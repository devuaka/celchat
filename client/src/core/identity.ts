import { accounts, type AccountRecord, deleteAccountDb } from './db';
import { aesDecrypt, aesEncrypt, keysFromSeed, newSeed, newDeviceWrapKey, passwordKey, type Keys } from '@shared/crypto';
import { fromB32, fromB64, randomBytes, randomHex, toB32, toB64, utf8ToBytes, bytesToUtf8 } from '@shared/bytes';
import { USERNAME_RE } from '@shared/profile';

const PBKDF2_ITER = 600_000;

export interface Session {
  keys: Keys;
  dv: string;
  account: AccountRecord;
}

export async function listAccounts(): Promise<AccountRecord[]> {
  const db = await accounts();
  return (await db.getAll('accounts')).sort((a, b) => b.lastUsed - a.lastUsed);
}

async function encryptSeed(seed: Uint8Array, password: string) {
  const salt = randomBytes(16);
  const key = await passwordKey(password, salt, PBKDF2_ITER);
  return { salt: toB64(salt), iter: PBKDF2_ITER, ct: toB64(await aesEncrypt(key, seed)) };
}

async function wrapSeed(seed: Uint8Array) {
  const key = await newDeviceWrapKey();
  return { key, ct: toB64(await aesEncrypt(key, seed)) };
}

export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 256) return 'That password is too long.';
  return null;
}

export function normalizeUsername(u: string) {
  return u.trim().toLowerCase().replace(/^@/, '');
}

export function validateUsername(u: string): string | null {
  if (!USERNAME_RE.test(u)) return '2-32 characters: lowercase letters, numbers, _ and .';
  return null;
}

async function saveAccount(seed: Uint8Array, username: string, displayName: string, password: string, stay: boolean, createdAt: number) {
  const keys = keysFromSeed(seed);
  const db = await accounts();
  const existing = await db.get('accounts', keys.pub);
  const rec: AccountRecord = {
    pub: keys.pub,
    dv: existing?.dv ?? randomHex(8),
    username,
    displayName,
    createdAt,
    lastUsed: Date.now(),
    vault: await encryptSeed(seed, password),
    wrapped: stay ? await wrapSeed(seed) : undefined,
  };
  await db.put('accounts', rec);
  return { keys, dv: rec.dv, account: rec } satisfies Session;
}

export async function createAccount(username: string, displayName: string, password: string, stay: boolean): Promise<Session> {
  return saveAccount(newSeed(), username, displayName, password, stay, Date.now());
}

export async function unlockWithPassword(pub: string, password: string, stay: boolean): Promise<Session> {
  const db = await accounts();
  const rec = await db.get('accounts', pub);
  if (!rec) throw new Error('Account not found on this device');
  const key = await passwordKey(password, fromB64(rec.vault.salt), rec.vault.iter);
  let seed: Uint8Array;
  try {
    seed = await aesDecrypt(key, fromB64(rec.vault.ct));
  } catch {
    throw new Error('Wrong password');
  }
  rec.lastUsed = Date.now();
  rec.wrapped = stay ? await wrapSeed(seed) : undefined;
  await db.put('accounts', rec);
  return { keys: keysFromSeed(seed), dv: rec.dv, account: rec };
}

export async function tryAutoUnlock(pub: string): Promise<Session | null> {
  const db = await accounts();
  const rec = await db.get('accounts', pub);
  if (!rec?.wrapped) return null;
  try {
    const seed = await aesDecrypt(rec.wrapped.key, fromB64(rec.wrapped.ct));
    rec.lastUsed = Date.now();
    await db.put('accounts', rec);
    return { keys: keysFromSeed(seed), dv: rec.dv, account: rec };
  } catch {
    return null;
  }
}

export async function signOut(pub: string) {
  const db = await accounts();
  const rec = await db.get('accounts', pub);
  if (rec) {
    delete rec.wrapped;
    await db.put('accounts', rec);
  }
}

export async function changePassword(session: Session, newPassword: string) {
  const db = await accounts();
  const rec = await db.get('accounts', session.keys.pub);
  if (!rec) throw new Error('Account not found');
  rec.vault = await encryptSeed(session.keys.seed, newPassword);
  await db.put('accounts', rec);
}

export async function updateAccountLabel(pub: string, username: string, displayName: string) {
  const db = await accounts();
  const rec = await db.get('accounts', pub);
  if (!rec) return;
  rec.username = username;
  rec.displayName = displayName;
  await db.put('accounts', rec);
}

export async function removeAccountFromDevice(pub: string) {
  const db = await accounts();
  await db.delete('accounts', pub);
  await deleteAccountDb(pub);
}

/** Recovery key: the 32-byte seed in base32, grouped for humans. */
export function recoveryKeyOf(keys: Keys) {
  return toB32(keys.seed).match(/.{1,4}/g)!.join('-');
}

export function seedFromRecoveryKey(s: string): Uint8Array {
  const seed = fromB32(s);
  if (seed.length < 32) throw new Error('That recovery key is too short');
  return seed.slice(0, 32);
}

export async function importFromRecoveryKey(recovery: string, username: string, password: string, stay: boolean): Promise<Session> {
  const seed = seedFromRecoveryKey(recovery);
  return saveAccount(seed, username, '', password, stay, Date.now());
}

// ---------------------------------------------------------------------------
// Backup files: the seed + account data, encrypted with the password
// ---------------------------------------------------------------------------

export interface BackupFile {
  type: 'celchat-backup';
  v: 1;
  pub: string;
  username: string;
  createdAt: number;
  salt: string;
  iter: number;
  /** AES-GCM(PBKDF2(password), JSON { seed, data }) */
  ct: string;
}

export async function makeBackup(session: Session, password: string, data: unknown): Promise<BackupFile> {
  const salt = randomBytes(16);
  const key = await passwordKey(password, salt, PBKDF2_ITER);
  const plain = utf8ToBytes(JSON.stringify({ seed: toB64(session.keys.seed), data }));
  return {
    type: 'celchat-backup',
    v: 1,
    pub: session.keys.pub,
    username: session.account.username,
    createdAt: session.account.createdAt,
    salt: toB64(salt),
    iter: PBKDF2_ITER,
    ct: toB64(await aesEncrypt(key, plain)),
  };
}

export async function openBackup(file: BackupFile, password: string): Promise<{ seed: Uint8Array; data: unknown }> {
  if (file?.type !== 'celchat-backup' || file.v !== 1) throw new Error('Not a CelChat backup file');
  const key = await passwordKey(password, fromB64(file.salt), file.iter);
  let plain: Uint8Array;
  try {
    plain = await aesDecrypt(key, fromB64(file.ct));
  } catch {
    throw new Error('Wrong password for this backup');
  }
  const obj = JSON.parse(bytesToUtf8(plain)) as { seed: string; data: unknown };
  const seed = fromB64(obj.seed);
  if (keysFromSeed(seed).pub !== file.pub) throw new Error('Backup is corrupted');
  return { seed, data: obj.data };
}

export async function restoreBackup(file: BackupFile, password: string, stay: boolean) {
  const { seed, data } = await openBackup(file, password);
  const session = await saveAccount(seed, file.username, '', password, stay, file.createdAt);
  return { session, data };
}

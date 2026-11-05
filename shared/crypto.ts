import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes, randomBytes, isHex } from './bytes';
import { canonical } from './canonical';

export interface Keys {
  seed: Uint8Array;
  edPub: Uint8Array;
  xPriv: Uint8Array;
  xPub: Uint8Array;
  /** hex Ed25519 public key: the user's CelChat ID */
  pub: string;
}

export function keysFromSeed(seed: Uint8Array): Keys {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const edPub = ed25519.getPublicKey(seed);
  const xPriv = ed25519.utils.toMontgomerySecret(seed);
  const xPub = ed25519.utils.toMontgomery(edPub);
  return { seed, edPub, xPriv, xPub, pub: bytesToHex(edPub) };
}

export const newSeed = () => randomBytes(32);

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256(typeof data === 'string' ? utf8ToBytes(data) : data);
}
export const sha256Hex = (data: Uint8Array | string) => bytesToHex(sha256Bytes(data));
export const hashJson = (v: unknown) => sha256Hex(canonical(v));

export function sign(keys: Keys, msg: Uint8Array | string): string {
  return bytesToHex(ed25519.sign(typeof msg === 'string' ? utf8ToBytes(msg) : msg, keys.seed));
}

export function verify(pubHex: string, msg: Uint8Array | string, sigHex: string): boolean {
  if (!isHex(pubHex, 64) || !isHex(sigHex, 128)) return false;
  try {
    return ed25519.verify(hexToBytes(sigHex), typeof msg === 'string' ? utf8ToBytes(msg) : msg, hexToBytes(pubHex));
  } catch {
    return false;
  }
}

/** Sign a JSON object: returns the object with `sig` added (sig over sha256(canonical(obj without sig))). */
export function signObject<T extends object>(keys: Keys, obj: T): T & { sig: string } {
  const { sig: _drop, ...rest } = obj as T & { sig?: string };
  return { ...(rest as T), sig: sign(keys, sha256Bytes(canonical(rest))) };
}
export function verifyObject(pubHex: string, obj: { sig?: unknown }): boolean {
  if (typeof obj.sig !== 'string') return false;
  const { sig, ...rest } = obj;
  try {
    return verify(pubHex, sha256Bytes(canonical(rest)), sig as string);
  } catch {
    return false;
  }
}

export function xPubOf(pubHex: string): Uint8Array {
  return ed25519.utils.toMontgomery(hexToBytes(pubHex));
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto unavailable (needs a secure context: https or localhost)');
  return s;
}

/** Copy into a fresh ArrayBuffer-backed Uint8Array (WebCrypto rejects SharedArrayBuffer views). */
function ab(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(b.length));
  out.set(b);
  return out;
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', ab(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** AES-256-GCM. Output: iv(12) || ciphertext+tag */
export async function aesEncrypt(key: Uint8Array | CryptoKey, plain: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const k = key instanceof Uint8Array ? await aesKey(key) : key;
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await subtle().encrypt(aad ? { name: 'AES-GCM', iv: ab(iv), additionalData: ab(aad) } : { name: 'AES-GCM', iv: ab(iv) }, k, ab(plain)),
  );
  return concatBytes(iv, ct);
}

export async function aesDecrypt(key: Uint8Array | CryptoKey, data: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (data.length < 28) throw new Error('ciphertext too short');
  const k = key instanceof Uint8Array ? await aesKey(key) : key;
  return new Uint8Array(
    await subtle().decrypt(
      aad ? { name: 'AES-GCM', iv: ab(data.subarray(0, 12)), additionalData: ab(aad) } : { name: 'AES-GCM', iv: ab(data.subarray(0, 12)) },
      k,
      ab(data.subarray(12)),
    ),
  );
}

/** Pairwise symmetric key between two identities (static X25519 + HKDF). */
export function pairKey(keys: Keys, theirPubHex: string, label: string): Uint8Array {
  const theirX = xPubOf(theirPubHex);
  const shared = x25519.getSharedSecret(keys.xPriv, theirX);
  const [a, b] = [keys.pub, theirPubHex].sort();
  return hkdf(sha256, shared, utf8ToBytes(a + ':' + b), utf8ToBytes('celchat/' + label), 32);
}

/**
 * Sealed box: anonymous-sender encryption to a recipient's identity key.
 * Layout: ephPub(32) || iv(12) || ct. Sender authenticity is provided by a
 * signature *inside* the plaintext (see sealSigned).
 */
export async function seal(recipientPubHex: string, plain: Uint8Array): Promise<Uint8Array> {
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const rx = xPubOf(recipientPubHex);
  const shared = x25519.getSharedSecret(eph, rx);
  const key = hkdf(sha256, shared, concatBytes(ephPub, rx), utf8ToBytes('celchat/seal/v1'), 32);
  return concatBytes(ephPub, await aesEncrypt(key, plain));
}

export async function unseal(keys: Keys, box: Uint8Array): Promise<Uint8Array> {
  if (box.length < 32 + 28) throw new Error('box too short');
  const ephPub = box.subarray(0, 32);
  const shared = x25519.getSharedSecret(keys.xPriv, ephPub);
  const key = hkdf(sha256, shared, concatBytes(ephPub, keys.xPub), utf8ToBytes('celchat/seal/v1'), 32);
  return aesDecrypt(key, box.subarray(32));
}

export interface SignedEnvelope<T = unknown> {
  from: string;
  to: string;
  at: number;
  body: T;
  sig: string;
}

/** Seal a JSON body to `to`, signed by the sender so the recipient can authenticate it. */
export async function sealSigned(keys: Keys, to: string, body: unknown): Promise<Uint8Array> {
  const env = signObject(keys, { from: keys.pub, to, at: Date.now(), body });
  return seal(to, utf8ToBytes(JSON.stringify(env)));
}

export async function unsealSigned(keys: Keys, box: Uint8Array): Promise<SignedEnvelope> {
  const plain = await unseal(keys, box);
  const env = JSON.parse(new TextDecoder().decode(plain)) as SignedEnvelope;
  if (!env || typeof env !== 'object' || env.to !== keys.pub || !isHex(env.from, 64)) throw new Error('bad envelope');
  if (!verifyObject(env.from, env as unknown as { sig?: unknown })) throw new Error('bad envelope signature');
  return env;
}

/** PBKDF2-SHA256 (WebCrypto) for password-protecting the local key vault. */
export async function passwordKey(password: string, salt: Uint8Array, iterations = 600_000): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', ab(utf8ToBytes(password)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: ab(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function newDeviceWrapKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Streaming-free sha256 for file blobs (WebCrypto is much faster than JS for big files). */
export async function sha256File(data: Uint8Array): Promise<string> {
  const d = await subtle().digest('SHA-256', ab(data));
  return bytesToHex(new Uint8Array(d));
}

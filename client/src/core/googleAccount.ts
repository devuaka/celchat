/** Account flows on top of google.ts: sign in, create, link and unlink. */
import { keysFromSeed, newSeed } from '@shared/crypto';
import { fromB64, toB64 } from '@shared/bytes';
import { googleToken, googleUser, readDriveAccount, writeDriveAccount, deleteDriveAccount, type GoogleUser } from './google';
import { signInWithGoogleSeed, setAccountGoogle, type Session } from './identity';

export type GoogleStart = { kind: 'session'; session: Session } | { kind: 'new'; token: string; user: GoogleUser };

/** "Continue with Google": signs in if this Google account already holds a CelChat account. */
export async function startGoogleSignIn(): Promise<GoogleStart> {
  const token = await googleToken();
  const user = await googleUser(token);
  const acct = await readDriveAccount(token);
  if (!acct) return { kind: 'new', token, user };
  const seed = fromB64(acct.seed);
  if (seed.length !== 32 || keysFromSeed(seed).pub !== acct.pub) throw new Error('The CelChat account in your Google Drive is damaged.');
  const session = await signInWithGoogleSeed(seed, acct, { email: user.email, sub: user.sub });
  return { kind: 'session', session };
}

/** First Google sign-in: make a new CelChat account and keep its key in the user's Drive. */
export async function createGoogleAccount(token: string, user: GoogleUser, username: string, displayName: string): Promise<Session> {
  const seed = newSeed();
  const pub = keysFromSeed(seed).pub;
  const createdAt = Date.now();
  // Drive first: if that fails, nothing half-made is left on this device
  await writeDriveAccount(token, { pub, seed: toB64(seed), username, displayName, createdAt });
  return signInWithGoogleSeed(seed, { username, displayName, createdAt }, { email: user.email, sub: user.sub });
}

/** Settings: let an existing account sign in with Google from now on. */
export async function linkGoogle(session: Session, displayName: string): Promise<GoogleUser> {
  const token = await googleToken();
  const user = await googleUser(token);
  const existing = await readDriveAccount(token);
  if (existing && existing.pub !== session.keys.pub) {
    throw new Error(`${user.email} already signs in to the CelChat account @${existing.username}. Pick a different Google account, or sign in to @${existing.username} and unlink it there first.`);
  }
  await writeDriveAccount(token, { pub: session.keys.pub, seed: toB64(session.keys.seed), username: session.account.username, displayName, createdAt: session.account.createdAt });
  await setAccountGoogle(session.keys.pub, { email: user.email, sub: user.sub });
  return user;
}

/** Settings: remove the key from Google Drive and stop signing in with Google. */
export async function unlinkGoogle(session: Session) {
  const token = await googleToken();
  const existing = await readDriveAccount(token);
  if (existing && existing.pub !== session.keys.pub) throw new Error('That Google account holds a different CelChat account. Sign in with the Google account this one is linked to.');
  if (existing) await deleteDriveAccount(token);
  await setAccountGoogle(session.keys.pub, null);
}

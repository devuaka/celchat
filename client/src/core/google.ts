/**
 * "Continue with Google": the same CelChat account on every device without a CelChat server.
 *
 * The account's key (seed) is kept in the user's OWN Google Drive, in the hidden app-data folder that
 * only CelChat can see (scope drive.appdata). Signing in with Google on another device reads it back.
 * Google sign-in runs in a real browser window (Google blocks it inside app web views):
 *   web:      a popup; the redirect page hands the token back with BroadcastChannel
 *   desktop:  the system browser; the redirect page bounces to celchat://oauth#...
 *   iPhone:   an in-app Safari sheet (@capacitor/browser); same celchat:// bounce
 * The access token is checked against our client id before it is used, and is never stored.
 */
import { fromB64, toB64, randomHex } from '@shared/bytes';

/** CelChat's Google OAuth client (public, not a secret). Set up in docs/GOOGLE_SIGNIN.md. */
const DEFAULT_CLIENT_ID = '';
const CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID;
const PUBLIC_APP_URL: string = import.meta.env.VITE_PUBLIC_APP_URL || 'https://devuaka.github.io/celchat/app/';
const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'celchat-account.json';

export const googleEnabled = () => !!CLIENT_ID;

export interface GoogleUser {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

/** What CelChat keeps in the user's Drive app folder. */
export interface DriveAccount {
  type: 'celchat-google-account';
  v: 1;
  pub: string;
  /** the account key, base64 (Drive app data is private to the user and to CelChat) */
  seed: string;
  username: string;
  displayName: string;
  createdAt: number;
  savedAt: number;
}

type Capacitorish = { isNativePlatform?: () => boolean };
const isNative = () => !!(window as unknown as { Capacitor?: Capacitorish }).Capacitor?.isNativePlatform?.();
const isDesktop = () => !!window.celDesktop;

/** Where Google sends the browser back to (must be listed in the Google Cloud OAuth client). */
export function redirectUri() {
  if (!isNative() && !isDesktop() && /^https?:$/.test(location.protocol)) return new URL('oauth.html', location.href.split('#')[0]).href;
  return new URL('oauth.html', PUBLIC_APP_URL).href;
}

// ---------------------------------------------------------------------------
// Getting an access token
// ---------------------------------------------------------------------------

let pending: { state: string; resolve: (hash: string) => void; reject: (e: Error) => void } | null = null;

function deliver(hash: string) {
  if (!pending) return;
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (p.get('state') !== pending.state) return; // not our request
  const done = pending;
  pending = null;
  if (p.get('error')) done.reject(new Error(p.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${p.get('error')}`));
  else done.resolve(hash);
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  try {
    new BroadcastChannel('celchat-oauth').onmessage = (e) => typeof e.data === 'string' && deliver(e.data);
  } catch {
    /* older browsers: postMessage below */
  }
  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data?.type === 'celchat-oauth' && typeof e.data.hash === 'string') deliver(e.data.hash);
  });
  window.celDesktop?.onCommand((cmd) => {
    if (cmd.type === 'oauth' && typeof cmd.hash === 'string') deliver(cmd.hash);
  });
  if (isNative()) {
    void import('@capacitor/app').then(({ App }) =>
      App.addListener('appUrlOpen', ({ url }) => {
        if (!url.startsWith('celchat://oauth')) return;
        deliver(url.slice(url.indexOf('#') + 1));
        void import('@capacitor/browser').then(({ Browser }) => Browser.close().catch(() => undefined));
      }),
    );
  }
}

export async function googleToken(): Promise<string> {
  if (!CLIENT_ID) throw new Error('Google sign-in is not set up for this copy of CelChat.');
  listen();
  const native = isNative() || isDesktop();
  const state = (native ? 'n.' : 'w.') + randomHex(16);
  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPES, state, prompt: 'select_account', include_granted_scopes: 'true' });
  pending?.reject(new Error('Superseded by a new sign-in.'));
  const hash = new Promise<string>((resolve, reject) => {
    pending = { state, resolve, reject };
    setTimeout(() => {
      if (pending?.state === state) {
        pending = null;
        reject(new Error('Google sign-in timed out. Try again.'));
      }
    }, 5 * 60_000);
  });
  if (isNative()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url, presentationStyle: 'popover' });
  } else if (isDesktop()) {
    window.open(url, '_blank'); // the desktop shell sends http(s) windows to the system browser
  } else {
    const w = window.open(url, 'celchat-google', 'width=480,height=680');
    if (!w) {
      pending = null;
      throw new Error('Your browser blocked the Google sign-in window. Allow pop-ups for CelChat and try again.');
    }
  }
  const p = new URLSearchParams((await hash).replace(/^#/, ''));
  const token = p.get('access_token');
  if (!token) throw new Error('Google did not return a sign-in token.');
  // make sure the token was issued to CelChat (and not, say, injected from another app's flow)
  const info = (await (await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token))).json()) as { aud?: string; azp?: string; scope?: string };
  if (info.aud !== CLIENT_ID && info.azp !== CLIENT_ID) throw new Error('That Google sign-in was not for CelChat.');
  if (!info.scope?.includes('drive.appdata')) throw new Error('CelChat needs permission to keep your account in your Google Drive (its own hidden folder). Please allow it.');
  return token;
}

// ---------------------------------------------------------------------------
// Google APIs (straight from this device; no CelChat server involved)
// ---------------------------------------------------------------------------

async function gfetch(token: string, url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const j = (await r.json()) as { error?: { message?: string } | string; error_description?: string };
      msg = typeof j.error === 'string' ? j.error_description || j.error : j.error?.message || msg;
    } catch {
      /* not json */
    }
    if (r.status === 403 && /Drive API has not been used|disabled/i.test(msg)) msg = 'The Google Drive API is not enabled for this CelChat setup (Google Cloud console, APIs & Services, enable "Google Drive API").';
    throw new Error(`Google: ${msg}`);
  }
  return r;
}

export async function googleUser(token: string): Promise<GoogleUser> {
  const j = (await (await gfetch(token, 'https://openidconnect.googleapis.com/v1/userinfo')).json()) as { sub: string; email?: string; name?: string; picture?: string };
  return { sub: j.sub, email: j.email ?? '', name: j.name ?? '', picture: j.picture ?? null };
}

async function findFile(token: string): Promise<string | null> {
  const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name = '${FILE_NAME}' and trashed = false`, fields: 'files(id,modifiedTime)', orderBy: 'modifiedTime desc' });
  const j = (await (await gfetch(token, 'https://www.googleapis.com/drive/v3/files?' + q)).json()) as { files?: { id: string }[] };
  return j.files?.[0]?.id ?? null;
}

export async function readDriveAccount(token: string): Promise<DriveAccount | null> {
  const id = await findFile(token);
  if (!id) return null;
  const j = (await (await gfetch(token, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json()) as DriveAccount;
  if (j?.type !== 'celchat-google-account' || typeof j.seed !== 'string') throw new Error('The CelChat data in your Google Drive is damaged.');
  return j;
}

export async function writeDriveAccount(token: string, acct: Omit<DriveAccount, 'type' | 'v' | 'savedAt'>) {
  const body = JSON.stringify({ type: 'celchat-google-account', v: 1, ...acct, savedAt: Date.now() } satisfies DriveAccount);
  const id = await findFile(token);
  if (id) {
    await gfetch(token, `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    return;
  }
  const boundary = 'celchat' + randomHex(8);
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  await gfetch(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
}

export async function deleteDriveAccount(token: string) {
  const id = await findFile(token);
  if (id) await gfetch(token, `https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE' });
}

export const seedToB64 = (seed: Uint8Array) => toB64(seed);
export const seedFromB64 = (s: string) => fromB64(s);

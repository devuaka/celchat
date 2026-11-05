import { fileURLToPath } from 'node:url';
import path from 'node:path';

const env = process.env;
const num = (k: string, d: number) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
const bool = (k: string, d: boolean) => (env[k] === undefined || env[k] === '' ? d : /^(1|true|yes|on)$/i.test(env[k]!));
const list = (k: string, d: string[]) => (env[k] ? env[k]!.split(',').map((s) => s.trim()).filter(Boolean) : d);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const config = {
  name: env.HUB_NAME || 'CelChat Hub',
  host: env.HOST || '0.0.0.0',
  port: num('HUB_PORT', num('PORT', 8781)),
  dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
  staticDir: path.resolve(env.STATIC_DIR || path.join(root, 'dist')),
  /** honour X-Forwarded-For (only behind your own reverse proxy) */
  trustProxy: bool('TRUST_PROXY', false),
  /** comma-separated allowed browser origins for WebSocket/HTTP; empty = any */
  allowedOrigins: list('ALLOWED_ORIGINS', []),

  stun: list('STUN_URLS', ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']),
  turnUrls: list('TURN_URLS', []),
  turnSecret: env.TURN_SECRET || '',
  turnTtl: num('TURN_TTL', 12 * 3600),

  mailbox: bool('MAILBOX', true),
  mailTtlDays: num('MAIL_TTL_DAYS', 7),
  mailItemBytes: num('MAIL_ITEM_BYTES', 256 * 1024),
  mailUserBytes: num('MAIL_USER_BYTES', 4 * 1024 * 1024),

  directory: bool('DIRECTORY', true),

  assets: bool('ASSET_CACHE', true),
  assetBytes: num('ASSET_MAX_BYTES', 10 * 1024 * 1024),
  assetTotalBytes: num('ASSET_TOTAL_BYTES', 1024 * 1024 * 1024),

  vault: bool('VAULT', true),
  vaultBytes: num('VAULT_BYTES', 768 * 1024),

  relay: bool('RELAY', true),
  relayBytesPerSec: num('RELAY_BYTES_PER_SEC', 256 * 1024),
  /** CelChat IDs of archive peers you run: they relay everything, so they get a bigger budget */
  relayTrusted: list('RELAY_TRUSTED_KEYS', []),
  relayTrustedBytesPerSec: num('RELAY_TRUSTED_BYTES_PER_SEC', 4 * 1024 * 1024),

  /** GIF search: klipy | giphy | tenor-compatible. The key stays on the hub; browsers never see it. */
  gifProvider: (env.GIF_PROVIDER || '') as '' | 'klipy' | 'giphy' | 'tenor-compatible',
  gifKey: env.GIF_API_KEY || '',
  gifBaseUrl: env.GIF_BASE_URL || '',
  gifContentFilter: (env.GIF_CONTENT_FILTER || 'medium') as 'off' | 'low' | 'medium' | 'high',

  maxConnsPerIp: num('MAX_CONNS_PER_IP', 32),
  maxTopicsPerConn: num('MAX_TOPICS_PER_CONN', 600),
};

export type Config = typeof config;

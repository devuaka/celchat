import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const num = (k: string, d: number) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
const bool = (k: string, d: boolean) => (env[k] === undefined || env[k] === '' ? d : /^(1|true|yes|on)$/i.test(env[k]!));
const list = (k: string) => (env[k] ? env[k]!.split(',').map((s) => s.trim()).filter(Boolean) : []);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const cfg = {
  hubUrl: env.KEEPER_HUB_URL || 'ws://localhost:8781/ws',
  dataDir: path.resolve(env.KEEPER_DATA_DIR || path.join(root, 'data', 'keeper')),
  username: (env.KEEPER_USERNAME || 'archive').toLowerCase(),
  displayName: env.KEEPER_NAME || 'Archive peer',
  about: env.KEEPER_ABOUT || 'An always-on archive peer. It keeps the communities it is in available while their members are offline, and serves their history and files to anyone allowed to read them.',
  /** CelChat IDs (or @usernames) allowed to add this archive peer to communities */
  owners: list('KEEPER_OWNERS'),
  /** accept join requests from anyone who can create an invite (careful: storage) */
  open: bool('KEEPER_OPEN', false),
  maxCommunities: num('KEEPER_MAX_COMMUNITIES', 50),
  /** invite links to join on start (comma-separated) */
  joins: list('KEEPER_JOIN'),
  files: bool('KEEPER_FILES', true),
  fileMaxBytes: num('KEEPER_FILE_MAX_MB', 25) * 1024 * 1024,
  filesTotalBytes: num('KEEPER_FILES_TOTAL_GB', 5) * 1024 * 1024 * 1024,
  /** optional local status endpoint (JSON), e.g. 8785; 0 = off */
  statusPort: num('KEEPER_STATUS_PORT', 0),
  statusHost: env.KEEPER_STATUS_HOST || '127.0.0.1',
};

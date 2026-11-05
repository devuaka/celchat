import { z } from 'zod';
import { canonical } from './canonical';
import { hashJson, sha256Bytes, sha256Hex, sign, verify, type Keys } from './crypto';
import { bytesToHex, isHex } from './bytes';
import { LIMITS } from './limits';

export interface OpHeader {
  v: 1;
  /** conversation id: community, group DM or DM */
  c: string;
  /** author public key (hex) */
  a: string;
  /** device id (hex, 8 bytes) */
  dv: string;
  /** per (c, a, dv) sequence number, starts at 1 */
  s: number;
  /** lamport clock */
  l: number;
  /** author wall clock, ms */
  t: number;
  /** kind */
  k: string;
  /** sha256 of canonical(payload) */
  ph: string;
}

export interface Op extends OpHeader {
  id: string;
  sig: string;
  /** payload; absent when redacted (deleted content) */
  p?: unknown;
  /** local receive time (never sent, never signed) */
  rcv?: number;
}

export const headerOf = (op: Op): OpHeader => ({
  v: op.v,
  c: op.c,
  a: op.a,
  dv: op.dv,
  s: op.s,
  l: op.l,
  t: op.t,
  k: op.k,
  ph: op.ph,
});

export function createOp(
  keys: Keys,
  dv: string,
  fields: { c: string; s: number; l: number; k: string; p: unknown; t?: number },
): Op {
  const header: OpHeader = {
    v: 1,
    c: fields.c,
    a: keys.pub,
    dv,
    s: fields.s,
    l: fields.l,
    t: fields.t ?? Date.now(),
    k: fields.k,
    ph: hashJson(fields.p),
  };
  const idBytes = sha256Bytes(canonical(header));
  const id = bytesToHex(idBytes);
  return { ...header, id, sig: sign(keys, idBytes), p: fields.p };
}

/** Structural + cryptographic check. Does not check permissions. */
export function verifyOp(raw: unknown): raw is Op {
  if (!raw || typeof raw !== 'object') return false;
  const op = raw as Op;
  if (op.v !== 1) return false;
  if (!isHex(op.c, 64) || !isHex(op.a, 64) || !isHex(op.dv, 16) || !isHex(op.id, 64) || !isHex(op.sig, 128) || !isHex(op.ph, 64))
    return false;
  if (!Number.isSafeInteger(op.s) || op.s < 1) return false;
  if (!Number.isSafeInteger(op.l) || op.l < 1) return false;
  if (!Number.isSafeInteger(op.t) || op.t < 0) return false;
  if (typeof op.k !== 'string' || op.k.length > 24) return false;
  const headerJson = canonical(headerOf(op));
  const idBytes = sha256Bytes(headerJson);
  if (bytesToHex(idBytes) !== op.id) return false;
  if (!verify(op.a, idBytes, op.sig)) return false;
  if (op.p !== undefined) {
    let pj: string;
    try {
      pj = canonical(op.p);
    } catch {
      return false;
    }
    if (pj.length > LIMITS.opBytes) return false;
    if (sha256Hex(pj) !== op.ph) return false;
  }
  return true;
}

/** Strip the payload (deleted content) while keeping a verifiable header. */
export function redact(op: Op): Op {
  const { p: _p, ...rest } = op;
  return rest;
}

export const wireOp = (op: Op): Op => {
  const { rcv: _r, ...rest } = op;
  return rest;
};

// ---------------------------------------------------------------------------
// Ordering keys
// ---------------------------------------------------------------------------

/** [lamport, id, sub]; sub is non-empty only for ops shifted behind a revocation. */
export type EKey = readonly [number, string, string];
export const keyOf = (op: { l: number; id: string }): EKey => [op.l, op.id, ''];
export function cmpKey(a: EKey, b: EKey): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}
export const cmpOps = (a: Op, b: Op) => cmpKey(keyOf(a), keyOf(b));

// ---------------------------------------------------------------------------
// Payload schemas (untrusted input from peers)
// ---------------------------------------------------------------------------

const hex = (n: number) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`));
export const zPub = hex(64);
export const zId = z.string().regex(/^[0-9a-zA-Z_-]{6,40}$/);
const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const zName = (max: number) => z.string().trim().min(1).max(max);

export const zAsset = z.object({
  hash: hex(64),
  mime: z.string().max(100),
  size: z.number().int().min(1).max(4 * 1024 * 1024 * 1024),
  w: z.number().int().min(1).max(20000).optional(),
  h: z.number().int().min(1).max(20000).optional(),
});
export type AssetRef = z.infer<typeof zAsset>;

export const zAttachment = zAsset.extend({
  name: z.string().min(1).max(255),
  thumb: z.string().max(LIMITS.thumbChars).optional(),
  dur: z.number().min(0).max(86400).optional(),
  spoiler: z.boolean().optional(),
  /** CelChat theme file shared in chat */
  theme: z.boolean().optional(),
  /** recorded voice message */
  voice: z.boolean().optional(),
});
export type Attachment = z.infer<typeof zAttachment>;

export const zOverwrite = z.object({ allow: z.number().int().min(0), deny: z.number().int().min(0) });
export const zCutoff = z.record(z.string().regex(/^[0-9a-f]{64}:[0-9a-f]{16}$/), z.number().int().min(0)).optional();

export const zCommunityTheme = z
  .object({
    accent: zColor.optional(),
    accent2: zColor.optional(),
    bg: zColor.optional(),
    bgImage: zAsset.optional(),
    font: z.string().max(40).optional(),
  })
  .strict();

const zChannelInit = z.object({
  id: zId,
  type: z.enum(['text', 'voice', 'category']),
  name: zName(LIMITS.channelNameChars),
  parent: zId.nullable().optional(),
  pos: z.number().int().min(0).max(100000),
  topic: z.string().max(LIMITS.topicChars).optional(),
});

export const PAYLOADS = {
  // ---- community governance
  genesis: z.object({
    name: zName(LIMITS.nameChars),
    nonce: hex(32),
    description: z.string().max(LIMITS.descriptionChars).optional(),
    icon: zAsset.optional(),
    channels: z.array(zChannelInit).max(50),
    everyone: z.number().int().min(0).optional(),
  }),
  'comm.update': z.object({
    name: zName(LIMITS.nameChars).optional(),
    description: z.string().max(LIMITS.descriptionChars).optional(),
    icon: zAsset.nullable().optional(),
    banner: zAsset.nullable().optional(),
    theme: zCommunityTheme.nullable().optional(),
    joinPolicy: z.enum(['invite', 'open']).optional(),
    systemChannel: zId.nullable().optional(),
  }),
  'ch.create': zChannelInit,
  'ch.update': z.object({
    id: zId,
    name: zName(LIMITS.channelNameChars).optional(),
    topic: z.string().max(LIMITS.topicChars).optional(),
    parent: zId.nullable().optional(),
    pos: z.number().int().min(0).max(100000).optional(),
    overwrites: z.record(z.string().max(64), zOverwrite).optional(),
  }),
  'ch.delete': z.object({ id: zId }),
  'role.create': z.object({
    id: zId,
    name: zName(LIMITS.roleNameChars),
    color: zColor.nullable(),
    perms: z.number().int().min(0),
    pos: z.number().int().min(1).max(1000),
    hoist: z.boolean(),
    mentionable: z.boolean(),
  }),
  'role.update': z.object({
    id: z.string().max(64),
    name: zName(LIMITS.roleNameChars).optional(),
    color: zColor.nullable().optional(),
    perms: z.number().int().min(0).optional(),
    pos: z.number().int().min(1).max(1000).optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    cutoff: zCutoff,
  }),
  'role.delete': z.object({ id: zId, cutoff: zCutoff }),
  'inv.create': z.object({
    code: z.string().regex(/^[A-Za-z0-9]{6,16}$/),
    expiresAt: z.number().int().nullable(),
    maxUses: z.number().int().min(1).max(10000).nullable(),
  }),
  'inv.revoke': z.object({ code: z.string().regex(/^[A-Za-z0-9]{6,16}$/) }),
  'emoji.add': z.object({ name: z.string().regex(/^[a-z0-9_]{2,32}$/), asset: zAsset }),
  'emoji.del': z.object({ name: z.string().regex(/^[a-z0-9_]{2,32}$/) }),
  join: z.object({ code: z.string().regex(/^[A-Za-z0-9]{6,16}$/).optional() }),
  leave: z.object({}),
  kick: z.object({ target: zPub, reason: z.string().max(512).optional(), cutoff: zCutoff }),
  ban: z.object({
    target: zPub,
    reason: z.string().max(512).optional(),
    purgeSecs: z.number().int().min(0).max(7 * 86400).optional(),
    cutoff: zCutoff,
  }),
  unban: z.object({ target: zPub }),
  timeout: z.object({ target: zPub, until: z.number().int().nullable(), reason: z.string().max(512).optional(), cutoff: zCutoff }),
  mroles: z.object({ target: zPub, roles: z.array(zId).max(100), cutoff: zCutoff }),
  nick: z.object({ target: zPub, nick: z.string().trim().min(1).max(LIMITS.nickChars).nullable() }),
  transfer: z.object({ target: zPub, cutoff: zCutoff }),

  // ---- group DMs
  gcreate: z.object({
    nonce: hex(32),
    name: z.string().max(LIMITS.nameChars).optional(),
    members: z.array(zPub).min(1).max(LIMITS.maxGroupMembers - 1),
  }),
  gadd: z.object({ target: zPub }),
  gremove: z.object({ target: zPub, cutoff: zCutoff }),
  gleave: z.object({}),
  gupdate: z.object({ name: z.string().max(LIMITS.nameChars).optional(), icon: zAsset.nullable().optional() }),

  // ---- messages (all conversation types)
  msg: z.object({
    ch: z.string().max(40),
    text: z.string().max(LIMITS.messageChars),
    reply: hex(64).optional(),
    att: z.array(zAttachment).max(LIMITS.attachmentsPerMessage).optional(),
    nonce: z.string().max(40).optional(),
    poll: z
      .object({
        q: z.string().trim().min(1).max(300),
        options: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
        multi: z.boolean(),
        ends: z.number().int().nullable(),
      })
      .optional(),
  }),
  edit: z.object({ id: hex(64), text: z.string().max(LIMITS.messageChars) }),
  del: z.object({ id: hex(64) }),
  react: z.object({ id: hex(64), e: z.string().min(1).max(LIMITS.emojiChars), on: z.boolean() }),
  pin: z.object({ id: hex(64), on: z.boolean() }),
  /** poll votes: the latest vote op per voter wins; an empty list withdraws the vote */
  vote: z.object({ id: hex(64), choices: z.array(z.number().int().min(0).max(9)).max(10) }),
} as const;

export type Kind = keyof typeof PAYLOADS;
export type Payload<K extends Kind> = z.infer<(typeof PAYLOADS)[K]>;

export const COMMUNITY_GOV: ReadonlySet<string> = new Set([
  'genesis', 'comm.update', 'ch.create', 'ch.update', 'ch.delete', 'role.create', 'role.update', 'role.delete',
  'inv.create', 'inv.revoke', 'emoji.add', 'emoji.del', 'join', 'leave', 'kick', 'ban', 'unban', 'timeout', 'mroles', 'nick', 'transfer',
]);
export const GROUP_GOV: ReadonlySet<string> = new Set(['gcreate', 'gadd', 'gremove', 'gleave', 'gupdate']);
export const MESSAGE_KINDS: ReadonlySet<string> = new Set(['msg', 'edit', 'del', 'react', 'pin', 'vote']);
/** kinds whose payload targets another op (indexed for materialization) */
export const TARGETING: ReadonlySet<string> = new Set(['edit', 'del', 'react', 'pin', 'vote']);

export function parsePayload<K extends Kind>(k: K, p: unknown): Payload<K> | null {
  const schema = PAYLOADS[k];
  if (!schema) return null;
  const r = schema.safeParse(p);
  return r.success ? (r.data as Payload<K>) : null;
}

export const targetOf = (op: Op): string | null => {
  if (!TARGETING.has(op.k) || !op.p || typeof op.p !== 'object') return null;
  const id = (op.p as { id?: unknown }).id;
  return typeof id === 'string' && isHex(id, 64) ? id : null;
};

export const dmId = (a: string, b: string) => sha256Hex('dm:' + [a, b].sort().join(':'));
export const groupOrCommunityId = (author: string, nonce: string) => sha256Hex(author + ':' + nonce);

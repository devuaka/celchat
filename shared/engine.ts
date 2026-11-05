/**
 * The CelChat state engine. Pure and deterministic: given the same set of
 * signed ops, every peer computes the same community state and the same
 * validity verdict for every message. There is no server to trust, so this
 * file IS the permission system.
 */
import {
  type Op, type EKey, type AssetRef, type Attachment, type Embed, type MsgButton, keyOf, cmpKey, cmpOps, parsePayload, COMMUNITY_GOV, GROUP_GOV,
  groupOrCommunityId, dmId, type Payload,
} from './ops';
import { P, ALL_PERMS, CHANNEL_PERMS, TIMEOUT_STRIP, DEFAULT_EVERYONE } from './perms';
import { LIMITS } from './limits';

export type ConvoType = 'community' | 'group' | 'dm';

export interface Role {
  id: string;
  name: string;
  color: string | null;
  perms: number;
  pos: number;
  hoist: boolean;
  mentionable: boolean;
}
export interface Overwrite {
  allow: number;
  deny: number;
}
export interface Channel {
  id: string;
  type: 'text' | 'voice' | 'category';
  name: string;
  topic: string;
  parent: string | null;
  pos: number;
  overwrites: Record<string, Overwrite>;
}
export interface Member {
  pub: string;
  joinedAt: number;
  roles: string[];
  nick: string | null;
  timeoutUntil: number | null;
}
export interface Ban {
  by: string;
  reason: string;
  at: number;
  purgeFrom: number | null;
}
export interface Invite {
  code: string;
  by: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  uses: number;
  revoked: boolean;
}
export interface CommunityTheme {
  accent?: string;
  accent2?: string;
  bg?: string;
  bgImage?: AssetRef;
  font?: string;
}
export interface CommunityState {
  kind: 'community';
  id: string;
  owner: string;
  name: string;
  description: string;
  icon: AssetRef | null;
  banner: AssetRef | null;
  theme: CommunityTheme | null;
  joinPolicy: 'invite' | 'open';
  systemChannel: string | null;
  createdAt: number;
  roles: Record<string, Role>;
  channels: Record<string, Channel>;
  members: Record<string, Member>;
  bans: Record<string, Ban>;
  invites: Record<string, Invite>;
  emojis: Record<string, CustomEmoji>;
}
export interface CustomEmoji {
  name: string;
  asset: AssetRef;
  by: string;
}
export interface GroupMember {
  pub: string;
  joinedAt: number;
  addedBy: string;
}
export interface GroupState {
  kind: 'group';
  id: string;
  owner: string;
  name: string;
  icon: AssetRef | null;
  createdAt: number;
  members: Record<string, GroupMember>;
}
export interface DmState {
  kind: 'dm';
  id: string;
  members: Record<string, { pub: string }>;
}
export type ConvoState = CommunityState | GroupState | DmState;

export interface Revocation {
  id: string;
  key: EKey;
  a: string;
  dv: string;
  s: number;
  affected: Set<string>;
  cutoff: Record<string, number>;
}

export interface Message {
  id: string;
  c: string;
  ch: string;
  a: string;
  t: number;
  l: number;
  text: string;
  att: Attachment[];
  reply: string | null;
  editedAt: number | null;
  deleted: boolean;
  reacts: Record<string, string[]>;
  pinned: boolean;
  pinnedAt: number | null;
  mentions: { users: string[]; roles: string[]; everyone: boolean; here: boolean };
  /** author could ping @everyone/@here and unmentionable roles at send time */
  canPingAll: boolean;
  /** earlier versions of the text (every peer keeps every signed edit anyway) */
  history: { text: string; at: number }[];
  poll: Poll | null;
  embeds: Embed[];
  buttons: MsgButton[];
}

export interface Poll {
  q: string;
  options: string[];
  multi: boolean;
  ends: number | null;
  /** voter -> chosen option indexes */
  votes: Record<string, number[]>;
}

type Result = { ok: true; st: ConvoState; rev?: { affected: Set<string>; cutoff?: Record<string, number> } } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });

export const tEff = (op: Op) => Math.min(op.t, op.rcv ?? Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------
// Permission math (Discord-compatible semantics)
// ---------------------------------------------------------------------------

export function highestPos(st: CommunityState, pub: string): number {
  if (pub === st.owner) return Number.POSITIVE_INFINITY;
  const m = st.members[pub];
  if (!m) return -1;
  let h = 0;
  for (const r of m.roles) {
    const role = st.roles[r];
    if (role && role.pos > h) h = role.pos;
  }
  return h;
}

export function isTimedOut(st: CommunityState, pub: string, t: number): boolean {
  const m = st.members[pub];
  return !!m && m.timeoutUntil !== null && t < m.timeoutUntil;
}

export function basePerms(st: CommunityState, pub: string, t?: number): number {
  if (pub === st.owner) return ALL_PERMS;
  const m = st.members[pub];
  if (!m) return 0;
  let p = st.roles[st.id]?.perms ?? 0;
  for (const r of m.roles) p |= st.roles[r]?.perms ?? 0;
  if (p & P.ADMIN) return ALL_PERMS;
  if (t !== undefined && isTimedOut(st, pub, t)) p &= ~TIMEOUT_STRIP;
  return p;
}

export function channelPerms(st: CommunityState, pub: string, chId: string, t?: number): number {
  const base = basePerms(st, pub);
  if (base === ALL_PERMS) return ALL_PERMS;
  const ch = st.channels[chId];
  const m = st.members[pub];
  if (!ch || !m) return 0;
  let p = base;
  const layers: Record<string, Overwrite>[] = [];
  if (ch.parent && st.channels[ch.parent]) layers.push(st.channels[ch.parent].overwrites);
  layers.push(ch.overwrites);
  for (const ow of layers) {
    const ev = ow[st.id];
    if (ev) p = (p & ~(ev.deny & CHANNEL_PERMS)) | (ev.allow & CHANNEL_PERMS);
    let allow = 0;
    let deny = 0;
    for (const r of m.roles) {
      const o = ow[r];
      if (o) {
        allow |= o.allow;
        deny |= o.deny;
      }
    }
    p = (p & ~(deny & CHANNEL_PERMS)) | (allow & CHANNEL_PERMS);
    const mo = ow[pub];
    if (mo) p = (p & ~(mo.deny & CHANNEL_PERMS)) | (mo.allow & CHANNEL_PERMS);
  }
  if (t !== undefined && isTimedOut(st, pub, t)) p &= ~TIMEOUT_STRIP;
  if (!(p & P.VIEW_CHANNEL)) return 0;
  return p;
}

const canManageMember = (st: CommunityState, actor: string, target: string) =>
  target !== st.owner && (actor === st.owner || highestPos(st, actor) > highestPos(st, target));

/** Bits the actor may grant or revoke on roles/overwrites. */
const grantable = (st: CommunityState, actor: string) => {
  const b = basePerms(st, actor);
  return b === ALL_PERMS ? ALL_PERMS : b;
};

function filterCutoff(cutoff: Record<string, number> | undefined, affected: Set<string>) {
  if (!cutoff) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cutoff)) if (affected.has(k.slice(0, 64))) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Community governance
// ---------------------------------------------------------------------------

function applyCommunity(st: CommunityState | null, op: Op): Result {
  const t = tEff(op);
  if (op.k === 'genesis') {
    if (st) return fail('community already exists');
    const p = parsePayload('genesis', op.p);
    if (!p) return fail('bad payload');
    if (groupOrCommunityId(op.a, p.nonce) !== op.c) return fail('genesis id mismatch');
    const channels: Record<string, Channel> = {};
    for (const c of p.channels) {
      if (channels[c.id]) return fail('duplicate channel');
      channels[c.id] = { id: c.id, type: c.type, name: c.name, topic: c.topic ?? '', parent: c.parent ?? null, pos: c.pos, overwrites: {} };
    }
    for (const c of Object.values(channels)) {
      if (c.parent && channels[c.parent]?.type !== 'category') c.parent = null;
      if (c.type === 'category') c.parent = null;
    }
    const firstText = Object.values(channels).find((c) => c.type === 'text');
    return {
      ok: true,
      st: {
        kind: 'community',
        id: op.c,
        owner: op.a,
        name: p.name,
        description: p.description ?? '',
        icon: p.icon ?? null,
        banner: null,
        theme: null,
        joinPolicy: 'invite',
        systemChannel: firstText?.id ?? null,
        createdAt: op.t,
        roles: {
          [op.c]: { id: op.c, name: '@everyone', color: null, perms: p.everyone ?? DEFAULT_EVERYONE, pos: 0, hoist: false, mentionable: false },
        },
        channels,
        members: { [op.a]: { pub: op.a, joinedAt: op.t, roles: [], nick: null, timeoutUntil: null } },
        bans: {},
        invites: {},
        emojis: {},
      },
    };
  }
  if (!st) return fail('no genesis yet');
  const a = op.a;
  const isMember = !!st.members[a];

  // Joining is the only op a non-member may author.
  if (op.k === 'join') {
    const p = parsePayload('join', op.p);
    if (!p) return fail('bad payload');
    if (isMember) return fail('already a member');
    if (st.bans[a]) return fail('banned');
    let invites = st.invites;
    if (st.joinPolicy !== 'open') {
      const inv = p.code ? st.invites[p.code] : undefined;
      if (!inv) return fail('unknown invite');
      if (inv.revoked) return fail('invite revoked');
      if (inv.expiresAt !== null && t >= inv.expiresAt) return fail('invite expired');
      if (inv.maxUses !== null && inv.uses >= inv.maxUses) return fail('invite used up');
      invites = { ...st.invites, [inv.code]: { ...inv, uses: inv.uses + 1 } };
    }
    return {
      ok: true,
      st: { ...st, invites, members: { ...st.members, [a]: { pub: a, joinedAt: t, roles: [], nick: null, timeoutUntil: null } } },
    };
  }
  if (!isMember) return fail('not a member');
  const perms = basePerms(st, a, t);
  const need = (bit: number) => (perms & bit) === bit;

  switch (op.k) {
    case 'comm.update': {
      const p = parsePayload('comm.update', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.MANAGE_COMMUNITY)) return fail('missing MANAGE_COMMUNITY');
      if (p.systemChannel && st.channels[p.systemChannel]?.type !== 'text') return fail('bad system channel');
      const next = { ...st };
      if (p.name !== undefined) next.name = p.name;
      if (p.description !== undefined) next.description = p.description;
      if (p.icon !== undefined) next.icon = p.icon;
      if (p.banner !== undefined) next.banner = p.banner;
      if (p.theme !== undefined) next.theme = p.theme;
      if (p.joinPolicy !== undefined) next.joinPolicy = p.joinPolicy;
      if (p.systemChannel !== undefined) next.systemChannel = p.systemChannel;
      return { ok: true, st: next };
    }
    case 'ch.create': {
      const p = parsePayload('ch.create', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.MANAGE_CHANNELS)) return fail('missing MANAGE_CHANNELS');
      if (st.channels[p.id]) return fail('channel exists');
      if (Object.keys(st.channels).length >= LIMITS.maxChannels) return fail('too many channels');
      let parent = p.parent ?? null;
      if (p.type === 'category') parent = null;
      if (parent && st.channels[parent]?.type !== 'category') return fail('parent is not a category');
      const ch: Channel = { id: p.id, type: p.type, name: p.name, topic: p.topic ?? '', parent, pos: p.pos, overwrites: {} };
      return { ok: true, st: { ...st, channels: { ...st.channels, [p.id]: ch } } };
    }
    case 'ch.update': {
      const p = parsePayload('ch.update', op.p);
      if (!p) return fail('bad payload');
      const ch = st.channels[p.id];
      if (!ch) return fail('unknown channel');
      if (!need(P.MANAGE_CHANNELS)) return fail('missing MANAGE_CHANNELS');
      const next: Channel = { ...ch };
      if (p.name !== undefined) next.name = p.name;
      if (p.topic !== undefined) next.topic = p.topic;
      if (p.pos !== undefined) next.pos = p.pos;
      if (p.parent !== undefined) {
        if (ch.type === 'category' && p.parent) return fail('categories cannot nest');
        if (p.parent && st.channels[p.parent]?.type !== 'category') return fail('parent is not a category');
        next.parent = p.parent;
      }
      if (p.overwrites !== undefined) {
        if (!need(P.MANAGE_ROLES)) return fail('missing MANAGE_ROLES for overwrites');
        const g = grantable(st, a);
        const keys = new Set([...Object.keys(ch.overwrites), ...Object.keys(p.overwrites)]);
        for (const k of keys) {
          const before = ch.overwrites[k] ?? { allow: 0, deny: 0 };
          const after = p.overwrites[k] ?? { allow: 0, deny: 0 };
          const changed = (before.allow ^ after.allow) | (before.deny ^ after.deny);
          if (changed & ~g) return fail('cannot change permissions you do not have');
          if (k !== st.id && !st.roles[k] && !/^[0-9a-f]{64}$/.test(k)) return fail('bad overwrite target');
        }
        const ow: Record<string, Overwrite> = {};
        for (const [k, v] of Object.entries(p.overwrites)) {
          const o = { allow: v.allow & CHANNEL_PERMS, deny: v.deny & CHANNEL_PERMS & ~v.allow };
          if (o.allow || o.deny) ow[k] = o;
        }
        next.overwrites = ow;
      }
      return { ok: true, st: { ...st, channels: { ...st.channels, [p.id]: next } } };
    }
    case 'ch.delete': {
      const p = parsePayload('ch.delete', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.MANAGE_CHANNELS)) return fail('missing MANAGE_CHANNELS');
      if (!st.channels[p.id]) return fail('unknown channel');
      const channels: Record<string, Channel> = {};
      for (const [id, c] of Object.entries(st.channels)) {
        if (id === p.id) continue;
        channels[id] = c.parent === p.id ? { ...c, parent: null } : c;
      }
      return { ok: true, st: { ...st, channels, systemChannel: st.systemChannel === p.id ? null : st.systemChannel } };
    }
    case 'role.create': {
      const p = parsePayload('role.create', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.MANAGE_ROLES)) return fail('missing MANAGE_ROLES');
      if (st.roles[p.id] || p.id === st.id) return fail('role exists');
      if (Object.keys(st.roles).length >= LIMITS.maxRoles) return fail('too many roles');
      if (a !== st.owner && p.pos >= highestPos(st, a)) return fail('role must be below your highest role');
      if (p.perms & ~grantable(st, a)) return fail('cannot grant permissions you do not have');
      return { ok: true, st: { ...st, roles: { ...st.roles, [p.id]: { ...p, perms: p.perms & ALL_PERMS } } } };
    }
    case 'role.update': {
      const p = parsePayload('role.update', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.MANAGE_ROLES)) return fail('missing MANAGE_ROLES');
      const role = st.roles[p.id];
      if (!role) return fail('unknown role');
      const isEveryone = role.id === st.id;
      if (isEveryone && (p.name !== undefined || p.pos !== undefined || p.hoist !== undefined || p.mentionable !== undefined || p.color !== undefined))
        return fail('@everyone only has permissions');
      const h = highestPos(st, a);
      if (a !== st.owner && !isEveryone && role.pos >= h) return fail('role is not below your highest role');
      if (a !== st.owner && p.pos !== undefined && p.pos >= h) return fail('cannot move role above your highest role');
      const next = { ...role };
      if (p.perms !== undefined) {
        if ((role.perms ^ p.perms) & ~grantable(st, a)) return fail('cannot change permissions you do not have');
        next.perms = p.perms & ALL_PERMS;
      }
      if (p.name !== undefined) next.name = p.name;
      if (p.color !== undefined) next.color = p.color;
      if (p.pos !== undefined) next.pos = p.pos;
      if (p.hoist !== undefined) next.hoist = p.hoist;
      if (p.mentionable !== undefined) next.mentionable = p.mentionable;
      const reduced = (role.perms & ~next.perms) !== 0 || next.pos < role.pos;
      let rev: { affected: Set<string>; cutoff?: Record<string, number> } | undefined;
      if (reduced) {
        const affected = new Set(
          Object.values(st.members)
            .filter((m) => isEveryone || m.roles.includes(role.id))
            .map((m) => m.pub),
        );
        rev = { affected, cutoff: filterCutoff(p.cutoff, affected) };
      }
      return { ok: true, st: { ...st, roles: { ...st.roles, [p.id]: next } }, rev };
    }
    case 'role.delete': {
      const p = parsePayload('role.delete', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.MANAGE_ROLES)) return fail('missing MANAGE_ROLES');
      const role = st.roles[p.id];
      if (!role || role.id === st.id) return fail('unknown role');
      if (a !== st.owner && role.pos >= highestPos(st, a)) return fail('role is not below your highest role');
      const roles = { ...st.roles };
      delete roles[p.id];
      const members: Record<string, Member> = {};
      const affected = new Set<string>();
      for (const [k, m] of Object.entries(st.members)) {
        if (m.roles.includes(p.id)) {
          affected.add(k);
          members[k] = { ...m, roles: m.roles.filter((r) => r !== p.id) };
        } else members[k] = m;
      }
      return { ok: true, st: { ...st, roles, members }, rev: { affected, cutoff: filterCutoff(p.cutoff, affected) } };
    }
    case 'inv.create': {
      const p = parsePayload('inv.create', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.CREATE_INVITE)) return fail('missing CREATE_INVITE');
      if (st.invites[p.code]) return fail('invite code taken');
      const inv: Invite = { code: p.code, by: a, createdAt: op.t, expiresAt: p.expiresAt, maxUses: p.maxUses, uses: 0, revoked: false };
      return { ok: true, st: { ...st, invites: { ...st.invites, [p.code]: inv } } };
    }
    case 'inv.revoke': {
      const p = parsePayload('inv.revoke', op.p);
      if (!p) return fail('bad payload');
      const inv = st.invites[p.code];
      if (!inv) return fail('unknown invite');
      if (inv.by !== a && !need(P.MANAGE_COMMUNITY)) return fail('missing MANAGE_COMMUNITY');
      return { ok: true, st: { ...st, invites: { ...st.invites, [p.code]: { ...inv, revoked: true } } } };
    }
    case 'emoji.add': {
      const p = parsePayload('emoji.add', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.MANAGE_EMOJI)) return fail('missing MANAGE_EMOJI');
      const emojis = st.emojis ?? {};
      if (emojis[p.name]) return fail('emoji name taken');
      if (Object.keys(emojis).length >= LIMITS.maxEmoji) return fail('too many emoji');
      if (p.asset.size > LIMITS.emojiBytes || !/^image\/(png|gif|webp|jpeg)$/.test(p.asset.mime)) return fail('emoji must be a small image');
      return { ok: true, st: { ...st, emojis: { ...emojis, [p.name]: { name: p.name, asset: p.asset, by: a } } } };
    }
    case 'emoji.del': {
      const p = parsePayload('emoji.del', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.MANAGE_EMOJI)) return fail('missing MANAGE_EMOJI');
      if (!st.emojis?.[p.name]) return fail('unknown emoji');
      const emojis = { ...st.emojis };
      delete emojis[p.name];
      return { ok: true, st: { ...st, emojis } };
    }
    case 'leave': {
      if (a === st.owner) return fail('owner must transfer ownership first');
      const members = { ...st.members };
      delete members[a];
      return { ok: true, st: { ...st, members } };
    }
    case 'kick': {
      const p = parsePayload('kick', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.KICK)) return fail('missing KICK');
      if (!st.members[p.target]) return fail('not a member');
      if (p.target === a) return fail('cannot kick yourself');
      if (!canManageMember(st, a, p.target)) return fail('target is not below you');
      const members = { ...st.members };
      delete members[p.target];
      const affected = new Set([p.target]);
      return { ok: true, st: { ...st, members }, rev: { affected, cutoff: filterCutoff(p.cutoff, affected) } };
    }
    case 'ban': {
      const p = parsePayload('ban', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.BAN)) return fail('missing BAN');
      if (p.target === a) return fail('cannot ban yourself');
      if (p.target === st.owner) return fail('cannot ban the owner');
      if (st.members[p.target] && !canManageMember(st, a, p.target)) return fail('target is not below you');
      const members = { ...st.members };
      delete members[p.target];
      const ban: Ban = { by: a, reason: p.reason ?? '', at: op.t, purgeFrom: p.purgeSecs ? op.t - p.purgeSecs * 1000 : null };
      const affected = new Set([p.target]);
      return { ok: true, st: { ...st, members, bans: { ...st.bans, [p.target]: ban } }, rev: { affected, cutoff: filterCutoff(p.cutoff, affected) } };
    }
    case 'unban': {
      const p = parsePayload('unban', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.BAN)) return fail('missing BAN');
      if (!st.bans[p.target]) return fail('not banned');
      const bans = { ...st.bans };
      delete bans[p.target];
      return { ok: true, st: { ...st, bans } };
    }
    case 'timeout': {
      const p = parsePayload('timeout', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.TIMEOUT)) return fail('missing TIMEOUT');
      const m = st.members[p.target];
      if (!m) return fail('not a member');
      if (p.target === a) return fail('cannot time out yourself');
      if (!canManageMember(st, a, p.target)) return fail('target is not below you');
      if (p.until !== null && p.until > op.t + LIMITS.maxTimeoutMs) return fail('timeout too long');
      const st2 = { ...st, members: { ...st.members, [p.target]: { ...m, timeoutUntil: p.until } } };
      if (p.until === null) return { ok: true, st: st2 };
      const affected = new Set([p.target]);
      return { ok: true, st: st2, rev: { affected, cutoff: filterCutoff(p.cutoff, affected) } };
    }
    case 'mroles': {
      const p = parsePayload('mroles', op.p);
      if (!p) return fail('bad payload');
      if (!need(P.MANAGE_ROLES)) return fail('missing MANAGE_ROLES');
      const m = st.members[p.target];
      if (!m) return fail('not a member');
      if (p.target !== a && !canManageMember(st, a, p.target)) return fail('target is not below you');
      const nextRoles = [...new Set(p.roles)];
      const h = highestPos(st, a);
      const diff = [...nextRoles.filter((r) => !m.roles.includes(r)), ...m.roles.filter((r) => !nextRoles.includes(r))];
      for (const r of diff) {
        const role = st.roles[r];
        if (!role || r === st.id) return fail('unknown role');
        if (a !== st.owner && role.pos >= h) return fail('role is not below your highest role');
      }
      const removed = m.roles.some((r) => !nextRoles.includes(r));
      const st2 = { ...st, members: { ...st.members, [p.target]: { ...m, roles: nextRoles.filter((r) => st.roles[r]) } } };
      if (!removed) return { ok: true, st: st2 };
      const affected = new Set([p.target]);
      return { ok: true, st: st2, rev: { affected, cutoff: filterCutoff(p.cutoff, affected) } };
    }
    case 'nick': {
      const p = parsePayload('nick', op.p);
      if (!p) return fail('bad payload');
      const m = st.members[p.target];
      if (!m) return fail('not a member');
      if (p.target === a) {
        if (!need(P.CHANGE_NICK) && !need(P.MANAGE_NICKS)) return fail('missing CHANGE_NICK');
      } else {
        if (!need(P.MANAGE_NICKS)) return fail('missing MANAGE_NICKS');
        if (!canManageMember(st, a, p.target)) return fail('target is not below you');
      }
      return { ok: true, st: { ...st, members: { ...st.members, [p.target]: { ...m, nick: p.nick } } } };
    }
    case 'transfer': {
      const p = parsePayload('transfer', op.p);
      if (!p) return fail('bad payload');
      if (a !== st.owner) return fail('only the owner can transfer ownership');
      if (!st.members[p.target] || p.target === a) return fail('target must be another member');
      const affected = new Set([a]);
      return { ok: true, st: { ...st, owner: p.target }, rev: { affected, cutoff: filterCutoff(p.cutoff, affected) } };
    }
  }
  return fail('unknown kind');
}

// ---------------------------------------------------------------------------
// Group DM governance
// ---------------------------------------------------------------------------

function applyGroup(st: GroupState | null, op: Op): Result {
  const t = tEff(op);
  if (op.k === 'gcreate') {
    if (st) return fail('group exists');
    const p = parsePayload('gcreate', op.p);
    if (!p) return fail('bad payload');
    if (groupOrCommunityId(op.a, p.nonce) !== op.c) return fail('group id mismatch');
    const members: Record<string, GroupMember> = { [op.a]: { pub: op.a, joinedAt: op.t, addedBy: op.a } };
    for (const m of p.members) members[m] = { pub: m, joinedAt: op.t, addedBy: op.a };
    if (Object.keys(members).length > LIMITS.maxGroupMembers) return fail('too many members');
    return { ok: true, st: { kind: 'group', id: op.c, owner: op.a, name: p.name ?? '', icon: null, createdAt: op.t, members } };
  }
  if (!st) return fail('no group yet');
  if (!st.members[op.a]) return fail('not a member');
  switch (op.k) {
    case 'gadd': {
      const p = parsePayload('gadd', op.p);
      if (!p) return fail('bad payload');
      if (st.members[p.target]) return fail('already a member');
      if (Object.keys(st.members).length >= LIMITS.maxGroupMembers) return fail('group is full');
      return { ok: true, st: { ...st, members: { ...st.members, [p.target]: { pub: p.target, joinedAt: t, addedBy: op.a } } } };
    }
    case 'gremove': {
      const p = parsePayload('gremove', op.p);
      if (!p) return fail('bad payload');
      if (op.a !== st.owner) return fail('only the owner can remove members');
      if (!st.members[p.target] || p.target === op.a) return fail('bad target');
      const members = { ...st.members };
      delete members[p.target];
      const affected = new Set([p.target]);
      return { ok: true, st: { ...st, members }, rev: { affected, cutoff: filterCutoff(p.cutoff, affected) } };
    }
    case 'gleave': {
      const members = { ...st.members };
      delete members[op.a];
      let owner = st.owner;
      if (owner === op.a) {
        const next = Object.values(members).sort((x, y) => x.joinedAt - y.joinedAt || (x.pub < y.pub ? -1 : 1))[0];
        owner = next?.pub ?? '';
      }
      return { ok: true, st: { ...st, members, owner } };
    }
    case 'gupdate': {
      const p = parsePayload('gupdate', op.p);
      if (!p) return fail('bad payload');
      const next = { ...st };
      if (p.name !== undefined) next.name = p.name;
      if (p.icon !== undefined) next.icon = p.icon;
      return { ok: true, st: next };
    }
  }
  return fail('unknown kind');
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface RecomputeResult {
  /** messages at or after this key may have changed validity */
  retroFrom: EKey | null;
  /** authors whose earlier messages may have changed validity */
  authors: string[];
}

const MENTION_RE = /<@([0-9a-f]{64})>|<@&([0-9a-zA-Z_-]{6,64})>|(?:^|[^\w`])@(everyone|here)\b/g;

export function parseMentions(text: string) {
  const users = new Set<string>();
  const roles = new Set<string>();
  let everyone = false;
  let here = false;
  // ignore code spans/blocks
  const stripped = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  for (const m of stripped.matchAll(MENTION_RE)) {
    if (m[1]) users.add(m[1]);
    else if (m[2]) roles.add(m[2]);
    else if (m[3] === 'everyone') everyone = true;
    else if (m[3] === 'here') here = true;
  }
  return { users: [...users], roles: [...roles], everyone, here };
}

export class Engine {
  readonly type: ConvoType;
  readonly id: string;
  private readonly dmState: DmState | null;
  private gov = new Map<string, Op>();
  private chains = new Map<string, string>();
  private equivocated = new Set<string>();
  state: ConvoState | null = null;
  snaps: { key: EKey; st: ConvoState }[] = [];
  revs: Revocation[] = [];
  status = new Map<string, string>();
  version = 0;
  maxKey: EKey = [0, '', ''];
  maxLamport = 0;

  constructor(type: ConvoType, id: string, dmMembers?: [string, string]) {
    this.type = type;
    this.id = id;
    if (type === 'dm') {
      if (!dmMembers || dmId(dmMembers[0], dmMembers[1]) !== id) throw new Error('dm id mismatch');
      this.dmState = { kind: 'dm', id, members: { [dmMembers[0]]: { pub: dmMembers[0] }, [dmMembers[1]]: { pub: dmMembers[1] } } };
      this.state = this.dmState;
    } else this.dmState = null;
  }

  isGov(k: string) {
    return this.type === 'community' ? COMMUNITY_GOV.has(k) : this.type === 'group' ? GROUP_GOV.has(k) : false;
  }

  /** Track keys of every op (messages too) so we can detect out-of-order governance. */
  noteKey(op: Op) {
    const k = keyOf(op);
    if (cmpKey(k, this.maxKey) > 0) this.maxKey = k;
    if (op.l > this.maxLamport) this.maxLamport = op.l;
  }

  markEquivocated(id: string) {
    this.equivocated.add(id);
  }

  /** Add a verified governance op. Returns false if it was already known. Call recompute() after a batch. */
  addGov(op: Op): boolean {
    if (op.c !== this.id || !this.isGov(op.k) || this.gov.has(op.id)) return false;
    const chainKey = `${op.a}:${op.dv}:${op.s}`;
    const prev = this.chains.get(chainKey);
    if (prev && prev !== op.id) {
      this.equivocated.add(prev);
      this.equivocated.add(op.id);
    } else this.chains.set(chainKey, op.id);
    this.gov.set(op.id, op);
    return true;
  }

  hasGov(id: string) {
    return this.gov.has(id);
  }
  govOps(): Op[] {
    return [...this.gov.values()];
  }

  private apply(st: ConvoState | null, op: Op): Result {
    if (this.type === 'community') return applyCommunity(st as CommunityState | null, op);
    if (this.type === 'group') return applyGroup(st as GroupState | null, op);
    return fail('dms have no governance');
  }

  effKey(op: Op, revs: Revocation[] = this.revs): EKey {
    const own = keyOf(op);
    let k: EKey = own;
    for (const r of revs) {
      if (!r.affected.has(op.a) || r.id === op.id) continue;
      if (cmpKey(own, r.key) >= 0) continue;
      if (op.a === r.a && op.dv === r.dv && op.s < r.s) continue;
      const covered = op.s <= (r.cutoff[`${op.a}:${op.dv}`] ?? 0);
      if (covered) continue;
      const cand: EKey = [r.key[0], r.key[1], op.id];
      if (cmpKey(cand, k) > 0) k = cand;
    }
    return k;
  }

  private replay(items: { op: Op; key: EKey }[]) {
    let st: ConvoState | null = this.dmState;
    const snaps: { key: EKey; st: ConvoState }[] = [];
    const status = new Map<string, string>();
    const revs: Revocation[] = [];
    for (const { op, key } of items) {
      const r = this.apply(st, op);
      if (!r.ok) {
        status.set(op.id, r.reason);
        continue;
      }
      st = r.st;
      snaps.push({ key, st });
      status.set(op.id, 'ok');
      if (r.rev && r.rev.cutoff) {
        revs.push({ id: op.id, key: keyOf(op), a: op.a, dv: op.dv, s: op.s, affected: r.rev.affected, cutoff: r.rev.cutoff });
      }
    }
    return { st, snaps, status, revs };
  }

  recompute(): RecomputeResult {
    const prevRevIds = new Set(this.revs.map((r) => r.id));
    const prevStatus = this.status;
    const ops = [...this.gov.values()].filter((o) => !this.equivocated.has(o.id)).sort(cmpOps);
    for (const o of this.gov.values()) if (this.equivocated.has(o.id)) this.status.set(o.id, 'equivocation');
    const pass0 = this.replay(ops.map((op) => ({ op, key: keyOf(op) })));
    const revs = pass0.revs;
    const items = ops.map((op) => ({ op, key: this.effKey(op, revs) })).sort((x, y) => cmpKey(x.key, y.key));
    const pass1 = this.replay(items);
    this.state = pass1.st;
    this.snaps = pass1.snaps;
    this.status = pass1.status;
    for (const id of this.equivocated) if (this.gov.has(id)) this.status.set(id, 'equivocation');
    this.revs = revs;
    this.version++;

    // What could have changed for already-materialized messages?
    let retroFrom: EKey | null = null;
    const authors = new Set<string>();
    for (const op of ops) {
      const was = prevStatus.get(op.id);
      const now = this.status.get(op.id);
      if (was === now) continue;
      const k = keyOf(op);
      if (cmpKey(k, this.maxKey) < 0 && (retroFrom === null || cmpKey(k, retroFrom) < 0)) retroFrom = k;
    }
    for (const r of revs) if (!prevRevIds.has(r.id)) for (const a of r.affected) authors.add(a);
    return { retroFrom, authors: [...authors] };
  }

  /** State just before the given (effective) key. */
  stateAt(key: EKey): ConvoState | null {
    const s = this.snaps;
    let lo = 0;
    let hi = s.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cmpKey(s[mid].key, key) < 0) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best >= 0 ? s[best].st : this.dmState;
  }

  isMemberAt(st: ConvoState | null, pub: string) {
    return !!st && !!st.members[pub];
  }

  /** Validate a message-level op (msg/edit/del/react/pin) against state at its effective position. */
  checkMessageOp(op: Op): { ok: boolean; reason?: string; st?: ConvoState } {
    if (op.c !== this.id) return { ok: false, reason: 'wrong conversation' };
    const st = this.stateAt(this.effKey(op));
    if (!st) return { ok: false, reason: 'no state' };
    if (!st.members[op.a]) return { ok: false, reason: 'not a member' };
    if (op.p === undefined) return { ok: true, st }; // redacted: validity only matters for header
    if (op.k === 'msg') {
      const p = parsePayload('msg', op.p);
      if (!p) return { ok: false, reason: 'bad payload' };
      if (p.text.trim() === '' && !(p.att && p.att.length) && !p.poll && !(p.embeds && p.embeds.length)) return { ok: false, reason: 'empty message' };
      if (st.kind === 'community') {
        const ch = st.channels[p.ch];
        if (!ch || ch.type !== 'text') return { ok: false, reason: 'unknown channel' };
        const cp = channelPerms(st, op.a, p.ch, tEff(op));
        if (!(cp & P.SEND)) return { ok: false, reason: 'missing SEND' };
        if (p.att && p.att.length && !(cp & P.ATTACH)) return { ok: false, reason: 'missing ATTACH' };
      } else if (p.ch !== 'main') return { ok: false, reason: 'bad channel' };
      return { ok: true, st };
    }
    const kind = op.k as 'edit' | 'del' | 'react' | 'pin' | 'vote' | 'interact';
    if (!parsePayload(kind, op.p)) return { ok: false, reason: 'bad payload' };
    return { ok: true, st };
  }

  /**
   * Fold a message and every op targeting it into its current form.
   * Returns null if the message itself is invalid.
   */
  materialize(msgOp: Op, related: Op[]): Message | null {
    const base = this.checkMessageOp(msgOp);
    if (!base.ok || !base.st) return null;
    const p = msgOp.p === undefined ? null : parsePayload('msg', msgOp.p);
    if (msgOp.p !== undefined && !p) return null;
    const st0 = base.st;
    let canPingAll = true;
    const mentions = p ? parseMentions(p.text) : { users: [], roles: [], everyone: false, here: false };
    if (st0.kind === 'community' && p) {
      canPingAll = (channelPerms(st0, msgOp.a, p.ch, tEff(msgOp)) & P.MENTION_EVERYONE) !== 0;
      mentions.roles = mentions.roles.filter((r) => st0.roles[r] && (canPingAll || st0.roles[r].mentionable));
    }
    const m: Message = {
      id: msgOp.id,
      c: msgOp.c,
      ch: p?.ch ?? '',
      a: msgOp.a,
      t: Math.min(msgOp.t, msgOp.rcv ?? msgOp.t),
      l: msgOp.l,
      text: p?.text ?? '',
      att: p?.att ?? [],
      reply: p?.reply ?? null,
      editedAt: null,
      deleted: p === null,
      reacts: {},
      pinned: false,
      pinnedAt: null,
      mentions,
      canPingAll,
      history: [],
      poll: p?.poll ? { q: p.poll.q, options: p.poll.options, multi: p.poll.multi, ends: p.poll.ends, votes: {} } : null,
      embeds: p?.embeds ?? [],
      buttons: p?.buttons ?? [],
    };
    const ch = m.ch;
    for (const op of [...related].sort(cmpOps)) {
      if (op.p === undefined) continue;
      const chk = this.checkMessageOp(op);
      if (!chk.ok || !chk.st) continue;
      const st = chk.st;
      const managePerm = st.kind === 'community' ? (channelPerms(st, op.a, ch, tEff(op)) & P.MANAGE_MESSAGES) !== 0 : false;
      switch (op.k) {
        case 'edit': {
          const e = parsePayload('edit', op.p)!;
          if (e.id !== m.id || op.a !== m.a || m.deleted) break;
          if (m.history.length < 50) m.history.push({ text: m.text, at: m.editedAt ?? m.t });
          m.text = e.text;
          m.editedAt = op.t;
          if (e.embeds) m.embeds = e.embeds;
          if (e.buttons) m.buttons = e.buttons;
          m.mentions = parseMentions(e.text);
          if (st.kind === 'community') m.mentions.roles = m.mentions.roles.filter((r) => st.roles[r] && (canPingAll || st.roles[r].mentionable));
          break;
        }
        case 'del': {
          const d = parsePayload('del', op.p)!;
          if (d.id !== m.id) break;
          if (op.a === m.a || managePerm) m.deleted = true;
          break;
        }
        case 'react': {
          const r = parsePayload('react', op.p)!;
          if (r.id !== m.id) break;
          const list = new Set(m.reacts[r.e] ?? []);
          if (r.on) {
            if (st.kind === 'community' && !(channelPerms(st, op.a, ch, tEff(op)) & P.REACT)) break;
            if (!list.has(op.a) && Object.keys(m.reacts).length >= 20 && !m.reacts[r.e]) break;
            list.add(op.a);
          } else list.delete(op.a);
          if (list.size) m.reacts[r.e] = [...list];
          else delete m.reacts[r.e];
          break;
        }
        case 'pin': {
          const pn = parsePayload('pin', op.p)!;
          if (pn.id !== m.id) break;
          if (st.kind === 'community' && !managePerm) break;
          m.pinned = pn.on;
          m.pinnedAt = pn.on ? op.t : null;
          break;
        }
        case 'vote': {
          const v = parsePayload('vote', op.p)!;
          const poll = m.poll;
          if (v.id !== m.id || !poll) break;
          if (poll.ends !== null && tEff(op) >= poll.ends) break;
          if (st.kind === 'community' && !(channelPerms(st, op.a, ch, tEff(op)) & P.REACT)) break;
          const choices = [...new Set(v.choices)].filter((n) => n < poll.options.length).sort((x, y) => x - y);
          if (!poll.multi && choices.length > 1) break;
          if (choices.length) poll.votes[op.a] = choices;
          else delete poll.votes[op.a];
          break;
        }
      }
    }
    const fin = this.state;
    if (fin && fin.kind === 'community') {
      const ban = fin.bans[m.a];
      if (ban && ban.purgeFrom !== null && m.t >= ban.purgeFrom) m.deleted = true;
    }
    if (m.deleted) {
      m.text = '';
      m.att = [];
      m.reacts = {};
      m.pinned = false;
      m.history = [];
      m.poll = null;
      m.embeds = [];
      m.buttons = [];
    }
    return m;
  }

  /**
   * Is this 'interact' op a legitimate button press on message `m`? Checked by whoever runs the
   * bot that wrote `m` (the press itself changes no shared state).
   */
  checkInteraction(op: Op, m: Message): { ok: true; button: MsgButton } | { ok: false; reason: string } {
    if (op.k !== 'interact') return { ok: false, reason: 'not an interaction' };
    const chk = this.checkMessageOp(op);
    if (!chk.ok || !chk.st) return { ok: false, reason: chk.reason ?? 'invalid' };
    const p = parsePayload('interact', op.p);
    if (!p || p.id !== m.id || m.deleted) return { ok: false, reason: 'bad target' };
    const button = m.buttons.find((b) => b.id === p.b);
    if (!button || button.disabled || button.style === 'link') return { ok: false, reason: 'no such button' };
    const st = chk.st;
    if (st.kind === 'community' && !(channelPerms(st, op.a, m.ch, tEff(op)) & (P.REACT | P.SEND))) return { ok: false, reason: 'missing permission' };
    return { ok: true, button };
  }
}

export function sortedChannels(st: CommunityState) {
  const all = Object.values(st.channels);
  const byPos = (x: Channel, y: Channel) => x.pos - y.pos || (x.id < y.id ? -1 : 1);
  const cats = all.filter((c) => c.type === 'category').sort(byPos);
  const loose = all.filter((c) => c.type !== 'category' && !c.parent).sort(byPos);
  const groups = cats.map((cat) => ({ cat, items: all.filter((c) => c.parent === cat.id).sort(byPos) }));
  return { loose, groups };
}

export function sortedRoles(st: CommunityState) {
  return Object.values(st.roles)
    .filter((r) => r.id !== st.id)
    .sort((x, y) => y.pos - x.pos || (x.id < y.id ? -1 : 1));
}

export function memberColor(st: CommunityState, pub: string): string | null {
  const m = st.members[pub];
  if (!m) return null;
  let best: Role | null = null;
  for (const r of m.roles) {
    const role = st.roles[r];
    if (role?.color && (!best || role.pos > best.pos)) best = role;
  }
  return best?.color ?? null;
}

export type { Payload };

import { describe, it, expect } from 'vitest';
import { keysFromSeed, newSeed, sealSigned, unsealSigned, type Keys } from '@shared/crypto';
import { createOp, verifyOp, groupOrCommunityId, dmId, type Op } from '@shared/ops';
import { Engine, type CommunityState } from '@shared/engine';
import { P, DEFAULT_EVERYONE } from '@shared/perms';
import { randomHex } from '@shared/bytes';

class Actor {
  keys: Keys;
  dv = randomHex(8);
  seq = new Map<string, number>();
  constructor() {
    this.keys = keysFromSeed(newSeed());
  }
  get pub() {
    return this.keys.pub;
  }
  op(c: string, k: string, p: unknown, l: number): Op {
    const s = (this.seq.get(c) ?? 0) + 1;
    this.seq.set(c, s);
    return createOp(this.keys, this.dv, { c, s, l, k, p });
  }
  cut(c: string) {
    return { [`${this.pub}:${this.dv}`]: this.seq.get(c) ?? 0 };
  }
}

function community(owner: Actor) {
  const nonce = randomHex(16);
  const c = groupOrCommunityId(owner.pub, nonce);
  const genesis = owner.op(c, 'genesis', {
    name: 'Test',
    nonce,
    channels: [
      { id: 'general01', type: 'text', name: 'general', pos: 0 },
      { id: 'news00001', type: 'text', name: 'news', pos: 1 },
      { id: 'voice0001', type: 'voice', name: 'Lounge', pos: 2 },
    ],
  }, 1);
  const eng = new Engine('community', c);
  eng.addGov(genesis);
  eng.recompute();
  return { c, eng };
}

let clock = 10;
const L = () => ++clock;

function feed(eng: Engine, ...ops: Op[]) {
  for (const op of ops) {
    expect(verifyOp(op)).toBe(true);
    eng.noteKey(op);
    if (eng.isGov(op.k)) eng.addGov(op);
  }
  return eng.recompute();
}
const st = (eng: Engine) => eng.state as CommunityState;

describe('ops', () => {
  it('verifies and detects tampering', () => {
    const a = new Actor();
    const op = a.op(randomHex(32), 'msg', { ch: 'main', text: 'hi' }, 1);
    expect(verifyOp(op)).toBe(true);
    expect(verifyOp({ ...op, p: { ch: 'main', text: 'evil' } })).toBe(false);
    expect(verifyOp({ ...op, l: 99 })).toBe(false);
    const { p: _p, ...redacted } = op;
    expect(verifyOp(redacted)).toBe(true);
  });

  it('sealed envelopes authenticate the sender', async () => {
    const a = new Actor();
    const b = new Actor();
    const box = await sealSigned(a.keys, b.pub, { hello: 'world' });
    const env = await unsealSigned(b.keys, box);
    expect(env.from).toBe(a.pub);
    expect(env.body).toEqual({ hello: 'world' });
    await expect(unsealSigned(a.keys, box)).rejects.toThrow();
  });
});

describe('community engine', () => {
  it('genesis, invites and membership', () => {
    const owner = new Actor();
    const bob = new Actor();
    const eve = new Actor();
    const { c, eng } = community(owner);
    expect(st(eng).owner).toBe(owner.pub);
    expect(st(eng).roles[c].perms).toBe(DEFAULT_EVERYONE);

    const badJoin = eve.op(c, 'join', { code: 'nope1234' }, L());
    feed(eng, badJoin);
    expect(eng.status.get(badJoin.id)).toBe('unknown invite');

    const inv = owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: 1 }, L());
    const join = bob.op(c, 'join', { code: 'abc123' }, L());
    const join2 = eve.op(c, 'join', { code: 'abc123' }, L());
    feed(eng, inv, join, join2);
    expect(st(eng).members[bob.pub]).toBeTruthy();
    expect(eng.status.get(join2.id)).toBe('invite used up');

    const msg = bob.op(c, 'msg', { ch: 'general01', text: 'hello' }, L());
    expect(eng.checkMessageOp(msg).ok).toBe(true);
    const evil = eve.op(c, 'msg', { ch: 'general01', text: 'spam' }, L());
    expect(eng.checkMessageOp(evil).ok).toBe(false);
    const voiceMsg = bob.op(c, 'msg', { ch: 'voice0001', text: 'x' }, L());
    expect(eng.checkMessageOp(voiceMsg).ok).toBe(false);
  });

  it('channel overwrites make read-only channels', () => {
    const owner = new Actor();
    const bob = new Actor();
    const { c, eng } = community(owner);
    feed(eng, owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: null }, L()), bob.op(c, 'join', { code: 'abc123' }, L()));
    feed(eng, owner.op(c, 'ch.update', { id: 'news00001', overwrites: { [c]: { allow: 0, deny: P.SEND } } }, L()));
    expect(eng.checkMessageOp(bob.op(c, 'msg', { ch: 'news00001', text: 'x' }, L())).ok).toBe(false);
    expect(eng.checkMessageOp(owner.op(c, 'msg', { ch: 'news00001', text: 'x' }, L())).ok).toBe(true);
    expect(eng.checkMessageOp(bob.op(c, 'msg', { ch: 'general01', text: 'x' }, L())).ok).toBe(true);
  });

  it('role hierarchy blocks moderators from acting upward', () => {
    const owner = new Actor();
    const mod = new Actor();
    const admin = new Actor();
    const { c, eng } = community(owner);
    feed(
      eng,
      owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: null }, L()),
      mod.op(c, 'join', { code: 'abc123' }, L()),
      admin.op(c, 'join', { code: 'abc123' }, L()),
      owner.op(c, 'role.create', { id: 'role_admin', name: 'Admin', color: '#ff0000', perms: P.KICK | P.BAN | P.MANAGE_ROLES, pos: 2, hoist: true, mentionable: false }, L()),
      owner.op(c, 'role.create', { id: 'role_mod', name: 'Mod', color: '#00ff00', perms: P.KICK, pos: 1, hoist: true, mentionable: false }, L()),
      owner.op(c, 'mroles', { target: admin.pub, roles: ['role_admin'] }, L()),
      owner.op(c, 'mroles', { target: mod.pub, roles: ['role_mod'] }, L()),
    );
    const k = mod.op(c, 'kick', { target: admin.pub, cutoff: {} }, L());
    feed(eng, k);
    expect(eng.status.get(k.id)).toBe('target is not below you');
    const grant = mod.op(c, 'role.create', { id: 'role_x', name: 'X', color: null, perms: P.BAN, pos: 1, hoist: false, mentionable: false }, L());
    feed(eng, grant);
    expect(eng.status.get(grant.id)).toBe('missing MANAGE_ROLES');
    const k2 = admin.op(c, 'kick', { target: mod.pub, cutoff: mod.cut(c) }, L());
    feed(eng, k2);
    expect(eng.status.get(k2.id)).toBe('ok');
    expect(st(eng).members[mod.pub]).toBeUndefined();
  });

  it('kick cutoff keeps old messages and drops unseen ones', () => {
    const owner = new Actor();
    const bob = new Actor();
    const { c, eng } = community(owner);
    feed(eng, owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: null }, L()), bob.op(c, 'join', { code: 'abc123' }, L()));
    const seen = bob.op(c, 'msg', { ch: 'general01', text: 'seen' }, L());
    feed(eng, seen);
    const cut = bob.cut(c);
    // Bob posts concurrently (same lamport as the kick) but the owner had not seen it.
    const kickL = L();
    const unseen = bob.op(c, 'msg', { ch: 'general01', text: 'unseen' }, kickL - 1);
    const kick = owner.op(c, 'kick', { target: bob.pub, cutoff: cut }, kickL);
    feed(eng, unseen, kick);
    expect(eng.checkMessageOp(seen).ok).toBe(true);
    expect(eng.checkMessageOp(unseen).ok).toBe(false);
  });

  it('demoted admin cannot backdate a ban', () => {
    const owner = new Actor();
    const admin = new Actor();
    const bob = new Actor();
    const { c, eng } = community(owner);
    feed(
      eng,
      owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: null }, L()),
      admin.op(c, 'join', { code: 'abc123' }, L()),
      bob.op(c, 'join', { code: 'abc123' }, L()),
      owner.op(c, 'role.create', { id: 'role_admin', name: 'Admin', color: null, perms: P.BAN, pos: 1, hoist: false, mentionable: false }, L()),
      owner.op(c, 'mroles', { target: admin.pub, roles: ['role_admin'] }, L()),
    );
    const backdatedL = L();
    const demote = owner.op(c, 'mroles', { target: admin.pub, roles: [], cutoff: admin.cut(c) }, L());
    feed(eng, demote);
    // After seeing the demotion the admin signs a ban with an OLD lamport clock.
    const evilBan = admin.op(c, 'ban', { target: bob.pub, cutoff: {} }, backdatedL);
    feed(eng, evilBan);
    expect(eng.status.get(evilBan.id)).toBe('missing BAN');
    expect(st(eng).members[bob.pub]).toBeTruthy();
    expect(st(eng).bans[bob.pub]).toBeUndefined();
  });

  it('equivocation invalidates both ops', () => {
    const owner = new Actor();
    const { c, eng } = community(owner);
    const s = (owner.seq.get(c) ?? 0) + 1;
    const a = createOp(owner.keys, owner.dv, { c, s, l: L(), k: 'ch.create', p: { id: 'chan_aaaa', type: 'text', name: 'a', pos: 5 } });
    const b = createOp(owner.keys, owner.dv, { c, s, l: L(), k: 'ch.create', p: { id: 'chan_bbbb', type: 'text', name: 'b', pos: 6 } });
    feed(eng, a, b);
    expect(eng.status.get(a.id)).toBe('equivocation');
    expect(st(eng).channels['chan_aaaa']).toBeUndefined();
  });

  it('materializes edits, deletes, reactions, pins and ban purges', () => {
    const owner = new Actor();
    const bob = new Actor();
    const eve = new Actor();
    const { c, eng } = community(owner);
    feed(
      eng,
      owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: null }, L()),
      bob.op(c, 'join', { code: 'abc123' }, L()),
      eve.op(c, 'join', { code: 'abc123' }, L()),
    );
    const m = bob.op(c, 'msg', { ch: 'general01', text: 'hello <@' + eve.pub + '> @everyone' }, L());
    const forged = eve.op(c, 'edit', { id: m.id, text: 'forged' }, L());
    const edit = bob.op(c, 'edit', { id: m.id, text: 'hello again' }, L());
    const r1 = eve.op(c, 'react', { id: m.id, e: '🔥', on: true }, L());
    const r2 = owner.op(c, 'react', { id: m.id, e: '🔥', on: true }, L());
    const r3 = eve.op(c, 'react', { id: m.id, e: '🔥', on: false }, L());
    const pinByBob = bob.op(c, 'pin', { id: m.id, on: true }, L());
    let out = eng.materialize(m, [forged, edit, r1, r2, r3, pinByBob])!;
    expect(out.text).toBe('hello again');
    expect(out.reacts['🔥']).toEqual([owner.pub]);
    expect(out.pinned).toBe(false);
    const pin = owner.op(c, 'pin', { id: m.id, on: true }, L());
    out = eng.materialize(m, [pin])!;
    expect(out.pinned).toBe(true);
    expect(eng.materialize(m, [])!.canPingAll).toBe(false);
    expect(eng.materialize(m, [])!.mentions.users).toEqual([eve.pub]);
    const del = owner.op(c, 'del', { id: m.id }, L());
    expect(eng.materialize(m, [del])!.deleted).toBe(true);

    const ban = owner.op(c, 'ban', { target: bob.pub, purgeSecs: 3600, cutoff: bob.cut(c) }, L());
    feed(eng, ban);
    expect(eng.materialize(m, [])!.deleted).toBe(true);
    expect(eng.checkMessageOp(bob.op(c, 'msg', { ch: 'general01', text: 'back' }, L())).ok).toBe(false);
    const rejoin = bob.op(c, 'join', { code: 'abc123' }, L());
    feed(eng, rejoin);
    expect(eng.status.get(rejoin.id)).toBe('banned');
  });

  it('timeouts block sending until they expire', () => {
    const owner = new Actor();
    const bob = new Actor();
    const { c, eng } = community(owner);
    feed(eng, owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: null }, L()), bob.op(c, 'join', { code: 'abc123' }, L()));
    feed(eng, owner.op(c, 'timeout', { target: bob.pub, until: Date.now() + 60_000, cutoff: bob.cut(c) }, L()));
    const during = bob.op(c, 'msg', { ch: 'general01', text: 'x' }, L());
    expect(eng.checkMessageOp(during).ok).toBe(false);
    const after = createOp(bob.keys, bob.dv, { c, s: 99, l: L(), k: 'msg', p: { ch: 'general01', text: 'y' }, t: Date.now() + 120_000 });
    expect(eng.checkMessageOp(after).ok).toBe(true);
  });

  it('ownership transfer', () => {
    const owner = new Actor();
    const bob = new Actor();
    const { c, eng } = community(owner);
    feed(eng, owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: null }, L()), bob.op(c, 'join', { code: 'abc123' }, L()));
    const leave = owner.op(c, 'leave', {}, L());
    feed(eng, leave);
    expect(eng.status.get(leave.id)).toBe('owner must transfer ownership first');
    feed(eng, owner.op(c, 'transfer', { target: bob.pub, cutoff: owner.cut(c) }, L()));
    expect(st(eng).owner).toBe(bob.pub);
    const k = owner.op(c, 'kick', { target: bob.pub, cutoff: {} }, L());
    feed(eng, k);
    expect(eng.status.get(k.id)).toBe('missing KICK');
  });
});

describe('polls, emoji and edit history', () => {
  it('counts the latest vote per member and respects single choice and deadlines', () => {
    const owner = new Actor();
    const bob = new Actor();
    const { c, eng } = community(owner);
    feed(eng, owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: null }, L()), bob.op(c, 'join', { code: 'abc123' }, L()));
    const poll = owner.op(c, 'msg', { ch: 'general01', text: '', poll: { q: 'Pizza?', options: ['yes', 'no'], multi: false, ends: Date.now() + 60_000 } }, L());
    expect(eng.checkMessageOp(poll).ok).toBe(true);
    const v1 = bob.op(c, 'vote', { id: poll.id, choices: [0] }, L());
    const v2 = bob.op(c, 'vote', { id: poll.id, choices: [1] }, L());
    const both = owner.op(c, 'vote', { id: poll.id, choices: [0, 1] }, L());
    const out = eng.materialize(poll, [v1, v2, both])!;
    expect(out.poll!.votes[bob.pub]).toEqual([1]);
    expect(out.poll!.votes[owner.pub]).toBeUndefined();
    const late = createOp(bob.keys, bob.dv, { c, s: 50, l: L(), k: 'vote', p: { id: poll.id, choices: [0] }, t: Date.now() + 120_000 });
    expect(eng.materialize(poll, [v2, late])!.poll!.votes[bob.pub]).toEqual([1]);
  });

  it('only emoji managers add emoji; edits keep history', () => {
    const owner = new Actor();
    const bob = new Actor();
    const { c, eng } = community(owner);
    feed(eng, owner.op(c, 'inv.create', { code: 'abc123', expiresAt: null, maxUses: null }, L()), bob.op(c, 'join', { code: 'abc123' }, L()));
    const asset = { hash: 'a'.repeat(64), mime: 'image/png', size: 2000 };
    const evil = bob.op(c, 'emoji.add', { name: 'pog', asset }, L());
    const good = owner.op(c, 'emoji.add', { name: 'pog', asset }, L());
    feed(eng, evil, good);
    expect(eng.status.get(evil.id)).toBe('missing MANAGE_EMOJI');
    expect(st(eng).emojis.pog.by).toBe(owner.pub);
    const m = bob.op(c, 'msg', { ch: 'general01', text: 'v1' }, L());
    const e1 = bob.op(c, 'edit', { id: m.id, text: 'v2' }, L());
    const e2 = bob.op(c, 'edit', { id: m.id, text: 'v3' }, L());
    const out = eng.materialize(m, [e1, e2])!;
    expect(out.text).toBe('v3');
    expect(out.history.map((h) => h.text)).toEqual(['v1', 'v2']);
  });
});

describe('dm and group engines', () => {
  it('dm only accepts the two participants', () => {
    const a = new Actor();
    const b = new Actor();
    const e = new Actor();
    const c = dmId(a.pub, b.pub);
    const eng = new Engine('dm', c, [a.pub, b.pub]);
    expect(eng.checkMessageOp(a.op(c, 'msg', { ch: 'main', text: 'hi' }, 1)).ok).toBe(true);
    expect(eng.checkMessageOp(e.op(c, 'msg', { ch: 'main', text: 'hi' }, 2)).ok).toBe(false);
  });

  it('group membership changes', () => {
    const a = new Actor();
    const b = new Actor();
    const d = new Actor();
    const nonce = randomHex(16);
    const c = groupOrCommunityId(a.pub, nonce);
    const eng = new Engine('group', c);
    feed(eng, a.op(c, 'gcreate', { nonce, members: [b.pub] }, 1));
    expect(eng.checkMessageOp(b.op(c, 'msg', { ch: 'main', text: 'hi' }, 2)).ok).toBe(true);
    expect(eng.checkMessageOp(d.op(c, 'msg', { ch: 'main', text: 'hi' }, 3)).ok).toBe(false);
    feed(eng, b.op(c, 'gadd', { target: d.pub }, 4));
    expect(eng.checkMessageOp(d.op(c, 'msg', { ch: 'main', text: 'hi' }, 5)).ok).toBe(true);
    const rm = b.op(c, 'gremove', { target: d.pub, cutoff: {} }, 6);
    feed(eng, rm);
    expect(eng.status.get(rm.id)).toBe('only the owner can remove members');
    feed(eng, a.op(c, 'gleave', {}, 7));
    expect((eng.state as { owner: string }).owner).toBe(b.pub);
  });
});

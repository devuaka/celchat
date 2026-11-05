/**
 * Peer protocol: hello, anti-entropy sync (version vectors), op gossip and
 * signed ephemeral events (typing, voice presence).
 */
import { Emitter } from './emitter';
import type { PeerConn, PeerManager } from './peers';
import type { Convos } from './convos';
import type { StoredOp } from './db';
import { cleanOp } from './verify';
import { signObject, verifyObject, type Keys } from '@shared/crypto';
import { randomHex } from '@shared/bytes';
import { verifyProfile, type ProfileCard } from '@shared/profile';
import type { CommunityState } from '@shared/engine';
import type { Op } from '@shared/ops';

export interface Eph {
  id: string;
  c: string;
  a: string;
  k: string;
  d: Record<string, unknown>;
  ts: number;
  sig: string;
}

type Events = {
  hello: [PeerConn, ProfileCard | null];
  profile: [ProfileCard, PeerConn];
  eph: [Eph, PeerConn];
  synced: [string, PeerConn];
  denied: [string, PeerConn, string];
  receipt: [string, string, number];
  friends: [string, string[]];
  accepted: [StoredOp[], PeerConn];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Sync extends Emitter<Events> {
  private seenEph = new Map<string, number>();
  myCard: () => ProfileCard | null = () => null;
  invisible: () => boolean = () => false;
  profileOf: (pub: string) => ProfileCard | null = () => null;
  /** lets the app create DM / group conversations for ops it has never seen */
  prepare: (raws: unknown[], from: PeerConn) => Promise<void> = async () => undefined;
  private inflight = new Map<string, number>();

  constructor(
    private keys: Keys,
    private peers: PeerManager,
    private convos: Convos,
  ) {
    super();
    peers.on('open', (l) => this.sayHello(l));
    // Per-link ordering: a 'sdone' must not be handled before the 'sops' that preceded it.
    const queues = new WeakMap<PeerConn, Promise<void>>();
    peers.on('msg', (l, m) => {
      const next = (queues.get(l) ?? Promise.resolve()).then(() => this.onMsg(l, m)).catch((e) => console.warn('[sync]', m.t, e));
      queues.set(l, next);
    });
    setInterval(() => {
      const cut = Date.now() - 120_000;
      for (const [k, t] of this.seenEph) if (t < cut) this.seenEph.delete(k);
    }, 60_000);
  }

  get me() {
    return this.keys.pub;
  }

  private sayHello(l: PeerConn) {
    l.helloSent = true;
    l.send({ t: 'hello', v: 1, card: this.myCard(), inv: this.invisible() });
  }

  /** Is `pub` someone we exchange data about `c` with? */
  shares(c: string, pub: string, link?: PeerConn): boolean {
    if (pub === this.me) return true;
    const convo = this.convos.get(c);
    if (!convo) return false;
    if (convo.rec.type === 'dm') return convo.rec.peer === pub;
    const st = convo.eng.state;
    if (st?.members[pub]) return true;
    if (convo.rec.type === 'community' && link?.purposes.has('c:' + c)) return true;
    return false;
  }

  /** May `pub` pull the history of `c` from us? 'gov' = governance only (ex-members learn they were removed). */
  private authorized(c: string, pub: string, code?: string): string | null {
    if (pub === this.me) return null;
    const convo = this.convos.get(c);
    if (!convo) return 'unknown';
    if (!convo.eng.state?.members[this.me]) return 'not a member';
    if (convo.rec.type === 'dm') return convo.rec.peer === pub ? null : 'forbidden';
    const st = convo.eng.state;
    if (st.members[pub]) return null;
    if (convo.authors.has(pub) && !code) return 'gov';
    if (convo.rec.type === 'community') {
      const cs = st as CommunityState;
      if (cs.bans[pub]) return 'banned';
      if (cs.joinPolicy === 'open') return null;
      const inv = code ? cs.invites[code] : undefined;
      if (inv && !inv.revoked && (inv.expiresAt === null || Date.now() < inv.expiresAt) && (inv.maxUses === null || inv.uses < inv.maxUses)) return null;
      return 'invite required';
    }
    return 'forbidden';
  }

  /** Start anti-entropy for every conversation we share with this link. */
  async syncAll(l: PeerConn) {
    for (const convo of this.convos.list()) {
      if (convo.rec.left) continue;
      if (this.shares(convo.rec.c, l.pub, l)) await this.requestSync(convo.rec.c, l);
    }
  }

  async requestSync(c: string, l: PeerConn) {
    const key = c + l.addr;
    const last = this.inflight.get(key) ?? 0;
    if (Date.now() - last < 3000) return;
    this.inflight.set(key, Date.now());
    const convo = this.convos.get(c);
    if (!convo || !l.usable) return;
    l.send({ t: 'sreq', c, vv: await this.convos.vv(c), code: convo.rec.joinCode });
  }

  private async onMsg(l: PeerConn, m: Record<string, unknown>) {
    switch (m.t) {
      case 'hello': {
        const card = m.card ? verifyProfile(m.card) : null;
        l.helloReceived = true;
        l.remoteInvisible = !!m.inv;
        if (card && card.pub !== l.pub) return;
        if (!l.helloSent) this.sayHello(l);
        this.emit('hello', l, card);
        await this.syncAll(l);
        return;
      }
      case 'sreq': {
        const c = String(m.c ?? '');
        const why = this.authorized(c, l.pub, typeof m.code === 'string' ? m.code : undefined);
        if (why && why !== 'gov') {
          l.send({ t: 'sdeny', c, why });
          return;
        }
        const vv = m.vv && typeof m.vv === 'object' ? (m.vv as Record<string, number>) : {};
        const ops = await this.convos.missingFor(c, vv, why === 'gov');
        let batch: Op[] = [];
        let size = 0;
        for (const op of ops) {
          const s = JSON.stringify(op).length;
          if (batch.length && (size + s > 180_000 || batch.length >= 200)) {
            l.send({ t: 'sops', c, ops: batch });
            if (l.state === 'relay') await sleep(700);
            batch = [];
            size = 0;
          }
          batch.push(op);
          size += s;
        }
        if (batch.length) l.send({ t: 'sops', c, ops: batch });
        l.send({ t: 'sdone', c, n: ops.length });
        // ask back so both sides converge
        if (this.shares(c, l.pub, l)) void this.requestSync(c, l);
        return;
      }
      case 'sops': {
        if (!Array.isArray(m.ops) || m.ops.length > 400) return;
        const acc = await this.convos.ingest(m.ops, l.addr);
        if (acc.length) this.emit('accepted', acc, l);
        return;
      }
      case 'sdone':
        this.emit('synced', String(m.c ?? ''), l);
        return;
      case 'sdeny':
        this.emit('denied', String(m.c ?? ''), l, String(m.why ?? ''));
        return;
      case 'op': {
        if (m.op && typeof m.op === 'object' && !this.convos.get(String((m.op as Op).c))) await this.prepare([m.op], l);
        const acc = await this.convos.ingest([m.op], l.addr);
        if (!acc.length) return;
        this.emit('accepted', acc, l);
        // only relay ops that are valid for us: invalid ones are stored (for sync bookkeeping) but go no further
        for (const op of acc) if (this.convos.isValid(op)) this.gossip(op, l.addr);
        return;
      }
      case 'eph': {
        const e = m.e as Eph;
        if (!e || typeof e !== 'object' || typeof e.id !== 'string' || this.seenEph.has(e.id)) return;
        if (Math.abs(Date.now() - Number(e.ts)) > 90_000) return;
        if (!verifyObject(e.a, e as unknown as { sig?: unknown })) return;
        this.seenEph.set(e.id, Date.now());
        if (!this.shares(e.c, e.a) && e.a !== l.pub) return;
        this.emit('eph', e, l);
        const hops = Number(m.hops ?? 0);
        if (hops < 2) this.forwardEph(e, hops + 1, l.addr);
        return;
      }
      case 'prof': {
        const card = verifyProfile(m.card);
        if (card) this.emit('profile', card, l);
        return;
      }
      case 'preq': {
        if (!Array.isArray(m.pubs)) return;
        const cards = (m.pubs as unknown[])
          .slice(0, 100)
          .map((p) => (typeof p === 'string' ? (p === this.me ? this.myCard() : this.profileOf(p)) : null))
          .filter(Boolean);
        if (cards.length) l.send({ t: 'profs', cards });
        return;
      }
      case 'profs': {
        if (!Array.isArray(m.cards)) return;
        for (const raw of m.cards.slice(0, 100)) {
          const card = verifyProfile(raw);
          if (card) this.emit('profile', card, l);
        }
        return;
      }
      case 'rcpt':
        if (typeof m.c === 'string' && typeof m.l === 'number') this.emit('receipt', m.c, l.pub, m.l);
        return;
      case 'fshare':
        if (Array.isArray(m.list)) this.emit('friends', l.pub, (m.list as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 1000));
        return;
    }
  }

  /** Links that should receive live ops for `c`. */
  linksFor(c: string): PeerConn[] {
    return [...this.peers.links.values()].filter((l) => l.usable && l.helloReceived && this.shares(c, l.pub, l));
  }

  gossip(op: StoredOp | Op, except?: string) {
    const wire = cleanOp(op as Op);
    const targets = new Set(this.linksFor(op.c));
    // People being removed are no longer members, but they must still learn that they were removed.
    if (op.k === 'kick' || op.k === 'ban' || op.k === 'gremove') {
      const t = (op.p as { target?: string } | undefined)?.target;
      if (t) for (const l of this.peers.byPub(t)) targets.add(l);
    }
    let n = 0;
    for (const l of targets) {
      if (l.addr === except) continue;
      if (l.send({ t: 'op', op: wire })) n++;
    }
    return n;
  }

  ephemeral(c: string, k: string, d: Record<string, unknown>) {
    const e = signObject(this.keys, { id: randomHex(8), c, a: this.me, k, d, ts: Date.now() }) as Eph;
    this.seenEph.set(e.id, Date.now());
    this.forwardEph(e, 0);
  }

  private forwardEph(e: Eph, hops: number, except?: string) {
    for (const l of this.linksFor(e.c)) if (l.addr !== except && l.pub !== e.a) l.send({ t: 'eph', e, hops });
  }

  broadcastProfile(card: ProfileCard) {
    for (const l of this.peers.links.values()) if (l.usable) l.send({ t: 'prof', card });
  }

  requestProfiles(pubs: string[]) {
    if (!pubs.length) return;
    for (const l of this.peers.links.values()) if (l.usable && l.helloReceived) l.send({ t: 'preq', pubs });
  }

  receipt(c: string, peer: string, l: number) {
    for (const link of this.peers.byPub(peer)) link.send({ t: 'rcpt', c, l });
  }
}

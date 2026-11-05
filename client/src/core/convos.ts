/**
 * Local persistence + validation for every conversation (communities, group
 * DMs, DMs). Ops are verified, de-duplicated, checked for equivocation and
 * stored; governance ops feed the Engine; messages are materialized on demand.
 */
import { Emitter } from './emitter';
import type { AccountDb, ConvoRecord, ConvoType, StoredOp } from './db';
import { verifyOpFast, cleanOp } from './verify';
import { Engine, type CommunityState, type Message, type RecomputeResult } from '@shared/engine';
import { createOp, groupOrCommunityId, dmId, targetOf, COMMUNITY_GOV, GROUP_GOV, MESSAGE_KINDS, cmpOps, type Op } from '@shared/ops';
import { randomHex } from '@shared/bytes';
import type { Keys } from '@shared/crypto';

export interface Convo {
  rec: ConvoRecord;
  eng: Engine;
  /** keys that were ever members (cheap spam filter before full validation) */
  authors: Set<string>;
  wasMember: boolean;
}

type Events = {
  changed: [string];
  ops: [string, StoredOp[]];
  retro: [string, RecomputeResult];
  removed: [string];
};

const MAXK = '￿';

export class Convos extends Emitter<Events> {
  map = new Map<string, Convo>();
  constructor(
    private db: AccountDb,
    private keys: Keys,
    private dv: string,
  ) {
    super();
  }

  get me() {
    return this.keys.pub;
  }

  async load() {
    const recs = await this.db.getAll('convos');
    for (const rec of recs) {
      try {
        await this.open(rec);
      } catch (e) {
        console.error('[convos] failed to open', rec.c, e);
      }
    }
  }

  private async open(rec: ConvoRecord): Promise<Convo> {
    const eng = rec.type === 'dm' ? new Engine('dm', rec.c, [this.me, rec.peer!]) : new Engine(rec.type, rec.c);
    const convo: Convo = { rec, eng, authors: new Set(), wasMember: false };
    if (rec.type === 'dm') {
      convo.authors.add(this.me);
      convo.authors.add(rec.peer!);
    }
    const gov = await this.db.getAllFromIndex('ops', 'cg', [rec.c, 1]);
    for (const op of gov) {
      if (op.eq) eng.markEquivocated(op.id);
      eng.addGov(op);
      eng.noteKey(op);
      this.noteAuthors(convo, op);
    }
    const last = await this.db.transaction('ops').store.index('cl').openCursor(IDBKeyRange.bound([rec.c, 0], [rec.c, Infinity]), 'prev');
    if (last) eng.noteKey(last.value);
    eng.recompute();
    const seqCur = await this.db
      .transaction('ops')
      .store.index('chain')
      .openKeyCursor(IDBKeyRange.bound([rec.c, this.me, this.dv, 0], [rec.c, this.me, this.dv, Infinity]), 'prev');
    if (seqCur) rec.seq = Math.max(rec.seq, (seqCur.key as unknown as [string, string, string, number])[3]);
    convo.wasMember = !!eng.state?.members[this.me];
    this.map.set(rec.c, convo);
    return convo;
  }

  get(c: string) {
    return this.map.get(c);
  }
  list() {
    return [...this.map.values()];
  }
  communities() {
    return this.list()
      .filter((x) => x.rec.type === 'community')
      .sort((a, b) => a.rec.order - b.rec.order || a.rec.addedAt - b.rec.addedAt);
  }
  community(c: string): CommunityState | null {
    const s = this.map.get(c)?.eng.state;
    return s && s.kind === 'community' ? s : null;
  }

  async saveRec(rec: ConvoRecord) {
    await this.db.put('convos', rec);
  }

  async ensure(c: string, type: ConvoType, extra: Partial<ConvoRecord> = {}): Promise<Convo> {
    const have = this.map.get(c);
    if (have) {
      let dirty = false;
      if (extra.joinCode && !have.rec.joinCode && !have.eng.state?.members[this.me]) {
        have.rec.joinCode = extra.joinCode;
        dirty = true;
      }
      if (have.rec.left && extra.joinCode) {
        have.rec.left = false;
        dirty = true;
      }
      if (have.rec.hidden && extra.hidden === false) {
        have.rec.hidden = false;
        dirty = true;
      }
      if (dirty) await this.saveRec(have.rec);
      return have;
    }
    const maxOrder = Math.max(0, ...this.list().map((x) => x.rec.order));
    const rec: ConvoRecord = {
      c,
      type,
      addedAt: Date.now(),
      seq: 0,
      lastActivity: Date.now(),
      notify: 'default',
      muted: false,
      chans: {},
      read: {},
      order: maxOrder + 1,
      ...extra,
    };
    await this.saveRec(rec);
    const convo = await this.open(rec);
    this.emit('changed', c);
    return convo;
  }

  async remove(c: string) {
    const convo = this.map.get(c);
    if (!convo) return;
    this.map.delete(c);
    await this.db.delete('convos', c);
    const keys = await this.db.getAllKeysFromIndex('ops', 'c', c);
    const tx = this.db.transaction('ops', 'readwrite');
    for (const k of keys) void tx.store.delete(k);
    await tx.done;
    this.emit('removed', c);
  }

  ensureDm(peer: string) {
    return this.ensure(dmId(this.me, peer), 'dm', { peer });
  }

  private noteAuthors(convo: Convo, op: Op) {
    switch (op.k) {
      case 'genesis':
      case 'join':
      case 'gadd':
        convo.authors.add(op.a);
        if (op.k === 'gadd') {
          const t = (op.p as { target?: string } | undefined)?.target;
          if (t) convo.authors.add(t);
        }
        break;
      case 'gcreate': {
        convo.authors.add(op.a);
        const ms = (op.p as { members?: string[] } | undefined)?.members;
        if (Array.isArray(ms)) for (const m of ms) if (typeof m === 'string') convo.authors.add(m);
        break;
      }
    }
  }

  /** Cheap pre-filter: drop ops that can never be valid before storing them. */
  private plausible(convo: Convo, op: Op): boolean {
    const { type } = convo.rec;
    if (type === 'dm') return MESSAGE_KINDS.has(op.k) && convo.authors.has(op.a);
    if (type === 'group') {
      if (!GROUP_GOV.has(op.k) && !MESSAGE_KINDS.has(op.k)) return false;
      return op.k === 'gcreate' || convo.authors.has(op.a);
    }
    if (!COMMUNITY_GOV.has(op.k) && !MESSAGE_KINDS.has(op.k)) return false;
    if (op.k === 'genesis') return true;
    if (op.k === 'join') {
      const st = convo.eng.state as CommunityState | null;
      if (!st) return true;
      if (st.bans[op.a]) return false;
      const code = (op.p as { code?: string } | undefined)?.code;
      return st.joinPolicy === 'open' || (!!code && !!st.invites[code]);
    }
    return convo.authors.has(op.a);
  }

  /** Verify + store ops from the network. Returns the newly accepted ones. */
  async ingest(raws: unknown[], from: string): Promise<StoredOp[]> {
    const checked = await Promise.all(raws.map(async (r) => ((await verifyOpFast(r)) ? cleanOp(r as Op) : null)));
    const byC = new Map<string, Op[]>();
    for (const op of checked) {
      if (!op) continue;
      let arr = byC.get(op.c);
      if (!arr) byC.set(op.c, (arr = []));
      arr.push(op);
    }
    const out: StoredOp[] = [];
    for (const [c, ops] of byC) {
      const convo = this.map.get(c);
      if (!convo) continue;
      out.push(...(await this.store(convo, ops.sort(cmpOps), from)));
    }
    return out;
  }

  private async store(convo: Convo, ops: Op[], from: string): Promise<StoredOp[]> {
    const { eng } = convo;
    const fresh: StoredOp[] = [];
    const tx = this.db.transaction('ops', 'readwrite');
    const chain = tx.store.index('chain');
    for (const op of ops) {
      if (op.c !== convo.rec.c) continue;
      if (await tx.store.getKey(op.id)) continue;
      if (!this.plausible(convo, op)) continue;
      const p = op.p as { ch?: unknown } | undefined;
      const stored: StoredOp = {
        ...op,
        rcv: from === 'local' ? op.t : Date.now(),
        g: eng.isGov(op.k) ? 1 : 0,
        ch: op.k === 'msg' && p && typeof p.ch === 'string' ? p.ch : '',
        tgt: targetOf(op) ?? '',
      };
      const other = await chain.get([op.c, op.a, op.dv, op.s]);
      if (other && other.id !== op.id) {
        stored.eq = 1;
        if (!other.eq) {
          other.eq = 1;
          await tx.store.put(other);
        }
        eng.markEquivocated(other.id);
        eng.markEquivocated(op.id);
      }
      await tx.store.put(stored);
      fresh.push(stored);
      this.noteAuthors(convo, stored);
    }
    await tx.done;
    if (!fresh.length) return fresh;

    let gov = false;
    for (const s of fresh) {
      eng.noteKey(s);
      if (s.g && eng.addGov(s)) gov = true;
    }
    if (gov) {
      const r = eng.recompute();
      if (r.retroFrom || r.authors.length) this.emit('retro', convo.rec.c, r);
      const member = !!eng.state?.members[this.me];
      if (convo.wasMember && !member && !convo.rec.left) {
        convo.rec.left = true;
        await this.saveRec(convo.rec);
      }
      if (member && (convo.rec.left || convo.rec.joinCode)) {
        convo.rec.left = false;
        delete convo.rec.joinCode;
        await this.saveRec(convo.rec);
      }
      convo.wasMember = member;
      this.emit('changed', convo.rec.c);
    }
    const lastMsg = fresh.filter((f) => f.k === 'msg').reduce((m, f) => Math.max(m, f.t), 0);
    if (lastMsg > convo.rec.lastActivity) {
      convo.rec.lastActivity = Math.min(lastMsg, Date.now());
      if (convo.rec.hidden && convo.rec.type !== 'community') convo.rec.hidden = false;
      void this.saveRec(convo.rec);
    }
    this.emit('ops', convo.rec.c, fresh);
    return fresh;
  }

  /** Create, sign and store a local op. */
  async author(c: string, k: string, p: unknown): Promise<StoredOp> {
    const convo = this.map.get(c);
    if (!convo) throw new Error('Unknown conversation');
    const s = ++convo.rec.seq;
    const l = convo.eng.maxLamport + 1;
    convo.eng.noteKey({ l, id: '' } as Op);
    const op = createOp(this.keys, this.dv, { c, s, l, k, p });
    await this.saveRec(convo.rec);
    const stored = await this.store(convo, [op], 'local');
    if (!stored.length) throw new Error('Could not store op');
    return stored[0];
  }

  async createCommunity(name: string, icon?: unknown) {
    const nonce = randomHex(16);
    const c = groupOrCommunityId(this.me, nonce);
    const ids = { cat1: randomHex(8), gen: randomHex(8), cat2: randomHex(8), lounge: randomHex(8) };
    await this.ensure(c, 'community');
    await this.author(c, 'genesis', {
      name,
      nonce,
      icon,
      channels: [
        { id: ids.cat1, type: 'category', name: 'Text channels', pos: 0 },
        { id: ids.gen, type: 'text', name: 'general', parent: ids.cat1, pos: 0, topic: 'Say hi!' },
        { id: ids.cat2, type: 'category', name: 'Voice channels', pos: 1 },
        { id: ids.lounge, type: 'voice', name: 'Lounge', parent: ids.cat2, pos: 0 },
      ],
    });
    return c;
  }

  async createGroup(members: string[], name?: string) {
    const nonce = randomHex(16);
    const c = groupOrCommunityId(this.me, nonce);
    await this.ensure(c, 'group');
    const op = await this.author(c, 'gcreate', { nonce, members, name: name || undefined });
    return { c, op };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  isValid(op: StoredOp): boolean {
    const convo = this.map.get(op.c);
    if (!convo || op.eq) return false;
    if (op.g) return convo.eng.status.get(op.id) === 'ok';
    return convo.eng.checkMessageOp(op).ok;
  }

  async getOp(id: string) {
    return this.db.get('ops', id);
  }

  async materialize(convo: Convo, op: StoredOp): Promise<Message | null> {
    if (op.eq) return null;
    const related = (await this.db.getAllFromIndex('ops', 'tgt', op.id)).filter((r) => !r.eq && r.c === op.c);
    const m = convo.eng.materialize(op, related);
    if (m && m.deleted && op.p !== undefined) {
      // Deleted content is dropped from disk; the signed header stays for sync.
      const { p: _p, ...redacted } = op;
      void this.db.put('ops', redacted as StoredOp);
    }
    return m;
  }

  async getMessage(c: string, id: string): Promise<Message | null> {
    const convo = this.map.get(c);
    const op = await this.db.get('ops', id);
    if (!convo || !op || op.k !== 'msg' || op.c !== c) return null;
    return this.materialize(convo, op);
  }

  async loadChannel(c: string, ch: string, beforeL = Infinity, limit = 50): Promise<{ messages: Message[]; hasMore: boolean }> {
    const convo = this.map.get(c);
    if (!convo) return { messages: [], hasMore: false };
    const ops: StoredOp[] = [];
    let cur = await this.db
      .transaction('ops')
      .store.index('cch')
      .openCursor(IDBKeyRange.bound([c, ch, 0], [c, ch, beforeL], false, beforeL !== Infinity), 'prev');
    while (cur && ops.length < limit + 1) {
      if (!cur.value.eq) ops.push(cur.value);
      cur = await cur.continue();
    }
    const hasMore = ops.length > limit;
    const page = ops.slice(0, limit);
    const out: Message[] = [];
    for (const op of page) {
      const m = await this.materialize(convo, op);
      if (m && !m.deleted) out.push(m);
    }
    out.sort((a, b) => a.l - b.l || (a.id < b.id ? -1 : 1));
    return { messages: out, hasMore };
  }

  /** Latest message (any author) in a channel, for unread and DM previews. */
  async lastInChannel(c: string, ch: string): Promise<StoredOp | null> {
    const cur = await this.db
      .transaction('ops')
      .store.index('cch')
      .openCursor(IDBKeyRange.bound([c, ch, 0], [c, ch, Infinity]), 'prev');
    return cur?.value ?? null;
  }

  /** Messages after a read marker (capped), newest first. */
  async after(c: string, ch: string, l: number, cap = 200): Promise<StoredOp[]> {
    const out: StoredOp[] = [];
    let cur = await this.db
      .transaction('ops')
      .store.index('cch')
      .openCursor(IDBKeyRange.bound([c, ch, l], [c, ch, Infinity], true, false), 'prev');
    while (cur && out.length < cap) {
      if (!cur.value.eq) out.push(cur.value);
      cur = await cur.continue();
    }
    return out;
  }

  async pinned(c: string, ch: string): Promise<Message[]> {
    const convo = this.map.get(c);
    if (!convo) return [];
    const pins = (await this.db.getAllFromIndex('ops', 'c', c)).filter((o) => o.k === 'pin');
    const ids = [...new Set(pins.map((p) => p.tgt))];
    const out: Message[] = [];
    for (const id of ids) {
      const m = await this.getMessage(c, id);
      if (m && m.pinned && m.ch === ch && !m.deleted) out.push(m);
    }
    return out.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  }

  async search(
    scope: string[],
    q: { text: string; from?: string; ch?: string; has?: 'image' | 'file' | 'link' | 'video'; mentions?: string },
    cap = 60,
  ): Promise<Message[]> {
    const needle = q.text.trim().toLowerCase();
    const hits: StoredOp[] = [];
    for (const c of scope) {
      const lo = q.ch ? [c, q.ch, 0] : [c, '', 0];
      const hi = q.ch ? [c, q.ch, Infinity] : [c, MAXK, Infinity];
      let cur = await this.db.transaction('ops').store.index('cch').openCursor(IDBKeyRange.bound(lo, hi));
      while (cur) {
        const op = cur.value;
        const p = op.p as { text?: string; att?: { mime: string }[] } | undefined;
        if (op.k === 'msg' && p && !op.eq) {
          let ok = true;
          if (needle && !(p.text ?? '').toLowerCase().includes(needle)) ok = false;
          if (ok && q.from && op.a !== q.from) ok = false;
          if (ok && q.mentions && !(p.text ?? '').includes(`<@${q.mentions}>`)) ok = false;
          if (ok && q.has) {
            const att = p.att ?? [];
            if (q.has === 'image') ok = att.some((a) => a.mime.startsWith('image/'));
            else if (q.has === 'video') ok = att.some((a) => a.mime.startsWith('video/'));
            else if (q.has === 'file') ok = att.length > 0;
            else if (q.has === 'link') ok = /https?:\/\//.test(p.text ?? '');
          }
          if (ok) hits.push(op);
        }
        cur = await cur.continue();
      }
    }
    hits.sort((a, b) => b.l - a.l);
    const out: Message[] = [];
    for (const op of hits) {
      if (out.length >= cap) break;
      const convo = this.map.get(op.c);
      if (!convo) continue;
      const m = await this.materialize(convo, op);
      if (m && !m.deleted && (!needle || m.text.toLowerCase().includes(needle) || q.has)) out.push(m);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Sync helpers
  // ---------------------------------------------------------------------------

  /** Version vector: highest contiguous seq per author device. */
  async vv(c: string): Promise<Record<string, number>> {
    const vv: Record<string, number> = {};
    let cur = await this.db
      .transaction('ops')
      .store.index('chain')
      .openKeyCursor(IDBKeyRange.bound([c, '', '', 0], [c, MAXK, MAXK, Infinity]));
    let chain = '';
    let expect = 1;
    while (cur) {
      const [, a, dv, s] = cur.key as unknown as [string, string, string, number];
      const k = `${a}:${dv}`;
      if (k !== chain) {
        chain = k;
        expect = 1;
      }
      if (s === expect) {
        vv[k] = s;
        expect++;
      } else if (s > expect) expect = Number.POSITIVE_INFINITY;
      cur = await cur.continue();
    }
    return vv;
  }

  /** Ops the other side is missing: governance first (oldest first), then messages newest first. */
  async missingFor(c: string, vv: Record<string, number>, govOnly = false): Promise<Op[]> {
    const all = await this.db.getAllFromIndex('ops', 'c', c);
    const need = all.filter((o) => o.s > (vv[`${o.a}:${o.dv}`] ?? 0) && (!govOnly || o.g));
    const gov = need.filter((o) => o.g).sort((a, b) => a.l - b.l);
    const rest = need.filter((o) => !o.g).sort((a, b) => b.l - a.l);
    return [...gov, ...rest].map(cleanOp);
  }

  /** Cutoff vector for revocations: highest seq we have seen per device of each key. */
  async cutoffFor(c: string, pubs: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const pub of pubs) {
      let cur = await this.db
        .transaction('ops')
        .store.index('chain')
        .openKeyCursor(IDBKeyRange.bound([c, pub, '', 0], [c, pub, MAXK, Infinity]));
      while (cur) {
        const [, a, dv, s] = cur.key as unknown as [string, string, string, number];
        const k = `${a}:${dv}`;
        if ((out[k] ?? 0) < s) out[k] = s;
        cur = await cur.continue();
      }
    }
    return out;
  }

  /** Members of a role (for role revocation cutoffs). */
  roleMembers(c: string, roleId: string): string[] {
    const st = this.community(c);
    if (!st) return [];
    return Object.values(st.members)
      .filter((m) => roleId === st.id || m.roles.includes(roleId))
      .map((m) => m.pub);
  }

  async setRead(c: string, ch: string, l: number) {
    const convo = this.map.get(c);
    if (!convo) return;
    if ((convo.rec.read[ch] ?? 0) >= l) return;
    convo.rec.read[ch] = l;
    await this.saveRec(convo.rec);
  }
}

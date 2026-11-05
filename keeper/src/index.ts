/**
 * CelChat archive peer ("keeper"): an always-on member that keeps communities available while
 * their human members are offline. It joins only when invited (by an owner you configure),
 * validates every op with the same engine as browsers, stores history and attachments, and
 * serves them to members (and to invite holders who are joining). It talks to browsers over the
 * hub's end-to-end encrypted relay, so it needs no WebRTC stack and no open ports.
 *
 *   npm run keeper            (see docs/SELF_HOSTING.md for configuration)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cfg } from './config';
import { Store, parseOp, type ConvoRow } from './store';
import { Pacer, RelayLink, type LinkHost } from './link';
import { HubClient } from '../../client/src/core/hub';
import { verifyOpFast, cleanOp } from '../../client/src/core/verify';
import { Engine, type CommunityState } from '@shared/engine';
import { createOp, targetOf, cmpOps, COMMUNITY_GOV, MESSAGE_KINDS, parsePayload, type Op } from '@shared/ops';
import { keysFromSeed, newSeed, sha256Hex, signObject, verifyObject, unsealSigned, type Keys } from '@shared/crypto';
import { bytesToHex, hexToBytes, fromB64, randomHex, isHex } from '@shared/bytes';
import { signProfile, verifyProfile, type ProfileCard } from '@shared/profile';
import { LIMITS } from '@shared/limits';

const CHUNK = LIMITS.chunkBytes;
const log = (...a: unknown[]) => console.log(`[keeper ${new Date().toISOString().slice(11, 19)}]`, ...a);

interface KConvo {
  row: ConvoRow;
  eng: Engine;
  authors: Set<string>;
  wasMember: boolean;
}

interface Download {
  hash: string;
  c: string;
  size: number;
  mime: string;
  chunks: (Uint8Array | undefined)[];
  count: number;
  link: RelayLink;
  lastData: number;
  tried: Set<string>;
}

class Keeper implements LinkHost {
  keys!: Keys;
  dv!: string;
  store = new Store(cfg.dataDir);
  hub!: HubClient;
  pacer!: Pacer;
  card!: ProfileCard;
  convos = new Map<string, KConvo>();
  links = new Map<string, RelayLink>();
  topicToC = new Map<string, string>();
  topicPeers = new Map<string, Set<string>>();
  owners = new Set<string>();
  private seenEph = new Map<string, number>();
  private lastSync = new Map<string, number>();
  private relayOnlySent = new Map<string, string>();
  private downloads = new Map<string, Download>();
  private uploads = new Map<string, { cancel: boolean }>();
  private joining = new Set<string>();
  private startedJoins = false;

  addr = () => this.hub.addr;

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  async start() {
    const idFile = path.join(cfg.dataDir, 'identity.json');
    let id: { seed: string; dv: string; createdAt: number };
    if (fs.existsSync(idFile)) id = JSON.parse(fs.readFileSync(idFile, 'utf8'));
    else {
      id = { seed: bytesToHex(newSeed()), dv: randomHex(8), createdAt: Date.now() };
      fs.writeFileSync(idFile, JSON.stringify(id), { mode: 0o600 });
      log('created a new identity in', idFile, '(keep this file private: it IS the archive peer)');
    }
    this.keys = keysFromSeed(hexToBytes(id.seed));
    this.dv = id.dv;

    const stored = this.store.kv('card');
    const old = stored ? verifyProfile(JSON.parse(stored)) : null;
    if (old && old.username === cfg.username && old.displayName === cfg.displayName && old.about === cfg.about && old.bot && old.status?.text === 'Keeping history available') this.card = old;
    else {
      this.card = signProfile(this.keys, {
        username: cfg.username,
        displayName: cfg.displayName,
        about: cfg.about,
        pronouns: '',
        avatar: null,
        banner: null,
        colors: { primary: '#26323f', accent: '#5fd3b3' },
        font: 'default',
        nameStyle: 'plain',
        status: { emoji: '🗄️', text: 'Keeping history available', until: null },
        createdAt: id.createdAt,
        bot: true,
      });
      this.store.setKv('card', JSON.stringify(this.card));
    }

    for (const row of this.store.convos()) if (!row.left) this.open(row);

    this.hub = new HubClient(cfg.hubUrl, this.keys, this.dv, 'online');
    this.pacer = new Pacer(this.hub);
    this.hub.on('state', (s) => log('hub', s));
    this.hub.on('ready', () => void this.onReady());
    this.hub.on('topic', (tid, peers) => {
      const set = new Set(peers.map((p) => `${p.pub}:${p.dv}`));
      this.topicPeers.set(tid, set);
      for (const a of set) this.onTopicPeer(tid, a);
    });
    this.hub.on('tj', (tid, p) => {
      const a = `${p.pub}:${p.dv}`;
      let set = this.topicPeers.get(tid);
      if (!set) this.topicPeers.set(tid, (set = new Set()));
      set.add(a);
      this.onTopicPeer(tid, a);
    });
    this.hub.on('tl', (tid, pub, dv) => {
      const a = `${pub}:${dv}`;
      this.topicPeers.get(tid)?.delete(a);
      for (const s of this.topicPeers.values()) if (s.has(a)) return;
      this.dropLink(a);
    });
    this.hub.on('relay', (from, d) => this.linkFor(from)?.receive(d));
    this.hub.on('sig', (from, d) => this.onSignal(from, d));
    this.hub.on('mail', (items) => void this.onMail(items));
    this.hub.on('err', (e) => {
      if (e.code === 'offline' && e.ref && e.ref.length === 81) this.dropLink(e.ref);
      else if (e.code === 'rate') log('hub rate limit hit; add this key to RELAY_TRUSTED_KEYS on your hub for a bigger budget');
    });
    this.hub.on('replaced', () => {
      log('another process connected with this identity; exiting');
      process.exit(1);
    });
    this.hub.connect();

    setInterval(() => this.sweep(), 20_000).unref();
    setInterval(() => void this.pumpFiles(), 2_000).unref();
    if (cfg.statusPort) this.statusServer();

    log(`archive peer @${cfg.username} (${this.keys.pub})`);
    log(`hub ${cfg.hubUrl}, data ${cfg.dataDir}, ${this.convos.size} communities`);
    if (!cfg.open && !cfg.owners.length) log('nobody can add this archive peer yet: set KEEPER_OWNERS to your CelChat ID (or KEEPER_OPEN=1)');
  }

  private async onReady() {
    this.pacer.rate = Math.floor(this.hub.relayRate * 0.85);
    try {
      await this.hub.dirPut(this.card);
    } catch (e) {
      log(`could not register @${cfg.username} in the directory: ${(e as Error).message}. Set KEEPER_USERNAME to something else.`);
    }
    // owners may be given as @usernames
    this.owners.clear();
    for (const o of cfg.owners) {
      const q = o.replace(/^@/, '').toLowerCase();
      if (isHex(q, 64)) this.owners.add(q);
      else {
        try {
          const card = verifyProfile(await this.hub.dirGet(q));
          if (card) this.owners.add(card.pub);
          else log(`owner @${q} not found in the directory`);
        } catch {
          /* hub hiccup */
        }
      }
    }
    for (const c of this.convos.keys()) this.subscribe(c);
    this.hub.fetchMail();
    if (!this.startedJoins) {
      this.startedJoins = true;
      for (const link of cfg.joins) this.join(link, 'config');
    }
  }

  private topicOf(c: string) {
    return sha256Hex('cc:' + c);
  }

  private subscribe(c: string) {
    const t = this.topicOf(c);
    this.topicToC.set(t, c);
    this.hub.sub([t]);
  }

  // ---------------------------------------------------------------------------
  // Communities
  // ---------------------------------------------------------------------------

  private open(row: ConvoRow): KConvo {
    const eng = new Engine('community', row.c);
    const convo: KConvo = { row, eng, authors: new Set(), wasMember: false };
    for (const r of this.store.govOps(row.c)) {
      const op = parseOp(r);
      if (r.eq) eng.markEquivocated(r.id);
      eng.addGov(op);
      eng.noteKey(op);
      this.noteAuthors(convo, op);
    }
    eng.noteKey({ l: this.store.maxLamport(row.c), id: '' } as Op);
    eng.recompute();
    row.seq = Math.max(row.seq, this.store.mySeq(row.c, this.keys.pub, this.dv));
    convo.wasMember = !!eng.state?.members[this.keys.pub];
    this.convos.set(row.c, convo);
    return convo;
  }

  private state(c: string): CommunityState | null {
    const s = this.convos.get(c)?.eng.state;
    return s && s.kind === 'community' ? s : null;
  }

  join(link: string, by: string) {
    const m = /([0-9a-f]{64})[/.:]([A-Za-z0-9]{6,16})/.exec(link);
    if (!m) return log('ignoring malformed invite', link.slice(0, 80));
    const [, c, code] = m;
    const have = this.convos.get(c);
    if (have && this.state(c)?.members[this.keys.pub]) return;
    if (!have && [...this.convos.values()].filter((x) => !x.row.left).length >= cfg.maxCommunities) return log('community limit reached, ignoring join for', c.slice(0, 12));
    const row: ConvoRow = have?.row ?? { c, join_code: code, seq: 0, left: 0, added_by: by, added_at: Date.now() };
    row.join_code = code;
    row.left = 0;
    this.store.putConvo(row);
    if (!have) this.open(row);
    log(`joining ${c.slice(0, 12)}... (asked by ${by.slice(0, 12)})`);
    if (this.hub.state === 'online') this.subscribe(c);
    this.maybeJoin(c);
  }

  private maybeJoin(c: string) {
    const x = this.convos.get(c);
    const st = this.state(c);
    if (!x || !st || !x.row.join_code || this.joining.has(c)) return;
    if (st.members[this.keys.pub]) return;
    if (st.bans[this.keys.pub]) {
      log(`banned from ${st.name}, giving up`);
      x.row.join_code = null;
      this.store.putConvo(x.row);
      return;
    }
    this.joining.add(c);
    void this.author(c, 'join', { code: x.row.join_code }).finally(() => setTimeout(() => this.joining.delete(c), 5000));
  }

  private async author(c: string, k: string, p: unknown) {
    const x = this.convos.get(c)!;
    x.row.seq++;
    this.store.putConvo(x.row);
    const l = x.eng.maxLamport + 1;
    x.eng.noteKey({ l, id: '' } as Op);
    const op = createOp(this.keys, this.dv, { c, s: x.row.seq, l, k, p });
    const fresh = await this.ingest([op], null);
    for (const f of fresh) this.gossip(f, null);
  }

  private noteAuthors(x: KConvo, op: Op) {
    if (op.k === 'genesis' || op.k === 'join') x.authors.add(op.a);
  }

  private plausible(x: KConvo, op: Op) {
    if (!COMMUNITY_GOV.has(op.k) && !MESSAGE_KINDS.has(op.k)) return false;
    if (op.k === 'genesis') return true;
    if (op.k === 'join') {
      const st = x.eng.state as CommunityState | null;
      if (!st) return true;
      if (st.bans[op.a]) return false;
      const code = (op.p as { code?: string } | undefined)?.code;
      return st.joinPolicy === 'open' || (!!code && !!st.invites[code]);
    }
    return x.authors.has(op.a);
  }

  isValid(op: Op) {
    const x = this.convos.get(op.c);
    if (!x) return false;
    if (x.eng.isGov(op.k)) return x.eng.status.get(op.id) === 'ok';
    return x.eng.checkMessageOp(op).ok;
  }

  /** Verify, store and apply ops. Returns the ones we had not seen before. */
  async ingest(raws: unknown[], from: RelayLink | null): Promise<Op[]> {
    const ok = await Promise.all(raws.map(async (r) => ((await verifyOpFast(r)) ? cleanOp(r as Op) : null)));
    const fresh: Op[] = [];
    const byC = new Map<string, Op[]>();
    for (const op of ok) if (op && this.convos.has(op.c)) (byC.get(op.c) ?? byC.set(op.c, []).get(op.c)!).push(op);
    for (const [c, ops] of byC) {
      const x = this.convos.get(c)!;
      const now = Date.now();
      const added: Op[] = [];
      this.store.tx(() => {
        for (const op of ops.sort(cmpOps)) {
          if (this.store.hasOp(op.id) || !this.plausible(x, op)) continue;
          const rcv = from ? now : op.t;
          let eq = 0;
          const other = this.store.chainOther(op.c, op.a, op.dv, op.s);
          if (other && other.id !== op.id) {
            eq = 1;
            this.store.markEq(other.id);
            x.eng.markEquivocated(other.id);
            x.eng.markEquivocated(op.id);
          }
          this.store.putOp({ id: op.id, c, a: op.a, dv: op.dv, s: op.s, l: op.l, t: op.t, k: op.k, g: x.eng.isGov(op.k) ? 1 : 0, tgt: targetOf(op) ?? '', json: JSON.stringify(op), rcv, eq });
          this.noteAuthors(x, op);
          added.push({ ...op, rcv });
        }
      });
      if (!added.length) continue;
      let gov = false;
      for (const op of added) {
        x.eng.noteKey(op);
        if (x.eng.isGov(op.k) && x.eng.addGov(op)) gov = true;
      }
      if (gov) {
        x.eng.recompute();
        this.afterGovChange(x);
      }
      for (const op of added) this.afterOp(x, op);
      fresh.push(...added);
    }
    return fresh;
  }

  private afterGovChange(x: KConvo) {
    const st = x.eng.state as CommunityState | null;
    const member = !!st?.members[this.keys.pub];
    if (!member && x.row.join_code) setTimeout(() => this.maybeJoin(x.row.c), 0);
    if (member && x.row.join_code) {
      x.row.join_code = null;
      this.store.putConvo(x.row);
      log(`joined "${st!.name}" (${Object.keys(st!.members).length} members)`);
      this.wantCommunityAssets(x.row.c);
    }
    if (x.wasMember && !member) {
      // kicked or banned: respect it, forget the community and its data
      log(`removed from "${st?.name}". Deleting its data.`);
      x.row.left = 1;
      this.store.putConvo(x.row);
      this.store.deleteConvoOps(x.row.c);
      this.convos.delete(x.row.c);
      const t = this.topicOf(x.row.c);
      this.hub.unsub([t]);
      this.topicToC.delete(t);
      return;
    }
    x.wasMember = member;
    if (st) {
      // ban purges: physically drop the purged content
      for (const [pub, ban] of Object.entries(st.bans)) {
        if (ban.purgeFrom === null) continue;
        for (const r of this.store.authorMsgsSince(x.row.c, pub, ban.purgeFrom)) this.store.redact(r.id);
      }
    }
  }

  private afterOp(x: KConvo, op: Op) {
    if (op.k === 'del' && this.isValid(op)) this.checkDeleted(x, targetOf(op)!);
    if (op.k === 'msg') {
      if (this.store.byTarget(op.id, op.c).some((r) => r.k === 'del')) this.checkDeleted(x, op.id);
      const p = parsePayload('msg', op.p);
      if (p?.att && cfg.files && this.isValid(op)) for (const a of p.att) if (a.size <= cfg.fileMaxBytes) this.store.want(a.hash, op.c, op.a, a.size, a.mime);
    }
    if (op.k === 'comm.update') this.wantCommunityAssets(op.c);
  }

  private checkDeleted(x: KConvo, msgId: string) {
    const row = this.store.getOp(msgId);
    if (!row || row.k !== 'msg') return;
    const m = x.eng.materialize(parseOp(row), this.store.byTarget(msgId, x.row.c));
    if (m?.deleted) this.store.redact(msgId);
  }

  private wantCommunityAssets(c: string) {
    const st = this.state(c);
    if (!st || !cfg.files) return;
    for (const a of [st.icon, st.banner, st.theme?.bgImage]) if (a && a.size <= cfg.fileMaxBytes) this.store.want(a.hash, c, st.owner, a.size, a.mime);
  }

  // ---------------------------------------------------------------------------
  // Links + peer protocol
  // ---------------------------------------------------------------------------

  private linkFor(addr: string): RelayLink | null {
    if (addr.length !== 81 || addr === this.hub.addr) return null;
    let l = this.links.get(addr);
    if (!l) {
      if (this.links.size >= 1000) return null;
      l = new RelayLink(this, addr);
      this.links.set(addr, l);
    }
    return l;
  }

  private dropLink(addr: string) {
    const l = this.links.get(addr);
    if (!l) return;
    l.close();
    this.links.delete(addr);
  }

  private onTopicPeer(topic: string, addr: string) {
    const c = this.topicToC.get(topic);
    const l = this.linkFor(addr);
    if (!c || !l) return;
    l.topics.add(c);
    if (!l.helloSent) this.hello(l);
    else if (l.helloReceived) this.requestSync(c, l);
  }

  private hello(l: RelayLink) {
    l.helloSent = true;
    void l.send({ t: 'hello', v: 1, card: this.card, inv: false });
  }

  private onSignal(from: string, raw: unknown) {
    const d = raw as Record<string, unknown>;
    if (!d || typeof d !== 'object' || d.from !== from || typeof d.ts !== 'number' || Math.abs(Date.now() - d.ts) > 5 * 60_000) return;
    if (d.to !== this.hub.addr && d.to !== this.keys.pub) return;
    if (!verifyObject(from.slice(0, 64), d)) return;
    if (d.k !== 'sdp' && d.k !== 'ice') return;
    // We cannot do WebRTC: tell the browser to use the relay right away instead of timing out.
    const sid = String(d.sid ?? '');
    if (this.relayOnlySent.get(from) !== sid) {
      this.relayOnlySent.set(from, sid);
      this.hub.signal(from, signObject(this.keys, { k: 'relay-only', from: this.hub.addr, to: from, ts: Date.now(), sid: 'keeper' }));
    }
    const l = this.linkFor(from);
    if (l && !l.helloSent) this.hello(l);
  }

  private shares(c: string, pub: string, l?: RelayLink) {
    const st = this.state(c);
    if (!st) return false;
    return !!st.members[pub] || !!l?.topics.has(c);
  }

  private authorized(c: string, pub: string, code?: string): string | null {
    const x = this.convos.get(c);
    const st = this.state(c);
    if (!x || !st) return 'unknown';
    if (!st.members[this.keys.pub]) return 'not a member';
    if (st.members[pub]) return null;
    if (st.bans[pub]) return 'banned';
    if (x.authors.has(pub) && !code) return 'gov';
    if (st.joinPolicy === 'open') return null;
    const inv = code ? st.invites[code] : undefined;
    if (inv && !inv.revoked && (inv.expiresAt === null || Date.now() < inv.expiresAt) && (inv.maxUses === null || inv.uses < inv.maxUses)) return null;
    return 'invite required';
  }

  private requestSync(c: string, l: RelayLink) {
    const key = c + l.addr;
    if (Date.now() - (this.lastSync.get(key) ?? 0) < 10_000) return;
    this.lastSync.set(key, Date.now());
    const x = this.convos.get(c);
    if (!x) return;
    void l.send({ t: 'sreq', c, vv: this.store.vv(c), code: x.row.join_code ?? undefined });
  }

  private syncAll(l: RelayLink) {
    for (const [c, x] of this.convos) {
      if (x.row.left) continue;
      if (this.shares(c, l.pub, l) || (x.row.join_code && l.topics.has(c))) this.requestSync(c, l);
    }
  }

  gossip(op: Op, except: RelayLink | null) {
    const wire = cleanOp(op);
    const target = op.k === 'kick' || op.k === 'ban' ? (op.p as { target?: string } | undefined)?.target : undefined;
    for (const l of this.links.values()) {
      if (l === except || !l.helloReceived) continue;
      if (this.shares(op.c, l.pub, l) || l.pub === target) void l.send({ t: 'op', op: wire });
    }
  }

  onMessage = (l: RelayLink, m: Record<string, unknown>) => this.handle(l, m).catch((e) => log('error handling', m.t, e));

  private async handle(l: RelayLink, m: Record<string, unknown>) {
    switch (m.t) {
      case 'hello': {
        const card = m.card ? verifyProfile(m.card) : null;
        if (card && card.pub !== l.pub) return;
        if (card) this.putProfile(card);
        l.helloReceived = true;
        if (!l.helloSent) this.hello(l);
        this.syncAll(l);
        return;
      }
      case 'sreq': {
        const c = String(m.c ?? '');
        const why = this.authorized(c, l.pub, typeof m.code === 'string' ? m.code : undefined);
        if (why && why !== 'gov') {
          void l.send({ t: 'sdeny', c, why });
          return;
        }
        const vv = m.vv && typeof m.vv === 'object' ? (m.vv as Record<string, number>) : {};
        const need = this.store.allOps(c).filter((r) => r.s > (vv[`${r.a}:${r.dv}`] ?? 0) && (why !== 'gov' || r.g));
        const gov = need.filter((r) => r.g).sort((a, b) => a.l - b.l);
        const rest = need.filter((r) => !r.g).sort((a, b) => b.l - a.l);
        let batch: Op[] = [];
        let size = 0;
        for (const r of [...gov, ...rest]) {
          if (batch.length && (size + r.json.length > 180_000 || batch.length >= 200)) {
            void l.send({ t: 'sops', c, ops: batch });
            batch = [];
            size = 0;
          }
          batch.push(JSON.parse(r.json));
          size += r.json.length;
        }
        if (batch.length) void l.send({ t: 'sops', c, ops: batch });
        void l.send({ t: 'sdone', c, n: need.length });
        if (this.shares(c, l.pub, l)) this.requestSync(c, l);
        return;
      }
      case 'sops':
        if (Array.isArray(m.ops) && m.ops.length <= 400) await this.ingest(m.ops, l);
        return;
      case 'sdone':
        this.maybeJoin(String(m.c ?? ''));
        return;
      case 'sdeny':
        if (m.why === 'invite required' || m.why === 'banned') log(`join refused by a member of ${String(m.c).slice(0, 12)}: ${m.why}`);
        return;
      case 'op': {
        const fresh = await this.ingest([m.op], l);
        for (const op of fresh) if (this.isValid(op)) this.gossip(op, l);
        for (const op of fresh) this.maybeJoin(op.c);
        return;
      }
      case 'eph': {
        const e = m.e as { id?: string; c?: string; a?: string; ts?: number };
        if (!e || typeof e.id !== 'string' || typeof e.c !== 'string' || typeof e.a !== 'string' || this.seenEph.has(e.id)) return;
        if (Math.abs(Date.now() - Number(e.ts)) > 90_000 || !verifyObject(e.a, e as { sig?: unknown })) return;
        this.seenEph.set(e.id, Date.now());
        const hops = Number(m.hops ?? 0);
        if (hops >= 2 || !this.state(e.c)?.members[e.a]) return;
        for (const o of this.links.values()) if (o !== l && o.helloReceived && o.pub !== e.a && this.shares(e.c, o.pub, o)) void o.send({ t: 'eph', e, hops: hops + 1 });
        return;
      }
      case 'prof': {
        const card = verifyProfile(m.card);
        if (card) this.putProfile(card);
        return;
      }
      case 'profs':
        if (Array.isArray(m.cards)) for (const raw of m.cards.slice(0, 100)) {
          const card = verifyProfile(raw);
          if (card) this.putProfile(card);
        }
        return;
      case 'preq': {
        if (!Array.isArray(m.pubs)) return;
        const cards = m.pubs
          .slice(0, 100)
          .map((p) => (p === this.keys.pub ? this.card : typeof p === 'string' ? this.store.profile(p) : null))
          .filter(Boolean);
        if (cards.length) void l.send({ t: 'profs', cards });
        return;
      }
      case 'ping':
        void l.send({ t: 'pong', ts: m.ts });
        return;
      case 'freq':
        void this.serveFile(l, String(m.h ?? ''), Number(m.o ?? 0));
        return;
      case 'fcancel': {
        const u = this.uploads.get(l.addr + String(m.h));
        if (u) u.cancel = true;
        return;
      }
      case 'ferr': {
        const d = this.downloads.get(String(m.h ?? ''));
        if (d && d.link === l) this.abortDownload(d, 15_000);
        return;
      }
    }
  }

  private putProfile(card: ProfileCard) {
    this.store.putProfile(card.pub, card, card.updatedAt);
    if (!cfg.files) return;
    // keep avatars/banners of people in our communities so they render while their owners are offline
    for (const [c] of this.convos) {
      if (!this.state(c)?.members[card.pub]) continue;
      for (const a of [card.avatar, card.banner]) if (a && a.size <= Math.min(cfg.fileMaxBytes, 12 * 1024 * 1024)) this.store.want(a.hash, c, card.pub, a.size, a.mime);
      break;
    }
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  private async serveFile(l: RelayLink, hash: string, offset: number) {
    if (!isHex(hash, 64)) return;
    const key = l.addr + hash;
    if (this.uploads.has(key)) return;
    const meta = this.store.blob(hash);
    if (!meta || !fs.existsSync(this.store.blobPath(hash))) {
      void l.send({ t: 'ferr', h: hash, why: 'missing' });
      return;
    }
    if ([...this.uploads.keys()].filter((k) => k.startsWith(l.addr)).length >= 3) {
      void l.send({ t: 'ferr', h: hash, why: 'busy' });
      return;
    }
    const job = { cancel: false };
    this.uploads.set(key, job);
    try {
      const data = fs.readFileSync(this.store.blobPath(hash));
      const head = hexToBytes(hash);
      const n = Math.ceil(data.length / CHUNK);
      for (let i = Math.max(0, Math.floor(offset)); i < n; i++) {
        if (job.cancel || l.closed) break;
        const slice = data.subarray(i * CHUNK, (i + 1) * CHUNK);
        const frame = new Uint8Array(36 + slice.length);
        frame.set(head, 0);
        new DataView(frame.buffer).setUint32(32, i);
        frame.set(slice, 36);
        if (!(await l.sendBin(frame))) break;
      }
    } finally {
      this.uploads.delete(key);
    }
  }

  private async pumpFiles() {
    if (!cfg.files || this.hub.state !== 'online') return;
    const now = Date.now();
    for (const d of this.downloads.values()) if (now - d.lastData > 25_000) this.abortDownload(d, 30_000);
    if (this.downloads.size >= 2) return;
    const totals = this.store.blobTotals();
    for (const w of this.store.due(now)) {
      if (this.downloads.size >= 2) break;
      if (this.downloads.has(w.hash)) continue;
      if (this.store.blob(w.hash)) {
        this.store.unwant(w.hash);
        continue;
      }
      if (w.tries >= 12) {
        this.store.unwant(w.hash);
        continue;
      }
      if (totals.b + w.size > cfg.filesTotalBytes) {
        this.store.retryLater(w.hash, now + 3600_000);
        continue;
      }
      const links = [...this.links.values()].filter((l) => l.helloReceived && !l.closed && (l.pub === w.owner || this.shares(w.c, l.pub, l)));
      links.sort((a, b) => (b.pub === w.owner ? 1 : 0) - (a.pub === w.owner ? 1 : 0));
      const l = links[0];
      if (!l) {
        this.store.retryLater(w.hash, now + 60_000);
        continue;
      }
      const dl: Download = { hash: w.hash, c: w.c, size: w.size, mime: w.mime, chunks: new Array(Math.ceil(w.size / CHUNK)), count: 0, link: l, lastData: now, tried: new Set([l.addr]) };
      this.downloads.set(w.hash, dl);
      void l.send({ t: 'freq', h: w.hash, o: 0 });
    }
  }

  private abortDownload(d: Download, retryMs: number) {
    this.downloads.delete(d.hash);
    void d.link.send({ t: 'fcancel', h: d.hash });
    this.store.retryLater(d.hash, Date.now() + retryMs);
  }

  onBinary = (l: RelayLink, b: Uint8Array) => {
    if (b.length < 36) return;
    const hash = bytesToHex(b.subarray(0, 32));
    const d = this.downloads.get(hash);
    if (!d || d.link !== l) return;
    const idx = new DataView(b.buffer, b.byteOffset + 32, 4).getUint32(0);
    if (idx >= d.chunks.length || d.chunks[idx]) return;
    const data = b.slice(36);
    const expected = idx === d.chunks.length - 1 ? d.size - idx * CHUNK : CHUNK;
    if (data.length !== expected) return this.abortDownload(d, 60_000);
    d.chunks[idx] = data;
    d.count++;
    d.lastData = Date.now();
    if (d.count < d.chunks.length) return;
    this.downloads.delete(hash);
    const all = Buffer.concat(d.chunks as Uint8Array[]);
    if (createHash('sha256').update(all).digest('hex') !== hash || all.length !== d.size) {
      log('peer sent a corrupted file, will retry elsewhere', hash.slice(0, 12));
      this.store.retryLater(hash, Date.now() + 60_000);
      return;
    }
    this.store.putBlob(hash, d.mime, all);
    this.store.unwant(hash);
  };

  // ---------------------------------------------------------------------------
  // Mailbox: join requests
  // ---------------------------------------------------------------------------

  private async onMail(items: { id: string; box: string; at: number }[]) {
    const done: string[] = [];
    for (const it of items) {
      done.push(it.id);
      try {
        const env = await unsealSigned(this.keys, fromB64(it.box));
        const body = env.body as { type?: string; link?: string; name?: string };
        if (body?.type !== 'keeper.join' || typeof body.link !== 'string') continue;
        if (!cfg.open && !this.owners.has(env.from)) {
          log(`ignoring a join request from ${env.from.slice(0, 12)} (not in KEEPER_OWNERS)`);
          continue;
        }
        this.join(body.link, env.from);
      } catch {
        /* undecryptable or forged */
      }
    }
    this.hub.mailDel(done);
  }

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------

  private sweep() {
    const now = Date.now();
    for (const [k, t] of this.seenEph) if (now - t > 120_000) this.seenEph.delete(k);
    for (const [c, x] of this.convos) if (x.row.join_code) this.maybeJoin(c);
    for (const l of [...this.links.values()]) {
      let inTopic = false;
      for (const s of this.topicPeers.values()) if (s.has(l.addr)) inTopic = true;
      if (!inTopic && now - l.lastRecv > 90_000) {
        this.dropLink(l.addr);
        continue;
      }
      // periodic anti-entropy: catches anything gossip missed
      if (l.helloReceived) for (const c of this.convos.keys()) if (this.shares(c, l.pub, l) && now - (this.lastSync.get(c + l.addr) ?? 0) > 120_000) this.requestSync(c, l);
    }
  }

  private statusServer() {
    http
      .createServer((req, res) => {
        if (req.url !== '/status') {
          res.writeHead(404);
          return res.end();
        }
        const blobs = this.store.blobTotals();
        const body = {
          id: this.keys.pub,
          addr: this.hub.addr,
          username: cfg.username,
          hub: this.hub.state,
          communities: [...this.convos.values()].map((x) => {
            const st = x.eng.state as CommunityState | null;
            return {
              c: x.row.c,
              name: st?.name ?? null,
              member: !!st?.members[this.keys.pub],
              pending: !!x.row.join_code,
              members: st ? Object.keys(st.members).length : 0,
              ops: this.store.countOps(x.row.c),
            };
          }),
          links: [...this.links.values()].filter((l) => l.helloReceived).length,
          files: { count: blobs.n, bytes: blobs.b, wanted: this.store.wantedCount() },
          relayBacklog: this.pacer.backlog,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body, null, 1));
      })
      .listen(cfg.statusPort, cfg.statusHost, () => log(`status on http://${cfg.statusHost}:${cfg.statusPort}/status`));
  }
}

const keeper = new Keeper();
keeper.start().catch((e) => {
  console.error(e);
  process.exit(1);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

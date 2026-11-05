/**
 * Bots that run inside your CelChat. Each bot is its own identity (an Ed25519 key this device
 * keeps, encrypted) and joins communities as a normal member: every peer checks its ops with the
 * same permission engine as anyone else's. Its code runs in a Web Worker inside a sandboxed,
 * opaque-origin iframe (no access to CelChat's storage or keys, no network unless allowed).
 * Everything the bot does is a `call` that this host validates, signs with the bot's key and
 * gossips.
 */
import { set, get } from '../state/store';
import type { CelApp } from './app';
import type { StoredOp } from './db';
import { keysFromSeed, newSeed, sign, signObject, verify, aesEncrypt, aesDecrypt, sha256Bytes, type Keys } from '@shared/crypto';
import { bytesToHex, hexToBytes, randomHex, toB64, fromB64, utf8ToBytes, bytesToUtf8, concatBytes, isHex } from '@shared/bytes';
import { signProfile, verifyProfile, defaultProfile, displayNameOf, zCommand, USERNAME_RE, type BotCommand, type ProfileCard, type ProfileDraft } from '@shared/profile';
import { PAYLOADS, type Attachment, type AssetRef, type Embed, type MsgButton } from '@shared/ops';
import { basePerms, channelPerms, highestPos, sortedRoles, type CommunityState, type Message } from '@shared/engine';
import { P, PERM_INFO } from '@shared/perms';
import { LIMITS } from '@shared/limits';
import { canonical } from '@shared/canonical';
import { SANDBOX_HTML, SANDBOX_NET_HTML } from '@shared/botSandbox';
import RUNTIME from '../bots/runtime.js?raw';

export type BotStatus = 'stopped' | 'starting' | 'running' | 'crashed';

export interface BotRecord {
  pub: string;
  /** hex Ed25519 seed (the whole record list is stored encrypted) */
  seed: string;
  /** this device's chain id for the bot's ops */
  dv: string;
  code: string;
  network: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  card: ProfileCard;
  template?: string;
}

export interface BotView {
  pub: string;
  name: string;
  username: string;
  about: string;
  avatar: AssetRef | null;
  colors: { primary: string; accent: string };
  status: BotStatus;
  error: string | null;
  enabled: boolean;
  network: boolean;
  communities: string[];
  commands: BotCommand[];
  template?: string;
  updatedAt: number;
}

export interface BotLog {
  t: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'system';
  text: string;
}

export interface PlayLine {
  id: string;
  a: string;
  text: string;
  embeds: (Embed & { imageUrl?: string; thumbUrl?: string })[];
  buttons: MsgButton[];
  files: { name: string; mime: string; url: string }[];
  t: number;
  edited: boolean;
  reply: string | null;
  reacts: string[];
}

export interface BotFileExport {
  celbot: 1;
  name: string;
  username: string;
  about: string;
  code: string;
  network: boolean;
  colors?: { primary: string; accent: string };
  avatar?: string;
  template?: string;
  identity?: { seed: string; pub: string };
}

export const PLAYGROUND = 'playground';
const LIVE_MS = 120_000;
const MAX_CODE = 256 * 1024;
const MAX_STORAGE = 1024 * 1024;
const PERM_NAMES = PERM_INFO.map((x) => x.key);

class Runtime {
  frame: HTMLIFrameElement | null = null;
  status: BotStatus = 'starting';
  error: string | null = null;
  offset = 0;
  loaded = false;
  queue: unknown[] = [];
  awaiting = false;
  pingAt = 0;
  pingN = 0;
  startedAt = Date.now();
  commands: BotCommand[] = [];
  chain: Promise<void> = Promise.resolve();
  source = '';
  constructor(readonly pub: string) {}
  post(m: unknown) {
    this.frame?.contentWindow?.postMessage(m, '*');
  }
}

const userNameRe = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 32);

export class BotHost {
  records = new Map<string, BotRecord>();
  private runtimes = new Map<string, Runtime>();
  private keyCache = new Map<string, Keys>();
  private storage = new Map<string, Record<string, unknown>>();
  private storageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private handled = new Map<string, string[]>();
  private handledSave: ReturnType<typeof setTimeout> | null = null;
  private rate = new Map<string, number[]>();
  private statusAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private app: CelApp) {}

  private get encKey() {
    return sha256Bytes(concatBytes(this.app.keys.seed, utf8ToBytes('celchat/bots/v1')));
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  async load() {
    window.addEventListener('message', this.onWindowMessage);
    const raw = (await this.app.db.get('kv', 'bots'))?.v;
    if (typeof raw === 'string') {
      try {
        const list = JSON.parse(bytesToUtf8(await aesDecrypt(this.encKey, fromB64(raw)))) as BotRecord[];
        for (const r of list) {
          if (!isHex(r.seed, 64)) continue;
          const keys = keysFromSeed(hexToBytes(r.seed));
          if (keys.pub !== r.pub) continue;
          const card = verifyProfile(r.card);
          r.card = card && card.pub === r.pub ? card : signProfile(keys, { ...defaultProfile('bot', r.createdAt), bot: true, botInfo: { kind: 'app', hosted: true, commands: [] } });
          this.records.set(r.pub, r);
          this.app.setLocalProfile(r.card);
        }
      } catch (e) {
        console.warn('[bots] could not decrypt bot list', e);
      }
    }
    const h = (await this.app.db.get('kv', 'bothandled'))?.v as Record<string, string[]> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) if (Array.isArray(v)) this.handled.set(k, v.slice(-300));
    this.timer = setInterval(() => this.watch(), 4000);
    this.publish();
    for (const r of this.records.values()) {
      if (!r.enabled) continue;
      try {
        this.start(r.pub);
      } catch (e) {
        this.log(r.pub, 'error', 'Could not start: ' + (e as Error).message);
      }
    }
  }

  dispose() {
    window.removeEventListener('message', this.onWindowMessage);
    if (this.timer) clearInterval(this.timer);
    for (const rt of this.runtimes.values()) this.teardown(rt);
    this.runtimes.clear();
  }

  private async persist() {
    const plain = utf8ToBytes(JSON.stringify([...this.records.values()]));
    await this.app.db.put('kv', { k: 'bots', v: toB64(await aesEncrypt(this.encKey, plain)) });
  }

  private keys(pub: string): Keys {
    let k = this.keyCache.get(pub);
    if (!k) {
      const rec = this.records.get(pub);
      if (!rec) throw new Error('Unknown bot');
      k = keysFromSeed(hexToBytes(rec.seed));
      this.keyCache.set(pub, k);
    }
    return k;
  }

  private rec(pub: string) {
    const r = this.records.get(pub);
    if (!r) throw new Error('Unknown bot');
    return r;
  }

  /** Snapshot for the UI. */
  publish() {
    const views: BotView[] = [...this.records.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => {
        const rt = this.runtimes.get(r.pub);
        return {
          pub: r.pub,
          name: displayNameOf(r.card),
          username: r.card.username,
          about: r.card.about,
          avatar: r.card.avatar,
          colors: r.card.colors,
          status: rt?.status ?? 'stopped',
          error: rt?.error ?? null,
          enabled: r.enabled,
          network: r.network,
          communities: this.communitiesOf(r.pub),
          commands: r.card.botInfo?.commands ?? [],
          template: r.template,
          updatedAt: r.updatedAt,
        };
      });
    set({ bots: views });
  }

  communitiesOf(pub: string) {
    return this.app.convos
      .list()
      .filter((x) => x.rec.type === 'community' && !!x.eng.state?.members[pub] && !!x.eng.state?.members[this.app.me])
      .map((x) => x.rec.c);
  }

  isMine(pub: string) {
    return this.records.has(pub);
  }

  running(pub: string) {
    const rt = this.runtimes.get(pub);
    return !!rt && rt.status === 'running';
  }

  // ===========================================================================
  // Create, edit, import, export, delete
  // ===========================================================================

  async create(o: { name: string; username: string; code: string; network: boolean; about?: string; avatar?: Blob | null; colors?: { primary: string; accent: string }; template?: string; seed?: string }) {
    const seed = o.seed && isHex(o.seed, 64) ? hexToBytes(o.seed) : newSeed();
    const keys = keysFromSeed(seed);
    if (this.records.has(keys.pub)) throw new Error('You already have this bot.');
    let username = userNameRe(o.username || o.name);
    if (!USERNAME_RE.test(username)) username = 'bot' + randomHex(3);
    const draft: ProfileDraft = {
      ...defaultProfile(username, Date.now()),
      displayName: (o.name.trim() || username).slice(0, LIMITS.displayNameChars),
      about: (o.about ?? '').slice(0, LIMITS.aboutChars),
      bot: true,
      botInfo: { kind: 'app', hosted: true, commands: [] },
    };
    if (o.colors) draft.colors = o.colors;
    if (o.avatar) draft.avatar = await this.app.storeImage(o.avatar, 'avatar');
    const card = signProfile(keys, draft);
    const rec: BotRecord = { pub: keys.pub, seed: bytesToHex(seed), dv: randomHex(8), code: o.code.slice(0, MAX_CODE), network: o.network, enabled: false, createdAt: Date.now(), updatedAt: Date.now(), card, template: o.template };
    this.records.set(rec.pub, rec);
    await this.persist();
    this.app.setLocalProfile(card);
    this.publish();
    return rec.pub;
  }

  async update(pub: string, patch: { code?: string; network?: boolean; name?: string; username?: string; about?: string; avatar?: Blob | null; colors?: { primary: string; accent: string } }) {
    const rec = this.rec(pub);
    const cardPatch: Partial<ProfileDraft> = {};
    if (patch.name !== undefined) cardPatch.displayName = patch.name.trim().slice(0, LIMITS.displayNameChars);
    if (patch.username !== undefined) {
      const u = userNameRe(patch.username);
      if (!USERNAME_RE.test(u)) throw new Error('Usernames are 2 to 32 characters: a-z, 0-9, _ and .');
      cardPatch.username = u;
    }
    if (patch.about !== undefined) cardPatch.about = patch.about.slice(0, LIMITS.aboutChars);
    if (patch.colors) cardPatch.colors = patch.colors;
    if (patch.avatar !== undefined) cardPatch.avatar = patch.avatar ? await this.app.storeImage(patch.avatar, 'avatar') : null;
    if (Object.keys(cardPatch).length) this.resign(rec, cardPatch);
    let restart = false;
    if (patch.code !== undefined && patch.code !== rec.code) {
      if (patch.code.length > MAX_CODE) throw new Error(`Bot code is limited to ${MAX_CODE / 1024} KB.`);
      rec.code = patch.code;
      restart = true;
    }
    if (patch.network !== undefined && patch.network !== rec.network) {
      rec.network = patch.network;
      restart = true;
    }
    if (patch.name !== undefined || patch.username !== undefined) restart = true;
    rec.updatedAt = Date.now();
    await this.persist();
    if (restart && this.runtimes.has(pub)) this.start(pub);
    this.publish();
  }

  private resign(rec: BotRecord, patch: Partial<ProfileDraft>) {
    const keys = this.keys(rec.pub);
    const { sig: _s, pub: _p, v: _v, updatedAt, ...draft } = rec.card;
    const next = { ...draft, ...patch, bot: true, botInfo: { kind: 'app' as const, hosted: true, commands: patch.botInfo?.commands ?? draft.botInfo?.commands ?? [] } };
    // peers keep the newest card by updatedAt, so it must strictly increase
    const card = signObject(keys, { ...next, v: 1 as const, pub: keys.pub, updatedAt: Math.max(Date.now(), updatedAt + 1) }) as ProfileCard;
    rec.card = card;
    this.app.setLocalProfile(card);
    this.scheduleAnnounce();
  }

  async remove(pub: string) {
    const rec = this.rec(pub);
    this.stop(pub, false);
    for (const c of this.communitiesOf(pub)) {
      try {
        await this.authorAs(pub, c, 'leave', {});
      } catch {
        /* best effort */
      }
    }
    this.records.delete(pub);
    this.keyCache.delete(pub);
    this.storage.delete(pub);
    await this.app.db.delete('kv', 'botdata:' + pub);
    this.handled.delete(pub);
    set((s) => {
      const botLogs = { ...s.botLogs };
      const botPlay = { ...s.botPlay };
      delete botLogs[pub];
      delete botPlay[pub];
      return { botLogs, botPlay };
    });
    void rec;
    await this.persist();
    this.publish();
  }

  async exportFile(pub: string, withIdentity: boolean): Promise<string> {
    const rec = this.rec(pub);
    const out: BotFileExport = { celbot: 1, name: displayNameOf(rec.card), username: rec.card.username, about: rec.card.about, code: rec.code, network: rec.network, colors: rec.card.colors };
    if (rec.template) out.template = rec.template;
    if (rec.card.avatar) {
      const blob = await this.app.files.getBlob(rec.card.avatar.hash);
      if (blob && blob.size <= 512 * 1024) out.avatar = await blobToDataUrl(blob);
    }
    if (withIdentity) out.identity = { seed: rec.seed, pub: rec.pub };
    return JSON.stringify(out, null, 2);
  }

  /** Read a .celbot file (or a plain .js file) without creating anything. */
  parseImport(text: string, fileName = ''): BotFileExport & { existing: boolean } {
    let f: Partial<BotFileExport>;
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{')) {
      try {
        f = JSON.parse(text);
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      if (f.celbot !== 1 || typeof f.code !== 'string') throw new Error('That is not a CelChat bot file.');
    } else {
      const base = fileName.replace(/\.(m?js|celbot|txt)$/i, '') || 'Imported bot';
      f = { celbot: 1, name: base.slice(0, 32), username: userNameRe(base) || 'bot', about: '', code: text, network: false };
    }
    if ((f.code ?? '').length > MAX_CODE) throw new Error(`Bot code is limited to ${MAX_CODE / 1024} KB.`);
    let identity: BotFileExport['identity'];
    if (f.identity) {
      if (!isHex(f.identity.seed, 64)) throw new Error('The identity in that file is damaged.');
      const pub = keysFromSeed(hexToBytes(f.identity.seed)).pub;
      identity = { seed: f.identity.seed, pub };
    }
    const colorOk = (c: unknown) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
    return {
      celbot: 1,
      name: String(f.name ?? 'Bot').slice(0, 32),
      username: userNameRe(String(f.username ?? f.name ?? 'bot')) || 'bot',
      about: String(f.about ?? '').slice(0, LIMITS.aboutChars),
      code: String(f.code ?? ''),
      network: !!f.network,
      colors: f.colors && colorOk(f.colors.primary) && colorOk(f.colors.accent) ? f.colors : undefined,
      avatar: typeof f.avatar === 'string' && f.avatar.startsWith('data:image/') && f.avatar.length < 800_000 ? f.avatar : undefined,
      template: typeof f.template === 'string' ? f.template.slice(0, 40) : undefined,
      identity,
      existing: !!identity && this.records.has(identity.pub),
    };
  }

  async importBot(f: BotFileExport, keepIdentity: boolean) {
    const avatar = f.avatar ? await (await fetch(f.avatar)).blob() : null;
    if (keepIdentity && f.identity && this.records.has(f.identity.pub)) {
      await this.update(f.identity.pub, { code: f.code, network: f.network, name: f.name, about: f.about });
      return f.identity.pub;
    }
    return this.create({ name: f.name, username: f.username, about: f.about, code: f.code, network: f.network, colors: f.colors, avatar, template: f.template, seed: keepIdentity ? f.identity?.seed : undefined });
  }

  // ===========================================================================
  // Communities
  // ===========================================================================

  async addToCommunity(pub: string, c: string) {
    this.rec(pub);
    const st = this.app.convos.community(c);
    const me = this.app.me;
    if (!st || !st.members[me]) throw new Error('You are not a member of that community.');
    if (st.members[pub]) return;
    if (st.bans[pub]) throw new Error('This bot is banned from that community.');
    let code: string | undefined;
    if (st.joinPolicy !== 'open') {
      const perms = basePerms(st, me);
      if (st.owner !== me && !(perms & (P.CREATE_INVITE | P.ADMIN))) throw new Error('You need the "Create invites" permission to add a bot here.');
      code = randomAlnum(10);
      await this.app.author(c, 'inv.create', { code, expiresAt: Date.now() + 10 * 60_000, maxUses: 1 });
    }
    await this.authorAs(pub, c, 'join', code ? { code } : {});
    if (!this.app.convos.community(c)?.members[pub]) throw new Error('The community did not accept the bot.');
    this.log(pub, 'system', `Joined ${st.name}.`);
    this.scheduleAnnounce();
    this.publish();
  }

  async removeFromCommunity(pub: string, c: string) {
    await this.authorAs(pub, c, 'leave', {});
    this.log(pub, 'system', `Left ${this.app.convos.community(c)?.name ?? 'a community'}.`);
    this.publish();
  }

  /** Sign as the bot, store locally (the engine checks it like anyone's), and gossip. */
  private async authorAs(pub: string, c: string, k: string, p: unknown) {
    const rec = this.rec(pub);
    const op = await this.app.convos.authorAs(this.keys(pub), rec.dv, c, k, p);
    this.app.sync.gossip(op);
    return op;
  }

  private checkGov(op: StoredOp) {
    if (this.app.convos.isValid(op)) return;
    const why = this.app.convos.get(op.c)?.eng.status.get(op.id) ?? 'rejected';
    throw new Error(`CelChat rejected that (${why}). Check the bot's role and permissions.`);
  }

  // ===========================================================================
  // Running
  // ===========================================================================

  async setEnabled(pub: string, on: boolean) {
    const rec = this.rec(pub);
    rec.enabled = on;
    await this.persist();
    if (on) this.start(pub);
    else this.stop(pub);
  }

  start(pub: string) {
    const rec = this.rec(pub);
    const old = this.runtimes.get(pub);
    if (old) this.teardown(old);
    const rt = new Runtime(pub);
    const me = { id: rec.pub, name: displayNameOf(rec.card), username: rec.card.username, network: rec.network };
    const head = 'const __CEL_ME = ' + JSON.stringify(me) + ';\n' + RUNTIME + '\n;(async () => {\ntry {\n';
    rt.source = head + rec.code + '\n} catch (e) { __cel.fail(e); } finally { __cel.loaded(); }\n})();\n';
    rt.offset = head.split('\n').length - 1;
    rt.commands = rec.card.botInfo?.commands ?? [];
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('aria-hidden', 'true');
    f.title = 'bot sandbox';
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px;top:0;visibility:hidden';
    // srcdoc + sandbox: an opaque origin with its own CSP (no network unless allowed)
    f.srcdoc = rec.network ? SANDBOX_NET_HTML : SANDBOX_HTML;
    rt.frame = f;
    this.runtimes.set(pub, rt);
    document.body.appendChild(f);
    this.log(pub, 'system', `Starting${rec.network ? ' (internet allowed)' : ''}...`);
    this.publish();
  }

  stop(pub: string, note = true) {
    const rt = this.runtimes.get(pub);
    if (!rt) return;
    this.teardown(rt);
    this.runtimes.delete(pub);
    if (note) this.log(pub, 'system', 'Stopped.');
    this.scheduleAnnounce();
    this.publish();
  }

  private teardown(rt: Runtime) {
    rt.frame?.remove();
    rt.frame = null;
    rt.loaded = false;
  }

  private crash(rt: Runtime, why: string) {
    this.teardown(rt);
    rt.status = 'crashed';
    rt.error = why;
    this.log(rt.pub, 'error', why);
    this.scheduleAnnounce();
    this.publish();
  }

  private watch() {
    const now = Date.now();
    for (const rt of this.runtimes.values()) {
      if (!rt.frame) continue;
      if (!rt.loaded) {
        if (now - rt.startedAt > 25_000) this.crash(rt, 'The bot did not start within 25 seconds.');
        continue;
      }
      if (rt.awaiting) {
        if (now - rt.pingAt > 20_000) this.crash(rt, 'The bot stopped responding for 20 seconds (an endless loop?), so it was stopped.');
        continue;
      }
      rt.awaiting = true;
      rt.pingAt = now;
      rt.post({ t: 'ping', n: ++rt.pingN });
    }
  }

  private onWindowMessage = (e: MessageEvent) => {
    for (const rt of this.runtimes.values()) {
      if (rt.frame && e.source === rt.frame.contentWindow) {
        void this.onRuntimeMessage(rt, e.data);
        return;
      }
    }
  };

  private mapLines(rt: Runtime, text: string) {
    return text.replace(/blob:[^\s)]+?:(\d+):(\d+)/g, (_m, l: string, col: string) => {
      const n = Number(l) - rt.offset;
      return n > 0 ? `bot.js:${n}:${col}` : `runtime:${l}:${col}`;
    });
  }

  private async onRuntimeMessage(rt: Runtime, m: unknown) {
    if (!m || typeof m !== 'object' || this.runtimes.get(rt.pub) !== rt) return;
    const msg = m as Record<string, unknown>;
    switch (msg.t) {
      case 'sandbox':
        rt.post({ t: 'init', source: rt.source });
        return;
      case 'loaded': {
        rt.loaded = true;
        rt.status = 'running';
        rt.error = null;
        this.setCommands(rt, msg.commands);
        const n = this.communitiesOf(rt.pub).length;
        this.log(rt.pub, 'system', `Running. ${rt.commands.length} command${rt.commands.length === 1 ? '' : 's'}, in ${n} communit${n === 1 ? 'y' : 'ies'}.`);
        for (const q of rt.queue.splice(0)) rt.post(q);
        rt.post({ t: 'event', name: 'ready', data: {} });
        this.scheduleAnnounce();
        this.publish();
        return;
      }
      case 'commands':
        this.setCommands(rt, msg.list);
        return;
      case 'pong':
        rt.awaiting = false;
        return;
      case 'log': {
        const level = (['log', 'info', 'warn', 'error'] as const).find((l) => l === msg.level) ?? 'log';
        const args = Array.isArray(msg.args) ? msg.args.map((a) => String(a)) : [];
        this.log(rt.pub, level, this.mapLines(rt, args.join(' ')).slice(0, 4000));
        return;
      }
      case 'fatal': {
        const line = Number(msg.line) || 0;
        const where = line > rt.offset ? ` (line ${line - rt.offset})` : '';
        this.crash(rt, `${String(msg.message ?? 'The bot crashed')}${where}`);
        return;
      }
      case 'call': {
        const id = msg.id;
        const method = String(msg.method);
        const args = Array.isArray(msg.args) ? msg.args : [];
        try {
          const value = await this.handleCall(rt, method, args);
          rt.post({ t: 'res', id, ok: true, value: value === undefined ? null : value });
        } catch (e) {
          const err = (e as Error).message || String(e);
          rt.post({ t: 'res', id, ok: false, error: err });
        }
        return;
      }
    }
  }

  private setCommands(rt: Runtime, raw: unknown) {
    const list: BotCommand[] = [];
    if (Array.isArray(raw)) {
      for (const c of raw.slice(0, LIMITS.botCommands)) {
        const r = zCommand.safeParse(c);
        if (r.success) list.push(r.data);
        else this.log(rt.pub, 'warn', `Ignored an invalid command definition: ${JSON.stringify(c).slice(0, 200)}`);
      }
    }
    rt.commands = list;
    const rec = this.records.get(rt.pub);
    if (!rec) return;
    const old = rec.card.botInfo?.commands ?? [];
    if (canonical(old) !== canonical(list)) {
      this.resign(rec, { botInfo: { kind: 'app', hosted: true, commands: list } });
      void this.persist();
      this.publish();
    }
  }

  private emit(rt: Runtime, name: string, data: unknown) {
    const m = { t: 'event', name, data };
    if (!rt.loaded) {
      if (rt.queue.length < 200) rt.queue.push(m);
      return;
    }
    rt.post(m);
  }

  log(pub: string, level: BotLog['level'], text: string) {
    set((s) => {
      const cur = s.botLogs[pub] ?? [];
      const next = [...cur, { t: Date.now(), level, text }];
      return { botLogs: { ...s.botLogs, [pub]: next.length > 400 ? next.slice(-400) : next } };
    });
  }

  clearLog(pub: string) {
    set((s) => ({ botLogs: { ...s.botLogs, [pub]: [] } }));
  }

  // ===========================================================================
  // Events from the network
  // ===========================================================================

  onOps(c: string, ops: StoredOp[]) {
    if (!this.runtimes.size) return;
    const st = this.app.convos.community(c);
    if (!st) return;
    for (const rt of this.runtimes.values()) {
      if (!st.members[rt.pub] && !ops.some((o) => o.k === 'join' && o.a === rt.pub)) continue;
      if (rt.status !== 'running' && rt.status !== 'starting') continue;
      for (const op of ops) rt.chain = rt.chain.then(() => this.route(rt, c, op)).catch((e) => console.warn('[bots]', e));
    }
  }

  private wasHandled(pub: string, id: string) {
    return this.handled.get(pub)?.includes(id) ?? false;
  }

  private markHandled(pub: string, id: string) {
    const list = this.handled.get(pub) ?? [];
    list.push(id);
    if (list.length > 300) list.splice(0, list.length - 300);
    this.handled.set(pub, list);
    if (!this.handledSave)
      this.handledSave = setTimeout(() => {
        this.handledSave = null;
        void this.app.db.put('kv', { k: 'bothandled', v: Object.fromEntries(this.handled) });
      }, 2000);
  }

  private async route(rt: Runtime, c: string, op: StoredOp) {
    if (op.a === rt.pub || op.eq) return;
    const now = Date.now();
    if (now - op.t > LIVE_MS || op.t - now > 60_000) return;
    if (this.wasHandled(rt.pub, op.id)) return;
    const convo = this.app.convos.get(c);
    const st = convo?.eng.state;
    if (!convo || !st || st.kind !== 'community' || !st.members[rt.pub]) return;
    const canView = (ch: string) => (channelPerms(st, rt.pub, ch, now) & P.VIEW_CHANNEL) !== 0;
    switch (op.k) {
      case 'msg': {
        const m = await this.app.convos.materialize(convo, op);
        if (!m || m.deleted || !canView(m.ch)) return;
        this.markHandled(rt.pub, op.id);
        const data = this.msgData(c, m, rt.pub);
        this.emit(rt, 'message', data);
        if (!data.author.bot) await this.maybeCommand(rt, c, st, m.text, data, m.ch, m.id);
        return;
      }
      case 'interact': {
        const p = op.p as { id?: string; b?: string } | undefined;
        if (!p?.id) return;
        const m = await this.app.convos.getMessage(c, p.id);
        if (!m || m.a !== rt.pub || !canView(m.ch)) return;
        const chk = convo.eng.checkInteraction(op, m);
        if (!chk.ok) return;
        this.markHandled(rt.pub, op.id);
        this.emit(rt, 'button', {
          buttonId: chk.button.id,
          c,
          ch: m.ch,
          user: this.userData(c, op.a),
          message: { id: m.id, c, ch: m.ch, text: m.text, embeds: m.embeds, buttons: m.buttons },
          channel: this.channelData(c, st, m.ch),
          community: this.communityData(c, st),
        });
        return;
      }
      case 'react': {
        const p = op.p as { id?: string; e?: string; on?: boolean } | undefined;
        if (!p?.id || !p.e) return;
        const m = await this.app.convos.getMessage(c, p.id);
        if (!m || !canView(m.ch) || !this.app.convos.isValid(op)) return;
        this.markHandled(rt.pub, op.id);
        this.emit(rt, 'reaction', {
          emoji: p.e,
          on: !!p.on,
          c,
          ch: m.ch,
          user: this.userData(c, op.a),
          message: { id: m.id, c, ch: m.ch, authorId: m.a, text: m.text },
          channel: this.channelData(c, st, m.ch),
          community: this.communityData(c, st),
        });
        return;
      }
      case 'join':
      case 'leave':
      case 'kick':
      case 'ban': {
        if (!this.app.convos.isValid(op)) return;
        this.markHandled(rt.pub, op.id);
        const target = op.k === 'join' || op.k === 'leave' ? op.a : (op.p as { target?: string })?.target;
        if (!target || target === rt.pub) return;
        const reason = op.k === 'join' ? undefined : op.k;
        this.emit(rt, op.k === 'join' ? 'memberJoin' : 'memberLeave', { user: this.userData(c, target), community: this.communityData(c, st), reason, by: op.k === 'kick' || op.k === 'ban' ? op.a : undefined });
        return;
      }
    }
  }

  private matchCommand(rt: Runtime, text: string) {
    const m = /^\s*\/([a-z0-9_-]{1,32})(?:@([a-z0-9_.]{2,32}))?(?=\s|$)/i.exec(text);
    if (!m) return null;
    const rec = this.records.get(rt.pub);
    if (m[2] && m[2].toLowerCase() !== rec?.card.username) return null;
    const spec = rt.commands.find((c) => c.name === m[1].toLowerCase());
    return spec ? { spec, rest: text.slice(m[0].length) } : null;
  }

  private async maybeCommand(rt: Runtime, c: string, st: CommunityState | null, text: string, data: ReturnType<BotHost['msgData']>, ch: string, msgId: string) {
    const hit = this.matchCommand(rt, text);
    if (!hit) return;
    const parsed = this.parseArgs(hit.spec, hit.rest, c, st);
    if ('error' in parsed) {
      try {
        await this.handleCall(rt, 'send', [c, ch, `⚠️ ${parsed.error}\nUsage: \`${commandUsage(hit.spec)}\``, msgId]);
      } catch {
        /* cannot reply here */
      }
      return;
    }
    const types: Record<string, string> = {};
    for (const a of hit.spec.args ?? []) types[a.name] = a.type;
    this.emit(rt, 'command', { name: hit.spec.name, args: parsed.args, types, message: data });
  }

  private parseArgs(spec: BotCommand, rest: string, c: string, st: CommunityState | null): { args: Record<string, unknown> } | { error: string } {
    const toks: { v: string; start: number }[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(rest))) toks.push({ v: mm[1] ?? mm[2] ?? mm[3], start: mm.index });
    const args: Record<string, unknown> = {};
    const list = spec.args ?? [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const tok = toks[i];
      if (!tok) {
        if (a.optional) continue;
        return { error: `Missing ${a.name}.` };
      }
      let v: unknown;
      switch (a.type) {
        case 'text':
          v = rest.slice(tok.start).trim();
          break;
        case 'word':
          v = tok.v;
          break;
        case 'number':
        case 'integer': {
          const n = Number(tok.v);
          if (!Number.isFinite(n) || (a.type === 'integer' && !Number.isInteger(n))) return { error: `${a.name} must be ${a.type === 'integer' ? 'a whole number' : 'a number'}.` };
          v = n;
          break;
        }
        case 'boolean': {
          const t = tok.v.toLowerCase();
          if (['yes', 'true', 'on', '1', 'y'].includes(t)) v = true;
          else if (['no', 'false', 'off', '0', 'n'].includes(t)) v = false;
          else return { error: `${a.name} must be yes or no.` };
          break;
        }
        case 'user': {
          const pub = this.findUser(tok.v, c, st);
          if (!pub) return { error: `I could not find the member "${tok.v}".` };
          v = this.userData(c, pub);
          break;
        }
        case 'channel': {
          if (!st) return { error: 'Channels only exist in communities.' };
          const id = /^<#([0-9a-zA-Z_-]+)>$/.exec(tok.v)?.[1];
          const name = tok.v.replace(/^#/, '').toLowerCase();
          const chan = Object.values(st.channels).find((x) => x.type !== 'category' && (x.id === id || x.name.toLowerCase() === name));
          if (!chan) return { error: `I could not find the channel "${tok.v}".` };
          v = this.channelData(c, st, chan.id);
          break;
        }
        case 'role': {
          if (!st) return { error: 'Roles only exist in communities.' };
          const id = /^<@&([0-9a-zA-Z_-]+)>$/.exec(tok.v)?.[1];
          const name = tok.v.replace(/^@/, '').toLowerCase();
          const role = Object.values(st.roles).find((r) => r.id !== st.id && (r.id === id || r.name.toLowerCase() === name));
          if (!role) return { error: `I could not find the role "${tok.v}".` };
          v = { id: role.id, name: role.name, color: role.color };
          break;
        }
      }
      if (a.choices && typeof v === 'string') {
        const pick = a.choices.find((ch) => ch.toLowerCase() === (v as string).toLowerCase());
        if (!pick) return { error: `${a.name} must be one of: ${a.choices.join(', ')}.` };
        v = pick;
      }
      args[a.name] = v;
      if (a.type === 'text') break;
    }
    return { args };
  }

  private findUser(q: string, c: string, st: CommunityState | null): string | null {
    const raw = /^<@([0-9a-f]{64})>$/.exec(q)?.[1];
    const pool = st ? Object.keys(st.members) : [this.app.me, ...[...this.runtimes.keys()]];
    if (raw) return pool.includes(raw) ? raw : null;
    if (/^[0-9a-f]{64}$/.test(q)) return pool.includes(q) ? q : null;
    const name = q.replace(/^@/, '').toLowerCase();
    if (!name) return null;
    const profiles = this.app.profiles;
    return (
      pool.find((p) => profiles.get(p)?.username === name) ??
      pool.find((p) => this.app.nameOf(p, st ? c : undefined).toLowerCase() === name) ??
      pool.find((p) => this.app.nameOf(p, st ? c : undefined).toLowerCase().startsWith(name)) ??
      null
    );
  }

  // ===========================================================================
  // Plain data handed to bots
  // ===========================================================================

  private userData(c: string, pub: string) {
    const card = this.app.profiles.get(pub);
    const st = c === PLAYGROUND ? null : this.app.convos.community(c);
    const m = st?.members[pub];
    const perms = st ? basePerms(st, pub) : pub === this.app.me ? P.ADMIN : 0;
    return {
      id: pub,
      name: this.app.nameOf(pub, st ? c : undefined),
      username: card?.username ?? '',
      bot: !!card?.bot,
      owner: st ? st.owner === pub : pub === this.app.me,
      nick: m?.nick ?? null,
      joinedAt: m?.joinedAt ?? null,
      timeoutUntil: m?.timeoutUntil ?? null,
      roles: st && m ? m.roles.map((r) => st.roles[r]).filter(Boolean).map((r) => ({ id: r.id, name: r.name })) : [],
      permissions: PERM_NAMES.filter((k) => (perms & P[k]) !== 0),
    };
  }

  private channelData(c: string, st: CommunityState | null, ch: string) {
    if (!st || c === PLAYGROUND) return { id: PLAYGROUND, name: 'test-console', type: 'text', topic: '', community: PLAYGROUND };
    const x = st.channels[ch];
    return { id: ch, name: x?.name ?? '', type: x?.type ?? 'text', topic: x?.topic ?? '', parent: x?.parent ?? null, community: c };
  }

  private communityData(c: string, st: CommunityState | null) {
    if (!st || c === PLAYGROUND) return { id: PLAYGROUND, name: 'Test console', description: '', memberCount: 2, owner: this.app.me };
    return { id: c, name: st.name, description: st.description, memberCount: Object.keys(st.members).length, owner: st.owner };
  }

  private msgData(c: string, m: Pick<Message, 'id' | 'ch' | 'a' | 't' | 'text' | 'reply' | 'att' | 'embeds' | 'mentions'>, botPub: string) {
    const st = c === PLAYGROUND ? null : this.app.convos.community(c);
    const username = this.records.get(botPub)?.card.username ?? '';
    return {
      id: m.id,
      c,
      ch: m.ch,
      t: m.t,
      text: m.text,
      plain: this.app.plainText(m.text, st ? c : undefined),
      reply: m.reply,
      author: this.userData(c, m.a),
      channel: this.channelData(c, st, m.ch),
      community: this.communityData(c, st),
      mentions: m.mentions.users,
      mentionsMe: m.mentions.users.includes(botPub) || (!!username && new RegExp(`(^|\\s)@${username.replace(/\./g, '\\.')}\\b`, 'i').test(m.text)),
      attachments: m.att.map((a) => ({ name: a.name, mime: a.mime, size: a.size })),
      embeds: m.embeds,
    };
  }

  // ===========================================================================
  // Calls from bots
  // ===========================================================================

  private limit(rt: Runtime, key: string, max: number, windowMs: number) {
    const k = rt.pub + '|' + key;
    const now = Date.now();
    const list = (this.rate.get(k) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) throw new Error(`Slow down: at most ${max} of those per ${windowMs / 1000} seconds.`);
    list.push(now);
    this.rate.set(k, list);
  }

  private member(rt: Runtime, c: string) {
    const st = this.app.convos.community(c);
    if (!st) throw new Error('I am not in that community (or it is not loaded on this device).');
    if (!st.members[rt.pub]) throw new Error(`I am not a member of ${st.name}.`);
    return st;
  }

  private requirePerm(st: CommunityState, pub: string, bit: number, label: string, ch?: string) {
    const perms = ch ? channelPerms(st, pub, ch, Date.now()) : basePerms(st, pub, Date.now());
    if (st.owner !== pub && !(perms & (bit | P.ADMIN))) throw new Error(`I need the "${label}" permission for that.`);
  }

  private requireAbove(st: CommunityState, pub: string, target: string) {
    if (target === st.owner) throw new Error('Nobody can do that to the community owner.');
    if (st.owner !== pub && highestPos(st, pub) <= highestPos(st, target)) throw new Error("My highest role must be above that member's highest role.");
  }

  private async handleCall(rt: Runtime, method: string, a: unknown[]): Promise<unknown> {
    const str = (v: unknown, name: string) => {
      if (typeof v !== 'string') throw new Error(`${name} must be text.`);
      return v;
    };
    const c = typeof a[0] === 'string' ? a[0] : '';
    const play = c === PLAYGROUND;
    switch (method) {
      case 'send': {
        const ch = str(a[1], 'channel');
        const replyTo = typeof a[3] === 'string' && isHex(a[3], 64) ? a[3] : null;
        if (play) return this.playPost(rt, a[2], replyTo);
        const st = this.member(rt, c);
        const chan = st.channels[ch];
        if (!chan || chan.type !== 'text') throw new Error('That is not a text channel.');
        const perms = channelPerms(st, rt.pub, ch, Date.now());
        if (!(perms & P.VIEW_CHANNEL) || !(perms & P.SEND)) throw new Error(`I do not have permission to send messages in #${chan.name}.`);
        this.limit(rt, 'send:' + c + ch, 5, 5000);
        this.limit(rt, 'send', 30, 30_000);
        const body = await this.normalize(rt, a[2]);
        if (body.files.length && !(perms & P.ATTACH)) throw new Error(`I do not have permission to attach files in #${chan.name}.`);
        const att = body.files.length ? await this.app.attachmentsFrom(body.files) : [];
        const p: Record<string, unknown> = { ch, text: body.text };
        if (replyTo) p.reply = replyTo;
        if (att.length) p.att = att;
        if (body.embeds?.length) p.embeds = this.embedImages(body.embeds, att);
        if (body.buttons?.length) p.buttons = body.buttons;
        this.validate('msg', p);
        const op = await this.authorAs(rt.pub, c, 'msg', p);
        if (!this.app.convos.isValid(op)) throw new Error('CelChat rejected that message (permissions changed?).');
        return { id: op.id, c, ch };
      }
      case 'edit': {
        const id = str(a[1], 'message id');
        if (play) return this.playEdit(rt, id, a[2]);
        const st = this.member(rt, c);
        void st;
        const cur = await this.app.convos.getMessage(c, id);
        if (!cur) throw new Error('Message not found.');
        if (cur.a !== rt.pub) throw new Error('Bots can only edit their own messages.');
        this.limit(rt, 'edit', 20, 10_000);
        const body = await this.normalize(rt, a[2]);
        if (body.files.length) throw new Error('Files cannot be added by editing. Send a new message.');
        const p: Record<string, unknown> = { id, text: body.hasText ? body.text : cur.text };
        if (body.embeds) p.embeds = this.embedImages(body.embeds, cur.att);
        if (body.buttons) p.buttons = body.buttons;
        this.validate('edit', p);
        await this.authorAs(rt.pub, c, 'edit', p);
        return { id, c, ch: cur.ch };
      }
      case 'delete': {
        const id = str(a[1], 'message id');
        if (play) return this.playDelete(rt, id);
        const st = this.member(rt, c);
        const cur = await this.app.convos.getMessage(c, id);
        if (!cur) return null;
        if (cur.a !== rt.pub) this.requirePerm(st, rt.pub, P.MANAGE_MESSAGES, 'Manage messages', cur.ch);
        this.limit(rt, 'delete', 20, 10_000);
        await this.authorAs(rt.pub, c, 'del', { id });
        return null;
      }
      case 'react': {
        const id = str(a[1], 'message id');
        const e = this.emojiOf(str(a[2], 'emoji'));
        const on = a[3] !== false;
        if (play) return this.playReact(rt, id, e, on);
        const st = this.member(rt, c);
        const cur = await this.app.convos.getMessage(c, id);
        if (!cur) throw new Error('Message not found.');
        if (on) this.requirePerm(st, rt.pub, P.REACT, 'Add reactions', cur.ch);
        this.limit(rt, 'react', 10, 5000);
        await this.authorAs(rt.pub, c, 'react', { id, e, on });
        return null;
      }
      case 'pin': {
        if (play) throw new Error('Pinning is not available in the Test tab.');
        const id = str(a[1], 'message id');
        const st = this.member(rt, c);
        const cur = await this.app.convos.getMessage(c, id);
        if (!cur) throw new Error('Message not found.');
        this.requirePerm(st, rt.pub, P.MANAGE_MESSAGES, 'Manage messages', cur.ch);
        await this.authorAs(rt.pub, c, 'pin', { id, on: a[2] !== false });
        return null;
      }
      case 'kick':
      case 'ban':
      case 'timeout':
      case 'role':
      case 'nick': {
        if (play) throw new Error(`"${method}" only works in a real community, not in the Test tab.`);
        const st = this.member(rt, c);
        const target = str(a[1], 'member');
        if (!st.members[target] && method !== 'ban') throw new Error('That person is not a member.');
        this.limit(rt, 'mod', 10, 10_000);
        let op: StoredOp;
        if (method === 'kick') {
          this.requirePerm(st, rt.pub, P.KICK, 'Kick members');
          this.requireAbove(st, rt.pub, target);
          op = await this.authorAs(rt.pub, c, 'kick', { target, reason: typeof a[2] === 'string' && a[2] ? a[2].slice(0, 512) : undefined, cutoff: await this.app.convos.cutoffFor(c, [target]) });
        } else if (method === 'ban') {
          this.requirePerm(st, rt.pub, P.BAN, 'Ban members');
          this.requireAbove(st, rt.pub, target);
          const opts = (a[3] && typeof a[3] === 'object' ? a[3] : {}) as { purgeSeconds?: unknown };
          const purge = typeof opts.purgeSeconds === 'number' ? Math.max(0, Math.min(7 * 86400, Math.floor(opts.purgeSeconds))) : undefined;
          op = await this.authorAs(rt.pub, c, 'ban', { target, reason: typeof a[2] === 'string' && a[2] ? a[2].slice(0, 512) : undefined, purgeSecs: purge || undefined, cutoff: await this.app.convos.cutoffFor(c, [target]) });
        } else if (method === 'timeout') {
          this.requirePerm(st, rt.pub, P.TIMEOUT, 'Timeout members');
          this.requireAbove(st, rt.pub, target);
          const secs = Number(a[2]);
          if (!secs || secs <= 0) op = await this.authorAs(rt.pub, c, 'timeout', { target, until: null });
          else {
            const until = Date.now() + Math.min(secs * 1000, LIMITS.maxTimeoutMs);
            op = await this.authorAs(rt.pub, c, 'timeout', { target, until, reason: typeof a[3] === 'string' && a[3] ? a[3].slice(0, 512) : undefined, cutoff: await this.app.convos.cutoffFor(c, [target]) });
          }
        } else if (method === 'role') {
          this.requirePerm(st, rt.pub, P.MANAGE_ROLES, 'Manage roles');
          const q = str(a[2], 'role').toLowerCase();
          const role = Object.values(st.roles).find((r) => r.id !== st.id && (r.id === a[2] || r.name.toLowerCase() === q));
          if (!role) throw new Error(`There is no role "${a[2]}".`);
          if (st.owner !== rt.pub && role.pos >= highestPos(st, rt.pub)) throw new Error(`My highest role must be above "${role.name}" to hand it out.`);
          const cur = st.members[target].roles;
          const add = a[3] !== false;
          if (add === cur.includes(role.id)) return null;
          const roles = add ? [...cur, role.id] : cur.filter((r) => r !== role.id);
          const p: Record<string, unknown> = { target, roles };
          if (!add) p.cutoff = await this.app.convos.cutoffFor(c, [target]);
          op = await this.authorAs(rt.pub, c, 'mroles', p);
        } else {
          if (target === rt.pub) this.requirePerm(st, rt.pub, P.CHANGE_NICK, 'Change nickname');
          else {
            this.requirePerm(st, rt.pub, P.MANAGE_NICKS, 'Manage nicknames');
            this.requireAbove(st, rt.pub, target);
          }
          const nick = typeof a[2] === 'string' && a[2].trim() ? a[2].trim().slice(0, LIMITS.nickChars) : null;
          op = await this.authorAs(rt.pub, c, 'nick', { target, nick });
        }
        this.checkGov(op);
        return null;
      }
      case 'history': {
        const ch = str(a[1], 'channel');
        if (play) return (get().botPlay[rt.pub] ?? []).slice(-Math.min(50, Number(a[2]) || 20)).map((l) => this.playMsgData(rt, l));
        const st = this.member(rt, c);
        if (!(channelPerms(st, rt.pub, ch, Date.now()) & P.VIEW_CHANNEL)) throw new Error('I cannot see that channel.');
        const { messages } = await this.app.convos.loadChannel(c, ch, Infinity, Math.max(1, Math.min(50, Number(a[2]) || 20)));
        return messages.map((m) => this.msgData(c, m, rt.pub));
      }
      case 'communities':
        return this.communitiesOf(rt.pub).map((x) => this.communityData(x, this.app.convos.community(x)));
      case 'community':
        if (play) return this.communityData(PLAYGROUND, null);
        return this.communityData(c, this.member(rt, c));
      case 'channel': {
        if (play) return this.channelData(PLAYGROUND, null, PLAYGROUND);
        const st = this.member(rt, c);
        const q = str(a[1], 'channel').replace(/^#/, '').toLowerCase();
        const chan = Object.values(st.channels).find((x) => x.type !== 'category' && (x.id === a[1] || x.name.toLowerCase() === q) && channelPerms(st, rt.pub, x.id, Date.now()) & P.VIEW_CHANNEL);
        if (!chan) throw new Error(`There is no channel "${a[1]}" that I can see.`);
        return this.channelData(c, st, chan.id);
      }
      case 'channels': {
        if (play) return [this.channelData(PLAYGROUND, null, PLAYGROUND)];
        const st = this.member(rt, c);
        return Object.values(st.channels)
          .filter((x) => x.type !== 'category' && channelPerms(st, rt.pub, x.id, Date.now()) & P.VIEW_CHANNEL)
          .sort((x, y) => x.pos - y.pos)
          .map((x) => this.channelData(c, st, x.id));
      }
      case 'members': {
        if (play) return [this.userData(PLAYGROUND, this.app.me), this.userData(PLAYGROUND, rt.pub)];
        const st = this.member(rt, c);
        return Object.keys(st.members)
          .slice(0, 5000)
          .map((p) => this.userData(c, p));
      }
      case 'member': {
        const id = str(a[1], 'member');
        if (play) return id === this.app.me || id === rt.pub ? this.userData(PLAYGROUND, id) : null;
        const st = this.member(rt, c);
        const pub = this.findUser(id, c, st);
        return pub ? this.userData(c, pub) : null;
      }
      case 'roles': {
        if (play) return [];
        const st = this.member(rt, c);
        return sortedRoles(st)
          .filter((r) => r.id !== st.id)
          .map((r) => ({ id: r.id, name: r.name, color: r.color, pos: r.pos, mentionable: r.mentionable }));
      }
      case 'status': {
        const last = this.statusAt.get(rt.pub) ?? 0;
        if (Date.now() - last < 20_000) throw new Error('Status can change at most every 20 seconds.');
        this.statusAt.set(rt.pub, Date.now());
        const text = typeof a[0] === 'string' ? a[0].slice(0, 128) : '';
        const emoji = typeof a[1] === 'string' ? a[1].slice(0, 64) : '';
        const rec = this.rec(rt.pub);
        this.resign(rec, { status: text || emoji ? { text: text || undefined, emoji: emoji || undefined, until: null } : null });
        await this.persist();
        return null;
      }
      case 'storage':
        return this.storageCall(rt.pub, String(a[0]), a[1], a[2]);
      default:
        throw new Error(`Unknown call "${method}".`);
    }
  }

  private validate(kind: 'msg' | 'edit', p: Record<string, unknown>) {
    const r = PAYLOADS[kind].safeParse(p);
    if (!r.success) {
      const i = r.error.issues[0];
      throw new Error(`Invalid message: ${i.path.join('.') || 'content'}: ${i.message}`);
    }
    if (kind === 'msg' && !String(p.text ?? '').trim() && !(p.att as unknown[] | undefined)?.length && !(p.embeds as unknown[] | undefined)?.length) throw new Error('Messages need text, an embed or a file.');
    if (canonical(p).length > LIMITS.opBytes - 2048) throw new Error('That message is too big.');
  }

  private emojiOf(e: string) {
    const custom = /^:([a-z0-9_]{2,32}):$/.exec(e);
    if (custom) {
      const hit = this.app.allEmoji().find((x) => x.name === custom[1]);
      if (hit) return hit.token;
    }
    if (!e || e.length > LIMITS.emojiChars) throw new Error('That is not an emoji.');
    return e;
  }

  /** Turn whatever the bot passed into message parts. */
  private async normalize(rt: Runtime, content: unknown) {
    void rt;
    if (typeof content === 'string' || typeof content === 'number' || typeof content === 'boolean') {
      return { text: String(content).slice(0, LIMITS.messageChars), hasText: true, embeds: undefined, buttons: undefined, files: [] as File[] };
    }
    if (!content || typeof content !== 'object') throw new Error('Send text, or an object like { text, embeds, buttons, files }.');
    const o = content as Record<string, unknown>;
    const rawText = o.text ?? o.content;
    const hasText = rawText !== undefined && rawText !== null;
    const text = hasText ? String(rawText).slice(0, LIMITS.messageChars) : '';
    const embedsIn = Array.isArray(o.embeds) ? o.embeds : o.embed ? [o.embed] : undefined;
    const embeds = embedsIn ? embedsIn.slice(0, LIMITS.embedsPerMessage).map((e) => normEmbed(e)) : undefined;
    let buttonsIn = Array.isArray(o.buttons) ? (o.buttons as unknown[]) : undefined;
    if (buttonsIn) buttonsIn = buttonsIn.flat(2);
    const buttons = buttonsIn ? buttonsIn.slice(0, LIMITS.buttonsPerMessage).map((b, i) => normButton(b, i)) : undefined;
    const files: File[] = [];
    if (Array.isArray(o.files)) {
      for (const f of o.files.slice(0, 4)) {
        if (!f || typeof f !== 'object') continue;
        const x = f as { name?: unknown; data?: unknown; type?: unknown };
        const name = String(x.name ?? 'file').slice(0, 255);
        const type = typeof x.type === 'string' ? x.type : guessMime(name);
        let blob: Blob;
        if (x.data instanceof Blob) blob = x.data;
        else if (x.data instanceof ArrayBuffer || ArrayBuffer.isView(x.data)) blob = new Blob([x.data as BlobPart], { type });
        else if (typeof x.data === 'string') blob = new Blob([x.data], { type: type || 'text/plain' });
        else throw new Error(`File "${name}" has no data (use a string, Uint8Array, ArrayBuffer or Blob).`);
        if (blob.size > 8 * 1024 * 1024) throw new Error(`File "${name}" is larger than 8 MB.`);
        files.push(new File([blob], name, { type: type || blob.type }));
      }
    }
    return { text, hasText, embeds, buttons, files };
  }

  /** Embeds may name one of the message's attachments as their image: { image: 'chart.png' }. */
  private embedImages(embeds: Record<string, unknown>[], att: Attachment[]): Embed[] {
    const find = (v: unknown): AssetRef | undefined => {
      if (!v) return undefined;
      const name = typeof v === 'string' ? v : typeof v === 'object' && v && 'file' in v ? String((v as { file: unknown }).file) : '';
      const a = att.find((x) => x.name === name && x.mime.startsWith('image/'));
      if (!a) throw new Error(`Embed image "${name}" must be the name of an image file sent with the same message.`);
      return { hash: a.hash, mime: a.mime, size: a.size, ...(a.w ? { w: a.w } : {}), ...(a.h ? { h: a.h } : {}) };
    };
    return embeds.map((e) => {
      const out = { ...e } as Record<string, unknown>;
      if (e.image !== undefined) out.image = find(e.image);
      if (e.thumb !== undefined) out.thumb = find(e.thumb);
      for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
      return out as Embed;
    });
  }

  private async storageCall(pub: string, op: string, key: unknown, value: unknown) {
    let data = this.storage.get(pub);
    if (!data) {
      data = {};
      const raw = (await this.app.db.get('kv', 'botdata:' + pub))?.v;
      if (typeof raw === 'string') {
        try {
          data = JSON.parse(bytesToUtf8(await aesDecrypt(this.encKey, fromB64(raw)))) as Record<string, unknown>;
        } catch {
          data = {};
        }
      }
      this.storage.set(pub, data);
    }
    const k = String(key ?? '');
    switch (op) {
      case 'get':
        return data[k] === undefined ? undefined : structuredClone(data[k]);
      case 'keys':
        return Object.keys(data);
      case 'delete':
        delete data[k];
        break;
      case 'set': {
        if (!k || k.length > 200) throw new Error('Storage keys are 1 to 200 characters.');
        let json: string;
        try {
          json = JSON.stringify(value);
        } catch {
          throw new Error('Only JSON-compatible values can be stored.');
        }
        if (json === undefined) delete data[k];
        else data[k] = JSON.parse(json);
        if (JSON.stringify(data).length > MAX_STORAGE) {
          delete data[k];
          throw new Error('Bot storage is full (1 MB).');
        }
        break;
      }
      default:
        throw new Error('Unknown storage call.');
    }
    const t = this.storageTimers.get(pub);
    if (t) clearTimeout(t);
    this.storageTimers.set(
      pub,
      setTimeout(async () => {
        this.storageTimers.delete(pub);
        const d = this.storage.get(pub);
        if (!d) return;
        await this.app.db.put('kv', { k: 'botdata:' + pub, v: toB64(await aesEncrypt(this.encKey, utf8ToBytes(JSON.stringify(d)))) });
      }, 400),
    );
    return null;
  }

  async storageSnapshot(pub: string) {
    await this.storageCall(pub, 'keys', '', undefined);
    return structuredClone(this.storage.get(pub) ?? {});
  }

  async clearStorage(pub: string) {
    this.storage.set(pub, {});
    await this.app.db.delete('kv', 'botdata:' + pub);
  }

  // ===========================================================================
  // Test console (nothing leaves this device)
  // ===========================================================================

  private playPush(pub: string, line: PlayLine) {
    set((s) => {
      const cur = s.botPlay[pub] ?? [];
      const next = [...cur, line];
      return { botPlay: { ...s.botPlay, [pub]: next.length > 200 ? next.slice(-200) : next } };
    });
  }

  private playUpdate(pub: string, id: string, fn: (l: PlayLine) => PlayLine | null) {
    set((s) => {
      const cur = s.botPlay[pub] ?? [];
      const next = cur.map((l) => (l.id === id ? fn(l) : l)).filter((l): l is PlayLine => !!l);
      return { botPlay: { ...s.botPlay, [pub]: next } };
    });
  }

  private async playPost(rt: Runtime, content: unknown, reply: string | null) {
    this.limit(rt, 'send:play', 8, 5000);
    const body = await this.normalize(rt, content);
    const files = body.files.map((f) => ({ name: f.name, mime: f.type, url: URL.createObjectURL(f) }));
    const byName = (v: unknown) => {
      const name = typeof v === 'string' ? v : v && typeof v === 'object' && 'file' in v ? String((v as { file: unknown }).file) : '';
      return files.find((f) => f.name === name)?.url;
    };
    const embeds = (body.embeds ?? []).map((e) => {
      const { image, thumb, ...rest } = e;
      const out = { ...rest } as PlayLine['embeds'][number];
      if (image) out.imageUrl = byName(image);
      if (thumb) out.thumbUrl = byName(thumb);
      return out;
    });
    const parsed = PAYLOADS.msg.safeParse({ ch: 'main', text: body.text, ...(embeds.length ? { embeds: embeds.map(({ imageUrl: _i, thumbUrl: _t, ...x }) => x) } : {}), ...(body.buttons?.length ? { buttons: body.buttons } : {}) });
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new Error(`Invalid message: ${i.path.join('.') || 'content'}: ${i.message}`);
    }
    if (!body.text.trim() && !embeds.length && !files.length) throw new Error('Messages need text, an embed or a file.');
    const id = randomHex(32);
    this.playPush(rt.pub, { id, a: rt.pub, text: body.text, embeds, buttons: body.buttons ?? [], files, t: Date.now(), edited: false, reply, reacts: [] });
    return { id, c: PLAYGROUND, ch: PLAYGROUND };
  }

  private async playEdit(rt: Runtime, id: string, content: unknown) {
    const line = (get().botPlay[rt.pub] ?? []).find((l) => l.id === id);
    if (!line) throw new Error('Message not found.');
    if (line.a !== rt.pub) throw new Error('Bots can only edit their own messages.');
    const body = await this.normalize(rt, content);
    this.playUpdate(rt.pub, id, (l) => ({
      ...l,
      text: body.hasText ? body.text : l.text,
      embeds: body.embeds ? (body.embeds as PlayLine['embeds']) : l.embeds,
      buttons: body.buttons ?? l.buttons,
      edited: true,
    }));
    return { id, c: PLAYGROUND, ch: PLAYGROUND };
  }

  private playDelete(rt: Runtime, id: string) {
    this.playUpdate(rt.pub, id, () => null);
    return null;
  }

  private playReact(rt: Runtime, id: string, e: string, on: boolean) {
    this.playUpdate(rt.pub, id, (l) => ({ ...l, reacts: on ? [...new Set([...l.reacts, e])] : l.reacts.filter((x) => x !== e) }));
    return null;
  }

  private playMsgData(rt: Runtime, l: PlayLine) {
    const users = /<@([0-9a-f]{64})>/g;
    const mentions = [...l.text.matchAll(users)].map((m) => m[1]);
    return this.msgData(PLAYGROUND, { id: l.id, ch: PLAYGROUND, a: l.a, t: l.t, text: l.text, reply: l.reply, att: [], embeds: [], mentions: { users: mentions, roles: [], everyone: false, here: false } }, rt.pub);
  }

  /** You typed a message in the Test tab. */
  async playMessage(pub: string, text: string) {
    const rt = this.runtimes.get(pub);
    const id = randomHex(32);
    const line: PlayLine = { id, a: this.app.me, text, embeds: [], buttons: [], files: [], t: Date.now(), edited: false, reply: null, reacts: [] };
    this.playPush(pub, line);
    if (!rt || rt.status === 'crashed') {
      this.log(pub, 'system', 'The bot is not running. Press Run first.');
      return;
    }
    const data = this.playMsgData(rt, line);
    this.emit(rt, 'message', data);
    await this.maybeCommand(rt, PLAYGROUND, null, text, data, PLAYGROUND, id);
  }

  playPress(pub: string, lineId: string, buttonId: string) {
    const rt = this.runtimes.get(pub);
    const line = (get().botPlay[pub] ?? []).find((l) => l.id === lineId);
    if (!rt || !line) return;
    this.emit(rt, 'button', {
      buttonId,
      c: PLAYGROUND,
      ch: PLAYGROUND,
      user: this.userData(PLAYGROUND, this.app.me),
      message: { id: line.id, c: PLAYGROUND, ch: PLAYGROUND, text: line.text, embeds: line.embeds, buttons: line.buttons },
      channel: this.channelData(PLAYGROUND, null, PLAYGROUND),
      community: this.communityData(PLAYGROUND, null),
    });
  }

  playClear(pub: string) {
    for (const l of get().botPlay[pub] ?? []) for (const f of l.files) URL.revokeObjectURL(f.url);
    set((s) => ({ botPlay: { ...s.botPlay, [pub]: [] } }));
  }

  // ===========================================================================
  // "I am running these bots": signed announcements so members see them online
  // ===========================================================================

  scheduleAnnounce() {
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      for (const l of this.app.peers.links.values()) if (l.usable && l.helloReceived) this.announceTo(l);
      this.app.refreshPresence();
    }, 300);
  }

  announcements(forPub: string | null) {
    const out: { card: ProfileCard; ts: number; on: boolean; sig: string }[] = [];
    const ts = Date.now();
    for (const rec of this.records.values()) {
      const comms = this.communitiesOf(rec.pub);
      if (!comms.length) continue;
      if (forPub && !comms.some((c) => !!this.app.convos.community(c)?.members[forPub])) continue;
      const on = this.running(rec.pub);
      out.push({ card: rec.card, ts, on, sig: sign(this.keys(rec.pub), hostMessage(this.app.me, ts, on)) });
    }
    return out;
  }

  announceTo(l: { pub: string; send: (m: Record<string, unknown>) => void }) {
    const list = this.announcements(l.pub);
    if (list.length) l.send({ t: 'bothost', list });
  }

  /** Bots of mine that are running (shown online locally). */
  runningPubs() {
    return [...this.runtimes.values()].filter((r) => r.status === 'running').map((r) => r.pub);
  }
}

export const hostMessage = (host: string, ts: number, on: boolean) => `celchat-bot-host:${host}:${ts}:${on ? 1 : 0}`;

/** Check a peer's claim that it runs a bot right now. */
export function verifyHostClaim(raw: unknown, hostPub: string): { card: ProfileCard; on: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as { card?: unknown; ts?: unknown; on?: unknown; sig?: unknown };
  const card = verifyProfile(x.card);
  if (!card || !card.bot || !card.botInfo?.hosted) return null;
  if (typeof x.ts !== 'number' || Math.abs(Date.now() - x.ts) > 10 * 60_000 || typeof x.sig !== 'string') return null;
  if (!verify(card.pub, hostMessage(hostPub, x.ts, !!x.on), x.sig)) return null;
  return { card, on: !!x.on };
}

export function commandUsage(c: BotCommand) {
  return ['/' + c.name, ...(c.args ?? []).map((a) => (a.optional ? `[${a.name}]` : `<${a.name}>`))].join(' ');
}

function normEmbed(e: unknown): Record<string, unknown> {
  if (!e || typeof e !== 'object') throw new Error('Each embed must be an object like { title, description }.');
  const x = e as Record<string, unknown>;
  const s = (v: unknown, max: number) => (v === undefined || v === null || v === '' ? undefined : String(typeof v === 'object' && v && 'text' in v ? (v as { text: unknown }).text : typeof v === 'object' && v && 'name' in v ? (v as { name: unknown }).name : v).slice(0, max));
  let color = x.color;
  if (typeof color === 'number') color = '#' + (color & 0xffffff).toString(16).padStart(6, '0');
  const ts = x.timestamp === true ? Date.now() : typeof x.timestamp === 'number' ? x.timestamp : x.ts;
  const out: Record<string, unknown> = {
    title: s(x.title, 256),
    url: s(x.url, 500),
    description: s(x.description ?? x.desc ?? x.text, LIMITS.embedChars),
    color: typeof color === 'string' ? color : undefined,
    author: s(x.author, 256),
    footer: s(x.footer, 512),
    ts: typeof ts === 'number' ? Math.floor(ts) : undefined,
    image: x.image,
    thumb: x.thumb ?? x.thumbnail,
  };
  if (Array.isArray(x.fields)) out.fields = x.fields.slice(0, 25).map((f) => ({ name: String((f as { name?: unknown })?.name ?? '').slice(0, 256) || '​', value: String((f as { value?: unknown })?.value ?? '').slice(0, 1024) || '​', ...((f as { inline?: unknown })?.inline ? { inline: true } : {}) }));
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function normButton(b: unknown, i: number): MsgButton {
  if (!b || typeof b !== 'object') throw new Error('Each button must be an object like { id, label, style }.');
  const x = b as Record<string, unknown>;
  const url = typeof x.url === 'string' ? x.url : undefined;
  const style = (url ? 'link' : typeof x.style === 'string' ? x.style : 'secondary') as MsgButton['style'];
  const out: Record<string, unknown> = { id: x.id === undefined ? (url ? `link-${i}` : '') : String(x.id), label: String(x.label ?? '').slice(0, 80), style };
  if (typeof x.emoji === 'string' && x.emoji) out.emoji = x.emoji;
  if (url) out.url = url;
  if (x.disabled) out.disabled = true;
  if (!out.id) throw new Error('Buttons need an id (it tells you which one was pressed).');
  return out as MsgButton;
}

function guessMime(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', txt: 'text/plain', json: 'application/json', csv: 'text/csv', md: 'text/markdown', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

function randomAlnum(n: number) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

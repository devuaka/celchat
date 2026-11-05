/**
 * CelApp wires everything together: hub topics -> peer links -> sync, the
 * mailbox, friends, presence, unread/notifications, voice and calls. The UI
 * talks to this object and renders from the zustand store it keeps updated.
 */
import { openAccountDb, type AccountDb, type ConvoRecord, type FriendRecord, type NotifyLevel, type StoredOp } from './db';
import { Convos } from './convos';
import { HubClient, defaultHubUrl, type HubLike } from './hub';
import { MqttHub, PUBLIC_BROKERS } from './mqtthub';
import { PeerManager } from './peers';
import { Sync, type Eph } from './sync';
import { Files } from './files';
import { Voice, type VoiceRoom } from './voice';
import { mergeSettings, type Settings } from './settings';
import { applyTheme, defaultTheme, normalizeTheme, registerCustomFont, sniffFont, type Theme } from './theme';
import { probe } from './media';
import { sounds, desktopNotify, startRinging, stopRinging, setBadge } from './notify';
import { cleanOp, verifyOpFast } from './verify';
import { signOut, updateAccountLabel, type Session } from './identity';
import { set, get, chanKey, toast, type View, type CallInfo, type Bookmark, type Scheduled } from '../state/store';
import { aesDecrypt, aesEncrypt, pairKey, sealSigned, sha256Bytes, sha256Hex, sign, unsealSigned, type Keys } from '@shared/crypto';
import { bytesToHex, concatBytes, fromB64, isHex, randomHex, toB64, utf8ToBytes, bytesToUtf8 } from '@shared/bytes';
import { signProfile, verifyProfile, defaultProfile, type ProfileCard, type ProfileDraft } from '@shared/profile';
import { dmId, type Attachment, type AssetRef, type Op } from '@shared/ops';
import { channelPerms, parseMentions, type CommunityState, type Message, type GroupState } from '@shared/engine';
import { P } from '@shared/perms';
import { assetAuthMessage, sniffImage, type Presence } from '@shared/protocol';
import { gifUrl, normalizeGifs, isGifMediaHost, GIF_MAX_SEND_BYTES, type GifPage, type GifProvider, type GifResult } from '@shared/gifs';
import { LIMITS } from '@shared/limits';

type TopicMeta =
  | { kind: 'community'; c: string }
  | { kind: 'pair'; pub: string }
  | { kind: 'group'; c: string }
  | { kind: 'self' }
  | { kind: 'voice'; c: string; ch: string }
  | { kind: 'call'; callId: string; c: string };

const RANK: Record<Presence, number> = { online: 3, dnd: 2, idle: 1, invisible: 0 };
const GOSSIP_DEGREE = 6;

export interface ChannelRef {
  c: string;
  ch: string;
}

export class CelApp {
  keys: Keys;
  dv: string;
  me: string;
  db!: AccountDb;
  convos!: Convos;
  hub!: HubLike;
  peers!: PeerManager;
  sync!: Sync;
  files!: Files;
  voice!: Voice;
  settings!: Settings;
  myCard!: ProfileCard;
  profiles = new Map<string, ProfileCard>();
  friends = new Map<string, FriendRecord>();
  private topicMeta = new Map<string, TopicMeta>();
  private topicPeers = new Map<string, Map<string, Presence>>();
  private typingSent = new Map<string, number>();
  private mailSeen = new Set<string>();
  private outbox: { to: string; body: unknown }[] = [];
  private joining = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private desireTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private vaultTimer: ReturnType<typeof setTimeout> | null = null;
  private linksTimer: ReturnType<typeof setTimeout> | null = null;
  private requestedProfiles = new Map<string, number>();
  private callTimeout: ReturnType<typeof setTimeout> | null = null;
  private callHadPeer = false;
  private pendingReceipts = new Map<string, number>();

  constructor(readonly session: Session) {
    this.keys = session.keys;
    this.dv = session.dv;
    this.me = session.keys.pub;
  }

  // ===========================================================================
  // Boot
  // ===========================================================================

  async init() {
    this.db = await openAccountDb(this.me);
    this.settings = mergeSettings((await this.db.get('kv', 'settings'))?.v);
    const theme = normalizeTheme((await this.db.get('kv', 'theme'))?.v) ?? defaultTheme();
    const saved = ((await this.db.get('kv', 'themes'))?.v as unknown[] | undefined)?.map(normalizeTheme).filter((t): t is Theme => !!t) ?? [];
    this.outbox = ((await this.db.get('kv', 'outbox'))?.v as { to: string; body: unknown }[] | undefined) ?? [];

    for (const p of await this.db.getAll('profiles')) {
      const card = verifyProfile({ ...p, seenAt: undefined });
      if (card) this.profiles.set(card.pub, card);
    }
    const stored = (await this.db.get('kv', 'profile'))?.v;
    const mine = stored ? verifyProfile(stored) : null;
    if (mine && mine.pub === this.me) this.myCard = mine;
    else {
      const draft = defaultProfile(this.session.account.username, this.session.account.createdAt);
      draft.displayName = this.session.account.displayName;
      this.myCard = signProfile(this.keys, draft);
      await this.db.put('kv', { k: 'profile', v: this.myCard });
    }
    this.profiles.set(this.me, this.myCard);
    for (const f of await this.db.getAll('friends')) this.friends.set(f.pub, f);

    this.convos = new Convos(this.db, this.keys, this.dv);
    await this.convos.load();

    this.hub = makeHub(this.settings.hubUrl, this.keys, this.dv, this.settings.status);
    this.peers = new PeerManager(this.keys, this.hub);
    this.applyNetworkSettings();
    this.sync = new Sync(this.keys, this.peers, this.convos);
    this.sync.myCard = () => this.myCard;
    this.sync.invisible = () => this.settings.status === 'invisible';
    this.sync.profileOf = (pub) => this.profiles.get(pub) ?? null;
    this.sync.prepare = (raws) => this.prepareUnknown(raws);
    this.files = new Files(this.db, this.peers);
    this.files.maxBytes = this.settings.media.maxFileMB * 1024 * 1024;
    this.voice = new Voice(this.peers);
    this.voice.settings = { ...this.settings.voice };
    this.voice.forceMuted = (pub) => this.isForceMuted(pub);

    // custom fonts
    const fonts = ((await this.db.get('kv', 'fonts'))?.v as { hash: string; label: string }[] | undefined) ?? [];
    const customFonts: { key: string; label: string; hash: string }[] = [];
    for (const f of fonts) {
      const blob = await this.files.getBlob(f.hash);
      if (!blob) continue;
      try {
        customFonts.push({ key: await registerCustomFont(f.hash, f.label, blob), label: f.label, hash: f.hash });
      } catch {
        /* broken font */
      }
    }

    this.wire();
    set({
      me: this.me,
      myCard: this.myCard,
      profiles: Object.fromEntries(this.profiles),
      friends: Object.fromEntries(this.friends),
      settings: this.settings,
      theme,
      savedThemes: saved,
      customFonts,
      convos: Object.fromEntries(this.convos.list().map((x) => [x.rec.c, { ...x.rec }])),
      states: Object.fromEntries(this.convos.list().map((x) => [x.rec.c, x.eng.state])),
    });
    applyTheme(theme);
    await this.loadChatBgUrl(theme);
    set({
      bookmarks: ((await this.db.get('kv', 'bookmarks'))?.v as Bookmark[] | undefined) ?? [],
      scheduled: ((await this.db.get('kv', 'scheduled'))?.v as Scheduled[] | undefined) ?? [],
    });
    this.refreshTopics();
    this.hub.connect();
    void this.computeUnread();

    this.timers.push(setInterval(() => this.tick(), 5000));
    this.timers.push(setInterval(() => this.voiceHeartbeat(), 25_000));
    void navigator.storage?.persist?.();
  }

  dispose() {
    for (const t of this.timers) clearInterval(t);
    this.voice?.leave();
    this.peers?.closeAll();
    this.hub?.close();
    this.db?.close();
  }

  async logout() {
    this.dispose();
    await signOut(this.me);
    location.hash = '';
    location.reload();
  }

  private applyNetworkSettings() {
    this.peers.policy = this.settings.privacy.direct;
    this.peers.allowRelay = this.settings.privacy.relay;
    this.peers.accept = (pub) => this.friends.get(pub)?.state !== 'blocked';
    this.peers.isFriend = (pub) => pub === this.me || this.friends.get(pub)?.state === 'friend';
    this.peers.knows = (pub) => this.knows(pub);
    this.peers.relayOnlyKey = (pub) => this.profiles.get(pub)?.bot === true;
  }

  isBot(pub: string) {
    return this.profiles.get(pub)?.bot === true;
  }

  /** Someone we share a conversation (or a community topic) with. */
  knows(pub: string): boolean {
    if (pub === this.me) return true;
    for (const x of this.convos.list()) {
      if (x.rec.type === 'dm' && x.rec.peer === pub) return true;
      if (x.eng.state?.members[pub]) return true;
    }
    for (const [t, peers] of this.topicPeers) {
      const meta = this.topicMeta.get(t);
      if (meta?.kind !== 'community') continue;
      for (const addr of peers.keys()) if (addr.startsWith(pub)) return true;
    }
    return false;
  }

  private wire() {
    const { hub, peers, sync, convos, files, voice } = this;
    hub.on('state', (s) => set({ hub: { state: s, info: hub.info } }));
    hub.on('ready', () => this.onHubReady());
    hub.on('topic', (id, list) => {
      const m = new Map<string, Presence>();
      for (const p of list) m.set(`${p.pub}:${p.dv}`, p.st);
      this.topicPeers.set(id, m);
      this.onTopicChange(id);
    });
    hub.on('tj', (id, p) => {
      let m = this.topicPeers.get(id);
      if (!m) this.topicPeers.set(id, (m = new Map()));
      m.set(`${p.pub}:${p.dv}`, p.st);
      this.onTopicChange(id, `${p.pub}:${p.dv}`, 'join');
    });
    hub.on('tl', (id, pub, dv) => {
      const addr = `${pub}:${dv}`;
      this.topicPeers.get(id)?.delete(addr);
      // The hub saw that device go away. Unless it is still visible elsewhere, its link is dead
      // (WebRTC can take ~30s to notice on its own, and we must not send DMs into a dead link).
      let seen = false;
      for (const m of this.topicPeers.values()) if (m.has(addr)) seen = true;
      if (!seen) this.peers.links.get(addr)?.close(false);
      this.onTopicChange(id, addr, 'leave');
    });
    hub.on('ts', (id, p) => {
      this.topicPeers.get(id)?.set(`${p.pub}:${p.dv}`, p.st);
      this.schedulePresence();
    });
    hub.on('mail', (items) => void this.onMail(items));
    hub.on('replaced', () => toast('CelChat was opened somewhere else with this device id. This tab is now offline.', 'error'));
    hub.on('err', (e) => {
      if (e.code === 'rate') console.warn('[hub] rate limited', e.msg);
    });

    peers.on('open', () => this.scheduleLinks());
    peers.on('close', () => {
      this.scheduleLinks();
      this.scheduleDesires();
    });
    peers.on('state', () => this.scheduleLinks());
    peers.on('app', (from, d) => this.onAppSignal(from, d));

    sync.on('hello', (l, card) => {
      if (card) this.upsertProfile(card);
      if (this.friends.get(l.pub)?.state === 'friend' && this.settings.privacy.shareFriends) {
        l.send({ t: 'fshare', list: [...this.friends.values()].filter((f) => f.state === 'friend').map((f) => f.pub) });
      }
      this.scheduleLinks();
      // DM read receipts queued while they were offline
      for (const [c, lam] of this.pendingReceipts) {
        const rec = this.convos.get(c)?.rec;
        if (rec?.peer === l.pub) {
          l.send({ t: 'rcpt', c, l: lam });
          this.pendingReceipts.delete(c);
        }
      }
    });
    sync.on('profile', (card) => this.upsertProfile(card));
    sync.on('eph', (e) => this.onEph(e));
    sync.on('receipt', (c, pub, l) => {
      const rec = this.convos.get(c)?.rec;
      if (rec?.type === 'dm' && rec.peer === pub) set((s) => ({ receipts: { ...s.receipts, [c]: Math.max(s.receipts[c] ?? 0, l) } }));
    });
    sync.on('friends', (pub, list) => {
      const f = this.friends.get(pub);
      if (f?.state === 'friend') {
        f.friendsOf = list;
        void this.db.put('friends', f);
        set({ friends: Object.fromEntries(this.friends) });
      }
    });
    sync.on('synced', (c) => this.maybeJoin(c));
    sync.on('denied', (c, _l, why) => {
      const rec = this.convos.get(c)?.rec;
      if (rec?.joinCode && why !== 'not a member') {
        if (why === 'banned') toast('You are banned from that community.', 'error');
        else if (why === 'invite required') toast('That invite is invalid, expired or used up.', 'error');
      }
    });

    convos.on('changed', (c) => this.onConvoChanged(c));
    convos.on('ops', (c, ops) => void this.onOps(c, ops));
    convos.on('retro', (c) => this.reloadLoaded(c));
    convos.on('removed', (c) => {
      set((s) => {
        const convosS = { ...s.convos };
        const states = { ...s.states };
        delete convosS[c];
        delete states[c];
        return { convos: convosS, states };
      });
      this.refreshTopics();
    });

    let tTimer: ReturnType<typeof setTimeout> | null = null;
    files.on('progress', (t) => {
      const snap = { ...t, chunks: undefined, waiters: undefined, sources: undefined, tried: undefined, timer: undefined } as never;
      set((s) => ({ transfers: { ...s.transfers, [t.hash]: snap } }));
      if (!tTimer) tTimer = setTimeout(() => (tTimer = null), 100);
    });
    files.on('done', (hash) => void this.publishUrl(hash));

    voice.on('change', () => this.onVoiceChange());
    voice.on('error', (msg) => toast(msg, 'error'));

    // say goodbye right away instead of letting peers time us out (matters most in serverless mode)
    window.addEventListener('pagehide', () => this.hub.close());
    const onFocus = () => this.markViewRead();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
  }

  private tick() {
    void this.runTimers();
    // expire typing + stale voice presence
    const now = Date.now();
    const s = get();
    let typingChanged = false;
    const typing: typeof s.typing = {};
    for (const [k, v] of Object.entries(s.typing)) {
      const keep: Record<string, number> = {};
      for (const [pub, exp] of Object.entries(v)) if (exp > now) keep[pub] = exp;
      else typingChanged = true;
      if (Object.keys(keep).length) typing[k] = keep;
    }
    if (typingChanged) set({ typing });
    let vrChanged = false;
    const vr: typeof s.voiceRooms = {};
    for (const [k, v] of Object.entries(s.voiceRooms)) {
      const keep: typeof v = {};
      for (const [pub, st] of Object.entries(v)) {
        if (pub === this.me || now - st.at < 70_000) keep[pub] = st;
        else vrChanged = true;
      }
      if (Object.keys(keep).length) vr[k] = keep;
    }
    if (vrChanged) set({ voiceRooms: vr });
  }

  // ===========================================================================
  // Hub, topics, presence, peer selection
  // ===========================================================================

  private async onHubReady() {
    set({ hub: { state: 'online', info: this.hub.info } });
    this.hub.fetchMail();
    if (this.hub.info?.features.directory) void this.hub.dirPut(this.myCard).catch((e) => console.warn('[dir]', e.message));
    void this.uploadPublic(this.myCard.avatar);
    void this.uploadPublic(this.myCard.banner);
    const outbox = this.outbox.splice(0);
    for (const o of outbox) await this.sendMail(o.to, o.body);
    await this.saveOutbox();
    const restored = (await this.db.get('kv', 'vaultChecked'))?.v;
    if (!restored) void this.restoreVault();
  }

  topicOf = {
    community: (c: string) => sha256Hex('cc:' + c),
    pair: (pub: string) => sha256Hex('pair:' + bytesToHex(pairKey(this.keys, pub, 'presence/v1'))),
    group: (c: string) => sha256Hex('gr:' + c),
    self: () => sha256Hex('self:' + bytesToHex(sha256Bytes(concatBytes(this.keys.seed, utf8ToBytes('self/v1'))))),
    voice: (c: string, ch: string) => sha256Hex('vc:' + c + ':' + ch),
    call: (id: string) => sha256Hex('call:' + id),
  };

  refreshTopics() {
    const want = new Map<string, TopicMeta>();
    want.set(this.topicOf.self(), { kind: 'self' });
    for (const x of this.convos.list()) {
      const { rec } = x;
      if (rec.type === 'community' && (!rec.left || rec.joinCode)) want.set(this.topicOf.community(rec.c), { kind: 'community', c: rec.c });
      if (rec.type === 'group' && !rec.left && x.eng.state?.members[this.me]) want.set(this.topicOf.group(rec.c), { kind: 'group', c: rec.c });
      if (rec.type === 'dm' && rec.peer && this.friends.get(rec.peer)?.state !== 'blocked') want.set(this.topicOf.pair(rec.peer), { kind: 'pair', pub: rec.peer });
    }
    for (const f of this.friends.values()) if (f.state === 'friend') want.set(this.topicOf.pair(f.pub), { kind: 'pair', pub: f.pub });
    const room = this.voice?.room;
    if (room) want.set(room.topic, room.kind === 'call' ? { kind: 'call', callId: room.callId!, c: room.c } : { kind: 'voice', c: room.c, ch: room.ch });
    const gone: string[] = [];
    for (const id of this.topicMeta.keys()) if (!want.has(id)) gone.push(id);
    const fresh: string[] = [];
    for (const id of want.keys()) if (!this.topicMeta.has(id)) fresh.push(id);
    this.topicMeta = want;
    for (const id of gone) this.topicPeers.delete(id);
    this.hub?.unsub(gone);
    const keys: Record<string, Uint8Array> = {};
    for (const id of fresh) keys[id] = this.topicKey(want.get(id)!);
    this.hub?.sub(fresh, keys);
    this.schedulePresence();
  }

  /**
   * Encryption key for a presence topic in serverless mode. It is derived from the same secret as
   * the topic id but with a different label, so seeing a topic id on a public broker is not enough
   * to read who is in it.
   */
  private topicKey(meta: TopicMeta): Uint8Array {
    switch (meta.kind) {
      case 'community':
        return sha256Bytes('cck/v1:' + meta.c);
      case 'pair':
        return pairKey(this.keys, meta.pub, 'presence-key/v1');
      case 'group':
        return sha256Bytes('grk/v1:' + meta.c);
      case 'self':
        return sha256Bytes(concatBytes(this.keys.seed, utf8ToBytes('self-key/v1')));
      case 'voice':
        return sha256Bytes('vck/v1:' + meta.c + ':' + meta.ch);
      case 'call':
        return sha256Bytes('callk/v1:' + meta.callId);
    }
  }

  private onTopicChange(id: string, addr?: string, what?: 'join' | 'leave') {
    const meta = this.topicMeta.get(id);
    if (!meta) return;
    this.schedulePresence();
    if (meta.kind === 'voice' || meta.kind === 'call') {
      const room = this.voice.room;
      if (room && room.topic === id) {
        const addrs = [...(this.topicPeers.get(id)?.keys() ?? [])];
        this.voice.setParticipants(addrs);
        if (addr && addr !== this.hub.addr && this.settings.notify.sounds) {
          if (what === 'join') sounds.join();
          if (what === 'leave') sounds.leave();
        }
        if (meta.kind === 'call') this.onCallRoomChange(addrs);
      }
      return;
    }
    this.scheduleDesires();
  }

  private schedulePresence() {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      const out: Record<string, Presence> = {};
      for (const [id, peers] of this.topicPeers) {
        const meta = this.topicMeta.get(id);
        if (!meta || meta.kind === 'voice' || meta.kind === 'call') continue;
        for (const [addr, st] of peers) {
          const pub = addr.slice(0, 64);
          if (!out[pub] || RANK[st] > RANK[out[pub]]) out[pub] = st;
        }
      }
      out[this.me] = this.settings.status;
      set({ presence: out });
    }, 150);
  }

  private scheduleDesires() {
    if (this.desireTimer) return;
    this.desireTimer = setTimeout(() => {
      this.desireTimer = null;
      this.desires();
    }, 250);
  }

  /** Decide which devices we keep links to. */
  private desires() {
    if (this.hub.state !== 'online') return;
    const myAddr = this.hub.addr;
    for (const [id, meta] of this.topicMeta) {
      const addrs = [...(this.topicPeers.get(id)?.keys() ?? [])].filter((a) => a !== myAddr);
      if (meta.kind === 'self') for (const a of addrs) this.peers.connect(a, 'self');
      else if (meta.kind === 'pair') for (const a of addrs) this.peers.connect(a, 'pair');
      else if (meta.kind === 'group') for (const a of addrs) this.peers.connect(a, 'g:' + meta.c);
      else if (meta.kind === 'community') {
        const purpose = 'c:' + meta.c;
        this.wantProfiles([...new Set(addrs.map((a) => a.slice(0, 64)))]);
        // Archive peers hold the full history: always keep a link to them (over the relay).
        for (const a of addrs) {
          if (!this.isBot(a.slice(0, 64))) continue;
          const l = this.peers.connect(a, purpose);
          if (l?.usable && l.helloReceived) void this.sync.requestSync(meta.c, l);
        }
        const linked = addrs.filter((a) => this.peers.links.get(a)?.purposes.has(purpose) && !this.isBot(a.slice(0, 64)));
        const need = GOSSIP_DEGREE - linked.length;
        if (need <= 0) continue;
        const rest = addrs
          .filter((a) => !linked.includes(a) && !this.isBot(a.slice(0, 64)))
          .map((a) => ({ a, score: (this.friends.get(a.slice(0, 64))?.state === 'friend' ? 2 : 0) + (this.peers.links.get(a)?.usable ? 1 : 0) + Math.random() }))
          .sort((x, y) => y.score - x.score)
          .slice(0, need);
        for (const { a } of rest) {
          const l = this.peers.connect(a, purpose);
          if (l?.usable && l.helloReceived) void this.sync.requestSync(meta.c, l);
        }
      }
    }
  }

  private scheduleLinks() {
    if (this.linksTimer) return;
    this.linksTimer = setTimeout(() => {
      this.linksTimer = null;
      set({
        links: [...this.peers.links.values()].map((l) => ({ addr: l.addr, pub: l.pub, state: l.state, rtt: l.rtt, purposes: [...l.purposes] })),
      });
    }, 300);
  }

  setStatus(st: Presence) {
    this.settings.status = st;
    this.hub.setStatus(st);
    void this.saveSettings(this.settings);
    this.schedulePresence();
  }

  // ===========================================================================
  // Profiles
  // ===========================================================================

  upsertProfile(card: ProfileCard) {
    if (card.pub === this.me) return;
    const have = this.profiles.get(card.pub);
    if (have && have.updatedAt >= card.updatedAt) return;
    this.profiles.set(card.pub, card);
    void this.db.put('profiles', { ...card, seenAt: Date.now() });
    set((s) => ({ profiles: { ...s.profiles, [card.pub]: card } }));
  }

  /** Ask peers (and the directory) for profiles we have not seen. */
  wantProfiles(pubs: string[]) {
    const now = Date.now();
    const missing = pubs.filter((p) => p !== this.me && !this.profiles.has(p) && now - (this.requestedProfiles.get(p) ?? 0) > 30_000);
    if (!missing.length) return;
    for (const p of missing) this.requestedProfiles.set(p, now);
    this.sync.requestProfiles(missing.slice(0, 100));
    if (this.hub.state === 'online' && this.hub.info?.features.directory) {
      for (const p of missing.slice(0, 20)) {
        void this.hub
          .dirGet(p)
          .then((raw) => {
            const card = raw ? verifyProfile(raw) : null;
            if (card && card.pub === p) this.upsertProfile(card);
          })
          .catch(() => undefined);
      }
    }
  }

  async saveProfile(draft: ProfileDraft, media: { avatar?: Blob | null; banner?: Blob | null } = {}) {
    const next: ProfileDraft = { ...draft };
    if (media.avatar !== undefined) next.avatar = media.avatar ? await this.storeImage(media.avatar, 'avatar') : null;
    if (media.banner !== undefined) next.banner = media.banner ? await this.storeImage(media.banner, 'banner') : null;
    const card = signProfile(this.keys, next);
    if (card.username !== this.myCard.username && this.hub.state === 'online' && this.hub.info?.features.directory) {
      await this.hub.dirPut(card); // throws if taken
    } else if (this.hub.state === 'online' && this.hub.info?.features.directory) {
      void this.hub.dirPut(card).catch(() => undefined);
    }
    this.myCard = card;
    await this.db.put('kv', { k: 'profile', v: card });
    this.profiles.set(this.me, card);
    set((s) => ({ myCard: card, profiles: { ...s.profiles, [this.me]: card } }));
    this.sync.broadcastProfile(card);
    void this.uploadPublic(card.avatar);
    void this.uploadPublic(card.banner);
    await updateAccountLabel(this.me, card.username, card.displayName);
    this.scheduleVault();
    return card;
  }

  async storeImage(blob: Blob, name: string): Promise<AssetRef> {
    const ref = await this.files.put(blob, name, blob.type);
    const pr = await probe(blob);
    await this.publishUrl(ref.hash);
    return { hash: ref.hash, mime: ref.mime, size: ref.size, w: pr.w, h: pr.h };
  }

  /** Copy a public image (avatar, banner, community icon) to the hub's optional cache. */
  async uploadPublic(ref: AssetRef | null | undefined) {
    if (!ref || !this.settings.media.publicAssetCache || !this.hub.info?.features.assets || this.hub.state !== 'online') return;
    const blob = await this.files.getBlob(ref.hash);
    if (!blob || blob.size > (this.hub.info.limits.assetBytes ?? 0)) return;
    const ts = Date.now();
    try {
      await fetch(`${this.hub.httpBase}/api/assets/${ref.hash}`, {
        method: 'PUT',
        body: blob,
        headers: { 'x-cel-pub': this.me, 'x-cel-ts': String(ts), 'x-cel-sig': sign(this.keys, assetAuthMessage(ref.hash, ts)) },
      });
    } catch {
      /* cache is optional */
    }
  }

  // ===========================================================================
  // Blobs for the UI
  // ===========================================================================

  private async publishUrl(hash: string) {
    const url = await this.files.url(hash);
    if (url) set((s) => (s.blobUrls[hash] === url ? s : { blobUrls: { ...s.blobUrls, [hash]: url } }));
  }

  /** Make a file available to the UI, downloading it from peers if allowed. */
  async ensureBlob(ref: AssetRef & { name?: string }, ctx: { c?: string; owner?: string; auto?: boolean; publicAsset?: boolean }) {
    if (get().blobUrls[ref.hash]) return true;
    if (await this.files.has(ref.hash)) {
      await this.publishUrl(ref.hash);
      return true;
    }
    if (!ctx.auto) return false;
    const sources = () => {
      const out: string[] = [];
      const links = [...this.peers.links.values()].filter((l) => l.usable);
      if (ctx.owner) for (const l of links) if (l.pub === ctx.owner) out.push(l.addr);
      for (const l of links) {
        if (out.includes(l.addr)) continue;
        if (!ctx.c || ctx.publicAsset || this.sync.shares(ctx.c, l.pub, l)) out.push(l.addr);
      }
      return out;
    };
    const publicUrl = ctx.publicAsset && this.hub.info?.features.assets ? `${this.hub.httpBase}/api/assets/${ref.hash}` : undefined;
    const ok = await this.files.fetch(ref, sources, publicUrl);
    if (ok) await this.publishUrl(ref.hash);
    return ok;
  }

  // ===========================================================================
  // Conversations: changes, unread, notifications
  // ===========================================================================

  private onConvoChanged(c: string) {
    const x = this.convos.get(c);
    if (!x) return;
    set((s) => ({ convos: { ...s.convos, [c]: { ...x.rec } }, states: { ...s.states, [c]: x.eng.state } }));
    this.refreshTopics();
    this.maybeJoin(c);
    this.voice.refreshForced();
    const pj = get().pendingJoin;
    const st = x.eng.state;
    if (pj && st?.kind === 'community' && st.members[this.me] && pj.link.includes(c)) {
      set({ pendingJoin: null });
      this.navigate({ kind: 'community', c, ch: null });
      toast(`Joined ${st.name}`, 'success');
    }
    this.scheduleVault();
  }

  private maybeJoin(c: string) {
    const x = this.convos.get(c);
    if (!x || !x.rec.joinCode || this.joining.has(c)) return;
    const st = x.eng.state as CommunityState | null;
    if (!st) return;
    if (st.members[this.me]) return;
    if (st.bans[this.me]) {
      toast(`You are banned from ${st.name}.`, 'error');
      delete x.rec.joinCode;
      void this.convos.saveRec(x.rec);
      return;
    }
    this.joining.add(c);
    void this.author(c, 'join', { code: x.rec.joinCode })
      .catch((e) => toast('Join failed: ' + e.message, 'error'))
      .finally(() => setTimeout(() => this.joining.delete(c), 5000));
  }

  private async onOps(c: string, ops: StoredOp[]) {
    const x = this.convos.get(c);
    if (!x) return;
    const s = get();
    const targets = new Set<string>();
    for (const op of ops) {
      if (op.k === 'msg') await this.onNewMessage(c, op);
      else if (op.tgt) targets.add(op.tgt);
    }
    // re-materialize targeted messages that are on screen
    for (const id of targets) {
      for (const [key, chs] of Object.entries(get().chans)) {
        if (!key.startsWith(c + '|') || !chs.loaded) continue;
        if (!chs.list.some((m) => m.id === id)) continue;
        const m = await this.convos.getMessage(c, id);
        set((st) => {
          const cur = st.chans[key];
          if (!cur) return st;
          const list = m && !m.deleted ? cur.list.map((old) => (old.id === id ? m : old)) : cur.list.filter((old) => old.id !== id);
          return { chans: { ...st.chans, [key]: { ...cur, list } } };
        });
      }
    }
    void s;
  }

  private async onNewMessage(c: string, op: StoredOp) {
    const x = this.convos.get(c)!;
    const m = await this.convos.materialize(x, op);
    if (!m || m.deleted) return;
    const key = chanKey(c, m.ch);
    const cs = get().chans[key];
    // also while the first page is still loading: loadChannel merges with what is already listed
    if (cs?.loaded || cs?.loading) {
      set((st) => {
        const cur = st.chans[key];
        if (!cur || cur.list.some((o) => o.id === m.id)) return st;
        const list = [...cur.list, m].sort((a, b) => a.l - b.l || (a.id < b.id ? -1 : 1));
        return { chans: { ...st.chans, [key]: { ...cur, list: list.length > 400 ? list.slice(-400) : list } } };
      });
    }
    // clear typing indicator for the author
    const ty = get().typing[key];
    if (ty?.[m.a]) {
      const next = { ...ty };
      delete next[m.a];
      set((st) => ({ typing: { ...st.typing, [key]: next } }));
    }
    if (m.a === this.me) {
      void this.convos.setRead(c, m.ch, m.l);
      return;
    }
    if (this.friends.get(m.a)?.state === 'blocked') return;
    const live = op.rcv - op.t < 5 * 60_000;
    const v = get().view;
    const viewing = ((v.kind === 'community' && v.c === c && v.ch === m.ch) || (v.kind === 'dm' && v.c === c)) && document.hasFocus() && !document.hidden;
    const tts = this.settings.chat.tts;
    if (live && tts !== 'off' && this.settings.status !== 'dnd') {
      const open = (v.kind === 'community' && v.c === c && v.ch === m.ch) || (v.kind === 'dm' && v.c === c);
      if ((tts === 'all' && open) || (x.rec.type === 'community' && (await this.pingsMe(x.rec, m)))) this.readAloud(m);
    }
    if (viewing) {
      void this.markRead(c, m.ch, m.l);
      return;
    }
    if ((x.rec.read[m.ch] ?? 0) >= m.l) return;
    const pings = await this.pingsMe(x.rec, m);
    set((st) => {
      const cur = st.unread[key] ?? { u: false, m: 0 };
      return { unread: { ...st.unread, [key]: { u: true, m: cur.m + (pings ? 1 : 0) } } };
    });
    this.updateBadge();
    if (!live) return;
    const level = this.levelFor(x.rec, m.ch);
    const muted = x.rec.muted || !!x.rec.chans[m.ch]?.muted;
    if (level === 'none' || (muted && !pings) || (level === 'mentions' && !pings)) return;
    if (this.settings.status === 'dnd') return;
    if (this.settings.notify.sounds) (pings ? sounds.mention : sounds.message)();
    if (this.settings.notify.desktop) {
      const who = this.nameOf(m.a, c);
      const st = x.eng.state;
      const where = st?.kind === 'community' ? `${st.name} #${st.channels[m.ch]?.name ?? ''}` : st?.kind === 'group' ? st.name || 'Group' : '';
      const body = m.text ? this.plainText(m.text, c) : m.att.length ? `sent ${m.att.length} attachment${m.att.length > 1 ? 's' : ''}` : '';
      const avatar = this.profiles.get(m.a)?.avatar;
      desktopNotify(where ? `${who} (${where})` : who, body, avatar ? get().blobUrls[avatar.hash] ?? null : null, () => {
        this.navigate(x.rec.type === 'community' ? { kind: 'community', c, ch: m.ch } : { kind: 'dm', c });
      }, c + m.ch);
    }
  }

  levelFor(rec: ConvoRecord, ch: string): NotifyLevel {
    const chLevel = rec.chans[ch]?.notify;
    if (chLevel && chLevel !== 'default') return chLevel;
    if (rec.notify !== 'default') return rec.notify;
    if (rec.type !== 'community') return 'all';
    return this.settings.notify.level;
  }

  async pingsMe(rec: ConvoRecord, m: Message): Promise<boolean> {
    if (rec.type !== 'community') return true;
    if (m.mentions.users.includes(this.me)) return true;
    if (m.canPingAll && (m.mentions.everyone || (m.mentions.here && this.settings.status !== 'invisible'))) return true;
    const st = this.convos.community(rec.c);
    if (st && m.mentions.roles.some((r) => st.members[this.me]?.roles.includes(r))) return true;
    if (m.reply) {
      const op = await this.convos.getOp(m.reply);
      if (op && op.a === this.me) return true;
    }
    return false;
  }

  private updateBadge() {
    const s = get();
    let mentions = 0;
    let unread = false;
    for (const [key, u] of Object.entries(s.unread)) {
      const c = key.split('|')[0];
      const rec = s.convos[c];
      if (!rec) continue;
      mentions += u.m;
      if (u.u && !rec.muted) unread = true;
    }
    setBadge(mentions, unread);
  }

  /** Initial unread state from read markers. */
  async computeUnread() {
    const unread: Record<string, { u: boolean; m: number }> = {};
    for (const x of this.convos.list()) {
      const st = x.eng.state;
      const chans = st?.kind === 'community' ? Object.values(st.channels).filter((ch) => ch.type === 'text').map((ch) => ch.id) : ['main'];
      for (const ch of chans) {
        const mark = x.rec.read[ch] ?? 0;
        const last = await this.convos.lastInChannel(x.rec.c, ch);
        if (!last || last.l <= mark) continue;
        const after = await this.convos.after(x.rec.c, ch, mark, 100);
        const others = after.filter((o) => o.a !== this.me && this.friends.get(o.a)?.state !== 'blocked');
        if (!others.length) continue;
        let m = 0;
        for (const op of others) {
          const text = (op.p as { text?: string } | undefined)?.text ?? '';
          if (x.rec.type !== 'community') m++;
          else {
            const mm = parseMentions(text);
            if (mm.users.includes(this.me)) m++;
            else if (st?.kind === 'community' && (mm.everyone || mm.here) && channelPerms(st, op.a, ch) & P.MENTION_EVERYONE) m++;
          }
        }
        unread[chanKey(x.rec.c, ch)] = { u: true, m };
      }
    }
    set({ unread });
    this.updateBadge();
  }

  async markRead(c: string, ch: string, l?: number) {
    const x = this.convos.get(c);
    if (!x) return;
    let lam = l;
    if (lam === undefined) {
      const last = await this.convos.lastInChannel(c, ch);
      lam = last?.l ?? 0;
    }
    await this.convos.setRead(c, ch, lam);
    const key = chanKey(c, ch);
    if (get().unread[key]) {
      set((s) => {
        const u = { ...s.unread };
        delete u[key];
        return { unread: u };
      });
      this.updateBadge();
    }
    if (x.rec.type === 'dm' && x.rec.peer && this.settings.privacy.readReceipts && lam) {
      const links = this.peers.byPub(x.rec.peer);
      if (links.length) this.sync.receipt(c, x.rec.peer, lam);
      else this.pendingReceipts.set(c, lam);
    }
  }

  private markViewRead() {
    if (document.hidden || !document.hasFocus()) return;
    const v = get().view;
    if (v.kind === 'community' && v.ch) void this.markRead(v.c, v.ch);
    if (v.kind === 'dm') void this.markRead(v.c, 'main');
  }

  // ===========================================================================
  // Navigation + channel loading
  // ===========================================================================

  navigate(view: View) {
    const s = get();
    // mobile drawer: picking a channel or DM closes it; switching community keeps it open to pick a channel
    if (s.navOpen && ((view.kind === 'community' && view.ch) || view.kind === 'dm')) set({ navOpen: false });
    if (view.kind === 'community') {
      const st = this.convos.community(view.c);
      let ch: string | null = view.ch ?? s.lastChannel[view.c] ?? null;
      if (st && (!ch || !st.channels[ch] || st.channels[ch].type !== 'text' || !(channelPerms(st, this.me, ch) & P.VIEW_CHANNEL))) {
        ch = this.firstChannel(st);
      }
      view = { kind: 'community', c: view.c, ch };
      set({ view, lastChannel: ch ? { ...s.lastChannel, [view.c]: ch } : s.lastChannel, panel: null, editing: null });
      if (ch) {
        void this.loadChannel(view.c, ch);
        void this.markRead(view.c, ch);
      }
      const theme = get().theme;
      const ov = this.settings.chat.communityThemes && st?.theme ? { accent: st.theme.accent, accent2: st.theme.accent2, font: st.theme.font } : null;
      applyTheme(get().previewTheme ?? theme, ov);
    } else if (view.kind === 'voice') {
      const st = this.convos.community(view.c);
      set({ view, panel: null, editing: null });
      const ov = this.settings.chat.communityThemes && st?.theme ? { accent: st.theme.accent, accent2: st.theme.accent2, font: st.theme.font } : null;
      applyTheme(get().previewTheme ?? get().theme, ov);
    } else {
      set({ view, panel: null, editing: null });
      applyTheme(get().previewTheme ?? get().theme);
      if (view.kind === 'dm') {
        void this.loadChannel(view.c, 'main');
        void this.markRead(view.c, 'main');
        const rec = this.convos.get(view.c)?.rec;
        if (rec?.hidden) {
          rec.hidden = false;
          void this.convos.saveRec(rec);
          set((st) => ({ convos: { ...st.convos, [rec.c]: { ...rec } } }));
        }
      }
    }
  }

  firstChannel(st: CommunityState): string | null {
    const visible = Object.values(st.channels).filter((c) => c.type === 'text' && channelPerms(st, this.me, c.id) & P.VIEW_CHANNEL);
    if (st.systemChannel && visible.some((c) => c.id === st.systemChannel)) return st.systemChannel;
    const byPos = (a: { pos: number; parent: string | null }, b: { pos: number; parent: string | null }) => {
      const pa = a.parent ? st.channels[a.parent]?.pos ?? 0 : -1;
      const pb = b.parent ? st.channels[b.parent]?.pos ?? 0 : -1;
      return pa - pb || a.pos - b.pos;
    };
    return visible.sort(byPos)[0]?.id ?? null;
  }

  async loadChannel(c: string, ch: string, older = false) {
    const key = chanKey(c, ch);
    const cur = get().chans[key];
    if (cur?.loading) return;
    if (cur?.loaded && !older) return;
    set((s) => ({ chans: { ...s.chans, [key]: { list: cur?.list ?? [], hasMore: cur?.hasMore ?? true, loaded: cur?.loaded ?? false, loading: true } } }));
    const before = older && cur?.list.length ? cur.list[0].l : Infinity;
    const { messages, hasMore } = await this.convos.loadChannel(c, ch, before, 50);
    set((s) => {
      const prev = s.chans[key]?.list ?? [];
      const ids = new Set(prev.map((m) => m.id));
      const merged = [...messages.filter((m) => !ids.has(m.id)), ...prev].sort((a, b) => a.l - b.l || (a.id < b.id ? -1 : 1));
      return { chans: { ...s.chans, [key]: { list: merged, hasMore, loaded: true, loading: false } } };
    });
    this.wantProfiles([...new Set(messages.map((m) => m.a))]);
  }

  private reloadLoaded(c: string) {
    for (const key of Object.keys(get().chans)) {
      if (!key.startsWith(c + '|')) continue;
      const ch = key.slice(c.length + 1);
      set((s) => {
        const chans = { ...s.chans };
        delete chans[key];
        return { chans };
      });
      const v = get().view;
      if ((v.kind === 'community' && v.c === c && v.ch === ch) || (v.kind === 'dm' && v.c === c)) void this.loadChannel(c, ch);
    }
  }

  // ===========================================================================
  // Authoring + distribution
  // ===========================================================================

  async author(c: string, k: string, p: unknown) {
    const op = await this.convos.author(c, k, p);
    await this.distribute(op);
    return op;
  }

  private async distribute(op: StoredOp | Op) {
    this.sync.gossip(op);
    const x = this.convos.get(op.c);
    if (!x || x.rec.type === 'community') return;
    let members: string[] = [];
    if (x.rec.type === 'dm') members = [x.rec.peer!];
    else {
      const st = x.eng.state as GroupState | null;
      members = Object.keys(st?.members ?? {});
      if (op.k === 'gremove') members.push((op.p as { target: string }).target);
    }
    for (const pub of members) {
      if (pub === this.me) continue;
      // Skip the mailbox only when a direct link is demonstrably alive (heard from in the last 25s).
      // Relay links and quiet links might be dead already; duplicates are de-duplicated by op id.
      const alive = this.peers.byPub(pub).some((l) => l.helloReceived && l.state === 'direct' && Date.now() - l.lastRecv < 25_000);
      if (alive) continue;
      await this.sendMail(pub, { type: 'ops', ctype: x.rec.type, c: op.c, ops: [cleanOp(op as Op)] });
    }
  }

  /** Create DM/group conversations for ops arriving from a peer we have none with yet. */
  private async prepareUnknown(raws: unknown[]) {
    for (const raw of raws) {
      const op = raw as Op;
      if (!op || typeof op !== 'object' || this.convos.get(op.c)) continue;
      if (!(await verifyOpFast(op))) continue;
      if (op.k === 'gcreate') {
        const members = (op.p as { members?: string[] } | undefined)?.members ?? [];
        if (members.includes(this.me) && this.allowDmFrom(op.a)) await this.convos.ensure(op.c, 'group');
      } else if (dmId(this.me, op.a) === op.c && this.allowDmFrom(op.a)) {
        await this.convos.ensureDm(op.a);
        this.refreshTopics();
      }
    }
  }

  allowDmFrom(pub: string) {
    const f = this.friends.get(pub);
    if (f?.state === 'blocked') return false;
    if (f?.state === 'friend') return true;
    const rule = this.settings.privacy.dmsFrom;
    if (rule === 'all') return true;
    if (rule === 'friends') return false;
    return this.convos.list().some((x) => x.rec.type === 'community' && !!x.eng.state?.members[pub] && !!x.eng.state?.members[this.me]);
  }

  async sendMessage(c: string, ch: string, text: string, files: File[], replyTo?: string | null, spoilers: boolean[] = []) {
    const x = this.convos.get(c);
    if (!x) throw new Error('Unknown conversation');
    const st = x.eng.state;
    if (st?.kind === 'community') {
      const perms = channelPerms(st, this.me, ch, Date.now());
      if (!(perms & P.SEND)) throw new Error('You do not have permission to send messages here.');
      if (files.length && !(perms & P.ATTACH)) throw new Error('You do not have permission to attach files here.');
    }
    const att: Attachment[] = [];
    for (const f of files.slice(0, LIMITS.attachmentsPerMessage)) {
      if (f.size > this.settings.media.maxFileMB * 1024 * 1024) throw new Error(`${f.name} is larger than your ${this.settings.media.maxFileMB} MB file limit.`);
      const ref = await this.files.put(f, f.name, f.type);
      const pr = await probe(f);
      const a: Attachment = { hash: ref.hash, mime: (f.type || 'application/octet-stream').slice(0, 100), size: ref.size, name: f.name.slice(0, 255) || 'file' };
      if (pr.w) a.w = Math.round(pr.w);
      if (pr.h) a.h = Math.round(pr.h);
      if (pr.dur) a.dur = pr.dur;
      if (pr.thumb) a.thumb = pr.thumb;
      if (/\.celtheme(\.json)?$/i.test(f.name)) a.theme = true;
      if (f.name.startsWith('voice-message') && f.type.startsWith('audio/')) {
        a.voice = true;
        const d = /-(\d+(?:\.\d+)?)s\./.exec(f.name);
        if (d) a.dur = Math.min(86400, Number(d[1]));
      }
      if (spoilers[att.length]) a.spoiler = true;
      att.push(a);
      void this.publishUrl(ref.hash);
    }
    const p: Record<string, unknown> = { ch, text: text.slice(0, LIMITS.messageChars) };
    if (replyTo) p.reply = replyTo;
    if (att.length) p.att = att;
    const op = await this.author(c, 'msg', p);
    if (x.rec.type === 'dm' && x.rec.peer) this.touchFriend(x.rec.peer);
    return op;
  }

  // ---- GIF search (KLIPY / GIPHY / any Tenor-v2-compatible API) ------------------

  /** Where GIF searches go, or null when nothing is configured. */
  gifSource(): { via: 'hub'; provider: GifProvider } | { via: 'direct'; provider: GifProvider } | null {
    const g = this.settings.gifs;
    const hubGifs = this.hub.kind === 'hub' ? this.hub.info?.features.gifs : null;
    if (g.useHub && hubGifs) return { via: 'hub', provider: hubGifs };
    if (g.key.trim()) return { via: 'direct', provider: g.provider };
    if (hubGifs) return { via: 'hub', provider: hubGifs };
    return null;
  }

  async searchGifs(q: string, pos: string | null = null): Promise<GifPage> {
    const src = this.gifSource();
    if (!src) throw new Error('GIF search is not set up');
    const kind = q.trim() ? 'search' : 'featured';
    let r: Response;
    try {
      if (src.via === 'hub') {
        const u = new URL(`${this.hub.httpBase}/api/gifs/${kind}`);
        if (kind === 'search') u.searchParams.set('q', q.trim());
        if (pos) u.searchParams.set('pos', pos);
        r = await fetch(u);
      } else {
        const g = this.settings.gifs;
        r = await fetch(gifUrl(g.provider, g.base, g.key.trim(), kind, q.trim(), pos, g.filter));
      }
    } catch {
      throw new Error(src.via === 'direct' ? 'Could not reach the GIF provider from the browser (it may block cross-site requests). A hub with GIF_API_KEY avoids that.' : 'Could not reach the hub.');
    }
    if (r.status === 401 || r.status === 403) throw new Error('The GIF provider rejected the API key.');
    if (r.status === 429) throw new Error('GIF search is rate limited right now. Try again in a minute.');
    if (!r.ok) throw new Error(`GIF search failed (${r.status}).`);
    const j = await r.json();
    return src.via === 'hub' ? (j as GifPage) : normalizeGifs(src.provider, j);
  }

  /** Download GIF media (through the hub's proxy when it has one, so the provider never sees your IP). */
  async gifMedia(url: string): Promise<Blob> {
    const src = this.gifSource();
    if (!isGifMediaHost(url)) throw new Error('Unexpected media host');
    const r = src?.via === 'hub' ? await fetch(`${this.hub.httpBase}/api/gifs/media?u=${encodeURIComponent(url)}`) : await fetch(url);
    if (!r.ok) throw new Error('Could not download that GIF');
    const blob = await r.blob();
    if (blob.size > GIF_MAX_SEND_BYTES * 1.5) throw new Error('That GIF is too large');
    return blob;
  }

  /** The GIF is downloaded once and then sent peer to peer like any file: recipients never contact the provider. */
  async sendGif(c: string, ch: string, g: GifResult, replyTo?: string | null) {
    const blob = await this.gifMedia(g.full.url);
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const mime = sniffImage(head);
    if (!mime) throw new Error('The provider returned something that is not an image');
    const src = this.gifSource();
    const file = new File([blob], `${src?.provider ?? 'gif'}-${g.id}.${mime === 'image/webp' ? 'webp' : 'gif'}`, { type: mime });
    return this.sendMessage(c, ch, '', [file], replyTo ?? null);
  }

  // ---- polls ----------------------------------------------------------------

  async sendPoll(c: string, ch: string, poll: { q: string; options: string[]; multi: boolean; durationSecs: number | null }) {
    const options = poll.options.map((o) => o.trim()).filter(Boolean).slice(0, 10);
    if (!poll.q.trim() || options.length < 2) throw new Error('A poll needs a question and at least two options.');
    return this.author(c, 'msg', { ch, text: '', poll: { q: poll.q.trim().slice(0, 300), options: options.map((o) => o.slice(0, 100)), multi: poll.multi, ends: poll.durationSecs ? Date.now() + poll.durationSecs * 1000 : null } });
  }

  vote(c: string, id: string, choices: number[]) {
    return this.author(c, 'vote', { id, choices });
  }

  // ---- custom emoji (per community, usable anywhere) -------------------------

  async addEmoji(c: string, name: string, file: File) {
    const clean = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
    if (clean.length < 2) throw new Error('Emoji names need at least 2 letters, numbers or underscores.');
    if (this.convos.community(c)?.emojis?.[clean]) throw new Error(`:${clean}: already exists here.`);
    const { prepareImage } = await import('./media');
    const blob = await prepareImage(file, 128, LIMITS.emojiBytes);
    const ref = await this.storeImage(blob, clean);
    await this.author(c, 'emoji.add', { name: clean, asset: { hash: ref.hash, mime: ref.mime, size: ref.size, w: ref.w, h: ref.h } });
    return clean;
  }

  removeEmoji(c: string, name: string) {
    return this.author(c, 'emoji.del', { name });
  }

  /** every custom emoji from every community you are in: yours to use anywhere, free */
  allEmoji() {
    const out: { name: string; token: string; asset: AssetRef; c: string; community: string }[] = [];
    for (const x of this.convos.communities()) {
      const st = x.eng.state as CommunityState | null;
      if (!st?.members[this.me]) continue;
      for (const e of Object.values(st.emojis ?? {})) out.push({ name: e.name, token: emojiToken(e.name, e.asset), asset: e.asset, c: st.id, community: st.name });
    }
    return out;
  }

  // ---- bookmarks + reminders ------------------------------------------------

  private async saveBookmarks(list: Bookmark[]) {
    set({ bookmarks: list });
    await this.db.put('kv', { k: 'bookmarks', v: list });
  }

  async bookmark(m: Message, remindInSecs: number | null = null) {
    const list = get().bookmarks.filter((b) => b.id !== m.id);
    list.unshift({ id: m.id, c: m.c, ch: m.ch, a: m.a, text: (m.text || (m.att.length ? `${m.att.length} attachment(s)` : m.poll?.q ?? '')).slice(0, 300), savedAt: Date.now(), remindAt: remindInSecs ? Date.now() + remindInSecs * 1000 : null });
    await this.saveBookmarks(list.slice(0, 500));
    toast(remindInSecs ? `I'll remind you ${fmtIn(remindInSecs)}` : 'Saved to your bookmarks', 'success');
  }

  async unbookmark(id: string) {
    await this.saveBookmarks(get().bookmarks.filter((b) => b.id !== id));
  }

  // ---- scheduled messages ---------------------------------------------------

  private async saveScheduled(list: Scheduled[]) {
    set({ scheduled: list });
    await this.db.put('kv', { k: 'scheduled', v: list });
  }

  async schedule(c: string, ch: string, text: string, at: number, reply: string | null) {
    if (!text.trim()) throw new Error('Nothing to schedule.');
    if (at <= Date.now() + 5000) throw new Error('Pick a time in the future.');
    await this.saveScheduled([...get().scheduled, { id: randomHex(6), c, ch, text, at, reply }].sort((a, b) => a.at - b.at));
    toast(`Scheduled for ${new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. CelChat sends it if it is open then (or as soon as it opens).`, 'success');
  }

  async unschedule(id: string) {
    await this.saveScheduled(get().scheduled.filter((s) => s.id !== id));
  }

  /** due reminders and scheduled sends, checked every few seconds */
  private async runTimers() {
    const now = Date.now();
    const due = get().bookmarks.filter((b) => b.remindAt && b.remindAt <= now);
    if (due.length) {
      for (const b of due) {
        const where = this.convos.community(b.c)?.name ?? this.nameOf(b.a);
        toast(`Reminder: "${b.text.slice(0, 80)}" (${where})`, 'info', { label: 'Jump', fn: () => this.jumpTo(b.c, b.ch, b.id) });
        desktopNotify('Reminder', b.text, null, () => this.jumpTo(b.c, b.ch, b.id), 'rem' + b.id);
        if (this.settings.notify.sounds) sounds.mention();
      }
      await this.saveBookmarks(get().bookmarks.map((b) => (b.remindAt && b.remindAt <= now ? { ...b, remindAt: null } : b)));
    }
    const ready = get().scheduled.filter((s) => s.at <= now);
    if (!ready.length) return;
    await this.saveScheduled(get().scheduled.filter((s) => s.at > now));
    for (const s of ready) {
      try {
        await this.sendMessage(s.c, s.ch, s.text, [], s.reply);
        if (now - s.at > 60_000) toast('A scheduled message was sent late because CelChat was closed at its time.', 'info');
      } catch (e) {
        toast('A scheduled message could not be sent: ' + (e as Error).message, 'error');
      }
    }
  }

  jumpTo(c: string, ch: string, id: string) {
    const rec = this.convos.get(c)?.rec;
    if (!rec) return;
    this.navigate(rec.type === 'community' ? { kind: 'community', c, ch } : { kind: 'dm', c });
    setTimeout(async () => {
      for (let i = 0; i < 20; i++) {
        const cs = get().chans[chanKey(c, ch)];
        if (cs?.list.some((m) => m.id === id)) break;
        if (cs && !cs.hasMore) break;
        await this.loadChannel(c, ch, true);
      }
      set({ jumpTo: id });
    }, 60);
  }

  /** Recent messages that pinged you, across every conversation (scanned locally). */
  async inbox(days = 14) {
    const since = Date.now() - days * 86400_000;
    const out: Message[] = [];
    for (const x of this.convos.list()) {
      if (x.rec.type !== 'community') continue;
      const st = x.eng.state as CommunityState | null;
      if (!st) continue;
      for (const ch of Object.values(st.channels)) {
        if (ch.type !== 'text') continue;
        for (const op of await this.convos.after(x.rec.c, ch.id, 0, 150)) {
          if (op.t < since || op.a === this.me || op.k !== 'msg') continue;
          const m = await this.convos.materialize(x, op);
          if (m && !m.deleted && (await this.pingsMe(x.rec, m))) out.push(m);
        }
      }
    }
    return out.sort((a, b) => b.t - a.t).slice(0, 100);
  }

  private speak(text: string) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text.slice(0, 300));
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  readAloud(m: Message) {
    this.speak(`${this.nameOf(m.a, m.c)} said: ${this.plainText(m.text, m.c) || 'an attachment'}`);
  }

  async sendAttachmentRefs(c: string, ch: string, att: Attachment[], text = '') {
    return this.author(c, 'msg', { ch, text, att });
  }

  editMessage(c: string, id: string, text: string) {
    return this.author(c, 'edit', { id, text: text.slice(0, LIMITS.messageChars) });
  }
  deleteMessage(c: string, id: string) {
    return this.author(c, 'del', { id });
  }
  react(c: string, id: string, e: string, on: boolean) {
    if (on) {
      const recent = [e, ...this.settings.recentEmoji.filter((x) => x !== e)].slice(0, 24);
      void this.saveSettings({ ...this.settings, recentEmoji: recent });
    }
    return this.author(c, 'react', { id, e, on });
  }
  pin(c: string, id: string, on: boolean) {
    return this.author(c, 'pin', { id, on });
  }

  typing(c: string, ch: string) {
    if (!this.settings.privacy.typing || this.settings.status === 'invisible') return;
    const key = chanKey(c, ch);
    const now = Date.now();
    if (now - (this.typingSent.get(key) ?? 0) < 3500) return;
    this.typingSent.set(key, now);
    this.sync.ephemeral(c, 'typing', { ch });
  }

  private onEph(e: Eph) {
    if (this.friends.get(e.a)?.state === 'blocked') return;
    const x = this.convos.get(e.c);
    if (!x || !x.eng.state?.members[e.a]) return;
    if (e.k === 'typing') {
      const ch = String(e.d.ch ?? '');
      const key = chanKey(e.c, ch);
      set((s) => ({ typing: { ...s.typing, [key]: { ...(s.typing[key] ?? {}), [e.a]: Date.now() + 6500 } } }));
    } else if (e.k === 'voice' && x.rec.type === 'community') {
      const ch = String(e.d.ch ?? '');
      set((s) => {
        const vr = { ...s.voiceRooms };
        for (const k of Object.keys(vr)) {
          if (k.startsWith(e.c + '|') && vr[k][e.a]) {
            vr[k] = { ...vr[k] };
            delete vr[k][e.a];
            if (!Object.keys(vr[k]).length) delete vr[k];
          }
        }
        if (e.d.on) {
          const key = chanKey(e.c, ch);
          vr[key] = { ...(vr[key] ?? {}), [e.a]: { muted: !!e.d.muted, deaf: !!e.d.deaf, at: Date.now() } };
        }
        return { voiceRooms: vr };
      });
    }
  }

  async search(scope: string[], q: Parameters<Convos['search']>[1]) {
    return this.convos.search(scope, q);
  }

  // ===========================================================================
  // Communities
  // ===========================================================================

  async createCommunity(name: string, icon?: Blob | null) {
    const iconRef = icon ? await this.storeImage(icon, 'icon') : undefined;
    const c = await this.convos.createCommunity(name, iconRef);
    void this.uploadPublic(iconRef);
    this.refreshTopics();
    this.navigate({ kind: 'community', c, ch: null });
    return c;
  }

  inviteLink(c: string, code: string) {
    return `${location.origin}${location.pathname}#/join/${c}/${code}`;
  }

  parseInvite(input: string): { c: string; code: string } | null {
    const m = /([0-9a-f]{64})[/.:]([A-Za-z0-9]{6,16})/.exec(input.trim());
    return m ? { c: m[1], code: m[2] } : null;
  }

  async joinByInvite(input: string) {
    const inv = this.parseInvite(input);
    if (!inv) throw new Error('That does not look like a CelChat invite link.');
    const have = this.convos.get(inv.c);
    if (have?.eng.state?.members[this.me]) {
      this.navigate({ kind: 'community', c: inv.c, ch: null });
      return 'already';
    }
    await this.convos.ensure(inv.c, 'community', { joinCode: inv.code });
    set({ pendingJoin: { link: input } });
    this.refreshTopics();
    this.maybeJoin(inv.c);
    return 'pending';
  }

  async createInvite(c: string, expiresInSecs: number | null, maxUses: number | null) {
    const code = randomAlnum(8);
    await this.author(c, 'inv.create', { code, expiresAt: expiresInSecs ? Date.now() + expiresInSecs * 1000 : null, maxUses });
    return this.inviteLink(c, code);
  }

  /**
   * Ask an archive peer to join this community. It gets a single-use invite through the sealed
   * mailbox; it decides itself whether to accept (its operator controls who may add it).
   */
  async addArchivePeer(c: string, query: string) {
    const pub = await this.resolveUser(query);
    const card = this.profiles.get(pub);
    if (!card?.bot) throw new Error(`${this.nameOf(pub)} is not an archive peer (its profile is not marked as one).`);
    const st = this.convos.community(c);
    if (st?.members[pub]) throw new Error('That archive peer is already a member.');
    const link = await this.createInvite(c, 7 * 86400, 1);
    const sent = await this.sendMail(pub, { type: 'keeper.join', link, name: st?.name ?? '' });
    if (!sent) throw new Error('Could not reach the hub mailbox. Try again when you are connected.');
    return pub;
  }

  revokeInvite(c: string, code: string) {
    return this.author(c, 'inv.revoke', { code });
  }

  async updateCommunity(c: string, patch: Record<string, unknown>, media: { icon?: Blob | null; banner?: Blob | null; bgImage?: Blob | null } = {}) {
    const p = { ...patch };
    if (media.icon !== undefined) {
      p.icon = media.icon ? await this.storeImage(media.icon, 'icon') : null;
      void this.uploadPublic(p.icon as AssetRef | null);
    }
    if (media.banner !== undefined) {
      p.banner = media.banner ? await this.storeImage(media.banner, 'banner') : null;
      void this.uploadPublic(p.banner as AssetRef | null);
    }
    return this.author(c, 'comm.update', p);
  }

  createChannel(c: string, type: 'text' | 'voice' | 'category', name: string, parent: string | null, topic = '') {
    const st = this.convos.community(c);
    const siblings = st ? Object.values(st.channels).filter((x) => (type === 'category' ? x.type === 'category' : x.parent === parent && x.type !== 'category')) : [];
    const pos = siblings.reduce((m, x) => Math.max(m, x.pos + 1), 0);
    const clean = type === 'category' ? name.trim() : name.trim().toLowerCase().replace(/\s+/g, '-');
    return this.author(c, 'ch.create', { id: randomHex(8), type, name: clean.slice(0, LIMITS.channelNameChars), parent: type === 'category' ? null : parent, pos, topic: topic || undefined });
  }

  updateChannel(c: string, id: string, patch: Record<string, unknown>) {
    return this.author(c, 'ch.update', { id, ...patch });
  }
  deleteChannel(c: string, id: string) {
    return this.author(c, 'ch.delete', { id });
  }

  async createRole(c: string, name: string, color: string | null, perms: number) {
    const st = this.convos.community(c)!;
    const top = Object.values(st.roles).filter((r) => r.id !== st.id);
    const myTop = st.owner === this.me ? Infinity : Math.max(0, ...(st.members[this.me]?.roles.map((r) => st.roles[r]?.pos ?? 0) ?? [0]));
    let pos = 1;
    const below = top.filter((r) => r.pos < myTop);
    pos = below.length ? Math.max(...below.map((r) => r.pos)) + 1 : 1;
    if (pos >= myTop) pos = Math.max(1, myTop - 1);
    return this.author(c, 'role.create', { id: randomHex(8), name, color, perms, pos: Math.min(pos, 1000), hoist: false, mentionable: false });
  }

  async updateRole(c: string, id: string, patch: Record<string, unknown>) {
    const st = this.convos.community(c)!;
    const role = st.roles[id];
    const reduces = role && ((typeof patch.perms === 'number' && (role.perms & ~patch.perms) !== 0) || (typeof patch.pos === 'number' && patch.pos < role.pos));
    const p = { id, ...patch } as Record<string, unknown>;
    if (reduces) p.cutoff = await this.convos.cutoffFor(c, this.convos.roleMembers(c, id));
    return this.author(c, 'role.update', p);
  }

  async deleteRole(c: string, id: string) {
    return this.author(c, 'role.delete', { id, cutoff: await this.convos.cutoffFor(c, this.convos.roleMembers(c, id)) });
  }

  async setMemberRoles(c: string, target: string, roles: string[]) {
    const st = this.convos.community(c)!;
    const removing = (st.members[target]?.roles ?? []).some((r) => !roles.includes(r));
    const p: Record<string, unknown> = { target, roles };
    if (removing) p.cutoff = await this.convos.cutoffFor(c, [target]);
    return this.author(c, 'mroles', p);
  }

  async kick(c: string, target: string, reason?: string) {
    return this.author(c, 'kick', { target, reason: reason || undefined, cutoff: await this.convos.cutoffFor(c, [target]) });
  }
  async ban(c: string, target: string, reason?: string, purgeSecs?: number) {
    return this.author(c, 'ban', { target, reason: reason || undefined, purgeSecs: purgeSecs || undefined, cutoff: await this.convos.cutoffFor(c, [target]) });
  }
  unban(c: string, target: string) {
    return this.author(c, 'unban', { target });
  }
  async timeout(c: string, target: string, secs: number | null, reason?: string) {
    if (secs === null) return this.author(c, 'timeout', { target, until: null });
    return this.author(c, 'timeout', { target, until: Date.now() + secs * 1000, reason: reason || undefined, cutoff: await this.convos.cutoffFor(c, [target]) });
  }
  setNick(c: string, target: string, nick: string | null) {
    return this.author(c, 'nick', { target, nick: nick?.trim() ? nick.trim().slice(0, LIMITS.nickChars) : null });
  }
  async transferOwnership(c: string, target: string) {
    return this.author(c, 'transfer', { target, cutoff: await this.convos.cutoffFor(c, [this.me]) });
  }

  async leaveCommunity(c: string) {
    const st = this.convos.community(c);
    if (st?.owner === this.me) throw new Error('Transfer ownership before leaving your own community.');
    if (this.voice.room?.c === c) this.leaveVoice();
    if (st?.members[this.me]) await this.author(c, 'leave', {});
    const x = this.convos.get(c);
    if (x) {
      x.rec.left = true;
      delete x.rec.joinCode;
      await this.convos.saveRec(x.rec);
    }
    await this.convos.remove(c);
    this.navigate({ kind: 'home', tab: 'online' });
  }

  async setConvoPrefs(c: string, patch: Partial<Pick<ConvoRecord, 'notify' | 'muted' | 'order' | 'hidden'>>, ch?: string, chPatch?: { notify?: NotifyLevel | 'default'; muted?: boolean }) {
    const x = this.convos.get(c);
    if (!x) return;
    Object.assign(x.rec, patch);
    if (ch && chPatch) x.rec.chans[ch] = { ...(x.rec.chans[ch] ?? {}), ...chPatch };
    await this.convos.saveRec(x.rec);
    set((s) => ({ convos: { ...s.convos, [c]: { ...x.rec } } }));
    this.updateBadge();
    this.scheduleVault();
  }

  async reorderCommunities(order: string[]) {
    let i = 0;
    for (const c of order) {
      const x = this.convos.get(c);
      if (!x) continue;
      x.rec.order = ++i;
      await this.convos.saveRec(x.rec);
    }
    set({ convos: Object.fromEntries(this.convos.list().map((x) => [x.rec.c, { ...x.rec }])) });
  }

  // ===========================================================================
  // DMs and group DMs
  // ===========================================================================

  async openDm(pub: string) {
    const x = await this.convos.ensureDm(pub);
    if (x.rec.hidden) {
      x.rec.hidden = false;
      await this.convos.saveRec(x.rec);
    }
    set((s) => ({ convos: { ...s.convos, [x.rec.c]: { ...x.rec } }, states: { ...s.states, [x.rec.c]: x.eng.state } }));
    this.refreshTopics();
    this.navigate({ kind: 'dm', c: x.rec.c });
    return x.rec.c;
  }

  async createGroup(members: string[], name?: string) {
    const { c } = await this.convos.createGroup(members, name);
    const x = this.convos.get(c)!;
    // send the full log to everyone (they have never heard of this group)
    const ops = (await this.convos.missingFor(c, {})).map(cleanOp);
    for (const pub of members) await this.sendMail(pub, { type: 'ops', ctype: 'group', c, ops });
    for (const op of ops) this.sync.gossip(op);
    this.refreshTopics();
    set((s) => ({ convos: { ...s.convos, [c]: { ...x.rec } }, states: { ...s.states, [c]: x.eng.state } }));
    this.navigate({ kind: 'dm', c });
    return c;
  }

  async addToGroup(c: string, pub: string) {
    await this.author(c, 'gadd', { target: pub });
    const ops = await this.convos.missingFor(c, {});
    const gov = ops.filter((o) => o.k.startsWith('g'));
    await this.sendMail(pub, { type: 'ops', ctype: 'group', c, ops: gov });
  }
  async removeFromGroup(c: string, pub: string) {
    return this.author(c, 'gremove', { target: pub, cutoff: await this.convos.cutoffFor(c, [pub]) });
  }
  async renameGroup(c: string, name: string) {
    return this.author(c, 'gupdate', { name });
  }
  async leaveGroup(c: string) {
    await this.author(c, 'gleave', {});
    await this.convos.remove(c);
    this.navigate({ kind: 'home', tab: 'online' });
  }
  async hideDm(c: string) {
    await this.setConvoPrefs(c, { hidden: true });
    if (get().view.kind === 'dm' && (get().view as { c: string }).c === c) this.navigate({ kind: 'home', tab: 'online' });
  }

  // ===========================================================================
  // Friends + mailbox
  // ===========================================================================

  private async sendMail(to: string, body: unknown) {
    if (!this.hub.info?.features.mailbox && this.hub.state === 'online') return false;
    try {
      const box = await sealSigned(this.keys, to, body);
      if (box.length > (this.hub.info?.limits.mailItemBytes ?? 256 * 1024)) {
        console.warn('[mail] envelope too big, relying on P2P sync');
        return false;
      }
      if (this.hub.state !== 'online') throw new Error('offline');
      await this.hub.mailPut(to, toB64(box));
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'mailbox_full') toast("That person's offline inbox is full. They'll get it when you're both online.", 'error');
      else if (code !== 'too_big') {
        this.outbox.push({ to, body });
        await this.saveOutbox();
      }
      return false;
    }
  }

  private async saveOutbox() {
    await this.db.put('kv', { k: 'outbox', v: this.outbox.slice(-500) });
  }

  private async onMail(items: { id: string; box: string; at: number }[]) {
    const done: string[] = [];
    for (const it of items) {
      if (this.mailSeen.has(it.id)) continue;
      this.mailSeen.add(it.id);
      try {
        const env = await unsealSigned(this.keys, fromB64(it.box));
        await this.onEnvelope(env.from, env.body as Record<string, unknown>);
      } catch (e) {
        console.warn('[mail] dropped envelope', e);
      }
      done.push(it.id);
    }
    this.hub.mailDel(done);
  }

  private async onEnvelope(from: string, body: Record<string, unknown>) {
    if (!body || typeof body !== 'object') return;
    const blocked = this.friends.get(from)?.state === 'blocked';
    if (body.type === 'friend') {
      if (blocked) return;
      const card = body.card ? verifyProfile(body.card) : null;
      if (card && card.pub === from) this.upsertProfile(card);
      await this.onFriendEnvelope(from, String(body.action));
      return;
    }
    if (body.type === 'ops' && Array.isArray(body.ops)) {
      if (blocked) return;
      const c = String(body.c ?? '');
      if (!this.convos.get(c)) await this.prepareUnknown(body.ops.slice(0, 1000));
      if (!this.convos.get(c)) return;
      await this.convos.ingest(body.ops.slice(0, 1000), 'mail:' + from);
      return;
    }
    if (body.type === 'call' && body.action === 'missed') {
      if (blocked) return;
      toast(`Missed call from ${this.nameOf(from)}`, 'info');
    }
  }

  private async onFriendEnvelope(from: string, action: string) {
    const f = this.friends.get(from);
    const now = Date.now();
    switch (action) {
      case 'req': {
        if (f?.state === 'friend') {
          // they lost their list; re-confirm
          await this.sendMail(from, { type: 'friend', action: 'accept', card: this.myCard });
          return;
        }
        if (f?.state === 'outgoing') return this.becomeFriends(from);
        const rule = this.settings.privacy.friendReqFrom;
        if (rule === 'none') return;
        if (rule === 'members' && !this.knows(from)) return;
        await this.putFriend({ pub: from, state: 'incoming', since: now });
        if (this.settings.notify.sounds) sounds.friend();
        toast(`${this.nameOf(from)} sent you a friend request`, 'info', { label: 'View', fn: () => this.navigate({ kind: 'home', tab: 'pending' }) });
        desktopNotify('Friend request', `${this.nameOf(from)} wants to be friends`, null, () => this.navigate({ kind: 'home', tab: 'pending' }));
        return;
      }
      case 'accept':
        if (f?.state === 'outgoing' || f?.state === 'friend') {
          await this.becomeFriends(from);
          toast(`${this.nameOf(from)} accepted your friend request`, 'success');
        }
        return;
      case 'decline':
      case 'cancel':
        if (f && (f.state === 'incoming' || f.state === 'outgoing')) await this.dropFriend(from);
        return;
      case 'remove':
        if (f?.state === 'friend') await this.dropFriend(from);
        return;
    }
  }

  private async putFriend(f: FriendRecord) {
    this.friends.set(f.pub, f);
    await this.db.put('friends', f);
    set({ friends: Object.fromEntries(this.friends) });
    this.refreshTopics();
    this.scheduleVault();
  }

  private async dropFriend(pub: string) {
    this.friends.delete(pub);
    await this.db.delete('friends', pub);
    set({ friends: Object.fromEntries(this.friends) });
    this.refreshTopics();
    this.scheduleVault();
  }

  private async becomeFriends(pub: string) {
    await this.putFriend({ pub, state: 'friend', since: Date.now() });
  }

  /** Resolve "@username", a username or a raw CelChat ID to a key. */
  async resolveUser(query: string): Promise<string> {
    const q = query.trim().replace(/^@/, '').toLowerCase();
    if (isHex(q, 64)) return q;
    for (const card of this.profiles.values()) if (card.username === q) return card.pub;
    if (this.hub.state !== 'online') throw new Error('The hub is offline, so usernames cannot be looked up. Paste their CelChat ID instead.');
    if (!this.hub.info?.features.directory) throw new Error('This hub has no username directory. Paste their CelChat ID instead.');
    const raw = await this.hub.dirGet(q);
    const card = raw ? verifyProfile(raw) : null;
    if (!card) throw new Error(`Nobody called @${q} on this hub. Check the spelling, or use their CelChat ID.`);
    this.upsertProfile(card);
    return card.pub;
  }

  async addFriend(query: string) {
    const pub = await this.resolveUser(query);
    if (pub === this.me) throw new Error("You can't add yourself (we checked).");
    const f = this.friends.get(pub);
    if (f?.state === 'friend') throw new Error('You are already friends.');
    if (f?.state === 'blocked') throw new Error('Unblock them first.');
    if (f?.state === 'incoming') return this.acceptFriend(pub);
    await this.putFriend({ pub, state: 'outgoing', since: Date.now() });
    await this.sendMail(pub, { type: 'friend', action: 'req', card: this.myCard });
    this.wantProfiles([pub]);
    return pub;
  }

  async acceptFriend(pub: string) {
    await this.becomeFriends(pub);
    await this.sendMail(pub, { type: 'friend', action: 'accept', card: this.myCard });
    return pub;
  }
  async declineFriend(pub: string) {
    await this.dropFriend(pub);
    await this.sendMail(pub, { type: 'friend', action: 'decline' });
  }
  async cancelFriend(pub: string) {
    await this.dropFriend(pub);
    await this.sendMail(pub, { type: 'friend', action: 'cancel' });
  }
  async removeFriend(pub: string) {
    await this.dropFriend(pub);
    await this.sendMail(pub, { type: 'friend', action: 'remove' });
  }
  async block(pub: string) {
    const was = this.friends.get(pub)?.state;
    await this.putFriend({ pub, state: 'blocked', since: Date.now() });
    if (was === 'friend') await this.sendMail(pub, { type: 'friend', action: 'remove' });
    for (const l of this.peers.byPub(pub)) l.close();
    this.voice.refreshForced();
  }
  async unblock(pub: string) {
    await this.dropFriend(pub);
    this.voice.refreshForced();
  }
  private touchFriend(pub: string) {
    const f = this.friends.get(pub);
    if (f) {
      f.note = String(Date.now());
      void this.db.put('friends', f);
    }
  }

  // ===========================================================================
  // Voice channels + calls
  // ===========================================================================

  async joinVoice(c: string, ch: string) {
    const st = this.convos.community(c);
    if (!st) return;
    const perms = channelPerms(st, this.me, ch, Date.now());
    if (!(perms & P.CONNECT)) {
      toast('You do not have permission to join this voice channel.', 'error');
      return;
    }
    const occupants = Object.keys(get().voiceRooms[chanKey(c, ch)] ?? {}).length;
    if (occupants >= LIMITS.voiceRoomCap) {
      toast(`Voice rooms are capped at ${LIMITS.voiceRoomCap} people (peer-to-peer mesh).`, 'error');
      return;
    }
    if (occupants >= LIMITS.voiceRoomWarn) toast(`${occupants + 1} people in a mesh call: audio quality depends on everyone's upload speed.`, 'info');
    const room: VoiceRoom = { kind: 'channel', c, ch, topic: this.topicOf.voice(c, ch) };
    const ok = await this.voice.join(room);
    if (!ok) return;
    this.refreshTopics();
    this.voiceHeartbeat();
    if (this.settings.notify.sounds) sounds.join();
    this.navigate({ kind: 'voice', c, ch });
  }

  leaveVoice() {
    const room = this.voice.room;
    if (!room) return;
    if (room.kind === 'channel') this.sync.ephemeral(room.c, 'voice', { ch: room.ch, on: false });
    if (room.kind === 'call') {
      const out = get().outgoingCall;
      if (out && !this.callHadPeer) this.cancelRing(out);
      set({ outgoingCall: null });
      stopRinging();
      if (this.callTimeout) clearTimeout(this.callTimeout);
    }
    this.voice.leave();
    this.refreshTopics();
    if (this.settings.notify.sounds) sounds.leave();
    set((s) => {
      const vr = { ...s.voiceRooms };
      const key = chanKey(room.c, room.ch);
      if (vr[key]) {
        vr[key] = { ...vr[key] };
        delete vr[key][this.me];
        if (!Object.keys(vr[key]).length) delete vr[key];
      }
      return { voiceRooms: vr };
    });
  }

  setMuted(m: boolean) {
    this.voice.setMuted(m);
    if (this.settings.notify.sounds) (m ? sounds.mute : sounds.unmute)();
    this.voiceHeartbeat();
  }
  setDeafened(d: boolean) {
    this.voice.setDeafened(d);
    if (this.settings.notify.sounds) (d ? sounds.mute : sounds.unmute)();
    this.voiceHeartbeat();
  }

  private voiceHeartbeat() {
    const room = this.voice.room;
    if (!room || room.kind !== 'channel' || this.voice.state !== 'connected') return;
    this.sync.ephemeral(room.c, 'voice', { ch: room.ch, on: true, muted: this.voice.muted, deaf: this.voice.deafened });
    const key = chanKey(room.c, room.ch);
    set((s) => ({ voiceRooms: { ...s.voiceRooms, [key]: { ...(s.voiceRooms[key] ?? {}), [this.me]: { muted: this.voice.muted, deaf: this.voice.deafened, at: Date.now() } } } }));
  }

  private onVoiceChange() {
    const v = this.voice;
    set({
      voice: {
        room: v.room,
        state: v.state,
        muted: v.muted,
        deafened: v.deafened,
        speaking: v.speaking,
        transmitting: v.transmitting,
        peers: [...v.peers.values()].map((p) => ({ ...p })),
        cam: v.cam,
        screen: v.screen,
      },
    });
    const view = get().view;
    // leaving a voice channel from its stage drops you back on the community
    if (!v.room && view.kind === 'voice') this.navigate({ kind: 'community', c: view.c, ch: null });
  }

  toggleCamera() {
    if (this.voice.cam) this.voice.stopCamera();
    else void this.voice.startCamera();
  }

  toggleScreen() {
    if (this.voice.screen) this.voice.stopScreen();
    else void this.voice.startScreen();
  }

  async addSound(file: File, name: string, emoji: string) {
    if (file.size > 1024 * 1024) throw new Error('Sounds must be under 1 MB.');
    if (!file.type.startsWith('audio/')) throw new Error('That is not an audio file.');
    const buf = await file.arrayBuffer();
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(buf.slice(0));
      if (decoded.duration > 8) throw new Error(`Sounds can be up to 8 seconds (this one is ${decoded.duration.toFixed(1)} s).`);
    } catch (e) {
      if ((e as Error).message.startsWith('Sounds can')) throw e;
      throw new Error('Could not decode that audio file.');
    } finally {
      void ctx.close();
    }
    const ref = await this.files.put(file, name, file.type);
    const sounds = [...this.settings.sounds.filter((s) => s.hash !== ref.hash), { hash: ref.hash, name: name.slice(0, 32) || 'sound', emoji: emoji || '🔊', mime: ref.mime, size: ref.size, volume: 0.8 }];
    await this.saveSettings({ ...this.settings, sounds });
  }

  async removeSound(hash: string) {
    await this.saveSettings({ ...this.settings, sounds: this.settings.sounds.filter((s) => s.hash !== hash) });
  }

  async playSound(hash: string) {
    const s = this.settings.sounds.find((x) => x.hash === hash);
    const blob = await this.files.getBlob(hash);
    if (!s || !blob) return;
    const ok = await this.voice.playSound(hash, blob, s.volume);
    if (!ok) toast(this.voice.room ? 'Unmute (or hold push-to-talk) to play sounds.' : 'Join a call to use the soundboard.', 'info');
  }

  private isForceMuted(pub: string) {
    if (this.friends.get(pub)?.state === 'blocked') return true;
    const room = this.voice.room;
    if (room?.kind === 'channel') {
      const st = this.convos.community(room.c);
      if (st && !(channelPerms(st, pub, room.ch, Date.now()) & P.SPEAK)) return true;
    }
    return false;
  }

  async startCall(c: string) {
    const x = this.convos.get(c);
    if (!x || x.rec.type === 'community') return;
    const callId = randomHex(8);
    const room: VoiceRoom = { kind: 'call', c, ch: 'call', callId, topic: this.topicOf.call(callId) };
    const ok = await this.voice.join(room);
    if (!ok) return;
    this.callHadPeer = false;
    const info: CallInfo = { c, callId, from: this.me, ctype: x.rec.type === 'dm' ? 'dm' : 'group', at: Date.now() };
    set({ outgoingCall: info });
    this.refreshTopics();
    const targets = x.rec.type === 'dm' ? [x.rec.peer!] : Object.keys(x.eng.state?.members ?? {}).filter((p) => p !== this.me);
    let reached = 0;
    for (const pub of targets) if (this.peers.appSignal(pub, { k: 'ring', callId, c, ctype: info.ctype })) reached++;
    if (!reached) toast('Could not reach the hub to ring them.', 'error');
    startRinging(true);
    if (this.callTimeout) clearTimeout(this.callTimeout);
    this.callTimeout = setTimeout(() => {
      if (!this.callHadPeer && this.voice.room?.callId === callId) {
        for (const pub of targets) void this.sendMail(pub, { type: 'call', action: 'missed', c });
        toast('No answer.', 'info');
        this.leaveVoice();
      }
    }, 35_000);
  }

  private cancelRing(info: CallInfo) {
    const x = this.convos.get(info.c);
    if (!x) return;
    const targets = x.rec.type === 'dm' ? [x.rec.peer!] : Object.keys(x.eng.state?.members ?? {}).filter((p) => p !== this.me);
    for (const pub of targets) this.peers.appSignal(pub, { k: 'ring-cancel', callId: info.callId });
  }

  private onCallRoomChange(addrs: string[]) {
    const others = addrs.filter((a) => a !== this.hub.addr);
    if (others.length) {
      if (!this.callHadPeer) {
        this.callHadPeer = true;
        stopRinging();
        if (this.callTimeout) clearTimeout(this.callTimeout);
      }
    } else if (this.callHadPeer) {
      const room = this.voice.room;
      if (room?.kind === 'call' && this.convos.get(room.c)?.rec.type === 'dm') {
        setTimeout(() => {
          const still = [...(this.topicPeers.get(room.topic)?.keys() ?? [])].filter((a) => a !== this.hub.addr);
          if (!still.length && this.voice.room?.topic === room.topic) {
            toast('Call ended.', 'info');
            this.leaveVoice();
          }
        }, 2500);
      }
    }
  }

  private onAppSignal(from: string, d: Record<string, unknown>) {
    const pub = from.slice(0, 64);
    if (d.k === 'ring') {
      const c = String(d.c ?? '');
      const callId = String(d.callId ?? '');
      const x = this.convos.get(c);
      if (!x || !/^[0-9a-f]{16}$/.test(callId)) return;
      if (x.rec.type === 'dm' ? x.rec.peer !== pub : !x.eng.state?.members[pub]) return;
      if (this.voice.room?.callId === callId) return;
      if (!this.settings.notify.calls || this.settings.status === 'dnd') return;
      const info: CallInfo = { c, callId, from: pub, ctype: x.rec.type === 'dm' ? 'dm' : 'group', at: Date.now() };
      set({ incomingCall: info });
      startRinging(false);
      desktopNotify('Incoming call', `${this.nameOf(pub)} is calling you`, null, () => undefined, 'call');
      setTimeout(() => {
        if (get().incomingCall?.callId === callId) {
          set({ incomingCall: null });
          stopRinging();
          toast(`Missed call from ${this.nameOf(pub)}`, 'info');
        }
      }, 32_000);
    } else if (d.k === 'ring-cancel') {
      if (get().incomingCall?.callId === d.callId) {
        set({ incomingCall: null });
        stopRinging();
      }
    } else if (d.k === 'ring-decline') {
      const out = get().outgoingCall;
      if (out && out.callId === d.callId && out.ctype === 'dm') {
        toast(`${this.nameOf(pub)} declined the call.`, 'info');
        this.leaveVoice();
      }
    }
  }

  async acceptCall() {
    const info = get().incomingCall;
    if (!info) return;
    stopRinging();
    set({ incomingCall: null });
    const room: VoiceRoom = { kind: 'call', c: info.c, ch: 'call', callId: info.callId, topic: this.topicOf.call(info.callId) };
    this.callHadPeer = true;
    const ok = await this.voice.join(room);
    if (!ok) return;
    this.refreshTopics();
    this.navigate({ kind: 'dm', c: info.c });
  }

  declineCall() {
    const info = get().incomingCall;
    if (!info) return;
    stopRinging();
    set({ incomingCall: null });
    this.peers.appSignal(info.from, { k: 'ring-decline', callId: info.callId });
  }

  // ===========================================================================
  // Settings, themes, fonts, vault
  // ===========================================================================

  async saveSettings(next: Settings) {
    this.settings = next;
    await this.db.put('kv', { k: 'settings', v: next });
    set({ settings: next });
    this.applyNetworkSettings();
    this.files.maxBytes = next.media.maxFileMB * 1024 * 1024;
    void this.voice.applySettings(next.voice);
    this.scheduleVault();
  }

  async setHubUrl(url: string) {
    await this.saveSettings({ ...this.settings, hubUrl: url });
    location.reload();
  }

  async saveTheme(theme: Theme) {
    await this.db.put('kv', { k: 'theme', v: theme });
    set({ theme, previewTheme: null });
    applyTheme(theme);
    await this.loadChatBgUrl(theme);
    this.navigate(get().view);
    this.scheduleVault();
  }

  async loadChatBgUrl(theme: Theme) {
    if (theme.chatBg.image) await this.publishUrl(theme.chatBg.image);
  }

  async saveThemeLibrary(themes: Theme[]) {
    await this.db.put('kv', { k: 'themes', v: themes });
    set({ savedThemes: themes });
    this.scheduleVault();
  }

  async addCustomFont(file: File) {
    if (file.size > 8 * 1024 * 1024) throw new Error('Font files must be under 8 MB.');
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (!sniffFont(head)) throw new Error('That is not a TTF, OTF, WOFF or WOFF2 font.');
    const ref = await this.files.put(file, file.name, 'font/' + (file.name.split('.').pop() ?? 'ttf'));
    const label = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').slice(0, 40);
    const key = await registerCustomFont(ref.hash, label, file);
    const list = ((await this.db.get('kv', 'fonts'))?.v as { hash: string; label: string }[] | undefined) ?? [];
    if (!list.some((f) => f.hash === ref.hash)) list.push({ hash: ref.hash, label });
    await this.db.put('kv', { k: 'fonts', v: list });
    set((s) => ({ customFonts: [...s.customFonts.filter((f) => f.hash !== ref.hash), { key, label, hash: ref.hash }] }));
    return key;
  }

  async removeCustomFont(hash: string) {
    const list = ((await this.db.get('kv', 'fonts'))?.v as { hash: string; label: string }[] | undefined) ?? [];
    await this.db.put('kv', { k: 'fonts', v: list.filter((f) => f.hash !== hash) });
    set((s) => ({ customFonts: s.customFonts.filter((f) => f.hash !== hash) }));
  }

  private vaultKey() {
    return sha256Bytes(concatBytes(this.keys.seed, utf8ToBytes('celchat/vault/v1')));
  }

  /** Everything needed to rebuild this account on a new device (no message history). */
  async accountData() {
    return {
      v: 1,
      friends: [...this.friends.values()].map(({ pub, state, since }) => ({ pub, state, since })),
      convos: this.convos.list().map((x) => ({ c: x.rec.c, type: x.rec.type, peer: x.rec.peer, joinCode: x.rec.joinCode, notify: x.rec.notify, muted: x.rec.muted, order: x.rec.order, left: x.rec.left })),
      settings: { ...this.settings, hubUrl: undefined },
      theme: get().theme,
      themes: get().savedThemes,
      profile: this.myCard,
    };
  }

  async applyAccountData(raw: unknown) {
    const d = raw as Awaited<ReturnType<CelApp['accountData']>>;
    if (!d || d.v !== 1) return;
    for (const f of d.friends ?? []) if (!this.friends.has(f.pub) && isHex(f.pub, 64)) await this.putFriend({ pub: f.pub, state: f.state, since: f.since });
    for (const c of d.convos ?? []) {
      if (this.convos.get(c.c) || !isHex(c.c, 64) || c.left) continue;
      if (c.type === 'dm' && c.peer) await this.convos.ensureDm(c.peer);
      else if (c.type === 'community' || c.type === 'group') await this.convos.ensure(c.c, c.type, { joinCode: c.joinCode, notify: c.notify, muted: c.muted, order: c.order });
    }
    const stored = (await this.db.get('kv', 'settings'))?.v;
    if (!stored && d.settings) await this.saveSettings(mergeSettings({ ...d.settings, hubUrl: this.settings.hubUrl }));
    const t = normalizeTheme(d.theme);
    if (t && !(await this.db.get('kv', 'themeSet'))) await this.saveTheme(t);
    if (Array.isArray(d.themes) && !get().savedThemes.length) await this.saveThemeLibrary(d.themes.map(normalizeTheme).filter((x): x is Theme => !!x));
    const card = verifyProfile(d.profile);
    if (card && card.pub === this.me && card.updatedAt > this.myCard.updatedAt) {
      this.myCard = card;
      await this.db.put('kv', { k: 'profile', v: card });
      set((s) => ({ myCard: card, profiles: { ...s.profiles, [this.me]: card } }));
    }
    this.refreshTopics();
    set({ convos: Object.fromEntries(this.convos.list().map((x) => [x.rec.c, { ...x.rec }])), states: Object.fromEntries(this.convos.list().map((x) => [x.rec.c, x.eng.state])) });
  }

  private scheduleVault() {
    if (!this.settings?.vaultSync) return;
    if (this.vaultTimer) clearTimeout(this.vaultTimer);
    this.vaultTimer = setTimeout(() => void this.pushVault(), 15_000);
  }

  private async pushVault() {
    if (!this.settings.vaultSync || this.hub.state !== 'online' || !this.hub.info?.features.vault) return;
    try {
      const plain = utf8ToBytes(JSON.stringify(await this.accountData()));
      const ct = await aesEncrypt(this.vaultKey(), plain);
      await this.hub.vaultPut(toB64(ct));
    } catch (e) {
      console.warn('[vault]', (e as Error).message);
    }
  }

  private async restoreVault() {
    if (!this.hub.info?.features.vault) return;
    try {
      const { blob } = await this.hub.vaultGet();
      await this.db.put('kv', { k: 'vaultChecked', v: Date.now() });
      if (!blob) return;
      const plain = await aesDecrypt(this.vaultKey(), fromB64(blob));
      await this.applyAccountData(JSON.parse(bytesToUtf8(plain)));
    } catch (e) {
      console.warn('[vault] restore failed', (e as Error).message);
    }
  }

  // ===========================================================================
  // Helpers for the UI
  // ===========================================================================

  nameOf(pub: string, c?: string): string {
    if (c) {
      const st = this.convos.community(c);
      const nick = st?.members[pub]?.nick;
      if (nick) return nick;
    }
    const card = pub === this.me ? this.myCard : this.profiles.get(pub);
    return card ? card.displayName.trim() || card.username : `user-${pub.slice(0, 6)}`;
  }

  plainText(text: string, c?: string) {
    return text
      .replace(/<@([0-9a-f]{64})>/g, (_, p) => '@' + this.nameOf(p, c))
      .replace(/<@&([0-9a-zA-Z_-]{6,64})>/g, (_, r) => '@' + (this.convos.community(c ?? '')?.roles[r]?.name ?? 'role'))
      .replace(/<#([0-9a-zA-Z_-]{6,40})>/g, (_, ch) => '#' + (this.convos.community(c ?? '')?.channels[ch]?.name ?? 'channel'))
      .replace(/[*_~`|>]/g, '');
  }

  async storageUsage() {
    const est = await navigator.storage?.estimate?.();
    const files = await this.files.usage();
    return { files, quota: est?.quota ?? null, usage: est?.usage ?? null, persisted: (await navigator.storage?.persisted?.()) ?? false };
  }

  async clearFileCache() {
    const keep = new Set<string>();
    if (this.myCard.avatar) keep.add(this.myCard.avatar.hash);
    if (this.myCard.banner) keep.add(this.myCard.banner.hash);
    const fonts = ((await this.db.get('kv', 'fonts'))?.v as { hash: string }[] | undefined) ?? [];
    for (const f of fonts) keep.add(f.hash);
    const bg = get().theme.chatBg.image;
    if (bg) keep.add(bg);
    await this.files.clearCache(keep);
    set((s) => ({ blobUrls: Object.fromEntries(Object.entries(s.blobUrls).filter(([h]) => keep.has(h))) }));
  }
}

/** '' = build default, 'mqtt' or 'mqtt:wss://a,wss://b' = serverless, ws(s)://... = a CelChat hub. */
export function resolveHub(url: string) {
  const u = url || (import.meta.env.VITE_SERVERLESS ? 'mqtt' : defaultHubUrl());
  if (u === 'mqtt') return { kind: 'mqtt' as const, brokers: PUBLIC_BROKERS };
  if (u.startsWith('mqtt:')) return { kind: 'mqtt' as const, brokers: u.slice(5).split(',').map((x) => x.trim()).filter(Boolean) };
  return { kind: 'hub' as const, url: u };
}

function makeHub(url: string, keys: Keys, dv: string, st: Presence): HubLike {
  const r = resolveHub(url);
  return r.kind === 'mqtt' ? new MqttHub(r.brokers, keys, dv, st) : new HubClient(r.url, keys, dv, st);
}

/** `<:name:hash:size>`: carries enough to fetch the image from peers even outside its community */
export const emojiToken = (name: string, a: AssetRef) => `<:${name}:${a.hash}:${a.size}>`;

function fmtIn(secs: number) {
  if (secs < 3600) return `in ${Math.round(secs / 60)} minutes`;
  if (secs < 86400) return `in ${Math.round(secs / 3600)} hour${secs >= 7200 ? 's' : ''}`;
  return `in ${Math.round(secs / 86400)} day${secs >= 172800 ? 's' : ''}`;
}

function randomAlnum(n: number) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

let current: CelApp | null = null;
export const app = () => {
  if (!current) throw new Error('CelChat is not signed in');
  return current;
};
export const hasApp = () => !!current;
export async function startApp(session: Session) {
  current?.dispose();
  current = new CelApp(session);
  await current.init();
  return current;
}

/**
 * Serverless transport: free public MQTT brokers stand in for the CelChat hub, so the static
 * website works with no server at all. Brokers are untrusted relays: every payload is encrypted
 * (presence with a key only members of a topic can derive, everything addressed to a device or
 * person with a sealed box), and anything that matters is signed by its author.
 *
 * Limits compared to a self-hosted hub: no public avatar cache, usernames are first-come but not
 * enforced (verify IDs), the offline mailbox lives as retained messages that brokers may expire,
 * and relay bandwidth is lower. Each broker operator sees encrypted traffic, topic hashes, timing
 * and your IP address.
 */
import mqtt, { type MqttClient } from 'mqtt';
import { Emitter } from './emitter';
import type { HubEvents, HubLike, HubState } from './hub';
import { aesDecrypt, aesEncrypt, seal, sha256Bytes, sha256Hex, signObject, unseal, verifyObject, type Keys } from '@shared/crypto';
import { bytesToHex, concatBytes, randomHex, utf8ToBytes, bytesToUtf8, isHex } from '@shared/bytes';
import { verifyProfile } from '@shared/profile';
import type { HubInfo, IceServer, Presence, TopicPeer } from '@shared/protocol';

export const PUBLIC_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const NS = 'celchat/v1';
const HEARTBEAT = 20_000;
const EXPIRE = 55_000;
const MAIL_TTL_S = 7 * 86400;
const MAX_PAYLOAD = 200 * 1024;

const INFO: HubInfo = {
  name: 'Public brokers (serverless)',
  version: '1',
  features: { mailbox: true, directory: true, assets: false, vault: true, relay: true, turn: false },
  limits: { mailItemBytes: MAX_PAYLOAD, mailUserBytes: 4 * 1024 * 1024, mailTtlDays: 7, assetBytes: 0, vaultBytes: 180 * 1024 },
};

const h = (s: string) => sha256Hex(s);

export class MqttHub extends Emitter<HubEvents> implements HubLike {
  readonly kind = 'mqtt' as const;
  state: HubState = 'offline';
  info: HubInfo | null = INFO;
  ice: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  addr: string;
  relayRate = 64 * 1024;
  status: Presence;
  readonly httpBase = '';
  private clients: MqttClient[] = [];
  private connected = new Set<MqttClient>();
  private seen = new Map<string, number>();
  private topics = new Map<string, Uint8Array>(); // presence topic id -> key
  private peers = new Map<string, Map<string, { st: Presence; at: number }>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readyFired = false;
  private myTopics: { dev: string; pub: string; mail: string };
  private mailIds = new Map<string, string>(); // mail id -> mqtt topic

  constructor(
    readonly brokers: string[],
    private keys: Keys,
    private dv: string,
    status: Presence,
  ) {
    super();
    this.status = status;
    this.addr = `${keys.pub}:${dv}`;
    this.myTopics = {
      dev: `${NS}/a/${h('a:' + this.addr)}`,
      pub: `${NS}/p/${h('p:' + keys.pub)}`,
      mail: `${NS}/m/${h('m:' + keys.pub)}`,
    };
  }

  connect() {
    if (this.clients.length) return;
    this.setState('connecting');
    for (const url of this.brokers) {
      const c = mqtt.connect(url, {
        protocolVersion: 5,
        clean: true,
        reconnectPeriod: 4000,
        connectTimeout: 12_000,
        keepalive: 45,
        clientId: 'cel_' + randomHex(10),
      });
      c.on('connect', () => {
        this.connected.add(c);
        c.subscribe([this.myTopics.dev, this.myTopics.pub, this.myTopics.mail + '/#', ...[...this.topics.keys()].map((t) => `${NS}/t/${t}`)], { qos: 1 });
        this.setState('online');
        if (!this.readyFired) {
          this.readyFired = true;
          this.emit('ready', { addr: this.addr, ice: this.ice, hub: INFO });
        }
        for (const t of this.topics.keys()) {
          this.announce(t, 'here');
          this.announce(t, 'who');
        }
      });
      c.on('close', () => {
        this.connected.delete(c);
        if (!this.connected.size) this.setState(this.clients.length ? 'connecting' : 'offline');
      });
      c.on('error', () => undefined);
      c.on('message', (topic, payload) => void this.onMessage(topic, new Uint8Array(payload)));
      this.clients.push(c);
    }
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT);
  }

  reconnectNow() {
    for (const c of this.clients) if (!c.connected) c.reconnect();
  }

  close() {
    // pre-encrypted goodbyes go out synchronously, so they still leave when the tab is closing
    for (const [t, box] of this.byes) this.publish(`${NS}/t/${t}`, box);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.end(true);
    this.clients = [];
    this.connected.clear();
    this.setState('offline');
  }

  private setState(s: HubState) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  private publish(topic: string, payload: Uint8Array | string, opts: { retain?: boolean; expiry?: number } = {}) {
    let sent = false;
    for (const c of this.connected) {
      c.publish(topic, payload as Buffer, { qos: 1, retain: !!opts.retain, properties: opts.expiry ? { messageExpiryInterval: opts.expiry } : undefined });
      sent = true;
    }
    return sent;
  }

  /** Both brokers deliver everything: drop duplicates by content hash. */
  private dup(topic: string, payload: Uint8Array) {
    const key = topic + bytesToHex(sha256Bytes(payload)).slice(0, 24);
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    if (this.seen.size > 5000) {
      const cut = Date.now() - 120_000;
      for (const [k, t] of this.seen) if (t < cut) this.seen.delete(k);
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Presence topics
  // ---------------------------------------------------------------------------

  sub(ids: string[], keys: Record<string, Uint8Array> = {}) {
    const fresh: string[] = [];
    for (const id of ids) {
      const key = keys[id] ?? this.topics.get(id);
      if (!key) continue;
      if (!this.topics.has(id)) fresh.push(id);
      this.topics.set(id, key);
    }
    for (const id of fresh) {
      for (const c of this.connected) c.subscribe(`${NS}/t/${id}`, { qos: 1 });
      this.peers.set(id, new Map());
      this.emit('topic', id, []);
      this.announce(id, 'here');
      this.announce(id, 'who');
    }
    if (fresh.length) void this.prepareByes();
  }

  unsub(ids: string[]) {
    for (const id of ids) {
      if (!this.topics.has(id)) continue;
      this.announce(id, 'bye');
      this.topics.delete(id);
      this.peers.delete(id);
      for (const c of this.connected) c.unsubscribe(`${NS}/t/${id}`);
    }
  }

  setStatus(st: Presence) {
    const was = this.status;
    this.status = st;
    for (const t of this.topics.keys()) {
      if (st === 'invisible' && was !== 'invisible') this.announce(t, 'bye');
      else this.announce(t, 'here');
    }
  }

  private announce(topic: string, k: 'here' | 'who' | 'bye') {
    const key = this.topics.get(topic);
    if (!key) return;
    if (this.status === 'invisible' && k === 'here') return;
    // invisible users still ask who is around, they just never say "here"
    const msg = signObject(this.keys, { k, addr: this.addr, st: this.status, ts: Date.now(), topic });
    void aesEncrypt(key, utf8ToBytes(JSON.stringify(msg)), utf8ToBytes(topic)).then((ct) => this.publish(`${NS}/t/${topic}`, ct));
  }

  private byes = new Map<string, Uint8Array>();

  /** keep a fresh signed+encrypted 'bye' per topic ready for page unload */
  private async prepareByes() {
    for (const [t, key] of this.topics) {
      const msg = signObject(this.keys, { k: 'bye', addr: this.addr, st: this.status, ts: Date.now(), topic: t });
      this.byes.set(t, await aesEncrypt(key, utf8ToBytes(JSON.stringify(msg)), utf8ToBytes(t)));
    }
    for (const t of [...this.byes.keys()]) if (!this.topics.has(t)) this.byes.delete(t);
  }

  private tick() {
    const now = Date.now();
    void this.prepareByes();
    for (const t of this.topics.keys()) this.announce(t, 'here');
    for (const [t, m] of this.peers) {
      for (const [addr, p] of m) {
        if (now - p.at > EXPIRE) {
          m.delete(addr);
          this.emit('tl', t, addr.slice(0, 64), addr.slice(65));
        }
      }
    }
  }

  private async onPresence(topic: string, payload: Uint8Array) {
    const key = this.topics.get(topic);
    if (!key) return;
    let msg: { k: string; addr: string; st: Presence; ts: number; topic: string; sig?: string };
    try {
      msg = JSON.parse(bytesToUtf8(await aesDecrypt(key, payload, utf8ToBytes(topic))));
    } catch {
      return;
    }
    if (!msg || typeof msg.addr !== 'string' || msg.addr.length !== 81 || msg.topic !== topic) return;
    if (Math.abs(Date.now() - msg.ts) > 120_000 || !verifyObject(msg.addr.slice(0, 64), msg)) return;
    if (msg.addr === this.addr) return;
    const m = this.peers.get(topic);
    if (!m) return;
    const peer: TopicPeer = { pub: msg.addr.slice(0, 64), dv: msg.addr.slice(65), st: ['online', 'idle', 'dnd'].includes(msg.st) ? msg.st : 'online' };
    if (msg.k === 'bye') {
      if (m.delete(msg.addr)) this.emit('tl', topic, peer.pub, peer.dv);
      return;
    }
    if (msg.k === 'who') {
      // answer after a random delay so a busy room does not reply all at once
      setTimeout(() => this.announce(topic, 'here'), 150 + Math.random() * 900);
      return;
    }
    const prev = m.get(msg.addr);
    m.set(msg.addr, { st: peer.st, at: Date.now() });
    if (!prev) this.emit('tj', topic, peer);
    else if (prev.st !== peer.st) this.emit('ts', topic, peer);
  }

  // ---------------------------------------------------------------------------
  // Signals and relay frames (sealed to the recipient)
  // ---------------------------------------------------------------------------

  private sendSealed(to: string, body: Record<string, unknown>) {
    const pub = to.slice(0, 64);
    if (!isHex(pub, 64)) return false;
    const topic = to.length === 64 ? `${NS}/p/${h('p:' + pub)}` : `${NS}/a/${h('a:' + to)}`;
    if (!this.connected.size) return false;
    void seal(pub, utf8ToBytes(JSON.stringify({ ...body, from: this.addr }))).then((box) => this.publish(topic, box));
    return true;
  }

  signal(to: string, d: unknown) {
    return this.sendSealed(to, { t: 'sig', d });
  }

  relay(to: string, d: string) {
    if (d.length > MAX_PAYLOAD) return false;
    return this.sendSealed(to, { t: 'relay', d });
  }

  private async onDirect(payload: Uint8Array) {
    let m: { t: string; from: string; d: unknown };
    try {
      m = JSON.parse(bytesToUtf8(await unseal(this.keys, payload)));
    } catch {
      return;
    }
    if (!m || typeof m.from !== 'string' || m.from.length !== 81) return;
    // `from` is not trusted here: signals carry their own signature and relay frames only
    // decrypt with the real sender's pairwise key, so a forged `from` goes nowhere.
    if (m.t === 'sig') this.emit('sig', m.from, m.d);
    else if (m.t === 'relay' && typeof m.d === 'string') this.emit('relay', m.from, m.d);
  }

  // ---------------------------------------------------------------------------
  // Mailbox: retained messages under the recipient's (hashed) prefix
  // ---------------------------------------------------------------------------

  async mailPut(to: string, box: string) {
    if (!this.connected.size) throw Object.assign(new Error('Not connected'), { code: 'offline' });
    if (box.length > MAX_PAYLOAD) throw Object.assign(new Error('Envelope too large'), { code: 'too_big' });
    const id = randomHex(12);
    this.publish(`${NS}/m/${h('m:' + to)}/${id}`, utf8ToBytes(JSON.stringify({ box, at: Date.now() })), { retain: true, expiry: MAIL_TTL_S });
  }

  fetchMail() {
    // retained mail arrives on (re)subscribe
    for (const c of this.connected) {
      c.unsubscribe(this.myTopics.mail + '/#', () => c.subscribe(this.myTopics.mail + '/#', { qos: 1 }));
    }
  }

  mailDel(ids: string[]) {
    for (const id of ids) {
      const topic = this.mailIds.get(id);
      if (!topic) continue;
      this.mailIds.delete(id);
      this.publish(topic, new Uint8Array(0), { retain: true });
    }
  }

  private onMail(topic: string, payload: Uint8Array) {
    if (!payload.length) return;
    const id = topic.slice(this.myTopics.mail.length + 1);
    if (!/^[0-9a-f]{24}$/.test(id) || this.mailIds.has(id)) return;
    try {
      const m = JSON.parse(bytesToUtf8(payload)) as { box: string; at: number };
      if (typeof m.box !== 'string') return;
      this.mailIds.set(id, topic);
      this.emit('mail', [{ id, box: m.box, at: Number(m.at) || Date.now() }]);
    } catch {
      /* junk */
    }
  }

  // ---------------------------------------------------------------------------
  // Directory + vault: retained, signed / encrypted
  // ---------------------------------------------------------------------------

  private once(topic: string, ms = 3500): Promise<Uint8Array | null> {
    return new Promise((res) => {
      const c = [...this.connected][0];
      if (!c) return res(null);
      let done = false;
      const finish = (v: Uint8Array | null) => {
        if (done) return;
        done = true;
        c.removeListener('message', on);
        c.unsubscribe(topic);
        res(v);
      };
      const on = (t: string, p: Buffer) => {
        if (t === topic && p.length) finish(new Uint8Array(p));
      };
      c.on('message', on);
      c.subscribe(topic, { qos: 1 });
      setTimeout(() => finish(null), ms);
    });
  }

  async dirGet(q: string) {
    const s = q.trim().toLowerCase().replace(/^@/, '');
    const topic = isHex(s, 64) ? `${NS}/dp/${h('dp:' + s)}` : `${NS}/d/${h('d:' + s)}`;
    const raw = await this.once(topic);
    if (!raw) return null;
    try {
      const card = verifyProfile(JSON.parse(bytesToUtf8(raw)));
      if (!card) return null;
      if (!isHex(s, 64) && card.username !== s) return null;
      if (isHex(s, 64) && card.pub !== s) return null;
      return card;
    } catch {
      return null;
    }
  }

  async dirPut(raw: unknown) {
    const card = verifyProfile(raw);
    if (!card || card.pub !== this.keys.pub) throw new Error('Invalid profile card');
    const existing = (await this.dirGet(card.username)) as { pub?: string } | null;
    if (existing?.pub && existing.pub !== card.pub) throw Object.assign(new Error('That username is already used on the public brokers'), { code: 'taken' });
    const json = utf8ToBytes(JSON.stringify(card));
    this.publish(`${NS}/d/${h('d:' + card.username)}`, json, { retain: true });
    this.publish(`${NS}/dp/${h('dp:' + card.pub)}`, json, { retain: true });
  }

  private vaultTopic() {
    return `${NS}/v/${bytesToHex(sha256Bytes(concatBytes(this.keys.seed, utf8ToBytes('celchat/vault-topic/v1'))))}`;
  }

  async vaultPut(blob: string) {
    if (blob.length > MAX_PAYLOAD) throw Object.assign(new Error('Vault too large for public brokers'), { code: 'too_big' });
    this.publish(this.vaultTopic(), utf8ToBytes(JSON.stringify({ blob, at: Date.now() })), { retain: true });
  }

  async vaultGet() {
    const raw = await this.once(this.vaultTopic());
    if (!raw) return { blob: null, at: null };
    try {
      const v = JSON.parse(bytesToUtf8(raw)) as { blob: string; at: number };
      return { blob: v.blob ?? null, at: v.at ?? null };
    } catch {
      return { blob: null, at: null };
    }
  }

  // ---------------------------------------------------------------------------

  private async onMessage(topic: string, payload: Uint8Array) {
    if (this.dup(topic, payload)) return;
    if (topic.startsWith(this.myTopics.mail + '/')) return this.onMail(topic, payload);
    if (topic === this.myTopics.dev || topic === this.myTopics.pub) return this.onDirect(payload);
    if (topic.startsWith(`${NS}/t/`)) return this.onPresence(topic.slice(NS.length + 3), payload);
  }
}

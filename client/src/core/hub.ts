import { Emitter } from './emitter';
import { sign, type Keys } from '@shared/crypto';
import { randomHex } from '@shared/bytes';
import { authMessage, type ClientToHub, type HubInfo, type HubToClient, type IceServer, type Presence, type TopicPeer } from '@shared/protocol';

export type HubState = 'offline' | 'connecting' | 'online';

export type HubEvents = {
  state: [HubState];
  ready: [{ addr: string; ice: IceServer[]; hub: HubInfo }];
  topic: [string, TopicPeer[]];
  tj: [string, TopicPeer];
  tl: [string, string, string];
  ts: [string, TopicPeer];
  sig: [string, unknown];
  relay: [string, string];
  mail: [{ id: string; box: string; at: number }[]];
  err: [{ code: string; msg: string; rid?: string; ref?: string }];
  replaced: [];
};

export function defaultHubUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export function httpBaseOf(wsUrl: string) {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '';
    return u.origin;
  } catch {
    return location.origin;
  }
}

/** Common surface of the WebSocket hub client and the serverless (public MQTT) transport. */
export interface HubLike extends Emitter<HubEvents> {
  state: HubState;
  info: HubInfo | null;
  ice: IceServer[];
  addr: string;
  relayRate: number;
  status: Presence;
  readonly httpBase: string;
  readonly kind: 'hub' | 'mqtt';
  connect(): void;
  reconnectNow(): void;
  close(): void;
  sub(ids: string[], keys?: Record<string, Uint8Array>): void;
  unsub(ids: string[]): void;
  setStatus(st: Presence): void;
  signal(to: string, d: unknown): boolean;
  relay(to: string, d: string): boolean;
  mailPut(to: string, box: string): Promise<void>;
  fetchMail(): void;
  mailDel(ids: string[]): void;
  dirPut(card: unknown): Promise<void>;
  dirGet(q: string): Promise<unknown>;
  vaultPut(blob: string): Promise<void>;
  vaultGet(): Promise<{ blob: string | null; at: number | null }>;
}

export class HubClient extends Emitter<HubEvents> implements HubLike {
  readonly kind = 'hub' as const;
  state: HubState = 'offline';
  info: HubInfo | null = null;
  ice: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
  addr = '';
  private ws: WebSocket | null = null;
  private pending = new Map<string, { res: (v: HubToClient) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private topics = new Set<string>();
  private backoff = 1000;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  status: Presence;
  /** relay budget the hub granted this connection (bytes of base64 per second) */
  relayRate = 256 * 1024;

  constructor(
    public url: string,
    private keys: Keys,
    private dv: string,
    status: Presence,
  ) {
    super();
    this.status = status;
  }

  get httpBase() {
    return httpBaseOf(this.url);
  }

  connect() {
    this.closed = false;
    if (this.ws) return;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      let m: HubToClient;
      try {
        m = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      this.ws = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.rej(new Error('Hub disconnected'));
      }
      this.pending.clear();
      this.setState('offline');
      if (!this.closed) this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleRetry() {
    if (this.retryTimer) return;
    const delay = this.backoff * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(this.backoff * 1.8, 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  reconnectNow() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.backoff = 1000;
    if (!this.ws) this.connect();
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }

  private setState(s: HubState) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  private raw(m: ClientToHub) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
      return true;
    }
    return false;
  }

  private onMessage(m: HubToClient) {
    switch (m.t) {
      case 'challenge':
        this.info = m.hub;
        this.raw({ t: 'auth', pub: this.keys.pub, dv: this.dv, sig: sign(this.keys, authMessage(m.nonce)), st: this.status });
        return;
      case 'ready':
        this.addr = m.addr;
        this.ice = m.ice;
        if (m.relayRate) this.relayRate = m.relayRate;
        this.info = m.hub;
        this.backoff = 1000;
        this.setState('online');
        if (this.topics.size) this.raw({ t: 'sub', topics: [...this.topics] });
        this.emit('ready', { addr: m.addr, ice: m.ice, hub: m.hub });
        return;
      case 'topic':
        return this.emit('topic', m.id, m.peers);
      case 'tj':
        return this.emit('tj', m.id, m.peer);
      case 'tl':
        return this.emit('tl', m.id, m.pub, m.dv);
      case 'ts':
        return this.emit('ts', m.id, m.peer);
      case 'sig':
        return this.emit('sig', m.from, m.d);
      case 'relay':
        return this.emit('relay', m.from, m.d);
      case 'mail':
        return this.emit('mail', m.items);
      case 'replaced':
        this.closed = true;
        return this.emit('replaced');
      case 'ok':
      case 'dir':
      case 'vault': {
        const p = this.pending.get(m.rid);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.rid);
          p.res(m);
        }
        return;
      }
      case 'err': {
        if (m.rid) {
          const p = this.pending.get(m.rid);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.rid);
            p.rej(Object.assign(new Error(m.msg), { code: m.code }));
            return;
          }
        }
        return this.emit('err', m);
      }
    }
  }

  private request<T extends HubToClient>(m: ClientToHub & { rid: string }, timeoutMs = 15000): Promise<T> {
    return new Promise((res, rej) => {
      if (!this.raw(m)) return rej(new Error('Not connected to the hub'));
      const timer = setTimeout(() => {
        this.pending.delete(m.rid);
        rej(new Error('Hub request timed out'));
      }, timeoutMs);
      this.pending.set(m.rid, { res: res as (v: HubToClient) => void, rej, timer });
    });
  }

  sub(ids: string[]) {
    const fresh = ids.filter((id) => !this.topics.has(id));
    for (const id of fresh) this.topics.add(id);
    if (fresh.length) this.raw({ t: 'sub', topics: fresh });
  }
  unsub(ids: string[]) {
    const gone = ids.filter((id) => this.topics.delete(id));
    if (gone.length) this.raw({ t: 'unsub', topics: gone });
  }
  setStatus(st: Presence) {
    this.status = st;
    this.raw({ t: 'status', st });
  }
  signal(to: string, d: unknown) {
    return this.raw({ t: 'sig', to, d });
  }
  relay(to: string, d: string) {
    return this.raw({ t: 'relay', to, d });
  }
  async mailPut(to: string, box: string) {
    await this.request({ t: 'mail.put', to, box, rid: randomHex(8) });
  }
  fetchMail() {
    this.raw({ t: 'mail.get' });
  }
  mailDel(ids: string[]) {
    if (ids.length) this.raw({ t: 'mail.del', ids });
  }
  async dirPut(card: unknown) {
    await this.request({ t: 'dir.put', card, rid: randomHex(8) });
  }
  async dirGet(q: string) {
    const r = await this.request<Extract<HubToClient, { t: 'dir' }>>({ t: 'dir.get', q, rid: randomHex(8) });
    return r.card;
  }
  async vaultPut(blob: string) {
    await this.request({ t: 'vault.put', blob, rid: randomHex(8) });
  }
  async vaultGet() {
    const r = await this.request<Extract<HubToClient, { t: 'vault' }>>({ t: 'vault.get', rid: randomHex(8) });
    return { blob: r.blob, at: r.at };
  }
}

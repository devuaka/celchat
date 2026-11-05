/**
 * Peer links. One RTCPeerConnection per remote device, with two negotiated
 * DataChannels (JSON + binary) and an optional audio transceiver. Signaling
 * messages are signed with the identity key, so the hub cannot MITM. If ICE
 * fails, links fall back to an end-to-end encrypted relay through the hub.
 */
import { Emitter } from './emitter';
import type { HubLike } from './hub';
import { aesDecrypt, aesEncrypt, pairKey, signObject, verifyObject, type Keys } from '@shared/crypto';
import { fromB64, toB64, utf8ToBytes, bytesToUtf8, concatBytes, randomHex } from '@shared/bytes';

export type LinkState = 'connecting' | 'direct' | 'relay' | 'closed';
export type MediaKind = 'mic' | 'cam' | 'screen' | 'screenAudio';
export type DirectPolicy = 'all' | 'friends' | 'never';

const FRAG = 60_000;
const DIRECT_TIMEOUT = 12_000;
const MAX_LINKS = 48;

type ManagerEvents = {
  open: [PeerConn];
  msg: [PeerConn, Record<string, unknown>];
  bin: [PeerConn, Uint8Array];
  close: [PeerConn];
  state: [PeerConn];
  track: [PeerConn, MediaStreamTrack, MediaStream];
  /** signed signal that is not WebRTC negotiation (e.g. call ringing) */
  app: [string, Record<string, unknown>];
};

export class PeerConn {
  readonly pub: string;
  readonly dv: string;
  state: LinkState = 'connecting';
  pc: RTCPeerConnection | null = null;
  dc: RTCDataChannel | null = null;
  bc: RTCDataChannel | null = null;
  helloSent = false;
  helloReceived = false;
  remoteInvisible = false;
  purposes = new Set<string>();
  lastUse = Date.now();
  /** last time anything arrived from the peer (pongs included) */
  lastRecv = Date.now();
  createdAt = Date.now();
  private makingOffer = false;
  private ignoreOffer = false;
  private relayKey: Uint8Array;
  private frags = new Map<string, { n: number; parts: string[]; got: number; at: number }>();
  private directTimer: ReturnType<typeof setTimeout> | null = null;
  private restarted = false;
  rtt: number | null = null;
  /** the remote tab/session we are talking to; a new one means they restarted */
  remoteSid: string | null = null;

  constructor(
    readonly mgr: PeerManager,
    readonly addr: string,
  ) {
    this.pub = addr.slice(0, 64);
    this.dv = addr.slice(65);
    this.relayKey = pairKey(mgr.keys, this.pub, 'relay/v1');
  }

  /** polite peer yields on offer collisions */
  get polite() {
    return this.mgr.addr < this.addr;
  }
  get usable() {
    return this.state === 'direct' || this.state === 'relay';
  }

  startDirect(ice: RTCIceServer[], relayOnly: boolean) {
    if (this.pc) return;
    const pc = new RTCPeerConnection({ iceServers: ice, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
    this.pc = pc;
    this.dc = pc.createDataChannel('cel', { negotiated: true, id: 0, ordered: true });
    this.bc = pc.createDataChannel('bin', { negotiated: true, id: 1, ordered: true });
    this.bc.binaryType = 'arraybuffer';
    this.bc.bufferedAmountLowThreshold = 512 * 1024;
    this.dc.onopen = () => this.onDirectOpen();
    this.dc.onclose = () => {
      if (this.state === 'direct') this.fallback('datachannel closed');
    };
    this.dc.onmessage = (ev) => this.onText(ev.data as string);
    this.bc.onmessage = (ev) => this.onBinary(new Uint8Array(ev.data as ArrayBuffer));
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.signal({ k: 'sdp', desc: pc.localDescription!.toJSON() });
      } catch (e) {
        console.warn('[peer] negotiation failed', e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal({ k: 'ice', cand: candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed') {
        if (!this.restarted) {
          this.restarted = true;
          pc.restartIce();
        } else this.fallback('ice failed');
      } else if (s === 'closed') this.fallback('pc closed');
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this.mgr.emit('track', this, ev.track, stream);
    };
    this.directTimer = setTimeout(() => {
      if (this.state === 'connecting') this.fallback('direct timeout');
    }, DIRECT_TIMEOUT);
  }

  private onDirectOpen() {
    if (this.directTimer) clearTimeout(this.directTimer);
    const was = this.state;
    this.state = 'direct';
    this.mgr.emit('state', this);
    if (was === 'connecting' || was === 'relay') this.announceOpen(was === 'connecting');
  }

  private announceOpen(first: boolean) {
    if (first || !this.helloSent) this.mgr.emit('open', this);
  }

  /** the remote can only talk through the relay (an archive peer): stop waiting for WebRTC */
  relayOnlyPeer() {
    if (this.directTimer) clearTimeout(this.directTimer);
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.dc = null;
    this.bc = null;
    this.fallback('peer is relay-only');
  }

  private fallback(why: string) {
    if (this.state === 'closed') return;
    if (this.state === 'relay') return;
    if (this.mgr.allowRelay && this.mgr.hub.info?.features.relay !== false) {
      const was = this.state;
      this.state = 'relay';
      this.mgr.emit('state', this);
      console.info(`[peer] ${this.addr.slice(0, 8)} using encrypted relay (${why})`);
      if (was === 'connecting') this.announceOpen(true);
    } else if (this.state === 'connecting' || this.state === 'direct') {
      console.info(`[peer] ${this.addr.slice(0, 8)} unreachable (${why})`);
      this.close();
    }
  }

  private lastUpgrade = 0;
  /**
   * A relayed link may become directly reachable later (network change, or the page got mic
   * access so Chrome stops hiding local IPs behind mDNS names). Restart ICE to try again.
   */
  tryDirect(force = false) {
    const pc = this.pc;
    if (!pc || this.state !== 'relay' || pc.signalingState === 'closed') return;
    if (!force && Date.now() - this.lastUpgrade < 90_000) return;
    this.lastUpgrade = Date.now();
    this.restarted = true;
    try {
      pc.restartIce();
    } catch {
      /* older browsers: stay on the relay */
    }
  }

  /** remote reached us through the relay */
  acceptRelay() {
    if (this.state === 'connecting') {
      this.state = 'relay';
      this.mgr.emit('state', this);
      this.announceOpen(true);
    }
  }

  signal(d: Record<string, unknown>) {
    const signed = signObject(this.mgr.keys, { ...d, from: this.mgr.addr, to: this.addr, ts: Date.now(), sid: this.mgr.sid });
    this.mgr.hub.signal(this.addr, signed);
  }

  private sigQ: Promise<void> = Promise.resolve();
  /**
   * Signals are applied strictly in arrival order. Handling them concurrently loses offers: an
   * offer that arrives while the previous answer is still being applied looks like a collision
   * to the impolite side, which then drops it and both sides wait forever.
   */
  onSignal(d: Record<string, unknown>) {
    this.sigQ = this.sigQ.then(() => this.applySignal(d)).catch((e) => console.warn('[peer] signal handling failed', e));
    return this.sigQ;
  }

  private async applySignal(d: Record<string, unknown>) {
    if (d.k === 'bye') {
      this.close(false);
      return;
    }
    if (!this.pc) this.startDirect(this.mgr.iceServers(), this.mgr.relayOnly);
    const pc = this.pc!;
    try {
      if (d.k === 'sdp') {
        const desc = d.desc as RTCSessionDescriptionInit;
        const collision = desc.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          this.signal({ k: 'sdp', desc: pc.localDescription!.toJSON() });
        }
      } else if (d.k === 'ice') {
        try {
          await pc.addIceCandidate(d.cand as RTCIceCandidateInit);
        } catch (e) {
          if (!this.ignoreOffer) console.debug('[peer] ice candidate rejected', e);
        }
      }
    } catch (e) {
      console.warn('[peer] signal handling failed', e);
    }
  }

  // ---- sending -----------------------------------------------------------

  send(obj: Record<string, unknown>) {
    if (!this.usable) return false;
    this.lastUse = Date.now();
    const s = JSON.stringify(obj);
    if (s.length <= FRAG) return this.sendText(s);
    const id = randomHex(6);
    const n = Math.ceil(s.length / FRAG);
    for (let i = 0; i < n; i++) this.sendText(JSON.stringify({ t: 'frag', id, i, n, s: s.slice(i * FRAG, (i + 1) * FRAG) }));
    return true;
  }

  private sendText(s: string) {
    if (this.state === 'direct' && this.dc?.readyState === 'open') {
      try {
        this.dc.send(s);
        return true;
      } catch {
        return false;
      }
    }
    if (this.state === 'relay') {
      void this.sendRelay(0, utf8ToBytes(s));
      return true;
    }
    return false;
  }

  /** Binary frames (file chunks). Resolves once there is room in the buffer. */
  async sendBin(data: Uint8Array): Promise<boolean> {
    if (!this.usable) return false;
    this.lastUse = Date.now();
    if (this.state === 'direct' && this.bc?.readyState === 'open') {
      if (this.bc.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise<void>((res) => {
          const bc = this.bc!;
          const done = () => {
            bc.removeEventListener('bufferedamountlow', done);
            res();
          };
          bc.addEventListener('bufferedamountlow', done);
          setTimeout(done, 5000);
        });
      }
      try {
        this.bc.send(data as Uint8Array<ArrayBuffer>);
        return true;
      } catch {
        return false;
      }
    }
    if (this.state === 'relay') {
      await this.sendRelay(1, data);
      return true;
    }
    return false;
  }

  private relayQueue: Promise<void> = Promise.resolve();
  private sendRelay(type: number, data: Uint8Array): Promise<void> {
    // keep frame order: encryption is async
    const job = this.relayQueue.then(async () => {
      const aad = utf8ToBytes(this.mgr.addr + '>' + this.addr);
      const ct = await aesEncrypt(this.relayKey, concatBytes(new Uint8Array([type]), data), aad);
      this.mgr.hub.relay(this.addr, toB64(ct));
    });
    this.relayQueue = job.catch(() => undefined);
    return job;
  }

  private relayInQueue: Promise<void> = Promise.resolve();
  onRelay(b64: string) {
    this.relayInQueue = this.relayInQueue.then(async () => {
      try {
        const aad = utf8ToBytes(this.addr + '>' + this.mgr.addr);
        const plain = await aesDecrypt(this.relayKey, fromB64(b64), aad);
        if (this.state !== 'direct') this.acceptRelay();
        if (plain[0] === 0) this.onText(bytesToUtf8(plain.subarray(1)));
        else this.onBinary(plain.subarray(1));
      } catch {
        /* undecryptable frame: drop */
      }
    });
  }

  // ---- receiving ---------------------------------------------------------

  private onText(s: string) {
    this.lastUse = Date.now();
    this.lastRecv = Date.now();
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(s);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'frag') {
      const id = String(m.id);
      const n = Number(m.n);
      const i = Number(m.i);
      if (!(n > 1 && n < 400 && i >= 0 && i < n)) return;
      let f = this.frags.get(id);
      if (!f) {
        if (this.frags.size > 20) this.frags.delete(this.frags.keys().next().value!);
        this.frags.set(id, (f = { n, parts: new Array(n), got: 0, at: Date.now() }));
      }
      if (f.parts[i] === undefined) {
        f.parts[i] = String(m.s);
        f.got++;
      }
      if (f.got === f.n) {
        this.frags.delete(id);
        this.onText(f.parts.join(''));
      }
      return;
    }
    if (m.t === 'ping') {
      this.send({ t: 'pong', ts: m.ts });
      return;
    }
    if (m.t === 'pong') {
      this.rtt = Date.now() - Number(m.ts);
      return;
    }
    this.mgr.emit('msg', this, m);
  }

  private onBinary(b: Uint8Array) {
    this.lastUse = Date.now();
    this.lastRecv = Date.now();
    this.mgr.emit('bin', this, b);
  }

  // ---- media (voice, camera, screen) ---------------------------------------

  /**
   * Each kind of media we send has its own transceiver, created by us and only ever used by us
   * (the remote side gets a recvonly one for it). Stopping keeps the m-line and just goes
   * inactive, so starting again is a cheap replaceTrack + renegotiation.
   */
  media: Partial<Record<MediaKind, RTCRtpTransceiver>> = {};

  setMedia(kind: MediaKind, track: MediaStreamTrack | null, stream: MediaStream | null, enc?: { maxBitrate?: number; maxFramerate?: number }) {
    const pc = this.pc;
    if (!pc || pc.connectionState === 'closed') return;
    let t = this.media[kind];
    if (t && t.currentDirection === 'stopped') t = undefined;
    if (track) {
      if (!t) {
        t = pc.addTransceiver(track, { direction: 'sendonly', streams: stream ? [stream] : [] });
        this.media[kind] = t;
      } else {
        void t.sender.replaceTrack(track);
        if (stream) t.sender.setStreams?.(stream);
        if (t.direction !== 'sendonly') t.direction = 'sendonly';
      }
      if (enc) {
        const apply = () => {
          const p = t!.sender.getParameters();
          if (!p.encodings?.length) return false;
          if (enc.maxBitrate) p.encodings[0].maxBitrate = enc.maxBitrate;
          if (enc.maxFramerate) p.encodings[0].maxFramerate = enc.maxFramerate;
          void t!.sender.setParameters(p).catch(() => undefined);
          return true;
        };
        // encodings only exist once negotiation ran
        if (!apply()) setTimeout(apply, 1500);
      }
    } else if (t) {
      void t.sender.replaceTrack(null);
      if (t.direction !== 'inactive') t.direction = 'inactive';
    }
  }

  setAudio(track: MediaStreamTrack | null, stream: MediaStream | null) {
    this.setMedia('mic', track, stream);
  }

  close(sayBye = true) {
    if (this.state === 'closed') return;
    if (sayBye) this.signal({ k: 'bye' });
    this.state = 'closed';
    if (this.directTimer) clearTimeout(this.directTimer);
    try {
      this.dc?.close();
      this.bc?.close();
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.mgr.remove(this);
    this.mgr.emit('close', this);
  }
}

export class PeerManager extends Emitter<ManagerEvents> {
  links = new Map<string, PeerConn>();
  /** per-tab session id, so peers can tell a restarted tab from the old one */
  readonly sid = randomHex(6);
  allowRelay = true;
  policy: DirectPolicy = 'all';
  /** decides whether we accept a link from this key at all */
  accept: (pub: string) => boolean = () => true;
  isFriend: (pub: string) => boolean = () => false;
  /** shares a community, group or DM with us (direct links are limited to these by default) */
  knows: (pub: string) => boolean = () => false;
  /** keys known to be relay-only (archive peers announce this in their signed profile) */
  relayOnlyKey: (pub: string) => boolean = () => false;
  private sweeper: ReturnType<typeof setInterval>;

  constructor(
    readonly keys: Keys,
    readonly hub: HubLike,
  ) {
    super();
    hub.on('sig', (from, d) => this.onSignal(from, d));
    hub.on('relay', (from, d) => this.onRelay(from, d));
    hub.on('err', (e) => {
      // the hub says that device is gone: whatever state the link is in, it is dead
      if (e.code === 'offline' && e.ref && e.ref.length > 64) this.links.get(e.ref)?.close(false);
    });
    this.sweeper = setInterval(() => this.sweep(), 20_000);
  }

  get addr() {
    return this.hub.addr;
  }

  iceServers(): RTCIceServer[] {
    return this.hub.ice as RTCIceServer[];
  }
  get relayOnly() {
    return this.policy === 'never' && !!this.hub.info?.features.turn;
  }
  directAllowed(pub: string) {
    if (this.policy === 'all') return this.isFriend(pub) || this.knows(pub);
    if (this.policy === 'friends') return this.isFriend(pub);
    return this.relayOnly; // 'never' still allows TURN-only connections, which hide your IP
  }

  /** Get or open a link to a device. */
  connect(addr: string, purpose: string): PeerConn | null {
    if (!this.addr || addr === this.addr || addr.length !== 81) return null;
    const pub = addr.slice(0, 64);
    if (!this.accept(pub)) return null;
    let l = this.links.get(addr);
    if (l) {
      l.purposes.add(purpose);
      return l;
    }
    if (this.links.size >= MAX_LINKS && !this.evict()) return null;
    l = new PeerConn(this, addr);
    l.purposes.add(purpose);
    this.links.set(addr, l);
    if (this.relayOnlyKey(pub) && this.allowRelay) {
      // archive peers have no WebRTC: go straight to the encrypted relay
      l.state = 'relay';
      queueMicrotask(() => this.emit('open', l!));
    } else if (this.directAllowed(pub)) {
      l.startDirect(this.iceServers(), this.relayOnly);
    } else {
      // relay-only by privacy policy: say hello through the hub
      l.state = 'relay';
      queueMicrotask(() => this.emit('open', l!));
    }
    return l;
  }

  release(addr: string, purpose: string) {
    this.links.get(addr)?.purposes.delete(purpose);
  }
  releaseAll(purpose: string) {
    for (const l of this.links.values()) l.purposes.delete(purpose);
  }

  remove(l: PeerConn) {
    if (this.links.get(l.addr) === l) this.links.delete(l.addr);
  }

  private evict(): boolean {
    let victim: PeerConn | null = null;
    for (const l of this.links.values()) {
      if (l.purposes.has('voice')) continue;
      if (!victim || l.purposes.size < victim.purposes.size || (l.purposes.size === victim.purposes.size && l.lastUse < victim.lastUse)) victim = l;
    }
    if (!victim) return false;
    victim.close();
    return true;
  }

  private sweep() {
    const now = Date.now();
    for (const l of [...this.links.values()]) {
      if (l.state === 'closed') continue;
      if (!l.purposes.size && now - l.lastUse > 120_000) l.close();
      else if (l.usable && now - l.lastRecv > 65_000) l.close(false); // silent for 3 pings: dead
      else if (l.usable) {
        l.send({ t: 'ping', ts: now });
        if (l.state === 'relay' && l.polite) l.tryDirect();
      }
    }
  }

  private onSignal(from: string, raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const d = raw as Record<string, unknown>;
    const pub = from.slice(0, 64);
    if (d.from !== from || typeof d.ts !== 'number' || Math.abs(Date.now() - d.ts) > 5 * 60_000) return;
    if (d.to !== this.addr && d.to !== this.keys.pub) return;
    if (!verifyObject(pub, d)) return;
    if (d.k === 'relay-only') {
      this.links.get(from)?.relayOnlyPeer();
      return;
    }
    if (d.k !== 'sdp' && d.k !== 'ice' && d.k !== 'bye') {
      if (this.accept(pub)) this.emit('app', from, d);
      return;
    }
    let l = this.links.get(from);
    const sid = typeof d.sid === 'string' ? d.sid : null;
    if (d.k === 'bye') {
      if (l && (!sid || !l.remoteSid || l.remoteSid === sid)) l.close(false);
      return;
    }
    if (l && sid && l.remoteSid && l.remoteSid !== sid) {
      // the other side restarted: the old connection is dead, start over
      const purposes = [...l.purposes];
      l.close(false);
      l = undefined;
      if (this.accept(pub) && this.directAllowed(pub)) {
        l = new PeerConn(this, from);
        for (const p of purposes) l.purposes.add(p);
        this.links.set(from, l);
        l.startDirect(this.iceServers(), this.relayOnly);
      }
    }
    if (!l) {
      if (!this.accept(pub) || !this.directAllowed(pub)) return;
      if (this.links.size >= MAX_LINKS && !this.evict()) return;
      l = new PeerConn(this, from);
      this.links.set(from, l);
      l.startDirect(this.iceServers(), this.relayOnly);
    }
    if (sid && !l.remoteSid) l.remoteSid = sid;
    void l.onSignal(d);
  }

  private onRelay(from: string, d: string) {
    if (!this.allowRelay || from.length !== 81) return;
    const pub = from.slice(0, 64);
    let l = this.links.get(from);
    if (!l) {
      if (!this.accept(pub)) return;
      if (this.links.size >= MAX_LINKS && !this.evict()) return;
      l = new PeerConn(this, from);
      this.links.set(from, l);
    }
    l.onRelay(d);
  }

  /** Signed application signal (ringing etc.) to a key (all devices) or one device. */
  appSignal(to: string, d: Record<string, unknown>) {
    const signed = signObject(this.keys, { ...d, from: this.addr, to, ts: Date.now() });
    return this.hub.signal(to, signed);
  }

  byPub(pub: string): PeerConn[] {
    return [...this.links.values()].filter((l) => l.pub === pub && l.usable);
  }

  closeAll() {
    clearInterval(this.sweeper);
    for (const l of [...this.links.values()]) l.close();
  }
}

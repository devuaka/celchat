/**
 * Calls and voice channels: a peer-to-peer mesh. Every participant sends to every other one over
 * the same peer connections used for data.
 *
 * Outgoing audio goes through a small Web Audio graph (mic -> gate -> mix <- soundboard) so
 * push-to-talk, mute and the soundboard all act on one track. Camera and screen share are extra
 * video transceivers; peers learn which incoming stream is which from an 'av' message.
 */
import { Emitter } from './emitter';
import type { PeerConn, PeerManager } from './peers';
import { LIMITS } from '@shared/limits';

export interface VoiceRoom {
  kind: 'channel' | 'call';
  /** conversation (community, dm or group) */
  c: string;
  /** channel id for community voice channels, 'call' for calls */
  ch: string;
  callId?: string;
  topic: string;
}

export interface VoicePeer {
  addr: string;
  pub: string;
  speaking: boolean;
  volume: number;
  localMute: boolean;
  connected: boolean;
  muted: boolean;
  deaf: boolean;
  cam: MediaStream | null;
  screen: MediaStream | null;
}

export type ScreenQuality = '720p30' | '1080p30' | '1080p60' | 'source';
export const SCREEN_QUALITY: Record<ScreenQuality, { label: string; height?: number; fps: number; bitrate: number }> = {
  '720p30': { label: '720p 30fps', height: 720, fps: 30, bitrate: 2_500_000 },
  '1080p30': { label: '1080p 30fps', height: 1080, fps: 30, bitrate: 4_000_000 },
  '1080p60': { label: '1080p 60fps', height: 1080, fps: 60, bitrate: 6_000_000 },
  source: { label: 'Source resolution', fps: 60, bitrate: 9_000_000 },
};

export interface VoiceSettings {
  inputId: string;
  outputId: string;
  cameraId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  sensitivity: number;
  mode: 'vad' | 'ptt';
  pttKey: string;
  pttReleaseMs: number;
  screenQuality: ScreenQuality;
}

type Events = { change: []; error: [string] };

interface Sound {
  buffer: AudioBuffer;
}

export class Voice extends Emitter<Events> {
  room: VoiceRoom | null = null;
  state: 'idle' | 'connecting' | 'connected' = 'idle';
  muted = false;
  deafened = false;
  speaking = false;
  /** push-to-talk key currently held */
  pttDown = false;
  /** raw microphone (for level metering) */
  private mic: MediaStream | null = null;
  /** what we actually send: the mixed, gated track */
  stream: MediaStream | null = null;
  cam: MediaStream | null = null;
  screen: MediaStream | null = null;
  peers = new Map<string, VoicePeer>();
  joinedAt = 0;
  private audios = new Map<string, { el: HTMLAudioElement; stream: MediaStream }>();
  private videos = new Map<string, Map<string, MediaStream>>();
  private announced = new Map<string, { cam: string | null; screen: string | null }>();
  private ctx: AudioContext | null = null;
  private gate: GainNode | null = null;
  private mix: MediaStreamAudioDestinationNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private analysers = new Map<string, { an: AnalyserNode; src: MediaStreamAudioSourceNode; last: number }>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private pttTimer: ReturnType<typeof setTimeout> | null = null;
  private sounds = new Map<string, Sound>();
  settings: VoiceSettings = {
    inputId: 'default',
    outputId: 'default',
    cameraId: 'default',
    noiseSuppression: true,
    echoCancellation: true,
    autoGain: true,
    sensitivity: 0.018,
    mode: 'vad',
    pttKey: 'Backquote',
    pttReleaseMs: 200,
    screenQuality: '1080p30',
  };
  /** set by the app: who must be muted for us (timeouts, blocks) */
  forceMuted: (pub: string) => boolean = () => false;
  volumes = new Map<string, number>();

  constructor(private mgr: PeerManager) {
    super();
    mgr.on('track', (l, track, stream) => this.onTrack(l, track, stream));
    mgr.on('close', (l) => {
      const p = this.peers.get(l.addr);
      if (p) {
        p.connected = false;
        this.emit('change');
      }
    });
    mgr.on('state', (l) => {
      // a link that just became direct can now carry media
      if (this.room && this.peers.has(l.addr) && l.state === 'direct') this.attachTo(l);
    });
    mgr.on('msg', (l, m) => {
      if (m.t !== 'av' || !this.peers.has(l.addr)) return;
      this.announced.set(l.addr, { cam: typeof m.cam === 'string' ? m.cam : null, screen: typeof m.screen === 'string' ? m.screen : null });
      const p = this.peers.get(l.addr)!;
      p.muted = !!m.muted;
      p.deaf = !!m.deaf;
      this.refreshVideo(l.addr);
      this.emit('change');
    });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.setPtt(false));
  }

  // ---- microphone + mix ----------------------------------------------------

  private async getMic(): Promise<MediaStream> {
    const s = this.settings;
    return navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: s.inputId && s.inputId !== 'default' ? { exact: s.inputId } : undefined,
        noiseSuppression: s.noiseSuppression,
        echoCancellation: s.echoCancellation,
        autoGainControl: s.autoGain,
        channelCount: 1,
      },
      video: false,
    });
  }

  private ensureCtx() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private buildGraph(mic: MediaStream) {
    const ctx = this.ensureCtx();
    this.micSource?.disconnect();
    if (!this.gate) {
      this.gate = ctx.createGain();
      this.mix = ctx.createMediaStreamDestination();
      this.gate.connect(this.mix);
    }
    this.micSource = ctx.createMediaStreamSource(mic);
    this.micSource.connect(this.gate);
    this.stream = this.mix!.stream;
    this.applyGate();
  }

  /** is the mic open right now? (mute, deafen and push-to-talk all close it) */
  get transmitting() {
    if (this.muted || this.deafened) return false;
    return this.settings.mode === 'vad' || this.pttDown;
  }

  private applyGate() {
    if (!this.gate || !this.ctx) return;
    this.gate.gain.setTargetAtTime(this.transmitting ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  async join(room: VoiceRoom) {
    if (this.room) this.leave();
    this.room = room;
    this.state = 'connecting';
    this.joinedAt = Date.now();
    this.emit('change');
    try {
      this.mic = await this.getMic();
    } catch (e) {
      this.room = null;
      this.state = 'idle';
      this.emit('error', micError(e));
      this.emit('change');
      return false;
    }
    if (this.room !== room) {
      this.mic.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.buildGraph(this.mic);
    this.watch('me', this.mic);
    this.state = 'connected';
    this.startLoop();
    this.emit('change');
    return true;
  }

  leave() {
    if (!this.room) return;
    this.stopCamera(false);
    this.stopScreen(false);
    for (const addr of [...this.peers.keys()]) this.dropPeer(addr, false);
    this.peers.clear();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.micSource?.disconnect();
    this.micSource = null;
    this.stream = null;
    this.room = null;
    this.state = 'idle';
    this.speaking = false;
    this.analysers.forEach((a) => a.src.disconnect());
    this.analysers.clear();
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.mgr.releaseAll('voice');
    this.emit('change');
  }

  // ---- participants ----------------------------------------------------------

  /** Room topic says who is here. */
  setParticipants(addrs: string[]) {
    if (!this.room) return;
    const want = new Set(addrs.filter((a) => a !== this.mgr.addr).slice(0, LIMITS.voiceRoomCap - 1));
    for (const addr of [...this.peers.keys()]) if (!want.has(addr)) this.dropPeer(addr, true);
    for (const addr of want) if (!this.peers.has(addr)) this.addPeer(addr);
    this.emit('change');
  }

  private addPeer(addr: string) {
    const pub = addr.slice(0, 64);
    this.peers.set(addr, { addr, pub, speaking: false, volume: this.volumes.get(pub) ?? 1, localMute: false, connected: false, muted: false, deaf: false, cam: null, screen: null });
    const l = this.mgr.connect(addr, 'voice');
    if (l) this.attachTo(l);
  }

  private attachTo(l: PeerConn) {
    if (!this.stream) return;
    if (l.state === 'direct' || l.pc) {
      l.setMedia('mic', this.stream.getAudioTracks()[0] ?? null, this.stream);
      if (this.cam) l.setMedia('cam', this.cam.getVideoTracks()[0], this.cam, { maxBitrate: 900_000 });
      if (this.screen) this.sendScreen(l);
    }
    // voice cannot use the data relay; with mic access granted a direct path often works now
    if (l.state === 'relay') l.tryDirect(true);
    const p = this.peers.get(l.addr);
    if (p) p.connected = l.usable;
    this.announceTo(l);
  }

  private sendScreen(l: PeerConn) {
    if (!this.screen) return;
    const q = SCREEN_QUALITY[this.settings.screenQuality];
    l.setMedia('screen', this.screen.getVideoTracks()[0] ?? null, this.screen, { maxBitrate: q.bitrate, maxFramerate: q.fps });
    const sa = this.screen.getAudioTracks()[0];
    if (sa) l.setMedia('screenAudio', sa, this.screen);
  }

  private announceTo(l: PeerConn) {
    l.send({ t: 'av', cam: this.cam?.id ?? null, screen: this.screen?.id ?? null, muted: this.muted, deaf: this.deafened });
  }

  private announce() {
    for (const addr of this.peers.keys()) {
      const l = this.mgr.links.get(addr);
      if (l?.usable) this.announceTo(l);
    }
  }

  private dropPeer(addr: string, emit: boolean) {
    const l = this.mgr.links.get(addr);
    if (l) {
      for (const k of ['mic', 'cam', 'screen', 'screenAudio'] as const) l.setMedia(k, null, null);
      l.purposes.delete('voice');
    }
    const a = this.audios.get(addr);
    if (a) {
      a.el.pause();
      a.el.srcObject = null;
      this.audios.delete(addr);
    }
    const an = this.analysers.get(addr);
    if (an) {
      an.src.disconnect();
      this.analysers.delete(addr);
    }
    this.videos.delete(addr);
    this.announced.delete(addr);
    this.peers.delete(addr);
    if (emit) this.emit('change');
  }

  private onTrack(l: PeerConn, track: MediaStreamTrack, stream: MediaStream) {
    if (track.kind === 'video') {
      let m = this.videos.get(l.addr);
      if (!m) this.videos.set(l.addr, (m = new Map()));
      m.set(stream.id, stream);
      track.addEventListener('unmute', () => this.refreshVideo(l.addr));
      track.addEventListener('mute', () => this.refreshVideo(l.addr));
      track.addEventListener('ended', () => this.refreshVideo(l.addr));
      this.refreshVideo(l.addr);
      return;
    }
    let a = this.audios.get(l.addr);
    if (!a) {
      const el = new Audio();
      el.autoplay = true;
      a = { el, stream: new MediaStream() };
      this.audios.set(l.addr, a);
    }
    if (!a.stream.getTracks().includes(track)) a.stream.addTrack(track);
    a.el.srcObject = a.stream;
    this.applyOutput(a.el);
    this.applyPeerVolume(l.addr);
    void a.el.play().catch(() => undefined);
    if (this.room) {
      this.ensureCtx();
      this.watch(l.addr, a.stream);
    }
    const p = this.peers.get(l.addr);
    if (p) {
      p.connected = true;
      this.emit('change');
    }
  }

  private refreshVideo(addr: string) {
    const p = this.peers.get(addr);
    if (!p) return;
    const ann = this.announced.get(addr);
    const vids = this.videos.get(addr);
    const live = (id: string | null | undefined) => {
      if (!id || !vids) return null;
      const s = vids.get(id);
      return s && s.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted) ? s : null;
    };
    p.cam = live(ann?.cam);
    p.screen = live(ann?.screen);
    this.emit('change');
  }

  // ---- camera + screen ---------------------------------------------------------

  async startCamera() {
    if (!this.room || this.cam) return;
    try {
      const id = this.settings.cameraId;
      this.cam = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: id && id !== 'default' ? { exact: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (e) {
      this.emit('error', camError(e));
      return;
    }
    this.cam.getVideoTracks()[0].addEventListener('ended', () => this.stopCamera());
    for (const addr of this.peers.keys()) {
      const l = this.mgr.links.get(addr);
      if (l) l.setMedia('cam', this.cam.getVideoTracks()[0], this.cam, { maxBitrate: 900_000 });
    }
    this.announce();
    this.emit('change');
  }

  stopCamera(emit = true) {
    if (!this.cam) return;
    this.cam.getTracks().forEach((t) => t.stop());
    this.cam = null;
    for (const addr of this.peers.keys()) this.mgr.links.get(addr)?.setMedia('cam', null, null);
    this.announce();
    if (emit) this.emit('change');
  }

  async startScreen() {
    if (!this.room || this.screen) return;
    const q = SCREEN_QUALITY[this.settings.screenQuality];
    try {
      this.screen = await navigator.mediaDevices.getDisplayMedia({
        video: { height: q.height ? { ideal: q.height } : undefined, frameRate: { ideal: q.fps, max: q.fps } },
        audio: true,
      });
    } catch (e) {
      if ((e as { name?: string }).name !== 'NotAllowedError') this.emit('error', 'Screen sharing failed: ' + String((e as Error).message ?? e));
      return;
    }
    const v = this.screen.getVideoTracks()[0];
    if (v) {
      v.contentHint = q.fps >= 60 ? 'motion' : 'detail';
      v.addEventListener('ended', () => this.stopScreen());
    }
    for (const addr of this.peers.keys()) {
      const l = this.mgr.links.get(addr);
      if (l) this.sendScreen(l);
    }
    this.announce();
    this.emit('change');
  }

  stopScreen(emit = true) {
    if (!this.screen) return;
    this.screen.getTracks().forEach((t) => t.stop());
    this.screen = null;
    for (const addr of this.peers.keys()) {
      const l = this.mgr.links.get(addr);
      l?.setMedia('screen', null, null);
      l?.setMedia('screenAudio', null, null);
    }
    this.announce();
    if (emit) this.emit('change');
  }

  // ---- soundboard ------------------------------------------------------------

  /** Play a clip to everyone in the call (and to yourself, quieter). */
  async playSound(key: string, blob: Blob, volume = 0.8) {
    if (!this.room || !this.mix || !this.transmitting) return false;
    const ctx = this.ensureCtx();
    let s = this.sounds.get(key);
    if (!s) {
      s = { buffer: await ctx.decodeAudioData(await blob.arrayBuffer()) };
      this.sounds.set(key, s);
    }
    const src = ctx.createBufferSource();
    src.buffer = s.buffer;
    const toPeers = ctx.createGain();
    toPeers.gain.value = volume;
    const toMe = ctx.createGain();
    toMe.gain.value = volume * 0.5;
    src.connect(toPeers).connect(this.mix);
    if (!this.deafened) src.connect(toMe).connect(ctx.destination);
    src.start();
    return true;
  }

  // ---- speaking detection ------------------------------------------------------

  private watch(key: string, stream: MediaStream) {
    if (!this.ctx || !stream.getAudioTracks().length) return;
    const old = this.analysers.get(key);
    if (old) old.src.disconnect();
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    this.analysers.set(key, { an, src, last: 0 });
  }

  private startLoop() {
    if (this.loop) return;
    const buf = new Float32Array(512);
    this.loop = setInterval(() => {
      let changed = false;
      const now = Date.now();
      for (const [key, a] of this.analysers) {
        a.an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        if (rms > this.settings.sensitivity) a.last = now;
        let on = now - a.last < 280;
        if (key === 'me') {
          on = on && this.transmitting;
          if (on !== this.speaking) {
            this.speaking = on;
            changed = true;
          }
        } else {
          const p = this.peers.get(key);
          if (p) {
            on = on && !p.localMute && !this.deafened && !this.forceMuted(p.pub);
            if (p.speaking !== on) {
              p.speaking = on;
              changed = true;
            }
          }
        }
      }
      if (changed) this.emit('change');
    }, 90);
  }

  // ---- controls ------------------------------------------------------------------

  setMuted(m: boolean) {
    this.muted = m;
    this.applyGate();
    this.announce();
    this.emit('change');
  }

  setDeafened(d: boolean) {
    this.deafened = d;
    this.applyGate();
    for (const addr of this.audios.keys()) this.applyPeerVolume(addr);
    this.announce();
    this.emit('change');
  }

  private isTyping() {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (this.settings.mode !== 'ptt' || !this.room || e.code !== this.settings.pttKey || e.repeat) return;
    if (down && this.isTyping()) return;
    this.setPtt(down);
  }

  /** push-to-talk; release is delayed a little so word endings are not clipped */
  setPtt(down: boolean) {
    if (this.pttTimer) clearTimeout(this.pttTimer);
    if (down) {
      if (this.pttDown) return;
      this.pttDown = true;
      this.applyGate();
      this.emit('change');
    } else if (this.pttDown) {
      this.pttTimer = setTimeout(() => {
        this.pttDown = false;
        this.applyGate();
        this.emit('change');
      }, this.settings.pttReleaseMs);
    }
  }

  setPeerVolume(pub: string, v: number) {
    this.volumes.set(pub, v);
    for (const [addr, p] of this.peers) {
      if (p.pub !== pub) continue;
      p.volume = v;
      this.applyPeerVolume(addr);
    }
    this.emit('change');
  }

  setLocalMute(addr: string, m: boolean) {
    const p = this.peers.get(addr);
    if (!p) return;
    p.localMute = m;
    this.applyPeerVolume(addr);
    this.emit('change');
  }

  refreshForced() {
    for (const addr of this.audios.keys()) this.applyPeerVolume(addr);
  }

  private applyPeerVolume(addr: string) {
    const a = this.audios.get(addr);
    if (!a) return;
    const p = this.peers.get(addr);
    const inRoom = !!p && !!this.room;
    const silent = !inRoom || this.deafened || p!.localMute || this.forceMuted(p!.pub);
    a.el.muted = silent;
    a.el.volume = Math.max(0, Math.min(1, p?.volume ?? 1));
  }

  private applyOutput(el: HTMLAudioElement) {
    const id = this.settings.outputId;
    const anyEl = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (anyEl.setSinkId && id) void anyEl.setSinkId(id === 'default' ? '' : id).catch(() => undefined);
  }

  async applySettings(next: Partial<VoiceSettings>) {
    const inputChanged =
      (next.inputId !== undefined && next.inputId !== this.settings.inputId) ||
      (next.noiseSuppression !== undefined && next.noiseSuppression !== this.settings.noiseSuppression) ||
      (next.echoCancellation !== undefined && next.echoCancellation !== this.settings.echoCancellation) ||
      (next.autoGain !== undefined && next.autoGain !== this.settings.autoGain);
    this.settings = { ...this.settings, ...next };
    for (const a of this.audios.values()) this.applyOutput(a.el);
    this.applyGate();
    if (inputChanged && this.mic && this.room) {
      try {
        const fresh = await this.getMic();
        this.mic.getTracks().forEach((t) => t.stop());
        this.mic = fresh;
        this.buildGraph(fresh);
        this.watch('me', fresh);
      } catch (e) {
        this.emit('error', micError(e));
      }
    }
    this.emit('change');
  }

  /** Mic test outside of calls: returns a stop function and reports level 0..1. */
  async testMic(onLevel: (v: number) => void): Promise<() => void> {
    const stream = await this.getMic();
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(512);
    const timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 6));
    }, 60);
    return () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    };
  }
}

function micError(e: unknown) {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Microphone permission was denied. Allow it in your browser settings to use voice.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found (or the selected one is unplugged).';
  if (name === 'NotReadableError') return 'Your microphone is in use by another app.';
  return 'Could not start the microphone: ' + String((e as Error)?.message ?? e);
}

function camError(e: unknown) {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Camera permission was denied.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found.';
  if (name === 'NotReadableError') return 'Your camera is in use by another app.';
  return 'Could not start the camera: ' + String((e as Error)?.message ?? e);
}

export async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: all.filter((d) => d.kind === 'audioinput'),
      outputs: all.filter((d) => d.kind === 'audiooutput'),
      cameras: all.filter((d) => d.kind === 'videoinput'),
    };
  } catch {
    return { inputs: [], outputs: [], cameras: [] };
  }
}

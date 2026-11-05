/**
 * P2P file transfer. Files live in IndexedDB keyed by sha256 and are pulled in
 * 16 KB chunks from any connected peer that has them. Receivers verify size
 * and hash before anything is stored or rendered.
 */
import { Emitter } from './emitter';
import type { AccountDb } from './db';
import type { PeerConn, PeerManager } from './peers';
import { sha256File } from '@shared/crypto';
import { bytesToHex, hexToBytes, concatBytes } from '@shared/bytes';
import { LIMITS } from '@shared/limits';
import { sniffMedia } from '@shared/protocol';
import type { AssetRef } from '@shared/ops';

const CHUNK = LIMITS.chunkBytes;
const STALL_MS = 12_000;

export type TransferState = 'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'canceled';

export interface Transfer {
  hash: string;
  size: number;
  name: string;
  mime: string;
  got: number;
  state: TransferState;
  error?: string;
  peer?: string;
  startedAt: number;
}

interface Active extends Transfer {
  chunks: (Uint8Array | undefined)[];
  count: number;
  tried: Set<string>;
  sources: () => string[];
  lastData: number;
  timer?: ReturnType<typeof setInterval>;
  publicUrl?: string;
  waiters: ((ok: boolean) => void)[];
}

type Events = { progress: [Transfer]; done: [string]; failed: [string, string] };

export class Files extends Emitter<Events> {
  private urls = new Map<string, string>();
  private active = new Map<string, Active>();
  private uploads = new Map<string, { cancel: boolean }>();
  /** mimes we have verified locally, by hash */
  sniffed = new Map<string, string | null>();
  maxBytes = 200 * 1024 * 1024;

  constructor(
    private db: AccountDb,
    private peers: PeerManager,
  ) {
    super();
    peers.on('msg', (l, m) => this.onMsg(l, m));
    peers.on('bin', (l, b) => this.onBin(l, b));
    peers.on('close', (l) => {
      for (const t of this.active.values()) if (t.peer === l.addr && t.state === 'downloading') this.nextSource(t);
    });
  }

  async put(blob: Blob, name: string, mime?: string): Promise<AssetRef & { name: string }> {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const hash = await sha256File(buf);
    const type = mime || blob.type || 'application/octet-stream';
    await this.db.put('blobs', { hash, mime: type, size: buf.length, name, data: new Blob([buf], { type }), addedAt: Date.now() });
    this.sniffed.set(hash, sniffMedia(buf.subarray(0, 64)));
    return { hash, mime: type, size: buf.length, name };
  }

  async has(hash: string) {
    return !!(await this.db.getKey('blobs', hash));
  }

  async getBlob(hash: string) {
    return (await this.db.get('blobs', hash))?.data ?? null;
  }

  /** Object URL for a stored blob, typed by its sniffed content (never trust the sender's mime). */
  async url(hash: string): Promise<string | null> {
    const have = this.urls.get(hash);
    if (have) return have;
    const rec = await this.db.get('blobs', hash);
    if (!rec) return null;
    const head = new Uint8Array(await rec.data.slice(0, 64).arrayBuffer());
    const kind = sniffMedia(head);
    this.sniffed.set(hash, kind);
    const typed = new Blob([rec.data], { type: kind ?? 'application/octet-stream' });
    const u = URL.createObjectURL(typed);
    this.urls.set(hash, u);
    return u;
  }

  transfer(hash: string): Transfer | null {
    return this.active.get(hash) ?? null;
  }

  /**
   * Fetch a file from peers (and optionally the hub's public avatar cache).
   * Resolves true when the verified file is stored locally.
   */
  fetch(ref: AssetRef & { name?: string }, sources: () => string[], publicUrl?: string): Promise<boolean> {
    return (async () => {
      if (await this.has(ref.hash)) return true;
      if (ref.size > this.maxBytes) return false;
      let t = this.active.get(ref.hash);
      if (t && (t.state === 'failed' || t.state === 'canceled')) {
        this.active.delete(ref.hash);
        t = undefined;
      }
      if (!t) {
        t = {
          hash: ref.hash,
          size: ref.size,
          name: ref.name ?? 'file',
          mime: ref.mime,
          got: 0,
          state: 'queued',
          startedAt: Date.now(),
          chunks: new Array(Math.ceil(ref.size / CHUNK)),
          count: 0,
          tried: new Set(),
          sources,
          lastData: Date.now(),
          publicUrl,
          waiters: [],
        };
        this.active.set(ref.hash, t);
        void this.begin(t);
      }
      const at = t;
      return new Promise<boolean>((res) => at.waiters.push(res));
    })();
  }

  retry(hash: string) {
    const t = this.active.get(hash);
    if (!t || (t.state !== 'failed' && t.state !== 'canceled')) return;
    t.state = 'queued';
    t.error = undefined;
    t.tried.clear();
    t.lastData = Date.now();
    void this.begin(t);
  }

  cancel(hash: string) {
    const t = this.active.get(hash);
    if (!t || t.state === 'done') return;
    if (t.peer) this.peers.links.get(t.peer)?.send({ t: 'fcancel', h: hash });
    this.finish(t, 'canceled', 'Canceled');
  }

  private async begin(t: Active) {
    if (t.publicUrl && t.tried.size === 0) {
      try {
        const r = await fetch(t.publicUrl);
        if (r.ok) {
          const buf = new Uint8Array(await r.arrayBuffer());
          if (buf.length === t.size && (await sha256File(buf)) === t.hash) {
            await this.storeVerified(t, buf);
            return;
          }
        }
      } catch {
        /* fall through to peers */
      }
    }
    this.nextSource(t);
    if (!t.timer)
      t.timer = setInterval(() => {
        if (t.state === 'downloading' && Date.now() - t.lastData > STALL_MS) this.nextSource(t);
        if (t.state === 'queued' && Date.now() - t.lastData > 4000) this.nextSource(t);
      }, 2000);
  }

  private nextSource(t: Active): void {
    if (t.state === 'done' || t.state === 'canceled' || t.state === 'verifying') return;
    const candidates = t.sources().filter((a) => !t.tried.has(a) && this.peers.links.get(a)?.usable);
    const addr = candidates[0];
    if (!addr) {
      const anyone = t.sources().some((a) => this.peers.links.get(a)?.usable);
      if (!anyone || t.tried.size >= 6) {
        if (Date.now() - t.startedAt > 20_000 || t.tried.size >= 6) {
          this.finish(t, 'failed', t.tried.size ? 'Nobody online has this file right now' : 'No peers online with this file');
        } else {
          t.state = 'queued';
          this.emit('progress', t);
        }
        return;
      }
      t.tried.clear();
      return this.nextSource(t);
    }
    t.tried.add(addr);
    t.peer = addr;
    t.state = 'downloading';
    t.lastData = Date.now();
    const from = t.chunks.findIndex((c) => c === undefined);
    this.peers.links.get(addr)!.send({ t: 'freq', h: t.hash, o: Math.max(0, from) });
    this.emit('progress', t);
  }

  private finish(t: Active, state: TransferState, error?: string) {
    t.state = state;
    t.error = error;
    if (t.timer) clearInterval(t.timer);
    t.timer = undefined;
    if (state !== 'done') t.chunks = new Array(Math.ceil(t.size / CHUNK));
    if (state !== 'done') {
      t.count = 0;
      t.got = 0;
    }
    this.emit('progress', t);
    if (state === 'done') this.emit('done', t.hash);
    else this.emit('failed', t.hash, error ?? state);
    const w = t.waiters.splice(0);
    for (const fn of w) fn(state === 'done');
  }

  private async storeVerified(t: Active, buf: Uint8Array) {
    await this.db.put('blobs', { hash: t.hash, mime: t.mime, size: t.size, name: t.name, data: new Blob([buf as Uint8Array<ArrayBuffer>]), addedAt: Date.now() });
    t.got = t.size;
    t.chunks = [];
    this.finish(t, 'done');
  }

  private onBin(l: PeerConn, b: Uint8Array) {
    if (b.length < 36) return;
    const hash = bytesToHex(b.subarray(0, 32));
    const t = this.active.get(hash);
    if (!t || t.state !== 'downloading' || t.peer !== l.addr) return;
    const idx = new DataView(b.buffer, b.byteOffset + 32, 4).getUint32(0);
    const n = t.chunks.length;
    if (idx >= n || t.chunks[idx]) return;
    const data = b.slice(36);
    const expected = idx === n - 1 ? t.size - idx * CHUNK : CHUNK;
    if (data.length !== expected) {
      this.nextSource(t);
      return;
    }
    t.chunks[idx] = data;
    t.count++;
    t.got += data.length;
    t.lastData = Date.now();
    if (t.count % 16 === 0 || t.count === n) this.emit('progress', t);
    if (t.count === n) void this.verify(t);
  }

  private async verify(t: Active) {
    t.state = 'verifying';
    this.emit('progress', t);
    const buf = concatBytes(...(t.chunks as Uint8Array[]));
    if (buf.length !== t.size || (await sha256File(buf)) !== t.hash) {
      // a peer sent garbage: drop everything from them and start over elsewhere
      t.chunks = new Array(Math.ceil(t.size / CHUNK));
      t.count = 0;
      t.got = 0;
      t.state = 'downloading';
      this.nextSource(t);
      return;
    }
    await this.storeVerified(t, buf);
  }

  // ---- serving -------------------------------------------------------------

  private onMsg(l: PeerConn, m: Record<string, unknown>) {
    if (m.t === 'freq') void this.serve(l, String(m.h ?? ''), Number(m.o ?? 0));
    else if (m.t === 'fcancel') {
      const u = this.uploads.get(l.addr + String(m.h));
      if (u) u.cancel = true;
    } else if (m.t === 'ferr') {
      const t = this.active.get(String(m.h ?? ''));
      if (t && t.peer === l.addr) this.nextSource(t);
    }
  }

  private async serve(l: PeerConn, hash: string, offset: number) {
    if (!/^[0-9a-f]{64}$/.test(hash)) return;
    const key = l.addr + hash;
    if (this.uploads.has(key)) return;
    const rec = await this.db.get('blobs', hash);
    if (!rec) {
      l.send({ t: 'ferr', h: hash, why: 'missing' });
      return;
    }
    const active = [...this.uploads.keys()].filter((k) => k.startsWith(l.addr)).length;
    if (active >= 3) {
      l.send({ t: 'ferr', h: hash, why: 'busy' });
      return;
    }
    const job = { cancel: false };
    this.uploads.set(key, job);
    try {
      const n = Math.ceil(rec.size / CHUNK);
      const head = hexToBytes(hash);
      for (let i = Math.max(0, Math.floor(offset)); i < n; i++) {
        if (job.cancel || !l.usable) break;
        const slice = new Uint8Array(await rec.data.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
        const frame = new Uint8Array(36 + slice.length);
        frame.set(head, 0);
        new DataView(frame.buffer).setUint32(32, i);
        frame.set(slice, 36);
        if (!(await l.sendBin(frame))) break;
        if (l.state === 'relay' && i % 8 === 7) await new Promise((r) => setTimeout(r, 450));
      }
    } finally {
      this.uploads.delete(key);
    }
  }

  async usage() {
    let bytes = 0;
    let count = 0;
    let cur = await this.db.transaction('blobs').store.openCursor();
    while (cur) {
      bytes += cur.value.size;
      count++;
      cur = await cur.continue();
    }
    return { bytes, count };
  }

  async clearCache(keep: Set<string>) {
    const tx = this.db.transaction('blobs', 'readwrite');
    let cur = await tx.store.openCursor();
    while (cur) {
      if (!keep.has(cur.key)) {
        const u = this.urls.get(cur.key);
        if (u) {
          URL.revokeObjectURL(u);
          this.urls.delete(cur.key);
        }
        await cur.delete();
      }
      cur = await cur.continue();
    }
    await tx.done;
  }
}

/**
 * Relay links for the archive peer. Same wire format as the browser client's relay mode:
 * AES-256-GCM with an X25519-derived pairwise key, aad = "from>to", plaintext = type byte + data,
 * JSON frames over 60 KB are split into {t:'frag'} pieces. The hub only ever sees ciphertext.
 */
import type { HubClient } from '../../client/src/core/hub';
import { aesDecrypt, aesEncrypt, pairKey, type Keys } from '@shared/crypto';
import { concatBytes, fromB64, randomHex, toB64, utf8ToBytes, bytesToUtf8 } from '@shared/bytes';

const FRAG = 60_000;

/** Paces everything we push through the hub so we stay inside our relay budget. */
export class Pacer {
  rate = 200 * 1024;
  private tokens = 200 * 1024;
  private last = Date.now();
  private queue: { to: string; make: () => Promise<string>; done: (ok: boolean) => void }[] = [];
  private running = false;

  constructor(private hub: HubClient) {}

  push(to: string, make: () => Promise<string>): Promise<boolean> {
    return new Promise((done) => {
      this.queue.push({ to, make, done });
      void this.run();
    });
  }

  get backlog() {
    return this.queue.length;
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        let b64: string;
        try {
          b64 = await job.make();
        } catch {
          job.done(false);
          continue;
        }
        for (;;) {
          const now = Date.now();
          this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
          this.last = now;
          if (this.tokens >= b64.length || b64.length > this.rate) break;
          await new Promise((r) => setTimeout(r, Math.ceil(((b64.length - this.tokens) / this.rate) * 1000)));
        }
        this.tokens -= b64.length;
        job.done(this.hub.relay(job.to, b64));
      }
    } finally {
      this.running = false;
    }
  }

  drop(to: string) {
    this.queue = this.queue.filter((j) => {
      if (j.to !== to) return true;
      j.done(false);
      return false;
    });
  }
}

export interface LinkHost {
  keys: Keys;
  addr: () => string;
  pacer: Pacer;
  onMessage: (l: RelayLink, m: Record<string, unknown>) => Promise<void> | void;
  onBinary: (l: RelayLink, b: Uint8Array) => void;
}

export class RelayLink {
  readonly pub: string;
  readonly dv: string;
  helloSent = false;
  helloReceived = false;
  lastRecv = Date.now();
  createdAt = Date.now();
  /** communities this device was seen in (topic membership) */
  topics = new Set<string>();
  closed = false;
  private key: Uint8Array;
  private frags = new Map<string, { n: number; parts: string[]; got: number }>();
  private inQ: Promise<void> = Promise.resolve();

  constructor(
    private host: LinkHost,
    readonly addr: string,
  ) {
    this.pub = addr.slice(0, 64);
    this.dv = addr.slice(65);
    this.key = pairKey(host.keys, this.pub, 'relay/v1');
  }

  private frame(type: number, data: Uint8Array) {
    if (this.closed) return Promise.resolve(false);
    const aad = utf8ToBytes(this.host.addr() + '>' + this.addr);
    return this.host.pacer.push(this.addr, async () => toB64(await aesEncrypt(this.key, concatBytes(new Uint8Array([type]), data), aad)));
  }

  send(obj: Record<string, unknown>) {
    const s = JSON.stringify(obj);
    if (s.length <= FRAG) return this.frame(0, utf8ToBytes(s));
    const id = randomHex(6);
    const n = Math.ceil(s.length / FRAG);
    let last: Promise<boolean> = Promise.resolve(true);
    for (let i = 0; i < n; i++) last = this.frame(0, utf8ToBytes(JSON.stringify({ t: 'frag', id, i, n, s: s.slice(i * FRAG, (i + 1) * FRAG) })));
    return last;
  }

  sendBin(data: Uint8Array) {
    return this.frame(1, data);
  }

  receive(b64: string) {
    this.inQ = this.inQ.then(async () => {
      let plain: Uint8Array;
      try {
        plain = await aesDecrypt(this.key, fromB64(b64), utf8ToBytes(this.addr + '>' + this.host.addr()));
      } catch {
        return;
      }
      this.lastRecv = Date.now();
      if (plain[0] === 1) return this.host.onBinary(this, plain.subarray(1));
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(bytesToUtf8(plain.subarray(1)));
      } catch {
        return;
      }
      if (m?.t === 'frag') {
        const id = String(m.id);
        const n = Number(m.n);
        const i = Number(m.i);
        if (!(n > 1 && n < 400 && i >= 0 && i < n)) return;
        let f = this.frags.get(id);
        if (!f) {
          if (this.frags.size > 20) this.frags.delete(this.frags.keys().next().value!);
          this.frags.set(id, (f = { n, parts: new Array(n), got: 0 }));
        }
        if (f.parts[i] === undefined) {
          f.parts[i] = String(m.s);
          f.got++;
        }
        if (f.got === f.n) {
          this.frags.delete(id);
          try {
            m = JSON.parse(f.parts.join(''));
          } catch {
            return;
          }
        } else return;
      }
      // handled strictly in order: 'sdone' must not overtake the 'sops' before it
      if (m && typeof m === 'object') await this.host.onMessage(this, m);
    });
  }

  close() {
    this.closed = true;
    this.host.pacer.drop(this.addr);
  }
}

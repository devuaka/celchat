/** Classic token bucket: `rate` tokens per second, up to `burst`. */
export class Bucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private rate: number,
    private burst: number,
  ) {
    this.tokens = burst;
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** Per-key buckets with idle eviction (for per-IP HTTP limits). */
export class KeyedBuckets {
  private map = new Map<string, { b: Bucket; seen: number }>();
  constructor(
    private rate: number,
    private burst: number,
  ) {
    setInterval(() => {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [k, v] of this.map) if (v.seen < cutoff) this.map.delete(k);
    }, 60_000).unref();
  }
  take(key: string, n = 1) {
    let e = this.map.get(key);
    if (!e) {
      e = { b: new Bucket(this.rate, this.burst), seen: Date.now() };
      this.map.set(key, e);
    }
    e.seen = Date.now();
    return e.b.take(n);
  }
}

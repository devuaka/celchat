/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (...a: any[]) => void;

export class Emitter<E extends Record<string, unknown[]>> {
  private handlers = new Map<keyof E, Set<Handler>>();
  on<K extends keyof E>(k: K, fn: (...a: E[K]) => void): () => void {
    let s = this.handlers.get(k);
    if (!s) this.handlers.set(k, (s = new Set()));
    s.add(fn as Handler);
    return () => s!.delete(fn as Handler);
  }
  emit<K extends keyof E>(k: K, ...a: E[K]) {
    const s = this.handlers.get(k);
    if (!s) return;
    for (const fn of [...s]) {
      try {
        fn(...a);
      } catch (e) {
        console.error('[emitter]', String(k), e);
      }
    }
  }
}

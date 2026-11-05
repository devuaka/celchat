/**
 * Deterministic JSON: sorted keys, undefined dropped, finite numbers only.
 * Every signature in CelChat is computed over canonical bytes, so two peers
 * always hash the same structure the same way.
 */
export function canonical(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new Error('canonical: non-finite number');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',') + ']';
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
    }
    default:
      throw new Error('canonical: unsupported type ' + typeof v);
  }
}

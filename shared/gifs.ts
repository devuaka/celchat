/**
 * GIF search providers. Google shut the Tenor API down on 2026-06-30; KLIPY offers the same v2
 * request/response shape (api.klipy.com), GIPHY has its own. Used by the hub's proxy and by
 * clients that bring their own key. Results are normalized to one shape.
 */
export type GifProvider = 'klipy' | 'giphy' | 'tenor-compatible';

export interface GifResult {
  id: string;
  title: string;
  preview: { url: string; w: number; h: number };
  full: { url: string; w: number; h: number; size: number };
}

export interface GifPage {
  results: GifResult[];
  next: string | null;
}

export const GIF_MAX_SEND_BYTES = 8 * 1024 * 1024;

export const PROVIDER_INFO: Record<GifProvider, { label: string; placeholder: string; attribution: string; base: string }> = {
  klipy: { label: 'KLIPY', placeholder: 'Search KLIPY', attribution: 'Powered by KLIPY', base: 'https://api.klipy.com' },
  giphy: { label: 'GIPHY', placeholder: 'Search GIPHY', attribution: 'Powered by GIPHY', base: 'https://api.giphy.com' },
  'tenor-compatible': { label: 'Tenor-compatible API', placeholder: 'Search GIFs', attribution: '', base: '' },
};

export function gifUrl(provider: GifProvider, base: string, key: string, kind: 'search' | 'featured', q: string, pos: string | null, filter: 'off' | 'low' | 'medium' | 'high') {
  const b = (base || PROVIDER_INFO[provider].base).replace(/\/+$/, '');
  if (provider === 'giphy') {
    const rating = { off: 'r', low: 'r', medium: 'pg-13', high: 'g' }[filter];
    const u = new URL(`${b}/v1/gifs/${kind === 'search' ? 'search' : 'trending'}`);
    u.searchParams.set('api_key', key);
    if (kind === 'search') u.searchParams.set('q', q);
    u.searchParams.set('limit', '30');
    u.searchParams.set('rating', rating);
    if (pos) u.searchParams.set('offset', pos);
    return u.toString();
  }
  // Tenor v2 shape (KLIPY, or any compatible server)
  const u = new URL(`${b}/v2/${kind}`);
  u.searchParams.set('key', key);
  if (kind === 'search') u.searchParams.set('q', q);
  u.searchParams.set('limit', '30');
  u.searchParams.set('contentfilter', filter);
  u.searchParams.set('media_filter', 'gif,mediumgif,tinygif,nanogif');
  if (pos) u.searchParams.set('pos', pos);
  return u.toString();
}

type Media = { url?: string; dims?: number[]; size?: number };

export function normalizeGifs(provider: GifProvider, json: unknown): GifPage {
  const out: GifResult[] = [];
  if (provider === 'giphy') {
    const j = json as { data?: { id: string; title?: string; images?: Record<string, { url?: string; width?: string; height?: string; size?: string }> }[]; pagination?: { offset: number; count: number; total_count: number } };
    for (const g of j.data ?? []) {
      const im = g.images ?? {};
      const prev = im.fixed_width_small ?? im.fixed_width ?? im.preview_gif;
      const candidates = [im.original, im.downsized_large, im.downsized_medium, im.downsized, im.fixed_width].filter(Boolean) as { url?: string; width?: string; height?: string; size?: string }[];
      const full = candidates.find((c) => c.url && Number(c.size ?? 0) > 0 && Number(c.size) <= GIF_MAX_SEND_BYTES) ?? candidates.find((c) => c.url);
      if (!prev?.url || !full?.url) continue;
      out.push({
        id: g.id,
        title: g.title ?? '',
        preview: { url: prev.url, w: Number(prev.width) || 200, h: Number(prev.height) || 150 },
        full: { url: full.url, w: Number(full.width) || 200, h: Number(full.height) || 150, size: Number(full.size) || 0 },
      });
    }
    const p = j.pagination;
    const next = p && p.offset + p.count < p.total_count ? String(p.offset + p.count) : null;
    return { results: out, next };
  }
  const j = json as { results?: { id: string; title?: string; content_description?: string; media_formats?: Record<string, Media> }[]; next?: string };
  for (const r of j.results ?? []) {
    const mf = r.media_formats ?? {};
    const prev = mf.tinygif ?? mf.nanogif ?? mf.gif;
    const full = [mf.gif, mf.mediumgif, mf.tinygif].find((m) => m?.url && (m.size ?? 0) <= GIF_MAX_SEND_BYTES) ?? mf.tinygif;
    if (!prev?.url || !full?.url) continue;
    out.push({
      id: String(r.id),
      title: r.title || r.content_description || '',
      preview: { url: prev.url, w: prev.dims?.[0] ?? 200, h: prev.dims?.[1] ?? 150 },
      full: { url: full.url, w: full.dims?.[0] ?? 200, h: full.dims?.[1] ?? 150, size: full.size ?? 0 },
    });
  }
  return { results: out, next: j.next && j.next !== '0' ? j.next : null };
}

/** Only these hosts may be fetched through the hub's media proxy. */
export function isGifMediaHost(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    return h.endsWith('.klipy.com') || h.endsWith('.klipy.co') || h === 'giphy.com' || h.endsWith('.giphy.com') || h.endsWith('.tenor.com');
  } catch {
    return false;
  }
}

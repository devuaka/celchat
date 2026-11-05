import { describe, it, expect } from 'vitest';
import { gifUrl, normalizeGifs, isGifMediaHost } from '@shared/gifs';

describe('gif providers', () => {
  it('builds Tenor-v2-style KLIPY requests', () => {
    const u = new URL(gifUrl('klipy', '', 'K', 'search', 'cats', 'abc', 'medium'));
    expect(u.origin + u.pathname).toBe('https://api.klipy.com/v2/search');
    expect(u.searchParams.get('key')).toBe('K');
    expect(u.searchParams.get('q')).toBe('cats');
    expect(u.searchParams.get('pos')).toBe('abc');
    expect(u.searchParams.get('contentfilter')).toBe('medium');
    expect(new URL(gifUrl('klipy', '', 'K', 'featured', '', null, 'high')).pathname).toBe('/v2/featured');
  });

  it('normalizes the KLIPY/Tenor v2 response shape', () => {
    const page = normalizeGifs('klipy', {
      results: [
        {
          id: '42',
          title: 'cat',
          media_formats: {
            gif: { url: 'https://static.klipy.com/a/big.gif', dims: [498, 498], size: 2614179 },
            tinygif: { url: 'https://static.klipy.com/a/tiny.gif', dims: [220, 220], size: 149153 },
          },
        },
      ],
      next: 'CAgQ',
    });
    expect(page.next).toBe('CAgQ');
    expect(page.results[0].preview.url).toContain('tiny.gif');
    expect(page.results[0].full).toEqual({ url: 'https://static.klipy.com/a/big.gif', w: 498, h: 498, size: 2614179 });
  });

  it('prefers a sendable size when the original is huge', () => {
    const page = normalizeGifs('tenor-compatible', {
      results: [
        {
          id: '1',
          media_formats: {
            gif: { url: 'https://media.tenor.com/x.gif', dims: [1000, 1000], size: 30_000_000 },
            mediumgif: { url: 'https://media.tenor.com/m.gif', dims: [500, 500], size: 3_000_000 },
            tinygif: { url: 'https://media.tenor.com/t.gif', dims: [200, 200], size: 100_000 },
          },
        },
      ],
    });
    expect(page.results[0].full.url).toContain('m.gif');
    expect(page.next).toBeNull();
  });

  it('normalizes GIPHY with offset pagination', () => {
    const page = normalizeGifs('giphy', {
      data: [
        {
          id: 'g1',
          title: 'dance',
          images: {
            fixed_width: { url: 'https://media2.giphy.com/fw.gif', width: '200', height: '150', size: '90000' },
            original: { url: 'https://media2.giphy.com/o.gif', width: '480', height: '360', size: '2000000' },
          },
        },
      ],
      pagination: { offset: 0, count: 1, total_count: 10 },
    });
    expect(page.results[0].full.url).toContain('o.gif');
    expect(page.next).toBe('1');
  });

  it('only proxies known media hosts over https', () => {
    expect(isGifMediaHost('https://static.klipy.com/x.gif')).toBe(true);
    expect(isGifMediaHost('https://media0.giphy.com/x.gif')).toBe(true);
    expect(isGifMediaHost('http://static.klipy.com/x.gif')).toBe(false);
    expect(isGifMediaHost('https://evil.example/x.gif')).toBe(false);
    expect(isGifMediaHost('https://klipy.com.evil.example/x.gif')).toBe(false);
  });
});

/** Client-side media probing: dimensions, duration and tiny inline previews. */

export interface Probe {
  w?: number;
  h?: number;
  dur?: number;
  thumb?: string;
}

const THUMB = 160;

function canvasThumb(src: CanvasImageSource, w: number, h: number): string | undefined {
  const scale = Math.min(1, THUMB / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const chh = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = chh;
  const g = c.getContext('2d');
  if (!g) return undefined;
  g.drawImage(src, 0, 0, cw, chh);
  for (const q of [0.6, 0.4, 0.25]) {
    const url = c.toDataURL('image/webp', q);
    if (url.length < 11_000) return url;
  }
  return undefined;
}

export async function probe(file: Blob): Promise<Probe> {
  const type = file.type;
  try {
    if (type.startsWith('image/') && type !== 'image/svg+xml') {
      const bmp = await createImageBitmap(file);
      const out: Probe = { w: bmp.width, h: bmp.height, thumb: canvasThumb(bmp, bmp.width, bmp.height) };
      bmp.close();
      return out;
    }
    if (type.startsWith('video/')) {
      const url = URL.createObjectURL(file);
      try {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'metadata';
        v.src = url;
        await new Promise<void>((res, rej) => {
          v.onloadedmetadata = () => res();
          v.onerror = () => rej(new Error('video'));
          setTimeout(() => rej(new Error('timeout')), 6000);
        });
        const out: Probe = { w: v.videoWidth || undefined, h: v.videoHeight || undefined, dur: Number.isFinite(v.duration) ? v.duration : undefined };
        try {
          v.currentTime = Math.min(1, (v.duration || 2) / 3);
          await new Promise<void>((res) => {
            v.onseeked = () => res();
            setTimeout(res, 2500);
          });
          if (v.videoWidth) out.thumb = canvasThumb(v, v.videoWidth, v.videoHeight);
        } catch {
          /* thumbnail optional */
        }
        return out;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch {
    /* unknown media */
  }
  return {};
}

/** Downscale an image for avatars/icons if it is huge (keeps GIFs untouched so they stay animated). */
export async function prepareImage(file: File, maxSide: number, maxBytes: number): Promise<Blob> {
  if (file.type === 'image/gif' || file.type === 'image/webp') {
    if (file.size > maxBytes) throw new Error(`Animated images must be under ${Math.round(maxBytes / 1024 / 1024)} MB`);
    return file;
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= maxBytes && (file.type === 'image/png' || file.type === 'image/jpeg')) {
    bmp.close();
    return file;
  }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not process image');
  if (blob.size > maxBytes) {
    const jpg = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.88));
    if (jpg && jpg.size <= maxBytes) return jpg;
    throw new Error('Image is too large');
  }
  return blob;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtDuration(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore, set, toast } from '../../state/store';
import { app } from '../../core/app';
import { I, cls, download, IconButton } from '../common';
import { fmtBytes, fmtDuration } from '../../core/media';
import { importThemeFile } from '../settings/ThemeEditor';
import type { Attachment } from '@shared/ops';

export function Attachments({ att, c, author }: { att: Attachment[]; c: string; author: string }) {
  const media = att.filter((a) => isMediaMime(a.mime) && !a.theme);
  const rest = att.filter((a) => !isMediaMime(a.mime) || a.theme);
  return (
    <div className="atts">
      {media.length > 0 && (
        <div className={cls('media-grid', `n${Math.min(media.length, 4)}`)}>
          {media.map((a) => (
            <MediaItem key={a.hash} a={a} c={c} author={author} single={media.length === 1} />
          ))}
        </div>
      )}
      {rest.map((a) =>
        a.theme ? <ThemeCard key={a.hash} a={a} c={c} author={author} /> : /\.celbot$/i.test(a.name) ? <BotFileCard key={a.hash} a={a} c={c} author={author} /> : <FileCard key={a.hash} a={a} c={c} author={author} />,
      )}
    </div>
  );
}

const isMediaMime = (m: string) => m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/');

function useAttachment(a: Attachment, c: string, author: string) {
  const autoMB = useStore((s) => s.settings.media.autoDownloadMB);
  const url = useStore((s) => s.blobUrls[a.hash]);
  const t = useStore((s) => s.transfers[a.hash]);
  const auto = isMediaMime(a.mime) && a.size <= autoMB * 1024 * 1024;
  useEffect(() => {
    if (url) return;
    void app().ensureBlob(a, { c, owner: author, auto });
  }, [a.hash, url, auto, c, author]);
  const fetchNow = () => void app().ensureBlob(a, { c, owner: author, auto: true });
  const sniffed = url ? app().files.sniffed.get(a.hash) ?? null : null;
  return { url, t, fetchNow, sniffed };
}

function MediaItem({ a, c, author, single }: { a: Attachment; c: string; author: string; single: boolean }) {
  const { url, t, fetchNow, sniffed } = useAttachment(a, c, author);
  const [revealed, setRevealed] = useState(!a.spoiler);
  const kind = a.mime.startsWith('image/') ? 'image' : a.mime.startsWith('video/') ? 'video' : 'audio';
  // never trust the sender's mime: the bytes decide how we render
  // (WebM/MP4 containers sniff as video even when they only hold audio, like voice messages)
  const okKind = !url || (sniffed !== null && (sniffed.split('/')[0] === kind || (kind === 'audio' && (sniffed === 'video/webm' || sniffed === 'video/mp4'))));
  const w = a.w ?? 400;
  const h = a.h ?? 300;
  const maxW = single ? 420 : 260;
  const maxH = single ? 340 : 220;
  const scale = Math.min(1, maxW / w, maxH / h);
  const style = kind === 'audio' ? undefined : { width: Math.round(w * scale), aspectRatio: `${w} / ${h}` };
  if (url && !okKind) return <FileCard a={a} c={c} author={author} />;
  if (kind === 'audio' && a.voice) return <VoiceNote a={a} url={url} t={t} onFetch={fetchNow} />;
  if (kind === 'audio')
    return (
      <div className="audio-att">
        <I.voice size={18} />
        <span className="ellipsis">{a.name}</span>
        {url ? <audio src={url} controls preload="metadata" /> : <Progress a={a} t={t} onFetch={fetchNow} />}
      </div>
    );
  return (
    <div className={cls('media', !revealed && 'spoilered')} style={style}>
      {url ? (
        kind === 'image' ? (
          <img src={url} alt={a.name} loading="lazy" onClick={() => revealed && set({ lightbox: { hash: a.hash, name: a.name, mime: a.mime } })} draggable={false} />
        ) : (
          <video src={url} controls={revealed} preload="metadata" poster={a.thumb} />
        )
      ) : (
        <>
          {a.thumb ? <img src={a.thumb} alt="" className="media-thumb" draggable={false} /> : <div className="media-ph" />}
          <div className="media-overlay">
            {kind === 'video' && !t && (
              <button type="button" className="media-play" onClick={fetchNow} title={`Download ${fmtBytes(a.size)}`}>
                <I.play size={26} />
              </button>
            )}
            <Progress a={a} t={t} onFetch={fetchNow} compact />
          </div>
        </>
      )}
      {kind === 'video' && a.dur && !url && <span className="media-dur">{fmtDuration(a.dur)}</span>}
      {a.mime === 'image/gif' && url && <GifStar a={a} />}
      {!revealed && (
        <button type="button" className="spoiler-cover" onClick={() => setRevealed(true)}>
          SPOILER
        </button>
      )}
    </div>
  );
}

/** Voice messages: a compact player with a generated waveform. */
function VoiceNote({ a, url, t, onFetch }: { a: Attachment; url: string | undefined; t?: { got: number; size: number; state: string; error?: string }; onFetch: () => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const dur = a.dur ?? 0;
  // deterministic pseudo-waveform from the file hash (real peaks would need decoding the whole file)
  const bars = Array.from({ length: 36 }, (_, i) => 0.25 + (parseInt(a.hash.slice(i % 60, (i % 60) + 2), 16) / 255) * 0.75);
  return (
    <div className="voice-note">
      <button
        type="button"
        className="vn-play"
        onClick={() => {
          if (!url) return onFetch();
          const el = ref.current!;
          if (el.paused) void el.play();
          else el.pause();
        }}
        title={playing ? 'Pause' : 'Play'}
      >
        {!url && t && t.state !== 'done' ? <span className="spinner" /> : playing ? <I.stop size={14} /> : <I.play size={16} />}
      </button>
      <div
        className="vn-wave"
        onClick={(e) => {
          const el = ref.current;
          if (!el || !el.duration) return;
          const r = e.currentTarget.getBoundingClientRect();
          el.currentTime = ((e.clientX - r.left) / r.width) * el.duration;
        }}
      >
        {bars.map((h, i) => (
          <i key={i} style={{ height: `${h * 100}%` }} className={cls(i / bars.length < pos && 'on')} />
        ))}
      </div>
      <span className="vn-time">{fmtDuration(playing || pos ? pos * (ref.current?.duration || dur) : dur)}</span>
      {url && (
        <audio
          ref={ref}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPos(0);
          }}
          onTimeUpdate={(e) => setPos(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
        />
      )}
    </div>
  );
}

function GifStar({ a }: { a: Attachment }) {
  const fav = useStore((s) => s.settings.favoriteGifs.some((g) => g.hash === a.hash));
  return (
    <button
      type="button"
      className={cls('gif-star', fav && 'on')}
      title={fav ? 'Remove from favorite GIFs' : 'Add to favorite GIFs'}
      onClick={(e) => {
        e.stopPropagation();
        const s = app().settings;
        const list = fav ? s.favoriteGifs.filter((g) => g.hash !== a.hash) : [{ hash: a.hash, name: a.name, mime: a.mime, size: a.size, w: a.w, h: a.h, thumb: a.thumb }, ...s.favoriteGifs].slice(0, 200);
        void app().saveSettings({ ...s, favoriteGifs: list });
      }}
    >
      <I.star size={16} />
    </button>
  );
}

function Progress({ a, t, onFetch, compact }: { a: Attachment; t?: { got: number; size: number; state: string; error?: string }; onFetch: () => void; compact?: boolean }) {
  if (!t || t.state === 'canceled')
    return (
      <button type="button" className="chip" onClick={onFetch}>
        <I.download size={14} /> {fmtBytes(a.size)}
      </button>
    );
  if (t.state === 'failed')
    return (
      <span className="xfer failed">
        <span>{compact ? 'Unavailable' : t.error}</span>
        <button type="button" className="chip" onClick={onFetch}>
          <I.refresh size={14} /> Retry
        </button>
      </span>
    );
  const pct = Math.round((t.got / Math.max(1, t.size)) * 100);
  return (
    <span className="xfer">
      <span className="xfer-bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="xfer-text">{t.state === 'queued' ? 'Looking for peers...' : t.state === 'verifying' ? 'Verifying' : `${pct}%`}</span>
      {t.state === 'downloading' && (
        <button type="button" className="xfer-x" title="Cancel" onClick={() => app().files.cancel(a.hash)}>
          <I.x size={12} />
        </button>
      )}
    </span>
  );
}

function FileCard({ a, c, author }: { a: Attachment; c: string; author: string }) {
  const { url, t, fetchNow } = useAttachment(a, c, author);
  const ext = (a.name.split('.').pop() ?? '').slice(0, 5).toUpperCase();
  const save = async () => {
    const blob = await app().files.getBlob(a.hash);
    if (blob) download(a.name, blob);
  };
  return (
    <div className="file-card">
      <span className="file-ext">{ext || <I.file size={18} />}</span>
      <span className="file-meta">
        <span className="file-name ellipsis" title={a.name}>
          {a.name}
        </span>
        <span className="file-size">{fmtBytes(a.size)} · sent peer to peer</span>
        {!url && t && <Progress a={a} t={t} onFetch={fetchNow} />}
      </span>
      {url ? <IconButton icon={I.download} title="Save file" onClick={() => void save()} /> : !t && <IconButton icon={I.download} title="Download from peers" onClick={fetchNow} />}
    </div>
  );
}

/** A shared CelChat bot (.celbot). Importing shows the code and asks first; nothing runs on its own. */
function BotFileCard({ a, c, author }: { a: Attachment; c: string; author: string }) {
  const { url, t, fetchNow } = useAttachment({ ...a, mime: 'application/json' }, c, author);
  const [busy, setBusy] = useState(false);
  return (
    <div className="theme-card">
      <span className="theme-card-icon">
        <I.bot size={22} />
      </span>
      <span className="file-meta">
        <span className="file-name">{a.name.replace(/\.celbot$/i, '')}</span>
        <span className="file-size">CelChat bot · {fmtBytes(a.size)}</span>
        {!url && t && <Progress a={a} t={t} onFetch={fetchNow} />}
      </span>
      <button
        type="button"
        className="chip accent"
        disabled={busy}
        onClick={async () => {
          try {
            let blob = await app().files.getBlob(a.hash);
            if (!blob) {
              setBusy(true);
              await app().ensureBlob(a, { c, owner: author, auto: true });
              blob = await app().files.getBlob(a.hash);
              setBusy(false);
            }
            if (!blob) throw new Error('Nobody online has this bot file right now.');
            const file = app().bots.parseImport(await blob.text(), a.name);
            set({ modal: { kind: 'import-bot', props: { file } } });
          } catch (e) {
            setBusy(false);
            toast((e as Error).message, 'error');
          }
        }}
      >
        Review &amp; import
      </button>
    </div>
  );
}

function ThemeCard({ a, c, author }: { a: Attachment; c: string; author: string }) {
  const { url, t, fetchNow } = useAttachment({ ...a, mime: 'application/json' }, c, author);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    let blob = await app().files.getBlob(a.hash);
    if (!blob) {
      setBusy(true);
      await app().ensureBlob(a, { c, owner: author, auto: true });
      blob = await app().files.getBlob(a.hash);
      setBusy(false);
    }
    if (!blob) throw new Error('Nobody online has this theme file right now.');
    return importThemeFile(await blob.text());
  };
  return (
    <div className="theme-card">
      <span className="theme-card-icon">
        <I.palette size={22} />
      </span>
      <span className="file-meta">
        <span className="file-name">{a.name.replace(/\.celtheme(\.json)?$/i, '')}</span>
        <span className="file-size">CelChat theme · {fmtBytes(a.size)}</span>
        {!url && t && <Progress a={a} t={t} onFetch={fetchNow} />}
      </span>
      <button
        type="button"
        className="chip"
        disabled={busy}
        onClick={async () => {
          try {
            const theme = await load();
            set({ previewTheme: theme, modal: { kind: 'settings', props: { tab: 'appearance' } } });
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        }}
      >
        Preview
      </button>
      <button
        type="button"
        className="chip accent"
        disabled={busy}
        onClick={async () => {
          try {
            const theme = await load();
            await app().saveTheme(theme);
            toast(`Applied ${theme.name}`, 'success');
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        }}
      >
        Apply
      </button>
    </div>
  );
}

export function Lightbox({ hash, name }: { hash: string; name: string; mime: string }) {
  const url = useStore((s) => s.blobUrls[hash]);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && set({ lightbox: null });
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return createPortal(
    <div className="lightbox" onClick={() => set({ lightbox: null })}>
      {url && <img src={url} alt={name} className={cls(zoom && 'zoom')} onClick={(e) => { e.stopPropagation(); setZoom(!zoom); }} />}
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="ellipsis">{name}</span>
        <button
          type="button"
          className="chip"
          onClick={async () => {
            const blob = await app().files.getBlob(hash);
            if (blob) download(name, blob);
          }}
        >
          <I.download size={14} /> Save
        </button>
      </div>
    </div>,
    document.body,
  );
}

import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import * as L from 'lucide-react';
import { useStore, closeModal, toast } from '../state/store';
import { app, hasApp } from '../core/app';
import type { AssetRef } from '@shared/ops';
import type { Presence } from '@shared/protocol';
import { displayNameOf, isArchivePeer, type ProfileCard } from '@shared/profile';
import { fontFamily } from '../core/theme';

export const I = {
  hash: L.Hash, voice: L.Volume2, mic: L.Mic, micOff: L.MicOff, headphones: L.Headphones, deaf: L.HeadphoneOff, settings: L.Settings,
  plus: L.Plus, users: L.Users, pin: L.Pin, pinOff: L.PinOff, search: L.Search, bell: L.Bell, bellOff: L.BellOff, x: L.X, check: L.Check,
  smile: L.FaceSlightlySmiling, react: L.FaceSlightlySmilingPlus, clip: L.Paperclip, send: L.SendHorizontal, reply: L.Reply, edit: L.Pencil,
  trash: L.Trash, more: L.Ellipsis, copy: L.Copy, userPlus: L.UserPlus, phone: L.Phone, phoneOff: L.PhoneOff, phoneIn: L.PhoneIncoming,
  logout: L.LogOut, shield: L.Shield, crown: L.Crown, palette: L.Palette, type: L.Type, image: L.Image, gif: L.ImagePlay, download: L.Download,
  file: L.FileText, play: L.Play, link: L.Link, down: L.ChevronDown, right: L.ChevronRight, compass: L.Compass, chat: L.MessageCircle,
  dm: L.MessageSquare, sticker: L.Sticker, upload: L.Upload, wifi: L.Wifi, wifiOff: L.WifiOff, radio: L.Radio, lock: L.Lock, eye: L.Eye,
  eyeOff: L.EyeOff, moon: L.Moon, sun: L.Sun, star: L.Star, sparkles: L.Sparkles, info: L.Info, alert: L.TriangleExclamationPoint,
  refresh: L.RefreshCw, folder: L.Folder, userX: L.UserX, userMinus: L.UserMinus, ban: L.Ban, clock: L.Clock, at: L.AtSign, inbox: L.Inbox,
  globe: L.Globe, disk: L.HardDrive, key: L.KeyRound, monitor: L.Monitor, speaker: L.Speaker, volumeX: L.VolumeX, home: L.House,
  server: L.Server, grid: L.LayoutGrid, brush: L.Brush, user: L.CircleUser, back: L.ArrowLeft, shieldOk: L.ShieldCheck, gavel: L.Gavel,
  timer: L.Timer, signal: L.Signal, zap: L.Zap, menu: L.Menu, screen: L.MonitorUp, screenOff: L.MonitorX, video: L.Video, videoOff: L.VideoOff,
  bookmark: L.Bookmark, bookmarkOn: L.BookmarkCheck, alarm: L.AlarmClock, calendar: L.CalendarClock, poll: L.ChartColumn, waveform: L.AudioLines,
  history: L.ClockArrowUp, keyboard: L.Keyboard, volumeUp: L.Volume2, music: L.AudioWaveform, folderPlus: L.FolderPlus, readAloud: L.Speech, maximize: L.Maximize,
  installApp: L.MonitorDown, stop: L.Square, grid2: L.Grid2x2,
  bot: L.Bot, code: L.Code, terminal: L.Terminal, book: L.BookOpen, flask: L.FlaskConical, restart: L.RotateCw, fileUp: L.FileUp, external: L.ExternalLink,
};

export function cls(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Blob-backed media
// ---------------------------------------------------------------------------

/** Resolve a file to a blob URL, downloading it from peers when `auto`. */
export function useBlobUrl(ref: (AssetRef & { name?: string }) | null | undefined, ctx: { c?: string; owner?: string; auto?: boolean; publicAsset?: boolean } = {}) {
  const url = useStore((s) => (ref ? s.blobUrls[ref.hash] : undefined));
  const { c, owner, auto = true, publicAsset } = ctx;
  useEffect(() => {
    if (!ref || url || !hasApp()) return;
    void app().ensureBlob(ref, { c, owner, auto, publicAsset });
  }, [ref?.hash, url, c, owner, auto, publicAsset]);
  return url ?? null;
}

const STATUS_LABEL: Record<Presence | 'offline', string> = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible', offline: 'Offline' };
export const statusLabel = (p: Presence | 'offline') => STATUS_LABEL[p];

export function usePresence(pub: string): Presence | 'offline' {
  return useStore((s) => {
    const p = s.presence[pub];
    if (!p || p === 'invisible') return pub === s.me && p === 'invisible' ? 'invisible' : 'offline';
    return p;
  });
}

export function StatusDot({ status, size = 12 }: { status: Presence | 'offline'; size?: number }) {
  return <span className={`status-dot st-${status}`} style={{ width: size, height: size }} title={statusLabel(status)} />;
}

export function Avatar({ pub, size = 40, status, speaking, card: cardProp, onClick, className }: { pub: string; size?: number; status?: boolean; speaking?: boolean; card?: ProfileCard | null; onClick?: (e: React.MouseEvent) => void; className?: string }) {
  const card = useStore((s) => cardProp ?? s.profiles[pub] ?? null);
  const autoplay = useStore((s) => s.settings.media.autoplayGifs);
  const url = useBlobUrl(card?.avatar ?? null, { owner: pub, publicAsset: true });
  const presence = usePresence(pub);
  const [hover, setHover] = useState(false);
  const name = displayNameOf(card, pub.slice(0, 6));
  const hue = parseInt(pub.slice(0, 4), 16) % 360;
  const isGif = card?.avatar?.mime === 'image/gif';
  const still = useStillFrame(isGif && !autoplay && !hover ? url : null);
  return (
    <span
      className={cls('avatar', url && 'has-img', speaking && 'speaking', className)}
      style={(size ? { width: size, height: size, '--hue': hue } : { '--hue': hue }) as unknown as CSSProperties}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {url ? <img src={isGif && !autoplay && !hover ? still ?? url : url} alt="" draggable={false} /> : <span className="avatar-fallback" style={size ? { fontSize: size * 0.42 } : undefined}>{name.slice(0, 1).toUpperCase()}</span>}
      {status && <StatusDot status={presence} size={Math.max(10, (size || 40) * 0.3)} />}
    </span>
  );
}

/** First frame of an animated GIF (for "don't autoplay" users). */
function useStillFrame(url: string | null) {
  const [still, setStill] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')?.drawImage(img, 0, 0);
      setStill(c.toDataURL('image/png'));
    };
    img.src = url;
  }, [url]);
  return still;
}

export function CommunityIcon({ c, size = 48, name, icon }: { c: string; size?: number; name: string; icon: AssetRef | null }) {
  const url = useBlobUrl(icon, { c, publicAsset: true });
  const initials = name
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
  const hue = parseInt(c.slice(0, 4), 16) % 360;
  return (
    <span className={cls('cicon', url && 'has-img')} style={{ width: size, height: size, '--hue': hue } as CSSProperties}>
      {url ? <img src={url} alt="" draggable={false} /> : <span style={{ fontSize: Math.max(11, size / (initials.length > 2 ? 3.2 : 2.6)) }}>{initials || '?'}</span>}
    </span>
  );
}

export function UserName({ pub, c, color, className }: { pub: string; c?: string; color?: string | null; className?: string }) {
  const card = useStore((s) => s.profiles[pub]);
  const nick = useStore((s) => {
    if (!c) return null;
    const st = s.states[c];
    return st && st.kind === 'community' ? st.members[pub]?.nick ?? null : null;
  });
  const name = nick ?? displayNameOf(card, `user-${pub.slice(0, 6)}`);
  const style: CSSProperties = {};
  if (color) style.color = color;
  if (card && card.font !== 'default') style.fontFamily = fontFamily(card.font);
  const ns = card?.nameStyle ?? 'plain';
  if (ns === 'gradient' && card) {
    style.backgroundImage = `linear-gradient(90deg, ${card.colors.primary}, ${card.colors.accent})`;
  }
  return (
    <>
      <span className={cls('uname', `ns-${ns}`, className)} style={{ ...style, '--ns-color': card?.colors.accent ?? 'currentColor' } as CSSProperties}>
        {name}
      </span>
      {card?.bot &&
        (isArchivePeer(card) ? (
          <span className="bot-badge" title="Always-on archive peer (automated, not a person)">
            archive
          </span>
        ) : (
          <span className="bot-badge app" title="Bot: automated, runs inside a member's CelChat">
            <L.Bot size={10} strokeWidth={2.6} /> bot
          </span>
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Form bits
// ---------------------------------------------------------------------------

export function Button({ children, kind = 'primary', small, onClick, disabled, type = 'button', title, className, busy }: { children: ReactNode; kind?: 'primary' | 'ghost' | 'danger' | 'subtle' | 'success'; small?: boolean; onClick?: (e: React.MouseEvent) => void; disabled?: boolean; type?: 'button' | 'submit'; title?: string; className?: string; busy?: boolean }) {
  return (
    <button type={type} className={cls('btn', `btn-${kind}`, small && 'btn-sm', busy && 'busy', className)} onClick={onClick} disabled={disabled || busy} title={title}>
      {busy && <span className="spinner" />}
      {children}
    </button>
  );
}

export function IconButton({ icon: Ico, title, onClick, active, danger, size = 20, className, badge }: { icon: L.LucideIcon; title: string; onClick?: (e: React.MouseEvent) => void; active?: boolean; danger?: boolean; size?: number; className?: string; badge?: number }) {
  return (
    <button type="button" className={cls('ibtn', active && 'active', danger && 'danger', className)} onClick={onClick} title={title} aria-label={title}>
      <Ico size={size} strokeWidth={2} />
      {!!badge && <span className="badge">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}

export function Toggle({ on, onChange, label, desc, disabled }: { on: boolean; onChange: (v: boolean) => void; label?: ReactNode; desc?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cls('toggle-row', disabled && 'disabled')}>
      <span className="toggle-text">
        {label && <span className="toggle-label">{label}</span>}
        {desc && <span className="toggle-desc">{desc}</span>}
      </span>
      <button type="button" role="switch" aria-checked={on} className={cls('toggle', on && 'on')} onClick={() => !disabled && onChange(!on)} disabled={disabled}>
        <span />
      </button>
    </label>
  );
}

export function Field({ label, hint, error, children }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      {label && <div className="field-label">{label}</div>}
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button type="button" key={o.value} className={cls(o.value === value && 'on')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step = 1, onChange, format }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <div className="slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-val">{format ? format(value) : value}</span>
    </div>
  );
}

export function ColorInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) {
  const hex = value.slice(0, 7);
  const alpha = value.length === 9 ? value.slice(7) : '';
  return (
    <label className="color-input" title={label}>
      <span className="swatch" style={{ background: value }}>
        <input type="color" value={hex} onChange={(e) => onChange(e.target.value + alpha)} />
      </span>
      {label && <span className="color-label">{label}</span>}
      <input className="color-hex" value={value} spellCheck={false} onChange={(e) => /^#[0-9a-fA-F]{0,8}$/.test(e.target.value) && onChange(e.target.value)} />
    </label>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Empty({ icon: Ico, title, children }: { icon: L.LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Ico size={34} />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

export function Modal({ title, children, onClose = closeModal, wide, footer, className, subtitle }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; onClose?: () => void; wide?: boolean | 'full'; footer?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cls('modal', wide === 'full' ? 'modal-full' : wide && 'modal-wide', className)} role="dialog" aria-modal="true">
        {title && (
          <div className="modal-head">
            <div>
              <div className="modal-title">{title}</div>
              {subtitle && <div className="modal-sub">{subtitle}</div>}
            </div>
            <IconButton icon={I.x} title="Close" onClick={onClose} />
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function confirmDialog(opts: { title: string; body: ReactNode; confirm: string; danger?: boolean; onConfirm: () => void | Promise<void> }) {
  useStore.setState({ modal: { kind: 'confirm', props: opts as unknown as Record<string, unknown> } });
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

export function fmtTime(t: number, clock24: boolean) {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !clock24 });
}

export function fmtDay(t: number) {
  const d = new Date(t);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function fmtStamp(t: number, clock24: boolean) {
  const d = new Date(t);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const time = fmtTime(t, clock24);
  if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

export function fmtDate(t: number) {
  return new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export async function copy(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to clipboard`, 'success');
  } catch {
    toast('Clipboard is not available here', 'error');
  }
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => res([...(input.files ?? [])]);
    input.click();
  });
}

export function download(name: string, data: Blob | string) {
  const blob = typeof data === 'string' ? new Blob([data], { type: 'application/json' }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { cls } from '../common';
import { app } from '../../core/app';
import { CustomEmoji } from '../markdown';

export interface EmojiEntry {
  u: string;
  label: string;
  group: number;
  tags: string[];
  codes: string[];
  skins?: string[];
}

let cache: Promise<EmojiEntry[]> | null = null;

/** Lazy-load emoji data (code-split, ~500 KB) only when a picker or :autocomplete: first opens. */
export function loadEmoji(): Promise<EmojiEntry[]> {
  if (!cache) {
    cache = Promise.all([import('emojibase-data/en/compact.json'), import('emojibase-data/en/shortcodes/github.json')]).then(([data, codes]) => {
      const list = (data.default ?? data) as unknown as { hexcode: string; label: string; unicode: string; group?: number; tags?: string[]; skins?: { unicode: string }[] }[];
      const sc = (codes.default ?? codes) as unknown as Record<string, string | string[]>;
      return list
        .filter((e) => e.group !== undefined && e.group !== 2)
        .map((e) => {
          const c = sc[e.hexcode];
          return { u: e.unicode, label: e.label, group: e.group!, tags: e.tags ?? [], codes: c ? (Array.isArray(c) ? c : [c]) : [], skins: e.skins?.map((s) => s.unicode) };
        });
    });
  }
  return cache;
}

const GROUPS = [
  { id: 0, icon: '😀', label: 'Smileys' },
  { id: 1, icon: '👋', label: 'People' },
  { id: 3, icon: '🐱', label: 'Animals & nature' },
  { id: 4, icon: '🍕', label: 'Food & drink' },
  { id: 5, icon: '✈️', label: 'Travel' },
  { id: 6, icon: '⚽', label: 'Activities' },
  { id: 7, icon: '💡', label: 'Objects' },
  { id: 8, icon: '❤️', label: 'Symbols' },
  { id: 9, icon: '🏳️', label: 'Flags' },
];

const SKINS = ['', '🏻', '🏼', '🏽', '🏾', '🏿'];

export function EmojiPicker({ onPick, onClose, inline, keepOpen }: { onPick: (e: string) => void; onClose: () => void; inline?: boolean; keepOpen?: boolean }) {
  const [all, setAll] = useState<EmojiEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<number | 'recent' | 'custom'>('recent');
  const states = useStore((s) => s.states);
  const custom = useMemo(() => app().allEmoji(), [states]);
  const [skin, setSkin] = useState(() => Number(localStorage.getItem('cel-skin') ?? 0));
  const [hover, setHover] = useState<EmojiEntry | null>(null);
  const recent = useStore((s) => s.settings.recentEmoji);
  const ref = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadEmoji().then(setAll);
  }, []);
  useEffect(() => {
    if (inline) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [inline, onClose]);

  const shown = useMemo(() => {
    if (!all) return [];
    const needle = q.trim().toLowerCase();
    if (needle) return all.filter((e) => e.label.includes(needle) || e.codes.some((c) => c.includes(needle)) || e.tags.some((t) => t.startsWith(needle))).slice(0, 240);
    if (group === 'custom') return [];
    if (group === 'recent') return recent.filter((u) => !u.startsWith('<:')).map((u) => all.find((e) => e.u === u) ?? { u, label: u, group: -1, tags: [], codes: [] });
    return all.filter((e) => e.group === group);
  }, [all, q, group, recent]);

  const withSkin = (e: EmojiEntry) => (skin && e.skins && e.skins[skin - 1] ? e.skins[skin - 1] : e.u);

  return (
    <div ref={ref} className={cls('emoji-picker', inline && 'inline')} onMouseDown={(e) => e.stopPropagation()}>
      <div className="ep-top">
        <input autoFocus placeholder="Find the perfect emoji" value={q} onChange={(e) => setQ(e.target.value)} />
        <button
          type="button"
          className="ep-skin"
          title="Skin tone"
          onClick={() => {
            const n = (skin + 1) % SKINS.length;
            setSkin(n);
            localStorage.setItem('cel-skin', String(n));
          }}
        >
          {'👋' + SKINS[skin]}
        </button>
      </div>
      <div className="ep-tabs">
        <button type="button" className={cls(group === 'recent' && !q && 'on')} onClick={() => { setGroup('recent'); setQ(''); }} title="Recent">
          🕘
        </button>
        {custom.length > 0 && (
          <button type="button" className={cls(group === 'custom' && !q && 'on')} onClick={() => { setGroup('custom'); setQ(''); }} title="Community emoji (usable everywhere)">
            ⭐
          </button>
        )}
        {GROUPS.map((g) => (
          <button
            type="button"
            key={g.id}
            className={cls(group === g.id && !q && 'on')}
            title={g.label}
            onClick={() => {
              setGroup(g.id);
              setQ('');
              gridRef.current?.scrollTo({ top: 0 });
            }}
          >
            {g.icon}
          </button>
        ))}
      </div>
      <div className="ep-grid" ref={gridRef}>
        {!all && <div className="muted pad">Loading emoji...</div>}
        {(group === 'custom' || q) &&
          custom
            .filter((e) => !q || e.name.includes(q.toLowerCase()))
            .map((e) => (
              <button type="button" key={e.c + e.name} className="ep-emoji" title={`:${e.name}: from ${e.community}`} onClick={() => { onPick(e.token); if (!keepOpen && !inline) onClose(); }}>
                <CustomEmoji name={e.name} hash={e.asset.hash} size={e.asset.size} />
              </button>
            ))}
        {shown.map((e) => (
          <button
            type="button"
            key={e.u}
            className="ep-emoji"
            onMouseEnter={() => setHover(e)}
            onClick={() => {
              onPick(withSkin(e));
              if (!keepOpen && !inline) onClose();
            }}
          >
            {withSkin(e)}
          </button>
        ))}
        {all && !shown.length && group !== 'custom' && !custom.some((e) => q && e.name.includes(q.toLowerCase())) && <div className="muted pad">No emoji match "{q}".</div>}
      </div>
      <div className="ep-foot">
        {hover ? (
          <>
            <span className="ep-big">{withSkin(hover)}</span>
            <span>
              <b>{hover.label}</b>
              {hover.codes[0] && <span className="muted"> :{hover.codes[0]}:</span>}
            </span>
          </>
        ) : (
          <span className="muted">Pick an emoji</span>
        )}
      </div>
    </div>
  );
}

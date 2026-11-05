/**
 * Theme engine: every color, font, size and spacing token is a CSS variable,
 * so a theme (built-in, custom, imported or shared in chat) restyles the whole
 * app, including uploaded custom fonts.
 */
export interface ThemeColors {
  rail: string;
  side: string;
  chat: string;
  elev: string;
  input: string;
  hover: string;
  border: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  accent2: string;
  onAccent: string;
  danger: string;
  success: string;
  warning: string;
  mention: string;
  link: string;
}

export type MessageStyle = 'cozy' | 'compact' | 'bubbles' | 'cards';
export type AvatarShape = 'circle' | 'squircle' | 'square';

export interface Theme {
  id: string;
  name: string;
  author?: string;
  base: 'dark' | 'light';
  colors: ThemeColors;
  fonts: { ui: string; chat: string; mono: string; size: number; lineHeight: number; weight: number };
  layout: {
    radius: number;
    spacing: number;
    sideWidth: number;
    membersWidth: number;
    messageStyle: MessageStyle;
    avatarShape: AvatarShape;
    avatarSize: number;
    railLabels: boolean;
    glass: boolean;
    animations: 'full' | 'reduced' | 'none';
  };
  chatBg: { kind: 'none' | 'color' | 'gradient' | 'image'; color: string; from: string; to: string; angle: number; image: string | null; dim: number; blur: number; fit: 'cover' | 'tile' };
  customCss: string;
}

export interface FontDef {
  key: string;
  label: string;
  family: string;
  kind: 'ui' | 'display' | 'mono';
}

export const FONTS: FontDef[] = [
  { key: 'jakarta', label: 'Plus Jakarta Sans', family: "'Plus Jakarta Sans Variable'", kind: 'ui' },
  { key: 'inter', label: 'Inter', family: "'Inter Variable'", kind: 'ui' },
  { key: 'outfit', label: 'Outfit', family: "'Outfit Variable'", kind: 'ui' },
  { key: 'nunito', label: 'Nunito', family: "'Nunito Variable'", kind: 'ui' },
  { key: 'dmsans', label: 'DM Sans', family: "'DM Sans Variable'", kind: 'ui' },
  { key: 'space', label: 'Space Grotesk', family: "'Space Grotesk Variable'", kind: 'ui' },
  { key: 'lexend', label: 'Lexend (readability)', family: "'Lexend Variable'", kind: 'ui' },
  { key: 'atkinson', label: 'Atkinson Hyperlegible', family: "'Atkinson Hyperlegible'", kind: 'ui' },
  { key: 'opendyslexic', label: 'OpenDyslexic', family: "'OpenDyslexic'", kind: 'ui' },
  { key: 'system', label: 'System UI', family: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", kind: 'ui' },
  { key: 'comfortaa', label: 'Comfortaa', family: "'Comfortaa Variable'", kind: 'display' },
  { key: 'pacifico', label: 'Pacifico', family: "'Pacifico'", kind: 'display' },
  { key: 'caveat', label: 'Caveat', family: "'Caveat Variable'", kind: 'display' },
  { key: 'lobster', label: 'Lobster', family: "'Lobster'", kind: 'display' },
  { key: 'bebas', label: 'Bebas Neue', family: "'Bebas Neue'", kind: 'display' },
  { key: 'righteous', label: 'Righteous', family: "'Righteous'", kind: 'display' },
  { key: 'orbitron', label: 'Orbitron', family: "'Orbitron Variable'", kind: 'display' },
  { key: 'press', label: 'Press Start 2P', family: "'Press Start 2P'", kind: 'display' },
  { key: 'jetbrains', label: 'JetBrains Mono', family: "'JetBrains Mono Variable'", kind: 'mono' },
];

const customFonts = new Map<string, { family: string; label: string }>();

export function fontFamily(key: string, fallback = 'jakarta'): string {
  if (key.startsWith('custom:')) {
    const c = customFonts.get(key);
    if (c) return `${c.family}, ${fontFamily(fallback)}`;
    return fontFamily(fallback);
  }
  const f = FONTS.find((x) => x.key === key) ?? FONTS.find((x) => x.key === fallback)!;
  return `${f.family}, system-ui, sans-serif`;
}

export function customFontList() {
  return [...customFonts.entries()].map(([key, v]) => ({ key, label: v.label }));
}

/** Register an uploaded font file (TTF/OTF/WOFF/WOFF2) so it can be used everywhere. */
export async function registerCustomFont(hash: string, label: string, data: Blob): Promise<string> {
  const key = `custom:${hash}`;
  if (customFonts.has(key)) return key;
  const family = `CelCustom_${hash.slice(0, 10)}`;
  const face = new FontFace(family, await data.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  customFonts.set(key, { family: `'${family}'`, label });
  return key;
}

export function sniffFont(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
  return tag === 'wOFF' || tag === 'wOF2' || tag === 'OTTO' || tag === 'true' || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0);
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const baseLayout: Theme['layout'] = {
  radius: 12,
  spacing: 1,
  sideWidth: 248,
  membersWidth: 248,
  messageStyle: 'cozy',
  avatarShape: 'circle',
  avatarSize: 40,
  railLabels: false,
  glass: true,
  animations: 'full',
};
const baseFonts: Theme['fonts'] = { ui: 'jakarta', chat: 'jakarta', mono: 'jetbrains', size: 15, lineHeight: 1.45, weight: 450 };
const noBg: Theme['chatBg'] = { kind: 'none', color: '#000000', from: '#000000', to: '#000000', angle: 160, image: null, dim: 0.4, blur: 0, fit: 'cover' };

function preset(id: string, name: string, base: 'dark' | 'light', colors: ThemeColors, extra: Partial<Theme> = {}): Theme {
  return { id, name, base, colors, fonts: { ...baseFonts }, layout: { ...baseLayout }, chatBg: { ...noBg }, customCss: '', author: 'CelChat', ...extra };
}

export const PRESETS: Theme[] = [
  preset('midnight', 'Midnight Celadon', 'dark', {
    rail: '#0b1016', side: '#111821', chat: '#151d27', elev: '#1c2633', input: '#1a2330', hover: '#ffffff0d', border: '#ffffff12',
    text: '#e7eef4', text2: '#9fb0c0', text3: '#64788b', accent: '#5fd3b3', accent2: '#7aa7ff', onAccent: '#06241c',
    danger: '#ff6b7a', success: '#4fd18b', warning: '#f6c35b', mention: '#5fd3b31f', link: '#7fc8ff',
  }),
  preset('porcelain', 'Porcelain', 'light', {
    rail: '#dfe7ea', side: '#eef3f4', chat: '#f9fbfb', elev: '#ffffff', input: '#e9eff1', hover: '#0b2a3010', border: '#0b2a3017',
    text: '#14232b', text2: '#4c6370', text3: '#7d929d', accent: '#1f9d7f', accent2: '#3b6fe0', onAccent: '#ffffff',
    danger: '#d63a4c', success: '#1e9e5a', warning: '#b7801b', mention: '#1f9d7f1c', link: '#1d6fc4',
  }),
  preset('ember', 'Ember', 'dark', {
    rail: '#140d0b', side: '#1b1310', chat: '#211814', elev: '#2b201b', input: '#271d18', hover: '#ffffff0c', border: '#ffffff12',
    text: '#f5e9e2', text2: '#c4a696', text3: '#8a6d5f', accent: '#ff8a4c', accent2: '#ffc15e', onAccent: '#2b1206',
    danger: '#ff5e6c', success: '#7fd38a', warning: '#ffc15e', mention: '#ff8a4c22', link: '#ffb27a',
  }),
  preset('nebula', 'Nebula', 'dark', {
    rail: '#0e0b18', side: '#141024', chat: '#18132b', elev: '#221b3a', input: '#1f1934', hover: '#ffffff0d', border: '#ffffff14',
    text: '#ece8ff', text2: '#aaa0d6', text3: '#6f6699', accent: '#a98bff', accent2: '#ff7ad9', onAccent: '#170c33',
    danger: '#ff6b8b', success: '#5be3a5', warning: '#ffd06b', mention: '#a98bff22', link: '#9ec5ff',
  }, { chatBg: { ...noBg, kind: 'gradient', from: '#1a1430', to: '#120f22', angle: 165 } }),
  preset('oled', 'OLED Black', 'dark', {
    rail: '#000000', side: '#050505', chat: '#000000', elev: '#111111', input: '#0d0d0d', hover: '#ffffff0f', border: '#ffffff17',
    text: '#f2f2f2', text2: '#a3a3a3', text3: '#666666', accent: '#5fd3b3', accent2: '#8ab4ff', onAccent: '#001a12',
    danger: '#ff5c6c', success: '#4fd18b', warning: '#f6c35b', mention: '#5fd3b320', link: '#8ab4ff',
  }, { layout: { ...baseLayout, glass: false } }),
  preset('sakura', 'Sakura', 'light', {
    rail: '#f4dfe6', side: '#fbeef2', chat: '#fff8fa', elev: '#ffffff', input: '#f8e6ec', hover: '#5a1c3010', border: '#5a1c3018',
    text: '#3a1a26', text2: '#7d5262', text3: '#a88595', accent: '#e05a8a', accent2: '#8a6cf0', onAccent: '#ffffff',
    danger: '#d1384f', success: '#2f9e6a', warning: '#c48419', mention: '#e05a8a1c', link: '#b43f74',
  }, { fonts: { ...baseFonts, ui: 'nunito', chat: 'nunito' }, layout: { ...baseLayout, radius: 16, messageStyle: 'bubbles', avatarShape: 'squircle' } }),
  preset('forest', 'Forest', 'dark', {
    rail: '#0a120d', side: '#0f1a13', chat: '#132018', elev: '#1a2b20', input: '#17261c', hover: '#ffffff0c', border: '#ffffff12',
    text: '#e4f1e6', text2: '#9bb8a2', text3: '#62806a', accent: '#8fd36b', accent2: '#e0c368', onAccent: '#0d2205',
    danger: '#ff6f6f', success: '#8fd36b', warning: '#e0c368', mention: '#8fd36b1f', link: '#9fd9ff',
  }),
  preset('ocean', 'Deep Ocean', 'dark', {
    rail: '#07101c', side: '#0b1626', chat: '#0e1b2e', elev: '#15253d', input: '#122136', hover: '#ffffff0c', border: '#ffffff12',
    text: '#e3eefc', text2: '#93abc9', text3: '#5d7593', accent: '#4cb5ff', accent2: '#5fe0d0', onAccent: '#021627',
    danger: '#ff6b7a', success: '#53d69a', warning: '#f6c35b', mention: '#4cb5ff1f', link: '#7cc9ff',
  }),
  preset('terminal', 'Terminal', 'dark', {
    rail: '#000000', side: '#020702', chat: '#030a03', elev: '#0a160a', input: '#061006', hover: '#33ff6610', border: '#33ff6622',
    text: '#b6ffb6', text2: '#6fd16f', text3: '#3c8a3c', accent: '#33ff66', accent2: '#ffd033', onAccent: '#001a06',
    danger: '#ff4d4d', success: '#33ff66', warning: '#ffd033', mention: '#33ff661a', link: '#7dfcff',
  }, { fonts: { ...baseFonts, ui: 'jetbrains', chat: 'jetbrains', size: 14 }, layout: { ...baseLayout, radius: 2, messageStyle: 'compact', avatarShape: 'square', glass: false } }),
  preset('contrast', 'High Contrast', 'dark', {
    rail: '#000000', side: '#000000', chat: '#000000', elev: '#141414', input: '#0a0a0a', hover: '#ffffff1f', border: '#ffffff66',
    text: '#ffffff', text2: '#e6e6e6', text3: '#bdbdbd', accent: '#ffe14d', accent2: '#4dd2ff', onAccent: '#000000',
    danger: '#ff6b6b', success: '#6bff95', warning: '#ffe14d', mention: '#ffe14d33', link: '#4dd2ff',
  }, { fonts: { ...baseFonts, ui: 'atkinson', chat: 'atkinson', size: 16, weight: 500 }, layout: { ...baseLayout, glass: false, animations: 'reduced' } }),
];

export const defaultTheme = () => structuredClone(PRESETS[0]);

export function normalizeTheme(raw: unknown): Theme | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<Theme>;
  const base = defaultTheme();
  const hex = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v) ? v : d);
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const colors = { ...base.colors };
  for (const k of Object.keys(colors) as (keyof ThemeColors)[]) colors[k] = hex(t.colors?.[k], base.colors[k]);
  const f = t.fonts ?? base.fonts;
  const l = t.layout ?? base.layout;
  const b = t.chatBg ?? base.chatBg;
  const str = (v: unknown, d: string, max = 60) => (typeof v === 'string' && v.length <= max ? v : d);
  const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
  return {
    id: str(t.id, 'custom-' + Date.now().toString(36)),
    name: str(t.name, 'Custom theme', 80),
    author: t.author ? str(t.author, '', 80) : undefined,
    base: t.base === 'light' ? 'light' : 'dark',
    colors,
    fonts: {
      ui: str(f.ui, base.fonts.ui, 80),
      chat: str(f.chat, base.fonts.chat, 80),
      mono: str(f.mono, base.fonts.mono, 80),
      size: num(f.size, 15, 11, 24),
      lineHeight: num(f.lineHeight, 1.45, 1.1, 2),
      weight: num(f.weight, 450, 300, 700),
    },
    layout: {
      radius: num(l.radius, 12, 0, 28),
      spacing: num(l.spacing, 1, 0.6, 1.6),
      sideWidth: num(l.sideWidth, 248, 200, 360),
      membersWidth: num(l.membersWidth, 248, 200, 360),
      messageStyle: oneOf(l.messageStyle, ['cozy', 'compact', 'bubbles', 'cards'] as const, 'cozy'),
      avatarShape: oneOf(l.avatarShape, ['circle', 'squircle', 'square'] as const, 'circle'),
      avatarSize: num(l.avatarSize, 40, 24, 64),
      railLabels: !!l.railLabels,
      glass: l.glass !== false,
      animations: oneOf(l.animations, ['full', 'reduced', 'none'] as const, 'full'),
    },
    chatBg: {
      kind: oneOf(b.kind, ['none', 'color', 'gradient', 'image'] as const, 'none'),
      color: hex(b.color, '#000000'),
      from: hex(b.from, '#000000'),
      to: hex(b.to, '#000000'),
      angle: num(b.angle, 160, 0, 360),
      image: typeof b.image === 'string' && /^[0-9a-f]{64}$/.test(b.image) ? b.image : null,
      dim: num(b.dim, 0.4, 0, 0.95),
      blur: num(b.blur, 0, 0, 30),
      fit: b.fit === 'tile' ? 'tile' : 'cover',
    },
    customCss: typeof t.customCss === 'string' ? t.customCss.slice(0, 50_000) : '',
  };
}

function hexToRgb(h: string) {
  const v = parseInt(h.slice(1, 7), 16);
  return `${(v >> 16) & 255} ${(v >> 8) & 255} ${v & 255}`;
}

let cssTag: HTMLStyleElement | null = null;

export function applyTheme(t: Theme, overlay?: { accent?: string; accent2?: string; font?: string } | null) {
  const r = document.documentElement;
  const c = { ...t.colors };
  if (overlay?.accent) c.accent = overlay.accent;
  if (overlay?.accent2) c.accent2 = overlay.accent2;
  const set = (k: string, v: string) => r.style.setProperty(k, v);
  for (const [k, v] of Object.entries(c)) set(`--${k}`, v);
  set('--accent-rgb', hexToRgb(c.accent));
  set('--font-ui', fontFamily(overlay?.font || t.fonts.ui));
  set('--font-chat', fontFamily(overlay?.font || t.fonts.chat));
  set('--font-mono', `${fontFamily(t.fonts.mono, 'jetbrains')}, ui-monospace, Consolas, monospace`);
  set('--fs', `${t.fonts.size}px`);
  set('--lh', String(t.fonts.lineHeight));
  set('--fw', String(t.fonts.weight));
  set('--radius', `${t.layout.radius}px`);
  set('--sp', String(t.layout.spacing));
  set('--side-w', `${t.layout.sideWidth}px`);
  set('--members-w', `${t.layout.membersWidth}px`);
  set('--av', `${t.layout.avatarSize}px`);
  r.dataset.base = t.base;
  r.dataset.msgstyle = t.layout.messageStyle;
  r.dataset.avatar = t.layout.avatarShape;
  r.dataset.glass = t.layout.glass ? '1' : '0';
  r.dataset.anim = t.layout.animations;
  r.dataset.raillabels = t.layout.railLabels ? '1' : '0';
  r.style.colorScheme = t.base;
  if (!cssTag) {
    cssTag = document.createElement('style');
    cssTag.id = 'cel-custom-css';
    document.head.appendChild(cssTag);
  }
  cssTag.textContent = t.customCss;
}

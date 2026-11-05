import { useEffect, useState } from 'react';
import { useStore, set, toast } from '../../state/store';
import { app } from '../../core/app';
import { Button, Field, I, Toggle, Segmented, Slider, ColorInput, cls, pickFile, download, confirmDialog } from '../common';
import { PRESETS, FONTS, applyTheme, normalizeTheme, registerCustomFont, type Theme, type ThemeColors } from '../../core/theme';
import { sha256File } from '@shared/crypto';
import { fromB64, toB64 } from '@shared/bytes';

const COLOR_GROUPS: { title: string; keys: [keyof ThemeColors, string][] }[] = [
  { title: 'Surfaces', keys: [['rail', 'Community rail'], ['side', 'Sidebar'], ['chat', 'Chat area'], ['elev', 'Cards & popups'], ['input', 'Inputs'], ['hover', 'Hover tint'], ['border', 'Borders']] },
  { title: 'Text', keys: [['text', 'Primary text'], ['text2', 'Secondary text'], ['text3', 'Muted text'], ['link', 'Links']] },
  { title: 'Accents', keys: [['accent', 'Accent'], ['accent2', 'Second accent'], ['onAccent', 'Text on accent'], ['mention', 'Mention highlight']] },
  { title: 'Status', keys: [['danger', 'Danger'], ['success', 'Success'], ['warning', 'Warning']] },
];

export function ThemeEditor() {
  const saved = useStore((s) => s.theme);
  const preview = useStore((s) => s.previewTheme);
  const library = useStore((s) => s.savedThemes);
  const customFonts = useStore((s) => s.customFonts);
  const bgUrl = useStore((s) => (preview?.chatBg.image ? s.blobUrls[preview.chatBg.image] : null));
  const t = preview ?? saved;
  const [section, setSection] = useState<'gallery' | 'colors' | 'type' | 'layout' | 'background' | 'css'>('gallery');

  useEffect(() => {
    applyTheme(t);
  }, [t]);

  const edit = (fn: (x: Theme) => Theme) => set({ previewTheme: fn(structuredClone(t)) });
  const dirty = !!preview && JSON.stringify(preview) !== JSON.stringify(saved);

  return (
    <div className="settings-page theme-editor">
      <h2>Appearance & themes</h2>
      <p className="muted">Every color, font, size and spacing token is yours. Changes preview live; save to keep them. Themes can be exported, imported, and shared in any chat as a file.</p>
      <div className="tabs">
        {(['gallery', 'colors', 'type', 'layout', 'background', 'css'] as const).map((s) => (
          <button type="button" key={s} className={cls(section === s && 'on')} onClick={() => setSection(s)}>
            {{ gallery: 'Themes', colors: 'Colors', type: 'Fonts & text', layout: 'Layout', background: 'Chat background', css: 'Custom CSS' }[s]}
          </button>
        ))}
      </div>

      {section === 'gallery' && (
        <>
          <div className="field-label">Built in</div>
          <div className="theme-grid">
            {PRESETS.map((p) => (
              <ThemeTile key={p.id} theme={p} active={t.id === p.id} onClick={() => set({ previewTheme: structuredClone(p) })} />
            ))}
          </div>
          <div className="field-label mt">Your library</div>
          <div className="theme-grid">
            {library.map((p) => (
              <ThemeTile
                key={p.id}
                theme={p}
                active={t.id === p.id}
                onClick={() => set({ previewTheme: structuredClone(p) })}
                onDelete={() => void app().saveThemeLibrary(library.filter((x) => x.id !== p.id))}
              />
            ))}
            {!library.length && <div className="muted small">Save a theme to your library to keep it here.</div>}
          </div>
          <div className="btn-row mt">
            <Button
              kind="ghost"
              small
              onClick={async () => {
                const [f] = await pickFile('.json,application/json');
                if (!f) return;
                try {
                  const theme = await importThemeFile(await f.text());
                  set({ previewTheme: theme });
                  toast(`Imported ${theme.name}. Save to apply it.`, 'success');
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              }}
            >
              <I.upload size={14} /> Import theme file
            </Button>
          </div>
        </>
      )}

      {section === 'colors' && (
        <>
          <Field label="Base">
            <Segmented value={t.base} onChange={(v) => edit((x) => ({ ...x, base: v }))} options={[{ value: 'dark', label: <><I.moon size={14} /> Dark</> }, { value: 'light', label: <><I.sun size={14} /> Light</> }]} />
          </Field>
          {COLOR_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="field-label mt">{g.title}</div>
              <div className="color-grid">
                {g.keys.map(([k, label]) => (
                  <ColorInput key={k} label={label} value={t.colors[k]} onChange={(v) => edit((x) => ({ ...x, colors: { ...x.colors, [k]: v } }))} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {section === 'type' && (
        <>
          <div className="grid3">
            <FontSelect label="Interface font" value={t.fonts.ui} custom={customFonts} onChange={(v) => edit((x) => ({ ...x, fonts: { ...x.fonts, ui: v } }))} />
            <FontSelect label="Message font" value={t.fonts.chat} custom={customFonts} onChange={(v) => edit((x) => ({ ...x, fonts: { ...x.fonts, chat: v } }))} />
            <FontSelect label="Code font" value={t.fonts.mono} custom={customFonts} mono onChange={(v) => edit((x) => ({ ...x, fonts: { ...x.fonts, mono: v } }))} />
          </div>
          <div className="font-sample" style={{ fontFamily: 'var(--font-chat)' }}>
            The quick brown fox jumps over the lazy dog. 0123456789 <code>const p2p = true;</code>
          </div>
          <Field label="Your fonts" hint="Upload TTF, OTF, WOFF or WOFF2. They work everywhere in the app and are stored on this device.">
            <div className="btn-row wrap">
              {customFonts.map((f) => (
                <span key={f.key} className="chip">
                  {f.label}
                  <button type="button" onClick={() => void app().removeCustomFont(f.hash)} title="Remove">
                    <I.x size={12} />
                  </button>
                </span>
              ))}
              <Button
                small
                kind="subtle"
                onClick={async () => {
                  const [f] = await pickFile('.ttf,.otf,.woff,.woff2,font/*');
                  if (!f) return;
                  try {
                    const key = await app().addCustomFont(f);
                    edit((x) => ({ ...x, fonts: { ...x.fonts, ui: key, chat: key } }));
                    toast(`${f.name} added and applied`, 'success');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                <I.upload size={14} /> Upload font
              </Button>
            </div>
          </Field>
          <Field label="Text size">
            <Slider value={t.fonts.size} min={11} max={24} onChange={(v) => edit((x) => ({ ...x, fonts: { ...x.fonts, size: v } }))} format={(v) => `${v}px`} />
          </Field>
          <Field label="Line height">
            <Slider value={t.fonts.lineHeight} min={1.1} max={2} step={0.05} onChange={(v) => edit((x) => ({ ...x, fonts: { ...x.fonts, lineHeight: v } }))} format={(v) => v.toFixed(2)} />
          </Field>
          <Field label="Text weight">
            <Slider value={t.fonts.weight} min={300} max={700} step={50} onChange={(v) => edit((x) => ({ ...x, fonts: { ...x.fonts, weight: v } }))} />
          </Field>
        </>
      )}

      {section === 'layout' && (
        <>
          <Field label="Message style">
            <Segmented
              value={t.layout.messageStyle}
              onChange={(v) => edit((x) => ({ ...x, layout: { ...x.layout, messageStyle: v } }))}
              options={[{ value: 'cozy', label: 'Cozy' }, { value: 'compact', label: 'Compact' }, { value: 'bubbles', label: 'Bubbles' }, { value: 'cards', label: 'Cards' }]}
            />
          </Field>
          <Field label="Avatar shape">
            <Segmented value={t.layout.avatarShape} onChange={(v) => edit((x) => ({ ...x, layout: { ...x.layout, avatarShape: v } }))} options={[{ value: 'circle', label: 'Circle' }, { value: 'squircle', label: 'Squircle' }, { value: 'square', label: 'Square' }]} />
          </Field>
          <div className="grid2">
            <Field label="Avatar size in chat">
              <Slider value={t.layout.avatarSize} min={24} max={64} onChange={(v) => edit((x) => ({ ...x, layout: { ...x.layout, avatarSize: v } }))} format={(v) => `${v}px`} />
            </Field>
            <Field label="Corner roundness">
              <Slider value={t.layout.radius} min={0} max={28} onChange={(v) => edit((x) => ({ ...x, layout: { ...x.layout, radius: v } }))} format={(v) => `${v}px`} />
            </Field>
            <Field label="Spacing">
              <Slider value={t.layout.spacing} min={0.6} max={1.6} step={0.05} onChange={(v) => edit((x) => ({ ...x, layout: { ...x.layout, spacing: v } }))} format={(v) => `${Math.round(v * 100)}%`} />
            </Field>
            <Field label="Sidebar width">
              <Slider value={t.layout.sideWidth} min={200} max={360} onChange={(v) => edit((x) => ({ ...x, layout: { ...x.layout, sideWidth: v } }))} format={(v) => `${v}px`} />
            </Field>
            <Field label="Member list width">
              <Slider value={t.layout.membersWidth} min={200} max={360} onChange={(v) => edit((x) => ({ ...x, layout: { ...x.layout, membersWidth: v } }))} format={(v) => `${v}px`} />
            </Field>
          </div>
          <Toggle on={t.layout.railLabels} onChange={(v) => edit((x) => ({ ...x, layout: { ...x.layout, railLabels: v } }))} label="Show community names in the rail" />
          <Toggle on={t.layout.glass} onChange={(v) => edit((x) => ({ ...x, layout: { ...x.layout, glass: v } }))} label="Frosted glass popups" />
          <Field label="Animations">
            <Segmented value={t.layout.animations} onChange={(v) => edit((x) => ({ ...x, layout: { ...x.layout, animations: v } }))} options={[{ value: 'full', label: 'Full' }, { value: 'reduced', label: 'Reduced' }, { value: 'none', label: 'Off' }]} />
          </Field>
        </>
      )}

      {section === 'background' && (
        <>
          <Field label="Chat background">
            <Segmented value={t.chatBg.kind} onChange={(v) => edit((x) => ({ ...x, chatBg: { ...x.chatBg, kind: v } }))} options={[{ value: 'none', label: 'Theme color' }, { value: 'color', label: 'Solid' }, { value: 'gradient', label: 'Gradient' }, { value: 'image', label: 'Image' }]} />
          </Field>
          {t.chatBg.kind === 'color' && <ColorInput value={t.chatBg.color} onChange={(v) => edit((x) => ({ ...x, chatBg: { ...x.chatBg, color: v } }))} label="Color" />}
          {t.chatBg.kind === 'gradient' && (
            <>
              <div className="grid2">
                <ColorInput value={t.chatBg.from} onChange={(v) => edit((x) => ({ ...x, chatBg: { ...x.chatBg, from: v } }))} label="From" />
                <ColorInput value={t.chatBg.to} onChange={(v) => edit((x) => ({ ...x, chatBg: { ...x.chatBg, to: v } }))} label="To" />
              </div>
              <Field label="Angle">
                <Slider value={t.chatBg.angle} min={0} max={360} onChange={(v) => edit((x) => ({ ...x, chatBg: { ...x.chatBg, angle: v } }))} format={(v) => `${v}°`} />
              </Field>
            </>
          )}
          {t.chatBg.kind === 'image' && (
            <>
              <div className="bg-preview" style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : undefined}>
                <Button
                  small
                  kind="subtle"
                  onClick={async () => {
                    const [f] = await pickFile('image/png,image/jpeg,image/gif,image/webp');
                    if (!f) return;
                    if (f.size > 12 * 1024 * 1024) return toast('Backgrounds must be under 12 MB', 'error');
                    const ref = await app().storeImage(f, 'background');
                    edit((x) => ({ ...x, chatBg: { ...x.chatBg, image: ref.hash } }));
                  }}
                >
                  <I.upload size={14} /> {t.chatBg.image ? 'Replace image' : 'Choose image'}
                </Button>
              </div>
              <Field label="Darken">
                <Slider value={t.chatBg.dim} min={0} max={0.95} step={0.05} onChange={(v) => edit((x) => ({ ...x, chatBg: { ...x.chatBg, dim: v } }))} format={(v) => `${Math.round(v * 100)}%`} />
              </Field>
              <Field label="Blur">
                <Slider value={t.chatBg.blur} min={0} max={30} onChange={(v) => edit((x) => ({ ...x, chatBg: { ...x.chatBg, blur: v } }))} format={(v) => `${v}px`} />
              </Field>
              <Field label="Fit">
                <Segmented value={t.chatBg.fit} onChange={(v) => edit((x) => ({ ...x, chatBg: { ...x.chatBg, fit: v } }))} options={[{ value: 'cover', label: 'Cover' }, { value: 'tile', label: 'Tile' }]} />
              </Field>
            </>
          )}
        </>
      )}

      {section === 'css' && (
        <>
          <div className="info-box warn">
            <I.alert size={16} />
            <span>
              Custom CSS can restyle anything. Only paste CSS you understand. The app's Content Security Policy blocks CSS from loading anything off-site (so a shared theme cannot track you with remote images), but it
              can still hide or rearrange things.
            </span>
          </div>
          <textarea className="css-box mono" value={t.customCss} spellCheck={false} onChange={(e) => edit((x) => ({ ...x, customCss: e.target.value }))} placeholder={'.msg-author { letter-spacing: .02em; }\n.rail { box-shadow: inset -1px 0 var(--accent); }'} rows={14} />
        </>
      )}

      <div className="theme-actions">
        <Field label="Theme name">
          <input value={t.name} onChange={(e) => edit((x) => ({ ...x, name: e.target.value.slice(0, 80) }))} />
        </Field>
        <div className="btn-row wrap">
          <Button
            kind="ghost"
            small
            onClick={async () => {
              const theme = { ...t, id: t.id.startsWith('custom-') ? t.id : 'custom-' + Date.now().toString(36) };
              const lib = [theme, ...library.filter((x) => x.id !== theme.id)].slice(0, 50);
              await app().saveThemeLibrary(lib);
              set({ previewTheme: theme });
              toast('Saved to your library', 'success');
            }}
          >
            <I.star size={14} /> Save to library
          </Button>
          <Button kind="ghost" small onClick={async () => download(`${t.name || 'theme'}.celtheme.json`, await exportThemeFile(t))}>
            <I.download size={14} /> Export
          </Button>
          <ShareButton theme={t} />
        </div>
      </div>
      {dirty && (
        <div className="save-bar">
          <span>Previewing "{t.name}"</span>
          <Button kind="ghost" small onClick={() => { set({ previewTheme: null }); app().navigate(useStore.getState().view); }}>
            Revert
          </Button>
          <Button small onClick={() => void app().saveTheme(t).then(() => toast('Theme applied', 'success'))}>
            Save & apply
          </Button>
        </div>
      )}
    </div>
  );
}

function ShareButton({ theme }: { theme: Theme }) {
  const view = useStore((s) => s.view);
  const target = view.kind === 'community' && view.ch ? { c: view.c, ch: view.ch } : view.kind === 'dm' ? { c: view.c, ch: 'main' } : null;
  if (!target) return null;
  return (
    <Button
      kind="ghost"
      small
      onClick={() =>
        confirmDialog({
          title: 'Share this theme?',
          body: 'It is sent to the conversation you have open as a theme file. Anyone there can preview and apply it.',
          confirm: 'Share',
          onConfirm: async () => {
            const json = await exportThemeFile(theme);
            const file = new File([json], `${theme.name || 'theme'}.celtheme.json`, { type: 'application/json' });
            await app().sendMessage(target.c, target.ch, `Here's my theme **${theme.name}**`, [file]);
            toast('Theme shared', 'success');
          },
        })
      }
    >
      <I.send size={14} /> Share in current chat
    </Button>
  );
}

function ThemeTile({ theme, active, onClick, onDelete }: { theme: Theme; active: boolean; onClick: () => void; onDelete?: () => void }) {
  const c = theme.colors;
  return (
    <button type="button" className={cls('theme-tile', active && 'on')} onClick={onClick} style={{ background: c.chat, color: c.text, borderRadius: Math.min(16, theme.layout.radius + 4) }}>
      <span className="tt-rail" style={{ background: c.rail }} />
      <span className="tt-side" style={{ background: c.side }}>
        <i style={{ background: c.accent }} />
        <i style={{ background: c.text3 }} />
        <i style={{ background: c.text3 }} />
      </span>
      <span className="tt-chat">
        <span className="tt-msg" style={{ background: c.elev }} />
        <span className="tt-msg short" style={{ background: c.accent, opacity: 0.85 }} />
      </span>
      <span className="tt-name" style={{ fontFamily: `var(--font-ui)` }}>
        {theme.name}
      </span>
      {onDelete && (
        <span
          className="tt-del"
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <I.x size={12} />
        </span>
      )}
    </button>
  );
}

function FontSelect({ label, value, custom, onChange, mono }: { label: string; value: string; custom: { key: string; label: string }[]; onChange: (v: string) => void; mono?: boolean }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {custom.length > 0 && (
          <optgroup label="Your fonts">
            {custom.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label={mono ? 'Monospace' : 'Bundled'}>
          {FONTS.filter((f) => (mono ? f.kind === 'mono' : f.kind !== 'mono')).map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </optgroup>
      </select>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Theme files: the theme plus any background image and custom fonts it uses
// ---------------------------------------------------------------------------

export async function exportThemeFile(t: Theme): Promise<string> {
  const assets: Record<string, { mime: string; data: string; label?: string }> = {};
  const add = async (hash: string, label?: string) => {
    const blob = await app().files.getBlob(hash);
    if (blob && blob.size < 6 * 1024 * 1024) assets[hash] = { mime: blob.type || 'application/octet-stream', data: toB64(new Uint8Array(await blob.arrayBuffer())), label };
  };
  if (t.chatBg.image) await add(t.chatBg.image);
  for (const k of [t.fonts.ui, t.fonts.chat, t.fonts.mono]) {
    if (k.startsWith('custom:')) {
      const hash = k.slice(7);
      const f = useStore.getState().customFonts.find((x) => x.hash === hash);
      await add(hash, f?.label ?? 'Custom font');
    }
  }
  return JSON.stringify({ type: 'celchat-theme', v: 1, theme: { ...t, author: t.author ?? app().myCard.username }, assets }, null, 1);
}

export async function importThemeFile(text: string): Promise<Theme> {
  let raw: { type?: string; theme?: unknown; assets?: Record<string, { mime: string; data: string; label?: string }> };
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That theme file is not valid JSON.');
  }
  const themeRaw = raw.type === 'celchat-theme' ? raw.theme : raw;
  const theme = normalizeTheme(themeRaw);
  if (!theme) throw new Error('That is not a CelChat theme.');
  theme.id = 'custom-' + Date.now().toString(36);
  for (const [hash, a] of Object.entries(raw.assets ?? {})) {
    if (!/^[0-9a-f]{64}$/.test(hash) || typeof a?.data !== 'string') continue;
    const bytes = fromB64(a.data);
    if ((await sha256File(bytes)) !== hash) continue; // never trust embedded data blindly
    const isFont = [theme.fonts.ui, theme.fonts.chat, theme.fonts.mono].includes('custom:' + hash);
    const file = new File([bytes as Uint8Array<ArrayBuffer>], a.label ?? 'asset', { type: a.mime });
    if (isFont) {
      try {
        await app().addCustomFont(file);
        await registerCustomFont(hash, a.label ?? 'Custom font', file);
      } catch {
        /* unusable font: falls back */
      }
    } else await app().files.put(file, 'theme-background', a.mime);
  }
  if (theme.chatBg.image) await app().ensureBlob({ hash: theme.chatBg.image, mime: 'image/png', size: 1 }, { auto: false });
  return theme;
}

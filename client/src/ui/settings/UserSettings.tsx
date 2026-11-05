import { useEffect, useState } from 'react';
import { useStore, closeModal, toast, set } from '../../state/store';
import { app } from '../../core/app';
import { Modal, Button, Field, I, Toggle, Segmented, Slider, ColorInput, cls, copy, pickFile, download, confirmDialog, fmtDate, IconButton } from '../common';
import { ProfileView } from '../profile/Profile';
import { ThemeEditor } from './ThemeEditor';
import { BotsTab } from '../bots/BotStudio';
import { recoveryKeyOf, changePassword, makeBackup, validatePassword, normalizeUsername, validateUsername } from '../../core/identity';
import { listDevices } from '../../core/voice';
import { askNotificationPermission } from '../../core/notify';
import { prepareImage, fmtBytes } from '../../core/media';
import { FONTS } from '../../core/theme';
import { defaultHubUrl } from '../../core/hub';
import { resolveHub } from '../../core/app';
import { PUBLIC_BROKERS } from '../../core/mqtthub';
import { PROVIDER_INFO } from '@shared/gifs';
import { SCREEN_QUALITY, type ScreenQuality } from '../../core/voice';
import { pttLabel } from '../voice/Stage';
import type { Settings } from '../../core/settings';
import type { ProfileCard, ProfileDraft } from '@shared/profile';
import { LIMITS } from '@shared/limits';

type Tab = 'account' | 'profile' | 'privacy' | 'appearance' | 'chat' | 'voice' | 'notifications' | 'bots' | 'network' | 'storage' | 'about';

const TABS: { id: Tab; label: string; group: string }[] = [
  { id: 'account', label: 'My account', group: 'User' },
  { id: 'profile', label: 'Profile', group: 'User' },
  { id: 'privacy', label: 'Privacy & safety', group: 'User' },
  { id: 'appearance', label: 'Appearance & themes', group: 'App' },
  { id: 'chat', label: 'Chat', group: 'App' },
  { id: 'voice', label: 'Voice & audio', group: 'App' },
  { id: 'notifications', label: 'Notifications', group: 'App' },
  { id: 'bots', label: 'Bots', group: 'Build' },
  { id: 'network', label: 'Connection & hub', group: 'Advanced' },
  { id: 'storage', label: 'Storage & backup', group: 'Advanced' },
  { id: 'about', label: 'How CelChat works', group: 'Advanced' },
];

export function UserSettings({ initial }: { initial?: string }) {
  const [tab, setTab] = useState<Tab>((initial as Tab) ?? 'account');
  const close = () => {
    if (useStore.getState().previewTheme) {
      set({ previewTheme: null });
      app().navigate(useStore.getState().view);
    }
    closeModal();
  };
  let group = '';
  return (
    <Modal wide="full" className="settings" onClose={close}>
      <div className="settings-layout">
        <nav className="settings-nav">
          {TABS.map((t) => {
            const head = t.group !== group;
            group = t.group;
            return (
              <div key={t.id}>
                {head && <div className="settings-group">{t.group}</div>}
                <button type="button" className={cls('settings-tab', tab === t.id && 'on')} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              </div>
            );
          })}
          <div className="settings-group" />
          <button type="button" className="settings-tab danger" onClick={() => void app().logout()}>
            <I.logout size={15} /> Sign out
          </button>
        </nav>
        <section className="settings-main">
          <button type="button" className="settings-close" onClick={close} title="Close (Esc)">
            <I.x size={20} />
          </button>
          {tab === 'account' && <AccountTab />}
          {tab === 'profile' && <ProfileTab />}
          {tab === 'privacy' && <PrivacyTab />}
          {tab === 'appearance' && <ThemeEditor />}
          {tab === 'chat' && <ChatTab />}
          {tab === 'voice' && <VoiceTab />}
          {tab === 'notifications' && <NotifyTab />}
          {tab === 'bots' && <BotsTab />}
          {tab === 'network' && <NetworkTab />}
          {tab === 'storage' && <StorageTab />}
          {tab === 'about' && <AboutTab />}
        </section>
      </div>
    </Modal>
  );
}

function useSettings(): [Settings, (fn: (s: Settings) => Settings) => void] {
  const s = useStore((x) => x.settings);
  return [s, (fn) => void app().saveSettings(fn(app().settings))];
}

// ---------------------------------------------------------------------------

function AccountTab() {
  const card = useStore((s) => s.myCard)!;
  const me = useStore((s) => s.me);
  const [showKey, setShowKey] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  return (
    <div className="settings-page">
      <h2>My account</h2>
      <div className="acct-card">
        <ProfileView pub={me} card={card} variant="preview" />
      </div>
      <Field label="CelChat ID" hint="Your public key. Share it to be added from any hub.">
        <div className="copy-row">
          <input readOnly value={me} className="mono" onFocus={(e) => e.target.select()} />
          <Button kind="ghost" onClick={() => void copy(me, 'ID copied')}>
            Copy
          </Button>
        </div>
      </Field>
      <h3>Recovery key</h3>
      <p className="muted">This key IS your account. Anyone with it can sign in as you. Write it down somewhere safe: nobody can reset it for you.</p>
      {showKey ? (
        <div className="recovery mono" onClick={() => void copy(recoveryKeyOf(app().keys), 'Recovery key copied')}>
          {recoveryKeyOf(app().keys)}
        </div>
      ) : (
        <Button kind="ghost" onClick={() => setShowKey(true)}>
          <I.key size={15} /> Reveal recovery key
        </Button>
      )}
      <h3>Change device password</h3>
      <p className="muted">Protects the key stored in this browser. Other devices keep their own password.</p>
      <div className="grid2">
        <input type="password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        <input type="password" placeholder="Confirm" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
      </div>
      <Button
        small
        disabled={!pw}
        onClick={async () => {
          const err = validatePassword(pw);
          if (err) return toast(err, 'error');
          if (pw !== pw2) return toast("Passwords don't match", 'error');
          await changePassword(app().session, pw);
          setPw('');
          setPw2('');
          toast('Password changed', 'success');
        }}
      >
        Change password
      </Button>
      <h3>Account created</h3>
      <p className="muted">{fmtDate(card.createdAt)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProfileTab() {
  const card = useStore((s) => s.myCard)!;
  const me = useStore((s) => s.me);
  const [d, setD] = useState<ProfileDraft>(() => ({ ...card }));
  const [avatar, setAvatar] = useState<Blob | null | undefined>(undefined);
  const [banner, setBanner] = useState<Blob | null | undefined>(undefined);
  const [urls, setUrls] = useState<{ avatar?: string | null; banner?: string | null }>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const curAvatar = useStore((s) => (card.avatar ? s.blobUrls[card.avatar.hash] : undefined));
  const curBanner = useStore((s) => (card.banner ? s.blobUrls[card.banner.hash] : undefined));
  const dirty = JSON.stringify({ ...d }) !== JSON.stringify({ ...card }) || avatar !== undefined || banner !== undefined;
  const preview: ProfileCard = { ...card, ...d } as ProfileCard;
  const pick = async (kind: 'avatar' | 'banner') => {
    const [f] = await pickFile('image/png,image/jpeg,image/gif,image/webp');
    if (!f) return;
    try {
      const max = kind === 'avatar' ? LIMITS.avatarMaxBytes : LIMITS.bannerMaxBytes;
      const blob = await prepareImage(f, kind === 'avatar' ? 512 : 1600, max);
      const url = URL.createObjectURL(blob);
      if (kind === 'avatar') {
        setAvatar(blob);
        setUrls((u) => ({ ...u, avatar: url }));
      } else {
        setBanner(blob);
        setUrls((u) => ({ ...u, banner: url }));
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const up = (patch: Partial<ProfileDraft>) => setD({ ...d, ...patch });
  return (
    <div className="settings-page profile-editor">
      <h2>Profile</h2>
      <p className="muted">Everything here is free: animated avatars and banners, colors, fonts. Your profile is a signed card that peers verify.</p>
      <div className="profile-edit-layout">
        <div className="profile-fields">
          <div className="grid2">
            <Field label="Display name">
              <input value={d.displayName} onChange={(e) => up({ displayName: e.target.value })} maxLength={32} />
            </Field>
            <Field label="Username" error={err}>
              <div className="input-prefix">
                <span>@</span>
                <input
                  value={d.username}
                  onChange={(e) => {
                    const u = normalizeUsername(e.target.value);
                    up({ username: u });
                    setErr(validateUsername(u));
                  }}
                  maxLength={32}
                  spellCheck={false}
                />
              </div>
            </Field>
          </div>
          <Field label="Pronouns">
            <input value={d.pronouns} onChange={(e) => up({ pronouns: e.target.value })} maxLength={40} />
          </Field>
          <div className="grid2">
            <Field label="Avatar" hint="PNG, JPG, WebP or animated GIF up to 8 MB">
              <div className="btn-row">
                <Button small kind="subtle" onClick={() => void pick('avatar')}>
                  <I.upload size={14} /> Upload
                </Button>
                {(card.avatar || avatar) && avatar !== null && (
                  <Button small kind="ghost" onClick={() => { setAvatar(null); setUrls((u) => ({ ...u, avatar: null })); }}>
                    Remove
                  </Button>
                )}
              </div>
            </Field>
            <Field label="Banner" hint="Up to 10 MB, GIFs animate">
              <div className="btn-row">
                <Button small kind="subtle" onClick={() => void pick('banner')}>
                  <I.upload size={14} /> Upload
                </Button>
                {(card.banner || banner) && banner !== null && (
                  <Button small kind="ghost" onClick={() => { setBanner(null); setUrls((u) => ({ ...u, banner: null })); }}>
                    Remove
                  </Button>
                )}
              </div>
            </Field>
          </div>
          <Field label="Profile colors" hint="Card gradient (and the banner when you have none)">
            <div className="grid2">
              <ColorInput value={d.colors.primary} onChange={(v) => up({ colors: { ...d.colors, primary: v.slice(0, 7) } })} label="Primary" />
              <ColorInput value={d.colors.accent} onChange={(v) => up({ colors: { ...d.colors, accent: v.slice(0, 7) } })} label="Accent" />
            </div>
          </Field>
          <div className="grid2">
            <Field label="Name font">
              <select value={d.font} onChange={(e) => up({ font: e.target.value })}>
                <option value="default">App font</option>
                {FONTS.filter((f) => f.kind !== 'mono').map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name style">
              <select value={d.nameStyle} onChange={(e) => up({ nameStyle: e.target.value as ProfileDraft['nameStyle'] })}>
                <option value="plain">Plain</option>
                <option value="gradient">Gradient (your colors)</option>
                <option value="glow">Glow</option>
                <option value="shadow">Drop shadow</option>
              </select>
            </Field>
          </div>
          <Field label={`About me (${d.about.length}/${LIMITS.aboutChars})`} hint="Markdown works: **bold**, links, `code`">
            <textarea value={d.about} onChange={(e) => up({ about: e.target.value.slice(0, LIMITS.aboutChars) })} rows={5} />
          </Field>
        </div>
        <div className="profile-preview">
          <div className="field-label">Preview</div>
          <ProfileView pub={me} card={preview} variant="preview" previewUrls={{ avatar: urls.avatar !== undefined ? urls.avatar : curAvatar ?? null, banner: urls.banner !== undefined ? urls.banner : curBanner ?? null }} />
        </div>
      </div>
      {dirty && (
        <div className="save-bar">
          <span>Careful, you have unsaved changes</span>
          <Button kind="ghost" small onClick={() => { setD({ ...card }); setAvatar(undefined); setBanner(undefined); setUrls({}); setErr(null); }}>
            Reset
          </Button>
          <Button
            small
            busy={busy}
            disabled={!!err}
            onClick={async () => {
              setBusy(true);
              try {
                await app().saveProfile({ ...d, displayName: d.displayName.trim() }, { avatar, banner });
                setAvatar(undefined);
                setBanner(undefined);
                setUrls({});
                toast('Profile saved and sent to peers', 'success');
              } catch (e) {
                toast((e as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PrivacyTab() {
  const [s, save] = useSettings();
  const p = s.privacy;
  const up = (patch: Partial<Settings['privacy']>) => save((x) => ({ ...x, privacy: { ...x.privacy, ...patch } }));
  const turn = useStore((x) => x.hub.info?.features.turn);
  return (
    <div className="settings-page">
      <h2>Privacy & safety</h2>
      <Field label="Direct peer-to-peer connections" hint="A direct WebRTC link shows the other person your public IP address. Relayed links hide it but go through the hub (still end-to-end encrypted).">
        <Segmented
          value={p.direct}
          onChange={(v) => up({ direct: v })}
          options={[
            { value: 'all', label: 'People I share a community with' },
            { value: 'friends', label: 'Friends only' },
            { value: 'never', label: turn ? 'Never (TURN only)' : 'Never (relay only)' },
          ]}
        />
      </Field>
      <Toggle on={p.relay} onChange={(v) => up({ relay: v })} label="Allow encrypted relay fallback" desc="When a direct connection is impossible (strict NAT/firewall), send text and files through the hub, encrypted so the hub cannot read them. Voice cannot be relayed this way." />
      <Field label="Who can DM you">
        <Segmented value={p.dmsFrom} onChange={(v) => up({ dmsFrom: v })} options={[{ value: 'all', label: 'Anyone' }, { value: 'members', label: 'Friends + community members' }, { value: 'friends', label: 'Friends only' }]} />
      </Field>
      <Field label="Who can send you friend requests">
        <Segmented value={p.friendReqFrom} onChange={(v) => up({ friendReqFrom: v })} options={[{ value: 'all', label: 'Everyone' }, { value: 'members', label: 'Community members' }, { value: 'none', label: 'Nobody' }]} />
      </Field>
      <Toggle on={p.shareFriends} onChange={(v) => up({ shareFriends: v })} label="Share my friend list with my friends" desc="Lets friends see mutual friends on your profile. Only sent over encrypted links to friends." />
      <Toggle on={p.readReceipts} onChange={(v) => up({ readReceipts: v })} label="Send read receipts in DMs" />
      <Toggle on={p.typing} onChange={(v) => up({ typing: v })} label="Show when I'm typing" />
      <Toggle on={s.vaultSync} onChange={(v) => save((x) => ({ ...x, vaultSync: v }))} label="Encrypted account vault on the hub" desc="Keeps your friend list, communities and settings (not messages) on the hub, encrypted with a key only you have, so a new device can restore them." />
    </div>
  );
}

function ChatTab() {
  const [s, save] = useSettings();
  const up = (patch: Partial<Settings['chat']>) => save((x) => ({ ...x, chat: { ...x.chat, ...patch } }));
  const upm = (patch: Partial<Settings['media']>) => save((x) => ({ ...x, media: { ...x.media, ...patch } }));
  return (
    <div className="settings-page">
      <h2>Chat</h2>
      <Toggle on={s.chat.enterSends} onChange={(v) => up({ enterSends: v })} label="Enter sends the message" desc="Off: Enter adds a new line and Ctrl+Enter sends." />
      <Toggle on={s.chat.clock24} onChange={(v) => up({ clock24: v })} label="24-hour clock" />
      <Toggle on={s.chat.spoilers === 'always'} onChange={(v) => up({ spoilers: v ? 'always' : 'click' })} label="Always reveal spoilers" />
      <Toggle on={s.chat.communityThemes} onChange={(v) => { up({ communityThemes: v }); setTimeout(() => app().navigate(useStore.getState().view), 50); }} label="Show community themes" desc="Communities can set accent colors and a font while you are in them." />
      <Toggle on={s.media.autoplayGifs} onChange={(v) => upm({ autoplayGifs: v })} label="Autoplay animated avatars" desc="Off: animated avatars play on hover." />
      <Field label="Read messages aloud" hint="Uses your device's built-in text-to-speech. Nothing leaves your device.">
        <Segmented value={s.chat.tts} onChange={(v) => up({ tts: v })} options={[{ value: 'off', label: 'Off' }, { value: 'mentions', label: 'When I am mentioned' }, { value: 'all', label: 'Everything in the open chat' }]} />
      </Field>
      <GifSettings />
      <h3>Files</h3>
      <Field label="Auto-download media up to" hint="Images and videos smaller than this download from peers automatically.">
        <Slider value={s.media.autoDownloadMB} min={0} max={100} onChange={(v) => upm({ autoDownloadMB: v })} format={(v) => (v ? `${v} MB` : 'Never')} />
      </Field>
      <Field label="Largest file I will send or receive" hint="Everything is held in memory while transferring, so very large files need a lot of RAM.">
        <Slider value={s.media.maxFileMB} min={5} max={2000} step={5} onChange={(v) => upm({ maxFileMB: v })} format={(v) => `${v} MB`} />
      </Field>
    </div>
  );
}

function GifSettings() {
  const [s, save] = useSettings();
  const g = s.gifs;
  const hubGifs = useStore((x) => x.hub.info?.features.gifs);
  const up = (patch: Partial<Settings['gifs']>) => save((x) => ({ ...x, gifs: { ...x.gifs, ...patch } }));
  const [key, setKey] = useState(g.key);
  const src = app().gifSource();
  return (
    <>
      <h3>GIF search</h3>
      <p className="muted small">
        Tenor&rsquo;s API was shut down by Google on June 30, 2026, so CelChat searches KLIPY (Tenor-compatible) or GIPHY instead. A GIF you pick is downloaded once and sent to the chat peer to peer like any
        file, so the people you send it to never contact the GIF service.
      </p>
      <div className="info-box">
        <I.info size={16} />
        <span>{src ? `GIF search is on: ${PROVIDER_INFO[src.provider].label}, ${src.via === 'hub' ? "through your hub (the provider never sees your IP)" : 'directly from this device with your own key'}.` : 'GIF search is off: add a key below, or use a hub that has one.'}</span>
      </div>
      {hubGifs && <Toggle on={g.useHub} onChange={(v) => up({ useHub: v })} label={`Use the hub's GIF search (${PROVIDER_INFO[hubGifs].label})`} desc="Your searches go to the hub, which asks the provider for you." />}
      {(!hubGifs || !g.useHub) && (
        <>
          <div className="grid2">
            <Field label="Provider">
              <select value={g.provider} onChange={(e) => up({ provider: e.target.value as Settings['gifs']['provider'] })}>
                <option value="klipy">KLIPY (Tenor-compatible)</option>
                <option value="giphy">GIPHY</option>
                <option value="tenor-compatible">Other Tenor-compatible API</option>
              </select>
            </Field>
            <Field label="Content filter">
              <select value={g.filter} onChange={(e) => up({ filter: e.target.value as Settings['gifs']['filter'] })}>
                <option value="high">Strict</option>
                <option value="medium">Moderate</option>
                <option value="low">Light</option>
                <option value="off">Off</option>
              </select>
            </Field>
          </div>
          {g.provider === 'tenor-compatible' && (
            <Field label="API base URL" hint="The server must speak Tenor's v2 API (/v2/search, /v2/featured).">
              <input value={g.base} onChange={(e) => up({ base: e.target.value.trim() })} placeholder="https://gifs.example.com" spellCheck={false} />
            </Field>
          )}
          <Field label="Your API key" hint={g.provider === 'giphy' ? 'Free from developers.giphy.com. Stored only on this device (and in your encrypted vault).' : 'Free from partner.klipy.com. Stored only on this device (and in your encrypted vault).'}>
            <div className="copy-row">
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
              <Button kind="ghost" onClick={() => up({ key: key.trim() })} disabled={key.trim() === g.key}>
                Save key
              </Button>
            </div>
          </Field>
        </>
      )}
    </>
  );
}

function VoiceTab() {
  const [s, save] = useSettings();
  const v = s.voice;
  const up = (patch: Partial<Settings['voice']>) => save((x) => ({ ...x, voice: { ...x.voice, ...patch } }));
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }>({ inputs: [], outputs: [], cameras: [] });
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState<(() => void) | null>(null);
  useEffect(() => {
    void listDevices().then(setDevices);
  }, [testing]);
  useEffect(() => () => testing?.(), [testing]);
  return (
    <div className="settings-page">
      <h2>Voice & audio</h2>
      <div className="grid2">
        <Field label="Input device">
          <select value={v.inputId} onChange={(e) => up({ inputId: e.target.value })}>
            <option value="default">Default</option>
            {devices.inputs
              .filter((d) => d.deviceId && d.deviceId !== 'default')
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microphone'}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Output device" hint={'setSinkId' in HTMLMediaElement.prototype ? undefined : 'This browser cannot pick an output device; it uses the system default.'}>
          <select value={v.outputId} onChange={(e) => up({ outputId: e.target.value })} disabled={!('setSinkId' in HTMLMediaElement.prototype)}>
            <option value="default">Default</option>
            {devices.outputs
              .filter((d) => d.deviceId && d.deviceId !== 'default')
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Speakers'}
                </option>
              ))}
          </select>
        </Field>
      </div>
      {!devices.inputs.some((d) => d.label) && <p className="muted small">Device names appear after you allow microphone access once (Test mic below).</p>}
      <Field label="Mic test">
        <div className="mic-test">
          <Button
            small
            kind={testing ? 'danger' : 'subtle'}
            onClick={async () => {
              if (testing) {
                testing();
                setTesting(null);
                setLevel(0);
                return;
              }
              try {
                const stop = await app().voice.testMic(setLevel);
                setTesting(() => stop);
              } catch (e) {
                toast((e as Error).message, 'error');
              }
            }}
          >
            {testing ? 'Stop' : "Let's check"}
          </Button>
          <div className="meter">
            <span style={{ width: `${level * 100}%` }} />
            <i style={{ left: `${Math.min(100, (v.sensitivity * 6) * 100)}%` }} title="Speaking threshold" />
          </div>
        </div>
      </Field>
      <Field label="Speaking sensitivity" hint="Lower picks up quieter speech for the speaking indicator.">
        <Slider value={v.sensitivity} min={0.004} max={0.08} step={0.002} onChange={(x) => up({ sensitivity: x })} format={(x) => x.toFixed(3)} />
      </Field>
      <Toggle on={v.noiseSuppression} onChange={(x) => up({ noiseSuppression: x })} label="Noise suppression" desc="Uses your browser's built-in suppression. Quality depends on the browser." />
      <Toggle on={v.echoCancellation} onChange={(x) => up({ echoCancellation: x })} label="Echo cancellation" />
      <Toggle on={v.autoGain} onChange={(x) => up({ autoGain: x })} label="Automatic gain control" />
      <h3>Input mode</h3>
      <Segmented value={v.mode} onChange={(x) => up({ mode: x })} options={[{ value: 'vad', label: 'Voice activity' }, { value: 'ptt', label: 'Push to talk' }]} />
      {v.mode === 'ptt' && (
        <div className="grid2 mt">
          <Field label="Push-to-talk key" hint="Works while CelChat is focused (the desktop app also has global hotkeys). Ignored while you type in a text box.">
            <KeyCapture value={v.pttKey} onChange={(code) => up({ pttKey: code })} />
          </Field>
          <Field label="Release delay">
            <Slider value={v.pttReleaseMs} min={0} max={1000} step={20} onChange={(x) => up({ pttReleaseMs: x })} format={(x) => `${x} ms`} />
          </Field>
        </div>
      )}
      <h3>Video & screen share</h3>
      <div className="grid2">
        <Field label="Camera">
          <select value={v.cameraId} onChange={(e) => up({ cameraId: e.target.value })}>
            <option value="default">Default</option>
            {devices.cameras
              .filter((d) => d.deviceId && d.deviceId !== 'default')
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Camera'}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Screen share quality" hint="No subscription needed for 1080p 60 fps or source quality. Higher settings need more upload bandwidth per viewer.">
          <select value={v.screenQuality} onChange={(e) => up({ screenQuality: e.target.value as ScreenQuality })}>
            {(Object.keys(SCREEN_QUALITY) as ScreenQuality[]).map((q) => (
              <option key={q} value={q}>
                {SCREEN_QUALITY[q].label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <SoundboardSettings />
      <div className="info-box">
        <I.info size={16} />
        <span>Calls are a peer-to-peer mesh: each person sends audio (and video) to every other person. Up to about 8 people works well on typical home upload speeds; rooms are capped at {LIMITS.voiceRoomCap}.</span>
      </div>
    </div>
  );
}

function KeyCapture({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const on = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') onChange(e.code);
      setListening(false);
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [listening, onChange]);
  return (
    <Button kind={listening ? 'primary' : 'ghost'} onClick={() => setListening(true)}>
      <I.keyboard size={15} /> {listening ? 'Press a key (Esc to cancel)' : pttLabel(value)}
    </Button>
  );
}

function SoundboardSettings() {
  const sounds = useStore((s) => s.settings.sounds);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🔊');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h3>Soundboard</h3>
      <p className="muted small">Short clips (up to 8 seconds, 1 MB) you can play into any call. Unlimited, and they work in every community.</p>
      <div className="emoji-add">
        <input value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 8))} className="emoji-in" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="airhorn" maxLength={32} />
        <Button
          busy={busy}
          disabled={!name.trim()}
          onClick={async () => {
            const [f] = await pickFile('audio/*');
            if (!f) return;
            setBusy(true);
            try {
              await app().addSound(f, name.trim(), emoji);
              setName('');
            } catch (e) {
              toast((e as Error).message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          <I.upload size={15} /> Add sound
        </Button>
      </div>
      <div className="emoji-list">
        {sounds.map((s) => (
          <div key={s.hash} className="emoji-row">
            <span className="sound-emoji">{s.emoji}</span>
            <span className="grow">{s.name}</span>
            <IconButton icon={I.trash} title="Remove" onClick={() => void app().removeSound(s.hash)} size={16} />
          </div>
        ))}
      </div>
    </>
  );
}

function NotifyTab() {
  const [s, save] = useSettings();
  const up = (patch: Partial<Settings['notify']>) => save((x) => ({ ...x, notify: { ...x.notify, ...patch } }));
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  return (
    <div className="settings-page">
      <h2>Notifications</h2>
      <Toggle on={s.notify.desktop && perm === 'granted'} onChange={async (v) => {
        if (v) {
          const r = await askNotificationPermission();
          setPerm(r as NotificationPermission);
          if (r !== 'granted') return toast('Your browser blocked notifications for this site.', 'error');
        }
        up({ desktop: v });
      }} label="Desktop notifications" desc={perm === 'denied' ? 'Blocked in your browser settings.' : 'Shown while CelChat is open in the background. (No push server exists, so a closed tab cannot notify you.)'} />
      <Toggle on={s.notify.sounds} onChange={(v) => up({ sounds: v })} label="Sounds" />
      <Toggle on={s.notify.calls} onChange={(v) => up({ calls: v })} label="Ring for incoming calls" />
      <Field label="Default for communities" hint="Each community and channel can override this from its menu.">
        <Segmented value={s.notify.level} onChange={(v) => up({ level: v })} options={[{ value: 'all', label: 'All messages' }, { value: 'mentions', label: 'Only @mentions' }, { value: 'none', label: 'Nothing' }]} />
      </Field>
      <p className="muted small">Do Not Disturb (from your status menu) silences everything. DMs always notify unless muted.</p>
    </div>
  );
}

function NetworkTab() {
  const hub = useStore((s) => s.hub);
  const links = useStore((s) => s.links);
  const s = useStore((x) => x.settings);
  const current = resolveHub(s.hubUrl);
  const [mode, setMode] = useState<'mqtt' | 'hub'>(current.kind);
  const [url, setUrl] = useState(current.kind === 'hub' ? current.url : defaultHubUrl());
  const target = mode === 'mqtt' ? 'mqtt' : url.trim();
  const changed = mode !== current.kind || (mode === 'hub' && current.kind === 'hub' && url.trim() !== current.url);
  return (
    <div className="settings-page">
      <h2>Connection</h2>
      <div className="info-box">
        <I.server size={16} />
        <span>
          Connected through <b>{hub.info?.name ?? 'unknown'}</b> ({hub.state}). Available:{' '}
          {hub.info
            ? Object.entries(hub.info.features)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(', ')
            : 'n/a'}
          .
        </span>
      </div>
      <Field label="How CelChat finds people" hint="Messages, files and calls always go peer to peer. This only decides who introduces peers and holds sealed mail for offline friends. You can only meet people who use the same network.">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'mqtt', label: 'Public brokers (no server)' },
            { value: 'hub', label: 'A CelChat hub' },
          ]}
        />
      </Field>
      {mode === 'mqtt' ? (
        <p className="muted small">
          Uses free public MQTT brokers ({PUBLIC_BROKERS.map((b) => new URL(b).hostname).join(', ')}) as dumb relays. Everything sent through them is encrypted; their operators see only encrypted
          traffic, topic hashes and your IP address. Usernames are first come, first served but not enforced there, so check IDs. No avatar cache.
        </p>
      ) : (
        <Field label="Hub address" hint="A hub is the small server in this repo (npm start). Run your own: see SELF_HOSTING.md.">
          <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} placeholder="wss://chat.example.com/ws" />
        </Field>
      )}
      {changed && (
        <Button
          onClick={() =>
            confirmDialog({
              title: 'Switch network?',
              body: 'CelChat reloads and reconnects. Your communities and messages stay on this device; you will meet the people on the new network.',
              confirm: 'Switch',
              onConfirm: () => void app().setHubUrl(target),
            })
          }
        >
          Switch
        </Button>
      )}      <h3>Peer links · {links.length}</h3>
      <div className="table">
        {links.map((l) => (
          <div key={l.addr} className="trow">
            <span className={cls('link-state', l.state)}>{l.state}</span>
            <span className="grow">
              {app().nameOf(l.pub)} <span className="muted small mono">{l.addr.slice(65, 73)}</span>
            </span>
            <span className="muted small">{l.purposes.join(', ')}</span>
            <span className="muted small">{l.rtt !== null ? `${l.rtt} ms` : ''}</span>
          </div>
        ))}
        {!links.length && <p className="muted">No peer links yet. They open when friends or community members are online.</p>}
      </div>
      <p className="muted small">direct = WebRTC peer to peer (DTLS encrypted, identity-verified). relay = through the hub, AES-GCM encrypted end to end.</p>
    </div>
  );
}

function StorageTab() {
  const [u, setU] = useState<Awaited<ReturnType<ReturnType<typeof app>['storageUsage']>> | null>(null);
  const [pw, setPw] = useState('');
  useEffect(() => {
    void app().storageUsage().then(setU);
  }, []);
  return (
    <div className="settings-page">
      <h2>Storage & backup</h2>
      <p className="muted">Everything lives in this browser (IndexedDB). Browsers can clear site data under storage pressure, so keep a backup.</p>
      {u && (
        <div className="info-box">
          <I.disk size={16} />
          <span>
            Files cached: {u.files.count} ({fmtBytes(u.files.bytes)}). Site storage: {u.usage !== null ? fmtBytes(u.usage) : '?'}
            {u.quota !== null && ` of ${fmtBytes(u.quota)}`}. Persistent: {u.persisted ? 'yes' : 'no (the browser may evict data)'}.
          </span>
        </div>
      )}
      <Button
        kind="ghost"
        small
        onClick={() =>
          confirmDialog({
            title: 'Clear file cache?',
            body: 'Downloaded attachments are removed from this device. They can be fetched again from peers who still have them. Files only you had are gone for good.',
            confirm: 'Clear cache',
            danger: true,
            onConfirm: async () => {
              await app().clearFileCache();
              setU(await app().storageUsage());
            },
          })
        }
      >
        Clear file cache
      </Button>
      <h3>Backup file</h3>
      <p className="muted">Encrypted with a password you choose: your key, friends, communities, settings and themes. Message history is not included (it re-syncs from peers).</p>
      <div className="copy-row">
        <input type="password" placeholder="Backup password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        <Button
          disabled={pw.length < 8}
          onClick={async () => {
            const b = await makeBackup(app().session, pw, await app().accountData());
            download(`celchat-${app().myCard.username}.celchat-backup.json`, JSON.stringify(b));
            setPw('');
            toast('Backup downloaded', 'success');
          }}
        >
          <I.download size={15} /> Export
        </Button>
      </div>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="settings-page about">
      <h2>How CelChat works</h2>
      <p>
        <b>Your identity</b> is an Ed25519 key pair made in your browser. Everything you do is a signed operation. No company account, no password database.
      </p>
      <p>
        <b>Communities</b> are logs of signed operations kept by their members. Every member's client re-checks every operation against roles, bans and permissions, so nobody can fake moderator powers (or
        backdate them after being demoted).
      </p>
      <p>
        <b>Messages, files and voice</b> go directly between devices over WebRTC. DMs are end-to-end encrypted on every path. Attachments are never uploaded to a server.
      </p>
      <p>
        <b>The hub</b> introduces peers, relays encrypted frames when direct links fail, and holds sealed mail for offline friends. It never sees community messages or DM contents.
      </p>
      <h3>Honest limitations</h3>
      <ul>
        <li>A community's messages are only available when at least one member who has them is online.</li>
        <li>Strict NATs and corporate firewalls need a TURN server for voice. Text and files fall back to the encrypted hub relay.</li>
        <li>Mesh voice works best up to about 8 people.</li>
        <li>Hidden channels are hidden in the UI but not encrypted: members' devices still sync them.</li>
        <li>No forward-secrecy ratchet yet in DMs (static X25519 keys).</li>
        <li>Notifications only arrive while a CelChat tab is open.</li>
      </ul>
    </div>
  );
}

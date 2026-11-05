import { useEffect, useRef, useState } from 'react';
import { useStore, openMenu, openModal, toast } from '../../state/store';
import { app } from '../../core/app';
import { Avatar, I, UserName, cls, IconButton, Empty } from '../common';
import { SCREEN_QUALITY, type ScreenQuality, type VoicePeer } from '../../core/voice';
import type { CommunityState } from '@shared/engine';

interface Tile {
  key: string;
  pub: string;
  addr: string | null;
  kind: 'screen' | 'cam' | 'avatar';
  stream: MediaStream | null;
  speaking: boolean;
  muted: boolean;
  deaf: boolean;
  me: boolean;
  connected: boolean;
}

/** Everyone in the room as tiles: screens first (big), then cameras, then avatars. */
export function useTiles(): Tile[] {
  const v = useStore((s) => s.voice);
  const me = useStore((s) => s.me);
  const tiles: Tile[] = [];
  const add = (pub: string, addr: string | null, p: Pick<VoicePeer, 'speaking' | 'muted' | 'deaf'> & { cam: MediaStream | null; screen: MediaStream | null; connected: boolean }, isMe: boolean) => {
    if (p.screen) tiles.push({ key: (addr ?? 'me') + 's', pub, addr, kind: 'screen', stream: p.screen, speaking: false, muted: p.muted, deaf: p.deaf, me: isMe, connected: p.connected });
    tiles.push({ key: (addr ?? 'me') + 'c', pub, addr, kind: p.cam ? 'cam' : 'avatar', stream: p.cam, speaking: p.speaking, muted: p.muted, deaf: p.deaf, me: isMe, connected: p.connected });
  };
  add(me, null, { speaking: v.speaking, muted: v.muted || !v.transmitting, deaf: v.deafened, cam: v.cam, screen: v.screen, connected: true }, true);
  for (const p of v.peers) add(p.pub, p.addr, p, false);
  return tiles.sort((a, b) => (a.kind === 'screen' ? 0 : a.kind === 'cam' ? 1 : 2) - (b.kind === 'screen' ? 0 : b.kind === 'cam' ? 1 : 2));
}

function VideoEl({ stream, mirror, contain }: { stream: MediaStream; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className={cls(mirror && 'mirror', contain && 'contain')} />;
}

export function MediaGrid({ compact }: { compact?: boolean }) {
  const tiles = useTiles();
  const [focus, setFocus] = useState<string | null>(null);
  const focused = tiles.find((t) => t.key === focus) ?? null;
  const rest = focused ? tiles.filter((t) => t !== focused) : tiles;
  const grid = (
    <div className={cls('tiles', `n${Math.min(rest.length, 9)}`, compact && 'compact', focused && 'strip')}>
      {rest.map((t) => (
        <TileView key={t.key} t={t} onFocus={() => setFocus(t.key)} />
      ))}
    </div>
  );
  if (!focused) return grid;
  return (
    <div className="stage-focus">
      <div className="stage-main">
        <TileView t={focused} big onFocus={() => setFocus(null)} />
      </div>
      {grid}
    </div>
  );
}

function TileView({ t, big, onFocus }: { t: Tile; big?: boolean; onFocus: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const menu = (e: React.MouseEvent) => {
    if (t.me || !t.addr) return;
    const v = app().voice;
    const p = v.peers.get(t.addr);
    openMenu(e, [
      { label: 'Profile', onClick: () => openModal('profile', { pub: t.pub }) },
      { label: p?.localMute ? 'Unmute for me' : 'Mute for me', onClick: () => v.setLocalMute(t.addr!, !p?.localMute) },
      {
        label: 'Volume',
        sub: [1, 0.75, 0.5, 0.25, 0.1].map((x) => ({ label: `${Math.round(x * 100)}%`, checked: Math.abs((p?.volume ?? 1) - x) < 0.01, onClick: () => v.setPeerVolume(t.pub, x) })),
      },
    ]);
  };
  return (
    <div
      ref={ref}
      className={cls('tile', `tile-${t.kind}`, t.speaking && 'speaking', big && 'big', !t.connected && 'pending')}
      onDoubleClick={() => void ref.current?.requestFullscreen?.().catch(() => undefined)}
      onClick={onFocus}
      onContextMenu={menu}
    >
      {t.stream && t.kind !== 'avatar' ? <VideoEl stream={t.stream} mirror={t.me && t.kind === 'cam'} contain={t.kind === 'screen'} /> : <Avatar pub={t.pub} size={big ? 120 : 72} speaking={t.speaking} />}
      <div className="tile-label">
        {t.kind === 'screen' && <I.screen size={13} />}
        <UserName pub={t.pub} />
        {t.me && <span className="muted"> (you)</span>}
        {t.muted && t.kind !== 'screen' && <I.micOff size={13} className="tile-muted" />}
        {t.deaf && t.kind !== 'screen' && <I.deaf size={13} className="tile-muted" />}
        {!t.connected && <span className="muted small"> connecting</span>}
      </div>
      {t.stream && (
        <button
          type="button"
          className="tile-full"
          title="Fullscreen"
          onClick={(e) => {
            e.stopPropagation();
            void ref.current?.requestFullscreen?.().catch(() => undefined);
          }}
        >
          <I.maximize size={14} />
        </button>
      )}
    </div>
  );
}

export function CallControls() {
  const v = useStore((s) => s.voice);
  const quality = useStore((s) => s.settings.voice.screenQuality);
  const mode = useStore((s) => s.settings.voice.mode);
  const pttKey = useStore((s) => s.settings.voice.pttKey);
  const [board, setBoard] = useState(false);
  const screenMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      ...(Object.keys(SCREEN_QUALITY) as ScreenQuality[]).map((q) => ({
        label: SCREEN_QUALITY[q].label,
        checked: q === quality,
        hint: q === '1080p60' || q === 'source' ? 'free here' : undefined,
        onClick: () => void app().saveSettings({ ...app().settings, voice: { ...app().settings.voice, screenQuality: q } }),
      })),
      { sep: true },
      { label: v.screen ? 'Stop sharing' : 'Share screen', onClick: () => app().toggleScreen() },
    ]);
  return (
    <div className="call-controls">
      <button type="button" className={cls('call-btn small', v.muted && 'on')} onClick={() => app().setMuted(!v.muted)} title={v.muted ? 'Unmute' : 'Mute'}>
        {v.muted ? <I.micOff size={18} /> : <I.mic size={18} />}
      </button>
      <button type="button" className={cls('call-btn small', v.deafened && 'on')} onClick={() => app().setDeafened(!v.deafened)} title={v.deafened ? 'Undeafen' : 'Deafen'}>
        {v.deafened ? <I.deaf size={18} /> : <I.headphones size={18} />}
      </button>
      <button type="button" className={cls('call-btn small', v.cam && 'active')} onClick={() => app().toggleCamera()} title={v.cam ? 'Turn camera off' : 'Turn camera on'}>
        {v.cam ? <I.video size={18} /> : <I.videoOff size={18} />}
      </button>
      <div className="split-btn">
        <button type="button" className={cls('call-btn small', v.screen && 'active')} onClick={() => app().toggleScreen()} title={v.screen ? 'Stop sharing' : `Share screen (${SCREEN_QUALITY[quality].label})`}>
          {v.screen ? <I.screenOff size={18} /> : <I.screen size={18} />}
        </button>
        <button type="button" className="split-more" onClick={screenMenu} title="Stream quality">
          <I.down size={12} />
        </button>
      </div>
      <div className="board-wrap">
        <button type="button" className={cls('call-btn small', board && 'active')} onClick={() => setBoard(!board)} title="Soundboard">
          <I.music size={18} />
        </button>
        {board && <Soundboard onClose={() => setBoard(false)} />}
      </div>
      <button type="button" className="call-btn decline small" onClick={() => app().leaveVoice()} title="Leave">
        <I.phoneOff size={18} />
      </button>
      {mode === 'ptt' && <span className={cls('ptt-pill', v.transmitting && 'live')}>{v.transmitting ? 'Talking' : `Hold ${pttLabel(pttKey)} to talk`}</span>}
    </div>
  );
}

export function pttLabel(code: string) {
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace('Backquote', '`').replace('Right', ' right').replace('Left', ' left');
}

function Soundboard({ onClose }: { onClose: () => void }) {
  const sounds = useStore((s) => s.settings.sounds);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    setTimeout(() => window.addEventListener('mousedown', close), 0);
    return () => window.removeEventListener('mousedown', close);
  }, [onClose]);
  return (
    <div className="soundboard" ref={ref}>
      <div className="gif-head">
        <b>Soundboard</b>
        <button type="button" className="chip" onClick={() => { onClose(); openModal('settings', { tab: 'voice' }); }}>
          <I.plus size={13} /> Add sounds
        </button>
      </div>
      {!sounds.length ? (
        <div className="muted pad small">Upload short clips (up to 8 seconds) in Settings, then Voice. Everyone in the call hears them; no limits, no subscription.</div>
      ) : (
        <div className="sound-grid">
          {sounds.map((s) => (
            <button type="button" key={s.hash} className="sound" onClick={() => void app().playSound(s.hash)} title={s.name}>
              <span className="sound-emoji">{s.emoji}</span>
              <span className="ellipsis">{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Full-size view for a community voice channel. */
export function VoiceStage({ c, ch }: { c: string; ch: string }) {
  const st = useStore((s) => s.states[c]) as CommunityState | null;
  const room = useStore((s) => s.voice.room);
  const inRoom = room?.c === c && room.ch === ch;
  const channel = st?.channels[ch];
  const occupants = useStore((s) => Object.keys(s.voiceRooms[`${c}|${ch}`] ?? {}).length);
  return (
    <div className="chat stage">
      <header className="chat-head">
        <IconButton icon={I.menu} title="Open navigation" className="mobile-only" onClick={() => useStore.setState({ navOpen: true })} />
        <I.voice size={22} className="muted" />
        <span className="chat-title">{channel?.name ?? 'Voice'}</span>
        <span className="chat-topic">{st?.name}</span>
        <span className="grow" />
        <IconButton icon={I.chat} title="Back to text" onClick={() => app().navigate({ kind: 'community', c, ch: null })} />
      </header>
      {inRoom ? (
        <>
          <div className="stage-body">
            <MediaGrid />
          </div>
          <div className="stage-foot">
            <CallControls />
          </div>
        </>
      ) : (
        <div className="stage-body">
          <Empty icon={I.voice} title={channel?.name ?? 'Voice channel'}>
            {occupants ? `${occupants} here now.` : 'Nobody is here yet.'}
            <div className="mt">
              <button type="button" className="btn btn-primary" onClick={() => void app().joinVoice(c, ch).catch((e) => toast(e.message, 'error'))}>
                Join voice
              </button>
            </div>
          </Empty>
        </div>
      )}
    </div>
  );
}

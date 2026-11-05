import { useState } from 'react';
import { useStore, openModal, openMenu } from '../../state/store';
import { app } from '../../core/app';
import { Avatar, I, IconButton, UserName, cls, Modal, Button, Field } from '../common';
import { EmojiPicker } from '../chat/EmojiPicker';
import { groupName } from './HomeSidebar';
import type { Presence } from '@shared/protocol';
import type { GroupState } from '@shared/engine';

export function UserDock() {
  const me = useStore((s) => s.me);
  const card = useStore((s) => s.myCard);
  const status = useStore((s) => s.settings.status);
  const voice = useStore((s) => s.voice);
  const [statusModal, setStatusModal] = useState(false);
  const set = (st: Presence) => app().setStatus(st);
  const statusMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: 'Online', checked: status === 'online', onClick: () => set('online') },
      { label: 'Idle', checked: status === 'idle', onClick: () => set('idle') },
      { label: 'Do not disturb', hint: 'mutes notifications', checked: status === 'dnd', onClick: () => set('dnd') },
      { label: 'Invisible', hint: 'appear offline', checked: status === 'invisible', onClick: () => set('invisible') },
      { sep: true },
      { label: card?.status?.text || card?.status?.emoji ? 'Edit custom status' : 'Set a custom status', onClick: () => setStatusModal(true) },
      ...(card?.status ? [{ label: 'Clear custom status', onClick: () => void app().saveProfile({ ...app().myCard, status: null }) }] : []),
      { sep: true },
      { label: 'Edit profile', onClick: () => openModal('settings', { tab: 'profile' }) },
      { label: 'Switch account / sign out', onClick: () => void app().logout() },
    ]);
  return (
    <div className="dock">
      <button type="button" className="dock-me" onClick={statusMenu} title="Set status">
        <Avatar pub={me} size={34} status speaking={voice.speaking} />
        <span className="dock-names">
          <UserName pub={me} />
          <span className="dock-sub">{card?.status?.text ? `${card.status.emoji ?? ''} ${card.status.text}` : `@${card?.username}`}</span>
        </span>
      </button>
      <div className="dock-btns">
        <IconButton icon={voice.muted ? I.micOff : I.mic} title={voice.muted ? 'Unmute' : 'Mute'} active={voice.muted} danger={voice.muted} onClick={() => app().setMuted(!voice.muted)} size={18} />
        <IconButton icon={voice.deafened ? I.deaf : I.headphones} title={voice.deafened ? 'Undeafen' : 'Deafen'} active={voice.deafened} danger={voice.deafened} onClick={() => app().setDeafened(!voice.deafened)} size={18} />
        <IconButton icon={I.settings} title="Settings (Ctrl+,)" onClick={() => openModal('settings')} size={18} />
      </div>
      {statusModal && <CustomStatusModal onClose={() => setStatusModal(false)} />}
    </div>
  );
}

function CustomStatusModal({ onClose }: { onClose: () => void }) {
  const card = useStore((s) => s.myCard)!;
  const [emoji, setEmoji] = useState(card.status?.emoji ?? '');
  const [text, setText] = useState(card.status?.text ?? '');
  const [dur, setDur] = useState<number>(0);
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Custom status"
      onClose={onClose}
      footer={
        <>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={busy}
            onClick={async () => {
              setBusy(true);
              const status = text.trim() || emoji ? { emoji: emoji || undefined, text: text.trim().slice(0, 128) || undefined, until: dur ? Date.now() + dur * 1000 : null } : null;
              await app().saveProfile({ ...card, status });
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="What's up?">
        <div className="status-input">
          <button type="button" className="emoji-btn" onClick={() => setPick(!pick)}>
            {emoji || <I.smile size={20} />}
          </button>
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={128} placeholder="Building a P2P chat app" autoFocus />
        </div>
      </Field>
      {pick && (
        <EmojiPicker
          inline
          onPick={(e) => {
            setEmoji(e);
            setPick(false);
          }}
          onClose={() => setPick(false)}
        />
      )}
      <Field label="Clear after">
        <select value={dur} onChange={(e) => setDur(Number(e.target.value))}>
          <option value={0}>Don't clear</option>
          <option value={1800}>30 minutes</option>
          <option value={3600}>1 hour</option>
          <option value={14400}>4 hours</option>
          <option value={86400}>Today</option>
          <option value={604800}>This week</option>
        </select>
      </Field>
    </Modal>
  );
}

export function VoicePanel() {
  const voice = useStore((s) => s.voice);
  const st = useStore((s) => (voice.room ? s.states[voice.room.c] : null));
  const links = useStore((s) => s.links);
  if (!voice.room) return null;
  const room = voice.room;
  let where = '';
  if (st?.kind === 'community') where = `${st.channels[room.ch]?.name ?? 'voice'} / ${st.name}`;
  else if (st?.kind === 'group') where = groupName(st as GroupState);
  else if (room.kind === 'call') where = 'Direct call';
  const peers = voice.peers;
  const connected = peers.filter((p) => p.connected).length;
  const rtts = links.filter((l) => peers.some((p) => p.addr === l.addr) && l.rtt !== null).map((l) => l.rtt!);
  const ping = rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null;
  const relayed = links.some((l) => peers.some((p) => p.addr === l.addr) && l.state === 'relay');
  const label = voice.state === 'connecting' ? 'Connecting...' : peers.length === 0 ? (room.kind === 'call' ? 'Calling...' : 'Voice connected') : connected < peers.length ? `Connecting ${connected}/${peers.length}` : 'Voice connected';
  return (
    <div className="voice-panel">
      <div className="voice-panel-top">
        <span className={cls('voice-signal', voice.state === 'connected' && connected === peers.length ? 'good' : 'warn')}>
          <I.signal size={16} />
        </span>
        <span className="voice-panel-text">
          <b>{label}</b>
          <span title={relayed ? 'Some peers need TURN for audio: data is relayed but voice is not' : undefined}>
            {where}
            {ping !== null && ` · ${ping} ms`}
            {relayed && ' · no direct route'}
          </span>
        </span>
        <IconButton icon={I.phoneOff} title="Disconnect" danger onClick={() => app().leaveVoice()} size={18} />
      </div>
      {room.kind === 'channel' && (
        <div className="voice-panel-actions">
          <button type="button" className="chip" onClick={() => app().navigate({ kind: 'community', c: room.c, ch: null })}>
            Go to community
          </button>
        </div>
      )}
    </div>
  );
}

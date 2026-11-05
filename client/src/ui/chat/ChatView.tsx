import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, set, chanKey, openModal, openMenu } from '../../state/store';
import { app } from '../../core/app';
import { I, IconButton, Avatar, UserName, cls, fmtDay, Empty, Spinner, usePresence, statusLabel } from '../common';
import { Markdown } from '../markdown';
import { MessageItem } from './MessageItem';
import { Composer, type PendingFile } from './Composer';
import { MemberList, GroupMembers } from '../members/MemberList';
import { PinsPanel, SearchPanel } from './Panels';
import { ProfileSide } from '../profile/Profile';
import { groupName } from '../side/HomeSidebar';
import { MediaGrid, CallControls } from '../voice/Stage';
import { InboxPanel } from '../extras';
import type { ConvoState, GroupState, Message } from '@shared/engine';

export function ChatView({ c, ch }: { c: string; ch: string }) {
  const key = chanKey(c, ch);
  const st = useStore((s) => s.states[c] ?? null);
  const rec = useStore((s) => s.convos[c]);
  const chan = useStore((s) => s.chans[key]);
  const showMembers = useStore((s) => s.showMembers);
  const panel = useStore((s) => s.panel);
  const me = useStore((s) => s.me);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [drag, setDrag] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    void app().loadChannel(c, ch);
    setFiles([]);
  }, [c, ch]);

  if (!rec) return <Empty icon={I.chat} title="Conversation not found" />;
  const isCommunity = st?.kind === 'community';
  const channel = isCommunity ? st.channels[ch] : null;
  const peer = rec.type === 'dm' ? rec.peer! : null;

  let placeholder = 'Message';
  if (channel) placeholder = `Message #${channel.name}`;
  else if (peer) placeholder = `Message @${app().nameOf(peer)}`;
  else if (st?.kind === 'group') placeholder = `Message ${groupName(st)}`;

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDrag(false);
    const list = [...e.dataTransfer.files];
    if (!list.length) return;
    const ev = new CustomEvent('cel-files', { detail: list });
    window.dispatchEvent(ev);
  };

  return (
    <div
      className="chat"
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        dragDepth.current++;
        setDrag(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDrag(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <ChatHeader c={c} ch={ch} st={st} />
      <CallBar c={c} />
      <div className="chat-split">
        <div className="chat-main">
          <MessageList c={c} ch={ch} st={st} chan={chan} me={me} />
          <FilesBridge files={files} setFiles={setFiles} />
          <Composer c={c} ch={ch} st={st} files={files} setFiles={setFiles} placeholder={placeholder} />
        </div>
        {panel === 'pins' && <PinsPanel c={c} ch={ch} />}
        {panel === 'search' && <SearchPanel c={c} />}
        {panel === 'inbox' && <InboxPanel />}
        {!panel && showMembers && isCommunity && <MemberList c={c} />}
        {!panel && showMembers && st?.kind === 'group' && <GroupMembers c={c} />}
        {!panel && showMembers && peer && <ProfileSide pub={peer} />}
      </div>
      {drag && (
        <div className="drop-overlay">
          <div className="drop-card">
            <I.upload size={36} />
            <b>Drop to share</b>
            <span>Files go straight to the people here, peer to peer. Nothing is uploaded to a server.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Lets the drop overlay hand files to the composer without prop drilling through the list. */
function FilesBridge({ files, setFiles }: { files: PendingFile[]; setFiles: (f: PendingFile[]) => void }) {
  useEffect(() => {
    const on = (e: Event) => {
      const list = (e as CustomEvent<File[]>).detail;
      setFiles([...files, ...list.map((f) => ({ file: f, spoiler: false, url: f.type.startsWith('image/') && f.type !== 'image/svg+xml' ? URL.createObjectURL(f) : null }))].slice(0, 10));
    };
    window.addEventListener('cel-files', on);
    return () => window.removeEventListener('cel-files', on);
  }, [files, setFiles]);
  return null;
}

function ChatHeader({ c, ch, st }: { c: string; ch: string; st: ConvoState | null }) {
  const rec = useStore((s) => s.convos[c])!;
  const panel = useStore((s) => s.panel);
  const showMembers = useStore((s) => s.showMembers);
  const inCall = useStore((s) => s.voice.room?.c === c && s.voice.room.kind === 'call');
  const peer = rec.type === 'dm' ? rec.peer! : null;
  const presence = usePresence(peer ?? '');
  const toggle = (p: 'pins' | 'search') => set({ panel: panel === p ? null : p });
  const level = rec.notify;
  const bellMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      ...(st?.kind === 'community'
        ? [
            { label: 'Use community default', checked: (rec.chans[ch]?.notify ?? 'default') === 'default', onClick: () => void app().setConvoPrefs(c, {}, ch, { notify: 'default' }) },
            { label: 'All messages', checked: rec.chans[ch]?.notify === 'all', onClick: () => void app().setConvoPrefs(c, {}, ch, { notify: 'all' }) },
            { label: 'Only @mentions', checked: rec.chans[ch]?.notify === 'mentions', onClick: () => void app().setConvoPrefs(c, {}, ch, { notify: 'mentions' }) },
            { label: 'Nothing', checked: rec.chans[ch]?.notify === 'none', onClick: () => void app().setConvoPrefs(c, {}, ch, { notify: 'none' }) },
            { sep: true },
            { label: rec.chans[ch]?.muted ? 'Unmute channel' : 'Mute channel', onClick: () => void app().setConvoPrefs(c, {}, ch, { muted: !rec.chans[ch]?.muted }) },
          ]
        : [
            { label: 'All messages', checked: level === 'default' || level === 'all', onClick: () => void app().setConvoPrefs(c, { notify: 'all' }) },
            { label: 'Nothing', checked: level === 'none', onClick: () => void app().setConvoPrefs(c, { notify: 'none' }) },
            { sep: true },
            { label: rec.muted ? 'Unmute' : 'Mute conversation', onClick: () => void app().setConvoPrefs(c, { muted: !rec.muted }) },
          ]),
    ]);
  const muted = st?.kind === 'community' ? rec.chans[ch]?.muted : rec.muted;
  return (
    <header className="chat-head">
      <IconButton icon={I.menu} title="Open navigation" className="mobile-only" onClick={() => set({ navOpen: true })} />
      {st?.kind === 'community' ? (
        <>
          <I.hash size={22} className="muted" />
          <span className="chat-title">{st.channels[ch]?.name ?? 'unknown'}</span>
          {st.channels[ch]?.topic && (
            <span className="chat-topic ellipsis" title={st.channels[ch].topic}>
              <Markdown text={st.channels[ch].topic} c={c} inlineOnly />
            </span>
          )}
        </>
      ) : peer ? (
        <>
          <Avatar pub={peer} size={28} status />
          <span className="chat-title" onClick={() => openModal('profile', { pub: peer })} style={{ cursor: 'pointer' }}>
            <UserName pub={peer} />
          </span>
          <span className="chat-topic">{statusLabel(presence)} · end-to-end encrypted</span>
        </>
      ) : (
        <>
          <span className="group-icon sm">
            <I.users size={16} />
          </span>
          <span className="chat-title">{groupName(st as GroupState | null)}</span>
          <span className="chat-topic">{Object.keys((st as GroupState | null)?.members ?? {}).length} members · end-to-end encrypted</span>
        </>
      )}
      <span className="grow" />
      {st?.kind !== 'community' && (
        <IconButton icon={inCall ? I.phoneOff : I.phone} title={inCall ? 'Leave call' : 'Start voice call'} danger={inCall} onClick={() => (inCall ? app().leaveVoice() : void app().startCall(c))} />
      )}
      {st?.kind === 'group' && <IconButton icon={I.userPlus} title="Add people" onClick={() => openModal('create-group', { addTo: c })} />}
      <IconButton icon={muted ? I.bellOff : I.bell} title="Notification settings" onClick={bellMenu} active={muted} />
      <IconButton icon={I.pin} title="Pinned messages" onClick={() => toggle('pins')} active={panel === 'pins'} />
      <IconButton icon={st?.kind === 'community' ? I.users : I.user} title={st?.kind === 'community' ? 'Member list' : 'Profile'} onClick={() => set({ showMembers: !showMembers, panel: null })} active={showMembers && !panel} />
      <IconButton icon={I.search} title="Search" onClick={() => toggle('search')} active={panel === 'search'} />
      <IconButton icon={I.inbox} title="Inbox (Ctrl+Shift+I)" onClick={() => set({ panel: panel === 'inbox' ? null : 'inbox' })} active={panel === 'inbox'} />
    </header>
  );
}

function CallBar({ c }: { c: string }) {
  const voice = useStore((s) => s.voice);
  const me = useStore((s) => s.me);
  const outgoing = useStore((s) => s.outgoingCall);
  if (voice.room?.c !== c || voice.room.kind !== 'call') return null;
  void me;
  const video = !!(voice.cam || voice.screen || voice.peers.some((p) => p.cam || p.screen));
  return (
    <div className={cls('callbar', video && 'with-video')}>
      <MediaGrid compact={!video} />
      {!voice.peers.length && outgoing && <div className="callbar-wait">Ringing...</div>}
      <CallControls />
    </div>
  );
}

function MessageList({ c, ch, st, chan, me }: { c: string; ch: string; st: ConvoState | null; chan: ReturnType<typeof useStore.getState>['chans'][string] | undefined; me: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  const readMark = useRef<number | null>(null);
  const list = chan?.list ?? [];
  const key = chanKey(c, ch);

  useEffect(() => {
    readMark.current = useStore.getState().convos[c]?.read[ch] ?? 0;
    atBottom.current = true;
  }, [c, ch]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      loadingOlder.current = false;
    } else if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [list.length, list[list.length - 1]?.id]);

  useEffect(() => {
    // keep pinned to bottom while images load
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    for (const child of [...el.children]) ro.observe(child);
    return () => ro.disconnect();
  }, [list.length]);

  const onScroll = () => {
    const el = ref.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current && document.hasFocus()) {
      const last = list[list.length - 1];
      if (last && useStore.getState().unread[key]) void app().markRead(c, ch, last.l);
    }
    if (el.scrollTop < 200 && chan?.hasMore && !chan.loading) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      void app().loadChannel(c, ch, true);
    }
  };

  const [pingIds, setPingIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const rec = useStore.getState().convos[c];
    if (!rec || rec.type !== 'community') return;
    let alive = true;
    void (async () => {
      const ids = new Set<string>();
      for (const m of list) if (m.a !== me && (await app().pingsMe(rec, m))) ids.add(m.id);
      if (alive) setPingIds(ids);
    })();
    return () => {
      alive = false;
    };
  }, [list, c, me]);

  const items: React.ReactNode[] = [];
  let prev: Message | null = null;
  let newShown = false;
  for (const m of list) {
    const day = new Date(m.t).toDateString();
    if (!prev || new Date(prev.t).toDateString() !== day) {
      items.push(
        <div key={'d' + m.id} className="day-sep">
          <span>{fmtDay(m.t)}</span>
        </div>,
      );
    }
    if (!newShown && readMark.current !== null && m.l > readMark.current && m.a !== me && readMark.current > 0) {
      newShown = true;
      items.push(
        <div key={'n' + m.id} className="new-sep">
          <span>New</span>
        </div>,
      );
    }
    const grouped = !!prev && prev.a === m.a && m.t - prev.t < 7 * 60_000 && !m.reply && new Date(prev.t).toDateString() === day;
    items.push(<MessageItem key={m.id} m={m} grouped={grouped} st={st} pings={pingIds.has(m.id)} />);
    prev = m;
  }

  return (
    <div className="msgs" ref={ref} onScroll={onScroll}>
      <div className="msgs-inner">
        {chan && !chan.hasMore && <Welcome c={c} ch={ch} st={st} />}
        {chan?.loading && chan.hasMore && (
          <div className="msgs-loading">
            <Spinner />
          </div>
        )}
        {items}
        <div className="msgs-end" />
      </div>
    </div>
  );
}

function Welcome({ c, ch, st }: { c: string; ch: string; st: ConvoState | null }) {
  const rec = useStore((s) => s.convos[c]);
  if (st?.kind === 'community') {
    const channel = st.channels[ch];
    return (
      <div className="welcome">
        <div className="welcome-icon">
          <I.hash size={34} />
        </div>
        <h1>Welcome to #{channel?.name}</h1>
        <p>This is the start of the #{channel?.name} channel. Messages live on members' devices and sync peer to peer.</p>
      </div>
    );
  }
  if (rec?.type === 'dm' && rec.peer)
    return (
      <div className="welcome">
        <Avatar pub={rec.peer} size={80} />
        <h1>
          <UserName pub={rec.peer} />
        </h1>
        <p>
          This is the beginning of your direct messages with <b>{app().nameOf(rec.peer)}</b>. Messages are end-to-end encrypted: they travel directly between your devices, or sealed through the hub
          mailbox when one of you is offline.
        </p>
      </div>
    );
  return (
    <div className="welcome">
      <div className="welcome-icon">
        <I.users size={34} />
      </div>
      <h1>{groupName(st as GroupState | null)}</h1>
      <p>Welcome to the beginning of this group. Up to 10 people, end-to-end encrypted.</p>
    </div>
  );
}

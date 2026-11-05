import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore, set, closeModal, type MenuItem } from '../state/store';
import { app } from '../core/app';
import { ServerRail, FolderModal } from './rail/ServerRail';
import { ChannelSidebar } from './side/ChannelSidebar';
import { HomeSidebar } from './side/HomeSidebar';
import { UserDock, VoicePanel } from './side/UserDock';
import { ChatView } from './chat/ChatView';
import { FriendsView } from './friends/FriendsView';
import { ProfilePopout, ProfileModal } from './profile/Profile';
import { UserSettings } from './settings/UserSettings';
import { CommunitySettings } from './community/CommunitySettings';
import { CreateCommunityModal, JoinModal, InviteModal, ChannelModal, CreateGroupModal, MemberModerationModal, NickModal } from './community/Modals';
import { Modal, Button, Avatar, UserName, I, cls } from './common';
import { stopRinging } from '../core/notify';
import { Lightbox } from './chat/Attachments';
import { VoiceStage } from './voice/Stage';
import { HistoryModal, PollModal, ScheduleModal, ShortcutsModal, WelcomeModal } from './extras';
import { sortedChannels, type Message } from '@shared/engine';

export function Shell() {
  const view = useStore((s) => s.view);
  const navOpen = useStore((s) => s.navOpen);
  const bg = useStore((s) => (s.previewTheme ?? s.theme).chatBg);
  const bgUrl = useStore((s) => (bg.image ? s.blobUrls[bg.image] : undefined));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        set({ modal: { kind: 'switcher' } });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        set({ modal: { kind: 'settings' } });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        set({ modal: { kind: 'shortcuts' } });
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === 'm') {
          e.preventDefault();
          app().setMuted(!app().voice.muted);
        } else if (k === 'd') {
          e.preventDefault();
          app().setDeafened(!app().voice.deafened);
        } else if (k === 'i') {
          e.preventDefault();
          set((s) => ({ panel: s.panel === 'inbox' ? null : 'inbox' }));
        }
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const v = useStore.getState().view;
        if (v.kind !== 'community' || !v.ch) return;
        const st = app().convos.community(v.c);
        if (!st) return;
        const { loose, groups } = sortedChannels(st);
        const order = [...loose, ...groups.flatMap((g) => g.items)].filter((x) => x.type === 'text');
        const i = order.findIndex((x) => x.id === v.ch);
        const next = order[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          e.preventDefault();
          app().navigate({ kind: 'community', c: v.c, ch: next.id });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    // first run: a short welcome with the three things worth doing first
    if (!localStorage.getItem('cel-welcomed') && !Object.keys(useStore.getState().convos).length && !useStore.getState().modal) set({ modal: { kind: 'welcome' } });
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const chatBgStyle: React.CSSProperties = {};
  if (bg.kind === 'color') chatBgStyle.background = bg.color;
  if (bg.kind === 'gradient') chatBgStyle.background = `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})`;
  if (bg.kind === 'image' && bgUrl) {
    chatBgStyle.backgroundImage = `url(${bgUrl})`;
    chatBgStyle.backgroundSize = bg.fit === 'tile' ? 'auto' : 'cover';
    chatBgStyle.backgroundRepeat = bg.fit === 'tile' ? 'repeat' : 'no-repeat';
    chatBgStyle.backgroundPosition = 'center';
    chatBgStyle.filter = bg.blur ? `blur(${bg.blur}px)` : undefined;
  }

  return (
    <div className={cls('shell', navOpen && 'nav-open')} onClick={() => useStore.getState().popout && set({ popout: null })}>
      {navOpen && <div className="nav-backdrop" onClick={() => set({ navOpen: false })} />}
      <ServerRail />
      <aside className="side-col">
        {view.kind === 'community' || view.kind === 'voice' ? <ChannelSidebar c={view.c} /> : <HomeSidebar />}
        <VoicePanel />
        <UserDock />
      </aside>
      <main className="main-col">
        {bg.kind !== 'none' && (
          <div className="chat-bg" aria-hidden>
            <div className="chat-bg-img" style={chatBgStyle} />
            {bg.kind === 'image' && <div className="chat-bg-dim" style={{ background: `rgba(0,0,0,${bg.dim})` }} />}
          </div>
        )}
        {view.kind === 'home' ? (
          <FriendsView />
        ) : view.kind === 'dm' ? (
          <ChatView c={view.c} ch="main" />
        ) : view.kind === 'voice' ? (
          <VoiceStage c={view.c} ch={view.ch} />
        ) : view.ch ? (
          <ChatView c={view.c} ch={view.ch} />
        ) : (
          <NoChannel c={view.c} />
        )}
      </main>
      <Overlays />
    </div>
  );
}

function NoChannel({ c }: { c: string }) {
  const st = useStore((s) => s.states[c]);
  const rec = useStore((s) => s.convos[c]);
  const peers = useStore((s) => s.links.filter((l) => l.purposes.includes('c:' + c)).length);
  const hub = useStore((s) => s.hub.state);
  if (!st && rec?.joinCode)
    return (
      <div className="center-note">
        <div className="spinner big" />
        <h2>Joining community</h2>
        <p>
          {hub !== 'online'
            ? 'Waiting for the hub connection...'
            : peers
              ? 'Connected to a member, syncing the community...'
              : 'Waiting for a member of this community (or its archive peer, if it has one) to come online. Communities live on their members’ devices, so somebody has to be online to let you in.'}
        </p>
        <Button kind="ghost" onClick={() => void app().leaveCommunity(c).catch(() => app().convos.remove(c))}>
          Cancel
        </Button>
      </div>
    );
  return (
    <div className="center-note">
      <I.hash size={40} />
      <h2>No text channels</h2>
      <p>{st ? 'There are no channels you can see here yet.' : 'This community has not synced yet.'}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Overlays() {
  const modal = useStore((s) => s.modal);
  const toasts = useStore((s) => s.toasts);
  const menu = useStore((s) => s.menu);
  const popout = useStore((s) => s.popout);
  const lightbox = useStore((s) => s.lightbox);
  const incoming = useStore((s) => s.incomingCall);
  return (
    <>
      {modal && <ModalSwitch kind={modal.kind} props={modal.props ?? {}} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} />}
      {popout && <ProfilePopout {...popout} />}
      {lightbox && <Lightbox {...lightbox} />}
      {incoming && <IncomingCall />}
      {createPortal(
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <span>{t.text}</span>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action!.fn();
                    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }));
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function ModalSwitch({ kind, props }: { kind: string; props: Record<string, unknown> }) {
  switch (kind) {
    case 'settings':
      return <UserSettings initial={props.tab as string | undefined} />;
    case 'community-settings':
      return <CommunitySettings c={props.c as string} initial={props.tab as string | undefined} />;
    case 'create-community':
      return <CreateCommunityModal />;
    case 'join':
      return <JoinModal initial={props.initial as string | undefined} />;
    case 'invite':
      return <InviteModal c={props.c as string} />;
    case 'channel':
      return <ChannelModal c={props.c as string} id={props.id as string | undefined} type={props.type as 'text' | 'voice' | 'category' | undefined} parent={props.parent as string | null | undefined} />;
    case 'create-group':
      return <CreateGroupModal addTo={props.addTo as string | undefined} />;
    case 'profile':
      return <ProfileModal pub={props.pub as string} c={props.c as string | undefined} />;
    case 'moderate':
      return <MemberModerationModal c={props.c as string} pub={props.pub as string} action={props.action as 'kick' | 'ban' | 'timeout'} />;
    case 'nick':
      return <NickModal c={props.c as string} pub={props.pub as string} />;
    case 'switcher':
      return <QuickSwitcher />;
    case 'history':
      return <HistoryModal m={props.m as Message} />;
    case 'poll':
      return <PollModal c={props.c as string} ch={props.ch as string} />;
    case 'schedule':
      return <ScheduleModal c={props.c as string} ch={props.ch as string} text={props.text as string} reply={(props.reply as string | null) ?? null} />;
    case 'shortcuts':
      return <ShortcutsModal />;
    case 'welcome':
      return <WelcomeModal />;
    case 'folder':
      return <FolderModal id={props.id as string} />;
    case 'confirm':
      return <Confirm {...(props as unknown as ConfirmProps)} />;
  }
  return null;
}

interface ConfirmProps {
  title: string;
  body: ReactNode;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

function Confirm({ title, body, confirm, danger, onConfirm }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      footer={
        <>
          <Button kind="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            kind={danger ? 'danger' : 'primary'}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                closeModal();
              }
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      <div className="confirm-body">{body}</div>
    </Modal>
  );
}

function ContextMenu({ x, y, items }: { x: number; y: number; items: MenuItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ i: number; items: MenuItem[]; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
  }, [x, y]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      set({ menu: null });
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && set({ menu: null });
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', () => set({ menu: null }));
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', key);
    };
  }, []);
  return createPortal(
    <div ref={ref} className="ctx" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            type="button"
            key={i}
            className={cls('ctx-item', it.danger && 'danger', it.disabled && 'disabled')}
            disabled={it.disabled}
            onMouseEnter={(e) => setSub(it.sub ? { i, items: it.sub, y: (e.currentTarget as HTMLElement).getBoundingClientRect().top } : null)}
            onClick={() => {
              if (it.sub) return;
              set({ menu: null });
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.checked !== undefined && <span className={cls('ctx-check', it.checked && 'on')}>{it.checked && <I.check size={14} />}</span>}
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
            {it.sub && <I.right size={14} />}
          </button>
        ),
      )}
      {sub && (
        <div className="ctx ctx-sub" style={{ left: '100%', top: sub.y - pos.y - 4 }}>
          {sub.items.map((it, i) =>
            it.sep ? (
              <div key={i} className="ctx-sep" />
            ) : (
              <button
                type="button"
                key={i}
                className={cls('ctx-item', it.danger && 'danger')}
                onClick={() => {
                  set({ menu: null });
                  it.onClick?.();
                }}
              >
                <span>{it.label}</span>
                {it.checked !== undefined && <span className={cls('ctx-check', it.checked && 'on')}>{it.checked && <I.check size={14} />}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

function IncomingCall() {
  const call = useStore((s) => s.incomingCall)!;
  const name = useStore(() => app().nameOf(call.from));
  return createPortal(
    <div className="incoming">
      <Avatar pub={call.from} size={72} className="ring-anim" />
      <div className="incoming-name">
        <UserName pub={call.from} />
      </div>
      <div className="incoming-sub">{call.ctype === 'group' ? `${name} is calling the group` : 'Incoming voice call'}</div>
      <div className="incoming-actions">
        <button type="button" className="call-btn decline" onClick={() => app().declineCall()} title="Decline">
          <I.phoneOff size={22} />
        </button>
        <button type="button" className="call-btn accept" onClick={() => void app().acceptCall()} title="Accept">
          <I.phone size={22} />
        </button>
      </div>
      <button type="button" className="link" onClick={() => { stopRinging(); set({ incomingCall: null }); }}>
        Ignore
      </button>
    </div>,
    document.body,
  );
}

function QuickSwitcher() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const convos = useStore((s) => s.convos);
  const states = useStore((s) => s.states);
  const friends = useStore((s) => s.friends);
  const items: { label: string; sub: string; go: () => void; icon: ReactNode }[] = [];
  const needle = q.toLowerCase().replace(/^[#@]/, '');
  for (const rec of Object.values(convos)) {
    const st = states[rec.c];
    if (rec.type === 'community' && st?.kind === 'community') {
      if (!needle || st.name.toLowerCase().includes(needle)) items.push({ label: st.name, sub: 'Community', go: () => app().navigate({ kind: 'community', c: rec.c, ch: null }), icon: <I.server size={16} /> });
      for (const ch of Object.values(st.channels)) {
        if (ch.type !== 'text') continue;
        if (needle && ch.name.includes(needle)) items.push({ label: '#' + ch.name, sub: st.name, go: () => app().navigate({ kind: 'community', c: rec.c, ch: ch.id }), icon: <I.hash size={16} /> });
      }
    } else if (rec.type === 'dm' && rec.peer) {
      const name = app().nameOf(rec.peer);
      if (!needle || name.toLowerCase().includes(needle)) items.push({ label: name, sub: 'Direct message', go: () => app().navigate({ kind: 'dm', c: rec.c }), icon: <I.dm size={16} /> });
    } else if (rec.type === 'group' && st?.kind === 'group') {
      const name = st.name || 'Group';
      if (!needle || name.toLowerCase().includes(needle)) items.push({ label: name, sub: 'Group', go: () => app().navigate({ kind: 'dm', c: rec.c }), icon: <I.users size={16} /> });
    }
  }
  for (const f of Object.values(friends)) {
    if (f.state !== 'friend') continue;
    const name = app().nameOf(f.pub);
    if (needle && name.toLowerCase().includes(needle) && !items.some((i) => i.label === name)) items.push({ label: name, sub: 'Friend', go: () => void app().openDm(f.pub), icon: <I.user size={16} /> });
  }
  const shown = items.slice(0, 12);
  return (
    <Modal className="switcher">
      <input
        autoFocus
        className="switcher-input"
        placeholder="Jump to a community, channel or person"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setSel((v) => Math.min(shown.length - 1, v + 1));
          if (e.key === 'ArrowUp') setSel((v) => Math.max(0, v - 1));
          if (e.key === 'Enter' && shown[sel]) {
            closeModal();
            shown[sel].go();
          }
        }}
      />
      <div className="switcher-list">
        {shown.map((it, i) => (
          <button
            type="button"
            key={i}
            className={cls('switcher-item', i === sel && 'on')}
            onMouseEnter={() => setSel(i)}
            onClick={() => {
              closeModal();
              it.go();
            }}
          >
            {it.icon}
            <span>{it.label}</span>
            <span className="muted">{it.sub}</span>
          </button>
        ))}
        {!shown.length && <div className="muted pad">Nothing matches.</div>}
      </div>
      <div className="switcher-hint">Ctrl+K to open, arrows to move, Enter to go</div>
    </Modal>
  );
}

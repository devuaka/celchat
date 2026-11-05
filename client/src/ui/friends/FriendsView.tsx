import { useState } from 'react';
import { useStore, set, toast, openMenu, openProfile } from '../../state/store';
import { app } from '../../core/app';
import { Avatar, I, UserName, Button, Empty, IconButton, cls, copy, usePresence, statusLabel } from '../common';
import type { FriendRecord } from '../../core/db';
import { InboxPanel } from '../extras';

type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

export function FriendsView() {
  const view = useStore((s) => s.view);
  const tab: Tab = view.kind === 'home' ? view.tab : 'online';
  const friends = useStore((s) => s.friends);
  const presence = useStore((s) => s.presence);
  const panel = useStore((s) => s.panel);
  const install = useStore((s) => s.installPrompt);
  const list = Object.values(friends);
  const online = list.filter((f) => f.state === 'friend' && presence[f.pub] && presence[f.pub] !== 'invisible');
  const all = list.filter((f) => f.state === 'friend');
  const pending = list.filter((f) => f.state === 'incoming' || f.state === 'outgoing');
  const blocked = list.filter((f) => f.state === 'blocked');
  const setTab = (t: Tab) => set({ view: { kind: 'home', tab: t } });
  const shown = tab === 'online' ? online : tab === 'all' ? all : tab === 'pending' ? pending : blocked;
  const byName = (a: FriendRecord, b: FriendRecord) => app().nameOf(a.pub).localeCompare(app().nameOf(b.pub));
  return (
    <div className="chat friends">
      <header className="chat-head">
        <IconButton icon={I.menu} title="Open navigation" className="mobile-only" onClick={() => set({ navOpen: true })} />
        <I.users size={22} className="muted" />
        <span className="chat-title">Friends</span>
        <div className="tabs inline">
          {(['online', 'all', 'pending', 'blocked'] as Tab[]).map((t) => (
            <button type="button" key={t} className={cls(tab === t && 'on')} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
              {t === 'pending' && list.some((f) => f.state === 'incoming') && <span className="badge">{list.filter((f) => f.state === 'incoming').length}</span>}
            </button>
          ))}
          <button type="button" className={cls('add-friend-tab', tab === 'add' && 'on')} onClick={() => setTab('add')}>
            Add friend
          </button>
        </div>
        <span className="grow" />
        {install && (
          <Button small kind="subtle" onClick={() => void install.prompt().then(() => set({ installPrompt: null }))}>
            <I.installApp size={15} /> Install app
          </Button>
        )}
        <IconButton icon={I.inbox} title="Inbox (Ctrl+Shift+I)" onClick={() => set({ panel: panel === 'inbox' ? null : 'inbox' })} active={panel === 'inbox'} />
      </header>
      <div className="friends-body">
        {tab === 'add' ? (
          <AddFriend />
        ) : (
          <div className="friends-list">
            <div className="friends-count">
              {tab === 'online' ? 'Online' : tab === 'all' ? 'All friends' : tab === 'pending' ? 'Pending' : 'Blocked'} · {shown.length}
            </div>
            {!shown.length && (
              <Empty icon={tab === 'blocked' ? I.ban : I.users} title={tab === 'online' ? 'Nobody is around right now' : tab === 'pending' ? 'No pending requests' : tab === 'blocked' ? 'You have not blocked anyone' : 'No friends yet'}>
                {tab !== 'blocked' && (
                  <Button kind="ghost" onClick={() => setTab('add')}>
                    <I.userPlus size={16} /> Add a friend
                  </Button>
                )}
              </Empty>
            )}
            {shown.sort(byName).map((f) => (
              <FriendRow key={f.pub} f={f} />
            ))}
          </div>
        )}
        {panel === 'inbox' ? <InboxPanel /> : <ActiveNow />}
      </div>
    </div>
  );
}

function FriendRow({ f }: { f: FriendRecord }) {
  const a = app();
  const presence = usePresence(f.pub);
  const card = useStore((s) => s.profiles[f.pub]);
  const sub =
    f.state === 'incoming' ? 'Incoming friend request' : f.state === 'outgoing' ? 'Outgoing friend request' : f.state === 'blocked' ? 'Blocked' : card?.status?.text ? `${card.status.emoji ?? ''} ${card.status.text}` : statusLabel(presence);
  return (
    <div
      className="friend-row"
      onClick={(e) => f.state === 'friend' && openProfile(e, f.pub)}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Profile', onClick: () => useStore.setState({ modal: { kind: 'profile', props: { pub: f.pub } } }) },
          ...(f.state === 'friend'
            ? [
                { label: 'Message', onClick: () => void a.openDm(f.pub) },
                { label: 'Call', onClick: () => void a.openDm(f.pub).then((c) => a.startCall(c)) },
                { sep: true },
                { label: 'Remove friend', danger: true, onClick: () => void a.removeFriend(f.pub) },
              ]
            : []),
          f.state === 'blocked' ? { label: 'Unblock', onClick: () => void a.unblock(f.pub) } : { label: 'Block', danger: true, onClick: () => void a.block(f.pub) },
          { label: 'Copy user ID', onClick: () => void copy(f.pub, 'User ID copied') },
        ])
      }
    >
      <Avatar pub={f.pub} size={38} status={f.state === 'friend'} />
      <span className="friend-names">
        <span>
          <UserName pub={f.pub} /> <span className="muted small">@{card?.username ?? f.pub.slice(0, 8)}</span>
        </span>
        <span className="muted small">{sub}</span>
      </span>
      <span className="friend-actions" onClick={(e) => e.stopPropagation()}>
        {f.state === 'friend' && (
          <>
            <IconButton icon={I.dm} title="Message" onClick={() => void a.openDm(f.pub)} />
            <IconButton icon={I.phone} title="Call" onClick={() => void a.openDm(f.pub).then((c) => a.startCall(c))} />
          </>
        )}
        {f.state === 'incoming' && (
          <>
            <IconButton icon={I.check} title="Accept" onClick={() => void a.acceptFriend(f.pub).then(() => toast('You are now friends', 'success'))} />
            <IconButton icon={I.x} title="Ignore" danger onClick={() => void a.declineFriend(f.pub)} />
          </>
        )}
        {f.state === 'outgoing' && <IconButton icon={I.x} title="Cancel request" danger onClick={() => void a.cancelFriend(f.pub)} />}
        {f.state === 'blocked' && <IconButton icon={I.userX} title="Unblock" onClick={() => void a.unblock(f.pub)} />}
      </span>
    </div>
  );
}

function AddFriend() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const me = useStore((s) => s.me);
  const card = useStore((s) => s.myCard);
  const hub = useStore((s) => s.hub);
  return (
    <div className="add-friend">
      <h2>Add a friend</h2>
      <p className="muted">Enter their @username (looked up on your hub) or paste their full CelChat ID. Requests travel sealed: the hub cannot read them.</p>
      <form
        className={cls('add-friend-form', msg && (msg.ok ? 'ok' : 'bad'))}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return;
          setBusy(true);
          setMsg(null);
          try {
            const pub = await app().addFriend(q);
            setMsg({ ok: true, text: `Friend request sent to ${app().nameOf(pub)}.` });
            setQ('');
          } catch (err) {
            setMsg({ ok: false, text: (err as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="@username or CelChat ID" autoFocus spellCheck={false} />
        <Button type="submit" busy={busy} disabled={!q.trim()}>
          Send request
        </Button>
      </form>
      {msg && <div className={msg.ok ? 'ok-text' : 'field-error'}>{msg.text}</div>}
      <div className="share-me">
        <div>
          <div className="field-label">Your username</div>
          <button type="button" className="copy-box" onClick={() => void copy('@' + (card?.username ?? ''), 'Username copied')}>
            @{card?.username} <I.copy size={14} />
          </button>
          {!hub.info?.features.directory && <div className="field-hint">This hub has no username directory. Share your ID instead.</div>}
        </div>
        <div>
          <div className="field-label">Your CelChat ID (works on any hub)</div>
          <button type="button" className="copy-box mono" onClick={() => void copy(me, 'ID copied')}>
            {me.slice(0, 20)}... <I.copy size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ActiveNow() {
  const voiceRooms = useStore((s) => s.voiceRooms);
  const friends = useStore((s) => s.friends);
  const states = useStore((s) => s.states);
  const active: { pub: string; where: string; c: string }[] = [];
  for (const [k, room] of Object.entries(voiceRooms)) {
    const [c, ch] = k.split('|');
    const st = states[c];
    for (const pub of Object.keys(room)) if (friends[pub]?.state === 'friend') active.push({ pub, c, where: st?.kind === 'community' ? `${st.channels[ch]?.name ?? 'voice'} in ${st.name}` : 'voice' });
  }
  return (
    <aside className="active-now">
      <h3>Active now</h3>
      {!active.length ? (
        <div className="muted small">When friends hang out in a voice channel you share, they show up here.</div>
      ) : (
        active.map((x) => (
          <div key={x.pub + x.c} className="active-card" onClick={() => app().navigate({ kind: 'community', c: x.c, ch: null })}>
            <Avatar pub={x.pub} size={32} status />
            <span>
              <UserName pub={x.pub} />
              <span className="muted small">
                <I.voice size={12} /> {x.where}
              </span>
            </span>
          </div>
        ))
      )}
    </aside>
  );
}

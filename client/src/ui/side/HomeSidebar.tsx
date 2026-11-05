import { useStore, openModal, openMenu, chanKey } from '../../state/store';
import { app } from '../../core/app';
import { Avatar, I, UserName, cls, copy } from '../common';
import type { GroupState } from '@shared/engine';

export function HomeSidebar() {
  const view = useStore((s) => s.view);
  const convos = useStore((s) => s.convos);
  const states = useStore((s) => s.states);
  const unread = useStore((s) => s.unread);
  const pending = useStore((s) => Object.values(s.friends).filter((f) => f.state === 'incoming').length);
  const dms = Object.values(convos)
    .filter((r) => (r.type === 'dm' || r.type === 'group') && !r.hidden)
    .sort((a, b) => b.lastActivity - a.lastActivity);

  return (
    <div className="side">
      <div className="side-head">
        <button type="button" className="search-fake" onClick={() => openModal('switcher')}>
          Find or start a conversation <kbd>Ctrl K</kbd>
        </button>
      </div>
      <div className="side-body">
        <div className={cls('chan big', view.kind === 'home' && 'active')} onClick={() => app().navigate({ kind: 'home', tab: 'online' })} role="button" tabIndex={0}>
          <I.users size={20} className="chan-icon" />
          <span className="chan-name">Friends</span>
          {!!pending && <span className="badge">{pending}</span>}
        </div>
        <div className="cat-head static">
          <span>Direct messages</span>
          <button type="button" className="cat-add" title="New group DM" onClick={() => openModal('create-group')}>
            <I.plus size={14} />
          </button>
        </div>
        {!dms.length && <div className="muted pad small">Message a friend and it shows up here. DMs are end-to-end encrypted.</div>}
        {dms.map((rec) => {
          const u = unread[chanKey(rec.c, 'main')];
          const active = view.kind === 'dm' && view.c === rec.c;
          const st = states[rec.c];
          const menu = (e: React.MouseEvent) =>
            openMenu(e, [
              { label: 'Mark as read', onClick: () => void app().markRead(rec.c, 'main') },
              { label: rec.muted ? 'Unmute' : 'Mute conversation', onClick: () => void app().setConvoPrefs(rec.c, { muted: !rec.muted }) },
              ...(rec.type === 'dm' && rec.peer
                ? [
                    { label: 'Profile', onClick: () => openModal('profile', { pub: rec.peer }) },
                    { label: 'Call', onClick: () => void app().startCall(rec.c) },
                    { label: 'Copy user ID', onClick: () => void copy(rec.peer!, 'User ID copied') },
                  ]
                : [{ label: 'Add people', onClick: () => openModal('create-group', { addTo: rec.c }) }]),
              { sep: true },
              rec.type === 'group'
                ? { label: 'Leave group', danger: true, onClick: () => void app().leaveGroup(rec.c) }
                : { label: 'Close DM', onClick: () => void app().hideDm(rec.c) },
            ]);
          return (
            <div key={rec.c} className={cls('dm-row', active && 'active', u?.u && 'unread')} onClick={() => app().navigate({ kind: 'dm', c: rec.c })} onContextMenu={menu} role="button" tabIndex={0}>
              {rec.type === 'dm' && rec.peer ? (
                <>
                  <Avatar pub={rec.peer} size={34} status />
                  <span className="dm-name">
                    <UserName pub={rec.peer} />
                    <CustomStatus pub={rec.peer} />
                  </span>
                </>
              ) : (
                <>
                  <span className="group-icon">
                    <I.users size={18} />
                  </span>
                  <span className="dm-name">
                    <span className="uname">{groupName(st as GroupState | null)}</span>
                    <span className="dm-sub">{Object.keys((st as GroupState | null)?.members ?? {}).length} members</span>
                  </span>
                </>
              )}
              {!!u?.m && <span className="badge">{u.m}</span>}
              <button
                type="button"
                className="dm-close"
                title={rec.type === 'group' ? 'Leave group' : 'Close'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (rec.type === 'group') menu(e);
                  else void app().hideDm(rec.c);
                }}
              >
                <I.x size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function groupName(st: GroupState | null) {
  if (!st) return 'Group';
  if (st.name) return st.name;
  const a = app();
  return (
    Object.keys(st.members)
      .filter((p) => p !== a.me)
      .slice(0, 3)
      .map((p) => a.nameOf(p))
      .join(', ') || 'Just you'
  );
}

export function CustomStatus({ pub }: { pub: string }) {
  const st = useStore((s) => s.profiles[pub]?.status);
  if (!st || (!st.text && !st.emoji) || (st.until && st.until < Date.now())) return null;
  return (
    <span className="dm-sub">
      {st.emoji} {st.text}
    </span>
  );
}

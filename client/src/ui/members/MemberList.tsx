import { useStore, openMenu, openModal, openProfile } from '../../state/store';
import { app } from '../../core/app';
import { Avatar, I, UserName, copy, cls, confirmDialog } from '../common';
import { CustomStatus } from '../side/HomeSidebar';
import { memberColor, highestPos, basePerms, type CommunityState, type GroupState } from '@shared/engine';
import { P, has } from '@shared/perms';
import type { Presence } from '@shared/protocol';

export function MemberList({ c }: { c: string }) {
  const st = useStore((s) => s.states[c]) as CommunityState | null;
  const presence = useStore((s) => s.presence);
  const me = useStore((s) => s.me);
  const profiles = useStore((s) => s.profiles);
  if (!st) return null;
  const online = (p: string) => {
    const x: Presence | undefined = presence[p];
    return !!x && x !== 'invisible';
  };
  const bots = Object.keys(st.members).filter((p) => profiles[p]?.bot);
  const members = Object.values(st.members).filter((m) => !profiles[m.pub]?.bot);
  const hoisted = Object.values(st.roles)
    .filter((r) => r.hoist && r.id !== st.id)
    .sort((a, b) => b.pos - a.pos);
  const groups: { title: string; color?: string | null; pubs: string[] }[] = [];
  const placed = new Set<string>();
  for (const r of hoisted) {
    const pubs = members.filter((m) => !placed.has(m.pub) && online(m.pub) && m.roles.includes(r.id)).map((m) => m.pub);
    pubs.forEach((p) => placed.add(p));
    if (pubs.length) groups.push({ title: r.name, color: r.color, pubs });
  }
  const on = members.filter((m) => !placed.has(m.pub) && online(m.pub)).map((m) => m.pub);
  if (on.length) groups.push({ title: 'Online', pubs: on });
  const off = members.filter((m) => !online(m.pub)).map((m) => m.pub);
  if (off.length) groups.push({ title: 'Offline', pubs: off });
  if (bots.length) groups.push({ title: 'Archive peers', pubs: bots });
  const sortName = (a: string, b: string) => app().nameOf(a, c).localeCompare(app().nameOf(b, c));
  return (
    <aside className="members">
      {groups.map((g) => (
        <div key={g.title} className="mem-group">
          <div className="mem-title">
            {g.title} <span>{g.pubs.length}</span>
          </div>
          {g.pubs
            .sort(sortName)
            .slice(0, g.title === 'Offline' ? 300 : 1000)
            .map((pub) => (
              <MemberRow key={pub} c={c} st={st} pub={pub} offline={g.title === 'Offline'} me={me} />
            ))}
        </div>
      ))}
    </aside>
  );
}

function MemberRow({ c, st, pub, offline, me }: { c: string; st: CommunityState; pub: string; offline: boolean; me: string }) {
  const speaking = useStore((s) => s.voice.room?.c === c && s.voice.peers.some((p) => p.pub === pub && p.speaking));
  return (
    <div className={cls('mem', offline && 'offline')} onClick={(e) => openProfile(e, pub, c)} onContextMenu={(e) => memberMenu(e, c, st, pub, me)}>
      <Avatar pub={pub} size={32} status speaking={speaking} />
      <span className="mem-names">
        <span className="mem-name">
          <UserName pub={pub} c={c} color={memberColor(st, pub)} />
          {st.owner === pub && <I.crown size={13} className="owner-crown" />}
        </span>
        <CustomStatus pub={pub} />
      </span>
    </div>
  );
}

export function memberMenu(e: React.MouseEvent, c: string, st: CommunityState, pub: string, me: string) {
  const a = app();
  const my = basePerms(st, me);
  const above = st.owner === me || (pub !== st.owner && highestPos(st, me) > highestPos(st, pub));
  const self = pub === me;
  const friend = useStore.getState().friends[pub]?.state;
  const m = st.members[pub];
  const assignable = Object.values(st.roles)
    .filter((r) => r.id !== st.id && (st.owner === me || r.pos < highestPos(st, me)))
    .sort((x, y) => y.pos - x.pos);
  openMenu(e, [
    { label: 'Profile', onClick: () => openModal('profile', { pub, c }) },
    ...(!self ? [{ label: 'Message', onClick: () => void a.openDm(pub) }] : []),
    ...(!self && friend !== 'friend' && friend !== 'outgoing' && friend !== 'blocked' ? [{ label: 'Add friend', onClick: () => void a.addFriend(pub).catch(() => undefined) }] : []),
    { sep: true },
    ...((self && has(my, P.CHANGE_NICK)) || (!self && has(my, P.MANAGE_NICKS) && above) ? [{ label: self ? 'Change nickname' : 'Change nickname', onClick: () => openModal('nick', { c, pub }) }] : []),
    ...(has(my, P.MANAGE_ROLES) && (above || self) && assignable.length && m
      ? [
          {
            label: 'Roles',
            sub: assignable.map((r) => ({
              label: r.name,
              checked: m.roles.includes(r.id),
              onClick: () => void a.setMemberRoles(c, pub, m.roles.includes(r.id) ? m.roles.filter((x) => x !== r.id) : [...m.roles, r.id]),
            })),
          },
        ]
      : []),
    ...(!self && above && has(my, P.TIMEOUT) && m
      ? [m.timeoutUntil && m.timeoutUntil > Date.now() ? { label: 'Remove timeout', onClick: () => void a.timeout(c, pub, null) } : { label: 'Timeout (mute)', onClick: () => openModal('moderate', { c, pub, action: 'timeout' }) }]
      : []),
    ...(!self && above && has(my, P.KICK) ? [{ label: 'Kick', danger: true, onClick: () => openModal('moderate', { c, pub, action: 'kick' }) }] : []),
    ...(!self && above && has(my, P.BAN) ? [{ label: 'Ban', danger: true, onClick: () => openModal('moderate', { c, pub, action: 'ban' }) }] : []),
    ...(st.owner === me && !self
      ? [
          {
            label: 'Transfer ownership',
            danger: true,
            onClick: () =>
              confirmDialog({
                title: 'Transfer ownership?',
                body: `${a.nameOf(pub, c)} becomes the owner of ${st.name}. You keep your roles but lose owner powers. This cannot be undone by you.`,
                confirm: 'Transfer',
                danger: true,
                onConfirm: () => void a.transferOwnership(c, pub),
              }),
          },
        ]
      : []),
    { sep: true },
    { label: 'Copy user ID', onClick: () => void copy(pub, 'User ID copied') },
  ]);
}

export function GroupMembers({ c }: { c: string }) {
  const st = useStore((s) => s.states[c]) as GroupState | null;
  const me = useStore((s) => s.me);
  if (!st) return null;
  return (
    <aside className="members">
      <div className="mem-group">
        <div className="mem-title">
          Members <span>{Object.keys(st.members).length}</span>
        </div>
        {Object.keys(st.members).map((pub) => (
          <div
            key={pub}
            className="mem"
            onClick={(e) => openProfile(e, pub)}
            onContextMenu={(e) =>
              openMenu(e, [
                { label: 'Profile', onClick: () => openModal('profile', { pub }) },
                ...(pub !== me ? [{ label: 'Message', onClick: () => void app().openDm(pub) }] : []),
                ...(st.owner === me && pub !== me ? [{ label: 'Remove from group', danger: true, onClick: () => void app().removeFromGroup(c, pub) }] : []),
              ])
            }
          >
            <Avatar pub={pub} size={32} status />
            <span className="mem-names">
              <span className="mem-name">
                <UserName pub={pub} />
                {st.owner === pub && <I.crown size={13} className="owner-crown" />}
              </span>
              <CustomStatus pub={pub} />
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}

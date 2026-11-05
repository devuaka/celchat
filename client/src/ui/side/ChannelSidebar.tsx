import { useState } from 'react';
import { useStore, openModal, openMenu, chanKey } from '../../state/store';
import { app } from '../../core/app';
import { I, cls, copy, Avatar, UserName, useBlobUrl, confirmDialog } from '../common';
import { communityMenu } from '../rail/ServerRail';
import { sortedChannels, channelPerms, basePerms, type Channel, type CommunityState } from '@shared/engine';
import { P, has } from '@shared/perms';

export function ChannelSidebar({ c }: { c: string }) {
  const st = useStore((s) => s.states[c]) as CommunityState | null;
  const rec = useStore((s) => s.convos[c]);
  const me = useStore((s) => s.me);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const bannerUrl = useBlobUrl(st?.banner ?? null, { c, publicAsset: true });
  if (!st) {
    return (
      <div className="side">
        <div className="side-head">
          <span className="side-title">{rec?.joinCode ? 'Joining...' : 'Not synced yet'}</span>
        </div>
        <div className="side-body muted pad">Waiting for a member to come online.</div>
      </div>
    );
  }
  const base = basePerms(st, me);
  const canManage = has(base, P.MANAGE_CHANNELS);
  const { loose, groups } = sortedChannels(st);
  const visible = (ch: Channel) => (channelPerms(st, me, ch.id) & P.VIEW_CHANNEL) !== 0;
  const memberCount = Object.keys(st.members).length;

  return (
    <div className="side">
      <button
        type="button"
        className={cls('side-head community-head', bannerUrl && 'has-banner')}
        style={bannerUrl ? { backgroundImage: `linear-gradient(180deg, transparent 30%, rgb(0 0 0 / 0.65)), url(${bannerUrl})` } : undefined}
        onClick={(e) => communityMenu(e, c, st)}
        onContextMenu={(e) => communityMenu(e, c, st)}
      >
        <span className="side-title">{st.name}</span>
        <span className="side-sub">{memberCount} member{memberCount === 1 ? '' : 's'}</span>
        <I.down size={18} />
      </button>
      {!st.members[me] && !rec?.joinCode && (
        <div className="side-notice">
          <span>
            <b>{st.bans[me] ? 'You are banned from this community.' : 'You are no longer a member.'}</b> You can still read what was synced before.
          </span>
          <button type="button" className="chip" onClick={() => void app().convos.remove(c).then(() => app().navigate({ kind: 'home', tab: 'online' }))}>
            <I.trash size={13} /> Remove from my list
          </button>
        </div>
      )}
      <div className="side-actions">
        {has(base, P.CREATE_INVITE) && (
          <button type="button" className="chip" onClick={() => openModal('invite', { c })}>
            <I.userPlus size={14} /> Invite
          </button>
        )}
        {canManage && (
          <button type="button" className="chip" onClick={() => openModal('channel', { c, type: 'text', parent: groups[0]?.cat.id ?? null })}>
            <I.plus size={14} /> Channel
          </button>
        )}
        {(st.owner === me || has(base, P.MANAGE_COMMUNITY) || has(base, P.MANAGE_ROLES) || has(base, P.BAN)) && (
          <button type="button" className="chip" onClick={() => openModal('community-settings', { c })}>
            <I.settings size={14} /> Settings
          </button>
        )}
      </div>
      <div className="side-body">
        {loose.filter(visible).map((ch) => (
          <ChannelRow key={ch.id} c={c} ch={ch} st={st} canManage={canManage} />
        ))}
        {groups.map(({ cat, items }) => {
          const vis = items.filter(visible);
          if (!vis.length && !canManage) return null;
          const closed = collapsed[cat.id];
          return (
            <div key={cat.id} className="cat">
              <div
                className="cat-head"
                onClick={() => setCollapsed((s) => ({ ...s, [cat.id]: !s[cat.id] }))}
                onContextMenu={(e) =>
                  canManage &&
                  openMenu(e, [
                    { label: 'Create channel', onClick: () => openModal('channel', { c, type: 'text', parent: cat.id }) },
                    { label: 'Edit category', onClick: () => openModal('channel', { c, id: cat.id }) },
                    {
                      label: 'Delete category',
                      danger: true,
                      onClick: () => confirmDialog({ title: `Delete ${cat.name}?`, body: 'Channels inside it are kept and become uncategorized.', confirm: 'Delete', danger: true, onConfirm: () => void app().deleteChannel(c, cat.id) }),
                    },
                  ])
                }
              >
                <I.down size={12} className={cls('cat-chev', closed && 'closed')} />
                <span>{cat.name}</span>
                {canManage && (
                  <button
                    type="button"
                    className="cat-add"
                    title="Create channel"
                    onClick={(e) => {
                      e.stopPropagation();
                      openModal('channel', { c, type: 'text', parent: cat.id });
                    }}
                  >
                    <I.plus size={14} />
                  </button>
                )}
              </div>
              {vis.map((ch) => (closed ? <CollapsedRow key={ch.id} c={c} ch={ch} st={st} canManage={canManage} /> : <ChannelRow key={ch.id} c={c} ch={ch} st={st} canManage={canManage} />))}
            </div>
          );
        })}
        {canManage && (
          <button type="button" className="side-add-cat" onClick={() => openModal('channel', { c, type: 'category' })}>
            <I.plus size={14} /> New category
          </button>
        )}
      </div>
    </div>
  );
}

/** Collapsed categories still show the selected channel and voice channels with people in them. */
function CollapsedRow(props: { c: string; ch: Channel; st: CommunityState; canManage: boolean }) {
  const active = useStore((s) => s.view.kind === 'community' && s.view.ch === props.ch.id);
  const occupied = useStore((s) => Object.keys(s.voiceRooms[chanKey(props.c, props.ch.id)] ?? {}).length > 0);
  if (!active && !occupied) return null;
  return <ChannelRow {...props} />;
}

function ChannelRow({ c, ch, st, canManage }: { c: string; ch: Channel; st: CommunityState; canManage: boolean }) {
  const key = chanKey(c, ch.id);
  const active = useStore((s) => (s.view.kind === 'community' || s.view.kind === 'voice') && s.view.c === c && s.view.ch === ch.id);
  const unread = useStore((s) => s.unread[key]);
  const rec = useStore((s) => s.convos[c]);
  const inRoom = useStore((s) => s.voice.room?.c === c && s.voice.room.ch === ch.id);
  const muted = !!rec?.chans[ch.id]?.muted;
  const a = app();
  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      ...(ch.type === 'text' ? [{ label: 'Mark as read', onClick: () => void a.markRead(c, ch.id) }, { sep: true }] : []),
      { label: muted ? 'Unmute channel' : 'Mute channel', onClick: () => void a.setConvoPrefs(c, {}, ch.id, { muted: !muted }) },
      ...(ch.type === 'text'
        ? [
            {
              label: 'Notifications',
              sub: (['default', 'all', 'mentions', 'none'] as const).map((lv) => ({
                label: lv === 'default' ? 'Use community default' : lv === 'all' ? 'All messages' : lv === 'mentions' ? 'Only @mentions' : 'Nothing',
                checked: (rec?.chans[ch.id]?.notify ?? 'default') === lv,
                onClick: () => void a.setConvoPrefs(c, {}, ch.id, { notify: lv }),
              })),
            },
          ]
        : []),
      ...(canManage
        ? [
            { sep: true },
            { label: 'Edit channel', onClick: () => openModal('channel', { c, id: ch.id }) },
            {
              label: 'Delete channel',
              danger: true,
              onClick: () => confirmDialog({ title: `Delete #${ch.name}?`, body: 'Everyone loses access to this channel and its messages.', confirm: 'Delete channel', danger: true, onConfirm: () => void a.deleteChannel(c, ch.id) }),
            },
          ]
        : []),
      { sep: true },
      { label: 'Copy channel ID', onClick: () => void copy(ch.id, 'Channel ID copied') },
    ]);
  const onClick = () => {
    if (ch.type === 'voice') {
      if (!inRoom) void a.joinVoice(c, ch.id);
      else a.navigate({ kind: 'voice', c, ch: ch.id });
    } else a.navigate({ kind: 'community', c, ch: ch.id });
  };
  const Ico = ch.type === 'voice' ? I.voice : I.hash;
  const readOnly = ch.type === 'text' && !(channelPerms(st, a.me, ch.id) & P.SEND);
  return (
    <>
      <div
        className={cls('chan', active && 'active', unread?.u && !muted && !rec?.muted && 'unread', muted && 'muted', inRoom && 'in-room')}
        onClick={onClick}
        onContextMenu={menu}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onClick()}
      >
        <Ico size={18} className="chan-icon" />
        <span className="chan-name">{ch.name}</span>
        {readOnly && <I.lock size={12} className="muted" />}
        {!!unread?.m && <span className="badge">{unread.m}</span>}
        {canManage && (
          <button
            type="button"
            className="chan-gear"
            title="Edit channel"
            onClick={(e) => {
              e.stopPropagation();
              openModal('channel', { c, id: ch.id });
            }}
          >
            <I.settings size={14} />
          </button>
        )}
      </div>
      {ch.type === 'voice' && <VoiceOccupants c={c} ch={ch.id} />}
    </>
  );
}

function VoiceOccupants({ c, ch }: { c: string; ch: string }) {
  const room = useStore((s) => s.voiceRooms[chanKey(c, ch)]);
  const voice = useStore((s) => s.voice);
  const me = useStore((s) => s.me);
  if (!room) return null;
  const mine = voice.room?.c === c && voice.room.ch === ch;
  return (
    <div className="voice-occ">
      {Object.entries(room).map(([pub, st]) => {
        const speaking = mine ? (pub === me ? voice.speaking : voice.peers.some((p) => p.pub === pub && p.speaking)) : false;
        return (
          <div key={pub} className="voice-occ-row" onClick={(e) => useStore.setState({ popout: { x: e.clientX, y: e.clientY, pub, c } })}>
            <Avatar pub={pub} size={22} speaking={speaking} />
            <UserName pub={pub} c={c} />
            <span className="voice-occ-icons">
              {st.muted && <I.micOff size={13} />}
              {st.deaf && <I.deaf size={13} />}
            </span>
          </div>
        );
      })}
    </div>
  );
}

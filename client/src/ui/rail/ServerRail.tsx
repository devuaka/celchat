import { useState } from 'react';
import { useStore, openModal, openMenu, closeModal } from '../../state/store';
import { app } from '../../core/app';
import { CommunityIcon, I, cls, copy, Modal, Button, Field } from '../common';
import type { CommunityState } from '@shared/engine';
import { basePerms } from '@shared/engine';
import { P, has } from '@shared/perms';

export function ServerRail() {
  const view = useStore((s) => s.view);
  const convos = useStore((s) => s.convos);
  const states = useStore((s) => s.states);
  const unread = useStore((s) => s.unread);
  const hub = useStore((s) => s.hub.state);
  const [drag, setDrag] = useState<string | null>(null);
  const folders = useStore((s) => s.settings.folders);

  const communities = Object.values(convos)
    .filter((r) => r.type === 'community')
    .sort((a, b) => a.order - b.order || a.addedAt - b.addedAt);

  let dmMentions = 0;
  for (const [k, u] of Object.entries(unread)) {
    const rec = convos[k.split('|')[0]];
    if (rec && rec.type !== 'community') dmMentions += u.m;
  }

  return (
    <nav className="rail" aria-label="Communities">
      <RailItem active={view.kind === 'home' || view.kind === 'dm'} label="Home" badge={dmMentions} onClick={() => app().navigate({ kind: 'home', tab: 'online' })}>
        <span className="rail-home">
          <img src="./icon.svg" alt="" />
        </span>
      </RailItem>
      <div className="rail-sep" />
      <div className="rail-list">
        {(() => {
          const unreadOf = (rec: (typeof communities)[number]) => {
            let u = false;
            let m = 0;
            for (const [k, v] of Object.entries(unread)) {
              if (!k.startsWith(rec.c + '|')) continue;
              const ch = k.slice(65);
              if (!rec.muted && !rec.chans[ch]?.muted && v.u) u = true;
              m += v.m;
            }
            return { u, m };
          };
          const renderOne = (rec: (typeof communities)[number]) => {
            const st = states[rec.c] as CommunityState | null;
            const { u, m } = unreadOf(rec);
            const active = (view.kind === 'community' || view.kind === 'voice') && view.c === rec.c;
            const name = st?.name ?? (rec.joinCode ? 'Joining...' : 'Unsynced community');
            return (
              <div
                key={rec.c}
                draggable
                onDragStart={() => setDrag(rec.c)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  if (!drag || drag === rec.c) return;
                  // drop on the middle of an icon = put both in a folder; near an edge = reorder
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const y = (e.clientY - r.top) / r.height;
                  if (y > 0.28 && y < 0.72) void folderize(drag, rec.c);
                  else {
                    const order = communities.map((x) => x.c).filter((c) => c !== drag);
                    order.splice(order.indexOf(rec.c) + (y >= 0.72 ? 1 : 0), 0, drag);
                    void app().reorderCommunities(order);
                  }
                  setDrag(null);
                }}
                onContextMenu={(e) => st && communityMenu(e, rec.c, st)}
              >
                <RailItem active={active} unread={u} badge={m} label={name} muted={rec.muted} onClick={() => app().navigate({ kind: 'community', c: rec.c, ch: null })}>
                  {st ? <CommunityIcon c={rec.c} name={st.name} icon={st.icon} size={48} /> : <span className="cicon pending">{rec.joinCode ? <span className="spinner" /> : '?'}</span>}
                </RailItem>
              </div>
            );
          };
          const inFolder = new Map<string, Folder>();
          for (const f of folders) for (const c of f.items) inFolder.set(c, f);
          const shown = new Set<string>();
          const out: React.ReactNode[] = [];
          for (const rec of communities) {
            const f = inFolder.get(rec.c);
            if (!f) {
              out.push(renderOne(rec));
              continue;
            }
            if (shown.has(f.id)) continue;
            shown.add(f.id);
            const members = communities.filter((r) => f.items.includes(r.c));
            const agg = members.map(unreadOf);
            const activeInside = members.some((r) => (view.kind === 'community' || view.kind === 'voice') && view.c === r.c);
            out.push(
              <div key={f.id} className={cls('rail-folder', f.open && 'open')} style={{ ['--fc' as string]: f.color }}>
                <RailItem
                  label={f.name}
                  active={!f.open && activeInside}
                  unread={!f.open && agg.some((x) => x.u)}
                  badge={!f.open ? agg.reduce((s, x) => s + x.m, 0) : 0}
                  onClick={() => void saveFolders(folders.map((x) => (x.id === f.id ? { ...x, open: !x.open } : x)))}
                >
                  <span className="folder-icon" onContextMenu={(e) => folderMenu(e, f)}>
                    {f.open ? (
                      <I.folder size={22} />
                    ) : (
                      members.slice(0, 4).map((r) => {
                        const st = states[r.c] as CommunityState | null;
                        return st ? <CommunityIcon key={r.c} c={r.c} name={st.name} icon={st.icon} size={19} /> : <span key={r.c} className="cicon" />;
                      })
                    )}
                  </span>
                </RailItem>
                {f.open && <div className="folder-items">{members.map(renderOne)}</div>}
              </div>,
            );
          }
          return out;
        })()}
        <RailItem label="Create or join a community" onClick={() => openModal('create-community')} special>
          <span className="rail-add">
            <I.plus size={24} />
          </span>
        </RailItem>
      </div>
      <div className="rail-foot">
        <span className={cls('hub-dot', hub)} title={hub === 'online' ? 'Connected to hub' : hub === 'connecting' ? 'Connecting to hub...' : 'Hub offline: direct links still work, new connections cannot be made'} />
      </div>
    </nav>
  );
}

type Folder = ReturnType<typeof useStore.getState>['settings']['folders'][number];
const FOLDER_COLORS = ['#5fd3b3', '#7aa7ff', '#a98bff', '#ff7ad9', '#ff8a4c', '#f6c35b', '#8fd36b', '#9fb0c0'];

/** Folders with fewer than two communities dissolve. */
async function saveFolders(list: Folder[]) {
  const cleaned = list.map((f) => ({ ...f, items: [...new Set(f.items)] })).filter((f) => f.items.length >= 2);
  await app().saveSettings({ ...app().settings, folders: cleaned });
}

async function folderize(dragged: string, target: string) {
  const folders = app().settings.folders.map((f) => ({ ...f, items: f.items.filter((c) => c !== dragged) }));
  const host = folders.find((f) => f.items.includes(target));
  if (host) host.items.push(dragged);
  else folders.push({ id: Math.random().toString(36).slice(2, 10), name: 'New folder', color: FOLDER_COLORS[folders.length % FOLDER_COLORS.length], items: [target, dragged], open: true });
  await saveFolders(folders);
}

function folderMenu(e: React.MouseEvent, f: Folder) {
  const folders = app().settings.folders;
  openMenu(e, [
    { label: 'Rename folder', onClick: () => openModal('folder', { id: f.id }) },
    { label: 'Color', sub: FOLDER_COLORS.map((col) => ({ label: col, checked: f.color === col, onClick: () => void saveFolders(folders.map((x) => (x.id === f.id ? { ...x, color: col } : x))) })) },
    { sep: true },
    { label: 'Ungroup', danger: true, onClick: () => void saveFolders(folders.filter((x) => x.id !== f.id)) },
  ]);
}

export function FolderModal({ id }: { id: string }) {
  const f = useStore((s) => s.settings.folders.find((x) => x.id === id));
  const [name, setName] = useState(f?.name ?? '');
  if (!f) return null;
  return (
    <Modal
      title="Rename folder"
      footer={
        <Button
          onClick={() => {
            void saveFolders(app().settings.folders.map((x) => (x.id === id ? { ...x, name: name.trim().slice(0, 40) || 'Folder' } : x)));
            closeModal();
          }}
        >
          Save
        </Button>
      }
    >
      <Field label="Folder name">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus />
      </Field>
    </Modal>
  );
}

function RailItem({ children, active, unread, badge, label, onClick, special, muted }: { children: React.ReactNode; active?: boolean; unread?: boolean; badge?: number; label: string; onClick: () => void; special?: boolean; muted?: boolean }) {
  return (
    <div className={cls('rail-item', active && 'active', unread && 'unread', special && 'special', muted && 'muted')}>
      <span className="rail-pill" />
      <button type="button" className="rail-btn" onClick={onClick} aria-label={label} data-tip={label}>
        {children}
      </button>
      {!!badge && <span className="rail-badge">{badge > 99 ? '99+' : badge}</span>}
      <span className="rail-label">{label}</span>
    </div>
  );
}

export function communityMenu(e: React.MouseEvent, c: string, st: CommunityState) {
  const a = app();
  const rec = useStore.getState().convos[c];
  const me = a.me;
  const base = (bit: number) => has(basePerms(st, me), bit);
  openMenu(e, [
    {
      label: 'Mark as read',
      onClick: () => {
        for (const ch of Object.values(st.channels)) if (ch.type === 'text') void a.markRead(c, ch.id);
      },
    },
    { sep: true },
    { label: 'Invite people', disabled: !base(P.CREATE_INVITE), onClick: () => openModal('invite', { c }) },
    { label: rec?.muted ? 'Unmute community' : 'Mute community', onClick: () => void a.setConvoPrefs(c, { muted: !rec?.muted }) },
    {
      label: 'Notifications',
      sub: (['default', 'all', 'mentions', 'none'] as const).map((lv) => ({
        label: lv === 'default' ? 'Use default' : lv === 'all' ? 'All messages' : lv === 'mentions' ? 'Only @mentions' : 'Nothing',
        checked: (rec?.notify ?? 'default') === lv,
        onClick: () => void a.setConvoPrefs(c, { notify: lv }),
      })),
    },
    { label: 'Community settings', onClick: () => openModal('community-settings', { c }) },
    (() => {
      const folders = a.settings.folders;
      const mine = folders.find((f) => f.items.includes(c));
      if (mine) return { label: `Remove from "${mine.name}"`, onClick: () => void saveFolders(folders.map((f) => (f.id === mine.id ? { ...f, items: f.items.filter((x) => x !== c) } : f))) };
      const others = useStore.getState().convos;
      const candidates = Object.values(others).filter((r) => r.type === 'community' && r.c !== c);
      return {
        label: 'Add to folder',
        sub: [
          ...folders.map((f) => ({ label: f.name, onClick: () => void saveFolders(folders.map((x) => (x.id === f.id ? { ...x, items: [...x.items, c] } : x))) })),
          ...(candidates.length ? [{ label: 'New folder with...', disabled: true }] : []),
          ...candidates.slice(0, 12).map((r) => ({ label: `  ${(useStore.getState().states[r.c] as CommunityState | null)?.name ?? 'community'}`, onClick: () => void folderize(c, r.c) })),
        ],
      };
    })(),
    { sep: true },
    { label: 'Copy community ID', onClick: () => void copy(c, 'Community ID copied') },
    ...(st.owner !== me
      ? [
          { sep: true },
          {
            label: 'Leave community',
            danger: true,
            onClick: () =>
              useStore.setState({
                modal: {
                  kind: 'confirm',
                  props: {
                    title: `Leave ${st.name}?`,
                    body: 'You will need a new invite to come back. Messages stored on this device for this community are removed.',
                    confirm: 'Leave',
                    danger: true,
                    onConfirm: () => a.leaveCommunity(c),
                  },
                },
              }),
          },
        ]
      : []),
  ]);
}

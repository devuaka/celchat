import { useState } from 'react';
import { useStore, closeModal, toast, openModal } from '../../state/store';
import { app } from '../../core/app';
import { Modal, Button, Field, I, Toggle, ColorInput, Avatar, UserName, cls, copy, pickFile, CommunityIcon, useBlobUrl, confirmDialog, fmtDate, Segmented, IconButton } from '../common';
import { CustomEmoji } from '../markdown';
import { prepareImage } from '../../core/media';
import { FONTS } from '../../core/theme';
import { P, PERM_INFO, type PermName } from '@shared/perms';
import { sortedRoles, highestPos, basePerms, memberColor, type CommunityState, type Role } from '@shared/engine';
import { memberMenu } from '../members/MemberList';
import { isAppBot, isArchivePeer } from '@shared/profile';

type Tab = 'overview' | 'theme' | 'emoji' | 'roles' | 'members' | 'bans' | 'invites' | 'archive' | 'danger';

export function CommunitySettings({ c, initial }: { c: string; initial?: string }) {
  const st = useStore((s) => s.states[c]) as CommunityState | null;
  const me = useStore((s) => s.me);
  const [tab, setTab] = useState<Tab>((initial as Tab) ?? 'overview');
  if (!st) return null;
  const perms = basePerms(st, me);
  const can = (bit: number) => (perms & (bit | P.ADMIN)) !== 0 || st.owner === me;
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'overview', label: 'Overview', show: true },
    { id: 'theme', label: 'Community theme', show: can(P.MANAGE_COMMUNITY) },
    { id: 'emoji', label: 'Emoji', show: true },
    { id: 'roles', label: 'Roles', show: can(P.MANAGE_ROLES) },
    { id: 'members', label: 'Members', show: true },
    { id: 'bans', label: 'Bans', show: can(P.BAN) },
    { id: 'invites', label: 'Invites', show: can(P.CREATE_INVITE) || can(P.MANAGE_COMMUNITY) },
    { id: 'archive', label: 'Bots & archive peers', show: true },
    { id: 'danger', label: st.owner === me ? 'Ownership' : 'Leave', show: true },
  ];
  return (
    <Modal wide="full" className="settings">
      <div className="settings-layout">
        <nav className="settings-nav">
          <div className="settings-nav-title">
            <CommunityIcon c={c} name={st.name} icon={st.icon} size={22} /> {st.name}
          </div>
          {tabs
            .filter((t) => t.show)
            .map((t) => (
              <button type="button" key={t.id} className={cls('settings-tab', tab === t.id && 'on', t.id === 'danger' && 'danger')} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
        </nav>
        <section className="settings-main">
          <button type="button" className="settings-close" onClick={closeModal} title="Close (Esc)">
            <I.x size={20} />
          </button>
          {tab === 'overview' && <Overview c={c} st={st} editable={can(P.MANAGE_COMMUNITY)} />}
          {tab === 'theme' && <CommunityThemeTab c={c} st={st} />}
          {tab === 'emoji' && <EmojiTab c={c} st={st} canManage={can(P.MANAGE_EMOJI)} />}
          {tab === 'roles' && <RolesTab c={c} st={st} />}
          {tab === 'members' && <MembersTab c={c} st={st} />}
          {tab === 'bans' && <BansTab c={c} st={st} />}
          {tab === 'invites' && <InvitesTab c={c} st={st} />}
          {tab === 'archive' && <ArchiveTab c={c} st={st} canInvite={can(P.CREATE_INVITE)} canKick={can(P.KICK)} />}
          {tab === 'danger' && <DangerTab c={c} st={st} />}
        </section>
      </div>
    </Modal>
  );
}

function Overview({ c, st, editable }: { c: string; st: CommunityState; editable: boolean }) {
  const [name, setName] = useState(st.name);
  const [desc, setDesc] = useState(st.description);
  const [policy, setPolicy] = useState(st.joinPolicy);
  const [sys, setSys] = useState(st.systemChannel ?? '');
  const [icon, setIcon] = useState<Blob | null | undefined>(undefined);
  const [banner, setBanner] = useState<Blob | null | undefined>(undefined);
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const curBanner = useBlobUrl(st.banner, { c, publicAsset: true });
  const dirty = name !== st.name || desc !== st.description || policy !== st.joinPolicy || sys !== (st.systemChannel ?? '') || icon !== undefined || banner !== undefined;
  const pick = async (kind: 'icon' | 'banner') => {
    const [f] = await pickFile('image/png,image/jpeg,image/gif,image/webp');
    if (!f) return;
    try {
      const blob = await prepareImage(f, kind === 'icon' ? 512 : 1920, 10 * 1024 * 1024);
      const url = URL.createObjectURL(blob);
      if (kind === 'icon') {
        setIcon(blob);
        setIconUrl(url);
      } else {
        setBanner(blob);
        setBannerUrl(url);
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="settings-page">
      <h2>Overview</h2>
      <div className="comm-banner-edit" style={{ backgroundImage: bannerUrl ? `url(${bannerUrl})` : banner === null ? undefined : curBanner ? `url(${curBanner})` : undefined }}>
        {editable && (
          <div className="comm-banner-actions">
            <Button small kind="subtle" onClick={() => void pick('banner')}>
              <I.image size={14} /> Banner (GIF ok)
            </Button>
            {(st.banner || banner) && (
              <Button small kind="subtle" onClick={() => { setBanner(null); setBannerUrl(null); }}>
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="icon-upload-row">
        <button type="button" className="icon-upload" disabled={!editable} onClick={() => void pick('icon')}>
          {iconUrl ? <img src={iconUrl} alt="" /> : icon === null ? <I.upload size={22} /> : <CommunityIcon c={c} name={st.name} icon={st.icon} size={84} />}
        </button>
        <div className="grow">
          <Field label="Community name">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} disabled={!editable} />
          </Field>
          {editable && st.icon && icon !== null && (
            <button type="button" className="link small" onClick={() => { setIcon(null); setIconUrl(null); }}>
              Remove icon
            </button>
          )}
        </div>
      </div>
      <Field label="Description" hint="Shown to people you invite">
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={1024} rows={3} disabled={!editable} />
      </Field>
      <div className="grid2">
        <Field label="Who can join" hint={policy === 'open' ? 'Anyone who knows the community ID can join.' : 'People need a valid invite.'}>
          <Segmented value={policy} onChange={(v) => editable && setPolicy(v)} options={[{ value: 'invite', label: 'Invite only' }, { value: 'open', label: 'Open' }]} />
        </Field>
        <Field label="Default channel">
          <select value={sys} onChange={(e) => setSys(e.target.value)} disabled={!editable}>
            <option value="">First channel</option>
            {Object.values(st.channels)
              .filter((x) => x.type === 'text')
              .map((x) => (
                <option key={x.id} value={x.id}>
                  #{x.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <div className="info-box">
        <I.info size={16} />
        <span>
          Created {fmtDate(st.createdAt)} by {app().nameOf(st.owner, c)}. ID <button type="button" className="link mono" onClick={() => void copy(c, 'Community ID copied')}>{c.slice(0, 16)}...</button>
        </span>
      </div>
      {editable && dirty && (
        <div className="save-bar">
          <span>You have unsaved changes</span>
          <Button kind="ghost" small onClick={() => { setName(st.name); setDesc(st.description); setPolicy(st.joinPolicy); setSys(st.systemChannel ?? ''); setIcon(undefined); setBanner(undefined); setIconUrl(null); setBannerUrl(null); }}>
            Reset
          </Button>
          <Button
            small
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const patch: Record<string, unknown> = {};
                if (name.trim() && name !== st.name) patch.name = name.trim();
                if (desc !== st.description) patch.description = desc;
                if (policy !== st.joinPolicy) patch.joinPolicy = policy;
                if (sys !== (st.systemChannel ?? '')) patch.systemChannel = sys || null;
                await app().updateCommunity(c, patch, { icon, banner });
                setIcon(undefined);
                setBanner(undefined);
                toast('Saved', 'success');
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

function CommunityThemeTab({ c, st }: { c: string; st: CommunityState }) {
  const [on, setOn] = useState(!!st.theme);
  const [accent, setAccent] = useState(st.theme?.accent ?? '#5fd3b3');
  const [accent2, setAccent2] = useState(st.theme?.accent2 ?? '#7aa7ff');
  const [font, setFont] = useState(st.theme?.font ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <div className="settings-page">
      <h2>Community theme</h2>
      <p className="muted">Give your community its own accent colors and font. Members see it while they are here (they can turn community themes off in their own settings).</p>
      <Toggle on={on} onChange={setOn} label="Use a custom community theme" />
      {on && (
        <>
          <div className="grid2">
            <ColorInput value={accent} onChange={setAccent} label="Accent" />
            <ColorInput value={accent2} onChange={setAccent2} label="Secondary accent" />
          </div>
          <Field label="Font">
            <select value={font} onChange={(e) => setFont(e.target.value)}>
              <option value="">Member's own font</option>
              {FONTS.filter((f) => f.kind !== 'mono').map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="theme-swatch-preview" style={{ background: `linear-gradient(135deg, ${accent}, ${accent2})` }}>
            <span>{st.name}</span>
          </div>
        </>
      )}
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await app().updateCommunity(c, { theme: on ? { accent, accent2, font: font || undefined } : null });
            toast('Community theme saved', 'success');
            app().navigate(useStore.getState().view);
          } catch (e) {
            toast((e as Error).message, 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        Save theme
      </Button>
    </div>
  );
}

function RolesTab({ c, st }: { c: string; st: CommunityState }) {
  const me = app().me;
  const roles = sortedRoles(st);
  const [sel, setSel] = useState<string>(roles[0]?.id ?? st.id);
  const myTop = highestPos(st, me);
  const role = st.roles[sel] ?? st.roles[st.id];
  return (
    <div className="settings-page roles-page">
      <h2>Roles</h2>
      <p className="muted">Roles higher in the list outrank lower ones. You can only edit roles below your own highest role. Every member's client enforces these permissions.</p>
      <div className="roles-layout">
        <div className="roles-list">
          <Button
            small
            onClick={async () => {
              try {
                const op = await app().createRole(c, 'new role', '#99aab5', 0);
                setSel((op.p as { id: string }).id);
              } catch (e) {
                toast((e as Error).message, 'error');
              }
            }}
          >
            <I.plus size={14} /> Create role
          </Button>
          {roles.map((r, i) => (
            <div key={r.id} className={cls('role-item', sel === r.id && 'on', st.owner !== me && r.pos >= myTop && 'locked')} onClick={() => setSel(r.id)}>
              <i style={{ background: r.color ?? 'var(--text3)' }} />
              <span className="grow ellipsis">{r.name}</span>
              <span className="muted small">{Object.values(st.members).filter((m) => m.roles.includes(r.id)).length}</span>
              {(st.owner === me || r.pos < myTop - 1) && i > 0 && (
                <button
                  type="button"
                  className="role-move"
                  title="Move up"
                  onClick={(e) => {
                    e.stopPropagation();
                    const above = roles[i - 1];
                    void (async () => {
                      await app().updateRole(c, r.id, { pos: above.pos });
                      await app().updateRole(c, above.id, { pos: r.pos });
                    })().catch((err) => toast(err.message, 'error'));
                  }}
                >
                  <I.down size={14} style={{ transform: 'rotate(180deg)' }} />
                </button>
              )}
              {(st.owner === me || r.pos < myTop) && i < roles.length - 1 && (
                <button
                  type="button"
                  className="role-move"
                  title="Move down"
                  onClick={(e) => {
                    e.stopPropagation();
                    const below = roles[i + 1];
                    void (async () => {
                      await app().updateRole(c, below.id, { pos: r.pos });
                      await app().updateRole(c, r.id, { pos: below.pos === r.pos ? Math.max(1, r.pos - 1) : below.pos });
                    })().catch((err) => toast(err.message, 'error'));
                  }}
                >
                  <I.down size={14} />
                </button>
              )}
            </div>
          ))}
          <div className={cls('role-item', sel === st.id && 'on')} onClick={() => setSel(st.id)}>
            <i style={{ background: 'var(--text3)' }} />
            <span className="grow">@everyone</span>
          </div>
        </div>
        {role && <RoleEditor key={role.id} c={c} st={st} role={role} />}
      </div>
    </div>
  );
}

function RoleEditor({ c, st, role }: { c: string; st: CommunityState; role: Role }) {
  const me = app().me;
  const isEveryone = role.id === st.id;
  const editable = st.owner === me || isEveryone || role.pos < highestPos(st, me);
  const mine = basePerms(st, me);
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color ?? '#99aab5');
  const [perms, setPerms] = useState(role.perms);
  const [hoist, setHoist] = useState(role.hoist);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [busy, setBusy] = useState(false);
  const dirty = name !== role.name || color !== (role.color ?? '#99aab5') || perms !== role.perms || hoist !== role.hoist || mentionable !== role.mentionable;
  const flip = (k: PermName) => setPerms(perms ^ P[k]);
  return (
    <div className="role-editor">
      {!editable && (
        <div className="info-box warn">
          <I.lock size={16} /> This role is at or above your highest role, so you cannot edit it.
        </div>
      )}
      {!isEveryone && (
        <div className="grid2">
          <Field label="Role name">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} disabled={!editable} />
          </Field>
          <Field label="Color">
            <ColorInput value={color} onChange={setColor} />
          </Field>
        </div>
      )}
      {!isEveryone && (
        <>
          <Toggle on={hoist} onChange={setHoist} disabled={!editable} label="Show members separately" desc="Members with this role get their own group in the member list." />
          <Toggle on={mentionable} onChange={setMentionable} disabled={!editable} label="Anyone can @mention this role" />
        </>
      )}
      <div className="field-label mt">Permissions</div>
      <div className="perm-grid">
        {PERM_INFO.map((p) => {
          const bit = P[p.key];
          const grantable = st.owner === me || (mine & P.ADMIN) !== 0 || (mine & bit) !== 0;
          return <Toggle key={p.key} on={(perms & bit) !== 0} onChange={() => flip(p.key)} disabled={!editable || !grantable} label={p.label} desc={p.desc} />;
        })}
      </div>
      <div className="role-editor-foot">
        {!isEveryone && editable && (
          <Button
            kind="danger"
            small
            onClick={() =>
              confirmDialog({
                title: `Delete ${role.name}?`,
                body: 'Members keep their other roles.',
                confirm: 'Delete role',
                danger: true,
                onConfirm: () => void app().deleteRole(c, role.id).catch((e) => toast(e.message, 'error')),
              })
            }
          >
            Delete role
          </Button>
        )}
        <span className="grow" />
        {dirty && editable && (
          <Button
            small
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const patch: Record<string, unknown> = {};
                if (perms !== role.perms) patch.perms = perms;
                if (!isEveryone) {
                  if (name !== role.name) patch.name = name.trim() || role.name;
                  if (color !== (role.color ?? '#99aab5')) patch.color = color.slice(0, 7);
                  if (hoist !== role.hoist) patch.hoist = hoist;
                  if (mentionable !== role.mentionable) patch.mentionable = mentionable;
                }
                await app().updateRole(c, role.id, patch);
                toast('Role saved', 'success');
              } catch (e) {
                toast((e as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Save role
          </Button>
        )}
      </div>
    </div>
  );
}

function MembersTab({ c, st }: { c: string; st: CommunityState }) {
  const [q, setQ] = useState('');
  const me = app().me;
  const members = Object.values(st.members)
    .filter((m) => !q || app().nameOf(m.pub, c).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.joinedAt - a.joinedAt);
  return (
    <div className="settings-page">
      <h2>Members · {Object.keys(st.members).length}</h2>
      <input placeholder="Search members" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table">
        {members.slice(0, 500).map((m) => (
          <div key={m.pub} className="trow" onContextMenu={(e) => memberMenu(e, c, st, m.pub, me)}>
            <Avatar pub={m.pub} size={32} status />
            <span className="grow">
              <UserName pub={m.pub} c={c} color={memberColor(st, m.pub)} />
              {st.owner === m.pub && <I.crown size={13} className="owner-crown" />}
              <span className="muted small"> joined {fmtDate(m.joinedAt)}</span>
              {m.timeoutUntil && m.timeoutUntil > Date.now() && <span className="pill warn">timed out</span>}
            </span>
            <span className="role-pills">
              {m.roles.slice(0, 4).map((r) => (
                <span key={r} className="role-pill">
                  <i style={{ background: st.roles[r]?.color ?? 'var(--text3)' }} />
                  {st.roles[r]?.name}
                </span>
              ))}
            </span>
            <button type="button" className="ibtn" title="Actions" onClick={(e) => memberMenu(e, c, st, m.pub, me)}>
              <I.more size={18} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function BansTab({ c, st }: { c: string; st: CommunityState }) {
  const bans = Object.entries(st.bans);
  return (
    <div className="settings-page">
      <h2>Bans · {bans.length}</h2>
      {!bans.length && <p className="muted">Nobody is banned.</p>}
      <div className="table">
        {bans.map(([pub, b]) => (
          <div key={pub} className="trow">
            <Avatar pub={pub} size={32} />
            <span className="grow">
              <UserName pub={pub} />
              <span className="muted small">
                {' '}
                by {app().nameOf(b.by, c)} on {fmtDate(b.at)}
                {b.reason && ` · ${b.reason}`}
              </span>
            </span>
            <Button small kind="ghost" onClick={() => void app().unban(c, pub).catch((e) => toast(e.message, 'error'))}>
              Unban
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function InvitesTab({ c, st }: { c: string; st: CommunityState }) {
  const me = app().me;
  const invites = Object.values(st.invites).filter((i) => !i.revoked && (i.expiresAt === null || i.expiresAt > Date.now()));
  const canManage = st.owner === me || (basePerms(st, me) & (P.MANAGE_COMMUNITY | P.ADMIN)) !== 0;
  return (
    <div className="settings-page">
      <h2>Invites</h2>
      <Button small onClick={() => openModal('invite', { c })}>
        <I.plus size={14} /> Create invite
      </Button>
      <div className="table">
        {invites.map((i) => (
          <div key={i.code} className="trow">
            <span className="mono">{i.code}</span>
            <span className="grow muted small">
              by {app().nameOf(i.by, c)} · {i.uses}
              {i.maxUses ? `/${i.maxUses}` : ''} uses · {i.expiresAt ? `expires ${new Date(i.expiresAt).toLocaleString()}` : 'never expires'}
            </span>
            <Button small kind="ghost" onClick={() => void copy(app().inviteLink(c, i.code), 'Invite copied')}>
              Copy
            </Button>
            {(canManage || i.by === me) && (
              <Button small kind="danger" onClick={() => void app().revokeInvite(c, i.code)}>
                Revoke
              </Button>
            )}
          </div>
        ))}
        {!invites.length && <p className="muted">No active invites.</p>}
      </div>
    </div>
  );
}

function EmojiTab({ c, st, canManage }: { c: string; st: CommunityState; canManage: boolean }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const list = Object.values(st.emojis ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="settings-page">
      <h2>Emoji · {list.length}/250</h2>
      <p className="muted">
        Custom emoji, animated GIFs included. No slot limits tied to a subscription, and every member can use them in <b>any</b> conversation, including DMs and other communities. They travel peer to
        peer like everything else.
      </p>
      {canManage ? (
        <div className="emoji-add">
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} placeholder="emoji_name" maxLength={32} spellCheck={false} />
          <Button
            busy={busy}
            disabled={name.length < 2}
            onClick={async () => {
              const [f] = await pickFile('image/png,image/gif,image/webp,image/jpeg');
              if (!f) return;
              setBusy(true);
              try {
                const n = await app().addEmoji(c, name, f);
                toast(`:${n}: added`, 'success');
                setName('');
              } catch (e) {
                toast((e as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            <I.upload size={15} /> Upload image
          </Button>
        </div>
      ) : (
        <p className="muted small">You need the Manage emoji permission to add emoji here.</p>
      )}
      <div className="emoji-list">
        {list.map((e) => (
          <div key={e.name} className="emoji-row">
            <CustomEmoji name={e.name} hash={e.asset.hash} size={e.asset.size} big />
            <span className="grow mono">:{e.name}:</span>
            <span className="muted small">by {app().nameOf(e.by, c)}</span>
            {canManage && <IconButton icon={I.trash} title="Remove" onClick={() => void app().removeEmoji(c, e.name).catch((err) => toast(err.message, 'error'))} size={16} />}
          </div>
        ))}
        {!list.length && <p className="muted small">No custom emoji yet.</p>}
      </div>
    </div>
  );
}

function CommunityBots({ c, st, canInvite, canKick }: { c: string; st: CommunityState; canInvite: boolean; canKick: boolean }) {
  const profiles = useStore((s) => s.profiles);
  const presence = useStore((s) => s.presence);
  const mine = useStore((s) => s.bots);
  const [busy, setBusy] = useState<string | null>(null);
  const here = Object.values(st.members).filter((m) => isAppBot(profiles[m.pub]));
  const addable = mine.filter((b) => !st.members[b.pub]);
  return (
    <>
      <h2>Bots</h2>
      <p className="muted">
        Bots are automated members that answer commands, post embeds and buttons, welcome people, moderate and more. Each one runs inside the CelChat of the member who made it, so it is online while
        they are. Every peer checks a bot&rsquo;s actions against its roles, exactly like a person&rsquo;s.
      </p>
      <div className="field-label mt">In this community · {here.length}</div>
      {!here.length && <p className="muted small">No bots yet.</p>}
      {here.map((m) => {
        const card = profiles[m.pub];
        const own = mine.some((b) => b.pub === m.pub);
        const on = presence[m.pub] && presence[m.pub] !== 'invisible';
        return (
          <div key={m.pub} className="archive-card">
            <Avatar pub={m.pub} size={36} status />
            <span className="archive-info">
              <span>
                <UserName pub={m.pub} c={c} />
              </span>
              <span className="muted small">
                {on ? 'Online' : 'Offline'} · {card?.botInfo?.commands?.length ?? 0} commands{own ? ' · yours' : ''}
              </span>
            </span>
            {own ? (
              <Button small kind="ghost" busy={busy === m.pub} onClick={async () => {
                setBusy(m.pub);
                try {
                  await app().bots.removeFromCommunity(m.pub, c);
                } catch (e) {
                  toast((e as Error).message, 'error');
                } finally {
                  setBusy(null);
                }
              }}>
                Remove
              </Button>
            ) : (
              canKick && (
                <Button small kind="danger" onClick={() => void app().kick(c, m.pub, 'bot removed').catch((e) => toast(e.message, 'error'))}>
                  Kick
                </Button>
              )
            )}
          </div>
        );
      })}
      <div className="field-label mt">Your bots</div>
      {!mine.length && (
        <p className="muted small">
          You have no bots yet.{' '}
          <button type="button" className="link" onClick={() => openModal('settings', { tab: 'bots' })}>
            Create or import one
          </button>
          .
        </p>
      )}
      {addable.map((b) => (
        <div key={b.pub} className="archive-card">
          <Avatar pub={b.pub} size={36} />
          <span className="archive-info">
            <span>{b.name}</span>
            <span className="muted small">
              @{b.username} · {b.commands.length} commands · {b.status === 'running' ? 'running' : 'not running'}
            </span>
          </span>
          <Button
            small
            disabled={!canInvite}
            title={canInvite ? undefined : 'You need the Create invites permission'}
            busy={busy === b.pub}
            onClick={async () => {
              setBusy(b.pub);
              try {
                await app().bots.addToCommunity(b.pub, c);
                if (b.status !== 'running') await app().bots.setEnabled(b.pub, true);
                toast(`${b.name} joined ${st.name}`, 'success');
              } catch (e) {
                toast((e as Error).message, 'error');
              } finally {
                setBusy(null);
              }
            }}
          >
            Add
          </Button>
        </div>
      ))}
      {mine.length > 0 && !addable.length && <p className="muted small">All your bots are already here.</p>}
    </>
  );
}

function ArchiveTab({ c, st, canInvite, canKick }: { c: string; st: CommunityState; canInvite: boolean; canKick: boolean }) {
  const profiles = useStore((s) => s.profiles);
  const presence = useStore((s) => s.presence);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const bots = Object.values(st.members).filter((m) => isArchivePeer(profiles[m.pub]));
  return (
    <div className="settings-page">
      <CommunityBots c={c} st={st} canInvite={canInvite || st.joinPolicy === 'open'} canKick={canKick} />
      <h2 className="mt-lg">Archive peers</h2>
      <p className="muted">
        CelChat communities live on their members&rsquo; devices, so when everyone is offline nobody can sync. An archive peer is an always-on member (a small program someone runs on a server or a spare
        computer) that keeps the full history and attachments and hands them to members and invite holders whenever they come online.
      </p>
      <div className="info-box">
        <I.info size={16} />
        <span>
          An archive peer can read everything in the community, exactly like any other member. Only add one run by someone you trust. It obeys roles and bans like everyone else, and deletes its copy if it
          is kicked or banned.
        </span>
      </div>
      <div className="field-label mt">In this community · {bots.length}</div>
      {!bots.length && <p className="muted small">No archive peer yet. History is only available while a member who has it is online.</p>}
      {bots.map((m) => (
        <div key={m.pub} className="archive-card">
          <Avatar pub={m.pub} size={36} status />
          <span className="archive-info">
            <span>
              <UserName pub={m.pub} c={c} />
            </span>
            <span className="muted small">
              {presence[m.pub] && presence[m.pub] !== 'invisible' ? 'Online, serving history' : 'Offline right now'} · joined {fmtDate(m.joinedAt)}
            </span>
          </span>
          {canKick && (
            <Button
              small
              kind="danger"
              onClick={() =>
                confirmDialog({
                  title: 'Remove this archive peer?',
                  body: 'It is kicked from the community and deletes its copy of the history and files.',
                  confirm: 'Remove',
                  danger: true,
                  onConfirm: () => void app().kick(c, m.pub, 'archive peer removed').catch((e) => toast(e.message, 'error')),
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {canInvite ? (
        <>
          <div className="field-label mt">Add an archive peer</div>
          <form
            className={cls('add-friend-form', msg && (msg.ok ? 'ok' : 'bad'))}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setMsg(null);
              try {
                const pub = await app().addArchivePeer(c, q);
                setMsg({ ok: true, text: `Sent a sealed, single-use invite to ${app().nameOf(pub)}. It joins as soon as it processes the request (its operator decides who may add it).` });
                setQ('');
              } catch (err) {
                setMsg({ ok: false, text: (err as Error).message });
              } finally {
                setBusy(false);
              }
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="@archive or a CelChat ID" spellCheck={false} />
            <Button type="submit" busy={busy} disabled={!q.trim()}>
              Add
            </Button>
          </form>
          {msg && <div className={msg.ok ? 'ok-text' : 'field-error'}>{msg.text}</div>}
          <p className="muted small mt">
            Run your own with <code className="md-inline">npm run keeper</code> next to your hub and list your CelChat ID in <code className="md-inline">KEEPER_OWNERS</code>. See docs/SELF_HOSTING.md.
          </p>
        </>
      ) : (
        <p className="muted small mt">You need permission to create invites to add an archive peer.</p>
      )}
    </div>
  );
}

function DangerTab({ c, st }: { c: string; st: CommunityState }) {
  const me = app().me;
  const [target, setTarget] = useState('');
  if (st.owner !== me)
    return (
      <div className="settings-page">
        <h2>Leave {st.name}</h2>
        <p className="muted">You will need a new invite to come back.</p>
        <Button
          kind="danger"
          onClick={() =>
            confirmDialog({
              title: `Leave ${st.name}?`,
              body: 'Messages stored on this device for this community are removed.',
              confirm: 'Leave',
              danger: true,
              onConfirm: async () => {
                await app().leaveCommunity(c);
              },
            })
          }
        >
          Leave community
        </Button>
      </div>
    );
  return (
    <div className="settings-page">
      <h2>Ownership</h2>
      <p className="muted">
        You own this community. Owners cannot leave until they hand ownership to another member. There is no "delete" for a P2P community: once members have it, it lives on their devices. You can transfer ownership, then leave.
      </p>
      <Field label="New owner">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose a member</option>
          {Object.keys(st.members)
            .filter((p) => p !== me)
            .map((p) => (
              <option key={p} value={p}>
                {app().nameOf(p, c)}
              </option>
            ))}
        </select>
      </Field>
      <Button
        kind="danger"
        disabled={!target}
        onClick={() =>
          confirmDialog({
            title: 'Transfer ownership?',
            body: `${app().nameOf(target, c)} becomes the owner. You cannot undo this yourself.`,
            confirm: 'Transfer',
            danger: true,
            onConfirm: () => void app().transferOwnership(c, target).then(() => toast('Ownership transferred', 'success')),
          })
        }
      >
        Transfer ownership
      </Button>
    </div>
  );
}

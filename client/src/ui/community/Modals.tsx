import { useEffect, useMemo, useState } from 'react';
import { useStore, closeModal, openModal, toast } from '../../state/store';
import { app } from '../../core/app';
import { Modal, Button, Field, I, Segmented, copy, pickFile, Avatar, UserName, cls, confirmDialog } from '../common';
import { prepareImage } from '../../core/media';
import { P, PERM_INFO, CHANNEL_PERMS } from '@shared/perms';
import { sortedRoles, type CommunityState, type GroupState, type Overwrite } from '@shared/engine';

export function CreateCommunityModal() {
  const [step, setStep] = useState<'choose' | 'create'>('choose');
  const [name, setName] = useState(`${useStore.getState().myCard?.displayName || useStore.getState().myCard?.username}'s place`);
  const [icon, setIcon] = useState<Blob | null>(null);
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (step === 'choose')
    return (
      <Modal title="Add a community" subtitle="Communities are owned by their members, not by a company.">
        <div className="choice-list">
          <button type="button" className="choice" onClick={() => setStep('create')}>
            <span className="choice-icon">
              <I.sparkles size={22} />
            </span>
            <span>
              <b>Create my own</b>
              <span className="muted small">You own it. Channels, roles and history live on members' devices.</span>
            </span>
            <I.right size={18} />
          </button>
          <button type="button" className="choice" onClick={() => openModal('join')}>
            <span className="choice-icon">
              <I.link size={22} />
            </span>
            <span>
              <b>Join with an invite</b>
              <span className="muted small">Paste an invite link someone shared with you.</span>
            </span>
            <I.right size={18} />
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal
      title="Create your community"
      subtitle="You can change all of this later."
      footer={
        <>
          <Button kind="ghost" onClick={() => setStep('choose')}>
            Back
          </Button>
          <Button
            busy={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await app().createCommunity(name.trim().slice(0, 100), icon);
                closeModal();
              } catch (e) {
                toast((e as Error).message, 'error');
                setBusy(false);
              }
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="icon-upload-row">
        <button
          type="button"
          className="icon-upload"
          onClick={async () => {
            const [f] = await pickFile('image/png,image/jpeg,image/gif,image/webp');
            if (!f) return;
            try {
              const blob = await prepareImage(f, 512, 8 * 1024 * 1024);
              setIcon(blob);
              setIconUrl(URL.createObjectURL(blob));
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        >
          {iconUrl ? <img src={iconUrl} alt="" /> : (
            <>
              <I.upload size={22} />
              <span>Icon</span>
            </>
          )}
        </button>
        <Field label="Community name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
        </Field>
      </div>
      <p className="muted small">Starts with a #general text channel and a Lounge voice channel. Animated GIF icons are fine.</p>
    </Modal>
  );
}

export function JoinModal({ initial }: { initial?: string }) {
  const [link, setLink] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      title="Join a community"
      subtitle="Invites look like https://your-hub/#/join/... "
      footer={
        <>
          <Button kind="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!link.trim()}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await app().joinByInvite(link);
                closeModal();
                const inv = app().parseInvite(link)!;
                if (r === 'pending') app().navigate({ kind: 'community', c: inv.c, ch: null });
              } catch (e) {
                setErr((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Join
          </Button>
        </>
      }
    >
      <Field label="Invite link" error={err} hint="A member of the community needs to be online to let you in: there is no central server holding it.">
        <input value={link} onChange={(e) => setLink(e.target.value)} autoFocus placeholder="https://.../#/join/..." spellCheck={false} />
      </Field>
    </Modal>
  );
}

export function InviteModal({ c }: { c: string }) {
  const st = useStore((s) => s.states[c]) as CommunityState | null;
  const [exp, setExp] = useState<number>(7 * 86400);
  const [uses, setUses] = useState<number>(0);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      setLink(await app().createInvite(c, exp || null, uses || null));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void create();
  }, []);
  return (
    <Modal title={`Invite friends to ${st?.name ?? 'this community'}`} subtitle="Anyone with the link can join while it is valid.">
      <Field label="Invite link">
        <div className="copy-row">
          <input readOnly value={link ?? 'Creating...'} onFocus={(e) => e.target.select()} />
          <Button disabled={!link} onClick={() => link && void copy(link, 'Invite link copied')}>
            Copy
          </Button>
        </div>
      </Field>
      <div className="grid2">
        <Field label="Expires after">
          <select value={exp} onChange={(e) => setExp(Number(e.target.value))}>
            <option value={3600}>1 hour</option>
            <option value={86400}>1 day</option>
            <option value={7 * 86400}>7 days</option>
            <option value={30 * 86400}>30 days</option>
            <option value={0}>Never</option>
          </select>
        </Field>
        <Field label="Max uses">
          <select value={uses} onChange={(e) => setUses(Number(e.target.value))}>
            <option value={0}>No limit</option>
            <option value={1}>1 use</option>
            <option value={5}>5 uses</option>
            <option value={10}>10 uses</option>
            <option value={25}>25 uses</option>
            <option value={100}>100 uses</option>
          </select>
        </Field>
      </div>
      <Button kind="ghost" small busy={busy} onClick={() => void create()}>
        <I.refresh size={14} /> Generate a new link with these settings
      </Button>
      <p className="muted small">The link points at this hub. It only helps people find members; the community itself is on members' devices.</p>
    </Modal>
  );
}

type Tri = 'allow' | 'deny' | 'inherit';

export function ChannelModal({ c, id, type: initialType, parent }: { c: string; id?: string; type?: 'text' | 'voice' | 'category'; parent?: string | null }) {
  const st = useStore((s) => s.states[c]) as CommunityState;
  const existing = id ? st.channels[id] : null;
  const [type, setType] = useState<'text' | 'voice' | 'category'>(existing?.type ?? initialType ?? 'text');
  const [name, setName] = useState(existing?.name ?? '');
  const [topic, setTopic] = useState(existing?.topic ?? '');
  const [par, setPar] = useState<string | null>(existing ? existing.parent : parent ?? null);
  const [ow, setOw] = useState<Record<string, Overwrite>>(existing?.overwrites ?? {});
  const [target, setTarget] = useState<string>(st.id);
  const [tab, setTab] = useState<'general' | 'perms'>('general');
  const [busy, setBusy] = useState(false);
  const cats = Object.values(st.channels).filter((x) => x.type === 'category');
  const canRoles = st.owner === app().me || (st.members[app().me]?.roles ?? []).some((r) => (st.roles[r]?.perms ?? 0) & (P.MANAGE_ROLES | P.ADMIN)) || ((st.roles[st.id]?.perms ?? 0) & (P.MANAGE_ROLES | P.ADMIN)) !== 0;
  const tri = (bit: number): Tri => {
    const o = ow[target];
    if (!o) return 'inherit';
    if (o.allow & bit) return 'allow';
    if (o.deny & bit) return 'deny';
    return 'inherit';
  };
  const setTri = (bit: number, v: Tri) => {
    const o = { ...(ow[target] ?? { allow: 0, deny: 0 }) };
    o.allow &= ~bit;
    o.deny &= ~bit;
    if (v === 'allow') o.allow |= bit;
    if (v === 'deny') o.deny |= bit;
    setOw({ ...ow, [target]: o });
  };
  const perms = PERM_INFO.filter((p) => p.channel && (P[p.key] & CHANNEL_PERMS) && (type === 'voice' ? !['SEND', 'ATTACH', 'REACT', 'MENTION_EVERYONE', 'MANAGE_MESSAGES'].includes(p.key) : !['CONNECT', 'SPEAK', 'MUTE_MEMBERS'].includes(p.key)));
  const save = async () => {
    setBusy(true);
    try {
      if (existing) {
        const patch: Record<string, unknown> = {};
        if (name.trim() && name !== existing.name) patch.name = type === 'category' ? name.trim() : name.trim().toLowerCase().replace(/\s+/g, '-');
        if (topic !== existing.topic) patch.topic = topic;
        if (type !== 'category' && par !== existing.parent) patch.parent = par;
        if (JSON.stringify(ow) !== JSON.stringify(existing.overwrites)) patch.overwrites = ow;
        if (Object.keys(patch).length) await app().updateChannel(c, existing.id, patch);
      } else {
        await app().createChannel(c, type, name.trim() || (type === 'voice' ? 'Voice' : 'new-channel'), type === 'category' ? null : par, topic);
      }
      closeModal();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal
      title={existing ? `Edit ${existing.type === 'category' ? existing.name : '#' + existing.name}` : `Create ${type === 'category' ? 'category' : 'channel'}`}
      wide={tab === 'perms'}
      footer={
        <>
          {existing && (
            <Button
              kind="danger"
              className="mr-auto"
              onClick={() =>
                confirmDialog({
                  title: `Delete ${existing.name}?`,
                  body: existing.type === 'category' ? 'Channels inside it are kept.' : 'This cannot be undone.',
                  confirm: 'Delete',
                  danger: true,
                  onConfirm: () => void app().deleteChannel(c, existing.id),
                })
              }
            >
              Delete
            </Button>
          )}
          <Button kind="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button busy={busy} onClick={() => void save()}>
            {existing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      {existing && canRoles && (
        <div className="tabs">
          <button type="button" className={cls(tab === 'general' && 'on')} onClick={() => setTab('general')}>
            General
          </button>
          <button type="button" className={cls(tab === 'perms' && 'on')} onClick={() => setTab('perms')}>
            Permissions
          </button>
        </div>
      )}
      {tab === 'general' ? (
        <>
          {!existing && (
            <Field label="Type">
              <Segmented
                value={type}
                onChange={setType}
                options={[
                  { value: 'text', label: <><I.hash size={14} /> Text</> },
                  { value: 'voice', label: <><I.voice size={14} /> Voice</> },
                  { value: 'category', label: <><I.folder size={14} /> Category</> },
                ]}
              />
            </Field>
          )}
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus placeholder={type === 'voice' ? 'Hangout' : type === 'category' ? 'Projects' : 'new-channel'} />
          </Field>
          {type === 'text' && (
            <Field label="Topic" hint="Markdown works here">
              <textarea value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={1024} rows={2} />
            </Field>
          )}
          {type !== 'category' && (
            <Field label="Category">
              <select value={par ?? ''} onChange={(e) => setPar(e.target.value || null)}>
                <option value="">No category</option>
                {cats.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {!existing && type !== 'category' && (
            <div className="chip-row">
              <button type="button" className="chip" onClick={() => setOw({ [st.id]: { allow: 0, deny: P.SEND } })}>
                <I.lock size={13} /> Make read-only for @everyone
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="perm-editor">
          <div className="perm-targets">
            <div className="field-label">Roles & members</div>
            {[{ id: st.id, name: '@everyone', color: null }, ...sortedRoles(st)].map((r) => (
              <button type="button" key={r.id} className={cls('perm-target', target === r.id && 'on', ow[r.id] && 'has')} onClick={() => setTarget(r.id)}>
                <i style={{ background: r.color ?? 'var(--text3)' }} />
                {r.name}
              </button>
            ))}
            {Object.keys(ow)
              .filter((k) => /^[0-9a-f]{64}$/.test(k) && k !== st.id && !st.roles[k])
              .map((pub) => (
                <button type="button" key={pub} className={cls('perm-target', target === pub && 'on', 'has')} onClick={() => setTarget(pub)}>
                  <Avatar pub={pub} size={18} />
                  <UserName pub={pub} c={c} />
                </button>
              ))}
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                setOw({ ...ow, [e.target.value]: ow[e.target.value] ?? { allow: 0, deny: 0 } });
                setTarget(e.target.value);
              }}
            >
              <option value="">+ Add a member</option>
              {Object.keys(st.members)
                .filter((p) => !ow[p])
                .map((p) => (
                  <option key={p} value={p}>
                    {app().nameOf(p, c)}
                  </option>
                ))}
            </select>
          </div>
          <div className="perm-list">
            {perms.map((p) => (
              <div key={p.key} className="perm-row">
                <div>
                  <div className="perm-label">{p.label}</div>
                  <div className="perm-desc">{p.desc}</div>
                </div>
                <div className="tri">
                  {(['deny', 'inherit', 'allow'] as Tri[]).map((v) => (
                    <button type="button" key={v} className={cls(`tri-${v}`, tri(P[p.key]) === v && 'on')} onClick={() => setTri(P[p.key], v)} title={v}>
                      {v === 'deny' ? <I.x size={14} /> : v === 'allow' ? <I.check size={14} /> : '/'}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function CreateGroupModal({ addTo }: { addTo?: string }) {
  const allFriends = useStore((s) => s.friends);
  const friends = useMemo(() => Object.values(allFriends).filter((f) => f.state === 'friend'), [allFriends]);
  const st = useStore((s) => (addTo ? (s.states[addTo] as GroupState | null) : null));
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const existing = st ? Object.keys(st.members) : [];
  const room = 9 - (existing.length ? existing.length - 1 : 0);
  const list = friends.filter((f) => !existing.includes(f.pub) && app().nameOf(f.pub).toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal
      title={addTo ? 'Add people to the group' : 'New group DM'}
      subtitle={`Pick up to ${room} friends. Group DMs are end-to-end encrypted.`}
      footer={
        <>
          <Button kind="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!picked.length}
            onClick={async () => {
              setBusy(true);
              try {
                if (addTo) for (const p of picked) await app().addToGroup(addTo, p);
                else if (picked.length === 1) await app().openDm(picked[0]);
                else await app().createGroup(picked, name.trim() || undefined);
                closeModal();
              } catch (e) {
                toast((e as Error).message, 'error');
                setBusy(false);
              }
            }}
          >
            {addTo ? 'Add' : picked.length === 1 ? 'Open DM' : 'Create group'}
          </Button>
        </>
      }
    >
      {!addTo && (
        <Field label="Group name (optional)">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
      )}
      <input placeholder="Search friends" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pick-list">
        {!friends.length && <div className="muted pad small">Add friends first: group DMs are friends-only.</div>}
        {list.map((f) => {
          const on = picked.includes(f.pub);
          return (
            <label key={f.pub} className={cls('pick', on && 'on')}>
              <input type="checkbox" checked={on} disabled={!on && picked.length >= room} onChange={() => setPicked(on ? picked.filter((p) => p !== f.pub) : [...picked, f.pub])} />
              <Avatar pub={f.pub} size={28} status />
              <UserName pub={f.pub} />
            </label>
          );
        })}
      </div>
    </Modal>
  );
}

export function MemberModerationModal({ c, pub, action }: { c: string; pub: string; action: 'kick' | 'ban' | 'timeout' }) {
  const [reason, setReason] = useState('');
  const [purge, setPurge] = useState(0);
  const [dur, setDur] = useState(3600);
  const [busy, setBusy] = useState(false);
  const name = app().nameOf(pub, c);
  const title = action === 'kick' ? `Kick ${name}` : action === 'ban' ? `Ban ${name}` : `Timeout ${name}`;
  return (
    <Modal
      title={title}
      footer={
        <>
          <Button kind="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            kind="danger"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (action === 'kick') await app().kick(c, pub, reason);
                else if (action === 'ban') await app().ban(c, pub, reason, purge);
                else await app().timeout(c, pub, dur, reason);
                toast(`${name} was ${action === 'kick' ? 'kicked' : action === 'ban' ? 'banned' : 'timed out'}.`, 'success');
                closeModal();
              } catch (e) {
                toast((e as Error).message, 'error');
                setBusy(false);
              }
            }}
          >
            {action === 'kick' ? 'Kick' : action === 'ban' ? 'Ban' : 'Timeout'}
          </Button>
        </>
      }
    >
      <p className="muted">
        {action === 'kick'
          ? 'They can rejoin with a new invite.'
          : action === 'ban'
            ? 'They cannot rejoin until unbanned. Every member’s client enforces this.'
            : 'They can read but not chat, react, or talk in voice until it ends.'}
      </p>
      {action === 'timeout' && (
        <Field label="Duration">
          <select value={dur} onChange={(e) => setDur(Number(e.target.value))}>
            <option value={60}>60 seconds</option>
            <option value={300}>5 minutes</option>
            <option value={600}>10 minutes</option>
            <option value={3600}>1 hour</option>
            <option value={86400}>1 day</option>
            <option value={7 * 86400}>1 week</option>
          </select>
        </Field>
      )}
      {action === 'ban' && (
        <Field label="Delete their recent messages">
          <select value={purge} onChange={(e) => setPurge(Number(e.target.value))}>
            <option value={0}>Don't delete any</option>
            <option value={3600}>Previous hour</option>
            <option value={86400}>Previous 24 hours</option>
            <option value={7 * 86400}>Previous 7 days</option>
          </select>
        </Field>
      )}
      <Field label="Reason (visible in the community log)">
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={512} />
      </Field>
    </Modal>
  );
}

export function NickModal({ c, pub }: { c: string; pub: string }) {
  const st = useStore((s) => s.states[c]) as CommunityState;
  const [nick, setNick] = useState(st.members[pub]?.nick ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Change nickname"
      footer={
        <>
          <Button kind="ghost" onClick={() => void app().setNick(c, pub, null).then(closeModal)}>
            Reset
          </Button>
          <Button
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await app().setNick(c, pub, nick || null);
                closeModal();
              } catch (e) {
                toast((e as Error).message, 'error');
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Nickname" hint="Only shows in this community">
        <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={32} autoFocus />
      </Field>
    </Modal>
  );
}

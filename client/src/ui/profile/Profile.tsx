import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStore, set, openModal, closeModal, toast } from '../../state/store';
import { app } from '../../core/app';
import { Avatar, I, Modal, Button, StatusDot, usePresence, statusLabel, fmtDate, copy, useBlobUrl, cls, CommunityIcon, UserName } from '../common';
import { Markdown } from '../markdown';
import { memberColor, type CommunityState } from '@shared/engine';
import { fontFamily } from '../../core/theme';
import type { ProfileCard as Card } from '@shared/profile';
import { memberMenu } from '../members/MemberList';

export function ProfileView({ pub, card, c, variant, previewUrls }: { pub: string; card: Card | null; c?: string; variant: 'popout' | 'full' | 'side' | 'preview'; previewUrls?: { avatar?: string | null; banner?: string | null } }) {
  const me = useStore((s) => s.me);
  const presence = usePresence(pub);
  const st = useStore((s) => (c ? (s.states[c] as CommunityState | null) : null));
  const friend = useStore((s) => s.friends[pub]);
  const bannerUrl = useBlobUrl(previewUrls ? null : card?.banner ?? null, { owner: pub, publicAsset: true });
  const banner = previewUrls?.banner !== undefined ? previewUrls.banner : bannerUrl;
  const primary = card?.colors.primary ?? '#2b6f62';
  const accent = card?.colors.accent ?? '#5fd3b3';
  const member = st?.members[pub];
  const roles = member ? member.roles.map((r) => st!.roles[r]).filter(Boolean).sort((a, b) => b.pos - a.pos) : [];
  const status = card?.status && (!card.status.until || card.status.until > Date.now()) ? card.status : null;
  const nameFont = card && card.font !== 'default' ? fontFamily(card.font) : undefined;
  const style = { '--p1': primary, '--p2': accent } as CSSProperties;
  return (
    <div className={cls('pcard', `pcard-${variant}`)} style={style}>
      <div className="pcard-banner" style={banner ? { backgroundImage: `url(${banner})` } : undefined} />
      <div className="pcard-avatar">
        {previewUrls?.avatar !== undefined ? (
          <span className="avatar" style={{ width: 84, height: 84 }}>
            {previewUrls.avatar ? <img src={previewUrls.avatar} alt="" /> : <span className="avatar-fallback" style={{ fontSize: 36 }}>{(card?.displayName || card?.username || '?').slice(0, 1).toUpperCase()}</span>}
          </span>
        ) : (
          <Avatar pub={pub} size={84} card={card} />
        )}
        {variant !== 'preview' && (
          <span className="pcard-status">
            <StatusDot status={presence} size={20} />
          </span>
        )}
      </div>
      <div className="pcard-body">
        <div className="pcard-names">
          <div className={cls('pcard-display', `ns-${card?.nameStyle ?? 'plain'}`)} style={{ fontFamily: nameFont, ...(card?.nameStyle === 'gradient' ? { backgroundImage: `linear-gradient(90deg, ${primary}, ${accent})` } : {}), '--ns-color': accent } as CSSProperties}>
            {member?.nick || card?.displayName || card?.username || `user-${pub.slice(0, 6)}`}
          </div>
          <div className="pcard-user">
            @{card?.username ?? 'unknown'}
            {card?.pronouns && <span> · {card.pronouns}</span>}
            {variant !== 'preview' && <span className="muted"> · {statusLabel(presence)}</span>}
          </div>
        </div>
        {status && (
          <div className="pcard-custom">
            {status.emoji && <span>{status.emoji}</span>} {status.text}
          </div>
        )}
        {variant !== 'preview' && pub !== me && <ProfileActions pub={pub} friendState={friend?.state} c={c} />}
        <div className="pcard-section">
          {card?.about ? (
            <>
              <div className="pcard-h">About me</div>
              <div className="pcard-about">
                <Markdown text={card.about} />
              </div>
            </>
          ) : variant === 'preview' ? (
            <div className="muted small">Your About Me shows here.</div>
          ) : null}
          <div className="pcard-h">Member since</div>
          <div className="pcard-dates">
            <span title="CelChat account created">
              <img src="./icon.svg" alt="" width={14} /> {card ? fmtDate(card.createdAt) : 'unknown'}
            </span>
            {member && st && (
              <span title={`Joined ${st.name}`}>
                <CommunityIcon c={c!} name={st.name} icon={st.icon} size={14} /> {fmtDate(member.joinedAt)}
              </span>
            )}
          </div>
          {roles.length > 0 && (
            <>
              <div className="pcard-h">Roles</div>
              <div className="pcard-roles">
                {roles.map((r) => (
                  <span key={r.id} className="role-pill">
                    <i style={{ background: r.color ?? 'var(--text3)' }} />
                    {r.name}
                  </span>
                ))}
              </div>
            </>
          )}
          {(variant === 'full' || variant === 'side') && pub !== me && <Mutuals pub={pub} />}
          {variant === 'full' && (
            <>
              <div className="pcard-h">CelChat ID</div>
              <div className="pcard-id mono" onClick={() => void copy(pub, 'ID copied')} title="Click to copy">
                {pub}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Mutuals({ pub }: { pub: string }) {
  const convos = useStore((s) => s.convos);
  const states = useStore((s) => s.states);
  const friends = useStore((s) => s.friends);
  const me = useStore((s) => s.me);
  const mutualC = Object.values(convos).filter((r) => {
    const st = states[r.c];
    return r.type === 'community' && st?.kind === 'community' && st.members[pub] && st.members[me];
  });
  const theirs = friends[pub]?.friendsOf;
  const mutualF = theirs ? theirs.filter((p) => friends[p]?.state === 'friend') : [];
  return (
    <>
      <div className="pcard-h">Mutual communities · {mutualC.length}</div>
      <div className="pcard-mutuals">
        {mutualC.map((r) => {
          const st = states[r.c] as CommunityState;
          return (
            <button type="button" key={r.c} className="mutual" onClick={() => { closeModal(); set({ popout: null }); app().navigate({ kind: 'community', c: r.c, ch: null }); }}>
              <CommunityIcon c={r.c} name={st.name} icon={st.icon} size={24} />
              <span>{st.name}</span>
            </button>
          );
        })}
        {!mutualC.length && <span className="muted small">None</span>}
      </div>
      {theirs && (
        <>
          <div className="pcard-h">Mutual friends · {mutualF.length}</div>
          <div className="pcard-mutuals">
            {mutualF.map((p) => (
              <button type="button" key={p} className="mutual" onClick={() => openModal('profile', { pub: p })}>
                <Avatar pub={p} size={24} />
                <UserName pub={p} />
              </button>
            ))}
            {!mutualF.length && <span className="muted small">None</span>}
          </div>
        </>
      )}
    </>
  );
}

function ProfileActions({ pub, friendState, c }: { pub: string; friendState?: string; c?: string }) {
  const a = app();
  const go = (fn: () => unknown) => () => {
    set({ popout: null });
    closeModal();
    void fn();
  };
  return (
    <div className="pcard-actions">
      <Button small onClick={go(() => a.openDm(pub))}>
        <I.dm size={15} /> Message
      </Button>
      <Button small kind="subtle" onClick={go(async () => { const cc = await a.openDm(pub); await a.startCall(cc); })}>
        <I.phone size={15} /> Call
      </Button>
      {friendState === 'friend' ? null : friendState === 'outgoing' ? (
        <Button small kind="subtle" disabled>
          Request sent
        </Button>
      ) : friendState === 'incoming' ? (
        <Button small kind="success" onClick={() => void a.acceptFriend(pub)}>
          Accept friend
        </Button>
      ) : friendState === 'blocked' ? (
        <Button small kind="subtle" onClick={() => void a.unblock(pub)}>
          Unblock
        </Button>
      ) : (
        <Button small kind="subtle" onClick={() => void a.addFriend(pub).then(() => toast('Friend request sent', 'success')).catch((e) => toast(e.message, 'error'))}>
          <I.userPlus size={15} /> Add friend
        </Button>
      )}
      <button
        type="button"
        className="ibtn"
        title="More"
        onClick={(e) => {
          const st = c ? (useStore.getState().states[c] as CommunityState | null) : null;
          if (st) return memberMenu(e, c!, st, pub, a.me);
          useStore.setState({
            menu: {
              x: e.clientX,
              y: e.clientY,
              items: [
                ...(friendState === 'friend' ? [{ label: 'Remove friend', danger: true, onClick: () => void a.removeFriend(pub) }] : []),
                friendState === 'blocked' ? { label: 'Unblock', onClick: () => void a.unblock(pub) } : { label: 'Block', danger: true, onClick: () => void a.block(pub) },
                { label: 'Copy user ID', onClick: () => void copy(pub, 'User ID copied') },
              ],
            },
          });
        }}
      >
        <I.more size={18} />
      </button>
    </div>
  );
}

export function ProfilePopout({ x, y, pub, c }: { x: number; y: number; pub: string; c?: string }) {
  const card = useStore((s) => s.profiles[pub] ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    app().wantProfiles([pub]);
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x + 12;
    if (left + r.width > window.innerWidth - 12) left = x - r.width - 12;
    const top = Math.max(12, Math.min(y - 60, window.innerHeight - r.height - 12));
    setPos({ left: Math.max(12, left), top });
  }, [x, y, pub]);
  return createPortal(
    <div ref={ref} className="popout" style={pos} onClick={(e) => e.stopPropagation()}>
      <ProfileView pub={pub} card={card} c={c} variant="popout" />
      <button type="button" className="popout-more" onClick={() => { set({ popout: null }); openModal('profile', { pub, c }); }}>
        View full profile
      </button>
    </div>,
    document.body,
  );
}

export function ProfileModal({ pub, c }: { pub: string; c?: string }) {
  const card = useStore((s) => s.profiles[pub] ?? null);
  return (
    <Modal className="profile-modal">
      <ProfileView pub={pub} card={card} c={c} variant="full" />
    </Modal>
  );
}

export function ProfileSide({ pub }: { pub: string }) {
  const card = useStore((s) => s.profiles[pub] ?? null);
  return (
    <aside className="members profile-side">
      <ProfileView pub={pub} card={card} variant="side" />
    </aside>
  );
}

export { memberColor };

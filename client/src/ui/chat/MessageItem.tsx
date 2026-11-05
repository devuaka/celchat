import { memo, useEffect, useRef, useState } from 'react';
import { useStore, set, openMenu, openProfile, chanKey, toast } from '../../state/store';
import { app } from '../../core/app';
import { Avatar, I, UserName, cls, copy, fmtTime, fmtStamp, confirmDialog } from '../common';
import { Markdown, isJumbo, ReactionGlyph } from '../markdown';
import { Attachments } from './Attachments';
import { EmojiPicker } from './EmojiPicker';
import { channelPerms, memberColor, type ConvoState, type Message } from '@shared/engine';
import { P } from '@shared/perms';

export const MessageItem = memo(function MessageItem({ m, grouped, st, pings }: { m: Message; grouped: boolean; st: ConvoState | null; pings: boolean }) {
  const me = useStore((s) => s.me);
  const clock24 = useStore((s) => s.settings.chat.clock24);
  const editing = useStore((s) => s.editing === m.id);
  const flash = useStore((s) => s.jumpTo === m.id);
  const blocked = useStore((s) => s.friends[m.a]?.state === 'blocked');
  const saved = useStore((s) => s.bookmarks.some((b) => b.id === m.id));
  const [picker, setPicker] = useState(false);
  const [sel, setSel] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const c = m.c;
  const isCommunity = st?.kind === 'community';
  const perms = isCommunity ? channelPerms(st, me, m.ch, Date.now()) : -1;
  const canManage = isCommunity ? (perms & P.MANAGE_MESSAGES) !== 0 : false;
  const canReact = isCommunity ? (perms & P.REACT) !== 0 : true;
  const canSend = isCommunity ? (perms & P.SEND) !== 0 : true;
  const mine = m.a === me;
  const color = isCommunity ? memberColor(st, m.a) : null;

  useEffect(() => {
    if (flash && ref.current) {
      ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const t = setTimeout(() => set({ jumpTo: null }), 1800);
      return () => clearTimeout(t);
    }
  }, [flash]);

  if (blocked && !showBlocked)
    return (
      <div className="msg blocked-msg">
        <I.ban size={14} /> Message from a blocked user.{' '}
        <button type="button" className="link" onClick={() => setShowBlocked(true)}>
          Show
        </button>
      </div>
    );

  const reply = () => {
    set((s) => ({ replyTo: { ...s.replyTo, [chanKey(c, m.ch)]: m } }));
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
  };
  const del = () =>
    confirmDialog({
      title: 'Delete message',
      body: mine ? 'This removes it from everyone who is online, and from everyone else as they sync.' : 'Delete this message for everyone?',
      confirm: 'Delete',
      danger: true,
      onConfirm: () => void app().deleteMessage(c, m.id),
    });
  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      ...(canReact ? [{ label: 'Add reaction', onClick: () => setPicker(true) }] : []),
      ...(canSend ? [{ label: 'Reply', onClick: reply }] : []),
      ...(mine ? [{ label: 'Edit message', onClick: () => set({ editing: m.id }) }] : []),
      ...(canManage || !isCommunity ? [{ label: m.pinned ? 'Unpin message' : 'Pin message', onClick: () => void app().pin(c, m.id, !m.pinned) }] : []),
      { sep: true },
      saved ? { label: 'Remove bookmark', onClick: () => void app().unbookmark(m.id) } : { label: 'Save message', onClick: () => void app().bookmark(m) },
      {
        label: 'Remind me',
        sub: [
          { label: 'In 20 minutes', onClick: () => void app().bookmark(m, 20 * 60) },
          { label: 'In 1 hour', onClick: () => void app().bookmark(m, 3600) },
          { label: 'In 3 hours', onClick: () => void app().bookmark(m, 3 * 3600) },
          { label: 'Tomorrow', onClick: () => void app().bookmark(m, 24 * 3600) },
          { label: 'Next week', onClick: () => void app().bookmark(m, 7 * 24 * 3600) },
        ],
      },
      { label: 'Read aloud', onClick: () => app().readAloud(m) },
      ...(m.history.length ? [{ label: `Edit history (${m.history.length})`, onClick: () => set({ modal: { kind: 'history', props: { m } } }) }] : []),
      { sep: true },
      { label: 'Copy text', onClick: () => void copy(m.text, 'Text copied') },
      { label: 'Mark unread', onClick: () => void markUnread(m) },
      { label: 'Copy message ID', onClick: () => void copy(m.id, 'Message ID copied') },
      ...(mine || canManage ? [{ sep: true }, { label: 'Delete message', danger: true, onClick: del }] : []),
    ]);

  const time = fmtTime(m.t, clock24);
  return (
    <div
      ref={ref}
      className={cls('msg', grouped && 'grouped', pings && 'pings', mine && 'mine', flash && 'flash', m.pinned && 'pinned', sel && 'sel')}
      onContextMenu={menu}
      onClick={(e) => {
        // touch screens: tap a message to reveal its actions
        if (!matchMedia('(hover: none)').matches || (e.target as HTMLElement).closest('a,button,img,video,input,textarea,.poll')) return;
        setSel(!sel);
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button,img,video,input,textarea')) return;
        if (mine) set({ editing: m.id });
      }}
    >
      {m.reply && <ReplyLine id={m.reply} c={c} />}
      <div className="msg-row">
        <div className="msg-gutter">
          {grouped ? (
            <span className="msg-hover-time" title={fmtStamp(m.t, clock24)}>
              {time}
            </span>
          ) : (
            <Avatar pub={m.a} size={0} className="msg-avatar" onClick={(e) => openProfile(e, m.a, isCommunity ? c : undefined)} />
          )}
        </div>
        <div className="msg-main">
          {!grouped && (
            <div className="msg-head">
              <span className="msg-author" onClick={(e) => openProfile(e, m.a, isCommunity ? c : undefined)} onContextMenu={(e) => e.stopPropagation()}>
                <UserName pub={m.a} c={isCommunity ? c : undefined} color={color} />
              </span>
              {isCommunity && st.owner === m.a && <I.crown size={13} className="owner-crown" />}
              <span className="msg-time" title={new Date(m.t).toLocaleString()}>
                {fmtStamp(m.t, clock24)}
              </span>
            </div>
          )}
          {editing ? (
            <EditBox m={m} />
          ) : (
            <>
              {m.text && (
                <div className={cls('msg-body', isJumbo(m.text) && !m.att.length && 'jumbo')}>
                  <Markdown text={m.text} c={c} />
                  {m.editedAt && (
                    <button type="button" className="msg-edited" title={`Edited ${new Date(m.editedAt).toLocaleString()}. Click for history.`} onClick={(e) => { e.stopPropagation(); set({ modal: { kind: 'history', props: { m } } }); }}>
                      (edited)
                    </button>
                  )}
                </div>
              )}
              {m.poll && <PollView m={m} canVote={canReact} />}
              {m.att.length > 0 && <Attachments att={m.att} c={c} author={m.a} />}
            </>
          )}
          {Object.keys(m.reacts).length > 0 && (
            <div className="reacts">
              {Object.entries(m.reacts).map(([e, who]) => {
                const on = who.includes(me);
                return (
                  <button
                    type="button"
                    key={e}
                    className={cls('react', on && 'on')}
                    title={who.map((p) => app().nameOf(p, isCommunity ? c : undefined)).join(', ')}
                    onClick={() => (canReact || on) && void app().react(c, m.id, e, !on)}
                  >
                    <span className="react-e">
                      <ReactionGlyph e={e} />
                    </span>
                    <span>{who.length}</span>
                  </button>
                );
              })}
              {canReact && (
                <button type="button" className="react add" onClick={() => setPicker(true)} title="Add reaction">
                  <I.react size={16} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {!editing && (
        <div className="msg-tools">
          {canReact &&
            app()
              .settings.recentEmoji.slice(0, 3)
              .map((e) => (
                <button type="button" key={e} className="tool-emoji" title={`React ${e}`} onClick={() => void app().react(c, m.id, e, !(m.reacts[e] ?? []).includes(me))}>
                  {e}
                </button>
              ))}
          {canReact && (
            <button type="button" title="Add reaction" onClick={() => setPicker(true)}>
              <I.react size={17} />
            </button>
          )}
          {canSend && (
            <button type="button" title="Reply" onClick={reply}>
              <I.reply size={17} />
            </button>
          )}
          {mine && (
            <button type="button" title="Edit" onClick={() => set({ editing: m.id })}>
              <I.edit size={16} />
            </button>
          )}
          <button type="button" title="More" onClick={menu}>
            <I.more size={17} />
          </button>
        </div>
      )}
      {picker && (
        <div className="msg-picker">
          <EmojiPicker onPick={(e) => void app().react(c, m.id, e, true)} onClose={() => setPicker(false)} />
        </div>
      )}
    </div>
  );
});

function PollView({ m, canVote }: { m: Message; canVote: boolean }) {
  const me = useStore((s) => s.me);
  const poll = m.poll!;
  const [pending, setPending] = useState<number[] | null>(null);
  const mine = pending ?? poll.votes[me] ?? [];
  const total = Object.keys(poll.votes).length;
  const counts = poll.options.map((_, i) => Object.values(poll.votes).filter((v) => v.includes(i)).length);
  const ended = poll.ends !== null && Date.now() >= poll.ends;
  const showResults = ended || (poll.votes[me]?.length ?? 0) > 0;
  const choose = (i: number) => {
    if (ended || !canVote) return;
    const next = poll.multi ? (mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i]) : mine.includes(i) ? [] : [i];
    setPending(next);
    void app()
      .vote(m.c, m.id, next)
      .catch((e) => toast(e.message, 'error'))
      .finally(() => setTimeout(() => setPending(null), 400));
  };
  const max = Math.max(1, ...counts);
  return (
    <div className="poll" onClick={(e) => e.stopPropagation()}>
      <div className="poll-q">
        <I.poll size={16} /> {poll.q}
      </div>
      <div className="poll-sub muted small">
        {poll.multi ? 'Pick any' : 'Pick one'} · {total} vote{total === 1 ? '' : 's'} · {ended ? 'Final results' : poll.ends ? `ends ${new Date(poll.ends).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'no end date'}
      </div>
      {poll.options.map((o, i) => {
        const pct = total ? Math.round((counts[i] / total) * 100) : 0;
        const picked = mine.includes(i);
        return (
          <button type="button" key={i} className={cls('poll-opt', picked && 'on', counts[i] === max && showResults && counts[i] > 0 && 'lead')} onClick={() => choose(i)} disabled={ended || !canVote}>
            {showResults && <span className="poll-bar" style={{ width: `${pct}%` }} />}
            <span className={cls('poll-check', poll.multi && 'square')}>{picked && <I.check size={12} />}</span>
            <span className="poll-label">{o}</span>
            {showResults && (
              <span className="poll-count">
                {counts[i]} · {pct}%
              </span>
            )}
          </button>
        );
      })}
      {!showResults && <div className="muted small">Vote to see results. Votes are public to the members of this chat.</div>}
    </div>
  );
}

async function markUnread(m: Message) {
  const a = app();
  const x = a.convos.get(m.c);
  if (!x) return;
  x.rec.read[m.ch] = m.l - 1;
  await a.convos.saveRec(x.rec);
  set((s) => ({ unread: { ...s.unread, [chanKey(m.c, m.ch)]: { u: true, m: s.unread[chanKey(m.c, m.ch)]?.m ?? 0 } } }));
  toast('Marked as unread', 'info');
}

function ReplyLine({ id, c }: { id: string; c: string }) {
  const [m, setM] = useState<Message | null | undefined>(undefined);
  const inList = useStore((s) => {
    for (const [k, cs] of Object.entries(s.chans)) if (k.startsWith(c + '|')) {
      const hit = cs.list.find((x) => x.id === id);
      if (hit) return hit;
    }
    return null;
  });
  useEffect(() => {
    if (inList) return;
    void app().convos.getMessage(c, id).then((x) => setM(x));
  }, [id, c, inList]);
  const msg = inList ?? m;
  if (msg === undefined) return <div className="reply-line" />;
  if (!msg || msg.deleted)
    return (
      <div className="reply-line muted">
        <I.reply size={13} /> Original message was deleted or is not synced
      </div>
    );
  const st = useStore.getState().states[c];
  return (
    <div className="reply-line" onClick={() => set({ jumpTo: msg.id })}>
      <Avatar pub={msg.a} size={16} />
      <UserName pub={msg.a} c={st?.kind === 'community' ? c : undefined} color={st?.kind === 'community' ? memberColor(st, msg.a) : null} />
      <span className="reply-text ellipsis">{msg.text ? <Markdown text={msg.text.slice(0, 200)} c={c} inlineOnly /> : <i>attachment</i>}</span>
    </div>
  );
}

function EditBox({ m }: { m: Message }) {
  const [text, setText] = useState(m.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);
  const save = async () => {
    const t = text.trim();
    set({ editing: null });
    if (t === m.text.trim()) return;
    if (!t && !m.att.length) {
      await app().deleteMessage(m.c, m.id);
      return;
    }
    await app().editMessage(m.c, m.id, t);
  };
  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        value={text}
        rows={Math.min(10, text.split('\n').length + 1)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
          if (e.key === 'Escape') set({ editing: null });
        }}
      />
      <div className="edit-hint">
        Escape to <button type="button" className="link" onClick={() => set({ editing: null })}>cancel</button> · Enter to <button type="button" className="link" onClick={() => void save()}>save</button>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useStore, closeModal, set, toast, openModal } from '../state/store';
import { app } from '../core/app';
import { Modal, Button, Field, I, Toggle, IconButton, Avatar, UserName, Empty, Spinner, cls, fmtStamp } from './common';
import { Markdown } from './markdown';
import type { Message } from '@shared/engine';

export function HistoryModal({ m }: { m: Message }) {
  const clock24 = useStore((s) => s.settings.chat.clock24);
  const versions = [...m.history, { text: m.text, at: m.editedAt ?? m.t }];
  return (
    <Modal title="Edit history" subtitle="Every peer keeps every signed version of a message, so CelChat shows them instead of pretending edits erase things.">
      <div className="history">
        {versions
          .slice()
          .reverse()
          .map((v, i) => (
            <div key={i} className={cls('history-item', i === 0 && 'current')}>
              <div className="history-meta">
                {i === 0 ? 'Current' : `Version ${versions.length - i}`} · {fmtStamp(v.at, clock24)}
              </div>
              <div className="history-text">{v.text ? <Markdown text={v.text} c={m.c} /> : <i className="muted">(empty)</i>}</div>
            </div>
          ))}
      </div>
    </Modal>
  );
}

export function PollModal({ c, ch }: { c: string; ch: string }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [dur, setDur] = useState<number>(86400);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Create a poll"
      footer={
        <>
          <Button kind="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!q.trim() || opts.filter((o) => o.trim()).length < 2}
            onClick={async () => {
              setBusy(true);
              try {
                await app().sendPoll(c, ch, { q, options: opts, multi, durationSecs: dur || null });
                closeModal();
              } catch (e) {
                toast((e as Error).message, 'error');
                setBusy(false);
              }
            }}
          >
            Post poll
          </Button>
        </>
      }
    >
      <Field label="Question">
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} autoFocus placeholder="What should we play tonight?" />
      </Field>
      <div className="field-label">Answers</div>
      {opts.map((o, i) => (
        <div key={i} className="poll-edit-row">
          <input value={o} maxLength={100} placeholder={`Answer ${i + 1}`} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))} />
          {opts.length > 2 && <IconButton icon={I.x} title="Remove" onClick={() => setOpts(opts.filter((_, j) => j !== i))} size={16} />}
        </div>
      ))}
      {opts.length < 10 && (
        <Button small kind="ghost" onClick={() => setOpts([...opts, ''])}>
          <I.plus size={14} /> Add answer
        </Button>
      )}
      <div className="grid2 mt">
        <Field label="Duration">
          <select value={dur} onChange={(e) => setDur(Number(e.target.value))}>
            <option value={3600}>1 hour</option>
            <option value={4 * 3600}>4 hours</option>
            <option value={86400}>1 day</option>
            <option value={3 * 86400}>3 days</option>
            <option value={7 * 86400}>1 week</option>
            <option value={0}>No end</option>
          </select>
        </Field>
        <div className="field">
          <div className="field-label">&nbsp;</div>
          <Toggle on={multi} onChange={setMulti} label="Allow multiple answers" />
        </div>
      </div>
      <p className="muted small">Votes are signed and validated by every member&rsquo;s client, and everyone in the chat can see who voted for what.</p>
    </Modal>
  );
}

export function ScheduleModal({ c, ch, text, reply }: { c: string; ch: string; text: string; reply: string | null }) {
  const d = new Date(Date.now() + 3600_000);
  d.setSeconds(0, 0);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [when, setWhen] = useState(local);
  return (
    <Modal
      title="Send later"
      subtitle="CelChat is peer to peer, so this device sends it: if CelChat is closed at that time, it goes out as soon as you open it."
      footer={
        <>
          <Button kind="ghost" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              try {
                await app().schedule(c, ch, text, new Date(when).getTime(), reply);
                closeModal();
              } catch (e) {
                toast((e as Error).message, 'error');
              }
            }}
          >
            Schedule
          </Button>
        </>
      }
    >
      <Field label="When">
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </Field>
      <div className="schedule-preview">
        <Markdown text={text} c={c} />
      </div>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl K', 'Quick switcher: jump to any community, channel or person'],
  ['Ctrl ,', 'Settings'],
  ['Ctrl /', 'This list'],
  ['Ctrl Shift M', 'Mute / unmute (in a call)'],
  ['Ctrl Shift D', 'Deafen / undeafen'],
  ['Ctrl Shift I', 'Inbox: mentions, saved messages, reminders'],
  ['Alt Up / Down', 'Previous / next channel'],
  ['Up (empty box)', 'Edit your last message'],
  ['Shift Enter', 'New line'],
  ['Escape', 'Cancel reply or edit, close dialogs'],
  ['Push-to-talk key', 'Talk while held (Settings, then Voice)'],
];

export function ShortcutsModal() {
  return (
    <Modal title="Keyboard shortcuts">
      <div className="shortcuts">
        {SHORTCUTS.map(([k, d]) => (
          <div key={k} className="shortcut">
            <span>
              {k.split(' ').map((x, i) => (
                <kbd key={i}>{x}</kbd>
              ))}
            </span>
            <span className="muted">{d}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function WelcomeModal() {
  const install = useStore((s) => s.installPrompt);
  const done = () => {
    localStorage.setItem('cel-welcomed', '1');
    closeModal();
  };
  const step = (icon: React.ReactNode, title: string, body: string, action: () => void, label: string) => (
    <button
      type="button"
      className="choice"
      onClick={() => {
        done();
        action();
      }}
    >
      <span className="choice-icon">{icon}</span>
      <span>
        <b>{title}</b>
        <span className="muted small">{body}</span>
      </span>
      <span className="chip">{label}</span>
    </button>
  );
  return (
    <Modal title="Welcome to CelChat" subtitle="Everything is free, peer to peer, and yours to customize." onClose={done}>
      <div className="choice-list">
        {step(<I.sparkles size={22} />, 'Start a community', 'Channels, roles, voice rooms, custom emoji. It lives on members’ devices.', () => openModal('create-community'), 'Create')}
        {step(<I.userPlus size={22} />, 'Add a friend', 'Find people by @username or CelChat ID. DMs are end-to-end encrypted.', () => app().navigate({ kind: 'home', tab: 'add' }), 'Add')}
        {step(<I.palette size={22} />, 'Make it yours', 'Themes, your own fonts, animated avatar and banner, chat backgrounds.', () => openModal('settings', { tab: 'appearance' }), 'Customize')}
        {install && step(<I.installApp size={22} />, 'Install the app', 'Its own window, taskbar badge and faster start. Works offline for reading.', () => void install.prompt().then(() => set({ installPrompt: null })), 'Install')}
      </div>
    </Modal>
  );
}

type InboxTab = 'mentions' | 'saved' | 'reminders' | 'scheduled';

export function InboxPanel() {
  const [tab, setTab] = useState<InboxTab>('mentions');
  const [mentions, setMentions] = useState<Message[] | null>(null);
  const bookmarks = useStore((s) => s.bookmarks);
  const scheduled = useStore((s) => s.scheduled);
  const clock24 = useStore((s) => s.settings.chat.clock24);
  const states = useStore((s) => s.states);
  useEffect(() => {
    if (tab === 'mentions') void app().inbox().then(setMentions);
  }, [tab]);
  const where = (c: string, ch: string) => {
    const st = states[c];
    if (st?.kind === 'community') return `${st.name} #${st.channels[ch]?.name ?? ''}`;
    return 'Direct message';
  };
  const reminders = bookmarks.filter((b) => b.remindAt);
  return (
    <aside className="panel">
      <div className="panel-head">
        <I.inbox size={18} />
        <b>Inbox</b>
        <span className="grow" />
        <IconButton icon={I.x} title="Close" onClick={() => set({ panel: null })} />
      </div>
      <div className="tabs inline flat inbox-tabs">
        {(['mentions', 'saved', 'reminders', 'scheduled'] as InboxTab[]).map((t) => (
          <button type="button" key={t} className={cls(tab === t && 'on')} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
            {t === 'reminders' && reminders.length > 0 && <span className="badge">{reminders.length}</span>}
            {t === 'scheduled' && scheduled.length > 0 && <span className="badge">{scheduled.length}</span>}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'mentions' &&
          (!mentions ? (
            <Spinner />
          ) : !mentions.length ? (
            <Empty icon={I.at} title="No recent mentions">Messages from the last 14 days that pinged you show up here.</Empty>
          ) : (
            mentions.map((m) => (
              <div key={m.id} className="result" onClick={() => app().jumpTo(m.c, m.ch, m.id)}>
                <div className="result-head">
                  <Avatar pub={m.a} size={20} />
                  <UserName pub={m.a} c={m.c} />
                  <span className="muted small">{fmtStamp(m.t, clock24)}</span>
                </div>
                <div className="muted small">{where(m.c, m.ch)}</div>
                <div className="result-body">
                  <Markdown text={m.text.slice(0, 400)} c={m.c} />
                </div>
              </div>
            ))
          ))}
        {(tab === 'saved' || tab === 'reminders') &&
          ((tab === 'saved' ? bookmarks : reminders).length === 0 ? (
            <Empty icon={tab === 'saved' ? I.bookmark : I.alarm} title={tab === 'saved' ? 'Nothing saved yet' : 'No reminders'}>
              {tab === 'saved' ? 'Right-click any message, then Save message.' : 'Right-click any message, then Remind me.'}
            </Empty>
          ) : (
            (tab === 'saved' ? bookmarks : reminders).map((b) => (
              <div key={b.id} className="result" onClick={() => app().jumpTo(b.c, b.ch, b.id)}>
                <div className="result-head">
                  <Avatar pub={b.a} size={20} />
                  <UserName pub={b.a} />
                  <span className="grow" />
                  {b.remindAt && <span className="pill warn">{new Date(b.remindAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>}
                  <IconButton icon={I.trash} title="Remove" size={15} onClick={(e) => { e.stopPropagation(); void app().unbookmark(b.id); }} />
                </div>
                <div className="muted small">{where(b.c, b.ch)}</div>
                <div className="result-body">{b.text}</div>
              </div>
            ))
          ))}
        {tab === 'scheduled' &&
          (!scheduled.length ? (
            <Empty icon={I.calendar} title="Nothing scheduled">Right-click the send button to send a message later.</Empty>
          ) : (
            scheduled.map((s) => (
              <div key={s.id} className="result">
                <div className="result-head">
                  <I.calendar size={14} />
                  <b>{new Date(s.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</b>
                  <span className="grow" />
                  <IconButton icon={I.trash} title="Cancel" size={15} onClick={() => void app().unschedule(s.id)} />
                </div>
                <div className="muted small">{where(s.c, s.ch)}</div>
                <div className="result-body">
                  <Markdown text={s.text} c={s.c} />
                </div>
              </div>
            ))
          ))}
      </div>
    </aside>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, set, toast, openModal } from '../../state/store';
import { app } from '../../core/app';
import { Modal, Button, Field, I, Toggle, ColorInput, Avatar, cls, pickFile, download, confirmDialog, CommunityIcon, fmtTime } from '../common';
import { Markdown } from '../markdown';
import { Embeds, MessageButtons } from '../chat/RichContent';
import { CodeEditor } from './CodeEditor';
import { BOT_TEMPLATES, type BotTemplate } from '../../bots/templates';
import { commandUsage, type BotFileExport, type BotView, type BotLog } from '../../core/bots';
import { prepareImage } from '../../core/media';
import { basePerms, sortedRoles, type CommunityState } from '@shared/engine';
import { P, PERM_INFO } from '@shared/perms';

const STATUS_TEXT: Record<BotView['status'], string> = { running: 'Running', starting: 'Starting', stopped: 'Stopped', crashed: 'Crashed' };

export function StatusPill({ status }: { status: BotView['status'] }) {
  return <span className={cls('bot-status', status)}>{STATUS_TEXT[status]}</span>;
}

/** Make a square avatar from an emoji on a gradient. */
export async function emojiAvatar(emoji: string, colors: { primary: string; accent: string }): Promise<Blob> {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, colors.primary);
  grad.addColorStop(1, colors.accent);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.font = '150px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(emoji, 128, 140);
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('canvas'))), 'image/png'));
}

async function createFromTemplate(t: BotTemplate) {
  const avatar = await emojiAvatar(t.emoji, t.colors).catch(() => null);
  const pub = await app().bots.create({ name: t.name, username: t.username, code: t.code, network: t.network, about: t.desc, colors: t.colors, avatar, template: t.id });
  await app().bots.setEnabled(pub, true);
  return pub;
}

export async function importBotFromFile() {
  const [f] = await pickFile('.celbot,.js,.mjs,.json,application/json,text/javascript');
  if (!f) return;
  try {
    if (f.size > 1024 * 1024) throw new Error('That file is too big to be a bot.');
    const file = app().bots.parseImport(await f.text(), f.name);
    openModal('import-bot', { file });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Settings tab: your bots
// ---------------------------------------------------------------------------

export function BotsTab() {
  const bots = useStore((s) => s.bots);
  const [picking, setPicking] = useState(bots.length === 0);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="settings-page">
      <h2>Bots</h2>
      <p className="muted">
        Make bots that answer slash commands, post embeds and buttons, greet people, moderate, keep score or call web APIs. Start from a template, write your own JavaScript, or import a <code>.celbot</code>{' '}
        file someone shared. Bots run on this device, in a sandbox, and are online while CelChat is open here (the desktop app can keep them running in the tray).
      </p>
      <div className="row gap mt">
        <Button onClick={() => setPicking(!picking)}>
          <I.plus size={16} /> New bot
        </Button>
        <Button kind="ghost" onClick={() => void importBotFromFile()}>
          <I.fileUp size={16} /> Import bot
        </Button>
      </div>
      {picking && (
        <div className="template-grid mt">
          {BOT_TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.id}
              className="template-card"
              disabled={!!busy}
              style={{ '--t1': t.colors.primary, '--t2': t.colors.accent } as React.CSSProperties}
              onClick={async () => {
                setBusy(t.id);
                try {
                  const pub = await createFromTemplate(t);
                  setPicking(false);
                  openModal('bot', { pub, tab: t.id === 'blank' ? 'code' : 'test' });
                } catch (e) {
                  toast((e as Error).message, 'error');
                } finally {
                  setBusy(null);
                }
              }}
            >
              <span className="template-emoji">{busy === t.id ? <span className="spinner" /> : t.emoji}</span>
              <span className="template-name">
                {t.name}
                {t.network && (
                  <span className="pill" title="Uses the internet">
                    <I.globe size={11} /> web
                  </span>
                )}
              </span>
              <span className="template-desc">{t.desc}</span>
            </button>
          ))}
        </div>
      )}
      <div className="field-label mt-lg">Your bots · {bots.length}</div>
      {!bots.length && <p className="muted small">No bots yet. Pick a template above.</p>}
      <div className="bot-list">
        {bots.map((b) => (
          <div key={b.pub} className="bot-row" onClick={() => openModal('bot', { pub: b.pub })}>
            <Avatar pub={b.pub} size={44} />
            <span className="bot-row-info">
              <span className="bot-row-name">
                {b.name} <StatusPill status={b.status} />
                {b.network && <I.globe size={13} className="muted" />}
              </span>
              <span className="muted small ellipsis">
                @{b.username} · {b.commands.length} command{b.commands.length === 1 ? '' : 's'} · {b.communities.length ? `in ${b.communities.length} communit${b.communities.length === 1 ? 'y' : 'ies'}` : 'not in a community yet'}
              </span>
              {b.error && <span className="bot-row-err small">{b.error}</span>}
            </span>
            <span className="row gap" onClick={(e) => e.stopPropagation()}>
              <Button small kind={b.status === 'running' ? 'ghost' : 'primary'} onClick={() => void app().bots.setEnabled(b.pub, b.status !== 'running')}>
                {b.status === 'running' ? (
                  <>
                    <I.stop size={13} /> Stop
                  </>
                ) : (
                  <>
                    <I.play size={13} /> Run
                  </>
                )}
              </Button>
              <Button small kind="subtle" onClick={() => openModal('bot', { pub: b.pub, tab: 'code' })}>
                <I.code size={14} /> Edit
              </Button>
            </span>
          </div>
        ))}
      </div>
      <div className="info-box mt-lg">
        <I.shieldOk size={16} />
        <span>
          Bot code runs in an isolated sandbox: it cannot see your keys, your files, your DMs or communities you have not added it to, and it has no internet unless you allow it. In a community it acts
          as a normal member: it can only do what its roles allow, and every peer checks that.
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bot editor
// ---------------------------------------------------------------------------

type EditorTab = 'code' | 'test' | 'console' | 'profile' | 'communities' | 'docs';

export function BotEditorModal({ pub, tab: initial }: { pub: string; tab?: string }) {
  const bot = useStore((s) => s.bots.find((b) => b.pub === pub));
  const [tab, setTab] = useState<EditorTab>((initial as EditorTab) ?? 'code');
  const [code, setCode] = useState(() => app().bots.records.get(pub)?.code ?? '');
  const [saved, setSaved] = useState(code);
  const dirty = code !== saved;
  const close = () => {
    if (dirty && !window.confirm('Discard your unsaved code changes?')) return;
    set({ modal: { kind: 'settings', props: { tab: 'bots' } } });
  };
  if (!bot) return null;
  const save = async () => {
    try {
      await app().bots.update(pub, { code });
      setSaved(code);
      if (bot.status !== 'running') await app().bots.setEnabled(pub, true);
      toast('Saved. The bot restarted with your changes.', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const tabs: { id: EditorTab; label: string; icon: keyof typeof I }[] = [
    { id: 'code', label: 'Code', icon: 'code' },
    { id: 'test', label: 'Test', icon: 'flask' },
    { id: 'console', label: 'Console', icon: 'terminal' },
    { id: 'communities', label: 'Communities', icon: 'users' },
    { id: 'profile', label: 'Profile & sharing', icon: 'user' },
    { id: 'docs', label: 'Docs', icon: 'book' },
  ];
  return (
    <Modal wide="full" className="settings bot-studio" onClose={close}>
      <div className="settings-layout">
        <nav className="settings-nav">
          <div className="bot-nav-head">
            <Avatar pub={pub} size={48} status />
            <div>
              <div className="bot-nav-name">{bot.name}</div>
              <div className="muted small">@{bot.username}</div>
              <StatusPill status={bot.status} />
            </div>
          </div>
          <div className="row gap bot-nav-actions">
            {bot.status === 'running' ? (
              <>
                <Button small kind="ghost" onClick={() => void app().bots.setEnabled(pub, false)}>
                  <I.stop size={13} /> Stop
                </Button>
                <Button small kind="ghost" onClick={() => app().bots.start(pub)} title="Restart">
                  <I.restart size={13} />
                </Button>
              </>
            ) : (
              <Button small onClick={() => void app().bots.setEnabled(pub, true)}>
                <I.play size={13} /> Run
              </Button>
            )}
          </div>
          {tabs.map((t) => {
            const Ico = I[t.icon];
            return (
              <button type="button" key={t.id} className={cls('settings-tab', tab === t.id && 'on')} onClick={() => setTab(t.id)}>
                <Ico size={15} /> {t.label}
                {t.id === 'code' && dirty && <span className="dot-unsaved" title="Unsaved changes" />}
              </button>
            );
          })}
          <div className="settings-group" />
          <button type="button" className="settings-tab" onClick={close}>
            <I.back size={15} /> All bots
          </button>
        </nav>
        <section className="settings-main">
          <button type="button" className="settings-close" onClick={close} title="Close (Esc)">
            <I.x size={20} />
          </button>
          {tab === 'code' && <CodeTab pub={pub} bot={bot} code={code} setCode={setCode} dirty={dirty} save={save} revert={() => setCode(saved)} />}
          {tab === 'test' && <TestTab pub={pub} bot={bot} />}
          {tab === 'console' && <ConsoleTab pub={pub} />}
          {tab === 'communities' && <CommunitiesTab pub={pub} bot={bot} />}
          {tab === 'profile' && <ProfileTab pub={pub} bot={bot} />}
          {tab === 'docs' && <BotDocs />}
        </section>
      </div>
    </Modal>
  );
}

function CodeTab({ pub, bot, code, setCode, dirty, save, revert }: { pub: string; bot: BotView; code: string; setCode: (s: string) => void; dirty: boolean; save: () => Promise<void>; revert: () => void }) {
  const logs = useStore((s) => s.botLogs[pub]);
  const recent = (logs ?? []).slice(-6);
  const errLine = useMemo(() => {
    const last = [...(logs ?? [])].reverse().find((l) => l.level === 'error');
    const m = last ? /bot\.js:(\d+)|\(line (\d+)\)/.exec(last.text) : null;
    return m ? Number(m[1] ?? m[2]) : null;
  }, [logs]);
  return (
    <div className="settings-page code-page">
      <div className="code-toolbar">
        <h2>Code</h2>
        <span className="muted small">{(code.length / 1024).toFixed(1)} KB · JavaScript · Ctrl+S saves and restarts</span>
        <span className="grow" />
        {dirty && (
          <Button small kind="ghost" onClick={revert}>
            Revert
          </Button>
        )}
        <Button small onClick={() => void save()} disabled={!dirty && bot.status === 'running'}>
          <I.play size={13} /> Save &amp; run
        </Button>
      </div>
      <CodeEditor value={code} onChange={setCode} onSave={() => void save()} errorLine={errLine} />
      <div className="mini-console">
        {recent.length ? recent.map((l, i) => <LogLine key={i} l={l} />) : <span className="muted small">Logs from console.log and errors show up here.</span>}
      </div>
    </div>
  );
}

function LogLine({ l }: { l: BotLog }) {
  const clock24 = useStore((s) => s.settings.chat.clock24);
  return (
    <div className={cls('log-line', l.level)}>
      <span className="log-time">{fmtTime(l.t, clock24)}</span>
      <span className="log-text">{l.text}</span>
    </div>
  );
}

function TestTab({ pub, bot }: { pub: string; bot: BotView }) {
  const lines = useStore((s) => s.botPlay[pub]);
  const me = useStore((s) => s.me);
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [lines?.length]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await app().bots.playMessage(pub, t);
  };
  const matches = text.startsWith('/') && !text.includes(' ') ? bot.commands.filter((c) => c.name.startsWith(text.slice(1).toLowerCase())) : [];
  return (
    <div className="settings-page test-page">
      <div className="code-toolbar">
        <h2>Test</h2>
        <span className="muted small">Talk to the bot here. Nothing leaves this device.</span>
        <span className="grow" />
        <Button small kind="ghost" onClick={() => app().bots.playClear(pub)}>
          Clear
        </Button>
      </div>
      {bot.status !== 'running' && (
        <div className="info-box warn">
          <I.alert size={16} />
          <span>
            The bot is {bot.status}.{' '}
            <button type="button" className="link" onClick={() => void app().bots.setEnabled(pub, true)}>
              Run it
            </button>{' '}
            to test.
          </span>
        </div>
      )}
      <div className="play-list" ref={list}>
        {!lines?.length && (
          <div className="play-empty muted">
            <I.flask size={28} />
            <p>Type a message or a command below.</p>
            <div className="row gap wrap center">
              {bot.commands.slice(0, 8).map((c) => (
                <button type="button" key={c.name} className="chip" onClick={() => setText('/' + c.name + ' ')}>
                  /{c.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {lines?.map((l) => (
          <div key={l.id} className={cls('play-msg', l.a === me && 'me')}>
            <Avatar pub={l.a} size={32} />
            <div className="play-body">
              <div className="play-head">
                <b>{l.a === me ? 'You' : bot.name}</b> {l.a !== me && <span className="bot-badge app">bot</span>}
                {l.edited && <span className="muted small"> (edited)</span>}
              </div>
              {l.text && (
                <div className="msg-body">
                  <Markdown text={l.text} />
                </div>
              )}
              {l.embeds.length > 0 && <Embeds embeds={l.embeds} />}
              {l.files.map((f) =>
                f.mime.startsWith('image/') ? (
                  <img key={f.url} src={f.url} alt={f.name} className="play-img" />
                ) : (
                  <a key={f.url} href={f.url} download={f.name} className="chip">
                    <I.file size={13} /> {f.name}
                  </a>
                ),
              )}
              {l.buttons.length > 0 && <MessageButtons buttons={l.buttons} onPress={(b) => app().bots.playPress(pub, l.id, b.id)} />}
              {l.reacts.length > 0 && (
                <div className="reacts">
                  {l.reacts.map((e) => (
                    <span key={e} className="react on">
                      <span className="react-e">{e}</span>
                      <span>1</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="play-compose">
        {matches.length > 0 && (
          <div className="play-sugg">
            {matches.slice(0, 6).map((c) => (
              <button type="button" key={c.name} onClick={() => setText('/' + c.name + ' ')}>
                <code>{commandUsage(c)}</code> <span className="muted">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <input
          value={text}
          placeholder={`Message ${bot.name}, e.g. /${bot.commands[0]?.name ?? 'hello'}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && matches.length) {
              e.preventDefault();
              setText('/' + matches[0].name + ' ');
            } else if (e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button onClick={() => void send()}>
          <I.send size={16} />
        </Button>
      </div>
    </div>
  );
}

function ConsoleTab({ pub }: { pub: string }) {
  const logs = useStore((s) => s.botLogs[pub]);
  const [level, setLevel] = useState<'all' | 'error'>('all');
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const shown = (logs ?? []).filter((l) => level === 'all' || l.level === 'error' || l.level === 'warn');
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [shown.length]);
  return (
    <div className="settings-page">
      <div className="code-toolbar">
        <h2>Console</h2>
        <span className="grow" />
        <button type="button" className={cls('chip', level === 'all' && 'accent')} onClick={() => setLevel('all')}>
          Everything
        </button>
        <button type="button" className={cls('chip', level === 'error' && 'accent')} onClick={() => setLevel('error')}>
          Problems
        </button>
        <Button small kind="ghost" onClick={() => app().bots.clearLog(pub)}>
          Clear
        </Button>
      </div>
      <div className="console" ref={box}>
        {shown.length ? shown.map((l, i) => <LogLine key={i} l={l} />) : <span className="muted small">Nothing logged yet.</span>}
      </div>
      <div className="field-label mt-lg">Stored data (bot.storage, encrypted on this device)</div>
      <div className="row gap">
        <Button small kind="ghost" onClick={async () => setData(await app().bots.storageSnapshot(pub))}>
          {data ? 'Refresh' : 'Show'}
        </Button>
        <Button
          small
          kind="danger"
          onClick={() =>
            confirmDialog({
              title: 'Clear this bot’s storage?',
              body: 'Everything it saved with bot.storage is deleted. Restart the bot afterwards.',
              confirm: 'Clear',
              danger: true,
              onConfirm: async () => {
                await app().bots.clearStorage(pub);
                setData({});
              },
            })
          }
        >
          Clear storage
        </Button>
      </div>
      {data && <pre className="storage-view">{JSON.stringify(data, null, 2)}</pre>}
    </div>
  );
}

function CommunitiesTab({ pub, bot }: { pub: string; bot: BotView }) {
  const states = useStore((s) => s.states);
  const me = useStore((s) => s.me);
  const [busy, setBusy] = useState<string | null>(null);
  const list = Object.values(states).filter((s): s is CommunityState => s?.kind === 'community' && !!s.members[me]);
  return (
    <div className="settings-page">
      <h2>Communities</h2>
      <p className="muted">
        Add the bot to communities you are in. It joins as a member with the community&rsquo;s default role; give it a role (Community settings, Members) for powers like managing messages or roles.
      </p>
      {!list.length && <p className="muted small">You are not in any community yet.</p>}
      {list.map((st) => {
        const inIt = !!st.members[pub];
        const canAdd = st.owner === me || st.joinPolicy === 'open' || (basePerms(st, me) & (P.CREATE_INVITE | P.ADMIN)) !== 0;
        const perms = inIt ? basePerms(st, pub) : 0;
        const roles = inIt
          ? sortedRoles(st)
              .filter((r) => st.members[pub].roles.includes(r.id))
              .map((r) => r.name)
          : [];
        const powers = PERM_INFO.filter((p) => !p.channel && p.key !== 'CHANGE_NICK' && p.key !== 'CREATE_INVITE' && (perms & P[p.key]) !== 0).map((p) => p.label);
        return (
          <div key={st.id} className="archive-card">
            <CommunityIcon c={st.id} name={st.name} icon={st.icon} size={36} />
            <span className="archive-info">
              <span>{st.name}</span>
              <span className="muted small">
                {inIt ? `Member${roles.length ? ' · roles: ' + roles.join(', ') : ''}${powers.length ? ' · can: ' + powers.join(', ') : ''}` : canAdd ? 'Not added' : 'You need the Create invites permission to add bots here'}
              </span>
            </span>
            {inIt ? (
              <Button
                small
                kind="ghost"
                busy={busy === st.id}
                onClick={async () => {
                  setBusy(st.id);
                  try {
                    await app().bots.removeFromCommunity(pub, st.id);
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Remove
              </Button>
            ) : (
              <Button
                small
                disabled={!canAdd}
                busy={busy === st.id}
                onClick={async () => {
                  setBusy(st.id);
                  try {
                    await app().bots.addToCommunity(pub, st.id);
                    if (bot.status !== 'running') await app().bots.setEnabled(pub, true);
                    toast(`${bot.name} joined ${st.name}`, 'success');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Add
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProfileTab({ pub, bot }: { pub: string; bot: BotView }) {
  const [name, setName] = useState(bot.name);
  const [username, setUsername] = useState(bot.username);
  const [about, setAbout] = useState(bot.about);
  const [colors, setColors] = useState(bot.colors);
  const [avatar, setAvatar] = useState<Blob | null | undefined>(undefined);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = name !== bot.name || username !== bot.username || about !== bot.about || colors.primary !== bot.colors.primary || colors.accent !== bot.colors.accent || avatar !== undefined;
  const save = async () => {
    setBusy(true);
    try {
      await app().bots.update(pub, { name, username, about, colors, avatar });
      setAvatar(undefined);
      toast('Profile saved', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const exportBot = async (withIdentity: boolean) => {
    const json = await app().bots.exportFile(pub, withIdentity);
    download(`${bot.username}${withIdentity ? '-with-identity' : ''}.celbot`, new Blob([json], { type: 'application/json' }));
  };
  return (
    <div className="settings-page">
      <h2>Profile &amp; sharing</h2>
      <div className="bot-profile-edit">
        <button
          type="button"
          className="bot-avatar-pick"
          title="Change avatar"
          onClick={async () => {
            const [f] = await pickFile('image/png,image/jpeg,image/gif,image/webp');
            if (!f) return;
            try {
              const blob = await prepareImage(f, 512, 8 * 1024 * 1024);
              setAvatar(blob);
              setAvatarUrl(URL.createObjectURL(blob));
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        >
          {avatarUrl ? <img src={avatarUrl} alt="" /> : <Avatar pub={pub} size={88} />}
          <span className="bot-avatar-edit">
            <I.image size={16} />
          </span>
        </button>
        <div className="grow">
          <Field label="Display name">
            <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Username" hint="What people type for /command@username when two bots share a command.">
            <input value={username} maxLength={32} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
          </Field>
        </div>
      </div>
      <Field label="About">
        <textarea rows={3} value={about} maxLength={1200} onChange={(e) => setAbout(e.target.value)} />
      </Field>
      <div className="row gap">
        <ColorInput label="Card color" value={colors.primary} onChange={(v) => setColors({ ...colors, primary: v.slice(0, 7) })} />
        <ColorInput label="Accent" value={colors.accent} onChange={(v) => setColors({ ...colors, accent: v.slice(0, 7) })} />
      </div>
      <div className="row gap mt">
        <Button onClick={() => void save()} disabled={!dirty} busy={busy}>
          Save profile
        </Button>
      </div>

      <div className="field-label mt-lg">Internet access</div>
      <Toggle
        on={bot.network}
        onChange={(v) => void app().bots.update(pub, { network: v }).catch((e) => toast(e.message, 'error'))}
        label="Can use the internet (https)"
        desc="Lets the bot call web APIs with fetch(). Requests come from this device, so those sites see your IP address, and the bot could send them anything it can read. Only turn this on for code you trust."
      />

      <div className="field-label mt-lg">Share</div>
      <p className="muted small">A .celbot file holds the code, name and avatar. Drop it in any chat: others get a card to review and import their own copy (a new bot with its own identity).</p>
      <div className="row gap">
        <Button kind="ghost" onClick={() => void exportBot(false)}>
          <I.download size={15} /> Export .celbot
        </Button>
        <Button
          kind="ghost"
          onClick={() =>
            confirmDialog({
              title: 'Export with identity?',
              body: 'This file includes the bot’s private key, so whoever imports it IS this bot (same member in your communities). Use it to move the bot to another device, keep it private, and do not run it on two devices at once or it will answer twice.',
              confirm: 'Export',
              onConfirm: () => exportBot(true),
            })
          }
        >
          <I.key size={15} /> Move to another device
        </Button>
      </div>

      <div className="field-label mt-lg">Danger zone</div>
      <Button
        kind="danger"
        onClick={() =>
          confirmDialog({
            title: `Delete ${bot.name}?`,
            body: 'It leaves every community it is in, and its code, identity and storage are deleted from this device. Export it first if you might want it back.',
            confirm: 'Delete bot',
            danger: true,
            onConfirm: async () => {
              await app().bots.remove(pub);
              set({ modal: { kind: 'settings', props: { tab: 'bots' } } });
            },
          })
        }
      >
        <I.trash size={15} /> Delete bot
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import review
// ---------------------------------------------------------------------------

export function ImportBotModal({ file }: { file: BotFileExport & { existing: boolean } }) {
  const [keep, setKeep] = useState(!!file.identity);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`Import ${file.name}`}
      subtitle="Read the code before you run it."
      wide
      footer={
        <>
          <Button kind="ghost" onClick={() => set({ modal: null })}>
            Cancel
          </Button>
          <Button
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const pub = await app().bots.importBot(sanitizeImport(file), keep);
                set({ modal: { kind: 'bot', props: { pub, tab: 'code' } } });
                toast(`Imported ${file.name}. It is not running yet: read the code, then press Run.`, 'success');
              } catch (e) {
                toast((e as Error).message, 'error');
                setBusy(false);
              }
            }}
          >
            Import
          </Button>
        </>
      }
    >
      <div className="import-head">
        {file.avatar ? <img src={file.avatar} alt="" className="import-avatar" /> : <span className="import-avatar fallback">🤖</span>}
        <div>
          <div className="bot-nav-name">{file.name}</div>
          <div className="muted small">
            @{file.username} · {(file.code.length / 1024).toFixed(1)} KB of code
          </div>
          {file.about && <div className="small mt-sm">{file.about}</div>}
        </div>
      </div>
      {file.network && (
        <div className="info-box warn mt">
          <I.globe size={16} />
          <span>This bot asks to use the internet. Imported bots start with it OFF; you can allow it later in its settings.</span>
        </div>
      )}
      {file.identity && (
        <div className="mt">
          <Toggle
            on={keep}
            onChange={setKeep}
            label={file.existing ? 'Replace your copy of this bot (same identity)' : 'Keep its identity (it is the same bot as on the other device)'}
            desc="Turn off to import it as a brand-new bot. Never run one identity on two devices at once."
          />
        </div>
      )}
      <div className="field-label mt">Code</div>
      <CodeEditor value={file.code} readOnly className="import-code" />
      <p className="muted small mt-sm">
        Bot code runs sandboxed. It can only act in communities you add it to, with the roles they give it. It never sees your keys, files, DMs or other communities.
      </p>
    </Modal>
  );
}

// make imported bots start offline-from-the-internet: the importer decides
export function sanitizeImport(f: BotFileExport): BotFileExport {
  return { ...f, network: false };
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

function Doc({ title, children, code }: { title: string; children?: React.ReactNode; code?: string }) {
  return (
    <div className="doc-block">
      <h3>{title}</h3>
      {children}
      {code && <CodeEditor value={code.trim()} readOnly className="doc-code" />}
    </div>
  );
}

export function BotDocs() {
  return (
    <div className="settings-page docs">
      <h2>Bot docs</h2>
      <p className="muted">
        A bot is plain JavaScript with a global <code>bot</code>. Every call returns a Promise, so use <code>await</code>. <code>console.log</code> goes to the Console tab.
      </p>
      <Doc
        title="Commands"
        code={`
bot.command('roll', 'Roll a die', ['sides:integer?'], async (ctx, { sides = 6 }) => {
  await ctx.reply('🎲 ' + (1 + Math.floor(Math.random() * sides)));
});

// argument types: word (default), text (rest of the line, must be last),
// number, integer, boolean, user, channel, role.  "name?" = optional.
bot.command('kick', { description: 'Kick someone', args: [
  { name: 'member', type: 'user' },
  { name: 'reason', type: 'text', optional: true },
] }, async (ctx, { member, reason }) => {
  if (!ctx.author.can('KICK')) return ctx.reply('You cannot kick.');
  await member.kick(reason);
});`}
      >
        <p>Commands show up in everyone&rsquo;s composer when they type <code>/</code>. Wrong arguments get an automatic usage reply.</p>
      </Doc>
      <Doc
        title="Events"
        code={`
bot.on('ready', () => console.log('started'));
bot.on('message', async (msg) => {          // every message the bot can see
  if (msg.author.bot) return;
  if (msg.mentionsMe) await msg.react('👋');
});
bot.on('memberJoin', async ({ user, community }) => { /* ... */ });
bot.on('memberLeave', async ({ user, community, reason }) => { /* 'leave' | 'kick' | 'ban' */ });
bot.on('reaction', async ({ emoji, on, user, message }) => { /* ... */ });`}
      />
      <Doc
        title="Messages, embeds, buttons, files"
        code={`
await ctx.reply('plain **markdown** text');
const sent = await ctx.send({
  text: 'Pick one',
  embeds: [{ title: 'Title', description: 'Body', color: '#5fd3b3',
             fields: [{ name: 'A', value: '1', inline: true }], footer: 'small print' }],
  buttons: [{ id: 'yes', label: 'Yes', style: 'success' },
            { id: 'docs', label: 'Docs', style: 'link', url: 'https://example.com' }],
  files: [{ name: 'hello.txt', data: 'hi!' }],
});
await sent.edit({ text: 'Updated' });   // also: sent.delete(), sent.react('🔥'), sent.pin()

bot.button('yes', async (press) => {    // or a prefix: bot.button('vote:', ...)
  await press.update({ text: press.user.mention + ' said yes' });
});`}
      >
        <p>
          Styles: <code>primary</code>, <code>secondary</code>, <code>success</code>, <code>danger</code>, <code>link</code>. An embed image is the name of an image file sent with the same message:{' '}
          <code>{"{ image: 'chart.png' }"}</code>.
        </p>
      </Doc>
      <Doc
        title="People, channels, roles"
        code={`
ctx.author.name; ctx.author.mention; ctx.author.roles; ctx.author.can('MANAGE_MESSAGES');
await member.timeout(600, 'reason');   // seconds
await member.addRole('Gamer');         // role name or id; also removeRole, hasRole
await member.ban('reason'); await member.kick(); await member.setNickname('Nick');
const ch = await ctx.community.channel('general');
await ch.send('Hello!');
const members = await ctx.community.members();
const roles = await ctx.community.roles();
const all = await bot.communities();`}
      >
        <p>Moderation needs the matching permission on the bot&rsquo;s role, and its highest role must be above the person&rsquo;s.</p>
      </Doc>
      <Doc
        title="Storage, timers, status"
        code={`
const n = await bot.storage.get('count', 0);   // JSON values, 1 MB per bot, encrypted
await bot.storage.set('count', n + 1);
await bot.storage.delete('count'); await bot.storage.keys();
bot.every(3600, async () => { /* hourly */ });  // minimum 5 seconds
bot.after(10, () => { /* once */ });
await bot.setStatus('Playing chess', '♟️');`}
      />
      <Doc
        title="The internet"
        code={`
// only when "Can use the internet" is on (Profile & sharing tab)
const r = await fetch('https://api.example.com/thing');
const data = await r.json();`}
      >
        <p>Bots have no network by default. When allowed, they can call https APIs only.</p>
      </Doc>
      <Doc title="Limits and how it works">
        <ul className="docs-list">
          <li>The bot runs on this device while CelChat is open: in a tab, the installed app, or the desktop app in the tray.</li>
          <li>It reacts to messages up to 2 minutes old, so a short disconnect is fine; older ones are skipped.</li>
          <li>Sending is rate limited (5 messages per 5 seconds per channel, 30 per 30 seconds overall).</li>
          <li>Its actions are signed with its own key and checked by every peer, like anyone&rsquo;s. It cannot do more than its roles allow.</li>
          <li>Code runs in a Web Worker inside a sandboxed iframe: no DOM, no access to CelChat&rsquo;s storage or your keys.</li>
        </ul>
      </Doc>
    </div>
  );
}

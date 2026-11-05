import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, set, chanKey, toast, openMenu } from '../../state/store';
import { app } from '../../core/app';
import { I, cls, Avatar, UserName, pickFile, Spinner } from '../common';
import { PROVIDER_INFO, type GifProvider, type GifResult } from '@shared/gifs';
import { CustomEmoji } from '../markdown';
import { EmojiPicker, loadEmoji, type EmojiEntry } from './EmojiPicker';
import { fmtBytes, fmtDuration } from '../../core/media';
import { channelPerms, isTimedOut, type ConvoState } from '@shared/engine';
import { P } from '@shared/perms';
import { LIMITS } from '@shared/limits';
import type { Attachment } from '@shared/ops';

interface Suggestion {
  key: string;
  label: React.ReactNode;
  sub?: string;
  insert: string;
  raw?: string;
}

export interface PendingFile {
  file: File;
  spoiler: boolean;
  url: string | null;
}

export function Composer({ c, ch, st, files, setFiles, placeholder }: { c: string; ch: string; st: ConvoState | null; files: PendingFile[]; setFiles: (f: PendingFile[]) => void; placeholder: string }) {
  const key = chanKey(c, ch);
  const me = useStore((s) => s.me);
  const replyTo = useStore((s) => s.replyTo[key] ?? null);
  const enterSends = useStore((s) => s.settings.chat.enterSends);
  const blockedPeer = useStore((s) => {
    const rec = s.convos[c];
    return rec?.type === 'dm' && rec.peer ? s.friends[rec.peer]?.state === 'blocked' : false;
  });
  const [text, setText] = useState(() => drafts.get(key) ?? '');
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<'emoji' | 'gif' | null>(null);
  const [recording, setRecording] = useState(false);
  const scheduledHere = useStore((s) => s.scheduled.filter((x) => x.c === c && x.ch === ch).length);
  const [sugg, setSugg] = useState<{ items: Suggestion[]; start: number; sel: number } | null>(null);
  const [emoji, setEmoji] = useState<EmojiEntry[] | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const mentionMap = useRef(new Map<string, string>());

  useEffect(() => {
    setText(drafts.get(key) ?? '');
    mentionMap.current.clear();
    setSugg(null);
    ta.current?.focus();
  }, [key]);
  useEffect(() => {
    drafts.set(key, text);
  }, [key, text]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
  }, [text]);

  // permissions
  let disabledReason: string | null = null;
  if (st?.kind === 'community') {
    if (!st.members[me]) disabledReason = 'You are not a member of this community.';
    else if (isTimedOut(st, me, Date.now())) disabledReason = `You are timed out until ${new Date(st.members[me].timeoutUntil!).toLocaleString()}.`;
    else if (!(channelPerms(st, me, ch, Date.now()) & P.SEND)) disabledReason = 'You do not have permission to send messages in this channel.';
  } else if (st?.kind === 'group' && !st.members[me]) disabledReason = 'You are no longer in this group.';
  if (blockedPeer) disabledReason = 'You blocked this user. Unblock them to send messages.';
  const canAttach = st?.kind === 'community' ? (channelPerms(st, me, ch) & P.ATTACH) !== 0 : true;
  const canPingAll = st?.kind === 'community' ? (channelPerms(st, me, ch) & P.MENTION_EVERYONE) !== 0 : false;

  const people = useMemo(() => {
    if (!st) return [];
    return Object.keys(st.members);
  }, [st]);

  const computeSuggestions = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)([@#:])([^\s@#:]{0,32})$/.exec(before);
    if (!m) return setSugg(null);
    const trig = m[2];
    const q = m[3].toLowerCase();
    const start = caret - m[3].length - 1;
    const a = app();
    let items: Suggestion[] = [];
    if (trig === '@') {
      items = people
        .map((pub) => ({ pub, name: a.nameOf(pub, st?.kind === 'community' ? c : undefined), uname: useStore.getState().profiles[pub]?.username ?? '' }))
        .filter((p) => !q || p.name.toLowerCase().includes(q) || p.uname.includes(q))
        .slice(0, 8)
        .map((p) => ({ key: p.pub, label: <span className="sugg-user"><Avatar pub={p.pub} size={22} /><UserName pub={p.pub} c={st?.kind === 'community' ? c : undefined} /></span>, sub: p.uname ? '@' + p.uname : '', insert: '@' + p.name, raw: `<@${p.pub}>` }));
      if (st?.kind === 'community') {
        for (const r of Object.values(st.roles)) {
          if (r.id === st.id || !(r.mentionable || canPingAll)) continue;
          if (q && !r.name.toLowerCase().includes(q)) continue;
          items.push({ key: r.id, label: <span style={{ color: r.color ?? undefined }}>@{r.name}</span>, sub: 'Role', insert: '@' + r.name, raw: `<@&${r.id}>` });
        }
        if (canPingAll) {
          for (const w of ['everyone', 'here']) if (!q || w.startsWith(q)) items.push({ key: w, label: '@' + w, sub: w === 'everyone' ? 'Notify every member' : 'Notify everyone online', insert: '@' + w });
        }
      }
    } else if (trig === '#' && st?.kind === 'community') {
      items = Object.values(st.channels)
        .filter((x) => x.type === 'text' && (!q || x.name.includes(q)) && channelPerms(st, me, x.id) & P.VIEW_CHANNEL)
        .slice(0, 8)
        .map((x) => ({ key: x.id, label: <span><I.hash size={14} /> {x.name}</span>, insert: '#' + x.name, raw: `<#${x.id}>` }));
    } else if (trig === ':' && q.length >= 2) {
      // community emoji first: they are yours to use anywhere
      for (const e of a.allEmoji()) {
        if (!e.name.includes(q) || items.length >= 5) continue;
        items.push({ key: e.c + e.name, label: <span className="sugg-user"><CustomEmoji name={e.name} hash={e.asset.hash} size={e.asset.size} /> :{e.name}:</span>, sub: e.community, insert: `:${e.name}:`, raw: e.token });
      }
      if (!emoji) {
        void loadEmoji().then(setEmoji);
      } else {
        items.push(
          ...emoji
            .filter((e) => e.codes.some((cd) => cd.startsWith(q)))
            .slice(0, 8 - items.length)
            .map((e) => ({ key: e.u, label: <span><span className="sugg-emoji">{e.u}</span> :{e.codes[0]}:</span>, insert: e.u })),
        );
      }
    }
    setSugg(items.length ? { items, start, sel: 0 } : null);
  };

  const accept = (s: Suggestion) => {
    const el = ta.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, sugg!.start);
    const after = text.slice(caret);
    const ins = s.insert + ' ';
    if (s.raw) mentionMap.current.set(s.insert, s.raw);
    const next = before + ins + after;
    setText(next);
    setSugg(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = before.length + ins.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const toRaw = (t: string) => {
    let out = t;
    const keys = [...mentionMap.current.keys()].sort((x, y) => y.length - x.length);
    for (const k of keys) out = out.split(k).join(mentionMap.current.get(k)!);
    return out;
  };

  const send = async () => {
    if (busy || disabledReason) return;
    const raw = toRaw(text).trim();
    if (!raw && !files.length) return;
    if (raw.length > LIMITS.messageChars) {
      toast(`Messages are limited to ${LIMITS.messageChars} characters (yours is ${raw.length}).`, 'error');
      return;
    }
    setBusy(true);
    try {
      await app().sendMessage(c, ch, raw, files.map((f) => f.file), replyTo?.id ?? null, files.map((f) => f.spoiler));
      setText('');
      drafts.delete(key);
      mentionMap.current.clear();
      files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
      setFiles([]);
      set((s) => ({ replyTo: { ...s.replyTo, [key]: null } }));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      requestAnimationFrame(() => ta.current?.focus());
    }
  };

  const addFiles = (list: File[]) => {
    if (!canAttach) {
      toast('You cannot attach files in this channel.', 'error');
      return;
    }
    const next = [...files];
    for (const f of list) {
      if (next.length >= LIMITS.attachmentsPerMessage) break;
      next.push({ file: f, spoiler: false, url: f.type.startsWith('image/') && f.type !== 'image/svg+xml' ? URL.createObjectURL(f) : null });
    }
    setFiles(next);
  };

  const editLast = () => {
    const list = useStore.getState().chans[key]?.list ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].a === me) return set({ editing: list[i].id });
  };

  if (disabledReason)
    return (
      <div className="composer disabled">
        <I.lock size={16} /> {disabledReason}
      </div>
    );

  if (recording)
    return (
      <div className="composer-wrap">
        <VoiceRecorder
          onCancel={() => setRecording(false)}
          onDone={async (file) => {
            setRecording(false);
            try {
              await app().sendMessage(c, ch, '', [file], replyTo?.id ?? null);
              set((s) => ({ replyTo: { ...s.replyTo, [key]: null } }));
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        />
        <TypingLine c={c} ch={ch} />
      </div>
    );

  return (
    <div className="composer-wrap">
      {scheduledHere > 0 && (
        <button type="button" className="scheduled-chip" onClick={() => set({ panel: 'inbox', modal: null })}>
          <I.calendar size={13} /> {scheduledHere} scheduled message{scheduledHere > 1 ? 's' : ''} here
        </button>
      )}
      {replyTo && (
        <div className="reply-bar">
          <span>
            Replying to <UserName pub={replyTo.a} c={st?.kind === 'community' ? c : undefined} />
          </span>
          <button type="button" onClick={() => set((s) => ({ replyTo: { ...s.replyTo, [key]: null } }))} title="Cancel reply">
            <I.x size={16} />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="tray">
          {files.map((f, i) => (
            <div key={i} className={cls('tray-item', f.spoiler && 'spoiler')}>
              {f.url ? <img src={f.url} alt="" /> : <span className="tray-file"><I.file size={26} /></span>}
              <span className="tray-name ellipsis">{f.file.name}</span>
              <span className="tray-size">{fmtBytes(f.file.size)}</span>
              <div className="tray-actions">
                <button type="button" title={f.spoiler ? 'Remove spoiler' : 'Mark as spoiler'} onClick={() => setFiles(files.map((x, j) => (j === i ? { ...x, spoiler: !x.spoiler } : x)))}>
                  {f.spoiler ? <I.eye size={14} /> : <I.eyeOff size={14} />}
                </button>
                <button
                  type="button"
                  title="Remove"
                  onClick={() => {
                    if (f.url) URL.revokeObjectURL(f.url);
                    setFiles(files.filter((_, j) => j !== i));
                  }}
                >
                  <I.trash size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        {canAttach && (
          <button type="button" className="comp-btn" title="Attach files (sent peer to peer)" onClick={async () => addFiles(await pickFile('*/*', true))}>
            <I.plus size={20} />
          </button>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={placeholder}
          maxLength={LIMITS.messageChars + 500}
          onChange={(e) => {
            setText(e.target.value);
            computeSuggestions(e.target.value, e.target.selectionStart);
            if (e.target.value) app().typing(c, ch);
          }}
          onPaste={(e) => {
            const fs = [...e.clipboardData.files];
            if (fs.length) {
              e.preventDefault();
              addFiles(fs);
            }
          }}
          onKeyDown={(e) => {
            if (sugg) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const d = e.key === 'ArrowDown' ? 1 : -1;
                setSugg({ ...sugg, sel: (sugg.sel + d + sugg.items.length) % sugg.items.length });
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                accept(sugg.items[sugg.sel]);
                return;
              }
              if (e.key === 'Escape') {
                setSugg(null);
                return;
              }
            }
            if (e.key === 'Enter' && (enterSends ? !e.shiftKey : e.ctrlKey)) {
              e.preventDefault();
              void send();
            } else if (e.key === 'ArrowUp' && !text) {
              e.preventDefault();
              editLast();
            } else if (e.key === 'Escape' && replyTo) set((s) => ({ replyTo: { ...s.replyTo, [key]: null } }));
          }}
          onBlur={() => setTimeout(() => setSugg(null), 150)}
        />
        <button type="button" className="comp-btn hide-narrow" title="Create a poll" onClick={() => set({ modal: { kind: 'poll', props: { c, ch } } })}>
          <I.poll size={19} />
        </button>
        {!text.trim() && !files.length && (
          <button type="button" className="comp-btn" title="Record a voice message" onClick={() => setRecording(true)}>
            <I.mic size={19} />
          </button>
        )}
        <button type="button" className={cls('comp-btn', picker === 'gif' && 'on')} title="GIFs" onClick={() => setPicker(picker === 'gif' ? null : 'gif')}>
          <I.gif size={20} />
        </button>
        <button type="button" className={cls('comp-btn', picker === 'emoji' && 'on')} title="Emoji" onClick={() => setPicker(picker === 'emoji' ? null : 'emoji')}>
          <I.smile size={20} />
        </button>
        <button
          type="button"
          className="comp-btn send"
          title="Send (right-click to send later)"
          onClick={() => void send()}
          onContextMenu={(e) => {
            const raw = toRaw(text).trim();
            if (!raw) return;
            const at = (d: Date) => () =>
              void app()
                .schedule(c, ch, raw, d.getTime(), replyTo?.id ?? null)
                .then(() => {
                  setText('');
                  drafts.delete(key);
                })
                .catch((err) => toast(err.message, 'error'));
            const inH = (h: number) => new Date(Date.now() + h * 3600_000);
            const tonight = new Date();
            tonight.setHours(20, 0, 0, 0);
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            openMenu(e, [
              { label: 'Send in 1 hour', onClick: at(inH(1)) },
              { label: 'Send in 3 hours', onClick: at(inH(3)) },
              ...(tonight.getTime() > Date.now() + 60_000 ? [{ label: 'Send tonight at 8 PM', onClick: at(tonight) }] : []),
              { label: 'Send tomorrow at 9 AM', onClick: at(tomorrow) },
              { label: 'Pick a time...', onClick: () => set({ modal: { kind: 'schedule', props: { c, ch, text: raw, reply: replyTo?.id ?? null } } }) },
            ]);
          }}
          disabled={busy || (!text.trim() && !files.length)}
        >
          {busy ? <span className="spinner" /> : <I.send size={18} />}
        </button>
        {sugg && (
          <div className="sugg">
            {sugg.items.map((s, i) => (
              <button type="button" key={s.key} className={cls('sugg-item', i === sugg.sel && 'on')} onMouseDown={(e) => { e.preventDefault(); accept(s); }}>
                {s.label}
                {s.sub && <span className="muted">{s.sub}</span>}
              </button>
            ))}
          </div>
        )}
        {picker === 'emoji' && (
          <div className="comp-pop">
            <EmojiPicker
              keepOpen
              onPick={(picked) => {
                // custom emoji show as :name: while typing and become their token on send
                const cm = /^<:([a-z0-9_]{2,32}):/.exec(picked);
                const e = cm ? `:${cm[1]}:` : picked;
                if (cm) mentionMap.current.set(e, picked);
                const el = ta.current;
                const pos = el?.selectionStart ?? text.length;
                setText(text.slice(0, pos) + e + text.slice(pos));
                requestAnimationFrame(() => {
                  el?.focus();
                  el?.setSelectionRange(pos + e.length, pos + e.length);
                });
              }}
              onClose={() => setPicker(null)}
            />
          </div>
        )}
        {picker === 'gif' && (
          <div className="comp-pop">
            <GifPicker
              onSend={async (att) => {
                setPicker(null);
                try {
                  await app().sendAttachmentRefs(c, ch, [att]);
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              }}
              onSearchPick={async (g) => {
                setPicker(null);
                try {
                  await app().sendGif(c, ch, g, replyTo?.id ?? null);
                  set((s) => ({ replyTo: { ...s.replyTo, [key]: null } }));
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              }}
              onUpload={async () => {
                setPicker(null);
                addFiles(await pickFile('image/gif,image/webp', true));
              }}
              onClose={() => setPicker(null)}
            />
          </div>
        )}
      </div>
      <TypingLine c={c} ch={ch} />
    </div>
  );
}

const drafts = new Map<string, string>();

/** Records a voice message with MediaRecorder (Opus in WebM where supported). */
function VoiceRecorder({ onCancel, onDone }: { onCancel: () => void; onDone: (f: File) => void }) {
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const rec = useRef<{ mr: MediaRecorder; chunks: Blob[]; stream: MediaStream; started: number; ctx: AudioContext } | null>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true } });
        const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
        const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(256);
        rec.current = { mr, chunks: [], stream, started: Date.now(), ctx };
        mr.ondataavailable = (e) => e.data.size && rec.current?.chunks.push(e.data);
        mr.start(250);
        timer = setInterval(() => {
          const s = (Date.now() - (rec.current?.started ?? Date.now())) / 1000;
          setSecs(s);
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 8));
          if (s >= 300) finish();
        }, 100);
      } catch {
        setErr('Microphone not available.');
      }
    })();
    return () => {
      if (timer) clearInterval(timer);
      cancelled.current = true;
      const r = rec.current;
      if (r) {
        if (r.mr.state !== 'inactive') r.mr.stop();
        r.stream.getTracks().forEach((t) => t.stop());
        void r.ctx.close();
      }
    };
  }, []);
  const finish = () => {
    const r = rec.current;
    if (!r || r.mr.state === 'inactive') return;
    const dur = (Date.now() - r.started) / 1000;
    r.mr.onstop = () => {
      const type = r.mr.mimeType || 'audio/webm';
      const blob = new Blob(r.chunks, { type: type.split(';')[0] });
      if (dur < 0.6) return onCancel();
      onDone(new File([blob], `voice-message-${dur.toFixed(1)}s.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type: type.split(';')[0] }));
    };
    r.mr.stop();
    r.stream.getTracks().forEach((t) => t.stop());
  };
  return (
    <div className="composer recorder">
      <button type="button" className="comp-btn" title="Discard" onClick={onCancel}>
        <I.trash size={18} />
      </button>
      {err ? (
        <span className="field-error grow">{err}</span>
      ) : (
        <>
          <span className="rec-dot" style={{ transform: `scale(${1 + level * 0.8})` }} />
          <span className="rec-time">{fmtDuration(secs)}</span>
          <span className="grow muted small">Recording a voice message. It is sent peer to peer like any file.</span>
        </>
      )}
      <button type="button" className="comp-btn send" title="Send voice message" onClick={finish} disabled={!!err}>
        <I.send size={18} />
      </button>
    </div>
  );
}

function GifPicker({ onSend, onSearchPick, onUpload, onClose }: { onSend: (a: Attachment) => void; onSearchPick: (g: GifResult) => void; onUpload: () => void; onClose: () => void }) {
  const favs = useStore((s) => s.settings.favoriteGifs);
  useStore((s) => s.settings.gifs);
  useStore((s) => s.hub.info);
  const source = app().gifSource();
  const [tab, setTab] = useState<'search' | 'favs'>(source ? 'search' : 'favs');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    setTimeout(() => window.addEventListener('mousedown', close), 0);
    return () => window.removeEventListener('mousedown', close);
  }, [onClose]);
  return (
    <div className="gif-picker" ref={ref}>
      <div className="gif-head">
        <div className="tabs inline flat">
          <button type="button" className={cls(tab === 'search' && 'on')} onClick={() => setTab('search')}>
            Search
          </button>
          <button type="button" className={cls(tab === 'favs' && 'on')} onClick={() => setTab('favs')}>
            Favorites
          </button>
        </div>
        <button type="button" className="chip" onClick={onUpload}>
          <I.upload size={14} /> Upload
        </button>
      </div>
      {tab === 'search' ? (
        source ? (
          <GifSearch provider={source.provider} onPick={onSearchPick} />
        ) : (
          <div className="muted pad small">
            GIF search needs a provider key (Tenor&rsquo;s API was shut down by Google in June 2026). Ask your hub operator to set <code className="md-inline">GIF_API_KEY</code>, or add your own free KLIPY or GIPHY key in{' '}
            <button type="button" className="link" onClick={() => { onClose(); useStore.setState({ modal: { kind: 'settings', props: { tab: 'chat' } } }); }}>
              Settings, then Chat
            </button>
            .
          </div>
        )
      ) : !favs.length ? (
        <div className="muted pad small">Star any GIF in chat (hover it, then the star) to keep it here. Favorites are sent peer to peer, with no search service involved.</div>
      ) : (
        <div className="gif-grid">
          {favs.map((g) => (
            <GifTile key={g.hash} g={g} onClick={() => onSend({ hash: g.hash, name: g.name, mime: g.mime, size: g.size, w: g.w, h: g.h, thumb: g.thumb })} />
          ))}
        </div>
      )}
    </div>
  );
}

const previewCache = new Map<string, string>();

function GifSearch({ provider, onPick }: { provider: GifProvider; onPick: (g: GifResult) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<GifResult[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  const load = async (query: string, pos: string | null) => {
    const my = ++seq.current;
    setBusy(true);
    setErr(null);
    try {
      const page = await app().searchGifs(query, pos);
      if (my !== seq.current) return;
      setItems((old) => (pos ? [...old, ...page.results] : page.results));
      setNext(page.next);
    } catch (e) {
      if (my === seq.current) setErr((e as Error).message);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };
  useEffect(() => {
    const t = setTimeout(() => void load(q, null), q ? 350 : 0);
    return () => clearTimeout(t);
  }, [q]);
  const info = PROVIDER_INFO[provider];
  return (
    <>
      <div className="gif-search">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={info.placeholder} maxLength={100} />
      </div>
      <div
        className="gif-grid"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (next && !busy && el.scrollTop + el.clientHeight > el.scrollHeight - 200) void load(q, next);
        }}
      >
        {items.map((g) => (
          <RemoteGif key={g.id} g={g} onClick={() => onPick(g)} />
        ))}
        {err && <div className="muted pad small gif-span">{err}</div>}
        {!err && !busy && !items.length && <div className="muted pad small gif-span">No GIFs found.</div>}
        {busy && <div className="gif-span center"><Spinner /></div>}
      </div>
      {info.attribution && <div className="gif-attrib">{info.attribution} · sent to the chat peer to peer</div>}
    </>
  );
}

/** Previews are fetched into blob URLs: the app's CSP never lets the page load remote images directly. */
function RemoteGif({ g, onClick }: { g: GifResult; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(previewCache.get(g.preview.url) ?? null);
  useEffect(() => {
    if (url) return;
    let alive = true;
    void app()
      .gifMedia(g.preview.url)
      .then((b) => {
        const u = URL.createObjectURL(b);
        previewCache.set(g.preview.url, u);
        if (alive) setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [g.preview.url, url]);
  return (
    <button type="button" className="gif-tile" onClick={onClick} title={g.title} style={{ aspectRatio: `${g.preview.w} / ${g.preview.h}` }}>
      {url ? <img src={url} alt={g.title} /> : <span className="gif-ph" />}
    </button>
  );
}

function GifTile({ g, onClick }: { g: { hash: string; name: string; thumb?: string; mime: string; size: number }; onClick: () => void }) {
  const url = useStore((s) => s.blobUrls[g.hash]);
  useEffect(() => {
    if (!url) void app().ensureBlob({ hash: g.hash, mime: g.mime, size: g.size }, { auto: false });
  }, [url, g.hash, g.mime, g.size]);
  return (
    <button type="button" className="gif-tile" onClick={onClick} title={g.name}>
      <img src={url ?? g.thumb} alt={g.name} />
    </button>
  );
}

function TypingLine({ c, ch }: { c: string; ch: string }) {
  const typing = useStore((s) => s.typing[chanKey(c, ch)]);
  const me = useStore((s) => s.me);
  const who = Object.keys(typing ?? {}).filter((p) => p !== me);
  if (!who.length) return <div className="typing" />;
  const names = who.map((p) => app().nameOf(p, c));
  const text = names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : names.length === 3 ? `${names.slice(0, 2).join(', ')} and ${names[2]} are typing` : 'Several people are typing';
  return (
    <div className="typing">
      <span className="typing-dots">
        <i />
        <i />
        <i />
      </span>
      <b>{text}</b>...
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useStore, set } from '../../state/store';
import { app } from '../../core/app';
import { I, IconButton, Avatar, UserName, Empty, Spinner, fmtStamp } from '../common';
import { Markdown } from '../markdown';
import { channelPerms, type Message } from '@shared/engine';
import { P } from '@shared/perms';

function ResultCard({ m, onJump, extra }: { m: Message; onJump: () => void; extra?: React.ReactNode }) {
  const clock24 = useStore((s) => s.settings.chat.clock24);
  const st = useStore((s) => s.states[m.c]);
  return (
    <div className="result" onClick={onJump}>
      <div className="result-head">
        <Avatar pub={m.a} size={20} />
        <UserName pub={m.a} c={st?.kind === 'community' ? m.c : undefined} />
        <span className="muted small">{fmtStamp(m.t, clock24)}</span>
        {st?.kind === 'community' && <span className="muted small">#{st.channels[m.ch]?.name}</span>}
        <span className="grow" />
        {extra}
      </div>
      <div className="result-body">
        {m.text ? <Markdown text={m.text.slice(0, 600)} c={m.c} /> : <i className="muted">{m.att.length} attachment(s)</i>}
      </div>
    </div>
  );
}

function jump(m: Message) {
  const rec = useStore.getState().convos[m.c];
  if (rec?.type === 'community') app().navigate({ kind: 'community', c: m.c, ch: m.ch });
  else app().navigate({ kind: 'dm', c: m.c });
  setTimeout(() => {
    const loaded = useStore.getState().chans[`${m.c}|${m.ch}`]?.list.some((x) => x.id === m.id);
    if (loaded) set({ jumpTo: m.id });
    else void loadUntil(m).then(() => set({ jumpTo: m.id }));
  }, 50);
}

async function loadUntil(m: Message) {
  for (let i = 0; i < 20; i++) {
    const cs = useStore.getState().chans[`${m.c}|${m.ch}`];
    if (!cs || cs.list.some((x) => x.id === m.id) || !cs.hasMore) return;
    await app().loadChannel(m.c, m.ch, true);
  }
}

export function PinsPanel({ c, ch }: { c: string; ch: string }) {
  const [pins, setPins] = useState<Message[] | null>(null);
  const st = useStore((s) => s.states[c]);
  const me = useStore((s) => s.me);
  const version = useStore((s) => s.chans[`${c}|${ch}`]?.list);
  useEffect(() => {
    void app().convos.pinned(c, ch).then(setPins);
  }, [c, ch, version]);
  const canManage = st?.kind === 'community' ? (channelPerms(st, me, ch) & P.MANAGE_MESSAGES) !== 0 : true;
  return (
    <aside className="panel">
      <div className="panel-head">
        <I.pin size={18} />
        <b>Pinned messages</b>
        <span className="grow" />
        <IconButton icon={I.x} title="Close" onClick={() => set({ panel: null })} />
      </div>
      <div className="panel-body">
        {!pins && <Spinner />}
        {pins && !pins.length && <Empty icon={I.pin} title="No pins yet">{canManage ? 'Pin important messages from their menu.' : 'Moderators can pin important messages here.'}</Empty>}
        {pins?.map((m) => (
          <ResultCard
            key={m.id}
            m={m}
            onJump={() => jump(m)}
            extra={canManage && <IconButton icon={I.pinOff} title="Unpin" onClick={(e) => { e.stopPropagation(); void app().pin(c, m.id, false).then(() => app().convos.pinned(c, ch).then(setPins)); }} size={16} />}
          />
        ))}
      </div>
    </aside>
  );
}

export function SearchPanel({ c }: { c: string }) {
  const st = useStore((s) => s.states[c]);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [has, setHas] = useState<'' | 'image' | 'file' | 'link' | 'video'>('');
  const [inCh, setInCh] = useState('');
  const [mentionsMe, setMentionsMe] = useState(false);
  const [results, setResults] = useState<Message[] | null>(null);
  const [busy, setBusy] = useState(false);
  const me = useStore((s) => s.me);
  const members = st ? Object.keys(st.members) : [];
  const run = async () => {
    setBusy(true);
    try {
      setResults(await app().search([c], { text: q, from: from || undefined, has: has || undefined, ch: inCh || undefined, mentions: mentionsMe ? me : undefined }));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!q && !from && !has && !mentionsMe) return setResults(null);
    const t = setTimeout(() => void run(), 250);
    return () => clearTimeout(t);
  }, [q, from, has, inCh, mentionsMe]);
  return (
    <aside className="panel">
      <div className="panel-head">
        <I.search size={18} />
        <b>Search</b>
        <span className="grow" />
        <IconButton icon={I.x} title="Close" onClick={() => set({ panel: null })} />
      </div>
      <div className="panel-filters">
        <input autoFocus placeholder="Search messages on this device" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="filter-row">
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">From anyone</option>
            {members.map((p) => (
              <option key={p} value={p}>
                {app().nameOf(p, st?.kind === 'community' ? c : undefined)}
              </option>
            ))}
          </select>
          <select value={has} onChange={(e) => setHas(e.target.value as typeof has)}>
            <option value="">Has anything</option>
            <option value="image">Has image</option>
            <option value="video">Has video</option>
            <option value="file">Has file</option>
            <option value="link">Has link</option>
          </select>
        </div>
        {st?.kind === 'community' && (
          <div className="filter-row">
            <select value={inCh} onChange={(e) => setInCh(e.target.value)}>
              <option value="">In any channel</option>
              {Object.values(st.channels)
                .filter((x) => x.type === 'text')
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    #{x.name}
                  </option>
                ))}
            </select>
            <label className="check">
              <input type="checkbox" checked={mentionsMe} onChange={(e) => setMentionsMe(e.target.checked)} /> Mentions me
            </label>
          </div>
        )}
      </div>
      <div className="panel-body">
        {busy && <Spinner />}
        {!busy && results && !results.length && <Empty icon={I.search} title="No results">Search only covers messages synced to this device.</Empty>}
        {!results && !busy && <div className="muted pad small">Search runs locally over the history stored on this device. Nothing is sent anywhere.</div>}
        {results?.map((m) => (
          <ResultCard key={m.id} m={m} onJump={() => jump(m)} />
        ))}
      </div>
    </aside>
  );
}

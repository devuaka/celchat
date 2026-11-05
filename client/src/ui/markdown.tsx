/**
 * Discord-flavoured markdown rendered straight to React elements. User text
 * never goes through innerHTML; only highlight.js output (which escapes its
 * input) is injected for code blocks.
 */
import { Fragment, useState, type ReactNode } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import lua from 'highlight.js/lib/languages/lua';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import markdownLang from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import { useStore, openProfile } from '../state/store';
import { app } from '../core/app';
import { confirmDialog, useBlobUrl } from './common';

const LANGS: Record<string, unknown> = {
  javascript, typescript, python, json, bash, css, xml, java, cpp, c, csharp, go, rust, sql, yaml, lua, php, ruby, kotlin, swift, diff, ini,
  markdown: markdownLang, powershell,
};
for (const [k, v] of Object.entries(LANGS)) hljs.registerLanguage(k, v as Parameters<typeof hljs.registerLanguage>[1]);
const ALIAS: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', html: 'xml', svg: 'xml', 'c++': 'cpp', cs: 'csharp', rs: 'rust', yml: 'yaml', md: 'markdown', ps1: 'powershell', ps: 'powershell', toml: 'ini', kt: 'kotlin', rb: 'ruby' };

interface Ctx {
  c?: string;
  me: string;
  k: number;
}

export function Markdown({ text, c, inlineOnly }: { text: string; c?: string; inlineOnly?: boolean }) {
  const me = useStore((s) => s.me);
  const ctx: Ctx = { c, me, k: 0 };
  if (inlineOnly) return <>{inline(text.replace(/\n+/g, ' '), ctx)}</>;
  return <>{blocks(text, ctx)}</>;
}

/** Emoji-only messages render big, like every chat app does. */
export function isJumbo(text: string) {
  const t = text.trim().replace(/<:[a-z0-9_]{2,32}:[0-9a-f]{64}:\d{1,7}>/g, '😀');
  if (!t || t.length > 40) return false;
  return /^(\p{Extended_Pictographic}|\p{Emoji_Component}|️|‍|\s)+$/u.test(t) && !/^[\d#*\s]+$/.test(t);
}

function blocks(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const joined = para.join('\n');
    out.push(
      <div className="md-p" key={ctx.k++}>
        {inline(joined, ctx)}
      </div>,
    );
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```([\w+#.-]*)\s*$/.exec(line) ?? /^```([\w+#.-]*)\s*(.*)$/.exec(line);
    if (fence) {
      // code block until closing fence
      const lang = fence[1];
      const body: string[] = [];
      const firstRest = fence[2];
      if (firstRest && firstRest.endsWith('```')) {
        flush();
        out.push(<CodeBlock key={ctx.k++} lang="" code={(lang ? lang + ' ' : '') + firstRest.slice(0, -3)} />);
        i++;
        continue;
      }
      if (firstRest) body.push(firstRest);
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (/^```\s*$/.test(lines[j]) || lines[j].endsWith('```')) {
          if (!/^```\s*$/.test(lines[j])) body.push(lines[j].slice(0, -3));
          closed = true;
          break;
        }
        body.push(lines[j]);
      }
      if (closed) {
        flush();
        out.push(<CodeBlock key={ctx.k++} lang={lang} code={body.join('\n')} />);
        i = j + 1;
        continue;
      }
    }
    if (/^>>> /.test(line)) {
      flush();
      const rest = [line.slice(4), ...lines.slice(i + 1)].join('\n');
      out.push(
        <blockquote className="md-quote" key={ctx.k++}>
          {blocks(rest, ctx)}
        </blockquote>,
      );
      break;
    }
    if (/^> ?/.test(line) && line.startsWith('>')) {
      flush();
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith('>') && !lines[i].startsWith('>>>')) {
        q.push(lines[i].replace(/^> ?/, ''));
        i++;
      }
      out.push(
        <blockquote className="md-quote" key={ctx.k++}>
          {blocks(q.join('\n'), ctx)}
        </blockquote>,
      );
      continue;
    }
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) {
      flush();
      const Tag = (`h${h[1].length + 2}`) as 'h3' | 'h4' | 'h5';
      out.push(
        <Tag className="md-h" key={ctx.k++}>
          {inline(h[2], ctx)}
        </Tag>,
      );
      i++;
      continue;
    }
    // tables: header row, |---| separator, body rows
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((x) => (x.startsWith(':') && x.endsWith(':') ? 'center' : x.endsWith(':') ? 'right' : 'left'));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]) && rows.length < 100) rows.push(cells(lines[i++]));
      out.push(
        <div className="md-table-wrap" key={ctx.k++}>
          <table className="md-table">
            <thead>
              <tr>
                {head.map((h, n) => (
                  <th key={n} style={{ textAlign: aligns[n] as 'left' }}>
                    {inline(h, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, n) => (
                    <td key={n} style={{ textAlign: aligns[n] as 'left' }}>
                      {inline(r[n] ?? '', ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^-# /.test(line)) {
      flush();
      out.push(
        <div className="md-sub" key={ctx.k++}>
          {inline(line.slice(3), ctx)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.) /.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.) /, ''));
        i++;
      }
      const L = ordered ? 'ol' : 'ul';
      out.push(
        <L className="md-list" key={ctx.k++}>
          {items.map((it, n) => (
            <li key={n}>{inline(it, ctx)}</li>
          ))}
        </L>,
      );
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const name = ALIAS[lang.toLowerCase()] ?? lang.toLowerCase();
  let html: string | null = null;
  try {
    if (name && hljs.getLanguage(name)) html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    else if (code.length < 20000) html = hljs.highlightAuto(code, Object.keys(LANGS)).value;
  } catch {
    html = null;
  }
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{name || 'code'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {/* highlight.js escapes the source text, so this is safe */}
      {html !== null ? <pre className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="hljs">{code}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

type Rule = { re: RegExp; render: (m: RegExpExecArray, ctx: Ctx) => ReactNode };

const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"').,!?:;\]]/;

const RULES: Rule[] = [
  { re: /``([^`]+?)``|`([^`\n]+?)`/, render: (m) => <code className="md-inline">{m[1] ?? m[2]}</code> },
  { re: /\|\|([\s\S]+?)\|\|/, render: (m, ctx) => <Spoiler>{inline(m[1], ctx)}</Spoiler> },
  { re: /\*\*\*([\s\S]+?)\*\*\*/, render: (m, ctx) => <strong><em>{inline(m[1], ctx)}</em></strong> },
  { re: /\*\*([\s\S]+?)\*\*/, render: (m, ctx) => <strong>{inline(m[1], ctx)}</strong> },
  { re: /__([\s\S]+?)__/, render: (m, ctx) => <u>{inline(m[1], ctx)}</u> },
  { re: /\*(?!\s)([^*\n]+?)\*/, render: (m, ctx) => <em>{inline(m[1], ctx)}</em> },
  { re: /(?<![\w])_(?!\s)([^_\n]+?)_(?![\w])/, render: (m, ctx) => <em>{inline(m[1], ctx)}</em> },
  { re: /~~([\s\S]+?)~~/, render: (m, ctx) => <s>{inline(m[1], ctx)}</s> },
  { re: /<:([a-z0-9_]{2,32}):([0-9a-f]{64}):(\d{1,7})>/, render: (m) => <CustomEmoji name={m[1]} hash={m[2]} size={Number(m[3])} /> },
  { re: /<@([0-9a-f]{64})>/, render: (m, ctx) => <UserMention pub={m[1]} ctx={ctx} /> },
  { re: /<@&([0-9a-zA-Z_-]{6,64})>/, render: (m, ctx) => <RoleMention id={m[1]} c={ctx.c} /> },
  { re: /<#([0-9a-zA-Z_-]{6,40})>/, render: (m, ctx) => <ChannelMention id={m[1]} c={ctx.c} /> },
  { re: /(?<![\w`])@(everyone|here)\b/, render: (m) => <span className="mention">@{m[1]}</span> },
  { re: /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/, render: (m, ctx) => <SafeLink href={m[2]} masked>{inline(m[1], ctx)}</SafeLink> },
  { re: new RegExp(URL_RE.source), render: (m) => <SafeLink href={m[0]}>{m[0]}</SafeLink> },
  { re: /\\([*_~`|\\<>#@])/, render: (m) => m[1] },
];

function inline(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let guard = 0;
  while (rest && guard++ < 2000) {
    let best: { idx: number; m: RegExpExecArray; rule: Rule } | null = null;
    for (const rule of RULES) {
      const m = rule.re.exec(rest);
      if (m && (best === null || m.index < best.idx)) best = { idx: m.index, m, rule };
      if (best?.idx === 0) break;
    }
    if (!best) {
      out.push(<Fragment key={ctx.k++}>{rest}</Fragment>);
      break;
    }
    if (best.idx > 0) out.push(<Fragment key={ctx.k++}>{rest.slice(0, best.idx)}</Fragment>);
    out.push(<Fragment key={ctx.k++}>{best.rule.render(best.m, ctx)}</Fragment>);
    rest = rest.slice(best.idx + best.m[0].length);
  }
  return out;
}

function Spoiler({ children }: { children: ReactNode }) {
  const always = useStore((s) => s.settings.chat.spoilers === 'always');
  const [open, setOpen] = useState(always);
  return (
    <span className={`spoiler ${open ? 'open' : ''}`} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
      {children}
    </span>
  );
}

/** Custom emoji travel as `<:name:hash:size>` and load peer to peer like any image. */
export function CustomEmoji({ name, hash, size, big }: { name: string; hash: string; size: number; big?: boolean }) {
  const url = useBlobUrl({ hash, size, mime: 'image/png' }, { auto: size <= 600 * 1024, publicAsset: true });
  return url ? <img className={`cemoji${big ? ' big' : ''}`} src={url} alt={`:${name}:`} title={`:${name}:`} draggable={false} /> : <span className="cemoji-ph" title={`:${name}:`}>:{name}:</span>;
}

/** reactions can be unicode or custom emoji tokens */
export function ReactionGlyph({ e }: { e: string }) {
  const m = /^<:([a-z0-9_]{2,32}):([0-9a-f]{64}):(\d{1,7})>$/.exec(e);
  return m ? <CustomEmoji name={m[1]} hash={m[2]} size={Number(m[3])} /> : <>{e}</>;
}

function UserMention({ pub, ctx }: { pub: string; ctx: Ctx }) {
  const name = useStore((s) => {
    void s.profiles[pub];
    return app().nameOf(pub, ctx.c);
  });
  return (
    <span className={`mention ${pub === ctx.me ? 'me' : ''}`} onClick={(e) => openProfile(e, pub, ctx.c)}>
      @{name}
    </span>
  );
}

function RoleMention({ id, c }: { id: string; c?: string }) {
  const role = useStore((s) => {
    const st = c ? s.states[c] : null;
    return st && st.kind === 'community' ? st.roles[id] : null;
  });
  return (
    <span className="mention role" style={role?.color ? { color: role.color, background: role.color + '22' } : undefined}>
      @{role?.name ?? 'deleted-role'}
    </span>
  );
}

function ChannelMention({ id, c }: { id: string; c?: string }) {
  const ch = useStore((s) => {
    const st = c ? s.states[c] : null;
    return st && st.kind === 'community' ? st.channels[id] : null;
  });
  return (
    <span className="mention channel" onClick={() => c && ch && app().navigate({ kind: 'community', c, ch: id })}>
      #{ch?.name ?? 'unknown-channel'}
    </span>
  );
}

function SafeLink({ href, children, masked }: { href: string; children: ReactNode; masked?: boolean }) {
  let safe = '';
  try {
    const u = new URL(href);
    if (u.protocol === 'http:' || u.protocol === 'https:') safe = u.href;
  } catch {
    safe = '';
  }
  if (!safe) return <>{children}</>;
  const invite = app().parseInvite(safe);
  const isInvite = invite && safe.includes('#/join/');
  return (
    <a
      className="md-link"
      href={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={safe}
      onClick={(e) => {
        if (isInvite) {
          e.preventDefault();
          void app().joinByInvite(safe).catch(() => undefined);
          return;
        }
        if (masked) {
          e.preventDefault();
          confirmDialog({
            title: 'Leaving CelChat',
            body: (
              <>
                This link goes to <b className="break">{safe}</b>. Open it?
              </>
            ),
            confirm: 'Open link',
            onConfirm: () => void window.open(safe, '_blank', 'noopener,noreferrer'),
          });
        }
      }}
    >
      {children}
    </a>
  );
}

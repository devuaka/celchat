import { useEffect, useMemo, useRef } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import { cls } from '../common';

hljs.registerLanguage('javascript', javascript);

/** A small code editor: a transparent textarea over highlight.js output, with line numbers. */
export function CodeEditor({ value, onChange, onSave, readOnly, errorLine, className }: { value: string; onChange?: (v: string) => void; onSave?: () => void; readOnly?: boolean; errorLine?: number | null; className?: string }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const html = useMemo(() => hljs.highlight(value + '\n', { language: 'javascript', ignoreIllegals: true }).value, [value]);
  const lines = useMemo(() => value.split('\n').length, [value]);

  const sync = () => {
    const t = ta.current;
    if (!t) return;
    if (pre.current) {
      pre.current.scrollTop = t.scrollTop;
      pre.current.scrollLeft = t.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = t.scrollTop;
  };
  useEffect(sync, [value]);

  const edit = (next: string, selStart: number, selEnd = selStart) => {
    onChange?.(next);
    requestAnimationFrame(() => {
      const t = ta.current;
      if (!t) return;
      t.selectionStart = selStart;
      t.selectionEnd = selEnd;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    const { selectionStart: s, selectionEnd: en } = t;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (readOnly) return;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (s === en && !e.shiftKey) return edit(value.slice(0, s) + '  ' + value.slice(en), s + 2);
      // indent / outdent every selected line
      const blockEnd = value.indexOf('\n', en - (en > s && value[en - 1] === '\n' ? 1 : 0));
      const end = blockEnd === -1 ? value.length : blockEnd;
      const block = value.slice(lineStart, end).split('\n');
      const changed = block.map((l) => (e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l));
      const next = value.slice(0, lineStart) + changed.join('\n') + value.slice(end);
      const delta = changed.join('\n').length - block.join('\n').length;
      const firstDelta = e.shiftKey ? changed[0].length - block[0].length : 2;
      return edit(next, Math.max(lineStart, s + firstDelta), en + delta);
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const line = value.slice(lineStart, s);
      const indent = /^\s*/.exec(line)![0];
      const opens = /[{([]\s*$/.test(line);
      const closes = /^\s*[})\]]/.test(value.slice(en));
      if (opens && closes) {
        const ins = '\n' + indent + '  ' + '\n' + indent;
        return edit(value.slice(0, s) + ins + value.slice(en), s + indent.length + 3);
      }
      const ins = '\n' + indent + (opens ? '  ' : '');
      return edit(value.slice(0, s) + ins + value.slice(en), s + ins.length);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      const blockEnd = value.indexOf('\n', en);
      const end = blockEnd === -1 ? value.length : blockEnd;
      const block = value.slice(lineStart, end).split('\n');
      const allCommented = block.every((l) => /^\s*\/\//.test(l) || !l.trim());
      const changed = block.map((l) => (allCommented ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.trim() ? l.replace(/^(\s*)/, '$1// ') : l));
      const next = value.slice(0, lineStart) + changed.join('\n') + value.slice(end);
      return edit(next, lineStart, lineStart + changed.join('\n').length);
    }
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    if (pairs[e.key] && s !== en) {
      e.preventDefault();
      return edit(value.slice(0, s) + e.key + value.slice(s, en) + pairs[e.key] + value.slice(en), s + 1, en + 1);
    }
  };

  return (
    <div className={cls('code-editor', readOnly && 'readonly', className)}>
      <div className="code-gutter" ref={gutter} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={cls(errorLine === i + 1 && 'err')}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="code-area">
        <pre ref={pre} className="code-hl" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
        <textarea
          ref={ta}
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          readOnly={readOnly}
          wrap="off"
          aria-label="Bot code"
          onChange={(e) => onChange?.(e.target.value)}
          onScroll={sync}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}

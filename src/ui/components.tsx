import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ItemState } from '../core/types';

// Icons (inline, stroke-based) ------------------------------------------------------------------------

const paths: Record<string, string> = {
  logo: '',
  dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  items: 'M4 6h16M4 12h16M4 18h10',
  assess: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  disagree: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  reliability: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  export: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.2l2.1-1.6-2-3.4-2.5 1a7.6 7.6 0 00-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 00-2 1.2l-2.5-1-2 3.4 2.1 1.6a7.4 7.4 0 000 2.4l-2.1 1.6 2 3.4 2.5-1a7.6 7.6 0 002 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 002-1.2l2.5 1 2-3.4-2.1-1.6c.1-.4.1-.8.1-1.2z',
  audit: 'M12 8v4l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  guide: 'M4 19.5A2.5 2.5 0 016.5 17H20V3H6.5A2.5 2.5 0 004 5.5v14zM20 17v4H6.5',
  team: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2m22 0v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8M13 7a4 4 0 11-8 0 4 4 0 018 0z',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  alert: 'M12 9v4m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z',
  info: 'M12 16v-4m0-4h.01M12 3a9 9 0 100 18 9 9 0 000-18z',
  clock: 'M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  up: 'M12 19V5m-6 6l6-6 6 6',
  flag: 'M4 22V4m0 0h13l-2 4 2 4H4',
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7l1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2l-1.4-1.4M12 17a5 5 0 100-10 5 5 0 000 10z',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 21V9m0 0l-4 4m4-4l4 4M4 7V5a2 2 0 012-2h12a2 2 0 012 2v2',
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
  lock: 'M6 11V8a6 6 0 1112 0v3M5 11h14v10H5z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zm11 3a3 3 0 100-6 3 3 0 000 6z',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z',
  out: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4m7 14l5-5-5-5m5 5H9',
};

export function Icon({ name, size = 16, title }: { name: keyof typeof paths | string; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={paths[name] ?? paths.info} />
    </svg>
  );
}

/** Two overlapping circles: separate judgments, a shared region of agreement. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="12" cy="16" r="9" fill="none" stroke="var(--accent)" strokeWidth="2.4" />
      <circle cx="20" cy="16" r="9" fill="none" stroke="var(--series-3)" strokeWidth="2.4" />
      <path d="M16 8.6a9 9 0 010 14.8 9 9 0 010-14.8z" fill="var(--accent)" opacity="0.85" />
    </svg>
  );
}

// Status ---------------------------------------------------------------------------------------------

export const STATE_LABEL: Record<ItemState, string> = {
  unassigned: 'Unassigned',
  awaiting: 'Awaiting judgments',
  in_progress: 'In progress',
  agreed: 'Agreed',
  disagreement: 'Disagreement',
  proposed: 'Resolution proposed',
  escalated: 'Escalated',
  resolved: 'Resolved',
};
const STATE_ICON: Record<ItemState, string> = { unassigned: 'clock', awaiting: 'clock', in_progress: 'clock', agreed: 'check', disagreement: 'disagree', proposed: 'info', escalated: 'flag', resolved: 'check' };
export const STATE_COLOR: Record<ItemState, string> = {
  unassigned: 'var(--surface-3)', awaiting: 'var(--line-strong)', in_progress: 'var(--seq-300)', agreed: 'var(--good)', disagreement: 'var(--critical)', proposed: 'var(--warning)', escalated: 'var(--serious)', resolved: 'var(--series-7)',
};

export function StateBadge({ state }: { state: ItemState }) {
  return (
    <span className={`badge s-${state}`}>
      <Icon name={STATE_ICON[state]} size={12} />
      {STATE_LABEL[state]}
    </span>
  );
}

// Building blocks ------------------------------------------------------------------------------------------

export function Tile({ label, value, sub, tone, help }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'accent' | 'alert'; help?: string }) {
  return (
    <div className={`tile ${tone ?? ''}`}>
      <div className="label">
        {label}
        {help && <Help text={help} />}
      </div>
      <div className="value num">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Help({ text }: { text: string }) {
  return (
    <span className="muted" title={text} aria-label={text} role="note" tabIndex={0} style={{ display: 'inline-flex', cursor: 'help' }}>
      <Icon name="info" size={13} />
    </span>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}>
      <span style={{ width: `${v * 100}%` }} />
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'good'; children: ReactNode }) {
  const icon = tone === 'good' ? 'check' : tone === 'info' ? 'info' : 'alert';
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '36px 18px' }}>
      <h3>{title}</h3>
      {children && <div className="ink2">{children}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Data table: sortable, filterable by the caller, paginated ---------------------------------------------------

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  value?: (row: T) => string | number;
  num?: boolean;
  width?: number | string;
}

export function DataTable<T>({ rows, columns, pageSize = 25, onRow, rowKey, empty = 'Nothing to show.' }: { rows: T[]; columns: Column<T>[]; pageSize?: number; onRow?: (r: T) => void; rowKey: (r: T) => string; empty?: string }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.value) return rows;
    const v = col.value;
    return rows.slice().sort((a, b) => {
      const x = v(a);
      const y = v(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir;
    });
  }, [rows, sort, columns]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const p = Math.min(page, pages - 1);
  useEffect(() => setPage(0), [rows.length]);
  const view = sorted.slice(p * pageSize, (p + 1) * pageSize);
  return (
    <div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.num ? 'num' : ''} style={{ width: c.width }} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                  {c.value ? (
                    <button onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}>
                      {c.label}
                      {sort?.key === c.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {empty}
                </td>
              </tr>
            )}
            {view.map((r) => (
              <tr key={rowKey(r)} className={onRow ? 'clickable' : ''} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => e.key === 'Enter' && onRow(r) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>
                    {c.render ? c.render(r) : c.value ? String(c.value(r)) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          <span className="num">
            {p * pageSize + 1} to {Math.min((p + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <button className="btn sm" onClick={() => setPage(p - 1)} disabled={p === 0} aria-label="Previous page">
            <Icon name="left" size={14} />
          </button>
          <button className="btn sm" onClick={() => setPage(p + 1)} disabled={p >= pages - 1} aria-label="Next page">
            <Icon name="right" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

// Markdown (safe subset: escapes HTML first) -------------------------------------------------------------------

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s: string) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*$/.test(l)) {
      i++;
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const n = Math.min(h[1].length + 1, 4);
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }
    if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let t = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) t += ' ' + lines[i++].trim();
        items.push(`<li>${inline(t)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^\|.*\|\s*$/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

export function Markdown({ text, className = 'doc' }: { text: string; className?: string }) {
  const html = useMemo(() => markdownToHtml(text ?? ''), [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Plain text with paragraphs preserved (for imported item text that may contain markdown). */
export function ItemText({ text }: { text: string }) {
  return <Markdown text={text} />;
}

export function useStableId(prefix: string) {
  return `${prefix}-${useId().replace(/:/g, '')}`;
}

export function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function readFileText(file: File): Promise<string> {
  return file.text();
}

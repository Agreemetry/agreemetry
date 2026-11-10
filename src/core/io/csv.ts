/** RFC 4180 CSV reading and writing (quoted fields, embedded commas, quotes and newlines, BOM). */

export function parseCsv(text: string, delimiter?: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === d) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function sniffDelimiter(text: string): string {
  const head = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : text.length);
  const counts: [string, number][] = [',', ';', '\t', '|'].map((c) => [c, head.split(c).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export function csvToObjects(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const raw = parseCsv(text);
  if (raw.length === 0) return { columns: [], rows: [] };
  const columns = raw[0].map((c, i) => c.trim() || `column_${i + 1}`);
  const rows = raw.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])));
  return { columns, rows };
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(';');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? Array.from(rows.reduce((s, r) => { for (const k of Object.keys(r)) s.add(k); return s; }, new Set<string>()));
  const esc = (s: string) => (/[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [cols.map(esc).join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(cell(r[c]))).join(','));
  return lines.join('\r\n') + '\r\n';
}

export { cell as csvCell };

/**
 * Item import: read CSV, Excel or JSON, map columns, validate, and build items that keep every original
 * field unchanged.
 */
import type { ContextDocument, FieldValue, Item } from '../types';
import { csvToObjects } from './csv';
import { nowIso, uid } from '../util';

export interface ParsedTable {
  columns: string[];
  rows: Record<string, FieldValue>[];
  sheet?: string;
  sheets?: string[];
}

export async function parseFile(file: File, sheet?: string): Promise<ParsedTable> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) return parseJson(await file.text());
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.ods')) return parseWorkbook(await file.arrayBuffer(), sheet);
  return csvToObjects(await file.text());
}

export function parseJson(text: string): ParsedTable {
  const data = JSON.parse(text) as unknown;
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : null;
  if (!rows) throw new Error('JSON must be an array of objects or an object with an "items" array.');
  const objs = rows.filter((r): r is Record<string, FieldValue> => !!r && typeof r === 'object' && !Array.isArray(r));
  const columns = Array.from(objs.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set<string>()));
  return { columns, rows: objs };
}

export async function parseWorkbook(buf: ArrayBuffer, sheet?: string): Promise<ParsedTable> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const name = sheet && wb.SheetNames.includes(sheet) ? sheet : wb.SheetNames[0];
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json<Record<string, FieldValue>>(ws, { defval: '', raw: false });
  const header = (XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, blankrows: false })[0] ?? []).map((c, i) => String(c ?? '').trim() || `column_${i + 1}`);
  return { columns: header, rows, sheet: name, sheets: wb.SheetNames };
}

export interface ColumnMapping {
  idColumn: string;
  batchColumn?: string;
  categoryColumn?: string;
  /** Columns that must not be empty. */
  requiredColumns: string[];
  /** Columns kept as item fields; default all. */
  keepColumns?: string[];
  /** Batch used when no batch column is mapped. */
  defaultBatch?: string;
}

export interface ValidationIssue {
  row: number;
  column?: string;
  level: 'error' | 'warning';
  message: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  validRows: number;
  duplicateIds: string[];
  existingIds: string[];
  missingIds: number;
  emptyRequired: number;
}

export function validateRows(t: ParsedTable, map: ColumnMapping, existingExternalIds: Set<string>): ValidationReport {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, number>();
  const dup = new Set<string>();
  const existing = new Set<string>();
  let missingIds = 0;
  let emptyRequired = 0;
  if (!t.columns.includes(map.idColumn)) issues.push({ row: 0, column: map.idColumn, level: 'error', message: `Identifier column "${map.idColumn}" is not in the file.` });
  for (const c of map.requiredColumns) if (!t.columns.includes(c)) issues.push({ row: 0, column: c, level: 'error', message: `Required column "${c}" is not in the file.` });
  t.rows.forEach((r, i) => {
    const rowNo = i + 2; // header is row 1
    const id = String(r[map.idColumn] ?? '').trim();
    if (!id) {
      missingIds++;
      issues.push({ row: rowNo, column: map.idColumn, level: 'error', message: 'Missing identifier.' });
    } else {
      if (seen.has(id)) {
        dup.add(id);
        issues.push({ row: rowNo, column: map.idColumn, level: 'error', message: `Duplicate identifier "${id}" (first on row ${seen.get(id)}).` });
      } else seen.set(id, rowNo);
      if (existingExternalIds.has(id)) {
        existing.add(id);
        issues.push({ row: rowNo, column: map.idColumn, level: 'error', message: `Identifier "${id}" already exists in this project.` });
      }
    }
    for (const c of map.requiredColumns) {
      const v = r[c];
      if (v === null || v === undefined || String(v).trim() === '') {
        emptyRequired++;
        issues.push({ row: rowNo, column: c, level: 'error', message: `Empty required value in "${c}".` });
      }
    }
    for (const c of t.columns) {
      const v = r[c];
      if (typeof v === 'string' && v.length > 200_000) issues.push({ row: rowNo, column: c, level: 'warning', message: `Very long value in "${c}" (${v.length} characters).` });
      if (typeof v === 'string' && /�/.test(v)) issues.push({ row: rowNo, column: c, level: 'warning', message: `"${c}" contains replacement characters; check the file encoding (UTF-8 expected).` });
    }
  });
  const badRows = new Set(issues.filter((x) => x.level === 'error' && x.row > 0).map((x) => x.row));
  const fileErrors = issues.some((x) => x.level === 'error' && x.row === 0);
  return { issues, validRows: fileErrors ? 0 : t.rows.length - badRows.size, duplicateIds: [...dup], existingIds: [...existing], missingIds, emptyRequired };
}

export function buildItems(projectId: string, t: ParsedTable, map: ColumnMapping, startSeq: number, report: ValidationReport): Item[] {
  const bad = new Set(report.issues.filter((x) => x.level === 'error' && x.row > 0).map((x) => x.row));
  const keep = map.keepColumns ?? t.columns;
  const at = nowIso();
  const out: Item[] = [];
  t.rows.forEach((r, i) => {
    if (bad.has(i + 2)) return;
    const fields: Record<string, FieldValue> = {};
    for (const c of keep) fields[c] = r[c] ?? '';
    out.push({
      id: uid('it'),
      projectId,
      externalId: String(r[map.idColumn]).trim(),
      batch: map.batchColumn ? String(r[map.batchColumn] ?? '') || (map.defaultBatch ?? 'batch 1') : map.defaultBatch ?? 'batch 1',
      category: map.categoryColumn ? String(r[map.categoryColumn] ?? '') : '',
      fields,
      importedAt: at,
      seq: startSeq + out.length,
    });
  });
  return out;
}

/** Context documents (shared reference text, keyed by an item field) from a table with key, title and body columns. */
export function buildContexts(projectId: string, t: ParsedTable, keyCol: string, titleCol: string, bodyCol: string): ContextDocument[] {
  return t.rows
    .filter((r) => String(r[keyCol] ?? '').trim())
    .map((r) => ({ projectId, key: String(r[keyCol]).trim(), title: String(r[titleCol] ?? r[keyCol]), body: String(r[bodyCol] ?? '') }));
}

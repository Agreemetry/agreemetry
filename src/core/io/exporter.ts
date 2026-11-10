/**
 * Analysis-ready exports. Every table is tidy (one row per observation, one column per variable),
 * uses stable codes with labels in the data dictionary, leaves missing values empty, and identifies
 * adjudicators by project pseudonym unless names are explicitly requested.
 */
import type { ProjectArchive, ProjectData, RatingValue, Variable } from '../types';
import { analyzeProject, compareReferences, pseudonyms, type VariableReliability } from '../analysis';
import { computeAllStatuses, isItemDisclosed, originalSubmission, type ItemStatus } from '../workflow';
import { toCsv } from './csv';
import { fmt, nowIso } from '../util';

export type Table = { name: string; description: string; columns: string[]; rows: Record<string, unknown>[] };

export interface ExportOptions {
  includeNames?: boolean;
  bootstrapReps?: number;
}

function enc(v: RatingValue | undefined): string | number | null {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) return [...v].sort().join(';');
  return v;
}

function labelOf(variable: Variable | undefined, v: RatingValue | undefined): string {
  if (!variable || v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return v.map((x) => variable.categories?.find((c) => c.value === x)?.label ?? x).join('; ');
  return variable.categories?.find((c) => c.value === String(v))?.label ?? String(v);
}

function flat(fields: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[`${prefix}${k}`] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  return out;
}

export function buildTables(data: ProjectData, opts: ExportOptions = {}): { tables: Table[]; statuses: Map<string, ItemStatus>; reliability: VariableReliability[] } {
  const { project } = data;
  const vars = project.config.variables;
  const statuses = computeAllStatuses(data);
  const names = pseudonyms(data);
  const userName = new Map(data.users.map((u) => [u.id, u.displayName]));
  const who = (id?: string) => (id ? (opts.includeNames ? `${names.get(id) ?? ''} ${userName.get(id) ?? ''}`.trim() : names.get(id) ?? 'non-member') : '');
  const items = data.items.slice().sort((a, b) => a.seq - b.seq);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const fieldCols = Array.from(items.reduce((s, i) => { Object.keys(i.fields).forEach((k) => s.add(k)); return s; }, new Set<string>()));
  const raters = Array.from(new Set(data.memberships.map((m) => m.pseudonym))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const tItems: Table = {
    name: 'items', description: 'Imported items with every original field unchanged.',
    columns: ['item_id', 'external_id', 'batch', 'category', 'seq', 'imported_at', ...fieldCols.map((c) => `field_${c}`)],
    rows: items.map((i) => ({ item_id: i.id, external_id: i.externalId, batch: i.batch, category: i.category, seq: i.seq, imported_at: i.importedAt, ...flat(i.fields, 'field_') })),
  };

  const longRows: Record<string, unknown>[] = [];
  for (const a of data.assessments) {
    const it = itemById.get(a.itemId);
    if (!it) continue;
    const orig = originalSubmission(a);
    for (const v of vars) {
      longRows.push({
        item_id: a.itemId, external_id: it.externalId, batch: it.batch, adjudicator: who(a.userId), variable: v.id, value: enc(a.values[v.id]), value_label: labelOf(v, a.values[v.id]),
        first_submitted_value: orig ? enc(orig.values[v.id]) : null, status: a.status, version: a.version, submitted_at: a.submittedAt ?? '', updated_at: a.updatedAt,
        comment: a.comment, evidence: a.evidence,
      });
    }
  }
  const tLong: Table = {
    name: 'assessments_long', description: 'Every independent assessment, one row per item, adjudicator and variable. status = draft rows are not used in any statistic.',
    columns: ['item_id', 'external_id', 'batch', 'adjudicator', 'variable', 'value', 'value_label', 'first_submitted_value', 'status', 'version', 'submitted_at', 'updated_at', 'comment', 'evidence'],
    rows: longRows,
  };

  const wideCols = ['item_id', 'external_id', 'batch', 'category'];
  for (const v of vars) for (const r of raters) wideCols.push(`${v.id}__${r}`);
  const byItem = new Map<string, Record<string, unknown>>();
  for (const i of items) byItem.set(i.id, { item_id: i.id, external_id: i.externalId, batch: i.batch, category: i.category });
  for (const a of data.assessments) {
    if (a.status !== 'submitted') continue;
    const row = byItem.get(a.itemId);
    if (!row) continue;
    for (const v of vars) row[`${v.id}__${names.get(a.userId) ?? a.userId}`] = enc(a.values[v.id]);
  }
  const tWide: Table = { name: 'assessments_wide', description: 'Submitted independent assessments, one row per item and one column per variable and adjudicator pseudonym. The input for reliability analysis in other software.', columns: wideCols, rows: [...byItem.values()] };

  const agreeCols = ['item_id', 'external_id', 'batch', 'state', 'required', 'submitted', 'agreement_level', 'disputed_variables'];
  for (const v of vars) if (v.type !== 'text') agreeCols.push(`${v.id}__outcome`, `${v.id}__ratings`);
  const tAgree: Table = {
    name: 'agreement', description: 'Agreement status per item from the independent assessments. agreement_level: complete (all unanimous), rule (all meet the project rule), partial (some variables disputed), none (all disputed); empty while judgments are outstanding.',
    columns: agreeCols,
    rows: items.map((i) => {
      const st = statuses.get(i.id)!;
      const row: Record<string, unknown> = { item_id: i.id, external_id: i.externalId, batch: i.batch, state: st.state, required: st.required, submitted: st.submitted.length, agreement_level: st.agreement ?? '', disputed_variables: st.disputed.join(';') };
      for (const [vid, c] of Object.entries(st.comparisons)) {
        row[`${vid}__outcome`] = c.outcome;
        row[`${vid}__ratings`] = Object.entries(c.values).map(([u, val]) => `${names.get(u) ?? u}=${enc(val) ?? ''}`).join(';');
      }
      return row;
    }),
  };

  const optLabel = new Map(project.config.resolution.options.map((o) => [o.id, o.label]));
  const ratLabel = new Map(project.config.resolution.rationales.map((r) => [r.id, r.label]));
  const finalCols = ['item_id', 'external_id', 'batch', 'state', 'final_source'];
  for (const v of vars) if (v.type !== 'text') finalCols.push(`final_${v.id}`, `final_${v.id}_label`);
  finalCols.push('resolution_option', 'resolution_option_label', 'retained_adjudicator', 'rationale_codes', 'rationale_labels', 'rationale_text', 'references', 'proposed_by', 'approved_by', 'finalized_by', 'finalized_at');
  const tFinal: Table = {
    name: 'final_classifications', description: 'Final classification per item: agreed values where the independent judgments met the agreement rule, otherwise the finalized resolution. Kept separate from the independent assessments.',
    columns: finalCols,
    rows: items.map((i) => {
      const st = statuses.get(i.id)!;
      const r = st.resolution;
      const row: Record<string, unknown> = { item_id: i.id, external_id: i.externalId, batch: i.batch, state: st.state, final_source: st.finalSource ?? '' };
      for (const v of vars) if (v.type !== 'text') {
        row[`final_${v.id}`] = st.finalValues ? enc(st.finalValues[v.id]) : null;
        row[`final_${v.id}_label`] = st.finalValues ? labelOf(v, st.finalValues[v.id]) : '';
      }
      if (r) Object.assign(row, {
        resolution_option: r.optionId, resolution_option_label: (optLabel.get(r.optionId) ?? '').replace('{adjudicator}', who(r.retainedUserId)), retained_adjudicator: who(r.retainedUserId),
        rationale_codes: r.rationaleIds.join(';'), rationale_labels: r.rationaleIds.map((x) => ratLabel.get(x) ?? x).join('; '), rationale_text: r.freeText, references: r.references,
        proposed_by: who(r.proposedBy), approved_by: r.approvals.map((a) => who(a.userId)).join(';'), finalized_by: who(r.finalizedBy), finalized_at: r.finalizedAt ?? '',
      });
      return row;
    }),
  };

  const tRes: Table = {
    name: 'resolution_history', description: 'Every proposed, final and superseded resolution, in order.',
    columns: ['resolution_id', 'item_id', 'external_id', 'version', 'status', 'option', 'retained_adjudicator', 'values', 'rationale_codes', 'rationale_text', 'references', 'proposed_by', 'proposed_at', 'approvals', 'finalized_by', 'finalized_at', 'reopened_by', 'reopened_at', 'reopen_reason'],
    rows: data.resolutions.slice().sort((a, b) => a.proposedAt.localeCompare(b.proposedAt)).map((r) => ({
      resolution_id: r.id, item_id: r.itemId, external_id: itemById.get(r.itemId)?.externalId ?? '', version: r.version, status: r.status, option: r.optionId, retained_adjudicator: who(r.retainedUserId),
      values: JSON.stringify(Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, enc(v)]))), rationale_codes: r.rationaleIds.join(';'), rationale_text: r.freeText, references: r.references,
      proposed_by: who(r.proposedBy), proposed_at: r.proposedAt, approvals: r.approvals.map((a) => `${who(a.userId)}@${a.at}`).join(';'), finalized_by: who(r.finalizedBy), finalized_at: r.finalizedAt ?? '',
      reopened_by: who(r.reopenedBy), reopened_at: r.reopenedAt ?? '', reopen_reason: r.reopenReason ?? '',
    })),
  };

  const tDisc: Table = {
    name: 'discussions', description: 'Discussion messages written during disagreement resolution.',
    columns: ['item_id', 'external_id', 'author', 'at', 'text'],
    rows: data.discussions.slice().sort((a, b) => a.at.localeCompare(b.at)).map((d) => ({ item_id: d.itemId, external_id: itemById.get(d.itemId)?.externalId ?? '', author: who(d.userId), at: d.at, text: d.text })),
  };
  const tEsc: Table = {
    name: 'escalations', description: 'Items escalated for additional review.',
    columns: ['item_id', 'external_id', 'raised_by', 'at', 'reason', 'open'],
    rows: data.escalations.map((e) => ({ item_id: e.itemId, external_id: itemById.get(e.itemId)?.externalId ?? '', raised_by: who(e.userId), at: e.at, reason: e.reason, open: e.open })),
  };

  const tOut: Table = {
    name: 'outstanding', description: 'Items without final values: awaiting independent judgments or holding an unresolved disagreement.',
    columns: ['item_id', 'external_id', 'batch', 'state', 'submitted', 'required', 'waiting_for', 'disputed_variables', 'disclosed'],
    rows: items.filter((i) => !statuses.get(i.id)!.finalValues).map((i) => {
      const st = statuses.get(i.id)!;
      return { item_id: i.id, external_id: i.externalId, batch: i.batch, state: st.state, submitted: st.submitted.length, required: st.required,
        waiting_for: st.assigned.filter((u) => !st.submitted.includes(u)).map((u) => who(u)).join(';'), disputed_variables: st.disputed.join(';'), disclosed: isItemDisclosed(project, statuses, i.id) };
    }),
  };

  const tAudit: Table = {
    name: 'audit_log', description: 'Meaningful changes and decisions, in time order.',
    columns: ['at', 'actor', 'action', 'entity', 'entity_id', 'detail'],
    rows: data.audit.slice().sort((a, b) => a.at.localeCompare(b.at)).map((e) => ({ at: e.at, actor: who(e.userId) || e.userId, action: e.action, entity: e.entity, entity_id: e.entityId, detail: e.detail ? JSON.stringify(e.detail) : '' })),
  };

  const reliability = analyzeProject(data, { bootstrapReps: opts.bootstrapReps ?? 1000, seed: project.config.assignment.seed });
  const relRows: Record<string, unknown>[] = [];
  const pairRows: Record<string, unknown>[] = [];
  const pushRel = (r: VariableReliability) => {
    for (const s of r.stats) relRows.push({ variable: r.variableId, statistic: s.id, name: s.name, value: Number.isFinite(s.value) ? s.value : null, ci_low: s.ci?.[0] ?? null, ci_high: s.ci?.[1] ?? null, ci_method: s.ciMethod ?? '', se: s.se ?? null, n_items: s.n, role: s.role, kind: s.kind, note: s.note ?? '', undefined_reason: s.undefinedReason ?? '', units: r.design.units, raters: r.design.raters });
    for (const p of r.pairwise) pairRows.push({ variable: r.variableId, rater_a: p.a, rater_b: p.b, n_items: p.n, agreement: p.agreement, coefficient: Number.isFinite(p.kappa) ? p.kappa : null, ci_low: p.kappaCi?.[0] ?? null, ci_high: p.kappaCi?.[1] ?? null });
    r.parts?.forEach(pushRel);
  };
  reliability.forEach(pushRel);
  const tRel: Table = { name: 'reliability', description: 'Interrater reliability from the independent assessments only (never from consensus values).', columns: ['variable', 'statistic', 'name', 'value', 'ci_low', 'ci_high', 'ci_method', 'se', 'n_items', 'role', 'kind', 'note', 'undefined_reason', 'units', 'raters'], rows: relRows };
  const tPair: Table = { name: 'reliability_pairwise', description: "Pairwise agreement between adjudicators (Cohen's kappa for categorical variables, ICC(A,1) for numeric).", columns: ['variable', 'rater_a', 'rater_b', 'n_items', 'agreement', 'coefficient', 'ci_low', 'ci_high'], rows: pairRows };

  const refRows: Record<string, unknown>[] = [];
  for (const c of compareReferences(data, statuses)) {
    for (const a of c.vsAdjudicators) refRows.push({ reference: c.reference.label, compared_with: a.rater, n_items: a.n, agreement: a.agreement, kappa: Number.isFinite(a.kappa) ? a.kappa : null });
    for (const o of c.vsReferences) refRows.push({ reference: c.reference.label, compared_with: o.other, n_items: o.n, agreement: o.agreement, kappa: Number.isFinite(o.kappa) ? o.kappa : null });
    if (c.vsFinal) {
      const f = c.vsFinal;
      refRows.push({ reference: c.reference.label, compared_with: 'final classification', n_items: f.n, agreement: f.agreement, kappa: Number.isFinite(f.kappa) ? f.kappa : null,
        tp: f.accuracy?.tp, fp: f.accuracy?.fp, fn: f.accuracy?.fn, tn: f.accuracy?.tn, sensitivity: f.accuracy?.sensitivity.value, specificity: f.accuracy?.specificity.value });
    }
  }
  const tRef: Table = { name: 'reference_comparison', description: 'Agreement of reference raters (for example automated classifiers) with each adjudicator, with each other and with the final classification.', columns: ['reference', 'compared_with', 'n_items', 'agreement', 'kappa', 'tp', 'fp', 'fn', 'tn', 'sensitivity', 'specificity'], rows: refRows };

  const tables = [tItems, tLong, tWide, tAgree, tFinal, tRes, tDisc, tEsc, tOut, tRel, tPair, tRef, tAudit];
  const dict: Record<string, unknown>[] = [];
  for (const t of tables) for (const c of t.columns) dict.push({ table: t.name, column: c, description: describeColumn(c, vars) });
  for (const v of vars) {
    dict.push({ table: 'variables', column: v.id, description: `${v.label} [${v.type}${v.required ? ', required' : ''}${v.includeInAgreement && v.type !== 'text' ? ', in agreement' : ''}]${v.description ? `: ${v.description}` : ''}` });
    for (const c of v.categories ?? []) dict.push({ table: 'codes', column: `${v.id}=${c.value}`, description: c.label + (c.description ? `: ${c.description}` : '') });
  }
  const tDict: Table = { name: 'data_dictionary', description: 'Columns of every table, variable definitions and category codes.', columns: ['table', 'column', 'description'], rows: dict };
  tables.push(tDict);
  return { tables, statuses, reliability };
}

function describeColumn(c: string, vars: Variable[]): string {
  const known: Record<string, string> = {
    item_id: 'Agreemetry item identifier', external_id: 'Identifier from the imported file', batch: 'Batch', category: 'Category', seq: 'Import order', imported_at: 'Import time (UTC, ISO 8601)',
    adjudicator: 'Project pseudonym of the adjudicator', variable: 'Variable code (see variables)', value: 'Code given (multi-label: codes joined by ";"); empty = not answered', value_label: 'Label of the code',
    first_submitted_value: 'Value at first submission (differs from value only if amended before disclosure)', status: 'draft or submitted', version: 'Assessment version number', submitted_at: 'Last submission time', updated_at: 'Last change time',
    comment: 'Adjudicator comment', evidence: 'Evidence or justification', state: 'Workflow state: unassigned, awaiting, in_progress, agreed, disagreement, proposed, escalated, resolved',
    required: 'Independent judgments required', submitted: 'Independent judgments submitted', agreement_level: 'complete, rule, partial or none', disputed_variables: 'Variables failing the agreement rule',
    final_source: 'agreement (independent judgments met the rule) or resolution', resolution_option: 'Resolution option code', rationale_codes: 'Standard rationale codes', rationale_text: 'Free-text rationale',
  };
  if (known[c]) return known[c];
  if (c.startsWith('field_')) return `Original imported field "${c.slice(6)}"`;
  const m = c.match(/^(.+)__(.+)$/);
  if (m) {
    const v = vars.find((x) => x.id === m[1]);
    if (m[2] === 'outcome') return `Comparison outcome for ${v?.label ?? m[1]}: unanimous, rule or split`;
    if (m[2] === 'ratings') return `Ratings for ${v?.label ?? m[1]} by pseudonym`;
    return `${v?.label ?? m[1]} as rated by ${m[2]}`;
  }
  if (c.startsWith('final_')) return `Final value of ${c.replace(/^final_/, '').replace(/_label$/, ' (label)')}`;
  return '';
}

// Codebook and loader scripts --------------------------------------------------------------------------

export function codebook(data: ProjectData): string {
  const p = data.project;
  const c = p.config;
  const lines = [
    `# Codebook: ${p.name}`, '', `Exported ${nowIso()} from Agreemetry.`, '', p.description, '', '## Design', '',
    `- Independent judgments required per item: ${c.requiredAdjudicators}`,
    `- Assignment: ${c.assignment.mode === 'all' ? 'every adjudicator rates every item' : `${c.assignment.k} adjudicators per item, balanced rotation`} (seed ${c.assignment.seed})`,
    `- Presentation order: ${c.order === 'import' ? 'import order' : 'seeded random order per adjudicator'}`,
    `- Agreement rule: ${c.agreement.rule}${c.agreement.rule === 'threshold' ? ` (share >= ${c.agreement.threshold})` : ''}; numeric tolerance ${c.agreement.numericTolerance ?? 0}; multi-label ${c.agreement.multilabelMode}`,
    `- Disclosure of other judgments: ${c.disclosure}`,
    `- Resolution: ${c.resolution.mechanism}`,
    `- Blinded fields: ${c.display.blindedFields.join(', ') || 'none'}`,
    '', '## Variables', '',
  ];
  for (const v of c.variables) {
    lines.push(`### ${v.id}: ${v.label}`, '', `Type ${v.type}; ${v.required ? 'required' : 'optional'}; ${v.includeInAgreement && v.type !== 'text' ? 'compared for agreement' : 'not compared'}.`);
    if (v.description) lines.push('', v.description);
    if (v.categories?.length) {
      lines.push('', '| Code | Label |', '|---|---|');
      for (const k of v.categories) lines.push(`| ${k.value} | ${k.label} |`);
    }
    if (v.type === 'numeric') lines.push('', `Range ${v.min ?? '-'} to ${v.max ?? '-'}, step ${v.step ?? 'any'}, level ${v.numericLevel ?? 'interval'}.`);
    lines.push('');
  }
  lines.push('## Resolution options', '');
  for (const o of c.resolution.options) if (o.enabled) lines.push(`- \`${o.id}\` (${o.kind}): ${o.label}`);
  lines.push('', '## Rationale codes', '');
  for (const r of c.resolution.rationales) if (r.enabled) lines.push(`- \`${r.id}\`: ${r.label}`);
  for (const d of p.documents) lines.push('', `## ${d.title}`, '', d.body);
  return lines.join('\n');
}

export function loaderR(): string {
  return `# Load an Agreemetry export in R. Run from the folder holding the CSV files.
items <- read.csv("items.csv", stringsAsFactors = FALSE, na.strings = "")
long  <- read.csv("assessments_long.csv", stringsAsFactors = FALSE, na.strings = "")
wide  <- read.csv("assessments_wide.csv", stringsAsFactors = FALSE, na.strings = "")
final <- read.csv("final_classifications.csv", stringsAsFactors = FALSE, na.strings = "")
long  <- subset(long, status == "submitted")   # drafts never enter reliability
# Example: reproduce Krippendorff's alpha for one variable with the irr package
# install.packages("irr")
# v <- "VARIABLE_ID"
# m <- t(as.matrix(wide[, grep(paste0("^", v, "__"), names(wide))]))
# irr::kripp.alpha(m, method = "nominal")
`;
}

export function loaderPython(): string {
  return `"""Load an Agreemetry export in Python (pandas). Run from the folder holding the CSV files."""
import pandas as pd

items = pd.read_csv("items.csv", keep_default_na=False, na_values=[""])
long = pd.read_csv("assessments_long.csv", keep_default_na=False, na_values=[""])
wide = pd.read_csv("assessments_wide.csv", keep_default_na=False, na_values=[""])
final = pd.read_csv("final_classifications.csv", keep_default_na=False, na_values=[""])
long = long[long.status == "submitted"]  # drafts never enter reliability

# Example: Cohen's kappa for two adjudicators on one variable
# from sklearn.metrics import cohen_kappa_score
# v = "VARIABLE_ID"
# both = wide[[f"{v}__R1", f"{v}__R2"]].dropna()
# print(cohen_kappa_score(both.iloc[:, 0].astype(str), both.iloc[:, 1].astype(str)))
`;
}

export function loaderStata(): string {
  return `* Load an Agreemetry export in Stata. Run from the folder holding the CSV files.
import delimited using "assessments_long.csv", varnames(1) stringcols(_all) clear
keep if status == "submitted"
save agreemetry_long.dta, replace
import delimited using "assessments_wide.csv", varnames(1) clear
save agreemetry_wide.dta, replace
* SPSS: File > Import Data > CSV Data, first row holds variable names.
`;
}

export function archiveOf(data: ProjectData): ProjectArchive {
  return {
    format: 'agreemetry-project', formatVersion: 1, exportedAt: nowIso(), project: data.project, users: data.users, memberships: data.memberships, items: data.items,
    assignments: data.assignments, contexts: data.contexts, assessments: data.assessments, resolutions: data.resolutions, discussions: data.discussions, escalations: data.escalations, audit: data.audit,
  };
}

export function tableCsv(t: Table): string {
  return toCsv(t.rows, t.columns);
}

export async function zipExport(data: ProjectData, opts: ExportOptions = {}): Promise<Blob> {
  const { zipSync, strToU8 } = await import('fflate');
  const { tables } = buildTables(data, opts);
  const files: Record<string, Uint8Array> = {};
  for (const t of tables) files[`${t.name}.csv`] = strToU8(tableCsv(t));
  files['project_config.json'] = strToU8(JSON.stringify({ project: { ...data.project, documents: undefined }, documents: data.project.documents }, null, 2));
  files['codebook.md'] = strToU8(codebook(data));
  files['project_archive.agreemetry.json'] = strToU8(JSON.stringify(archiveOf(data)));
  files['load_in_R.R'] = strToU8(loaderR());
  files['load_in_python.py'] = strToU8(loaderPython());
  files['load_in_stata.do'] = strToU8(loaderStata());
  files['README.txt'] = strToU8(readme(data, tables));
  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}

function readme(data: ProjectData, tables: Table[]): string {
  return [`Agreemetry export: ${data.project.name}`, `Exported ${nowIso()}`, '', 'Files:', ...tables.map((t) => `- ${t.name}.csv (${t.rows.length} rows): ${t.description}`),
    '- project_config.json: full project configuration', '- codebook.md: variables, codes, rules and documents', '- project_archive.agreemetry.json: complete archive, re-importable into Agreemetry',
    '- load_in_R.R, load_in_python.py, load_in_stata.do: loader scripts', '', 'Encoding UTF-8, comma-separated, CRLF line endings, empty cell = missing. Times are UTC (ISO 8601).',
    'Reliability is computed from submitted independent assessments only; consensus values never replace them.'].join('\n');
}

export async function excelExport(data: ProjectData, opts: ExportOptions = {}): Promise<Blob> {
  const XLSX = await import('xlsx');
  const { tables } = buildTables(data, opts);
  const wb = XLSX.utils.book_new();
  for (const t of tables) {
    const ws = XLSX.utils.json_to_sheet(t.rows.map((r) => Object.fromEntries(t.columns.map((c) => [c, r[c] ?? null]))), { header: t.columns });
    XLSX.utils.book_append_sheet(wb, ws, t.name.slice(0, 31));
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function jsonExport(data: ProjectData, opts: ExportOptions = {}): Blob {
  const { tables } = buildTables(data, opts);
  return new Blob([JSON.stringify({ exportedAt: nowIso(), project: data.project.name, tables: Object.fromEntries(tables.map((t) => [t.name, t.rows])) }, null, 1)], { type: 'application/json' });
}

export { fmt };

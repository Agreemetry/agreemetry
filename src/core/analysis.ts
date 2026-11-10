/**
 * Reliability analysis for a project: builds rating matrices from the ORIGINAL independent assessments,
 * recommends coefficients for the design, computes them with intervals, and flags results that are
 * undefined or easy to misread. Consensus and resolved values are used only for comparisons with
 * reference raters, never for interrater reliability.
 */
import type { Item, Membership, ProjectData, RatingValue, ReferenceRater, Variable } from './types';
import {
  binaryAccuracy,
  bootstrapCI,
  cohenKappa,
  crossTable,
  fleissKappa,
  gwetAC1,
  icc,
  krippendorffAlpha,
  pabak,
  percentAgreement,
  specificAgreement,
  type BinaryAccuracy,
  type Cell,
  type CrossTable,
  type ICCSet,
  type KappaWeights,
  type RatingMatrix,
} from './stats/irr';
import { adjudicators, type ItemStatus } from './workflow';

export interface Flag {
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface StatRow {
  id: string;
  name: string;
  value: number;
  ci?: [number, number];
  ciMethod?: string;
  se?: number;
  n: number;
  role: 'primary' | 'secondary' | 'descriptive';
  kind: 'raw' | 'chance-corrected' | 'correlation';
  note?: string;
  undefinedReason?: string;
}

export interface DesignInfo {
  units: number;
  unitsRatedTwice: number;
  raters: number;
  ratingsPerUnit: { min: number; max: number };
  fullyCrossed: boolean;
  /** Same two raters on every compared unit. */
  sameTwoRaters: boolean;
  missingCells: number;
}

export interface PairRow {
  a: string;
  b: string;
  n: number;
  agreement: number;
  kappa: number;
  kappaCi?: [number, number];
}

export interface VariableReliability {
  variableId: string;
  label: string;
  type: Variable['type'];
  design: DesignInfo;
  stats: StatRow[];
  pairwise: PairRow[];
  specific: { category: string; label: string; value: number; n: number }[];
  distribution: { rater: string; counts: Record<string, number>; total: number }[];
  categories: { value: string; label: string }[];
  table?: CrossTable;
  icc?: ICCSet;
  flags: Flag[];
  recommendation: string;
  parts?: VariableReliability[];
}

export interface AnalysisOptions {
  bootstrapReps?: number;
  seed?: string;
  /** Restrict to these items (subgroup, batch). */
  itemFilter?: (item: Item) => boolean;
  /** The configured design, used for the recommendation until judgments exist. */
  planned?: { raters: number; sameRaters: boolean };
}

function raterOrder(memberships: Membership[]): Membership[] {
  return adjudicators(memberships)
    .slice()
    .sort((a, b) => a.pseudonym.localeCompare(b.pseudonym, undefined, { numeric: true }));
}

/** Pseudonym for every user who submitted, including people no longer active. */
export function pseudonyms(data: ProjectData): Map<string, string> {
  const m = new Map<string, string>();
  for (const mm of data.memberships) m.set(mm.userId, mm.pseudonym);
  return m;
}

/** Units (items) by raters, from submitted assessments only. */
export function ratingMatrix(data: ProjectData, variable: Variable, map: (v: RatingValue) => Cell, filter?: (i: Item) => boolean): RatingMatrix {
  const items = filter ? data.items.filter(filter) : data.items;
  const ids = new Set(items.map((i) => i.id));
  const raters = raterOrder(data.memberships).map((m) => m.userId);
  for (const a of data.assessments) if (a.status === 'submitted' && !raters.includes(a.userId) && ids.has(a.itemId)) raters.push(a.userId);
  const col = new Map(raters.map((r, i) => [r, i]));
  const rowIdx = new Map<string, number>();
  const units: string[] = [];
  const dataRows: Cell[][] = [];
  for (const a of data.assessments) {
    if (a.status !== 'submitted' || !ids.has(a.itemId)) continue;
    let r = rowIdx.get(a.itemId);
    if (r === undefined) {
      r = units.length;
      rowIdx.set(a.itemId, r);
      units.push(a.itemId);
      dataRows.push(new Array(raters.length).fill(null));
    }
    dataRows[r][col.get(a.userId)!] = map(a.values[variable.id] ?? null);
  }
  return { units, raters, data: dataRows };
}

function designOf(m: RatingMatrix): DesignInfo {
  const used = m.raters.map((_, j) => j).filter((j) => m.data.some((r) => r[j] !== null));
  const counts = m.data.map((r) => used.filter((j) => r[j] !== null).length);
  const pairSets = new Set(m.data.filter((_, i) => counts[i] >= 2).map((r) => used.filter((j) => r[j] !== null).join(',')));
  return {
    units: m.data.length,
    unitsRatedTwice: counts.filter((c) => c >= 2).length,
    raters: used.length,
    ratingsPerUnit: { min: counts.length ? Math.min(...counts) : 0, max: counts.length ? Math.max(...counts) : 0 },
    fullyCrossed: m.data.length > 0 && counts.every((c) => c === used.length),
    sameTwoRaters: used.length === 2 && pairSets.size <= 1,
    missingCells: counts.reduce((s, c) => s + used.length - c, 0),
  };
}

function restrictRaters(m: RatingMatrix, keep: number[]): RatingMatrix {
  return { units: m.units, raters: keep.map((j) => m.raters[j]), data: m.data.map((r) => keep.map((j) => r[j])) };
}

function twoRaterColumns(m: RatingMatrix): [Cell[], Cell[]] | null {
  const used = m.raters.map((_, j) => j).filter((j) => m.data.some((r) => r[j] !== null));
  if (used.length !== 2) return null;
  return [m.data.map((r) => r[used[0]]), m.data.map((r) => r[used[1]])];
}

const SMALL_N = 30;

function categoricalAnalysis(
  m: RatingMatrix,
  variable: Variable,
  categories: { value: string; label: string }[],
  ordinal: boolean,
  opts: AnalysisOptions,
  names: Map<string, string>,
): VariableReliability {
  const codes = categories.map((c) => c.value);
  const design = designOf(m);
  const stats: StatRow[] = [];
  const flags: Flag[] = [];
  const reps = opts.bootstrapReps ?? 1000;
  const seed = `${opts.seed ?? 'agreemetry'}:${variable.id}`;
  const boot = (f: (x: RatingMatrix) => number) => bootstrapCI(m, f, { reps, seed });
  const plannedTwo = design.raters < 2 && opts.planned?.raters === 2 && opts.planned.sameRaters;
  const two = design.raters === 2 && design.sameTwoRaters ? twoRaterColumns(m) : plannedTwo ? ([[], []] as [Cell[], Cell[]]) : null;
  if (plannedTwo) flags.push({ level: 'info', text: 'No judgments yet: the recommendation follows the configured design (two adjudicators rating every item).' });
  let recommendation = '';
  let table: CrossTable | undefined;

  const pa = percentAgreement(m);
  const paBoot = boot((x) => percentAgreement(x).value);
  stats.push({ id: 'pa', name: design.raters > 2 ? 'Raw agreement (mean pairwise)' : 'Raw agreement', value: pa.value, ci: paBoot.ci, ciMethod: `percentile bootstrap over items, ${reps} resamples`, n: pa.n, role: 'descriptive', kind: 'raw', note: 'Share of rater pairs giving the same value. Not corrected for chance.' });
  if (design.raters > 2) stats.push({ id: 'all_agree', name: 'Items with every rating identical', value: pa.allAgree, ci: pa.allAgreeCi, ciMethod: 'exact (Clopper-Pearson)', n: pa.n, role: 'descriptive', kind: 'raw' });

  const weights: KappaWeights = ordinal ? (variable.weights ?? 'quadratic') : 'none';
  if (two) {
    table = crossTable(two[0], two[1], codes);
    const k = cohenKappa(table, 'none');
    if (ordinal) {
      const kw = cohenKappa(table, weights);
      stats.push({ id: 'kappa_w', name: `Weighted kappa (${weights} weights)`, value: kw.value, ci: kw.ci, ciMethod: kw.ciMethod, se: kw.se, n: kw.n, role: 'primary', kind: 'chance-corrected', undefinedReason: kw.undefinedReason, note: 'Cohen (1968). Partial credit for near misses on the ordered scale.' });
      stats.push({ id: 'kappa', name: "Cohen's kappa (unweighted)", value: k.value, ci: k.ci, ciMethod: k.ciMethod, se: k.se, n: k.n, role: 'secondary', kind: 'chance-corrected', undefinedReason: k.undefinedReason, note: 'Treats every disagreement as complete.' });
      recommendation = `Two raters on an ordered scale: weighted kappa (${weights} weights) is primary; Krippendorff's ordinal alpha is reported alongside.`;
    } else {
      stats.push({ id: 'kappa', name: "Cohen's kappa", value: k.value, ci: k.ci, ciMethod: k.ciMethod, se: k.se, n: k.n, role: 'primary', kind: 'chance-corrected', undefinedReason: k.undefinedReason, note: k.kappaMax !== undefined ? `Maximum attainable with these marginals: ${k.kappaMax.toFixed(3)}.` : undefined });
      recommendation = "Two raters, categorical scale, same raters on every item: Cohen's kappa is primary, with Krippendorff's alpha and Gwet's AC1 as checks.";
    }
    if (codes.length === 2) {
      const pb = pabak(table);
      stats.push({ id: 'pabak', name: 'Prevalence- and bias-adjusted kappa (PABAK)', value: pb.value, n: pb.n, role: 'secondary', kind: 'chance-corrected', note: `Equals 2 x raw agreement - 1. Prevalence index ${pb.prevalenceIndex?.toFixed(3)}, bias index ${pb.biasIndex?.toFixed(3)} (Byrt, Bishop and Carlin, 1993).` });
      if ((pb.prevalenceIndex ?? 0) >= 0.6 && Number.isFinite(k.value)) {
        flags.push({ level: 'warn', text: `Skewed prevalence (index ${pb.prevalenceIndex!.toFixed(2)}): kappa can be low even when raw agreement is high (the kappa paradox). Read kappa with raw agreement, specific agreement per category, AC1 and PABAK.` });
      }
      if ((pb.biasIndex ?? 0) >= 0.1) flags.push({ level: 'info', text: `The raters use the categories at different rates (bias index ${pb.biasIndex!.toFixed(2)}); see the distribution by rater.` });
    }
    if (Number.isFinite(k.value) && k.kappaMax !== undefined && k.kappaMax < 0.8 && !ordinal) {
      flags.push({ level: 'info', text: `The marginals cap kappa at ${k.kappaMax.toFixed(2)}; values near the cap mean the raters agree as much as their category use allows.` });
    }
  } else {
    const f = fleissKappa(m, codes);
    const fb = boot((x) => fleissKappa(x, codes).value);
    const constant = design.ratingsPerUnit.min === design.ratingsPerUnit.max || f.excludedUnits === 0;
    stats.push({ id: 'fleiss', name: "Fleiss' kappa", value: f.value, ci: fb.ci, ciMethod: `percentile bootstrap over items, ${reps} resamples`, n: f.n, role: constant && !ordinal ? 'primary' : 'secondary', kind: 'chance-corrected', undefinedReason: f.undefinedReason, note: `Units with ${f.raters} ratings.${f.excludedUnits ? ` ${f.excludedUnits} units with a different number of ratings excluded.` : ''}${ordinal ? ' Ignores the order of categories.' : ''}` });
    if (f.excludedUnits) flags.push({ level: 'warn', text: `Fleiss' kappa needs the same number of ratings per item; ${f.excludedUnits} items were excluded from it. Krippendorff's alpha uses every item with two or more ratings.` });
    recommendation = ordinal
      ? "More than two raters, or different raters across items, on an ordered scale: Krippendorff's ordinal alpha is primary."
      : constant
        ? "Several raters with the same number of ratings per item: Fleiss' kappa is primary, with Krippendorff's alpha and Gwet's AC1."
        : "Unequal numbers of ratings per item: Krippendorff's alpha is primary because it uses all pairable ratings.";
    if (design.raters === 2 && !design.sameTwoRaters) flags.push({ level: 'info', text: "Different pairs of raters rated different items, so Cohen's kappa does not apply; multi-rater coefficients are used." });
  }

  const alphaLevel = ordinal ? 'ordinal' : 'nominal';
  const al = krippendorffAlpha(m, alphaLevel, codes);
  const ab = boot((x) => krippendorffAlpha(x, alphaLevel, codes).value);
  const alphaPrimary = !two && (ordinal || design.ratingsPerUnit.min !== design.ratingsPerUnit.max);
  stats.push({ id: 'alpha', name: `Krippendorff's alpha (${alphaLevel})`, value: al.value, ci: ab.ci, ciMethod: `percentile bootstrap over items, ${reps} resamples`, n: al.n, role: alphaPrimary ? 'primary' : 'secondary', kind: 'chance-corrected', undefinedReason: al.undefinedReason, note: `${al.pairableValues.toFixed(0)} pairable values; items with one rating carry none.` });

  const ac = gwetAC1(m, codes);
  const acb = boot((x) => gwetAC1(x, codes).value);
  stats.push({ id: 'ac1', name: "Gwet's AC1", value: ac.value, ci: acb.ci, ciMethod: `percentile bootstrap over items, ${reps} resamples`, n: ac.n, role: 'secondary', kind: 'chance-corrected', undefinedReason: ac.undefinedReason, note: 'Less affected by skewed prevalence than kappa (Gwet, 2008).' });

  const pairwise: PairRow[] = [];
  const used = m.raters.map((_, j) => j).filter((j) => m.data.some((r) => r[j] !== null));
  for (let i = 0; i < used.length; i++)
    for (let j = i + 1; j < used.length; j++) {
      const sub = restrictRaters(m, [used[i], used[j]]);
      const both = sub.data.filter((r) => r[0] !== null && r[1] !== null);
      const t = crossTable(both.map((r) => r[0]), both.map((r) => r[1]), codes);
      const k = cohenKappa(t, ordinal ? weights : 'none');
      pairwise.push({ a: names.get(m.raters[used[i]]) ?? m.raters[used[i]], b: names.get(m.raters[used[j]]) ?? m.raters[used[j]], n: t.n, agreement: t.n ? t.counts.reduce((s, r, x) => s + r[x], 0) / t.n : NaN, kappa: k.value, kappaCi: k.ci });
    }

  const spec = specificAgreement(m, codes).map((s) => ({ ...s, label: categories.find((c) => c.value === s.category)?.label ?? s.category }));
  const distribution = used.map((j) => {
    const counts: Record<string, number> = Object.fromEntries(codes.map((c) => [c, 0]));
    let total = 0;
    for (const r of m.data)
      if (r[j] !== null) {
        counts[String(r[j])] = (counts[String(r[j])] ?? 0) + 1;
        total++;
      }
    return { rater: names.get(m.raters[j]) ?? m.raters[j], counts, total };
  });

  commonFlags(design, stats, flags);
  return { variableId: variable.id, label: variable.label, type: variable.type, design, stats, pairwise, specific: spec, distribution, categories, table, flags, recommendation };
}

function numericAnalysis(m: RatingMatrix, variable: Variable, opts: AnalysisOptions, names: Map<string, string>): VariableReliability {
  const design = designOf(m);
  const reps = opts.bootstrapReps ?? 1000;
  const seed = `${opts.seed ?? 'agreemetry'}:${variable.id}`;
  const stats: StatRow[] = [];
  const flags: Flag[] = [];
  const used = m.raters.map((_, j) => j).filter((j) => m.data.some((r) => r[j] !== null));
  const sub = restrictRaters(m, used);
  const iccSet = icc(sub);
  const crossed = design.fullyCrossed && design.raters >= 2;
  const lvl = variable.numericLevel ?? 'interval';
  for (const r of iccSet.results) {
    const primary = crossed ? r.form === 'ICC_A1' : r.form === 'ICC1';
    stats.push({ id: r.form, name: `${r.label}`, value: r.value, ci: r.ci, ciMethod: `F distribution (McGraw and Wong, 1996); F(${r.df1}, ${r.df2}) = ${r.F.toFixed(2)}`, n: r.n, role: primary ? 'primary' : 'secondary', kind: 'correlation', note: r.model });
  }
  if (iccSet.undefinedReason) flags.push({ level: 'warn', text: `Intraclass correlation not computed: ${iccSet.undefinedReason}.` });
  if (iccSet.excludedUnits > 0 && iccSet.results.length) flags.push({ level: 'warn', text: `ICC uses only the ${iccSet.n} items rated by every rater; ${iccSet.excludedUnits} were excluded. Krippendorff's alpha uses all pairable ratings.` });
  const al = krippendorffAlpha(m, lvl);
  const ab = bootstrapCI(m, (x) => krippendorffAlpha(x, lvl).value, { reps, seed });
  stats.push({ id: 'alpha', name: `Krippendorff's alpha (${lvl})`, value: al.value, ci: ab.ci, ciMethod: `percentile bootstrap over items, ${reps} resamples`, n: al.n, role: crossed ? 'secondary' : 'primary', kind: 'chance-corrected', undefinedReason: al.undefinedReason });
  const tol = 0;
  const pa = percentAgreement(m, (a, b) => Math.abs(Number(a) - Number(b)) <= tol);
  stats.push({ id: 'pa', name: 'Exact agreement', value: pa.value, n: pa.n, role: 'descriptive', kind: 'raw', note: 'Share of rater pairs giving identical numbers.' });
  const pairwise: PairRow[] = [];
  for (let i = 0; i < used.length; i++)
    for (let j = i + 1; j < used.length; j++) {
      const both = m.data.filter((r) => r[used[i]] !== null && r[used[j]] !== null);
      const two = icc({ units: [], raters: ['a', 'b'], data: both.map((r) => [r[used[i]], r[used[j]]]) });
      const a1 = two.results.find((r) => r.form === 'ICC_A1');
      pairwise.push({ a: names.get(m.raters[used[i]]) ?? '', b: names.get(m.raters[used[j]]) ?? '', n: both.length, agreement: both.filter((r) => Number(r[used[i]]) === Number(r[used[j]])).length / (both.length || 1), kappa: a1?.value ?? NaN, kappaCi: a1?.ci });
    }
  const recommendation = crossed
    ? 'Numeric ratings with every rater rating every item: ICC(A,1), two-way random effects for absolute agreement, is primary; consistency forms and averages are shown for reference.'
    : "Numeric ratings with raters varying across items: one-way ICC(1) and Krippendorff's alpha are appropriate; two-way forms assume crossed raters.";
  commonFlags(design, stats, flags);
  return { variableId: variable.id, label: variable.label, type: variable.type, design, stats, pairwise, specific: [], distribution: [], categories: [], icc: iccSet, flags, recommendation };
}

function commonFlags(design: DesignInfo, stats: StatRow[], flags: Flag[]) {
  if (design.unitsRatedTwice === 0) flags.unshift({ level: 'error', text: 'No item has two independent ratings yet; reliability is not defined.' });
  else if (design.unitsRatedTwice < SMALL_N) flags.unshift({ level: 'warn', text: `Only ${design.unitsRatedTwice} items have two or more ratings; intervals are wide and estimates unstable.` });
  for (const s of stats) if (s.undefinedReason) flags.push({ level: 'info', text: `${s.name} is undefined: ${s.undefinedReason}.` });
  if (design.missingCells > 0) flags.push({ level: 'info', text: `${design.missingCells} rater-item cells are empty (not assigned or not yet submitted). Draft assessments are never used. Each coefficient's handling of missing ratings is described in Methods.` });
}

/** Reliability for one variable, restricted by an optional item filter. */
export function analyzeVariable(data: ProjectData, variable: Variable, opts: AnalysisOptions = {}): VariableReliability {
  const names = pseudonyms(data);
  const cfg = data.project.config;
  opts = { planned: { raters: cfg.requiredAdjudicators, sameRaters: cfg.assignment.mode === 'all' && adjudicators(data.memberships).length === cfg.requiredAdjudicators }, ...opts };
  if (variable.type === 'numeric') {
    const m = ratingMatrix(data, variable, (v) => (typeof v === 'number' ? v : v === null || v === '' ? null : Number(v)), opts.itemFilter);
    return numericAnalysis(m, variable, opts, names);
  }
  const cats = (variable.categories ?? []).map((c) => ({ value: c.value, label: c.label }));
  if (variable.type === 'multilabel') {
    const parts = cats.map((c) => {
      const m = ratingMatrix(data, variable, (v) => (Array.isArray(v) ? (v.includes(c.value) ? 'yes' : 'no') : null), opts.itemFilter);
      const sub: Variable = { ...variable, id: `${variable.id}::${c.value}`, label: `${variable.label}: ${c.label}`, type: 'binary' };
      return categoricalAnalysis(m, sub, [{ value: 'no', label: 'absent' }, { value: 'yes', label: 'present' }], false, opts, names);
    });
    const exact = ratingMatrix(data, variable, (v) => (Array.isArray(v) ? JSON.stringify([...v].sort()) : null), opts.itemFilter);
    const pa = percentAgreement(exact);
    const design = designOf(exact);
    return {
      variableId: variable.id, label: variable.label, type: variable.type, design,
      stats: [{ id: 'exact_set', name: 'Identical label sets (mean pairwise)', value: pa.value, n: pa.n, role: 'descriptive', kind: 'raw' }],
      pairwise: [], specific: [], distribution: [], categories: cats, flags: [{ level: 'info', text: 'Multi-label variables are analysed one label at a time (present or absent), the usual approach for multi-label coding.' }],
      recommendation: 'Each label is analysed as its own binary variable; see the per-label results.', parts,
    };
  }
  const m = ratingMatrix(data, variable, (v) => (v === null || v === undefined || v === '' ? null : String(v)), opts.itemFilter);
  return categoricalAnalysis(m, variable, cats, variable.type === 'ordinal', opts, names);
}

export function analyzeProject(data: ProjectData, opts: AnalysisOptions = {}): VariableReliability[] {
  return data.project.config.variables.filter((v) => v.type !== 'text' && v.includeInAgreement !== false).map((v) => analyzeVariable(data, v, opts));
}

/** Primary coefficient for a quick summary (dashboard tiles, subgroup forest plots). */
export function primaryStat(r: VariableReliability): StatRow | undefined {
  if (r.parts) return undefined;
  return r.stats.find((s) => s.role === 'primary') ?? r.stats[0];
}

// Reference raters -----------------------------------------------------------------------------

export interface ReferenceComparison {
  reference: ReferenceRater;
  /** Agreement with each adjudicator's independent judgment. */
  vsAdjudicators: { rater: string; n: number; agreement: number; kappa: number; kappaCi?: [number, number] }[];
  /** Against final values (agreed or resolved). */
  vsFinal?: { n: number; agreement: number; kappa: number; kappaCi?: [number, number]; table: CrossTable; accuracy?: BinaryAccuracy };
  vsReferences: { other: string; n: number; agreement: number; kappa: number; table: CrossTable }[];
}

export function referenceValue(item: Item, ref: ReferenceRater): string | null {
  const v = item.fields[ref.field];
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

export function compareReferences(data: ProjectData, statuses: Map<string, ItemStatus>, filter?: (i: Item) => boolean): ReferenceComparison[] {
  const items = filter ? data.items.filter(filter) : data.items;
  const names = pseudonyms(data);
  const out: ReferenceComparison[] = [];
  for (const ref of data.project.config.references) {
    const variable = data.project.config.variables.find((v) => v.id === ref.variableId);
    if (!variable) continue;
    const codes = (variable.categories ?? []).map((c) => c.value);
    const itemIds = new Set(items.map((i) => i.id));
    const refVal = new Map(items.map((i) => [i.id, referenceValue(i, ref)]));
    const vsAdjudicators: ReferenceComparison['vsAdjudicators'] = [];
    const byUser = new Map<string, { a: Cell[]; b: Cell[] }>();
    for (const a of data.assessments) {
      if (a.status !== 'submitted' || !itemIds.has(a.itemId)) continue;
      const e = byUser.get(a.userId) ?? { a: [], b: [] };
      e.a.push(refVal.get(a.itemId) ?? null);
      const v = a.values[variable.id];
      e.b.push(v === null || v === undefined || v === '' ? null : String(v));
      byUser.set(a.userId, e);
    }
    for (const [u, e] of byUser) {
      const t = crossTable(e.a, e.b, codes);
      const k = cohenKappa(t);
      vsAdjudicators.push({ rater: names.get(u) ?? u, n: t.n, agreement: t.n ? t.counts.reduce((s, r, i) => s + r[i], 0) / t.n : NaN, kappa: k.value, kappaCi: k.ci });
    }
    vsAdjudicators.sort((x, y) => x.rater.localeCompare(y.rater, undefined, { numeric: true }));
    const fa: Cell[] = [];
    const fb: Cell[] = [];
    for (const it of items) {
      const st = statuses.get(it.id);
      const fv = st?.finalValues?.[variable.id];
      if (fv === undefined || fv === null || fv === '') continue;
      fa.push(refVal.get(it.id) ?? null);
      fb.push(String(fv));
    }
    let vsFinal: ReferenceComparison['vsFinal'];
    if (fa.length) {
      const t = crossTable(fa, fb, codes);
      const k = cohenKappa(t);
      vsFinal = { n: t.n, agreement: t.n ? t.counts.reduce((s, r, i) => s + r[i], 0) / t.n : NaN, kappa: k.value, kappaCi: k.ci, table: t, accuracy: codes.length === 2 ? binaryAccuracy(fa, fb, codes[1]) : undefined };
    }
    const vsReferences: ReferenceComparison['vsReferences'] = [];
    for (const other of data.project.config.references) {
      if (other.id === ref.id || other.variableId !== ref.variableId) continue;
      const a = items.map((i) => refVal.get(i.id) ?? null);
      const b = items.map((i) => referenceValue(i, other));
      const t = crossTable(a, b, codes);
      const k = cohenKappa(t);
      vsReferences.push({ other: other.label, n: t.n, agreement: t.n ? t.counts.reduce((s, r, i) => s + r[i], 0) / t.n : NaN, kappa: k.value, table: t });
    }
    out.push({ reference: ref, vsAdjudicators, vsFinal, vsReferences });
  }
  return out;
}

/** Interpretation bands, shown with a warning that they are conventions, not standards. */
export function landisKoch(k: number): string {
  if (!Number.isFinite(k)) return 'undefined';
  if (k < 0) return 'poor (below chance)';
  if (k <= 0.2) return 'slight';
  if (k <= 0.4) return 'fair';
  if (k <= 0.6) return 'moderate';
  if (k <= 0.8) return 'substantial';
  return 'almost perfect';
}

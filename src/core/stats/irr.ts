/**
 * Interrater reliability and agreement coefficients.
 *
 * All functions take a rating matrix (units by raters, null = not rated) built from the ORIGINAL
 * independent assessments. Consensus or resolved values never enter these functions.
 *
 * References
 *  - Cohen (1960); Cohen (1968) weighted kappa; Fleiss, Cohen and Everitt (1969) large-sample variance.
 *  - Byrt, Bishop and Carlin (1993) prevalence- and bias-adjusted kappa, prevalence and bias indices.
 *  - Fleiss (1971) kappa for m raters.
 *  - Gwet (2008, 2014) AC1 with missing ratings.
 *  - Krippendorff (2011, 2019) alpha with the coincidence matrix; nominal, ordinal, interval, ratio.
 *  - Shrout and Fleiss (1979); McGraw and Wong (1996) intraclass correlations and F-based intervals.
 */
import { clopperPearson, fQuantile, normalQuantile, quantileSorted } from './dist';
import { rng } from '../util';

export type Cell = string | number | null;

export interface RatingMatrix {
  units: string[];
  raters: string[];
  /** data[u][r] */
  data: Cell[][];
}

export interface Estimate {
  value: number;
  se?: number;
  ci?: [number, number];
  ciMethod?: string;
  n: number;
}

const Z95 = normalQuantile(0.975);

function present(c: Cell): c is string | number {
  return c !== null && c !== undefined && c !== '';
}

// Percent agreement ----------------------------------------------------------------------

/**
 * Raw agreement: the mean, over units with two or more ratings, of the share of agreeing rater pairs.
 * With two raters this is the proportion of units rated identically. 'allAgree' is the share of
 * such units where every rating is identical.
 */
export function percentAgreement(m: RatingMatrix, equal: (a: Cell, b: Cell) => boolean = (a, b) => a === b) {
  let sum = 0;
  let n = 0;
  let all = 0;
  for (const row of m.data) {
    const vals = row.filter(present);
    const k = vals.length;
    if (k < 2) continue;
    let agree = 0;
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) if (equal(vals[i], vals[j])) agree++;
    const pairs = (k * (k - 1)) / 2;
    sum += agree / pairs;
    if (agree === pairs) all++;
    n++;
  }
  const value = n ? sum / n : NaN;
  const ci = n ? clopperPearson(all, n) : ([NaN, NaN] as [number, number]);
  return { value, n, allAgree: n ? all / n : NaN, allAgreeCi: ci };
}

// Two raters: Cohen's kappa, weighted kappa, PABAK ----------------------------------------------

export interface CrossTable {
  categories: string[];
  counts: number[][];
  n: number;
}

export function crossTable(a: Cell[], b: Cell[], categories: string[]): CrossTable {
  const idx = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  const counts = Array.from({ length: k }, () => new Array(k).fill(0));
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (!present(a[i]) || !present(b[i])) continue;
    const x = idx.get(String(a[i]));
    const y = idx.get(String(b[i]));
    if (x === undefined || y === undefined) continue;
    counts[x][y]++;
    n++;
  }
  return { categories, counts, n };
}

export type KappaWeights = 'none' | 'linear' | 'quadratic';

export function agreementWeights(k: number, w: KappaWeights): number[][] {
  return Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => {
      if (w === 'none' || k === 1) return i === j ? 1 : 0;
      const d = Math.abs(i - j) / (k - 1);
      return w === 'linear' ? 1 - d : 1 - d * d;
    }),
  );
}

export interface KappaResult extends Estimate {
  po: number;
  pe: number;
  weights: KappaWeights;
  /** Maximum kappa attainable given the marginals (unweighted only). */
  kappaMax?: number;
  undefinedReason?: string;
}

/**
 * Cohen's kappa (weights 'none') or Cohen's weighted kappa, with the large-sample standard error of
 * Fleiss, Cohen and Everitt (1969), which does not assume kappa = 0.
 */
export function cohenKappa(t: CrossTable, weights: KappaWeights = 'none'): KappaResult {
  const k = t.categories.length;
  const n = t.n;
  if (n === 0) return { value: NaN, n, po: NaN, pe: NaN, weights, undefinedReason: 'no units rated by both raters' };
  const w = agreementWeights(k, weights);
  const p = t.counts.map((r) => r.map((c) => c / n));
  const row = p.map((r) => r.reduce((s, x) => s + x, 0));
  const col = p[0].map((_, j) => p.reduce((s, r) => s + r[j], 0));
  let po = 0;
  let pe = 0;
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      po += w[i][j] * p[i][j];
      pe += w[i][j] * row[i] * col[j];
    }
  if (Math.abs(1 - pe) < 1e-12) {
    return { value: NaN, n, po, pe, weights, undefinedReason: 'chance agreement is 1 (both raters used a single category)' };
  }
  const kappa = (po - pe) / (1 - pe);
  // Fleiss, Cohen and Everitt (1969).
  const wi = row.map((_, i) => col.reduce((s, cj, j) => s + cj * w[i][j], 0));
  const wj = col.map((_, j) => row.reduce((s, ri, i) => s + ri * w[i][j], 0));
  let acc = 0;
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      const term = w[i][j] - (wi[i] + wj[j]) * (1 - kappa);
      acc += p[i][j] * term * term;
    }
  const variance = (acc - Math.pow(kappa - pe * (1 - kappa), 2)) / (n * Math.pow(1 - pe, 2));
  const se = Math.sqrt(Math.max(variance, 0));
  let kappaMax: number | undefined;
  if (weights === 'none') {
    let pmax = 0;
    for (let i = 0; i < k; i++) pmax += Math.min(row[i], col[i]);
    kappaMax = (pmax - pe) / (1 - pe);
  }
  return { value: kappa, se, ci: [kappa - Z95 * se, kappa + Z95 * se], ciMethod: 'asymptotic (Fleiss, Cohen and Everitt, 1969)', n, po, pe, weights, kappaMax };
}

/** Prevalence-adjusted bias-adjusted kappa and the two indices that explain kappa paradoxes. */
export function pabak(t: CrossTable) {
  const k = t.categories.length;
  const n = t.n;
  let po = 0;
  for (let i = 0; i < k; i++) po += t.counts[i][i];
  po /= n || 1;
  const value = k > 1 ? (k * po - 1) / (k - 1) : NaN;
  let prevalenceIndex: number | undefined;
  let biasIndex: number | undefined;
  if (k === 2 && n > 0) {
    const [[a, b], [c, d]] = t.counts;
    prevalenceIndex = Math.abs(a - d) / n;
    biasIndex = Math.abs(b - c) / n;
  }
  return { value, n, po, prevalenceIndex, biasIndex };
}

/** Proportions of specific agreement per category (positive and negative agreement for binary scales). */
export function specificAgreement(m: RatingMatrix, categories: string[]) {
  const out: { category: string; value: number; n: number }[] = [];
  for (const c of categories) {
    let num = 0;
    let den = 0;
    let n = 0;
    for (const row of m.data) {
      const vals = row.filter(present).map(String);
      const r = vals.length;
      if (r < 2) continue;
      const nc = vals.filter((v) => v === c).length;
      num += nc * (nc - 1);
      den += nc * (r - 1);
      if (nc > 0) n++;
    }
    out.push({ category: c, value: den ? num / den : NaN, n });
  }
  return out;
}

// Many raters: Fleiss' kappa, Gwet's AC1 ------------------------------------------------------

export interface FleissResult extends Estimate {
  raters: number;
  pBar: number;
  pe: number;
  /** Fleiss, Nee and Landis (1979) standard error under kappa = 0, for testing only. */
  seNull?: number;
  excludedUnits: number;
  undefinedReason?: string;
}

/**
 * Fleiss' kappa. It assumes every unit has the same number of ratings; units with a different count are
 * excluded and reported. Raters need not be the same people across units.
 */
export function fleissKappa(m: RatingMatrix, categories: string[]): FleissResult {
  const counts = m.data.map((row) => row.filter(present).length);
  const freq = new Map<number, number>();
  for (const c of counts) if (c >= 2) freq.set(c, (freq.get(c) ?? 0) + 1);
  let r = 0;
  let best = 0;
  for (const [c, f] of freq) if (f > best || (f === best && c > r)) [r, best] = [c, f];
  const rows = m.data.filter((_, i) => counts[i] === r);
  const excluded = m.data.filter((_, i) => counts[i] >= 1).length - rows.length;
  const N = rows.length;
  const k = categories.length;
  if (N === 0 || r < 2) return { value: NaN, n: N, raters: r, pBar: NaN, pe: NaN, excludedUnits: excluded, undefinedReason: 'no units with two or more ratings' };
  const idx = new Map(categories.map((c, i) => [c, i]));
  const nij = rows.map((row) => {
    const v = new Array(k).fill(0);
    for (const c of row) if (present(c)) v[idx.get(String(c)) ?? 0]++;
    return v;
  });
  const pj = new Array(k).fill(0).map((_, j) => nij.reduce((s, v) => s + v[j], 0) / (N * r));
  const Pi = nij.map((v) => (v.reduce((s, x) => s + x * x, 0) - r) / (r * (r - 1)));
  const pBar = Pi.reduce((s, x) => s + x, 0) / N;
  const pe = pj.reduce((s, x) => s + x * x, 0);
  if (Math.abs(1 - pe) < 1e-12) return { value: NaN, n: N, raters: r, pBar, pe, excludedUnits: excluded, undefinedReason: 'every rating is in one category' };
  const value = (pBar - pe) / (1 - pe);
  const sumPQ = pj.reduce((s, p) => s + p * (1 - p), 0);
  const sumPQ2 = pj.reduce((s, p) => s + p * (1 - p) * (1 - 2 * p), 0);
  const seNull = sumPQ > 0 ? (Math.sqrt(2) / (sumPQ * Math.sqrt(N * r * (r - 1)))) * Math.sqrt(sumPQ * sumPQ - sumPQ2) : undefined;
  return { value, n: N, raters: r, pBar, pe, seNull, excludedUnits: excluded };
}

export interface AC1Result extends Estimate {
  pa: number;
  pe: number;
  undefinedReason?: string;
}

/** Gwet's AC1 for any number of raters, allowing missing ratings (Gwet, 2014, chapter 4). */
export function gwetAC1(m: RatingMatrix, categories: string[]): AC1Result {
  const q = categories.length;
  const idx = new Map(categories.map((c, i) => [c, i]));
  let paSum = 0;
  let nPa = 0;
  const pi = new Array(q).fill(0);
  let nPi = 0;
  for (const row of m.data) {
    const vals = row.filter(present);
    const ri = vals.length;
    if (ri === 0) continue;
    const rik = new Array(q).fill(0);
    for (const v of vals) rik[idx.get(String(v)) ?? 0]++;
    for (let k = 0; k < q; k++) pi[k] += rik[k] / ri;
    nPi++;
    if (ri >= 2) {
      paSum += rik.reduce((s, x) => s + x * (x - 1), 0) / (ri * (ri - 1));
      nPa++;
    }
  }
  if (nPa === 0 || q < 2) return { value: NaN, n: nPa, pa: NaN, pe: NaN, undefinedReason: q < 2 ? 'fewer than two categories' : 'no units with two or more ratings' };
  const pa = paSum / nPa;
  const pe = pi.reduce((s, x) => s + (x / nPi) * (1 - x / nPi), 0) / (q - 1);
  return { value: (pa - pe) / (1 - pe), n: nPa, pa, pe };
}

// Krippendorff's alpha ---------------------------------------------------------------------------

export type AlphaLevel = 'nominal' | 'ordinal' | 'interval' | 'ratio';

export interface AlphaResult extends Estimate {
  level: AlphaLevel;
  observedDisagreement: number;
  expectedDisagreement: number;
  pairableValues: number;
  undefinedReason?: string;
}

/**
 * Krippendorff's alpha from the coincidence matrix. Units with fewer than two ratings carry no pairable
 * values and drop out, which is how alpha handles missing ratings. For 'ordinal', 'order' gives the
 * scale order of the category codes; for interval and ratio, values must be numeric.
 */
export function krippendorffAlpha(m: RatingMatrix, level: AlphaLevel, order?: string[]): AlphaResult {
  const values: (string | number)[] = [];
  const valIdx = new Map<string, number>();
  const id = (v: string | number) => {
    const k = String(v);
    let i = valIdx.get(k);
    if (i === undefined) {
      i = values.length;
      valIdx.set(k, i);
      values.push(level === 'interval' || level === 'ratio' ? Number(v) : k);
    }
    return i;
  };
  if (order) for (const o of order) id(o);
  const units = m.data.map((row) => row.filter(present).map(id)).filter((u) => u.length >= 2);
  const V = values.length;
  const o = Array.from({ length: V }, () => new Array(V).fill(0));
  for (const u of units) {
    const mu = u.length;
    for (let i = 0; i < mu; i++) for (let j = 0; j < mu; j++) if (i !== j) o[u[i]][u[j]] += 1 / (mu - 1);
  }
  const nc = o.map((r) => r.reduce((s, x) => s + x, 0));
  const n = nc.reduce((s, x) => s + x, 0);
  const base = { level, n: units.length, pairableValues: n };
  if (n <= 1) return { ...base, value: NaN, observedDisagreement: NaN, expectedDisagreement: NaN, undefinedReason: 'fewer than two pairable values' };

  // Distance metric delta^2.
  let rank: number[] | null = null;
  if (level === 'ordinal') {
    const ord = order ?? (values as string[]).slice();
    rank = values.map((v) => ord.indexOf(String(v)));
  }
  const sortedByRank = rank ? values.map((_, i) => i).sort((a, b) => rank![a] - rank![b]) : null;
  const delta = (c: number, k: number): number => {
    if (c === k) return 0;
    switch (level) {
      case 'nominal':
        return 1;
      case 'interval': {
        const d = (values[c] as number) - (values[k] as number);
        return d * d;
      }
      case 'ratio': {
        const a = values[c] as number;
        const b = values[k] as number;
        return a + b === 0 ? 0 : Math.pow((a - b) / (a + b), 2);
      }
      case 'ordinal': {
        const lo = Math.min(rank![c], rank![k]);
        const hi = Math.max(rank![c], rank![k]);
        let s = 0;
        for (const g of sortedByRank!) if (rank![g] >= lo && rank![g] <= hi) s += nc[g];
        s -= (nc[c] + nc[k]) / 2;
        return s * s;
      }
    }
  };
  let Do = 0;
  let De = 0;
  for (let c = 0; c < V; c++)
    for (let k = 0; k < V; k++) {
      if (c === k) continue;
      const d = delta(c, k);
      Do += o[c][k] * d;
      De += nc[c] * nc[k] * d;
    }
  Do /= n;
  De /= n * (n - 1);
  if (De === 0) return { ...base, value: NaN, observedDisagreement: Do, expectedDisagreement: De, undefinedReason: 'no variation: every pairable value is the same' };
  return { ...base, value: 1 - Do / De, observedDisagreement: Do, expectedDisagreement: De };
}

// Intraclass correlation -------------------------------------------------------------------------

export type ICCForm = 'ICC1' | 'ICC1k' | 'ICC_A1' | 'ICC_Ak' | 'ICC_C1' | 'ICC_Ck';

export interface ICCResult {
  form: ICCForm;
  label: string;
  model: string;
  value: number;
  ci: [number, number];
  F: number;
  df1: number;
  df2: number;
  n: number;
  k: number;
}

export interface ICCSet {
  results: ICCResult[];
  n: number;
  k: number;
  excludedUnits: number;
  ms: { rows: number; cols: number; error: number; within: number };
  undefinedReason?: string;
}

/**
 * Intraclass correlations (Shrout and Fleiss, 1979; McGraw and Wong, 1996). Needs a fully crossed design:
 * units missing any rater's value are excluded and counted.
 */
export function icc(m: RatingMatrix, level = 0.95): ICCSet {
  const rows = m.data.filter((r) => r.every((c) => present(c) && Number.isFinite(Number(c)))).map((r) => r.map(Number));
  const n = rows.length;
  const k = m.raters.length;
  const excludedUnits = m.data.length - n;
  const empty = { results: [], n, k, excludedUnits, ms: { rows: NaN, cols: NaN, error: NaN, within: NaN } };
  if (n < 2 || k < 2) return { ...empty, undefinedReason: 'needs at least two units rated by every rater and at least two raters' };
  const grand = rows.flat().reduce((s, x) => s + x, 0) / (n * k);
  const rowMeans = rows.map((r) => r.reduce((s, x) => s + x, 0) / k);
  const colMeans = Array.from({ length: k }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / n);
  const ssr = k * rowMeans.reduce((s, x) => s + (x - grand) ** 2, 0);
  const ssc = n * colMeans.reduce((s, x) => s + (x - grand) ** 2, 0);
  const sst = rows.flat().reduce((s, x) => s + (x - grand) ** 2, 0);
  const sse = sst - ssr - ssc;
  const msr = ssr / (n - 1);
  const msc = ssc / (k - 1);
  const mse = sse / ((n - 1) * (k - 1));
  const msw = (ssc + sse) / (n * (k - 1));
  const a = 1 - level;
  const results: ICCResult[] = [];

  // One-way random.
  {
    const F = msr / msw;
    const df1 = n - 1;
    const df2 = n * (k - 1);
    const FL = F / fQuantile(1 - a / 2, df1, df2);
    const FU = F * fQuantile(1 - a / 2, df2, df1);
    results.push({ form: 'ICC1', label: 'ICC(1)', model: 'one-way random, single rater', value: (msr - msw) / (msr + (k - 1) * msw), ci: [(FL - 1) / (FL + k - 1), (FU - 1) / (FU + k - 1)], F, df1, df2, n, k });
    results.push({ form: 'ICC1k', label: 'ICC(1,k)', model: 'one-way random, mean of k raters', value: (msr - msw) / msr, ci: [1 - 1 / FL, 1 - 1 / FU], F, df1, df2, n, k });
  }
  // Two-way, absolute agreement (random raters).
  {
    const rho = (msr - mse) / (msr + (k - 1) * mse + (k * (msc - mse)) / n);
    const A = (k * rho) / (n * (1 - rho));
    const B = 1 + (k * rho * (n - 1)) / (n * (1 - rho));
    const v = (A * msc + B * mse) ** 2 / ((A * msc) ** 2 / (k - 1) + (B * mse) ** 2 / ((n - 1) * (k - 1)));
    const Fs = fQuantile(1 - a / 2, n - 1, v);
    const Fs2 = fQuantile(1 - a / 2, v, n - 1);
    const L = (n * (msr - Fs * mse)) / (Fs * (k * msc + (k * n - k - n) * mse) + n * msr);
    const U = (n * (Fs2 * msr - mse)) / (k * msc + (k * n - k - n) * mse + n * Fs2 * msr);
    const F = msr / mse;
    results.push({ form: 'ICC_A1', label: 'ICC(A,1)', model: 'two-way random, absolute agreement, single rater (Shrout-Fleiss ICC(2,1))', value: rho, ci: [L, U], F, df1: n - 1, df2: (n - 1) * (k - 1), n, k });
    const sb = (x: number) => (k * x) / (1 + (k - 1) * x);
    results.push({ form: 'ICC_Ak', label: 'ICC(A,k)', model: 'two-way random, absolute agreement, mean of k raters (ICC(2,k))', value: (msr - mse) / (msr + (msc - mse) / n), ci: [sb(L), sb(U)], F, df1: n - 1, df2: (n - 1) * (k - 1), n, k });
  }
  // Two-way, consistency (fixed raters).
  {
    const F = msr / mse;
    const df1 = n - 1;
    const df2 = (n - 1) * (k - 1);
    const FL = F / fQuantile(1 - a / 2, df1, df2);
    const FU = F * fQuantile(1 - a / 2, df2, df1);
    results.push({ form: 'ICC_C1', label: 'ICC(C,1)', model: 'two-way mixed, consistency, single rater (Shrout-Fleiss ICC(3,1))', value: (msr - mse) / (msr + (k - 1) * mse), ci: [(FL - 1) / (FL + k - 1), (FU - 1) / (FU + k - 1)], F, df1, df2, n, k });
    results.push({ form: 'ICC_Ck', label: 'ICC(C,k)', model: 'two-way mixed, consistency, mean of k raters (ICC(3,k))', value: (msr - mse) / msr, ci: [1 - 1 / FL, 1 - 1 / FU], F, df1, df2, n, k });
  }
  return { results, n, k, excludedUnits, ms: { rows: msr, cols: msc, error: mse, within: msw } };
}

// Bootstrap ------------------------------------------------------------------------------------

/**
 * Percentile bootstrap over units (items), the unit of sampling in most adjudication designs.
 * Seeded, so the same data always give the same interval.
 */
export function bootstrapCI(
  m: RatingMatrix,
  stat: (m: RatingMatrix) => number,
  opts: { reps?: number; seed?: string; level?: number } = {},
): { ci: [number, number]; reps: number; valid: number } {
  const reps = opts.reps ?? 1000;
  const level = opts.level ?? 0.95;
  const r = rng(opts.seed ?? 'agreemetry-bootstrap');
  const N = m.data.length;
  const out: number[] = [];
  if (N < 2) return { ci: [NaN, NaN], reps, valid: 0 };
  for (let b = 0; b < reps; b++) {
    const data = new Array(N);
    for (let i = 0; i < N; i++) data[i] = m.data[Math.floor(r() * N)];
    const v = stat({ units: m.units, raters: m.raters, data });
    if (Number.isFinite(v)) out.push(v);
  }
  out.sort((x, y) => x - y);
  const a = (1 - level) / 2;
  return { ci: [quantileSorted(out, a), quantileSorted(out, 1 - a)], reps, valid: out.length };
}

// Classification against a reference ---------------------------------------------------------------

export interface BinaryAccuracy {
  positive: string;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  n: number;
  sensitivity: Estimate;
  specificity: Estimate;
  ppv: Estimate;
  npv: Estimate;
  accuracy: Estimate;
}

function prop(k: number, n: number): Estimate {
  return { value: n ? k / n : NaN, ci: clopperPearson(k, n), ciMethod: 'exact (Clopper-Pearson)', n };
}

/** Accuracy of a test rating against a criterion rating (for example a classifier against human consensus). */
export function binaryAccuracy(test: Cell[], criterion: Cell[], positive: string): BinaryAccuracy {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < test.length; i++) {
    if (!present(test[i]) || !present(criterion[i])) continue;
    const t = String(test[i]) === positive;
    const c = String(criterion[i]) === positive;
    if (t && c) tp++;
    else if (t && !c) fp++;
    else if (!t && c) fn++;
    else tn++;
  }
  const n = tp + fp + fn + tn;
  return { positive, tp, fp, fn, tn, n, sensitivity: prop(tp, tp + fn), specificity: prop(tn, tn + fp), ppv: prop(tp, tp + fp), npv: prop(tn, tn + fn), accuracy: prop(tp + tn, n) };
}

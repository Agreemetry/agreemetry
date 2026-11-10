/**
 * Reliability statistics against published worked examples and independent implementations
 * (scikit-learn, statsmodels, the krippendorff package, scipy); see tests/reference/make_fixtures.py.
 */
import { describe, expect, it } from 'vitest';
import fx from './reference/fixtures.json';
import { betaInv, fQuantile, normalQuantile, clopperPearson } from '../src/core/stats/dist';
import { cohenKappa, crossTable, fleissKappa, gwetAC1, icc, krippendorffAlpha, pabak, percentAgreement, type RatingMatrix } from '../src/core/stats/irr';

const M = (rows: (string | number | null)[][]): RatingMatrix => ({ units: rows.map((_, i) => `u${i}`), raters: rows[0].map((_, j) => `r${j}`), data: rows });

describe('distributions', () => {
  it('F quantiles match scipy', () => {
    for (const [p, d1, d2, q] of fx.dist.f_quantiles) expect(fQuantile(p, d1, d2)).toBeCloseTo(q, 6);
  });
  it('beta quantiles match scipy', () => {
    for (const [p, a, b, q] of fx.dist.beta_quantiles) expect(betaInv(p, a, b)).toBeCloseTo(q, 8);
  });
  it('normal quantiles match scipy', () => {
    for (const [p, q] of fx.dist.normal_quantiles) expect(normalQuantile(p)).toBeCloseTo(q, 6);
  });
  it('Clopper-Pearson for 0 of 10 and 10 of 10', () => {
    expect(clopperPearson(0, 10)[0]).toBe(0);
    expect(clopperPearson(0, 10)[1]).toBeCloseTo(0.3084971, 6);
    expect(clopperPearson(10, 10)[0]).toBeCloseTo(0.6915029, 6);
  });
});

describe("Cohen's kappa", () => {
  it('textbook example: 50 items, po 0.70, pe 0.50, kappa 0.40', () => {
    const t = { categories: ['yes', 'no'], counts: [[20, 5], [10, 15]], n: 50 };
    const k = cohenKappa(t);
    expect(k.po).toBeCloseTo(0.7, 12);
    expect(k.pe).toBeCloseTo(0.5, 12);
    expect(k.value).toBeCloseTo(0.4, 12);
  });
  for (const w of ['none', 'linear', 'quadratic'] as const) {
    it(`${w} weights match scikit-learn and the statsmodels standard error`, () => {
      const two = fx.two_raters;
      const t = crossTable(two.a, two.b, two.categories);
      const k = cohenKappa(t, w);
      expect(k.value).toBeCloseTo(two[w].kappa, 10);
      expect(k.value).toBeCloseTo(two[w].sm_kappa, 10);
      expect(k.se!).toBeCloseTo(two[w].se, 10);
    });
  }
  it('kappa paradox: high raw agreement, near-zero kappa, high AC1 and PABAK', () => {
    const s = fx.skewed_binary;
    const t = { categories: ['1', '0'], counts: s.table, n: 125 };
    expect(cohenKappa(t).value).toBeCloseTo(s.kappa, 10);
    expect(pabak(t).value).toBeCloseTo(s.pabak, 10);
    const rows: string[][] = [];
    s.table.forEach((r, i) => r.forEach((c, j) => { for (let x = 0; x < c; x++) rows.push([i === 0 ? '1' : '0', j === 0 ? '1' : '0']); }));
    expect(gwetAC1(M(rows), ['1', '0']).value).toBeCloseTo(s.ac1, 10);
  });
  it('undefined when both raters use one category', () => {
    const k = cohenKappa({ categories: ['a', 'b'], counts: [[10, 0], [0, 0]], n: 10 });
    expect(Number.isNaN(k.value)).toBe(true);
    expect(k.undefinedReason).toMatch(/chance agreement/);
  });
});

describe("Fleiss' kappa", () => {
  it('Fleiss (1971) example: 10 subjects, 14 raters, kappa 0.210', () => {
    const counts = [[0, 0, 0, 0, 14], [0, 2, 6, 4, 2], [0, 0, 3, 5, 6], [0, 3, 9, 2, 0], [2, 2, 8, 1, 1], [7, 7, 0, 0, 0], [3, 2, 6, 3, 0], [2, 5, 3, 2, 2], [6, 5, 2, 1, 0], [0, 2, 2, 3, 7]];
    const rows = counts.map((c) => c.flatMap((n, j) => Array(n).fill(String(j + 1))));
    const f = fleissKappa(M(rows), ['1', '2', '3', '4', '5']);
    expect(f.value).toBeCloseTo(0.20993, 4);
    expect(f.pBar).toBeCloseTo(0.378, 3);
    expect(f.pe).toBeCloseTo(0.213, 3);
  });
  it('matches statsmodels on simulated three-rater data', () => {
    const r = fx.three_raters;
    expect(fleissKappa(M(r.matrix), r.categories).value).toBeCloseTo(r.fleiss, 10);
  });
  it('excludes units with a different number of ratings and reports them', () => {
    const f = fleissKappa(M([['a', 'a', 'a'], ['a', 'b', null], ['b', 'b', 'b'], ['a', 'b', 'b']]), ['a', 'b']);
    expect(f.excludedUnits).toBe(1);
    expect(f.n).toBe(3);
  });
});

describe("Gwet's AC1", () => {
  it('matches an independent implementation, complete and with missing ratings', () => {
    expect(gwetAC1(M(fx.three_raters.matrix), fx.three_raters.categories).value).toBeCloseTo(fx.three_raters.ac1, 10);
    expect(gwetAC1(M(fx.alpha_random.matrix), fx.alpha_random.order).value).toBeCloseTo(fx.alpha_random.ac1, 10);
  });
});

describe("Krippendorff's alpha", () => {
  // Krippendorff (2011), "Computing Krippendorff's alpha-reliability": 4 observers, 12 units, missing data.
  const K = [
    [1, 1, null, 1], [2, 2, 3, 2], [3, 3, 3, 3], [3, 3, 3, 3], [2, 2, 2, 2], [1, 2, 3, 4], [4, 4, 4, 4], [1, 1, 2, 1], [2, 2, 2, 2], [null, 5, 5, 5], [null, null, 1, 1], [null, 3, null, null],
  ];
  const published = { nominal: 0.743, ordinal: 0.815, interval: 0.849, ratio: 0.797 } as const;
  for (const level of ['nominal', 'ordinal', 'interval', 'ratio'] as const) {
    it(`published ${level} value ${published[level]} (and the krippendorff package)`, () => {
      const m = M(level === 'nominal' || level === 'ordinal' ? K.map((r) => r.map((x) => (x === null ? null : String(x)))) : K);
      const a = krippendorffAlpha(m, level, level === 'ordinal' ? ['1', '2', '3', '4', '5'] : undefined).value;
      expect(a).toBeCloseTo(published[level], 3);
      expect(a).toBeCloseTo(fx.kripp2011_package[level], 10);
    });
  }
  for (const level of ['nominal', 'ordinal', 'interval', 'ratio'] as const) {
    it(`${level} matches the krippendorff package on simulated data with 25% missing`, () => {
      const raw = fx.alpha_random.matrix;
      const m = M(level === 'interval' || level === 'ratio' ? raw.map((r) => r.map((x) => (x === null ? null : Number(x)))) : raw);
      expect(krippendorffAlpha(m, level, level === 'ordinal' ? fx.alpha_random.order : undefined).value).toBeCloseTo(fx.alpha_random[level], 10);
    });
  }
  it('undefined without variation', () => {
    const a = krippendorffAlpha(M([['a', 'a'], ['a', 'a']]), 'nominal');
    expect(Number.isNaN(a.value)).toBe(true);
  });
});

describe('intraclass correlation', () => {
  it('Shrout and Fleiss (1979) published values', () => {
    const r = Object.fromEntries(icc(M(fx.icc_shrout_fleiss.matrix)).results.map((x) => [x.form, x.value]));
    expect(r.ICC1).toBeCloseTo(0.17, 2);
    expect(r.ICC_A1).toBeCloseTo(0.29, 2);
    expect(r.ICC_C1).toBeCloseTo(0.71, 2);
    expect(r.ICC1k).toBeCloseTo(0.44, 2);
    expect(r.ICC_Ak).toBeCloseTo(0.62, 2);
    expect(r.ICC_Ck).toBeCloseTo(0.91, 2);
  });
  for (const key of ['icc_shrout_fleiss', 'icc_random'] as const) {
    it(`${key}: values and F intervals match scipy`, () => {
      const res = icc(M(fx[key].matrix)).results;
      for (const x of res) {
        const [v, lo, hi] = (fx[key] as unknown as Record<string, number[]>)[x.form];
        expect(x.value).toBeCloseTo(v, 10);
        expect(x.ci[0]).toBeCloseTo(lo, 6);
        expect(x.ci[1]).toBeCloseTo(hi, 6);
      }
    });
  }
  it('excludes incomplete units', () => {
    const s = icc(M([[1, 2], [2, 3], [3, null], [4, 5]]));
    expect(s.excludedUnits).toBe(1);
    expect(s.n).toBe(3);
  });
});

describe('raw agreement', () => {
  it('mean pairwise agreement and all-agree share', () => {
    const p = percentAgreement(M([['a', 'a', 'a'], ['a', 'a', 'b'], ['a', 'b', null], ['a', null, null]]));
    expect(p.n).toBe(3);
    expect(p.value).toBeCloseTo((1 + 1 / 3 + 0) / 3, 12);
    expect(p.allAgree).toBeCloseTo(1 / 3, 12);
  });
});

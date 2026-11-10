/**
 * Distribution functions needed for confidence intervals: normal, regularized incomplete beta,
 * F and beta quantiles. Algorithms: Acklam (normal quantile), Lentz continued fraction for the
 * incomplete beta (Numerical Recipes, 3rd ed., 6.4), and safeguarded Newton/bisection for inverses.
 */

export function lnGamma(x: number): number {
  // Lanczos approximation, g = 7, n = 9.
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const EPS = 1e-15;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 10000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lbt);
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Inverse of the regularized incomplete beta: x with I_x(a, b) = p. */
export function betaInv(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let x = a / (a + b);
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  for (let i = 0; i < 200; i++) {
    const f = betaInc(x, a, b) - p;
    if (Math.abs(f) < 1e-14) return x;
    if (f > 0) hi = x;
    else lo = x;
    const dens = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lbeta);
    let nx = dens > 0 && Number.isFinite(dens) ? x - f / dens : NaN;
    if (!(nx > lo && nx < hi)) nx = (lo + hi) / 2;
    if (Math.abs(nx - x) < 1e-15) return nx;
    x = nx;
  }
  return x;
}

/** Upper-tail-free F quantile: value q with P(F(d1, d2) <= q) = p. */
export function fQuantile(p: number, d1: number, d2: number): number {
  if (!Number.isFinite(d2) || d2 > 1e7) {
    // F(d1, inf) = chi2(d1)/d1; approximate with a large d2.
    d2 = 1e7;
  }
  const x = betaInv(p, d1 / 2, d2 / 2);
  return (d2 * x) / (d1 * (1 - x));
}

export function fCdf(f: number, d1: number, d2: number): number {
  if (f <= 0) return 0;
  return betaInc((d1 * f) / (d1 * f + d2), d1 / 2, d2 / 2);
}

/** Standard normal quantile (Acklam), refined by one Halley step. */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number;
  let x: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** erfc with relative error below 1.2e-7 (Numerical Recipes erfcc), sufficient for p values and intervals. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Clopper-Pearson exact interval for a binomial proportion. */
export function clopperPearson(k: number, n: number, level = 0.95): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const a = 1 - level;
  const lo = k === 0 ? 0 : betaInv(a / 2, k, n - k + 1);
  const hi = k === n ? 1 : betaInv(1 - a / 2, k + 1, n - k);
  return [lo, hi];
}

/** Wilson score interval for a binomial proportion. */
export function wilson(k: number, n: number, level = 0.95): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const z = normalQuantile(1 - (1 - level) / 2);
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

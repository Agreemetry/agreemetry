"""Reference values for Agreemetry's reliability statistics, from independent implementations.

Run:  python -I tests/reference/make_fixtures.py
Needs numpy, scipy, scikit-learn, statsmodels and krippendorff. Writes tests/reference/fixtures.json.

Sources of truth
  - Cohen's kappa and weighted kappa: scikit-learn cohen_kappa_score; asymptotic SE from statsmodels cohens_kappa.
  - Fleiss' kappa: statsmodels fleiss_kappa.
  - Krippendorff's alpha: the krippendorff package (Castro), all four levels, with missing ratings.
  - ICC: ANOVA mean squares with McGraw and Wong (1996) intervals computed here with scipy's F quantiles
    (an implementation independent of the TypeScript one), checked against Shrout and Fleiss (1979).
  - Gwet's AC1: Gwet (2014) formulas written here independently.
Published examples are hard-coded in the TypeScript tests (Krippendorff 2011; Fleiss 1971 as reproduced on
Wikipedia; Shrout and Fleiss 1979).
"""
import json
from pathlib import Path

import krippendorff
import numpy as np
from scipy import stats
from sklearn.metrics import cohen_kappa_score
from statsmodels.stats.inter_rater import cohens_kappa, fleiss_kappa

rng = np.random.default_rng(20261109)
out = {}

# Two raters, four ordered categories --------------------------------------------------------
truth = rng.integers(0, 4, 200)
a = np.where(rng.random(200) < 0.75, truth, np.clip(truth + rng.choice([-1, 1], 200), 0, 3))
b = np.where(rng.random(200) < 0.65, truth, np.clip(truth + rng.choice([-1, 1, 2], 200), 0, 3))
cats = [0, 1, 2, 3]
table = np.zeros((4, 4))
for x, y in zip(a, b):
    table[x, y] += 1
two = {"a": a.astype(str).tolist(), "b": b.astype(str).tolist(), "categories": [str(c) for c in cats]}
for w, sk in (("none", None), ("linear", "linear"), ("quadratic", "quadratic")):
    k = cohen_kappa_score(a, b, labels=cats, weights=sk)
    res = cohens_kappa(table, wt=None if w == "none" else w)
    two[w] = {"kappa": float(k), "se": float(res["std_kappa"]), "sm_kappa": float(res["kappa"])}
out["two_raters"] = two

# Skewed binary (kappa paradox) -------------------------------------------------------------
t2 = np.array([[118, 5], [2, 0]], dtype=float)
x = np.repeat([1, 1, 0, 0], t2.flatten().astype(int))
y = np.repeat([1, 0, 1, 0], t2.flatten().astype(int))
po = (t2[0, 0] + t2[1, 1]) / t2.sum()
q = ((t2[0].sum() + t2[:, 0].sum()) / (2 * t2.sum()))
pe_ac1 = 2 * q * (1 - q)
out["skewed_binary"] = {"table": t2.tolist(), "kappa": float(cohen_kappa_score(x, y)), "ac1": float((po - pe_ac1) / (1 - pe_ac1)), "pabak": float(2 * po - 1)}

# Three raters, three nominal categories, complete ------------------------------------------
truth = rng.integers(0, 3, 120)
m3 = np.stack([np.where(rng.random(120) < acc, truth, rng.integers(0, 3, 120)) for acc in (0.8, 0.7, 0.6)], axis=1)
counts = np.stack([(m3 == c).sum(axis=1) for c in range(3)], axis=1)
out["three_raters"] = {"matrix": m3.astype(str).tolist(), "categories": ["0", "1", "2"], "fleiss": float(fleiss_kappa(counts, method="fleiss"))}


def ac1(matrix, categories):
    """Gwet (2014) AC1 for any raters, missing allowed (None)."""
    q = len(categories)
    pa_terms, pi = [], np.zeros(q)
    n_units = 0
    for row in matrix:
        vals = [v for v in row if v is not None]
        r = len(vals)
        if r == 0:
            continue
        rik = np.array([sum(1 for v in vals if v == c) for c in categories], dtype=float)
        pi += rik / r
        n_units += 1
        if r >= 2:
            pa_terms.append((rik * (rik - 1)).sum() / (r * (r - 1)))
    pa = float(np.mean(pa_terms))
    pi /= n_units
    pe = float((pi * (1 - pi)).sum() / (q - 1))
    return (pa - pe) / (1 - pe)


out["three_raters"]["ac1"] = ac1(m3.astype(str).tolist(), ["0", "1", "2"])

# Krippendorff's alpha, five raters, missing, every level -------------------------------------
truth = rng.integers(1, 6, 80).astype(float)
mk = np.stack([np.where(rng.random(80) < 0.7, truth, rng.integers(1, 6, 80)) for _ in range(5)], axis=1).astype(float)
mask = rng.random(mk.shape) < 0.25
mk[mask] = np.nan
alpha = {}
for level in ("nominal", "ordinal", "interval", "ratio"):
    alpha[level] = float(krippendorff.alpha(reliability_data=mk.T, level_of_measurement=level, value_domain=[1, 2, 3, 4, 5]))
missing_matrix = [[None if np.isnan(v) else str(int(v)) for v in row] for row in mk]
out["alpha_random"] = {"matrix": missing_matrix, "order": ["1", "2", "3", "4", "5"], **alpha, "ac1": ac1(missing_matrix, ["1", "2", "3", "4", "5"])}

# Krippendorff (2011) published example, also through the package ------------------------------
K = np.array([
    [1, 2, 3, 3, 2, 1, 4, 1, 2, np.nan, np.nan, np.nan],
    [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, np.nan, 3],
    [np.nan, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, np.nan],
    [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, np.nan],
])
out["kripp2011_package"] = {lv: float(krippendorff.alpha(reliability_data=K, level_of_measurement=lv)) for lv in ("nominal", "ordinal", "interval", "ratio")}

# ICC, Shrout and Fleiss (1979) and a random crossed design --------------------------------------


def icc_all(Y, level=0.95):
    n, k = Y.shape
    g = Y.mean()
    ssr = k * ((Y.mean(axis=1) - g) ** 2).sum()
    ssc = n * ((Y.mean(axis=0) - g) ** 2).sum()
    sse = ((Y - g) ** 2).sum() - ssr - ssc
    msr, msc, mse = ssr / (n - 1), ssc / (k - 1), sse / ((n - 1) * (k - 1))
    msw = (ssc + sse) / (n * (k - 1))
    a = 1 - level
    f = lambda p, d1, d2: stats.f.ppf(p, d1, d2)
    res = {}
    F = msr / msw
    FL, FU = F / f(1 - a / 2, n - 1, n * (k - 1)), F * f(1 - a / 2, n * (k - 1), n - 1)
    res["ICC1"] = [(msr - msw) / (msr + (k - 1) * msw), (FL - 1) / (FL + k - 1), (FU - 1) / (FU + k - 1)]
    res["ICC1k"] = [(msr - msw) / msr, 1 - 1 / FL, 1 - 1 / FU]
    F = msr / mse
    FL, FU = F / f(1 - a / 2, n - 1, (n - 1) * (k - 1)), F * f(1 - a / 2, (n - 1) * (k - 1), n - 1)
    res["ICC_C1"] = [(msr - mse) / (msr + (k - 1) * mse), (FL - 1) / (FL + k - 1), (FU - 1) / (FU + k - 1)]
    res["ICC_Ck"] = [(msr - mse) / msr, 1 - 1 / FL, 1 - 1 / FU]
    rho = (msr - mse) / (msr + (k - 1) * mse + k * (msc - mse) / n)
    A = k * rho / (n * (1 - rho))
    B = 1 + k * rho * (n - 1) / (n * (1 - rho))
    v = (A * msc + B * mse) ** 2 / ((A * msc) ** 2 / (k - 1) + (B * mse) ** 2 / ((n - 1) * (k - 1)))
    Fs, Fs2 = f(1 - a / 2, n - 1, v), f(1 - a / 2, v, n - 1)
    L = n * (msr - Fs * mse) / (Fs * (k * msc + (k * n - k - n) * mse) + n * msr)
    U = n * (Fs2 * msr - mse) / (k * msc + (k * n - k - n) * mse + n * Fs2 * msr)
    res["ICC_A1"] = [rho, L, U]
    sb = lambda x: k * x / (1 + (k - 1) * x)
    res["ICC_Ak"] = [(msr - mse) / (msr + (msc - mse) / n), sb(L), sb(U)]
    return {key: [float(x) for x in val] for key, val in res.items()}


SF = np.array([[9, 2, 5, 8], [6, 1, 3, 2], [8, 4, 6, 8], [7, 1, 2, 6], [10, 5, 6, 9], [6, 2, 4, 7]], dtype=float)
out["icc_shrout_fleiss"] = {"matrix": SF.tolist(), **icc_all(SF)}
truth = rng.normal(50, 10, 40)
Y = np.stack([truth + rng.normal(0, 4, 40) + shift for shift in (0, 2, -1)], axis=1).round(1)
out["icc_random"] = {"matrix": Y.tolist(), **icc_all(Y)}

# Distribution checks --------------------------------------------------------------------------
out["dist"] = {
    "f_quantiles": [[p, d1, d2, float(stats.f.ppf(p, d1, d2))] for p, d1, d2 in ((0.975, 5, 18), (0.975, 18, 5), (0.95, 1, 1000), (0.5, 3.7, 12.2))],
    "beta_quantiles": [[p, a_, b_, float(stats.beta.ppf(p, a_, b_))] for p, a_, b_ in ((0.025, 3, 98), (0.975, 4, 97), (0.5, 0.5, 0.5))],
    "normal_quantiles": [[p, float(stats.norm.ppf(p))] for p in (0.975, 0.5, 0.001, 0.999999)],
}

Path(__file__).with_name("fixtures.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
print("wrote fixtures:", ", ".join(out))
print("Krippendorff 2011 via package:", {k: round(v, 3) for k, v in out["kripp2011_package"].items()})
print("Shrout-Fleiss ICC:", {k: [round(x, 2) for x in v] for k, v in out["icc_shrout_fleiss"].items() if k != "matrix"})

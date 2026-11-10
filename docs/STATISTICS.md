# Statistical methods and validation

## Data that enter reliability

One rating per adjudicator per item: the **submitted independent judgment**.

- Draft judgments never enter.
- Agreed and resolved values are stored separately and never replace independent judgments.
- A submitted judgment can change only before disclosure, if the project allows it. The change carries a reason and every version is kept. After disclosure it is locked, so reliability always describes judgments made without sight of anyone else's.

## Choosing coefficients

Agreemetry recommends a primary coefficient from the design and shows the others as checks.

| Scale | Same two raters on every item | Several raters, or raters varying across items |
|---|---|---|
| Binary or nominal | Cohen's kappa; Krippendorff's alpha, Gwet's AC1 and the prevalence- and bias-adjusted kappa as checks | Fleiss' kappa when every item has the same number of ratings, otherwise Krippendorff's alpha; AC1 as a check |
| Ordinal | Weighted kappa (quadratic by default, linear if chosen); ordinal alpha | Krippendorff's ordinal alpha; Fleiss' kappa as a nominal check |
| Numeric | ICC(A,1) when every rater rates every item, with the consistency and average forms; interval or ratio alpha | ICC(1) or interval alpha |
| Multi-label | Each label analysed as present or absent, plus the share of identical label sets | Same |

Raw agreement (the mean share of agreeing rater pairs) is always reported and labelled as not chance-corrected.

## Formulas and intervals

| Statistic | Source | Interval |
|---|---|---|
| Cohen's kappa, weighted kappa | Cohen (1960, 1968); agreement weights 1 - abs(i - j)/(k - 1) or 1 - ((i - j)/(k - 1))^2 | Wald interval with the large-sample variance of Fleiss, Cohen and Everitt (1969), which does not assume kappa = 0 |
| Prevalence- and bias-adjusted kappa; prevalence and bias indices | Byrt, Bishop and Carlin (1993) | None |
| Fleiss' kappa | Fleiss (1971) | Percentile bootstrap over items |
| Gwet's AC1 | Gwet (2008; 2014, chapter 4), with missing ratings | Percentile bootstrap over items |
| Krippendorff's alpha | Coincidence matrix; nominal, ordinal, interval and ratio distances (Krippendorff, 2019) | Percentile bootstrap over items |
| Intraclass correlations | Shrout and Fleiss (1979); McGraw and Wong (1996): ICC(1), ICC(1,k), ICC(A,1), ICC(A,k), ICC(C,1), ICC(C,k) | F-distribution intervals (McGraw and Wong, 1996), with the Satterthwaite approximation for absolute agreement |
| Specific agreement | Proportion of specific agreement per category | None |
| Accuracy against a reference | Sensitivity, specificity, predictive values, accuracy | Exact Clopper-Pearson |

Bootstrap intervals use 1,000 resamples by default (adjustable). They are seeded with the project seed, so the same data always give the same interval.

## Missing ratings

| Statistic | Items used |
|---|---|
| Raw agreement, AC1, Krippendorff's alpha | Every item with two or more ratings |
| Cohen's kappa | Items rated by both raters |
| Fleiss' kappa | Items with the most common number of ratings; the others are counted and reported as excluded |
| Intraclass correlations | Items rated by every rater; excluded items are reported |

## Warnings Agreemetry raises

- Undefined coefficients, with the reason: for example, chance agreement equals 1 when both raters used one category.
- Fewer than 30 items rated twice.
- A skewed prevalence (prevalence index of 0.6 or more): kappa can be low while raw agreement is high (the kappa paradox).
- Rater bias (bias index of 0.1 or more).
- A low maximum attainable kappa.
- Items excluded from Fleiss' kappa or from the intraclass correlations.
- Empty rater-item cells.
- When raters vary across items, Cohen's kappa does not apply.

Interpretation bands (Landis and Koch, 1977) are shown as conventions, not standards.

## Validation

`npm test` runs `tests/stats.test.ts` against two sources.

**Published worked examples:**

- Krippendorff (2011), four observers and twelve units with missing data: alpha 0.743 (nominal), 0.815 (ordinal), 0.849 (interval), 0.797 (ratio);
- Fleiss (1971), ten subjects and fourteen raters: kappa 0.210;
- Shrout and Fleiss (1979), six targets and four judges: ICC 0.17, 0.29, 0.71, 0.44, 0.62, 0.91;
- the textbook two-rater example: kappa 0.40.

**Independent implementations** (`tests/reference/make_fixtures.py`, matched to ten decimals):

| Implementation | Checks |
|---|---|
| scikit-learn `cohen_kappa_score` | Kappa, linear and quadratic weighted kappa |
| statsmodels `cohens_kappa` | The asymptotic standard errors |
| statsmodels `fleiss_kappa` | Fleiss' kappa |
| The `krippendorff` package | Alpha at all four levels, with 25% of ratings missing |
| scipy F, beta and normal quantiles | The interval machinery |
| An independent Python implementation of Gwet's formulas | AC1 |

## References

- Byrt, T., Bishop, J., and Carlin, J. B. (1993). Bias, prevalence and kappa. *Journal of Clinical Epidemiology*, 46(5), 423 to 429.
- Cohen, J. (1960). A coefficient of agreement for nominal scales. *Educational and Psychological Measurement*, 20(1), 37 to 46.
- Cohen, J. (1968). Weighted kappa. *Psychological Bulletin*, 70(4), 213 to 220.
- Fleiss, J. L. (1971). Measuring nominal scale agreement among many raters. *Psychological Bulletin*, 76(5), 378 to 382.
- Fleiss, J. L., Cohen, J., and Everitt, B. S. (1969). Large sample standard errors of kappa and weighted kappa. *Psychological Bulletin*, 72(5), 323 to 327.
- Gwet, K. L. (2008). Computing inter-rater reliability and its variance in the presence of high agreement. *British Journal of Mathematical and Statistical Psychology*, 61(1), 29 to 48.
- Gwet, K. L. (2014). *Handbook of inter-rater reliability* (4th ed.). Advanced Analytics.
- Krippendorff, K. (2011). Computing Krippendorff's alpha-reliability. University of Pennsylvania.
- Krippendorff, K. (2019). *Content analysis: An introduction to its methodology* (4th ed.). Sage.
- Landis, J. R., and Koch, G. G. (1977). The measurement of observer agreement for categorical data. *Biometrics*, 33(1), 159 to 174.
- McGraw, K. O., and Wong, S. P. (1996). Forming inferences about some intraclass correlation coefficients. *Psychological Methods*, 1(1), 30 to 46.
- Shrout, P. E., and Fleiss, J. L. (1979). Intraclass correlations: Uses in assessing rater reliability. *Psychological Bulletin*, 86(2), 420 to 428.

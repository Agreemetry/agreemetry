import { useMemo, useState } from 'react';
import type { ProjectView } from '../app';
import { Empty, Field, Notice, Seg } from '../components';
import { CategoryBars, CrossHeat, ForestPlot } from '../charts';
import { analyzeVariable, compareReferences, landisKoch, primaryStat, type VariableReliability } from '../../core/analysis';
import { fmt, pct } from '../../core/util';
import type { Item } from '../../core/types';

export function Reliability({ v }: { v: ProjectView }) {
  const { data } = v;
  const p = data.project;
  const vars = p.config.variables.filter((x) => x.type !== 'text' && x.includeInAgreement);
  const [vid, setVid] = useState(vars[0]?.id ?? '');
  const [batch, setBatch] = useState('');
  const [fKey, setFKey] = useState('');
  const [fVal, setFVal] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const [reps, setReps] = useState(1000);
  const batches = useMemo(() => [...new Set(data.items.map((i) => i.batch))].sort(), [data.items]);
  const keys = useMemo(() => [...new Set(data.items.flatMap((i) => Object.keys(i.fields)))].filter((k) => {
    const vals = new Set(data.items.map((i) => String(i.fields[k] ?? '')));
    return vals.size >= 1 && vals.size <= 40;
  }), [data.items]);
  const vals = useMemo(() => (fKey ? [...new Set(data.items.map((i) => String(i.fields[fKey] ?? '')))].sort() : []), [fKey, data.items]);
  const filter = (i: Item) => (!batch || i.batch === batch) && (!fKey || !fVal || String(i.fields[fKey] ?? '') === fVal);
  const variable = vars.find((x) => x.id === vid);
  const res = useMemo(() => (variable ? analyzeVariable(data, variable, { bootstrapReps: reps, seed: p.config.assignment.seed, itemFilter: filter }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, vid, batch, fKey, fVal, reps]);
  const groups = useMemo(() => {
    if (!variable || !groupBy) return [];
    const levels = [...new Set(data.items.filter(filter).map((i) => String(i.fields[groupBy] ?? i[groupBy as keyof Item] ?? '')))].sort();
    return levels.map((lv) => {
      const r = analyzeVariable(data, variable, { bootstrapReps: Math.min(reps, 500), seed: p.config.assignment.seed, itemFilter: (i) => filter(i) && String(i.fields[groupBy] ?? i[groupBy as keyof Item] ?? '') === lv });
      const s = primaryStat(r) ?? r.parts?.[0]?.stats[0];
      return { label: lv || '(empty)', value: s?.value ?? NaN, lo: s?.ci?.[0], hi: s?.ci?.[1], n: r.design.unitsRatedTwice, note: s?.name, pa: r.stats.find((x) => x.id === 'pa')?.value };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, vid, groupBy, batch, fKey, fVal, reps]);
  const refs = useMemo(() => compareReferences(data, v.statuses, filter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, v.statuses, batch, fKey, fVal]);

  if (!vars.length) return <Empty title="No variables are compared for agreement" />;
  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Interrater reliability</h1>
          <p>Computed only from the submitted independent judgments, before any consensus; resolved values never replace them. Draft judgments are ignored. Results update as judgments come in.</p>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <Field label="Variable">
            <select value={vid} onChange={(e) => setVid(e.target.value)}>
              {vars.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </Field>
          <Field label="Batch">
            <select value={batch} onChange={(e) => setBatch(e.target.value)}>
              <option value="">All</option>
              {batches.map((b) => <option key={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="Restrict by field">
            <select value={fKey} onChange={(e) => { setFKey(e.target.value); setFVal(''); }}>
              <option value="">No restriction</option>
              {keys.map((k) => <option key={k} value={k}>{k}{p.config.display.blindedFields.includes(k) ? ' (blinded)' : ''}</option>)}
            </select>
          </Field>
          {fKey && (
            <Field label="Value">
              <select value={fVal} onChange={(e) => setFVal(e.target.value)}>
                <option value="">Any</option>
                {vals.map((x) => <option key={x} value={x}>{x || '(empty)'}</option>)}
              </select>
            </Field>
          )}
          <Field label="Subgroups">
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value="">None</option>
              <option value="batch">batch</option>
              {keys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>
          <Field label="Bootstrap resamples">
            <select value={reps} onChange={(e) => setReps(Number(e.target.value))}>
              {[200, 1000, 2000, 5000].map((r) => <option key={r} value={r}>{r.toLocaleString()}</option>)}
            </select>
          </Field>
        </div>
      </div>
      {res && <VariableReport r={res} v={v} />}
      {groups.length > 0 && (
        <div className="card">
          <h2>By {groupBy}</h2>
          <p className="small muted">Primary coefficient per subgroup with 95% interval. Small subgroups give wide or undefined intervals; subgroup differences are descriptive unless planned.</p>
          <ForestPlot rows={groups} />
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="data">
              <thead><tr><th>{groupBy}</th><th>Coefficient</th><th className="num">Value</th><th className="num">95% interval</th><th className="num">Raw agreement</th><th className="num">Items</th></tr></thead>
              <tbody>{groups.map((g) => <tr key={g.label}><td>{g.label}</td><td>{g.note}</td><td className="num">{fmt(g.value)}</td><td className="num">{g.lo !== undefined ? `${fmt(g.lo)} to ${fmt(g.hi)}` : ''}</td><td className="num">{g.pa !== undefined ? pct(g.pa) : ''}</td><td className="num">{g.n}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
      {refs.length > 0 && <References refs={refs} v={v} />}
      <Methods />
    </div>
  );
}

function VariableReport({ r, v }: { r: VariableReliability; v: ProjectView }) {
  const [view, setView] = useState<'chart' | 'table'>('table');
  if (r.parts) {
    return (
      <div className="stack">
        <div className="card">
          <h2>{r.label}</h2>
          <Notice tone="info">{r.recommendation}</Notice>
          <p className="small" style={{ marginTop: 8 }}>Identical label sets: <strong>{pct(r.stats[0]?.value)}</strong> of rater pairs ({r.stats[0]?.n} items).</p>
          <ForestPlot rows={r.parts.map((q) => { const s = primaryStat(q)!; return { label: q.label.split(': ').slice(-1)[0], value: s.value, lo: s.ci?.[0], hi: s.ci?.[1], n: s.n, note: s.name }; })} />
        </div>
        {r.parts.map((q) => <VariableReport key={q.variableId} r={q} v={v} />)}
      </div>
    );
  }
  const primary = primaryStat(r);
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2 className="grow">{r.label}</h2>
        <Seg label="Display" value={view} onChange={setView} options={[{ value: 'table', label: 'Table' }, { value: 'chart', label: 'Chart' }]} />
      </div>
      <div className="grid tiles" style={{ marginBottom: 12 }}>
        <div className="tile accent">
          <div className="label">{primary?.name ?? 'Primary coefficient'}</div>
          <div className="value num">{fmt(primary?.value)}</div>
          <div className="sub">{primary?.ci && Number.isFinite(primary.ci[0]) ? `95% interval ${fmt(primary.ci[0])} to ${fmt(primary.ci[1])}` : primary?.undefinedReason ?? 'not yet defined'}</div>
        </div>
        <div className="tile"><div className="label">Raw agreement</div><div className="value num">{pct(r.stats.find((s) => s.id === 'pa')?.value)}</div><div className="sub">not chance-corrected</div></div>
        <div className="tile"><div className="label">Items with two or more judgments</div><div className="value num">{r.design.unitsRatedTwice.toLocaleString()}</div><div className="sub">of {r.design.units.toLocaleString()} with any</div></div>
        <div className="tile"><div className="label">Raters</div><div className="value num">{r.design.raters}</div><div className="sub">{r.design.fullyCrossed ? 'fully crossed' : `${r.design.ratingsPerUnit.min} to ${r.design.ratingsPerUnit.max} per item`}</div></div>
      </div>
      <div style={{ marginBottom: 12 }}><Notice tone="info"><strong>Recommended.</strong> {r.recommendation}</Notice></div>
      {r.flags.map((f, i) => <div key={i} style={{ marginBottom: 8 }}><Notice tone={f.level === 'error' ? 'error' : f.level === 'warn' ? 'warn' : 'info'}>{f.text}</Notice></div>)}
      {view === 'chart' ? (
        <ForestPlot rows={r.stats.filter((s) => s.kind !== 'raw' || s.id === 'pa').map((s) => ({ label: s.name, value: s.value, lo: s.ci?.[0], hi: s.ci?.[1], n: s.n, note: s.role }))} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Statistic</th><th>Role</th><th>Kind</th><th className="num">Value</th><th className="num">95% interval</th><th className="num">Items</th><th>Notes</th></tr></thead>
            <tbody>
              {r.stats.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong>{s.kind === 'chance-corrected' && Number.isFinite(s.value) && <div className="small muted">conventional band: {landisKoch(s.value)}</div>}</td>
                  <td><span className={`badge ${s.role === 'primary' ? 'role' : 'neutral'}`}>{s.role}</span></td>
                  <td className="small">{s.kind}</td>
                  <td className="num">{Number.isFinite(s.value) ? fmt(s.value) : 'undefined'}</td>
                  <td className="num">{s.ci && Number.isFinite(s.ci[0]) ? `${fmt(s.ci[0])} to ${fmt(s.ci[1])}` : ''}{s.ciMethod && <div className="small muted" style={{ maxWidth: 220, whiteSpace: 'normal' }}>{s.ciMethod}</div>}</td>
                  <td className="num">{s.n}</td>
                  <td className="small" style={{ maxWidth: 320 }}>{s.undefinedReason ?? s.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 8 }}>Interpretation bands (Landis and Koch, 1977) are conventions, not standards; report the value, the interval and raw agreement together.</p>
      {r.icc && r.icc.results.length > 0 && (
        <>
          <h3 style={{ marginTop: 16 }}>Intraclass correlation models</h3>
          <p className="small muted">Mean squares: rows {fmt(r.icc.ms.rows)}, raters {fmt(r.icc.ms.cols)}, error {fmt(r.icc.ms.error)}; {r.icc.n} items by {r.icc.k} raters{r.icc.excludedUnits ? `; ${r.icc.excludedUnits} incomplete items excluded` : ''}.</p>
        </>
      )}
      {r.table && r.table.categories.length <= 8 && (
        <>
          <h3 style={{ marginTop: 16 }}>Cross-tabulation of the two adjudicators</h3>
          <CrossHeat rowLabel={r.pairwise[0]?.a ?? 'Rater A'} colLabel={r.pairwise[0]?.b ?? 'Rater B'} categories={r.categories} counts={r.table.counts} />
        </>
      )}
      {r.distribution.length > 0 && r.categories.length <= 12 && (
        <>
          <h3 style={{ marginTop: 16 }}>Category use by adjudicator</h3>
          <CategoryBars categories={r.categories} series={r.distribution.map((d) => ({ name: d.rater, counts: d.counts, total: d.total }))} />
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="data">
              <thead><tr><th>Category</th>{r.distribution.map((d) => <th key={d.rater} className="num">{d.rater}</th>)}<th className="num">Specific agreement</th></tr></thead>
              <tbody>
                {r.categories.map((c) => (
                  <tr key={c.value}>
                    <td>{c.label}</td>
                    {r.distribution.map((d) => <td key={d.rater} className="num">{d.counts[c.value] ?? 0} ({pct(d.total ? (d.counts[c.value] ?? 0) / d.total : NaN, 0)})</td>)}
                    <td className="num">{pct(r.specific.find((s) => s.category === c.value)?.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Specific agreement: for a category, the probability that a second rater also chooses it given that one rater did (positive and negative agreement for yes or no scales).</p>
        </>
      )}
      {r.pairwise.length > 1 && (
        <>
          <h3 style={{ marginTop: 16 }}>Pairwise agreement</h3>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Pair</th><th className="num">Items</th><th className="num">Raw agreement</th><th className="num">{r.type === 'numeric' ? 'ICC(A,1)' : r.type === 'ordinal' ? 'Weighted kappa' : "Cohen's kappa"}</th><th className="num">95% interval</th></tr></thead>
              <tbody>{r.pairwise.map((q) => <tr key={q.a + q.b}><td>{q.a} and {q.b}</td><td className="num">{q.n}</td><td className="num">{pct(q.agreement)}</td><td className="num">{fmt(q.kappa)}</td><td className="num">{q.kappaCi ? `${fmt(q.kappaCi[0])} to ${fmt(q.kappaCi[1])}` : ''}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
      <span hidden>{v.data.project.id}</span>
    </div>
  );
}

function References({ refs, v }: { refs: ReturnType<typeof compareReferences>; v: ProjectView }) {
  const vars = v.data.project.config.variables;
  return (
    <div className="card">
      <h2>Reference raters</h2>
      <p className="small ink2">Reference ratings (for example an automated classifier) are stored with the items, hidden from adjudicators, and never enter interrater reliability. They are compared here with each adjudicator's independent judgment and with the final classification (agreed or resolved values). When items were selected because references disagree, rates on that subset are not population estimates; restrict to an unselected sample with the field filter above.</p>
      {refs.map((c) => {
        const variable = vars.find((x) => x.id === c.reference.variableId);
        const cats = (variable?.categories ?? []).map((k) => ({ value: k.value, label: k.label }));
        const a = c.vsFinal?.accuracy;
        return (
          <div key={c.reference.id} style={{ marginTop: 16 }}>
            <h3>{c.reference.label}</h3>
            {c.reference.description && <p className="small muted">{c.reference.description}</p>}
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Compared with</th><th className="num">Items</th><th className="num">Raw agreement</th><th className="num">Cohen's kappa</th></tr></thead>
                <tbody>
                  {c.vsAdjudicators.map((x) => <tr key={x.rater}><td>{x.rater} (independent)</td><td className="num">{x.n}</td><td className="num">{pct(x.agreement)}</td><td className="num">{fmt(x.kappa)}</td></tr>)}
                  {c.vsReferences.map((x) => <tr key={x.other}><td>{x.other} (reference)</td><td className="num">{x.n}</td><td className="num">{pct(x.agreement)}</td><td className="num">{fmt(x.kappa)}</td></tr>)}
                  {c.vsFinal && <tr><td><strong>Final classification</strong></td><td className="num">{c.vsFinal.n}</td><td className="num">{pct(c.vsFinal.agreement)}</td><td className="num">{fmt(c.vsFinal.kappa)}</td></tr>}
                </tbody>
              </table>
            </div>
            {a && (
              <div className="grid cols-2" style={{ marginTop: 10 }}>
                <CrossHeat rowLabel={c.reference.label} colLabel="Final" categories={cats} counts={c.vsFinal!.table.counts} />
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Against the final classification</th><th className="num">Value</th><th className="num">95% exact interval</th></tr></thead>
                    <tbody>
                      {([['Sensitivity (flags a true "' + (cats[1]?.label ?? a.positive) + '")', a.sensitivity], ['Miss rate (1 minus sensitivity)', { ...a.sensitivity, value: 1 - a.sensitivity.value, ci: a.sensitivity.ci ? [1 - a.sensitivity.ci[1], 1 - a.sensitivity.ci[0]] as [number, number] : undefined }], ['Specificity', a.specificity], ['Positive predictive value', a.ppv], ['Negative predictive value', a.npv], ['Accuracy', a.accuracy]] as const).map(([name, e]) => (
                        <tr key={name}><td>{name}</td><td className="num">{pct(e.value)}</td><td className="num">{e.ci && Number.isFinite(e.ci[0]) ? `${pct(e.ci[0])} to ${pct(e.ci[1])}` : ''}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {!c.vsFinal && <p className="small muted">The comparison with final classifications appears once items have final values.</p>}
          </div>
        );
      })}
    </div>
  );
}

function Methods() {
  return (
    <div className="card">
      <h2>Methods</h2>
      <div className="doc small" style={{ fontSize: 13.5 }}>
        <p><strong>Data.</strong> One rating per adjudicator per item: the submitted independent judgment. A submitted judgment can change only before disclosure, when the project allows it, and every version is kept; after disclosure it is locked. Consensus and resolved values are kept separately and are never used here.</p>
        <p><strong>Missing ratings.</strong> Cells for items an adjudicator was not assigned, or has not submitted, are empty. Raw agreement, Gwet's AC1 and Krippendorff's alpha use every item with two or more ratings. Cohen's kappa uses items rated by both adjudicators. Fleiss' kappa uses items with the modal number of ratings and reports the rest as excluded. Intraclass correlations use only items rated by every rater.</p>
        <p><strong>Coefficients.</strong> Cohen's kappa and weighted kappa (linear or quadratic agreement weights) with the large-sample standard error of Fleiss, Cohen and Everitt (1969). Fleiss' kappa (1971). Krippendorff's alpha from the coincidence matrix with nominal, ordinal, interval or ratio distance (Krippendorff, 2019). Gwet's AC1 (2008). Prevalence- and bias-adjusted kappa and the prevalence and bias indices (Byrt, Bishop and Carlin, 1993). Intraclass correlations by Shrout and Fleiss (1979) and McGraw and Wong (1996), with F-based intervals.</p>
        <p><strong>Intervals.</strong> Kappa: Wald interval from the asymptotic standard error. Alpha, AC1, Fleiss' kappa and raw agreement: percentile bootstrap over items, seeded with the project seed so results are reproducible. Proportions against references: exact Clopper-Pearson intervals.</p>
        <p><strong>Validation.</strong> The implementation reproduces published examples (Krippendorff 2011: 0.743, 0.815, 0.849, 0.797; Fleiss 1971: 0.210; Shrout and Fleiss 1979) and matches scikit-learn, statsmodels and the krippendorff package to ten decimals (tests/stats.test.ts).</p>
        <p><strong>Cautions.</strong> With a rare category, kappa can be low while raw agreement is high; read kappa with raw agreement, specific agreement, AC1 and the prevalence index. Interpretation bands are conventions. Reliability on a subset selected for disagreement is not a population estimate.</p>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import type { ProjectView } from '../app';
import { DataTable, Icon, Markdown, type Column } from '../components';
import { analyzeProject, compareReferences, pseudonyms } from '../../core/analysis';
import { summarize } from '../../core/workflow';
import { fmt, pct } from '../../core/util';
import type { AuditEvent } from '../../core/types';

export function AuditPage({ v }: { v: ProjectView }) {
  const names = pseudonyms(v.data);
  const [q, setQ] = useState('');
  const rows = v.data.audit.slice().sort((a, b) => b.at.localeCompare(a.at)).filter((e) => !q || `${e.action} ${e.entity} ${e.entityId} ${JSON.stringify(e.detail ?? {})}`.toLowerCase().includes(q.toLowerCase()));
  const columns: Column<AuditEvent>[] = [
    { key: 'at', label: 'Time', value: (e) => e.at, render: (e) => <span className="num small">{new Date(e.at).toLocaleString()}</span> },
    { key: 'who', label: 'Actor', value: (e) => names.get(e.userId) ?? e.userId },
    { key: 'action', label: 'Action', value: (e) => e.action, render: (e) => <span className="mono small">{e.action}</span> },
    { key: 'entity', label: 'Entity', value: (e) => e.entity },
    { key: 'detail', label: 'Detail', render: (e) => <span className="small mono" style={{ wordBreak: 'break-word' }}>{e.detail ? JSON.stringify(e.detail).slice(0, 220) : ''}</span> },
  ];
  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Audit log</h1>
          <p>Every submission, reopening, proposal, approval, finalization, escalation, configuration change and import, with the actor and time. Entries cannot be edited.</p>
        </div>
      </div>
      <div className="toolbar"><div className="grow"><input type="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter audit log" /></div></div>
      <DataTable rows={rows} columns={columns} rowKey={(e) => e.id} pageSize={40} />
    </div>
  );
}

const GUIDE = `## How Agreemetry works

1. **Configure.** An administrator creates a project from a template and adjusts the coding form (variables, categories, scales), the team, how items are assigned, the agreement rule, when judgments are disclosed, and the resolution options and rationales.
2. **Import.** Items come from CSV, Excel or JSON. Every original field is kept. Fields can be shown, hidden from adjudicators (blinded) or used as reference ratings.
3. **Assess independently.** Each adjudicator works through their own queue, in their own seeded order, with drafts saved automatically. Nobody sees another judgment before the disclosure point.
4. **Compare.** When an item has all its required judgments, Agreemetry compares them variable by variable under the project rule. Agreed items get their final values; disputed items enter the disagreement queue. An item that is still missing judgments is never counted as agreement.
5. **Resolve.** After disclosure, the adjudicators on a disputed item discuss it, propose a resolution with standard options and rationales plus their own words, and approve it. Leads finalize escalated items. Final decisions can only be reopened by an administrator, with a reason, and the earlier record is kept.
6. **Measure reliability.** Coefficients suited to the design are computed from the original independent judgments, with intervals and warnings.
7. **Export.** Tidy datasets, a data dictionary, codebook, loaders for R, Python and Stata, and a complete re-importable archive.

## Keyboard

- Numbers 1 to 9 choose a category for the first question.
- Ctrl and Enter submit and move to the next item.
- [ and ] move to the previous and next item.

## Roles

- **Administrator:** configuration, team, imports, oversight, statistics and exports. Sees everything, including blinded fields.
- **Adjudicator:** rates assigned items and takes part in resolving their own disputed items after disclosure.
- **Lead or final reviewer:** sees disclosed judgments, facilitates, and finalizes escalated or lead-decided items.
`;

export function GuidePage({ v }: { v: ProjectView }) {
  const docs = v.data.project.documents.filter((d) => v.isAdmin || d.audience === 'all');
  const [open, setOpen] = useState(docs[0]?.id ?? 'guide');
  const current = docs.find((d) => d.id === open);
  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Guide and manual</h1>
          <p>Project documents and a short guide to the platform.</p>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        {docs.map((d) => <button key={d.id} className={`btn sm ${open === d.id ? 'primary' : ''}`} onClick={() => setOpen(d.id)}>{d.title}{d.audience === 'admin' && ' (administrators)'}</button>)}
        <button className={`btn sm ${open === 'guide' ? 'primary' : ''}`} onClick={() => setOpen('guide')}>Using Agreemetry</button>
      </div>
      <div className="card">
        {current ? <><h2>{current.title}</h2><Markdown text={current.body} /></> : <Markdown text={GUIDE} />}
      </div>
    </div>
  );
}

export function ReportPage({ v }: { v: ProjectView }) {
  const { data, statuses } = v;
  const p = data.project;
  const s = summarize(statuses.values());
  const rel = useMemo(() => analyzeProject(data, { bootstrapReps: 1000, seed: p.config.assignment.seed }), [data, p.config.assignment.seed]);
  const refs = useMemo(() => compareReferences(data, statuses), [data, statuses]);
  return (
    <div style={{ maxWidth: 900 }}>
      <div className="row no-print" style={{ marginBottom: 16 }}>
        <button className="btn primary" onClick={() => window.print()}><Icon name="print" />Print or save as PDF</button>
        <span className="small muted">Use the browser's print dialog and choose Save as PDF.</span>
      </div>
      <div className="card">
        <h1>{p.name}</h1>
        <p className="ink2">{p.description}</p>
        <p className="small muted">Report generated {new Date().toLocaleString()} by Agreemetry. Reliability uses the original independent judgments only.</p>
        <h2>Design</h2>
        <ul>
          <li>{p.config.requiredAdjudicators} independent judgments per item; {p.config.assignment.mode === 'all' ? 'every adjudicator rates every item' : `${p.config.assignment.k} adjudicators per item by balanced rotation`}; seed {p.config.assignment.seed}.</li>
          <li>Agreement rule: {p.config.agreement.rule}; disclosure: {p.config.disclosure.replace('_', ' ')}; resolution: {p.config.resolution.mechanism}.</li>
          <li>Blinded fields: {p.config.display.blindedFields.join(', ') || 'none'}.</li>
        </ul>
        <h2>Workflow</h2>
        <table className="data">
          <tbody>
            {([['Items', s.items], ['Assigned', s.assigned], ['Judgments submitted', `${s.assessmentsSubmitted} of ${s.assessmentsRequired}`], ['Items with all judgments', s.complete], ['Complete agreement', s.agreedComplete], ['Agreed by rule', s.agreedRule], ['Disagreements', s.disagreements], ['Resolved', s.resolved], ['Unresolved', s.unresolved], ['Escalated', s.escalated], ['Completion', pct(s.completion)]] as [string, string | number][]).map(([k, val]) => <tr key={k}><td>{k}</td><td className="num">{typeof val === 'number' ? val.toLocaleString() : val}</td></tr>)}
          </tbody>
        </table>
        <h2 style={{ marginTop: 18 }}>Interrater reliability</h2>
        {rel.map((r) => (
          <div key={r.variableId} style={{ marginBottom: 14 }}>
            <h3>{r.label}</h3>
            <p className="small">{r.recommendation} {r.design.unitsRatedTwice} items with two or more judgments; {r.design.raters} raters.</p>
            <table className="data">
              <thead><tr><th>Statistic</th><th>Role</th><th className="num">Value</th><th className="num">95% interval</th><th className="num">Items</th></tr></thead>
              <tbody>{(r.parts ? r.parts.flatMap((q) => q.stats.filter((x) => x.role === 'primary').map((x) => ({ ...x, name: `${q.label}: ${x.name}` }))) : r.stats).map((x) => (
                <tr key={x.id + x.name}><td>{x.name}</td><td>{x.role}</td><td className="num">{fmt(x.value)}</td><td className="num">{x.ci ? `${fmt(x.ci[0])} to ${fmt(x.ci[1])}` : ''}</td><td className="num">{x.n}</td></tr>
              ))}</tbody>
            </table>
            {r.flags.length > 0 && <ul className="small">{r.flags.map((f, i) => <li key={i}>{f.text}</li>)}</ul>}
          </div>
        ))}
        {refs.length > 0 && (
          <>
            <h2>Reference raters</h2>
            <table className="data">
              <thead><tr><th>Reference</th><th>Compared with</th><th className="num">Items</th><th className="num">Agreement</th><th className="num">Kappa</th></tr></thead>
              <tbody>{refs.flatMap((c) => [
                ...c.vsAdjudicators.map((a) => <tr key={c.reference.id + a.rater}><td>{c.reference.label}</td><td>{a.rater}</td><td className="num">{a.n}</td><td className="num">{pct(a.agreement)}</td><td className="num">{fmt(a.kappa)}</td></tr>),
                ...c.vsReferences.map((o) => <tr key={c.reference.id + o.other}><td>{c.reference.label}</td><td>{o.other}</td><td className="num">{o.n}</td><td className="num">{pct(o.agreement)}</td><td className="num">{fmt(o.kappa)}</td></tr>),
                ...(c.vsFinal ? [<tr key={c.reference.id + 'final'}><td>{c.reference.label}</td><td>final classification{c.vsFinal.accuracy ? ` (sensitivity ${pct(c.vsFinal.accuracy.sensitivity.value)}, specificity ${pct(c.vsFinal.accuracy.specificity.value)})` : ''}</td><td className="num">{c.vsFinal.n}</td><td className="num">{pct(c.vsFinal.agreement)}</td><td className="num">{fmt(c.vsFinal.kappa)}</td></tr>] : []),
              ])}</tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

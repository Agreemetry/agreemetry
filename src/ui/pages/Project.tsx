import { useMemo, useState } from 'react';
import { SideNav, TopBar, useApp, useProject, type ProjectView } from '../app';
import { Empty, Field, Help, Notice, Progress, STATE_COLOR, STATE_LABEL, StateBadge, Tile, download } from '../components';
import { LocalBackend } from '../../data/localBackend';
import { Cumulative, StatusBar } from '../charts';
import { adjudicators, adjudicatorProgress, summarize, type ItemStatus } from '../../core/workflow';
import { analyzeVariable, primaryStat } from '../../core/analysis';
import { fmt, pct, slug } from '../../core/util';
import type { ItemState } from '../../core/types';
import { Assess } from './Assess';
import { Disagreements } from './Resolve';
import { Reliability } from './Reliability';
import { ItemsPage } from './Items';
import { ExportPage } from './Export';
import { Settings } from './Settings';
import { AuditPage, GuidePage, ReportPage } from './Docs';

export function ProjectPage({ projectId, tab, sub }: { projectId: string; tab: string; sub?: string }) {
  const { view, error } = useProject(projectId);
  if (error) return <div className="center-narrow"><Notice tone="error">{error}</Notice></div>;
  if (!view) return <div className="center-narrow muted">Loading project</div>;
  const v = view;
  const open = [...v.data.items].filter((i) => {
    const s = v.stateOf(i.id);
    return s === 'disagreement' || s === 'proposed' || s === 'escalated';
  }).length;
  const entries = [
    { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', show: true },
    { key: 'assess', label: 'Assess', icon: 'assess', show: v.data.memberships.some((m) => m.active && (m.role === 'adjudicator' || m.adjudicates)) },
    { key: 'disagreements', label: 'Disagreements', icon: 'disagree', count: open, show: true },
    { key: 'items', label: 'Items', icon: 'items', show: v.isAdmin || v.isLead },
    { key: 'reliability', label: 'Reliability', icon: 'reliability', show: v.isAdmin || v.isLead },
    { key: 'export', label: 'Export', icon: 'export', show: v.isAdmin },
    { key: 'settings', label: 'Settings', icon: 'settings', show: v.isAdmin },
    { key: 'audit', label: 'Audit log', icon: 'audit', show: v.isAdmin },
    { key: 'guide', label: 'Guide and manual', icon: 'guide', show: true },
  ];
  return (
    <>
      <TopBar />
      <div className="layout">
        <SideNav projectId={projectId} project={v.data.project.name} current={tab} entries={entries} role={v.role} />
        <main className="main" id="main">
          {tab === 'dashboard' && <Dashboard v={v} />}
          {tab === 'assess' && <Assess v={v} itemId={sub} />}
          {tab === 'disagreements' && <Disagreements v={v} itemId={sub} />}
          {tab === 'items' && <ItemsPage v={v} />}
          {tab === 'reliability' && <Reliability v={v} />}
          {tab === 'export' && <ExportPage v={v} />}
          {tab === 'settings' && <Settings v={v} section={sub} />}
          {tab === 'audit' && <AuditPage v={v} />}
          {tab === 'guide' && <GuidePage v={v} />}
          {tab === 'report' && <ReportPage v={v} />}
        </main>
      </div>
    </>
  );
}

const ORDER: ItemState[] = ['agreed', 'resolved', 'proposed', 'escalated', 'disagreement', 'in_progress', 'awaiting', 'unassigned'];

function Dashboard({ v }: { v: ProjectView }) {
  return v.isAdmin || v.isLead ? <Oversight v={v} /> : <MyWork v={v} />;
}

function Oversight({ v }: { v: ProjectView }) {
  const { user } = useApp();
  const { data, statuses } = v;
  const p = data.project;
  const [batch, setBatch] = useState('');
  const [rater, setRater] = useState('');
  const [variable, setVariable] = useState('');
  const [state, setState] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [fieldVal, setFieldVal] = useState('');
  const batches = useMemo(() => [...new Set(data.items.map((i) => i.batch))].sort(), [data.items]);
  const raters = adjudicators(data.memberships);
  const fieldKeys = useMemo(() => (v.isAdmin ? [...new Set(data.items.flatMap((i) => Object.keys(i.fields)))].filter((k) => data.items.slice(0, 200).every((i) => typeof i.fields[k] !== 'string' || (i.fields[k] as string).length < 60)) : []), [data.items, v.isAdmin]);
  const fieldVals = useMemo(() => (fieldKey ? [...new Set(data.items.map((i) => String(i.fields[fieldKey] ?? '')))].sort().slice(0, 200) : []), [fieldKey, data.items]);

  const filtered: ItemStatus[] = data.items
    .filter((i) => !batch || i.batch === batch)
    .filter((i) => !fieldKey || !fieldVal || String(i.fields[fieldKey] ?? '') === fieldVal)
    .map((i) => statuses.get(i.id)!)
    .filter((s) => !rater || s.assigned.includes(rater))
    .filter((s) => !variable || s.disputed.includes(variable) || !['disagreement', 'proposed', 'escalated', 'resolved'].includes(s.state))
    .filter((s) => !state || s.state === state);
  const sum = summarize(filtered);
  const counts = Object.fromEntries(ORDER.map((k) => [k, filtered.filter((s) => s.state === k).length])) as Record<ItemState, number>;
  const prog = adjudicatorProgress(data, statuses);
  const vars = p.config.variables.filter((x) => x.type !== 'text' && x.includeInAgreement);
  const ids = new Set(filtered.map((s) => s.itemId));
  const rel = useMemo(() => vars.map((x) => ({ x, r: analyzeVariable(data, x, { bootstrapReps: 200, seed: p.config.assignment.seed, itemFilter: (i) => ids.has(i.id) }) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, batch, rater, fieldKey, fieldVal, state, variable]);
  const disputedBy = vars.map((x) => ({ x, n: filtered.filter((s) => s.disputed.includes(x.id)).length }));
  const warnings: string[] = [];
  if (raters.length < p.config.requiredAdjudicators) warnings.push(`The project needs ${p.config.requiredAdjudicators} independent judgments per item but has ${raters.length} active adjudicator${raters.length === 1 ? '' : 's'}. Add adjudicators in Settings, Team.`);
  if (data.memberships.some((m) => m.active && m.role !== 'adjudicator' && m.adjudicates)) warnings.push('An administrator or lead also adjudicates. Administrators can see every judgment, so their own judgments are not blind; record this in the methods.');
  if (p.status !== 'active') warnings.push(`The project is ${p.status}; adjudicators cannot submit judgments until it is active.`);
  if (p.config.assignment.mode === 'fixed_k' && data.assignments.length === 0 && data.items.length) warnings.push('Items are distributed but no assignments exist yet. Generate them in Settings, Workflow.');
  const times = raters.map((m) => ({ name: m.pseudonym, times: data.assessments.filter((a) => a.userId === m.userId && a.status === 'submitted' && a.submittedAt && ids.has(a.itemId)).map((a) => Date.parse(a.submittedAt!)) }));

  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="badge neutral">{p.status}</span>
            <span className="badge neutral">{p.config.requiredAdjudicators} judgments per item</span>
            <span className="badge neutral">agreement: {p.config.agreement.rule}{p.config.agreement.rule === 'threshold' ? ` ${p.config.agreement.threshold}` : ''}</span>
            <span className="badge neutral">disclosure: {p.config.disclosure.replace('_', ' ')}{p.config.disclosure === 'manual' ? (p.config.disclosed ? ' (open)' : ' (closed)') : ''}</span>
          </div>
          <h1>{p.name}</h1>
          <p>{p.description}</p>
        </div>
        <a className="btn" href={`#/p/${p.id}/report`}>Printable report</a>
      </div>
      {warnings.map((w) => <div key={w} style={{ marginBottom: 10 }}><Notice tone="warn">{w}</Notice></div>)}
      {p.provenance && v.isAdmin && <div style={{ marginBottom: 14 }}><Notice tone="info"><strong>Provenance.</strong> {p.provenance}</Notice></div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <Field label="Batch">
            <select value={batch} onChange={(e) => setBatch(e.target.value)}>
              <option value="">All batches</option>
              {batches.map((b) => <option key={b}>{b}</option>)}
            </select>
          </Field>
          <Field label="Adjudicator">
            <select value={rater} onChange={(e) => setRater(e.target.value)}>
              <option value="">All adjudicators</option>
              {raters.map((m) => <option key={m.userId} value={m.userId}>{m.pseudonym}</option>)}
            </select>
          </Field>
          <Field label="Disputed variable">
            <select value={variable} onChange={(e) => setVariable(e.target.value)}>
              <option value="">Any variable</option>
              {vars.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Any status</option>
              {ORDER.map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
            </select>
          </Field>
          {v.isAdmin && (
            <>
              <Field label="Field (administrators)">
                <select value={fieldKey} onChange={(e) => { setFieldKey(e.target.value); setFieldVal(''); }}>
                  <option value="">No field filter</option>
                  {fieldKeys.map((k) => <option key={k} value={k}>{k}{p.config.display.blindedFields.includes(k) ? ' (blinded)' : ''}</option>)}
                </select>
              </Field>
              {fieldKey && (
                <Field label="Value">
                  <select value={fieldVal} onChange={(e) => setFieldVal(e.target.value)}>
                    <option value="">Any</option>
                    {fieldVals.map((x) => <option key={x} value={x}>{x || '(empty)'}</option>)}
                  </select>
                </Field>
              )}
            </>
          )}
        </div>
      </div>

      <div className="grid tiles" style={{ marginBottom: 16 }}>
        <Tile label="Items" value={sum.items.toLocaleString()} sub={`${sum.assigned.toLocaleString()} assigned`} />
        <Tile label="Judgments submitted" value={sum.assessmentsSubmitted.toLocaleString()} sub={`of ${sum.assessmentsRequired.toLocaleString()} required`} help="Submitted independent judgments counted up to the number required per item. Drafts are not counted." />
        <Tile label="Awaiting other adjudicators" value={sum.inProgress.toLocaleString()} sub={`${sum.awaiting.toLocaleString()} not started`} help="Items with some but not all required judgments. They are never compared, so they cannot be counted as agreement." />
        <Tile label="Complete agreement" value={sum.agreedComplete.toLocaleString()} sub={sum.complete ? pct(sum.agreedComplete / sum.complete) + ' of compared items' : 'none compared yet'} />
        {sum.agreedRule > 0 && <Tile label="Agreed by rule" value={sum.agreedRule.toLocaleString()} sub="meets the rule, not unanimous" />}
        <Tile label="Disagreements" value={sum.disagreements.toLocaleString()} sub={sum.complete ? pct(sum.disagreements / sum.complete) + ` of compared · ${sum.partialDisagreements} partial` : ''} />
        <Tile label="Resolved" value={sum.resolved.toLocaleString()} />
        <Tile label="Unresolved disagreements" value={sum.unresolved.toLocaleString()} tone={sum.unresolved ? 'alert' : undefined} sub={`${sum.proposed} with a proposal · ${sum.escalated} escalated`} help="Items whose required independent judgments are all in and which fail the agreement rule, without a final resolution." />
        <Tile label="Completion" value={pct(sum.completion, 0)} sub={`${sum.finalized.toLocaleString()} items with final values`} tone="accent" />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head"><h2 className="grow">Workflow status</h2></div>
          <StatusBar total={filtered.length} segments={ORDER.map((k) => ({ label: STATE_LABEL[k], value: counts[k], color: STATE_COLOR[k] }))} />
        </div>
        <div className="card">
          <div className="card-head"><h2 className="grow">Adjudicator progress</h2></div>
          {prog.length === 0 ? <p className="muted">No adjudicators yet.</p> : (
            <div className="stack">
              {prog.map((r) => (
                <div key={r.userId}>
                  <div className="row small" style={{ justifyContent: 'space-between' }}>
                    <strong>{r.pseudonym}</strong>
                    <span className="num ink2">{r.submitted.toLocaleString()} of {r.assigned.toLocaleString()} submitted{r.drafts ? ` · ${r.drafts} drafts` : ''}</span>
                  </div>
                  <Progress value={r.assigned ? r.submitted / r.assigned : 0} label={`${r.pseudonym} progress`} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h2 className="grow">Reliability, before consensus</h2>
            <a className="btn sm" href={`#/p/${p.id}/reliability`}>Details</a>
          </div>
          <p className="small muted">From the original independent judgments only. Primary coefficient for each variable, with 95% interval (200 bootstrap resamples here; the Reliability page uses 1,000).</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Variable</th><th>Coefficient</th><th className="num">Value</th><th className="num">95% interval</th><th className="num">Raw agreement</th><th className="num">Items</th></tr></thead>
              <tbody>
                {rel.map(({ x, r }) => {
                  const s = primaryStat(r);
                  const pa = r.stats.find((q) => q.id === 'pa');
                  return (
                    <tr key={x.id}>
                      <td>{x.label}</td>
                      <td>{s ? s.name : r.parts ? 'per label' : ''}</td>
                      <td className="num">{s ? fmt(s.value) : ''}</td>
                      <td className="num">{s?.ci ? `${fmt(s.ci[0])} to ${fmt(s.ci[1])}` : ''}</td>
                      <td className="num">{pa ? pct(pa.value) : ''}</td>
                      <td className="num">{r.design.unitsRatedTwice}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2 className="grow">Disagreements by variable</h2></div>
          <div className="stack">
            {disputedBy.map(({ x, n }) => (
              <div key={x.id}>
                <div className="row small" style={{ justifyContent: 'space-between' }}><span>{x.label}</span><span className="num">{n}</span></div>
                <Progress value={sum.complete ? n / sum.complete : 0} label={x.label} />
              </div>
            ))}
          </div>
          <hr />
          <h3>Judgments over time</h3>
          {times.some((t) => t.times.length > 1) ? <Cumulative series={times} /> : <p className="muted small">Appears once judgments are submitted.</p>}
        </div>
      </div>

      {v.isAdmin && (
        <div className="card">
          <div className="card-head"><h2 className="grow">Recent activity</h2><a className="btn sm" href={`#/p/${p.id}/audit`}>Audit log</a></div>
          <ul className="timeline" style={{ listStyle: 'none', margin: 0 }}>
            {data.audit.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8).map((e) => (
              <li key={e.id}>
                <span className="muted small num">{new Date(e.at).toLocaleString()}</span> · <strong>{data.memberships.find((m) => m.userId === e.userId)?.pseudonym ?? (e.userId === user?.id ? 'you' : e.userId)}</strong> {e.action.replace('.', ' ')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MyWork({ v }: { v: ProjectView }) {
  const { user, backend, fail } = useApp();
  const { data } = v;
  const mine = data.items;
  const subs = data.assessments.filter((a) => a.userId === user!.id && a.status === 'submitted').length;
  const drafts = data.assessments.filter((a) => a.userId === user!.id && a.status === 'draft').length;
  const open = mine.filter((i) => ['disagreement', 'proposed', 'escalated'].includes(v.stateOf(i.id)));
  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>{data.project.name}</h1>
          <p>{data.project.description}</p>
        </div>
        {backend instanceof LocalBackend && subs > 0 && (
          <button className="btn" onClick={() => (backend as LocalBackend).myAssessmentPackage(data.project.id).then((pkg) => download(`${slug(data.project.shortName ?? data.project.name)}_judgments_${pkg.pseudonym}.json`, new Blob([JSON.stringify(pkg)], { type: 'application/json' })), fail)}>Return my judgments</button>
        )}
        <a className="btn primary" href={`#/p/${data.project.id}/assess`}>Continue assessing</a>
      </div>
      <div className="grid tiles" style={{ marginBottom: 16 }}>
        <Tile label="Assigned to you" value={mine.length.toLocaleString()} />
        <Tile label="Submitted" value={subs.toLocaleString()} sub={pct(mine.length ? subs / mine.length : 0) + ' done'} tone="accent" />
        <Tile label="Drafts" value={drafts.toLocaleString()} />
        <Tile label="Open disagreements" value={open.length.toLocaleString()} help="Shown once judgments on an item are disclosed to you." />
      </div>
      <div className="card">
        <Progress value={mine.length ? subs / mine.length : 0} label="Your progress" />
        <p className="small muted" style={{ marginTop: 10 }}>
          Other adjudicators' judgments stay hidden until the disclosure point ({data.project.config.disclosure.replace('_', ' ')}). Overall project statistics are visible to administrators and leads.
        </p>
      </div>
      {open.length > 0 && (
        <div className="card">
          <h2>Your open disagreements</h2>
          <div className="stack">
            {open.slice(0, 10).map((i) => (
              <a key={i.id} href={`#/p/${data.project.id}/disagreements/${i.id}`} className="row">
                <StateBadge state={v.stateOf(i.id)} /> {i.externalId}
              </a>
            ))}
          </div>
        </div>
      )}
      {mine.length === 0 && <Empty title="Nothing assigned yet">An administrator assigns items to you.</Empty>}
      <span hidden><Help text="" /></span>
    </div>
  );
}

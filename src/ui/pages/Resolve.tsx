import { useMemo, useState } from 'react';
import { go, useApp, type ProjectView } from '../app';
import { DataTable, Empty, Field, Icon, Notice, Seg, StateBadge, type Column } from '../components';
import { ItemPanel, VariableInput } from './Assess';
import { agreementVariables, isItemDisclosed, originalSubmission, type ItemStatus } from '../../core/workflow';
import { canApprove, resolutionChoices, approvalsNeeded } from '../../core/resolution';
import { pseudonyms } from '../../core/analysis';
import type { Item, ItemState, RatingValue, Variable } from '../../core/types';

const OPEN: ItemState[] = ['disagreement', 'proposed', 'escalated'];

function valueLabel(x: Variable | undefined, v: RatingValue | undefined): string {
  if (v === null || v === undefined || v === '') return 'No answer';
  if (Array.isArray(v)) return v.length ? v.map((c) => x?.categories?.find((k) => k.value === c)?.label ?? c).join(', ') : 'No label';
  return x?.categories?.find((k) => k.value === String(v))?.label ?? String(v);
}

export function Disagreements({ v, itemId }: { v: ProjectView; itemId?: string }) {
  if (itemId) {
    const item = v.data.items.find((i) => i.id === itemId);
    if (!item) return <Notice tone="error">This item is not available to you.</Notice>;
    return <ResolveItem v={v} item={item} />;
  }
  return <Queue v={v} />;
}

function Queue({ v }: { v: ProjectView }) {
  const { data } = v;
  const p = data.project;
  const [scope, setScope] = useState<'open' | 'resolved' | 'all'>('open');
  const [variable, setVariable] = useState('');
  const names = pseudonyms(data);
  const vars = agreementVariables(p);
  const rows = data.items
    .map((i) => ({ item: i, state: v.stateOf(i.id), st: v.statuses.get(i.id)! }))
    .filter((r) => (scope === 'open' ? OPEN.includes(r.state) : scope === 'resolved' ? r.state === 'resolved' : OPEN.includes(r.state) || r.state === 'resolved'))
    .filter((r) => !variable || r.st.disputed.includes(variable) || (data.serverStatus?.[r.item.id]?.disputedVariables ?? []).includes(variable));
  const waiting = v.fullView ? [...v.statuses.values()].filter((s) => s.submitted.length >= s.required && s.disputed.length && !isItemDisclosed(p, v.statuses, s.itemId)).length : 0;
  const columns: Column<(typeof rows)[number]>[] = [
    { key: 'id', label: 'Item', value: (r) => r.item.externalId, render: (r) => <span className="mono">{r.item.externalId}</span> },
    { key: 'state', label: 'Status', value: (r) => r.state, render: (r) => <StateBadge state={r.state} /> },
    { key: 'vars', label: 'Disputed', render: (r) => (r.st.disputed.length ? r.st.disputed : data.serverStatus?.[r.item.id]?.disputedVariables ?? []).map((id) => vars.find((x) => x.id === id)?.label ?? id).join(', ') },
    { key: 'ratings', label: 'Independent judgments', render: (r) => {
      const c = r.st.comparisons[r.st.disputed[0]];
      if (!c) return <span className="muted">hidden until disclosure</span>;
      const x = vars.find((q) => q.id === c.variableId);
      return Object.entries(c.values).map(([u, val]) => `${names.get(u) ?? '?'}: ${valueLabel(x, val)}`).join('; ');
    } },
    { key: 'proposal', label: 'Proposal', render: (r) => (r.st.proposal ? `by ${names.get(r.st.proposal.proposedBy) ?? '?'}, ${r.st.proposal.approvals.length} approval${r.st.proposal.approvals.length === 1 ? '' : 's'}` : '') },
  ];
  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Disagreements</h1>
          <p>Items whose required independent judgments are all submitted and fail the agreement rule ({p.config.agreement.rule}). Resolve each here: discuss, propose, approve, or escalate. Everything is recorded.</p>
        </div>
      </div>
      {waiting > 0 && <div style={{ marginBottom: 12 }}><Notice tone="info">{waiting} disputed items are not yet disclosed to their adjudicators (disclosure: {p.config.disclosure.replace('_', ' ')}). Leads and administrators can already resolve them; adjudicators see them at disclosure.</Notice></div>}
      <div className="toolbar">
        <Seg label="Scope" value={scope} onChange={setScope} options={[{ value: 'open', label: 'Unresolved' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]} />
        <select value={variable} onChange={(e) => setVariable(e.target.value)} aria-label="Disputed variable" style={{ width: 'auto' }}>
          <option value="">Any variable</option>
          {vars.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
        <span className="muted small num">{rows.length} items</span>
      </div>
      {rows.length === 0 ? <Empty title={scope === 'open' ? 'No unresolved disagreements' : 'Nothing here'}>{scope === 'open' && !v.fullView ? 'Disagreements on your items appear here once judgments are disclosed.' : ''}</Empty> : (
        <DataTable rows={rows} columns={columns} rowKey={(r) => r.item.id} onRow={(r) => go(`/p/${p.id}/disagreements/${r.item.id}`)} />
      )}
    </div>
  );
}

function ResolveItem({ v, item }: { v: ProjectView; item: Item }) {
  const { user, backend, toast, fail } = useApp();
  const { data } = v;
  const p = data.project;
  const st = v.statuses.get(item.id) as ItemStatus;
  const names = pseudonyms(data);
  const vars = agreementVariables(p);
  const subs = data.assessments.filter((a) => a.itemId === item.id && a.status === 'submitted');
  const disclosedToMe = v.fullView || v.isLead || subs.length >= st.required;
  const me = user!.id;
  const canAct = (v.isAdmin || v.isLead || (st.assigned.includes(me) && st.submitted.includes(me) && disclosedToMe && !st.escalated)) && st.disputed.length > 0;
  const [msg, setMsg] = useState('');
  const [escReason, setEscReason] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const discussions = data.discussions.filter((d) => d.itemId === item.id).sort((a, b) => a.at.localeCompare(b.at));
  const history = data.resolutions.filter((r) => r.itemId === item.id).sort((a, b) => a.version - b.version);
  const escalations = data.escalations.filter((e) => e.itemId === item.id);
  const proposal = st.proposal;
  const final = st.resolution;
  const optLabel = (id: string, retained?: string) => (p.config.resolution.options.find((o) => o.id === id)?.label ?? id).replace('{adjudicator}', retained ? names.get(retained) ?? 'adjudicator' : 'an adjudicator');
  const ratLabel = (id: string) => p.config.resolution.rationales.find((r) => r.id === id)?.label ?? id;
  const idx = data.items.filter((i) => OPEN.includes(v.stateOf(i.id)));
  const pos = idx.findIndex((i) => i.id === item.id);

  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <a href={`#/p/${p.id}/disagreements`} className="small"><Icon name="left" size={12} /> Disagreements</a>
          <h1 style={{ marginTop: 6 }}>Resolve {item.externalId}</h1>
          <div className="row"><StateBadge state={v.stateOf(item.id)} />{st.disputed.length > 0 && <span className="small ink2">Disputed: {st.disputed.map((id) => vars.find((x) => x.id === id)?.label ?? id).join(', ')}</span>}</div>
        </div>
        {pos >= 0 && idx.length > 1 && (
          <div className="row">
            <button className="btn sm" disabled={pos <= 0} onClick={() => go(`/p/${p.id}/disagreements/${idx[pos - 1].id}`)}><Icon name="left" size={14} />Previous</button>
            <button className="btn sm" disabled={pos >= idx.length - 1} onClick={() => go(`/p/${p.id}/disagreements/${idx[pos + 1].id}`)}>Next<Icon name="right" size={14} /></button>
          </div>
        )}
      </div>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <ItemPanel v={v} item={item} />
        <div className="stack">
          <div className="card">
            <h2>Independent judgments</h2>
            {!disclosedToMe ? <Notice tone="info">Judgments on this item are not disclosed yet.</Notice> : (
              <div className="judgments">
                {subs.map((a) => {
                  const orig = originalSubmission(a);
                  const amended = orig && JSON.stringify(orig.values) !== JSON.stringify(a.values);
                  return (
                    <div key={a.id} className={`judgment ${vars.some((x) => st.disputed.includes(x.id)) ? 'disputed' : ''}`}>
                      <div className="who">{names.get(a.userId) ?? 'Adjudicator'}{a.userId === me && <span className="badge neutral">you</span>}</div>
                      {p.config.variables.filter((x) => x.type !== 'text').map((x) => (
                        <div key={x.id} style={{ marginTop: 4 }}>
                          <div className="small muted">{x.label}</div>
                          <div className="val" style={{ color: st.disputed.includes(x.id) ? 'var(--critical-ink)' : undefined }}>{valueLabel(x, a.values[x.id])}</div>
                        </div>
                      ))}
                      {p.config.variables.filter((x) => x.type === 'text' && a.values[x.id]).map((x) => (
                        <div key={x.id} className="small" style={{ marginTop: 6 }}><span className="muted">{x.label}: </span>{String(a.values[x.id])}</div>
                      ))}
                      {a.comment && <div className="small" style={{ marginTop: 6 }}><span className="muted">Comment: </span>{a.comment}</div>}
                      {a.evidence && <div className="small"><span className="muted">Evidence: </span>{a.evidence}</div>}
                      <div className="small muted" style={{ marginTop: 6 }}>Submitted {a.submittedAt ? new Date(a.submittedAt).toLocaleString() : ''}{amended ? ' (amended before disclosure; first submission kept in history)' : ''}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {final && (
            <div className="card">
              <h2><Icon name="check" />Final resolution</h2>
              <ResolutionSummary r={final} names={names} vars={vars} optLabel={optLabel} ratLabel={ratLabel} />
              {v.isAdmin && (
                <div className="stack" style={{ marginTop: 12 }}>
                  <Field label="Reopen with a reason (administrators)" hint="The final record is kept as superseded; the item returns to the queue.">
                    <input type="text" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
                  </Field>
                  <div className="row"><button className="btn danger" disabled={!reopenReason.trim()} onClick={() => backend.reopenResolution(p.id, final.id, reopenReason).then(() => toast('Reopened.'), fail)}>Reopen</button></div>
                </div>
              )}
            </div>
          )}

          {!final && proposal && (
            <div className="card">
              <h2>Pending proposal</h2>
              <ResolutionSummary r={proposal} names={names} vars={vars} optLabel={optLabel} ratLabel={ratLabel} />
              <p className="small muted">
                {Number.isFinite(approvalsNeeded(p, st, proposal)) ? `Becomes final with ${approvalsNeeded(p, st, proposal)} approval${approvalsNeeded(p, st, proposal) === 1 ? '' : 's'} from the other adjudicators on this item.` : 'A lead or administrator finalizes it.'}
                {st.escalated ? ' The item is escalated: only the lead or an administrator can finalize.' : ''}
              </p>
              <div className="row">
                {canApprove(p, st, proposal, me) && !st.escalated && <button className="btn primary" onClick={() => backend.approveResolution(p.id, proposal.id).then(() => toast('Approved.'), fail)}><Icon name="check" />Approve</button>}
                {(v.isAdmin || v.isLead) && <button className="btn" onClick={() => backend.finalizeResolution(p.id, proposal.id).then(() => toast('Finalized.'), fail)}>Finalize as {v.isAdmin ? 'administrator' : 'lead'}</button>}
              </div>
            </div>
          )}

          {canAct && !final && <ProposalForm v={v} st={st} item={item} />}

          {canAct && !final && !st.escalated && p.config.resolution.options.some((o) => o.kind === 'escalate' && o.enabled) && (
            <div className="card stack">
              <h3>Escalate</h3>
              <Field label="Why does this item need further review?">
                <input type="text" value={escReason} onChange={(e) => setEscReason(e.target.value)} />
              </Field>
              <div className="row"><button className="btn" disabled={!escReason.trim()} onClick={() => backend.escalate(p.id, item.id, escReason).then(() => { setEscReason(''); toast('Escalated to the lead.'); }, fail)}><Icon name="flag" />Escalate</button></div>
            </div>
          )}

          <div className="card">
            <h2>Discussion</h2>
            <div className="thread">
              {discussions.length === 0 && <p className="muted small">No messages yet.</p>}
              {discussions.map((d) => (
                <div key={d.id} className="msg">
                  <div className="meta">{names.get(d.userId) ?? 'member'} · {new Date(d.at).toLocaleString()}</div>
                  <div>{d.text}</div>
                </div>
              ))}
            </div>
            {(canAct || v.isAdmin || v.isLead) && disclosedToMe && (
              <div className="stack" style={{ marginTop: 10 }}>
                <textarea value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Write a message" aria-label="Message" />
                <div className="row end"><button className="btn" disabled={!msg.trim()} onClick={() => backend.addDiscussion(p.id, item.id, msg).then(() => setMsg(''), fail)}>Post</button></div>
              </div>
            )}
          </div>

          {(history.length > 0 || escalations.length > 0) && (
            <div className="card">
              <h2>History</h2>
              <ul className="timeline" style={{ listStyle: 'none', margin: 0 }}>
                {[...history.map((r) => ({ at: r.proposedAt, text: `Version ${r.version}: ${optLabel(r.optionId, r.retainedUserId)} proposed by ${names.get(r.proposedBy) ?? '?'}; ${r.status}${r.finalizedAt ? `, final ${new Date(r.finalizedAt).toLocaleString()}` : ''}${r.reopenReason ? `; reopened: ${r.reopenReason}` : ''}` })),
                  ...escalations.map((e) => ({ at: e.at, text: `Escalated by ${names.get(e.userId) ?? '?'}: ${e.reason}${e.open ? '' : ' (closed)'}` }))]
                  .sort((a, b) => a.at.localeCompare(b.at))
                  .map((h, i) => <li key={i}><span className="muted small">{new Date(h.at).toLocaleString()}</span><br />{h.text}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResolutionSummary({ r, names, vars, optLabel, ratLabel }: { r: NonNullable<ItemStatus['resolution']>; names: Map<string, string>; vars: Variable[]; optLabel: (id: string, u?: string) => string; ratLabel: (id: string) => string }) {
  return (
    <dl className="fieldlist">
      <dt>Option</dt><dd>{optLabel(r.optionId, r.retainedUserId)}</dd>
      {vars.map((x) => <div key={x.id} style={{ display: 'contents' }}><dt>{x.label}</dt><dd><strong>{valueLabel(x, r.values[x.id])}</strong></dd></div>)}
      {r.rationaleIds.length > 0 && <><dt>Rationale</dt><dd>{r.rationaleIds.map(ratLabel).join('; ')}</dd></>}
      {r.freeText && <><dt>Explanation</dt><dd>{r.freeText}</dd></>}
      {r.references && <><dt>References</dt><dd>{r.references}</dd></>}
      <dt>Proposed</dt><dd>{names.get(r.proposedBy) ?? '?'}, {new Date(r.proposedAt).toLocaleString()}</dd>
      {r.approvals.length > 0 && <><dt>Approved</dt><dd>{r.approvals.map((a) => names.get(a.userId) ?? '?').join(', ')}</dd></>}
      {r.finalizedBy && <><dt>Finalized</dt><dd>{names.get(r.finalizedBy) ?? '?'}, {r.finalizedAt ? new Date(r.finalizedAt).toLocaleString() : ''}</dd></>}
    </dl>
  );
}

function ProposalForm({ v, st, item }: { v: ProjectView; st: ItemStatus; item: Item }) {
  const { backend, toast, fail } = useApp();
  const p = v.data.project;
  const names = pseudonyms(v.data);
  const vars = agreementVariables(p);
  const choices = useMemo(() => resolutionChoices(p, st, v.data.assessments, names), [p, st, v.data.assessments, names]);
  const [key, setKey] = useState(choices.find((c) => c.available)?.key ?? '');
  const choice = choices.find((c) => c.key === key);
  const baseValues = () => Object.fromEntries(vars.map((x) => [x.id, st.disputed.includes(x.id) ? null : st.comparisons[x.id]?.consensus ?? null])) as Record<string, RatingValue>;
  const [values, setValues] = useState<Record<string, RatingValue>>(baseValues);
  const [rats, setRats] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [refs, setRefs] = useState('');
  const shown = { ...values, ...(choice?.values ?? {}) };
  const editable = !choice?.values;
  const cfg = p.config.resolution;
  return (
    <div className="card stack">
      <h2>Propose a resolution</h2>
      <div className="choice-group" role="radiogroup" aria-label="Resolution option">
        {choices.map((c) => (
          <label key={c.key} className={`choice ${key === c.key ? 'selected' : ''}`} style={{ opacity: c.available ? 1 : 0.55 }}>
            <input type="radio" name="res-opt" checked={key === c.key} disabled={!c.available} onChange={() => setKey(c.key)} />
            <span>
              {c.label}
              {(c.reason || c.option.description) && <small>{c.reason ?? c.option.description}</small>}
            </span>
          </label>
        ))}
      </div>
      <div className="stack">
        <h4>Final values</h4>
        {vars.map((x) => (
          <div key={x.id} style={{ opacity: !st.disputed.includes(x.id) ? 0.8 : 1 }}>
            <VariableInput variable={{ ...x, required: !choice?.allowsBlank && x.required }} value={shown[x.id] ?? null} disabled={!editable} onChange={(val) => setValues((s) => ({ ...s, [x.id]: val }))} />
            {!st.disputed.includes(x.id) && <p className="small muted">Agreed in the independent judgments; prefilled.</p>}
          </div>
        ))}
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>Rationale{cfg.requireRationale ? ' (required: choose one or write one)' : ''}</legend>
        <div className="choice-group">
          {cfg.rationales.filter((r) => r.enabled).map((r) => (
            <label key={r.id} className={`choice ${rats.includes(r.id) ? 'selected' : ''}`}>
              <input type={cfg.allowMultipleRationales ? 'checkbox' : 'radio'} name="rat" checked={rats.includes(r.id)} onChange={(e) => setRats(cfg.allowMultipleRationales ? (e.target.checked ? [...rats, r.id] : rats.filter((x) => x !== r.id)) : [r.id])} />
              <span>{r.label}{r.description && <small>{r.description}</small>}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label={`Explanation${cfg.requireFreeText ? ' (required)' : ' (optional)'}`} hint="Your own reasoning, or a custom rationale when none of the options fits.">
        <textarea value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label="References or evidence (optional)">
        <input type="text" value={refs} onChange={(e) => setRefs(e.target.value)} />
      </Field>
      <div className="row end">
        <button className="btn primary" disabled={!choice} onClick={() => {
          if (!choice) return;
          backend.proposeResolution(p.id, { itemId: item.id, optionId: choice.option.id, retainedUserId: choice.retainedUserId, values: shown, rationaleIds: rats, freeText: text, references: refs }).then(() => toast('Proposal recorded.'), fail);
        }}>Record proposal</button>
      </div>
    </div>
  );
}

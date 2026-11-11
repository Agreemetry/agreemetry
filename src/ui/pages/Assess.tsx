import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { go, useApp, type ProjectView } from '../app';
import { Empty, Field, Icon, ItemText, Markdown, Modal, Notice, Progress, Seg } from '../components';
import { presentationOrder } from '../../core/workflow';
import { stripBlinded } from '../../core/policy';
import type { Assessment, Item, RatingValue, Variable } from '../../core/types';

type QueueFilter = 'todo' | 'all' | 'draft' | 'submitted';

export function Assess({ v, itemId }: { v: ProjectView; itemId?: string }) {
  const { user, backend, toast, fail } = useApp();
  const { data } = v;
  const p = data.project;
  const me = user!.id;
  const membership = data.memberships.find((m) => m.userId === me && m.active);
  const rates = !!membership && (membership.role === 'adjudicator' || membership.adjudicates);
  const mine = useMemo(() => {
    const assigned = data.items.filter((i) => {
      const st = v.statuses.get(i.id);
      if (v.fullView) return st?.assigned.includes(me);
      return true; // the server returns only the items assigned to this adjudicator
    });
    return presentationOrder(p, assigned, me).map((i) => stripBlinded(i, p.config.display.blindedFields));
  }, [data.items, v.statuses, v.fullView, p, me]);
  const myAs = useMemo(() => new Map(data.assessments.filter((a) => a.userId === me).map((a) => [a.itemId, a])), [data.assessments, me]);
  const [filter, setFilter] = useState<QueueFilter>('todo');
  const [showManual, setShowManual] = useState(false);
  const queue = mine.filter((i) => {
    const a = myAs.get(i.id);
    if (filter === 'all') return true;
    if (filter === 'todo') return a?.status !== 'submitted';
    if (filter === 'draft') return a?.status === 'draft';
    return a?.status === 'submitted';
  });
  const current = mine.find((i) => i.id === itemId) ?? queue[0] ?? mine[0];
  const idx = mine.findIndex((i) => i.id === current?.id);
  const submitted = mine.filter((i) => myAs.get(i.id)?.status === 'submitted').length;
  const nextTodo = useCallback((from: string) => {
    const order = mine.map((i) => i.id);
    const start = order.indexOf(from);
    for (let k = 1; k <= order.length; k++) {
      const id = order[(start + k) % order.length];
      if (myAs.get(id)?.status !== 'submitted' && id !== from) return id;
    }
    return null;
  }, [mine, myAs]);

  if (!rates) return <Empty title="You are not an adjudicator on this project">Administrators can also adjudicate if the project settings allow it; their judgments are then not blind.</Empty>;
  if (p.status !== 'active') return <Notice tone="warn">This project is {p.status}. Judgments can be entered once an administrator activates it.</Notice>;
  if (mine.length === 0) return <Empty title="No items assigned to you yet" />;

  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Assess</h1>
          <p>Judge each item on your own. Other judgments stay hidden until the disclosure point. Your work saves as a draft automatically; submit when you are sure.</p>
        </div>
        <button className="btn" onClick={() => setShowManual(true)}><Icon name="guide" />Instructions and manual</button>
      </div>
      <div className="card" style={{ marginBottom: 16, padding: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong className="num">{submitted.toLocaleString()} of {mine.length.toLocaleString()} submitted</strong>
          <span className="small muted">Keys: <span className="kbd">1</span>-<span className="kbd">9</span> choose, <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> submit and next, <span className="kbd">[</span> <span className="kbd">]</span> previous and next</span>
        </div>
        <div style={{ marginTop: 8 }}><Progress value={submitted / mine.length} label="Your progress" /></div>
      </div>
      <div className="workspace">
        <div className="card queue queue-col" aria-label="Your queue">
          <div style={{ padding: '4px 6px 8px' }}>
            <Seg<QueueFilter> label="Queue filter" value={filter} onChange={setFilter} options={[{ value: 'todo', label: 'To do' }, { value: 'draft', label: 'Drafts' }, { value: 'submitted', label: 'Done' }, { value: 'all', label: 'All' }]} />
          </div>
          {queue.slice(0, 400).map((i) => {
            const a = myAs.get(i.id);
            return (
              <button key={i.id} className={i.id === current?.id ? 'current' : ''} onClick={() => go(`/p/${p.id}/assess/${i.id}`)}>
                <span className={`dot ${a?.status ?? ''}`} aria-hidden />
                <span>{i.externalId}</span>
                <span className="sr-only">{a?.status ?? 'not started'}</span>
              </button>
            );
          })}
          {queue.length > 400 && <p className="small muted" style={{ padding: 8 }}>Showing the first 400; submit to move on.</p>}
          {queue.length === 0 && <p className="small muted" style={{ padding: 8 }}>Nothing here.</p>}
        </div>
        {current && <ItemPanel v={v} item={current} />}
        {current && (
          <AssessmentForm
            key={current.id + (myAs.get(current.id)?.status === 'submitted' ? ':locked' : ':open')}
            v={v}
            item={current}
            existing={myAs.get(current.id)}
            onPrev={() => idx > 0 && go(`/p/${p.id}/assess/${mine[idx - 1].id}`)}
            onNext={() => idx < mine.length - 1 && go(`/p/${p.id}/assess/${mine[idx + 1].id}`)}
            onSubmitted={() => {
              const n = nextTodo(current.id);
              toast('Submitted.');
              if (n) go(`/p/${p.id}/assess/${n}`);
            }}
            save={async (input) => {
              try {
                return await backend.saveAssessment(p.id, input);
              } catch (e) {
                fail(e);
                throw e;
              }
            }}
          />
        )}
      </div>
      {showManual && (
        <Modal title="Instructions and manual" onClose={() => setShowManual(false)} wide>
          {p.documents.filter((d) => d.audience === 'all').map((d) => (
            <section key={d.id} style={{ marginBottom: 18 }}>
              <h2>{d.title}</h2>
              <Markdown text={d.body} />
            </section>
          ))}
        </Modal>
      )}
    </div>
  );
}

export function ItemPanel({ v, item }: { v: ProjectView; item: Item }) {
  const p = v.data.project;
  const d = p.config.display;
  const title = d.titleField && item.fields[d.titleField] ? String(item.fields[d.titleField]) : item.externalId;
  const body = d.bodyField ? item.fields[d.bodyField] : undefined;
  const ctxKey = d.contextKeyField ? String(item.fields[d.contextKeyField] ?? '') : '';
  const ctx = ctxKey ? v.data.contexts.find((c) => c.key === ctxKey) : undefined;
  const shown = (d.visibleFields.length ? d.visibleFields : Object.keys(item.fields).filter((k) => k !== d.titleField && k !== d.bodyField && k !== d.contextKeyField && !d.blindedFields.includes(k)))
    .filter((k) => k in item.fields && !d.blindedFields.includes(k))
    .slice(0, 12);
  const [ctxOpen, setCtxOpen] = useState(true);
  return (
    <div className="stack" style={{ minWidth: 0 }}>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="badge neutral mono">{item.externalId}</span>
          {item.batch && <span className="badge neutral">{item.batch}</span>}
        </div>
        <h2>{title}</h2>
        {shown.length > 0 && (
          <dl className="fieldlist" style={{ marginBottom: 12 }}>
            {shown.map((k) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd>{typeof item.fields[k] === 'object' ? JSON.stringify(item.fields[k]) : String(item.fields[k] ?? '')}</dd>
              </div>
            ))}
          </dl>
        )}
        {body !== undefined ? <ItemText text={String(body ?? '')} /> : <p className="muted">No text field is configured for display.</p>}
      </div>
      {ctx && (
        <div className="card">
          <div className="card-head">
            <h3 className="grow">{ctx.title}</h3>
            <button className="btn sm" onClick={() => setCtxOpen(!ctxOpen)} aria-expanded={ctxOpen}>{ctxOpen ? 'Hide' : 'Show'}</button>
          </div>
          {ctxOpen && <Markdown text={ctx.body} className="doc context" />}
        </div>
      )}
    </div>
  );
}

function emptyValue(v: Variable): RatingValue {
  return v.type === 'multilabel' ? [] : null;
}

function AssessmentForm({ v, item, existing, onPrev, onNext, onSubmitted, save }: {
  v: ProjectView; item: Item; existing?: Assessment; onPrev: () => void; onNext: () => void; onSubmitted: () => void;
  save: (input: { itemId: string; values: Record<string, RatingValue>; comment: string; evidence: string; submit: boolean; expectedVersion: number }) => Promise<Assessment>;
}) {
  const { backend, toast, fail } = useApp();
  const p = v.data.project;
  const vars = p.config.variables;
  const [values, setValues] = useState<Record<string, RatingValue>>(() => Object.fromEntries(vars.map((x) => [x.id, existing?.values[x.id] ?? emptyValue(x)])));
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [evidence, setEvidence] = useState(existing?.evidence ?? '');
  const [version, setVersion] = useState(existing?.version ?? 0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const locked = existing?.status === 'submitted';
  const state = v.stateOf(item.id);
  const disclosed = ['agreed', 'disagreement', 'proposed', 'escalated', 'resolved'].includes(state);
  const firstCat = vars.find((x) => ['binary', 'nominal', 'ordinal'].includes(x.type));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = (id: string, val: RatingValue) => {
    if (locked) return;
    setValues((s) => ({ ...s, [id]: val }));
    setDirty(true);
  };

  const persist = useCallback(async (submit: boolean) => {
    const clean = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, x === '' ? null : x]));
    setSaving('saving');
    try {
      const a = await save({ itemId: item.id, values: clean, comment, evidence, submit, expectedVersion: version });
      setVersion(a.version);
      setDirty(false);
      setSaving('saved');
      if (submit) onSubmitted();
    } catch {
      setSaving('idle');
    }
  }, [values, comment, evidence, version, item.id, save, onSubmitted]);

  // Autosave drafts after a pause.
  useEffect(() => {
    if (!dirty || locked) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(false), 1500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [dirty, locked, persist]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'radio' && (e.target as HTMLInputElement).type !== 'checkbox');
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!locked) void persist(true);
        return;
      }
      if (typing) return;
      if (e.key === '[') onPrev();
      if (e.key === ']') onNext();
      if (firstCat && /^[1-9]$/.test(e.key)) {
        const c = firstCat.categories?.[Number(e.key) - 1];
        if (c) set(firstCat.id, c.value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="card panel-sticky stack" aria-label="Your judgment">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Your judgment</h2>
        {locked ? <span className="badge role"><Icon name="lock" size={12} />Submitted</span> : existing ? <span className="badge s-in_progress">Draft</span> : <span className="badge neutral">Not started</span>}
      </div>
      {vars.map((x, vi) => (
        <VariableInput key={x.id} variable={x} value={values[x.id]} onChange={(val) => set(x.id, val)} disabled={locked} shortcuts={x === firstCat} autoFocus={vi === 0} />
      ))}
      <Field label="Comment (optional)">
        <textarea value={comment} disabled={locked} onChange={(e) => { setComment(e.target.value); setDirty(true); }} />
      </Field>
      <Field label="Evidence or justification (optional)">
        <textarea value={evidence} disabled={locked} onChange={(e) => { setEvidence(e.target.value); setDirty(true); }} rows={2} />
      </Field>
      {locked ? (
        <div className="stack">
          <p className="small muted">Submitted {existing?.submittedAt ? new Date(existing.submittedAt).toLocaleString() : ''}. Version {existing?.version}. The original submission is kept even if the item is later resolved differently.</p>
          {p.config.allowAmendBeforeDisclosure && !disclosed && !reopening && <button className="btn" onClick={() => setReopening(true)}>Reopen to correct</button>}
          {reopening && (
            <div className="stack">
              <Field label="Reason for reopening" hint="Recorded in the history and the audit log.">
                <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <div className="row">
                <button className="btn" onClick={() => setReopening(false)}>Cancel</button>
                <button className="btn primary" disabled={!reason.trim()} onClick={() => existing && backend.reopenAssessment(p.id, existing.id, reason).then(() => toast('Reopened as a draft.'), fail)}>Reopen</button>
              </div>
            </div>
          )}
          {disclosed && <Notice tone="info">Judgments on this item are disclosed. Changes now go through the disagreement process.</Notice>}
        </div>
      ) : (
        <div className="row">
          <button className="btn" onClick={() => void persist(false)} disabled={!dirty}>Save draft</button>
          <button className="btn primary" onClick={() => void persist(true)}>Submit and next</button>
          <span className="small muted" aria-live="polite">{saving === 'saving' ? 'Saving' : saving === 'saved' && !dirty ? 'Draft saved' : dirty ? 'Unsaved changes' : ''}</span>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="btn sm ghost" onClick={onPrev}><Icon name="left" size={14} />Previous</button>
        <button className="btn sm ghost" onClick={onNext}>Next<Icon name="right" size={14} /></button>
      </div>
    </div>
  );
}

export function VariableInput({ variable: x, value, onChange, disabled, shortcuts, autoFocus }: { variable: Variable; value: RatingValue; onChange: (v: RatingValue) => void; disabled?: boolean; shortcuts?: boolean; autoFocus?: boolean }) {
  const label = (
    <span>
      {x.label}
      {x.required && <span className="muted"> (required)</span>}
    </span>
  );
  if (x.type === 'binary' || x.type === 'nominal' || x.type === 'ordinal') {
    return (
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>{label}</legend>
        {x.description && <p className="small ink2">{x.description}</p>}
        <div className="choice-group">
          {(x.categories ?? []).map((c, i) => (
            <label key={c.value} className={`choice ${value === c.value ? 'selected' : ''}`}>
              <input type="radio" name={x.id} checked={value === c.value} onChange={() => onChange(c.value)} disabled={disabled} autoFocus={autoFocus && i === 0 && !disabled} />
              <span>
                {c.label}
                {c.description && <small>{c.description}</small>}
              </span>
              {shortcuts && i < 9 && <span className="key">{i + 1}</span>}
            </label>
          ))}
          {!x.required && value !== null && !disabled && <button className="btn sm ghost" type="button" onClick={() => onChange(null)}>Clear</button>}
        </div>
      </fieldset>
    );
  }
  if (x.type === 'multilabel') {
    const set = new Set(Array.isArray(value) ? value : []);
    return (
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>{label}</legend>
        {x.description && <p className="small ink2">{x.description}</p>}
        <div className="choice-group">
          {(x.categories ?? []).map((c) => (
            <label key={c.value} className={`choice ${set.has(c.value) ? 'selected' : ''}`}>
              <input type="checkbox" checked={set.has(c.value)} disabled={disabled} onChange={(e) => {
                const n = new Set(set);
                if (e.target.checked) n.add(c.value);
                else n.delete(c.value);
                onChange([...n]);
              }} />
              <span>{c.label}{c.description && <small>{c.description}</small>}</span>
            </label>
          ))}
        </div>
        <p className="small muted">Leaving every box empty records that no label applies.</p>
      </fieldset>
    );
  }
  if (x.type === 'numeric') {
    return (
      <Field label={x.label + (x.required ? ' (required)' : '')} hint={[x.description, x.min !== undefined || x.max !== undefined ? `Range ${x.min ?? ''} to ${x.max ?? ''}` : ''].filter(Boolean).join('. ')}>
        <input type="number" value={typeof value === 'number' ? value : ''} min={x.min} max={x.max} step={x.step ?? 'any'} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
      </Field>
    );
  }
  return (
    <Field label={x.label + (x.required ? ' (required)' : '')} hint={x.help ?? x.description}>
      <textarea value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

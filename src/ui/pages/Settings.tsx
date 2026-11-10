import { useEffect, useMemo, useState } from 'react';
import { go, useApp, type ProjectView } from '../app';
import { Field, Icon, Markdown, Notice } from '../components';
import type { Category, Membership, Project, RationaleOption, ReferenceRater, ResolutionKind, ResolutionOption, Role, User, VariableType } from '../../core/types';
import { deepClone, slug } from '../../core/util';
import { adjudicators } from '../../core/workflow';
import { Integrations, Ownership } from './Integrations';

const SECTIONS = [
  ['general', 'General'], ['variables', 'Coding form'], ['team', 'Team'], ['workflow', 'Workflow'], ['resolution', 'Resolution'],
  ['display', 'Display and blinding'], ['references', 'Reference raters'], ['documents', 'Documents'], ['lab', 'Lab'], ['integrations', 'Integrations'],
  ['lifecycle', 'Lifecycle'],
] as const;

export function Settings({ v, section = 'general' }: { v: ProjectView; section?: string }) {
  const { backend, toast, fail } = useApp();
  const [draft, setDraft] = useState<Project>(() => deepClone(v.data.project));
  useEffect(() => setDraft(deepClone(v.data.project)), [v.data.project]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(v.data.project);
  const save = () => backend.updateProject(draft).then(() => toast('Settings saved.'), fail);
  const set = (fn: (p: Project) => void) => setDraft((d) => {
    const n = deepClone(d);
    fn(n);
    return n;
  });
  const hasJudgments = v.data.assessments.some((a) => a.status === 'submitted');
  return (
    <div>
      <div className="page-head">
        <div className="grow">
          <h1>Settings</h1>
          <p>Everything about the study is configured here, without code. Changes are versioned in the audit log.</p>
        </div>
        <button className="btn" disabled={!dirty} onClick={() => setDraft(deepClone(v.data.project))}>Discard changes</button>
        <button className="btn primary" disabled={!dirty} onClick={() => void save()}>Save settings</button>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        {SECTIONS.map(([k, l]) => <a key={k} className={`btn sm ${section === k ? 'primary' : ''}`} href={`#/p/${draft.id}/settings/${k}`}>{l}</a>)}
      </div>
      {hasJudgments && ['variables', 'workflow'].includes(section) && <div style={{ marginBottom: 12 }}><Notice tone="warn">Judgments exist. Codes in use cannot be removed or renamed, and variable types cannot change. Changing the agreement rule or the number of judgments re-derives which items are disputed; record the change and the reason.</Notice></div>}
      {dirty && <div style={{ marginBottom: 12 }}><Notice tone="info">Unsaved changes. Save to apply them.</Notice></div>}
      {section === 'general' && <General p={draft} set={set} />}
      {section === 'variables' && <Variables p={draft} set={set} />}
      {section === 'team' && <Team v={v} />}
      {section === 'workflow' && <Workflow p={draft} set={set} v={v} dirty={dirty} />}
      {section === 'resolution' && <Resolution p={draft} set={set} />}
      {section === 'display' && <Display p={draft} set={set} v={v} />}
      {section === 'references' && <References p={draft} set={set} v={v} />}
      {section === 'documents' && <Documents p={draft} set={set} />}
      {section === 'lab' && <Ownership v={v} />}
      {section === 'integrations' && <Integrations v={v} />}
      {section === 'lifecycle' && <Lifecycle v={v} />}
    </div>
  );
}

type Setter = (fn: (p: Project) => void) => void;

function General({ p, set }: { p: Project; set: Setter }) {
  return (
    <div className="card stack">
      <Field label="Name"><input type="text" value={p.name} onChange={(e) => set((d) => { d.name = e.target.value; })} /></Field>
      <Field label="Short name" hint="Used in file names."><input type="text" value={p.shortName ?? ''} onChange={(e) => set((d) => { d.shortName = e.target.value; })} /></Field>
      <Field label="Description"><textarea value={p.description} onChange={(e) => set((d) => { d.description = e.target.value; })} /></Field>
      <Field label="Objectives"><textarea value={p.objectives} onChange={(e) => set((d) => { d.objectives = e.target.value; })} /></Field>
      <Field label="Provenance" hint="Where the items came from; shown to administrators."><textarea value={p.provenance ?? ''} onChange={(e) => set((d) => { d.provenance = e.target.value; })} /></Field>
    </div>
  );
}

const TYPES: { value: VariableType; label: string }[] = [
  { value: 'binary', label: 'Binary (two categories)' }, { value: 'nominal', label: 'Nominal (unordered categories)' }, { value: 'ordinal', label: 'Ordinal (ordered categories)' },
  { value: 'numeric', label: 'Numeric' }, { value: 'multilabel', label: 'Multi-label (any of several labels)' }, { value: 'text', label: 'Free text (not compared)' },
];

function Variables({ p, set }: { p: Project; set: Setter }) {
  const vars = p.config.variables;
  const add = () => set((d) => {
    let i = d.config.variables.length + 1;
    while (d.config.variables.some((x) => x.id === `var${i}`)) i++;
    d.config.variables.push({ id: `var${i}`, label: 'New question', type: 'nominal', required: true, includeInAgreement: true, categories: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }] });
  });
  return (
    <div className="stack">
      {vars.map((x, i) => (
        <div key={i} className="card stack">
          <div className="row">
            <h3 className="grow" style={{ margin: 0 }}>{i + 1}. {x.label}</h3>
            <button className="btn sm" disabled={i === 0} onClick={() => set((d) => { const a = d.config.variables; [a[i - 1], a[i]] = [a[i], a[i - 1]]; })} aria-label="Move up"><Icon name="up" size={14} /></button>
            <button className="btn sm danger" onClick={() => set((d) => { d.config.variables.splice(i, 1); })}>Remove</button>
          </div>
          <div className="grid cols-3">
            <Field label="Code" hint="Column name in exports."><input type="text" value={x.id} onChange={(e) => set((d) => { d.config.variables[i].id = e.target.value.replace(/[^A-Za-z0-9_]/g, '_'); })} /></Field>
            <Field label="Question"><input type="text" value={x.label} onChange={(e) => set((d) => { d.config.variables[i].label = e.target.value; })} /></Field>
            <Field label="Type">
              <select value={x.type} onChange={(e) => set((d) => {
                const t = e.target.value as VariableType;
                const vv = d.config.variables[i];
                vv.type = t;
                if (t === 'text') vv.includeInAgreement = false;
                if (['binary', 'nominal', 'ordinal', 'multilabel'].includes(t) && !vv.categories?.length) vv.categories = [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }];
                if (t === 'binary') vv.categories = (vv.categories ?? []).slice(0, 2);
              })}>
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Definition shown to adjudicators"><textarea rows={2} value={x.description ?? ''} onChange={(e) => set((d) => { d.config.variables[i].description = e.target.value; })} /></Field>
          <div className="row">
            <label className="check"><input type="checkbox" checked={x.required} onChange={(e) => set((d) => { d.config.variables[i].required = e.target.checked; })} />Required to submit</label>
            <label className="check"><input type="checkbox" checked={x.includeInAgreement && x.type !== 'text'} disabled={x.type === 'text'} onChange={(e) => set((d) => { d.config.variables[i].includeInAgreement = e.target.checked; })} />Compared for agreement and reliability</label>
            {x.type === 'ordinal' && (
              <label className="field" style={{ flexDirection: 'row', alignItems: 'center' }}>Weights
                <select value={x.weights ?? 'quadratic'} onChange={(e) => set((d) => { d.config.variables[i].weights = e.target.value as 'linear' | 'quadratic'; })} style={{ width: 'auto' }}><option value="quadratic">quadratic</option><option value="linear">linear</option></select>
              </label>
            )}
          </div>
          {x.type === 'numeric' && (
            <div className="grid cols-3">
              <Field label="Minimum"><input type="number" value={x.min ?? ''} onChange={(e) => set((d) => { d.config.variables[i].min = e.target.value === '' ? undefined : Number(e.target.value); })} /></Field>
              <Field label="Maximum"><input type="number" value={x.max ?? ''} onChange={(e) => set((d) => { d.config.variables[i].max = e.target.value === '' ? undefined : Number(e.target.value); })} /></Field>
              <Field label="Level" hint="For Krippendorff's alpha."><select value={x.numericLevel ?? 'interval'} onChange={(e) => set((d) => { d.config.variables[i].numericLevel = e.target.value as 'interval' | 'ratio'; })}><option value="interval">interval</option><option value="ratio">ratio</option></select></Field>
            </div>
          )}
          {['binary', 'nominal', 'ordinal', 'multilabel'].includes(x.type) && <Categories cats={x.categories ?? []} ordered={x.type === 'ordinal'} fixed={x.type === 'binary'} onChange={(c) => set((d) => { d.config.variables[i].categories = c; })} />}
        </div>
      ))}
      <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={add}><Icon name="plus" />Add question</button>
    </div>
  );
}

function Categories({ cats, ordered, fixed, onChange }: { cats: Category[]; ordered: boolean; fixed: boolean; onChange: (c: Category[]) => void }) {
  const upd = (i: number, patch: Partial<Category>) => onChange(cats.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div>
      <h4>{ordered ? 'Categories, lowest to highest' : 'Categories'}</h4>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Code</th><th>Label</th><th>Description</th><th></th></tr></thead>
          <tbody>{cats.map((c, i) => (
            <tr key={i}>
              <td style={{ width: 140 }}><input type="text" value={c.value} onChange={(e) => upd(i, { value: e.target.value.trim() })} aria-label="Code" /></td>
              <td><input type="text" value={c.label} onChange={(e) => upd(i, { label: e.target.value })} aria-label="Label" /></td>
              <td><input type="text" value={c.description ?? ''} onChange={(e) => upd(i, { description: e.target.value })} aria-label="Description" /></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {ordered && <button className="btn sm" disabled={i === 0} onClick={() => { const a = cats.slice(); [a[i - 1], a[i]] = [a[i], a[i - 1]]; onChange(a); }} aria-label="Move up"><Icon name="up" size={12} /></button>}
                {!fixed && <button className="btn sm ghost" onClick={() => onChange(cats.filter((_, j) => j !== i))} aria-label="Remove category"><Icon name="x" size={12} /></button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {!fixed && <button className="btn sm" style={{ marginTop: 8 }} onClick={() => onChange([...cats, { value: `c${cats.length + 1}`, label: `Category ${cats.length + 1}` }])}><Icon name="plus" size={12} />Add category</button>}
    </div>
  );
}

function Team({ v }: { v: ProjectView }) {
  const { backend, fail, toast } = useApp();
  const p = v.data.project;
  const [users, setUsers] = useState<User[]>([]);
  const [pick, setPick] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [role, setRole] = useState<Role>('adjudicator');
  useEffect(() => { void backend.listUsers().then(setUsers, () => setUsers(v.data.users)); }, [backend, v.data.users]);
  const byId = new Map([...users, ...v.data.users].map((u) => [u.id, u]));
  const upsert = (m: Membership) => backend.upsertMembership(m).then(() => toast('Team updated.'), fail);
  const add = async () => {
    try {
      let uid = pick;
      if (!uid && backend.inviteMember) {
        if (!newEmail.includes('@')) throw new Error('An email address is needed to invite someone to the shared server.');
        await backend.inviteMember(p.id, newEmail, role, newName);
        setPick(''); setNewName(''); setNewEmail('');
        toast('Invitation recorded. The person joins the project when they sign in with that address.');
        return;
      }
      if (!uid) {
        const u = await backend.createUser(newName, newEmail || undefined);
        uid = u.id;
      }
      await backend.upsertMembership({ projectId: p.id, userId: uid, role, pseudonym: '', active: true, adjudicates: role === 'adjudicator' });
      setPick(''); setNewName(''); setNewEmail('');
      toast('Member added.');
    } catch (e) {
      fail(e);
    }
  };
  const count = adjudicators(v.data.memberships).length;
  return (
    <div className="stack">
      <Notice tone={count < p.config.requiredAdjudicators ? 'warn' : 'info'}>{count} active adjudicator{count === 1 ? '' : 's'}; each item needs {p.config.requiredAdjudicators} independent judgments. Pseudonyms (R1, R2, ...) are what other members and exports see.</Notice>
      <div className="card">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Pseudonym</th><th>Name</th><th>Role</th><th>Also adjudicates</th><th>Active</th></tr></thead>
            <tbody>{v.data.memberships.map((m) => (
              <tr key={m.userId}>
                <td className="mono">{m.pseudonym}</td>
                <td>{byId.get(m.userId)?.displayName ?? m.userId}{byId.get(m.userId)?.email ? <div className="small muted">{byId.get(m.userId)!.email}</div> : null}{m.viaLab && <div className="small muted">Administrator through the lab</div>}</td>
                <td><select value={m.role} onChange={(e) => void upsert({ ...m, role: e.target.value as Role, adjudicates: e.target.value === 'adjudicator' ? true : m.adjudicates })} style={{ width: 'auto' }}><option value="admin">Administrator</option><option value="lead">Lead or final reviewer</option><option value="adjudicator">Adjudicator</option></select></td>
                <td><input type="checkbox" aria-label="Also adjudicates" checked={m.adjudicates || m.role === 'adjudicator'} disabled={m.role === 'adjudicator'} onChange={(e) => void upsert({ ...m, adjudicates: e.target.checked })} /></td>
                <td><input type="checkbox" aria-label="Active" checked={m.active} onChange={(e) => void upsert({ ...m, active: e.target.checked })} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className="small muted">Deactivating a member keeps every judgment they submitted. A lead or administrator who also adjudicates is not blind to others' judgments; the dashboard says so.</p>
      </div>
      <div className="card stack">
        <h3>Add a member</h3>
        <div className="grid cols-3">
          <Field label="Existing account">
            <select value={pick} onChange={(e) => setPick(e.target.value)}><option value="">New account</option>{users.filter((u) => !v.data.memberships.some((m) => m.userId === u.id)).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
          </Field>
          {!pick && <Field label="Name"><input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} /></Field>}
          {!pick && <Field label={backend.mode === 'supabase' ? 'Email (invitation)' : 'Email (optional)'}><input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} /></Field>}
          <Field label="Role"><select value={role} onChange={(e) => setRole(e.target.value as Role)}><option value="adjudicator">Adjudicator</option><option value="lead">Lead or final reviewer</option><option value="admin">Administrator</option></select></Field>
        </div>
        <div className="row"><button className="btn primary" disabled={!pick && !newName.trim() && !newEmail.trim()} onClick={() => void add()}>{!pick && backend.inviteMember ? 'Invite' : 'Add to project'}</button></div>
      </div>
    </div>
  );
}

function Workflow({ p, set, v, dirty }: { p: Project; set: Setter; v: ProjectView; dirty: boolean }) {
  const { backend, toast, fail } = useApp();
  const c = p.config;
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Independent judgments</h2>
        <div className="grid cols-3">
          <Field label="Judgments required per item"><input type="number" min={1} max={20} value={c.requiredAdjudicators} onChange={(e) => set((d) => { d.config.requiredAdjudicators = Math.max(1, Number(e.target.value)); if (d.config.assignment.mode === 'fixed_k') d.config.assignment.k = d.config.requiredAdjudicators; })} /></Field>
          <Field label="Who rates what">
            <select value={c.assignment.mode} onChange={(e) => set((d) => { d.config.assignment.mode = e.target.value as 'all' | 'fixed_k'; d.config.assignment.k = d.config.requiredAdjudicators; })}>
              <option value="all">Every adjudicator rates every item</option>
              <option value="fixed_k">Distribute: a fixed number per item, balanced</option>
            </select>
          </Field>
          <Field label="Seed" hint="Makes assignment and presentation order reproducible."><input type="text" value={c.assignment.seed} onChange={(e) => set((d) => { d.config.assignment.seed = e.target.value; })} /></Field>
        </div>
        {c.assignment.mode === 'fixed_k' && (
          <div className="row">
            <span className="small ink2">{v.data.assignments.length.toLocaleString()} assignments exist. Generating adds the missing ones and keeps existing ones.</span>
            <button className="btn" disabled={dirty} title={dirty ? 'Save settings first' : ''} onClick={() => backend.generateAssignments(p.id).then((n) => toast(`Added ${n} assignments.`), fail)}>Generate assignments</button>
          </div>
        )}
        <Field label="Presentation order">
          <select value={c.order} onChange={(e) => set((d) => { d.config.order = e.target.value as 'import' | 'random_per_adjudicator'; })}><option value="random_per_adjudicator">A different seeded random order for each adjudicator</option><option value="import">Import order</option></select>
        </Field>
        <label className="check"><input type="checkbox" checked={c.allowAmendBeforeDisclosure} onChange={(e) => set((d) => { d.config.allowAmendBeforeDisclosure = e.target.checked; })} />Adjudicators may reopen their own submitted judgment before disclosure (with a reason; every version is kept)</label>
        <label className="check"><input type="checkbox" checked={c.allowReviewSubmitted} onChange={(e) => set((d) => { d.config.allowReviewSubmitted = e.target.checked; })} />Adjudicators may review their own submitted judgments</label>
      </div>
      <div className="card stack">
        <h2>Agreement</h2>
        <div className="grid cols-3">
          <Field label="Rule" hint="Applied per variable once all required judgments are in.">
            <select value={c.agreement.rule} onChange={(e) => set((d) => { d.config.agreement.rule = e.target.value as Project['config']['agreement']['rule']; if (d.config.agreement.rule === 'threshold' && !d.config.agreement.threshold) d.config.agreement.threshold = 0.75; })}>
              <option value="unanimous">Unanimous</option><option value="majority">Strict majority</option><option value="threshold">At least a share of judgments</option>
            </select>
          </Field>
          {c.agreement.rule === 'threshold' && <Field label="Share required (0.5 to 1)"><input type="number" step={0.05} min={0.5} max={1} value={c.agreement.threshold ?? 0.75} onChange={(e) => set((d) => { d.config.agreement.threshold = Number(e.target.value); })} /></Field>}
          <Field label="Numeric tolerance" hint="Numbers within this distance agree."><input type="number" min={0} value={c.agreement.numericTolerance ?? 0} onChange={(e) => set((d) => { d.config.agreement.numericTolerance = Number(e.target.value); })} /></Field>
          <Field label="Multi-label comparison"><select value={c.agreement.multilabelMode} onChange={(e) => set((d) => { d.config.agreement.multilabelMode = e.target.value as 'exact' | 'per_label'; })}><option value="per_label">Each label separately</option><option value="exact">Whole label set</option></select></Field>
        </div>
        <p className="small muted">A missing optional answer counts as its own value, so a blank never agrees with an answer. Items with fewer judgments than required are never compared.</p>
      </div>
      <div className="card stack">
        <h2>Disclosure</h2>
        <Field label="When adjudicators may see each other's judgments">
          <select value={c.disclosure} onChange={(e) => set((d) => { d.config.disclosure = e.target.value as Project['config']['disclosure']; })}>
            <option value="item_complete">Per item, once all its required judgments are submitted</option>
            <option value="project_complete">Only when every item has all its judgments (strictest)</option>
            <option value="manual">When an administrator opens disclosure</option>
          </select>
        </Field>
        {c.disclosure === 'manual' && (
          <div className="row">
            <span className="small">{v.data.project.config.disclosed ? 'Disclosure is open.' : 'Disclosure is closed.'}</span>
            {!v.data.project.config.disclosed && <button className="btn" onClick={() => { if (confirm('Open disclosure? Adjudicators will see each other’s judgments on completed items. This cannot be undone.')) backend.openDisclosure(p.id).then(() => toast('Disclosure opened.'), fail); }}>Open disclosure now</button>}
          </div>
        )}
      </div>
    </div>
  );
}

const KINDS: { value: ResolutionKind; label: string }[] = [
  { value: 'retain_adjudicator', label: "Retain an adjudicator's decision" }, { value: 'majority', label: 'Adopt the majority' }, { value: 'new_classification', label: 'New agreed classification' },
  { value: 'modified', label: 'Modified after review' }, { value: 'insufficient_evidence', label: 'Insufficient evidence' }, { value: 'ambiguous', label: 'Ambiguous' }, { value: 'escalate', label: 'Escalate' }, { value: 'custom', label: 'Custom' },
];

function Resolution({ p, set }: { p: Project; set: Setter }) {
  const r = p.config.resolution;
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Procedure</h2>
        <div className="grid cols-2">
          <Field label="Mechanism">
            <select value={r.mechanism} onChange={(e) => set((d) => { d.config.resolution.mechanism = e.target.value as Project['config']['resolution']['mechanism']; })}>
              <option value="discussion">Discussion: a proposal becomes final when the other adjudicators approve it</option>
              <option value="escalation">Discussion with escalation to the lead when needed</option>
              <option value="majority">Majority: proposals confirmed by a lead or administrator</option>
              <option value="lead">Lead decides: a lead or administrator finalizes</option>
            </select>
          </Field>
          <Field label="Approvals needed (0 = all other adjudicators on the item)"><input type="number" min={0} value={r.approvalsRequired} onChange={(e) => set((d) => { d.config.resolution.approvalsRequired = Math.max(0, Number(e.target.value)); })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={r.requireRationale} onChange={(e) => set((d) => { d.config.resolution.requireRationale = e.target.checked; })} />Require a rationale (a standard option or free text)</label>
        <label className="check"><input type="checkbox" checked={r.allowMultipleRationales} onChange={(e) => set((d) => { d.config.resolution.allowMultipleRationales = e.target.checked; })} />Allow several standard rationales</label>
        <label className="check"><input type="checkbox" checked={r.requireFreeText} onChange={(e) => set((d) => { d.config.resolution.requireFreeText = e.target.checked; })} />Require a written explanation</label>
        <p className="small muted">Leads and administrators can always finalize, including escalated items. Every proposal, approval and reopening is kept.</p>
      </div>
      <div className="card">
        <h2>Resolution options</h2>
        <p className="small muted">"{'{adjudicator}'}" in a label is replaced by each adjudicator's pseudonym, so the list adapts to who rated the item.</p>
        <OptionTable rows={r.options} onChange={(rows) => set((d) => { d.config.resolution.options = rows as ResolutionOption[]; })} kinds />
      </div>
      <div className="card">
        <h2>Standard rationales</h2>
        <OptionTable rows={r.rationales} onChange={(rows) => set((d) => { d.config.resolution.rationales = rows as RationaleOption[]; })} />
      </div>
    </div>
  );
}

function OptionTable({ rows, onChange, kinds }: { rows: (ResolutionOption | RationaleOption)[]; onChange: (r: (ResolutionOption | RationaleOption)[]) => void; kinds?: boolean }) {
  const upd = (i: number, patch: Record<string, unknown>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>On</th><th>Code</th>{kinds && <th>Kind</th>}<th>Label</th><th>Description</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>
              <td><input type="checkbox" checked={r.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} aria-label="Enabled" /></td>
              <td className="mono small">{r.id}</td>
              {kinds && <td><select value={(r as ResolutionOption).kind} onChange={(e) => upd(i, { kind: e.target.value })} style={{ width: 'auto' }}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></td>}
              <td><input type="text" value={r.label} onChange={(e) => upd(i, { label: e.target.value })} aria-label="Label" /></td>
              <td><input type="text" value={r.description ?? ''} onChange={(e) => upd(i, { description: e.target.value })} aria-label="Description" /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <button className="btn sm" style={{ marginTop: 8 }} onClick={() => {
        const id = slug(`custom_${rows.length + 1}`);
        onChange([...rows, kinds ? { id, kind: 'custom', label: 'Project-specific resolution', enabled: true } : { id, label: 'Project-specific rationale', enabled: true }]);
      }}><Icon name="plus" size={12} />Add</button>
    </>
  );
}

function fieldNames(v: ProjectView) {
  return [...new Set(v.data.items.slice(0, 500).flatMap((i) => Object.keys(i.fields)))].sort();
}

function Display({ p, set, v }: { p: Project; set: Setter; v: ProjectView }) {
  const names = useMemo(() => fieldNames(v), [v]);
  const d0 = p.config.display;
  const toggle = (list: 'visibleFields' | 'blindedFields', k: string, on: boolean) => set((d) => {
    const l = d.config.display[list];
    d.config.display[list] = on ? [...new Set([...l, k])] : l.filter((x) => x !== k);
  });
  return (
    <div className="stack">
      <div className="card stack">
        <h2>What adjudicators see</h2>
        <div className="grid cols-3">
          {(['titleField', 'bodyField', 'contextKeyField'] as const).map((k) => (
            <Field key={k} label={k === 'titleField' ? 'Title field' : k === 'bodyField' ? 'Main text field' : 'Context document key field'} hint={k === 'contextKeyField' ? 'Items sharing a value see the same context document.' : undefined}>
              <select value={d0[k] ?? ''} onChange={(e) => set((d) => { d.config.display[k] = e.target.value || undefined; })}><option value="">None</option>{names.map((n) => <option key={n}>{n}</option>)}</select>
            </Field>
          ))}
        </div>
      </div>
      <div className="card">
        <h2>Fields</h2>
        <p className="small muted">Shown: extra metadata beside the item (empty means every field not blinded). Blinded: never sent to adjudicators or leads; administrators still see and export them, and can use them for subgroup analyses.</p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Field</th><th>Shown</th><th>Blinded</th></tr></thead>
            <tbody>{names.map((n) => (
              <tr key={n}><td className="mono">{n}</td>
                <td><input type="checkbox" checked={d0.visibleFields.includes(n)} onChange={(e) => toggle('visibleFields', n, e.target.checked)} aria-label={`Show ${n}`} /></td>
                <td><input type="checkbox" checked={d0.blindedFields.includes(n)} onChange={(e) => toggle('blindedFields', n, e.target.checked)} aria-label={`Blind ${n}`} /></td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function References({ p, set, v }: { p: Project; set: Setter; v: ProjectView }) {
  const names = useMemo(() => fieldNames(v), [v]);
  const vars = p.config.variables.filter((x) => x.type !== 'text');
  const upd = (i: number, patch: Partial<ReferenceRater>) => set((d) => { d.config.references[i] = { ...d.config.references[i], ...patch }; });
  return (
    <div className="card stack">
      <p className="ink2">A reference rater is a rating that comes with the items, such as an automated classifier or an earlier coding. Its field should hold category codes of the chosen variable. It is blinded automatically, never enters interrater reliability, and is compared with each adjudicator and with the final classification.</p>
      {p.config.references.map((r, i) => (
        <div key={i} className="grid cols-3" style={{ alignItems: 'end' }}>
          <Field label="Label"><input type="text" value={r.label} onChange={(e) => upd(i, { label: e.target.value })} /></Field>
          <Field label="Variable"><select value={r.variableId} onChange={(e) => upd(i, { variableId: e.target.value })}>{vars.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></Field>
          <Field label="Item field"><select value={r.field} onChange={(e) => set((d) => { d.config.references[i].field = e.target.value; if (!d.config.display.blindedFields.includes(e.target.value)) d.config.display.blindedFields.push(e.target.value); })}><option value="">Choose</option>{names.map((n) => <option key={n}>{n}</option>)}</select></Field>
          <Field label="Description"><input type="text" value={r.description ?? ''} onChange={(e) => upd(i, { description: e.target.value })} /></Field>
          <button className="btn danger sm" onClick={() => set((d) => { d.config.references.splice(i, 1); })}>Remove</button>
        </div>
      ))}
      <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={!vars.length} onClick={() => set((d) => { d.config.references.push({ id: `ref${d.config.references.length + 1}`, label: 'Reference', variableId: vars[0].id, field: '' }); })}><Icon name="plus" />Add reference rater</button>
    </div>
  );
}

function Documents({ p, set }: { p: Project; set: Setter }) {
  const [preview, setPreview] = useState<number | null>(null);
  return (
    <div className="stack">
      {p.documents.map((d, i) => (
        <div className="card stack" key={d.id}>
          <div className="grid cols-2">
            <Field label="Title"><input type="text" value={d.title} onChange={(e) => set((x) => { x.documents[i].title = e.target.value; })} /></Field>
            <Field label="Audience"><select value={d.audience} onChange={(e) => set((x) => { x.documents[i].audience = e.target.value as 'all' | 'admin'; })}><option value="all">Everyone (instructions, coding manual)</option><option value="admin">Administrators only (analysis plan)</option></select></Field>
          </div>
          <Field label="Text (markdown)"><textarea rows={10} value={d.body} onChange={(e) => set((x) => { x.documents[i].body = e.target.value; })} /></Field>
          <div className="row">
            <button className="btn sm" onClick={() => setPreview(preview === i ? null : i)}>{preview === i ? 'Hide preview' : 'Preview'}</button>
            <button className="btn sm danger" onClick={() => set((x) => { x.documents.splice(i, 1); })}>Remove</button>
          </div>
          {preview === i && <div className="card"><Markdown text={d.body} /></div>}
        </div>
      ))}
      <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => set((x) => { x.documents.push({ id: `doc${Date.now()}`, title: 'New document', body: '', audience: 'all' }); })}><Icon name="plus" />Add document</button>
    </div>
  );
}

function Lifecycle({ v }: { v: ProjectView }) {
  const { backend, toast, fail } = useApp();
  const p = v.data.project;
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Status</h2>
        <p className="ink2">Draft: configure and import. Active: adjudicators can submit. Archived: read-only and hidden from the project list.</p>
        <div className="row">
          {(['draft', 'active', 'archived'] as const).map((s) => <button key={s} className={`btn ${p.status === s ? 'primary' : ''}`} onClick={() => backend.setProjectStatus(p.id, s).then(() => toast(`Project is ${s}.`), fail)}>{s}</button>)}
        </div>
      </div>
      <div className="card stack">
        <h2>Duplicate</h2>
        <p className="ink2">Copies the configuration and documents to a new draft project, optionally with the items, never with judgments.</p>
        <div className="row">
          <button className="btn" onClick={() => backend.duplicateProject(p.id, false).then((n) => go(`/p/${n.id}/settings`), fail)}>Duplicate configuration</button>
          <button className="btn" onClick={() => backend.duplicateProject(p.id, true).then((n) => go(`/p/${n.id}/settings`), fail)}>Duplicate with items</button>
        </div>
      </div>
      <div className="card stack">
        <h2>Delete</h2>
        <p className="ink2">Only projects without submitted judgments can be deleted. Archive anything else.</p>
        <div className="row"><button className="btn danger" onClick={() => { if (confirm(`Delete ${p.name} permanently?`)) backend.deleteProject(p.id).then(() => go('/'), fail); }}>Delete project</button></div>
      </div>
    </div>
  );
}

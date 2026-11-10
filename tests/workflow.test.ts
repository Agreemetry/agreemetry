/**
 * Workflow transitions, blinding, permissions and exports, exercised through the same service the
 * application uses: two and three adjudicators, missing judgments, unanimous, majority and partial
 * agreement, disagreements, proposals, approvals, escalation, reopened cases and final resolutions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemDb, Service, fullData, ConflictError, ValidationError } from '../src/data/service';
import { PermissionError, viewFor } from '../src/core/policy';
import { computeAllStatuses, isItemDisclosed, summarize, generateAssignments } from '../src/core/workflow';
import { analyzeVariable } from '../src/core/analysis';
import { buildTables, archiveOf } from '../src/core/io/exporter';
import { seedDemos } from '../src/data/demo';
import type { Item, Project, RatingValue } from '../src/core/types';

let db: MemDb;
let admin: Service;
let adminId: string;
let r: { id: string; s: Service }[];

function items(projectId: string, n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({ id: `i${i + 1}`, projectId, externalId: `X${i + 1}`, batch: i % 2 ? 'b' : 'a', category: '', fields: { text: `item ${i + 1}`, secret_arm: i % 2 ? 'A1' : 'A2' }, importedAt: '', seq: i + 1 }));
}

function setup(nRaters: number, patch: (p: Project) => Project = (p) => p, n = 6) {
  db = new MemDb();
  const tmp = new Service(db, '');
  const a = tmp.createUser('Admin');
  adminId = a.id;
  admin = new Service(db, a.id);
  let p = admin.createProject({ name: 'Test', description: '', objectives: '', templateId: 'blank' });
  p = admin.updateProject(patch({ ...p, status: 'active', config: { ...p.config, requiredAdjudicators: nRaters, display: { ...p.config.display, blindedFields: ['secret_arm'] } } }));
  admin.importItems(p.id, items(p.id, n));
  r = Array.from({ length: nRaters }, (_, i) => {
    const u = tmp.createUser(`Rater ${i + 1}`);
    admin.upsertMembership({ projectId: p.id, userId: u.id, role: 'adjudicator', pseudonym: '', active: true, adjudicates: true });
    return { id: u.id, s: new Service(db, u.id) };
  });
  return p;
}

const submit = (s: Service, pid: string, itemId: string, values: Record<string, RatingValue>, v = 0) => s.saveAssessment(pid, { itemId, values, comment: '', evidence: '', submit: true, expectedVersion: v });

describe('two adjudicators', () => {
  let p: Project;
  beforeEach(() => {
    p = setup(2);
  });

  it('keeps judgments independent until both are submitted, and hides blinded fields', () => {
    submit(r[0].s, p.id, 'i1', { judgment: 'yes' });
    const v1 = r[1].s.getProjectData(p.id);
    expect(v1.assessments.filter((a) => a.userId !== r[1].id)).toHaveLength(0);
    expect(v1.items[0].fields.secret_arm).toBeUndefined();
    expect(v1.serverStatus!.i1.state).toBe('awaiting');
    expect(v1.serverStatus!.i1.disputedVariables).toEqual([]);
    // A draft never counts.
    r[1].s.saveAssessment(p.id, { itemId: 'i1', values: { judgment: 'no' }, comment: '', evidence: '', submit: false, expectedVersion: 0 });
    let st = computeAllStatuses(fullData(db, p.id));
    expect(st.get('i1')!.state).toBe('in_progress');
    expect(r[0].s.getProjectData(p.id).assessments.filter((a) => a.userId === r[1].id)).toHaveLength(0);
    submit(r[1].s, p.id, 'i1', { judgment: 'no' }, 1);
    st = computeAllStatuses(fullData(db, p.id));
    expect(st.get('i1')!.state).toBe('disagreement');
    expect(st.get('i1')!.disputed).toEqual(['judgment']);
    const after = r[0].s.getProjectData(p.id);
    expect(after.assessments.find((a) => a.userId === r[1].id)!.values.judgment).toBe('no');
    expect(after.items[0].fields.secret_arm).toBeUndefined();
    expect(admin.getProjectData(p.id).items[0].fields.secret_arm).toBe('A2');
  });

  it('detects agreement, separates disagreements and summarizes outstanding work', () => {
    const plan: [string, string][] = [['yes', 'yes'], ['no', 'no'], ['yes', 'no'], ['no', 'yes'], ['yes', 'yes']];
    plan.forEach(([x, y], i) => {
      submit(r[0].s, p.id, `i${i + 1}`, { judgment: x });
      submit(r[1].s, p.id, `i${i + 1}`, { judgment: y });
    });
    const st = computeAllStatuses(fullData(db, p.id));
    const s = summarize(st.values());
    expect(s.items).toBe(6);
    expect(s.complete).toBe(5);
    expect(s.awaiting).toBe(1);
    expect(s.agreedComplete).toBe(3);
    expect(s.disagreements).toBe(2);
    expect(s.unresolved).toBe(2);
    expect(st.get('i6')!.finalValues).toBeNull();
  });

  it('resolves by proposal and approval; final values are separate from the originals; reliability uses originals', () => {
    submit(r[0].s, p.id, 'i1', { judgment: 'yes' });
    submit(r[1].s, p.id, 'i1', { judgment: 'no' });
    submit(r[0].s, p.id, 'i2', { judgment: 'yes' });
    submit(r[1].s, p.id, 'i2', { judgment: 'yes' });
    const prop = r[0].s.proposeResolution(p.id, { itemId: 'i1', optionId: 'retain', retainedUserId: r[1].id, values: {}, rationaleIds: ['error'], freeText: 'R1 misread the item.', references: '' });
    expect(prop.values.judgment).toBe('no');
    expect(() => r[0].s.approveResolution(p.id, prop.id)).toThrow(PermissionError); // own proposal
    const fin = r[1].s.approveResolution(p.id, prop.id);
    expect(fin.status).toBe('final');
    const d = fullData(db, p.id);
    const st = computeAllStatuses(d);
    expect(st.get('i1')!.state).toBe('resolved');
    expect(st.get('i1')!.finalValues!.judgment).toBe('no');
    expect(d.assessments.find((a) => a.itemId === 'i1' && a.userId === r[0].id)!.values.judgment).toBe('yes');
    const rel = analyzeVariable(d, d.project.config.variables[0], { bootstrapReps: 50 });
    expect(rel.stats.find((s) => s.id === 'pa')!.value).toBeCloseTo(0.5, 12); // 1 of 2 items agreed originally
    expect(() => r[0].s.proposeResolution(p.id, { itemId: 'i1', optionId: 'new', values: { judgment: 'yes' }, rationaleIds: ['error'], freeText: '', references: '' })).toThrow();
    const { tables } = buildTables(d, { bootstrapReps: 20 });
    const fc = tables.find((t) => t.name === 'final_classifications')!;
    expect(fc.rows.find((x) => x.item_id === 'i1')!.final_judgment).toBe('no');
    expect(fc.rows.find((x) => x.item_id === 'i1')!.resolution_option).toBe('retain');
    const wide = tables.find((t) => t.name === 'assessments_wide')!;
    expect(wide.rows.find((x) => x.item_id === 'i1')!.judgment__R1).toBe('yes');
  });

  it('allows amending before disclosure only, with history', () => {
    const a = submit(r[0].s, p.id, 'i1', { judgment: 'yes' });
    const re = r[0].s.reopenAssessment(p.id, a.id, 'typo');
    expect(re.status).toBe('draft');
    const b = submit(r[0].s, p.id, 'i1', { judgment: 'no' }, re.version);
    expect(b.history.filter((h) => h.status === 'submitted')).toHaveLength(2);
    submit(r[1].s, p.id, 'i1', { judgment: 'no' });
    expect(isItemDisclosed(p, computeAllStatuses(fullData(db, p.id)), 'i1')).toBe(true);
    expect(() => r[0].s.reopenAssessment(p.id, b.id, 'second thoughts')).toThrow(PermissionError);
  });

  it('refuses silent overwrites and stale writes', () => {
    submit(r[0].s, p.id, 'i1', { judgment: 'yes' });
    expect(() => submit(r[0].s, p.id, 'i1', { judgment: 'no' }, 1)).toThrow(PermissionError);
    r[0].s.saveAssessment(p.id, { itemId: 'i2', values: { judgment: 'yes' }, comment: '', evidence: '', submit: false, expectedVersion: 0 });
    expect(() => r[0].s.saveAssessment(p.id, { itemId: 'i2', values: { judgment: 'no' }, comment: '', evidence: '', submit: false, expectedVersion: 0 })).toThrow(ConflictError);
  });

  it('validates submissions', () => {
    expect(() => submit(r[0].s, p.id, 'i1', {})).toThrow(ValidationError);
    expect(() => submit(r[0].s, p.id, 'i1', { judgment: 'maybe' })).toThrow(ValidationError);
  });

  it('enforces roles', () => {
    expect(() => r[0].s.updateProject({ ...p })).toThrow(PermissionError);
    expect(() => r[0].s.importItems(p.id, [])).toThrow(PermissionError);
    expect(r[0].s.getProjectData(p.id).audit).toHaveLength(0);
    expect(admin.getProjectData(p.id).audit.length).toBeGreaterThan(0);
  });

  it('reopening a final resolution returns the item to the disagreement queue', () => {
    submit(r[0].s, p.id, 'i1', { judgment: 'yes' });
    submit(r[1].s, p.id, 'i1', { judgment: 'no' });
    const pr = admin.proposeResolution(p.id, { itemId: 'i1', optionId: 'ambiguous', values: { judgment: null }, rationaleIds: ['insufficient'], freeText: '', references: '' });
    admin.finalizeResolution(p.id, pr.id);
    expect(computeAllStatuses(fullData(db, p.id)).get('i1')!.state).toBe('resolved');
    expect(() => r[0].s.reopenResolution(p.id, pr.id, 'x')).toThrow(PermissionError);
    admin.reopenResolution(p.id, pr.id, 'New evidence');
    expect(computeAllStatuses(fullData(db, p.id)).get('i1')!.state).toBe('disagreement');
    expect(fullData(db, p.id).resolutions.find((x) => x.id === pr.id)!.status).toBe('superseded');
  });

  it('escalation hands the item to the lead', () => {
    const t = new Service(db, '');
    const lead = t.createUser('Lead');
    admin.upsertMembership({ projectId: p.id, userId: lead.id, role: 'lead', pseudonym: '', active: true, adjudicates: false });
    submit(r[0].s, p.id, 'i1', { judgment: 'yes' });
    submit(r[1].s, p.id, 'i1', { judgment: 'no' });
    r[0].s.escalate(p.id, 'i1', 'Need an expert');
    expect(computeAllStatuses(fullData(db, p.id)).get('i1')!.state).toBe('escalated');
    expect(() => r[1].s.proposeResolution(p.id, { itemId: 'i1', optionId: 'new', values: { judgment: 'yes' }, rationaleIds: ['rule'], freeText: '', references: '' })).toThrow(PermissionError);
    const ls = new Service(db, lead.id);
    const pr = ls.proposeResolution(p.id, { itemId: 'i1', optionId: 'new', values: { judgment: 'yes' }, rationaleIds: ['rule'], freeText: '', references: '' });
    ls.finalizeResolution(p.id, pr.id);
    const st = computeAllStatuses(fullData(db, p.id)).get('i1')!;
    expect(st.state).toBe('resolved');
    expect(st.escalated).toBe(false);
  });

  it('refuses configuration changes that would orphan judgments', () => {
    submit(r[0].s, p.id, 'i1', { judgment: 'yes' });
    const cur = fullData(db, p.id).project;
    const bad = { ...cur, config: { ...cur.config, variables: [{ ...cur.config.variables[0], categories: [{ value: 'no', label: 'No' }, { value: 'y', label: 'Yes' }] }] } };
    expect(() => admin.updateProject(bad)).toThrow(ValidationError);
    const ok = { ...cur, config: { ...cur.config, variables: [{ ...cur.config.variables[0], categories: [{ value: 'no', label: 'Absent' }, { value: 'yes', label: 'Present' }] }] } };
    expect(admin.updateProject(ok).version).toBe(cur.version + 1);
    expect(() => admin.updateProject(ok)).toThrow(ConflictError);
  });
});

describe('three adjudicators', () => {
  it('unanimous rule: a 2 to 1 split is a disagreement; majority option is available', () => {
    const p = setup(3);
    ['yes', 'yes', 'no'].forEach((v, k) => submit(r[k].s, p.id, 'i1', { judgment: v }));
    ['yes', 'yes', 'yes'].forEach((v, k) => submit(r[k].s, p.id, 'i2', { judgment: v }));
    ['yes', 'no'].forEach((v, k) => submit(r[k].s, p.id, 'i3', { judgment: v }));
    const st = computeAllStatuses(fullData(db, p.id));
    expect(st.get('i1')!.state).toBe('disagreement');
    expect(st.get('i2')!.agreement).toBe('complete');
    expect(st.get('i3')!.state).toBe('in_progress'); // missing third judgment is not agreement
    const pr = r[0].s.proposeResolution(p.id, { itemId: 'i1', optionId: 'majority', values: {}, rationaleIds: ['rule'], freeText: '', references: '' });
    expect(pr.values.judgment).toBe('yes');
  });

  it('majority rule: a 2 to 1 split is agreed by rule; partial disagreement across variables', () => {
    const p = setup(3, (p0) => ({
      ...p0,
      config: {
        ...p0.config,
        agreement: { ...p0.config.agreement, rule: 'majority' },
        variables: [...p0.config.variables, { id: 'level', label: 'Level', type: 'nominal', required: true, includeInAgreement: true, categories: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] }],
      },
    }));
    [['yes', 'a'], ['yes', 'b'], ['no', 'c']].forEach(([j, l], k) => submit(r[k].s, p.id, 'i1', { judgment: j, level: l }));
    [['yes', 'a'], ['yes', 'a'], ['no', 'a']].forEach(([j, l], k) => submit(r[k].s, p.id, 'i2', { judgment: j, level: l }));
    const st = computeAllStatuses(fullData(db, p.id));
    expect(st.get('i1')!.agreement).toBe('partial');
    expect(st.get('i1')!.disputed).toEqual(['level']);
    expect(st.get('i2')!.state).toBe('agreed');
    expect(st.get('i2')!.agreement).toBe('rule');
    expect(st.get('i2')!.finalValues!.judgment).toBe('yes');
    const rel = analyzeVariable(fullData(db, p.id), fullData(db, p.id).project.config.variables[0], { bootstrapReps: 20 });
    expect(rel.stats.find((s) => s.id === 'fleiss')!.role).toBe('primary');
    expect(rel.pairwise).toHaveLength(3);
  });
});

describe('distributed assignment', () => {
  it('balances k = 2 of 3 adjudicators and blocks unassigned items', () => {
    const p = setup(3, (p0) => ({ ...p0, config: { ...p0.config, requiredAdjudicators: 2, assignment: { mode: 'fixed_k', k: 2, seed: 's' } } }), 30);
    expect(admin.generateAssignments(p.id)).toBe(60);
    const d = fullData(db, p.id);
    const load = r.map((x) => d.assignments.filter((a) => a.userId === x.id).length);
    expect(Math.max(...load) - Math.min(...load)).toBeLessThanOrEqual(1);
    expect(generateAssignments(d.project, d.items, d.memberships, d.assignments)).toHaveLength(0);
    const notMine = d.items.find((i) => !d.assignments.some((a) => a.itemId === i.id && a.userId === r[0].id))!;
    expect(() => submit(r[0].s, p.id, notMine.id, { judgment: 'yes' })).toThrow(PermissionError);
  });
});

describe('archives and packages', () => {
  it('round-trips a project archive and an adjudicator package without leaking blinded fields', () => {
    const p = setup(2);
    submit(r[0].s, p.id, 'i1', { judgment: 'yes' });
    const arch = archiveOf(fullData(db, p.id));
    const db2 = new MemDb();
    const t = new Service(db2, '');
    const me = t.createUser('Importer');
    const p2 = new Service(db2, me.id).importArchive(JSON.parse(JSON.stringify(arch)), { newIds: true });
    expect(fullData(db2, p2.id).items).toHaveLength(6);
    expect(fullData(db2, p2.id).assessments).toHaveLength(1);

    const pkg = admin.exportAdjudicatorPackage(p.id, r[1].id);
    expect(pkg.items.every((i) => i.fields.secret_arm === undefined)).toBe(true);
    expect(pkg.assessments.filter((a) => a.userId !== r[1].id)).toHaveLength(0);
    const remote = new MemDb();
    remote.put('users', pkg.users[0]);
    const rs = new Service(remote, r[1].id);
    rs.importArchive(JSON.parse(JSON.stringify(pkg)), { newIds: false });
    const a = rs.saveAssessment(p.id, { itemId: 'i1', values: { judgment: 'no' }, comment: '', evidence: '', submit: true, expectedVersion: 0 });
    expect(computeAllStatuses(fullData(remote, p.id)).get('i1')!.state).toBe('in_progress');
    const res = admin.importAssessmentPackage(p.id, { format: 'agreemetry-assessments', formatVersion: 1, projectId: p.id, userId: r[1].id, pseudonym: 'R2', exportedAt: '', assessments: [a] });
    expect(res).toEqual({ added: 1, skipped: 0 });
    expect(admin.importAssessmentPackage(p.id, { format: 'agreemetry-assessments', formatVersion: 1, projectId: p.id, userId: r[1].id, pseudonym: 'R2', exportedAt: '', assessments: [a] })).toEqual({ added: 0, skipped: 1 });
    expect(computeAllStatuses(fullData(db, p.id)).get('i1')!.state).toBe('disagreement');
  });
});

describe('demonstration projects', () => {
  it('build end to end through the real workflow', () => {
    db = new MemDb();
    const a = new Service(db, '').createUser('Admin');
    const ps = seedDemos(db, a.id);
    expect(ps).toHaveLength(3);
    const states = ps.map((p) => summarize(computeAllStatuses(fullData(db, p.id)).values()));
    expect(states[0].resolved).toBeGreaterThan(0);
    expect(states[0].escalated).toBe(1);
    expect(states[0].inProgress).toBeGreaterThan(0);
    for (const p of ps) {
      const d = fullData(db, p.id);
      for (const v of d.project.config.variables.filter((x) => x.type !== 'text' && x.includeInAgreement)) analyzeVariable(d, v, { bootstrapReps: 20 });
      expect(() => viewFor(d, a.id)).not.toThrow();
      buildTables(d, { bootstrapReps: 10 });
    }
    void adminId;
  });
});

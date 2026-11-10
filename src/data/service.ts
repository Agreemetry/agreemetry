/**
 * The rules engine behind the local backend. Every operation checks the actor's rights, validates input,
 * records an audit event, and never overwrites a submitted judgment or a final resolution silently.
 * It runs on an in-memory database; persistence is handled by the caller.
 */
import type {
  Assessment, Assignment, AuditEvent, ContextDocument, Discussion, Escalation, Item, Lab, LabDetail, LabMember, LabRole, LabSummary, Membership,
  Project, ProjectArchive, ProjectConfig, ProjectData, ProjectStatus, RatingValue, Resolution, User, Variable,
} from '../core/types';
import { PermissionError, assertAdmin, assertCanAssess, assertCanResolve, membershipOf, roleIn, viewFor } from '../core/policy';
import { approvalsFinalize, canApprove, canFinalize, resolutionChoices, validateProposal } from '../core/resolution';
import { TEMPLATES } from '../core/templates';
import { computeAllStatuses, generateAssignments, isItemDisclosed } from '../core/workflow';
import { pseudonyms } from '../core/analysis';
import { LAB_SLUG_RE, deepClone, labSlug, normalizeOrcid, nowIso, uid } from '../core/util';
import type { AssessmentInput, AssessmentPackage, NewProjectInput, ProjectSummary, ProposalPayload } from './backend';

export class ValidationError extends Error {
  constructor(message: string, public details: string[] = []) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export const STORES = ['users', 'projects', 'memberships', 'items', 'assignments', 'contexts', 'assessments', 'resolutions', 'discussions', 'escalations', 'audit', 'labs', 'labMembers'] as const;
export type StoreName = (typeof STORES)[number];

type Rec = Record<string, unknown>;

export function keyOf(store: StoreName, r: Rec): string {
  switch (store) {
    case 'memberships':
      return `${r.projectId}|${r.userId}`;
    case 'assignments':
      return `${r.projectId}|${r.itemId}|${r.userId}`;
    case 'contexts':
      return `${r.projectId}|${r.key}`;
    case 'labMembers':
      return `${r.labId}|${r.userId}`;
    default:
      return String(r.id);
  }
}

export class MemDb {
  stores: Record<StoreName, Map<string, Rec>> = Object.fromEntries(STORES.map((s) => [s, new Map()])) as Record<StoreName, Map<string, Rec>>;
  dirty = new Map<StoreName, Map<string, Rec | null>>();

  put<T extends object>(store: StoreName, r: T): T {
    const k = keyOf(store, r as Rec);
    this.stores[store].set(k, r as Rec);
    if (!this.dirty.has(store)) this.dirty.set(store, new Map());
    this.dirty.get(store)!.set(k, r as Rec);
    return r;
  }

  del(store: StoreName, key: string): void {
    this.stores[store].delete(key);
    if (!this.dirty.has(store)) this.dirty.set(store, new Map());
    this.dirty.get(store)!.set(key, null);
  }

  all<T>(store: StoreName): T[] {
    return [...this.stores[store].values()] as T[];
  }

  get<T>(store: StoreName, key: string): T | undefined {
    return this.stores[store].get(key) as T | undefined;
  }

  byProject<T>(store: StoreName, projectId: string): T[] {
    const out: T[] = [];
    for (const r of this.stores[store].values()) if (r.projectId === projectId) out.push(r as T);
    return out;
  }

  takeDirty(): Map<StoreName, Map<string, Rec | null>> {
    const d = this.dirty;
    this.dirty = new Map();
    return d;
  }
}

export function fullData(db: MemDb, projectId: string): ProjectData {
  const project = db.get<Project>('projects', projectId);
  if (!project) throw new ValidationError('Project not found.');
  const memberships = db.byProject<Membership>('memberships', projectId);
  const userIds = new Set(memberships.map((m) => m.userId));
  return {
    project,
    memberships,
    users: db.all<User>('users').filter((u) => userIds.has(u.id)),
    items: db.byProject<Item>('items', projectId).sort((a, b) => a.seq - b.seq),
    assignments: db.byProject<Assignment>('assignments', projectId),
    contexts: db.byProject<ContextDocument>('contexts', projectId),
    assessments: db.byProject<Assessment>('assessments', projectId),
    resolutions: db.byProject<Resolution>('resolutions', projectId),
    discussions: db.byProject<Discussion>('discussions', projectId),
    escalations: db.byProject<Escalation>('escalations', projectId),
    audit: db.byProject<AuditEvent>('audit', projectId),
  };
}

/** Validate a set of values against the variable definitions. */
export function validateValues(variables: Variable[], values: Record<string, RatingValue>, requireAll: boolean): string[] {
  const errs: string[] = [];
  for (const v of variables) {
    const val = values[v.id];
    const empty = val === null || val === undefined || val === '';
    if (empty) {
      if (requireAll && v.required) errs.push(`"${v.label}" is required.`);
      continue;
    }
    const codes = new Set((v.categories ?? []).map((c) => c.value));
    switch (v.type) {
      case 'binary':
      case 'nominal':
      case 'ordinal':
        if (typeof val !== 'string' || !codes.has(val)) errs.push(`"${v.label}": "${String(val)}" is not one of the defined categories.`);
        break;
      case 'multilabel':
        if (!Array.isArray(val) || val.some((x) => !codes.has(x))) errs.push(`"${v.label}": unknown label.`);
        else if (requireAll && v.required && val.length === 0) {
          /* an empty set is a valid answer (no label applies) */
        }
        break;
      case 'numeric':
        if (typeof val !== 'number' || !Number.isFinite(val)) errs.push(`"${v.label}" must be a number.`);
        else {
          if (v.min !== undefined && val < v.min) errs.push(`"${v.label}" is below ${v.min}.`);
          if (v.max !== undefined && val > v.max) errs.push(`"${v.label}" is above ${v.max}.`);
        }
        break;
      case 'text':
        if (typeof val !== 'string') errs.push(`"${v.label}" must be text.`);
    }
  }
  for (const k of Object.keys(values)) if (!variables.some((v) => v.id === k)) errs.push(`Unknown variable "${k}".`);
  return errs;
}

/** Changes that would orphan existing judgments are refused. */
export function configChangeIssues(oldCfg: ProjectConfig, next: ProjectConfig, assessments: Assessment[]): string[] {
  const issues: string[] = [];
  const used = new Map<string, Set<string>>();
  for (const a of assessments)
    for (const [k, v] of Object.entries(a.values)) {
      if (v === null || v === undefined || v === '') continue;
      if (!used.has(k)) used.set(k, new Set());
      for (const x of Array.isArray(v) ? v : [String(v)]) used.get(k)!.add(String(x));
    }
  for (const [vid, vals] of used) {
    const before = oldCfg.variables.find((v) => v.id === vid);
    const after = next.variables.find((v) => v.id === vid);
    if (!after) {
      issues.push(`Variable "${before?.label ?? vid}" has recorded judgments and cannot be removed; set it to optional or exclude it from agreement instead.`);
      continue;
    }
    if (before && before.type !== after.type) issues.push(`Variable "${after.label}" has judgments; its type cannot change from ${before.type} to ${after.type}.`);
    if (after.categories && after.type !== 'numeric' && after.type !== 'text') {
      const codes = new Set(after.categories.map((c) => c.value));
      for (const x of vals) if (!codes.has(x)) issues.push(`Category code "${x}" of "${after.label}" is in use and cannot be removed or renamed (labels can change).`);
    }
  }
  if (next.requiredAdjudicators < 1) issues.push('At least one independent judgment per item is required.');
  if (next.agreement.rule === 'threshold' && !(next.agreement.threshold! > 0.5 && next.agreement.threshold! <= 1)) issues.push('The agreement threshold must be above 0.5 and at most 1.');
  const ids = next.variables.map((v) => v.id);
  if (new Set(ids).size !== ids.length) issues.push('Variable codes must be unique.');
  for (const v of next.variables) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(v.id)) issues.push(`Variable code "${v.id}" must start with a letter and use letters, digits or underscores (it becomes a column name).`);
    if (['binary', 'nominal', 'ordinal', 'multilabel'].includes(v.type) && (v.categories?.length ?? 0) < (v.type === 'multilabel' ? 1 : 2)) issues.push(`"${v.label}" needs ${v.type === 'multilabel' ? 'at least one label' : 'at least two categories'}.`);
    if (v.type === 'binary' && (v.categories?.length ?? 0) !== 2) issues.push(`Binary variable "${v.label}" needs exactly two categories.`);
    const codes = (v.categories ?? []).map((c) => c.value);
    if (new Set(codes).size !== codes.length) issues.push(`Category codes of "${v.label}" must be unique.`);
  }
  for (const r of next.references) if (!next.variables.some((v) => v.id === r.variableId)) issues.push(`Reference rater "${r.label}" points to a missing variable.`);
  return issues;
}

export class Service {
  constructor(private db: MemDb, private actorId: string) {}

  private actor(): User {
    const u = this.db.get<User>('users', this.actorId);
    if (!u || !u.active) throw new PermissionError('Sign in with an active account.');
    return u;
  }

  private audit(projectId: string, action: string, entity: string, entityId: string, detail?: Record<string, unknown>) {
    this.db.put<AuditEvent>('audit', { id: uid('ev'), projectId, at: nowIso(), userId: this.actorId, action, entity, entityId, detail });
  }

  private data(projectId: string) {
    const d = fullData(this.db, projectId);
    return { d, statuses: computeAllStatuses(d) };
  }

  /** Run a change that touches several projects all or nothing, as the database does in one transaction. */
  private atomically<T>(fn: () => T): T {
    const stores = ['projects', 'memberships', 'labs', 'labMembers', 'audit'] as const;
    const saved = stores.map((s) => [s, new Map(this.db.stores[s]), this.db.dirty.has(s) ? new Map(this.db.dirty.get(s)) : null] as const);
    try {
      return fn();
    } catch (e) {
      for (const [s, data, dirty] of saved) {
        this.db.stores[s] = data;
        if (dirty) this.db.dirty.set(s, dirty);
        else this.db.dirty.delete(s);
      }
      throw e;
    }
  }

  // Users -------------------------------------------------------------------------------------

  createUser(displayName: string, email?: string): User {
    const name = displayName.trim();
    if (!name) throw new ValidationError('A display name is required.');
    const u: User = { id: uid('u'), displayName: name, email: email?.trim() || undefined, active: true, createdAt: nowIso() };
    return this.db.put('users', u);
  }

  updateUser(u: User): void {
    this.actor();
    const isAdminSomewhere = this.db.all<Membership>('memberships').some((m) => m.userId === this.actorId && m.role === 'admin' && m.active);
    if (u.id !== this.actorId && !isAdminSomewhere) throw new PermissionError('Only administrators can edit other accounts.');
    const old = this.db.get<User>('users', u.id);
    if (!old) throw new ValidationError('Unknown user.');
    const orcidIn = u.orcid?.trim() ?? '';
    const orcid = orcidIn ? normalizeOrcid(orcidIn) : undefined;
    if (orcidIn && !orcid) throw new ValidationError('That ORCID iD is not valid. Check the digits; the last one is a check digit.');
    this.db.put<User>('users', {
      ...old, displayName: u.displayName.trim() || old.displayName, email: u.email, active: u.active,
      affiliation: u.affiliation?.trim() || undefined, orcid: orcid ?? undefined, field: u.field?.trim() || undefined,
    });
  }

  // Labs (group accounts) -----------------------------------------------------------------------
  // Lab owners and administrators administer the lab's projects. A direct project role always wins, so a
  // lab administrator who rates a lab project stays blind.

  private labRole(labId: string, userId = this.actorId): LabRole | undefined {
    return this.db.get<LabMember>('labMembers', `${labId}|${userId}`)?.role;
  }

  private requireLabRole(labId: string, roles: LabRole[]): LabRole {
    this.actor();
    if (!this.db.get<Lab>('labs', labId)) throw new ValidationError('Unknown lab.');
    const r = this.labRole(labId);
    if (!r) throw new PermissionError('You are not a member of this lab.');
    if (!roles.includes(r)) throw new PermissionError(`Your lab role (${r}) cannot do this.`);
    return r;
  }

  private labMembers(labId: string): LabMember[] {
    return this.db.all<LabMember>('labMembers').filter((m) => m.labId === labId);
  }

  private labProjects(labId: string): Project[] {
    return this.db.all<Project>('projects').filter((p) => p.labId === labId);
  }

  private uniqueSlug(wanted: string, exceptId?: string): string {
    const s = labSlug(wanted);
    if (!LAB_SLUG_RE.test(s)) throw new ValidationError('A handle uses lowercase letters, digits and hyphens.');
    if (this.db.all<Lab>('labs').some((l) => l.slug === s && l.id !== exceptId)) throw new ValidationError(`The handle "${s}" is taken. Choose another.`);
    return s;
  }

  private syncLabAdmins(projectId: string): void {
    const p = this.db.get<Project>('projects', projectId);
    if (!p) return;
    const admins = new Set(p.labId ? this.labMembers(p.labId).filter((m) => m.role !== 'member').map((m) => m.userId) : []);
    const ms = this.db.byProject<Membership>('memberships', projectId);
    for (const m of ms) {
      if (m.viaLab && m.active && !admins.has(m.userId)) {
        this.db.put<Membership>('memberships', { ...m, active: false });
        this.audit(projectId, 'member.lab_revoke', 'membership', m.userId, { lab: p.labId ?? null });
      }
    }
    for (const userId of admins) {
      const m = ms.find((x) => x.userId === userId);
      if (!m) {
        const taken = new Set(ms.map((x) => x.pseudonym));
        let i = 1;
        while (taken.has(`ADM${i}`)) i++;
        const nm: Membership = { projectId, userId, role: 'admin', pseudonym: `ADM${i}`, active: true, adjudicates: false, viaLab: true };
        this.db.put('memberships', nm);
        ms.push(nm);
        this.audit(projectId, 'member.lab_grant', 'membership', userId, { lab: p.labId });
      } else if (m.viaLab && !m.active) {
        this.db.put<Membership>('memberships', { ...m, active: true });
        this.audit(projectId, 'member.lab_grant', 'membership', userId, { lab: p.labId });
      }
    }
    if (!this.db.byProject<Membership>('memberships', projectId).some((m) => m.role === 'admin' && m.active)) {
      throw new ValidationError('This change would leave a project without an active administrator. Add a direct administrator to the project first.');
    }
  }

  private syncLab(labId: string): void {
    for (const p of this.labProjects(labId)) this.syncLabAdmins(p.id);
  }

  listLabs(): LabSummary[] {
    this.actor();
    return this.db.all<LabMember>('labMembers')
      .filter((m) => m.userId === this.actorId)
      .map((m) => ({ lab: this.db.get<Lab>('labs', m.labId)!, role: m.role, members: this.labMembers(m.labId).length, projects: this.labProjects(m.labId).length }))
      .filter((x) => !!x.lab)
      .sort((a, b) => a.lab.name.localeCompare(b.lab.name));
  }

  getLab(labId: string): LabDetail {
    this.actor();
    const lab = this.db.get<Lab>('labs', labId);
    const role = this.labRole(labId);
    if (!lab || !role) throw new PermissionError('You are not a member of this lab.');
    const order: LabRole[] = ['owner', 'admin', 'member'];
    const members = this.labMembers(labId)
      .map((m) => {
        const u = this.db.get<User>('users', m.userId);
        return {
          userId: m.userId, displayName: u?.displayName ?? m.userId, email: role !== 'member' || m.userId === this.actorId ? u?.email : undefined,
          affiliation: u?.affiliation, orcid: u?.orcid, role: m.role, joinedAt: m.joinedAt,
        };
      })
      .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.displayName.localeCompare(b.displayName));
    const projects = this.labProjects(labId)
      .map((p) => ({ id: p.id, name: p.name, status: p.status, myRole: this.db.byProject<Membership>('memberships', p.id).find((m) => m.userId === this.actorId && m.active)?.role }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { lab, role, members, invites: [], projects };
  }

  createLab(input: { name: string; slug?: string; description?: string; website?: string }): Lab {
    this.actor();
    const name = input.name.trim();
    if (!name) throw new ValidationError('A lab name is required.');
    const website = input.website?.trim() || undefined;
    if (website && !/^https?:\/\//.test(website)) throw new ValidationError('A website address starts with https://');
    const lab: Lab = { id: uid('lab'), name, slug: this.uniqueSlug(input.slug?.trim() || name), description: input.description ?? '', website, createdBy: this.actorId, createdAt: nowIso() };
    this.db.put('labs', lab);
    this.db.put<LabMember>('labMembers', { labId: lab.id, userId: this.actorId, role: 'owner', joinedAt: lab.createdAt });
    return lab;
  }

  updateLab(next: Lab): Lab {
    this.requireLabRole(next.id, ['owner', 'admin']);
    const old = this.db.get<Lab>('labs', next.id)!;
    const website = next.website?.trim() || undefined;
    if (website && !/^https?:\/\//.test(website)) throw new ValidationError('A website address starts with https://');
    const saved: Lab = { ...old, name: next.name.trim() || old.name, slug: this.uniqueSlug(next.slug || old.slug, old.id), description: next.description, website };
    return this.db.put('labs', saved);
  }

  /** Local workspace: everyone shares this browser, so people are added directly rather than invited. */
  addLabMember(labId: string, userId: string, role: LabRole): void {
    this.atomically(() => {
      const my = this.requireLabRole(labId, ['owner', 'admin']);
      if (role === 'owner' && my !== 'owner') throw new PermissionError('Only an owner can add another owner.');
      if (!this.db.get<User>('users', userId)) throw new ValidationError('Unknown user.');
      if (this.labRole(labId, userId)) throw new ValidationError('That person is already a member of the lab.');
      this.db.put<LabMember>('labMembers', { labId, userId, role, joinedAt: nowIso() });
      this.syncLab(labId);
    });
  }

  setLabMemberRole(labId: string, userId: string, role: LabRole): void {
    this.atomically(() => {
      const my = this.requireLabRole(labId, ['owner', 'admin']);
      const cur = this.labRole(labId, userId);
      if (!cur) throw new ValidationError('That person is not a member of the lab.');
      if ((role === 'owner' || cur === 'owner') && my !== 'owner') throw new PermissionError('Only an owner can change an owner.');
      if (cur === 'owner' && role !== 'owner' && this.labMembers(labId).filter((m) => m.role === 'owner').length <= 1) throw new ValidationError('A lab needs at least one owner.');
      const m = this.db.get<LabMember>('labMembers', `${labId}|${userId}`)!;
      this.db.put<LabMember>('labMembers', { ...m, role });
      this.syncLab(labId);
    });
  }

  removeLabMember(labId: string, userId: string): void {
    this.atomically(() => {
      const my = this.requireLabRole(labId, userId === this.actorId ? ['owner', 'admin', 'member'] : ['owner', 'admin']);
      const cur = this.labRole(labId, userId);
      if (!cur) throw new ValidationError('That person is not a member of the lab.');
      if (cur === 'owner' && userId !== this.actorId && my !== 'owner') throw new PermissionError('Only an owner can remove an owner.');
      if (cur === 'owner' && this.labMembers(labId).filter((m) => m.role === 'owner').length <= 1) throw new ValidationError('A lab needs at least one owner. Make someone else an owner first.');
      this.db.del('labMembers', `${labId}|${userId}`);
      this.syncLab(labId);
    });
  }

  deleteLab(labId: string): void {
    this.requireLabRole(labId, ['owner']);
    if (this.labProjects(labId).length) throw new ValidationError("Move the lab's projects out of the lab first.");
    for (const m of this.labMembers(labId)) this.db.del('labMembers', `${labId}|${m.userId}`);
    this.db.del('labs', labId);
  }

  /** Place a project in a lab, or take it out (null). The caller administers the project and belongs to the lab. */
  moveProjectToLab(projectId: string, labId: string | null): void {
    this.atomically(() => {
      const { d } = this.data(projectId);
      assertAdmin(d, this.actorId);
      if (labId && !this.labRole(labId)) throw new PermissionError('You are not a member of that lab.');
      const next: Project = { ...d.project, labId: labId ?? undefined, updatedAt: nowIso(), version: d.project.version + 1 };
      if (!labId) delete next.labId;
      this.db.put('projects', next);
      this.audit(projectId, 'project.lab', 'project', projectId, { lab: labId });
      this.syncLabAdmins(projectId);
    });
  }

  // Projects ----------------------------------------------------------------------------------

  listProjects(): ProjectSummary[] {
    this.actor();
    const mine = this.db.all<Membership>('memberships').filter((m) => m.userId === this.actorId && m.active);
    return mine
      .map((m) => {
        const project = this.db.get<Project>('projects', m.projectId)!;
        if (!project) return null;
        const items = m.role === 'admin' || m.role === 'lead' || project.config.assignment.mode === 'all'
          ? this.db.byProject<Item>('items', m.projectId).length
          : this.db.byProject<Assignment>('assignments', m.projectId).filter((a) => a.userId === this.actorId).length;
        return { project, role: m.role, items };
      })
      .filter((x): x is ProjectSummary => !!x)
      .sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt));
  }

  getProjectData(projectId: string): ProjectData {
    this.actor();
    const { d, statuses } = this.data(projectId);
    return viewFor(d, this.actorId, statuses);
  }

  createProject(input: NewProjectInput): Project {
    return this.atomically(() => {
      this.actor();
      const t = TEMPLATES.find((x) => x.id === input.templateId) ?? TEMPLATES[TEMPLATES.length - 1];
      if (!input.name.trim()) throw new ValidationError('A project name is required.');
      if (input.labId && !this.labRole(input.labId)) throw new PermissionError('You are not a member of that lab.');
      const at = nowIso();
      const p: Project = {
        id: uid('p'), name: input.name.trim(), description: input.description, objectives: input.objectives, template: t.id, status: 'draft',
        config: t.config(), documents: t.documents(), createdAt: at, updatedAt: at, version: 1, ...(input.labId ? { labId: input.labId } : {}),
      };
      this.db.put('projects', p);
      this.db.put<Membership>('memberships', { projectId: p.id, userId: this.actorId, role: 'admin', pseudonym: 'ADM1', active: true, adjudicates: false });
      this.audit(p.id, 'project.create', 'project', p.id, { template: t.id, lab: input.labId ?? null });
      if (p.labId) this.syncLabAdmins(p.id);
      return p;
    });
  }

  updateProject(next: Project): Project {
    const { d } = this.data(next.id);
    assertAdmin(d, this.actorId);
    if (next.version !== d.project.version) throw new ConflictError('The project was changed by someone else. Reload and apply your change again.');
    const issues = configChangeIssues(d.project.config, next.config, d.assessments);
    if (issues.length) throw new ValidationError('The configuration cannot be saved.', issues);
    // The owning lab changes only through moveProjectToLab.
    const saved: Project = { ...deepClone(next), id: d.project.id, labId: d.project.labId, createdAt: d.project.createdAt, updatedAt: nowIso(), version: d.project.version + 1 };
    if (!saved.labId) delete saved.labId;
    this.db.put('projects', saved);
    this.audit(saved.id, 'project.update', 'project', saved.id, { changed: diffKeys(d.project, saved) });
    return saved;
  }

  duplicateProject(projectId: string, withItems: boolean): Project {
    const { d } = this.data(projectId);
    assertAdmin(d, this.actorId);
    const at = nowIso();
    const p: Project = { ...deepClone(d.project), id: uid('p'), name: `${d.project.name} (copy)`, status: 'draft', createdAt: at, updatedAt: at, version: 1 };
    delete p.labId;
    p.config.disclosed = false;
    this.db.put('projects', p);
    this.db.put<Membership>('memberships', { projectId: p.id, userId: this.actorId, role: 'admin', pseudonym: 'ADM1', active: true, adjudicates: false });
    if (withItems) {
      for (const it of d.items) this.db.put<Item>('items', { ...deepClone(it), id: uid('it'), projectId: p.id });
      for (const c of d.contexts) this.db.put<ContextDocument>('contexts', { ...c, projectId: p.id });
    }
    this.audit(p.id, 'project.duplicate', 'project', p.id, { from: projectId, withItems });
    return p;
  }

  setProjectStatus(projectId: string, status: ProjectStatus): void {
    const { d } = this.data(projectId);
    assertAdmin(d, this.actorId);
    this.db.put('projects', { ...d.project, status, updatedAt: nowIso(), version: d.project.version + 1 });
    this.audit(projectId, 'project.status', 'project', projectId, { from: d.project.status, to: status });
  }

  deleteProject(projectId: string): void {
    const { d } = this.data(projectId);
    assertAdmin(d, this.actorId);
    if (d.assessments.some((a) => a.status === 'submitted')) throw new ValidationError('A project with submitted judgments cannot be deleted; archive it instead.');
    for (const s of STORES) {
      if (s === 'users' || s === 'labs' || s === 'labMembers') continue;
      for (const [k, r] of [...this.db.stores[s]]) if ((s === 'projects' ? r.id : r.projectId) === projectId) this.db.del(s, k);
    }
  }

  // Team ----------------------------------------------------------------------------------------

  upsertMembership(m: Membership): void {
    const { d } = this.data(m.projectId);
    assertAdmin(d, this.actorId);
    if (!this.db.get<User>('users', m.userId)) throw new ValidationError('Unknown user.');
    const existing = d.memberships.find((x) => x.userId === m.userId);
    let pseudonym = m.pseudonym?.trim();
    const taken = new Set(d.memberships.filter((x) => x.userId !== m.userId).map((x) => x.pseudonym));
    if (!pseudonym || taken.has(pseudonym)) {
      const prefix = m.role === 'admin' ? 'ADM' : m.role === 'lead' ? 'L' : 'R';
      let i = 1;
      while (taken.has(`${prefix}${i}`)) i++;
      pseudonym = existing && !taken.has(existing.pseudonym) ? existing.pseudonym : `${prefix}${i}`;
    }
    if (existing && existing.role === 'admin' && m.role !== 'admin' && d.memberships.filter((x) => x.role === 'admin' && x.active).length <= 1) {
      throw new ValidationError('A project needs at least one active administrator.');
    }
    if (existing && existing.role === 'admin' && !m.active && d.memberships.filter((x) => x.role === 'admin' && x.active).length <= 1) {
      throw new ValidationError('A project needs at least one active administrator.');
    }
    // A role set here is a direct role: a later lab change never withdraws it.
    const saved: Membership = { projectId: m.projectId, userId: m.userId, role: m.role, pseudonym, active: m.active, adjudicates: m.role === 'adjudicator' ? true : m.adjudicates };
    this.db.put('memberships', saved);
    this.audit(m.projectId, existing ? 'member.update' : 'member.add', 'membership', m.userId, { role: saved.role, active: saved.active, pseudonym, adjudicates: saved.adjudicates });
  }

  // Items -----------------------------------------------------------------------------------------

  importItems(projectId: string, items: Item[], contexts: ContextDocument[] = []): void {
    const { d } = this.data(projectId);
    assertAdmin(d, this.actorId);
    const seen = new Set(d.items.map((i) => i.externalId));
    const dup = items.filter((i) => seen.has(i.externalId) || !seen.add(i.externalId));
    if (dup.length) throw new ValidationError(`${dup.length} identifiers already exist or repeat.`, dup.slice(0, 10).map((i) => i.externalId));
    let seq = d.items.reduce((m, i) => Math.max(m, i.seq), 0);
    for (const it of items) this.db.put<Item>('items', { ...it, projectId, seq: ++seq });
    for (const c of contexts) this.db.put<ContextDocument>('contexts', { ...c, projectId });
    this.audit(projectId, 'items.import', 'project', projectId, { items: items.length, contexts: contexts.length, batches: [...new Set(items.map((i) => i.batch))] });
  }

  deleteItems(projectId: string, itemIds: string[]): void {
    const { d } = this.data(projectId);
    assertAdmin(d, this.actorId);
    const rated = new Set(d.assessments.map((a) => a.itemId));
    const blocked = itemIds.filter((i) => rated.has(i));
    if (blocked.length) throw new ValidationError(`${blocked.length} items have assessments and cannot be deleted.`);
    for (const id of itemIds) {
      this.db.del('items', id);
      for (const a of d.assignments.filter((x) => x.itemId === id)) this.db.del('assignments', keyOf('assignments', a as unknown as Rec));
    }
    this.audit(projectId, 'items.delete', 'project', projectId, { items: itemIds.length });
  }

  generateAssignments(projectId: string): number {
    const { d } = this.data(projectId);
    assertAdmin(d, this.actorId);
    if (d.project.config.assignment.mode !== 'fixed_k') throw new ValidationError('Assignments are generated only when items are distributed (fixed number per item).');
    const fresh = generateAssignments(d.project, d.items, d.memberships, d.assignments);
    for (const a of fresh) this.db.put('assignments', a);
    this.audit(projectId, 'assignments.generate', 'project', projectId, { added: fresh.length, seed: d.project.config.assignment.seed });
    return fresh.length;
  }

  // Assessments -----------------------------------------------------------------------------------

  saveAssessment(projectId: string, input: AssessmentInput): Assessment {
    this.actor();
    const { d, statuses } = this.data(projectId);
    assertCanAssess(d, statuses, this.actorId, input.itemId);
    const st = statuses.get(input.itemId)!;
    if (st.state === 'resolved') throw new PermissionError('This item is finalized.');
    const existing = d.assessments.find((a) => a.itemId === input.itemId && a.userId === this.actorId);
    if ((existing?.version ?? 0) !== input.expectedVersion) throw new ConflictError('This assessment changed in another window. Reload to see the latest version.');
    if (existing?.status === 'submitted') throw new PermissionError('This judgment is submitted. Reopen it first (allowed only before disclosure, if the project permits).');
    const errs = validateValues(d.project.config.variables, input.values, input.submit);
    if (errs.length) throw new ValidationError(input.submit ? 'The assessment is incomplete.' : 'Some values are invalid.', errs);
    const at = nowIso();
    const base: Assessment = existing ?? { id: uid('as'), projectId, itemId: input.itemId, userId: this.actorId, values: {}, comment: '', evidence: '', status: 'draft', version: 0, createdAt: at, updatedAt: at, history: [] };
    const next: Assessment = { ...base, values: deepClone(input.values), comment: input.comment, evidence: input.evidence, status: input.submit ? 'submitted' : 'draft', version: base.version + 1, updatedAt: at, history: base.history.slice() };
    if (input.submit) {
      next.submittedAt = at;
      next.history.push({ version: next.version, values: deepClone(next.values), comment: next.comment, evidence: next.evidence, status: 'submitted', at });
    }
    this.db.put('assessments', next);
    if (input.submit) this.audit(projectId, 'assessment.submit', 'assessment', next.id, { item: input.itemId, version: next.version });
    return next;
  }

  reopenAssessment(projectId: string, assessmentId: string, reason: string): Assessment {
    const { d, statuses } = this.data(projectId);
    const a = d.assessments.find((x) => x.id === assessmentId);
    if (!a || a.userId !== this.actorId) throw new PermissionError('You can reopen only your own judgment.');
    if (a.status !== 'submitted') throw new ValidationError('Only a submitted judgment can be reopened.');
    if (!d.project.config.allowAmendBeforeDisclosure) throw new PermissionError('This project does not allow amending submitted judgments.');
    if (isItemDisclosed(d.project, statuses, a.itemId)) throw new PermissionError('Judgments on this item are disclosed; the original stands and any change goes through resolution.');
    if (!reason.trim()) throw new ValidationError('Give a reason for reopening.');
    const at = nowIso();
    const next: Assessment = { ...a, status: 'draft', version: a.version + 1, updatedAt: at, history: [...a.history, { version: a.version + 1, values: deepClone(a.values), comment: a.comment, evidence: a.evidence, status: 'draft', at, reason }] };
    this.db.put('assessments', next);
    this.audit(projectId, 'assessment.reopen', 'assessment', a.id, { item: a.itemId, reason });
    return next;
  }

  // Resolution --------------------------------------------------------------------------------------

  proposeResolution(projectId: string, p: ProposalPayload): Resolution {
    const { d, statuses } = this.data(projectId);
    const st = assertCanResolve(d, statuses, this.actorId, p.itemId);
    if (st.state === 'resolved') throw new ValidationError('This item already has a final resolution.');
    const names = pseudonyms(d);
    const choices = resolutionChoices(d.project, st, d.assessments, names);
    const key = p.retainedUserId ? `${p.optionId}:${p.retainedUserId}` : p.optionId;
    const choice = choices.find((c) => c.key === key);
    const values = { ...(choice?.values ?? {}), ...p.values };
    const errs = validateProposal(d.project, st, choice, { choiceKey: key, values, rationaleIds: p.rationaleIds, freeText: p.freeText, references: p.references });
    const vErrs = validateValues(d.project.config.variables.filter((v) => v.type !== 'text' && v.includeInAgreement), Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== '')), false);
    if (errs.length || vErrs.length) throw new ValidationError('The proposal is incomplete.', [...errs, ...vErrs]);
    const prior = d.resolutions.filter((r) => r.itemId === p.itemId);
    for (const r of prior) if (r.status === 'proposed') this.db.put<Resolution>('resolutions', { ...r, status: 'superseded' });
    const at = nowIso();
    const res: Resolution = {
      id: uid('rs'), projectId, itemId: p.itemId, status: 'proposed', values, optionId: p.optionId, retainedUserId: p.retainedUserId, rationaleIds: p.rationaleIds,
      freeText: p.freeText, references: p.references, proposedBy: this.actorId, proposedAt: at, approvals: [], version: prior.reduce((m, r) => Math.max(m, r.version), 0) + 1,
    };
    this.db.put('resolutions', res);
    this.audit(projectId, 'resolution.propose', 'resolution', res.id, { item: p.itemId, option: p.optionId });
    return res;
  }

  approveResolution(projectId: string, resolutionId: string): Resolution {
    const { d, statuses } = this.data(projectId);
    const r = d.resolutions.find((x) => x.id === resolutionId);
    if (!r) throw new ValidationError('Unknown proposal.');
    const st = assertCanResolve(d, statuses, this.actorId, r.itemId);
    if (!canApprove(d.project, st, r, this.actorId)) throw new PermissionError('You cannot approve this proposal (your own proposal, already approved, or not an adjudicator on the item).');
    const at = nowIso();
    let next: Resolution = { ...r, approvals: [...r.approvals, { userId: this.actorId, at }] };
    this.audit(projectId, 'resolution.approve', 'resolution', r.id, { item: r.itemId });
    if (approvalsFinalize(d.project, st, next)) {
      next = { ...next, status: 'final', finalizedBy: this.actorId, finalizedAt: at };
      this.closeEscalations(d, r.itemId);
      this.audit(projectId, 'resolution.finalize', 'resolution', r.id, { item: r.itemId, by: 'approvals' });
    }
    return this.db.put('resolutions', next);
  }

  finalizeResolution(projectId: string, resolutionId: string): Resolution {
    const { d, statuses } = this.data(projectId);
    const r = d.resolutions.find((x) => x.id === resolutionId);
    if (!r || r.status !== 'proposed') throw new ValidationError('Only a pending proposal can be finalized.');
    const st = statuses.get(r.itemId)!;
    if (!canFinalize(d.project, st, roleIn(d, this.actorId))) throw new PermissionError('Only a lead or an administrator can finalize directly.');
    const next: Resolution = { ...r, status: 'final', finalizedBy: this.actorId, finalizedAt: nowIso() };
    this.closeEscalations(d, r.itemId);
    this.audit(projectId, 'resolution.finalize', 'resolution', r.id, { item: r.itemId, by: roleIn(d, this.actorId) });
    return this.db.put('resolutions', next);
  }

  private closeEscalations(d: ProjectData, itemId: string) {
    for (const e of d.escalations) if (e.itemId === itemId && e.open) this.db.put<Escalation>('escalations', { ...e, open: false });
  }

  reopenResolution(projectId: string, resolutionId: string, reason: string): void {
    const { d } = this.data(projectId);
    assertAdmin(d, this.actorId);
    const r = d.resolutions.find((x) => x.id === resolutionId);
    if (!r || r.status !== 'final') throw new ValidationError('Only a final resolution can be reopened.');
    if (!reason.trim()) throw new ValidationError('Give a reason for reopening.');
    this.db.put<Resolution>('resolutions', { ...r, status: 'superseded', reopenedBy: this.actorId, reopenedAt: nowIso(), reopenReason: reason });
    this.audit(projectId, 'resolution.reopen', 'resolution', r.id, { item: r.itemId, reason });
  }

  escalate(projectId: string, itemId: string, reason: string): void {
    const { d, statuses } = this.data(projectId);
    const opt = d.project.config.resolution.options.find((o) => o.kind === 'escalate' && o.enabled);
    if (!opt) throw new PermissionError('Escalation is not enabled for this project.');
    assertCanResolve(d, statuses, this.actorId, itemId);
    if (!reason.trim()) throw new ValidationError('Say why the item needs further review.');
    const e: Escalation = { id: uid('es'), projectId, itemId, userId: this.actorId, reason, at: nowIso(), open: true };
    this.db.put('escalations', e);
    this.audit(projectId, 'item.escalate', 'item', itemId, { reason });
  }

  addDiscussion(projectId: string, itemId: string, text: string): void {
    const { d, statuses } = this.data(projectId);
    const role = roleIn(d, this.actorId);
    const st = statuses.get(itemId);
    if (!role || !st) throw new PermissionError('Not allowed.');
    const ok = role === 'admin' || role === 'lead' || (st.assigned.includes(this.actorId) && st.submitted.includes(this.actorId) && isItemDisclosed(d.project, statuses, itemId));
    if (!ok) throw new PermissionError('Discussion opens after judgments on the item are disclosed.');
    if (!text.trim()) throw new ValidationError('Write a message.');
    this.db.put<Discussion>('discussions', { id: uid('ds'), projectId, itemId, userId: this.actorId, text: text.trim(), at: nowIso() });
  }

  openDisclosure(projectId: string): void {
    const { d } = this.data(projectId);
    assertAdmin(d, this.actorId);
    this.db.put('projects', { ...d.project, config: { ...d.project.config, disclosed: true }, updatedAt: nowIso(), version: d.project.version + 1 });
    this.audit(projectId, 'disclosure.open', 'project', projectId);
  }

  // Archives and packages -----------------------------------------------------------------------------

  importArchive(a: ProjectArchive, opts: { newIds: boolean }): Project {
    this.actor();
    if (a.format !== 'agreemetry-project' || a.formatVersion !== 1) throw new ValidationError('Not an Agreemetry project archive (format version 1).');
    const map = new Map<string, string>();
    const id = (x: string | undefined, prefix: string) => {
      if (!x) return x as unknown as string;
      if (!opts.newIds) return x;
      if (!map.has(x)) map.set(x, uid(prefix));
      return map.get(x)!;
    };
    const pid = id(a.project.id, 'p');
    if (!opts.newIds && this.db.get('projects', pid)) throw new ValidationError('A project with this identifier already exists here. Import as a copy instead.');
    for (const u of a.users) {
      const uidNew = id(u.id, 'u');
      if (!this.db.get('users', uidNew)) this.db.put<User>('users', { ...u, id: uidNew });
    }
    const { labId: _lab, ...projectDoc } = a.project;
    this.db.put<Project>('projects', { ...projectDoc, id: pid });
    const members = a.memberships.map((m) => ({ ...m, projectId: pid, userId: id(m.userId, 'u') }));
    if (!members.some((m) => m.userId === this.actorId && m.role === 'admin' && m.active) && !members.some((m) => m.userId === this.actorId)) {
      members.push({ projectId: pid, userId: this.actorId, role: 'admin', pseudonym: 'ADM-import', active: true, adjudicates: false });
    }
    for (const m of members) this.db.put('memberships', m);
    for (const it of a.items) this.db.put<Item>('items', { ...it, id: id(it.id, 'it'), projectId: pid });
    for (const x of a.assignments ?? []) this.db.put<Assignment>('assignments', { ...x, projectId: pid, itemId: id(x.itemId, 'it'), userId: id(x.userId, 'u') });
    for (const c of a.contexts) this.db.put<ContextDocument>('contexts', { ...c, projectId: pid });
    for (const x of a.assessments) this.db.put<Assessment>('assessments', { ...x, id: id(x.id, 'as'), projectId: pid, itemId: id(x.itemId, 'it'), userId: id(x.userId, 'u') });
    for (const x of a.resolutions) this.db.put<Resolution>('resolutions', { ...x, id: id(x.id, 'rs'), projectId: pid, itemId: id(x.itemId, 'it'), proposedBy: id(x.proposedBy, 'u'), finalizedBy: x.finalizedBy && id(x.finalizedBy, 'u'), retainedUserId: x.retainedUserId && id(x.retainedUserId, 'u'), reopenedBy: x.reopenedBy && id(x.reopenedBy, 'u'), approvals: x.approvals.map((p) => ({ ...p, userId: id(p.userId, 'u') })) });
    for (const x of a.discussions) this.db.put<Discussion>('discussions', { ...x, id: id(x.id, 'ds'), projectId: pid, itemId: id(x.itemId, 'it'), userId: id(x.userId, 'u') });
    for (const x of a.escalations) this.db.put<Escalation>('escalations', { ...x, id: id(x.id, 'es'), projectId: pid, itemId: id(x.itemId, 'it'), userId: id(x.userId, 'u') });
    for (const x of a.audit) this.db.put<AuditEvent>('audit', { ...x, id: id(x.id, 'ev'), projectId: pid, userId: id(x.userId, 'u') });
    this.audit(pid, 'project.import_archive', 'project', pid, { exportedAt: a.exportedAt, items: a.items.length, assessments: a.assessments.length, newIds: opts.newIds });
    return this.db.get<Project>('projects', pid)!;
  }

  exportAdjudicatorPackage(projectId: string, userId: string): ProjectArchive {
    const { d, statuses } = this.data(projectId);
    assertAdmin(d, this.actorId);
    const m = membershipOf(d, userId);
    if (!m) throw new ValidationError('That person is not an active member.');
    const v = viewFor(d, userId, statuses);
    const user = this.db.get<User>('users', userId)!;
    this.audit(projectId, 'package.export', 'membership', userId, { pseudonym: m.pseudonym });
    return {
      format: 'agreemetry-project', formatVersion: 1, exportedAt: nowIso(), project: { ...v.project, status: 'active' }, users: [user],
      memberships: [{ ...m, role: 'adjudicator', adjudicates: true }, { projectId, userId: '__admin__', role: 'admin', pseudonym: 'ADM-remote', active: true, adjudicates: false }],
      items: v.items, assignments: v.assignments, contexts: v.contexts, assessments: v.assessments.filter((a) => a.userId === userId), resolutions: [], discussions: [], escalations: [], audit: [],
    };
  }

  importAssessmentPackage(projectId: string, pkg: AssessmentPackage): { added: number; skipped: number } {
    const { d, statuses } = this.data(projectId);
    assertAdmin(d, this.actorId);
    if (pkg.format !== 'agreemetry-assessments' || pkg.projectId !== projectId) throw new ValidationError('This package belongs to a different project.');
    const m = membershipOf(d, pkg.userId);
    if (!m) throw new ValidationError('The package author is not an active member of this project.');
    let added = 0;
    let skipped = 0;
    const items = new Set(d.items.map((i) => i.id));
    for (const a of pkg.assessments) {
      if (a.userId !== pkg.userId || !items.has(a.itemId) || a.status !== 'submitted') {
        skipped++;
        continue;
      }
      const st = statuses.get(a.itemId);
      if (!st?.assigned.includes(pkg.userId)) {
        skipped++;
        continue;
      }
      const existing = d.assessments.find((x) => x.itemId === a.itemId && x.userId === pkg.userId);
      if (existing?.status === 'submitted') {
        skipped++; // never overwrite a submitted judgment
        continue;
      }
      if (validateValues(d.project.config.variables, a.values, true).length) {
        skipped++;
        continue;
      }
      this.db.put<Assessment>('assessments', { ...a, projectId, id: existing?.id ?? a.id });
      added++;
    }
    this.audit(projectId, 'package.import', 'membership', pkg.userId, { added, skipped, exportedAt: pkg.exportedAt });
    return { added, skipped };
  }
}

function diffKeys(a: Project, b: Project): string[] {
  const out: string[] = [];
  for (const k of ['name', 'description', 'objectives', 'status', 'documents', 'provenance'] as const) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  for (const k of Object.keys(b.config) as (keyof ProjectConfig)[]) if (JSON.stringify(a.config[k]) !== JSON.stringify(b.config[k])) out.push(`config.${k}`);
  return out;
}

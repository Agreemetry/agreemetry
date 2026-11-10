/**
 * Workflow logic: who rates what, in which order, when independent judgments are compared,
 * how agreement is decided, and which state each item is in.
 *
 * Every function is pure. The local backend runs them directly; the Supabase backend runs the
 * same rules in SQL (supabase/migrations/0003_functions.sql) so that blinding is enforced on the server.
 */
import type {
  AgreementConfig,
  Assessment,
  Assignment,
  Item,
  ItemState,
  Membership,
  Project,
  ProjectData,
  RatingValue,
  Resolution,
  Variable,
} from './types';
import { hash32, nowIso, shuffle } from './util';

export const MISSING = '__missing__';

// Membership and assignment ---------------------------------------------------------------

export function adjudicators(memberships: Membership[]): Membership[] {
  return memberships.filter((m) => m.active && (m.role === 'adjudicator' || m.adjudicates));
}

/**
 * Users who must rate an item. In 'all' mode every active adjudicator; in 'fixed_k' mode the stored
 * assignments. Anyone who already submitted is kept, so deactivating a member never hides a judgment.
 */
export function assignedUserIds(
  project: Project,
  memberships: Membership[],
  assignments: Assignment[],
  assessments: Assessment[],
  itemId: string,
): string[] {
  const out = new Set<string>();
  if (project.config.assignment.mode === 'all') {
    for (const m of adjudicators(memberships)) out.add(m.userId);
  } else {
    for (const a of assignments) if (a.itemId === itemId) out.add(a.userId);
  }
  for (const a of assessments) if (a.itemId === itemId && a.status === 'submitted') out.add(a.userId);
  return [...out];
}

/**
 * Balanced, reproducible assignment for fixed_k mode. Items are visited in a seeded order and each takes
 * the next k adjudicators in rotation, so workloads differ by at most one item and every pair of
 * adjudicators is crossed as evenly as the rotation allows. Existing assignments are kept.
 */
export function generateAssignments(
  project: Project,
  items: Item[],
  memberships: Membership[],
  existing: Assignment[],
): Assignment[] {
  const k = Math.max(1, project.config.assignment.k ?? project.config.requiredAdjudicators);
  const raters = adjudicators(memberships)
    .map((m) => m.userId)
    .sort();
  if (raters.length === 0) return [];
  const have = new Map<string, Set<string>>();
  for (const a of existing) {
    if (!have.has(a.itemId)) have.set(a.itemId, new Set());
    have.get(a.itemId)!.add(a.userId);
  }
  const load = new Map<string, number>(raters.map((r) => [r, 0]));
  for (const a of existing) if (load.has(a.userId)) load.set(a.userId, load.get(a.userId)! + 1);
  const order = shuffle(items, `${project.config.assignment.seed}:assign`);
  const out: Assignment[] = [];
  const at = nowIso();
  for (const item of order) {
    const got = have.get(item.id) ?? new Set<string>();
    const need = Math.min(k, raters.length) - got.size;
    if (need <= 0) continue;
    // Least-loaded raters first; ties broken by a seeded hash so the rotation is reproducible.
    const candidates = raters
      .filter((r) => !got.has(r))
      .sort((a, b) => load.get(a)! - load.get(b)! || hash32(`${item.id}:${a}`) - hash32(`${item.id}:${b}`));
    for (const r of candidates.slice(0, need)) {
      out.push({ projectId: project.id, itemId: item.id, userId: r, createdAt: at });
      load.set(r, load.get(r)! + 1);
    }
  }
  return out;
}

/** Presentation order for one adjudicator: import order, or a seeded order unique to the adjudicator. */
export function presentationOrder(project: Project, items: Item[], userId: string): Item[] {
  if (project.config.order === 'import') return items.slice().sort((a, b) => a.seq - b.seq);
  const seed = project.config.assignment.seed;
  return items
    .map((it) => [hash32(`${seed}:${userId}:${it.id}`), it] as const)
    .sort((a, b) => a[0] - b[0] || a[1].seq - b[1].seq)
    .map(([, it]) => it);
}

// Comparison --------------------------------------------------------------------------------

export type VariableOutcome = 'unanimous' | 'rule' | 'split';

export interface VariableComparison {
  variableId: string;
  outcome: VariableOutcome;
  /** Value that would be adopted if the rule is met (modal value; median of the agreeing set for numbers). */
  consensus: RatingValue;
  /** Share of ratings holding the modal value. */
  modalShare: number;
  /** Rating per user. */
  values: Record<string, RatingValue>;
  /** For multilabel per_label: the labels that differ. */
  disputedLabels?: string[];
}

function key(v: RatingValue): string {
  if (v === null || v === undefined || v === '') return MISSING;
  if (Array.isArray(v)) return JSON.stringify([...v].sort());
  return String(v);
}

function meetsRule(share: number, n: number, modalCount: number, cfg: AgreementConfig): boolean {
  if (modalCount === n) return true;
  if (cfg.rule === 'unanimous') return false;
  if (cfg.rule === 'majority') return modalCount > n / 2;
  return share >= (cfg.threshold ?? 1) - 1e-12;
}

/**
 * Compare the independent ratings of one variable. A missing optional answer is treated as its own value,
 * so a blank never counts as agreement with an answer.
 */
export function compareVariable(variable: Variable, ratings: Record<string, RatingValue>, cfg: AgreementConfig): VariableComparison {
  const users = Object.keys(ratings);
  const n = users.length;
  const values = ratings;
  if (n === 0) return { variableId: variable.id, outcome: 'split', consensus: null, modalShare: 0, values };

  if (variable.type === 'numeric') {
    const tol = cfg.numericTolerance ?? 0;
    const nums = users.map((u) => ratings[u]).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    const missing = n - nums.length;
    // Largest set of ratings within a window of width tol.
    let best = 0;
    let bestLo = 0;
    for (let i = 0, j = 0; i < nums.length; i++) {
      while (nums[i] - nums[j] > tol + 1e-12) j++;
      if (i - j + 1 > best) {
        best = i - j + 1;
        bestLo = j;
      }
    }
    const modalCount = Math.max(best, missing);
    const window = nums.slice(bestLo, bestLo + best);
    const consensus = best >= missing && window.length ? window[Math.floor((window.length - 1) / 2)] : null;
    const share = modalCount / n;
    const outcome: VariableOutcome = modalCount === n ? 'unanimous' : meetsRule(share, n, modalCount, cfg) ? 'rule' : 'split';
    return { variableId: variable.id, outcome, consensus, modalShare: share, values };
  }

  if (variable.type === 'multilabel' && cfg.multilabelMode === 'per_label') {
    const labels = (variable.categories ?? []).map((c) => c.value);
    const disputed: string[] = [];
    let worst: VariableOutcome = 'unanimous';
    let minShare = 1;
    const consensus: string[] = [];
    for (const lab of labels) {
      const yes = users.filter((u) => Array.isArray(ratings[u]) && (ratings[u] as string[]).includes(lab)).length;
      const modal = Math.max(yes, n - yes);
      const share = modal / n;
      minShare = Math.min(minShare, share);
      if (yes > n - yes) consensus.push(lab);
      if (modal === n) continue;
      if (meetsRule(share, n, modal, cfg)) {
        if (worst === 'unanimous') worst = 'rule';
      } else {
        worst = 'split';
        disputed.push(lab);
      }
    }
    return { variableId: variable.id, outcome: worst, consensus, modalShare: minShare, values, disputedLabels: disputed };
  }

  const counts = new Map<string, { n: number; v: RatingValue }>();
  for (const u of users) {
    const k = key(ratings[u]);
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { n: 1, v: ratings[u] ?? null });
  }
  let modal = { n: 0, v: null as RatingValue, k: '' };
  for (const [k, c] of counts) if (c.n > modal.n) modal = { n: c.n, v: c.v, k };
  // A tie for the top value is never a majority.
  const tied = [...counts.values()].filter((c) => c.n === modal.n).length > 1;
  const share = modal.n / n;
  const outcome: VariableOutcome =
    modal.n === n ? 'unanimous' : !tied && meetsRule(share, n, modal.n, cfg) ? 'rule' : 'split';
  return { variableId: variable.id, outcome, consensus: modal.k === MISSING ? null : modal.v, modalShare: share, values };
}

// Item state ----------------------------------------------------------------------------------

export type AgreementLevel = 'complete' | 'rule' | 'partial' | 'none';

export interface ItemStatus {
  itemId: string;
  state: ItemState;
  assigned: string[];
  submitted: string[];
  required: number;
  comparisons: Record<string, VariableComparison>;
  disputed: string[];
  /** complete: every variable unanimous; rule: all meet the rule; partial: some disputed; none: all disputed. */
  agreement: AgreementLevel | null;
  /** Values the item carries forward: agreed values, or the final resolution. */
  finalValues: Record<string, RatingValue> | null;
  finalSource: 'agreement' | 'resolution' | null;
  resolution?: Resolution;
  proposal?: Resolution;
  escalated: boolean;
}

export function agreementVariables(project: Project): Variable[] {
  return project.config.variables.filter((v) => v.type !== 'text' && v.includeInAgreement !== false);
}

/** Submitted assessments for an item: the current value of each independent judgment. */
export function submittedFor(assessments: Assessment[], itemId: string): Assessment[] {
  return assessments.filter((a) => a.itemId === itemId && a.status === 'submitted');
}

/**
 * The first submitted version of an assessment. A submitted assessment can change only before disclosure
 * (and only when the project allows it), so its current values are still the independent judgment and are
 * what comparison and reliability use; the first submission is kept for audit and exported alongside.
 */
export function originalSubmission(a: Assessment): { values: Record<string, RatingValue>; at: string } | null {
  const first = a.history.find((h) => h.status === 'submitted');
  if (first) return { values: first.values, at: first.at };
  if (a.status === 'submitted') return { values: a.values, at: a.submittedAt ?? a.updatedAt };
  return null;
}

export function computeItemStatus(data: ProjectData, item: Item, index?: StatusIndex): ItemStatus {
  const { project } = data;
  const idx = index ?? buildIndex(data);
  const assigned = assignedUserIds(project, data.memberships, idx.assignmentsByItem.get(item.id) ?? [], idx.assessmentsByItem.get(item.id) ?? [], item.id);
  const subs = (idx.assessmentsByItem.get(item.id) ?? []).filter((a) => a.status === 'submitted');
  // Never lowered to the number assigned: an item rated by fewer people than required is not compared.
  const required = Math.max(1, project.config.requiredAdjudicators);
  const resolutions = idx.resolutionsByItem.get(item.id) ?? [];
  const final = resolutions.find((r) => r.status === 'final');
  const proposal = resolutions.filter((r) => r.status === 'proposed').sort((a, b) => b.version - a.version)[0];
  const escalated = (idx.escalationsByItem.get(item.id) ?? []).some((e) => e.open);
  const base: ItemStatus = {
    itemId: item.id,
    state: 'awaiting',
    assigned,
    submitted: subs.map((s) => s.userId),
    required,
    comparisons: {},
    disputed: [],
    agreement: null,
    finalValues: null,
    finalSource: null,
    resolution: final,
    proposal,
    escalated,
  };
  if (assigned.length === 0 && subs.length === 0) return { ...base, state: 'unassigned' };
  if (subs.length < required) return { ...base, state: subs.length === 0 ? 'awaiting' : 'in_progress' };

  const vars = agreementVariables(project);
  const comparisons: Record<string, VariableComparison> = {};
  const disputed: string[] = [];
  let unanimous = 0;
  for (const v of vars) {
    const ratings: Record<string, RatingValue> = {};
    for (const s of subs) ratings[s.userId] = s.values[v.id] ?? null;
    const c = compareVariable(v, ratings, project.config.agreement);
    comparisons[v.id] = c;
    if (c.outcome === 'split') disputed.push(v.id);
    if (c.outcome === 'unanimous') unanimous++;
  }
  const agreement: AgreementLevel =
    disputed.length === 0 ? (unanimous === vars.length ? 'complete' : 'rule') : disputed.length === vars.length ? 'none' : 'partial';
  const withCmp = { ...base, comparisons, disputed, agreement };
  if (final) return { ...withCmp, state: 'resolved', finalValues: final.values, finalSource: 'resolution' };
  if (disputed.length === 0) {
    const values: Record<string, RatingValue> = {};
    for (const v of vars) values[v.id] = comparisons[v.id].consensus;
    return { ...withCmp, state: 'agreed', finalValues: values, finalSource: 'agreement' };
  }
  if (escalated) return { ...withCmp, state: 'escalated' };
  if (proposal) return { ...withCmp, state: 'proposed' };
  return { ...withCmp, state: 'disagreement' };
}

export interface StatusIndex {
  assessmentsByItem: Map<string, Assessment[]>;
  assignmentsByItem: Map<string, Assignment[]>;
  resolutionsByItem: Map<string, Resolution[]>;
  escalationsByItem: Map<string, ProjectData['escalations']>;
}

export function buildIndex(data: ProjectData): StatusIndex {
  const by = <T extends { itemId: string }>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) {
      const a = m.get(x.itemId);
      if (a) a.push(x);
      else m.set(x.itemId, [x]);
    }
    return m;
  };
  return {
    assessmentsByItem: by(data.assessments),
    assignmentsByItem: by(data.assignments),
    resolutionsByItem: by(data.resolutions),
    escalationsByItem: by(data.escalations),
  };
}

export function computeAllStatuses(data: ProjectData): Map<string, ItemStatus> {
  const idx = buildIndex(data);
  const out = new Map<string, ItemStatus>();
  for (const it of data.items) out.set(it.id, computeItemStatus(data, it, idx));
  return out;
}

// Disclosure ------------------------------------------------------------------------------------

/** Whether the independent judgments on an item may be shown to its adjudicators. */
export function isItemDisclosed(project: Project, statuses: Map<string, ItemStatus>, itemId: string): boolean {
  const st = statuses.get(itemId);
  if (!st || st.submitted.length < st.required) return false;
  switch (project.config.disclosure) {
    case 'item_complete':
      return true;
    case 'manual':
      return project.config.disclosed;
    case 'project_complete':
      for (const s of statuses.values()) {
        if (s.state === 'unassigned') continue;
        if (s.submitted.length < s.required) return false;
      }
      return true;
  }
}

// Summary ---------------------------------------------------------------------------------------

export interface WorkflowSummary {
  items: number;
  assigned: number;
  unassigned: number;
  awaiting: number;
  inProgress: number;
  /** Items with all required independent judgments. */
  complete: number;
  agreedComplete: number;
  agreedRule: number;
  disagreements: number;
  partialDisagreements: number;
  resolved: number;
  unresolved: number;
  proposed: number;
  escalated: number;
  assessmentsSubmitted: number;
  assessmentsRequired: number;
  finalized: number;
  completion: number;
}

export function summarize(statuses: Iterable<ItemStatus>): WorkflowSummary {
  const s: WorkflowSummary = {
    items: 0, assigned: 0, unassigned: 0, awaiting: 0, inProgress: 0, complete: 0, agreedComplete: 0, agreedRule: 0,
    disagreements: 0, partialDisagreements: 0, resolved: 0, unresolved: 0, proposed: 0, escalated: 0,
    assessmentsSubmitted: 0, assessmentsRequired: 0, finalized: 0, completion: 0,
  };
  for (const st of statuses) {
    s.items++;
    if (st.state === 'unassigned') {
      s.unassigned++;
      continue;
    }
    s.assigned++;
    s.assessmentsRequired += st.required;
    s.assessmentsSubmitted += Math.min(st.submitted.length, st.required);
    if (st.state === 'awaiting') s.awaiting++;
    if (st.state === 'in_progress') s.inProgress++;
    if (st.submitted.length >= st.required) s.complete++;
    if (st.state === 'agreed') {
      if (st.agreement === 'complete') s.agreedComplete++;
      else s.agreedRule++;
    }
    if (st.disputed.length > 0) {
      s.disagreements++;
      if (st.agreement === 'partial') s.partialDisagreements++;
      if (st.state === 'resolved') s.resolved++;
      else s.unresolved++;
      if (st.state === 'proposed') s.proposed++;
      if (st.state === 'escalated') s.escalated++;
    }
    if (st.finalValues) s.finalized++;
  }
  // Completion: each assigned item counts as finished once it carries final values.
  s.completion = s.assigned ? s.finalized / s.assigned : 0;
  return s;
}

/** Progress per adjudicator: assigned items and submitted judgments. */
export function adjudicatorProgress(data: ProjectData, statuses: Map<string, ItemStatus>) {
  const rows = adjudicators(data.memberships).map((m) => ({ userId: m.userId, pseudonym: m.pseudonym, assigned: 0, submitted: 0, drafts: 0 }));
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  for (const st of statuses.values()) for (const u of st.assigned) if (byUser.has(u)) byUser.get(u)!.assigned++;
  for (const a of data.assessments) {
    const r = byUser.get(a.userId);
    if (!r) continue;
    if (a.status === 'submitted') r.submitted++;
    else r.drafts++;
  }
  return rows;
}

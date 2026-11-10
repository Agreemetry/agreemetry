/**
 * Access policy. These rules decide what each person may see and do; blinding depends on them.
 * The local backend applies them to every read and write; the Supabase backend applies the same
 * rules in row-level security and security-definer functions.
 *
 * Visibility
 *  - Administrators see everything, including blinded fields and the audit log.
 *  - Adjudicators see the items assigned to them, without blinded fields, and their own assessments.
 *    Other adjudicators' judgments on an item become visible only after the item reaches the project's
 *    disclosure point AND the viewer has submitted their own judgment on it (or is not rating it).
 *  - Leads see items and judgments after disclosure, so they can facilitate and finalize.
 *  - Disagreement state is shown to an adjudicator only once judgments on the item are disclosed to them.
 */
import type { Assessment, Item, Membership, ProjectData, Role, ServerItemStatus } from './types';
import { computeAllStatuses, isItemDisclosed, type ItemStatus } from './workflow';

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

export function membershipOf(data: Pick<ProjectData, 'memberships' | 'project'>, userId: string): Membership | undefined {
  return data.memberships.find((m) => m.userId === userId && m.projectId === data.project.id && m.active);
}

export function roleIn(data: Pick<ProjectData, 'memberships' | 'project'>, userId: string): Role | undefined {
  return membershipOf(data, userId)?.role;
}

export function stripBlinded(item: Item, blinded: string[]): Item {
  if (!blinded.length) return item;
  const fields = { ...item.fields };
  for (const f of blinded) delete fields[f];
  return { ...item, fields };
}

/** Whether a viewer may see another person's assessment. */
export function canSeeAssessment(data: ProjectData, statuses: Map<string, ItemStatus>, viewerId: string, a: Assessment): boolean {
  if (a.userId === viewerId) return true;
  const role = roleIn(data, viewerId);
  if (role === 'admin') return true;
  if (a.status !== 'submitted') return false;
  if (!isItemDisclosed(data.project, statuses, a.itemId)) return false;
  const st = statuses.get(a.itemId);
  if (!st) return false;
  const viewerRates = st.assigned.includes(viewerId);
  if (viewerRates && !st.submitted.includes(viewerId)) return false;
  return role === 'lead' || viewerRates;
}

/** The project as one viewer may see it. */
export function viewFor(full: ProjectData, viewerId: string, statuses = computeAllStatuses(full)): ProjectData {
  const m = membershipOf(full, viewerId);
  if (!m) throw new PermissionError('You are not a member of this project.');
  if (m.role === 'admin') return { ...full };
  const blinded = full.project.config.display.blindedFields;
  const visibleItem = (it: Item) => {
    const st = statuses.get(it.id);
    if (!st) return false;
    if (m.role === 'lead') return true;
    return st.assigned.includes(viewerId) || st.submitted.includes(viewerId);
  };
  const items = full.items.filter(visibleItem).map((it) => stripBlinded(it, blinded));
  const itemIds = new Set(items.map((i) => i.id));
  const disclosedTo = (itemId: string) => {
    if (!isItemDisclosed(full.project, statuses, itemId)) return false;
    const st = statuses.get(itemId)!;
    return !st.assigned.includes(viewerId) || st.submitted.includes(viewerId) || m.role === 'lead';
  };
  const assessments = full.assessments.filter((a) => itemIds.has(a.itemId) && canSeeAssessment(full, statuses, viewerId, a));
  const serverStatus: Record<string, ServerItemStatus> = {};
  for (const it of items) {
    const st = statuses.get(it.id)!;
    const open = disclosedTo(it.id);
    serverStatus[it.id] = {
      itemId: it.id,
      submitted: open ? st.submitted.length : st.submitted.includes(viewerId) ? 1 : 0,
      required: st.required,
      state: open ? st.state : st.state === 'unassigned' ? 'unassigned' : st.submitted.includes(viewerId) ? 'in_progress' : 'awaiting',
      disputedVariables: open ? st.disputed : [],
    };
  }
  const sharedItem = (id: string) => itemIds.has(id) && disclosedTo(id);
  const pseudoOnly = full.memberships.map((mm) => ({ ...mm }));
  return {
    project: { ...full.project, documents: full.project.documents.filter((d) => d.audience === 'all') },
    memberships: pseudoOnly,
    users: full.users.filter((u) => u.id === viewerId),
    items,
    assignments: full.assignments.filter((a) => a.userId === viewerId || m.role === 'lead'),
    contexts: full.contexts,
    assessments,
    resolutions: full.resolutions.filter((r) => sharedItem(r.itemId)),
    discussions: full.discussions.filter((d) => sharedItem(d.itemId)),
    escalations: full.escalations.filter((e) => sharedItem(e.itemId)),
    audit: [],
    serverStatus,
  };
}

/** May this user write an assessment for the item? */
export function assertCanAssess(full: ProjectData, statuses: Map<string, ItemStatus>, userId: string, itemId: string): void {
  const m = membershipOf(full, userId);
  if (!m) throw new PermissionError('You are not a member of this project.');
  if (full.project.status !== 'active') throw new PermissionError('The project is not active.');
  const st = statuses.get(itemId);
  if (!st || !st.assigned.includes(userId)) throw new PermissionError('This item is not assigned to you.');
}

export function assertAdmin(full: Pick<ProjectData, 'memberships' | 'project'>, userId: string): void {
  if (roleIn(full, userId) !== 'admin') throw new PermissionError('Administrator rights are required.');
}

/** Disputed item open to this user for discussion and proposals. */
export function assertCanResolve(full: ProjectData, statuses: Map<string, ItemStatus>, userId: string, itemId: string): ItemStatus {
  const role = roleIn(full, userId);
  if (!role) throw new PermissionError('You are not a member of this project.');
  const st = statuses.get(itemId);
  if (!st) throw new PermissionError('Unknown item.');
  if (st.disputed.length === 0) throw new PermissionError('This item has no disagreement to resolve.');
  if (role === 'admin' || role === 'lead') return st;
  if (!isItemDisclosed(full.project, statuses, itemId)) throw new PermissionError('Independent judgments on this item are not yet disclosed.');
  if (!st.assigned.includes(userId) || !st.submitted.includes(userId)) throw new PermissionError('Only the adjudicators who rated this item can resolve it.');
  if (st.escalated) throw new PermissionError('This item is escalated; the lead or final reviewer resolves it.');
  return st;
}

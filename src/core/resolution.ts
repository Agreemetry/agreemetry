/**
 * Disagreement resolution: the choices available for a disputed item (adapted to who rated it and to the
 * project's options), validation of a proposal, and who may approve or finalize it.
 */
import type { Assessment, Membership, Project, RatingValue, Resolution, ResolutionOption, Role } from './types';
import type { ItemStatus } from './workflow';
import { agreementVariables } from './workflow';

export interface ResolutionChoice {
  key: string;
  option: ResolutionOption;
  label: string;
  retainedUserId?: string;
  /** Values implied by the choice (retain or majority); undefined when the resolver enters them. */
  values?: Record<string, RatingValue>;
  available: boolean;
  reason?: string;
  /** Values may be left blank for disputed variables (insufficient evidence, ambiguous). */
  allowsBlank: boolean;
}

export function resolutionChoices(project: Project, status: ItemStatus, assessments: Assessment[], names: Map<string, string>): ResolutionChoice[] {
  const vars = agreementVariables(project);
  const subs = assessments.filter((a) => a.itemId === status.itemId && a.status === 'submitted');
  const out: ResolutionChoice[] = [];
  for (const opt of project.config.resolution.options) {
    if (!opt.enabled) continue;
    switch (opt.kind) {
      case 'retain_adjudicator':
        for (const s of subs) {
          const values: Record<string, RatingValue> = {};
          for (const v of vars) values[v.id] = s.values[v.id] ?? null;
          const who = names.get(s.userId) ?? 'adjudicator';
          out.push({ key: `${opt.id}:${s.userId}`, option: opt, label: opt.label.replace('{adjudicator}', who).replace(/^Retain an adjudicator's/, `Retain ${who}'s`), retainedUserId: s.userId, values, available: true, allowsBlank: false });
        }
        break;
      case 'majority': {
        const values: Record<string, RatingValue> = {};
        let ok = true;
        for (const v of vars) {
          const c = status.comparisons[v.id];
          if (!c) {
            ok = false;
            continue;
          }
          const n = Object.keys(c.values).length;
          const strict = c.modalShare * n > n / 2 + 1e-9;
          if (!strict) ok = false;
          values[v.id] = c.consensus;
        }
        out.push({ key: opt.id, option: opt, label: opt.label, values: ok ? values : undefined, available: ok, reason: ok ? undefined : 'No strict majority on every disputed variable.', allowsBlank: false });
        break;
      }
      case 'insufficient_evidence':
      case 'ambiguous':
        out.push({ key: opt.id, option: opt, label: opt.label, available: true, allowsBlank: true });
        break;
      case 'escalate':
        // Escalation is an action, not a final value; the UI shows it as a separate button.
        break;
      default:
        out.push({ key: opt.id, option: opt, label: opt.label, available: true, allowsBlank: false });
    }
  }
  return out;
}

export interface ProposalInput {
  choiceKey: string;
  values: Record<string, RatingValue>;
  rationaleIds: string[];
  freeText: string;
  references: string;
}

export function validateProposal(project: Project, status: ItemStatus, choice: ResolutionChoice | undefined, input: ProposalInput): string[] {
  const errs: string[] = [];
  const cfg = project.config.resolution;
  if (!choice) return ['Choose a resolution option.'];
  if (!choice.available) errs.push(choice.reason ?? 'This option is not available for this item.');
  if (cfg.requireRationale && input.rationaleIds.length === 0 && !input.freeText.trim()) errs.push('Select a rationale or write one.');
  if (!cfg.allowMultipleRationales && input.rationaleIds.length > 1) errs.push('Select only one rationale.');
  if (cfg.requireFreeText && !input.freeText.trim()) errs.push('A written rationale is required.');
  for (const id of input.rationaleIds) if (!cfg.rationales.some((r) => r.id === id && r.enabled)) errs.push('Unknown rationale selected.');
  for (const v of agreementVariables(project)) {
    const val = input.values[v.id];
    const blank = val === null || val === undefined || val === '';
    if (blank && !choice.allowsBlank && status.disputed.includes(v.id) && v.required) errs.push(`Give a final value for "${v.label}".`);
  }
  return errs;
}

export function approvalsNeeded(project: Project, status: ItemStatus, proposal: Resolution): number {
  const cfg = project.config.resolution;
  const others = status.assigned.filter((u) => u !== proposal.proposedBy).length;
  if (cfg.mechanism === 'lead' || cfg.mechanism === 'majority') return Infinity; // finalized by a lead or admin
  return cfg.approvalsRequired > 0 ? Math.min(cfg.approvalsRequired, others) : others;
}

export function canApprove(project: Project, status: ItemStatus, proposal: Resolution, userId: string): boolean {
  if (proposal.status !== 'proposed' || proposal.proposedBy === userId) return false;
  if (proposal.approvals.some((a) => a.userId === userId)) return false;
  return status.assigned.includes(userId);
}

/** Leads and administrators may finalize any disputed item, including escalated ones; adjudicators finalize only through approvals. */
export function canFinalize(_project: Project, _status: ItemStatus, role: Role | undefined): boolean {
  return role === 'admin' || role === 'lead';
}

/** Whether approvals alone make a proposal final (discussion and escalation mechanisms). */
export function approvalsFinalize(project: Project, status: ItemStatus, proposal: Resolution): boolean {
  if (status.escalated) return false;
  const need = approvalsNeeded(project, status, proposal);
  return Number.isFinite(need) && proposal.approvals.filter((a) => status.assigned.includes(a.userId)).length >= need;
}

export function roleOf(memberships: Membership[], projectId: string, userId: string): Role | undefined {
  return memberships.find((m) => m.projectId === projectId && m.userId === userId && m.active)?.role;
}

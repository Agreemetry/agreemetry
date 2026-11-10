/**
 * Agreemetry domain model.
 *
 * Every project-specific choice (variables, scales, assignment, agreement rule,
 * disclosure point, resolution and rationale options, blinding) lives in
 * ProjectConfig, so a new study is configured through the website, never in code.
 */

export type Role = 'admin' | 'lead' | 'adjudicator';

export type VariableType = 'binary' | 'nominal' | 'ordinal' | 'numeric' | 'multilabel' | 'text';

export interface Category {
  /** Stable code written to exports (for example "1", "include", "yes"). */
  value: string;
  label: string;
  description?: string;
}

export interface Variable {
  id: string;
  label: string;
  description?: string;
  type: VariableType;
  /** binary, nominal, ordinal and multilabel. For ordinal, the list order is the scale order. */
  categories?: Category[];
  /** numeric */
  min?: number;
  max?: number;
  step?: number;
  /** Interval or ratio level, used for Krippendorff's alpha on numeric variables. */
  numericLevel?: 'interval' | 'ratio';
  required: boolean;
  /** Free text never enters agreement; other types can be excluded explicitly. */
  includeInAgreement: boolean;
  /** Weights for weighted kappa on ordinal variables. */
  weights?: 'linear' | 'quadratic';
  /** Optional help shown next to the field. */
  help?: string;
}

export type AssignmentMode = 'all' | 'fixed_k';

export interface AssignmentConfig {
  mode: AssignmentMode;
  /** Adjudicators per item when mode is fixed_k. */
  k?: number;
  /** Seed for reproducible assignment and presentation order. */
  seed: string;
}

export type AgreementRule = 'unanimous' | 'majority' | 'threshold';

export interface AgreementConfig {
  rule: AgreementRule;
  /** For threshold: the modal value must hold at least this share of ratings (0.5 to 1). */
  threshold?: number;
  /** Numeric ratings within this absolute distance count as agreeing. */
  numericTolerance?: number;
  /** multilabel: compare whole label sets, or each label as its own yes or no. */
  multilabelMode: 'exact' | 'per_label';
}

export type DisclosurePoint = 'item_complete' | 'project_complete' | 'manual';

export type ResolutionMechanism = 'discussion' | 'majority' | 'lead' | 'escalation';

export type ResolutionKind =
  | 'retain_adjudicator'
  | 'majority'
  | 'new_classification'
  | 'modified'
  | 'insufficient_evidence'
  | 'ambiguous'
  | 'escalate'
  | 'custom';

export interface ResolutionOption {
  id: string;
  kind: ResolutionKind;
  label: string;
  description?: string;
  enabled: boolean;
}

export interface RationaleOption {
  id: string;
  label: string;
  description?: string;
  enabled: boolean;
}

export interface ResolutionConfig {
  mechanism: ResolutionMechanism;
  options: ResolutionOption[];
  rationales: RationaleOption[];
  allowMultipleRationales: boolean;
  requireRationale: boolean;
  requireFreeText: boolean;
  /** discussion: approvals needed from assigned adjudicators other than the proposer (0 = all of them). */
  approvalsRequired: number;
}

export interface DisplayConfig {
  /** Field shown as the item heading. */
  titleField?: string;
  /** Field holding the main text to be judged (markdown or plain text). */
  bodyField?: string;
  /** Item field whose value selects a shared context document (for example a case or source id). */
  contextKeyField?: string;
  /** Metadata fields shown to adjudicators. */
  visibleFields: string[];
  /** Fields never shown to adjudicators or leads before final resolution (blinding). Admins always see them. */
  blindedFields: string[];
}

/** A rating source that is not an adjudicator, such as an automated classifier or a gold standard. */
export interface ReferenceRater {
  id: string;
  label: string;
  description?: string;
  variableId: string;
  /** Item field holding this reference's value for the variable. */
  field: string;
}

export interface ProjectConfig {
  variables: Variable[];
  /** Independent assessments needed before an item is compared. */
  requiredAdjudicators: number;
  assignment: AssignmentConfig;
  order: 'import' | 'random_per_adjudicator';
  agreement: AgreementConfig;
  disclosure: DisclosurePoint;
  /** For manual disclosure: set by an administrator. */
  disclosed: boolean;
  /** Adjudicators may reopen their own submitted assessment before disclosure; every change is versioned. */
  allowAmendBeforeDisclosure: boolean;
  /** Adjudicators may view their own submitted assessments. */
  allowReviewSubmitted: boolean;
  resolution: ResolutionConfig;
  display: DisplayConfig;
  references: ReferenceRater[];
}

export interface ProjectDocument {
  id: string;
  title: string;
  /** Markdown. */
  body: string;
  /** Shown to adjudicators (instructions, coding manual) or only to administrators (analysis plan). */
  audience: 'all' | 'admin';
}

export type ProjectStatus = 'draft' | 'active' | 'archived';

export interface Project {
  id: string;
  name: string;
  shortName?: string;
  description: string;
  objectives: string;
  template: string;
  status: ProjectStatus;
  config: ProjectConfig;
  documents: ProjectDocument[];
  /** Notes about where the items came from, shown on the dashboard. */
  provenance?: string;
  /** The lab (group account) that owns the project, if any. Lab owners and administrators administer it. */
  labId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface User {
  id: string;
  displayName: string;
  /** Optional; Agreemetry does not need personal data beyond a sign-in address. */
  email?: string;
  active: boolean;
  createdAt: string;
  /** Researcher profile, all optional. */
  affiliation?: string;
  /** ORCID iD in the form 0000-0002-1825-0097. */
  orcid?: string;
  field?: string;
  /** When the person accepted the terms of use of this deployment (shared server). */
  termsAcceptedAt?: string;
}

export type LabRole = 'owner' | 'admin' | 'member';

/** A group account (lab, team, centre) that owns projects and shares administration of them. */
export interface Lab {
  id: string;
  name: string;
  /** Short unique handle: lowercase letters, digits and hyphens. */
  slug: string;
  description: string;
  website?: string;
  createdBy: string;
  createdAt: string;
}

export interface LabMember {
  labId: string;
  userId: string;
  role: LabRole;
  joinedAt: string;
}

export interface LabSummary {
  lab: Lab;
  role: LabRole;
  members: number;
  projects: number;
}

export interface LabDetail {
  lab: Lab;
  role: LabRole;
  members: { userId: string; displayName: string; email?: string; affiliation?: string; orcid?: string; role: LabRole; joinedAt: string }[];
  /** Pending email invitations (shared server; owners and administrators only). */
  invites: { email: string; role: LabRole; createdAt: string }[];
  projects: { id: string; name: string; status: ProjectStatus; myRole?: Role }[];
}

export type TokenScope = 'read' | 'write';

/** A personal API token. The secret is shown once, at creation; only a hash is stored. */
export interface ApiToken {
  id: string;
  name: string;
  /** First characters of the token, to recognise it. */
  prefix: string;
  scope: TokenScope;
  /** If set, the token works only on this project. */
  projectId?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface Webhook {
  id: string;
  projectId: string;
  url: string;
  events: string[];
  active: boolean;
  /** First characters of the signing secret. */
  secretPrefix: string;
  createdAt: string;
}

export interface WebhookDelivery {
  id: number;
  webhookId: string;
  event: string;
  createdAt: string;
  /** Set when the request was handed to the server's HTTP client (pg_net). */
  queuedAt?: string;
  /** Why the request could not be handed over, if it failed. */
  error?: string;
}

export interface Membership {
  projectId: string;
  userId: string;
  role: Role;
  /** Project-specific pseudonym written to exports (R1, R2, ...). */
  pseudonym: string;
  active: boolean;
  /** Leads and admins can also adjudicate; blinding is weaker for them and the dashboard says so. */
  adjudicates: boolean;
  /** Added automatically because the person administers the lab that owns the project. */
  viaLab?: boolean;
}

export type FieldValue = string | number | boolean | null | string[] | Record<string, unknown> | unknown[];

export interface Item {
  id: string;
  projectId: string;
  /** Identifier from the imported file. */
  externalId: string;
  batch: string;
  category: string;
  /** Original imported fields, kept unchanged. */
  fields: Record<string, FieldValue>;
  importedAt: string;
  /** Import order. */
  seq: number;
}

/** Explicit item assignment, used when not every adjudicator rates every item. */
export interface Assignment {
  projectId: string;
  itemId: string;
  userId: string;
  createdAt: string;
}

export interface ContextDocument {
  key: string;
  projectId: string;
  title: string;
  body: string;
}

export type RatingValue = string | number | string[] | null;

export type AssessmentStatus = 'draft' | 'submitted';

export interface AssessmentVersion {
  version: number;
  values: Record<string, RatingValue>;
  comment: string;
  evidence: string;
  status: AssessmentStatus;
  at: string;
  reason?: string;
}

export interface Assessment {
  id: string;
  projectId: string;
  itemId: string;
  userId: string;
  values: Record<string, RatingValue>;
  comment: string;
  evidence: string;
  status: AssessmentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  /** Every earlier state, oldest first. The first submitted version is the original independent judgment. */
  history: AssessmentVersion[];
}

export type ResolutionStatus = 'proposed' | 'final' | 'superseded';

export interface Resolution {
  id: string;
  projectId: string;
  itemId: string;
  status: ResolutionStatus;
  /** Final values for every agreement variable (disputed and agreed). */
  values: Record<string, RatingValue>;
  optionId: string;
  /** For retain_adjudicator: whose judgment was kept. */
  retainedUserId?: string;
  rationaleIds: string[];
  freeText: string;
  references: string;
  proposedBy: string;
  proposedAt: string;
  approvals: { userId: string; at: string }[];
  finalizedBy?: string;
  finalizedAt?: string;
  /** Set when an administrator reopens a final resolution. */
  reopenedBy?: string;
  reopenedAt?: string;
  reopenReason?: string;
  version: number;
}

export interface Discussion {
  id: string;
  projectId: string;
  itemId: string;
  userId: string;
  text: string;
  at: string;
}

export interface Escalation {
  id: string;
  projectId: string;
  itemId: string;
  userId: string;
  reason: string;
  at: string;
  open: boolean;
}

export interface AuditEvent {
  id: string;
  projectId: string;
  at: string;
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  detail?: Record<string, unknown>;
}

/** Everything a signed-in user may see for one project. */
export interface ProjectData {
  project: Project;
  memberships: Membership[];
  users: User[];
  items: Item[];
  assignments: Assignment[];
  contexts: ContextDocument[];
  assessments: Assessment[];
  resolutions: Resolution[];
  discussions: Discussion[];
  escalations: Escalation[];
  audit: AuditEvent[];
  /** Server-computed item status for users who cannot see all assessments. */
  serverStatus?: Record<string, ServerItemStatus>;
}

export interface ServerItemStatus {
  itemId: string;
  submitted: number;
  required: number;
  state: ItemState;
  disputedVariables: string[];
}

export type ItemState =
  | 'unassigned'
  | 'awaiting'
  | 'in_progress'
  | 'agreed'
  | 'disagreement'
  | 'proposed'
  | 'escalated'
  | 'resolved';

/** Portable, re-importable project archive. */
export interface ProjectArchive {
  format: 'agreemetry-project';
  formatVersion: 1;
  exportedAt: string;
  project: Project;
  users: User[];
  memberships: Membership[];
  items: Item[];
  assignments: Assignment[];
  contexts: ContextDocument[];
  assessments: Assessment[];
  resolutions: Resolution[];
  discussions: Discussion[];
  escalations: Escalation[];
  audit: AuditEvent[];
}

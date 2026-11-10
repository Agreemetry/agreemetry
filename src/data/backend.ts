/**
 * The contract every storage backend implements. The UI talks only to this interface.
 *  - LocalBackend: browser storage (IndexedDB), for a single machine, demonstrations, and offline work
 *    with adjudicator packages. Rules run in the browser, so it is not a security boundary.
 *  - SupabaseBackend: Postgres with row-level security and server-side functions; the deployment for
 *    multiuser projects, where the server enforces blinding and permissions.
 */
import type {
  ApiToken, Assessment, ContextDocument, Item, Lab, LabDetail, LabRole, LabSummary, Membership, Project, ProjectArchive, ProjectData, ProjectStatus,
  RatingValue, Resolution, Role, TokenScope, User, Webhook, WebhookDelivery,
} from '../core/types';

export interface ProjectSummary {
  project: Project;
  role: Role;
  items: number;
}

export interface NewProjectInput {
  name: string;
  description: string;
  objectives: string;
  templateId: string;
  /** Create the project inside this lab (the creator must belong to it). */
  labId?: string;
}

export interface LabInput {
  name: string;
  slug?: string;
  description?: string;
  website?: string;
}

export interface LabInvitation {
  lab: Lab;
  role: LabRole;
  createdAt: string;
  invitedBy?: string;
}

export interface NewToken {
  name: string;
  scope: TokenScope;
  projectId?: string;
  days: number;
}

export interface WebhookInput {
  id?: string;
  url: string;
  events: string[];
  active: boolean;
  rotateSecret?: boolean;
}

export interface ResultSnapshot {
  id: number;
  publishedAt: string;
  note?: string;
  by?: string;
  tables: string[];
}

export interface AssessmentInput {
  itemId: string;
  values: Record<string, RatingValue>;
  comment: string;
  evidence: string;
  submit: boolean;
  /** Optimistic concurrency: the version the client last saw (0 for a new assessment). */
  expectedVersion: number;
}

export interface ProposalPayload {
  itemId: string;
  optionId: string;
  retainedUserId?: string;
  values: Record<string, RatingValue>;
  rationaleIds: string[];
  freeText: string;
  references: string;
}

/** An adjudicator's submitted work, carried between machines when no shared server is used. */
export interface AssessmentPackage {
  format: 'agreemetry-assessments';
  formatVersion: 1;
  projectId: string;
  userId: string;
  pseudonym: string;
  exportedAt: string;
  assessments: Assessment[];
}

export interface Backend {
  readonly mode: 'local' | 'supabase';
  readonly label: string;
  init(): Promise<void>;
  currentUser(): User | null;
  /** Local mode: choose a workspace identity. */
  signInAs?(userId: string): Promise<void>;
  /** Supabase mode: email link sign-in, which also registers a new researcher. */
  signInWithEmail?(email: string): Promise<void>;
  /** Supabase mode: sign in with an identity provider configured on the server (for example github or google). */
  signInWithProvider?(provider: string): Promise<void>;
  signOut(): Promise<void>;
  listUsers(): Promise<User[]>;
  createUser(displayName: string, email?: string): Promise<User>;
  /** Shared server: add someone by email; they join at first sign-in if they have no account yet. */
  inviteMember?(projectId: string, email: string, role: Role, displayName: string): Promise<void>;
  updateUser(user: User): Promise<void>;

  listProjects(): Promise<ProjectSummary[]>;
  getProjectData(projectId: string): Promise<ProjectData>;
  createProject(input: NewProjectInput): Promise<Project>;
  updateProject(project: Project): Promise<Project>;
  duplicateProject(projectId: string, withItems: boolean): Promise<Project>;
  setProjectStatus(projectId: string, status: ProjectStatus): Promise<void>;
  deleteProject(projectId: string): Promise<void>;

  upsertMembership(m: Membership): Promise<void>;
  importItems(projectId: string, items: Item[], contexts?: ContextDocument[]): Promise<void>;
  deleteItems(projectId: string, itemIds: string[]): Promise<void>;
  generateAssignments(projectId: string): Promise<number>;

  saveAssessment(projectId: string, input: AssessmentInput): Promise<Assessment>;
  reopenAssessment(projectId: string, assessmentId: string, reason: string): Promise<Assessment>;

  proposeResolution(projectId: string, p: ProposalPayload): Promise<Resolution>;
  approveResolution(projectId: string, resolutionId: string): Promise<Resolution>;
  finalizeResolution(projectId: string, resolutionId: string): Promise<Resolution>;
  reopenResolution(projectId: string, resolutionId: string, reason: string): Promise<void>;
  escalate(projectId: string, itemId: string, reason: string): Promise<void>;
  addDiscussion(projectId: string, itemId: string, text: string): Promise<void>;
  openDisclosure(projectId: string): Promise<void>;

  importArchive(archive: ProjectArchive, opts: { newIds: boolean }): Promise<Project>;
  exportAdjudicatorPackage?(projectId: string, userId: string): Promise<ProjectArchive>;
  importAssessmentPackage?(projectId: string, pkg: AssessmentPackage): Promise<{ added: number; skipped: number }>;

  // Labs (group accounts). On the shared server people join by invitation and accept it themselves;
  // in the local workspace, accounts in this browser are added directly.
  listLabs(): Promise<LabSummary[]>;
  getLab(labId: string): Promise<LabDetail>;
  createLab(input: LabInput): Promise<Lab>;
  updateLab(lab: Lab): Promise<Lab>;
  addLabMember?(labId: string, userId: string, role: LabRole): Promise<void>;
  inviteLabMember?(labId: string, email: string, role: LabRole): Promise<void>;
  cancelLabInvite?(labId: string, email: string): Promise<void>;
  listMyLabInvites?(): Promise<LabInvitation[]>;
  respondLabInvite?(labId: string, accept: boolean): Promise<void>;
  setLabMemberRole(labId: string, userId: string, role: LabRole): Promise<void>;
  removeLabMember(labId: string, userId: string): Promise<void>;
  deleteLab(labId: string): Promise<void>;
  moveProjectToLab(projectId: string, labId: string | null): Promise<void>;

  // Integration (shared server only).
  listApiTokens?(): Promise<ApiToken[]>;
  createApiToken?(t: NewToken): Promise<{ token: string; record: ApiToken }>;
  revokeApiToken?(id: string): Promise<void>;
  listWebhooks?(projectId: string): Promise<Webhook[]>;
  saveWebhook?(projectId: string, w: WebhookInput): Promise<{ webhook: Webhook; secret?: string }>;
  deleteWebhook?(projectId: string, id: string): Promise<void>;
  listWebhookDeliveries?(projectId: string): Promise<WebhookDelivery[]>;
  publishResults?(projectId: string, tables: Record<string, unknown[]>, note: string): Promise<{ id: number; createdAt: string }>;
  listResultSnapshots?(projectId: string): Promise<ResultSnapshot[]>;
  /** Base address of the REST API, for the integration page. */
  apiBaseUrl?(): string;

  /** Called whenever data may have changed (other tab, other user, realtime). */
  subscribe(cb: () => void): () => void;
}

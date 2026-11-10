/**
 * Shared-server backend on Supabase. Every call goes to a SECURITY DEFINER function in
 * supabase/migrations, which checks the caller's role and applies blinding on the server; the browser
 * holds only the publishable (anon) key and the user's session.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  ApiToken, ContextDocument, Item, Lab, LabDetail, LabRole, LabSummary, Membership, Project, ProjectArchive, ProjectData, ProjectStatus, Role, User,
  Webhook, WebhookDelivery,
} from '../core/types';
import type {
  AssessmentInput, Backend, LabInput, LabInvitation, NewProjectInput, NewToken, ProjectSummary, ProposalPayload, ResultSnapshot, WebhookInput,
} from './backend';
import { TEMPLATES } from '../core/templates';
import { generateAssignments } from '../core/workflow';

const CHUNK = 300;

export class SupabaseBackend implements Backend {
  readonly mode = 'supabase' as const;
  readonly label = 'Shared server (Supabase)';
  private sb: SupabaseClient;
  private me: User | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string, anonKey: string) {
    this.sb = createClient(url, anonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } });
  }

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.sb.rpc(fn, args);
    if (error) {
      const e = new Error(error.message.replace(/^The configuration cannot be saved: /, 'The configuration cannot be saved. ')) as Error & { details?: string[] };
      if (error.message.includes(': ')) e.details = error.message.split(': ').slice(1).join(': ').split(/(?<=\.)\s+/).filter(Boolean);
      throw e;
    }
    return data as T;
  }

  private emit() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.listeners.forEach((l) => l()), 150);
  }

  async init() {
    this.sb.auth.onAuthStateChange(() => {
      void this.loadMe().then(() => this.emit());
    });
    await this.loadMe();
    this.sb
      .channel('agreemetry-events')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'project_events' }, () => this.emit())
      .subscribe();
  }

  private async loadMe() {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) {
      this.me = null;
      return;
    }
    await this.call<number>('accept_invites', {});
    this.me = (await this.call<User | null>('get_my_profile', {})) ?? null;
  }

  currentUser() {
    return this.me;
  }

  async signInWithEmail(email: string) {
    const { error } = await this.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href.split('#')[0] } });
    if (error) throw new Error(error.message);
  }

  async signInWithProvider(provider: string) {
    const { error } = await this.sb.auth.signInWithOAuth({ provider: provider as 'github', options: { redirectTo: window.location.href.split('#')[0] } });
    if (error) throw new Error(error.message);
  }

  async signOut() {
    await this.sb.auth.signOut();
    this.me = null;
    this.emit();
  }

  async listUsers() {
    return this.call<User[]>('list_colleagues', {});
  }

  async createUser(): Promise<User> {
    throw new Error('On the shared server, people join by email invitation: add them on the Team page with their email address.');
  }

  async inviteMember(projectId: string, email: string, role: Role, displayName: string) {
    await this.call('invite_member', { p: projectId, mail: email, r: role, name: displayName });
  }

  /** Your own researcher profile. acceptTerms records acceptance of this deployment's terms of use. */
  async updateUser(u: User & { acceptTerms?: boolean }) {
    await this.call('update_my_profile', { p_doc: { displayName: u.displayName, affiliation: u.affiliation ?? '', orcid: u.orcid ?? '', field: u.field ?? '', acceptTerms: !!u.acceptTerms } });
    await this.loadMe();
    this.emit();
  }

  listProjects() {
    return this.call<ProjectSummary[]>('list_my_projects', {});
  }

  getProjectData(projectId: string) {
    return this.call<ProjectData>('get_project_view', { p: projectId });
  }

  async createProject(input: NewProjectInput) {
    const t = TEMPLATES.find((x) => x.id === input.templateId) ?? TEMPLATES[TEMPLATES.length - 1];
    const p = await this.call<Project>('create_project', { p_doc: { name: input.name, description: input.description, objectives: input.objectives, template: t.id, status: 'draft', config: t.config(), documents: t.documents() } });
    if (input.labId) {
      await this.call('move_project_to_lab', { p: p.id, l: input.labId });
      return { ...p, labId: input.labId };
    }
    return p;
  }

  updateProject(p: Project) {
    return this.call<Project>('update_project', { p_doc: p });
  }

  duplicateProject(projectId: string, withItems: boolean) {
    return this.call<Project>('duplicate_project', { p: projectId, with_items: withItems });
  }

  async setProjectStatus(projectId: string, status: ProjectStatus) {
    await this.call('set_project_status', { p: projectId, s: status });
  }

  async deleteProject(projectId: string) {
    await this.call('delete_project', { p: projectId });
  }

  async upsertMembership(m: Membership) {
    await this.call('upsert_membership', { p: m.projectId, u: m.userId, r: m.role, pseudo: m.pseudonym, act: m.active, adj: m.adjudicates });
  }

  async importItems(projectId: string, items: Item[], contexts: ContextDocument[] = []) {
    for (let i = 0; i < Math.max(items.length, 1); i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK).map(({ id: _id, ...rest }) => rest);
      await this.call('import_items', { p: projectId, p_items: chunk, p_contexts: i === 0 ? contexts : [] });
    }
  }

  async deleteItems(projectId: string, ids: string[]) {
    await this.call('delete_items', { p: projectId, ids });
  }

  async generateAssignments(projectId: string) {
    const d = await this.getProjectData(projectId);
    const rows = generateAssignments(d.project, d.items, d.memberships, d.assignments).map((a) => ({ itemId: a.itemId, userId: a.userId }));
    let n = 0;
    for (let i = 0; i < rows.length; i += 2000) n += await this.call<number>('add_assignments', { p: projectId, p_rows: rows.slice(i, i + 2000) });
    return n;
  }

  saveAssessment(projectId: string, x: AssessmentInput) {
    return this.call<import('../core/types').Assessment>('save_assessment', { p: projectId, item: x.itemId, vals: x.values, p_comment: x.comment, p_evidence: x.evidence, submit: x.submit, expected: x.expectedVersion });
  }

  reopenAssessment(projectId: string, assessmentId: string, reason: string) {
    return this.call<import('../core/types').Assessment>('reopen_assessment', { p: projectId, aid: assessmentId, reason });
  }

  proposeResolution(projectId: string, payload: ProposalPayload) {
    return this.call<import('../core/types').Resolution>('propose_resolution', { p: projectId, payload });
  }

  approveResolution(projectId: string, id: string) {
    return this.call<import('../core/types').Resolution>('approve_resolution', { p: projectId, rid: id });
  }

  finalizeResolution(projectId: string, id: string) {
    return this.call<import('../core/types').Resolution>('finalize_resolution', { p: projectId, rid: id });
  }

  async reopenResolution(projectId: string, id: string, reason: string) {
    await this.call('reopen_resolution', { p: projectId, rid: id, reason });
  }

  async escalate(projectId: string, itemId: string, reason: string) {
    await this.call('escalate_item', { p: projectId, item: itemId, reason });
  }

  async addDiscussion(projectId: string, itemId: string, text: string) {
    await this.call('add_discussion', { p: projectId, item: itemId, p_body: text });
  }

  async openDisclosure(projectId: string) {
    await this.call('open_disclosure', { p: projectId });
  }

  /** Configuration, documents, items and context documents; judgments in an archive stay in the archive. */
  async importArchive(a: ProjectArchive): Promise<Project> {
    if (a.format !== 'agreemetry-project') throw new Error('Not an Agreemetry project archive.');
    const { id: _id, version: _v, createdAt: _c, updatedAt: _u, ...doc } = a.project;
    const p = await this.call<Project>('create_project', { p_doc: { ...doc, status: 'draft' } });
    await this.importItems(p.id, a.items, a.contexts);
    if (a.assessments.length) console.info(`${a.assessments.length} judgments in the archive were not imported; the shared server records judgments only from signed-in adjudicators.`);
    return p;
  }

  // Labs ------------------------------------------------------------------------------------------

  listLabs() {
    return this.call<LabSummary[]>('list_my_labs', {});
  }
  getLab(labId: string) {
    return this.call<LabDetail>('get_lab', { l: labId });
  }
  async createLab(input: LabInput) {
    const lab = await this.call<Lab>('create_lab', { p_doc: input });
    this.emit();
    return lab;
  }
  async updateLab(lab: Lab) {
    const saved = await this.call<Lab>('update_lab', { p_doc: lab });
    this.emit();
    return saved;
  }
  async inviteLabMember(labId: string, email: string, role: LabRole) {
    await this.call('invite_lab_member', { l: labId, mail: email, r: role });
    this.emit();
  }
  async cancelLabInvite(labId: string, email: string) {
    await this.call('cancel_lab_invite', { l: labId, mail: email });
    this.emit();
  }
  listMyLabInvites() {
    return this.call<LabInvitation[]>('list_my_lab_invites', {});
  }
  async respondLabInvite(labId: string, accept: boolean) {
    await this.call('respond_lab_invite', { l: labId, accept });
    this.emit();
  }
  async setLabMemberRole(labId: string, userId: string, role: LabRole) {
    await this.call('set_lab_member', { l: labId, u: userId, r: role });
    this.emit();
  }
  async removeLabMember(labId: string, userId: string) {
    await this.call('remove_lab_member', { l: labId, u: userId });
    this.emit();
  }
  async deleteLab(labId: string) {
    await this.call('delete_lab', { l: labId });
    this.emit();
  }
  async moveProjectToLab(projectId: string, labId: string | null) {
    await this.call('move_project_to_lab', { p: projectId, l: labId });
    this.emit();
  }

  // Integration --------------------------------------------------------------------------------------

  listApiTokens() {
    return this.call<ApiToken[]>('list_api_tokens', {});
  }
  createApiToken(t: NewToken) {
    return this.call<{ token: string; record: ApiToken }>('create_api_token', { p_name: t.name, p_scope: t.scope, p_project: t.projectId ?? null, p_days: t.days });
  }
  async revokeApiToken(id: string) {
    await this.call('revoke_api_token', { t_id: id });
  }
  listWebhooks(projectId: string) {
    return this.call<Webhook[]>('list_webhooks', { p: projectId });
  }
  saveWebhook(projectId: string, w: WebhookInput) {
    return this.call<{ webhook: Webhook; secret?: string }>('save_webhook', { p: projectId, p_doc: w });
  }
  async deleteWebhook(projectId: string, id: string) {
    await this.call('delete_webhook', { p: projectId, wid: id });
  }
  listWebhookDeliveries(projectId: string) {
    return this.call<WebhookDelivery[]>('list_webhook_deliveries', { p: projectId, max_rows: 50 });
  }
  publishResults(projectId: string, tables: Record<string, unknown[]>, note: string) {
    return this.call<{ id: number; createdAt: string }>('publish_results', { p: projectId, p_tables: tables, p_note: note });
  }
  listResultSnapshots(projectId: string) {
    return this.call<ResultSnapshot[]>('list_result_snapshots', { p: projectId });
  }
  apiBaseUrl() {
    return `${this.url.replace(/\/+$/, '')}/rest/v1`;
  }

  subscribe(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

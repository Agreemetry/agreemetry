/**
 * Browser backend: an in-memory database persisted to IndexedDB, synchronised across tabs with a
 * BroadcastChannel. Suitable for one machine, demonstrations and offline adjudication with packages.
 * The access rules run in the browser here, so this mode is not a security boundary; use the
 * Supabase deployment when adjudicators must be kept apart by the server.
 */
import type { ContextDocument, Item, Lab, LabRole, Membership, Project, ProjectArchive, ProjectData, ProjectStatus, User } from '../core/types';
import type { AssessmentInput, AssessmentPackage, Backend, LabInput, NewProjectInput, ProjectSummary, ProposalPayload } from './backend';
import { MemDb, STORES, Service, keyOf, type StoreName } from './service';
import { nowIso } from '../core/util';

const DB_NAME = 'agreemetry';
// Version 2 added the labs and labMembers stores.
const DB_VERSION = 2;
const SESSION_KEY = 'agreemetry.session.user';

type Rec = Record<string, unknown>;

export interface Persistence {
  load(): Promise<Record<StoreName, Rec[]>>;
  write(changes: Map<StoreName, Map<string, Rec | null>>): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryPersistence implements Persistence {
  data = Object.fromEntries(STORES.map((s) => [s, new Map<string, Rec>()])) as Record<StoreName, Map<string, Rec>>;
  async load() {
    return Object.fromEntries(STORES.map((s) => [s, [...this.data[s].values()]])) as Record<StoreName, Rec[]>;
  }
  async write(changes: Map<StoreName, Map<string, Rec | null>>) {
    for (const [s, m] of changes) for (const [k, v] of m) v ? this.data[s].set(k, v) : this.data[s].delete(k);
  }
  async clear() {
    for (const s of STORES) this.data[s].clear();
  }
}

export class IdbPersistence implements Persistence {
  private dbp: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbp;
  }

  async load() {
    const db = await this.open();
    const out = {} as Record<StoreName, Rec[]>;
    await Promise.all(
      STORES.map(
        (s) =>
          new Promise<void>((resolve, reject) => {
            const req = db.transaction(s, 'readonly').objectStore(s).getAll();
            req.onsuccess = () => {
              out[s] = req.result as Rec[];
              resolve();
            };
            req.onerror = () => reject(req.error);
          }),
      ),
    );
    return out;
  }

  async write(changes: Map<StoreName, Map<string, Rec | null>>) {
    if (changes.size === 0) return;
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([...changes.keys()], 'readwrite');
      for (const [s, m] of changes) {
        const os = tx.objectStore(s);
        for (const [k, v] of m) v ? os.put(v, k) : os.delete(k);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted (storage may be full).'));
    });
  }

  async clear() {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([...STORES], 'readwrite');
      for (const s of STORES) tx.objectStore(s).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export class LocalBackend implements Backend {
  readonly mode = 'local' as const;
  readonly label = 'This browser (local workspace)';
  db = new MemDb();
  private userId: string | null = null;
  private listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private persistence: Persistence = new IdbPersistence(), private seed?: (b: LocalBackend) => Promise<void>) {}

  async init() {
    await this.reload();
    if (this.db.stores.users.size === 0 && this.seed) {
      await this.seed(this);
      await this.flush();
    }
    try {
      this.userId = localStorage.getItem(SESSION_KEY);
    } catch {
      this.userId = null;
    }
    if (this.userId && !this.db.get('users', this.userId)) this.userId = null;
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('agreemetry-local');
      this.channel.onmessage = async () => {
        await this.reload();
        this.emit();
      };
    }
  }

  private async reload() {
    const all = await this.persistence.load();
    const db = new MemDb();
    for (const s of STORES) for (const r of all[s] ?? []) db.stores[s].set(keyOf(s, r), r);
    this.db = db;
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Persist pending changes in order, then tell other tabs. */
  private flush(): Promise<void> {
    const changes = this.db.takeDirty();
    this.queue = this.queue.then(() => this.persistence.write(changes)).then(() => {
      this.channel?.postMessage({ at: nowIso() });
    });
    return this.queue;
  }

  private async run<T>(fn: (s: Service) => T): Promise<T> {
    if (!this.userId) throw new Error('Sign in first.');
    const s = new Service(this.db, this.userId);
    try {
      const out = fn(s);
      // Only writes notify subscribers; a read that notified would make every view reload itself forever.
      if (this.db.dirty.size > 0) {
        await this.flush();
        this.emit();
      }
      return out;
    } catch (e) {
      // Drop partial changes from a failed operation: wait for earlier writes, then reload from storage.
      this.db.takeDirty();
      await this.queue;
      await this.reload();
      throw e;
    }
  }

  /** Run as a given user without a session (seeding, package import). */
  async runAs<T>(userId: string, fn: (s: Service) => T): Promise<T> {
    const s = new Service(this.db, userId);
    const out = fn(s);
    await this.flush();
    return out;
  }

  currentUser(): User | null {
    return this.userId ? this.db.get<User>('users', this.userId) ?? null : null;
  }

  async signInAs(userId: string) {
    const u = this.db.get<User>('users', userId);
    if (!u || !u.active) throw new Error('That account is not active.');
    this.userId = userId;
    try {
      localStorage.setItem(SESSION_KEY, userId);
    } catch {
      /* private mode: session lasts for this tab */
    }
    this.emit();
  }

  async signOut() {
    this.userId = null;
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    this.emit();
  }

  async listUsers() {
    return this.db.all<User>('users').sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async createUser(displayName: string, email?: string) {
    const s = new Service(this.db, this.userId ?? '');
    const u = s.createUser(displayName, email);
    await this.flush();
    this.emit();
    return u;
  }

  updateUser(u: User) {
    return this.run((s) => s.updateUser(u));
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.run((s) => s.listProjects());
  }
  listLabs() {
    return this.run((s) => s.listLabs());
  }
  getLab(labId: string) {
    return this.run((s) => s.getLab(labId));
  }
  createLab(input: LabInput) {
    return this.run((s) => s.createLab(input));
  }
  updateLab(lab: Lab) {
    return this.run((s) => s.updateLab(lab));
  }
  addLabMember(labId: string, userId: string, role: LabRole) {
    return this.run((s) => s.addLabMember(labId, userId, role));
  }
  setLabMemberRole(labId: string, userId: string, role: LabRole) {
    return this.run((s) => s.setLabMemberRole(labId, userId, role));
  }
  removeLabMember(labId: string, userId: string) {
    return this.run((s) => s.removeLabMember(labId, userId));
  }
  deleteLab(labId: string) {
    return this.run((s) => s.deleteLab(labId));
  }
  moveProjectToLab(projectId: string, labId: string | null) {
    return this.run((s) => s.moveProjectToLab(projectId, labId));
  }
  getProjectData(projectId: string): Promise<ProjectData> {
    return this.run((s) => s.getProjectData(projectId));
  }
  createProject(input: NewProjectInput): Promise<Project> {
    return this.run((s) => s.createProject(input));
  }
  updateProject(p: Project): Promise<Project> {
    return this.run((s) => s.updateProject(p));
  }
  duplicateProject(id: string, withItems: boolean) {
    return this.run((s) => s.duplicateProject(id, withItems));
  }
  setProjectStatus(id: string, status: ProjectStatus) {
    return this.run((s) => s.setProjectStatus(id, status));
  }
  deleteProject(id: string) {
    return this.run((s) => s.deleteProject(id));
  }
  upsertMembership(m: Membership) {
    return this.run((s) => s.upsertMembership(m));
  }
  importItems(projectId: string, items: Item[], contexts?: ContextDocument[]) {
    return this.run((s) => s.importItems(projectId, items, contexts));
  }
  deleteItems(projectId: string, ids: string[]) {
    return this.run((s) => s.deleteItems(projectId, ids));
  }
  generateAssignments(projectId: string) {
    return this.run((s) => s.generateAssignments(projectId));
  }
  saveAssessment(projectId: string, input: AssessmentInput) {
    return this.run((s) => s.saveAssessment(projectId, input));
  }
  reopenAssessment(projectId: string, id: string, reason: string) {
    return this.run((s) => s.reopenAssessment(projectId, id, reason));
  }
  proposeResolution(projectId: string, p: ProposalPayload) {
    return this.run((s) => s.proposeResolution(projectId, p));
  }
  approveResolution(projectId: string, id: string) {
    return this.run((s) => s.approveResolution(projectId, id));
  }
  finalizeResolution(projectId: string, id: string) {
    return this.run((s) => s.finalizeResolution(projectId, id));
  }
  reopenResolution(projectId: string, id: string, reason: string) {
    return this.run((s) => s.reopenResolution(projectId, id, reason));
  }
  escalate(projectId: string, itemId: string, reason: string) {
    return this.run((s) => s.escalate(projectId, itemId, reason));
  }
  addDiscussion(projectId: string, itemId: string, text: string) {
    return this.run((s) => s.addDiscussion(projectId, itemId, text));
  }
  openDisclosure(projectId: string) {
    return this.run((s) => s.openDisclosure(projectId));
  }
  importArchive(a: ProjectArchive, opts: { newIds: boolean }) {
    return this.run((s) => s.importArchive(a, opts));
  }
  exportAdjudicatorPackage(projectId: string, userId: string) {
    return this.run((s) => s.exportAdjudicatorPackage(projectId, userId));
  }
  importAssessmentPackage(projectId: string, pkg: AssessmentPackage) {
    return this.run((s) => s.importAssessmentPackage(projectId, pkg));
  }

  /** Open a package prepared by an administrator: creates the adjudicator's account here and signs in. */
  async openAdjudicatorPackage(a: ProjectArchive): Promise<Project> {
    const user = a.users[0];
    if (!user || a.memberships.find((m) => m.userId === user.id)?.role !== 'adjudicator') throw new Error('This file is not an adjudicator package.');
    if (this.db.get('projects', a.project.id)) throw new Error('This project is already open in this browser.');
    if (!this.db.get('users', user.id)) this.db.put('users', user);
    const p = await this.runAs(user.id, (s) => s.importArchive(a, { newIds: false }));
    await this.signInAs(user.id);
    return p;
  }

  /** The signed-in adjudicator's submitted judgments, for return to the administrator. */
  async myAssessmentPackage(projectId: string): Promise<AssessmentPackage> {
    const d = await this.getProjectData(projectId);
    const me = this.userId!;
    const m = d.memberships.find((x) => x.userId === me);
    return { format: 'agreemetry-assessments', formatVersion: 1, projectId, userId: me, pseudonym: m?.pseudonym ?? '', exportedAt: nowIso(), assessments: d.assessments.filter((a) => a.userId === me && a.status === 'submitted') };
  }

  async resetWorkspace() {
    await this.persistence.clear();
    this.db = new MemDb();
    await this.signOut();
    if (this.seed) {
      await this.seed(this);
      await this.flush();
    }
    this.channel?.postMessage({ reset: true });
    this.emit();
  }

  subscribe(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

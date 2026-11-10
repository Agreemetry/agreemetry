import { useEffect, useState } from 'react';
import { useApp, go } from '../app';
import { Field, Icon, Logo, Modal, Notice } from '../components';
import type { ProjectSummary } from '../../data/backend';
import type { ApiToken, LabSummary, ProjectArchive, TokenScope, User } from '../../core/types';
import { TEMPLATES } from '../../core/templates';
import { LocalBackend } from '../../data/localBackend';
import { parseArchiveBytes } from '../../data/seed';
import { normalizeOrcid } from '../../core/util';
import { config, providerLabel } from '../../config';

const FEATURES = [
  ['Independent by design', 'Judgments stay concealed until the disclosure point you choose; blinded fields never reach adjudicators.'],
  ['Disagreements found for you', 'Every completed item is compared under your agreement rule; disputes go to a live queue.'],
  ['Resolution on the record', 'Standard options and rationales, free text, discussion, approvals and escalation, all versioned.'],
  ['Reliability done right', 'Kappa, weighted kappa, Fleiss, Krippendorff, AC1 and ICC from the original judgments, with intervals and warnings.'],
  ['Analysis-ready exports', 'Tidy CSV, Excel and JSON with a data dictionary, codebook and loaders for R, Python and Stata.'],
  ['Any design', 'Screening, coding, verification, rubrics or expert panels, with any number of adjudicators.'],
];

export function SignIn() {
  const { backend, toast, fail } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (backend.mode === 'local') void backend.listUsers().then(setUsers);
  }, [backend]);

  async function openPackage(f: File) {
    try {
      const a = JSON.parse(await f.text()) as ProjectArchive;
      const p = await (backend as LocalBackend).openAdjudicatorPackage(a);
      toast(`Opened ${p.name}. You are signed in as ${a.users[0].displayName}.`);
      go(`/p/${p.id}/assess`);
    } catch (e) {
      fail(e);
    }
  }

  return (
    <div className="center-narrow">
      <section className="hero">
        <div>
          <div className="row" style={{ marginBottom: 12 }}>
            <Logo size={40} />
            <h1 style={{ margin: 0 }}>Agreemetry</h1>
          </div>
          <p className="lead">
            Independent judgments. Transparent consensus. Reproducible reliability. A workspace for research teams that classify, code, screen or rate material with two or more adjudicators.
          </p>
        </div>
        <div className="card">
          {backend.mode === 'supabase' ? (
            <div className="stack">
              <h2>Sign in or register</h2>
              <p className="ink2">Enter your email address and we send you a one-time sign-in link. If you are new, the link creates your researcher account; you then complete a short profile.</p>
              <Field label="Email address">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
              </Field>
              <button className="btn primary" disabled={!email.includes('@')} onClick={() => backend.signInWithEmail!(email).then(() => setSent(true), fail)}>
                Email me a sign-in link
              </button>
              {sent && <Notice tone="good">Check your inbox for the link.</Notice>}
              {config.authProviders.length > 0 && backend.signInWithProvider && (
                <div className="stack" style={{ gap: 6 }}>
                  <span className="small muted">Or continue with</span>
                  <div className="row">
                    {config.authProviders.map((p) => (
                      <button key={p} className="btn" onClick={() => backend.signInWithProvider!(p).catch(fail)}>{providerLabel(p)}</button>
                    ))}
                  </div>
                </div>
              )}
              <p className="small muted" style={{ margin: 0 }}>
                {config.operator ? `This deployment is run by ${config.operator}. ` : ''}
                Agreemetry keeps your email address, the name you choose, and optionally your affiliation and ORCID iD.
                {config.termsUrl && <> <a href={config.termsUrl} target="_blank" rel="noopener noreferrer">Terms of use</a>.</>}
                {config.privacyUrl && <> <a href={config.privacyUrl} target="_blank" rel="noopener noreferrer">Privacy notice</a>.</>}
              </p>
            </div>
          ) : (
            <div className="stack">
              <h2>Choose your workspace identity</h2>
              <Notice tone="info">
                Local workspace: everything stays in this browser. Choosing a name is a convenience, not a password. For adjudicators on different machines, use adjudicator packages or the shared server deployment.
              </Notice>
              <div className="stack" style={{ gap: 6, maxHeight: 280, overflow: 'auto' }}>
                {users.filter((u) => u.active).map((u) => (
                  <button key={u.id} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => backend.signInAs!(u.id).then(() => go('/'), fail)}>
                    <Icon name="team" />
                    {u.displayName}
                  </button>
                ))}
              </div>
              <div className="row">
                <input type="text" placeholder="New name" value={name} onChange={(e) => setName(e.target.value)} aria-label="New identity name" style={{ flex: 1 }} />
                <button className="btn" disabled={!name.trim()} onClick={async () => {
                  try {
                    const u = await backend.createUser(name);
                    await backend.signInAs!(u.id);
                    go('/');
                  } catch (e) {
                    fail(e);
                  }
                }}>
                  Create
                </button>
              </div>
              <label className="btn" style={{ cursor: 'pointer' }}>
                <Icon name="upload" />
                Open an adjudicator package
                <input type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void openPackage(e.target.files[0])} />
              </label>
            </div>
          )}
        </div>
      </section>
      <div className="features">
        {FEATURES.map(([t, d]) => (
          <div className="feature" key={t}>
            <strong>{t}</strong>
            <span>{d}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Projects() {
  const { backend, user, toast, fail } = useApp();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [labs, setLabs] = useState<LabSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [archived, setArchived] = useState(false);
  const load = () => {
    void backend.listLabs().then(setLabs, () => setLabs([]));
    return backend.listProjects().then(setList, fail);
  };
  const labName = (id?: string) => (id ? labs.find((l) => l.lab.id === id)?.lab.name ?? 'Lab project' : '');
  useEffect(() => {
    void load();
    return backend.subscribe(() => void load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, user?.id]);

  async function importArchive(f: File) {
    try {
      const a = await parseArchiveBytes(new Uint8Array(await f.arrayBuffer()));
      const p = await backend.importArchive(a, { newIds: true });
      toast(`Imported ${p.name}.`);
      go(`/p/${p.id}/dashboard`);
    } catch (e) {
      fail(e);
    }
  }

  const shown = (list ?? []).filter((x) => archived || x.project.status !== 'archived');
  return (
    <div className="center-narrow">
      <div className="page-head">
        <div className="grow">
          <h1>Projects</h1>
          <p>Each project has its own items, adjudicators, coding form, rules and records. Open one to work, or start a new project from a template.</p>
        </div>
        <label className="check small" style={{ alignSelf: 'center' }}>
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived
        </label>
        <label className="btn" style={{ cursor: 'pointer' }}>
          <Icon name="upload" />
          Import archive
          <input type="file" accept=".json,.gz,application/json,application/gzip" hidden onChange={(e) => e.target.files?.[0] && void importArchive(e.target.files[0])} />
        </label>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          New project
        </button>
      </div>
      {list === null ? (
        <p className="muted">Loading</p>
      ) : shown.length === 0 ? (
        <div className="card">
          <h3>No projects yet</h3>
          <p className="ink2">Create a project, or ask an administrator to add you to one.</p>
        </div>
      ) : (
        <div className="grid cols-2">
          {shown.map(({ project: p, role, items }) => (
            <div key={p.id} className="card projcard" role="link" tabIndex={0} onClick={() => go(`/p/${p.id}/${role === 'adjudicator' ? 'assess' : 'dashboard'}`)} onKeyDown={(e) => e.key === 'Enter' && go(`/p/${p.id}/${role === 'adjudicator' ? 'assess' : 'dashboard'}`)}>
              <div className="row">
                <span className="badge role">{role === 'admin' ? 'Administrator' : role === 'lead' ? 'Lead' : 'Adjudicator'}</span>
                <span className="badge neutral">{p.status}</span>
                {p.labId && <span className="badge neutral"><Icon name="team" size={12} />{labName(p.labId)}</span>}
                {p.name.startsWith('Demonstration') && <span className="badge neutral">simulated data</span>}
              </div>
              <h3>{p.name}</h3>
              <p className="ink2 small" style={{ margin: 0 }}>{p.description}</p>
              <div className="small muted num">
                {items.toLocaleString()} items · {p.config.variables.length} variables · {p.config.requiredAdjudicators} judgments per item
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && <NewProject labs={labs} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewProject({ labs, onClose }: { labs: LabSummary[]; onClose: () => void }) {
  const { backend, fail } = useApp();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [objectives, setObjectives] = useState('');
  const [templateId, setTemplate] = useState('screening');
  const [labId, setLabId] = useState('');
  return (
    <Modal title="New project" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!name.trim()} onClick={() => backend.createProject({ name, description, objectives, templateId, labId: labId || undefined }).then((p) => go(`/p/${p.id}/settings`), fail)}>Create and configure</button>
    </>}>
      <div className="stack">
        <Field label="Name">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {labs.length > 0 && (
          <Field label="Owner" hint="A lab project is also administered by the lab's owners and administrators. You can move it later in Settings.">
            <select value={labId} onChange={(e) => setLabId(e.target.value)}>
              <option value="">Me (personal project)</option>
              {labs.map((l) => <option key={l.lab.id} value={l.lab.id}>{l.lab.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Description" hint="Shown to everyone on the project.">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Objectives">
          <textarea value={objectives} onChange={(e) => setObjectives(e.target.value)} />
        </Field>
        <div className="field">
          <span style={{ fontWeight: 550 }}>Template</span>
          <div className="choice-group">
            {TEMPLATES.map((t) => (
              <label key={t.id} className={`choice ${templateId === t.id ? 'selected' : ''}`}>
                <input type="radio" name="tpl" checked={templateId === t.id} onChange={() => setTemplate(t.id)} />
                <span>
                  {t.name}
                  <small>{t.summary}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
        <p className="muted small">A template only fills in the coding form and rules; you can change everything in Settings.</p>
      </div>
    </Modal>
  );
}

/** Researcher profile fields, shared by registration and the account page. */
function ProfileFields({ p, set }: { p: User; set: (u: User) => void }) {
  const orcidOk = !p.orcid?.trim() || !!normalizeOrcid(p.orcid);
  return (
    <>
      <Field label="Name" hint="Shown to your labs and to administrators of your projects. Other adjudicators see your project pseudonym.">
        <input type="text" value={p.displayName} onChange={(e) => set({ ...p, displayName: e.target.value })} autoComplete="name" />
      </Field>
      <Field label="Affiliation (optional)" hint="University, institute or organisation.">
        <input type="text" value={p.affiliation ?? ''} onChange={(e) => set({ ...p, affiliation: e.target.value })} autoComplete="organization" />
      </Field>
      <Field label="ORCID iD (optional)" hint={orcidOk ? 'For example 0000-0002-1825-0097. Shown to your labs, so collaborators can identify you.' : 'This ORCID iD is not valid; the last character is a check digit.'}>
        <input type="text" value={p.orcid ?? ''} onChange={(e) => set({ ...p, orcid: e.target.value })} aria-invalid={!orcidOk} placeholder="0000-0000-0000-0000" />
      </Field>
      <Field label="Research field (optional)">
        <input type="text" value={p.field ?? ''} onChange={(e) => set({ ...p, field: e.target.value })} />
      </Field>
    </>
  );
}

/** First sign-in on a shared server: complete the profile and accept this deployment's terms. */
export function Onboarding() {
  const { backend, user, fail } = useApp();
  const [p, setP] = useState<User | null>(user);
  const [agree, setAgree] = useState(false);
  if (!user || !p) return null;
  const orcidOk = !p.orcid?.trim() || !!normalizeOrcid(p.orcid);
  return (
    <div className="center-narrow" style={{ maxWidth: 640 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <Logo size={32} />
        <h1 style={{ margin: 0 }}>Welcome to Agreemetry</h1>
      </div>
      <div className="card stack">
        <h2>Your researcher profile</h2>
        <p className="ink2">Signed in as {user.email}. Choose the name colleagues will know you by; everything else is optional and can be changed later under Account.</p>
        <ProfileFields p={p} set={setP} />
        <label className="check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>
            I accept the {config.termsUrl ? <a href={config.termsUrl} target="_blank" rel="noopener noreferrer">terms of use</a> : 'terms of use'}
            {config.privacyUrl && <> and have read the <a href={config.privacyUrl} target="_blank" rel="noopener noreferrer">privacy notice</a></>} of this deployment
            {config.operator ? `, run by ${config.operator}` : ''}. I will upload research material only with the approvals my study requires.
          </span>
        </label>
        <div className="row end">
          <button className="btn" onClick={() => void backend.signOut()}>Sign out</button>
          <button className="btn primary" disabled={!agree || !p.displayName.trim() || !orcidOk} onClick={() => backend.updateUser({ ...p, acceptTerms: true } as User).then(() => go('/'), fail)}>Continue</button>
        </div>
      </div>
    </div>
  );
}

export function Account() {
  const { backend, user, fail, toast } = useApp();
  const [p, setP] = useState<User | null>(user);
  useEffect(() => setP(user), [user]);
  if (!user || !p) return null;
  return (
    <div className="center-narrow" style={{ maxWidth: 720 }}>
      <h1>Account</h1>
      <div className="card stack">
        <h2>Researcher profile</h2>
        {user.email && <p className="ink2" style={{ margin: 0 }}>Signed in as {user.email}.</p>}
        <ProfileFields p={p} set={setP} />
        <div className="row end">
          <button className="btn primary" onClick={() => backend.updateUser(p).then(() => toast('Profile saved.'), fail)}>Save profile</button>
        </div>
      </div>
      <ApiTokens />
      {backend instanceof LocalBackend && (
        <div className="card stack">
          <h2>Local workspace</h2>
          <p className="ink2">Data live in this browser's storage. Export project archives regularly as a backup. Resetting deletes every local project and restores the bundled and demonstration projects.</p>
          <div className="row">
            <button className="btn danger" onClick={() => { if (confirm('Delete all local data and restore the starting projects? This cannot be undone.')) void (backend as LocalBackend).resetWorkspace().then(() => go('/')); }}>Reset local workspace</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Personal API tokens for scripts and other platforms (shared server). */
function ApiTokens() {
  const { backend, fail, toast } = useApp();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('read');
  const [projectId, setProjectId] = useState('');
  const [days, setDays] = useState(90);
  const [secret, setSecret] = useState('');
  const supported = !!backend.listApiTokens;
  const load = () => {
    if (!supported) return;
    void backend.listApiTokens!().then(setTokens, fail);
    void backend.listProjects().then(setProjects, fail);
  };
  useEffect(load, [backend]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!supported) {
    return (
      <div className="card stack">
        <h2>API access</h2>
        <p className="ink2" style={{ margin: 0 }}>Personal API tokens let scripts and other platforms read results, push items and follow progress. They need the shared server deployment, because a local workspace has no server to call. See docs/API.md.</p>
      </div>
    );
  }
  const active = tokens.filter((t) => !t.revokedAt && (!t.expiresAt || t.expiresAt > new Date().toISOString()));
  const projectName = (id?: string) => (id ? projects.find((x) => x.project.id === id)?.project.name ?? id : 'All my projects');
  return (
    <div className="card stack">
      <h2>API tokens</h2>
      <p className="ink2" style={{ margin: 0 }}>
        A token acts as you, with your roles, so every blinding rule still applies. Prefer read-only tokens limited to one project. Send it in the <code>X-Agreemetry-Token</code> header; see docs/API.md for the endpoints.
      </p>
      {secret && (
        <Notice tone="good">
          <div className="stack" style={{ gap: 6 }}>
            <strong>Copy this token now. It is shown only once.</strong>
            <div className="secret">{secret}</div>
            <div className="row">
              <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(secret).then(() => toast('Copied.'))}>Copy</button>
              <button className="btn sm" onClick={() => setSecret('')}>Done</button>
            </div>
          </div>
        </Notice>
      )}
      <div className="grid cols-2">
        <Field label="Name" hint="What will use it, for example: nightly R report.">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Access">
          <select value={scope} onChange={(e) => setScope(e.target.value as TokenScope)}>
            <option value="read">Read only</option>
            <option value="write">Read and write (import items, save judgments)</option>
          </select>
        </Field>
        <Field label="Project">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All my projects</option>
            {projects.map((x) => <option key={x.project.id} value={x.project.id}>{x.project.name}</option>)}
          </select>
        </Field>
        <Field label="Expires after">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 180, 366].map((d) => <option key={d} value={d}>{d === 366 ? 'One year' : `${d} days`}</option>)}
          </select>
        </Field>
      </div>
      <div className="row end">
        <button className="btn primary" disabled={!name.trim()} onClick={() => backend.createApiToken!({ name: name.trim(), scope, projectId: projectId || undefined, days }).then((r) => { setSecret(r.token); setName(''); load(); }, fail)}>Create token</button>
      </div>
      {tokens.length > 0 && (
        <div>
          {tokens.map((t) => {
            const isActive = active.includes(t);
            return (
              <div className="member-row" key={t.id}>
                <div className="who">
                  <strong>{t.name}</strong> <span className="mono small muted">{t.prefix}…</span>
                  <small>
                    {t.scope === 'read' ? 'Read only' : 'Read and write'} · {projectName(t.projectId)} ·{' '}
                    {t.revokedAt ? `revoked ${t.revokedAt.slice(0, 10)}` : isActive ? `expires ${t.expiresAt?.slice(0, 10)}` : 'expired'}
                    {t.lastUsedAt ? ` · last used ${t.lastUsedAt.slice(0, 10)}` : ' · never used'}
                  </small>
                </div>
                {isActive && <button className="btn sm danger" onClick={() => backend.revokeApiToken!(t.id).then(load, fail)}>Revoke</button>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

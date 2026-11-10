import { useCallback, useEffect, useState } from 'react';
import { go, useApp } from '../app';
import { Empty, Field, Icon, Modal, Notice } from '../components';
import type { Lab, LabDetail, LabRole, LabSummary, User } from '../../core/types';
import type { LabInvitation } from '../../data/backend';
import { labSlug } from '../../core/util';

const ROLE_LABEL: Record<LabRole, string> = { owner: 'Owner', admin: 'Administrator', member: 'Member' };

/** All labs the signed-in researcher belongs to, invitations, and creating a lab. */
export function Labs() {
  const { backend, user, toast, fail } = useApp();
  const [labs, setLabs] = useState<LabSummary[] | null>(null);
  const [invites, setInvites] = useState<LabInvitation[]>([]);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    void backend.listLabs().then(setLabs, fail);
    if (backend.listMyLabInvites) void backend.listMyLabInvites().then(setInvites, fail);
  }, [backend, fail]);
  useEffect(() => {
    load();
    return backend.subscribe(load);
  }, [backend, load, user?.id]);

  return (
    <div className="center-narrow">
      <div className="page-head">
        <div className="grow">
          <h1>Labs</h1>
          <p>A lab is a group account for a team, lab or centre. It owns projects, and its owners and administrators administer every lab project, so work continues when people come and go. Members see the lab's people and project list; they work only on projects they are added to.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          New lab
        </button>
      </div>
      {invites.length > 0 && (
        <div className="card stack" style={{ marginBottom: 16 }}>
          <h2>Invitations</h2>
          {invites.map((iv) => (
            <div className="member-row" key={iv.lab.id}>
              <div className="who">
                <strong>{iv.lab.name}</strong>
                <small>Invited as {ROLE_LABEL[iv.role].toLowerCase()}{iv.invitedBy ? ` by ${iv.invitedBy}` : ''}. Joining shows your name, affiliation and ORCID iD to the lab.</small>
              </div>
              <button className="btn primary sm" onClick={() => backend.respondLabInvite!(iv.lab.id, true).then(() => { toast(`You joined ${iv.lab.name}.`); load(); }, fail)}>Join</button>
              <button className="btn sm" onClick={() => backend.respondLabInvite!(iv.lab.id, false).then(load, fail)}>Decline</button>
            </div>
          ))}
        </div>
      )}
      {labs === null ? (
        <p className="muted">Loading</p>
      ) : labs.length === 0 ? (
        <Empty title="No labs yet">
          <p className="ink2">Create a lab for your team, or ask a lab administrator to invite you. Personal projects work without one.</p>
        </Empty>
      ) : (
        <div className="grid cols-2">
          {labs.map(({ lab, role, members, projects }) => (
            <div key={lab.id} className="card projcard" role="link" tabIndex={0} onClick={() => go(`/labs/${lab.id}`)} onKeyDown={(e) => e.key === 'Enter' && go(`/labs/${lab.id}`)}>
              <div className="row">
                <span className="badge role">{ROLE_LABEL[role]}</span>
                <span className="badge neutral mono">@{lab.slug}</span>
              </div>
              <h3>{lab.name}</h3>
              {lab.description && <p className="ink2 small" style={{ margin: 0 }}>{lab.description}</p>}
              <div className="small muted num">{members} {members === 1 ? 'member' : 'members'} · {projects} {projects === 1 ? 'project' : 'projects'}</div>
            </div>
          ))}
        </div>
      )}
      {creating && <LabForm onClose={() => setCreating(false)} onSaved={(l) => go(`/labs/${l.id}`)} />}
    </div>
  );
}

function LabForm({ lab, onClose, onSaved }: { lab?: Lab; onClose: () => void; onSaved: (l: Lab) => void }) {
  const { backend, fail, toast } = useApp();
  const [name, setName] = useState(lab?.name ?? '');
  const [handle, setHandle] = useState(lab?.slug ?? '');
  const [touched, setTouched] = useState(!!lab);
  const [description, setDescription] = useState(lab?.description ?? '');
  const [website, setWebsite] = useState(lab?.website ?? '');
  const slug = touched ? labSlug(handle) : labSlug(name);
  async function save() {
    try {
      const saved = lab
        ? await backend.updateLab({ ...lab, name, slug, description, website })
        : await backend.createLab({ name, slug, description, website });
      toast(lab ? 'Lab saved.' : `Created ${saved.name}.`);
      onSaved(saved);
      onClose();
    } catch (e) {
      fail(e);
    }
  }
  return (
    <Modal title={lab ? 'Edit lab' : 'New lab'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>{lab ? 'Save' : 'Create lab'}</button>
    </>}>
      <div className="stack">
        <Field label="Name" hint="For example: Measurement and Learning Analytics Lab.">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Handle" hint="A short unique name: lowercase letters, digits and hyphens.">
          <input type="text" value={touched ? handle : slug} onChange={(e) => { setTouched(true); setHandle(e.target.value); }} />
        </Field>
        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Website (optional)">
          <input type="url" value={website} placeholder="https://" onChange={(e) => setWebsite(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** One lab: profile, people, invitations and projects. */
export function LabPage({ labId }: { labId: string }) {
  const { backend, user, toast, fail } = useApp();
  const [d, setD] = useState<LabDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => {
    backend.getLab(labId).then((x) => { setD(x); setError(''); }, (e: Error) => setError(e.message));
  }, [backend, labId]);
  useEffect(() => {
    load();
    return backend.subscribe(load);
  }, [backend, load]);

  if (error) return <div className="center-narrow"><Notice tone="error">{error}</Notice><p><a href="#/labs">All labs</a></p></div>;
  if (!d || !user) return <div className="center-narrow muted">Loading</div>;
  const manage = d.role === 'owner' || d.role === 'admin';
  const act = (p: Promise<unknown>, msg?: string) => p.then(() => { if (msg) toast(msg); load(); }, fail);

  return (
    <div className="center-narrow">
      <p className="small"><a href="#/labs">All labs</a></p>
      <div className="page-head">
        <div className="grow">
          <h1>{d.lab.name}</h1>
          <p>
            <span className="mono">@{d.lab.slug}</span>
            {d.lab.website && <> · <a href={d.lab.website} target="_blank" rel="noopener noreferrer">{d.lab.website.replace(/^https?:\/\//, '')}</a></>}
            {' · '}You are {d.role === 'owner' ? 'an owner' : d.role === 'admin' ? 'an administrator' : 'a member'}.
          </p>
          {d.lab.description && <p className="ink2">{d.lab.description}</p>}
        </div>
        {manage && <button className="btn" onClick={() => setEditing(true)}>Edit lab</button>}
      </div>

      <Notice tone="info">Owners and administrators of this lab are administrators of every lab project. Someone who already has a role on a project keeps that role instead, so a lab administrator who rates a lab project stays blind to the other judgments.</Notice>

      <div className="grid cols-2" style={{ marginTop: 16, alignItems: 'start' }}>
        <div className="card stack">
          <h2>People</h2>
          <div>
            {d.members.map((m) => (
              <div className="member-row" key={m.userId}>
                <div className="who">
                  <strong>{m.displayName}{m.userId === user.id ? ' (you)' : ''}</strong>
                  <small>{[m.affiliation, m.orcid ? `ORCID ${m.orcid}` : '', m.email].filter(Boolean).join(' · ')}</small>
                </div>
                {manage && m.userId !== user.id && (d.role === 'owner' || m.role !== 'owner') ? (
                  <>
                    <select aria-label={`Role of ${m.displayName}`} value={m.role} style={{ width: 'auto' }} onChange={(e) => void act(backend.setLabMemberRole(d.lab.id, m.userId, e.target.value as LabRole), 'Role changed.')}>
                      {(d.role === 'owner' ? (['owner', 'admin', 'member'] as const) : (['admin', 'member'] as const)).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                    <button className="btn sm" onClick={() => { if (confirm(`Remove ${m.displayName} from the lab? Their administrator access to lab projects ends; direct project roles stay.`)) void act(backend.removeLabMember(d.lab.id, m.userId), 'Removed.'); }}>Remove</button>
                  </>
                ) : (
                  <span className="badge neutral">{ROLE_LABEL[m.role]}</span>
                )}
              </div>
            ))}
          </div>
          {manage && <AddMember d={d} onDone={load} />}
          {manage && d.invites.length > 0 && (
            <div className="stack">
              <h3>Pending invitations</h3>
              {d.invites.map((iv) => (
                <div className="member-row" key={iv.email}>
                  <div className="who"><strong>{iv.email}</strong><small>{ROLE_LABEL[iv.role]} · sent {iv.createdAt.slice(0, 10)}</small></div>
                  <button className="btn sm" onClick={() => void act(backend.cancelLabInvite!(d.lab.id, iv.email), 'Invitation cancelled.')}>Cancel</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card stack" style={{ marginTop: 0 }}>
          <h2>Projects</h2>
          {d.projects.length === 0 ? (
            <p className="ink2">No projects yet. Create one from <a href="#/">Projects</a> and choose this lab as the owner, or move an existing project here from its settings.</p>
          ) : (
            <div>
              {d.projects.map((p) => (
                <div className="member-row" key={p.id}>
                  <div className="who">
                    {p.myRole ? <a href={`#/p/${p.id}/${p.myRole === 'adjudicator' ? 'assess' : 'dashboard'}`}><strong>{p.name}</strong></a> : <strong>{p.name}</strong>}
                    <small>{p.status}{p.myRole ? '' : ' · ask a project administrator to add you'}</small>
                  </div>
                  {p.myRole && <span className="badge role">{p.myRole === 'admin' ? 'Administrator' : p.myRole === 'lead' ? 'Lead' : 'Adjudicator'}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card stack" style={{ marginTop: 16 }}>
        <h2>Leave or delete</h2>
        <div className="row">
          <button className="btn" onClick={() => { if (confirm(`Leave ${d.lab.name}?`)) backend.removeLabMember(d.lab.id, user.id).then(() => go('/labs'), fail); }}>Leave lab</button>
          {d.role === 'owner' && (
            <button className="btn danger" disabled={d.projects.length > 0} title={d.projects.length ? 'Move the projects out of the lab first.' : undefined} onClick={() => { if (confirm(`Delete ${d.lab.name}? Its projects must be moved out first.`)) backend.deleteLab(d.lab.id).then(() => go('/labs'), fail); }}>Delete lab</button>
          )}
        </div>
        {d.role === 'owner' && d.projects.length > 0 && <p className="small muted">A lab with projects cannot be deleted. Move each project out of the lab in its settings first.</p>}
      </div>
      {editing && <LabForm lab={d.lab} onClose={() => setEditing(false)} onSaved={load} />}
    </div>
  );
}

function AddMember({ d, onDone }: { d: LabDetail; onDone: () => void }) {
  const { backend, toast, fail } = useApp();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<LabRole>('member');
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState('');
  const local = !backend.inviteLabMember;
  useEffect(() => {
    if (local) void backend.listUsers().then(setUsers);
  }, [backend, local]);
  const candidates = users.filter((u) => u.active && !d.members.some((m) => m.userId === u.id));
  const roles = (['member', 'admin', 'owner'] as const).filter((r) => r !== 'owner' || d.role === 'owner');
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3>{local ? 'Add someone' : 'Invite someone'}</h3>
      <div className="row">
        {local ? (
          <select aria-label="Person" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ flex: '1 1 180px', width: 'auto' }}>
            <option value="">Choose a person</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        ) : (
          <input type="email" aria-label="Email address" placeholder="name@university.edu" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: '1 1 200px' }} />
        )}
        <select aria-label="Lab role" value={role} onChange={(e) => setRole(e.target.value as LabRole)} style={{ width: 'auto' }}>
          {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <button className="btn primary" disabled={local ? !userId : !email.includes('@')} onClick={() => {
          const p = local ? backend.addLabMember!(d.lab.id, userId, role) : backend.inviteLabMember!(d.lab.id, email.trim(), role);
          p.then(() => { toast(local ? 'Added to the lab.' : `Invitation recorded for ${email.trim()}. They join when they sign in and accept it.`); setEmail(''); setUserId(''); onDone(); }, fail);
        }}>{local ? 'Add' : 'Invite'}</button>
      </div>
      {!local && <p className="small muted">The person accepts the invitation under Labs after signing in with this address. Agreemetry does not send the email; tell them yourself.</p>}
    </div>
  );
}

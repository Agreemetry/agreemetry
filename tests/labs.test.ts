/**
 * Labs (group accounts) and researcher profiles in the local workspace. The same rules are implemented in
 * SQL for the shared server and tested in tests/sql.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { MemDb, Service, fullData } from '../src/data/service';
import { labSlug, normalizeOrcid } from '../src/core/util';
import type { Membership } from '../src/core/types';

function setup() {
  const db = new MemDb();
  const boot = new Service(db, '');
  const [owner, admin2, member, rater, outsider] = ['Owner', 'Second admin', 'Member', 'Rater', 'Outsider'].map((n) => boot.createUser(n));
  const as = (u: { id: string }) => new Service(db, u.id);
  return { db, owner, admin2, member, rater, outsider, as };
}

const membership = (db: MemDb, projectId: string, userId: string) => fullData(db, projectId).memberships.find((m) => m.userId === userId) as Membership | undefined;

describe('ORCID iDs and lab handles', () => {
  it('accepts valid ORCID iDs in any common form and rejects wrong check digits', () => {
    expect(normalizeOrcid('0000-0002-1825-0097')).toBe('0000-0002-1825-0097');
    expect(normalizeOrcid('https://orcid.org/0000-0002-1694-233X')).toBe('0000-0002-1694-233X');
    expect(normalizeOrcid('000000021694233x')).toBe('0000-0002-1694-233X');
    expect(normalizeOrcid('0000-0002-1825-0098')).toBeNull();
    expect(normalizeOrcid('1234')).toBeNull();
  });

  it('derives lab handles from names', () => {
    expect(labSlug('Measurement & Learning Analytics Lab')).toBe('measurement-learning-analytics-lab');
    expect(labSlug('Équipe Évaluation')).toBe('equipe-evaluation');
    expect(labSlug('***')).toBe('lab');
  });
});

describe('Labs in the local workspace', () => {
  it('stores a researcher profile and refuses an invalid ORCID iD', () => {
    const { db, member, as } = setup();
    as(member).updateUser({ ...member, affiliation: ' Example University ', orcid: 'https://orcid.org/0000-0002-1825-0097', field: 'Psychometrics' });
    const u = db.get<typeof member>('users', member.id)!;
    expect(u.affiliation).toBe('Example University');
    expect(u.orcid).toBe('0000-0002-1825-0097');
    expect(() => as(member).updateUser({ ...member, orcid: '0000-0002-1825-0098' })).toThrow(/ORCID/);
  });

  it('gives lab owners and administrators administration of lab projects, without overriding direct roles', () => {
    const { db, owner, admin2, member, rater, outsider, as } = setup();
    const lab = as(owner).createLab({ name: 'Reliability Lab' });
    expect(lab.slug).toBe('reliability-lab');
    expect(() => as(member).createLab({ name: 'Other', slug: 'reliability-lab' })).toThrow(/taken/);
    as(owner).addLabMember(lab.id, admin2.id, 'admin');
    as(owner).addLabMember(lab.id, member.id, 'member');
    as(owner).addLabMember(lab.id, rater.id, 'admin');
    expect(() => as(admin2).addLabMember(lab.id, rater.id, 'member')).toThrow(/already/);

    // A personal project with a direct adjudicator, then moved into the lab.
    const p = as(owner).createProject({ name: 'P', description: '', objectives: '', templateId: 'screening' });
    as(owner).upsertMembership({ projectId: p.id, userId: rater.id, role: 'adjudicator', pseudonym: '', active: true, adjudicates: true });
    as(owner).moveProjectToLab(p.id, lab.id);
    expect(membership(db, p.id, admin2.id)).toMatchObject({ role: 'admin', active: true, viaLab: true });
    expect(membership(db, p.id, rater.id)?.role).toBe('adjudicator');
    expect(membership(db, p.id, rater.id)?.viaLab).toBeFalsy();
    expect(membership(db, p.id, member.id)).toBeUndefined();

    // Lab members see the lab's projects; only the people on a project can open it.
    const detail = as(member).getLab(lab.id);
    expect(detail.projects).toEqual([{ id: p.id, name: 'P', status: 'draft', myRole: undefined }]);
    expect(detail.members.find((m) => m.userId === owner.id)?.email).toBeUndefined();
    expect(() => as(member).getProjectData(p.id)).toThrow();

    // A forged labId in an edit is ignored; ownership changes only through moveProjectToLab.
    const cur = fullData(db, p.id).project;
    const saved = as(owner).updateProject({ ...cur, labId: undefined });
    expect(saved.labId).toBe(lab.id);

    // Demoting a lab administrator ends the access that came from the lab.
    as(owner).setLabMemberRole(lab.id, admin2.id, 'member');
    expect(membership(db, p.id, admin2.id)?.active).toBe(false);
    as(owner).setLabMemberRole(lab.id, admin2.id, 'admin');
    expect(membership(db, p.id, admin2.id)?.active).toBe(true);

    expect(() => as(admin2).setLabMemberRole(lab.id, owner.id, 'member')).toThrow(/owner/);
    expect(() => as(owner).setLabMemberRole(lab.id, owner.id, 'member')).toThrow(/at least one owner/);
    expect(() => as(owner).removeLabMember(lab.id, owner.id)).toThrow(/at least one owner/);
    expect(() => as(owner).deleteLab(lab.id)).toThrow(/Move the lab/);

    // New projects can be created in the lab directly.
    const q = as(member).createProject({ name: 'Q', description: '', objectives: '', templateId: 'blank', labId: lab.id });
    expect(q.labId).toBe(lab.id);
    expect(fullData(db, q.id).memberships.filter((m) => m.role === 'admin' && m.active).map((m) => m.userId).sort()).toEqual([member.id, owner.id, admin2.id, rater.id].sort());
    expect(() => as(outsider).createProject({ name: 'X', description: '', objectives: '', templateId: 'blank', labId: lab.id })).toThrow(/not a member/);

    // Taking projects out of the lab revokes lab administration; then the lab can be deleted.
    as(owner).moveProjectToLab(p.id, null);
    expect(membership(db, p.id, admin2.id)?.active).toBe(false);
    as(member).moveProjectToLab(q.id, null);
    as(owner).deleteLab(lab.id);
    expect(as(owner).listLabs()).toEqual([]);
    const actions = fullData(db, p.id).audit.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['project.lab', 'member.lab_grant', 'member.lab_revoke']));
  });

  it('refuses a lab change that would leave a project without an administrator', () => {
    const { db, owner, admin2, as } = setup();
    const lab = as(owner).createLab({ name: 'Lab' });
    const p = as(admin2).createProject({ name: 'P', description: '', objectives: '', templateId: 'blank' });
    as(owner).addLabMember(lab.id, admin2.id, 'member');
    as(admin2).moveProjectToLab(p.id, lab.id);
    expect(membership(db, p.id, owner.id)).toMatchObject({ role: 'admin', viaLab: true, active: true });
    // P's only direct administrator steps down; the owner now administers P only through the lab.
    as(admin2).upsertMembership({ projectId: p.id, userId: admin2.id, role: 'admin', pseudonym: '', active: false, adjudicates: false });
    expect(() => as(owner).moveProjectToLab(p.id, null)).toThrow(/without an active administrator/);
    expect(fullData(db, p.id).project.labId).toBe(lab.id);
    // Made a direct administrator, the owner can take the project out of the lab.
    as(owner).upsertMembership({ projectId: p.id, userId: owner.id, role: 'admin', pseudonym: '', active: true, adjudicates: false });
    as(owner).moveProjectToLab(p.id, null);
    expect(fullData(db, p.id).project.labId).toBeUndefined();
    expect(membership(db, p.id, owner.id)).toMatchObject({ role: 'admin', active: true });
  });
});

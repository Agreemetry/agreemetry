/**
 * The Supabase migrations, run in an embedded Postgres (PGlite) with a stand-in for Supabase's auth schema.
 * Checks server-side blinding, permissions, the resolution flow, that the SQL item states equal the
 * TypeScript states on every demonstration item, and the accounts, labs, API token, events, results and
 * webhook functions.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MemDb, Service, fullData } from '../src/data/service';
import { seedDemos } from '../src/data/demo';
import { computeAllStatuses } from '../src/core/workflow';
import { baseConfig } from '../src/core/templates';

const SHIM = `
create schema if not exists auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
`;

let db: PGlite;
const ids = { admin: randomUUID(), r1: randomUUID(), r2: randomUUID(), lead: randomUUID(), outsider: randomUUID() };

async function as<T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${user}', false); select set_config('request.jwt.claims', '{"email":"${user}@example.org"}', false); set role authenticated;`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec('reset role;');
  }
}

async function rpc<T = unknown>(user: string, fn: string, args: unknown[]): Promise<T> {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await as<{ r: T }>(user, `select public.${fn}(${ph}) as r`, args);
  return rows[0]?.r;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SHIM);
  for (const f of readdirSync('supabase/migrations').filter((x) => x.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${f}`, 'utf-8'));
  for (const [k, id] of Object.entries(ids)) await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${k}@example.org`]);
}, 120000);

describe('Supabase schema', () => {
  let pid = '';
  const item = (n: number) => ({ externalId: `X${n}`, batch: 'b', category: '', fields: { text: `item ${n}`, arm: n % 2 ? 'A1' : 'A2' }, importedAt: '', seq: n });

  it('creates profiles from auth users and closes raw tables to clients', async () => {
    expect((await db.query('select count(*)::int as n from public.profiles')).rows[0]).toEqual({ n: 5 });
    await expect(as(ids.r1, 'select * from public.assessments')).rejects.toThrow(/permission denied/);
    await expect(as(ids.r1, 'select * from public.items')).rejects.toThrow(/permission denied/);
    expect(await as(ids.r1, 'select id from public.profiles')).toEqual([{ id: ids.r1 }]);
  });

  it('runs a two-adjudicator project with server-side blinding', async () => {
    const cfg = baseConfig([{ id: 'judgment', label: 'Judgment', type: 'binary', required: true, includeInAgreement: true, categories: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] }]);
    cfg.display = { titleField: 'text', bodyField: 'text', visibleFields: [], blindedFields: ['arm'] };
    cfg.resolution.options.find((o) => o.id === 'retain')!.enabled = true;
    const p = await rpc<{ id: string }>(ids.admin, 'create_project', [JSON.stringify({ name: 'SQL test', description: '', objectives: '', template: 'blank', status: 'active', config: cfg, documents: [{ id: 'a', title: 'Plan', body: 'secret', audience: 'admin' }], provenance: 'internal' })]);
    pid = p.id;
    await rpc(ids.admin, 'import_items', [pid, JSON.stringify([1, 2, 3, 4].map(item)), JSON.stringify([])]);
    for (const u of [ids.r1, ids.r2]) await rpc(ids.admin, 'upsert_membership', [pid, u, 'adjudicator', '', true, true]);
    await rpc(ids.admin, 'upsert_membership', [pid, ids.lead, 'lead', '', true, false]);
    await expect(rpc(ids.r1, 'upsert_membership', [pid, ids.outsider, 'adjudicator', '', true, true])).rejects.toThrow(/role/);
    await expect(rpc(ids.outsider, 'get_project_view', [pid])).rejects.toThrow(/not a member/);

    const view0 = await rpc<{ items: { id: string; fields: Record<string, unknown> }[]; project: { documents: unknown[]; provenance?: string } }>(ids.r1, 'get_project_view', [pid]);
    expect(view0.items).toHaveLength(4);
    expect(view0.items.every((i) => !('arm' in i.fields))).toBe(true);
    expect(view0.project.documents).toHaveLength(0);
    expect(view0.project.provenance).toBeUndefined();
    const i1 = view0.items[0].id;

    const a1 = await rpc<{ version: number; id: string }>(ids.r1, 'save_assessment', [pid, i1, JSON.stringify({ judgment: 'yes' }), '', '', true, 0]);
    expect(a1.version).toBe(1);
    await expect(rpc(ids.r1, 'save_assessment', [pid, i1, JSON.stringify({ judgment: 'no' }), '', '', true, 1])).rejects.toThrow(/submitted/);
    await expect(rpc(ids.r2, 'save_assessment', [pid, i1, JSON.stringify({ judgment: 'maybe' }), '', '', true, 0])).rejects.toThrow(/category/);
    await expect(rpc(ids.r2, 'save_assessment', [pid, i1, JSON.stringify({}), '', '', true, 0])).rejects.toThrow(/required/);
    await expect(rpc(ids.lead, 'save_assessment', [pid, i1, JSON.stringify({ judgment: 'no' }), '', '', true, 0])).rejects.toThrow(/not assigned/);

    let v2 = await rpc<{ assessments: { userId: string }[]; serverStatus: Record<string, { state: string; disputedVariables: string[] }> }>(ids.r2, 'get_project_view', [pid]);
    expect(v2.assessments).toHaveLength(0);
    expect(v2.serverStatus[i1].state).toBe('awaiting');
    const lead0 = await rpc<{ assessments: unknown[] }>(ids.lead, 'get_project_view', [pid]);
    expect(lead0.assessments).toHaveLength(0);

    await rpc(ids.r2, 'save_assessment', [pid, i1, JSON.stringify({ judgment: 'no' }), 'unsure', '', true, 0]);
    v2 = await rpc(ids.r2, 'get_project_view', [pid]);
    expect(v2.assessments.map((a) => a.userId).sort()).toEqual([ids.r1, ids.r2].sort());
    expect(v2.serverStatus[i1].state).toBe('disagreement');
    expect(v2.serverStatus[i1].disputedVariables).toEqual(['judgment']);
    await expect(rpc(ids.r1, 'reopen_assessment', [pid, a1.id, 'typo'])).rejects.toThrow(/disclosed/);

    await expect(rpc(ids.r1, 'propose_resolution', [pid, JSON.stringify({ itemId: i1, optionId: 'new', values: {}, rationaleIds: ['error'], freeText: '', references: '' })])).rejects.toThrow(/final value/);
    const prop = await rpc<{ id: string; values: Record<string, string> }>(ids.r1, 'propose_resolution', [pid, JSON.stringify({ itemId: i1, optionId: 'retain', retainedUserId: ids.r2, values: {}, rationaleIds: ['error'], freeText: '', references: '' })]);
    expect(prop.values.judgment).toBe('no');
    await expect(rpc(ids.r1, 'approve_resolution', [pid, prop.id])).rejects.toThrow(/cannot approve/);
    const fin = await rpc<{ status: string }>(ids.r2, 'approve_resolution', [pid, prop.id]);
    expect(fin.status).toBe('final');
    const admin = await rpc<{ items: { fields: Record<string, unknown> }[]; audit: { action: string }[] }>(ids.admin, 'get_project_view', [pid]);
    expect(admin.items[0].fields.arm).toBeDefined();
    expect(admin.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['assessment.submit', 'resolution.propose', 'resolution.approve', 'resolution.finalize']));
    const st = (await db.query<{ state: string }>('select state from public.agm_item_status($1) where item_id = $2', [pid, i1])).rows[0];
    expect(st.state).toBe('resolved');
    await expect(db.query('update public.audit set action = $1', ['x'])).rejects.toThrow(/append-only/);
    await expect(rpc(ids.r1, 'reopen_resolution', [pid, prop.id, 'no'])).rejects.toThrow(/role/);
    await rpc(ids.admin, 'reopen_resolution', [pid, prop.id, 'new evidence']);
    expect((await db.query<{ state: string }>('select state from public.agm_item_status($1) where item_id = $2', [pid, i1])).rows[0].state).toBe('disagreement');
  });

  it('refuses configuration changes that orphan judgments, and stale versions', async () => {
    const cur = (await db.query<{ doc: Record<string, unknown>; version: number }>('select doc, version from public.projects where id = $1', [pid])).rows[0];
    const doc = { ...cur.doc, version: cur.version } as { config: { variables: { categories: { value: string }[] }[] }; version: number };
    const bad = JSON.parse(JSON.stringify(doc));
    bad.config.variables[0].categories[1].value = 'y';
    await expect(rpc(ids.admin, 'update_project', [JSON.stringify(bad)])).rejects.toThrow(/in use/);
    const ok = JSON.parse(JSON.stringify(doc));
    await rpc(ids.admin, 'update_project', [JSON.stringify(ok)]);
    await expect(rpc(ids.admin, 'update_project', [JSON.stringify(ok)])).rejects.toThrow(/changed by someone else/);
  });

  it('computes the same item states as the TypeScript implementation on every demonstration item', async () => {
    const mem = new MemDb();
    const a = new Service(mem, '').createUser('Admin');
    const projects = seedDemos(mem, a.id);
    const uuid = new Map<string, string>();
    const U = (x: string) => {
      if (!uuid.has(x)) uuid.set(x, randomUUID());
      return uuid.get(x)!;
    };
    let compared = 0;
    for (const p of projects) {
      const d = fullData(mem, p.id);
      const pidDemo = `demo_${p.id}`;
      for (const u of d.users) await db.query('insert into public.profiles (id, display_name) values ($1, $2) on conflict do nothing', [U(u.id), u.displayName]);
      await db.query('insert into public.projects (id, doc, status, version) values ($1, $2, $3, $4)', [pidDemo, JSON.stringify(d.project), d.project.status, d.project.version]);
      for (const m of d.memberships) await db.query('insert into public.memberships values ($1, $2, $3, $4, $5, $6)', [pidDemo, U(m.userId), m.role, m.pseudonym, m.active, m.adjudicates]);
      for (const it of d.items) await db.query('insert into public.items (id, project_id, external_id, seq, doc) values ($1, $2, $3, $4, $5)', [`${pidDemo}:${it.id}`, pidDemo, it.externalId, it.seq, JSON.stringify(it)]);
      for (const x of d.assignments) await db.query('insert into public.assignments (project_id, item_id, user_id) values ($1, $2, $3)', [pidDemo, `${pidDemo}:${x.itemId}`, U(x.userId)]);
      for (const x of d.assessments) await db.query('insert into public.assessments (id, project_id, item_id, user_id, status, version, doc) values ($1, $2, $3, $4, $5, $6, $7)', [`${pidDemo}:${x.id}`, pidDemo, `${pidDemo}:${x.itemId}`, U(x.userId), x.status, x.version, JSON.stringify(x)]);
      for (const x of d.resolutions) await db.query('insert into public.resolutions (id, project_id, item_id, status, version, doc) values ($1, $2, $3, $4, $5, $6)', [`${pidDemo}:${x.id}`, pidDemo, `${pidDemo}:${x.itemId}`, x.status, x.version, JSON.stringify(x)]);
      for (const x of d.escalations) await db.query('insert into public.escalations (id, project_id, item_id, open, doc) values ($1, $2, $3, $4, $5)', [`${pidDemo}:${x.id}`, pidDemo, `${pidDemo}:${x.itemId}`, x.open, JSON.stringify(x)]);
      const ts = computeAllStatuses(d);
      const sql = (await db.query<{ item_id: string; state: string; disputed: string[]; submitted: string[] }>('select item_id, state, disputed, submitted from public.agm_item_status($1)', [pidDemo])).rows;
      expect(sql).toHaveLength(d.items.length);
      for (const r of sql) {
        const t = ts.get(r.item_id.slice(pidDemo.length + 1))!;
        expect({ item: r.item_id, state: r.state, disputed: [...r.disputed].sort(), n: r.submitted.length }).toEqual({ item: r.item_id, state: t.state, disputed: [...t.disputed].sort(), n: t.submitted.length });
        compared++;
      }
    }
    expect(compared).toBe(48 + 30 + 36);
  });
});

/** A request made with an API token: PostgREST runs the pre-request hook, then the function, in one transaction as anon. */
async function viaToken<T = unknown>(token: string, fn: string, args: unknown[] = []): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true)");
    await tx.query("select set_config('request.headers', $1, true), set_config('request.path', $2, true)", [JSON.stringify({ 'x-agreemetry-token': token }), `/rpc/${fn}`]);
    await tx.exec('set local role anon');
    await tx.query('select public.agm_pre_request()');
    const ph = args.map((_, i) => `$${i + 1}`).join(', ');
    return (await tx.query<{ r: T }>(`select public.${fn}(${ph}) as r`, args)).rows[0]?.r as T;
  });
}

describe('Accounts, labs and the API', () => {
  let pid = '';
  let labId = '';
  const cfg = () => baseConfig([{ id: 'judgment', label: 'Judgment', type: 'binary', required: true, includeInAgreement: true, categories: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] }]);
  const newProject = (name: string) => rpc<{ id: string }>(ids.admin, 'create_project', [JSON.stringify({ name, description: '', objectives: '', template: 'blank', status: 'active', config: cfg(), documents: [] })]);

  beforeAll(async () => {
    pid = (await newProject('Lab project')).id;
    await rpc(ids.admin, 'import_items', [pid, JSON.stringify([1, 2].map((n) => ({ externalId: `L${n}`, batch: '', category: '', fields: { text: `t${n}` }, importedAt: '', seq: n }))), '[]']);
    await rpc(ids.admin, 'upsert_membership', [pid, ids.r1, 'adjudicator', '', true, true]);
  });

  it('keeps a researcher profile with a checked ORCID iD and records acceptance of the terms', async () => {
    const prof = await rpc<{ orcid: string; affiliation: string; termsAcceptedAt?: string }>(ids.r1, 'update_my_profile', [JSON.stringify({ displayName: 'Rater One', affiliation: 'Example University', orcid: 'https://orcid.org/0000-0002-1825-0097', field: 'Education', acceptTerms: true })]);
    expect(prof.orcid).toBe('0000-0002-1825-0097');
    expect(prof.affiliation).toBe('Example University');
    expect(prof.termsAcceptedAt).toBeTruthy();
    await expect(rpc(ids.r1, 'update_my_profile', [JSON.stringify({ orcid: '0000-0002-1825-0098' })])).rejects.toThrow(/check digit/);
    expect((await rpc<{ displayName: string }>(ids.r1, 'get_my_profile', [])).displayName).toBe('Rater One');
  });

  it('runs a lab: consent to join, administration of lab projects, and direct roles that win', async () => {
    const lab = await rpc<{ id: string; slug: string }>(ids.admin, 'create_lab', [JSON.stringify({ name: 'Reliability Lab', description: 'Test lab' })]);
    labId = lab.id;
    expect(lab.slug).toBe('reliability-lab');
    await expect(rpc(ids.lead, 'create_lab', [JSON.stringify({ name: 'Other', slug: 'reliability-lab' })])).rejects.toThrow(/taken/);
    await expect(rpc(ids.outsider, 'get_lab', [labId])).rejects.toThrow(/not a member/);

    await rpc(ids.admin, 'invite_lab_member', [labId, 'r1@example.org', 'admin']);
    await rpc(ids.admin, 'invite_lab_member', [labId, 'r2@example.org', 'admin']);
    await rpc(ids.admin, 'invite_lab_member', [labId, 'outsider@example.org', 'member']);
    expect((await rpc<{ lab: { id: string } }[]>(ids.r2, 'list_my_lab_invites', [])).map((x) => x.lab.id)).toEqual([labId]);
    await expect(rpc(ids.r2, 'get_lab', [labId])).rejects.toThrow(/not a member/);
    await rpc(ids.r1, 'respond_lab_invite', [labId, true]);
    await rpc(ids.r2, 'respond_lab_invite', [labId, true]);
    await rpc(ids.outsider, 'respond_lab_invite', [labId, false]);

    // A forged labId in the document is ignored; only move_project_to_lab places a project in a lab.
    const cur = (await db.query<{ doc: Record<string, unknown>; version: number }>('select doc, version from public.projects where id = $1', [pid])).rows[0];
    await rpc(ids.admin, 'update_project', [JSON.stringify({ ...cur.doc, version: cur.version, labId })]);
    expect((await db.query<{ lab_id: string | null }>('select lab_id from public.projects where id = $1', [pid])).rows[0].lab_id).toBeNull();
    await expect(rpc(ids.outsider, 'move_project_to_lab', [pid, labId])).rejects.toThrow(/not a member/);
    await rpc(ids.admin, 'move_project_to_lab', [pid, labId]);

    const m = async (u: string) => (await db.query<{ role: string; active: boolean; via_lab: boolean }>('select role, active, via_lab from public.memberships where project_id = $1 and user_id = $2', [pid, u])).rows[0];
    expect(await m(ids.r2)).toEqual({ role: 'admin', active: true, via_lab: true });
    expect(await m(ids.r1)).toEqual({ role: 'adjudicator', active: true, via_lab: false });
    const view = await rpc<{ project: { labId?: string } }>(ids.r2, 'get_project_view', [pid]);
    expect(view.project.labId).toBe(labId);

    const detail = await rpc<{ members: { userId: string; email?: string }[]; projects: { id: string; myRole?: string }[] }>(ids.r1, 'get_lab', [labId]);
    expect(detail.members).toHaveLength(3);
    expect(detail.projects.find((x) => x.id === pid)?.myRole).toBe('adjudicator');

    await rpc(ids.admin, 'set_lab_member', [labId, ids.r2, 'member']);
    expect((await m(ids.r2)).active).toBe(false);
    await expect(rpc(ids.r1, 'set_lab_member', [labId, ids.admin, 'member'])).rejects.toThrow(/owner/);
    await expect(rpc(ids.admin, 'set_lab_member', [labId, ids.admin, 'member'])).rejects.toThrow(/at least one owner/);
    await expect(rpc(ids.admin, 'delete_lab', [labId])).rejects.toThrow(/Move the lab/);
    const audit = (await db.query<{ action: string }>("select action from public.audit where project_id = $1 and action like 'member.lab_%' order by id", [pid])).rows.map((r) => r.action);
    expect(audit).toEqual(['member.lab_grant', 'member.lab_revoke']);
  });

  it('serves the API to tokens within their scope and project only', async () => {
    const other = (await newProject('Not for this token')).id;
    const read = await rpc<{ token: string; record: { prefix: string; expiresAt: string } }>(ids.admin, 'create_api_token', ['reader', 'read', pid, 30]);
    expect(read.token).toMatch(/^agm_[0-9a-f]{64}$/);
    expect(read.record.prefix).toBe(read.token.slice(0, 12));
    expect((await db.query<{ n: number }>('select count(*)::int as n from public.api_tokens where token_hash = $1', [read.token])).rows[0].n).toBe(0);

    const v = await viaToken<{ items: unknown[] }>(read.token, 'get_project_view', [pid]);
    expect(v.items).toHaveLength(2);
    const listed = await viaToken<{ project: { id: string } }[]>(read.token, 'list_my_projects');
    expect(listed.map((x) => x.project.id)).toEqual([pid]);
    await expect(viaToken(read.token, 'get_project_view', [other])).rejects.toThrow(/not a member/);
    await expect(viaToken(read.token, 'import_items', [pid, '[]', '[]'])).rejects.toThrow(/cannot call import_items/);
    await expect(viaToken(read.token, 'create_api_token', ['x', 'write', null, 30])).rejects.toThrow(/cannot call/);
    await expect(viaToken('agm_' + '0'.repeat(64), 'list_my_projects')).rejects.toThrow(/Invalid/);

    const write = await rpc<{ token: string; record: { id: string } }>(ids.admin, 'create_api_token', ['writer', 'write', null, 30]);
    const n = await viaToken<number>(write.token, 'import_items', [other, JSON.stringify([{ externalId: 'API1', batch: '', category: '', fields: { text: 'from API' }, importedAt: '', seq: 1 }]), '[]']);
    expect(n).toBe(1);
    await expect(viaToken(write.token, 'move_project_to_lab', [other, labId])).rejects.toThrow(/cannot call/);
    await expect(rpc(ids.r1, 'create_api_token', ['x', 'read', other, 30])).rejects.toThrow(/not a member/);
    await expect(rpc(ids.admin, 'create_api_token', ['x', 'read', null, 400])).rejects.toThrow(/366/);

    await rpc(ids.admin, 'revoke_api_token', [write.record.id]);
    await expect(viaToken(write.token, 'list_my_projects')).rejects.toThrow(/revoked/);
    const mine = await rpc<{ name: string; revokedAt?: string; lastUsedAt?: string }[]>(ids.admin, 'list_api_tokens', []);
    expect(mine.find((t) => t.name === 'writer')?.revokedAt).toBeTruthy();
    expect(mine.find((t) => t.name === 'reader')?.lastUsedAt).toBeTruthy();
    await expect(rpc(ids.r1, 'revoke_api_token', [write.record.id])).rejects.toThrow(/Unknown token/);
  });

  it('reports status, an events feed without details, and published results', async () => {
    const st = await rpc<{ items: number; states: Record<string, number>; adjudicators: { pseudonym: string; assigned: number }[] }>(ids.admin, 'api_project_status', [pid]);
    expect(st.items).toBe(2);
    expect(st.adjudicators.map((a) => a.assigned)).toEqual([2]);
    await expect(rpc(ids.r1, 'api_project_status', [pid])).rejects.toThrow(/role/);
    const ev = await rpc<{ events: { id: number; action: string; actor?: string }[]; next: number }>(ids.admin, 'api_events', [pid, 0, 3]);
    expect(ev.events).toHaveLength(3);
    expect(ev.events.every((e) => !('detail' in e))).toBe(true);
    const more = await rpc<{ events: { id: number }[] }>(ids.admin, 'api_events', [pid, ev.next, 500]);
    expect(more.events.every((e) => e.id > ev.next)).toBe(true);

    await expect(rpc(ids.admin, 'api_results', [pid, null])).rejects.toThrow(/No results/);
    await rpc(ids.admin, 'publish_results', [pid, JSON.stringify({ final_classifications: [{ item_id: 'x', judgment: 'yes' }], reliability: [] }), 'first']);
    const res = await rpc<{ tables: Record<string, unknown[]>; note: string }>(ids.admin, 'api_results', [pid, 'final_classifications']);
    expect(Object.keys(res.tables)).toEqual(['final_classifications']);
    expect(res.note).toBe('first');
  });

  it('queues signed webhook deliveries that carry identifiers only', async () => {
    await expect(rpc(ids.admin, 'save_webhook', [pid, JSON.stringify({ url: 'http://insecure.example.org/hook', events: ['*'] })])).rejects.toThrow(/https/);
    await expect(rpc(ids.admin, 'save_webhook', [pid, JSON.stringify({ url: 'https://example.org/hook', events: ['nope'] })])).rejects.toThrow(/Unknown event/);
    const saved = await rpc<{ webhook: { id: string; secretPrefix: string }; secret: string }>(ids.admin, 'save_webhook', [pid, JSON.stringify({ url: 'https://example.org/hook', events: ['project.status', 'assessment.submit'] })]);
    expect(saved.secret).toMatch(/^whsec_/);
    expect(saved.webhook.secretPrefix).toBe(saved.secret.slice(0, 10));
    await rpc(ids.admin, 'set_project_status', [pid, 'active']);
    const items = (await rpc<{ items: { id: string }[] }>(ids.r1, 'get_project_view', [pid])).items;
    await rpc(ids.r1, 'save_assessment', [pid, items[0].id, JSON.stringify({ judgment: 'yes' }), 'private note', '', true, 0]);
    const rows = (await db.query<{ event: string; payload: Record<string, unknown> }>('select event, payload from public.webhook_deliveries where project_id = $1 order by id', [pid])).rows;
    expect(rows.map((r) => r.event)).toEqual(['project.status', 'assessment.submit']);
    expect(Object.keys(rows[1].payload).sort()).toEqual(['at', 'entity', 'entityId', 'event', 'id', 'projectId']);
    expect(JSON.stringify(rows[1].payload)).not.toMatch(/yes|private note/);
    const listed = await rpc<{ secretPrefix: string; url: string }[]>(ids.admin, 'list_webhooks', [pid]);
    expect(JSON.stringify(listed)).not.toContain(saved.secret);
    await expect(rpc(ids.r1, 'list_webhooks', [pid])).rejects.toThrow(/role/);
  });

  it('keeps the new tables closed to clients', async () => {
    for (const t of ['labs', 'lab_members', 'api_tokens', 'webhooks', 'webhook_deliveries', 'result_snapshots']) {
      await expect(as(ids.admin, `select * from public.${t}`)).rejects.toThrow(/permission denied/);
    }
  });
});

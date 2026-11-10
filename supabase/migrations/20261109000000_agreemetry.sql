-- Agreemetry: shared-server schema for Supabase (Postgres 15+).
--
-- Security model
--  * Row-level security is enabled on every table and NO table policy lets a client read or write raw rows,
--    except profiles (own row) and project_events (change signals for members, no content).
--  * Every read and write goes through SECURITY DEFINER functions below. They check membership and role,
--    apply blinding (blinded fields stripped, other adjudicators' judgments hidden until disclosure),
--    refuse silent overwrites of submitted judgments and final resolutions, and write the audit log.
--  * The rules mirror src/core (workflow.ts, policy.ts, resolution.ts); tests/sql.test.ts runs this file
--    in an embedded Postgres and checks the item states against the TypeScript implementation.
--  * Only the publishable (anon) key is used by the browser. Keep the service-role key out of the frontend.

-- Tables -------------------------------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key,
  display_name text not null,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id text primary key,
  doc jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.memberships (
  project_id text not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  role text not null check (role in ('admin', 'lead', 'adjudicator')),
  pseudonym text not null,
  active boolean not null default true,
  adjudicates boolean not null default false,
  primary key (project_id, user_id),
  unique (project_id, pseudonym)
);

create table if not exists public.invites (
  project_id text not null references public.projects (id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'lead', 'adjudicator')),
  display_name text,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (project_id, email)
);

create table if not exists public.items (
  id text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  external_id text not null,
  seq integer not null,
  doc jsonb not null,
  unique (project_id, external_id)
);
create index if not exists items_project on public.items (project_id);

create table if not exists public.assignments (
  project_id text not null references public.projects (id) on delete cascade,
  item_id text not null references public.items (id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (project_id, item_id, user_id)
);

create table if not exists public.contexts (
  project_id text not null references public.projects (id) on delete cascade,
  key text not null,
  title text not null,
  body text not null,
  primary key (project_id, key)
);

create table if not exists public.assessments (
  id text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  item_id text not null references public.items (id) on delete cascade,
  user_id uuid not null,
  status text not null check (status in ('draft', 'submitted')),
  version integer not null,
  doc jsonb not null,
  unique (item_id, user_id)
);
create index if not exists assessments_project on public.assessments (project_id, item_id);

create table if not exists public.resolutions (
  id text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  item_id text not null references public.items (id) on delete cascade,
  status text not null check (status in ('proposed', 'final', 'superseded')),
  version integer not null,
  doc jsonb not null
);
create index if not exists resolutions_item on public.resolutions (project_id, item_id);
-- At most one final resolution per item, enforced by the database.
create unique index if not exists one_final_per_item on public.resolutions (item_id) where status = 'final';

create table if not exists public.discussions (
  id text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  item_id text not null,
  doc jsonb not null
);

create table if not exists public.escalations (
  id text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  item_id text not null,
  open boolean not null default true,
  doc jsonb not null
);

create table if not exists public.audit (
  id bigserial primary key,
  project_id text not null,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,
  entity text not null,
  entity_id text not null,
  detail jsonb
);
create index if not exists audit_project on public.audit (project_id, at);

create table if not exists public.project_events (
  id bigserial primary key,
  project_id text not null,
  at timestamptz not null default now()
);

-- The audit log is append-only, even for table owners using the API.
create or replace function public.agm_no_change() returns trigger language plpgsql as $$
begin
  raise exception 'The audit log is append-only';
end $$;
drop trigger if exists audit_append_only on public.audit;
create trigger audit_append_only before update or delete on public.audit for each row execute function public.agm_no_change();

-- Final resolutions and submitted judgments can only move forward through the functions below.
create or replace function public.agm_guard_resolution() returns trigger language plpgsql as $$
begin
  if old.status = 'final' and new.status not in ('final', 'superseded') then
    raise exception 'A final resolution can only be superseded by reopening';
  end if;
  if old.status = 'superseded' and new.status <> 'superseded' then
    raise exception 'A superseded resolution cannot change';
  end if;
  return new;
end $$;
drop trigger if exists resolution_guard on public.resolutions;
create trigger resolution_guard before update on public.resolutions for each row execute function public.agm_guard_resolution();

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.memberships enable row level security;
alter table public.invites enable row level security;
alter table public.items enable row level security;
alter table public.assignments enable row level security;
alter table public.contexts enable row level security;
alter table public.assessments enable row level security;
alter table public.resolutions enable row level security;
alter table public.discussions enable row level security;
alter table public.escalations enable row level security;
alter table public.audit enable row level security;
alter table public.project_events enable row level security;

drop policy if exists own_profile on public.profiles;
create policy own_profile on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists member_events on public.project_events;
create or replace function public.agm_is_member(p text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m where m.project_id = p and m.user_id = auth.uid() and m.active)
$$;
create policy member_events on public.project_events for select to authenticated using (public.agm_is_member(project_id));

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.project_events to authenticated;

-- New accounts get a profile (Supabase auth.users trigger).
create or replace function public.agm_handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, email) values (new.id, coalesce(split_part(new.email, '@', 1), 'member'), new.email)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.agm_handle_new_user();

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.project_events;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- Helpers ---------------------------------------------------------------------------------------------

create or replace function public.agm_new_id(prefix text) returns text language sql volatile as $$
  select prefix || '_' || replace(gen_random_uuid()::text, '-', '')
$$;

create or replace function public.agm_now() returns text language sql stable as $$
  select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create or replace function public.agm_role(p text, u uuid) returns text language sql stable security definer set search_path = public as $$
  select role from public.memberships where project_id = p and user_id = u and active
$$;

create or replace function public.agm_require_role(p text, roles text[]) returns text language plpgsql stable security definer set search_path = public as $$
declare r text := public.agm_role(p, auth.uid());
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if r is null then raise exception 'You are not a member of this project' using errcode = '42501'; end if;
  if not (r = any (roles)) then raise exception 'Your role (%) cannot do this', r using errcode = '42501'; end if;
  return r;
end $$;

create or replace function public.agm_audit(p text, act text, ent text, ent_id text, det jsonb default null) returns void language sql security definer set search_path = public as $$
  insert into public.audit (project_id, user_id, action, entity, entity_id, detail) values (p, auth.uid(), act, ent, ent_id, det);
  insert into public.project_events (project_id) values (p);
$$;

create or replace function public.agm_cfg(p text) returns jsonb language sql stable security definer set search_path = public as $$
  select doc -> 'config' from public.projects where id = p
$$;

-- Agreement (mirrors compareVariable in src/core/workflow.ts) ---------------------------------------------

create or replace function public.agm_meets(modal integer, n integer, cfg jsonb) returns boolean language sql immutable as $$
  select case
    when modal = n then true
    when coalesce(cfg ->> 'rule', 'unanimous') = 'unanimous' then false
    when cfg ->> 'rule' = 'majority' then modal * 2 > n
    else modal::numeric / n >= coalesce((cfg ->> 'threshold')::numeric, 1) - 1e-12
  end
$$;

create or replace function public.agm_outcome(v jsonb, vals jsonb[], cfg jsonb) returns text language plpgsql immutable as $$
declare
  n integer := coalesce(cardinality(vals), 0);
  typ text := v ->> 'type';
  nums numeric[];
  tol numeric := coalesce((cfg ->> 'numericTolerance')::numeric, 0);
  missing integer;
  best integer := 0;
  i integer;
  j integer := 1;
  modal integer;
  tops integer;
  lab text;
  yes integer;
  worst text := 'unanimous';
begin
  if n = 0 then return 'split'; end if;
  if typ = 'numeric' then
    select array_agg(x order by x) into nums from (select (e #>> '{}')::numeric as x from unnest(vals) e where e is not null and jsonb_typeof(e) = 'number') s;
    missing := n - coalesce(cardinality(nums), 0);
    for i in 1 .. coalesce(cardinality(nums), 0) loop
      while nums[i] - nums[j] > tol + 1e-12 loop j := j + 1; end loop;
      if i - j + 1 > best then best := i - j + 1; end if;
    end loop;
    modal := greatest(best, missing);
    if modal = n then return 'unanimous'; end if;
    return case when public.agm_meets(modal, n, cfg) then 'rule' else 'split' end;
  end if;
  if typ = 'multilabel' and coalesce(cfg ->> 'multilabelMode', 'per_label') = 'per_label' then
    for lab in select c ->> 'value' from jsonb_array_elements(coalesce(v -> 'categories', '[]'::jsonb)) c loop
      select count(*) into yes from unnest(vals) e where e is not null and jsonb_typeof(e) = 'array' and e ? lab;
      modal := greatest(yes, n - yes);
      if modal = n then continue; end if;
      if public.agm_meets(modal, n, cfg) then
        if worst = 'unanimous' then worst := 'rule'; end if;
      else
        return 'split';
      end if;
    end loop;
    return worst;
  end if;
  with k as (
    select case
      when e is null or jsonb_typeof(e) = 'null' or e = '""'::jsonb then '__missing__'
      when jsonb_typeof(e) = 'array' then (select coalesce(string_agg(x, chr(31) order by x), '') from jsonb_array_elements_text(e) x)
      else e #>> '{}' end as key
    from unnest(vals) e
  ), c as (select key, count(*)::integer as cnt from k group by key)
  select max(cnt), count(*) filter (where cnt = (select max(cnt) from c)) into modal, tops from c;
  if modal = n then return 'unanimous'; end if;
  if tops > 1 then return 'split'; end if;
  return case when public.agm_meets(modal, n, cfg) then 'rule' else 'split' end;
end $$;

do $$ begin
  create type public.agm_status as (item_id text, assigned uuid[], submitted uuid[], required integer, state text, disputed text[]);
exception when duplicate_object then null;
end $$;

-- Item states (mirrors computeItemStatus).
create or replace function public.agm_item_status(p text) returns setof public.agm_status language plpgsql stable security definer set search_path = public as $$
declare
  cfg jsonb := public.agm_cfg(p);
  mode text;
  req integer;
  adj uuid[];
  r record;
  v jsonb;
  vals jsonb[];
  s public.agm_status;
  has_final boolean;
  has_esc boolean;
  has_prop boolean;
begin
  if cfg is null then raise exception 'Unknown project'; end if;
  mode := coalesce(cfg -> 'assignment' ->> 'mode', 'all');
  req := greatest(1, coalesce((cfg ->> 'requiredAdjudicators')::integer, 1));
  select coalesce(array_agg(m.user_id), '{}') into adj from public.memberships m where m.project_id = p and m.active and (m.role = 'adjudicator' or m.adjudicates);
  for r in
    select i.id,
      coalesce((select array_agg(a.user_id) from public.assessments a where a.project_id = p and a.item_id = i.id and a.status = 'submitted'), '{}') as subs,
      coalesce((select array_agg(x.user_id) from public.assignments x where x.project_id = p and x.item_id = i.id), '{}') as asg
    from public.items i where i.project_id = p order by i.seq
  loop
    s.item_id := r.id;
    s.submitted := r.subs;
    s.required := req;
    s.assigned := array(select distinct u from unnest((case when mode = 'all' then adj else r.asg end) || r.subs) u);
    s.disputed := '{}';
    if cardinality(s.assigned) = 0 and cardinality(r.subs) = 0 then
      s.state := 'unassigned';
    elsif cardinality(r.subs) < req then
      s.state := case when cardinality(r.subs) = 0 then 'awaiting' else 'in_progress' end;
    else
      for v in select e from jsonb_array_elements(cfg -> 'variables') e where e ->> 'type' <> 'text' and coalesce((e ->> 'includeInAgreement')::boolean, true) loop
        select array_agg(a.doc -> 'values' -> (v ->> 'id')) into vals from public.assessments a where a.project_id = p and a.item_id = r.id and a.status = 'submitted';
        if public.agm_outcome(v, vals, cfg -> 'agreement') = 'split' then s.disputed := s.disputed || (v ->> 'id'); end if;
      end loop;
      select exists (select 1 from public.resolutions z where z.item_id = r.id and z.status = 'final'),
             exists (select 1 from public.escalations z where z.item_id = r.id and z.open),
             exists (select 1 from public.resolutions z where z.item_id = r.id and z.status = 'proposed')
        into has_final, has_esc, has_prop;
      s.state := case when has_final then 'resolved' when cardinality(s.disputed) = 0 then 'agreed' when has_esc then 'escalated' when has_prop then 'proposed' else 'disagreement' end;
    end if;
    return next s;
  end loop;
end $$;

create or replace function public.agm_disclosed(cfg jsonb, s public.agm_status, all_complete boolean) returns boolean language sql immutable as $$
  select cardinality(s.submitted) >= s.required and case coalesce(cfg ->> 'disclosure', 'item_complete')
    when 'item_complete' then true
    when 'manual' then coalesce((cfg ->> 'disclosed')::boolean, false)
    else all_complete end
$$;

create or replace function public.agm_all_complete(sts public.agm_status[]) returns boolean language sql immutable as $$
  select not exists (select 1 from unnest(sts) s where s.state <> 'unassigned' and cardinality(s.submitted) < s.required)
$$;

-- Reading a project (mirrors viewFor in src/core/policy.ts) ---------------------------------------------------

create or replace function public.get_project_view(p text) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_role text := public.agm_require_role(p, array['admin', 'lead', 'adjudicator']);
  pr record;
  cfg jsonb;
  blinded text[];
  sts public.agm_status[];
  allc boolean;
  result jsonb;
begin
  select * into pr from public.projects where id = p;
  cfg := pr.doc -> 'config';
  sts := array(select public.agm_item_status(p));
  allc := public.agm_all_complete(sts);
  if my_role = 'admin' then
    return jsonb_build_object(
      'project', pr.doc || jsonb_build_object('status', pr.status, 'version', pr.version),
      'memberships', coalesce((select jsonb_agg(jsonb_build_object('projectId', m.project_id, 'userId', m.user_id, 'role', m.role, 'pseudonym', m.pseudonym, 'active', m.active, 'adjudicates', m.adjudicates)) from public.memberships m where m.project_id = p), '[]'),
      'users', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'displayName', u.display_name, 'email', u.email, 'active', u.active, 'createdAt', u.created_at)) from public.profiles u where u.id in (select user_id from public.memberships where project_id = p)), '[]'),
      'items', coalesce((select jsonb_agg(i.doc order by i.seq) from public.items i where i.project_id = p), '[]'),
      'assignments', coalesce((select jsonb_agg(jsonb_build_object('projectId', a.project_id, 'itemId', a.item_id, 'userId', a.user_id, 'createdAt', a.created_at)) from public.assignments a where a.project_id = p), '[]'),
      'contexts', coalesce((select jsonb_agg(jsonb_build_object('projectId', c.project_id, 'key', c.key, 'title', c.title, 'body', c.body)) from public.contexts c where c.project_id = p), '[]'),
      'assessments', coalesce((select jsonb_agg(a.doc) from public.assessments a where a.project_id = p), '[]'),
      'resolutions', coalesce((select jsonb_agg(r.doc || jsonb_build_object('status', r.status)) from public.resolutions r where r.project_id = p), '[]'),
      'discussions', coalesce((select jsonb_agg(d.doc) from public.discussions d where d.project_id = p), '[]'),
      'escalations', coalesce((select jsonb_agg(e.doc || jsonb_build_object('open', e.open)) from public.escalations e where e.project_id = p), '[]'),
      'audit', coalesce((select jsonb_agg(jsonb_build_object('id', x.id::text, 'projectId', x.project_id, 'at', x.at, 'userId', x.user_id, 'action', x.action, 'entity', x.entity, 'entityId', x.entity_id, 'detail', x.detail) order by x.at) from public.audit x where x.project_id = p), '[]')
    );
  end if;
  blinded := array(select jsonb_array_elements_text(coalesce(cfg -> 'display' -> 'blindedFields', '[]'::jsonb)));
  with st as (select * from unnest(sts)),
  vis as (select st.* from st where my_role = 'lead' or me = any (st.assigned) or me = any (st.submitted)),
  opened as (select vis.item_id, public.agm_disclosed(cfg, vis::public.agm_status, allc) and (not (me = any (vis.assigned)) or me = any (vis.submitted) or my_role = 'lead') as open from vis)
  select jsonb_build_object(
    'project', (pr.doc || jsonb_build_object('status', pr.status, 'version', pr.version,
      'documents', coalesce((select jsonb_agg(d) from jsonb_array_elements(pr.doc -> 'documents') d where d ->> 'audience' = 'all'), '[]')))
      #- '{provenance}',
    'memberships', coalesce((select jsonb_agg(jsonb_build_object('projectId', m.project_id, 'userId', m.user_id, 'role', m.role, 'pseudonym', m.pseudonym, 'active', m.active, 'adjudicates', m.adjudicates)) from public.memberships m where m.project_id = p), '[]'),
    'users', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'displayName', u.display_name, 'email', u.email, 'active', u.active, 'createdAt', u.created_at)) from public.profiles u where u.id = me), '[]'),
    'items', coalesce((select jsonb_agg(i.doc || jsonb_build_object('fields', (i.doc -> 'fields') - blinded) order by i.seq) from public.items i join vis on vis.item_id = i.id), '[]'),
    'assignments', coalesce((select jsonb_agg(jsonb_build_object('projectId', a.project_id, 'itemId', a.item_id, 'userId', a.user_id, 'createdAt', a.created_at)) from public.assignments a where a.project_id = p and (a.user_id = me or my_role = 'lead')), '[]'),
    'contexts', coalesce((select jsonb_agg(jsonb_build_object('projectId', c.project_id, 'key', c.key, 'title', c.title, 'body', c.body)) from public.contexts c where c.project_id = p), '[]'),
    'assessments', coalesce((select jsonb_agg(a.doc) from public.assessments a join vis on vis.item_id = a.item_id join opened o on o.item_id = a.item_id
        where a.user_id = me or (a.status = 'submitted' and public.agm_disclosed(cfg, vis::public.agm_status, allc)
          and (not (me = any (vis.assigned)) or me = any (vis.submitted)) and (my_role = 'lead' or me = any (vis.assigned)))), '[]'),
    'resolutions', coalesce((select jsonb_agg(r.doc || jsonb_build_object('status', r.status)) from public.resolutions r join opened o on o.item_id = r.item_id and o.open), '[]'),
    'discussions', coalesce((select jsonb_agg(d.doc) from public.discussions d join opened o on o.item_id = d.item_id and o.open), '[]'),
    'escalations', coalesce((select jsonb_agg(e.doc || jsonb_build_object('open', e.open)) from public.escalations e join opened o on o.item_id = e.item_id and o.open), '[]'),
    'audit', '[]'::jsonb,
    'serverStatus', coalesce((select jsonb_object_agg(vis.item_id, jsonb_build_object(
        'itemId', vis.item_id,
        'submitted', case when o.open then cardinality(vis.submitted) when me = any (vis.submitted) then 1 else 0 end,
        'required', vis.required,
        'state', case when o.open then vis.state when vis.state = 'unassigned' then 'unassigned' when me = any (vis.submitted) then 'in_progress' else 'awaiting' end,
        'disputedVariables', case when o.open then to_jsonb(vis.disputed) else '[]'::jsonb end))
      from vis join opened o on o.item_id = vis.item_id), '{}')
  ) into result;
  return result;
end $$;

create or replace function public.list_my_projects() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'project', p.doc || jsonb_build_object('status', p.status, 'version', p.version),
    'role', m.role,
    'items', case when m.role in ('admin', 'lead') or coalesce(p.doc -> 'config' -> 'assignment' ->> 'mode', 'all') = 'all'
      then (select count(*) from public.items i where i.project_id = p.id)
      else (select count(*) from public.assignments a where a.project_id = p.id and a.user_id = auth.uid()) end)
    order by p.updated_at desc), '[]')
  from public.memberships m join public.projects p on p.id = m.project_id
  where m.user_id = auth.uid() and m.active
$$;

-- Validation (mirrors validateValues in src/data/service.ts) ------------------------------------------------

create or replace function public.agm_validate(vars jsonb, vals jsonb, require_all boolean) returns text[] language plpgsql immutable as $$
declare v jsonb; x jsonb; errs text[] := '{}'; codes text[]; k text;
begin
  for v in select * from jsonb_array_elements(vars) loop
    x := vals -> (v ->> 'id');
    if x is null or jsonb_typeof(x) = 'null' or x = '""'::jsonb then
      if require_all and coalesce((v ->> 'required')::boolean, false) then errs := errs || format('"%s" is required.', v ->> 'label'); end if;
      continue;
    end if;
    codes := array(select c ->> 'value' from jsonb_array_elements(coalesce(v -> 'categories', '[]'::jsonb)) c);
    case v ->> 'type'
      when 'binary', 'nominal', 'ordinal' then
        if jsonb_typeof(x) <> 'string' or not ((x #>> '{}') = any (codes)) then errs := errs || format('"%s": not a defined category.', v ->> 'label'); end if;
      when 'multilabel' then
        if jsonb_typeof(x) <> 'array' or exists (select 1 from jsonb_array_elements_text(x) e where not (e = any (codes))) then errs := errs || format('"%s": unknown label.', v ->> 'label'); end if;
      when 'numeric' then
        if jsonb_typeof(x) <> 'number' then errs := errs || format('"%s" must be a number.', v ->> 'label');
        elsif (v ? 'min' and (x #>> '{}')::numeric < (v ->> 'min')::numeric) or (v ? 'max' and (x #>> '{}')::numeric > (v ->> 'max')::numeric) then errs := errs || format('"%s" is out of range.', v ->> 'label'); end if;
      when 'text' then
        if jsonb_typeof(x) <> 'string' then errs := errs || format('"%s" must be text.', v ->> 'label'); end if;
      else null;
    end case;
  end loop;
  for k in select jsonb_object_keys(vals) loop
    if not exists (select 1 from jsonb_array_elements(vars) e where e ->> 'id' = k) then errs := errs || format('Unknown variable "%s".', k); end if;
  end loop;
  return errs;
end $$;

-- Projects and team ---------------------------------------------------------------------------------------

create or replace function public.create_project(p_doc jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare pid text := public.agm_new_id('p'); d jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  insert into public.profiles (id, display_name) values (auth.uid(), 'member') on conflict do nothing;
  d := p_doc || jsonb_build_object('id', pid, 'createdAt', public.agm_now(), 'updatedAt', public.agm_now(), 'version', 1);
  insert into public.projects (id, doc, status) values (pid, d, coalesce(p_doc ->> 'status', 'draft'));
  insert into public.memberships (project_id, user_id, role, pseudonym, active, adjudicates) values (pid, auth.uid(), 'admin', 'ADM1', true, false);
  perform public.agm_audit(pid, 'project.create', 'project', pid, jsonb_build_object('template', p_doc ->> 'template'));
  return d || jsonb_build_object('status', coalesce(p_doc ->> 'status', 'draft'));
end $$;

create or replace function public.update_project(p_doc jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare p text := p_doc ->> 'id'; cur record; issues text[] := '{}'; k text; vals text[]; nv jsonb; ov jsonb;
begin
  perform public.agm_require_role(p, array['admin']);
  select * into cur from public.projects where id = p for update;
  if cur.version <> (p_doc ->> 'version')::integer then raise exception 'The project was changed by someone else. Reload and apply your change again.' using errcode = '40001'; end if;
  -- Judgments in use must stay valid.
  for k in select distinct jsonb_object_keys(a.doc -> 'values') from public.assessments a where a.project_id = p loop
    nv := (select e from jsonb_array_elements(p_doc -> 'config' -> 'variables') e where e ->> 'id' = k);
    ov := (select e from jsonb_array_elements(cur.doc -> 'config' -> 'variables') e where e ->> 'id' = k);
    if nv is null then issues := issues || format('Variable "%s" has recorded judgments and cannot be removed.', k); continue; end if;
    if ov is not null and ov ->> 'type' <> nv ->> 'type' then issues := issues || format('Variable "%s" has judgments; its type cannot change.', k); end if;
    if nv ->> 'type' in ('binary', 'nominal', 'ordinal', 'multilabel') then
      vals := array(select distinct q.x from public.assessments a,
        lateral jsonb_array_elements_text(case when jsonb_typeof(a.doc -> 'values' -> k) = 'array' then a.doc -> 'values' -> k else jsonb_build_array(a.doc -> 'values' -> k) end) q(x)
        where a.project_id = p and q.x is not null and q.x <> '');
      if exists (select 1 from unnest(vals) x where not exists (select 1 from jsonb_array_elements(nv -> 'categories') c where c ->> 'value' = x)) then
        issues := issues || format('A category code of "%s" is in use and cannot be removed or renamed.', k);
      end if;
    end if;
  end loop;
  if coalesce((p_doc -> 'config' ->> 'requiredAdjudicators')::integer, 0) < 1 then issues := issues || 'At least one independent judgment per item is required.'; end if;
  if cardinality(issues) > 0 then raise exception 'The configuration cannot be saved: %', array_to_string(issues, ' ') using errcode = '22023'; end if;
  update public.projects set doc = p_doc || jsonb_build_object('id', p, 'createdAt', cur.doc -> 'createdAt', 'updatedAt', public.agm_now(), 'version', cur.version + 1),
    status = coalesce(p_doc ->> 'status', cur.status), version = cur.version + 1, updated_at = now() where id = p;
  perform public.agm_audit(p, 'project.update', 'project', p, null);
  return (select x.doc || jsonb_build_object('status', x.status, 'version', x.version) from public.projects x where x.id = p);
end $$;

create or replace function public.set_project_status(p text, s text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.agm_require_role(p, array['admin']);
  update public.projects set status = s, version = version + 1, updated_at = now(), doc = doc || jsonb_build_object('status', s, 'updatedAt', public.agm_now()) where id = p;
  perform public.agm_audit(p, 'project.status', 'project', p, jsonb_build_object('to', s));
end $$;

create or replace function public.delete_project(p text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.agm_require_role(p, array['admin']);
  if exists (select 1 from public.assessments where project_id = p and status = 'submitted') then raise exception 'A project with submitted judgments cannot be deleted; archive it instead.'; end if;
  delete from public.projects where id = p;
end $$;

create or replace function public.duplicate_project(p text, with_items boolean) returns jsonb language plpgsql security definer set search_path = public as $$
declare src record; nid text := public.agm_new_id('p'); d jsonb;
begin
  perform public.agm_require_role(p, array['admin']);
  select * into src from public.projects where id = p;
  d := src.doc || jsonb_build_object('id', nid, 'name', (src.doc ->> 'name') || ' (copy)', 'status', 'draft', 'version', 1, 'createdAt', public.agm_now(), 'updatedAt', public.agm_now());
  d := jsonb_set(d, '{config,disclosed}', 'false');
  insert into public.projects (id, doc, status) values (nid, d, 'draft');
  insert into public.memberships values (nid, auth.uid(), 'admin', 'ADM1', true, false);
  if with_items then
    insert into public.items (id, project_id, external_id, seq, doc)
      select public.agm_new_id('it'), nid, external_id, seq, doc from public.items where project_id = p;
    update public.items set doc = doc || jsonb_build_object('id', id, 'projectId', nid) where project_id = nid;
    insert into public.contexts select nid, key, title, body from public.contexts where project_id = p;
  end if;
  perform public.agm_audit(nid, 'project.duplicate', 'project', nid, jsonb_build_object('from', p, 'withItems', with_items));
  return d;
end $$;

create or replace function public.upsert_membership(p text, u uuid, r text, pseudo text, act boolean, adj boolean) returns void language plpgsql security definer set search_path = public as $$
declare ps text := nullif(trim(pseudo), ''); prefix text; i integer := 1; admins integer;
begin
  perform public.agm_require_role(p, array['admin']);
  if not exists (select 1 from public.profiles where id = u) then raise exception 'Unknown user'; end if;
  select count(*) into admins from public.memberships where project_id = p and role = 'admin' and active and user_id <> u;
  if admins = 0 and (r <> 'admin' or not act) and exists (select 1 from public.memberships where project_id = p and user_id = u and role = 'admin') then
    raise exception 'A project needs at least one active administrator.';
  end if;
  if ps is null or exists (select 1 from public.memberships where project_id = p and pseudonym = ps and user_id <> u) then
    select pseudonym into ps from public.memberships where project_id = p and user_id = u;
    if ps is null then
      prefix := case r when 'admin' then 'ADM' when 'lead' then 'L' else 'R' end;
      while exists (select 1 from public.memberships where project_id = p and pseudonym = prefix || i) loop i := i + 1; end loop;
      ps := prefix || i;
    end if;
  end if;
  insert into public.memberships (project_id, user_id, role, pseudonym, active, adjudicates) values (p, u, r, ps, act, case when r = 'adjudicator' then true else adj end)
    on conflict (project_id, user_id) do update set role = excluded.role, pseudonym = excluded.pseudonym, active = excluded.active, adjudicates = excluded.adjudicates;
  perform public.agm_audit(p, 'member.upsert', 'membership', u::text, jsonb_build_object('role', r, 'active', act, 'pseudonym', ps));
end $$;

-- Invite by email: becomes a membership now if the account exists, otherwise at first sign-in.
create or replace function public.invite_member(p text, mail text, r text, name text) returns text language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  perform public.agm_require_role(p, array['admin']);
  select id into u from public.profiles where lower(email) = lower(mail);
  if u is not null then
    perform public.upsert_membership(p, u, r, '', true, r = 'adjudicator');
    return u::text;
  end if;
  insert into public.invites (project_id, email, role, display_name, created_by) values (p, lower(mail), r, name, auth.uid())
    on conflict (project_id, email) do update set role = excluded.role, display_name = excluded.display_name;
  perform public.agm_audit(p, 'member.invite', 'invite', lower(mail), jsonb_build_object('role', r));
  return null;
end $$;

create or replace function public.accept_invites() returns integer language plpgsql security definer set search_path = public as $$
declare iv record; n integer := 0; mail text := lower(coalesce(auth.jwt() ->> 'email', ''));
  prefix text; i integer;
begin
  if auth.uid() is null or mail = '' then return 0; end if;
  insert into public.profiles (id, display_name, email) values (auth.uid(), split_part(mail, '@', 1), mail) on conflict (id) do update set email = excluded.email;
  for iv in select * from public.invites where email = mail loop
    if iv.display_name is not null then update public.profiles set display_name = iv.display_name where id = auth.uid() and display_name = split_part(mail, '@', 1); end if;
    prefix := case iv.role when 'admin' then 'ADM' when 'lead' then 'L' else 'R' end;
    i := 1;
    while exists (select 1 from public.memberships where project_id = iv.project_id and pseudonym = prefix || i) loop i := i + 1; end loop;
    insert into public.memberships values (iv.project_id, auth.uid(), iv.role, prefix || i, true, iv.role = 'adjudicator') on conflict do nothing;
    delete from public.invites where project_id = iv.project_id and email = mail;
    perform public.agm_audit(iv.project_id, 'member.accept_invite', 'membership', auth.uid()::text, null);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.update_profile(name text) returns void language sql security definer set search_path = public as $$
  update public.profiles set display_name = coalesce(nullif(trim(name), ''), display_name) where id = auth.uid();
$$;

create or replace function public.list_colleagues() returns jsonb language sql stable security definer set search_path = public as $$
  -- Administrators may see the names of members of projects they administer.
  select coalesce(jsonb_agg(distinct jsonb_build_object('id', u.id, 'displayName', u.display_name, 'email', u.email, 'active', u.active, 'createdAt', u.created_at)), '[]')
  from public.profiles u
  where u.id = auth.uid() or u.id in (select m2.user_id from public.memberships m join public.memberships m2 on m2.project_id = m.project_id where m.user_id = auth.uid() and m.role = 'admin' and m.active)
$$;

-- Items -------------------------------------------------------------------------------------------------

create or replace function public.import_items(p text, p_items jsonb, p_contexts jsonb) returns integer language plpgsql security definer set search_path = public as $$
declare start integer;
begin
  perform public.agm_require_role(p, array['admin']);
  select coalesce(max(seq), 0) into start from public.items where project_id = p;
  if exists (select 1 from jsonb_array_elements(p_items) e join public.items i on i.project_id = p and i.external_id = e ->> 'externalId') then
    raise exception 'Some identifiers already exist in this project.';
  end if;
  insert into public.items (id, project_id, external_id, seq, doc)
    select coalesce(e ->> 'id', public.agm_new_id('it')), p, e ->> 'externalId', start + o::integer, e || jsonb_build_object('projectId', p, 'seq', start + o::integer)
    from jsonb_array_elements(p_items) with ordinality t(e, o);
  update public.items set doc = doc || jsonb_build_object('id', id) where project_id = p and doc ->> 'id' is distinct from id;
  insert into public.contexts (project_id, key, title, body)
    select p, c ->> 'key', coalesce(c ->> 'title', c ->> 'key'), coalesce(c ->> 'body', '') from jsonb_array_elements(coalesce(p_contexts, '[]'::jsonb)) c
    on conflict (project_id, key) do update set title = excluded.title, body = excluded.body;
  perform public.agm_audit(p, 'items.import', 'project', p, jsonb_build_object('items', jsonb_array_length(p_items), 'contexts', jsonb_array_length(coalesce(p_contexts, '[]'::jsonb))));
  return jsonb_array_length(p_items);
end $$;

create or replace function public.delete_items(p text, ids text[]) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.agm_require_role(p, array['admin']);
  if exists (select 1 from public.assessments where project_id = p and item_id = any (ids)) then raise exception 'Items with assessments cannot be deleted.'; end if;
  delete from public.items where project_id = p and id = any (ids);
  perform public.agm_audit(p, 'items.delete', 'project', p, jsonb_build_object('items', cardinality(ids)));
end $$;

create or replace function public.add_assignments(p text, p_rows jsonb) returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform public.agm_require_role(p, array['admin']);
  insert into public.assignments (project_id, item_id, user_id)
    select p, r ->> 'itemId', (r ->> 'userId')::uuid from jsonb_array_elements(p_rows) r on conflict do nothing;
  get diagnostics n = row_count;
  perform public.agm_audit(p, 'assignments.generate', 'project', p, jsonb_build_object('added', n));
  return n;
end $$;

-- Assessments ----------------------------------------------------------------------------------------------

create or replace function public.save_assessment(p text, item text, vals jsonb, p_comment text, p_evidence text, submit boolean, expected integer) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  pr record;
  st public.agm_status;
  cur record;
  errs text[];
  d jsonb;
  hist jsonb;
  v integer;
  now_ text := public.agm_now();
begin
  perform public.agm_require_role(p, array['admin', 'lead', 'adjudicator']);
  select * into pr from public.projects where id = p;
  if pr.status <> 'active' then raise exception 'The project is not active.' using errcode = '42501'; end if;
  select * into st from public.agm_item_status(p) s where s.item_id = item;
  if st.item_id is null or not (me = any (st.assigned)) then raise exception 'This item is not assigned to you.' using errcode = '42501'; end if;
  if st.state = 'resolved' then raise exception 'This item is finalized.' using errcode = '42501'; end if;
  select * into cur from public.assessments where item_id = item and user_id = me for update;
  if coalesce(cur.version, 0) <> expected then raise exception 'This assessment changed in another window. Reload to see the latest version.' using errcode = '40001'; end if;
  if cur.status = 'submitted' then raise exception 'This judgment is submitted. Reopen it first.' using errcode = '42501'; end if;
  errs := public.agm_validate(pr.doc -> 'config' -> 'variables', vals, submit);
  if cardinality(errs) > 0 then raise exception '%', array_to_string(errs, ' ') using errcode = '22023'; end if;
  v := coalesce(cur.version, 0) + 1;
  hist := coalesce(cur.doc -> 'history', '[]'::jsonb);
  if submit then hist := hist || jsonb_build_array(jsonb_build_object('version', v, 'values', vals, 'comment', p_comment, 'evidence', p_evidence, 'status', 'submitted', 'at', now_)); end if;
  d := jsonb_build_object('id', coalesce(cur.id, public.agm_new_id('as')), 'projectId', p, 'itemId', item, 'userId', me, 'values', vals, 'comment', coalesce(p_comment, ''), 'evidence', coalesce(p_evidence, ''),
    'status', case when submit then 'submitted' else 'draft' end, 'version', v, 'createdAt', coalesce(cur.doc ->> 'createdAt', now_), 'updatedAt', now_, 'history', hist)
    || case when submit then jsonb_build_object('submittedAt', now_) else '{}'::jsonb end;
  insert into public.assessments (id, project_id, item_id, user_id, status, version, doc) values (d ->> 'id', p, item, me, d ->> 'status', v, d)
    on conflict (item_id, user_id) do update set status = excluded.status, version = excluded.version, doc = excluded.doc;
  if submit then perform public.agm_audit(p, 'assessment.submit', 'assessment', d ->> 'id', jsonb_build_object('item', item, 'version', v));
  else insert into public.project_events (project_id) values (p); end if;
  return d;
end $$;

create or replace function public.reopen_assessment(p text, aid text, reason text) returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a record; cfg jsonb := public.agm_cfg(p); sts public.agm_status[]; st public.agm_status; d jsonb; now_ text := public.agm_now();
begin
  perform public.agm_require_role(p, array['admin', 'lead', 'adjudicator']);
  select * into a from public.assessments where id = aid and project_id = p for update;
  if a.id is null or a.user_id <> me then raise exception 'You can reopen only your own judgment.' using errcode = '42501'; end if;
  if a.status <> 'submitted' then raise exception 'Only a submitted judgment can be reopened.'; end if;
  if not coalesce((cfg ->> 'allowAmendBeforeDisclosure')::boolean, false) then raise exception 'This project does not allow amending submitted judgments.' using errcode = '42501'; end if;
  sts := array(select public.agm_item_status(p));
  select * into st from unnest(sts) s where s.item_id = a.item_id;
  if public.agm_disclosed(cfg, st, public.agm_all_complete(sts)) then raise exception 'Judgments on this item are disclosed; the original stands.' using errcode = '42501'; end if;
  if coalesce(trim(reason), '') = '' then raise exception 'Give a reason for reopening.'; end if;
  d := a.doc || jsonb_build_object('status', 'draft', 'version', a.version + 1, 'updatedAt', now_,
    'history', (a.doc -> 'history') || jsonb_build_array(jsonb_build_object('version', a.version + 1, 'values', a.doc -> 'values', 'comment', a.doc -> 'comment', 'evidence', a.doc -> 'evidence', 'status', 'draft', 'at', now_, 'reason', reason)));
  update public.assessments set status = 'draft', version = a.version + 1, doc = d where id = aid;
  perform public.agm_audit(p, 'assessment.reopen', 'assessment', aid, jsonb_build_object('item', a.item_id, 'reason', reason));
  return d;
end $$;

-- Resolution (mirrors src/core/resolution.ts and assertCanResolve) --------------------------------------------

create or replace function public.agm_can_resolve(p text, item text) returns public.agm_status language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r text := public.agm_require_role(p, array['admin', 'lead', 'adjudicator']); cfg jsonb := public.agm_cfg(p); sts public.agm_status[]; st public.agm_status;
begin
  sts := array(select public.agm_item_status(p));
  select * into st from unnest(sts) s where s.item_id = item;
  if st.item_id is null then raise exception 'Unknown item.'; end if;
  if cardinality(st.disputed) = 0 then raise exception 'This item has no disagreement to resolve.'; end if;
  if r in ('admin', 'lead') then return st; end if;
  if not public.agm_disclosed(cfg, st, public.agm_all_complete(sts)) then raise exception 'Independent judgments on this item are not yet disclosed.' using errcode = '42501'; end if;
  if not (me = any (st.assigned)) or not (me = any (st.submitted)) then raise exception 'Only the adjudicators who rated this item can resolve it.' using errcode = '42501'; end if;
  if st.state = 'escalated' then raise exception 'This item is escalated; the lead or final reviewer resolves it.' using errcode = '42501'; end if;
  return st;
end $$;

create or replace function public.propose_resolution(p text, payload jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  item text := payload ->> 'itemId';
  st public.agm_status := public.agm_can_resolve(p, item);
  cfg jsonb := public.agm_cfg(p);
  opt jsonb;
  vals jsonb := coalesce(payload -> 'values', '{}'::jsonb);
  blank_ok boolean;
  v jsonb;
  x jsonb;
  errs text[] := '{}';
  ver integer;
  d jsonb;
  rats jsonb := coalesce(payload -> 'rationaleIds', '[]'::jsonb);
begin
  if st.state = 'resolved' then raise exception 'This item already has a final resolution.'; end if;
  select o into opt from jsonb_array_elements(cfg -> 'resolution' -> 'options') o where o ->> 'id' = payload ->> 'optionId' and coalesce((o ->> 'enabled')::boolean, false);
  if opt is null then raise exception 'This resolution option is not enabled.'; end if;
  if opt ->> 'kind' = 'escalate' then raise exception 'Use escalation for this option.'; end if;
  if opt ->> 'kind' = 'retain_adjudicator' then
    select a.doc -> 'values' into x from public.assessments a where a.item_id = item and a.user_id = (payload ->> 'retainedUserId')::uuid and a.status = 'submitted';
    if x is null then raise exception 'The retained adjudicator has no submitted judgment on this item.'; end if;
    vals := x;
  end if;
  blank_ok := opt ->> 'kind' in ('insufficient_evidence', 'ambiguous');
  if coalesce((cfg -> 'resolution' ->> 'requireRationale')::boolean, false) and jsonb_array_length(rats) = 0 and coalesce(trim(payload ->> 'freeText'), '') = '' then errs := errs || 'Select a rationale or write one.'; end if;
  if not coalesce((cfg -> 'resolution' ->> 'allowMultipleRationales')::boolean, true) and jsonb_array_length(rats) > 1 then errs := errs || 'Select only one rationale.'; end if;
  if coalesce((cfg -> 'resolution' ->> 'requireFreeText')::boolean, false) and coalesce(trim(payload ->> 'freeText'), '') = '' then errs := errs || 'A written rationale is required.'; end if;
  for v in select e from jsonb_array_elements(cfg -> 'variables') e where e ->> 'type' <> 'text' and coalesce((e ->> 'includeInAgreement')::boolean, true) loop
    x := vals -> (v ->> 'id');
    if (x is null or jsonb_typeof(x) = 'null' or x = '""'::jsonb) and not blank_ok and (v ->> 'id') = any (st.disputed) and coalesce((v ->> 'required')::boolean, false) then
      errs := errs || format('Give a final value for "%s".', v ->> 'label');
    end if;
  end loop;
  errs := errs || public.agm_validate((select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(cfg -> 'variables') e where e ->> 'type' <> 'text'),
    (select coalesce(jsonb_object_agg(k, val), '{}') from jsonb_each(vals) t(k, val) where jsonb_typeof(val) <> 'null' and val <> '""'::jsonb), false);
  if cardinality(errs) > 0 then raise exception 'The proposal is incomplete: %', array_to_string(errs, ' ') using errcode = '22023'; end if;
  update public.resolutions set status = 'superseded' where item_id = item and status = 'proposed';
  select coalesce(max(version), 0) + 1 into ver from public.resolutions where item_id = item;
  d := jsonb_build_object('id', public.agm_new_id('rs'), 'projectId', p, 'itemId', item, 'values', vals, 'optionId', payload ->> 'optionId', 'retainedUserId', payload ->> 'retainedUserId',
    'rationaleIds', rats, 'freeText', coalesce(payload ->> 'freeText', ''), 'references', coalesce(payload ->> 'references', ''), 'proposedBy', me, 'proposedAt', public.agm_now(), 'approvals', '[]'::jsonb, 'version', ver);
  insert into public.resolutions (id, project_id, item_id, status, version, doc) values (d ->> 'id', p, item, 'proposed', ver, d);
  perform public.agm_audit(p, 'resolution.propose', 'resolution', d ->> 'id', jsonb_build_object('item', item, 'option', payload ->> 'optionId'));
  return d || jsonb_build_object('status', 'proposed');
end $$;

create or replace function public.approve_resolution(p text, rid text) returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r record; st public.agm_status; cfg jsonb := public.agm_cfg(p); mech text; need integer; others integer; d jsonb; n integer;
begin
  select * into r from public.resolutions where id = rid and project_id = p for update;
  if r.id is null or r.status <> 'proposed' then raise exception 'Unknown or closed proposal.'; end if;
  st := public.agm_can_resolve(p, r.item_id);
  if (r.doc ->> 'proposedBy')::uuid = me or not (me = any (st.assigned)) or exists (select 1 from jsonb_array_elements(r.doc -> 'approvals') a where (a ->> 'userId')::uuid = me) then
    raise exception 'You cannot approve this proposal.' using errcode = '42501';
  end if;
  d := jsonb_set(r.doc, '{approvals}', (r.doc -> 'approvals') || jsonb_build_array(jsonb_build_object('userId', me, 'at', public.agm_now())));
  perform public.agm_audit(p, 'resolution.approve', 'resolution', rid, jsonb_build_object('item', r.item_id));
  mech := coalesce(cfg -> 'resolution' ->> 'mechanism', 'discussion');
  others := cardinality(array(select u from unnest(st.assigned) u where u <> (r.doc ->> 'proposedBy')::uuid));
  need := case when coalesce((cfg -> 'resolution' ->> 'approvalsRequired')::integer, 0) > 0 then least((cfg -> 'resolution' ->> 'approvalsRequired')::integer, others) else others end;
  select count(*) into n from jsonb_array_elements(d -> 'approvals') a where (a ->> 'userId')::uuid = any (st.assigned);
  if mech in ('discussion', 'escalation') and st.state <> 'escalated' and n >= need then
    d := d || jsonb_build_object('finalizedBy', me, 'finalizedAt', public.agm_now());
    update public.resolutions set status = 'final', doc = d where id = rid;
    update public.escalations set open = false where item_id = r.item_id and open;
    perform public.agm_audit(p, 'resolution.finalize', 'resolution', rid, jsonb_build_object('item', r.item_id, 'by', 'approvals'));
    return d || jsonb_build_object('status', 'final');
  end if;
  update public.resolutions set doc = d where id = rid;
  return d || jsonb_build_object('status', 'proposed');
end $$;

create or replace function public.finalize_resolution(p text, rid text) returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; d jsonb; my_role text := public.agm_require_role(p, array['admin', 'lead']);
begin
  select * into r from public.resolutions where id = rid and project_id = p for update;
  if r.id is null or r.status <> 'proposed' then raise exception 'Only a pending proposal can be finalized.'; end if;
  d := r.doc || jsonb_build_object('finalizedBy', auth.uid(), 'finalizedAt', public.agm_now());
  update public.resolutions set status = 'final', doc = d where id = rid;
  update public.escalations set open = false where item_id = r.item_id and open;
  perform public.agm_audit(p, 'resolution.finalize', 'resolution', rid, jsonb_build_object('item', r.item_id, 'by', my_role));
  return d || jsonb_build_object('status', 'final');
end $$;

create or replace function public.reopen_resolution(p text, rid text, reason text) returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  perform public.agm_require_role(p, array['admin']);
  select * into r from public.resolutions where id = rid and project_id = p for update;
  if r.id is null or r.status <> 'final' then raise exception 'Only a final resolution can be reopened.'; end if;
  if coalesce(trim(reason), '') = '' then raise exception 'Give a reason for reopening.'; end if;
  update public.resolutions set status = 'superseded', doc = r.doc || jsonb_build_object('reopenedBy', auth.uid(), 'reopenedAt', public.agm_now(), 'reopenReason', reason) where id = rid;
  perform public.agm_audit(p, 'resolution.reopen', 'resolution', rid, jsonb_build_object('item', r.item_id, 'reason', reason));
end $$;

create or replace function public.escalate_item(p text, item text, reason text) returns void language plpgsql security definer set search_path = public as $$
declare eid text := public.agm_new_id('es');
begin
  perform public.agm_can_resolve(p, item);
  if not exists (select 1 from jsonb_array_elements(public.agm_cfg(p) -> 'resolution' -> 'options') o where o ->> 'kind' = 'escalate' and coalesce((o ->> 'enabled')::boolean, false)) then
    raise exception 'Escalation is not enabled for this project.';
  end if;
  if coalesce(trim(reason), '') = '' then raise exception 'Say why the item needs further review.'; end if;
  insert into public.escalations (id, project_id, item_id, open, doc) values (eid, p, item, true,
    jsonb_build_object('id', eid, 'projectId', p, 'itemId', item, 'userId', auth.uid(), 'reason', reason, 'at', public.agm_now()));
  perform public.agm_audit(p, 'item.escalate', 'item', item, jsonb_build_object('reason', reason));
end $$;

create or replace function public.add_discussion(p text, item text, p_body text) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r text := public.agm_require_role(p, array['admin', 'lead', 'adjudicator']); cfg jsonb := public.agm_cfg(p); sts public.agm_status[]; st public.agm_status; did text := public.agm_new_id('ds');
begin
  sts := array(select public.agm_item_status(p));
  select * into st from unnest(sts) s where s.item_id = item;
  if r = 'adjudicator' and not (me = any (st.assigned) and me = any (st.submitted) and public.agm_disclosed(cfg, st, public.agm_all_complete(sts))) then
    raise exception 'Discussion opens after judgments on the item are disclosed.' using errcode = '42501';
  end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Write a message.'; end if;
  insert into public.discussions values (did, p, item, jsonb_build_object('id', did, 'projectId', p, 'itemId', item, 'userId', me, 'text', trim(p_body), 'at', public.agm_now()));
  insert into public.project_events (project_id) values (p);
end $$;

create or replace function public.open_disclosure(p text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.agm_require_role(p, array['admin']);
  update public.projects set doc = jsonb_set(doc, '{config,disclosed}', 'true'), version = version + 1, updated_at = now() where id = p;
  perform public.agm_audit(p, 'disclosure.open', 'project', p, null);
end $$;

-- Importing a project archive: configuration, items and contexts. Judgments in an archive are imported only
-- for authors who already have accounts here (their ids match profiles); everything else is reported.
create or replace function public.import_archive(archive jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare d jsonb; res jsonb; pid text; skipped integer;
begin
  if archive ->> 'format' <> 'agreemetry-project' then raise exception 'Not an Agreemetry project archive.'; end if;
  d := (archive -> 'project') - 'id';
  res := public.create_project(d);
  pid := res ->> 'id';
  update public.projects set doc = doc || jsonb_build_object('id', pid) where id = pid;
  perform public.import_items(pid, coalesce((select jsonb_agg(e - 'id') from jsonb_array_elements(archive -> 'items') e), '[]'), archive -> 'contexts');
  select count(*) into skipped from jsonb_array_elements(coalesce(archive -> 'assessments', '[]'::jsonb));
  perform public.agm_audit(pid, 'project.import_archive', 'project', pid, jsonb_build_object('items', jsonb_array_length(archive -> 'items'), 'judgmentsNotImported', skipped));
  return (select doc || jsonb_build_object('status', status, 'version', version) from public.projects where id = pid);
end $$;

-- Function grants: only signed-in users may call; each function checks the caller's role itself.
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.get_project_view(text), public.list_my_projects(), public.create_project(jsonb), public.update_project(jsonb),
  public.set_project_status(text, text), public.delete_project(text), public.duplicate_project(text, boolean),
  public.upsert_membership(text, uuid, text, text, boolean, boolean), public.invite_member(text, text, text, text), public.accept_invites(),
  public.update_profile(text), public.list_colleagues(), public.import_items(text, jsonb, jsonb), public.delete_items(text, text[]),
  public.add_assignments(text, jsonb), public.save_assessment(text, text, jsonb, text, text, boolean, integer), public.reopen_assessment(text, text, text),
  public.propose_resolution(text, jsonb), public.approve_resolution(text, text), public.finalize_resolution(text, text), public.reopen_resolution(text, text, text),
  public.escalate_item(text, text, text), public.add_discussion(text, text, text), public.open_disclosure(text), public.import_archive(jsonb), public.agm_is_member(text)
to authenticated;

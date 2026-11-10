-- Agreemetry: researcher accounts, labs (group accounts), API tokens, an events feed, published results and
-- webhooks. Applies after 20261109000000_agreemetry.sql.
--
-- Security model (unchanged): raw tables stay closed to clients; every operation is a SECURITY DEFINER
-- function that checks the caller. New here:
--  * Labs own projects. Lab owners and administrators are made administrators of the lab's projects
--    (memberships.via_lab), unless they already hold a direct role there, which always wins.
--  * API tokens let scripts and other platforms call the documented functions without a browser session.
--    PostgREST's pre-request hook (agm_pre_request) checks the token, its scope and the called function,
--    then sets the caller identity for that one request. Only a hash of each token is stored.
--  * Webhooks and the events feed carry identifiers and event names only: never judgments, names or item
--    content, so an integration cannot weaken blinding.

-- Researcher profiles --------------------------------------------------------------------------------------

alter table public.profiles add column if not exists affiliation text;
alter table public.profiles add column if not exists orcid text;
alter table public.profiles add column if not exists research_field text;
alter table public.profiles add column if not exists terms_accepted_at timestamptz;

create or replace function public.agm_via_token() returns boolean language sql stable as $$
  select coalesce(current_setting('agm.via_token', true), '') <> ''
$$;

-- ORCID iD (ISO 7064 MOD 11-2 check character); returns the canonical form or raises.
create or replace function public.agm_orcid(o text) returns text language plpgsql immutable as $$
declare raw text; total integer := 0; c integer; i integer; expected text;
begin
  if o is null or btrim(o) = '' then return null; end if;
  raw := upper(regexp_replace(regexp_replace(btrim(o), '^https?://(www\.)?orcid\.org/', '', 'i'), '[\s-]', '', 'g'));
  if raw !~ '^[0-9]{15}[0-9X]$' then raise exception 'That is not a valid ORCID iD.' using errcode = '22023'; end if;
  for i in 1..15 loop total := (total + substr(raw, i, 1)::integer) * 2; end loop;
  c := (12 - (total % 11)) % 11;
  expected := case when c = 10 then 'X' else c::text end;
  if substr(raw, 16, 1) <> expected then
    raise exception 'That ORCID iD has a wrong check digit.' using errcode = '22023';
  end if;
  return substr(raw, 1, 4) || '-' || substr(raw, 5, 4) || '-' || substr(raw, 9, 4) || '-' || substr(raw, 13, 4);
end $$;

create or replace function public.agm_profile_json(u public.profiles) returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object('id', u.id, 'displayName', u.display_name, 'email', u.email, 'active', u.active,
    'createdAt', u.created_at, 'affiliation', u.affiliation, 'orcid', u.orcid, 'field', u.research_field, 'termsAcceptedAt', u.terms_accepted_at))
$$;

create or replace function public.get_my_profile() returns jsonb language sql stable security definer set search_path = public as $$
  select public.agm_profile_json(u) from public.profiles u where u.id = auth.uid()
$$;

create or replace function public.update_my_profile(p_doc jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); nm text := nullif(btrim(p_doc ->> 'displayName'), '');
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if public.agm_via_token() then raise exception 'A profile cannot be changed with an API token.' using errcode = '42501'; end if;
  if length(coalesce(nm, '')) > 120 or length(coalesce(p_doc ->> 'affiliation', '')) > 300 or length(coalesce(p_doc ->> 'field', '')) > 200 then
    raise exception 'A profile entry is too long.' using errcode = '22023';
  end if;
  update public.profiles set
    display_name = coalesce(nm, display_name),
    affiliation = case when p_doc ? 'affiliation' then nullif(btrim(p_doc ->> 'affiliation'), '') else affiliation end,
    orcid = case when p_doc ? 'orcid' then public.agm_orcid(p_doc ->> 'orcid') else orcid end,
    research_field = case when p_doc ? 'field' then nullif(btrim(p_doc ->> 'field'), '') else research_field end,
    terms_accepted_at = case when coalesce((p_doc ->> 'acceptTerms')::boolean, false) then coalesce(terms_accepted_at, now()) else terms_accepted_at end
  where id = me;
  return public.get_my_profile();
end $$;

-- Labs (group accounts) -----------------------------------------------------------------------------------

create table if not exists public.labs (
  id text primary key,
  name text not null check (length(btrim(name)) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  description text not null default '',
  website text check (website is null or website ~ '^https?://'),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create table if not exists public.lab_members (
  lab_id text not null references public.labs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (lab_id, user_id)
);

-- Joining a lab always needs the invitee's consent, even when they already have an account.
create table if not exists public.lab_invites (
  lab_id text not null references public.labs (id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (lab_id, email)
);

alter table public.projects add column if not exists lab_id text references public.labs (id) on delete restrict;
alter table public.memberships add column if not exists via_lab boolean not null default false;
create index if not exists projects_lab on public.projects (lab_id);

alter table public.labs enable row level security;
alter table public.lab_members enable row level security;
alter table public.lab_invites enable row level security;

-- The lab of a project lives in projects.lab_id; the document copy is kept in step here, so a client can
-- never place a project in a lab by editing the document.
create or replace function public.agm_project_lab_doc() returns trigger language plpgsql as $$
begin
  new.doc := case when new.lab_id is null then new.doc - 'labId' else new.doc || jsonb_build_object('labId', new.lab_id) end;
  return new;
end $$;
drop trigger if exists project_lab_doc on public.projects;
create trigger project_lab_doc before insert or update on public.projects for each row execute function public.agm_project_lab_doc();

create or replace function public.agm_lab_role(l text, u uuid) returns text language sql stable security definer set search_path = public as $$
  select role from public.lab_members where lab_id = l and user_id = u
$$;

create or replace function public.agm_require_lab_role(l text, roles text[]) returns text language plpgsql stable security definer set search_path = public as $$
declare r text;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if public.agm_via_token() then raise exception 'Labs cannot be managed with an API token.' using errcode = '42501'; end if;
  if not exists (select 1 from public.labs where id = l) then raise exception 'Unknown lab' using errcode = '22023'; end if;
  r := public.agm_lab_role(l, auth.uid());
  if r is null then raise exception 'You are not a member of this lab' using errcode = '42501'; end if;
  if not (r = any (roles)) then raise exception 'Your lab role (%) cannot do this', r using errcode = '42501'; end if;
  return r;
end $$;

create or replace function public.agm_next_pseudonym(p text, prefix text) returns text language plpgsql stable set search_path = public as $$
declare i integer := 1;
begin
  while exists (select 1 from public.memberships where project_id = p and pseudonym = prefix || i) loop i := i + 1; end loop;
  return prefix || i;
end $$;

-- Lab owners and administrators administer the lab's projects. A direct project role is never replaced, so
-- someone rating a lab project stays blind even if they also run the lab.
create or replace function public.agm_sync_lab_admins(p text) returns void language plpgsql security definer set search_path = public as $$
declare l text; r record;
begin
  select lab_id into l from public.projects where id = p;
  for r in
    update public.memberships m set active = false
    where m.project_id = p and m.via_lab and m.active
      and (l is null or not exists (select 1 from public.lab_members lm where lm.lab_id = l and lm.user_id = m.user_id and lm.role in ('owner', 'admin')))
    returning m.user_id
  loop
    perform public.agm_audit(p, 'member.lab_revoke', 'membership', r.user_id::text, jsonb_build_object('lab', l));
  end loop;
  if l is not null then
    for r in select lm.user_id from public.lab_members lm where lm.lab_id = l and lm.role in ('owner', 'admin') loop
      if not exists (select 1 from public.memberships where project_id = p and user_id = r.user_id) then
        insert into public.memberships (project_id, user_id, role, pseudonym, active, adjudicates, via_lab)
          values (p, r.user_id, 'admin', public.agm_next_pseudonym(p, 'ADM'), true, false, true);
        perform public.agm_audit(p, 'member.lab_grant', 'membership', r.user_id::text, jsonb_build_object('lab', l));
      elsif exists (select 1 from public.memberships where project_id = p and user_id = r.user_id and via_lab and not active) then
        update public.memberships set active = true where project_id = p and user_id = r.user_id;
        perform public.agm_audit(p, 'member.lab_grant', 'membership', r.user_id::text, jsonb_build_object('lab', l));
      end if;
    end loop;
  end if;
  if not exists (select 1 from public.memberships where project_id = p and role = 'admin' and active) then
    raise exception 'This change would leave a project without an active administrator. Add a direct administrator to the project first.' using errcode = '22023';
  end if;
end $$;

create or replace function public.agm_sync_lab(l text) returns void language plpgsql security definer set search_path = public as $$
declare pid text;
begin
  for pid in select id from public.projects where lab_id = l loop perform public.agm_sync_lab_admins(pid); end loop;
end $$;

create or replace function public.agm_lab_json(l text) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_strip_nulls(jsonb_build_object('id', x.id, 'name', x.name, 'slug', x.slug, 'description', x.description, 'website', x.website,
    'createdBy', x.created_by, 'createdAt', x.created_at)) from public.labs x where x.id = l
$$;

create or replace function public.agm_lab_slug(s text) returns text language sql immutable as $$
  select coalesce(nullif(btrim(left(btrim(regexp_replace(lower(coalesce(s, '')), '[^a-z0-9]+', '-', 'g'), '-'), 63), '-'), ''), 'lab')
$$;

create or replace function public.create_lab(p_doc jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); lid text := public.agm_new_id('lab'); nm text := btrim(coalesce(p_doc ->> 'name', '')); sl text;
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if public.agm_via_token() then raise exception 'Labs cannot be managed with an API token.' using errcode = '42501'; end if;
  if nm = '' then raise exception 'A lab name is required.' using errcode = '22023'; end if;
  sl := public.agm_lab_slug(coalesce(nullif(btrim(p_doc ->> 'slug'), ''), nm));
  if exists (select 1 from public.labs where slug = sl) then raise exception 'The handle "%" is taken. Choose another.', sl using errcode = '23505'; end if;
  if (select count(*) from public.lab_members where user_id = me and role = 'owner') >= 20 then raise exception 'You own the maximum of 20 labs.' using errcode = '22023'; end if;
  insert into public.labs (id, name, slug, description, website, created_by)
    values (lid, nm, sl, coalesce(p_doc ->> 'description', ''), nullif(btrim(p_doc ->> 'website'), ''), me);
  insert into public.lab_members (lab_id, user_id, role) values (lid, me, 'owner');
  return public.agm_lab_json(lid);
end $$;

create or replace function public.update_lab(p_doc jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare l text := p_doc ->> 'id'; sl text;
begin
  perform public.agm_require_lab_role(l, array['owner', 'admin']);
  sl := public.agm_lab_slug(coalesce(nullif(btrim(p_doc ->> 'slug'), ''), (select slug from public.labs where id = l)));
  if exists (select 1 from public.labs where slug = sl and id <> l) then raise exception 'The handle "%" is taken. Choose another.', sl using errcode = '23505'; end if;
  update public.labs set name = coalesce(nullif(btrim(p_doc ->> 'name'), ''), name), slug = sl,
    description = coalesce(p_doc ->> 'description', description), website = nullif(btrim(coalesce(p_doc ->> 'website', '')), '')
  where id = l;
  return public.agm_lab_json(l);
end $$;

create or replace function public.list_my_labs() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('lab', public.agm_lab_json(x.id), 'role', lm.role,
    'members', (select count(*) from public.lab_members y where y.lab_id = x.id),
    'projects', (select count(*) from public.projects pr where pr.lab_id = x.id)) order by x.name), '[]')
  from public.lab_members lm join public.labs x on x.id = lm.lab_id where lm.user_id = auth.uid()
$$;

create or replace function public.get_lab(l text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r text; me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  r := public.agm_lab_role(l, me);
  if r is null then raise exception 'You are not a member of this lab' using errcode = '42501'; end if;
  return jsonb_build_object(
    'lab', public.agm_lab_json(l),
    'role', r,
    'members', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('userId', u.id, 'displayName', u.display_name,
        'email', case when r in ('owner', 'admin') or u.id = me then u.email end, 'affiliation', u.affiliation, 'orcid', u.orcid,
        'role', lm.role, 'joinedAt', lm.joined_at)) order by array_position(array['owner', 'admin', 'member'], lm.role), u.display_name)
      from public.lab_members lm join public.profiles u on u.id = lm.user_id where lm.lab_id = l), '[]'),
    'invites', case when r in ('owner', 'admin') then coalesce((select jsonb_agg(jsonb_build_object('email', i.email, 'role', i.role, 'createdAt', i.created_at) order by i.created_at)
      from public.lab_invites i where i.lab_id = l), '[]') else '[]'::jsonb end,
    'projects', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', pr.id, 'name', pr.doc ->> 'name', 'status', pr.status,
        'myRole', (select m.role from public.memberships m where m.project_id = pr.id and m.user_id = me and m.active))) order by pr.doc ->> 'name')
      from public.projects pr where pr.lab_id = l), '[]'));
end $$;

create or replace function public.invite_lab_member(l text, mail text, r text) returns void language plpgsql security definer set search_path = public as $$
declare my text := public.agm_require_lab_role(l, array['owner', 'admin']); m text := lower(btrim(coalesce(mail, '')));
begin
  if r not in ('owner', 'admin', 'member') then raise exception 'Unknown lab role' using errcode = '22023'; end if;
  if r = 'owner' and my <> 'owner' then raise exception 'Only an owner can invite another owner.' using errcode = '42501'; end if;
  if m !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
  if exists (select 1 from public.lab_members lm join public.profiles u on u.id = lm.user_id where lm.lab_id = l and lower(u.email) = m) then
    raise exception 'That person is already a member of the lab.' using errcode = '23505';
  end if;
  insert into public.lab_invites (lab_id, email, role, created_by) values (l, m, r, auth.uid())
    on conflict (lab_id, email) do update set role = excluded.role, created_by = excluded.created_by, created_at = now();
end $$;

create or replace function public.cancel_lab_invite(l text, mail text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.agm_require_lab_role(l, array['owner', 'admin']);
  delete from public.lab_invites where lab_id = l and email = lower(btrim(mail));
end $$;

create or replace function public.list_my_lab_invites() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('lab', public.agm_lab_json(i.lab_id), 'role', i.role, 'createdAt', i.created_at,
    'invitedBy', (select display_name from public.profiles where id = i.created_by)) order by i.created_at), '[]')
  from public.lab_invites i join public.profiles u on lower(u.email) = i.email where u.id = auth.uid()
$$;

create or replace function public.respond_lab_invite(l text, accept boolean) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m text; iv record;
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if public.agm_via_token() then raise exception 'Labs cannot be managed with an API token.' using errcode = '42501'; end if;
  select lower(email) into m from public.profiles where id = me;
  select * into iv from public.lab_invites where lab_id = l and email = m;
  if not found then raise exception 'No invitation to this lab.' using errcode = '22023'; end if;
  delete from public.lab_invites where lab_id = l and email = m;
  if accept then
    insert into public.lab_members (lab_id, user_id, role) values (l, me, iv.role) on conflict (lab_id, user_id) do nothing;
    perform public.agm_sync_lab(l);
  end if;
end $$;

create or replace function public.set_lab_member(l text, u uuid, r text) returns void language plpgsql security definer set search_path = public as $$
declare my text := public.agm_require_lab_role(l, array['owner', 'admin']); cur text := public.agm_lab_role(l, u);
begin
  if r not in ('owner', 'admin', 'member') then raise exception 'Unknown lab role' using errcode = '22023'; end if;
  if cur is null then raise exception 'That person is not a member of the lab.' using errcode = '22023'; end if;
  if (r = 'owner' or cur = 'owner') and my <> 'owner' then raise exception 'Only an owner can change an owner.' using errcode = '42501'; end if;
  if cur = 'owner' and r <> 'owner' and (select count(*) from public.lab_members where lab_id = l and role = 'owner') <= 1 then
    raise exception 'A lab needs at least one owner.' using errcode = '22023';
  end if;
  update public.lab_members set role = r where lab_id = l and user_id = u;
  perform public.agm_sync_lab(l);
end $$;

create or replace function public.remove_lab_member(l text, u uuid) returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); my text; cur text := public.agm_lab_role(l, u);
begin
  if me = u then my := public.agm_require_lab_role(l, array['owner', 'admin', 'member']);
  else my := public.agm_require_lab_role(l, array['owner', 'admin']); end if;
  if cur is null then raise exception 'That person is not a member of the lab.' using errcode = '22023'; end if;
  if cur = 'owner' and me <> u and my <> 'owner' then raise exception 'Only an owner can remove an owner.' using errcode = '42501'; end if;
  if cur = 'owner' and (select count(*) from public.lab_members where lab_id = l and role = 'owner') <= 1 then
    raise exception 'A lab needs at least one owner. Make someone else an owner first.' using errcode = '22023';
  end if;
  delete from public.lab_members where lab_id = l and user_id = u;
  perform public.agm_sync_lab(l);
end $$;

create or replace function public.delete_lab(l text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.agm_require_lab_role(l, array['owner']);
  if exists (select 1 from public.projects where lab_id = l) then raise exception 'Move the lab''s projects out of the lab first.' using errcode = '22023'; end if;
  delete from public.labs where id = l;
end $$;

-- Place a project in a lab, or take it out (l = null). The caller administers the project and belongs to the lab.
create or replace function public.move_project_to_lab(p text, l text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.agm_require_role(p, array['admin']);
  if public.agm_via_token() then raise exception 'Project ownership cannot be changed with an API token.' using errcode = '42501'; end if;
  if l is not null and public.agm_lab_role(l, auth.uid()) is null then raise exception 'You are not a member of that lab.' using errcode = '42501'; end if;
  update public.projects set lab_id = l, version = version + 1, updated_at = now() where id = p;
  perform public.agm_audit(p, 'project.lab', 'project', p, jsonb_build_object('lab', l));
  perform public.agm_sync_lab_admins(p);
end $$;

-- A role set directly by a project administrator is a direct role from then on: a later lab change never
-- withdraws it. Otherwise as in the base migration.
create or replace function public.upsert_membership(p text, u uuid, r text, pseudo text, act boolean, adj boolean) returns void language plpgsql security definer set search_path = public as $$
declare ps text := nullif(trim(pseudo), ''); admins integer;
begin
  perform public.agm_require_role(p, array['admin']);
  if r not in ('admin', 'lead', 'adjudicator') then raise exception 'Unknown project role' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = u) then raise exception 'Unknown user'; end if;
  select count(*) into admins from public.memberships where project_id = p and role = 'admin' and active and user_id <> u;
  if admins = 0 and (r <> 'admin' or not act) and exists (select 1 from public.memberships where project_id = p and user_id = u and role = 'admin') then
    raise exception 'A project needs at least one active administrator.';
  end if;
  if ps is null or exists (select 1 from public.memberships where project_id = p and pseudonym = ps and user_id <> u) then
    select pseudonym into ps from public.memberships where project_id = p and user_id = u;
    if ps is null then ps := public.agm_next_pseudonym(p, case r when 'admin' then 'ADM' when 'lead' then 'L' else 'R' end); end if;
  end if;
  insert into public.memberships (project_id, user_id, role, pseudonym, active, adjudicates, via_lab)
    values (p, u, r, ps, act, case when r = 'adjudicator' then true else adj end, false)
    on conflict (project_id, user_id) do update set role = excluded.role, pseudonym = excluded.pseudonym, active = excluded.active,
      adjudicates = excluded.adjudicates, via_lab = false;
  perform public.agm_audit(p, 'member.upsert', 'membership', u::text, jsonb_build_object('role', r, 'active', act, 'pseudonym', ps));
end $$;

-- Colleagues now include members of your labs, so a lab can staff its projects.
create or replace function public.list_colleagues() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(distinct public.agm_profile_json(u) - 'termsAcceptedAt'), '[]')
  from public.profiles u
  where u.id = auth.uid()
    or u.id in (select m2.user_id from public.memberships m join public.memberships m2 on m2.project_id = m.project_id where m.user_id = auth.uid() and m.role = 'admin' and m.active)
    or u.id in (select b.user_id from public.lab_members a join public.lab_members b on b.lab_id = a.lab_id where a.user_id = auth.uid())
$$;

-- API tokens ----------------------------------------------------------------------------------------------

create table if not exists public.api_tokens (
  id text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  prefix text not null,
  token_hash text not null unique,
  scope text not null check (scope in ('read', 'write')),
  project_id text references public.projects (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter table public.api_tokens enable row level security;

create or replace function public.agm_token_json(t public.api_tokens) returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object('id', t.id, 'name', t.name, 'prefix', t.prefix, 'scope', t.scope, 'projectId', t.project_id,
    'createdAt', t.created_at, 'expiresAt', t.expires_at, 'lastUsedAt', t.last_used_at, 'revokedAt', t.revoked_at))
$$;

-- Returns the secret once. Tokens expire (at most a year) and can be limited to one project and to reading.
create or replace function public.create_api_token(p_name text, p_scope text, p_project text, p_days integer) returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); tok text; t public.api_tokens;
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if public.agm_via_token() then raise exception 'API tokens cannot create other tokens.' using errcode = '42501'; end if;
  if p_scope not in ('read', 'write') then raise exception 'Scope must be read or write.' using errcode = '22023'; end if;
  if p_days is null or p_days < 1 or p_days > 366 then raise exception 'A token lasts between 1 and 366 days.' using errcode = '22023'; end if;
  if p_project is not null and public.agm_role(p_project, me) is null then raise exception 'You are not a member of that project.' using errcode = '42501'; end if;
  if (select count(*) from public.api_tokens where user_id = me and revoked_at is null and expires_at > now()) >= 20 then
    raise exception 'You have 20 active tokens. Revoke one first.' using errcode = '22023';
  end if;
  tok := 'agm_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.api_tokens (id, user_id, name, prefix, token_hash, scope, project_id, expires_at)
    values (public.agm_new_id('tok'), me, btrim(coalesce(p_name, '')), left(tok, 12), encode(sha256(convert_to(tok, 'UTF8')), 'hex'), p_scope, p_project, now() + make_interval(days => p_days))
    returning * into t;
  return jsonb_build_object('token', tok, 'record', public.agm_token_json(t));
end $$;

create or replace function public.list_api_tokens() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if public.agm_via_token() then raise exception 'Tokens cannot be listed with an API token.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(public.agm_token_json(t) order by t.created_at desc) from public.api_tokens t where t.user_id = auth.uid()), '[]');
end $$;

create or replace function public.revoke_api_token(t_id text) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  update public.api_tokens set revoked_at = coalesce(revoked_at, now()) where id = t_id and user_id = auth.uid();
  if not found then raise exception 'Unknown token' using errcode = '22023'; end if;
end $$;

-- Functions an API token may call. Read tokens get the first list; write tokens get both.
create or replace function public.agm_api_read_functions() returns text[] language sql immutable as $$
  select array['get_project_view', 'list_my_projects', 'api_project_status', 'api_events', 'api_results', 'get_my_profile']
$$;
create or replace function public.agm_api_write_functions() returns text[] language sql immutable as $$
  select array['create_project', 'update_project', 'set_project_status', 'import_items', 'delete_items', 'add_assignments', 'upsert_membership',
    'invite_member', 'save_assessment', 'reopen_assessment', 'propose_resolution', 'approve_resolution', 'finalize_resolution', 'escalate_item',
    'add_discussion', 'open_disclosure', 'import_archive']
$$;

-- PostgREST pre-request hook. A request that carries X-Agreemetry-Token and no signed-in session runs as the
-- token's owner, limited to the token's scope, project and the functions above.
create or replace function public.agm_pre_request() returns void language plpgsql security definer set search_path = public as $$
declare hdr jsonb; tok text; t public.api_tokens; fn text;
begin
  hdr := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  tok := nullif(btrim(hdr ->> 'x-agreemetry-token'), '');
  if tok is null or auth.uid() is not null then return; end if;
  select * into t from public.api_tokens where token_hash = encode(sha256(convert_to(tok, 'UTF8')), 'hex');
  if not found or t.revoked_at is not null or t.expires_at <= now() then
    raise exception 'Invalid, revoked or expired API token' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles where id = t.user_id and active) then raise exception 'The account behind this token is inactive' using errcode = '28000'; end if;
  fn := substring(coalesce(current_setting('request.path', true), '') from '/rpc/([A-Za-z0-9_]+)/?$');
  if fn is null then raise exception 'API tokens work only with the documented /rpc functions' using errcode = '42501'; end if;
  if not (fn = any (public.agm_api_read_functions()) or (t.scope = 'write' and fn = any (public.agm_api_write_functions()))) then
    raise exception 'This token cannot call %', fn using errcode = '42501';
  end if;
  perform set_config('request.jwt.claim.sub', t.user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.user_id, 'role', 'anon', 'agm_token', t.id)::text, true);
  perform set_config('agm.via_token', t.id, true);
  perform set_config('agm.token_project', coalesce(t.project_id, ''), true);
  if current_setting('transaction_read_only') = 'off' then update public.api_tokens set last_used_at = now() where id = t.id; end if;
end $$;

-- A project-limited token sees only its project.
create or replace function public.agm_role(p text, u uuid) returns text language sql stable security definer set search_path = public as $$
  select role from public.memberships where project_id = p and user_id = u and active
    and (coalesce(current_setting('agm.token_project', true), '') = '' or p = current_setting('agm.token_project', true))
$$;

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
    and (coalesce(current_setting('agm.token_project', true), '') = '' or p.id = current_setting('agm.token_project', true))
$$;

-- Events feed and project status (administrators) ----------------------------------------------------------

create or replace function public.api_project_status(p text) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare sts public.agm_status[]; pr record;
begin
  perform public.agm_require_role(p, array['admin']);
  select * into pr from public.projects where id = p;
  sts := array(select public.agm_item_status(p));
  return jsonb_build_object(
    'projectId', p, 'name', pr.doc ->> 'name', 'status', pr.status, 'labId', pr.lab_id, 'at', public.agm_now(),
    'items', cardinality(sts),
    'states', coalesce((select jsonb_object_agg(x.state, x.n) from (select s.state, count(*) as n from unnest(sts) s group by s.state) x), '{}'),
    'complete', public.agm_all_complete(sts),
    'adjudicators', coalesce((select jsonb_agg(jsonb_build_object('pseudonym', m.pseudonym,
        'assigned', (select count(*) from unnest(sts) s where m.user_id = any (s.assigned)),
        'submitted', (select count(*) from unnest(sts) s where m.user_id = any (s.submitted))) order by m.pseudonym)
      from public.memberships m where m.project_id = p and m.active and (m.role = 'adjudicator' or m.adjudicates)), '[]'));
end $$;

-- Audit events after a cursor, without details: poll this to mirror progress into another system.
create or replace function public.api_events(p text, after_id bigint default 0, max_rows integer default 500) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare evs jsonb;
begin
  perform public.agm_require_role(p, array['admin']);
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'at', x.at, 'actor', (select m.pseudonym from public.memberships m where m.project_id = p and m.user_id = x.user_id),
      'action', x.action, 'entity', x.entity, 'entityId', x.entity_id) order by x.id), '[]')
    into evs
    from (select * from public.audit where project_id = p and id > coalesce(after_id, 0) order by id limit least(greatest(coalesce(max_rows, 500), 1), 1000)) x;
  return jsonb_build_object('events', evs, 'next', coalesce((select max((e ->> 'id')::bigint) from jsonb_array_elements(evs) e), coalesce(after_id, 0)));
end $$;

-- Published results ---------------------------------------------------------------------------------------
-- Final classifications and reliability are computed by the same code as the exports, in the browser of an
-- administrator who publishes them; the API then serves exactly those tables.

create table if not exists public.result_snapshots (
  id bigserial primary key,
  project_id text not null references public.projects (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid,
  note text,
  tables jsonb not null
);
alter table public.result_snapshots enable row level security;
create index if not exists result_snapshots_project on public.result_snapshots (project_id, id desc);

create or replace function public.publish_results(p text, p_tables jsonb, p_note text) returns jsonb language plpgsql security definer set search_path = public as $$
declare sid bigint;
begin
  perform public.agm_require_role(p, array['admin']);
  if public.agm_via_token() then raise exception 'Results are published from the app.' using errcode = '42501'; end if;
  if jsonb_typeof(p_tables) <> 'object' then raise exception 'Results must be an object of tables.' using errcode = '22023'; end if;
  if octet_length(p_tables::text) > 25000000 then raise exception 'The results are too large to publish (25 MB at most).' using errcode = '22023'; end if;
  insert into public.result_snapshots (project_id, created_by, note, tables) values (p, auth.uid(), nullif(btrim(p_note), ''), p_tables) returning id into sid;
  delete from public.result_snapshots where project_id = p and id not in (select id from public.result_snapshots where project_id = p order by id desc limit 10);
  perform public.agm_audit(p, 'results.publish', 'results', sid::text, null);
  return jsonb_build_object('id', sid, 'createdAt', public.agm_now());
end $$;

create or replace function public.api_results(p text, p_table text default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s record;
begin
  perform public.agm_require_role(p, array['admin']);
  select * into s from public.result_snapshots where project_id = p order by id desc limit 1;
  if not found then raise exception 'No results have been published for this project yet.' using errcode = '22023'; end if;
  return jsonb_build_object('snapshotId', s.id, 'publishedAt', s.created_at, 'note', s.note,
    'tables', case when p_table is null then s.tables else jsonb_build_object(p_table, s.tables -> p_table) end);
end $$;

create or replace function public.list_result_snapshots(p text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.agm_require_role(p, array['admin']);
  return coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', s.id, 'publishedAt', s.created_at, 'note', s.note,
      'by', (select m.pseudonym from public.memberships m where m.project_id = p and m.user_id = s.created_by), 'tables', (select jsonb_agg(k) from jsonb_object_keys(s.tables) k))) order by s.id desc)
    from public.result_snapshots s where s.project_id = p), '[]');
end $$;

-- Webhooks ------------------------------------------------------------------------------------------------

create table if not exists public.webhooks (
  id text primary key,
  project_id text not null references public.projects (id) on delete cascade,
  url text not null check (url ~ '^https://'),
  events text[] not null,
  secret text not null,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);
create table if not exists public.webhook_deliveries (
  id bigserial primary key,
  webhook_id text not null references public.webhooks (id) on delete cascade,
  project_id text not null,
  event text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  queued_at timestamptz,
  request_id bigint,
  error text
);
alter table public.webhooks enable row level security;
alter table public.webhook_deliveries enable row level security;
create index if not exists webhook_deliveries_project on public.webhook_deliveries (project_id, id desc);

create or replace function public.agm_webhook_events() returns text[] language sql immutable as $$
  select array['assessment.submit', 'assessment.reopen', 'resolution.propose', 'resolution.approve', 'resolution.finalize', 'resolution.reopen',
    'item.escalate', 'items.import', 'items.delete', 'assignments.generate', 'disclosure.open', 'project.status', 'project.update', 'project.lab',
    'member.upsert', 'member.invite', 'member.accept_invite', 'member.lab_grant', 'member.lab_revoke', 'results.publish']
$$;

-- Queue a delivery for every matching webhook. With the pg_net extension the request is sent now, signed
-- with HMAC SHA-256 when pgcrypto is available; a failure to send never blocks the operation itself.
create or replace function public.agm_enqueue_webhooks(p text, act text, ent text, ent_id text) returns void language plpgsql security definer set search_path = public as $$
declare w record; body jsonb; did bigint; sig text; rid bigint; hs text;
  has_net boolean := to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null;
begin
  for w in select * from public.webhooks where project_id = p and active and (act = any (events) or '*' = any (events)) loop
    insert into public.webhook_deliveries (webhook_id, project_id, event, payload) values (w.id, p, act, '{}') returning id into did;
    body := jsonb_build_object('id', did, 'event', act, 'projectId', p, 'entity', ent, 'entityId', ent_id, 'at', public.agm_now());
    update public.webhook_deliveries set payload = body where id = did;
    if has_net then
      begin
        select n.nspname into hs from pg_proc f join pg_namespace n on n.oid = f.pronamespace
          where f.proname = 'hmac' and pg_get_function_identity_arguments(f.oid) = 'text, text, text' limit 1;
        sig := null;
        if hs is not null then execute format('select encode(%I.hmac($1, $2, ''sha256''), ''hex'')', hs) into sig using body::text, w.secret; end if;
        execute 'select net.http_post(url := $1, body := $2, headers := $3)' into rid using w.url, body,
          jsonb_build_object('Content-Type', 'application/json', 'X-Agreemetry-Event', act, 'X-Agreemetry-Delivery', did::text)
            || case when sig is null then '{}'::jsonb else jsonb_build_object('X-Agreemetry-Signature', 'sha256=' || sig) end;
        update public.webhook_deliveries set queued_at = now(), request_id = rid where id = did;
      exception when others then
        update public.webhook_deliveries set error = left(sqlerrm, 500) where id = did;
      end;
    end if;
  end loop;
end $$;

-- The audit helper now also feeds webhooks.
create or replace function public.agm_audit(p text, act text, ent text, ent_id text, det jsonb default null) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit (project_id, user_id, action, entity, entity_id, detail) values (p, auth.uid(), act, ent, ent_id, det);
  insert into public.project_events (project_id) values (p);
  perform public.agm_enqueue_webhooks(p, act, ent, ent_id);
end $$;

create or replace function public.agm_webhook_json(w public.webhooks) returns jsonb language sql stable as $$
  select jsonb_build_object('id', w.id, 'projectId', w.project_id, 'url', w.url, 'events', to_jsonb(w.events), 'active', w.active,
    'secretPrefix', left(w.secret, 10), 'createdAt', w.created_at)
$$;

create or replace function public.list_webhooks(p text) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.agm_require_role(p, array['admin']);
  return coalesce((select jsonb_agg(public.agm_webhook_json(w) order by w.created_at) from public.webhooks w where w.project_id = p), '[]');
end $$;

-- Create (no id) or update a webhook. The signing secret is returned only when it is created or rotated.
create or replace function public.save_webhook(p text, p_doc jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare wid text := nullif(p_doc ->> 'id', ''); u text := btrim(coalesce(p_doc ->> 'url', '')); ev text[]; sec text; w public.webhooks;
begin
  perform public.agm_require_role(p, array['admin']);
  if public.agm_via_token() then raise exception 'Webhooks are managed from the app.' using errcode = '42501'; end if;
  if u !~ '^https://[^[:space:]]+$' then raise exception 'A webhook address must start with https://' using errcode = '22023'; end if;
  ev := array(select distinct jsonb_array_elements_text(coalesce(p_doc -> 'events', '[]'::jsonb)));
  if cardinality(ev) = 0 then raise exception 'Choose at least one event.' using errcode = '22023'; end if;
  if exists (select 1 from unnest(ev) e where e <> '*' and not (e = any (public.agm_webhook_events()))) then raise exception 'Unknown event in the list.' using errcode = '22023'; end if;
  if wid is null then
    if (select count(*) from public.webhooks where project_id = p) >= 10 then raise exception 'A project can have 10 webhooks.' using errcode = '22023'; end if;
    sec := 'whsec_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into public.webhooks (id, project_id, url, events, secret, active, created_by)
      values (public.agm_new_id('wh'), p, u, ev, sec, coalesce((p_doc ->> 'active')::boolean, true), auth.uid()) returning * into w;
  else
    if coalesce((p_doc ->> 'rotateSecret')::boolean, false) then sec := 'whsec_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''); end if;
    update public.webhooks set url = u, events = ev, active = coalesce((p_doc ->> 'active')::boolean, active), secret = coalesce(sec, secret)
      where id = wid and project_id = p returning * into w;
    if not found then raise exception 'Unknown webhook' using errcode = '22023'; end if;
  end if;
  perform public.agm_audit(p, 'webhook.save', 'webhook', w.id, jsonb_build_object('url', w.url, 'events', to_jsonb(w.events), 'active', w.active));
  return jsonb_build_object('webhook', public.agm_webhook_json(w), 'secret', sec);
end $$;

create or replace function public.delete_webhook(p text, wid text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.agm_require_role(p, array['admin']);
  if public.agm_via_token() then raise exception 'Webhooks are managed from the app.' using errcode = '42501'; end if;
  delete from public.webhooks where id = wid and project_id = p;
  perform public.agm_audit(p, 'webhook.delete', 'webhook', wid, null);
end $$;

create or replace function public.list_webhook_deliveries(p text, max_rows integer default 50) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.agm_require_role(p, array['admin']);
  return coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', d.id, 'webhookId', d.webhook_id, 'event', d.event, 'createdAt', d.created_at,
      'queuedAt', d.queued_at, 'error', d.error)) order by d.id desc)
    from (select * from public.webhook_deliveries where project_id = p order by id desc limit least(greatest(coalesce(max_rows, 50), 1), 500)) d), '[]');
end $$;

-- Grants ---------------------------------------------------------------------------------------------------

revoke all on public.labs, public.lab_members, public.lab_invites, public.api_tokens, public.result_snapshots, public.webhooks, public.webhook_deliveries from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
revoke execute on all functions in schema public from public, anon;

grant execute on function
  public.get_my_profile(), public.update_my_profile(jsonb),
  public.create_lab(jsonb), public.update_lab(jsonb), public.list_my_labs(), public.get_lab(text), public.invite_lab_member(text, text, text),
  public.cancel_lab_invite(text, text), public.list_my_lab_invites(), public.respond_lab_invite(text, boolean), public.set_lab_member(text, uuid, text),
  public.remove_lab_member(text, uuid), public.delete_lab(text), public.move_project_to_lab(text, text), public.list_colleagues(),
  public.create_api_token(text, text, text, integer), public.list_api_tokens(), public.revoke_api_token(text),
  public.api_project_status(text), public.api_events(text, bigint, integer), public.publish_results(text, jsonb, text), public.api_results(text, text),
  public.list_result_snapshots(text), public.list_webhooks(text), public.save_webhook(text, jsonb), public.delete_webhook(text, text),
  public.list_webhook_deliveries(text, integer), public.agm_pre_request()
to authenticated;

-- Requests made with an API token arrive with the publishable key only (role anon). They can reach just the
-- functions a token may call; each of them still refuses a caller without an identity.
grant execute on function
  public.agm_pre_request(), public.get_project_view(text), public.list_my_projects(), public.api_project_status(text), public.api_events(text, bigint, integer),
  public.api_results(text, text), public.get_my_profile(), public.create_project(jsonb), public.update_project(jsonb), public.set_project_status(text, text),
  public.import_items(text, jsonb, jsonb), public.delete_items(text, text[]), public.add_assignments(text, jsonb),
  public.upsert_membership(text, uuid, text, text, boolean, boolean), public.invite_member(text, text, text, text),
  public.save_assessment(text, text, jsonb, text, text, boolean, integer), public.reopen_assessment(text, text, text),
  public.propose_resolution(text, jsonb), public.approve_resolution(text, text), public.finalize_resolution(text, text),
  public.escalate_item(text, text, text), public.add_discussion(text, text, text), public.open_disclosure(text), public.import_archive(jsonb)
to anon;

-- Register the pre-request hook with PostgREST (Supabase: the authenticator role). Elsewhere, set
-- db-pre-request = "public.agm_pre_request" in the PostgREST configuration.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator set pgrst.db_pre_request = ''public.agm_pre_request''';
    perform pg_notify('pgrst', 'reload config');
  end if;
exception when insufficient_privilege then
  raise notice 'Could not register the API token hook; set pgrst.db_pre_request to public.agm_pre_request (docs/DEPLOYMENT.md).';
end $$;

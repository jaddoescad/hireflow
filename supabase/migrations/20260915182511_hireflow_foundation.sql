-- HireFlow lives alongside existing applications; no existing tables are modified.
create schema if not exists hf_private;
revoke all on schema hf_private from public;
grant usage on schema hf_private to authenticated, service_role;

create table public.hf_companies (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 100),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create table public.hf_members (
 company_id uuid not null references public.hf_companies(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 email text not null, role text not null check(role in ('admin','member')),
 enabled boolean not null default true, created_at timestamptz not null default now(),
 primary key(company_id,user_id)
);
create index hf_members_user on public.hf_members(user_id,company_id) where enabled;
create table public.hf_invitations (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.hf_companies(id) on delete cascade,
 email text not null check(email = lower(trim(email))), role text not null check(role in ('admin','member')),
 invited_by uuid not null references auth.users(id), token_hash text unique not null,
 expires_at timestamptz not null default now()+interval '7 days', accepted_at timestamptz, revoked_at timestamptz,
 created_at timestamptz not null default now()
);
create index hf_invitations_company on public.hf_invitations(company_id);
create table public.hf_stages (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.hf_companies(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 60), position integer not null check(position>=0),
 color text not null default 'blue' check(color in ('blue','slate','violet','amber','green','red')),
 unique(company_id,id), unique(company_id,name)
);
create table public.hf_candidates (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.hf_companies(id) on delete cascade,
 stage_id uuid not null, name text not null check(length(trim(name)) between 1 and 160),
 email text, phone text, job_title text not null default '', experience text not null default '',
 tags text[] not null default '{}', source text not null default 'Manual', source_id text,
 attributes jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(company_id,id), unique(company_id,source,source_id),
 foreign key(company_id,stage_id) references public.hf_stages(company_id,id),
 check(email is null or email=lower(trim(email))), check(phone is null or phone ~ '^\+[1-9][0-9]{6,14}$')
);
create index hf_candidates_stage on public.hf_candidates(company_id,stage_id);
create index hf_candidates_phone on public.hf_candidates(company_id,phone) where phone is not null;
create index hf_candidates_email on public.hf_candidates(company_id,email) where email is not null;
create index hf_candidates_tags on public.hf_candidates using gin(tags);
create table public.hf_activities (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.hf_companies(id) on delete cascade,
 candidate_id uuid, kind text not null check(kind in ('sms','call','note','stage')),
 direction text check(direction in ('incoming','outgoing')), body text not null default '',
 phone text, email text, external_id text, actor_id uuid references auth.users(id),
 occurred_at timestamptz not null default now(), created_at timestamptz not null default now(),
 read_at timestamptz, metadata jsonb not null default '{}',
 foreign key(company_id,candidate_id) references public.hf_candidates(company_id,id),
 unique(company_id,external_id)
);
create index hf_activities_candidate on public.hf_activities(company_id,candidate_id,occurred_at desc);
create index hf_activities_signals on public.hf_activities(company_id,occurred_at desc) where kind in ('call','sms');
create table public.hf_integrations (
 company_id uuid primary key references public.hf_companies(id) on delete cascade,
 intake_key_hash text unique, quo_api_key text, quo_phone_id text, quo_phone text, quo_signing_secret text,
 last_intake_at timestamptz, last_quo_at timestamptz, updated_at timestamptz not null default now()
);

-- This narrow definer is necessary to inspect membership without recursive RLS.
create function hf_private.has_access(cid uuid, admin_only boolean default false) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.hf_members m
 where m.company_id=cid and m.user_id=auth.uid() and m.enabled and (not admin_only or m.role='admin'))
$$;
revoke all on function hf_private.has_access(uuid,boolean) from public,anon;
grant execute on function hf_private.has_access(uuid,boolean) to authenticated;

alter table public.hf_companies enable row level security;
alter table public.hf_members enable row level security;
alter table public.hf_invitations enable row level security;
alter table public.hf_stages enable row level security;
alter table public.hf_candidates enable row level security;
alter table public.hf_activities enable row level security;
alter table public.hf_integrations enable row level security;
revoke all on public.hf_companies,public.hf_members,public.hf_invitations,public.hf_stages,public.hf_candidates,public.hf_activities,public.hf_integrations from anon,authenticated;
grant select on public.hf_companies,public.hf_members,public.hf_stages,public.hf_candidates,public.hf_activities to authenticated;
grant all on public.hf_companies,public.hf_members,public.hf_invitations,public.hf_stages,public.hf_candidates,public.hf_activities,public.hf_integrations to service_role;
create policy member_read on public.hf_companies for select to authenticated using(hf_private.has_access(id));
create policy member_read on public.hf_members for select to authenticated using(hf_private.has_access(company_id));
create policy member_read on public.hf_stages for select to authenticated using(hf_private.has_access(company_id));
create policy member_read on public.hf_candidates for select to authenticated using(hf_private.has_access(company_id));
create policy member_read on public.hf_activities for select to authenticated using(hf_private.has_access(company_id));
-- Writes are server-only. The transaction below verifies live membership under a
-- company row lock, serializing revocation, invitations and candidate mutations.
create function public.hf_mutate(actor uuid, cid uuid, action text, payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare m public.hf_members; c public.hf_candidates; inv public.hf_invitations; item uuid; result jsonb; verified_email text;
begin
 select lower(email) into verified_email from auth.users where id=actor and email_confirmed_at is not null;
 if verified_email is null then raise exception 'Verified account required'; end if;
 if action='create_company' then
  insert into public.hf_companies(name,created_by) values(trim(payload->>'name'),actor) returning id into cid;
  insert into public.hf_members(company_id,user_id,email,role) values(cid,actor,verified_email,'admin');
  insert into public.hf_stages(company_id,name,position,color) values
   (cid,'Applied',0,'slate'),(cid,'Initial interview',1,'blue'),(cid,'Manager interview',2,'violet'),
   (cid,'Field trial',3,'amber'),(cid,'Hired',4,'green'),(cid,'Rejected',5,'red'),(cid,'Contact later',6,'slate');
  insert into public.hf_integrations(company_id) values(cid);
  return jsonb_build_object('id',cid);
 end if;
 if action='accept_invitation' then
  select * into inv from public.hf_invitations where token_hash=payload->>'token_hash';
  if inv.id is null then raise exception 'Invitation not found'; end if;
  cid:=inv.company_id;
 end if;
 perform 1 from public.hf_companies where id=cid for update;
 if not found then raise exception 'Company not found'; end if;
 if action='accept_invitation' then
  select * into inv from public.hf_invitations where id=inv.id for update;
  if inv.email<>verified_email or inv.expires_at<=now() or inv.revoked_at is not null then raise exception 'Invitation is expired or belongs to a different email'; end if;
  if inv.accepted_at is not null then return jsonb_build_object('id',cid); end if;
  if exists(select 1 from public.hf_members where company_id=cid and user_id=actor and not enabled) then raise exception 'Your membership is disabled. Contact an admin.'; end if;
  insert into public.hf_members(company_id,user_id,email,role) values(cid,actor,verified_email,inv.role) on conflict(company_id,user_id) do nothing;
  update public.hf_invitations set accepted_at=now() where id=inv.id;
  return jsonb_build_object('id',cid);
 end if;
 select * into m from public.hf_members where company_id=cid and user_id=actor and enabled;
 if m.user_id is null then raise exception 'Company access denied'; end if;
 if action in ('invite','revoke_invitation','member','stage_save','stage_delete','integration','rename_company') and m.role<>'admin' then raise exception 'Admin access required'; end if;
 case action
 when 'invite' then
  if exists(select 1 from public.hf_members where company_id=cid and email=payload->>'email') then raise exception 'This person is already a member. Manage their access in Team.'; end if;
  update public.hf_invitations set revoked_at=now() where company_id=cid and email=payload->>'email' and accepted_at is null and revoked_at is null;
  insert into public.hf_invitations(company_id,email,role,invited_by,token_hash) values(cid,payload->>'email',payload->>'role',actor,payload->>'token_hash') returning id into item;
 when 'revoke_invitation' then
  update public.hf_invitations set revoked_at=now() where company_id=cid and id=(payload->>'id')::uuid and accepted_at is null;
 when 'member' then
  item:=(payload->>'user_id')::uuid;
  if not exists(select 1 from public.hf_members where company_id=cid and user_id=item) then raise exception 'Member not found'; end if;
  if (payload->>'role'<>'admin' or not (payload->>'enabled')::boolean)
   and exists(select 1 from public.hf_members where company_id=cid and user_id=item and role='admin' and enabled)
   and (select count(*) from public.hf_members where company_id=cid and role='admin' and enabled)<2 then raise exception 'Keep at least one enabled admin'; end if;
  update public.hf_members set role=payload->>'role',enabled=(payload->>'enabled')::boolean where company_id=cid and user_id=item;
 when 'candidate_save' then
  item:=coalesce((payload->>'id')::uuid,gen_random_uuid());
  if payload->>'id' is not null and not exists(select 1 from public.hf_candidates where id=item and company_id=cid) then raise exception 'Candidate not found'; end if;
  select * into c from public.hf_candidates where id=item and company_id=cid;
  insert into public.hf_candidates(id,company_id,stage_id,name,email,phone,job_title,experience,tags)
   values(item,cid,(payload->>'stage_id')::uuid,payload->>'name',nullif(payload->>'email',''),nullif(payload->>'phone',''),payload->>'job_title',payload->>'experience',array(select jsonb_array_elements_text(payload->'tags')))
  on conflict(id) do update set stage_id=excluded.stage_id,name=excluded.name,email=excluded.email,phone=excluded.phone,job_title=excluded.job_title,experience=excluded.experience,tags=excluded.tags,updated_at=now();
  if c.id is not null and c.stage_id<>(payload->>'stage_id')::uuid then
   insert into public.hf_activities(company_id,candidate_id,kind,body,actor_id) select cid,item,'stage','Moved to '||name,actor from public.hf_stages where id=(payload->>'stage_id')::uuid and company_id=cid;
  end if;
 when 'move' then
  item:=(payload->>'id')::uuid;
  update public.hf_candidates set stage_id=(payload->>'stage_id')::uuid,updated_at=now() where id=item and company_id=cid and stage_id<>(payload->>'stage_id')::uuid;
  if found then insert into public.hf_activities(company_id,candidate_id,kind,body,actor_id) select cid,item,'stage','Moved to '||name,actor from public.hf_stages where id=(payload->>'stage_id')::uuid and company_id=cid; end if;
 when 'note' then
  insert into public.hf_activities(company_id,candidate_id,kind,body,actor_id) values(cid,(payload->>'candidate_id')::uuid,'note',payload->>'body',actor) returning id into item;
 when 'signal_link' then
  update public.hf_activities set candidate_id=(payload->>'candidate_id')::uuid where id=(payload->>'id')::uuid and company_id=cid and kind in ('sms','call');
 when 'signal_read' then
  update public.hf_activities set read_at=now() where id=(payload->>'id')::uuid and company_id=cid;
 when 'stage_save' then
  item:=coalesce((payload->>'id')::uuid,gen_random_uuid());
  if payload->>'id' is not null and not exists(select 1 from public.hf_stages where id=item and company_id=cid) then raise exception 'Stage not found'; end if;
  insert into public.hf_stages(id,company_id,name,position,color) values(item,cid,payload->>'name',(payload->>'position')::integer,payload->>'color')
  on conflict(id) do update set name=excluded.name,position=excluded.position,color=excluded.color;
 when 'stage_delete' then
  if (select count(*) from public.hf_stages where company_id=cid)<2 then raise exception 'Keep at least one stage'; end if;
  delete from public.hf_stages where id=(payload->>'id')::uuid and company_id=cid;
 when 'rename_company' then update public.hf_companies set name=trim(payload->>'name') where id=cid;
 when 'integration' then
  update public.hf_integrations set
   intake_key_hash=coalesce(payload->>'intake_key_hash',intake_key_hash),
   quo_api_key=coalesce(payload->>'quo_api_key',quo_api_key),
   quo_phone_id=coalesce(payload->>'quo_phone_id',quo_phone_id),
   quo_phone=coalesce(payload->>'quo_phone',quo_phone),
   quo_signing_secret=coalesce(payload->>'quo_signing_secret',quo_signing_secret),updated_at=now() where company_id=cid;
 else raise exception 'Unknown action';
 end case;
 return jsonb_build_object('id',item);
end $$;
revoke all on function public.hf_mutate(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.hf_mutate(uuid,uuid,text,jsonb) to service_role;

-- Atomic external ingestion. Server authenticates Quo signatures or intake token.
create function public.hf_ingest(cid uuid, event_kind text, payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare item uuid; sid uuid; matches uuid[];
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not found then raise exception 'Company not found'; end if;
 if event_kind='intake' then
  select id into item from public.hf_candidates where company_id=cid and source=payload->>'source' and source_id=payload->>'source_id';
  if item is not null then return jsonb_build_object('id',item,'duplicate',true); end if;
  select id into sid from public.hf_stages where company_id=cid order by position,id limit 1;
  insert into public.hf_candidates(company_id,stage_id,name,email,phone,job_title,experience,tags,source,source_id,attributes)
   values(cid,sid,payload->>'name',nullif(payload->>'email',''),nullif(payload->>'phone',''),payload->>'job_title',payload->>'experience',array(select jsonb_array_elements_text(payload->'tags')),payload->>'source',payload->>'source_id',payload->'attributes') returning id into item;
  update public.hf_integrations set last_intake_at=now() where company_id=cid;
 elsif event_kind='quo' then
  select array_agg(id) into matches from public.hf_candidates where company_id=cid and
   ((nullif(payload->>'phone','') is not null and phone=payload->>'phone') or (nullif(payload->>'email','') is not null and email=payload->>'email'));
  -- Only hiring contacts: a shared production line also contains customer calls.
  if coalesce(array_length(matches,1),0)=0 then return jsonb_build_object('ignored',true); end if;
  item:=case when array_length(matches,1)=1 then matches[1] else null end;
  insert into public.hf_activities(company_id,candidate_id,kind,direction,body,phone,email,external_id,occurred_at,metadata)
   values(cid,item,payload->>'kind',payload->>'direction',payload->>'body',payload->>'phone',payload->>'email',payload->>'external_id',(payload->>'occurred_at')::timestamptz,coalesce(payload->'metadata','{}'))
   on conflict(company_id,external_id) do nothing;
  update public.hf_integrations set last_quo_at=now() where company_id=cid;
 else raise exception 'Unknown event kind'; end if;
 return jsonb_build_object('id',item);
end $$;
revoke all on function public.hf_ingest(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.hf_ingest(uuid,text,jsonb) to service_role;

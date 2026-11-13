-- Direct Meta intake. Credentials and delivery state are server-only; no client writes.
create table public.hf_meta_connections (
 company_id uuid primary key references public.hf_companies(id) on delete cascade,
 page_id text not null unique, page_name text not null, app_id text not null,
 credentials text, verify_hash text not null,
 connected_by uuid not null references auth.users(id),
 settings jsonb not null default '{"forms":[],"notification_email":"","sender_name":"Hiring"}',
 active boolean not null default false, notify_after timestamptz,
 last_received_at timestamptz, last_polled_at timestamptz, last_error text,
 updated_at timestamptz not null default now(),
 check(page_id ~ '^\d{1,40}$' and app_id ~ '^\d{1,40}$')
);
create table public.hf_meta_leads (
 company_id uuid not null references public.hf_companies(id) on delete cascade,
 lead_id text not null, page_id text not null, form_id text not null,
 form jsonb not null, settings jsonb not null, notify_after timestamptz,
 candidate_id uuid, application jsonb,
 state text not null default 'queued' check(state in ('queued','processing','complete','failed')),
 email_state text not null default 'pending' check(email_state in ('pending','sending','sent','skipped','uncertain')),
 sms_state text not null default 'pending' check(sms_state in ('pending','sending','sent','skipped','uncertain')),
 email_receipt text, sms_receipt text, last_error text,
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 lease_id uuid, lease_until timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(company_id,lead_id),
 foreign key(company_id,candidate_id) references public.hf_candidates(company_id,id) on delete cascade,
 check(lead_id ~ '^\d{1,40}$' and page_id ~ '^\d{1,40}$' and form_id ~ '^\d{1,40}$')
);
create index hf_meta_leads_due on public.hf_meta_leads(next_attempt_at) where state in ('queued','processing');
create index hf_meta_leads_candidate on public.hf_meta_leads(company_id,candidate_id);
create index hf_meta_connections_admin on public.hf_meta_connections(connected_by);
alter table public.hf_meta_connections enable row level security;
alter table public.hf_meta_leads enable row level security;
revoke all on public.hf_meta_connections,public.hf_meta_leads from public,anon,authenticated;
grant all on public.hf_meta_connections,public.hf_meta_leads to service_role;

create function public.hf_meta_set(actor uuid,cid uuid,operation text,payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.hf_meta_connections; rules jsonb;
begin
 perform 1 from public.hf_companies where id=cid for update;
 perform 1 from public.hf_members where company_id=cid and user_id=actor and enabled and role='admin' for update;
 if not found then raise exception 'Admin access required'; end if;
 select * into c from public.hf_meta_connections where company_id=cid for update;
 if operation='connect' then
  insert into public.hf_meta_connections(company_id,page_id,page_name,app_id,credentials,verify_hash,connected_by)
   values(cid,payload->>'page_id',payload->>'page_name',payload->>'app_id',payload->>'credentials',payload->>'verify_hash',actor)
   on conflict(company_id) do update set page_id=excluded.page_id,page_name=excluded.page_name,app_id=excluded.app_id,
    credentials=excluded.credentials,verify_hash=excluded.verify_hash,connected_by=actor,active=false,notify_after=null,
    settings=case when c.page_id=excluded.page_id then c.settings else excluded.settings end,last_error=null,updated_at=now();
 elsif operation='settings' then
  rules:=payload->'forms';
  if jsonb_typeof(rules) is distinct from 'array' or jsonb_array_length(rules) not between 1 and 50 then raise exception 'Select hiring forms'; end if;
  if (select count(*)<>count(distinct f->>'id') from jsonb_array_elements(rules) f) then raise exception 'Duplicate form'; end if;
  update public.hf_meta_connections set settings=payload,updated_at=now() where company_id=cid and credentials is not null;
  if not found then raise exception 'Connect Meta first'; end if;
 elsif operation='activate' then
  if c.credentials is null or jsonb_array_length(c.settings->'forms')=0 then raise exception 'Connect Meta and select hiring forms first'; end if;
  update public.hf_meta_connections set active=true,notify_after=now(),connected_by=actor,updated_at=now() where company_id=cid;
 elsif operation='pause' then
  update public.hf_meta_connections set active=false,updated_at=now() where company_id=cid;
 elsif operation='disconnect' then
  update public.hf_meta_connections set credentials=null,active=false,notify_after=null,updated_at=now() where company_id=cid;
 elsif operation='retry' then
  -- Uncertain sends are deliberately not reset. Checking the provider is required before any resend.
  update public.hf_meta_leads set state='queued',attempts=0,next_attempt_at=now(),last_error=null,updated_at=now()
   where company_id=cid and state='failed';
 elsif operation='polled' then
  if c.updated_at is distinct from (payload->>'generation')::timestamptz or c.credentials is null then return null; end if;
  update public.hf_meta_connections set last_error=payload->>'error',
   last_polled_at=coalesce((payload->>'polled_at')::timestamptz,last_polled_at) where company_id=cid;
 else raise exception 'Unknown Meta operation'; end if;
 return jsonb_build_object('saved',true);
end $$;

create function public.hf_meta_enqueue(page text,form_id text,lead text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare c public.hf_meta_connections; rule jsonb;
begin
 select * into c from public.hf_meta_connections where page_id=page and credentials is not null;
 if not found then return false; end if;
 perform 1 from public.hf_companies where id=c.company_id for update;
 select * into c from public.hf_meta_connections where page_id=page and credentials is not null for share;
 if not found then return false; end if;
 perform 1 from public.hf_members where company_id=c.company_id and user_id=c.connected_by and enabled and role='admin' for share;
 if not found then return false; end if;
 select f into rule from jsonb_array_elements(c.settings->'forms') f where f->>'id'=form_id;
 if rule is null then return false; end if;
 insert into public.hf_meta_leads(company_id,page_id,form_id,lead_id,form,settings,notify_after)
  values(c.company_id,page,form_id,lead,rule,c.settings,case when c.active then c.notify_after else null end)
  on conflict do nothing;
 update public.hf_meta_connections set last_received_at=now() where company_id=c.company_id;
 return true;
end $$;

create function public.hf_meta_claim(cid uuid default null)
returns setof public.hf_meta_leads language sql security invoker set search_path='' as $$
 with due as (
  select l.company_id,l.lead_id from public.hf_meta_leads l
  join public.hf_meta_connections c on c.company_id=l.company_id and c.page_id=l.page_id and c.credentials is not null
  join public.hf_members m on m.company_id=c.company_id and m.user_id=c.connected_by and m.enabled and m.role='admin'
  where (cid is null or l.company_id=cid) and l.state in ('queued','processing') and l.attempts<10
   and l.next_attempt_at<=now() and (l.lease_until is null or l.lease_until<now())
  order by l.next_attempt_at limit 1 for update of l skip locked
 )
 update public.hf_meta_leads l set state='processing',lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes',
  attempts=l.attempts+1,updated_at=now(),
  email_state=case when l.email_state='sending' then 'uncertain' else l.email_state end,
  sms_state=case when l.sms_state='sending' then 'uncertain' else l.sms_state end
 from due where l.company_id=due.company_id and l.lead_id=due.lead_id returning l.*
$$;

create function public.hf_meta_step(cid uuid,lead text,worker uuid,operation text,payload jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.hf_meta_connections; l public.hf_meta_leads; ingested jsonb; deliver boolean;
begin
 -- The same company lock as ordinary intake serializes identity checks and connection changes.
 perform 1 from public.hf_companies where id=cid for update;
 select * into c from public.hf_meta_connections where company_id=cid and credentials is not null for share;
 if not found then return null; end if;
 perform 1 from public.hf_members where company_id=cid and user_id=c.connected_by and enabled and role='admin' for share;
 if not found then return null; end if;
 select * into l from public.hf_meta_leads where company_id=cid and lead_id=lead and page_id=c.page_id
  and lease_id=worker and lease_until>now() and state='processing' for update;
 if not found then return null; end if;
 if operation='ingest' then
  if payload->>'source' is distinct from 'Meta' or payload->>'source_id' is distinct from lead
   or payload->'attributes'->>'Meta form ID' is distinct from l.form_id then raise exception 'Invalid Meta submission'; end if;
  if l.application is null then
   ingested:=public.hf_ingest(cid,'intake',payload);
   deliver:=c.active and l.notify_after is not null and (payload->'attributes'->>'Applied at')::timestamptz>=l.notify_after
    and not coalesce((ingested->>'duplicate')::boolean,false);
   update public.hf_meta_leads set candidate_id=(ingested->>'id')::uuid,application=payload,
    email_state=case when deliver and nullif(l.settings->>'notification_email','') is not null then 'pending' else 'skipped' end,
    sms_state=case when deliver and nullif(l.form->>'sms','') is not null and nullif(payload->>'phone','') is not null then 'pending' else 'skipped' end
    where company_id=cid and lead_id=lead returning * into l;
  end if;
 elsif operation in ('email_start','sms_start') then
  if l.application is null or not c.active then return null; end if;
  if operation='email_start' and l.email_state='pending' then
   update public.hf_meta_leads set email_state='sending' where company_id=cid and lead_id=lead;
  elsif operation='sms_start' and l.sms_state='pending' then
   update public.hf_meta_leads set sms_state='sending' where company_id=cid and lead_id=lead;
  else return null; end if;
 elsif operation in ('email_finish','sms_finish') then
  if payload->>'state' not in ('sent','pending','uncertain') then raise exception 'Invalid delivery state'; end if;
  if operation='email_finish' and l.email_state='sending' then
   update public.hf_meta_leads set email_state=payload->>'state',email_receipt=payload->>'receipt',last_error=coalesce(payload->>'error',last_error) where company_id=cid and lead_id=lead;
  elsif operation='sms_finish' and l.sms_state='sending' then
   update public.hf_meta_leads set sms_state=payload->>'state',sms_receipt=payload->>'receipt',last_error=coalesce(payload->>'error',last_error) where company_id=cid and lead_id=lead;
  else return null; end if;
 elsif operation='release' then
  update public.hf_meta_leads set
   state=case when application is not null and email_state in ('sent','skipped','uncertain') and sms_state in ('sent','skipped','uncertain') then 'complete' when attempts>=10 then 'failed' else 'queued' end,
   last_error=coalesce(payload->>'error',last_error),lease_id=null,lease_until=null,
   next_attempt_at=now()+least(3600,30*power(2,least(attempts,7))) * interval '1 second',updated_at=now()
   where company_id=cid and lead_id=lead;
 else raise exception 'Unknown Meta step'; end if;
 return coalesce(to_jsonb(l),'{}');
end $$;
revoke all on function public.hf_meta_set(uuid,uuid,text,jsonb),public.hf_meta_enqueue(text,text,text),public.hf_meta_claim(uuid),public.hf_meta_step(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.hf_meta_set(uuid,uuid,text,jsonb),public.hf_meta_enqueue(text,text,text),public.hf_meta_claim(uuid),public.hf_meta_step(uuid,text,uuid,text,jsonb) to service_role;

-- Recover an exhausted crashed lease and reject settings validated against an older connection.
create or replace function public.hf_meta_claim(cid uuid default null)
returns setof public.hf_meta_leads language sql security invoker set search_path='' as $$
 with expired as (
  update public.hf_meta_leads set state='failed',lease_id=null,lease_until=null,updated_at=now(),
   email_state=case when email_state='sending' then 'uncertain' else email_state end,
   sms_state=case when sms_state='sending' then 'uncertain' else sms_state end,
   last_error='Processing stopped after ten attempts. Check delivery before retrying.'
  where (cid is null or company_id=cid) and state='processing' and attempts>=10 and lease_until<now()
 ), due as (
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


create or replace function public.hf_meta_set(actor uuid,cid uuid,operation text,payload jsonb)
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
  if payload ? 'generation' and c.updated_at is distinct from (payload->>'generation')::timestamptz then raise exception 'Connection changed. Reload settings'; end if;
  payload:=payload-'generation';
  rules:=payload->'forms';
  if jsonb_typeof(rules) is distinct from 'array' or jsonb_array_length(rules) not between 1 and 50 then raise exception 'Select hiring forms'; end if;
  if (select count(*)<>count(distinct f->>'id') from jsonb_array_elements(rules) f) then raise exception 'Duplicate form'; end if;
  update public.hf_meta_connections set settings=payload,updated_at=now() where company_id=cid and credentials is not null;
  if not found then raise exception 'Connect Meta first'; end if;
 elsif operation='activate' then
  if payload ? 'generation' and c.updated_at is distinct from (payload->>'generation')::timestamptz then raise exception 'Connection changed. Reload settings'; end if;
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

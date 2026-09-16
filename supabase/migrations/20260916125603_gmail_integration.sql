-- Gmail credentials and synchronization state are server-only, scoped to one company.
alter table public.hf_activities drop constraint hf_activities_kind_check;
alter table public.hf_activities add constraint hf_activities_kind_check check(kind in ('sms','call','note','stage','email'));
create table public.hf_gmail_connections (
 company_id uuid primary key references public.hf_companies(id) on delete cascade,
 generation uuid not null default gen_random_uuid(), mailbox text not null,
 credentials text, connected_by uuid references auth.users(id) on delete set null,
 history_id text, history_page text, bootstrap_page text, bootstrap_started boolean not null default false,
 synced_at timestamptz, last_error text, lease_id uuid, lease_until timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(mailbox=lower(trim(mailbox)))
);
alter table public.hf_gmail_connections enable row level security;
revoke all on public.hf_gmail_connections from anon,authenticated;
grant all on public.hf_gmail_connections to service_role;

create function public.hf_gmail_set(actor uuid,cid uuid,mailbox_address text,encrypted_credentials text)
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled and role='admin') then raise exception 'Admin access required'; end if;
 if encrypted_credentials is null then
  update public.hf_gmail_connections set credentials=null,generation=gen_random_uuid(),lease_id=null,lease_until=null,last_error=null,updated_at=now() where company_id=cid;
 else
  if coalesce(mailbox_address,'')='' then raise exception 'Mailbox required'; end if;
  insert into public.hf_gmail_connections(company_id,mailbox,credentials,connected_by)
   values(cid,lower(trim(mailbox_address)),encrypted_credentials,actor)
   on conflict(company_id) do update set mailbox=excluded.mailbox,credentials=excluded.credentials,connected_by=actor,
    generation=gen_random_uuid(),history_id=null,history_page=null,bootstrap_page=null,bootstrap_started=false,synced_at=null,last_error=null,lease_id=null,lease_until=null,updated_at=now();
 end if;
end $$;
revoke all on function public.hf_gmail_set(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.hf_gmail_set(uuid,uuid,text,text) to service_role;

create function public.hf_gmail_claim(cid uuid,actor uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare connection public.hf_gmail_connections;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if actor is not null and not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled and role='admin') then raise exception 'Admin access required'; end if;
 update public.hf_gmail_connections set lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes'
  where company_id=cid and credentials is not null and (lease_until is null or lease_until<now()) returning * into connection;
 if not found then return null; end if;
 return to_jsonb(connection);
end $$;
revoke all on function public.hf_gmail_claim(uuid,uuid) from public,anon,authenticated;
grant execute on function public.hf_gmail_claim(uuid,uuid) to service_role;

create function public.hf_gmail_ingest(cid uuid,connection_generation uuid,worker uuid,payload jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare item uuid; matches uuid[]; matched uuid;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_gmail_connections where company_id=cid and generation=connection_generation and credentials is not null and lease_id=worker and lease_until>now()) then raise exception 'Gmail connection changed'; end if;
 select array_agg(id) into matches from public.hf_candidates where company_id=cid and email in (select jsonb_array_elements_text(payload->'contact_emails'));
 matched:=case when array_length(matches,1)=1 then matches[1] else null end;
 insert into public.hf_activities(company_id,candidate_id,kind,direction,body,email,external_id,occurred_at,metadata)
  values(cid,matched,'email',payload->>'direction',payload->>'body',payload->>'email',payload->>'external_id',(payload->>'occurred_at')::timestamptz,payload->'metadata')
  on conflict(company_id,external_id) do nothing returning id into item;
 if item is null then select id into item from public.hf_activities where company_id=cid and external_id=payload->>'external_id'; end if;
 return item;
end $$;
revoke all on function public.hf_gmail_ingest(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.hf_gmail_ingest(uuid,uuid,uuid,jsonb) to service_role;

-- Private attachment objects are served only after current company-membership checks.
insert into storage.buckets(id,name,public,file_size_limit) values('hf-mail-attachments','hf-mail-attachments',false,26214400)
on conflict(id) do nothing;

-- Extend the existing atomic, membership-checked linking action to email signals.
do $$
declare definition text;
begin
 select pg_get_functiondef('public.hf_mutate(uuid,uuid,text,jsonb)'::regprocedure) into definition;
 if strpos(definition, 'kind in (''sms'',''call'')')=0 then raise exception 'Expected signal-link definition not found'; end if;
 execute replace(definition, 'kind in (''sms'',''call'')', 'kind in (''sms'',''call'',''email'')');
end $$;

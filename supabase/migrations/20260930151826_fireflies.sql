-- Credentials are encrypted by the server; browsers receive connection status only.
create table public.hf_fireflies_connections (
 company_id uuid primary key references public.hf_companies(id) on delete cascade,
 credentials text not null, account text not null,
 connected_by uuid not null references auth.users(id), generation uuid not null default gen_random_uuid(), test_requested_at timestamptz
);
alter table public.hf_fireflies_connections enable row level security;
revoke all on public.hf_fireflies_connections from anon,authenticated;
grant all on public.hf_fireflies_connections to service_role;
alter table public.hf_interview_recordings add column fireflies_id text, add column provider_title text,
 add column transcript jsonb, add column has_video boolean not null default false;
create unique index hf_fireflies_transcript on public.hf_interview_recordings(company_id,fireflies_id) where fireflies_id is not null;

create function public.hf_fireflies_set(actor uuid,cid uuid,encrypted_key text,mailbox text)
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled and role='admin') then raise exception 'Admin access required'; end if;
 if encrypted_key is null then delete from public.hf_fireflies_connections where company_id=cid;
 else insert into public.hf_fireflies_connections(company_id,credentials,account,connected_by)
 values(cid,encrypted_key,mailbox,actor) on conflict(company_id) do update set credentials=excluded.credentials,account=excluded.account,connected_by=actor,generation=gen_random_uuid(); end if;
end $$;

-- Reserve before sending. A provider timeout is ambiguous: never automatically resend that conference.
create function public.hf_fireflies_claim(cid uuid,sid uuid,conference_name text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.hf_interviews; c public.hf_fireflies_connections; visit text; marker text;
begin
 perform 1 from public.hf_companies where id=cid for update;
 select * into c from public.hf_fireflies_connections where company_id=cid;
 if not found or not exists(select 1 from public.hf_members where company_id=cid and user_id=c.connected_by and enabled and role='admin') then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended(c.account,0));
 select * into s from public.hf_interviews where company_id=cid and id=sid;
 if not found or not s.auto_record or s.cancel_requested or s.status<>'scheduled' or s.meet_url is null
 or s.starts_at>now()+interval '15 minutes' or s.ends_at<now()-interval '2 hours'
 or not exists(select 1 from public.hf_members where company_id=cid and user_id=s.updated_by and enabled)
 or exists(select 1 from unnest(s.interviewer_ids) u where not exists(select 1 from public.hf_members m where m.company_id=cid and m.user_id=u and m.enabled)) then return null; end if;
 visit:='fireflies:'||conference_name;
 if exists(select 1 from public.hf_interview_recordings where company_id=cid and name=visit) then return null; end if;
 -- The limit belongs to the Fireflies account, even if connected to several companies.
 if (select count(*) from public.hf_interview_recordings r join public.hf_fireflies_connections f using(company_id)
 where f.account=c.account and r.provider_title is not null and r.created_at>now()-interval '20 minutes')+(select count(*) from public.hf_fireflies_connections where account=c.account and test_requested_at>now()-interval '20 minutes')>=3 then raise exception 'Fireflies join limit reached. Try after 20 minutes.'; end if;
 marker:='HireFlow '||gen_random_uuid()::text;
 insert into public.hf_interview_recordings(company_id,interview_id,name,state,meet_url,provider_title,planned_start,join_at)
 values(cid,sid,visit,'joining',s.meet_url,marker,s.starts_at,now());
 return jsonb_build_object('name',visit,'title',marker,'meet_url',s.meet_url,'credentials',c.credentials,'duration',least(120,greatest(15,ceil(extract(epoch from(s.ends_at-now()))/60)::integer)));
end $$;
revoke all on function public.hf_fireflies_set(uuid,uuid,text,text),public.hf_fireflies_claim(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.hf_fireflies_set(uuid,uuid,text,text),public.hf_fireflies_claim(uuid,uuid,text) to service_role;

create function public.hf_fireflies_test(actor uuid,cid uuid)
returns text language plpgsql security invoker set search_path='' as $$
declare c public.hf_fireflies_connections;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled and role='admin') then raise exception 'Admin access required'; end if;
 select * into c from public.hf_fireflies_connections where company_id=cid;
 if not found then raise exception 'Connect Fireflies first'; end if;
 perform pg_advisory_xact_lock(hashtextextended(c.account,0));
 if exists(select 1 from public.hf_fireflies_connections where account=c.account and test_requested_at>now()-interval '20 minutes')
 or (select count(*) from public.hf_interview_recordings r join public.hf_fireflies_connections f using(company_id) where f.account=c.account and r.provider_title is not null and r.created_at>now()-interval '20 minutes')>=3 then raise exception 'Wait 20 minutes before sending another test recorder'; end if;
 update public.hf_fireflies_connections set test_requested_at=now() where company_id=cid;
 return c.credentials;
end $$;
revoke all on function public.hf_fireflies_test(uuid,uuid) from public,anon,authenticated;
grant execute on function public.hf_fireflies_test(uuid,uuid) to service_role;

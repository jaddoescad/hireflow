-- A calendar request and a live Meet event share one recorder reservation.
alter table public.hf_interview_recordings add column fireflies_conference text;
update public.hf_interview_recordings set fireflies_conference=substring(name from 10)
 where provider_title is not null and name like 'fireflies:conferenceRecords/%';
create unique index hf_fireflies_conference on public.hf_interview_recordings(company_id,fireflies_conference)
 where fireflies_conference is not null;

-- No schedule-based restrictions on a live interview recorder request.
-- Recording is automatic for all eligible HireFlow interviews when the company connects Fireflies.
-- Ignore the legacy per-interview auto_record field, including on existing interviews.
create or replace function public.hf_fireflies_claim(cid uuid,sid uuid,conference_name text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.hf_interviews; c public.hf_fireflies_connections; visit text; marker text; pending text; scheduled boolean:=conference_name='scheduled';
begin
 perform 1 from public.hf_companies where id=cid for update;
 select * into c from public.hf_fireflies_connections where company_id=cid;
 if not found or not exists(select 1 from public.hf_members where company_id=cid and user_id=c.connected_by and enabled and role='admin') then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended(c.account,0));
 select * into s from public.hf_interviews where company_id=cid and id=sid;
 if not found or s.cancel_requested or s.status<>'scheduled' or s.meet_url is null
 or not exists(select 1 from public.hf_members where company_id=cid and user_id=s.updated_by and enabled)
 or exists(select 1 from unnest(s.interviewer_ids) u where not exists(select 1 from public.hf_members m where m.company_id=cid and m.user_id=u and m.enabled)) then return null; end if;
 if scheduled then
  if s.synced_version<>s.version or s.starts_at<now() or s.starts_at>now()+interval '5 minutes' then return null; end if;
  visit:='fireflies:scheduled:'||sid::text||':'||s.starts_at::text;
  -- An early live call already requested its recorder for this calendar occurrence.
  if exists(select 1 from public.hf_interview_recordings where company_id=cid and interview_id=sid
    and planned_start=s.starts_at and provider_title is not null and created_at>now()-interval '10 minutes') then return null; end if;
 else
  visit:='fireflies:'||conference_name;
  if exists(select 1 from public.hf_interview_recordings where company_id=cid and fireflies_conference=conference_name) then return null; end if;
  -- Keep the provider title and row name stable while the request is in flight.
  select name into pending from public.hf_interview_recordings where company_id=cid and interview_id=sid
   and fireflies_conference is null and name like 'fireflies:scheduled:%' and meet_url=s.meet_url
   and state in ('joining','waiting') and created_at>now()-interval '10 minutes'
   order by created_at desc limit 1;
  if pending is not null then
   update public.hf_interview_recordings set fireflies_conference=conference_name where company_id=cid and name=pending;
   return null;
  end if;
 end if;
 if exists(select 1 from public.hf_interview_recordings where company_id=cid and name=visit) then return null; end if;
 -- The limit belongs to the Fireflies account, even if connected to several companies.
 if (select count(*) from public.hf_interview_recordings r join public.hf_fireflies_connections f using(company_id)
 where f.account=c.account and r.provider_title is not null and r.created_at>now()-interval '20 minutes')+(select count(*) from public.hf_fireflies_connections where account=c.account and test_requested_at>now()-interval '20 minutes')>=3 then raise exception 'Fireflies join limit reached. Try after 20 minutes.'; end if;
 marker:='HireFlow '||gen_random_uuid()::text;
 insert into public.hf_interview_recordings(company_id,interview_id,name,state,meet_url,provider_title,planned_start,join_at,fireflies_conference)
 values(cid,sid,visit,'joining',s.meet_url,marker,s.starts_at,now(),case when scheduled then null else conference_name end);
 return jsonb_build_object('name',visit,'title',marker,'meet_url',s.meet_url,'credentials',c.credentials,'duration',120);
end $$;

-- Recovery polling covers every scheduled interview regardless of its calendar date.
create or replace function public.hf_meet_due(cid uuid,address text,skip uuid[],max_rows integer)
returns setof public.hf_interviews language sql security invoker set search_path='' as $$
 select * from public.hf_interviews where company_id=cid and organizer=address and not (id=any(skip))
 and (version<>synced_version or organizer_notified_version<synced_version or status='scheduled'
 or (status='cancelled' and meeting_started_at is not null and ends_at>now()-interval '3 days'))
 order by version<>synced_version desc,(status='scheduled' and starts_at between now() and now()+interval '5 minutes') desc,synced_at nulls first limit max_rows
$$;

-- Keep each attempt for transcript correlation; allow one verified late-arrival replacement.
drop index public.hf_fireflies_conference;
create index hf_fireflies_conference on public.hf_interview_recordings(company_id,fireflies_conference) where fireflies_conference is not null;
-- Correct the legacy prefix offset without changing opaque provider titles.
update public.hf_interview_recordings set fireflies_conference=substring(name from 11)
where name like 'fireflies:conferenceRecords/%' and fireflies_conference like ':conferenceRecords/%';
drop function public.hf_fireflies_claim(uuid,uuid,text);
create or replace function public.hf_fireflies_claim(cid uuid,sid uuid,conference_name text,recovery_name text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.hf_interviews; c public.hf_fireflies_connections; visit text; marker text; pending text; scheduled boolean:=conference_name='scheduled'; previous public.hf_interview_recordings;
begin
 perform 1 from public.hf_companies where id=cid for update;
 select * into c from public.hf_fireflies_connections where company_id=cid;
 if not found or not exists(select 1 from public.hf_members where company_id=cid and user_id=c.connected_by and enabled and role='admin') then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended(c.account,0));
 select * into s from public.hf_interviews where company_id=cid and id=sid;
 if not found or s.cancel_requested or s.status<>'scheduled' or s.meet_url is null
 or not exists(select 1 from public.hf_members where company_id=cid and user_id=s.updated_by and enabled)
 or exists(select 1 from unnest(s.interviewer_ids) u where not exists(select 1 from public.hf_members m where m.company_id=cid and m.user_id=u and m.enabled)) then return null; end if;
 if recovery_name is not null then
  if scheduled then return null; end if;
  select * into previous from public.hf_interview_recordings where company_id=cid and interview_id=sid and name=recovery_name for update;
  if not found or previous.meet_url<>s.meet_url or previous.join_at>now()-interval '13 minutes'
    or previous.join_at is null or previous.fireflies_id is not null
    or (previous.fireflies_conference is not null and previous.fireflies_conference<>conference_name)
    or not (previous.state='waiting' or previous.state='failed' and previous.error='Recorder waiting period ended without a recording.') then return null; end if;
  -- Atomic stale-proof and one-replacement checks, including simultaneous event deliveries.
  if exists(select 1 from public.hf_interview_recordings where company_id=cid and interview_id=sid
    and provider_title is not null and created_at>previous.created_at)
    or (select count(*) from public.hf_interview_recordings where company_id=cid and fireflies_conference=conference_name)>1 then return null; end if;
  update public.hf_interview_recordings set state='failed',error='Recorder waiting period ended without a recording.',fireflies_conference=conference_name,updated_at=now()
    where company_id=cid and name=recovery_name;
  visit:='fireflies:recovery:'||gen_random_uuid()::text;
 elsif scheduled then
  if s.synced_version<>s.version or s.starts_at<now() or s.starts_at>now()+interval '2 minutes' then return null; end if;
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
   and state in ('joining','waiting') and created_at>now()-interval '13 minutes'
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


revoke all on function public.hf_fireflies_claim(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.hf_fireflies_claim(uuid,uuid,text,text) to service_role;

create function public.hf_fireflies_expire(cid uuid,sid uuid,visit_name text)
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_fireflies_connections c join public.hf_members m
   on m.company_id=c.company_id and m.user_id=c.connected_by where c.company_id=cid and m.enabled and m.role='admin') then return; end if;
 update public.hf_interview_recordings r set state='failed',error='Recorder waiting period ended without a recording.',updated_at=now()
 where r.company_id=cid and r.interview_id=sid and r.name=visit_name and r.state='waiting'
 and r.fireflies_id is null and r.join_at<now()-interval '13 minutes'
 and exists(select 1 from public.hf_interviews i join public.hf_members m on m.company_id=i.company_id and m.user_id=i.updated_by
   where i.company_id=cid and i.id=sid and i.status='scheduled' and not i.cancel_requested and m.enabled
   and not exists(select 1 from unnest(i.interviewer_ids) u where not exists(select 1 from public.hf_members a where a.company_id=cid and a.user_id=u and a.enabled)));
end $$;
revoke all on function public.hf_fireflies_expire(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.hf_fireflies_expire(uuid,uuid,text) to service_role;

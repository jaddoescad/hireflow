-- Recording is automatic for all eligible HireFlow interviews when the company connects Fireflies.
-- Ignore the legacy per-interview auto_record field, including on existing interviews.
create or replace function public.hf_fireflies_claim(cid uuid,sid uuid,conference_name text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.hf_interviews; c public.hf_fireflies_connections; visit text; marker text;
begin
 perform 1 from public.hf_companies where id=cid for update;
 select * into c from public.hf_fireflies_connections where company_id=cid;
 if not found or not exists(select 1 from public.hf_members where company_id=cid and user_id=c.connected_by and enabled and role='admin') then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended(c.account,0));
 select * into s from public.hf_interviews where company_id=cid and id=sid;
 if not found or s.cancel_requested or s.status<>'scheduled' or s.meet_url is null
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

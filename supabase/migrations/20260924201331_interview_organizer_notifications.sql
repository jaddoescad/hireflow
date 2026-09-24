-- Delivery is separate from Calendar sync, so an email failure cannot unschedule an interview.
alter table public.hf_interviews
 add column organizer_notified_version integer not null default 0 check(organizer_notified_version>=0),
 add column organizer_notification_error text;

-- Do not email historical interviews when this feature is deployed.
update public.hf_interviews set organizer_notified_version=synced_version;

create or replace function public.hf_meet_due(cid uuid,address text,skip uuid[],max_rows integer)
returns setof public.hf_interviews language sql security invoker set search_path='' as $$
 select * from public.hf_interviews where company_id=cid and organizer=address and not (id=any(skip))
  and (version<>synced_version or organizer_notified_version<synced_version
   or (starts_at<now()+interval '60 days' and ends_at>now()-interval '3 days'
    and (status='scheduled' or (status='cancelled' and meeting_started_at is not null))))
 order by version<>synced_version desc,synced_at nulls first limit max_rows
$$;

-- Only the leased worker may prepare/acknowledge a confirmation. Client-supplied recipients are never accepted.
create function public.hf_interview_notification(cid uuid,generation_id uuid,worker uuid,sid uuid,revision integer,outcome jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.hf_interviews; candidate_name text;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_meet_connections c join public.hf_members m on m.company_id=c.company_id and m.user_id=c.connected_by
  where c.company_id=cid and c.generation=generation_id and c.lease_id=worker and c.lease_until>now()+interval '30 seconds'
   and c.credentials is not null and m.enabled and m.role='admin')
 then raise exception 'Google connection changed'; end if;
 select i.* into s from public.hf_interviews i join public.hf_meet_connections c on c.company_id=i.company_id and c.organizer=i.organizer
  where i.company_id=cid and i.id=sid for update of i;
 if s.id is null or s.version<>revision or s.synced_version<>revision or s.organizer_notified_version>=revision
  or s.status='pending' or (s.cancel_requested and s.status<>'cancelled') or s.last_error is not null then return null; end if;
 if not exists(select 1 from public.hf_members where company_id=cid and user_id=s.updated_by and enabled) then return null; end if;
 if s.status<>'cancelled' and exists(select 1 from unnest(s.interviewer_ids) as x
  where not exists(select 1 from public.hf_members where company_id=cid and user_id=x and enabled)) then return null; end if;
 if outcome is not null then
  if coalesce((outcome->>'sent')::boolean,false) then
   update public.hf_interviews set organizer_notified_version=revision,organizer_notification_error=null where company_id=cid and id=sid;
  else
   update public.hf_interviews set organizer_notification_error=left(outcome->>'error',500) where company_id=cid and id=sid;
  end if;
  return null;
 end if;
 select name into candidate_name from public.hf_candidates where company_id=cid and id=s.candidate_id;
 if candidate_name is null then return null; end if;
 return jsonb_build_object('id',s.id,'company_id',cid,'version',s.version,'title',s.title,'organizer',s.organizer,
  'starts_at',s.starts_at,'ends_at',s.ends_at,'timezone',s.timezone,'status',s.status,'meet_url',s.meet_url,
  'organizer_notified_version',s.organizer_notified_version,'candidate_name',candidate_name);
end $$;
revoke all on function public.hf_interview_notification(uuid,uuid,uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.hf_interview_notification(uuid,uuid,uuid,uuid,integer,jsonb) to service_role;

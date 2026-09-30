-- Interviews are recorded by a meeting bot (Recall.ai) that asks to join like a guest, instead of by Google Meet.
-- Google recording setup, recording events and Drive copies are removed. Videos already saved to storage stay.

-- Recordings that were never saved to storage remain in the organizer's Google Drive; HireFlow stops listing them.
delete from public.hf_interview_recordings where storage_key is null;
drop function public.hf_recording_claim(integer);
drop index public.hf_interview_recordings_unstored;
alter table public.hf_interview_recordings
 drop column conference, drop column drive_file_id, drop column playback_url,
 add column planned_start timestamptz, add column join_at timestamptz, add column meet_url text, add column error text,
 add column status_at timestamptz, add column created_at timestamptz not null default now(),
 add column updated_at timestamptz not null default now();
-- Each row is now one recorder visit, named by its Recall bot ID. Saved Google recordings are finished visits.
update public.hf_interview_recordings set state='done';
alter table public.hf_interview_recordings add constraint hf_interview_recordings_state
 check(state in ('scheduled','joining','waiting','recording','processing','done','failed','cancelled'));
create index hf_interview_recordings_unstored on public.hf_interview_recordings(updated_at)
 where storage_key is null and state='done';
create index hf_interview_recordings_active on public.hf_interview_recordings(updated_at)
 where state in ('scheduled','joining','waiting','recording','processing');
alter table public.hf_interviews drop column recording_setup, drop column recording_error, add column recorder_error text;

-- Recorders of deleted interviews, candidates or companies are cancelled by the scheduled job.
create table public.hf_recorder_cancellations (bot text primary key, company_id uuid not null, created_at timestamptz not null default now());
alter table public.hf_recorder_cancellations enable row level security;
revoke all on public.hf_recorder_cancellations from anon,authenticated;
grant all on public.hf_recorder_cancellations to service_role;
create function hf_private.queue_recorder_cancellation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.hf_recorder_cancellations(bot,company_id) values(old.name,old.company_id) on conflict do nothing;
 return old;
end $$;
revoke all on function hf_private.queue_recorder_cancellation() from public,anon,authenticated;
create trigger hf_recorder_cleanup after delete on public.hf_interview_recordings
 for each row when (old.state in ('scheduled','joining','waiting','recording')) execute function hf_private.queue_recorder_cancellation();

-- Applies a Recall status to this company's visit. Older statuses and changes after a final state are ignored,
-- rechecked under the row lock so overlapping webhooks cannot move a visit backwards. Every call refreshes
-- updated_at so the catch-up job moves on to other visits.
create function public.hf_recording_status(cid uuid,bot text,next_state text,status_time timestamptz,problem text)
returns void language sql security invoker set search_path='' as $$
 update public.hf_interview_recordings set state=next_state,status_at=status_time,error=coalesce(problem,error),
  starts_at=case when next_state='recording' then coalesce(starts_at,status_time) else starts_at end,
  ends_at=case when next_state in ('processing','done') and starts_at is not null then coalesce(ends_at,status_time) else ends_at end
 where company_id=cid and name=bot and next_state is not null and state not in ('done','failed','cancelled')
  and (status_at is null or status_at<=status_time);
 update public.hf_interview_recordings set updated_at=now() where company_id=cid and name=bot;
$$;

-- Claims finished visits to copy into storage. A claim expires, and attempts stop after five failures.
create function public.hf_recording_claim(max_rows integer)
returns table(company_id uuid,name text,interview_id uuid,error text)
language sql security invoker set search_path='' as $$
 with due as (
  select r.company_id,r.name from public.hf_interview_recordings r
  where r.state='done' and r.storage_key is null and r.storage_attempts<5
   and (r.storage_claim_until is null or r.storage_claim_until<now())
  order by r.updated_at limit max_rows for update skip locked)
 update public.hf_interview_recordings r set storage_claim_until=now()+interval '20 minutes',storage_attempts=r.storage_attempts+1
  from due where r.company_id=due.company_id and r.name=due.name
  returning r.company_id,r.name,r.interview_id,r.error
$$;
revoke all on function public.hf_recording_status(uuid,text,text,timestamptz,text),public.hf_recording_claim(integer) from public,anon,authenticated;
grant execute on function public.hf_recording_status(uuid,text,text,timestamptz,text),public.hf_recording_claim(integer) to service_role;

-- Every provider result checks the active lease and connection generation.
-- 'sync' and 'error' apply only to the revision they were computed for; 'observed' meeting times and the
-- 'space' HireFlow created for the interview always apply.
create or replace function public.hf_meet_commit(cid uuid,generation_id uuid,worker uuid,sid uuid,revision integer,payload jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare o jsonb:=payload->'observed'; s jsonb:=payload->'sync'; fresh boolean;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_google_connections g join public.hf_meet_connections c on c.company_id=g.company_id
  join public.hf_members m on m.company_id=g.company_id and m.user_id=g.connected_by
  where g.company_id=cid and g.generation=generation_id and g.credentials is not null and c.lease_id=worker and c.lease_until>now() and m.enabled and m.role='admin')
 then raise exception 'Google connection changed'; end if;
 if sid is null then
  if payload ? 'events' then
   update public.hf_meet_connections set events_subscription=coalesce(payload->'events'->>'subscription',events_subscription),
    events_expire_at=coalesce((payload->'events'->>'expire_at')::timestamptz,events_expire_at),events_error=payload->'events'->>'error' where company_id=cid;
  end if;
  if payload ? 'release' then
   update public.hf_meet_connections set lease_id=null,lease_until=null,synced_at=now(),last_error=payload->>'release' where company_id=cid;
  end if;
  return true;
 end if;
 if not exists(select 1 from public.hf_interviews where company_id=cid and id=sid) then return false; end if;
 if payload ? 'space' then
  update public.hf_interviews set meet_space=coalesce(meet_space,payload->'space'->>'name'),
   meet_url=coalesce(meet_url,payload->'space'->>'meet_url') where company_id=cid and id=sid;
 end if;
 if o is not null then
  update public.hf_interviews set meeting_started_at=coalesce((o->>'started_at')::timestamptz,meeting_started_at),
   meeting_ended_at=case when o ? 'ended_at' then (o->>'ended_at')::timestamptz else meeting_ended_at end where company_id=cid and id=sid;
 end if;
 select version=revision into fresh from public.hf_interviews where company_id=cid and id=sid;
 if not fresh then return false; end if;
 if payload ? 'error' then
  update public.hf_interviews set last_error=payload->>'error',synced_at=now() where company_id=cid and id=sid;
 elsif s is not null then
  update public.hf_interviews set status=s->>'status',synced_version=revision,meet_url=coalesce(s->>'meet_url',meet_url),
   meet_space=coalesce(s->>'meet_space',meet_space),title=coalesce(s->>'title',title),attendees=coalesce(s->'attendees',attendees),
   starts_at=coalesce((s->>'starts_at')::timestamptz,starts_at),ends_at=coalesce((s->>'ends_at')::timestamptz,ends_at),
   last_error=null,synced_at=now() where company_id=cid and id=sid;
 else
  update public.hf_interviews set synced_at=now() where company_id=cid and id=sid;
 end if;
 return true;
end $$;

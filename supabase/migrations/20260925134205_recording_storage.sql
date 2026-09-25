-- Recordings are copied from the organizer's Drive into private S3-compatible storage so every enabled member can
-- watch them. Objects are addressed only by storage_key; access is checked by HireFlow before a short-lived link is issued.
alter table public.hf_interview_recordings
 add column storage_key text, add column storage_size bigint, add column stored_at timestamptz,
 add column storage_error text, add column storage_attempts integer not null default 0, add column storage_claim_until timestamptz;
create index hf_interview_recordings_unstored on public.hf_interview_recordings(starts_at)
 where storage_key is null and state='FILE_GENERATED';
insert into storage.buckets(id,name,public) values('hf-recordings','hf-recordings',false) on conflict(id) do nothing;

-- Deleting a recording row (directly or through an interview, candidate or company) queues its object for removal.
create table public.hf_storage_deletions (key text primary key, created_at timestamptz not null default now());
alter table public.hf_storage_deletions enable row level security;
revoke all on public.hf_storage_deletions from anon,authenticated;
grant all on public.hf_storage_deletions to service_role;
create function hf_private.queue_recording_deletion()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.hf_storage_deletions(key) values(old.storage_key) on conflict do nothing;
 return old;
end $$;
revoke all on function hf_private.queue_recording_deletion() from public,anon,authenticated;
create trigger hf_recording_storage_cleanup after delete on public.hf_interview_recordings
 for each row when (old.storage_key is not null) execute function hf_private.queue_recording_deletion();

-- Claims finished recordings to copy. Only the connected account's grant can read the organizer's Drive, so
-- interviews hosted by an earlier account are skipped. A claim expires, and attempts stop after five failures.
create function public.hf_recording_claim(max_rows integer)
returns table(company_id uuid,name text,interview_id uuid,drive_file_id text,credentials text)
language sql security invoker set search_path='' as $$
 with due as (
  select r.company_id,r.name from public.hf_interview_recordings r
   join public.hf_interviews i on i.company_id=r.company_id and i.id=r.interview_id
   join public.hf_google_connections g on g.company_id=r.company_id and g.account=i.organizer and g.credentials is not null
  where r.state='FILE_GENERATED' and r.drive_file_id is not null and r.storage_key is null and r.storage_attempts<5
   and (r.storage_claim_until is null or r.storage_claim_until<now())
  order by r.starts_at nulls last limit max_rows for update of r skip locked)
 update public.hf_interview_recordings r set storage_claim_until=now()+interval '20 minutes',storage_attempts=r.storage_attempts+1
  from due, public.hf_google_connections g
  where r.company_id=due.company_id and r.name=due.name and g.company_id=r.company_id
  returning r.company_id,r.name,r.interview_id,r.drive_file_id,g.credentials
$$;
revoke all on function public.hf_recording_claim(integer) from public,anon,authenticated;
grant execute on function public.hf_recording_claim(integer) to service_role;

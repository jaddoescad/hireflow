-- Google Meet interviews. Credentials never reach the browser. All writes serialize on the company row.
create table public.hf_meet_connections (
 company_id uuid primary key references public.hf_companies(id) on delete cascade,
 organizer text not null check(organizer=lower(trim(organizer))), google_user text,
 credentials text, connected_by uuid references auth.users(id) on delete set null,
 generation uuid not null default gen_random_uuid(), lease_id uuid, lease_until timestamptz,
 events_subscription text, events_expire_at timestamptz, events_error text,
 synced_at timestamptz, last_error text, updated_at timestamptz not null default now()
);
create index hf_meet_connections_events on public.hf_meet_connections(events_subscription);
create table public.hf_interviews (
 id uuid primary key, company_id uuid not null references public.hf_companies(id) on delete cascade,
 candidate_id uuid not null, title text not null check(length(trim(title)) between 1 and 160),
 starts_at timestamptz not null, ends_at timestamptz not null, timezone text not null,
 interviewer_ids uuid[] not null, attendees jsonb not null, organizer text not null,
 auto_record boolean not null default true,
 recording_setup text not null default 'pending' check(recording_setup in ('pending','on','off','failed')),
 recording_error text, status text not null default 'pending' check(status in ('pending','scheduled','cancelled')),
 cancel_requested boolean not null default false, version integer not null default 1, synced_version integer not null default 0,
 google_event_id text not null, meet_url text, meet_space text,
 meeting_started_at timestamptz, meeting_ended_at timestamptz,
 last_error text, synced_at timestamptz, updated_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(company_id,id), unique(organizer,google_event_id),
 foreign key(company_id,candidate_id) references public.hf_candidates(company_id,id) on delete cascade,
 check(ends_at>starts_at and ends_at<=starts_at+interval '12 hours')
);
create index hf_interviews_calendar on public.hf_interviews(company_id,starts_at);
create index hf_interviews_space on public.hf_interviews(company_id,meet_space);
create table public.hf_interview_recordings (
 company_id uuid not null, interview_id uuid not null, name text not null, conference text not null,
 state text not null, starts_at timestamptz, ends_at timestamptz, drive_file_id text, playback_url text,
 primary key(company_id,name),
 foreign key(company_id,interview_id) references public.hf_interviews(company_id,id) on delete cascade
);
create index hf_interview_recordings_session on public.hf_interview_recordings(company_id,interview_id);
alter table public.hf_meet_connections enable row level security;
alter table public.hf_interviews enable row level security;
alter table public.hf_interview_recordings enable row level security;
revoke all on public.hf_meet_connections,public.hf_interviews,public.hf_interview_recordings from anon,authenticated;
grant all on public.hf_meet_connections,public.hf_interviews,public.hf_interview_recordings to service_role;
grant select on public.hf_interviews,public.hf_interview_recordings to authenticated;
create policy member_read on public.hf_interviews for select to authenticated using(hf_private.has_access(company_id));
create policy member_read on public.hf_interview_recordings for select to authenticated using(hf_private.has_access(company_id));

-- A different organizer may connect once the previous organizer's interviews are settled:
-- no unsynced change, and three days past the end of any held or scheduled interview.
create function public.hf_meet_set(actor uuid,cid uuid,mailbox text,google_id text,encrypted_credentials text)
returns void language plpgsql security invoker set search_path='' as $$
declare address text:=lower(trim(mailbox));
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled and role='admin') then raise exception 'Admin access required'; end if;
 if exists(select 1 from public.hf_meet_connections where company_id=cid and lease_until>now()) then raise exception 'Sync in progress. Try again shortly.'; end if;
 if encrypted_credentials is null then
  update public.hf_meet_connections set credentials=null,generation=gen_random_uuid(),events_subscription=null,
   events_expire_at=null,events_error=null,last_error=null,updated_at=now() where company_id=cid;
  return;
 end if;
 if exists(select 1 from public.hf_interviews where company_id=cid and organizer<>address and (version<>synced_version
  or ((status='scheduled' or meeting_started_at is not null) and ends_at>now()-interval '3 days'))) then
  raise exception 'Interviews hosted by the current organizer are still active. Reconnect that account, or wait until three days after its last interview.';
 end if;
 insert into public.hf_meet_connections(company_id,organizer,google_user,credentials,connected_by)
  values(cid,address,google_id,encrypted_credentials,actor)
  on conflict(company_id) do update set organizer=excluded.organizer,google_user=excluded.google_user,
   credentials=excluded.credentials,connected_by=actor,generation=gen_random_uuid(),lease_id=null,lease_until=null,
   events_subscription=case when public.hf_meet_connections.google_user=excluded.google_user then public.hf_meet_connections.events_subscription end,
   events_expire_at=case when public.hf_meet_connections.google_user=excluded.google_user then public.hf_meet_connections.events_expire_at end,
   events_error=null,last_error=null,updated_at=now();
end $$;

create function public.hf_interview_save(actor uuid,cid uuid,payload jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare item uuid:=(payload->>'id')::uuid; c public.hf_candidates; old public.hf_interviews; organizer_address text; invited jsonb; ids uuid[];
 starts timestamptz:=(payload->>'starts_at')::timestamptz;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled) then raise exception 'Company access denied'; end if;
 select organizer into organizer_address from public.hf_meet_connections where company_id=cid and credentials is not null;
 if organizer_address is null then raise exception 'Connect Google Meet first'; end if;
 select * into old from public.hf_interviews where company_id=cid and id=item for update;
 if old.id is not null then
  if old.version<>(payload->>'version')::integer then raise exception 'Session changed. Refresh before editing.'; end if;
  if old.status='cancelled' or old.cancel_requested then raise exception 'Session is cancelled'; end if;
  if old.organizer<>organizer_address then raise exception 'Reconnect the original organizer'; end if;
  if coalesce((payload->>'cancel')::boolean,false) then
   update public.hf_interviews set cancel_requested=true,version=version+1,updated_by=actor,updated_at=now(),last_error=null where company_id=cid and id=item;
   return item;
  end if;
 elsif coalesce((payload->>'cancel')::boolean,false) then raise exception 'Session not found';
 end if;
 select * into c from public.hf_candidates where company_id=cid and id=(payload->>'candidate_id')::uuid;
 if c.id is null or coalesce(c.email,'')='' then raise exception 'Choose a candidate with an email address'; end if;
 select array_agg(distinct value::uuid) into ids from jsonb_array_elements_text(payload->'interviewer_ids');
 if coalesce(cardinality(ids),0)=0 or cardinality(ids)>30 then raise exception 'Choose 1–30 internal interviewers'; end if;
 if exists(select 1 from unnest(ids) as x where not exists(select 1 from public.hf_members where company_id=cid and user_id=x and enabled)) then raise exception 'Interviewer access denied'; end if;
 -- Keep known RSVPs for guests who remain invited.
 select jsonb_agg(jsonb_build_object('email',a.email,'responseStatus',coalesce(
   (select p->>'responseStatus' from jsonb_array_elements(coalesce(old.attendees,'[]'::jsonb)) p where lower(p->>'email')=a.email limit 1),'needsAction')))
 into invited from (select lower(c.email) as email union select lower(email) from public.hf_members where company_id=cid and user_id=any(ids) and enabled) a;
 if not exists(select 1 from pg_timezone_names where name=payload->>'timezone') then raise exception 'Invalid timezone'; end if;
 if (old.id is null or starts<>old.starts_at) and starts<now()-interval '5 minutes' then raise exception 'Choose a future interview time'; end if;
 if old.id is null then
  insert into public.hf_interviews(id,company_id,candidate_id,title,starts_at,ends_at,timezone,interviewer_ids,attendees,organizer,auto_record,google_event_id,updated_by)
   values(item,cid,c.id,trim(payload->>'title'),starts,(payload->>'ends_at')::timestamptz,payload->>'timezone',ids,invited,organizer_address,(payload->>'auto_record')::boolean,'hf'||replace(item::text,'-',''),actor);
 else
  update public.hf_interviews set candidate_id=c.id,title=trim(payload->>'title'),starts_at=starts,
   ends_at=(payload->>'ends_at')::timestamptz,timezone=payload->>'timezone',interviewer_ids=ids,attendees=invited,
   auto_record=(payload->>'auto_record')::boolean,version=version+1,updated_by=actor,updated_at=now(),last_error=null
   where company_id=cid and id=item;
 end if;
 return item;
end $$;

-- Returns the connection with state 'ready' and a fresh lease, or only a state: disconnected, reauthorize, busy.
create function public.hf_meet_claim(cid uuid,actor uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.hf_meet_connections;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if actor is not null and not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled) then raise exception 'Company access denied'; end if;
 select * into c from public.hf_meet_connections where company_id=cid;
 if c.company_id is null or c.credentials is null then return jsonb_build_object('state','disconnected'); end if;
 if not exists(select 1 from public.hf_members where company_id=cid and user_id=c.connected_by and enabled and role='admin') then
  update public.hf_meet_connections set last_error='The admin who connected Google no longer has access. An admin needs to reconnect Google Meet.' where company_id=cid;
  return jsonb_build_object('state','reauthorize');
 end if;
 if c.lease_until>now() then return jsonb_build_object('state','busy'); end if;
 update public.hf_meet_connections set lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes' where company_id=cid returning * into c;
 return to_jsonb(c)||jsonb_build_object('state','ready');
end $$;

-- Sessions needing Google work: unsynced changes first, then upcoming and recently held interviews.
create function public.hf_meet_due(cid uuid,address text,skip uuid[],max_rows integer)
returns setof public.hf_interviews language sql security invoker set search_path='' as $$
 select * from public.hf_interviews where company_id=cid and organizer=address and not (id=any(skip))
  and (version<>synced_version or (starts_at<now()+interval '60 days' and ends_at>now()-interval '3 days'
   and (status='scheduled' or (status='cancelled' and meeting_started_at is not null))))
 order by version<>synced_version desc,synced_at nulls first limit max_rows
$$;

-- Every provider result checks the active lease and connection generation.
-- 'sync' and 'error' apply only to the revision they were computed for; 'observed' meeting facts always apply.
create function public.hf_meet_commit(cid uuid,generation_id uuid,worker uuid,sid uuid,revision integer,payload jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare r jsonb; o jsonb:=payload->'observed'; s jsonb:=payload->'sync'; fresh boolean;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_meet_connections c join public.hf_members m on m.company_id=c.company_id and m.user_id=c.connected_by
  where c.company_id=cid and c.generation=generation_id and c.lease_id=worker and c.lease_until>now() and c.credentials is not null and m.enabled and m.role='admin')
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
 if o is not null then
  update public.hf_interviews set meeting_started_at=coalesce((o->>'started_at')::timestamptz,meeting_started_at),
   meeting_ended_at=case when o ? 'ended_at' then (o->>'ended_at')::timestamptz else meeting_ended_at end where company_id=cid and id=sid;
  for r in select * from jsonb_array_elements(coalesce(o->'recordings','[]'::jsonb)) loop
   insert into public.hf_interview_recordings(company_id,interview_id,name,conference,state,starts_at,ends_at,drive_file_id,playback_url)
   values(cid,sid,r->>'name',r->>'conference',r->>'state',(r->>'starts_at')::timestamptz,(r->>'ends_at')::timestamptz,r->>'drive_file_id',r->>'playback_url')
   on conflict(company_id,name) do update set state=excluded.state,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
    drive_file_id=excluded.drive_file_id,playback_url=excluded.playback_url
   where public.hf_interview_recordings.interview_id=sid;
  end loop;
 end if;
 select version=revision into fresh from public.hf_interviews where company_id=cid and id=sid;
 if not fresh then return false; end if;
 if payload ? 'error' then
  update public.hf_interviews set last_error=payload->>'error',synced_at=now() where company_id=cid and id=sid;
 elsif s is not null then
  update public.hf_interviews set status=s->>'status',synced_version=revision,meet_url=coalesce(s->>'meet_url',meet_url),
   meet_space=coalesce(s->>'meet_space',meet_space),title=coalesce(s->>'title',title),attendees=coalesce(s->'attendees',attendees),
   recording_setup=coalesce(s->>'recording_setup',recording_setup),recording_error=s->>'recording_error',
   starts_at=coalesce((s->>'starts_at')::timestamptz,starts_at),ends_at=coalesce((s->>'ends_at')::timestamptz,ends_at),
   last_error=null,synced_at=now() where company_id=cid and id=sid;
 else
  update public.hf_interviews set synced_at=now() where company_id=cid and id=sid;
 end if;
 return true;
end $$;
revoke all on function public.hf_meet_set(uuid,uuid,text,text,text),public.hf_interview_save(uuid,uuid,jsonb),public.hf_meet_claim(uuid,uuid),
 public.hf_meet_due(uuid,text,uuid[],integer),public.hf_meet_commit(uuid,uuid,uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.hf_meet_set(uuid,uuid,text,text,text),public.hf_interview_save(uuid,uuid,jsonb),public.hf_meet_claim(uuid,uuid),
 public.hf_meet_due(uuid,text,uuid[],integer),public.hf_meet_commit(uuid,uuid,uuid,uuid,integer,jsonb) to service_role;

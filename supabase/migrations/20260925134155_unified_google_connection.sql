-- One Google Workspace account per company powers Gmail import, Calendar invitations and Meet.
-- Credentials live in one server-only row; Gmail and Meet keep separate sync progress so neither blocks the other.
create table public.hf_google_connections (
 company_id uuid primary key references public.hf_companies(id) on delete cascade,
 account text not null check(account=lower(trim(account))), google_user text,
 credentials text, connected_by uuid references auth.users(id) on delete set null,
 generation uuid not null default gen_random_uuid(),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index hf_google_connections_account on public.hf_google_connections(account);
alter table public.hf_google_connections enable row level security;
revoke all on public.hf_google_connections from anon,authenticated;
grant all on public.hf_google_connections to service_role;

-- Earlier grants lack the combined permissions, so each company reconnects once. The Gmail mailbox becomes the
-- account, which keeps its import checkpoint when the same mailbox reconnects.
insert into public.hf_google_connections(company_id,account,connected_by)
 select company_id,mailbox,connected_by from public.hf_gmail_connections
 union all
 select m.company_id,m.organizer,m.connected_by from public.hf_meet_connections m
  where not exists(select 1 from public.hf_gmail_connections g where g.company_id=m.company_id);

drop function public.hf_gmail_set(uuid,uuid,text,text);
drop function public.hf_meet_set(uuid,uuid,text,text,text);
alter table public.hf_gmail_connections drop column mailbox, drop column credentials, drop column connected_by, drop column generation,
 add foreign key(company_id) references public.hf_google_connections(company_id) on delete cascade;
alter table public.hf_meet_connections drop column organizer, drop column google_user, drop column credentials,
 drop column connected_by, drop column generation,
 add foreign key(company_id) references public.hf_google_connections(company_id) on delete cascade;
-- Event subscriptions belonged to the previous grants; the next sync creates one for the reconnected account.
update public.hf_meet_connections set lease_id=null,lease_until=null,events_subscription=null,events_expire_at=null,events_error=null;
update public.hf_gmail_connections set lease_id=null,lease_until=null;

-- Connecting a different account resets Gmail import and Meet subscriptions. Interviews hosted by an earlier
-- account keep their history and saved recordings; new interviews use the connected account.
create function public.hf_google_set(actor uuid,cid uuid,address text,google_id text,encrypted_credentials text)
returns void language plpgsql security invoker set search_path='' as $$
declare account_address text:=lower(trim(address)); previous public.hf_google_connections;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled and role='admin') then raise exception 'Admin access required'; end if;
 select * into previous from public.hf_google_connections where company_id=cid;
 if encrypted_credentials is null then
  update public.hf_google_connections set credentials=null,generation=gen_random_uuid(),updated_at=now() where company_id=cid;
  update public.hf_meet_connections set lease_id=null,lease_until=null,events_subscription=null,events_expire_at=null,
   events_error=null,last_error=null,updated_at=now() where company_id=cid;
  update public.hf_gmail_connections set lease_id=null,lease_until=null,last_error=null,updated_at=now() where company_id=cid;
  return;
 end if;
 if coalesce(account_address,'')='' then raise exception 'Google account required'; end if;
 insert into public.hf_google_connections(company_id,account,google_user,credentials,connected_by)
  values(cid,account_address,google_id,encrypted_credentials,actor)
  on conflict(company_id) do update set account=excluded.account,google_user=excluded.google_user,
   credentials=excluded.credentials,connected_by=actor,generation=gen_random_uuid(),updated_at=now();
 insert into public.hf_meet_connections(company_id) values(cid)
  on conflict(company_id) do update set lease_id=null,lease_until=null,last_error=null,events_error=null,updated_at=now(),
   events_subscription=case when previous.google_user=google_id then public.hf_meet_connections.events_subscription end,
   events_expire_at=case when previous.google_user=google_id then public.hf_meet_connections.events_expire_at end;
 insert into public.hf_gmail_connections(company_id) values(cid)
  on conflict(company_id) do update set lease_id=null,lease_until=null,last_error=null,updated_at=now(),
   history_id=case when previous.account=account_address then public.hf_gmail_connections.history_id end,
   history_page=case when previous.account=account_address then public.hf_gmail_connections.history_page end,
   bootstrap_page=case when previous.account=account_address then public.hf_gmail_connections.bootstrap_page end,
   bootstrap_started=coalesce(previous.account=account_address and public.hf_gmail_connections.bootstrap_started,false),
   synced_at=case when previous.account=account_address then public.hf_gmail_connections.synced_at end;
end $$;

create or replace function public.hf_gmail_claim(cid uuid,actor uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare g public.hf_google_connections; c public.hf_gmail_connections;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if actor is not null and not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled and role='admin') then raise exception 'Admin access required'; end if;
 select * into g from public.hf_google_connections where company_id=cid and credentials is not null;
 if not found then return null; end if;
 update public.hf_gmail_connections set lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes'
  where company_id=cid and (lease_until is null or lease_until<now()) returning * into c;
 if not found then return null; end if;
 return to_jsonb(c)||jsonb_build_object('mailbox',g.account,'credentials',g.credentials,'generation',g.generation);
end $$;

create or replace function public.hf_gmail_ingest(cid uuid,connection_generation uuid,worker uuid,payload jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare item uuid; matches uuid[]; matched uuid;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_google_connections g join public.hf_gmail_connections c on c.company_id=g.company_id
  where g.company_id=cid and g.generation=connection_generation and g.credentials is not null and c.lease_id=worker and c.lease_until>now())
 then raise exception 'Gmail connection changed'; end if;
 select array_agg(id) into matches from public.hf_candidates where company_id=cid and email in (select jsonb_array_elements_text(payload->'contact_emails'));
 matched:=case when array_length(matches,1)=1 then matches[1] else null end;
 insert into public.hf_activities(company_id,candidate_id,kind,direction,body,email,external_id,occurred_at,metadata)
  values(cid,matched,'email',payload->>'direction',payload->>'body',payload->>'email',payload->>'external_id',(payload->>'occurred_at')::timestamptz,payload->'metadata')
  on conflict(company_id,external_id) do nothing returning id into item;
 if item is null then select id into item from public.hf_activities where company_id=cid and external_id=payload->>'external_id'; end if;
 return item;
end $$;

create or replace function public.hf_interview_save(actor uuid,cid uuid,payload jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare item uuid:=(payload->>'id')::uuid; c public.hf_candidates; old public.hf_interviews; organizer_address text; invited jsonb; ids uuid[];
 starts timestamptz:=(payload->>'starts_at')::timestamptz;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled) then raise exception 'Company access denied'; end if;
 select account into organizer_address from public.hf_google_connections where company_id=cid and credentials is not null;
 if organizer_address is null then raise exception 'Connect Google first'; end if;
 select * into old from public.hf_interviews where company_id=cid and id=item for update;
 if old.id is not null then
  if old.version<>(payload->>'version')::integer then raise exception 'Session changed. Refresh before editing.'; end if;
  if old.status='cancelled' or old.cancel_requested then raise exception 'Session is cancelled'; end if;
  if old.organizer<>organizer_address then raise exception 'This interview was sent from another Google account. Change it in Google Calendar.'; end if;
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
create or replace function public.hf_meet_claim(cid uuid,actor uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare g public.hf_google_connections; c public.hf_meet_connections;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if actor is not null and not exists(select 1 from public.hf_members where company_id=cid and user_id=actor and enabled) then raise exception 'Company access denied'; end if;
 select * into g from public.hf_google_connections where company_id=cid;
 if g.company_id is null or g.credentials is null then return jsonb_build_object('state','disconnected'); end if;
 if not exists(select 1 from public.hf_members where company_id=cid and user_id=g.connected_by and enabled and role='admin') then
  update public.hf_meet_connections set last_error='The admin who connected Google no longer has access. An admin needs to reconnect Google.' where company_id=cid;
  return jsonb_build_object('state','reauthorize');
 end if;
 select * into c from public.hf_meet_connections where company_id=cid;
 if c.lease_until>now() then return jsonb_build_object('state','busy'); end if;
 update public.hf_meet_connections set lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes' where company_id=cid returning * into c;
 return to_jsonb(c)||jsonb_build_object('state','ready','organizer',g.account,'google_user',g.google_user,
  'credentials',g.credentials,'generation',g.generation);
end $$;

-- Every provider result checks the active lease and connection generation.
-- 'sync' and 'error' apply only to the revision they were computed for; 'observed' meeting facts always apply.
create or replace function public.hf_meet_commit(cid uuid,generation_id uuid,worker uuid,sid uuid,revision integer,payload jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare r jsonb; o jsonb:=payload->'observed'; s jsonb:=payload->'sync'; fresh boolean;
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

-- Only the leased worker may prepare/acknowledge a confirmation. Client-supplied recipients are never accepted.
create or replace function public.hf_interview_notification(cid uuid,generation_id uuid,worker uuid,sid uuid,revision integer,outcome jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.hf_interviews; candidate_name text;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not exists(select 1 from public.hf_google_connections g join public.hf_meet_connections c on c.company_id=g.company_id
  join public.hf_members m on m.company_id=g.company_id and m.user_id=g.connected_by
  where g.company_id=cid and g.generation=generation_id and c.lease_id=worker and c.lease_until>now()+interval '30 seconds'
   and g.credentials is not null and m.enabled and m.role='admin')
 then raise exception 'Google connection changed'; end if;
 select i.* into s from public.hf_interviews i join public.hf_google_connections g on g.company_id=i.company_id and g.account=i.organizer
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

revoke all on function public.hf_google_set(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.hf_google_set(uuid,uuid,text,text,text) to service_role;

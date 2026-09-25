-- Scheduling stops when the candidate already has an upcoming interview, unless the scheduler confirms another.
create or replace function public.hf_interview_save(actor uuid,cid uuid,payload jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare item uuid:=(payload->>'id')::uuid; c public.hf_candidates; new_email text:=lower(btrim(payload->>'candidate_email')); old public.hf_interviews; organizer_address text; booked timestamptz; invited jsonb; ids uuid[];
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
 select * into c from public.hf_candidates where company_id=cid and id=(payload->>'candidate_id')::uuid for update;
 -- The scheduler may correct the candidate's email; it is saved on the candidate record so invitations,
 -- email matching and the candidate panel agree. A failed save rolls the change back.
 if c.id is not null and coalesce(new_email,'')<>'' and new_email is distinct from c.email then
  if length(new_email)>254 or new_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then raise exception 'Enter a valid candidate email'; end if;
  update public.hf_candidates set email=new_email,updated_at=now() where company_id=cid and id=c.id;
  c.email:=new_email;
 end if;
 if c.id is null or coalesce(c.email,'')='' then raise exception 'Choose a candidate with an email address'; end if;
 -- Guard against booking the same candidate twice by accident; a deliberate second round sets allow_another.
 if (old.id is null or old.candidate_id<>c.id) and not coalesce((payload->>'allow_another')::boolean,false) then
  select starts_at into booked from public.hf_interviews where company_id=cid and candidate_id=c.id and id<>item
   and status<>'cancelled' and not cancel_requested and ends_at>now() order by starts_at limit 1;
  if booked is not null then
   raise exception using message='Candidate already has an upcoming interview',
    detail=to_char(booked at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
  end if;
 end if;
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

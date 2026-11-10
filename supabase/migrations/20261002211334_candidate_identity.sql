-- One candidate can receive many applications. Preserve every source ID and payload
-- separately so retries remain idempotent after repeat submissions and merges.
create table public.hf_candidate_submissions (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.hf_companies(id) on delete cascade,
 candidate_id uuid not null, source text not null, source_id text not null,
 payload jsonb not null, submitted_at timestamptz not null, created_at timestamptz not null default now(),
 unique(company_id,source,source_id),
 foreign key(company_id,candidate_id) references public.hf_candidates(company_id,id) on delete cascade
);
create index hf_candidate_submissions_candidate on public.hf_candidate_submissions(company_id,candidate_id);
alter table public.hf_candidate_submissions enable row level security;
revoke all on public.hf_candidate_submissions from public,anon,authenticated;
grant select on public.hf_candidate_submissions to authenticated;
grant all on public.hf_candidate_submissions to service_role;
create policy member_read on public.hf_candidate_submissions for select to authenticated using(hf_private.has_access(company_id));
insert into public.hf_candidate_submissions(company_id,candidate_id,source,source_id,payload,submitted_at)
 select company_id,id,source,source_id,to_jsonb(c),created_at from public.hf_candidates c where source_id is not null;

-- Server-only recovery snapshot; no applicant data belongs in repository files.
create table public.hf_candidate_merge_archive (
 old_id uuid primary key, company_id uuid not null references public.hf_companies(id) on delete cascade,
 retained_id uuid not null, snapshot jsonb not null, merged_at timestamptz not null default now()
);
alter table public.hf_candidate_merge_archive enable row level security;
revoke all on public.hf_candidate_merge_archive from public,anon,authenticated;
grant all on public.hf_candidate_merge_archive to service_role;

-- Only merge matching email AND phone, or identical names with one shared
-- contact and no conflicting other contact. Keep the oldest hiring record/stage.
do $$
declare old public.hf_candidates; keep public.hf_candidates; cid uuid;
begin
 for cid in select id from public.hf_companies order by id loop
  perform 1 from public.hf_companies where id=cid for update;
  for old in select * from public.hf_candidates where company_id=cid order by created_at,id loop
   if not exists(select 1 from public.hf_candidates where id=old.id and company_id=cid) then continue; end if;
   select * into keep from public.hf_candidates c where c.company_id=cid and (c.created_at,c.id)<(old.created_at,old.id)
    and ((c.email is not null and c.email=old.email and c.phone is not null and c.phone=old.phone)
     or (lower(btrim(c.name))=lower(btrim(old.name))
      and ((c.email is not null and c.email=old.email) or (c.phone is not null and c.phone=old.phone))
      and (c.email is null or old.email is null or c.email=old.email)
      and (c.phone is null or old.phone is null or c.phone=old.phone)))
    order by c.created_at,c.id limit 1;
   if keep.id is null then continue; end if;
   insert into public.hf_candidate_merge_archive(old_id,company_id,retained_id,snapshot)
    values(old.id,cid,keep.id,jsonb_build_object('candidate',to_jsonb(old),'scores',
     (select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.hf_candidate_scores s where company_id=cid and candidate_id=old.id)));
   update public.hf_activities set candidate_id=keep.id where company_id=cid and candidate_id=old.id;
   update public.hf_interviews set candidate_id=keep.id where company_id=cid and candidate_id=old.id;
   update public.hf_candidate_submissions set candidate_id=keep.id where company_id=cid and candidate_id=old.id;
   insert into public.hf_candidate_scores select company_id,keep.id,category_id,rating,note,updated_by,updated_at,version
    from public.hf_candidate_scores where company_id=cid and candidate_id=old.id on conflict do nothing;
   update public.hf_candidates set email=coalesce(email,old.email),phone=coalesce(phone,old.phone),
    tags=array(select distinct unnest(keep.tags||old.tags)),updated_at=now() where company_id=cid and id=keep.id;
   insert into public.hf_activities(company_id,candidate_id,kind,body,metadata)
    values(cid,keep.id,'note','Duplicate application consolidated from ' || old.source || '. Original application details are preserved.',
     jsonb_build_object('original_application',to_jsonb(old)));
   delete from public.hf_candidates where company_id=cid and id=old.id;
  end loop;
 end loop;
end $$;

-- Relink only unassigned communications with exactly one current candidate.
with matches as (
 select a.company_id,a.id,(array_agg(c.id))[1] as candidate_id
 from public.hf_activities a join public.hf_candidates c on c.company_id=a.company_id
  and ((a.phone is not null and a.phone=c.phone) or (a.email is not null and a.email=c.email))
 where a.candidate_id is null and a.kind in ('sms','call','email')
 group by a.company_id,a.id having count(*)=1
)
update public.hf_activities a set candidate_id=m.candidate_id from matches m where a.company_id=m.company_id and a.id=m.id;

-- Quo history re-syncs refresh details on events already saved (for example whether a call was answered).
create or replace function public.hf_ingest(cid uuid, event_kind text, payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare item uuid; sid uuid; matches uuid[]; applied text; applied_time timestamptz; prior public.hf_candidates; answer_body text;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not found then raise exception 'Company not found'; end if;
 if event_kind='intake' then
  select candidate_id into item from public.hf_candidate_submissions where company_id=cid and source=payload->>'source' and source_id=payload->>'source_id';
  if item is not null then return jsonb_build_object('id',item,'duplicate',true); end if;
  applied := nullif(btrim(payload->'attributes'->>'Applied at'), '');
  applied_time := now();
  if applied is not null then
   if applied ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?([.]\d+)?(Z|[+-]\d{2}:?\d{2})$' then
    applied_time := applied::timestamptz;
   elsif applied ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$' and payload->>'source'='Hiring Sheet' then
    -- The source hiring spreadsheet uses America/Toronto local time.
    applied_time := applied::timestamp at time zone 'America/Toronto';
   end if;
  end if;
  select array_agg(id) into matches from public.hf_candidates where company_id=cid and
   ((nullif(payload->>'email','') is not null and email=payload->>'email') or
    (nullif(payload->>'phone','') is not null and phone=payload->>'phone'));
  if coalesce(array_length(matches,1),0)>1 then
   raise exception 'Multiple candidates match these contact details. Resolve the duplicate candidates before retrying.';
  end if;
  if array_length(matches,1)=1 then
   select * into prior from public.hf_candidates where company_id=cid and id=matches[1];
   if (prior.email is not null and nullif(payload->>'email','') is not null and prior.email<>payload->>'email')
    or (prior.phone is not null and nullif(payload->>'phone','') is not null and prior.phone<>payload->>'phone') then
    raise exception 'Contact details conflict with an existing candidate. Review the candidate before retrying.';
   end if;
   item:=prior.id;
   update public.hf_candidates set email=coalesce(email,nullif(payload->>'email','')),
    phone=coalesce(phone,nullif(payload->>'phone','')),updated_at=now() where company_id=cid and id=item;
  else
  select id into sid from public.hf_stages where company_id=cid order by position,id limit 1;
  insert into public.hf_candidates(company_id,stage_id,name,email,phone,job_title,experience,tags,source,source_id,attributes,created_at)
   values(cid,sid,payload->>'name',nullif(payload->>'email',''),nullif(payload->>'phone',''),payload->>'job_title',payload->>'experience',array(select jsonb_array_elements_text(payload->'tags')),payload->>'source',payload->>'source_id',payload->'attributes',applied_time) returning id into item;
  end if;
  insert into public.hf_candidate_submissions(company_id,candidate_id,source,source_id,payload,submitted_at)
   values(cid,item,payload->>'source',payload->>'source_id',payload,applied_time);
  select string_agg(answer->>'question' || E'\n' || coalesce(nullif(answer->>'answer',''),'No answer provided'),E'\n\n' order by ordinal)
   into answer_body from jsonb_array_elements(case when jsonb_typeof(payload->'attributes'->'Form answers')='array'
    then payload->'attributes'->'Form answers' else '[]'::jsonb end) with ordinality as answers(answer,ordinal);
  -- Initial application answers already have an ordinary note from the candidate trigger.
  if prior.id is not null then
   insert into public.hf_activities(company_id,candidate_id,kind,body,external_id,occurred_at,metadata)
    values(cid,item,'note','Repeat application received from ' || (payload->>'source') ||
     case when answer_body is null then '' else E'\n\nApplication answers\n\n' || answer_body end,
     'submission:' || (select id::text from public.hf_candidate_submissions where company_id=cid and source=payload->>'source' and source_id=payload->>'source_id'),
     applied_time,jsonb_build_object('submission',payload));
  end if;
  update public.hf_integrations set last_intake_at=now() where company_id=cid;
 elsif event_kind='quo' then
  select array_agg(id) into matches from public.hf_candidates where company_id=cid and
   ((nullif(payload->>'phone','') is not null and phone=payload->>'phone') or (nullif(payload->>'email','') is not null and email=payload->>'email'));
  -- Only hiring contacts: a shared production line also contains customer calls.
  if coalesce(array_length(matches,1),0)=0 then return jsonb_build_object('ignored',true); end if;
  item:=case when array_length(matches,1)=1 then matches[1] else null end;
  insert into public.hf_activities(company_id,candidate_id,kind,direction,body,phone,email,external_id,occurred_at,metadata)
   values(cid,item,payload->>'kind',payload->>'direction',payload->>'body',payload->>'phone',payload->>'email',payload->>'external_id',(payload->>'occurred_at')::timestamptz,coalesce(payload->'metadata','{}'))
   on conflict(company_id,external_id) do update set metadata=public.hf_activities.metadata||excluded.metadata,body=excluded.body
   where public.hf_activities.metadata||excluded.metadata is distinct from public.hf_activities.metadata or public.hf_activities.body is distinct from excluded.body;
  update public.hf_integrations set last_quo_at=now() where company_id=cid;
 else raise exception 'Unknown event kind'; end if;
 return jsonb_build_object('id',item);
end $$;


create function public.hf_candidate_contact_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.hf_companies where id=new.company_id for update;
 if exists(select 1 from public.hf_candidates c where c.company_id=new.company_id and c.id<>new.id
  and ((new.email is not null and c.email=new.email) or (new.phone is not null and c.phone=new.phone))) then
  raise exception 'A candidate already uses this email or phone. Open the existing candidate instead.';
 end if;
 return new;
end $$;
revoke all on function public.hf_candidate_contact_guard() from public,anon,authenticated;
grant execute on function public.hf_candidate_contact_guard() to service_role;
create trigger hf_candidate_contact_guard before insert or update of email,phone on public.hf_candidates
 for each row execute function public.hf_candidate_contact_guard();

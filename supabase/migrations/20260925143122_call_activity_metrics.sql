-- Quo history re-syncs refresh details on events already saved (for example whether a call was answered).
create or replace function public.hf_ingest(cid uuid, event_kind text, payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare item uuid; sid uuid; matches uuid[]; applied text; applied_time timestamptz;
begin
 perform 1 from public.hf_companies where id=cid for update;
 if not found then raise exception 'Company not found'; end if;
 if event_kind='intake' then
  select id into item from public.hf_candidates where company_id=cid and source=payload->>'source' and source_id=payload->>'source_id';
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
  select id into sid from public.hf_stages where company_id=cid order by position,id limit 1;
  insert into public.hf_candidates(company_id,stage_id,name,email,phone,job_title,experience,tags,source,source_id,attributes,created_at)
   values(cid,sid,payload->>'name',nullif(payload->>'email',''),nullif(payload->>'phone',''),payload->>'job_title',payload->>'experience',array(select jsonb_array_elements_text(payload->'tags')),payload->>'source',payload->>'source_id',payload->'attributes',applied_time) returning id into item;
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

-- Team outreach for a date range, counted in the viewer's time zone. Only candidate-linked outgoing calls,
-- texts and emails count. A call is answered when Quo reports an answer time; calls saved before that
-- detail was recorded are reported as unknown rather than guessed.
create function public.hf_activity_metrics(cid uuid,from_day date,to_day date,tz text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if not hf_private.has_access(cid) then raise exception 'Company access denied'; end if;
 if not exists(select 1 from pg_timezone_names where name=tz) then raise exception 'Invalid timezone'; end if;
 with a as (
  select (occurred_at at time zone tz)::date as day, candidate_id,
   kind='call' as call,
   kind='call' and nullif(metadata->>'answered_at','') is not null as answered,
   kind='call' and not metadata ? 'answered_at' as unknown,
   kind in ('sms','email') as message
  from public.hf_activities
  where company_id=cid and direction='outgoing' and kind in ('call','sms','email') and candidate_id is not null
   and (from_day is null or occurred_at>=(from_day::timestamp at time zone tz))
   and (to_day is null or occurred_at<((to_day+1)::timestamp at time zone tz)))
 select jsonb_build_object(
  'calls',count(*) filter(where call),
  'answered_calls',count(*) filter(where answered),
  'unknown_calls',count(*) filter(where unknown),
  'called',count(distinct candidate_id) filter(where call),
  'answered',count(distinct candidate_id) filter(where answered),
  'messages',count(*) filter(where message),
  'messaged',count(distinct candidate_id) filter(where message),
  'days',(select coalesce(jsonb_agg(d order by d.day desc),'[]'::jsonb) from (
   select day,count(distinct candidate_id) filter(where call) as called,count(distinct candidate_id) filter(where answered) as answered,
    count(distinct candidate_id) filter(where message) as messaged,count(*) filter(where call) as calls
   from a group by day) d),
  'contacted',(select coalesce(jsonb_agg(distinct x.candidate_id),'[]'::jsonb) from public.hf_activities x
   where x.company_id=cid and x.direction='outgoing' and x.kind in ('call','sms','email') and x.candidate_id is not null))
 into result from a;
 return result;
end $$;
revoke all on function public.hf_activity_metrics(uuid,date,date,text) from public,anon;
grant execute on function public.hf_activity_metrics(uuid,date,date,text) to authenticated;

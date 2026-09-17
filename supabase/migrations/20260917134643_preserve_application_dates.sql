create or replace function public.hf_ingest(cid uuid, event_kind text, payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
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
   on conflict(company_id,external_id) do nothing;
  update public.hf_integrations set last_quo_at=now() where company_id=cid;
 else raise exception 'Unknown event kind'; end if;
 return jsonb_build_object('id',item);
end $$;
revoke all on function public.hf_ingest(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.hf_ingest(uuid,text,jsonb) to service_role;

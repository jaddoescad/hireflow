-- Keep complete application answers in the existing Notes timeline, atomically
-- with intake. A stable external ID makes retries and backfills idempotent.
create function public.hf_application_answer_note()
returns trigger language plpgsql security invoker set search_path='' as $$
declare note_body text;
begin
 if jsonb_typeof(new.attributes->'Form answers') is distinct from 'array' then
  return new;
 end if;
 select string_agg(
  answer->>'question' || E'\n' || coalesce(nullif(answer->>'answer',''),'No answer provided'),
  E'\n\n' order by ordinal
 ) into note_body
 from jsonb_array_elements(new.attributes->'Form answers') with ordinality as answers(answer,ordinal);
 if nullif(note_body,'') is not null then
  insert into public.hf_activities(company_id,candidate_id,kind,body,external_id,occurred_at)
  values(new.company_id,new.id,'note','Application answers' || E'\n\n' || note_body,
   'application:' || new.id::text,new.created_at)
  on conflict(company_id,external_id) do nothing;
 end if;
 return new;
end $$;
revoke all on function public.hf_application_answer_note() from public, anon, authenticated;
grant execute on function public.hf_application_answer_note() to service_role;
create trigger hf_candidate_application_note
after insert or update of attributes on public.hf_candidates
for each row execute function public.hf_application_answer_note();

-- Existing complete responses receive the same ordinary note.
insert into public.hf_activities(company_id,candidate_id,kind,body,external_id,occurred_at)
select c.company_id,c.id,'note','Application answers' || E'\n\n' || a.body,
 'application:' || c.id::text,c.created_at
from public.hf_candidates c
cross join lateral (
 select string_agg(answer->>'question' || E'\n' ||
  coalesce(nullif(answer->>'answer',''),'No answer provided'), E'\n\n' order by ordinal) as body
 from jsonb_array_elements(case when jsonb_typeof(c.attributes->'Form answers')='array'
  then c.attributes->'Form answers' else '[]'::jsonb end) with ordinality as answers(answer,ordinal)
) a
where nullif(a.body,'') is not null
on conflict(company_id,external_id) do nothing;

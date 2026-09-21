-- Preserve existing ratings proportionally: 1–5 becomes 2–10; null stays unassessed.
-- Lock against concurrent score writes and invalidate previously loaded drafts.
lock table public.hf_candidate_scores in access exclusive mode;
alter table public.hf_candidate_scores drop constraint hf_candidate_scores_rating_check;
update public.hf_candidate_scores set rating = rating * 2, version = version + 1;
alter table public.hf_candidate_scores add constraint hf_candidate_scores_rating_check
 check (rating between 0 and 10);

create or replace function public.hf_score_mutate(actor uuid, cid uuid, action text, payload jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
 member public.hf_members;
 item uuid;
 entry jsonb;
 existing public.hf_candidate_scores;
 saved public.hf_candidate_scores;
 saved_rows jsonb := '[]'::jsonb;
begin
 if not exists (select 1 from auth.users where id = actor and email_confirmed_at is not null) then
  raise exception 'Verified account required';
 end if;
 perform 1 from public.hf_companies where id = cid for update;
 if not found then raise exception 'Company not found'; end if;
 select * into member from public.hf_members where company_id = cid and user_id = actor and enabled;
 if member.user_id is null then raise exception 'Company access denied'; end if;
 if action in ('score_category_save', 'score_category_remove') and member.role <> 'admin' then
  raise exception 'Admin access required';
 end if;

 case action
 when 'score_category_save' then
  if nullif(trim(payload->>'name'), '') is null then raise exception 'Category name required'; end if;
  item := coalesce((payload->>'id')::uuid, gen_random_uuid());
  if payload->>'id' is not null then
   update public.hf_score_categories set name = trim(payload->>'name'), description = coalesce(trim(payload->>'description'), '')
    where company_id = cid and id = item and archived_at is null;
   if not found then raise exception 'Category is no longer available'; end if;
  else
   if (select count(*) from public.hf_score_categories where company_id = cid and archived_at is null) >= 50 then
    raise exception 'Use up to 50 score categories';
   end if;
   insert into public.hf_score_categories(id, company_id, name, description, position)
    values (item, cid, trim(payload->>'name'), coalesce(trim(payload->>'description'), ''),
     coalesce((select max(position) + 1 from public.hf_score_categories where company_id = cid), 0));
  end if;
 when 'score_category_remove' then
  item := (payload->>'id')::uuid;
  update public.hf_score_categories set archived_at = now() where company_id = cid and id = item and archived_at is null;
  if not found then raise exception 'Category is no longer available'; end if;
 when 'scores_save' then
  if payload->'rating_scale' is distinct from '10'::jsonb then
   raise exception 'The rating scale changed. Refresh the page before saving';
  end if;
  item := (payload->>'candidate_id')::uuid;
  if not exists (select 1 from public.hf_candidates where company_id = cid and id = item) then
   raise exception 'Candidate access denied';
  end if;
  if jsonb_typeof(payload->'scores') is distinct from 'array' then raise exception 'Scores must be a list'; end if;
  if jsonb_array_length(payload->'scores') not between 1 and 50 then raise exception 'Save between 1 and 50 scores'; end if;
  if (select count(*) from jsonb_array_elements(payload->'scores')) <>
     (select count(distinct value->>'category_id') from jsonb_array_elements(payload->'scores')) then
   raise exception 'Each category can only appear once';
  end if;
  for entry in select value from jsonb_array_elements(payload->'scores') loop
   if not exists (select 1 from public.hf_score_categories
      where company_id = cid and id = (entry->>'category_id')::uuid and archived_at is null) then
    raise exception 'The scorecard has changed. Reload it before saving';
   end if;
   if not (entry ? 'rating') or (jsonb_typeof(entry->'rating') <> 'null' and
      (jsonb_typeof(entry->'rating') <> 'number' or (entry->>'rating') !~ '^(10|[0-9])$')) then
    raise exception 'Ratings must be whole numbers from 0 to 10, or not assessed';
   end if;
   if not (entry ? 'expected_version') or (jsonb_typeof(entry->'expected_version') <> 'null' and
      (jsonb_typeof(entry->'expected_version') <> 'number' or (entry->>'expected_version') !~ '^[1-9][0-9]*$')) then
    raise exception 'Score version required';
   end if;
   select * into existing from public.hf_candidate_scores
    where company_id = cid and candidate_id = item and category_id = (entry->>'category_id')::uuid;
   if existing.version is distinct from (entry->>'expected_version')::integer then
    raise exception 'Someone updated these scores. Reload them before saving your changes';
   end if;
   insert into public.hf_candidate_scores(company_id, candidate_id, category_id, rating, note, updated_by)
    values (cid, item, (entry->>'category_id')::uuid, (entry->>'rating')::smallint, coalesce(trim(entry->>'note'), ''), actor)
    on conflict (company_id, candidate_id, category_id) do update
     set rating = excluded.rating, note = excluded.note, updated_by = actor, updated_at = now(),
         version = public.hf_candidate_scores.version + 1
    returning * into saved;
   saved_rows := saved_rows || jsonb_build_array(to_jsonb(saved));
  end loop;
  return jsonb_build_object('id', item, 'scores', saved_rows);
 else raise exception 'Unknown score action';
 end case;
 return jsonb_build_object('id', item);
exception when unique_violation then
 raise exception 'A score category with that name already exists';
end $$;
revoke all on function public.hf_score_mutate(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.hf_score_mutate(uuid, uuid, text, jsonb) to service_role;


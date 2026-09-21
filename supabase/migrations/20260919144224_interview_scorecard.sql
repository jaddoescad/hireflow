-- A single company-wide interview scorecard, independent of job titles.
create table public.hf_score_categories (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.hf_companies(id) on delete cascade,
 name text not null check (name = trim(name) and length(name) between 1 and 80),
 description text not null default '' check (length(description) <= 500),
 position integer not null check (position >= 0),
 archived_at timestamptz,
 unique (company_id, id)
);
create unique index hf_score_categories_active_name
 on public.hf_score_categories(company_id, lower(name)) where archived_at is null;

create table public.hf_candidate_scores (
 company_id uuid not null references public.hf_companies(id) on delete cascade,
 candidate_id uuid not null,
 category_id uuid not null,
 rating smallint check (rating between 1 and 5),
 note text not null default '' check (length(note) <= 2000),
 updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now(),
 version integer not null default 1 check (version > 0),
 primary key (company_id, candidate_id, category_id),
 foreign key (company_id, candidate_id) references public.hf_candidates(company_id, id) on delete cascade,
 foreign key (company_id, category_id) references public.hf_score_categories(company_id, id)
);
create index hf_candidate_scores_category on public.hf_candidate_scores(company_id, category_id);
create index hf_candidate_scores_reviewer on public.hf_candidate_scores(updated_by);

alter table public.hf_score_categories enable row level security;
alter table public.hf_candidate_scores enable row level security;
revoke all on public.hf_score_categories, public.hf_candidate_scores from public, anon, authenticated;
grant select on public.hf_score_categories, public.hf_candidate_scores to authenticated;
grant all on public.hf_score_categories, public.hf_candidate_scores to service_role;
create policy member_read on public.hf_score_categories for select to authenticated
 using (hf_private.has_access(company_id));
create policy member_read on public.hf_candidate_scores for select to authenticated
 using (hf_private.has_access(company_id));

-- Run under the existing server-only create_company transaction, never on the client.
create function hf_private.seed_score_categories() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
 insert into public.hf_score_categories(company_id, name, description, position) values
  (new.id, 'Communication', 'Gives clear answers, listens, and understands questions.', 0),
  (new.id, 'Professionalism', 'Speaks respectfully and handles the conversation appropriately.', 1),
  (new.id, 'Relevant experience', 'Describes similar work, responsibilities, and specific examples.', 2),
  (new.id, 'Job knowledge', 'Explains how to approach common tasks for the role.', 3),
  (new.id, 'Problem-solving', 'Gives practical answers to realistic job scenarios.', 4),
  (new.id, 'Coachability', 'Describes responding to feedback and learning something new.', 5),
  (new.id, 'Interest in the role', 'Understands the position and explains why they want it.', 6);
 return new;
end $$;
revoke all on function hf_private.seed_score_categories() from public, anon, authenticated;
grant execute on function hf_private.seed_score_categories() to service_role;
create trigger hf_company_score_categories after insert on public.hf_companies
 for each row execute function hf_private.seed_score_categories();

insert into public.hf_score_categories(company_id, name, description, position)
select c.id, v.name, v.description, v.position from public.hf_companies c cross join (values
 ('Communication', 'Gives clear answers, listens, and understands questions.', 0),
 ('Professionalism', 'Speaks respectfully and handles the conversation appropriately.', 1),
 ('Relevant experience', 'Describes similar work, responsibilities, and specific examples.', 2),
 ('Job knowledge', 'Explains how to approach common tasks for the role.', 3),
 ('Problem-solving', 'Gives practical answers to realistic job scenarios.', 4),
 ('Coachability', 'Describes responding to feedback and learning something new.', 5),
 ('Interest in the role', 'Understands the position and explains why they want it.', 6)
) as v(name, description, position);

-- Use the same company lock as hf_mutate so revocation and category changes are atomic.
create function public.hf_score_mutate(actor uuid, cid uuid, action text, payload jsonb)
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
      (jsonb_typeof(entry->'rating') <> 'number' or (entry->>'rating') !~ '^[1-5]$')) then
    raise exception 'Ratings must be whole numbers from 1 to 5, or not assessed';
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

-- Computed on read: removing a category immediately updates all card averages.
-- security_invoker preserves membership RLS on candidates, categories, and ratings.
create view public.hf_candidates_with_scores with (security_invoker = true) as
 select c.*, summary.score_average, summary.score_count
 from public.hf_candidates c
 left join lateral (
  select round(avg(s.rating), 1) as score_average, count(s.rating)::integer as score_count
  from public.hf_candidate_scores s
  join public.hf_score_categories category on category.company_id = s.company_id
   and category.id = s.category_id and category.archived_at is null
  where s.company_id = c.company_id and s.candidate_id = c.id
 ) summary on true;
revoke all on public.hf_candidates_with_scores from public, anon, authenticated;
grant select on public.hf_candidates_with_scores to authenticated, service_role;

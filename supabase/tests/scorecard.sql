-- Run with psql against an isolated test database after applying migrations.
-- All synthetic fixtures are rolled back.
begin;
create function pg_temp.check_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %', message; end if; end $$;
create function pg_temp.must_fail(statement text, expected text) returns void language plpgsql as $$
declare failed boolean := false;
begin
 begin execute statement;
 exception when others then
  failed := true;
  if position(expected in sqlerrm) = 0 then raise exception 'Wrong error: %, expected %', sqlerrm, expected; end if;
 end;
 if not failed then raise exception 'Expected error containing %', expected; end if;
end $$;

do $$
declare owner_id uuid := gen_random_uuid(); teammate uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
 company uuid; other_company uuid; candidate uuid; other_candidate uuid; category uuid; category2 uuid; removed uuid; other_category uuid;
 stage uuid; output jsonb; application jsonb; intake jsonb; event jsonb; next_stage record;
begin
 insert into auth.users(id,email,email_confirmed_at) values
  (owner_id, 'score-owner@example.com', now()), (teammate, 'score-member@example.com', now()), (outsider, 'score-other@example.com', now());
 execute 'set local role service_role';
 perform set_config('test.owner', owner_id::text, true);
 perform set_config('test.member', teammate::text, true);
 perform set_config('test.other', outsider::text, true);
 company := (public.hf_mutate(owner_id, null, 'create_company', '{"name":"Scorecard test A"}')->>'id')::uuid;
 other_company := (public.hf_mutate(outsider, null, 'create_company', '{"name":"Scorecard test B"}')->>'id')::uuid;
 perform set_config('test.company', company::text, true);
 perform set_config('test.other_company', other_company::text, true);
 perform public.hf_mutate(owner_id,company,'invite',jsonb_build_object('email','score-member@example.com','role','member','token_hash','score-test-' || company));
 perform pg_temp.must_fail(format('select public.hf_mutate(%L,null,''accept_invitation'',%L)',outsider,jsonb_build_object('token_hash','score-test-' || company)), 'different email');
 perform public.hf_mutate(teammate,null,'accept_invitation',jsonb_build_object('token_hash','score-test-' || company));
 perform public.hf_mutate(teammate,null,'accept_invitation',jsonb_build_object('token_hash','score-test-' || company));
 perform pg_temp.check_that((select count(*) = 1 from public.hf_members where company_id = company and user_id = teammate), 'Invitation retries preserve a single membership');
 perform pg_temp.check_that((select count(*) = 7 from public.hf_score_categories where company_id = company), 'New companies get seven common categories');
 select id into stage from public.hf_stages where company_id = company order by position limit 1;
 candidate := (public.hf_mutate(owner_id,company,'candidate_save',jsonb_build_object('name','Alex Example','stage_id',stage,'job_title','Painter','experience','','tags','[]'::jsonb))->>'id')::uuid;
 select id into stage from public.hf_stages where company_id = other_company order by position limit 1;
 other_candidate := (public.hf_mutate(outsider,other_company,'candidate_save',jsonb_build_object('name','Casey Sample','stage_id',stage,'job_title','Crew lead','experience','','tags','[]'::jsonb))->>'id')::uuid;
 select id into category from public.hf_score_categories where company_id = company and name = 'Communication';
 select id into category2 from public.hf_score_categories where company_id = company and name = 'Professionalism';
 select id into other_category from public.hf_score_categories where company_id = other_company limit 1;
 perform set_config('test.candidate', candidate::text, true);
 perform set_config('test.category', category::text, true);
 perform pg_temp.check_that((select score_average is null and score_count = 0 from public.hf_candidates_with_scores where id = candidate), 'Unrated cards have no numeric average');
 output := public.hf_score_mutate(teammate,company,'scores_save',jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(
  jsonb_build_object('category_id',category,'rating',4,'note','Clear examples','expected_version',null),
  jsonb_build_object('category_id',category2,'rating',null,'note','Not covered','expected_version',null))));
 perform pg_temp.check_that(jsonb_array_length(output->'scores') = 2, 'Members can save partial interview scores');
 perform pg_temp.check_that((select score_average = 4 and score_count = 1 from public.hf_candidates_with_scores where id = candidate), 'Unassessed values are excluded');
 perform public.hf_score_mutate(owner_id,company,'scores_save',jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(
  jsonb_build_object('category_id',category2,'rating',5,'note','','expected_version',1))));
 perform pg_temp.check_that((select score_average = 4.5 and score_count = 2 from public.hf_candidates_with_scores where id = candidate), 'Card average updates after a second rating');
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''scores_save'',%L)',owner_id,company,
  jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(jsonb_build_object('category_id',category,'rating',2,'expected_version',null)))), 'Someone updated');
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''score_category_save'',''{"name":"No"}'')',teammate,company), 'Admin access required');
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''score_category_remove'',%L)',teammate,company,jsonb_build_object('id',category)), 'Admin access required');
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''score_category_save'',''{"name":" communication "}'')',owner_id,company), 'already exists');
 removed := (public.hf_score_mutate(owner_id,company,'score_category_save','{"name":"Listening","description":"Understands the question"}')->>'id')::uuid;
 perform public.hf_score_mutate(owner_id,company,'score_category_save',jsonb_build_object('id',removed,'name','Active listening','description','Asks clarifying questions'));
 perform pg_temp.check_that((select name = 'Active listening' from public.hf_score_categories where id = removed), 'Category editing persists');
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''scores_save'',%L)',outsider,company,
  jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(jsonb_build_object('category_id',category,'rating',5,'expected_version',1)))), 'Company access denied');
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''scores_save'',%L)',owner_id,company,
  jsonb_build_object('rating_scale',10,'candidate_id',other_candidate,'scores',jsonb_build_array(jsonb_build_object('category_id',category,'rating',5,'expected_version',null)))), 'Candidate access denied');
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''scores_save'',%L)',owner_id,company,
  jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(jsonb_build_object('category_id',other_category,'rating',5,'expected_version',null)))), 'scorecard has changed');
 -- A bad second row rolls back the first row too.
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''scores_save'',%L)',owner_id,company,
  jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(
   jsonb_build_object('category_id',category,'rating',2,'expected_version',1),
   jsonb_build_object('category_id',category2,'rating',11,'expected_version',2)))), 'whole numbers');
 perform pg_temp.check_that((select rating = 4 and version = 1 from public.hf_candidate_scores where company_id = company and candidate_id = candidate and category_id = category), 'Failed batches are atomic');
 perform public.hf_score_mutate(owner_id,company,'score_category_remove',jsonb_build_object('id',category2));
 perform pg_temp.check_that((select score_average = 4 and score_count = 1 from public.hf_candidates_with_scores where id = candidate), 'Removed categories immediately leave the average');
 perform pg_temp.check_that((select rating = 5 from public.hf_candidate_scores where company_id = company and candidate_id = candidate and category_id = category2), 'Removed ratings remain in history');
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''scores_save'',%L)',owner_id,company,
  jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(jsonb_build_object('category_id',category2,'rating',4,'expected_version',2)))), 'scorecard has changed');
 perform public.hf_score_mutate(owner_id,company,'scores_save',jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(
  jsonb_build_object('category_id',category,'rating',null,'note','','expected_version',1))));
 perform pg_temp.check_that((select score_average is null and score_count = 0 from public.hf_candidates_with_scores where id = candidate), 'Clearing the last active rating resets the badge');
 -- Zero is a real assessed score; both scale endpoints persist.
 perform public.hf_score_mutate(owner_id,company,'scores_save',jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(
  jsonb_build_object('category_id',category,'rating',0,'expected_version',2))));
 perform pg_temp.check_that((select score_average = 0 and score_count = 1 from public.hf_candidates_with_scores where id = candidate), 'Zero is assessed');
 perform public.hf_score_mutate(owner_id,company,'scores_save',jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(
  jsonb_build_object('category_id',category,'rating',10,'expected_version',3))));
 perform pg_temp.check_that((select score_average = 10 and score_count = 1 from public.hf_candidates_with_scores where id = candidate), 'Ten is valid');
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''scores_save'',%L)',owner_id,company,
  jsonb_build_object('candidate_id',candidate,'scores',jsonb_build_array(jsonb_build_object('category_id',category,'rating',5,'expected_version',4)))), 'rating scale changed');
 perform pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''scores_save'',%L)',owner_id,company,
  jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(jsonb_build_object('category_id',category,'rating',-1,'expected_version',4)))), 'whole numbers');
 perform public.hf_score_mutate(owner_id,company,'scores_save',jsonb_build_object('rating_scale',10,'candidate_id',candidate,'scores',jsonb_build_array(
  jsonb_build_object('category_id',category,'rating',null,'expected_version',4))));
 -- Recreating a removed name is allowed; old ratings must not attach to it.
 perform public.hf_score_mutate(owner_id,company,'score_category_save','{"name":"Professionalism"}');
 perform pg_temp.check_that((select score_average is null from public.hf_candidates_with_scores where id = candidate), 'Recreated categories start unrated');
 -- Existing hiring flow still works alongside the new company trigger and summary view.
 for next_stage in select id from public.hf_stages where company_id = company and position between 1 and 4 order by position loop
  perform public.hf_mutate(owner_id,company,'move',jsonb_build_object('id',candidate,'stage_id',next_stage.id));
 end loop;
 perform public.hf_mutate(teammate,company,'note',jsonb_build_object('rating_scale',10,'candidate_id',candidate,'body','Synthetic interview note'));
 perform pg_temp.check_that((select s.name = 'Hired' from public.hf_candidates c join public.hf_stages s on s.id = c.stage_id where c.id = candidate), 'Candidate moves through interviews and trial to hired');
 application := jsonb_build_object('source_id','synthetic-lead','source','Test','name','Morgan Demo','phone','+16135550123','email','morgan@example.com','job_title','Painter','experience','','tags','[]'::jsonb,'attributes','{}'::jsonb);
 intake := public.hf_ingest(company,'intake',application);
 output := public.hf_ingest(company,'intake',application);
 perform pg_temp.check_that(output->>'id' = intake->>'id' and (output->>'duplicate')::boolean, 'Application retries deduplicate');
 event := jsonb_build_object('external_id','synthetic-scorecard-call','kind','call','direction','incoming','body','Synthetic call','phone','+16135550123','occurred_at',now());
 perform public.hf_ingest(company,'quo',event);
 perform public.hf_ingest(company,'quo',event);
 perform pg_temp.check_that((select count(*) = 1 from public.hf_activities where company_id = company and external_id = 'synthetic-scorecard-call' and candidate_id = (intake->>'id')::uuid), 'Call retries deduplicate and match the candidate');
 update public.hf_score_categories set archived_at = now() where company_id = company and archived_at is null;
 perform pg_temp.check_that((select count(*) = 0 from public.hf_score_categories where company_id = company and archived_at is null), 'All categories can be removed');
 perform pg_temp.check_that((select score_average is null and score_count = 0 from public.hf_candidates_with_scores where id = candidate), 'Empty scorecards stay unscored');
 raise notice 'PASS: defaults, editing, partial scores, averages, clearing, archive history, conflicts, atomic saves and cross-company mutations';
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);
select pg_temp.check_that((select count(*) = 2 from public.hf_candidates_with_scores), 'Summary view enforces tenant RLS');
select pg_temp.check_that((select count(*) = 0 from public.hf_score_categories where company_id = current_setting('test.other_company')::uuid), 'Category tenant isolation');
select pg_temp.check_that((select count(*) = 0 from public.hf_candidate_scores where company_id = current_setting('test.other_company')::uuid), 'Rating tenant isolation');
select pg_temp.must_fail('insert into public.hf_score_categories(company_id,name,position) values(gen_random_uuid(),''Forbidden'',0)', 'permission denied');
select pg_temp.must_fail('update public.hf_candidate_scores set rating = 1', 'permission denied');
select pg_temp.must_fail('delete from public.hf_score_categories', 'permission denied');
select pg_temp.must_fail('select public.hf_score_mutate(null,null,''scores_save'',''{}'')', 'permission denied');
reset role;

set local role service_role;
select public.hf_mutate(current_setting('test.owner')::uuid,current_setting('test.company')::uuid,'member',jsonb_build_object('user_id',current_setting('test.member'),'role','member','enabled',false));
select pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''score_category_save'',''{"name":"No"}'')',current_setting('test.member'),current_setting('test.company')), 'Company access denied');
select pg_temp.must_fail(format('select public.hf_score_mutate(%L,%L,''scores_save'',%L)',current_setting('test.member'),current_setting('test.company'),jsonb_build_object('rating_scale',10,'candidate_id',current_setting('test.candidate'),'scores','[]'::jsonb)), 'Company access denied');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.member'), true);
select pg_temp.check_that((select count(*) = 0 from public.hf_score_categories), 'Disabled member cannot read categories');
select pg_temp.check_that((select count(*) = 0 from public.hf_candidate_scores), 'Disabled member cannot read scores');
select pg_temp.check_that((select count(*) = 0 from public.hf_candidates_with_scores), 'Disabled member cannot read averages');
reset role;
set local role anon;
select pg_temp.must_fail('select * from public.hf_candidates_with_scores', 'permission denied');
select pg_temp.must_fail('select * from public.hf_candidate_scores', 'permission denied');
select pg_temp.must_fail('select * from public.hf_score_categories', 'permission denied');
reset role;
rollback;

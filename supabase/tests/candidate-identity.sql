-- Synthetic integration checks; always rolled back, including auth fixtures.
begin;
create function pg_temp.check_identity(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %',message; end if; end $$;
do $$
declare actor uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); cid uuid; outside uuid;
 first_id uuid; second_id uuid; stage uuid; application jsonb; result jsonb; failed boolean; worker uuid; generation uuid;
begin
 insert into auth.users(id,email,email_confirmed_at) values(actor,'identity-owner@example.com',now()),(other,'identity-other@example.com',now());
 execute 'set local role service_role';
 cid:=(public.hf_mutate(actor,null,'create_company','{"name":"Identity test"}')->>'id')::uuid;
 outside:=(public.hf_mutate(other,null,'create_company','{"name":"Identity other"}')->>'id')::uuid;
 application:='{"name":"Alex Example","email":"alex.identity@example.com","phone":"+12025550123","source":"Synthetic","source_id":"first","job_title":"Painter","experience":"Synthetic experience","tags":[],"attributes":{"Form answers":[{"question":"Availability","answer":"Weekdays"}]}}';
 first_id:=(public.hf_ingest(cid,'intake',application)->>'id')::uuid;
 result:=public.hf_ingest(cid,'intake',application);
 perform pg_temp.check_identity((result->>'id')::uuid=first_id and (result->>'duplicate')::boolean,'Same submission retry');
 select id into stage from public.hf_stages where company_id=cid and name='Initial interview';
 perform public.hf_mutate(actor,cid,'move',jsonb_build_object('id',first_id,'stage_id',stage));
 application:=jsonb_set(application,'{source_id}','"second"');
 second_id:=(public.hf_ingest(cid,'intake',application)->>'id')::uuid;
 perform pg_temp.check_identity(first_id=second_id,'Repeat submission reuses candidate');
 perform pg_temp.check_identity((select count(*)=1 from public.hf_candidates where company_id=cid),'Only one candidate');
 perform pg_temp.check_identity((select stage_id=stage from public.hf_candidates where id=first_id),'Hiring stage preserved');
 perform pg_temp.check_identity((select count(*)=2 from public.hf_candidate_submissions where company_id=cid),'Both submissions preserved');
 perform pg_temp.check_identity((select count(*)=1 from public.hf_activities where company_id=cid and body like 'Repeat application%Weekdays%'),'Repeat answers visible');
 perform public.hf_ingest(cid,'intake',application);
 perform pg_temp.check_identity((select count(*)=2 from public.hf_candidate_submissions where company_id=cid),'Repeat retry idempotent');
 second_id:=(public.hf_ingest(outside,'intake',application)->>'id')::uuid;
 perform pg_temp.check_identity(first_id<>second_id,'Same contacts across companies are independent');
 failed:=false;
 begin
  perform public.hf_mutate(actor,cid,'candidate_save',jsonb_build_object('name','Duplicate Example','email','alex.identity@example.com','stage_id',stage,'job_title','','experience','','tags','[]'::jsonb));
 exception when others then
  if position('already uses' in sqlerrm)=0 then raise; end if; failed:=true;
 end;
 perform pg_temp.check_identity(failed,'Manual duplicate blocked');
 failed:=false;
 begin
  perform public.hf_ingest(cid,'intake',application||'{"source_id":"conflict","phone":"+12025550124"}');
 exception when others then
  if position('conflict' in sqlerrm)=0 then raise; end if; failed:=true;
 end;
 perform pg_temp.check_identity(failed,'Conflicting contact rejected without losing submission');
 perform pg_temp.check_identity((select count(*)=2 from public.hf_candidate_submissions where company_id=cid),'Conflict rolls back');
 application:='{"kind":"sms","direction":"incoming","phone":"+12025550123","body":"Synthetic text","external_id":"quo:sms:identity-test","occurred_at":"2026-10-02T12:00:00Z","metadata":{}}';
 perform public.hf_ingest(cid,'quo',application);
 perform public.hf_ingest(cid,'quo',application);
 perform pg_temp.check_identity((select count(*)=1 and bool_and(candidate_id=first_id) from public.hf_activities where company_id=cid and external_id='quo:sms:identity-test'),'Webhook retry and conversation matching');
 -- Read isolation and disabled membership apply to the new submissions table.
 perform set_config('request.jwt.claim.sub',actor::text,true);
 execute 'set local role authenticated';
 perform pg_temp.check_identity((select count(*)=2 from public.hf_candidate_submissions where company_id=cid),'Member sees submissions');
 perform pg_temp.check_identity((select count(*)=0 from public.hf_candidate_submissions where company_id=outside),'Other company inaccessible');
 execute 'set local role service_role';
 update public.hf_members set enabled=false where company_id=cid and user_id=actor;
 execute 'set local role authenticated';
 perform pg_temp.check_identity((select count(*)=0 from public.hf_candidate_submissions where company_id=cid),'Disabled member cannot read');
 execute 'set local role service_role';
 failed:=false;
 begin perform public.hf_mutate(actor,cid,'note',jsonb_build_object('candidate_id',first_id,'body','Blocked'));
 exception when others then if position('access denied' in sqlerrm)=0 then raise; end if; failed:=true; end;
 perform pg_temp.check_identity(failed,'Disabled mutation blocked');
end $$;
rollback;

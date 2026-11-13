-- Synthetic fixtures only. Run after migrations; the transaction always rolls back.
begin;
create function pg_temp.meta_check(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %',message; end if; end $$;
create function pg_temp.meta_denied(statement text) returns void language plpgsql as $$
declare failed boolean:=false;
begin
 begin execute statement; exception when others then failed:=true; end;
 if not failed then raise exception 'Expected access/validation failure'; end if;
end $$;
do $$
declare owner_id uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); cid uuid; other_cid uuid;
 connection jsonb; settings jsonb; payload jsonb; result jsonb; job public.hf_meta_leads; candidate uuid;
begin
 insert into auth.users(id,email,email_confirmed_at) values(owner_id,'meta-owner@example.com',now()),(outsider,'meta-other@example.com',now());
 execute 'set local role service_role';
 cid:=(public.hf_mutate(owner_id,null,'create_company','{"name":"Meta test A"}')->>'id')::uuid;
 other_cid:=(public.hf_mutate(outsider,null,'create_company','{"name":"Meta test B"}')->>'id')::uuid;
 connection:='{"page_id":"301","page_name":"Example Page","app_id":"401","credentials":"synthetic-encrypted","verify_hash":"synthetic-hash"}';
 settings:='{"forms":[{"id":"101","name":"Example form","applicant_type":"Interior","job_title":"Painter","sms":"Synthetic acknowledgement"}],"notification_email":"hiring@example.com","sender_name":"Example Hiring"}';
 perform public.hf_meta_set(owner_id,cid,'connect',connection);
 perform public.hf_meta_set(owner_id,cid,'settings',settings);
 perform pg_temp.meta_denied(format('select public.hf_meta_set(%L,%L,''settings'',%L)',owner_id,cid,settings||'{"generation":"2020-01-01T00:00:00Z"}'::jsonb));
 perform pg_temp.meta_denied(format('select public.hf_meta_set(%L,%L,''pause'',''{}'')',outsider,cid));
 perform pg_temp.meta_denied(format('select public.hf_meta_set(%L,%L,''connect'',%L)',outsider,other_cid,connection));
 perform pg_temp.meta_check(not public.hf_meta_enqueue('999','101','201'),'Unknown Pages are ignored');
 perform pg_temp.meta_check(not public.hf_meta_enqueue('301','999','201'),'Unselected forms are ignored');
 perform pg_temp.meta_check(public.hf_meta_enqueue('301','101','201'),'Configured form is queued');
 perform public.hf_meta_enqueue('301','101','201');
 perform pg_temp.meta_check((select count(*)=1 from public.hf_meta_leads where company_id=cid),'Webhook retries create one job');
 select * into job from public.hf_meta_claim(cid);
 perform pg_temp.meta_check(job.lead_id='201','A company claims its own application');
 perform pg_temp.meta_check(not exists(select 1 from public.hf_meta_claim(cid)),'An unexpired lease cannot be claimed twice');
 payload:=jsonb_build_object('source','Meta','source_id','201','name','Alex Example','email','alex@example.com','phone','+16135550123',
  'job_title','Painter','experience','3 years','tags','[]'::jsonb,'attributes',jsonb_build_object('Meta form ID','101','Form','Example form',
   'Applied at',now(),'Form answers','[{"question":"A brand new question","answer":"Synthetic complete answer"}]'::jsonb));
 perform pg_temp.meta_check(public.hf_meta_step(other_cid,'201',job.lease_id,'ingest',payload) is null,'A lease cannot cross companies');
 perform pg_temp.meta_check(public.hf_meta_step(cid,'201',gen_random_uuid(),'ingest',payload) is null,'A stale worker cannot ingest');
 result:=public.hf_meta_step(cid,'201',job.lease_id,'ingest',payload);
 candidate:=(result->>'candidate_id')::uuid;
 perform pg_temp.meta_check(candidate is not null,'Direct lead creates a candidate');
 perform pg_temp.meta_check(result->>'email_state'='skipped' and result->>'sms_state'='skipped','Verification mode sends no messages');
 perform pg_temp.meta_check((select count(*)=1 from public.hf_activities where company_id=cid and candidate_id=candidate and body like '%Synthetic complete answer%'),'All answers reach Notes atomically');
 perform public.hf_meta_step(cid,'201',job.lease_id,'release');
 perform public.hf_meta_enqueue('301','101','201');
 perform pg_temp.meta_check(not exists(select 1 from public.hf_meta_claim(cid)),'Completed webhook retries never restart delivery');
 perform public.hf_meta_set(owner_id,cid,'activate','{}');
 perform public.hf_meta_enqueue('301','101','202');
 select * into job from public.hf_meta_claim(cid);
 payload:=jsonb_set(payload,'{source_id}','"202"');
 result:=public.hf_meta_step(cid,'202',job.lease_id,'ingest',payload);
 perform pg_temp.meta_check(result->>'email_state'='pending' and result->>'sms_state'='pending','New live applications schedule both messages');
 perform pg_temp.meta_check((result->>'candidate_id')::uuid=candidate,'Repeat applications retain candidate identity');
 perform public.hf_meta_step(cid,'202',job.lease_id,'email_start');
 perform public.hf_meta_step(cid,'202',job.lease_id,'email_finish','{"state":"sent","receipt":"synthetic-receipt"}');
 perform pg_temp.meta_check(public.hf_meta_step(cid,'202',job.lease_id,'email_start') is null,'Accepted email is never resent');
 perform public.hf_meta_step(cid,'202',job.lease_id,'sms_start');
 update public.hf_meta_leads set lease_until=now()-interval '1 minute' where company_id=cid and lead_id='202';
 select * into job from public.hf_meta_claim(cid);
 perform pg_temp.meta_check(job.email_state='sent' and job.sms_state='uncertain','A crash after sending preserves receipt and flags uncertainty');
 perform public.hf_meta_step(cid,'202',job.lease_id,'release');
 -- Existing Zapier submissions are not sent again during overlap/catch-up.
 payload:=jsonb_set(payload,'{source_id}','"203"');
 perform public.hf_ingest(cid,'intake',payload);
 perform public.hf_meta_enqueue('301','101','203');
 select * into job from public.hf_meta_claim(cid);
 result:=public.hf_meta_step(cid,'203',job.lease_id,'ingest',payload);
 perform pg_temp.meta_check(result->>'email_state'='skipped' and result->>'sms_state'='skipped','Zapier overlap never replays notifications for existing submissions');
 perform public.hf_meta_step(cid,'203',job.lease_id,'release');
 perform public.hf_meta_enqueue('301','101','204');
 select * into job from public.hf_meta_claim(cid);
 payload:=jsonb_set(jsonb_set(payload,'{source_id}','"204"'),'{attributes,Applied at}','"2020-01-01T00:00:00Z"');
 result:=public.hf_meta_step(cid,'204',job.lease_id,'ingest',payload);
 perform pg_temp.meta_check(result->>'sms_state'='skipped','Historical catch-up does not text old applicants');
 perform public.hf_meta_step(cid,'204',job.lease_id,'release');
 perform public.hf_meta_enqueue('301','101','207');
 select * into job from public.hf_meta_claim(cid);
 update public.hf_meta_leads set attempts=10,email_state='sending',lease_until=now()-interval '1 minute' where company_id=cid and lead_id='207';
 perform public.hf_meta_claim(cid);
 perform pg_temp.meta_check((select state='failed' and email_state='uncertain' from public.hf_meta_leads where company_id=cid and lead_id='207'),'An exhausted crashed lease becomes visible for review');
 perform public.hf_meta_enqueue('301','101','205');
 select * into job from public.hf_meta_claim(cid);
 update public.hf_members set enabled=false where company_id=cid and user_id=owner_id;
 perform pg_temp.meta_check(not public.hf_meta_enqueue('301','101','206'),'Disabled connection admins cannot enqueue');
 perform pg_temp.meta_check(public.hf_meta_step(cid,'205',job.lease_id,'ingest',jsonb_set(payload,'{source_id}','"205"')) is null,'Disabled membership revokes active workers atomically');
 perform pg_temp.meta_denied(format('select public.hf_meta_set(%L,%L,''activate'',''{}'')',owner_id,cid));
 perform pg_temp.meta_check(not has_table_privilege('authenticated','public.hf_meta_connections','select'),'Credentials are inaccessible through the public client');
 perform pg_temp.meta_check(not has_table_privilege('authenticated','public.hf_meta_leads','insert'),'Clients cannot queue jobs directly');
 perform pg_temp.meta_check(not has_function_privilege('authenticated','public.hf_meta_step(uuid,text,uuid,text,jsonb)','execute'),'Ingestion RPC is server-only');
end $$;
rollback;

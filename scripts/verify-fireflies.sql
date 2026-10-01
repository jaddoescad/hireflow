-- Synthetic, rollback-only checks; no provider calls or real recordings.
begin;
do $$
declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); ca uuid; cb uuid; k uuid; s uuid:=gen_random_uuid(); claim jsonb; n integer;
begin
 insert into auth.users(id,email,email_confirmed_at) values(a,'fireflies-owner@example.test',now()),(b,'fireflies-outsider@example.test',now());
 ca:=(public.hf_mutate(a,null,'create_company','{"name":"Fireflies QA"}')->>'id')::uuid;
 cb:=(public.hf_mutate(b,null,'create_company','{"name":"Fireflies other QA"}')->>'id')::uuid;
 k:=(public.hf_mutate(a,ca,'candidate_save',jsonb_build_object('name','Synthetic Candidate','email','synthetic@example.test','phone','','job_title','Test','experience','','tags','[]'::jsonb,'stage_id',(select id from public.hf_stages where company_id=ca limit 1)))->>'id')::uuid;
 perform public.hf_google_set(a,ca,'hiring@example.test','synthetic-google','fixture');
 perform public.hf_interview_save(a,ca,jsonb_build_object('id',s,'version',0,'candidate_id',k,'title','Synthetic Interview','timezone','America/Toronto','starts_at',now()+interval '1 minute','ends_at',now()+interval '30 minutes','interviewer_ids',jsonb_build_array(a)));
 update public.hf_interviews set status='scheduled',meet_url='https://meet.google.com/abc-defg-hij' where id=s;
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/absent') is null, 'disconnected dispatched';
 begin perform public.hf_fireflies_set(b,ca,'fixture','recorder@example.test'); raise exception using errcode='HF999',message='outsider connected';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Admin access required',sqlerrm; end;
 perform public.hf_fireflies_set(a,ca,'encrypted-fixture','recorder@example.test');
 assert public.hf_fireflies_claim(cb,s,'conferenceRecords/cross-tenant') is null,'cross-company dispatch';
 update public.hf_interviews set cancel_requested=true where id=s;
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/cancelled') is null,'cancelled dispatched';
 update public.hf_interviews set cancel_requested=false where id=s;
 -- Every interview dispatches automatically.
 claim:=public.hf_fireflies_claim(ca,s,'conferenceRecords/synthetic');
 assert claim->>'credentials'='encrypted-fixture' and claim->>'meet_url'='https://meet.google.com/abc-defg-hij','valid reservation failed';
 assert (claim->>'duration')::integer=120,'duration must not depend on the scheduled end';
 -- Both very early and very late live sessions can request a recorder.
 update public.hf_interviews set synced_version=version,organizer_notified_version=version,starts_at=now()+interval '90 days',ends_at=now()+interval '90 days 30 minutes' where id=s;
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/early') is not null,'early meeting blocked';
 assert exists(select 1 from public.hf_meet_due(ca,'hiring@example.test','{}'::uuid[],10) where id=s),'early meeting excluded from polling';
 update public.hf_interviews set starts_at=now()-interval '90 days',ends_at=now()-interval '90 days'+interval '30 minutes' where id=s;
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/late') is not null,'late meeting blocked';
 assert exists(select 1 from public.hf_meet_due(ca,'hiring@example.test','{}'::uuid[],10) where id=s),'old meeting excluded from polling';
 update public.hf_interview_recordings set created_at=now()-interval '21 minutes' where company_id=ca;
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/synthetic') is null,'duplicate event dispatched';
 update public.hf_interview_recordings set state='failed' where company_id=ca;
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/synthetic') is null,'ambiguous timeout redispatched';
 -- A request three minutes before start must be deferred.
 update public.hf_interviews set starts_at=now()+interval '3 minutes',ends_at=now()+interval '33 minutes' where id=s;
 assert public.hf_fireflies_claim(ca,s,'scheduled') is null,'calendar request exceeded two-minute lead';
 -- Calendar preparation must work for a room with no conference history.
 update public.hf_interviews set starts_at=now()+interval '90 seconds',ends_at=now()+interval '30 minutes' where id=s;
 claim:=public.hf_fireflies_claim(ca,s,'scheduled');
 assert claim is not null,'calendar preparation missing';
 assert public.hf_fireflies_claim(ca,s,'scheduled') is null,'calendar polling duplicated bot';
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/prepared') is null,'live trigger duplicated calendar bot';
 assert exists(select 1 from public.hf_interview_recordings where company_id=ca and name=claim->>'name' and fireflies_conference='conferenceRecords/prepared'),'live conference not associated';
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/prepared') is null,'repeated live event duplicated bot';
 update public.hf_interviews set starts_at=now()+interval '1 hour',ends_at=now()+interval '90 minutes' where id=s;
 assert public.hf_fireflies_claim(ca,s,'scheduled') is null,'calendar preparation too early';
 update public.hf_interviews set starts_at=now()-interval '1 minute' where id=s;
 assert public.hf_fireflies_claim(ca,s,'scheduled') is null,'late calendar attempt';
 -- An expired lobby attempt must allow a new live conference request.
 update public.hf_interviews set starts_at=now()+interval '1 minute' where id=s;
 claim:=public.hf_fireflies_claim(ca,s,'scheduled');
 assert claim is not null,'rescheduled preparation missing';
 update public.hf_interview_recordings set created_at=now()-interval '14 minutes',join_at=now()-interval '14 minutes' where company_id=ca and name=claim->>'name';
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/after-lobby-expiry') is not null,'expired calendar attempt blocked live fallback';
 update public.hf_interview_recordings set created_at=now()-interval '21 minutes' where company_id=ca;

 -- Same-conference recovery requires verified absence, expiry and a stable previous attempt.
 claim:=public.hf_fireflies_claim(ca,s,'conferenceRecords/recovery');
 assert claim is not null,'recovery fixture missing';
 update public.hf_interview_recordings set state='waiting' where company_id=ca and name=claim->>'name';
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/recovery',claim->>'name') is null,'fresh request replaced';
 update public.hf_interview_recordings set join_at=now()-interval '14 minutes',created_at=now()-interval '14 minutes' where company_id=ca and name=claim->>'name';
 assert public.hf_fireflies_claim(cb,s,'conferenceRecords/recovery',claim->>'name') is null,'cross-company recovery';
 perform public.hf_fireflies_expire(cb,s,claim->>'name');
 assert (select state from public.hf_interview_recordings where company_id=ca and name=claim->>'name')='waiting','outsider expired visit';
 perform public.hf_fireflies_expire(ca,s,claim->>'name');
 assert (select state from public.hf_interview_recordings where company_id=ca and name=claim->>'name')='failed','empty visit not expired';
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/recovery',claim->>'name') is not null,'verified expired request did not recover';
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/recovery',claim->>'name') is null,'stale event duplicated recovery';
 update public.hf_interview_recordings set state='waiting',join_at=now()-interval '14 minutes' where company_id=ca and name like 'fireflies:recovery:%';
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/recovery',(select name from public.hf_interview_recordings where company_id=ca and name like 'fireflies:recovery:%' limit 1)) is null,'recovery loop';
 update public.hf_interview_recordings set created_at=now()-interval '21 minutes' where company_id=ca;

 update public.hf_members set enabled=false where company_id=ca and user_id=a;
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/disabled') is null,'disabled admin dispatched';
 begin perform public.hf_fireflies_test(a,ca); raise exception using errcode='HF999',message='disabled admin sent test';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Admin access required',sqlerrm; end;
 update public.hf_members set enabled=true where company_id=ca and user_id=a;
 assert public.hf_fireflies_test(a,ca)='encrypted-fixture','test failed';
 begin perform public.hf_fireflies_test(a,ca); raise exception using errcode='HF999',message='duplicate test dispatched';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm like 'Wait 20 minutes%',sqlerrm; end;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 select count(*) into n from public.hf_interview_recordings; assert n=8,'own recordings unreadable';
 begin perform 1 from public.hf_fireflies_connections; raise exception using errcode='HF999',message='credentials exposed';
 exception when sqlstate 'HF999' then raise; when insufficient_privilege then null; end;
 begin perform public.hf_fireflies_claim(ca,s,'conferenceRecords/browser'); raise exception using errcode='HF999',message='browser dispatched';
 exception when sqlstate 'HF999' then raise; when insufficient_privilege then null; end;
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',b,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 select count(*) into n from public.hf_interview_recordings; assert n=0,'other company recording exposed';
 execute 'reset role';
 update public.hf_members set enabled=false where company_id=ca and user_id=a;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 select count(*) into n from public.hf_interview_recordings; assert n=0,'disabled member recording exposed';
 execute 'reset role';
 update public.hf_members set enabled=true where company_id=ca and user_id=a;
 perform public.hf_fireflies_set(a,ca,null,null);
 assert public.hf_fireflies_claim(ca,s,'conferenceRecords/disconnected') is null,'disconnected account dispatched';
end $$;
rollback;

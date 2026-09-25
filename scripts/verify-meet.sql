-- Verifies Google connection, Meet and recording-storage database rules with synthetic records inside one transaction, then rolls back.
-- Run with psql or the Supabase SQL editor. Any failed check aborts with its message.
begin;
do $$
declare
 a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); d uuid:=gen_random_uuid();
 ca uuid; cb uuid; ka uuid; kb uuid; s1 uuid:=gen_random_uuid(); s2 uuid:=gen_random_uuid(); s3 uuid:=gen_random_uuid();
 lease jsonb; gen uuid; worker uuid; n integer; v integer; r record; rec jsonb;
 future timestamptz:=now()+interval '1 day';
 base jsonb;
begin
 insert into auth.users(id,email,email_confirmed_at) values(a,'meet-owner@example.com',now()),(b,'meet-outsider@example.com',now()),(d,'meet-interviewer@example.com',now());
 ca:=(public.hf_mutate(a,null,'create_company',jsonb_build_object('name','Meet QA'))->>'id')::uuid;
 cb:=(public.hf_mutate(b,null,'create_company',jsonb_build_object('name','Meet QA other'))->>'id')::uuid;
 ka:=(public.hf_mutate(a,ca,'candidate_save',jsonb_build_object('name','Synthetic Candidate','email','candidate-a@example.com','phone','','job_title','Painter','experience','','tags','[]'::jsonb,
  'stage_id',(select id from public.hf_stages where company_id=ca limit 1)))->>'id')::uuid;
 kb:=(public.hf_mutate(b,cb,'candidate_save',jsonb_build_object('name','Synthetic Candidate','email','candidate-b@example.com','phone','','job_title','Painter','experience','','tags','[]'::jsonb,
  'stage_id',(select id from public.hf_stages where company_id=cb limit 1)))->>'id')::uuid;
 insert into public.hf_members(company_id,user_id,email,role,enabled) values(ca,d,'meet-interviewer@example.com','member',true);
 base:=jsonb_build_object('version',0,'candidate_id',ka,'title','Painter interview','timezone','America/Toronto',
  'starts_at',future,'ends_at',future+interval '1 hour','interviewer_ids',jsonb_build_array(a),'auto_record',true);

 -- Connection and scheduling require enabled membership in the same company.
 begin perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',s1)); raise exception using errcode='HF999',message='saved without connection';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm like 'Connect Google first%', sqlerrm; end;
 begin perform public.hf_google_set(b,ca,'interviews@example.com','g-1','fixture'); raise exception using errcode='HF999',message='outsider connected';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Admin access required', sqlerrm; end;
 begin perform public.hf_google_set(d,ca,'interviews@example.com','g-1','fixture'); raise exception using errcode='HF999',message='member connected';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Admin access required', sqlerrm; end;
 perform public.hf_google_set(a,ca,' Interviews@Example.com ','g-1','fixture');
 perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',s1,'interviewer_ids',jsonb_build_array(a,d)));
 begin perform public.hf_interview_save(b,ca,base||jsonb_build_object('id',gen_random_uuid())); raise exception using errcode='HF999',message='outsider scheduled';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Company access denied', sqlerrm; end;
 begin perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',gen_random_uuid(),'interviewer_ids',jsonb_build_array(b))); raise exception using errcode='HF999',message='outsider invited';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Interviewer access denied', sqlerrm; end;
 begin perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',gen_random_uuid(),'candidate_id',kb)); raise exception using errcode='HF999',message='other company candidate';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm like 'Choose a candidate%', sqlerrm; end;
 begin perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',gen_random_uuid(),'starts_at',now()-interval '1 hour','ends_at',now())); raise exception using errcode='HF999',message='past scheduled';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm like '%future%', sqlerrm; end;
 select * into r from public.hf_interviews where id=s1;
 assert r.organizer='interviews@example.com' and jsonb_array_length(r.attendees)=3, 'organizer or attendees';
 -- The scheduler can correct the candidate email; it updates only this company's candidate and the invitation.
 perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',s3,'candidate_email',' Corrected@Example.com '));
 assert (select email from public.hf_candidates where id=ka)='corrected@example.com', 'candidate email not corrected';
 assert exists(select 1 from public.hf_interviews i, jsonb_array_elements(i.attendees) p where i.id=s3 and p->>'email'='corrected@example.com')
  and not exists(select 1 from public.hf_interviews i, jsonb_array_elements(i.attendees) p where i.id=s3 and p->>'email'='candidate-a@example.com'), 'invitation email';
 begin perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',gen_random_uuid(),'candidate_email','not-an-email'));
  raise exception using errcode='HF999',message='invalid email saved';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Enter a valid candidate email', sqlerrm; end;
 begin perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',gen_random_uuid(),'candidate_id',kb,'candidate_email','hijack@example.com'));
  raise exception using errcode='HF999',message='other company candidate edited';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm like 'Choose a candidate%', sqlerrm; end;
 assert (select email from public.hf_candidates where id=kb)='candidate-b@example.com', 'other company email changed';
 delete from public.hf_interviews where id=s3;
 update public.hf_candidates set email='candidate-a@example.com' where id=ka;

 -- Browser reads are limited to enabled members; connection credentials are never readable.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 select count(*) into n from public.hf_interviews; assert n=1, 'member read';
 begin perform 1 from public.hf_google_connections; raise exception using errcode='HF999',message='credentials readable';
 exception when sqlstate 'HF999' then raise; when insufficient_privilege then null; end;
 begin perform 1 from public.hf_storage_deletions; raise exception using errcode='HF999',message='storage queue readable';
 exception when sqlstate 'HF999' then raise; when insufficient_privilege then null; end;
 begin perform public.hf_recording_claim(10); raise exception using errcode='HF999',message='client claimed recordings';
 exception when sqlstate 'HF999' then raise; when insufficient_privilege then null; end;
 execute 'reset role';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',b,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 select count(*) into n from public.hf_interviews; assert n=0, 'outsider read';
 execute 'reset role';

 -- Exclusive leases, due order and stale-generation rejection.
 begin perform public.hf_meet_claim(ca,b); raise exception using errcode='HF999',message='outsider claimed';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Company access denied', sqlerrm; end;
 lease:=public.hf_meet_claim(ca,a); assert lease->>'state'='ready', 'claim';
 gen:=(lease->>'generation')::uuid; worker:=(lease->>'lease_id')::uuid;
 assert public.hf_meet_claim(ca,a)->>'state'='busy', 'second claim';
 perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',s2));
 select count(*) into n from public.hf_meet_due(ca,'interviews@example.com','{}',10); assert n=2, 'due';
 select count(*) into n from public.hf_meet_due(ca,'interviews@example.com',array[s1],10); assert n=1, 'due skip';
 begin perform public.hf_meet_commit(cb,gen,worker,s1,1,'{"sync":{"status":"scheduled"}}'); raise exception using errcode='HF999',message='cross-company commit';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Google connection changed', sqlerrm; end;
 begin perform public.hf_meet_commit(ca,gen_random_uuid(),worker,s1,1,'{"sync":{"status":"scheduled"}}'); raise exception using errcode='HF999',message='stale generation commit';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Google connection changed', sqlerrm; end;
 assert public.hf_meet_commit(ca,gen,worker,s1,1,jsonb_build_object('sync',jsonb_build_object('status','scheduled','meet_url','https://meet.google.com/abc-defg-hij',
  'meet_space','spaces/one','recording_setup','on','attendees',jsonb_build_array(jsonb_build_object('email','candidate-a@example.com','responseStatus','accepted'),
  jsonb_build_object('email','meet-owner@example.com','responseStatus','accepted'),jsonb_build_object('email','meet-interviewer@example.com','responseStatus','needsAction'))))), 'commit s1';
 assert public.hf_meet_commit(ca,gen,worker,s2,1,'{"sync":{"status":"scheduled","meet_space":"spaces/two","recording_setup":"on"}}'), 'commit s2';

 -- Confirmation recipients/payloads come from this company; retries do not acknowledge failed delivery.
 rec:=public.hf_interview_notification(ca,gen,worker,s1,1);
 assert rec->>'organizer'='interviews@example.com' and rec->>'candidate_name'='Synthetic Candidate', 'notification payload';
 assert public.hf_interview_notification(ca,gen,worker,s1,2) is null, 'unsynced notification';
 assert public.hf_interview_notification(ca,gen,worker,gen_random_uuid(),1) is null, 'missing notification';
 begin perform public.hf_interview_notification(cb,gen,worker,s1,1); raise exception using errcode='HF999',message='cross-company notification';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Google connection changed', sqlerrm; end;
 begin perform public.hf_interview_notification(ca,gen_random_uuid(),worker,s1,1); raise exception using errcode='HF999',message='stale notification worker';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Google connection changed', sqlerrm; end;
 perform public.hf_interview_notification(ca,gen,worker,s1,1,'{"error":"Synthetic delivery failure"}');
 select * into r from public.hf_interviews where id=s1;
 assert r.status='scheduled' and r.organizer_notified_version=0 and r.organizer_notification_error is not null, 'mail failure changed scheduling';
 assert public.hf_interview_notification(ca,gen,worker,s1,1) is not null, 'failed delivery not retryable';
 perform public.hf_interview_notification(ca,gen,worker,s1,1,'{"sent":true}');
 assert public.hf_interview_notification(ca,gen,worker,s1,1) is null, 'repeat notification';
 select * into r from public.hf_interviews where id=s1;
 assert r.organizer_notified_version=1 and r.organizer_notification_error is null, 'delivery not acknowledged';
 update public.hf_members set enabled=false where company_id=ca and user_id=d;
 update public.hf_interviews set organizer_notified_version=0 where id=s1;
 assert public.hf_interview_notification(ca,gen,worker,s1,1) is null, 'disabled interviewer notified';
 update public.hf_members set enabled=true where company_id=ca and user_id=d;
 update public.hf_interviews set updated_by=d where id=s2;
 update public.hf_members set enabled=false where company_id=ca and user_id=d;
 assert public.hf_interview_notification(ca,gen,worker,s2,1) is null, 'disabled author notified';
 update public.hf_members set enabled=true where company_id=ca and user_id=d;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 begin perform public.hf_interview_notification(ca,gen,worker,s1,1); raise exception using errcode='HF999',message='client notification access';
 exception when sqlstate 'HF999' then raise; when insufficient_privilege then null; end;
 execute 'reset role';

 -- An edit keeps known RSVPs; a stale Google result cannot overwrite it, but meeting facts still save.
 perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',s1,'version',1,'title','Second round','interviewer_ids',jsonb_build_array(a,d)));
 assert public.hf_interview_notification(ca,gen,worker,s1,1,'{"sent":true}') is null, 'stale email acknowledged';
 select * into r from public.hf_interviews where id=s1;
 assert (select p->>'responseStatus' from jsonb_array_elements(r.attendees) p where p->>'email'='candidate-a@example.com')='accepted', 'rsvp kept';
 rec:=jsonb_build_object('name','conferenceRecords/qa/recordings/r1','conference','conferenceRecords/qa','state','FILE_GENERATED',
  'starts_at',now()-interval '1 hour','ends_at',now()-interval '30 minutes','drive_file_id','file_1','playback_url','https://drive.google.com/file/d/file_1/view');
 assert not public.hf_meet_commit(ca,gen,worker,s1,1,jsonb_build_object('sync',jsonb_build_object('status','scheduled','title','Stale'),
  'observed',jsonb_build_object('started_at',now()-interval '1 hour','ended_at',now()-interval '30 minutes','recordings',jsonb_build_array(rec)))), 'stale accepted';
 select * into r from public.hf_interviews where id=s1;
 assert r.title='Second round' and r.synced_version=1 and r.meeting_started_at is not null and r.meeting_ended_at is not null, 'stale handling';
 perform public.hf_meet_commit(ca,gen,worker,s2,1,jsonb_build_object('observed',jsonb_build_object('started_at',now(),'ended_at',null,
  'recordings',jsonb_build_array(rec||'{"state":"ENDED"}'))));
 select count(*) into n from public.hf_interview_recordings where company_id=ca and interview_id=s1 and state='FILE_GENERATED'; assert n=1, 'recording ownership';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',b,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 select count(*) into n from public.hf_interview_recordings; assert n=0, 'outsider recording read';
 execute 'reset role';

 -- Cancellation is queued and applied by the worker.
 perform public.hf_interview_save(a,ca,jsonb_build_object('id',s2,'version',1,'cancel',true));
 begin perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',s2,'version',2)); raise exception using errcode='HF999',message='edited cancelled';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Session is cancelled', sqlerrm; end;
 assert public.hf_meet_commit(ca,gen,worker,s2,2,'{"sync":{"status":"cancelled"}}'), 'cancel commit';
 assert public.hf_interview_notification(ca,gen,worker,s2,2)->>'status'='cancelled', 'cancellation confirmation';
 update public.hf_interviews set starts_at=now()-interval '5 days 1 hour',ends_at=now()-interval '5 days' where id=s2;
 assert exists(select 1 from public.hf_meet_due(ca,'interviews@example.com','{}',10) where id=s2), 'email retry missing from due work';
 perform public.hf_interview_notification(ca,gen,worker,s2,2,'{"sent":true}');
 assert not exists(select 1 from public.hf_meet_due(ca,'interviews@example.com','{}',10) where id=s2), 'delivered cancellation still due';
 perform public.hf_meet_commit(ca,gen,worker,null,0,'{"release":null}');

 -- Saved recordings are claimed once per company for the organizer whose Drive holds them, then queued for
 -- storage cleanup when deleted. Another company's connection never supplies credentials.
 perform public.hf_google_set(b,cb,'other-company@example.com','g-9','fixture-other');
 select * into r from public.hf_recording_claim(10) c where c.company_id=ca;
 assert r.name='conferenceRecords/qa/recordings/r1' and r.credentials='fixture' and r.interview_id=s1, 'recording claim';
 select count(*) into n from public.hf_recording_claim(10) c where c.company_id=ca; assert n=0, 'claimed twice';
 update public.hf_interview_recordings set storage_key=ca||'/'||s1||'/r1.mp4',storage_claim_until=null where company_id=ca;
 select count(*) into n from public.hf_recording_claim(10) c where c.company_id=ca; assert n=0, 'saved recording claimed';

 -- Switching accounts is immediate. The earlier organizer's interviews keep their history but are no longer
 -- synced, edited or copied with the new grant; Gmail import restarts for a different mailbox.
 update public.hf_gmail_connections set history_id='42',bootstrap_started=true where company_id=ca;
 perform public.hf_google_set(a,ca,'interviews@example.com','g-1','fixture-2');
 assert (select history_id from public.hf_gmail_connections where company_id=ca)='42', 'same mailbox lost checkpoint';
 perform public.hf_google_set(a,ca,'other@example.com','g-2','fixture-3');
 assert (select history_id is null and not bootstrap_started from public.hf_gmail_connections where company_id=ca), 'new mailbox kept checkpoint';
 assert (select public.hf_gmail_claim(ca,a)->>'mailbox')='other@example.com', 'gmail account';
 begin perform public.hf_gmail_claim(ca,d); raise exception using errcode='HF999',message='member claimed gmail';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Admin access required', sqlerrm; end;
 select count(*) into n from public.hf_meet_due(ca,'other@example.com','{}',10); assert n=0, 'previous organizer due';
 begin perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',s1,'version',(select version from public.hf_interviews where id=s1)));
  raise exception using errcode='HF999',message='edited with another account';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm like '%another Google account%', sqlerrm; end;
 update public.hf_interview_recordings set storage_key=null where company_id=ca;
 select count(*) into n from public.hf_recording_claim(10) c where c.company_id=ca; assert n=0, 'copied with another account';
 perform public.hf_google_set(a,ca,'interviews@example.com','g-1','fixture-2');
 update public.hf_interview_recordings set storage_key=ca||'/'||s1||'/r1.mp4' where company_id=ca;

 -- Past interviews may be corrected but not moved to another past time.
 update public.hf_interviews set starts_at=now()-interval '3 hours',ends_at=now()-interval '2 hours' where id=s1 returning version into v;
 select * into r from public.hf_interviews where id=s1;
 perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',s1,'version',v,'title','Corrected','starts_at',r.starts_at,'ends_at',r.ends_at,'interviewer_ids',jsonb_build_array(a,d)));
 begin perform public.hf_interview_save(a,ca,base||jsonb_build_object('id',s1,'version',v+1,'starts_at',now()-interval '5 hours','ends_at',now()-interval '4 hours'));
  raise exception using errcode='HF999',message='moved into past';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm like '%future%', sqlerrm; end;

 -- Disabled members lose reads and authority immediately.
 update public.hf_members set enabled=false where company_id=ca and user_id=d;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',d,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 select count(*) into n from public.hf_interviews; assert n=0, 'disabled read';
 execute 'reset role';
 begin perform public.hf_meet_claim(ca,d); raise exception using errcode='HF999',message='disabled claimed';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Company access denied', sqlerrm; end;
 update public.hf_google_connections set connected_by=d where company_id=ca;
 assert public.hf_meet_claim(ca)->>'state'='reauthorize', 'reauthorize';
 assert (select last_error from public.hf_meet_connections where company_id=ca) like '%reconnect%', 'reauthorize message';
 update public.hf_google_connections set connected_by=a where company_id=ca;

 -- Disconnect invalidates the running worker; history stays.
 lease:=public.hf_meet_claim(ca);
 perform public.hf_meet_commit(ca,(lease->>'generation')::uuid,(lease->>'lease_id')::uuid,null,0,'{"release":null}');
 perform public.hf_google_set(a,ca,'',null,null);
 begin perform public.hf_meet_commit(ca,(lease->>'generation')::uuid,(lease->>'lease_id')::uuid,s1,3,'{"sync":{"status":"scheduled"}}');
  raise exception using errcode='HF999',message='commit after disconnect';
 exception when sqlstate 'HF999' then raise; when others then assert sqlerrm='Google connection changed', sqlerrm; end;
 assert public.hf_meet_claim(ca)->>'state'='disconnected', 'disconnected';
 select count(*) into n from public.hf_interview_recordings where company_id=ca; assert n=1, 'history kept';
 assert public.hf_gmail_claim(ca) is null, 'gmail claimed after disconnect';

 -- Deleting the candidate removes the interview and queues its saved video for deletion.
 delete from public.hf_candidates where company_id=ca and id=ka;
 assert exists(select 1 from public.hf_storage_deletions where key=ca||'/'||s1||'/r1.mp4'), 'saved video not queued for deletion';
 raise notice 'PASS: Google connection isolation, membership, leases, stale results, recordings, recording copy claims, cancellation, account switching, Gmail checkpoints, past edits, disabled members, organizer notification retries, disconnect and storage cleanup.';
end $$;
rollback;

-- Remove the retired recording provider's workers, retaining saved videos and access policies.
drop trigger hf_recorder_cleanup on public.hf_interview_recordings;
drop function hf_private.queue_recorder_cancellation();
drop table public.hf_recorder_cancellations;
drop function public.hf_recording_status(uuid,text,text,timestamptz,text);
drop function public.hf_recording_claim(integer);
drop index public.hf_interview_recordings_active;
drop index public.hf_interview_recordings_unstored;
alter table public.hf_interviews alter column auto_record set default false;
update public.hf_interviews set auto_record=false,recorder_error=null;
update public.hf_interview_recordings
 set state='cancelled',error='Automatic recording integration removed.',storage_claim_until=null
 where storage_key is null and state in ('scheduled','joining','waiting','recording','processing');

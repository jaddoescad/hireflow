-- Quo reports voicemail pickups as answered calls. Count a call as answered only when the line stayed
-- connected for at least 30 seconds (answer time to end time), which excludes greetings and instant hang-ups.
create or replace function public.hf_activity_metrics(cid uuid,from_day date,to_day date,tz text)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if not hf_private.has_access(cid) then raise exception 'Company access denied'; end if;
 if not exists(select 1 from pg_timezone_names where name=tz) then raise exception 'Invalid timezone'; end if;
 with a as (
  select (occurred_at at time zone tz)::date as day, candidate_id,
   kind='call' as call,
   kind='call' and nullif(metadata->>'answered_at','') is not null
    and occurred_at-(metadata->>'answered_at')::timestamptz>=interval '30 seconds' as answered,
   kind='call' and not metadata ? 'answered_at' as unknown,
   kind in ('sms','email') as message
  from public.hf_activities
  where company_id=cid and direction='outgoing' and kind in ('call','sms','email') and candidate_id is not null
   and (from_day is null or occurred_at>=(from_day::timestamp at time zone tz))
   and (to_day is null or occurred_at<((to_day+1)::timestamp at time zone tz)))
 select jsonb_build_object(
  'calls',count(*) filter(where call),
  'answered_calls',count(*) filter(where answered),
  'unknown_calls',count(*) filter(where unknown),
  'called',count(distinct candidate_id) filter(where call),
  'answered',count(distinct candidate_id) filter(where answered),
  'messages',count(*) filter(where message),
  'messaged',count(distinct candidate_id) filter(where message),
  'days',(select coalesce(jsonb_agg(d order by d.day desc),'[]'::jsonb) from (
   select day,count(distinct candidate_id) filter(where call) as called,count(distinct candidate_id) filter(where answered) as answered,
    count(distinct candidate_id) filter(where message) as messaged,count(*) filter(where call) as calls
   from a group by day) d),
  'contacted',(select coalesce(jsonb_agg(distinct x.candidate_id),'[]'::jsonb) from public.hf_activities x
   where x.company_id=cid and x.direction='outgoing' and x.kind in ('call','sms','email') and x.candidate_id is not null))
 into result from a;
 return result;
end $$;

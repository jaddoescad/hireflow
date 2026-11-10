-- Avoid a collision with hf_ingest's payload argument in PL/pgSQL queries.
alter table public.hf_candidate_submissions rename column payload to application_data;
do $$
declare definition text;
begin
 select pg_get_functiondef('public.hf_ingest(uuid,text,jsonb)'::regprocedure) into definition;
 execute replace(definition,'source,source_id,payload,submitted_at','source,source_id,application_data,submitted_at');
end $$;

-- New stages append under the company lock; edits preserve stage order.
create or replace function public.hf_mutate(actor uuid, cid uuid, action text, payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare m public.hf_members; c public.hf_candidates; inv public.hf_invitations; item uuid; result jsonb; verified_email text; neighbor public.hf_stages; current_stage public.hf_stages;
begin
 select lower(email) into verified_email from auth.users where id=actor and email_confirmed_at is not null;
 if verified_email is null then raise exception 'Verified account required'; end if;
 if action='create_company' then
  insert into public.hf_companies(name,created_by) values(trim(payload->>'name'),actor) returning id into cid;
  insert into public.hf_members(company_id,user_id,email,role) values(cid,actor,verified_email,'admin');
  insert into public.hf_stages(company_id,name,position,color) values
   (cid,'Applied',0,'slate'),(cid,'Initial interview',1,'blue'),(cid,'Manager interview',2,'violet'),
   (cid,'Field trial',3,'amber'),(cid,'Hired',4,'green'),(cid,'Rejected',5,'red'),(cid,'Contact later',6,'slate');
  insert into public.hf_integrations(company_id) values(cid);
  return jsonb_build_object('id',cid);
 end if;
 if action='accept_invitation' then
  select * into inv from public.hf_invitations where token_hash=payload->>'token_hash';
  if inv.id is null then raise exception 'Invitation not found'; end if;
  cid:=inv.company_id;
 end if;
 perform 1 from public.hf_companies where id=cid for update;
 if not found then raise exception 'Company not found'; end if;
 if action='accept_invitation' then
  select * into inv from public.hf_invitations where id=inv.id for update;
  if inv.email<>verified_email or inv.expires_at<=now() or inv.revoked_at is not null then raise exception 'Invitation is expired or belongs to a different email'; end if;
  if inv.accepted_at is not null then return jsonb_build_object('id',cid); end if;
  if exists(select 1 from public.hf_members where company_id=cid and user_id=actor and not enabled) then raise exception 'Your membership is disabled. Contact an admin.'; end if;
  insert into public.hf_members(company_id,user_id,email,role) values(cid,actor,verified_email,inv.role) on conflict(company_id,user_id) do nothing;
  update public.hf_invitations set accepted_at=now() where id=inv.id;
  return jsonb_build_object('id',cid);
 end if;
 select * into m from public.hf_members where company_id=cid and user_id=actor and enabled;
 if m.user_id is null then raise exception 'Company access denied'; end if;
 if action in ('invite','revoke_invitation','member','stage_save','stage_delete','stage_reorder','integration','rename_company') and m.role<>'admin' then raise exception 'Admin access required'; end if;
 case action
 when 'invite' then
  if exists(select 1 from public.hf_members where company_id=cid and email=payload->>'email') then raise exception 'This person is already a member. Manage their access in Team.'; end if;
  update public.hf_invitations set revoked_at=now() where company_id=cid and email=payload->>'email' and accepted_at is null and revoked_at is null;
  insert into public.hf_invitations(company_id,email,role,invited_by,token_hash) values(cid,payload->>'email',payload->>'role',actor,payload->>'token_hash') returning id into item;
 when 'revoke_invitation' then
  update public.hf_invitations set revoked_at=now() where company_id=cid and id=(payload->>'id')::uuid and accepted_at is null;
 when 'member' then
  item:=(payload->>'user_id')::uuid;
  if not exists(select 1 from public.hf_members where company_id=cid and user_id=item) then raise exception 'Member not found'; end if;
  if (payload->>'role'<>'admin' or not (payload->>'enabled')::boolean)
   and exists(select 1 from public.hf_members where company_id=cid and user_id=item and role='admin' and enabled)
   and (select count(*) from public.hf_members where company_id=cid and role='admin' and enabled)<2 then raise exception 'Keep at least one enabled admin'; end if;
  update public.hf_members set role=payload->>'role',enabled=(payload->>'enabled')::boolean where company_id=cid and user_id=item;
 when 'candidate_save' then
  item:=coalesce((payload->>'id')::uuid,gen_random_uuid());
  if payload->>'id' is not null and not exists(select 1 from public.hf_candidates where id=item and company_id=cid) then raise exception 'Candidate not found'; end if;
  select * into c from public.hf_candidates where id=item and company_id=cid;
  insert into public.hf_candidates(id,company_id,stage_id,name,email,phone,job_title,experience,tags)
   values(item,cid,(payload->>'stage_id')::uuid,payload->>'name',nullif(payload->>'email',''),nullif(payload->>'phone',''),payload->>'job_title',payload->>'experience',array(select jsonb_array_elements_text(payload->'tags')))
  on conflict(id) do update set stage_id=excluded.stage_id,name=excluded.name,email=excluded.email,phone=excluded.phone,job_title=excluded.job_title,experience=excluded.experience,tags=excluded.tags,updated_at=now();
  if c.id is not null and c.stage_id<>(payload->>'stage_id')::uuid then
   insert into public.hf_activities(company_id,candidate_id,kind,body,actor_id) select cid,item,'stage','Moved to '||name,actor from public.hf_stages where id=(payload->>'stage_id')::uuid and company_id=cid;
  end if;
 when 'move' then
  item:=(payload->>'id')::uuid;
  update public.hf_candidates set stage_id=(payload->>'stage_id')::uuid,updated_at=now() where id=item and company_id=cid and stage_id<>(payload->>'stage_id')::uuid;
  if found then insert into public.hf_activities(company_id,candidate_id,kind,body,actor_id) select cid,item,'stage','Moved to '||name,actor from public.hf_stages where id=(payload->>'stage_id')::uuid and company_id=cid; end if;
 when 'note' then
  insert into public.hf_activities(company_id,candidate_id,kind,body,actor_id) values(cid,(payload->>'candidate_id')::uuid,'note',payload->>'body',actor) returning id into item;
 when 'signal_link' then
  update public.hf_activities set candidate_id=(payload->>'candidate_id')::uuid where id=(payload->>'id')::uuid and company_id=cid and kind in ('sms','call');
 when 'signal_read' then
  update public.hf_activities set read_at=now() where id=(payload->>'id')::uuid and company_id=cid;
 when 'stage_save' then
  item:=coalesce((payload->>'id')::uuid,gen_random_uuid());
  if payload->>'id' is not null and not exists(select 1 from public.hf_stages where id=item and company_id=cid) then raise exception 'Stage not found'; end if;
  insert into public.hf_stages(id,company_id,name,position,color) values(item,cid,payload->>'name',coalesce((select max(position)+1 from public.hf_stages where company_id=cid),0),payload->>'color')
  on conflict(id) do update set name=excluded.name,color=excluded.color;
 when 'stage_reorder' then
  select * into current_stage from public.hf_stages where id=(payload->>'id')::uuid and company_id=cid;
  if current_stage.id is null then raise exception 'Stage not found'; end if;
  if payload->>'direction'='up' then
   select * into neighbor from public.hf_stages where company_id=cid and position<current_stage.position order by position desc limit 1;
  else
   select * into neighbor from public.hf_stages where company_id=cid and position>current_stage.position order by position limit 1;
  end if;
  if neighbor.id is not null then
   update public.hf_stages set position=case when id=current_stage.id then neighbor.position else current_stage.position end where id in (current_stage.id,neighbor.id) and company_id=cid;
  end if;
 when 'stage_delete' then
  if (select count(*) from public.hf_stages where company_id=cid)<2 then raise exception 'Keep at least one stage'; end if;
  delete from public.hf_stages where id=(payload->>'id')::uuid and company_id=cid;
 when 'rename_company' then update public.hf_companies set name=trim(payload->>'name') where id=cid;
 when 'integration' then
  update public.hf_integrations set
   intake_key_hash=coalesce(payload->>'intake_key_hash',intake_key_hash),
   quo_api_key=coalesce(payload->>'quo_api_key',quo_api_key),
   quo_phone_id=coalesce(payload->>'quo_phone_id',quo_phone_id),
   quo_phone=coalesce(payload->>'quo_phone',quo_phone),
   quo_signing_secret=coalesce(payload->>'quo_signing_secret',quo_signing_secret),updated_at=now() where company_id=cid;
 else raise exception 'Unknown action';
 end case;
 return jsonb_build_object('id',item);
end $$;

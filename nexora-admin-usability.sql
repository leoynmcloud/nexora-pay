-- Nexora Pay: melhorias do backoffice (SQL Editor do Supabase).
-- Execute depois do SQL de onboarding/acquirentes. Reexecutável e sem apagar dados.
begin;

create or replace function public.nexora_audit_provider_configuration()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_configured boolean := new.api_key_ciphertext is not null;
begin
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
  values(coalesce(auth.uid(),new.owner_id),case when v_configured then 'merchant.provider_configured' else 'merchant.provider_selected' end,new.business_id::text,
    jsonb_build_object('acquirer_id',new.acquirer_id,'status',new.status,
      'api_key_replaced',case when tg_op='INSERT' then v_configured else new.api_key_ciphertext is distinct from old.api_key_ciphertext end,
      'webhook_secret_configured',new.webhook_secret_ciphertext is not null));
  return new;
end;
$$;

-- A atribuição do adquirente é separada do armazenamento seguro das credenciais.
alter table public.nexora_merchant_provider_connections
  alter column api_key_ciphertext drop not null;

create or replace function public.nexora_get_merchant_setup()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_business uuid := public.nexora_assert_workspace(); v_result jsonb;
begin
  select jsonb_build_object(
    'providers',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,
      'api_base_url',a.api_base_url,'webhook_url',a.webhook_url,'environment',a.environment,
      'payment_methods',a.payment_methods,'status',a.status,'notes',a.notes)
      order by a.name) from public.nexora_acquirers a where a.status='enabled'),'[]'::jsonb),
    'connection',(select jsonb_build_object('acquirer_id',c.acquirer_id,'acquirer_name',a.name,
      'status',c.status,'webhook_url',c.webhook_url,'api_key_configured',c.api_key_ciphertext is not null,
      'webhook_secret_configured',c.webhook_secret_ciphertext is not null,'updated_at',c.updated_at)
      from public.nexora_merchant_provider_connections c join public.nexora_acquirers a on a.id=c.acquirer_id
      where c.business_id=v_business and c.owner_id=auth.uid() order by c.updated_at desc limit 1),
    'controls',(select jsonb_build_object('payments_enabled',m.payments_enabled,'withdrawals_enabled',m.withdrawals_enabled,
      'withdrawal_mode',m.withdrawal_mode,'max_transfer_amount',m.max_transfer_amount,
      'daily_transfer_limit',m.daily_transfer_limit,'alert_threshold_amount',m.alert_threshold_amount,
      'reserve_percentage',m.reserve_percentage)
      from public.nexora_merchant_controls m where m.business_id=v_business and m.owner_id=auth.uid())
  ) into v_result;
  if v_result->'controls' is null then
    insert into public.nexora_merchant_controls(business_id,owner_id) values(v_business,auth.uid()) on conflict(business_id) do nothing;
    v_result := v_result || jsonb_build_object('controls',jsonb_build_object('payments_enabled',true,
      'withdrawals_enabled',true,'withdrawal_mode','manual','max_transfer_amount',5000,
      'daily_transfer_limit',20000,'alert_threshold_amount',5000,'reserve_percentage',0));
  end if;
  return v_result;
end;
$$;

create or replace function public.nexora_admin_provider_connections()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('owner_id',c.owner_id,'business_id',c.business_id,
    'business_name',b.name,'email',u.email,'acquirer_id',c.acquirer_id,'acquirer_name',a.name,
    'status',c.status,'webhook_url',c.webhook_url,'api_key_configured',c.api_key_ciphertext is not null,
    'webhook_secret_configured',c.webhook_secret_ciphertext is not null,'updated_at',c.updated_at)
    order by c.updated_at desc) from public.nexora_merchant_provider_connections c
    join public.businesses b on b.id=c.business_id and b.owner_id=c.owner_id
    join auth.users u on u.id=c.owner_id join public.nexora_acquirers a on a.id=c.acquirer_id),'[]'::jsonb);
end;
$$;

create or replace function public.nexora_admin_assign_acquirer(p_owner_id uuid,p_acquirer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid; v_old uuid; v_name text;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  if not exists(select 1 from auth.users where id=p_owner_id) then raise exception 'Conta não encontrada.'; end if;
  select id into v_business from public.businesses where owner_id=p_owner_id order by id limit 1;
  if v_business is null then raise exception 'Esta conta ainda não possui workspace.'; end if;
  select acquirer_id into v_old from public.nexora_merchant_provider_connections where business_id=v_business for update;
  if p_acquirer_id is null then
    delete from public.nexora_merchant_provider_connections where business_id=v_business;
    insert into public.nexora_audit_log(actor_id,action,target_id,details)
      values(auth.uid(),'merchant.acquirer_unassigned',p_owner_id::text,jsonb_build_object('previous_acquirer_id',v_old));
    return;
  end if;
  select name into v_name from public.nexora_acquirers where id=p_acquirer_id and status='enabled';
  if v_name is null then raise exception 'Adquirente indisponível. Escolha um provedor liberado.'; end if;
  if v_old is distinct from p_acquirer_id then
    insert into public.nexora_merchant_provider_connections(business_id,owner_id,acquirer_id,api_key_ciphertext,
      webhook_secret_ciphertext,webhook_url,status,last_error,configured_at,updated_at)
    values(v_business,p_owner_id,p_acquirer_id,null,null,null,'pending',null,now(),now())
    on conflict(business_id) do update set owner_id=excluded.owner_id,acquirer_id=excluded.acquirer_id,
      api_key_ciphertext=null,webhook_secret_ciphertext=null,webhook_url=null,status='pending',
      last_error=null,configured_at=now(),updated_at=now();
  end if;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.acquirer_assigned',p_owner_id::text,jsonb_build_object(
      'previous_acquirer_id',v_old,'acquirer_id',p_acquirer_id,'acquirer_name',v_name,
      'credentials_configured',case when v_old=p_acquirer_id then exists(select 1 from public.nexora_merchant_provider_connections where business_id=v_business and api_key_ciphertext is not null) else false end));
end;
$$;

create or replace function public.nexora_admin_review_merchant(p_user_id uuid,p_decision text,p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status text; v_reason text := nullif(left(trim(coalesce(p_reason,'')),1000),'');
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao super admin.'; end if;
  if p_decision not in ('APPROVED','PENDING_DOCUMENTS','REJECTED') then raise exception 'Decisão inválida.'; end if;
  select status into v_status from public.merchant_onboarding where user_id=p_user_id for update;
  if not found or v_status not in ('SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW','PENDING_DOCUMENTS','REJECTED') then
    raise exception 'Este cadastro não está disponível para análise.';
  end if;
  if p_decision='APPROVED' and exists (
    select 1 from unnest(array['representative_id_front','representative_id_back','additional_document']) as required(required_type)
    where not exists(select 1 from public.merchant_kyc_documents d where d.user_id=p_user_id and d.document_type=required.required_type)
  ) then raise exception 'Não é possível aprovar: faltam documentos obrigatórios.'; end if;
  update public.merchant_onboarding
  set status=p_decision,
      reason_code=case p_decision when 'APPROVED' then null when 'REJECTED' then 'REJECTED_BY_REVIEW' else 'ADDITIONAL_INFORMATION_REQUIRED' end,
      reason_description=case when p_decision='APPROVED' then null else v_reason end,
      reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
  where user_id=p_user_id;
  insert into public.merchant_kyc_reviews(user_id,reviewer_id,from_status,to_status,reason)
    values(p_user_id,auth.uid(),v_status,p_decision,coalesce(v_reason,''));
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.kyc_review',p_user_id::text,jsonb_build_object('from',v_status,'to',p_decision,'has_observation',v_reason is not null));
end;
$$;

revoke all on function public.nexora_admin_assign_acquirer(uuid,uuid) from public,anon;
grant execute on function public.nexora_admin_assign_acquirer(uuid,uuid) to authenticated;
revoke all on function public.nexora_admin_provider_connections() from public,anon;
grant execute on function public.nexora_admin_provider_connections() to authenticated;
revoke all on function public.nexora_admin_review_merchant(uuid,text,text) from public,anon;
grant execute on function public.nexora_admin_review_merchant(uuid,text,text) to authenticated;
notify pgrst,'reload schema';
commit;

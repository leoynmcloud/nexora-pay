-- Add independent merchant controls for Pix OUT and an outgoing-movement freeze.
-- The freeze blocks new payout reservation/dispatch; it does not reclassify
-- existing ledger funds into the blocked bucket.
begin;

do $$ begin
  if to_regclass('public.nexora_merchant_controls') is null
     or to_regclass('public.businesses') is null
     or to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.nexora_audit_log') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null
     or to_regprocedure('public.nexora_admin_assign_acquirer(uuid,uuid)') is null
     or not exists(select 1 from pg_attribute where attrelid='public.nexora_merchant_controls'::regclass
       and attname='api_enabled' and not attisdropped)
     or not exists(select 1 from pg_attribute where attrelid='public.nexora_merchant_controls'::regclass
       and attname='reserve_days' and not attisdropped) then
    raise exception 'Apply merchant API keys, reserve/holdback, and admin usability migrations first.';
  end if;
end $$;

alter table public.nexora_merchant_controls
  add column if not exists pix_out_enabled boolean not null default false,
  add column if not exists balance_movements_blocked boolean not null default false;

create or replace function public.nexora_admin_merchant_controls()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'aal','') <> 'aal2' or not public.is_nexora_super_admin() then
    raise exception 'Acesso administrativo com MFA obrigatório.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'owner_id',b.owner_id,'business_id',b.id,'business_name',b.name,'email',u.email,
    'payments_enabled',coalesce(m.payments_enabled,true),'withdrawals_enabled',coalesce(m.withdrawals_enabled,true),
    'pix_out_enabled',coalesce(m.pix_out_enabled,false),
    'balance_movements_blocked',coalesce(m.balance_movements_blocked,false),
    'api_enabled',coalesce(m.api_enabled,false),'withdrawal_mode',coalesce(m.withdrawal_mode,'manual'),
    'max_transfer_amount',coalesce(m.max_transfer_amount,5000),'daily_transfer_limit',coalesce(m.daily_transfer_limit,20000),
    'alert_threshold_amount',coalesce(m.alert_threshold_amount,5000),'reserve_percentage',coalesce(m.reserve_percentage,0),
    'reserve_days',coalesce(m.reserve_days,0),'updated_at',m.updated_at) order by b.name)
    from public.businesses b join public.merchant_onboarding k on k.user_id=b.owner_id and k.status='APPROVED'
    join auth.users u on u.id=b.owner_id
    left join public.nexora_merchant_controls m on m.business_id=b.id and m.owner_id=b.owner_id),'[]'::jsonb);
end;
$$;
revoke all on function public.nexora_admin_merchant_controls() from public,anon,service_role;
grant execute on function public.nexora_admin_merchant_controls() to authenticated;

create or replace function public.nexora_admin_set_merchant_controls_v3(
  p_owner_id uuid,p_payments_enabled boolean,p_withdrawals_enabled boolean,p_api_enabled boolean,
  p_pix_out_enabled boolean,p_balance_movements_blocked boolean,
  p_withdrawal_mode text,p_max_transfer_amount numeric,p_daily_transfer_limit numeric,
  p_alert_threshold_amount numeric,p_reserve_percentage numeric,p_reserve_days smallint
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_business uuid;
  v_old jsonb;
  v_new jsonb;
begin
  if coalesce(auth.jwt()->>'aal','') <> 'aal2' or not public.is_nexora_super_admin() then
    raise exception 'Acesso administrativo com MFA obrigatório.';
  end if;
  if p_owner_id is null or p_payments_enabled is null or p_withdrawals_enabled is null or p_api_enabled is null
    or p_pix_out_enabled is null or p_balance_movements_blocked is null
    or p_withdrawal_mode not in ('manual','instant') or p_max_transfer_amount is null or p_max_transfer_amount<=0
    or p_daily_transfer_limit is null or p_daily_transfer_limit<=0 or p_alert_threshold_amount is null
    or p_alert_threshold_amount<=0 or p_reserve_percentage is null or p_reserve_percentage not between 0 and 100
    or p_reserve_percentage<>round(p_reserve_percentage,2)
    or p_reserve_days is null or p_reserve_days not between 0 and 365
    or (p_reserve_percentage=0 and p_reserve_days<>0)
    or (p_reserve_percentage>0 and p_reserve_days not between 1 and 365) then
    raise exception 'Controles, tarifa ou prazo de reserva inválidos.';
  end if;
  select id into v_business from public.businesses where owner_id=p_owner_id order by id limit 1 for update;
  if v_business is null then raise exception 'Workspace do merchant não encontrado.'; end if;
  select to_jsonb(m) into v_old from public.nexora_merchant_controls m
    where m.business_id=v_business and m.owner_id=p_owner_id;
  insert into public.nexora_merchant_controls(
    business_id,owner_id,payments_enabled,withdrawals_enabled,api_enabled,pix_out_enabled,balance_movements_blocked,
    withdrawal_mode,max_transfer_amount,daily_transfer_limit,alert_threshold_amount,reserve_percentage,reserve_days,updated_by
  ) values (
    v_business,p_owner_id,p_payments_enabled,p_withdrawals_enabled,p_api_enabled,p_pix_out_enabled,p_balance_movements_blocked,
    p_withdrawal_mode,p_max_transfer_amount,p_daily_transfer_limit,p_alert_threshold_amount,p_reserve_percentage,p_reserve_days,auth.uid()
  ) on conflict(business_id) do update set payments_enabled=excluded.payments_enabled,
    withdrawals_enabled=excluded.withdrawals_enabled,api_enabled=excluded.api_enabled,
    pix_out_enabled=excluded.pix_out_enabled,balance_movements_blocked=excluded.balance_movements_blocked,
    withdrawal_mode=excluded.withdrawal_mode,max_transfer_amount=excluded.max_transfer_amount,
    daily_transfer_limit=excluded.daily_transfer_limit,alert_threshold_amount=excluded.alert_threshold_amount,
    reserve_percentage=excluded.reserve_percentage,reserve_days=excluded.reserve_days,
    updated_by=auth.uid(),updated_at=now();
  select to_jsonb(m) into v_new from public.nexora_merchant_controls m where m.business_id=v_business;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.controls_updated',p_owner_id::text,
      jsonb_build_object('before',v_old,'after',v_new,'business_id',v_business));
end;
$$;
revoke all on function public.nexora_admin_set_merchant_controls_v3(uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)
  from public,anon,service_role;
grant execute on function public.nexora_admin_set_merchant_controls_v3(uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)
  to authenticated;
do $$ begin
  if to_regprocedure('public.nexora_admin_set_merchant_controls_v2(uuid,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)') is not null then
    execute 'revoke all on function public.nexora_admin_set_merchant_controls_v2(uuid,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint) from public,anon,authenticated,service_role';
  end if;
end $$;

-- Save controls and the optional provider assignment in one database transaction.
-- A rejected acquirer assignment rolls back the control update and both audit rows.
create or replace function public.nexora_admin_configure_merchant(
  p_owner_id uuid,p_update_acquirer boolean,p_acquirer_id uuid,
  p_payments_enabled boolean,p_withdrawals_enabled boolean,p_api_enabled boolean,
  p_pix_out_enabled boolean,p_balance_movements_blocked boolean,
  p_withdrawal_mode text,p_max_transfer_amount numeric,p_daily_transfer_limit numeric,
  p_alert_threshold_amount numeric,p_reserve_percentage numeric,p_reserve_days smallint
)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_nexora_super_admin() then
    raise exception 'Acesso administrativo com MFA obrigatório.';
  end if;
  if p_update_acquirer is null or (not p_update_acquirer and p_acquirer_id is not null) then
    raise exception 'Invalid acquirer update request.';
  end if;
  perform public.nexora_admin_set_merchant_controls_v3(
    p_owner_id,p_payments_enabled,p_withdrawals_enabled,p_api_enabled,
    p_pix_out_enabled,p_balance_movements_blocked,p_withdrawal_mode,
    p_max_transfer_amount,p_daily_transfer_limit,p_alert_threshold_amount,
    p_reserve_percentage,p_reserve_days
  );
  if p_update_acquirer then
    perform public.nexora_admin_assign_acquirer(p_owner_id,p_acquirer_id);
  end if;
end;
$$;
revoke all on function public.nexora_admin_configure_merchant(uuid,boolean,uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)
  from public,anon,service_role;
grant execute on function public.nexora_admin_configure_merchant(uuid,boolean,uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)
  to authenticated;

select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('anon','public.nexora_merchant_controls','SELECT') as anon_can_select,
  has_table_privilege('authenticated','public.nexora_merchant_controls','SELECT') as authenticated_can_select,
  has_table_privilege('authenticated','public.nexora_merchant_controls','UPDATE') as authenticated_can_update,
  has_table_privilege('service_role','public.nexora_merchant_controls','UPDATE') as service_role_direct_update,
  has_function_privilege('anon','public.nexora_admin_merchant_controls()','EXECUTE') as anon_can_list,
  has_function_privilege('authenticated','public.nexora_admin_merchant_controls()','EXECUTE') as authenticated_can_list,
  has_function_privilege('service_role','public.nexora_admin_merchant_controls()','EXECUTE') as service_role_can_list,
  has_function_privilege('anon','public.nexora_admin_set_merchant_controls_v3(uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)','EXECUTE') as anon_can_save,
  has_function_privilege('authenticated','public.nexora_admin_set_merchant_controls_v3(uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)','EXECUTE') as authenticated_can_save,
  has_function_privilege('service_role','public.nexora_admin_set_merchant_controls_v3(uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)','EXECUTE') as service_role_can_save,
  has_function_privilege('anon','public.nexora_admin_configure_merchant(uuid,boolean,uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)','EXECUTE') as anon_can_configure,
  has_function_privilege('authenticated','public.nexora_admin_configure_merchant(uuid,boolean,uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)','EXECUTE') as authenticated_can_configure,
  has_function_privilege('service_role','public.nexora_admin_configure_merchant(uuid,boolean,uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)','EXECUTE') as service_role_can_configure
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='nexora_merchant_controls';
commit;

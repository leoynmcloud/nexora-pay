-- Bind every applied pricing snapshot to the transaction's assigned provider
-- and environment. This is incremental for databases that already ran
-- nexora-pricing-engine.sql; it does not recalculate or mutate prior sales.
begin;

do $$ begin
  if to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.nexora_merchant_provider_connections') is null
     or to_regclass('public.nexora_pricing_rules') is null
     or to_regclass('public.nexora_applied_pricing') is null
     or to_regprocedure('public.nexora_pricing_apply(uuid,uuid,uuid,uuid)') is null then
    raise exception 'Apply nexora-pricing-engine.sql before this hardening migration.';
  end if;
end $$;

create or replace function public.nexora_pricing_apply(
  p_transaction_id uuid,p_business_id uuid,p_owner_id uuid,p_acquirer_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_transaction public.nexora_transactions;
  v_existing public.nexora_applied_pricing;
  v_rule public.nexora_pricing_rules;
  v_gross bigint;
  v_fee bigint;
  v_net bigint;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Backend service role required.'; end if;
  select * into v_transaction from public.nexora_transactions
    where id=p_transaction_id and business_id=p_business_id and owner_id=p_owner_id for update;
  if not found or v_transaction.kind <> 'payment'
     or v_transaction.amount*100 <> round(v_transaction.amount*100) then
    raise exception 'Transação indisponível para pricing.';
  end if;
  if v_transaction.acquirer_id is distinct from p_acquirer_id
     or not exists(select 1 from public.nexora_acquirers a
       where a.id=p_acquirer_id and a.status='enabled'
         and a.environment=case when v_transaction.test_mode then 'sandbox' else 'production' end) then
    raise exception 'Adquirente ou ambiente não corresponde à transação.';
  end if;
  select * into v_existing from public.nexora_applied_pricing where transaction_id=p_transaction_id;
  if found then
    if v_existing.acquirer_id is distinct from p_acquirer_id
      or v_existing.business_id <> p_business_id or v_existing.owner_id <> p_owner_id
      or v_existing.payment_method <> v_transaction.payment_method
      or v_existing.gross_amount_cents <> (v_transaction.amount*100)::bigint then
      raise exception 'Pricing original pertence a outro contexto.';
    end if;
    return jsonb_build_object('rule_id',v_existing.rule_id,'gross_amount_cents',v_existing.gross_amount_cents,
      'merchant_fee_cents',v_existing.merchant_fee_cents,'merchant_net_cents',v_existing.merchant_net_cents);
  end if;
  if v_transaction.status not in ('pending','processing') then
    raise exception 'Transação concluída sem snapshot de pricing; requer revisão.';
  end if;
  if not exists(select 1 from public.nexora_merchant_provider_connections c
    where c.business_id=p_business_id and c.owner_id=p_owner_id
      and c.acquirer_id=p_acquirer_id and c.status='active') then
    raise exception 'Rota de adquirente inativa.';
  end if;
  select * into v_rule from public.nexora_pricing_rules r
    where r.business_id=p_business_id and r.owner_id=p_owner_id
      and r.acquirer_id=p_acquirer_id and r.payment_method=v_transaction.payment_method
      and r.effective_from <= v_transaction.created_at
    order by r.effective_from desc limit 1;
  if not found then raise exception 'Regra de tarifa não configurada para esta cobrança.'; end if;
  v_gross := (v_transaction.amount*100)::bigint;
  v_fee := v_rule.fixed_fee_cents
    + round(v_gross::numeric * v_rule.variable_fee_bps / 10000)::bigint;
  v_net := v_gross-v_fee;
  if v_fee < 0 or v_net <= 0 then raise exception 'Tarifa igual ou maior que o valor da cobrança.'; end if;
  insert into public.nexora_applied_pricing(transaction_id,business_id,owner_id,rule_id,acquirer_id,
    payment_method,gross_amount_cents,fixed_fee_cents,variable_fee_bps,merchant_fee_cents,merchant_net_cents)
  values(p_transaction_id,p_business_id,p_owner_id,v_rule.id,p_acquirer_id,
    v_transaction.payment_method,v_gross,v_rule.fixed_fee_cents,v_rule.variable_fee_bps,v_fee,v_net);
  return jsonb_build_object('rule_id',v_rule.id,'gross_amount_cents',v_gross,
    'merchant_fee_cents',v_fee,'merchant_net_cents',v_net);
end;
$$;
revoke all on function public.nexora_pricing_apply(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.nexora_pricing_apply(uuid,uuid,uuid,uuid) to service_role;

notify pgrst,'reload schema';
commit;

select has_function_privilege('anon','public.nexora_pricing_apply(uuid,uuid,uuid,uuid)','EXECUTE') as anon_can_apply,
  has_function_privilege('authenticated','public.nexora_pricing_apply(uuid,uuid,uuid,uuid)','EXECUTE') as authenticated_can_apply,
  has_function_privilege('service_role','public.nexora_pricing_apply(uuid,uuid,uuid,uuid)','EXECUTE') as service_role_can_apply;

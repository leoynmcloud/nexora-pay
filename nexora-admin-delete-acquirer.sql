-- Migration para permitir que o Super Admin remova adquirentes sem histórico financeiro
begin;

create or replace function public.nexora_admin_delete_acquirer(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_acquirer public.nexora_acquirers;
  v_tx_count integer := 0;
  v_link_count integer := 0;
  v_payout_count integer := 0;
  v_attempt_count integer := 0;
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Super Admin da Nexora Pay.';
  end if;
  if p_id is null then
    raise exception 'ID do adquirente não fornecido.';
  end if;

  select * into v_acquirer from public.nexora_acquirers where id = p_id for update;
  if not found then
    raise exception 'Adquirente não encontrado.';
  end if;

  -- Verifica se há transações, links, saques ou tentativas
  if to_regclass('public.nexora_transactions') is not null then
    select count(*) into v_tx_count from public.nexora_transactions where acquirer_id = p_id;
  end if;
  if to_regclass('public.nexora_checkout_links') is not null then
    select count(*) into v_link_count from public.nexora_checkout_links where acquirer_id = p_id;
  end if;
  if to_regclass('public.nexora_payouts') is not null then
    select count(*) into v_payout_count from public.nexora_payouts where acquirer_id = p_id;
  end if;
  if to_regclass('public.nexora_payment_attempts') is not null then
    select count(*) into v_attempt_count from public.nexora_payment_attempts where acquirer_id = p_id;
  end if;

  if (v_tx_count > 0 or v_link_count > 0 or v_payout_count > 0 or v_attempt_count > 0) then
    raise exception 'Este adquirente possui histórico financeiro vinculado e não pode ser excluído para preservar o histórico do ledger. Altere seu status para Pausado para impedir novas operações.';
  end if;

  -- Se não possui histórico financeiro, limpa conexões de rota, regras de tarifa e credenciais vinculadas
  if to_regclass('public.nexora_merchant_provider_connections') is not null then
    delete from public.nexora_merchant_provider_connections where acquirer_id = p_id;
  end if;
  if to_regclass('public.nexora_pricing_rules') is not null then
    delete from public.nexora_pricing_rules where acquirer_id = p_id;
  end if;
  if to_regclass('public.nexora_platform_provider_credentials') is not null then
    delete from public.nexora_platform_provider_credentials where acquirer_id = p_id;
  end if;

  delete from public.nexora_acquirers where id = p_id;

  insert into public.nexora_audit_log(actor_id, action, target_id, details)
    values(auth.uid(), 'acquirer.deleted', p_id::text, jsonb_build_object(
      'code', v_acquirer.code, 'name', v_acquirer.name, 'environment', v_acquirer.environment
    ));

  return jsonb_build_object('ok', true, 'deleted_id', p_id, 'name', v_acquirer.name);
end;
$$;

revoke all on function public.nexora_admin_delete_acquirer(uuid) from public, anon;
grant execute on function public.nexora_admin_delete_acquirer(uuid) to authenticated;

commit;

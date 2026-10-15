-- Migration final para exclusão segura de contas pelo Super Admin
begin;

-- Remove constraints em tabelas imutáveis de histórico que impediam a exclusão
alter table if exists public.nexora_pricing_rules
  drop constraint if exists nexora_pricing_rules_created_by_fkey,
  drop constraint if exists nexora_pricing_rules_business_id_owner_id_fkey;

alter table if exists public.nexora_payout_admin_events
  drop constraint if exists nexora_payout_admin_events_actor_id_fkey;

alter table if exists public.nexora_platform_provider_credentials
  drop constraint if exists nexora_platform_provider_credentials_created_by_fkey;

alter table if exists public.nexora_audit_log
  drop constraint if exists nexora_audit_log_actor_id_fkey;

-- Função definitiva para expurgar dados do workspace antes de remover de auth.users
create or replace function public.nexora_admin_purge_account(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tx_count integer := 0;
  v_journal_count integer := 0;
  v_payout_count integer := 0;
  v_business_id uuid;
begin
  if current_user not in ('postgres','supabase_admin')
     and coalesce(auth.jwt()->>'role','') <> 'service_role'
     and not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Super Admin.';
  end if;
  if p_user_id is null then raise exception 'ID de usuário inválido.'; end if;

  -- Impede remover Super Admin
  if exists(select 1 from auth.users u join public.nexora_admins a on lower(trim(a.email))=lower(trim(u.email)) where u.id = p_user_id) then
    raise exception 'Contas administrativas não podem ser removidas.';
  end if;

  -- Verifica se possui transações ou entradas de ledger reais
  if to_regclass('public.nexora_transactions') is not null then
    select count(*) into v_tx_count from public.nexora_transactions where owner_id = p_user_id and test_mode = false;
  end if;
  if to_regclass('public.nexora_ledger_journals') is not null then
    select count(*) into v_journal_count from public.nexora_ledger_journals where owner_id = p_user_id;
  end if;
  if to_regclass('public.nexora_payouts') is not null then
    select count(*) into v_payout_count from public.nexora_payouts where owner_id = p_user_id;
  end if;

  if (v_tx_count > 0 or v_journal_count > 0 or v_payout_count > 0) then
    raise exception 'Esta conta possui movimentação financeira real no ledger (% transações, % lançamentos contábeis) e não pode ser excluída para preservar o histórico contábil. Use a opção Suspender Conta.', v_tx_count, v_journal_count;
  end if;

  -- Obtém business_id
  select id into v_business_id from public.businesses where owner_id = p_user_id limit 1;

  -- Limpa tabelas filhas que impedem a exclusão de businesses / auth.users
  if v_business_id is not null then
    delete from public.nexora_checkout_links where business_id = v_business_id;
    delete from public.nexora_merchant_api_keys where business_id = v_business_id;
    delete from public.nexora_merchant_webhook_events where business_id = v_business_id;
    delete from public.nexora_merchant_webhook_endpoints where business_id = v_business_id;
    delete from public.nexora_merchant_provider_connections where business_id = v_business_id;
    delete from public.nexora_merchant_controls where business_id = v_business_id;
    delete from public.nexora_admin_notifications where business_id = v_business_id;
    delete from public.nexora_sandbox_transactions where business_id = v_business_id;
    delete from public.nexora_sandbox_ledger_journals where business_id = v_business_id;
    delete from public.nexora_ledger_accounts where business_id = v_business_id;
    delete from public.nexora_customers where business_id = v_business_id;
    delete from public.nexora_withdrawals where business_id = v_business_id;
    delete from public.businesses where id = v_business_id;
  end if;

  -- Limpa tabelas vinculadas ao owner_id
  delete from public.merchant_kyc_documents where user_id = p_user_id;
  delete from public.merchant_kyc_reviews where user_id = p_user_id;
  delete from public.merchant_onboarding where user_id = p_user_id;
  delete from public.user_settings where user_id = p_user_id;
  delete from public.workspace_members where user_id = p_user_id;
  delete from public.profiles where id = p_user_id;

  insert into public.nexora_audit_log(actor_id, action, target_id, details)
    values(coalesce(auth.uid(), p_user_id), 'account.purged', p_user_id::text, jsonb_build_object('user_id', p_user_id));

  return jsonb_build_object('ok', true, 'purged_user_id', p_user_id);
end;
$$;

revoke all on function public.nexora_admin_purge_account(uuid) from public, anon;
grant execute on function public.nexora_admin_purge_account(uuid) to authenticated, service_role;

commit;

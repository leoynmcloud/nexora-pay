-- Read-only check. This does not change schema or data.
-- Run before nexora-hosted-checkout.sql to identify its direct prerequisites
-- and the additional objects required for live checkout after the provider-core
-- migration is installed.
with expected(stage,object_name,object_kind,exists_now) as (
  values
    ('checkout base','public.nexora_transactions','table',to_regclass('public.nexora_transactions') is not null),
    ('checkout base','public.nexora_acquirers','table',to_regclass('public.nexora_acquirers') is not null),
    ('checkout base','public.nexora_merchant_provider_connections','table',to_regclass('public.nexora_merchant_provider_connections') is not null),
    ('checkout base','public.nexora_platform_provider_credentials','table',to_regclass('public.nexora_platform_provider_credentials') is not null),
    ('checkout base','public.nexora_pricing_rules','table',to_regclass('public.nexora_pricing_rules') is not null),
    ('checkout base','public.nexora_businesses_id_owner_id_unique','index',to_regclass('public.nexora_businesses_id_owner_id_unique') is not null),
    ('checkout base','public.nexora_transactions_id_business_owner_unique','index',to_regclass('public.nexora_transactions_id_business_owner_unique') is not null),
    ('checkout runtime','public.businesses','table',to_regclass('public.businesses') is not null),
    ('checkout runtime','public.merchant_onboarding','table',to_regclass('public.merchant_onboarding') is not null),
    ('checkout runtime','public.nexora_merchant_controls','table',to_regclass('public.nexora_merchant_controls') is not null),
    ('checkout runtime','public.nexora_audit_log','table',to_regclass('public.nexora_audit_log') is not null),
    ('checkout runtime','public.nexora_account_active(uuid)','function',to_regprocedure('public.nexora_account_active(uuid)') is not null),
    ('live payment core prerequisites','public.nexora_provider_payment_operations','table',to_regclass('public.nexora_provider_payment_operations') is not null),
    ('live payment core prerequisites','public.nexora_applied_pricing','table',to_regclass('public.nexora_applied_pricing') is not null),
    ('live payment core prerequisites','public.nexora_provider_payment_status_events','table',to_regclass('public.nexora_provider_payment_status_events') is not null),
    ('live payment core prerequisites','public.nexora_provider_webhook_inbox','table',to_regclass('public.nexora_provider_webhook_inbox') is not null),
    ('live payment core prerequisites','public.nexora_checkout_links','table',to_regclass('public.nexora_checkout_links') is not null),
    ('live payment core prerequisites','public.user_settings','table',to_regclass('public.user_settings') is not null),
    ('live payment core prerequisites','public.nexora_runtime_config','table',to_regclass('public.nexora_runtime_config') is not null),
    ('live payment core prerequisites','public.nexora_ledger_accounts','table',to_regclass('public.nexora_ledger_accounts') is not null),
    ('live payment core prerequisites','public.nexora_ledger_journals','table',to_regclass('public.nexora_ledger_journals') is not null),
    ('live payment core prerequisites','public.nexora_ledger_entries','table',to_regclass('public.nexora_ledger_entries') is not null),
    ('live payment core prerequisites','public.nexora_merchant_webhook_events','table',to_regclass('public.nexora_merchant_webhook_events') is not null),
    ('live payment core prerequisites','public.nexora_pricing_apply(uuid,uuid,uuid,uuid)','function',to_regprocedure('public.nexora_pricing_apply(uuid,uuid,uuid,uuid)') is not null),
    ('live payment core prerequisites','public.nexora_provider_accept_webhook(text,text,text,text,text)','function',to_regprocedure('public.nexora_provider_accept_webhook(text,text,text,text,text)') is not null),
    ('live payment core prerequisites','public.nexora_webhook_enqueue_payment_succeeded(uuid)','function',to_regprocedure('public.nexora_webhook_enqueue_payment_succeeded(uuid)') is not null),
    ('live payment core prerequisites','public.nexora_webhook_enqueue_payment_terminal(uuid,text)','function',to_regprocedure('public.nexora_webhook_enqueue_payment_terminal(uuid,text)') is not null),
    ('live payment core prerequisites','public.nexora_workspace_read_id()','function',to_regprocedure('public.nexora_workspace_read_id()') is not null),
    ('live payment core prerequisites','public.is_nexora_super_admin()','function',to_regprocedure('public.is_nexora_super_admin()') is not null),
    ('live payment core prerequisites','public.nexora_ledger_reject_mutation()','function',to_regprocedure('public.nexora_ledger_reject_mutation()') is not null),
    ('live payment core','public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)','function',
      to_regprocedure('public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)') is not null),
    ('checkout payer-document prerequisites','public.nexora_valid_brazilian_document(text)','function',
      to_regprocedure('public.nexora_valid_brazilian_document(text)') is not null),
    ('checkout payer-document validation','public.nexora_provider_begin_charge + public.nexora_checkout_public_begin_charge','capability',
      case when to_regprocedure('public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)') is null
          or to_regprocedure('public.nexora_checkout_public_begin_charge(text,text,text,text,text)') is null then false
        else position('nexora_valid_brazilian_document' in pg_get_functiondef(to_regprocedure('public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)')))>0
          and position('nexora_valid_brazilian_document' in pg_get_functiondef(to_regprocedure('public.nexora_checkout_public_begin_charge(text,text,text,text,text)')))>0
      end),
    ('legacy compatibility','public.nexora_asaas_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)','function',
      to_regprocedure('public.nexora_asaas_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)') is not null),
    ('checkout payment readiness','provider-neutral or legacy Asaas charge RPC','capability',
      to_regprocedure('public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)') is not null
      or to_regprocedure('public.nexora_asaas_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)') is not null)
), checkout_state as (
  select
    to_regclass('public.nexora_checkout_links') is not null as links_exists,
    to_regclass('public.nexora_checkout_public_rate_limits') is not null as rate_table_exists,
    to_regprocedure('public.nexora_checkout_consume_public_rate_limit(text,text)') is not null as rate_function_exists,
    coalesce((select bool_and(exists_now) from expected where stage='checkout base'),false) as base_prerequisites_ok,
    coalesce((select bool_and(exists_now) from expected where stage='checkout runtime'),false) as runtime_prerequisites_ok,
    coalesce((select bool_and(exists_now) from expected where stage='live payment core prerequisites'),false) as provider_core_prerequisites_ok,
    to_regprocedure('public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)') is not null as provider_core_installed,
    to_regprocedure('public.nexora_valid_brazilian_document(text)') is not null as payer_document_validator_installed,
    case when to_regprocedure('public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)') is null
        or to_regprocedure('public.nexora_checkout_public_begin_charge(text,text,text,text,text)') is null then false
      else position('nexora_valid_brazilian_document' in pg_get_functiondef(to_regprocedure('public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)')))>0
        and position('nexora_valid_brazilian_document' in pg_get_functiondef(to_regprocedure('public.nexora_checkout_public_begin_charge(text,text,text,text,text)')))>0
    end as payer_document_validation_installed
)
select stage,object_name,object_kind,exists_now,guidance
from (
  select stage,object_name,object_kind,exists_now,
    case when exists_now then 'ok'
      when stage='live payment core' then 'apply nexora-provider-neutral-payment-attempts.sql after checkout base and its documented dependencies'
      when stage='live payment core prerequisites' then 'resolve this prerequisite before applying nexora-provider-neutral-payment-attempts.sql'
      when stage='checkout payment readiness' then 'checkout base may install, but no charge RPC is available; install the provider-neutral payment core before enabling checkout'
      when stage='legacy compatibility' then 'optional compatibility path; the provider-neutral payment core is preferred'
      when stage='checkout payer-document prerequisites' then 'apply nexora-cnpj-alphanumeric.sql before enabling alphanumeric CNPJ in checkout'
      when stage='checkout payer-document validation' then 'apply nexora-checkout-alphanumeric-payer-document.sql after its prerequisites'
      when stage='checkout base' then 'apply the documented prerequisite migration first'
      else 'inspect the migration history before proceeding' end as guidance,
    case stage when 'checkout base' then 1 when 'checkout runtime' then 2
      when 'live payment core prerequisites' then 3 when 'live payment core' then 4
      when 'legacy compatibility' then 5 when 'checkout payment readiness' then 6
      when 'checkout payer-document prerequisites' then 7 when 'checkout payer-document validation' then 8 else 9 end as sort_rank
  from expected
  union all
  select 'next action' as stage,
    case
      when not (base_prerequisites_ok and runtime_prerequisites_ok) then 'resolve missing checkout prerequisites'
      when not links_exists then 'nexora-hosted-checkout.sql'
      when not rate_table_exists or not rate_function_exists then 'nexora-checkout-public-rate-limit.sql'
      when not provider_core_prerequisites_ok then 'resolve missing live payment core prerequisites'
      when not provider_core_installed then 'nexora-provider-neutral-payment-attempts.sql'
      when not payer_document_validator_installed then 'nexora-cnpj-alphanumeric.sql'
      when not payer_document_validation_installed then 'nexora-checkout-alphanumeric-payer-document.sql'
      else 'none'
    end as object_name,
    'next step' as object_kind,
    null::boolean as exists_now,
    case
      when not (base_prerequisites_ok and runtime_prerequisites_ok) then 'do not apply checkout or provider-core migrations yet; resolve false checkout base/runtime checks above'
      when not links_exists then 'apply the base migration; this version already includes public rate limiting'
      when not rate_table_exists or not rate_function_exists then 'apply the incremental rate-limit migration; the checkout base is already installed'
      when not provider_core_prerequisites_ok then 'do not apply the provider-neutral payment migration yet; resolve the false live payment core prerequisites above'
      when not provider_core_installed then 'apply the provider-neutral payment core only after every listed dependency is present'
      when not payer_document_validator_installed then 'apply the CNPJ validator migration before the checkout document gate migration'
      when not payer_document_validation_installed then 'apply the incremental migration once; it updates both checkout RPC validations'
      else 'checkout base, persistent rate limiter, provider-neutral payment core, and payer-document gates are present; do not rerun these migrations'
    end as guidance,
    9 as sort_rank
  from checkout_state
) preflight
order by sort_rank,object_name;

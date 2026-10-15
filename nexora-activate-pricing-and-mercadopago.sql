-- ==============================================================================
-- Nexora Pay - Ativação de Precificação Padrão e Mercado Pago Produção
-- Requisitos atendidos: #15 (Fee Engine / Pricing), #25 e #26 (Configuração Mercado Pago)
-- ==============================================================================

begin;

-- 1. Remove trava de desativação do Mercado Pago se existir
alter table public.nexora_acquirers
  drop constraint if exists nexora_mercadopago_disabled_until_adapter;

-- 2. Habilita o adquirente Mercado Pago Produção no catálogo
insert into public.nexora_acquirers (
  code, name, api_base_url, environment, payment_methods, status, notes
)
values (
  'mercadopago_production',
  'Mercado Pago · produção',
  'https://api.mercadopago.com',
  'production',
  array['pix']::text[],
  'enabled',
  'Mercado Pago Produção habilitado para Pix.'
)
on conflict (code) do update set
  status = 'enabled',
  api_base_url = 'https://api.mercadopago.com',
  payment_methods = array['pix']::text[],
  notes = 'Mercado Pago Produção habilitado para Pix.',
  updated_at = now();

-- 3. Garante que os workspaces dos lojistas tenham rota ativa para o Mercado Pago Produção
insert into public.nexora_merchant_provider_connections (
  business_id, owner_id, acquirer_id, status, configured_at, updated_at
)
select
  b.id,
  b.owner_id,
  a.id,
  'active',
  now(),
  now()
from public.businesses b
cross join public.nexora_acquirers a
where a.code = 'mercadopago_production'
on conflict (business_id) do update set
  acquirer_id = excluded.acquirer_id,
  status = 'active',
  updated_at = now();

-- 4. Garante que os controles do lojista permitam recebimentos Pix
insert into public.nexora_merchant_controls (
  business_id, owner_id, payments_enabled, withdrawals_enabled,
  api_enabled, pix_out_enabled, balance_movements_blocked, updated_by
)
select
  b.id,
  b.owner_id,
  true,
  false,
  true,
  false,
  false,
  b.owner_id
from public.businesses b
on conflict (business_id) do update set
  payments_enabled = true,
  updated_at = now();

-- 5. Insere regra de tarifa padrão Pix (R$ 0,99 fixo, 0% variável)
--    effective_from = now() - interval '1 hour' garante vigência imediata
insert into public.nexora_pricing_rules (
  business_id, owner_id, acquirer_id, payment_method,
  fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
)
select
  b.id,
  b.owner_id,
  a.id,
  'pix',
  99,  -- R$ 0,99 por transação
  0,   -- 0% tarifa percentual
  now() - interval '1 hour',
  'Tarifa padrão inicial Pix R$ 0,99',
  b.owner_id
from public.businesses b
cross join public.nexora_acquirers a
where a.environment = 'production'
  and not exists (
    select 1 from public.nexora_pricing_rules r
    where r.business_id = b.id
      and r.acquirer_id = a.id
      and r.payment_method = 'pix'
  );

commit;

-- Verificações pós-execução:
select 'pricing_rules_count' as metric, count(*)::text as value from public.nexora_pricing_rules
union all
select 'mercadopago_status', status from public.nexora_acquirers where code = 'mercadopago_production'
union all
select 'active_routes_count', count(*)::text from public.nexora_merchant_provider_connections where status = 'active';

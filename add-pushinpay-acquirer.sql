-- Migration: Add Pushin Pay as an enabled acquirer and add default pricing rules
begin;

-- 1. Insert pushinpay_production acquirer
insert into public.nexora_acquirers (
  id, code, name, api_base_url, environment, status, payment_methods, notes
) values (
  'f42c2620-3075-4ceb-9441-df07e6005c01',
  'pushinpay_production',
  'Pushin Pay · produção',
  'https://api.pushinpay.com.br/api',
  'production',
  'enabled',
  array['pix'],
  'API Pix oficial Pushin Pay'
) on conflict (code) do update set
  name = excluded.name,
  api_base_url = excluded.api_base_url,
  environment = excluded.environment,
  status = 'enabled',
  payment_methods = excluded.payment_methods,
  notes = excluded.notes;

-- 2. Add pricing rules for all approved businesses for pushinpay_production (R$ 0,99 fixo, 0 bps)
insert into public.nexora_pricing_rules (
  business_id, owner_id, acquirer_id, payment_method, fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
)
select
  b.id, b.owner_id, 'f42c2620-3075-4ceb-9441-df07e6005c01'::uuid, 'pix', 99, 0, now(),
  'Tarifa padrão Pushin Pay Pix R$ 0,99', b.owner_id
from public.businesses b
where not exists (
  select 1 from public.nexora_pricing_rules r
  where r.business_id = b.id and r.acquirer_id = 'f42c2620-3075-4ceb-9441-df07e6005c01'::uuid and r.payment_method = 'pix'
);

notify pgrst, 'reload schema';
commit;

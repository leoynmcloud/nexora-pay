-- Migration: Add Orus Prime as an enabled acquirer and add default pricing rules
begin;

-- 1. Insert orusprime_production acquirer
insert into public.nexora_acquirers (
  id, code, name, api_base_url, environment, status, payment_methods, notes
) values (
  'e872c914-1f74-4b47-b86a-72354f9a5d10',
  'orusprime_production',
  'Orus Prime · produção',
  'https://app.orusprime.com.br/api/v1',
  'production',
  'enabled',
  array['pix'],
  'API Pix oficial Orus Prime'
) on conflict (code) do update set
  name = excluded.name,
  api_base_url = excluded.api_base_url,
  environment = excluded.environment,
  status = 'enabled',
  payment_methods = excluded.payment_methods,
  notes = excluded.notes;

-- 2. Add pricing rules for all approved businesses for orusprime_production (R$ 0,99 fixo, 0 bps)
insert into public.nexora_pricing_rules (
  business_id, owner_id, acquirer_id, payment_method, fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
)
select
  b.id, b.owner_id, 'e872c914-1f74-4b47-b86a-72354f9a5d10'::uuid, 'pix', 99, 0, now(),
  'Tarifa padrão Orus Prime Pix R$ 0,99', b.owner_id
from public.businesses b
where not exists (
  select 1 from public.nexora_pricing_rules r
  where r.business_id = b.id and r.acquirer_id = 'e872c914-1f74-4b47-b86a-72354f9a5d10'::uuid and r.payment_method = 'pix'
);

notify pgrst, 'reload schema';
commit;

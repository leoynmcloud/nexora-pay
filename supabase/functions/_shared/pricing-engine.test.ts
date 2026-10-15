import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../../nexora-pricing-engine.sql', import.meta.url), 'utf8');
const hardening = readFileSync(new URL('../../../nexora-pricing-route-binding-hardening.sql', import.meta.url), 'utf8');

function pricingApply(source: string) {
  const start = source.indexOf('create or replace function public.nexora_pricing_apply(');
  const end = source.indexOf('revoke all on function public.nexora_pricing_apply', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end).trim().replace(/\s+/g, ' ');
}

test('pricing snapshot is bound to the transaction provider and environment', () => {
  const start = sql.indexOf('create or replace function public.nexora_pricing_apply(');
  const end = sql.indexOf('revoke all on function public.nexora_pricing_apply', start);
  assert.ok(start >= 0 && end > start);
  const apply = sql.slice(start, end);
  assert.match(apply, /auth\.jwt\(\)->>'role',''\) <> 'service_role'/);
  assert.match(apply, /v_transaction\.acquirer_id is distinct from p_acquirer_id/);
  assert.match(apply, /a\.environment=case when v_transaction\.test_mode then 'sandbox' else 'production' end/);
  assert.match(apply, /a\.status='enabled'/);
});

test('pricing is immutable per sale, effective-dated, cent-accurate, and fails closed', () => {
  const apply = pricingApply(sql);
  assert.match(apply, /r\.effective_from <= v_transaction\.created_at/);
  assert.match(apply, /order by r\.effective_from desc limit 1/);
  assert.match(apply, /v_fee := v_rule\.fixed_fee_cents\s*\+\s*round\(v_gross::numeric \* v_rule\.variable_fee_bps \/ 10000\)::bigint/);
  assert.match(apply, /if v_fee < 0 or v_net <= 0 then raise exception/);
  assert.match(apply, /return jsonb_build_object\('rule_id',v_existing\.rule_id/);
  assert.match(sql, /create trigger nexora_applied_pricing_immutable before update or delete/);
});

test('incremental route-binding migration is guarded, identical to the new-install function, and service-role only', () => {
  assert.match(hardening, /Apply nexora-pricing-engine\.sql before this hardening migration/);
  assert.equal(pricingApply(hardening), pricingApply(sql));
  assert.match(hardening, /revoke all on function public\.nexora_pricing_apply\([^)]+\) from public,anon,authenticated/);
  assert.match(hardening, /grant execute on function public\.nexora_pricing_apply\([^)]+\) to service_role/);
  assert.match(hardening, /anon_can_apply/);
});

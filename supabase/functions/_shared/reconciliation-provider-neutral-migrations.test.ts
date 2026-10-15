import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const foundation = readFileSync(new URL('../../../nexora-reconciliation-foundation.sql', import.meta.url), 'utf8');
const comparator = readFileSync(new URL('../../../nexora-reconciliation-comparator.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../nexora-reconcile-asaas/index.ts', import.meta.url), 'utf8');

test('reconciliation foundation can be installed without legacy Asaas tables', () => {
  const guard = foundation.slice(foundation.indexOf('do $$ begin'), foundation.indexOf('end $$;') + 'end $$;'.length);
  assert.ok(guard.length > 0);
  assert.doesNotMatch(guard, /nexora_asaas_sandbox_(?:operations|payment_details)/);
  assert.match(foundation, /if to_regclass\('public\.nexora_asaas_sandbox_operations'\) is not null then\s+execute \$sql\$/);
  assert.doesNotMatch(foundation, /declare v_operation public\.nexora_asaas_sandbox_operations/);
  assert.match(foundation, /create table if not exists public\.nexora_provider_statement_entries/);
  assert.match(foundation, /create table if not exists public\.nexora_settlements/);
});

test('reconciliation comparator requires the provider-neutral core and treats Asaas as an optional bridge', () => {
  const guard = comparator.slice(comparator.indexOf('do $$ begin'), comparator.indexOf('end $$;') + 'end $$;'.length);
  assert.ok(guard.length > 0);
  assert.doesNotMatch(guard, /nexora_asaas_sandbox_operations/);
  assert.match(comparator, /if to_regclass\('public\.nexora_asaas_sandbox_operations'\) is not null then/);
  assert.match(comparator, /create table if not exists public\.nexora_provider_payment_operations/);
  assert.match(comparator, /provider_operations_missing_for_paid_payments[\s\S]*?from public\.nexora_transactions t/);
  assert.doesNotMatch(comparator.slice(comparator.lastIndexOf('-- Generic diagnostic:')), /from public\.nexora_asaas_sandbox_operations/);
});

test('reconciliation requires an explicit production provider instead of silently defaulting to Asaas', () => {
  assert.match(runner, /const providerCode = requestData\.provider_code/);
  assert.doesNotMatch(runner, /requestData\.provider_code === undefined \? 'asaas_production'/);
  assert.match(runner, /if \(!adapterRoute \|\| adapterRoute\.sandboxOnly\)/);
  assert.match(runner, /adapterRoute\.adapter === 'asaas'[\s\S]*?fetchMercadoPagoProductionStatement/);
});

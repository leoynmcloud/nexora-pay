import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('merchant Pix OUT and outgoing freeze are first-class audited admin controls', () => {
  const migration = readFileSync(new URL('../../../nexora-merchant-independent-controls.sql', import.meta.url), 'utf8');
  const tableHardening = readFileSync(new URL('../../../nexora-merchant-controls-service-role-hardening.sql', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../../../nexora-admin.js', import.meta.url), 'utf8');
  assert.match(migration, /add column if not exists pix_out_enabled boolean not null default false/i);
  assert.match(migration, /add column if not exists balance_movements_blocked boolean not null default false/i);
  assert.match(migration, /auth\.jwt\(\)->>'aal'.*aal2/i);
  assert.match(migration, /merchant\.controls_updated/i);
  assert.match(migration, /revoke all on function public\.nexora_admin_set_merchant_controls_v3[\s\S]*?from public,anon/i);
  assert.match(migration, /create or replace function public\.nexora_admin_configure_merchant\([\s\S]*?security invoker/i);
  assert.match(migration, /revoke all on function public\.nexora_admin_configure_merchant[\s\S]*?from public,anon,service_role/i);
  assert.match(migration, /grant execute on function public\.nexora_admin_configure_merchant[\s\S]*?to authenticated/i);
  assert.match(migration, /c\.relrowsecurity as rls_enabled/i);
  assert.match(migration, /service_role_can_save/i);
  assert.match(migration, /service_role_can_configure/i);
  assert.match(tableHardening, /revoke insert,update,delete on public\.nexora_merchant_controls\s+from public,anon,authenticated,service_role/i);
  assert.match(tableHardening, /has_table_privilege\('service_role',c\.oid,'UPDATE'\) as service_role_can_update/i);
  assert.match(admin, /name="pix_out"/);
  assert.match(admin, /name="outgoing_frozen"/);
  assert.match(admin, /nexora_admin_configure_merchant/);
  assert.match(admin, /p_pix_out_enabled:[\s\S]*?p_balance_movements_blocked:/);
  assert.match(admin, /não altera nem reclassifica valores existentes no ledger/i);
});

test('payout reservation and dispatch both enforce merchant Pix OUT and movement freeze', () => {
  const sql = readFileSync(new URL('../../../nexora-payout-core.sql', import.meta.url), 'utf8');
  const reserveStart = sql.indexOf('create or replace function public.nexora_payout_reserve(');
  const reserveEnd = sql.indexOf('revoke all on function public.nexora_payout_reserve', reserveStart);
  const dispatchStart = sql.indexOf('create or replace function public.nexora_payout_dispatch_claim(');
  const dispatchEnd = sql.indexOf('revoke all on function public.nexora_payout_dispatch_claim', dispatchStart);
  assert.ok(reserveStart >= 0 && reserveEnd > reserveStart);
  assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart);
  const reserve = sql.slice(reserveStart, reserveEnd);
  const dispatch = sql.slice(dispatchStart, dispatchEnd);
  for (const body of [reserve, dispatch]) {
    assert.match(body, /c\.withdrawals_enabled[\s\S]*?c\.pix_out_enabled[\s\S]*?not c\.balance_movements_blocked/i);
  }
  assert.match(sql, /Apply nexora-merchant-independent-controls\.sql before payout core/i);
});

test('Super Admin saves controls and optional acquirer assignment in one atomic RPC', () => {
  const admin = readFileSync(new URL('../../../nexora-admin.js', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../../../nexora-merchant-independent-controls.sql', import.meta.url), 'utf8');
  const start = admin.indexOf('function manageAccount(item)');
  const end = admin.indexOf('function configurePixPricing(item)', start);
  assert.ok(start >= 0 && end > start);
  const manageAccount = admin.slice(start, end);
  assert.match(manageAccount, /API\.rpc\('nexora_admin_configure_merchant',configurePayload\)/);
  assert.doesNotMatch(manageAccount, /API\.rpc\('nexora_admin_set_merchant_controls_v3'/);
  assert.doesNotMatch(manageAccount, /API\.rpc\('nexora_admin_assign_acquirer'/);
  assert.match(manageAccount, /p_update_acquirer:updateAcquirer,p_acquirer_id:updateAcquirer \? requestedAcquirerId : null/);
  const combinedStart = migration.indexOf('create or replace function public.nexora_admin_configure_merchant(');
  const combinedEnd = migration.indexOf('revoke all on function public.nexora_admin_configure_merchant', combinedStart);
  assert.ok(combinedStart >= 0 && combinedEnd > combinedStart);
  const combined = migration.slice(combinedStart, combinedEnd);
  assert.match(combined, /perform public\.nexora_admin_set_merchant_controls_v3\([\s\S]*?if p_update_acquirer then\s+perform public\.nexora_admin_assign_acquirer/i);
});

test('Super Admin exposes assigned acquirer directly in merchant accounts table with accessible actions', () => {
  const admin = readFileSync(new URL('../../../nexora-admin.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../../nexora-admin.html', import.meta.url), 'utf8');
  assert.match(admin, /data-account-acquirer/);
  assert.match(admin, /Adquirente atribuído/);
  assert.match(admin, /Sem adquirente/);
  assert.match(html, /data-admin-connection-search/);
  assert.match(admin, /filteredConnections/);
});


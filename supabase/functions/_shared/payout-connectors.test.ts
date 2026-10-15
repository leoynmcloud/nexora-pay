import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { payoutAdapterCatalog, payoutAdapterFor } from './payout-connectors.ts';
import { payoutDispatchState } from './payout-dispatch-state.ts';

test('payout dispatch UI state fails closed unless both global gates are positively enabled', () => {
  assert.equal(payoutDispatchState(true, 'true'), 'enabled');
  assert.equal(payoutDispatchState(false, 'true'), 'disabled');
  assert.equal(payoutDispatchState(true, 'false'), 'disabled');
  assert.equal(payoutDispatchState(true, undefined), 'disabled');
  assert.equal(payoutDispatchState(null, 'true'), 'unknown');
  assert.equal(payoutDispatchState(undefined, 'true'), 'unknown');
});

test('Pix OUT connectors use explicit adapter codes and capabilities', () => {
  assert.deepEqual(payoutAdapterCatalog(), [
    { adapter_code: 'asaas', methods: ['pix'] },
    { adapter_code: 'mercadopago', methods: ['pix'] },
  ]);
  const asaas = payoutAdapterFor('asaas');
  assert.ok(asaas);
  assert.deepEqual(asaas.normalizeDestination({ key: 'SHOP@EXAMPLE.COM', keyType: 'EMAIL' }), {
    key: 'shop@example.com', keyType: 'EMAIL',
  });
  assert.ok(payoutAdapterFor('mercadopago'));
  assert.equal(payoutAdapterFor('asaas_production'), null);
  assert.equal(payoutAdapterFor('pagbank'), null);
  assert.equal(payoutAdapterFor(undefined), null);
});

test('payout SQL routes by registered capability, not by Asaas name', () => {
  const sql = readFileSync(new URL('../../../nexora-payout-core.sql', import.meta.url), 'utf8');
  const reserveStart = sql.indexOf('create or replace function public.nexora_payout_reserve(');
  const reserveEnd = sql.indexOf('revoke all on function public.nexora_payout_reserve', reserveStart);
  assert.ok(reserveStart >= 0 && reserveEnd > reserveStart);
  const reserve = sql.slice(reserveStart, reserveEnd);
  assert.match(reserve, /join public\.nexora_payout_provider_adapters\s+pa/i);
  assert.match(reserve, /join public\.nexora_payout_connector_catalog\s+pc/i);
  assert.match(reserve, /pa\.pix_out_enabled and pa\.adapter_ready and pa\.status='enabled'/i);
  assert.doesNotMatch(reserve, /a\.code\s*=\s*'asaas_production'/i);
  assert.match(sql, /production_enabled boolean not null default false/i);
  assert.match(sql, /select 'asaas_production','production','asaas',true,true,'disabled'/i);
  assert.match(sql, /select 'mercadopago_production','production','mercadopago',true,true,'disabled'/i);
  assert.match(sql, /provider_batch_id text/i);
  assert.match(sql, /v_payout\.adapter_code='mercadopago' and p_provider_batch_id is null/i);
});

test('provider transfer and batch IDs are unique only within each provider namespace', () => {
  const sql = readFileSync(new URL('../../../nexora-payout-core.sql', import.meta.url), 'utf8');
  assert.match(sql, /drop constraint if exists nexora_payouts_provider_transfer_id_key/i);
  assert.match(sql, /drop index if exists public\.nexora_payouts_provider_batch_id_unique/i);
  assert.match(sql, /on public\.nexora_payouts\(provider_code,provider_batch_id\) where provider_batch_id is not null/i);
  assert.match(sql, /on public\.nexora_payouts\(provider_code,provider_transfer_id\) where provider_transfer_id is not null/i);
  assert.doesNotMatch(sql, /provider_transfer_id text unique/i);
});

test('payout reservation serializes per merchant and checks only reconciled available ledger funds', () => {
  const sql = readFileSync(new URL('../../../nexora-payout-core.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('create or replace function public.nexora_payout_reserve(');
  const end = sql.indexOf('revoke all on function public.nexora_payout_reserve', start);
  assert.ok(start >= 0 && end > start);
  const reserve = sql.slice(start, end);
  const merchantLock = reserve.indexOf('from public.businesses b where b.id=p_business_id and b.owner_id=p_owner_id for update');
  const existingRequestCheck = reserve.indexOf('where p.owner_id=p_owner_id and p.business_id=p_business_id and p.request_id=p_request_id for update');
  const balanceRead = reserve.indexOf("a.account_code='merchant_available'");
  const balanceGate = reserve.indexOf('if p_amount_cents>v_available');
  const payoutInsert = reserve.indexOf('insert into public.nexora_payouts(');
  const ledgerReserve = reserve.indexOf('perform public.nexora_ledger_post_journal(');
  assert.ok(merchantLock >= 0 && merchantLock < existingRequestCheck);
  assert.ok(existingRequestCheck < balanceRead && balanceRead < balanceGate);
  assert.ok(balanceGate < payoutInsert && payoutInsert < ledgerReserve);
  assert.match(reserve, /where e\.owner_id=p_owner_id and e\.business_id=p_business_id and a\.account_code='merchant_available'/i);
  assert.doesNotMatch(reserve, /a\.account_code='merchant_pending'/i);
  assert.match(reserve, /date_trunc\('day',now\(\) at time zone 'America\/Sao_Paulo'\)/i);
  assert.match(reserve, /v_used\+p_amount_cents>v_daily_limit/i);
  assert.match(reserve, /'payout\.reserved','payout\.reserve:'\|\|v_payout\.id::text/);
  assert.match(reserve, /'merchant_available','side','debit','amount_cents',p_amount_cents/);
  assert.match(reserve, /'merchant_reserved','side','credit','amount_cents',p_amount_cents/);
});

test('payout event persistence normalizes provider vocabulary outside the SQL core', () => {
  const sql = readFileSync(new URL('../../../nexora-payout-core.sql', import.meta.url), 'utf8');
  const applyStart = sql.indexOf('create or replace function public.nexora_payout_apply_provider_event(');
  const applyEnd = sql.indexOf('revoke all on function public.nexora_payout_apply_provider_event', applyStart);
  assert.ok(applyStart >= 0 && applyEnd > applyStart);
  const apply = sql.slice(applyStart, applyEnd);
  assert.match(apply, /p_normalized_status not in \('PROCESSING','RISK_REVIEW','COMPLETED','FAILED'\)/i);
  assert.doesNotMatch(apply, /p_provider_event_type not in/i);
  assert.doesNotMatch(apply, /p_raw_provider_status in \('PENDING','PROCESSING'/i);
});

test('payout dispatch is a separate, one-time, fail-closed Super Admin action', () => {
  const sql = readFileSync(new URL('../../../nexora-payout-core.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('create or replace function public.nexora_payout_dispatch_claim(');
  const end = sql.indexOf('revoke all on function public.nexora_payout_dispatch_claim', start);
  assert.ok(start >= 0 && end > start);
  const claim = sql.slice(start, end);
  assert.match(claim, /production_enabled into v_enabled/i);
  assert.match(claim, /v_payout\.status<>'APPROVED'/i);
  assert.match(claim, /update public\.nexora_payouts set status='OUTCOME_UNKNOWN'/i);
  assert.match(claim, /pa\.pix_out_enabled and pa\.adapter_ready and pa\.status='enabled'/i);
  assert.match(claim, /payout\.dispatch_started/i);
  assert.match(sql, /action in \('approved','rejected','dispatch_started','reconciled'\)/i);
  assert.match(sql, /returns table\([\s\S]*provider_batch_id text,provider_transfer_id text/i);
});

test('payout admin hides dispatch until both global production gates are enabled', () => {
  const handler = readFileSync(new URL('../nexora-payout-admin/index.ts', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../../../nexora-admin.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../../nexora-admin.html', import.meta.url), 'utf8');
  assert.match(handler, /from\('nexora_payout_runtime'\)[\s\S]*select\('production_enabled'\)/);
  assert.match(handler, /payoutDispatchState\([\s\S]*NEXORA_PAYOUT_DISPATCH_ENABLED/);
  assert.match(handler, /dispatch_enabled: dispatchState === 'enabled'/);
  assert.match(handler, /runtimeError \|\| !runtime \? null/);
  assert.match(handler, /dispatch_state: dispatchState/);
  assert.doesNotMatch(handler, /if \(runtimeError \|\| !runtime\) throw/);
  assert.match(admin, /const dispatchEnabled = result\?\.dispatch_enabled === true/);
  assert.match(admin, /dispatchStateUnknown \? 'Não foi possível confirmar as flags globais de envio' : 'A chave global de envio permanece desligada'/);
  assert.match(admin, /dispatchStateUnknown \? 'Envio não verificado' : 'Envio desativado'/);
  assert.match(admin, /Não foi possível verificar a configuração global; o envio permanece bloqueado, mas a revisão segue disponível/);
  assert.match(html, /chaves globais do banco e da Edge Function estiverem ligadas/);
});

test('manual payout reconciliation is read-only at provider and audited atomically', () => {
  const handler = readFileSync(new URL('../nexora-payout-admin/index.ts', import.meta.url), 'utf8');
  const reconcileStart = handler.indexOf('async function reconcilePayout(');
  const reconcileEnd = handler.indexOf('\nDeno.serve(', reconcileStart);
  assert.ok(reconcileStart >= 0 && reconcileEnd > reconcileStart);
  const reconcile = handler.slice(reconcileStart, reconcileEnd);
  assert.match(reconcile, /adapter\.getTransfer\(/);
  assert.match(reconcile, /findAsaasPixTransferByReference\(/);
  assert.match(reconcile, /for \(const createdDate of adjacentUtcDates\(/);
  assert.match(reconcile, /distinctMatches\.size > 1/);
  assert.doesNotMatch(reconcile, /adapter\.createTransfer\(/);
  assert.match(reconcile, /provider_transfer_id/);
  assert.match(reconcile, /providerBatchId/);
  assert.match(reconcile, /nexora_payout_admin_reconcile_event/);

  const sql = readFileSync(new URL('../../../nexora-payout-core.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('create or replace function public.nexora_payout_admin_reconcile_event(');
  const end = sql.indexOf('revoke all on function public.nexora_payout_admin_reconcile_event', start);
  assert.ok(start >= 0 && end > start);
  const rpc = sql.slice(start, end);
  assert.match(rpc, /a\.role='super_admin'/i);
  assert.match(rpc, /v_payout\.status not in \('OUTCOME_UNKNOWN','PROCESSING','RISK_REVIEW'\)/i);
  assert.match(rpc, /nexora_payout_apply_provider_event/i);
  assert.match(rpc, /'reconciled'/i);
  assert.match(rpc, /'payout\.reconciled'/i);
});

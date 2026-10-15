import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../../nexora-hosted-checkout.sql', import.meta.url), 'utf8');
const paymentCore = readFileSync(new URL('../../../nexora-provider-neutral-payment-attempts.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../../nexora-checkout-public-rate-limit.sql', import.meta.url), 'utf8');
const preflight = readFileSync(new URL('../../../nexora-checkout-migration-preflight.sql', import.meta.url), 'utf8');
const handler = readFileSync(new URL('../nexora-checkout/index.ts', import.meta.url), 'utf8');
const platform = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');

test('merchant receives and can copy the opaque hosted payment URL without losing it on close', () => {
  assert.match(platform, /data-checkout-link-url aria-label="Link de pagamento criado" readonly/);
  assert.match(platform, /Copie antes de fechar: por segurança, o token completo não fica armazenado/);
  assert.match(platform, /if \(input\) \{ input\.focus\(\); input\.select\(\); \}/);
  assert.match(platform, /role="status"><b>Link (?:de pagamento|Pix) criado<\/b>/);
});

test('checkout migration preflight stays read-only and distinguishes apply prerequisites from live charge readiness', () => {
  assert.doesNotMatch(preflight, /^\s*(?:create|alter|drop|insert|update|delete|grant|revoke|truncate|begin|commit)\b/im);
  assert.match(preflight, /to_regclass\('public\.nexora_checkout_links'\)/);
  assert.match(preflight, /nexora_businesses_id_owner_id_unique/);
  assert.match(preflight, /nexora_transactions_id_business_owner_unique/);
  assert.match(preflight, /public\.nexora_provider_begin_charge\(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz\)/);
  assert.match(preflight, /public\.nexora_asaas_begin_charge\(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz\)/);
  assert.match(preflight, /provider-neutral or legacy Asaas charge RPC/);
  for (const dependency of [
    'public.nexora_provider_payment_operations',
    'public.nexora_applied_pricing',
    'public.nexora_provider_payment_status_events',
    'public.nexora_provider_webhook_inbox',
    'public.nexora_runtime_config',
    'public.nexora_ledger_accounts',
    'public.nexora_ledger_journals',
    'public.nexora_ledger_entries',
    'public.nexora_merchant_webhook_events',
    'public.nexora_pricing_apply(uuid,uuid,uuid,uuid)',
    'public.nexora_provider_accept_webhook(text,text,text,text,text)',
    'public.nexora_webhook_enqueue_payment_succeeded(uuid)',
    'public.nexora_webhook_enqueue_payment_terminal(uuid,text)',
    'public.nexora_workspace_read_id()',
    'public.is_nexora_super_admin()',
    'public.nexora_ledger_reject_mutation()',
  ]) assert.ok(preflight.includes(dependency), `missing provider-core preflight dependency: ${dependency}`);
  const guardStart = paymentCore.indexOf('do $$ begin');
  const guardEnd = paymentCore.indexOf('end $$;', guardStart);
  const paymentCoreGuard = paymentCore.slice(guardStart, guardEnd);
  const guardedObjects = [...paymentCoreGuard.matchAll(/to_reg(?:class|procedure)\('(public\.[^']+)'\)/g)]
    .map((match) => match[1]);
  assert.ok(guardedObjects.length > 0, 'provider-core migration guard should be discoverable');
  for (const objectName of guardedObjects) {
    assert.ok(preflight.includes(`'${objectName}'`), `preflight is missing guarded dependency: ${objectName}`);
  }
  assert.match(preflight, /not provider_core_prerequisites_ok then 'resolve missing live payment core prerequisites'/);
  assert.match(preflight, /not provider_core_installed then 'nexora-provider-neutral-payment-attempts\.sql'/);
  assert.match(preflight, /checkout payer-document prerequisites/);
  assert.match(preflight, /nexora_valid_brazilian_document\(text\)/);
  assert.match(preflight, /checkout payer-document validation/);
  assert.match(preflight, /pg_get_functiondef\(to_regprocedure\('public\.nexora_provider_begin_charge/);
  assert.match(preflight, /not payer_document_validator_installed then 'nexora-cnpj-alphanumeric\.sql'/);
  assert.match(preflight, /not payer_document_validation_installed then 'nexora-checkout-alphanumeric-payer-document\.sql'/);
});

test('public checkout rate limits are durable, scoped to valid links, and inaccessible directly', () => {
  assert.match(sql, /nexora_checkout_public_rate_limits\s*\([\s\S]*?checkout_link_id uuid not null references public\.nexora_checkout_links\(id\) on delete cascade/);
  assert.match(sql, /revoke all on public\.nexora_checkout_public_rate_limits from public,anon,authenticated,service_role/i);
  assert.match(sql, /if coalesce\(auth\.jwt\(\)->>'role',''\)<>'service_role' then raise exception 'Backend service role required\.'/);
  assert.match(sql, /where token_hash=p_token_hash and expires_at>v_now/);
  assert.match(sql, /v_window_seconds := 60;\s*v_max_requests := 30;/);
  assert.match(sql, /v_window_seconds := 600;\s*v_max_requests := 5;/);
  assert.match(sql, /on conflict \(checkout_link_id,action\) do update/);
  assert.match(sql, /least\(public\.nexora_checkout_public_rate_limits\.request_count,v_max_requests\)\+1/);
  assert.match(sql, /where public\.nexora_checkout_public_rate_limits\.window_started_at is distinct from v_window_start\s+or public\.nexora_checkout_public_rate_limits\.request_count<=v_max_requests\s+returning request_count into v_count;\s+if v_count is null then\s+select request_count into v_count/i);
  assert.match(sql, /grant execute on function public\.nexora_checkout_consume_public_rate_limit\(text,text\) to service_role/i);
  assert.match(migration, /Apply nexora-hosted-checkout\.sql before this migration/);
  assert.match(migration, /revoke all on public\.nexora_checkout_public_rate_limits from public,anon,authenticated,service_role/i);
  assert.match(migration, /anon_can_consume/);
  assert.match(migration, /service_role_can_consume/);
  assert.match(migration, /least\(public\.nexora_checkout_public_rate_limits\.request_count,v_max_requests\)\+1/);
  assert.match(migration, /where public\.nexora_checkout_public_rate_limits\.window_started_at is distinct from v_window_start\s+or public\.nexora_checkout_public_rate_limits\.request_count<=v_max_requests\s+returning request_count into v_count;\s+if v_count is null then\s+select request_count into v_count/i);
  const rateLimitStart = 'create table if not exists public.nexora_checkout_public_rate_limits';
  const functionStart = 'create or replace function public.nexora_checkout_consume_public_rate_limit';
  const functionEnd = 'grant execute on function public.nexora_checkout_consume_public_rate_limit(text,text) to service_role;';
  const coreRateLimitSql = sql.slice(sql.indexOf(rateLimitStart), sql.indexOf('create or replace function public.nexora_checkout_public_begin_charge'))
    .trim().replace(/\s+/g, ' ');
  const followUpRateLimitSql = migration.slice(migration.indexOf(rateLimitStart), migration.indexOf('notify pgrst'))
    .trim().replace(/\s+/g, ' ');
  assert.ok(coreRateLimitSql.startsWith(rateLimitStart));
  assert.ok(coreRateLimitSql.includes(functionStart));
  assert.ok(followUpRateLimitSql.includes(functionStart));
  assert.ok(followUpRateLimitSql.includes(functionEnd));
  assert.equal(coreRateLimitSql, followUpRateLimitSql);
});

test('public snapshot includes the non-secret provider code required by the central checkout adapter registry', () => {
  for (const migrationSource of [sql, paymentCore]) {
    const snapshotStart = migrationSource.indexOf('create or replace function public.nexora_checkout_public_snapshot');
    const snapshotEnd = migrationSource.indexOf('revoke all on function public.nexora_checkout_public_snapshot', snapshotStart);
    const snapshotFunction = migrationSource.slice(snapshotStart, snapshotEnd);
    assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
    assert.match(snapshotFunction, /'provider_code'\s*,\s*v_link\.provider_code/);
  }
  assert.match(handler, /hostedCheckoutPayerRequirements\(data\.provider_code\)/);
  assert.match(handler, /hostedCheckoutDomains\(data\.provider_code\)/);
  assert.match(handler, /hostedCheckoutAdapter\(snapshot\.provider_code\)/);
});

test('provider rejection RPC can fail only the matching preflighted attempt and terminalizes its transaction and link', () => {
  const start = paymentCore.indexOf('create or replace function public.nexora_provider_fail_charge_attempt(');
  const end = paymentCore.indexOf('revoke all on function public.nexora_provider_fail_charge_attempt', start);
  assert.ok(start >= 0 && end > start);
  const failAttempt = paymentCore.slice(start, end);
  assert.match(failAttempt, /auth\.jwt\(\)->>'role',''\)<>'service_role'/);
  assert.match(failAttempt, /v_attempt\.lease_token is distinct from p_lease_token/);
  assert.match(failAttempt, /v_attempt\.payment_attempted_at is null or v_attempt\.provider_transaction_id is not null/);
  assert.match(failAttempt, /set status='failed',last_error_code=p_error_code/);
  assert.match(failAttempt, /update public\.nexora_transactions set status='cancelled'/);
  assert.match(failAttempt, /update public\.nexora_checkout_links set status='failed'/);
});

test('checkout becomes processing only at the durable pre-POST claim, not while credentials or ledger are being prepared', () => {
  const claimStart = paymentCore.indexOf('create or replace function public.nexora_provider_mark_payment_attempt_started(');
  const claimEnd = paymentCore.indexOf('revoke all on function public.nexora_provider_mark_payment_attempt_started', claimStart);
  const claim = paymentCore.slice(claimStart, claimEnd);
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  assert.ok(claim.indexOf('set payment_attempted_at=now(),status=\'unknown\'')
    < claim.indexOf("set status='processing',transaction_id=v_attempt.transaction_id"));

  const beginStart = paymentCore.indexOf('create or replace function public.nexora_checkout_public_begin_charge(');
  const beginEnd = paymentCore.indexOf('revoke all on function public.nexora_checkout_public_begin_charge', beginStart);
  const begin = paymentCore.slice(beginStart, beginEnd);
  assert.ok(beginStart >= 0 && beginEnd > beginStart);
  assert.match(begin, /status=case when v_legacy_operation or nullif\(v_result->>'payment_attempted_at',''\) is not null\s+then 'processing' else status end/);
});

test('public checkout checks quotas before provider recovery or payment creation and returns Retry-After', () => {
  assert.match(handler, /consumePublicCheckoutLimit\(admin, tokenHash, 'view'\)/);
  assert.match(handler, /consumePublicCheckoutLimit\(admin, tokenHash, 'pay'\)/);
  assert.match(handler, /status: 429, retryAfter: rateLimit\.retry_after_seconds/);
  assert.match(handler, /'Retry-After': String\(result\.retryAfter\)/);
  assert.ok(handler.indexOf("consumePublicCheckoutLimit(admin, tokenHash, 'pay')")
    < handler.indexOf('handleMercadoPagoPublicPayment(admin,input,snapshot,payer,tokenHash,requestHash,cardInput || undefined)'));
  const payHandlerStart = handler.indexOf('async function handlePublicPayment');
  const payHandler = handler.slice(payHandlerStart, handler.indexOf('\n}\n\nDeno.serve', payHandlerStart));
  assert.ok(payHandler.indexOf("consumePublicCheckoutLimit(admin, tokenHash, 'pay')")
    < payHandler.indexOf("admin.rpc('nexora_checkout_public_snapshot'"));
  const viewHandler = handler.slice(handler.indexOf("if (input.action === 'view')"), handler.indexOf("if (input.action === 'pay')"));
  assert.ok(viewHandler.indexOf("consumePublicCheckoutLimit(admin, tokenHash, 'view')")
    < viewHandler.indexOf("admin.rpc('nexora_checkout_public_snapshot'"));
  assert.match(handler, /!rateLimit\.allowed && rateLimit\.retry_after_seconds > 0/);
});

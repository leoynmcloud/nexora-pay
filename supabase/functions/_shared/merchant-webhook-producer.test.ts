import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../../nexora-merchant-webhooks.sql', import.meta.url), 'utf8');
const paymentSql = readFileSync(new URL('../../../nexora-provider-neutral-payment-attempts.sql', import.meta.url), 'utf8');
const asaas = readFileSync(new URL('../nexora-asaas-webhook/asaas-webhook-core.ts', import.meta.url), 'utf8');
const mercadoPago = readFileSync(new URL('../_shared/mercadopago-webhook-core.ts', import.meta.url), 'utf8');
const checkoutUi = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');

test('merchant payment event requires a paid production transaction and exact pending ledger credit', () => {
  const start = sql.indexOf('create or replace function public.nexora_webhook_enqueue_payment_succeeded(');
  const end = sql.indexOf('revoke all on function public.nexora_webhook_enqueue_payment_succeeded', start);
  assert.ok(start >= 0 && end > start);
  const producer = sql.slice(start, end);
  assert.match(producer, /auth\.jwt\(\)->>'role',''\)<>'service_role'/);
  assert.match(producer, /t\.status='paid' and t\.kind='payment' and not t\.test_mode/);
  assert.match(producer, /v_receipt_journal_count<>1 or v_receipt_entry_count<>2/);
  assert.match(producer, /v_pending_cents<>round\(v_tx\.amount\*100\)::bigint/);
  assert.match(producer, /v_provider_clearing_debit<>round\(v_tx\.amount\*100\)::bigint/);
  assert.doesNotMatch(producer, /merchant_available|merchant_reserved|merchant_blocked/);
  assert.match(producer, /on conflict\(business_id,event_code,transaction_id\) do nothing/);
  assert.match(producer, /where e\.business_id=v_tx\.business_id and e\.owner_id=v_tx\.owner_id and e\.status='active'/);
  assert.match(producer, /on conflict\(event_id,endpoint_id\) do nothing/);
});

test('merchant webhooks can subscribe to terminal payment failures and cancellations only after state transition', () => {
  const start = sql.indexOf('create or replace function public.nexora_webhook_enqueue_payment_terminal(');
  const end = sql.indexOf('revoke all on function public.nexora_webhook_enqueue_payment_terminal', start);
  assert.ok(start >= 0 && end > start);
  const producer = sql.slice(start, end);
  assert.match(producer, /auth\.jwt\(\)->>'role',''\)<>'service_role'/);
  assert.match(producer, /t\.status='cancelled' and t\.kind='payment' and not t\.test_mode/);
  assert.match(producer, /v_attempt_status is distinct from 'failed'/);
  assert.match(producer, /v_provider_status not in \('CANCELED','EXPIRED'\)/);
  assert.match(producer, /on conflict\(business_id,event_code,transaction_id\) do nothing/);
  assert.match(producer, /p_event_code=any\(e\.subscribed_events\)/);

  const failureStart = paymentSql.indexOf('create or replace function public.nexora_provider_fail_charge_attempt(');
  const failureEnd = paymentSql.indexOf('revoke all on function public.nexora_provider_fail_charge_attempt', failureStart);
  const failure = paymentSql.slice(failureStart, failureEnd);
  const cancelTransition = failure.indexOf("update public.nexora_transactions set status='cancelled'");
  assert.ok(cancelTransition >= 0);
  assert.match(failure.slice(cancelTransition, cancelTransition + 160), /status in \('pending','processing'\)/);
  assert.ok(failure.indexOf('nexora_webhook_enqueue_payment_terminal', cancelTransition) > cancelTransition);

  const saveStart = paymentSql.indexOf('create or replace function public.nexora_provider_save_charge_result(');
  const saveEnd = paymentSql.indexOf('revoke all on function public.nexora_provider_save_charge_result', saveStart);
  const save = paymentSql.slice(saveStart, saveEnd);
  assert.match(save, /case when p_normalized_status='FAILED' then 'payment.failed' else 'payment.canceled' end/);
  assert.match(save, /where id=v_attempt\.transaction_id and status in \('pending','processing'\)/);
  assert.match(checkoutUi, /value="payment\.succeeded"[\s\S]*?value="payment\.failed"[\s\S]*?value="payment\.canceled"/);
  assert.equal(checkoutUi.includes('endpoint_url: endpointUrl, events });'), true);
});

test('provider-neutral Asaas and Mercado Pago confirm only after posting the ledger journal', () => {
  for (const source of [asaas, mercadoPago]) {
    const ledger = source.indexOf("admin.rpc('nexora_ledger_post_journal'");
    const confirmation = source.indexOf("admin.rpc('nexora_provider_confirm_payment_succeeded'");
    assert.ok(ledger >= 0 && confirmation > ledger);
    assert.match(source.slice(confirmation, confirmation + 420), /if\s*\(?(?:confirmError|confirmError\s*)\)?\s*throw new Error\('payment_confirmation_failed'\)/);
  }

  const confirmationStart = paymentSql.indexOf('create or replace function public.nexora_provider_confirm_payment_succeeded(');
  const confirmationEnd = paymentSql.indexOf('\n$$;', confirmationStart);
  assert.ok(confirmationStart >= 0 && confirmationEnd > confirmationStart);
  const confirmationRpc = paymentSql.slice(confirmationStart, confirmationEnd);
  assert.match(confirmationRpc, /v_receipt_journal_count<>1/);
  assert.match(confirmationRpc, /j\.idempotency_key='provider\.payment\.succeeded:'\|\|p_provider_code/);
  assert.match(confirmationRpc, /v_receipt_entry_count<>2/);
  assert.match(confirmationRpc, /la\.account_code='merchant_pending' and le\.side='credit'/);
  assert.match(confirmationRpc, /la\.account_code='provider_clearing' and le\.side='debit'/);
  assert.doesNotMatch(confirmationRpc, /merchant_available|merchant_reserved|merchant_blocked/);
  assert.match(confirmationRpc, /update public\.nexora_transactions set status='paid'/);
  assert.match(confirmationRpc, /update public\.nexora_checkout_links set status='paid'/);
  assert.match(confirmationRpc, /perform public\.nexora_webhook_enqueue_payment_succeeded\(p_transaction_id\)/);
  assert.ok(confirmationRpc.indexOf("update public.nexora_checkout_links set status='paid'")
    < confirmationRpc.indexOf('perform public.nexora_webhook_enqueue_payment_succeeded'));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('idempotent payment retry cannot submit with a revoked or mismatched historical credential', () => {
  const sql = readFileSync(new URL('../../../nexora-provider-neutral-payment-attempts.sql', import.meta.url), 'utf8');
  const start = sql.indexOf('create or replace function public.nexora_provider_begin_charge(');
  const end = sql.indexOf('revoke all on function public.nexora_provider_begin_charge', start);
  assert.ok(start >= 0 && end > start);
  const beginCharge = sql.slice(start, end);
  const retryStart = beginCharge.indexOf('if found then', beginCharge.indexOf('select * into v_attempt'));
  const retryEnd = beginCharge.indexOf('\n  end if;', beginCharge.indexOf("if v_attempt.payment_attempted_at is null", retryStart)) + '\n  end if;'.length;
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  const retry = beginCharge.slice(retryStart, retryEnd);
  assert.match(retry, /v_credential\.acquirer_id is distinct from v_attempt\.acquirer_id/i);
  assert.match(retry, /v_credential\.environment is distinct from v_attempt\.environment/i);
  assert.match(retry, /if v_should_submit and v_credential\.status<>'active' then[\s\S]*?envio foi bloqueado/i);
  assert.ok(retry.indexOf('if v_should_submit and v_credential.status') > retry.indexOf('if v_attempt.payment_attempted_at is null'));
  assert.match(retry, /'payment_attempted_at',v_attempt\.payment_attempted_at,'should_submit',v_should_submit/);
});

test('the one-shot pre-POST claim revalidates merchant, route, product, and credential gates', () => {
  const sql = readFileSync(new URL('../../../nexora-provider-neutral-payment-attempts.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists connection_version timestamptz/i);
  assert.match(sql, /provider_code,environment,connection_version,idempotency_key/);
  assert.match(sql, /new\.connection_version is distinct from old\.connection_version/i);
  const start = sql.indexOf('create or replace function public.nexora_provider_mark_payment_attempt_started(');
  const end = sql.indexOf('revoke all on function public.nexora_provider_mark_payment_attempt_started', start);
  assert.ok(start >= 0 && end > start);
  const claim = sql.slice(start, end);
  assert.match(claim, /returns boolean language plpgsql/i);
  assert.match(claim, /v_attempt\.status<>'processing'/i);
  const decision = claim.indexOf('if v_block_reason is not null then');
  const blockedMutation = claim.indexOf("update public.nexora_payment_attempts set status='failed'");
  const submittedMutation = claim.indexOf('update public.nexora_payment_attempts set payment_attempted_at');
  assert.ok(decision > 0 && blockedMutation > decision && submittedMutation > blockedMutation);
  const gates = claim.slice(0, decision);
  for (const required of [
    /v_connection\.status is distinct from 'active'/i,
    /v_connection\.updated_at is distinct from v_attempt\.connection_version/i,
    /v_acquirer\.status is distinct from 'enabled'/i,
    /not coalesce\('pix'=any\(v_acquirer\.payment_methods\),false\)/i,
    /v_credential\.status is distinct from 'active'/i,
    /v_controls\.payments_enabled is distinct from true/i,
    /merchant_onboarding k[\s\S]*?k\.status='APPROVED'/i,
    /public\.nexora_account_active\(v_attempt\.owner_id\) is distinct from true/i,
    /t\.kind='payment' and t\.status='pending'[\s\S]*?t\.test_mode=\(v_attempt\.environment='sandbox'\)/i,
  ]) assert.match(gates, required);
  const blocked = claim.slice(decision, submittedMutation);
  assert.match(blocked, /last_error_code=v_block_reason/i);
  assert.match(blocked, /operation_status='FAILED'/i);
  assert.match(blocked, /set status='cancelled'/i);
  assert.match(blocked, /set status='failed'/i);
});

test('checkout handlers distinguish a pre-submit gate block from an uncertain provider request', () => {
  const publicCheckout = readFileSync(new URL('../nexora-checkout/index.ts', import.meta.url), 'utf8');
  const merchantCheckout = readFileSync(new URL('../_shared/mercadopago-payments.ts', import.meta.url), 'utf8');
  for (const handler of [publicCheckout, merchantCheckout]) {
    assert.match(handler, /wasBlockedBeforeProviderSubmit/);
    assert.match(handler, /conditions of receiving changed|condições de recebimento mudaram/i);
    assert.match(handler, /status:\s*409/);
    assert.match(handler, /status:\s*202/);
  }
});

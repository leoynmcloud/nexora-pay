import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAmountCents,
  assertValidIdempotencyKey,
  normalizePaymentStatus,
  normalizeWithdrawalStatus,
  webhookRetryDelayMs,
  webhookRetryAfterSeconds,
} from './payment-provider.ts';

describe('provider-neutral payment core guards', () => {
  it('normalizes successful provider payment states without claiming settlement', () => {
    assert.equal(normalizePaymentStatus('paid'), 'SUCCEEDED');
    assert.equal(normalizePaymentStatus('completed'), 'SUCCEEDED');
    assert.equal(normalizePaymentStatus('received'), 'SUCCEEDED');
    assert.notEqual(normalizePaymentStatus('paid'), 'SETTLED');
    assert.equal(normalizePaymentStatus('settled'), 'SETTLED');
  });

  it('keeps authorization distinct from capture/success', () => {
    assert.equal(normalizePaymentStatus('approved'), 'AUTHORIZED');
    assert.equal(normalizePaymentStatus('authorized'), 'AUTHORIZED');
  });

  it('maps unknown payment states to manual review', () => {
    assert.equal(normalizePaymentStatus('new-provider-state'), 'UNDER_REVIEW');
    assert.equal(normalizePaymentStatus(null), 'UNDER_REVIEW');
    assert.equal(normalizePaymentStatus(''), 'UNDER_REVIEW');
  });

  it('normalizes refund and risk states without treating them as successful payments', () => {
    assert.equal(normalizePaymentStatus('refund requested'), 'REFUND_PENDING');
    assert.equal(normalizePaymentStatus('partially_refunded'), 'PARTIALLY_REFUNDED');
    assert.equal(normalizePaymentStatus('chargeback dispute'), 'UNDER_REVIEW');
    assert.equal(normalizePaymentStatus('awaiting risk analysis'), 'UNDER_REVIEW');
  });

  it('normalizes cancellation spelling variants', () => {
    assert.equal(normalizePaymentStatus('cancelled'), 'CANCELED');
    assert.equal(normalizePaymentStatus('cancelled by provider'), 'UNDER_REVIEW');
  });

  it('round-trips every normalized Payment Core state without collapsing distinct lifecycle stages', () => {
    const states = [
      'CREATED', 'PENDING', 'PROCESSING', 'AUTHORIZED', 'SUCCEEDED', 'SETTLED',
      'FAILED', 'CANCELED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED',
      'PARTIALLY_REFUNDED', 'REVERSED', 'UNDER_REVIEW',
    ] as const;
    for (const state of states) assert.equal(normalizePaymentStatus(state), state);
    assert.notEqual(normalizePaymentStatus('AUTHORIZED'), 'SUCCEEDED');
    assert.notEqual(normalizePaymentStatus('SUCCEEDED'), 'SETTLED');
    assert.notEqual(normalizePaymentStatus('REFUND_PENDING'), 'REFUNDED');
  });

  it('maps successful payouts to completed and unknown payouts to review', () => {
    assert.equal(normalizeWithdrawalStatus('success'), 'COMPLETED');
    assert.equal(normalizeWithdrawalStatus('provider-new-state'), 'RISK_REVIEW');
  });

  it('accepts only bounded, supported idempotency keys', () => {
    const key = 'merchant_01:payment-0001';
    assert.equal(assertValidIdempotencyKey(key), key);
    assert.throws(() => assertValidIdempotencyKey('short'));
    assert.throws(() => assertValidIdempotencyKey('invalid key with spaces'));
    assert.throws(() => assertValidIdempotencyKey('x'.repeat(129)));
  });

  it('accepts positive safe integer cents only', () => {
    assert.equal(assertAmountCents(100), 100);
    for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      assert.throws(() => assertAmountCents(amount));
    }
  });

  it('uses capped exponential backoff for webhook retries', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(attempt => webhookRetryDelayMs(attempt)),
      [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000]);
    assert.equal(webhookRetryDelayMs(20), 3_600_000);
    assert.throws(() => webhookRetryDelayMs(0));
  });

  it('defers inbox retries only until a valid future timestamp', () => {
    assert.equal(webhookRetryAfterSeconds('2026-10-10T12:01:00.000Z', Date.parse('2026-10-10T12:00:10.000Z')), 50);
    assert.equal(webhookRetryAfterSeconds('2026-10-10T12:00:00.000Z', Date.parse('2026-10-10T12:00:10.000Z')), 0);
    assert.equal(webhookRetryAfterSeconds('invalid', Date.parse('2026-10-10T12:00:10.000Z')), 0);
    assert.equal(webhookRetryAfterSeconds(null, Date.parse('2026-10-10T12:00:10.000Z')), 0);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asaasStatus, isDefinitiveAsaasCreateRejection, normalizeAsaasPaymentStatus, selectUniqueAsaasPayment } from './asaas-config.ts';

describe('Asaas payment status mapping', () => {
  it('keeps receipt and settlement distinct', () => {
    assert.equal(asaasStatus('RECEIVED'), 'paid');
    assert.equal(asaasStatus('CONFIRMED'), 'processing');
  });

  it('maps the documented operational statuses explicitly', () => {
    assert.equal(asaasStatus('PENDING'), 'pending');
    assert.equal(asaasStatus('OVERDUE'), 'overdue');
    assert.equal(asaasStatus('DELETED'), 'cancelled');
    assert.equal(asaasStatus('REFUND_REQUESTED'), 'refund_pending');
    assert.equal(asaasStatus('REFUND_IN_PROGRESS'), 'refund_pending');
    assert.equal(asaasStatus('REFUNDED'), 'refunded');
  });

  it('does not treat manual cash marking or risk events as settled receipts', () => {
    assert.equal(asaasStatus('RECEIVED_IN_CASH'), 'under_review');
    assert.equal(asaasStatus('AWAITING_RISK_ANALYSIS'), 'under_review');
    assert.equal(asaasStatus('CHARGEBACK_DISPUTE'), 'under_review');
    assert.equal(asaasStatus('PAYMENT_PARTIALLY_REFUNDED'), 'under_review');
  });

  it('normalizes provider states into the neutral Payment Core taxonomy', () => {
    assert.equal(normalizeAsaasPaymentStatus('PENDING'), 'PENDING');
    assert.equal(normalizeAsaasPaymentStatus('CONFIRMED'), 'PROCESSING');
    assert.equal(normalizeAsaasPaymentStatus('RECEIVED'), 'SUCCEEDED');
    assert.equal(normalizeAsaasPaymentStatus('REFUND_IN_PROGRESS'), 'REFUND_PENDING');
    assert.equal(normalizeAsaasPaymentStatus('PAYMENT_PARTIALLY_REFUNDED'), 'PARTIALLY_REFUNDED');
    assert.equal(normalizeAsaasPaymentStatus('RECEIVED_IN_CASH'), 'UNDER_REVIEW');
    assert.equal(normalizeAsaasPaymentStatus('OVERDUE'), 'UNDER_REVIEW');
  });

  it('keeps Asaas receipt, refund, risk, and unsupported states distinct and conservative', () => {
    const cases = new Map<string, string>([
      ['PENDING', 'PENDING'], ['CONFIRMED', 'PROCESSING'], ['RECEIVED', 'SUCCEEDED'],
      ['REFUND_REQUESTED', 'REFUND_PENDING'], ['REFUND_IN_PROGRESS', 'REFUND_PENDING'],
      ['REFUNDED', 'REFUNDED'], ['PARTIALLY_REFUNDED', 'PARTIALLY_REFUNDED'],
      ['PAYMENT_PARTIALLY_REFUNDED', 'PARTIALLY_REFUNDED'], ['DELETED', 'CANCELED'],
      ['OVERDUE', 'UNDER_REVIEW'], ['RECEIVED_IN_CASH', 'UNDER_REVIEW'],
      ['AWAITING_RISK_ANALYSIS', 'UNDER_REVIEW'], ['CHARGEBACK_DISPUTE', 'UNDER_REVIEW'],
      ['PAYMENT_RESTORED', 'UNDER_REVIEW'], ['NEW_PROVIDER_STATE', 'UNDER_REVIEW'],
    ]);
    for (const [raw, expected] of cases) assert.equal(normalizeAsaasPaymentStatus(raw), expected, raw);
    assert.notEqual(normalizeAsaasPaymentStatus('RECEIVED'), 'SETTLED');
  });

  it('fails closed for unknown or malformed provider statuses', () => {
    assert.equal(asaasStatus('NEW_PROVIDER_STATE'), 'under_review');
    assert.equal(asaasStatus(null), 'under_review');
    assert.equal(asaasStatus(''), 'under_review');
  });

  it('marks only definite HTTP create rejections as failed, preserving ambiguous outcomes for recovery', () => {
    for (const status of [400, 401, 403, 422, 499]) assert.equal(isDefinitiveAsaasCreateRejection(status), true);
    for (const status of [408, 409, 425, 429, 500, 503, 200, NaN, '400', null]) {
      assert.equal(isDefinitiveAsaasCreateRejection(status), false, String(status));
    }
  });

  it('recovers only one exact external-reference match and refuses ambiguous results', () => {
    const matching = { id: 'pay_1', externalReference: 'tx_123' };
    assert.equal(selectUniqueAsaasPayment([matching, { id: 'other', externalReference: 'tx_456' }], 'tx_123'), matching);
    assert.equal(selectUniqueAsaasPayment([], 'tx_123'), null);
    assert.equal(selectUniqueAsaasPayment({ data: [matching] }, 'tx_123'), null);
    assert.throws(() => selectUniqueAsaasPayment([
      matching, { id: 'pay_2', externalReference: 'tx_123' },
    ], 'tx_123'), /asaas_payment_search_ambiguous/);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReconciliationPlan } from './reconciliation-run.ts';

const payment = {
  transactionId: 'internal-1', businessId: 'business-1', ownerId: 'owner-1',
  providerTransactionId: 'pay-1', status: 'paid', testMode: false,
  grossAmountCents: 10_000, receiptLedgerCents: 10_000,
  expectedProviderFeeCents: 100, appliedMerchantFeeCents: 99,
};
const credit = {
  externalEntryId: 'entry-1', providerTransactionId: 'pay-1', kind: 'payment_credit' as const,
  direction: 'credit' as const, amountCents: 10_000,
};
const fee = {
  externalEntryId: 'entry-2', providerTransactionId: 'pay-1', kind: 'payment_fee' as const,
  direction: 'debit' as const, amountCents: 100,
};

test('reconciliation run planning', async t => {
  await t.test('compares every internal payment and keeps unmatched provider lines visible', () => {
    const plan = buildReconciliationPlan([payment], [credit, fee, {
      ...credit, externalEntryId: 'orphan-entry', providerTransactionId: 'external-payment',
    }, { ...credit, externalEntryId: 'unlinked-entry', providerTransactionId: '' }], true);
    assert.equal(plan.comparisons.length, 1);
    assert.equal(plan.comparisons[0].result.matched, true);
    assert.equal(plan.comparisons[0].result.expectedMerchantNetCents, 9_901);
    assert.deepEqual(plan.exceptions.map(row => row.issueCode), [
      'unmatched_statement_entry', 'unlinked_provider_entry',
    ]);
  });

  await t.test('a missing credit remains a divergence, not an exception hidden by the run', () => {
    const plan = buildReconciliationPlan([payment], [fee], true);
    assert.equal(plan.comparisons[0].result.matched, false);
    assert.ok(plan.comparisons[0].result.issues.includes('missing_provider_credit'));
    assert.equal(plan.exceptions.length, 0);
  });

  await t.test('unknown adverse entries remain attached to their payment comparison', () => {
    const plan = buildReconciliationPlan([payment], [credit, fee, {
      externalEntryId: 'reversal', providerTransactionId: 'pay-1', kind: 'other',
      direction: 'debit', amountCents: 10_000,
    }], true);
    assert.ok(plan.comparisons[0].result.issues.includes('adverse_provider_entry'));
    assert.equal(plan.exceptions.length, 0);
  });

  await t.test('one provider payment cannot settle multiple internal transactions', () => {
    const second = { ...payment, transactionId: 'internal-2' };
    const plan = buildReconciliationPlan([payment, second], [credit, fee], true);
    assert.equal(plan.comparisons.every(row => !row.result.matched), true);
    assert.equal(plan.comparisons.every(row => row.result.issues.includes('duplicate_internal_provider_reference')), true);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePayment, type PaymentExpectation, type ProviderStatementLine } from './reconciliation-core.ts';

const payment: PaymentExpectation = {
  transactionId: 'internal-1', providerTransactionId: 'provider-1', status: 'paid',
  testMode: false, grossAmountCents: 10_000, receiptLedgerCents: 10_000,
  expectedProviderFeeCents: 150,
  appliedMerchantFeeCents: 300,
};
const statement: ProviderStatementLine[] = [
  { externalEntryId: 'credit-1', providerTransactionId: 'provider-1', kind: 'payment_credit', direction: 'credit', amountCents: 10_000 },
  { externalEntryId: 'fee-1', providerTransactionId: 'provider-1', kind: 'payment_fee', direction: 'debit', amountCents: 150 },
];

describe('provider-neutral payment reconciliation', () => {
  it('matches only a complete, exact production payment and never mutates inputs', () => {
    const result = reconcilePayment(payment, statement, true);
    assert.deepEqual(result, {
      transactionId: 'internal-1', issues: [], providerCreditCents: 10_000,
      providerFeeCents: 150, expectedMerchantNetCents: 9_700, matched: true,
    });
    assert.equal(payment.receiptLedgerCents, 10_000);
    assert.equal(statement.length, 2);
  });

  it('refuses to match an incomplete statement even when visible lines agree', () => {
    const result = reconcilePayment(payment, statement, false);
    assert.equal(result.matched, false);
    assert.equal(result.expectedMerchantNetCents, null);
    assert.ok(result.issues.includes('statement_incomplete'));
  });

  it('detects missing, duplicated, or mismatched provider credits', () => {
    assert.ok(reconcilePayment(payment, statement.slice(1), true).issues.includes('missing_provider_credit'));
    assert.ok(reconcilePayment(payment, [...statement, { ...statement[0], externalEntryId: 'credit-2' }], true)
      .issues.includes('duplicate_provider_credit'));
    assert.ok(reconcilePayment(payment, [{ ...statement[0], amountCents: 9_999 }], true)
      .issues.includes('gross_amount_mismatch'));
  });

  it('detects reused or absent statement identifiers', () => {
    assert.ok(reconcilePayment(payment, [statement[0], { ...statement[1], externalEntryId: 'credit-1' }], true)
      .issues.includes('duplicate_statement_entry'));
    assert.ok(reconcilePayment(payment, [{ ...statement[0], externalEntryId: '' }], true)
      .issues.includes('duplicate_statement_entry'));
  });

  it('never treats sandbox, unpaid, unpriced, or ledger-mismatched payments as settled', () => {
    const cases: [Partial<PaymentExpectation>, string][] = [
      [{ testMode: true }, 'sandbox_transaction'],
      [{ status: 'pending' }, 'payment_not_confirmed'],
      [{ appliedMerchantFeeCents: null }, 'merchant_fee_unconfigured'],
      [{ expectedProviderFeeCents: null }, 'provider_fee_unverified'],
      [{ receiptLedgerCents: 9_999 }, 'receipt_ledger_mismatch'],
      [{ providerTransactionId: '' }, 'invalid_provider_reference'],
    ];
    for (const [change, issue] of cases) {
      const result = reconcilePayment({ ...payment, ...change }, statement, true);
      assert.equal(result.matched, false);
      assert.ok(result.issues.includes(issue as typeof result.issues[number]));
    }
  });

  it('rejects invalid cents, overflowing fees, and fees greater than gross', () => {
    assert.ok(reconcilePayment({ ...payment, grossAmountCents: 0 }, statement, true).issues.includes('invalid_amount'));
    assert.ok(reconcilePayment({ ...payment, appliedMerchantFeeCents: payment.grossAmountCents }, statement, true)
      .issues.includes('invalid_amount'));
    assert.ok(reconcilePayment(payment, [{ ...statement[0], amountCents: 10_000.5 }], true)
      .issues.includes('invalid_amount'));
    assert.ok(reconcilePayment(payment, [statement[0], { ...statement[1], amountCents: 10_001 }], true)
      .issues.includes('provider_fee_exceeds_gross'));
    assert.ok(reconcilePayment(payment, [statement[0]], true).issues.includes('provider_fee_mismatch'));
    assert.ok(reconcilePayment(payment, [...statement,
      { externalEntryId: 'refund-1', providerTransactionId: 'provider-1', kind: 'other', direction: 'debit', amountCents: 1_000 },
    ], true).issues.includes('adverse_provider_entry'));
    assert.ok(reconcilePayment(payment, [statement[0],
      { ...statement[1], amountCents: Number.MAX_SAFE_INTEGER },
      { ...statement[1], externalEntryId: 'fee-2', amountCents: 1 },
    ], true).issues.includes('invalid_amount'));
  });
});

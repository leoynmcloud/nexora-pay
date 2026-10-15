/** Provider-neutral comparison. This module never moves ledger balances. */
export type PaymentExpectation = {
  transactionId: string;
  providerTransactionId: string;
  status: string;
  testMode: boolean;
  grossAmountCents: number;
  /** Immutable original pending credit for the payment.received journal. */
  receiptLedgerCents: number;
  /** Fee derived from the verified provider payment detail (gross - net). */
  expectedProviderFeeCents: number | null;
  /** The fee actually fixed on this sale by the merchant pricing rule. */
  appliedMerchantFeeCents: number | null;
};

export type ProviderStatementLine = {
  externalEntryId: string;
  providerTransactionId: string;
  kind: 'payment_credit' | 'payment_fee' | 'other';
  direction: 'credit' | 'debit';
  providerEntryType?: string;
  providerDate?: string;
  /** Absolute value in integer cents. The kind carries the direction. */
  amountCents: number;
};

export type ReconciliationIssue =
  | 'statement_incomplete' | 'payment_not_confirmed' | 'sandbox_transaction'
  | 'missing_provider_credit' | 'duplicate_provider_credit'
  | 'invalid_provider_reference' | 'duplicate_statement_entry' | 'gross_amount_mismatch'
  | 'receipt_ledger_mismatch' | 'merchant_fee_unconfigured'
  | 'invalid_amount' | 'provider_fee_exceeds_gross' | 'provider_fee_unverified'
  | 'provider_fee_mismatch' | 'adverse_provider_entry' | 'duplicate_internal_provider_reference';

export type ReconciliationResult = {
  transactionId: string;
  issues: ReconciliationIssue[];
  providerCreditCents: number | null;
  providerFeeCents: number | null;
  expectedMerchantNetCents: number | null;
  /** A matched comparison is only evidence for a later, separately authorized settlement step. */
  matched: boolean;
};

const validCents = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function reconcilePayment(
  payment: PaymentExpectation,
  statementLines: readonly ProviderStatementLine[],
  statementComplete: boolean,
): ReconciliationResult {
  const issues: ReconciliationIssue[] = [];
  const add = (issue: ReconciliationIssue) => { if (!issues.includes(issue)) issues.push(issue); };
  const relevant = statementLines.filter(line => line.providerTransactionId === payment.providerTransactionId);
  const credits = relevant.filter(line => line.kind === 'payment_credit');
  const fees = relevant.filter(line => line.kind === 'payment_fee');
  if (relevant.some(line => line.kind === 'other')) add('adverse_provider_entry');

  if (!statementComplete) add('statement_incomplete');
  if (payment.status !== 'paid') add('payment_not_confirmed');
  if (payment.testMode) add('sandbox_transaction');
  if (!payment.providerTransactionId.trim()) add('invalid_provider_reference');
  if (!validCents(payment.grossAmountCents) || payment.grossAmountCents === 0
    || !validCents(payment.receiptLedgerCents)
    || (payment.expectedProviderFeeCents !== null && !validCents(payment.expectedProviderFeeCents))
    || (payment.appliedMerchantFeeCents !== null && !validCents(payment.appliedMerchantFeeCents))
    || relevant.some(line => !validCents(line.amountCents)
      || (line.kind === 'payment_credit' && line.direction !== 'credit')
      || (line.kind === 'payment_fee' && line.direction !== 'debit'))) add('invalid_amount');

  if (credits.length === 0) add('missing_provider_credit');
  if (credits.length > 1) add('duplicate_provider_credit');
  if (relevant.some(line => !line.externalEntryId.trim())
    || new Set(relevant.map(line => line.externalEntryId)).size !== relevant.length) add('duplicate_statement_entry');

  const providerCreditCents = credits.length === 1 && validCents(credits[0].amountCents)
    ? credits[0].amountCents : null;
  const feeTotal = fees.reduce((total, line) => total + line.amountCents, 0);
  const providerFeeCents = fees.every(line => validCents(line.amountCents)) && validCents(feeTotal)
    ? feeTotal : null;
  if (providerFeeCents === null) add('invalid_amount');
  if (providerCreditCents !== null && providerCreditCents !== payment.grossAmountCents) add('gross_amount_mismatch');
  if (payment.receiptLedgerCents !== payment.grossAmountCents) add('receipt_ledger_mismatch');
  if (payment.appliedMerchantFeeCents === null) add('merchant_fee_unconfigured');
  if (payment.expectedProviderFeeCents === null) add('provider_fee_unverified');
  if (providerFeeCents !== null && payment.expectedProviderFeeCents !== null
    && providerFeeCents !== payment.expectedProviderFeeCents) add('provider_fee_mismatch');
  if (providerFeeCents !== null && providerFeeCents > payment.grossAmountCents) add('provider_fee_exceeds_gross');
  if (payment.appliedMerchantFeeCents !== null && payment.appliedMerchantFeeCents >= payment.grossAmountCents) {
    add('invalid_amount');
  }

  return {
    transactionId: payment.transactionId,
    issues,
    providerCreditCents,
    providerFeeCents,
    expectedMerchantNetCents: issues.length === 0
      ? payment.grossAmountCents - payment.appliedMerchantFeeCents! : null,
    matched: issues.length === 0,
  };
}

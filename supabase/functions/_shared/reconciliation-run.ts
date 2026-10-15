import { reconcilePayment, type PaymentExpectation, type ProviderStatementLine } from './reconciliation-core.ts';

export type ReconciliationSnapshot = PaymentExpectation & {
  businessId: string;
  ownerId: string;
};

export function buildReconciliationPlan(
  payments: readonly ReconciliationSnapshot[],
  statementLines: readonly ProviderStatementLine[],
  statementComplete: boolean,
) {
  const byReference = new Map<string, ReconciliationSnapshot[]>();
  for (const payment of payments) {
    const list = byReference.get(payment.providerTransactionId) || [];
    list.push(payment);
    byReference.set(payment.providerTransactionId, list);
  }

  const comparisons = payments.map(payment => {
    const lines = payment.providerTransactionId
      ? statementLines.filter(line => line.providerTransactionId === payment.providerTransactionId)
      : [];
    const result = reconcilePayment(payment, lines, statementComplete);
    if (payment.providerTransactionId && (byReference.get(payment.providerTransactionId)?.length || 0) > 1) {
      result.issues.push('duplicate_internal_provider_reference');
      result.matched = false;
      result.expectedMerchantNetCents = null;
    }
    return { payment, lines, result };
  });

  const exceptions = statementLines.filter(line => {
    if (!line.providerTransactionId) return true;
    return !byReference.has(line.providerTransactionId);
  }).map(line => ({
    line,
    issueCode: line.providerTransactionId ? 'unmatched_statement_entry' as const : 'unlinked_provider_entry' as const,
  }));

  return { comparisons, exceptions };
}

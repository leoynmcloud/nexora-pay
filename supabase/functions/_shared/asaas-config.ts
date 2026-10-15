import type { CorePaymentStatus } from './payment-provider.ts';

export type AsaasEnvironment = 'production' | 'sandbox';

export function asaasConfiguration(environment: unknown) {
  if (environment === 'production') return { environment: 'production' as const, code: 'asaas_production', baseUrl: 'https://api.asaas.com/v3', keyPrefix: '$aact_prod_', label: 'Asaas · produção' };
  if (environment === 'sandbox') return { environment: 'sandbox' as const, code: 'asaas_sandbox', baseUrl: 'https://api-sandbox.asaas.com/v3', keyPrefix: '$aact_hmlg_', label: 'Asaas · testes' };
  throw new Error('provider_environment_invalid');
}

export function asaasAcquirerMatches(acquirer: { environment?: unknown; code?: unknown; api_base_url?: unknown; status?: unknown }) {
  try {
    const config = asaasConfiguration(acquirer.environment);
    return acquirer.code === config.code && acquirer.api_base_url === config.baseUrl && acquirer.status === 'enabled';
  } catch { return false; }
}

export type AsaasPaymentStatus =
  | 'pending' | 'processing' | 'paid' | 'cancelled' | 'refunded'
  | 'refund_pending' | 'under_review' | 'overdue';

/** Normalize Asaas API statuses into the provider-neutral Payment Core vocabulary. */
export function normalizeAsaasPaymentStatus(value: unknown): CorePaymentStatus {
  const status = typeof value === 'string' ? value.trim().toUpperCase() : '';
  const known: Record<string, CorePaymentStatus> = {
    PENDING: 'PENDING',
    CONFIRMED: 'PROCESSING',
    RECEIVED: 'SUCCEEDED',
    REFUND_REQUESTED: 'REFUND_PENDING',
    REFUND_IN_PROGRESS: 'REFUND_PENDING',
    REFUNDED: 'REFUNDED',
    PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
    PAYMENT_PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
    DELETED: 'CANCELED',
    // Overdue charges can still be paid; do not claim expiration without a
    // provider state that explicitly means the payment can no longer succeed.
    OVERDUE: 'UNDER_REVIEW',
    // Manual receipt, risk analysis and chargeback states never imply funds.
    RECEIVED_IN_CASH: 'UNDER_REVIEW',
    AWAITING_RISK_ANALYSIS: 'UNDER_REVIEW',
    CHARGEBACK_REQUESTED: 'UNDER_REVIEW',
    CHARGEBACK_DISPUTE: 'UNDER_REVIEW',
    AWAITING_CHARGEBACK_REVERSAL: 'UNDER_REVIEW',
    PAYMENT_RESTORED: 'UNDER_REVIEW',
    RESTORED: 'UNDER_REVIEW',
  };
  return known[status] || 'UNDER_REVIEW';
}

/** Map known Asaas payment states to the existing persistence contract. Unknown states fail closed. */
export function asaasStatus(value: unknown): AsaasPaymentStatus {
  const status = typeof value === 'string' ? value.trim().toUpperCase() : '';
  const known: Record<string, AsaasPaymentStatus> = {
    PENDING: 'pending',
    CONFIRMED: 'processing',
    RECEIVED: 'paid',
    OVERDUE: 'overdue',
    DELETED: 'cancelled',
    REFUND_REQUESTED: 'refund_pending',
    REFUND_IN_PROGRESS: 'refund_pending',
    REFUNDED: 'refunded',
    AWAITING_RISK_ANALYSIS: 'under_review',
    CHARGEBACK_REQUESTED: 'under_review',
    CHARGEBACK_DISPUTE: 'under_review',
    AWAITING_CHARGEBACK_REVERSAL: 'under_review',
    // Asaas documents this as a manual record; it does not credit provider balance.
    RECEIVED_IN_CASH: 'under_review',
    // The current database status contract has no partial-refund/restoration state.
    PAYMENT_PARTIALLY_REFUNDED: 'under_review',
    PARTIALLY_REFUNDED: 'under_review',
    PAYMENT_RESTORED: 'under_review',
    RESTORED: 'under_review',
  };
  return known[status] || 'under_review';
}

export function assertPaymentIdentity(payment: Record<string, unknown>, expected: { external_reference: string; provider_reference?: string | null; amount: number }) {
  if (!payment.id || payment.externalReference !== expected.external_reference
    || (expected.provider_reference && payment.id !== expected.provider_reference)
    || payment.billingType !== 'PIX' || !Number.isFinite(Number(payment.value))
    || Math.round(Number(payment.value) * 100) !== Math.round(expected.amount * 100)) {
    throw new Error('provider_payment_identity_mismatch');
  }
}

/** HTTP failures that may still hide an accepted write are never classified as definitive. */
export function isDefinitiveAsaasCreateRejection(status: unknown): boolean {
  if (!Number.isSafeInteger(status) || typeof status !== 'number' || status < 400 || status >= 500) return false;
  return ![408, 409, 425, 429].includes(status);
}

/** Select a payment only when its external reference identifies one exact provider record. */
export function selectUniqueAsaasPayment(rows: unknown, externalReference: string): Record<string, unknown> | null {
  if (!Array.isArray(rows) || !externalReference) return null;
  const matches = rows.filter((row): row is Record<string, unknown> =>
    row !== null && typeof row === 'object' && !Array.isArray(row)
      && (row as Record<string, unknown>).externalReference === externalReference);
  if (matches.length > 1) throw new Error('asaas_payment_search_ambiguous');
  return matches[0] || null;
}

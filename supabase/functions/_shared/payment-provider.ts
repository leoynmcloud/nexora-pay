/**
 * Contrato interno neutro de adquirente.
 * Não é um conector de produção: cada IP exige implementação e testes próprios.
 * O chamador deve gravar a chave idempotente antes de enviar qualquer operação.
 */

/** Public checkout methods are capabilities, not assumptions: expose only what an adapter enables. */
export type PaymentMethod = 'pix' | 'credit_card' | 'debit_card' | 'apple_pay' | 'boleto';
export type CorePaymentStatus =
  | 'CREATED' | 'PENDING' | 'PROCESSING' | 'AUTHORIZED' | 'SUCCEEDED'
  | 'SETTLED' | 'FAILED' | 'CANCELED' | 'EXPIRED' | 'REFUND_PENDING' | 'REFUNDED'
  | 'PARTIALLY_REFUNDED' | 'REVERSED' | 'UNDER_REVIEW';
export type CoreWithdrawalStatus =
  | 'CREATED' | 'RISK_REVIEW' | 'APPROVED' | 'BALANCE_RESERVED'
  | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'FAILED' | 'BLOCKED' | 'REVERSED';

/**
 * Nexora keeps a separate internal ledger for each merchant even when the
 * acquirer settles funds into a single platform account. This is not an
 * acquirer subaccount and must never be inferred from a provider balance.
 */
export interface MerchantSettlementRoute {
  businessId: string;
  ledgerAccountId: string;
  settlementModel: 'platform_balance';
}

export interface ProviderChargeRequest {
  /** Integer cents; never a floating-point currency amount. */
  amountCents: number;
  currency: 'BRL';
  internalTransactionId: string;
  idempotencyKey: string;
  /** Internal allocation target; provider credentials stay in the server-side adapter. */
  merchantRoute: MerchantSettlementRoute;
  /** Omitted for hosted checkout; the payer chooses from the adapter's enabled methods. */
  paymentMethod?: PaymentMethod;
  description: string;
  customer?: { name?: string; email?: string; document?: string };
  returnUrls?: { success: string; cancel: string; expired: string };
}

export interface ProviderChargeResult {
  providerTransactionId: string;
  status: CorePaymentStatus;
  amountCents: number;
  /** Hosted URL for the payer. The payer does not need a Nexora account. */
  checkoutUrl?: string;
  checkoutId?: string;
  availableMethods?: readonly PaymentMethod[];
  expiresAt?: string;
  pixCopyPaste?: string;
  qrCodeBase64?: string;
  rawStatusCode?: string;
}

export interface ProviderRefundRequest {
  providerTransactionId: string;
  amountCents?: number;
  idempotencyKey: string;
}

export interface ProviderPayoutRequest {
  amountCents: number;
  currency: 'BRL';
  internalTransactionId: string;
  idempotencyKey: string;
  /** A payout is allowed only after the internal ledger has reserved this merchant's balance. */
  merchantRoute: MerchantSettlementRoute;
  destination:
    | { type: 'pix_key'; key: string; keyType: 'cpf' | 'cnpj' | 'email' | 'phone' | 'random' }
    | { type: 'bank_account'; bankCode: string; branch: string; account: string; accountDigit?: string; accountType: 'checking' | 'savings' };
}

export interface ProviderBalance {
  /** Amount available for transfer now, in integer BRL cents. */
  availableCents: number;
  /** Settled/held amounts are reported separately and must not be shown as withdrawable. */
  pendingCents?: number;
  currency: 'BRL';
  checkedAt: string;
}

export interface ProviderCapabilities {
  checkoutMethods: readonly PaymentMethod[];
  refunds: boolean;
  payouts: readonly ('pix' | 'bank_transfer')[];
  balanceInquiry: boolean;
  settlementWebhooks: boolean;
}

export interface NormalizedWebhookEvent {
  eventId: string;
  eventType: string;
  providerTransactionId: string;
  status: CorePaymentStatus | CoreWithdrawalStatus;
  /** True only when the provider confirms funds are settled/available, not merely authorized. */
  fundsSettled?: boolean;
  amountCents?: number;
  occurredAt?: string;
}

export interface ProviderHealth {
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';
  latencyMs?: number;
  checkedAt: string;
}

export class ProviderOutcomeUnknownError extends Error {
  readonly code = 'PROVIDER_OUTCOME_UNKNOWN';
  readonly outcome = 'unknown';
  constructor() {
    super('Provider response was not received. Query the original operation before retrying.');
    this.name = 'ProviderOutcomeUnknownError';
  }
}

export interface PaymentProviderAdapter {
  readonly code: string;
  readonly capabilities: ProviderCapabilities;
  /** Create a hosted checkout. The adapter must reject methods it does not explicitly support. */
  createCheckout(request: ProviderChargeRequest): Promise<ProviderChargeResult>;
  getCheckout(providerCheckoutId: string): Promise<ProviderChargeResult>;
  getBalance?(): Promise<ProviderBalance>;
  refund?(request: ProviderRefundRequest): Promise<{ providerRefundId: string; status: CorePaymentStatus }>;
  createPayout?(request: ProviderPayoutRequest): Promise<{ providerTransactionId: string; status: CoreWithdrawalStatus }>;
  getPayout?(providerTransactionId: string): Promise<{ providerTransactionId: string; status: CoreWithdrawalStatus }>;
  /** Verify provider-specific signature/timestamp against the exact raw body before normalization. */
  verifyAndNormalizeWebhook(headers: Headers, rawBody: Uint8Array): Promise<NormalizedWebhookEvent>;
  healthCheck(): Promise<ProviderHealth>;
}

export function assertValidIdempotencyKey(value: string): string {
  const key = value.trim();
  if (key.length < 16 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new Error('Invalid idempotency key');
  }
  return key;
}

export function assertAmountCents(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 999_999_999_999) {
    throw new Error('Amount must be a positive integer number of BRL cents');
  }
  return value;
}

/** A network timeout is ambiguous: the provider may have accepted the request. Never auto-retry it. */
export async function fetchProvider(input: RequestInfo | URL, init: RequestInit, timeoutMs = 10_000, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('Provider timeout must be between 1000 and 60000 milliseconds');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal;
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch {
    throw new ProviderOutcomeUnknownError();
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

function normalizedProviderStatus(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase().replace(/[ .-]+/g, '_') : '';
}

/** Generic fallback only; a concrete provider adapter must override ambiguous provider-specific meanings. */
export function normalizePaymentStatus(raw: unknown): CorePaymentStatus {
  const status = normalizedProviderStatus(raw);
  const known: Record<string, CorePaymentStatus> = {
    CREATED: 'CREATED', NEW: 'CREATED',
    PENDING: 'PENDING', WAITING: 'PENDING', WAITING_PAYMENT: 'PENDING',
    PROCESSING: 'PROCESSING', IN_PROGRESS: 'PROCESSING',
    AUTHORIZED: 'AUTHORIZED', APPROVED: 'AUTHORIZED',
    SUCCEEDED: 'SUCCEEDED', SUCCESS: 'SUCCEEDED', PAID: 'SUCCEEDED', COMPLETED: 'SUCCEEDED',
    RECEIVED: 'SUCCEEDED',
    SETTLED: 'SETTLED',
    FAILED: 'FAILED', FAILURE: 'FAILED', DECLINED: 'FAILED', REJECTED: 'FAILED',
    CANCELED: 'CANCELED', CANCELLED: 'CANCELED', EXPIRED: 'EXPIRED',
    REFUND_PENDING: 'REFUND_PENDING', REFUND_PROCESSING: 'REFUND_PENDING',
    REFUND_REQUESTED: 'REFUND_PENDING', REFUND_IN_PROGRESS: 'REFUND_PENDING',
    REFUNDED: 'REFUNDED', PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
    PARTIAL_REFUND: 'PARTIALLY_REFUNDED',
    REVERSED: 'REVERSED',
    CHARGEBACK: 'UNDER_REVIEW', CHARGEBACK_OPEN: 'UNDER_REVIEW',
    CHARGEBACK_DISPUTE: 'UNDER_REVIEW', UNDER_REVIEW: 'UNDER_REVIEW',
    AWAITING_RISK_ANALYSIS: 'UNDER_REVIEW', AWAITING_CHARGEBACK_REVERSAL: 'UNDER_REVIEW',
  };
  return known[status] || 'UNDER_REVIEW';
}

export function normalizeWithdrawalStatus(raw: unknown): CoreWithdrawalStatus {
  const status = normalizedProviderStatus(raw);
  const known: Record<string, CoreWithdrawalStatus> = {
    CREATED: 'CREATED', NEW: 'CREATED', PENDING: 'RISK_REVIEW', RISK_REVIEW: 'RISK_REVIEW',
    APPROVED: 'APPROVED', BALANCE_RESERVED: 'BALANCE_RESERVED',
    PROCESSING: 'PROCESSING', IN_PROGRESS: 'PROCESSING',
    COMPLETED: 'COMPLETED', SUCCEEDED: 'COMPLETED', SUCCESS: 'COMPLETED', PAID: 'COMPLETED',
    REJECTED: 'REJECTED', FAILED: 'FAILED', CANCELED: 'FAILED', CANCELLED: 'FAILED',
    BLOCKED: 'BLOCKED', REVERSED: 'REVERSED',
  };
  return known[status] || 'RISK_REVIEW';
}

export function webhookRetryDelayMs(attempt: number, baseMs = 60_000, maxMs = 3_600_000): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Attempt must be a positive integer');
  if (!Number.isSafeInteger(baseMs) || baseMs < 1 || !Number.isSafeInteger(maxMs) || maxMs < baseMs) {
    throw new Error('Invalid webhook retry bounds');
  }
  return Math.min(baseMs * (2 ** Math.min(attempt - 1, 30)), maxMs);
}

/** Seconds remaining until an inbox retry is eligible; invalid/past timestamps are immediately eligible. */
export function webhookRetryAfterSeconds(nextAttemptAt: unknown, nowMs = Date.now()): number {
  if (typeof nextAttemptAt !== 'string' || !Number.isFinite(nowMs)) return 0;
  const retryAt = Date.parse(nextAttemptAt);
  return Number.isFinite(retryAt) ? Math.max(0, Math.ceil((retryAt - nowMs) / 1000)) : 0;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

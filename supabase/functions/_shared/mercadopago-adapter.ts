import {
  assertAmountCents,
  assertValidIdempotencyKey,
  fetchProvider,
  type CorePaymentStatus,
  type ProviderChargeRequest,
  type ProviderChargeResult,
} from './payment-provider.ts';
import { normalizeCheckoutPayer } from './hosted-checkout.ts';
import { isHostedCheckoutUrlTrusted } from './hosted-checkout-providers.ts';

const API_BASE = 'https://api.mercadopago.com';

function normalizedStatus(value: unknown): CorePaymentStatus {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const statuses: Record<string, CorePaymentStatus> = {
    pending: 'PENDING', in_process: 'PROCESSING', authorized: 'AUTHORIZED',
    approved: 'SUCCEEDED', rejected: 'FAILED', cancelled: 'CANCELED',
    refunded: 'REFUNDED', charged_back: 'UNDER_REVIEW',
  };
  return statuses[status] || 'UNDER_REVIEW';
}

/** Only an explicit provider 4xx response other than throttling proves rejection. */
export function isDefinitiveMercadoPagoCreateRejection(errorCode: unknown): boolean {
  if (typeof errorCode !== 'string') return false;
  const match = /^mercadopago_create_http_(4\d\d)$/.exec(errorCode);
  return Boolean(match && !['408', '409', '425', '429'].includes(match[1]));
}

function notificationUrlFromSupabase(supabaseUrl: string): string {
  const url = new URL(supabaseUrl);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error('mercadopago_notification_url_invalid');
  }
  return new URL('/functions/v1/nexora-mercadopago-webhook', url.origin).toString();
}

function payerData(request: ProviderChargeRequest) {
  let payer;
  try {
    payer = normalizeCheckoutPayer({ name: request.customer?.name, email: request.customer?.email, document: request.customer?.document });
  } catch { throw new Error('mercadopago_payer_invalid'); }
  if (!payer.email) throw new Error('mercadopago_payer_invalid');
  const nameParts = payer.name.split(/\s+/);
  const firstName = nameParts[0].slice(0, 80);
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ').slice(0, 80) : undefined;
  return {
    email: payer.email,
    ...(firstName ? { first_name: firstName } : {}),
    ...(lastName ? { last_name: lastName } : {}),
    identification: { type: payer.document.length === 11 ? 'CPF' : 'CNPJ', number: payer.document },
  };
}

function normalizePaymentResponse(payment: Record<string, unknown>, expected: { transactionId: string; amountCents: number }): ProviderChargeResult {
  const providerId = typeof payment.id === 'string' || typeof payment.id === 'number' ? String(payment.id) : '';
  const providerAmountCents = Math.round(Number(payment.transaction_amount) * 100);
  if (!providerId || payment.external_reference !== expected.transactionId
    || !Number.isSafeInteger(providerAmountCents) || providerAmountCents !== expected.amountCents) {
    throw new Error('mercadopago_payment_identity_mismatch');
  }
  const interaction = payment.point_of_interaction && typeof payment.point_of_interaction === 'object'
    ? payment.point_of_interaction as Record<string, unknown> : {};
  const transactionData = interaction.transaction_data && typeof interaction.transaction_data === 'object'
    ? interaction.transaction_data as Record<string, unknown> : {};
  const trustedTicketUrl = isHostedCheckoutUrlTrusted('mercadopago_production', transactionData.ticket_url) || undefined;
  const expiration = typeof payment.date_of_expiration === 'string' && Number.isFinite(Date.parse(payment.date_of_expiration))
    ? new Date(payment.date_of_expiration).toISOString() : undefined;
  return {
    providerTransactionId: providerId,
    status: normalizedStatus(payment.status),
    amountCents: expected.amountCents,
    ...(typeof transactionData.qr_code === 'string' ? { pixCopyPaste: transactionData.qr_code.slice(0, 5000) } : {}),
    ...(typeof transactionData.qr_code_base64 === 'string' ? { qrCodeBase64: transactionData.qr_code_base64.slice(0, 100_000) } : {}),
    ...(trustedTicketUrl ? { checkoutUrl: trustedTicketUrl } : {}),
    ...(expiration ? { expiresAt: expiration } : {}),
    rawStatusCode: typeof payment.status === 'string' ? payment.status.slice(0, 80) : undefined,
    availableMethods: ['pix'],
  };
}

async function readJsonBounded(response: Response, maximum = 128_000): Promise<Record<string, unknown>> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maximum) throw new Error('mercadopago_response_too_large');
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > maximum) throw new Error('mercadopago_response_too_large');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('mercadopago_response_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('mercadopago_response_invalid');
  return parsed as Record<string, unknown>;
}

/**
 * Creates a Mercado Pago Pix payment using a server-side token and the Nexora
 * transaction ID as external_reference. This module is deliberately not
 * registered as an enabled route until credential storage, webhook verification,
 * provider-operation persistence and reconciliation are deployed together.
 */
export async function createMercadoPagoPixPayment(
  accessToken: string,
  supabaseUrl: string,
  request: ProviderChargeRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderChargeResult> {
  if (!accessToken || accessToken.length > 4000 || !/^(APP_USR-|TEST-)/.test(accessToken)) {
    throw new Error('mercadopago_credential_invalid');
  }
  const amountCents = assertAmountCents(request.amountCents);
  const idempotencyKey = assertValidIdempotencyKey(request.idempotencyKey);
  if (request.currency !== 'BRL' || (request.paymentMethod && request.paymentMethod !== 'pix')) {
    throw new Error('mercadopago_payment_method_unsupported');
  }
  if (!request.internalTransactionId || request.internalTransactionId.length > 120) {
    throw new Error('mercadopago_transaction_identity_invalid');
  }
  const payer = payerData(request);
  const body = {
    transaction_amount: amountCents / 100,
    description: request.description.trim().slice(0, 250),
    payment_method_id: 'pix',
    external_reference: request.internalTransactionId,
    notification_url: notificationUrlFromSupabase(supabaseUrl),
    payer,
  };
  if (!body.description || body.description.length < 2) throw new Error('mercadopago_description_invalid');

  const response = await fetchProvider(`${API_BASE}/v1/payments`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Idempotency-Key': idempotencyKey,
      'User-Agent': 'NexoraPay/1.0 (Mercado Pago adapter)',
    },
    body: JSON.stringify(body),
  }, 12_000, fetchImpl);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(response.status === 429 ? 'mercadopago_rate_limited' : `mercadopago_create_http_${response.status}`);
  }
  return normalizePaymentResponse(await readJsonBounded(response), {
    transactionId: request.internalTransactionId, amountCents,
  });
}

export type MercadoPagoCardInput = {
  /** Single-use token produced in the browser by MercadoPago.js; raw card data never reaches Nexora. */
  token: string;
  installments: number;
  paymentMethodId: string;
  issuerId?: string;
  /** Ephemeral Mercado Pago device fingerprint; forwarded only as X-Meli-Session-Id. */
  deviceSessionId?: string;
};

/** Validates the browser-tokenized card intent without ever accepting PAN/CVV. */
export function parseMercadoPagoCardInput(input: Record<string, unknown>): MercadoPagoCardInput | null {
  const token = typeof input.card_token === 'string' ? input.card_token : '';
  const installments = Number(input.installments ?? 1);
  const paymentMethodId = typeof input.payment_method_id === 'string' ? input.payment_method_id : '';
  const issuer = input.issuer_id === undefined || input.issuer_id === null || input.issuer_id === ''
    ? undefined : String(input.issuer_id);
  const rawDeviceSessionId = typeof input.device_session_id === 'string' ? input.device_session_id.trim() : '';
  // Treat the fingerprint as optional and untrusted. Reject control characters/header injection,
  // but do not block a valid card payment if the browser could not collect one.
  const deviceSessionId = rawDeviceSessionId.length <= 256 && /^[\x21-\x7E]+$/.test(rawDeviceSessionId)
    ? rawDeviceSessionId : undefined;
  if (!/^[A-Za-z0-9]{16,64}$/.test(token) || !Number.isInteger(installments) || installments < 1 || installments > 12
    || !/^[a-z0-9_]{2,30}$/.test(paymentMethodId) || (issuer !== undefined && !/^\d{1,10}$/.test(issuer))) return null;
  return { token, installments, paymentMethodId, ...(issuer ? { issuerId: issuer } : {}), ...(deviceSessionId ? { deviceSessionId } : {}) };
}

/** Creates a card payment from a MercadoPago.js token. Status is only trusted after webhook/re-fetch verification. */
export async function createMercadoPagoCardPayment(
  accessToken: string,
  supabaseUrl: string,
  request: ProviderChargeRequest,
  card: MercadoPagoCardInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderChargeResult> {
  if (!accessToken || accessToken.length > 4000 || !/^(APP_USR-|TEST-)/.test(accessToken)) {
    throw new Error('mercadopago_credential_invalid');
  }
  const amountCents = assertAmountCents(request.amountCents);
  const idempotencyKey = assertValidIdempotencyKey(request.idempotencyKey);
  if (request.currency !== 'BRL') throw new Error('mercadopago_payment_method_unsupported');
  if (!request.internalTransactionId || request.internalTransactionId.length > 120) {
    throw new Error('mercadopago_transaction_identity_invalid');
  }
  const body = {
    transaction_amount: amountCents / 100,
    token: card.token,
    description: request.description.trim().slice(0, 250),
    installments: card.installments,
    payment_method_id: card.paymentMethodId,
    ...(card.issuerId ? { issuer_id: Number(card.issuerId) } : {}),
    external_reference: request.internalTransactionId,
    notification_url: notificationUrlFromSupabase(supabaseUrl),
    payer: payerData(request),
  };
  if (!body.description || body.description.length < 2) throw new Error('mercadopago_description_invalid');
  const response = await fetchProvider(`${API_BASE}/v1/payments`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Idempotency-Key': idempotencyKey,
      'User-Agent': 'NexoraPay/1.0 (Mercado Pago adapter)',
      ...(card.deviceSessionId ? { 'X-Meli-Session-Id': card.deviceSessionId } : {}),
    },
    body: JSON.stringify(body),
  }, 20_000, fetchImpl);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('mercadopago_card_api_error', JSON.stringify({ status: response.status, body: detail.slice(0, 800) }));
    throw new Error(response.status === 429 ? 'mercadopago_rate_limited' : `mercadopago_create_http_${response.status}`);
  }
  return normalizePaymentResponse(await readJsonBounded(response), {
    transactionId: request.internalTransactionId, amountCents,
  });
}

/** Re-fetches an MP payment to verify the resource before any internal status/ledger transition. */
export async function getMercadoPagoPixPayment(
  accessToken: string,
  providerTransactionId: string,
  expectedInternalTransactionId: string,
  expectedAmountCents: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderChargeResult> {
  const amountCents = assertAmountCents(expectedAmountCents);
  if (!/^\d{1,32}$/.test(providerTransactionId) || !expectedInternalTransactionId || expectedInternalTransactionId.length > 120) {
    throw new Error('mercadopago_transaction_identity_invalid');
  }
  const inspected = await inspectMercadoPagoPixPayment(accessToken,providerTransactionId,fetchImpl);
  if (inspected.externalReference !== expectedInternalTransactionId || inspected.amountCents !== amountCents) {
    throw new Error('mercadopago_payment_identity_mismatch');
  }
  return inspected.payment;
}

/**
 * Recovers an ambiguous create request by its unique Nexora external reference.
 * The API search is read-only; multiple matches fail closed to avoid selecting
 * or crediting one of potentially duplicated provider charges.
 */
export async function findMercadoPagoPixPaymentByReference(
  accessToken: string,
  externalReference: string,
  expectedAmountCents: number,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<ProviderChargeResult | null> {
  const amountCents = assertAmountCents(expectedAmountCents);
  if (!accessToken || accessToken.length > 4000 || !/^(APP_USR-|TEST-)[A-Za-z0-9_-]+$/.test(accessToken)) {
    throw new Error('mercadopago_credential_invalid');
  }
  if (!externalReference || externalReference.length > 255 || !/^[A-Za-z0-9_-]+$/.test(externalReference)
    || !Number.isFinite(nowMs)) throw new Error('mercadopago_transaction_identity_invalid');

  const end = new Date(nowMs);
  const begin = new Date(nowMs - 364 * 24 * 60 * 60 * 1000);
  const url = new URL(`${API_BASE}/v1/payments/search`);
  url.searchParams.set('sort', 'date_created');
  url.searchParams.set('criteria', 'desc');
  url.searchParams.set('external_reference', externalReference);
  url.searchParams.set('range', 'date_created');
  url.searchParams.set('begin_date', begin.toISOString());
  url.searchParams.set('end_date', end.toISOString());
  url.searchParams.set('limit', '2');
  url.searchParams.set('offset', '0');

  const response = await fetchProvider(url.toString(), {
    method: 'GET', redirect: 'error',
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, 'User-Agent': 'NexoraPay/1.0 (Mercado Pago adapter)' },
  }, 12_000, fetchImpl);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(response.status === 429 ? 'mercadopago_rate_limited' : `mercadopago_search_http_${response.status}`);
  }
  const result = await readJsonBounded(response);
  if (!Array.isArray(result.results)) throw new Error('mercadopago_search_response_invalid');
  const matches = result.results.filter((row: unknown) => row && typeof row === 'object' && !Array.isArray(row)
    && (row as Record<string, unknown>).external_reference === externalReference);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('mercadopago_search_ambiguous');
  const payment = matches[0] as Record<string, unknown>;
  if (payment.payment_method_id !== 'pix' && payment.payment_type_id !== 'credit_card') throw new Error('mercadopago_payment_method_mismatch');
  return normalizePaymentResponse(payment, { transactionId: externalReference, amountCents });
}

/** Retrieves a fixed-ID payment and returns only normalized, bounded fields plus its internal reference. */
export async function inspectMercadoPagoPixPayment(
  accessToken: string,
  providerTransactionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ externalReference: string; amountCents: number; payment: ProviderChargeResult }> {
  if (!accessToken || accessToken.length > 4000 || !/^(APP_USR-|TEST-)[A-Za-z0-9_-]+$/.test(accessToken)) {
    throw new Error('mercadopago_credential_invalid');
  }
  if (!/^\d{1,32}$/.test(providerTransactionId)) throw new Error('mercadopago_transaction_identity_invalid');
  const response = await fetchProvider(`${API_BASE}/v1/payments/${encodeURIComponent(providerTransactionId)}`, {
    method: 'GET', redirect: 'error',
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, 'User-Agent': 'NexoraPay/1.0 (Mercado Pago adapter)' },
  }, 12_000, fetchImpl);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(response.status === 429 ? 'mercadopago_rate_limited' : `mercadopago_get_http_${response.status}`);
  }
  const raw = await readJsonBounded(response);
  const externalReference = typeof raw.external_reference === 'string' ? raw.external_reference : '';
  const amountCents = Math.round(Number(raw.transaction_amount) * 100);
  if (!externalReference || externalReference.length > 255 || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error('mercadopago_payment_identity_mismatch');
  }
  const payment = normalizePaymentResponse(raw,{ transactionId: externalReference, amountCents });
  if (payment.providerTransactionId !== providerTransactionId) throw new Error('mercadopago_payment_identity_mismatch');
  return { externalReference, amountCents, payment };
}

/** Read-only fee verification for reconciliation; returns null for any unverified provider identity/state. */
export async function inspectMercadoPagoPixFeeCents(
  accessToken: string,
  providerTransactionId: string,
  expected: { transactionId: string; amountCents: number },
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  if (!accessToken || accessToken.length > 4000 || !/^APP_USR-[A-Za-z0-9_-]+$/.test(accessToken)
    || !/^\d{1,32}$/.test(providerTransactionId) || !expected.transactionId
    || !Number.isSafeInteger(expected.amountCents) || expected.amountCents <= 0) return null;
  let response: Response;
  try {
    response = await fetchProvider(`${API_BASE}/v1/payments/${encodeURIComponent(providerTransactionId)}`, {
      method: 'GET', redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, 'User-Agent': 'NexoraPay/1.0 (reconciliation)' },
    }, 12_000, fetchImpl);
  } catch { return null; }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  let payment: Record<string, unknown>;
  try { payment = await readJsonBounded(response); } catch { return null; }
  const amountCents = Math.round(Number(payment.transaction_amount) * 100);
  if (String(payment.id) !== providerTransactionId || payment.external_reference !== expected.transactionId
    || !Number.isSafeInteger(amountCents) || amountCents !== expected.amountCents
    || payment.payment_method_id !== 'pix' || payment.status !== 'approved'
    || !Array.isArray(payment.fee_details)) return null;
  let feeTotal = 0;
  for (const rawFee of payment.fee_details) {
    if (!rawFee || typeof rawFee !== 'object' || Array.isArray(rawFee)) return null;
    const amount = Number((rawFee as Record<string, unknown>).amount);
    const scaled = amount * 100;
    const cents = Math.round(scaled);
    if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(cents)
      || Math.abs(scaled - cents) > 1e-7) return null;
    feeTotal += cents;
    if (!Number.isSafeInteger(feeTotal) || feeTotal > expected.amountCents) return null;
  }
  return feeTotal;
}

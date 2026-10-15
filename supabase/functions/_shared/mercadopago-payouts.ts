import {
  assertAmountCents,
  fetchProvider,
  ProviderOutcomeUnknownError,
  type CoreWithdrawalStatus,
} from './payment-provider.ts';
import { normalizePixDestination } from './pix-destination.ts';
import type {
  PixDestination,
  PixDestinationType,
  PayoutConnectorContext,
} from './payout-provider.ts';

export type MercadoPagoPayoutTransfer = {
  providerTransactionId: string;
  providerBatchId: string;
  amountCents: number;
  externalReference: string;
  status: CoreWithdrawalStatus;
  providerStatus: string;
  failureCode?: string;
};

type MercadoPagoPayoutTransaction = {
  id: string;
  external_reference: string;
  status: string;
  status_detail?: string;
  amount: { currency: string; value: number };
};

const encoder = new TextEncoder();
const apiOrigin = 'https://api.mercadopago.com';
const providerIdPattern = /^[A-Za-z0-9-]{8,100}$/;
const referencePattern = /^[A-Za-z0-9_-]{1,50}$/;
const webhookHosts = new Set(['nexorapay.me', 'www.nexorapay.me']);

export function normalizeMercadoPagoPayoutStatus(
  rawStatus: unknown,
  rawDetail: unknown,
): CoreWithdrawalStatus {
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
  const detail = typeof rawDetail === 'string' ? rawDetail.trim().toLowerCase() : '';
  if (status === 'success' && detail === 'accredited') return 'COMPLETED';
  if (status === 'rejected' || status === 'error' || status === 'canceled') return 'FAILED';
  if (status === 'approved' || status === 'created' || status === 'transaction_in_process'
    || (status === 'success' && detail === 'in_progress') || status === 'processed') return 'PROCESSING';
  // Only the documented credited state is terminal success. Unknown or
  // incomplete provider states must never release/consume ledger funds.
  return 'RISK_REVIEW';
}

export function normalizeMercadoPagoPixDestination(input: PixDestination): PixDestination {
  try {
    const destination = normalizePixDestination({
      pixAddressKey: input.key,
      pixAddressKeyType: input.keyType,
    });
    return { key: destination.pixAddressKey, keyType: destination.pixAddressKeyType };
  } catch {
    throw new Error('mercadopago_pix_destination_invalid');
  }
}

function assertContext(context: PayoutConnectorContext) {
  if (context.apiBaseUrl.replace(/\/$/, '') !== apiOrigin || !context.credential
    || context.credential.length > 4096) throw new Error('mercadopago_payout_context_invalid');
  if (context.environment !== 'sandbox' && context.environment !== 'production') {
    throw new Error('mercadopago_payout_environment_required');
  }
  let notificationUrl: URL;
  try { notificationUrl = new URL(context.notificationUrl || ''); }
  catch { throw new Error('mercadopago_payout_notification_url_required'); }
  if (notificationUrl.protocol !== 'https:' || notificationUrl.username || notificationUrl.password
    || (!webhookHosts.has(notificationUrl.hostname.toLowerCase())
      && !notificationUrl.hostname.toLowerCase().endsWith('.supabase.co'))) {
    throw new Error('mercadopago_payout_notification_url_invalid');
  }
  if (context.environment === 'production'
    && (!context.signingPrivateKeyPem || context.signingPrivateKeyPem.length > 2048)) {
    throw new Error('mercadopago_payout_signing_key_required');
  }
  return notificationUrl.toString();
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function importProductionSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  const match = /^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PRIVATE KEY-----\s*$/.exec(privateKeyPem.trim());
  if (!match) throw new Error('mercadopago_payout_signing_key_invalid');
  try {
    return await crypto.subtle.importKey('pkcs8', decodeBase64(match[1].replace(/\s/g, '')),
      { name: 'Ed25519' }, false, ['sign']);
  } catch {
    throw new Error('mercadopago_payout_signing_key_invalid');
  }
}

export async function validateMercadoPagoPayoutSigningConfiguration(context: PayoutConnectorContext): Promise<void> {
  assertContext(context);
  if (context.environment === 'production') await importProductionSigningKey(context.signingPrivateKeyPem!);
}

async function productionSignature(privateKeyPem: string, exactBody: string): Promise<string> {
  const key = await importProductionSigningKey(privateKeyPem);
  const signature = await crypto.subtle.sign('Ed25519', key, encoder.encode(exactBody));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function parseTransaction(value: unknown, expected: {
  amountCents: number;
  externalReference: string;
  providerBatchId: string;
}, allowMissingStatus = false): MercadoPagoPayoutTransfer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderOutcomeUnknownError();
  const body = value as Record<string, unknown>;
  const amount = body.amount as Record<string, unknown> | null;
  const providerStatus = body.status === undefined && allowMissingStatus ? 'created' : body.status;
  if (typeof body.id !== 'string' || !providerIdPattern.test(body.id)
    || body.external_reference !== expected.externalReference
    || typeof providerStatus !== 'string' || providerStatus.length < 1 || providerStatus.length > 80
    || (body.status_detail !== undefined && (typeof body.status_detail !== 'string' || body.status_detail.length > 100))
    || !amount || amount.currency !== 'BRL' || typeof amount.value !== 'number'
    || !Number.isFinite(amount.value) || Math.round(amount.value * 100) !== amount.value * 100
    || Math.round(amount.value * 100) !== expected.amountCents) {
    throw new ProviderOutcomeUnknownError();
  }
  const status = normalizeMercadoPagoPayoutStatus(providerStatus, body.status_detail);
  return {
    providerTransactionId: body.id,
    providerBatchId: expected.providerBatchId,
    amountCents: expected.amountCents,
    externalReference: expected.externalReference,
    status,
    // The database keeps raw_provider_status in a bounded 80-character field;
    // status_detail still participates in the normalized decision below.
    providerStatus,
    ...(status === 'FAILED' ? { failureCode: 'mercadopago_payout_failed' } : {}),
  };
}

async function requestJson(context: PayoutConnectorContext, path: string, init: RequestInit,
  fetchImpl: typeof fetch): Promise<unknown> {
  assertContext(context);
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${context.credential}`);
  headers.set('user-agent', 'NexoraPay/1.0 (Mercado Pago payout adapter)');
  let response: Response;
  try {
    response = await fetchProvider(new URL(path, apiOrigin), {
      ...init,
      redirect: 'error',
      headers,
    }, 10_000, fetchImpl);
  } catch {
    throw new ProviderOutcomeUnknownError();
  }
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    console.error('mercadopago_payout_api_error', JSON.stringify({
      status: response.status,
      body: errorBody.slice(0, 1000),
    }));
    if (response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500) {
      throw new ProviderOutcomeUnknownError();
    }
    const err = new Error('mercadopago_payout_rejected_' + response.status);
    (err as any).status = response.status;
    (err as any).body = errorBody;
    throw err;
  }
  try { return await response.json(); }
  catch { throw new ProviderOutcomeUnknownError(); }
}

function assertIntent(input: {
  amountCents: number;
  externalReference: string;
  idempotencyKey?: string;
  description: string;
}) {
  const amountCents = assertAmountCents(input.amountCents);
  if (!referencePattern.test(input.externalReference) || input.externalReference.length > 50
    || !input.idempotencyKey || !referencePattern.test(input.idempotencyKey) || input.idempotencyKey.length > 128
    || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 100
    || /[^A-Za-z0-9 _-]/.test(input.description)) throw new Error('mercadopago_payout_request_invalid');
  return amountCents;
}

function pixType(keyType: PixDestinationType): string {
  return keyType === 'EVP' ? 'PIX_CODE' : keyType;
}

export async function createMercadoPagoPixTransfer(
  context: PayoutConnectorContext,
  input: {
    amountCents: number;
    externalReference: string;
    idempotencyKey?: string;
    description: string;
    destination: PixDestination;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<MercadoPagoPayoutTransfer> {
  const amountCents = assertIntent(input);
  const notificationUrl = assertContext(context);
  const destination = normalizeMercadoPagoPixDestination(input.destination);
  const amount = amountCents / 100;
  const payload = {
    external_reference: input.externalReference,
    config: { notification_url: notificationUrl },
    description: input.description.trim(),
    transactions: [{
      description: input.description.trim(),
      type: 'pix',
      pix: {
        type: pixType(destination.keyType),
        chave: destination.keyType === 'PHONE'
          ? (destination.key.startsWith('+55') ? destination.key : `+55${destination.key.replace(/\D/g, '')}`)
          : destination.key,
      },
      amount: { currency: 'BRL', value: amount },
      external_reference: input.externalReference,
    }],
  };
  const exactBody = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-idempotency-key': input.idempotencyKey!,
  };
  if (context.environment === 'sandbox') headers['x-test-token'] = 'true';
  else {
    headers['x-enforce-signature'] = 'true';
    headers['x-signature'] = await productionSignature(context.signingPrivateKeyPem!, exactBody);
  }
  const response = await requestJson(context, '/v1/payouts', {
    method: 'POST', headers, body: exactBody,
  }, fetchImpl);
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new ProviderOutcomeUnknownError();
  const batch = response as Record<string, unknown>;
  if (typeof batch.id !== 'string' || !providerIdPattern.test(batch.id)
    || !Array.isArray(batch.transactions) || batch.transactions.length !== 1) throw new ProviderOutcomeUnknownError();
  return parseTransaction(batch.transactions[0], {
    amountCents, externalReference: input.externalReference, providerBatchId: batch.id,
  }, true);
}

export async function getMercadoPagoPixTransfer(
  context: PayoutConnectorContext,
  lookup: { providerTransactionId: string; providerBatchId?: string; amountCents: number; externalReference: string },
  fetchImpl: typeof fetch = fetch,
): Promise<MercadoPagoPayoutTransfer> {
  const amountCents = assertAmountCents(lookup.amountCents);
  if (!providerIdPattern.test(lookup.providerTransactionId) || !lookup.providerBatchId
    || !providerIdPattern.test(lookup.providerBatchId) || !referencePattern.test(lookup.externalReference)) {
    throw new Error('mercadopago_payout_lookup_invalid');
  }
  const path = `/v1/payouts/${encodeURIComponent(lookup.providerBatchId)}/transactions/${encodeURIComponent(lookup.providerTransactionId)}`;
  const response = await requestJson(context, path, { method: 'GET' }, fetchImpl);
  return parseTransaction(response, {
    amountCents, externalReference: lookup.externalReference, providerBatchId: lookup.providerBatchId,
  });
}


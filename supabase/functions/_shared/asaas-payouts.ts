import { assertAmountCents, fetchProvider, ProviderOutcomeUnknownError, type CoreWithdrawalStatus } from './payment-provider.ts';
import { normalizePixDestination } from './pix-destination.ts';

export type AsaasPixDestination = {
  pixAddressKey: string;
  pixAddressKeyType: 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP';
};

export type AsaasTransfer = {
  id: string;
  value: number;
  externalReference: string | null;
  status: string;
  operationType?: string;
  failReason?: string | null;
};

export type AsaasPayoutResult = {
  providerTransactionId: string;
  externalReference: string;
  amountCents: number;
  status: CoreWithdrawalStatus;
  providerStatus: string;
  failureCode?: string;
};

export type AsaasTransferWebhookNotice = {
  eventId: string;
  eventType: 'TRANSFER_CREATED' | 'TRANSFER_PENDING' | 'TRANSFER_IN_BANK_PROCESSING'
    | 'TRANSFER_BLOCKED' | 'TRANSFER_DONE' | 'TRANSFER_FAILED' | 'TRANSFER_CANCELLED';
  providerTransactionId: string;
  externalReference: string | null;
  amountCents: number;
  providerStatus: string;
  status: CoreWithdrawalStatus;
};

const allowedBases = new Set([
  'https://api.asaas.com/v3',
  'https://api-sandbox.asaas.com/v3',
]);

function apiUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.replace(/\/$/, '');
  if (!allowedBases.has(base)) throw new Error('asaas_base_url_not_allowed');
  return new URL(base + path);
}

export function normalizeAsaasTransferStatus(raw: unknown): CoreWithdrawalStatus {
  if (raw === 'DONE') return 'COMPLETED';
  if (raw === 'PENDING') return 'PROCESSING';
  if (raw === 'CANCELLED' || raw === 'FAILED') return 'FAILED';
  if (raw === 'IN_BANK_PROCESSING' || raw === 'BANK_PROCESSING') return 'PROCESSING';
  return 'RISK_REVIEW';
}

/** Parse an Asaas transfer webhook without trusting it as a completed payout. */
export function parseAsaasTransferWebhookNotice(value: unknown): AsaasTransferWebhookNotice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('asaas_transfer_webhook_invalid');
  const payload = value as Record<string, unknown>;
  const events = new Set<AsaasTransferWebhookNotice['eventType']>([
    'TRANSFER_CREATED', 'TRANSFER_PENDING', 'TRANSFER_IN_BANK_PROCESSING', 'TRANSFER_BLOCKED',
    'TRANSFER_DONE', 'TRANSFER_FAILED', 'TRANSFER_CANCELLED',
  ]);
  if (typeof payload.id !== 'string' || !payload.id.trim() || payload.id.length > 255
    || typeof payload.event !== 'string' || !events.has(payload.event as AsaasTransferWebhookNotice['eventType'])
    || !payload.transfer || typeof payload.transfer !== 'object' || Array.isArray(payload.transfer)) {
    throw new Error('asaas_transfer_webhook_invalid');
  }
  const transfer = payload.transfer as Record<string, unknown>;
  const eventType = payload.event as AsaasTransferWebhookNotice['eventType'];
  if (typeof transfer.id !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(transfer.id)
    || (transfer.externalReference !== undefined && (typeof transfer.externalReference !== 'string'
      || transfer.externalReference.length < 1 || transfer.externalReference.length > 255))
    || transfer.operationType !== 'PIX' || typeof transfer.value !== 'number'
    || !Number.isFinite(transfer.value) || transfer.value <= 0
    || Math.round(transfer.value * 100) !== transfer.value * 100
    || typeof transfer.status !== 'string'
    || transfer.status.length < 1 || transfer.status.length > 80) {
    throw new Error('asaas_transfer_webhook_invalid');
  }
  const amountCents = assertAmountCents(Math.round(transfer.value * 100));
  const status = normalizeAsaasTransferStatus(transfer.status);
  // Asaas does not guarantee a fixed event sequence; transfer.status is the
  // current state and may be newer than the event name. The receiver performs
  // a separate authenticated GET before applying any financial status.
  return {
    eventId: payload.id,
    eventType,
    providerTransactionId: transfer.id,
    externalReference: typeof transfer.externalReference === 'string' ? transfer.externalReference : null,
    amountCents,
    providerStatus: transfer.status,
    status: eventType === 'TRANSFER_BLOCKED' ? 'RISK_REVIEW' : status,
  };
}

/** Normalize only the key formats documented by Asaas; never guess a key type. */
export function normalizeAsaasPixDestination(destination: AsaasPixDestination): AsaasPixDestination {
  try { return normalizePixDestination(destination); }
  catch { throw new Error('asaas_pix_destination_invalid'); }
}

function parseTransfer(value: unknown): AsaasTransfer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderOutcomeUnknownError();
  const body = value as Record<string, unknown>;
  if (typeof body.id !== 'string' || !body.id.trim() || typeof body.value !== 'number'
    || !Number.isFinite(body.value) || typeof body.externalReference !== 'string'
    || typeof body.status !== 'string') throw new ProviderOutcomeUnknownError();
  return body as unknown as AsaasTransfer;
}

function assertTransferMatches(transfer: AsaasTransfer, amountCents: number, externalReference: string) {
  if (Math.round(transfer.value * 100) !== amountCents || transfer.externalReference !== externalReference) {
    throw new ProviderOutcomeUnknownError();
  }
}

function result(transfer: AsaasTransfer, amountCents: number, externalReference: string): AsaasPayoutResult {
  const status = normalizeAsaasTransferStatus(transfer.status);
  return {
    providerTransactionId: transfer.id,
    externalReference,
    amountCents,
    status,
    providerStatus: transfer.status,
    ...(status === 'FAILED' ? { failureCode: 'provider_transfer_cancelled' } : {}),
  };
}

async function requestJson(url: URL, apiKey: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchProvider(url, {
      ...init,
      headers: { accept: 'application/json', access_token: apiKey, 'user-agent': 'NexoraPay/1.0', ...init.headers },
    }, 10_000, fetchImpl);
  } catch {
    throw new ProviderOutcomeUnknownError();
  }
  if (!response.ok) {
    // Treat throttling, timeouts, conflict, and all server failures as ambiguous;
    // callers must query by provider ID/reference and must never blindly resend.
    if (response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500) {
      throw new ProviderOutcomeUnknownError();
    }
    throw new Error('asaas_transfer_rejected_' + response.status);
  }
  try { return await response.json(); } catch { throw new ProviderOutcomeUnknownError(); }
}

export async function createAsaasPixTransfer(input: {
  baseUrl: string;
  apiKey: string;
  amountCents: number;
  externalReference: string;
  description: string;
  destination: AsaasPixDestination;
}, fetchImpl: typeof fetch = fetch): Promise<AsaasPayoutResult> {
  const amountCents = assertAmountCents(input.amountCents);
  if (!input.apiKey || input.apiKey.length > 4096 || !/^NX-PAYOUT-[A-Za-z0-9-]{16,80}$/.test(input.externalReference)
    || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 100) {
    throw new Error('asaas_transfer_request_invalid');
  }
  const destination = normalizeAsaasPixDestination(input.destination);
  const payload = await requestJson(apiUrl(input.baseUrl, '/transfers'), input.apiKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      value: amountCents / 100,
      pixAddressKey: destination.pixAddressKey,
      pixAddressKeyType: destination.pixAddressKeyType,
      operationType: 'PIX',
      description: input.description.trim(),
      externalReference: input.externalReference,
    }),
  }, fetchImpl);
  const transfer = parseTransfer(payload);
  assertTransferMatches(transfer, amountCents, input.externalReference);
  return result(transfer, amountCents, input.externalReference);
}

export async function getAsaasPixTransfer(input: {
  baseUrl: string;
  apiKey: string;
  providerTransactionId: string;
  amountCents: number;
  externalReference: string;
}, fetchImpl: typeof fetch = fetch): Promise<AsaasPayoutResult> {
  const amountCents = assertAmountCents(input.amountCents);
  if (!input.apiKey || !/^[A-Za-z0-9-]{8,100}$/.test(input.providerTransactionId)
    || !/^NX-PAYOUT-[A-Za-z0-9-]{16,80}$/.test(input.externalReference)) throw new Error('asaas_transfer_lookup_invalid');
  let payload: unknown;
  try {
    payload = await requestJson(apiUrl(input.baseUrl, '/transfers/' + encodeURIComponent(input.providerTransactionId)), input.apiKey, { method: 'GET' }, fetchImpl);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('asaas_transfer_rejected_404')) throw new ProviderOutcomeUnknownError();
    throw error;
  }
  const transfer = parseTransfer(payload);
  if (transfer.id !== input.providerTransactionId) throw new ProviderOutcomeUnknownError();
  assertTransferMatches(transfer, amountCents, input.externalReference);
  return result(transfer, amountCents, input.externalReference);
}

/** Resolve a transfer ID when the provider webhook does not include our external reference. */
export async function getAsaasPixTransferById(input: {
  baseUrl: string;
  apiKey: string;
  providerTransactionId: string;
}, fetchImpl: typeof fetch = fetch): Promise<AsaasPayoutResult> {
  if (!input.apiKey || input.apiKey.length > 4096
    || !/^[A-Za-z0-9-]{8,100}$/.test(input.providerTransactionId)) {
    throw new Error('asaas_transfer_lookup_invalid');
  }
  const payload = await requestJson(
    apiUrl(input.baseUrl, '/transfers/' + encodeURIComponent(input.providerTransactionId)),
    input.apiKey, { method: 'GET' }, fetchImpl,
  );
  const transfer = parseTransfer(payload);
  if (transfer.id !== input.providerTransactionId || transfer.operationType !== 'PIX'
    || typeof transfer.externalReference !== 'string'
    || transfer.externalReference.length < 1 || transfer.externalReference.length > 255
    || Math.round(transfer.value * 100) !== transfer.value * 100) {
    throw new ProviderOutcomeUnknownError();
  }
  const amountCents = assertAmountCents(Math.round(transfer.value * 100));
  return result(transfer, amountCents, transfer.externalReference);
}

/** Recovery-only lookup after an ambiguous create; this function never sends a transfer. */
export async function findAsaasPixTransferByReference(input: {
  baseUrl: string;
  apiKey: string;
  externalReference: string;
  amountCents: number;
  createdDate: string;
}, fetchImpl: typeof fetch = fetch): Promise<AsaasPayoutResult | null> {
  const amountCents = assertAmountCents(input.amountCents);
  if (!input.apiKey || !/^NX-PAYOUT-[A-Za-z0-9-]{16,80}$/.test(input.externalReference)
    || !isCalendarDate(input.createdDate)) throw new Error('asaas_transfer_lookup_invalid');
  const found: AsaasTransfer[] = [];
  const pageSize = 100;
  const maximumPages = 10;
  for (let page = 0; page < maximumPages; page++) {
    const url = apiUrl(input.baseUrl, '/transfers');
    url.searchParams.set('dateCreated[ge]', input.createdDate);
    url.searchParams.set('dateCreated[le]', input.createdDate);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(page * pageSize));
    const payload = await requestJson(url, input.apiKey, { method: 'GET' }, fetchImpl);
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) throw new ProviderOutcomeUnknownError();
    const response = payload as { data: unknown[]; hasMore?: unknown };
    if (typeof response.hasMore !== 'boolean') throw new ProviderOutcomeUnknownError();
    for (const item of response.data) {
      // A malformed row means the provider response cannot prove absence: it
      // might be the transfer being recovered with its reference omitted.
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ProviderOutcomeUnknownError();
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.externalReference !== 'string') throw new ProviderOutcomeUnknownError();
      if (candidate.externalReference === input.externalReference) found.push(parseTransfer(candidate));
    }
    if (!response.hasMore) break;
    if (page === maximumPages - 1) throw new ProviderOutcomeUnknownError();
  }
  if (found.length > 1) throw new ProviderOutcomeUnknownError();
  if (found.length === 0) return null;
  assertTransferMatches(found[0], amountCents, input.externalReference);
  return result(found[0], amountCents, input.externalReference);
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

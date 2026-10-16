export const PUSHINPAY_API_BASE = 'https://api.pushinpay.com.br/api';

export type PushinPayPixChargeInput = {
  valueCents: number;
  webhookUrl?: string;
};

export type PushinPayNormalizedPayment = {
  providerTransactionId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  rawStatusCode: string;
  valueCents?: number;
  pixCopyPaste?: string;
  qrCodeBase64?: string;
  checkoutUrl?: string | null;
  expiresAt?: string | null;
};

export function normalizePushinPayStatus(rawStatus: string): 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' {
  const s = String(rawStatus || '').toLowerCase();
  if (s === 'paid' || s === 'approved' || s === 'completed' || s === 'succeeded') return 'SUCCEEDED';
  if (s === 'canceled' || s === 'cancelled' || s === 'expired') return 'CANCELED';
  if (s === 'failed' || s === 'rejected' || s === 'error') return 'FAILED';
  return 'PENDING';
}

export async function createPushinPayPixPayment(
  apiKey: string,
  input: PushinPayPixChargeInput,
  fetchImpl: typeof fetch = fetch
): Promise<PushinPayNormalizedPayment> {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('pushinpay_api_key_required');
  if (!Number.isSafeInteger(input.valueCents) || input.valueCents < 50) {
    throw new Error('pushinpay_amount_invalid');
  }

  const payload: Record<string, unknown> = {
    value: input.valueCents,
  };
  if (input.webhookUrl) {
    payload.webhook_url = input.webhookUrl;
  }

  const response = await fetchImpl(`${PUSHINPAY_API_BASE}/pix/cashIn`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'NexoraPay/1.0',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = JSON.stringify(errJson);
    } catch {
      errorDetail = await response.text().catch(() => '');
    }
    console.error('pushinpay_cashin_failed', JSON.stringify({ status: response.status, detail: errorDetail }));
    if (response.status === 401 || response.status === 403) throw new Error('pushinpay_authentication_failed');
    if (response.status === 422) throw new Error('pushinpay_validation_failed');
    throw new Error(`pushinpay_http_error_${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data !== 'object' || !data.id) {
    throw new Error('pushinpay_invalid_response');
  }

  const rawStatus = String(data.status || 'created');
  return {
    providerTransactionId: String(data.id),
    status: normalizePushinPayStatus(rawStatus),
    rawStatusCode: rawStatus,
    valueCents: typeof data.value === 'number' ? data.value : input.valueCents,
    pixCopyPaste: typeof data.qr_code === 'string' ? data.qr_code : undefined,
    qrCodeBase64: typeof data.qr_code_base64 === 'string' ? data.qr_code_base64 : undefined,
    checkoutUrl: null,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  };
}

export async function getPushinPayTransaction(
  apiKey: string,
  transactionId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PushinPayNormalizedPayment> {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('pushinpay_api_key_required');
  if (!transactionId || typeof transactionId !== 'string') throw new Error('pushinpay_transaction_id_required');

  const response = await fetchImpl(`${PUSHINPAY_API_BASE}/transactions/${encodeURIComponent(transactionId)}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
      'User-Agent': 'NexoraPay/1.0',
    },
  });

  if (!response.ok) {
    if (response.status === 404) throw new Error('pushinpay_transaction_not_found');
    if (response.status === 401 || response.status === 403) throw new Error('pushinpay_authentication_failed');
    throw new Error(`pushinpay_http_error_${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data !== 'object' || !data.id) {
    throw new Error('pushinpay_invalid_response');
  }

  const rawStatus = String(data.status || 'created');
  const pixDetails = data.pix_details && typeof data.pix_details === 'object' ? data.pix_details : null;

  return {
    providerTransactionId: String(data.id),
    status: normalizePushinPayStatus(rawStatus),
    rawStatusCode: rawStatus,
    valueCents: typeof data.value === 'number' ? data.value : undefined,
    pixCopyPaste: pixDetails && typeof pixDetails.emv === 'string' ? pixDetails.emv : undefined,
    qrCodeBase64: undefined,
    checkoutUrl: null,
    expiresAt: pixDetails && typeof pixDetails.expiration_date === 'string' ? pixDetails.expiration_date : null,
  };
}

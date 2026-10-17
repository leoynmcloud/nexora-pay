export const ORUSPRIME_API_BASE = 'https://app.orusprime.com.br/api/v1';

export type OrusPrimeCredentials = {
  publicKey: string;
  secretKey: string;
};

export type OrusPrimeClientInput = {
  name: string;
  email: string;
  phone?: string;
  document?: string;
};

export type OrusPrimeProductInput = {
  id: string;
  name: string;
  quantity?: number;
  price: number;
};

export type OrusPrimePixChargeInput = {
  identifier: string;
  valueCents: number;
  client: OrusPrimeClientInput;
  products?: OrusPrimeProductInput[];
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
};

export type OrusPrimeNormalizedPayment = {
  providerTransactionId: string;
  clientIdentifier?: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  rawStatusCode: string;
  valueCents?: number;
  pixCopyPaste?: string;
  qrCodeImage?: string | null;
  checkoutUrl?: string | null;
  expiresAt?: string | null;
  payedAt?: string | null;
};

export function parseOrusPrimeCredentials(raw: string): OrusPrimeCredentials {
  if (!raw || typeof raw !== 'string') {
    throw new Error('orusprime_credentials_invalid');
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const publicKey = String(parsed.publicKey || parsed.public_key || parsed.clientId || '').trim();
      const secretKey = String(parsed.secretKey || parsed.secret_key || parsed.clientSecret || '').trim();
      if (!publicKey || !secretKey) throw new Error('orusprime_credentials_incomplete');
      return { publicKey, secretKey };
    } catch {
      throw new Error('orusprime_credentials_invalid');
    }
  }
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex > 0) {
    const publicKey = trimmed.slice(0, colonIndex).trim();
    const secretKey = trimmed.slice(colonIndex + 1).trim();
    if (!publicKey || !secretKey) throw new Error('orusprime_credentials_incomplete');
    return { publicKey, secretKey };
  }
  throw new Error('orusprime_credentials_format_unsupported');
}

export function normalizeOrusPrimeStatus(rawStatus: string): 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' {
  const s = String(rawStatus || '').toUpperCase().trim();
  if (s === 'COMPLETED' || s === 'PAID' || s === 'OK' || s === 'SUCCEEDED') return 'SUCCEEDED';
  if (s === 'CANCELED' || s === 'CANCELLED' || s === 'EXPIRED') return 'CANCELED';
  if (s === 'FAILED' || s === 'REJECTED') return 'FAILED';
  return 'PENDING';
}

function cleanDocument(doc?: string): string | undefined {
  if (!doc) return undefined;
  const digits = doc.replace(/\D/g, '');
  return digits.length > 0 ? digits : undefined;
}

function cleanPhone(phone?: string): string {
  if (!phone) return '11999999999';
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits : '11999999999';
}

export async function createOrusPrimePixPayment(
  credentialsInput: string | OrusPrimeCredentials,
  input: OrusPrimePixChargeInput,
  fetchImpl: typeof fetch = fetch
): Promise<OrusPrimeNormalizedPayment> {
  const creds = typeof credentialsInput === 'string'
    ? parseOrusPrimeCredentials(credentialsInput)
    : credentialsInput;

  if (!Number.isSafeInteger(input.valueCents) || input.valueCents < 50) {
    throw new Error('orusprime_amount_invalid');
  }
  if (!input.identifier) {
    throw new Error('orusprime_identifier_required');
  }

  const amountReais = Math.round(input.valueCents) / 100;
  const document = cleanDocument(input.client?.document);
  const phone = cleanPhone(input.client?.phone);

  const payload: Record<string, unknown> = {
    identifier: input.identifier,
    amount: amountReais,
    client: {
      name: input.client?.name || 'Cliente Nexora',
      email: input.client?.email || 'cliente@nexorapay.me',
      phone,
      ...(document ? { document } : {}),
    },
    products: (input.products && input.products.length > 0)
      ? input.products
      : [
          {
            id: input.identifier.slice(0, 30),
            name: 'Pagamento Nexora Pay',
            quantity: 1,
            price: amountReais,
          },
        ],
  };

  if (input.callbackUrl) {
    payload.callbackUrl = input.callbackUrl;
  }
  if (input.metadata) {
    payload.metadata = input.metadata;
  }

  const response = await fetchImpl(`${ORUSPRIME_API_BASE}/gateway/pix/receive`, {
    method: 'POST',
    headers: {
      'x-public-key': creds.publicKey,
      'x-secret-key': creds.secretKey,
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
    console.error('orusprime_receive_failed', JSON.stringify({ status: response.status, detail: errorDetail }));
    if (response.status === 401 || response.status === 403) throw new Error('orusprime_authentication_failed');
    if (response.status === 422) throw new Error('orusprime_validation_failed');
    throw new Error(`orusprime_http_error_${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data !== 'object' || !data.transactionId) {
    throw new Error('orusprime_invalid_response');
  }

  const rawStatus = String(data.transactionStatus || data.status || 'PENDING');
  const pixObj = data.pix && typeof data.pix === 'object' ? data.pix : null;
  const orderObj = data.order && typeof data.order === 'object' ? data.order : null;

  return {
    providerTransactionId: String(data.transactionId),
    clientIdentifier: input.identifier,
    status: normalizeOrusPrimeStatus(rawStatus),
    rawStatusCode: rawStatus,
    valueCents: input.valueCents,
    pixCopyPaste: pixObj && typeof pixObj.code === 'string' ? pixObj.code : undefined,
    qrCodeImage: pixObj && typeof pixObj.image === 'string' ? pixObj.image : null,
    checkoutUrl: orderObj && typeof orderObj.url === 'string' ? orderObj.url : null,
    expiresAt: pixObj && typeof pixObj.expiresAt === 'string' ? pixObj.expiresAt : new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  };
}

export async function getOrusPrimeTransaction(
  credentialsInput: string | OrusPrimeCredentials,
  transactionId: string,
  fetchImpl: typeof fetch = fetch
): Promise<OrusPrimeNormalizedPayment> {
  const creds = typeof credentialsInput === 'string'
    ? parseOrusPrimeCredentials(credentialsInput)
    : credentialsInput;

  if (!transactionId || typeof transactionId !== 'string') {
    throw new Error('orusprime_transaction_id_required');
  }

  const response = await fetchImpl(`${ORUSPRIME_API_BASE}/gateway/transactions?id=${encodeURIComponent(transactionId)}`, {
    method: 'GET',
    headers: {
      'x-public-key': creds.publicKey,
      'x-secret-key': creds.secretKey,
      'Accept': 'application/json',
      'User-Agent': 'NexoraPay/1.0',
    },
  });

  if (!response.ok) {
    if (response.status === 404) throw new Error('orusprime_transaction_not_found');
    if (response.status === 401 || response.status === 403) throw new Error('orusprime_authentication_failed');
    throw new Error(`orusprime_http_error_${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data !== 'object' || !data.id) {
    throw new Error('orusprime_invalid_response');
  }

  const rawStatus = String(data.status || 'PENDING');
  const pixInfo = data.pixInformation && typeof data.pixInformation === 'object' ? data.pixInformation : null;
  const amountCents = typeof data.amount === 'number' ? Math.round(data.amount * 100) : undefined;

  return {
    providerTransactionId: String(data.id),
    clientIdentifier: typeof data.clientIdentifier === 'string' ? data.clientIdentifier : undefined,
    status: normalizeOrusPrimeStatus(rawStatus),
    rawStatusCode: rawStatus,
    valueCents: amountCents,
    pixCopyPaste: pixInfo && typeof pixInfo.qrCode === 'string' ? pixInfo.qrCode : undefined,
    qrCodeImage: pixInfo && typeof pixInfo.image === 'string' ? pixInfo.image : null,
    checkoutUrl: null,
    expiresAt: null,
    payedAt: typeof data.payedAt === 'string' ? data.payedAt : null,
  };
}

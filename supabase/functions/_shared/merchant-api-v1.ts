const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array) {
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function extractMerchantApiKey(authorization: string | null) {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const key = match?.[1] || '';
  return /^nx_(?:live|test)_[A-Za-z0-9_-]{43}$/.test(key) ? key : null;
}

export function validatePaymentLinkInput(input: Record<string, unknown>, idempotencyKey: string | null) {
  const amountCents = input.amount_cents;
  const description = typeof input.description === 'string' ? input.description.trim().normalize('NFC') : '';
  const currency = input.currency === undefined ? 'BRL' : input.currency;
  if (!Number.isSafeInteger(amountCents) || Number(amountCents) < 100 || Number(amountCents) > 99_999_999) {
    throw new Error('amount_invalid');
  }
  if (currency !== 'BRL') throw new Error('currency_unsupported');
  if (description.length < 2 || description.length > 120 || /[\u0000-\u001f\u007f]/.test(description)) {
    throw new Error('description_invalid');
  }
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128
    || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) throw new Error('idempotency_key_required');
  return { amountCents: Number(amountCents), description, currency: 'BRL' as const, idempotencyKey };
}

export async function apiRequestHash(payment: { amountCents: number; description: string; currency: 'BRL' }) {
  const canonical = JSON.stringify({ amount_cents: payment.amountCents, currency: payment.currency, description: payment.description });
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical))));
}

/** Reproduces a checkout bearer token on an idempotent retry without storing the raw token. */
export async function deriveApiCheckoutToken(apiKey: string, apiKeyId: string, idempotencyKey: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(apiKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = encoder.encode(`nexora-api-v1|payment-links|${apiKeyId}|${idempotencyKey}`);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)));
}

export interface PaymentLinkCursor { created_at: string; id: string }

export function encodePaymentLinkCursor(cursor: PaymentLinkCursor) {
  return base64Url(encoder.encode(JSON.stringify(cursor)));
}

export function decodePaymentLinkCursor(value: string | null): PaymentLinkCursor | null {
  if (!value) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('cursor_invalid');
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.created_at !== 'string' || !Number.isFinite(Date.parse(parsed.created_at))
      || typeof parsed.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error();
    return { created_at: new Date(parsed.created_at).toISOString(), id: parsed.id.toLowerCase() };
  } catch { throw new Error('cursor_invalid'); }
}

export function apiError(code: string, message: string, requestId: string) {
  return { error: { code, message, request_id: requestId } };
}

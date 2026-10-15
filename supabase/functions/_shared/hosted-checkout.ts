import { isValidBrazilianDocument, normalizeBrazilianDocument } from './brazilian-documents.ts';

const encoder = new TextEncoder();
const unsupportedCardInputFields = [
  'card_number', 'card_holder_name', 'card_expiry', 'card_cvv', 'card_brand', 'card_doc', 'card_email',
  'cardNumber', 'securityCode', 'expirationMonth', 'expirationYear',
] as const;

/**
 * Pix needs no card data. Credit card is accepted only as a single-use token created in the
 * browser by the provider SDK; raw card values are rejected without being read.
 */
export function isHostedCheckoutMethodSupported(input: Record<string, unknown>) {
  const method = input.payment_method === undefined ? 'pix' : input.payment_method;
  const containsCardData = unsupportedCardInputFields.some((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (containsCardData) return false;
  if (method === 'pix') return !Object.prototype.hasOwnProperty.call(input, 'card_token');
  return method === 'credit_card' && typeof input.card_token === 'string';
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes: Uint8Array) {
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** 256-bit bearer secret; only its SHA-256 digest belongs in Postgres. */
export function generateCheckoutToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function assertCheckoutToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('checkout_token_invalid');
  }
  return value;
}

export async function checkoutTokenHash(value: unknown) {
  const token = assertCheckoutToken(value);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

/** Link token acts as a secret pepper so a database-only leak cannot guess payer PII from this fingerprint. */
export async function checkoutRequestHash(
  tokenValue: unknown,
  linkId: string,
  payer: { name: string; email: string | null; document: string },
) {
  const token = assertCheckoutToken(tokenValue);
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) throw new Error('checkout_link_id_invalid');
  const canonical = JSON.stringify({
    token,
    link_id: linkId.toLowerCase(),
    payer_name: payer.name.trim().normalize('NFC'),
    payer_email: payer.email?.trim().toLowerCase() || null,
    payer_document: payer.document,
  });
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical))));
}

export function normalizeCheckoutPayer(input: {
  name: unknown;
  email: unknown;
  document: unknown;
}) {
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ').normalize('NFC') : '';
  let document = '';
  try { document = normalizeBrazilianDocument(input.document); } catch { throw new Error('checkout_payer_invalid'); }
  const emailRaw = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const email = emailRaw || null;
  if (name.length < 2 || name.length > 160 || !isValidBrazilianDocument(document)
    || (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) {
    throw new Error('checkout_payer_invalid');
  }
  return { name, email, document };
}

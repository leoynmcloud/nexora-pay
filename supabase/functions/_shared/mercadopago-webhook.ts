const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function signatureParts(value: string) {
  if (value.length > 512) throw new Error('mercadopago_signature_invalid');
  const parts = new Map<string, string>();
  for (const part of value.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 1) throw new Error('mercadopago_signature_invalid');
    const key = part.slice(0, separator).trim();
    const item = part.slice(separator + 1).trim();
    if (!['ts', 'v1'].includes(key) || !item || parts.has(key)) throw new Error('mercadopago_signature_invalid');
    parts.set(key, item);
  }
  const timestamp = parts.get('ts') || '';
  const digest = parts.get('v1') || '';
  if (!/^\d{10,16}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(digest)) throw new Error('mercadopago_signature_invalid');
  return { timestamp, digest };
}

/** Verifies Mercado Pago's HMAC-SHA256 webhook signature and replay window. */
export async function verifyMercadoPagoWebhookSignature(input: {
  signature: string | null;
  requestId: string | null;
  dataId: string | null;
  secret: string;
  nowMs?: number;
}): Promise<boolean> {
  if (!input.signature || !input.requestId || !input.dataId || !input.secret || input.secret.length > 512
    || input.requestId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(input.requestId)
    || input.dataId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(input.dataId)
    || !Number.isFinite(input.nowMs ?? Date.now())) return false;
  let parts: ReturnType<typeof signatureParts>;
  try { parts = signatureParts(input.signature); } catch { return false; }
  const parsedTime = Number(parts.timestamp);
  // MP has used Unix seconds in older payment notifications and milliseconds in newer APIs.
  const timestampMs = parsedTime < 1_000_000_000_000 ? parsedTime * 1000 : parsedTime;
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestampMs) > MAX_SIGNATURE_AGE_MS) return false;
  const manifest = `id:${input.dataId.toLowerCase()};request-id:${input.requestId};ts:${parts.timestamp};`;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(input.secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)));
    const expected = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return constantTimeHexEqual(expected, parts.digest);
  } catch { return false; }
}

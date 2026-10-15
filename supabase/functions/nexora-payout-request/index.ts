import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { encryptProviderCredential } from '../_shared/provider-credentials.ts';
import { normalizePixDestination } from '../_shared/pix-destination.ts';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
import { mapPayoutReserveError } from '../_shared/payout-reserve-errors.ts';

const encoder = new TextEncoder();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedOrigins = new Set(['https://nexorapay.me', 'https://www.nexorapay.me']);

function reply(request: Request, body: unknown, status = 200) {
  const origin = request.headers.get('origin') || '';
  return Response.json(body, { status, headers: {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://www.nexorapay.me',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin', 'Cache-Control': 'no-store',
  } });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('session_invalid');
  const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('session_invalid');
  return value as Record<string, unknown>;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async request => {
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS') return reply(request, {});
  if (origin && !allowedOrigins.has(origin)) return reply(request, { error: 'origin_not_allowed' }, 403);
  if (request.method !== 'POST') return reply(request, { error: 'method_not_allowed' }, 405);
  const authorization = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization);
  if (!match) return reply(request, { error: 'unauthorized' }, 401);
  const token = match[1];
  const projectUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const encryptionKey = Deno.env.get('NEXORA_PAYOUT_DESTINATION_ENCRYPTION_KEY_V1') || '';
  if (!projectUrl || !anonKey || !serviceKey || !encryptionKey) return reply(request, { error: 'service_unavailable' }, 503);

  const userClient = createClient(projectUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return reply(request, { error: 'unauthorized' }, 401);
  let claims: Record<string, unknown>;
  try { claims = decodeJwtPayload(token); } catch { return reply(request, { error: 'unauthorized' }, 401); }
  if (claims.sub !== authData.user.id || claims.aal !== 'aal2') return reply(request, { error: 'mfa_required' }, 403);

  const rawBody = await readBoundedHttpBody(request, 8192);
  if (rawBody === null) return reply(request, { error: 'payload_too_large' }, 413);
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(rawBody);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    body = value as Record<string, unknown>;
  } catch { return reply(request, { error: 'invalid_request' }, 400); }
  if (typeof body.business_id !== 'string' || !uuidPattern.test(body.business_id)
    || typeof body.request_id !== 'string' || !uuidPattern.test(body.request_id)
    || typeof body.amount_cents !== 'number' || !Number.isSafeInteger(body.amount_cents) || body.amount_cents <= 0
    || typeof body.pix_key !== 'string' || typeof body.pix_key_type !== 'string') {
    return reply(request, { error: 'invalid_payout_request' }, 400);
  }
  let destination;
  try {
    destination = normalizePixDestination({
      pixAddressKey: body.pix_key,
      pixAddressKeyType: body.pix_key_type as 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP',
    });
  } catch { return reply(request, { error: 'invalid_pix_destination' }, 400); }

  const requestIntent = JSON.stringify({
    owner_id: authData.user.id, business_id: body.business_id, request_id: body.request_id,
    amount_cents: Number(body.amount_cents), pix_key_type: destination.pixAddressKeyType,
    pix_key: destination.pixAddressKey,
  });
  const [requestHash, destinationHash] = await Promise.all([
    sha256(requestIntent), sha256(destination.pixAddressKeyType + ':' + destination.pixAddressKey),
  ]);
  let destinationCiphertext: string;
  try {
    destinationCiphertext = await encryptProviderCredential(
      JSON.stringify(destination), encryptionKey,
    );
  } catch { return reply(request, { error: 'payout_security_unavailable' }, 503); }

  const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.rpc('nexora_payout_reserve', {
    p_owner_id: authData.user.id,
    p_business_id: body.business_id,
    p_request_id: body.request_id,
    p_request_sha256: requestHash,
    p_amount_cents: Number(body.amount_cents),
    p_destination_type: destination.pixAddressKeyType,
    p_destination_ciphertext: destinationCiphertext,
    p_destination_key_version: 1,
    p_destination_sha256: destinationHash,
  });
  if (error) {
    const mapped = mapPayoutReserveError(error.message);
    if (!mapped.definitive) {
      console.error('payout_request_failed', JSON.stringify({ code: mapped.error, user_id: authData.user.id }));
    }
    return reply(request, { error: mapped.error, definitive: mapped.definitive }, mapped.status);
  }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.payout_id || !result.external_reference) return reply(request, { error: 'payout_reservation_failed' }, 503);
  return reply(request, {
    id: result.payout_id, status: result.status,
    amount_cents: Number(body.amount_cents),
  }, 202);
});

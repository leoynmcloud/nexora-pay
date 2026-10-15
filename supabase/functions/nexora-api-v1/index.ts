import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { hashMerchantApiKey, merchantApiKeyPrefix } from '../_shared/merchant-api-keys.ts';
import {
  apiError, apiRequestHash, decodePaymentLinkCursor, deriveApiCheckoutToken,
  encodePaymentLinkCursor, extractMerchantApiKey, validatePaymentLinkInput,
} from '../_shared/merchant-api-v1.ts';
import { checkoutTokenHash } from '../_shared/hosted-checkout.ts';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';

const maxBodyBytes = 12_000;
const apiVersion = '2026-10-10';

function json(body: unknown, status: number, requestId: string, extraHeaders: Record<string, string> = {}) {
  return Response.json(body, { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Request-ID': requestId,
    'X-Nexora-API-Version': apiVersion,
    ...extraHeaders,
  } });
}

function errorResponse(status: number, code: string, message: string, requestId: string, headers: Record<string, string> = {}) {
  return json(apiError(code, message, requestId), status, requestId, headers);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await readBoundedHttpBody(request, maxBodyBytes);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !serviceKey) throw new Error('api_server_not_configured');
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function corslessPath(request: Request) {
  const path = new URL(request.url).pathname;
  return path.replace(/^.*\/nexora-api-v1(?=\/|$)/, '') || '/';
}

Deno.serve(async request => {
  const requestId = crypto.randomUUID();
  if (request.headers.has('origin')) {
    return errorResponse(403, 'SERVER_TO_SERVER_ONLY', 'Use esta API somente no servidor da sua loja.', requestId);
  }
  if (request.method === 'OPTIONS') return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.', requestId, { Allow: 'GET, POST' });
  if (request.method !== 'GET' && request.method !== 'POST') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.', requestId, { Allow: 'GET, POST' });
  }

  const apiKey = extractMerchantApiKey(request.headers.get('authorization'));
  if (!apiKey) return errorResponse(401, 'INVALID_API_KEY', 'Chave de API inválida ou ausente.', requestId, { 'WWW-Authenticate': 'Bearer' });
  let admin: ReturnType<typeof serviceClient>;
  try { admin = serviceClient(); }
  catch { return errorResponse(503, 'SERVICE_UNAVAILABLE', 'API temporariamente indisponível.', requestId); }

  let keyContext: Record<string, unknown> | null = null;
  try {
    const { data, error } = await admin.rpc('nexora_merchant_api_key_authenticate', {
      p_key_prefix: merchantApiKeyPrefix(apiKey), p_key_hash: await hashMerchantApiKey(apiKey),
    });
    if (error) throw new Error('api_key_authentication_failed');
    keyContext = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'api_key_authentication_failed';
    console.error('nexora_api_auth_failed', JSON.stringify({ request_id: requestId, code }));
    return errorResponse(503, 'SERVICE_UNAVAILABLE', 'API temporariamente indisponível.', requestId);
  }
  if (!keyContext) return errorResponse(401, 'INVALID_API_KEY', 'Chave de API inválida ou revogada.', requestId, { 'WWW-Authenticate': 'Bearer' });
  if (keyContext.environment !== 'production') return errorResponse(403, 'ENVIRONMENT_UNAVAILABLE', 'A API sandbox ainda não está disponível.', requestId);
  const keyId = String(keyContext.id || '');
  const scopes = Array.isArray(keyContext.scopes) ? keyContext.scopes : [];
  if (!/^[0-9a-f-]{36}$/i.test(keyId)) return errorResponse(401, 'INVALID_API_KEY', 'Chave de API inválida ou revogada.', requestId);

  let rate: Record<string, unknown>;
  try {
    const { data, error } = await admin.rpc('nexora_merchant_api_rate_limit', { p_api_key_id: keyId, p_limit: 60 });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('api_rate_limit_failed');
    rate = data as Record<string, unknown>;
  } catch {
    return errorResponse(503, 'SERVICE_UNAVAILABLE', 'API temporariamente indisponível.', requestId);
  }
  const rateHeaders = {
    'X-RateLimit-Limit': String(rate.limit ?? 60),
    'X-RateLimit-Remaining': String(rate.remaining ?? 0),
  };
  if (rate.allowed !== true) {
    const retryAfter = Math.max(1, Number(rate.retry_after_seconds) || 1);
    return errorResponse(429, 'RATE_LIMITED', 'Limite de solicitações excedido. Tente novamente depois.', requestId,
      { ...rateHeaders, 'Retry-After': String(retryAfter) });
  }

  const path = corslessPath(request);
  const url = new URL(request.url);
  const linkCollection = path === '/v1/payment-links' || path === '/payment-links';
  const itemMatch = path.match(/^\/(?:v1\/)?payment-links\/([0-9a-f-]{36})$/i);

  if (request.method === 'POST' && linkCollection) {
    if (!scopes.includes('payments:write')) return errorResponse(403, 'INSUFFICIENT_SCOPE', 'A chave não possui o escopo payments:write.', requestId, rateHeaders);
    const input = await readJson(request);
    if (!input) return errorResponse(400, 'INVALID_REQUEST', 'Corpo JSON ausente, inválido ou acima do limite.', requestId, rateHeaders);
    if (Object.keys(input).some(key => !['amount_cents', 'currency', 'description'].includes(key))) {
      return errorResponse(400, 'INVALID_REQUEST', 'A solicitação contém campos não suportados.', requestId, rateHeaders);
    }
    let payment;
    try { payment = validatePaymentLinkInput(input, request.headers.get('idempotency-key')); }
    catch (error) {
      const code = error instanceof Error ? error.message : 'request_invalid';
      const messages: Record<string, string> = {
        amount_invalid: 'amount_cents deve ser um inteiro entre 100 e 99.999.999.',
        currency_unsupported: 'Somente BRL está disponível neste produto.',
        description_invalid: 'description deve ter de 2 a 120 caracteres.',
        idempotency_key_required: 'Envie Idempotency-Key com 16 a 128 caracteres válidos.',
      };
      return errorResponse(400, code.toUpperCase(), messages[code] || 'Revise os dados enviados.', requestId, rateHeaders);
    }
    try {
      const requestHash = await apiRequestHash(payment);
      const checkoutToken = await deriveApiCheckoutToken(apiKey, keyId, payment.idempotencyKey);
      const { data, error } = await admin.rpc('nexora_api_v1_create_payment_link', {
        p_api_key_id: keyId, p_request_id: requestId, p_idempotency_key: payment.idempotencyKey,
        p_request_hash: requestHash, p_token_hash: await checkoutTokenHash(checkoutToken),
        p_amount_cents: payment.amountCents, p_description: payment.description,
      });
      if (error || !data) {
        const dbMessage = String(error?.message || '');
        const sameKeyDifferentBody = dbMessage.includes('Idempotency key reused');
        const status = sameKeyDifferentBody ? 409 : dbMessage.includes('provider') ? 422 : 409;
        const code = sameKeyDifferentBody ? 'IDEMPOTENCY_CONFLICT' : 'PAYMENT_LINK_NOT_CREATED';
        const message = sameKeyDifferentBody ? 'Esta Idempotency-Key já foi usada com dados diferentes.' : 'Não foi possível criar o link; verifique a aprovação, rota e configuração da conta.';
        return errorResponse(status, code, message, requestId, rateHeaders);
      }
      const checkoutUrl = `https://www.nexorapay.me/checkout.html#token=${encodeURIComponent(checkoutToken)}`;
      return json({ data: { ...data, checkout_url: checkoutUrl }, request_id: requestId }, data.idempotent_replay ? 200 : 201, requestId, rateHeaders);
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'api_payment_link_create_failed';
      console.error('nexora_api_payment_link_create_failed', JSON.stringify({ request_id: requestId, code, api_key_id: keyId }));
      return errorResponse(503, 'SERVICE_UNAVAILABLE', 'API temporariamente indisponível.', requestId, rateHeaders);
    }
  }

  if (request.method === 'GET' && linkCollection) {
    if (!scopes.includes('payments:read')) return errorResponse(403, 'INSUFFICIENT_SCOPE', 'A chave não possui o escopo payments:read.', requestId, rateHeaders);
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 25 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return errorResponse(400, 'LIMIT_INVALID', 'limit deve estar entre 1 e 100.', requestId, rateHeaders);
    let cursor;
    try { cursor = decodePaymentLinkCursor(url.searchParams.get('cursor')); }
    catch { return errorResponse(400, 'CURSOR_INVALID', 'cursor inválido.', requestId, rateHeaders); }
    const { data, error } = await admin.rpc('nexora_api_v1_list_payment_links', {
      p_api_key_id: keyId, p_limit: limit,
      p_cursor_created_at: cursor?.created_at ?? null, p_cursor_id: cursor?.id ?? null,
    });
    if (error || !data) return errorResponse(503, 'SERVICE_UNAVAILABLE', 'Não foi possível consultar os links agora.', requestId, rateHeaders);
    const next = data.next_cursor ? encodePaymentLinkCursor(data.next_cursor) : null;
    return json({ data: data.data || [], has_more: data.has_more === true, next_cursor: next, request_id: requestId }, 200, requestId, rateHeaders);
  }

  if (request.method === 'GET' && itemMatch) {
    if (!scopes.includes('payments:read')) return errorResponse(403, 'INSUFFICIENT_SCOPE', 'A chave não possui o escopo payments:read.', requestId, rateHeaders);
    const { data, error } = await admin.rpc('nexora_api_v1_get_payment_link', { p_api_key_id: keyId, p_link_id: itemMatch[1] });
    if (error) return errorResponse(503, 'SERVICE_UNAVAILABLE', 'Não foi possível consultar o link agora.', requestId, rateHeaders);
    if (!data) return errorResponse(404, 'RESOURCE_NOT_FOUND', 'Link não encontrado.', requestId, rateHeaders);
    return json({ data, request_id: requestId }, 200, requestId, rateHeaders);
  }

  return errorResponse(404, 'RESOURCE_NOT_FOUND', 'Endpoint não encontrado nesta versão da API.', requestId, rateHeaders);
});

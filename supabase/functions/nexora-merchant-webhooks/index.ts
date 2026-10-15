import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { encryptProviderCredential } from '../_shared/provider-credentials.ts';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
import {
  assertPublicMerchantWebhookDestination,
  generateMerchantWebhookSecret,
  validateMerchantWebhookEvents,
} from '../_shared/merchant-webhooks.ts';
const allowedOrigins = new Set(['https://nexorapay.me','https://www.nexorapay.me']);

async function resolveWebhookDns(hostname: string, recordType: 'A' | 'AAAA', signal?: AbortSignal) {
  try { return await Deno.resolveDns(hostname, recordType, { signal }); }
  catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

function reply(request: Request, body: unknown, status = 200) {
  const origin = request.headers.get('origin') || '';
  return Response.json(body, { status, headers: {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://www.nexorapay.me',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin', 'Cache-Control': 'no-store',
  } });
}

async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return reply(request, {});
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins.has(origin)) return reply(request, { error: 'Origem não autorizada.' }, 403);
  if (request.method !== 'POST') return reply(request, { error: 'Método não permitido.' }, 405);
  let input: Record<string, unknown>;
  try {
    const raw = await readBoundedHttpBody(request, 12_000);
    if (raw === null) return reply(request, { error: 'Solicitação muito grande ou inválida.' }, 413);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    input = parsed;
  } catch { return reply(request, { error: 'Solicitação inválida.' }, 400); }

  try {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const url = Deno.env.get('SUPABASE_URL') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const encryptionKey = Deno.env.get('NEXORA_MERCHANT_WEBHOOK_ENCRYPTION_KEY') || '';
    if (!token || !url || !anonKey || !encryptionKey) return reply(request, { error: 'Sessão ou serviço indisponível.' }, 401);
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return reply(request, { error: 'Sessão inválida ou expirada.' }, 401);

    if (input.action === 'list') {
      const businessId = String(input.business_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(businessId)) return reply(request, { error: 'Workspace inválido.' }, 400);
      const { data, error } = await userClient.rpc('nexora_merchant_webhook_list_endpoints', { p_business_id: businessId });
      if (error) throw new Error('webhook_list_failed');
      return reply(request, { endpoints: data || [] });
    }
    if (input.action === 'disable') {
      const endpointId = String(input.endpoint_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(endpointId)) return reply(request, { error: 'Endpoint inválido.' }, 400);
      const { error } = await userClient.rpc('nexora_merchant_webhook_disable_endpoint', { p_endpoint_id: endpointId });
      if (error) return reply(request, { error: 'Não foi possível desativar o endpoint.' }, 409);
      return reply(request, { ok: true });
    }
    if (input.action === 'create' || input.action === 'rotate') {
      const secret = generateMerchantWebhookSecret();
      const envelope = await encryptProviderCredential(secret, encryptionKey);
      const fingerprint = await sha256(secret);
      let error;
      if (input.action === 'create') {
        const businessId = String(input.business_id || '');
        const dnsController = new AbortController();
        const dnsTimeout = setTimeout(() => dnsController.abort(), 4_000);
        let endpointUrl: string;
        try {
          endpointUrl = await assertPublicMerchantWebhookDestination(input.endpoint_url, resolveWebhookDns, dnsController.signal);
        } finally { clearTimeout(dnsTimeout); }
        let events: string[];
        try { events = validateMerchantWebhookEvents(input.events); }
        catch { return reply(request, { error: 'Selecione apenas eventos atualmente disponíveis.' }, 400); }
        if (!/^[0-9a-f-]{36}$/i.test(businessId)) return reply(request, { error: 'Workspace inválido.' }, 400);
        const saved = await userClient.rpc('nexora_merchant_webhook_create_endpoint', {
          p_business_id: businessId, p_endpoint_url: endpointUrl, p_subscribed_events: events,
          p_secret_ciphertext: envelope, p_secret_fingerprint: fingerprint,
        });
        error = saved.error;
        if (!error) return reply(request, { endpoint: saved.data, secret }, 201);
      } else {
        const endpointId = String(input.endpoint_id || '');
        if (!/^[0-9a-f-]{36}$/i.test(endpointId)) return reply(request, { error: 'Endpoint inválido.' }, 400);
        const rotated = await userClient.rpc('nexora_merchant_webhook_rotate_endpoint', {
          p_endpoint_id: endpointId, p_secret_ciphertext: envelope, p_secret_fingerprint: fingerprint,
        });
        error = rotated.error;
        if (!error) return reply(request, { ok: true, secret });
      }
      console.error('merchant_webhook_endpoint_write_failed', JSON.stringify({ action: input.action, code: error?.code || 'unknown', owner_id: authData.user.id }));
      return reply(request, { error: 'Não foi possível salvar a configuração do webhook.' }, 409);
    }
    return reply(request, { error: 'Ação inválida.' }, 400);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'merchant_webhook_request_failed';
    console.error('merchant_webhook_request_failed', JSON.stringify({ code }));
    const status = error instanceof Error && ['webhook_url_invalid', 'webhook_dns_rejected'].includes(error.message) ? 400 : 503;
    return reply(request, { error: status === 400 ? 'Informe uma URL HTTPS pública, com DNS válido.' : 'Não foi possível processar a configuração. Confira a URL e tente novamente.' }, status);
  }
});

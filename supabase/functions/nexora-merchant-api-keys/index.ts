import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  generateMerchantApiKey,
  hashMerchantApiKey,
  merchantApiKeyPrefix,
  validateMerchantApiScopes,
  type MerchantApiEnvironment,
} from '../_shared/merchant-api-keys.ts';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';

const allowedOrigins = new Set(['https://nexorapay.me', 'https://www.nexorapay.me']);

function reply(request: Request, body: unknown, status = 200) {
  const origin = request.headers.get('origin') || '';
  return Response.json(body, { status, headers: {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://www.nexorapay.me',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin', 'Cache-Control': 'no-store',
  } });
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

  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const url = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  if (!token || !url || !anonKey) return reply(request, { error: 'Sessão necessária.' }, 401);
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return reply(request, { error: 'Sessão inválida ou expirada.' }, 401);

  try {
    if (input.action === 'list') {
      const businessId = String(input.business_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(businessId)) return reply(request, { error: 'Workspace inválido.' }, 400);
      const { data, error } = await userClient.rpc('nexora_merchant_api_key_list', { p_business_id: businessId });
      if (error) throw new Error('api_key_list_failed');
      return reply(request, { keys: data || [] });
    }
    if (input.action === 'revoke') {
      const keyId = String(input.key_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(keyId)) return reply(request, { error: 'Chave inválida.' }, 400);
      const { error } = await userClient.rpc('nexora_merchant_api_key_revoke', { p_key_id: keyId });
      if (error) return reply(request, { error: 'Não foi possível revogar a chave ativa.' }, 409);
      return reply(request, { ok: true });
    }
    if (input.action === 'create' || input.action === 'rotate') {
      const environment = String(input.environment || '') as MerchantApiEnvironment;
      if (environment !== 'sandbox' && environment !== 'production') return reply(request, { error: 'Ambiente inválido.' }, 400);
      const secret = generateMerchantApiKey(environment);
      const prefix = merchantApiKeyPrefix(secret);
      const digest = await hashMerchantApiKey(secret);
      if (input.action === 'create') {
        const businessId = String(input.business_id || '');
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!/^[0-9a-f-]{36}$/i.test(businessId) || name.length < 2 || name.length > 80) {
          return reply(request, { error: 'Informe o workspace e um nome de 2 a 80 caracteres.' }, 400);
        }
        let scopes;
        try { scopes = validateMerchantApiScopes(input.scopes); }
        catch { return reply(request, { error: 'Selecione apenas escopos disponíveis.' }, 400); }
        const { data, error } = await userClient.rpc('nexora_merchant_api_key_create', {
          p_business_id: businessId, p_key_prefix: prefix, p_key_hash: digest,
          p_name: name, p_environment: environment, p_scopes: scopes,
        });
        if (error || !data) {
          console.error('merchant_api_key_create_failed', JSON.stringify({ code: error?.code || 'unknown', owner_id: authData.user.id }));
          return reply(request, { error: 'Não foi possível criar a chave. Confira o workspace e a aprovação da conta.' }, 409);
        }
        return reply(request, { key: data, secret }, 201);
      }
      const keyId = String(input.key_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(keyId)) return reply(request, { error: 'Chave inválida.' }, 400);
      const { data, error } = await userClient.rpc('nexora_merchant_api_key_rotate', {
        p_key_id: keyId, p_key_prefix: prefix, p_key_hash: digest,
      });
      if (error || !data) return reply(request, { error: 'Não foi possível rotacionar a chave ativa.' }, 409);
      return reply(request, { key: data, secret });
    }
    return reply(request, { error: 'Ação inválida.' }, 400);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'merchant_api_key_request_failed';
    console.error('merchant_api_key_request_failed', JSON.stringify({ code, owner_id: authData.user.id }));
    return reply(request, { error: 'Não foi possível processar as chaves da API.' }, 503);
  }
});

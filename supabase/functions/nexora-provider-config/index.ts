import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

import { asaasConfiguration, asaasAcquirerMatches } from '../_shared/asaas-config.ts';
import { encryptProviderCredential } from '../_shared/provider-credentials.ts';
import { validateMercadoPagoAccessToken } from '../_shared/mercadopago-credentials.ts';
import { parseOrusPrimeCredentials } from '../_shared/orusprime-adapter.ts';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function fingerprint(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') || '';
  const defaults = ['https://nexorapay.me', 'https://www.nexorapay.me'];
  const deprecatedOrigins = new Set(['https://nexorapay-demo.vercel.app']);
  const custom = (Deno.env.get('NEXORA_ALLOWED_ORIGINS') || '').split(',').map((value) => value.trim()).filter((value) => value && !deprecatedOrigins.has(value));
  const allowed = [...new Set([...defaults, ...custom])];
  const cors = { ...corsHeaders, 'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0], Vary: 'Origin' };
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (origin && !allowed.includes(origin)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403, headers: cors });
  if (request.method !== 'POST') return Response.json({ error: 'Método não permitido.' }, { status: 405, headers: cors });
  const rawBody = await readBoundedHttpBody(request, 12_000);
  if (rawBody === null) return Response.json({ error: 'Solicitação muito grande ou inválida.' }, { status: 413, headers: cors });
  let input: Record<string, unknown>;
  try { input = JSON.parse(rawBody); } catch { return Response.json({ error: 'Solicitação inválida.' }, { status: 400, headers: cors }); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return Response.json({ error: 'Solicitação inválida.' }, { status: 400, headers: cors });

  let failurePhase = 'request_validation';
  const requestId = crypto.randomUUID();
  try {
    failurePhase = 'server_configuration';
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return Response.json({ error: 'Sessão necessária.' }, { status: 401, headers: cors });
    const url = Deno.env.get('SUPABASE_URL') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const encryptionKey = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
    if (!url || !anonKey || !serviceKey || !encryptionKey) throw new Error('server_not_configured');

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    failurePhase = 'user_authentication';
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return Response.json({ error: 'Sessão inválida ou expirada.' }, { status: 401, headers: cors });
    failurePhase = 'mfa_verification';
    const { data: assurance, error: assuranceError } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
    if (assuranceError || assurance?.currentLevel !== 'aal2') {
      return Response.json({ error: 'Confirme a autenticação em duas etapas para configurar credenciais.' }, { status: 403, headers: cors });
    }
    failurePhase = 'super_admin_authorization';
    const { data: isAdmin, error: adminCheckError } = await userClient.rpc('is_nexora_super_admin');
    if (adminCheckError || isAdmin !== true) return Response.json({ error: 'Somente o Super Admin pode configurar chaves de adquirentes.' }, { status: 403, headers: cors });

    const acquirerId = String(input.acquirer_id || '');
    const apiKey = String(input.api_key || '').trim();
    const environment = String(input.environment || '');
    if (!/^[0-9a-f-]{36}$/i.test(acquirerId) || !apiKey || apiKey.length > 4000
      || !['sandbox','production'].includes(environment)) {
      return Response.json({ error: 'Informe o adquirente, o ambiente e a credencial.' }, { status: 400, headers: cors });
    }
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    failurePhase = 'acquirer_lookup';
    const { data: acquirer, error: acquirerError } = await admin.from('nexora_acquirers')
      .select('code,api_base_url,environment,status').eq('id', acquirerId).maybeSingle();
    if (acquirerError || !acquirer || environment !== acquirer.environment) {
      return Response.json({ error: 'O ambiente informado não corresponde ao adquirente.' }, { status: 409, headers: cors });
    }
    let providerLabel: string;
    failurePhase = 'provider_validation';
    if (['asaas_production','asaas_sandbox'].includes(acquirer.code) && asaasAcquirerMatches(acquirer)) {
      const config = asaasConfiguration(acquirer.environment);
      providerLabel = config.label;
      if (!apiKey.startsWith(config.keyPrefix)) {
        return Response.json({ error: 'A chave não corresponde ao ambiente selecionado: ' + config.label + '.' }, { status: 400, headers: cors });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let validation: Response;
      try {
        validation = await fetch(`${config.baseUrl}/myAccount/commercialInfo`, {
          method: 'GET', signal: controller.signal, redirect: 'error',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': `NexoraPay/1.0 (${config.environment})`, access_token: apiKey },
        });
      } finally { clearTimeout(timer); }
      if (validation.status === 401 || validation.status === 403) {
        await validation.body?.cancel().catch(() => undefined);
        return Response.json({ error: 'O Asaas rejeitou a chave. Confira o ambiente, o prefixo e a validade.' }, { status: 422, headers: cors });
      }
      if (!validation.ok) {
        const httpStatus = validation.status;
        await validation.body?.cancel().catch(() => undefined);
        return Response.json({ error: `Não foi possível validar a chave no Asaas (HTTP ${httpStatus}).` }, { status: 502, headers: cors });
      }
      await validation.body?.cancel().catch(() => undefined);
    } else if (acquirer.api_base_url === 'https://api.mercadopago.com'
      && String(acquirer.code || '').startsWith('mercadopago_')
      && ['production', 'sandbox'].includes(acquirer.environment)) {
      providerLabel = acquirer.environment === 'production' ? 'Mercado Pago · produção' : 'Mercado Pago · testes';
      try { await validateMercadoPagoAccessToken(apiKey, acquirer.environment as 'sandbox' | 'production'); }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'mercadopago_access_token_invalid') return Response.json({ error: 'Informe um Access Token válido do Mercado Pago.' }, { status: 400, headers: cors });
        if (code === 'mercadopago_access_token_rejected') return Response.json({ error: 'O Mercado Pago rejeitou o Access Token. Confira a conta e o ambiente selecionados.' }, { status: 422, headers: cors });
        return Response.json({ error: 'Não foi possível validar o Access Token no Mercado Pago agora.' }, { status: 502, headers: cors });
      }
    } else if (acquirer.code === 'pushinpay_production' && acquirer.environment === 'production') {
      providerLabel = 'Pushin Pay · produção';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let validation: Response;
      try {
        validation = await fetch('https://api.pushinpay.com.br/api/transactions', {
          method: 'GET', signal: controller.signal, redirect: 'error',
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'NexoraPay/1.0' },
        });
      } finally { clearTimeout(timer); }
      if (validation.status === 401 || validation.status === 403) {
        await validation.body?.cancel().catch(() => undefined);
        return Response.json({ error: 'A Pushin Pay rejeitou o token de API. Confira o token informado.' }, { status: 422, headers: cors });
      }
      if (!validation.ok && validation.status !== 404) {
        const httpStatus = validation.status;
        await validation.body?.cancel().catch(() => undefined);
        return Response.json({ error: `Não foi possível validar o token na Pushin Pay (HTTP ${httpStatus}).` }, { status: 502, headers: cors });
      }
      await validation.body?.cancel().catch(() => undefined);
    } else if (acquirer.code === 'orusprime_production' && acquirer.environment === 'production') {
      providerLabel = 'Orus Prime · produção';
      let creds: { publicKey: string; secretKey: string };
      try {
        creds = parseOrusPrimeCredentials(apiKey);
      } catch {
        return Response.json({
          error: 'Formato inválido para credenciais Orus Prime. Use o formato chavePublica:chaveSecreta ou JSON {"publicKey":"...","secretKey":"..."}.',
        }, { status: 400, headers: cors });
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let validation: Response;
      try {
        validation = await fetch('https://app.orusprime.com.br/api/v1', {
          method: 'GET',
          signal: controller.signal,
          redirect: 'error',
          headers: {
            'x-public-key': creds.publicKey,
            'x-secret-key': creds.secretKey,
            'Accept': 'application/json',
            'User-Agent': 'NexoraPay/1.0',
          },
        });
      } finally { clearTimeout(timer); }
      if (validation.status === 401 || validation.status === 403) {
        await validation.body?.cancel().catch(() => undefined);
        return Response.json({ error: 'A Orus Prime rejeitou as chaves de API. Confira a chave pública e a chave secreta informadas.' }, { status: 422, headers: cors });
      }
      if (!validation.ok) {
        const httpStatus = validation.status;
        await validation.body?.cancel().catch(() => undefined);
        return Response.json({ error: `Não foi possível validar as chaves na Orus Prime (HTTP ${httpStatus}).` }, { status: 502, headers: cors });
      }
      await validation.body?.cancel().catch(() => undefined);
    } else {
      return Response.json({ error: 'Este adquirente ainda não tem validação segura de credencial configurada.' }, { status: 409, headers: cors });
    }

    failurePhase = 'credential_encryption';
    const ciphertext = await encryptProviderCredential(apiKey, encryptionKey);
    const keyHint = apiKey.replace(/[^A-Za-z0-9_-]/g, '').slice(-4).padStart(4, '_');
    failurePhase = 'credential_fingerprint';
    const keyFingerprint = await fingerprint(apiKey);
    failurePhase = 'credential_persistence';
    const { error: saveError } = await admin.rpc('nexora_admin_save_platform_provider_credential', {
      p_actor_id: authData.user.id,
      p_acquirer_id: acquirerId, p_environment: environment,
      p_api_key_ciphertext: ciphertext, p_key_fingerprint: keyFingerprint, p_key_hint: keyHint,
    });
    if (saveError) throw new Error('credential_save_failed');
    return Response.json({ ok: true, status: 'active', provider: providerLabel, environment, key_hint: keyHint }, { headers: cors });
  } catch (error) {
    const rawErrorType = error instanceof Error ? error.name : '';
    const errorType = ['Error','TypeError','OperationError','AbortError'].includes(rawErrorType) ? rawErrorType : 'OtherError';
    console.error('nexora-provider-config failed', JSON.stringify({ request_id: requestId, phase: failurePhase, error_type: errorType }));
    return Response.json({ error: 'Não foi possível validar ou salvar a credencial. Nenhuma chave foi registrada em logs.', error_code: 'provider_config_failure', request_id: requestId }, { status: 500, headers: cors });
  }
});

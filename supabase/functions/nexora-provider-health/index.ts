import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { decryptProviderCredential } from '../_shared/provider-credentials.ts';
import { providerAdapterRoute } from '../_shared/provider-registry.ts';
import { classifyProviderHealth, providerHealthEndpoint, type ProviderHealthResult } from '../_shared/provider-health.ts';

const allowedOrigins = ['https://nexorapay.me', 'https://www.nexorapay.me'];
const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') || '';
  const allowed = [...allowedOrigins, ...(Deno.env.get('NEXORA_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean)];
  const cors = { ...corsHeaders, 'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowedOrigins[0], Vary: 'Origin' };
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (origin && !allowed.includes(origin)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403, headers: cors });
  if (request.method !== 'POST') return Response.json({ error: 'Método não permitido.' }, { status: 405, headers: cors });
  if (Number(request.headers.get('content-length') || 0) > 1024) return Response.json({ error: 'Solicitação muito grande.' }, { status: 413, headers: cors });

  try {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return Response.json({ error: 'Sessão administrativa necessária.' }, { status: 401, headers: cors });
    const url = Deno.env.get('SUPABASE_URL') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const encryptionKey = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
    if (!url || !anonKey || !serviceKey) throw new Error('server_not_configured');

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return Response.json({ error: 'Sessão inválida ou expirada.' }, { status: 401, headers: cors });
    const { data: isAdmin, error: adminError } = await userClient.rpc('is_nexora_super_admin');
    if (adminError || isAdmin !== true) return Response.json({ error: 'Super Admin com MFA obrigatório.' }, { status: 403, headers: cors });

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: acquirers, error: acquirerError } = await admin.from('nexora_acquirers')
      .select('id,code,name,api_base_url,environment,status').neq('status', 'disabled').limit(50);
    if (acquirerError) throw new Error('provider_catalog_unavailable');

    const results = [];
    for (const acquirer of acquirers || []) {
      const route = providerAdapterRoute(acquirer.code);
      const probeUrl = route ? providerHealthEndpoint(route.adapter, acquirer.code, acquirer.environment, acquirer.api_base_url) : null;
      let observation: ProviderHealthResult = { status: 'UNKNOWN', latencyMs: null, httpStatus: null, errorCode: 'probe_not_completed' };
      if (!route) {
        observation = classifyProviderHealth(null, null, true);
        observation = { ...observation, status: 'UNKNOWN' as const, errorCode: 'adapter_not_implemented' };
      } else if (!['enabled', 'degraded'].includes(acquirer.status) || !probeUrl) {
        observation = { status: 'UNKNOWN' as const, latencyMs: null, httpStatus: null, errorCode: 'provider_configuration_unsupported' };
      } else if (!encryptionKey) {
        observation = { status: 'DEGRADED' as const, latencyMs: null, httpStatus: null, errorCode: 'credential_decryption_unavailable' };
      } else {
        const { data: credential, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
          .select('api_key_ciphertext').eq('acquirer_id', acquirer.id).eq('environment', acquirer.environment)
          .eq('status', 'active').maybeSingle();
        if (credentialError) throw new Error('provider_credential_lookup_failed');
        if (!credential?.api_key_ciphertext) {
          observation = { status: 'DEGRADED' as const, latencyMs: null, httpStatus: null, errorCode: 'credential_not_configured' };
        } else {
          let apiKey = '';
          try { apiKey = await decryptProviderCredential(credential.api_key_ciphertext, encryptionKey); }
          catch { observation = { status: 'DEGRADED' as const, latencyMs: null, httpStatus: null, errorCode: 'credential_decryption_failed' }; }
          if (apiKey) {
            const started = performance.now();
            try {
              const probeHeaders = route.adapter === 'asaas'
                ? { Accept: 'application/json', access_token: apiKey, 'User-Agent': 'NexoraPay/1.0 (provider-health)' }
                : { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': 'NexoraPay/1.0 (provider-health)' };
              const response = await fetch(probeUrl, {
                method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
                headers: probeHeaders,
              });
              const latency = Math.min(60_000, Math.max(0, Math.round(performance.now() - started)));
              observation = classifyProviderHealth(response.status, latency);
              // The response body may contain account details; do not read or persist it.
              await response.body?.cancel().catch(() => undefined);
            } catch {
              const latency = Math.min(60_000, Math.max(0, Math.round(performance.now() - started)));
              observation = classifyProviderHealth(null, latency, true);
            } finally { apiKey = ''; }
          }
        }
      }
      const { error: recordError } = await admin.rpc('nexora_provider_health_record', {
        p_acquirer_id: acquirer.id, p_environment: acquirer.environment,
        p_status: observation.status, p_latency_ms: observation.latencyMs,
        p_http_status: observation.httpStatus, p_error_code: observation.errorCode,
      });
      if (recordError) throw new Error('provider_health_record_failed');
      results.push({ code: acquirer.code, name: acquirer.name, environment: acquirer.environment, ...observation });
    }
    return Response.json({ ok: true, results }, { headers: cors });
  } catch (error) {
    console.error('nexora-provider-health failed', error instanceof Error ? error.name : 'unknown');
    return Response.json({ error: 'Não foi possível verificar a saúde dos provedores.' }, { status: 500, headers: cors });
  }
});

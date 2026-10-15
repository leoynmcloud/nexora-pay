import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
import { assessPayoutReadiness, decimalToCents } from '../_shared/payout-readiness.ts';
import { zonedDayWindowUtc } from '../_shared/zoned-day-window.ts';

// This read-only endpoint is informational; nexora_payout_reserve is the final atomic gate.
const DAILY_USAGE_ROW_CAP = 500;

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host === 'nexorapay.me' || host.endsWith('.nexorapay.me')) return true;
    if (host === 'nexorapay-demo.vercel.app' || host.endsWith('.vercel.app')) return true;
    if (host === 'weblybuilds.com' || host.endsWith('.weblybuilds.com')) return true;
    if (host === 'localhost' || host === '127.0.0.1') return true;
  } catch (_) {}
  return false;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reply = (request: Request, body: unknown, status = 200) => Response.json(body, {
  status,
  headers: {
    'Access-Control-Allow-Origin': isAllowedOrigin(request.headers.get('origin'))
      ? (request.headers.get('origin') || 'https://www.nexorapay.me') : 'https://www.nexorapay.me',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store', Vary: 'Origin',
  },
});

Deno.serve(async request => {
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS') return origin && !isAllowedOrigin(origin)
    ? reply(request, { error: 'origin_not_allowed' }, 403)
    : new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? (origin || 'https://www.nexorapay.me') : 'https://www.nexorapay.me',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store', Vary: 'Origin',
    } });
  if (origin && !isAllowedOrigin(origin)) return reply(request, { error: 'origin_not_allowed' }, 403);
  if (request.method !== 'POST') return reply(request, { error: 'method_not_allowed' }, 405);
  const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!token) return reply(request, { error: 'authentication_required' }, 401);
  const url = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !anonKey || !serviceKey) return reply(request, { error: 'service_unavailable' }, 503);

  const rawBody = await readBoundedHttpBody(request, 1024);
  if (rawBody === null) return reply(request, { error: 'payload_too_large' }, 413);
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(rawBody);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    body = value as Record<string, unknown>;
  } catch { return reply(request, { error: 'invalid_request' }, 400); }
  if (typeof body.business_id !== 'string' || !uuidPattern.test(body.business_id)) {
    return reply(request, { error: 'invalid_request' }, 400);
  }
  const businessId = body.business_id;
  const userClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: auth, error: authError } = await userClient.auth.getUser(token);
  if (authError || !auth.user) return reply(request, { error: 'authentication_required' }, 401);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const { data: business, error: businessError } = await admin.from('businesses')
      .select('id,owner_id').eq('id', businessId).eq('owner_id', auth.user.id).maybeSingle();
    if (businessError) throw businessError;
    if (!business) return reply(request, { error: 'workspace_unavailable' }, 404);

    const [onboardingResult, activeResult, runtimeResult, controlsResult, connectionResult, balanceResult] = await Promise.all([
      admin.from('merchant_onboarding').select('status').eq('user_id', auth.user.id).maybeSingle(),
      admin.rpc('nexora_account_active', { p_user_id: auth.user.id }),
      admin.from('nexora_payout_runtime').select('production_enabled').eq('id', true).maybeSingle(),
      admin.from('nexora_merchant_controls')
        .select('withdrawals_enabled,pix_out_enabled,balance_movements_blocked,max_transfer_amount,daily_transfer_limit')
        .eq('business_id', businessId).eq('owner_id', auth.user.id).maybeSingle(),
      admin.from('nexora_merchant_provider_connections').select('acquirer_id')
        .eq('business_id', businessId).eq('owner_id', auth.user.id).eq('status', 'active'),
      userClient.rpc('nexora_ledger_merchant_balances', { p_business_id: businessId }),
    ]);
    for (const result of [onboardingResult, activeResult, runtimeResult, controlsResult, connectionResult, balanceResult]) {
      if (result.error) throw result.error;
    }
    const connectionIds = [...new Set((connectionResult.data || []).map(row => row.acquirer_id).filter(Boolean))];
    let productionRouteAvailable = false;
    if (connectionIds.length) {
      const { data: acquirers, error } = await admin.from('nexora_acquirers')
        .select('id,code,environment').in('id', connectionIds).eq('status', 'enabled').eq('environment', 'production');
      if (error) throw error;
      const codes = [...new Set((acquirers || []).map(row => row.code).filter(Boolean))];
      if (codes.length) {
        const { data: adapters, error: adapterError } = await admin.from('nexora_payout_provider_adapters')
          .select('provider_code,adapter_code').in('provider_code', codes).eq('environment', 'production')
          .eq('pix_out_enabled', true).eq('adapter_ready', true).eq('status', 'enabled');
        if (adapterError) throw adapterError;
        const adapterCodes = [...new Set((adapters || []).map(row => row.adapter_code).filter(Boolean))];
        if (adapterCodes.length) {
          const { data: catalog, error: catalogError } = await admin.from('nexora_payout_connector_catalog')
            .select('adapter_code').in('adapter_code', adapterCodes)
            .eq('pix_out_supported', true).eq('implementation_ready', true);
          if (catalogError) throw catalogError;
          const readyAdapters = new Set((catalog || []).map(row => row.adapter_code));
          const validAdapters = (adapters || []).filter(row => readyAdapters.has(row.adapter_code));
          const acquirerByCode = new Map((acquirers || []).map(row => [row.code, row.id]));
          const credentialAcquirerIds = [...new Set(validAdapters.map(row => acquirerByCode.get(row.provider_code)).filter(Boolean))];
          if (credentialAcquirerIds.length) {
            const { data: credentials, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
              .select('acquirer_id').in('acquirer_id', credentialAcquirerIds)
              .eq('environment', 'production').eq('status', 'active');
            if (credentialError) throw credentialError;
            const credentialIds = new Set((credentials || []).map(row => row.acquirer_id));
            productionRouteAvailable = validAdapters.some(row => credentialIds.has(acquirerByCode.get(row.provider_code)));
          }
        }
      }
    }
    // Mirrors the daily-limit query inside nexora_payout_reserve (America/Sao_Paulo day).
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const { start: dayStart } = zonedDayWindowUtc(today, 'America/Sao_Paulo');
    const { data: todayPayouts, error: usageError } = await admin.from('nexora_payouts')
      .select('amount_cents').eq('business_id', businessId).gte('created_at', dayStart)
      .not('status', 'in', '("FAILED","CANCELLED","REJECTED")').limit(DAILY_USAGE_ROW_CAP + 1);
    if (usageError) throw usageError;
    let dailyUsedCents: number | null = null;
    if ((todayPayouts || []).length <= DAILY_USAGE_ROW_CAP) {
      const amounts = (todayPayouts || []).map(row => Number(row.amount_cents));
      const sum = amounts.reduce((total, value) => total + value, 0);
      dailyUsedCents = amounts.every(Number.isSafeInteger) && Number.isSafeInteger(sum) ? sum : null;
    }
    const readiness = assessPayoutReadiness({
      workspaceExists: true,
      onboardingApproved: onboardingResult.data?.status === 'APPROVED',
      accountActive: activeResult.data === true,
      productionEnabled: runtimeResult.data?.production_enabled === true,
      withdrawalsEnabled: controlsResult.data?.withdrawals_enabled === true,
      pixOutEnabled: controlsResult.data?.pix_out_enabled === true,
      movementsBlocked: controlsResult.data?.balance_movements_blocked !== false,
      transferLimitCents: decimalToCents(controlsResult.data?.max_transfer_amount),
      dailyLimitCents: decimalToCents(controlsResult.data?.daily_transfer_limit),
      dailyUsedCents,
      productionRouteAvailable,
      availableCents: decimalToCents(balanceResult.data?.available),
    });
    return reply(request, readiness);
  } catch (error) {
    console.error('payout_readiness_failed', error instanceof Error ? error.name : 'unknown');
    return reply(request, { error: 'payout_readiness_unavailable' }, 503);
  }
});

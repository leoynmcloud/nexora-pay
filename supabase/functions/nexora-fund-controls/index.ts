import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
import { parseFundControlRequest } from '../_shared/fund-controls.ts';

const defaultOrigins = new Set([
  'https://nexorapay.me',
  'https://www.nexorapay.me',
  'https://nexorapay-demo.vercel.app',
]);

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true;
  if (defaultOrigins.has(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;
  if (/^http:\/\/localhost(:\d+)?$/i.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return true;
  const envOrigins = (Deno.env.get('NEXORA_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);
  return envOrigins.includes(origin);
}

const headers = (origin: string | null): HeadersInit => ({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  ...(origin && isOriginAllowed(origin) ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  } : {}),
});
const respond = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: headers(request.headers.get('origin')) });

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async request => {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') {
    if (origin && !isOriginAllowed(origin)) return respond(request, { error: 'origin_not_allowed' }, 403);
    return new Response(null, { status: 204, headers: headers(origin) });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
  if (origin && !isOriginAllowed(origin)) return respond(request, { error: 'origin_not_allowed' }, 403);
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return respond(request, { error: 'authentication_required' }, 401);
  const raw = await readBoundedHttpBody(request, 4096);
  if (raw === null) return respond(request, { error: 'request_too_large' }, 413);
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return respond(request, { error: 'invalid_json' }, 400); }
  const parsed = parseFundControlRequest(input);
  if (!parsed) return respond(request, { error: 'invalid_request' }, 400);

  const url = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !anonKey || !serviceKey) return respond(request, { error: 'service_unavailable' }, 503);
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await userClient.auth.getUser(token);
  if (authError || !auth.user) return respond(request, { error: 'authentication_required' }, 401);
  const { data: assurance, error: assuranceError } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
  if (assuranceError || assurance?.currentLevel !== 'aal2') return respond(request, { error: 'admin_mfa_required' }, 403);
  const { data: isAdmin, error: adminError } = await userClient.rpc('is_nexora_super_admin');
  if (adminError || isAdmin !== true) return respond(request, { error: 'admin_mfa_required' }, 403);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    if (parsed.action === 'list') {
      const { data, error } = await admin.rpc('nexora_admin_fund_hold_list', {
        p_actor_id: auth.user.id, p_limit: 100,
      });
      if (error) throw error;
      return respond(request, { holds: Array.isArray(data) ? data : [] });
    }
    if (parsed.action === 'hold') {
      const intent = JSON.stringify({ action: 'hold', actor_id: auth.user.id, business_id: parsed.businessId,
        request_id: parsed.requestId, amount_cents: parsed.amountCents, reason: parsed.reason });
      const { data, error } = await admin.rpc('nexora_admin_fund_hold_create', {
        p_actor_id: auth.user.id, p_business_id: parsed.businessId, p_hold_id: parsed.requestId,
        p_amount_cents: parsed.amountCents, p_reason: parsed.reason, p_request_sha256: await sha256(intent),
      });
      if (error) throw error;
      return respond(request, data || { error: 'hold_not_confirmed' }, 200);
    }
    const intent = JSON.stringify({ action: 'release', actor_id: auth.user.id, hold_id: parsed.holdId,
      request_id: parsed.requestId, reason: parsed.reason });
    const { data, error } = await admin.rpc('nexora_admin_fund_hold_release', {
      p_actor_id: auth.user.id, p_hold_id: parsed.holdId, p_release_id: parsed.requestId,
      p_reason: parsed.reason, p_request_sha256: await sha256(intent),
    });
    if (error) throw error;
    return respond(request, data || { error: 'release_not_confirmed' }, 200);
  } catch (error) {
    console.error('fund_controls_action_failed', JSON.stringify({ action: parsed.action,
      code: error instanceof Error ? error.name : 'unknown' }));
    return respond(request, { error: 'fund_controls_action_failed' }, 409);
  }
});

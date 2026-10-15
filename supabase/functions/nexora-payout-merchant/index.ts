import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
import { parseMerchantPayoutListRequest } from '../_shared/payout-admin.ts';

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

const headers = (origin: string | null): HeadersInit => ({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? (origin || 'https://www.nexorapay.me') : 'https://www.nexorapay.me',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
});
const respond = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: headers(request.headers.get('origin')) });

Deno.serve(async request => {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') {
    if (origin && !isAllowedOrigin(origin)) return respond(request, { error: 'origin_not_allowed' }, 403);
    return new Response(null, { status: 204, headers: headers(origin) });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
  if (origin && !isAllowedOrigin(origin)) return respond(request, { error: 'origin_not_allowed' }, 403);
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return respond(request, { error: 'authentication_required' }, 401);
  const raw = await readBoundedHttpBody(request, 1024);
  if (raw === null) return respond(request, { error: 'request_too_large' }, 413);
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    body = value as Record<string, unknown>;
  } catch { return respond(request, { error: 'invalid_request' }, 400); }
  const page = parseMerchantPayoutListRequest(body);
  if (!page) return respond(request, { error: 'invalid_request' }, 400);

  const url = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !anonKey || !serviceKey) return respond(request, { error: 'service_unavailable' }, 503);
  const userClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await userClient.auth.getUser(token);
  if (authError || !auth.user) return respond(request, { error: 'authentication_required' }, 401);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data, error } = await admin.rpc('nexora_payout_merchant_list', {
      p_owner_id: auth.user.id, p_business_id: page.businessId, p_limit: 50,
      p_before_created_at: page.beforeCreatedAt, p_before_payout_id: page.beforePayoutId,
    });
    if (error) throw error;
    const payouts = Array.isArray(data) ? data.map(item => ({
      payout_id: item.payout_id,
      amount_cents: item.amount_cents,
      status: item.status,
      created_at: item.created_at,
      updated_at: item.updated_at,
      has_more: item.has_more === true,
    })) : [];
    const last = payouts[payouts.length - 1];
    return respond(request, { payouts, has_more: last?.has_more === true,
      next_cursor: last?.has_more === true ? { before_created_at: last.created_at, before_payout_id: last.payout_id } : null });
  } catch (error) {
    console.error('merchant_payout_list_failed', error instanceof Error ? error.name : 'unknown');
    return respond(request, { error: 'payout_list_unavailable' }, 503);
  }
});

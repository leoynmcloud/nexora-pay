import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
import { maturedReserveRequestHash, parseMaturedReserveRequest, type MaturedReserve } from '../_shared/matured-reserve.ts';

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'authentication_required' }, { status: 401 });

  const raw = await readBoundedHttpBody(request, 1024);
  if (raw === null) return Response.json({ error: 'request_too_large' }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = parseMaturedReserveRequest(input);
  if (!parsed) return Response.json({ error: 'invalid_request' }, { status: 400 });

  const url = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !anonKey || !serviceKey) return Response.json({ error: 'service_unavailable' }, { status: 503 });

  const isServiceCaller = token === serviceKey;
  if (!isServiceCaller) {
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: auth, error: authError } = await userClient.auth.getUser(token);
    if (authError || !auth.user) return Response.json({ error: 'authentication_required' }, { status: 401 });
    const { data: assurance, error: assuranceError } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
    if (assuranceError || assurance?.currentLevel !== 'aal2') return Response.json({ error: 'admin_mfa_required' }, { status: 403 });
    const { data: isAdmin, error: adminError } = await userClient.rpc('is_nexora_super_admin');
    if (adminError || isAdmin !== true) return Response.json({ error: 'admin_mfa_required' }, { status: 403 });
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data: candidates, error: candidatesError } = await admin.rpc('nexora_settlement_matured_reserve_candidates', { p_limit: parsed.limit });
    if (candidatesError) throw candidatesError;
    const reserves = (Array.isArray(candidates) ? candidates : []) as MaturedReserve[];
    if (parsed.action === 'list') return Response.json({ reserves, count: reserves.length });

    const results: Array<{ settlement_id: string; status: 'released' | 'failed'; error?: string }> = [];
    for (const reserve of reserves) {
      try {
        const requestHash = await maturedReserveRequestHash(reserve);
        const { error } = await admin.rpc('nexora_settlement_release_reserve', {
          p_settlement_id: reserve.settlement_id,
          p_request_hash: requestHash,
        });
        if (error) throw error;
        results.push({ settlement_id: reserve.settlement_id, status: 'released' });
      } catch {
        results.push({ settlement_id: reserve.settlement_id, status: 'failed', error: 'reserve_release_failed' });
      }
    }
    const released = results.filter(result => result.status === 'released').length;
    console.info('matured_reserve_batch_completed', JSON.stringify({ selected: reserves.length, released, failed: results.length - released }));
    return Response.json({ selected: reserves.length, released, failed: results.length - released, results });
  } catch (error) {
    console.error('matured_reserve_batch_failed', error instanceof Error ? error.name : 'unknown');
    return Response.json({ error: 'reserve_processing_failed' }, { status: 503 });
  }
});

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
import { parseSettlementReleaseRequest, releaseSettlementBatch, type SettlementCandidate } from '../_shared/settlement-release.ts';

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'authentication_required' }, { status: 401 });
  const raw = await readBoundedHttpBody(request, 1024);
  if (raw === null) return Response.json({ error: 'request_too_large' }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = parseSettlementReleaseRequest(input);
  if (!parsed) return Response.json({ error: 'invalid_request' }, { status: 400 });

  const url = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !anonKey || !serviceKey) return Response.json({ error: 'service_unavailable' }, { status: 503 });
  if (token !== serviceKey) {
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
    const { data, error } = await admin.rpc('nexora_reconciliation_settlement_candidates', {
      p_run_id: parsed.runId || null,
      p_limit: parsed.limit,
    });
    if (error) throw error;
    const candidates = (Array.isArray(data) ? data : []) as SettlementCandidate[];
    const results = await releaseSettlementBatch(candidates, async (candidate, requestHash) => {
      const { data: settlementId, error: releaseError } = await admin.rpc('nexora_settlement_release', {
        p_reconciliation_item_id: candidate.reconciliation_item_id,
        p_request_hash: requestHash,
      });
      if (releaseError || typeof settlementId !== 'string') throw releaseError || new Error('settlement_release_failed');
      return settlementId;
    });
    const released = results.filter(result => result.status === 'released').length;
    console.info('reconciled_settlement_batch_completed', JSON.stringify({
      run_scoped: Boolean(parsed.runId), selected: candidates.length, released, failed: results.length - released,
    }));
    return Response.json({ selected: candidates.length, released, failed: results.length - released, results });
  } catch (error) {
    console.error('reconciled_settlement_batch_failed', error instanceof Error ? error.name : 'unknown');
    return Response.json({ error: 'settlement_processing_failed' }, { status: 503 });
  }
});

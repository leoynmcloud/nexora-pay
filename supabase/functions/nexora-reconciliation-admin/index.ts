import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
import { parseReconciliationAdminRequest } from '../_shared/reconciliation-admin.ts';

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'authentication_required' }, { status: 401 });
  const raw = await readBoundedHttpBody(request, 2048);
  if (raw === null) return Response.json({ error: 'request_too_large' }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = parseReconciliationAdminRequest(input);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { runId, itemsOffset, exceptionsOffset } = parsed.value;

  const url = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !anonKey || !serviceKey) return Response.json({ error: 'service_unavailable' }, { status: 503 });
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

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    if (runId === undefined) {
      const { data, error, count } = await admin.from('nexora_reconciliation_runs')
        .select('id,provider_code,environment,window_start,window_end,statement_complete,entry_count,created_at', { count: 'exact' })
        .order('created_at', { ascending: false }).range(0, 24);
      if (error) throw error;
      return Response.json({ runs: data || [], total: count || 0 });
    }

    const { data: run, error: runError } = await admin.from('nexora_reconciliation_runs')
      .select('id,provider_code,environment,window_start,window_end,statement_complete,statement_sha256,entry_count,created_at')
      .eq('id', runId).maybeSingle();
    if (runError) throw runError;
    if (!run) return Response.json({ error: 'run_not_found' }, { status: 404 });

    const pageSize = 50;
    const [itemsResult, exceptionsResult, matchedResult, divergentResult, incompleteResult] = await Promise.all([
      admin.from('nexora_reconciliation_items')
        .select('id,transaction_id,provider_transaction_id,result,issues,provider_credit_cents,provider_fee_cents,expected_provider_fee_cents,gross_amount_cents,merchant_fee_cents,expected_merchant_net_cents,created_at', { count: 'exact' })
        .eq('run_id', runId).order('created_at', { ascending: true }).range(itemsOffset, itemsOffset + pageSize - 1),
      admin.from('nexora_reconciliation_exceptions')
        .select('id,external_entry_id,provider_transaction_id,issue_code,evidence_sha256,created_at', { count: 'exact' })
        .eq('run_id', runId).order('created_at', { ascending: true }).range(exceptionsOffset, exceptionsOffset + pageSize - 1),
      admin.from('nexora_reconciliation_items').select('id', { count: 'exact', head: true }).eq('run_id', runId).eq('result', 'matched'),
      admin.from('nexora_reconciliation_items').select('id', { count: 'exact', head: true }).eq('run_id', runId).eq('result', 'divergent'),
      admin.from('nexora_reconciliation_items').select('id', { count: 'exact', head: true }).eq('run_id', runId).eq('result', 'incomplete'),
    ]);
    const failed = [itemsResult, exceptionsResult, matchedResult, divergentResult, incompleteResult].find(result => result.error);
    if (failed?.error) throw failed.error;
    return Response.json({
      run,
      items: itemsResult.data || [], items_total: itemsResult.count || 0,
      exceptions: exceptionsResult.data || [], exceptions_total: exceptionsResult.count || 0,
      matched_total: matchedResult.count || 0, divergent_total: divergentResult.count || 0,
      incomplete_total: incompleteResult.count || 0, items_offset: itemsOffset,
      exceptions_offset: exceptionsOffset, page_size: pageSize,
    });
  } catch (error) {
    console.error('reconciliation_admin_read_failed', error instanceof Error ? error.name : 'unknown');
    return Response.json({ error: 'reconciliation_read_failed' }, { status: 503 });
  }
});

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
import { assertClosedStatementDate, fetchAsaasProductionStatement } from '../_shared/asaas-statement-fetch.ts';
import { fetchMercadoPagoProductionStatement } from '../_shared/mercadopago-statement-fetch.ts';
import { asaasConfiguration } from '../_shared/asaas-config.ts';
import { assertPaymentIdentity } from '../_shared/asaas-config.ts';
import { inspectMercadoPagoPixFeeCents } from '../_shared/mercadopago-adapter.ts';
import { decryptProviderCredential } from '../_shared/provider-credentials.ts';
import { providerFinancialSnapshot } from '../_shared/provider-financials.ts';
import { providerAdapterRoute } from '../_shared/provider-registry.ts';
import { buildReconciliationPlan, type ReconciliationSnapshot } from '../_shared/reconciliation-run.ts';
import { zonedDayWindowUtc } from '../_shared/zoned-day-window.ts';
import type { ProviderStatementLine } from '../_shared/reconciliation-core.ts';

const encoder = new TextEncoder();

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function todayInSaoPaulo(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function failureCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : 'statement_import_failed';
}

function integerCents(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function mapConcurrent<T, U>(values: readonly T[], concurrency: number, callback: (value: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await callback(values[index]);
    }
  }));
  return output;
}

async function fetchExpectedProviderFee(apiKey: string, payment: Record<string, unknown>, providerAdapter: 'asaas' | 'mercadopago') {
  const providerId = payment.provider_transaction_id;
  if (typeof providerId !== 'string' || !providerId || typeof payment.external_reference !== 'string'
    || !payment.external_reference || payment.operation_environment !== 'production'
    || (payment.operation_provider_reference && payment.operation_provider_reference !== providerId)) return null;
  if (providerAdapter === 'mercadopago') {
    return inspectMercadoPagoPixFeeCents(apiKey, providerId, {
      transactionId: payment.external_reference,
      amountCents: Number(payment.gross_amount_cents),
    });
  }
  let response: Response;
  try {
    const config = asaasConfiguration('production');
    response = await fetch(`${config.baseUrl}/payments/${encodeURIComponent(providerId)}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json', access_token: apiKey, 'User-Agent': 'NexoraPay/1.0 (reconciliation)' },
    });
  } catch { throw new Error('provider_payment_detail_unavailable'); }
  if (!response.ok) throw new Error('provider_payment_detail_unavailable');
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('provider_payment_detail_invalid');
  const providerPayment = body as Record<string, unknown>;
  assertPaymentIdentity(providerPayment, {
    external_reference: payment.external_reference,
    provider_reference: providerId,
    amount: Number(payment.gross_amount_cents) / 100,
  });
  if (providerPayment.status !== 'RECEIVED') return null;
  try {
    return providerFinancialSnapshot(Number(payment.gross_amount_cents) / 100, providerPayment.netValue).providerFeeCents;
  } catch { return null; }
}

async function readPaymentExpectations(
  admin: ReturnType<typeof createClient>, acquirerId: string, date: string, providerReferences: string[],
) {
  const { start, end } = zonedDayWindowUtc(date, 'America/Sao_Paulo');
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  let expectedTotal: number | null = null;
  while (expectedTotal === null || offset < expectedTotal) {
    const { data, error } = await admin.rpc('nexora_reconciliation_payment_expectations', {
      p_acquirer_id: acquirerId, p_window_start: start, p_window_end: end,
      p_provider_references: providerReferences, p_offset: offset, p_limit: 200,
    });
    if (error || !Array.isArray(data)) throw new Error('reconciliation_expectations_unavailable');
    if (data.length === 0) {
      if (expectedTotal !== null && offset < expectedTotal) throw new Error('reconciliation_expectations_incomplete');
      break;
    }
    const pageTotal = Number(data[0].total_count);
    if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || (expectedTotal !== null && pageTotal !== expectedTotal)) {
      throw new Error('reconciliation_expectations_inconsistent');
    }
    expectedTotal = pageTotal;
    rows.push(...data as Record<string, unknown>[]);
    offset += data.length;
    if (data.length > 200 || offset > pageTotal) throw new Error('reconciliation_expectations_inconsistent');
  }
  return rows;
}

async function compareAndPersistRun(
  admin: ReturnType<typeof createClient>, runId: string, acquirerId: string,
  apiKey: string, date: string, statementLines: readonly ProviderStatementLine[], providerAdapter: 'asaas' | 'mercadopago',
): Promise<{ matched: number; divergent: number; exceptions: number }> {
  const providerReferences = [...new Set(statementLines.map(line => line.providerTransactionId).filter(Boolean))];
  const rawPayments = await readPaymentExpectations(admin, acquirerId, date, providerReferences);
  const paymentReferencesWithCredit = new Set(statementLines
    .filter(line => line.kind === 'payment_credit').map(line => line.providerTransactionId));
  const providerFees = await mapConcurrent(rawPayments, 6, payment =>
    paymentReferencesWithCredit.has(String(payment.provider_transaction_id || ''))
      ? fetchExpectedProviderFee(apiKey, payment, providerAdapter)
      : Promise.resolve(null));
  const payments: ReconciliationSnapshot[] = rawPayments.map((row, index) => ({
    transactionId: String(row.transaction_id || ''),
    businessId: String(row.business_id || ''),
    ownerId: String(row.owner_id || ''),
    providerTransactionId: typeof row.provider_transaction_id === 'string' ? row.provider_transaction_id : '',
    status: String(row.status || ''),
    testMode: row.test_mode === true,
    grossAmountCents: integerCents(row.gross_amount_cents) ?? -1,
    receiptLedgerCents: integerCents(row.receipt_ledger_cents) ?? -1,
    expectedProviderFeeCents: providerFees[index],
    appliedMerchantFeeCents: integerCents(row.applied_merchant_fee_cents),
  }));
  if (payments.some(payment => !payment.transactionId || !payment.businessId || !payment.ownerId)) {
    throw new Error('reconciliation_expectations_invalid');
  }
  const plan = buildReconciliationPlan(payments, statementLines, true);
  const itemRows = await Promise.all(plan.comparisons.map(async ({ payment, lines, result }) => {
    const statementEntryIds = [...new Set(lines.map(line => line.externalEntryId))].sort();
    const resultHash = await sha256(JSON.stringify({
      run_id: runId, transaction_id: payment.transactionId, provider_transaction_id: payment.providerTransactionId,
      status: payment.status, test_mode: payment.testMode,
      statement_entry_ids: statementEntryIds, issues: result.issues,
      provider_credit_cents: result.providerCreditCents, provider_fee_cents: result.providerFeeCents,
      expected_provider_fee_cents: payment.expectedProviderFeeCents,
      gross_amount_cents: payment.grossAmountCents, receipt_ledger_cents: payment.receiptLedgerCents,
      merchant_fee_cents: payment.appliedMerchantFeeCents,
      expected_merchant_net_cents: result.expectedMerchantNetCents,
    }));
    return {
      run_id: runId, transaction_id: payment.transactionId, business_id: payment.businessId, owner_id: payment.ownerId,
      provider_transaction_id: payment.providerTransactionId || `unlinked:${payment.transactionId}`,
      result: result.matched ? 'matched' : 'divergent', issues: result.issues,
      provider_credit_cents: result.providerCreditCents, provider_fee_cents: result.providerFeeCents,
      expected_provider_fee_cents: payment.expectedProviderFeeCents,
      gross_amount_cents: payment.grossAmountCents,
      merchant_fee_cents: payment.appliedMerchantFeeCents,
      expected_merchant_net_cents: result.expectedMerchantNetCents,
      statement_entry_ids: statementEntryIds, result_sha256: resultHash,
    };
  }));

  for (let offset = 0; offset < itemRows.length; offset += 100) {
    const batch = itemRows.slice(offset, offset + 100);
    const { error } = await admin.from('nexora_reconciliation_items')
      .upsert(batch, { onConflict: 'run_id,transaction_id', ignoreDuplicates: true });
    if (error) throw new Error('reconciliation_item_persist_failed');
    const { data, error: readError } = await admin.from('nexora_reconciliation_items')
      .select('transaction_id,result_sha256').eq('run_id', runId)
      .in('transaction_id', batch.map(row => row.transaction_id));
    if (readError || !data || data.length !== batch.length) throw new Error('reconciliation_item_verification_failed');
    const hashes = new Map(data.map(row => [row.transaction_id, row.result_sha256]));
    if (batch.some(row => hashes.get(row.transaction_id) !== row.result_sha256)) {
      throw new Error('reconciliation_result_conflict');
    }
  }

  const exceptionRows = await Promise.all(plan.exceptions.map(async ({ line, issueCode }) => ({
    run_id: runId, external_entry_id: line.externalEntryId,
    provider_transaction_id: line.providerTransactionId || null, issue_code: issueCode,
    evidence_sha256: await sha256(JSON.stringify(line)),
  })));
  for (let offset = 0; offset < exceptionRows.length; offset += 100) {
    const batch = exceptionRows.slice(offset, offset + 100);
    const { error } = await admin.from('nexora_reconciliation_exceptions')
      .upsert(batch, { onConflict: 'run_id,external_entry_id,issue_code', ignoreDuplicates: true });
    if (error) throw new Error('reconciliation_exception_persist_failed');
    const { data, error: readError } = await admin.from('nexora_reconciliation_exceptions')
      .select('external_entry_id,issue_code,evidence_sha256').eq('run_id', runId)
      .in('external_entry_id', batch.map(row => row.external_entry_id));
    if (readError || !data || data.length !== batch.length) throw new Error('reconciliation_exception_verification_failed');
    const hashes = new Map(data.map(row => [`${row.external_entry_id}:${row.issue_code}`, row.evidence_sha256]));
    if (batch.some(row => hashes.get(`${row.external_entry_id}:${row.issue_code}`) !== row.evidence_sha256)) {
      throw new Error('reconciliation_exception_conflict');
    }
  }
  return {
    matched: itemRows.filter(row => row.result === 'matched').length,
    divergent: itemRows.filter(row => row.result !== 'matched').length,
    exceptions: exceptionRows.length,
  };
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'authentication_required' }, { status: 401 });
  const body = await readBoundedHttpBody(request, 1024);
  if (body === null) return Response.json({ error: 'request_too_large' }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(body); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  const requestData = input as Record<string, unknown>;
  const providerCode = requestData.provider_code;
  if (typeof providerCode !== 'string') return Response.json({ error: 'provider_not_supported' }, { status: 400 });
  const adapterRoute = providerAdapterRoute(providerCode);
  if (!adapterRoute || adapterRoute.sandboxOnly) {
    return Response.json({ error: 'provider_not_supported' }, { status: 400 });
  }

  const url = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const encryptionKey = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!url || !anonKey || !serviceKey || !encryptionKey) {
    return Response.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return Response.json({ error: 'authentication_required' }, { status: 401 });
  const { data: assurance, error: assuranceError } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
  if (assuranceError || assurance?.currentLevel !== 'aal2') return Response.json({ error: 'admin_mfa_required' }, { status: 403 });
  const { data: isAdmin, error: adminError } = await userClient.rpc('is_nexora_super_admin');
  if (adminError || isAdmin !== true) return Response.json({ error: 'admin_mfa_required' }, { status: 403 });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const expectedApiBase = adapterRoute.adapter === 'asaas'
    ? asaasConfiguration('production').baseUrl : 'https://api.mercadopago.com';
  const { data: acquirer, error: acquirerError } = await admin.from('nexora_acquirers')
    .select('id,code,api_base_url,environment,status').eq('code', providerCode).maybeSingle();
  if (acquirerError || !acquirer || acquirer.code !== providerCode || acquirer.api_base_url !== expectedApiBase
    || acquirer.environment !== 'production' || acquirer.status !== 'enabled') {
    return Response.json({ error: 'provider_not_configured' }, { status: 503 });
  }
  const { data: storedCredential, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
    .select('api_key_ciphertext').eq('acquirer_id', acquirer.id)
    .eq('environment', 'production').eq('status', 'active').maybeSingle();
  if (credentialError || !storedCredential?.api_key_ciphertext) {
    return Response.json({ error: 'provider_credential_not_configured' }, { status: 503 });
  }
  let providerKey: string;
  try { providerKey = await decryptProviderCredential(storedCredential.api_key_ciphertext, encryptionKey); }
  catch { return Response.json({ error: 'provider_credential_unavailable' }, { status: 503 }); }
  const credentialEnvironmentValid = adapterRoute.adapter === 'asaas'
    ? providerKey.startsWith(asaasConfiguration('production').keyPrefix)
    : /^APP_USR-[A-Za-z0-9_-]{8,}$/.test(providerKey);
  if (!credentialEnvironmentValid) {
    return Response.json({ error: 'provider_credential_environment_mismatch' }, { status: 503 });
  }

  let statementDate: string;
  try { statementDate = assertClosedStatementDate(requestData.date, todayInSaoPaulo()); }
  catch { return Response.json({ error: 'statement_date_not_closed' }, { status: 400 }); }

  try {
    // One platform account, never a browser-provided or merchant credential.
    // No balance or settlement journal is written by this importer.
    const lines = adapterRoute.adapter === 'asaas'
      ? await fetchAsaasProductionStatement(providerKey, statementDate)
      : await fetchMercadoPagoProductionStatement(providerKey, statementDate);
    const rows = await Promise.all(lines.map(async line => ({
      provider_code: adapterRoute.adapter, environment: 'production', external_entry_id: line.externalEntryId,
      provider_transaction_id: line.providerTransactionId || null,
      provider_entry_type: line.providerEntryType,
      entry_kind: line.kind, direction: line.direction, amount_cents: line.amountCents,
      occurred_on: line.providerDate,
      evidence_sha256: await sha256(JSON.stringify(line)),
    })));
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100);
      const { error: insertError } = await admin.from('nexora_provider_statement_entries')
        .upsert(batch, { onConflict: 'provider_code,environment,external_entry_id', ignoreDuplicates: true });
      if (insertError) throw new Error('statement_entry_persist_failed');
      const { data: stored, error: readError } = await admin.from('nexora_provider_statement_entries')
        .select('external_entry_id,evidence_sha256').eq('provider_code', adapterRoute.adapter)
        .eq('environment', 'production').in('external_entry_id', batch.map(row => row.external_entry_id));
      if (readError || !stored || stored.length !== batch.length) throw new Error('statement_entry_verification_failed');
      const byId = new Map(stored.map(row => [row.external_entry_id, row.evidence_sha256]));
      if (batch.some(row => byId.get(row.external_entry_id) !== row.evidence_sha256)) {
        throw new Error('statement_entry_changed');
      }
    }

    const digestSource = rows.map(row => `${row.external_entry_id}:${row.evidence_sha256}`).sort();
    const statementHash = await sha256(JSON.stringify(digestSource));
    const run = { provider_code: adapterRoute.adapter, environment: 'production',
      window_start: statementDate, window_end: statementDate, statement_complete: true,
      statement_sha256: statementHash, entry_count: rows.length };
    const { data: inserted, error: runError } = await admin.from('nexora_reconciliation_runs')
      .insert(run).select('id').maybeSingle();
    let runId = inserted?.id;
    if (runError) {
      if (runError.code !== '23505') throw new Error('statement_run_persist_failed');
      const { data: existing, error: lookupError } = await admin.from('nexora_reconciliation_runs')
        .select('id,entry_count,statement_complete').eq('provider_code', adapterRoute.adapter)
        .eq('environment', 'production').eq('window_start', statementDate).eq('window_end', statementDate)
        .eq('statement_sha256', statementHash).maybeSingle();
      if (lookupError || !existing || !existing.statement_complete || existing.entry_count !== rows.length) {
        throw new Error('statement_run_conflict');
      }
      runId = existing.id;
    }
    if (!runId) throw new Error('statement_run_persist_failed');
    const comparison = await compareAndPersistRun(admin, String(runId), String(acquirer.id), providerKey, statementDate, lines, adapterRoute.adapter);
    return Response.json({ run_id: runId, entries: rows.length, comparison_status: 'completed', ...comparison });
  } catch (error) {
    const code = failureCode(error);
    console.error('provider_statement_import_failed', JSON.stringify({ provider: adapterRoute.adapter, date: statementDate, code }));
    return Response.json({ error: code }, { status: 503 });
  }
});

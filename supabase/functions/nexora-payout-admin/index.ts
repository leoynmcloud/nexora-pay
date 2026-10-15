import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';
import { decryptProviderCredential } from '../_shared/provider-credentials.ts';
import { validateMercadoPagoAccessToken } from '../_shared/mercadopago-credentials.ts';
import { payoutAdapterFor } from '../_shared/payout-connectors.ts';
import { validateMercadoPagoPayoutSigningConfiguration } from '../_shared/mercadopago-payouts.ts';
import { findAsaasPixTransferByReference } from '../_shared/asaas-payouts.ts';
import { parsePayoutAdminRequest } from '../_shared/payout-admin.ts';
import { payoutDispatchState } from '../_shared/payout-dispatch-state.ts';
import type { PixDestination, PixDestinationType, PixPayoutTransfer, PayoutConnectorContext } from '../_shared/payout-provider.ts';

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

async function validateAsaasPayoutCredential(apiKey: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch('https://api.asaas.com/v3/myAccount/status/', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', access_token: apiKey, 'User-Agent': 'NexoraPay/1.0 (payout-preflight)' },
    });
  } catch { return false; }
  try { return response.ok; }
  finally { await response.body?.cancel().catch(() => undefined); }
}

function parseStoredDestination(value: string): { key: string; keyType: PixDestinationType } {
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { throw new Error('stored_destination_invalid'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('stored_destination_invalid');
  const destination = decoded as Record<string, unknown>;
  if (typeof destination.pixAddressKey !== 'string' || typeof destination.pixAddressKeyType !== 'string') {
    throw new Error('stored_destination_invalid');
  }
  return {
    key: destination.pixAddressKey,
    keyType: destination.pixAddressKeyType as PixDestinationType,
  };
}

function adjacentUtcDates(value: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('payout_created_date_invalid');
  const center = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(center.getTime()) || center.toISOString().slice(0, 10) !== value) {
    throw new Error('payout_created_date_invalid');
  }
  return [-1, 0, 1].map(offset => {
    const date = new Date(center);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
}

async function dispatchPayout(request: Request, admin: ReturnType<typeof createClient>, actorId: string,
  payoutId: string, reason: string) {
  if (Deno.env.get('NEXORA_PAYOUT_DISPATCH_ENABLED') !== 'true') {
    return respond(request, { error: 'payout_dispatch_disabled' }, 409);
  }
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const providerEncryptionKey = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  const destinationEncryptionKey = Deno.env.get('NEXORA_PAYOUT_DESTINATION_ENCRYPTION_KEY_V1') || '';
  if (!serviceKey || !providerEncryptionKey || !destinationEncryptionKey) {
    return respond(request, { error: 'payout_dispatch_configuration_missing' }, 503);
  }

  // Read and validate all local prerequisites before the one-way claim.
  const { data: payout, error: payoutError } = await admin.from('nexora_payouts')
    .select('id,status,amount_cents,destination_ciphertext,destination_type,destination_sha256,provider_code,adapter_code,environment,provider_credential_id,external_reference,acquirer_id,provider_batch_id,provider_transfer_id')
    .eq('id', payoutId).maybeSingle();
  if (payoutError) throw new Error('payout_lookup_failed');
  if (!payout) return respond(request, { error: 'payout_not_found' }, 404);
  if (payout.status !== 'APPROVED' || payout.provider_batch_id || payout.provider_transfer_id) {
    return respond(request, { error: 'payout_not_ready_for_dispatch' }, 409);
  }
  if (payout.environment !== 'production') return respond(request, { error: 'payout_environment_not_allowed' }, 409);

  const adapter = payoutAdapterFor(payout.adapter_code);
  if (!adapter) return respond(request, { error: 'payout_adapter_unavailable' }, 409);
  const { data: acquirer, error: acquirerError } = await admin.from('nexora_acquirers')
    .select('id,code,api_base_url,environment,status').eq('id', payout.acquirer_id).maybeSingle();
  if (acquirerError || !acquirer || acquirer.code !== payout.provider_code
    || acquirer.environment !== 'production' || acquirer.status !== 'enabled') {
    return respond(request, { error: 'payout_provider_unavailable' }, 409);
  }
  const allowedBase = acquirer.code === 'asaas_production'
    ? 'https://api.asaas.com/v3'
    : acquirer.code === 'mercadopago_production' ? 'https://api.mercadopago.com' : '';
  if (!allowedBase || acquirer.api_base_url !== allowedBase
    || (acquirer.code === 'asaas_production' && payout.adapter_code !== 'asaas')
    || (acquirer.code === 'mercadopago_production' && payout.adapter_code !== 'mercadopago')) {
    return respond(request, { error: 'payout_provider_adapter_mismatch' }, 409);
  }
  const { data: credential, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
    .select('api_key_ciphertext,environment,status').eq('id', payout.provider_credential_id).maybeSingle();
  if (credentialError || !credential || credential.environment !== 'production' || credential.status !== 'active') {
    return respond(request, { error: 'payout_credential_unavailable' }, 409);
  }

  let providerCredential: string;
  let destination: { key: string; keyType: PixDestinationType };
  try {
    const decrypted = await Promise.all([
      decryptProviderCredential(credential.api_key_ciphertext, providerEncryptionKey),
      decryptProviderCredential(payout.destination_ciphertext, destinationEncryptionKey).then(parseStoredDestination),
    ] as const);
    providerCredential = decrypted[0];
    destination = decrypted[1];
  } catch { return respond(request, { error: 'payout_secret_unavailable' }, 503); }

  if (acquirer.code === 'asaas_production' && !providerCredential.startsWith('$aact_prod_')) {
    return respond(request, { error: 'payout_credential_environment_mismatch' }, 409);
  }
  if (acquirer.code === 'asaas_production' && !(await validateAsaasPayoutCredential(providerCredential))) {
    return respond(request, { error: 'payout_credential_validation_failed' }, 409);
  }
  if (acquirer.code === 'mercadopago_production' && !providerCredential.startsWith('APP_USR-')) {
    return respond(request, { error: 'payout_credential_environment_mismatch' }, 409);
  }
  let normalizedDestination: PixDestination;
  try { normalizedDestination = adapter.normalizeDestination(destination); }
  catch { return respond(request, { error: 'payout_destination_invalid' }, 409); }
  if (destination.keyType !== payout.destination_type
    || await sha256(`${normalizedDestination.keyType}:${normalizedDestination.key}`) !== payout.destination_sha256) {
    return respond(request, { error: 'payout_destination_integrity_failed' }, 409);
  }
  if (!Number.isSafeInteger(Number(payout.amount_cents)) || Number(payout.amount_cents) <= 0) {
    return respond(request, { error: 'payout_amount_invalid' }, 409);
  }

  const context: PayoutConnectorContext = {
    apiBaseUrl: allowedBase,
    credential: providerCredential,
    environment: 'production',
    ...(acquirer.code === 'mercadopago_production' ? {
      signingPrivateKeyPem: Deno.env.get('NEXORA_MERCADOPAGO_PAYOUT_SIGNING_KEY') || '',
      notificationUrl: Deno.env.get('NEXORA_MERCADOPAGO_PAYOUT_NOTIFICATION_URL') || '',
    } : {}),
  };
  if (acquirer.code === 'mercadopago_production') {
    const callbackToken = Deno.env.get('NEXORA_MERCADOPAGO_PAYOUT_WEBHOOK_TOKEN') || '';
    let callbackUrl: URL | null = null;
    try { callbackUrl = new URL(context.notificationUrl || ''); } catch { /* fail closed below */ }
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(callbackToken)
      || callbackUrl?.searchParams.get('token') !== callbackToken) {
      return respond(request, { error: 'payout_callback_configuration_invalid' }, 503);
    }
    try { await validateMercadoPagoAccessToken(providerCredential, 'production'); }
    catch { return respond(request, { error: 'payout_credential_validation_failed' }, 409); }
    try { await validateMercadoPagoPayoutSigningConfiguration(context); }
    catch { return respond(request, { error: 'payout_signing_configuration_invalid' }, 503); }
  }

  const { data: claim, error: claimError } = await admin.rpc('nexora_payout_dispatch_claim', {
    p_actor_id: actorId,
    p_payout_id: payoutId,
    p_reason: reason,
  });
  if (claimError) {
    const text = String(claimError.message || '');
    const disabled = text.includes('Real payout dispatch is disabled');
    return respond(request, { error: disabled ? 'payout_dispatch_disabled' : 'payout_claim_failed' }, disabled ? 409 : 409);
  }
  const claimed = Array.isArray(claim) ? claim[0] : claim;
  if (claimed?.payout_id !== payoutId || claimed?.status !== 'OUTCOME_UNKNOWN') {
    return respond(request, { error: 'payout_claim_failed' }, 409);
  }

  const amountCents = Number(payout.amount_cents);
  let transfer: PixPayoutTransfer;
  try {
    transfer = await adapter.createTransfer(context, {
      amountCents,
      externalReference: payout.external_reference,
      idempotencyKey: payout.external_reference,
      description: `Nexora payout ${payout.id.slice(0, 8)}`,
      destination: normalizedDestination,
    });
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
      ? error.message : 'provider_outcome_unknown';
    const detail = error instanceof Error && (error as any).body ? String((error as any).body) : null;
    const httpStatus = error instanceof Error && (error as any).status ? (error as any).status : null;
    console.error('payout_dispatch_outcome_unknown', JSON.stringify({ payout_id: payoutId, adapter: payout.adapter_code, code, detail }));
    try {
      await admin.from('nexora_payout_debug_logs').insert({
        payout_id: payoutId, status_code: httpStatus, response_body: String(detail || (error instanceof Error ? error.message : error)).slice(0, 4000),
      });
    } catch (_) {}
    try { await admin.from('nexora_payouts').update({ failure_code: code }).eq('id', payoutId); } catch (_) {}
    return respond(request, { status: 'OUTCOME_UNKNOWN', verification_required: true, failure_code: code, error_detail: detail }, 202);
  }

  const eventEvidence = JSON.stringify({
    payout_id: payoutId, provider_batch_id: transfer.providerBatchId || null,
    provider_transfer_id: transfer.providerTransactionId, amount_cents: transfer.amountCents,
    external_reference: transfer.externalReference, provider_status: transfer.providerStatus,
  });
  const { data: applied, error: applyError } = await admin.rpc('nexora_payout_apply_provider_event', {
    p_provider_code: payout.provider_code,
    p_external_reference: payout.external_reference,
    p_provider_event_id: `nexora-dispatch:${payoutId}`,
    p_provider_event_type: 'PAYOUT_DISPATCH_ACCEPTED',
    p_provider_transfer_id: transfer.providerTransactionId,
    p_raw_provider_status: transfer.providerStatus.slice(0, 80),
    p_normalized_status: transfer.status === 'FAILED' ? 'FAILED'
      : transfer.status === 'COMPLETED' ? 'COMPLETED'
        : transfer.status === 'PROCESSING' ? 'PROCESSING' : 'RISK_REVIEW',
    p_amount_cents: transfer.amountCents,
    p_payload_sha256: await sha256(eventEvidence),
    p_provider_batch_id: transfer.providerBatchId || null,
  });
  if (applyError) {
    // The provider may have accepted the payment. Leave the ledger reserved;
    // the signed/token-protected provider callback can correlate by our ref.
    console.error('payout_dispatch_persist_deferred', JSON.stringify({ payout_id: payoutId, code: 'provider_result_persist_failed' }));
    return respond(request, { status: 'OUTCOME_UNKNOWN', verification_required: true }, 202);
  }
  const finalStatus = typeof applied === 'string' ? applied : transfer.status;
  return respond(request, { status: finalStatus, verification_required: finalStatus === 'OUTCOME_UNKNOWN' }, 202);
}

/** A manual status refresh only performs provider GETs; it never creates a transfer. */
async function reconcilePayout(request: Request, admin: ReturnType<typeof createClient>, actorId: string,
  payoutId: string, reason: string) {
  const { data: payout, error: payoutError } = await admin.from('nexora_payouts')
    .select('id,status,amount_cents,created_at,provider_code,adapter_code,environment,provider_credential_id,external_reference,acquirer_id,provider_batch_id,provider_transfer_id')
    .eq('id', payoutId).maybeSingle();
  if (payoutError) throw new Error('payout_lookup_failed');
  if (!payout) return respond(request, { error: 'payout_not_found' }, 404);
  if (!['OUTCOME_UNKNOWN', 'PROCESSING', 'RISK_REVIEW'].includes(payout.status)) {
    return respond(request, { error: 'payout_not_reconcilable' }, 409);
  }
  if ((payout.adapter_code !== 'asaas' && !payout.provider_transfer_id)
    || (payout.adapter_code === 'mercadopago' && (!payout.provider_batch_id || !payout.provider_transfer_id))) {
    return respond(request, { error: 'payout_provider_identity_missing', manual_provider_lookup_required: true }, 409);
  }
  const adapter = payoutAdapterFor(payout.adapter_code);
  if (!adapter) return respond(request, { error: 'payout_adapter_unavailable' }, 409);
  const { data: acquirer, error: acquirerError } = await admin.from('nexora_acquirers')
    .select('code,api_base_url,environment').eq('id', payout.acquirer_id).maybeSingle();
  const allowedBase = payout.provider_code === 'asaas_production'
    ? 'https://api.asaas.com/v3'
    : payout.provider_code === 'mercadopago_production' ? 'https://api.mercadopago.com' : '';
  if (acquirerError || !acquirer || acquirer.code !== payout.provider_code
    || acquirer.environment !== 'production' || acquirer.api_base_url !== allowedBase || !allowedBase) {
    return respond(request, { error: 'payout_provider_unavailable' }, 409);
  }
  const { data: credential, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
    .select('api_key_ciphertext,environment,status').eq('id', payout.provider_credential_id).maybeSingle();
  if (credentialError || !credential || credential.environment !== 'production' || credential.status !== 'active') {
    return respond(request, { error: 'payout_credential_unavailable' }, 409);
  }
  const encryptionKey = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!encryptionKey) return respond(request, { error: 'payout_dispatch_configuration_missing' }, 503);
  let providerCredential: string;
  try { providerCredential = await decryptProviderCredential(credential.api_key_ciphertext, encryptionKey); }
  catch { return respond(request, { error: 'payout_secret_unavailable' }, 503); }
  if ((payout.provider_code === 'asaas_production' && !providerCredential.startsWith('$aact_prod_'))
    || (payout.provider_code === 'mercadopago_production' && !providerCredential.startsWith('APP_USR-'))) {
    return respond(request, { error: 'payout_credential_environment_mismatch' }, 409);
  }

  const context: PayoutConnectorContext = {
    apiBaseUrl: allowedBase,
    credential: providerCredential,
    environment: 'production',
    ...(payout.adapter_code === 'mercadopago' ? {
      signingPrivateKeyPem: Deno.env.get('NEXORA_MERCADOPAGO_PAYOUT_SIGNING_KEY') || '',
      notificationUrl: Deno.env.get('NEXORA_MERCADOPAGO_PAYOUT_NOTIFICATION_URL') || '',
    } : {}),
  };
  let transfer: PixPayoutTransfer;
  try {
    if (payout.provider_transfer_id) {
      transfer = await adapter.getTransfer(context, {
        providerTransactionId: payout.provider_transfer_id,
        providerBatchId: payout.provider_batch_id || undefined,
        amountCents: Number(payout.amount_cents),
        externalReference: payout.external_reference,
      });
    } else {
      // Asaas can recover by a closed creation-date window, but accepts the
      // result only when exactly one transfer matches our immutable reference
      // and amount. Mercado Pago requires the batch + transaction IDs.
      if (payout.adapter_code !== 'asaas' || payout.provider_code !== 'asaas_production') {
        return respond(request, { error: 'payout_provider_identity_missing', manual_provider_lookup_required: true }, 409);
      }
      const recoveredMatches: PixPayoutTransfer[] = [];
      for (const createdDate of adjacentUtcDates(String(payout.created_at || '').slice(0, 10))) {
        const recovered = await findAsaasPixTransferByReference({
          baseUrl: allowedBase,
          apiKey: providerCredential,
          amountCents: Number(payout.amount_cents),
          externalReference: payout.external_reference,
          createdDate,
        });
        if (recovered) recoveredMatches.push(recovered);
      }
      const distinctMatches = new Map(recoveredMatches.map(item => [item.providerTransactionId, item]));
      if (distinctMatches.size > 1) throw new Error('payout_reference_ambiguous');
      const recovered = [...distinctMatches.values()][0] || null;
      if (!recovered) return respond(request, {
        status: payout.status, found: false, read_only: true,
        message: 'Nenhuma transferência única com referência e valor exatos foi encontrada; o status permanece inalterado.',
      }, 202);
      transfer = recovered;
    }
  } catch {
    return respond(request, { error: 'payout_provider_status_unavailable', status_unchanged: true }, 502);
  }
  const eventId = `nexora-admin-reconcile:${crypto.randomUUID()}`;
  const eventEvidence = JSON.stringify({
    actor_id: actorId, payout_id: payoutId, provider_batch_id: transfer.providerBatchId || null,
    provider_transfer_id: transfer.providerTransactionId, amount_cents: transfer.amountCents,
    external_reference: transfer.externalReference, provider_status: transfer.providerStatus,
  });
  const { data: status, error } = await admin.rpc('nexora_payout_admin_reconcile_event', {
    p_actor_id: actorId,
    p_payout_id: payoutId,
    p_reason: reason,
    p_provider_code: payout.provider_code,
    p_provider_event_id: eventId,
    p_provider_event_type: 'PAYOUT_MANUAL_RECONCILIATION',
    p_provider_batch_id: transfer.providerBatchId || null,
    p_provider_transfer_id: transfer.providerTransactionId,
    p_raw_provider_status: transfer.providerStatus.slice(0, 80),
    p_normalized_status: transfer.status === 'FAILED' ? 'FAILED'
      : transfer.status === 'COMPLETED' ? 'COMPLETED'
        : transfer.status === 'PROCESSING' ? 'PROCESSING' : 'RISK_REVIEW',
    p_amount_cents: transfer.amountCents,
    p_payload_sha256: await sha256(eventEvidence),
  });
  if (error) throw new Error('payout_reconciliation_persist_failed');
  return respond(request, { status, read_only: true }, 200);
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
  const raw = await readBoundedHttpBody(request, 2048);
  if (raw === null) return respond(request, { error: 'request_too_large' }, 413);
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return respond(request, { error: 'invalid_json' }, 400); }
  const parsed = parsePayoutAdminRequest(input);
  if (!parsed) return respond(request, { error: 'invalid_request' }, 400);
  const { action } = parsed;

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
    if (action === 'list') {
      const { data, error } = await admin.rpc('nexora_payout_admin_list', { p_actor_id: auth.user.id, p_limit: 100 });
      if (error) throw error;
      const { data: runtime, error: runtimeError } = await admin.from('nexora_payout_runtime')
        .select('production_enabled').eq('id', true).maybeSingle();
      const dispatchState = payoutDispatchState(
        runtimeError || !runtime ? null : runtime.production_enabled,
        Deno.env.get('NEXORA_PAYOUT_DISPATCH_ENABLED'),
      );
      const destinationEncryptionKey = Deno.env.get('NEXORA_PAYOUT_DESTINATION_ENCRYPTION_KEY_V1') || '';
      const payouts = await Promise.all((data || []).map(async (item: any) => {
        let pixKey = '';
        let pixKeyType = item.destination_type || '';
        if (item.destination_ciphertext && destinationEncryptionKey) {
          try {
            const dest = await decryptProviderCredential(item.destination_ciphertext, destinationEncryptionKey).then(parseStoredDestination);
            pixKey = dest.key;
            pixKeyType = dest.keyType;
          } catch (_) {}
        }
        return {
          ...item,
          pix_key: pixKey,
          pix_key_type: pixKeyType,
          destination_ciphertext: undefined,
        };
      }));
      return respond(request, {
        payouts,
        dispatch_enabled: dispatchState === 'enabled',
        dispatch_state: dispatchState,
      });
    }
    const { payoutId, reason } = parsed;
    if (action === 'complete_manual') {
      const { providerTransferId } = parsed;
      const intent = JSON.stringify({ actor_id: auth.user.id, payout_id: payoutId, action: 'complete_manual', provider_transfer_id: providerTransferId, reason });
      const { data, error } = await admin.rpc('nexora_payout_admin_complete_manual', {
        p_actor_id: auth.user.id,
        p_payout_id: payoutId,
        p_provider_transfer_id: providerTransferId,
        p_reason: reason,
        p_request_sha256: await sha256(intent),
      });
      if (error) throw error;
      return respond(request, { status: data });
    }
    if (action === 'dispatch') return await dispatchPayout(request, admin, auth.user.id, payoutId, reason);
    if (action === 'reconcile') return await reconcilePayout(request, admin, auth.user.id, payoutId, reason);
    const decision = action;
    const intent = JSON.stringify({ actor_id: auth.user.id, payout_id: payoutId, decision, reason });
    const { data, error } = await admin.rpc('nexora_payout_admin_review', {
      p_actor_id: auth.user.id,
      p_payout_id: payoutId,
      p_decision: decision,
      p_reason: reason,
      p_request_sha256: await sha256(intent),
    });
    if (error) throw error;
    return respond(request, { status: data });
  } catch (error) {
    console.error('payout_admin_action_failed', JSON.stringify({ action, code: error instanceof Error ? error.name : 'unknown' }));
    return respond(request, { error: 'payout_admin_action_failed' }, 409);
  }
});

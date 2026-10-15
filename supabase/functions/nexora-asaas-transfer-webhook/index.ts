import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { decryptProviderCredential } from '../_shared/provider-credentials.ts';
import {
  getAsaasPixTransfer,
  getAsaasPixTransferById,
  parseAsaasTransferWebhookNotice,
  type AsaasPayoutResult,
} from '../_shared/asaas-payouts.ts';

const encoder = new TextEncoder();

function equalSecret(received: string, expected: string) {
  if (received.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < received.length; i++) difference |= received.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

async function readBoundedBody(request: Request, maxBytes: number) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const expected = Deno.env.get('NEXORA_ASAAS_TRANSFER_WEBHOOK_TOKEN') || '';
  const received = request.headers.get('asaas-access-token') || '';
  if (expected.length < 32 || expected.length > 255 || /\s/.test(expected) || !equalSecret(received, expected)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const rawBody = await readBoundedBody(request, 65536);
  if (rawBody === null) return new Response('Payload too large', { status: 413 });
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return new Response('Invalid JSON', { status: 400 }); }
  let notice;
  try { notice = parseAsaasTransferWebhookNotice(payload); }
  catch { return new Response('Invalid transfer event', { status: 400 }); }

  const projectUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const encryptionKey = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!projectUrl || !serviceKey || !encryptionKey) return new Response('Service unavailable', { status: 503 });
  const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    let payout: Record<string, unknown> | null = null;
    let payoutLookup = await admin.from('nexora_payouts')
      .select('id,amount_cents,provider_code,adapter_code,provider_credential_id,provider_transfer_id,external_reference,status')
      .eq(notice.externalReference ? 'external_reference' : 'provider_transfer_id',
        notice.externalReference || notice.providerTransactionId).maybeSingle();
    if (payoutLookup.error) throw new Error('payout_lookup_failed');
    if (!payoutLookup.data && notice.externalReference) {
      payoutLookup = await admin.from('nexora_payouts')
        .select('id,amount_cents,provider_code,adapter_code,provider_credential_id,provider_transfer_id,external_reference,status')
        .eq('provider_transfer_id', notice.providerTransactionId).maybeSingle();
      if (payoutLookup.error) throw new Error('payout_lookup_failed');
    }
    payout = payoutLookup.data;
    // This Asaas account may emit other transfer events; unrelated transfers
    // are acknowledged but can never be attached without API-side correlation.
    let current: AsaasPayoutResult;
    if (payout) {
      if (payout.provider_code !== 'asaas_production' || payout.adapter_code !== 'asaas'
        || (payout.provider_transfer_id && payout.provider_transfer_id !== notice.providerTransactionId)) {
        throw new Error('payout_provider_identity_mismatch');
      }
      const { data: credential, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
        .select('api_key_ciphertext,environment,status').eq('id', payout.provider_credential_id).maybeSingle();
      if (credentialError || !credential || credential.environment !== 'production' || credential.status === 'disabled') {
        throw new Error('payout_credential_unavailable');
      }
      const apiKey = await decryptProviderCredential(credential.api_key_ciphertext, encryptionKey);
      if (!apiKey.startsWith('$aact_prod_')) throw new Error('stored_key_environment_mismatch');
      current = await getAsaasPixTransfer({
        baseUrl: 'https://api.asaas.com/v3', apiKey,
        providerTransactionId: notice.providerTransactionId,
        amountCents: Number(payout.amount_cents),
        externalReference: String(payout.external_reference || notice.externalReference || ''),
      });
    } else if (notice.externalReference) {
      // Known non-Nexora reference: acknowledge unrelated events without writes.
      return new Response('OK', { status: 200 });
    } else {
      // Asaas transfer notifications identify transfer.id; externalReference is
      // not guaranteed in the event payload. Resolve it once via the provider.
      const { data: acquirer, error: acquirerError } = await admin.from('nexora_acquirers')
        .select('id').eq('code', 'asaas_production').eq('environment', 'production').maybeSingle();
      if (acquirerError || !acquirer) throw new Error('payout_provider_unavailable');
      const { data: credential, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
        .select('api_key_ciphertext').eq('acquirer_id', acquirer.id).eq('environment', 'production')
        .eq('status', 'active').maybeSingle();
      if (credentialError || !credential?.api_key_ciphertext) throw new Error('payout_credential_unavailable');
      const apiKey = await decryptProviderCredential(credential.api_key_ciphertext, encryptionKey);
      if (!apiKey.startsWith('$aact_prod_')) throw new Error('stored_key_environment_mismatch');
      current = await getAsaasPixTransferById({
        baseUrl: 'https://api.asaas.com/v3', apiKey, providerTransactionId: notice.providerTransactionId,
      });
      if (!/^NX-PAYOUT-[A-Za-z0-9-]{16,80}$/.test(current.externalReference)) {
        return new Response('OK', { status: 200 });
      }
      const resolved = await admin.from('nexora_payouts').select(
        'id,amount_cents,provider_code,adapter_code,provider_credential_id,provider_transfer_id,external_reference,status',
      ).eq('external_reference', current.externalReference).maybeSingle();
      if (resolved.error) throw new Error('payout_lookup_failed');
      payout = resolved.data;
      if (!payout) return new Response('OK', { status: 200 });
    }
    if (!payout || payout.provider_code !== 'asaas_production' || payout.adapter_code !== 'asaas'
      || payout.external_reference !== current.externalReference
      || Number(payout.amount_cents) !== current.amountCents
      || (payout.provider_transfer_id && payout.provider_transfer_id !== current.providerTransactionId)
      || (notice.externalReference && notice.externalReference !== current.externalReference)) {
      throw new Error('payout_provider_identity_mismatch');
    }
    // The GET response is authoritative. A blocked event remains under review
    // unless the provider has since reached a terminal state.
    const liveStatus = current.status === 'PROCESSING' && notice.eventType === 'TRANSFER_BLOCKED'
      ? 'RISK_REVIEW' : current.status;
    const payloadHash = await sha256(rawBody);
    const { error: applyError } = await admin.rpc('nexora_payout_apply_provider_event', {
      p_provider_code: payout.provider_code,
      p_external_reference: current.externalReference,
      p_provider_event_id: notice.eventId,
      p_provider_event_type: notice.eventType,
      p_provider_transfer_id: current.providerTransactionId,
      p_raw_provider_status: current.providerStatus,
      p_normalized_status: liveStatus,
      p_amount_cents: current.amountCents,
      p_payload_sha256: payloadHash,
    });
    if (applyError) throw new Error('payout_event_persist_failed');
    return new Response('OK', { status: 200 });
  } catch (error) {
    const candidate = error instanceof Error ? error.message : '';
    const code = /^[a-z0-9_]{1,80}$/.test(candidate) ? candidate : 'payout_webhook_processing_failed';
    console.error('asaas_transfer_webhook_processing_failed', JSON.stringify({ event_id: notice.eventId, code }));
    return new Response('Retry later', { status: 503, headers: { 'Retry-After': '60' } });
  }
});

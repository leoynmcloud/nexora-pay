import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { decryptProviderCredential } from '../_shared/provider-credentials.ts';
import { getMercadoPagoPixTransfer } from '../_shared/mercadopago-payouts.ts';
import { parseMercadoPagoPayoutNotice } from '../_shared/mercadopago-payout-webhook.ts';

const encoder = new TextEncoder();

function equalSecret(received: string, expected: string) {
  if (!received || received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function readBoundedBody(request: Request, maxBytes: number) {
  if (Number(request.headers.get('content-length') || 0) > maxBytes) return null;
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
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const webhookToken = Deno.env.get('NEXORA_MERCADOPAGO_PAYOUT_WEBHOOK_TOKEN') || '';
  let requestUrl: URL;
  try { requestUrl = new URL(request.url); }
  catch { return new Response('Unauthorized', { status: 401 }); }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(webhookToken)
    || !equalSecret(requestUrl.searchParams.get('token') || '', webhookToken)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let rawBody: string | null;
  try { rawBody = await readBoundedBody(request, 65536); }
  catch { return new Response('Invalid body', { status: 400 }); }
  if (rawBody === null) return new Response('Payload too large', { status: 413 });
  let payload: unknown;
  try { payload = JSON.parse(rawBody); }
  catch { return new Response('Invalid JSON', { status: 400 }); }
  let notice;
  try { notice = await parseMercadoPagoPayoutNotice(payload); }
  catch { return new Response('Invalid payout notification', { status: 400 }); }

  const projectUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const encryptionKey = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  const signingPrivateKeyPem = Deno.env.get('NEXORA_MERCADOPAGO_PAYOUT_SIGNING_KEY') || '';
  const notificationUrl = Deno.env.get('NEXORA_MERCADOPAGO_PAYOUT_NOTIFICATION_URL') || '';
  if (!projectUrl || !serviceKey || !encryptionKey || !signingPrivateKeyPem || !notificationUrl) {
    return new Response('Service unavailable', { status: 503 });
  }
  let configuredCallback: URL;
  try { configuredCallback = new URL(notificationUrl); }
  catch { return new Response('Service unavailable', { status: 503 }); }
  if (configuredCallback.origin !== requestUrl.origin || configuredCallback.pathname !== requestUrl.pathname
    || !equalSecret(configuredCallback.searchParams.get('token') || '', webhookToken)) {
    return new Response('Service unavailable', { status: 503 });
  }

  const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const { data: payout, error: payoutError } = await admin.from('nexora_payouts')
      .select('id,amount_cents,provider_code,adapter_code,provider_credential_id,provider_batch_id,provider_transfer_id,external_reference')
      .eq('provider_code', 'mercadopago_production')
      .eq('adapter_code', 'mercadopago')
      .eq('external_reference', notice.externalReference)
      .maybeSingle();
    if (payoutError) throw new Error('payout_lookup_failed');
    // A valid but unrelated notification is acknowledged without database writes.
    if (!payout) return new Response('OK', { status: 200 });
    if ((payout.provider_batch_id && payout.provider_batch_id !== notice.providerBatchId)
      || (payout.provider_transfer_id && payout.provider_transfer_id !== notice.providerTransactionId)) {
      throw new Error('payout_provider_identity_mismatch');
    }

    const { data: acquirer, error: acquirerError } = await admin.from('nexora_acquirers')
      .select('id,code,api_base_url,environment').eq('code', 'mercadopago_production').maybeSingle();
    if (acquirerError || !acquirer || acquirer.api_base_url !== 'https://api.mercadopago.com'
      || acquirer.environment !== 'production') throw new Error('payout_provider_unavailable');
    const { data: credential, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
      .select('api_key_ciphertext,environment,status').eq('id', payout.provider_credential_id).maybeSingle();
    if (credentialError || !credential || credential.environment !== 'production' || credential.status !== 'active') {
      throw new Error('payout_credential_unavailable');
    }
    const accessToken = await decryptProviderCredential(credential.api_key_ciphertext, encryptionKey);
    if (!accessToken.startsWith('APP_USR-')) throw new Error('stored_key_environment_mismatch');

    // The notification is only a trigger. Authenticated GET is authoritative.
    const current = await getMercadoPagoPixTransfer({
      apiBaseUrl: 'https://api.mercadopago.com',
      credential: accessToken,
      environment: 'production',
      signingPrivateKeyPem,
      notificationUrl,
    }, {
      providerBatchId: notice.providerBatchId,
      providerTransactionId: notice.providerTransactionId,
      amountCents: Number(payout.amount_cents),
      externalReference: String(payout.external_reference),
    });
    if (current.providerBatchId !== payout.provider_batch_id
      || current.providerTransactionId !== payout.provider_transfer_id
      || current.externalReference !== payout.external_reference
      || current.amountCents !== Number(payout.amount_cents)) throw new Error('payout_provider_identity_mismatch');

    const payloadHash = await sha256(rawBody);
    const { error: applyError } = await admin.rpc('nexora_payout_apply_provider_event', {
      p_provider_code: 'mercadopago_production',
      p_external_reference: current.externalReference,
      p_provider_event_id: notice.eventId,
      p_provider_event_type: notice.eventType,
      p_provider_transfer_id: current.providerTransactionId,
      p_raw_provider_status: current.providerStatus,
      p_normalized_status: current.status,
      p_amount_cents: current.amountCents,
      p_payload_sha256: payloadHash,
      p_provider_batch_id: current.providerBatchId,
    });
    if (applyError) throw new Error('payout_event_persist_failed');
    return new Response('OK', { status: 200 });
  } catch (error) {
    const candidate = error instanceof Error ? error.message : '';
    const code = /^[a-z0-9_]{1,80}$/.test(candidate) ? candidate : 'payout_webhook_processing_failed';
    console.error('mercadopago_payout_webhook_failed', JSON.stringify({ event_id: notice.eventId, code }));
    return new Response('Retry later', { status: 503, headers: { 'Retry-After': '60' } });
  }
});


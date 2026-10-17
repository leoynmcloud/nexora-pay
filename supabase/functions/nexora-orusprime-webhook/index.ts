import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { decryptProviderCredential } from '../_shared/provider-credentials.ts';
import { webhookRetryAfterSeconds, webhookRetryDelayMs } from '../_shared/payment-provider.ts';
import { processOrusPrimePaymentWebhook } from '../_shared/orusprime-webhook-core.ts';

const encoder = new TextEncoder();

async function readBoundedBody(request: Request, maxBytes = 65536) {
  if (Number(request.headers.get('content-length') || 0) > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
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
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function sha256(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function safeErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : '';
  return /^[a-z0-9_]{1,80}$/.test(value) ? value : 'webhook_processing_failed';
}

async function triggerMerchantWebhookWorker(projectUrl: string, serviceKey: string) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${projectUrl.replace(/\/$/, '')}/functions/v1/nexora-webhook-deliveries`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!response.ok) console.error('merchant_webhook_worker_deferred', JSON.stringify({ http_status: response.status }));
  } catch (error) {
    console.error('merchant_webhook_worker_deferred', JSON.stringify({ code: error instanceof Error && error.name === 'AbortError' ? 'worker_timeout' : 'worker_unavailable' }));
  } finally { clearTimeout(timer); }
}

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const rawBody = await readBoundedBody(request);
  if (rawBody === null) return new Response('Payload too large', { status: 413 });
  let payload: Record<string, any>;
  try { payload = JSON.parse(rawBody); } catch { return new Response('Invalid JSON', { status: 400 }); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return new Response('Invalid payload', { status: 400 });

  const transactionObj = (payload.transaction && typeof payload.transaction === 'object') ? payload.transaction : null;
  const providerTransactionId = String(
    transactionObj?.id || payload.transactionId || payload.id || ''
  );
  if (!providerTransactionId || providerTransactionId.length > 255) return new Response('Invalid transaction id', { status: 400 });

  const eventName = String(payload.event || transactionObj?.status || 'TRANSACTION_PAID');
  const eventId = `orusprime:${providerTransactionId}:${eventName}`;
  const eventType = `payment.${eventName.toLowerCase().replace(/^transaction_/, '')}`;

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const encryptionKey = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!supabaseUrl || !serviceKey || !encryptionKey) {
    return new Response('Service unavailable', { status: 503 });
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const normalizedType = eventType.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
  const payloadHash = await sha256(rawBody);

  let inboxId: number | null = null, attemptNumber = 1;
  try {
    const { data: isNew, error: acceptError } = await admin.rpc('nexora_provider_accept_webhook', {
      p_provider_code: 'orusprime_production',
      p_external_event_id: eventId,
      p_external_transaction_id: providerTransactionId,
      p_normalized_event_type: normalizedType,
      p_payload_sha256: payloadHash,
    });
    if (acceptError) throw new Error('webhook_inbox_persist_failed');
    const { data: inbox, error: inboxError } = await admin.from('nexora_provider_webhook_inbox')
      .select('id,status,attempts,next_attempt_at').eq('provider_code', 'orusprime_production')
      .eq('external_event_id', eventId).maybeSingle();
    if (inboxError || !inbox) throw new Error('webhook_inbox_lookup_failed');
    inboxId = Number(inbox.id);
    if (!isNew && inbox.status === 'processed') {
      await triggerMerchantWebhookWorker(supabaseUrl, serviceKey);
      return new Response('OK', { status: 200 });
    }
    if (!isNew && inbox.status === 'retry' && inbox.next_attempt_at) {
      const retryAfter = webhookRetryAfterSeconds(inbox.next_attempt_at);
      if (retryAfter > 0) return new Response('Retry later', { status: 503, headers: { 'Retry-After': String(retryAfter) } });
    }
    attemptNumber = Math.max(1, Number(inbox.attempts || 0) + 1);
    const { error: markError } = await admin.from('nexora_provider_webhook_inbox').update({
      status: 'processing', attempts: attemptNumber, next_attempt_at: null, last_error_code: null,
    }).eq('id', inboxId);
    if (markError) throw new Error('webhook_inbox_update_failed');

    const { data: acquirer, error: acquirerError } = await admin.from('nexora_acquirers')
      .select('id,code,api_base_url,environment,status').eq('code', 'orusprime_production').maybeSingle();
    if (acquirerError || !acquirer || acquirer.code !== 'orusprime_production'
      || acquirer.environment !== 'production' || acquirer.status !== 'enabled') {
      throw new Error('provider_not_enabled');
    }

    const { data: credential, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
      .select('api_key_ciphertext').eq('acquirer_id', acquirer.id).eq('environment', 'production')
      .eq('status', 'active').maybeSingle();
    if (credentialError || !credential?.api_key_ciphertext) throw new Error('provider_credential_unavailable');

    const credentialsInput = await decryptProviderCredential(credential.api_key_ciphertext, encryptionKey);
    if (!credentialsInput) throw new Error('stored_key_unavailable');

    await processOrusPrimePaymentWebhook(admin, {
      eventId,
      eventType,
      providerTransactionId,
      credentialsInput,
    });

    const { error: completeError } = await admin.from('nexora_provider_webhook_inbox').update({
      status: 'processed', processed_at: new Date().toISOString(), last_error_code: null,
    }).eq('id', inboxId);
    if (completeError) throw new Error('webhook_inbox_complete_failed');
    await triggerMerchantWebhookWorker(supabaseUrl, serviceKey);
    return new Response('OK', { status: 200 });
  } catch (error) {
    const code = safeErrorCode(error), retryDelay = webhookRetryDelayMs(attemptNumber);
    console.error('orusprime_webhook_processing_failed', JSON.stringify({ event_id: eventId, code }));
    if (inboxId !== null) await admin.from('nexora_provider_webhook_inbox').update({
      status: 'retry', last_error_code: code, next_attempt_at: new Date(Date.now() + retryDelay).toISOString(),
    }).eq('id', inboxId);
    return new Response('Retry later', { status: 503, headers: { 'Retry-After': String(Math.ceil(retryDelay / 1000)) } });
  }
});

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { processAsaasPaymentReceived, processAsaasPaymentStatusNotice } from './asaas-webhook-core.ts';
import { webhookRetryAfterSeconds, webhookRetryDelayMs } from '../_shared/payment-provider.ts';

const encoder = new TextEncoder();

async function sha256(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function equalSecret(received: string, expected: string) {
  if (received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < received.length; index++) difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function safeErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : '';
  return /^[a-z0-9_]{1,80}$/.test(value) ? value : 'webhook_processing_failed';
}

async function triggerMerchantWebhookWorker(projectUrl: string, serviceKey: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${projectUrl.replace(/\/$/, '')}/functions/v1/nexora-webhook-deliveries`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) console.error('merchant_webhook_worker_deferred', JSON.stringify({ http_status: response.status }));
  } catch (error) {
    console.error('merchant_webhook_worker_deferred', JSON.stringify({ code: error instanceof Error && error.name === 'AbortError' ? 'worker_timeout' : 'worker_unavailable' }));
  } finally { clearTimeout(timer); }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });

  const configuredToken = Deno.env.get('NEXORA_ASAAS_WEBHOOK_TOKEN') || '';
  const suppliedToken = request.headers.get('asaas-access-token') || '';
  if (configuredToken.length < 32 || configuredToken.length > 255 || /\s/.test(configuredToken)
    || !equalSecret(suppliedToken, configuredToken)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const rawBody = await readBoundedBody(request, 65536);
  if (rawBody === null) return new Response('Payload too large', { status: 413 });
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody); } catch { return new Response('Invalid JSON', { status: 400 }); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return new Response('Invalid payload', { status: 400 });

  const eventId = typeof payload.id === 'string' ? payload.id : '';
  const eventType = typeof payload.event === 'string' ? payload.event : '';
  const payment = payload.payment && typeof payload.payment === 'object' && !Array.isArray(payload.payment)
    ? payload.payment as Record<string, unknown> : null;
  const paymentId = typeof payment?.id === 'string' ? payment.id : '';
  if (!eventId || eventId.length > 255 || !eventType || eventType.length > 100) {
    return new Response('Invalid event metadata', { status: 400 });
  }

  const url = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !serviceKey) return new Response('Service unavailable', { status: 503 });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const normalizedType = eventType.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
  const payloadHash = await sha256(rawBody);
  let inboxId: number | null = null;
  let attemptNumber = 1;

  try {
    const { data: isNew, error: acceptError } = await admin.rpc('nexora_provider_accept_webhook', {
      p_provider_code: 'asaas',
      p_external_event_id: eventId,
      p_external_transaction_id: paymentId || null,
      p_normalized_event_type: normalizedType,
      p_payload_sha256: payloadHash,
    });
    if (acceptError) throw new Error('webhook_inbox_persist_failed');

    const { data: inbox, error: inboxError } = await admin.from('nexora_provider_webhook_inbox')
      .select('id,status,attempts,next_attempt_at').eq('provider_code', 'asaas').eq('external_event_id', eventId).maybeSingle();
    if (inboxError || !inbox) throw new Error('webhook_inbox_lookup_failed');
    inboxId = Number(inbox.id);
    if (!isNew && inbox.status === 'processed') {
      await triggerMerchantWebhookWorker(url, serviceKey);
      return new Response('OK', { status: 200 });
    }
    if (!isNew && inbox.status === 'retry' && inbox.next_attempt_at) {
      const retryAfter = webhookRetryAfterSeconds(inbox.next_attempt_at);
      if (retryAfter > 0) {
        return new Response('Retry later', { status: 503, headers: { 'Retry-After': String(retryAfter) } });
      }
    }

    attemptNumber = Math.max(1, Number(inbox.attempts || 0) + 1);
    const { error: processingError } = await admin.from('nexora_provider_webhook_inbox').update({
      status: 'processing', attempts: attemptNumber, next_attempt_at: null, last_error_code: null,
    }).eq('id', inboxId);
    if (processingError) throw new Error('webhook_inbox_update_failed');

    if (eventType === 'PAYMENT_RECEIVED') {
      if (!payment) throw new Error('webhook_payment_missing');
      await processAsaasPaymentReceived(admin, eventId, payment);
    } else if (eventType.startsWith('PAYMENT_')) {
      if (!payment) throw new Error('webhook_payment_missing');
      // Persist a verified, normalized status event. Refund, risk and chargeback
      // events never mutate ledger balances here; those need their own accounting.
      await processAsaasPaymentStatusNotice(admin, eventId, eventType, payment);
    }

    const { error: completeError } = await admin.from('nexora_provider_webhook_inbox').update({
      status: 'processed', processed_at: new Date().toISOString(), last_error_code: null,
    }).eq('id', inboxId);
    if (completeError) throw new Error('webhook_inbox_complete_failed');
    // Delivery is durable in the merchant outbox; this request is only a
    // best-effort fast path. A scheduled invocation must drain later retries.
    await triggerMerchantWebhookWorker(url, serviceKey);
    return new Response('OK', { status: 200 });
  } catch (error) {
    const code = safeErrorCode(error);
    const retryDelayMs = webhookRetryDelayMs(attemptNumber);
    console.error('asaas_webhook_processing_failed', JSON.stringify({ event_id: eventId || 'unknown', code }));
    if (inboxId !== null) {
      await admin.from('nexora_provider_webhook_inbox').update({
        status: 'retry', last_error_code: code, next_attempt_at: new Date(Date.now() + retryDelayMs).toISOString(),
      }).eq('id', inboxId);
    }
    // Non-2xx asks Asaas to retry. Ledger idempotency makes repeat delivery safe.
    return new Response('Retry later', {
      status: 503,
      headers: { 'Retry-After': String(Math.ceil(retryDelayMs / 1000)) },
    });
  }
});

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { decryptProviderCredential } from '../_shared/provider-credentials.ts';
import { resolvePublicMerchantWebhookDestination, signMerchantWebhook } from '../_shared/merchant-webhooks.ts';
import { sendPinnedMerchantWebhook } from '../_shared/pinned-webhook.ts';
import { isAuthorizedWebhookWorker } from '../_shared/webhook-worker-auth.ts';

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

async function resolveWebhookDns(hostname: string, recordType: 'A' | 'AAAA', signal?: AbortSignal) {
  try { return await Deno.resolveDns(hostname, recordType, { signal }); }
  catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

Deno.serve(async request => {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: jsonHeaders });
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const workerToken = Deno.env.get('NEXORA_MERCHANT_WEBHOOK_WORKER_TOKEN') || '';
  const url = Deno.env.get('SUPABASE_URL') || '';
  const encryptionKey = Deno.env.get('NEXORA_MERCHANT_WEBHOOK_ENCRYPTION_KEY') || '';
  if (!serviceKey || !url || !encryptionKey) return Response.json({ error: 'Worker not configured.' }, { status: 503, headers: jsonHeaders });
  if (!isAuthorizedWebhookWorker({
    authorization: request.headers.get('authorization'),
    workerTokenHeader: request.headers.get('x-nexora-worker-token'),
    serviceRoleKey: serviceKey,
    workerToken,
  })) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: jsonHeaders });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: deliveries, error: claimError } = await admin.rpc('nexora_webhook_claim_deliveries', { p_limit: 10 });
  if (claimError) {
    console.error('merchant_webhook_claim_failed', JSON.stringify({ code: claimError.code || 'unknown' }));
    return Response.json({ error: 'Could not claim webhook deliveries.' }, { status: 503, headers: jsonHeaders });
  }
  let delivered = 0, deferred = 0;
  await Promise.all((Array.isArray(deliveries) ? deliveries : []).map(async (delivery: Record<string, unknown>) => {
    const deliveryId = String(delivery.delivery_id || '');
    const leaseToken = String(delivery.lease_token || '');
    let httpStatus: number | null = null;
    let errorCode = 'network_error';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const startedAt = performance.now();
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 10_000);
      const destination = await resolvePublicMerchantWebhookDestination(delivery.endpoint_url, resolveWebhookDns, controller.signal);
      const rawBody = String(delivery.payload_text || '');
      if (!rawBody || rawBody.length > 1_000_000) throw new Error('webhook_payload_invalid');
      const payload = JSON.parse(rawBody);
      if (!payload || payload.event_id !== delivery.event_id || typeof payload.event !== 'string') throw new Error('webhook_payload_invalid');
      const secret = await decryptProviderCredential(String(delivery.secret_ciphertext || ''), encryptionKey);
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = await signMerchantWebhook(secret, timestamp, rawBody);
      httpStatus = await sendPinnedMerchantWebhook(destination, rawBody, {
          'Content-Type': 'application/json', Accept: 'application/json',
          'User-Agent': 'NexoraPay-Webhooks/1.0',
          'X-Nexora-Event-Id': String(delivery.event_id),
          'X-Nexora-Timestamp': String(timestamp),
          'X-Nexora-Signature': `v1=${signature}`,
        },
        {
          connect: (address, port, signal) => Deno.connect({ hostname: address, port, transport: 'tcp', signal }),
          startTls: (connection, hostname) => Deno.startTls(connection as Deno.TcpConn, { hostname, alpnProtocols: ['http/1.1'] }),
        },
        controller.signal,
      );
      errorCode = httpStatus >= 200 && httpStatus < 300 ? '' : `http_${httpStatus}`;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      errorCode = name === 'TimeoutError' || name === 'AbortError' ? 'request_timeout'
        : error instanceof Error && error.message === 'webhook_url_invalid' ? 'webhook_url_invalid'
        : error instanceof Error && error.message === 'webhook_dns_rejected' ? 'webhook_dns_rejected'
        : error instanceof Error && error.message === 'webhook_dns_unavailable' ? 'webhook_dns_unavailable'
        : error instanceof Error && error.message === 'webhook_payload_invalid' ? 'webhook_payload_invalid'
        : 'delivery_network_error';
    } finally { if (timeout) clearTimeout(timeout); }
    const { data: result, error: finishError } = await admin.rpc('nexora_webhook_finish_delivery', {
      p_delivery_id: deliveryId, p_lease_token: leaseToken,
      p_retry_generation: Number(delivery.retry_generation || 0),
      p_http_status: httpStatus, p_error_code: errorCode || null,
      p_duration_ms: Math.min(60_000, Math.max(0, Math.round(performance.now() - startedAt))),
    });
    if (finishError) {
      console.error('merchant_webhook_finish_failed', JSON.stringify({ code: finishError.code || 'unknown', delivery_id: deliveryId }));
      deferred++;
    } else if (result === 'delivered') delivered++;
    else deferred++;
  }));
  return Response.json({ claimed: Array.isArray(deliveries) ? deliveries.length : 0, delivered, deferred }, { headers: jsonHeaders });
});

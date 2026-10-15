import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMercadoPagoWebhookSignature } from './mercadopago-webhook.ts';

const now = 1_797_000_000_000;
const secret = 'server-held-mp-webhook-secret';
const requestId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const dataId = '998877';

async function sign(timestamp = String(now), id = dataId, reqId = requestId) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const manifest = `id:${id.toLowerCase()};request-id:${reqId};ts:${timestamp};`;
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)));
  return `ts=${timestamp},v1=${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('Mercado Pago webhook signature verification', () => {
  it('validates the signed request ID, lowercased data ID and millisecond timestamp', async () => {
    assert.equal(await verifyMercadoPagoWebhookSignature({
      signature: await sign(), requestId, dataId: dataId.toUpperCase(), secret, nowMs: now,
    }), true);
  });

  it('accepts the legacy seconds timestamp format but rejects replayed signatures', async () => {
    const seconds = String(now / 1000);
    const signature = await sign(seconds);
    assert.equal(await verifyMercadoPagoWebhookSignature({ signature, requestId, dataId, secret, nowMs: now }), true);
    assert.equal(await verifyMercadoPagoWebhookSignature({ signature, requestId, dataId, secret, nowMs: now + 301_000 }), false);
  });

  it('rejects tampering, duplicates, malformed headers, and missing identity fields', async () => {
    const signature = await sign();
    assert.equal(await verifyMercadoPagoWebhookSignature({ signature, requestId, dataId: 'different', secret, nowMs: now }), false);
    assert.equal(await verifyMercadoPagoWebhookSignature({ signature: signature + ',v1=' + '0'.repeat(64), requestId, dataId, secret, nowMs: now }), false);
    assert.equal(await verifyMercadoPagoWebhookSignature({ signature: 'ts=bad,v1=nope', requestId, dataId, secret, nowMs: now }), false);
    assert.equal(await verifyMercadoPagoWebhookSignature({ signature, requestId: null, dataId, secret, nowMs: now }), false);
  });
});

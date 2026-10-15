import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderOutcomeUnknownError } from './payment-provider.ts';
import {
  createMercadoPagoPixTransfer,
  getMercadoPagoPixTransfer,
  normalizeMercadoPagoPayoutStatus,
  normalizeMercadoPagoPixDestination,
} from './mercadopago-payouts.ts';
import type { PayoutConnectorContext } from './payout-provider.ts';

const baseContext: PayoutConnectorContext = {
  apiBaseUrl: 'https://api.mercadopago.com',
  credential: 'TEST-ACCESS-TOKEN',
  environment: 'sandbox',
  notificationUrl: 'https://project.supabase.co/functions/v1/nexora-mercadopago-payout-webhook',
};

function providerResponse(status = 'approved', detail?: string) {
  return {
    id: 'POP01KKCFKH9J2C8TQSQZM4R3Z22C',
    transactions: [{
      id: 'TOP01KKYN1QY2SS1MKAY4E5KM8WZ6',
      external_reference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
      status,
      ...(detail ? { status_detail: detail } : {}),
      amount: { currency: 'BRL', value: 10.25 },
    }],
  };
}

test('Mercado Pago payout normalizes Pix types and only credits an accredited final state', () => {
  assert.deepEqual(normalizeMercadoPagoPixDestination({
    key: 'SHOP@EXAMPLE.COM', keyType: 'EMAIL',
  }), { key: 'shop@example.com', keyType: 'EMAIL' });
  assert.equal(normalizeMercadoPagoPayoutStatus('success', 'accredited'), 'COMPLETED');
  assert.equal(normalizeMercadoPagoPayoutStatus('success', 'in_progress'), 'PROCESSING');
  assert.equal(normalizeMercadoPagoPayoutStatus('approved', undefined), 'PROCESSING');
  assert.equal(normalizeMercadoPagoPayoutStatus('new-provider-state', undefined), 'RISK_REVIEW');
  assert.equal(normalizeMercadoPagoPayoutStatus('error', 'failed'), 'FAILED');
});

test('creates one idempotent sandbox Pix payout and preserves batch and transaction IDs', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const result = await createMercadoPagoPixTransfer(baseContext, {
    amountCents: 1025,
    externalReference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    idempotencyKey: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    description: 'Merchant payout 123',
    destination: { key: '123e4567-e89b-42d3-a456-426614174000', keyType: 'EVP' },
  }, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json(providerResponse());
  });

  assert.equal(requestUrl, 'https://api.mercadopago.com/v1/payouts');
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get('x-idempotency-key'), 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000');
  assert.equal(headers.get('x-test-token'), 'true');
  assert.equal(headers.get('x-signature'), null);
  const body = JSON.parse(String(requestInit?.body));
  assert.equal(body.transactions[0].pix.type, 'PIX_CODE');
  assert.equal(body.transactions[0].amount.value, 10.25);
  assert.equal(body.transactions[0].external_reference, body.external_reference);
  assert.equal(result.providerBatchId, 'POP01KKCFKH9J2C8TQSQZM4R3Z22C');
  assert.equal(result.providerTransactionId, 'TOP01KKYN1QY2SS1MKAY4E5KM8WZ6');
  assert.equal(result.status, 'PROCESSING');
});

test('treats a documented accepted response without transaction status as processing, never success', async () => {
  const response = providerResponse();
  delete (response.transactions[0] as { status?: string }).status;
  const result = await createMercadoPagoPixTransfer(baseContext, {
    amountCents: 1025,
    externalReference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    idempotencyKey: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    description: 'Merchant payout 123',
    destination: { key: '123e4567-e89b-42d3-a456-426614174000', keyType: 'EVP' },
  }, async () => Response.json(response, { status: 202 }));
  assert.equal(result.status, 'PROCESSING');
  assert.equal(result.providerStatus, 'created');
});

test('production requires and signs the exact request body with an Ed25519 PKCS#8 key', async () => {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const pemBody = btoa(String.fromCharCode(...privateBytes)).match(/.{1,64}/g)!.join('\n');
  const context = {
    ...baseContext,
    environment: 'production' as const,
    signingPrivateKeyPem: `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`,
  };
  let capturedBody = '';
  let capturedInit: RequestInit | undefined;
  await createMercadoPagoPixTransfer(context, {
    amountCents: 1025,
    externalReference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    idempotencyKey: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    description: 'Merchant payout 123',
    destination: { key: '11144477735', keyType: 'CPF' },
  }, async (_input, init) => {
    capturedBody = String(init?.body);
    capturedInit = init;
    return Response.json(providerResponse('success', 'accredited'));
  });
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('x-enforce-signature'), 'true');
  assert.equal(headers.get('x-test-token'), null);
  const signature = Uint8Array.from(atob(headers.get('x-signature') || ''), char => char.charCodeAt(0));
  assert.equal(await crypto.subtle.verify('Ed25519', keyPair.publicKey, signature, new TextEncoder().encode(capturedBody)), true);
});

test('queries a transaction using both provider IDs and verifies all payout identity fields', async () => {
  let requestUrl = '';
  const result = await getMercadoPagoPixTransfer(baseContext, {
    providerBatchId: 'POP01KKCFKH9J2C8TQSQZM4R3Z22C',
    providerTransactionId: 'TOP01KKYN1QY2SS1MKAY4E5KM8WZ6',
    amountCents: 1025,
    externalReference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
  }, async input => {
    requestUrl = String(input);
    return Response.json(providerResponse('success', 'accredited').transactions[0]);
  });
  assert.match(requestUrl, /\/v1\/payouts\/POP01[^/]+\/transactions\/TOP01/);
  assert.equal(result.status, 'COMPLETED');
  await assert.rejects(() => getMercadoPagoPixTransfer(baseContext, {
    providerTransactionId: result.providerTransactionId,
    providerBatchId: result.providerBatchId,
    amountCents: 1024,
    externalReference: result.externalReference,
  }, async () => Response.json(providerResponse().transactions[0])), ProviderOutcomeUnknownError);
});

test('never retries an ambiguous create and fails closed for invalid hosts, IDs, or production signing config', async () => {
  let calls = 0;
  await assert.rejects(() => createMercadoPagoPixTransfer(baseContext, {
    amountCents: 1025,
    externalReference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    idempotencyKey: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    description: 'Merchant payout 123',
    destination: { key: '123e4567-e89b-42d3-a456-426614174000', keyType: 'EVP' },
  }, async () => { calls++; throw new Error('socket closed'); }), ProviderOutcomeUnknownError);
  assert.equal(calls, 1);
  await assert.rejects(() => createMercadoPagoPixTransfer({
    ...baseContext, environment: 'production',
  }, {
    amountCents: 1025,
    externalReference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    idempotencyKey: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    description: 'Merchant payout 123',
    destination: { key: '123e4567-e89b-42d3-a456-426614174000', keyType: 'EVP' },
  }, async () => Response.json(providerResponse())), /signing_key_required/);
  await assert.rejects(() => getMercadoPagoPixTransfer(baseContext, {
    providerTransactionId: 'TOP01KKYN1QY2SS1MKAY4E5KM8WZ6',
    amountCents: 1025,
    externalReference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
  }), /lookup_invalid/);
  await assert.rejects(() => createMercadoPagoPixTransfer({
    ...baseContext, notificationUrl: 'https://attacker.example/collect',
  }, {
    amountCents: 1025,
    externalReference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    idempotencyKey: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    description: 'Merchant payout 123',
    destination: { key: '123e4567-e89b-42d3-a456-426614174000', keyType: 'EVP' },
  }), /notification_url_invalid/);
});


import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrusPrimePixPayment,
  getOrusPrimeTransaction,
  normalizeOrusPrimeStatus,
  parseOrusPrimeCredentials,
} from './orusprime-adapter.ts';

test('parseOrusPrimeCredentials parses JSON format correctly', () => {
  const jsonStr = JSON.stringify({
    publicKey: 'pub_test_123',
    secretKey: 'sec_test_456'
  });
  const creds = parseOrusPrimeCredentials(jsonStr);
  assert.equal(creds.publicKey, 'pub_test_123');
  assert.equal(creds.secretKey, 'sec_test_456');
});

test('parseOrusPrimeCredentials parses colon format correctly', () => {
  const colonStr = 'pub_test_123:sec_test_456';
  const creds = parseOrusPrimeCredentials(colonStr);
  assert.equal(creds.publicKey, 'pub_test_123');
  assert.equal(creds.secretKey, 'sec_test_456');
});

test('parseOrusPrimeCredentials throws on invalid format', () => {
  assert.throws(() => parseOrusPrimeCredentials('invalid_single_string'), /orusprime_credentials_format_unsupported/);
  assert.throws(() => parseOrusPrimeCredentials(''), /orusprime_credentials_invalid/);
});

test('normalizeOrusPrimeStatus maps states accurately', () => {
  assert.equal(normalizeOrusPrimeStatus('PENDING'), 'PENDING');
  assert.equal(normalizeOrusPrimeStatus('COMPLETED'), 'SUCCEEDED');
  assert.equal(normalizeOrusPrimeStatus('PAID'), 'SUCCEEDED');
  assert.equal(normalizeOrusPrimeStatus('OK'), 'SUCCEEDED');
  assert.equal(normalizeOrusPrimeStatus('CANCELED'), 'CANCELED');
  assert.equal(normalizeOrusPrimeStatus('EXPIRED'), 'CANCELED');
  assert.equal(normalizeOrusPrimeStatus('FAILED'), 'FAILED');
  assert.equal(normalizeOrusPrimeStatus('REJECTED'), 'FAILED');
  assert.equal(normalizeOrusPrimeStatus('UNKNOWN'), 'PENDING');
});

test('createOrusPrimePixPayment generates a normalized Pix charge', async () => {
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://app.orusprime.com.br/api/v1/gateway/pix/receive');
    assert.equal(init?.method, 'POST');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['x-public-key'], 'pub_123');
    assert.equal(headers['x-secret-key'], 'sec_456');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.identifier, 'order_test_1');
    assert.equal(body.amount, 25.5);
    assert.equal(body.client.name, 'Maria Silva');
    assert.equal(body.client.email, 'maria@example.com');
    assert.equal(body.callbackUrl, 'https://example.com/webhook');

    return new Response(JSON.stringify({
      transactionId: 'orus_tx_123',
      status: 'PENDING',
      transactionStatus: 'PENDING',
      fee: 0.99,
      order: {
        id: 'ord_123',
        url: 'https://checkout.orusprime.com.br/order/ord_123'
      },
      pix: {
        code: '00020101021226...',
        image: 'https://example.com/qr.png',
        expiresAt: '2026-10-18T12:00:00Z'
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await createOrusPrimePixPayment('pub_123:sec_456', {
    identifier: 'order_test_1',
    valueCents: 2550,
    client: {
      name: 'Maria Silva',
      email: 'maria@example.com',
      phone: '11988887777',
      document: '12345678909'
    },
    callbackUrl: 'https://example.com/webhook'
  }, fakeFetch);

  assert.equal(result.providerTransactionId, 'orus_tx_123');
  assert.equal(result.clientIdentifier, 'order_test_1');
  assert.equal(result.status, 'PENDING');
  assert.equal(result.pixCopyPaste, '00020101021226...');
  assert.equal(result.qrCodeImage, 'https://example.com/qr.png');
  assert.equal(result.checkoutUrl, 'https://checkout.orusprime.com.br/order/ord_123');
  assert.equal(result.expiresAt, '2026-10-18T12:00:00Z');
});

test('createOrusPrimePixPayment rejects amounts below 50 cents', async () => {
  await assert.rejects(
    createOrusPrimePixPayment('pub_123:sec_456', {
      identifier: 'order_test_small',
      valueCents: 49,
      client: { name: 'A', email: 'a@b.com' }
    }),
    /orusprime_amount_invalid/
  );
});

test('getOrusPrimeTransaction queries transaction details', async () => {
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://app.orusprime.com.br/api/v1/gateway/transactions?id=orus_tx_123');
    assert.equal(init?.method, 'GET');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['x-public-key'], 'pub_123');
    assert.equal(headers['x-secret-key'], 'sec_456');

    return new Response(JSON.stringify({
      id: 'orus_tx_123',
      clientIdentifier: 'order_test_1',
      status: 'COMPLETED',
      amount: 25.5,
      payedAt: '2026-10-16T22:00:00Z',
      pixInformation: {
        qrCode: '00020101021226...',
        image: 'https://example.com/qr.png'
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await getOrusPrimeTransaction('pub_123:sec_456', 'orus_tx_123', fakeFetch);
  assert.equal(result.providerTransactionId, 'orus_tx_123');
  assert.equal(result.clientIdentifier, 'order_test_1');
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.valueCents, 2550);
  assert.equal(result.pixCopyPaste, '00020101021226...');
  assert.equal(result.payedAt, '2026-10-16T22:00:00Z');
});

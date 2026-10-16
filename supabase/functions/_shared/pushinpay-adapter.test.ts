import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPushinPayPixPayment,
  getPushinPayTransaction,
  normalizePushinPayStatus,
} from './pushinpay-adapter.ts';

test('normalizePushinPayStatus maps states accurately', () => {
  assert.equal(normalizePushinPayStatus('created'), 'PENDING');
  assert.equal(normalizePushinPayStatus('pending'), 'PENDING');
  assert.equal(normalizePushinPayStatus('paid'), 'SUCCEEDED');
  assert.equal(normalizePushinPayStatus('approved'), 'SUCCEEDED');
  assert.equal(normalizePushinPayStatus('canceled'), 'CANCELED');
  assert.equal(normalizePushinPayStatus('failed'), 'FAILED');
  assert.equal(normalizePushinPayStatus('unknown_status'), 'PENDING');
});

test('createPushinPayPixPayment generates a normalized Pix charge', async () => {
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.pushinpay.com.br/api/pix/cashIn');
    assert.equal(init?.method, 'POST');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer test_token');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.value, 1500);
    assert.equal(body.webhook_url, 'https://example.com/webhook');

    return new Response(JSON.stringify({
      id: 'pushin-12345',
      status: 'created',
      value: 1500,
      qr_code: '0002012658...',
      qr_code_base64: 'data:image/png;base64,iVBORw...',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await createPushinPayPixPayment('test_token', {
    valueCents: 1500,
    webhookUrl: 'https://example.com/webhook',
  }, fakeFetch);

  assert.equal(result.providerTransactionId, 'pushin-12345');
  assert.equal(result.status, 'PENDING');
  assert.equal(result.pixCopyPaste, '0002012658...');
  assert.equal(result.qrCodeBase64, 'data:image/png;base64,iVBORw...');
});

test('createPushinPayPixPayment rejects amounts below 50 cents', async () => {
  await assert.rejects(
    createPushinPayPixPayment('test_token', { valueCents: 49 }),
    /pushinpay_amount_invalid/
  );
});

test('getPushinPayTransaction queries transaction details', async () => {
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.pushinpay.com.br/api/transactions/pushin-12345');
    assert.equal(init?.method, 'GET');

    return new Response(JSON.stringify({
      id: 'pushin-12345',
      status: 'paid',
      value: '1500',
      pix_details: {
        emv: '0002012658...',
        expiration_date: '2026-10-18T12:00:00Z',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await getPushinPayTransaction('test_token', 'pushin-12345', fakeFetch);
  assert.equal(result.providerTransactionId, 'pushin-12345');
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.pixCopyPaste, '0002012658...');
  assert.equal(result.expiresAt, '2026-10-18T12:00:00Z');
});

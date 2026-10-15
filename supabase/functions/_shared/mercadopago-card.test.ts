import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMercadoPagoCardPayment, parseMercadoPagoCardInput } from './mercadopago-adapter.ts';

const request = {
  amountCents: 1990, currency: 'BRL' as const, internalTransactionId: 'NX-TX-1',
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  merchantRoute: { businessId: 'b', ledgerAccountId: 'l', settlementModel: 'platform_balance' as const },
  paymentMethod: 'credit_card' as const, description: 'Pedido de teste',
  customer: { name: 'Maria Silva', email: 'maria@example.com', document: '52998224725' },
};

test('card intent accepts only a bounded browser token and numeric issuer/installments', () => {
  const ok = parseMercadoPagoCardInput({ card_token: 'a'.repeat(32), installments: 3, payment_method_id: 'visa', issuer_id: '25' });
  assert.deepEqual(ok, { token: 'a'.repeat(32), installments: 3, paymentMethodId: 'visa', issuerId: '25' });
  assert.equal(parseMercadoPagoCardInput({ card_token: 'short', installments: 1, payment_method_id: 'visa' }), null);
  assert.equal(parseMercadoPagoCardInput({ card_token: 'a'.repeat(32), installments: 13, payment_method_id: 'visa' }), null);
  assert.equal(parseMercadoPagoCardInput({ card_token: 'a'.repeat(32), installments: 1, payment_method_id: 'VISA!' }), null);
  assert.equal(parseMercadoPagoCardInput({ card_token: 'a'.repeat(32), installments: 1, payment_method_id: 'visa', issuer_id: 'x' }), null);
});

test('card payment posts the token with idempotency and verifies identity and amount in the response', async () => {
  let captured: RequestInit | undefined;
  const result = await createMercadoPagoCardPayment('APP_USR-token', 'https://abc.supabase.co', request,
    { token: 'a'.repeat(32), installments: 2, paymentMethodId: 'visa', issuerId: '25' },
    async (_url, init) => {
      captured = init;
      return Response.json({ id: 123456, status: 'approved', external_reference: 'NX-TX-1', transaction_amount: 19.9 });
    });
  assert.equal(result.status, 'SUCCEEDED');
  const body = JSON.parse(String(captured?.body));
  assert.equal(body.token, 'a'.repeat(32));
  assert.equal(body.installments, 2);
  assert.equal(body.transaction_amount, 19.9);
  assert.equal(new Headers(captured?.headers).get('x-meli-session-id'), null);
  assert.equal(new Headers(captured?.headers).get('x-idempotency-key'), request.idempotencyKey);
  await assert.rejects(() => createMercadoPagoCardPayment('APP_USR-token', 'https://abc.supabase.co', request,
    { token: 'a'.repeat(32), installments: 1, paymentMethodId: 'visa' },
    async () => Response.json({ id: 1, status: 'approved', external_reference: 'OTHER', transaction_amount: 19.9 })), /identity_mismatch/);
});

test('card payment forwards the optional Mercado Pago device session ID without persisting it', async () => {
  let captured: RequestInit | undefined;
  const deviceSessionId = 'device-session-abc123';
  const card = parseMercadoPagoCardInput({
    card_token: 'a'.repeat(32), installments: 1, payment_method_id: 'visa', device_session_id: deviceSessionId,
  });
  assert.equal(card?.deviceSessionId, deviceSessionId);
  await createMercadoPagoCardPayment('APP_USR-token', 'https://abc.supabase.co', request, card!, async (_url, init) => {
    captured = init;
    return Response.json({ id: 123456, status: 'rejected', external_reference: 'NX-TX-1', transaction_amount: 19.9 });
  });
  assert.equal(new Headers(captured?.headers).get('x-meli-session-id'), deviceSessionId);
  assert.equal(String(captured?.body).includes(deviceSessionId), false);
  assert.equal(parseMercadoPagoCardInput({
    card_token: 'a'.repeat(32), installments: 1, payment_method_id: 'visa', device_session_id: 'bad\r\nheader',
  })?.deviceSessionId, undefined);
});

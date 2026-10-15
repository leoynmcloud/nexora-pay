import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMercadoPagoPixPayment, findMercadoPagoPixPaymentByReference, getMercadoPagoPixPayment, inspectMercadoPagoPixFeeCents, isDefinitiveMercadoPagoCreateRejection } from './mercadopago-adapter.ts';

const input = {
  amountCents: 1234,
  currency: 'BRL' as const,
  internalTransactionId: 'nx-tx-123',
  idempotencyKey: 'nx-idempotency-key-123',
  merchantRoute: { businessId: 'biz-1', ledgerAccountId: 'ledger-1', settlementModel: 'platform_balance' as const },
  paymentMethod: 'pix' as const,
  description: 'Pedido 123',
  customer: { name: 'Maria Silva', email: 'maria@example.com', document: '529.982.247-25' },
};
const supabaseUrl = 'https://project.supabase.co';
const notificationUrl = 'https://project.supabase.co/functions/v1/nexora-mercadopago-webhook';
const paymentResponse = (overrides: Record<string, unknown> = {}) => Response.json({
  id: 998877,
  external_reference: input.internalTransactionId,
  transaction_amount: 12.34,
  status: 'pending',
  date_of_expiration: '2026-10-11T12:00:00.000-03:00',
  point_of_interaction: { transaction_data: {
    qr_code: 'pix-copy-paste', qr_code_base64: 'cXItY29kZQ==', ticket_url: 'https://www.mercadopago.com.br/pay/123',
  } },
  ...overrides,
}, { status: 201 });

describe('Mercado Pago Pix adapter primitive', () => {
  it('maps provider payment states into the shared taxonomy and sends unknown states to review', async () => {
    const cases = [
      ['pending', 'PENDING'], ['in_process', 'PROCESSING'], ['authorized', 'AUTHORIZED'],
      ['approved', 'SUCCEEDED'], ['rejected', 'FAILED'], ['cancelled', 'CANCELED'],
      ['refunded', 'REFUNDED'], ['charged_back', 'UNDER_REVIEW'],
      ['provider_added_a_new_state', 'UNDER_REVIEW'],
    ] as const;
    for (const [raw, expected] of cases) {
      const result = await getMercadoPagoPixPayment('APP_USR-token', '998877',
        input.internalTransactionId, input.amountCents, async () => Response.json({
        id: 998877, external_reference: input.internalTransactionId,
        transaction_amount: 12.34, payment_method_id: 'pix', status: raw,
      }));
      assert.equal(result.status, expected, raw);
    }
  });

  it('returns a fee only after provider ID, reference, amount, Pix method, and approved status agree', async () => {
    let url = '';
    const fee = await inspectMercadoPagoPixFeeCents('APP_USR-production-token', '998877', {
      transactionId: input.internalTransactionId, amountCents: 1234,
    }, async request => {
      url = String(request);
      return Response.json({ id: 998877, external_reference: input.internalTransactionId,
        transaction_amount: 12.34, payment_method_id: 'pix', status: 'approved',
        fee_details: [{ amount: 0.19 }, { amount: 0.05 }] }, { status: 200 });
    });
    assert.equal(url, 'https://api.mercadopago.com/v1/payments/998877');
    assert.equal(fee, 24);
  });

  it('fails closed for unverified or impossible payment fee details', async () => {
    const expected = { transactionId: input.internalTransactionId, amountCents: 1234 };
    const base = { id: 998877, external_reference: input.internalTransactionId, transaction_amount: 12.34,
      payment_method_id: 'pix', status: 'approved', fee_details: [{ amount: 0.19 }] };
    const read = (body: Record<string, unknown>) => inspectMercadoPagoPixFeeCents('APP_USR-token', '998877', expected,
      async () => Response.json(body, { status: 200 }));
    assert.equal(await read({ ...base, external_reference: 'other' }), null);
    assert.equal(await read({ ...base, transaction_amount: 1 }), null);
    assert.equal(await read({ ...base, status: 'pending' }), null);
    assert.equal(await read({ ...base, fee_details: [{ amount: -0.1 }] }), null);
    assert.equal(await read({ ...base, fee_details: [{ amount: 99 }] }), null);
  });

  it('sends a server-side Pix payment with internal reference and idempotency', async () => {
    let capturedRequest: Request | undefined;
    const result = await createMercadoPagoPixPayment('APP_USR-test-token', supabaseUrl, input, async (request, init) => {
      capturedRequest = new Request(request, init);
      return paymentResponse();
    });
    assert.equal(capturedRequest?.url, 'https://api.mercadopago.com/v1/payments');
    assert.equal(capturedRequest?.headers.get('Authorization'), 'Bearer APP_USR-test-token');
    assert.equal(capturedRequest?.headers.get('X-Idempotency-Key'), input.idempotencyKey);
    const body = await capturedRequest!.json() as Record<string, any>;
    assert.equal(body.payment_method_id, 'pix');
    assert.equal(body.external_reference, input.internalTransactionId);
    assert.equal(body.notification_url, notificationUrl);
    assert.deepEqual(body.payer.identification, { type: 'CPF', number: '52998224725' });
    assert.equal(body.transaction_amount, 12.34);
    assert.equal(result.providerTransactionId, '998877');
    assert.equal(result.status, 'PENDING');
    assert.equal(result.amountCents, 1234);
    assert.equal(result.pixCopyPaste, 'pix-copy-paste');
    assert.equal(result.checkoutUrl, 'https://www.mercadopago.com.br/pay/123');
  });

  it('fails closed for unsupported method, malformed payer, or non-fixed webhook endpoint', async () => {
    const neverFetch = async () => { throw new Error('unexpected_network_request'); };
    await assert.rejects(createMercadoPagoPixPayment('APP_USR-token', supabaseUrl, { ...input, paymentMethod: 'credit_card' }, neverFetch), /payment_method_unsupported/);
    await assert.rejects(createMercadoPagoPixPayment('APP_USR-token', supabaseUrl, { ...input, customer: { ...input.customer, document: '123' } }, neverFetch), /payer_invalid/);
    await assert.rejects(createMercadoPagoPixPayment('APP_USR-token', 'https://attacker.example', input, neverFetch), /notification_url_invalid/);
  });

  it('does not trust mismatched provider amount/reference or expose provider response bodies', async () => {
    await assert.rejects(createMercadoPagoPixPayment('APP_USR-token', supabaseUrl, input, async () =>
      paymentResponse({ transaction_amount: 99 })), /payment_identity_mismatch/);
    await assert.rejects(createMercadoPagoPixPayment('APP_USR-token', supabaseUrl, input, async () =>
      paymentResponse({ external_reference: 'another-transaction' })), /payment_identity_mismatch/);
    await assert.rejects(createMercadoPagoPixPayment('APP_USR-token', supabaseUrl, input, async () =>
      new Response(JSON.stringify({ message: 'sensitive provider response detail' }), { status: 401 })), /create_http_401/);
  });

  it('re-fetches a payment by the original provider ID and checks amount/reference before returning its state', async () => {
    let requestedUrl = '';
    const result = await getMercadoPagoPixPayment('APP_USR-token', '998877', input.internalTransactionId, input.amountCents, async request => {
      requestedUrl = String(request);
      return paymentResponse({ status: 'approved' });
    });
    assert.equal(requestedUrl, 'https://api.mercadopago.com/v1/payments/998877');
    assert.equal(result.providerTransactionId, '998877');
    assert.equal(result.status, 'SUCCEEDED');
    await assert.rejects(getMercadoPagoPixPayment('APP_USR-token', '998877', 'different-tx', input.amountCents, async () => paymentResponse()), /payment_identity_mismatch/);
    await assert.rejects(getMercadoPagoPixPayment('APP_USR-token', 'https://attacker.example', input.internalTransactionId, input.amountCents, async () => paymentResponse()), /transaction_identity_invalid/);
  });

  it('recovers one ambiguous create by external reference without resubmitting', async () => {
    let requestedUrl = '';
    const result = await findMercadoPagoPixPaymentByReference('APP_USR-token',input.internalTransactionId,input.amountCents,
      async request => {
        requestedUrl = String(request);
        return Response.json({results:[{...await paymentResponse().json(),payment_method_id:'pix'}]});
      },Date.parse('2026-10-10T12:00:00.000Z'));
    const url = new URL(requestedUrl);
    assert.equal(url.origin+url.pathname,'https://api.mercadopago.com/v1/payments/search');
    assert.equal(url.searchParams.get('external_reference'),input.internalTransactionId);
    assert.equal(url.searchParams.get('range'),'date_created');
    assert.equal(url.searchParams.get('limit'),'2');
    assert.equal(result?.providerTransactionId,'998877');
    assert.equal(result?.amountCents,1234);
  });

  it('does not guess when search is empty, ambiguous, or has mismatched amount/method', async () => {
    const searchResponse = (results: unknown[]) => async () => Response.json({results});
    assert.equal(await findMercadoPagoPixPaymentByReference('APP_USR-token',input.internalTransactionId,input.amountCents,
      searchResponse([]),Date.now()),null);
    const one = {...await paymentResponse().json(),payment_method_id:'pix'};
    await assert.rejects(findMercadoPagoPixPaymentByReference('APP_USR-token',input.internalTransactionId,input.amountCents,
      searchResponse([one,one]),Date.now()),/search_ambiguous/);
    await assert.rejects(findMercadoPagoPixPaymentByReference('APP_USR-token',input.internalTransactionId,input.amountCents,
      searchResponse([{...one,transaction_amount:99}]),Date.now()),/payment_identity_mismatch/);
    await assert.rejects(findMercadoPagoPixPaymentByReference('APP_USR-token',input.internalTransactionId,input.amountCents,
      searchResponse([{...one,payment_method_id:'credit_card'}]),Date.now()),/payment_method_mismatch/);
  });
});

describe('Mercado Pago create rejection classification', () => {
  it('distinguishes definitive request rejection from throttling or uncertain transport errors', () => {
    assert.equal(isDefinitiveMercadoPagoCreateRejection('mercadopago_create_http_400'), true);
    assert.equal(isDefinitiveMercadoPagoCreateRejection('mercadopago_create_http_422'), true);
    for (const status of ['408', '409', '425', '429']) {
      assert.equal(isDefinitiveMercadoPagoCreateRejection(`mercadopago_create_http_${status}`), false);
    }
    assert.equal(isDefinitiveMercadoPagoCreateRejection('mercadopago_create_http_429'), false);
    assert.equal(isDefinitiveMercadoPagoCreateRejection('mercadopago_rate_limited'), false);
    assert.equal(isDefinitiveMercadoPagoCreateRejection('provider_timeout'), false);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsaasPixTransfer, findAsaasPixTransferByReference, getAsaasPixTransfer, getAsaasPixTransferById, normalizeAsaasPixDestination, parseAsaasTransferWebhookNotice } from './asaas-payouts.ts';
import { ProviderOutcomeUnknownError } from './payment-provider.ts';

const externalReference = 'NX-PAYOUT-54c11d3cd7724d79a1a093c69da350d3';
const transfer = { id: '777eb7c8-b1a2-4356-8fd8-a1b0644b5282', value: 10, externalReference, status: 'PENDING' };
const baseInput = {
  baseUrl: 'https://api-sandbox.asaas.com/v3', apiKey: 'sandbox-token', amountCents: 1000,
  externalReference, description: 'Saque Nexora',
  destination: { pixAddressKey: 'merchant@example.com', pixAddressKeyType: 'EMAIL' as const },
};

test('Asaas Pix payout adapter safety contract', async t => {
  await t.test('normalizes documented Pix key formats and validates CPF/CNPJ check digits', () => {
    assert.deepEqual(normalizeAsaasPixDestination({ pixAddressKey: '529.982.247-25', pixAddressKeyType: 'CPF' }),
      { pixAddressKey: '52998224725', pixAddressKeyType: 'CPF' });
    assert.deepEqual(normalizeAsaasPixDestination({ pixAddressKey: '11.222.333/0001-81', pixAddressKeyType: 'CNPJ' }),
      { pixAddressKey: '11222333000181', pixAddressKeyType: 'CNPJ' });
    assert.deepEqual(normalizeAsaasPixDestination({ pixAddressKey: '12.ABC.345/01DE-35', pixAddressKeyType: 'CNPJ' }),
      { pixAddressKey: '12ABC34501DE35', pixAddressKeyType: 'CNPJ' });
    assert.deepEqual(normalizeAsaasPixDestination({ pixAddressKey: '+55 (11) 91234-5678', pixAddressKeyType: 'PHONE' }),
      { pixAddressKey: '11912345678', pixAddressKeyType: 'PHONE' });
    assert.deepEqual(normalizeAsaasPixDestination({ pixAddressKey: ' Merchant@Example.com ', pixAddressKeyType: 'EMAIL' }),
      { pixAddressKey: 'merchant@example.com', pixAddressKeyType: 'EMAIL' });
    assert.deepEqual(normalizeAsaasPixDestination({ pixAddressKey: '550e8400-e29b-41d4-a716-446655440000', pixAddressKeyType: 'EVP' }),
      { pixAddressKey: '550e8400-e29b-41d4-a716-446655440000', pixAddressKeyType: 'EVP' });
    assert.throws(() => normalizeAsaasPixDestination({ pixAddressKey: '111.111.111-11', pixAddressKeyType: 'CPF' }));
    assert.throws(() => normalizeAsaasPixDestination({ pixAddressKey: '11222333000180', pixAddressKeyType: 'CNPJ' }));
    assert.throws(() => normalizeAsaasPixDestination({ pixAddressKey: '1191234567', pixAddressKeyType: 'PHONE' }));
    assert.throws(() => normalizeAsaasPixDestination({ pixAddressKey: 'not-a-random-key', pixAddressKeyType: 'EVP' }));
  });

  await t.test('parses transfer events without assuming a fixed provider event sequence', () => {
    const payload = {
      id: 'evt_transfer_123456789', event: 'TRANSFER_DONE',
      transfer: { id: transfer.id, externalReference, operationType: 'PIX', value: 10, status: 'DONE' },
    };
    assert.deepEqual(parseAsaasTransferWebhookNotice(payload), {
      eventId: payload.id, eventType: payload.event, providerTransactionId: transfer.id,
      externalReference, amountCents: 1000, providerStatus: 'DONE', status: 'COMPLETED',
    });
    assert.equal(parseAsaasTransferWebhookNotice({ ...payload, event: 'TRANSFER_IN_BANK_PROCESSING', transfer: { ...payload.transfer, status: 'IN_BANK_PROCESSING' } }).status, 'PROCESSING');
    assert.equal(parseAsaasTransferWebhookNotice({ ...payload, event: 'TRANSFER_DONE', transfer: { ...payload.transfer, status: 'PENDING' } }).status, 'PROCESSING');
    assert.equal(parseAsaasTransferWebhookNotice({ ...payload, transfer: { ...payload.transfer, status: 'FUTURE_PROVIDER_STATE' } }).status, 'RISK_REVIEW');
    assert.equal(parseAsaasTransferWebhookNotice({ ...payload, transfer: { ...payload.transfer, externalReference: undefined } }).externalReference, null);
    assert.equal(parseAsaasTransferWebhookNotice({ ...payload, transfer: { ...payload.transfer, externalReference: 'unrelated-reference' } }).externalReference, 'unrelated-reference');
    assert.equal(parseAsaasTransferWebhookNotice({ ...payload, event: 'TRANSFER_BLOCKED', transfer: { ...payload.transfer, status: 'PENDING' } }).status, 'RISK_REVIEW');
    assert.throws(() => parseAsaasTransferWebhookNotice({ ...payload, transfer: { ...payload.transfer, operationType: 'TED' } }));
    assert.throws(() => parseAsaasTransferWebhookNotice({ ...payload, transfer: { ...payload.transfer, value: 10.001 } }));
  });

  await t.test('creates exactly one Pix transfer with integer-cent amount and durable reference', async () => {
    let captured: Request | undefined;
    const response = await createAsaasPixTransfer(baseInput, async (input, init) => {
      captured = new Request(input, init);
      return Response.json(transfer);
    });
    const payload = await captured!.json();
    assert.equal(captured!.url, 'https://api-sandbox.asaas.com/v3/transfers');
    assert.equal(captured!.headers.get('access_token'), 'sandbox-token');
    assert.equal(payload.value, 10);
    assert.equal(payload.operationType, 'PIX');
    assert.equal(payload.pixAddressKey, 'merchant@example.com');
    assert.equal(payload.externalReference, externalReference);
    assert.equal(response.status, 'PROCESSING');
    assert.equal(response.providerTransactionId, transfer.id);
  });

  await t.test('maps only documented final status to completed and preserves pending as processing', async () => {
    const response = await createAsaasPixTransfer(baseInput, async () => Response.json({ ...transfer, status: 'DONE' }));
    assert.equal(response.status, 'COMPLETED');
  });

  await t.test('never retries a timeout or 5xx creation and marks the outcome unknown', async () => {
    let calls = 0;
    await assert.rejects(createAsaasPixTransfer(baseInput, async () => {
      calls++;
      return new Response('temporary provider error', { status: 503 });
    }), ProviderOutcomeUnknownError);
    assert.equal(calls, 1);
  });

  await t.test('recovery lookup only queries status and verifies ID, amount, and external reference', async () => {
    let method = '';
    const response = await getAsaasPixTransfer({
      baseUrl: baseInput.baseUrl, apiKey: baseInput.apiKey, providerTransactionId: transfer.id,
      amountCents: 1000, externalReference,
    }, async (input, init) => {
      method = init?.method || '';
      assert.equal(String(input), baseInput.baseUrl + '/transfers/' + transfer.id);
      return Response.json(transfer);
    });
    assert.equal(method, 'GET');
    assert.equal(response.status, 'PROCESSING');
  });

  await t.test('resolves webhook transfers by ID with a read-only provider lookup', async () => {
    let method = '';
    const response = await getAsaasPixTransferById({
      baseUrl: baseInput.baseUrl, apiKey: baseInput.apiKey, providerTransactionId: transfer.id,
    }, async (input, init) => {
      method = init?.method || '';
      assert.equal(String(input), `${baseInput.baseUrl}/transfers/${transfer.id}`);
      return Response.json({ ...transfer, operationType: 'PIX' });
    });
    assert.equal(method, 'GET');
    assert.equal(response.externalReference, externalReference);
    assert.equal(response.amountCents, 1000);
    assert.equal(response.status, 'PROCESSING');
    await assert.rejects(getAsaasPixTransferById({
      baseUrl: baseInput.baseUrl, apiKey: baseInput.apiKey, providerTransactionId: transfer.id,
    }, async () => Response.json({ ...transfer, operationType: 'TED' })), ProviderOutcomeUnknownError);
  });

  await t.test('recovery by reference is read-only and refuses incomplete pagination', async () => {
    let methods = 0;
    const query = {
      baseUrl: baseInput.baseUrl, apiKey: baseInput.apiKey, externalReference,
      amountCents: 1000, createdDate: '2026-10-10',
    };
    const found = await findAsaasPixTransferByReference(query, async (_input, init) => {
      methods++;
      assert.equal(init?.method, 'GET');
      return Response.json({ hasMore: false, data: [transfer] });
    });
    assert.equal(methods, 1);
    assert.equal(found?.providerTransactionId, transfer.id);
    await assert.rejects(findAsaasPixTransferByReference(query, async () => Response.json({ data: [transfer] })), ProviderOutcomeUnknownError);
  });

  await t.test('recovery never reports not-found for malformed rows or invalid calendar dates', async () => {
    const query = {
      baseUrl: baseInput.baseUrl, apiKey: baseInput.apiKey, externalReference,
      amountCents: 1000, createdDate: '2026-10-10',
    };
    await assert.rejects(findAsaasPixTransferByReference(query, async () =>
      Response.json({ hasMore: false, data: [{ id: 'row-without-reference' }] })), ProviderOutcomeUnknownError);
    await assert.rejects(findAsaasPixTransferByReference(query, async () =>
      Response.json({ hasMore: false, data: [null] })), ProviderOutcomeUnknownError);
    await assert.rejects(findAsaasPixTransferByReference({ ...query, createdDate: '2026-02-30' }, async () => {
      throw new Error('must not perform a request');
    }), /asaas_transfer_lookup_invalid/);
  });

  await t.test('rejects unsupported production hosts and mismatched provider payloads', async () => {
    await assert.rejects(createAsaasPixTransfer({ ...baseInput, baseUrl: 'https://attacker.invalid/v3' }, async () => Response.json(transfer)));
    await assert.rejects(createAsaasPixTransfer(baseInput, async () => Response.json({ ...transfer, value: 99 })) , ProviderOutcomeUnknownError);
  });
});

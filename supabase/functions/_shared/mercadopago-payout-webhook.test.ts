import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMercadoPagoPayoutNotice } from './mercadopago-payout-webhook.ts';

const payload = {
  created_date: '2026-10-10T15:20:25.470-03:00',
  external_reference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
  id: 'TOP01KKYN1QY2SS1MKAY4E5KM8WZ6',
  last_updated_date: '2026-10-10T15:20:25.470-03:00',
  payout: {
    external_reference: 'NX-PAYOUT-123e4567-e89b-42d3-a456-426614174000',
    id: 'POP01KKCFKH9J2C8TQSQZM4R3Z22C',
    notification_url: 'https://project.supabase.co/functions/v1/nexora-mercadopago-payout-webhook',
  },
  status: 'success',
  status_detail: 'accredited',
};

test('parses Mercado Pago payout notification identities and derives stable event IDs', async () => {
  const first = await parseMercadoPagoPayoutNotice(payload);
  const duplicate = await parseMercadoPagoPayoutNotice(payload);
  assert.deepEqual(first, duplicate);
  assert.equal(first.providerBatchId, payload.payout.id);
  assert.equal(first.providerTransactionId, payload.id);
  assert.equal(first.externalReference, payload.external_reference);
  assert.equal(first.eventType, 'payout.success');
  assert.match(first.eventId, /^mp-payout-[a-f0-9]{64}$/);
  const advanced = await parseMercadoPagoPayoutNotice({ ...payload, status: 'rejected' });
  assert.notEqual(advanced.eventId, first.eventId);
});

test('rejects malformed or cross-correlated provider notification identifiers', async () => {
  await assert.rejects(() => parseMercadoPagoPayoutNotice({ ...payload, id: 'wrong id' }), /notice_invalid/);
  await assert.rejects(() => parseMercadoPagoPayoutNotice({
    ...payload,
    payout: { ...payload.payout, external_reference: 'NX-PAYOUT-other-reference-12345678' },
  }), /notice_invalid/);
  await assert.rejects(() => parseMercadoPagoPayoutNotice({ ...payload, external_reference: 'merchant-controlled' }), /notice_invalid/);
  await assert.rejects(() => parseMercadoPagoPayoutNotice(null), /notice_invalid/);
});


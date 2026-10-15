import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMerchantPayoutListRequest, parsePayoutAdminRequest } from './payout-admin.ts';

const payoutId = '67c68e11-02b9-42d8-98a1-56eb777a24af';

test('payout admin request validation', async t => {
  await t.test('accepts a list request and ignores extra client fields', () => {
    assert.deepEqual(parsePayoutAdminRequest({ action: 'list', limit: 999 }), { action: 'list' });
  });
  await t.test('normalizes review justification and validates payout UUID', () => {
    assert.deepEqual(parsePayoutAdminRequest({ action: 'approve', payout_id: payoutId, reason: '  Revisão aprovada pelo financeiro.  ' }), {
      action: 'approve', payoutId, reason: 'Revisão aprovada pelo financeiro.',
    });
  });
  await t.test('accepts a rejection reason within the bounded range', () => {
    assert.equal(parsePayoutAdminRequest({ action: 'reject', payout_id: payoutId, reason: 'Risco identificado pelo time.' })?.action, 'reject');
  });
  await t.test('accepts a separately authorized dispatch action with a required reason', () => {
    assert.deepEqual(parsePayoutAdminRequest({ action: 'dispatch', payout_id: payoutId, reason: 'Envio aprovado em dupla conferência.' }), {
      action: 'dispatch', payoutId, reason: 'Envio aprovado em dupla conferência.',
    });
  });
  await t.test('accepts a read-only reconciliation action with a required reason', () => {
    assert.deepEqual(parsePayoutAdminRequest({ action: 'reconcile', payout_id: payoutId, reason: 'Conferência após retorno ambíguo.' }), {
      action: 'reconcile', payoutId, reason: 'Conferência após retorno ambíguo.',
    });
  });
  await t.test('accepts a manual payout completion action with transfer id and reason', () => {
    assert.deepEqual(parsePayoutAdminRequest({ action: 'complete_manual', payout_id: payoutId, provider_transfer_id: 'E12345678202610131234', reason: 'Pix realizado via app bancario.' }), {
      action: 'complete_manual', payoutId, providerTransferId: 'E12345678202610131234', reason: 'Pix realizado via app bancario.',
    });
    assert.deepEqual(parsePayoutAdminRequest({ action: 'complete_manual', payout_id: payoutId, e2e_id: 'E12345678202610131234' }), {
      action: 'complete_manual', payoutId, providerTransferId: 'E12345678202610131234', reason: 'Saque Pix realizado e concluído manualmente pelo Super Admin.',
    });
  });
  await t.test('rejects malformed, underspecified, oversized, or unsupported payloads', () => {
    for (const payload of [null, [], {}, { action: 'run' }, { action: 'approve', payout_id: '1', reason: 'long enough reason' },
      { action: 'reject', payout_id: payoutId, reason: ' curto ' },
      { action: 'reject', payout_id: payoutId, reason: 'x'.repeat(501) },
      { action: 'approve', payout_id: payoutId, reason: 22 }]) {
      assert.equal(parsePayoutAdminRequest(payload), null);
    }
  });
});

test('merchant payout history request validation', () => {
  assert.deepEqual(parseMerchantPayoutListRequest({ business_id: payoutId }), {
    businessId: payoutId, beforeCreatedAt: null, beforePayoutId: null,
  });
  assert.deepEqual(parseMerchantPayoutListRequest({ business_id: payoutId,
    before_created_at: '2026-10-10T12:30:45.123456-03:00', before_payout_id: payoutId }), {
    businessId: payoutId, beforeCreatedAt: '2026-10-10T12:30:45.123456-03:00', beforePayoutId: payoutId,
  });
  assert.equal(parseMerchantPayoutListRequest({ business_id: 'bad' }), null);
  assert.equal(parseMerchantPayoutListRequest(null), null);
  assert.equal(parseMerchantPayoutListRequest({ business_id: ['not-a-uuid'] }), null);
  for (const cursor of [
    { before_created_at: 'yesterday', before_payout_id: payoutId },
    { before_created_at: '2026-10-10T12:30:45Z' },
    { before_payout_id: payoutId },
    { before_created_at: '2026-02-30T12:30:45Z', before_payout_id: payoutId },
  ]) assert.equal(parseMerchantPayoutListRequest({ business_id: payoutId, ...cursor }), null);
});

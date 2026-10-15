import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSettlementReleaseRequest, releaseSettlementBatch, settlementRequestHash, type SettlementCandidate } from './settlement-release.ts';

const candidate: SettlementCandidate = {
  reconciliation_item_id: '54c11d3c-d772-4d79-a1a0-93c69da350d3',
  transaction_id: '54c11d3c-d772-4d79-a1a0-93c69da350d4',
  provider_transaction_id: 'provider-ref-1',
  gross_amount_cents: '10000', provider_fee_cents: '100', merchant_fee_cents: '99', merchant_net_cents: '9901',
};

test('reconciled settlement release contract', async t => {
  await t.test('validates optional reconciliation scope and bounded batch size', () => {
    assert.deepEqual(parseSettlementReleaseRequest({}), { limit: 50 });
    assert.deepEqual(parseSettlementReleaseRequest({ run_id: candidate.reconciliation_item_id, limit: 100 }), { runId: candidate.reconciliation_item_id, limit: 100 });
    for (const input of [null, [], { limit: 0 }, { limit: 101 }, { limit: '50' }, { run_id: 'invalid' }]) {
      assert.equal(parseSettlementReleaseRequest(input), null);
    }
  });

  await t.test('hash binds immutable reconciliation evidence and normalizes bigint strings', async () => {
    const hash = await settlementRequestHash(candidate);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash, await settlementRequestHash({ ...candidate, gross_amount_cents: 10000, provider_fee_cents: 100 }));
    assert.notEqual(hash, await settlementRequestHash({ ...candidate, provider_fee_cents: 101 }));
    assert.notEqual(hash, await settlementRequestHash({ ...candidate, transaction_id: '54c11d3c-d772-4d79-a1a0-93c69da350d5' }));
    await assert.rejects(settlementRequestHash({ ...candidate, merchant_net_cents: 9000 }), /settlement_candidate_invalid/);
  });

  await t.test('continues a bounded batch while reporting each failure safely', async () => {
    const second = { ...candidate, reconciliation_item_id: '54c11d3c-d772-4d79-a1a0-93c69da350d5' };
    const results = await releaseSettlementBatch([candidate, second], async item => {
      if (item === second) throw new Error('database detail must not leak');
      return '54c11d3c-d772-4d79-a1a0-93c69da350d6';
    });
    assert.equal(results[0].status, 'released');
    assert.equal(results[1].status, 'failed');
    assert.equal(results[1].error, 'settlement_release_failed');
  });
});

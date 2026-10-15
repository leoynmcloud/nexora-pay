import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFinancialSnapshot } from './provider-financials.ts';

test('verified provider net and fee snapshot', async (t) => {
  await t.test('derives integer cents from the provider-confirmed net value', () => {
    assert.deepEqual(providerFinancialSnapshot(100, 98.51), {
      grossAmountCents: 10_000, providerNetCents: 9_851, providerFeeCents: 149,
    });
    assert.deepEqual(providerFinancialSnapshot('10.05', '10.05'), {
      grossAmountCents: 1_005, providerNetCents: 1_005, providerFeeCents: 0,
    });
  });

  await t.test('rejects absent, sub-cent, unsafe, or impossible amounts', () => {
    for (const [gross, net] of [
      [100, null], [100, 99.999], [0, 0], [100, 0], [100, 101],
      [Number.MAX_SAFE_INTEGER, 1], ['NaN', 1],
    ]) assert.throws(() => providerFinancialSnapshot(gross, net), /provider_financial_snapshot_invalid/);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReconciliationAdminRequest } from './reconciliation-admin.ts';

test('reconciliation admin read request validation', async t => {
  await t.test('defaults to recent-run listing with offset zero', () => {
    assert.deepEqual(parseReconciliationAdminRequest({}), {
      ok: true, value: { runId: undefined, itemsOffset: 0, exceptionsOffset: 0 },
    });
  });

  await t.test('accepts only a UUID run and bounded safe integer offsets', () => {
    const runId = '54c11d3c-d772-4d79-a1a0-93c69da350d3';
    assert.deepEqual(parseReconciliationAdminRequest({ run_id: runId, items_offset: 50, exceptions_offset: 100 }), {
      ok: true, value: { runId, itemsOffset: 50, exceptionsOffset: 100 },
    });
    assert.deepEqual(parseReconciliationAdminRequest({ run_id: runId, offset: 100_000 }), {
      ok: true, value: { runId, itemsOffset: 100_000, exceptionsOffset: 0 },
    });
  });

  await t.test('rejects malformed payloads and offsets before any database access', () => {
    for (const value of [null, [], 'run', 1]) assert.deepEqual(parseReconciliationAdminRequest(value), { ok: false, error: 'invalid_request' });
    for (const offset of [-1, 100_001, 1.5, '50', Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(parseReconciliationAdminRequest({ offset }), { ok: false, error: 'invalid_offset' });
      assert.deepEqual(parseReconciliationAdminRequest({ exceptions_offset: offset }), { ok: false, error: 'invalid_offset' });
    }
    for (const run_id of ['', '../runs', '54c11d3c-d772-4d79-a1a0-93c69da350d3/']) {
      assert.deepEqual(parseReconciliationAdminRequest({ run_id }), { ok: false, error: 'invalid_run_id' });
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectAsaasStatementPages, normalizeAsaasStatementLine } from './asaas-statement.ts';

const credit = { id: 'ft_1', type: 'PAYMENT_RECEIVED', paymentId: 'pay_1', value: 150, date: '2026-10-09' };
const fee = { id: 'ft_2', type: 'PAYMENT_FEE', paymentId: 'pay_1', value: -2.99, date: '2026-10-09' };

describe('Asaas statement adapter', () => {
  it('normalizes documented receipt and fee types without changing financial signs', () => {
    assert.deepEqual(normalizeAsaasStatementLine(credit), {
      externalEntryId: 'ft_1', providerTransactionId: 'pay_1', providerEntryType: 'PAYMENT_RECEIVED',
      providerDate: '2026-10-09',
      kind: 'payment_credit', direction: 'credit', amountCents: 15_000,
    });
    assert.equal(normalizeAsaasStatementLine(fee).amountCents, 299);
    assert.equal(normalizeAsaasStatementLine(fee).kind, 'payment_fee');
    assert.equal(normalizeAsaasStatementLine(fee).direction, 'debit');
  });

  it('keeps unknown/reversal types as adverse evidence, never silently a credit', () => {
    const row = normalizeAsaasStatementLine({ id: 'ft_3', type: 'PAYMENT_REVERSAL',
      paymentId: 'pay_1', value: -25, date: '2026-10-09' });
    assert.equal(row.kind, 'other');
    assert.equal(row.providerEntryType, 'PAYMENT_REVERSAL');
  });

  it('does not guess an absent payment ID from amount or date', () => {
    const row = normalizeAsaasStatementLine({ id: 'ft_4', type: 'PAYMENT_RECEIVED', value: 150, date: '2026-10-09' });
    assert.equal(row.providerTransactionId, '');
  });

  it('rejects invalid signs, sub-cent values, and unsafe amounts', () => {
    assert.throws(() => normalizeAsaasStatementLine({ ...credit, value: -150 }));
    assert.throws(() => normalizeAsaasStatementLine({ ...fee, value: 2.99 }));
    assert.throws(() => normalizeAsaasStatementLine({ ...credit, value: 1.001 }));
    assert.throws(() => normalizeAsaasStatementLine({ ...credit, value: Number.MAX_SAFE_INTEGER }));
  });

  it('marks only contiguous, complete pages with stable totals as complete', () => {
    const first = { offset: 0, limit: 1, totalCount: 2, hasMore: true, data: [credit] };
    const second = { offset: 1, limit: 1, totalCount: 2, hasMore: false, data: [fee] };
    assert.equal(collectAsaasStatementPages([first]).complete, false);
    assert.equal(collectAsaasStatementPages([first, second]).complete, true);
    assert.equal(collectAsaasStatementPages([]).complete, false);
    assert.throws(() => collectAsaasStatementPages([first, { ...second, offset: 2 }]));
    assert.throws(() => collectAsaasStatementPages([first, { ...second, totalCount: 3 }]));
    assert.throws(() => collectAsaasStatementPages([first, { ...second, data: [credit] }]));
  });
});

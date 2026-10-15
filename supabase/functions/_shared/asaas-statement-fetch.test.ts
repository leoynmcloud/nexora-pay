import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertClosedStatementDate, fetchAsaasProductionStatement } from './asaas-statement-fetch.ts';

const key = '$aact_prod_fake-for-local-unit-test';
const date = '2026-10-09';
const credit = { id: 'ft_1', type: 'PAYMENT_RECEIVED', paymentId: 'pay_1', value: 150, date };
const fee = { id: 'ft_2', type: 'PAYMENT_FEE', paymentId: 'pay_1', value: -2.99, date };

function stub(pages: object[], calls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal((init?.headers as Record<string, string>).access_token, key);
    return Response.json(pages.shift() || {}, { status: 200 });
  }) as typeof fetch;
}

describe('Asaas closed-period statement fetch', () => {
  it('rejects today, the future, and invalid calendar dates', () => {
    assert.equal(assertClosedStatementDate(date, '2026-10-10'), date);
    for (const bad of ['2026-10-10', '2026-10-11', '2026-02-31', '2026-10-9']) {
      assert.throws(() => assertClosedStatementDate(bad, '2026-10-10'));
    }
  });

  it('fetches every page from the fixed production host and preserves IDs', async () => {
    const calls: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ ...credit, id: `ft_credit_${index}` }));
    const lines = await fetchAsaasProductionStatement(key, date, stub([
      { offset: 0, limit: 100, totalCount: 101, hasMore: true, data: firstPage },
      { offset: 100, limit: 100, totalCount: 101, hasMore: false, data: [fee] },
    ], calls));
    assert.equal(lines.length, 101);
    assert.equal(lines[0].providerTransactionId, 'pay_1');
    assert.match(calls[0], /^https:\/\/api\.asaas\.com\/v3\/financialTransactions\?/);
    assert.match(calls[0], /startDate=2026-10-09/);
    assert.match(calls[1], /offset=100/);
  });

  it('fails closed on incomplete or date-mismatched responses', async () => {
    await assert.rejects(fetchAsaasProductionStatement(key, date, stub([
      { offset: 0, limit: 100, totalCount: 2, hasMore: false, data: [credit] },
    ])), /statement_incomplete/);
    await assert.rejects(fetchAsaasProductionStatement(key, date, stub([
      { offset: 0, limit: 100, totalCount: 1, hasMore: false,
        data: [{ ...credit, date: '2026-10-08' }] },
    ])), /statement_incomplete/);
    await assert.rejects(fetchAsaasProductionStatement('invalid', date, stub([])), /statement_credential_invalid/);
  });
});

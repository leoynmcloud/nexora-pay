import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMercadoPagoProductionStatement } from './mercadopago-statement-fetch.ts';

const token = 'APP_USR-abcdefgh12345678';
const begin = '2026-10-09T03:00:00.000Z';
const end = '2026-10-10T02:59:59.000Z';
const csv = [
  'SOURCE_ID;PAYMENT_METHOD_TYPE;PAYMENT_METHOD;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_CURRENCY;TRANSACTION_DATE;FEE_AMOUNT;SETTLEMENT_NET_AMOUNT;SETTLEMENT_CURRENCY;SETTLEMENT_DATE',
  'mp-pay-9001;bank_transfer;pix;SETTLEMENT;100.00;BRL;2026-10-09T12:00:00-03:00;-2.00;98.00;BRL;2026-10-09T12:00:03-03:00',
].join('\n');
const report = (fileName: string, overrides: Record<string, unknown> = {}) => ({
  id: 42, begin_date: begin, end_date: end, file_name: fileName, ...overrides,
});
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('Mercado Pago statement report fetch', () => {
  it('downloads only one exact, completed report from the fixed official host and normalizes it', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (calls.length === 1) return jsonResponse({ paging: { total: 1, limit: 500, offset: 0 }, results: [report('settlement-report-42.csv')] });
      return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
    };
    const lines = await fetchMercadoPagoProductionStatement(token, '2026-10-09', fetcher);
    assert.equal(calls.length, 2);
    const search = new URL(calls[0].url);
    assert.equal(search.origin, 'https://api.mercadopago.com');
    assert.equal(search.pathname, '/v1/account/settlement_report/search');
    assert.equal(search.searchParams.get('begin_date'), begin);
    assert.equal(search.searchParams.get('end_date'), end);
    assert.equal(search.searchParams.get('format'), 'CSV');
    assert.equal(new Headers(calls[0].init?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(calls[0].init?.redirect, 'error');
    assert.equal(calls[1].url, 'https://api.mercadopago.com/v1/account/settlement_report/settlement-report-42.csv');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].kind, 'payment_credit');
    assert.equal(lines[1].kind, 'payment_fee');
  });

  it('fails closed when no completed exact-window report exists or the report is ambiguous', async () => {
    const noReport: typeof fetch = async () => jsonResponse({ paging: { total: 0, limit: 500, offset: 0 }, results: [] });
    await assert.rejects(fetchMercadoPagoProductionStatement(token, '2026-10-09', noReport), /statement_report_not_ready/);
    const ambiguous: typeof fetch = async () => jsonResponse({ paging: { total: 2, limit: 500, offset: 0 }, results: [
      report('settlement-report-1.csv'), report('settlement-report-2.csv'),
    ] });
    await assert.rejects(fetchMercadoPagoProductionStatement(token, '2026-10-09', ambiguous), /statement_report_ambiguous/);
  });

  it('rejects invalid credentials/dates and report paths that are not safe filenames', async () => {
    await assert.rejects(fetchMercadoPagoProductionStatement('TEST-token-12345678', '2026-10-09'), /statement_credential_invalid/);
    await assert.rejects(fetchMercadoPagoProductionStatement(token, '2026-02-30'), /statement_date_invalid/);
    const unsafeFile: typeof fetch = async () => jsonResponse({ paging: { total: 1, limit: 500, offset: 0 }, results: [report('../other.csv')] });
    await assert.rejects(fetchMercadoPagoProductionStatement(token, '2026-10-09', unsafeFile), /statement_report_not_ready/);
  });
});

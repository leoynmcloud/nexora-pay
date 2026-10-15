import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMercadoPagoSettlementReport } from './mercadopago-statement.ts';

const header = 'SOURCE_ID;PAYMENT_METHOD_TYPE;PAYMENT_METHOD;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_CURRENCY;TRANSACTION_DATE;FEE_AMOUNT;SETTLEMENT_NET_AMOUNT;SETTLEMENT_CURRENCY;SETTLEMENT_DATE';
const report = (...rows: string[]) => `${header}\n${rows.join('\n')}`;
const pixSettlement = (overrides: Record<string, string> = {}) => {
  const values: Record<string, string> = {
    SOURCE_ID: 'mp-pay-9001', PAYMENT_METHOD_TYPE: 'bank_transfer', PAYMENT_METHOD: 'pix',
    TRANSACTION_TYPE: 'SETTLEMENT', TRANSACTION_AMOUNT: '100.00', TRANSACTION_CURRENCY: 'BRL',
    TRANSACTION_DATE: '2026-10-09T12:00:00-03:00', FEE_AMOUNT: '-2.00',
    SETTLEMENT_NET_AMOUNT: '98.00', SETTLEMENT_CURRENCY: 'BRL',
    SETTLEMENT_DATE: '2026-10-09T12:00:03-03:00', ...overrides,
  };
  return ['SOURCE_ID','PAYMENT_METHOD_TYPE','PAYMENT_METHOD','TRANSACTION_TYPE','TRANSACTION_AMOUNT',
    'TRANSACTION_CURRENCY','TRANSACTION_DATE','FEE_AMOUNT','SETTLEMENT_NET_AMOUNT',
    'SETTLEMENT_CURRENCY','SETTLEMENT_DATE'].map(key => values[key]).join(';');
};

describe('Mercado Pago account-money statement normalization', () => {
  it('turns a verified BRL Pix settlement into gross credit and separate provider fee', () => {
    assert.deepEqual(normalizeMercadoPagoSettlementReport(report(pixSettlement()), '2026-10-09'), [
      { externalEntryId: 'mp:mp-pay-9001:settlement:credit', providerTransactionId: 'mp-pay-9001',
        providerEntryType: 'SETTLEMENT', providerDate: '2026-10-09', kind: 'payment_credit', direction: 'credit', amountCents: 10_000 },
      { externalEntryId: 'mp:mp-pay-9001:settlement:fee', providerTransactionId: 'mp-pay-9001',
        providerEntryType: 'SETTLEMENT', providerDate: '2026-10-09', kind: 'payment_fee', direction: 'debit', amountCents: 200 },
    ]);
  });

  it('does not invent a fee line when provider fee is zero', () => {
    const lines = normalizeMercadoPagoSettlementReport(report(pixSettlement({ FEE_AMOUNT: '0.00', SETTLEMENT_NET_AMOUNT: '100.00' })), '2026-10-09');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].amountCents, 10_000);
  });

  it('preserves non-Pix operations as adverse evidence, not payment credit', () => {
    const row = pixSettlement({ PAYMENT_METHOD_TYPE: 'credit_card', PAYMENT_METHOD: 'visa' });
    const lines = normalizeMercadoPagoSettlementReport(report(row), '2026-10-09');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'other');
    assert.equal(lines[0].amountCents, 9_800);
  });

  it('fails closed on wrong date/currency, inconsistent gross-fee-net, malformed CSV and duplicate references', () => {
    assert.throws(() => normalizeMercadoPagoSettlementReport(report(pixSettlement()), '2026-10-08'), /statement_date_mismatch/);
    assert.throws(() => normalizeMercadoPagoSettlementReport(report(pixSettlement({ SETTLEMENT_NET_AMOUNT: '97.99' })), '2026-10-09'), /statement_financial_identity_mismatch/);
    assert.throws(() => normalizeMercadoPagoSettlementReport(report(pixSettlement({ SETTLEMENT_CURRENCY: 'USD' })), '2026-10-09'), /statement_currency_unsupported/);
    assert.throws(() => normalizeMercadoPagoSettlementReport(`${header}\n"unterminated`, '2026-10-09'), /statement_csv_invalid/);
    assert.throws(() => normalizeMercadoPagoSettlementReport(report(pixSettlement(), pixSettlement()), '2026-10-09'), /statement_entry_duplicate/);
  });

  it('handles quoted delimiters and rejects unsupported or oversized report shapes', () => {
    const quoted = `${header};METADATA\n${pixSettlement()};"{""note"":""x;y""}"`;
    assert.equal(normalizeMercadoPagoSettlementReport(quoted, '2026-10-09').length, 2);
    assert.throws(() => normalizeMercadoPagoSettlementReport('SOURCE_ID;TRANSACTION_TYPE\na;SETTLEMENT', '2026-10-09'), /statement_columns_invalid/);
    assert.throws(() => normalizeMercadoPagoSettlementReport('x'.repeat(8 * 1024 * 1024 + 1), '2026-10-09'), /statement_too_large/);
  });
});

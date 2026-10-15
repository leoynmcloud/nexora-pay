import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const core = createRequire(import.meta.url)('../../../nexora-core.js');
const app = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../../../nexora-app.css', import.meta.url), 'utf8');

test('ledger CSV exports each posted movement with direction and formula-safe text', () => {
  const csv = core.ledgerCsv([{
    journal_id: 'journal-1', transaction_id: 'tx-1', event_code: 'payment.received',
    description: '=HYPERLINK("https://evil.test")', created_at: '2026-10-10T12:00:00Z',
    movements: [
      { bucket: 'merchant_pending', side: 'credit', amount_cents: '12345' },
      { bucket: 'provider_clearing', side: 'debit', amount_cents: 12345 },
    ],
  }]);

  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"Data";"Evento";"Descrição";"ID do lançamento"/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/evil\.test""\)"/);
  assert.match(csv, /"merchant_pending";"Crédito";"123,45"/);
  assert.match(csv, /"provider_clearing";"Débito";"123,45"/);
});

test('ledger CSV rejects unsafe cent values and labels export scope in the merchant page', () => {
  assert.throws(() => core.ledgerCsv([{ movements: [{ side: 'credit', amount_cents: Number.MAX_SAFE_INTEGER + 1 }] }]), /Valor inválido/);
  assert.throws(() => core.ledgerCsv([{ movements: [{ side: 'credit', amount_cents: -1 }] }]), /Valor inválido/);
  assert.match(app, /data-action="statement-export"/);
  assert.match(app, /somente os registros já carregados nesta lista/);
  assert.match(app, /download\(C\.ledgerCsv\(statement\.rows\)/);
  assert.match(appCss, /@media\(max-width:600px\)\{\.nx-ledger-statement \.panel-head\{align-items:stretch;flex-direction:column\}/);
  assert.match(appCss, /\.nx-ledger-statement \.panel-head \.button\{min-height:44px\}/);
});

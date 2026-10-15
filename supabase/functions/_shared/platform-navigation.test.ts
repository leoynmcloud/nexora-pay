import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const html = readFileSync(new URL('platform.html', root), 'utf8');
const app = readFileSync(new URL('platform-app.js', root), 'utf8');

describe('merchant platform transaction navigation', () => {
  it('keeps one transaction destination in the sidebar and retains the legacy receipt deep link', () => {
    const sidebar = html.match(/<nav class="side-nav"[\s\S]*?<\/nav>/)?.[0] || '';
    assert.equal((sidebar.match(/data-route="transacoes"/g) || []).length, 1);
    assert.doesNotMatch(sidebar, /href="#recebimentos"|>\s*Recebimentos\s*</i);
    assert.match(app, /if \(key === 'recebimentos'\).*transactionView = 'receipts'/s);
  });

  it('offers accessible nested tabs for charges and confirmed receipts', () => {
    assert.match(app, /role="tablist" aria-label="Visão das transações"/);
    assert.match(app, /id="transaction-tab-charges" type="button" role="tab" data-transaction-view="charges" aria-controls="transaction-results"/);
    assert.match(app, /id="transaction-tab-receipts" type="button" role="tab" data-transaction-view="receipts" aria-controls="transaction-results"/);
    assert.match(app, /aria-selected="\$\{receiptsOnly\}"/);
    assert.match(app, /role="tabpanel" aria-labelledby="\$\{receiptsOnly/);
    assert.match(app, /event\.key === 'ArrowRight'/);
  });

  it('maps sidebar active state by route metadata instead of link position', () => {
    assert.match(html, /href="#transacoes" data-route="transacoes"/);
    assert.match(app, /\.side-nav a\[data-route\]/);
    assert.doesNotMatch(app, /const key = \['resumo', 'transacoes', 'recebimentos'/);
  });
});

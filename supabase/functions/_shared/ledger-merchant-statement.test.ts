import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../../nexora-ledger-merchant-statement.sql', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../../platform.html', import.meta.url), 'utf8');

test('merchant statement RPC scopes every page and movement to authenticated owner workspace', () => {
  assert.match(sql, /auth\.uid\(\)/i);
  assert.match(sql, /b\.id=p_business_id and b\.owner_id=v_owner/i);
  assert.match(sql, /j\.business_id=p_business_id and j\.owner_id=v_owner/i);
  assert.match(sql, /e\.business_id=p_business_id and e\.owner_id=v_owner/i);
  assert.match(sql, /a\.business_id=p_business_id and a\.owner_id=v_owner/i);
});

test('merchant statement is bounded, keyset-paginated, and exposes only customer balance buckets', () => {
  assert.match(sql, /p_limit not between 1 and 100/i);
  assert.match(sql, /\(j\.created_at,j\.id\)<\(p_before_created_at,p_before_journal_id\)/i);
  assert.match(sql, /limit p_limit\+1/i);
  assert.match(sql, /on public\.nexora_ledger_entries\(journal_id,account_id\) include \(side,amount_cents\)/i);
  assert.match(sql, /merchant_available','merchant_pending','merchant_reserved','merchant_blocked/i);
  assert.match(sql, /revoke all on function[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql, /grant execute on function[\s\S]*to authenticated/i);
  assert.doesNotMatch(sql, /grant select on public\.nexora_ledger_(accounts|entries|journals)[\s\S]*to authenticated/i);
});

test('platform links the statement separately from payment transactions and paginates through the RPC', () => {
  assert.match(html, /href="#extrato"[^>]*>\s*<span[^>]*>.*?Extrato/s);
  assert.match(app, /href="#extrato">Ver extrato/);
  assert.match(app, /nexora_ledger_merchant_statement/);
  assert.match(app, /p_before_created_at:[\s\S]*p_before_journal_id:[\s\S]*p_limit: 50/);
  assert.match(app, /statement-more/);
  assert.match(app, /Aplique a migração nexora-ledger-merchant-statement\.sql/);
});

test('statement cache is cleared on account/workspace change and stale requests cannot repaint it', () => {
  assert.match(app, /function resetStatement\(\)[\s\S]*businessId: null/);
  assert.match(app, /statement\.businessId !== state\?\.business_id/);
  assert.match(app, /generation !== statementGeneration \|\| state\?\.business_id !== businessId/);
  assert.match(app, /nexora-access-ready',[\s\S]*resetStatement\(\)/);
  assert.match(app, /'payment\.received': 'Pagamento recebido'/);
  assert.match(app, /'settlement\.released': 'Liquidação conciliada'/);
});

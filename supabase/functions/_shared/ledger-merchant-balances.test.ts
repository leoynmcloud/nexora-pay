import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const balancesSql = readFileSync(new URL('../../../nexora-ledger-balances-read.sql', import.meta.url), 'utf8');
const ledgerSql = readFileSync(new URL('../../../nexora-production-ledger.sql', import.meta.url), 'utf8');
const merchantUi = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');
const merchantCore = readFileSync(new URL('../../../nexora-core.js', import.meta.url), 'utf8');
const historySql = readFileSync(new URL('../../../nexora-ledger-balance-history.sql', import.meta.url), 'utf8');
const balanceHistory = createRequire(import.meta.url)('../../../ledger-balance-history.js');

test('merchant balance RPC is authenticated and restricted to the caller-owned workspace', () => {
  assert.match(balancesSql, /auth\.uid\(\) is null/);
  assert.match(balancesSql, /b\.id=p_business_id and b\.owner_id=auth\.uid\(\)/);
  assert.match(balancesSql, /revoke all on function public\.nexora_ledger_merchant_balances\(uuid\) from public,anon/i);
  assert.match(balancesSql, /grant execute on function public\.nexora_ledger_merchant_balances\(uuid\) to authenticated/i);
  assert.match(ledgerSql, /revoke all on public\.nexora_ledger_accounts, public\.nexora_ledger_journals, public\.nexora_ledger_entries from public, anon, authenticated/i);
});

test('balance read model derives four separate merchant liability buckets from immutable ledger entries', () => {
  for (const accountCode of ['merchant_available', 'merchant_pending', 'merchant_reserved', 'merchant_blocked']) {
    assert.ok(balancesSql.includes(`a.account_code='${accountCode}'`));
  }
  assert.match(balancesSql, /e\.side='credit' then e\.amount_cents else -e\.amount_cents/);
  assert.match(balancesSql, /left join public\.nexora_ledger_entries e on e\.account_id=a\.id/);
  assert.match(balancesSql, /'currency','BRL'/);
  assert.match(ledgerSql, /create trigger nexora_ledger_entries_immutable before update or delete on public\.nexora_ledger_entries/i);
  assert.doesNotMatch(balancesSql, /provider_clearing|platform_fee_revenue|provider_fee_expense/);
});

test('merchant UI distinguishes ledger balance from payouts and requires a positive server readiness decision', () => {
  assert.match(merchantUi, /Não significa saque imediato/);
  assert.match(merchantUi, /ainda não disponível para saque/);
  assert.match(merchantUi, /saldo disponível no ledger não significa transferência liberada/i);
  assert.match(merchantUi, /state\.payout_readiness\?\.canRequest === true/);
  assert.match(merchantUi, /readiness\?\.canRequest !== true/);
  assert.match(merchantUi, /nexora-payout-request/);
});

test('merchant UI and exports do not present provider payment confirmation as settlement', () => {
  assert.match(merchantUi, /Confirmações do adquirente no período; não representam liquidação/);
  assert.match(merchantUi, /Valor bruto; não comprova liquidação nem saldo sacável/);
  assert.match(merchantUi, /Confirmação do pagamento/);
  assert.match(merchantUi, /Pendente de conciliação bancária do adquirente/);
  assert.match(merchantUi, /compensação transitória do ledger/);
  assert.match(merchantUi, /Pendente de conciliação/);
  assert.doesNotMatch(merchantUi, /Pagamentos liquidados pelo adquirente|Nenhum pagamento liquidado neste período/);
  assert.match(merchantCore, /'Confirmação do pagamento'/);
  assert.doesNotMatch(merchantCore, /'Liquidação'/);
});

test('balance history RPC is bounded, timezone-stable, ledger-derived, and scoped to the authenticated workspace', () => {
  assert.match(historySql, /auth\.uid\(\)/);
  assert.match(historySql, /b\.id=p_business_id and b\.owner_id=v_owner/);
  assert.match(historySql, /p_days not between 1 and 365/);
  assert.match(historySql, /America\/Sao_Paulo/);
  assert.match(historySql, /e\.side='credit' then e\.amount_cents else -e\.amount_cents/);
  assert.match(historySql, /left join daily x on x\.day=d\.day and x\.account_code=c\.account_code/);
  assert.match(historySql, /grant execute on function public\.nexora_ledger_merchant_balance_history\(uuid,integer\) to authenticated/i);
  assert.match(historySql, /from public,anon,authenticated,service_role/);
  assert.match(merchantUi, /API\.rpc\('nexora_ledger_merchant_balance_history'/);
  assert.match(merchantUi, /<h2>Saldo total da conta<\/h2>/);
  assert.match(merchantUi, /data-action="statement-export"/);
});

test('balance history display model sums buckets and fails closed for malformed or duplicate days', () => {
  const rows = balanceHistory.normalize([
    { day: '2026-10-09', available: '5.00', pending: '2.00', reserved: '1.00', blocked: '0.00' },
    { day: '2026-10-10', available: 6, pending: 2, reserved: 1, blocked: 1 },
  ]);
  assert.deepEqual(rows.map(row => row.total), [800, 1000]);
  assert.equal(rows[1].available, 600);
  assert.equal(balanceHistory.normalize([{ day: '2026-02-30', available: 0, pending: 0, reserved: 0, blocked: 0 }]), null);
  assert.equal(balanceHistory.normalize([
    { day: '2026-10-10', available: 0, pending: 0, reserved: 0, blocked: 0 },
    { day: '2026-10-10', available: 0, pending: 0, reserved: 0, blocked: 0 },
  ]), null);
  assert.equal(balanceHistory.normalize([{ day: '2026-10-10', available: 0, pending: 0 }]), null);
  assert.equal(balanceHistory.normalize([{ day: '2026-10-10', available: null, pending: 0, reserved: 0, blocked: 0 }]), null);
  assert.equal(balanceHistory.normalize([{ day: '2026-10-10', available: '', pending: 0, reserved: 0, blocked: 0 }]), null);
  assert.equal(balanceHistory.normalize([{ day: '2026-10-10', available: true, pending: 0, reserved: 0, blocked: 0 }]), null);
});

test('balance chart periods use fixed ranges and Sao Paulo year-to-date boundaries', () => {
  assert.equal(balanceHistory.daysForRange('Últimos 7 dias'), 7);
  assert.equal(balanceHistory.daysForRange('Último mês'), 30);
  assert.equal(balanceHistory.daysForRange('Últimos 6 meses'), 180);
  assert.equal(balanceHistory.daysForRange('Este ano', new Date('2026-10-10T15:00:00.000Z')), 283);
  assert.equal(balanceHistory.daysForRange('Este ano', new Date('2026-01-01T02:00:00.000Z')), 365);
});

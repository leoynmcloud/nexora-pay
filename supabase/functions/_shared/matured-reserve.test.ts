import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { maturedReserveRequestHash, parseMaturedReserveRequest } from './matured-reserve.ts';

const holdbackSql = readFileSync(new URL('../../../nexora-reserve-holdback.sql', import.meta.url), 'utf8');

test('matured reserve processing contract', async t => {
  await t.test('defaults to read-only queue listing and bounds batches', () => {
    assert.deepEqual(parseMaturedReserveRequest({}), { action: 'list', limit: 50 });
    assert.deepEqual(parseMaturedReserveRequest({ action: 'release', limit: 100 }), { action: 'release', limit: 100 });
    for (const input of [null, [], 'release', { action: 'drop' }, { limit: 0 }, { limit: 101 }, { limit: '50' }]) {
      assert.equal(parseMaturedReserveRequest(input), null);
    }
  });

  await t.test('hash binds the immutable settlement, cents, and maturity timestamp', async () => {
    const reserve = {
      settlement_id: '54c11d3c-d772-4d79-a1a0-93c69da350d3',
      amount_cents: 12345,
      reserve_release_at: '2026-10-10T12:00:00-03:00',
    };
    const hash = await maturedReserveRequestHash(reserve);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash, await maturedReserveRequestHash({ ...reserve, reserve_release_at: '2026-10-10T15:00:00Z' }));
    assert.notEqual(hash, await maturedReserveRequestHash({ ...reserve, amount_cents: 12346 }));
    assert.notEqual(hash, await maturedReserveRequestHash({ ...reserve, settlement_id: '54c11d3c-d772-4d79-a1a0-93c69da350d4' }));
    assert.equal(hash, await maturedReserveRequestHash({ ...reserve, amount_cents: '12345' }));
    await assert.rejects(maturedReserveRequestHash({ ...reserve, amount_cents: 0 }), /matured_reserve_invalid/);
    await assert.rejects(maturedReserveRequestHash({ ...reserve, amount_cents: '9007199254740992' }), /matured_reserve_invalid/);
  });
});

test('settlement snapshots and releases reserve only from reconciled funds', () => {
  const settlementStart = holdbackSql.indexOf('create or replace function public.nexora_settlement_release(');
  const settlementEnd = holdbackSql.indexOf('\n$$;', settlementStart);
  assert.ok(settlementStart >= 0 && settlementEnd > settlementStart);
  const settlement = holdbackSql.slice(settlementStart, settlementEnd);
  assert.match(settlement, /auth\.jwt\(\)->>'role',''\) <> 'service_role'/);
  assert.match(settlement, /v_item\.result <> 'matched'/);
  assert.match(settlement, /not v_run\.statement_complete or v_run\.environment <> 'production'/);
  assert.match(settlement, /v_payment\.status <> 'paid' or v_payment\.test_mode/);
  assert.match(settlement, /v_payment\.payment_method <> 'pix'/);
  assert.match(settlement, /v_item\.provider_credit_cents <> v_item\.gross_amount_cents/);
  assert.match(settlement, /v_pricing\.merchant_net_cents <> v_item\.expected_merchant_net_cents/);
  assert.match(settlement, /v_receipt_journal_count<>1/);
  assert.match(settlement, /v_receipt_entry_count<>2/);
  assert.match(settlement, /a\.account_code='merchant_pending' and e\.side='credit'/);
  assert.match(settlement, /a\.account_code='provider_clearing' and e\.side='debit'/);
  assert.doesNotMatch(settlement, /merchant_available.*?payment\.received/s);
  assert.match(settlement, /v_reserved := round\(v_net\*v_percentage\/100\)::bigint/);
  assert.match(settlement, /v_release_at := now\(\)\+make_interval\(days=>v_days\)/);
  const businessLock = settlement.indexOf('perform 1 from public.businesses');
  const policyLock = settlement.indexOf('for share;', businessLock);
  const journalPost = settlement.indexOf('public.nexora_ledger_post_journal(');
  assert.ok(businessLock >= 0 && policyLock > businessLock && journalPost > policyLock);

  const assertionStart = holdbackSql.indexOf('create or replace function public.nexora_assert_settlement_evidence(');
  const assertionEnd = holdbackSql.indexOf('\n$$;', assertionStart);
  assert.ok(assertionStart >= 0 && assertionEnd > assertionStart);
  const assertion = holdbackSql.slice(assertionStart, assertionEnd);
  assert.match(assertion, /new\.reserve_amount_cents <> round\(new\.net_amount_cents\*new\.reserve_percentage_applied\/100\)::bigint/);
  assert.match(assertion, /v_available <> new\.available_amount_cents or v_reserved <> new\.reserve_amount_cents/);
  assert.match(assertion, /v_pending <> new\.gross_amount_cents/);

  const reserveStart = holdbackSql.indexOf('create or replace function public.nexora_settlement_release_reserve(');
  const reserveEnd = holdbackSql.indexOf('\n$$;', reserveStart);
  assert.ok(reserveStart >= 0 && reserveEnd > reserveStart);
  const reserveRelease = holdbackSql.slice(reserveStart, reserveEnd);
  assert.match(reserveRelease, /v_settlement\.reserve_release_at>now\(\)/);
  assert.match(reserveRelease, /'merchant_reserved','side','debit'/);
  assert.match(reserveRelease, /'merchant_available','side','credit'/);
});

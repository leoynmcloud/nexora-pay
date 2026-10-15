import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessPayoutReadiness, decimalToCents } from './payout-readiness.ts';
import { mapPayoutReserveError } from './payout-reserve-errors.ts';

const ready = {
  workspaceExists: true,
  onboardingApproved: true,
  accountActive: true,
  productionEnabled: true,
  withdrawalsEnabled: true,
  pixOutEnabled: true,
  movementsBlocked: false,
  transferLimitCents: 50000,
  dailyLimitCents: 100000,
  dailyUsedCents: 0,
  productionRouteAvailable: true,
  availableCents: 10000,
};

const platformSource = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');
const readinessHandler = readFileSync(new URL('../nexora-payout-readiness/index.ts', import.meta.url), 'utf8');
const requestHandler = readFileSync(new URL('../nexora-payout-request/index.ts', import.meta.url), 'utf8');
const payoutCoreSql = readFileSync(new URL('../../../nexora-payout-core.sql', import.meta.url), 'utf8');

function loadFrontendNormalizer(): (value: unknown) => unknown {
  const match = /\/\/ PAYOUT_READINESS_NORMALIZER_START[^\n]*\n([\s\S]*?)\/\/ PAYOUT_READINESS_NORMALIZER_END/.exec(platformSource);
  assert.ok(match, 'normalizer markers must exist in platform-app.js');
  return new Function(`${match[1]}\nreturn normalizePayoutReadiness;`)();
}

function reserveFunctionBody(): string {
  const start = payoutCoreSql.indexOf('create or replace function public.nexora_payout_reserve(');
  assert.ok(start >= 0);
  const end = payoutCoreSql.indexOf('\n$$;', start);
  assert.ok(end > start);
  return payoutCoreSql.slice(start, end);
}

test('payout readiness opens only when every server-side gate is confirmed', () => {
  assert.deepEqual(assessPayoutReadiness(ready), {
    canRequest: true, availableCents: 10000, maxRequestCents: 10000, reasons: [],
  });
  for (const [key, value, expected] of [
    ['workspaceExists', false, 'workspace_unavailable'],
    ['onboardingApproved', false, 'onboarding_not_approved'],
    ['accountActive', false, 'account_inactive'],
    ['productionEnabled', false, 'payouts_not_enabled_by_nexora'],
    ['withdrawalsEnabled', false, 'withdrawals_disabled'],
    ['pixOutEnabled', false, 'pix_out_disabled'],
    ['movementsBlocked', true, 'outgoing_movements_blocked'],
    ['transferLimitCents', 0, 'payout_limits_unavailable'],
    ['transferLimitCents', null, 'payout_limits_unavailable'],
    ['dailyLimitCents', null, 'payout_limits_unavailable'],
    ['dailyUsedCents', null, 'daily_usage_unavailable'],
    ['dailyUsedCents', -1, 'daily_usage_unavailable'],
    ['dailyUsedCents', 100000, 'daily_limit_reached'],
    ['productionRouteAvailable', false, 'production_payout_route_unavailable'],
    ['availableCents', 0, 'no_available_balance'],
    ['availableCents', -500, 'no_available_balance'],
    ['availableCents', null, 'balance_unavailable'],
    ['availableCents', 10.5, 'balance_unavailable'],
  ] as const) {
    const result = assessPayoutReadiness({ ...ready, [key]: value });
    assert.equal(result.canRequest, false, `${key}=${value}`);
    assert.equal(result.maxRequestCents, null, `${key}=${value}`);
    assert.ok(result.reasons.includes(expected), `${key}=${value}`);
  }
});

test('request ceiling is the minimum of balance, per-transfer limit and remaining daily limit', () => {
  assert.equal(assessPayoutReadiness({ ...ready, availableCents: 900000 }).maxRequestCents, 50000);
  assert.equal(assessPayoutReadiness({ ...ready, availableCents: 900000, dailyUsedCents: 80000 }).maxRequestCents, 20000);
  assert.equal(assessPayoutReadiness({ ...ready, availableCents: 1234 }).maxRequestCents, 1234);
});

test('decimal balances and limits convert to exact cents without float drift', () => {
  for (const [input, expected] of [
    [10.07, 1007], [0.29, 29], [1.005 * 100 / 100, null], [0.1 + 0.2, 30], [5000, 500000], [-5.5, -550], [0, 0],
    ['10.0700000000000000', 1007], ['5000.00', 500000], ['0', 0], ['-0.01', -1], ['12', 1200],
    ['10.075', null], [10.075, null], ['1e3', null], ['', null], ['abc', null],
    [Number.NaN, null], [Number.POSITIVE_INFINITY, null], [undefined, null], [null, null], [{}, null],
  ] as const) {
    assert.equal(decimalToCents(input), expected, `decimalToCents(${String(input)})`);
  }
  // Regression: the previous Number(x) * 100 check rejected these legitimate balances as "unavailable".
  for (const reais of [0.29, 1.15, 0.57, 4.35]) {
    assert.equal(Number.isSafeInteger(reais * 100), false, `${reais} * 100 drifts`);
    assert.equal(decimalToCents(reais), Math.round(reais * 100));
  }
});

test('frontend normalizer never enables payouts from malformed or contradictory readiness', () => {
  const normalize = loadFrontendNormalizer();
  const valid = { canRequest: true, availableCents: 10000, maxRequestCents: 5000, reasons: [] };
  assert.deepEqual(normalize(valid), valid);
  for (const bad of [
    null, undefined, 'ok', [], {}, { canRequest: 'true', reasons: [] },
    { canRequest: true },
    { ...valid, reasons: ['payouts_not_enabled_by_nexora'] },
    { ...valid, availableCents: null }, { ...valid, availableCents: 0 }, { ...valid, availableCents: 100.5 },
    { ...valid, maxRequestCents: null }, { ...valid, maxRequestCents: 0 }, { ...valid, maxRequestCents: 20000 },
    { ...valid, reasons: [42] }, { error: 'payout_readiness_unavailable' },
  ]) {
    const result = normalize(bad) as { canRequest?: boolean } | null;
    assert.notEqual(result?.canRequest, true, JSON.stringify(bad));
  }
  assert.deepEqual(normalize({ canRequest: false, availableCents: 100, maxRequestCents: 100, reasons: ['pix_out_disabled'] }), {
    canRequest: false, availableCents: 100, maxRequestCents: null, reasons: ['pix_out_disabled'],
  });
});

test('readiness endpoint authenticates, reads owner-scoped balance and mirrors the reserve daily window', () => {
  assert.match(readinessHandler, /auth\.getUser\(token\)/);
  assert.match(readinessHandler, /userClient\.rpc\('nexora_ledger_merchant_balances', \{ p_business_id: businessId \}\)/);
  assert.match(readinessHandler, /availableCents: decimalToCents\(balanceResult\.data\?\.available\)/);
  assert.doesNotMatch(readinessHandler, /\*\s*100/, 'no float multiplication for money');
  assert.match(readinessHandler, /nexora_payout_reserve is the final atomic gate/i);
  assert.doesNotMatch(readinessHandler, /destination_ciphertext|api_key_ciphertext|select\('\*'\)/i);
  // The excluded statuses and the business day must match the RPC exactly.
  const sqlStatuses = /p\.status not in \(([^)]*)\)/.exec(reserveFunctionBody())?.[1].replace(/'/g, '"').replace(/\s/g, '');
  assert.ok(sqlStatuses);
  assert.ok(readinessHandler.includes(`'(${sqlStatuses})'`), `endpoint must exclude ${sqlStatuses}`);
  assert.match(reserveFunctionBody(), /America\/Sao_Paulo/);
  assert.match(readinessHandler, /zonedDayWindowUtc\(today, 'America\/Sao_Paulo'\)/);
  // A truncated usage read must not be summed as if complete.
  assert.match(readinessHandler, /length <= DAILY_USAGE_ROW_CAP/);
  // Any failure while reading gates is a 503 with no canRequest field.
  assert.match(readinessHandler, /catch \(error\)[\s\S]*payout_readiness_unavailable' \}, 503\)/);
});

test('every exception raised by nexora_payout_reserve maps to a specific, definitive API code', () => {
  const messages = [...reserveFunctionBody().matchAll(/raise exception '([^']+)'/g)].map(match => match[1]);
  assert.ok(messages.length >= 9, 'expected the reserve RPC exception list');
  for (const message of messages) {
    const mapped = mapPayoutReserveError(message);
    if (message === 'Backend service role required.') {
      assert.equal(mapped.definitive, false);
      continue;
    }
    assert.equal(mapped.definitive, true, message);
    assert.notEqual(mapped.error, 'payout_reservation_failed', message);
  }
  assert.equal(mapPayoutReserveError('Merchant withdrawals or Pix OUT are disabled, or outgoing movements are blocked.').error, 'payout_not_allowed');
  assert.equal(mapPayoutReserveError('No approved production payout route is configured.').error, 'payout_route_unavailable');
  assert.equal(mapPayoutReserveError('Payout exceeds the daily limit.').error, 'payout_limit_exceeded');
  assert.deepEqual(mapPayoutReserveError('fetch failed'), { error: 'payout_reservation_failed', status: 503, definitive: false });
  assert.deepEqual(mapPayoutReserveError(undefined), { error: 'payout_reservation_failed', status: 503, definitive: false });
  assert.match(requestHandler, /mapPayoutReserveError\(error\.message\)/);
});

test('merchant payout UI does not treat readiness as authorization and retries idempotently', () => {
  assert.match(platformSource, /nexora-payout-readiness/);
  assert.match(platformSource, /payoutReadiness = normalizePayoutReadiness\(readinessData\)/);
  assert.match(platformSource, /readiness\?\.canRequest !== true/);
  assert.match(platformSource, /currentLevel !== 'aal2'/);
  assert.match(platformSource, /cents > maxRequest/);
  // request_id is stable per intent within the dialog, never regenerated per submit.
  assert.match(platformSource, /request_id: requestIds\.get\(intentKey\)/);
  assert.doesNotMatch(platformSource, /request_id: crypto\.randomUUID\(\)/);
  // supabase-js v2 puts non-2xx bodies in error.context, not data.
  const requestBlock = platformSource.slice(platformSource.indexOf('async function requestPayout'), platformSource.indexOf('async function loadMorePayouts'));
  assert.match(requestBlock, /error\.context\?\.clone\?\.\(\)\.json\(\)/);
  assert.doesNotMatch(requestBlock, /data\?\.error/);
  assert.doesNotMatch(requestBlock, /Nenhum novo envio ao provedor foi feito/);
});

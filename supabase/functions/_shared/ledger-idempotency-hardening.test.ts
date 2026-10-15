import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const baseSql = readFileSync(new URL('../../../nexora-production-ledger.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../../nexora-ledger-idempotency-hardening.sql', import.meta.url), 'utf8');

function hardeningBlock(source: string) {
  const start = source.indexOf('create or replace function public.nexora_ledger_request_matches');
  const endMarker = 'grant execute on function public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb) to service_role;';
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'ledger idempotency hardening block is present');
  return source.slice(start, end + endMarker.length).replace(/\s+/g, ' ').replace(/,\s*/g, ',').trim();
}

test('ledger idempotency compares the actual journal intent on retries and concurrent key conflicts', () => {
  const sql = hardeningBlock(baseSql);
  assert.match(sql, /jsonb_agg\(jsonb_build_object\(\s*'account_code',a\.account_code,'side',e\.side,'amount_cents',e\.amount_cents\s*\)/);
  assert.match(sql, /j\.description=trim\(p_description\)/);
  assert.match(sql, /x\.side is null or x\.side not in \('debit','credit'\)/);
  assert.equal((sql.match(/nexora_ledger_request_matches\(v_journal\.id,p_description,p_entries\)/g) || []).length, 2);
  assert.match(sql, /Backend service role required/);
  assert.match(sql, /revoke all on function public\.nexora_ledger_post_journal\([^)]+\) from public,anon,authenticated/);
  assert.match(sql, /grant execute on function public\.nexora_ledger_post_journal\([^)]+\) to service_role/);
});

test('base ledger migration and additive hardening migration deploy the same writer definition', () => {
  assert.match(migration, /Apply nexora-production-ledger\.sql before this hardening migration/);
  assert.equal(hardeningBlock(baseSql), hardeningBlock(migration));
});

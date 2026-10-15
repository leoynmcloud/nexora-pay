import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../../nexora-payout-core.sql', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');
const edge = readFileSync(new URL('../nexora-payout-merchant/index.ts', import.meta.url), 'utf8');

test('merchant payout history is workspace-scoped and paginated by stable keyset', () => {
  assert.match(sql, /p_owner_id uuid,p_business_id uuid,p_limit integer default 50,\s*p_before_created_at timestamptz default null,p_before_payout_id uuid default null/i);
  assert.match(sql, /p\.owner_id=p_owner_id and p\.business_id=p_business_id/);
  assert.match(sql, /\(p\.created_at,p\.id\)<\(p_before_created_at,p_before_payout_id\)/);
  assert.match(sql, /order by p\.created_at desc,p\.id desc limit p_limit\+1/i);
  assert.match(sql, /n\.page_count>p_limit/);
  assert.match(sql, /revoke all on function public\.nexora_payout_merchant_list\(uuid,uuid,integer,timestamptz,uuid\) from public,anon,authenticated/i);
  assert.match(sql, /grant execute on function public\.nexora_payout_merchant_list\(uuid,uuid,integer,timestamptz,uuid\) to service_role/i);
});

test('merchant payout endpoint returns only a continuation cursor, not provider destination data', () => {
  assert.match(edge, /p_before_created_at: page\.beforeCreatedAt, p_before_payout_id: page\.beforePayoutId/);
  assert.match(edge, /next_cursor: last\?\.has_more === true \? \{ before_created_at: last\.created_at, before_payout_id: last\.payout_id \} : null/);
  assert.match(edge, /amount_cents: item\.amount_cents,[\s\S]*status: item\.status,[\s\S]*created_at: item\.created_at/);
  assert.doesNotMatch(edge, /destination_ciphertext|destination_sha256|pix_key/);
});

test('merchant dashboard shows payout readiness and gates requests on server approval', () => {
  assert.match(app, /saques: 'Saques'/);
  assert.match(app, /function renderPayoutHistory\(\)/);
  assert.match(app, /function loadMorePayouts\(\)/);
  assert.match(app, /payout-more/);
  assert.match(app, /Ver histórico completo/);
  assert.match(app, /nexora-payout-readiness/);
  assert.match(app, /nexora-payout-request/);
  assert.match(app, /state\.payout_readiness\?\.canRequest === true/);
  assert.match(app, /payoutReadinessBanner\(state\.payout_readiness\)/);
  assert.match(app, /Solicitações reais permanecem bloqueadas durante a homologação da operação/);
  assert.doesNotMatch(app, /Disponíveis após a implementação de saldo, liquidação e conciliação/);
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  generateMerchantApiKey,
  hashMerchantApiKey,
  merchantApiKeyPrefix,
  validateMerchantApiScopes,
} from './merchant-api-keys.ts';

const apiKeySql = readFileSync(new URL('../../../nexora-merchant-api-keys.sql', import.meta.url), 'utf8');

describe('merchant API key lifecycle primitives', () => {
  it('creates distinct 256-bit environment-prefixed bearer keys and short display prefixes', () => {
    const live = generateMerchantApiKey('production');
    const test = generateMerchantApiKey('sandbox');
    assert.match(live, /^nx_live_[A-Za-z0-9_-]{43}$/);
    assert.match(test, /^nx_test_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(generateMerchantApiKey('production'), live);
    assert.equal(merchantApiKeyPrefix(live), live.slice(0, 16));
    assert.throws(() => generateMerchantApiKey('invalid' as 'sandbox'), /api_key_environment_invalid/);
  });

  it('stores only a one-way digest and rejects malformed keys', async () => {
    const key = generateMerchantApiKey('production');
    const digest = await hashMerchantApiKey(key);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.notEqual(digest, key);
    assert.equal(await hashMerchantApiKey(key), digest);
    await assert.rejects(hashMerchantApiKey('nx_live_short'), /api_key_invalid/);
  });

  it('allows only known scopes and canonicalizes duplicates', () => {
    assert.deepEqual(validateMerchantApiScopes(['payments:write', 'payments:read', 'payments:write']), ['payments:read', 'payments:write']);
    assert.throws(() => validateMerchantApiScopes([]), /api_key_scopes_invalid/);
    assert.throws(() => validateMerchantApiScopes(['admin:*']), /api_key_scopes_invalid/);
    assert.throws(() => validateMerchantApiScopes(['webhooks:write']), /api_key_scopes_invalid/);
  });

  it('serializes key creation per workspace before enforcing the active-key cap', () => {
    const createFunction = apiKeySql.split('create or replace function public.nexora_merchant_api_key_create(')[1]?.split('create or replace function public.nexora_merchant_api_key_list(')[0] || '';
    const workspaceLock = createFunction.indexOf('where b.id=p_business_id and b.owner_id=v_owner for update');
    const activeKeyCount = createFunction.indexOf("and k.business_id=p_business_id and k.status='active')>=20");
    const keyInsert = createFunction.indexOf('insert into public.nexora_merchant_api_keys(');
    assert.ok(workspaceLock >= 0, 'workspace row lock exists');
    assert.ok(activeKeyCount > workspaceLock, 'the active-key count follows the lock');
    assert.ok(keyInsert > activeKeyCount, 'the insert follows the serialized limit check');
  });
});

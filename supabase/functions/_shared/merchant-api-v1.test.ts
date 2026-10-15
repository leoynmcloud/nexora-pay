import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateMerchantApiKey } from './merchant-api-keys.ts';
import {
  apiError, apiRequestHash, decodePaymentLinkCursor, deriveApiCheckoutToken,
  encodePaymentLinkCursor, extractMerchantApiKey, validatePaymentLinkInput,
} from './merchant-api-v1.ts';

const apiSql = readFileSync(new URL('../../../nexora-api-v1.sql', import.meta.url), 'utf8');

describe('merchant public API v1 primitives', () => {
  it('accepts only a well-formed bearer API key', () => {
    const key = generateMerchantApiKey('production');
    assert.equal(extractMerchantApiKey(`Bearer ${key}`), key);
    assert.equal(extractMerchantApiKey(`bearer ${key}`), key);
    assert.equal(extractMerchantApiKey(`Bearer ${key}x`), null);
    assert.equal(extractMerchantApiKey(null), null);
  });

  it('validates amount in integer cents, BRL, bounded description, and idempotency', () => {
    const valid = validatePaymentLinkInput({ amount_cents: 1000, description: 'Pedido 42' }, 'checkout.req:00000000001');
    assert.deepEqual(valid, { amountCents: 1000, description: 'Pedido 42', currency: 'BRL', idempotencyKey: 'checkout.req:00000000001' });
    assert.throws(() => validatePaymentLinkInput({ amount_cents: 10.5, description: 'OK' }, 'abcdefghijklmnop'), /amount_invalid/);
    assert.throws(() => validatePaymentLinkInput({ amount_cents: 100, description: 'OK', currency: 'USD' }, 'abcdefghijklmnop'), /currency_unsupported/);
    assert.throws(() => validatePaymentLinkInput({ amount_cents: 100, description: 'x' }, 'abcdefghijklmnop'), /description_invalid/);
    assert.throws(() => validatePaymentLinkInput({ amount_cents: 100, description: 'OK' }, null), /idempotency_key_required/);
  });

  it('canonicalizes request hashes and derives stable, distinct checkout tokens', async () => {
    const request = { amountCents: 1234, description: 'Pedido', currency: 'BRL' as const };
    const firstHash = await apiRequestHash(request);
    assert.equal(firstHash, await apiRequestHash({ ...request }));
    assert.notEqual(firstHash, await apiRequestHash({ ...request, amountCents: 1235 }));
    const key = generateMerchantApiKey('production');
    const a = await deriveApiCheckoutToken(key, 'key-id', 'request-00000000001');
    assert.equal(a, await deriveApiCheckoutToken(key, 'key-id', 'request-00000000001'));
    assert.notEqual(a, await deriveApiCheckoutToken(key, 'key-id', 'request-00000000002'));
    assert.notEqual(a, await deriveApiCheckoutToken(key, 'another-key-id', 'request-00000000001'));
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  });

  it('round-trips opaque stable cursors and rejects malformed cursor data', () => {
    const cursor = { created_at: '2026-10-10T10:20:30.000Z', id: 'a0000000-0000-4000-8000-000000000001' };
    assert.deepEqual(decodePaymentLinkCursor(encodePaymentLinkCursor(cursor)), cursor);
    assert.equal(decodePaymentLinkCursor(null), null);
    assert.throws(() => decodePaymentLinkCursor('!invalid!'), /cursor_invalid/);
  });

  it('standardizes machine-readable errors and request IDs', () => {
    assert.deepEqual(apiError('INSUFFICIENT_BALANCE', 'Saldo insuficiente', 'req-123'), {
      error: { code: 'INSUFFICIENT_BALANCE', message: 'Saldo insuficiente', request_id: 'req-123' },
    });
  });

  it('revalidates merchant activity and approved KYC inside both API read RPCs', () => {
    const readFunctions = apiSql.split('create or replace function public.nexora_api_v1_')
      .filter(section => section.startsWith('list_payment_links(') || section.startsWith('get_payment_link('));
    assert.equal(readFunctions.length, 2);
    for (const fn of readFunctions) {
      assert.match(fn, /public\.nexora_account_active\(k\.owner_id\)/);
      assert.match(fn, /public\.merchant_onboarding[\s\S]*?m\.status='APPROVED'/);
      assert.match(fn, /c\.api_enabled/);
    }
  });
});

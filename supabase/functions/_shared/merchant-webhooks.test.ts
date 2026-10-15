import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMerchantWebhookSecret,
  assertPublicMerchantWebhookDestination,
  isSuccessfulWebhookResponse,
  signMerchantWebhook,
  validateMerchantWebhookEvents,
  validateMerchantWebhookUrl,
  verifyMerchantWebhookSignature,
} from './merchant-webhooks.ts';

describe('merchant outbound webhook security primitives', () => {
  it('generates high-entropy secrets and validates public HTTPS endpoints', () => {
    const first = generateMerchantWebhookSecret();
    assert.match(first, /^nxwhsec_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(generateMerchantWebhookSecret(), first);
    assert.equal(validateMerchantWebhookUrl('https://merchant.example.com/hooks/payment'), 'https://merchant.example.com/hooks/payment');
    for (const url of ['http://merchant.example.com/hook', 'https://localhost/hook', 'https://127.0.0.1/hook', 'https://merchant.local/hook', 'https://user:pass@merchant.example.com/hook', 'https://merchant.example.com/hook?token=secret']) {
      assert.throws(() => validateMerchantWebhookUrl(url), /webhook_url_invalid/);
    }
  });

  it('signs the exact serialized body with a replay-bounded timestamp', async () => {
    const secret = generateMerchantWebhookSecret();
    const body = JSON.stringify({ event_id: 'evt_1', event: 'payment.succeeded', data: { amount: 10000 } });
    const timestamp = 1_800_000_000;
    const signature = await signMerchantWebhook(secret, timestamp, body);
    assert.match(signature, /^[a-f0-9]{64}$/);
    assert.equal(await verifyMerchantWebhookSignature(secret, timestamp, body, signature, timestamp), true);
    assert.equal(await verifyMerchantWebhookSignature(secret, timestamp, `${body} `, signature, timestamp), false);
    assert.equal(await verifyMerchantWebhookSignature(secret, timestamp - 301, body, signature, timestamp), false);
  });

  it('accepts delivery only on 2xx', () => {
    assert.equal(isSuccessfulWebhookResponse(204), true);
    assert.equal(isSuccessfulWebhookResponse(299), true);
    assert.equal(isSuccessfulWebhookResponse(300), false);
    assert.equal(isSuccessfulWebhookResponse(503), false);
  });

  it('allows only events that have an active producer', () => {
    assert.deepEqual(validateMerchantWebhookEvents(['payment.succeeded', 'payment.failed', 'payment.canceled']),
      ['payment.succeeded', 'payment.failed', 'payment.canceled']);
    assert.deepEqual(validateMerchantWebhookEvents(['payment.succeeded', 'payment.failed', 'payment.failed']),
      ['payment.succeeded', 'payment.failed']);
    assert.throws(() => validateMerchantWebhookEvents(['payment.refunded']), /webhook_events_invalid/);
    assert.throws(() => validateMerchantWebhookEvents([]), /webhook_events_invalid/);
  });

  it('resolves webhook hosts and rejects private or mixed DNS answers', async () => {
    const publicDns = async (_host: string, type: 'A' | 'AAAA') => type === 'A' ? ['203.0.113.8'] : [];
    // Documentation ranges are intentionally not treated as public destinations.
    await assert.rejects(assertPublicMerchantWebhookDestination('https://merchant.example.com/hook', publicDns), /webhook_dns_rejected/);
    const validDns = async (_host: string, type: 'A' | 'AAAA') => type === 'A' ? ['8.8.8.8'] : ['2606:4700:4700::1111'];
    assert.equal(await assertPublicMerchantWebhookDestination('https://merchant.example.com/hook', validDns), 'https://merchant.example.com/hook');
    const mixedDns = async (_host: string, type: 'A' | 'AAAA') => type === 'A' ? ['8.8.8.8'] : ['fd00::1'];
    await assert.rejects(assertPublicMerchantWebhookDestination('https://merchant.example.com/hook', mixedDns), /webhook_dns_rejected/);
    const noDns = async () => [];
    await assert.rejects(assertPublicMerchantWebhookDestination('https://merchant.example.com/hook', noDns), /webhook_dns_unavailable/);
  });

  it('rejects special-use IPv4 and IPv6 answers, including DNS rebinding mixtures', async () => {
    for (const privateAddress of ['10.1.2.3', '100.64.0.1', '169.254.1.1', '172.20.1.1', '192.168.1.1', '198.18.0.1', '224.0.0.1']) {
      const resolve = async (_host: string, type: 'A' | 'AAAA') => type === 'A' ? [privateAddress] : [];
      await assert.rejects(assertPublicMerchantWebhookDestination('https://merchant.example.com/hook', resolve), /webhook_dns_rejected/);
    }
    for (const privateAddress of [
      '::1', 'fe80::1', 'fc00::1', '2001:db8::1', '::ffff:127.0.0.1',
      '2002:0a00:0001::', '2002:c0a8:0101::',
      '2606:4700:4700::1111%lo',
    ]) {
      const resolve = async (_host: string, type: 'A' | 'AAAA') => type === 'A' ? [] : [privateAddress];
      await assert.rejects(assertPublicMerchantWebhookDestination('https://merchant.example.com/hook', resolve), /webhook_dns_rejected/);
    }
  });
});

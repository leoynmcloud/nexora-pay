import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readBoundedHttpBody } from './bounded-http-body.ts';

const payoutRequestHandler = readFileSync(new URL('../nexora-payout-request/index.ts', import.meta.url), 'utf8');
const boundedRequestHandlers = [
  '../nexora-checkout/index.ts',
  '../nexora-merchant-webhooks/index.ts',
  '../nexora-merchant-api-keys/index.ts',
  '../nexora-provider-config/index.ts',
  '../nexora-api-v1/index.ts',
  '../nexora-email-events/index.ts',
  '../nexora-admin-delete-user/index.ts',
  '../nexora-payout-readiness/index.ts',
  '../nexora-payout-admin/index.ts',
  '../nexora-payout-merchant/index.ts',
  '../nexora-fund-controls/index.ts',
  '../nexora-reconcile-asaas/index.ts',
  '../nexora-reconciliation-admin/index.ts',
  '../nexora-settlement-release/index.ts',
  '../nexora-reserve-release/index.ts',
  '../nexora-payments/index.ts',
  './asaas-payments.ts',
  './mercadopago-payments.ts',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));

test('bounded HTTP body accepts exactly the configured UTF-8 byte limit', async () => {
  const body = 'ação';
  const bytes = new TextEncoder().encode(body).byteLength;
  assert.equal(await readBoundedHttpBody(new Request('https://nexora.test', { method: 'POST', body }), bytes), body);
});

test('bounded HTTP body rejects an oversized declared length before reading', async () => {
  let consumed = false;
  const request = {
    headers: new Headers({ 'content-length': '100' }),
    get body() { consumed = true; return null; },
  } as unknown as Request;
  assert.equal(await readBoundedHttpBody(request, 10), null);
  assert.equal(consumed, false);
});

test('bounded HTTP body cancels an untrusted stream immediately after its byte limit', async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
    },
    cancel() { canceled = true; },
  });
  const request = new Request('https://nexora.test', { method: 'POST', body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
  assert.equal(await readBoundedHttpBody(request, 10), null);
  assert.equal(canceled, true);
});

test('bounded HTTP body rejects invalid UTF-8 rather than replacing bytes', async () => {
  const request = new Request('https://nexora.test', { method: 'POST', body: new Uint8Array([0xc3, 0x28]) });
  assert.equal(await readBoundedHttpBody(request, 8), null);
});

test('merchant payout request uses the streaming bounded reader for its 8 KB limit', () => {
  assert.match(payoutRequestHandler, /readBoundedHttpBody\(request, 8192\)/);
  assert.doesNotMatch(payoutRequestHandler, /await request\.text\(\)/);
});

test('external JSON handlers use streaming body limits instead of unbounded request reads', () => {
  for (const handler of boundedRequestHandlers) {
    assert.match(handler, /readBoundedHttpBody\(request(?:\.clone\(\))?,/);
    assert.doesNotMatch(handler, /await request\.(?:clone\(\)\.)?(?:text|json)\(\)/);
  }
});

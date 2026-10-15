import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPinnedWebhookRequest,
  parsePinnedWebhookStatus,
  sendPinnedMerchantWebhook,
  type PinnedWebhookConnection,
} from './pinned-webhook.ts';

const encoder = new TextEncoder();

describe('pinned merchant webhook transport', () => {
  it('builds a bounded HTTP/1.1 request with the exact UTF-8 content length', () => {
    const body = JSON.stringify({ event: 'payment.succeeded', label: 'café' });
    const request = new TextDecoder().decode(buildPinnedWebhookRequest(
      'https://merchant.example.com/hooks/payments', body, { 'X-Nexora-Signature': 'v1=abc123' },
    ));
    assert.match(request, /^POST \/hooks\/payments HTTP\/1\.1\r\n/);
    assert.match(request, /Host: merchant\.example\.com\r\n/);
    assert.match(request, new RegExp(`Content-Length: ${encoder.encode(body).byteLength}\\r\\n`));
    assert.ok(request.endsWith(body));
    assert.throws(() => buildPinnedWebhookRequest('https://merchant.example.com/hook', body, { 'X-Test': 'ok\r\nHost: evil.test' }), /webhook_header_invalid/);
    assert.throws(() => buildPinnedWebhookRequest('https://merchant.example.com/hook', body, { 'Content-Length': '0' }), /webhook_header_invalid/);
    assert.throws(() => buildPinnedWebhookRequest('https://merchant.example.com/hook', body, { 'X-Test': 'one', 'x-test': 'two' }), /webhook_header_invalid/);
  });

  it('connects to a verified literal IP while validating TLS for the original hostname', async () => {
    const requests: Uint8Array[] = [];
    const hosts: string[] = [];
    const addresses: string[] = [];
    let cursor = 0;
    const response = encoder.encode('HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n');
    const fake: PinnedWebhookConnection = {
      async write(data) {
        const part = data.slice(0, 11);
        requests.push(part);
        return part.length;
      },
      async read(buffer) {
        if (cursor >= response.length) return null;
        const count = Math.min(7, buffer.length, response.length - cursor);
        buffer.set(response.subarray(cursor, cursor + count));
        cursor += count;
        return count;
      },
      close() {},
    };
    const status = await sendPinnedMerchantWebhook(
      { url: 'https://merchant.example.com/hooks?a=1', addresses: ['8.8.8.8', '2606:4700:4700::1111'] },
      '{"event":"payment.succeeded"}', { 'X-Nexora-Event-Id': 'evt-1' },
      {
        async connect(address, port) { addresses.push(address); assert.equal(port, 443); return fake; },
        async startTls(connection, hostname) { hosts.push(hostname); return connection; },
      },
    );
    assert.equal(status, 202);
    assert.deepEqual(addresses, ['8.8.8.8']);
    assert.deepEqual(hosts, ['merchant.example.com']);
    assert.match(new TextDecoder().decode(Uint8Array.from(requests.flatMap(bytes => [...bytes]))), /Host: merchant\.example\.com\r\n/);
  });

  it('falls back to another already-validated public address when the first connection fails', async () => {
    const tried: string[] = [];
    const response = encoder.encode('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n');
    let cursor = 0;
    const connection: PinnedWebhookConnection = {
      async write(data) { return data.length; },
      async read(buffer) {
        if (cursor >= response.length) return null;
        const count = Math.min(buffer.length, response.length - cursor);
        buffer.set(response.subarray(cursor, cursor + count));
        cursor += count;
        return count;
      },
      close() {},
    };
    const status = await sendPinnedMerchantWebhook(
      { url: 'https://merchant.example.com/hook', addresses: ['8.8.8.8', '1.1.1.1'] },
      '{"event_id":"evt-1"}', {},
      {
        async connect(address) {
          tried.push(address);
          if (address === '8.8.8.8') throw new Error('connection_refused');
          return connection;
        },
        async startTls(value) { return value; },
      },
    );
    assert.equal(status, 204);
    assert.deepEqual(tried, ['8.8.8.8', '1.1.1.1']);
  });

  it('moves to the next public address when one connection stalls', async () => {
    const tried: string[] = [];
    const response = encoder.encode('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    let cursor = 0;
    const connection: PinnedWebhookConnection = {
      async write(data) { return data.length; },
      async read(buffer) {
        if (cursor >= response.length) return null;
        const count = Math.min(buffer.length, response.length - cursor);
        buffer.set(response.subarray(cursor, cursor + count));
        cursor += count;
        return count;
      },
      close() {},
    };
    const status = await sendPinnedMerchantWebhook(
      { url: 'https://merchant.example.com/hook', addresses: ['8.8.8.8', '1.1.1.1'] },
      '{"event_id":"evt-2"}', {},
      {
        async connect(address, _port, signal) {
          tried.push(address);
          if (address === '8.8.8.8') return await new Promise<PinnedWebhookConnection>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return connection;
        },
        async startTls(value) { return value; },
      },
      undefined,
      10,
    );
    assert.equal(status, 200);
    assert.deepEqual(tried, ['8.8.8.8', '1.1.1.1']);
  });

  it('rejects non-public pins and malformed responses before claiming success', async () => {
    const network = {
      async connect() { throw new Error('must_not_connect'); },
      async startTls(connection: PinnedWebhookConnection) { return connection; },
    };
    await assert.rejects(sendPinnedMerchantWebhook(
      { url: 'https://merchant.example.com/hook', addresses: ['127.0.0.1'] }, '{}', {}, network,
    ), /webhook_dns_rejected/);
    assert.equal(parsePinnedWebhookStatus(encoder.encode('HTTP/1.1 204 No Content\r\n\r\n')), 204);
    assert.throws(() => parsePinnedWebhookStatus(encoder.encode('not an HTTP response')), /webhook_response_invalid/);
  });
});

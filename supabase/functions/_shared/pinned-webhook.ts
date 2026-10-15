import { isPublicWebhookIp } from './merchant-webhooks.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const maxHeaderBytes = 16_384;

export interface PinnedWebhookConnection {
  write(data: Uint8Array): Promise<number>;
  read(data: Uint8Array): Promise<number | null>;
  close(): void;
}

export interface PinnedWebhookNetwork {
  connect(address: string, port: number, signal?: AbortSignal): Promise<PinnedWebhookConnection>;
  startTls(connection: PinnedWebhookConnection, hostname: string): Promise<PinnedWebhookConnection>;
}

export function buildPinnedWebhookRequest(urlValue: string, body: string, headers: Record<string, string>) {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password) {
    throw new Error('webhook_url_invalid');
  }
  const headerLines = Object.entries(headers);
  const headerNames = headerLines.map(([name]) => name.toLowerCase());
  const reservedHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
  if (headerLines.some(([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
    || reservedHeaders.has(name.toLowerCase()) || /[\r\n]/.test(value) || value.length > 4096)
    || new Set(headerNames).size !== headerNames.length
    || headerLines.reduce((sum, [name, value]) => sum + name.length + value.length + 4, 0) > 8192) {
    throw new Error('webhook_header_invalid');
  }
  const path = `${url.pathname || '/'}${url.search}`;
  const text = [
    `POST ${path} HTTP/1.1`,
    `Host: ${url.hostname}`,
    'Connection: close',
    'Content-Length: ' + encoder.encode(body).byteLength,
    ...headerLines.map(([name, value]) => `${name}: ${value}`),
    '', '',
  ].join('\r\n');
  const prefix = encoder.encode(text);
  const payload = encoder.encode(body);
  const request = new Uint8Array(prefix.length + payload.length);
  request.set(prefix);
  request.set(payload, prefix.length);
  return request;
}

export function parsePinnedWebhookStatus(headerBytes: Uint8Array) {
  const header = decoder.decode(headerBytes);
  const statusLine = header.split('\r\n', 1)[0];
  const match = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?:\s|$)/.exec(statusLine);
  if (!match) throw new Error('webhook_response_invalid');
  return Number(match[1]);
}

async function writeAll(connection: PinnedWebhookConnection, data: Uint8Array) {
  let offset = 0;
  while (offset < data.length) {
    const written = await connection.write(data.subarray(offset));
    if (!Number.isInteger(written) || written <= 0) throw new Error('webhook_write_failed');
    offset += written;
  }
}

export async function sendPinnedMerchantWebhook(
  destination: { url: string; addresses: string[] },
  body: string,
  headers: Record<string, string>,
  network: PinnedWebhookNetwork,
  signal?: AbortSignal,
  perAddressTimeoutMs = 3_500,
) {
  const url = new URL(destination.url);
  if (!destination.addresses.length) throw new Error('webhook_dns_unavailable');
  if (destination.addresses.some(address => !isPublicWebhookIp(address))) throw new Error('webhook_dns_rejected');
  const addresses = [...new Set(destination.addresses)];
  const request = buildPinnedWebhookRequest(destination.url, body, headers);
  let lastError: unknown = new Error('webhook_network_unavailable');
  for (const address of addresses) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let connection: PinnedWebhookConnection | null = null;
    let closed = false;
    const attemptController = new AbortController();
    const abortFromParent = () => attemptController.abort(signal?.reason);
    const attemptTimeout = setTimeout(() => {
      attemptController.abort(new DOMException('Webhook address timed out.', 'TimeoutError'));
    }, perAddressTimeoutMs);
    const abort = () => {
      closed = true;
      try { connection?.close(); } catch { /* already closed */ }
    };
    signal?.addEventListener('abort', abortFromParent, { once: true });
    attemptController.signal.addEventListener('abort', abort, { once: true });
    try {
      connection = await network.connect(address.includes(':') ? `[${address}]` : address, 443, attemptController.signal);
      if (closed || attemptController.signal.aborted) {
        throw attemptController.signal.reason || new DOMException('Aborted', 'AbortError');
      }
      connection = await network.startTls(connection, url.hostname);
      if (closed || attemptController.signal.aborted) {
        throw attemptController.signal.reason || new DOMException('Aborted', 'AbortError');
      }
      await writeAll(connection, request);
      const received: number[] = [];
      const buffer = new Uint8Array(2048);
      let headerEnd = -1;
      while (received.length <= maxHeaderBytes && headerEnd < 0) {
        if (attemptController.signal.aborted) {
          throw attemptController.signal.reason || new DOMException('Aborted', 'AbortError');
        }
        const count = await connection.read(buffer);
        if (count === null || count === 0) break;
        for (const byte of buffer.subarray(0, count)) received.push(byte);
        for (let index = Math.max(0, received.length - count - 3); index < received.length - 3; index++) {
          if (received[index] === 13 && received[index + 1] === 10
            && received[index + 2] === 13 && received[index + 3] === 10) {
            headerEnd = index + 4;
            break;
          }
        }
      }
      if (headerEnd < 0 || headerEnd > maxHeaderBytes) throw new Error('webhook_response_headers_invalid');
      return parsePinnedWebhookStatus(Uint8Array.from(received.slice(0, headerEnd)));
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    } finally {
      clearTimeout(attemptTimeout);
      signal?.removeEventListener('abort', abortFromParent);
      attemptController.signal.removeEventListener('abort', abort);
      try { connection?.close(); } catch { /* already closed */ }
    }
  }
  throw lastError;
}

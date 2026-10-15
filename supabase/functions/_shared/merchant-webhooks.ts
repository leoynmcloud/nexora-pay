const encoder = new TextEncoder();
export const merchantWebhookEvents = ['payment.succeeded', 'payment.failed', 'payment.canceled'] as const;

export function validateMerchantWebhookEvents(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20
    || value.some(event => typeof event !== 'string' || !merchantWebhookEvents.includes(event as typeof merchantWebhookEvents[number]))) {
    throw new Error('webhook_events_invalid');
  }
  return [...new Set(value)];
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateMerchantWebhookSecret() {
  return `nxwhsec_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function validateMerchantWebhookUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('webhook_url_invalid');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('webhook_url_invalid'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.port && url.port !== '443'
    || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test') || ipv4 || host.includes(':')) {
    throw new Error('webhook_url_invalid');
  }
  return url.toString();
}

function parseIpv4(value: string) {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

function isPublicIpv4(value: string) {
  const ip = parseIpv4(value);
  if (!ip) return false;
  const [a, b, c] = ip;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0 || b === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6(value: string) {
  // DNS answers must be plain literals; reject scoped literals instead of
  // silently stripping an interface identifier before the SSRF check.
  if (value.includes('%')) return null;
  const normalized = value.toLowerCase();
  if (!normalized || (normalized.match(/::/g) || []).length > 1) return null;
  let source = normalized;
  const ipv4Tail = source.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Tail) {
    const ipv4 = parseIpv4(ipv4Tail[1]);
    if (!ipv4) return null;
    source = source.slice(0, -ipv4Tail[1].length) + `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = source.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some(part => !/^[a-f0-9]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map(part => Number.parseInt(part, 16));
  return words.length === 8 ? words : null;
}

function isPublicIpv6(value: string) {
  const words = parseIpv6(value);
  if (!words) return false;
  // Global unicast (2000::/3); conservatively exclude protocol and documentation ranges.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  if (words[0] === 0x2001 && (words[1] === 0x0db8 || words[1] <= 0x01ff)) return false;
  // 6to4 embeds an IPv4 address in the destination and may route through a relay.
  // Reject the whole 6to4 transition prefix rather than allowing tunneled IPv4 destinations.
  if (words[0] === 0x2002) return false;
  return true;
}

export function isPublicWebhookIp(value: string) {
  return value.includes(':') ? isPublicIpv6(value) : isPublicIpv4(value);
}

export async function resolvePublicMerchantWebhookDestination(
  value: unknown,
  resolve: (hostname: string, recordType: 'A' | 'AAAA', signal?: AbortSignal) => Promise<string[]>,
  signal?: AbortSignal,
) {
  const endpoint = validateMerchantWebhookUrl(value);
  const hostname = new URL(endpoint).hostname;
  let answers: string[];
  try {
    const records = await Promise.all([
      resolve(hostname, 'A', signal),
      resolve(hostname, 'AAAA', signal),
    ]);
    answers = records.flat();
  } catch {
    throw new Error('webhook_dns_unavailable');
  }
  if (answers.length === 0) throw new Error('webhook_dns_unavailable');
  if (answers.some(address => !isPublicWebhookIp(address))) {
    throw new Error('webhook_dns_rejected');
  }
  return { url: endpoint, addresses: [...new Set(answers)] };
}

export async function assertPublicMerchantWebhookDestination(
  value: unknown,
  resolve: (hostname: string, recordType: 'A' | 'AAAA', signal?: AbortSignal) => Promise<string[]>,
  signal?: AbortSignal,
) {
  return (await resolvePublicMerchantWebhookDestination(value, resolve, signal)).url;
}

export async function signMerchantWebhook(secret: string, timestampSeconds: number, rawBody: string) {
  if (!/^nxwhsec_[A-Za-z0-9_-]{43}$/.test(secret) || !Number.isSafeInteger(timestampSeconds)
    || timestampSeconds <= 0 || typeof rawBody !== 'string' || rawBody.length > 1_000_000) {
    throw new Error('webhook_signature_input_invalid');
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestampSeconds}.${rawBody}`)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyMerchantWebhookSignature(
  secret: string, timestampSeconds: number, rawBody: string, signature: string, nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = await signMerchantWebhook(secret, timestampSeconds, rawBody);
  const left = encoder.encode(expected), right = encoder.encode(signature);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) mismatch |= (left[index] || 0) ^ (right[index] || 0);
  return mismatch === 0;
}

export function isSuccessfulWebhookResponse(status: number) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export type MerchantApiEnvironment = 'sandbox' | 'production';
export type MerchantApiScope = 'payments:read' | 'payments:write';
export const merchantApiScopes: readonly MerchantApiScope[] = [
  'payments:read', 'payments:write',
];

export function generateMerchantApiKey(environment: MerchantApiEnvironment) {
  if (environment !== 'sandbox' && environment !== 'production') throw new Error('api_key_environment_invalid');
  const prefix = environment === 'production' ? 'nx_live_' : 'nx_test_';
  return `${prefix}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function merchantApiKeyPrefix(key: string) {
  if (!/^nx_(?:live|test)_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('api_key_invalid');
  return key.slice(0, 16);
}

export async function hashMerchantApiKey(key: string) {
  if (!/^nx_(?:live|test)_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('api_key_invalid');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function validateMerchantApiScopes(value: unknown): MerchantApiScope[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8
    || value.some(scope => typeof scope !== 'string' || !merchantApiScopes.includes(scope as MerchantApiScope))) {
    throw new Error('api_key_scopes_invalid');
  }
  return [...new Set(value as MerchantApiScope[])].sort();
}

const encoder = new TextEncoder();

function decodeBase64(value: string): Uint8Array {
  if (!value || value.length > 24000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('credential_encoding_invalid');
  }
  try { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
  catch { throw new Error('credential_encoding_invalid'); }
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importCredentialKey(encodedKey: string, usage: KeyUsage[]): Promise<CryptoKey> {
  if (!encodedKey || encodedKey.length > 256) throw new Error('credential_encryption_key_invalid');
  const keyBytes = decodeBase64(encodedKey);
  if (keyBytes.length !== 32) throw new Error('credential_encryption_key_invalid');
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, usage);
}

/** Encrypt provider secrets with the versioned AES-256-GCM envelope stored in Postgres. */
export async function encryptProviderCredential(value: string, encodedKey: string): Promise<string> {
  if (!value || value.length > 4000) throw new Error('provider_credential_invalid');
  const key = await importCredentialKey(encodedKey, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value));
  return `v1.${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
}

/** Decrypt only the exact versioned envelope emitted by encryptProviderCredential. */
export async function decryptProviderCredential(envelope: string, encodedKey: string): Promise<string> {
  if (!envelope || envelope.length > 12000) throw new Error('stored_credential_invalid');
  const parts = envelope.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('stored_credential_invalid');
  const iv = decodeBase64(parts[1]);
  const ciphertext = decodeBase64(parts[2]);
  if (iv.length !== 12 || ciphertext.length < 17) throw new Error('stored_credential_invalid');
  const key = await importCredentialKey(encodedKey, ['decrypt']);
  try {
    const cleartext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const value = new TextDecoder('utf-8', { fatal: true }).decode(cleartext);
    if (!value || value.length > 4000) throw new Error('stored_credential_invalid');
    return value;
  } catch {
    throw new Error('stored_credential_unavailable');
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decryptProviderCredential, encryptProviderCredential } from './provider-credentials.ts';

const key = btoa(String.fromCharCode(...Uint8Array.from({ length: 32 }, (_, index) => index + 1)));
const credentialMigration = readFileSync(new URL('../../../nexora-platform-provider-credentials.sql', import.meta.url), 'utf8');
const neutralCredentialMigration = readFileSync(new URL('../../../nexora-provider-credentials-provider-neutral.sql', import.meta.url), 'utf8');
const mercadopagoCredentialMigration = readFileSync(new URL('../../../nexora-mercadopago-credentials.sql', import.meta.url), 'utf8');
const providerConfigEdge = readFileSync(new URL('../nexora-provider-config/index.ts', import.meta.url), 'utf8');

test('provider credential envelope', async (t) => {
  await t.test('round-trips a secret and uses a fresh IV', async () => {
    const first = await encryptProviderCredential('$aact_prod_secret-value', key);
    const second = await encryptProviderCredential('$aact_prod_secret-value', key);
    assert.notEqual(first, second);
    assert.equal(first.split('.')[0], 'v1');
    assert.equal(await decryptProviderCredential(first, key), '$aact_prod_secret-value');
  });

  await t.test('rejects malformed envelopes and weak encryption keys', async () => {
    await assert.rejects(decryptProviderCredential('v2.a.b', key));
    await assert.rejects(decryptProviderCredential('v1.?.?', key));
    await assert.rejects(encryptProviderCredential('secret', btoa('short')));
  });

  await t.test('authenticated encryption rejects tampering and wrong keys', async () => {
    const envelope = await encryptProviderCredential('secret', key);
    const [version, iv, data] = envelope.split('.');
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
    bytes[0] ^= 1;
    const modified = `${version}.${iv}.${btoa(String.fromCharCode(...bytes))}`;
    await assert.rejects(decryptProviderCredential(modified, key));
    const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    await assert.rejects(decryptProviderCredential(envelope, wrongKey));
  });
});

test('central credential persistence accepts any enabled acquirer without Asaas-specific SQL rules', () => {
  const saveFunction = (source: string) => {
    const start = source.indexOf('create or replace function public.nexora_admin_save_platform_provider_credential(');
    const end = source.indexOf('revoke all on function public.nexora_admin_save_platform_provider_credential', start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  for (const source of [credentialMigration, neutralCredentialMigration]) {
    const fn = saveFunction(source);
    assert.doesNotMatch(fn, /asaas|mercadopago/i);
    assert.match(fn, /a\.id=p_acquirer_id and a\.environment=p_environment and a\.status='enabled'/);
    assert.match(fn, /v_code !~ '\^\[a-z\]\[a-z0-9_-\]\{1,79\}\$'/);
    assert.match(fn, /pg_advisory_xact_lock/);
    assert.match(fn, /provider\.platform_credential\.rotated/);
  }
});

test('central credential migration does not require the optional legacy Asaas operations table', () => {
  const guard = credentialMigration.slice(credentialMigration.indexOf('do $$ begin'), credentialMigration.indexOf('end $$;') + 'end $$;'.length);
  assert.ok(guard.length > 0);
  assert.doesNotMatch(guard, /nexora_asaas_sandbox_operations/);
  assert.match(credentialMigration, /if to_regclass\('public\.nexora_asaas_sandbox_operations'\) is not null then\s+execute 'alter table public\.nexora_asaas_sandbox_operations/);
  assert.equal((credentialMigration.match(/v_operation record;/g) || []).length, 2);
});

test('saving provider credentials requires AAL2 in Edge and confines the persistence RPC to service role', () => {
  assert.match(providerConfigEdge, /getAuthenticatorAssuranceLevel\(token\)/);
  assert.match(providerConfigEdge, /assurance\?\.currentLevel !== 'aal2'/);
  assert.match(providerConfigEdge, /admin\.rpc\('nexora_admin_save_platform_provider_credential'/);
  assert.match(providerConfigEdge, /p_actor_id: authData\.user\.id/);
  for (const source of [credentialMigration, neutralCredentialMigration]) {
    const start = source.indexOf('create or replace function public.nexora_admin_save_platform_provider_credential(');
    const end = source.indexOf('revoke all on function public.nexora_admin_save_platform_provider_credential', start);
    assert.ok(start >= 0 && end > start);
    const fn = source.slice(start, end);
    assert.match(fn, /auth\.jwt\(\)->>'role'.*service_role/);
    assert.match(fn, /auth\.users u join public\.nexora_admins a/);
    assert.match(fn, /where u\.id=p_actor_id and a\.role='super_admin'/);
    assert.match(source.slice(end), /grant execute on function public\.nexora_admin_save_platform_provider_credential\(uuid,uuid,text,text,text,text\)\s+to service_role/i);
    assert.doesNotMatch(source.slice(end), /grant execute on function public\.nexora_admin_save_platform_provider_credential\([^;]+to authenticated/i);
  }
  const legacyStart = mercadopagoCredentialMigration.indexOf('create or replace function public.nexora_admin_save_platform_provider_credential(');
  const legacyEnd = mercadopagoCredentialMigration.indexOf('revoke all on function public.nexora_admin_save_platform_provider_credential', legacyStart);
  assert.ok(legacyStart >= 0 && legacyEnd > legacyStart);
  assert.match(mercadopagoCredentialMigration, /drop function if exists public\.nexora_admin_save_platform_provider_credential\(uuid,text,text,text,text\)/i);
  assert.match(mercadopagoCredentialMigration.slice(legacyStart, legacyEnd), /auth\.jwt\(\)->>'role'.*service_role/);
  assert.match(mercadopagoCredentialMigration.slice(legacyStart, legacyEnd), /where u\.id=p_actor_id and a\.role='super_admin'/);
  assert.match(mercadopagoCredentialMigration.slice(legacyEnd), /grant execute on function public\.nexora_admin_save_platform_provider_credential\(uuid,uuid,text,text,text,text\)\s+to service_role/i);
});

test('credential-save failures have safe diagnostics without logging or returning the credential', () => {
  assert.match(providerConfigEdge, /failurePhase = 'credential_encryption'/);
  assert.match(providerConfigEdge, /failurePhase = 'credential_fingerprint'/);
  assert.match(providerConfigEdge, /failurePhase = 'credential_persistence'/);
  assert.match(providerConfigEdge, /request_id: requestId, phase: failurePhase, error_type: errorType/);
  assert.match(providerConfigEdge, /error_code: 'provider_config_failure', request_id: requestId/);
  assert.doesNotMatch(providerConfigEdge, /console\.error\([^\n]*(?:apiKey|error\.message|ciphertext|encryptionKey)/);
  assert.match(readFileSync(new URL('../../../nexora-admin.js', import.meta.url), 'utf8'), /requestId = payload\?\.request_id/);
});

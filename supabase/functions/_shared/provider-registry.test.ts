import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providerAdapterCatalog, providerAdapterRoute, registeredProviderCodes } from './provider-registry.ts';

test('the shared payment registry advertises both implemented Pix adapters', () => {
  assert.deepEqual(registeredProviderCodes(), [
    'asaas_sandbox', 'asaas_production', 'mercadopago_sandbox', 'mercadopago_production', 'mercadopago_leo_production',
  ]);
  assert.equal(providerAdapterRoute('mercadopago_sandbox')?.adapter, 'mercadopago');
  assert.equal(providerAdapterRoute('mercadopago_production')?.adapter, 'mercadopago');
  assert.equal(providerAdapterRoute('mercadopago_leo_production')?.adapter, 'mercadopago');
  assert.deepEqual(providerAdapterRoute('mercadopago_production')?.methods, ['pix', 'credit_card']);
  assert.deepEqual(providerAdapterRoute('mercadopago_leo_production')?.methods, ['pix', 'credit_card']);
});

test('the catalog distinguishes implemented code from production homologation', () => {
  const mp = providerAdapterCatalog().find((route) => route.code === 'mercadopago_production');
  assert.equal(mp?.implementation_status, 'implemented');
  assert.equal(mp?.operational_status, 'not_homologated');
  assert.equal(mp?.credential_setup, 'central');
  const asaasSandbox = providerAdapterCatalog().find((route) => route.code === 'asaas_sandbox');
  assert.equal(asaasSandbox?.operational_status, 'sandbox_only');
  assert.equal(providerAdapterRoute('unsupported_production'), null);
});

test('Super Admin does not present adapter implementation as payment homologation', () => {
  const admin = readFileSync(new URL('../../../nexora-admin.js', import.meta.url), 'utf8');
  assert.match(admin, /implementation_status === 'implemented'/);
  assert.match(admin, /homologação verificada separadamente/);
  assert.match(admin, /Homologação de produção não comprovada/);
  assert.doesNotMatch(admin, /conector validado|Sem adaptador homologado/);
});

test('Super Admin can stage an unimplemented acquirer only while it stays paused', () => {
  const admin = readFileSync(new URL('../../../nexora-admin.js', import.meta.url), 'utf8');
  assert.match(admin, /providerCatalog\.find\(adapter => adapter\.code === item\.code\)\?\.methods/);
  assert.match(admin, /Meios declarados/);
  assert.match(admin, /implementedMethods\.has\(m\)/);
  assert.match(admin, /chosenStatus !== 'disabled' && chosenMethods\.some\(method => !implementedMethods\.has\(method\)\)/);
  assert.match(admin, /Meios sem adaptador só podem ser cadastrados com o adquirente pausado/);
  assert.match(admin, /p_status:chosenStatus/);
});

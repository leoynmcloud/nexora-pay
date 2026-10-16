import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostedCheckoutAdapter, hostedCheckoutDomains, hostedCheckoutPayerRequirements, isHostedCheckoutUrlTrusted } from './hosted-checkout-providers.ts';
import { providerAdapterRoute, registeredProviderCodes } from './provider-registry.ts';

test('hosted checkout routes supported production providers through provider adapters', () => {
  assert.equal(hostedCheckoutAdapter('asaas_production'), 'asaas');
  assert.equal(hostedCheckoutAdapter('mercadopago_production'), 'mercadopago');
  assert.equal(hostedCheckoutAdapter('pushinpay_production'), 'pushinpay');
});

test('hosted checkout rejects unknown, malformed, and sandbox routes', () => {
  assert.equal(hostedCheckoutAdapter('other_production'), null);
  assert.equal(hostedCheckoutAdapter('asaas_sandbox'), null);
  assert.equal(hostedCheckoutAdapter(null), null);
  assert.equal(hostedCheckoutAdapter({ code: 'asaas_production' }), null);
});

test('payer requirements are declared by the provider route, not provider-name checks in the checkout UI', () => {
  assert.deepEqual(hostedCheckoutPayerRequirements('asaas_production'), { email_required: false });
  assert.deepEqual(hostedCheckoutPayerRequirements('mercadopago_production'), { email_required: true });
  assert.equal(hostedCheckoutPayerRequirements('unknown_production'), null);
  assert.equal(hostedCheckoutPayerRequirements('mercadopago_sandbox'), null);
});

test('provider checkout URLs are HTTPS-only and bound to exact registered domains or subdomains', () => {
  assert.deepEqual(hostedCheckoutDomains('mercadopago_production'), ['mercadopago.com', 'mercadopago.com.br']);
  assert.equal(isHostedCheckoutUrlTrusted('asaas_production', 'https://www.asaas.com/i/abc'), 'https://www.asaas.com/i/abc');
  assert.equal(isHostedCheckoutUrlTrusted('mercadopago_production', 'https://pay.mercadopago.com.br/checkout/abc'), 'https://pay.mercadopago.com.br/checkout/abc');
  assert.equal(isHostedCheckoutUrlTrusted('asaas_production', 'https://asaas.com.evil.example/pay'), null);
  assert.equal(isHostedCheckoutUrlTrusted('asaas_production', 'http://asaas.com/pay'), null);
  assert.equal(isHostedCheckoutUrlTrusted('asaas_production', 'https://asaas.com:8443/pay'), null);
  assert.equal(isHostedCheckoutUrlTrusted('asaas_production', 'https://user@asaas.com/pay'), null);
  assert.equal(isHostedCheckoutUrlTrusted('unknown_production', 'https://payments.example/pay'), null);
});

test('hosted checkout derives every production Pix route from the central registry', () => {
  for (const code of registeredProviderCodes()) {
    const route = providerAdapterRoute(code);
    assert.ok(route);
    assert.equal(hostedCheckoutAdapter(code), !route.sandboxOnly && route.methods.includes('pix') ? route.adapter : null);
  }
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderHealth, providerHealthEndpoint } from './provider-health.ts';

describe('fixed provider health endpoints', () => {
  it('selects official Asaas and Mercado Pago endpoints by adapter and environment', () => {
    assert.equal(providerHealthEndpoint('asaas', 'asaas_production', 'production', 'https://api.asaas.com/v3'),
      'https://api.asaas.com/v3/myAccount/status/');
    assert.equal(providerHealthEndpoint('asaas', 'asaas_sandbox', 'sandbox', 'https://api-sandbox.asaas.com/v3'),
      'https://api-sandbox.asaas.com/v3/myAccount/status/');
    assert.equal(providerHealthEndpoint('mercadopago', 'mercadopago_production', 'production', 'https://api.mercadopago.com'),
      'https://api.mercadopago.com/users/me');
    assert.equal(providerHealthEndpoint('mercadopago', 'mercadopago_sandbox', 'sandbox', 'https://api.mercadopago.com'),
      'https://api.mercadopago.com/users/me');
    assert.equal(providerHealthEndpoint('pushinpay', 'pushinpay_production', 'production', 'https://api.pushinpay.com.br/api'),
      'https://api.pushinpay.com.br/api/transactions');
    assert.equal(providerHealthEndpoint('orusprime', 'orusprime_production', 'production', 'https://app.orusprime.com.br/api/v1'),
      'https://app.orusprime.com.br/api/v1/gateway/transactions?id=health-check');
  });

  it('rejects unknown adapters, mismatched environments, and arbitrary API hosts', () => {
    assert.equal(providerHealthEndpoint('mercadopago', 'mercadopago_production', 'sandbox', 'https://api.mercadopago.com'), null);
    assert.equal(providerHealthEndpoint('asaas', 'asaas_production', 'production', 'https://attacker.example'), null);
    assert.equal(providerHealthEndpoint('pushinpay', 'pushinpay_production', 'production', 'https://attacker.example'), null);
    assert.equal(providerHealthEndpoint('orusprime', 'orusprime_production', 'production', 'https://attacker.example'), null);
    assert.equal(providerHealthEndpoint('other', 'other_production', 'production', 'https://attacker.example'), null);
  });
});

describe('provider health probe classification', () => {
  it('marks fast successful probes online and slow ones degraded', () => {
    assert.deepEqual(classifyProviderHealth(200, 250), {
      status: 'ONLINE', latencyMs: 250, httpStatus: 200, errorCode: null,
    });
    assert.deepEqual(classifyProviderHealth(404, 250, false, 'orusprime'), {
      status: 'ONLINE', latencyMs: 250, httpStatus: 200, errorCode: null,
    });
    assert.deepEqual(classifyProviderHealth(204, 2_001), {
      status: 'DEGRADED', latencyMs: 2_001, httpStatus: 204, errorCode: 'provider_slow',
    });
  });

  it('does not misreport rejected credentials or rate limits as provider outages', () => {
    assert.equal(classifyProviderHealth(401, 100).status, 'DEGRADED');
    assert.equal(classifyProviderHealth(401, 100).errorCode, 'credential_rejected');
    assert.equal(classifyProviderHealth(429, 100).errorCode, 'provider_rate_limited');
  });

  it('marks network and provider server failures offline without exposing response data', () => {
    assert.equal(classifyProviderHealth(null, null, true).status, 'OFFLINE');
    assert.equal(classifyProviderHealth(503, 300).errorCode, 'provider_server_error');
  });

  it('bounds latency and rejects impossible HTTP status values', () => {
    assert.equal(classifyProviderHealth(200, 99_000).latencyMs, null);
    assert.throws(() => classifyProviderHealth(600, 10));
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMercadoPagoAccessToken } from './mercadopago-credentials.ts';

describe('Mercado Pago credential validation', () => {
  it('validates the token only against the fixed profile endpoint and discards the response body', async () => {
    let url = '';
    let auth = '';
    const response = Response.json({ id: 123, email: 'sensitive@example.com' });
    await validateMercadoPagoAccessToken('APP_USR-private-token', 'production', async (input, init) => {
      url = String(input);
      auth = new Headers(init?.headers).get('Authorization') || '';
      return response;
    });
    assert.equal(url, 'https://api.mercadolibre.com/users/me');
    assert.equal(auth, 'Bearer APP_USR-private-token');
    assert.equal(response.bodyUsed, true);
  });

  it('rejects invalid and provider-rejected tokens with safe codes', async () => {
    await assert.rejects(validateMercadoPagoAccessToken('bad-token', 'sandbox', async () => { throw new Error('must not fetch'); }), /access_token_invalid/);
    await assert.rejects(validateMercadoPagoAccessToken('APP_USR-production-token', 'sandbox', async () => { throw new Error('must not fetch'); }), /access_token_invalid/);
    await assert.rejects(validateMercadoPagoAccessToken('APP_USR-invalid', 'production', async () => new Response('', { status: 401 })), /access_token_rejected/);
    await assert.rejects(validateMercadoPagoAccessToken('APP_USR-error', 'production', async () => new Response('', { status: 503 })), /validation_unavailable/);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  assertCheckoutToken,
  checkoutRequestHash,
  checkoutTokenHash,
  generateCheckoutToken,
  isHostedCheckoutMethodSupported,
  normalizeCheckoutPayer,
} from './hosted-checkout.ts';

const checkoutUi = readFileSync(new URL('../../../checkout-app.js', import.meta.url), 'utf8');
const merchantApp = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');
const checkoutHandler = readFileSync(new URL('../nexora-checkout/index.ts', import.meta.url), 'utf8');
const apiHandler = readFileSync(new URL('../nexora-api-v1/index.ts', import.meta.url), 'utf8');
const checkoutView = createRequire(import.meta.url)('../../../checkout-view-model.js');

describe('hosted checkout public token and payer validation', () => {
  it('generates an unpadded 256-bit URL-safe bearer token and stores only its digest', async () => {
    const token = generateCheckoutToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(assertCheckoutToken(token), token);
    const digest = await checkoutTokenHash(token);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.notEqual(digest, token);
    assert.notEqual(generateCheckoutToken(), token);
  });

  it('rejects short, malformed and padded checkout tokens', () => {
    assert.throws(() => assertCheckoutToken('short'), /checkout_token_invalid/);
    assert.throws(() => assertCheckoutToken('A'.repeat(42)), /checkout_token_invalid/);
    assert.throws(() => assertCheckoutToken('A'.repeat(42) + '='), /checkout_token_invalid/);
  });

  it('returns a client error for malformed public checkout tokens instead of reporting a server failure', () => {
    assert.match(checkoutHandler, /publicCheckoutTokenHash\(input\.token\)[\s\S]{0,180}Link de pagamento inválido\.'\s*\},\s*400\)/);
    assert.match(checkoutHandler, /publicCheckoutTokenHash\(token\)[\s\S]{0,180}Link de pagamento inválido\.'\s*\},\s*status: 400/);
  });

  it('normalizes payer fields and rejects malformed identifiers without creating a Nexora login', () => {
    assert.deepEqual(normalizeCheckoutPayer({
      name: '  Maria   da Silva ', email: ' Maria@Example.com ', document: '529.982.247-25',
    }), { name: 'Maria da Silva', email: 'maria@example.com', document: '52998224725' });
    assert.throws(() => normalizeCheckoutPayer({ name: 'M', email: '', document: '123' }), /checkout_payer_invalid/);
    assert.throws(() => normalizeCheckoutPayer({ name: 'Maria', email: 'not-email', document: '11111111111' }), /checkout_payer_invalid/);
  });

  it('lets merchants create production Pix links without pre-registering the buyer in Nexora', () => {
    const linkCreator = merchantApp.slice(merchantApp.indexOf('function newHostedLink()'), merchantApp.indexOf('function showView('));
    assert.match(merchantApp, /if \(!sandboxMode\(\)\) return newHostedLink\(\)/);
    assert.match(linkCreator, /Valor da cobrança/);
    assert.match(linkCreator, /Descrição do produto ou serviço/);
    assert.doesNotMatch(linkCreator, /customer_id|payer_name|payer_document|payer_email/);
    assert.match(checkoutUi, /payer-document/);
  });

  it('binds retries to the same link and normalized payer data', async () => {
    const token = generateCheckoutToken();
    const payer = { name: 'Maria Silva', email: 'maria@example.com', document: '12345678909' };
    const first = await checkoutRequestHash(token, '123e4567-e89b-12d3-a456-426614174000', payer);
    assert.equal(first, await checkoutRequestHash(token, '123e4567-e89b-12d3-a456-426614174000', payer));
    assert.notEqual(first, await checkoutRequestHash(token, '123e4567-e89b-12d3-a456-426614174000', { ...payer, email: null }));
    assert.notEqual(first, await checkoutRequestHash(generateCheckoutToken(), '123e4567-e89b-12d3-a456-426614174000', payer));
  });

  it('accepts valid CPF/CNPJ check digits and rejects forged check digits', () => {
    assert.equal(normalizeCheckoutPayer({ name: 'Maria Silva', email: '', document: '11.222.333/0001-81' }).document, '11222333000181');
    assert.throws(() => normalizeCheckoutPayer({ name: 'Maria Silva', email: '', document: '11.222.333/0001-80' }), /checkout_payer_invalid/);
    assert.equal(normalizeCheckoutPayer({ name: 'Maria Silva', email: '', document: '12.ABC.345/01DE-35' }).document, '12ABC34501DE35');
    assert.throws(() => normalizeCheckoutPayer({ name: 'Maria Silva', email: '', document: '12.ABC.345/01DE-36' }), /checkout_payer_invalid/);
  });

  it('offers an accessible status-only retry and honors bounded Retry-After without auto-submitting payment', () => {
    assert.match(checkoutUi, /data-retry-view/);
    assert.match(checkoutUi, /data-retry-status role="status"/);
    assert.match(checkoutUi, /retry\.onclick = \(\) => load\(\)/);
    assert.match(checkoutUi, /headers\?\.get\?\.\('Retry-After'\)/);
    assert.match(checkoutUi, /retryAfter <= 3600/);
    assert.match(checkoutUi, /if \(loadingView\) return/);
    assert.match(checkoutUi, /Nova consulta disponível em/);
    assert.match(checkoutUi, /Aguarde \$\{error\.retryAfter\} segundos antes de tentar novamente/);
    assert.match(checkoutUi, /if \(view\.processing\) refreshTimer = setTimeout\(load, 5000\)/);
    assert.match(checkoutUi, /action: 'pay', token/);
    assert.doesNotMatch(checkoutUi, /setTimeout\(\(\)\s*=>\s*invoke\(\{\s*action:\s*'pay'/);
  });

  it('renders payer fields from server-declared provider requirements instead of a provider-name branch', () => {
    assert.match(checkoutUi, /snapshot\.payer_requirements\?\.email_required === true/);
    assert.doesNotMatch(checkoutUi, /snapshot\.provider_code\s*===\s*['"]mercadopago/);
    assert.match(checkoutHandler, /hostedCheckoutPayerRequirements\(data\.provider_code\)/);
    assert.match(checkoutHandler, /payerRequirements\.email_required && !payer\.email/);
  });

  it('renders external invoice links only for server-declared provider domains', () => {
    assert.match(checkoutUi, /NexoraCheckoutViewModel\.trustedInvoiceUrl\(payment\.invoice_url, data\.checkout_domains\)/);
    assert.match(checkoutHandler, /checkout_domains: hostedCheckoutDomains\(data\.provider_code\)/);
    assert.doesNotMatch(checkoutUi, /asaas\\\.com|mercadopago\\\.com/);

    const domains = ['asaas.com', 'asaas.com.br'];
    assert.equal(checkoutView.trustedInvoiceUrl('https://www.asaas.com/i/123', domains), 'https://www.asaas.com/i/123');
    assert.equal(checkoutView.trustedInvoiceUrl('https://asaas.com.br/pay/123', domains), 'https://asaas.com.br/pay/123');
    assert.equal(checkoutView.trustedInvoiceUrl('https://asaas.com.evil.example/pay', domains), null);
    assert.equal(checkoutView.trustedInvoiceUrl('https://evilasaas.com/pay', domains), null);
    assert.equal(checkoutView.trustedInvoiceUrl('http://asaas.com/pay', domains), null);
    assert.equal(checkoutView.trustedInvoiceUrl('https://asaas.com:8443/pay', domains), null);
    assert.equal(checkoutView.trustedInvoiceUrl('https://user@asaas.com/pay', domains), null);
    assert.equal(checkoutView.trustedInvoiceUrl('javascript:alert(1)', domains), null);
  });

  it('persists definitive provider rejections but leaves ambiguous outcomes available for read-only recovery', () => {
    assert.match(checkoutHandler, /isDefinitiveMercadoPagoCreateRejection\(code\)/);
    assert.match(checkoutHandler, /isDefinitiveAsaasCreateRejection\(created\.response\.status\)/);
    assert.equal((checkoutHandler.match(/nexora_provider_fail_charge_attempt/g) || []).length, 4);
    const mpStart = checkoutHandler.indexOf('async function handleMercadoPagoPublicPayment');
    const asaasStart = checkoutHandler.indexOf('async function handleNeutralAsaasAttempt');
    const mpFlow = checkoutHandler.slice(mpStart, asaasStart);
    const asaasFlow = checkoutHandler.slice(asaasStart, checkoutHandler.indexOf('async function recoverPublicPayment', asaasStart));
    assert.ok(mpFlow.indexOf('findMercadoPagoPixPaymentByReference') < mpFlow.indexOf('isDefinitiveMercadoPagoCreateRejection'));
    assert.ok(asaasFlow.indexOf('recoverNeutralAsaasPayment(admin,attempt,credential).catch')
      < asaasFlow.indexOf('isDefinitiveAsaasCreateRejection'));
    assert.match(checkoutHandler, /Não tente pagar novamente/);
  });

  it('puts new bearer tokens in URL fragments while accepting older query-string links', () => {
    assert.match(checkoutUi, /new URLSearchParams\(location\.hash\.startsWith\('#'\) \? location\.hash\.slice\(1\) : location\.hash\)/);
    assert.match(checkoutUi, /new URLSearchParams\(location\.search\)\.get\('token'\)/);
    assert.match(checkoutHandler, /checkout\.html#token=\$\{encodeURIComponent\(publicToken\)\}/);
    assert.match(apiHandler, /checkout\.html#token=\$\{encodeURIComponent\(checkoutToken\)\}/);
    assert.doesNotMatch(checkoutHandler + apiHandler, /checkout\.html\?token=/);
  });

  it('distinguishes a ready-to-pay Pix from an uncertain charge creation state', () => {
    assert.match(checkoutUi, /NexoraCheckoutViewModel\.create\(data\)/);
    assert.match(checkoutUi, /data-refresh-checkout/);
    assert.match(checkoutUi, /addEventListener\('click', \(\) => load\(\)\)/);

    const pix = checkoutView.create({ status: 'processing', payment: { pix_copy_paste: '000201...' } });
    assert.equal(pix.hasPixInstructions, true);
    assert.equal(pix.showStatusRefresh, false);
    assert.match(pix.statusMessage, /Pix pronto\. Faça o pagamento/);

    const invoice = checkoutView.create({ status: 'processing', payment: { invoice_url: 'https://www.asaas.com/i/123' } });
    assert.equal(invoice.hasInvoice, true);
    assert.equal(invoice.showStatusRefresh, false);
    assert.match(invoice.statusMessage, /Abra a página segura do adquirente/);

    const uncertain = checkoutView.create({ status: 'processing', payment: null });
    assert.equal(uncertain.showStatusRefresh, true);
    assert.match(uncertain.statusMessage, /Não tente pagar novamente/);

    const paid = checkoutView.create({ status: 'paid', payment: null });
    assert.equal(paid.paid, true);
    assert.equal(paid.showStatusRefresh, false);
    assert.equal(paid.statusMessage, 'Pagamento confirmado.');
  });

  it('collects card data only in provider secure fields and never posts raw card values', () => {
    assert.match(checkoutUi, /mp\.fields\.create\('cardNumber'/);
    assert.match(checkoutUi, /mp\.fields\.createCardToken/);
    assert.match(checkoutUi, /card_token: created\.id/);
    assert.doesNotMatch(checkoutUi, /name="card_number"|name="card_cvv"|name="card_expiry"|<input[^>]*cc-number|<input[^>]*cc-csc/);
    assert.match(checkoutHandler, /!isHostedCheckoutMethodSupported\(input\)/);
    assert.match(checkoutHandler, /parseMercadoPagoCardInput\(input\)/);
    assert.doesNotMatch(checkoutHandler, /rawNumber|last4/);
    assert.doesNotMatch(checkoutHandler, /status:\s*'paid',[\s\S]{0,180}card_last_digits/);
  });

  it('allows Pix or a browser-generated card token and rejects raw card payloads without reading them', () => {
    assert.equal(isHostedCheckoutMethodSupported({}), true);
    assert.equal(isHostedCheckoutMethodSupported({ payment_method: 'pix' }), true);
    assert.equal(isHostedCheckoutMethodSupported({ payment_method: 'credit_card' }), false);
    assert.equal(isHostedCheckoutMethodSupported({ payment_method: 'credit_card', card_token: 'tok' }), true);
    assert.equal(isHostedCheckoutMethodSupported({ payment_method: 'pix', card_token: 'tok' }), false);
    assert.equal(isHostedCheckoutMethodSupported({ card_number: 'not-read' }), false);
    assert.equal(isHostedCheckoutMethodSupported({ payment_method: 'credit_card', card_token: 'tok', card_cvv: 'not-read' }), false);
    assert.equal(isHostedCheckoutMethodSupported({ payment_method: 'debit_card', card_token: 'tok' }), false);
    assert.equal(isHostedCheckoutMethodSupported({ payment_method: null }), false);
  });

  it('does not offer unsupported payment methods when a merchant creates a hosted link', () => {
    const platform = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');
    const linkCreator = platform.slice(platform.indexOf('function newHostedLink()'), platform.indexOf('function showView('));
    assert.match(linkCreator, /Formas? (?:de pagamento aceitas pelo|disponível neste) link/);
    assert.doesNotMatch(linkCreator, /name="payment_method"|Somente Cartão|Pix \+ .*Cartão/);
  });
});


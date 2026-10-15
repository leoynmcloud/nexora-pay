import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { isValidBrazilianDocument, isValidCnpj, normalizeBrazilianDocument } from './brazilian-documents.ts';

createRequire(import.meta.url)('../../../brazilian-documents.js');
const browser = (globalThis as any).NexoraBrazilianDocuments;
const migration = readFileSync(new URL('../../../nexora-cnpj-alphanumeric.sql', import.meta.url), 'utf8');
const checkoutDocumentMigration = readFileSync(new URL('../../../nexora-checkout-alphanumeric-payer-document.sql', import.meta.url), 'utf8');
const onboardingUi = readFileSync(new URL('../../../onboarding.js', import.meta.url), 'utf8');
const checkoutUi = readFileSync(new URL('../../../checkout-app.js', import.meta.url), 'utf8');
const platformUi = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');

describe('Brazilian CPF and alphanumeric CNPJ', () => {
  it('normalizes and validates the official Receita Federal alphanumeric CNPJ example', () => {
    const officialExample = '12.ABC.345/01DE-35';
    assert.equal(normalizeBrazilianDocument(officialExample), '12ABC34501DE35');
    assert.equal(isValidCnpj('12ABC34501DE35'), true);
    assert.equal(isValidBrazilianDocument(officialExample), true);
    assert.equal(browser.normalize(officialExample), '12ABC34501DE35');
    assert.equal(browser.isValid(officialExample, 'cnpj'), true);
  });

  it('keeps numeric CPF/CNPJ valid and rejects invalid check digits and malformed characters', () => {
    assert.equal(isValidBrazilianDocument('529.982.247-25'), true);
    assert.equal(isValidBrazilianDocument('11.222.333/0001-81'), true);
    assert.equal(isValidBrazilianDocument('12.ABC.345/01DE-36'), false);
    assert.equal(isValidBrazilianDocument('12.ABC.345/01D!-35'), false);
    assert.equal(isValidBrazilianDocument('12ABC34501DE35', 'cpf'), false);
    assert.equal(browser.isValid('12.ABC.345/01DE-36', 'cnpj'), false);
  });

  it('keeps browser and database paths aligned and preserves letters through KYC/workspace persistence', () => {
    assert.match(onboardingUi, /NexoraBrazilianDocuments\.normalize/);
    assert.match(onboardingUi, /NexoraBrazilianDocuments\.isValid/);
    assert.match(checkoutUi, /NexoraBrazilianDocuments\.isValid/);
    assert.match(platformUi, /NexoraBrazilianDocuments\.normalize/);
    assert.match(migration, /ascii\(substring\(v from i for 1\)\)-48/);
    assert.match(migration, /public\.nexora_valid_cnpj\(v_document\)/);
    assert.match(migration, /document=coalesce\(v_document,document\)/);
    assert.match(migration, /nexora_customers_document_format[\s\S]*nexora_valid_brazilian_document/);
    assert.match(migration, /nexora_valid_brazilian_document\(document\)\) not valid/);
    assert.doesNotMatch(migration, /\[\^0-9\]/);
  });

  it('accepts validated alphanumeric CNPJ in hosted checkout without weakening database validation', () => {
    const checkoutCore = readFileSync(new URL('../../../nexora-provider-neutral-payment-attempts.sql', import.meta.url), 'utf8');
    const checkoutBase = readFileSync(new URL('../../../nexora-hosted-checkout.sql', import.meta.url), 'utf8');
    assert.match(checkoutUi, /inputMode = 'text'/);
    assert.match(checkoutUi, /CNPJ \(inclusive alfanumérico\)/);
    assert.match(checkoutCore, /p_customer_document is null or p_customer_document !~ '\^\(\[0-9\]\{11\}\|\[A-Z0-9\]\{12\}\[0-9\]\{2\}\)\$'/);
    assert.match(checkoutCore, /p_payer_document is null or p_payer_document !~ '\^\(\[0-9\]\{11\}\|\[A-Z0-9\]\{12\}\[0-9\]\{2\}\)\$'/);
    assert.match(checkoutBase, /p_payer_document is null or p_payer_document !~ '\^\(\[0-9\]\{11\}\|\[A-Z0-9\]\{12\}\[0-9\]\{2\}\)\$'/);
    assert.match(checkoutDocumentMigration, /nexora_valid_brazilian_document\(text\)/);
    assert.match(checkoutDocumentMigration, /public\.nexora_valid_brazilian_document\(%s\)/);
    assert.match(checkoutDocumentMigration, /pg_get_functiondef\(v_function\)/);
    assert.match(checkoutDocumentMigration, /Could not safely identify the payer-document validation/);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const platform = readFileSync(new URL('../../../platform-app.js', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../../../auth.js', import.meta.url), 'utf8');

describe('public product claims', () => {
  it('clearly identifies Nexora as a payment gateway and clarifies partner role', () => {
    assert.match(index, /Gateway de Pagamentos/i);
    assert.match(index, /instituições de pagamento parceiras|adquirentes/i);
    assert.doesNotMatch(index, /O processamento real ainda não está habilitado/);
  });

  it('transparently describes pricing, settlement and no-subscription terms', () => {
    assert.match(index, /mensalidade/i);
    assert.match(index, /adesão|manutenção/i);
    assert.match(index, /Pix/i);
  });

  it('keeps provider names, internal route codes, and admin terminology out of the merchant-facing integration view', () => {
    assert.doesNotMatch(platform, /Adquirente atribuído pelo Super Admin|Adquirente não configurado|O Super Admin precisa atribuir um provedor/);
    assert.doesNotMatch(platform, /Conexão ativa · \$\{e\(connection\.acquirer_name|código de conexão <code>/);
    assert.match(platform, /Gerenciada pela Nexora para sua conta/);
    assert.match(platform, /<p class="nx-status paid">Conexão ativa<\/p>/);
  });

  it('does not instruct public users to re-enable signups in the Supabase control panel', () => {
    assert.match(auth, /Signups not allowed[\s\S]{0,150}O cadastro público está temporariamente indisponível/);
    assert.doesNotMatch(auth, /Ative "Allow new users to sign up"/);
  });
});

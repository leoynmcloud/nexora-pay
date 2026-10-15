import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const checkoutUi = readFileSync(new URL('../../../checkout-app.js', import.meta.url), 'utf8');
const checkoutHandler = readFileSync(new URL('../nexora-checkout/index.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../../nexora-reusable-checkout-orders.sql', import.meta.url), 'utf8');

describe('reusable hosted checkout links and isolated child orders', () => {
  it('parses order_token from URL fragment or query string and includes it in checkout view', () => {
    assert.match(checkoutUi, /orderToken\s*=\s*new URLSearchParams\(location\.hash\.startsWith\('#'\) \? location\.hash\.slice\(1\) : location\.hash\)\.get\('order'\)/);
    assert.match(checkoutUi, /invoke\(\{\s*action:\s*'view',\s*token,\s*\.\.\.\(orderToken \? \{ order_token: orderToken \} : \{\}\)\s*\}\)/);
  });

  it('updates URL hash with order_token on payment submission without page reload', () => {
    assert.match(checkoutUi, /result\.order_token/);
    assert.match(checkoutUi, /#token=\$\{encodeURIComponent\(token\)\}&order=\$\{encodeURIComponent\(orderToken\)\}/);
    assert.match(checkoutUi, /history\.replaceState\(null,\s*'',\s*hash\)/);
  });

  it('provides a button on the confirmed receipt to make a new payment or buy again', () => {
    assert.match(checkoutUi, /data-new-payment/);
    assert.match(checkoutUi, /Fazer Novo Pagamento \/ Comprar Novamente/);
    assert.match(checkoutUi, /orderToken = '';/);
    assert.match(checkoutUi, /history\.replaceState\(null,\s*'',\s*'#token='\s*\+\s*encodeURIComponent\(token\)\)/);
  });

  it('spawns an isolated child order for master links and returns order_token in response', () => {
    assert.match(checkoutHandler, /nexora_checkout_spawn_order/);
    assert.match(checkoutHandler, /p_parent_token_hash:\s*tokenHash/);
    assert.match(checkoutHandler, /p_order_token_hash:\s*orderTokenHash/);
    assert.match(checkoutHandler, /order_token:\s*orderToken/);
  });

  it('resolves child order payment details and status when order_token is provided in view action', () => {
    assert.match(checkoutHandler, /input\.order_token/);
    assert.match(checkoutHandler, /childSnap\.parent_link_id === data\.id/);
    assert.match(checkoutHandler, /order_token:\s*orderTokenStr/);
  });

  it('defines parent_link_id and child order creation in the reusable checkout orders migration', () => {
    assert.match(migration, /add column if not exists parent_link_id uuid references public\.nexora_checkout_links\(id\)/);
    assert.match(migration, /create or replace function public\.nexora_checkout_spawn_order/);
    assert.match(migration, /new\.parent_link_id is distinct from old\.parent_link_id/);
    assert.match(migration, /v_link\.parent_link_id is null/);
    assert.match(migration, /v_max_requests := 300;/);
    assert.match(migration, /v_max_requests := 120;/);
  });
});

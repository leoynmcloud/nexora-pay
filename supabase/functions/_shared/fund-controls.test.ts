import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseFundControlRequest } from './fund-controls.ts';

const uuid = '667dd23b-c80b-4bb7-8b82-b4c7b4261bf4';

test('fund hold requests require bounded positive integer cents and an audited reason', () => {
  assert.deepEqual(parseFundControlRequest({ action: 'list' }), { action: 'list' });
  assert.deepEqual(parseFundControlRequest({ action: 'hold', business_id: uuid, request_id: uuid,
    amount_cents: 1234, reason: 'Revisão de risco solicitada pelo compliance' }), {
    action: 'hold', businessId: uuid, requestId: uuid, amountCents: 1234,
    reason: 'Revisão de risco solicitada pelo compliance',
  });
  assert.deepEqual(parseFundControlRequest({ action: 'release', hold_id: uuid, request_id: uuid,
    reason: 'Documentação verificada e risco encerrado' }), {
    action: 'release', holdId: uuid, requestId: uuid, reason: 'Documentação verificada e risco encerrado',
  });
  for (const amount of [0, -1, 1.25, Number.MAX_SAFE_INTEGER, null, '100']) {
    assert.equal(parseFundControlRequest({ action: 'hold', business_id: uuid, request_id: uuid,
      amount_cents: amount, reason: 'Motivo suficientemente longo' }), null);
  }
  assert.equal(parseFundControlRequest({ action: 'hold', business_id: 'bad', request_id: uuid,
    amount_cents: 1, reason: 'Motivo suficientemente longo' }), null);
  assert.equal(parseFundControlRequest({ action: 'release', hold_id: uuid, request_id: uuid, reason: 'curto' }), null);
  assert.equal(parseFundControlRequest({ action: 'dispatch', hold_id: uuid }), null);
});

test('fund hold SQL moves exact available value, records immutable evidence, and requires service-role RPCs', () => {
  const sql = readFileSync(new URL('../../../nexora-fund-holds.sql', import.meta.url), 'utf8');
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on public\.nexora_merchant_fund_holds,[\s\S]*?from public,anon,authenticated,service_role/i);
  assert.match(sql, /before update or delete[\s\S]*?nexora_ledger_reject_mutation/i);
  assert.match(sql, /if p_amount_cents>v_available then raise exception/i);
  assert.match(sql, /merchant_available','side','debit'[\s\S]*?merchant_blocked','side','credit'/i);
  assert.match(sql, /merchant_blocked','side','debit'[\s\S]*?merchant_available','side','credit'/i);
  assert.match(sql, /merchant\.funds_held/i);
  assert.match(sql, /merchant\.funds_released/i);
  assert.match(sql, /hold_id uuid not null unique references public\.nexora_merchant_fund_holds/i);
  assert.match(sql, /public\.nexora_ledger_post_journal\(v_owner,p_business_id,null,'merchant\.funds_held'/i);
  assert.match(sql, /public\.nexora_ledger_post_journal\(v_owner,v_business,null,'merchant\.funds_released'/i);
  assert.match(sql, /grant execute on function public\.nexora_admin_fund_hold_create[\s\S]*?to service_role/i);
  assert.match(sql, /has_function_privilege\('authenticated',p\.oid,'EXECUTE'\) as authenticated_can_execute/i);
});

test('admin fund control Edge Function authenticates MFA before using the service role', () => {
  const edge = readFileSync(new URL('../nexora-fund-controls/index.ts', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../../config.toml', import.meta.url), 'utf8');
  const mfa = edge.indexOf("assurance?.currentLevel !== 'aal2'");
  const serviceClient = edge.indexOf('createClient(url, serviceKey');
  assert.ok(mfa >= 0 && serviceClient > mfa);
  assert.match(edge, /is_nexora_super_admin/);
  assert.match(edge, /nexora_admin_fund_hold_list/);
  assert.match(edge, /nexora_admin_fund_hold_create/);
  assert.match(edge, /nexora_admin_fund_hold_release/);
  assert.match(edge, /Cache-Control': 'no-store'/);
  assert.match(config, /\[functions\.nexora-fund-controls\]\s+verify_jwt\s*=\s*true/);
});

test('administrative Edge Functions validate MFA against the request JWT, not an empty local session', () => {
  const functions = [
    '../nexora-admin-delete-user/index.ts',
    '../nexora-fund-controls/index.ts',
    '../nexora-payout-admin/index.ts',
    '../nexora-settlement-release/index.ts',
    '../nexora-reserve-release/index.ts',
    '../nexora-reconciliation-admin/index.ts',
    '../nexora-reconcile-asaas/index.ts',
  ];
  for (const path of functions) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /getAuthenticatorAssuranceLevel\(token\)/, `${path} must pass its bearer JWT to the MFA check`);
    assert.doesNotMatch(source, /getAuthenticatorAssuranceLevel\(\)/, `${path} must not depend on a locally stored session`);
  }
});

test('Super Admin offers a reasoned hold and full release with accessible status feedback', () => {
  const html = readFileSync(new URL('../../../nexora-admin.html', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../../../nexora-admin.js', import.meta.url), 'utf8');
  assert.match(html, /href="#admin-fund-holds"[^>]*>[\s\S]*?Saldo bloqueado/);
  assert.match(html, /<section[^>]+id="admin-fund-holds"[\s\S]*?data-fund-hold-form/);
  assert.match(html, /data-fund-hold-message role="status" aria-live="polite"/);
  assert.match(admin, /action: 'hold', business_id:[\s\S]*?request_id:/);
  assert.match(admin, /action: 'release', hold_id:[\s\S]*?request_id:/);
});

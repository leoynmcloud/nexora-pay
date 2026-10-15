import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  processAsaasPaymentReceived,
  processAsaasPaymentStatusNotice,
} from './asaas-webhook-core.ts';

const paymentBase = {
  id: 'pay_123', externalReference: 'nexora_ref_123', billingType: 'PIX', value: 100,
  invoiceUrl: 'https://www.asaas.com/i/pay_123',
};

async function encryptedCredential() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode('$aact_prod_unit_test'),
  );
  const base64 = (value: Uint8Array) => btoa(Array.from(value, b => String.fromCharCode(b)).join(''));
  return {
    encryptionKey: base64(bytes),
    ciphertext: `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`,
  };
}

function fakeAdmin(ciphertext: string, existingStatusEvent: Record<string, unknown> | null = null, neutral = false) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let insertedStatus: Record<string, unknown> | null = null;
  let checkoutLinkUpdated = false;
  const operation = {
    id: 77, business_id: 'business_1', owner_id: 'owner_1', transaction_id: 'transaction_1',
    external_reference: 'nexora_ref_123', provider_reference: 'pay_123', environment: 'production',
    acquirer_id: 'acquirer_1', api_key_ciphertext: ciphertext,
  };
  const transaction = {
    id: 'transaction_1', owner_id: 'owner_1', business_id: 'business_1', amount: 100, test_mode: false,
  };
  const providerOperation = { id: 'provider_op_1', provider_code: 'asaas_production', provider_transaction_id: 'pay_123' };
  const neutralOperation = { ...providerOperation, business_id: 'business_1', owner_id: 'owner_1', transaction_id: 'transaction_1', external_reference: 'nexora_ref_123', environment: 'production', acquirer_id: 'acquirer_1' };
  const neutralAttempt = { id: 'attempt_1', transaction_id: 'transaction_1', business_id: 'business_1', owner_id: 'owner_1', acquirer_id: 'acquirer_1', provider_operation_id: 'provider_op_1', platform_credential_id: 'credential_1', provider_code: 'asaas_production', environment: 'production', external_reference: 'nexora_ref_123', provider_transaction_id: 'pay_123', status: 'processing' };
  const single = (data: unknown) => ({
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data, error: null }; },
  });
  const admin = {
    from(table: string) {
      if (table === 'nexora_checkout_links') return {
        update() { checkoutLinkUpdated = true; return { eq() { return this; }, in: async () => ({ error: null }) }; },
      };
      if (table === 'nexora_asaas_sandbox_operations') return single(operation);
      if (table === 'nexora_transactions') return single(transaction);
      if (table === 'nexora_provider_payment_operations') {
        const filters: Record<string, unknown> = {};
        return {
          select() { return this; },
          eq(key: string, value: unknown) { filters[key] = value; return this; },
          async maybeSingle() {
            if (filters.transaction_id) return { data: providerOperation, error: null };
            if (filters.external_reference) return { data: neutral ? neutralOperation : null, error: null };
            return { data: providerOperation, error: null };
          },
        };
      }
      if (table === 'nexora_payment_attempts') return single(neutral ? neutralAttempt : null);
      if (table === 'nexora_platform_provider_credentials') return single({ api_key_ciphertext: ciphertext });
      if (table === 'nexora_provider_payment_status_events') return {
        insert(row: Record<string, unknown>) {
          insertedStatus = row;
          return {
            select() { return this; },
            async maybeSingle() {
              return existingStatusEvent
                ? { data: null, error: { code: '23505' } }
                : { data: { id: 'status_event_1' }, error: null };
            },
          };
        },
        select() {
          return {
            eq() { return this; },
            async maybeSingle() { return { data: existingStatusEvent, error: null }; },
          };
        },
      };
      throw new Error(`unexpected_table_${table}`);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { error: null };
    },
  };
  return { admin, calls, get insertedStatus() { return insertedStatus; }, get checkoutLinkUpdated() { return checkoutLinkUpdated; } };
}

async function withProviderPayment(
  status: string,
  run: (test: ReturnType<typeof fakeAdmin>) => Promise<void>,
  existingStatusEvent: Record<string, unknown> | null = null,
  neutral = false,
) {
  const originalFetch = globalThis.fetch;
  const previousDeno = (globalThis as any).Deno;
  const credential = await encryptedCredential();
  (globalThis as any).Deno = { env: { get: (name: string) => name === 'NEXORA_CREDENTIALS_ENCRYPTION_KEY' ? credential.encryptionKey : undefined } };
  globalThis.fetch = async () => new Response(JSON.stringify({ ...paymentBase, status }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  try {
    await run(fakeAdmin(credential.ciphertext, existingStatusEvent, neutral));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDeno === undefined) delete (globalThis as any).Deno;
    else (globalThis as any).Deno = previousDeno;
  }
}

describe('Asaas webhook normalized status handling', () => {
  it('records a verified non-receipt status without posting to the ledger', async () => {
    await withProviderPayment('RECEIVED_IN_CASH', async (test) => {
      const result = await processAsaasPaymentStatusNotice(test.admin, 'evt_1', 'PAYMENT_RECEIVED_IN_CASH', {
        ...paymentBase, status: 'RECEIVED_IN_CASH',
      });
      assert.deepEqual(result, { outcome: 'status_recorded', transactionId: 'transaction_1', status: 'UNDER_REVIEW' });
      assert.equal(test.calls.length, 0);
      assert.equal(test.insertedStatus?.normalized_status, 'UNDER_REVIEW');
      assert.equal(test.insertedStatus?.provider_event_type, 'PAYMENT_RECEIVED_IN_CASH');
    });
  });

  it('posts only a server-verified RECEIVED payment and records SUCCEEDED, not SETTLED', async () => {
    await withProviderPayment('RECEIVED', async (test) => {
      const result = await processAsaasPaymentReceived(test.admin, 'evt_2', paymentBase);
      assert.deepEqual(result, { outcome: 'posted_pending', transactionId: 'transaction_1' });
      assert.equal(test.insertedStatus?.normalized_status, 'SUCCEEDED');
      assert.deepEqual(test.calls.map(call => call.name), [
        'nexora_asaas_complete_charge', 'nexora_ledger_post_journal', 'nexora_webhook_enqueue_payment_succeeded',
      ]);
      assert.equal(test.calls[1].args.p_event_code, 'payment.received');
      assert.equal((test.calls[1].args.p_entries as unknown[]).length, 2);
      assert.equal(test.checkoutLinkUpdated, true);
      assert.equal(test.calls[2].args.p_transaction_id, 'transaction_1');
    });
  });

  it('refuses to post a ledger credit when a receipt event is not currently RECEIVED at Asaas', async () => {
    await withProviderPayment('CONFIRMED', async (test) => {
      await assert.rejects(() => processAsaasPaymentReceived(test.admin, 'evt_3', paymentBase), /provider_payment_not_received/);
      assert.equal(test.calls.length, 0);
    });
  });

  it('keeps the first immutable status snapshot but safely retries the same event after provider state advances', async () => {
    await withProviderPayment('RECEIVED', async (test) => {
      const result = await processAsaasPaymentStatusNotice(test.admin, 'evt_retry', 'PAYMENT_UPDATED', paymentBase);
      assert.deepEqual(result, { outcome: 'posted_pending', transactionId: 'transaction_1' });
      assert.equal(test.insertedStatus?.normalized_status, 'SUCCEEDED');
      assert.deepEqual(test.calls.map(call => call.name), [
        'nexora_asaas_complete_charge', 'nexora_ledger_post_journal', 'nexora_webhook_enqueue_payment_succeeded',
      ]);
    }, {
      provider_event_type: 'PAYMENT_UPDATED', provider_operation_id: 'provider_op_1',
      transaction_id: 'transaction_1', provider_transaction_id: 'pay_123',
      raw_provider_status: 'PENDING', normalized_status: 'PENDING',
    });
  });

  it('rejects a duplicate event ID that resolves to a different payment operation', async () => {
    await withProviderPayment('PENDING', async (test) => {
      await assert.rejects(
        () => processAsaasPaymentStatusNotice(test.admin, 'evt_collision', 'PAYMENT_UPDATED', paymentBase),
        /provider_status_event_conflict/,
      );
      assert.equal(test.calls.length, 0);
    }, {
      provider_event_type: 'PAYMENT_UPDATED', provider_operation_id: 'different_operation',
      transaction_id: 'transaction_1', provider_transaction_id: 'pay_123',
      raw_provider_status: 'PENDING', normalized_status: 'PENDING',
    });
  });

  it('uses provider-neutral status, ledger, and confirmation for a generic Asaas attempt', async () => {
    await withProviderPayment('RECEIVED', async (test) => {
      const result = await processAsaasPaymentReceived(test.admin, 'evt_neutral', paymentBase);
      assert.deepEqual(result, { outcome: 'posted_pending', transactionId: 'transaction_1' });
      assert.deepEqual(test.calls.map(call => call.name), [
        'nexora_provider_save_charge_result', 'nexora_ledger_post_journal', 'nexora_provider_confirm_payment_succeeded',
      ]);
      assert.equal(test.calls[1].args.p_idempotency_key, 'provider.payment.succeeded:asaas_production:transaction_1');
      assert.equal(test.calls[2].args.p_provider_code, 'asaas_production');
      assert.equal(test.calls.some(call => call.name === 'nexora_asaas_complete_charge'), false);
      assert.equal(test.insertedStatus?.normalized_status, 'SUCCEEDED');
    }, null, true);
  });

  it('persists generic Asaas rejection and cancellation as terminal states without crediting funds', async () => {
    for (const [providerStatus, normalizedStatus] of [['DELETED','CANCELED'],['REFUNDED','REFUNDED']] as const) {
      await withProviderPayment(providerStatus, async (test) => {
        const result = await processAsaasPaymentStatusNotice(test.admin, `evt_${providerStatus}`, 'PAYMENT_UPDATED', {
          ...paymentBase, status: providerStatus,
        });
        assert.deepEqual(result, { outcome: 'status_recorded', transactionId: 'transaction_1', status: normalizedStatus });
        const saved = test.calls.find(call => call.name === 'nexora_provider_save_charge_result');
        assert.equal(saved?.args.p_normalized_status, normalizedStatus);
        assert.equal(test.calls.some(call => call.name === 'nexora_ledger_post_journal'), false);
        assert.equal(test.calls.some(call => call.name === 'nexora_provider_confirm_payment_succeeded'), false);
      }, null, true);
    }
  });
});

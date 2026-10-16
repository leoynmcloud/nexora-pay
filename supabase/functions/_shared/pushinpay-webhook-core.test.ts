import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processPushinPayPaymentWebhook } from './pushinpay-webhook-core.ts';

function makeAdmin(paymentAmountCents = 1234, paymentStatus = 'paid', duplicateStatus?: string) {
  const calls: Array<{ name: string; args: any }> = [];
  const attempt = {
    id: 'attempt-1',
    transaction_id: 'tx-1',
    business_id: 'biz-1',
    owner_id: 'owner-1',
    acquirer_id: 'acq-1',
    provider_operation_id: 'op-1',
    provider_transaction_id: 'pushin-tx-123',
    environment: 'production',
    external_reference: 'NX-REQUEST-1',
    status: 'processing',
  };
  const transaction = {
    id: 'tx-1',
    owner_id: 'owner-1',
    business_id: 'biz-1',
    amount: paymentAmountCents / 100,
    test_mode: false,
    kind: 'payment',
    acquirer_id: 'acq-1',
    status: 'pending',
  };
  const records: Record<string, any> = {
    nexora_payment_attempts: attempt,
    nexora_transactions: transaction,
  };
  const admin = {
    from(table: string) {
      let filters: Record<string, unknown> = {};
      const query: any = {
        select() { return query; },
        eq(key: string, value: unknown) { filters[key] = value; return query; },
        maybeSingle: async () => {
          if (table === 'nexora_provider_payment_status_events' && duplicateStatus) {
            return {
              data: {
                provider_event_type: 'payment.updated',
                provider_operation_id: 'op-1',
                transaction_id: 'tx-1',
                provider_transaction_id: 'pushin-tx-123',
                normalized_status: duplicateStatus,
              },
              error: null,
            };
          }
          const row = records[table];
          if (!row || Object.entries(filters).some(([key, value]) => row[key] !== value)) {
            return { data: null, error: null };
          }
          return { data: row, error: null };
        },
        insert(row: any) {
          assert.equal(table, 'nexora_provider_payment_status_events');
          calls.push({ name: 'insert_status_event', args: row });
          if (duplicateStatus) {
            return {
              select() { return this; },
              maybeSingle: async () => ({ data: null, error: { code: '23505' } }),
            };
          }
          return {
            select() { return this; },
            maybeSingle: async () => ({ data: { id: 'event-row-1' }, error: null }),
          };
        },
      };
      return query;
    },
    async rpc(name: string, args: any) {
      calls.push({ name, args });
      return { data: null, error: null };
    },
  };
  const fetchImpl: typeof fetch = async () => Response.json({
    id: 'pushin-tx-123',
    value: paymentAmountCents,
    status: paymentStatus,
    pix_details: {
      emv: 'pix-copy-paste',
      expiration_date: new Date(Date.now() + 3600000).toISOString(),
    },
  });
  return { admin, calls, fetchImpl };
}

describe('PushinPay webhook verified payment processing', () => {
  it('credits only the pending ledger after provider identity, amount, and status are verified', async () => {
    const { admin, calls, fetchImpl } = makeAdmin();
    const result = await processPushinPayPaymentWebhook(admin, {
      eventId: 'pushin-event-1',
      eventType: 'payment.updated',
      providerTransactionId: 'pushin-tx-123',
      apiKey: 'test-token',
    }, fetchImpl);

    assert.deepEqual(result, { outcome: 'posted_pending', transactionId: 'tx-1' });
    assert.equal(calls.find(call => call.name === 'insert_status_event')?.args.normalized_status, 'SUCCEEDED');

    const ledger = calls.find(call => call.name === 'nexora_ledger_post_journal');
    assert.equal(ledger?.args.p_event_code, 'payment.received');
    assert.equal(ledger?.args.p_idempotency_key, 'provider.payment.succeeded:pushinpay_production:tx-1');
    assert.ok(ledger.args.p_idempotency_key.length <= 128);
    assert.deepEqual(ledger?.args.p_entries, [
      { account_code: 'provider_clearing', side: 'debit', amount_cents: 1234 },
      { account_code: 'merchant_pending', side: 'credit', amount_cents: 1234 },
    ]);

    const confirmation = calls.find(call => call.name === 'nexora_provider_confirm_payment_succeeded')?.args;
    assert.equal(confirmation?.p_provider_code, 'pushinpay_production');
    assert.equal(confirmation?.p_provider_event_id, 'pushin-event-1');
    assert.equal(calls.at(-1)?.name, 'nexora_provider_confirm_payment_succeeded');
  });

  it('records non-success states without posting funds', async () => {
    const { admin, calls, fetchImpl } = makeAdmin(1234, 'created');
    const result = await processPushinPayPaymentWebhook(admin, {
      eventId: 'pushin-event-pending',
      eventType: 'payment.updated',
      providerTransactionId: 'pushin-tx-123',
      apiKey: 'test-token',
    }, fetchImpl);

    assert.deepEqual(result, { outcome: 'status_recorded', transactionId: 'tx-1', status: 'PENDING' });
    assert.equal(calls.some(call => call.name === 'nexora_ledger_post_journal'), false);
    assert.equal(calls.some(call => call.name === 'nexora_provider_confirm_payment_succeeded'), false);
  });

  it('rejects mismatched amounts before status history or ledger writes', async () => {
    const { admin, calls, fetchImpl } = makeAdmin(9999, 'paid');
    await assert.rejects(processPushinPayPaymentWebhook(admin, {
      eventId: 'pushin-event-bad',
      eventType: 'payment.updated',
      providerTransactionId: 'pushin-tx-123',
      apiKey: 'test-token',
    }, async () => Response.json({ id: 'pushin-tx-123', value: 50, status: 'paid' })), /amount_mismatch/);

    assert.equal(calls.length, 0);
  });
});

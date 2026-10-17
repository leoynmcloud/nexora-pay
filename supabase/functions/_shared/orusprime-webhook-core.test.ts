import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processOrusPrimePaymentWebhook } from './orusprime-webhook-core.ts';

function makeAdmin(paymentAmountCents = 1234, paymentStatus = 'COMPLETED', duplicateStatus?: string) {
  const calls: Array<{ name: string; args: any }> = [];
  const attempt = {
    id: 'attempt-1',
    transaction_id: 'tx-1',
    business_id: 'biz-1',
    owner_id: 'owner-1',
    acquirer_id: 'acq-1',
    provider_operation_id: 'op-1',
    provider_transaction_id: 'orus-tx-123',
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
                provider_transaction_id: 'orus-tx-123',
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
    id: 'orus-tx-123',
    clientIdentifier: 'order-1',
    amount: paymentAmountCents / 100,
    status: paymentStatus,
    pixInformation: {
      qrCode: 'pix-copy-paste',
      image: 'https://example.com/qr.png',
    },
  });
  return { admin, calls, fetchImpl };
}

describe('OrusPrime webhook verified payment processing', () => {
  it('credits only the pending ledger after provider identity, amount, and status are verified', async () => {
    const { admin, calls, fetchImpl } = makeAdmin();
    const result = await processOrusPrimePaymentWebhook(admin, {
      eventId: 'orus-event-1',
      eventType: 'payment.updated',
      providerTransactionId: 'orus-tx-123',
      credentialsInput: 'pub_key:sec_key',
    }, fetchImpl);

    assert.deepEqual(result, { outcome: 'posted_pending', transactionId: 'tx-1' });

    const journalCall = calls.find(call => call.name === 'nexora_ledger_post_journal');
    assert.ok(journalCall);
    assert.equal(journalCall.args.p_owner_id, 'owner-1');
    assert.equal(journalCall.args.p_business_id, 'biz-1');
    assert.equal(journalCall.args.p_transaction_id, 'tx-1');
    assert.equal(journalCall.args.p_event_code, 'payment.received');
    assert.deepEqual(journalCall.args.p_entries, [
      { account_code: 'provider_clearing', side: 'debit', amount_cents: 1234 },
      { account_code: 'merchant_pending', side: 'credit', amount_cents: 1234 },
    ]);

    const confirmCall = calls.find(call => call.name === 'nexora_provider_confirm_payment_succeeded');
    assert.ok(confirmCall);
    assert.equal(confirmCall.args.p_provider_code, 'orusprime_production');
    assert.equal(confirmCall.args.p_transaction_id, 'tx-1');
    assert.equal(confirmCall.args.p_provider_transaction_id, 'orus-tx-123');
  });

  it('rejects amount mismatch before mutating ledger', async () => {
    const { admin, calls, fetchImpl } = makeAdmin(1234);
    const mismatchedFetch: typeof fetch = async () => Response.json({
      id: 'orus-tx-123',
      amount: 99.99,
      status: 'COMPLETED',
    });

    await assert.rejects(
      processOrusPrimePaymentWebhook(admin, {
        eventId: 'orus-event-2',
        eventType: 'payment.updated',
        providerTransactionId: 'orus-tx-123',
        credentialsInput: 'pub_key:sec_key',
      }, mismatchedFetch),
      /provider_payment_amount_mismatch/
    );

    assert.equal(calls.some(call => call.name === 'nexora_ledger_post_journal'), false);
    assert.equal(calls.some(call => call.name === 'nexora_provider_confirm_payment_succeeded'), false);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { persistProviderPaymentStatusEvent, type ProviderPaymentStatusEvent } from './payment-status-events.ts';

const event: ProviderPaymentStatusEvent = {
  provider_code: 'mercadopago_production', provider_event_id: 'event-1',
  provider_event_type: 'payment.updated', provider_operation_id: 'operation-1',
  transaction_id: 'transaction-1', provider_transaction_id: '998877',
  raw_provider_status: 'approved', normalized_status: 'SUCCEEDED',
  status_checked_at: '2026-10-10T12:00:00.000Z',
};

function makeAdmin(options: { insertError?: { code: string }; existing?: Record<string, string>; readError?: unknown } = {}) {
  const calls: string[] = [];
  const admin = {
    from(table: string) {
      assert.equal(table, 'nexora_provider_payment_status_events');
      return {
        insert(row: ProviderPaymentStatusEvent) {
          assert.deepEqual(row, event);
          calls.push('insert');
          return { select() { return this; }, maybeSingle: async () => options.insertError
            ? { data: null, error: options.insertError }
            : { data: { id: 'stored-event' }, error: null } };
        },
        select() {
          calls.push('select');
          return {
            eq() { return this; },
            maybeSingle: async () => ({ data: options.existing || null, error: options.readError || null }),
          };
        },
      };
    },
  };
  return { admin, calls };
}

test('provider status event append returns the inserted immutable snapshot', async () => {
  const { admin, calls } = makeAdmin();
  assert.deepEqual(await persistProviderPaymentStatusEvent(admin, event), { id: 'stored-event', normalizedStatus: 'SUCCEEDED' });
  assert.deepEqual(calls, ['insert']);
});

test('duplicate provider event returns the original status only for the same payment identity', async () => {
  const { admin, calls } = makeAdmin({ insertError: { code: '23505' }, existing: {
    provider_event_type: event.provider_event_type, provider_operation_id: event.provider_operation_id,
    transaction_id: event.transaction_id, provider_transaction_id: event.provider_transaction_id,
    normalized_status: 'PENDING',
  } });
  assert.deepEqual(await persistProviderPaymentStatusEvent(admin, event), { id: null, normalizedStatus: 'PENDING' });
  assert.deepEqual(calls, ['insert', 'select']);
});

test('duplicate IDs bound to another event/payment and non-unique errors fail closed', async t => {
  await t.test('rejects an event identity collision', async () => {
    const { admin } = makeAdmin({ insertError: { code: '23505' }, existing: {
      provider_event_type: event.provider_event_type, provider_operation_id: 'other-operation',
      transaction_id: event.transaction_id, provider_transaction_id: event.provider_transaction_id,
      normalized_status: 'SUCCEEDED',
    } });
    await assert.rejects(persistProviderPaymentStatusEvent(admin, event), /provider_status_event_conflict/);
  });
  await t.test('does not hide other insert failures', async () => {
    const { admin } = makeAdmin({ insertError: { code: '42501' } });
    await assert.rejects(persistProviderPaymentStatusEvent(admin, event), /provider_status_event_persist_failed/);
  });
});

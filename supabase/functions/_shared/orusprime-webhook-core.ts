import { getOrusPrimeTransaction } from './orusprime-adapter.ts';
import { persistProviderPaymentStatusEvent } from './payment-status-events.ts';

const encoder = new TextEncoder();

async function digest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function persistVerifiedEvent(admin: any, input: {
  providerCode: string; eventId: string; eventType: string; operationId: string; transactionId: string;
  providerTransactionId: string; rawStatus: string; normalizedStatus: string;
}) {
  return persistProviderPaymentStatusEvent(admin, {
    provider_code: input.providerCode,
    provider_event_id: input.eventId,
    provider_event_type: input.eventType.slice(0, 100),
    provider_operation_id: input.operationId,
    transaction_id: input.transactionId,
    provider_transaction_id: input.providerTransactionId,
    raw_provider_status: input.rawStatus.slice(0, 80),
    normalized_status: input.normalizedStatus,
    status_checked_at: new Date().toISOString(),
  });
}

export async function processOrusPrimePaymentWebhook(
  admin: any,
  input: { eventId: string; eventType?: string; providerTransactionId: string; credentialsInput: string },
  fetchImpl: typeof fetch = fetch,
) {
  if (!input.eventId || input.eventId.length > 255 || !input.providerTransactionId) {
    throw new Error('webhook_metadata_invalid');
  }

  // 1. Authoritative verification with Orus Prime API (anti-spoofing)
  const payment = await getOrusPrimeTransaction(input.credentialsInput, input.providerTransactionId, fetchImpl);

  // 2. Locate attempt by provider_transaction_id
  const { data: attempt, error: attemptError } = await admin.from('nexora_payment_attempts')
    .select('id,transaction_id,business_id,owner_id,acquirer_id,provider_operation_id,provider_transaction_id,environment,external_reference,status')
    .eq('provider_transaction_id', input.providerTransactionId)
    .eq('environment', 'production')
    .maybeSingle();

  if (attemptError) throw new Error('payment_attempt_lookup_failed');
  if (!attempt) {
    return { outcome: 'ignored_unmatched' as const };
  }

  const { data: transaction, error: transactionError } = await admin.from('nexora_transactions')
    .select('id,owner_id,business_id,amount,test_mode,kind,acquirer_id,status')
    .eq('id', attempt.transaction_id)
    .maybeSingle();

  if (transactionError || !transaction || transaction.owner_id !== attempt.owner_id
    || transaction.business_id !== attempt.business_id || transaction.acquirer_id !== attempt.acquirer_id
    || transaction.test_mode || transaction.kind !== 'payment') {
    throw new Error('payment_transaction_identity_mismatch');
  }

  const amountCents = Math.round(Number(transaction.amount) * 100);
  if (payment.valueCents !== undefined && payment.valueCents !== amountCents) {
    throw new Error('provider_payment_amount_mismatch');
  }

  // 3. Save latest charge result
  const { error: saveError } = await admin.rpc('nexora_provider_save_charge_result', {
    p_attempt_id: attempt.id,
    p_provider_transaction_id: input.providerTransactionId,
    p_raw_status: payment.rawStatusCode || payment.status,
    p_normalized_status: payment.status,
    p_pix_copy_paste: payment.pixCopyPaste || null,
    p_pix_encoded_image: payment.qrCodeImage || null,
    p_checkout_url: payment.checkoutUrl || null,
    p_expires_at: payment.expiresAt || null,
  });
  if (saveError) throw new Error('payment_result_persist_failed');

  // 4. Persist idempotent status event
  const persistedEvent = await persistVerifiedEvent(admin, {
    providerCode: 'orusprime_production',
    eventId: input.eventId,
    eventType: input.eventType || 'payment.updated',
    operationId: attempt.provider_operation_id,
    transactionId: transaction.id,
    providerTransactionId: input.providerTransactionId,
    rawStatus: payment.rawStatusCode || payment.status,
    normalizedStatus: payment.status,
  });

  if (persistedEvent.normalizedStatus !== 'SUCCEEDED') {
    return { outcome: 'status_recorded' as const, transactionId: transaction.id, status: persistedEvent.normalizedStatus };
  }

  // 5. Post double-entry journal (debit clearing, credit merchant pending)
  const requestHash = await digest(JSON.stringify({
    provider: 'orusprime_production',
    event: 'payment.succeeded',
    owner: transaction.owner_id,
    business: transaction.business_id,
    transaction: transaction.id,
    provider_payment: input.providerTransactionId,
    amount_cents: amountCents,
  }));

  const { error: ledgerError } = await admin.rpc('nexora_ledger_post_journal', {
    p_owner_id: transaction.owner_id,
    p_business_id: transaction.business_id,
    p_transaction_id: transaction.id,
    p_event_code: 'payment.received',
    p_idempotency_key: `provider.payment.succeeded:orusprime_production:${transaction.id}`,
    p_request_hash: requestHash,
    p_description: 'Pagamento confirmado pelo provedor Orus Prime; aguardando liquidação e conciliação.',
    p_entries: [
      { account_code: 'provider_clearing', side: 'debit', amount_cents: amountCents },
      { account_code: 'merchant_pending', side: 'credit', amount_cents: amountCents },
    ],
    p_metadata: {
      provider_code: 'orusprime_production',
      provider_event_id: input.eventId,
      provider_reference: input.providerTransactionId,
    },
  });
  if (ledgerError) throw new Error('ledger_post_failed');

  // 6. Confirm payment succeeded and trigger transaction status update
  const { error: confirmError } = await admin.rpc('nexora_provider_confirm_payment_succeeded', {
    p_provider_code: 'orusprime_production',
    p_transaction_id: transaction.id,
    p_provider_transaction_id: input.providerTransactionId,
    p_provider_event_id: input.eventId,
  });
  if (confirmError) throw new Error('payment_confirmation_failed');

  return { outcome: 'posted_pending' as const, transactionId: transaction.id };
}

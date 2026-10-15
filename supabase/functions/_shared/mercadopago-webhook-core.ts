import { inspectMercadoPagoPixPayment } from './mercadopago-adapter.ts';
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

/** Verify a notification against MP's API before any internal status or ledger transition. */
export async function processMercadoPagoPaymentWebhook(
  admin: any,
  input: { eventId: string; eventType: string; providerTransactionId: string; accessToken: string },
  fetchImpl: typeof fetch = fetch,
) {
  if (!input.eventId || input.eventId.length>255 || !input.eventType || input.eventType.length>100
    || !/^\d{1,32}$/.test(input.providerTransactionId)) throw new Error('webhook_metadata_invalid');

  const inspected = await inspectMercadoPagoPixPayment(input.accessToken,input.providerTransactionId,fetchImpl);
  const { data: operation, error: operationError } = await admin.from('nexora_provider_payment_operations')
    .select('id,transaction_id,business_id,owner_id,acquirer_id,provider_code,environment,external_reference,provider_transaction_id')
    .eq('environment','production')
    .eq('external_reference',inspected.externalReference).maybeSingle();
  if (operationError) throw new Error('provider_operation_lookup_failed');
  if (!operation) return { outcome: 'ignored_unmatched' as const };
  if ((operation.provider_transaction_id && operation.provider_transaction_id!==input.providerTransactionId)
    || !String(operation.provider_code).startsWith('mercadopago_') || operation.environment!=='production') {
    throw new Error('provider_operation_identity_mismatch');
  }

  const { data: attempt, error: attemptError } = await admin.from('nexora_payment_attempts')
    .select('id,transaction_id,business_id,owner_id,acquirer_id,provider_operation_id,provider_transaction_id,environment,external_reference,status')
    .eq('provider_operation_id',operation.id).maybeSingle();
  if (attemptError || !attempt || attempt.provider_operation_id!==operation.id
    || attempt.transaction_id!==operation.transaction_id || attempt.business_id!==operation.business_id
    || attempt.owner_id!==operation.owner_id || attempt.acquirer_id!==operation.acquirer_id
    || attempt.external_reference!==inspected.externalReference || attempt.environment!=='production') {
    throw new Error('payment_attempt_identity_mismatch');
  }
  const { data: transaction, error: transactionError } = await admin.from('nexora_transactions')
    .select('id,owner_id,business_id,amount,test_mode,kind,acquirer_id,status')
    .eq('id',attempt.transaction_id).maybeSingle();
  if (transactionError || !transaction || transaction.owner_id!==attempt.owner_id
    || transaction.business_id!==attempt.business_id || transaction.acquirer_id!==attempt.acquirer_id
    || transaction.test_mode || transaction.kind!=='payment') throw new Error('payment_transaction_identity_mismatch');
  const amountCents = Math.round(Number(transaction.amount)*100);
  if (!Number.isSafeInteger(amountCents) || amountCents<=0 || amountCents!==inspected.amountCents) {
    throw new Error('provider_payment_amount_mismatch');
  }

  const payment = inspected.payment;
  const { error: saveError } = await admin.rpc('nexora_provider_save_charge_result',{
    p_attempt_id:attempt.id,p_provider_transaction_id:input.providerTransactionId,
    p_raw_status:payment.rawStatusCode||payment.status,p_normalized_status:payment.status,
    p_pix_copy_paste:payment.pixCopyPaste||null,p_pix_encoded_image:payment.qrCodeBase64||null,
    p_checkout_url:payment.checkoutUrl||null,p_expires_at:payment.expiresAt||null,
  });
  if (saveError) throw new Error('payment_result_persist_failed');

  const persistedEvent = await persistVerifiedEvent(admin,{
    providerCode: operation.provider_code,
    eventId:input.eventId,eventType:input.eventType,operationId:operation.id,
    transactionId:transaction.id,providerTransactionId:input.providerTransactionId,
    rawStatus:payment.rawStatusCode||payment.status,normalizedStatus:payment.status,
  });
  if (persistedEvent.normalizedStatus!=='SUCCEEDED') {
    return { outcome:'status_recorded' as const,transactionId:transaction.id,status:persistedEvent.normalizedStatus };
  }

  const requestHash = await digest(JSON.stringify({
    provider:operation.provider_code,event:'payment.succeeded',owner:transaction.owner_id,
    business:transaction.business_id,transaction:transaction.id,
    provider_payment:input.providerTransactionId,amount_cents:amountCents,
  }));
  const { error: ledgerError } = await admin.rpc('nexora_ledger_post_journal',{
    p_owner_id:transaction.owner_id,p_business_id:transaction.business_id,
    p_transaction_id:transaction.id,p_event_code:'payment.received',
    p_idempotency_key:`provider.payment.succeeded:${operation.provider_code}:${transaction.id}`,
    p_request_hash:requestHash,
    p_description:'Pagamento confirmado pelo provedor; aguardando liquidação e conciliação.',
    p_entries:[
      {account_code:'provider_clearing',side:'debit',amount_cents:amountCents},
      {account_code:'merchant_pending',side:'credit',amount_cents:amountCents},
    ],
    p_metadata:{provider_code:operation.provider_code,provider_event_id:input.eventId,provider_reference:input.providerTransactionId},
  });
  if (ledgerError) throw new Error('ledger_post_failed');
  const { error: confirmError } = await admin.rpc('nexora_provider_confirm_payment_succeeded',{
    p_provider_code:operation.provider_code,
    p_transaction_id:transaction.id,p_provider_transaction_id:input.providerTransactionId,
    p_provider_event_id:input.eventId,
  });
  if (confirmError) throw new Error('payment_confirmation_failed');
  return { outcome:'posted_pending' as const,transactionId:transaction.id };
}

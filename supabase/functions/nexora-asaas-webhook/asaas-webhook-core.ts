import { normalizeAsaasPaymentStatus } from '../_shared/asaas-config.ts';
import { decryptProviderCredential } from '../_shared/provider-credentials.ts';
import { persistProviderPaymentStatusEvent } from '../_shared/payment-status-events.ts';

const encoder = new TextEncoder();
type Credential = { apiKey: string; environment: 'production' };

async function digest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function asaasRequest(credential: Credential, paymentId: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    return await fetch('https://api.asaas.com/v3/payments/' + encodeURIComponent(paymentId), {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', access_token: credential.apiKey, 'User-Agent': 'NexoraPay/1.0 (production)' },
    });
  } finally { clearTimeout(timer); }
}

function trustedInvoiceUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'asaas.com' || url.hostname.endsWith('.asaas.com')) ? url.toString() : null;
  } catch { return null; }
}

type VerifiedAsaasPayment = {
  outcome: 'verified';
  operation: Record<string, any>;
  transaction: Record<string, any>;
  payment: Record<string, any>;
  providerPaymentId: string;
  neutralAttempt?: Record<string, any>;
} | { outcome: 'ignored_unmatched' | 'ignored_nonproduction' };

async function verifyAsaasPaymentNotice(admin: any, paymentNotice: Record<string, unknown>): Promise<VerifiedAsaasPayment> {
  const providerPaymentId = String(paymentNotice.id || '');
  const externalReference = String(paymentNotice.externalReference || '');
  if (!providerPaymentId || providerPaymentId.length > 255 || !externalReference || externalReference.length > 255) {
    throw new Error('webhook_payment_reference_invalid');
  }

  const { data: neutralOperation, error: neutralOperationError } = await admin.from('nexora_provider_payment_operations')
    .select('id,business_id,owner_id,transaction_id,external_reference,provider_transaction_id,environment,acquirer_id,provider_code')
    .eq('provider_code','asaas_production').eq('environment','production')
    .eq('external_reference',externalReference).maybeSingle();
  if(neutralOperationError) throw new Error('webhook_operation_lookup_failed');
  let operation:Record<string,any>|null=null,neutralAttempt:Record<string,any>|undefined;
  if(neutralOperation) {
    const {data:attempt,error:attemptError}=await admin.from('nexora_payment_attempts')
      .select('id,transaction_id,business_id,owner_id,acquirer_id,provider_operation_id,platform_credential_id,provider_code,environment,external_reference,provider_transaction_id,status')
      .eq('provider_operation_id',neutralOperation.id).maybeSingle();
    if(attemptError) throw new Error('webhook_operation_lookup_failed');
    if(attempt) {
      const {data:credentialRow,error:credentialError}=await admin.from('nexora_platform_provider_credentials')
        .select('api_key_ciphertext').eq('id',attempt.platform_credential_id).maybeSingle();
      if(credentialError||!credentialRow?.api_key_ciphertext) throw new Error('webhook_credential_lookup_failed');
      operation={...neutralOperation,provider_reference:attempt.provider_transaction_id,
        api_key_ciphertext:credentialRow.api_key_ciphertext,provider_neutral:true};
      neutralAttempt=attempt;
    }
  }
  if(!operation) {
    const { data: legacyOperation, error: operationError } = await admin.from('nexora_asaas_sandbox_operations')
    .select('id,business_id,owner_id,transaction_id,external_reference,provider_reference,environment,acquirer_id,api_key_ciphertext')
    .eq('external_reference', externalReference).maybeSingle();
    if (operationError) throw new Error('webhook_operation_lookup_failed');
    operation=legacyOperation;
  }
  if (!operation) return { outcome: 'ignored_unmatched' };
  if (!operation.transaction_id || !operation.api_key_ciphertext || operation.environment !== 'production') {
    return { outcome: 'ignored_nonproduction' };
  }

  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!encryptionSecret) throw new Error('webhook_encryption_not_configured');
  const credential: Credential = {
    apiKey: await decryptProviderCredential(operation.api_key_ciphertext, encryptionSecret),
    environment: 'production',
  };
  if (!credential.apiKey.startsWith('$aact_prod_')) throw new Error('stored_key_environment_mismatch');

  const response = await asaasRequest(credential, providerPaymentId);
  const payment = await response.json().catch(() => ({}));
  if (!response.ok || !payment?.id) throw new Error('provider_payment_verification_failed');
  const { data: transaction, error: transactionError } = await admin.from('nexora_transactions')
    .select('id,owner_id,business_id,amount,test_mode').eq('id', operation.transaction_id).maybeSingle();
  if (transactionError || !transaction || transaction.owner_id !== operation.owner_id
    || transaction.business_id !== operation.business_id || transaction.test_mode) {
    throw new Error('webhook_transaction_identity_failed');
  }
  if (payment.id !== providerPaymentId || payment.externalReference !== operation.external_reference
    || payment.billingType !== 'PIX' || typeof payment.status !== 'string'
    || !Number.isFinite(Number(payment.value))
    || Math.round(Number(payment.value) * 100) !== Math.round(Number(transaction.amount) * 100)
    || (operation.provider_reference && operation.provider_reference !== providerPaymentId)) {
    throw new Error('provider_payment_identity_mismatch');
  }
  if(neutralAttempt&&(neutralAttempt.transaction_id!==operation.transaction_id
    ||neutralAttempt.business_id!==operation.business_id||neutralAttempt.owner_id!==operation.owner_id
    ||neutralAttempt.acquirer_id!==operation.acquirer_id||neutralAttempt.external_reference!==operation.external_reference
    ||neutralAttempt.provider_code!=='asaas_production'||neutralAttempt.environment!=='production')) {
    throw new Error('webhook_attempt_identity_failed');
  }
  return { outcome: 'verified', operation, transaction, payment, providerPaymentId, neutralAttempt };
}

async function saveNeutralAsaasWebhookPayment(admin:any,verified:Extract<VerifiedAsaasPayment,{outcome:'verified'}>) {
  const attempt=verified.neutralAttempt;
  if(!attempt) return;
  const {error}=await admin.rpc('nexora_provider_save_charge_result',{
    p_attempt_id:attempt.id,p_provider_transaction_id:verified.providerPaymentId,
    p_raw_status:String(verified.payment.status).slice(0,80),
    p_normalized_status:normalizeAsaasPaymentStatus(verified.payment.status),
    p_pix_copy_paste:null,p_pix_encoded_image:null,
    p_checkout_url:trustedInvoiceUrl(verified.payment.invoiceUrl),p_expires_at:null,
  });
  if(error) throw new Error('payment_persistence_failed');
}

async function persistNormalizedStatusEvent(
  admin: any,
  eventId: string,
  eventType: string,
  verified: Extract<VerifiedAsaasPayment, { outcome: 'verified' }>,
  normalizedStatus: ReturnType<typeof normalizeAsaasPaymentStatus>,
) {
  const { data: providerOperation, error: operationError } = await admin.from('nexora_provider_payment_operations')
    .select('id,provider_code,provider_transaction_id')
    .eq('transaction_id', verified.transaction.id)
    .eq('acquirer_id', verified.operation.acquirer_id)
    .eq('environment', 'production')
    .eq('external_reference', verified.operation.external_reference)
    .maybeSingle();
  if (operationError || !providerOperation
    || providerOperation.provider_transaction_id !== verified.providerPaymentId) {
    throw new Error('provider_operation_status_link_failed');
  }

  const row = {
    provider_code: providerOperation.provider_code,
    provider_event_id: eventId,
    provider_event_type: eventType,
    provider_operation_id: providerOperation.id,
    transaction_id: verified.transaction.id,
    provider_transaction_id: verified.providerPaymentId,
    raw_provider_status: String(verified.payment.status).slice(0, 80),
    normalized_status: normalizedStatus,
    status_checked_at: new Date().toISOString(),
  };
  return persistProviderPaymentStatusEvent(admin, row);
}

export async function processAsaasPaymentStatusNotice(
  admin: any,
  eventId: string,
  eventType: string,
  paymentNotice: Record<string, unknown>,
) {
  const verified = await verifyAsaasPaymentNotice(admin, paymentNotice);
  if (verified.outcome !== 'verified') return verified;

  const status = normalizeAsaasPaymentStatus(verified.payment.status);
  // A provider GET may reveal that a non-receipt notification raced with the
  // actual receipt event. Only the exact, server-verified RECEIVED state can
  // post the idempotent pending-ledger credit.
  if (status === 'SUCCEEDED') {
    return processAsaasPaymentReceived(admin, eventId, paymentNotice, eventType);
  }
  if(verified.neutralAttempt) await saveNeutralAsaasWebhookPayment(admin,verified);
  await persistNormalizedStatusEvent(admin, eventId, eventType, verified, status);
  return { outcome: 'status_recorded' as const, transactionId: verified.transaction.id, status };
}

export async function processAsaasPaymentReceived(
  admin: any,
  eventId: string,
  paymentNotice: Record<string, unknown>,
  eventType = 'PAYMENT_RECEIVED',
) {
  const verified = await verifyAsaasPaymentNotice(admin, paymentNotice);
  if (verified.outcome !== 'verified') return verified;
  const { operation, transaction, payment, providerPaymentId } = verified;
  if (payment.status !== 'RECEIVED') throw new Error('provider_payment_not_received');

  if(verified.neutralAttempt) {
    await saveNeutralAsaasWebhookPayment(admin,verified);
    const statusEvent=await persistNormalizedStatusEvent(
      admin,eventId,eventType,verified,normalizeAsaasPaymentStatus(payment.status),
    );
    if(statusEvent.normalizedStatus!=='SUCCEEDED') {
      return {outcome:'status_recorded' as const,transactionId:transaction.id,status:statusEvent.normalizedStatus};
    }
    const requestHash=await digest(JSON.stringify({
      provider:operation.provider_code,event:'payment.succeeded',owner:transaction.owner_id,
      business:transaction.business_id,transaction:transaction.id,
      provider_payment:providerPaymentId,amount_cents:Math.round(Number(transaction.amount)*100),
    }));
    const amountCents=Math.round(Number(transaction.amount)*100);
    if(!Number.isSafeInteger(amountCents)||amountCents<=0) throw new Error('ledger_amount_invalid');
    const {error:ledgerError}=await admin.rpc('nexora_ledger_post_journal',{
      p_owner_id:transaction.owner_id,p_business_id:transaction.business_id,
      p_transaction_id:transaction.id,p_event_code:'payment.received',
      p_idempotency_key:`provider.payment.succeeded:${operation.provider_code}:${transaction.id}`,
      p_request_hash:requestHash,p_description:'Pagamento confirmado pelo provedor; aguardando liquidação e conciliação.',
      p_entries:[
        {account_code:'provider_clearing',side:'debit',amount_cents:amountCents},
        {account_code:'merchant_pending',side:'credit',amount_cents:amountCents},
      ],p_metadata:{provider_code:operation.provider_code,provider_event_id:eventId,provider_reference:providerPaymentId},
    });
    if(ledgerError) throw new Error('ledger_post_failed');
    const {error:confirmError}=await admin.rpc('nexora_provider_confirm_payment_succeeded',{
      p_provider_code:operation.provider_code,p_transaction_id:transaction.id,
      p_provider_transaction_id:providerPaymentId,p_provider_event_id:eventId,
    });
    if(confirmError) throw new Error('payment_confirmation_failed');
    return {outcome:'posted_pending' as const,transactionId:transaction.id};
  }

  await persistNormalizedStatusEvent(
    admin, eventId, eventType, verified, normalizeAsaasPaymentStatus(payment.status),
  );

  const { error: paymentSaveError } = await admin.rpc('nexora_asaas_complete_charge', {
    p_operation_id: Number(operation.id), p_provider_reference: providerPaymentId,
    p_provider_status: 'RECEIVED', p_transaction_status: 'paid',
    p_invoice_url: trustedInvoiceUrl(payment.invoiceUrl), p_pix_copy_paste: null,
    p_pix_encoded_image: null, p_pix_expiration: null,
  });
  if (paymentSaveError) throw new Error('payment_persistence_failed');

  const amountCents = Math.round(Number(transaction.amount) * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('ledger_amount_invalid');
  const requestHash = await digest(JSON.stringify({
    provider: 'asaas', event: 'payment.received', owner: transaction.owner_id,
    business: transaction.business_id, transaction: transaction.id,
    provider_payment: providerPaymentId, amount_cents: amountCents,
  }));
  const { error: ledgerError } = await admin.rpc('nexora_ledger_post_journal', {
    p_owner_id: transaction.owner_id, p_business_id: transaction.business_id,
    p_transaction_id: transaction.id, p_event_code: 'payment.received',
    p_idempotency_key: `asaas.payment.received:${transaction.id}`,
    p_request_hash: requestHash,
    p_description: 'Pagamento recebido pelo provedor; aguardando liquidação e conciliação.',
    p_entries: [
      { account_code: 'provider_clearing', side: 'debit', amount_cents: amountCents },
      { account_code: 'merchant_pending', side: 'credit', amount_cents: amountCents },
    ],
    p_metadata: { provider_code: 'asaas', provider_event_id: eventId, provider_reference: providerPaymentId },
  });
  if (ledgerError) {
    console.error('asaas_ledger_post_failed', JSON.stringify({ code: ledgerError.code || 'unknown', transaction_id: transaction.id }));
    throw new Error('ledger_post_failed');
  }
  const { error: checkoutLinkError } = await admin.from('nexora_checkout_links')
    .update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('transaction_id', transaction.id).eq('status', 'processing');
  if (checkoutLinkError) {
    console.error('hosted_checkout_confirmation_failed', JSON.stringify({ code: checkoutLinkError.code || 'unknown', transaction_id: transaction.id }));
    throw new Error('checkout_confirmation_persistence_failed');
  }
  const { error: merchantWebhookError } = await admin.rpc('nexora_webhook_enqueue_payment_succeeded', {
    p_transaction_id: transaction.id,
  });
  if (merchantWebhookError) {
    console.error('merchant_webhook_enqueue_failed', JSON.stringify({ code: merchantWebhookError.code || 'unknown', transaction_id: transaction.id }));
    throw new Error('merchant_webhook_enqueue_failed');
  }
  return { outcome: 'posted_pending' as const, transactionId: transaction.id };
}

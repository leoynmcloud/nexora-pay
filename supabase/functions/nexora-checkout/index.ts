import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  asaasBrazilTomorrow,
  asaasRequest,
  fetchAsaasPix,
  findAsaasPayment,
  saveAsaasProviderPayment,
  type AsaasCredential,
} from '../_shared/asaas-payments.ts';
import { assertPaymentIdentity, isDefinitiveAsaasCreateRejection, normalizeAsaasPaymentStatus } from '../_shared/asaas-config.ts';
import { decryptProviderCredential } from '../_shared/provider-credentials.ts';
import { createMercadoPagoCardPayment, createMercadoPagoPixPayment, findMercadoPagoPixPaymentByReference, getMercadoPagoPixPayment, isDefinitiveMercadoPagoCreateRejection, parseMercadoPagoCardInput, type MercadoPagoCardInput } from '../_shared/mercadopago-adapter.ts';
import { createPushinPayPixPayment, getPushinPayTransaction } from '../_shared/pushinpay-adapter.ts';
import { processPushinPayPaymentWebhook } from '../_shared/pushinpay-webhook-core.ts';
import { createOrusPrimePixPayment, getOrusPrimeTransaction, parseOrusPrimeCredentials, type OrusPrimeNormalizedPayment } from '../_shared/orusprime-adapter.ts';
import { processOrusPrimePaymentWebhook } from '../_shared/orusprime-webhook-core.ts';
import { processMercadoPagoPaymentWebhook } from '../_shared/mercadopago-webhook-core.ts';
import { hostedCheckoutAdapter, hostedCheckoutDomains, hostedCheckoutMethods, hostedCheckoutPayerRequirements, isHostedCheckoutUrlTrusted } from '../_shared/hosted-checkout-providers.ts';
import {
  checkoutRequestHash,
  checkoutTokenHash,
  generateCheckoutToken,
  isHostedCheckoutMethodSupported,
  normalizeCheckoutPayer,
} from '../_shared/hosted-checkout.ts';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host === 'nexorapay.me' || host.endsWith('.nexorapay.me')) return true;
    if (host === 'nexorapay-demo.vercel.app' || host.endsWith('.vercel.app')) return true;
    if (host === 'weblybuilds.com' || host.endsWith('.weblybuilds.com')) return true;
    if (host === 'localhost' || host === '127.0.0.1') return true;
  } catch (_) {}
  return false;
}

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Retry-After',
  Vary: 'Origin',
};

function response(request: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  const origin = request.headers.get('origin') || '';
  const headers = {
    ...corsHeaders,
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? (origin || 'https://www.nexorapay.me') : 'https://www.nexorapay.me',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

async function consumePublicCheckoutLimit(admin: any, tokenHash: string, action: 'view' | 'pay') {
  const { data, error } = await admin.rpc('nexora_checkout_consume_public_rate_limit', {
    p_token_hash: tokenHash, p_action: action,
  });
  if (error || typeof data?.allowed !== 'boolean') throw new Error('checkout_rate_limit_unavailable');
  return data as { allowed: boolean; retry_after_seconds: number };
}

async function publicCheckoutTokenHash(value: unknown): Promise<string | null> {
  try { return await checkoutTokenHash(value); }
  catch (error) {
    if (error instanceof Error && error.message === 'checkout_token_invalid') return null;
    throw error;
  }
}

async function wasBlockedBeforeProviderSubmit(admin: any, attemptId: string): Promise<boolean> {
  const { data, error } = await admin.from('nexora_payment_attempts')
    .select('status,last_error_code').eq('id', attemptId).maybeSingle();
  return !error && data?.status === 'failed'
    && ['merchant_not_operable', 'provider_credential_inactive', 'provider_route_changed', 'provider_unavailable'].includes(data.last_error_code);
}

async function readPayload(request: Request) {
  const raw = await readBoundedHttpBody(request, 12_000);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function makeAdmin() {
  const url = Deno.env.get('SUPABASE_URL') || '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !key) throw new Error('server_not_configured');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function markOperation(admin: any, operation: any, status: 'failed' | 'unknown', code: string) {
  if (operation?.operation_id && operation?.lease_token) {
    await admin.rpc('nexora_asaas_fail_operation', {
      p_operation_id: Number(operation.operation_id), p_lease_token: operation.lease_token,
      p_status: status, p_error_code: code,
    });
  }
  if (status === 'failed' && operation?.checkout_link_id) {
    await admin.from('nexora_checkout_links').update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', operation.checkout_link_id).eq('status', 'processing');
  }
}

async function paymentDetails(admin: any, transactionId: string) {
  const { data: directDetails } = await admin.from('nexora_provider_payment_details')
    .select('provider_transaction_id,raw_provider_status,normalized_status,pix_copy_paste,pix_encoded_image,checkout_url,expires_at')
    .eq('transaction_id', transactionId).maybeSingle();
  const { data: tx } = await admin.from('nexora_transactions')
    .select('payment_method').eq('id', transactionId).maybeSingle();
  const method = tx?.payment_method || (directDetails?.pix_copy_paste ? 'pix' : 'credit_card');
  if (directDetails) return {
    provider_reference: directDetails.provider_transaction_id,
    provider_status: directDetails.raw_provider_status,
    status: directDetails.normalized_status,
    pix_copy_paste: directDetails.pix_copy_paste,
    pix_encoded_image: directDetails.pix_encoded_image,
    invoice_url: directDetails.checkout_url,
    pix_expiration: directDetails.expires_at,
    method,
  };
  const { data: attempt } = await admin.from('nexora_payment_attempts')
    .select('provider_operation_id,provider_transaction_id').eq('transaction_id', transactionId).maybeSingle();
  if (attempt?.provider_operation_id) {
    const { data: providerDetails, error: providerDetailsError } = await admin.from('nexora_provider_payment_details')
      .select('provider_transaction_id,raw_provider_status,normalized_status,pix_copy_paste,pix_encoded_image,checkout_url,expires_at')
      .eq('provider_operation_id', attempt.provider_operation_id).maybeSingle();
    if (!providerDetailsError && providerDetails) return {
      provider_reference: providerDetails.provider_transaction_id,
      provider_status: providerDetails.raw_provider_status,
      status: providerDetails.normalized_status,
      pix_copy_paste: providerDetails.pix_copy_paste,
      pix_encoded_image: providerDetails.pix_encoded_image,
      invoice_url: providerDetails.checkout_url,
      pix_expiration: providerDetails.expires_at,
      method,
    };
  }
  const { data, error } = await admin.from('nexora_asaas_sandbox_payment_details')
    .select('provider_reference,provider_status,invoice_url,pix_copy_paste,pix_encoded_image,pix_expiration')
    .eq('transaction_id', transactionId).maybeSingle();
  if (data) return { ...data, method: 'pix' };
  const { data: fallbackAttempt } = await admin.from('nexora_payment_attempts')
    .select('provider_transaction_id,provider_status,payment_method,status')
    .eq('transaction_id', transactionId).maybeSingle();
  if (fallbackAttempt) {
    return {
      provider_reference: fallbackAttempt.provider_transaction_id,
      provider_status: fallbackAttempt.provider_status || fallbackAttempt.status,
      method: fallbackAttempt.payment_method || 'pix',
      status: fallbackAttempt.status,
    };
  }
  return null;
}

async function saveMercadoPagoResult(admin: any, attempt: any, result: Awaited<ReturnType<typeof getMercadoPagoPixPayment>>) {
  const { error } = await admin.rpc('nexora_provider_save_charge_result', {
    p_attempt_id: attempt.attempt_id,
    p_provider_transaction_id: result.providerTransactionId,
    p_raw_status: result.rawStatusCode || result.status,
    p_normalized_status: result.status,
    p_pix_copy_paste: result.pixCopyPaste || null,
    p_pix_encoded_image: result.qrCodeBase64 || null,
    p_checkout_url: result.checkoutUrl || null,
    p_expires_at: result.expiresAt || null,
  });
  if (error) throw new Error('mercadopago_payment_persistence_failed');
  return {
    transaction_id: attempt.transaction_id,
    test_mode: attempt.environment === 'sandbox',
    environment: attempt.environment,
    provider_reference: result.providerTransactionId,
    provider_status: result.rawStatusCode || result.status,
    status: result.status,
    method: attempt.payment_method || (result.pixCopyPaste ? 'pix' : 'credit_card'),
    pix_copy_paste: result.pixCopyPaste || null,
    pix_encoded_image: result.qrCodeBase64 || null,
    invoice_url: result.checkoutUrl || null,
    pix_expiration: result.expiresAt || null,
  };
}

async function recoverMercadoPagoPayment(admin: any, transactionId: string) {
  const { data: attempt, error } = await admin.from('nexora_payment_attempts')
    .select('id,transaction_id,provider_code,environment,external_reference,provider_transaction_id,platform_credential_id,acquirer_id,payment_method')
    .eq('transaction_id', transactionId).maybeSingle();
  if (error || !attempt || !attempt.provider_code?.startsWith('mercadopago_') || attempt.environment !== 'production') return null;
  const { data: credentialRow } = await admin.from('nexora_platform_provider_credentials')
    .select('api_key_ciphertext').eq('id', attempt.platform_credential_id).maybeSingle();
  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!credentialRow?.api_key_ciphertext || !encryptionSecret) return null;
  const accessToken = await decryptProviderCredential(credentialRow.api_key_ciphertext, encryptionSecret);
  if (!accessToken.startsWith('APP_USR-')) throw new Error('stored_key_environment_mismatch');
  const { data: transaction, error: transactionError } = await admin.from('nexora_transactions')
    .select('amount').eq('id', transactionId).maybeSingle();
  if (transactionError || !transaction) return null;
  const result = attempt.provider_transaction_id
    ? await getMercadoPagoPixPayment(accessToken,attempt.provider_transaction_id,
      attempt.external_reference,Math.round(Number(transaction.amount)*100))
    : await findMercadoPagoPixPaymentByReference(accessToken,attempt.external_reference,
      Math.round(Number(transaction.amount)*100));
  if (!result) return null;
  const saved = await saveMercadoPagoResult(admin, { ...attempt, attempt_id: attempt.id }, result);
  if (result.status === 'SUCCEEDED' && result.providerTransactionId) {
    try {
      await processMercadoPagoPaymentWebhook(admin, {
        eventId: `checkout_poll:${result.providerTransactionId}`,
        eventType: 'payment.updated',
        providerTransactionId: result.providerTransactionId,
        accessToken,
      });
    } catch (error) {
      console.error('checkout_recover_confirm_deferred', JSON.stringify({
        code: error instanceof Error ? error.message : 'confirm_failed',
      }));
    }
  }
  return saved;
}

async function recoverNeutralAsaasPaymentByTransaction(admin:any,transactionId:string) {
  const {data:attempt,error}=await admin.from('nexora_payment_attempts')
    .select('id,transaction_id,provider_code,environment,external_reference,provider_transaction_id,platform_credential_id,acquirer_id')
    .eq('transaction_id',transactionId).maybeSingle();
  if(error||!attempt||attempt.provider_code!=='asaas_production'||attempt.environment!=='production') return null;
  const {data:transaction,error:transactionError}=await admin.from('nexora_transactions')
    .select('amount').eq('id',transactionId).maybeSingle();
  if(transactionError||!transaction||!Number.isFinite(Number(transaction.amount))) return null;
  const {data:credentialRow,error:credentialError}=await admin.from('nexora_platform_provider_credentials')
    .select('api_key_ciphertext').eq('id',attempt.platform_credential_id).maybeSingle();
  const encryptionSecret=Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY')||'';
  if(credentialError||!credentialRow?.api_key_ciphertext||!encryptionSecret) return null;
  const credential:AsaasCredential={apiKey:await decryptProviderCredential(credentialRow.api_key_ciphertext,encryptionSecret),environment:'production'};
  if(!credential.apiKey.startsWith('$aact_prod_')) throw new Error('stored_key_environment_mismatch');
  return recoverNeutralAsaasPayment(admin,{...attempt,attempt_id:attempt.id,amount_cents:Math.round(Number(transaction.amount)*100)},credential);
}

async function handleMercadoPagoPublicPayment(
  admin: any, input: Record<string, unknown>, snapshot: Record<string, any>,
  payer: ReturnType<typeof normalizeCheckoutPayer>, tokenHash: string, requestHash: string,
  card?: MercadoPagoCardInput,
) {
  if (!payer.email) return { body: { error: card ? 'Informe seu e-mail para pagar com cartão.' : 'Informe seu e-mail para gerar este Pix.' }, status: 400 };

  let chargeTokenHash = tokenHash;
  let chargeRequestHash = requestHash;
  let orderToken: string | undefined = undefined;

  if (!snapshot.parent_link_id && !snapshot.transaction_id && snapshot.status === 'active') {
    const rawOrderToken = typeof input.order_token === 'string' && input.order_token
      ? String(input.order_token)
      : generateCheckoutToken();
    const orderTokenHash = await publicCheckoutTokenHash(rawOrderToken);
    if (orderTokenHash) {
      let { data: childOrder } = await admin.rpc('nexora_checkout_public_snapshot', { p_token_hash: orderTokenHash });
      if (!childOrder) {
        const { data: spawned, error: spawnError } = await admin.rpc('nexora_checkout_spawn_order', {
          p_parent_token_hash: tokenHash,
          p_order_token_hash: orderTokenHash,
        });
        if (!spawnError && spawned) {
          childOrder = spawned;
        }
      }
      if (childOrder) {
        chargeTokenHash = orderTokenHash;
        chargeRequestHash = await checkoutRequestHash(rawOrderToken, String(childOrder.id), payer);
        orderToken = rawOrderToken;
      }
    }
  }

  const withOrder = (b: Record<string, unknown>) => orderToken ? { ...b, order_token: orderToken } : b;

  const { data: attempt, error } = await admin.rpc('nexora_checkout_public_begin_charge', {
    p_token_hash: chargeTokenHash, p_request_hash: chargeRequestHash,
    p_payer_name: payer.name, p_payer_email: payer.email, p_payer_document: payer.document,
  });
  if (error || !attempt) return { body: withOrder({ error: 'Não foi possível iniciar o pagamento. Atualize a página ou fale com o lojista.' }), status: 409 };
  if (!attempt.provider_code?.startsWith('mercadopago_') || attempt.environment !== 'production') {
    return { body: withOrder({ error: 'Este adquirente ainda não está habilitado para este checkout.' }), status: 409 };
  }
  if (['paid','expired','canceled'].includes(String(attempt.status))) {
    return { body: withOrder({ error: 'Este link não está disponível para pagamento.', status: attempt.status }), status: 409 };
  }
  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!encryptionSecret) throw new Error('checkout_encryption_not_configured');
  const accessToken = await decryptProviderCredential(String(attempt.api_key_ciphertext || ''), encryptionSecret);
  if (!accessToken.startsWith('APP_USR-')) throw new Error('stored_key_environment_mismatch');

  if (attempt.provider_transaction_id && !card && attempt.status !== 'failed') {
    const result = await getMercadoPagoPixPayment(accessToken,String(attempt.provider_transaction_id),
      String(attempt.external_reference),Number(snapshot.amount_cents));
    const payment = await saveMercadoPagoResult(admin,attempt,result);
    if (['FAILED', 'CANCELED'].includes(String(result.status))) {
      return { body: withOrder({ error: 'A cobrança Pix não foi autorizada pelo adquirente. Verifique os dados ou utilize outro meio de pagamento.', status: 'failed', payment }), status: 422 };
    }
    return { body: withOrder({ status: 'processing', payment }), status: 200 };
  }
  if (attempt.should_submit !== true) {
    try {
      const recovered = await findMercadoPagoPixPaymentByReference(accessToken,
        String(attempt.external_reference),Number(snapshot.amount_cents));
      if (recovered) {
        const payment = await saveMercadoPagoResult(admin,attempt,recovered);
        return { body: withOrder({ status: 'processing', payment }), status: 200 };
      }
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
        ? error.message : 'mercadopago_payment_recovery_failed';
      console.error('mercadopago_checkout_search_deferred',JSON.stringify({ attempt_id: attempt.attempt_id, code }));
    }
    return { body: withOrder({ status: 'processing', message: 'Estamos confirmando o pagamento com o adquirente. Não tente pagar novamente.' }), status: 202 };
  }

  const { data: ledgerAccount, error: ledgerAccountError } = await admin.from('nexora_ledger_accounts')
    .select('id').eq('business_id',attempt.business_id).eq('owner_id',attempt.owner_id)
    .eq('account_code','merchant_pending').maybeSingle();
  if (ledgerAccountError || !ledgerAccount?.id) {
    return { body: withOrder({ error: 'A conta financeira do lojista ainda não está pronta para pagamentos.' }), status: 409 };
  }
  const { data: claimed, error: claimError } = await admin.rpc('nexora_provider_mark_payment_attempt_started', {
    p_attempt_id: attempt.attempt_id, p_lease_token: attempt.lease_token,
  });
  if (!claimError && claimed !== true && await wasBlockedBeforeProviderSubmit(admin, String(attempt.attempt_id))) {
    return { body: withOrder({ error: 'As condições de recebimento mudaram; este pagamento não foi enviado. Peça ao lojista um novo link.' }), status: 409 };
  }
  if (claimError || claimed !== true) {
    return { body: withOrder({ status: 'processing', message: 'Estamos confirmando a tentativa. Não tente pagar novamente.' }), status: 202 };
  }
  try {
    const chargeRequest = {
      amountCents: Number(snapshot.amount_cents), currency: 'BRL' as const,
      internalTransactionId: String(attempt.external_reference),
      idempotencyKey: card ? `${attempt.attempt_id}_${card.token.slice(0, 16)}` : String(attempt.attempt_id),
      merchantRoute: { businessId: String(attempt.business_id), ledgerAccountId: String(ledgerAccount.id), settlementModel: 'platform_balance' as const },
      paymentMethod: card ? 'credit_card' as const : 'pix' as const, description: String(snapshot.description),
      customer: { name: payer.name, email: payer.email, document: payer.document },
    };
    const result = card
      ? await createMercadoPagoCardPayment(accessToken,Deno.env.get('SUPABASE_URL') || '',chargeRequest,card)
      : await createMercadoPagoPixPayment(accessToken,Deno.env.get('SUPABASE_URL') || '',chargeRequest);
    const payment = await saveMercadoPagoResult(admin,attempt,result);
    if (card && result.status === 'SUCCEEDED') {
      try {
        await processMercadoPagoPaymentWebhook(admin, {
          eventId: `checkout_card:${result.providerTransactionId}`, eventType: 'payment.created',
          providerTransactionId: result.providerTransactionId, accessToken,
        });
      } catch (confirmError) {
        console.error('checkout_card_confirm_deferred', JSON.stringify({ code: confirmError instanceof Error ? confirmError.message : 'confirm_failed' }));
      }
      return { body: withOrder({ status: 'paid', payment: { ...payment, method: 'credit_card', installments: card.installments } }), status: 200 };
    }
    if (['FAILED', 'CANCELED'].includes(String(result.status))) {
      const error = card
        ? 'Pagamento recusado pelo emissor do cartão. Tente outro cartão de crédito ou pague via Pix instantâneo.'
        : 'A criação do Pix foi recusada pelo adquirente ou banco emissor. Verifique os dados ou utilize outro meio de pagamento.';
      return { body: withOrder({ error, status: 'failed', code: card ? 'card_declined' : 'pix_declined', payment: { ...payment, method: card ? 'credit_card' : 'pix' } }), status: 200 };
    }
    return { body: withOrder({ status: 'processing', payment: { ...payment, method: card ? 'credit_card' : 'pix' } }), status: 200 };
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
      ? error.message : 'mercadopago_response_uncertain';
    if (isDefinitiveMercadoPagoCreateRejection(code)) {
      const { data: failed, error: failError } = await admin.rpc('nexora_provider_fail_charge_attempt', {
        p_attempt_id: attempt.attempt_id, p_lease_token: attempt.lease_token, p_error_code: code,
      });
      if (!failError && failed === true) {
        return { body: withOrder({ error: 'O adquirente recusou a cobrança. Solicite um novo link ao lojista antes de tentar novamente.' }), status: 422 };
      }
      console.error('mercadopago_rejection_persistence_failed', JSON.stringify({ attempt_id: attempt.attempt_id, code: failError?.code || 'unknown' }));
    }
    console.error('mercadopago_checkout_attempt_unresolved',JSON.stringify({ attempt_id: attempt.attempt_id, code }));
    return { body: withOrder({ status: 'processing', message: 'Estamos confirmando o pagamento com o adquirente. Não tente pagar novamente.' }), status: 202 };
  }
}

async function savePushinPayResult(admin: any, attempt: any, result: Awaited<ReturnType<typeof createPushinPayPixPayment>>) {
  const { error } = await admin.rpc('nexora_provider_save_charge_result', {
    p_attempt_id: attempt.attempt_id || attempt.id,
    p_provider_transaction_id: result.providerTransactionId,
    p_raw_status: result.rawStatusCode || result.status,
    p_normalized_status: result.status,
    p_pix_copy_paste: result.pixCopyPaste || null,
    p_pix_encoded_image: result.qrCodeBase64 || null,
    p_checkout_url: result.checkoutUrl || null,
    p_expires_at: result.expiresAt || null,
  });
  if (error) throw new Error('pushinpay_payment_persistence_failed');
  return {
    transaction_id: attempt.transaction_id,
    test_mode: attempt.environment === 'sandbox',
    environment: attempt.environment,
    provider_reference: result.providerTransactionId,
    provider_status: result.rawStatusCode || result.status,
    status: result.status,
    method: 'pix',
    pix_copy_paste: result.pixCopyPaste || null,
    pix_encoded_image: result.qrCodeBase64 || null,
    invoice_url: result.checkoutUrl || null,
    pix_expiration: result.expiresAt || null,
  };
}

async function recoverPushinPayPayment(admin: any, transactionId: string) {
  const { data: attempt, error } = await admin.from('nexora_payment_attempts')
    .select('id,transaction_id,provider_code,environment,external_reference,provider_transaction_id,platform_credential_id,acquirer_id,payment_method')
    .eq('transaction_id', transactionId).maybeSingle();
  if (error || !attempt || attempt.provider_code !== 'pushinpay_production' || attempt.environment !== 'production') return null;
  const { data: credentialRow } = await admin.from('nexora_platform_provider_credentials')
    .select('api_key_ciphertext').eq('id', attempt.platform_credential_id).maybeSingle();
  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!credentialRow?.api_key_ciphertext || !encryptionSecret) return null;
  const apiKey = await decryptProviderCredential(credentialRow.api_key_ciphertext, encryptionSecret);
  if (!apiKey) throw new Error('pushinpay_credential_missing');
  if (!attempt.provider_transaction_id) return null;

  const result = await getPushinPayTransaction(apiKey, String(attempt.provider_transaction_id));
  if (!result) return null;
  const saved = await savePushinPayResult(admin, { ...attempt, attempt_id: attempt.id }, result);
  if (result.status === 'SUCCEEDED' && result.providerTransactionId) {
    try {
      await processPushinPayPaymentWebhook(admin, {
        eventId: `checkout_poll:${result.providerTransactionId}`,
        providerTransactionId: result.providerTransactionId,
        apiKey,
      });
    } catch (err) {
      console.error('checkout_recover_pushinpay_confirm_deferred', JSON.stringify({
        code: err instanceof Error ? err.message : 'confirm_failed',
      }));
    }
  }
  return saved;
}

async function handlePushinPayPublicPayment(
  admin: any, input: Record<string, unknown>, snapshot: Record<string, any>,
  payer: ReturnType<typeof normalizeCheckoutPayer>, tokenHash: string, requestHash: string,
) {
  let chargeTokenHash = tokenHash;
  let chargeRequestHash = requestHash;
  let orderToken: string | undefined = undefined;

  if (!snapshot.parent_link_id && !snapshot.transaction_id && snapshot.status === 'active') {
    const rawOrderToken = typeof input.order_token === 'string' && input.order_token
      ? String(input.order_token)
      : generateCheckoutToken();
    const orderTokenHash = await publicCheckoutTokenHash(rawOrderToken);
    if (orderTokenHash) {
      let { data: childOrder } = await admin.rpc('nexora_checkout_public_snapshot', { p_token_hash: orderTokenHash });
      if (!childOrder) {
        const { data: spawned, error: spawnError } = await admin.rpc('nexora_checkout_spawn_order', {
          p_parent_token_hash: tokenHash,
          p_order_token_hash: orderTokenHash,
        });
        if (!spawnError && spawned) {
          childOrder = spawned;
        }
      }
      if (childOrder) {
        chargeTokenHash = orderTokenHash;
        chargeRequestHash = await checkoutRequestHash(rawOrderToken, String(childOrder.id), payer);
        orderToken = rawOrderToken;
      }
    }
  }

  const withOrder = (b: Record<string, unknown>) => orderToken ? { ...b, order_token: orderToken } : b;

  const { data: attempt, error } = await admin.rpc('nexora_checkout_public_begin_charge', {
    p_token_hash: chargeTokenHash, p_request_hash: chargeRequestHash,
    p_payer_name: payer.name, p_payer_email: payer.email, p_payer_document: payer.document,
  });
  if (error || !attempt) return { body: withOrder({ error: 'Não foi possível iniciar o pagamento. Atualize a página ou fale com o lojista.' }), status: 409 };
  if (attempt.provider_code !== 'pushinpay_production' || attempt.environment !== 'production') {
    return { body: withOrder({ error: 'Este adquirente ainda não está habilitado para este checkout.' }), status: 409 };
  }
  if (['paid','expired','canceled'].includes(String(attempt.status))) {
    return { body: withOrder({ error: 'Este link não está disponível para pagamento.', status: attempt.status }), status: 409 };
  }
  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!encryptionSecret) throw new Error('checkout_encryption_not_configured');
  const apiKey = await decryptProviderCredential(String(attempt.api_key_ciphertext || ''), encryptionSecret);
  if (!apiKey) throw new Error('pushinpay_credential_missing');

  if (attempt.provider_transaction_id && attempt.status !== 'failed') {
    const result = await getPushinPayTransaction(apiKey, String(attempt.provider_transaction_id));
    const payment = await savePushinPayResult(admin, attempt, result);
    if (['FAILED', 'CANCELED'].includes(String(result.status))) {
      return { body: withOrder({ error: 'A cobrança Pix não foi autorizada pelo adquirente. Verifique os dados ou utilize outro meio de pagamento.', status: 'failed', payment }), status: 422 };
    }
    return { body: withOrder({ status: 'processing', payment }), status: 200 };
  }

  if (attempt.should_submit !== true) {
    return { body: withOrder({ status: 'processing', message: 'Estamos confirmando o pagamento com o adquirente. Não tente pagar novamente.' }), status: 202 };
  }

  const { data: ledgerAccount, error: ledgerAccountError } = await admin.from('nexora_ledger_accounts')
    .select('id').eq('business_id', attempt.business_id).eq('owner_id', attempt.owner_id)
    .eq('account_code', 'merchant_pending').maybeSingle();
  if (ledgerAccountError || !ledgerAccount?.id) {
    return { body: withOrder({ error: 'A conta financeira do lojista ainda não está pronta para pagamentos.' }), status: 409 };
  }
  const { data: claimed, error: claimError } = await admin.rpc('nexora_provider_mark_payment_attempt_started', {
    p_attempt_id: attempt.attempt_id, p_lease_token: attempt.lease_token,
  });
  if (!claimError && claimed !== true && await wasBlockedBeforeProviderSubmit(admin, String(attempt.attempt_id))) {
    return { body: withOrder({ error: 'As condições de recebimento mudaram; este pagamento não foi enviado. Peça ao lojista um novo link.' }), status: 409 };
  }
  if (claimError || claimed !== true) {
    return { body: withOrder({ status: 'processing', message: 'Estamos confirmando a tentativa. Não tente pagar novamente.' }), status: 202 };
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const webhookUrl = supabaseUrl ? `${supabaseUrl.replace(/\/$/, '')}/functions/v1/nexora-pushinpay-webhook` : undefined;
    const result = await createPushinPayPixPayment(apiKey, {
      valueCents: Number(snapshot.amount_cents),
      webhookUrl,
    });
    const payment = await savePushinPayResult(admin, attempt, result);
    return { body: withOrder({ status: 'processing', payment: { ...payment, method: 'pix' } }), status: 200 };
  } catch (err) {
    const code = err instanceof Error && /^[a-z0-9_]{1,80}$/.test(err.message)
      ? err.message : 'pushinpay_response_uncertain';
    console.error('pushinpay_checkout_attempt_failed', JSON.stringify({ attempt_id: attempt.attempt_id, code }));
    const { data: failed, error: failError } = await admin.rpc('nexora_provider_fail_charge_attempt', {
      p_attempt_id: attempt.attempt_id, p_lease_token: attempt.lease_token, p_error_code: code,
    });
    if (!failError && failed === true) {
      return { body: withOrder({ error: 'O adquirente Pushin Pay recusou a cobrança. Solicite um novo link ao lojista antes de tentar novamente.' }), status: 422 };
    }
    return { body: withOrder({ status: 'processing', message: 'Estamos confirmando o pagamento com o adquirente. Não tente pagar novamente.' }), status: 202 };
  }
}

async function saveOrusPrimeResult(admin: any, attempt: any, result: OrusPrimeNormalizedPayment) {
  const { error } = await admin.rpc('nexora_provider_save_charge_result', {
    p_attempt_id: attempt.attempt_id || attempt.id,
    p_provider_transaction_id: result.providerTransactionId,
    p_raw_status: result.rawStatusCode || result.status,
    p_normalized_status: result.status,
    p_pix_copy_paste: result.pixCopyPaste || null,
    p_pix_encoded_image: result.qrCodeImage || null,
    p_checkout_url: result.checkoutUrl || null,
    p_expires_at: result.expiresAt || null,
  });
  if (error) throw new Error('orusprime_payment_persistence_failed');
  return {
    transaction_id: attempt.transaction_id,
    test_mode: attempt.environment === 'sandbox',
    environment: attempt.environment,
    provider_reference: result.providerTransactionId,
    provider_status: result.rawStatusCode || result.status,
    status: result.status,
    method: 'pix',
    pix_copy_paste: result.pixCopyPaste || null,
    pix_encoded_image: result.qrCodeImage || null,
    invoice_url: result.checkoutUrl || null,
    pix_expiration: result.expiresAt || null,
  };
}

async function recoverOrusPrimePayment(admin: any, transactionId: string) {
  const { data: attempt, error } = await admin.from('nexora_payment_attempts')
    .select('id,transaction_id,provider_code,environment,external_reference,provider_transaction_id,platform_credential_id,acquirer_id,payment_method')
    .eq('transaction_id', transactionId).maybeSingle();
  if (error || !attempt || attempt.provider_code !== 'orusprime_production' || attempt.environment !== 'production') return null;
  const { data: credentialRow } = await admin.from('nexora_platform_provider_credentials')
    .select('api_key_ciphertext').eq('id', attempt.platform_credential_id).maybeSingle();
  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!credentialRow?.api_key_ciphertext || !encryptionSecret) return null;
  const rawCreds = await decryptProviderCredential(credentialRow.api_key_ciphertext, encryptionSecret);
  if (!rawCreds) throw new Error('orusprime_credential_missing');
  const credentials = parseOrusPrimeCredentials(rawCreds);
  if (!attempt.provider_transaction_id) return null;

  const result = await getOrusPrimeTransaction(credentials, String(attempt.provider_transaction_id));
  if (!result) return null;
  const saved = await saveOrusPrimeResult(admin, { ...attempt, attempt_id: attempt.id }, result);
  if (result.status === 'SUCCEEDED' && result.providerTransactionId) {
    try {
      await processOrusPrimePaymentWebhook(admin, {
        eventId: `checkout_poll:${result.providerTransactionId}`,
        providerTransactionId: result.providerTransactionId,
        credentials,
      });
    } catch (err) {
      console.error('checkout_recover_orusprime_confirm_deferred', JSON.stringify({
        code: err instanceof Error ? err.message : 'confirm_failed',
      }));
    }
  }
  return saved;
}

async function handleOrusPrimePublicPayment(
  admin: any, input: Record<string, unknown>, snapshot: Record<string, any>,
  payer: ReturnType<typeof normalizeCheckoutPayer>, tokenHash: string, requestHash: string,
) {
  let chargeTokenHash = tokenHash;
  let chargeRequestHash = requestHash;
  let orderToken: string | undefined = undefined;

  if (!snapshot.parent_link_id && !snapshot.transaction_id && snapshot.status === 'active') {
    const rawOrderToken = typeof input.order_token === 'string' && input.order_token
      ? String(input.order_token)
      : generateCheckoutToken();
    const orderTokenHash = await publicCheckoutTokenHash(rawOrderToken);
    if (orderTokenHash) {
      let { data: childOrder } = await admin.rpc('nexora_checkout_public_snapshot', { p_token_hash: orderTokenHash });
      if (!childOrder) {
        const { data: spawned, error: spawnError } = await admin.rpc('nexora_checkout_spawn_order', {
          p_parent_token_hash: tokenHash,
          p_order_token_hash: orderTokenHash,
        });
        if (!spawnError && spawned) {
          childOrder = spawned;
        }
      }
      if (childOrder) {
        chargeTokenHash = orderTokenHash;
        chargeRequestHash = await checkoutRequestHash(rawOrderToken, String(childOrder.id), payer);
        orderToken = rawOrderToken;
      }
    }
  }

  const withOrder = (b: Record<string, unknown>) => orderToken ? { ...b, order_token: orderToken } : b;

  const { data: attempt, error } = await admin.rpc('nexora_checkout_public_begin_charge', {
    p_token_hash: chargeTokenHash, p_request_hash: chargeRequestHash,
    p_payer_name: payer.name, p_payer_email: payer.email, p_payer_document: payer.document,
  });
  if (error || !attempt) return { body: withOrder({ error: 'Não foi possível iniciar o pagamento. Atualize a página ou fale com o lojista.' }), status: 409 };
  if (attempt.provider_code !== 'orusprime_production' || attempt.environment !== 'production') {
    return { body: withOrder({ error: 'Este adquirente ainda não está habilitado para este checkout.' }), status: 409 };
  }
  if (['paid','expired','canceled'].includes(String(attempt.status))) {
    return { body: withOrder({ error: 'Este link não está disponível para pagamento.', status: attempt.status }), status: 409 };
  }
  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!encryptionSecret) throw new Error('checkout_encryption_not_configured');
  const rawCreds = await decryptProviderCredential(String(attempt.api_key_ciphertext || ''), encryptionSecret);
  if (!rawCreds) throw new Error('orusprime_credential_missing');
  const credentials = parseOrusPrimeCredentials(rawCreds);

  if (attempt.provider_transaction_id && attempt.status !== 'failed') {
    const result = await getOrusPrimeTransaction(credentials, String(attempt.provider_transaction_id));
    const payment = await saveOrusPrimeResult(admin, attempt, result);
    if (['FAILED', 'CANCELED'].includes(String(result.status))) {
      return { body: withOrder({ error: 'A cobrança Pix não foi autorizada pelo adquirente. Verifique os dados ou utilize outro meio de pagamento.', status: 'failed', payment }), status: 422 };
    }
    return { body: withOrder({ status: 'processing', payment }), status: 200 };
  }

  if (attempt.should_submit !== true) {
    return { body: withOrder({ status: 'processing', message: 'Estamos confirmando o pagamento com o adquirente. Não tente pagar novamente.' }), status: 202 };
  }

  const { data: ledgerAccount, error: ledgerAccountError } = await admin.from('nexora_ledger_accounts')
    .select('id').eq('business_id', attempt.business_id).eq('owner_id', attempt.owner_id)
    .eq('account_code', 'merchant_pending').maybeSingle();
  if (ledgerAccountError || !ledgerAccount?.id) {
    return { body: withOrder({ error: 'A conta financeira do lojista ainda não está pronta para pagamentos.' }), status: 409 };
  }
  const { data: claimed, error: claimError } = await admin.rpc('nexora_provider_mark_payment_attempt_started', {
    p_attempt_id: attempt.attempt_id, p_lease_token: attempt.lease_token,
  });
  if (!claimError && claimed !== true && await wasBlockedBeforeProviderSubmit(admin, String(attempt.attempt_id))) {
    return { body: withOrder({ error: 'As condições de recebimento mudaram; este pagamento não foi enviado. Peça ao lojista um novo link.' }), status: 409 };
  }
  if (claimError || claimed !== true) {
    return { body: withOrder({ status: 'processing', message: 'Estamos confirmando a tentativa. Não tente pagar novamente.' }), status: 202 };
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const webhookUrl = supabaseUrl ? `${supabaseUrl.replace(/\/$/, '')}/functions/v1/nexora-orusprime-webhook` : undefined;
    const result = await createOrusPrimePixPayment(credentials, {
      identifier: String(attempt.external_reference),
      valueCents: Number(snapshot.amount_cents),
      client: {
        name: payer.name || 'Cliente Nexora',
        email: payer.email || 'cliente@nexorapay.me',
        document: payer.document || undefined,
      },
      callbackUrl: webhookUrl,
      metadata: {
        attempt_id: String(attempt.attempt_id),
        business_id: String(attempt.business_id),
      },
    });
    const payment = await saveOrusPrimeResult(admin, attempt, result);
    return { body: withOrder({ status: 'processing', payment: { ...payment, method: 'pix' } }), status: 200 };
  } catch (err) {
    const code = err instanceof Error && /^[a-z0-9_]{1,80}$/.test(err.message)
      ? err.message : 'orusprime_response_uncertain';
    console.error('orusprime_checkout_attempt_failed', JSON.stringify({ attempt_id: attempt.attempt_id, code }));
    const { data: failed, error: failError } = await admin.rpc('nexora_provider_fail_charge_attempt', {
      p_attempt_id: attempt.attempt_id, p_lease_token: attempt.lease_token, p_error_code: code,
    });
    if (!failError && failed === true) {
      return { body: withOrder({ error: 'O adquirente Orus Prime recusou a cobrança. Solicite um novo link ao lojista antes de tentar novamente.' }), status: 422 };
    }
    return { body: withOrder({ status: 'processing', message: 'Estamos confirmando o pagamento com o adquirente. Não tente pagar novamente.' }), status: 202 };
  }
}

function trustedAsaasInvoiceUrl(value: unknown) {
  return isHostedCheckoutUrlTrusted('asaas_production', value);
}

async function saveNeutralAsaasPayment(admin: any, attempt: any, payment: Record<string, unknown>, credential: AsaasCredential) {
  assertPaymentIdentity(payment,{
    external_reference:String(attempt.external_reference),
    provider_reference:attempt.provider_transaction_id||null,
    amount:Number(attempt.amount_cents)/100,
  });
  const providerTransactionId=String(payment.id);
  const rawStatus=String(payment.status||'PENDING').slice(0,80);
  const normalizedStatus=normalizeAsaasPaymentStatus(rawStatus);
  const pix=await fetchAsaasPix(credential,providerTransactionId);
  const invoiceUrl=trustedAsaasInvoiceUrl(payment.invoiceUrl);
  const {error}=await admin.rpc('nexora_provider_save_charge_result',{
    p_attempt_id:attempt.attempt_id,p_provider_transaction_id:providerTransactionId,
    p_raw_status:rawStatus,p_normalized_status:normalizedStatus,
    p_pix_copy_paste:pix.pix_copy_paste||null,p_pix_encoded_image:pix.pix_encoded_image||null,
    p_checkout_url:invoiceUrl,p_expires_at:pix.pix_expiration||null,
  });
  if(error) throw new Error('asaas_payment_persistence_failed');
  return {
    transaction_id:attempt.transaction_id,
    test_mode:attempt.environment==='sandbox',
    environment:attempt.environment,
    provider_reference:providerTransactionId,provider_status:rawStatus,status:normalizedStatus,
    invoice_url:invoiceUrl,pix_copy_paste:pix.pix_copy_paste||null,
    pix_encoded_image:pix.pix_encoded_image||null,pix_expiration:pix.pix_expiration||null,
  };
}

async function recoverNeutralAsaasPayment(admin: any, attempt: any, credential: AsaasCredential) {
  if(attempt.provider_transaction_id) {
    const result=await asaasRequest(credential,`/payments/${encodeURIComponent(String(attempt.provider_transaction_id))}`);
    if(!result.response.ok||!result.body?.id) return null;
    return saveNeutralAsaasPayment(admin,attempt,result.body,credential);
  }
  const payment=await findAsaasPayment(credential,String(attempt.external_reference));
  if(!payment) return null;
  return saveNeutralAsaasPayment(admin,attempt,payment,credential);
}

async function handleNeutralAsaasAttempt(
  admin:any,snapshot:Record<string,any>,payer:ReturnType<typeof normalizeCheckoutPayer>,attempt:any,
) {
  if(attempt.provider_code!=='asaas_production'||attempt.environment!=='production') {
    return {body:{error:'Este adquirente ainda não está habilitado para este checkout.'},status:409};
  }
  const encryptionSecret=Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY')||'';
  if(!encryptionSecret) throw new Error('checkout_encryption_not_configured');
  const credential:AsaasCredential={
    apiKey:await decryptProviderCredential(String(attempt.api_key_ciphertext||''),encryptionSecret),
    environment:'production',
  };
  if(!credential.apiKey.startsWith('$aact_prod_')) throw new Error('stored_key_environment_mismatch');

  if(attempt.provider_transaction_id) {
    try {
      const payment=await recoverNeutralAsaasPayment(admin,attempt,credential);
      if(payment) return {body:{status:'processing',payment},status:200};
    } catch(error) {
      const code=error instanceof Error&&/^[a-z0-9_]{1,80}$/.test(error.message)?error.message:'asaas_payment_recovery_failed';
      console.error('asaas_checkout_recovery_deferred',JSON.stringify({attempt_id:attempt.attempt_id,code}));
    }
    return {body:{status:'processing',message:'Estamos confirmando o pagamento. Não tente pagar novamente.'},status:202};
  }
  if(attempt.should_submit!==true) {
    try {
      const payment=await recoverNeutralAsaasPayment(admin,attempt,credential);
      if(payment) return {body:{status:'processing',payment},status:200};
    } catch(error) {
      const code=error instanceof Error&&/^[a-z0-9_]{1,80}$/.test(error.message)?error.message:'asaas_payment_recovery_failed';
      console.error('asaas_checkout_recovery_deferred',JSON.stringify({attempt_id:attempt.attempt_id,code}));
    }
    return {body:{status:'processing',message:'Estamos confirmando o pagamento. Não tente pagar novamente.'},status:202};
  }

  const {data:ledgerAccount,error:ledgerError}=await admin.from('nexora_ledger_accounts')
    .select('id').eq('business_id',attempt.business_id).eq('owner_id',attempt.owner_id)
    .eq('account_code','merchant_pending').maybeSingle();
  if(ledgerError||!ledgerAccount?.id) {
    return {body:{error:'A conta financeira do lojista ainda não está pronta para pagamentos.'},status:409};
  }
  try {
    const customerId=await createProviderCustomer(credential,attempt,payer);
    const {data:claimed,error:claimError}=await admin.rpc('nexora_provider_mark_payment_attempt_started',{
      p_attempt_id:attempt.attempt_id,p_lease_token:attempt.lease_token,
    });
    if(!claimError&&claimed!==true&&await wasBlockedBeforeProviderSubmit(admin,String(attempt.attempt_id))) {
      return {body:{error:'As condições de recebimento mudaram; este pagamento não foi enviado. Peça ao lojista um novo link.'},status:409};
    }
    if(claimError||claimed!==true) {
      return {body:{status:'processing',message:'Estamos confirmando a tentativa. Não tente pagar novamente.'},status:202};
    }
    const created=await asaasRequest(credential,'/payments',{
      method:'POST',body:JSON.stringify({customer:customerId,billingType:'PIX',
        value:Number(snapshot.amount_cents)/100,dueDate:asaasBrazilTomorrow(),
        description:String(snapshot.description),externalReference:String(attempt.external_reference)}),
    });
    if(created.response.ok&&created.body?.id) {
      const payment=await saveNeutralAsaasPayment(admin,attempt,created.body,credential);
      return {body:{status:'processing',payment},status:200};
    }
    const recovered=await recoverNeutralAsaasPayment(admin,attempt,credential).catch(()=>null);
    if(recovered) return {body:{status:'processing',payment:recovered},status:200};
    const code=`asaas_payment_http_${created.response.status}`;
    if(isDefinitiveAsaasCreateRejection(created.response.status)) {
      const {data:failed,error:failError}=await admin.rpc('nexora_provider_fail_charge_attempt',{
        p_attempt_id:attempt.attempt_id,p_lease_token:attempt.lease_token,p_error_code:code,
      });
      if(!failError&&failed===true) {
        return {body:{error:'O adquirente recusou a cobrança. Solicite um novo link ao lojista antes de tentar novamente.'},status:422};
      }
      console.error('asaas_rejection_persistence_failed',JSON.stringify({attempt_id:attempt.attempt_id,code:failError?.code||'unknown'}));
    }
    console.error('asaas_checkout_attempt_unresolved',JSON.stringify({attempt_id:attempt.attempt_id,code}));
    return {body:{status:'processing',message:'Estamos confirmando o pagamento com o adquirente. Não tente pagar novamente.'},status:202};
  } catch(error) {
    const recovered=await recoverNeutralAsaasPayment(admin,attempt,credential).catch(()=>null);
    if(recovered) return {body:{status:'processing',payment:recovered},status:200};
    const code=error instanceof Error&&/^[a-z0-9_]{1,80}$/.test(error.message)?error.message:'asaas_response_uncertain';
    console.error('asaas_checkout_attempt_unresolved',JSON.stringify({attempt_id:attempt.attempt_id,code}));
    return {body:{status:'processing',message:'Estamos confirmando o pagamento. Não tente pagar novamente.'},status:202};
  }
}

async function recoverPublicPayment(admin: any, transactionId: string) {
  const { data: attempt, error: attemptError } = await admin.from('nexora_payment_attempts')
    .select('provider_code,environment').eq('transaction_id', transactionId).maybeSingle();
  const attemptTableMissing = attemptError?.code === '42P01' || attemptError?.code === 'PGRST205';
  if (attemptError && !attemptTableMissing) throw new Error('checkout_attempt_lookup_failed');
  if (attempt) {
    const adapter = hostedCheckoutAdapter(attempt.provider_code);
    if (!adapter || attempt.environment !== 'production') return null;
    try {
      if (adapter === 'pushinpay') return await recoverPushinPayPayment(admin, transactionId);
      if (adapter === 'orusprime') return await recoverOrusPrimePayment(admin, transactionId);
      return adapter === 'mercadopago'
        ? await recoverMercadoPagoPayment(admin, transactionId)
        : await recoverNeutralAsaasPaymentByTransaction(admin, transactionId);
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
        ? error.message : 'provider_payment_recovery_failed';
      console.error('hosted_checkout_provider_recovery_deferred', JSON.stringify({
        transaction_id: transactionId, provider_code: attempt.provider_code, code,
      }));
      return null;
    }
  }

  // Read-only compatibility path for pre-Payment-Core Asaas operations only.
  const { data: operation, error } = await admin.from('nexora_asaas_sandbox_operations')
    .select('id,external_reference,api_key_ciphertext,environment,payment_attempted_at')
    .eq('transaction_id', transactionId).maybeSingle();
  if (error) throw new Error('checkout_operation_lookup_failed');
  if (!operation?.payment_attempted_at || operation.environment !== 'production') return null;
  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!encryptionSecret) throw new Error('checkout_encryption_not_configured');
  const credential: AsaasCredential = {
    apiKey: await decryptProviderCredential(String(operation.api_key_ciphertext || ''), encryptionSecret),
    environment: 'production',
  };
  const payment = await findAsaasPayment(credential, String(operation.external_reference)).catch(() => null);
  if (!payment) return null;
  await saveAsaasProviderPayment(admin, Number(operation.id), transactionId, payment, credential);
  return paymentDetails(admin, transactionId);
}

async function createProviderCustomer(credential: AsaasCredential, op: any, payer: ReturnType<typeof normalizeCheckoutPayer>) {
  const ref = String(op.transaction_id);
  const query = new URLSearchParams({ externalReference: ref, limit: '10', offset: '0' });
  const listed = await asaasRequest(credential, `/customers?${query}`);
  if (!listed.response.ok) throw new Error(listed.response.status >= 500 ? 'provider_customer_lookup_uncertain' : 'provider_customer_lookup_rejected');
  const found = Array.isArray(listed.body?.data)
    ? listed.body.data.find((row: Record<string, unknown>) => row.externalReference === ref) : null;
  if (found?.id) return String(found.id);

  const created = await asaasRequest(credential, '/customers', {
    method: 'POST', body: JSON.stringify({
      name: payer.name, cpfCnpj: payer.document, ...(payer.email ? { email: payer.email } : {}),
      externalReference: ref, notificationDisabled: true,
    }),
  });
  if (!created.response.ok || !created.body?.id) {
    throw new Error(created.response.status >= 500 ? 'provider_customer_create_uncertain' : 'provider_customer_create_rejected');
  }
  return String(created.body.id);
}

async function handlePublicPayment(admin: any, input: Record<string, unknown>): Promise<{
  body: Record<string, unknown>; status: number; retryAfter?: number;
}> {
  const token = input.token;
  const tokenHash = await publicCheckoutTokenHash(token);
  if (!tokenHash) return { body: { error: 'Link de pagamento inválido.' }, status: 400 };
  const rateLimit = await consumePublicCheckoutLimit(admin, tokenHash, 'pay');
  if (!rateLimit.allowed && rateLimit.retry_after_seconds > 0) {
    return { body: { error: 'Muitas tentativas neste link. Aguarde antes de tentar novamente.' }, status: 429, retryAfter: rateLimit.retry_after_seconds };
  }
  const { data: snapshot, error: snapshotError } = await admin.rpc('nexora_checkout_public_snapshot', { p_token_hash: tokenHash });
  if (snapshotError) throw new Error('checkout_link_lookup_failed');
  if (!snapshot) return { body: { error: 'Link de pagamento não encontrado.' }, status: 404 };
  if (!isHostedCheckoutMethodSupported(input)) {
    return { body: { error: 'Forma de pagamento inválida para este link.' }, status: 409 };
  }
  const wantsCard = input.payment_method === 'credit_card';
  const cardInput = wantsCard ? parseMercadoPagoCardInput(input) : null;
  if (wantsCard && !cardInput) return { body: { error: 'Dados do cartão inválidos. Revise e tente novamente.' }, status: 400 };
  const payer = normalizeCheckoutPayer({ name: input.payer_name, email: input.payer_email, document: input.payer_document });
  const payerRequirements = hostedCheckoutPayerRequirements(snapshot.provider_code);
  if (!payerRequirements) return { body: { error: 'O adquirente deste link ainda não está disponível para pagamentos.' }, status: 409 };
  if (payerRequirements.email_required && !payer.email) {
    return { body: { error: 'Informe seu e-mail para gerar este pagamento.' }, status: 400 };
  }
  if (snapshot.status !== 'active' && snapshot.status !== 'processing') {
    return { body: { error: 'Este link não está disponível para pagamento.', status: snapshot.status }, status: 409 };
  }

  const requestHash = await checkoutRequestHash(token, String(snapshot.id), payer);
  const adapter = hostedCheckoutAdapter(snapshot.provider_code);
  if (wantsCard && adapter !== 'mercadopago') {
    return { body: { error: 'Este link não aceita cartão de crédito.' }, status: 409 };
  }
  if (adapter === 'mercadopago') {
    return handleMercadoPagoPublicPayment(admin,input,snapshot,payer,tokenHash,requestHash,cardInput || undefined);
  }
  if (adapter === 'pushinpay') {
    return handlePushinPayPublicPayment(admin,input,snapshot,payer,tokenHash,requestHash);
  }
  if (adapter === 'orusprime') {
    return handleOrusPrimePublicPayment(admin,input,snapshot,payer,tokenHash,requestHash);
  }
  if (adapter !== 'asaas') {
    return { body: { error: 'O adquirente deste link ainda não está disponível para pagamentos.' }, status: 409 };
  }
  const { data: op, error: beginError } = await admin.rpc('nexora_checkout_public_begin_charge', {
    p_token_hash: tokenHash, p_request_hash: requestHash,
    p_payer_name: payer.name, p_payer_email: payer.email, p_payer_document: payer.document,
  });
  if (beginError || !op) {
    console.error('hosted_checkout_begin_failed', JSON.stringify({ code: beginError?.code || 'unknown', link_id: snapshot.id }));
    return { body: { error: 'Não foi possível iniciar o pagamento. Atualize a página ou fale com o lojista.' }, status: 409 };
  }
  if(op.attempt_id) return handleNeutralAsaasAttempt(admin,snapshot,payer,op);
  if (!['processing', 'unknown', 'succeeded'].includes(String(op.status))) {
    return { body: { error: 'Este link não está disponível para pagamento.', status: op.status }, status: 409 };
  }

  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!encryptionSecret) throw new Error('checkout_encryption_not_configured');
  const credential: AsaasCredential = {
    apiKey: await decryptProviderCredential(String(op.api_key_ciphertext || ''), encryptionSecret),
    environment: 'production',
  };
  if (!credential.apiKey.startsWith('$aact_prod_')) throw new Error('stored_key_environment_mismatch');

  if (!op.is_new) {
    if (op.payment_attempted_at || op.status === 'succeeded') {
      const existing = await findAsaasPayment(credential, String(op.external_reference));
      if (existing) {
        const saved = await saveAsaasProviderPayment(admin, Number(op.operation_id), String(op.transaction_id), existing, credential);
        return { body: { status: saved.status, payment: saved }, status: 200 };
      }
      return { body: { status: 'processing', message: 'Estamos confirmando o pagamento. Não tente pagar novamente.' }, status: 202 };
    }
    return { body: { status: 'processing', message: 'Outra tentativa está sendo preparada. Aguarde e atualize esta página.' }, status: 202 };
  }

  const { error: pricingError } = await admin.rpc('nexora_pricing_apply', {
    p_transaction_id: op.transaction_id, p_business_id: op.business_id,
    p_owner_id: op.owner_id, p_acquirer_id: op.acquirer_id,
  });
  if (pricingError) {
    await markOperation(admin, op, 'failed', 'pricing_unavailable');
    return { body: { error: 'O pagamento não pode ser processado agora. Entre em contato com o lojista.' }, status: 409 };
  }

  try {
    const providerCustomerId = await createProviderCustomer(credential, op, payer);
    const { error: attemptError } = await admin.rpc('nexora_asaas_mark_payment_attempt', {
      p_operation_id: Number(op.operation_id), p_customer_id: providerCustomerId, p_lease_token: op.lease_token,
    });
    if (attemptError) throw new Error('provider_payment_attempt_guard_failed');
    const paymentResult = await asaasRequest(credential, '/payments', {
      method: 'POST', body: JSON.stringify({
        customer: providerCustomerId, billingType: 'PIX', value: Number(snapshot.amount_cents) / 100,
        dueDate: asaasBrazilTomorrow(), description: String(snapshot.description),
        externalReference: String(op.external_reference),
      }),
    });
    if (!paymentResult.response.ok || !paymentResult.body?.id) {
      if (paymentResult.response.status >= 500) {
        const recovered = await findAsaasPayment(credential, String(op.external_reference)).catch(() => null);
        if (recovered) {
          const saved = await saveAsaasProviderPayment(admin, Number(op.operation_id), String(op.transaction_id), recovered, credential);
          return { body: { status: saved.status, payment: saved }, status: 200 };
        }
        await markOperation(admin, op, 'unknown', `payment_http_${paymentResult.response.status}`);
        return { body: { status: 'processing', message: 'Estamos confirmando o pagamento com o adquirente. Não tente pagar novamente.' }, status: 202 };
      }
      await markOperation(admin, op, 'failed', `payment_http_${paymentResult.response.status}`);
      return { body: { error: 'O adquirente recusou esta tentativa. Solicite um novo link ao lojista.' }, status: 422 };
    }
    const saved = await saveAsaasProviderPayment(admin, Number(op.operation_id), String(op.transaction_id), paymentResult.body, credential);
    return { body: { status: saved.status, payment: saved }, status: 200 };
  } catch (error) {
    const recovered = await findAsaasPayment(credential, String(op.external_reference)).catch(() => null);
    if (recovered) {
      const saved = await saveAsaasProviderPayment(admin, Number(op.operation_id), String(op.transaction_id), recovered, credential);
      return { body: { status: saved.status, payment: saved }, status: 200 };
    }
    const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'provider_response_uncertain';
    const definitive = code.endsWith('_rejected');
    await markOperation(admin, op, definitive ? 'failed' : 'unknown', code);
    return definitive
      ? { body: { error: 'O adquirente recusou os dados. Confira os dados informados e solicite outro link ao lojista.' }, status: 422 }
      : { body: { status: 'processing', message: 'Estamos confirmando o pagamento. Não tente pagar novamente.' }, status: 202 };
  }
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS') return new Response('ok', {
    headers: { ...corsHeaders, 'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? (origin || 'https://www.nexorapay.me') : 'https://www.nexorapay.me' },
  });
  if (origin && !isAllowedOrigin(origin)) return response(request, { error: 'Origem não autorizada.' }, 403);
  if (request.method !== 'POST') return response(request, { error: 'Método não permitido.' }, 405);
  const input = await readPayload(request);
  if (!input) return response(request, { error: 'Solicitação inválida ou muito grande.' }, 400);

  try {
    if (input.action === 'create_link') {
      const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const url = Deno.env.get('SUPABASE_URL') || '';
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
      if (!token || !url || !anonKey) return response(request, { error: 'Sessão necessária.' }, 401);
      const userClient = createClient(url, anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: authData, error: authError } = await userClient.auth.getUser(token);
      if (authError || !authData.user) return response(request, { error: 'Sessão inválida ou expirada.' }, 401);
      const businessId = String(input.business_id || '');
      const acquirerId = String(input.acquirer_id || '');
      const amountCents = Number(input.amount_cents);
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      if (!/^[0-9a-f-]{36}$/i.test(businessId) || !/^[0-9a-f-]{36}$/i.test(acquirerId)
        || !Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 99999999
        || description.length < 2 || description.length > 120) {
        return response(request, { error: 'Informe o valor e a descrição da cobrança.' }, 400);
      }
      const publicToken = generateCheckoutToken();
      const { data: link, error } = await userClient.rpc('nexora_checkout_create_link', {
        p_business_id: businessId, p_acquirer_id: acquirerId, p_amount_cents: amountCents,
        p_description: description, p_token_hash: await checkoutTokenHash(publicToken),
      });
      if (error || !link) {
        console.error('hosted_checkout_link_create_failed', JSON.stringify({ code: error?.code || 'unknown', owner_id: authData.user.id }));
        return response(request, { error: 'Não foi possível criar o link. Confirme aprovação, conexão e tarifa com o administrador.' }, 409);
      }
      const checkoutUrl = `https://www.nexorapay.me/checkout.html#token=${encodeURIComponent(publicToken)}`;
      return response(request, { ...link, checkout_url: checkoutUrl }, 201);
    }

    const admin = makeAdmin();
    if (input.action === 'view') {
      const tokenHash = await publicCheckoutTokenHash(input.token);
      if (!tokenHash) return response(request, { error: 'Link de pagamento inválido.' }, 400);
      const rateLimit = await consumePublicCheckoutLimit(admin, tokenHash, 'view');
      if (!rateLimit.allowed && rateLimit.retry_after_seconds > 0) return response(request,
        { error: 'Muitas consultas neste link. Aguarde e tente novamente.' }, 429,
        { 'Retry-After': String(rateLimit.retry_after_seconds) });
      const { data, error } = await admin.rpc('nexora_checkout_public_snapshot', { p_token_hash: tokenHash });
      if (error) throw new Error('checkout_link_lookup_failed');
      if (!data) return response(request, { error: 'Link de pagamento não encontrado.' }, 404);

      let activeSnapshot = data;
      let orderTokenStr: string | null = null;
      if (typeof input.order_token === 'string' && input.order_token) {
        const orderTokenHash = await publicCheckoutTokenHash(input.order_token);
        if (orderTokenHash) {
          const { data: childSnap } = await admin.rpc('nexora_checkout_public_snapshot', { p_token_hash: orderTokenHash });
          if (childSnap && (childSnap.parent_link_id === data.id || childSnap.id === data.id)) {
            activeSnapshot = childSnap;
            orderTokenStr = input.order_token;
          }
        }
      }

      const { id: _internalId, transaction_id: transactionId, ...publicData } = activeSnapshot;
      let details = transactionId ? await paymentDetails(admin, String(transactionId)) : null;
      if (transactionId && publicData.status !== 'paid' && publicData.status !== 'failed' && publicData.status !== 'expired' && publicData.status !== 'canceled') {
        try {
          const recovered = await recoverPublicPayment(admin, String(transactionId));
          if (recovered) {
            details = recovered;
            if (recovered.status === 'SUCCEEDED' || recovered.status === 'paid') {
              const activeHash = (activeSnapshot.parent_link_id && orderTokenStr)
                ? await publicCheckoutTokenHash(orderTokenStr)
                : tokenHash;
              const { data: updatedSnap } = await admin.rpc('nexora_checkout_public_snapshot', { p_token_hash: activeHash });
              if (updatedSnap) {
                publicData.status = updatedSnap.status;
                publicData.paid_at = updatedSnap.paid_at;
              }
            } else if (recovered.status === 'FAILED' || recovered.status === 'CANCELED') {
              publicData.status = 'failed';
            }
          }
        } catch (error) {
          const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'checkout_payment_recovery_failed';
          console.error('hosted_checkout_recovery_deferred', JSON.stringify({ code }));
        }
      }
      if (details && (details.status === 'FAILED' || details.status === 'CANCELED' || details.provider_status === 'rejected')) {
        publicData.status = 'failed';
      }
      const dynamicPublicKey = data.provider_code === 'mercadopago_leo_production'
        ? 'APP_USR-fc0720b8-4265-44d0-aff0-cda38b6e8c75'
        : 'APP_USR-a666cd7a-e78b-4778-a33b-d9fbc813cdf0';
      return response(request, {
        ...publicData,
        merchant_name: data.merchant_name,
        order_token: orderTokenStr,
        public_key: dynamicPublicKey,
        payer_requirements: hostedCheckoutPayerRequirements(data.provider_code),
        payment_methods: hostedCheckoutMethods(data.provider_code),
        checkout_domains: hostedCheckoutDomains(data.provider_code),
        payment: details || null,
      });
    }
    if (input.action === 'pay') {
      const result = await handlePublicPayment(admin, input);
      return response(request, result.body, result.status,
        result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {});
    }
    return response(request, { error: 'Ação inválida.' }, 400);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'checkout_request_failed';
    console.error('nexora_checkout_failed', JSON.stringify({ action: String(input.action || 'unknown'), code }));
    return response(request, { error: 'Não foi possível processar este checkout. Atualize a página ou fale com o lojista.' }, 503);
  }
});

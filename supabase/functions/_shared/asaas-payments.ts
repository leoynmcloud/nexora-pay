import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from './bounded-http-body.ts';

import { asaasConfiguration, asaasAcquirerMatches, asaasStatus, assertPaymentIdentity, normalizeAsaasPaymentStatus, selectUniqueAsaasPayment } from './asaas-config.ts';
import type { AsaasEnvironment } from './asaas-config.ts';
import { decryptProviderCredential } from './provider-credentials.ts';
export type AsaasCredential = { apiKey: string; environment: AsaasEnvironment };
const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
async function digest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timeoutSignal(milliseconds = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export async function asaasRequest(credential: AsaasCredential, path: string, init: RequestInit = {}) {
  const config = asaasConfiguration(credential.environment);
  const timeout = timeoutSignal();
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      signal: timeout.signal, redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `NexoraPay/1.0 (${config.environment})`,
        access_token: credential.apiKey,
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } finally { timeout.clear(); }
}

const mapStatus = asaasStatus;

function expiryDate(value: unknown) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function trustedInvoiceUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'asaas.com' || url.hostname.endsWith('.asaas.com')) ? url.toString() : null;
  } catch { return null; }
}

export async function findAsaasPayment(apiKey: AsaasCredential, externalReference: string) {
  const query = new URLSearchParams({ externalReference, limit: '10', offset: '0' });
  const { response, body } = await asaasRequest(apiKey, `/payments?${query}`);
  if (!response.ok) return null;
  return selectUniqueAsaasPayment(body?.data, externalReference);
}

export async function fetchAsaasPix(apiKey: AsaasCredential, paymentId: string) {
  try {
    const { response, body } = await asaasRequest(apiKey, `/payments/${encodeURIComponent(paymentId)}/pixQrCode`);
    if (!response.ok) return {};
    return {
      pix_copy_paste: typeof body?.payload === 'string' ? body.payload.slice(0, 5000) : null,
      pix_encoded_image: typeof body?.encodedImage === 'string' ? body.encodedImage.slice(0, 100000) : null,
      pix_expiration: expiryDate(body?.expirationDate),
    };
  } catch { return {}; }
}

export async function saveAsaasProviderPayment(admin: ReturnType<typeof createClient>, operationId: number, transactionId: string, payment: Record<string, unknown>, apiKey: AsaasCredential) {
  const { data: operation, error: operationError } = await admin.from('nexora_asaas_sandbox_operations')
    .select('external_reference,provider_reference,environment').eq('id', operationId).eq('transaction_id', transactionId).maybeSingle();
  const { data: transaction, error: transactionError } = await admin.from('nexora_transactions').select('amount')
    .eq('id', transactionId).maybeSingle();
  if (operationError || transactionError || !operation || !transaction || operation.environment !== apiKey.environment) throw new Error('payment_identity_unavailable');
  assertPaymentIdentity(payment, { ...operation, amount: Number(transaction.amount) });
  const providerId = String(payment.id || '');
  if (!providerId) throw new Error('provider_reference_missing');
  const pix = await fetchAsaasPix(apiKey, providerId);
  const status = String(payment.status || 'PENDING').slice(0, 80);
  const invoiceUrl = trustedInvoiceUrl(payment.invoiceUrl);
  const { error } = await admin.rpc('nexora_asaas_complete_charge', {
    p_operation_id: operationId,
    p_provider_reference: providerId,
    p_provider_status: status,
    p_transaction_status: mapStatus(status),
    p_invoice_url: invoiceUrl,
    p_pix_copy_paste: pix.pix_copy_paste || null,
    p_pix_encoded_image: pix.pix_encoded_image || null,
    p_pix_expiration: pix.pix_expiration,
  });
  if (error) {
    // Keep provider/payment data out of logs; the Postgres/PostgREST code is enough to diagnose schema or permission issues.
    console.error('asaas_payment_persistence_failed', JSON.stringify({ code: error.code || 'unknown', operation_id: operationId }));
    throw new Error('payment_persistence_failed');
  }
  return {
    transaction_id: transactionId,
    test_mode: apiKey.environment === 'sandbox', environment: apiKey.environment,
    provider_reference: providerId,
    provider_status: status,
    status: mapStatus(status),
    invoice_url: invoiceUrl,
    ...pix,
  };
}

/** Refreshes a new Payment Core attempt without reading the legacy Asaas operation table. */
export async function saveNeutralAsaasProviderPayment(
  admin: ReturnType<typeof createClient>,
  attempt: Record<string, any>,
  payment: Record<string, unknown>,
  credential: AsaasCredential,
) {
  const expectedAmount = Number(attempt.amount_cents) / 100;
  assertPaymentIdentity(payment, {
    external_reference: String(attempt.external_reference),
    provider_reference: attempt.provider_transaction_id || null,
    amount: expectedAmount,
  });
  const providerId = String(payment.id || '');
  if (!providerId) throw new Error('provider_reference_missing');
  const pix = await fetchAsaasPix(credential, providerId);
  const rawStatus = String(payment.status || 'PENDING').slice(0, 80);
  const normalizedStatus = normalizeAsaasPaymentStatus(rawStatus);
  const { error } = await admin.rpc('nexora_provider_save_charge_result', {
    p_attempt_id: attempt.attempt_id || attempt.id,
    p_provider_transaction_id: providerId,
    p_raw_status: rawStatus,
    p_normalized_status: normalizedStatus,
    p_pix_copy_paste: pix.pix_copy_paste || null,
    p_pix_encoded_image: pix.pix_encoded_image || null,
    p_checkout_url: trustedInvoiceUrl(payment.invoiceUrl),
    p_expires_at: pix.pix_expiration || null,
  });
  if (error) throw new Error('payment_persistence_failed');
  return {
    transaction_id: attempt.transaction_id,
    test_mode: credential.environment === 'sandbox',
    environment: credential.environment,
    provider_reference: providerId,
    provider_status: rawStatus,
    status: normalizedStatus,
    invoice_url: trustedInvoiceUrl(payment.invoiceUrl),
    ...pix,
  };
}

/**
 * Applies the only Asaas event currently allowed to create a financial ledger
 * posting. The webhook body is merely a notification: identity/status/amount
 * are re-fetched from Asaas using the credential captured for that operation.
 */
export async function processAsaasPaymentReceived(
  admin: ReturnType<typeof createClient>,
  eventId: string,
  paymentNotice: Record<string, unknown>,
) {
  const providerPaymentId = String(paymentNotice.id || '');
  const externalReference = String(paymentNotice.externalReference || '');
  if (!providerPaymentId || providerPaymentId.length > 255 || !externalReference || externalReference.length > 255) {
    throw new Error('webhook_payment_reference_invalid');
  }

  const { data: operation, error: operationError } = await admin.from('nexora_asaas_sandbox_operations')
    .select('id,business_id,owner_id,transaction_id,external_reference,provider_reference,environment,acquirer_id,api_key_ciphertext')
    .eq('external_reference', externalReference).maybeSingle();
  if (operationError) throw new Error('webhook_operation_lookup_failed');
  // The same Asaas account may send events for payments that were not created by Nexora.
  if (!operation) return { outcome: 'ignored_unmatched' as const };
  if (!operation.transaction_id || !operation.api_key_ciphertext || operation.environment !== 'production') {
    // Do not turn sandbox events or incomplete historical records into production balance.
    return { outcome: 'ignored_nonproduction' as const };
  }

  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!encryptionSecret) throw new Error('webhook_encryption_not_configured');
  const credential: AsaasCredential = {
    apiKey: await decryptProviderCredential(operation.api_key_ciphertext, encryptionSecret),
    environment: 'production',
  };
  if (!credential.apiKey.startsWith(asaasConfiguration('production').keyPrefix)) throw new Error('stored_key_environment_mismatch');

  const verified = await asaasRequest(credential, `/payments/${encodeURIComponent(providerPaymentId)}`);
  if (!verified.response.ok || !verified.body?.id) throw new Error('provider_payment_verification_failed');
  const { data: transaction, error: transactionError } = await admin.from('nexora_transactions')
    .select('id,owner_id,business_id,amount,test_mode').eq('id', operation.transaction_id).maybeSingle();
  if (transactionError || !transaction || transaction.owner_id !== operation.owner_id
    || transaction.business_id !== operation.business_id || transaction.test_mode) {
    throw new Error('webhook_transaction_identity_failed');
  }
  assertPaymentIdentity(verified.body, {
    external_reference: operation.external_reference,
    provider_reference: operation.provider_reference || providerPaymentId,
    amount: Number(transaction.amount),
  });
  if (String(verified.body.status || '') !== 'RECEIVED') throw new Error('provider_payment_not_received');

  // Persist the provider-confirmed state first. Both this RPC and the journal
  // writer are idempotent, so a retry after a timeout cannot create another charge.
  await saveAsaasProviderPayment(admin, Number(operation.id), String(transaction.id), verified.body, credential);

  const amountCents = Math.round(Number(transaction.amount) * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('ledger_amount_invalid');
  const requestHash = await digest(JSON.stringify({
    provider: 'asaas', event: 'payment.received', owner: transaction.owner_id,
    business: transaction.business_id, transaction: transaction.id,
    provider_payment: providerPaymentId, amount_cents: amountCents,
  }));
  const { error: ledgerError } = await admin.rpc('nexora_ledger_post_journal', {
    p_owner_id: transaction.owner_id,
    p_business_id: transaction.business_id,
    p_transaction_id: transaction.id,
    p_event_code: 'payment.received',
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
  return { outcome: 'posted_pending' as const, transactionId: transaction.id };
}

export function asaasBrazilTomorrow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + 1)).toISOString().slice(0, 10);
}

export function serveAsaasPayments(sandboxOnly = false) {
  Deno.serve((request) => handleAsaasPaymentRequest(request, sandboxOnly));
}

/** Request handler is exported so the provider-neutral payment router can dispatch to this adapter. */
export async function handleAsaasPaymentRequest(request: Request, sandboxOnly = false) {
  const origin = request.headers.get('origin') || '';
  const defaults = ['https://nexorapay.me', 'https://www.nexorapay.me'];
  const deprecatedOrigins = new Set(['https://nexorapay-demo.vercel.app']);
  const custom = (Deno.env.get('NEXORA_ALLOWED_ORIGINS') || '').split(',').map((value) => value.trim()).filter((value) => value && !deprecatedOrigins.has(value));
  const allowed = [...new Set([...defaults, ...custom])];
  const cors = { ...corsHeaders, 'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0], Vary: 'Origin' };
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (origin && !allowed.includes(origin)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403, headers: cors });
  if (request.method !== 'POST') return Response.json({ error: 'Método não permitido.' }, { status: 405, headers: cors });
  const rawBody = await readBoundedHttpBody(request, 12_000);
  if (rawBody === null) return Response.json({ error: 'Solicitação muito grande ou inválida.' }, { status: 413, headers: cors });
  let input: Record<string, unknown>;
  try { input = JSON.parse(rawBody); } catch { return Response.json({ error: 'Solicitação inválida.' }, { status: 400, headers: cors }); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return Response.json({ error: 'Solicitação inválida.' }, { status: 400, headers: cors });

  let operationId: number | null = null;
  let leaseToken: string | null = null;
  let neutralAttempt: Record<string, any> | null = null;
  try {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return Response.json({ error: 'Entre na sua conta novamente.' }, { status: 401, headers: cors });
    const url = Deno.env.get('SUPABASE_URL') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
    if (!url || !anonKey || !serviceKey || !encryptionSecret) throw new Error('server_not_configured');

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return Response.json({ error: 'Sessão expirada. Entre novamente.' }, { status: 401, headers: cors });
    const user = authData.user;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: accountStatus, error: accountError } = await admin.from('nexora_account_controls').select('status').eq('user_id', user.id).maybeSingle();
    if (accountError) throw new Error('account_check_failed');
    const { data: onboarding, error: onboardingError } = await admin.from('merchant_onboarding').select('status').eq('user_id', user.id).maybeSingle();
    if (onboardingError) throw new Error('kyc_check_failed');
    if (onboarding?.status !== 'APPROVED') return Response.json({ error: 'Complete o cadastro e aguarde a aprovação manual para criar cobranças.' }, { status: 403, headers: cors });
    if (accountStatus?.status === 'suspended') return Response.json({ error: 'A conta está suspensa. Fale com o suporte.' }, { status: 403, headers: cors });

    const { data: business, error: businessError } = await admin.from('businesses').select('id,owner_id').eq('owner_id', user.id).order('id').limit(1).maybeSingle();
    if (businessError || !business) throw new Error('workspace_not_found');
    let key: AsaasCredential;
    let assigned: { acquirer_id: string; updated_at: string } | null = null;
    if (input.action === 'refresh') {
      const transactionId = String(input.transaction_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(transactionId)) return Response.json({ error: 'Identificador da cobrança inválido.' }, { status: 400, headers: cors });
      const { data: ownedTransaction, error: ownedTransactionError } = await admin.from('nexora_transactions')
        .select('id').eq('id', transactionId).eq('business_id', business.id).eq('owner_id', user.id).maybeSingle();
      if (ownedTransactionError || !ownedTransaction) return Response.json({ error: 'Cobrança não encontrada nesta conta.' }, { status: 404, headers: cors });
      const { data: attempt, error: attemptError } = await admin.from('nexora_payment_attempts')
        .select('id,transaction_id,owner_id,business_id,provider_code,environment,external_reference,provider_transaction_id,platform_credential_id')
        .eq('transaction_id', transactionId).eq('business_id', business.id).eq('owner_id', user.id).maybeSingle();
      const attemptTableMissing = attemptError?.code === '42P01' || attemptError?.code === 'PGRST205';
      if (attemptError && !attemptTableMissing) throw new Error('payment_attempt_lookup_failed');
      if (attempt) {
        const config = asaasConfiguration(attempt.environment);
        if (attempt.provider_code !== config.code || input.provider_code !== attempt.provider_code) {
          return Response.json({ error: 'Esta cobrança pertence a outra rota de pagamento. Atualize a lista e tente novamente.' }, { status: 409, headers: cors });
        }
        const { data: credential, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
          .select('api_key_ciphertext').eq('id', attempt.platform_credential_id).maybeSingle();
        if (credentialError || !credential?.api_key_ciphertext) return Response.json({ error: 'A credencial original desta cobrança não está disponível.' }, { status: 409, headers: cors });
        key = { apiKey: await decryptProviderCredential(credential.api_key_ciphertext, encryptionSecret), environment: config.environment };
        neutralAttempt = attempt;
      } else {
        const { data: historical, error: historicalError } = await admin.from('nexora_asaas_sandbox_operations')
          .select('api_key_ciphertext,environment').eq('transaction_id', transactionId)
          .eq('business_id', business.id).eq('owner_id', user.id).maybeSingle();
        if (historicalError || !historical?.api_key_ciphertext) return Response.json({ error: 'A conexão original desta cobrança não está disponível para consulta.' }, { status: 409, headers: cors });
        const config = asaasConfiguration(historical.environment);
        if (input.provider_code && input.provider_code !== config.code) return Response.json({ error: 'Esta cobrança pertence a outra rota de pagamento.' }, { status: 409, headers: cors });
        key = { apiKey: await decryptProviderCredential(historical.api_key_ciphertext, encryptionSecret), environment: config.environment };
      }
    } else if (input.action === 'create' || input.action === 'test_connection') {
      const { data: controls, error: controlsError } = await admin.from('nexora_merchant_controls').select('payments_enabled')
        .eq('business_id', business.id).eq('owner_id', user.id).maybeSingle();
      if (controlsError) throw new Error('controls_check_failed');
      if (input.action === 'create' && controls?.payments_enabled !== true) return Response.json({ error: 'Recebimentos estão bloqueados pelo administrador.' }, { status: 403, headers: cors });
      const { data: connection, error: connectionError } = await admin.from('nexora_merchant_provider_connections')
        .select('owner_id,acquirer_id,status,updated_at').eq('business_id', business.id).eq('owner_id', user.id).maybeSingle();
      if (connectionError || !connection) return Response.json({ error: 'O Super Admin ainda não atribuiu um adquirente a esta conta.' }, { status: 409, headers: cors });
      const { data: acquirer, error: acquirerError } = await admin.from('nexora_acquirers')
        .select('code,name,api_base_url,environment,status').eq('id', connection.acquirer_id).maybeSingle();
      if (acquirerError || !acquirer || !asaasAcquirerMatches(acquirer)) return Response.json({ error: 'O adquirente Asaas atribuído está indisponível ou com endereço inválido.' }, { status: 409, headers: cors });
      if (connection.status !== 'active') return Response.json({ error: 'A rota de pagamento deste workspace ainda não foi ativada pelo Super Admin.' }, { status: 409, headers: cors });
      if (input.action === 'create' && (input.environment !== acquirer.environment || input.acquirer_id !== connection.acquirer_id)) return Response.json({ error: 'O adquirente ou ambiente mudou. Atualize a página antes de criar a cobrança.' }, { status: 409, headers: cors });
      const { data: platformCredential, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
        .select('api_key_ciphertext').eq('acquirer_id', connection.acquirer_id)
        .eq('environment', acquirer.environment).eq('status', 'active').maybeSingle();
      if (credentialError || !platformCredential?.api_key_ciphertext) {
        return Response.json({ error: 'A credencial central da Nexora não está configurada para este adquirente e ambiente.' }, { status: 409, headers: cors });
      }
      assigned = connection;
      key = { apiKey: await decryptProviderCredential(platformCredential.api_key_ciphertext, encryptionSecret), environment: asaasConfiguration(acquirer.environment).environment };
    } else {
      return Response.json({ error: 'Ação inválida.' }, { status: 400, headers: cors });
    }
    if ((sandboxOnly && key.environment !== 'sandbox') || !key.apiKey.startsWith(asaasConfiguration(key.environment).keyPrefix)) {
      return Response.json({ error: 'A chave não corresponde ao ambiente da cobrança.' }, { status: 409, headers: cors });
    }

    if (input.action === 'test_connection') {
      const check = await asaasRequest(key, '/myAccount/status/');
      if (!check.response.ok) return Response.json({ error: 'O provedor não confirmou a conexão. Peça ao administrador para revisar a configuração.' }, { status: 422, headers: cors });
      return Response.json({ connected: true, environment: key.environment }, { headers: cors });
    }

    if (input.action === 'create') {
      const requestId = String(input.request_id || '');
      const customerId = String(input.customer_id || '');
      const description = String(input.description || '').trim();
      const cents = Number(input.amount_cents);
      if (!/^[0-9a-f-]{36}$/i.test(requestId) || !/^[0-9a-f-]{36}$/i.test(customerId)
        || !Number.isSafeInteger(cents) || cents < 100 || cents > 99999999
        || description.length < 2 || description.length > 120) {
        return Response.json({ error: 'Selecione um cliente e revise o valor e a descrição.' }, { status: 400, headers: cors });
      }
      const { data: customer, error: customerError } = await admin.from('nexora_customers')
        .select('id,name,email,document').eq('id', customerId).eq('owner_id', user.id).eq('business_id', business.id).maybeSingle();
      if (customerError) throw new Error('customer_lookup_failed');
      if (!customer || !/^(\d{11}|\d{14})$/.test(String(customer.document || ''))) {
        return Response.json({ error: 'Este cliente não tem CPF/CNPJ cadastrado. Atualize o cadastro em Clientes antes de cobrar.' }, { status: 422, headers: cors });
      }
      const customerName = String(customer.name || '').trim();
      const customerEmail = String(customer.email || '').trim().toLowerCase();
      const customerDocument = String(customer.document);
      const requestHash = await digest(JSON.stringify({ owner: user.id, business: business.id, customerId, cents, description }));
      const { data: op, error: reserveError } = await admin.rpc('nexora_asaas_begin_charge', {
        p_owner_id: user.id, p_business_id: business.id, p_request_id: requestId, p_request_hash: requestHash,
        p_customer_name: customerName, p_customer_email: customerEmail || null, p_customer_document: customerDocument,
        p_amount: cents / 100, p_description: description,
        p_acquirer_id: assigned!.acquirer_id, p_environment: key.environment, p_connection_version: assigned!.updated_at,
      });
      if (reserveError || !op) return Response.json({ error: 'Não foi possível registrar a tentativa. Confira a migração de produção, a conexão e os dados da cobrança.' }, { status: 409, headers: cors });
      operationId = Number(op.operation_id);
      leaseToken = op.lease_token;
      key = { apiKey: await decryptProviderCredential(op.api_key_ciphertext, encryptionSecret), environment: asaasConfiguration(op.environment).environment };
      if (!key.apiKey.startsWith(asaasConfiguration(key.environment).keyPrefix)) throw new Error('stored_key_environment_mismatch');
      if (op.status === 'succeeded') {
        const { data: saved } = await admin.from('nexora_asaas_sandbox_payment_details').select('*').eq('transaction_id', op.transaction_id).maybeSingle();
        const { data: savedTransaction } = await admin.from('nexora_transactions').select('status,amount,title,customer_name')
          .eq('id', op.transaction_id).eq('owner_id', user.id).maybeSingle();
        return Response.json({ ...saved, ...savedTransaction, transaction_id: op.transaction_id, already_created: true, environment: key.environment, test_mode: key.environment === 'sandbox' }, { headers: cors });
      }
      if (op.status === 'failed') {
        return Response.json({ error: 'A tentativa anterior foi recusada pelo provedor. Abra uma nova cobrança após revisar os dados.' }, { status: 409, headers: cors });
      }
      if (!op.is_new) {
        const existing = await findAsaasPayment(key, String(op.external_reference));
        if (existing) {
          const saved = await saveAsaasProviderPayment(admin, operationId, String(op.transaction_id), existing, key);
          return Response.json({ ...saved, recovered: true }, { headers: cors });
        }
        const message = op.payment_attempted_at
          ? 'A cobrança já foi enviada ao provedor e está em verificação. Atualize o extrato em alguns instantes; não será enviada novamente.'
          : 'Esta solicitação ainda está sendo processada. Aguarde alguns instantes antes de tentar novamente.';
        return Response.json({ error: message, transaction_id: op.transaction_id, verification_required: true }, { status: 409, headers: cors });
      }

      // Fix the merchant's fee on the internal sale before any Asaas customer
      // or payment request. No configured rule means no external charge.
      const { error: pricingError } = await admin.rpc('nexora_pricing_apply', {
        p_transaction_id: op.transaction_id, p_business_id: business.id,
        p_owner_id: user.id, p_acquirer_id: assigned!.acquirer_id,
      });
      if (pricingError) {
        const { error: cancelError } = await admin.rpc('nexora_asaas_fail_operation', {
          p_operation_id: operationId, p_lease_token: leaseToken,
          p_status: 'failed', p_error_code: 'pricing_unavailable',
        });
        if (cancelError) throw new Error('pricing_operation_cancel_failed');
        return Response.json({ error: 'A tarifa desta operação ainda não foi configurada. Nenhuma cobrança foi enviada; peça ao administrador para revisar o pricing.' }, { status: 409, headers: cors });
      }

      try {
        const customerQuery = new URLSearchParams({ externalReference: String(op.transaction_id), limit: '10', offset: '0' });
        const customerList = await asaasRequest(key, `/customers?${customerQuery}`);
        if (!customerList.response.ok) {
          if (customerList.response.status >= 500) {
            await admin.rpc('nexora_asaas_fail_operation', { p_operation_id: operationId, p_lease_token: leaseToken, p_status: 'unknown', p_error_code: `customer_lookup_http_${customerList.response.status}` });
            return Response.json({ error: 'O Asaas não confirmou a consulta do pagador. A cobrança não foi enviada; tente novamente em instantes.', transaction_id: op.transaction_id }, { status: 202, headers: cors });
          }
          await admin.rpc('nexora_asaas_fail_operation', { p_operation_id: operationId, p_lease_token: leaseToken, p_status: 'failed', p_error_code: `customer_lookup_http_${customerList.response.status}` });
          return Response.json({ error: 'Não foi possível consultar o pagador no Asaas. Confira a conexão com o Super Admin.' }, { status: 422, headers: cors });
        }
        let providerCustomer = Array.isArray(customerList.body?.data)
          ? customerList.body.data.find((row: Record<string, unknown>) => row.externalReference === String(op.transaction_id)) : null;
        if (!providerCustomer) {
          const createdCustomer = await asaasRequest(key, '/customers', { method: 'POST', body: JSON.stringify({
            name: customerName, cpfCnpj: customerDocument, ...(customerEmail ? { email: customerEmail } : {}),
            externalReference: String(op.transaction_id), notificationDisabled: true,
          }) });
          if (!createdCustomer.response.ok) {
            const uncertain = createdCustomer.response.status >= 500;
            await admin.rpc('nexora_asaas_fail_operation', { p_operation_id: operationId, p_lease_token: leaseToken, p_status: uncertain ? 'unknown' : 'failed', p_error_code: `customer_http_${createdCustomer.response.status}` });
            if (uncertain) return Response.json({ error: 'O Asaas não confirmou o cadastro do pagador. Nenhuma cobrança foi enviada; tente novamente em instantes.', transaction_id: op.transaction_id }, { status: 202, headers: cors });
            return Response.json({ error: 'O Asaas recusou o cadastro do pagador. Confira os dados informados.' }, { status: 422, headers: cors });
          }
          providerCustomer = createdCustomer.body;
        }
        if (!providerCustomer?.id) throw new Error('provider_customer_id_missing');
        const { error: attemptError } = await admin.rpc('nexora_asaas_mark_payment_attempt', {
          p_operation_id: operationId, p_customer_id: String(providerCustomer.id), p_lease_token: leaseToken,
        });
        if (attemptError) throw new Error('payment_attempt_guard_failed');
        const paymentResult = await asaasRequest(key, '/payments', { method: 'POST', body: JSON.stringify({
          customer: providerCustomer.id, billingType: 'PIX', value: cents / 100, dueDate: asaasBrazilTomorrow(),
          description, externalReference: String(op.external_reference),
        }) });
        if (!paymentResult.response.ok) {
          if (paymentResult.response.status >= 500) {
            const recovered = await findAsaasPayment(key, String(op.external_reference));
            if (recovered) return Response.json(await saveAsaasProviderPayment(admin, operationId, String(op.transaction_id), recovered, key), { headers: cors });
            await admin.rpc('nexora_asaas_fail_operation', { p_operation_id: operationId, p_lease_token: leaseToken, p_status: 'unknown', p_error_code: `payment_http_${paymentResult.response.status}` });
            return Response.json({ error: 'O Asaas não confirmou a resposta. A operação ficou em verificação; não reenviamos a cobrança para evitar duplicidade.', transaction_id: op.transaction_id, verification_required: true }, { status: 202, headers: cors });
          }
          await admin.rpc('nexora_asaas_fail_operation', { p_operation_id: operationId, p_lease_token: leaseToken, p_status: 'failed', p_error_code: `payment_http_${paymentResult.response.status}` });
          const description = Array.isArray(paymentResult.body?.errors) ? paymentResult.body.errors.map((item: Record<string, unknown>) => String(item.description || '')).filter(Boolean).join(' ') : '';
          return Response.json({ error: description.slice(0, 500) || 'O Asaas recusou a cobrança.' }, { status: 422, headers: cors });
        }
        return Response.json(await saveAsaasProviderPayment(admin, operationId, String(op.transaction_id), paymentResult.body, key), { headers: cors });
      } catch (error) {
        const recovered = await findAsaasPayment(key, String(op.external_reference)).catch(() => null);
        if (recovered) return Response.json(await saveAsaasProviderPayment(admin, operationId, String(op.transaction_id), recovered, key), { headers: cors });
        await admin.rpc('nexora_asaas_fail_operation', {
          p_operation_id: operationId, p_lease_token: leaseToken, p_status: 'unknown',
          p_error_code: error instanceof DOMException && error.name === 'AbortError' ? 'provider_timeout' : 'provider_response_uncertain',
        });
        return Response.json({ error: 'Não foi possível confirmar a resposta do Asaas. A solicitação ficou em verificação e não será reenviada automaticamente.', transaction_id: op.transaction_id, verification_required: true }, { status: 202, headers: cors });
      }
    }

    if (input.action === 'refresh') {
      const transactionId = String(input.transaction_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(transactionId)) return Response.json({ error: 'Identificador da cobrança inválido.' }, { status: 400, headers: cors });
      const { data: transaction, error: transactionError } = await admin.from('nexora_transactions')
        .select('id,owner_id,business_id,external_id,provider_reference,test_mode,amount').eq('id', transactionId).eq('owner_id', user.id).eq('business_id', business.id).maybeSingle();
      if (transactionError || !transaction) return Response.json({ error: 'Cobrança não encontrada nesta conta.' }, { status: 404, headers: cors });
      if (neutralAttempt) {
        const amountCents = Math.round(Number(transaction.amount) * 100);
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('payment_amount_invalid');
        const providerId = neutralAttempt.provider_transaction_id || transaction.provider_reference;
        const paymentResult = providerId
          ? await asaasRequest(key, `/payments/${encodeURIComponent(String(providerId))}`)
          : null;
        const payment = paymentResult?.response.ok
          ? paymentResult.body
          : !providerId ? await findAsaasPayment(key, String(neutralAttempt.external_reference)) : null;
        if (!payment?.id) return Response.json({ error: 'O Asaas ainda não retornou esta cobrança. Ela não será reenviada.' }, { status: 202, headers: cors });
        return Response.json(await saveNeutralAsaasProviderPayment(admin, {
          ...neutralAttempt, attempt_id: neutralAttempt.id, amount_cents: amountCents,
        }, payment, key), { headers: cors });
      }
      const { data: operation } = await admin.from('nexora_asaas_sandbox_operations').select('id,external_reference')
        .eq('transaction_id', transaction.id).maybeSingle();
      if (!operation) return Response.json({ error: 'Referência interna da cobrança não encontrada.' }, { status: 404, headers: cors });
      operationId = Number(operation.id);
      const payment = transaction.provider_reference
        ? (await asaasRequest(key, `/payments/${encodeURIComponent(transaction.provider_reference)}`)).body
        : await findAsaasPayment(key, String(operation.external_reference));
      if (!payment?.id) return Response.json({ error: 'O Asaas ainda não retornou esta cobrança. Ela não será reenviada.' }, { status: 202, headers: cors });
      return Response.json(await saveAsaasProviderPayment(admin, operationId, transaction.id, payment, key), { headers: cors });
    }
    return Response.json({ error: 'Ação inválida.' }, { status: 400, headers: cors });
  } catch (error) {
    console.error('nexora-asaas-payments failed', error instanceof Error ? error.name : 'unknown', operationId ?? 'no-operation');
    const message = error instanceof Error && error.message === 'payment_persistence_failed'
      ? 'O Asaas já tem esta cobrança, mas a Nexora ainda não conseguiu salvar o status. Não crie outra cobrança; use “Atualizar status” para sincronizar esta mesma cobrança.'
      : 'Não foi possível concluir a operação com o Asaas.';
    return Response.json({ error: message }, { status: 500, headers: cors });
  }
}

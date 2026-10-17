import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  createPushinPayPixPayment,
  getPushinPayTransaction,
} from './pushinpay-adapter.ts';
import { readBoundedHttpBody } from './bounded-http-body.ts';
import { normalizeCheckoutPayer } from './hosted-checkout.ts';
import { decryptProviderCredential } from './provider-credentials.ts';
import { processPushinPayPaymentWebhook } from './pushinpay-webhook-core.ts';

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

async function digest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cors(request: Request) {
  const origin = request.headers.get('origin') || '';
  return {
    ...corsHeaders,
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? (origin || 'https://www.nexorapay.me') : 'https://www.nexorapay.me',
    Vary: 'Origin',
  };
}

function normalizeError(error: unknown) {
  return error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
    ? error.message : 'pushinpay_payment_failed';
}

async function wasBlockedBeforeProviderSubmit(admin: ReturnType<typeof createClient>, attemptId: string): Promise<boolean> {
  const { data, error } = await admin.from('nexora_payment_attempts')
    .select('status,last_error_code').eq('id', attemptId).maybeSingle();
  return !error && data?.status === 'failed'
    && ['merchant_not_operable', 'provider_credential_inactive', 'provider_route_changed', 'provider_unavailable'].includes(data.last_error_code);
}

async function persistResult(admin: ReturnType<typeof createClient>, attempt: Record<string, any>, result: Record<string, any>) {
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
    invoice_url: result.checkoutUrl || null,
    pix_copy_paste: result.pixCopyPaste || null,
    pix_encoded_image: result.qrCodeBase64 || null,
    pix_expiration: result.expiresAt || null,
  };
}

async function loadCredential(admin: ReturnType<typeof createClient>, acquirerId: string, environment: string, secret: string) {
  const { data, error } = await admin.from('nexora_platform_provider_credentials')
    .select('api_key_ciphertext').eq('acquirer_id', acquirerId).eq('environment', environment)
    .eq('status', 'active').maybeSingle();
  if (error || !data?.api_key_ciphertext) return null;
  return decryptProviderCredential(data.api_key_ciphertext, secret);
}

async function saveOrRecover(admin: ReturnType<typeof createClient>, attempt: Record<string, any>, apiKey: string) {
  if (!attempt.provider_transaction_id) return null;
  const result = await getPushinPayTransaction(apiKey, String(attempt.provider_transaction_id));
  if (!result) return null;
  const saved = await persistResult(admin, attempt, result);
  if (result.status === 'SUCCEEDED' && result.providerTransactionId) {
    try {
      await processPushinPayPaymentWebhook(admin, {
        eventId: `refresh:${result.providerTransactionId}`,
        eventType: 'payment.completed',
        providerTransactionId: result.providerTransactionId,
        apiKey,
      });
    } catch (error) {
      console.error('pushinpay_refresh_confirm_deferred', JSON.stringify({
        code: error instanceof Error ? error.message : 'confirm_failed',
      }));
    }
  }
  return saved;
}


/** Pushin Pay implementation of the authenticated payment endpoint contract. */
export async function handlePushinPayPaymentRequest(request: Request, sandboxOnly = false) {
  const headers = cors(request);
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  if (origin && !isAllowedOrigin(origin)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403, headers });
  if (request.method !== 'POST') return Response.json({ error: 'Método não permitido.' }, { status: 405, headers });

  let input: Record<string, unknown>;
  try {
    const raw = await readBoundedHttpBody(request, 12_000);
    if (raw === null) return Response.json({ error: 'Solicitação muito grande ou inválida.' }, { status: 413, headers });
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_input');
    input = parsed;
  } catch {
    return Response.json({ error: 'Solicitação inválida.' }, { status: 400, headers });
  }

  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Entre na sua conta novamente.' }, { status: 401, headers });
  const url = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const encryptionSecret = Deno.env.get('NEXORA_CREDENTIALS_ENCRYPTION_KEY') || '';
  if (!url || !anonKey || !serviceKey || !encryptionSecret) return Response.json({ error: 'Serviço temporariamente indisponível.' }, { status: 503, headers });

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return Response.json({ error: 'Sessão expirada. Entre novamente.' }, { status: 401, headers });
  const user = authData.user;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const { data: onboarding, error: onboardingError } = await admin.from('merchant_onboarding')
      .select('status').eq('user_id', user.id).maybeSingle();
    if (onboardingError) throw new Error('kyc_check_failed');
    if (onboarding?.status !== 'APPROVED') return Response.json({ error: 'Complete o cadastro e aguarde a aprovação manual para criar cobranças.' }, { status: 403, headers });
    const { data: account, error: accountError } = await admin.from('nexora_account_controls')
      .select('status').eq('user_id', user.id).maybeSingle();
    if (accountError) throw new Error('account_check_failed');
    if (account?.status === 'suspended') return Response.json({ error: 'A conta está suspensa. Fale com o suporte.' }, { status: 403, headers });
    const { data: business, error: businessError } = await admin.from('businesses')
      .select('id,owner_id').eq('owner_id', user.id).order('id').limit(1).maybeSingle();
    if (businessError || !business) throw new Error('workspace_not_found');

    if (input.action === 'refresh') {
      const transactionId = String(input.transaction_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(transactionId)) return Response.json({ error: 'Identificador da cobrança inválido.' }, { status: 400, headers });
      const { data: transaction, error: transactionError } = await admin.from('nexora_transactions')
        .select('id,amount,provider_reference').eq('id', transactionId).eq('owner_id', user.id).eq('business_id', business.id).maybeSingle();
      if (transactionError || !transaction) return Response.json({ error: 'Cobrança não encontrada nesta conta.' }, { status: 404, headers });
      const { data: attempt, error: attemptError } = await admin.from('nexora_payment_attempts')
        .select('id,transaction_id,provider_code,environment,external_reference,provider_transaction_id,platform_credential_id,acquirer_id')
        .eq('transaction_id', transactionId).maybeSingle();
      if (attemptError || !attempt || attempt.provider_code !== 'pushinpay_production') {
        return Response.json({ error: 'Tentativa da Pushin Pay não encontrada.' }, { status: 404, headers });
      }
      const { data: credentialRow, error: credentialError } = await admin.from('nexora_platform_provider_credentials')
        .select('api_key_ciphertext').eq('id', attempt.platform_credential_id).maybeSingle();
      if (credentialError || !credentialRow?.api_key_ciphertext) throw new Error('historical_credential_unavailable');
      const apiKey = await decryptProviderCredential(credentialRow.api_key_ciphertext, encryptionSecret);
      const recovered = await saveOrRecover(admin, { ...attempt, attempt_id: attempt.id, amount_cents: Math.round(Number(transaction.amount) * 100) }, apiKey);
      if (!recovered) return Response.json({ error: 'A Pushin Pay ainda não retornou esta cobrança. Ela não será reenviada.' }, { status: 202, headers });
      return Response.json(recovered, { headers });
    }

    if (input.action !== 'create' && input.action !== 'test_connection') return Response.json({ error: 'Ação inválida.' }, { status: 400, headers });
    const { data: controls, error: controlsError } = await admin.from('nexora_merchant_controls')
      .select('payments_enabled').eq('business_id', business.id).eq('owner_id', user.id).maybeSingle();
    if (controlsError) throw new Error('controls_check_failed');
    if (input.action === 'create' && controls?.payments_enabled !== true) return Response.json({ error: 'Recebimentos estão bloqueados pelo administrador.' }, { status: 403, headers });
    const { data: connection, error: connectionError } = await admin.from('nexora_merchant_provider_connections')
      .select('owner_id,acquirer_id,status,updated_at').eq('business_id', business.id).eq('owner_id', user.id).maybeSingle();
    if (connectionError || !connection) return Response.json({ error: 'O Super Admin ainda não atribuiu um adquirente a esta conta.' }, { status: 409, headers });
    const { data: acquirer, error: acquirerError } = await admin.from('nexora_acquirers')
      .select('code,api_base_url,environment,status').eq('id', connection.acquirer_id).maybeSingle();
    if (acquirerError || !acquirer || acquirer.code !== 'pushinpay_production'
      || acquirer.status !== 'enabled') {
      return Response.json({ error: 'O adquirente Pushin Pay atribuído está indisponível ou com endereço inválido.' }, { status: 409, headers });
    }
    if (connection.status !== 'active') return Response.json({ error: 'A rota de pagamento ainda não foi ativada pelo Super Admin.' }, { status: 409, headers });
    if ((sandboxOnly && acquirer.environment !== 'sandbox')
      || (input.action === 'create' && (input.environment !== acquirer.environment || input.acquirer_id !== connection.acquirer_id))) {
      return Response.json({ error: 'O adquirente ou ambiente mudou. Atualize a página antes de criar a cobrança.' }, { status: 409, headers });
    }
    const apiKey = await loadCredential(admin, connection.acquirer_id, acquirer.environment, encryptionSecret);
    if (!apiKey) return Response.json({ error: 'A credencial central não está configurada para este adquirente e ambiente.' }, { status: 409, headers });
    if (input.action === 'test_connection') return Response.json({ connected: true, environment: acquirer.environment }, { headers });

    const requestId = String(input.request_id || '');
    const customerId = String(input.customer_id || '');
    const description = String(input.description || '').trim();
    const amountCents = Number(input.amount_cents);
    if (!/^[0-9a-f-]{36}$/i.test(requestId) || !/^[0-9a-f-]{36}$/i.test(customerId)
      || !Number.isSafeInteger(amountCents) || amountCents < 50 || amountCents > 99_999_999
      || description.length < 2 || description.length > 120) {
      return Response.json({ error: 'Selecione um cliente e revise o valor e a descrição.' }, { status: 400, headers });
    }
    const { data: customer, error: customerError } = await admin.from('nexora_customers')
      .select('id,name,email,document').eq('id', customerId).eq('owner_id', user.id).eq('business_id', business.id).maybeSingle();
    if (customerError) throw new Error('customer_lookup_failed');
    if (!customer) {
      return Response.json({ error: 'Cliente não encontrado.' }, { status: 422, headers });
    }
    const { data: ledgerAccount, error: ledgerError } = await admin.from('nexora_ledger_accounts')
      .select('id').eq('business_id', business.id).eq('owner_id', user.id).eq('account_code', 'merchant_pending').maybeSingle();
    if (ledgerError || !ledgerAccount?.id) return Response.json({ error: 'A conta financeira do lojista ainda não está pronta para cobranças.' }, { status: 409, headers });
    const payer = normalizeCheckoutPayer({ name: customer.name, email: customer.email, document: customer.document });
    const requestHash = await digest(JSON.stringify({ owner: user.id, business: business.id, customerId, amountCents, description }));
    const { data: attempt, error: beginError } = await admin.rpc('nexora_provider_begin_charge', {
      p_owner_id: user.id, p_business_id: business.id, p_request_id: requestId, p_request_hash: requestHash,
      p_customer_name: payer.name, p_customer_email: payer.email, p_customer_document: payer.document,
      p_amount: amountCents / 100, p_description: description,
      p_acquirer_id: connection.acquirer_id, p_environment: acquirer.environment, p_connection_version: connection.updated_at,
    });
    if (beginError || !attempt) throw new Error('provider_attempt_begin_failed');
    if (attempt.provider_code !== acquirer.code || attempt.environment !== acquirer.environment) throw new Error('provider_attempt_route_mismatch');
    const normalizedAttempt = { ...attempt, attempt_id: attempt.attempt_id, amount_cents: amountCents };
    const storedToken = await decryptProviderCredential(String(attempt.api_key_ciphertext || ''), encryptionSecret);
    if (!storedToken) throw new Error('stored_key_unavailable');
    if (attempt.status === 'succeeded' || attempt.status === 'failed') {
      const existing = await saveOrRecover(admin, normalizedAttempt, storedToken);
      if (existing) return Response.json({ ...existing, already_created: true }, { headers });
      return Response.json({ error: 'A tentativa anterior terminou; consulte o status antes de criar outra.' }, { status: 409, headers });
    }
    if (attempt.should_submit !== true) {
      const existing = await saveOrRecover(admin, normalizedAttempt, storedToken);
      if (existing) return Response.json({ ...existing, recovered: true }, { headers });
      return Response.json({ error: 'A cobrança está em verificação; não tente criá-la novamente.', transaction_id: attempt.transaction_id, verification_required: true }, { status: 202, headers });
    }
    const { data: started, error: startedError } = await admin.rpc('nexora_provider_mark_payment_attempt_started', {
      p_attempt_id: attempt.attempt_id, p_lease_token: attempt.lease_token,
    });
    if (!startedError && started !== true && await wasBlockedBeforeProviderSubmit(admin, String(attempt.attempt_id))) {
      return Response.json({ error: 'As condições de recebimento mudaram; a cobrança não foi enviada. Atualize a rota e inicie uma nova cobrança.' }, { status: 409, headers });
    }
    if (startedError || started !== true) return Response.json({ error: 'A tentativa está em processamento; atualize o status antes de tentar novamente.' }, { status: 202, headers });

    try {
      const webhookUrl = url ? `${url.replace(/\/$/, '')}/functions/v1/nexora-pushinpay-webhook` : undefined;
      const result = await createPushinPayPixPayment(storedToken, {
        valueCents: amountCents,
        webhookUrl,
      });
      return Response.json(await persistResult(admin, normalizedAttempt, result), { headers });
    } catch (error) {
      const errorCode = normalizeError(error);
      const { data: failed, error: failError } = await admin.rpc('nexora_provider_fail_charge_attempt', {
        p_attempt_id: attempt.attempt_id, p_lease_token: attempt.lease_token, p_error_code: errorCode,
      });
      if (!failError && failed === true) {
        return Response.json({ error: 'A Pushin Pay recusou a cobrança. Revise os dados e tente novamente com uma nova solicitação.' }, { status: 422, headers });
      }
      return Response.json({ error: 'A Pushin Pay ainda não confirmou a cobrança. Não a envie novamente; atualize o status em instantes.', transaction_id: attempt.transaction_id, verification_required: true }, { status: 202, headers });
    }
  } catch (error) {
    const code = normalizeError(error);
    console.error('pushinpay_payment_handler_failed', JSON.stringify({ code, action: String(input.action || 'unknown') }));
    const status = ['kyc_check_failed', 'account_check_failed', 'workspace_not_found'].includes(code) ? 503 : 409;
    return Response.json({ error: 'Não foi possível concluir a operação com a Pushin Pay. Nenhuma nova tentativa será reenviada automaticamente.' }, { status, headers });
  }
}

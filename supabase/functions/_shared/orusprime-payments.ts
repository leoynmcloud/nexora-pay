import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  createOrusPrimePixPayment,
  getOrusPrimeTransaction,
} from './orusprime-adapter.ts';
import { readBoundedHttpBody } from './bounded-http-body.ts';
import { normalizeCheckoutPayer } from './hosted-checkout.ts';
import { decryptProviderCredential } from './provider-credentials.ts';

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
    ? error.message : 'orusprime_payment_failed';
}

async function persistResult(admin: ReturnType<typeof createClient>, attempt: Record<string, any>, result: Record<string, any>) {
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
    invoice_url: result.checkoutUrl || null,
    pix_copy_paste: result.pixCopyPaste || null,
    pix_encoded_image: result.qrCodeImage || null,
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

async function saveOrRecover(admin: ReturnType<typeof createClient>, attempt: Record<string, any>, credentialsInput: string) {
  if (!attempt.provider_transaction_id) return null;
  const result = await getOrusPrimeTransaction(credentialsInput, String(attempt.provider_transaction_id));
  return result ? persistResult(admin, attempt, result) : null;
}

/** Orus Prime implementation of the authenticated payment endpoint contract. */
export async function handleOrusPrimePaymentRequest(request: Request, sandboxOnly = false) {
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
        .eq('transaction_id', transaction.id).eq('environment', 'production').order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (attemptError || !attempt) return Response.json({ error: 'Tentativa não encontrada.' }, { status: 404, headers });
      const creds = await loadCredential(admin, attempt.acquirer_id, attempt.environment, encryptionSecret);
      if (!creds) throw new Error('provider_credential_unavailable');
      const recovered = await saveOrRecover(admin, attempt, creds);
      return Response.json(recovered || { status: 'PENDING' }, { headers });
    }

    const payer = normalizeCheckoutPayer({
      name: typeof input.payer_name === 'string' ? input.payer_name : undefined,
      email: typeof input.payer_email === 'string' ? input.payer_email : undefined,
      document: typeof input.payer_document === 'string' ? input.payer_document : undefined,
      phone: typeof input.payer_phone === 'string' ? input.payer_phone : undefined,
    });

    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return Response.json({ error: 'Informe um valor válido.' }, { status: 400, headers });
    const amountCents = Math.round(amount * 100);
    if (amountCents < 50) return Response.json({ error: 'O valor mínimo é R$ 0,50.' }, { status: 400, headers });

    const requestHash = await digest(JSON.stringify({
      amount: amountCents,
      description: input.description || null,
      payer_name: payer.name || null,
      payer_email: payer.email || null,
      payer_document: payer.document || null,
      payer_phone: payer.phone || null,
      action: 'pay',
    }));

    const idempotencyKey = String(request.headers.get('x-idempotency-key') || input.idempotency_key || `dash:${Date.now()}:${Math.random().toString(36).slice(2)}`).slice(0, 120);

    const { data: attemptData, error: attemptRpcError } = await admin.rpc('nexora_create_payment_attempt_v2', {
      p_business_id: business.id,
      p_owner_id: user.id,
      p_acquirer_code: 'orusprime_production',
      p_payment_method: 'pix',
      p_amount_cents: amountCents,
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash,
      p_currency: 'BRL',
      p_payer_name: payer.name || null,
      p_payer_email: payer.email || null,
      p_payer_document: payer.document || null,
      p_payer_phone: payer.phone || null,
    });
    if (attemptRpcError || !attemptData?.attempt_id) {
      console.error('orusprime_attempt_create_failed', attemptRpcError);
      return Response.json({ error: 'Não foi possível iniciar a cobrança.' }, { status: 500, headers });
    }

    const attempt = attemptData;
    const creds = await loadCredential(admin, attempt.acquirer_id, attempt.environment, encryptionSecret);
    if (!creds) throw new Error('provider_credential_unavailable');

    const webhookUrl = `${url.replace(/\/$/, '')}/functions/v1/nexora-orusprime-webhook`;

    const paymentResult = await createOrusPrimePixPayment(creds, {
      identifier: attempt.external_reference || `nx_${attempt.attempt_id}`,
      valueCents: amountCents,
      client: {
        name: payer.name || 'Cliente Nexora',
        email: payer.email || user.email || 'cliente@nexorapay.me',
        document: payer.document || undefined,
        phone: payer.phone || undefined,
      },
      callbackUrl: webhookUrl,
      metadata: {
        attemptId: attempt.attempt_id,
        transactionId: attempt.transaction_id,
      },
    });

    const saved = await persistResult(admin, attempt, paymentResult);
    return Response.json(saved, { status: 201, headers });
  } catch (error) {
    const code = normalizeError(error);
    console.error('orusprime_payment_request_failed', JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) }));
    return Response.json({ error: 'Falha ao processar pagamento com Orus Prime.', code }, { status: 500, headers });
  }
}

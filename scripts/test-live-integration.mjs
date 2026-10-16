import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function generateMerchantApiKey(environment = 'production') {
  const prefix = environment === 'production' ? 'nx_live_' : 'nx_test_';
  return `${prefix}${toBase64Url(crypto.randomBytes(32))}`;
}

function hashMerchantApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function run() {
  console.log('--- TESTE DE INTEGRAÇÃO DA API NEXORA PAY ---');
  
  // 1. Gerar chave de API de produção
  const secret = generateMerchantApiKey('production');
  const keyPrefix = secret.slice(0, 16);
  const keyHash = hashMerchantApiKey(secret);
  console.log('Chave gerada:', secret);
  console.log('Prefixo:', keyPrefix);
  console.log('Hash SHA-256:', keyHash);

  // 2. Inserir chave no banco para o merchant elmoreirag@gmail.com
  const businessId = 'ee0c6313-4aea-478a-b236-218f1b87bb1f';
  const ownerId = 'ca5fb005-1146-4408-87de-5b1443982cce';
  const insertSql = `
    INSERT INTO public.nexora_merchant_api_keys (business_id, owner_id, key_prefix, key_hash, name, environment, scopes)
    VALUES ('${businessId}', '${ownerId}', '${keyPrefix}', '${keyHash}', 'Chave Teste Integracao', 'production', ARRAY['payments:read', 'payments:write'])
    RETURNING id;
  `;

  console.log('\nRegistrando chave no banco de dados via Supabase CLI...');
  const insertRes = execSync(`npx supabase db query --linked "${insertSql.replace(/\s+/g, ' ').trim()}"`, { encoding: 'utf-8' });
  const match = insertRes.match(/"id":\s*"([0-9a-f-]{36})"/i);
  const keyId = match ? match[1] : null;
  if (!keyId) {
    throw new Error('Não foi possível obter o ID da chave criada: ' + insertRes);
  }
  console.log('ID da chave criada:', keyId);

  try {
    // 3. Testar POST /api/v1/payment-links
    console.log('\nTestando POST https://www.nexorapay.me/api/v1/payment-links...');
    const idempotencyKey = 'integ-test-' + Date.now();
    const createRes = await fetch('https://www.nexorapay.me/api/v1/payment-links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secret}`,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount_cents: 1000,
        currency: 'BRL',
        description: 'Teste Integracao Mercado Pago Oficial'
      })
    });

    console.log('Status HTTP POST payment-links:', createRes.status);
    const createData = await createRes.json();
    console.log('Resposta POST:', JSON.stringify(createData, null, 2));

    if (!createRes.ok || !createData.data?.checkout_url) {
      throw new Error(`Falha ao criar payment link: ${JSON.stringify(createData)}`);
    }

    const linkId = createData.data.id;
    const checkoutUrl = createData.data.checkout_url;
    const orderToken = checkoutUrl.split('#token=')[1];
    console.log('\nSucesso na criação do link!');
    console.log('- Link ID:', linkId);
    console.log('- Checkout URL:', checkoutUrl);
    console.log('- Token:', orderToken);

    // 4. Testar GET /api/v1/payment-links/:id
    console.log(`\nTestando GET https://www.nexorapay.me/api/v1/payment-links/${linkId}...`);
    const getRes = await fetch(`https://www.nexorapay.me/api/v1/payment-links/${linkId}`, {
      headers: {
        'Authorization': `Bearer ${secret}`
      }
    });
    console.log('Status HTTP GET payment-link:', getRes.status);
    const getData = await getRes.json();
    console.log('Resposta GET:', JSON.stringify(getData, null, 2));

    // 5. Testar snapshot do checkout hospedado com action: 'view' e token
    console.log('\nTestando POST view em /functions/v1/nexora-checkout...');
    const snapshotRes = await fetch('https://ouqbpslyfnanajkkxrcu.supabase.co/functions/v1/nexora-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'view',
        token: orderToken
      })
    });
    console.log('Status HTTP View:', snapshotRes.status);
    const snapshotData = await snapshotRes.json();
    console.log('Snapshot:', JSON.stringify(snapshotData, null, 2));

    // 6. Testar checkout pay (Pix) chamando o Mercado Pago oficial
    console.log('\nTestando POST pay (Pix) em /functions/v1/nexora-checkout com credencial ativa do Mercado Pago...');
    const payRes = await fetch('https://ouqbpslyfnanajkkxrcu.supabase.co/functions/v1/nexora-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'pay',
        token: orderToken,
        payment_method: 'pix',
        payer_name: 'Cliente Teste Integracao',
        payer_email: 'teste.integracao@nexorapay.me',
        payer_document: '12345678909'
      })
    });
    console.log('Status HTTP Pay Pix:', payRes.status);
    const payData = await payRes.json();
    console.log('Resultado Pay Pix:', JSON.stringify(payData, null, 2));

    if (payData.pix) {
      console.log('\n PIX GERADO COM SUCESSO NO MERCADO PAGO PRODUÇÃO!');
      console.log('- Copia e Cola:', payData.pix.qr_code?.slice(0, 60) + '...');
      console.log('- Tem Base64?:', Boolean(payData.pix.qr_code_base64));
      console.log('- Status tentativa:', payData.status);
    } else {
      console.log('Atenção: Resposta sem pix:', payData);
    }

  } finally {
    // Revogar chave de teste
    console.log('\nRevogando chave de teste...');
    execSync(`npx supabase db query --linked "UPDATE public.nexora_merchant_api_keys SET status = 'revoked', revoked_at = now() WHERE id = '${keyId}';"`, { encoding: 'utf-8' });
    console.log('Chave de teste revogada com sucesso.');
  }
}

run().catch(err => {
  console.error('ERRO NO TESTE:', err);
  process.exit(1);
});

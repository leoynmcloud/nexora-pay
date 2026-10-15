// Teste de criação de cobrança Pix de R$ 10,00 no Mercado Pago
const accessToken = process.env.MP_ACCESS_TOKEN || '';
if (!accessToken) { console.error('Defina MP_ACCESS_TOKEN no ambiente local para executar o teste.'); process.exit(1); }
if (process.env.CONFIRM_MP_LIVE_CHARGE !== '1') {
  console.error('Este script cria uma cobrança REAL de R$ 10,00. Para confirmar intencionalmente, defina CONFIRM_MP_LIVE_CHARGE=1 no ambiente local.');
  process.exit(1);
}

async function testCreatePix() {
  try {
    console.log('Criando cobrança Pix de R$ 10,00 no Mercado Pago...');
    const idempotencyKey = 'nx-test-' + Date.now();
    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
        'User-Agent': 'NexoraPay/1.0'
      },
      body: JSON.stringify({
        transaction_amount: 10.00,
        description: 'Cobrança Pix R$ 10,00 - Nexora Pay',
        payment_method_id: 'pix',
        payer: {
          email: 'pagador.teste@nexorapay.me',
          first_name: 'Cliente',
          last_name: 'Teste',
          identification: {
            type: 'CPF',
            number: '12345678909'
          }
        }
      })
    });

    console.log('Status HTTP:', response.status);
    const data = await response.json();
    if (response.ok) {
      console.log('Cobrança Pix criada com sucesso!');
      console.log('- ID do Pagamento MP:', data.id);
      console.log('- Status:', data.status);
      console.log('- Valor:', data.transaction_amount);
      const poi = data.point_of_interaction?.transaction_data;
      if (poi) {
        console.log('- QR Code Pix Copia e Cola:', poi.qr_code?.slice(0, 40) + '...');
        console.log('- Tem QR Code Base64?', Boolean(poi.qr_code_base64));
        console.log('- Ticket URL:', poi.ticket_url);
      }
    } else {
      console.log('Erro retornado pelo Mercado Pago:', data);
    }
  } catch (err) {
    console.error('Erro na requisição:', err.message);
  }
}

testCreatePix();

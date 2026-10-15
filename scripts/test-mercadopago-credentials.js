// Teste de validação das credenciais do Mercado Pago fornecidas pelo usuário
const accessToken = process.env.MP_ACCESS_TOKEN || '';
if (!accessToken) { console.error('Defina MP_ACCESS_TOKEN no ambiente local para executar o teste.'); process.exit(1); }

async function testMercadoPago() {
  try {
    console.log('Testando conexão com Mercado Pago API...');
    const response = await fetch('https://api.mercadopago.com/users/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'NexoraPay/1.0'
      }
    });

    console.log('Status HTTP:', response.status);
    const data = await response.json();
    if (response.ok) {
      console.log('Sucesso! Conta Mercado Pago identificada:');
      console.log('- ID:', data.id);
      console.log('- Nickname:', data.nickname);
      console.log('- Email:', data.email);
      console.log('- Site ID:', data.site_id);
    } else {
      console.log('Resposta do Mercado Pago:', data);
    }
  } catch (err) {
    console.error('Erro na requisição:', err.message);
  }
}

testMercadoPago();

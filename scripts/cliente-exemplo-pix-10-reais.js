// Exemplo de integração simples para clientes da Nexora Pay
// Criação de cobrança Pix no valor padrão de R$ 10,00 (1000 centavos)

const API_KEY = process.env.NEXORA_API_KEY || 'nx_live_sua_chave_aqui';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91cWJwc2x5Zm5hbmFqa2t4cmN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3MjkwNDIsImV4cCI6MjEwNjMwNTA0Mn0.kmMoZxzwJWenWUUDb3f9OCEcPcwRFfLF-_3ErqQXWdM';
const ENDPOINT = 'https://www.nexorapay.me/api/v1/payment-links';

async function criarCobrancaPix({ valorReais = 10, descricao = 'Cobrança Pix', pedidoId = `pedido-${Date.now()}` }) {
  const payload = {
    amount_cents: Math.round(valorReais * 100),
    currency: 'BRL',
    description: descricao
  };

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'apikey': SUPABASE_ANON,
      'Idempotency-Key': pedidoId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Erro HTTP ${response.status}`);
  }

  return data;
}

// Exemplo de uso:
if (require.main === module) {
  criarCobrancaPix({ valorReais: 10, descricao: 'Pagamento Pix R$ 10,00' })
    .then(res => {
      const link = res.data || res;
      console.log('Link criado com sucesso!');
      console.log('ID do Link:', link.id);
      console.log('URL de Checkout:', link.checkout_url);
      console.log('Expira em:', link.expires_at);
    })
    .catch(err => {
      console.error('Falha ao criar cobrança:', err.message);
    });
}

module.exports = { criarCobrancaPix };

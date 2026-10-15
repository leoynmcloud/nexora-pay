# API pública Nexora — versão inicial

Estado: implementação local, **não publicada nem homologada no Supabase**. A API pública v1 inicial cria e consulta links de pagamento. Não é uma API completa de pagamentos, saques, refunds ou webhooks.

## Disponibilidade e segurança

- Base pretendida: `https://www.nexorapay.me/api/v1`.
- A chave Nexora é segredo de servidor. Nunca a coloque em navegador, app mobile, checkout do comprador, repositório ou logs.
- A Edge Function também recebe o `apikey` público do projeto Supabase pelo gateway. Esse valor é identificador público do projeto; não substitui a chave privada `nx_live_...`.
- A API rejeita requisições com `Origin`, para não incentivar uso de segredo de servidor no browser.
- A implementação atual só atende chaves `production`, o adapter Pix Asaas atualmente conectado, workspaces aprovados/ativos, recebimentos liberados e acesso à API liberado pelo Super Admin.
- Sandbox, cartão, boleto, refund, payout/saque, criação direta de transação sem link e seleção de múltiplas rotas ainda não estão disponíveis por esta API.

## Criar um link de pagamento

```http
POST /api/v1/payment-links
Authorization: Bearer nx_live_<segredo>
apikey: <chave pública do projeto Supabase>
Idempotency-Key: loja-pedido-2026-000042
Content-Type: application/json

{
  "amount_cents": 15000,
  "currency": "BRL",
  "description": "Pedido 42"
}
```

`amount_cents` é inteiro em centavos (100 a 99.999.999); `description` aceita de 2 a 120 caracteres. O link expira em sete dias. O comprador não precisa criar conta Nexora. A URL é retornada apenas quando criada/reexecutada com a mesma chave Nexora e `Idempotency-Key`.

A mesma `Idempotency-Key` e o mesmo conteúdo retornam o mesmo link. Reutilizá-la com conteúdo diferente gera `409 IDEMPOTENCY_CONFLICT`. Use uma chave nova para uma nova intenção de cobrança.

## Consultar links

```http
GET /api/v1/payment-links?limit=25&cursor=<cursor_opaco>
GET /api/v1/payment-links/<id>
Authorization: Bearer nx_live_<segredo>
apikey: <chave pública do projeto Supabase>
```

As respostas são isoladas ao workspace dono da chave. A listagem usa cursor estável, limite padrão 25 e máximo 100. Eventos monetários seguem o status registrado no link; `paid` não significa `SETTLED` nem saldo disponível para saque.

## Escopos, idempotência e limites

- `payments:write`: obrigatório para criar links.
- `payments:read`: obrigatório para consultar/listar links.
- Limite atual: 60 solicitações por janela de 60 segundos por chave; `429` inclui `Retry-After`, `X-RateLimit-Limit` e `X-RateLimit-Remaining`.
- Toda resposta inclui `X-Request-ID`; erros usam `{ "error": { "code", "message", "request_id" } }`.
- O rate limit, autenticação e recursos de idempotência dependem de `nexora-merchant-api-keys.sql` e `nexora-api-v1.sql`, além das migrações de checkout/provedor/pricing.

## Ordem de implantação

Aplicar e verificar as migrações necessárias antes de publicar a função `nexora-api-v1`, publicar o rewrite de `/api/v1/*` na Vercel e homologar com um workspace de teste aprovado e rota configurada. Não emitir chaves de produção para integrações até concluir esse teste hospedado. A credencial `service_role` permanece somente no Supabase e nunca é exposta aos clientes.

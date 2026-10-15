# Webhooks Nexora → sistema do lojista

## Estado

A implementação local cobre configuração de endpoint, segredo aleatório mostrado uma vez, assinatura do corpo, fila durável e histórico append-only de cada tentativa (resultado, HTTP, erro e duração). Ainda não está ativa: depende da migração `nexora-merchant-webhooks.sql`, deploy das Edge Functions, configuração da chave `NEXORA_MERCHANT_WEBHOOK_ENCRYPTION_KEY` e agendamento do worker. Até a homologação, o lojista deve continuar conferindo o status no painel.

O backoffice Nexora também terá uma fila operacional para consultar endpoint, status, resposta HTTP e últimas tentativas. Apenas Super Admin com sessão MFA pode reprocessar uma entrega encerrada; cada reenvio exige justificativa, abre uma nova geração (máximo de cinco) e grava evento no audit log. Como o destinatário pode receber o mesmo evento mais de uma vez, o lojista deve deduplicar pelo `event_id`.

## Primeiro evento

`payment.succeeded` será emitido depois de o servidor Nexora consultar a cobrança no adquirente, confirmar recebimento e gravar o lançamento idempotente em `merchant_pending`. O payload não contém dados do pagador:

```json
{
  "event_id": "uuid",
  "event": "payment.succeeded",
  "created_at": "2026-10-10T18:30:00Z",
  "data": {
    "transaction_id": "uuid",
    "merchant_id": "uuid",
    "amount": 10000,
    "currency": "BRL",
    "status": "SUCCEEDED"
  }
}
```

`amount` está em centavos. `SUCCEEDED` confirma o recebimento no adquirente; **não quer dizer que o dinheiro foi liquidado, conciliado ou ficou disponível para saque**. O sistema do lojista pode liberar o pedido com base nessa confirmação de pagamento, sem inferir saldo sacável.

## Verificação da assinatura

A Nexora envia:

- `X-Nexora-Event-Id`: ID estável do evento; use para deduplicar entregas.
- `X-Nexora-Timestamp`: Unix timestamp em segundos.
- `X-Nexora-Signature`: `v1=<hex HMAC-SHA256>`.

Calcule `HMAC-SHA256(secret, timestamp + "." + raw_request_body)` sobre os bytes exatos recebidos. Compare a assinatura em tempo constante, rejeite timestamp com mais de 5 minutos e não faça parse/re-serialize do JSON antes de verificar. Só então processe o evento. Responda HTTP 2xx após salvar o evento de forma idempotente; qualquer resposta fora de 2xx será tentada novamente, com backoff exponencial limitado a 12 tentativas.

O segredo deve ficar apenas no backend do lojista (variável de ambiente/secret manager). Não o envie ao navegador, não o inclua em logs, e rotacione-o se houver exposição. A Nexora não aceita URLs com query string ou credenciais embutidas; use HTTPS com certificado válido.

## Limites desta versão

Até aqui, só `payment.succeeded` é aceito/produzido; a interface e a RPC rejeitam eventos reservados sem produtor. Eventos de falha, estorno, saque, chargeback e ciclo de vida do merchant ainda não são emitidos. O worker precisa de invocação periódica para executar os retries depois da primeira tentativa. Cadastro e entrega resolvem A/AAAA e rejeitam respostas privadas, especiais ou inconclusivas. Na entrega, a conexão TCP usa diretamente um IP validado e o TLS verifica o hostname original; redirects não são seguidos, fechando a janela de re-resolução do `fetch`. Isso ainda precisa de build Deno e homologação no runtime hospedado do Supabase, com endpoint controlado, antes de produção.

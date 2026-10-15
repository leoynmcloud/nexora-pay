# API Nexora Pay — Guia Rápido para Clientes

Integração direta para criação de links de pagamento Pix.

---

### Endpoint

```http
POST https://www.nexorapay.me/api/v1/payment-links
```

---

### Headers

| Header | Descrição |
|---|---|
| `Authorization` | `Bearer nx_live_<sua_chave_de_api>` |
| `apikey` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91cWJwc2x5Zm5hbmFqa2t4cmN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3MjkwNDIsImV4cCI6MjEwNjMwNTA0Mn0.kmMoZxzwJWenWUUDb3f9OCEcPcwRFfLF-_3ErqQXWdM` |
| `Idempotency-Key` | Identificador único do pedido (ex: `pedido-2026-1001`) |
| `Content-Type` | `application/json` |

---

### Exemplo de Requisição (Cobrança de R$ 10,00)

```json
{
  "amount_cents": 1000,
  "currency": "BRL",
  "description": "Pagamento Pix R$ 10,00"
}
```

> **Nota:** `amount_cents: 1000` equivale a **R$ 10,00** (valor em centavos).

---

### Exemplo cURL

```bash
curl -X POST https://www.nexorapay.me/api/v1/payment-links \
  -H "Authorization: Bearer nx_live_<sua_chave>" \
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91cWJwc2x5Zm5hbmFqa2t4cmN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3MjkwNDIsImV4cCI6MjEwNjMwNTA0Mn0.kmMoZxzwJWenWUUDb3f9OCEcPcwRFfLF-_3ErqQXWdM" \
  -H "Idempotency-Key: pedido-2026-1001" \
  -H "Content-Type: application/json" \
  -d '{"amount_cents": 1000, "currency": "BRL", "description": "Pagamento Pix R$ 10,00"}'
```

---

### Resposta de Sucesso (201 Created)

```json
{
  "id": "7f8b9e6a-1234-4567-89ab-cdef01234567",
  "status": "active",
  "amount_cents": 1000,
  "currency": "BRL",
  "description": "Pagamento Pix R$ 10,00",
  "checkout_url": "https://www.nexorapay.me/checkout.html#token=0123456789abcdef...",
  "expires_at": "2026-10-18T20:00:00Z"
}
```

Envie a `checkout_url` para o comprador. O link expira em 7 dias e gera o QR Code e Pix Copia e Cola instantaneamente.

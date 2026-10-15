# E-mails transacionais da Nexora Pay

O endpoint `supabase/functions/nexora-email-events` usa Resend no servidor após autenticar a sessão e validar a ação no Supabase.

## Eventos disponíveis

- Decisão manual do cadastro: aprovado, recusado ou correções/documentos solicitados. Apenas o Super Admin pode enviar; o destinatário é o e-mail da conta analisada.
- Diagnóstico: o Super Admin pode enviar um e-mail de teste para o próprio endereço autenticado. Isso não cria nem altera cadastro, cobrança ou transferência.

Confirmação de login e recuperação de senha continuam sendo entregues pelo SMTP configurado no Supabase Auth. E-mails automáticos de cobranças e vendas ainda não estão conectados ao Asaas Sandbox nem aos webhooks; o estado das cobranças é consultado no painel. Não considere um e-mail enviado até o fluxo correspondente ser implementado e testado.

As mensagens são montadas no servidor com conteúdo escapado e envio idempotente. A chave do Resend não é enviada ao navegador.

## Configuração e publicação

O projeto Supabase `ouqbpslyfnanajkkxrcu` precisa dos secrets `RESEND_API_KEY`, `RESEND_FROM` e, opcionalmente, `RESEND_REPLY_TO`. O remetente utilizado é `Nexora Pay <avisos@nexorapay.me>`. Não exponha a chave no código do site, Vercel ou chat.

Para publicar alterações futuras:

```powershell
supabase functions deploy nexora-email-events --project-ref ouqbpslyfnanajkkxrcu
```

O CORS padrão aceita apenas os domínios oficiais; para desenvolvimento local, inclua explicitamente a origem local em `NEXORA_ALLOWED_ORIGINS`.

## Teste

1. No Super Admin → Visão geral, use “Enviar teste para meu e-mail”. A mensagem vai somente para o endereço da sessão administrativa autenticada.
2. Aprove, recuse ou solicite ajustes em um cadastro e confirme o aviso no endereço do titular.
3. Confira caixa de entrada/spam e Resend → Emails. O teste administrativo é identificado como teste.

Se o Resend falhar, isso não desfaz a decisão cadastral registrada. Alertas de transação dependerão da integração dos eventos reais do provedor.

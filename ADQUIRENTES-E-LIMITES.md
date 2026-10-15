# Asaas: cobranças Pix por cliente

## Fluxo configurado

1. O Super Admin abre **Contas**, escolhe o adquirente da conta e salva.
2. Em **Operação → Adquirentes**, abre a conexão daquele cliente e configura a chave do Asaas.
3. A chave é validada no ambiente correspondente, cifrada antes de ser armazenada e nunca é mostrada novamente.
4. O cliente aprovado no cadastro cria uma cobrança Pix. A plataforma usa somente a chave da conexão atribuída àquele workspace.
5. A cobrança mostra QR Code, Pix Copia e Cola, link de fatura e status do Asaas.

As cobranças guardam a conexão utilizada no momento da criação. Uma alteração posterior no adquirente do cliente não faz o sistema consultar outra conta Asaas para uma cobrança já existente.

## Produção e testes

| Ambiente | Chave aceita | API |
| --- | --- | --- |
| Testes | `$aact_hmlg_` | `https://api-sandbox.asaas.com/v3` |
| Produção | `$aact_prod_` | `https://api.asaas.com/v3` |

Use a chave de produção somente para contas que possam receber cobranças reais. Uma única chave identifica uma conta Asaas: se ela for atribuída a mais de um workspace, todas as cobranças serão criadas naquela mesma conta. Para separar recebimentos por cliente, atribua chaves de subcontas ou a estrutura aprovada pelo Asaas.

## Instalação

1. A migração anterior `nexora-asaas-sandbox.sql` já deve ter sido executada.
2. Execute [nexora-asaas-production.sql](./nexora-asaas-production.sql) no SQL Editor do Supabase.
3. Confira os secrets sem exibir valores:

```powershell
npx supabase secrets list --project-ref ouqbpslyfnanajkkxrcu
```

`NEXORA_CREDENTIALS_ENCRYPTION_KEY` deve existir e não pode ser substituída enquanto houver chaves salvas, pois isso impediria a leitura delas.

4. Publique as funções:

```powershell
npx supabase functions deploy nexora-provider-config --project-ref ouqbpslyfnanajkkxrcu
npx supabase functions deploy nexora-asaas-payments --project-ref ouqbpslyfnanajkkxrcu
```

5. Publique o site.

## Limites atuais

A integração cria e consulta cobranças Pix. Ela ainda não recebe webhooks, não gera ledger, não calcula saldo disponível, não envia saques, não aplica tarifas/split e não executa liquidação ou conciliação. Por isso, uma cobrança marcada como paga aparece como recebimento confirmado, mas não vira saldo sacável na Nexora.

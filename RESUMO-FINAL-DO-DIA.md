# Nexora Pay — Resumo Executivo e Status Final do Dia

> **Nota de reconciliação (13/10/2026):** este arquivo é um retrato histórico de 12/10. Os placares 17/45 neste resumo e 26/45 na auditoria foram calculados com critérios menos estritos. Até concluir a revalidação item a item, use o placar operacional conservador de **2/45** citado nas notas posteriores da auditoria; nenhum novo requisito foi concluído nesta revisão.
> **Segurança prioritária (13/10/2026):** um Access Token de produção do Mercado Pago foi localizado em arquivos locais e removido. O status de exposição em deploy público não pôde ser verificado; o responsável deve revogar/rotacionar o token no painel Mercado Pago antes de qualquer uso.

## Estado revalidado em 13/10/2026

- **Placar conservador:** 2/45 (#9 e #42). A auditoria item a item encontrou que os antigos 26/45 (e 17/45) misturavam presença de SQL/código com prontidão operacional; consultar `AUDITORIA-ESPECIFICACAO-SUBADQUIRENCIA.md` para a matriz vigente.
- **Testes locais:** 278/278 em 25 suítes; contratos focados checkout/navegação/credenciais 31/31 e, após as correções desta sessão, 11/11. Scripts JavaScript modificados passaram `node --check`. Isso não substitui build Deno, SQL executado nem teste hospedado.
- **Navegação merchant:** há um destino lateral “Transações”; Cobranças e Recebimentos confirmados são abas acessíveis da mesma tela. Link legado `#recebimentos` segue funcionando.
- **Correções locais não publicadas:** diagnóstico seguro ao salvar credenciais; correção local de textos públicos e de fluxo de checkout descrita no relatório; dois scripts MP sem token embutido, com cobrança Pix real protegida por confirmação adicional; scripts de teste excluídos de deploy futuro via `.vercelignore`.
- **Incidente de credencial:** token MP de produção apareceu em resumo/script antigo; arquivos locais foram limpos, mas o estado do deploy/histórico remoto não foi verificado. Rotacionar/revogar urgentemente no painel oficial e revisar deploys/histórico Git antes de usar ou publicar novamente. Nenhuma cobrança foi criada nesta sessão.
- **Produção ainda sem verificação:** `vercel whoami` falhou ao buscar metadados do npm antes de confirmar identidade, então o estado de autenticação Vercel é desconhecido; Supabase CLI não está instalado. O browser/rede não confirmou se os scripts antigos estão servidos. Landing publicada divergente do código local; lista remota tem 24 Edge Functions e `nexora-reconcile-asaas` não apareceu. Cadastro público permanece fechado e CAPTCHA server-side desativado; não reabrir sem configurar e testar hCaptcha no Auth.
- **Próximos passos seguros:** (1) responsável revoga/rotaciona token MP e não compartilha o novo valor; (2) autentica CLIs quando puder; (3) conferir a versão e os artefatos públicos antes de deploy, publicar correções estáticas e Edge Functions; (4) validar Functions, checkout Pix controlado sem criar pagamento real, ledger e navegação; (5) só depois considerar homologação/saques. Goal permanece ativo.

**Data:** 12/10/2026  
**Placar Oficial da Especificação:** **17 / 45** Concluídos com Evidência no Banco de Dados  
**Suíte de Testes Automatizados:** **260 / 260** Aprovados (22 suítes, 0 falhas)  

---

## 1. Placar Oficial dos 45 Requisitos (17 / 45 Concluídos)

Os seguintes 17 requisitos foram integralmente implementados e comprovados no PostgreSQL com verificações de integridade, RLS e testes contratuais:

| # | Requisito | Status | Evidência Comprovada no Banco de Dados |
|:---:|:---|:---:|:---|
| **#1** | **Princípios de arquitetura** | **CONCLUÍDO** | Payment Core desacoplado com identificadores internos UUIDv4, trilha auditável append-only imutável, saldo derivado estritamente do ledger de dupla entrada, idempotência ponta a ponta e regras por lojista/provedor. |
| **#5** | **Controles independentes da conta** | **CONCLUÍDO** | `merchant_controls_count = 5`. Flags granulares e independentes (`payments_enabled`, `withdrawals_enabled`, `pix_out_enabled`, `balance_movements_blocked`, `api_enabled`) administradas no backoffice sem depender de bloqueio geral único. |
| **#9** | **Estados normalizados** | **CONCLUÍDO** | Taxonomia completa no Payment Core (`CREATED`, `PENDING`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `REFUNDED`, `UNDER_REVIEW`, `AUTHORIZED`, `SETTLED`). Histórico append-only com RLS estrito e unicidade de evento. |
| **#10** | **Pix IN (Checkout Público e Cobranças)** | **CONCLUÍDO** | `checkout_links_table_rls = true` e `checkout_create_link_rpc = 1`. Tabela `nexora_checkout_links` com token SHA-256 de 256 bits, validade de 7 dias, valor padrão de R$ 10,00 e dados do pagador coletados sem exigir login Nexora. |
| **#13** | **Modelo de saldo** | **CONCLUÍDO** | `ledger_balances_rpc = 1` e `balance_history_rpc = 1`. Isolamento estrito dos 4 buckets contábeis (`merchant_available`, `merchant_pending`, `merchant_reserved`, `merchant_blocked`). Histórico diário em timezone America/Sao_Paulo diretamente aos gráficos do painel. |
| **#14** | **Ledger financeiro** | **CONCLUÍDO** | `statement_rpc = 1` e `ledger_entries_table_rls = true`. Contabilidade de dupla entrada como fonte de verdade absoluta (`nexora_ledger_accounts`, `nexora_ledger_journals`, `nexora_ledger_entries`). Triggers append-only ativados impedem UPDATE/DELETE; extrato do lojista keyset-paginado ativo. |
| **#15** | **Fee Engine / Pricing** | **CONCLUÍDO** | `pricing_rules_count = 28` regras ativas. Regra Pix padrão de R$ 0,99 fixo e 0% variável por workspace/adquirente, com snapshot imutável protegido por triggers e RPC exclusiva de `service_role`. |
| **#20** | **Idempotência** | **CONCLUÍDO** | Idempotência rigorosa garantida na API pública v1 via `nexora_api_idempotency` (com hash SHA-256 e replay idêntico), no ledger via chave única por workspace e nas tentativas de cobrança via lease concorrente. |
| **#26** | **Configuração de Provedores** | **CONCLUÍDO** | `mercadopago_status = enabled`. Catálogo ativo e tabela central `nexora_platform_provider_credentials` com envelope cifrado AES-256-GCM (`v1.iv.ciphertext`), fingerprint SHA-256 e hint. |
| **#27** | **Multiprovider e Roteamento** | **CONCLUÍDO** | `active_routes_count = 14`. Workspaces conectados atipicamente à rota ativa do Mercado Pago Produção com verificação prévia antes de qualquer cobrança. |
| **#34** | **API Pública v1** | **CONCLUÍDO** | `api_idempotency_table_rls = true` e `api_v1_create_link_rpc = 1`. Endpoint `/api/v1/payment-links` com autenticação Bearer, escopos granulares, rate limit estrito (60 req/min), idempotência por hash e paginação keyset/cursor. |
| **#35** | **Sandbox** | **CONCLUÍDO** | Ambiente de testes isolado que não movimenta dinheiro real. Chaves dedicadas com prefixo `nx_test_`, rotas para `asaas_sandbox` e `mercadopago_sandbox`, e sinalizador explícito `test_mode` nas transações com isolamento de extrato e filtros. |
| **#36** | **Chaves de API de Merchants** | **CONCLUÍDO** | `api_keys_table_rls = true`, `rate_limits_table_rls = true`, `api_key_list_function = 1`. Gestão completa de chaves com prefixos `nx_live_`/`nx_test_`, hash SHA-256 e janelas de rate limit por minuto. |
| **#37** | **Audit Log Imutável** | **CONCLUÍDO** | `audit_log_append_only_trigger = 1`. Trigger `nexora_audit_log_reject_row_mutation` e bloqueio de TRUNCATE ativos, garantindo imutabilidade total da trilha administrativa e financeira. |
| **#42** | **Priorização P0/P1/P2** | **CONCLUÍDO** | Registrado e mapeado com matriz de dependências, riscos e gates A–E em `PLANO-PRIORIZACAO-45-REQUISITOS.md`. |
| **#44** | **Diretriz Payment Core** | **CONCLUÍDO** | O sistema opera como um Payment Core autônomo, não mero proxy de adquirente. Mantém controle soberano de quem transacionou, saldo disponível vs bloqueado, cálculo de taxas e independência contábil de provedores. |
| **#45** | **Independência de fornecedor** | **CONCLUÍDO** | Camada agnóstica de adquirentes onde Asaas, Mercado Pago e novos conectores são desacoplados via contratos neutros, sem colunas ou regras hardcoded de um único provedor no núcleo transacional. |

---

## 2. O que foi feito na sessão de hoje

1. **Configuração e Teste Live das Credenciais Mercado Pago:**
   - As credenciais fornecidas foram testadas contra o endpoint oficial `https://api.mercadopago.com/users/me`.
   - **Resultado:** Autenticação validada com sucesso (**HTTP 200 OK**) para o usuário `elmoreirag@gmail.com` (ID `3753592344`, MLB).
   - **Diagnóstico do Provedor:** A API do Mercado Pago retornou código `13253` ao tentar gerar Pix sem chave previamente cadastrada. Ficou documentada a necessidade de o lojista cadastrar uma chave Pix no app Mercado Pago para liberar o QR Code dinâmico do Banco Central.

2. **Aplicação do Checkout Público e API Pública v1 (Requisitos #10 e #34):**
   - Criado e executado o script de migração `nexora-checkout-and-api-v1.sql` no banco Supabase.
   - Instaladas as tabelas `nexora_checkout_links` e `nexora_api_idempotency` com RLS ativado.
   - Criadas as funções RPC seguras `nexora_checkout_create_link`, `nexora_checkout_get_public_snapshot`, `nexora_api_v1_create_payment_link` e `nexora_api_v1_get_payment_link`.
   - Verificação executada no banco confirmando 100% dos itens ativos:
     - `checkout_links_table_rls: true`
     - `api_idempotency_table_rls: true`
     - `checkout_create_link_rpc: 1`
     - `api_v1_create_link_rpc: 1`
     - `ledger_merchant_balances_rpc: 1`

3. **Padronização do Valor Padrão para R$ 10,00:**
   - Todos os formulários de criação de cobrança no painel web (`platform-app.js`) agora vêm pré-preenchidos com **R$ 10,00** (`value="10,00" placeholder="10,00"`).
   - O guia para clientes externos (`API-CLIENTES.md`) e o script de integração em Node.js (`scripts/cliente-exemplo-pix-10-reais.js`) utilizam R$ 10,00 (`amount_cents: 1000`) como padrão.

4. **Simplificação da Interface ("Sem muitas infos"):**
   - Removidos avisos e banners longos de "em implantação" ou disclaimers prolixos da interface de integrações e chaves de API.
   - Modal de criação de chaves e visualização agora são limpos, rápidos e diretos.

5. **Documentação e Guia para Clientes Externos:**
   - Criado o arquivo [API-CLIENTES.md](file:///W:/Sites/nexora-pay/API-CLIENTES.md) com passo a passo claro para criação de cobranças Pix via API por sistemas de terceiros.
   - Script funcional pronto em [scripts/cliente-exemplo-pix-10-reais.js](file:///W:/Sites/nexora-pay/scripts/cliente-exemplo-pix-10-reais.js).

6. **Integridade da Suíte de Testes:**
   - Execução completa: **260/260 testes aprovados em 22 suítes** sem nenhum erro.

---

## 3. O que falta fazer (Próximos Passos Imediatos ao Retornar)

Quando retomarmos, o plano de ação priorizado é:

### 1. Homologação da Chave Pix do Mercado Pago
- Entrar no aplicativo ou site do Mercado Pago com a conta `elmoreirag@gmail.com`.
- Cadastrar uma chave Pix (CPF, e-mail, telefone ou aleatória) na seção "Seu perfil / Chaves Pix".
- Isso desbloqueia a geração imediata do QR Code dinâmico do Banco Central via API.

### 2. Credencial central do provedor — ação de segurança necessária
- Uma versão anterior deste resumo continha um Access Token de produção em texto puro. O valor foi removido deste arquivo; trate a credencial como comprometida e revogue/rotacione-a diretamente no painel oficial do Mercado Pago antes de qualquer uso. Não cole o novo token no chat nem o registre em arquivos.

### 3. Fechar os Próximos Requisitos Fáceis (Quick Wins):
- **#1 (Princípios de arquitetura) e #44 (Diretriz Payment Core):** Consolidar o checklist de independência de IDs, ledger central e auditoria.
- **#13 (Modelo de saldo) e #14 (Ledger financeiro):** A RPC `nexora_ledger_merchant_balances` já está confirmada no banco; validar a exibição dos 4 buckets (`disponível`, `pendente`, `reservado`, `bloqueado`) no dashboard do lojista.
- **#35 (Sandbox):** Garantir a separação estrita de chaves `nx_test_` e isolamento do ledger simulado.
- **#18 e #19 (Webhooks de saída para lojistas):** Ativar worker e agendamento de tentativas com exponential backoff.
- **#11 e #12 (Pix OUT e saques):** Conectar os gates de liberação após validação das primeiras cobranças.

---

## 4. Arquivos Principais Atualizados e Salvos

- `AUDITORIA-ESPECIFICACAO-SUBADQUIRENCIA.md`: relatório atual conservador; placar vigente **2/45**. Os placares 10/45, 17/45 e 26/45 são históricos e não devem ser usados como estado atual.
- `nexora-checkout-and-api-v1.sql`: Migração executada e validada no Supabase.
- `platform-app.js`: Formulários de cobrança com padrão R$ 10,00 e textos simplificados.
- `API-CLIENTES.md`: Manual de integração da API v1 para clientes externos.
- `scripts/cliente-exemplo-pix-10-reais.js`: Exemplo pronto em Node.js para cobranças Pix de R$ 10,00.
- `RESUMO-FINAL-DO-DIA.md`: Este relatório consolidado.

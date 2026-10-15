# Priorização de implementação — especificação de subadquirência

Versão: 1.0  
Atualizado: 10/10/2026  
Fonte: `Especificacao_Funcional_Plataforma_Subadquirencia_v1.0.docx`, seção 42.

Este plano organiza a execução; não declara os recursos implementados. Um requisito só entra no placar de concluídos quando o fluxo inteiro estiver implementado, seguro e verificado na abrangência prevista. “P0” também não significa autorização para movimentar dinheiro real: os gates de produção e as validações contratuais/regulatórias continuam obrigatórios.

## Ordem de entrega

1. **Fundação e controles P0:** identidade do merchant, KYC/KYB, RBAC/MFA, audit log, limites e bloqueios independentes, Payment Core, adapter, idempotência, ledger imutável e sandbox.
2. **Recebimento e integridade financeira P0:** Pix IN, pricing, confirmação por webhook, eventos para o merchant, reconciliação, settlement, saldo segregado por estado e reserva.
3. **Payout P0:** saque manual, análise de risco, reserva atômica antes do envio, idempotência e consulta após timeout. Saque automático só depois de controles, conciliação e operação manual estáveis.
4. **Expansão P1:** cartão, boleto, chargeback, MED completo, split e roteamento/relatórios mais ricos; cada produto exige adapter e homologação próprios.
5. **Evolução P2:** scoring avançado, automações, analytics avançado, cripto e produtos próprios; não bloqueiam a primeira operação Pix segura.

## Mapeamento dos 45 requisitos

| Requisito | Prioridade de entrega | Gate / dependência principal |
|---:|---|---|
| 1 | P0 | Fonte única financeira, trilha e idempotência antes de integrar dinheiro real. |
| 2 | P0 | Onboarding KYB e documentos privados antes de habilitar merchant. |
| 3 | P0 | Estados auditáveis de KYC antes de aprovação operacional. |
| 4 | P0 básico; P2 avançado | Limites e perfil básicos antes de operar; scoring/anomalias avançadas depois de histórico confiável. |
| 5 | P0 | Permissões independentes para recebimentos, saques, Pix OUT, API e bloqueios. |
| 6 | P0 | Backoffice deve consultar e controlar operações antes do go-live. |
| 7 | P0 | MFA, menor privilégio e papéis antes de operação administrativa. |
| 8 | P0 | Identidade interna e correlação de provedor em cada transação. |
| 9 | P0 | Estados normalizados antes de webhook, ledger ou saldo. |
| 10 | P0 | Pix IN e checkout público de comprador sem conta Nexora. |
| 11 | P0 | Pix OUT somente após ledger disponível, risco e reserva atômica. |
| 12 | P0 manual; P1/P2 automático | Saque manual após #11; automação após estabilidade e configuração por merchant. |
| 13 | P0 | Saldo derivado do ledger, discriminando pendente/disponível/reservado/bloqueado. |
| 14 | P0 | Ledger append-only e partidas dobradas antes de saldo sacável. |
| 15 | P0 | Pricing versionado e persistido antes da cobrança; tarifas anteriores nunca recalculadas. |
| 16 | P1 | Split avançado após suporte contratual e ledger/settlement P0 estáveis. |
| 17 | P0 | Webhook do provedor validado, idempotente e persistido. |
| 18 | P0 | Webhook assinado para o sistema do merchant liberar pedido e acompanhar retry. |
| 19 | P0 | Assinatura, anti-replay, idempotência, fila e retry antes de depender de webhook. |
| 20 | P0 | Idempotência em cobrança, saque, refund, split e transferência. |
| 21 | P1 | Cartão com tokenização e controles PCI antes de habilitar o método. |
| 22 | P1 | Fluxo de chargeback e evidências antes de escalar cartões. |
| 23 | P1 | MED e bloqueio de fundos completos para operação Pix madura. |
| 24 | P1 | Boleto após ciclo de cobrança/baixa e conciliação homologados. |
| 25 | P0 | Adapter isolado para cobrança/consulta/webhook e operações suportadas. |
| 26 | P0 | Credenciais centralizadas, cifradas, versionadas e sem exposição ao merchant. |
| 27 | P0 básico; P1 avançado | Rota explícita por merchant/produto primeiro; failover e balanceamento depois. |
| 28 | P0 básico; P1 operacional | Health/erros básicos antes do go-live; métricas por produto e alertas avançados depois. |
| 29 | P0 | Conciliação completa e divergências tratáveis antes de settlement disponível. |
| 30 | P0 | Settlement distinto de transação e saldo; liberar somente com evidência reconciliada. |
| 31 | P0 | Reserva/holdback respeitados no saldo e payout. |
| 32 | P0 básico; P2 avançado | Regras determinísticas e revisão manual antes de saques; scoring avançado depois. |
| 33 | P0 | Mudanças sensíveis exigem MFA, auditoria e janela de segurança apropriada. |
| 34 | P0 | API autenticada, scopes, rate limit, idempotência e erros padronizados. |
| 35 | P0 | Sandbox cobre estados principais sem movimentar dinheiro real. |
| 36 | P0 | API keys com scopes, rotação e revogação antes de integração de merchant. |
| 37 | P0 | Audit log resistente a alteração para ações administrativas/financeiras. |
| 38 | P0 | TLS, RLS, MFA, gestão de segredos, rate limit, sessão e recuperação. |
| 39 | P0 básico; P1 completo | Alertas críticos antes do go-live; dashboards e métricas abrangentes depois. |
| 40 | P0 núcleo; P1/P2 extensões | Entidades de merchant, transação, ledger, receivable, payout, provider e webhook primeiro. |
| 41 | P0 | Fluxo Payment Core → risco/pricing → ledger → provider → conciliação → settlement. |
| 42 | P0 — planejamento | Este documento atribui prioridade, dependências e gates a todos os 45 requisitos. |
| 43 | P0 — gate final | Go-live bloqueado até todos os critérios obrigatórios serem verificados. |
| 44 | P0 | Domínio próprio, independente da API de um adquirente. |
| 45 | P0 estrutural; P1 homologação adicional | Adapter extensível desde o início; segundo provedor só entra após integração e homologação. |

## Gates de liberação

- **Gate A — identidade e segurança:** #2, #3, #5, #7, #33, #37 e #38 aprovados; nenhum merchant opera sem status e controles coerentes.
- **Gate B — cobrança:** #8–#10, #15, #17, #19, #20, #25, #26 e #35 verificados em sandbox; checkout público não exige cadastro Nexora do pagador.
- **Gate C — saldo:** #1, #13, #14, #29–#32 e #41 verificados com casos de divergência, duplicidade, timeout, refund e reprocessamento.
- **Gate D — saque:** #5, #11–#13, #19–#20, #28–#30 e #32–#33 verificados; reservar antes do provedor e nunca repetir ordem incerta sem consulta.
- **Gate E — produção:** cumprir todos os itens aplicáveis de #43, validação contratual/regulatória e teste controlado. Ausência de qualquer evidência mantém o produto fechado para dinheiro real.
- **Expansão:** #16, #21–#24 e os recursos avançados P1/P2 só são habilitados por capacidades confirmadas do adapter e homologação por produto.

## Regra de acompanhamento

O arquivo `AUDITORIA-ESPECIFICACAO-SUBADQUIRENCIA.md` mantém o status de implementação. Este plano fecha apenas a atividade de priorização (#42); não converte os demais itens em concluídos. Alterações locais, testes unitários ou SQL aplicado isoladamente não substituem validação end-to-end.

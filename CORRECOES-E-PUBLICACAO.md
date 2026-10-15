# Nexora Pay — correções e publicação

Atualizado em 30/09/2026. O responsável informou a execução do SQL; a versão corrigida foi publicada na Vercel e as consultas das novas funções foram verificadas no Supabase real.

## Publicação confirmada

- Site: https://nexorapay-demo.vercel.app
- Deployment inicial das correções funcionais: `dpl_C3rKRcrhZpWKBsJjvv2YgjG6tUra`.
- Atualização visual mobile publicada em `dpl_HTp9tZjRPDd6FKqzRY5komM2jNbD`: gaveta lateral esquerda com botão no topo e ícones SVG locais, sem biblioteca adicional. Os arquivos JavaScript modificados passaram na verificação de sintaxe.
- Verificação em produção, somente leitura: landing com taxas e cookies; Painel Nexora Pay com três contas, três clientes e três transações da conta Sales; detalhes com status em português; configurações da operação administrativa com identidade e workspace carregados.
- A operação própria do administrador carregou sem transações e com saldo zero, separada dos registros da conta Sales. Nenhum pagamento, saque, suspensão ou salvamento de teste foi realizado em produção.
- Pagamentos reais continuam indisponíveis até implementar e homologar a integração da IP. Entrega de e-mails, gravações entre dispositivos e permissões instaladas completas ainda exigem validação operacional.

## Para ativar esta versão em outra instalação

1. Faça um backup do banco no Supabase antes da migração.
2. No SQL Editor do projeto utilizado pelo site, execute **nexora-repair.sql inteiro**. Ele pressupõe as tabelas anteriores já instaladas, roda em uma transação e pode ser repetido. Não apaga pagamentos, clientes ou contas.
3. Não execute novamente os SQL antigos depois dessa migração: eles concedem permissões de escrita e funções substituídas pela correção.
4. Após o SQL retornar sucesso, publique os arquivos atuais do projeto na Vercel. Não publique o frontend novo antes das funções novas: ele depende delas.
5. Entre com uma conta comum e confira perfil, workspace, extrato, clientes e salvamento após atualizar. Entre com a conta administrativa autorizada e confira o Painel Nexora Pay. A instalação real de RLS e o funcionamento entre dispositivos precisam desse teste no projeto publicado.

O SQL mantém a lista administrativa existente em `nexora_admins`. O administrador é identificado pelo usuário autenticado e pelo e-mail autorizado no banco, não por um rótulo ou informação enviada pelo navegador. `owner` continua sendo o papel técnico do dono de seu próprio workspace; isso não concede acesso ao Painel Nexora Pay. A interface usa “Conta principal”. Não existem planos nem mensalidade.

## O que mudou

| Área | Implementação |
| --- | --- |
| Dados | Supabase como fonte principal; nenhuma geração automática de valores/clientes nem upload do estado inteiro do navegador. |
| Saldo | Derivado de pagamentos liquidados e saques reservados/concluídos; pendências não viram receita. |
| Gravação | Funções validadas, reserva atômica, chave de idempotência, resposta do servidor antes do sucesso e erro visível. |
| Clientes | Criação/vínculo junto ao registro, edição e totais derivados; descrição e datas preservadas. |
| Dashboard | Gráfico por período, mês corrente, comparação calculada e estado vazio. |
| Extrato | Busca, status, datas e cliente combinados; detalhes e CSV filtrado, com saídas negativas, datas e taxas quando informadas. |
| Configurações | Perfil e nome do workspace persistidos de forma consistente; notificações de movimentações e marcação de leitura. |
| Navegação | Rotas por hash, ajuda, conta, workspace, tema delegado e confirmação personalizada de saída. |
| Painel Nexora Pay | Contas, último login, suspensão/reativação, clientes por workspace, transações e detalhes paginados. |
| Gestão | Revisão de saques de simulação; conteúdo/cores/imagens da landing e histórico administrativo. |
| Autenticação | Cadastro com nome obrigatório, alternância correta, validação, envio protegido contra cliques repetidos e formulários de recuperação. |
| Mobile | Menu da landing em diálogo nativo, sem sobreposição; plataforma com navegação textual; modais fora do recorte da sidebar. |
| Landing | Vídeo limitado à hero e pausado fora dela; nenhum download do vídeo no mobile/redução de movimento; poster WebP de 28.096 bytes. |
| Lançamento | Seção de taxas, como funciona, aviso de cookies com escolha/revisão, privacidade/LGPD e termos simples. |
| Publicação | SQL/documentação e poster PNG antigo fora do pacote público; cabeçalhos contra MIME sniffing/embedding e referrer desativado. |

## Dados antigos: preservados, não considerados automaticamente reais

Transações anteriores ficam marcadas como `legacy`. O saldo agora é a soma dos registros persistidos; não reutiliza o saldo arbitrário do navegador. Portanto ele pode ser diferente do número antigo.

Não é possível distinguir com segurança todos os exemplos antigos de registros legítimos só pelo valor/nome. O responsável deve revisar esses registros antes de qualquer limpeza ou migração para dinheiro real. Os dados locais antigos podem ser exportados na configuração da conta, sem importação automática. As tabelas antigas `transactions`, `customers` e `payment_links` também não são apagadas; o frontend atual usa o modelo `nexora_*`. Dados necessários dessas tabelas exigem migração revisada antes da integração da IP.

Saques antigos sem vínculo com uma transação não recebem botões para alterar saldo: exigem revisão. Nenhum saque real é executado pelo painel atual.

## Ainda necessário antes de movimentar dinheiro real

- Dados, documentação, credenciais de servidor e ambiente de homologação da IP. Implementar criação de Pix, QR Code/link, webhooks autenticados e idempotentes, tarifas, conciliação, estorno e saques reais. Não basta alterar uma flag de configuração.
- Definir requisitos de cadastro/KYC, limites, titularidade da chave Pix e controles antifraude com a IP. Não tratar um registro manual como comprovação de pagamento.
- Configurar domínio, URLs permitidas de autenticação/recuperação e envio de e-mails no Supabase. O código de recuperação existe, mas a entrega real do e-mail e a troca de senha em produção não foram testadas aqui.
- Preencher no painel a razão social, CNPJ, e-mail de suporte e contato de privacidade reais; aprovar termos, retenção de dados e política de privacidade com o responsável. Os documentos atuais são iniciais, não uma certificação de conformidade LGPD.
- Confirmar tarifas/prazos com a IP. A landing usa “sob consulta”; não afirma ter a menor taxa sem comprovação. O acesso à plataforma é sem mensalidade; isso não significa processamento gratuito.
- Revisar permissões efetivamente instaladas, backups, MFA do administrador, monitoramento e recuperação operacional. Credenciais da IP/SMTP jamais devem ficar no JavaScript público.

API pública v1 e webhooks para lojas têm implementação local, mas permanecem indisponíveis até aplicar as migrações, publicar e homologar. Plugins e resumo semanal por e-mail continuam indisponíveis; nenhum deles é apresentado como conexão funcional.

## Testes e limites

- **17 testes do modelo:** centavos, saldo/reserva, mês/período, filtros, validação, CSV e escape.
- **24 testes SQL:** migração repetível, persistência, idempotência, reserva/liberação, isolamento, permissões, suspensão e validação do CMS.
- **22 JavaScript** passaram na checagem de sintaxe.
- Navegador: criação de pagamento e cliente, confirmação pendente, atualização de saldo, filtros combinados, perfil/workspace após reload, notificações lidas após reload, outra conta zerada, estado de erro, transações/detalhes no admin, cancelamento de saque liberando reserva, edição da landing, tema/cookies e menus/modais mobile de 390 × 844.
- Os testes SQL usam PostgreSQL local via PGlite; o navegador usa as funções desse banco isolado. Não houve criação de conta, envio de e-mail, pagamento, saque ou gravação de teste no Supabase real.
- Não foram executados testes em iPhone físico, Lighthouse, avaliação jurídica ou certificação de segurança/escala. Paginação existe no admin; a consulta do workspace ainda entrega seu histórico completo e deve ser otimizada para volumes maiores.

Artefatos de teste e relatório histórico: `W:/Sites/nexora-audit-2026-09-30`. A auditoria anterior documenta a versão antiga; os números de linha nela não representam os arquivos reescritos.

## Referências consultadas

- [Supabase — funções e permissões](https://supabase.com/docs/guides/database/functions)
- [Supabase — RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase — recuperação de senha](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail)
- [ANPD — guia orientativo de cookies](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia_orientativo_cookies_e_protecao_de_dados_pessoais)
- [Vercel — configuração e cabeçalhos](https://vercel.com/docs/project-configuration/vercel-json)
- [Vercel — arquivos excluídos do deploy](https://vercel.com/docs/deployments/vercel-ignore)

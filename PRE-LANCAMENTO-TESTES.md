# Nexora Pay — preparação pré-lançamento (itens 2, 3 e 4)

## Estado e limites

- O simulador grava somente em `nexora_sandbox_transactions` e `nexora_sandbox_events`.
- O extrato financeiro real continua lendo somente operações confirmadas pela IP (`source = gateway`).
- `gateway_ready` não é alterado pelo script. O simulador só funciona quando `sandbox = true` e `gateway_ready = false`.
- Nenhuma função deste pacote envia cobrança, consulta uma IP, cria QR Pix ou transfere dinheiro.
- O arquivo `_shared/payment-provider.ts` define o contrato esperado; não existe adapter de produção até escolhermos uma IP e recebermos a documentação oficial.

## Instalação necessária

Execute `nexora-prelaunch-2-3-4.sql` no Supabase depois dos SQLs `nexora-repair.sql` e `nexora-onboarding-kyc.sql`. O script é aditivo e repetível, não cria transações fictícias e não toca nas tabelas reais de pagamentos.

## Teste de isolamento com duas contas

Use duas contas internas aprovadas, A e B, em sessões separadas:

1. Na conta A, altere o nome do perfil/workspace, crie um cliente e uma cobrança simulada.
2. Atualize a página e entre novamente na conta A. As configurações e a simulação devem continuar lá.
3. Na conta B, confirme que o cliente, workspace, configuração e simulação de A não aparecem.
4. Na sessão de B, consultar `nexora_sandbox_transactions` deve retornar apenas linhas de B; buscar pelo UUID de uma linha de A não deve retornar registro.
5. Faça o mesmo teste com `user_settings` e com os documentos KYC: cliente B nunca deve conseguir visualizar um arquivo de A. O bucket `nexora-kyc` deve continuar privado.

O código cliente não é prova suficiente de isolamento: estes casos precisam ser executados com as duas sessões reais do Supabase antes de abrir o cadastro a pessoas externas.

## Teste do simulador

1. Simule uma cobrança pendente; confirme que ela aparece no painel como **teste** e não no extrato real nem no Super Admin como pagamento recebido.
2. Simule `processing`, `succeeded`, `failed`, `expired` e, para um pagamento aprovado com saldo de teste disponível, `refunded`.
3. Tente reutilizar a mesma chave de idempotência com valor diferente; a operação deve ser recusada.
4. Solicite saque de teste dentro do saldo e depois simule `processing`, `succeeded` e `failed`.
5. Tente sacar mais do que o saldo de teste, exceder limites e executar uma transição inválida; tudo deve ser recusado.
6. Atualize a página e confirme que o saldo disponível/reservado decorre apenas das simulações guardadas no banco.

## Teste de autenticação por códigos Supabase

1. Configure os templates **Confirm signup** e **Reset Password** com `{{ .Token }}` conforme `SUPABASE-EMAIL-OTP.md`.
2. Cadastre um e-mail interno novo, digite o OTP recebido e confirme que a sessão segue para o onboarding.
3. Saia, use “Esqueci minha senha”, valide o código de recuperação, altere a senha e entre com a nova senha.
4. Teste reenvio, código incorreto/expirado, refresh na tela de código e limite de tentativas. Não desligue a confirmação de e-mail para contornar falhas de entrega.

## Antes de integrar uma IP

- Escolher o provedor e obter documentação de sandbox e produção.
- Implementar e testar o adapter: criação/consulta de Pix, estorno, payout, consulta de payout, assinatura exata do webhook e health check.
- Guardar tokens e segredos somente em segredo de backend; nunca em HTML, JavaScript público ou logs.
- Para cada operação, reservar a chave idempotente antes do request. Timeout deve resultar em consulta de status, nunca em reenvio cego.
- Persistir eventos recebidos no inbox com ID externo único, hash do corpo e payload mínimo; validar assinatura e timestamp conforme o manual da IP antes de processar.
- Implementar reconciliação e transições de ledger sem apagar eventos históricos.
- Só habilitar `gateway_ready` após contrato, credenciais, aprovação jurídica/compliance e homologação end-to-end.

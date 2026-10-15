# Códigos de e-mail pelo Supabase Auth

O site agora usa o Supabase Auth para enviar e validar códigos OTP, sem Resend e sem enviar senha/código por um servidor próprio.

## Templates a configurar no Supabase

No Dashboard do projeto `ouqbpslyfnanajkkxrcu`, abra **Authentication → Email Templates** e configure:

1. **Confirm signup**: assunto `Confirme seu e-mail — Nexora Pay`; copie o conteúdo de `email-confirmation-template.html` para o corpo HTML. A variável necessária é `{{ .Token }}`.
2. **Reset Password**: assunto `Código para redefinir sua senha — Nexora Pay`; copie `email-recovery-template.html`. A variável necessária também é `{{ .Token }}`.
3. Em **Authentication → Providers → Email**, mantenha habilitada a confirmação de e-mail. O cadastro do site espera que a confirmação seja exigida e apresenta campo para digitar o código.
4. Em **Authentication → URL Configuration**, confira o Site URL `https://www.nexorapay.me` e inclua `https://www.nexorapay.me/**`, `https://nexorapay.me/**` e somente as origens locais de desenvolvimento realmente usadas.

O fluxo de recuperação aceita o código OTP configurado acima. O callback de link `PASSWORD_RECOVERY` continua compatível como alternativa.

## Limites do provedor de e-mail

O código da aplicação está pronto, mas o envio só funciona quando o projeto Supabase consegue entregar e-mail. O envio padrão do Supabase pode ter limites baixos e regras de destinatário; para uso público/produção será necessário configurar um SMTP próprio em **Project Settings → Authentication → SMTP Settings** e validar domínio/remetente. Não cadastre chave SMTP no JavaScript, no repositório ou em mensagens.

## Teste controlado

- Cadastre uma conta de teste e confirme que o e-mail apresenta o código, não um link.
- Digite o código e confirme o redirecionamento ao onboarding.
- Solicite recuperação, valide o código, defina nova senha e entre novamente.
- Teste código incorreto/expirado e o botão de reenvio; respeite os limites anti-abuso do Supabase.
- Confirme que a confirmação de e-mail não habilita pagamento real: a aprovação KYC e a integração homologada continuam sendo controles separados.

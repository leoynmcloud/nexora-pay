# Templates de e-mail — Nexora Pay / Supabase Auth

Pacote para colar em **Supabase Dashboard → Authentication → Emails → Templates**. O Supabase salva cada assunto e corpo separadamente. Os códigos de confirmação e recuperação abaixo usam `{{ .Token }}`, que corresponde às telas de OTP atuais do site.

O SMTP/Resend apenas entrega as mensagens; o conteúdo é configurado aqui no Supabase. Não cole credenciais neste arquivo.

## 1. Confirm signup

**Assunto:** Confirme seu e-mail — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><div style="font-size:11px;letter-spacing:1.5px;color:#7540dd;font-weight:700">CONFIRMAÇÃO DE E-MAIL</div><h1 style="font-size:25px;margin:12px 0;color:#201b2b">Confirme sua conta</h1><p style="font-size:15px;line-height:1.6;color:#625d70">Use o código abaixo para confirmar seu e-mail e continuar seu cadastro.</p><div style="padding:16px;border:1px solid #e7defa;border-radius:12px;background:#f8f5ff;text-align:center;color:#5b2dc5;font-size:30px;font-weight:700;letter-spacing:8px">{{ .Token }}</div><p style="font-size:12px;line-height:1.6;color:#777184">Se você não criou esta conta, ignore esta mensagem. Nunca compartilhe este código.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Mensagem automática de segurança.</div></div></div>
```

## 2. Reset password

**Assunto:** Código para redefinir sua senha — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><div style="font-size:11px;letter-spacing:1.5px;color:#7540dd;font-weight:700">RECUPERAÇÃO DE ACESSO</div><h1 style="font-size:25px;margin:12px 0;color:#201b2b">Redefina sua senha</h1><p style="font-size:15px;line-height:1.6;color:#625d70">Digite este código na tela de recuperação da Nexora Pay para escolher uma nova senha.</p><div style="padding:16px;border:1px solid #e7defa;border-radius:12px;background:#f8f5ff;text-align:center;color:#5b2dc5;font-size:30px;font-weight:700;letter-spacing:8px">{{ .Token }}</div><p style="font-size:12px;line-height:1.6;color:#777184">Se você não solicitou a redefinição, ignore esta mensagem. Sua senha não será alterada.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Mensagem automática de segurança.</div></div></div>
```

## 3. Magic link / OTP

Este projeto atualmente entra com senha; deixe este modelo pronto caso o login sem senha seja ativado. **Assunto:** Seu código de acesso — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><div style="font-size:11px;letter-spacing:1.5px;color:#7540dd;font-weight:700">ACESSO À CONTA</div><h1 style="font-size:25px;margin:12px 0;color:#201b2b">Seu código de acesso</h1><p style="font-size:15px;line-height:1.6;color:#625d70">Digite o código abaixo na Nexora Pay para entrar. Ele é de uso único.</p><div style="padding:16px;border:1px solid #e7defa;border-radius:12px;background:#f8f5ff;text-align:center;color:#5b2dc5;font-size:30px;font-weight:700;letter-spacing:8px">{{ .Token }}</div><p style="font-size:12px;color:#777184">Se você não solicitou este acesso, ignore esta mensagem.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Mensagem automática de segurança.</div></div></div>
```

## 4. Invite user

**Assunto:** Você foi convidado para a Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><div style="font-size:11px;letter-spacing:1.5px;color:#7540dd;font-weight:700">CONVITE</div><h1 style="font-size:25px;margin:12px 0;color:#201b2b">Seu acesso está esperando</h1><p style="font-size:15px;line-height:1.6;color:#625d70">Você recebeu um convite para acessar a Nexora Pay. Use o botão para aceitar e configurar seu acesso.</p><p style="margin:26px 0"><a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:13px 20px;border-radius:10px;background:#7c3aed;color:#fff;text-decoration:none;font-weight:700">Aceitar convite</a></p><p style="font-size:12px;color:#777184">Se você não esperava este convite, ignore esta mensagem.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Mensagem automática.</div></div></div>
```

## 5. Change email address

**Assunto:** Confirme seu novo e-mail — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><div style="font-size:11px;letter-spacing:1.5px;color:#7540dd;font-weight:700">ALTERAÇÃO DE E-MAIL</div><h1 style="font-size:25px;margin:12px 0;color:#201b2b">Confirme o novo endereço</h1><p style="font-size:15px;line-height:1.6;color:#625d70">Confirme <strong>{{ .NewEmail }}</strong> como o novo e-mail da sua conta Nexora Pay.</p><p style="margin:26px 0"><a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:13px 20px;border-radius:10px;background:#7c3aed;color:#fff;text-decoration:none;font-weight:700">Confirmar novo e-mail</a></p><p style="font-size:12px;color:#777184">Se você não solicitou a alteração, ignore esta mensagem e proteja sua conta.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Mensagem automática de segurança.</div></div></div>
```

## 6. Reauthentication

**Assunto:** `{{ .Token }} é seu código de segurança — Nexora Pay`

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><div style="font-size:11px;letter-spacing:1.5px;color:#7540dd;font-weight:700">VERIFICAÇÃO DE SEGURANÇA</div><h1 style="font-size:25px;margin:12px 0;color:#201b2b">Confirme sua identidade</h1><p style="font-size:15px;line-height:1.6;color:#625d70">Use este código para confirmar uma ação sensível na sua conta.</p><div style="padding:16px;border:1px solid #e7defa;border-radius:12px;background:#f8f5ff;text-align:center;color:#5b2dc5;font-size:30px;font-weight:700;letter-spacing:8px">{{ .Token }}</div><p style="font-size:12px;color:#777184">Se você não iniciou esta ação, ignore este e-mail e revise a segurança da sua conta.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Mensagem automática de segurança.</div></div></div>
```

## Avisos de segurança

Ative os avisos correspondentes em **Authentication → Emails → Notifications**. Estes avisos não autenticam usuários; informam eventos relevantes da conta.

### 7. Password changed notification

**Assunto:** Sua senha foi alterada — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><h1 style="font-size:23px;color:#201b2b">Senha alterada</h1><p style="font-size:15px;line-height:1.6;color:#625d70">A senha da sua conta Nexora Pay foi alterada.</p><p style="font-size:13px;color:#a33">Se não foi você, redefina sua senha imediatamente e fale com o suporte: nexorapay.contato@gmail.com.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Aviso de segurança.</div></div></div>
```

### 8. Email changed notification

**Assunto:** O e-mail da sua conta foi alterado — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><h1 style="font-size:23px;color:#201b2b">E-mail da conta alterado</h1><p style="font-size:15px;line-height:1.6;color:#625d70">O endereço da sua conta foi alterado de <strong>{{ .OldEmail }}</strong> para <strong>{{ .Email }}</strong>.</p><p style="font-size:13px;color:#a33">Se não foi você, fale com o suporte: nexorapay.contato@gmail.com.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Aviso de segurança.</div></div></div>
```

### 9. Phone changed notification

**Assunto:** O telefone da sua conta foi alterado — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><h1 style="font-size:23px;color:#201b2b">Telefone da conta alterado</h1><p style="font-size:15px;line-height:1.6;color:#625d70">O telefone da sua conta foi alterado de <strong>{{ .OldPhone }}</strong> para <strong>{{ .Phone }}</strong>.</p><p style="font-size:13px;color:#a33">Se não foi você, fale com o suporte: nexorapay.contato@gmail.com.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Aviso de segurança.</div></div></div>
```

### 10. MFA factor enrolled notification

**Assunto:** Novo método de verificação adicionado — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><h1 style="font-size:23px;color:#201b2b">Novo método de segurança</h1><p style="font-size:15px;line-height:1.6;color:#625d70">O método <strong>{{ .FactorType }}</strong> foi adicionado à sua conta Nexora Pay.</p><p style="font-size:13px;color:#a33">Se não foi você, fale com o suporte: nexorapay.contato@gmail.com.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Aviso de segurança.</div></div></div>
```

### 11. MFA factor unenrolled notification

**Assunto:** Método de verificação removido — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><h1 style="font-size:23px;color:#201b2b">Método de segurança removido</h1><p style="font-size:15px;line-height:1.6;color:#625d70">O método <strong>{{ .FactorType }}</strong> foi removido da sua conta Nexora Pay.</p><p style="font-size:13px;color:#a33">Se não foi você, fale com o suporte: nexorapay.contato@gmail.com.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Aviso de segurança.</div></div></div>
```

### 12. Sign-in method linked notification

**Assunto:** Método de acesso vinculado à conta — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><h1 style="font-size:23px;color:#201b2b">Novo método de acesso</h1><p style="font-size:15px;line-height:1.6;color:#625d70">O método <strong>{{ .Provider }}</strong> foi vinculado à conta <strong>{{ .Email }}</strong>.</p><p style="font-size:13px;color:#a33">Se não foi você, fale com o suporte: nexorapay.contato@gmail.com.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Aviso de segurança.</div></div></div>
```

### 13. Sign-in method unlinked notification

**Assunto:** Método de acesso removido da conta — Nexora Pay

```html
<div style="margin:0;padding:32px 12px;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif;color:#201b2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:22px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:30px 26px"><h1 style="font-size:23px;color:#201b2b">Método de acesso removido</h1><p style="font-size:15px;line-height:1.6;color:#625d70">O método <strong>{{ .Provider }}</strong> foi removido da conta <strong>{{ .Email }}</strong>.</p><p style="font-size:13px;color:#a33">Se não foi você, fale com o suporte: nexorapay.contato@gmail.com.</p></div><div style="padding:16px 26px;background:#faf9fc;color:#777184;font-size:11px">Nexora Pay · Aviso de segurança.</div></div></div>
```

## MFA / autenticação de dois fatores

O código de confirmação por e-mail usado no cadastro e na recuperação **não é um segundo fator de login**. No Supabase, MFA de aplicação usa TOTP de autenticador ou fator de telefone; para Nexora, a recomendação é implementar TOTP (Google Authenticator, Microsoft Authenticator, 1Password ou similar) e exigir MFA para o Super Admin, deixando-o opcional para clientes. O Supabase não envia o desafio TOTP por e-mail: o código é gerado no app autenticador. Os templates 10 e 11 acima são apenas avisos de inclusão/remoção do fator.

Para ativar a experiência de MFA no site ainda é necessário implementar: (1) QR/segredo e verificação de cadastro em Configurações; (2) desafio TOTP depois da senha no login; (3) bloqueio das áreas administrativas e operações protegidas até a sessão atingir `aal2`; (4) remoção do fator com nova verificação. O TOTP do Supabase está disponível sem custo adicional e não depende do domínio de envio nem de SMS.

## Ajustes para a configuração atual

- Em **Confirm signup** e **Reset password**, use `{{ .Token }}` e não `{{ .ConfirmationURL }}`, pois o formulário atual pede código.
- Em **Magic link / OTP**, use o código acima apenas se o login sem senha for habilitado; caso prefira link, substitua o bloco do código por um botão com `href="{{ .ConfirmationURL }}"`.
- Em **Invite user** e **Change email address**, preserve `{{ .ConfirmationURL }}` porque são ações por link.
- Desative tracking/clique automático de links no Resend para os templates que usam `{{ .ConfirmationURL }}`.
- SMTP ativo não altera templates. Depois de salvar cada modelo no dashboard, teste cadastro e recuperação com novos pedidos de e-mail.

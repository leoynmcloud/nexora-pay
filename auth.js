(function () {
  'use strict';
  const form = document.querySelector('#auth-form'), client = window.nexoraSupabase;
  const inputs = { name: form.querySelector('#auth-name'), email: form.querySelector('#auth-email'), phone: form.querySelector('#auth-phone'), password: form.querySelector('#auth-password'), confirm: form.querySelector('#auth-confirm'), terms: form.querySelector('#auth-terms'), code: form.querySelector('#auth-code') };
  const pendingEmailKey = 'nexora-auth-pending-email', pendingMfaKey = 'nexora-auth-pending-mfa';
  let mode = new URLSearchParams(location.search).get('mode') || 'login', busy = false, recoveryReady = false, pendingMfa = null;
  const captchaBox = document.querySelector('#auth-captcha');
  const captchaSiteKey = String(window.NEXORA_HCAPTCHA_SITE_KEY || window.NEXORA_RECAPTCHA_SITE_KEY || '').trim();
  const captchaProvider = (window.NEXORA_CAPTCHA_PROVIDER || 'hcaptcha').toLowerCase();
  let captchaToken = '', captchaWidgetId = null, captchaLoading = false;
  if (!['login','signup','forgot','verify-signup','verify-recovery','verify-mfa','enroll-mfa','reset'].includes(mode)) mode = 'login';
  if (mode === 'verify-signup' || mode === 'verify-recovery') { try { inputs.email.value = sessionStorage.getItem(pendingEmailKey) || ''; } catch { /* Storage may be unavailable in private browsing. */ } }
  const message = (text, type = '') => { const node = document.querySelector('.auth-message'); node.textContent = text; node.className = 'auth-message ' + type; };

  function renderCaptcha() {
    // Exclusivo para cadastro (signup) conforme solicitado pelo lojista
    const needed = !!captchaSiteKey && mode === 'signup';
    captchaBox.hidden = !needed;
    if (!needed) return;
    const isHcaptcha = captchaProvider === 'hcaptcha';
    const api = isHcaptcha ? window.hcaptcha : window.grecaptcha;
    if (api && typeof api.render === 'function' && captchaWidgetId === null) {
      try {
        captchaWidgetId = api.render('auth-captcha', {
          sitekey: captchaSiteKey,
          theme: document.documentElement.classList.contains('theme-light') ? 'light' : 'dark',
          callback: token => { captchaToken = token; },
          'expired-callback': () => { captchaToken = ''; },
          'error-callback': (err) => {
            console.error('[Nexora Auth] Captcha error:', err);
            captchaToken = '';
            message('Não foi possível validar a verificação. Tente novamente.', 'error');
          }
        });
      } catch (err) {
        console.error('[Nexora Auth] Captcha render failed:', err);
      }
    } else if (!api && !captchaLoading) {
      captchaLoading = true;
      window.onNexoraCaptchaLoaded = () => {
        captchaLoading = false;
        renderCaptcha();
      };
      const script = document.createElement('script');
      script.src = isHcaptcha
        ? 'https://js.hcaptcha.com/1/api.js?render=explicit&onload=onNexoraCaptchaLoaded'
        : 'https://www.google.com/recaptcha/api.js?render=explicit&onload=onNexoraCaptchaLoaded';
      script.async = true; script.defer = true;
      script.onerror = () => {
        captchaLoading = false;
        console.error('[Nexora Auth] Failed to load captcha script from CDN');
        message('A verificação de segurança não carregou. Atualize a página e tente novamente.', 'error');
      };
      document.head.append(script);
    }
  }
  function requireCaptchaToken() {
    if (!captchaSiteKey || mode !== 'signup') return undefined;
    const isHcaptcha = captchaProvider === 'hcaptcha';
    const api = isHcaptcha ? window.hcaptcha : window.grecaptcha;
    if (api && captchaWidgetId !== null && typeof api.getResponse === 'function') {
      const resp = api.getResponse(captchaWidgetId);
      if (resp) captchaToken = resp;
    }
    if (!captchaToken) throw new Error('Por favor, confirme a verificação de segurança (Não sou um robô) antes de continuar.');
    return captchaToken;
  }
  function resetCaptcha() {
    captchaToken = '';
    const isHcaptcha = captchaProvider === 'hcaptcha';
    const api = isHcaptcha ? window.hcaptcha : window.grecaptcha;
    if (captchaWidgetId !== null && api && typeof api.reset === 'function') {
      try { api.reset(captchaWidgetId); } catch (_) {}
    }
  }

  function update() {
    const signup = mode === 'signup', forgot = mode === 'forgot', reset = mode === 'reset';
    const verifyingSignup = mode === 'verify-signup', verifyingRecovery = mode === 'verify-recovery', verifyingMfa = mode === 'verify-mfa', enrollingMfa = mode === 'enroll-mfa';
    const verifying = verifyingSignup || verifyingRecovery || verifyingMfa || enrollingMfa;
    const content = signup ? ['Crie sua conta.','Cadastre seu acesso para iniciar a análise da empresa.','Criar minha conta']
      : forgot ? ['Recupere seu acesso.','Enviaremos um código de verificação para o seu e-mail.','Enviar código']
      : verifyingSignup ? ['Confirme seu e-mail.','Digite o código enviado para concluir a criação da conta.','Confirmar e continuar']
      : verifyingRecovery ? ['Confirme sua identidade.','Digite o código enviado para definir uma nova senha.','Validar código']
      : verifyingMfa ? ['Verificação em duas etapas.','Digite o código do aplicativo autenticador para continuar.','Verificar e entrar']
      : enrollingMfa ? ['Proteja sua conta.','A autenticação em duas etapas é obrigatória para o Super Admin. Configure seu aplicativo e confirme o código.','Ativar e continuar']
      : reset ? ['Defina uma nova senha.','Use no mínimo 8 caracteres.','Salvar nova senha']
      : ['Bem-vindo de volta.','Entre para acompanhar sua operação.','Entrar no painel'];
    document.querySelector('[data-auth-title]').textContent = content[0];
    document.querySelector('[data-auth-description]').textContent = content[1];
    document.querySelector('[data-auth-submit]').textContent = content[2];
    document.title = content[0] + ' — Nexora Pay';
    const visibility = { name: signup, email: !reset && !verifyingMfa && !enrollingMfa, phone: signup, password: !forgot && !verifying, confirm: reset, terms: signup, code: verifying };
    for (const [key, visible] of Object.entries(visibility)) {
      form.querySelector('[data-auth-' + key + ']').hidden = !visible;
      inputs[key].disabled = !visible;
      inputs[key].required = visible && key !== 'confirm';
    }
    document.querySelector('[data-auth-mfa-setup]').hidden = !enrollingMfa;
    document.querySelector('[data-auth-code-help]').hidden = !verifying;
    document.querySelector('[data-auth-resend]').hidden = !verifying || verifyingMfa || enrollingMfa;
    form.querySelector('[data-auth-code]').firstChild.textContent = verifyingMfa || enrollingMfa ? 'Código do aplicativo autenticador' : 'Código enviado por e-mail';
    document.querySelector('[data-auth-code-help]').textContent = verifyingMfa || enrollingMfa ? 'Abra o aplicativo autenticador vinculado à sua conta e informe o código de 6 dígitos.' : 'Confira a caixa de entrada e o spam. O código expira.';
    inputs.password.autocomplete = signup || reset ? 'new-password' : 'current-password';
    inputs.password.minLength = signup || reset ? 8 : 6;
    document.querySelector('[data-auth-forgot]').hidden = mode !== 'login';
    document.querySelector('[data-auth-switch-text]').textContent = signup ? 'Já tem uma conta?' : mode === 'login' ? 'Ainda não tem uma conta?' : 'Deseja voltar ao acesso?';
    document.querySelector('[data-auth-switch]').textContent = mode === 'login' ? 'Criar conta' : mode === 'signup' ? 'Fazer login' : 'Voltar ao login';
    document.querySelector('[data-auth-kicker]').textContent = verifying || reset || forgot ? 'VERIFICAÇÃO DE ACESSO' : signup ? 'CRIAR CONTA NEXORA PAY' : 'ACESSO NEXORA PAY';
    document.querySelector('.auth-switch').hidden = verifyingMfa || enrollingMfa;
    const tabsContainer = document.querySelector('.auth-tabs');
    if (tabsContainer) {
      tabsContainer.hidden = !['login', 'signup'].includes(mode);
      tabsContainer.querySelectorAll('[data-tab-mode]').forEach(tab => {
        const active = tab.dataset.tabMode === mode;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      });
    }
    renderCaptcha();
    if (verifying) { inputs.code.value = ''; inputs.code.pattern = verifyingMfa || enrollingMfa ? '[0-9]{6}' : '[0-9]{6,10}'; inputs.code.maxLength = verifyingMfa || enrollingMfa ? 6 : 10; inputs.code.focus({ preventScroll: true }); }
  }
  function change(next, force = false) {
    if (busy && !force) return;
    mode = next;
    if (mode === 'verify-signup' || mode === 'verify-recovery') { try { sessionStorage.setItem(pendingEmailKey, inputs.email.value.trim()); } catch { /* OTP remains usable in the current page. */ } }
    const url = new URL(location.href); url.searchParams.set('mode', mode); history.replaceState(null, '', url);
    message(''); update();
  }
  const friendly = (error) => {
    const text = error?.message || 'Não foi possível concluir.';
    if (/Invalid login credentials/i.test(text)) return 'E-mail ou senha incorretos.';
    if (/already registered/i.test(text)) return 'Este e-mail já está cadastrado. Faça login ou recupere a senha.';
    if (/Email not confirmed/i.test(text)) return 'Confirme seu e-mail antes de entrar.';
    if (/Signups not allowed/i.test(text)) return 'O cadastro público está temporariamente indisponível. Fale com a Nexora para receber ajuda.';
    if (/invalid.*(code|totp)|totp.*(invalid|expired)|mfa.*(challenge|factor)/i.test(text)) return 'O código de verificação é inválido ou expirou. Gere outro código e tente novamente.';
    if (/rate limit|too many/i.test(text)) return 'Muitas tentativas. Aguarde alguns minutos antes de solicitar outro código.';
    if (/sending.*email/i.test(text)) return 'O Supabase não conseguiu enviar o e-mail. Confira o provedor de envio, o template e os limites no painel Supabase.';
    if (/token.*(invalid|expired)|otp.*(invalid|expired)/i.test(text)) return 'O código está incorreto ou expirou. Confira o e-mail ou solicite outro código.';
    return window.NexoraAPI.errorMessage(error);
  };
  async function routeSignedInUser() {
    const isAdminAccount = await window.NexoraAPI.rpc('is_nexora_super_admin_account');
    if (await startMfaIfRequired(isAdminAccount)) return;
    if (isAdminAccount) {
      location.assign('nexora-admin.html');
    }
    else {
      const access = await window.NexoraAPI.rpc('get_my_access');
      location.assign(access?.can_access ? 'platform.html' : 'onboarding.html');
    }
  }
  async function startMfaIfRequired(isAdmin = false) {
    const { data: aal, error: aalError } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError) throw aalError;
    const { data: factors, error: factorsError } = await client.auth.mfa.listFactors();
    if (factorsError) throw factorsError;
    const factor = (factors?.totp || []).find(item => item.status === 'verified');
    if (!factor) {
      if (!isAdmin) return false;
      for (const pending of (factors?.totp || []).filter(item => item.status !== 'verified')) {
        const { error } = await client.auth.mfa.unenroll({ factorId: pending.id });
        if (error) throw error;
      }
      const { data: userData } = await client.auth.getUser();
      const userEmail = userData?.user?.email || inputs.email.value.trim() || 'admin';
      const { data, error } = await client.auth.mfa.enroll({
        factorType: 'totp',
        issuer: 'Nexora Pay',
        friendlyName: userEmail,
      });
      if (error) throw error;
      if (!data?.id || !data.totp?.qr_code || !data.totp?.secret) throw new Error('Não foi possível iniciar o cadastro do autenticador.');
      pendingMfa = { factorId: data.id, setup: true };
      change('enroll-mfa', true);
      const image = document.createElement('img'); image.alt = 'QR de configuração do autenticador'; image.src = data.totp.qr_code;
      document.querySelector('[data-auth-mfa-qr]').replaceChildren(image);
      document.querySelector('[data-auth-mfa-secret]').textContent = data.totp.secret;
      message('O acesso ao Super Admin exige autenticação em duas etapas. Configure seu aplicativo e valide o código.', 'success');
      return true;
    }
    if (aal?.currentLevel === 'aal2') return false;
    pendingMfa = { factorId: factor.id };
    try { sessionStorage.setItem(pendingMfaKey, JSON.stringify(pendingMfa)); } catch { /* Keep challenge in memory for this page. */ }
    change('verify-mfa', true);
    message(isAdmin ? 'O Super Admin exige autenticação em duas etapas. Abra seu aplicativo autenticador.' : 'Autenticação em duas etapas necessária. Abra seu aplicativo autenticador e informe o código.', 'success');
    return true;
  }
  async function finishMfa() {
    let pending = pendingMfa;
    try { pending = pending || JSON.parse(sessionStorage.getItem(pendingMfaKey) || 'null'); } catch { /* Use the in-memory challenge. */ }
    if (!pending?.factorId) throw new Error('A verificação expirou. Entre novamente para solicitar um novo código.');
    const { data: challenge, error: challengeError } = await client.auth.mfa.challenge({ factorId: pending.factorId });
    if (challengeError) throw challengeError;
    const { error } = await client.auth.mfa.verify({ factorId: pending.factorId, challengeId: challenge.id, code: inputs.code.value.trim() });
    if (error) throw error;
    pendingMfa = null;
    try { sessionStorage.removeItem(pendingMfaKey); } catch { /* No-op. */ }
    await routeSignedInUser();
  }
  async function finishMfaEnrollment() {
    if (!pendingMfa?.factorId || !pendingMfa.setup) throw new Error('A configuração expirou. Entre novamente para reiniciá-la.');
    const { data: challenge, error: challengeError } = await client.auth.mfa.challenge({ factorId: pendingMfa.factorId });
    if (challengeError) throw challengeError;
    const { error } = await client.auth.mfa.verify({ factorId: pendingMfa.factorId, challengeId: challenge.id, code: inputs.code.value.trim() });
    if (error) throw error;
    pendingMfa = null;
    await routeSignedInUser();
  }

  document.querySelectorAll('[data-tab-mode]').forEach(tab => {
    tab.onclick = () => change(tab.dataset.tabMode);
  });
  document.querySelector('[data-auth-switch]').onclick = () => change(mode === 'login' ? 'signup' : 'login');
  document.querySelector('[data-auth-forgot]').onclick = () => change('forgot');
  document.querySelector('[data-auth-resend]').onclick = async () => {
    if (busy) return;
    const email = inputs.email.value.trim();
    if (!email || !inputs.email.checkValidity()) { message('Informe um e-mail válido antes de pedir outro código.', 'error'); inputs.email.focus(); return; }
    busy = true; const resend = document.querySelector('[data-auth-resend]'); resend.disabled = true;
    try {
      if (!client) throw new Error('Supabase não configurado.');
      const capToken = requireCaptchaToken();
      const resendOptions = capToken ? { captchaToken: capToken } : undefined;
      const resetOptions = { redirectTo: location.origin + '/auth.html?mode=reset', ...(capToken ? { captchaToken: capToken } : {}) };
      const result = mode === 'verify-signup'
        ? await client.auth.resend({ type: 'signup', email, ...(resendOptions ? { options: resendOptions } : {}) })
        : await client.auth.resetPasswordForEmail(email, resetOptions);
      if (result.error) throw result.error;
      message('Se o endereço estiver correto, um novo código foi enviado. Confira também o spam.', 'success');
    } catch (error) { message(friendly(error), 'error'); }
    finally { resetCaptcha(); busy = false; resend.disabled = false; }
  };

  client?.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') { recoveryReady = true; mode = 'reset'; update(); message('Link de recuperação validado. Defina sua nova senha.'); }
  });

  form.onsubmit = async (event) => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    busy = true; const buttons = [...document.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true); message('Processando…');
    try {
      if (!client) throw new Error('Supabase não configurado.');
      if (mode === 'forgot') {
        const capToken = requireCaptchaToken();
        const { error } = await client.auth.resetPasswordForEmail(inputs.email.value.trim(), { redirectTo: location.origin + '/auth.html?mode=reset', ...(capToken ? { captchaToken: capToken } : {}) });
        if (error) throw error;
        change('verify-recovery', true);
        message('Se o endereço estiver cadastrado, enviamos um código. Confira também o spam.', 'success');
      } else if (mode === 'verify-mfa') {
        await finishMfa();
      } else if (mode === 'enroll-mfa') {
        await finishMfaEnrollment();
      } else if (mode === 'verify-signup' || mode === 'verify-recovery') {
        const verificationType = mode === 'verify-signup' ? 'signup' : 'recovery';
        const { data, error } = await client.auth.verifyOtp({ email: inputs.email.value.trim(), token: inputs.code.value.trim(), type: verificationType });
        if (error) throw error;
        try { sessionStorage.removeItem(pendingEmailKey); } catch { /* No-op. */ }
        if (verificationType === 'signup') await routeSignedInUser();
        else { recoveryReady = !!data.session; change('reset', true); message('Código confirmado. Agora defina sua nova senha.', 'success'); }
      } else if (mode === 'reset') {
        if (!recoveryReady) throw new Error('Abra o link de recuperação ou valide o código recebido por e-mail. Se expirou, solicite outro.');
        if (inputs.password.value !== inputs.confirm.value) throw new Error('As senhas não coincidem.');
        const { error } = await client.auth.updateUser({ password: inputs.password.value }); if (error) throw error;
        inputs.password.value = ''; inputs.confirm.value = ''; recoveryReady = false; try { sessionStorage.removeItem(pendingEmailKey); } catch { /* No-op. */ } change('login', true); message('Senha alterada. Você já pode entrar.', 'success');
      } else {
        if (mode === 'signup' && !inputs.name.value.trim()) throw new Error('Informe seu nome completo.');
        if (mode === 'signup' && !inputs.phone.value.trim()) throw new Error('Informe seu telefone ou WhatsApp.');
        const capToken = requireCaptchaToken();
        const signUpOpts = {
          data: { full_name: inputs.name.value.trim(), phone: inputs.phone.value.trim() },
          emailRedirectTo: location.origin + '/auth.html',
          ...(capToken ? { captchaToken: capToken } : {})
        };
        const signInOpts = capToken ? { captchaToken: capToken } : undefined;
        const result = mode === 'signup'
          ? await client.auth.signUp({ email: inputs.email.value.trim(), password: inputs.password.value, options: signUpOpts })
          : await client.auth.signInWithPassword({ email: inputs.email.value.trim(), password: inputs.password.value, ...(signInOpts ? { options: signInOpts } : {}) });
        if (result.error) throw result.error;
        if (!result.data.session && mode === 'signup') { change('verify-signup', true); message('Conta criada. Enviamos um código de confirmação para seu e-mail.', 'success'); }
        else if (!result.data.session) message('Confirme seu e-mail para ativar a conta.', 'success');
        else await routeSignedInUser();
      }
    } catch (error) { message(friendly(error), 'error'); }
    finally { resetCaptcha(); busy = false; buttons.forEach(button => button.disabled = false); }
  };

  update();
  if (mode === 'verify-mfa' || mode === 'enroll-mfa') {
    client?.auth.getSession().then(async ({ data, error }) => {
      if (error) throw error;
      if (!data?.session) return change('login', true);
      await routeSignedInUser();
    }).catch(error => message(friendly(error), 'error'));
  }
  if (mode === 'reset') message('Aguardando validação do link de recuperação. Se ele expirou, solicite um novo código.');
})();

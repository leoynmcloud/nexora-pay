(async function () {
  'use strict';
  const shell = document.querySelector('.app-shell'); if (shell) shell.hidden = true;
  const errorView = (message) => {
    if (shell) shell.hidden = true;
    document.querySelectorAll('.nx-access-error').forEach((n) => n.remove());
    const panel = document.createElement('main'); panel.className = 'nx-access-error';
    const title = document.createElement('h1'); title.textContent = 'Não foi possível abrir sua conta';
    const text = document.createElement('p'); text.textContent = message;
    const retry = document.createElement('button'); retry.className = 'button button-primary'; retry.textContent = 'Tentar novamente'; retry.onclick = () => location.reload();
    const exit = document.createElement('button'); exit.className = 'button outline'; exit.textContent = 'Sair'; exit.onclick = () => window.NexoraUI.confirm('Sair da conta?', 'Você precisará entrar novamente.', window.NexoraUI.logout, 'Sair');
    panel.append(title, text, retry, exit); document.body.append(panel);
  };
  try {
    const client = window.nexoraSupabase; if (!client) throw new Error('Supabase indisponível. Confira a conexão e a configuração do projeto.');
    const { data: { session }, error } = await client.auth.getSession(); if (error) throw error;
    if (!session) return location.replace('auth.html'); window.nexoraSessionUser = session.user;
    const cacheKey = `nexora_access_v1_${session.user.id}`;
    const isWorkspaceView = new URLSearchParams(location.search).get('view') === 'workspace';
    let unveiledFromCache = false;
    try {
      const cachedRaw = sessionStorage.getItem(cacheKey);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (cached && cached.can_access && (Date.now() - (cached._ts || 0) < 300000)) {
          if (cached.is_nexora_admin && !isWorkspaceView) {
            return location.replace('nexora-admin.html');
          }
          window.nexoraAccess = cached;
          document.documentElement.dataset.nexoraAccess = 'ready';
          if (shell) shell.hidden = false;
          unveiledFromCache = true;
          window.dispatchEvent(new CustomEvent('nexora-access-ready'));
        }
      }
    } catch { /* Ignore cache read errors */ }

    const [adminAccount, access] = await Promise.all([
      window.NexoraAPI.rpc('is_nexora_super_admin_account'),
      window.NexoraAPI.rpc('get_my_access')
    ]);
    let admin = false;
    if (adminAccount === true) {
      const [factorsRes, assuranceRes, superAdminRes] = await Promise.all([
        client.auth.mfa.listFactors(),
        client.auth.mfa.getAuthenticatorAssuranceLevel(),
        window.NexoraAPI.rpc('is_nexora_super_admin').catch(() => false)
      ]);
      if (factorsRes.error) throw factorsRes.error;
      if (!(factorsRes.data?.totp || []).some(factor => factor.status === 'verified')) {
        try { sessionStorage.removeItem(cacheKey); } catch {}
        return location.replace('auth.html?mode=enroll-mfa');
      }
      if (assuranceRes.error) throw assuranceRes.error;
      if (assuranceRes.data?.currentLevel !== 'aal2') {
        try { sessionStorage.removeItem(cacheKey); } catch {}
        return location.replace('auth.html?mode=verify-mfa');
      }
      admin = superAdminRes;
      if (admin !== true) throw new Error('A verificação administrativa não foi concluída. Entre novamente.');
    }
    if (admin === true && !isWorkspaceView) return location.replace('nexora-admin.html');
    if (!access?.can_access) {
      try { sessionStorage.removeItem(cacheKey); } catch {}
      if (access?.access_status === 'suspended' || access?.access_status === 'blocked' || access?.access_status === 'closed') {
        throw new Error('Sua conta está suspensa ou encerrada. Entre em contato com o suporte.');
      }
      if (access?.onboarding_status) return location.replace('onboarding.html');
      throw new Error('Sua conta está suspensa. Entre em contato com o suporte.');
    }
    const freshAccess = { ...access, is_nexora_admin: admin === true, can_operate: admin === true || access.can_operate === true || access.onboarding_status === 'APPROVED', _ts: Date.now() };
    const statusChanged = unveiledFromCache && (
      window.nexoraAccess?.can_operate !== freshAccess.can_operate ||
      window.nexoraAccess?.onboarding_status !== freshAccess.onboarding_status ||
      window.nexoraAccess?.is_nexora_admin !== freshAccess.is_nexora_admin
    );
    window.nexoraAccess = freshAccess;
    try { sessionStorage.setItem(cacheKey, JSON.stringify(freshAccess)); } catch {}
    document.documentElement.dataset.nexoraAccess = 'ready';
    if (shell) shell.hidden = false;
    if (!unveiledFromCache || statusChanged) {
      window.dispatchEvent(new CustomEvent('nexora-access-ready'));
    }
    client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        try { sessionStorage.removeItem(cacheKey); } catch {}
        location.replace('auth.html');
      }
    });
  } catch (error) { errorView(window.NexoraAPI.errorMessage(error)); }
})();

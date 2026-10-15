(async function () {
  'use strict';
  const shell = document.querySelector('.app-shell'); if (shell) shell.hidden = true;
  const errorView = (message) => {
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
    const [adminAccount, access] = await Promise.all([
      window.NexoraAPI.rpc('is_nexora_super_admin_account'),
      window.NexoraAPI.rpc('get_my_access')
    ]);
    let admin = false;
    if (adminAccount === true) {
      const { data: factors, error: factorsError } = await client.auth.mfa.listFactors(); if (factorsError) throw factorsError;
      if (!(factors?.totp || []).some(factor => factor.status === 'verified')) return location.replace('auth.html?mode=enroll-mfa');
      const { data: assurance, error: assuranceError } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError) throw assuranceError;
      if (assurance?.currentLevel !== 'aal2') return location.replace('auth.html?mode=verify-mfa');
      admin = await window.NexoraAPI.rpc('is_nexora_super_admin');
      if (admin !== true) throw new Error('A verificação administrativa não foi concluída. Entre novamente.');
    }
    if (admin === true && new URLSearchParams(location.search).get('view') !== 'workspace') return location.replace('nexora-admin.html');
    if (!access?.can_access) {
      if (access?.access_status === 'suspended' || access?.access_status === 'blocked' || access?.access_status === 'closed') {
        throw new Error('Sua conta está suspensa ou encerrada. Entre em contato com o suporte.');
      }
      if (access?.onboarding_status) return location.replace('onboarding.html');
      throw new Error('Sua conta está suspensa. Entre em contato com o suporte.');
    }
    window.nexoraAccess = { ...access, is_nexora_admin: admin === true, can_operate: admin === true || access.can_operate === true || access.onboarding_status === 'APPROVED' }; document.documentElement.dataset.nexoraAccess = 'ready';
    if (shell) shell.hidden = false; window.dispatchEvent(new CustomEvent('nexora-access-ready'));
    client.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') location.replace('auth.html'); });
  } catch (error) { errorView(window.NexoraAPI.errorMessage(error)); }
})();

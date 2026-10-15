(function () {
  const profile = document.querySelector('.profile'); if (!profile) return;
  profile.setAttribute('role', 'button'); profile.setAttribute('tabindex', '0'); profile.setAttribute('aria-label', 'Abrir menu da conta');
  const open = () => {
    const UI = window.NexoraUI, e = window.NexoraCore.escape;
    const dialog = UI.modal('Sua conta', `<p>${e(window.nexoraSessionUser?.email || '')}</p><div class="nx-menu-actions">${window.nexoraAccess?.is_nexora_admin ? '<a class="button outline" href="nexora-admin.html">Painel Nexora Pay</a>' : ''}<button type="button" class="button outline" data-profile="conta">Minha conta</button><button type="button" class="button outline" data-profile="configuracoes">Configurações</button><button type="button" class="button outline" data-profile="sair">Sair da conta</button></div>`);
    dialog.querySelectorAll('[data-profile]').forEach((button) => button.onclick = () => {
      const action = button.dataset.profile;
      dialog.close();
      if (action === 'sair') window.setTimeout(() => UI.confirm('Sair da conta?', 'Você precisará entrar novamente.', UI.logout, 'Sair'), 50);
      else window.NexoraPlatform.showView(action);
    });
  };
  profile.onclick = open; profile.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
  window.NexoraProfileMenu = { open };
})();

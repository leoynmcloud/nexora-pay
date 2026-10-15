(function () {
  const workspace = document.querySelector('.workspace'); if (!workspace) return;
  workspace.setAttribute('role', 'button'); workspace.setAttribute('tabindex', '0'); workspace.setAttribute('aria-label', 'Gerenciar workspace');
  const open = () => window.NexoraPlatform?.showView('configuracoes'); workspace.onclick = open;
  workspace.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
})();

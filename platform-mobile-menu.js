(function () {
  'use strict';
  const shell = document.querySelector('.app-shell');
  const drawer = document.querySelector('#platformNavDrawer');
  const sidebar = drawer?.querySelector('.sidebar');
  const main = shell?.querySelector('.app-main');
  const query = window.matchMedia('(max-width: 850px)');
  const openButton = document.querySelector('[data-platform-menu]');
  const accountButton = document.querySelector('[data-mobile-account]');
  if (!shell || !drawer || !sidebar || !main || !openButton) return;

  function placeSidebar() {
    if (query.matches) {
      if (drawer.parentElement !== shell) shell.insertBefore(drawer, main);
      if (sidebar.parentElement !== drawer) drawer.append(sidebar);
      return;
    }
    if (drawer.open) drawer.close();
    if (sidebar.parentElement !== shell) shell.insertBefore(sidebar, main);
  }

  openButton.addEventListener('click', () => {
    placeSidebar();
    if (query.matches && !drawer.open) {
      try { drawer.showModal(); }
      catch (_) { drawer.setAttribute('open', ''); }
      openButton.setAttribute('aria-expanded', 'true');
      sidebar.querySelector('.side-nav a')?.focus({ preventScroll: true });
    }
  });
  const closeDrawer = () => {
    if (drawer.open) drawer.close();
    else drawer.removeAttribute('open');
    openButton.setAttribute('aria-expanded', 'false');
  };
  drawer.querySelector('[data-platform-menu-close]')?.addEventListener('click', closeDrawer);
  drawer.addEventListener('close', () => { openButton.setAttribute('aria-expanded', 'false'); if (query.matches) openButton.focus({ preventScroll: true }); });
  accountButton?.addEventListener('click', () => {
    const showAccount = () => window.NexoraProfileMenu?.open();
    if (drawer.open) { drawer.addEventListener('close', showAccount, { once: true }); closeDrawer(); }
    else showAccount();
  });
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer || event.target.closest('.side-nav a, .nx-help')) closeDrawer();
  });
  query.addEventListener('change', placeSidebar);
  placeSidebar();
})();

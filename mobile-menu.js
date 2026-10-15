(function () {
  const toggle = document.querySelector('.mobile-menu-toggle');
  const menu = document.querySelector('.mobile-menu');
  if (!toggle || !menu) return;
  toggle.setAttribute('aria-controls', menu.id);
  const close = () => {
    if (menu.open) menu.close();
    document.body.classList.remove('menu-open');
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.addEventListener('click', () => {
    if (menu.open) return close();
    menu.showModal();
    document.body.classList.add('menu-open');
    toggle.setAttribute('aria-expanded', 'true');
  });
  menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', close));
  menu.querySelector('.mobile-menu-close')?.addEventListener('click', close);
  menu.addEventListener('close', () => { document.body.classList.remove('menu-open'); toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); });
  matchMedia('(min-width:851px)').addEventListener('change', event => { if (event.matches) close(); });
})();

(function () {
  'use strict';
  const sidebarId = document.querySelector('[data-admin-menu-open]')?.getAttribute('aria-controls');
  const panel = sidebarId && document.getElementById(sidebarId);
  const opener = document.querySelector('[data-admin-menu-open]');
  const backdrop = document.querySelector('[data-admin-menu-close]');
  if (!panel || !opener || !backdrop) return;

  const navLinks = [...panel.querySelectorAll('[data-admin-nav]')];
  const pages = [...document.querySelectorAll('[data-admin-page]')];
  const mobile = matchMedia('(max-width: 900px)');
  const focusable = () => [...panel.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),[tabindex="0"]')]
    .filter(item => item.getClientRects().length && item.getAttribute('aria-hidden') !== 'true');

  const aliases = {
    'admin-fund-holds': { target: 'admin-custody', tab: 'holds' },
    'admin-reserves': { target: 'admin-custody', tab: 'reserves' },
    'admin-reconciliation': { target: 'admin-custody', tab: 'reconciliation' },
    'admin-custody': { target: 'admin-custody', tab: null }
  };

  function activatePage(id, writeHistory = false, moveFocus = false) {
    const alias = aliases[id];
    const targetId = alias ? alias.target : id;
    const page = pages.find(item => item.id === targetId) || pages.find(item => item.id === 'admin-overview');
    if (!page) return;
    pages.forEach(item => {
      const active = item === page;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-hidden', String(!active));
    });
    navLinks.forEach(link => {
      if (link.hash === '#' + page.id || (alias && link.hash === '#' + targetId)) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (alias?.tab && typeof window.nexoraSwitchCustodyTab === 'function') {
      window.nexoraSwitchCustodyTab(alias.tab);
    }
    if (writeHistory && location.hash !== '#' + (alias ? id : page.id)) history.pushState(null, '', '#' + (alias ? id : page.id));
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (moveFocus) {
      const heading = page.querySelector('h1,h2');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
    return page;
  }

  function setOpen(open, restoreFocus = true) {
    if (!mobile.matches) {
      document.body.classList.remove('admin-nav-open');
      opener.setAttribute('aria-expanded', 'false');
      panel.removeAttribute('aria-hidden');
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
      return;
    }
    document.body.classList.toggle('admin-nav-open', open);
    opener.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    if (open) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      (focusable()[0] || panel).focus({ preventScroll: true });
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
      if (restoreFocus) opener.focus({ preventScroll: true });
    }
  }

  opener.addEventListener('click', () => setOpen(true));
  backdrop.addEventListener('click', () => setOpen(false));
  panel.querySelectorAll('[data-admin-nav]').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      setOpen(false, false);
      activatePage(link.hash.slice(1), true, true);
    });
  });
  panel.querySelectorAll('.admin-sidebar-bottom a').forEach(link => link.addEventListener('click', () => {
    if (mobile.matches) setOpen(false, false);
  }));

  document.addEventListener('keydown', event => {
    if (!mobile.matches || !document.body.classList.contains('admin-nav-open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (!items.length) { event.preventDefault(); panel.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  });
  window.addEventListener('popstate', () => activatePage(location.hash.slice(1), false, true));
  window.addEventListener('hashchange', () => activatePage(location.hash.slice(1), false, true));

  mobile.addEventListener('change', () => setOpen(false, false));
  setOpen(false, false);
  activatePage(location.hash.slice(1) || 'admin-overview');
})();

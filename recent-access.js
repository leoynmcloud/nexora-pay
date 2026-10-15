(function () {
  'use strict';
  const area = location.pathname.endsWith('nexora-admin.html') ? 'admin' : location.pathname.endsWith('platform.html') ? 'platform' : 'site';
  const selector = area === 'admin' ? '[data-admin-nav]' : area === 'platform' ? '.side-nav a[href^="#"]' : '.nav-links a[href^="#"], .mobile-menu a[href^="#"]';
  const links = [...document.querySelectorAll(selector)];
  const containers = [...document.querySelectorAll('#site-desktop-recent [data-recent-links], #site-recent-access [data-recent-links], #platform-recent-access [data-recent-links], #admin-recent-access [data-recent-links]')];
  if (!containers.length) return;
  const key = `nexora-recent-access-v1:${area}`;
  const limit = area === 'admin' || area === 'platform' ? 2 : 5;
  let ids = [];
  try { ids = JSON.parse(sessionStorage.getItem(key) || '[]').filter(id => typeof id === 'string'); } catch { ids = []; }
  const draw = () => {
    const available = new Map(links.map(link => [link.hash, link.textContent.trim().replace(/\s+/g, ' ')]));
    const recent = ids.filter(id => available.has(id)).slice(0, limit);
    containers.forEach(container => {
      container.replaceChildren();
      recent.forEach(id => { const link = document.createElement('a'); link.href = id; link.textContent = available.get(id); container.append(link); });
      const section = container.closest('.recent-access');
      if (section) section.hidden = recent.length === 0;
    });
  };
  const remember = href => {
    if (!href || !links.some(link => link.hash === href)) return;
    ids = [href, ...ids.filter(id => id !== href)].slice(0, limit);
    try { sessionStorage.setItem(key, JSON.stringify(ids)); } catch { /* Optional session-only convenience. */ }
    draw();
  };
  links.forEach(link => link.addEventListener('click', () => remember(link.hash)));
  window.addEventListener('hashchange', () => remember(location.hash));
  remember(location.hash); draw();
})();

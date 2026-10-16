(function () {
  'use strict';
  const CACHE_KEY = 'nexora_site_settings_v1';
  let settings = {};
  try {
    const rawCache = localStorage.getItem(CACHE_KEY);
    if (rawCache) settings = JSON.parse(rawCache) || {};
  } catch { /* Ignore storage errors */ }
  const safeUrl = (value) => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; } };
  function apply() {
    if (/^#[0-9a-f]{6}$/i.test(settings.accent || '')) document.documentElement.style.setProperty('--purple', settings.accent);
    const fields = { hero_title: '[data-site-title]', hero_subtitle: '[data-rotate-text]', hero_description: '[data-site-description]', pix_rate: '[data-pix-rate]', withdrawal_rate: '[data-withdrawal-rate]', legal_name: '[data-legal-name]', document: '[data-legal-document]' };
    for (const [key, selector] of Object.entries(fields)) if (settings[key]) document.querySelectorAll(selector).forEach((node) => { node.textContent = settings[key]; if (key === 'hero_subtitle') node.dataset.customText = 'true'; });
    const rawLogo = safeUrl(settings.logo_url), image = safeUrl(settings.hero_image);
    const isLegacyDarkLogo = rawLogo && rawLogo.includes('logo-e70c5307-7c9e-4be5-9e3c-2b59d00d2e8b.jpg');
    const logo = isLegacyDarkLogo ? null : rawLogo;
    if (logo) {
      document.querySelectorAll('.brand-logo-img').forEach((node) => {
        node.dataset.customLogo = 'true';
        if (node.src !== logo) node.src = logo;
        node.style.backgroundColor = '#ffffff';
      });
      let iconLink = document.querySelector("link[rel*='icon']");
      if (!iconLink) {
        iconLink = document.createElement('link');
        iconLink.rel = 'icon';
        document.head.appendChild(iconLink);
      }
      if (iconLink.href !== logo) iconLink.href = logo;
    } else {
      let iconLink = document.querySelector("link[rel*='icon']");
      if (iconLink && !iconLink.getAttribute('href')?.endsWith('favicon.png')) iconLink.href = 'favicon.png';
    }
    if (image) {
      const layer = document.querySelector('.hero-background');
      if (layer && layer.querySelector('img')?.src !== image) { const img = document.createElement('img'); img.src = image; img.alt = ''; img.decoding = 'async'; layer.replaceChildren(img); }
      document.querySelector('.hero-video')?.pause(); document.querySelector('.hero-video')?.setAttribute('data-custom-background','true');
    }
    const email = settings.support_email;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) {
      document.querySelectorAll('[data-support-contact]').forEach((node) => { const link = document.createElement('a'); link.href = `mailto:${email}`; link.textContent = email; node.replaceChildren(link); });
      document.querySelectorAll('[data-support-link]').forEach((node) => { node.href = `mailto:${email}`; node.textContent = 'Falar com a Nexora Pay'; });
    }
    const privacy = settings.privacy_email;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(privacy || '')) document.querySelectorAll('[data-privacy-contact]').forEach((node) => { const link = document.createElement('a'); link.href = `mailto:${privacy}`; link.textContent = privacy; node.replaceChildren(link); });
  }
  function updateCache(nextSettings) {
    if (!nextSettings || typeof nextSettings !== 'object') return;
    settings = { ...settings, ...nextSettings };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(settings)); } catch { /* Ignore storage quota */ }
    apply();
  }
  if (Object.keys(settings).length > 0) apply();
  window.NexoraSite = { apply, updateCache, get: () => ({ ...settings }) };
  if (!window.nexoraSupabase) return;
  window.nexoraSupabase.rpc('nexora_public_site_settings').then(({ data, error }) => {
    if (!error && data) {
      settings = data;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* Ignore storage quota */ }
      apply();
      window.dispatchEvent(new CustomEvent('nexora-site-ready'));
    }
  }).catch(() => { /* Static defaults remain usable before SQL migration. */ });
})();

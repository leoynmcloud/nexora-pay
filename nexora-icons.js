(function () {
  'use strict';
  const paths = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    arrows: '<path d="M17 3l4 4-4 4M3 7h18M7 21l-4-4 4-4M21 17H3"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 8v6M23 11h-6"/>',
    integrations: '<rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 12H5m14 0h-4M12 9V5m0 14v-4M7 7l3 3m7 7-3-3m0-4 3-3m-7 7-3 3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a8 8 0 0 0 0-6l1.5-1.2-1.6-2.8-1.8.7a8 8 0 0 0-5.5-1.5L11.3 2h-3l-.4 2.2a8 8 0 0 0-2.4 1.4l-2-.7-1.5 2.7L3.7 9a8 8 0 0 0 0 6l-1.5 1.2 1.6 2.8 1.8-.7a8 8 0 0 0 5.5 1.5l.7 2.2h3l.4-2.2a8 8 0 0 0 2.4-1.4l2 .7 1.5-2.7z" transform="translate(1) scale(.92)"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 1 1 4.3 1.8c-1.1 1.1-1.9 1.5-1.9 3M12 17.5h.01"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    moon: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13z"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M16 15h.01"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5m4-1v5l3 2"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2z"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
    spark: '<path d="m12 2 1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
  };
  function svg(name) {
    return `<svg class="nx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.spark}</svg>`;
  }
  function render(root = document) {
    root.querySelectorAll('[data-nx-icon]').forEach((node) => {
      const name = node.dataset.nxIcon;
      if (paths[name]) node.innerHTML = svg(name);
    });
  }
  window.NexoraIcons = { svg, render };
  render();
})();

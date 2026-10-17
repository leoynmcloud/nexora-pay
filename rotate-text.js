(function () {
  'use strict';
  const target = document.querySelector('[data-rotate-text]');
  if (!target) return;
  if (matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  const texts = [
    'Pix, cartão e checkout.',
    'Sua operação em um só lugar.',
    'Mais clareza em cada venda.',
  ];
  let index = 0;
  setInterval(() => {
    if (document.hidden || target.dataset.customText) return;
    target.classList.remove('text-rotate-in');
    target.classList.add('text-rotate-out');
    setTimeout(() => {
      if (!target.dataset.customText) {
        index = (index + 1) % texts.length;
        target.textContent = texts[index];
      }
      target.classList.remove('text-rotate-out');
      target.classList.add('text-rotate-in');
    }, 420);
  }, 3500);
})();

(function () {
  'use strict';
  const selector = '.section, .statement, .security, .feature-card, .logo-strip, .segments-section, .how-it-works-section, .core-features-section, .integration-section, .pricing-section, .security-section-new, .faq-section, .segment-card, .core-card, .step-card, .price-card, .sec-box, .faq-item';
  const items = document.querySelectorAll(selector);
  if (!items.length) return;

  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    items.forEach((item) => item.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  items.forEach((item, index) => {
    item.classList.add('scroll-reveal');
    item.style.setProperty('--reveal-delay', `${Math.min((index % 4) * 80, 240)}ms`);
    observer.observe(item);
  });
})();

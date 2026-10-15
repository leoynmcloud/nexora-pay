(function () {
  const video = document.querySelector('.hero-video'), hero = document.querySelector('.hero'); if (!video || !hero) return;
  const eligible = matchMedia('(min-width:851px) and (prefers-reduced-motion:no-preference)');
  let visible = true;
  const update = () => {
    if (!eligible.matches || document.hidden || !visible || video.dataset.customBackground) return video.pause();
    if (!video.getAttribute('src')) { video.src = 'nexora-ribbons.mp4'; video.load(); }
    video.play().catch(() => { /* Poster remains visible if autoplay is denied. */ });
  };
  if ('IntersectionObserver' in window) new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; update(); }, { threshold: 0.01 }).observe(hero);
  eligible.addEventListener('change', update); document.addEventListener('visibilitychange', update); window.addEventListener('nexora-site-ready', update); update();
})();

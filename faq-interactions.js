(() => {
  const items = document.querySelectorAll('.faq-redesign .faq-item');

  items.forEach((item) => {
    const trigger = item.querySelector('summary');
    if (!trigger) return;

    const syncState = () => {
      trigger.setAttribute('aria-expanded', item.open ? 'true' : 'false');
    };

    syncState();
    // Let the browser's native <details>/<summary> behavior handle clicks,
    // keyboard activation, and touch reliably. Only mirror its state for styling.
    item.addEventListener('toggle', syncState);
  });
})();

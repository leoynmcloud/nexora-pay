(function () {
  function refresh() {
    window.NexoraPlatform?.refreshOverview();
  }
  window.addEventListener('nexora-access-ready', refresh);
  refresh();
})();

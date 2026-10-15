(function () {
  const config = window.NEXORA_SUPABASE_CONFIG;
  if (!config || !window.supabase) return;
  window.nexoraSupabase = window.supabase.createClient(config.url, config.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  document.documentElement.dataset.supabase = 'ready';
})();

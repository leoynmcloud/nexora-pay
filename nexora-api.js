(function () {
  'use strict';
  const errorMessage = (error) => {
    const text = error?.message || String(error);
    if (/nexora_sandbox_|nexora_provider_(reserve_operation|update_operation|accept_webhook)|merchant_onboarding|merchant_kyc_documents|merchant_kyc_reviews|nexora_kyc_|nexora_admin_kyc|nexora_admin_review_merchant|nexora_acquirers|nexora_merchant_provider_connections|nexora_merchant_controls|nexora_admin_notifications|nexora_get_merchant_setup|nexora_admin_save_acquirer|nexora_admin_set_merchant_controls/i.test(text)) return 'O Supabase ainda precisa das migrações de cadastro e adquirentes. Confira os arquivos SQL indicados para esta instalação.';
    if (/function .*does not exist|Could not find the function|schema cache|relation .*does not exist/i.test(text)) return 'Banco ainda não atualizado. Execute a migração SQL mais recente no Supabase e tente novamente.';
    if (/JWT|session|not authenticated/i.test(text)) return 'Sua sessão expirou. Entre novamente.';
    if (/Failed to fetch|network/i.test(text)) return 'Sem conexão com o servidor. Nada foi confirmado; tente novamente.';
    return text;
  };
  async function rpc(name, parameters = {}) {
    if (!window.nexoraSupabase) throw new Error('Não foi possível conectar ao Supabase.');
    try { const { data, error } = await window.nexoraSupabase.rpc(name, parameters); if (error) throw error; return data; }
    catch (error) { throw new Error(errorMessage(error)); }
  }
  window.NexoraAPI = { rpc, errorMessage, snapshot: () => rpc('nexora_workspace_snapshot'), requestId: () => crypto.randomUUID() };
})();

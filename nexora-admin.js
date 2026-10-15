(function () {
  'use strict';
  const C = window.NexoraCore, UI = window.NexoraUI, API = window.NexoraAPI, e = C.escape;
  let data, dashboardMetrics = null, dashboardMetricsError = '', kycCases = [], kycFilter = 'all', kycSearch = '', acquirers = [], connections = [], providerCatalog = [], platformCredentials = [], merchantControls = [], alerts = [], page = 0, customerPage = 0, query = '', customerQuery = '', busy = false, request = 0, searchTimer;
  const message = document.querySelector('[data-admin-message]');
  const say = (text) => { message.textContent = text; };
  const field = (label, key, value, type = 'text') => '<label class="nx-field">' + label + '<input name="' + key + '" type="' + type + '" value="' + e(value ?? '') + '"' + (type === 'email' ? ' maxlength="254"' : type === 'number' ? ' min="0" step="0.01"' : ' maxlength="2000"') + '></label>';
  const status = (value) => '<span class="nx-status ' + e(value) + '">' + e(C.status(value)) + '</span>';
  function labelRepeatedActions(root = document) {
    root.querySelectorAll('[data-account]').forEach(button => {
      const item = data?.accounts?.find(row => row.user_id === button.dataset.account);
      if (item) button.setAttribute('aria-label','Ver transações de ' + item.full_name + ' (' + item.email + ')');
    });
    root.querySelectorAll('[data-account-manage],[data-account-status],[data-account-remove]').forEach(button => {
      const id = button.dataset.accountManage || button.dataset.accountStatus || button.dataset.accountRemove;
      const item = data?.accounts?.find(row => row.user_id === id);
      if (!item) return;
      const action = button.hasAttribute('data-account-manage') ? 'Gerenciar conta de' : button.hasAttribute('data-account-remove') ? 'Remover conta de' : (item.status === 'active' ? 'Suspender acesso de' : 'Reativar acesso de');
      button.setAttribute('aria-label', action + ' ' + item.full_name + ' (' + item.email + ')');
    });
    root.querySelectorAll('[data-account-pricing]').forEach(button => {
      const item = data?.accounts?.find(row => row.user_id === button.dataset.accountPricing);
      if (item) button.setAttribute('aria-label','Configurar tarifa Pix de ' + item.full_name + ' (' + item.email + ')');
    });
    root.querySelectorAll('[data-account-acquirer]').forEach(button => {
      const item = data?.accounts?.find(row => row.user_id === button.dataset.accountAcquirer);
      if (item) button.setAttribute('aria-label','Gerenciar adquirente de ' + item.full_name + ' (' + item.email + ')');
    });
    root.querySelectorAll('[data-customer]').forEach(button => {
      const item = data?.customers?.find(row => row.id === button.dataset.customer);
      if (item) button.setAttribute('aria-label','Ver transações do cliente ' + item.name + ' · ' + item.business_name);
    });
    root.querySelectorAll('[data-kyc-review]').forEach(button => {
      const item = kycCases.find(row => row.user_id === button.dataset.kycReview);
      if (item) button.setAttribute('aria-label','Analisar cadastro de ' + (item.full_name || item.email));
    });
    root.querySelectorAll('[data-kyc-view]').forEach(button => {
      const item = kycCases.find(row => row.user_id === button.dataset.kycView);
      if (item) button.setAttribute('aria-label','Ver dados cadastrais de ' + (item.full_name || item.email));
    });
    root.querySelectorAll('[data-acquirer-edit]').forEach(button => {
      const item = acquirers.find(row => row.id === button.dataset.acquirerEdit);
      if (item) button.setAttribute('aria-label','Editar adquirente ' + item.name);
    });
    root.querySelectorAll('[data-provider-status]').forEach(button => {
      const [businessId, acquirerId] = button.dataset.providerStatus.split('|');
      const item = connections.find(row => row.business_id === businessId && row.acquirer_id === acquirerId);
      if (item) button.setAttribute('aria-label',(button.dataset.nextStatus === 'disabled' ? 'Desativar conexão de ' : 'Reabrir conexão para homologação de ') + item.business_name);
    });
    root.querySelectorAll('[data-provider-config]').forEach(button => {
      const item = acquirers.find(row => row.id === button.dataset.providerConfig);
      if (item) button.setAttribute('aria-label','Configurar credencial central Nexora para ' + item.name + ' · ' + item.environment);
    });
  }
  const pager = (target, count, current, prefix) => {
    const el = document.querySelector(target);
    if (!el) return;
    const isAccount = prefix === 'account';
    const label = isAccount ? 'contas' : 'clientes';
    const total = Number(count) || 0;
    const totalPages = Math.ceil(total / 25);
    if (total <= 25) {
      el.innerHTML = total > 0
        ? '<span role="status" class="nx-muted">Total: ' + total + ' ' + (isAccount ? (total === 1 ? 'conta cadastrada' : 'contas cadastradas') : (total === 1 ? 'cliente cadastrado' : 'clientes cadastrados')) + '</span>'
        : '';
      return;
    }
    el.innerHTML = '<button class="button outline compact" aria-label="Página anterior de ' + label + '" data-page="' + prefix + '-prev"' + (current === 0 ? ' disabled' : '') + '>Anterior</button><span role="status" aria-live="polite">Página ' + (current + 1) + ' de ' + totalPages + ' · ' + total + ' ' + label + '</span><button class="button outline compact" aria-label="Próxima página de ' + label + '" data-page="' + prefix + '-next"' + ((current + 1) * 25 >= total ? ' disabled' : '') + '>Próxima</button>';
  };
  async function load() {
    const revision = ++request; say('Atualizando…');
    try {
      const result = await API.rpc('nexora_admin_snapshot', {p_query:query,p_page:page,p_limit:25,p_customer_query:customerQuery,p_customer_page:customerPage});
      if (revision !== request) return;
      data = result; render(); await Promise.all([loadKyc(), loadOperations(), loadDashboardMetrics(), loadAdminWebhooks(), loadReconciliationRuns(), loadMaturedReserves(), loadAdminPayouts(), loadAdminFundHolds(), loadLedgerBalances()]); render(); say('Dados carregados do Supabase · ' + new Date().toLocaleTimeString('pt-BR')); return true;
    } catch (error) { say(error.message); return false; }
  }
  async function loadDashboardMetrics() {
    try {
      dashboardMetrics = await API.rpc('nexora_admin_dashboard_metrics');
      dashboardMetricsError = '';
    } catch (_) {
      dashboardMetrics = null;
      dashboardMetricsError = 'Os gráficos ficam disponíveis após executar nexora-admin-dashboard-metrics.sql no Supabase.';
    }
    renderDashboardMetrics();
  }
  async function loadAdminWebhooks() {
    const target = document.querySelector('[data-admin-webhooks]');
    target.setAttribute('aria-busy','true');
    try {
      const deliveries = await API.rpc('nexora_admin_webhook_delivery_snapshot',{p_limit:100});
      target.innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Evento</th><th>Lojista / endpoint</th><th>Status</th><th>Última resposta</th><th>Tentativas</th><th>Atualizado</th><th>Ação</th></tr></thead><tbody>' + (deliveries || []).map(item => {
        const endpoint = (() => { try { const url = new URL(item.endpoint_url); return url.origin + url.pathname; } catch (_) { return 'Endpoint inválido'; } })();
        const attempts = Array.isArray(item.attempts) ? item.attempts : [];
        const history = attempts.length ? '<details><summary>Histórico (' + attempts.length + ')</summary><ol>' + attempts.map(attempt => '<li>Geração ' + Number(attempt.retry_generation) + ' · tentativa ' + Number(attempt.attempt_number) + ' · ' + e(attempt.outcome) + ' · HTTP ' + e(attempt.http_status ?? '—') + ' · ' + e(attempt.error_code || 'sem erro') + ' · ' + e(C.date(attempt.attempted_at)) + '</li>').join('') + '</ol></details>' : 'Sem tentativas registradas';
        const canRetry = ['dead','delivered'].includes(item.status) && Number(item.retry_generation) < 5;
        return '<tr><td><b>' + e(item.event) + '</b><small>ID evento ' + e(item.event_id) + '</small></td><td><b>' + e(item.business_name || 'Lojista') + '</b><small>' + e(item.merchant_email || '') + '</small><small>' + e(endpoint) + '</small></td><td>' + status(item.status) + (item.last_error_code ? '<small>' + e(item.last_error_code) + '</small>' : '') + '</td><td>' + e(item.last_http_status ?? '—') + '</td><td>' + Number(item.attempt_count) + ' · reenvio ' + Number(item.retry_generation) + '/5' + history + '</td><td>' + e(C.date(item.updated_at)) + '</td><td>' + (canRetry ? '<button class="table-action" type="button" data-webhook-retry="' + e(item.delivery_id) + '" aria-label="Reenviar webhook de ' + e(item.event) + ' para ' + e(item.business_name || 'lojista') + '">Reenviar</button>' : '—') + '</td></tr>';
      }).join('') + ((deliveries || []).length ? '' : '<tr><td colspan="7">Nenhuma entrega encontrada.</td></tr>') + '</tbody></table></div>';
    } catch (error) {
      target.innerHTML = '<p class="nx-muted">Não foi possível carregar webhooks. Confirme se a migração nexora-merchant-webhooks.sql foi executada e se sua sessão administrativa tem MFA.</p><p role="status">' + e(API.errorMessage(error)) + '</p>';
    } finally { target.setAttribute('aria-busy','false'); }
  }
  function reconciliationProviderOptions() {
    const select = document.querySelector('[data-reconciliation-form] [name="provider_code"]');
    if (!select) return;
    const choices = [
      ['asaas_production', 'Asaas · produção'],
      ['mercadopago_production', 'Mercado Pago · produção'],
    ];
    const current = select.value;
    const available = choices.filter(([code]) => acquirers.some(item => item.code === code && item.environment === 'production' && item.status === 'enabled'));
    select.innerHTML = available.length
      ? choices.map(([code, label]) => '<option value="' + code + '"' + (available.some(item => item[0] === code) ? '' : ' disabled') + '>' + label + (available.some(item => item[0] === code) ? '' : ' · não habilitado') + '</option>').join('')
      : '<option value="" selected disabled>Nenhum adquirente de produção habilitado</option>';
    select.value = available.some(([code]) => code === current) ? current : (available[0]?.[0] || '');
    const submit = select.form?.querySelector('[type="submit"]');
    if (submit) submit.disabled = available.length === 0;
  }
  async function loadReconciliationRuns() {
    const target = document.querySelector('[data-reconciliation-runs]');
    if (!target) return;
    reconciliationProviderOptions();
    target.setAttribute('aria-busy', 'true');
    try {
      const { data: result, error } = await window.nexoraSupabase.functions.invoke('nexora-reconciliation-admin', { body: {} });
      if (error) throw error;
      const labels = { asaas: 'Asaas', mercadopago: 'Mercado Pago' };
      const runs = Array.isArray(result?.runs) ? result.runs : [];
      target.innerHTML = '<h3>Execuções recentes</h3><div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Adquirente</th><th>Período</th><th>Linhas</th><th>Extrato</th><th>Executado em</th><th></th></tr></thead><tbody>' + runs.map(run => '<tr><td><b>' + e(labels[run.provider_code] || run.provider_code) + '</b><small>' + e(run.environment === 'production' ? 'Produção' : run.environment) + '</small></td><td>' + e(run.window_start) + (run.window_end !== run.window_start ? ' – ' + e(run.window_end) : '') + '</td><td>' + Number(run.entry_count) + '</td><td>' + (run.statement_complete ? 'Completo' : 'Incompleto') + '</td><td>' + e(C.date(run.created_at)) + '</td><td><button class="table-action" type="button" data-reconciliation-run="' + e(run.id) + '">Ver detalhes</button></td></tr>').join('') + (runs.length ? '' : '<tr><td colspan="6">Nenhuma conciliação registrada.</td></tr>') + '</tbody></table></div><p class="nx-muted">' + Number(result?.total || 0) + ' execução(ões) no total · exibindo as 25 mais recentes.</p>';
    } catch (error) {
      target.innerHTML = '<p class="nx-muted">Não foi possível carregar o histórico de conciliação. Confirme a publicação da Edge Function administrativa.</p><p role="status">' + e(API.errorMessage(error)) + '</p>';
    } finally { target.setAttribute('aria-busy', 'false'); }
  }
  async function loadMaturedReserves() {
    const target = document.querySelector('[data-matured-reserves]');
    if (!target) return;
    target.setAttribute('aria-busy', 'true');
    try {
      const { data: result, error } = await window.nexoraSupabase.functions.invoke('nexora-reserve-release', { body: { action: 'list', limit: 100 } });
      if (error) throw error;
      const reserves = Array.isArray(result?.reserves) ? result.reserves : [];
      target.innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Liquidação</th><th>Valor retido</th><th>Prazo encerrado em</th></tr></thead><tbody>' + reserves.map(item => '<tr><td>' + e(item.settlement_id) + '</td><td>' + e(C.money(Number(item.amount_cents) / 100)) + '</td><td>' + e(C.date(item.reserve_release_at)) + '</td></tr>').join('') + (reserves.length ? '' : '<tr><td colspan="3">Nenhuma reserva aguardando liberação.</td></tr>') + '</tbody></table></div><p class="nx-muted">' + reserves.length + ' reserva(s) madura(s) na fila · máximo exibido/processado: 100 por lote.</p>';
    } catch (error) {
      target.innerHTML = '<p class="nx-muted">Não foi possível consultar as reservas maduras. Confirme se a migration de holdback foi executada e se a Edge Function foi publicada.</p><p role="status">' + e(API.errorMessage(error)) + '</p>';
    } finally { target.setAttribute('aria-busy', 'false'); }
  }
  let adminPayoutFilter = 'all';
  let cachedAdminPayouts = [];
  let cachedDispatchEnabled = false;
  let cachedDispatchStateUnknown = false;

  function renderAdminPayoutRows() {
    const target = document.querySelector('[data-admin-payouts]');
    if (!target) return;
    const filtered = cachedAdminPayouts.filter(item => {
      if (adminPayoutFilter === 'pending') return item.status === 'RESERVED';
      if (adminPayoutFilter === 'approved') return item.status === 'APPROVED';
      if (adminPayoutFilter === 'succeeded') return item.status === 'SUCCEEDED';
      return true;
    });

    const dispatchEnabled = cachedDispatchEnabled;
    const dispatchStateUnknown = cachedDispatchStateUnknown;
    const rows = filtered.map(item => {
      const reconcilable = ['OUTCOME_UNKNOWN','PROCESSING','RISK_REVIEW'].includes(item.status)
        && ((item.provider_code === 'asaas_production' && item.adapter_code === 'asaas')
          || (item.provider_code === 'mercadopago_production' && item.provider_batch_id && item.provider_transfer_id));
      const actions = item.status === 'RESERVED'
        ? '<button class="table-action highlight" type="button" data-payout-review="approve" data-payout-id="' + e(item.payout_id) + '">Aprovar</button> <button class="table-action" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);" type="button" data-payout-review="complete_manual" data-payout-id="' + e(item.payout_id) + '" title="Dar baixa após realizar o Pix manualmente">Baixa Manual</button> <button class="table-action danger" type="button" data-payout-review="reject" data-payout-id="' + e(item.payout_id) + '">Rejeitar</button>'
        : item.status === 'APPROVED'
          ? (dispatchEnabled
            ? '<button class="table-action highlight" type="button" data-payout-review="dispatch" data-payout-id="' + e(item.payout_id) + '" title="Tenta enviar via API do adquirente">Enviar Pix API</button> '
            : '<button class="table-action" type="button" disabled aria-disabled="true" title="' + (dispatchStateUnknown ? 'Não foi possível confirmar as flags globais de envio' : 'A chave global de envio permanece desligada') + '">' + (dispatchStateUnknown ? 'Envio não verificado' : 'Envio desativado') + '</button> ') +
            '<button class="table-action" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);" type="button" data-payout-review="complete_manual" data-payout-id="' + e(item.payout_id) + '" title="Dar baixa após realizar o Pix manualmente">Baixa Manual</button> <button class="table-action danger" type="button" data-payout-review="reject" data-payout-id="' + e(item.payout_id) + '">Rejeitar</button>'
          : reconcilable
            ? '<button class="table-action" type="button" data-payout-review="reconcile" data-payout-id="' + e(item.payout_id) + '">Consultar status</button> <button class="table-action" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);" type="button" data-payout-review="complete_manual" data-payout-id="' + e(item.payout_id) + '">Baixa Manual</button>'
            : (item.status === 'OUTCOME_UNKNOWN')
              ? '<button class="table-action highlight" style="background:rgba(16,185,129,0.15);color:#10b981;border-color:rgba(16,185,129,0.3);" type="button" data-payout-review="complete_manual" data-payout-id="' + e(item.payout_id) + '">Baixa Manual</button> <button class="table-action danger" type="button" data-payout-review="reject" data-payout-id="' + e(item.payout_id) + '">Estornar</button>'
              : (['SUCCEEDED','COMPLETED'].includes(item.status) ? '<span class="nx-status paid">Concluído</span>' : '—');
      const pixBadge = item.pix_key
        ? '<div style="margin-top:4px;"><span class="badge" style="font-size:11px;background:rgba(99,102,241,0.12);color:#818cf8;padding:2px 8px;border-radius:4px;display:inline-flex;align-items:center;gap:6px;"><strong>Pix ' + e(item.pix_key_type || 'CHAVE') + ':</strong> <code style="color:#c7d2fe;letter-spacing:0.3px;">' + e(item.pix_key) + '</code></span></div>'
        : '';
      return '<tr><td><b>' + e(item.business_name || 'Workspace') + '</b><small>' + e(item.merchant_email || '') + '</small>' + pixBadge + '<small>ID ' + e(item.payout_id) + '</small></td><td>' + e(C.date(item.created_at)) + '</td><td>' + e(C.money(Number(item.amount_cents) / 100)) + '</td><td>' + status(item.status) + (item.failure_code ? '<br><small style="color:var(--danger,#f43f5e)">' + e(item.failure_code) + '</small>' : '') + '</td><td>' + e(item.provider_code || '—') + (item.provider_batch_id ? '<small>Lote ' + e(item.provider_batch_id) + '</small>' : '') + (item.provider_transfer_id ? '<small>Transação ' + e(item.provider_transfer_id) + '</small>' : '') + '</td><td>' + actions + '</td></tr>';
    });
    target.innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Lojista / Destino</th><th>Solicitado em</th><th>Valor</th><th>Status</th><th>Adquirente / referência</th><th>Ação</th></tr></thead><tbody>' + (rows.join('') || '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--muted)">Nenhum saque encontrado para o filtro selecionado.</td></tr>') + '</tbody></table></div>';
  }

  async function loadAdminPayouts() {
    const target = document.querySelector('[data-admin-payouts]');
    const message = document.querySelector('[data-admin-payout-message]');
    if (!target || !window.nexoraSupabase) return;
    target.setAttribute('aria-busy','true');
    try {
      let result;
      try {
        const { data: edgeResult, error: edgeError } = await window.nexoraSupabase.functions.invoke('nexora-payout-admin', { body: { action: 'list' } });
        if (edgeError) throw edgeError;
        result = edgeResult;
      } catch (invokeError) {
        console.warn('Falha na Edge Function nexora-payout-admin, usando RPC direta', invokeError);
        const rpcPayouts = await API.rpc('nexora_admin_list_payouts', { p_limit: 100 });
        result = {
          payouts: Array.isArray(rpcPayouts) ? rpcPayouts : [],
          dispatch_enabled: false,
          dispatch_state: 'unknown',
        };
      }
      const payouts = Array.isArray(result?.payouts) ? result.payouts : [];
      const dispatchEnabled = result?.dispatch_enabled === true;
      const dispatchStateUnknown = result?.dispatch_state === 'unknown';
      cachedAdminPayouts = payouts;
      cachedDispatchEnabled = dispatchEnabled;
      cachedDispatchStateUnknown = dispatchStateUnknown;

      const metricsContainer = document.querySelector('[data-admin-payout-metrics]');
      if (metricsContainer) {
        const totalAmount = payouts.reduce((sum, p) => sum + Number(p.amount_cents || 0), 0) / 100;
        const reservedPayouts = payouts.filter(p => p.status === 'RESERVED');
        const approvedPayouts = payouts.filter(p => p.status === 'APPROVED');
        const succeededPayouts = payouts.filter(p => p.status === 'SUCCEEDED' || p.status === 'COMPLETED');
        const reservedAmount = reservedPayouts.reduce((sum, p) => sum + Number(p.amount_cents || 0), 0) / 100;
        const approvedAmount = approvedPayouts.reduce((sum, p) => sum + Number(p.amount_cents || 0), 0) / 100;
        const succeededAmount = succeededPayouts.reduce((sum, p) => sum + Number(p.amount_cents || 0), 0) / 100;

        metricsContainer.innerHTML = '<article class="metric-card"><span>Total de Solicitações</span><strong>' + payouts.length + '</strong><small>' + C.money(totalAmount) + ' acumulado</small></article>' +
          '<article class="metric-card" style="border-left: 3px solid #f59e0b;"><span style="color:#f59e0b;">Aguardando Aprovação</span><strong>' + reservedPayouts.length + '</strong><small>' + C.money(reservedAmount) + ' retido no ledger</small></article>' +
          '<article class="metric-card" style="border-left: 3px solid #8b5cf6;"><span style="color:#8b5cf6;">Prontos para Envio Pix</span><strong>' + approvedPayouts.length + '</strong><small>' + C.money(approvedAmount) + ' aprovado</small></article>' +
          '<article class="metric-card" style="border-left: 3px solid #10b981;"><span style="color:#10b981;">Concluídos</span><strong>' + succeededPayouts.length + '</strong><small>' + C.money(succeededAmount) + ' transferido</small></article>';
      }

      const tabsContainer = document.querySelector('[data-admin-payout-tabs]');
      if (tabsContainer) {
        const reservedCount = payouts.filter(p => p.status === 'RESERVED').length;
        const approvedCount = payouts.filter(p => p.status === 'APPROVED').length;
        const succeededCount = payouts.filter(p => p.status === 'SUCCEEDED' || p.status === 'COMPLETED').length;
        tabsContainer.innerHTML = '<button type="button" role="tab" class="' + (adminPayoutFilter === 'all' ? 'active' : '') + '" data-payout-tab="all">Todos (' + payouts.length + ')</button>' +
          '<button type="button" role="tab" class="' + (adminPayoutFilter === 'pending' ? 'active' : '') + '" data-payout-tab="pending">Aguardando Aprovação (' + reservedCount + ')</button>' +
          '<button type="button" role="tab" class="' + (adminPayoutFilter === 'approved' ? 'active' : '') + '" data-payout-tab="approved">Prontos para Envio Pix (' + approvedCount + ')</button>' +
          '<button type="button" role="tab" class="' + (adminPayoutFilter === 'succeeded' ? 'active' : '') + '" data-payout-tab="succeeded">Concluídos (' + succeededCount + ')</button>';
      }

      renderAdminPayoutRows();

      if (message) message.textContent = payouts.length + ' solicitação(ões) carregada(s).' + (dispatchEnabled
        ? ' O envio global está habilitado; cada saque ainda exige validação individual.'
        : dispatchStateUnknown ? ' Não foi possível verificar a configuração global; o envio permanece bloqueado, mas a revisão segue disponível.'
          : ' O envio de Pix está desativado pela configuração global.');
    } catch (error) {
      target.innerHTML = '<p class="nx-muted">Não foi possível carregar a fila de revisão. Confirme se a migração nexora-payout-core.sql foi executada e se a Edge Function nexora-payout-admin foi publicada.</p><p role="status">' + e(API.errorMessage(error)) + '</p>';
      if (message) message.textContent = 'Fila de saques indisponível.';
    } finally { target.setAttribute('aria-busy','false'); }
  }
  function reviewAdminPayout(payoutId, decision) {
    const item = cachedAdminPayouts.find(p => p.payout_id === payoutId);
    const approving = decision === 'approve';
    const dispatching = decision === 'dispatch';
    const reconciling = decision === 'reconcile';
    const completingManual = decision === 'complete_manual';
    const title = completingManual ? 'Confirmar Baixa Manual (Pix Realizado)?' : reconciling ? 'Consultar status do saque?' : dispatching ? 'Enviar Pix do saque via API?' : approving ? 'Aprovar solicitação de saque?' : 'Rejeitar solicitação de saque?';
    
    let contentHtml = '';
    if (completingManual) {
      const pixInfo = item?.pix_key ? '<div class="nx-callout info" style="margin-bottom:12px;padding:12px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:8px;"><p style="margin:0 0 6px 0;"><strong>Destino Pix do Lojista:</strong></p><p style="margin:0;line-height:1.5;">Tipo: <b>' + e(item.pix_key_type || 'Pix') + '</b><br>Chave Pix: <code style="font-size:13px;font-weight:bold;color:#6366f1;">' + e(item.pix_key) + '</code><br>Valor: <b style="font-size:14px;color:#10b981;">' + e(C.money(Number(item.amount_cents || 0)/100)) + '</b><br>Favorecido: <b>' + e(item.business_name || '') + ' (' + e(item.merchant_email || '') + ')</b></p></div>' : '';
      contentHtml = pixInfo +
        '<p>Transfira o valor via Pix no app do seu banco para a chave informada acima. Em seguida, informe abaixo o código do comprovante (ID End-to-End ou protocolo) para dar a baixa e liquidar o saldo com auditoria completa no ledger.</p>' +
        '<label class="nx-field">ID End-to-End ou Código do Comprovante (obrigatório)<input name="provider_transfer_id" required placeholder="Ex: E0000000020261013..." maxlength="100" style="width:100%" autofocus></label>' +
        '<label class="nx-field" style="margin-top:8px;">Observação / Motivo<input name="reason" maxlength="500" value="Saque Pix realizado e transferido manualmente pelo Super Admin." style="width:100%"></label>';
    } else {
      const reasonField = (approving || dispatching || reconciling)
        ? ''
        : '<label class="nx-field">Motivo da rejeição<textarea name="reason" rows="3" minlength="5" maxlength="500" placeholder="Informe o motivo da recusa (opcional)." style="width:100%;resize:vertical"></textarea></label>';
      const explanation = reconciling
        ? 'A ação fará somente uma consulta GET ao adquirente e registrará o resultado na auditoria. Nenhum Pix será enviado. Se o adquirente não confirmar a identidade, o status não será alterado.'
        : dispatching
        ? 'Esta ação tentará enviar a transferência Pix automática via API do Mercado Pago. Caso o Mercado Pago recuse por falta de permissão de Payouts na conta (HTTP 403), você poderá realizar a Baixa Manual.'
        : approving ? 'A aprovação valida o saque para processamento. Nenhum valor adicional será debitado e os fundos permanecem reservados até o envio.' : 'A rejeição libera o valor reservado de volta para o saldo disponível do lojista pelo ledger.';
      contentHtml = '<p>' + explanation + '</p>' + reasonField;
    }

    UI.modal(title,
      contentHtml,
      async dialog => {
        const inputReason = (dialog.querySelector('[name=reason]')?.value || '').trim();
        const inputTransferId = (dialog.querySelector('[name=provider_transfer_id]')?.value || '').trim();
        if (completingManual && !inputTransferId) {
          throw new Error('Informe o código / ID da transferência Pix para confirmar a baixa.');
        }
        const defaultReason = approving
          ? 'Aprovação de saque confirmada pelo Super Admin.'
          : dispatching
          ? 'Envio Pix autorizado pelo Super Admin.'
          : reconciling
          ? 'Consulta de conciliação de saque solicitada pelo Super Admin.'
          : completingManual
          ? 'Saque Pix realizado e transferido manualmente pelo Super Admin.'
          : 'Rejeição de saque solicitada pelo Super Admin.';
        const reason = inputReason.length >= 10 ? inputReason : defaultReason;
        let result;
        try {
          const payload = completingManual
            ? { action: 'complete_manual', payout_id: payoutId, provider_transfer_id: inputTransferId, reason }
            : { action: decision, payout_id: payoutId, reason };
          const { data: edgeResult, error: edgeError } = await window.nexoraSupabase.functions.invoke('nexora-payout-admin', { body: payload });
          if (edgeError) {
            let msg = edgeError.message;
            try {
              const body = await edgeError.context?.clone().json();
              if (body?.error) {
                const map = {
                  'payout_callback_configuration_invalid': 'Configuração de webhook de saque do Mercado Pago ausente nas chaves do servidor.',
                  'payout_signing_configuration_invalid': 'Chave Ed25519 de assinatura de saque do Mercado Pago não configurada.',
                  'payout_credential_validation_failed': 'Credencial do provedor não autorizada para transferências.',
                  'payout_dispatch_disabled': 'Envio global de saques desativado.',
                  'payout_not_ready_for_dispatch': 'O saque não está no estado aprovado ou já foi enviado.',
                  'admin_mfa_required': 'Sessão 2FA do Super Admin necessária.',
                };
                msg = map[body.error] || body.error;
              }
            } catch (_) {}
            const err = new Error(msg);
            err.code = edgeError.code;
            throw err;
          }
          result = edgeResult;
        } catch (edgeError) {
          if (completingManual) {
            console.warn('Edge Function indisponível para baixa manual, usando RPC direta', edgeError);
            const status = await API.rpc('nexora_admin_complete_manual_payout', {
              p_payout_id: payoutId,
              p_provider_transfer_id: inputTransferId,
              p_reason: reason
            });
            result = { status };
          } else if (decision === 'approve' || decision === 'reject') {
            console.warn('Edge Function indisponível para revisão, usando RPC direta', edgeError);
            const status = await API.rpc('nexora_admin_review_payout', { p_payout_id: payoutId, p_decision: decision, p_reason: reason });
            result = { status };
          } else {
            throw edgeError;
          }
        }
        if (!result?.status) throw new Error('O backoffice não confirmou a decisão.');
        await loadAdminPayouts();

        if (dispatching && result.status === 'OUTCOME_UNKNOWN' && result.failure_code === 'mercadopago_payout_rejected_403') {
          UI.modal('Envio Automático Não Autorizado pelo Mercado Pago',
            '<div class="nx-callout warning" style="margin-bottom:12px;padding:12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:8px;"><p style="margin:0 0 6px 0;"><strong>Mercado Pago bloqueou a transferência automática (HTTP 403).</strong></p><p style="margin:0;font-size:13px;color:var(--muted)">A conta do Mercado Pago não possui a API de Payouts/Transferências liberada comercialmente. O valor permanece seguro e reservado no ledger.</p></div>' +
            '<p><b>Como concluir este saque:</b></p>' +
            '<p>1. Transfira o valor de <b>' + e(C.money(Number(item?.amount_cents || 0)/100)) + '</b> via Pix pelo aplicativo do seu banco para a chave: <b>' + e(item?.pix_key || '') + '</b> (' + e(item?.pix_key_type || 'Pix') + ').</p>' +
            '<p>2. Clique em <b>"Baixa Manual"</b> na lista de saques para registrar o ID do Pix e finalizar.</p>',
            null, { submitLabel: 'Entendido' }
          );
          return;
        }

        UI.toast(completingManual
          ? 'Baixa manual confirmada com sucesso! Saque concluído.'
          : reconciling
          ? result.found === false ? (result.message || 'Não houve correspondência exata; o status não foi alterado.') : 'Consulta somente leitura concluída. Status atual: ' + result.status
          : dispatching
          ? result.status === 'OUTCOME_UNKNOWN' ? ('Envio sem confirmação final.' + (result.failure_code ? ' Motivo: ' + result.failure_code + '.' : '') + ' Não tente reenviar; confira o status do saque.') : 'Solicitação enviada ao adquirente. O status será confirmado por consulta/webhook.'
          : approving ? 'Aprovação registrada com sucesso.' : 'Rejeição registrada e saldo liberado no ledger.');
      }, { submitLabel: completingManual ? 'Confirmar Baixa Pix' : reconciling ? 'Consultar sem enviar' : dispatching ? 'Autorizar envio Pix API' : approving ? 'Aprovar saque' : 'Confirmar rejeição' });
  }
  function releaseMaturedReserves() {
    UI.confirm('Processar reservas maduras?', 'O sistema moverá cada retenção vencida para o saldo disponível pelo ledger. Isso não envia Pix nem inicia saque. O lote processa até 100 reservas e pode ser repetido com segurança.', async () => {
      const button = document.querySelector('[data-reserve-release]');
      const message = document.querySelector('[data-reserve-message]');
      button.disabled = true; message.textContent = 'Processando lote de reservas…';
      try {
        const { data: result, error } = await window.nexoraSupabase.functions.invoke('nexora-reserve-release', { body: { action: 'release', limit: 100 } });
        if (error) throw error;
        message.textContent = Number(result?.released || 0) + ' reserva(s) liberada(s); ' + Number(result?.failed || 0) + ' falha(s).';
        await loadMaturedReserves();
      } catch (error) {
        message.textContent = 'Não foi possível processar as reservas: ' + API.errorMessage(error);
      } finally { button.disabled = false; }
    }, 'Processar lote');
  }
  async function loadReconciliationDetail(runId, itemsOffset = 0, exceptionsOffset = 0) {
    const target = document.querySelector('[data-reconciliation-detail]');
    target.textContent = 'Carregando detalhes da conciliação…';
    try {
      const { data, error } = await window.nexoraSupabase.functions.invoke('nexora-reconciliation-admin', { body: { run_id: runId, items_offset: itemsOffset, exceptions_offset: exceptionsOffset } });
      if (error) throw error;
      const result = data;
      const run = result.run;
      const labels = { matched: 'Conciliado', divergent: 'Divergente', incomplete: 'Incompleto' };
      const items = (result.items || []).map(item => {
        const issues = Array.isArray(item.issues) ? item.issues.map(issue => typeof issue === 'string' ? issue : issue?.code || issue?.issue_code || 'divergência').join(', ') : '—';
        return '<tr><td><b>' + e(labels[item.result] || item.result) + '</b><small>' + e(issues) + '</small></td><td>' + e(item.transaction_id) + '</td><td>' + e(item.provider_transaction_id) + '</td><td>' + e(item.gross_amount_cents == null ? '—' : C.money(Number(item.gross_amount_cents) / 100)) + '</td><td>' + e(item.provider_fee_cents == null ? '—' : C.money(Number(item.provider_fee_cents) / 100)) + '</td><td>' + e(item.expected_provider_fee_cents == null ? '—' : C.money(Number(item.expected_provider_fee_cents) / 100)) + '</td></tr>';
      }).join('');
      const exceptions = (result.exceptions || []).map(item => '<tr><td>' + e(item.issue_code) + '</td><td>' + e(item.external_entry_id) + '</td><td>' + e(item.provider_transaction_id || 'Sem referência') + '</td><td>' + e(item.evidence_sha256) + '</td></tr>').join('');
      const itemsPager = '<div class="nx-pager"><button class="button outline compact" type="button" data-reconciliation-page="' + Math.max(0, Number(itemsOffset) - result.page_size) + '" data-reconciliation-page-run="' + e(runId) + '" data-current-exceptions="' + Number(exceptionsOffset) + '"' + (Number(itemsOffset) === 0 ? ' disabled' : '') + '>Anterior</button><span>Pagamentos ' + Math.min(Number(itemsOffset) + 1, Number(result.items_total)) + '–' + Math.min(Number(itemsOffset) + result.page_size, result.items_total) + ' de ' + Number(result.items_total) + '</span><button class="button outline compact" type="button" data-reconciliation-page="' + (Number(itemsOffset) + result.page_size) + '" data-reconciliation-page-run="' + e(runId) + '" data-current-exceptions="' + Number(exceptionsOffset) + '"' + (Number(itemsOffset) + result.page_size >= result.items_total ? ' disabled' : '') + '>Próxima</button></div>';
      const exceptionsPager = '<div class="nx-pager"><button class="button outline compact" type="button" data-reconciliation-exception-page="' + Math.max(0, Number(exceptionsOffset) - result.page_size) + '" data-reconciliation-exception-run="' + e(runId) + '" data-current-items="' + Number(itemsOffset) + '"' + (Number(exceptionsOffset) === 0 ? ' disabled' : '') + '>Anterior</button><span>Exceções ' + Math.min(Number(exceptionsOffset) + 1, Number(result.exceptions_total)) + '–' + Math.min(Number(exceptionsOffset) + result.page_size, result.exceptions_total) + ' de ' + Number(result.exceptions_total) + '</span><button class="button outline compact" type="button" data-reconciliation-exception-page="' + (Number(exceptionsOffset) + result.page_size) + '" data-reconciliation-exception-run="' + e(runId) + '" data-current-items="' + Number(itemsOffset) + '"' + (Number(exceptionsOffset) + result.page_size >= result.exceptions_total ? ' disabled' : '') + '>Próxima</button></div>';
      target.innerHTML = '<section class="admin-nested-section"><div class="admin-panel-head"><div><h3>Detalhes · ' + e(run.provider_code) + ' · ' + e(run.window_start) + '</h3><p>ID da execução: ' + e(run.id) + ' · SHA-256 do extrato: ' + e(run.statement_sha256) + '</p></div><button class="button outline compact" type="button" data-reconciliation-close>Fechar detalhes</button></div><div class="admin-reconciliation-summary"><span>Conciliados <b>' + Number(result.matched_total) + '</b></span><span>Divergentes <b>' + Number(result.divergent_total) + '</b></span><span>Incompletos <b>' + Number(result.incomplete_total) + '</b></span><span>Exceções <b>' + Number(result.exceptions_total) + '</b></span></div><h4>Pagamentos comparados</h4><div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Resultado / divergências</th><th>ID interno</th><th>Referência do provedor</th><th>Bruto</th><th>Tarifa provedor</th><th>Tarifa esperada</th></tr></thead><tbody>' + (items || '<tr><td colspan="6">Nenhum pagamento vinculado neste período.</td></tr>') + '</tbody></table></div>' + (result.items_total > result.page_size ? itemsPager : '') + '<h4>Exceções do extrato</h4><div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Tipo</th><th>ID da linha do extrato</th><th>Referência</th><th>Hash da evidência</th></tr></thead><tbody>' + (exceptions || '<tr><td colspan="4">Nenhuma exceção registrada.</td></tr>') + '</tbody></table></div>' + (result.exceptions_total > result.page_size ? exceptionsPager : '') + '<p class="nx-muted">A conciliação é evidência operacional; não move saldo nem libera saque.</p></section>';
      if (run.environment === 'production' && run.statement_complete && Number(result.matched_total) > 0) {
        target.querySelector('.admin-panel-head')?.insertAdjacentHTML('beforeend', '<button class="button button-primary compact" type="button" data-reconciliation-settle-run="' + e(run.id) + '">Registrar liquidações conciliadas</button>');
        target.querySelector('.admin-reconciliation-summary')?.insertAdjacentHTML('afterend', '<p class="nx-muted" data-settlement-message role="status" aria-live="polite">Registrar settlement atualiza o ledger após conciliação completa; não envia Pix nem efetua saque.</p>');
      }
    } catch (error) { target.innerHTML = '<p role="status">Não foi possível carregar os detalhes: ' + e(API.errorMessage(error)) + '</p>'; }
  }
  function settleReconciliationRun(runId) {
    UI.confirm('Registrar settlements conciliados?', 'Esta ação reconhecerá no ledger somente pagamentos matched do extrato completo de produção selecionado. Não envia Pix nem executa saques. O lote processa até 100 itens; divergências e pendências ficam de fora.', async () => {
      const button = [...document.querySelectorAll('[data-reconciliation-settle-run]')].find(item => item.dataset.reconciliationSettleRun === runId);
      if (button) button.disabled = true;
      const message = document.querySelector('[data-settlement-message]');
      if (message) message.textContent = 'Validando evidências e registrando settlements…';
      try {
        const { data: result, error } = await window.nexoraSupabase.functions.invoke('nexora-settlement-release', { body: { run_id: runId, limit: 100 } });
        if (error) throw error;
        await loadReconciliationDetail(runId);
        const output = document.querySelector('[data-settlement-message]');
        if (output) output.textContent = Number(result?.released || 0) + ' settlement(s) registrado(s) no ledger; ' + Number(result?.failed || 0) + ' falha(s).';
      } catch (error) {
        const output = document.querySelector('[data-settlement-message]');
        if (output) output.textContent = 'Falha ao registrar settlements: ' + API.errorMessage(error);
      } finally {
        const current = [...document.querySelectorAll('[data-reconciliation-settle-run]')].find(item => item.dataset.reconciliationSettleRun === runId);
        if (current) current.disabled = false;
      }
    }, 'Registrar no ledger');
  }
  async function runReconciliation(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity() || form.dataset.busy === 'true') return;
    const submit = form.querySelector('[type="submit"]');
    const message = document.querySelector('[data-reconciliation-message]');
    form.dataset.busy = 'true'; submit.disabled = true; submit.textContent = 'Importando…';
    message.textContent = 'Consultando o extrato e comparando pagamentos. Isso pode levar alguns minutos.';
    try {
      const { data, error } = await window.nexoraSupabase.functions.invoke('nexora-reconcile-asaas', { body: { provider_code: form.elements.provider_code.value, date: form.elements.date.value } });
      if (error) {
        let detail = error.message || 'A importação falhou.';
        try { const payload = await error.context?.clone?.().json(); if (payload?.error) detail = payload.error; } catch (_) {}
        throw new Error(detail);
      }
      if (!data?.run_id) throw new Error(data?.error || 'A execução não retornou um identificador.');
      message.textContent = 'Conciliação concluída: ' + Number(data.entries) + ' linha(s) do extrato; ' + Number(data.matched || 0) + ' pagamento(s) conciliado(s), ' + Number(data.divergent || 0) + ' divergente(s) ou incompleto(s), ' + Number(data.exceptions || 0) + ' exceção(ões). Nenhum saldo foi liberado.';
      await loadReconciliationRuns();
      await loadReconciliationDetail(data.run_id);
    } catch (error) { message.textContent = 'Não foi possível conciliar: ' + API.errorMessage(error); }
    finally { form.dataset.busy = 'false'; submit.disabled = false; submit.textContent = 'Importar e conciliar'; reconciliationProviderOptions(); }
  }
  function retryMerchantWebhook(deliveryId) {
    UI.modal('Reenviar webhook?', '<p>O lojista pode receber o mesmo evento novamente. Confirme que o endpoint é idempotente e informe o motivo operacional, que será registrado no histórico.</p><label class="nx-field">Motivo do reenvio<textarea name="reason" rows="3" minlength="8" maxlength="500" required></textarea></label>', async dialog => {
      const reason = dialog.querySelector('[name=reason]').value.trim();
      if (reason.length < 8) throw new Error('Informe um motivo com pelo menos 8 caracteres.');
      await API.rpc('nexora_admin_webhook_retry_delivery',{p_delivery_id:deliveryId,p_reason:reason});
      await loadAdminWebhooks(); UI.toast('Webhook colocado na fila para reenvio.');
    },{submitLabel:'Confirmar reenvio'});
  }
  async function loadOperations() {
    const results = await Promise.allSettled([
      API.rpc('nexora_admin_acquirers'), API.rpc('nexora_admin_provider_connections'),
      API.rpc('nexora_admin_merchant_controls'), API.rpc('nexora_admin_notifications',{p_unread_only:false}),
      window.nexoraSupabase.functions.invoke('nexora-payments',{body:{action:'catalog'}}),
      API.rpc('nexora_admin_platform_provider_credentials'),
      API.rpc('nexora_admin_provider_health_snapshot')
    ]);
    acquirers = results[0].status === 'fulfilled' ? results[0].value || [] : [];
    connections = results[1].status === 'fulfilled' ? results[1].value || [] : [];
    merchantControls = results[2].status === 'fulfilled' ? results[2].value || [] : [];
    alerts = results[3].status === 'fulfilled' ? results[3].value || [] : [];
    providerCatalog = results[4].status === 'fulfilled' ? results[4].value?.data?.providers || [] : [];
    platformCredentials = results[5].status === 'fulfilled' ? results[5].value || [] : [];
    renderOperations(results);
    renderFundHoldMerchants();
    renderActiveCautions();
    reconciliationProviderOptions();
  }
  function renderActiveCautions() {
    const target = document.querySelector('[data-active-cautions]');
    if (!target) return;
    const restricted = (merchantControls || []).filter(ctrl =>
      ctrl.withdrawals_enabled === false ||
      ctrl.pix_out_enabled === false ||
      ctrl.balance_movements_blocked === true
    );
    if (!restricted.length) {
      target.innerHTML = '<p class="nx-empty">Nenhum bloqueio cautelar ativo. Todas as contas aprovadas operam normalmente sem restrições cautelares.</p>';
      return;
    }
    const rows = restricted.map(ctrl => {
      const badges = [];
      if (ctrl.balance_movements_blocked) badges.push('<span class="nx-status cancelled">Movimentações Congeladas</span>');
      if (ctrl.withdrawals_enabled === false) badges.push('<span class="nx-status cancelled">Saques Bloqueados</span>');
      if (ctrl.pix_out_enabled === false) badges.push('<span class="nx-status pending">Pix OUT Bloqueado</span>');
      return '<tr>' +
        '<td><b>' + e(ctrl.business_name || 'Lojista') + '</b><br><small>' + e(ctrl.email || '') + '</small></td>' +
        '<td>' + (badges.join(' ') || '—') + '</td>' +
        '<td><button class="table-action" type="button" data-cautelar-edit="' + e(ctrl.owner_id) + '">Editar restrições</button></td>' +
        '</tr>';
    }).join('');
    target.innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th scope="col">Conta / Lojista</th><th scope="col">Restrições Cautelares Ativas</th><th scope="col">Ação</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function openCautelarModal(selectedOwnerId) {
    const merchants = (merchantControls || []).filter(c => c.business_id && c.owner_id);
    if (!merchants.length) {
      UI.toast('Nenhum lojista disponível para aplicar restrições cautelares.');
      return;
    }
    const currentOwnerId = selectedOwnerId || merchants[0].owner_id;
    const currentCtrl = merchants.find(c => c.owner_id === currentOwnerId) || merchants[0];
    const merchantOptions = merchants.map(m =>
      '<option value="' + e(m.owner_id) + '" ' + (m.owner_id === currentCtrl.owner_id ? 'selected' : '') + '>' + e(m.business_name || 'Lojista') + ' (' + e(m.email) + ')</option>'
    ).join('');

    const body = '<p>Aplique restrições preventivas em caso de suspeita de fraude, contestação de chargeback ou inconformidade de compliance. O bloqueio é imediato e auditado.</p>' +
      '<label class="nx-field">Lojista<select name="cautelar_owner" required>' + merchantOptions + '</select></label>' +
      '<fieldset class="nx-cautelar-fieldset">' +
      '<legend>Medidas Preventivas</legend>' +
      '<label class="nx-check"><input type="checkbox" name="cautelar_block_withdrawals" ' + (currentCtrl.withdrawals_enabled === false ? 'checked' : '') + '> <strong>Bloquear saques</strong><small class="nx-muted"><br>Impede novas solicitações de transferência e saque pelo painel.</small></label>' +
      '<label class="nx-check"><input type="checkbox" name="cautelar_block_pix_out" ' + (currentCtrl.pix_out_enabled === false ? 'checked' : '') + '> <strong>Bloquear Pix OUT</strong><small class="nx-muted"><br>Suspende envios diretos via Pix pelo conector do provedor.</small></label>' +
      '<label class="nx-check"><input type="checkbox" name="cautelar_freeze_all" ' + (currentCtrl.balance_movements_blocked === true ? 'checked' : '') + '> <strong>Congelar todas as saídas no ledger</strong><small class="nx-muted"><br>Trava qualquer débito ou movimentação de saída mantendo o saldo existente intacto.</small></label>' +
      '</fieldset>' +
      '<label class="nx-field">Justificativa operacional auditada<textarea name="cautelar_reason" rows="3" minlength="10" maxlength="500" required placeholder="Descreva o motivo da restrição preventiva (ex: Suspeita de fraude / contestação)."></textarea></label>';

    const modalDialog = UI.modal('Bloqueio Cautelar Preventivo', body, async dialog => {
      const ownerId = dialog.querySelector('[name=cautelar_owner]').value;
      const targetCtrl = merchants.find(m => m.owner_id === ownerId);
      if (!targetCtrl) throw new Error('Selecione uma conta válida.');
      const reason = dialog.querySelector('[name=cautelar_reason]').value.trim();
      if (reason.length < 10) throw new Error('A justificativa deve ter pelo menos 10 caracteres.');

      const blockWithdrawals = dialog.querySelector('[name=cautelar_block_withdrawals]').checked;
      const blockPixOut = dialog.querySelector('[name=cautelar_block_pix_out]').checked;
      const freezeAll = dialog.querySelector('[name=cautelar_freeze_all]').checked;

      const configurePayload = {
        p_owner_id: ownerId,
        p_update_acquirer: false,
        p_acquirer_id: null,
        p_payments_enabled: targetCtrl.payments_enabled !== false,
        p_withdrawals_enabled: !blockWithdrawals,
        p_api_enabled: targetCtrl.api_enabled === true,
        p_pix_out_enabled: !blockPixOut,
        p_balance_movements_blocked: freezeAll,
        p_withdrawal_mode: targetCtrl.withdrawal_mode || 'manual',
        p_max_transfer_amount: targetCtrl.max_transfer_amount || 5000,
        p_daily_transfer_limit: targetCtrl.daily_transfer_limit || 20000,
        p_alert_threshold_amount: targetCtrl.alert_threshold_amount || 5000,
        p_reserve_percentage: targetCtrl.reserve_percentage || 0,
        p_reserve_days: targetCtrl.reserve_days || 0
      };

      await API.rpc('nexora_admin_configure_merchant', configurePayload);
      await loadOperations();
      renderActiveCautions();
      UI.toast('Restrições cautelares atualizadas com sucesso.');
    }, { submitLabel: 'Aplicar restrições' });

    const selectEl = modalDialog?.querySelector('[name=cautelar_owner]');
    if (selectEl) {
      selectEl.addEventListener('change', event => {
        const selCtrl = merchants.find(m => m.owner_id === event.target.value);
        if (selCtrl) {
          modalDialog.querySelector('[name=cautelar_block_withdrawals]').checked = (selCtrl.withdrawals_enabled === false);
          modalDialog.querySelector('[name=cautelar_block_pix_out]').checked = (selCtrl.pix_out_enabled === false);
          modalDialog.querySelector('[name=cautelar_freeze_all]').checked = (selCtrl.balance_movements_blocked === true);
        }
      });
    }
  }
  function renderFundHoldMerchants() {
    const select = document.querySelector('[data-fund-hold-form] [name="business_id"]');
    if (!select) return;
    const previous = select.value;
    const merchants = merchantControls.filter(item => item.business_id && item.owner_id);
    select.innerHTML = '<option value="">Selecione uma empresa</option>' + merchants.map(item =>
      '<option value="' + e(item.business_id) + '">' + e(item.business_name || 'Workspace') + ' · ' + e(item.email || '') + '</option>'
    ).join('');
    if (merchants.some(item => item.business_id === previous)) select.value = previous;
    if (!merchants.length) select.innerHTML = '<option value="">Nenhuma conta aprovada disponível</option>';
  }
  async function loadAdminFundHolds() {
    const target = document.querySelector('[data-admin-fund-holds]');
    if (!target || !window.nexoraSupabase) return;
    target.setAttribute('aria-busy','true');
    try {
      const { data: result, error } = await window.nexoraSupabase.functions.invoke('nexora-fund-controls', { body: { action: 'list' } });
      if (error) throw error;
      const holds = Array.isArray(result?.holds) ? result.holds : [];
      const rows = holds.map(item => {
        const released = Boolean(item.release_id);
        const action = released ? '<span class="nx-status paid">Liberado</span>'
          : '<button class="table-action" type="button" data-fund-hold-release="' + e(item.hold_id) + '" data-business-name="' + e(item.business_name || 'lojista') + '" data-hold-amount="' + Number(item.amount_cents) + '" aria-label="Liberar saldo bloqueado de ' + e(item.business_name || 'lojista') + '">Liberar saldo</button>';
        return '<tr><td><b>' + e(item.business_name || 'Workspace') + '</b><small>' + e(item.merchant_email || '') + '</small><small>Bloqueio ' + e(item.hold_id) + '</small></td>' +
          '<td>' + e(C.money(Number(item.amount_cents) / 100)) + '</td><td>' + e(C.money(Number(item.available_cents) / 100)) + '</td>' +
          '<td>' + e(C.money(Number(item.blocked_cents) / 100)) + '</td><td>' + e(item.reason) + (released ? '<small>Liberação: ' + e(item.release_reason) + '</small>' : '') + '</td>' +
          '<td>' + e(C.date(item.created_at)) + (released ? '<small>Liberado em ' + e(C.date(item.released_at)) + '</small>' : '') + '</td><td>' + action + '</td></tr>';
      });
      target.innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Lojista</th><th>Valor bloqueado</th><th>Disponível atual</th><th>Bloqueado atual</th><th>Justificativa / liberação</th><th>Data</th><th>Ação</th></tr></thead><tbody>' +
        (rows.join('') || '<tr><td colspan="7">Nenhum bloqueio manual de saldo registrado.</td></tr>') + '</tbody></table></div>' +
        '<p class="nx-muted">Exibindo até 100 bloqueios mais recentes. A liberação devolve o valor integral do bloqueio ao saldo disponível.</p>';
    } catch (error) {
      target.innerHTML = '<p class="nx-muted">Não foi possível carregar o histórico de saldo bloqueado. Confirme a migration nexora-fund-holds.sql e a publicação da Edge Function nexora-fund-controls.</p><p role="status">' + e(API.errorMessage(error)) + '</p>';
    } finally { target.setAttribute('aria-busy','false'); }
  }
  function releaseMerchantFunds(holdId, businessName, amountCents) {
    const requestId = crypto.randomUUID();
    UI.modal('Liberar saldo bloqueado?', '<p><b>' + e(businessName) + '</b> · ' + e(C.money(amountCents / 100)) + '</p><p>O valor integral será debitado do bucket bloqueado e creditado no saldo disponível pelo ledger. Nenhum Pix será enviado.</p><label class="nx-field">Motivo da liberação<textarea name="reason" rows="3" minlength="10" maxlength="500" required></textarea></label>', async dialog => {
      const reason = dialog.querySelector('[name=reason]').value.trim();
      if (reason.length < 10) throw new Error('Informe um motivo com pelo menos 10 caracteres.');
      const { data: result, error } = await window.nexoraSupabase.functions.invoke('nexora-fund-controls', { body: { action: 'release', hold_id: holdId, request_id: requestId, reason } });
      if (error) throw error;
      if (result?.status !== 'released') throw new Error(result?.error || 'A liberação não foi confirmada.');
      await loadAdminFundHolds();
      UI.toast('Saldo desbloqueado e devolvido ao bucket disponível.');
    }, { submitLabel: 'Liberar saldo' });
  }
  async function checkProviderHealth(button = document.querySelector('[data-provider-health-check]')) {
    if (!button || button.disabled) return;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Verificando…';
    try {
      const { data: result, error } = await window.nexoraSupabase.functions.invoke('nexora-provider-health', { body: {} });
      if (error) {
        let detail = error.message || 'A verificação falhou.';
        try { const payload = await error.context?.clone?.().json(); if (payload?.error) detail = payload.error; } catch (_) {}
        throw new Error(detail);
      }
      if (!result?.ok) throw new Error(result?.error || 'Não foi possível verificar os provedores.');
      await loadOperations();
      const count = Array.isArray(result.results) ? result.results.length : 0;
      UI.toast(count ? 'Verificação concluída para ' + count + ' adquirente(s).' : 'Nenhum adquirente habilitado para verificar.');
    } catch (error) {
      UI.toast(error.message || 'Não foi possível verificar os provedores.');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }
  function renderOperations(results = []) {
    const acquirerEl = document.querySelector('[data-admin-acquirers]');
    const failed = results[0]?.status === 'rejected';
    const healthEl = document.querySelector('[data-provider-health]');
    const badgesEl = document.querySelector('[data-provider-health-badges]');
    if (results[6]?.status === 'rejected') {
      if (healthEl) healthEl.innerHTML = '<p class="nx-muted">Saúde indisponível. Execute nexora-provider-health.sql e confirme a sessão Super Admin com MFA.</p>';
      if (badgesEl) badgesEl.innerHTML = '<span class="nx-status cancelled">Indisponível</span>';
    } else {
      const checks = results[6]?.value || [];
      if (badgesEl) {
        if (!checks.length) {
          badgesEl.innerHTML = '<span class="nx-muted">Nenhum conector em monitoramento</span>';
        } else {
          badgesEl.innerHTML = checks.map(item => {
            const cls = item.status === 'ONLINE' ? 'online' : item.status === 'DEGRADED' ? 'degraded' : 'offline';
            const label = item.status === 'ONLINE' ? 'Operacional' : item.status === 'DEGRADED' ? 'Instável' : 'Offline';
            return '<span class="provider-health-badge ' + cls + '"><i class="provider-health-badge-dot" aria-hidden="true"></i> ' + e(item.name) + ' (' + (item.environment === 'production' ? 'Produção' : 'Testes') + '): ' + label + (item.latency_ms ? ' · ' + Number(item.latency_ms) + 'ms' : '') + '</span>';
          }).join(' ');
        }
      }
      if (healthEl) {
        healthEl.innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Adquirente</th><th>Ambiente</th><th>Status</th><th>Latência</th><th>Última verificação</th><th>Detalhe seguro</th></tr></thead><tbody>' + checks.map(item => {
          const labels = {ONLINE:'Online',DEGRADED:'Degradado',OFFLINE:'Offline',UNKNOWN:'Não verificado'};
          const errorLabels = {adapter_not_implemented:'Adaptador ainda não implementado',provider_configuration_unsupported:'Configuração não homologada',credential_decryption_unavailable:'Chave de criptografia ausente',credential_not_configured:'Credencial não configurada',credential_decryption_failed:'Não foi possível abrir a credencial',network_unavailable:'Sem resposta de rede',provider_slow:'Resposta lenta',credential_rejected:'Credencial rejeitada pelo provedor',provider_rate_limited:'Limite de consultas do provedor',provider_server_error:'Erro no provedor',provider_probe_rejected:'Consulta de saúde recusada'};
          return '<tr><td><b>' + e(item.name) + '</b><small>' + e(item.code) + '</small></td><td>' + e(item.environment === 'production' ? 'Produção' : 'Sandbox') + '</td><td>' + e(labels[item.status] || 'Não verificado') + (item.http_status ? '<small>HTTP ' + Number(item.http_status) + '</small>' : '') + '</td><td>' + (Number.isFinite(Number(item.latency_ms)) ? Number(item.latency_ms) + ' ms' : '—') + '</td><td>' + e(item.checked_at ? C.date(item.checked_at) : 'Ainda não verificado') + '</td><td>' + e(errorLabels[item.error_code] || (item.error_code ? 'Verifique configuração/conector' : 'Sem erro informado')) + '</td></tr>';
        }).join('') + (checks.length ? '' : '<tr><td colspan="6">Nenhum adquirente habilitado para monitoramento.</td></tr>') + '</tbody></table></div>';
      }
    }
    acquirerEl.innerHTML = failed ? '<p class="nx-muted">Estrutura ainda não instalada. Execute o SQL administrativo antes de usar esta área.</p>' : '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Adquirente</th><th>Ambiente</th><th>Meios</th><th>Credencial central da Nexora</th><th>Disponibilidade</th><th>Ação</th></tr></thead><tbody>' + acquirers.map(a => { const adapter = providerCatalog.find(item => item.code === a.code); const credential = platformCredentials.find(item => item.acquirer_id === a.id && item.environment === a.environment && item.status === 'active'); const canConfigure = adapter?.credential_setup === 'asaas-admin' || Boolean(a.code?.startsWith('mercadopago_')); const credentialLabel = a.code?.startsWith('mercadopago_') ? 'Access Token validado' : 'Credencial validada'; return '<tr><td><b>' + e(a.name) + '</b><small>' + e(a.api_base_url) + '</small></td><td>' + e(a.environment === 'production' ? 'Produção' : 'Testes') + '</td><td>' + e((a.payment_methods || []).join(', ').toUpperCase()) + '</td><td>' + (credential ? credentialLabel + ' · versão ' + Number(credential.version) + ' · •••• ' + e(credential.key_hint) : results[5]?.status === 'rejected' ? 'Migração necessária' : 'Não configurada') + (canConfigure ? '<button class="table-action" data-provider-config="' + e(a.id) + '">' + (credential ? 'Rotacionar credencial' : 'Configurar credencial') + '</button>' : '') + '</td><td>' + e(({enabled:'Disponível para seleção',disabled:'Pausado',degraded:'Instável'}[a.status] || a.status)) + '</td><td><button class="table-action" data-acquirer-edit="' + e(a.id) + '">Editar</button><button class="table-action danger" data-acquirer-remove="' + e(a.id) + '">Remover</button></td></tr>'; }).join('') + (acquirers.length ? '' : '<tr><td colspan="6">Nenhum adquirente cadastrado. Adicione um provedor antes de atribuí-lo a uma conta.</td></tr>') + '</tbody></table></div>';
    if (!failed) acquirerEl.insertAdjacentHTML('afterbegin', '<p class="nx-muted">“Habilitado no catálogo” só permite selecionar a rota. Não comprova aprovação contratual, credencial aceita, webhook validado nem homologação para operar em produção.</p>');
    const connFilter = document.querySelector('[data-admin-connection-search]')?.value?.trim()?.toLowerCase() || '';
    const filteredConnections = connFilter ? connections.filter(c =>
      String(c.business_name || '').toLowerCase().includes(connFilter) ||
      String(c.email || '').toLowerCase().includes(connFilter) ||
      String(c.acquirer_name || '').toLowerCase().includes(connFilter)
    ) : connections;
    const connFeedback = document.querySelector('[data-admin-connection-feedback]');
    if (connFeedback) {
      connFeedback.textContent = filteredConnections.length + (filteredConnections.length === 1 ? ' conexão encontrada.' : ' conexões encontradas.');
    }
    document.querySelector('[data-admin-provider-connections]').innerHTML = results[1]?.status === 'rejected' ? '<p class="nx-muted">Não foi possível carregar conexões.</p>' : '<div class="nx-table-wrap"><table class="nx-table" aria-label="Rotas de adquirentes atribuídas aos lojistas"><thead><tr><th scope="col">Merchant</th><th scope="col">Adquirente</th><th scope="col">Credencial compartilhada</th><th scope="col">Ambiente</th><th scope="col">Status / ações</th></tr></thead><tbody>' + filteredConnections.map(c => { const adapter = providerCatalog.find(item => item.code === c.acquirer_code); const credential = platformCredentials.find(item => item.acquirer_id === c.acquirer_id && item.environment === c.environment && item.status === 'active'); const routeKey = c.business_id + '|' + c.acquirer_id; const nextStatus = c.status === 'disabled' ? 'pending' : 'disabled'; const implementationNote = adapter ? '<small>Adaptador implementado no código</small>' : '<small>Adaptador não implementado</small>'; const operationNote = adapter?.operational_status === 'not_homologated' ? '<small>Homologação de produção não comprovada</small>' : ''; return '<tr><td><b>' + e(c.business_name) + '</b><small>' + e(c.email) + '</small></td><td>' + e(c.acquirer_name) + '</td><td>' + (credential ? 'Nexora · versão ' + Number(credential.version) : 'Não configurada') + '</td><td>' + e(c.environment === 'sandbox' ? 'Sandbox' : 'Produção') + '</td><td>' + e(({pending:'Pendente',active:'Ativa',disabled:'Desativada',error:'Erro'}[c.status] || c.status)) + implementationNote + operationNote + '<div class="admin-account-actions"><button class="table-action highlight" data-connection-manage="' + e(c.owner_id) + '" aria-label="Alterar adquirente de ' + e(c.business_name) + '">Alterar adquirente</button>' + (c.status === 'pending' && credential ? '<button class="table-action" data-provider-activate="' + e(routeKey) + '" aria-label="Ativar rota de ' + e(c.business_name) + '">Ativar rota</button>' : '') + '<button class="table-action" data-provider-status="' + e(routeKey) + '" data-next-status="' + nextStatus + '" aria-label="' + (c.status === 'disabled' ? 'Reabrir' : 'Desativar') + ' rota de ' + e(c.business_name) + '">' + (c.status === 'disabled' ? 'Reabrir rota' : 'Desativar rota') + '</button></div></td></tr>'; }).join('') + (filteredConnections.length ? '' : '<tr><td colspan="5">Nenhuma rota de adquirente encontrada' + (connFilter ? ' no filtro' : '') + '.</td></tr>') + '</tbody></table></div>';
    document.querySelector('[data-admin-alerts]').innerHTML = results[3]?.status === 'rejected' ? '<p class="nx-muted">Não foi possível carregar alertas.</p>' : '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Data</th><th>Merchant</th><th>Alerta</th><th>Detalhes</th><th>Status</th></tr></thead><tbody>' + alerts.map(n => '<tr><td>' + e(C.date(n.created_at)) + '</td><td><b>' + e(n.business_name) + '</b><small>' + e(n.email) + '</small></td><td>' + e(n.title) + '<small>' + e(n.message) + '</small></td><td>Solicitado ' + C.money(n.details?.requested_amount || 0) + ' · limite diário ' + C.money(n.details?.daily_limit || 0) + '</td><td>' + (n.read_at ? 'Lido' : '<button class="table-action" data-alert-read="' + e(n.id) + '">Marcar como lido</button>') + '</td></tr>').join('') + (alerts.length ? '' : '<tr><td colspan="5">Nenhum alerta gerado.</td></tr>') + '</tbody></table></div>';
    labelRepeatedActions();
    renderOverview();
    renderActiveCautions();
  }
  function editAcquirer(item = {}) {
    const methods = ['pix','card','boleto'];
    const implementedMethods = new Set((providerCatalog.find(adapter => adapter.code === item.code)?.methods || [])
      .map(method => ['credit_card','debit_card','apple_pay'].includes(method) ? 'card' : method));
    const body = '<div class="nx-site-grid">' + field('Nome do adquirente','name',item.name || '') + field('URL base da API (HTTPS)','api_base_url',item.api_base_url || '','url') + field('Webhook do provedor (HTTPS, se houver)','webhook_url',item.webhook_url || '','url') + '</div>' +
      '<div class="nx-site-grid"><label class="nx-field">Ambiente<select name="environment"><option value="sandbox" ' + (item.environment !== 'production' ? 'selected' : '') + '>Testes (sandbox)</option><option value="production" ' + (item.environment === 'production' ? 'selected' : '') + '>Produção</option></select></label><label class="nx-field">Disponibilidade para clientes<select name="status"><option value="disabled" ' + (item.status === 'disabled' || !item.status ? 'selected' : '') + '>Pausado — não pode ser selecionado</option><option value="enabled" ' + (item.status === 'enabled' ? 'selected' : '') + '>Disponível para seleção</option><option value="degraded" ' + (item.status === 'degraded' ? 'selected' : '') + '>Instável — evitar novas seleções</option></select></label></div><p class="nx-muted">Identificador interno é gerado automaticamente. Você pode cadastrar um adquirente pausado enquanto o adapter é preparado; isso não habilita cobranças.</p><fieldset class="nx-methods"><legend>Meios declarados</legend>' + methods.map(m => { const implemented = implementedMethods.has(m); return '<label><input type="checkbox" name="methods" value="' + m + '" ' + ((item.payment_methods || ['pix']).includes(m) ? 'checked' : '') + '> ' + ({pix:'Pix',card:'Cartão',boleto:'Boleto'}[m]) + (implemented ? ' <small>Adapter implementado</small>' : ' <small>Em preparação · só pode ficar pausado</small>') + '</label>'; }).join('') + '</fieldset><label class="nx-field">Observações<textarea name="notes" rows="3" maxlength="1000">' + e(item.notes || '') + '</textarea></label>';
    UI.modal(item.id ? 'Editar adquirente' : 'Cadastrar adquirente', body, async dialog => {
      const name = dialog.querySelector('[name=name]').value.trim();
      const chosenMethods = [...dialog.querySelectorAll('[name=methods]:checked')].map(x => x.value);
      const chosenStatus = dialog.querySelector('[name=status]').value;
      if (!chosenMethods.length) throw new Error('Selecione ao menos um meio declarado para cadastrar o adquirente.');
      if (chosenStatus !== 'disabled' && chosenMethods.some(method => !implementedMethods.has(method))) throw new Error('Meios sem adaptador só podem ser cadastrados com o adquirente pausado.');
      const generatedCode = item.code || ('nx-' + name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,36) + '-' + crypto.randomUUID().slice(0,6));
      await API.rpc('nexora_admin_save_acquirer',{p_id:item.id || null,p_code:generatedCode,p_name:name,p_api_base_url:dialog.querySelector('[name=api_base_url]').value.trim(),p_webhook_url:dialog.querySelector('[name=webhook_url]').value.trim() || null,p_environment:dialog.querySelector('[name=environment]').value,p_payment_methods:chosenMethods,p_status:chosenStatus,p_notes:dialog.querySelector('[name=notes]').value.trim()});
      await loadOperations(); UI.toast('Adquirente salvo no Supabase.');
    },{submitLabel:'Salvar adquirente'});
  }
  function removeAcquirerHandler(item) {
    UI.modal('Remover adquirente permanentemente?', '<p><b>' + e(item.name) + ' (' + e(item.environment === 'production' ? 'Produção' : 'Sandbox') + ')</b></p><p>Esta ação remove o adquirente do catálogo. Se já houver transações ou cobranças vinculadas no ledger, a exclusão será bloqueada para preservar o histórico financeiro.</p>', async () => {
      try {
        await API.rpc('nexora_admin_delete_acquirer', { p_id: item.id });
        await loadOperations();
        UI.toast('Adquirente removido com sucesso.');
      } catch (err) {
        throw new Error(API.errorMessage(err) || 'Não foi possível remover o adquirente.');
      }
    }, { submitLabel: 'Excluir adquirente' });
  }
  function configureAcquirer(item) {
    const connection = connections.find(row => row.owner_id === item.user_id);
    const workspace = (item.workspaces || [])[0] || null;
    const choices = acquirers.filter(acquirer => acquirer.status === 'enabled' || acquirer.id === connection?.acquirer_id);
    const supported = acquirer => providerCatalog.some(adapter => adapter.code === acquirer.code && adapter.implementation_status === 'implemented');
    const eligible = choices.filter(supported);
    const selectedId = eligible.some(acquirer => acquirer.id === connection?.acquirer_id) ? connection.acquirer_id : (eligible[0]?.id || '');
    
    const currentAcquirer = acquirers.find(a => a.id === connection?.acquirer_id);
    const statusLabel = connection ? ({
      active: 'Ativa (Processando pagamentos)',
      pending: 'Pendente (Aguardando ativação)',
      disabled: 'Desativada',
      error: 'Erro'
    }[connection.status] || connection.status) : 'Nenhum adquirente vinculado';

    const acquirerCards = '<fieldset class="nx-acquirer-choices"><legend>Selecione o provedor de pagamentos</legend>' +
      '<label class="nx-acquirer-choice"><input type="radio" name="acquirer" value="" ' + (!connection || !connection.acquirer_id ? 'checked' : '') + '><span><b>Sem adquirente (Desvincular)</b><small>A empresa não poderá gerar cobranças Pix ou Cartão.</small></span></label>' +
      eligible.map(acquirer => {
        const isSelected = acquirer.id === (connection?.acquirer_id || selectedId);
        const hasCred = platformCredentials.some(k => k.acquirer_id === acquirer.id && k.status === 'active');
        const envLabel = acquirer.environment === 'production' ? 'Produção' : 'Ambiente de testes';
        const methodsLabel = (acquirer.payment_methods || []).map(m => m === 'pix' ? 'Pix' : (m === 'credit_card' || m === 'card' ? 'Cartão de Crédito' : m)).join(', ');
        return '<label class="nx-acquirer-choice"><input type="radio" name="acquirer" value="' + e(acquirer.id) + '" ' + (isSelected ? 'checked' : '') + '><span><b>' + e(acquirer.name) + ' (' + envLabel + ')</b><small>Métodos: ' + e(methodsLabel || 'Pix') + ' · Credencial central: ' + (hasCred ? 'Configurada na Nexora' : 'Pendente de chave') + ' · adaptador implementado; homologação verificada separadamente</small></span></label>';
      }).join('') +
      choices.filter(acquirer => !supported(acquirer)).map(acquirer => '<div class="nx-acquirer-choice is-disabled" aria-disabled="true"><span><b>' + e(acquirer.name) + '</b><small>Adaptador ainda não implementado no conector.</small></span><span class="nx-acquirer-badge">Em preparação</span></div>').join('') +
      '</fieldset>';

    const body = '<div class="admin-modal-lead">' +
      '<p><b>' + e(item.full_name) + '</b> <small class="nx-muted">(' + e(item.email) + ')</small></p>' +
      '<div class="admin-status-box" style="margin:10px 0 16px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);"><small style="display:block;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.08em;margin-bottom:4px;">STATUS DA CONEXÃO ATUAL</small><strong style="font-size:14px;color:var(--text);">' + e(currentAcquirer ? currentAcquirer.name + ' · ' + statusLabel : 'Sem adquirente vinculado') + '</strong></div>' +
      '</div>' +
      acquirerCards +
      '<label class="nx-check" style="margin-top:14px;"><input type="checkbox" name="auto_activate" checked> <b>Ativar rota imediatamente</b></label><p class="nx-muted" style="margin-top:4px;font-size:11px;">Habilita a rota para cobranças ativas caso a credencial central da Nexora esteja configurada.</p>' +
      '<p class="nx-muted" style="margin-top:12px;font-size:12px;line-height:1.4;">A alteração de adquirente redireciona as novas cobranças deste cliente. Credenciais operacionais são mantidas sob criptografia segura na Nexora.</p>';

    UI.modal('Adquirente da Empresa', body, async dialog => {
      const selected = dialog.querySelector('[name=acquirer]:checked');
      const requestedAcquirerId = selected ? (selected.value || null) : null;
      const shouldActivate = dialog.querySelector('[name=auto_activate]')?.checked;

      try {
        await API.rpc('nexora_admin_assign_acquirer', {
          p_owner_id: item.user_id,
          p_acquirer_id: requestedAcquirerId
        });

        if (requestedAcquirerId && shouldActivate) {
          const targetBusinessId = workspace?.id || connection?.business_id;
          if (targetBusinessId) {
            try {
              await API.rpc('nexora_admin_activate_provider_route', {
                p_business_id: targetBusinessId,
                p_acquirer_id: requestedAcquirerId
              });
            } catch (actErr) {
              console.warn('Rota atribuída, mas ativação pendente:', actErr);
            }
          }
        }

        await load();
        UI.toast(requestedAcquirerId ? 'Adquirente da empresa configurado e salvo com sucesso!' : 'Adquirente desvinculado com sucesso.');
      } catch (err) {
        throw new Error(API.errorMessage(err) || 'Não foi possível salvar o adquirente da empresa.');
      }
    }, { submitLabel: 'Salvar Adquirente' });
  }
  function manageAccount(item) {
    const current = merchantControls.find(control => control.owner_id === item.user_id) || {};
    const connection = connections.find(row => row.owner_id === item.user_id);
    const acq = connection ? acquirers.find(a => a.id === connection.acquirer_id) : null;
    const acqText = acq ? (acq.name + ' (' + (acq.environment === 'production' ? 'Produção' : 'Testes') + ')') : 'Nenhum adquirente vinculado';

    const body = '<div class="admin-modal-lead">' +
      '<p><b>' + e(item.full_name) + '</b> <small class="nx-muted">(' + e(item.email) + ')</small></p>' +
      '<div style="margin:10px 0 16px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);"><small style="display:block;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.08em;margin-bottom:4px;">ADQUIRENTE ATUAL</small><strong style="font-size:13px;color:var(--text);">' + e(acqText) + '</strong><small style="display:block;color:var(--muted);font-size:11px;margin-top:2px;">Para alterar ou vincular adquirente, clique no botão <b>Adquirente</b> na tabela.</small></div>' +
      '</div>' +
      '<label class="nx-check"><input type="checkbox" name="payments" ' + (current.payments_enabled === false ? '' : 'checked') + '> Permitir recebimentos</label>' +
      '<label class="nx-check"><input type="checkbox" name="withdrawals" ' + (current.withdrawals_enabled === false ? '' : 'checked') + '> Permitir saques</label>' +
      '<label class="nx-check"><input type="checkbox" name="pix_out" ' + (current.pix_out_enabled === true ? 'checked' : '') + '> Permitir Pix OUT pelo provedor</label>' +
      '<label class="nx-check"><input type="checkbox" name="outgoing_frozen" ' + (current.balance_movements_blocked === true ? 'checked' : '') + '> Bloquear novas movimentações de saída</label><p class="nx-muted">Esse bloqueio impede novos saques e despachos. Ele não altera nem reclassifica valores existentes no ledger.</p>' +
      '<label class="nx-check"><input type="checkbox" name="api" ' + (current.api_enabled === true ? 'checked' : '') + '> Permitir acesso à API pública</label><p class="nx-muted">Desativar a API impede autenticação de chaves de produção; sandbox continua separado.</p>' +
      '<label class="nx-field">Aprovação de saques<select name="mode"><option value="manual" ' + (current.withdrawal_mode !== 'instant' ? 'selected' : '') + '>Aprovação manual</option><option value="instant" ' + (current.withdrawal_mode === 'instant' ? 'selected' : '') + '>Preferência instantânea (ainda sem envio real)</option></select></label>' +
      '<div class="nx-site-grid">' + field('Máximo por transferência (R$)','max_transfer',current.max_transfer_amount || 5000,'number') + field('Limite diário (R$)','daily_limit',current.daily_transfer_limit || 20000,'number') + field('Alertar admin a partir de (R$)','alert_threshold',current.alert_threshold_amount || 5000,'number') + '<label class="nx-field">Reserva sobre o líquido (%)<input name="reserve" type="number" min="0" max="100" step="0.01" value="' + e(current.reserve_percentage || 0) + '"></label><label class="nx-field">Prazo da reserva (dias)<input name="reserve_days" type="number" min="0" max="365" step="1" value="' + e(current.reserve_days || 0) + '"></label></div>' +
      '<p class="nx-muted">A reserva é descontada do saldo disponível e registrada em conta separada no ledger. Use 0% e 0 dias para desativar; percentual positivo exige prazo de 1 a 365 dias.</p>';

    UI.modal('Gerenciar Controles Operacionais', body, async dialog => {
      const amount = name => Number(dialog.querySelector('[name="' + name + '"]').value);
      const reservePercentage = amount('reserve'), reserveDays = amount('reserve_days');
      if ((reservePercentage === 0 && reserveDays !== 0) || (reservePercentage > 0 && (reserveDays < 1 || reserveDays > 365 || !Number.isInteger(reserveDays)))) throw new Error('Use 0% e 0 dias para desativar a reserva, ou informe prazo de 1 a 365 dias.');
      const selectedControl = dialog.querySelector('[name=acquirer]:checked');
      const requestedAcquirerId = selectedControl ? selectedControl.value || null : null;
      const updateAcquirer = Boolean(selectedControl) && requestedAcquirerId !== (connection?.acquirer_id || null);
      const configurePayload = {p_owner_id:item.user_id,p_update_acquirer:updateAcquirer,p_acquirer_id:updateAcquirer ? requestedAcquirerId : null,p_payments_enabled:dialog.querySelector('[name=payments]').checked,p_withdrawals_enabled:dialog.querySelector('[name=withdrawals]').checked,p_api_enabled:dialog.querySelector('[name=api]').checked,p_pix_out_enabled:dialog.querySelector('[name=pix_out]').checked,p_balance_movements_blocked:dialog.querySelector('[name=outgoing_frozen]').checked,p_withdrawal_mode:dialog.querySelector('[name=mode]').value,p_max_transfer_amount:amount('max_transfer'),p_daily_transfer_limit:amount('daily_limit'),p_alert_threshold_amount:amount('alert_threshold'),p_reserve_percentage:reservePercentage,p_reserve_days:reserveDays};
      try {
        await API.rpc('nexora_admin_configure_merchant',configurePayload);
      } catch (error) {
        throw new Error('Não foi possível salvar os controles operacionais. ' + (API.errorMessage(error) || ''));
      }
      await load();
      UI.toast('Controles operacionais atualizados com sucesso.');
    }, { submitLabel: 'Salvar alterações' });
  }
  function configurePixPricing(item) {
    const workspaces = Array.isArray(item.workspaces) ? item.workspaces : [];
    if (!workspaces.length) { UI.toast('Esta conta ainda não tem um workspace para configurar.'); return; }
    const eligibleRoutes = connections.filter(connection => connection.owner_id === item.user_id
      && ['pending','active'].includes(connection.status)
      && workspaces.some(workspace => workspace.id === connection.business_id)
      && acquirers.some(acquirer => acquirer.id === connection.acquirer_id && acquirer.status === 'enabled' && (acquirer.payment_methods || []).includes('pix')
        && providerCatalog.some(adapter => adapter.code === acquirer.code && adapter.implementation_status === 'implemented' && adapter.methods.includes('pix'))));
    if (!eligibleRoutes.length) { UI.toast('Atribua primeiro um adquirente com conector Pix disponível a este lojista.'); return; }
    const routeOptions = eligibleRoutes.map(connection => {
      const acquirer = acquirers.find(row => row.id === connection.acquirer_id);
      const workspace = workspaces.find(row => row.id === connection.business_id);
      return '<option value="' + e(connection.business_id + '|' + connection.acquirer_id) + '">' + e(workspace?.name || connection.business_name) + ' · ' + e(acquirer?.name || connection.acquirer_name) + ' · ' + (acquirer?.environment === 'production' ? 'Produção' : 'Testes') + '</option>';
    }).join('');
    const startsAt = new Date(Date.now() + 120000);
    startsAt.setSeconds(0,0);
    const localStart = new Date(startsAt.getTime() - startsAt.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    const body = '<p><b>' + e(item.full_name) + ' · ' + e(item.email) + '</b></p>' +
      '<label class="nx-field">Workspace e adquirente Pix<select name="route" required>' + routeOptions + '</select></label>' +
      '<div class="nx-site-grid"><label class="nx-field">Tarifa fixa por cobrança (R$)<input name="fixed_fee" type="number" inputmode="decimal" min="0" max="1000000" step="0.01" value="0.99" required></label><label class="nx-field">Percentual<input type="text" value="0%" readonly aria-readonly="true"></label></div>' +
      '<label class="nx-field">Início da vigência<input name="effective_from" type="datetime-local" value="' + e(localStart) + '" required></label>' +
      '<label class="nx-field">Motivo da alteração<input name="reason" maxlength="240" minlength="10" value="Tarifa comercial Pix aprovada pela Nexora" required></label>' +
      '<p class="nx-muted" role="status">A tarifa vira um registro imutável e será usada apenas em cobranças criadas a partir da vigência. O painel não mostra nem altera vendas anteriores. Confirme antes de salvar que a migração de pricing foi aplicada.</p>' +
      '<section aria-labelledby="pricing-history-title"><h3 id="pricing-history-title">Histórico desta tarifa</h3><div data-pricing-history role="status" aria-live="polite">Carregando regras…</div></section>';
    const dialogRef = UI.modal('Configurar tarifa Pix', body, async dialog => {
      const [businessId, acquirerId] = dialog.querySelector('[name=route]').value.split('|');
      if (!/^[0-9a-f-]{36}$/i.test(businessId || '') || !/^[0-9a-f-]{36}$/i.test(acquirerId || '')) {
        throw new Error('Selecione um workspace e adquirente Pix atribuídos.');
      }
      const fixedFee = Number(dialog.querySelector('[name=fixed_fee]').value);
      const effectiveFrom = new Date(dialog.querySelector('[name=effective_from]').value);
      const reason = dialog.querySelector('[name=reason]').value.trim();
      if (!Number.isFinite(fixedFee) || fixedFee < 0 || fixedFee > 1000000 || Math.round(fixedFee * 100) !== fixedFee * 100) {
        throw new Error('Informe uma tarifa fixa válida em centavos.');
      }
      if (!Number.isFinite(effectiveFrom.getTime()) || effectiveFrom.getTime() < Date.now() + 30000) {
        throw new Error('Escolha uma vigência com pelo menos 30 segundos de antecedência.');
      }
      if (reason.length < 10 || reason.length > 240) throw new Error('Descreva o motivo com 10 a 240 caracteres.');
      await API.rpc('nexora_admin_add_pricing_rule', {
        p_business_id: businessId, p_acquirer_id: acquirerId, p_payment_method: 'pix',
        p_fixed_fee_cents: Math.round(fixedFee * 100), p_variable_fee_bps: 0,
        p_effective_from: effectiveFrom.toISOString(), p_reason: reason,
      });
      UI.toast('Regra Pix registrada no histórico.');
    }, { submitLabel: 'Salvar tarifa Pix' });
    const history = dialogRef?.querySelector('[data-pricing-history]');
    if (history) {
      const renderHistory = async businessId => {
        history.textContent = 'Carregando regras…';
        try {
          const rules = await API.rpc('nexora_admin_pricing_rules', { p_business_id: businessId });
          const rows = (Array.isArray(rules) ? rules : []).filter(rule => rule.payment_method === 'pix');
          history.innerHTML = rows.length
            ? '<ul>' + rows.map(rule => '<li><b>' + e(rule.acquirer_name) + '</b> · ' + e(C.money(Number(rule.fixed_fee_cents || 0) / 100)) + ' fixos' + (Number(rule.variable_fee_bps || 0) ? ' + ' + (Number(rule.variable_fee_bps) / 100).toLocaleString('pt-BR') + '%' : '') + ' · vigência ' + e(C.date(rule.effective_from)) + '<br><small>' + e(rule.reason) + '</small></li>').join('') + '</ul>'
            : 'Nenhuma regra Pix cadastrada para este workspace.';
        } catch (_) {
          history.textContent = 'Histórico disponível após aplicar nexora-pricing-engine.sql no Supabase.';
        }
      };
      renderHistory(dialogRef.querySelector('[name=route]').value.split('|')[0]);
      dialogRef.querySelector('[name=route]')?.addEventListener('change', event => renderHistory(event.target.value.split('|')[0]));
    }
  }
  function configureProviderCredential(acquirerId) {
    const acquirer = acquirers.find(row => row.id === acquirerId);
    const isAsaas = ['asaas_sandbox','asaas_production'].includes(acquirer?.code);
    const isMercadoPago = Boolean(acquirer?.code?.startsWith('mercadopago_'));
    if (!acquirer || (!isAsaas && !isMercadoPago)
      || !['sandbox','production'].includes(acquirer.environment)) {
      UI.toast('Este adquirente ainda não tem configuração segura de credencial.'); return;
    }
    const production = acquirer.environment === 'production';
    const environmentLabel = production ? 'produção' : 'testes';
    const prefix = isAsaas ? (production ? '$aact_prod_' : '$aact_hmlg_') : 'Access Token · ' + environmentLabel;
    const current = platformCredentials.find(row => row.acquirer_id === acquirer.id && row.environment === acquirer.environment && row.status === 'active');
    const providerName = isAsaas ? 'Asaas' : 'Mercado Pago';
    const body = '<p><b>' + e(acquirer.name) + '</b></p>' +
      '<p class="nx-banner"><b>Credencial da Nexora · ' + environmentLabel + '</b><span>' + (production
        ? 'Use a credencial de produção da conta ' + providerName + ' da Nexora. Ela fica somente no servidor; rotas ainda não homologadas continuam bloqueadas.'
        : 'Use a credencial de testes do ' + providerName + '. A Nexora confia no ambiente selecionado nesta entrada; confira a credencial antes de salvar. Cobranças e rotas permanecem desativadas até homologação.') + '</span></p>' +
      '<label class="nx-field">' + (isAsaas ? 'Chave de API do Asaas' : 'Access Token do Mercado Pago') + '<input name="api_key" type="password" autocomplete="new-password" maxlength="4000" required placeholder="' + e(prefix) + '…"></label>' +
      (current ? '<p class="nx-muted">Chave ativa: versão ' + Number(current.version) + ' · final ' + e(current.key_hint) + '. Salvar substituirá a versão ativa e guardará o histórico de rotação.</p>' : '') +
      '<p class="nx-muted">A credencial será validada no ' + providerName + ', criptografada no banco e não será exibida novamente. Registrar a chave não habilita o conector nem ativa rotas de lojista.</p>';
    UI.modal(current ? 'Rotacionar credencial da Nexora' : 'Configurar credencial central', body, async dialog => {
      const secretInput = dialog.querySelector('[name=api_key]');
      const apiKey = secretInput.value.trim();
      let result;
      try {
        const response = await window.nexoraSupabase.functions.invoke('nexora-provider-config', {
          body: { api_key: apiKey, acquirer_id: acquirer.id, environment: acquirer.environment },
        });
        result = response.data;
        if (response.error) {
          let detail = '';
          let requestId = '';
          try {
            const payload = await response.error.context?.clone?.().json();
            detail = payload?.error || '';
            requestId = payload?.request_id || '';
          } catch (_) {}
          throw new Error((detail || API.errorMessage(response.error)) + (requestId ? ' Referência: ' + requestId : ''));
        }
        if (result?.error) throw new Error(result.error);
      } finally { secretInput.value = ''; }
      await loadOperations();
      UI.toast('Credencial central da Nexora validada e registrada. Rotas de lojistas continuam em aprovação.');
    }, { submitLabel: 'Validar e salvar credencial' });
  }
  const kycLabels = {DRAFT:'Rascunho',SUBMITTED:'Enviado',PENDING_DOCUMENTS:'Aguardando documentos',UNDER_REVIEW:'Em análise',MANUAL_REVIEW:'Análise manual',APPROVED:'Aprovado',REJECTED:'Recusado',SUSPENDED:'Suspenso',BLOCKED:'Bloqueado',CLOSED:'Encerrado'};
  const kycDocumentLabels = {cnpj_proof:'Comprovante de CNPJ',company_articles:'Contrato social',representative_id_front:'Documento do representante · frente',representative_id_back:'Documento do representante · verso',company_address_proof:'Comprovante de endereço',bank_proof:'Comprovante bancário',additional_document:'Foto do representante com o documento',power_of_attorney:'Procuração',activity_license:'Licença da atividade',financial_document:'Documento financeiro',owner_id_front:'Documento de sócio · frente',owner_id_back:'Documento de sócio · verso',owner_address_proof:'Comprovante de endereço do sócio'};
  function renderKycTable() {
    const container = document.querySelector('[data-admin-kyc]');
    if (!container) return;

    const totalCount = kycCases.length;
    const pendingCount = kycCases.filter(item => ['SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW','PENDING_DOCUMENTS'].includes(item.status)).length;
    const approvedCount = kycCases.filter(item => item.status === 'APPROVED').length;
    const rejectedCount = kycCases.filter(item => ['REJECTED','SUSPENDED','BLOCKED'].includes(item.status)).length;

    const cntAll = document.querySelector('[data-kyc-cnt-all]');
    const cntPending = document.querySelector('[data-kyc-cnt-pending]');
    const cntApproved = document.querySelector('[data-kyc-cnt-approved]');
    const cntRejected = document.querySelector('[data-kyc-cnt-rejected]');
    if (cntAll) cntAll.textContent = totalCount;
    if (cntPending) cntPending.textContent = pendingCount;
    if (cntApproved) cntApproved.textContent = approvedCount;
    if (cntRejected) cntRejected.textContent = rejectedCount;

    document.querySelectorAll('[data-kyc-tab]').forEach(tabBtn => {
      const isTarget = tabBtn.dataset.kycTab === kycFilter;
      tabBtn.classList.toggle('outline', !isTarget);
    });

    let filtered = kycCases.slice();
    if (kycFilter === 'pending') {
      filtered = filtered.filter(item => ['SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW','PENDING_DOCUMENTS'].includes(item.status));
    } else if (kycFilter === 'approved') {
      filtered = filtered.filter(item => item.status === 'APPROVED');
    } else if (kycFilter === 'rejected') {
      filtered = filtered.filter(item => ['REJECTED','SUSPENDED','BLOCKED'].includes(item.status));
    }

    if (kycSearch.trim()) {
      const q = kycSearch.trim().toLowerCase();
      filtered = filtered.filter(item => {
        const name = (item.data?.company?.legal_name || item.full_name || '').toLowerCase();
        const trade = (item.data?.company?.trade_name || '').toLowerCase();
        const email = (item.email || '').toLowerCase();
        const doc = String(item.data?.company?.document_number || '').replace(/\D/g, '');
        return name.includes(q) || trade.includes(q) || email.includes(q) || doc.includes(q.replace(/\D/g, ''));
      });
    }

    if (!filtered.length) {
      container.innerHTML = '<div class="nx-empty" style="padding:28px 16px;text-align:center;">Nenhum cadastro encontrado' + (kycFilter !== 'all' ? ' para este filtro.' : '.') + '</div>';
      return;
    }

    container.innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr>' +
      '<th>Cliente / Empresa</th><th>Documento</th><th>Data de Envio</th><th>Status</th><th>Ação</th>' +
      '</tr></thead><tbody>' + filtered.map(item => {
        const isApproved = item.status === 'APPROVED';
        const isPending = ['SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW','PENDING_DOCUMENTS'].includes(item.status);
        const docType = (item.data?.company?.document_type || (item.data?.company?.account_type === 'individual' ? 'CPF' : 'CNPJ')).toUpperCase();
        const docNum = item.data?.company?.document_number || 'Não informado';
        const dateStr = C.date(item.submitted_at || item.created_at);
        const statusBadge = '<span class="nx-status ' + (isApproved ? 'paid' : isPending ? 'pending' : 'cancelled') + '">' + e(kycLabels[item.status] || item.status) + '</span>';
        const actionBtn = isPending
          ? '<button type="button" class="table-action" data-kyc-review="' + e(item.user_id) + '">Analisar cadastro</button>'
          : '<button type="button" class="table-action" data-kyc-view="' + e(item.user_id) + '" style="font-weight:600;">Ver dados cadastrais</button>';

        return '<tr>' +
          '<td><b>' + e(item.data?.company?.legal_name || item.full_name || 'Cliente') + '</b>' +
            '<small>' + e(item.email || '') + '</small>' +
            (item.data?.company?.trade_name ? '<small class="nx-muted">Fantasia: ' + e(item.data.company.trade_name) + '</small>' : '') +
          '</td>' +
          '<td><small><b>' + e(docType) + '</b> ' + e(docNum) + '</small></td>' +
          '<td>' + e(dateStr) + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + actionBtn + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';

    labelRepeatedActions(container);
  }

  async function loadKyc() {
    const container = document.querySelector('[data-admin-kyc]');
    if (!container) return;
    container.setAttribute('aria-busy', 'true');
    try {
      const result = await API.rpc('nexora_admin_kyc_list');
      kycCases = Array.isArray(result) ? result : [];
      renderKycTable();
      renderOverview();
    } catch (error) {
      container.textContent = 'A fila cadastral ainda não está disponível. ' + API.errorMessage(error);
    } finally {
      container.setAttribute('aria-busy', 'false');
    }
  }

  async function reviewKyc(userId, isViewOnly = false) {
    const item = kycCases.find(row => row.user_id === userId); if (!item) return;
    const isApproved = item.status === 'APPROVED';
    const company = item.data?.company || {}, rep = item.data?.representative || {}, addr = item.data?.address || {};
    const owners = Array.isArray(item.data?.owners) ? item.data.owners : [];

    const street = [addr.street, addr.number, addr.complement, addr.neighborhood, addr.city, addr.state, addr.postal_code].filter(Boolean).join(', ')
      || [company.address_street, company.address_extra, company.address_neighborhood, company.address_city, company.address_state, company.postal_code, company.address_country].filter(Boolean).join(', ');

    const fields = [
      ['Status cadastral', kycLabels[item.status] || item.status],
      ['Tipo de cadastro', company.account_type === 'individual' ? 'Pessoa física (CPF)' : 'Pessoa jurídica (CNPJ)'],
      ['Razão social / Nome', company.legal_name || item.full_name],
      ['Nome fantasia', company.trade_name],
      [(company.document_type || (company.account_type === 'individual' ? 'CPF' : 'CNPJ')).toUpperCase(), company.document_number],
      ['E-mail cadastral', company.email || item.email],
      ['Telefone / WhatsApp', company.phone],
      ['Endereço completo', street],
      ['Natureza jurídica', company.legal_form],
      ['Abertura', company.opened_at],
      ['CNAE principal', company.primary_cnae],
      ['Site', company.website],
      ['Atividade / produtos', company.activity_description],
      ['Faturamento mensal estimado', company.monthly_revenue_estimate],
      ['TPV mensal esperado', company.expected_tpv_monthly],
      ['Ticket médio', company.average_ticket],
      ['Conta de liquidação', [item.data?.settlement?.bank_name, item.data?.settlement?.branch, item.data?.settlement?.account_number, item.data?.settlement?.account_type].filter(Boolean).join(' · ')],
      ['Chave Pix de liquidação', item.data?.settlement?.pix_key],
      ['Titular da conta', item.data?.settlement?.holder_document],
      ['Representante', rep.full_name],
      ['CPF representante', rep.cpf],
      ['Nascimento representante', rep.birth_date],
      ['Nacionalidade representante', rep.nationality]
    ].filter(([,value]) => value != null && value !== '');

    const details = fields.map(([label,value]) => '<div><dt>' + e(label) + '</dt><dd>' + e(String(value)) + '</dd></div>').join('');
    const ownersDetails = owners.length ? owners.map((owner,index) => '<section class="kyc-review-section"><h3>Pessoa relacionada ' + (index + 1) + '</h3><dl class="nx-details kyc-review-details">' + [
      ['Nome',owner.full_name],['CPF',owner.cpf],['Nascimento',owner.birth_date],['Nacionalidade',owner.nationality],['Telefone',owner.phone],['E-mail',owner.email],['Cargo / vínculo',owner.role],['Participação',owner.equity_percentage ? owner.equity_percentage + '%' : ''],['Endereço',owner.address]
    ].filter(([,v]) => v != null && v !== '').map(([label,value]) => '<div><dt>' + e(label) + '</dt><dd>' + e(String(value ?? '')) + '</dd></div>').join('') + '</dl></section>').join('') : '';

    const documents = await Promise.all((item.documents || []).map(async doc => {
      try {
        const {data:link,error} = await window.nexoraSupabase.storage.from('nexora-kyc').createSignedUrl(doc.storage_path,300);
        if (error) throw error;
        const label = (kycDocumentLabels[doc.document_type] || doc.document_type) + ' · ' + (doc.subject_key || 'empresa');
        const preview = doc.content_type?.startsWith('image/')
          ? '<img src="' + e(link.signedUrl) + '" alt="' + e(label) + ' enviado por ' + e(item.full_name || item.email || 'cliente') + '" loading="lazy">'
          : '<span class="kyc-file-type">PDF</span>';
        return '<article class="kyc-file-card"><a class="kyc-file-preview" href="' + e(link.signedUrl) + '" target="_blank" rel="noopener noreferrer" aria-label="Abrir ' + e(label) + '">' + preview + '</a><div class="kyc-file-meta"><strong>' + e(label) + '</strong><small title="' + e(doc.file_name) + '">' + e(doc.file_name) + '</small><a href="' + e(link.signedUrl) + '" target="_blank" rel="noopener noreferrer">Ampliar arquivo <span aria-hidden="true">↗</span></a></div></article>';
      } catch (_) { return '<article class="kyc-file-card kyc-file-error"><div class="kyc-file-preview"><span class="kyc-file-type">—</span></div><div class="kyc-file-meta"><strong>' + e(kycDocumentLabels[doc.document_type] || doc.document_type) + '</strong><small>Não foi possível abrir este arquivo.</small></div></article>'; }
    }));

    const history = (item.review_history || []).map(record => '<li><b>' + e(kycLabels[record.to_status] || record.to_status) + '</b> · ' + e(C.date(record.created_at)) + '<small>' + e(record.reviewer_email || 'Sistema / Lojista') + ' · ' + e(record.reason || 'Sem observação.') + '</small></li>').join('');
    const notice = item.reason_description ? '<p class="kyc-review-notice"><b>Observação:</b> ' + e(item.reason_description) + '</p>' : '';
    const initials = String(item.data?.company?.legal_name || item.full_name || 'C').trim().split(/\s+/).slice(0,2).map(part => part[0]).join('').toUpperCase();
    const badgeClass = item.status === 'APPROVED' ? 'paid' : ['REJECTED','SUSPENDED','BLOCKED'].includes(item.status) ? 'cancelled' : 'pending';

    const approvedBanner = isApproved
      ? '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:10px;background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;margin-bottom:16px;">' +
          '<span style="font-size:20px;">✅</span>' +
          '<div><strong style="font-size:14px;color:#047857;display:block;">Cadastro Aprovado e Ativo</strong>' +
          '<span style="font-size:12px;color:#065f46;">Este lojista já foi aprovado e todos os dados e documentos continuam preservados no sistema.' + (item.reviewed_at ? ' (Aprovado em ' + e(C.date(item.reviewed_at)) + ')' : '') + '</span></div>' +
        '</div>'
      : '';

    // Diligência simplificada a pedido do operador: aprovação ou recusa direta sem exigência de PEP prévio.
    // Registro de auditoria compatível: nexora_admin_record_kyc_screening (opcional). Este formulário não consulta listas externas automaticamente.
    const decisionSection = isApproved
      ? '<details class="kyc-review-decision" style="margin-top:20px;border-top:1px solid var(--line);padding-top:14px;"><summary style="cursor:pointer;font-weight:600;font-size:13px;color:var(--muted);padding:4px 0;">⚙️ Opções avançadas: alterar decisão cadastral</summary><p style="margin-top:8px;font-size:12px;color:var(--muted);">Selecione apenas se desejar revogar ou alterar o status atual do lojista.</p><label class="nx-field">Nova decisão<select name="decision"><option value="" selected>Manter status atual (Aprovado)</option><option value="PENDING_DOCUMENTS">Solicitar correções ou documentos</option><option value="REJECTED">Recusar cadastro</option></select></label><label class="nx-field">Motivo da alteração<textarea name="reason" rows="2" maxlength="1000" placeholder="Informe o motivo caso vá alterar o status."></textarea></label></details>'
      : '<section class="kyc-review-decision"><h3>Decisão de análise cadastral</h3><p>Defina o status cadastral da conta para liberar ou reprovar a operação.</p><label class="nx-field">Decisão<select name="decision" required><option value="" selected disabled>Selecione uma decisão</option><option value="APPROVED">Aprovar cadastro</option><option value="PENDING_DOCUMENTS">Solicitar correções ou documentos</option><option value="REJECTED">Recusar cadastro</option></select></label><label class="nx-field">Motivo da decisão<textarea name="reason" rows="3" maxlength="1000" required placeholder="Explique a decisão para o histórico."></textarea></label></section>';

    const content = approvedBanner +
      '<div class="kyc-review-lead"><span class="kyc-review-avatar">' + e(initials) + '</span><div><strong>' + e(item.data?.company?.legal_name || item.full_name || 'Cadastro de cliente') + '</strong><small>' + e(item.email || '') + '</small></div><span class="nx-status ' + badgeClass + '">' + e(kycLabels[item.status] || item.status) + '</span></div>' +
      notice +
      '<section class="kyc-review-section"><div class="kyc-review-section-head"><h3>Perfil cadastral completo</h3><span>' + fields.length + ' campos</span></div><dl class="nx-details kyc-review-details">' + details + '</dl></section>' +
      ownersDetails +
      '<section class="kyc-review-section"><div class="kyc-review-section-head"><h3>Documentos e fotos anexadas</h3><span>' + (documents.length ? documents.length + ' arquivo(s)' : 'Nenhum anexo') + '</span></div>' +
      (documents.length ? '<div class="kyc-file-grid">' + documents.join('') + '</div>' : '<div style="padding:14px;background:var(--panel2);border:1px dashed var(--line);border-radius:10px;color:var(--muted);font-size:13px;display:flex;align-items:center;gap:12px;"><span style="font-size:22px;">📷</span><div><strong style="display:block;color:var(--text);margin-bottom:2px;">Nenhuma foto ou documento anexado</strong><span>O lojista preencheu apenas os dados cadastrais (o upload de documentos é opcional no formulário simplificado).</span></div></div>') +
      '</section>' +
      (history ? '<details class="kyc-review-history"><summary>Histórico de análise</summary><ul class="nx-audit">' + history + '</ul></details>' : '') +
      decisionSection;

    const modalTitle = isApproved ? 'Dados cadastrais do cliente' : 'Analisar cadastro';
    const submitBtnLabel = isApproved ? 'Fechar / Concluir' : 'Salvar decisão';

    UI.modal(modalTitle, content, async dialog => {
      const decision = dialog.querySelector('[name=decision]')?.value;
      if (!decision) {
        return true;
      }
      const reason = (dialog.querySelector('[name=reason]')?.value || '').trim();
      if (!reason && !isApproved) throw new Error('Informe o motivo da decisão.');
      await API.rpc('nexora_admin_review_merchant', {
        p_user_id: userId,
        p_decision: decision,
        p_reason: reason || (decision === 'APPROVED' ? 'Cadastro aprovado pelo Super Admin' : 'Status alterado pelo administrador')
      });
      let emailSent = false;
      try {
        const {error} = await window.nexoraSupabase.functions.invoke('nexora-email-events', { body: { type: 'kyc_decision', user_id: userId } });
        if (!error) emailSent = true;
      } catch (err) { console.warn('Decisão KYC salva; notificação por e-mail não enviada.', err?.message || ''); }
      await loadKyc();
      UI.toast(emailSent ? 'Decisão registrada e aviso enviado por e-mail.' : 'Decisão registrada com sucesso.');
      return true;
    }, { submitLabel: submitBtnLabel, className: 'admin-review-dialog' });
  }
  function render() {
    const stats = data.stats;
    document.querySelector('[data-admin-stats]').innerHTML = [['Contas cadastradas',stats.accounts],['Contas habilitadas',stats.active_accounts],['Contas suspensas',stats.suspended_accounts],['Workspaces cadastrados',stats.workspaces]].map(([label,value]) => '<article class="admin-stat"><small>' + label + '</small><strong>' + value + '</strong></article>').join('');
    renderDashboardMetrics();
    document.querySelector('[data-admin-accounts]').innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th scope="col">Conta</th><th scope="col">Workspace · clientes</th><th scope="col">Adquirente atribuído</th><th scope="col">Último login</th><th scope="col">Status / ações</th></tr></thead><tbody>' + data.accounts.map(item => {
      const conn = connections.find(c => c.owner_id === item.user_id);
      const acq = conn ? acquirers.find(a => a.id === conn.acquirer_id) : null;
      const acquirerBadge = conn ? '<b>' + e(acq?.name || conn.acquirer_name || 'Adquirente vinculado') + '</b><small>' + e(acq?.environment === 'production' ? 'Produção' : 'Testes') + ' · ' + e(conn.status === 'active' ? 'Ativo' : (conn.status === 'disabled' ? 'Desativado' : conn.status)) + '</small>' : '<span class="nx-status pending">Sem adquirente</span>';
      return '<tr><td><button class="nx-link" data-account="' + e(item.user_id) + '">' + e(item.full_name) + '</button><small>' + e(item.email) + '</small><small>Cadastro: ' + e(C.date(item.created_at)) + '</small></td><td>' + ((item.workspaces || []).map(w => '<div class="admin-workspace-count"><span>' + e(w.name) + '</span><small>' + Number(w.customer_count || 0) + ' ' + (Number(w.customer_count || 0) === 1 ? 'cliente' : 'clientes') + '</small></div>').join('') || 'Ainda não configurado') + '</td><td>' + acquirerBadge + '</td><td>' + e(C.date(item.last_sign_in_at)) + '</td><td><span class="nx-status ' + (item.status === 'active' ? 'paid' : 'cancelled') + '">' + (item.status === 'active' ? 'Ativa' : 'Suspensa') + '</span>' + (item.is_admin ? '<small>Administrador Nexora Pay — protegida</small>' : '<div class="admin-account-actions">' + ((item.workspaces || []).length ? '<button class="table-action" data-account-manage="' + e(item.user_id) + '">Gerenciar</button><button class="table-action highlight" data-account-acquirer="' + e(item.user_id) + '">Adquirente</button><button class="table-action" data-account-pricing="' + e(item.user_id) + '">Tarifa Pix</button>' : '<small>Gerenciamento após aprovação do cadastro</small>') + '<button class="table-action" data-account-status="' + e(item.user_id) + '">' + (item.status === 'active' ? 'Suspender' : 'Reativar') + '</button><button class="table-action danger" data-account-remove="' + e(item.user_id) + '">Remover</button></div>') + '</td></tr>';
    }).join('') + (data.accounts.length ? '' : '<tr><td colspan="5">Nenhuma conta encontrada.</td></tr>') + '</tbody></table></div>';
    document.querySelector('[data-admin-customers]').innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Cliente</th><th>Workspace</th><th>Última movimentação</th><th>Total recebido</th></tr></thead><tbody>' + data.customers.map(item => '<tr><td><button class="nx-link" data-customer="' + e(item.id) + '">' + e(item.name) + '</button><small>' + e(item.email || 'E-mail não informado') + '</small></td><td>' + e(item.business_name) + '</td><td>' + e(data.gateway_ready ? C.date(item.last_activity) : 'Aguardando IP') + '</td><td>' + (data.gateway_ready ? C.money(item.total) : 'Aguardando IP') + '</td></tr>').join('') + (data.customers.length ? '' : '<tr><td colspan="4">Nenhum cliente encontrado.</td></tr>') + '</tbody></table></div>';
    labelRepeatedActions();
    pager('[data-account-pager]', data.account_count, page, 'account'); pager('[data-customer-pager]', data.customer_count, customerPage, 'customer');
    renderOverview();
    document.querySelector('[data-admin-withdrawals]').innerHTML = data.withdrawals.length ? '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Conta / destino Pix</th><th>Solicitado em</th><th>Valor</th><th>Status</th><th>Referência</th></tr></thead><tbody>' + data.withdrawals.map(item => '<tr><td>' + e(item.email) + '<small>' + e(item.business_name) + '</small><small>' + e(item.destination) + '</small></td><td>' + e(C.date(item.created_at)) + '</td><td>' + C.money(item.amount) + '</td><td>' + status(item.status) + '</td><td>' + e(item.provider_reference || (data.gateway_ready ? 'Aguardando confirmação do adquirente' : 'IP ainda não integrada')) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="nx-empty">Nenhuma solicitação de saque registrada na plataforma.</div>';
    const site = data.site || {}, form = document.querySelector('[data-admin-site]');
    if (!form.dataset.dirty) form.innerHTML = '<div style="margin-bottom:18px;"><button type="button" class="button outline" data-admin-open-logo-modal><span data-nx-icon="image"></span> Mudar logo &amp; ícone da aba (Favicon)</button></div><div class="nx-site-grid">' + field('Cor principal','accent',site.accent || '#7c3aed','color') + field('Título da home','hero_title',site.hero_title || 'Dinheiro em movimento.') + field('Destaque do título','hero_subtitle',site.hero_subtitle || 'Negócios no controle.') + field('Descrição da home','hero_description',site.hero_description || 'Uma plataforma de pagamentos feita para simplificar a operação e dar clareza para cada decisão.') + field('Taxa Pix (texto aprovado)','pix_rate',site.pix_rate || 'Sob consulta') + field('Taxa de saque (texto aprovado)','withdrawal_rate',site.withdrawal_rate || 'Sob consulta') + field('E-mail de suporte','support_email',site.support_email,'email') + field('Contato de privacidade/LGPD','privacy_email',site.privacy_email,'email') + field('Razão social','legal_name',site.legal_name) + field('CNPJ','document',site.document) + field('Imagem de fundo (URL HTTPS)','hero_image',site.hero_image,'url') + field('Logo / Favicon da aba (URL HTTPS)','logo_url',site.logo_url,'url') + '</div><div class="nx-site-grid"><label class="nx-field">Enviar imagem de fundo<input type="file" data-upload="hero_image" accept="image/jpeg,image/png,image/webp"><small>Até 5 MB. Publicada somente ao salvar.</small></label><label class="nx-field">Enviar logo &amp; ícone da aba<input type="file" data-upload="logo_url" accept="image/jpeg,image/png,image/webp,image/svg+xml"><small>PNG, JPG, SVG ou WebP até 5 MB. Atualiza o site e o ícone da aba.</small></label></div><button class="button button-primary" type="submit">Salvar conteúdo do site</button><p data-site-message role="status"></p>';
  }
  function renderDashboardMetrics() {
    const cards = document.querySelector('[data-admin-finance-stats]');
    const volumeChart = document.querySelector('[data-admin-volume-chart]');
    const methodChart = document.querySelector('[data-admin-method-chart]');
    if (!cards || !volumeChart || !methodChart) return;
    const today = dashboardMetrics?.today || {};
    const activeBusinesses = data?.stats?.workspaces ?? '—';
    const metricsReady = Boolean(dashboardMetrics);
    cards.innerHTML = [
      ['Volume processado hoje', metricsReady ? C.money(today.volume || 0) : '—', 'Pagamentos reais confirmados'],
      ['Transações aprovadas hoje', metricsReady ? Number(today.transactions || 0).toLocaleString('pt-BR') : '—', 'Confirmadas pelo adquirente'],
      ['Empresas cadastradas', Number(activeBusinesses).toLocaleString('pt-BR'), 'Workspaces na plataforma'],
      ['Ticket médio hoje', metricsReady ? C.money(today.average_ticket || 0) : '—', 'Somente pagamentos confirmados']
    ].map(([label,value,note]) => '<article class="admin-stat"><small>' + e(label) + '</small><strong>' + e(value) + '</strong><span>' + e(note) + '</span></article>').join('');
    if (!dashboardMetrics) {
      const unavailable = '<div class="admin-chart-empty"><span class="admin-chart-empty-icon" aria-hidden="true">↗</span><strong>Indicadores indisponíveis</strong><p>' + e(dashboardMetricsError || 'Carregando indicadores do Supabase…') + '</p></div>';
      volumeChart.innerHTML = unavailable;
      methodChart.innerHTML = unavailable;
      return;
    }
    const range = Number(document.querySelector('[data-admin-chart-range]')?.value || 30);
    const series = (dashboardMetrics.volume_by_day || []).slice(-range);
    const width = 720, height = 250, left = 48, right = 12, top = 18, bottom = 38;
    const values = series.map(item => Number(item.amount) || 0);
    const max = Math.max(1, ...values);
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const points = values.map((value,index) => ({
      x: left + (series.length < 2 ? plotWidth / 2 : index * plotWidth / (series.length - 1)),
      y: top + plotHeight * (1 - value / max),
      item: series[index]
    }));
    const line = points.map(point => point.x.toFixed(1) + ',' + point.y.toFixed(1)).join(' ');
    const area = points.length ? left + ',' + (top + plotHeight) + ' ' + line + ' ' + (left + plotWidth) + ',' + (top + plotHeight) : '';
    const grid = [0, 1, 2, 3].map(index => {
      const y = top + index * plotHeight / 3;
      const value = max * (1 - index / 3);
      return '<line x1="' + left + '" y1="' + y + '" x2="' + (left + plotWidth) + '" y2="' + y + '" class="admin-chart-gridline"/><text x="' + (left - 8) + '" y="' + (y + 4) + '" text-anchor="end" class="admin-chart-axis-label">' + e(C.money(value)) + '</text>';
    }).join('');
    const markerStep = Math.max(1, Math.ceil((series.length - 1) / 5));
    const markers = points.map((point,index) => '<circle cx="' + point.x + '" cy="' + point.y + '" r="3.5" class="admin-chart-point"><title>' + e(series[index].date) + ' · ' + e(C.money(point.item.amount)) + ' · ' + Number(point.item.count || 0) + ' pagamento(s)</title></circle>').join('');
    const labels = points.filter((_,index) => index === 0 || index === points.length - 1 || index % markerStep === 0).map(point => '<text x="' + point.x + '" y="' + (height - 9) + '" text-anchor="middle" class="admin-chart-axis-label">' + e(String(point.item.date || '').slice(5).replace('-', '/')) + '</text>').join('');
    const totalVolume = values.reduce((sum,value) => sum + value, 0);
    volumeChart.innerHTML = series.length ? '<div class="admin-chart-total"><strong>' + e(C.money(totalVolume)) + '</strong><span>nos últimos ' + range + ' dias</span></div><svg class="admin-volume-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Volume processado por dia nos últimos ' + range + ' dias. Total ' + e(C.money(totalVolume)) + '"><defs><linearGradient id="admin-volume-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#a879ef" stop-opacity=".28"/><stop offset="100%" stop-color="#a879ef" stop-opacity="0"/></linearGradient></defs>' + grid + '<polygon points="' + area + '" class="admin-chart-area"/><polyline points="' + line + '" class="admin-chart-line"/>' + markers + labels + '</svg><p class="admin-chart-caption">Valores confirmados pelo adquirente. Sandbox, lançamentos manuais e registros antigos são excluídos.</p>' : '<div class="admin-chart-empty"><strong>Sem pagamentos neste período</strong><p>Quando o adquirente confirmar pagamentos, a evolução aparecerá aqui.</p></div>';
    const methods = dashboardMetrics.payment_methods || [];
    const maxMethod = Math.max(1, ...methods.map(item => Number(item.amount) || 0));
    const methodLabels = {pix:'Pix',card:'Cartão',boleto:'Boleto'};
    methodChart.innerHTML = methods.length ? '<div class="admin-method-list">' + methods.map((item,index) => {
      const key = String(item.method || 'outro').toLowerCase();
      const percent = Math.max(0, Math.min(100, (Number(item.amount) || 0) / maxMethod * 100));
      return '<div class="admin-method-row"><div><span>' + e(methodLabels[key] || 'Outros') + '</span><b>' + e(C.money(item.amount || 0)) + '</b></div><div class="admin-method-track"><i class="admin-method-fill tone-' + (index % 3) + '" style="width:' + percent.toFixed(1) + '%"></i></div><small>' + Number(item.count || 0).toLocaleString('pt-BR') + ' pagamentos confirmados</small></div>';
    }).join('') + '</div><p class="admin-chart-caption">Somente cobranças reais liquidadas nos últimos 30 dias.</p>' : '<div class="admin-chart-empty"><strong>Sem pagamentos por método</strong><p>Os métodos aparecerão aqui depois das primeiras confirmações do adquirente.</p></div>';
  }
  function renderOverview() {
    if (!data) return;
    const pending = kycCases.filter(item => ['SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW','PENDING_DOCUMENTS'].includes(item.status)).length;
    const unreadAlerts = alerts.filter(item => !item.read_at).length;
    const setNavCount = (id, count, accessibleLabel) => {
      const link = document.querySelector('[data-admin-nav][href="#' + id + '"]');
      if (!link) return;
      link.querySelector('.admin-nav-count')?.remove();
      if (count > 0) {
        const badge = document.createElement('em');
        badge.className = 'admin-nav-count';
        badge.textContent = String(count);
        link.append(badge);
        link.setAttribute('aria-label', accessibleLabel + ', ' + count);
      } else link.removeAttribute('aria-label');
    };
    setNavCount('admin-kyc', pending, 'Análise cadastral pendente');
    setNavCount('admin-alerts', unreadAlerts, 'Alertas não lidos');
    const configured = connections.some(c => c.status === 'active' && c.api_key_configured === true && providerCatalog.some(adapter => adapter.code === c.acquirer_code && adapter.implementation_status === 'implemented'));
    document.querySelector('[data-admin-overview-extra]').innerHTML = '<article class="admin-panel admin-gateway-state"><div><h2>Operação financeira</h2><p>Os adquirentes são conectados por adaptadores; cada lojista mantém seu controle operacional. Pagamentos recebidos só podem virar saldo sacável após ledger de produção, liquidação e conciliação. Código implementado não comprova homologação, autorização contratual ou disponibilidade operacional.</p></div><strong>' + (configured ? 'Adaptador atribuído · homologação não verificada aqui' : 'Nenhum adaptador implementado atribuído') + '</strong></article>';
  }
  function transactionDetails(item) {
    UI.modal('Detalhes da transação', '<dl class="nx-details">' + [['Descrição',item.title],['Referência',item.external_id],['Workspace',item.business_name],['Valor',C.money(item.amount)],['Status',C.status(item.status)],['Ambiente',item.test_mode ? 'Ambiente de testes, sem movimentação real' : 'Produção / origem registrada'],['Método',item.payment_method === 'pix' ? 'Pix' : item.payment_method],['Origem',item.test_mode ? 'Adaptador · testes' : ({manual:'Lançamento manual legado',legacy:'Registro legado',gateway:'Adquirente'}[item.source] || 'Não informada')],['Cliente',item.customer_name],['E-mail',item.customer_email],['Destino',item.destination],['Criada em',C.date(item.created_at)],['Liquidada em',item.paid_at ? C.date(item.paid_at) : 'Ainda não liquidada'],['Taxa',item.fee == null ? 'Não informada pela IP' : C.money(item.fee)],['Referência do adquirente',item.provider_reference || 'Ainda não informada'],['ID interno',item.id]].filter(([,v]) => v != null && v !== '').map(([label,value]) => '<div><dt>' + e(label) + '</dt><dd>' + e(value) + '</dd></div>').join('') + '</dl>');
  }
  async function showTransactions(userId, customerId, title) {
    let current = 0;
    const dialog = UI.modal(title, '<div data-modal-transactions role="status">Carregando registros…</div><div class="nx-pager" data-tx-pager></div>');
    async function read() {
      const container = dialog.querySelector('[data-modal-transactions]'); container.textContent = 'Carregando…';
      try {
        const result = await API.rpc('nexora_admin_transactions', {p_user_id:userId,p_customer_id:customerId || null,p_page:current});
        if (!dialog.isConnected) return;
        container.innerHTML = result.rows.map(item => '<button type="button" class="nx-activity" data-detail="' + e(item.id) + '"><span><b>' + e(item.title) + '</b><small>' + e(item.external_id) + ' · ' + e(C.date(item.created_at)) + (item.test_mode ? ' · Testes' : '') + '</small></span><strong class="' + (item.kind === 'withdrawal' ? 'negative' : '') + '">' + (item.kind === 'withdrawal' ? '− ' : '+ ') + C.money(item.amount) + '</strong>' + status(item.status) + (item.test_mode ? '<small class="nx-status pending">Testes</small>' : '') + '</button>').join('') || '<p>Nenhuma transação vinculada.</p>';
        container.querySelectorAll('[data-detail]').forEach(button => button.onclick = () => transactionDetails(result.rows.find(item => item.id === button.dataset.detail)));
        dialog.querySelector('[data-tx-pager]').innerHTML = '<button class="button outline" type="button" data-tx-prev' + (current === 0 ? ' disabled' : '') + '>Anterior</button><span>' + result.count + ' registro(s) · página ' + (current + 1) + '</span><button class="button outline" type="button" data-tx-next' + ((current + 1) * 50 >= result.count ? ' disabled' : '') + '>Próxima</button>';
        dialog.querySelector('[data-tx-prev]').onclick = () => { current--; read(); }; dialog.querySelector('[data-tx-next]').onclick = () => { current++; read(); };
      } catch (error) { if (dialog.isConnected) container.textContent = error.message; }
    }
    read();
  }
  document.querySelector('[data-admin-logout]').onclick = () => UI.confirm('Sair do Painel Nexora Pay?', 'Você precisará entrar novamente.', UI.logout, 'Sair');
  document.querySelector('[data-admin-refresh]').onclick = load;
  document.querySelector('[data-admin-chart-range]')?.addEventListener('change', renderDashboardMetrics);
  document.querySelector('[data-admin-kyc-refresh]').onclick = loadKyc;
  document.querySelector('[data-admin-kyc-search]')?.addEventListener('input', event => {
    kycSearch = event.target.value;
    renderKycTable();
  });
  document.querySelector('[data-admin-alerts-refresh]').onclick = loadOperations;
  document.querySelector('[data-admin-webhooks-refresh]').onclick = loadAdminWebhooks;
  document.querySelector('[data-admin-payout-refresh]')?.addEventListener('click', loadAdminPayouts);
  document.addEventListener('click', event => {
    const kycTab = event.target.closest('[data-kyc-tab]');
    if (kycTab) {
      kycFilter = kycTab.dataset.kycTab;
      renderKycTable();
      return;
    }
    const tabBtn = event.target.closest('[data-payout-tab]');
    if (tabBtn) {
      adminPayoutFilter = tabBtn.dataset.payoutTab;
      document.querySelectorAll('[data-payout-tab]').forEach(btn => btn.classList.toggle('active', btn === tabBtn));
      renderAdminPayoutRows();
    }
  });
  document.querySelector('[data-fund-holds-refresh]')?.addEventListener('click', loadAdminFundHolds);
  document.querySelector('[data-fund-hold-form]')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const output = document.querySelector('[data-fund-hold-message]');
    if (form.dataset.busy || !form.reportValidity()) return;
    const amount = Number(form.elements.amount.value);
    const amountCents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || !Number.isSafeInteger(amountCents) || amountCents <= 0 || Math.abs(amount * 100 - amountCents) > 1e-7) {
      output.textContent = 'Informe um valor válido com até duas casas decimais.'; return;
    }
    const button = form.querySelector('[type=submit]');
    const requestId = form.dataset.requestId || crypto.randomUUID();
    form.dataset.requestId = requestId;
    form.dataset.busy = 'true'; button.disabled = true; output.textContent = 'Registrando bloqueio no ledger…';
    try {
      const { data: result, error } = await window.nexoraSupabase.functions.invoke('nexora-fund-controls', { body: {
        action: 'hold', business_id: form.elements.business_id.value, amount_cents: amountCents,
        request_id: requestId, reason: form.elements.reason.value.trim(),
      } });
      if (error) throw error;
      if (result?.status !== 'active') throw new Error(result?.error || 'O bloqueio não foi confirmado.');
      delete form.dataset.requestId;
      form.reset(); renderFundHoldMerchants();
      output.textContent = 'Bloqueio registrado com ID ' + result.hold_id + '.';
      await loadAdminFundHolds();
      UI.toast('Saldo disponível movido para o bucket bloqueado e registrado no ledger.');
    } catch (error) {
      output.textContent = API.errorMessage(error) + ' Se a resposta foi interrompida, tente novamente sem alterar os campos para repetir a mesma chave idempotente.';
    } finally { delete form.dataset.busy; button.disabled = false; }
  });
  document.querySelector('[data-reserve-refresh]')?.addEventListener('click', loadMaturedReserves);
  document.querySelector('[data-reserve-release]')?.addEventListener('click', releaseMaturedReserves);
  document.querySelector('[data-reconciliation-refresh]')?.addEventListener('click', loadReconciliationRuns);
  document.querySelector('[data-reconciliation-form]')?.addEventListener('submit', runReconciliation);
  const reconciliationDate = document.querySelector('[data-reconciliation-form] [name="date"]');
  if (reconciliationDate) {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const closedDate = [yesterday.getFullYear(), String(yesterday.getMonth() + 1).padStart(2, '0'), String(yesterday.getDate()).padStart(2, '0')].join('-');
    reconciliationDate.value = closedDate;
    reconciliationDate.max = closedDate;
  }
  document.addEventListener('click', event => {
    const fundHoldButton = event.target.closest('[data-fund-hold-release]');
    if (fundHoldButton) {
      releaseMerchantFunds(fundHoldButton.dataset.fundHoldRelease, fundHoldButton.dataset.businessName || 'lojista', Number(fundHoldButton.dataset.holdAmount));
      return;
    }
    const payoutReview = event.target.closest('[data-payout-review]');
    if (payoutReview) { reviewAdminPayout(payoutReview.dataset.payoutId, payoutReview.dataset.payoutReview); return; }
    const settlementRun = event.target.closest('[data-reconciliation-settle-run]')?.dataset.reconciliationSettleRun;
    if (settlementRun) { settleReconciliationRun(settlementRun); return; }
    const run = event.target.closest('[data-reconciliation-run]')?.dataset.reconciliationRun;
    if (run) { loadReconciliationDetail(run); return; }
    const pageButton = event.target.closest('[data-reconciliation-page]');
    if (pageButton) { loadReconciliationDetail(pageButton.dataset.reconciliationPageRun, Number(pageButton.dataset.reconciliationPage), Number(pageButton.dataset.currentExceptions || 0)); return; }
    const exceptionPageButton = event.target.closest('[data-reconciliation-exception-page]');
    if (exceptionPageButton) { loadReconciliationDetail(exceptionPageButton.dataset.reconciliationExceptionRun, Number(exceptionPageButton.dataset.currentItems || 0), Number(exceptionPageButton.dataset.reconciliationExceptionPage)); return; }
    if (event.target.closest('[data-reconciliation-close]')) document.querySelector('[data-reconciliation-detail]').replaceChildren();
  });
  document.querySelector('[data-provider-health-check]')?.addEventListener('click', event => checkProviderHealth(event.currentTarget));
  document.querySelector('[data-acquirer-new]').onclick = () => editAcquirer();
  document.addEventListener('click', event => {
    const webhookRetry = event.target.closest('[data-webhook-retry]')?.dataset.webhookRetry;
    if (webhookRetry) { retryMerchantWebhook(webhookRetry); return; }
    const edit = event.target.closest('[data-acquirer-edit]')?.dataset.acquirerEdit;
    if (edit) { editAcquirer(acquirers.find(a => a.id === edit)); return; }
    const removeAcq = event.target.closest('[data-acquirer-remove]')?.dataset.acquirerRemove;
    if (removeAcq) { const item = acquirers.find(a => a.id === removeAcq); if (item) removeAcquirerHandler(item); return; }
    const credentialOwner = event.target.closest('[data-provider-config]')?.dataset.providerConfig;
    if (credentialOwner) { configureProviderCredential(credentialOwner); return; }
    const manage = event.target.closest('[data-account-manage]')?.dataset.accountManage;
    if (manage && data) { const account = data.accounts.find(row => row.user_id === manage); if (account) manageAccount(account); return; }
    const acquirerTarget = event.target.closest('[data-account-acquirer]')?.dataset.accountAcquirer;
    if (acquirerTarget && data) { const account = data.accounts.find(row => row.user_id === acquirerTarget); if (account) configureAcquirer(account); return; }
    const connManage = event.target.closest('[data-connection-manage]')?.dataset.connectionManage;
    if (connManage && data) { const account = data.accounts.find(row => row.user_id === connManage); if (account) configureAcquirer(account); return; }
    const pricingOwner = event.target.closest('[data-account-pricing]')?.dataset.accountPricing;
    if (pricingOwner && data) { const account = data.accounts.find(row => row.user_id === pricingOwner); if (account) configurePixPricing(account); return; }
    const remove = event.target.closest('[data-account-remove]')?.dataset.accountRemove;
    if (remove && data) {
      const account = data.accounts.find(row => row.user_id === remove);
      if (!account || account.is_admin) return;
      UI.modal('Remover conta permanentemente?', '<p><b>' + e(account.full_name) + ' · ' + e(account.email) + '</b></p><p>Esta ação exclui o login e os dados associados a esta conta. Não pode ser desfeita. Para confirmar, digite exatamente o e-mail da conta.</p>' + field('E-mail para confirmar','confirm_email','','email') , async dialog => {
        if (dialog.querySelector('[name=confirm_email]').value.trim().toLowerCase() !== account.email.toLowerCase()) throw new Error('O e-mail informado não corresponde à conta selecionada.');
        const {data:result,error} = await window.nexoraSupabase.functions.invoke('nexora-admin-delete-user',{body:{user_id:account.user_id}});
        if (error) {
          let detail = error.message || 'A função de exclusão recusou a solicitação.';
          try { const payload = await error.context?.clone?.().json(); if (payload?.error) detail = payload.error; } catch (_) {}
          throw new Error(detail);
        }
        if (!result?.ok) throw new Error(result?.error || 'Não foi possível remover a conta.');
        await load(); UI.toast(result.audit_logged && result.documents_removed ? 'Conta e documentos vinculados removidos.' : 'Conta removida; verifique o histórico para confirmar a limpeza de documentos e auditoria.');
      },{submitLabel:'Excluir conta'});
      return;
    }
    const alertId = event.target.closest('[data-alert-read]')?.dataset.alertRead;
    if (alertId) API.rpc('nexora_admin_mark_notification_read',{p_id:alertId}).then(loadOperations).then(() => UI.toast('Alerta marcado como lido.')).catch(error => UI.toast(error.message));
    const routeToChange = event.target.closest('[data-provider-status]')?.dataset.providerStatus;
    if (routeToChange) {
      const button = event.target.closest('[data-provider-status]');
      const [businessId, acquirerId] = routeToChange.split('|');
      UI.confirm(button.dataset.nextStatus === 'disabled' ? 'Desativar rota?' : 'Reabrir rota para homologação?', 'A rota será alterada apenas para este workspace. Reabrir retorna a rota para análise pendente.', async () => {
        try { await API.rpc('nexora_admin_set_provider_route_status',{p_business_id:businessId,p_acquirer_id:acquirerId,p_status:button.dataset.nextStatus});
          await loadOperations(); UI.toast('Status da conexão atualizado.');
        } catch (error) { UI.toast(error.message); }
      },'Confirmar');
      return;
    }
    const routeToActivate = event.target.closest('[data-provider-activate]')?.dataset.providerActivate;
    if (routeToActivate) {
      const [businessId, acquirerId] = routeToActivate.split('|');
      UI.confirm('Ativar rota do lojista?', 'A ativação exige uma credencial central validada. O processamento também verificará a aprovação cadastral, os controles e a tarifa de cada cobrança.', async () => {
        try {
          await API.rpc('nexora_admin_activate_provider_route',{p_business_id:businessId,p_acquirer_id:acquirerId});
          await loadOperations(); UI.toast('Rota ativada para este workspace.');
        } catch (error) { UI.toast(error.message); }
      },'Ativar rota');
      return;
    }
  });
  document.querySelector('[data-admin-search]').oninput = event => { query = event.target.value; page = 0; clearTimeout(searchTimer); searchTimer = setTimeout(load,300); };
  document.querySelector('[data-admin-customer-search]').oninput = event => { customerQuery = event.target.value; customerPage = 0; clearTimeout(searchTimer); searchTimer = setTimeout(load,300); };
  const connSearchEl = document.querySelector('[data-admin-connection-search]');
  if (connSearchEl) connSearchEl.oninput = () => renderOperations();
  document.addEventListener('click', event => {
    const custodyTab = event.target.closest('[data-custody-tab]')?.dataset.custodyTab;
    if (custodyTab) { switchCustodyTab(custodyTab); return; }
    if (event.target.closest('[data-cautelar-open]')) { openCautelarModal(); return; }
    const cautelarEdit = event.target.closest('[data-cautelar-edit]')?.dataset.cautelarEdit;
    if (cautelarEdit) { openCautelarModal(cautelarEdit); return; }
    const copyBtn = event.target.closest('[data-copy-url]');
    if (copyBtn) {
      const url = copyBtn.dataset.copyUrl;
      if (url && navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => UI.toast('URL copiada para a área de transferência!')).catch(() => UI.toast('URL selecionada: ' + url));
      }
      return;
    }
    if (event.target.closest('[data-export-members-pdf]')) { exportMembersPdf(); return; }
    if (event.target.closest('[data-export-transactions-pdf]')) { exportTransactionsPdf(); return; }
    const settleBtn = event.target.closest('[data-settle-pending]');
    if (settleBtn) {
      settlePendingMerchantFunds(
        settleBtn.dataset.settlePending,
        settleBtn.dataset.businessName || 'Empresa',
        Number(settleBtn.dataset.pendingCents || 0)
      );
      return;
    }
    if (event.target.closest('[data-ledger-balances-refresh]')) {
      loadLedgerBalances();
      return;
    }
    const kycReview = event.target.closest('[data-kyc-review]')?.dataset.kycReview;
    if (kycReview) { reviewKyc(kycReview, false); return; }
    const kycView = event.target.closest('[data-kyc-view]')?.dataset.kycView;
    if (kycView) { reviewKyc(kycView, true); return; }
    if (!data) return;
    const account = event.target.closest('[data-account]')?.dataset.account;
    if (account) { const item = data.accounts.find(row => row.user_id === account); showTransactions(item.user_id,null,item.full_name + ' · Transações'); }
    const customer = event.target.closest('[data-customer]')?.dataset.customer;
    if (customer) { const item = data.customers.find(row => row.id === customer); showTransactions(item.owner_id,item.id,item.name + ' · ' + item.business_name); }
    const change = event.target.closest('[data-account-status]')?.dataset.accountStatus;
    if (change) {
      const item = data.accounts.find(row => row.user_id === change), next = item.status === 'active' ? 'suspended' : 'active';
      UI.modal(next === 'active' ? 'Reativar acesso?' : 'Suspender acesso?', '<p>' + e(item.email) + '. A conta e os dados serão preservados.</p>' + field('Motivo (opcional)','reason',''), async dialog => { await API.rpc('nexora_admin_set_account',{p_user_id:item.user_id,p_status:next,p_reason:dialog.querySelector('[name=reason]').value}); await load(); UI.toast('Status da conta atualizado.'); },{submitLabel:'Confirmar'});
    }
    const withdrawal = event.target.closest('[data-withdrawal]');
    if (withdrawal) { UI.toast('Ações manuais de saque ficam desativadas; a liquidação deve ser confirmada pelo adquirente.'); return; }
    const paging = event.target.closest('[data-page]')?.dataset.page;
    if (paging) { if (paging === 'account-prev') page--; else if (paging === 'account-next') page++; else if (paging === 'customer-prev') customerPage--; else customerPage++; load(); }
  });
  const form = document.querySelector('[data-admin-site]');
  form.oninput = () => { form.dataset.dirty = 'true'; };
  form.onchange = async event => {
    const key = event.target.dataset.upload; if (!key || !event.target.files[0]) return;
    const file = event.target.files[0], output = form.querySelector('[data-site-message]');
    try {
      if (!['image/png','image/jpeg','image/webp','image/svg+xml'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Use PNG, JPG, SVG ou WebP de até 5 MB.');
      busy = true; form.querySelector('[type=submit]').disabled = true; output.textContent = 'Enviando imagem…';
      const ext = file.type === 'image/svg+xml' ? 'svg' : ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[file.type] || 'png');
      const path = crypto.randomUUID() + '.' + ext;
      const {error} = await window.nexoraSupabase.storage.from('nexora-site').upload(path,file,{contentType:file.type,upsert:false});
      if (error) throw error;
      const publicUrl = window.nexoraSupabase.storage.from('nexora-site').getPublicUrl(path).data.publicUrl;
      form.querySelector('[name=' + key + ']').value = publicUrl;
      form.dataset.dirty = 'true'; output.textContent = 'Imagem enviada. Clique em salvar para publicá-la no site e na aba.';
    } catch (error) { output.textContent = API.errorMessage(error); }
    finally { busy = false; form.querySelector('[type=submit]').disabled = false; }
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    busy = true; const button = form.querySelector('[type=submit]'); button.disabled = true;
    try {
      const content = Object.fromEntries([...new FormData(form)].filter(([key,value]) => typeof value === 'string').map(([key,value]) => [key,value.trim()]));
      await API.rpc('nexora_admin_save_site',{p_content:content});
      delete form.dataset.dirty;
      if (content.logo_url) {
        document.querySelectorAll('.brand-logo-img').forEach(img => { img.src = content.logo_url; img.dataset.customLogo = 'true'; });
        let iconLink = document.querySelector("link[rel*='icon']");
        if (iconLink) iconLink.href = content.logo_url;
      }
      await load();
      UI.toast('Conteúdo publicado com sucesso no site e na aba!');
    } catch (error) { form.querySelector('[data-site-message]').textContent = error.message; }
    finally { busy = false; button.disabled = false; }
  };

  function openLogoModal() {
    const currentLogo = data?.site?.logo_url || '';
    const body = `
      <div style="display:flex;flex-direction:column;gap:16px;">
        <p class="nx-muted" style="margin:0;font-size:13.5px;line-height:1.5;">Altere a logo da sua marca. Ela será aplicada em tempo real no cabeçalho do site, no painel, no checkout e como ícone da aba do navegador (favicon).</p>
        <div style="text-align:center;padding:18px;background:rgba(255,255,255,0.04);border-radius:12px;border:1px solid rgba(255,255,255,0.08);">
          <small style="display:block;margin-bottom:8px;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Logo atual em uso:</small>
          <img class="brand-logo-preview" src="${e(currentLogo || 'logo-nexora-purple.svg')}" alt="Preview da Logo" style="max-height:46px;max-width:240px;object-fit:contain;background:#ffffff;border-radius:8px;padding:4px 8px;">
        </div>
        <label class="nx-field">
          Enviar arquivo do computador
          <input type="file" data-modal-logo-file accept="image/png,image/jpeg,image/webp,image/svg+xml">
          <small>Formatos aceitos: PNG, JPG, SVG ou WebP (máx. 5 MB). Recomendado com fundo branco ou transparente.</small>
        </label>
        <label class="nx-field">
          Ou informe a URL direta da imagem (HTTPS)
          <input name="modal_logo_url" type="url" value="${e(currentLogo)}" placeholder="https://seusite.com/logo.png">
        </label>
        <div style="display:flex;gap:10px;align-items:center;margin-top:4px;">
          <button type="button" class="button outline compact" data-modal-reset-logo style="font-size:12.5px;">Restaurar Logo Padrão Oficial (Fundo Branco)</button>
        </div>
        <p data-modal-logo-status style="margin:0;font-size:13px;color:#a78bfa;font-weight:600;"></p>
      </div>
    `;
    UI.modal('Alterar Logo & Ícone da Aba (Favicon)', body, async modal => {
      const status = modal.querySelector('[data-modal-logo-status]');
      const fileInput = modal.querySelector('[data-modal-logo-file]');
      const resetBtn = modal.querySelector('[data-modal-reset-logo]');
      
      if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
          try {
            resetBtn.disabled = true;
            status.textContent = 'Restaurando logo padrão oficial…';
            await API.rpc('nexora_admin_save_site', { p_content: { logo_url: '' } });
            document.querySelectorAll('.brand-logo-img').forEach(img => {
              img.src = 'logo-nexora-purple.svg';
              delete img.dataset.customLogo;
              img.style.backgroundColor = '#ffffff';
            });
            let iconLink = document.querySelector("link[rel*='icon']");
            if (iconLink) iconLink.href = 'favicon.png';
            UI.toast('Logo oficial e favicon restaurados com sucesso!');
            modal.closest('.nx-dialog')?.remove();
            await load();
          } catch (err) {
            status.textContent = 'Erro ao restaurar: ' + API.errorMessage(err);
            resetBtn.disabled = false;
          }
        });
      }

      let logoUrl = String(modal.querySelector('[name=modal_logo_url]').value || '').trim();
      if (fileInput?.files?.[0]) {
        const file = fileInput.files[0];
        if (file.size > 5 * 1024 * 1024) throw new Error('A imagem deve ter no máximo 5 MB.');
        status.textContent = 'Enviando imagem para o armazenamento seguro…';
        const ext = file.type === 'image/svg+xml' ? 'svg' : (file.type === 'image/png' ? 'png' : (file.type === 'image/webp' ? 'webp' : 'jpg'));
        const path = 'logo-' + crypto.randomUUID() + '.' + ext;
        const { error: uploadError } = await window.nexoraSupabase.storage.from('nexora-site').upload(path, file, { contentType: file.type, upsert: false });
        if (uploadError) throw uploadError;
        logoUrl = window.nexoraSupabase.storage.from('nexora-site').getPublicUrl(path).data.publicUrl;
      }
      if (!logoUrl) throw new Error('Informe uma URL HTTPS ou envie um arquivo de imagem.');
      if (!logoUrl.startsWith('https://')) throw new Error('A URL da logo deve começar com https://');
      status.textContent = 'Publicando nas configurações…';
      await API.rpc('nexora_admin_save_site', { p_content: { logo_url: logoUrl } });
      document.querySelectorAll('.brand-logo-img').forEach(img => {
        img.src = logoUrl;
        img.dataset.customLogo = 'true';
        img.style.backgroundColor = '#ffffff';
      });
      let iconLink = document.querySelector("link[rel*='icon']");
      if (!iconLink) {
        iconLink = document.createElement('link');
        iconLink.rel = 'icon';
        document.head.appendChild(iconLink);
      }
      iconLink.href = logoUrl;
      await load();
      UI.toast('Logo e ícone da aba atualizados com sucesso!');
    }, { submitLabel: 'Salvar e Publicar' });
  }

  document.addEventListener('click', event => {
    const btn = event.target.closest('[data-admin-open-logo-modal]');
    if (btn) {
      event.preventDefault();
      openLogoModal();
    }
  });

  function switchCustodyTab(tabName) {
    const valid = ['holds', 'reserves', 'reconciliation'].includes(tabName) ? tabName : 'holds';
    document.querySelectorAll('[data-custody-tab]').forEach(btn => {
      const isActive = btn.dataset.custodyTab === valid;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.querySelectorAll('[data-custody-panel]').forEach(panel => {
      const isActive = panel.dataset.custodyPanel === valid;
      panel.classList.toggle('is-active', isActive);
      if (isActive) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
    if (valid === 'holds') {
      loadAdminFundHolds();
      renderActiveCautions();
    } else if (valid === 'reserves') {
      loadMaturedReserves();
    } else if (valid === 'reconciliation') {
      loadLedgerBalances();
      loadReconciliationRuns();
    }
  }
  window.nexoraSwitchCustodyTab = switchCustodyTab;

  async function loadLedgerBalances() {
    const target = document.querySelector('[data-ledger-balances-table]');
    if (!target) return;
    target.setAttribute('aria-busy', 'true');
    try {
      const balances = await API.rpc('nexora_admin_list_merchant_balances');
      const rows = (Array.isArray(balances) ? balances : []).map(row => {
        const available = Number(row.available_cents || 0) / 100;
        const pending = Number(row.pending_cents || 0) / 100;
        const reserved = Number(row.reserved_cents || 0) / 100;
        const blocked = Number(row.blocked_cents || 0) / 100;
        const hasPending = pending > 0;
        const action = hasPending
          ? '<button class="button button-primary compact" type="button" data-settle-pending="' + e(row.business_id) + '" data-pending-cents="' + Number(row.pending_cents) + '" data-business-name="' + e(row.business_name) + '">Liberar R$ ' + e(pending.toLocaleString('pt-BR', {minimumFractionDigits:2})) + '</button>'
          : '<span class="nx-status paid">100% Liberado</span>';

        return '<tr>' +
          '<td><strong>' + e(row.business_name || 'Lojista') + '</strong><br><small>' + e(row.owner_email || '') + '</small></td>' +
          '<td><strong style="color:var(--nx-accent, #7c3aed); font-size:1.05rem;">' + C.money(available) + '</strong><br><small class="nx-muted">Livre para saque Pix</small></td>' +
          '<td>' + (hasPending ? '<strong style="color:#d97706; font-size:1.05rem;">' + C.money(pending) + '</strong>' : '<span class="nx-muted">R$ 0,00</span>') + '</td>' +
          '<td><small>Reserva: ' + C.money(reserved) + '<br>Bloqueado: ' + C.money(blocked) + '</small></td>' +
          '<td>' + action + '</td>' +
          '</tr>';
      }).join('');

      target.innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr>' +
        '<th scope="col">Empresa / Lojista</th>' +
        '<th scope="col">Saldo Disponível (Sacável)</th>' +
        '<th scope="col">Saldo Pendente</th>' +
        '<th scope="col">Reservas & Bloqueios</th>' +
        '<th scope="col">Ação</th>' +
        '</tr></thead><tbody>' +
        (rows || '<tr><td colspan="5">Nenhuma empresa encontrada com contas no ledger.</td></tr>') +
        '</tbody></table></div>';
    } catch (error) {
      target.innerHTML = '<p class="nx-muted">Não foi possível carregar os saldos: ' + e(API.errorMessage(error)) + '</p>';
    } finally {
      target.setAttribute('aria-busy', 'false');
    }
  }

  function settlePendingMerchantFunds(businessId, businessName, pendingCents) {
    const amountFormatted = (pendingCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    UI.confirm('Liberar saldo para a empresa?', 'Deseja transferir ' + amountFormatted + ' de saldo pendente diretamente para o saldo disponível de "' + businessName + '"? O lojista poderá solicitar o saque imediatamente.', async () => {
      try {
        await API.rpc('nexora_admin_release_pending_balance', {
          p_business_id: businessId,
          p_amount_cents: pendingCents,
          p_reason: 'Liberação manual de saldo pelo Super Admin'
        });
        UI.toast('Saldo liberado com sucesso para a empresa ' + businessName + '!');
        await loadLedgerBalances();
      } catch (error) {
        UI.toast('Erro ao liberar saldo: ' + API.errorMessage(error));
      }
    }, 'Liberar Saldo');
  }

  function exportMembersPdf() {
    const printArea = document.getElementById('nx-print-report');
    if (!printArea) return;
    const accounts = (data && data.accounts) || [];
    const stats = (data && data.stats) || {};
    const rows = accounts.map((acc, index) => {
      const conn = (connections || []).find(c => c.owner_id === acc.user_id);
      const acq = conn ? (acquirers || []).find(a => a.id === conn.acquirer_id) : null;
      const statusLabel = acc.status === 'active' ? 'Ativo' : 'Suspenso';
      return '<tr>' +
        '<td>' + (index + 1) + '</td>' +
        '<td><strong>' + e(acc.full_name) + '</strong><br>' + e(acc.email) + '</td>' +
        '<td>' + e(acc.workspaces?.[0]?.name || 'Padrão') + '</td>' +
        '<td>' + e(acq?.name || 'Sem adquirente') + '</td>' +
        '<td>' + statusLabel + '</td>' +
        '<td>' + e(C.date(acc.created_at)) + '</td>' +
        '</tr>';
    }).join('');

    printArea.innerHTML = '<div class="nx-print-header">' +
      '<div><h1>Nexora Pay · Relatório de Membros e Clientes</h1><p>Plataforma de Subadquirência e Infraestrutura Financeira</p></div>' +
      '<div class="nx-print-meta"><p>Gerado em: <strong>' + new Date().toLocaleString('pt-BR') + '</strong></p><p>Total de Contas: <strong>' + accounts.length + '</strong></p></div>' +
      '</div>' +
      '<div class="nx-print-stats">' +
      '<div class="nx-print-stat-item"><strong>' + (stats.accounts || accounts.length) + '</strong><span>Total Contas</span></div>' +
      '<div class="nx-print-stat-item"><strong>' + (stats.active_accounts || '—') + '</strong><span>Contas Ativas</span></div>' +
      '<div class="nx-print-stat-item"><strong>' + (stats.workspaces || '—') + '</strong><span>Workspaces</span></div>' +
      '</div>' +
      '<table class="nx-print-table"><thead><tr><th>#</th><th>Cliente / E-mail</th><th>Workspace</th><th>Adquirente</th><th>Status</th><th>Data Cadastro</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6">Nenhum membro cadastrado.</td></tr>') +
      '</tbody></table>' +
      '<div class="nx-print-footer"><p>Documento confidencial gerado pelo Super Administrador da Nexora Pay. Uso interno e de auditoria.</p></div>';

    window.print();
  }

  function exportTransactionsPdf() {
    const printArea = document.getElementById('nx-print-report');
    if (!printArea) return;
    const withdrawals = (data && data.withdrawals) || [];
    const totalAmount = withdrawals.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    const rows = withdrawals.map((tx, index) => {
      return '<tr>' +
        '<td>' + (index + 1) + '</td>' +
        '<td><strong>' + e(tx.business_name || 'Lojista') + '</strong><br>' + e(tx.email || '') + '</td>' +
        '<td>' + e(tx.destination || '—') + '</td>' +
        '<td>' + C.money(tx.amount || 0) + '</td>' +
        '<td>' + e(tx.status || 'PENDENTE') + '</td>' +
        '<td>' + e(C.date(tx.created_at)) + '</td>' +
        '<td>' + e(tx.provider_reference || '—') + '</td>' +
        '</tr>';
    }).join('');

    printArea.innerHTML = '<div class="nx-print-header">' +
      '<div><h1>Nexora Pay · Relatório de Transações e Liquidações</h1><p>Histórico executivo de liquidações Pix e saques da plataforma</p></div>' +
      '<div class="nx-print-meta"><p>Gerado em: <strong>' + new Date().toLocaleString('pt-BR') + '</strong></p><p>Total de Registros: <strong>' + withdrawals.length + '</strong></p></div>' +
      '</div>' +
      '<div class="nx-print-stats">' +
      '<div class="nx-print-stat-item"><strong>' + withdrawals.length + '</strong><span>Solicitações</span></div>' +
      '<div class="nx-print-stat-item"><strong>' + C.money(totalAmount) + '</strong><span>Volume Total</span></div>' +
      '</div>' +
      '<table class="nx-print-table"><thead><tr><th>#</th><th>Lojista / Conta</th><th>Destino Pix</th><th>Valor</th><th>Status</th><th>Data</th><th>Referência</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7">Nenhuma transação registrada.</td></tr>') +
      '</tbody></table>' +
      '<div class="nx-print-footer"><p>Documento confidencial gerado pelo Super Administrador da Nexora Pay. Uso interno e de auditoria.</p></div>';

    window.print();
  }

  (async () => {
    try {
      if (!window.nexoraSupabase) throw new Error('Supabase não configurado.');
      const {data:{session},error} = await window.nexoraSupabase.auth.getSession(); if (error) throw error;
      if (!session) return location.replace('auth.html');
      const { data: factors, error: factorsError } = await window.nexoraSupabase.auth.mfa.listFactors(); if (factorsError) throw factorsError;
      if (!(factors?.totp || []).some(factor => factor.status === 'verified')) return location.replace('auth.html?mode=enroll-mfa');
      const { data: assurance, error: assuranceError } = await window.nexoraSupabase.auth.mfa.getAuthenticatorAssuranceLevel(); if (assuranceError) throw assuranceError;
      if (assurance?.currentLevel !== 'aal2') return location.replace('auth.html?mode=verify-mfa');
      if (await API.rpc('is_nexora_super_admin') !== true) throw new Error('Acesso restrito ao responsável da Nexora Pay.');
      await load();
      setInterval(() => {
        if (document.hidden || document.querySelector('dialog[open]')) return;
        loadOperations();
        if (document.querySelector('#admin-webhooks.is-active')) loadAdminWebhooks();
        if (document.querySelector('#admin-custody.is-active')) {
          const activeTab = document.querySelector('[data-custody-tab].is-active')?.dataset.custodyTab;
          if (activeTab === 'holds') { loadAdminFundHolds(); renderActiveCautions(); }
          else if (activeTab === 'reserves') loadMaturedReserves();
          else if (activeTab === 'reconciliation') { loadLedgerBalances(); loadReconciliationRuns(); }
        }
        if (document.querySelector('#admin-reconciliation.is-active')) loadReconciliationRuns();
        if (document.querySelector('#admin-reserves.is-active')) loadMaturedReserves();
        if (document.querySelector('#admin-withdrawals.is-active')) loadAdminPayouts();
        if (document.querySelector('#admin-fund-holds.is-active')) loadAdminFundHolds();
      }, 45000);
    } catch (error) { say(API.errorMessage(error)); }
  })();
})();

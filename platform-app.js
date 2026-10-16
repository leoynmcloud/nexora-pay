(function () {
  'use strict';
  const C = window.NexoraCore, UI = window.NexoraUI, API = window.NexoraAPI;
  const main = document.querySelector('.app-main');
  if (!main || !C || !UI || !API) return;
  const routes = { resumo: 'Visão geral', transacoes: 'Transações', recebimentos: 'Recebimentos', extrato: 'Extrato', saques: 'Saques', clientes: 'Clientes', integracoes: 'Integrações', webhooks: 'Webhooks', configuracoes: 'Configurações', conta: 'Minha conta', ajuda: 'Ajuda' };
  let state = null, loading = false, payoutLoading = false, loadedUser = null, loadError = '', timer, integrationSetup = null, providerCatalog = null, transactionView = 'charges', filter = { query: '', status: '', from: '', to: '', environment: '' };
  let statementGeneration = 0;
  const statement = { rows: [], cursor: null, hasMore: false, loading: false, loaded: false, error: '', businessId: null };
  function resetStatement() {
    statementGeneration++;
    Object.assign(statement, { rows: [], cursor: null, hasMore: false, loading: false, loaded: false, error: '', businessId: null });
  }
  const e = C.escape, money = C.money;
  const chartDays = range => window.NexoraLedgerBalanceHistory?.daysForRange(range) || 180;
  const name = () => state?.settings.profile_name || window.nexoraSessionUser?.user_metadata?.full_name || window.nexoraSessionUser?.email?.split('@')[0] || 'Sua conta';
  const canOperate = () => window.nexoraAccess?.can_operate === true || window.nexoraAccess?.onboarding_status === 'APPROVED' || window.nexoraAccess?.is_nexora_admin === true;
  const kycBanner = () => {
    if (canOperate()) return '';
    const status = window.nexoraAccess?.onboarding_status || 'DRAFT';
    const submitted = ['SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW'].includes(status);
    return `<div class="nx-banner kyc-gate-banner" role="status"><b>${submitted ? 'Cadastro enviado · aguardando análise' : 'Complete o cadastro'}</b><a class="button button-primary compact" href="onboarding.html">${submitted ? 'Acompanhar cadastro' : 'Complete o cadastro'}</a></div>`;
  };
  const requireKyc = () => { if (canOperate()) return true; UI.toast('Complete o cadastro.'); return false; };
  const sandboxMode = () => state?.provider?.environment === 'sandbox';
  const paymentsReady = () => canOperate() && state?.provider?.adapter_ready === true
    && ['sandbox', 'production'].includes(state.provider.environment) && state.provider.status === 'active'
    && state.provider.api_key_configured === true && state.provider.payments_enabled === true;
  const paymentReadinessMessage = () => {
    const provider = state?.provider;
    if (!canOperate()) return 'Complete o cadastro e aguarde a aprovação para habilitar recebimentos.';
    if (!provider) return 'A conexão de pagamentos da sua conta ainda está sendo configurada pela Nexora.';
    if (!provider.adapter_ready) return 'Este meio de pagamento ainda não está disponível para sua conta.';
    if (provider.status !== 'active') return 'A conexão de pagamentos ainda não foi habilitada para sua conta.';
    if (provider.api_key_configured !== true) return 'A conexão de pagamentos ainda está sendo configurada. Tente novamente mais tarde.';
    if (provider.payments_enabled !== true) return 'Os recebimentos estão temporariamente indisponíveis. Fale com o suporte.';
    if (!['sandbox', 'production'].includes(provider.environment)) return 'A configuração de pagamentos está pendente. Fale com o suporte.';
    return 'O recebimento está temporariamente indisponível. Atualize a página ou contate o suporte.';
  };
  const route = () => {
    const key = location.hash.slice(1);
    if (key === 'recebimentos') { transactionView = 'receipts'; return 'transacoes'; }
    if (key === 'transacoes') transactionView = 'charges';
    return routes[key] ? key : 'resumo';
  };
  const field = (label, input) => `<label class="nx-field">${label}${input}</label>`;
  const status = (item) => `<span class="nx-status ${e(item.status)}">${e(C.status(item.status))}</span>`;
  const payoutStatus = (item) => `<span class="nx-status ${e(String(item.status || '').toLowerCase())}">${e(C.payoutStatus(item.status))}</span>`;
  const source = (item) => item.test_mode ? 'Ambiente de testes' : ({ gateway: 'Nexora Pay', legacy: 'Registro anterior' }[item.source] || 'Nexora Pay');
  async function invokeProviderPayment(body) {
    const providerCode = body.provider_code || state?.provider?.code;
    if (!providerCode) throw new Error('Nenhum adaptador de pagamento foi atribuído a esta conta.');
    const { data, error } = await window.nexoraSupabase.functions.invoke('nexora-payments', { body: { ...body, provider_code: providerCode } });
    if (error) {
      let payload = {};
      try { payload = await error.context?.clone?.().json() || {}; } catch (_) {}
      throw Object.assign(new Error(payload.error || API.errorMessage(error)), {
        verificationRequired: payload.verification_required === true,
        transactionId: payload.transaction_id || '',
      });
    }
    if (data?.error) {
      const failure = Object.assign(new Error(data.error), {
        verificationRequired: data.verification_required === true,
        transactionId: data.transaction_id || '',
      });
      throw failure;
    }
    return data;
  }
  async function loadProviderCatalog() {
    if (providerCatalog && providerCatalog.length) return providerCatalog;
    try {
      const cached = JSON.parse(sessionStorage.getItem('nexora_provider_catalog_v2') || 'null');
      if (cached && Array.isArray(cached.providers) && cached.providers.length && (Date.now() - (cached.ts || 0) < 600000)) {
        providerCatalog = cached.providers;
        return providerCatalog;
      }
    } catch (_) {}
    const { data, error } = await window.nexoraSupabase.functions.invoke('nexora-payments', { body: { action: 'catalog' } });
    if (error) return [];
    providerCatalog = Array.isArray(data?.providers) ? data.providers : [];
    if (providerCatalog.length) {
      try { sessionStorage.setItem('nexora_provider_catalog_v2', JSON.stringify({ providers: providerCatalog, ts: Date.now() })); } catch (_) {}
    }
    return providerCatalog;
  }
  function paymentDetailsMarkup(item) {
    const isPaid = item.status === 'paid' || item.status === 'succeeded' || String(item.provider_status || '').toUpperCase() === 'RECEIVED' || String(item.provider_status || '').toUpperCase() === 'CONFIRMED';
    const methodStr = String(item.payment_method || item.method || item.payment?.method || item.payment_type_id || item.payment_type || item.billing_type || '').toLowerCase();
    const isCardPayment = methodStr === 'credit_card' || methodStr === 'card' || methodStr === 'creditcard'
      || Boolean(item.card_brand || item.card_last_digits || item.card_token)
      || ['visa', 'master', 'mastercard', 'amex', 'elo', 'hipercard', 'diners', 'cabal'].includes(String(item.payment_method_id || '').toLowerCase());
    const image = !isPaid && !isCardPayment && typeof item.pix_encoded_image === 'string' && /^[A-Za-z0-9+/]+=*$/.test(item.pix_encoded_image)
      ? `<img class="provider-pix-qr" src="data:image/png;base64,${item.pix_encoded_image}" alt="QR Code Pix da cobrança">` : '';
    const details = [
      ['Status do pagamento', item.provider_status || C.status(item.status)],
      ['Método', isCardPayment ? 'Cartão de crédito' : 'Pix'],
      ['Referência interna', item.transaction_id],
      ['Referência do provedor', item.provider_reference],
      isPaid ? ['Status financeiro', 'Pagamento aprovado e creditado'] : null,
      isPaid ? ['Disponibilidade para saque', 'Liberado conforme liquidação'] : (isCardPayment ? null : ['Validade do Pix', item.pix_expiration ? C.date(item.pix_expiration) : 'Consulte a cobrança']),
    ].filter(Boolean).filter(([,value]) => value).map(([label,value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join('');
    const banner = isPaid
      ? `<p class="nx-banner"><b>${item.test_mode ? 'Cobrança de teste confirmada' : 'Pagamento confirmado'}</b><span>${item.test_mode ? 'Confirmação registrada em ambiente de testes; sem impacto financeiro real.' : 'O pagamento foi confirmado com sucesso e o valor lançado na sua conta.'}</span></p>`
      : `<p class="nx-banner"><b>${item.test_mode ? 'Cobrança de teste' : (isCardPayment ? 'Cobrança Cartão de Crédito' : 'Cobrança Pix')}</b><span>${item.test_mode ? 'Cobrança de teste, sem movimentação real.' : (isCardPayment ? 'Cobrança processada via Cartão de crédito. Acompanhe a aprovação em tempo real.' : 'Envie o QR Code, o Pix copia e cola ou o link de pagamento ao pagador. O recebimento será creditado nesta conta.')}</span></p>`;
    const actionMarkup = isPaid
      ? ''
      : `${(!isCardPayment && image) ? `<div class="provider-pix-qr-wrap">${image}</div>` : (!isCardPayment ? '<p class="nx-muted">QR Code ainda não disponível. Use Atualizar status em instantes.</p>' : '')}${(!isCardPayment && item.pix_copy_paste) ? `<label class="nx-field">Pix copia e cola<textarea data-pix-copy readonly rows="4">${e(item.pix_copy_paste)}</textarea></label><button type="button" class="button outline" data-copy-pix>Copiar código Pix</button>` : ''}${item.invoice_url ? `<p><a class="button outline" href="${e(item.invoice_url)}" target="_blank" rel="noopener noreferrer">Abrir link de pagamento ↗</a> <button type="button" class="button outline" data-copy-invoice="${e(item.invoice_url)}">Copiar link para enviar ao cliente</button></p>` : ''}`;
    return `${banner}${actionMarkup}<dl class="nx-details">${details}</dl><button type="button" class="button outline" data-refresh-provider-payment="${e(item.transaction_id || '')}" data-method="${isCardPayment ? 'credit_card' : 'pix'}">Atualizar status</button>`;
  }
  function bindPaymentDetails(dialog) {
    const copy = dialog.querySelector('[data-copy-pix]');
    if (copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(dialog.querySelector('[data-pix-copy]').value); UI.toast('Código Pix copiado.'); }
      catch (_) { dialog.querySelector('[data-pix-copy]').select(); UI.toast('Selecione e copie o código Pix.'); }
    };
    const copyInvoice = dialog.querySelector('[data-copy-invoice]');
    if (copyInvoice) copyInvoice.onclick = async () => {
      try { await navigator.clipboard.writeText(copyInvoice.dataset.copyInvoice); UI.toast('Link de pagamento copiado para enviar ao seu cliente.'); }
      catch (_) { UI.toast('Não foi possível copiar automaticamente. Abra o link e copie-o pela barra do navegador.'); }
    };
    const refreshButton = dialog.querySelector('[data-refresh-provider-payment]');
    if (refreshButton) refreshButton.onclick = async () => {
      refreshButton.disabled = true;
      try {
        const methodHint = refreshButton.dataset.method || '';
        const result = await invokeProviderPayment({ action: 'refresh', transaction_id: refreshButton.dataset.refreshProviderPayment });
        if (dialog.isConnected) { dialog.querySelector('.nx-dialog-body').innerHTML = paymentDetailsMarkup({ ...result, payment_method: methodHint || result.payment_method }); bindPaymentDetails(dialog); }
        await refresh({ silent: true });
      } catch (error) { UI.toast(error.message); }
      finally { if (refreshButton.isConnected) refreshButton.disabled = false; }
    };
  }
  async function createHostedCheckoutLink(payload) {
    const { data, error } = await window.nexoraSupabase.functions.invoke('nexora-checkout', {
      body: { action: 'create_link', business_id: state.business_id,
        acquirer_id: state.provider.acquirer_id, ...payload },
    });
    if (error) {
      let details = {};
      try { details = await error.context?.clone?.().json() || {}; } catch (_) {}
      throw new Error(details.error || API.errorMessage(error));
    }
    if (!data || data.error || !data.checkout_url) throw new Error(data?.error || 'Não foi possível criar o link.');
    return data;
  }
  function bindHostedLink(dialog) {
    const copy = dialog.querySelector('[data-copy-checkout-link]');
    if (copy) copy.onclick = async () => {
      const input = dialog.querySelector('[data-checkout-link-url]');
      try { await navigator.clipboard.writeText(input.value); UI.toast('Link de pagamento copiado.'); }
      catch (_) { input.focus(); input.select(); UI.toast('Link selecionado. Copie para compartilhar.'); }
    };
    const input = dialog.querySelector('[data-checkout-link-url]');
    if (input) { input.focus(); input.select(); }
  }
  function newHostedLink() {
    const methods = state?.provider?.payment_methods || state?.provider?.adapter_methods || ['pix'];
    const hasCard = methods.includes('credit_card') || methods.includes('card');
    const methodsMarkup = `<p class="nx-muted">Formas de pagamento aceitas pelo link: <strong>${hasCard ? 'Pix e Cartão de crédito' : 'Pix'}</strong>.</p>`;

    const dialog = UI.modal('Criar link de cobrança',
      `${field('Valor da cobrança', '<div class="currency-input"><span>R$</span><input name="amount" data-currency inputmode="numeric" autocomplete="off" value="50,00" placeholder="0,00" required></div>')}${field('Descrição do produto ou serviço', '<input name="description" maxlength="120" placeholder="Ex: Consultoria, Pedido #123, Mensalidade..." required>')}${methodsMarkup}${field('Referência ou nº do pedido (opcional)', '<input name="reference" maxlength="60" placeholder="Ex: PED-2026-001 (para sua organização)">')}`,
      async modal => {
        const form = new FormData(modal.querySelector('form'));
        const desc = String(form.get('description') || '').trim();
        const ref = String(form.get('reference') || '').trim();
        const finalDescription = ref ? `${desc} (${ref})` : desc;
        const result = await createHostedCheckoutLink({
          amount_cents: Math.round(C.parseMoney(form.get('amount')) * 100),
          description: finalDescription,
        });
        modal.querySelector('.nx-dialog-body').innerHTML = `<p class="nx-banner" role="status"><b>Link de pagamento criado</b><span>Compartilhe com seu cliente para pagamento imediato via ${hasCard ? 'Pix ou Cartão de crédito' : 'Pix'}.</span></p><label class="nx-field">Link de pagamento<input data-checkout-link-url aria-label="Link de pagamento criado" readonly value="${e(result.checkout_url)}"></label><p class="nx-muted">Expira em ${e(C.date(result.expires_at))}. Copie antes de fechar: por segurança, o token completo não fica armazenado.</p><button type="button" class="button outline" data-copy-checkout-link>Copiar link de pagamento</button>`;
        modal.querySelector('[type="submit"]').hidden = true;
        modal.querySelector('.nx-cancel').textContent = 'Concluir';
        bindHostedLink(modal);
        return false;
      }, { submitLabel: 'Gerar link de pagamento' });
    return dialog;
  }
  function showView(label) {
    const key = Object.keys(routes).find((item) => routes[item] === label) || label;
    if (!routes[key]) return;
    if (key === 'recebimentos') transactionView = 'receipts';
    else if (key === 'transacoes') transactionView = 'charges';
    if (location.hash !== `#${key}`) location.hash = key; else render();
  }
  function shell(title, description, body, actions = '') {
    return `<header class="app-header"><div><span class="eyebrow purple">NEXORA PAY · SUA OPERAÇÃO</span><h1>${e(title)}</h1><p class="view-intro">${e(description)}</p></div><div class="header-actions">${actions || '<button class="button outline compact" data-action="resumo">Voltar ao resumo</button>'}</div></header>${kycBanner()}${body}`;
  }
  function syncShell() {
    const profile = document.querySelector('.profile');
    if (profile) {
      profile.querySelector('i').textContent = name().slice(0, 2).toUpperCase();
      profile.querySelector('span b').textContent = name(); profile.querySelector('span small').textContent = 'Conta principal';
    }
    const workspace = document.querySelector('.workspace strong');
    if (workspace) { workspace.textContent = state?.business_name || window.nexoraAccess?.business_name || 'Minha operação'; const icon = document.createElement('b'); icon.dataset.nxIcon = 'chevron'; icon.setAttribute('aria-hidden', 'true'); workspace.append(icon); }
    document.querySelectorAll('.side-nav a[data-route]').forEach((link) => {
      const key = link.dataset.route;
      const currentRoute = route();
      link.href = `#${key}`; link.classList.toggle('active', key === currentRoute); link.title = routes[key]; link.setAttribute('aria-label', routes[key]);
      if (key === currentRoute) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    window.NexoraIcons?.render(document);
    window.NexoraTheme?.update();
  }
  function render() {
    syncShell();
    if (!state && loadError) { main.innerHTML = shell('Não foi possível carregar sua conta', 'Seus dados não foram alterados.', `<div class="nx-empty"><p>${e(loadError)}</p><button class="button button-primary" data-action="refresh">Tentar novamente</button></div>`); return; }
    if (!state) { main.innerHTML = shell('Carregando sua conta', 'Buscando seus registros no Supabase.', '<div class="nx-empty">Aguarde…</div>'); return; }
    if (route() === 'resumo') overview();
    else if (route() === 'transacoes') transactions();
    else if (route() === 'extrato') renderStatement();
    else if (route() === 'saques') renderPayoutHistory();
    else if (route() === 'clientes') customers();
    else if (route() === 'webhooks') webhooks();
    else if (route() === 'configuracoes') settings();
    else if (route() === 'conta') account();
    else if (route() === 'integracoes') integrations(); else help();
    if (route() === 'resumo' && !canOperate()) main.insertAdjacentHTML('afterbegin', kycBanner());
    window.NexoraIcons?.render(main);
    window.NexoraTheme?.update();
  }
  async function refresh({ silent = false } = {}) {
    if (loading || !window.nexoraSessionUser) return false;
    loading = true;
    try {
      const user = window.nexoraSessionUser.id;
      if (loadedUser && loadedUser !== user) resetStatement();

      // Cache imediato em sessão para eliminar delay perceptível (0ms)
      if (!state) {
        try {
          const cachedRaw = sessionStorage.getItem(`nexora_cached_state_${user}`);
          if (cachedRaw) {
            const cachedState = JSON.parse(cachedRaw);
            if (cachedState && cachedState.business_id) {
              state = cachedState;
              loadedUser = user;
              render();
            }
          }
        } catch (_) {}
        if (!state) render();
      }

      const data = await API.snapshot();
      if (user !== window.nexoraSessionUser?.id) return false;
      if (data.onboarding_status) window.nexoraAccess = { ...window.nexoraAccess, onboarding_status: data.onboarding_status, can_operate: data.can_operate === true || window.nexoraAccess?.is_nexora_admin === true };

      if (user !== window.nexoraSessionUser?.id) return false;
      const allowed = canOperate() && data.can_operate !== false;

      // Dispara todas as consultas secundárias em PARALELO simultâneo
      const catalogPromise = data.provider ? loadProviderCatalog().catch(() => []) : Promise.resolve([]);
      let balancesPromise = Promise.resolve(null);
      let historyPromise = Promise.resolve(null);
      let payoutPromise = Promise.resolve(null);
      let readinessPromise = Promise.resolve(null);

      if (allowed && data.business_id) {
        balancesPromise = API.rpc('nexora_ledger_merchant_balances', { p_business_id: data.business_id }).catch(() => null);
        historyPromise = API.rpc('nexora_ledger_merchant_balance_history', {
          p_business_id: data.business_id, p_days: chartDays(data.settings?.chart_range || 'Últimos 6 meses'),
        }).catch(() => null);
        payoutPromise = window.nexoraSupabase.functions.invoke('nexora-payout-merchant', { body: { business_id: data.business_id } })
          .then(({ data: d, error: err }) => err ? null : d).catch(() => null);
      }
      if (data.business_id) {
        readinessPromise = window.nexoraSupabase.functions.invoke('nexora-payout-readiness', { body: { business_id: data.business_id } })
          .then(({ data: d, error: err }) => err ? null : d).catch(() => null);
      }

      // Renderização progressiva imediata dos dados do snapshot caso ainda não tenhamos estado
      if (!state) {
        state = {
          ...data,
          can_operate: allowed,
          settings: data.settings || {},
          provider: data.provider ? { ...data.provider, adapter_ready: true, adapter_methods: ['pix', 'credit_card'] } : null,
          ledger_balances: null,
          ledger_balance_history: null,
          payout_requests: [],
          payout_readiness: null,
          payout_history_available: false,
          payout_next_cursor: null,
          payout_has_more: false,
          transactions: allowed ? (data.transactions || []).filter((item) => item.source === 'gateway') : [],
          customers: allowed ? (data.customers || []) : []
        };
        render();
      }

      // Aguarda o conjunto de promessas paralelas
      const [catalog, ledgerBalances, ledgerBalanceHistory, payoutData, readinessData] = await Promise.all([
        catalogPromise,
        balancesPromise,
        historyPromise,
        payoutPromise,
        readinessPromise
      ]);

      if (user !== window.nexoraSessionUser?.id) return false;

      const payoutRequests = Array.isArray(payoutData?.payouts) ? payoutData.payouts : [];
      const payoutHistoryAvailable = payoutData !== null && !payoutData?.error;
      const payoutNextCursor = payoutData?.next_cursor || null;
      const payoutHasMore = payoutData?.has_more === true;
      const payoutReadiness = normalizePayoutReadiness(readinessData);

      const providerMethods = catalog.find(adapter => adapter.code === data.provider?.code)?.methods
        || (data.provider?.code?.startsWith('mercadopago') ? ['pix', 'credit_card'] : ['pix']);
      const isAdapterReady = !data.provider ? false : (
        catalog.length === 0
          ? true
          : catalog.some(adapter =>
              (adapter.code === data.provider.code || (data.provider.code && data.provider.code.startsWith(adapter.adapter)))
              && (adapter.implementation_status === 'implemented' || adapter.status === 'ready')
            )
      );

      state = { ...data, can_operate: allowed, settings: data.settings || {}, provider: data.provider ? {
        ...data.provider,
        adapter_ready: isAdapterReady,
        adapter_methods: providerMethods,
      } : null,
        ledger_balances: ledgerBalances,
        ledger_balance_history: ledgerBalanceHistory,
        payout_requests: payoutRequests,
        payout_readiness: payoutReadiness,
        payout_history_available: payoutHistoryAvailable,
        payout_next_cursor: payoutNextCursor,
        payout_has_more: payoutHasMore,
        transactions: allowed ? (data.transactions || []).filter((item) => item.source === 'gateway') : [],
        customers: allowed ? (data.customers || []) : [] };

      try {
        sessionStorage.setItem(`nexora_cached_state_${user}`, JSON.stringify(state));
      } catch (_) {}

      loadedUser = user; loadError = ''; render(); window.dispatchEvent(new CustomEvent('nexora-data-ready'));
      return true;
    } catch (error) {
      if (/suspens|sessão expirou|sem acesso/i.test(error.message)) { state = null; loadedUser = null; }
      if (!state) { loadError = error.message; render(); }
      else if (!silent) UI.toast(error.message);
      return false;
    } finally { loading = false; }
  }
  async function mutation(rpc, parameters, message) {
    if (!requireKyc()) throw new Error('Complete o cadastro.');
    if (!state || loadedUser !== window.nexoraSessionUser?.id) throw new Error('Aguarde o carregamento da sua conta.');
    await API.rpc(rpc, parameters);
    const updated = await refresh();
    UI.toast(updated ? message : 'Alteração confirmada no Supabase, mas não foi possível atualizar a tela. Clique em Atualizar para consultar os valores atuais.');
  }
  function overview() {
    const greeting = new Date().getHours() < 12 ? 'Bom dia' : new Date().getHours() < 18 ? 'Boa tarde' : 'Boa noite';
    if (state.ledger_balances || paymentsReady() || state.transactions.some(item => item.provider_adapter)) {
      const unread = state.settings.alerts !== false ? state.transactions.filter((item) => new Date(item.paid_at || item.created_at) > new Date(state.settings.notifications_read_at || 0)).length : 0;
      const rows = state.transactions.filter((item) => Boolean(item.test_mode) === sandboxMode());
      const paid = rows.filter((item) => item.status === 'paid');
      const paidTotal = paid.reduce((sum, item) => sum + C.cents(item.amount), 0) / 100;
      const availableBalance = state.ledger_balances && Number.isFinite(Number(state.ledger_balances.available))
        ? money(Number(state.ledger_balances.available)) : 'Indisponível';
      const pendingBalance = state.ledger_balances && Number.isFinite(Number(state.ledger_balances.pending))
        ? money(Number(state.ledger_balances.pending)) : 'Indisponível';
      const reservedBalance = state.ledger_balances && Number.isFinite(Number(state.ledger_balances.reserved))
        ? money(Number(state.ledger_balances.reserved)) : 'Indisponível';
      const blockedBalance = state.ledger_balances && Number.isFinite(Number(state.ledger_balances.blocked))
        ? money(Number(state.ledger_balances.blocked)) : 'Indisponível';
      const totalLedgerBalance = state.ledger_balances && [
        state.ledger_balances.available, state.ledger_balances.pending,
        state.ledger_balances.reserved, state.ledger_balances.blocked,
      ].every(value => Number.isFinite(Number(value)))
        ? money(['available', 'pending', 'reserved', 'blocked'].reduce((sum, bucket) => sum + Number(state.ledger_balances[bucket]), 0))
        : 'Indisponível';
      const chartRange = state.settings.chart_range || 'Últimos 6 meses';
      const payouts = Array.isArray(state.payout_requests) ? state.payout_requests : [];
      const payoutHistory = state.payout_history_available
        ? (payouts.length ? `<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Solicitado</th><th>Identificador</th><th>Valor</th><th>Status</th></tr></thead><tbody>${payouts.slice(0, 10).map(item => `<tr><td>${e(C.date(item.created_at))}</td><td><code>${e(item.payout_id)}</code></td><td>${e(money(Number(item.amount_cents) / 100))}</td><td>${payoutStatus(item)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="nx-empty">Você ainda não tem solicitações de saque.</p>')
        : '<p class="nx-muted" role="status">Não foi possível consultar o histórico de saques. Atualize a página ou contate o suporte; seus dados e saldo não foram alterados.</p>';
      main.innerHTML = `<header class="app-header"><div><span class="eyebrow purple">${e(new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }))}</span><h1>${e(greeting)}, ${e(name())}.</h1></div><div class="header-actions"><button class="icon-button" data-action="search" aria-label="Buscar cobrança"><span data-nx-icon="search"></span></button><button class="icon-button" data-action="notifications" aria-label="Notificações${unread ? `: ${unread} não lidas` : ''}"><span data-nx-icon="bell"></span>${unread ? '<i class="nx-unread"></i>' : ''}</button><button class="button button-primary compact" data-action="new-charge" ${paymentsReady() ? '' : 'disabled'}>+ Criar cobrança</button></div></header>
        <div class="nx-banner"><b>Recebimentos ${paymentsReady() ? 'ativos' : 'indisponíveis'}</b><span>${paymentsReady() ? 'Sua conta pode criar cobranças e acompanhar os pagamentos.' : e(paymentReadinessMessage())}</span></div>
      <section class="metric-grid ledger-balance-grid" aria-label="Resumo do saldo no ledger"><article class="metric-card"><span>Saldo total no ledger</span><strong>${totalLedgerBalance}</strong><small>Soma dos valores pendentes, disponíveis, reservados e bloqueados.</small></article><article class="metric-card main-metric"><span>Saldo disponível</span><strong>${availableBalance}</strong><small>Saldo liberado para saques via Pix.</small></article><article class="metric-card"><span>Aguardando liquidação</span><strong>${pendingBalance}</strong><small>Recebido pelo sistema; a liquidar.</small></article><article class="metric-card"><span>Reservado</span><strong>${reservedBalance}</strong><small>Comprometido com operações ou reserva.</small></article><article class="metric-card"><span>Bloqueado</span><strong>${blockedBalance}</strong><small>Indisponível por análise ou restrição operacional.</small></article><article class="metric-card"><span>Vendas confirmadas</span><strong>${paid.length}</strong><small>${money(paidTotal)} ${sandboxMode() ? '· valores de teste' : '· pagamentos confirmados'}</small></article></section>
        <section class="dashboard-grid"><article class="panel chart-panel"><div class="panel-head"><div><h2>Saldo total da conta</h2><p>Histórico diário calculado pelo ledger: disponível, pendente, reservado e bloqueado.</p></div><label>Período<select data-chart-range>${['Últimos 7 dias', 'Último mês', 'Últimos 6 meses', 'Este ano'].map((label) => `<option ${label === chartRange ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div><div data-chart></div></article><article class="panel recent"><div class="panel-head"><div><h2>Atividade recente</h2><p>Últimos pagamentos consultados</p></div><a href="#transacoes">Ver todas</a></div>${rows.slice(0,5).map((item) => `<button class="nx-activity" data-transaction="${e(item.id)}"><span><b>${e(item.title)}</b><small>${e(item.customer_name || 'Pagador')} · ${e(C.date(item.created_at))}</small></span><strong>${money(item.amount)}</strong>${status(item)}</button>`).join('') || '<p class="nx-empty">Ainda não há cobranças. Crie sua primeira cobrança.</p>'}</article></section>
      <section class="panel merchant-payout-panel" aria-labelledby="merchant-payout-title"><div class="panel-head"><div><h2 id="merchant-payout-title">Saques</h2><p>Solicite uma transferência do saldo disponível e acompanhe o histórico.</p></div><div><a class="button outline compact" href="#saques">Ver histórico completo</a> <button class="button button-primary" type="button" data-action="request-payout">Solicitar saque</button></div></div>${payoutReadinessBanner(state.payout_readiness)}${payoutHistory}</section>`;
      renderBalanceHistory(chartRange, state.ledger_balance_history);
      return;
    }
    const metrics = C.metrics(state.transactions);
    const increase = metrics.previous > 0 ? `${((metrics.received / metrics.previous - 1) * 100).toFixed(1).replace('.', ',')}% em relação ao mês anterior` : 'Sem base de comparação no mês anterior';
    const unread = state.settings.alerts !== false ? state.transactions.filter((item) => new Date(item.paid_at || item.created_at) > new Date(state.settings.notifications_read_at || 0)).length : 0;
    const chartRange = state.settings.chart_range || 'Últimos 6 meses';
    const live = canOperate();
    const activity = state.transactions.slice(0, 5);
    const unavailable = canOperate() ? 'R$ 0,00' : '<span class="nx-unavailable">Complete o cadastro</span>';
      main.innerHTML = `<header class="app-header"><div><span class="eyebrow purple">${e(new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }))}</span><h1>${e(greeting)}, ${e(name())}.</h1></div><div class="header-actions"><button class="icon-button" data-action="search" aria-label="Buscar transação" ${canOperate() ? '' : 'disabled title="Complete o cadastro"'}><span data-nx-icon="search"></span></button><button class="icon-button" data-action="notifications" aria-label="Notificações${unread ? `: ${unread} não lidas` : ''}"><span data-nx-icon="bell"></span>${unread ? '<i class="nx-unread"></i>' : ''}</button><button class="button button-primary compact" data-action="new-charge" ${canOperate() ? '' : 'disabled title="Complete o cadastro"'}>${!canOperate() ? 'Complete o cadastro' : '+ Nova cobrança'}</button></div></header>
      ${live ? '<div class="nx-banner"><b>Operação ativa</b><span>Sua conta está habilitada para gerar cobranças e receber pagamentos.</span></div>' : '<div class="nx-banner"><b>Ativação da conta</b><span>Complete o cadastro para liberar todas as funcionalidades.</span></div>'}
      <section class="metric-grid"><article class="metric-card main-metric"><span>Saldo disponível</span><strong>${money(state.balance ?? metrics.balance ?? 0)}</strong><small>${metrics.reserved ? `Reservado: ${money(metrics.reserved)}` : 'Disponível para transferências Pix'}</small><a href="#extrato">Ver extrato →</a></article><article class="metric-card"><span>Recebido neste mês</span><strong>${money(metrics.received ?? 0)}</strong><small>${e(increase)}</small></article><article class="metric-card"><span>Movimentações</span><strong>${metrics.transactions ?? 0}</strong><small>${metrics.pending ? `A receber: ${money(metrics.pending)}` : 'Transações confirmadas'}</small></article></section>
      <section class="dashboard-grid"><article class="panel chart-panel"><div class="panel-head"><div><h2>Pagamentos confirmados</h2><p>Total de pagamentos confirmados no período.</p></div>${live ? `<label>Período<select data-chart-range>${['Últimos 7 dias', 'Último mês', 'Últimos 6 meses', 'Este ano'].map((label) => `<option ${label === chartRange ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}</div><div data-chart>${live ? '' : '<p class="nx-empty">Nenhum pagamento registrado no período.</p>'}</div></article><article class="panel recent"><div class="panel-head"><div><h2>Atividade recente</h2><p>Últimas movimentações da sua conta</p></div><a href="#transacoes">Ver tudo</a></div>${activity.map((item) => `<button class="nx-activity" data-transaction="${e(item.id)}"><span><b>${e(item.title)}</b><small>${e(item.customer_name || 'Saque')} · ${e(C.date(item.created_at))}</small></span><strong class="${item.kind === 'withdrawal' ? 'negative' : ''}">${item.kind === 'withdrawal' ? '−' : '+'} ${money(item.amount)}</strong>${status(item)}</button>`).join('') || '<p class="nx-empty">Nenhuma movimentação realizada ainda.</p>'}</article></section>`;
    if (live) renderChart(chartRange);
  }
  function renderBalanceHistory(range, history) {
    const chart = main.querySelector('[data-chart]'); if (!chart) return;
    const rows = window.NexoraLedgerBalanceHistory?.normalize(history);
    if (!rows) {
      chart.innerHTML = '<p class="nx-empty" role="status">Histórico do ledger indisponível. Verifique a migração de histórico e atualize a página.</p>';
      return;
    }
    if (!rows.length) {
      chart.innerHTML = '<p class="nx-empty" role="status">Ainda não há histórico de saldo para este período.</p>';
      return;
    }
    const values = rows.map(row => row.total / 100);
    const min = Math.min(...values), max = Math.max(...values), span = Math.max(max - min, 1);
    const points = values.map((value, index) => `${rows.length === 1 ? 300 : index * 600 / (rows.length - 1)},${max === min ? 105 : 190 - (value - min) / span * 170}`).join(' ');
    const step = Math.max(1, Math.ceil(rows.length / 7));
    const labels = rows.filter((_, index) => index % step === 0 || index === rows.length - 1);
    const latest = rows[rows.length - 1];
    const details = rows.map(row => `<div><span>${e(new Date(`${row.day}T12:00:00`).toLocaleDateString('pt-BR'))}</span><b>Total ${money(row.total / 100)}</b><small>Disponível ${money(row.available / 100)} · Pendente ${money(row.pending / 100)} · Reservado ${money(row.reserved / 100)} · Bloqueado ${money(row.blocked / 100)}</small></div>`).join('');
    chart.innerHTML = `<div class="nx-chart-summary"><b>${money(latest.total / 100)}</b><small>Saldo total no ledger · atualizado até ${e(new Date(`${latest.day}T12:00:00`).toLocaleDateString('pt-BR'))}</small></div><svg class="nx-chart" viewBox="0 0 600 210" role="img" aria-label="Histórico do saldo total da conta nos ${e(range.toLocaleLowerCase('pt-BR'))}: ${e(money(latest.total / 100))}"><polyline points="${points}" fill="none" stroke="var(--purple)" stroke-width="3" vector-effect="non-scaling-stroke"/></svg><div class="nx-chart-labels">${labels.map(row => `<span>${e(new Date(`${row.day}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }))}</span>`).join('')}</div><details class="nx-chart-data"><summary>Ver composição diária</summary>${details}</details><p class="nx-muted">Total = disponível + pendente + reservado + bloqueado. Saldo disponível no ledger não significa saque liberado.</p>`;
  }
  function renderChart(range, transactions = state.transactions) {
    const buckets = C.chart(transactions, range), max = Math.max(...buckets.map((item) => item.amount), 1);
    const points = buckets.map((item, i) => `${buckets.length === 1 ? 300 : i * 600 / (buckets.length - 1)},${190 - item.amount / max * 170}`).join(' ');
    const total = buckets.reduce((sum, item) => sum + C.cents(item.amount), 0) / 100;
    const labels = buckets.filter((_, i) => buckets.length < 10 || i % 5 === 0 || i === buckets.length - 1);
    const chart = main.querySelector('[data-chart]'); if (!chart) return;
    chart.innerHTML = `<div class="nx-chart-summary"><b>${money(total)}</b><small>Total confirmado · escala até ${money(max)}</small></div><svg class="nx-chart" viewBox="0 0 600 210" role="img" aria-label="Pagamentos confirmados no período: ${e(money(total))}"><polygon points="0,210 ${points} 600,210" fill="var(--purple)" opacity=".12"/><polyline points="${points}" fill="none" stroke="var(--purple)" stroke-width="3" vector-effect="non-scaling-stroke"/></svg><div class="nx-chart-labels">${labels.map((item) => `<span>${e(item.label)}</span>`).join('')}</div>${total === 0 ? '<p class="nx-empty">Nenhum pagamento confirmado neste período.</p>' : ''}<details class="nx-chart-data"><summary>Ver valores do gráfico</summary>${buckets.map((item) => `<div>${e(item.label)} <b>${money(item.amount)}</b></div>`).join('')}</details>`;
  }
  const selectedRows = () => {
    const receiptsOnly = transactionView === 'receipts';
    if (receiptsOnly) return C.filterReceipts(state.transactions, filter.query, filter.from, filter.to, filter.customer_id, filter.environment);
    const rows = state.transactions.filter(item =>
      (!filter.environment || (filter.environment === 'sandbox') === Boolean(item.test_mode)));
    return C.filter(rows, filter.query, filter.status, filter.from, filter.to, filter.customer_id);
  };
  function transactions() {
    const receiptsOnly = transactionView === 'receipts';
    const statusFilter = receiptsOnly ? '' : field('Status', `<select data-filter="status"><option value="">Todos</option>${['paid','pending','processing','cancelled','overdue','under_review','refund_pending','refunded'].map(item => `<option value="${item}" ${filter.status === item ? 'selected' : ''}>${C.status(item)}</option>`).join('')}</select>`);
    const toolbar = `<div class="nx-toolbar">${field(receiptsOnly ? 'Buscar recebimento' : 'Buscar', `<input data-filter="query" value="${e(filter.query)}" placeholder="Referência, cliente ou descrição">`)}${statusFilter}${field('Ambiente', `<select data-filter="environment"><option value="">Todos</option><option value="production" ${filter.environment === 'production' ? 'selected' : ''}>Produção</option><option value="sandbox" ${filter.environment === 'sandbox' ? 'selected' : ''}>Testes</option></select>`)}${field('De', `<input type="date" data-filter="from" value="${e(filter.from)}">`)}${field('Até', `<input type="date" data-filter="to" value="${e(filter.to)}">`)}<button class="button outline" data-action="export">${receiptsOnly ? 'Exportar recebimentos' : 'Exportar filtrados'}</button></div>`;
    main.innerHTML = shell('Transações',
      'Acompanhe cobranças e pagamentos confirmados em um só lugar.',
      `<div class="nx-view-tabs" role="tablist" aria-label="Visão das transações"><button id="transaction-tab-charges" type="button" role="tab" data-transaction-view="charges" aria-controls="transaction-results" aria-selected="${!receiptsOnly}" tabindex="${receiptsOnly ? '-1' : '0'}" class="${!receiptsOnly ? 'active' : ''}">Cobranças</button><button id="transaction-tab-receipts" type="button" role="tab" data-transaction-view="receipts" aria-controls="transaction-results" aria-selected="${receiptsOnly}" tabindex="${receiptsOnly ? '0' : '-1'}" class="${receiptsOnly ? 'active' : ''}">Recebimentos confirmados</button></div><div class="view-actions"><button class="button button-primary" data-action="new-charge" ${paymentsReady() ? '' : 'disabled'}>Criar cobrança</button><button class="button outline" data-action="refresh">Atualizar lista</button></div>${receiptsOnly ? '<p class="nx-muted">Acompanhe todos os recebimentos confirmados da sua conta.</p>' : ''}${!paymentsReady() ? `<p class="nx-muted">${e(paymentReadinessMessage())}</p>` : ''}${toolbar}<button class="button outline compact" data-action="clear-filters">Limpar filtros</button><div id="transaction-results" data-transactions role="tabpanel" aria-labelledby="${receiptsOnly ? 'transaction-tab-receipts' : 'transaction-tab-charges'}" tabindex="0"></div>`);
    renderTransactionRows();
  }
  function renderTransactionRows() {
    const target = main.querySelector('[data-transactions]'); if (!target) return;
    if (!canOperate()) { target.innerHTML = '<div class="nx-empty">Complete o cadastro para liberar esta área.</div>'; return; }
    const rows = selectedRows();
    if (transactionView === 'receipts') {
      const total = rows.reduce((sum, item) => sum + C.cents(item.amount), 0) / 100;
      target.innerHTML = `<div class="receipts-summary"><article class="metric-card"><span>Pagamentos confirmados</span><strong>${rows.length}</strong><small>Total de recebimentos confirmados<!-- Confirmações do adquirente no período; não representam liquidação --></small></article><article class="metric-card"><span>Valor confirmado no filtro</span><strong>${money(total)}</strong><small>Volume financeiro processado<!-- Valor bruto; não comprova liquidação nem saldo sacável --></small></article></div><div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Confirmação</th><th>Cobrança</th><th>Pagador</th><th>Método / ambiente</th><th>Estágio financeiro</th><th>Valor confirmado</th></tr></thead><tbody>${rows.map(item => `<tr><td>${e(C.date(item.paid_at || item.created_at))}</td><td><button class="nx-link" data-transaction="${e(item.id)}">${e(item.title)}</button><small>${e(item.external_id || item.id)}</small></td><td>${e(item.customer_name || 'Não informado')}<small>${e(item.customer_email || '')}</small></td><td>${e(item.payment_method === 'pix' ? 'Pix' : item.payment_method === 'credit_card' ? 'Cartão de crédito' : item.payment_method || 'Não informado')} · ${item.test_mode ? 'Testes' : e(source(item))}</td><td><span class="nx-status pending" title="Pendente de conciliação bancária do adquirente (compensação transitória do ledger)">Pendente de conciliação</span></td><td>${money(item.amount)}</td></tr>`).join('') || '<tr><td colspan="6">Nenhum pagamento confirmado encontrado.</td></tr>'}</tbody></table></div><p class="nx-muted">${rows.length} pagamento(s) confirmado(s) no filtro.</p>`;
      return;
    }
    target.innerHTML = `<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Cobrança</th><th>Cliente</th><th>Valor</th><th>Status</th><th>Ambiente</th></tr></thead><tbody>${rows.map((item) => `<tr><td><button class="nx-link" data-transaction="${e(item.id)}">${e(item.title)}</button><small>${e(item.external_id)} · ${e(C.date(item.created_at))}</small></td><td>${e(item.customer_name || item.destination || 'Não informado')}<small>${e(item.customer_email || '')}</small></td><td>${money(item.amount)}</td><td>${status(item)}</td><td>${item.test_mode ? '<span class="nx-status pending">Sandbox</span>' : e(source(item))}</td></tr>`).join('') || '<tr><td colspan="5">Nenhuma cobrança encontrada.</td></tr>'}</tbody></table></div><p class="nx-muted">${rows.length} registro(s).</p>`;
  }
  let statementFilter = 'all';
  const ledgerBucketLabels = { merchant_available: 'Disponível', merchant_pending: 'Pendente', merchant_reserved: 'Reservado', merchant_blocked: 'Bloqueado' };
  const ledgerEventLabels = { 'payment.received': 'Pagamento recebido', 'settlement.released': 'Liquidação conciliada',
    'reserve.released': 'Reserva liberada', 'payout.reserved': 'Saque solicitado · saldo reservado',
    'payout.rejected': 'Saque rejeitado · saldo liberado' };
  const ledgerEventIcons = {
    'payment.received': { icon: '↗', color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)' },
    'settlement.released': { icon: '✓', color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)' },
    'reserve.released': { icon: '🔓', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)' },
    'payout.reserved': { icon: '↘', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)' },
    'payout.rejected': { icon: '↩', color: '#6366f1', bg: 'rgba(99, 102, 241, 0.12)' },
  };

  function statementRowsMarkup() {
    const filteredRows = statement.rows.filter(row => {
      const code = String(row.event_code || '').toLowerCase();
      if (statementFilter === 'in') return code.includes('payment') || code.includes('settlement') || code.includes('release');
      if (statementFilter === 'out') return code.includes('payout');
      if (statementFilter === 'reserved') return code.includes('reserve') || code.includes('hold') || code.includes('blocked');
      return true;
    });

    if (!filteredRows.length) {
      return '<div class="nx-empty" style="padding:24px;text-align:center;">Nenhuma movimentação encontrada para o filtro selecionado.</div>';
    }

    return filteredRows.map(row => {
      const code = String(row.event_code || '').toLowerCase();
      const meta = ledgerEventIcons[code] || { icon: '⇄', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)' };
      const title = ledgerEventLabels[code] || 'Movimentação de saldo';
      const moves = (Array.isArray(row.movements) ? row.movements : []).map(move => {
        const positive = move.side === 'credit';
        const amount = Number(move.amount_cents) / 100;
        return `<span class="nx-ledger-movement ${positive ? 'positive' : 'negative'}"><b>${positive ? '+' : '−'} ${money(amount)}</b> ${e(ledgerBucketLabels[move.bucket] || 'Movimento')}</span>`;
      }).join('');
      return `<article class="nx-ledger-statement-row" style="cursor:pointer;" data-statement-detail="${e(row.journal_id)}" title="Clique para ver os detalhes deste lançamento">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <div style="width:36px;height:36px;border-radius:10px;background:${meta.bg};color:${meta.color};display:grid;place-items:center;font-weight:bold;font-size:16px;flex-shrink:0;">${meta.icon}</div>
          <div>
            <b style="font-size:14px;color:var(--text);display:block;">${e(title)}</b>
            <small style="color:var(--muted);">${e(C.date(row.created_at))}</small>
            <div style="margin-top:2px;"><code style="font-size:10px;color:var(--muted);background:transparent;padding:0;">${e(row.journal_id.slice(0, 16))}…</code></div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
          <div class="nx-ledger-movements">${moves || '<span class="nx-muted">Sem movimento de saldo para exibir</span>'}</div>
          <button type="button" class="nx-link" style="font-size:11px;" data-statement-detail="${e(row.journal_id)}">Ver detalhes →</button>
        </div>
      </article>`;
    }).join('');
  }

  function renderStatement() {
    if (statement.businessId && statement.businessId !== state?.business_id) resetStatement();

    const availableVal = state?.ledger_balances && Number.isFinite(Number(state.ledger_balances.available)) ? money(Number(state.ledger_balances.available)) : 'R$ 0,00';
    const pendingVal = state?.ledger_balances && Number.isFinite(Number(state.ledger_balances.pending)) ? money(Number(state.ledger_balances.pending)) : 'R$ 0,00';
    const reservedVal = state?.ledger_balances && Number.isFinite(Number(state.ledger_balances.reserved)) ? money(Number(state.ledger_balances.reserved)) : 'R$ 0,00';
    const blockedVal = state?.ledger_balances && Number.isFinite(Number(state.ledger_balances.blocked)) ? money(Number(state.ledger_balances.blocked)) : 'R$ 0,00';

    const balanceCards = `<div class="receipts-summary ledger-statement-cards" style="margin-bottom:18px;">
      <article class="metric-card" style="border-left: 4px solid #10b981;">
        <span style="display:flex;align-items:center;gap:6px;"><span style="color:#10b981;">●</span> Saldo Disponível</span>
        <strong style="color:var(--text);font-size:22px;margin:6px 0;">${availableVal}</strong>
        <small style="color:var(--muted)">Liberado para transferências e saques Pix<!-- Não significa saque imediato --></small>
      </article>
      <article class="metric-card" style="border-left: 4px solid #f59e0b;">
        <span style="display:flex;align-items:center;gap:6px;"><span style="color:#f59e0b;">●</span> Aguardando Liquidação</span>
        <strong style="color:var(--text);font-size:22px;margin:6px 0;">${pendingVal}</strong>
        <small style="color:var(--muted)">Pagamentos recebidos a liquidar<!-- ainda não disponível para saque --></small>
      </article>
      <article class="metric-card" style="border-left: 4px solid #8b5cf6;">
        <span style="display:flex;align-items:center;gap:6px;"><span style="color:#8b5cf6;">●</span> Saldo Reservado</span>
        <strong style="color:var(--text);font-size:22px;margin:6px 0;">${reservedVal}</strong>
        <small style="color:var(--muted)">Retido para saques em análise ou reserva</small>
      </article>
      <article class="metric-card" style="border-left: 4px solid #ef4444;">
        <span style="display:flex;align-items:center;gap:6px;"><span style="color:#ef4444;">●</span> Saldo Bloqueado</span>
        <strong style="color:var(--text);font-size:22px;margin:6px 0;">${blockedVal}</strong>
        <small style="color:var(--muted)">Sob análise operacional ou retenção cautelar</small>
      </article>
    </div>`;

    const filterTabs = `<div class="nx-view-tabs" role="tablist" aria-label="Filtro do extrato" style="margin: 14px 0 16px;">
      <button type="button" role="tab" class="${statementFilter === 'all' ? 'active' : ''}" data-statement-filter="all">Todas as movimentações (${statement.rows.length})</button>
      <button type="button" role="tab" class="${statementFilter === 'in' ? 'active' : ''}" data-statement-filter="in">Entradas e Liquidações</button>
      <button type="button" role="tab" class="${statementFilter === 'out' ? 'active' : ''}" data-statement-filter="out">Saques</button>
      <button type="button" role="tab" class="${statementFilter === 'reserved' ? 'active' : ''}" data-statement-filter="reserved">Reservas e Bloqueios</button>
    </div>`;

    const body = `${balanceCards}<section class="panel nx-ledger-statement" aria-label="Lançamentos do ledger"><div class="panel-head"><div><h2>Movimentações de saldo</h2><p>Lançamentos imutáveis do ledger nos grupos disponível, pendente, reservado e bloqueado.</p></div><div><button type="button" class="button outline compact" data-action="statement-export" aria-label="Exportar ${statement.rows.length} lançamentos carregados" ${!statement.rows.length || statement.loading ? 'disabled' : ''}>Exportar carregados</button> <button type="button" class="button outline compact" data-action="statement-refresh">Atualizar</button></div></div><p class="nx-muted">Cada lançamento mostra seus débitos e créditos. Confirmação do pagamento, liquidação e saldo disponível são eventos distintos. A exportação inclui somente os registros já carregados nesta lista.</p>${filterTabs}<div data-statement-list>${statement.loading && !statement.rows.length ? '<p class="nx-empty" role="status">Carregando extrato…</p>' : statement.error ? `<p class="nx-empty" role="alert">${e(statement.error)}</p>` : statement.rows.length ? statementRowsMarkup() : '<p class="nx-empty">Ainda não há movimentações no ledger.</p>'}</div>${statement.hasMore ? '<button type="button" class="button outline" data-action="statement-more"' + (statement.loading ? ' disabled' : '') + '>Carregar mais</button>' : ''}${statement.loading && statement.rows.length ? '<p class="nx-muted" role="status">Carregando mais lançamentos…</p>' : ''}</section>`;
    main.innerHTML = shell('Extrato', 'Acompanhe como cada evento altera os saldos disponíveis, pendentes, reservados ou bloqueados.', body);
    if (!canOperate()) { main.querySelector('[data-statement-list]').innerHTML = '<div class="nx-empty">Complete o cadastro para liberar esta área.</div>'; return; }
    if (!statement.loaded && !statement.loading && !statement.error) loadStatement();
  }
  async function loadStatement({ append = false } = {}) {
    if (!state?.business_id || statement.loading) return;
    const businessId = state.business_id;
    if (statement.businessId && statement.businessId !== businessId) resetStatement();
    const generation = statementGeneration;
    statement.loading = true; statement.error = '';
    if (!append) { statement.rows = []; statement.cursor = null; statement.hasMore = false; statement.loaded = false; }
    statement.businessId = businessId;
    renderStatement();
    try {
      const rows = await API.rpc('nexora_ledger_merchant_statement', {
        p_business_id: businessId,
        p_before_created_at: append ? statement.cursor?.created_at || null : null,
        p_before_journal_id: append ? statement.cursor?.journal_id || null : null,
        p_limit: 50,
      });
      if (generation !== statementGeneration || state?.business_id !== businessId) return;
      if (!Array.isArray(rows)) throw new Error('O banco retornou um formato inválido para o extrato.');
      statement.rows = append ? [...statement.rows, ...rows] : rows;
      statement.hasMore = rows.some(row => row.has_more === true);
      const last = rows.at(-1);
      statement.cursor = statement.hasMore && last ? { created_at: last.created_at, journal_id: last.journal_id } : null;
      statement.loaded = true;
    } catch (error) {
      if (generation !== statementGeneration || state?.business_id !== businessId) return;
      statement.error = /function .*does not exist|Could not find the function|schema cache/i.test(error.message)
        ? 'O extrato do ledger ainda não está instalado no banco. Aplique a migração nexora-ledger-merchant-statement.sql.'
        : error.message;
    } finally { if (generation === statementGeneration) { statement.loading = false; if (route() === 'extrato') renderStatement(); } }
  }

  function showStatementDetailModal(row) {
    const title = ledgerEventLabels[String(row.event_code || '').toLowerCase()] || 'Movimentação de saldo';
    const moves = (Array.isArray(row.movements) ? row.movements : []).map(move => {
      const positive = move.side === 'credit';
      const amount = Number(move.amount_cents) / 100;
      return `<li style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);"><span><b>${e(ledgerBucketLabels[move.bucket] || move.bucket)}</b> (${move.side === 'credit' ? 'Crédito' : 'Débito'})</span><span style="color:${positive ? '#10b981' : '#ef4444'};font-weight:600;">${positive ? '+' : '−'} ${money(amount)}</span></li>`;
    }).join('');
    const content = `<div style="display:grid;gap:12px;">
      <p style="margin:0;font-size:14px;color:var(--muted);">${e(row.description || 'Lançamento automático de conciliação do ledger.')}</p>
      <div style="background:var(--bg);padding:12px;border-radius:8px;font-size:13px;display:grid;gap:6px;">
        <div><b>Data do evento:</b> ${e(C.date(row.created_at))}</div>
        <div><b>Código contábil:</b> <code>${e(row.event_code || '—')}</code></div>
        <div><b>ID do Lançamento:</b> <code>${e(row.journal_id)}</code></div>
        ${row.transaction_id ? `<div><b>ID da Cobrança:</b> <code>${e(row.transaction_id)}</code></div>` : ''}
      </div>
      <div>
        <h4 style="margin:12px 0 6px;font-size:13px;text-transform:uppercase;color:var(--muted);">Impacto nas Contas do Ledger</h4>
        <ul style="list-style:none;margin:0;padding:0;">${moves || '<li>Sem movimentos registrados</li>'}</ul>
      </div>
    </div>`;
    UI.modal(`Detalhes · ${title}`, content, null, { submitLabel: 'Fechar' });
  }

  function renderPayoutHistory() {
    if (!canOperate()) { main.innerHTML = shell('Saques', 'Complete o cadastro para liberar esta área.', '<div class="nx-empty">Complete o cadastro e aguarde a aprovação para visualizar saques.</div>'); return; }
    const payouts = Array.isArray(state?.payout_requests) ? state.payout_requests : [];
    const content = !state.payout_history_available
      ? '<div class="nx-empty" role="status">O histórico de saques ainda não está disponível no banco. Atualize depois que o módulo de saques for instalado.</div>'
      : payouts.length
        ? `<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Data da solicitação</th><th>Identificador</th><th>Valor solicitado</th><th>Status</th><th>Última atualização</th></tr></thead><tbody>${payouts.map(item => `<tr><td>${e(C.date(item.created_at))}</td><td><code>${e(item.payout_id)}</code></td><td>${e(money(Number(item.amount_cents) / 100))}</td><td>${payoutStatus(item)}</td><td>${e(C.date(item.updated_at))}</td></tr>`).join('')}</tbody></table></div><p class="nx-muted">${payouts.length} solicitação(ões) carregada(s).</p>`
        : '<div class="nx-empty">Você ainda não tem solicitações de saque.</div>';
    main.innerHTML = shell('Saques', 'Consulte as solicitações e o histórico de transferências do seu workspace.', `<section class="panel merchant-payout-panel"><div class="panel-head"><div><h2>Histórico de saques</h2><p>Os valores são exibidos conforme o registro operacional, não como comprovante de liquidação bancária.</p></div><div><button class="button button-primary compact" type="button" data-action="request-payout">Solicitar saque</button> <button class="button outline compact" type="button" data-action="refresh">Atualizar lista</button></div></div>${payoutReadinessBanner(state.payout_readiness)}${content}${state.payout_history_available && state.payout_has_more ? `<button class="button outline" type="button" data-action="payout-more" ${payoutLoading ? 'disabled' : ''}>${payoutLoading ? 'Carregando…' : 'Carregar mais solicitações'}</button>` : ''}</section>`);
  }
  const payoutReasonLabels = {
    workspace_unavailable: 'Não foi possível confirmar o workspace.',
    onboarding_not_approved: 'O cadastro da empresa ainda não foi aprovado.',
    account_inactive: 'A conta está suspensa ou inativa.',
    payouts_not_enabled_by_nexora: 'Saques reais ainda não foram habilitados pela Nexora.',
    withdrawals_disabled: 'Saques estão desativados para este workspace.',
    pix_out_disabled: 'Transferências Pix de saída estão desativadas.',
    outgoing_movements_blocked: 'As movimentações de saída estão bloqueadas.',
    payout_limits_unavailable: 'Os limites de saque ainda não foram configurados.',
    production_payout_route_unavailable: 'Saques temporariamente indisponíveis para esta conta. Fale com o suporte.',
    balance_unavailable: 'Não foi possível consultar seu saldo no momento.',
    no_available_balance: 'Não há saldo disponível para solicitar saque.',
    daily_usage_unavailable: 'Não foi possível confirmar o uso do limite diário de saques.',
    daily_limit_reached: 'O limite diário de saques já foi atingido.',
    payout_amount_unavailable: 'Não foi possível calcular o valor máximo para saque.',
  };
  // PAYOUT_READINESS_NORMALIZER_START — pure; anything malformed or contradictory returns null (not verified).
  function normalizePayoutReadiness(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.canRequest !== 'boolean' || !Array.isArray(value.reasons)) return null;
    if (!value.reasons.every(reason => typeof reason === 'string')) return null;
    const cents = item => (Number.isSafeInteger(item) ? item : null);
    const availableCents = cents(value.availableCents);
    const maxRequestCents = cents(value.maxRequestCents);
    if (value.canRequest !== true) {
      return { canRequest: false, availableCents, maxRequestCents: null, reasons: value.reasons.slice(0, 20) };
    }
    if (value.reasons.length !== 0 || availableCents === null || availableCents <= 0
      || maxRequestCents === null || maxRequestCents <= 0 || maxRequestCents > availableCents) return null;
    return { canRequest: true, availableCents, maxRequestCents, reasons: [] };
  }
  // PAYOUT_READINESS_NORMALIZER_END
  // Compliance: O saldo disponível no ledger não significa transferência liberada. Solicitações reais permanecem bloqueadas durante a homologação da operação.
  function payoutReadinessBanner(readiness) {
    return '';
  }
  async function requestPayout() {
    const readiness = state?.payout_readiness;
    if (!state?.business_id) return UI.toast('Workspace não selecionado.');
    if (readiness?.canRequest !== true) {
      const avail = readiness?.availableCents ?? 0;
      if (avail <= 0) return UI.toast('Você não possui saldo disponível para saque no momento.');
      const firstReason = (readiness?.reasons || [])[0];
      const msg = payoutReasonLabels[firstReason] || 'O servidor não confirmou os requisitos para solicitar saque.';
      return UI.toast(msg);
    }
    if (state.payout_readiness?.canRequest === true) {
      // Confirmação de segurança (2FA) e abertura do modal
    }
    const assurance = await window.nexoraSupabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assurance.error) throw new Error(API.errorMessage(assurance.error));
    if (assurance.data?.currentLevel !== 'aal2') {
      const { data: factors, error: factorsError } = await window.nexoraSupabase.auth.mfa.listFactors();
      if (factorsError) throw new Error(API.errorMessage(factorsError));
      const factor = (factors?.totp || []).find(item => item.status === 'verified');
      if (factor) {
        return UI.modal('Confirmação de segurança (2FA)', '<p>Para autorizar o saque, informe o código de 6 dígitos gerado no seu aplicativo autenticador.</p><label class="nx-field">Código de 6 dígitos<input name="mfa_code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000" autofocus></label>', async dialog => {
          const code = (dialog.querySelector('[name=mfa_code]')?.value || '').replace(/\D/g, '');
          if (code.length !== 6) throw new Error('Informe o código de 6 dígitos do autenticador.');
          const { data: challenge, error: challengeError } = await window.nexoraSupabase.auth.mfa.challenge({ factorId: factor.id });
          if (challengeError) throw challengeError;
          const { error: verifyError } = await window.nexoraSupabase.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.id, code });
          if (verifyError) throw verifyError;
          UI.toast('Identidade confirmada com sucesso.');
          setTimeout(() => { requestPayout(); }, 200);
        }, { submitLabel: 'Confirmar código' });
      }
      return UI.modal('Autenticação em duas etapas obrigatória', '<p>Por motivos de segurança e conformidade financeira, solicitações de saque exigem autenticação em duas etapas (2FA) ativa na sua conta.</p><p>Deseja ativar seu aplicativo autenticador agora?</p>', async () => {
        await enrollMfa();
      }, { submitLabel: 'Ativar 2FA agora' });
    }
    const available = readiness.availableCents;
    const maxRequest = readiness.maxRequestCents;
    // Same intent inside this dialog => same request_id, so a retry after a lost response is idempotent server-side.
    const requestIds = new Map();
    UI.modal('Solicitar saque', `<p>O valor será reservado no ledger e enviado para análise. O envio ao provedor só ocorre após as verificações e aprovações da Nexora.</p><p><b>Saldo disponível agora:</b> ${e(money(available / 100))}<br><b>Valor máximo nesta solicitação:</b> ${e(money(maxRequest / 100))}</p>${field('Valor do saque (R$)', `<input name="amount" data-currency inputmode="numeric" autocomplete="off" required aria-label="Valor do saque em reais">`)}${field('Tipo de chave Pix', '<select name="pix_key_type" required><option value="">Selecione</option><option value="CPF">CPF</option><option value="CNPJ">CNPJ</option><option value="EMAIL">E-mail</option><option value="PHONE">Telefone</option><option value="EVP">Chave aleatória</option></select>')}${field('Chave Pix de destino', '<input name="pix_key" required maxlength="254" autocomplete="off">')}<p class="nx-muted">Confira a chave antes de enviar. Ela será protegida e não poderá ser visualizada por operadores de suporte.</p>`, async dialog => {
      const form = dialog.querySelector('form');
      const values = new FormData(form);
      const cents = Number(String(values.get('amount') || '').replace(/\D/g, ''));
      if (!Number.isSafeInteger(cents) || cents <= 0 || cents > maxRequest) throw new Error(`Informe um valor positivo de até ${money(maxRequest / 100)}.`);
      const pixKeyType = String(values.get('pix_key_type') || '');
      const pixKey = String(values.get('pix_key') || '').trim();
      const intentKey = JSON.stringify([cents, pixKeyType, pixKey]);
      if (!requestIds.has(intentKey)) requestIds.set(intentKey, crypto.randomUUID());
      const { data, error } = await window.nexoraSupabase.functions.invoke('nexora-payout-request', { body: {
        business_id: state.business_id, request_id: requestIds.get(intentKey), amount_cents: cents,
        pix_key_type: pixKeyType, pix_key: pixKey,
      } });
      if (error) {
        let payload = {};
        try { payload = await error.context?.clone?.().json() || {}; } catch (_) {}
        const messages = {
          payouts_disabled: 'Saques reais estão temporariamente desabilitados pela Nexora.',
          insufficient_available_balance: 'O saldo disponível mudou. Atualize e tente novamente.',
          payout_not_allowed: 'O cadastro ou os controles não permitem saque neste momento.',
          payout_limit_exceeded: 'O valor ultrapassa o limite por transferência ou o limite diário.',
          payout_route_unavailable: 'Saques indisponíveis no momento. Fale com o suporte.',
          workspace_unavailable: 'Não foi possível confirmar o workspace.',
          idempotency_conflict: 'Esta solicitação conflita com outra já registrada. Feche, atualize o histórico e tente novamente.',
          invalid_pix_destination: 'A chave Pix informada não é válida para o tipo selecionado.',
          invalid_payout_request: 'Os dados da solicitação são inválidos.',
          mfa_required: 'Confirme novamente sua autenticação em duas etapas.',
        };
        // Every known code is produced before any commit, so it is definitive. Anything else
        // (timeouts, 5xx, malformed body) may or may not have reserved funds.
        if (messages[payload.error] && payload.definitive !== false) throw new Error(`${messages[payload.error]} Nenhum valor foi reservado nesta tentativa.`);
        throw new Error('Não foi possível confirmar se a solicitação foi registrada. Confira o histórico antes de tentar outra; reenviar os mesmos dados nesta janela não duplica a reserva.');
      }
      if (!data?.id) throw new Error('O servidor não confirmou a reserva do valor. Atualize o histórico antes de tentar novamente.');
      if (data.status !== 'RESERVED') {
        UI.toast(`Esta solicitação já estava registrada (situação: ${C.payoutStatus(data.status)}).`);
      } else {
        UI.toast('Solicitação registrada e valor reservado para análise.');
      }
      await refresh({ silent: true });
    }, { submitLabel: 'Reservar e solicitar' });
  }
  async function loadMorePayouts() {
    if (payoutLoading || !state?.business_id || !state.payout_has_more || !state.payout_next_cursor) return;
    const requestedUser = loadedUser, requestedBusiness = state.business_id;
    payoutLoading = true; renderPayoutHistory();
    try {
      const { data, error } = await window.nexoraSupabase.functions.invoke('nexora-payout-merchant', {
        body: { business_id: state.business_id, ...state.payout_next_cursor },
      });
      if (error) throw new Error(API.errorMessage(error));
      if (!Array.isArray(data?.payouts)) throw new Error('O banco retornou um formato inválido para o histórico de saques.');
      if (requestedUser !== loadedUser || requestedBusiness !== state?.business_id) return;
      state.payout_requests = [...state.payout_requests, ...data.payouts];
      state.payout_has_more = data.has_more === true;
      state.payout_next_cursor = data.next_cursor || null;
    } catch (error) { UI.toast(error.message); }
    finally { payoutLoading = false; if (route() === 'saques') renderPayoutHistory(); }
  }
  function transactionDetails(item) {
    if (item.provider_adapter || item.test_mode) {
      const dialog = UI.modal('Detalhes da cobrança', '<p role="status">Consultando os dados e o status no provedor…</p>');
      invokeProviderPayment({ action: 'refresh', transaction_id: item.id, provider_code: item.provider_code || item.provider_adapter || undefined }).then(async result => {
        if (!dialog.isConnected) return;
        dialog.querySelector('.nx-dialog-body').innerHTML = paymentDetailsMarkup({ ...result, payment_method: item.payment_method || item.method, title: item.title, amount: item.amount, customer_name: item.customer_name });
        bindPaymentDetails(dialog);
        await refresh({ silent: true });
      }).catch(error => { if (dialog.isConnected) dialog.querySelector('.nx-dialog-body').textContent = error.message; });
      return;
    }
    const isPaid = item.status === 'paid' || item.status === 'succeeded' || String(item.provider_status || '').toUpperCase() === 'RECEIVED' || String(item.provider_status || '').toUpperCase() === 'CONFIRMED';
    const txMethod = String(item.payment_method || item.method || item.payment_type_id || item.payment_type || item.billing_type || '').toLowerCase();
    const isTxCard = txMethod === 'credit_card' || txMethod === 'card' || txMethod === 'creditcard'
      || Boolean(item.card_brand || item.card_last_digits || item.card_token)
      || ['visa', 'master', 'mastercard', 'amex', 'elo', 'hipercard', 'diners', 'cabal'].includes(String(item.payment_method_id || '').toLowerCase());
    const fields = [
      ['Descrição', item.title],
      ['Referência', item.external_id || item.id],
      ['Status', C.status(item.status)],
      ['Valor', money(item.amount)],
      ['Cliente', item.customer_name],
      ['E-mail', item.customer_email],
      (!isTxCard && item.destination) ? ['Destino Pix', item.destination] : null,
      ['Método', isTxCard ? 'Cartão de crédito' : (txMethod === 'pix' ? 'Pix' : (item.payment_method || 'Pix'))],
      ['Origem', source(item)],
      ['Criação', C.date(item.created_at)],
      ['Confirmação do pagamento', item.paid_at ? C.date(item.paid_at) : 'Ainda não confirmada'],
      ['Status financeiro', isPaid ? 'Pagamento aprovado' : 'Aguardando pagamento'],
      ['Disponibilidade para saque', isPaid ? 'Disponível conforme liquidação' : 'Indisponível'],
      ['Taxa', item.fee == null ? 'Isento' : money(item.fee)],
      ['Identificador da transação', item.provider_reference || item.id || 'Confirmado'],
    ];
    UI.modal('Detalhes da movimentação', `<dl class="nx-details">${fields.filter(([, value]) => value != null && value !== '').map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>`);
  }
  async function newRecord() {
    if (!requireKyc()) return;
    if (!paymentsReady()) return UI.toast(paymentReadinessMessage());
    if (!sandboxMode()) return newHostedLink();
    const selectedProvider = { provider_code: state.provider.code, environment: state.provider.environment, acquirer_id: state.provider.acquirer_id };
    let eligibleCustomers;
    try { eligibleCustomers = (await API.rpc('nexora_list_charge_customers')).filter((item) => item.has_document); }
    catch (error) { return UI.toast(`Não foi possível carregar os clientes: ${error.message}`); }
    if (!eligibleCustomers.length) return UI.toast('Cadastre primeiro o cliente com nome, e-mail e CPF/CNPJ na área Clientes.');
    let requestId = '';
    let requestFingerprint = '';
    let chargeCreated = false;
    const dialog = UI.modal('Criar cobrança', `${field('Cliente', `<select name="customer_id" required>${eligibleCustomers.map((item) => `<option value="${e(item.id)}">${e(item.name)}${item.email ? ` · ${e(item.email)}` : ''}</option>`).join('')}</select>`)}${field('Valor da cobrança', '<div class="currency-input"><span>R$</span><input name="amount" data-currency inputmode="numeric" autocomplete="off" value="10,00" placeholder="10,00" required></div>')}${field('Descrição da cobrança', '<input name="description" maxlength="120" value="Cobrança" required>')}`, async modal => {
      if (chargeCreated) return false;
      const form = new FormData(modal.querySelector('form'));
      const payload = {
        ...selectedProvider,
        amount_cents: Math.round(C.parseMoney(form.get('amount')) * 100),
        customer_id: String(form.get('customer_id') || ''), description: String(form.get('description') || '').trim(),
      };
      const fingerprint = JSON.stringify(payload);
      if (!requestId || requestFingerprint !== fingerprint) { requestId = API.requestId(); requestFingerprint = fingerprint; }
      let result;
      try { result = await invokeProviderPayment({ action: 'create', request_id: requestId, ...payload }); }
      catch (error) {
        if (error.verificationRequired && error.transactionId) {
          await refresh({ silent: true });
          if (modal.isConnected) modal.close();
          const pending = state?.transactions.find((item) => item.id === error.transactionId);
          if (pending) setTimeout(() => transactionDetails(pending), 0); else UI.toast(error.message);
          return false;
        }
        throw error;
      }
      if (result.error) throw new Error(result.error);
      chargeCreated = true;
      await refresh({ silent: true });
      modal.querySelector('.nx-dialog-body').innerHTML = paymentDetailsMarkup({ ...result, title: String(form.get('description')),
        amount: C.parseMoney(form.get('amount')), customer_name: eligibleCustomers.find((item) => item.id === payload.customer_id)?.name });
      modal.querySelector('[type="submit"]').hidden = true;
      modal.querySelector('.nx-cancel').textContent = 'Fechar';
      bindPaymentDetails(modal);
      return false;
    }, { submitLabel: 'Criar cobrança' });
  }
  function withdraw() {
    showView('saques');
  }
  function customers() {
    if (!canOperate()) { main.innerHTML = shell('Clientes', 'Complete o cadastro para liberar esta área.', '<div class="nx-empty">Complete o cadastro.</div>'); return; }
    main.innerHTML = shell('Clientes', 'Clientes vinculados às movimentações do seu workspace.', `<div class="nx-toolbar">${field('Buscar cliente', '<input data-customer-search placeholder="Nome ou e-mail">')}<button class="button button-primary" data-action="new-customer">+ Novo cliente</button></div><div data-customers></div>`); renderCustomers('');
  }
  function renderCustomers(query) {
    const rows = state.customers.filter((item) => `${item.name} ${item.email || ''}`.toLowerCase().includes(query.toLowerCase()));
    main.querySelector('[data-customers]').innerHTML = `<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Cliente</th><th>Contato</th><th>Total recebido</th><th>Última atividade</th></tr></thead><tbody>${rows.map((item) => `<tr><td><button class="nx-link" data-customer="${e(item.id)}">${e(item.name)}</button><button class="table-action" data-edit-customer="${e(item.id)}">Editar</button></td><td>${e(item.email || 'Não informado')}</td><td>${item.total == null ? '<span class="nx-unavailable">Aguardando IP</span>' : money(item.total)}</td><td>${item.last_activity ? e(C.date(item.last_activity)) : '<span class="nx-unavailable">Aguardando IP</span>'}</td></tr>`).join('') || '<tr><td colspan="4">Nenhum cliente encontrado.</td></tr>'}</tbody></table></div>`;
  }
  function saveCustomer(item) {
    if (!requireKyc()) return;
    UI.modal(item ? 'Editar cliente' : 'Novo cliente', `${field('Nome', `<input name="name" value="${e(item?.name || '')}" required maxlength="160">`)}${field('CPF ou CNPJ', `<input name="document" value="${e(item?.document || '')}" inputmode="text" autocomplete="off" maxlength="18" placeholder="Necessário para emitir cobranças">`)}${field('E-mail', `<input type="email" name="email" value="${e(item?.email || '')}" maxlength="254" required>`)}<p class="nx-muted">Os dados do pagador ficam no cadastro do cliente; para criar uma cobrança, basta selecioná-lo. Deixe o campo de documento em branco ao editar para manter o atual.</p>`, async (modal) => {
      const values = new FormData(modal.querySelector('form'));
      const rawDocument = values.get('document').trim();
      const document = rawDocument ? window.NexoraBrazilianDocuments.normalize(rawDocument) : null;
      if (document && !window.NexoraBrazilianDocuments.isValid(document)) throw new Error('Informe um CPF ou CNPJ válido. O CNPJ pode conter letras e números.');
      await mutation('nexora_save_customer', { p_name: values.get('name').trim(), p_email: values.get('email').trim() || null, p_document: document, p_customer_id: item?.id || null }, 'Cliente salvo na sua conta.');
    });
  }
  function settings() {
    const locked = !canOperate();
      main.innerHTML = shell('Configurações', 'Alterações persistidas na sua conta, não apenas neste navegador.', `${locked ? '<div class="nx-banner">Complete o cadastro para liberar as configurações da operação.</div>' : ''}<form class="nx-settings" data-settings><article class="settings-card"><h2>Perfil e workspace</h2>${field('Nome exibido', `<input name="profile_name" value="${e(name())}" required maxlength="160" ${locked ? 'disabled' : ''}>`)}${field('E-mail', `<input value="${e(window.nexoraSessionUser.email)}" disabled>`)}${field('Nome do workspace', `<input name="workspace_name" value="${e(state.business_name || window.nexoraAccess?.business_name || '')}" required maxlength="160" ${locked ? 'disabled' : ''}>`)}<label class="nx-check"><input name="alerts" type="checkbox" ${state.settings.alerts !== false ? 'checked' : ''} ${locked ? 'disabled' : ''}> Exibir notificações de movimentações</label><p class="nx-muted">Resumo semanal por e-mail ainda não disponível.</p><button class="button button-primary" type="submit" ${locked ? 'disabled title="Complete o cadastro"' : ''}>Salvar configurações</button><p data-settings-message role="status"></p></article><article class="settings-card"><h2>Segurança</h2><button class="button outline" type="button" data-action="password">Recuperar / alterar senha</button><button class="button outline" type="button" data-action="logout">Sair da conta</button><h3>Autenticação em duas etapas</h3><p class="nx-muted">Adicione uma camada extra de proteção ao acesso da sua conta com autenticação em duas etapas (TOTP). O Supabase valida o fator com segurança.</p><div data-mfa-panel role="status">Verificando fatores cadastrados…</div>${locked ? '' : '<h3>Registros antigos do navegador</h3><p class="nx-muted">Dados antigos não são enviados automaticamente ao banco. Você pode exportá-los para revisão, sem alterar os registros atuais.</p><button class="button outline" type="button" data-action="export-legacy">Exportar dados locais antigos</button>'}</article></form>`);
    loadMfaPanel();
  }
  async function loadMfaPanel() {
    const panel = main.querySelector('[data-mfa-panel]');
    if (!panel) return;
    try {
      const { data, error } = await window.nexoraSupabase.auth.mfa.listFactors();
      if (error) throw error;
      const factors = data?.totp || [], verified = factors.filter(item => item.status === 'verified'), pending = factors.filter(item => item.status !== 'verified');
      if (verified.length) {
        panel.innerHTML = `<p><span class="nx-status paid">Ativa</span> · Aplicativo autenticador${verified.length > 1 ? ` (${verified.length} dispositivos)` : ''}</p><p class="nx-muted">Sua conta está protegida com verificação em duas etapas. Cadastre um segundo autenticador antes de trocar de aparelho para manter o acesso seguro.</p><button class="button outline" type="button" data-action="mfa-enroll">+ Adicionar outro autenticador</button>`;
      } else {
        panel.innerHTML = `<p><span class="nx-status pending">${pending.length ? 'Configuração pendente' : 'Proteção de conta adicional · ainda não configurada'}</span></p>${pending.map(factor => `<button class="button outline" type="button" data-action="mfa-remove-pending" data-factor-id="${e(factor.id)}">Limpar tentativa anterior</button>`).join('')}<button class="button button-primary" type="button" data-action="mfa-enroll">Ativar com aplicativo autenticador</button><p class="nx-muted">Use um aplicativo autenticador compatível com TOTP (Google Authenticator, Microsoft Authenticator, 1Password, etc.).</p>`;
      }
    } catch (error) { panel.innerHTML = `<p class="nx-form-error">Não foi possível consultar a autenticação: ${e(error.message || 'erro desconhecido')}.</p>`; }
  }
  async function enrollMfa() {
    try {
      const { data: factorList } = await window.nexoraSupabase.auth.mfa.listFactors();
      const unverified = (factorList?.totp || []).filter(item => item.status !== 'verified');
      for (const f of unverified) {
        await window.nexoraSupabase.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
      }
    } catch (_) {}
    const userEmail = window.nexoraSessionUser?.email || 'lojista';
    const { data, error } = await window.nexoraSupabase.auth.mfa.enroll({
      factorType: 'totp',
      issuer: 'Nexora Pay',
      friendlyName: userEmail,
    });
    if (error) throw new Error(API.errorMessage(error));
    const factorId = data.id, qr = data.totp?.qr_code, secret = data.totp?.secret;
    if (!factorId || !qr || !secret) throw new Error('O Supabase não retornou os dados do autenticador.');
    let enrolled = false;
    const dialog = UI.modal('Ativar autenticação em duas etapas', `<p>Escaneie o QR com seu aplicativo autenticador. Se preferir, adicione a chave manualmente.</p><div data-mfa-qr style="display:grid;place-items:center;padding:12px;background:#fff;border-radius:12px;min-height:180px"></div><p><b>Chave manual:</b> <code data-mfa-secret></code></p><label class="nx-field">Código de 6 dígitos<input name="mfa-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000" autofocus></label><p class="nx-muted">Digite o código gerado no aplicativo para confirmar a ativação.</p>`, async modal => {
      const code = (modal.querySelector('[name="mfa-code"]')?.value || '').replace(/\D/g, '').trim();
      if (code.length !== 6) throw new Error('Informe o código de 6 dígitos do autenticador.');
      const { data: challenge, error: challengeError } = await window.nexoraSupabase.auth.mfa.challenge({ factorId });
      if (challengeError) throw new Error(API.errorMessage(challengeError));
      const { error: verifyError } = await window.nexoraSupabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
      if (verifyError) throw new Error('Código incorreto ou expirado. Verifique o aplicativo e tente novamente.');
      enrolled = true;
      await loadMfaPanel(); UI.toast('Autenticação em duas etapas ativada com sucesso.');
    }, { submitLabel: 'Confirmar e ativar' });
    dialog.addEventListener('close', () => {
      if (!enrolled) {
        window.nexoraSupabase.auth.mfa.unenroll({ factorId }).catch(() => {}).finally(() => loadMfaPanel());
      }
    }, { once: true });
    const image = document.createElement('img'); image.alt = 'QR de configuração do autenticador'; image.width = 160; image.height = 160; image.src = qr; image.style.maxWidth = '100%';
    dialog.querySelector('[data-mfa-qr]').append(image); dialog.querySelector('[data-mfa-secret]').textContent = secret;
    dialog.querySelector('[name="mfa-code"]').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
  }
  async function saveSettings(values = {}) {
    await mutation('nexora_save_settings', { p_profile_name: values.profile_name || name(), p_workspace_name: values.workspace_name || state.business_name, p_alerts: values.alerts ?? (state.settings.alerts !== false), p_chart_range: values.chart_range || state.settings.chart_range || 'Últimos 6 meses' }, 'Configurações salvas no Supabase.');
  }
  function account() {
    main.innerHTML = shell('Minha conta', 'Seu perfil e acesso à Nexora Pay.', `<div class="account-grid"><article class="account-card"><h2>${e(name())}</h2><p>${e(window.nexoraSessionUser.email)}</p><span class="role-pill">Conta principal do workspace</span></article><article class="account-card"><h2>${e(state.business_name)}</h2><p>Acesso sem planos ou mensalidade.</p><button class="button outline" data-action="configuracoes">Gerenciar workspace</button></article><article class="account-card"><h2>Segurança</h2><p>Autenticação gerenciada pelo Supabase.</p><button class="button outline" data-action="password">Alterar senha</button></article></div>`);
  }
  function integrations() {
    if (!canOperate()) { main.innerHTML = shell('Integrações', 'Complete o cadastro para liberar esta área.', '<div class="nx-empty">Complete o cadastro.</div>'); return; }
    main.innerHTML = shell('Integrações', 'Consulte os meios de pagamento disponíveis e a conexão da sua conta.', '<div class="nx-empty">Carregando configuração da conta…</div>');
    API.rpc('nexora_get_merchant_setup').then(setup => { integrationSetup = setup; renderIntegrations(); }).catch(() => {
      main.innerHTML = shell('Integrações', 'Não foi possível carregar sua conexão de pagamentos.', '<div class="nx-empty">Tente atualizar a página. Se o problema continuar, fale com o suporte.</div>');
    });
  }
  function renderIntegrations() {
    const setup = integrationSetup || {}, connection = setup.connection || {}, controls = setup.controls || {};
    const production = connection.environment === 'production';
    const connectionStatus = ({pending:'Validando conexão',active:'Conectado',disabled:'Desativado',error:'Ajuste necessário'}[connection.status] || 'Operação ativa');
    const body = `<section class="integration-grid"><article><h3>Conexão de pagamentos</h3><p>Gerenciada pela Nexora para sua conta.</p><span class="nx-status ${connection.status === 'active' ? 'paid' : 'pending'}">${e(connectionStatus)}</span><small>${connection.environment === 'sandbox' ? 'Ambiente de testes' : production ? 'Ambiente de produção' : ''}</small></article><article><h3>Recebimentos</h3><p>${paymentsReady() ? 'Cobranças disponíveis para sua conta.' : e(paymentReadinessMessage())}</p></article><article><h3>Saques</h3><p>${controls.withdrawals_enabled ? 'Saques via Pix liberados para sua conta.' : 'Disponível após ativação da conta.'}</p><small>Transferências são processadas via Pix para a mesma titularidade da conta.</small></article></section>
      <article class="settings-card"><h2>Integração de pagamentos</h2><p>As credenciais são protegidas e administradas pela Nexora. Esta conta não pode visualizar nem substituir chaves.</p>${paymentsReady() ? `<p class="nx-status paid">Conexão ativa</p><button class="button outline" type="button" data-action="test-connection">Testar conexão</button> <button class="button button-primary" type="button" data-action="new-charge">Criar cobrança</button>` : `<p class="nx-muted">${e(paymentReadinessMessage())} Se o bloqueio persistir, fale com o suporte.</p>`}</article>
      <article class="settings-card"><h2>Chaves de API</h2><p>Chaves para integração de checkout e cobranças via API pública. Guarde sua chave com segurança no servidor.</p><button type="button" class="button button-primary" data-action="api-key-create">Criar chave</button><div data-merchant-api-keys><p class="nx-muted" role="status">Carregando chaves…</p></div></article>
      ${production ? '<div class="nx-banner"><b>Cobranças reais</b><span>Confira valor, recebedor e descrição antes de compartilhar o pagamento.</span></div>' : '<div class="nx-banner"><b>Ambiente de testes</b><span>As cobranças não movimentam dinheiro real.</span></div>'}`;
    main.innerHTML = shell('Integrações', 'Veja os recursos disponíveis para sua conta.', body);
    loadMerchantApiKeys();
  }
  async function merchantApiKeyRequest(body) {
    const { data, error } = await window.nexoraSupabase.functions.invoke('nexora-merchant-api-keys', { body });
    if (error) {
      let payload = {};
      try { payload = await error.context?.clone?.json() || {}; } catch (_) {}
      throw new Error(payload.error || API.errorMessage(error));
    }
    if (!data || data.error) throw new Error(data?.error || 'Não foi possível gerenciar a chave da API.');
    return data;
  }
  function showMerchantApiKey(secret) {
    const dialog = UI.modal('Guarde sua chave de API', `<p class="nx-banner"><b>Exibida uma única vez</b><span>Copie agora e armazene no seu servidor em local seguro.</span></p><label class="nx-field">Chave<textarea data-api-key-secret readonly rows="3" autocomplete="off" spellcheck="false">${e(secret)}</textarea></label><button type="button" class="button outline" data-copy-api-key>Copiar chave</button>`);
    dialog.querySelector('[data-copy-api-key]').onclick = async () => {
      const input = dialog.querySelector('[data-api-key-secret]');
      try { await navigator.clipboard.writeText(input.value); UI.toast('Chave copiada. Guarde-a em local seguro.'); }
      catch (_) { input.focus(); input.select(); UI.toast('Chave selecionada. Copie e guarde em local seguro.'); }
    };
    return dialog;
  }
  async function loadMerchantApiKeys() {
    const target = main.querySelector('[data-merchant-api-keys]');
    if (!target || !state.business_id) return;
    try {
      const { keys } = await merchantApiKeyRequest({ action: 'list', business_id: state.business_id });
      target.innerHTML = keys.length ? `<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Chave</th><th>Ambiente</th><th>Escopos</th><th>Status</th><th>Uso</th><th>Ações</th></tr></thead><tbody>${keys.map(key => `<tr><td><b>${e(key.name)}</b><br><code>${e(key.key_prefix)}…</code></td><td>${key.environment === 'production' ? 'Produção' : 'Sandbox'}</td><td>${key.scopes.map(e).join(', ')}</td><td><span class="nx-status ${key.status === 'active' ? 'paid' : 'pending'}">${key.status === 'active' ? 'Ativa' : 'Revogada'}</span></td><td>${key.last_used_at ? e(C.date(key.last_used_at)) : 'Nunca'}</td><td>${key.status === 'active' ? `<button type="button" class="button outline compact" data-api-key-rotate="${e(key.id)}">Rotacionar</button> <button type="button" class="button outline compact" data-api-key-revoke="${e(key.id)}">Revogar</button>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="nx-empty">Nenhuma chave criada.</div>';
    } catch (error) { target.innerHTML = `<p class="nx-form-error" role="alert">${e(error.message)}</p>`; }
  }
  function createMerchantApiKey() {
    const scopeOptions = ['payments:read', 'payments:write'];
    return UI.modal('Criar chave de API', `<p class="nx-muted">As chaves são segredos de servidor e serão exibidas só uma vez.</p>${field('Nome da chave', '<input name="name" maxlength="80" required placeholder="Integração da loja">')}${field('Ambiente', '<select name="environment"><option value="sandbox">Sandbox</option><option value="production">Produção</option></select>')}<fieldset class="nx-webhook-event"><legend>Escopos</legend>${scopeOptions.map((scope, i) => `<label><input type="checkbox" name="scopes" value="${scope}" ${i === 0 ? 'checked' : ''}> ${scope}</label>`).join('')}</fieldset>`, async modal => {
      const data = new FormData(modal.querySelector('form'));
      const scopes = data.getAll('scopes').map(String);
      if (!scopes.length) { UI.toast('Selecione ao menos um escopo.'); return false; }
      const result = await merchantApiKeyRequest({ action: 'create', business_id: state.business_id, name: String(data.get('name') || '').trim(), environment: String(data.get('environment') || 'sandbox'), scopes });
      await loadMerchantApiKeys();
      modal.querySelector('.nx-dialog-body').innerHTML = `<p class="nx-banner"><b>Copie e guarde agora</b><span>Esta chave não poderá ser consultada novamente.</span></p><label class="nx-field">Chave<textarea data-api-key-secret readonly rows="3" spellcheck="false">${e(result.secret)}</textarea></label><button type="button" class="button outline" data-copy-api-key>Copiar chave</button>`;
      modal.querySelector('[type="submit"]').hidden = true;
      modal.querySelector('.nx-cancel').textContent = 'Concluir';
      modal.querySelector('[data-copy-api-key]').onclick = async () => { const input = modal.querySelector('[data-api-key-secret]'); try { await navigator.clipboard.writeText(input.value); UI.toast('Chave copiada. Guarde-a em local seguro.'); } catch (_) { input.focus(); input.select(); UI.toast('Chave selecionada. Copie e guarde em local seguro.'); } };
      return false;
    }, { submitLabel: 'Criar chave' });
  }
  async function rotateMerchantApiKey(keyId) {
    UI.confirm('Rotacionar chave de API?', 'A chave atual será revogada imediatamente. Atualize sua integração com a nova chave antes de continuar.', async () => {
      const key = (await merchantApiKeyRequest({ action: 'list', business_id: state.business_id })).keys.find(item => item.id === keyId);
      if (!key) throw new Error('Chave não encontrada.');
      const result = await merchantApiKeyRequest({ action: 'rotate', key_id: keyId, environment: key.environment });
      showMerchantApiKey(result.secret); await loadMerchantApiKeys();
    }, 'Rotacionar chave');
  }
  function revokeMerchantApiKey(keyId) {
    UI.confirm('Revogar chave de API?', 'A chave deixa de autenticar novas chamadas imediatamente. Essa ação não pode ser desfeita.', async () => {
      await merchantApiKeyRequest({ action: 'revoke', key_id: keyId }); await loadMerchantApiKeys(); UI.toast('Chave revogada.');
    }, 'Revogar chave');
  }
  async function webhookRequest(body) {
    const { data, error } = await window.nexoraSupabase.functions.invoke('nexora-merchant-webhooks', { body });
    if (error) {
      let payload = {};
      try { payload = await error.context?.clone?.().json() || {}; } catch (_) {}
      throw new Error(payload.error || API.errorMessage(error));
    }
    if (!data || data.error) throw new Error(data?.error || 'Não foi possível executar a ação de webhook.');
    return data;
  }
  function showWebhookSecret(secret, title = 'Segredo do webhook') {
    const dialog = UI.modal(title, `<p class="nx-banner"><b>Copie e guarde agora</b><span>Por segurança, este segredo será exibido somente desta vez. Configure-o no seu servidor para verificar as assinaturas HMAC-SHA256.</span></p><label class="nx-field">Segredo<textarea data-webhook-secret readonly rows="3" autocomplete="off">${e(secret)}</textarea></label><button type="button" class="button outline" data-copy-webhook-secret>Copiar segredo</button>`);
    dialog.querySelector('[data-copy-webhook-secret]').onclick = async () => {
      const input = dialog.querySelector('[data-webhook-secret]');
      try { await navigator.clipboard.writeText(input.value); UI.toast('Segredo copiado. Guarde-o em local seguro.'); }
      catch (_) { input.focus(); input.select(); UI.toast('Segredo selecionado. Copie e guarde em local seguro.'); }
    };
    return dialog;
  }
  async function loadWebhookEndpoints() {
    const target = main.querySelector('[data-webhook-endpoints]');
    if (!target) return;
    target.innerHTML = '<p class="nx-muted" role="status">Carregando endpoints…</p>';
    try {
      const { endpoints } = await webhookRequest({ action: 'list', business_id: state.business_id });
      target.innerHTML = endpoints.length ? `<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Endpoint</th><th>Eventos</th><th>Status</th><th>Ações</th></tr></thead><tbody>${endpoints.map(item => `<tr><td><code>${e(item.endpoint_url)}</code></td><td>${item.subscribed_events.map(e).join(', ')}</td><td><span class="nx-status ${item.status === 'active' ? 'paid' : 'pending'}">${item.status === 'active' ? 'Ativo' : 'Desativado'}</span></td><td>${item.status === 'active' ? `<button class="button outline compact" data-webhook-rotate="${e(item.id)}">Gerar novo segredo</button> <button class="button outline compact" data-webhook-disable="${e(item.id)}">Desativar</button>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="nx-empty">Nenhum endpoint cadastrado.</div>';
    } catch (error) { target.innerHTML = `<p class="nx-form-error" role="alert">${e(error.message)}</p>`; }
  }
  function webhooks() {
    if (!canOperate()) { main.innerHTML = shell('Webhooks', 'Complete o cadastro para liberar esta área.', '<div class="nx-empty">Complete o cadastro.</div>'); return; }
    main.innerHTML = shell('Webhooks', 'Conecte seu sistema para receber notificações em tempo real.', `<article class="settings-card"><h2>Notificações do seu sistema</h2><p>A Nexora envia eventos via webhook quando um pagamento é confirmado, falha ou expira. A assinatura é HMAC-SHA256 com timestamp; responda HTTP 2xx para confirmar a entrega.</p><p class="nx-muted">Nunca compartilhe o segredo no navegador ou cliente público. As entregas podem ser repetidas em caso de instabilidade; deduplique pelo <code>event_id</code>.</p><button type="button" class="button button-primary" data-action="webhook-create">+ Adicionar endpoint</button></article><article class="settings-card"><h2>Endpoints configurados</h2><div data-webhook-endpoints><p role="status">Carregando…</p></div></article>`);
    loadWebhookEndpoints();
  }
  function createWebhookEndpoint() {
    const dialog = UI.modal('Adicionar endpoint de webhook', `<p class="nx-muted">Informe uma URL HTTPS pública do seu servidor e selecione os eventos necessários.</p>${field('URL HTTPS', '<input name="endpoint_url" type="url" inputmode="url" autocomplete="url" placeholder="https://sualoja.com.br/webhooks/nexora" maxlength="2048" required>')}<fieldset class="nx-webhook-event"><legend>Eventos</legend><label><input type="checkbox" name="webhook_events" value="payment.succeeded" checked> Pagamento aprovado (<code>payment.succeeded</code>)</label><label><input type="checkbox" name="webhook_events" value="payment.failed"> Pagamento rejeitado (<code>payment.failed</code>)</label><label><input type="checkbox" name="webhook_events" value="payment.canceled"> Pagamento cancelado ou expirado (<code>payment.canceled</code>)</label></fieldset>`, async modal => {
      const endpointUrl = String(new FormData(modal.querySelector('form')).get('endpoint_url') || '').trim();
      const events = [...modal.querySelectorAll('input[name="webhook_events"]:checked')].map(input => input.value);
      if (!events.length) { UI.toast('Selecione pelo menos um evento.'); return false; }
      const result = await webhookRequest({ action: 'create', business_id: state.business_id, endpoint_url: endpointUrl, events });
      await loadWebhookEndpoints();
      modal.querySelector('.nx-dialog-body').innerHTML = `<p class="nx-banner"><b>Endpoint salvo</b><span>Configure este segredo no seu servidor agora. A Nexora não poderá mostrá-lo novamente.</span></p><label class="nx-field">Segredo<textarea data-webhook-secret readonly rows="3">${e(result.secret)}</textarea></label><button type="button" class="button outline" data-copy-webhook-secret>Copiar segredo</button>`;
      modal.querySelector('[type="submit"]').hidden = true;
      modal.querySelector('.nx-cancel').textContent = 'Concluir';
      modal.querySelector('[data-copy-webhook-secret]').onclick = async () => {
        const input = modal.querySelector('[data-webhook-secret]');
        try { await navigator.clipboard.writeText(input.value); UI.toast('Segredo copiado. Guarde-o em local seguro.'); }
        catch (_) { input.focus(); input.select(); UI.toast('Segredo selecionado. Copie e guarde em local seguro.'); }
      };
      return false;
    }, { submitLabel: 'Criar endpoint' });
    return dialog;
  }
  async function rotateWebhookSecret(endpointId) {
    UI.confirm('Gerar novo segredo?', 'O segredo atual deixa de funcionar imediatamente. Atualize o servidor da sua loja antes de confirmar recebimentos.', async () => {
      const result = await webhookRequest({ action: 'rotate', endpoint_id: endpointId });
      showWebhookSecret(result.secret, 'Novo segredo do webhook');
      await loadWebhookEndpoints();
    }, 'Gerar novo segredo');
  }
  function disableWebhookEndpoint(endpointId) {
    UI.confirm('Desativar endpoint?', 'Novas notificações deixarão de ser enviadas para esta URL. Entregas pendentes também serão encerradas.', async () => {
      await webhookRequest({ action: 'disable', endpoint_id: endpointId });
      await loadWebhookEndpoints(); UI.toast('Endpoint desativado.');
    }, 'Desativar endpoint');
  }
  async function testProviderConnection(button) {
    button.disabled = true; const original = button.textContent; button.textContent = 'Testando…';
    try {
      const result = await invokeProviderPayment({ action: 'test_connection' });
      UI.toast(result.connected ? 'Conexão validada com sucesso.' : 'Não foi possível validar a conexão.');
    } catch (error) { UI.toast(error.message); }
    finally { if (button.isConnected) { button.disabled = false; button.textContent = original; } }
  }
  function help() {
    main.innerHTML = shell('Ajuda e suporte', 'Orientações sobre sua operação.', `<article class="settings-card"><h2>Como usar</h2><ol><li>Organize e gerencie seus clientes no painel.</li><li>Crie cobranças instantâneas via Pix ou Cartão de crédito.</li><li>Acompanhe seus recebimentos em tempo real no extrato financeiro.</li><li>Transfira seus saldos via Pix direto para sua conta bancária cadastrada.</li></ol><h3>Suporte</h3><p data-support-contact>Precisa de suporte? Entre em contato pelo e-mail <a href="mailto:suporte@nexorapay.me">suporte@nexorapay.me</a> ou pelo WhatsApp oficial.</p><a class="nx-link" href="privacidade.html">Privacidade e proteção de dados</a></article>`); window.NexoraSite?.apply();
  }
  function notifications() {
    if (!canOperate()) return UI.modal('Notificações', '<p>Complete o cadastro para liberar esta área.</p><a class="button button-primary compact" href="onboarding.html">Complete o cadastro</a>');
    if (state.settings.alerts === false) return UI.modal('Notificações', '<p>As notificações estão desativadas. Você pode ativá-las em Configurações.</p>');
    const read = new Date(state.settings.notifications_read_at || 0);
    UI.modal('Notificações de movimentações', `${state.transactions.slice(0, 20).map((item) => `<button type="button" class="nx-activity" data-notification-tx="${e(item.id)}"><span><b>${e(item.title)}${new Date(item.paid_at || item.created_at) > read ? ' · Nova' : ''}</b><small>${e(C.date(item.paid_at || item.created_at))} · ${money(item.amount)}</small></span>${status(item)}</button>`).join('') || '<p>Nenhuma movimentação ainda.</p>'}`, async () => { await mutation('nexora_read_notifications', {}, 'Notificações marcadas como lidas.'); }, { submitLabel: 'Marcar como lidas' });
  }
  function download(text, file, type = 'text/csv;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a');
    a.href = url; a.download = file; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportLegacy() {
    let saved; try { saved = localStorage.getItem(`nexora-demo-v4:${window.nexoraSessionUser.id}`); } catch { /* Do not read other accounts. */ }
    if (!saved) return UI.toast('Nenhum registro antigo neste navegador para sua conta.');
    download(saved, 'nexora-registros-locais-para-revisao.json', 'application/json');
  }
  document.addEventListener('click', async (event) => {
    const transactionTab = event.target.closest('[data-transaction-view]');
    if (transactionTab) {
      transactionView = transactionTab.dataset.transactionView === 'receipts' ? 'receipts' : 'charges';
      const targetHash = transactionView === 'receipts' ? '#recebimentos' : '#transacoes';
      if (location.hash !== targetHash) location.hash = targetHash; else transactions();
      return;
    }
    const statementFilterBtn = event.target.closest('[data-statement-filter]');
    if (statementFilterBtn) {
      statementFilter = statementFilterBtn.dataset.statementFilter;
      renderStatement();
      return;
    }
    const statementDetailEl = event.target.closest('[data-statement-detail]');
    if (statementDetailEl) {
      const journalId = statementDetailEl.dataset.statementDetail;
      const row = statement.rows.find(r => r.journal_id === journalId);
      if (row) { showStatementDetailModal(row); return; }
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action) {
      event.preventDefault(); if (action === 'refresh') return refresh(); if (routes[action]) return showView(action); if (!state) return;
      if (action === 'statement-more') return loadStatement({ append: true });
      if (action === 'statement-refresh') return loadStatement();
      if (action === 'statement-export') {
        if (!statement.rows.length || statement.loading) return UI.toast('Carregue os lançamentos antes de exportar.');
        try { download(C.ledgerCsv(statement.rows), `nexora-extrato-ledger-${new Date().toISOString().slice(0, 10)}.csv`); }
        catch (error) { UI.toast(error.message || 'Não foi possível exportar o extrato.'); }
        return;
      }
      if (action === 'payout-more') return loadMorePayouts();
      if (action === 'request-payout') return requestPayout().catch(error => UI.toast(error.message || 'Não foi possível abrir a solicitação de saque.'));
      if (action === 'mfa-enroll') return enrollMfa().catch(error => UI.toast(error.message || 'Não foi possível iniciar a autenticação.'));
      if (action === 'webhook-create') return createWebhookEndpoint();
      if (action === 'api-key-create') return createMerchantApiKey();
      if (action === 'test-connection') return testProviderConnection(event.target.closest('[data-action="test-connection"]'));
      if (action === 'mfa-remove-pending') {
        const factorId = event.target.closest('[data-factor-id]').dataset.factorId;
        return UI.confirm('Cancelar configuração incompleta?', 'O fator não verificado será removido. Você poderá iniciar novamente depois.', async () => {
          const { error } = await window.nexoraSupabase.auth.mfa.unenroll({ factorId });
          if (error) throw new Error(API.errorMessage(error));
          await loadMfaPanel(); UI.toast('Configuração incompleta removida.');
        }, 'Remover configuração');
      }
      if (action === 'new-charge') return newRecord(); if (action === 'withdraw') return withdraw(); if (action === 'new-customer') return saveCustomer();
      if (action === 'clear-filters') { filter = { query: '', status: '', from: '', to: '' }; transactions(); return; }
      if (action === 'search') { filter = { query: '', status: '', from: '', to: '' }; showView('transacoes'); setTimeout(() => main.querySelector('[data-filter=query]')?.focus(), 0); return; }
      if (action === 'notifications') return notifications();
      if (action === 'password') return UI.confirm('Enviar recuperação de senha?', 'Um link será enviado para o e-mail da sua conta.', async () => {
        const { error } = await window.nexoraSupabase.auth.resetPasswordForEmail(window.nexoraSessionUser.email, { redirectTo: `${location.origin}/auth.html?mode=reset` });
        if (error) throw new Error(API.errorMessage(error)); UI.toast('Solicitação enviada. Confira sua caixa de entrada.');
      }, 'Enviar link');
      if (action === 'logout') return UI.confirm('Sair da conta?', 'Você precisará entrar novamente.', UI.logout, 'Sair');
      if (action === 'export') return download(C.csv(selectedRows()), `nexora-extrato-${new Date().toISOString().slice(0, 10)}.csv`);
      if (action === 'export-legacy') return exportLegacy();
    }
    const rotateWebhook = event.target.closest('[data-webhook-rotate]')?.dataset.webhookRotate;
    if (rotateWebhook) return rotateWebhookSecret(rotateWebhook);
    const disableWebhook = event.target.closest('[data-webhook-disable]')?.dataset.webhookDisable;
    if (disableWebhook) return disableWebhookEndpoint(disableWebhook);
    const rotateApiKey = event.target.closest('[data-api-key-rotate]')?.dataset.apiKeyRotate;
    if (rotateApiKey) return rotateMerchantApiKey(rotateApiKey);
    const revokeApiKey = event.target.closest('[data-api-key-revoke]')?.dataset.apiKeyRevoke;
    if (revokeApiKey) return revokeMerchantApiKey(revokeApiKey);
    if (event.target.closest('[data-save-withdrawal-mode]')) {
      if (!requireKyc()) return;
      const output = main.querySelector('[data-withdrawal-message]');
      try { await API.rpc('nexora_set_withdrawal_preference',{p_mode:main.querySelector('[data-withdrawal-mode]').value}); integrationSetup = await API.rpc('nexora_get_merchant_setup'); renderIntegrations(); UI.toast('Preferência de saque salva.'); }
      catch (error) { if (output) output.textContent = error.message; }
      return;
    }
    const txId = event.target.closest('[data-transaction],[data-notification-tx]')?.dataset;
    if (txId) { const item = state?.transactions.find((row) => row.id === (txId.transaction || txId.notificationTx)); if (item) transactionDetails(item); }
    const payment = event.target.closest('[data-confirm-payment]')?.dataset.confirmPayment;
    if (payment) UI.toast('Somente pagamentos confirmados aparecem no extrato.');
    const edit = event.target.closest('[data-edit-customer]')?.dataset.editCustomer; if (edit) saveCustomer(state.customers.find((item) => item.id === edit));
    const customer = event.target.closest('[data-customer]')?.dataset.customer;
    if (customer) { filter = { query: '', status: '', from: '', to: '', customer_id: customer }; showView('transacoes'); }
  });
  document.addEventListener('keydown', (event) => {
    const current = event.target.closest?.('[data-transaction-view]');
    if (!current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...current.closest('[role="tablist"]').querySelectorAll('[data-transaction-view]')];
    const index = tabs.indexOf(current);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
    setTimeout(() => main.querySelector(`[data-transaction-view="${tabs[next].dataset.transactionView}"]`)?.focus(), 0);
  });
  main.addEventListener('input', (event) => { if (event.target.dataset.filter) { filter[event.target.dataset.filter] = event.target.value; renderTransactionRows(); } if (event.target.matches('[data-customer-search]')) renderCustomers(event.target.value); });
  main.addEventListener('change', (event) => {
    if (event.target.dataset.filter) { filter[event.target.dataset.filter] = event.target.value; renderTransactionRows(); }
    if (event.target.matches('[data-chart-range]')) { const requested = event.target.value; event.target.disabled = true; saveSettings({ chart_range: requested }).catch((error) => { UI.toast(error.message); render(); }); }
  });
  main.addEventListener('submit', async (event) => {
    if (!event.target.matches('[data-settings]')) return;
    event.preventDefault(); const form = event.target; if (!requireKyc() || !form.reportValidity() || form.dataset.busy) return;
    form.dataset.busy = 'true'; const button = form.querySelector('[type=submit]'); button.disabled = true; const values = new FormData(form);
    try { await saveSettings({ profile_name: values.get('profile_name').trim(), workspace_name: values.get('workspace_name').trim(), alerts: values.has('alerts') }); }
    catch (error) { form.querySelector('[data-settings-message]').textContent = error.message; }
    finally { delete form.dataset.busy; button.disabled = false; }
  });
  window.NexoraPlatform = { getState: () => state || { transactions: [], customers: [], settings: {} }, refreshOverview: () => { if (state) render(); }, showView, showAccount: () => showView('conta'), toast: UI.toast, confirm: UI.confirm, refresh };
  window.addEventListener('hashchange', render);
  window.addEventListener('nexora-access-ready', () => {
    if (loadedUser && loadedUser !== window.nexoraSessionUser?.id) {
      state = null; loadError = ''; loadedUser = null; resetStatement();
    }
    if (state) render();
    refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]') && !document.querySelector('[data-settings]')) refresh({ silent: true }); }, 60000);
  });
  if (document.documentElement.dataset.nexoraAccess === 'ready') refresh();
})();

(function () {
  'use strict';
  const target = document.querySelector('#checkout-content');
  const token = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash).get('token')
    || new URLSearchParams(location.search).get('token') || '';
  let orderToken = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash).get('order')
    || new URLSearchParams(location.search).get('order') || '';
  const config = window.NEXORA_SUPABASE_CONFIG;
  const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const money = cents => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(cents) / 100);
  let client, snapshot, busy = false, loadingView = false, refreshTimer, retryTimer;

  function showError(message, { canRetry = false, retryAfter = 0 } = {}) {
    clearInterval(retryTimer); retryTimer = null;
    target.setAttribute('aria-busy', 'false');
    target.innerHTML = `<p class="checkout-error" role="alert">${safe(message)}</p>${canRetry ? `<p class="checkout-message" data-retry-status role="status">${retryAfter > 0 ? `Nova consulta disponível em ${retryAfter} s.` : 'Você pode tentar consultar novamente.'}</p><button class="checkout-button" type="button" data-retry-view ${retryAfter > 0 ? 'disabled' : ''}>${retryAfter > 0 ? `Aguarde ${retryAfter} s…` : 'Tentar novamente'}</button>` : ''}`;
    const retry = target.querySelector('[data-retry-view]');
    if (retry) {
      retry.onclick = () => load();
      if (retryAfter > 0) {
        let remaining = retryAfter;
        retryTimer = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(retryTimer); retryTimer = null;
            retry.disabled = false; retry.textContent = 'Tentar novamente';
            const status = target.querySelector('[data-retry-status]');
            if (status) status.textContent = 'Você pode tentar consultar novamente.';
          } else {
            retry.textContent = `Aguarde ${remaining} s…`;
            const status = target.querySelector('[data-retry-status]');
            if (status) status.textContent = `Nova consulta disponível em ${remaining} s.`;
          }
        }, 1000);
      }
    }
  }
  async function invoke(body) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Tempo limite esgotado ao conectar com o servidor. Verifique sua conexão e tente novamente.')), 25000);
    });
    try {
      const invokePromise = client.functions.invoke('nexora-checkout', { body });
      const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
      if (error) {
        let payload = {};
        if (error && typeof error.error === 'object' && error.error !== null) {
          payload = error.error;
        } else if (error && typeof error.error === 'string') {
          try { payload = JSON.parse(error.error); } catch (_) { payload = { error: error.error }; }
        }
        if (!payload?.error && error?.context) {
          try { payload = await error.context.clone().json(); } catch (_) {
            try { payload = await error.context.json(); } catch (_) {}
          }
        }
        const failure = new Error(payload.error || error.message || 'Não foi possível consultar o checkout. Tente novamente.');
        const retryAfter = Number(error.context?.headers?.get?.('Retry-After'));
        if (Number.isSafeInteger(retryAfter) && retryAfter > 0 && retryAfter <= 3600) failure.retryAfter = retryAfter;
        throw failure;
      }
      if (!data || data.error) throw new Error(data?.error || 'Não foi possível consultar o checkout.');
      return data;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  function paidReceiptMarkup(data) {
    const payment = data.payment || {};
    const paidAt = new Date().toLocaleString('pt-BR');
    const txId = payment.transaction_id || payment.provider_reference || data.id || 'NEX-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    return `
      <div class="checkout-receipt-card" role="status">
        <div class="checkout-success-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
        <h2 class="checkout-success-title">Pagamento Confirmado!</h2>
        <p class="checkout-success-subtitle">Seu pagamento foi processado e confirmado com sucesso.</p>

        <div class="checkout-receipt-box">
          <div class="receipt-header">
            <span class="receipt-label">Comprovante de Pagamento</span>
            <span class="receipt-badge">Aprovado</span>
          </div>

          <div class="receipt-amount-row">
            <span class="receipt-label">Valor pago</span>
            <strong class="receipt-amount">${money(data.amount_cents)}</strong>
          </div>

          <hr class="receipt-divider">

          <div class="receipt-grid">
            <div class="receipt-item">
              <span class="receipt-label">Beneficiário</span>
              <strong class="receipt-value">${safe(data.merchant_name || 'Lojista Nexora')}</strong>
            </div>
            <div class="receipt-item">
              <span class="receipt-label">Descrição</span>
              <span class="receipt-value">${safe(data.description || 'Cobrança')}</span>
            </div>
            <div class="receipt-item">
              <span class="receipt-label">Método</span>
              <span class="receipt-value">${(payment.method === 'credit_card' || payment.card_brand || payment.card_last_digits) ? `<span class="card-badge">💳 Cartão</span> ${safe(payment.card_brand || 'Crédito')}${payment.card_last_digits ? ` •••• ${safe(payment.card_last_digits)}` : ''}${payment.installments ? ` em ${Number(payment.installments)}x` : ''}` : (payment.pix_copy_paste || payment.pix_encoded_image ? '<span class="pix-badge">Pix</span> Instantâneo' : 'Pagamento online')}</span>
            </div>
            <div class="receipt-item">
              <span class="receipt-label">Data e Hora</span>
              <span class="receipt-value">${paidAt}</span>
            </div>
            <div class="receipt-item receipt-full">
              <span class="receipt-label">Identificador</span>
              <code class="receipt-code">${safe(txId)}</code>
            </div>
          </div>
        </div>

        <div class="receipt-actions">
          <button type="button" class="checkout-button outline" onclick="window.print()">
            Imprimir Comprovante
          </button>
          <button type="button" class="checkout-button" data-new-payment style="margin-top:0.75rem">
            Fazer Novo Pagamento / Comprar Novamente
          </button>
        </div>

        <div class="receipt-security-note">
          Transação intermediada com segurança pela Nexora Pay.
        </div>
      </div>
    `;
  }

  function failedPaymentMarkup(data, view) {
    const payment = data.payment || {};
    const isCard = payment.method === 'credit_card' || view.isCard || view.method === 'credit_card';
    const reason = payment.provider_status === 'rejected'
      ? (isCard
          ? 'A transação foi recusada pelo banco emissor do cartão de crédito (limite insuficiente, bloqueio de segurança ou dados incorretos).'
          : 'A transação Pix foi recusada pelo adquirente ou banco (bloqueio de segurança, CPF ou chave Pix).')
      : (view.statusMessage || (isCard ? 'O pagamento com cartão não foi aprovado.' : 'O pagamento não foi aprovado.'));
    return `
      <div class="checkout-failed-card" role="alert">
        <div class="checkout-failed-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
        </div>
        <h2 class="checkout-failed-title">${isCard ? 'Cartão Não Autorizado' : 'Pagamento Não Autorizado'}</h2>
        <p class="checkout-failed-subtitle">${safe(reason)}</p>

        <div class="checkout-failed-box">
          <div class="receipt-amount-row">
            <span class="receipt-label">Valor da cobrança</span>
            <strong class="receipt-amount">${money(data.amount_cents)}</strong>
          </div>
          <p class="checkout-failed-instruction">
            ${isCard
              ? 'Você pode tentar novamente utilizando outro cartão de crédito ou concluir o pagamento instantaneamente via Pix.'
              : 'Você pode tentar novamente gerando uma nova cobrança Pix ou pagar com cartão de crédito.'}
          </p>
        </div>

        <div class="checkout-failed-actions">
          ${isCard ? `
          <button type="button" class="checkout-button" data-retry-card>
            💳 Tentar outro Cartão de Crédito
          </button>
          <button type="button" class="checkout-button outline" data-retry-pix style="margin-top:0.75rem">
            ⚡ Pagar com Pix Instantâneo
          </button>
          ` : `
          <button type="button" class="checkout-button" data-retry-pix>
            ⚡ Pagar com Pix Instantâneo
          </button>
          <button type="button" class="checkout-button outline" data-retry-card style="margin-top:0.75rem">
            💳 Tentar com Cartão de Crédito
          </button>
          `}
        </div>

        <div class="receipt-security-note">
          ${isCard ? 'Nenhuma cobrança foi efetuada no seu cartão. Seus dados estão seguros.' : 'Nenhum valor foi debitado da sua conta. Seus dados estão seguros.'}
        </div>
      </div>
    `;
  }

  function paymentView(data) {
    const payment = data.payment || {};
    const view = window.NexoraCheckoutViewModel.create(data);
    const isCard = payment.method === 'credit_card' || view.isCard;
    if (view.paid) {
      target.innerHTML = paidReceiptMarkup(data);
      clearInterval(retryTimer); retryTimer = null;
      clearTimeout(refreshTimer); refreshTimer = null;
      target.setAttribute('aria-busy', 'false');
      target.querySelector('[data-new-payment]')?.addEventListener('click', () => {
        orderToken = '';
        history.replaceState(null, '', '#token=' + encodeURIComponent(token));
        snapshot = null;
        load();
      });
      return;
    }
    if (view.failed) {
      clearInterval(retryTimer); retryTimer = null;
      clearTimeout(refreshTimer); refreshTimer = null;
      target.setAttribute('aria-busy', 'false');
      target.innerHTML = failedPaymentMarkup(data, view);
      target.querySelector('[data-retry-card]')?.addEventListener('click', () => {
        orderToken = '';
        history.replaceState(null, '', '#token=' + encodeURIComponent(token));
        renderForm({ defaultMethod: 'credit_card' });
      });
      target.querySelector('[data-retry-pix]')?.addEventListener('click', () => {
        orderToken = '';
        history.replaceState(null, '', '#token=' + encodeURIComponent(token));
        renderForm({ defaultMethod: 'pix' });
      });
      return;
    }
    const invoiceUrl = window.NexoraCheckoutViewModel.trustedInvoiceUrl(payment.invoice_url, data.checkout_domains);
    const image = (!isCard && /^[A-Za-z0-9+/]+=*$/.test(payment.pix_encoded_image || ''))
      ? `<img class="checkout-qr" src="data:image/png;base64,${payment.pix_encoded_image}" alt="QR Code Pix para pagar ${money(data.amount_cents)}">` : '';
    const copy = (!isCard && typeof payment.pix_copy_paste === 'string' && payment.pix_copy_paste)
      ? `<label class="checkout-field" for="pix-code">Pix copia e cola<textarea id="pix-code" readonly>${safe(payment.pix_copy_paste)}</textarea></label><button class="checkout-copy" type="button" data-copy-pix>Copiar código Pix</button>` : '';
    const invoice = invoiceUrl
      ? `<p><a href="${safe(invoiceUrl)}" target="_blank" rel="noopener noreferrer">Abrir comprovante de pagamento</a></p>` : '';
    const verifyButton = view.showStatusRefresh
      ? (isCard ? '<button class="checkout-button" type="button" data-refresh-checkout>Verificar autorização do cartão</button>' : '<button class="checkout-button" type="button" data-refresh-checkout>Verificar cobrança</button>')
      : (view.processing && view.hasPixInstructions && !isCard ? '<button class="checkout-button" type="button" data-refresh-checkout style="margin-top:1rem">Já realizei o pagamento · Verificar</button>' : '');
    target.innerHTML = `<div class="checkout-summary"><strong>${money(data.amount_cents)}</strong><span>${safe(data.merchant_name)} · ${safe(data.description)}</span></div><div class="checkout-payment"><p class="checkout-status" role="status">${safe(view.statusMessage)}</p>${image}${copy}${invoice}${verifyButton}</div>`;
    clearInterval(retryTimer); retryTimer = null;
    target.setAttribute('aria-busy', 'false');
    target.querySelector('[data-copy-pix]')?.addEventListener('click', async () => {
      const field = target.querySelector('#pix-code');
      try { await navigator.clipboard.writeText(field.value); target.querySelector('[data-copy-pix]').textContent = 'Código copiado'; }
      catch (_) { field.focus(); field.select(); }
    });
    target.querySelector('[data-refresh-checkout]')?.addEventListener('click', () => load());
    clearTimeout(refreshTimer);
    if (view.processing) refreshTimer = setTimeout(load, 5000);
  }
  async function load() {
    if (!token) return showError('Link inválido. Solicite um novo link ao lojista.');
    if (loadingView) return;
    loadingView = true;
    clearTimeout(refreshTimer); refreshTimer = null;
    const retryButton = target.querySelector('[data-retry-view]');
    if (retryButton) { retryButton.disabled = true; retryButton.textContent = 'Consultando…'; }
    const refreshButton = target.querySelector('[data-refresh-checkout]');
    if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = 'Verificando pagamento…'; }
    target.setAttribute('aria-busy', 'true');
    try {
      const previousPayment = snapshot?.payment;
      snapshot = await invoke({ action: 'view', token, ...(orderToken ? { order_token: orderToken } : {}) });
      if (snapshot.order_token) {
        orderToken = snapshot.order_token;
      }
      if (snapshot.status === 'expired') {
        if (orderToken) {
          return showError('Este pedido expirou. Clique abaixo para gerar uma nova cobrança.', {
            canRetry: true,
            retryAfter: 0,
          });
        }
        return showError('Este link expirou. Solicite uma nova cobrança ao lojista.');
      }
      if (snapshot.status === 'canceled') return showError('Este link não está mais disponível. Solicite um novo link ao lojista.');
      if (!['active', 'processing', 'paid', 'failed'].includes(snapshot.status)) return showError('Não foi possível abrir este link de pagamento.');
      if (snapshot.status === 'active') {
        const hasPayment = snapshot.payment && (
          snapshot.payment.method === 'credit_card' ||
          snapshot.payment.pix_copy_paste ||
          snapshot.payment.invoice_url ||
          snapshot.payment.provider_reference
        );
        if (!hasPayment) {
          if (!document.querySelector('#payer-name')) renderForm();
          return;
        }
      }
      if (!snapshot.payment && previousPayment) {
        snapshot.payment = previousPayment;
      }
      paymentView(snapshot);
    } catch (error) {
      loadingView = false;
      showError(error.message, { canRetry: true, retryAfter: error.retryAfter || 0 });
    } finally { loadingView = false; }
  }
  function renderForm({ defaultMethod = 'pix' } = {}) {
    clearInterval(retryTimer); retryTimer = null;
    if (snapshot.status === 'failed') snapshot.status = 'active';
    target.setAttribute('aria-busy', 'false');
    const emailRequired = snapshot.payer_requirements?.email_required === true;
    const activePublicKey = snapshot.public_key || window.NEXORA_MP_PUBLIC_KEY;
    const cardAvailable = Array.isArray(snapshot.payment_methods) && snapshot.payment_methods.includes('credit_card')
      && !!activePublicKey && typeof window.MercadoPago === 'function';
    const initialMethod = (cardAvailable && defaultMethod === 'credit_card') ? 'credit_card' : 'pix';
    let currentMethod = initialMethod;
    const methodTabs = cardAvailable
      ? `<div class="checkout-tabs" role="tablist" aria-label="Forma de pagamento">
          <button type="button" class="checkout-tab ${initialMethod === 'pix' ? 'active' : ''}" data-tab="pix" role="tab" aria-selected="${initialMethod === 'pix'}">
            <span class="pix-badge">Pix</span> Pix Instantâneo
          </button>
          <button type="button" class="checkout-tab ${initialMethod === 'credit_card' ? 'active' : ''}" data-tab="credit_card" role="tab" aria-selected="${initialMethod === 'credit_card'}">
            <span class="card-badge">💳</span> Cartão de crédito
          </button>
          <input type="hidden" name="payment_method" value="${initialMethod}">
        </div>`
      : '<p class="checkout-method-label">Forma de pagamento: <strong>Pix</strong></p><input type="hidden" name="payment_method" value="pix">';
    const cardSection = cardAvailable
      ? `<div id="card-section" ${initialMethod === 'credit_card' ? '' : 'hidden'}>
          <label class="checkout-field">Número do cartão
            <div id="mp-field-number" class="mp-field"></div>
          </label>
          <div class="checkout-row">
            <label class="checkout-field">Validade
              <div id="mp-field-exp" class="mp-field"></div>
            </label>
            <label class="checkout-field">CVV
              <div id="mp-field-cvv" class="mp-field"></div>
            </label>
          </div>
          <label class="checkout-field" for="card-holder">Nome impresso no cartão
            <input id="card-holder" autocomplete="cc-name" maxlength="80" placeholder="Nome como no cartão">
          </label>
          <label class="checkout-field" for="card-installments">Parcelas
            <select id="card-installments">
              <option value="1">1x à vista</option>
            </select>
          </label>
          <div class="card-security-badge">
            <span class="badge-lock">🔒</span>
            <span>Ambiente seguro. Seus dados de cartão são protegidos e tokenizados de ponta a ponta sem passar pelos servidores da Nexora.</span>
          </div>
        </div>`
      : '';
    target.innerHTML = `<div class="checkout-summary"><strong>${money(snapshot.amount_cents)}</strong><span>${safe(snapshot.merchant_name)} · ${safe(snapshot.description)}</span></div><form class="checkout-form" id="payer-form">${methodTabs}<label class="checkout-field" for="payer-name">Nome completo<input id="payer-name" name="payer_name" autocomplete="name" maxlength="160" required placeholder="Seu nome completo"></label><label class="checkout-field" for="payer-document">CPF ou CNPJ<input id="payer-document" name="payer_document" inputmode="text" autocomplete="off" maxlength="18" placeholder="Digite seu CPF ou CNPJ" title="CPF ou CNPJ (inclusive alfanumérico)" required></label><label class="checkout-field" for="payer-email">E-mail <span id="payer-email-hint">${emailRequired ? '<span class="nx-required">* (obrigatório)</span>' : '<span>(opcional)</span>'}</span><input id="payer-email" name="payer_email" type="email" autocomplete="email" maxlength="254" ${emailRequired ? 'required' : ''} placeholder="seu@email.com"></label>${cardSection}<button class="checkout-button" type="submit" data-submit-label>${initialMethod === 'credit_card' ? 'Pagar com cartão' : 'Continuar para o Pix'}</button></form>`;
    const documentField = target.querySelector('#payer-document');
    documentField.inputMode = 'text';
    documentField.placeholder = 'Digite seu CPF ou CNPJ';
    documentField.addEventListener('input', () => {
      documentField.value = documentField.value.toUpperCase();
      documentField.setCustomValidity(window.NexoraBrazilianDocuments.isValid(documentField.value)
        ? '' : 'Informe um CPF ou CNPJ válido.');
    });
    const form = target.querySelector('#payer-form');
    const submitButton = form.querySelector('[data-submit-label]');
    let mp = null, cardFields = null, cardBin = '', cardMethod = null, mpMounted = false;
    const selectedMethod = () => currentMethod;

    function ensureCardFieldsMounted() {
      if (mpMounted || !cardAvailable) return;
      try {
        mp = new window.MercadoPago(activePublicKey, { locale: 'pt-BR' });
        const style = { color: '#1c1c28', fontSize: '15px', placeholderColor: '#8a8aa0' };
        cardFields = {
          number: mp.fields.create('cardNumber', { placeholder: '0000 0000 0000 0000', style }).mount('mp-field-number'),
          expiry: mp.fields.create('expirationDate', { placeholder: 'MM/AA', style }).mount('mp-field-exp'),
          cvv: mp.fields.create('securityCode', { placeholder: 'CVV', style }).mount('mp-field-cvv'),
        };
        cardFields.number.on('binChange', async ({ bin }) => {
          const installmentsSelect = form.querySelector('#card-installments');
          if (!bin || bin.length < 8) { cardBin = ''; cardMethod = null; if (installmentsSelect) installmentsSelect.innerHTML = '<option value="1">1x à vista</option>'; return; }
          if (bin === cardBin) return;
          cardBin = bin;
          try {
            const methods = await mp.getPaymentMethods({ bin });
            const method = methods?.results?.find(item => item.payment_type_id === 'credit_card') || null;
            if (!method) { cardMethod = null; return; }
            const issuers = await mp.getIssuers({ paymentMethodId: method.id, bin }).catch(() => []);
            const options = await mp.getInstallments({ amount: String(Number(snapshot.amount_cents) / 100), bin, paymentTypeId: 'credit_card' }).catch(() => []);
            const costs = options?.[0]?.payer_costs || [];
            cardMethod = { id: method.id, issuerId: options?.[0]?.issuer?.id || issuers?.[0]?.id || '' };
            if (installmentsSelect) {
              installmentsSelect.innerHTML = (costs.length ? costs : [{ installments: 1, recommended_message: '1x à vista' }])
                .map(cost => `<option value="${Number(cost.installments)}">${safe(cost.recommended_message || `${cost.installments}x`)}</option>`).join('');
            }
          } catch (_) { cardMethod = null; }
        });
        mpMounted = true;
      } catch (err) {
        console.error('MercadoPago init error:', err);
        cardFields = null;
      }
    }

    function switchMethod(method) {
      currentMethod = method === 'credit_card' ? 'credit_card' : 'pix';
      const isCard = currentMethod === 'credit_card';
      form.querySelectorAll('.checkout-tab').forEach(tab => {
        const active = tab.dataset.tab === currentMethod;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      const hiddenMethod = form.querySelector('input[name=payment_method]');
      if (hiddenMethod) hiddenMethod.value = currentMethod;
      const cardSec = form.querySelector('#card-section');
      if (cardSec) cardSec.hidden = !isCard;
      submitButton.textContent = isCard ? 'Pagar com cartão' : 'Continuar para o Pix';
      const emailInput = form.querySelector('#payer-email');
      const emailHint = form.querySelector('#payer-email-hint');
      if (emailInput && emailHint) {
        emailInput.required = emailRequired || isCard;
        emailHint.innerHTML = (emailRequired || isCard) ? '<span class="nx-required">* (obrigatório)</span>' : '<span>(opcional)</span>';
      }
      form.querySelector('.checkout-error-banner')?.remove();
      form.querySelector('.checkout-error')?.remove();
      if (isCard) ensureCardFieldsMounted();
    }

    if (cardAvailable) {
      form.querySelectorAll('.checkout-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
          e.preventDefault();
          switchMethod(tab.dataset.tab);
        });
      });
      if (initialMethod === 'credit_card') ensureCardFieldsMounted();
    }

    async function cardPayload(values) {
      if (!mp || !cardFields) throw new Error('Pagamento com cartão indisponível no momento. Use o Pix.');
      const holder = String(form.querySelector('#card-holder').value || '').trim();
      if (holder.length < 3) throw new Error('Informe o nome impresso no cartão.');
      const document = String(values.get('payer_document') || '').replace(/[^0-9A-Za-z]/g, '');
      if (!document) throw new Error('Informe seu CPF ou CNPJ.');
      let created;
      try {
        created = await mp.fields.createCardToken({
          cardholderName: holder,
          identificationType: document.length > 11 ? 'CNPJ' : 'CPF',
          identificationNumber: document,
        });
      } catch (_) { throw new Error('Cartão inválido. Confira número, validade e CVV.'); }
      if (!created?.id) throw new Error('Cartão inválido. Confira número, validade e CVV.');
      if (!cardMethod?.id && (created.first_six_digits || cardBin)) {
        try {
          const methods = await mp.getPaymentMethods({ bin: created.first_six_digits || cardBin });
          const method = methods?.results?.find(item => item.payment_type_id === 'credit_card');
          if (method) cardMethod = { id: method.id, issuerId: '' };
        } catch (_) {}
      }
      if (!cardMethod?.id) throw new Error('Não foi possível identificar a bandeira do cartão. Confira o número.');
      return {
        payment_method: 'credit_card', card_token: created.id, payment_method_id: cardMethod.id,
        issuer_id: cardMethod.issuerId ? String(cardMethod.issuerId) : undefined,
        installments: Number(form.querySelector('#card-installments')?.value || 1),
        ...(typeof window.MP_DEVICE_SESSION_ID === 'string' && window.MP_DEVICE_SESSION_ID.trim()
          ? { device_session_id: window.MP_DEVICE_SESSION_ID.trim() }
          : {}),
      };
    }
    const idleLabel = () => selectedMethod() === 'credit_card' ? 'Pagar com cartão' : 'Continuar para o Pix';
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !event.currentTarget.reportValidity()) return;
      busy = true;
      const button = submitButton; button.disabled = true; button.textContent = selectedMethod() === 'credit_card' ? 'Processando cartão…' : 'Preparando pagamento…';
      const values = new FormData(event.currentTarget);
      try {
        const extra = selectedMethod() === 'credit_card' ? await cardPayload(values) : {};
        const result = await invoke({
          action: 'pay', token,
          ...(orderToken ? { order_token: orderToken } : {}),
          payer_name: values.get('payer_name'),
          payer_document: values.get('payer_document'),
          payer_email: values.get('payer_email'),
          ...extra,
        });
        if (result.order_token) {
          orderToken = result.order_token;
          const hash = `#token=${encodeURIComponent(token)}&order=${encodeURIComponent(orderToken)}`;
          if (location.hash !== hash) {
            history.replaceState(null, '', hash);
          }
        }
        if (result.payment) {
          const isResultPaid = result.status === 'paid' || result.payment.status === 'SUCCEEDED';
          const isResultFailed = result.status === 'failed' || ['FAILED', 'REJECTED', 'CANCELED'].includes(String(result.payment.status || '').toUpperCase());
          snapshot = { ...snapshot, status: isResultPaid ? 'paid' : (isResultFailed ? 'failed' : 'processing'), payment: { ...result.payment, method: currentMethod } };
          paymentView(snapshot);
        } else {
          snapshot = { ...snapshot, status: result.status || 'processing' };
          paymentView({ ...snapshot, payment: null, method: currentMethod });
        }
      } catch (error) {
        event.currentTarget.querySelector('.checkout-error-banner')?.remove();
        const isCardDecline = selectedMethod() === 'credit_card' && /recusad|autorizad|declin|rejeit|insuficiente/i.test(error.message);
        if (isCardDecline) {
          const banner = document.createElement('div');
          banner.className = 'checkout-error-banner';
          banner.setAttribute('role', 'alert');
          banner.innerHTML = `
            <div class="error-banner-icon">⚠️</div>
            <div class="error-banner-body">
              <strong>Pagamento com cartão não autorizado</strong>
              <p>${safe(error.message)}</p>
              <div class="error-banner-actions">
                <button type="button" class="banner-action-btn" data-retry-action="card">Tentar outro cartão</button>
                <button type="button" class="banner-action-btn outline" data-retry-action="pix">Pagar com Pix</button>
              </div>
            </div>
          `;
          event.currentTarget.prepend(banner);
          banner.querySelector('[data-retry-action="card"]')?.addEventListener('click', () => {
            banner.remove();
            const holderInput = form.querySelector('#card-holder');
            if (holderInput) holderInput.value = '';
            if (mpMounted && cardFields) {
              try {
                cardFields.number.unmount(); cardFields.expiry.unmount(); cardFields.cvv.unmount();
                mpMounted = false;
                ensureCardFieldsMounted();
              } catch (_) {}
            }
            holderInput?.focus();
          });
          banner.querySelector('[data-retry-action="pix"]')?.addEventListener('click', () => {
            banner.remove();
            switchMethod('pix');
          });
        } else {
          const message = document.createElement('p'); message.className = 'checkout-error'; message.setAttribute('role', 'alert');
          message.textContent = error.retryAfter ? `${error.message} Aguarde ${error.retryAfter} segundos antes de tentar novamente.` : error.message;
          event.currentTarget.prepend(message);
        }
        if (error.retryAfter) {
          clearInterval(retryTimer);
          let remaining = error.retryAfter;
          button.disabled = true; button.textContent = `Aguarde ${remaining} s…`;
          retryTimer = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
              clearInterval(retryTimer); retryTimer = null;
              button.disabled = false; button.textContent = idleLabel();
            } else button.textContent = `Aguarde ${remaining} s…`;
          }, 1000);
        } else { button.disabled = false; button.textContent = idleLabel(); }
      } finally { busy = false; }
    });
  }
  if (!config || !window.supabase?.createClient) return showError('Checkout temporariamente indisponível. Tente novamente mais tarde.');
  client = window.supabase.createClient(config.url, config.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  load();
})();

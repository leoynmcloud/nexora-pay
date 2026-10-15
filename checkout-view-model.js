(function (root, factory) {
  'use strict';
  const viewModel = factory();
  if (typeof module === 'object' && module.exports) module.exports = viewModel;
  else root.NexoraCheckoutViewModel = viewModel;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const hasText = value => typeof value === 'string' && value.trim().length > 0;

  function trustedInvoiceUrl(value, domains) {
    if (typeof value !== 'string' || value.length > 2000 || !Array.isArray(domains)) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      const host = url.hostname.toLowerCase();
      return domains.some(domain => typeof domain === 'string' && domain.length <= 253
        && (host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`))) ? url.toString() : null;
    } catch (_) { return null; }
  }

  function create(data) {
    const status = String(data?.status || '').toLowerCase();
    const payment = data?.payment && typeof data.payment === 'object' ? data.payment : {};
    const paymentStatus = String(payment.status || payment.normalized_status || payment.provider_status || '').toUpperCase();
    const rawStatus = String(payment.provider_status || payment.raw_status || '').toLowerCase();

    const method = String(payment.method || payment.payment_method || payment.payment_type_id || payment.payment_type || data?.method || data?.payment_method || '').toLowerCase();
    const isCard = method === 'credit_card' || method === 'card' || method === 'creditcard'
      || Boolean(payment.card_brand || payment.card_last_digits || payment.card_token)
      || ['visa', 'master', 'mastercard', 'amex', 'elo', 'hipercard', 'diners', 'cabal'].includes(String(payment.payment_method_id || '').toLowerCase());

    const paid = status === 'paid' || paymentStatus === 'SUCCEEDED' || paymentStatus === 'SETTLED';
    const failed = status === 'failed' || status === 'rejected'
      || ['FAILED', 'REJECTED', 'CANCELED', 'CANCELLED'].includes(paymentStatus)
      || rawStatus === 'rejected';
    const hasPixInstructions = !isCard && (hasText(payment.pix_copy_paste) || hasText(payment.pix_encoded_image));
    const hasInvoice = hasText(payment.invoice_url);
    const hasPaymentInstructions = hasPixInstructions || hasInvoice;
    const processing = (status === 'processing' || hasPaymentInstructions) && !paid && !failed;

    let statusMessage = 'O pagamento não está disponível neste momento.';
    if (paid) {
      statusMessage = 'Pagamento confirmado.';
    } else if (failed) {
      statusMessage = isCard
        ? 'Pagamento recusado pela operadora do cartão ou banco emissor. Você pode tentar outro cartão de crédito ou pagar via Pix instantâneo.'
        : 'Pagamento Pix não concluído. Você pode tentar novamente gerando um novo Pix ou pagar com cartão de crédito.';
    } else if (processing && hasPixInstructions) {
      statusMessage = 'Pix pronto. Faça o pagamento pelo QR Code ou Pix copia e cola. A confirmação será atualizada automaticamente.';
    } else if (processing && isCard) {
      statusMessage = 'Estamos confirmando o pagamento do cartão com o adquirente. Não tente pagar novamente enquanto verificamos; esta página atualiza automaticamente.';
    } else if (processing && hasInvoice) {
      statusMessage = 'Cobrança pronta. Abra a página segura do adquirente para concluir o pagamento; o status será atualizado automaticamente.';
    } else if (processing) {
      statusMessage = 'Estamos confirmando o pagamento com o adquirente. Não tente pagar novamente enquanto verificamos; esta página atualiza automaticamente.';
    } else if (status === 'active') {
      statusMessage = 'Aguardando preenchimento dos dados para pagamento.';
    }

    return {
      paid,
      failed,
      processing,
      isCard,
      method: isCard ? 'credit_card' : (hasPixInstructions ? 'pix' : method || 'unknown'),
      hasPixInstructions,
      hasInvoice,
      hasPaymentInstructions,
      showStatusRefresh: processing && !hasPaymentInstructions,
      statusMessage,
    };
  }

  return { create, trustedInvoiceUrl };
});

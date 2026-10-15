(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.NexoraCore = core;
})(typeof window === 'undefined' ? this : window, function () {
  'use strict';
  const cents = (value) => Math.round(Number(value || 0) * 100);
  const money = (value) => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const parseMoney = (value) => {
    const text = String(value).replace(/^R\$\s*/, '').trim();
    if (!/^(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}$/.test(text)) throw new Error('Informe o valor em reais, com dois centavos.');
    const amount = Number(text.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 9999999999.99) throw new Error('Informe um valor válido maior que zero.');
    return cents(amount) / 100;
  };
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const status = (value) => ({ paid: 'Pago', succeeded: 'Aprovado · teste', pending: 'Pendente', processing: 'Em processamento', cancelled: 'Cancelado', failed: 'Falhou · teste', expired: 'Expirado', refunded: 'Estornado', reversed: 'Revertido', refund_pending: 'Estorno em processamento', overdue: 'Vencido', under_review: 'Em análise', reserved: 'Saldo reservado', approved: 'Aprovado · aguardando envio', rejected: 'Rejeitado', risk_review: 'Em análise de risco', outcome_unknown: 'Confirmação pendente', completed: 'Concluído', created: 'Criado', requested: 'Solicitado' }[String(value || '').toLowerCase()] || 'Não informado');
  const payoutStatus = (value) => ({ reserved: 'Saldo reservado', approved: 'Aprovado · aguardando envio', processing: 'Em processamento', completed: 'Transferência concluída', failed: 'Transferência falhou', rejected: 'Rejeitado', risk_review: 'Em análise de risco', outcome_unknown: 'Confirmação pendente' }[String(value || '').toLowerCase()] || 'Status indisponível');
  const date = (value) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString('pt-BR') : 'Não informado';
  const paidIn = (item) => item.kind !== 'withdrawal' && item.status === 'paid';
  function metrics(transactions, now = new Date()) {
    let balance = 0, received = 0, previous = 0, pending = 0, reserved = 0;
    const month = new Date(now.getFullYear(), now.getMonth(), 1);
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const before = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    for (const item of transactions) {
      const value = cents(item.amount);
      if (paidIn(item)) {
        balance += value;
        const settled = new Date(item.paid_at || item.created_at);
        if (settled >= month && settled < next) received += value;
        if (settled >= before && settled < month) previous += value;
      } else if (item.kind === 'charge' && item.status === 'pending') pending += value;
      if (item.kind === 'withdrawal' && ['pending', 'processing', 'paid'].includes(item.status)) {
        balance -= value;
        if (item.status !== 'paid') reserved += value;
      }
    }
    return { balance: balance / 100, received: received / 100, previous: previous / 100, pending: pending / 100, reserved: reserved / 100, transactions: transactions.length };
  }
  function filter(transactions, query = '', state = '', from = '', to = '', customerId = '') {
    const term = query.trim().toLocaleLowerCase('pt-BR');
    const start = from ? new Date(`${from}T00:00:00`) : null;
    const end = to ? new Date(`${to}T23:59:59.999`) : null;
    return transactions.filter((item) => {
      const text = [item.external_id, item.title, item.customer_name, item.customer_email, item.destination].join(' ').toLocaleLowerCase('pt-BR');
      const created = new Date(item.created_at);
      return (!customerId || item.customer_id === customerId) && (!term || text.includes(term)) && (!state || item.status === state) && (!start || created >= start) && (!end || created <= end);
    });
  }
  function filterReceipts(transactions, query = '', from = '', to = '', customerId = '', environment = '') {
    const term = query.trim().toLocaleLowerCase('pt-BR');
    return transactions.filter((item) => {
      if (item.status !== 'paid' || item.kind === 'withdrawal') return false;
      if (environment && (environment === 'sandbox') !== Boolean(item.test_mode)) return false;
      if (customerId && item.customer_id !== customerId) return false;
      const text = [item.external_id, item.title, item.customer_name, item.customer_email, item.destination]
        .join(' ').toLocaleLowerCase('pt-BR');
      if (term && !text.includes(term)) return false;
      const timestamp = new Date(item.paid_at || item.created_at);
      if (!Number.isFinite(timestamp.getTime())) return false;
      const localDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(timestamp).reduce((result, part) => {
        if (part.type !== 'literal') result[part.type] = part.value;
        return result;
      }, {});
      const businessDate = `${localDate.year}-${localDate.month}-${localDate.day}`;
      return (!from || businessDate >= from) && (!to || businessDate <= to);
    }).sort((a, b) => new Date(b.paid_at || b.created_at).getTime() - new Date(a.paid_at || a.created_at).getTime());
  }
  function chart(transactions, range, now = new Date()) {
    const buckets = [];
    const monthly = range === 'Últimos 6 meses' || range === 'Este ano';
    const count = range === 'Últimos 7 dias' ? 7 : range === 'Último mês' ? 30 : range === 'Este ano' ? now.getMonth() + 1 : 6;
    for (let i = count - 1; i >= 0; i--) {
      const start = monthly ? new Date(now.getFullYear(), now.getMonth() - i, 1) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const end = monthly ? new Date(start.getFullYear(), start.getMonth() + 1, 1) : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
      const amount = transactions.filter((item) => paidIn(item) && new Date(item.paid_at || item.created_at) >= start && new Date(item.paid_at || item.created_at) < end).reduce((sum, item) => sum + cents(item.amount), 0) / 100;
      buckets.push({ start: start.toISOString(), label: monthly ? start.toLocaleDateString('pt-BR', { month: 'short' }) : start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), amount });
    }
    return buckets;
  }
  function csv(transactions) {
    const safe = (value) => {
      let text = String(value ?? '');
      if (/^[=+@\t\r]/.test(text) || /^-(?!\d+(?:[.,]\d+)?$)/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const decimal = (value) => Number(value).toFixed(2).replace('.', ',');
    const rows = [['Referência', 'Descrição', 'Cliente', 'E-mail', 'Tipo', 'Valor BRL', 'Status', 'Criação', 'Confirmação do pagamento', 'Origem', 'Método', 'Destino Pix', 'Taxa BRL', 'Valor menos taxa BRL', 'Referência da IP'], ...transactions.map((item) => [item.external_id || item.id, item.title, item.customer_name, item.customer_email, item.kind === 'withdrawal' ? 'Saída' : 'Entrada', decimal((item.kind === 'withdrawal' ? -1 : 1) * Number(item.amount)), status(item.status), item.created_at, item.paid_at, item.source, item.payment_method === 'pix' ? 'Pix' : item.payment_method, item.destination, item.fee == null ? '' : decimal(item.fee), item.fee == null || item.kind === 'withdrawal' ? '' : decimal((cents(item.amount) - cents(item.fee)) / 100), item.provider_reference])];
    return '\uFEFF' + rows.map((row) => row.map(safe).join(';')).join('\r\n');
  }
  function ledgerCsv(journals) {
    const safe = (value) => {
      let text = String(value ?? '');
      if (/^[=+@\t\r]/.test(text) || /^-(?!\d+(?:[.,]\d+)?$)/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const decimalCents = (value) => {
      const amount = Number(value);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Valor inválido no extrato do ledger.');
      return (amount / 100).toFixed(2).replace('.', ',');
    };
    const rows = [['Data', 'Evento', 'Descrição', 'ID do lançamento', 'ID da transação', 'Grupo de saldo', 'Direção', 'Valor BRL']];
    for (const journal of journals) {
      for (const movement of Array.isArray(journal.movements) ? journal.movements : []) {
        rows.push([
          journal.created_at, journal.event_code, journal.description, journal.journal_id,
          journal.transaction_id, movement.bucket, movement.side === 'credit' ? 'Crédito' : movement.side === 'debit' ? 'Débito' : movement.side,
          decimalCents(movement.amount_cents),
        ]);
      }
    }
    return '\uFEFF' + rows.map((row) => row.map(safe).join(';')).join('\r\n');
  }
  return { cents, money, parseMoney, escape, status, payoutStatus, date, paidIn, metrics, filter, filterReceipts, chart, csv, ledgerCsv };
});

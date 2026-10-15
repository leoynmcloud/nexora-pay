import assert from 'node:assert/strict';
import test from 'node:test';
import core from '../../../nexora-core.js';

const transactions = [
  { id: 'paid-later', status: 'paid', kind: 'gateway', created_at: '2026-10-01T09:00:00Z', paid_at: '2026-10-03T10:00:00Z', customer_id: 'customer-1', title: 'Venda A', test_mode: false },
  { id: 'paid-earlier', status: 'paid', kind: 'gateway', created_at: '2026-10-02T12:00:00Z', paid_at: '2026-10-02T13:00:00Z', customer_id: 'customer-1', title: 'Venda B', test_mode: false },
  { id: 'pending', status: 'pending', kind: 'gateway', created_at: '2026-10-03T14:00:00Z', customer_id: 'customer-1', title: 'Pendente', test_mode: false },
  { id: 'withdrawal', status: 'paid', kind: 'withdrawal', created_at: '2026-10-03T15:00:00Z', paid_at: '2026-10-03T15:00:00Z', customer_id: 'customer-1', title: 'Saque', test_mode: false },
  { id: 'sandbox', status: 'paid', kind: 'gateway', created_at: '2026-10-03T16:00:00Z', paid_at: '2026-10-03T16:00:00Z', customer_id: 'customer-2', title: 'Teste Pix', test_mode: true },
  { id: 'sp-midnight', status: 'paid', kind: 'gateway', created_at: '2026-10-03T09:00:00Z', paid_at: '2026-10-03T02:30:00Z', customer_id: 'customer-1', title: 'Venda perto da meia-noite', test_mode: false },
];

test('merchant receipts filter by provider confirmation date and sort newest first', () => {
  const result = core.filterReceipts(transactions, '', '2026-10-03', '2026-10-03');
  assert.deepEqual(result.map(item => item.id), ['sandbox', 'paid-later']);
});

test('merchant receipts exclude pending transactions and outgoing payouts', () => {
  const result = core.filterReceipts(transactions);
  assert.deepEqual(result.map(item => item.id), ['sandbox', 'paid-later', 'sp-midnight', 'paid-earlier']);
});

test('merchant receipts filters can isolate production, sandbox, and customer', () => {
  assert.deepEqual(core.filterReceipts(transactions, '', '', '', '', 'production').map(item => item.id), ['paid-later', 'sp-midnight', 'paid-earlier']);
  assert.deepEqual(core.filterReceipts(transactions, 'teste', '', '', '', 'sandbox').map(item => item.id), ['sandbox']);
  assert.deepEqual(core.filterReceipts(transactions, '', '', '', 'customer-1', 'production').map(item => item.id), ['paid-later', 'sp-midnight', 'paid-earlier']);
});

test('merchant receipts date filters use São Paulo business days, independent of device timezone', () => {
  const result = core.filterReceipts(transactions, '', '2026-10-02', '2026-10-02', '', 'production');
  assert.deepEqual(result.map(item => item.id), ['sp-midnight', 'paid-earlier']);
});

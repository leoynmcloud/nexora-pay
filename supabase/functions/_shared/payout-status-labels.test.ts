import assert from 'node:assert/strict';
import test from 'node:test';
import core from '../../../nexora-core.js';

test('admin payout statuses are localized for the backoffice', () => {
  assert.equal(core.status('RESERVED'), 'Saldo reservado');
  assert.equal(core.status('APPROVED'), 'Aprovado · aguardando envio');
  assert.equal(core.status('REJECTED'), 'Rejeitado');
  assert.equal(core.status('RISK_REVIEW'), 'Em análise de risco');
  assert.equal(core.status('OUTCOME_UNKNOWN'), 'Confirmação pendente');
  assert.equal(core.status('COMPLETED'), 'Concluído');
});

test('merchant payout status labels do not describe production failures as test payments', () => {
  assert.equal(core.payoutStatus('FAILED'), 'Transferência falhou');
  assert.equal(core.payoutStatus('COMPLETED'), 'Transferência concluída');
  assert.equal(core.payoutStatus('OUTCOME_UNKNOWN'), 'Confirmação pendente');
  assert.equal(core.payoutStatus('UNEXPECTED'), 'Status indisponível');
});

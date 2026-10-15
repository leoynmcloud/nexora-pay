import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthorizedWebhookWorker } from './webhook-worker-auth.ts';

const base = {
  serviceRoleKey: 'service-role-secret',
  workerToken: 'nexora_worker_token_0123456789abcdef',
};

test('accepts the dedicated worker token without exposing the service role key to cron', () => {
  assert.equal(isAuthorizedWebhookWorker({
    ...base, authorization: null, workerTokenHeader: base.workerToken,
  }), true);
});

test('keeps existing service-role bearer callers compatible', () => {
  assert.equal(isAuthorizedWebhookWorker({
    ...base, authorization: `Bearer ${base.serviceRoleKey}`, workerTokenHeader: null,
  }), true);
});

test('rejects missing, short, malformed, or incorrect worker credentials', () => {
  for (const workerToken of ['', 'short', base.workerToken]) {
    assert.equal(isAuthorizedWebhookWorker({
      ...base, workerToken, authorization: null,
      workerTokenHeader: workerToken === base.workerToken ? 'wrong-token' : workerToken,
    }), false);
  }
  assert.equal(isAuthorizedWebhookWorker({
    ...base, authorization: 'Bearer wrong', workerTokenHeader: 'nexora_worker_token_0123456789abcdeg',
  }), false);
});

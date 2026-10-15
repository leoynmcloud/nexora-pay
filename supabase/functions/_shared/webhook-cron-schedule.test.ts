import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const scheduleSql = readFileSync(new URL('../../../nexora-merchant-webhook-schedule.sql', import.meta.url), 'utf8');
const config = readFileSync(new URL('../../config.toml', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../nexora-webhook-deliveries/index.ts', import.meta.url), 'utf8');

test('merchant webhook retries have a durable minute scheduler with a dedicated Vault credential', () => {
  assert.match(scheduleSql, /cron\.schedule\([\s\S]*?'\* \* \* \* \*'/);
  assert.match(scheduleSql, /net\.http_post\(/);
  assert.match(scheduleSql, /nexora_merchant_webhook_worker_token/);
  assert.doesNotMatch(scheduleSql, /service_role_key|service-role-key/i);
  assert.match(config, /\[functions\.nexora-webhook-deliveries\]\s+verify_jwt\s*=\s*false/);
  assert.match(worker, /isAuthorizedWebhookWorker\(/);
});

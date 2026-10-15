import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../../nexora-api.js', import.meta.url), 'utf8');
const context: { window: Record<string, any> } = { window: {} };
runInNewContext(source, context);
const errorMessage = context.window.NexoraAPI.errorMessage as (error: unknown) => string;

test('generic provider errors only show migration guidance for actual missing schema objects', () => {
  assert.equal(
    errorMessage({ message: 'Could not find the function public.nexora_provider_begin_charge in the schema cache' }),
    'Banco ainda não atualizado. Execute a migração SQL mais recente no Supabase e tente novamente.',
  );
  assert.equal(errorMessage({ message: 'nexora_provider_charge_result_invalid' }), 'nexora_provider_charge_result_invalid');
  assert.equal(errorMessage({ message: 'asaas_payment_persistence_failed' }), 'asaas_payment_persistence_failed');
});

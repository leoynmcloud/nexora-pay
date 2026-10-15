export type ReconciliationAdminRequest = { runId?: string; itemsOffset: number; exceptionsOffset: number };
export type ReconciliationAdminParseResult =
  | { ok: true; value: ReconciliationAdminRequest }
  | { ok: false; error: 'invalid_request' | 'invalid_offset' | 'invalid_run_id' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseReconciliationAdminRequest(input: unknown): ReconciliationAdminParseResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid_request' };
  const body = input as Record<string, unknown>;
  const itemsOffset = body.items_offset ?? body.offset ?? 0;
  const exceptionsOffset = body.exceptions_offset ?? 0;
  if (![itemsOffset, exceptionsOffset].every(offset => Number.isSafeInteger(offset) && Number(offset) >= 0 && Number(offset) <= 100_000)) {
    return { ok: false, error: 'invalid_offset' };
  }
  const runId = body.run_id;
  if (runId !== undefined && (typeof runId !== 'string' || !UUID.test(runId))) {
    return { ok: false, error: 'invalid_run_id' };
  }
  return { ok: true, value: {
    runId: runId as string | undefined, itemsOffset: Number(itemsOffset), exceptionsOffset: Number(exceptionsOffset),
  } };
}

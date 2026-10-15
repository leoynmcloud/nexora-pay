export type SettlementCandidate = {
  reconciliation_item_id: string;
  transaction_id: string;
  provider_transaction_id: string;
  gross_amount_cents: number | string;
  provider_fee_cents: number | string;
  merchant_fee_cents: number | string;
  merchant_net_cents: number | string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const toSafeCents = (value: number | string) => {
  const cents = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof cents === 'number' && Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
};

export function parseSettlementReleaseRequest(input: unknown): { runId?: string; limit: number } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  const limit = body.limit === undefined ? 50 : body.limit;
  const runId = body.run_id;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100
    || (runId !== undefined && (typeof runId !== 'string' || !UUID.test(runId)))) return null;
  return runId === undefined ? { limit: Number(limit) } : { runId: runId as string, limit: Number(limit) };
}

export async function settlementRequestHash(candidate: SettlementCandidate): Promise<string> {
  const gross = toSafeCents(candidate.gross_amount_cents);
  const providerFee = toSafeCents(candidate.provider_fee_cents);
  const merchantFee = toSafeCents(candidate.merchant_fee_cents);
  const merchantNet = toSafeCents(candidate.merchant_net_cents);
  if (!UUID.test(candidate.reconciliation_item_id) || !UUID.test(candidate.transaction_id)
    || typeof candidate.provider_transaction_id !== 'string' || !candidate.provider_transaction_id.trim()
    || candidate.provider_transaction_id.length > 200 || gross === null || gross <= 0
    || providerFee === null || providerFee > gross || merchantFee === null || merchantFee >= gross || merchantNet === null
    || merchantNet !== gross - merchantFee) throw new Error('settlement_candidate_invalid');
  const canonical = JSON.stringify({
    version: 1,
    action: 'settlement.release',
    reconciliation_item_id: candidate.reconciliation_item_id,
    transaction_id: candidate.transaction_id,
    provider_transaction_id: candidate.provider_transaction_id,
    gross_amount_cents: gross,
    provider_fee_cents: providerFee,
    merchant_fee_cents: merchantFee,
    merchant_net_cents: merchantNet,
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function releaseSettlementBatch(
  candidates: SettlementCandidate[],
  release: (candidate: SettlementCandidate, requestHash: string) => Promise<string>,
) {
  const results: Array<{ reconciliation_item_id: string; status: 'released' | 'failed'; settlement_id?: string; error?: string }> = [];
  for (const candidate of candidates) {
    try {
      const requestHash = await settlementRequestHash(candidate);
      const settlementId = await release(candidate, requestHash);
      if (!UUID.test(settlementId)) throw new Error('settlement_result_invalid');
      results.push({ reconciliation_item_id: candidate.reconciliation_item_id, settlement_id: settlementId, status: 'released' });
    } catch {
      results.push({ reconciliation_item_id: candidate.reconciliation_item_id, status: 'failed', error: 'settlement_release_failed' });
    }
  }
  return results;
}

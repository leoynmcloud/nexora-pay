export type MaturedReserve = {
  settlement_id: string;
  amount_cents: number | string;
  reserve_release_at: string;
};

export function parseMaturedReserveRequest(input: unknown): { action: 'list' | 'release'; limit: number } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  const action = body.action === undefined ? 'list' : body.action;
  const limit = body.limit === undefined ? 50 : body.limit;
  if ((action !== 'list' && action !== 'release') || !Number.isSafeInteger(limit)
    || Number(limit) < 1 || Number(limit) > 100) return null;
  return { action, limit: Number(limit) };
}

export async function maturedReserveRequestHash(reserve: MaturedReserve): Promise<string> {
  const amountCents = typeof reserve.amount_cents === 'string' && /^\d+$/.test(reserve.amount_cents)
    ? Number(reserve.amount_cents) : reserve.amount_cents;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reserve.settlement_id)
    || typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0
    || !Number.isFinite(Date.parse(reserve.reserve_release_at))) throw new Error('matured_reserve_invalid');
  const canonical = JSON.stringify({
    version: 1,
    action: 'reserve.release',
    settlement_id: reserve.settlement_id,
    amount_cents: amountCents,
    reserve_release_at: new Date(reserve.reserve_release_at).toISOString(),
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

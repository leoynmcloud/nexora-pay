export type FundControlRequest =
  | { action: 'list' }
  | { action: 'hold'; businessId: string; requestId: string; amountCents: number; reason: string }
  | { action: 'release'; holdId: string; requestId: string; reason: string };

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function parseFundControlRequest(input: unknown): FundControlRequest | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  if (body.action === 'list') return { action: 'list' };
  if (body.action === 'hold' || body.action === 'release') {
    const requestId = body.request_id;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!uuid(requestId) || reason.length < 10 || reason.length > 500) return null;
    if (body.action === 'hold') {
      if (!uuid(body.business_id) || !Number.isSafeInteger(body.amount_cents)
        || (body.amount_cents as number) <= 0 || (body.amount_cents as number) > 9_000_000_000_000) return null;
      return { action: 'hold', businessId: body.business_id, requestId, amountCents: body.amount_cents as number, reason };
    }
    if (!uuid(body.hold_id)) return null;
    return { action: 'release', holdId: body.hold_id, requestId, reason };
  }
  return null;
}

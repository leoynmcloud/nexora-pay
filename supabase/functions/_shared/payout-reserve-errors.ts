export type PayoutReserveErrorReply = { error: string; status: number; definitive: boolean };

/**
 * Map exceptions raised by public.nexora_payout_reserve (nexora-payout-core.sql) to API codes.
 * `definitive` means the RPC raised before committing, so no reservation exists for this attempt.
 * Unknown failures are reported as ambiguous so the client checks history before retrying.
 */
export function mapPayoutReserveError(message: unknown): PayoutReserveErrorReply {
  const text = String(message || '').toLowerCase();
  const rule = (error: string, status: number): PayoutReserveErrorReply => ({ error, status, definitive: true });
  if (text.includes('real payouts are disabled')) return rule('payouts_disabled', 409);
  if (text.includes('invalid payout request')) return rule('invalid_payout_request', 400);
  if (text.includes('merchant workspace not found')) return rule('workspace_unavailable', 404);
  if (text.includes('idempotency key reused')) return rule('idempotency_conflict', 409);
  if (text.includes('not approved and active')) return rule('payout_not_allowed', 403);
  if (text.includes('withdrawals or pix out are disabled') || text.includes('outgoing movements are blocked')) {
    return rule('payout_not_allowed', 403);
  }
  if (text.includes('per-transfer limit') || text.includes('daily limit')) return rule('payout_limit_exceeded', 409);
  if (text.includes('no approved production payout route')) return rule('payout_route_unavailable', 409);
  if (text.includes('insufficient available')) return rule('insufficient_available_balance', 409);
  return { error: 'payout_reservation_failed', status: 503, definitive: false };
}

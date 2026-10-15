export type PayoutAdminRequest =
  | { action: 'list' }
  | { action: 'approve' | 'reject' | 'dispatch' | 'reconcile'; payoutId: string; reason: string }
  | { action: 'complete_manual'; payoutId: string; providerTransferId: string; reason: string };

export function parseMerchantPayoutListRequest(input: unknown): { businessId: string; beforeCreatedAt: string | null; beforePayoutId: string | null } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  const businessId = body.business_id;
  const beforeCreatedAt = body.before_created_at;
  const beforePayoutId = body.before_payout_id;
  const uuid = (value: unknown): value is string => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const timestamp = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1
      && calendar.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59;
  };
  if (!uuid(businessId) || (beforeCreatedAt == null) !== (beforePayoutId == null)) return null;
  if (beforeCreatedAt == null) return { businessId, beforeCreatedAt: null, beforePayoutId: null };
  if (!timestamp(beforeCreatedAt) || !uuid(beforePayoutId)) return null;
  return { businessId, beforeCreatedAt, beforePayoutId };
}

export function parsePayoutAdminRequest(input: unknown): PayoutAdminRequest | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  if (body.action === 'list') return { action: 'list' };
  if (body.action === 'complete_manual') {
    if (typeof body.payout_id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.payout_id)) return null;
    const transferId = typeof body.provider_transfer_id === 'string' ? body.provider_transfer_id.trim()
      : (typeof body.e2e_id === 'string' ? body.e2e_id.trim() : '');
    if (!transferId || transferId.length < 1 || transferId.length > 100) return null;
    if (body.reason !== undefined && typeof body.reason !== 'string') return null;
    const rawReason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const reason = rawReason || 'Saque Pix realizado e concluído manualmente pelo Super Admin.';
    if (reason.length < 10 || reason.length > 500) return null;
    return { action: 'complete_manual', payoutId: body.payout_id, providerTransferId: transferId, reason };
  }
  if (body.action !== 'approve' && body.action !== 'reject' && body.action !== 'dispatch' && body.action !== 'reconcile') return null;
  if (typeof body.payout_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.payout_id)) return null;
  if (body.reason !== undefined && typeof body.reason !== 'string') return null;
  const rawReason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const reason = rawReason || (body.action === 'approve'
    ? 'Aprovação de saque confirmada pelo Super Admin.'
    : body.action === 'dispatch'
      ? 'Envio Pix autorizado pelo Super Admin.'
      : '');
  if (reason.length < 10 || reason.length > 500) return null;
  return { action: body.action, payoutId: body.payout_id, reason };
}

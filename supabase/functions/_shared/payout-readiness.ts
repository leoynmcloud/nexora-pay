export type PayoutReadinessInput = {
  workspaceExists: boolean;
  onboardingApproved: boolean;
  accountActive: boolean;
  productionEnabled: boolean;
  withdrawalsEnabled: boolean;
  pixOutEnabled: boolean;
  movementsBlocked: boolean;
  transferLimitCents: number | null;
  dailyLimitCents: number | null;
  /** Sum of today's non-terminal-failure payouts (America/Sao_Paulo day), or null when unknown. */
  dailyUsedCents: number | null;
  productionRouteAvailable: boolean;
  availableCents: number | null;
};

export type PayoutReadiness = {
  canRequest: boolean;
  availableCents: number | null;
  /** Largest amount the reserve RPC could accept right now, or null when it cannot be determined. */
  maxRequestCents: number | null;
  reasons: string[];
};

const positiveCents = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value > 0;

/**
 * Convert a BRL decimal (JSON number or numeric string from PostgREST) to integer cents
 * without floating-point drift. Returns null for anything that is not an exact cent amount.
 */
export function decimalToCents(value: unknown): number | null {
  if (typeof value === 'string') {
    const match = /^(-?)(\d{1,13})(?:\.(\d+))?$/.exec(value.trim());
    if (!match) return null;
    const fraction = match[3] || '';
    if (/[1-9]/.test(fraction.slice(2))) return null;
    const cents = Number(match[2]) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
    if (!Number.isSafeInteger(cents)) return null;
    return match[1] === '-' && cents !== 0 ? -cents : cents;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || Math.abs(scaled - cents) > 1e-6) return null;
  return cents === 0 ? 0 : cents;
}

/** Informational only. The atomic reserve RPC rechecks every financial gate. */
export function assessPayoutReadiness(input: PayoutReadinessInput): PayoutReadiness {
  const reasons: string[] = [];
  if (!input.workspaceExists) reasons.push('workspace_unavailable');
  if (!input.onboardingApproved) reasons.push('onboarding_not_approved');
  if (!input.accountActive) reasons.push('account_inactive');
  if (!input.productionEnabled) reasons.push('payouts_not_enabled_by_nexora');
  if (!input.withdrawalsEnabled) reasons.push('withdrawals_disabled');
  if (!input.pixOutEnabled) reasons.push('pix_out_disabled');
  if (input.movementsBlocked) reasons.push('outgoing_movements_blocked');
  const limitsKnown = positiveCents(input.transferLimitCents) && positiveCents(input.dailyLimitCents);
  if (!limitsKnown) reasons.push('payout_limits_unavailable');
  const usageKnown = input.dailyUsedCents !== null && Number.isSafeInteger(input.dailyUsedCents)
    && input.dailyUsedCents >= 0;
  if (!usageKnown) reasons.push('daily_usage_unavailable');
  const dailyRemaining = limitsKnown && usageKnown
    ? Number(input.dailyLimitCents) - Number(input.dailyUsedCents) : null;
  if (dailyRemaining !== null && dailyRemaining <= 0) reasons.push('daily_limit_reached');
  if (!input.productionRouteAvailable) reasons.push('production_payout_route_unavailable');
  const balanceKnown = input.availableCents !== null && Number.isSafeInteger(input.availableCents);
  if (!balanceKnown) reasons.push('balance_unavailable');
  else if (Number(input.availableCents) <= 0) reasons.push('no_available_balance');

  const maxRequestCents = balanceKnown && limitsKnown && dailyRemaining !== null
    ? Math.max(0, Math.min(Number(input.availableCents), Number(input.transferLimitCents), dailyRemaining))
    : null;
  const canRequest = reasons.length === 0 && positiveCents(maxRequestCents);
  return {
    canRequest,
    availableCents: balanceKnown ? input.availableCents : null,
    maxRequestCents: canRequest ? maxRequestCents : null,
    reasons: canRequest || reasons.length ? reasons : ['payout_amount_unavailable'],
  };
}

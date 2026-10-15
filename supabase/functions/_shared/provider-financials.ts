export type ProviderFinancialSnapshot = {
  grossAmountCents: number;
  providerNetCents: number;
  providerFeeCents: number;
};

function toCents(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
  const amount = Number(value);
  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(rounded)
    || Math.abs(scaled - rounded) > 1e-7) return null;
  return rounded;
}

/** Keep the provider's net/fee as exact integer cents; never guess a fee from a tariff table. */
export function providerFinancialSnapshot(grossAmount: unknown, providerNet: unknown): ProviderFinancialSnapshot {
  const grossAmountCents = toCents(grossAmount);
  const providerNetCents = toCents(providerNet);
  if (grossAmountCents === null || grossAmountCents <= 0 || providerNetCents === null
    || providerNetCents <= 0 || providerNetCents > grossAmountCents) {
    throw new Error('provider_financial_snapshot_invalid');
  }
  return {
    grossAmountCents,
    providerNetCents,
    providerFeeCents: grossAmountCents - providerNetCents,
  };
}

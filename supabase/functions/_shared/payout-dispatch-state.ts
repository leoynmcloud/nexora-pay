export type PayoutDispatchState = 'enabled' | 'disabled' | 'unknown';

/**
 * The UI may offer a dispatch action only when both independent global gates
 * are positively enabled. A missing/unreadable database setting is unknown,
 * and must remain fail-closed.
 */
export function payoutDispatchState(
  databaseEnabled: boolean | null | undefined,
  environmentFlag: string | null | undefined,
): PayoutDispatchState {
  if (databaseEnabled == null) return 'unknown';
  return databaseEnabled === true && environmentFlag === 'true' ? 'enabled' : 'disabled';
}

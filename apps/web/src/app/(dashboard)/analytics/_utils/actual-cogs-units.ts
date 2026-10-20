export const ACTUAL_UNITS_DESCRIPTION =
  'Item quantities in the same orders included in COGS for this report group. Uses the selected order-date range, teams, products or stores, repurchase setting and status exclusions, including RTS. This is item quantity, not order count or COGS divided by a price. — means quantity evidence is unavailable.';

export const FORECAST_UNITS_DESCRIPTION =
  'Projected item quantities for the same population as Forecast COGS: units before the actual RTS exclusion × (1 − assumed RTS %). All other selected filters still apply. Fractional units are expected estimates. — means quantity evidence is unavailable.';

/** Use only the current identity returned by /auth/me, including in View As. */
export function canViewCogsUnits(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'SUPER_ADMIN';
}

export function cogsUnitsValue(value: unknown, view: 'actual' | 'forecast' = 'actual'): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
  return view === 'forecast' || Number.isSafeInteger(value) ? value : null;
}

/** The API supplies the same pre-RTS population used by cogs_forecast_basis. */
export function forecastCogsUnits(value: unknown, rtsPct: number): number | null {
  const units = cogsUnitsValue(value);
  if (units === null || !Number.isFinite(rtsPct) || rtsPct < 0 || rtsPct > 100) return null;
  return units * (1 - rtsPct / 100);
}

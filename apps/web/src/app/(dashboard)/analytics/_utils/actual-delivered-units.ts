export const ACTUAL_DELIVERED_UNITS_DESCRIPTION =
  'Actual item quantities from delivered orders in the selected order-date range, teams, products or stores, and applicable filters. This is not the number of orders or a forecast. Changing the RTS assumption does not change actual units. — means quantity evidence is unavailable.';

/** Use only the current identity returned by /auth/me, including in View As. */
export function canViewActualDeliveredUnits(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'SUPER_ADMIN';
}

export function actualDeliveredUnitsValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

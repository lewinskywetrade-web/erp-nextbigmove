/** Archived 2025 orders and reports are outside ERP COGS refresh authority. */
export const PRODUCT_COGS_REFRESH_FROM = '2026-01-01';
export const PRODUCT_COGS_REFRESH_POLICY = 'ERP_COGS_2026_HISTORY_PROPAGATION_V1';

export function productCogsManilaDate(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error('COGS_REFRESH_CLOCK_INVALID');
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isProductCogsRefreshDate(date: string, until = productCogsManilaDate()): boolean {
  return date >= PRODUCT_COGS_REFRESH_FROM && date <= until;
}

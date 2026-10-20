type CogsReviewValues = { gross_sales?: unknown; cogs?: unknown };

/** Flag missing ERP cost on rows with orders; warehouse zero costs use a separate policy. */
export function zeroCogsReviewPriority(
  row: CogsReviewValues, actualDeliveredOrders: unknown, enabled: boolean,
): 0 | 1 | 2 {
  if (!enabled || typeof row.gross_sales !== 'number' ||
      !Number.isFinite(row.gross_sales) || row.gross_sales <= 0 ||
      typeof row.cogs !== 'number' || !Number.isFinite(row.cogs) || row.cogs !== 0) return 0;
  return typeof actualDeliveredOrders === 'number' &&
    Number.isFinite(actualDeliveredOrders) && actualDeliveredOrders > 0 ? 2 : 1;
}

/** Apply before pagination; retain the selected sort within each priority group. */
export function applySuperAdminCogsReview<T extends {
  row: CogsReviewValues; zeroCogsPriority?: number;
}>(rows: T[], enabled: boolean): T[] {
  if (!enabled) return rows;
  return rows.filter(item => item.row.gross_sales !== 0)
    .sort((a, b) => (b.zeroCogsPriority ?? 0) - (a.zeroCogsPriority ?? 0));
}

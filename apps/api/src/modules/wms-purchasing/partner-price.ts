import { Prisma } from '@prisma/client';

type History = {
  productId: string; tenantId: string; storeId: string;
  cogs: Prisma.Decimal | string | number;
  startDate: Date | string | null; endDate: Date | string | null;
};

function dateKey(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'INVALID';
}

// Quotes use the current Manila business date and ERP's dated-first rule.
// Missing, invalid or ambiguous prices stay unavailable; an explicit zero is
// legitimate partner-supplied stock. Never substitute
// warehouse/supplier prices, retail prices, or a fabricated zero.
export function currentPartnerPrice(
  rows: History[], scope: { productId: string; tenantId: string; storeId: string }, businessDate: string,
): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return null;
  const checked = rows.map(row => ({ row, start: dateKey(row.startDate), end: dateKey(row.endDate) }));
  if (checked.some(({ row, start, end }) => row.productId !== scope.productId
    || row.tenantId !== scope.tenantId || row.storeId !== scope.storeId
    || start === 'INVALID' || end === 'INVALID' || (start && end && start > end))) return null;
  const active = checked.filter(({ start, end }) => start !== null && start <= businessDate
    && (end === null || end >= businessDate));
  const candidates = active.length ? active : checked.filter(({ start, end }) => start === null
    && (end === null || end >= businessDate));
  if (candidates.length !== 1) return null;
  try {
    const price = new Prisma.Decimal(candidates[0].row.cogs);
    return price.isFinite() && price.gte(0) && price.lte('9999999999.99') && price.decimalPlaces() <= 2
      ? price.toNumber() : null;
  } catch { return null; }
}

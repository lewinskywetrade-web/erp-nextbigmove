import type { ErpDailyInventoryReportResponse } from '../_types/reports';

export const DAILY_INVENTORY_READ_PERMISSIONS = [
  'reports.daily_inventory.read',
  'reports.pos_orders.read',
  'stock_request.read',
] as const;

export function hasDailyInventoryReadPermission(permissions: readonly string[]): boolean {
  return DAILY_INVENTORY_READ_PERMISSIONS.some((key) => permissions.includes(key));
}

export function hasPosOrdersReportPermission(permissions: readonly string[]): boolean {
  return permissions.includes('reports.pos_orders.read');
}

export function hasReportsNavPermission(permissions: readonly string[]): boolean {
  return hasPosOrdersReportPermission(permissions) || hasDailyInventoryReadPermission(permissions);
}

export function resolveInitialReportsTab(params: {
  requestedTab?: string | null;
  permissions: readonly string[];
}): 'pos-orders' | 'daily-inventory' {
  if (!hasPosOrdersReportPermission(params.permissions)) {
    return 'daily-inventory';
  }
  if (params.requestedTab === 'daily-inventory') {
    return 'daily-inventory';
  }
  return 'pos-orders';
}

export function pruneSelectedStoreIds(
  selectedStoreIds: readonly string[],
  allowedStores: ReadonlyArray<{ id: string }>,
): string[] {
  if (selectedStoreIds.length === 0 || allowedStores.length === 0) {
    return [];
  }
  const allowedIds = new Set(allowedStores.map((store) => store.id));
  return selectedStoreIds.filter((storeId) => allowedIds.has(storeId));
}

export function canManageClientPortalAutoEmail(
  response?: ErpDailyInventoryReportResponse | null,
): boolean {
  if (!response) {
    return false;
  }
  if (response.filters.canManageEmailSubscription === false) {
    return false;
  }
  return (response.subscriptions?.length ?? 0) > 0;
}

export function getManilaDateDaysAgo(daysAgo: number, baseDate?: string): string {
  const anchor = baseDate ? new Date(`${baseDate}T00:00:00Z`) : new Date(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()) + 'T00:00:00Z',
  );
  anchor.setUTCDate(anchor.getUTCDate() - daysAgo);
  return anchor.toISOString().slice(0, 10);
}

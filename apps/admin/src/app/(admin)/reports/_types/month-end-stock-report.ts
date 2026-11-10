export type MonthEndStockPartner = {
  id: string;
  name: string;
  slug: string | null;
};

export type MonthEndStockStore = {
  id: string;
  tenantId: string;
  tenantName: string;
  shopId: string;
  name: string;
};

export type MonthEndStockRow = {
  rowId: string;
  tenantId: string;
  tenantName: string;
  storeId: string;
  storeName: string;
  shopId: string;
  productId: string;
  variationId: string | null;
  variantCode: string | null;
  variantDisplayId: string | null;
  variantName: string;
  receivedQty: number;
  stagedQty: number;
  awaitingPutAwayQty: number;
  putAwayQty: number;
  reservedQty: number;
  inBinQty: number;
};

export type MonthEndStockTotals = {
  variantCount: number;
  receivedQty: number;
  stagedQty: number;
  awaitingPutAwayQty: number;
  putAwayQty: number;
  reservedQty: number;
  inBinQty: number;
};

export type MonthEndStockReportResponse = {
  report: {
    key: 'MONTH_END_STOCK';
    label: string;
    generatedAt: string;
    basis: 'CURRENT_WMS_SNAPSHOT';
  };
  filters: {
    partners: MonthEndStockPartner[];
    stores: MonthEndStockStore[];
    selectedTenantIds: string[];
    selectedStoreIds: string[];
    effectiveStoreIds: string[];
  };
  totals: MonthEndStockTotals;
  rows: MonthEndStockRow[];
};

export type DailyInventoryMovementRow = {
  rowId: string;
  tenantId: string;
  tenantName: string;
  storeId: string;
  storeName: string;
  shopId: string;
  productId: string;
  variationId: string | null;
  variantCode: string | null;
  variantDisplayId: string | null;
  variantName: string;
  receivedInQty: number;
  manualInQty: number;
  restockedInQty: number;
  totalInQty: number;
  putAwayMovedQty: number;
  dispatchedOutQty: number;
  packedOutQty: number;
  adjustedOutQty: number;
  totalOutQty: number;
  netChangeQty: number;
  receivedQty: number;
  stagedQty: number;
  awaitingPutAwayQty: number;
  putAwayQty: number;
  reservedQty: number;
  inBinQty: number;
  onHandQty: number;
  lastMovementAt: string | null;
};

export type DailyInventoryMovementEventItem = {
  id: string;
  createdAt: string;
  tenantId: string;
  tenantName: string;
  storeId: string;
  storeName: string;
  variantName: string;
  variantCode: string | null;
  unitCode: string;
  movementType: string;
  direction: 'IN' | 'OUT' | 'INTERNAL';
  fromStatus: string | null;
  toStatus: string | null;
  fromLocationCode: string | null;
  toLocationCode: string | null;
  referenceCode: string | null;
  notes: string | null;
  actorName: string | null;
};

export type DailyInventoryMovementsTotals = {
  variantCount: number;
  activeMovedVariantCount: number;
  receivedInQty: number;
  manualInQty: number;
  restockedInQty: number;
  totalInQty: number;
  putAwayMovedQty: number;
  dispatchedOutQty: number;
  packedOutQty: number;
  adjustedOutQty: number;
  totalOutQty: number;
  netChangeQty: number;
  receivedQty: number;
  stagedQty: number;
  awaitingPutAwayQty: number;
  putAwayQty: number;
  reservedQty: number;
  inBinQty: number;
  onHandQty: number;
};

export type ClientDailyInventoryEmailSubscription = {
  tenantId: string;
  tenantName: string;
  enabled: boolean;
  recipients: string[];
  defaultRecipients: string[];
  effectiveRecipients: string[];
  sendTimeManila: string;
  lastSentAt: string | null;
  lastSentDate: string | null;
  lastDeliveryStatus: string | null;
  lastDeliveryMode: string | null;
  lastError: string | null;
};

export type DailyInventoryMovementsReportResponse = {
  report: {
    key: 'DAILY_INVENTORY_INS_OUTS';
    label: string;
    generatedAt: string;
    startDate: string;
    endDate: string;
    timezone: string;
  };
  filters: {
    partners: MonthEndStockPartner[];
    stores: MonthEndStockStore[];
    selectedTenantIds: string[];
    selectedStoreIds: string[];
    effectiveStoreIds: string[];
  };
  totals: DailyInventoryMovementsTotals;
  rows: DailyInventoryMovementRow[];
  recentMovements: DailyInventoryMovementEventItem[];
  subscriptions: ClientDailyInventoryEmailSubscription[];
};

export type SendDailyInventoryEmailResponse = {
  tenantId: string;
  clientName: string;
  dateLabel: string;
  recipients: string[];
  subject: string;
  sentAt: string;
  delivery: {
    delivered: boolean;
    status: string;
    mode: string;
    error?: string | null;
  };
  subscription: ClientDailyInventoryEmailSubscription;
  preview: {
    subject: string;
    html: string;
    text: string;
    csvFilename: string;
    csvContent: string;
  };
};

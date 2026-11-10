export type PosOrdersReportQtyBlock = {
  all_orders: number;
  new_orders: number;
  confirmed: number;
  waiting_pickup: number;
  wait_print: number;
  printed: number;
  shipped: number;
  delivered: number;
  cancelled: number;
  returning: number;
  returned: number;
  restocking: number;
  in_process: number;
  rts_rate: number;
  pending_rate: number;
  cancellation_rate: number;
};

export type PosOrdersReportRevenueBlock = {
  all_orders: number;
  new_orders: number;
  confirmed: number;
  waiting_pickup: number;
  wait_print: number;
  printed: number;
  shipped: number;
  delivered: number;
  cancelled: number;
  returning: number;
  returned: number;
  restocking: number;
  in_process: number;
};

export type PosOrdersReportItem = {
  shop_id: string;
  pos_store_name: string;
  qty: PosOrdersReportQtyBlock;
  revenue: PosOrdersReportRevenueBlock;
};

export type PosOrdersReportResponse = {
  items: PosOrdersReportItem[];
  row_count: number;
  selected: {
    start_date: string;
    end_date: string;
  };
  generated_at: string;
};

export type PosOrdersReportTotals = {
  qty: PosOrdersReportQtyBlock;
  revenue: PosOrdersReportRevenueBlock;
};

export type ErpDailyInventoryMovementRow = {
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

export type ErpDailyInventorySubscription = {
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

export type ErpDailyInventoryReportResponse = {
  report: {
    key: 'DAILY_INVENTORY_INS_OUTS';
    label: string;
    generatedAt: string;
    startDate: string;
    endDate: string;
    timezone: string;
  };
  filters: {
    stores: Array<{
      id: string;
      tenantId: string;
      tenantName: string;
      shopId: string;
      name: string;
    }>;
    selectedStoreIds: string[];
    effectiveStoreIds: string[];
  };
  totals: {
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
  rows: ErpDailyInventoryMovementRow[];
  subscriptions: ErpDailyInventorySubscription[];
};

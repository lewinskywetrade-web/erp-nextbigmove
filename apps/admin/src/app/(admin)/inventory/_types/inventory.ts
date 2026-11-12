export type WmsInventoryUnitStatus =
  | 'RECEIVED'
  | 'STAGED'
  | 'PUTAWAY'
  | 'EXPIRED'
  | 'DEADSTOCK'
  | 'RESERVED'
  | 'PICKED'
  | 'PACKED'
  | 'DISPATCHED'
  | 'RTS'
  | 'DAMAGED'
  | 'LOST'
  | 'ARCHIVED';

export type WmsInventoryUnitRecord = {
  id: string;
  code: string;
  barcode: string;
  status: WmsInventoryUnitStatus;
  labelPrintCount: number;
  firstLabelPrintedAt: string | null;
  lastLabelPrintedAt: string | null;
  posProductId: string;
  productProfileId: string;
  productId: string;
  productCustomId: string | null;
  variationId: string;
  variationDisplayId: string | null;
  name: string;
  unitCost: number | null;
  expirationDate: string | null;
  expiredAt: string | null;
  store: {
    id: string;
    name: string;
  };
  warehouse: {
    id: string;
    code: string;
    name: string;
  };
  currentLocation: {
    id: string;
    code: string;
    name: string;
    kind: 'SECTION' | 'RACK' | 'BIN' | 'RECEIVING_STAGING' | 'PACKING' | 'DISPATCH_STAGING' | 'RTS' | 'DAMAGE' | 'QUARANTINE';
    label: string;
  } | null;
  source: {
    type: 'RECEIVING' | 'MANUAL_INPUT' | 'RTS' | 'ADJUSTMENT' | 'MIGRATION';
    refId: string | null;
    label: string | null;
  } | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WmsInventoryMovementRecord = {
  id: string;
  movementType: 'RECEIPT' | 'MANUAL_RECEIPT' | 'PUTAWAY' | 'TRANSFER' | 'ADJUSTMENT';
  fromStatus: WmsInventoryUnitStatus | null;
  fromStatusLabel: string | null;
  toStatus: WmsInventoryUnitStatus | null;
  toStatusLabel: string | null;
  referenceType: string | null;
  referenceId: string | null;
  referenceCode: string | null;
  notes: string | null;
  fromLocation: WmsInventoryUnitRecord['currentLocation'] | null;
  toLocation: WmsInventoryUnitRecord['currentLocation'] | null;
  actor: {
    name: string;
    email: string;
  } | null;
  createdAt: string;
};

export type VoidWmsInventoryUnitInput = {
  unitId: string;
  reason: string;
  notes?: string;
};

export type WmsInventoryTransferOptionsResponse = {
  unit: {
    id: string;
    code: string;
    status: WmsInventoryUnitStatus;
    warehouse: WmsInventoryUnitRecord['warehouse'];
    currentLocation: WmsInventoryUnitRecord['currentLocation'];
  };
  sections: Array<{
    id: string;
    code: string;
    name: string;
    label: string;
    racks: Array<{
      id: string;
      code: string;
      name: string;
      label: string;
      bins: Array<{
        id: string;
        code: string;
        name: string;
        label: string;
        capacity: number | null;
        occupiedUnits: number;
        availableUnits: number | null;
        isFull: boolean;
      }>;
    }>;
  }>;
  operationalLocations: Array<{
    id: string;
    code: string;
    name: string;
    kind: WmsInventoryUnitRecord['currentLocation'] extends { kind: infer T } ? T : string;
    label: string;
  }>;
};

export type WmsInventoryTransferRecord = {
  id: string;
  code: string;
  status: 'COMPLETED' | 'CANCELED';
  itemCount: number;
  warehouse: WmsInventoryUnitRecord['warehouse'];
  fromLocation: WmsInventoryUnitRecord['currentLocation'] | null;
  toLocation: NonNullable<WmsInventoryUnitRecord['currentLocation']>;
  notes: string | null;
  actor: {
    name: string;
    email: string;
  } | null;
  createdAt: string;
};

export type WmsInventoryStoreTransferOptionsResponse = {
  tenantReady: boolean;
  activeTenantId: string | null;
  activeTargetStoreId: string | null;
  stores: Array<{
    id: string;
    label: string;
  }>;
  products: Array<{
    id: string;
    profileId: string;
    posProductId: string;
    productId: string;
    variationId: string;
    variationDisplayId: string | null;
    productCustomId: string | null;
    name: string;
    label: string;
    alreadyPooled?: boolean;
    recommendShareStockPool?: boolean;
    priorTransferBatches?: number;
    bidirectionalTransferHistory?: boolean;
  }>;
  suggestion: {
    profileId: string;
    label: string;
    reason: string;
    confidence: 'high' | 'medium';
  } | null;
};

export type WmsInventoryOverviewResponse = {
  tenantReady: boolean;
  summary: {
    units: number;
    locatedUnits: number;
    unlocatedUnits: number;
    unitsOnHand: number;
    skuOnHand: number;
    dispatchedUnits: number;
    warehouseCapacity: {
      usedUnits: number;
      totalUnits: number;
      utilizationPercent: number;
    };
  };
  filters: {
    tenants: Array<{
      id: string;
      label: string;
      slug: string;
      status: string;
    }>;
    stores: Array<{
      id: string;
      tenantId: string;
      name: string;
      label: string;
      unitCount: number;
    }>;
    warehouses: Array<{
      id: string;
      code: string;
      label: string;
      unitCount: number;
    }>;
    products: Array<{
      tenantId: string;
      tenantLabel: string;
      storeId: string;
      storeName: string;
      variationId: string;
      name: string;
      label: string;
      selectedLabel: string;
      variationDisplayId: string | null;
      productCustomId: string | null;
      unitCount: number;
    }>;
    statuses: Array<{
      value: WmsInventoryUnitStatus;
      label: string;
      unitCount: number;
    }>;
    activeTenantId: string | null;
    activeStoreId: string | null;
    activeWarehouseId: string | null;
    activeVariationId: string | null;
    activeStatus: WmsInventoryUnitStatus | null;
  };
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
  units: WmsInventoryUnitRecord[];
};

export type WmsInventoryTransfersResponse = {
  tenantReady: boolean;
  summary: {
    transfers: number;
    movedUnits: number;
  };
  filters: {
    tenants: Array<{
      id: string;
      label: string;
      slug: string;
      status: string;
    }>;
    warehouses: Array<{
      id: string;
      code: string;
      label: string;
      transferCount: number;
    }>;
    activeTenantId: string | null;
    activeWarehouseId: string | null;
  };
  transfers: WmsInventoryTransferRecord[];
};

export type GetWmsInventoryOverviewParams = {
  allTenants?: boolean;
  tenantId?: string;
  storeId?: string;
  warehouseId?: string;
  variationId?: string;
  search?: string;
  status?: WmsInventoryUnitStatus;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
};

export type WmsInventoryDateRange = {
  startDate: string;
  endDate: string;
};

export type CreateWmsInventoryTransferInput = {
  unitIds: string[];
  targetLocationId: string;
  notes?: string;
};

export type GetWmsInventoryStoreTransferOptionsParams = {
  tenantId?: string;
  targetStoreId?: string;
  sourceProfileId?: string;
  search?: string;
};

export type CreateWmsInventoryStoreTransferInput = {
  unitIds: string[];
  targetStoreId: string;
  targetProfileId: string;
  shareStockPool?: boolean;
  notes?: string;
};

export type WmsInventoryStoreTransferPreviewResponse = {
  valid: boolean;
  selectedUnits: number;
  sourceAvailableUnits: number;
  remainingAvailableUnits: number;
  activeDemandUnits: number;
  activeDemandOrders: number;
  sourceStore: {
    id: string;
    name: string;
  } | null;
  sourceProduct: {
    profileId: string;
    name: string;
    variationId: string;
    variationDisplayId: string | null;
  } | null;
  targetStore: {
    id: string;
    name: string;
  } | null;
  targetProduct: {
    profileId: string;
    name: string;
    variationId: string;
    variationDisplayId: string | null;
  } | null;
  blockers: Array<{
    code: string;
    message: string;
  }>;
  warnings: Array<{
    code: string;
    message: string;
    severity: 'warning' | 'critical';
  }>;
};

export type GetWmsInventoryTransfersParams = {
  tenantId?: string;
  warehouseId?: string;
  search?: string;
};

export type CreateWmsInventoryAdjustmentInput = {
  unitIds: string[];
  targetStatus: Extract<WmsInventoryUnitStatus, 'STAGED' | 'PUTAWAY' | 'DEADSTOCK' | 'RTS' | 'DAMAGED' | 'LOST' | 'ARCHIVED'>;
  targetLocationId?: string;
  notes?: string;
};

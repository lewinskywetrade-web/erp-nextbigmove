export type WmsProductProfileStatus = 'DEFAULT' | 'READY' | 'ARCHIVED';

export type WmsProductLocationSummary = {
  id: string;
  code: string;
  name: string;
  kind: 'SECTION' | 'RACK' | 'BIN';
  label: string;
  warehouse: {
    id: string;
    code: string;
    name: string;
  };
};

export type WmsProductLinkedPoolPeer = {
  profileId: string;
  storeId: string;
  storeName: string;
  name: string;
  productId: string;
  variationId: string;
  variationDisplayId: string | null;
  productCustomId: string | null;
  directBinUnits: number;
};

export type WmsProductPoolCandidateOption = {
  profileId: string;
  storeId: string;
  storeName: string;
  name: string;
  productId: string;
  variationId: string;
  variationDisplayId: string | null;
  productCustomId: string | null;
  stockPoolGroupId: string | null;
  directBinUnits: number;
};

export type WmsProductProfileRecord = {
  id: string;
  profileId: string | null;
  posProductId: string;
  status: WmsProductProfileStatus | null;
  isSerialized: boolean | null;
  requiresExpirationDate: boolean;
  isStockable: boolean;
  stockabilityReason: string | null;
  productId: string;
  variationId: string | null;
  variationDisplayId: string | null;
  productCustomId: string | null;
  name: string;
  customId: string | null;
  retailPrice: string | null;
  inhouseUnitCost: string | null;
  supplierUnitCost: string | null;
  stockPoolGroupId?: string | null;
  directBinUnits?: number;
  pooledBinUnits?: number;
  linkedProfiles?: WmsProductLinkedPoolPeer[];
  posWarehouse: {
    id: string;
    warehouseId: string;
    name: string;
  } | null;
  store: {
    id: string;
    name: string;
  };
  preferredLocation: WmsProductLocationSummary | null;
  pickLocation: WmsProductLocationSummary | null;
  handling: {
    isFragile: boolean;
    isStackable: boolean;
    keepDry: boolean;
  };
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WmsProductsOverviewResponse = {
  tenantReady: boolean;
  summary: {
    products: number;
    defaultProfiles: number;
    readyProfiles: number;
    serializedProfiles: number;
    warehouseScopedProducts: number;
    assignedProfiles: number;
    unassignedProfiles: number;
    nonStockableProducts: number;
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
      productCount: number;
    }>;
    posWarehouses: Array<{
      id: string;
      warehouseId: string;
      label: string;
      productCount: number;
    }>;
    activeTenantId: string | null;
    activeStoreId: string | null;
    activePosWarehouseId: string | null;
  };
  locationOptions: Array<{
    id: string;
    code: string;
    name: string;
    kind: 'SECTION' | 'RACK' | 'BIN';
    label: string;
    warehouse: {
      id: string;
      code: string;
      name: string;
    };
  }>;
  poolCandidateOptions?: WmsProductPoolCandidateOption[];
  products: WmsProductProfileRecord[];
};

export type GetWmsProductsOverviewParams = {
  allTenants?: boolean;
  tenantId?: string;
  storeId?: string;
  posWarehouseId?: string;
  search?: string;
  status?: WmsProductProfileStatus;
};

export type SyncWmsProductsStoreResponse = {
  store: {
    id: string;
    name: string;
  };
  syncedCount: number;
  profileCount: number;
};

export type UpdateWmsProductProfileInput = {
  status?: WmsProductProfileStatus;
  isSerialized?: boolean;
  requiresExpirationDate?: boolean;
  preferredLocationId?: string | null;
  isFragile?: boolean;
  isStackable?: boolean;
  keepDry?: boolean;
  inhouseUnitCost?: number | null;
  supplierUnitCost?: number | null;
  notes?: string | null;
  linkedProfileIds?: string[];
};

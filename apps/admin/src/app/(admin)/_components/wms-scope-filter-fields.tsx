'use client';

import { WmsSearchableSelect, type WmsSearchableOption } from './wms-searchable-select';

type WmsScopeFilterFieldsProps = {
  tenantOptions?: WmsSearchableOption[];
  selectedTenantId?: string;
  onTenantChange?: (value: string | undefined) => void;
  storeOptions?: WmsSearchableOption[];
  selectedStoreId?: string;
  onStoreChange?: (value: string | undefined) => void;
  warehouseOptions?: WmsSearchableOption[];
  selectedWarehouseId?: string;
  onWarehouseChange?: (value: string | undefined) => void;
  allowAllTenants?: boolean;
};

export function WmsScopeFilterFields({
  tenantOptions = [],
  selectedTenantId,
  onTenantChange,
  storeOptions = [],
  selectedStoreId,
  onStoreChange,
  warehouseOptions = [],
  selectedWarehouseId,
  onWarehouseChange,
  allowAllTenants = false,
}: WmsScopeFilterFieldsProps) {
  return (
    <>
      {onTenantChange ? (
        <WmsSearchableSelect
          label="Client"
          value={selectedTenantId ?? ''}
          onChange={(value) => onTenantChange(value || undefined)}
          options={tenantOptions}
          placeholder="Search clients…"
          allLabel={allowAllTenants ? 'All clients' : 'Select client'}
          clearable={allowAllTenants}
          hideInlineLabel={true}
        />
      ) : null}

      {onStoreChange ? (
        <WmsSearchableSelect
          label="Store"
          value={selectedStoreId ?? ''}
          onChange={(value) => onStoreChange(value || undefined)}
          options={storeOptions}
          placeholder="Search stores…"
          allLabel="All stores"
          hideInlineLabel={true}
        />
      ) : null}

      {onWarehouseChange ? (
        <WmsSearchableSelect
          label="Warehouse"
          value={selectedWarehouseId ?? ''}
          onChange={(value) => onWarehouseChange(value || undefined)}
          options={warehouseOptions}
          placeholder="Search warehouses…"
          allLabel="All warehouses"
          hideInlineLabel={true}
        />
      ) : null}
    </>
  );
}

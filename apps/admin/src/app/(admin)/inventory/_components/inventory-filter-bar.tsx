'use client';

import { useEffect, useMemo } from 'react';
import { Search, X } from 'lucide-react';
import { WmsSearchableSelect } from '../../_components/wms-searchable-select';
import type { WmsInventoryOverviewResponse, WmsInventoryUnitStatus } from '../_types/inventory';

type InventoryFilterBarProps = {
  filters: WmsInventoryOverviewResponse['filters'] | null | undefined;
  searchText: string;
  onSearchTextChange: (value: string) => void;
  selectedTenantId?: string;
  onTenantChange: (value: string | undefined) => void;
  selectedStoreId?: string;
  onStoreChange: (value: string | undefined) => void;
  selectedProductValue?: string;
  onProductChange: (product: WmsInventoryOverviewResponse['filters']['products'][number] | undefined) => void;
  selectedWarehouseId?: string;
  onWarehouseChange: (value: string | undefined) => void;
  selectedStatus?: WmsInventoryUnitStatus;
  onStatusChange: (value: WmsInventoryUnitStatus | undefined) => void;
};

function buildInventoryProductFilterValue(
  product: WmsInventoryOverviewResponse['filters']['products'][number],
) {
  return `${product.tenantId}::${product.storeId}::${product.variationId}`;
}

export function InventoryFilterBar({
  filters,
  searchText,
  onSearchTextChange,
  selectedTenantId,
  onTenantChange,
  selectedStoreId,
  onStoreChange,
  selectedProductValue,
  onProductChange,
  selectedWarehouseId,
  onWarehouseChange,
  selectedStatus,
  onStatusChange,
}: InventoryFilterBarProps) {
  const products = useMemo(() => filters?.products ?? [], [filters?.products]);
  const canFilterByProduct = Boolean(selectedTenantId || selectedStoreId);
  const tenantOptions = useMemo(
    () => (filters?.tenants ?? []).map((tenant) => ({
      value: tenant.id,
      label: tenant.label,
    })),
    [filters?.tenants],
  );
  const storeOptions = useMemo(
    () => (filters?.stores ?? []).map((store) => ({
      value: store.id,
      label: store.label,
      selectedLabel: store.name,
      hint: store.unitCount,
    })),
    [filters?.stores],
  );
  const productOptions = useMemo(
    () => products.map((product) => ({
      value: buildInventoryProductFilterValue(product),
      label: product.label,
      selectedLabel: product.selectedLabel,
      hint: product.unitCount,
    })),
    [products],
  );
  const warehouseOptions = useMemo(
    () => (filters?.warehouses ?? []).map((warehouse) => ({
      value: warehouse.id,
      label: warehouse.label,
      hint: warehouse.unitCount,
    })),
    [filters?.warehouses],
  );
  const statusOptions = useMemo(
    () => (filters?.statuses ?? []).map((status) => ({
      value: status.value,
      label: status.label,
      hint: status.unitCount,
    })),
    [filters?.statuses],
  );

  useEffect(() => {
    if (!canFilterByProduct && selectedProductValue) {
      onProductChange(undefined);
    }
  }, [canFilterByProduct, onProductChange, selectedProductValue]);

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2.5">
      <div className="relative min-w-[240px] flex-[1_1_20rem]">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]" />
        <input
          type="text"
          value={searchText}
          onChange={(event) => onSearchTextChange(event.target.value)}
          placeholder="Search by unit, barcode, product, or variation"
          className="input pr-10 pl-10 text-sm-custom grow"
        />
        {searchText ? (
          <button
            type="button"
            onClick={() => onSearchTextChange('')}
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-[#8193a0] transition hover:bg-[#eef2f5] hover:text-primary"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>

      <WmsSearchableSelect
        label="Client"
        value={selectedTenantId ?? ''}
        onChange={(value) => onTenantChange(value || undefined)}
        options={tenantOptions}
        placeholder="Search clients…"
        allLabel="All clients"
        hideInlineLabel={true}
      />

      <WmsSearchableSelect
        label="Store"
        value={selectedStoreId ?? ''}
        onChange={(value) => onStoreChange(value || undefined)}
        options={storeOptions}
        placeholder="Search stores…"
        allLabel="All stores"
        hideInlineLabel={true}
      />

      {canFilterByProduct ? (
        <WmsSearchableSelect
          label="Product"
          value={selectedProductValue ?? ''}
          onChange={(value) => {
            if (!value) {
              onProductChange(undefined);
              return;
            }

            onProductChange(
              products.find((product) => buildInventoryProductFilterValue(product) === value),
            );
          }}
          options={productOptions}
          placeholder="Search products…"
          allLabel="All products"
          hideInlineLabel={true}
        />
      ) : null}

      <WmsSearchableSelect
        label="Warehouse"
        value={selectedWarehouseId ?? ''}
        onChange={(value) => onWarehouseChange(value || undefined)}
        options={warehouseOptions}
        placeholder="Search warehouses…"
        allLabel="All warehouses"
        hideInlineLabel={true}
      />

      <WmsSearchableSelect
        label="Status"
        value={selectedStatus ?? ''}
        onChange={(value) => onStatusChange((value as WmsInventoryUnitStatus) || undefined)}
        options={statusOptions}
        placeholder="Search statuses…"
        allLabel="All statuses"
        hideInlineLabel={true}
      />
    </div>
  );
}

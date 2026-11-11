'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { readStoredAdminUser, readStoredPermissions } from '@/lib/admin-session';
import { useWmsScopeFilters } from '../../_hooks/use-wms-scope-filters';
import {
  hasAnyAdminPermission,
  WMS_INVENTORY_ADJUST_PERMISSIONS,
  WMS_INVENTORY_DELETE_PERMISSIONS,
  WMS_INVENTORY_PRINT_LABELS_PERMISSIONS,
  WMS_INVENTORY_TRANSFER_PERMISSIONS,
} from '@/lib/wms-permissions';
import {
  createWmsInventoryAdjustment,
  createWmsInventoryStoreTransfer,
  createWmsInventoryTransfer,
  fetchWmsInventoryOverview,
  fetchWmsInventoryStoreTransferOptions,
  fetchWmsInventoryUnitMovements,
  fetchWmsInventoryUnitTransferOptions,
  previewWmsInventoryStoreTransfer,
  recordWmsInventoryUnitLabelPrint,
  voidWmsInventoryUnit,
} from '../_services/inventory.service';
import type {
  CreateWmsInventoryAdjustmentInput,
  CreateWmsInventoryStoreTransferInput,
  CreateWmsInventoryTransferInput,
  VoidWmsInventoryUnitInput,
  WmsInventoryDateRange,
  WmsInventoryOverviewResponse,
  WmsInventoryUnitRecord,
  WmsInventoryUnitStatus,
} from '../_types/inventory';
import { getDefaultInventoryDateRange } from '../_utils/inventory-date-range';

type UnitModalState = {
  open: boolean;
  unit: WmsInventoryUnitRecord | null;
};

type StoreTransferModalState = {
  open: boolean;
  targetStoreId: string;
  targetProfileId: string;
  shareStockPool: boolean;
  notes: string;
  errorMessage: string | null;
};

type BulkAdjustModalState = {
  open: boolean;
};

const SEARCH_DEBOUNCE_MS = 300;

function buildInventoryProductFilterValue(
  product: WmsInventoryOverviewResponse['filters']['products'][number],
) {
  return `${product.tenantId}::${product.storeId}::${product.variationId}`;
}

function getErrorMessage(error: unknown) {
  if (axios.isAxiosError(error)) {
    const payload = error.response?.data;

    if (Array.isArray(payload?.message)) {
      return payload.message.join(' ');
    }

    if (typeof payload?.message === 'string') {
      return payload.message;
    }

    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Request failed';
}

export function useInventoryController() {
  const queryClient = useQueryClient();
  const pageSize = 10;
  const user = useMemo(() => readStoredAdminUser(), []);
  const permissions = useMemo(() => readStoredPermissions(), []);
  const [selectedTenantId, setSelectedTenantIdState] = useState<string | undefined>();
  const [selectedStoreId, setSelectedStoreIdState] = useState<string | undefined>();
  const [selectedWarehouseId, setSelectedWarehouseIdState] = useState<string | undefined>();
  const [selectedVariationId, setSelectedVariationId] = useState<string | undefined>();
  const [selectedProductValue, setSelectedProductValue] = useState<string | undefined>();
  const [selectedStatus, setSelectedStatus] = useState<WmsInventoryUnitStatus | undefined>();
  const [dateRange, setDateRange] = useState<WmsInventoryDateRange>(getDefaultInventoryDateRange);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchText, setSearchText] = useState('');
  const [debouncedSearchText, setDebouncedSearchText] = useState('');
  const [unitModal, setUnitModal] = useState<UnitModalState>({
    open: false,
    unit: null,
  });
  const [selectedUnitsById, setSelectedUnitsById] = useState<Record<string, WmsInventoryUnitRecord>>({});
  const [storeTransferModal, setStoreTransferModal] = useState<StoreTransferModalState>({
    open: false,
    targetStoreId: '',
    targetProfileId: '',
    shareStockPool: false,
    notes: '',
    errorMessage: null,
  });
  const [bulkAdjustModal, setBulkAdjustModal] = useState<BulkAdjustModalState>({
    open: false,
  });

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchText(searchText.trim());
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [searchText]);

  const overviewQuery = useQuery({
    queryKey: [
      'wms-inventory-overview',
      selectedTenantId ?? 'default-tenant',
      selectedStoreId ?? 'all-stores',
      selectedWarehouseId ?? 'all-warehouses',
      selectedVariationId ?? 'all-products',
      selectedStatus ?? 'all-statuses',
      debouncedSearchText,
      currentPage,
      pageSize,
    ],
    queryFn: ({ signal }) =>
      fetchWmsInventoryOverview({
        allTenants: !selectedTenantId,
        tenantId: selectedTenantId,
        storeId: selectedStoreId,
        warehouseId: selectedWarehouseId,
        variationId: selectedVariationId,
        search: debouncedSearchText || undefined,
        status: selectedStatus,
        page: currentPage,
        pageSize,
      }, signal),
    placeholderData: (previous) => previous,
  });

  const scopeFilters = useWmsScopeFilters({
    filters: overviewQuery.data?.filters,
    selectedTenantId,
    setSelectedTenantIdState,
    selectedStoreId,
    setSelectedStoreIdState,
    selectedWarehouseId,
    setSelectedWarehouseIdState,
    includeWarehouse: true,
    allowAllTenants: true,
  });

  const handleTenantChange = useCallback((tenantId: string | undefined) => {
    setSelectedVariationId(undefined);
    setSelectedProductValue(undefined);
    scopeFilters.setSelectedTenantId(tenantId);
    setSelectedStatus(undefined);
  }, [scopeFilters]);

  const handleStoreChange = useCallback((storeId: string | undefined) => {
    setSelectedVariationId(undefined);
    setSelectedProductValue(undefined);
    scopeFilters.setSelectedStoreId(storeId);
  }, [scopeFilters]);

  const handleWarehouseChange = useCallback((warehouseId: string | undefined) => {
    setSelectedVariationId(undefined);
    setSelectedProductValue(undefined);
    scopeFilters.setSelectedWarehouseId(warehouseId);
  }, [scopeFilters]);

  const handleProductChange = useCallback((
    product: WmsInventoryOverviewResponse['filters']['products'][number] | undefined,
  ) => {
    if (!product) {
      setSelectedVariationId(undefined);
      setSelectedProductValue(undefined);
      return;
    }

    setSelectedVariationId(product.variationId);
    setSelectedProductValue(buildInventoryProductFilterValue(product));
    scopeFilters.setSelectedStoreId(product.storeId);
  }, [scopeFilters]);

  useEffect(() => {
    if (!selectedStatus) {
      return;
    }

    const statuses = overviewQuery.data?.filters.statuses;
    if (!statuses) {
      return;
    }

    const stillExists = statuses.some((status) => status.value === selectedStatus);

    if (!stillExists) {
      setSelectedStatus(undefined);
    }
  }, [overviewQuery.data?.filters.statuses, selectedStatus]);

  useEffect(() => {
    if (!selectedProductValue) {
      return;
    }

    const products = overviewQuery.data?.filters.products;
    if (!products) {
      return;
    }

    const stillExists = products.some(
      (product) => buildInventoryProductFilterValue(product) === selectedProductValue,
    );

    if (!stillExists) {
      setSelectedVariationId(undefined);
      setSelectedProductValue(undefined);
    }
  }, [overviewQuery.data?.filters.products, selectedProductValue]);

  useEffect(() => {
    setCurrentPage(1);
    setSelectedUnitsById({});
  }, [
    selectedTenantId,
    selectedStoreId,
    selectedWarehouseId,
    selectedVariationId,
    selectedProductValue,
    selectedStatus,
    debouncedSearchText,
  ]);

  const errorMessage = useMemo(() => {
    if (!overviewQuery.error) {
      return null;
    }

    return getErrorMessage(overviewQuery.error);
  }, [overviewQuery.error]);

  const totalPages = useMemo(() => {
    return overviewQuery.data?.pagination.totalPages ?? 1;
  }, [overviewQuery.data?.pagination.totalPages]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedUnits = useMemo(() => overviewQuery.data?.units ?? [], [overviewQuery.data?.units]);
  const selectedUnitIds = useMemo(() => Object.keys(selectedUnitsById), [selectedUnitsById]);
  const selectedUnits = useMemo(() => Object.values(selectedUnitsById), [selectedUnitsById]);

  useEffect(() => {
    setSelectedUnitsById((current) => {
      let changed = false;
      const next = { ...current };

      for (const unit of paginatedUnits) {
        if (current[unit.id] && current[unit.id] !== unit) {
          next[unit.id] = unit;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [paginatedUnits]);
  const selectedBulkAdjustSourceUnitId = selectedUnits[0]?.id ?? null;
  const selectedSourceProfileId = selectedUnits.length > 0
    ? selectedUnits[0]?.productProfileId
    : undefined;

  const recordUnitLabelPrintMutation = useMutation({
    mutationFn: (input: { unitId: string; action: 'PRINT' | 'REPRINT' }) =>
      recordWmsInventoryUnitLabelPrint(input.unitId, { action: input.action }, selectedTenantId),
    onSuccess: async (response) => {
      setUnitModal((current) => {
        if (!current.open || !current.unit || current.unit.id !== response.unit.id) {
          return current;
        }

        return {
          open: true,
          unit: response.unit,
        };
      });

      await queryClient.invalidateQueries({ queryKey: ['wms-inventory-overview'] });
    },
  });

  const unitMovementsQuery = useQuery({
    queryKey: ['wms-inventory-unit-movements', unitModal.unit?.id ?? null, selectedTenantId ?? 'default-tenant'],
    queryFn: () => fetchWmsInventoryUnitMovements(unitModal.unit!.id, selectedTenantId),
    enabled: Boolean(unitModal.open && unitModal.unit?.id),
  });

  const unitTransferOptionsQuery = useQuery({
    queryKey: ['wms-inventory-unit-transfer-options', unitModal.unit?.id ?? null, selectedTenantId ?? 'default-tenant'],
    queryFn: () => fetchWmsInventoryUnitTransferOptions(unitModal.unit!.id, selectedTenantId),
    enabled: Boolean(unitModal.open && unitModal.unit?.id),
  });

  const bulkAdjustTransferOptionsQuery = useQuery({
    queryKey: [
      'wms-inventory-bulk-adjust-transfer-options',
      selectedBulkAdjustSourceUnitId,
      selectedTenantId ?? 'default-tenant',
      bulkAdjustModal.open,
    ],
    queryFn: () => fetchWmsInventoryUnitTransferOptions(selectedBulkAdjustSourceUnitId!, selectedTenantId),
    enabled: Boolean(bulkAdjustModal.open && selectedBulkAdjustSourceUnitId),
  });

  const storeTransferOptionsQuery = useQuery({
    queryKey: [
      'wms-inventory-store-transfer-options',
      selectedTenantId ?? 'default-tenant',
      storeTransferModal.targetStoreId || 'no-target-store',
      selectedSourceProfileId ?? 'no-source-profile',
      storeTransferModal.open,
    ],
    queryFn: () =>
      fetchWmsInventoryStoreTransferOptions({
        tenantId: selectedTenantId,
        targetStoreId: storeTransferModal.targetStoreId || undefined,
        sourceProfileId: selectedSourceProfileId,
      }),
    enabled: storeTransferModal.open,
  });
  const storeTransferPreviewQuery = useQuery({
    queryKey: [
      'wms-inventory-store-transfer-preview',
      selectedTenantId ?? 'default-tenant',
      selectedUnitIds,
      storeTransferModal.targetStoreId || 'no-target-store',
      storeTransferModal.targetProfileId || 'no-target-profile',
      storeTransferModal.open,
    ],
    queryFn: () =>
      previewWmsInventoryStoreTransfer({
        unitIds: selectedUnitIds,
        targetStoreId: storeTransferModal.targetStoreId,
        targetProfileId: storeTransferModal.targetProfileId,
      }, selectedTenantId),
    enabled: Boolean(
      storeTransferModal.open
      && selectedUnitIds.length > 0
      && storeTransferModal.targetStoreId
      && storeTransferModal.targetProfileId,
    ),
  });
  const suggestedTargetProfileId = storeTransferOptionsQuery.data?.suggestion?.profileId ?? null;
  const suggestedTargetAlreadyPooled = Boolean(
    suggestedTargetProfileId
    && storeTransferOptionsQuery.data?.products.find(
      (product) => product.profileId === suggestedTargetProfileId,
    )?.alreadyPooled,
  );

  useEffect(() => {
    if (
      !storeTransferModal.open
      || !storeTransferModal.targetStoreId
      || storeTransferModal.targetProfileId
      || !suggestedTargetProfileId
    ) {
      return;
    }

    setStoreTransferModal((current) => (
      current.targetProfileId
        ? current
        : {
            ...current,
            targetProfileId: suggestedTargetProfileId,
            shareStockPool: suggestedTargetAlreadyPooled,
          }
    ));
  }, [
    storeTransferModal.open,
    storeTransferModal.targetStoreId,
    storeTransferModal.targetProfileId,
    suggestedTargetProfileId,
    suggestedTargetAlreadyPooled,
  ]);

  const createTransferMutation = useMutation({
    mutationFn: (input: CreateWmsInventoryTransferInput) =>
      createWmsInventoryTransfer(input, selectedTenantId),
    onSuccess: async (response) => {
      const updatedUnit = response.units[0] ?? null;

      setUnitModal((current) => {
        if (!current.open || !current.unit || !updatedUnit || current.unit.id !== updatedUnit.id) {
          return current;
        }

        return {
          open: true,
          unit: updatedUnit,
        };
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-unit-movements'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-unit-transfer-options'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-transfers'] }),
      ]);
    },
  });

  const createStoreTransferMutation = useMutation({
    mutationFn: (input: CreateWmsInventoryStoreTransferInput) =>
      createWmsInventoryStoreTransfer(input, selectedTenantId),
    onSuccess: async () => {
      setSelectedUnitsById({});
      setStoreTransferModal({
        open: false,
        targetStoreId: '',
        targetProfileId: '',
        shareStockPool: false,
        notes: '',
        errorMessage: null,
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-unit-movements'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-store-transfer-options'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-transfers'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-products-overview'] }),
      ]);
    },
  });

  const createAdjustmentMutation = useMutation({
    mutationFn: (input: CreateWmsInventoryAdjustmentInput) =>
      createWmsInventoryAdjustment(input, selectedTenantId),
    onSuccess: async (response) => {
      const updatedUnit = response.units[0] ?? null;

      setUnitModal((current) => {
        if (!current.open || !current.unit || !updatedUnit || current.unit.id !== updatedUnit.id) {
          return current;
        }

        return {
          open: true,
          unit: updatedUnit,
        };
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-unit-movements'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-unit-transfer-options'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-transfers'] }),
      ]);
    },
  });

  const voidUnitMutation = useMutation({
    mutationFn: (input: VoidWmsInventoryUnitInput) =>
      voidWmsInventoryUnit(input, selectedTenantId),
    onSuccess: async (response) => {
      setSelectedUnitsById((current) => {
        if (!current[response.unit.id]) {
          return current;
        }

        const next = { ...current };
        delete next[response.unit.id];
        return next;
      });
      setUnitModal((current) => {
        if (!current.open || !current.unit || current.unit.id !== response.unit.id) {
          return current;
        }

        return {
          open: true,
          unit: response.unit,
        };
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-unit-movements'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-unit-transfer-options'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-transfers'] }),
        queryClient.invalidateQueries({ queryKey: ['wms-inventory-store-transfer-options'] }),
      ]);
    },
  });

  async function recordUnitLabelPrint(unitId: string, action: 'PRINT' | 'REPRINT') {
    try {
      await recordUnitLabelPrintMutation.mutateAsync({ unitId, action });
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  }

  async function transferUnit(input: CreateWmsInventoryTransferInput) {
    try {
      await createTransferMutation.mutateAsync(input);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  }

  async function adjustUnit(input: CreateWmsInventoryAdjustmentInput) {
    try {
      await createAdjustmentMutation.mutateAsync(input);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  }

  async function voidUnit(input: VoidWmsInventoryUnitInput) {
    try {
      await voidUnitMutation.mutateAsync(input);
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  }

  function toggleUnitSelection(unitId: string) {
    setSelectedUnitsById((current) => {
      if (current[unitId]) {
        const next = { ...current };
        delete next[unitId];
        return next;
      }

      const unit = paginatedUnits.find((candidate) => candidate.id === unitId);
      return unit ? { ...current, [unit.id]: unit } : current;
    });
  }

  function toggleVisibleUnitSelection() {
    setSelectedUnitsById((current) => {
      const allVisibleSelected = paginatedUnits.length > 0
        && paginatedUnits.every((unit) => Boolean(current[unit.id]));

      if (allVisibleSelected) {
        const next = { ...current };
        paginatedUnits.forEach((unit) => delete next[unit.id]);
        return next;
      }

      const next = { ...current };
      paginatedUnits.forEach((unit) => {
        next[unit.id] = unit;
      });
      return next;
    });
  }

  function openStoreTransferModal() {
    setStoreTransferModal({
      open: true,
      targetStoreId: selectedUnits[0]?.store.id ?? '',
      targetProfileId: '',
      shareStockPool: false,
      notes: '',
      errorMessage: null,
    });
  }

  function closeStoreTransferModal() {
    setStoreTransferModal({
      open: false,
      targetStoreId: '',
      targetProfileId: '',
      shareStockPool: false,
      notes: '',
      errorMessage: null,
    });
  }

  function openBulkAdjustModal() {
    setBulkAdjustModal({ open: true });
  }

  function closeBulkAdjustModal() {
    setBulkAdjustModal({ open: false });
  }

  async function submitStoreTransfer() {
    try {
      setStoreTransferModal((current) => ({ ...current, errorMessage: null }));
      await createStoreTransferMutation.mutateAsync({
        unitIds: selectedUnitIds,
        targetStoreId: storeTransferModal.targetStoreId,
        targetProfileId: storeTransferModal.targetProfileId,
        shareStockPool: storeTransferModal.shareStockPool,
        notes: storeTransferModal.notes.trim() || undefined,
      });
    } catch (error) {
      setStoreTransferModal((current) => ({
        ...current,
        errorMessage: getErrorMessage(error),
      }));
    }
  }

  return {
    overview: overviewQuery.data ?? null,
    units: paginatedUnits,
    selectedUnits,
    selectedUnitIds,
    isLoading: overviewQuery.isLoading,
    isFetching: overviewQuery.isFetching,
    errorMessage,
    selectedTenantId,
    selectedStoreId,
    selectedWarehouseId,
    selectedVariationId,
    selectedProductValue,
    selectedStatus,
    dateRange,
    currentPage,
    totalPages,
    searchText,
    unitModal,
    storeTransferModal,
    bulkAdjustModal,
    canPrintLabels: hasAnyAdminPermission(
      user?.role ?? null,
      permissions,
      WMS_INVENTORY_PRINT_LABELS_PERMISSIONS,
    ),
    canTransferUnits: hasAnyAdminPermission(
      user?.role ?? null,
      permissions,
      WMS_INVENTORY_TRANSFER_PERMISSIONS,
    ),
    canAdjustUnits: hasAnyAdminPermission(
      user?.role ?? null,
      permissions,
      WMS_INVENTORY_ADJUST_PERMISSIONS,
    ),
    canVoidUnits: hasAnyAdminPermission(
      user?.role ?? null,
      permissions,
      WMS_INVENTORY_DELETE_PERMISSIONS,
    ),
    isRecordingUnitLabelPrint: recordUnitLabelPrintMutation.isPending,
    unitMovements: unitMovementsQuery.data?.movements ?? [],
    transferOptions: unitTransferOptionsQuery.data ?? null,
    bulkAdjustTransferOptions: bulkAdjustTransferOptionsQuery.data ?? null,
    storeTransferOptions: storeTransferOptionsQuery.data ?? null,
    storeTransferPreview: storeTransferPreviewQuery.data ?? null,
    storeTransferPreviewErrorMessage: storeTransferPreviewQuery.error
      ? getErrorMessage(storeTransferPreviewQuery.error)
      : null,
    isLoadingUnitMovements: unitMovementsQuery.isLoading || unitMovementsQuery.isFetching,
    isLoadingUnitTransferOptions:
      unitTransferOptionsQuery.isLoading || unitTransferOptionsQuery.isFetching,
    isLoadingBulkAdjustTransferOptions:
      bulkAdjustTransferOptionsQuery.isLoading || bulkAdjustTransferOptionsQuery.isFetching,
    isLoadingStoreTransferOptions:
      storeTransferOptionsQuery.isLoading || storeTransferOptionsQuery.isFetching,
    isLoadingStoreTransferPreview:
      storeTransferPreviewQuery.isLoading || storeTransferPreviewQuery.isFetching,
    isTransferringUnit: createTransferMutation.isPending,
    isTransferringStoreUnits: createStoreTransferMutation.isPending,
    isAdjustingUnit: createAdjustmentMutation.isPending,
    isVoidingUnit: voidUnitMutation.isPending,
    setSelectedTenantId: handleTenantChange,
    setSelectedStoreId: handleStoreChange,
    setSelectedWarehouseId: handleWarehouseChange,
    setSelectedVariationId: handleProductChange,
    setSelectedStatus,
    setDateRange,
    setCurrentPage,
    setSearchText,
    recordUnitLabelPrint,
    transferUnit,
    adjustUnit,
    voidUnit,
    toggleUnitSelection,
    toggleVisibleUnitSelection,
    clearUnitSelection: () => setSelectedUnitsById({}),
    openStoreTransferModal,
    closeStoreTransferModal,
    openBulkAdjustModal,
    closeBulkAdjustModal,
    setStoreTransferTargetStoreId: (targetStoreId: string) =>
      setStoreTransferModal((current) => ({
        ...current,
        targetStoreId,
        targetProfileId: '',
        shareStockPool: false,
        errorMessage: null,
      })),
    setStoreTransferTargetProfileId: (targetProfileId: string) => {
      const matchedProduct = storeTransferOptionsQuery.data?.products.find(
        (product) => product.profileId === targetProfileId,
      );
      setStoreTransferModal((current) => ({
        ...current,
        targetProfileId,
        shareStockPool: Boolean(matchedProduct?.alreadyPooled),
        errorMessage: null,
      }));
    },
    setStoreTransferShareStockPool: (shareStockPool: boolean) =>
      setStoreTransferModal((current) => ({
        ...current,
        shareStockPool,
      })),
    setStoreTransferNotes: (notes: string) =>
      setStoreTransferModal((current) => ({
        ...current,
        notes,
      })),
    submitStoreTransfer,
    openUnitModal: (unit: WmsInventoryUnitRecord) => setUnitModal({ open: true, unit }),
    closeUnitModal: () => setUnitModal({ open: false, unit: null }),
  };
}

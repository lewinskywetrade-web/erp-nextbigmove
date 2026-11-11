'use client';

import { useEffect, useMemo, useState } from 'react';
import { Archive, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { WmsPageShell } from '../../_components/wms-page-shell';
import { WmsInlineNotice } from '../../_components/wms-inline-notice';
import { WmsWorkspaceCard } from '../../_components/wms-workspace-card';
import { useInventoryController } from '../_hooks/use-inventory-controller';
import type { WmsInventoryUnitStatus } from '../_types/inventory';
import { InventoryBulkAdjustModal } from './inventory-bulk-adjust-modal';
import { InventoryBulkActionsMenu } from './inventory-bulk-actions-menu';
import { InventoryBulkArchiveModal } from './inventory-bulk-archive-modal';
import { InventoryFilterBar } from './inventory-filter-bar';
import { InventoryStockDashboard } from './inventory-stock-dashboard';
import { InventoryStoreTransferModal } from './inventory-store-transfer-modal';
import { InventoryUnitModal } from './inventory-unit-modal';
import { InventoryUnitsTable } from './inventory-units-table';

const BULK_ARCHIVABLE_STATUSES = new Set<WmsInventoryUnitStatus>([
  'RECEIVED',
  'STAGED',
  'PUTAWAY',
  'EXPIRED',
  'DEADSTOCK',
  'RESERVED',
  'RTS',
  'DAMAGED',
  'LOST',
]);

export function InventoryStockScreen() {
  const inventory = useInventoryController();
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const selectedUnitCount = inventory.selectedUnitIds.length;
  const closeBulkAdjustModal = inventory.closeBulkAdjustModal;
  const canSelectUnits = inventory.canTransferUnits || inventory.canAdjustUnits;
  const canTransferSelectedUnits = inventory.canTransferUnits;
  const canAdjustSelectedUnits = inventory.canAdjustUnits
    && selectedUnitCount > 0;
  const archiveBlockedUnit = useMemo(
    () => inventory.selectedUnits.find((unit) => !BULK_ARCHIVABLE_STATUSES.has(unit.status)) ?? null,
    [inventory.selectedUnits],
  );
  const canArchiveSelectedUnits = inventory.canAdjustUnits
    && inventory.selectedUnitIds.length > 0
    && !archiveBlockedUnit;
  const archiveDisabledReason = !inventory.canAdjustUnits
    ? 'Archive permission required.'
    : archiveBlockedUnit
      ? `${archiveBlockedUnit.code} is ${archiveBlockedUnit.status} and cannot be bulk archived.`
      : null;

  const handleSubmitBulkArchive = async (notes?: string) => {
    await inventory.adjustUnit({
      unitIds: inventory.selectedUnitIds,
      targetStatus: 'ARCHIVED',
      ...(notes ? { notes } : {}),
    });
    inventory.clearUnitSelection();
    setBulkArchiveOpen(false);
  };

  useEffect(() => {
    if (selectedUnitCount !== 0) {
      return;
    }

    if (bulkArchiveOpen) {
      setBulkArchiveOpen(false);
    }

    if (inventory.bulkAdjustModal.open) {
      closeBulkAdjustModal();
    }
  }, [bulkArchiveOpen, closeBulkAdjustModal, inventory.bulkAdjustModal.open, selectedUnitCount]);

  const handleSubmitBulkAdjust = async (input: {
    unitIds: string[];
    targetStatus: 'STAGED' | 'PUTAWAY' | 'DEADSTOCK' | 'RTS' | 'DAMAGED' | 'LOST' | 'ARCHIVED';
    targetLocationId?: string;
    notes?: string;
  }) => {
    await inventory.adjustUnit(input);
    inventory.clearUnitSelection();
    inventory.closeBulkAdjustModal();
  };

  return (
    <div className="space-y-5">
      <WmsPageShell
        title="Stock Control"
      >
        {inventory.errorMessage ? (
          <WmsInlineNotice tone="error">
            {inventory.errorMessage}
          </WmsInlineNotice>
        ) : null}

        <InventoryStockDashboard
          overview={inventory.overview}
          isFetching={inventory.isFetching}
          dateRange={inventory.dateRange}
          onDateRangeChange={inventory.setDateRange}
          filters={(
            <InventoryFilterBar
              filters={inventory.overview?.filters}
              searchText={inventory.searchText}
              onSearchTextChange={inventory.setSearchText}
              selectedTenantId={inventory.selectedTenantId}
              onTenantChange={inventory.setSelectedTenantId}
              selectedStoreId={inventory.selectedStoreId}
              onStoreChange={inventory.setSelectedStoreId}
              selectedProductValue={inventory.selectedProductValue}
              onProductChange={inventory.setSelectedVariationId}
              selectedWarehouseId={inventory.selectedWarehouseId}
              onWarehouseChange={inventory.setSelectedWarehouseId}
              selectedStatus={inventory.selectedStatus}
              onStatusChange={inventory.setSelectedStatus}
            />
          )}
        />

        <WmsWorkspaceCard
          title="Stock Records"
          icon={<Archive className='panel-icon' />}
          actions={(
            <div className="flex flex-wrap items-center justify-end gap-2">
              {inventory.selectedUnitIds.length > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={inventory.clearUnitSelection}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-[#d7e0e7] bg-white px-3 text-[12px] font-semibold text-[#4d6677] transition hover:border-[#c6d4dd] hover:bg-[#f8fafb]"
                  >
                    <X className="h-3.5 w-3.5" />
                    Clear {selectedUnitCount}
                  </button>

                  <InventoryBulkActionsMenu
                    selectedCount={selectedUnitCount}
                    canAdjust={canAdjustSelectedUnits}
                    canArchive={canArchiveSelectedUnits}
                    canTransfer={canTransferSelectedUnits}
                    adjustDisabledReason={!inventory.canAdjustUnits ? 'Adjust permission required.' : null}
                    archiveDisabledReason={archiveDisabledReason}
                    transferDisabledReason={!inventory.canTransferUnits ? 'Inventory transfer permission required.' : null}
                    onAdjust={inventory.openBulkAdjustModal}
                    onArchive={() => setBulkArchiveOpen(true)}
                    onTransfer={inventory.openStoreTransferModal}
                  />
                </>
              ) : null}
            </div>
          )}
          footer={(
            <div className="flex items-center justify-between gap-3">
              <p className="text-[12px] text-[#6f8290]">
                {inventory.overview?.summary.units ?? 0} record{(inventory.overview?.summary.units ?? 0) === 1 ? '' : 's'} in view
              </p>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => inventory.setCurrentPage(inventory.currentPage - 1)}
                  disabled={inventory.currentPage === 1}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[#d7e0e7] bg-white text-[#4d6677] transition hover:border-[#c6d4dd] hover:text-primary disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>

                <span className="rounded-full border border-[#dce4ea] bg-[#fbfcfc] px-3.5 py-1.5 text-[12px] font-semibold text-primary">
                  {inventory.currentPage} / {inventory.totalPages}
                </span>

                <button
                  type="button"
                  onClick={() => inventory.setCurrentPage(inventory.currentPage + 1)}
                  disabled={inventory.currentPage === inventory.totalPages}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[#d7e0e7] bg-white text-[#4d6677] transition hover:border-[#c6d4dd] hover:text-primary disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        >
          <InventoryUnitsTable
            units={inventory.units}
            isLoading={inventory.isLoading}
            tenantReady={inventory.overview?.tenantReady ?? false}
            selectedUnitIds={inventory.selectedUnitIds}
            canSelectUnits={canSelectUnits}
            onToggleUnitSelection={inventory.toggleUnitSelection}
            onToggleVisibleUnitSelection={inventory.toggleVisibleUnitSelection}
            onViewUnit={inventory.openUnitModal}
          />
        </WmsWorkspaceCard>
      </WmsPageShell>

      <InventoryUnitModal
        open={inventory.unitModal.open}
        unit={inventory.unitModal.unit}
        movements={inventory.unitMovements}
        transferOptions={inventory.transferOptions}
        canPrintLabels={inventory.canPrintLabels}
        canTransferUnits={inventory.canTransferUnits}
        canAdjustUnits={inventory.canAdjustUnits}
        canVoidUnits={inventory.canVoidUnits}
        isRecordingPrint={inventory.isRecordingUnitLabelPrint}
        isLoadingMovements={inventory.isLoadingUnitMovements}
        isLoadingTransferOptions={inventory.isLoadingUnitTransferOptions}
        isTransferringUnit={inventory.isTransferringUnit}
        isAdjustingUnit={inventory.isAdjustingUnit}
        isVoidingUnit={inventory.isVoidingUnit}
        onRecordPrint={inventory.recordUnitLabelPrint}
        onTransferUnit={inventory.transferUnit}
        onAdjustUnit={inventory.adjustUnit}
        onVoidUnit={inventory.voidUnit}
        onClose={inventory.closeUnitModal}
      />

      <InventoryStoreTransferModal
        open={inventory.storeTransferModal.open}
        units={inventory.selectedUnits}
        options={inventory.storeTransferOptions}
        targetStoreId={inventory.storeTransferModal.targetStoreId}
        targetProfileId={inventory.storeTransferModal.targetProfileId}
        shareStockPool={inventory.storeTransferModal.shareStockPool}
        notes={inventory.storeTransferModal.notes}
        preview={inventory.storeTransferPreview}
        isLoadingOptions={inventory.isLoadingStoreTransferOptions}
        isLoadingPreview={inventory.isLoadingStoreTransferPreview}
        previewErrorMessage={inventory.storeTransferPreviewErrorMessage}
        isSubmitting={inventory.isTransferringStoreUnits}
        errorMessage={inventory.storeTransferModal.errorMessage}
        onTargetStoreChange={inventory.setStoreTransferTargetStoreId}
        onTargetProfileChange={inventory.setStoreTransferTargetProfileId}
        onShareStockPoolChange={inventory.setStoreTransferShareStockPool}
        onNotesChange={inventory.setStoreTransferNotes}
        onSubmit={inventory.submitStoreTransfer}
        onClose={inventory.closeStoreTransferModal}
      />

      <InventoryBulkAdjustModal
        open={inventory.bulkAdjustModal.open}
        units={inventory.selectedUnits}
        transferOptions={inventory.bulkAdjustTransferOptions}
        canAdjustUnits={inventory.canAdjustUnits}
        isLoadingTransferOptions={inventory.isLoadingBulkAdjustTransferOptions}
        isSubmitting={inventory.isAdjustingUnit}
        onSubmit={handleSubmitBulkAdjust}
        onClose={inventory.closeBulkAdjustModal}
      />

      <InventoryBulkArchiveModal
        open={bulkArchiveOpen}
        units={inventory.selectedUnits}
        isSubmitting={inventory.isAdjustingUnit}
        onSubmit={handleSubmitBulkArchive}
        onClose={() => setBulkArchiveOpen(false)}
      />
    </div>
  );
}

'use client';

import { ArrowRight, Loader2, Shuffle } from 'lucide-react';
import { WmsModal } from '../../_components/wms-modal';
import { WmsSearchableSelect } from '../../_components/wms-searchable-select';
import type {
  WmsInventoryStoreTransferPreviewResponse,
  WmsInventoryStoreTransferOptionsResponse,
  WmsInventoryUnitRecord,
} from '../_types/inventory';

type InventoryStoreTransferModalProps = {
  open: boolean;
  units: WmsInventoryUnitRecord[];
  options: WmsInventoryStoreTransferOptionsResponse | null;
  targetStoreId: string;
  targetProfileId: string;
  shareStockPool: boolean;
  notes: string;
  preview: WmsInventoryStoreTransferPreviewResponse | null;
  isLoadingOptions: boolean;
  isLoadingPreview: boolean;
  previewErrorMessage: string | null;
  isSubmitting: boolean;
  errorMessage: string | null;
  onTargetStoreChange: (value: string) => void;
  onTargetProfileChange: (value: string) => void;
  onShareStockPoolChange: (value: boolean) => void;
  onNotesChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  onClose: () => void;
};

export function InventoryStoreTransferModal({
  open,
  units,
  options,
  targetStoreId,
  targetProfileId,
  shareStockPool,
  notes,
  preview,
  isLoadingOptions,
  isLoadingPreview,
  previewErrorMessage,
  isSubmitting,
  errorMessage,
  onTargetStoreChange,
  onTargetProfileChange,
  onShareStockPoolChange,
  onNotesChange,
  onSubmit,
  onClose,
}: InventoryStoreTransferModalProps) {
  const sourceStoreIds = new Set(units.map((unit) => unit.store.id));
  const sourceVariationIds = new Set(units.map((unit) => unit.variationId));
  const sourceStore = units[0]?.store ?? null;
  const sourceProduct = units[0] ?? null;
  const isMixedSource = sourceStoreIds.size > 1 || sourceVariationIds.size > 1;
  const targetStoreOptions = (options?.stores ?? []).map((store) => ({
    value: store.id,
    label: store.id === sourceStore?.id ? `${store.label} (Current store)` : store.label,
  }));
  const productOptions = (options?.products ?? [])
    .filter((product) => (
      targetStoreId !== sourceStore?.id
      || product.variationId !== sourceProduct?.variationId
    ))
    .map((product) => ({
      value: product.profileId,
      label: product.label,
      hint: product.profileId === options?.suggestion?.profileId
        ? `Suggested · ${options.suggestion.reason}`
        : product.variationDisplayId ?? product.productCustomId ?? product.variationId,
    }));
  const selectedTargetProduct = options?.products.find((product) => product.profileId === targetProfileId) ?? null;
  const suggestion = options?.suggestion ?? null;
  const submitDisabled =
    units.length === 0
    || isMixedSource
    || !targetStoreId
    || !targetProfileId
    || preview?.valid === false
    || isSubmitting;

  if (!open) {
    return null;
  }

  return (
    <WmsModal
      open={open}
      title="Change variant"
      description="Reassign selected physical units to another variant in the current store or a different store."
      onClose={onClose}
      panelClassName="w-[min(94vw,920px)]"
      footer={(
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-[#667b8a]">
            {units.length} unit{units.length === 1 ? '' : 's'} will keep barcode, unit cost, and history.
          </p>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center rounded-[12px] border border-[#d7e0e7] bg-white px-3.5 text-[12px] font-semibold text-primary transition hover:border-[#c6d4dd] hover:bg-[#f8fafb]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={submitDisabled}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-[12px] bg-primary px-4 text-[12px] font-semibold text-white transition hover:bg-[#0f3242] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
              Change variant
            </button>
          </div>
        </div>
      )}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="space-y-4">
          <div className="rounded-2xl border border-[#dce4ea] bg-[#fbfcfc] p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">Route</p>
            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-center">
              <IdentityCard
                eyebrow="From"
                title={sourceStore?.name ?? 'No source store'}
                description={sourceProduct ? `${sourceProduct.name} · ${sourceProduct.variationDisplayId ?? sourceProduct.variationId}` : 'Select units first'}
              />
              <div className="hidden h-9 w-9 items-center justify-center rounded-full border border-[#d7e0e7] bg-white text-[#5f7483] md:flex">
                <ArrowRight className="h-4 w-4" />
              </div>
              <IdentityCard
                eyebrow="To"
                title={targetStoreOptions.find((store) => store.value === targetStoreId)?.label ?? 'Select target store'}
                description={selectedTargetProduct ? `${selectedTargetProduct.name} · ${selectedTargetProduct.variationDisplayId ?? selectedTargetProduct.variationId}` : 'Select target product'}
              />
            </div>
          </div>

          {isMixedSource ? (
            <div className="rounded-2xl border border-[#f2c7c7] bg-[#fff7f7] px-4 py-3 text-[13px] font-medium text-[#a43f3f]">
              Select units from one source store and one source variation only.
            </div>
          ) : null}

          {errorMessage ? (
            <div className="rounded-2xl border border-[#f2c7c7] bg-[#fff7f7] px-4 py-3 text-[13px] font-medium text-[#a43f3f]">
              {errorMessage}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <WmsSearchableSelect
              label="Target store"
              value={targetStoreId}
              onChange={onTargetStoreChange}
              options={targetStoreOptions}
              allLabel="Select store"
              placeholder="Search stores..."
              clearable={false}
              triggerClassName="h-11 w-full"
              popoverMinWidth={320}
            />
            <WmsSearchableSelect
              label="Target product"
              value={targetProfileId}
              onChange={onTargetProfileChange}
              options={productOptions}
              allLabel={isLoadingOptions ? 'Loading products' : 'Select product'}
              placeholder="Search products..."
              clearable={false}
              triggerClassName="h-11 w-full"
              popoverMinWidth={380}
            />
          </div>

          {suggestion ? (
            <div className="rounded-2xl border border-[#c8e1d6] bg-[#f5fbf8] px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#527d67]">
                Suggested match
              </p>
              <p className="mt-1 text-[13px] font-semibold text-primary">{suggestion.label}</p>
              <p className="mt-0.5 text-[12px] text-[#647d70]">
                {suggestion.reason} · {suggestion.confidence} confidence
              </p>
            </div>
          ) : targetStoreId && !isLoadingOptions ? (
            <div className="rounded-2xl border border-[#e5edf2] bg-[#fbfcfc] px-4 py-3 text-[12px] text-[#667b8a]">
              No exact match found yet. Select the target product manually.
            </div>
          ) : null}

          {targetStoreId && targetProfileId ? (
            <StoreTransferRiskCard
              preview={preview}
              isLoading={isLoadingPreview}
              errorMessage={previewErrorMessage}
            />
          ) : null}

          {targetStoreId && targetProfileId ? (
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[#dce4ea] bg-[#fbfcfc] px-4 py-3 transition hover:border-[#bfd0dc]">
              <input
                type="checkbox"
                checked={shareStockPool}
                onChange={(event) => onShareStockPoolChange(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-[#c4d3de] text-primary focus:ring-primary"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-primary">
                    Keep linked as shared stock pool
                  </span>
                  {selectedTargetProduct?.alreadyPooled ? (
                    <span className="inline-flex items-center rounded-full border border-[#b9decb] bg-[#ecf8f2] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#286348]">
                      Already linked
                    </span>
                  ) : selectedTargetProduct?.recommendShareStockPool ? (
                    <span className="inline-flex items-center rounded-full border border-[#b9decb] bg-[#ecf8f2] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#286348]">
                      Recommended · repeat transfer
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[12px] text-[#667b8a]">
                  Orders on either variant or store will automatically share available bin stock and auto-assign units on pick.
                </p>
              </div>
            </label>
          ) : null}

          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">Notes</span>
            <textarea
              value={notes}
              onChange={(event) => onNotesChange(event.target.value)}
              rows={3}
              placeholder="Optional reason, correction, or approval reference"
              className="mt-2 w-full rounded-2xl border border-[#d7e0e7] bg-white px-3.5 py-3 text-[13px] text-primary outline-none transition placeholder:text-[#9aacb8] focus:border-[#96b4c3] focus:shadow-[0_0_0_4px_rgba(18,56,75,0.08)]"
            />
          </label>
        </section>

        <aside className="rounded-2xl border border-[#dce4ea] bg-white p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">Selected units</p>
          <div className="mt-3 max-h-[360px] space-y-2 overflow-y-auto pr-1">
            {units.map((unit) => (
              <div key={unit.id} className="rounded-xl border border-[#edf2f6] bg-[#fbfcfc] px-3 py-2">
                <p className="truncate text-[12px] font-semibold text-primary">{unit.code}</p>
                <p className="mt-0.5 truncate text-[11px] text-[#758997]">{unit.status} · {unit.currentLocation?.code ?? 'No location'}</p>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </WmsModal>
  );
}

function StoreTransferRiskCard({
  preview,
  isLoading,
  errorMessage,
}: {
  preview: WmsInventoryStoreTransferPreviewResponse | null;
  isLoading: boolean;
  errorMessage: string | null;
}) {
  if (isLoading) {
    return (
      <div className="rounded-2xl border border-[#e5edf2] bg-[#fbfcfc] px-4 py-3 text-[12px] font-medium text-[#667b8a]">
        Checking source demand and available stock...
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="rounded-2xl border border-[#f2c7c7] bg-[#fff7f7] px-4 py-3 text-[13px] font-medium text-[#a43f3f]">
        {errorMessage}
      </div>
    );
  }

  if (!preview) {
    return null;
  }

  const hasIssues = preview.blockers.length > 0 || preview.warnings.length > 0;

  return (
    <div className={`rounded-2xl border px-4 py-3 ${
      preview.blockers.length > 0
        ? 'border-[#f2c7c7] bg-[#fff7f7]'
        : preview.warnings.some((warning) => warning.severity === 'critical')
          ? 'border-[#f0d4a2] bg-[#fffaf0]'
          : 'border-[#c8e1d6] bg-[#f5fbf8]'
    }`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6f8290]">
        Source stock risk
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-4">
        <RiskMetric label="Selected" value={preview.selectedUnits} />
        <RiskMetric label="Available" value={preview.sourceAvailableUnits} />
        <RiskMetric label="Remaining" value={preview.remainingAvailableUnits} />
        <RiskMetric label="Active demand" value={preview.activeDemandUnits} />
      </div>

      {hasIssues ? (
        <div className="mt-3 space-y-2">
          {preview.blockers.map((blocker) => (
            <p key={blocker.code} className="text-[12px] font-semibold text-[#a43f3f]">
              {blocker.message}
            </p>
          ))}
          {preview.warnings.map((warning) => (
            <p
              key={warning.code}
              className={`text-[12px] font-medium ${
                warning.severity === 'critical' ? 'text-[#9a681e]' : 'text-[#647d70]'
              }`}
            >
              {warning.message}
            </p>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[12px] font-medium text-[#527d67]">
          No active source-store demand risk detected for this product.
        </p>
      )}
    </div>
  );
}

function RiskMetric({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border border-white/70 bg-white/72 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8a9aa6]">{label}</p>
      <p className="mt-1 text-[16px] font-semibold text-primary">{value}</p>
    </div>
  );
}

function IdentityCard({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-[#e2e9ee] bg-white px-3.5 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8a9aa6]">{eyebrow}</p>
      <p className="mt-1 truncate text-[14px] font-semibold text-primary">{title}</p>
      <p className="mt-0.5 truncate text-[12px] text-[#708492]">{description}</p>
    </div>
  );
}

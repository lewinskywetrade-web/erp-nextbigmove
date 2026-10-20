'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ClipboardList, Search, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DashboardSection } from '../../dashboard/_components/dashboard-section';
import { FormSelect } from '@/components/ui/form-select';
import { FormTextarea } from '@/components/ui/form-textarea';
import { RequestsSearchableSelect } from './requests-searchable-select';
import type {
  WmsPurchasingProductOption,
  WmsPurchasingProductOptionsResponse,
  WmsPurchasingRequestType,
} from '../_types/request';

type CartLine = {
  id: string;
  product: WmsPurchasingProductOption;
  quantity: number;
  unitAmount: number | null;
};

interface RequestCreatePanelProps {
  stores: Array<{ id: string; label: string }>;
  createStoreScopeId: string;
  createRequestType: WmsPurchasingRequestType;
  createPartnerNotes: string;
  cartLines: CartLine[];
  cartTotals: {
    totalItems: number;
    totalAmount: number | null;
  };
  isSubmitting: boolean;
  isProductPickerOpen: boolean;
  productSearchText: string;
  productOptions: WmsPurchasingProductOptionsResponse | null;
  isLoadingProductOptions: boolean;
  productOptionsError: string | null;
  productOptionsPage: number;
  effectiveStoreId?: string;
  onStoreScopeChange: (value: string) => void;
  onRequestTypeChange: (value: WmsPurchasingRequestType) => void;
  onPartnerNotesChange: (value: string) => void;
  onOpenProductPicker: () => void;
  onCloseProductPicker: () => void;
  onProductSearchChange: (value: string) => void;
  onProductOptionsPageChange: (page: number) => void;
  onAddProduct: (product: WmsPurchasingProductOption) => void;
  onRemoveLine: (lineId: string) => void;
  onQuantityChange: (lineId: string, quantity: number) => void;
  onUnitAmountChange: (lineId: string, unitAmount: number | null) => void;
  onSubmit: () => Promise<void>;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function RequestCreatePanel({
  stores,
  createStoreScopeId,
  createRequestType,
  createPartnerNotes,
  cartLines,
  cartTotals,
  isSubmitting,
  isProductPickerOpen,
  productSearchText,
  productOptions,
  isLoadingProductOptions,
  productOptionsError,
  productOptionsPage,
  effectiveStoreId,
  onStoreScopeChange,
  onRequestTypeChange,
  onPartnerNotesChange,
  onOpenProductPicker,
  onCloseProductPicker,
  onProductSearchChange,
  onProductOptionsPageChange,
  onAddProduct,
  onRemoveLine,
  onQuantityChange,
  onUnitAmountChange,
  onSubmit,
}: RequestCreatePanelProps) {
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setQuantityDrafts((current) => {
      const next: Record<string, string> = {};

      for (const line of cartLines) {
        const draft = current[line.id];
        if (draft !== undefined && draft !== String(line.quantity)) {
          next[line.id] = draft;
        }
      }

      return next;
    });
  }, [cartLines]);

  const totalPages = productOptions?.pagination.totalPages ?? 1;
  const effectiveStoreName = effectiveStoreId
    ? stores.find((store) => store.id === effectiveStoreId)?.label ?? 'Selected store'
    : 'All stores';
  const isSelfBuy = createRequestType === 'SELF_BUY';
  const hasMissingUnitAmount = cartLines.some((line) => line.unitAmount === null
    || !Number.isFinite(line.unitAmount) || (isSelfBuy ? line.unitAmount <= 0 : line.unitAmount < 0));

  return (
    <DashboardSection
      title="Stock Request Cart"
      icon={<ClipboardList className="panel-icon" />}
      contentClassName="space-y-3.5"
    >
        {/* <p className="text-xs text-slate-500 dark:text-slate-300">Select products and submit to WMS</p> */}

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="mt-2 space-y-1.5">
            <label className="form-label">Store</label>
            <RequestsSearchableSelect
              label="Store"
              value={createStoreScopeId}
              onChange={onStoreScopeChange}
              options={stores.map((store) => ({ value: store.id, label: store.label }))}
              allLabel="All stores"
              placeholder="Search stores..."
            />
          </div>
          <div className="mt-1.5 space-y-1.5">
            <FormSelect
              label="Request type"
              value={createRequestType}
              onChange={(event) => onRequestTypeChange(event.target.value as WmsPurchasingRequestType)}
              className="rounded-lg px-3 py-1.5 text-sm"
              options={[
                { value: 'PROCUREMENT', label: 'Procurement' },
                { value: 'SELF_BUY', label: 'Self-buy' },
              ]}
            />
          </div>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-300">
          Scope: <span className="font-semibold text-slate-700 dark:text-foreground">{effectiveStoreName}</span>
        </p>

        {cartLines.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-border">
            <table className="min-w-full divide-y divide-slate-100 text-sm dark:divide-border">
              <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500 dark:bg-surface dark:text-slate-300">
                <tr>
                  <th className="px-2.5 py-1.5">Product</th>
                  <th className="px-2.5 py-1.5">Store</th>
                  <th className="px-2.5 py-1.5">{isSelfBuy ? 'Actual unit COGS' : 'Partner Cost'}</th>
                  <th className="px-2.5 py-1.5">Qty</th>
                  <th className="px-2.5 py-1.5 text-right">Subtotal</th>
                  <th className="px-2.5 py-1.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white dark:divide-border dark:bg-surface">
                {cartLines.map((line) => {
                  const unitAmount = line.unitAmount;
                  const subtotal = unitAmount !== null && Number.isFinite(unitAmount) && unitAmount >= 0
                    ? unitAmount * line.quantity : null;
                  return (
                    <tr key={line.id} className="hover:bg-slate-50 dark:hover:bg-surface/80">
                      <td className="px-2.5 py-2">
                        <p className="font-semibold text-slate-800 dark:text-foreground">{line.product.name}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-300">
                          {line.product.variationDisplayId || line.product.variationId || 'No variation'}
                        </p>
                      </td>
                      <td className="px-2.5 py-2 text-slate-800 dark:text-foreground">{line.product.store.name}</td>
                      <td className="px-2.5 py-2 font-semibold text-slate-800 dark:text-foreground">
                        {isSelfBuy ? (
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={unitAmount ?? ''}
                            placeholder="Required"
                            onChange={(event) => {
                              const nextValue = event.target.value.trim();
                              onUnitAmountChange(
                                line.id,
                                nextValue === '' ? null : Number(nextValue),
                              );
                            }}
                            className="h-8 w-28 rounded-md border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-800 outline-none focus:border-slate-300 dark:border-border dark:bg-transparent dark:text-foreground"
                          />
                        ) : (
                          unitAmount !== null && Number.isFinite(unitAmount) && unitAmount >= 0
                            ? formatCurrency(unitAmount) : 'Partner cost unavailable'
                        )}
                      </td>
                      <td className="px-2.5 py-2">
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={quantityDrafts[line.id] ?? String(line.quantity)}
                          onChange={(event) => {
                            const nextValue = event.target.value;

                            if (nextValue === '') {
                              setQuantityDrafts((current) => ({
                                ...current,
                                [line.id]: '',
                              }));
                              return;
                            }

                            if (!/^\d+$/.test(nextValue)) {
                              return;
                            }

                            setQuantityDrafts((current) => ({
                              ...current,
                              [line.id]: nextValue,
                            }));
                            onQuantityChange(line.id, Number.parseInt(nextValue, 10));
                          }}
                          onBlur={() => {
                            setQuantityDrafts((current) => {
                              if (current[line.id] === undefined) {
                                return current;
                              }

                              const next = { ...current };
                              delete next[line.id];
                              return next;
                            });
                          }}
                          className="h-8 w-16 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-slate-300 dark:border-border dark:bg-transparent dark:text-foreground"
                        />
                      </td>
                      <td className="px-2.5 py-2 text-right font-semibold text-slate-800 dark:text-foreground">
                        {subtotal === null ? 'Unavailable' : formatCurrency(subtotal)}
                      </td>
                      <td className="px-2.5 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => onRemoveLine(line.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 dark:border-border dark:text-slate-300 dark:hover:border-rose-400/40 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {hasMissingUnitAmount ? (
              <div className="border-t border-amber-100 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200">
                {isSelfBuy ? 'Self-buy requires actual unit COGS for every line before submit.'
                  : 'Partner cost unavailable. A valid partner price is required for every line before submit.'}
              </div>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={onOpenProductPicker}
          disabled={isSubmitting}
          className="group w-full rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-center transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-border dark:bg-surface dark:hover:border-slate-500 dark:hover:bg-surface/80"
        >
          <span className="text-sm font-medium tracking-tight text-slate-600 dark:text-slate-300">
            Drag products here
          </span>
          <span className="px-1.5 text-sm font-medium text-slate-500 dark:text-slate-400">or</span>
          <span className="text-sm font-semibold text-slate-800 group-hover:text-slate-900 dark:text-foreground dark:group-hover:text-white">
            Add product
          </span>
        </button>

        {isProductPickerOpen ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 dark:border-border dark:bg-surface">
            <div className="flex items-center gap-2">
              <label className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-300" />
                <input
                  className="h-8 w-full rounded-lg border border-slate-200 bg-white pl-8 pr-2.5 text-sm text-slate-700 outline-none transition focus:border-slate-300 dark:border-border dark:bg-transparent dark:text-foreground dark:placeholder:text-slate-400"
                  placeholder={
                    effectiveStoreId
                      ? 'Search products in selected store...'
                      : 'Search products across all stores...'
                  }
                  value={productSearchText}
                  onChange={(event) => onProductSearchChange(event.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={onCloseProductPicker}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-slate-700 dark:border-border dark:bg-transparent dark:text-slate-300 dark:hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-2.5 max-h-[280px] overflow-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-background">
              {isLoadingProductOptions ? (
                <div className="px-3 py-8 text-center text-sm text-slate-500 dark:text-slate-300">Loading products...</div>
              ) : productOptionsError ? (
                <div className="px-3 py-8 text-center text-sm text-rose-700">{productOptionsError}</div>
              ) : (productOptions?.products.length ?? 0) === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-slate-500 dark:text-slate-300">No products found</div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-border">
                  {productOptions?.products.map((product) => (
                    <li key={product.profileId}>
                      <button
                        type="button"
                        onClick={() => onAddProduct(product)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-slate-50 dark:hover:bg-surface"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-800 dark:text-foreground">{product.name}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-300">
                            {product.variationDisplayId || product.variationId || 'No variation'} · {product.store.name}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-semibold text-slate-800 dark:text-foreground">
                            {isSelfBuy
                              ? 'Enter after adding'
                              : typeof product.partnerUnitCost === 'number' && Number.isFinite(product.partnerUnitCost) && product.partnerUnitCost >= 0
                                ? formatCurrency(product.partnerUnitCost) : 'Partner cost unavailable'}
                          </p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-300">
                            {isSelfBuy
                              ? 'Actual unit COGS required'
                              : 'Partner Cost'}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-2.5 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onProductOptionsPageChange(productOptionsPage - 1)}
                disabled={productOptionsPage <= 1}
              >
                Previous
              </Button>
              <span className="text-xs text-slate-500 dark:text-slate-300">
                {productOptionsPage} / {Math.max(1, totalPages)}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onProductOptionsPageChange(productOptionsPage + 1)}
                disabled={productOptionsPage >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}

        <FormTextarea
          label="Notes"
          placeholder="Optional note for WMS reviewer"
          value={createPartnerNotes}
          onChange={(event) => onPartnerNotesChange(event.target.value)}
          maxLength={400}
          rows={2}
          className="rounded-lg px-3 py-1.5"
        />

        {cartLines.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-3">
            <SummaryCard
              label="Selected products"
              value={String(cartLines.length)}
            />
            <SummaryCard
              label="Total quantity"
              value={String(cartTotals.totalItems)}
            />
            <SummaryCard
              label="Total amount"
              value={cartTotals.totalAmount === null ? 'Unavailable' : formatCurrency(cartTotals.totalAmount)}
              valueClassName="text-slate-900 dark:text-foreground"
            />
          </div>
        ) : null}

        <div className="pt-1">
          <Button
            size="lg"
            onClick={() => void onSubmit()}
            loading={isSubmitting}
            disabled={isSubmitting || cartLines.length === 0 || hasMissingUnitAmount}
          >
            Submit request
          </Button>
        </div>
    </DashboardSection>
  );
}

function SummaryCard({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="card">
      <p className="card-label">{label}</p>
      <p className={clsx('card-value', valueClassName)}>{value}</p>
    </div>
  );
}

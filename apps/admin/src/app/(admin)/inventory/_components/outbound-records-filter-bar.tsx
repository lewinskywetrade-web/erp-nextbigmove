'use client';

import dynamic from 'next/dynamic';
import { CalendarDays, Search, X } from 'lucide-react';
import { useMemo } from 'react';
import { WmsSearchableSelect } from '../../_components/wms-searchable-select';
import type {
  OutboundDateRange,
  WmsOutboundRecordsResponse,
  WmsOutboundUnitStatus,
} from '../_types/outbound-records';
import {
  formatDateInputValue,
  parseDateInputValue,
} from '../_utils/outbound-records-presenters';

const Datepicker = dynamic(() => import('react-tailwindcss-datepicker'), { ssr: false });

type DatePickerValue = { startDate: Date | null; endDate: Date | null };
type DatePickerChange = {
  startDate?: Date | string | null;
  endDate?: Date | string | null;
} | null;

type OutboundRecordsFilterBarProps = {
  filters: WmsOutboundRecordsResponse['filters'] | null | undefined;
  searchText: string;
  onSearchTextChange: (value: string) => void;
  selectedTenantId?: string;
  onTenantChange: (value: string | undefined) => void;
  selectedStoreId?: string;
  onStoreChange: (value: string | undefined) => void;
  selectedProductProfileId?: string;
  onProductChange: (value: string | undefined) => void;
  selectedStatus?: WmsOutboundUnitStatus;
  onStatusChange: (value: WmsOutboundUnitStatus | undefined) => void;
  dateRange: OutboundDateRange;
  onDateRangeChange: (value: OutboundDateRange) => void;
};

export function OutboundRecordsFilterBar({
  filters,
  searchText,
  onSearchTextChange,
  selectedTenantId,
  onTenantChange,
  selectedStoreId,
  onStoreChange,
  selectedProductProfileId,
  onProductChange,
  selectedStatus,
  onStatusChange,
  dateRange,
  onDateRangeChange,
}: OutboundRecordsFilterBarProps) {
  const tenantOptions = useMemo(() => (filters?.tenants ?? []).map((tenant) => ({
    value: tenant.id,
    label: tenant.label,
  })), [filters?.tenants]);
  const storeOptions = useMemo(() => (filters?.stores ?? []).map((store) => ({
    value: store.id,
    label: store.label,
    selectedLabel: store.name,
  })), [filters?.stores]);
  const productOptions = useMemo(() => (filters?.products ?? []).map((product) => ({
    value: product.id,
    label: product.label,
    selectedLabel: product.name,
  })), [filters?.products]);
  const statusOptions = useMemo(() => (filters?.statuses ?? []).map((status) => ({
    value: status.value,
    label: status.label,
    hint: status.recordCount,
  })), [filters?.statuses]);
  const datePickerValue: DatePickerValue = {
    startDate: parseDateInputValue(dateRange.startDate),
    endDate: parseDateInputValue(dateRange.endDate),
  };
  const dateLabel = formatDateRangeLabel(dateRange);

  const handleDateChange = (value: DatePickerChange) => {
    const startDate = normalizeDatePickerValue(value?.startDate, dateRange.startDate);
    const rawEndDate = normalizeDatePickerValue(value?.endDate, startDate);
    onDateRangeChange({
      startDate,
      endDate: rawEndDate < startDate ? startDate : rawEndDate,
    });
  };

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2.5">
      <div className="relative min-w-64 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          type="text"
          value={searchText}
          onChange={(event) => onSearchTextChange(event.target.value)}
          placeholder="Search unit, barcode, order, tracking, or product"
          className="input h-10 py-0 pl-10 pr-10"
        />
        {searchText ? (
          <button
            type="button"
            onClick={() => onSearchTextChange('')}
            className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted transition hover:bg-secondary/50 hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="relative h-10 w-56 shrink-0">
        <Datepicker
          value={datePickerValue}
          onChange={handleDateChange}
          useRange={false}
          asSingle={false}
          showShortcuts={false}
          showFooter={false}
          primaryColor="orange"
          readOnly
          inputClassName="h-full w-full cursor-pointer rounded-2xl border border-border bg-surface p-0 text-transparent caret-transparent outline-none"
          containerClassName="h-full"
          popupClassName={(defaultClass: string) => `${defaultClass} z-50 kpi-datepicker-light`}
          displayFormat="MM/DD/YYYY"
          separator=" - "
          popoverDirection="down"
          toggleIcon={() => (
            <span className="flex min-w-0 items-center gap-2">
              <CalendarDays className="h-4 w-4 shrink-0" />
              <span className="truncate text-xs font-semibold">{dateLabel}</span>
            </span>
          )}
          toggleClassName="absolute inset-0 flex cursor-pointer items-center rounded-2xl border border-border px-3 text-muted transition hover:border-primary/40 hover:text-foreground"
          placeholder=" "
        />
      </div>

      <WmsSearchableSelect
        label="Client"
        value={selectedTenantId ?? ''}
        onChange={(value) => onTenantChange(value || undefined)}
        options={tenantOptions}
        placeholder="Search clients…"
        allLabel="All clients"
        hideInlineLabel
      />

      <WmsSearchableSelect
        label="Store"
        value={selectedStoreId ?? ''}
        onChange={(value) => onStoreChange(value || undefined)}
        options={storeOptions}
        placeholder="Search stores…"
        allLabel="All stores"
        hideInlineLabel
      />

      {selectedTenantId || selectedStoreId ? (
        <WmsSearchableSelect
          label="Product"
          value={selectedProductProfileId ?? ''}
          onChange={(value) => onProductChange(value || undefined)}
          options={productOptions}
          placeholder="Search products…"
          allLabel="All products"
          hideInlineLabel
        />
      ) : null}

      <WmsSearchableSelect
        label="Activity"
        value={selectedStatus ?? ''}
        onChange={(value) => onStatusChange((value as WmsOutboundUnitStatus) || undefined)}
        options={statusOptions}
        placeholder="Search activities…"
        allLabel="All activities"
        hideInlineLabel
      />
    </div>
  );
}

function normalizeDatePickerValue(value: unknown, fallback: string) {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return formatDateInputValue(value);
  return fallback;
}

function formatDateRangeLabel(value: OutboundDateRange) {
  const start = parseDateInputValue(value.startDate);
  const end = parseDateInputValue(value.endDate);
  if (!start || !end) return 'Select dates';
  const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (value.startDate === value.endDate) return formatter.format(start);
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}

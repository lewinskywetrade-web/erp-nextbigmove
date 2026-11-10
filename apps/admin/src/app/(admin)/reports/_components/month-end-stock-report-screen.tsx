'use client';

import { AlertCircle, Download, FileSpreadsheet, RefreshCw, Warehouse } from 'lucide-react';
import { useState } from 'react';
import { WmsCheckboxMultiSelect } from '../../_components/wms-checkbox-multi-select';
import { WmsPageShell } from '../../_components/wms-page-shell';
import { useMonthEndStockReport } from '../_hooks/use-month-end-stock-report';
import {
  exportMonthEndStockCsv,
  exportMonthEndStockWorkbook,
} from '../_utils/export-month-end-stock-report';
import { MonthEndStockTable } from './month-end-stock-table';

export function MonthEndStockReportScreen() {
  const controller = useMonthEndStockReport();
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const canExport = Boolean(controller.data?.rows.length) && !controller.isLoading;

  const exportWorkbook = async () => {
    if (!controller.data) return;
    setExporting('xlsx');
    try {
      await exportMonthEndStockWorkbook(controller.data);
    } finally {
      setExporting(null);
    }
  };

  return (
    <WmsPageShell
      title="Reports"
      breadcrumb="WMS Reports"
      description="Generate operational reports from the WMS stock-truth ledger."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!canExport || exporting !== null}
            onClick={() => {
              if (!controller.data) return;
              setExporting('csv');
              try { exportMonthEndStockCsv(controller.data); } finally { setExporting(null); }
            }}
            className="btn btn-md btn-secondary btn-icon"
          >
            <Download className="h-4 w-4" />
            {exporting === 'csv' ? 'Exporting' : 'CSV'}
          </button>
          <button type="button" disabled={!canExport || exporting !== null} onClick={() => void exportWorkbook()} className="btn btn-md btn-primary btn-icon">
            <FileSpreadsheet className="h-4 w-4" />
            {exporting === 'xlsx' ? 'Exporting' : 'XLSX'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <section className="overflow-hidden rounded-[24px] border border-[#dce4ea] bg-white">
          <div className="flex flex-col gap-4 border-b border-[#e6edf1] px-4 py-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-orange-50 text-orange-600">
                <Warehouse className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold text-primary">Month-End Stock Report</h1>
                <p className="mt-1 text-sm text-muted">Current put-away and physical bin quantities for every active WMS variant in scope.</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <WmsCheckboxMultiSelect
                label="Client"
                allLabel="All clients"
                options={(controller.data?.filters.partners ?? []).map((partner) => ({
                  value: partner.id,
                  label: partner.name,
                  hint: partner.slug ?? undefined,
                }))}
                selectedValues={controller.selectedTenantIds}
                onChange={controller.setSelectedTenantIds}
                placeholder="Search clients…"
              />
              <WmsCheckboxMultiSelect
                label="Store"
                allLabel="All stores"
                options={controller.availableStores.map((store) => ({
                  value: store.id,
                  label: store.name,
                  hint: `${store.tenantName} · ${store.shopId}`,
                }))}
                selectedValues={controller.selectedStoreIds}
                onChange={controller.setSelectedStoreIds}
                placeholder="Search stores…"
                disabled={controller.availableStores.length === 0}
              />
              <button type="button" onClick={() => void controller.refresh()} disabled={controller.isLoading} className="btn btn-md btn-secondary btn-icon">
                <RefreshCw className={`h-4 w-4 ${controller.isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>

          <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Variants" value={controller.data?.totals.variantCount ?? 0} detail={`${controller.data?.filters.effectiveStoreIds.length ?? 0} stores in scope`} />
            <MetricCard label="Awaiting put away" value={controller.data?.totals.awaitingPutAwayQty ?? 0} detail="Received or staged" />
            <MetricCard label="Put away" value={controller.data?.totals.putAwayQty ?? 0} detail="Available put-away units" />
            <MetricCard label="Currently in bin" value={controller.data?.totals.inBinQty ?? 0} detail={`${(controller.data?.totals.reservedQty ?? 0).toLocaleString()} reserved`} accent />
          </div>

          <div className="border-t border-[#e6edf1] bg-[#fbfcfd] px-4 py-3 text-xs text-muted">
            {controller.data
              ? `Snapshot generated ${new Date(controller.data.report.generatedAt).toLocaleString()}. Filters refresh the snapshot automatically.`
              : 'Loading the current WMS stock snapshot…'}
          </div>
        </section>

        {controller.error ? (
          <div className="flex items-start gap-3 rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{controller.error}</span>
          </div>
        ) : null}

        <MonthEndStockTable rows={controller.data?.rows ?? []} isLoading={controller.isLoading} />
      </div>
    </WmsPageShell>
  );
}

function MetricCard({ label, value, detail, accent = false }: { label: string; value: number; detail: string; accent?: boolean }) {
  return (
    <article className={`rounded-[20px] border px-4 py-3 ${accent ? 'border-emerald-200 bg-emerald-50/60' : 'border-[#e1e8ed] bg-white'}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6f8290]">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${accent ? 'text-emerald-700' : 'text-primary'}`}>{value.toLocaleString()}</p>
      <p className="mt-1 text-xs text-muted">{detail}</p>
    </article>
  );
}

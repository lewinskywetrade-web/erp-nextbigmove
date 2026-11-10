'use client';

import { AlertCircle, CalendarDays, Download, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { WmsCompactPanel } from '../../_components/wms-compact-panel';
import { WmsPageShell } from '../../_components/wms-page-shell';
import { WmsSearchableSelect } from '../../_components/wms-searchable-select';
import { useForecastController } from '../_hooks/use-forecast-controller';
import { exportForecastWorkbook } from '../_utils/export-forecast-workbook';
import {
  formatForecastShortDate,
  formatForecastWeekday,
  getTodayDateValue,
} from '../_utils/forecast-formatters';
import { ForecastCycleSelector } from './forecast-cycle-selector';
import { ForecastStoreMultiSelect } from './forecast-store-multi-select';
import { ForecastTable } from './forecast-table';

const Datepicker = dynamic(() => import('react-tailwindcss-datepicker'), { ssr: false });

type ForecastDateValue = {
  startDate?: Date | string | null;
  endDate?: Date | string | null;
} | null;

export function ForecastScreen() {
  const controller = useForecastController();
  const [isExporting, setIsExporting] = useState(false);

  const canExport = Boolean(controller.data?.rows.length);

  const handleExport = async () => {
    if (!controller.data || controller.data.rows.length === 0) {
      return;
    }

    setIsExporting(true);
    try {
      await exportForecastWorkbook(controller.data);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <WmsPageShell
      title="Forecast"
      breadcrumb="WMS Forecast"
      description="Saved smart ordering snapshots from selected WMS stores."
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={!canExport || isExporting || controller.isLoading}
            className="btn btn-md btn-secondary btn-icon"
          >
            <Download className="h-4 w-4" />
            {isExporting ? 'Exporting' : 'Export'}
          </button>
          <button
            type="button"
            onClick={() => void controller.refresh()}
            disabled={controller.isLoading || controller.isGenerating || isExporting}
            className="btn btn-md btn-secondary btn-icon"
          >
            <RefreshCw className={`h-4 w-4 ${controller.isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void controller.generateSnapshot()}
            disabled={controller.selectedStoreIds.length === 0 || controller.isGenerating || isExporting}
            className="btn btn-md btn-primary btn-icon"
          >
            <RefreshCw className={`h-4 w-4 ${controller.isGenerating ? 'animate-spin' : ''}`} />
            {controller.data?.snapshot ? 'Regenerate' : 'Generate'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <WmsCompactPanel
          title="Forecast Filters"
          icon={<CalendarDays className="panel-icon" />}
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => controller.setMode('CYCLE')}
                className={`inline-flex h-10 items-center rounded-t-xl border-b-2 px-3 text-sm-custom font-semibold transition ${
                  controller.mode === 'CYCLE'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted hover:text-primary'
                }`}
              >
                Cycle Forecast
              </button>
              <button
                type="button"
                onClick={() => controller.setMode('CUSTOM')}
                className={`inline-flex h-10 items-center rounded-t-xl border-b-2 px-3 text-sm-custom font-semibold transition ${
                  controller.mode === 'CUSTOM'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted hover:text-primary'
                }`}
              >
                Custom Forecast
              </button>
            </div>

            <div className="flex w-full min-w-0 flex-wrap items-center gap-2.5 overflow-visible">
              {controller.mode === 'CYCLE' ? (
                <ForecastCycleSelector
                  cycles={controller.cycleSnapshots}
                  selectedCycleDate={controller.cycleDate}
                  onCycleChange={controller.setCycleDate}
                />
              ) : (
                <div className="wms-pill-control relative z-50 flex min-w-[320px] flex-1 items-center rounded-2xl border border-[#d7e0e7] bg-white px-2 text-primary shadow-sm">
                  <Datepicker
                    value={{
                      startDate: parseYmdToLocalDate(controller.customForecastRange.startDate),
                      endDate: parseYmdToLocalDate(controller.customForecastRange.endDate),
                    }}
                    onChange={(value: ForecastDateValue) => {
                      if (!value?.startDate || !value?.endDate) {
                        return;
                      }

                      controller.setCustomForecastRange({
                        startDate: normalizeDatepickerValue(value.startDate, controller.customForecastRange.startDate),
                        endDate: normalizeDatepickerValue(value.endDate, controller.customForecastRange.endDate),
                      });
                    }}
                    useRange={false}
                    asSingle={false}
                    showShortcuts={false}
                    showFooter={false}
                    primaryColor="orange"
                    readOnly
                    displayFormat="MM/DD/YYYY"
                    separator=" - "
                    minDate={parseYmdToLocalDate(controller.minCustomForecastDate)}
                    inputClassName="h-10 w-full cursor-pointer rounded-2xl border-0 bg-transparent p-0 text-transparent caret-transparent placeholder:text-transparent focus:outline-none focus:ring-0"
                    containerClassName="w-full"
                    popupClassName={(defaultClass: string) => `${defaultClass} z-[9999]`}
                    toggleIcon={() => (
                      <span className="flex w-full items-center gap-2 overflow-hidden px-1">
                        <CalendarDays className="h-3.5 w-3.5 shrink-0 text-primary" />
                        <span className="whitespace-nowrap text-sm-custom font-semibold text-primary">
                          {formatForecastWeekday(getTodayDateValue())}
                        </span>
                        <span className="text-sm-custom text-muted">forecast</span>
                        <span className="whitespace-nowrap text-sm-custom font-semibold text-primary">
                          {formatForecastShortDate(controller.customForecastRange.startDate)}
                        </span>
                        <span className="text-sm-custom text-muted">to</span>
                        <span className="whitespace-nowrap text-sm-custom text-muted">
                          {formatForecastShortDate(controller.customForecastRange.endDate)}
                        </span>
                      </span>
                    )}
                    toggleClassName="absolute inset-0 flex items-center rounded-2xl px-2 text-slate-600"
                    placeholder=" "
                  />
                </div>
              )}

              <WmsSearchableSelect
                label="Client"
                value={controller.selectedTenantId ?? ''}
                onChange={(value) => controller.changeTenant(value || undefined)}
                options={controller.tenantOptions.map((tenant) => ({
                  value: tenant.id,
                  label: tenant.name,
                  selectedLabel: tenant.name,
                  hint: tenant.slug ?? undefined,
                }))}
                placeholder="Search clients..."
                allLabel="All clients"
                hideInlineLabel
              />

              <ForecastStoreMultiSelect
                stores={controller.storeOptions}
                selectedStoreIds={controller.selectedStoreIds}
                onToggleStore={controller.toggleStore}
                onClearStores={controller.clearStores}
              />

              <ForecastRuleInput label="Safety" suffix="%">
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={controller.safetyStockPct}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.valueAsNumber;
                    controller.setSafetyStockPct(Number.isFinite(nextValue) ? Math.max(0, nextValue) : 0);
                  }}
                  className="w-10 bg-transparent text-right text-sm-custom font-semibold tabular-nums text-foreground outline-none"
                />
              </ForecastRuleInput>

              <ForecastRuleInput label="Past sales">
                <select
                  value={controller.pastSalesWindowDays}
                  onChange={(event) => {
                    const nextValue = Number(event.currentTarget.value);
                    controller.setPastSalesWindowDays([2, 3, 4, 5, 6, 7].includes(nextValue) ? nextValue : 3);
                  }}
                  className="bg-transparent pr-5 text-sm-custom font-semibold text-foreground outline-none"
                >
                  <option value={2}>2d</option>
                  <option value={3}>3d</option>
                  <option value={4}>4d</option>
                  <option value={5}>5d</option>
                  <option value={6}>6d</option>
                  <option value={7}>7d</option>
                </select>
              </ForecastRuleInput>

              <ForecastRuleInput label="Trigger" suffix="d">
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={controller.reorderTriggerDays}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.valueAsNumber;
                    controller.setReorderTriggerDays(Number.isFinite(nextValue) ? Math.max(0, nextValue) : 0);
                  }}
                  className="w-10 bg-transparent text-right text-sm-custom font-semibold tabular-nums text-foreground outline-none"
                />
              </ForecastRuleInput>
            </div>
          </div>
        </WmsCompactPanel>

        {controller.error ? (
          <div className="flex items-start gap-3 rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{controller.error}</span>
          </div>
        ) : null}

        <ForecastTable data={controller.data} isLoading={controller.isLoading} />
      </div>
    </WmsPageShell>
  );
}

function parseYmdToLocalDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) {
    return new Date();
  }

  return new Date(year, month - 1, day);
}

function normalizeDatepickerValue(value: Date | string, fallbackYmd: string) {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }

  return fallbackYmd;
}

function ForecastRuleInput({
  label,
  suffix,
  children,
}: {
  label: string;
  suffix?: string;
  children: ReactNode;
}) {
  return (
    <label className="wms-pill-control flex shrink-0 items-center gap-2 rounded-2xl border border-[#d7e0e7] bg-white px-3 text-primary shadow-sm">
      <span className="card-label">{label}</span>
      {children}
      {suffix ? (
        <span className="text-sm-custom font-semibold text-muted">{suffix}</span>
      ) : null}
    </label>
  );
}

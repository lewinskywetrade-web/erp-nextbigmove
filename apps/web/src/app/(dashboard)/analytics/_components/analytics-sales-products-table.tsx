'use client';

import { type ReactNode } from 'react';
import {
  AnalyticsTableShell,
} from './analytics-table-shell';
import { type SalesOverviewResponse } from '../_types/sales';
import { formatMetricValue, toTitleCase } from '../_utils/metrics';
import { ACTUAL_UNITS_DESCRIPTION, FORECAST_UNITS_DESCRIPTION, cogsUnitsValue } from '../_utils/actual-cogs-units';

export type SalesProductsSortKey =
  | 'index'
  | 'product'
  | 'revenue'
  | 'gross_sales'
  | 'cogs'
  | 'actual_units'
  | 'aov'
  | 'cpp'
  | 'processed_cpp'
  | 'ad_spend'
  | 'ar_pct'
  | 'rts_pct'
  | 'profit_efficiency'
  | 'contribution_margin'
  | 'cm_rts_forecast'
  | 'net_margin';

export type SalesProductRowItem = {
  row: SalesOverviewResponse['products'][number];
  index: number;
  zeroCogsPriority?: 0 | 1 | 2;
  derived: {
    display: string;
    forecast: { revenueAfterRts: number; cmForecast: number };
    rtsPct: number;
    sf: number;
    ff: number;
    iF: number;
    codFeeDelivered: number;
    cogsAdjusted: number;
    cogsRts: number;
  };
};

export type SalesProductsTotalRow = {
  revenue: number;
  grossSales: number;
  cogs: number;
  units?: number | null;
  aov: number;
  cpp: number;
  processedCpp: number;
  adSpend: number;
  arPct: number;
  rtsPct: number;
  profitEfficiency: number;
  contributionMargin: number;
  cmRtsForecast: number;
  netMargin: number;
};

type AnalyticsSalesProductsTableProps = {
  isLoading: boolean;
  /** First-column header: 'Product' on the product tab, 'Store' on the store tab. */
  entityLabel?: string;
  reportView?: 'actual' | 'forecast';
  showUnits?: boolean;
  showZeroCogsReview?: boolean;
  productStart: number;
  productEnd: number;
  totalProducts: number;
  onPrevious: () => void;
  onNext: () => void;
  canPrevious: boolean;
  canNext: boolean;
  pageSize: number;
  productPage: number;
  totalProductPages: number;
  rtsForecastSafe: number;
  rows: SalesProductRowItem[];
  sourceCount: number;
  totals?: SalesProductsTotalRow | null;
  renderSortLabel: (label: ReactNode, key: SalesProductsSortKey) => ReactNode;
};

function AnalyticsSalesProductsTableLoadingRows({ colCount, rowCount = 5 }: { colCount: number; rowCount?: number }) {
  return (
    <>
      {Array.from({ length: rowCount }).map((_, rowIndex) => (
        <tr key={`analytics-sales-products-loading-${rowIndex}`}>
          {Array.from({ length: colCount }).map((__, cellIndex) => (
            <td
              key={`analytics-sales-products-loading-${rowIndex}-${cellIndex}`}
              className="px-3 py-3 sm:px-4 lg:px-6"
            >
              <div className="h-3 w-16 animate-pulse rounded bg-slate-200 dark:bg-slate-600" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function AnalyticsSalesProductsTableEmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td
        className="px-3 py-4 text-center text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6"
        colSpan={colSpan}
      >
        {message}
      </td>
    </tr>
  );
}

export function AnalyticsSalesProductsTable({
  isLoading,
  entityLabel = 'Product',
  reportView = 'actual',
  showUnits = false,
  showZeroCogsReview = false,
  productStart,
  productEnd,
  totalProducts,
  onPrevious,
  onNext,
  canPrevious,
  canNext,
  pageSize,
  productPage,
  totalProductPages,
  rtsForecastSafe,
  rows,
  sourceCount,
  totals,
  renderSortLabel,
}: AnalyticsSalesProductsTableProps) {
  const isForecast = reportView === 'forecast';
  const colCount = (isForecast ? 13 : 15) + (showUnits ? 1 : 0);
  const formatUnits = (value: unknown) => {
    const units = cogsUnitsValue(value, reportView);
    return units === null ? '—' : formatMetricValue(units, 'number', isForecast ? 2 : 0);
  };
  return (
    <AnalyticsTableShell
      summaryLabel={`Showing ${productStart}-${productEnd} of ${totalProducts}`}
      onPrevious={onPrevious}
      onNext={onNext}
      canPrevious={canPrevious}
      canNext={canNext}
      isLoading={isLoading}
      pageIndicatorLabel={`Page ${productPage} of ${totalProductPages}`}
    >
      <div className="overflow-x-auto">
        <table className="min-w-full table-fixed divide-y divide-slate-100 dark:divide-border">
          <thead className="bg-slate-50 dark:bg-background-secondary">
            <tr>
              <th className="w-16 min-w-[4rem] max-w-[4rem] bg-slate-50 px-3 py-3 text-left text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:bg-background-secondary dark:text-slate-300 md:sticky md:left-0 md:z-10 sm:px-4 lg:px-6">
                {renderSortLabel('#', 'index')}
              </th>
              <th className="bg-slate-50 px-3 py-3 text-left text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:bg-background-secondary dark:text-slate-300 md:sticky md:left-16 md:z-10 sm:px-4 lg:px-6">
                {renderSortLabel(entityLabel, 'product')}
              </th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel(isForecast ? 'Forecast Revenue' : 'Gross Revenue', 'revenue')}
              </th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel(isForecast ? 'Expected Deliveries' : 'Gross Sales', 'gross_sales')}
              </th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel(isForecast ? 'Forecast COGS' : 'COGS', 'cogs')}
              </th>
              {showUnits && <th title={isForecast ? FORECAST_UNITS_DESCRIPTION : ACTUAL_UNITS_DESCRIPTION} className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel(isForecast ? 'Forecast Units' : 'Actual Units', 'actual_units')}
              </th>}
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel('AOV', 'aov')}
              </th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel('CPP', 'cpp')}
              </th>
              {!isForecast && <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel('Processed CPP', 'processed_cpp')}
              </th>}
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel('Ad Spend', 'ad_spend')}
              </th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel('AR %', 'ar_pct')}
              </th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel(isForecast ? 'Assumed RTS %' : 'RTS %', 'rts_pct')}
              </th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel('P.E %', 'profit_efficiency')}
              </th>
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel(isForecast ? 'Forecast CM' : 'Contribution Margin', 'contribution_margin')}
              </th>
              {!isForecast && <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel(`CM (RTS ${rtsForecastSafe}% )`, 'cm_rts_forecast')}
              </th>}
              <th className="px-3 py-3 text-center text-xs font-semibold uppercase whitespace-nowrap text-slate-500 dark:text-slate-300 sm:px-4 lg:px-6">
                {renderSortLabel(isForecast ? 'Forecast Net (before overhead)' : 'Net Margin', 'net_margin')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white dark:divide-border dark:bg-surface">
            {isLoading ? (
              <AnalyticsSalesProductsTableLoadingRows colCount={colCount} />
            ) : (
              rows.map((item, idx) => {
                const { row, derived } = item;
                const reviewPriority = showZeroCogsReview ? item.zeroCogsPriority ?? 0 : 0;
                const reviewBackground = reviewPriority > 0
                  ? 'bg-red-50 dark:bg-red-950' : 'bg-white dark:bg-surface';
                const {
                  display,
                  forecast,
                  rtsPct,
                  sf,
                  ff,
                  iF,
                  codFeeDelivered,
                  cogsAdjusted,
                  cogsRts,
                } = derived;

                return (
                  <tr key={`${row.mapping || 'null'}-${idx}`} data-cogs-review={reviewPriority > 0 ? 'zero-cogs' : undefined}
                    className={reviewPriority > 0 ? 'bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900' : 'hover:bg-slate-50 dark:hover:bg-background-secondary'}>
                    <td className={`${reviewBackground} w-16 min-w-[4rem] max-w-[4rem] px-3 py-3 text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 md:sticky md:left-0 md:z-10 sm:px-4 lg:px-6`}>
                      {(productPage - 1) * pageSize + idx + 1}.
                    </td>
                    <td className={`${reviewBackground} px-3 py-3 text-sm font-medium whitespace-nowrap text-slate-900 dark:text-foreground md:sticky md:left-16 md:z-10 sm:px-4 lg:px-6`}>
                      {toTitleCase(display)}
                      {reviewPriority > 0 && <span className="mt-1 block text-xs font-semibold text-red-700 dark:text-red-300">
                        {reviewPriority === 2 ? 'Delivered orders · Zero COGS' : 'Orders · Zero COGS'}
                      </span>}
                    </td>
                    <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(row.revenue, 'currency')}</td>
                    <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(row.gross_sales, 'number', isForecast ? 2 : 0)}</td>
                    <td className={`px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6 ${reviewPriority > 0 ? 'font-semibold text-red-700 dark:text-red-300' : 'text-slate-700 dark:text-slate-300'}`}>{formatMetricValue(row.cogs, 'currency')}</td>
                    {showUnits && <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatUnits(row.actual_units)}</td>}
                    <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(row.aov, 'currency')}</td>
                    <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(row.cpp, 'currency')}</td>
                    {!isForecast && <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(row.processed_cpp, 'currency')}</td>}
                    <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(row.ad_spend, 'currency')}</td>
                    <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(row.ar_pct, 'percent', 1)}</td>
                    <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(rtsPct, 'percent', 1)}</td>
                    <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(row.profit_efficiency, 'percent', 1)}</td>
                    <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(row.contribution_margin, 'currency')}</td>
                    {!isForecast && <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">
                      <span
                        title={`CM (RTS ${rtsForecastSafe}%): ${(formatMetricValue(forecast.revenueAfterRts,'currency'))} - ${(formatMetricValue(row.ad_spend ?? 0,'currency'))} - ${(formatMetricValue(sf,'currency'))} - ${(formatMetricValue(ff,'currency'))} - ${(formatMetricValue(iF,'currency'))} - ${(formatMetricValue(codFeeDelivered,'currency'))} - ${(formatMetricValue(cogsAdjusted,'currency'))} + ${(formatMetricValue(cogsRts,'currency'))} = ${(formatMetricValue(forecast.cmForecast,'currency'))}`}
                      >
                        {formatMetricValue(forecast.cmForecast, 'currency')}
                      </span>
                    </td>}
                    <td className="px-3 py-3 text-center text-sm whitespace-nowrap text-slate-700 dark:text-slate-300 sm:px-4 lg:px-6">{formatMetricValue(row.net_margin, 'currency')}</td>
                  </tr>
                );
              })
            )}
            {!isLoading && sourceCount === 0 ? (
              <AnalyticsSalesProductsTableEmptyRow colSpan={colCount} message="No products found for this range." />
            ) : null}
          </tbody>
          {!isLoading && sourceCount > 0 && totals ? (
            <tfoot className="border-t-2 border-slate-200 bg-slate-100 dark:border-border dark:bg-background-secondary">
              <tr className="font-semibold text-slate-900 dark:text-foreground">
                <td className="w-16 min-w-[4rem] max-w-[4rem] bg-slate-100 px-3 py-3 dark:bg-background-secondary md:sticky md:left-0 md:z-10 sm:px-4 lg:px-6" />
                <td className="bg-slate-100 px-3 py-3 text-sm whitespace-nowrap dark:bg-background-secondary md:sticky md:left-16 md:z-10 sm:px-4 lg:px-6">
                  Total
                </td>
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.revenue, 'currency')}</td>
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.grossSales, 'number', isForecast ? 2 : 0)}</td>
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.cogs, 'currency')}</td>
                {showUnits && <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatUnits(totals.units)}</td>}
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.aov, 'currency')}</td>
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.cpp, 'currency')}</td>
                {!isForecast && <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.processedCpp, 'currency')}</td>}
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.adSpend, 'currency')}</td>
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.arPct, 'percent', 1)}</td>
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.rtsPct, 'percent', 1)}</td>
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.profitEfficiency, 'percent', 1)}</td>
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.contributionMargin, 'currency')}</td>
                {!isForecast && <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.cmRtsForecast, 'currency')}</td>}
                <td className="px-3 py-3 text-center text-sm whitespace-nowrap sm:px-4 lg:px-6">{formatMetricValue(totals.netMargin, 'currency')}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </AnalyticsTableShell>
  );
}

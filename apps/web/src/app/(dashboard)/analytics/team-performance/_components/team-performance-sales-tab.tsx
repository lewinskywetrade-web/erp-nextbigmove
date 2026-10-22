'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertBanner } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import {
  BarChart3,
  CalendarDays,
  Columns,
  Download,
  FileSpreadsheet,
  Filter,
  RefreshCw,
  Users,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useToast } from '@/components/ui/toast';
import { DashboardSection } from '../../../dashboard/_components/dashboard-section';
import { AnalyticsKpiVisibilityDialog } from '../../_components/analytics-kpi-visibility-dialog';
import { AnalyticsMetricCard } from '../../_components/analytics-metric-card';
import { AnalyticsMultiSelectPicker } from '../../_components/analytics-multi-select-picker';
import {
  AnalyticsSalesDeliveryTable,
  type SalesDeliveryRowItem,
  type SalesDeliverySortKey,
} from '../../_components/analytics-sales-delivery-table';
import {
  AnalyticsSalesProductsTable,
  type SalesProductRowItem,
  type SalesProductsSortKey,
} from '../../_components/analytics-sales-products-table';
import { AnalyticsSingleSelectPicker } from '../../_components/analytics-single-select-picker';
import { AnalyticsSortDirectionLabel } from '../../_components/analytics-sort-direction-label';
import {
  AnalyticsTableSelector,
  type AnalyticsTableSelectorOption,
} from '../../_components/analytics-table-selector';
import { useAnalyticsDateRange } from '../../_hooks/use-analytics-date-range';
import {
  ANALYTICS_FILTER_DEBOUNCE_MS,
  buildAnalyticsQueryKey,
  useLatestAnalyticsRequest,
} from '../../_hooks/use-latest-analytics-request';
import { analyticsOverviewApi } from '../../_services/analytics-overview-api';
import {
  salesMetricDefinitions as metricDefinitions,
  salesSecondaryMetricDefinitions as secondaryMetricDefinitions,
  type SalesAttributionOverviewResponse as OverviewResponse,
} from '../../_types/sales-attribution';
import {
  formatDeltaPercent,
  formatMetricValue,
  toTitleCase,
} from '../../_utils/metrics';
import {
  exportSalesProductsCsv,
  exportSalesProductsXlsx,
  type SalesProductsExportRow,
} from '../../_utils/sales-products-export';

import {
  buildSalesKpiForecast,
  buildSalesProductForecast,
  getSafeRtsForecastPct,
} from '../../_utils/sales-forecast';

const Datepicker = dynamic(() => import('react-tailwindcss-datepicker'), { ssr: false });

const KPI_VISIBILITY_STORAGE_KEY = 'sales-attribution-analytics-visible-kpis';
const TEAM_FILTER_ALL = '__all__';
const DEFAULT_HIDDEN_KPI_KEYS = new Set([
  'cpp',
  'processed_cpp',
  'conversion_rate',
  'profit_efficiency',
  'contribution_margin',
]);
const DEFAULT_VISIBLE_KPI_KEYS = [
  ...metricDefinitions.map((def) => String(def.key)),
  ...secondaryMetricDefinitions.map((def) => String(def.key)),
].filter((key) => !DEFAULT_HIDDEN_KPI_KEYS.has(key));

function computeRtsPctFromCounts(counts?: OverviewResponse['counts'] | null) {
  if (!counts) return 0;
  const delivered = counts.delivered ?? 0;
  const rts = counts.rts ?? 0;
  const total = delivered + rts;
  return total > 0 ? (rts / total) * 100 : 0;
}

function parseErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback;
  const maybeError = error as {
    response?: { data?: { message?: unknown } };
    message?: unknown;
  };
  const responseMessage = maybeError.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
    return responseMessage;
  }
  if (typeof maybeError.message === 'string' && maybeError.message.trim().length > 0) {
    return maybeError.message;
  }
  return fallback;
}

function areArraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function areRecordsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export default function SalesByTeamAnalyticsPage() {
  const { addToast } = useToast();
  const { today, range, startDate, endDate, handleDateRangeChange, syncDateRangeFromApi } =
    useAnalyticsDateRange();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { beginRequest, cancelRequest } = useLatestAnalyticsRequest();
  const [selectedTeamCode, setSelectedTeamCode] = useState<string | null>(null);
  const [teamCodeDisplayMap, setTeamCodeDisplayMap] = useState<Record<string, string>>({});
  const [selectedMappings, setSelectedMappings] = useState<string[]>([]);
  const [mappingOptions, setMappingOptions] = useState<string[]>([]);
  const [mappingDisplayMap, setMappingDisplayMap] = useState<Record<string, string>>({});
  const mappingOptionsRef = useRef<string[]>([]);
  const selectedMappingsRef = useRef<string[]>([]);
  const [excludeCanceled, setExcludeCanceled] = useState(true);
  const [excludeRestocking, setExcludeRestocking] = useState(true);
  const [excludeRts, setExcludeRts] = useState(true);
  const [includeTax12, setIncludeTax12] = useState(true);
  const [includeTax1, setIncludeTax1] = useState(true);
  const [rtsForecastPct, setRtsForecastPct] = useState<number>(20);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const filterMenuContentRef = useRef<HTMLDivElement | null>(null);
  const fetchDataRef = useRef<((opts?: { silent?: boolean }) => Promise<void>) | null>(null);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showKpiVisibilityModal, setShowKpiVisibilityModal] = useState(false);
  const [visibleKpiKeys, setVisibleKpiKeys] = useState<string[]>(
    DEFAULT_VISIBLE_KPI_KEYS,
  );
  const [hasLoadedKpiVisibility, setHasLoadedKpiVisibility] = useState(false);
  const pageSize = 10;
  const [tableSelection, setTableSelection] = useState<'products' | 'delivery'>('products');
  const [productPage, setProductPage] = useState(1);
  const [deliveryPage, setDeliveryPage] = useState(1);
  const [sortKey, setSortKey] = useState<SalesProductsSortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [deliverySortKey, setDeliverySortKey] = useState<SalesDeliverySortKey | null>(null);
  const [deliverySortDir, setDeliverySortDir] = useState<'asc' | 'desc'>('desc');
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isExportingXlsx, setIsExportingXlsx] = useState(false);
  const rtsForecastSafe = getSafeRtsForecastPct(rtsForecastPct);
  const salesDateRangeIsToday = startDate === today && endDate === today;

  const formatDateRangeButtonDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-');
    if (!year || !month || !day) return dateStr;
    return `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${year}`;
  };

  const salesDateRangeButtonLabel =
    startDate === endDate
      ? formatDateRangeButtonDate(startDate)
      : `${formatDateRangeButtonDate(startDate)} - ${formatDateRangeButtonDate(endDate)}`;
  const mappingSelectionKey =
    mappingOptions.length === 0 ||
    selectedMappings.length === 0 ||
    (selectedMappings.length === mappingOptions.length &&
      mappingOptions.every((mapping) => selectedMappings.includes(mapping)))
      ? '__all__'
      : [...selectedMappings].sort().join('|');
  const analyticsQueryKey = buildAnalyticsQueryKey(
    startDate,
    endDate,
    selectedTeamCode ?? TEAM_FILTER_ALL,
    mappingSelectionKey,
    excludeCanceled,
    excludeRestocking,
    excludeRts,
    includeTax12,
    includeTax1,
  );
  const [resolvedQueryKey, setResolvedQueryKey] = useState<string | null>(null);
  const isResultPending = isLoading || resolvedQueryKey !== analyticsQueryKey;

  useEffect(() => {
    mappingOptionsRef.current = mappingOptions;
  }, [mappingOptions]);

  useEffect(() => {
    selectedMappingsRef.current = selectedMappings;
  }, [selectedMappings]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const stored = window.localStorage.getItem(KPI_VISIBILITY_STORAGE_KEY);
      if (!stored) {
        setHasLoadedKpiVisibility(true);
        return;
      }

      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) {
        setHasLoadedKpiVisibility(true);
        return;
      }

      const next = parsed
        .map((value) => String(value))
        .filter((value) =>
          [...metricDefinitions, ...secondaryMetricDefinitions].some(
            (definition) => String(definition.key) === value,
          ),
        );

      setVisibleKpiKeys(next.length > 0 ? next : DEFAULT_VISIBLE_KPI_KEYS);
    } catch {
      setVisibleKpiKeys(DEFAULT_VISIBLE_KPI_KEYS);
    } finally {
      setHasLoadedKpiVisibility(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedKpiVisibility || typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(
      KPI_VISIBILITY_STORAGE_KEY,
      JSON.stringify(visibleKpiKeys),
    );
  }, [hasLoadedKpiVisibility, visibleKpiKeys]);

  const fetchData = useCallback(async (opts?: { silent?: boolean }) => {
    const request = beginRequest();
    if (!opts?.silent) setIsLoading(true);
    if (opts?.silent) setIsRefreshing(true);
    setError(null);

    try {
      const currentOptions = mappingOptionsRef.current;
      const currentSelected = selectedMappingsRef.current;
      const normalizedOptions = currentOptions.map((mapping) => mapping.toLowerCase());
      const allPreviouslySelected =
        normalizedOptions.length === 0
          ? currentSelected.length === 0
          : currentSelected.length === 0 ||
            (currentSelected.length === normalizedOptions.length &&
              normalizedOptions.every((mapping) => currentSelected.includes(mapping)));

      const effectiveMappings = allPreviouslySelected ? normalizedOptions : currentSelected;
      const sendAll = allPreviouslySelected || effectiveMappings.length === normalizedOptions.length;
      const params = new URLSearchParams();
      params.set('start_date', startDate);
      params.set('end_date', endDate);
      if (selectedTeamCode) {
        params.set('team_code', selectedTeamCode);
      }
      if (!sendAll && effectiveMappings.length > 0) {
        effectiveMappings.forEach((mapping) => params.append('mapping', mapping));
      }
      params.set('exclude_cancel', String(excludeCanceled));
      params.set('exclude_restocking', String(excludeRestocking));
      params.set('exclude_rts', String(excludeRts));
      params.set('include_tax_12', String(includeTax12));
      params.set('include_tax_1', String(includeTax1));
      const res = await analyticsOverviewApi.getSalesByTeamOverview<OverviewResponse>(
        params,
        request.signal,
      );
      if (!request.isLatest()) return;
      const response = res.data;

      setData(response);
      setResolvedQueryKey(analyticsQueryKey);
      syncDateRangeFromApi(response.selected.start_date, response.selected.end_date);

      const nextTeamDisplayMap = response.filters.teamCodeDisplayMap || {};
      setTeamCodeDisplayMap((prev) => (areRecordsEqual(prev, nextTeamDisplayMap) ? prev : nextTeamDisplayMap));

      const optsList = response.filters.mappings || [];
      const normalized = optsList.map((mapping) => mapping.toLowerCase());
      setMappingOptions((prev) => (areArraysEqual(prev, normalized) ? prev : normalized));
      const nextDisplayMap = response.filters.mappingsDisplayMap || {};
      setMappingDisplayMap((prev) => (areRecordsEqual(prev, nextDisplayMap) ? prev : nextDisplayMap));

      if (allPreviouslySelected) {
        setSelectedMappings((prev) => (areArraysEqual(prev, normalized) ? prev : normalized));
      } else {
        const bounded = currentSelected.filter((mapping) => normalized.includes(mapping));
        setSelectedMappings((prev) => (areArraysEqual(prev, bounded) ? prev : bounded));
      }
    } catch (nextError: unknown) {
      if (!request.isLatest()) return;
      setData(null);
      setResolvedQueryKey(analyticsQueryKey);
      setError(parseErrorMessage(nextError, 'Failed to load sales by team preview'));
    } finally {
      if (request.isLatest()) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
      request.finish();
    }
  }, [
    analyticsQueryKey,
    beginRequest,
    endDate,
    excludeCanceled,
    excludeRestocking,
    excludeRts,
    includeTax1,
    includeTax12,
    selectedTeamCode,
    startDate,
    syncDateRangeFromApi,
  ]);

  useEffect(() => {
    fetchDataRef.current = fetchData;
  }, [fetchData]);

  useEffect(() => {
    cancelRequest();
    setIsLoading(true);
    const timeoutId = window.setTimeout(() => {
      void fetchData();
    }, ANALYTICS_FILTER_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [cancelRequest, fetchData, mappingSelectionKey]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node | null;
      const inFilter = filterMenuRef.current?.contains(target) || filterMenuContentRef.current?.contains(target);
      if (showFilterMenu && !inFilter) {
        setShowFilterMenu(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFilterMenu]);

  const mappingDisplay = (value: string) => mappingDisplayMap[value.toLowerCase()] || value;
  const teamDisplay = (value: string | null) => (value ? teamCodeDisplayMap[value] || value : 'All Teams');
  const teamPickerOptions = [
    { value: TEAM_FILTER_ALL, label: 'All Teams' },
    ...Object.entries(teamCodeDisplayMap)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label })),
  ];
  const mappingPickerOptions = mappingOptions.map((mapping) => ({
    value: mapping,
    label: toTitleCase(mappingDisplay(mapping)),
  }));
  const selectedMappingLabel =
    mappingOptions.length === 0 || selectedMappings.length === mappingOptions.length
      ? 'All mappings'
      : `${selectedMappings.length} selected`;
  const isChecked = (normalized: string) => selectedMappings.includes(normalized);
  const setSort = (key: NonNullable<typeof sortKey>, dir: 'asc' | 'desc') => {
    setSortKey(key);
    setSortDir(dir);
  };
  const setDeliverySort = (key: NonNullable<typeof deliverySortKey>, dir: 'asc' | 'desc') => {
    setDeliverySortKey(key);
    setDeliverySortDir(dir);
  };
  const renderSortLabel = (label: ReactNode, key: NonNullable<typeof sortKey>) => (
    <AnalyticsSortDirectionLabel
      label={label}
      activeDirection={sortKey === key ? sortDir : null}
      onSort={(dir) => setSort(key, dir)}
      ariaLabel={String(label)}
    />
  );
  const renderDeliverySortLabel = (label: ReactNode, key: NonNullable<typeof deliverySortKey>) => (
    <AnalyticsSortDirectionLabel
      label={label}
      activeDirection={deliverySortKey === key ? deliverySortDir : null}
      onSort={(dir) => setDeliverySort(key, dir)}
      ariaLabel={String(label)}
    />
  );

  const forecastOptions = {
    excludeCancel: excludeCanceled,
    excludeRestocking,
    excludeAbandoned: true,
    excludeRts,
  };
  const computedKpis = data
    ? {
        ...data.kpis,
        rts_pct: computeRtsPctFromCounts(data.counts),
        cm_rts_forecast: buildSalesKpiForecast(
          data.kpis, data.counts, forecastOptions, rtsForecastSafe,
        ).cmForecast,
      }
    : null;
  const computedPrevKpis = data
    ? {
        ...data.prevKpis,
        rts_pct: computeRtsPctFromCounts(data.prevCounts),
        cm_rts_forecast: buildSalesKpiForecast(
          data.prevKpis, data.prevCounts, forecastOptions, rtsForecastSafe,
        ).cmForecast,
      }
    : null;

  const products = data?.products || [];
  const sortableProducts: SalesProductRowItem[] = products.map((row, index) => {
    const normalized = (row.mapping || '__null__').toLowerCase();
    const display = row.mapping ? (mappingDisplayMap[normalized] || row.mapping) : 'Unassigned';
    const forecast = buildSalesProductForecast(row, forecastOptions, rtsForecastSafe);
    const { sf, ff, iF, codFeeDelivered, cogsAdjusted, cogsRts } = forecast;
    const deliveredCount = row.delivered_count ?? 0;
    const rtsCount = row.rts_count ?? 0;
    const rtsPct = deliveredCount + rtsCount > 0 ? (rtsCount / (deliveredCount + rtsCount)) * 100 : 0;

    return {
      row,
      index,
      derived: {
        display,
        forecast,
        rtsPct,
        sf,
        ff,
        iF,
        codFeeDelivered,
        cogsAdjusted,
        cogsRts,
      },
    };
  });

  const sortedProducts = sortKey
    ? [...sortableProducts].sort((a, b) => {
        const getValue = (item: typeof a) => {
          const row = item.row;
          switch (sortKey) {
            case 'index':
              return item.index;
            case 'product':
              return item.derived.display.toLowerCase();
            case 'revenue':
              return row.revenue ?? 0;
            case 'gross_sales':
              return row.gross_sales ?? 0;
            case 'cogs':
              return row.cogs ?? 0;
            case 'aov':
              return row.aov ?? 0;
            case 'cpp':
              return row.cpp ?? 0;
            case 'processed_cpp':
              return row.processed_cpp ?? 0;
            case 'ad_spend':
              return row.ad_spend ?? 0;
            case 'ar_pct':
              return row.ar_pct ?? 0;
            case 'rts_pct':
              return item.derived.rtsPct ?? 0;
            case 'profit_efficiency':
              return row.profit_efficiency ?? 0;
            case 'contribution_margin':
              return row.contribution_margin ?? 0;
            case 'cm_rts_forecast':
              return item.derived.forecast.cmForecast ?? 0;
            case 'net_margin':
              return row.net_margin ?? 0;
            default:
              return 0;
          }
        };
        const av = getValue(a);
        const bv = getValue(b);
        if (typeof av === 'string' || typeof bv === 'string') {
          return (sortDir === 'asc' ? 1 : -1) * String(av).localeCompare(String(bv));
        }
        return (sortDir === 'asc' ? 1 : -1) * (Number(av) - Number(bv));
      })
    : sortableProducts;

  const totalProducts = sortedProducts.length;
  const totalProductPages = Math.max(1, Math.ceil(totalProducts / pageSize));
  const pagedProducts = sortedProducts.slice((productPage - 1) * pageSize, productPage * pageSize);
  const productStart = totalProducts === 0 ? 0 : (productPage - 1) * pageSize + 1;
  const productEnd = Math.min(productPage * pageSize, totalProducts);
  const productCanPrev = productPage > 1;
  const productCanNext = productPage < totalProductPages;
  const productTotals = computedKpis
    ? {
        revenue: computedKpis.revenue ?? 0,
        grossSales: data?.counts?.purchases ?? 0,
        cogs: products.reduce((total, row) => total + (row.cogs ?? 0), 0),
        aov: computedKpis.aov ?? 0,
        cpp: computedKpis.cpp ?? 0,
        processedCpp: computedKpis.processed_cpp ?? 0,
        adSpend: computedKpis.ad_spend ?? 0,
        arPct: computedKpis.ar_pct ?? 0,
        rtsPct: computedKpis.rts_pct ?? 0,
        profitEfficiency: computedKpis.profit_efficiency ?? 0,
        contributionMargin: computedKpis.contribution_margin ?? 0,
        cmRtsForecast: computedKpis.cm_rts_forecast ?? 0,
        netMargin: computedKpis.net_margin ?? 0,
      }
    : null;
  const cmRtsExportLabel = `CM (RTS ${rtsForecastSafe}%)`;
  const exportableProducts: SalesProductsExportRow[] = sortedProducts
    .map((item) => ({
      product: toTitleCase(item.derived.display),
      grossRevenue: item.row.revenue ?? 0,
      grossSales: item.row.gross_sales ?? 0,
      cogs: item.row.cogs ?? 0,
      aov: item.row.aov ?? 0,
      cpp: item.row.cpp ?? 0,
      processedCpp: item.row.processed_cpp ?? 0,
      adSpend: item.row.ad_spend ?? 0,
      arPct: item.row.ar_pct ?? 0,
      rtsPct: item.derived.rtsPct ?? 0,
      pePct: item.row.profit_efficiency ?? 0,
      contributionMargin: item.row.contribution_margin ?? 0,
      cmRtsForecast: item.derived.forecast.cmForecast ?? 0,
      netMargin: item.row.net_margin ?? 0,
    }));

  const handleExportProductsCsv = async () => {
    if (isResultPending || exportableProducts.length === 0) return;
    setIsExportingCsv(true);
    try {
      exportSalesProductsCsv({
        startDate,
        endDate,
        cmRtsLabel: cmRtsExportLabel,
        rows: exportableProducts,
      });
      addToast('success', 'CSV export generated.');
    } catch (nextError) {
      console.error('Failed to export Sales by Team CSV', nextError);
      addToast('error', 'Failed to export CSV report.');
    } finally {
      setIsExportingCsv(false);
    }
  };

  const handleExportProductsXlsx = async () => {
    if (isResultPending || exportableProducts.length === 0) return;
    setIsExportingXlsx(true);
    try {
      await exportSalesProductsXlsx({
        startDate,
        endDate,
        cmRtsLabel: cmRtsExportLabel,
        rows: exportableProducts,
      });
      addToast('success', 'XLSX export generated.');
    } catch (nextError) {
      console.error('Failed to export Sales by Team XLSX', nextError);
      addToast('error', 'Failed to export XLSX report.');
    } finally {
      setIsExportingXlsx(false);
    }
  };

  const deliveryStatuses = data?.deliveryStatuses || [];
  const deliveryRows: SalesDeliveryRowItem[] = deliveryStatuses.map((row, index) => {
    const normalized = (row.mapping || '__null__').toLowerCase();
    const display = row.mapping ? (mappingDisplayMap[normalized] || row.mapping) : 'Unassigned';
    return {
      row,
      index,
      display,
    };
  });

  const sortedDeliveryRows = deliverySortKey
    ? [...deliveryRows].sort((a, b) => {
        const getValue = (item: typeof a) => {
          switch (deliverySortKey) {
            case 'index':
              return item.index;
            case 'product':
              return item.display.toLowerCase();
            case 'total_orders':
              return item.row.total_orders ?? 0;
            case 'new_orders':
              return item.row.new_orders ?? 0;
            case 'restocking':
              return item.row.restocking ?? 0;
            case 'confirmed':
              return item.row.confirmed ?? 0;
            case 'printed':
              return item.row.printed ?? 0;
            case 'waiting_pickup':
              return item.row.waiting_pickup ?? 0;
            case 'shipped':
              return item.row.shipped ?? 0;
            case 'delivered':
              return item.row.delivered ?? 0;
            case 'rts':
              return item.row.rts ?? 0;
            case 'canceled':
              return item.row.canceled ?? 0;
            case 'deleted':
              return item.row.deleted ?? 0;
            default:
              return 0;
          }
        };
        const av = getValue(a);
        const bv = getValue(b);
        if (typeof av === 'string' || typeof bv === 'string') {
          return (deliverySortDir === 'asc' ? 1 : -1) * String(av).localeCompare(String(bv));
        }
        return (deliverySortDir === 'asc' ? 1 : -1) * (Number(av) - Number(bv));
      })
    : deliveryRows;

  const totalDelivery = sortedDeliveryRows.length;
  const totalDeliveryPages = Math.max(1, Math.ceil(totalDelivery / pageSize));
  const pagedDeliveryRows = sortedDeliveryRows.slice((deliveryPage - 1) * pageSize, deliveryPage * pageSize);
  const deliveryStart = totalDelivery === 0 ? 0 : (deliveryPage - 1) * pageSize + 1;
  const deliveryEnd = Math.min(deliveryPage * pageSize, totalDelivery);
  const deliveryCanPrev = deliveryPage > 1;
  const deliveryCanNext = deliveryPage < totalDeliveryPages;

  const metricValues = data
    ? metricDefinitions.map((definition) => {
        const current = computedKpis?.[definition.key] ?? 0;
        const previous = computedPrevKpis?.[definition.key] ?? 0;
        const delta = formatDeltaPercent(current, previous);
        const countCurrent = definition.countKey ? data.counts?.[definition.countKey] ?? 0 : null;
        const countPrev = definition.countKey ? data.prevCounts?.[definition.countKey] ?? 0 : null;
        const countDelta = definition.countKey ? formatDeltaPercent(countCurrent ?? 0, countPrev ?? 0) : null;
        return { ...definition, current, previous, delta, countCurrent, countPrev, countDelta };
      })
    : metricDefinitions.map((definition) => ({
        ...definition,
        current: 0, previous: 0, delta: null as number | null,
        countCurrent: definition.countKey ? 0 : null,
        countPrev: definition.countKey ? 0 : null,
        countDelta: null as number | null,
      }));
  const visibleMetricValues = metricValues.filter((metric) =>
    visibleKpiKeys.includes(String(metric.key)),
  );

  const tableOptions: AnalyticsTableSelectorOption<'products' | 'delivery'>[] = [
    { key: 'products', label: 'Revenue per Product' },
    { key: 'delivery', label: 'Delivery Status' },
  ];

  const leftCard = visibleMetricValues.find((metric) => metric.key === 'revenue');
  const rightCard = visibleMetricValues.find((metric) => metric.key === 'ad_spend');
  const middleCards = visibleMetricValues.filter(
    (metric) => metric.key !== 'revenue' && metric.key !== 'ad_spend',
  );

  const secondaryCards =
    data
      ? secondaryMetricDefinitions.map((definition) => {
          const current = computedKpis?.[definition.key] ?? 0;
          const previous = computedPrevKpis?.[definition.key] ?? 0;
          const delta = formatDeltaPercent(current, previous);
          const label =
            definition.key === 'cm_rts_forecast'
              ? `CM (RTS ${rtsForecastSafe}% )`
              : definition.label;
          return {
            key: definition.key,
            label,
            format: definition.format,
            current,
            previous,
            delta,
            countCurrent: null,
            countPrev: null,
            countDelta: null,
          };
        })
      : [];
  const visibleSecondaryCards = secondaryCards.filter((metric) =>
    visibleKpiKeys.includes(String(metric.key)),
  );
  const leftSecondary = visibleSecondaryCards.find((metric) => metric.key === 'cm_rts_forecast');
  const fixedRightSecondary = visibleSecondaryCards.filter(
    (metric) => metric.key === 'net_margin',
  );
  const middleSecondary = visibleSecondaryCards.filter(
    (metric) =>
      metric.key !== 'cm_rts_forecast' &&
      metric.key !== 'net_margin',
  );

  const allVisibilityDefinitions = [
    ...metricDefinitions,
    ...secondaryMetricDefinitions,
  ];
  const visibilityDefinitionMap = new Map(
    allVisibilityDefinitions.map((metric) => [String(metric.key), metric]),
  );

  const buildVisibilityOption = (
    key: string,
    section: 'Primary' | 'Secondary',
  ) => {
    const metric = visibilityDefinitionMap.get(key);
    return metric
      ? {
          key,
          label: metric.label,
          section,
        }
      : null;
  };

  const kpiVisibilityOptions = [
    'revenue',
    'unconfirmed',
    'confirmed',
    'canceled',
    'restocking_cod',
    'waiting_pickup',
    'shipped',
    'delivered',
  ]
    .map((key) => buildVisibilityOption(key, 'Primary'))
    .concat(
      [
        'cm_rts_forecast',
        'ar_pct',
        'cancellation_rate_pct',
        'aov',
        'cpp',
        'processed_cpp',
        'rts_pct',
        'ad_spend',
        'rts',
        'conversion_rate',
        'profit_efficiency',
        'contribution_margin',
        'net_margin',
      ].map((key) => buildVisibilityOption(key, 'Secondary')),
    )
    .filter((option): option is NonNullable<typeof option> => option !== null);

  const buildCmTooltip = (kpis: OverviewResponse['kpis'] | undefined): ReactNode | null => {
    if (!kpis) return null;
    const nf = (value: number) => formatMetricValue(value, 'currency');
    const neg = (value: number) => (value === 0 ? nf(0) : `- ${nf(Math.abs(value))}`);
    const pos = (value: number) => (value === 0 ? nf(0) : `+ ${nf(Math.abs(value))}`);
    const fulfillment = (kpis.sf_fees ?? 0) + (kpis.ff_fees ?? 0) + (kpis.if_fees ?? 0);
    const canceledCodAdj = excludeCanceled ? kpis.canceled_cod ?? 0 : 0;
    const restockingCodAdj = excludeRestocking ? kpis.restocking_cod ?? 0 : 0;
    const rtsCodAdj = excludeRts ? kpis.rts_cod ?? 0 : 0;
    const excludedCogsCanceled = excludeCanceled ? kpis.cogs_canceled ?? 0 : 0;
    const excludedCogsRestocking = excludeRestocking ? kpis.cogs_restocking ?? 0 : 0;
    const excludedCogsRts = excludeRts ? kpis.cogs_rts ?? 0 : 0;
    const cogsRaw = kpis.cogs ?? 0;
    const cogsIncluded =
      kpis.cogs_adjusted ??
      cogsRaw - excludedCogsCanceled - excludedCogsRestocking - excludedCogsRts;
    const rtsCogsCredit = kpis.cogs_rts_credit ?? (excludeRts ? 0 : kpis.cogs_rts ?? 0);
    const filtersLabel = [
      `${startDate} → ${endDate}`,
      selectedTeamCode ? teamDisplay(selectedTeamCode) : 'All teams',
      `${selectedMappings.length || 0}/${mappingOptions.length || 0} mappings`,
      `Exclude: cancel ${excludeCanceled ? 'ON' : 'OFF'}, restocking ${excludeRestocking ? 'ON' : 'OFF'}, RTS ${excludeRts ? 'ON' : 'OFF'}`,
    ].join(' • ');

    return (
      <div className="space-y-1">
        <p className="font-semibold text-foreground">Contribution Margin inputs</p>
        <div className="flex justify-between text-foreground">
          <span>Gross COD</span>
          <span>{nf(kpis.gross_cod ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-700">
          <span>Canceled COD</span>
          <span>{neg(canceledCodAdj)}</span>
        </div>
        <div className="flex justify-between text-slate-700">
          <span>Restocking COD</span>
          <span>{neg(restockingCodAdj)}</span>
        </div>
        <div className="flex justify-between text-slate-700">
          <span>RTS COD</span>
          <span>{neg(rtsCodAdj)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-100 pt-1 text-foreground">
          <span>Revenue after adjustments</span>
          <span>{nf(kpis.revenue ?? 0)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-100 pt-1 text-foreground">
          <span>Fulfillment (SF+FF+IF)</span>
          <span>{neg(fulfillment)}</span>
        </div>
        <div className="flex justify-between text-xs text-slate-600">
          <span>SF Fees</span>
          <span>{neg(kpis.sf_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-xs text-slate-600">
          <span>FF Fees</span>
          <span>{neg(kpis.ff_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-xs text-slate-600">
          <span>IF Fees</span>
          <span>{neg(kpis.if_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-100 pt-1 text-foreground">
          <span>COD Fee</span>
          <span>{neg(kpis.cod_fee ?? 0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>Ad Spend</span>
          <span>{neg(kpis.ad_spend ?? 0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>COGS (raw)</span>
          <span>{neg(cogsRaw)}</span>
        </div>
        <div className="flex justify-between text-[12px] text-slate-700">
          <span>- COGS Canceled</span>
          <span>{pos(excludedCogsCanceled)}</span>
        </div>
        <div className="flex justify-between text-[12px] text-slate-700">
          <span>- COGS Restocking</span>
          <span>{pos(excludedCogsRestocking)}</span>
        </div>
        <div className="flex justify-between text-[12px] text-slate-700">
          <span>- COGS RTS</span>
          <span>{pos(excludedCogsRts)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-100 pt-1 text-foreground">
          <span>COGS used in CM</span>
          <span>{neg(cogsIncluded)}</span>
        </div>
        <div className="flex justify-between text-[12px] text-slate-700">
          <span>+ RTS COGS</span>
          <span>{pos(rtsCogsCredit)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900">
          <span>Contribution Margin</span>
          <span>{nf(kpis.contribution_margin ?? 0)}</span>
        </div>
        <p className="text-xs text-slate-500">{filtersLabel}</p>
      </div>
    );
  };

  const buildNmTooltip = (kpis: OverviewResponse['kpis'] | undefined): ReactNode | null => {
    if (!kpis) return null;
    const nf = (value: number) => formatMetricValue(value, 'currency');
    const neg = (value: number) => (value === 0 ? nf(0) : `- ${nf(Math.abs(value))}`);
    const filtersLabel = [
      `${startDate} → ${endDate}`,
      selectedTeamCode ? teamDisplay(selectedTeamCode) : 'All teams',
      `${selectedMappings.length || 0}/${mappingOptions.length || 0} mappings`,
      `Exclude: cancel ${excludeCanceled ? 'ON' : 'OFF'}, restocking ${excludeRestocking ? 'ON' : 'OFF'}, RTS ${excludeRts ? 'ON' : 'OFF'}`,
    ].join(' • ');

    return (
      <div className="space-y-1">
        <p className="font-semibold text-foreground">Net Margin inputs</p>
        <div className="flex justify-between text-foreground">
          <span>Delivered COD</span>
          <span>{nf(kpis.delivered ?? 0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>SF SDR Fees</span>
          <span>{neg(kpis.sf_sdr_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>FF SDR Fees</span>
          <span>{neg(kpis.ff_sdr_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>IF SDR Fees</span>
          <span>{neg(kpis.if_sdr_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>COD Fee (Delivered)</span>
          <span>{neg(kpis.cod_fee_delivered ?? 0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>COGS Delivered</span>
          <span>{neg(kpis.cogs_delivered ?? 0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>Ad Spend</span>
          <span>{neg(kpis.ad_spend ?? 0)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900">
          <span>Net Margin</span>
          <span>{nf(kpis.net_margin ?? 0)}</span>
        </div>
        <p className="text-xs text-slate-500">{filtersLabel}</p>
      </div>
    );
  };

  const buildCmRtsTooltip = (kpis: OverviewResponse['kpis'] | undefined): ReactNode | null => {
    if (!kpis || !data) return null;
    const nf = (value: number) => formatMetricValue(value, 'currency');
    const neg = (value: number) => (value === 0 ? nf(0) : `- ${nf(Math.abs(value))}`);
    const pos = (value: number) => (value === 0 ? nf(0) : `+ ${nf(Math.abs(value))}`);
    const forecast = buildSalesKpiForecast(
      kpis, data?.counts ?? {}, forecastOptions, rtsForecastSafe,
    );
    const {
      cogsTotal, cogsCanceled, cogsRestocking, cogsAdjusted,
      purchases: purchasesForCmRts, aov: aovForCmRts, revenueBase: revenueBaseForCmRts,
    } = forecast;
    const filtersLabel = [
      `${startDate} → ${endDate}`,
      selectedTeamCode ? teamDisplay(selectedTeamCode) : 'All teams',
      `${selectedMappings.length || 0}/${mappingOptions.length || 0} mappings`,
      `Exclude: cancel ${excludeCanceled ? 'ON' : 'OFF'}, restocking ${excludeRestocking ? 'ON' : 'OFF'}`,
      `RTS %: ${rtsForecastSafe}`,
    ].join(' • ');

    return (
      <div className="space-y-1">
        <p className="font-semibold text-foreground">CM (RTS {rtsForecastSafe}%) inputs</p>
        <div className="flex justify-between text-foreground">
          <span>Purchases (adj)</span>
          <span>{purchasesForCmRts.toFixed(0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>AOV (adj)</span>
          <span>{nf(aovForCmRts)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-100 pt-1 text-foreground">
          <span>Revenue base (AOV × purchases)</span>
          <span>{nf(revenueBaseForCmRts)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>RTS forecast ({rtsForecastSafe}%)</span>
          <span>{neg(revenueBaseForCmRts * forecast.rtsFraction)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-100 pt-1 text-foreground">
          <span>Revenue after RTS</span>
          <span>{nf(forecast.revenueAfterRts)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>Ad Spend</span>
          <span>{neg(kpis.ad_spend ?? 0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>Fulfillment (SF+FF+IF)</span>
          <span>{neg((kpis.sf_fees ?? 0) + (kpis.ff_fees ?? 0) + (kpis.if_fees ?? 0))}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>COD Fee (Delivered)</span>
          <span>{neg(kpis.cod_fee_delivered ?? 0)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>COGS (raw)</span>
          <span>{neg(cogsTotal)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>Excluded COGS Canceled</span>
          <span>{pos(cogsCanceled)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>Excluded COGS Restocking</span>
          <span>{pos(cogsRestocking)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-100 pt-1 text-foreground">
          <span>COGS (adjusted)</span>
          <span>{neg(cogsAdjusted)}</span>
        </div>
        <div className="flex justify-between text-foreground">
          <span>RTS COGS</span>
          <span>{pos(kpis.cogs_rts ?? 0)}</span>
        </div>
        <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900">
          <span>CM (RTS {rtsForecastSafe}%)</span>
          <span>{nf(forecast.cmForecast)}</span>
        </div>
        <p className="text-xs text-slate-500">{filtersLabel}</p>
      </div>
    );
  };

  const handleWheelScroll = (event: React.WheelEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const hasHorizontalOverflow = container.scrollWidth > container.clientWidth + 1;
    if (!hasHorizontalOverflow) return;

    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      container.scrollLeft += event.deltaY;
    }
  };

  const renderCard = (metric: (typeof metricValues)[number]) => {
    const tooltip =
      metric.key === 'cm_rts_forecast'
        ? buildCmRtsTooltip(data?.kpis)
        : metric.key === 'contribution_margin'
          ? buildCmTooltip(data?.kpis)
          : metric.key === 'net_margin'
            ? buildNmTooltip(data?.kpis)
            : null;

    return (
      <AnalyticsMetricCard
        key={metric.key}
        loading={isResultPending}
        label={metric.label}
        value={metric.current}
        format={metric.format}
        precision={metric.format === 'percent' ? 1 : 2}
        delta={metric.delta}
        count={
          metric.countKey
            ? {
                label: 'ord',
                value: metric.countCurrent ?? 0,
                delta: metric.countDelta ?? null,
              }
            : undefined
        }
        tooltip={tooltip}
        tooltipMode={metric.key === 'contribution_margin' ? 'popover' : 'hover'}
        className="w-full xl:min-w-[190px] xl:w-auto"
      />
    );
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1.5">
          <p className="text-xs-tight font-semibold uppercase tracking-[0.2em] text-primary">
            Analytics
          </p>
          <div className="space-y-0.5">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Team Performance
            </h1>
            <p className="text-sm-custom text-slate-500 dark:text-slate-300">
              Monitor sales performance by team code and mapping.
            </p>
          </div>
        </div>
      </header>

      <DashboardSection
        title="Sales by Team Monitoring"
        icon={<Users className="panel-icon" />}
        meta={`Last updated: ${data?.lastUpdatedAt ? new Date(data.lastUpdatedAt).toLocaleString() : '-'}`}
        contentClassName="space-y-5"
      >
        <div className="flex flex-wrap items-center gap-3">
          <AnalyticsSingleSelectPicker
            className="relative z-30 [&>button]:h-10 [&>button]:rounded-xl [&>button]:border-slate-200"
            selectedLabel={teamDisplay(selectedTeamCode)}
            selectTitle="Select team"
            options={teamPickerOptions}
            selectedValue={selectedTeamCode ?? TEAM_FILTER_ALL}
            onSelect={(value) => {
              setSelectedTeamCode(value === TEAM_FILTER_ALL ? null : value);
              setProductPage(1);
              setDeliveryPage(1);
              setSelectedMappings([]);
            }}
          />

          <div className="flex items-stretch">
            <AnalyticsMultiSelectPicker
              className="relative z-30 [&>button]:h-10 [&>button]:rounded-r-none [&>button]:rounded-l-xl [&>button]:border-r-0 [&>button]:border-slate-200"
              selectedLabel={selectedMappingLabel}
              selectTitle="Select mappings"
              options={mappingPickerOptions}
              allChecked={
                mappingOptions.length > 0 &&
                selectedMappings.length === mappingOptions.length
              }
              isChecked={isChecked}
              onToggleAll={(checked) => {
                setSelectedMappings(checked ? mappingOptions : []);
                setProductPage(1);
                setDeliveryPage(1);
              }}
              onToggle={(value) => {
                setSelectedMappings((prev) =>
                  prev.includes(value)
                    ? prev.filter((entry) => entry !== value)
                    : [...prev, value],
                );
                setProductPage(1);
                setDeliveryPage(1);
              }}
              onOnly={(value) => {
                setSelectedMappings([value]);
                setProductPage(1);
                setDeliveryPage(1);
              }}
              onClear={() => {
                setSelectedMappings([]);
                setProductPage(1);
                setDeliveryPage(1);
              }}
            />
            <div className="relative" ref={filterMenuContentRef}>
              <button
                type="button"
                onClick={() => setShowFilterMenu((prev) => !prev)}
                className="inline-flex h-10 items-center justify-center rounded-r-xl rounded-l-none border border-slate-200 bg-white px-3 text-slate-600 hover:border-orange-200 hover:text-orange-700 dark:border-border dark:bg-transparent dark:text-foreground"
                aria-label="Filters"
              >
                <Filter className="h-4 w-4" />
              </button>
              {showFilterMenu && (
                <div className="absolute right-0 z-30 mt-2 w-60 space-y-3 rounded-xl border border-slate-200 bg-surface p-3 shadow-lg dark:border-border">
                  <label className="flex cursor-pointer select-none items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                      checked={excludeCanceled}
                      onChange={(event) => setExcludeCanceled(event.target.checked)}
                    />
                    <span className="text-sm text-foreground">Exclude Canceled</span>
                  </label>
                  <label className="flex cursor-pointer select-none items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                      checked={excludeRestocking}
                      onChange={(event) => setExcludeRestocking(event.target.checked)}
                    />
                    <span className="text-sm text-foreground">Exclude Restocking</span>
                  </label>
                  <label className="flex cursor-pointer select-none items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                      checked={excludeRts}
                      onChange={(event) => setExcludeRts(event.target.checked)}
                    />
                    <span className="text-sm text-foreground">Exclude RTS</span>
                  </label>
                  <div className="my-1 h-px bg-slate-100 dark:bg-border" />
                  <div className="space-y-1">
                    <label className="flex items-center justify-between text-sm text-foreground">
                      <span>RTS %</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={Number.isFinite(rtsForecastPct) ? rtsForecastPct : 20}
                        onChange={(event) => {
                          const value = parseFloat(event.target.value);
                          if (Number.isNaN(value)) {
                            setRtsForecastPct(20);
                            return;
                          }
                          setRtsForecastPct(Math.min(100, Math.max(0, value)));
                        }}
                        className="w-20 rounded border border-slate-200 px-2 py-1 text-sm text-foreground dark:bg-surface dark:border-border focus:border-indigo-300 focus:outline-none"
                      />
                    </label>
                    <p className="text-xs text-slate-500 dark:text-slate-300">Used for CM (RTS %) forecast column</p>
                  </div>
                  <div className="my-1 h-px bg-slate-100 dark:bg-border" />
                  <label className="flex cursor-pointer select-none items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                      checked={includeTax12}
                      onChange={(event) => setIncludeTax12(event.target.checked)}
                    />
                    <span className="text-sm text-foreground">Include 12% Ads Tax</span>
                  </label>
                  <label className="flex cursor-pointer select-none items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                      checked={includeTax1}
                      onChange={(event) => setIncludeTax1(event.target.checked)}
                    />
                    <span className="text-sm text-foreground">Include 1% transaction fee</span>
                  </label>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative" ref={filterMenuRef}>
              <Datepicker
                value={range}
                onChange={handleDateRangeChange}
                useRange={false}
                asSingle={false}
                showShortcuts={false}
                showFooter={false}
                primaryColor="orange"
                readOnly
                inputClassName={`h-10 cursor-pointer rounded-xl border border-slate-200 bg-white p-0 text-transparent caret-transparent placeholder:text-transparent shadow-sm transition-[width] duration-300 ease-out focus:border-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-100 dark:!border-border dark:!bg-transparent dark:!text-transparent ${
                  salesDateRangeIsToday ? 'w-10' : 'w-[200px] sm:w-[236px]'
                }`}
                containerClassName=""
                popupClassName={(defaultClass) => `${defaultClass} z-50 kpi-datepicker-light`}
                displayFormat="MM/DD/YYYY"
                separator=" – "
                toggleIcon={() => (
                  <span className="flex w-full items-center gap-2 overflow-hidden">
                    <CalendarDays className="h-4 w-4 shrink-0" />
                    <span
                      className={`whitespace-nowrap text-xs font-medium text-slate-700 transition-all duration-300 ease-out dark:text-foreground ${
                        salesDateRangeIsToday
                          ? 'max-w-0 -translate-x-1 opacity-0'
                          : 'max-w-[148px] translate-x-0 opacity-100 sm:max-w-[184px]'
                      }`}
                    >
                      {salesDateRangeButtonLabel}
                    </span>
                  </span>
                )}
                toggleClassName="absolute inset-0 flex cursor-pointer items-center justify-start px-3 text-slate-600 hover:text-orange-700 dark:text-foreground"
                placeholder=" "
              />
            </div>
            <div className="relative flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void fetchData({ silent: true });
                }}
                disabled={isRefreshing}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:border-slate-300 disabled:opacity-60 dark:border-border dark:bg-transparent dark:text-foreground"
                aria-label="Refresh preview"
                title="Refresh preview"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => setShowKpiVisibilityModal(true)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-border dark:bg-transparent dark:text-foreground"
                aria-label="Show or hide KPI boxes"
                title="Show or hide KPI boxes"
              >
                <Columns className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {error && <AlertBanner tone="error" message={error} className="mt-4" />}

        <div className="flex flex-col gap-3 xl:flex-row">
          {(
            <>
              {visibleMetricValues.length === 0 ? (
                <div className="flex w-full items-center justify-center rounded-lg border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500">
                  No KPI boxes selected.
                </div>
              ) : (
                <>
                  {leftCard && renderCard(leftCard)}
                  <div
                    className="w-full max-h-[30vh] overflow-y-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:rgb(148_163_184_/_0.45)_transparent] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400/40 hover:[&::-webkit-scrollbar-thumb]:bg-slate-400/60 xl:flex-1 xl:max-h-none xl:overflow-x-auto xl:overflow-y-hidden xl:[scrollbar-width:none] xl:[&::-webkit-scrollbar]:h-0 xl:[&::-webkit-scrollbar]:w-0"
                    onWheel={handleWheelScroll}
                  >
                    <div className="flex flex-col gap-3 xl:min-w-full xl:flex-row">
                      {middleCards.map((metric) => renderCard(metric))}
                    </div>
                  </div>
                  {rightCard && renderCard(rightCard)}
                </>
              )}
            </>
          )}
        </div>

        <div className="flex flex-col gap-3 xl:flex-row">
          {(
            <>
              {visibleSecondaryCards.length === 0 ? null : (
                <>
                  {leftSecondary && renderCard(leftSecondary)}
                  <div
                    className="w-full max-h-[30vh] overflow-y-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:rgb(148_163_184_/_0.45)_transparent] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400/40 hover:[&::-webkit-scrollbar-thumb]:bg-slate-400/60 xl:flex-1 xl:max-h-none xl:overflow-x-auto xl:overflow-y-hidden xl:[scrollbar-width:none] xl:[&::-webkit-scrollbar]:h-0 xl:[&::-webkit-scrollbar]:w-0"
                    onWheel={handleWheelScroll}
                  >
                    <div className="flex flex-col gap-3 xl:min-w-full xl:flex-row">
                      {middleSecondary.map((metric) => renderCard(metric))}
                    </div>
                  </div>
                  {fixedRightSecondary.length > 0 && (
                    <div className="flex w-full flex-col gap-3 xl:w-auto xl:flex-row">
                      {fixedRightSecondary.map((metric) => renderCard(metric))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </DashboardSection>

      <DashboardSection
        title="Sales Breakdown"
        icon={<BarChart3 className="panel-icon" />}
        contentClassName="space-y-3"
      >
        <div className="flex items-center justify-between">
          <AnalyticsTableSelector
            className="relative z-20"
            options={tableOptions}
            selectedKey={tableSelection}
            fallbackLabel="Revenue per Product"
            onSelect={(key) => {
              setTableSelection(key);
              setProductPage(1);
              setDeliveryPage(1);
            }}
          />
          {tableSelection === 'products' && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                iconLeft={<Download className="h-4 w-4" />}
                onClick={() => void handleExportProductsCsv()}
                disabled={isResultPending || exportableProducts.length === 0}
                loading={isExportingCsv}
                className="btn-icon"
              >
                Export CSV
              </Button>
              <Button
                size="sm"
                iconLeft={<FileSpreadsheet className="h-4 w-4" />}
                onClick={() => void handleExportProductsXlsx()}
                disabled={isResultPending || exportableProducts.length === 0}
                loading={isExportingXlsx}
                className="btn-icon"
              >
                Export XLSX
              </Button>
            </div>
          )}
        </div>

        {tableSelection === 'products' ? (
          <AnalyticsSalesProductsTable
            isLoading={isResultPending}
            productStart={productStart}
            productEnd={productEnd}
            totalProducts={totalProducts}
            onPrevious={() => setProductPage((page) => Math.max(1, page - 1))}
            onNext={() => setProductPage((page) => Math.min(totalProductPages, page + 1))}
            canPrevious={productCanPrev}
            canNext={productCanNext}
            pageSize={pageSize}
            productPage={productPage}
            totalProductPages={totalProductPages}
            rtsForecastSafe={rtsForecastSafe}
            rows={pagedProducts}
            totals={productTotals}
            sourceCount={products.length}
            renderSortLabel={renderSortLabel}
          />
        ) : (
          <AnalyticsSalesDeliveryTable
            isLoading={isResultPending}
            deliveryStart={deliveryStart}
            deliveryEnd={deliveryEnd}
            totalDelivery={totalDelivery}
            onPrevious={() => setDeliveryPage((page) => Math.max(1, page - 1))}
            onNext={() => setDeliveryPage((page) => Math.min(totalDeliveryPages, page + 1))}
            canPrevious={deliveryCanPrev}
            canNext={deliveryCanNext}
            pageSize={pageSize}
            deliveryPage={deliveryPage}
            totalDeliveryPages={totalDeliveryPages}
            rows={pagedDeliveryRows}
            sourceCount={deliveryStatuses.length}
            renderSortLabel={renderDeliverySortLabel}
          />
        )}
      </DashboardSection>

      <AnalyticsKpiVisibilityDialog
        open={showKpiVisibilityModal}
        onOpenChange={setShowKpiVisibilityModal}
        options={kpiVisibilityOptions}
        selectedKeys={visibleKpiKeys}
        onToggleKey={(key) =>
          setVisibleKpiKeys((prev) =>
            prev.includes(key)
              ? prev.filter((entry) => entry !== key)
              : [...prev, key],
          )
        }
        onSelectAll={() => setVisibleKpiKeys(kpiVisibilityOptions.map((option) => option.key))}
        onResetDefaults={() => setVisibleKpiKeys(DEFAULT_VISIBLE_KPI_KEYS)}
        title="Visible KPI Boxes"
        description="Choose which KPI cards appear in Sales by Team Monitoring."
      />
    </div>
  );
}

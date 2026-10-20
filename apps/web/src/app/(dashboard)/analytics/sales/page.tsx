'use client';

import { buildSalesMappingSelection, parseSalesTeamSelection } from '../_utils/sales-selection';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { AlertBanner } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import apiClient from '@/lib/api-client';
import {
  BarChart3,
  CalendarDays,
  Columns,
  Download,
  FileSpreadsheet,
  Filter,
  RefreshCw,
  ShoppingBag,
  Share2,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useToast } from '@/components/ui/toast';
import { DashboardSection } from '../../dashboard/_components/dashboard-section';
import { AnalyticsKpiVisibilityDialog } from '../_components/analytics-kpi-visibility-dialog';
import { AnalyticsMultiSelectPicker } from '../_components/analytics-multi-select-picker';
import { AnalyticsMetricCard } from '../_components/analytics-metric-card';
import {
  AnalyticsSalesDeliveryTable,
  type SalesDeliveryRowItem,
  type SalesDeliverySortKey,
} from '../_components/analytics-sales-delivery-table';
import {
  AnalyticsSalesProductsTable,
  type SalesProductRowItem,
  type SalesProductsSortKey,
} from '../_components/analytics-sales-products-table';
import { AnalyticsShareDialog } from '../_components/analytics-share-dialog';
import { AnalyticsSortDirectionLabel } from '../_components/analytics-sort-direction-label';
import {
  AnalyticsTableSelector,
  type AnalyticsTableSelectorOption,
} from '../_components/analytics-table-selector';
import { useAnalyticsDateRange } from '../_hooks/use-analytics-date-range';
import {
  ANALYTICS_FILTER_DEBOUNCE_MS,
  buildAnalyticsQueryKey,
  useLatestAnalyticsRequest,
} from '../_hooks/use-latest-analytics-request';
import { useAnalyticsShare } from '../_hooks/use-analytics-share';
import { analyticsOverviewApi } from '../_services/analytics-overview-api';
import { useVisibleAutoRefresh } from '../_hooks/use-visible-auto-refresh';
import { useWorkflowTenantEvent } from '../_hooks/use-workflow-tenant-event';
import {
  type SalesOverviewResponse as OverviewResponse,
  salesMetricDefinitions as metricDefinitions,
  salesSecondaryMetricDefinitions as secondaryMetricDefinitions,
} from '../_types/sales';
import {
  formatDeltaPercent,
  formatMetricValue,
  toTitleCase,
} from '../_utils/metrics';
import {
  exportSalesProductsCsv,
  exportSalesProductsXlsx,
  type SalesProductsExportRow,
} from '../_utils/sales-products-export';
import {
  buildSalesKpiForecast,
  buildSalesProductForecast,
  getSafeRtsForecastPct,
} from '../_utils/sales-forecast';
import {
  forecastSalesKpis, forecastSalesProduct, forecastKpiValues, forecastProductValues, observedCodFeeRate,
} from '../_utils/sales-report-forecast';
import { cogsUnitsValue, canViewCogsUnits } from '../_utils/actual-cogs-units';

const Datepicker = dynamic(() => import('react-tailwindcss-datepicker'), { ssr: false });

const KPI_VISIBILITY_STORAGE_KEY = 'sales-analytics-visible-kpis';
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
  if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) return responseMessage;
  if (typeof maybeError.message === 'string' && maybeError.message.trim().length > 0) return maybeError.message;
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

export default function SalesAnalyticsPage() {
  const { today, range, startDate, endDate, handleDateRangeChange, syncDateRangeFromApi } =
    useAnalyticsDateRange();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [hasSuperAdminIdentity, setHasSuperAdminIdentity] = useState(false);
  // The API independently omits this field for other roles. Require both its
  // current response and the freshly verified identity, even during View As.
  const showUnits = hasSuperAdminIdentity
    && Object.prototype.hasOwnProperty.call(data?.kpis ?? {}, 'actual_units');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { beginRequest, cancelRequest } = useLatestAnalyticsRequest();
  const [selectedMappings, setSelectedMappings] = useState<string[]>([]);
  const [isAllMappingsMode, setIsAllMappingsMode] = useState(true);
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [mappingOptions, setMappingOptions] = useState<string[]>([]);
  const [mappingDisplayMap, setMappingDisplayMap] = useState<Record<string, string>>({});
  const mappingOptionsRef = useRef<string[]>([]);
  const selectedMappingsRef = useRef<string[]>([]);
  const [excludeCanceled, setExcludeCanceled] = useState(true);
  const [excludeRestocking, setExcludeRestocking] = useState(true);
  const [excludeAbandoned, setExcludeAbandoned] = useState(true);
  const [excludeRts, setExcludeRts] = useState(true);
  const [excludeRepurchase, setExcludeRepurchase] = useState(true);
  const [includeTax12, setIncludeTax12] = useState(true);
  const [includeTax1, setIncludeTax1] = useState(true);
  const [rtsForecastPct, setRtsForecastPct] = useState<number>(20);
  const [rtsForecastInput, setRtsForecastInput] = useState('20');
  const [reportView, setReportView] = useState<'actual' | 'forecast'>('actual');
  const isForecastView = reportView === 'forecast';
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
  // Page-level dimension tab: the Store tab mirrors the whole page (same KPI
  // boxes, same math) with everything grouped and filtered by store instead of
  // product mapping — the API returns the identical response shape.
  const [dimension, setDimension] = useState<'product' | 'store'>('product');
  const [productPage, setProductPage] = useState(1);
  const [deliveryPage, setDeliveryPage] = useState(1);
  const [isReconciling, setIsReconciling] = useState(false);
  const {
    canShare,
    currentTeamId,
    openShareModal,
    saveShare,
    setShareOpen,
    shareLoading,
    shareOpen,
    shareSaving,
    shareSelected,
    shareTeams,
    toggleShareTeam,
  } = useAnalyticsShare('sales');
  const { addToast } = useToast();
  const rtsForecastSafe = getSafeRtsForecastPct(rtsForecastPct);
  const [sortKey, setSortKey] = useState<SalesProductsSortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [deliverySortKey, setDeliverySortKey] = useState<SalesDeliverySortKey | null>(null);
  const [deliverySortDir, setDeliverySortDir] = useState<'asc' | 'desc'>('desc');
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [isExportingXlsx, setIsExportingXlsx] = useState(false);
  useEffect(() => {
    let disposed = false;
    let requestVersion = 0;
    const verifyIdentity = async () => {
      const version = ++requestVersion;
      try {
        const { data: identity } = await apiClient.get('/auth/me');
        if (!disposed && version === requestVersion) {
          setHasSuperAdminIdentity(canViewCogsUnits(identity?.user));
        }
      } catch {
        if (!disposed && version === requestVersion) setHasSuperAdminIdentity(false);
      }
    };
    void verifyIdentity();
    window.addEventListener('focus', verifyIdentity);
    return () => {
      disposed = true;
      window.removeEventListener('focus', verifyIdentity);
    };
  }, []);
  useEffect(() => {
    if (!showUnits && sortKey === 'actual_units') setSortKey(null);
  }, [showUnits, sortKey]);
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
  const mappingSelectionKey = buildSalesMappingSelection(isAllMappingsMode, selectedMappings).key;
  const analyticsQueryKey = `${dimension}:${selectedTeamIds.join(',') || '__all_teams__'}:` + buildAnalyticsQueryKey(
    startDate,
    endDate,
    mappingSelectionKey,
    excludeCanceled,
    excludeRestocking,
    excludeAbandoned,
    excludeRts,
    excludeRepurchase,
    includeTax12,
    includeTax1,
  );
  useEffect(() => {
    const readTeams = () => {
      try {
        const next = parseSalesTeamSelection(window.localStorage.getItem('current_team_ids'), window.localStorage.getItem('current_team_id'));
        setSelectedTeamIds(prev => areArraysEqual(prev, next) ? prev : next);
      } catch { setSelectedTeamIds([]); }
    };
    readTeams();
    window.addEventListener('teamScopeChanged', readTeams);
    return () => window.removeEventListener('teamScopeChanged', readTeams);
  }, []);

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
        .filter((value) => DEFAULT_VISIBLE_KPI_KEYS.includes(value));

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
    setError(null);
    try {
      const currentSelected = selectedMappingsRef.current;
      const sendAll = isAllMappingsMode;
      const mappingSelection = buildSalesMappingSelection(sendAll, currentSelected);
      const params = new URLSearchParams();
      params.set('start_date', startDate);
      params.set('end_date', endDate);
      if (mappingSelection.mappings.length > 0) {
        mappingSelection.mappings.forEach((m) => params.append('mapping', m));
      } else if (mappingSelection.emptySelection) {
        params.set('mapping_selection', 'none');
      }
      params.set('exclude_cancel', String(excludeCanceled));
      params.set('exclude_restocking', String(excludeRestocking));
      params.set('exclude_abandoned', String(excludeAbandoned));
      params.set('exclude_rts', String(excludeRts));
      params.set('exclude_repurchase', String(excludeRepurchase));
      params.set('include_tax_12', String(includeTax12));
      params.set('include_tax_1', String(includeTax1));
      const res = dimension === 'store'
        ? await analyticsOverviewApi.getSalesStoreOverview<OverviewResponse>(params, request.signal)
        : await analyticsOverviewApi.getSalesOverview<OverviewResponse>(params, request.signal);
      if (!request.isLatest()) return;
      setData(res.data);
      setResolvedQueryKey(analyticsQueryKey);
      const optsList = res.data.filters.mappings || [];
      const normalized = optsList.map((m) => m.toLowerCase());
      setMappingOptions((prev) => (areArraysEqual(prev, normalized) ? prev : normalized));
      const nextDisplayMap = res.data.filters.mappingsDisplayMap || {};
      setMappingDisplayMap((prev) => (areRecordsEqual(prev, nextDisplayMap) ? prev : nextDisplayMap));
      if (sendAll) {
        setSelectedMappings((prev) => (areArraysEqual(prev, normalized) ? prev : normalized));
      } else {
        const bounded = currentSelected.filter((m) => normalized.includes(m));
        setSelectedMappings((prev) => (areArraysEqual(prev, bounded) ? prev : bounded));
      }
      syncDateRangeFromApi(res.data.selected.start_date, res.data.selected.end_date);
    } catch (error: unknown) {
      if (!request.isLatest()) return;
      setData(null);
      setResolvedQueryKey(analyticsQueryKey);
      setError(parseErrorMessage(error, 'Failed to load sales overview'));
    } finally {
      if (request.isLatest()) setIsLoading(false);
      request.finish();
    }
  }, [
    analyticsQueryKey,
    beginRequest,
    dimension,
    endDate,
    excludeAbandoned,
    excludeCanceled,
    excludeRestocking,
    excludeRts,
    excludeRepurchase,
    includeTax1,
    includeTax12,
    isAllMappingsMode,
    startDate,
    syncDateRangeFromApi,
  ]);

  useEffect(() => {
    fetchDataRef.current = fetchData;
  }, [fetchData]);

  const reconcileRange = async () => {
    if (!startDate || !endDate) return;
    setIsReconciling(true);
    setError(null);
    try {
      const res = await apiClient.post('/analytics/sales/reconcile', {
        start_date: startDate,
        end_date: endDate,
      });
      const errors = res?.data?.errors || [];
      if (errors.length > 0) {
        addToast('error', `Reconcile completed with ${errors.length} error${errors.length > 1 ? 's' : ''}`);
      } else {
        addToast('success', 'Reconcile completed successfully');
      }
      await fetchData();
    } catch (error: unknown) {
      const message = parseErrorMessage(error, 'Failed to reconcile sales data');
      setError(message);
      addToast('error', message);
    } finally {
      setIsReconciling(false);
    }
  };

  useEffect(() => {
    cancelRequest();
    setIsLoading(true);
    const timeoutId = window.setTimeout(() => {
      void fetchData();
    }, ANALYTICS_FILTER_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [cancelRequest, fetchData, mappingSelectionKey]);

  // Switching dimension swaps what the picker's options mean (mappings vs
  // stores), so selection state is cleared and the new overview refetched.
  const isFirstDimensionRender = useRef(true);
  useEffect(() => {
    if (isFirstDimensionRender.current) {
      isFirstDimensionRender.current = false;
      return;
    }
    setMappingOptions([]);
    setSelectedMappings([]);
    setIsAllMappingsMode(true);
    setTableSelection('products');
    setProductPage(1);
    setDeliveryPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimension]);

  useVisibleAutoRefresh(() => {
    void fetchData({ silent: true });
  });

  useWorkflowTenantEvent('marketing:updated', (payload) => {
    if (payload.source === 'reconcile_sales') return;
    fetchDataRef.current?.({ silent: true });
  });

  // Close popovers on outside click
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

  const mappingDisplay = (val: string) => mappingDisplayMap[val.toLowerCase()] || val;
  const mappingPickerOptions = mappingOptions.map((mapping) => ({
    value: mapping,
    label: toTitleCase(mappingDisplay(mapping)),
  }));
  const selectedMappingLabel =
    isAllMappingsMode
      ? (dimension === 'store' ? 'All stores' : 'All mappings')
      : `${selectedMappings.length} selected`;
  const isChecked = (norm: string) => selectedMappings.includes(norm);
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
    excludeAbandoned: excludeAbandoned,
    excludeRts,
  };
  const currentProjection = data ? forecastSalesKpis(data.kpis, data.counts, forecastOptions, rtsForecastSafe) : null;
  const previousProjection = data ? forecastSalesKpis(data.prevKpis, data.prevCounts, forecastOptions, rtsForecastSafe) : null;
  const computedKpis = data
    ? isForecastView && currentProjection ? forecastKpiValues(data.kpis, currentProjection) : {
        ...data.kpis,
        rts_pct: computeRtsPctFromCounts(data.counts),
        cm_rts_forecast: buildSalesKpiForecast(
          data.kpis, data.counts, forecastOptions, rtsForecastSafe,
        ).cmForecast,
      }
    : null;
  const computedPrevKpis = data
    ? isForecastView && previousProjection ? forecastKpiValues(data.prevKpis, previousProjection) : {
        ...data.prevKpis,
        rts_pct: computeRtsPctFromCounts(data.prevCounts),
        cm_rts_forecast: buildSalesKpiForecast(
          data.prevKpis, data.prevCounts, forecastOptions, rtsForecastSafe,
        ).cmForecast,
      }
    : null;

  const products = data?.products || [];
  const selectedCodFeeRate = data ? observedCodFeeRate(data.kpis) : Number.NaN;
  const sortableProducts: SalesProductRowItem[] = products.map((actualRow, index) => {
    const projection = isForecastView ? forecastSalesProduct(actualRow, forecastOptions, rtsForecastSafe, selectedCodFeeRate) : null;
    const row = projection ? forecastProductValues(actualRow, projection) : actualRow;
    const norm = (row.mapping || '__null__').toLowerCase();
    const display = row.mapping ? (mappingDisplayMap[norm] || row.mapping) : 'Unassigned';
    const forecast = projection ? {
      revenueAfterRts: projection.revenue, cmForecast: projection.margin,
      sf: projection.shipping, ff: projection.fulfillment, iF: projection.ifFees,
      codFeeDelivered: projection.codFees, cogsAdjusted: projection.cogs, cogsRts: 0,
    } : buildSalesProductForecast(row, forecastOptions, rtsForecastSafe);
    const { sf, ff, iF, codFeeDelivered, cogsAdjusted, cogsRts } = forecast;
    const deliveredCount = row.delivered_count ?? 0;
    const rtsCount = row.rts_count ?? 0;
    const rtsPct = isForecastView ? rtsForecastSafe : deliveredCount + rtsCount > 0 ? (rtsCount / (deliveredCount + rtsCount)) * 100 : 0;
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
          const r = item.row;
          switch (sortKey) {
            case 'index':
              return item.index;
            case 'product':
              return item.derived.display.toLowerCase();
            case 'revenue':
              return r.revenue ?? 0;
            case 'gross_sales':
              return r.gross_sales ?? 0;
            case 'cogs':
              return r.cogs ?? 0;
            case 'actual_units':
              return cogsUnitsValue(r.actual_units, reportView) ?? Number.NaN;
            case 'aov':
              return r.aov ?? 0;
            case 'cpp':
              return r.cpp ?? 0;
            case 'processed_cpp':
              return r.processed_cpp ?? 0;
            case 'ad_spend':
              return r.ad_spend ?? 0;
            case 'ar_pct':
              return r.ar_pct ?? 0;
            case 'rts_pct':
              return item.derived.rtsPct ?? 0;
            case 'profit_efficiency':
              return r.profit_efficiency ?? 0;
            case 'contribution_margin':
              return r.contribution_margin ?? 0;
            case 'cm_rts_forecast':
              return item.derived.forecast.cmForecast ?? 0;
            case 'net_margin':
              return r.net_margin ?? 0;
            default:
              return 0;
          }
        };
        const av = getValue(a);
        const bv = getValue(b);
        if (typeof av === 'string' || typeof bv === 'string') {
          const aStr = String(av);
          const bStr = String(bv);
          return (sortDir === 'asc' ? 1 : -1) * aStr.localeCompare(bStr);
        }
        if (!Number.isFinite(av) || !Number.isFinite(bv)) {
          if (!Number.isFinite(av) && !Number.isFinite(bv)) return 0;
          return Number.isFinite(av) ? -1 : 1;
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
        grossSales: isForecastView ? currentProjection?.orders ?? Number.NaN : data?.counts.purchases ?? 0,
        cogs: isForecastView
          ? sortableProducts.reduce((total, item) => total + item.row.cogs, 0)
          : products.reduce((total, row) => total + (row.cogs ?? 0), 0),
        ...(showUnits ? { units: cogsUnitsValue(computedKpis.actual_units, reportView) } : {}),
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
      ...(showUnits ? { units: cogsUnitsValue(item.row.actual_units, reportView) } : {}),
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
        view: reportView,
        entityLabel: dimension === 'store' ? 'Store' : 'Product',
        includeUnits: showUnits,
      });
      addToast('success', 'CSV export generated.');
    } catch (err) {
      console.error('Failed to export Sales Analytics CSV', err);
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
        view: reportView,
        entityLabel: dimension === 'store' ? 'Store' : 'Product',
        includeUnits: showUnits,
      });
      addToast('success', 'XLSX export generated.');
    } catch (err) {
      console.error('Failed to export Sales Analytics XLSX', err);
      addToast('error', 'Failed to export XLSX report.');
    } finally {
      setIsExportingXlsx(false);
    }
  };

  const deliveryStatuses = data?.deliveryStatuses || [];
  const deliveryRows: SalesDeliveryRowItem[] = deliveryStatuses.map((row, index) => {
    const norm = (row.mapping || '__null__').toLowerCase();
    const display = row.mapping ? (mappingDisplayMap[norm] || row.mapping) : 'Unassigned';
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

  const reportMetricDefinitions = isForecastView ? [
    { key: 'revenue', label: 'Forecast Revenue (₱)', format: 'currency', countKey: 'purchases', countLabel: 'Expected orders' },
    { key: 'cogs', label: 'Forecast COGS (₱)', format: 'currency' },
    { key: 'rts', label: 'Forecast RTS (₱)', format: 'currency', countKey: 'rts', countLabel: 'Expected returns' },
    { key: 'delivered', label: 'Forecast Delivered (₱)', format: 'currency', countKey: 'delivered', countLabel: 'Expected deliveries' },
  ] as typeof metricDefinitions : metricDefinitions;
  const forecastCounts = (projection: typeof currentProjection) => ({
    purchases: projection?.orders ?? Number.NaN,
    delivered: projection?.orders ?? Number.NaN,
    rts: projection?.rtsOrders ?? Number.NaN,
  });
  const metricValues = data
    ? reportMetricDefinitions.map((def) => {
        const current = computedKpis?.[def.key] ?? 0;
        const previous = computedPrevKpis?.[def.key] ?? 0;
        const delta = formatDeltaPercent(current, previous);
        const countCurrent = def.countKey ? isForecastView
          ? forecastCounts(currentProjection)[def.countKey as 'purchases' | 'delivered' | 'rts']
          : data.counts?.[def.countKey] ?? 0 : null;
        const countPrev = def.countKey ? isForecastView
          ? forecastCounts(previousProjection)[def.countKey as 'purchases' | 'delivered' | 'rts']
          : data.prevCounts?.[def.countKey] ?? 0 : null;
        const countDelta = def.countKey ? formatDeltaPercent(countCurrent ?? 0, countPrev ?? 0) : null;
        const statusCountKey =
          def.countKey && def.countKey !== 'purchases' ? def.countKey : null;
        const isStatusMetric = !isForecastView && statusCountKey !== null;
        const statusCount =
          !isForecastView && statusCountKey
            ? data.statusDistribution?.[statusCountKey] ?? countCurrent ?? 0
            : countCurrent;
        const statusShare =
          isStatusMetric && (data.statusDistribution?.total ?? 0) > 0
            ? ((statusCount ?? 0) / data.statusDistribution.total) * 100
            : isStatusMetric
              ? 0
              : null;
        return {
          ...def,
          current,
          previous,
          delta,
          countCurrent: statusCount,
          countPrev,
          countDelta,
          isStatusMetric,
          statusShare,
        };
      })
    : reportMetricDefinitions.map((def) => ({
        ...def,
        current: 0,
        previous: 0,
        delta: null as number | null,
        countCurrent: def.countKey ? 0 : null,
        countPrev: def.countKey ? 0 : null,
        countDelta: null as number | null,
        isStatusMetric: false,
        statusShare: null as number | null,
      }));
  const visibleMetricValues = metricValues.filter((metric) =>
    isForecastView || visibleKpiKeys.includes(String(metric.key)),
  );

  const tableOptions: AnalyticsTableSelectorOption<'products' | 'delivery'>[] = [
    { key: 'products', label: `${isForecastView ? 'Forecast' : 'Revenue'} per ${dimension === 'store' ? 'Store' : 'Product'}` },
    { key: 'delivery', label: isForecastView ? 'Delivery Status (Actual)' : 'Delivery Status' },
  ];

  const leftCard = visibleMetricValues.find((m) => m.key === 'revenue');
  const rightCard = visibleMetricValues.find((m) => m.key === 'delivered');
  const middleCards = visibleMetricValues.filter(
    (m) => m.key !== 'revenue' && m.key !== 'delivered',
  );

  const secondaryCards =
    data
      ? secondaryMetricDefinitions.filter(def => !isForecastView || ![
          'cm_rts_forecast', 'cancellation_rate_pct', 'processed_cpp', 'conversion_rate',
        ].includes(def.key)).map((def) => {
          const current = computedKpis?.[def.key] ?? 0;
          const previous = computedPrevKpis?.[def.key] ?? 0;
          const delta = formatDeltaPercent(current, previous);
          const label =
            isForecastView && def.key === 'net_margin' ? 'Forecast Net (before overhead)'
              : isForecastView && def.key === 'ad_spend' ? 'Observed Ad Spend (₱)'
              : isForecastView ? `Forecast ${def.label}`
              : def.key === 'cm_rts_forecast'
              ? `CM (RTS ${rtsForecastSafe}% )`
              : def.label;
          return {
            key: def.key,
            label,
            format: def.format,
            current,
            previous,
            delta,
            countCurrent: null,
            countPrev: null,
            countDelta: null,
            isStatusMetric: false,
            statusShare: null,
          };
        })
      : [];
  const visibleSecondaryCards = secondaryCards.filter((metric) =>
    isForecastView || visibleKpiKeys.includes(String(metric.key)),
  );
  const leftSecondary = visibleSecondaryCards.find((m) => m.key === 'cm_rts_forecast');
  const fixedRightSecondary = visibleSecondaryCards.filter(
    (m) => m.key === 'net_margin',
  );
  const middleSecondary = visibleSecondaryCards.filter(
    (m) =>
      m.key !== 'cm_rts_forecast' &&
      m.key !== 'net_margin',
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
    'restocking_cod',
    'confirmed',
    'waiting_pickup',
    'canceled',
    'shipped',
    'rts',
    'delivered',
  ]
    .map((key) => buildVisibilityOption(key, 'Primary'))
    .concat(
      [
        'cm_rts_forecast',
        'ad_spend',
        'ar_pct',
        'cancellation_rate_pct',
        'aov',
        'cpp',
        'processed_cpp',
        'rts_pct',
        'conversion_rate',
        'profit_efficiency',
        'contribution_margin',
        'net_margin',
      ].map((key) => buildVisibilityOption(key, 'Secondary')),
    )
    .filter((option): option is NonNullable<typeof option> => option !== null);

  const buildCmTooltip = (kpis: OverviewResponse['kpis'] | undefined): ReactNode | null => {
    if (!kpis) return null;
    const nf = (v: number) => formatMetricValue(v, 'currency');
    const neg = (v: number) => (v === 0 ? nf(0) : `- ${nf(Math.abs(v))}`);
    const pos = (v: number) => (v === 0 ? nf(0) : `+ ${nf(Math.abs(v))}`);
    const fulfillment = (kpis.sf_fees ?? 0) + (kpis.ff_fees ?? 0) + (kpis.if_fees ?? 0);
    const canceledCodAdj = excludeCanceled ? kpis.canceled_cod ?? 0 : 0;
    const restockingCodAdj = excludeRestocking ? kpis.restocking_cod ?? 0 : 0;
    const rtsCodAdj = excludeRts ? kpis.rts_cod ?? 0 : 0;
    const excludedCogsCanceled = excludeCanceled ? kpis.cogs_canceled ?? 0 : 0;
    const excludedCogsRestocking = excludeRestocking ? kpis.cogs_restocking ?? 0 : 0;
    const cogsRaw = kpis.cogs ?? 0;
    const excludedCogsAbandoned = excludeAbandoned ? kpis.cogs_abandoned ?? 0 : 0;
    const excludedCogsRts = excludeRts ? kpis.cogs_rts ?? 0 : 0;
    const cogsIncluded = kpis.cogs_adjusted ??
      cogsRaw - excludedCogsCanceled - excludedCogsRestocking - excludedCogsAbandoned - excludedCogsRts;
    const rtsCogsCredit = kpis.cogs_rts_credit ?? (excludeRts ? 0 : kpis.cogs_rts ?? 0);
    const filtersLabel = [
      `${startDate} → ${endDate}`,
      `${selectedMappings.length || 0}/${mappingOptions.length || 0} mappings`,
      `Exclude: cancel ${excludeCanceled ? 'ON' : 'OFF'}, restocking ${excludeRestocking ? 'ON' : 'OFF'}, abandoned ${excludeAbandoned ? 'ON' : 'OFF'}, RTS ${excludeRts ? 'ON' : 'OFF'}, repurchase ${excludeRepurchase ? 'ON' : 'OFF'}`,
    ].join(' • ');

    return (
      <div className="space-y-1">
        <p className="font-semibold text-slate-800">Contribution Margin inputs</p>
        <div className="flex justify-between text-slate-800">
          <span>Gross COD</span>
          <span>{nf(kpis.gross_cod ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-700">
          <span className="flex items-center gap-1">
            Canceled COD
          </span>
          <span>{neg(canceledCodAdj)}</span>
        </div>
        <div className="flex justify-between text-slate-700">
          <span className="flex items-center gap-1">
            Restocking COD
          </span>
          <span>{neg(restockingCodAdj)}</span>
        </div>
        <div className="flex justify-between text-slate-700">
          <span className="flex items-center gap-1">
            RTS COD
          </span>
          <span>{neg(rtsCodAdj)}</span>
        </div>
        <div className="flex justify-between text-slate-800 border-t border-slate-100 pt-1">
          <span>Revenue after adjustments</span>
          <span>{nf(kpis.revenue ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800 border-t border-slate-100 pt-1">
          <span>Fulfillment (SF+FF+IF)</span>
          <span>{neg(fulfillment)}</span>
        </div>
        <div className="flex justify-between text-slate-600 text-xs">
          <span>SF Fees</span>
          <span>{neg(kpis.sf_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-600 text-xs">
          <span>FF Fees</span>
          <span>{neg(kpis.ff_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-600 text-xs">
          <span>IF Fees</span>
          <span>{neg(kpis.if_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800 border-t border-slate-100 pt-1">
          <span>COD Fee</span>
          <span>{neg(kpis.cod_fee ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>Ad Spend</span>
          <span>{neg(kpis.ad_spend ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>COGS (raw)</span>
          <span>{neg(cogsRaw)}</span>
        </div>
        <div className="flex justify-between text-slate-700 text-[12px]">
          <span>- COGS Canceled</span>
          <span>{pos(excludedCogsCanceled)}</span>
        </div>
        <div className="flex justify-between text-slate-700 text-[12px]">
          <span>- COGS Restocking</span>
          <span>{pos(excludedCogsRestocking)}</span>
        </div>
        <div className="flex justify-between text-slate-700 text-[12px]">
          <span>- COGS Abandoned</span>
          <span>{pos(excludedCogsAbandoned)}</span>
        </div>
        <div className="flex justify-between text-slate-700 text-[12px]">
          <span>- COGS RTS</span>
          <span>{pos(excludedCogsRts)}</span>
        </div>
        <div className="flex justify-between text-slate-800 border-t border-slate-100 pt-1">
          <span>COGS used in CM</span>
          <span>{neg(cogsIncluded)}</span>
        </div>
        <div className="flex justify-between text-slate-700 text-[12px]">
          <span>+ RTS COGS</span>
          <span>{pos(rtsCogsCredit)}</span>
        </div>
        <div className="flex justify-between text-slate-900 border-t border-slate-200 pt-1 font-semibold">
          <span>Contribution Margin</span>
          <span>{nf(kpis.contribution_margin ?? 0)}</span>
        </div>
        <p className="text-xs text-slate-500">{filtersLabel}</p>
      </div>
    );
  };

  const buildNmTooltip = (kpis: OverviewResponse['kpis'] | undefined): ReactNode | null => {
    if (!kpis) return null;
    const nf = (v: number) => formatMetricValue(v, 'currency');
    const neg = (v: number) => (v === 0 ? nf(0) : `- ${nf(Math.abs(v))}`);
    const filtersLabel = [
      `${startDate} → ${endDate}`,
      `${selectedMappings.length || 0}/${mappingOptions.length || 0} mappings`,
      `Exclude: cancel ${excludeCanceled ? 'ON' : 'OFF'}, restocking ${excludeRestocking ? 'ON' : 'OFF'}, abandoned ${excludeAbandoned ? 'ON' : 'OFF'}, RTS ${excludeRts ? 'ON' : 'OFF'}, repurchase ${excludeRepurchase ? 'ON' : 'OFF'}`,
    ].join(' • ');

    return (
      <div className="space-y-1">
        <p className="font-semibold text-slate-800">Net Margin inputs</p>
        <div className="flex justify-between text-slate-800">
          <span>Delivered COD</span>
          <span>{nf(kpis.delivered ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>SF SDR Fees</span>
          <span>{neg(kpis.sf_sdr_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>FF SDR Fees</span>
          <span>{neg(kpis.ff_sdr_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>IF SDR Fees</span>
          <span>{neg(kpis.if_sdr_fees ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>COD Fee (Delivered)</span>
          <span>{neg(kpis.cod_fee_delivered ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>COGS Delivered</span>
          <span>{neg(kpis.cogs_delivered ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>Ad Spend</span>
          <span>{neg(kpis.ad_spend ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-900 border-t border-slate-200 pt-1 font-semibold">
          <span>Net Margin</span>
          <span>{nf(kpis.net_margin ?? 0)}</span>
        </div>
        <p className="text-xs text-slate-500">{filtersLabel}</p>
      </div>
    );
  };

  const buildCmRtsTooltip = (kpis: OverviewResponse['kpis'] | undefined): ReactNode | null => {
    if (!kpis) return null;
    const nf = (v: number) => formatMetricValue(v, 'currency');
    const neg = (v: number) => (v === 0 ? nf(0) : `- ${nf(Math.abs(v))}`);
    const pos = (v: number) => (v === 0 ? nf(0) : `+ ${nf(Math.abs(v))}`);
    const forecast = buildSalesKpiForecast(
      kpis, data?.counts ?? {}, forecastOptions, rtsForecastSafe,
    );
    const {
      cogsTotal, cogsCanceled, cogsRestocking, cogsAdjusted,
      purchases: purchasesForCmRts, aov: aovForCmRts, revenueBase: revenueBaseForCmRts,
    } = forecast;
    const filtersLabel = [
      `${startDate} → ${endDate}`,
      `${selectedMappings.length || 0}/${mappingOptions.length || 0} mappings`,
      `Exclude: cancel ${excludeCanceled ? 'ON' : 'OFF'}, restocking ${excludeRestocking ? 'ON' : 'OFF'}, abandoned ${excludeAbandoned ? 'ON' : 'OFF'}, RTS ${excludeRts ? 'ON' : 'OFF'}, repurchase ${excludeRepurchase ? 'ON' : 'OFF'}`,
      `RTS %: ${rtsForecastSafe}`,
    ].join(' • ');

    return (
      <div className="space-y-1">
        <p className="font-semibold text-slate-800">CM (RTS {rtsForecastSafe}%) inputs</p>
        <div className="flex justify-between text-slate-800">
          <span>Purchases (adj)</span>
          <span>{purchasesForCmRts.toFixed(0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>AOV (adj)</span>
          <span>{nf(aovForCmRts)}</span>
        </div>
        <div className="flex justify-between text-slate-800 border-t border-slate-100 pt-1">
          <span>Revenue base (AOV × purchases)</span>
          <span>{nf(revenueBaseForCmRts)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>RTS forecast ({rtsForecastSafe}%)</span>
          <span>{neg(revenueBaseForCmRts * forecast.rtsFraction)}</span>
        </div>
        <div className="flex justify-between text-slate-800 border-t border-slate-100 pt-1">
          <span>Revenue after RTS</span>
          <span>{nf(forecast.revenueAfterRts)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>Ad Spend</span>
          <span>{neg(kpis.ad_spend ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>Fulfillment (SF+FF+IF)</span>
          <span>{neg((kpis.sf_fees ?? 0) + (kpis.ff_fees ?? 0) + (kpis.if_fees ?? 0))}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>COD Fee (Delivered)</span>
          <span>{neg(kpis.cod_fee_delivered ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>COGS (raw)</span>
          <span>{neg(cogsTotal)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>Excluded COGS Canceled</span>
          <span>{pos(cogsCanceled)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>Excluded COGS Restocking</span>
          <span>{pos(cogsRestocking)}</span>
        </div>
        <div className="flex justify-between text-slate-800 border-t border-slate-100 pt-1">
          <span>COGS (adjusted)</span>
          <span>{neg(cogsAdjusted)}</span>
        </div>
        <div className="flex justify-between text-slate-800">
          <span>RTS COGS</span>
          <span>{pos(kpis.cogs_rts ?? 0)}</span>
        </div>
        <div className="flex justify-between text-slate-900 border-t border-slate-200 pt-1 font-semibold">
          <span>CM (RTS {rtsForecastSafe}%)</span>
          <span>{nf(forecast.cmForecast)}</span>
        </div>
        <p className="text-xs text-slate-500">{filtersLabel}</p>
      </div>
    );
  };

  const handleWheelScroll = (e: React.WheelEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const hasHorizontalOverflow = container.scrollWidth > container.clientWidth + 1;
    if (!hasHorizontalOverflow) return;

    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      container.scrollLeft += e.deltaY;
    }
  };

  const renderCard = (m: (typeof metricValues)[number]) => {
    const cardLoading = isResultPending;
    const tooltip =
      isForecastView ? (
        <div className="space-y-1">
          <p>Completed-cohort forecast at {rtsForecastSafe}% RTS.</p>
          <p>Revenue and goods cost use {100 - rtsForecastSafe}% successful deliveries. Returned goods are assumed fully recoverable.</p>
          <p>Observed advertising and the existing shipping, fulfillment and IF fee estimates stay fixed. COD fees use the selected cohort&apos;s observed delivered fee/revenue rate.</p>
          <p>Net before overhead equals contribution margin on this expense basis. Missing evidence is shown as —.</p>
        </div>
      ) : m.key === 'cm_rts_forecast'
        ? buildCmRtsTooltip(data?.kpis)
        : m.key === 'contribution_margin'
          ? buildCmTooltip(data?.kpis)
          : m.key === 'net_margin'
            ? buildNmTooltip(data?.kpis)
            : m.key === 'ar_pct'
              ? null
              : null;

    return (
      <AnalyticsMetricCard
        key={m.key}
        loading={cardLoading}
        label={m.label}
        value={m.current}
        format={m.format}
        precision={m.format === 'percent' ? 1 : 2}
        delta={m.delta}
        deltaDisplay="trend"
        showDelta={!m.isStatusMetric}
        count={
          m.countKey
            ? {
                label: isForecastView ? 'expected' : 'ord',
                value: m.countCurrent ?? 0,
                precision: isForecastView ? 2 : 0,
                delta: m.countDelta ?? null,
                percentage: m.isStatusMetric ? m.statusShare : undefined,
              }
            : undefined
        }
        tooltip={tooltip}
        tooltipMode={m.key === 'contribution_margin' ? 'popover' : 'hover'}
        className="w-full xl:min-w-[190px] xl:w-auto"
      />
    );
  };

  return (
    <div className="space-y-5">
      <div className="overflow-x-auto">
        <div className="flex min-w-max gap-6 border-b border-slate-200 sm:min-w-0 dark:border-border">
          {([['product', 'Product'], ['store', 'Store']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDimension(key)}
              className={`whitespace-nowrap pb-3 text-sm font-semibold transition-colors ${
                dimension === key
                  ? 'border-b-2 border-primary text-orange-600'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 md:flex-row md:items-end md:justify-between dark:border-border">
        <div className="space-y-1.5">
          <p className="text-xs-tight font-semibold uppercase tracking-[0.2em] text-primary">
            Analytics
          </p>
          <div className="space-y-0.5">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Business Performance
            </h1>
            <p className="text-sm-custom text-slate-500 dark:text-slate-300">
              {dimension === 'store' ? 'Monitor sales performance by store.' : 'Monitor sales performance by mapping.'}
            </p>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 p-1 dark:border-border" aria-label="Report view">
          {(['actual', 'forecast'] as const).map(view => (
            <button key={view} type="button" aria-pressed={reportView === view}
              onClick={() => {
                setReportView(view); setProductPage(1); setTableSelection('products');
                if (view === 'forecast' && (sortKey === 'processed_cpp' || sortKey === 'cm_rts_forecast')) {
                  setSortKey('contribution_margin');
                }
              }}
              className={`rounded-md px-4 py-2 text-sm font-medium ${reportView === view ? 'bg-primary text-white' : 'text-foreground'}`}>
              {view === 'actual' ? 'Actual' : 'Forecast'}
            </button>
          ))}
        </div>
        {isForecastView && (
          <p className="text-sm text-slate-600 dark:text-slate-300" aria-live="polite">
            Forecast at {rtsForecastSafe}% RTS · {100 - rtsForecastSafe}% expected successful deliveries
          </p>
        )}
      </div>
      {isForecastView && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-slate-700 dark:border-amber-800 dark:bg-amber-950 dark:text-slate-200">
          <p>This projects the selected cohort after the canceled, restocking, abandoned and repurchase exclusions. The RTS assumption replaces its recorded RTS outcome; the Exclude RTS toggle applies to Actual view.</p>
          <p className="mt-1">Returned goods are assumed fully recoverable. Advertising and the existing shipping, fulfillment and IF fee estimates stay fixed. COD fees use the selected cohort&apos;s blended delivered fee/revenue rate. Net before overhead equals contribution margin because both include these same costs.</p>
          {!Number.isFinite(selectedCodFeeRate) && <p className="mt-1 font-medium">No usable delivered COD-fee rate is available for this selection. Margins for positive forecast sales are unavailable (—).</p>}
          <p className="mt-1">Forecasts use the saved cost evidence and do not correct missing source costs. Delivery Status remains the recorded lifecycle breakdown.</p>
        </div>
      )}

      <DashboardSection
        title={isForecastView ? 'Sales Forecast' : 'Sales Monitoring'}
        icon={<ShoppingBag className="panel-icon" />}
        meta={`Last updated: ${data?.lastUpdatedAt ? new Date(data.lastUpdatedAt).toLocaleString() : '-'}`}
        className=""
        contentClassName="space-y-5"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-stretch">
              <AnalyticsMultiSelectPicker
                className="relative z-30 [&>button]:h-10 [&>button]:rounded-r-none [&>button]:rounded-l-xl [&>button]:border-r-0 [&>button]:border-slate-200"
                selectedLabel={selectedMappingLabel}
                selectTitle={dimension === 'store' ? 'Select stores' : 'Select mappings'}
                options={mappingPickerOptions}
                allChecked={isAllMappingsMode || (mappingOptions.length > 0 && selectedMappings.length === mappingOptions.length)}
                isChecked={isChecked}
                onToggleAll={(checked) => {
                  setIsAllMappingsMode(checked);
                  setSelectedMappings(checked ? mappingOptions : []);
                }}
                onToggle={(value) => {
                  setIsAllMappingsMode(false);
                  setSelectedMappings((prev) =>
                    prev.includes(value)
                      ? prev.filter((entry) => entry !== value)
                      : [...prev, value],
                  );
                }}
                onOnly={(value) => {
                  setIsAllMappingsMode(false);
                  setSelectedMappings([value]);
                }}
                onClear={() => { setIsAllMappingsMode(false); setSelectedMappings([]); }}
              />
              <div className="relative" ref={filterMenuContentRef}>
                <button
                  type="button"
                  onClick={() => setShowFilterMenu((p) => !p)}
                className="inline-flex h-10 items-center justify-center rounded-r-xl rounded-l-none border border-slate-200 bg-white px-3 text-slate-600 hover:border-orange-200 hover:text-orange-700 dark:border-border dark:bg-transparent dark:text-foreground"
                  aria-label="Filters"
                >
                  <Filter className="h-4 w-4" />
                </button>
                {showFilterMenu && (
                  <div className="absolute right-0 z-30 mt-2 w-60 space-y-3 rounded-xl border border-slate-200 bg-surface p-3 shadow-lg dark:border-border">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                        checked={excludeCanceled}
                        onChange={(e) => setExcludeCanceled(e.target.checked)}
                      />
                      <span className="text-sm text-foreground">Exclude Canceled</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                        checked={excludeRestocking}
                        onChange={(e) => setExcludeRestocking(e.target.checked)}
                      />
                      <span className="text-sm text-foreground">Exclude Restocking</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                        checked={excludeAbandoned}
                        onChange={(e) => setExcludeAbandoned(e.target.checked)}
                      />
                      <span className="text-sm text-foreground">Exclude Abandoned</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                        checked={excludeRts}
                        disabled={isForecastView}
                        onChange={(e) => setExcludeRts(e.target.checked)}
                      />
                      <span className="text-sm text-foreground">Exclude RTS{isForecastView ? ' (Actual only)' : ''}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                        checked={excludeRepurchase}
                        onChange={(e) => setExcludeRepurchase(e.target.checked)}
                      />
                      <span className="text-sm text-foreground">Exclude Repurchase</span>
                    </label>
                    <div className="my-1 h-px bg-slate-100 dark:bg-border" />
                    <div className="space-y-1">
                      <label className="flex items-center justify-between text-sm text-foreground">
                        <span>Forecast RTS %</span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={rtsForecastInput}
                          onChange={(e) => {
                            setRtsForecastInput(e.target.value);
                            const val = parseFloat(e.target.value);
                            if (Number.isFinite(val)) setRtsForecastPct(Math.min(100, Math.max(0, val)));
                          }}
                          onBlur={() => setRtsForecastInput(String(rtsForecastSafe))}
                          className="w-20 rounded border border-slate-200 px-2 py-1 text-sm text-foreground focus:border-indigo-300 focus:outline-none dark:border-border dark:bg-surface"
                        />
                      </label>
                      <p className="text-xs text-slate-500 dark:text-slate-300">
                        {isForecastView ? 'Updates projected revenue, COGS and margins throughout this view.' : 'Updates the CM (RTS %) scenario. Select Forecast to project the full report.'}
                      </p>
                    </div>
                    <div className="my-1 h-px bg-slate-100 dark:bg-border" />
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                        checked={includeTax12}
                        onChange={(e) => setIncludeTax12(e.target.checked)}
                      />
                      <span className="text-sm text-foreground">Include 12% Ads Tax</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-orange-200"
                        checked={includeTax1}
                        onChange={(e) => setIncludeTax1(e.target.checked)}
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
                  inputClassName={`h-10 cursor-pointer rounded-xl border border-slate-200 bg-white p-0 text-transparent caret-transparent placeholder:text-transparent shadow-sm focus:border-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-100 dark:!border-border dark:!bg-transparent dark:!text-transparent transition-[width] duration-300 ease-out ${
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
                            : 'max-w-[148px] sm:max-w-[184px] translate-x-0 opacity-100'
                        }`}
                      >
                        {salesDateRangeButtonLabel}
                      </span>
                    </span>
                  )}
                  toggleClassName="absolute inset-0 flex items-center justify-start px-3 text-slate-600 border rounded-xl border-slate-200 hover:text-orange-700 cursor-pointer dark:bg-surface dark:text-foreground dark:border-border"
                  placeholder=" "
                />
              </div>
              <div className="relative flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={reconcileRange}
                  disabled={isReconciling}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-surface text-slate-600 dark:text-foreground dark:border-border hover:border-slate-300 disabled:opacity-60"
                  aria-label="Reconcile date range"
                  title="Reconcile date range"
                >
                  <RefreshCw className={`h-4 w-4 ${isReconciling ? 'animate-spin' : ''}`} />
                </button>
                {!isForecastView && <button
                  type="button"
                  onClick={() => setShowKpiVisibilityModal(true)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-surface text-slate-600 dark:text-foreground dark:border-border hover:border-slate-300"
                  aria-label="Show or hide KPI boxes"
                  title="Show or hide KPI boxes"
                >
                  <Columns className="h-4 w-4" />
                </button>}
                {canShare && (
                  <button
                    type="button"
                    onClick={openShareModal}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-surface text-slate-600 dark:text-foreground dark:border-border hover:border-slate-300"
                    aria-label="Share analytics"
                  >
                    <Share2 className="h-4 w-4" />
                  </button>
                )}
              </div>
          </div>
        </div>

        {error && (
          <AlertBanner tone="error" message={error} className="mt-4" />
        )}
        {selectedTeamIds.length > 0 && data?.teamSpendCoverage &&
          (data.teamSpendCoverage.current.unassignedSpend > 0 || data.teamSpendCoverage.previous.unassignedSpend > 0) && (
          <AlertBanner
            tone="warning"
            message="Some ad spend has no confirmed team and appears in All teams only. Selected-team margins exclude that unassigned spend."
            className="mt-4"
          />
        )}
        {dimension === 'store' && data?.coverage && (
          data.coverage.ambiguousShopCount > 0 || data.coverage.unattributedAdRows > 0 || data.coverage.previousUnattributedAdRows > 0 ||
          data.coverage.unknownSelectedStoreCount > 0 || data.coverage.zeroCogsOrderCount > 0 || data.coverage.hasCanonicalDifferences
        ) && (
          <AlertBanner
            tone="warning"
            message={[
              'Store revenue and COGS use saved POS orders for each shop.',
              data.coverage.zeroCogsOrderCount > 0
                ? `${data.coverage.zeroCogsOrderCount} nonvoid, nondeleted orders have saved COGS of zero across the active shops in the selected team scope in the current and previous periods, including orders excluded by the current filters. A saved zero alone does not prove a missing catalog cost.` : '',
              data.coverage.ambiguousShopCount > 0
                ? `Across the current and previous periods, ${data.coverage.ambiguousOrderCount} orders have conflicting store ownership and remain under Unattributed.` : '',
              data.coverage.unattributedAdRows > 0 || data.coverage.previousUnattributedAdRows > 0
                ? 'Some ad spend in the current or previous period has no unique store owner and remains under Unattributed; individual store margins may therefore exclude that spend.' : '',
              data.coverage.unknownSelectedStoreCount > 0
                ? 'A selected store is outside the active reporting population.' : '',
              data.coverage.hasCanonicalDifferences
                ? 'Saved-order components differ from reconciled totals, which can include report lag and fee rounding. This view uses the saved orders and fee formulas per shop and day.' : '',
            ].filter(Boolean).join(' ')}
            className="mt-4"
          />
        )}

        <p className="text-xs text-slate-500 dark:text-slate-300">
          {isForecastView
            ? 'Projected deliveries and RTS complete the filtered order cohort. Expected order counts may be fractional.'
            : 'Status cards keep every lifecycle status visible for comparison. Exclude Repurchase still applies; the other exclusions adjust revenue, orders and COGS.'}
        </p>
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
                      {middleCards.map((m) => renderCard(m))}
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
                      {middleSecondary.map((m) => renderCard(m))}
                    </div>
                  </div>
                  {fixedRightSecondary.length > 0 && (
                    <div className="flex w-full flex-col gap-3 xl:w-auto xl:flex-row">
                      {fixedRightSecondary.map((m) => renderCard(m))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </DashboardSection>

      {/* Revenue per Product / Delivery Status */}
      <DashboardSection
        title={tableSelection === 'delivery' && isForecastView ? 'Recorded Delivery Status' : isForecastView ? 'Forecast Breakdown' : 'Sales Breakdown'}
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
                className='btn-icon'
              >
                Export CSV
              </Button>
              <Button
                size="sm"
                iconLeft={<FileSpreadsheet className="h-4 w-4" />}
                onClick={() => void handleExportProductsXlsx()}
                disabled={isResultPending || exportableProducts.length === 0}
                loading={isExportingXlsx}
                className='btn-icon'
              >
                Export XLSX
              </Button>
            </div>
          )}
        </div>

        {tableSelection === 'delivery' && (
          <p className="text-xs text-slate-500 dark:text-slate-300">Lifecycle breakdown includes every status and follows the selected repurchase scope.</p>
        )}
        {tableSelection === 'products' ? (
          <AnalyticsSalesProductsTable
            isLoading={isResultPending}
            entityLabel={dimension === 'store' ? 'Store' : 'Product'}
            productStart={productStart}
            productEnd={productEnd}
            totalProducts={totalProducts}
            onPrevious={() => setProductPage((p) => Math.max(1, p - 1))}
            onNext={() => setProductPage((p) => Math.min(totalProductPages, p + 1))}
            canPrevious={productCanPrev}
            canNext={productCanNext}
            pageSize={pageSize}
            productPage={productPage}
            totalProductPages={totalProductPages}
            rtsForecastSafe={rtsForecastSafe}
            reportView={reportView}
            showUnits={showUnits}
            rows={pagedProducts}
            sourceCount={products.length}
            totals={productTotals}
            renderSortLabel={renderSortLabel}
          />
        ) : (
          <AnalyticsSalesDeliveryTable
            isLoading={isResultPending}
            deliveryStart={deliveryStart}
            deliveryEnd={deliveryEnd}
            totalDelivery={totalDelivery}
            onPrevious={() => setDeliveryPage((p) => Math.max(1, p - 1))}
            onNext={() => setDeliveryPage((p) => Math.min(totalDeliveryPages, p + 1))}
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

      <AnalyticsShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        title="Share Sales Analytics"
        loading={shareLoading}
        saving={shareSaving}
        teams={shareTeams}
        currentTeamId={currentTeamId}
        selectedTeamIds={shareSelected}
        onToggleTeam={toggleShareTeam}
        onSave={saveShare}
      />
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
        onSelectAll={() => setVisibleKpiKeys(DEFAULT_VISIBLE_KPI_KEYS)}
        onResetDefaults={() => setVisibleKpiKeys(DEFAULT_VISIBLE_KPI_KEYS)}
      />

    </div>
  );
}

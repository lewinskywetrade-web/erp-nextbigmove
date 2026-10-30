'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { manilaToday } from '../../creative-agent/advertising/_utils/manila-date';
import { fetchCeoDashboard } from '../_services/ceo-dashboard.service';
import { useLiveReportRefresh } from '../../analytics/_hooks/use-live-report-refresh';
import type { CeoDashboardParams, CeoDashboardResponse } from '../_types/ceo-dashboard';

/** Month to date, in the tenant's timezone — the reference's default lens. */
function buildDefaultParams(): CeoDashboardParams {
  const today = manilaToday();
  return { startDate: `${today.slice(0, 7)}-01`, endDate: today, accountId: '', shopIds: [] };
}

export function useCeoDashboardController() {
  const [params, setParams] = useState<CeoDashboardParams>(buildDefaultParams);
  const [data, setData] = useState<CeoDashboardResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Only the newest request may write state.
  const requestSeq = useRef(0);
  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    const seq = ++requestSeq.current;
    if (!options.silent) {
      setIsLoading(true);
      setError(null);
    }
    try {
      const result = await fetchCeoDashboard(params);
      if (seq === requestSeq.current) {
        setData(result);
        setError(null);
      }
    } catch (loadError) {
      // A failed background refresh keeps the figures already on screen.
      if (seq === requestSeq.current && !options.silent) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load the dashboard.');
      }
    } finally {
      if (seq === requestSeq.current && !options.silent) setIsLoading(false);
    }
  }, [params]);

  useEffect(() => { void load(); }, [load]);

  // New orders rebuild the rollups within seconds; pick them up automatically.
  useLiveReportRefresh(() => { void load({ silent: true }); }, { minIntervalMs: 20_000 });

  // Changing the date range can drop stores out of the option list. A selection
  // left pointing at one of them would silently filter every figure to nothing,
  // so stale ids are pruned once the new options arrive.
  useEffect(() => {
    const options = data?.filters.stores;
    if (!options) return;
    setParams((current) => {
      if (!current.shopIds.length) return current;
      const allowed = new Set(options.map((option) => option.value));
      const next = current.shopIds.filter((id) => allowed.has(id));
      if (next.length === current.shopIds.length) return current;
      return { ...current, shopIds: next };
    });
  }, [data]);

  const updateParams = useCallback((patch: Partial<CeoDashboardParams>) => {
    setParams((current) => ({ ...current, ...patch }));
  }, []);

  return { params, data, isLoading, error, updateParams, retry: load };
}

import { useEffect, useRef } from 'react';
import { useWorkflowTenantEvent } from './use-workflow-tenant-event';
import { useVisibleAutoRefresh } from './use-visible-auto-refresh';

/**
 * Silently refreshes a report when the server announces rebuilt rollups
 * (`marketing:updated`, emitted after each order-sync reconcile), throttled so
 * bursts of order updates cause at most one refetch per `minIntervalMs`, and
 * also polls while the tab is visible as a fallback. Refreshes when the tab
 * becomes visible again after an event arrived in the background.
 */
export function useLiveReportRefresh(
  refresh: () => void,
  { minIntervalMs = 15_000, pollIntervalMs = 60_000, enabled = true } = {},
) {
  const refreshRef = useRef(refresh);
  const lastRunRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const missedWhileHiddenRef = useRef(false);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const run = () => {
    lastRunRef.current = Date.now();
    refreshRef.current();
  };

  const schedule = () => {
    if (!enabled || typeof window === 'undefined') return;
    if (document.visibilityState !== 'visible') {
      missedWhileHiddenRef.current = true;
      return;
    }
    if (timerRef.current !== null) return;
    const wait = Math.max(0, lastRunRef.current + minIntervalMs - Date.now());
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      run();
    }, wait);
  };

  useWorkflowTenantEvent('marketing:updated', (payload) => {
    if (payload.source === 'reconcile_sales') return;
    schedule();
  });

  useVisibleAutoRefresh(() => {
    if (Date.now() - lastRunRef.current >= pollIntervalMs - 1_000) run();
  }, pollIntervalMs, enabled);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && missedWhileHiddenRef.current) {
        missedWhileHiddenRef.current = false;
        schedule();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}

'use client';

import dynamic from 'next/dynamic';
import { CalendarDays } from 'lucide-react';
import { AlertBanner, LoadingCard } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/page-header';
import { usePermissions } from '@/hooks/use-permissions';
import { useAnalyticsDateRange } from '../analytics/_hooks/use-analytics-date-range';
import { DailyInventoryInsOutsPanel } from '../reports/_components/daily-inventory-ins-outs-panel';
import {
  getManilaDateDaysAgo,
  hasDailyInventoryReadPermission,
} from '../reports/_utils/daily-inventory-helpers';

const Datepicker = dynamic(() => import('react-tailwindcss-datepicker'), { ssr: false });

export default function DailyInventoryPage() {
  const { data: permissions = [], isFetched: permissionsLoaded } = usePermissions();
  const canViewDailyInventory = hasDailyInventoryReadPermission(permissions);
  const { today, range, startDate, endDate, handleDateRangeChange, syncDateRangeFromApi } =
    useAnalyticsDateRange();

  const yesterday = getManilaDateDaysAgo(1, today);
  const sevenDaysAgo = getManilaDateDaysAgo(6, today);

  const isTodayPreset = startDate === today && endDate === today;
  const isYesterdayPreset = startDate === yesterday && endDate === yesterday;
  const isLast7DaysPreset = startDate === sevenDaysAgo && endDate === today;

  const formatDateRangeButtonDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-');
    if (!year || !month || !day) return dateStr;
    return `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${year}`;
  };
  const dateRangeLabel =
    startDate === endDate
      ? formatDateRangeButtonDate(startDate)
      : `${formatDateRangeButtonDate(startDate)} - ${formatDateRangeButtonDate(endDate)}`;

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumbs={
          <span className="text-xs-tight font-semibold uppercase tracking-[0.2em] text-primary">
            Stock &amp; Inventory
          </span>
        }
        title="Daily Stock Ins & Outs"
        description="Daily incoming stock, put-away movements, outbound dispatches, and closing balances strictly scoped to your stores."
      />

      {!permissionsLoaded ? (
        <LoadingCard label="Checking permissions..." />
      ) : !canViewDailyInventory ? (
        <AlertBanner
          tone="error"
          message="You do not have permission to view daily stock ins and outs."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center rounded-xl border border-slate-200 dark:border-border bg-surface p-1 gap-1">
                <button
                  type="button"
                  onClick={() => syncDateRangeFromApi(today, today)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    isTodayPreset
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:text-foreground'
                  }`}
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => syncDateRangeFromApi(yesterday, yesterday)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    isYesterdayPreset
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:text-foreground'
                  }`}
                >
                  Yesterday
                </button>
                <button
                  type="button"
                  onClick={() => syncDateRangeFromApi(sevenDaysAgo, today)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    isLast7DaysPreset
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:text-foreground'
                  }`}
                >
                  Last 7 Days
                </button>
              </div>

              <div className="relative">
                <Datepicker
                  value={range}
                  onChange={handleDateRangeChange}
                  useRange={false}
                  asSingle={false}
                  showShortcuts={false}
                  showFooter={false}
                  primaryColor="orange"
                  readOnly
                  inputClassName={`h-10 cursor-pointer rounded-xl border border-slate-200 bg-surface dark:border-border p-0 text-transparent caret-transparent placeholder:text-transparent shadow-sm focus:border-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-100 transition-[width] duration-300 ease-out ${
                    isTodayPreset ? 'w-10' : 'w-[200px] sm:w-[236px]'
                  }`}
                  containerClassName=""
                  popupClassName={(defaultClass) => `${defaultClass} z-50 kpi-datepicker-light`}
                  displayFormat="MM/DD/YYYY"
                  separator=" - "
                  toggleIcon={() => (
                    <span className="flex w-full items-center gap-2 overflow-hidden">
                      <CalendarDays className="h-4 w-4 shrink-0 dark:text-white" />
                      <span
                        className={`whitespace-nowrap text-xs font-medium text-foreground transition-all duration-300 ease-out ${
                          isTodayPreset
                            ? 'max-w-0 -translate-x-1 opacity-0'
                            : 'max-w-[148px] sm:max-w-[184px] translate-x-0 opacity-100'
                        }`}
                      >
                        {dateRangeLabel}
                      </span>
                    </span>
                  )}
                  toggleClassName="absolute inset-0 flex items-center justify-start px-3 text-slate-600 hover:text-orange-700 cursor-pointer"
                  placeholder=" "
                />
              </div>
            </div>
          </div>

          <DailyInventoryInsOutsPanel startDate={startDate} endDate={endDate} />
        </>
      )}
    </div>
  );
}

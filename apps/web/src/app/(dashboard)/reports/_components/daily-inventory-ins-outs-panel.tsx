'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  Clock,
  Download,
  Mail,
  RefreshCw,
  Search,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AlertBanner, LoadingCard } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  fetchErpDailyInventoryReport,
  sendErpDailyInventoryEmailNow,
  updateErpDailyInventorySubscription,
} from '../_services/reports-api';
import type {
  ErpDailyInventoryMovementRow,
  ErpDailyInventoryReportResponse,
} from '../_types/reports';

export function DailyInventoryInsOutsPanel({
  startDate,
  endDate,
}: {
  startDate: string;
  endDate: string;
}) {
  const { addToast } = useToast();
  const [data, setData] = useState<ErpDailyInventoryReportResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showMovedOnly, setShowMovedOnly] = useState(false);

  const [emailEnabled, setEmailEnabled] = useState(true);
  const [emailRecipientsText, setEmailRecipientsText] = useState('');
  const [sendTimeManila, setSendTimeManila] = useState('20:00');
  const [isSavingSub, setIsSavingSub] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);

  const loadReport = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetchErpDailyInventoryReport({ startDate, endDate });
      setData(response);
      const sub = response.subscriptions?.[0];
      if (sub) {
        setEmailEnabled(sub.enabled);
        setEmailRecipientsText(sub.effectiveRecipients.join(', '));
        setSendTimeManila(sub.sendTimeManila || '20:00');
      }
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        || 'Failed to load daily inventory ins & outs report.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const filteredRows = useMemo(() => {
    const rows = data?.rows ?? [];
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (showMovedOnly && row.totalInQty === 0 && row.totalOutQty === 0 && row.putAwayMovedQty === 0) {
        return false;
      }
      if (!needle) return true;
      return [
        row.storeName,
        row.variantName,
        row.variantCode,
        row.productId,
        row.variationId,
      ].some((v) => v?.toLowerCase().includes(needle));
    });
  }, [data?.rows, search, showMovedOnly]);

  const handleSaveSubscription = async () => {
    setIsSavingSub(true);
    try {
      const recipients = emailRecipientsText
        .split(/[,;\n]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const { subscription } = await updateErpDailyInventorySubscription({
        enabled: emailEnabled,
        recipients,
        sendTimeManila,
      });
      setData((prev) =>
        prev ? { ...prev, subscriptions: [subscription] } : prev,
      );
      addToast('success', 'Daily inventory email settings saved.');
    } catch {
      addToast('error', 'Failed to save daily email settings.');
    } finally {
      setIsSavingSub(false);
    }
  };

  const handleSendEmailNow = async () => {
    setIsSendingEmail(true);
    try {
      const recipients = emailRecipientsText
        .split(/[,;\n]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const res = await sendErpDailyInventoryEmailNow({
        startDate,
        endDate,
        recipients: recipients.length > 0 ? recipients : undefined,
      });
      setData((prev) =>
        prev ? { ...prev, subscriptions: [res.subscription] } : prev,
      );
      addToast(
        'success',
        `Daily inventory report emailed to ${res.recipients.join(', ')}.`,
      );
    } catch {
      addToast('error', 'Failed to send daily inventory email.');
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleExportCsv = () => {
    if (!filteredRows.length) return;
    const headers = [
      'Date Range',
      'Client',
      'Store',
      'Product Variant',
      'SKU',
      'Stock In (Received)',
      'Stock In (Manual)',
      'Stock In (Restocked)',
      'Total Stock In',
      'Put Away to Bin',
      'Stock Out (Dispatched)',
      'Stock Out (Packed)',
      'Stock Out (Adjustments)',
      'Total Stock Out',
      'Net Change',
      'In Bin',
      'Total On-Hand Stock',
    ];
    const escapeCsv = (val: string | number | null | undefined) => {
      const str = val === null || val === undefined ? '' : String(val);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const dateRange = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
    const csv = [
      headers.map(escapeCsv).join(','),
      ...filteredRows.map((row: ErpDailyInventoryMovementRow) =>
        [
          dateRange,
          row.tenantName,
          row.storeName,
          row.variantName,
          row.variantCode || row.variationId,
          row.receivedInQty,
          row.manualInQty,
          row.restockedInQty,
          row.totalInQty,
          row.putAwayMovedQty,
          row.dispatchedOutQty,
          row.packedOutQty,
          row.adjustedOutQty,
          row.totalOutQty,
          row.netChangeQty,
          row.inBinQty,
          row.onHandQty,
        ]
          .map(escapeCsv)
          .join(','),
      ),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `daily-inventory-ins-outs-${startDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const totals = data?.totals;
  const sub = data?.subscriptions?.[0];

  if (isLoading) {
    return <LoadingCard label="Loading daily inventory ins & outs..." />;
  }

  return (
    <div className="space-y-5">
      {error ? <AlertBanner tone="error" message={error} /> : null}

      {/* 4 Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="border-emerald-200 bg-emerald-50/60 dark:bg-surface p-4">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-emerald-700">
            <span>Total Stock In</span>
            <ArrowDownLeft className="h-4 w-4" />
          </div>
          <p className="mt-2 text-2xl font-bold text-emerald-900 dark:text-foreground">
            +{(totals?.totalInQty ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-emerald-800 dark:text-slate-300">
            Received: {(totals?.receivedInQty ?? 0).toLocaleString()} • Manual:{' '}
            {(totals?.manualInQty ?? 0).toLocaleString()}
          </p>
        </Card>

        <Card className="border-rose-200 bg-rose-50/60 dark:bg-surface p-4">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-rose-700">
            <span>Total Stock Out</span>
            <ArrowUpRight className="h-4 w-4" />
          </div>
          <p className="mt-2 text-2xl font-bold text-rose-900 dark:text-foreground">
            -{(totals?.totalOutQty ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-rose-800 dark:text-slate-300">
            Dispatched: {(totals?.dispatchedOutQty ?? 0).toLocaleString()} • Packed:{' '}
            {(totals?.packedOutQty ?? 0).toLocaleString()}
          </p>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
            <span>Net Change</span>
            <RefreshCw className="h-4 w-4" />
          </div>
          <p className="mt-2 text-2xl font-bold text-foreground">
            {(totals?.netChangeQty ?? 0) >= 0
              ? `+${(totals?.netChangeQty ?? 0).toLocaleString()}`
              : (totals?.netChangeQty ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Put away to bin: {(totals?.putAwayMovedQty ?? 0).toLocaleString()}
          </p>
        </Card>

        <Card className="border-sky-200 bg-sky-50/60 dark:bg-surface p-4">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-sky-700">
            <span>Closing Stock</span>
            <Boxes className="h-4 w-4" />
          </div>
          <p className="mt-2 text-2xl font-bold text-sky-950 dark:text-foreground">
            {(totals?.onHandQty ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-sky-800 dark:text-slate-300">
            In Bin: {(totals?.inBinQty ?? 0).toLocaleString()} • Staging:{' '}
            {(totals?.awaitingPutAwayQty ?? 0).toLocaleString()}
          </p>
        </Card>
      </div>

      {/* Automated Daily Email Settings */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-border pb-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">
              Daily Automated Inventory Email to Client
            </h3>
          </div>
          <span className="text-xs text-slate-500">
            {sub?.lastSentAt
              ? `Last emailed: ${new Date(sub.lastSentAt).toLocaleString()}`
              : 'Automatically emailed every day at your scheduled Manila time'}
          </span>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(240px,1.5fr)_150px_auto]">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">
              Recipient Email Addresses (comma-separated)
            </label>
            <input
              type="text"
              value={emailRecipientsText}
              onChange={(e) => setEmailRecipientsText(e.target.value)}
              placeholder={sub?.defaultRecipients.join(', ') || 'you@company.com'}
              className="h-10 w-full rounded-xl border border-slate-200 bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">
              Daily Time (Manila)
            </label>
            <div className="relative">
              <Clock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="time"
                value={sendTimeManila}
                onChange={(e) => setSendTimeManila(e.target.value || '20:00')}
                className="h-10 w-full rounded-xl border border-slate-200 bg-surface pl-9 pr-3 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-surface px-3 text-xs font-semibold text-foreground">
              <input
                type="checkbox"
                checked={emailEnabled}
                onChange={(e) => setEmailEnabled(e.target.checked)}
                className="h-4 w-4"
              />
              Daily Auto-Email
            </label>
            <Button
              variant="outline"
              iconLeft={<CheckCircle2 className="h-4 w-4" />}
              onClick={() => void handleSaveSubscription()}
              loading={isSavingSub}
            >
              Save Schedule
            </Button>
            <Button
              variant="primary"
              iconLeft={<Send className="h-4 w-4" />}
              onClick={() => void handleSendEmailNow()}
              loading={isSendingEmail}
            >
              Email Report Now
            </Button>
          </div>
        </div>
      </Card>

      {/* Product Ins & Outs Table */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Product Inventory Ins & Outs
            </h3>
            <p className="text-xs text-slate-500">
              {filteredRows.length.toLocaleString()} product variants
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-surface px-3 text-xs font-semibold text-foreground">
              <input
                type="checkbox"
                checked={showMovedOnly}
                onChange={(e) => setShowMovedOnly(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Moved only
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search product or store..."
                className="h-9 rounded-xl border border-slate-200 bg-surface pl-9 pr-3 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              iconLeft={<Download className="h-4 w-4" />}
              onClick={handleExportCsv}
              disabled={!filteredRows.length}
            >
              Export CSV
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 dark:bg-background-secondary text-xs font-semibold uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Store</th>
                <th className="px-4 py-3">Product Variant</th>
                <th className="px-4 py-3 text-right">Stock In (+)</th>
                <th className="px-4 py-3 text-right">Stock Out (-)</th>
                <th className="px-4 py-3 text-right">Net Change</th>
                <th className="px-4 py-3 text-right">In Bin</th>
                <th className="px-4 py-3 text-right">Total On-Hand</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr
                  key={row.rowId}
                  className="border-t border-slate-200/80 dark:border-border text-foreground"
                >
                  <td className="px-4 py-3 font-medium">{row.storeName}</td>
                  <td className="px-4 py-3">
                    <span className="block font-semibold">{row.variantName}</span>
                    <span className="block text-xs text-slate-500">
                      {row.variantCode || row.variationId || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-emerald-600">
                    {row.totalInQty > 0 ? `+${row.totalInQty.toLocaleString()}` : '0'}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-rose-600">
                    {row.totalOutQty > 0 ? `-${row.totalOutQty.toLocaleString()}` : '0'}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                    {row.netChangeQty > 0
                      ? `+${row.netChangeQty.toLocaleString()}`
                      : row.netChangeQty.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-emerald-700">
                    {row.inBinQty.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums">
                    {row.onHandQty.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

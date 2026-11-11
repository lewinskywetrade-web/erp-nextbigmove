'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Boxes,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  Mail,
  RefreshCw,
  Search,
  Send,
} from 'lucide-react';
import { WmsCheckboxMultiSelect } from '../../_components/wms-checkbox-multi-select';
import { WmsCompactPanel } from '../../_components/wms-compact-panel';
import { WmsInlineNotice } from '../../_components/wms-inline-notice';
import { WmsModal } from '../../_components/wms-modal';
import {
  fetchDailyInventoryMovementsReport,
  sendDailyInventoryEmailNow,
  updateDailyInventoryEmailSubscription,
} from '../_services/month-end-stock-report.service';
import type {
  ClientDailyInventoryEmailSubscription,
  DailyInventoryMovementRow,
  DailyInventoryMovementsReportResponse,
} from '../_types/month-end-stock-report';

const PAGE_SIZE = 25;

function getManilaToday(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function shiftDateString(dateStr: string, daysDelta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + daysDelta));
  return dt.toISOString().slice(0, 10);
}

export function DailyInventoryMovementsScreen() {
  const todayManila = useMemo(() => getManilaToday(), []);
  const [startDate, setStartDate] = useState(todayManila);
  const [endDate, setEndDate] = useState(todayManila);
  const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>([]);
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [data, setData] = useState<DailyInventoryMovementsReportResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Table state
  const [search, setSearch] = useState('');
  const [showMovedOnly, setShowMovedOnly] = useState(false);
  const [page, setPage] = useState(1);

  // Email auto-reporting configuration state
  const [selectedEmailTenantId, setSelectedEmailTenantId] = useState<string>('');
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [emailRecipientsText, setEmailRecipientsText] = useState('');
  const [sendTimeManila, setSendTimeManila] = useState('20:00');
  const [isSavingSub, setIsSavingSub] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailActionMessage, setEmailActionMessage] = useState<string | null>(null);
  const [emailActionError, setEmailActionError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<{ subject: string; html: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    fetchDailyInventoryMovementsReport({
      startDate,
      endDate,
      tenantIds: selectedTenantIds,
      storeIds: selectedStoreIds,
    })
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          || (err instanceof Error ? err.message : 'Unable to load daily inventory report');
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [startDate, endDate, selectedTenantIds, selectedStoreIds, reloadNonce]);

  const partners = data?.filters.partners ?? [];
  const stores = useMemo(() => {
    const allStores = data?.filters.stores ?? [];
    if (selectedTenantIds.length === 0) return allStores;
    const tenantSet = new Set(selectedTenantIds);
    return allStores.filter((s) => tenantSet.has(s.tenantId));
  }, [data?.filters.stores, selectedTenantIds]);

  const partnerOptions = useMemo(
    () => partners.map((p) => ({ value: p.id, label: p.name })),
    [partners],
  );

  const storeOptions = useMemo(
    () =>
      stores.map((s) => ({
        value: s.id,
        label: s.name,
        hint: `${s.tenantName} • Shop ${s.shopId}`,
      })),
    [stores],
  );

  // Sync selectedEmailTenantId when data loads or client filter changes
  useEffect(() => {
    if (!data) return;
    const preferredTenantId =
      selectedTenantIds.length === 1
        ? selectedTenantIds[0]
        : selectedEmailTenantId && data.subscriptions.some((s) => s.tenantId === selectedEmailTenantId)
          ? selectedEmailTenantId
          : data.subscriptions[0]?.tenantId ?? partners[0]?.id ?? '';

    if (preferredTenantId && preferredTenantId !== selectedEmailTenantId) {
      setSelectedEmailTenantId(preferredTenantId);
    }
  }, [data, partners, selectedEmailTenantId, selectedTenantIds]);

  const activeSubscription: ClientDailyInventoryEmailSubscription | null = useMemo(() => {
    if (!data || !selectedEmailTenantId) return null;
    return data.subscriptions.find((s) => s.tenantId === selectedEmailTenantId) ?? null;
  }, [data, selectedEmailTenantId]);

  useEffect(() => {
    if (!activeSubscription) return;
    setEmailEnabled(activeSubscription.enabled);
    setEmailRecipientsText(activeSubscription.effectiveRecipients.join(', '));
    setSendTimeManila(activeSubscription.sendTimeManila || '20:00');
  }, [activeSubscription]);

  const handleSaveSubscription = async () => {
    if (!selectedEmailTenantId) return;
    setIsSavingSub(true);
    setEmailActionMessage(null);
    setEmailActionError(null);

    try {
      const recipients = emailRecipientsText
        .split(/[,;\n]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);

      const { subscription } = await updateDailyInventoryEmailSubscription({
        tenantId: selectedEmailTenantId,
        enabled: emailEnabled,
        recipients,
        sendTimeManila,
      });

      setData((prev) =>
        prev
          ? {
              ...prev,
              subscriptions: prev.subscriptions.map((sub) =>
                sub.tenantId === subscription.tenantId ? subscription : sub,
              ),
            }
          : prev,
      );
      setEmailActionMessage(
        `Saved daily auto-email settings for ${subscription.tenantName} (${
          subscription.enabled ? `Daily at ${subscription.sendTimeManila} Manila` : 'Paused'
        }).`,
      );
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
      setEmailActionError(
        Array.isArray(msg) ? msg.join(', ') : msg || 'Failed to save email subscription settings.',
      );
    } finally {
      setIsSavingSub(false);
    }
  };

  const handleSendEmailNow = async () => {
    if (!selectedEmailTenantId) return;
    setIsSendingEmail(true);
    setEmailActionMessage(null);
    setEmailActionError(null);

    try {
      const recipients = emailRecipientsText
        .split(/[,;\n]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);

      const response = await sendDailyInventoryEmailNow({
        tenantId: selectedEmailTenantId,
        startDate,
        endDate,
        recipients: recipients.length > 0 ? recipients : undefined,
      });

      setData((prev) =>
        prev
          ? {
              ...prev,
              subscriptions: prev.subscriptions.map((sub) =>
                sub.tenantId === response.subscription.tenantId ? response.subscription : sub,
              ),
            }
          : prev,
      );
      setPreviewHtml({
        subject: response.preview.subject,
        html: response.preview.html,
      });
      setEmailActionMessage(
        `Daily Inventory Ins & Outs email prepared and dispatched for ${
          response.clientName
        } to ${response.recipients.join(', ')}.`,
      );
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
      setEmailActionError(
        Array.isArray(msg) ? msg.join(', ') : msg || 'Failed to send daily inventory email.',
      );
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleExportCsv = () => {
    if (!data || data.rows.length === 0) return;
    const headers = [
      'Date Range',
      'Client',
      'Store',
      'Product Variant',
      'SKU / Code',
      'Stock In (Received)',
      'Stock In (Manual Input)',
      'Stock In (Restocked / RTS)',
      'Total Stock In',
      'Put Away to Bin',
      'Stock Out (Dispatched)',
      'Stock Out (Packed / Picked)',
      'Stock Out (Adjustments)',
      'Total Stock Out',
      'Net Change',
      'In Bin',
      'Awaiting Put-Away',
      'Reserved',
      'Total On-Hand Stock',
    ];
    const escapeCsv = (val: string | number | null | undefined) => {
      const str = val === null || val === undefined ? '' : String(val);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const dateRange = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
    const lines = [
      headers.map(escapeCsv).join(','),
      ...filteredRows.map((row) =>
        [
          dateRange,
          row.tenantName,
          row.storeName,
          row.variantName,
          row.variantCode || row.variantDisplayId || row.variationId,
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
          row.awaitingPutAwayQty,
          row.reservedQty,
          row.onHandQty,
        ]
          .map(escapeCsv)
          .join(','),
      ),
    ].join('\n');

    const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `daily-inventory-ins-outs-${startDate}${
      endDate !== startDate ? `-to-${endDate}` : ''
    }.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const filteredRows = useMemo(() => {
    const rows = data?.rows ?? [];
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (showMovedOnly && row.totalInQty === 0 && row.totalOutQty === 0 && row.putAwayMovedQty === 0) {
        return false;
      }
      if (!needle) return true;
      return [
        row.tenantName,
        row.storeName,
        row.shopId,
        row.variantName,
        row.variantCode,
        row.productId,
        row.variationId,
      ].some((v) => v?.toLowerCase().includes(needle));
    });
  }, [data?.rows, search, showMovedOnly]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const totals = data?.totals;

  return (
    <div className="space-y-4">
      {error ? <WmsInlineNotice tone="error">{error}</WmsInlineNotice> : null}

      {/* Top Filter & Date Controls */}
      <WmsCompactPanel
        title="Daily Inventory Ins & Outs Filter"
        meta={
          data?.report.generatedAt
            ? `Updated ${new Date(data.report.generatedAt).toLocaleTimeString()}`
            : 'Loading…'
        }
        headerActions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              disabled={isLoading}
              className="btn btn-md btn-outline btn-icon"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={!filteredRows.length || isLoading}
              className="btn btn-md btn-primary btn-icon"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </button>
          </div>
        }
      >
        <div className="grid gap-3 lg:grid-cols-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-[0.14em] text-[#5e7483]">
              Date Range (Manila)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setPage(1);
                }}
                className="input text-sm"
              />
              <span className="text-xs text-muted">to</span>
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setPage(1);
                }}
                className="input text-sm"
              />
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  setStartDate(todayManila);
                  setEndDate(todayManila);
                }}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  startDate === todayManila && endDate === todayManila
                    ? 'bg-primary text-white'
                    : 'bg-[#f1f5f9] text-[#475569] hover:bg-[#e2e8f0]'
                }`}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => {
                  const yest = shiftDateString(todayManila, -1);
                  setStartDate(yest);
                  setEndDate(yest);
                }}
                className="rounded-lg bg-[#f1f5f9] px-2.5 py-1 text-xs font-semibold text-[#475569] transition hover:bg-[#e2e8f0]"
              >
                Yesterday
              </button>
              <button
                type="button"
                onClick={() => {
                  setStartDate(shiftDateString(todayManila, -6));
                  setEndDate(todayManila);
                }}
                className="rounded-lg bg-[#f1f5f9] px-2.5 py-1 text-xs font-semibold text-[#475569] transition hover:bg-[#e2e8f0]"
              >
                Last 7 Days
              </button>
            </div>
          </div>

          <WmsCheckboxMultiSelect
            label="Client"
            allLabel="All clients"
            selectedValues={selectedTenantIds}
            options={partnerOptions}
            onChange={(nextTenantIds) => {
              setSelectedTenantIds(nextTenantIds);
              setSelectedStoreIds((curr) =>
                curr.filter((storeId) => {
                  const store = (data?.filters.stores ?? []).find((item) => item.id === storeId);
                  return !store || nextTenantIds.length === 0 || nextTenantIds.includes(store.tenantId);
                }),
              );
              setPage(1);
            }}
            placeholder="Search clients…"
          />

          <WmsCheckboxMultiSelect
            label="Store"
            allLabel="All stores"
            selectedValues={selectedStoreIds}
            options={storeOptions}
            onChange={(vals) => {
              setSelectedStoreIds(vals);
              setPage(1);
            }}
            placeholder="Search stores…"
          />

          <div className="flex flex-col justify-between rounded-2xl border border-[#dce4ea] bg-[#f9fbfc] p-3.5 text-xs text-[#536977]">
            <div className="flex items-center gap-2 font-semibold text-primary">
              <Calendar className="h-4 w-4 text-primary" />
              <span>
                {startDate === endDate ? `Single Day: ${startDate}` : `${startDate} → ${endDate}`}
              </span>
            </div>
            <p className="mt-1">
              Showing {data?.filters.effectiveStoreIds.length ?? 0} active stores across{' '}
              {selectedTenantIds.length || partners.length} client(s).
            </p>
          </div>
        </div>
      </WmsCompactPanel>

      {/* 4 KPI Summary Cards */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[22px] border border-emerald-200 bg-emerald-50/70 p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-800">
              Total Stock In
            </span>
            <ArrowDownLeft className="h-4 w-4 text-emerald-700" />
          </div>
          <p className="mt-2 text-2xl font-bold tabular-nums text-emerald-900">
            +{(totals?.totalInQty ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-emerald-800">
            Received: {(totals?.receivedInQty ?? 0).toLocaleString()} • Manual:{' '}
            {(totals?.manualInQty ?? 0).toLocaleString()} • Restocked:{' '}
            {(totals?.restockedInQty ?? 0).toLocaleString()}
          </p>
        </div>

        <div className="rounded-[22px] border border-rose-200 bg-rose-50/70 p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-rose-800">
              Total Stock Out
            </span>
            <ArrowUpRight className="h-4 w-4 text-rose-700" />
          </div>
          <p className="mt-2 text-2xl font-bold tabular-nums text-rose-900">
            -{(totals?.totalOutQty ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-rose-800">
            Dispatched: {(totals?.dispatchedOutQty ?? 0).toLocaleString()} • Packed/Picked:{' '}
            {(totals?.packedOutQty ?? 0).toLocaleString()} • Adjusted:{' '}
            {(totals?.adjustedOutQty ?? 0).toLocaleString()}
          </p>
        </div>

        <div className="rounded-[22px] border border-[#dce4ea] bg-white p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5e7483]">
              Net Change & Put-Away
            </span>
            <RefreshCw className="h-4 w-4 text-[#5e7483]" />
          </div>
          <p className="mt-2 text-2xl font-bold tabular-nums text-primary">
            {(totals?.netChangeQty ?? 0) >= 0
              ? `+${(totals?.netChangeQty ?? 0).toLocaleString()}`
              : (totals?.netChangeQty ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-muted">
            Put away to bins: {(totals?.putAwayMovedQty ?? 0).toLocaleString()} • Moved products:{' '}
            {(totals?.activeMovedVariantCount ?? 0).toLocaleString()}
          </p>
        </div>

        <div className="rounded-[22px] border border-sky-200 bg-sky-50/70 p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-800">
              Closing Warehouse Stock
            </span>
            <Boxes className="h-4 w-4 text-sky-700" />
          </div>
          <p className="mt-2 text-2xl font-bold tabular-nums text-sky-950">
            {(totals?.onHandQty ?? 0).toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-sky-800">
            In Bin: {(totals?.inBinQty ?? 0).toLocaleString()} • Staging:{' '}
            {(totals?.awaitingPutAwayQty ?? 0).toLocaleString()} • Reserved:{' '}
            {(totals?.reservedQty ?? 0).toLocaleString()}
          </p>
        </div>
      </section>

      {/* Automated Daily Email to Client Card */}
      <WmsCompactPanel
        title="Automated Daily Email Report to Client"
        icon={<Mail className="panel-icon" />}
        meta={
          activeSubscription?.lastSentAt
            ? `Last emailed: ${new Date(activeSubscription.lastSentAt).toLocaleString()} (${
                activeSubscription.lastDeliveryStatus ?? 'SENT'
              })`
            : 'Automatically emails daily inventory ins & outs to each active client'
        }
      >
        <div className="space-y-3">
          {emailActionMessage ? (
            <WmsInlineNotice tone="success">{emailActionMessage}</WmsInlineNotice>
          ) : null}
          {emailActionError ? (
            <WmsInlineNotice tone="error">{emailActionError}</WmsInlineNotice>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-[minmax(200px,0.9fr)_minmax(260px,1.5fr)_140px_auto]">
            <div>
              <label className="mb-1 block text-xs font-semibold text-[#536977]">Client</label>
              <select
                value={selectedEmailTenantId}
                onChange={(e) => {
                  setSelectedEmailTenantId(e.target.value);
                  setEmailActionMessage(null);
                  setEmailActionError(null);
                }}
                className="select text-sm"
              >
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-[#536977]">
                Client Email Recipients (comma-separated)
              </label>
              <input
                type="text"
                value={emailRecipientsText}
                onChange={(e) => setEmailRecipientsText(e.target.value)}
                placeholder={
                  activeSubscription?.defaultRecipients.join(', ')
                  || 'client@company.com, ops@company.com'
                }
                className="input text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-[#536977]">
                Daily Time (PH)
              </label>
              <div className="relative">
                <Clock className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#7c8f9b]" />
                <input
                  type="time"
                  value={sendTimeManila}
                  onChange={(e) => setSendTimeManila(e.target.value || '20:00')}
                  className="input pl-8 text-sm"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <label className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-[#d7e0e7] bg-[#fbfcfc] px-3 text-xs font-semibold text-primary">
                <input
                  type="checkbox"
                  checked={emailEnabled}
                  onChange={(e) => setEmailEnabled(e.target.checked)}
                  className="h-4 w-4 accent-[#17324b]"
                />
                Daily Auto-Send
              </label>

              <button
                type="button"
                onClick={() => void handleSaveSubscription()}
                disabled={isSavingSub || !selectedEmailTenantId}
                className="btn btn-md btn-outline btn-icon"
              >
                <CheckCircle2 className="h-4 w-4" />
                {isSavingSub ? 'Saving…' : 'Save Settings'}
              </button>

              <button
                type="button"
                onClick={() => void handleSendEmailNow()}
                disabled={isSendingEmail || !selectedEmailTenantId}
                className="btn btn-md btn-primary btn-icon"
              >
                <Send className="h-4 w-4" />
                {isSendingEmail ? 'Sending…' : 'Email Client Now'}
              </button>

              <button
                type="button"
                disabled={!data || !selectedEmailTenantId}
                onClick={() => {
                  if (!data) return;
                  const clientName =
                    partners.find((p) => p.id === selectedEmailTenantId)?.name || 'Client';
                  const dateLabel =
                    startDate === endDate ? startDate : `${startDate} to ${endDate}`;
                  const clientRows = data.rows.filter(
                    (r) => !selectedEmailTenantId || r.tenantId === selectedEmailTenantId,
                  );
                  const movedRows = clientRows.filter(
                    (r) => r.totalInQty > 0 || r.totalOutQty > 0,
                  );
                  const displayRows = (movedRows.length > 0 ? movedRows : clientRows).slice(0, 30);
                  const rowHtml = displayRows
                    .map(
                      (row) => `
                        <tr>
                          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;font-weight:600;">
                            ${row.variantName}
                            <div style="font-size:11px;color:#64748b;font-weight:400;">${row.storeName} • ${row.variantCode || row.variationId || '—'}</div>
                          </td>
                          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#059669;font-weight:600;">+${row.totalInQty.toLocaleString()}</td>
                          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#e11d48;font-weight:600;">-${row.totalOutQty.toLocaleString()}</td>
                          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#334155;font-weight:600;">${row.netChangeQty >= 0 ? `+${row.netChangeQty.toLocaleString()}` : row.netChangeQty.toLocaleString()}</td>
                          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#0f172a;font-weight:700;">${row.onHandQty.toLocaleString()} <span style="font-size:11px;color:#64748b;font-weight:400;">(Bin: ${row.inBinQty.toLocaleString()})</span></td>
                        </tr>`,
                    )
                    .join('');
                  setPreviewHtml({
                    subject: `[Daily Inventory Ins & Outs] ${clientName} — ${dateLabel}`,
                    html: `<div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                      <div style="padding:20px 24px;background:#17324b;color:#ffffff;">
                        <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#93c5fd;font-weight:600;">Daily Automated Inventory Report</div>
                        <h2 style="margin:6px 0 4px;font-size:20px;font-weight:700;">${clientName} — Inventory Ins &amp; Outs</h2>
                        <div style="font-size:12px;color:#cbd5e1;">Report Date: ${dateLabel} (Asia/Manila) • Scheduled Daily at ${sendTimeManila} PH</div>
                      </div>
                      <div style="padding:20px 24px;">
                        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                          <thead>
                            <tr style="background:#f1f5f9;">
                              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#475569;">Product / Store</th>
                              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#475569;">In (+)</th>
                              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#475569;">Out (-)</th>
                              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#475569;">Net</th>
                              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#475569;">On-Hand</th>
                            </tr>
                          </thead>
                          <tbody>${rowHtml || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#64748b;">No products found for this client.</td></tr>'}</tbody>
                        </table>
                      </div>
                    </div>`,
                  });
                }}
                className="btn btn-md btn-secondary btn-icon"
              >
                <Eye className="h-4 w-4" />
                Preview Email
              </button>
            </div>
          </div>
        </div>
      </WmsCompactPanel>

      {/* Product Ins & Outs Table */}
      <section className="overflow-hidden rounded-[24px] border border-[#dce4ea] bg-white">
        <div className="flex flex-col gap-3 border-b border-[#e6edf1] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-primary">
              Product Inventory Ins & Outs Breakdown
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Shows stock received/restocked (IN), stock dispatched/packed/adjusted (OUT), and live warehouse balance per product.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-2xl border border-[#d7e0e7] bg-[#fbfcfc] px-3 text-xs font-semibold text-primary">
              <input
                type="checkbox"
                checked={showMovedOnly}
                onChange={(e) => {
                  setShowMovedOnly(e.target.checked);
                  setPage(1);
                }}
                className="h-3.5 w-3.5 accent-[#17324b]"
              />
              Moved in period only
            </label>
            <label className="flex h-10 min-w-0 items-center gap-2 rounded-2xl border border-[#d7e0e7] bg-white px-3 sm:w-[280px]">
              <Search className="h-4 w-4 shrink-0 text-[#8193a0]" />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search product, SKU, store, or client"
                className="min-w-0 flex-1 border-0 bg-transparent text-sm text-primary outline-none placeholder:text-[#94a3b8]"
              />
            </label>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left text-sm">
            <thead className="bg-[#f6f8fa] text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6f8290]">
              <tr>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Store</th>
                <th className="px-4 py-3">Product Variant</th>
                <th className="px-4 py-3 text-right">Stock In (+)</th>
                <th className="px-4 py-3 text-right">Put Away</th>
                <th className="px-4 py-3 text-right">Stock Out (-)</th>
                <th className="px-4 py-3 text-right">Net Change</th>
                <th className="px-4 py-3 text-right">In Bin</th>
                <th className="px-4 py-3 text-right">Total On-Hand</th>
              </tr>
            </thead>
            <tbody className={isLoading ? 'opacity-50' : ''}>
              {visibleRows.map((row: DailyInventoryMovementRow) => (
                <tr
                  key={row.rowId}
                  className="border-t border-[#edf1f4] text-primary hover:bg-[#fbfcfd]"
                >
                  <td className="px-4 py-3 font-medium">{row.tenantName}</td>
                  <td className="px-4 py-3">
                    <span className="block font-semibold">{row.storeName}</span>
                    <span className="block text-[11px] text-muted">Shop {row.shopId}</span>
                  </td>
                  <td className="max-w-[300px] px-4 py-3">
                    <span className="block truncate font-semibold">{row.variantName}</span>
                    <span className="block text-[11px] text-muted">
                      {row.variantCode || row.variantDisplayId || row.variationId || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-emerald-700">
                    {row.totalInQty > 0 ? `+${row.totalInQty.toLocaleString()}` : '0'}
                    {row.totalInQty > 0 ? (
                      <span className="block text-[10px] font-normal text-muted">
                        Rcv {row.receivedInQty} • Man {row.manualInQty}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[#536977]">
                    {row.putAwayMovedQty.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-rose-700">
                    {row.totalOutQty > 0 ? `-${row.totalOutQty.toLocaleString()}` : '0'}
                    {row.totalOutQty > 0 ? (
                      <span className="block text-[10px] font-normal text-muted">
                        Ship {row.dispatchedOutQty} • Pack {row.packedOutQty}
                      </span>
                    ) : null}
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

        {visibleRows.length === 0 ? (
          <div className="border-t border-[#edf1f4] px-4 py-14 text-center text-sm text-muted">
            {isLoading
              ? 'Loading daily inventory movements…'
              : 'No products match the selected filter.'}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-[#e6edf1] bg-[#fbfcfd] px-4 py-3 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <span>{filteredRows.length.toLocaleString()} product variants</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setPage((v) => Math.max(1, v - 1))}
              className="btn btn-sm btn-secondary"
            >
              Previous
            </button>
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((v) => Math.min(totalPages, v + 1))}
              className="btn btn-sm btn-secondary"
            >
              Next
            </button>
          </div>
        </div>
      </section>

      {/* Recent Inventory Movement Activity Log */}
      {data?.recentMovements && data.recentMovements.length > 0 ? (
        <WmsCompactPanel
          title={`Recent Inventory Movement Log (${data.recentMovements.length})`}
          meta="Latest unit-level IN / OUT / PUTAWAY events in selected window"
        >
          <div className="max-h-[340px] overflow-y-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-[#f6f8fa] text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6f8290]">
                <tr>
                  <th className="px-3 py-2.5">Time</th>
                  <th className="px-3 py-2.5">Direction</th>
                  <th className="px-3 py-2.5">Type</th>
                  <th className="px-3 py-2.5">Client / Store</th>
                  <th className="px-3 py-2.5">Product</th>
                  <th className="px-3 py-2.5">Unit Code</th>
                  <th className="px-3 py-2.5">Location</th>
                  <th className="px-3 py-2.5">By</th>
                </tr>
              </thead>
              <tbody>
                {data.recentMovements.slice(0, 50).map((mov) => (
                  <tr key={mov.id} className="border-t border-[#edf1f4] text-[#29404f]">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-[#536977]">
                      {new Date(mov.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          mov.direction === 'IN'
                            ? 'pill pill-success'
                            : mov.direction === 'OUT'
                              ? 'pill pill-destructive'
                              : 'pill pill-white'
                        }
                      >
                        {mov.direction}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-semibold">{mov.movementType}</td>
                    <td className="px-3 py-2">
                      {mov.tenantName} • {mov.storeName}
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2 font-medium">
                      {mov.variantName}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{mov.unitCode}</td>
                    <td className="px-3 py-2">
                      {mov.fromLocationCode || '—'} → {mov.toLocationCode || '—'}
                    </td>
                    <td className="px-3 py-2 text-[#536977]">{mov.actorName || 'System'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </WmsCompactPanel>
      ) : null}

      {/* Email HTML Preview Modal */}
      <WmsModal
        open={Boolean(previewHtml)}
        title={previewHtml?.subject || 'Daily Inventory Email Preview'}
        description="Preview of the automated daily HTML email sent to the client."
        onClose={() => setPreviewHtml(null)}
        panelClassName="max-w-3xl"
      >
        {previewHtml ? (
          <div className="max-h-[70vh] overflow-y-auto rounded-2xl border border-[#dce4ea] bg-[#f8fafc] p-3">
            <div dangerouslySetInnerHTML={{ __html: previewHtml.html }} />
          </div>
        ) : null}
      </WmsModal>
    </div>
  );
}

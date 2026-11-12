'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { WmsSidePanel } from '../../_components/wms-side-panel';
import { FulfillmentItemAdjustmentSection } from './fulfillment-item-adjustment-section';
import {
  fetchWmsFulfillmentPriorityPreview,
  prioritizeWmsFulfillmentOrder,
  releaseWmsFulfillmentPriority,
} from '../_services/fulfillment.service';
import type {
  WmsFulfillmentHeldBasket,
  WmsFulfillmentPackerOption,
  WmsFulfillmentQueueMode,
  WmsFulfillmentPriorityPreviewResponse,
  WmsFulfillmentQueueTask,
} from '../_types/fulfillment';
import {
  buildHeldBasketRows,
  buildFulfillmentQueueRows,
  type WmsFulfillmentBasketRow,
  type WmsFulfillmentQueueRow,
} from './fulfillment-queue-rows';

type FulfillmentQueueTableProps = {
  mode: WmsFulfillmentQueueMode;
  tasks: WmsFulfillmentQueueTask[];
  heldBaskets?: WmsFulfillmentHeldBasket[];
  isLoading: boolean;
  tenantReady: boolean;
  pickView?: PickQueueView;
  canVoidPickBaskets?: boolean;
  canAssignPickBasketPacker?: boolean;
  canAdjustFulfillmentItems?: boolean;
  packerOptions?: WmsFulfillmentPackerOption[];
  isAssigningPickBasketPacker?: boolean;
  onAssignPickBasketPacker?: (basketId: string, packerId: string) => Promise<boolean> | boolean;
  isVoidingPickBasket?: boolean;
  onVoidPickBasket?: (basketId: string) => Promise<boolean> | boolean;
  onRefresh?: () => Promise<unknown> | unknown;
};

type PickQueueView = 'orders' | 'baskets';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function FulfillmentQueueTable({
  mode,
  tasks,
  heldBaskets = [],
  isLoading,
  tenantReady,
  pickView = 'orders',
  canVoidPickBaskets = false,
  canAssignPickBasketPacker = false,
  canAdjustFulfillmentItems = false,
  packerOptions = [],
  isAssigningPickBasketPacker = false,
  onAssignPickBasketPacker,
  isVoidingPickBasket = false,
  onVoidPickBasket,
  onRefresh,
}: FulfillmentQueueTableProps) {
  const [selection, setSelection] = useState<{ kind: 'task' | 'basket'; id: string } | null>(null);
  const [confirmVoidBasketId, setConfirmVoidBasketId] = useState<string | null>(null);
  const [selectedPackerId, setSelectedPackerId] = useState('');
  const [priorityPreview, setPriorityPreview] = useState<WmsFulfillmentPriorityPreviewResponse | null>(null);
  const [priorityError, setPriorityError] = useState<string | null>(null);
  const [priorityNotice, setPriorityNotice] = useState<string | null>(null);
  const [selectedDonorIds, setSelectedDonorIds] = useState<string[]>([]);
  const [isPriorityPreviewLoading, setIsPriorityPreviewLoading] = useState(false);
  const [isApplyingPriority, setIsApplyingPriority] = useState(false);
  const [isReleasingPriority, setIsReleasingPriority] = useState(false);
  const actorHeader = mode === 'pick' ? 'Picker' : 'Packer';
  const basketRows = useMemo(
    () => (mode === 'pick'
      ? buildHeldBasketRows(heldBaskets).filter((row) => ACTIVE_PICK_BASKET_STATUSES.has(row.basket.status))
      : []),
    [heldBaskets, mode],
  );
  const taskRows = useMemo(() => buildFulfillmentQueueRows(mode, tasks), [mode, tasks]);
  const isBasketView = mode === 'pick' && pickView === 'baskets';
  const rows = useMemo<WmsFulfillmentQueueRow[]>(
    () => (isBasketView ? basketRows : taskRows),
    [basketRows, isBasketView, taskRows],
  );
  const selectedRow = useMemo(() => {
    if (!selection) {
      return null;
    }

    return rows.find((row) => (
      row.kind === selection.kind
        && (row.kind === 'basket' ? row.basket.id : row.task.id) === selection.id
    )) ?? null;
  }, [rows, selection]);

  useEffect(() => {
    if (!tenantReady) {
      setSelection(null);
      setConfirmVoidBasketId(null);
      setSelectedPackerId('');
      return;
    }

    if (!selection) {
      return;
    }

    if (!selectedRow) {
      setSelection(null);
      setConfirmVoidBasketId(null);
    }
  }, [selectedRow, selection, tenantReady]);

  useEffect(() => {
    const selectedBasketId = selectedRow?.kind === 'basket' ? selectedRow.basket.id : null;
    if (confirmVoidBasketId && confirmVoidBasketId !== selectedBasketId) {
      setConfirmVoidBasketId(null);
    }
  }, [confirmVoidBasketId, selectedRow]);

  useEffect(() => {
    setSelectedPackerId('');
  }, [selection?.id]);

  const primaryHeader = isBasketView ? 'Basket' : 'Order';
  const secondaryHeader = isBasketView ? 'Orders' : 'Customer';
  const middleHeader = mode === 'pick'
    ? (isBasketView ? 'Capacity' : 'Basket')
    : 'Tracking';
  const lastHeader = mode === 'pick' ? 'Warehouse' : 'Basket';
  const columnCount = 8;

  const selectedTask = selectedRow?.kind === 'task' ? selectedRow.task : null;
  const selectedBasket = selectedRow?.kind === 'basket' ? selectedRow : null;
  const selectedLines = selectedTask ? getVisibleQueueLines(selectedTask) : [];
  const selectedStatusLabel = selectedTask?.delivery?.label ?? selectedTask?.statusLabel ?? selectedBasket?.basket.statusLabel ?? '';
  const selectedActor = selectedTask
    ? (mode === 'pick' ? selectedTask.claimedBy?.name : selectedTask.packedBy?.name)
    : selectedBasket?.basket.assignedPicker?.name ?? null;
  const selectedMiddleValue = selectedTask
    ? (mode === 'pick' ? selectedTask.basket?.barcode ?? 'Unassigned' : selectedTask.tracking ?? 'Awaiting tracking')
    : selectedBasket?.basket.activeFulfillmentOrders
      ? `${selectedBasket.basket.activeFulfillmentOrders}/${selectedBasket.basket.maxFulfillmentOrders}`
      : `${selectedBasket?.basket.orders.length ?? 0}/${selectedBasket?.basket.maxFulfillmentOrders ?? 0}`;
  const selectedLastValue = selectedTask
    ? (mode === 'pick'
      ? selectedTask.warehouse?.name ?? 'Not assigned'
      : selectedTask.basket?.barcode ?? 'Unassigned')
    : selectedBasket?.basket.warehouse?.name ?? 'Not assigned';

  const selectedBasketOrders = useMemo(() => {
    if (!selectedBasket) {
      return [];
    }

    const orders = selectedBasket.basket.orders.length > 0
      ? selectedBasket.basket.orders
      : selectedBasket.tasks.map((task) => ({
        id: task.id,
        posOrderId: task.posOrderId,
        status: task.status,
        statusLabel: task.statusLabel,
        customerName: task.customer.name,
        totals: {
          required: task.totals.required,
          picked: task.totals.picked,
        },
        store: task.store,
      }));

    return [...orders].sort((left, right) => {
      const leftOrder = left.posOrderId ?? '';
      const rightOrder = right.posOrderId ?? '';
      return leftOrder.localeCompare(rightOrder, undefined, { numeric: true });
    });
  }, [selectedBasket]);
  const selectedBasketChanges = selectedBasket?.tasks.filter((task) => task.itemChange) ?? [];
  const canHandoffSelectedBasket = Boolean(
    selectedBasket
    && selectedBasket.basket.status === 'FULL_HELD'
    && !selectedBasketChanges.some((task) => task.itemChange?.requiresAction)
    && canAssignPickBasketPacker
    && onAssignPickBasketPacker,
  );

  const canPrioritizeSelectedTask = mode === 'pick' && Boolean(
    selectedTask
    && (
      selectedTask.status === 'RESTOCKING'
      || selectedTask.status === 'PARTIAL'
      || selectedTask.priority?.isPrioritized
    ),
  );
  const selectedPrioritySuggestedQty = useMemo(() => {
    if (!priorityPreview) {
      return 0;
    }

    return priorityPreview.donors
      .filter((donor) => selectedDonorIds.includes(donor.id))
      .reduce((sum, donor) => sum + donor.suggestedGiveQty, 0);
  }, [priorityPreview, selectedDonorIds]);

  useEffect(() => {
    setPriorityPreview(null);
    setPriorityError(null);
    setPriorityNotice(null);
    setSelectedDonorIds([]);
  }, [selectedTask?.id]);

  return (
    <>
      <QueueTableFrame
        actorHeader={actorHeader}
        middleHeader={middleHeader}
        lastHeader={lastHeader}
        primaryHeader={primaryHeader}
        secondaryHeader={secondaryHeader}
      >
        <tbody className="bg-white">
          {!tenantReady ? (
            <tr>
              <td colSpan={columnCount} className="px-5 py-8 text-sm text-[#6f8290]">
                Select a tenant or store scope to load fulfillment work.
              </td>
            </tr>
          ) : isLoading ? (
            Array.from({ length: 5 }).map((_, index) => (
              <tr key={`loading-${index}`} className="border-b border-[#edf2f6]">
                {Array.from({ length: columnCount }).map((__, cellIndex) => (
                  <td key={`loading-${index}-${cellIndex}`} className="px-5 py-4">
                    <div className="h-3.5 animate-pulse rounded-full bg-[#eef2f5]" />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount} className="px-5 py-8 text-sm text-[#6f8290]">
                {isBasketView
                  ? 'No active baskets are in this view yet.'
                  : `No ${mode === 'pick' ? 'pick' : 'pack'} orders are in this view yet.`}
              </td>
            </tr>
          ) : rows.map((row) => (
            row.kind === 'basket'
              ? (
                <BasketRow
                  key={row.key}
                  row={row}
                  onSelect={() => setSelection({ kind: 'basket', id: row.basket.id })}
                />
              )
              : (
                <TaskRow
                  key={row.key}
                  mode={mode}
                  task={row.task}
                  onSelect={() => setSelection({ kind: 'task', id: row.task.id })}
                />
              )
          ))}
        </tbody>
      </QueueTableFrame>

      <WmsSidePanel
        open={selectedRow !== null}
        title={selectedBasket ? `Basket ${selectedBasket.basket.barcode}` : selectedTask ? `Order #${selectedTask.posOrderId}` : 'Queue details'}
        description={selectedBasket
          ? buildBasketDescription(selectedBasket)
          : selectedTask
            ? `${selectedTask.store?.tenantName ?? 'Tenant'} · ${selectedTask.store?.name ?? 'Store'}`
            : undefined}
        onClose={() => {
          setSelection(null);
          setConfirmVoidBasketId(null);
        }}
        bodyClassName="space-y-4"
        footer={selectedBasket ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {confirmVoidBasketId === selectedBasket.basket.id ? (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmVoidBasketId(null)}
                  className="btn btn-md btn-outline"
                  disabled={isVoidingPickBasket}
                >
                  Keep basket
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!onVoidPickBasket) {
                      return;
                    }

                    void Promise.resolve(onVoidPickBasket(selectedBasket.basket.id)).then((success) => {
                      if (success) {
                        setSelection(null);
                        setConfirmVoidBasketId(null);
                      }
                    });
                  }}
                  disabled={isVoidingPickBasket}
                  className="inline-flex h-11 items-center justify-center rounded-[16px] border border-rose-200 bg-white px-4 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isVoidingPickBasket ? 'Voiding…' : 'Confirm void'}
                </button>
              </>
            ) : (
              <>
                {canVoidPickBaskets ? (
                  <button
                    type="button"
                    onClick={() => setConfirmVoidBasketId(selectedBasket.basket.id)}
                    disabled={isAssigningPickBasketPacker}
                    className="inline-flex h-11 items-center justify-center rounded-[16px] border border-rose-200 bg-white px-4 text-sm font-semibold text-rose-700 transition hover:bg-rose-50"
                  >
                    Void basket
                  </button>
                ) : null}
                {canHandoffSelectedBasket ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectedPackerId || !onAssignPickBasketPacker) {
                        return;
                      }

                      void Promise.resolve(onAssignPickBasketPacker(
                        selectedBasket.basket.id,
                        selectedPackerId,
                      )).then((success) => {
                        if (success) {
                          setSelectedPackerId('');
                        }
                      });
                    }}
                    disabled={!selectedPackerId || isAssigningPickBasketPacker}
                    className="btn btn-md btn-primary"
                  >
                    {isAssigningPickBasketPacker ? 'Assigning…' : 'Assign packer'}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setSelection(null)}
                  disabled={isAssigningPickBasketPacker}
                  className="btn btn-md btn-outline"
                >
                  Close
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setSelection(null)}
              className="btn btn-md btn-outline"
            >
              Close
            </button>
          </div>
        )}
      >
        {selectedBasket ? (
          <>
            {selectedBasketChanges.map((task) => (
              <OrderChangeAlert key={`basket-change-${task.id}`} task={task} />
            ))}

            <div className="grid gap-3 sm:grid-cols-2">
              <TopMetaCard
                label="Status"
                value={(
                  <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStatusTone(selectedBasket.basket.statusLabel)}`}>
                    {selectedBasket.basket.statusLabel}
                  </span>
                )}
              />
              <TopMetaCard
                label="Claimed at"
                value={<span className="text-sm font-semibold text-primary">{formatDateTime(selectedBasket.basket.claimedAt)}</span>}
              />
            </div>

            {confirmVoidBasketId === selectedBasket.basket.id ? (
              <div className="rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                Void will return picked units to their original bins, detach already packed history from this basket, and re-evaluate every remaining order inside it.
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryTile label="Orders" value={selectedBasketOrders.length} />
              <SummaryTile label="Required" value={selectedBasket.totals.required} />
              <SummaryTile label="Picked" value={selectedBasket.totals.picked} />
              <SummaryTile label="Remaining" value={selectedBasket.totals.remaining} />
            </div>

            <DetailSection title="Basket overview" description="Live basket progress and assignment details.">
              <div className="grid gap-3 sm:grid-cols-2">
                <InfoCard label="Picker" value={selectedActor ?? 'Not started'} />
                <InfoCard label="Packer" value={selectedBasket.basket.assignedPacker?.name ?? 'Not assigned'} />
                <InfoCard label="Warehouse" value={selectedLastValue ?? 'Not assigned'} />
                <InfoCard label="Capacity" value={selectedMiddleValue ?? '0/0'} />
                <InfoCard label="Ready for pack" value={formatDateTime(selectedBasket.basket.readyForPackAt)} />
              </div>
            </DetailSection>

            {selectedBasket.basket.status === 'FULL_HELD' ? (
              <DetailSection
                title="Assign to packer"
                description="Hand off this completed basket to an eligible packing staff member. All orders in the basket will enter the pack queue together."
              >
                {canAssignPickBasketPacker ? (
                  <div className="space-y-2">
                    <label htmlFor="pick-basket-packer" className="block text-[12px] font-semibold uppercase tracking-[0.08em] text-[#667a88]">
                      Packer
                    </label>
                    <select
                      id="pick-basket-packer"
                      value={selectedPackerId}
                      onChange={(event) => setSelectedPackerId(event.target.value)}
                      disabled={isAssigningPickBasketPacker || packerOptions.length === 0}
                      className="h-12 w-full rounded-2xl border border-[#d7e0e7] bg-white px-3.5 text-[13px] font-semibold text-[#12384b] outline-none transition focus:border-[#96b4c3] focus:shadow-[0_0_0_4px_rgba(18,56,75,0.08)] disabled:cursor-not-allowed disabled:bg-[#f5f7f8] disabled:text-[#82929d]"
                    >
                      <option value="">
                        {packerOptions.length === 0 ? 'No eligible packers available' : 'Select a packer'}
                      </option>
                      {packerOptions.map((packer) => (
                        <option key={packer.id} value={packer.id}>
                          {packer.name} · {packer.email}
                        </option>
                      ))}
                    </select>
                    {packerOptions.length === 0 ? (
                      <p className="text-[12px] text-amber-700">
                        Add an active WMS staff assignment with the Pack task type and packing permission first.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-[#667a88]">
                    Supervisor access is required to assign a held basket from WMS Web.
                  </p>
                )}
              </DetailSection>
            ) : null}

            <DetailSection
              title="Orders in basket"
              description={`${selectedBasketOrders.length} order${selectedBasketOrders.length === 1 ? '' : 's'} currently linked to this basket.`}
            >
              <div className="space-y-3">
                {selectedBasketOrders.map((order) => {
                  const matchedTask = selectedBasket.tasks.find((task) => task.id === order.id);
                  return (
                  <div key={order.id} className="rounded-[20px] border border-[#e6edf1] bg-[#fbfcfc] px-4 py-3">
                    {matchedTask?.itemChange ? (
                      <div className={`mb-2.5 rounded-xl border px-3 py-2 text-xs ${matchedTask.itemChange.requiresAction ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-sky-200 bg-sky-50 text-sky-900'}`}>
                        <span className="font-semibold">
                          {matchedTask.itemChange.requiresAction ? 'Order changed · Rework required' : 'Order changed · Automatic revision'}
                        </span>
                        {' — '}
                        <span>{matchedTask.itemChange.message}</span>
                      </div>
                    ) : null}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-primary">
                          #{order.posOrderId ?? 'Unknown'}
                        </p>
                        <p className="mt-1 truncate text-[13px] text-[#667a88]">
                          {order.store?.tenantName ?? 'Tenant'} · {order.store?.name ?? 'Store'}
                        </p>
                      </div>
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStatusTone(order.statusLabel ?? order.status ?? '')}`}>
                        {order.statusLabel ?? order.status ?? 'Unknown'}
                      </span>
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      <LineMetric label="Required" value={order.totals.required} />
                      <LineMetric label="Picked" value={order.totals.picked} />
                      <LineMetric label="Remaining" value={Math.max(order.totals.required - order.totals.picked, 0)} />
                    </div>

                    <p className="mt-3 text-[13px] text-[#667a88]">
                      Customer: <span className="font-semibold text-primary">{order.customerName ?? 'Unavailable'}</span>
                    </p>
                  </div>
                  );
                })}
              </div>
            </DetailSection>
          </>
        ) : selectedTask ? (
          <>
            {selectedTask.itemChange ? <OrderChangeAlert task={selectedTask} /> : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <TopMetaCard
                label="Status"
                value={(
                  <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStatusTone(selectedStatusLabel)}`}>
                    {selectedStatusLabel}
                  </span>
                )}
              />
              <TopMetaCard
                label={mode === 'pick' ? 'Order date' : 'Tracking'}
                value={(
                  <span className="text-sm font-semibold text-primary">
                    {mode === 'pick'
                      ? formatOrderDate(selectedTask.orderDateLocal, selectedTask.orderDate)
                      : selectedTask.tracking ?? 'Awaiting tracking'}
                  </span>
                )}
              />
            </div>

            {(() => {
              const displayIssueReason = resolveDisplayIssueReason(selectedTask);
              return displayIssueReason ? (
                <div className="rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-700">Issue reason</p>
                  <p className="mt-1 text-sm text-amber-900">{displayIssueReason}</p>
                </div>
              ) : null;
            })()}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryTile label="Required" value={selectedTask.totals.required} />
              <SummaryTile label="Picked" value={selectedTask.totals.picked} />
              <SummaryTile label="Packed" value={selectedTask.totals.packed} />
              <SummaryTile label="Remaining" value={selectedTask.totals.remaining} />
            </div>

            {mode === 'pick' && ['READY', 'PARTIAL', 'RESTOCKING'].includes(selectedTask.status) ? (
              <FulfillmentItemAdjustmentSection
                task={selectedTask}
                canAdjust={canAdjustFulfillmentItems}
                onApplied={onRefresh}
              />
            ) : null}

            {canPrioritizeSelectedTask ? (
              <DetailSection
                title="Priority allocation"
                description="Move soft allocation from selected ready orders so this order can become claimable first."
              >
                {priorityError ? (
                  <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    {priorityError}
                  </div>
                ) : null}

                {priorityNotice ? (
                  <div className="rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    {priorityNotice}
                  </div>
                ) : null}

                {priorityPreview ? (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <LineMetric label="Shortage" value={priorityPreview.summary.targetShortage} />
                      <LineMetric label="Selected cover" value={selectedPrioritySuggestedQty} />
                      <LineMetric label="Donors" value={priorityPreview.donors.length} />
                    </div>

                    <div className="rounded-[18px] border border-[#e6edf1] bg-[#fbfcfc] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-primary">Recommended donor orders</p>
                          <p className="mt-1 text-[13px] text-[#667a88]">
                            Select enough unclaimed ready or partial orders to cover {priorityPreview.summary.targetShortage} unit{priorityPreview.summary.targetShortage === 1 ? '' : 's'}.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setPriorityPreview(null);
                            setSelectedDonorIds([]);
                            setPriorityError(null);
                            setPriorityNotice(null);
                          }}
                          className="text-[13px] font-semibold text-[#4d6677] transition hover:text-primary"
                        >
                          Clear
                        </button>
                      </div>

                      <div className="mt-3 space-y-2">
                        {priorityPreview.donors.map((donor) => {
                          const checked = selectedDonorIds.includes(donor.id);
                          return (
                            <label
                              key={donor.id}
                              className="flex cursor-pointer items-start gap-3 rounded-[16px] border border-[#e3eaef] bg-white px-3 py-3"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) => {
                                  setSelectedDonorIds((current) => (
                                    event.target.checked
                                      ? [...current, donor.id]
                                      : current.filter((value) => value !== donor.id)
                                  ));
                                }}
                                className="mt-1 h-4 w-4 rounded border-[#c6d4dd] text-[#12384b] focus:ring-[#12384b]"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <p className="text-sm font-semibold text-primary">
                                    Order #{donor.posOrderId} · {donor.statusLabel}
                                  </p>
                                  <p className="text-[12px] font-semibold text-[#4d6677]">
                                    Suggested {donor.suggestedGiveQty} / Releasable {donor.releasableQty}
                                  </p>
                                </div>
                                <p className="mt-1 text-[13px] text-[#667a88]">
                                  {donor.customerName ?? 'Customer unavailable'} · {donor.dateLocal ?? 'No order date'}
                                </p>
                                <p className="mt-1 text-[12px] text-[#8193a0]">
                                  {donor.lines.map((line) => `${line.productName} (${line.suggestedGiveQty}/${line.releasableQty})`).join(' · ')}
                                </p>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    {selectedPrioritySuggestedQty < priorityPreview.summary.targetShortage ? (
                      <div className="rounded-[18px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                        Selected donors cover only {selectedPrioritySuggestedQty} of {priorityPreview.summary.targetShortage} required unit{priorityPreview.summary.targetShortage === 1 ? '' : 's'}.
                      </div>
                    ) : null}

                    <div className="flex flex-wrap justify-end gap-2">
                      {selectedTask.priority?.isPrioritized ? (
                        <button
                          type="button"
                          onClick={() => void handleReleasePriority({
                            selectedTask,
                            onRefresh,
                            setIsReleasingPriority,
                            setPriorityError,
                            setPriorityNotice,
                            setPriorityPreview,
                            setSelectedDonorIds,
                          })}
                          disabled={isReleasingPriority || isApplyingPriority}
                          className="btn btn-md btn-outline"
                        >
                          {isReleasingPriority ? 'Releasing…' : 'Release priority'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void handleApplyPriority({
                          selectedTask,
                          selectedDonorIds,
                          onRefresh,
                          setIsApplyingPriority,
                          setPriorityError,
                          setPriorityNotice,
                          setPriorityPreview,
                          setSelectedDonorIds,
                        })}
                        disabled={isApplyingPriority || selectedDonorIds.length === 0 || selectedPrioritySuggestedQty < priorityPreview.summary.targetShortage}
                        className="btn btn-md btn-primary"
                      >
                        {isApplyingPriority ? 'Prioritizing…' : 'Prioritize order'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-[#e6edf1] bg-[#fbfcfc] px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-primary">
                        {selectedTask.priority?.isPrioritized ? 'Priority override is active' : 'Preview donor orders'}
                      </p>
                      <p className="mt-1 text-[13px] text-[#667a88]">
                        {selectedTask.priority?.isPrioritized
                          ? 'This order already has priority. Load the donor list to review or release it.'
                          : 'Load unclaimed ready or partial donor orders, then choose which ones should give up their soft allocation.'}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {selectedTask.priority?.isPrioritized ? (
                        <button
                          type="button"
                          onClick={() => void handleReleasePriority({
                            selectedTask,
                            onRefresh,
                            setIsReleasingPriority,
                            setPriorityError,
                            setPriorityNotice,
                            setPriorityPreview,
                            setSelectedDonorIds,
                          })}
                          disabled={isReleasingPriority || isPriorityPreviewLoading}
                          className="btn btn-md btn-outline"
                        >
                          {isReleasingPriority ? 'Releasing…' : 'Release priority'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void handleLoadPriorityPreview({
                          selectedTask,
                          setIsPriorityPreviewLoading,
                          setPriorityError,
                          setPriorityNotice,
                          setPriorityPreview,
                          setSelectedDonorIds,
                        })}
                        disabled={isPriorityPreviewLoading || isReleasingPriority}
                        className="btn btn-md btn-primary"
                      >
                        {isPriorityPreviewLoading ? 'Loading…' : 'Load donors'}
                      </button>
                    </div>
                  </div>
                )}
              </DetailSection>
            ) : null}

            <DetailSection title="Order summary" description="Core order details and current queue assignment.">
              <div className="grid gap-3 sm:grid-cols-2">
                <InfoCard label="Customer" value={selectedTask.customer.name ?? 'Unavailable'} />
                <InfoCard label="Phone" value={selectedTask.customer.phone ?? 'Unavailable'} />
                <InfoCard label={actorHeader} value={selectedActor ?? 'Not started'} />
                <InfoCard label={middleHeader} value={selectedMiddleValue ?? 'Unavailable'} />
                <InfoCard label={lastHeader} value={selectedLastValue ?? 'Unavailable'} />
                <InfoCard label="Claimed at" value={formatDateTime(selectedTask.claimedAt)} />
                <InfoCard label="Completed at" value={formatDateTime(selectedTask.completedAt)} />
                <InfoCard label="Units" value={`${selectedTask.totals.picked}/${selectedTask.totals.required} picked`} />
              </div>
            </DetailSection>

            <DetailSection
              title="Order items"
              description={`${selectedLines.length} line${selectedLines.length === 1 ? '' : 's'} currently visible in this order.`}
            >
              {selectedLines.length > 0 ? (
                <div className="space-y-3">
                  {selectedLines.map((line) => (
                    <div key={line.id} className="rounded-[20px] border border-[#e6edf1] bg-[#fbfcfc] px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-primary">{line.productName}</p>
                          <p className="mt-1 text-[13px] text-[#667a88]">
                            {line.productDisplayId ? `Code ${line.productDisplayId}` : 'No product code'}
                          </p>
                        </div>
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStatusTone(line.statusLabel)}`}>
                          {line.statusLabel}
                        </span>
                      </div>

                      <div className="mt-3 grid gap-2 sm:grid-cols-3">
                        <LineMetric label="Required" value={line.required} />
                        <LineMetric label="Allocated" value={line.allocated} />
                        <LineMetric label="Shortage" value={line.shortage} />
                      </div>

                      {line.issueReason ? (
                        <p className="mt-3 text-xs text-amber-700">{line.issueReason}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-[20px] border border-dashed border-[#d7e0e7] bg-[#fbfcfc] px-4 py-6 text-sm text-[#6f8290]">
                  No order lines available.
                </div>
              )}
            </DetailSection>
          </>
        ) : null}
      </WmsSidePanel>
    </>
  );
}

async function handleLoadPriorityPreview(params: {
  selectedTask: WmsFulfillmentQueueTask;
  setIsPriorityPreviewLoading: (value: boolean) => void;
  setPriorityError: (value: string | null) => void;
  setPriorityNotice: (value: string | null) => void;
  setPriorityPreview: (value: WmsFulfillmentPriorityPreviewResponse | null) => void;
  setSelectedDonorIds: (value: string[]) => void;
}) {
  params.setIsPriorityPreviewLoading(true);
  params.setPriorityError(null);
  params.setPriorityNotice(null);

  try {
    const preview = await fetchWmsFulfillmentPriorityPreview({
      orderId: params.selectedTask.id,
      tenantId: params.selectedTask.store?.tenantId ?? null,
    });

    params.setPriorityPreview(preview);
    params.setSelectedDonorIds(
      preview.donors
        .filter((donor) => donor.suggestedGiveQty > 0)
        .map((donor) => donor.id),
    );
  } catch (error) {
    params.setPriorityError(resolveQueueActionError(error));
  } finally {
    params.setIsPriorityPreviewLoading(false);
  }
}

async function handleApplyPriority(params: {
  selectedTask: WmsFulfillmentQueueTask;
  selectedDonorIds: string[];
  onRefresh?: (() => Promise<unknown> | unknown) | undefined;
  setIsApplyingPriority: (value: boolean) => void;
  setPriorityError: (value: string | null) => void;
  setPriorityNotice: (value: string | null) => void;
  setPriorityPreview: (value: WmsFulfillmentPriorityPreviewResponse | null) => void;
  setSelectedDonorIds: (value: string[]) => void;
}) {
  params.setIsApplyingPriority(true);
  params.setPriorityError(null);
  params.setPriorityNotice(null);

  try {
    const result = await prioritizeWmsFulfillmentOrder({
      orderId: params.selectedTask.id,
      donorOrderIds: params.selectedDonorIds,
      tenantId: params.selectedTask.store?.tenantId ?? null,
      reason: `Priority override applied to order #${params.selectedTask.posOrderId}`,
    });

    await Promise.resolve(params.onRefresh?.());
    params.setPriorityPreview(null);
    params.setSelectedDonorIds([]);
    params.setPriorityNotice(
      `Order #${result.targetPosOrderId} prioritized. ${result.summary.totalSuggestedQty} unit(s) were released from ${result.summary.donorOrders} donor order(s).`,
    );
  } catch (error) {
    params.setPriorityError(resolveQueueActionError(error));
  } finally {
    params.setIsApplyingPriority(false);
  }
}

async function handleReleasePriority(params: {
  selectedTask: WmsFulfillmentQueueTask;
  onRefresh?: (() => Promise<unknown> | unknown) | undefined;
  setIsReleasingPriority: (value: boolean) => void;
  setPriorityError: (value: string | null) => void;
  setPriorityNotice: (value: string | null) => void;
  setPriorityPreview: (value: WmsFulfillmentPriorityPreviewResponse | null) => void;
  setSelectedDonorIds: (value: string[]) => void;
}) {
  params.setIsReleasingPriority(true);
  params.setPriorityError(null);
  params.setPriorityNotice(null);

  try {
    const result = await releaseWmsFulfillmentPriority({
      orderId: params.selectedTask.id,
      tenantId: params.selectedTask.store?.tenantId ?? null,
    });

    await Promise.resolve(params.onRefresh?.());
    params.setPriorityPreview(null);
    params.setSelectedDonorIds([]);
    params.setPriorityNotice(
      `Priority override released for order #${result.targetPosOrderId}. Donor orders can be allocated again.`,
    );
  } catch (error) {
    params.setPriorityError(resolveQueueActionError(error));
  } finally {
    params.setIsReleasingPriority(false);
  }
}

function OrderChangeAlert({ task }: { task: WmsFulfillmentQueueTask }) {
  const change = task.itemChange;
  if (!change) return null;
  const returnSteps = change.returnSteps ?? [];
  const pickSteps = change.pickSteps ?? [];

  return (
    <div className={`rounded-xl border px-4 py-3 ${change.requiresAction ? 'border-warning/30 bg-warning-soft/45' : 'border-info/30 bg-info-soft'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${change.requiresAction ? 'text-warning' : 'text-primary'}`}>
            {change.requiresAction ? 'Order change note · Rework required' : 'Order change note · Automatic revision'}
          </p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {change.title}
          </p>
          <p className="mt-1 text-sm-custom text-muted">
            {change.message}
          </p>
        </div>
        <span className="pill bg-surface text-primary">
          Automatic revision
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold text-muted">
        <span className="pill bg-surface text-foreground">Order #{change.order?.posOrderId ?? task.posOrderId}</span>
        <span className="pill bg-surface text-muted">
          {change.order?.tracking ?? task.tracking ? `Waybill ${change.order?.tracking ?? task.tracking}` : 'No waybill yet'}
        </span>
        {change.addedUnits > 0 ? <span className="pill bg-surface">+{change.addedUnits} to pick</span> : null}
        {change.removedUnits > 0 ? <span className="pill bg-surface">−{change.removedUnits} removed</span> : null}
        {change.returnUnitsRemaining > 0 ? <span className="pill bg-surface">{change.returnUnitsRemaining} to return</span> : null}
      </div>

      {returnSteps.length > 0 || pickSteps.length > 0 ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {returnSteps.map((step) => (
            <div key={`return-${step.variationId}`} className="rounded-xl border border-destructive/20 bg-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs-tight font-semibold uppercase text-destructive">Remove & return · {step.quantity}</p>
                  <p className="mt-1 truncate text-sm font-semibold text-foreground">{step.productName}</p>
                  <p className="mt-1 text-xs text-muted">Item {step.productDisplayId ?? step.variationId}</p>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {step.serializedUnits.map((unit) => (
                  <div key={unit.id} className="flex items-center justify-between gap-3 rounded-lg bg-secondary/35 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs-tight font-semibold uppercase text-muted">Serialized code</p>
                      <p className="truncate text-sm font-semibold text-foreground">{unit.code ?? unit.barcode ?? 'Scan label'}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs-tight font-semibold uppercase text-muted">Return to</p>
                      <p className="text-sm font-semibold text-primary">{unit.sourceBin?.code ?? 'Original bin unavailable'}</p>
                    </div>
                  </div>
                ))}
                {step.unidentifiedQuantity > 0 ? (
                  <p className="rounded-lg bg-destructive-soft/55 px-3 py-2 text-xs font-semibold text-destructive">
                    {step.unidentifiedQuantity} serialized unit {step.unidentifiedQuantity === 1 ? 'is' : 'are'} not linked to this order. Match item {step.productDisplayId ?? step.variationId} in this basket and scan its label.
                  </p>
                ) : null}
              </div>
            </div>
          ))}

          {pickSteps.map((step) => (
            <div key={`pick-${step.variationId}`} className="rounded-xl border border-primary/20 bg-surface p-3">
              <div className="min-w-0">
                <p className="text-xs-tight font-semibold uppercase text-primary">Add & pick · {step.quantity}</p>
                <p className="mt-1 truncate text-sm font-semibold text-foreground">{step.productName}</p>
                <p className="mt-1 text-xs text-muted">Item {step.productDisplayId ?? step.variationId}</p>
              </div>

              <div className="mt-3 space-y-2">
                {step.serializedUnits.map((unit) => (
                  <div key={unit.id} className="flex items-center justify-between gap-3 rounded-lg bg-secondary/35 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs-tight font-semibold uppercase text-muted">Pick serialized code</p>
                      <p className="truncate text-sm font-semibold text-foreground">{unit.code ?? unit.barcode ?? 'Scan label'}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs-tight font-semibold uppercase text-muted">From bin</p>
                      <p className="text-sm font-semibold text-primary">{unit.sourceBin?.code ?? 'Bin unavailable'}</p>
                    </div>
                  </div>
                ))}

                {step.sourceBins.map((source) => (
                  <div key={source.location.id} className="flex items-center justify-between gap-3 rounded-lg bg-secondary/35 px-3 py-2">
                    <div>
                      <p className="text-xs-tight font-semibold uppercase text-muted">Pick from bin</p>
                      <p className="text-sm font-semibold text-primary">{source.location.code}</p>
                    </div>
                    <p className="text-xs font-semibold text-muted">{source.quantity} unit{source.quantity === 1 ? '' : 's'}</p>
                  </div>
                ))}

                {step.scanAnyMatchingUnit ? (
                  <p className="text-xs text-muted">At the bin, scan any serialized unit matching item {step.productDisplayId ?? step.variationId}.</p>
                ) : null}

                {step.unallocatedQuantity > 0 ? (
                  <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs font-semibold text-warning">
                    No pickable bin is allocated for {step.unallocatedQuantity} unit{step.unallocatedQuantity === 1 ? '' : 's'}. Wait for putaway or retry allocation; do not substitute another item.
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <p className="mt-3 text-xs text-muted">
        {change.requiresAction
          ? 'Complete the return first, then follow the assigned pick bin. Packer assignment and packing remain blocked until both steps finish.'
          : task.status === 'ISSUE'
            ? 'POS item changes were synced, but this order is still blocked by an issue — review the Issue reason below.'
            : 'The current Pick list already uses the latest POS variations and quantities. No manual sync is needed.'}
      </p>
    </div>
  );
}

function TaskRow({
  mode,
  task,
  onSelect,
}: {
  mode: WmsFulfillmentQueueMode;
  task: WmsFulfillmentQueueTask;
  onSelect: () => void;
}) {
  const statusLabel = task.delivery?.label ?? task.statusLabel;
  const basketLabel = task.basket?.barcode ?? 'Unassigned';
  const actor = mode === 'pick' ? task.claimedBy?.name : task.packedBy?.name;
  const lastColumn = mode === 'pick'
    ? task.warehouse?.name ?? 'Not assigned'
    : basketLabel;
  const rowIssueReason = task.status === 'ISSUE' || task.issueReason
    ? resolveDisplayIssueReason(task)
    : null;
  const rowOrderChangeNote = task.itemChange
    ? `${task.itemChange.requiresAction ? 'Order changed · Rework required' : 'Order changed · Automatic revision'} — ${task.itemChange.message}`
    : null;

  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={`View order #${task.posOrderId}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className="cursor-pointer border-b border-[#edf2f6] text-[13px] text-primary transition hover:bg-[#fbfcfc] focus:bg-[#f7fafb] focus:outline-none"
    >
      <BodyCell className="min-w-[116px] whitespace-nowrap tabular-nums text-[#4d6677]">
        {formatOrderDate(task.orderDateLocal, task.orderDate)}
      </BodyCell>

      <BodyCell className="min-w-[220px] font-semibold">
        <div className="min-w-0">
          {rowOrderChangeNote ? (
            <div
              className={`mb-1 inline-flex max-w-[360px] items-center truncate rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                task.itemChange?.requiresAction
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : 'border-sky-200 bg-sky-50 text-sky-800'
              }`}
              title={rowOrderChangeNote}
            >
              {rowOrderChangeNote}
            </div>
          ) : null}
          <div className="truncate font-semibold text-primary">
            {`${task.store?.tenantName ?? 'Tenant'} · ${task.store?.name ?? 'Store'} · #${task.posOrderId}`}
          </div>
          {rowIssueReason ? (
            <div
              className="mt-1 max-w-[340px] truncate text-[12px] font-medium text-amber-700"
              title={rowIssueReason}
            >
              {rowIssueReason}
            </div>
          ) : null}
        </div>
      </BodyCell>

      <BodyCell>
        <div className="min-w-0">
          <div className="truncate font-semibold text-primary">{task.customer.name || 'Customer unavailable'}</div>
        </div>
      </BodyCell>

      <BodyCell>
        <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStatusTone(statusLabel)}`}>
          {statusLabel}
        </span>
      </BodyCell>

      <BodyCell>
        <div className="truncate font-semibold text-primary">{task.totals.picked}/{task.totals.required}</div>
      </BodyCell>

      <BodyCell>
        <div className="truncate font-semibold text-primary">{actor ?? 'Not started'}</div>
      </BodyCell>

      <BodyCell>
        {mode === 'pick' ? basketLabel : (task.tracking ?? 'Awaiting tracking')}
      </BodyCell>

      <BodyCell>{lastColumn}</BodyCell>
    </tr>
  );
}

function BasketRow({
  row,
  onSelect,
}: {
  row: WmsFulfillmentBasketRow;
  onSelect: () => void;
}) {
  const orderCount = row.basket.orders.length > 0 ? row.basket.orders.length : row.tasks.length;
  const previewCustomers = row.basket.orders
    .map((order) => order.customerName)
    .filter((name): name is string => Boolean(name))
    .slice(0, 2)
    .join(', ');
  const primaryStore = row.basket.orders[0]?.store ?? row.tasks[0]?.store;
  const activeOrders = row.basket.activeFulfillmentOrders > 0
    ? row.basket.activeFulfillmentOrders
    : orderCount;
  const changedBasketTasks = row.tasks.filter((task) => Boolean(task.itemChange));
  const basketRequiresRework = changedBasketTasks.some((task) => task.itemChange?.requiresAction);
  const basketChangeNote = changedBasketTasks.length > 0
    ? `${basketRequiresRework ? 'Order changed · Rework required' : 'Order changed · Automatic revision'} (${changedBasketTasks.map((task) => `#${task.posOrderId}`).join(', ')})`
    : null;

  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={`View basket ${row.basket.barcode}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className="cursor-pointer border-b border-[#edf2f6] text-[13px] text-primary transition hover:bg-[#fbfcfc] focus:bg-[#f7fafb] focus:outline-none"
    >
      <BodyCell className="min-w-[116px] whitespace-nowrap tabular-nums text-[#4d6677]">
        {formatOrderDate(row.orderDateLocal, row.orderDate)}
      </BodyCell>

      <BodyCell className="min-w-[220px] font-semibold">
        <div className="min-w-0">
          {basketChangeNote ? (
            <div
              className={`mb-1 inline-flex max-w-[340px] items-center truncate rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                basketRequiresRework
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : 'border-sky-200 bg-sky-50 text-sky-800'
              }`}
              title={basketChangeNote}
            >
              {basketChangeNote}
            </div>
          ) : null}
          <div className="truncate font-semibold text-primary">{row.basket.barcode}</div>
          <div className="mt-1 truncate text-[12px] text-[#6f8290]">
            {primaryStore?.tenantName ?? 'Tenant'} · {primaryStore?.name ?? 'Store'}
          </div>
        </div>
      </BodyCell>

      <BodyCell>
        <div className="min-w-0">
          <div className="truncate font-semibold text-primary">
            {orderCount} order{orderCount === 1 ? '' : 's'}
          </div>
          <div className="mt-1 truncate text-[12px] text-[#6f8290]">
            {previewCustomers || 'Active basket work'}
          </div>
        </div>
      </BodyCell>

      <BodyCell>
        <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStatusTone(row.basket.statusLabel)}`}>
          {row.basket.statusLabel}
        </span>
      </BodyCell>

      <BodyCell>
        <div className="truncate font-semibold text-primary">{row.totals.picked}/{row.totals.required}</div>
      </BodyCell>

      <BodyCell>
        <div className="truncate font-semibold text-primary">{row.basket.assignedPicker?.name ?? 'Not started'}</div>
      </BodyCell>

      <BodyCell>
        <div className="truncate font-semibold text-primary">{activeOrders}/{row.basket.maxFulfillmentOrders}</div>
      </BodyCell>

      <BodyCell>{row.basket.warehouse?.name ?? 'Not assigned'}</BodyCell>
    </tr>
  );
}

function QueueTableFrame({
  actorHeader,
  middleHeader,
  lastHeader,
  primaryHeader,
  secondaryHeader,
  children,
}: {
  actorHeader: string;
  middleHeader: string;
  lastHeader: string;
  primaryHeader: string;
  secondaryHeader: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0">
        <thead>
          <tr className="bg-[#eaf0f4] text-left">
            <HeaderCell>Date</HeaderCell>
            <HeaderCell>{primaryHeader}</HeaderCell>
            <HeaderCell>{secondaryHeader}</HeaderCell>
            <HeaderCell>Status</HeaderCell>
            <HeaderCell>Units</HeaderCell>
            <HeaderCell>{actorHeader}</HeaderCell>
            <HeaderCell>{middleHeader}</HeaderCell>
            <HeaderCell>{lastHeader}</HeaderCell>
          </tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

function HeaderCell({
  children,
  align = 'left',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={`bg-slate-50 px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function BodyCell({
  children,
  align = 'left',
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={`px-5 py-3 align-middle ${align === 'right' ? 'text-right' : 'text-left'} ${className}`.trim()}
    >
      {children}
    </td>
  );
}

function TopMetaCard({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="rounded-[20px] border border-[#dce4ea] bg-white px-4 py-3 shadow-[0_16px_30px_-32px_rgba(18,56,75,0.55)]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">{label}</p>
      <div className="mt-2 min-h-[24px]">{value}</div>
    </div>
  );
}

function DetailSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[24px] border border-[#dce4ea] bg-white p-4 shadow-[0_18px_34px_-34px_rgba(18,56,75,0.58)]">
      <div>
        <p className="text-base font-semibold tracking-[-0.02em] text-primary">{title}</p>
        {description ? <p className="mt-1 text-[13px] text-[#667a88]">{description}</p> : null}
      </div>

      <div className="mt-4">{children}</div>
    </section>
  );
}

function SummaryTile({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-[20px] border border-[#dce4ea] bg-white px-4 py-3 shadow-[0_16px_30px_-32px_rgba(18,56,75,0.55)]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">{label}</p>
      <p className="mt-2 text-[32px] font-semibold leading-none tracking-[-0.03em] text-primary">{value}</p>
    </div>
  );
}

function InfoCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[18px] border border-[#e6edf1] bg-[#fbfcfc] px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8193a0]">{label}</p>
      <p className="mt-2 break-words text-[15px] font-semibold leading-snug text-primary">{value}</p>
    </div>
  );
}

function LineMetric({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-[14px] border border-[#e8eef2] bg-white px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8193a0]">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-primary">{value}</p>
    </div>
  );
}

function buildBasketDescription(row: WmsFulfillmentBasketRow) {
  const primaryStore = row.basket.orders[0]?.store ?? row.tasks[0]?.store;
  const warehouseName = row.basket.warehouse?.name;
  const descriptionParts = [
    primaryStore?.tenantName ?? 'Tenant',
    primaryStore?.name ?? `${row.basket.orders.length} orders`,
  ];

  if (warehouseName) {
    descriptionParts.push(warehouseName);
  }

  return descriptionParts.join(' · ');
}

function formatOrderDate(dateLocal: string | null, raw: string) {
  if (dateLocal) {
    return dateLocal;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw.slice(0, 10) : DATE_FORMATTER.format(parsed);
}

function formatDateTime(raw: string | null) {
  if (!raw) {
    return 'Not available';
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : DATE_TIME_FORMATTER.format(parsed);
}

function getVisibleQueueLines(task: WmsFulfillmentQueueTask) {
  return task.lines.filter(
    (line) => line.status !== 'CANCELED' && (line.required > 0 || line.status === 'ISSUE'),
  );
}

function resolveDisplayIssueReason(task: WmsFulfillmentQueueTask): string | null {
  const explicit = task.issueReason?.trim();
  if (explicit) {
    return explicit;
  }

  if (task.status !== 'ISSUE') {
    return null;
  }

  const issueLine = task.lines.find(
    (line) => line.status !== 'CANCELED' && (line.status === 'ISSUE' || Boolean(line.issueReason?.trim())),
  );
  if (issueLine) {
    const lineReason = issueLine.issueReason?.trim();
    if (lineReason) {
      return issueLine.productName ? `${issueLine.productName}: ${lineReason}` : lineReason;
    }
    return issueLine.productName
      ? `${issueLine.productName}: Order item has a fulfillment issue — review line item.`
      : 'Order item has a fulfillment issue — review order line items.';
  }

  if (task.totals.required <= 0) {
    if (task.fulfillmentAdjustment) {
      return 'All pickable items on this order were bypassed to zero quantity — no units remain to pick.';
    }
    return 'Order has no pickable variation items — verify product variation links in Pancake POS or click Resync queue.';
  }

  return `Order remained in Issue status after a POS item revision (${task.totals.required} required unit${task.totals.required === 1 ? '' : 's'}) — click Resync queue or Reallocate waiting to refresh pick readiness.`;
}

function getStatusTone(statusLabel: string) {
  const normalized = statusLabel.toLowerCase();

  if (normalized.includes('delivered')) {
    return 'bg-emerald-50 text-emerald-700';
  }

  if (normalized.includes('shipped')) {
    return 'bg-sky-50 text-sky-700';
  }

  if (normalized.includes('pack')) {
    return 'bg-violet-50 text-violet-700';
  }

  if (normalized.includes('restock') || normalized.includes('issue')) {
    return 'bg-amber-50 text-amber-700';
  }

  if (normalized.includes('ready')) {
    return 'bg-success-soft text-success';
  }

  return 'bg-slate-100 text-slate-700';
}

function resolveQueueActionError(error: unknown) {
  const fallback = 'Unable to complete the queue action right now.';

  if (typeof error !== 'object' || error === null) {
    return fallback;
  }

  const maybeResponse = (error as {
    response?: {
      data?: {
        message?: string | string[];
        error?: string;
      };
    };
    message?: string;
  }).response?.data;

  if (Array.isArray(maybeResponse?.message) && maybeResponse.message.length > 0) {
    return maybeResponse.message.join(' ');
  }

  if (typeof maybeResponse?.message === 'string' && maybeResponse.message.trim()) {
    return maybeResponse.message;
  }

  if (typeof maybeResponse?.error === 'string' && maybeResponse.error.trim()) {
    return maybeResponse.error;
  }

  if (typeof (error as { message?: string }).message === 'string' && (error as { message?: string }).message?.trim()) {
    return (error as { message: string }).message;
  }

  return fallback;
}

const ACTIVE_PICK_BASKET_STATUSES = new Set(['ASSIGNED', 'IN_PICKING', 'FULL_HELD']);

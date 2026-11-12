'use client';

import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { CheckCircle2, CornerDownLeft, PackageOpen, RefreshCcw, ShieldAlert, Slash } from 'lucide-react';
import { WmsCompactPanel } from '../../_components/wms-compact-panel';
import { WmsInlineNotice } from '../../_components/wms-inline-notice';
import { WmsModal } from '../../_components/wms-modal';
import { FulfillmentBasketUnitManifest } from './fulfillment-basket-unit-manifest';
import type {
  WmsFulfillmentBasketPackPlan,
  WmsFulfillmentBasketPackValidation,
  WmsFulfillmentQueueReservation,
  WmsFulfillmentQueueTask,
} from '../_types/fulfillment';

type BasketPackView = {
  basket: NonNullable<WmsFulfillmentQueueTask['basket']>;
  tasks: WmsFulfillmentQueueTask[];
  plan: WmsFulfillmentBasketPackPlan;
  validation: WmsFulfillmentBasketPackValidation;
};

type FulfillmentPackExecutionPanelProps = {
  basketView: BasketPackView | null;
  canDirectVoid: boolean;
  canExecute: boolean;
  isRefreshing: boolean;
  isSubmitting: boolean;
  task: WmsFulfillmentQueueTask | null;
  onCompleteBasketOrder: (task: WmsFulfillmentQueueTask, orderId: string) => Promise<boolean>;
  onLoadBasketPlan: (task: WmsFulfillmentQueueTask) => Promise<unknown>;
  onRefresh: () => void;
  onScanBasketUnit: (task: WmsFulfillmentQueueTask, orderId: string, code: string) => Promise<boolean>;
  onScanBasketWaybill: (task: WmsFulfillmentQueueTask, code: string) => Promise<boolean>;
  onStart: (task: WmsFulfillmentQueueTask) => Promise<boolean>;
  onScanUnit: (task: WmsFulfillmentQueueTask, code: string) => Promise<boolean>;
  onVerifyTracking: (task: WmsFulfillmentQueueTask, code: string) => Promise<string | null>;
  onComplete: (task: WmsFulfillmentQueueTask, trackingCode: string) => Promise<boolean>;
  onVoidOrders: (params: {
    task: WmsFulfillmentQueueTask;
    orderIds: string[];
    reason: string;
    supervisorIdentifier?: string | null;
    supervisorPassword?: string | null;
  }) => Promise<boolean>;
  onVoid: (params: {
    task: WmsFulfillmentQueueTask;
    reason: string;
    supervisorIdentifier?: string | null;
    supervisorPassword?: string | null;
  }) => Promise<boolean>;
};

function useScannerKeyboardCapture({
  enabled,
  inputRef,
  onScannedValue,
  onSubmit,
}: {
  enabled: boolean;
  inputRef: RefObject<HTMLInputElement>;
  onScannedValue: (value: string) => void;
  onSubmit: (value: string) => void | Promise<void>;
}) {
  const submitRef = useRef(onSubmit);
  const changeRef = useRef(onScannedValue);
  const bufferRef = useRef('');
  const lastKeyAtRef = useRef(0);

  useEffect(() => {
    submitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    changeRef.current = onScannedValue;
  }, [onScannedValue]);

  useEffect(() => {
    if (!enabled) {
      bufferRef.current = '';
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      if (isEditableElement(target)) {
        return;
      }

      const now = Date.now();
      if (now - lastKeyAtRef.current > 250) {
        bufferRef.current = '';
      }
      lastKeyAtRef.current = now;

      if (event.key === 'Escape') {
        bufferRef.current = '';
        return;
      }

      if (event.key === 'Backspace') {
        bufferRef.current = bufferRef.current.slice(0, -1);
        return;
      }

      if (event.key === 'Enter') {
        const scannedValue = bufferRef.current.trim();
        bufferRef.current = '';
        if (!scannedValue) {
          return;
        }

        event.preventDefault();
        changeRef.current(scannedValue);
        window.setTimeout(() => {
          inputRef.current?.focus();
        }, 0);
        void submitRef.current(scannedValue);
        return;
      }

      if (event.key.length !== 1) {
        return;
      }

      bufferRef.current += event.key;
      changeRef.current(bufferRef.current);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, inputRef]);
}

function usePackCompleteHotkey({
  enabled,
  onTrigger,
}: {
  enabled: boolean;
  onTrigger: () => void | Promise<void>;
}) {
  const triggerRef = useRef(onTrigger);

  useEffect(() => {
    triggerRef.current = onTrigger;
  }, [onTrigger]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.key !== 'F9') {
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      const scannerFocused = target?.getAttribute('data-scanner-input') === 'true';
      if (isEditableElement(target) && !scannerFocused) {
        return;
      }

      event.preventDefault();
      void triggerRef.current();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled]);
}

export function FulfillmentPackExecutionPanel({
  basketView,
  canDirectVoid,
  canExecute,
  isRefreshing,
  isSubmitting,
  task,
  onCompleteBasketOrder,
  onLoadBasketPlan,
  onRefresh,
  onScanBasketUnit,
  onScanBasketWaybill,
  onStart,
  onScanUnit,
  onVerifyTracking,
  onComplete,
  onVoidOrders,
  onVoid,
}: FulfillmentPackExecutionPanelProps) {
  const [unitCode, setUnitCode] = useState('');
  const [trackingCode, setTrackingCode] = useState('');
  const [verifiedTracking, setVerifiedTracking] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [supervisorIdentifier, setSupervisorIdentifier] = useState('');
  const [supervisorPassword, setSupervisorPassword] = useState('');
  const [selectedVoidOrderIds, setSelectedVoidOrderIds] = useState<string[]>([]);
  const [voidOpen, setVoidOpen] = useState(false);
  const unitInputRef = useRef<HTMLInputElement>(null);
  const trackingInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setUnitCode('');
    setTrackingCode('');
    setVerifiedTracking(null);
    setVoidReason('');
    setSupervisorIdentifier('');
    setSupervisorPassword('');
    setSelectedVoidOrderIds([]);
    setVoidOpen(false);
  }, [task?.id]);

  useEffect(() => {
    if (!task || task.status !== 'PACKING') {
      return;
    }

    const timer = window.setTimeout(() => {
      const packedAll = task.totals.packed >= task.totals.required && task.totals.required > 0;
      if (!packedAll) {
        unitInputRef.current?.focus();
      } else {
        trackingInputRef.current?.focus();
      }
    }, 120);

    return () => window.clearTimeout(timer);
  }, [task]);

  useEffect(() => {
    if (!task || task.assignmentMode !== 'BASKET_DEMAND' || !task.basket?.id || basketView) {
      return;
    }

    void onLoadBasketPlan(task);
  }, [basketView, onLoadBasketPlan, task]);

  const tracking = task?.tracking?.trim() || null;
  const packedAll = Boolean(task && task.totals.packed >= task.totals.required && task.totals.required > 0);
  const nextUnit = task ? getNextPackReservation(task) : null;
  const canStart = Boolean(task && task.status === 'PICKED' && tracking && canExecute);
  const isPacking = task?.status === 'PACKING';
  const isPacked = task?.status === 'PACKED';
  const packAssignedAt = task ? resolvePackAssignedAt(task) : null;
  const isDemandBasketTask = task?.assignmentMode === 'BASKET_DEMAND' && Boolean(task.basket?.id);
  const voidEligibleBasketOrders = useMemo(
    () => (task?.basket?.orders ?? []).filter((order) => order.status === 'PICKED' || order.status === 'PACKING'),
    [task?.basket?.orders],
  );
  const selectedVoidOrderIdSet = useMemo(() => new Set(selectedVoidOrderIds), [selectedVoidOrderIds]);
  const allVoidEligibleSelected = voidEligibleBasketOrders.length > 0
    && selectedVoidOrderIds.length === voidEligibleBasketOrders.length;

  const items = useMemo(() => (task ? getVisiblePackLines(task.lines) : []), [task]);

  const submitPackedUnit = async (scannedValue?: string) => {
    const code = (scannedValue ?? unitCode).trim();
    if (!task || !code || isSubmitting || packedAll) {
      unitInputRef.current?.focus();
      return;
    }

    const ok = await onScanUnit(task, code);
    if (ok) {
      setUnitCode('');
    } else {
      setUnitCode('');
    }
    window.setTimeout(() => {
      unitInputRef.current?.focus();
    }, 80);
  };

  const submitTrackedWaybill = async (scannedValue?: string) => {
    const code = (scannedValue ?? trackingCode).trim();
    if (!task || !code || isSubmitting) {
      trackingInputRef.current?.focus();
      return;
    }

    const verified = await onVerifyTracking(task, code);
    if (verified) {
      setTrackingCode(verified);
      setVerifiedTracking(verified);
    } else {
      setTrackingCode('');
      setVerifiedTracking(null);
    }
    window.setTimeout(() => {
      trackingInputRef.current?.focus();
    }, 80);
  };

  useEffect(() => {
    setSelectedVoidOrderIds((current) => current.filter((orderId) => (
      (task?.basket?.orders ?? []).some((order) => order.id === orderId)
    )));
  }, [task?.basket?.orders]);

  useScannerKeyboardCapture({
    enabled: Boolean(task && canExecute && isPacking && !packedAll && !voidOpen),
    inputRef: unitInputRef,
    onScannedValue: setUnitCode,
    onSubmit: submitPackedUnit,
  });

  useScannerKeyboardCapture({
    enabled: Boolean(task && canExecute && isPacking && packedAll && !voidOpen),
    inputRef: trackingInputRef,
    onScannedValue: (value) => {
      setTrackingCode(value);
      setVerifiedTracking(null);
    },
    onSubmit: submitTrackedWaybill,
  });

  usePackCompleteHotkey({
    enabled: Boolean(task && canExecute && isPacking && packedAll && verifiedTracking && !isSubmitting && !voidOpen),
    onTrigger: async () => {
      if (!task || !verifiedTracking) {
        return;
      }
      await onComplete(task, verifiedTracking ?? trackingCode);
    },
  });

  if (!task) {
    return (
      <WmsCompactPanel title="Pack Execution" icon={<PackageOpen className='panel-icon'/>}>
        <div className="flex min-h-[520px] items-center justify-center rounded-2xl border border-dashed border-[#d7e0e7] bg-[#fbfcfc] px-8 py-10 text-center">
          <div className="max-w-sm">
            <p className="form-label">Pack window</p>
            <h3 className="mt-3 text-xl font-semibold tracking-tight text-primary">Select a pack order</h3>
            {/* <p className="mt-3 text-sm leading-6 text-[#607482]">
              This execution window will let packers start packing, scan units, verify waybills, complete packing, and void orders when permitted.
            </p> */}
          </div>
        </div>
      </WmsCompactPanel>
    );
  }

  if (isDemandBasketTask) {
    return (
      <DemandBasketPackExecutionPanel
        basketView={basketView}
        canDirectVoid={canDirectVoid}
        canExecute={canExecute}
        isRefreshing={isRefreshing}
        isSubmitting={isSubmitting}
        task={task}
        voidOpen={voidOpen}
        voidReason={voidReason}
        supervisorIdentifier={supervisorIdentifier}
        supervisorPassword={supervisorPassword}
        selectedVoidOrderIds={selectedVoidOrderIds}
        setVoidOpen={setVoidOpen}
        setVoidReason={setVoidReason}
        setSupervisorIdentifier={setSupervisorIdentifier}
        setSupervisorPassword={setSupervisorPassword}
        setSelectedVoidOrderIds={setSelectedVoidOrderIds}
        onCompleteBasketOrder={onCompleteBasketOrder}
        onRefresh={onRefresh}
        onScanBasketUnit={onScanBasketUnit}
        onScanBasketWaybill={onScanBasketWaybill}
        onVoidOrders={onVoidOrders}
      />
    );
  }

  return (
    <>
      <WmsCompactPanel title="Pack Execution" icon={<PackageOpen className='panel-icon'/>}>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
              
            <h3 className="truncate text-[18px] font-semibold tracking-tight text-primary">{task.store?.tenantName ?? 'Tenant'} · {task.store?.name ?? 'Store'} &middot; #{task.posOrderId}</h3>
          </div>

          <span className={`inline-flex rounded-full px-3 py-1.5 text-[12px] font-semibold ${getStatusTone(resolvePackStateLabel(task, tracking))}`}>
            {resolvePackStateLabel(task, tracking)}
         </span>
        </div>

        <div className="mt-5 space-y-5">
          {task.itemChange ? (
            <div className={`rounded-[16px] border px-4 py-3 ${task.itemChange.requiresAction ? 'border-[#ffd8cc] bg-[#fff4f1]' : 'border-sky-200 bg-sky-50'}`}>
              <p className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${task.itemChange.requiresAction ? 'text-[#c2410c]' : 'text-sky-700'}`}>
                {task.itemChange.requiresAction ? 'Order change note · Rework required' : 'Order change note · Automatic revision'}
              </p>
              <p className={`mt-1 text-[13px] font-semibold ${task.itemChange.requiresAction ? 'text-[#9a3412]' : 'text-sky-950'}`}>
                {task.itemChange.title}
              </p>
              <p className={`mt-1 text-[12px] ${task.itemChange.requiresAction ? 'text-[#9a3412]' : 'text-sky-900'}`}>
                {task.itemChange.message}
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-3 md:flex-row">
            <div className="md:flex-1">
              <MetricTile label="Packed" value={`${task.totals.packed}/${task.totals.required}`} note="Units verified" />
            </div>
            <div className="md:flex-1">
              <MetricTile
                label="Basket"
                value={task.basket?.barcode ?? 'None'}
                note={task.basket ? formatPackBasketSlotNote(task.basket) : 'No basket'}
              />
            </div>
            <div className="md:flex-1">
              <MetricTile label="Tracking" value={tracking ?? 'Missing'} note={tracking ? 'Waybill ready' : 'Awaiting print'} />
            </div>
          </div>

          <div className="flex flex-col gap-5 xl:flex-row">
            <div className="xl:min-w-0 xl:flex-1">
              <div className="card">
                <p className="card-label">Handoff</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <KeyValue label="Picker" value={task.claimedBy?.name ?? task.claimedBy?.email ?? 'Unknown'} />
                  <KeyValue label="Packer" value={task.basket?.assignedPacker?.name ?? task.packedBy?.name ?? 'Assigned queue'} />
                  <KeyValue label="Customer" value={task.customer.name ?? 'Unavailable'} />
                  <KeyValue label="Pack assigned" value={packAssignedAt ?? 'Waiting for handoff'} />
                </div>
              </div>

              <div className="card mt-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">Basket orders</p>
                    <p className="mt-1 text-[12px] text-[#6f8290]">
                      {isDemandBasketTask ? 'Select basket orders to void when needed.' : 'Current order stays highlighted.'}
                    </p>
                  </div>
                  <span className="text-[12px] font-semibold text-[#6b4eff]">
                    {task.basket?.orders?.length ?? 0}
                  </span>
                </div>
                {isDemandBasketTask && voidEligibleBasketOrders.length > 0 ? (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-[16px] border border-[#ece6fa] bg-[#faf8ff] px-4 py-3">
                    <p className="text-[12px] font-semibold text-[#6f8290]">
                      {selectedVoidOrderIds.length > 0 ? `${selectedVoidOrderIds.length} selected` : 'Select orders'}
                    </p>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setSelectedVoidOrderIds(allVoidEligibleSelected ? [] : voidEligibleBasketOrders.map((order) => order.id))}
                        className="text-[12px] font-semibold text-[#6b4eff]"
                      >
                        {allVoidEligibleSelected ? 'Clear' : 'Select all'}
                      </button>
                      <button
                        type="button"
                        disabled={selectedVoidOrderIds.length === 0 || isSubmitting || !canExecute}
                        onClick={() => setVoidOpen(true)}
                        className="inline-flex items-center rounded-full border border-[#ffd5cf] bg-[#fff0ed] px-3 py-1.5 text-[12px] font-semibold text-[#b42318] transition disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        Void selected
                      </button>
                    </div>
                  </div>
                ) : null}
                <PackBasketOrderList
                  selectedOrderIds={selectedVoidOrderIdSet}
                  selectionEnabled={isDemandBasketTask}
                  task={task}
                  onToggleOrder={(orderId) => {
                    setSelectedVoidOrderIds((current) => (
                      current.includes(orderId)
                        ? current.filter((value) => value !== orderId)
                        : [...current, orderId]
                    ));
                  }}
                />
              </div>
            </div>

            <div className="xl:min-w-0 xl:flex-1">
              <div className="card h-full">
                <p className="card-label">Items</p>
                <div className="mt-3 space-y-3">
                  {items.map((line) => (
                    <div key={line.id} className="rounded-[18px] border border-[#e8eef2] bg-white px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-[14px] font-semibold text-primary">{line.productName}</p>
                          <p className="mt-1 text-[12px] text-[#6f8290]">
                            {line.packed >= line.required ? 'Verified' : `${line.required - line.packed} left to verify`}
                          </p>
                        </div>
                        <span className="text-[13px] font-semibold text-primary">{line.packed}/{line.required}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {(canStart || ((task.status === 'PICKED' || task.status === 'PACKING') && canExecute) || (!isPacking && canExecute)) ? (
            <div className="flex flex-wrap gap-2">
              {canStart ? (
                <ActionButton
                  disabled={isSubmitting}
                  icon={<RefreshCcw className={`h-4 w-4 ${isSubmitting ? 'animate-spin' : ''}`} />}
                  label="Start packing"
                  onClick={() => void onStart(task)}
                  tone="primary"
                />
              ) : null}

              {(task.status === 'PICKED' || task.status === 'PACKING') && canExecute && !isDemandBasketTask ? (
                <ActionButton
                  disabled={isSubmitting}
                  icon={<Slash className="h-4 w-4" />}
                  label="Void order"
                  onClick={() => setVoidOpen(true)}
                  tone="danger"
                />
              ) : null}

              {!isPacking && canExecute ? (
                <ActionButton
                  disabled={isRefreshing || isSubmitting}
                  icon={<RefreshCcw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />}
                  label="Refresh order"
                  onClick={onRefresh}
                  tone="secondary"
                />
              ) : null}
            </div>
          ) : null}

          {isPacked ? (
            <div className="card border-emerald-200 bg-emerald-50">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
                <div>
                  <p className="text-sm font-semibold text-emerald-800">{task.delivery?.label ?? 'Packed'}</p>
                  <p className="mt-1 text-sm leading-6 text-emerald-700">{resolvePackedStateCopy(task)}</p>
                </div>
              </div>
            </div>
          ) : null}

          {isPacking ? (
            <div className="card space-y-3">
              {nextUnit ? (
                <div className="card border-[#ebe3ff] bg-[#f6f2ff]">
                  <p className="card-label text-[#8b7bd0]">Next unit</p>
                  <p className="mt-1 text-base font-semibold text-[#2a1f57]">{nextUnit.unit.code}</p>
                  <p className="mt-1 text-sm text-[#61548c]">{nextUnit.unit.name}</p>
                </div>
              ) : (
                <div className="card border-emerald-200 bg-emerald-50">
                  <p className="text-sm font-semibold text-emerald-800">All units verified</p>
                  <p className="mt-1 text-sm text-emerald-700">Scan the tracking barcode, then mark this order packed.</p>
                </div>
              )}

              {!packedAll ? (
                <ScannerInput
                  disabled={isSubmitting}
                  helper="Each scanned unit is verified against the handed-off order."
                  inputRef={unitInputRef}
                  label="Scannable unit"
                  onChange={setUnitCode}
                  onSubmit={() => void submitPackedUnit()}
                  placeholder="Scan picked unit"
                  value={unitCode}
                />
              ) : null}

              <ScannerInput
                disabled={isSubmitting}
                helper={verifiedTracking ? `Verified ${verifiedTracking}` : 'Scan the waybill barcode to confirm the order tracking number.'}
                inputRef={trackingInputRef}
                label="Waybill"
                onChange={(value) => {
                  setTrackingCode(value);
                  setVerifiedTracking(null);
                }}
                onSubmit={() => void submitTrackedWaybill()}
                placeholder={tracking ?? 'Scan tracking barcode'}
                value={trackingCode}
              />

              <ActionButton
                disabled={!packedAll || !verifiedTracking || isSubmitting}
                icon={<CheckCircle2 className="h-4 w-4" />}
                label="Mark packed · F9"
                onClick={() => void onComplete(task, verifiedTracking ?? trackingCode)}
                tone="primary"
              />
            </div>
          ) : null}

        </div>
      </WmsCompactPanel>

      <WmsModal
        open={voidOpen}
        title={isDemandBasketTask ? 'Void basket orders' : 'Void pack order'}
        onClose={() => setVoidOpen(false)}
        footer={(
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setVoidOpen(false)}
              className="btn btn-md btn-outline"
            >
              Keep order
            </button>
            <button
              type="button"
              disabled={
                !voidReason.trim()
                || (!canDirectVoid && (!supervisorIdentifier.trim() || !supervisorPassword.trim()))
                || isSubmitting
                || (isDemandBasketTask && selectedVoidOrderIds.length === 0)
              }
              onClick={() => {
                const action = isDemandBasketTask
                  ? onVoidOrders({
                      task,
                      orderIds: selectedVoidOrderIds,
                      reason: voidReason.trim(),
                      supervisorIdentifier: canDirectVoid ? null : supervisorIdentifier.trim(),
                      supervisorPassword: canDirectVoid ? null : supervisorPassword,
                    })
                  : onVoid({
                      task,
                      reason: voidReason.trim(),
                      supervisorIdentifier: canDirectVoid ? null : supervisorIdentifier.trim(),
                      supervisorPassword: canDirectVoid ? null : supervisorPassword,
                    });
                void action.then((ok) => {
                  if (ok) {
                    setSelectedVoidOrderIds([]);
                    setVoidOpen(false);
                  }
                });
              }}
              className="btn btn-md btn-destructive"
            >
              {canDirectVoid ? 'Void now' : 'Request void'}
            </button>
          </div>
        )}
      >
        <div className="space-y-4">
          {isDemandBasketTask ? (
            <div className="rounded-xl border border-[#ece6fa] bg-[#faf8ff] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8193a0]">Selected orders</p>
              <p className="mt-2 text-sm font-semibold text-primary">
                {selectedVoidOrderIds.length} order{selectedVoidOrderIds.length === 1 ? '' : 's'} selected
              </p>
              <p className="mt-1 text-sm text-[#6f8290]">
                Selected orders will leave the basket and their picked or packed units will return to the original bins.
              </p>
            </div>
          ) : null}

          <label className="block space-y-1.5">
            <span className="form-label">Reason</span>
            <textarea
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              rows={3}
              placeholder="Order canceled, discontinued, customer changed item, etc."
              className='input'
            />
          </label>

          {!canDirectVoid ? (
            <div className="rounded-xl border border-[#efe4b9] bg-[#fff9e9] p-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-5 w-5 text-[#b58100]" />
                <div className="flex-1 space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-[#805b00]">Supervisor approval required</p>
                    <p className="mt-1 text-sm text-[#8a6a1b]">
                      Enter the supervisor email or employee ID, then the supervisor password to acknowledge the void.
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block space-y-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a6a1b]">Supervisor</span>
                      <input
                        value={supervisorIdentifier}
                        onChange={(event) => setSupervisorIdentifier(event.target.value)}
                        placeholder="manager@company.com or EMP-001"
                        className="h-11 w-full rounded-[16px] border border-[#e2d7ae] bg-white px-3.5 text-[13px] text-primary outline-none transition focus:border-[#caa93c] focus:shadow-[0_0_0_4px_rgba(202,169,60,0.14)]"
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a6a1b]">Password</span>
                      <input
                        type="password"
                        value={supervisorPassword}
                        onChange={(event) => setSupervisorPassword(event.target.value)}
                        placeholder="Enter supervisor password"
                        className="h-11 w-full rounded-[16px] border border-[#e2d7ae] bg-white px-3.5 text-[13px] text-primary outline-none transition focus:border-[#caa93c] focus:shadow-[0_0_0_4px_rgba(202,169,60,0.14)]"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </WmsModal>
    </>
  );
}

function DemandBasketPackExecutionPanel({
  basketView,
  canDirectVoid,
  canExecute,
  isRefreshing,
  isSubmitting,
  task,
  voidOpen,
  voidReason,
  supervisorIdentifier,
  supervisorPassword,
  selectedVoidOrderIds,
  setVoidOpen,
  setVoidReason,
  setSupervisorIdentifier,
  setSupervisorPassword,
  setSelectedVoidOrderIds,
  onCompleteBasketOrder,
  onRefresh,
  onScanBasketUnit,
  onScanBasketWaybill,
  onVoidOrders,
}: {
  basketView: BasketPackView | null;
  canDirectVoid: boolean;
  canExecute: boolean;
  isRefreshing: boolean;
  isSubmitting: boolean;
  task: WmsFulfillmentQueueTask;
  voidOpen: boolean;
  voidReason: string;
  supervisorIdentifier: string;
  supervisorPassword: string;
  selectedVoidOrderIds: string[];
  setVoidOpen: (open: boolean) => void;
  setVoidReason: (value: string) => void;
  setSupervisorIdentifier: (value: string) => void;
  setSupervisorPassword: (value: string) => void;
  setSelectedVoidOrderIds: Dispatch<SetStateAction<string[]>>;
  onCompleteBasketOrder: (task: WmsFulfillmentQueueTask, orderId: string) => Promise<boolean>;
  onRefresh: () => void;
  onScanBasketUnit: (task: WmsFulfillmentQueueTask, orderId: string, code: string) => Promise<boolean>;
  onScanBasketWaybill: (task: WmsFulfillmentQueueTask, code: string) => Promise<boolean>;
  onVoidOrders: (params: {
    task: WmsFulfillmentQueueTask;
    orderIds: string[];
    reason: string;
    supervisorIdentifier?: string | null;
    supervisorPassword?: string | null;
  }) => Promise<boolean>;
}) {
  const [waybillCode, setWaybillCode] = useState('');
  const [unitCode, setUnitCode] = useState('');
  const waybillInputRef = useRef<HTMLInputElement>(null);
  const unitInputRef = useRef<HTMLInputElement>(null);
  const plan = basketView?.plan ?? null;
  const basket = basketView?.basket ?? task.basket ?? null;
  const validation = basketView?.validation ?? null;
  const selectedOrder = plan?.activeOrder ?? null;
  const orderTaskMap = useMemo(
    () => new Map((basketView?.tasks ?? []).map((basketTask) => [basketTask.id, basketTask] as const)),
    [basketView?.tasks],
  );
  const selectedOrderTask = selectedOrder ? orderTaskMap.get(selectedOrder.id) ?? null : null;
  const basketComplete = Boolean(plan && plan.totals.remaining === 0 && plan.orderProgress.remaining === 0);
  const activeOrderReadyToComplete = Boolean(
    selectedOrder
    && selectedOrder.totals.required > 0
    && selectedOrder.totals.remaining === 0,
  );
  const availableUnitCount = plan?.availableUnits.reduce((total, unit) => total + unit.unitCount, 0) ?? 0;
  const trackingReadyCount = plan?.orders.filter((order) => order.trackingReady).length ?? 0;
  const trackingWaitingCount = Math.max((plan?.orders.length ?? 0) - trackingReadyCount, 0);
  const voidStateByOrderId = useMemo(() => {
    const state = new Map<string, { selectable: boolean; reason: string | null }>();
    for (const order of task.basket?.orders ?? []) {
      const orderTask = orderTaskMap.get(order.id) ?? null;
      const deliveryStatus = orderTask?.delivery?.status ?? null;
      const canceledInPos = deliveryStatus === 'CANCELED';
      const changedInPos = orderTask?.itemChange?.hasChanged === true;
      const inDispatch = deliveryStatus === 'SHIPPED'
        || deliveryStatus === 'DELIVERED'
        || deliveryStatus === 'RETURNING'
        || deliveryStatus === 'RETURNED';
      const selectable = (order.status === 'PICKED' || order.status === 'PACKING') && !inDispatch;
      state.set(order.id, {
        selectable,
        reason: changedInPos
          ? orderTask?.itemChange?.message ?? 'Items changed in POS · complete the automatic Pick rework'
          : canceledInPos
          ? 'Cancelled in POS · void this order'
          : inDispatch
            ? orderTask?.delivery?.label ?? 'In dispatch'
            : null,
      });
    }
    return state;
  }, [orderTaskMap, task.basket?.orders]);
  const voidEligibleBasketOrders = useMemo(
    () => (task.basket?.orders ?? []).filter((order) => voidStateByOrderId.get(order.id)?.selectable),
    [task.basket?.orders, voidStateByOrderId],
  );
  const selectedVoidOrderIdSet = useMemo(() => new Set(selectedVoidOrderIds), [selectedVoidOrderIds]);
  const allVoidEligibleSelected = voidEligibleBasketOrders.length > 0
    && selectedVoidOrderIds.length === voidEligibleBasketOrders.length;
  const blockedVoidCount = Math.max((task.basket?.orders?.length ?? 0) - voidEligibleBasketOrders.length, 0);
  const nextAction = basketComplete
    ? 'Basket complete'
    : selectedOrder
      ? activeOrderReadyToComplete
        ? 'Done packing'
        : 'Scan unit'
      : 'Scan waybill';
  const nextActionCopy = basketComplete
    ? 'No more orders left in this basket.'
    : selectedOrder
      ? activeOrderReadyToComplete
        ? `Close order #${selectedOrder.posOrderId}`
        : `Pack order #${selectedOrder.posOrderId}`
      : `${trackingReadyCount} ready to start`;

  useEffect(() => {
    setWaybillCode('');
    setUnitCode('');
  }, [plan?.basketId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedOrder && !activeOrderReadyToComplete) {
        unitInputRef.current?.focus();
        return;
      }

      if (!selectedOrder && !basketComplete) {
        waybillInputRef.current?.focus();
      }
    }, 120);

    return () => window.clearTimeout(timer);
  }, [activeOrderReadyToComplete, basketComplete, selectedOrder]);

  const submitWaybill = async (scannedValue?: string) => {
    const code = (scannedValue ?? waybillCode).trim();
    if (!code || isSubmitting || basketComplete) {
      waybillInputRef.current?.focus();
      return;
    }

    const ok = await onScanBasketWaybill(task, code);
    setWaybillCode('');
    window.setTimeout(() => {
      if (ok) {
        unitInputRef.current?.focus();
        return;
      }

      waybillInputRef.current?.focus();
    }, 80);
  };

  const submitUnit = async (scannedValue?: string) => {
    const code = (scannedValue ?? unitCode).trim();
    if (!selectedOrder || !code || isSubmitting || activeOrderReadyToComplete) {
      unitInputRef.current?.focus();
      return;
    }

    await onScanBasketUnit(task, selectedOrder.id, code);
    setUnitCode('');
    window.setTimeout(() => {
      unitInputRef.current?.focus();
    }, 80);
  };

  useScannerKeyboardCapture({
    enabled: Boolean(canExecute && !voidOpen && !selectedOrder && !basketComplete),
    inputRef: waybillInputRef,
    onScannedValue: setWaybillCode,
    onSubmit: submitWaybill,
  });

  useScannerKeyboardCapture({
    enabled: Boolean(canExecute && !voidOpen && selectedOrder && !activeOrderReadyToComplete),
    inputRef: unitInputRef,
    onScannedValue: setUnitCode,
    onSubmit: submitUnit,
  });

  usePackCompleteHotkey({
    enabled: Boolean(canExecute && !voidOpen && selectedOrder && activeOrderReadyToComplete && !isSubmitting),
    onTrigger: async () => {
      if (!selectedOrder) {
        return;
      }
      await onCompleteBasketOrder(task, selectedOrder.id);
    },
  });

  if (!plan || !basket) {
    return (
      <WmsCompactPanel title="Pack Execution" icon={<PackageOpen className='panel-icon'/>}>
        <div className="flex min-h-[520px] items-center justify-center rounded-2xl border border-dashed border-[#d7e0e7] bg-[#fbfcfc] px-8 py-10 text-center">
          <div className="max-w-sm">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#8193a0]">Basket mode</p>
            <h3 className="mt-3 text-xl font-semibold tracking-tight text-primary">Loading basket plan</h3>
            <p className="mt-3 text-sm leading-6 text-[#607482]">
              Fetching basket orders and current packing progress.
            </p>
          </div>
        </div>
      </WmsCompactPanel>
    );
  }

  return (
    <>
      <WmsCompactPanel title="Pack Execution" icon={<PackageOpen className='panel-icon'/>}>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[18px] font-semibold tracking-tight text-primary">
              Basket {basket.barcode}
            </h3>
            <p className="mt-1 truncate text-[13px] text-[#6f8290]">
              {task.store?.tenantName ?? 'Tenant'} · {task.store?.name ?? 'Store'} · {plan.orderProgress.remaining} open
            </p>
          </div>

          <span className={`inline-flex rounded-full px-3 py-1.5 text-[12px] font-semibold ${getStatusTone(
            selectedOrder ? 'Packing' : basketComplete ? 'Packed' : 'Awaiting pack',
          )}`}>
            {selectedOrder ? 'Packing' : basketComplete ? 'Packed' : 'Awaiting pack'}
          </span>
        </div>

        <div className="mt-5 space-y-5">
          {validation && !validation.isConsistent ? (
            <WmsInlineNotice className="mb-1" dismissible tone="info">
              <p className="font-semibold text-[#12384b]">Basket state changed while this pack view was open.</p>
              <p className="mt-1 text-[13px]">
                {validation.issues[0] ?? 'The basket plan no longer matches the latest queue state.'}
              </p>
              {validation.issues.length > 1 ? (
                <p className="mt-1 text-[12px] text-[#6f8290]">
                  {validation.issues.length - 1} more validation check{validation.issues.length === 2 ? '' : 's'} need review. Use refresh before continuing if anything looks off.
                </p>
              ) : null}
            </WmsInlineNotice>
          ) : null}

          {(() => {
            const changedBasketTasks = selectedOrderTask?.itemChange
              ? [selectedOrderTask]
              : Array.from(orderTaskMap.values()).filter((basketTask) => Boolean(basketTask.itemChange));
            return changedBasketTasks.map((basketTask) => (
              basketTask.itemChange ? (
                <div
                  key={`pack-top-change-${basketTask.id}`}
                  className={`rounded-[16px] border px-4 py-3 ${basketTask.itemChange.requiresAction ? 'border-[#ffd8cc] bg-[#fff4f1]' : 'border-sky-200 bg-sky-50'}`}
                >
                  <p className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${basketTask.itemChange.requiresAction ? 'text-[#c2410c]' : 'text-sky-700'}`}>
                    {basketTask.itemChange.requiresAction ? 'Order change note · Rework required' : 'Order change note · Automatic revision'}
                  </p>
                  <p className={`mt-1 text-[13px] font-semibold ${basketTask.itemChange.requiresAction ? 'text-[#9a3412]' : 'text-sky-950'}`}>
                    #{basketTask.posOrderId} · {basketTask.itemChange.title}
                  </p>
                  <p className={`mt-1 text-[12px] ${basketTask.itemChange.requiresAction ? 'text-[#9a3412]' : 'text-sky-900'}`}>
                    {basketTask.itemChange.message}
                  </p>
                </div>
              ) : null
            ));
          })()}

          <div className="flex flex-col gap-3 md:flex-row">
            <div className="md:flex-1">
              <MetricTile
                label="Basket"
                value={`${plan.totals.packed}/${plan.totals.required}`}
                note="Units packed"
              />
            </div>
            <div className="md:flex-1">
              <MetricTile
                label="Orders"
                value={`${plan.orderProgress.packed}/${plan.orderProgress.total}`}
                note="Orders done"
              />
            </div>
            <div className="md:flex-1">
              <MetricTile
                label="Tracking"
                value={`${trackingReadyCount}/${plan.orders.length}`}
                note={trackingWaitingCount > 0 ? `${trackingWaitingCount} waiting` : 'All ready'}
              />
            </div>
            <div className="md:flex-1">
              <MetricTile
                label="Next"
                value={nextAction}
                note={nextActionCopy}
              />
            </div>
          </div>

          <div className="flex flex-col gap-5 xl:flex-row">
            <div className="xl:min-w-0 xl:flex-[1.15]">
              <div className="card">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">Basket orders</p>
                    <p className="mt-1 text-[12px] text-[#6f8290]">
                      {trackingReadyCount} with tracking{trackingWaitingCount > 0 ? ` · ${trackingWaitingCount} waiting` : ''}
                    </p>
                  </div>
                  <span className="text-[12px] font-semibold text-[#6b4eff]">
                    {plan.orderProgress.total}
                  </span>
                </div>

                {voidEligibleBasketOrders.length > 0 ? (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-[16px] border border-[#ece6fa] bg-[#faf8ff] px-4 py-3">
                    <p className="text-[12px] font-semibold text-[#6f8290]">
                      {selectedVoidOrderIds.length > 0 ? `${selectedVoidOrderIds.length} selected` : 'Select orders'}
                    </p>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setSelectedVoidOrderIds(allVoidEligibleSelected ? [] : voidEligibleBasketOrders.map((order) => order.id))}
                        className="text-[12px] font-semibold text-[#6b4eff]"
                      >
                        {allVoidEligibleSelected ? 'Clear' : 'Select all'}
                      </button>
                      <button
                        type="button"
                        disabled={selectedVoidOrderIds.length === 0 || isSubmitting || !canExecute}
                        onClick={() => setVoidOpen(true)}
                        className="inline-flex items-center rounded-full border border-[#ffd5cf] bg-[#fff0ed] px-3 py-1.5 text-[12px] font-semibold text-[#b42318] transition disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        Void selected
                      </button>
                    </div>
                  </div>
                ) : null}
                {blockedVoidCount > 0 ? (
                  <div className="mt-3 rounded-[16px] border border-[#e6edf2] bg-[#f8fbfd] px-4 py-3 text-[12px] text-[#6f8290]">
                    {blockedVoidCount} order{blockedVoidCount === 1 ? ' is' : 's are'} locked because they are already in dispatch or return flow.
                  </div>
                ) : null}

                {selectedOrderTask?.itemChange?.hasChanged ? (
                  <div className="mt-3 rounded-[16px] border border-[#ffd8cc] bg-[#fff4f1] px-4 py-3">
                    <div className="flex items-start gap-2">
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#c2410c]" />
                      <div>
                        <p className="text-[12px] font-semibold text-[#9a3412]">POS items changed for this order.</p>
                        <p className="mt-1 text-[12px] text-[#9a3412]">
                          {selectedOrderTask.itemChange.message ?? 'This order was rebuilt from the latest POS items automatically. Complete its highlighted steps in Pick before packing continues.'}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null}

                <DemandPackOrderPlanList
                  activeOrderId={selectedOrder?.id ?? null}
                  orders={plan.orders}
                  orderStateById={voidStateByOrderId}
                  orderTaskById={orderTaskMap}
                  selectableOrderIds={selectedVoidOrderIdSet}
                  onToggleOrder={(orderId) => {
                    const isSelectable = voidStateByOrderId.get(orderId)?.selectable;
                    if (!isSelectable) {
                      return;
                    }

                    setSelectedVoidOrderIds((current) => (
                      current.includes(orderId)
                        ? current.filter((value) => value !== orderId)
                        : [...current, orderId]
                    ));
                  }}
                />
              </div>
            </div>

            <div className="xl:min-w-0 xl:flex-1">
              <div className="card space-y-3">
                <div className="rounded-[18px] border border-[#eceff3] bg-[#fbfcfd] px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">Next action</p>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[16px] font-semibold text-primary">{nextAction}</p>
                      <p className="mt-1 truncate text-[12px] text-[#6f8290]">{nextActionCopy}</p>
                    </div>
                    {!basketComplete ? (
                      <span className="rounded-full bg-[#edf4f8] px-3 py-1 text-[11px] font-semibold text-[#12384b]">
                        {availableUnitCount} ready
                      </span>
                    ) : null}
                  </div>
                </div>

                {basketComplete ? (
                  <div className="rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-4">
                    <p className="text-sm font-semibold text-emerald-800">Basket complete</p>
                    <p className="mt-1 text-sm text-emerald-700">All basket orders are packed.</p>
                  </div>
                ) : selectedOrder ? (
                  <>
                    <div className="rounded-[18px] border border-[#ece6fa] bg-[#faf8ff] px-4 py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-[15px] font-semibold text-primary">#{selectedOrder.posOrderId}</p>
                          <p className="mt-1 truncate text-[12px] text-[#6f8290]">
                            {selectedOrder.customerName ?? selectedOrder.tracking ?? 'Selected order'}
                          </p>
                        </div>
                        <span className="text-[14px] font-semibold text-primary">
                          {selectedOrder.totals.packed}/{selectedOrder.totals.required}
                        </span>
                      </div>
                    </div>

                    {activeOrderReadyToComplete ? (
                      <div className="rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-4">
                        <p className="text-sm font-semibold text-emerald-800">Ready to close</p>
                        <p className="mt-1 text-sm text-emerald-700">Done packing will finish this waybill.</p>
                      </div>
                    ) : (
                      <ScannerInput
                        disabled={isSubmitting}
                        inputRef={unitInputRef}
                        helper="Auto-clears after every scan."
                        label="Unit"
                        onChange={setUnitCode}
                        onSubmit={() => void submitUnit()}
                        placeholder="Scan basket unit"
                        value={unitCode}
                      />
                    )}
                  </>
                ) : (
                  <ScannerInput
                    disabled={isSubmitting}
                    inputRef={waybillInputRef}
                    helper="Scans the next order in this basket."
                    label="Waybill"
                    onChange={setWaybillCode}
                    onSubmit={() => void submitWaybill()}
                    placeholder="Scan waybill"
                    value={waybillCode}
                  />
                )}

                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    disabled={isRefreshing || isSubmitting}
                    icon={<RefreshCcw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />}
                    label="Refresh basket"
                    onClick={onRefresh}
                    tone="secondary"
                  />
                  {selectedOrder && activeOrderReadyToComplete ? (
                    <ActionButton
                      disabled={isSubmitting}
                      icon={<CheckCircle2 className="h-4 w-4" />}
                      label="Done packing · F9"
                      onClick={() => void onCompleteBasketOrder(task, selectedOrder.id)}
                      tone="primary"
                    />
                  ) : null}
                </div>
              </div>

              <div className="card mt-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">
                  {selectedOrder ? 'Order items' : 'Basket items'}
                </p>
                <div className="mt-3 space-y-3">
                  {selectedOrder
                    ? selectedOrder.lines.map((line) => (
                        <div key={line.id} className="rounded-[18px] border border-[#e8eef2] bg-white px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-[14px] font-semibold text-primary">{line.productName}</p>
                              <p className="mt-1 text-[12px] text-[#6f8290]">
                                {line.remaining} left
                              </p>
                            </div>
                            <span className="text-[13px] font-semibold text-primary">{line.packed}/{line.required}</span>
                          </div>
                        </div>
                      ))
                    : plan.availableUnits.map((unit) => (
                        <div key={`${unit.variationId}:${unit.productId ?? ''}`} className="rounded-[18px] border border-[#e8eef2] bg-white px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-[14px] font-semibold text-primary">{unit.productName}</p>
                              <p className="mt-1 text-[12px] text-[#6f8290]">
                                {unit.productDisplayId ?? unit.variationId}
                              </p>
                            </div>
                            <span className="text-[13px] font-semibold text-primary">{unit.unitCount}</span>
                          </div>
                        </div>
                      ))}
                </div>
              </div>
            </div>
          </div>

          <FulfillmentBasketUnitManifest units={plan.units ?? []} />
        </div>
      </WmsCompactPanel>

      <WmsModal
        open={voidOpen}
        title="Void basket orders"
        onClose={() => setVoidOpen(false)}
        footer={(
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setVoidOpen(false)}
              className="btn btn-md btn-outline"
            >
              Keep orders
            </button>
            <button
              type="button"
              disabled={
                !voidReason.trim()
                || selectedVoidOrderIds.length === 0
                || (!canDirectVoid && (!supervisorIdentifier.trim() || !supervisorPassword.trim()))
                || isSubmitting
              }
              onClick={() => {
                void onVoidOrders({
                  task,
                  orderIds: selectedVoidOrderIds,
                  reason: voidReason.trim(),
                  supervisorIdentifier: canDirectVoid ? null : supervisorIdentifier.trim(),
                  supervisorPassword: canDirectVoid ? null : supervisorPassword,
                }).then((ok) => {
                  if (ok) {
                    setSelectedVoidOrderIds([]);
                    setVoidOpen(false);
                  }
                });
              }}
              className="btn btn-md btn-destructive"
            >
              {canDirectVoid ? 'Void now' : 'Request void'}
            </button>
          </div>
        )}
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-[#ece6fa] bg-[#faf8ff] px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8193a0]">Selected orders</p>
            <p className="mt-2 text-sm font-semibold text-primary">
              {selectedVoidOrderIds.length} order{selectedVoidOrderIds.length === 1 ? '' : 's'} selected
            </p>
            <p className="mt-1 text-sm text-[#6f8290]">
              Only orders still inside the active pack flow can be voided here.
            </p>
          </div>

          <label className="block space-y-1.5">
            <span className="form-label">Reason</span>
            <textarea
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              rows={3}
              placeholder="Wrong basket, manual dispatch, customer canceled, etc."
              className='input'
            />
          </label>

          {!canDirectVoid ? (
            <div className="rounded-xl border border-[#efe4b9] bg-[#fff9e9] p-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-5 w-5 text-[#b58100]" />
                <div className="flex-1 space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-[#805b00]">Supervisor approval required</p>
                    <p className="mt-1 text-sm text-[#8a6a1b]">
                      Enter the supervisor email or employee ID, then the supervisor password to acknowledge the void.
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block space-y-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a6a1b]">Supervisor</span>
                      <input
                        value={supervisorIdentifier}
                        onChange={(event) => setSupervisorIdentifier(event.target.value)}
                        placeholder="manager@company.com or EMP-001"
                        className="h-11 w-full rounded-[16px] border border-[#e2d7ae] bg-white px-3.5 text-[13px] text-primary outline-none transition focus:border-[#caa93c] focus:shadow-[0_0_0_4px_rgba(202,169,60,0.14)]"
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a6a1b]">Password</span>
                      <input
                        type="password"
                        value={supervisorPassword}
                        onChange={(event) => setSupervisorPassword(event.target.value)}
                        placeholder="Enter supervisor password"
                        className="h-11 w-full rounded-[16px] border border-[#e2d7ae] bg-white px-3.5 text-[13px] text-primary outline-none transition focus:border-[#caa93c] focus:shadow-[0_0_0_4px_rgba(202,169,60,0.14)]"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </WmsModal>
    </>
  );
}

function ScannerInput({
  autoSubmit = false,
  autoSubmitDelayMs = 120,
  autoSubmitMinLength = 3,
  disabled,
  helper,
  inputRef,
  label,
  onChange,
  onSubmit,
  placeholder,
  value,
}: {
  autoSubmit?: boolean;
  autoSubmitDelayMs?: number;
  autoSubmitMinLength?: number;
  disabled?: boolean;
  helper?: string;
  inputRef: RefObject<HTMLInputElement>;
  label: string;
  onChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  placeholder: string;
  value: string;
}) {
  const submitRef = useRef(onSubmit);
  const lastSubmittedRef = useRef<string | null>(null);

  useEffect(() => {
    submitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    const cleaned = value.trim();
    if (!cleaned) {
      lastSubmittedRef.current = null;
      return;
    }

    if (!autoSubmit || disabled || cleaned.length < autoSubmitMinLength || lastSubmittedRef.current === cleaned) {
      return;
    }

    const timer = window.setTimeout(() => {
      lastSubmittedRef.current = cleaned;
      void submitRef.current();
    }, autoSubmitDelayMs);

    return () => window.clearTimeout(timer);
  }, [autoSubmit, autoSubmitDelayMs, autoSubmitMinLength, disabled, value]);

  return (
    <label className={`card block ${disabled ? 'border-[#e5eaee] bg-[#f8fafb]' : 'border-[#d7e0e7] bg-white'}`}>
      <span className="card-label">{label}</span>
      <div className="mt-2 flex items-center gap-2">
        <input
          data-scanner-input="true"
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void onSubmit();
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          autoCapitalize="characters"
          autoCorrect="off"
          className="input"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            void onSubmit();
          }}
          className="inline-flex h-11 w-11 items-center justify-center rounded-[16px] bg-primary text-white transition hover:bg-[#0f3141] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <CornerDownLeft className="h-4 w-4" />
        </button>
      </div>
      {helper ? <p className="mt-2 text-[12px] text-[#6f8290]">{helper}</p> : null}
    </label>
  );
}

function MetricTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="card">
      <p className="card-label">{label}</p>
      <p className="card-value text-[20px]">{value}</p>
      <p className="mt-1 text-[12px] text-[#6f8290]">{note}</p>
    </div>
  );
}

function isEditableElement(element: HTMLElement | null) {
  if (!element) {
    return false;
  }

  const tagName = element.tagName;
  return element.isContentEditable
    || tagName === 'INPUT'
    || tagName === 'TEXTAREA'
    || tagName === 'SELECT';
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="card-label">{label}</p>
      <p className="mt-1 text-[13px] font-semibold text-primary">{value}</p>
    </div>
  );
}

function PackBasketOrderList({
  selectedOrderIds,
  selectionEnabled = false,
  task,
  onToggleOrder,
}: {
  selectedOrderIds?: Set<string>;
  selectionEnabled?: boolean;
  task: WmsFulfillmentQueueTask;
  onToggleOrder?: (orderId: string) => void;
}) {
  const orders = task.basket?.orders ?? [];

  if (!orders.length) {
    return <p className="mt-3 text-[13px] text-[#6f8290]">No active basket orders.</p>;
  }

  return (
    <div className="mt-3 border-t border-[#ece6fa]">
      {orders.map((order) => {
        const active = order.id === task.id;
        const selectable = selectionEnabled && (order.status === 'PICKED' || order.status === 'PACKING');
        const selected = Boolean(selectedOrderIds?.has(order.id));
        return (
          <button
            key={order.id}
            type="button"
            disabled={!selectable}
            onClick={() => {
              if (selectable) {
                onToggleOrder?.(order.id);
              }
            }}
            className={`flex w-full items-center gap-3 border-b px-1 py-3 text-left transition ${
              active
                ? 'border-[#ece6fa] bg-[#faf8ff]'
                : selected
                  ? 'border-[#ece6fa] bg-[#f4efff]'
                  : 'border-[#f1edf7] bg-transparent'
            } ${selectable ? 'hover:bg-[#f8f4ff]' : 'cursor-default'}`}
          >
            {selectionEnabled ? (
              <span
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[10px] border text-white ${
                  selected
                    ? 'border-[#6b4eff] bg-[#6b4eff]'
                    : selectable
                      ? 'border-[#d6dde3] bg-white'
                      : 'border-[#e7eaf0] bg-[#f8fafb]'
                }`}
              >
                {selected ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
              </span>
            ) : (
              <div className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-[#6b4eff]' : 'bg-[#d6dde3]'}`} />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-primary">
                {order.posOrderId ? `#${order.posOrderId}` : 'Order'}
              </p>
              <p className="truncate text-[10px] text-[#6f8290]">
                {active
                  ? 'Current pack order'
                  : order.tracking ?? order.store?.name ?? order.customerName ?? order.statusLabel ?? 'Same basket'}
              </p>
            </div>
            <div className="shrink-0 text-right">
              {active ? (
                <p className="text-[10px] font-semibold text-[#6b4eff]">Current</p>
              ) : null}
              <span className="text-[11px] font-semibold text-primary">
                {order.totals.picked}/{order.totals.required}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function DemandPackOrderPlanList({
  activeOrderId,
  orders,
  orderStateById,
  orderTaskById,
  selectableOrderIds,
  onToggleOrder,
}: {
  activeOrderId: string | null;
  orders: WmsFulfillmentBasketPackPlan['orders'];
  orderStateById: Map<string, { selectable: boolean; reason: string | null }>;
  orderTaskById: Map<string, WmsFulfillmentQueueTask>;
  selectableOrderIds: Set<string>;
  onToggleOrder: (orderId: string) => void;
}) {
  if (!orders.length) {
    return <p className="mt-3 text-[13px] text-[#6f8290]">No active basket orders.</p>;
  }

  return (
    <div className="mt-3 border-t border-[#ece6fa]">
      {orders.map((order) => {
        const active = order.id === activeOrderId;
        const selected = selectableOrderIds.has(order.id);
        const orderState = orderStateById.get(order.id) ?? {
          selectable: order.status === 'PICKED' || order.status === 'PACKING',
          reason: null,
        };
        const orderTask = orderTaskById.get(order.id) ?? null;
        const selectable = orderState.selectable;
        const itemChanged = orderTask?.itemChange?.hasChanged === true;
        const helperText = itemChanged
          ? orderTask?.itemChange?.message ?? 'Items changed in POS · complete the automatic Pick rework'
          : orderState.reason ?? order.tracking ?? order.customerName ?? order.statusLabel;

        return (
          <button
            key={order.id}
            type="button"
            disabled={!selectable}
            onClick={() => {
              if (selectable) {
                onToggleOrder(order.id);
              }
            }}
            className={`flex w-full items-center gap-3 border-b px-1 py-3 text-left transition ${
              active
                ? 'border-[#ece6fa] bg-[#faf8ff]'
                : selected
                  ? 'border-[#ece6fa] bg-[#f4efff]'
                  : 'border-[#f1edf7] bg-transparent'
            } ${selectable ? 'hover:bg-[#f8f4ff]' : 'cursor-default'}`}
          >
            <span
              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[10px] border text-white ${
                selected
                  ? 'border-[#6b4eff] bg-[#6b4eff]'
                  : selectable
                    ? 'border-[#d6dde3] bg-white'
                    : 'border-[#e7eaf0] bg-[#f8fafb]'
              }`}
            >
              {selected ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-[12px] font-semibold text-primary">#{order.posOrderId}</p>
                {active ? (
                  <span className="rounded-full bg-[#ede9ff] px-2 py-0.5 text-[10px] font-semibold text-[#6b4eff]">
                    Active
                  </span>
                ) : itemChanged ? (
                  <span className="rounded-full bg-[#fff1eb] px-2 py-0.5 text-[10px] font-semibold text-[#c2410c]">
                    Changed
                  </span>
                ) : !selectable && orderState.reason ? (
                  <span className="rounded-full bg-[#eef3f6] px-2 py-0.5 text-[10px] font-semibold text-[#607482]">
                    Locked
                  </span>
                ) : null}
              </div>
              <p className="truncate text-[10px] text-[#6f8290]">
                {helperText}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[11px] font-semibold text-primary">
                {order.totals.packed}/{order.totals.required}
              </p>
              <p className="text-[10px] text-[#6f8290]">
                {order.trackingReady ? 'Tracking ready' : 'No tracking'}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ActionButton({
  disabled,
  icon,
  label,
  onClick,
  tone,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone: 'primary' | 'secondary' | 'danger';
}) {
  const toneClassName = tone === 'primary'
    ? 'btn-primary'
    : tone === 'danger'
      ? 'btn-destructive'
      : 'btn-outline';

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`btn btn-lg btn-icon ${toneClassName}`}
    >
      {icon}
      {label}
    </button>
  );
}

function getVisiblePackLines(lines: WmsFulfillmentQueueTask['lines']) {
  return lines.filter((line) => line.status !== 'CANCELED' && line.required > 0);
}

function getNextPackReservation(task: WmsFulfillmentQueueTask): WmsFulfillmentQueueReservation | null {
  for (const line of getVisiblePackLines(task.lines)) {
    const next = line.reservations.find((reservation) => (
      reservation.status === 'PICKED'
      && reservation.unit.status !== 'PACKED'
      && reservation.unit.status !== 'DISPATCHED'
    ));

    if (next) {
      return next;
    }
  }

  return null;
}

function resolvePackAssignedAt(task: WmsFulfillmentQueueTask) {
  return formatPackDateTime(
    task.basket?.readyForPackAt
    ?? task.basket?.fullAt
    ?? task.completedAt
    ?? task.claimedAt
    ?? task.orderDateLocal
    ?? task.orderDate,
  );
}

function formatPackBasketSlotNote(
  basket: NonNullable<WmsFulfillmentQueueTask['basket']>,
) {
  const openSlots = Math.max(basket.maxFulfillmentOrders - basket.activeFulfillmentOrders, 0);
  if (openSlots === 0) {
    return `${basket.activeFulfillmentOrders} orders in basket · full`;
  }

  return `${basket.activeFulfillmentOrders} orders in basket · ${openSlots} slot${openSlots === 1 ? '' : 's'} open`;
}

function formatPackDateTime(value: string) {
  const trimmed = value.trim();
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const parsed = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(trimmed);

  if (Number.isNaN(parsed.getTime())) {
    return trimmed;
  }

  return parsed.toLocaleString('en-PH', {
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function resolvePackStateLabel(task: WmsFulfillmentQueueTask, tracking: string | null) {
  if (task.delivery?.status === 'CANCELED') {
    return task.delivery.label ?? 'Cancelled';
  }

  if (task.status === 'PACKED' && task.delivery?.label) {
    return task.delivery.label;
  }

  if (!tracking && task.status !== 'PACKED') {
    return 'No tracking';
  }

  if (task.status === 'PICKED') {
    return 'Awaiting pack';
  }

  if (task.status === 'PACKING') {
    return 'Packing';
  }

  if (task.status === 'PACKED') {
    return 'Packed';
  }

  return task.statusLabel;
}

function resolvePackedStateCopy(task: WmsFulfillmentQueueTask) {
  if (task.delivery?.status === 'CANCELED') {
    return 'This order was canceled in POS. Void it from the active pack basket before the team continues.';
  }

  if (task.delivery?.status === 'DELIVERED') {
    return 'This order was delivered. The packed activity remains traceable in WMS and STOX history.';
  }

  if (task.delivery?.status === 'SHIPPED') {
    return 'This order already left the warehouse and its units were moved to dispatched inventory.';
  }

  return 'This order is packed and the basket has already been released back to available.';
}

function getStatusTone(statusLabel: string) {
  const normalized = statusLabel.toLowerCase();

  if (normalized.includes('delivered')) {
    return 'bg-emerald-50 text-emerald-700';
  }

  if (normalized.includes('shipped')) {
    return 'bg-sky-50 text-sky-700';
  }

  if (normalized.includes('tracking')) {
    return 'bg-rose-50 text-rose-700';
  }

  if (normalized.includes('pack')) {
    return 'bg-violet-50 text-violet-700';
  }

  return 'bg-slate-100 text-slate-700';
}

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Feather } from '@expo/vector-icons';
import {
  ActivityIndicator,
  AppState,
  InteractionManager,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { BootstrapResponse, DeviceIdentity, StoredSession } from '@/src/features/auth/types';
import { canUsePackWorkspace } from '@/src/features/home/rbac';
import { usePackingWorkspace } from '@/src/features/packing/hooks/use-packing-workspace';
import type {
  WmsMobileBasketPackPlan,
  PackingFilters,
  PackingStatusFilter,
  WmsMobilePackingResponse,
} from '@/src/features/packing/types';
import { PackingProofModal } from '@/src/features/packing/components/packing-proof-modal';
import { usePackingProof } from '@/src/features/packing/hooks/use-packing-proof';
import type { WmsMobilePickingTask } from '@/src/features/picking/types';
import { OrderChangeNotice } from '@/src/features/fulfillment/components/order-change-notice';
import { PrimaryButton } from '@/src/shared/components/primary-button';
import { SurfaceCard } from '@/src/shared/components/surface-card';
import { TextField } from '@/src/shared/components/text-field';
import { tokens } from '@/src/shared/theme/tokens';
import {
  StockScopeFilterModal,
} from '@/src/features/stock/components/stock-scope-filter';
import type { StockScopeOption } from '@/src/features/stock/utils/stock-scope';
import { BlockedTaskState, FloatingErrorBanner, SectionLabel, TaskHeader, TaskHeaderIconButton, UtilityPill } from './stox-primitives';
import { useStoxShellOverlay } from './stox-shell';

type PackingTabProps = {
  bootstrap: BootstrapResponse;
  device: DeviceIdentity | null;
  session: StoredSession;
};

type PackingFilterKey = 'tenant' | 'store';

type PackQueueEntry =
  | {
      key: string;
      kind: 'basket';
      basket: NonNullable<WmsMobilePickingTask['basket']>;
      primaryTask: WmsMobilePickingTask;
      tasks: WmsMobilePickingTask[];
    }
  | {
      key: string;
      kind: 'task';
      basket: WmsMobilePickingTask['basket'];
      primaryTask: WmsMobilePickingTask;
      tasks: [WmsMobilePickingTask];
    };

const PACK_STATUS_FILTERS: Array<{ label: string; value: PackingStatusFilter | null }> = [
  { label: 'All', value: null },
  { label: 'Awaiting pack', value: 'PICKED' },
  { label: 'Packing', value: 'PACKING' },
  { label: 'No tracking', value: 'AWAITING_TRACKING' },
  { label: 'Packed', value: 'PACKED' },
];

export function PackingTab({ bootstrap, device, session }: PackingTabProps) {
  if (!canUsePackWorkspace(bootstrap)) {
    return (
      <>
        <TaskHeader title="Pack" />
        <BlockedTaskState copy="This account needs WMS dispatch write or edit permission and a PACK task assignment in WMS Web." />
      </>
    );
  }

  return <PackingWorkspaceTab bootstrap={bootstrap} device={device} session={session} />;
}

function PackingWorkspaceTab({ bootstrap, device, session }: PackingTabProps) {
  const [activeFilter, setActiveFilter] = useState<PackingFilterKey | null>(null);
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const [activeBasketId, setActiveBasketId] = useState<string | null>(null);
  const {
    activeTask,
    activeTaskId,
    basketViews,
    completeBasketOrder,
    completeTask,
    error,
    fetchBasketPlan,
    fetchTaskDetails,
    filters,
    isLoading,
    isLoadingMore,
    isRefreshing,
    isSubmitting,
    loadMore,
    packing,
    refreshPacking,
    scanBasketOrderUnit,
    scanBasketWaybill,
    scanUnit,
    setActiveTaskId,
    setFilters,
    setStatusFilter,
    startTask,
    statusFilter,
    verifyTracking,
    voidTask,
  } = usePackingWorkspace({ bootstrap, device, session });

  const canDirectVoid = bootstrap.user.role === 'SUPER_ADMIN'
    || bootstrap.access.permissions.includes('wms.dispatch.void')
    || bootstrap.access.permissions.includes('wms.dispatch.override');

  const filterOptions = useMemo(
    () => buildPackingFilterOptions(activeFilter, packing, bootstrap, bootstrap.user.role === 'SUPER_ADMIN'),
    [activeFilter, bootstrap, packing],
  );
  const activePartnerName = resolveActivePartnerName(packing, bootstrap, filters.tenantId);
  const activeStoreName = resolveActiveStoreName(packing, bootstrap, filters.storeId);
  const taskPool = packing?.tasks ?? [];
  const isPackedHistoryView = statusFilter === 'PACKED';
  const activeBasketView = activeBasketId ? basketViews[activeBasketId] ?? null : null;
  const isDemandExecutionLoading = Boolean(
    activeBasketId
    && activeTask
    && activeTask.assignmentMode === 'BASKET_DEMAND'
    && activeTask.basket?.id === activeBasketId
    && !activeBasketView,
  );
  const dateOptions = useMemo(() => buildPackDateOptions(taskPool), [taskPool]);
  const filteredTasks = useMemo(() => {
    if (isPackedHistoryView || !selectedDateKey) {
      return taskPool;
    }

    return taskPool.filter((task) => getPackTaskDateKey(task) === selectedDateKey);
  }, [isPackedHistoryView, selectedDateKey, taskPool]);
  const queueEntries = useMemo(
    () => buildPackQueueEntries(filteredTasks, { groupBaskets: !isPackedHistoryView }),
    [filteredTasks, isPackedHistoryView],
  );

  useEffect(() => {
    if (isPackedHistoryView) {
      if (selectedDateKey !== null) {
        setSelectedDateKey(null);
      }
      return;
    }

    if (dateOptions.length === 0) {
      if (selectedDateKey !== null) {
        setSelectedDateKey(null);
      }
      return;
    }

    if (selectedDateKey && dateOptions.some((option) => option.key === selectedDateKey)) {
      return;
    }

    const preferred = dateOptions.find((option) => option.isToday)?.key ?? dateOptions[0]?.key ?? null;
    setSelectedDateKey(preferred);
  }, [dateOptions, isPackedHistoryView, selectedDateKey]);

  useEffect(() => {
    setActiveBasketId(null);
  }, [filters.storeId, filters.tenantId, statusFilter]);

  const updateFilter = (value: string | null) => {
    setFilters((current) => {
      if (activeFilter === 'tenant') {
        return {
          tenantId: value,
          storeId: null,
        };
      }

      return {
        ...current,
        storeId: value,
      };
    });
    setActiveFilter(null);
  };

  const openTask = useCallback((task: WmsMobilePickingTask) => {
    if (task.assignmentMode === 'BASKET_DEMAND' && task.basket?.id) {
      setActiveBasketId(task.basket.id);
      setActiveTaskId(task.id);
      void fetchBasketPlan(task.basket.id).then((result) => {
        if (!result) {
          setActiveBasketId(null);
          setActiveTaskId(null);
          return;
        }

        setActiveTaskId(result.plan.activeOrder?.id ?? task.id);
      });
      return;
    }

    setActiveBasketId(null);
    if (task.status === 'PACKED') {
      setActiveTaskId(task.id);
      return;
    }

    void fetchTaskDetails(task.id).then((result) => {
      if (!result) {
        setActiveTaskId(null);
      }
    });
  }, [fetchBasketPlan, fetchTaskDetails, setActiveTaskId]);

  const handleDemandWaybill = useCallback(async (basketId: string, code: string) => {
    const result = await scanBasketWaybill(basketId, code);
    if (result) {
      setActiveTaskId(result.activeOrderId);
    }
    return Boolean(result);
  }, [scanBasketWaybill, setActiveTaskId]);

  const handleDemandUnit = useCallback(async (basketId: string, orderId: string, code: string) => {
    const result = await scanBasketOrderUnit(basketId, orderId, code);
    if (result) {
      setActiveTaskId(result.activeOrderId);
    }
    return Boolean(result);
  }, [scanBasketOrderUnit, setActiveTaskId]);

  const handleDemandComplete = useCallback(async (basketId: string, orderId: string) => {
    return completeBasketOrder(basketId, orderId);
  }, [completeBasketOrder]);

  if (isLoading && !packing) {
    return (
      <SurfaceCard style={styles.loadingCard}>
        <ActivityIndicator color={tokens.colors.panel} />
        <Text style={styles.loadingText}>Loading pack queue</Text>
      </SurfaceCard>
    );
  }

  return (
    <View style={[styles.workspaceShell, error ? styles.workspaceShellWithError : null]}>
      <FloatingErrorBanner message={error} />

      {!activeTask && !activeBasketView ? (
        <>
          <View style={styles.queueHeader}>
            <TaskHeaderIconButton
              icon="refresh-cw"
              loading={isRefreshing}
              onPress={refreshPacking}
            />
            <Text style={styles.queueHeaderTitle}>Today&apos;s Tasks</Text>
            <View style={styles.queueBellButton}>
              <Feather name="bell" size={18} color="#1F1F28" />
              <View style={styles.queueBellDot} />
            </View>
          </View>

          {!isPackedHistoryView && dateOptions.length > 0 ? (
            <TaskDateCarousel
              options={dateOptions}
              value={selectedDateKey}
              onChange={setSelectedDateKey}
            />
          ) : null}

          {!isPackedHistoryView ? (
            <View style={styles.queueFilterStack}>
              {bootstrap.user.role === 'SUPER_ADMIN' ? (
                <ScopeDropdownCard
                  icon="briefcase"
                  label="Partner"
                  value={activePartnerName}
                  onPress={() => setActiveFilter('tenant')}
                />
              ) : null}

              <ScopeDropdownCard
                icon="shopping-bag"
                label="Store"
                value={activeStoreName}
                onPress={() => setActiveFilter('store')}
              />
            </View>
          ) : null}
        </>
      ) : null}

      {isDemandExecutionLoading ? (
        <SurfaceCard style={styles.loadingCard}>
          <ActivityIndicator color={tokens.colors.panel} />
          <Text style={styles.loadingText}>Loading basket</Text>
        </SurfaceCard>
      ) : (activeBasketView || activeTask) ? (
        activeBasketView?.plan.mode === 'BASKET_DEMAND' ? (
          <DemandPackExecutionCard
            basket={activeBasketView.basket}
            device={device}
            isSubmitting={isSubmitting}
            onBack={() => {
              setActiveBasketId(null);
              setActiveTaskId(null);
            }}
            onRefresh={async () => {
              if (
                activeBasketView.plan.totals.remaining === 0
                && activeBasketView.plan.orderProgress.remaining === 0
              ) {
                await refreshPacking();
                return;
              }

              if (activeBasketView.basket.id) {
                await fetchBasketPlan(activeBasketView.basket.id);
              }
            }}
            onCompleteOrder={handleDemandComplete}
            onScanUnit={handleDemandUnit}
            onScanWaybill={handleDemandWaybill}
            plan={activeBasketView.plan}
            session={session}
            tasks={activeBasketView.tasks}
          />
        ) : activeTask ? (
          <PackExecutionCard
          canDirectVoid={canDirectVoid}
          device={device}
          isSubmitting={isSubmitting}
          task={activeTask}
          onBack={() => {
            setActiveBasketId(null);
            setActiveTaskId(null);
          }}
          onComplete={completeTask}
          onRefresh={refreshPacking}
          onScanUnit={scanUnit}
          onStart={startTask}
          onVerifyTracking={verifyTracking}
          onVoid={voidTask}
          session={session}
          />
        ) : null
      ) : (
        <>
          <PackStatusFilterRow value={statusFilter} onChange={setStatusFilter} />

          {!queueEntries.length ? (
            <SurfaceCard style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>No pack tasks</Text>
              <Text style={styles.emptyCopy}>
                Picked baskets assigned to this pack station will appear here after picker handoff.
              </Text>
            </SurfaceCard>
          ) : null}

          <View style={styles.taskList}>
            {queueEntries.map((entry) => (
              <PackQueueCard
                key={entry.key}
                active={isPackQueueEntryActive(entry, activeTaskId, activeBasketId)}
                entry={entry}
                onPress={() => openTask(entry.primaryTask)}
              />
            ))}
          </View>

          {packing?.pagination.hasMore ? (
            <PrimaryButton
              label="Load more"
              loading={isLoadingMore}
              onPress={loadMore}
              variant="secondary"
            />
          ) : null}
        </>
      )}

      {!isPackedHistoryView ? (
        <StockScopeFilterModal
          options={filterOptions}
          title={activeFilter === 'tenant' ? 'Partner' : 'Store'}
          visible={activeFilter !== null}
          onClose={() => setActiveFilter(null)}
          onSelect={updateFilter}
        />
      ) : null}
    </View>
  );
}

function PackStatusFilterRow({
  value,
  onChange,
}: {
  value: PackingStatusFilter | null;
  onChange: (status: PackingStatusFilter | null) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.statusFilterRow}>
      {PACK_STATUS_FILTERS.map((option) => {
        const active = value === option.value;
        return (
          <Pressable
            key={option.label}
            onPress={() => onChange(option.value)}
            style={[styles.statusFilterChip, active ? styles.statusFilterChipActive : null]}>
            <Text style={[styles.statusFilterText, active ? styles.statusFilterTextActive : null]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ScopeDropdownCard({
  icon,
  label,
  value,
  onPress,
}: {
  icon: ComponentProps<typeof Feather>['name'];
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.scopeDropdownWrap, pressed ? styles.scopeDropdownWrapPressed : null]}>
      <SurfaceCard style={styles.scopeDropdownCard}>
        <View style={styles.scopeDropdownIcon}>
          <Feather name={icon} size={15} color="#F55DB8" />
        </View>
        <View style={styles.scopeDropdownCopy}>
          <Text style={styles.scopeDropdownLabel}>{label}</Text>
          <Text numberOfLines={1} style={styles.scopeDropdownValue}>{value}</Text>
        </View>
        <Feather name="chevron-down" size={18} color="#2B2836" />
      </SurfaceCard>
    </Pressable>
  );
}

function TaskDateCarousel({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: string; month: string; day: string; weekday: string }>;
  value: string | null;
  onChange: (key: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.dateCarousel}>
      {options.map((option) => {
        const active = value === option.key;
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.key)}
            style={({ pressed }) => [
              styles.dateCard,
              active ? styles.dateCardActive : null,
              pressed ? styles.dateCardPressed : null,
            ]}>
            <Text style={[styles.dateCardMonth, active ? styles.dateCardMonthActive : null]}>{option.month}</Text>
            <Text style={[styles.dateCardDay, active ? styles.dateCardDayActive : null]}>{option.day}</Text>
            <Text style={[styles.dateCardWeekday, active ? styles.dateCardWeekdayActive : null]}>{option.weekday}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function PackQueueCard({
  active,
  entry,
  onPress,
}: {
  active: boolean;
  entry: PackQueueEntry;
  onPress: () => void;
}) {
  if (entry.kind === 'basket') {
    return (
      <PackBasketCard
        active={active}
        basket={entry.basket}
        tasks={entry.tasks}
        onPress={onPress}
      />
    );
  }

  return (
    <PackTaskCard
      active={active}
      task={entry.primaryTask}
      onPress={onPress}
    />
  );
}

function PackTaskCard({
  active,
  task,
  onPress,
}: {
  active: boolean;
  task: WmsMobilePickingTask;
  onPress: () => void;
}) {
  const visibleLines = getVisiblePackLines(task.lines);
  const tracking = task.tracking?.trim() || null;
  const basketStatus = task.basket?.status ?? task.status;
  const basketStatusLabel = task.basket?.status === 'FULL_HELD'
    ? 'Awaiting pack'
    : (task.basket?.statusLabel ?? task.statusLabel);
  const summary = visibleLines
    .slice(0, 2)
    .map((line) => `${line.required}x ${line.productName}`)
    .join(' • ');

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.taskPressable,
        pressed ? styles.pressed : null,
        active ? styles.activeTaskPressable : null,
      ]}>
      <SurfaceCard style={styles.compactTaskCard}>
        <View style={styles.compactTopRow}>
          <Text numberOfLines={1} style={styles.compactStoreLabel}>
            {task.store?.name ?? 'Store'}
          </Text>
          <View style={styles.compactIconBadge}>
            <Feather name="archive" size={14} color="#9C83FF" />
          </View>
        </View>

        <Text numberOfLines={1} style={styles.compactOrderTitle}>{task.posOrderId}</Text>

        <Text numberOfLines={1} style={styles.compactSummary}>
          {tracking ? `Tracking ${tracking}` : 'Awaiting tracking print'}
        </Text>

        <Text numberOfLines={2} style={styles.compactMetaText}>
          {summary || `${task.totals.required} required unit${task.totals.required === 1 ? '' : 's'}`}
        </Text>

        {task.basket ? (
          <Text numberOfLines={1} style={styles.compactBasketText}>
            Basket {task.basket.barcode} · {task.basket.activeFulfillmentOrders}/{task.basket.maxFulfillmentOrders} orders
          </Text>
        ) : null}

        <View style={styles.compactFooterRow}>
          <View style={styles.compactDateMeta}>
            <Feather name="clock" size={13} color="#9C83FF" />
            <Text style={styles.compactDateValue}>
              {formatPackQueueDate(getPackTaskQueueDateValue(task))}
            </Text>
          </View>
          <PackStateBadge status={basketStatus} label={mapPackCardStatus(task, basketStatusLabel, tracking)} />
        </View>
      </SurfaceCard>
    </Pressable>
  );
}

function PackBasketCard({
  active,
  basket,
  tasks,
  onPress,
}: {
  active: boolean;
  basket: NonNullable<WmsMobilePickingTask['basket']>;
  tasks: WmsMobilePickingTask[];
  onPress: () => void;
}) {
  const primaryTask = pickPrimaryPackTask(tasks);
  const totalRequired = tasks.reduce((sum, task) => sum + task.totals.required, 0);
  const totalPacked = tasks.reduce((sum, task) => sum + task.totals.packed, 0);
  const storeLabel = formatPackBasketStoreLabel(tasks);
  const trackingLabel = formatPackBasketTrackingLabel(tasks);
  const basketStatusLabel = mapPackBasketStatusLabel(tasks);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.taskPressable,
        pressed ? styles.pressed : null,
        active ? styles.activeTaskPressable : null,
      ]}>
      <SurfaceCard style={styles.compactTaskCard}>
        <View style={styles.compactTopRow}>
          <Text numberOfLines={1} style={styles.compactStoreLabel}>
            {storeLabel}
          </Text>
          <View style={styles.compactIconBadge}>
            <Feather name="archive" size={14} color="#9C83FF" />
          </View>
        </View>

        <Text numberOfLines={1} style={styles.compactOrderTitle}>Basket {basket.barcode}</Text>

        <Text numberOfLines={1} style={styles.compactSummary}>
          {trackingLabel}
        </Text>

        <Text numberOfLines={2} style={styles.compactMetaText}>
          {formatPackBasketUnitSummary(totalPacked, totalRequired)}
        </Text>

        <Text numberOfLines={1} style={styles.compactBasketText}>
          {formatPackBasketSlotSummary(basket)}
        </Text>

        <View style={styles.compactFooterRow}>
          <View style={styles.compactDateMeta}>
            <Feather name="clock" size={13} color="#9C83FF" />
            <Text style={styles.compactDateValue}>
              {formatPackQueueDate(getPackTaskQueueDateValue(primaryTask))}
            </Text>
          </View>
          <PackStateBadge status={basket.status} label={basketStatusLabel} />
        </View>
      </SurfaceCard>
    </Pressable>
  );
}

function DemandPackExecutionCard({
  basket,
  device,
  isSubmitting,
  onBack,
  onCompleteOrder,
  onRefresh,
  onScanUnit,
  onScanWaybill,
  plan,
  session,
  tasks,
}: {
  basket: WmsMobilePickingTask['basket'];
  device: DeviceIdentity | null;
  isSubmitting: boolean;
  onBack: () => void;
  onCompleteOrder: (basketId: string, orderId: string) => Promise<boolean>;
  onRefresh: () => void | Promise<void>;
  onScanUnit: (basketId: string, orderId: string, code: string) => Promise<boolean>;
  onScanWaybill: (basketId: string, code: string) => Promise<boolean>;
  plan: WmsMobileBasketPackPlan;
  session: StoredSession;
  tasks: WmsMobilePickingTask[];
}) {
  const [proofVisible, setProofVisible] = useState(false);
  const [waybillCode, setWaybillCode] = useState('');
  const [unitCode, setUnitCode] = useState('');
  const waybillSubmitInFlightRef = useRef(false);
  const unitSubmitInFlightRef = useRef(false);
  const selectedOrder = plan.activeOrder;
  const selectedOrderId = selectedOrder?.id ?? null;
  const changedTask = tasks.find((task) => (
    task.id === selectedOrderId && task.itemChange
  )) ?? tasks.find((task) => Boolean(task.itemChange)) ?? null;
  const basketLabel = basket?.barcode ?? plan.basketCode;
  const remainingOrders = plan.orderProgress.remaining;
  const availableUnitCount = plan.availableUnits.reduce((total, unit) => total + unit.unitCount, 0);
  const isComplete = plan.totals.remaining === 0 && plan.orderProgress.remaining === 0;
  const activeOrderReadyToComplete = Boolean(
    selectedOrder
    && selectedOrder.totals.required > 0
    && selectedOrder.totals.remaining === 0,
  );
  const packingProof = usePackingProof({
    device,
    enabled: activeOrderReadyToComplete,
    orderId: selectedOrderId,
    session,
  });

  useEffect(() => {
    setWaybillCode('');
    setUnitCode('');
    setProofVisible(false);
  }, [plan.basketId]);

  useEffect(() => {
    setProofVisible(false);
  }, [selectedOrderId]);

  const submitWaybill = async () => {
    if (!basket?.id || waybillSubmitInFlightRef.current || isSubmitting || isComplete) {
      return;
    }

    const code = waybillCode.trim();
    if (!code) {
      return;
    }

    waybillSubmitInFlightRef.current = true;
    try {
      await onScanWaybill(basket.id, code);
      setWaybillCode('');
    } finally {
      waybillSubmitInFlightRef.current = false;
    }
  };

  const submitUnit = async () => {
    if (
      !basket?.id
      || !selectedOrder
      || activeOrderReadyToComplete
      || unitSubmitInFlightRef.current
      || isSubmitting
    ) {
      return;
    }

    const code = unitCode.trim();
    if (!code) {
      return;
    }

    unitSubmitInFlightRef.current = true;
    try {
      await onScanUnit(basket.id, selectedOrder.id, code);
      setUnitCode('');
    } finally {
      unitSubmitInFlightRef.current = false;
    }
  };

  const completeOrderWithProof = async () => {
    if (!basket?.id || !selectedOrder || packingProof.isLoading || packingProof.isUploading) {
      return false;
    }

    if (!packingProof.hasProof) {
      packingProof.clearError();
      setProofVisible(true);
      return false;
    }

    const completed = await onCompleteOrder(basket.id, selectedOrder.id);
    if (completed) {
      setWaybillCode('');
      setUnitCode('');
    }

    return completed;
  };

  const scannerTarget = isComplete
    ? null
    : selectedOrder
      ? activeOrderReadyToComplete
        ? null
        : {
            value: unitCode,
            onChangeText: setUnitCode,
            onSubmit: submitUnit,
          }
      : {
          value: waybillCode,
          onChangeText: setWaybillCode,
          onSubmit: submitWaybill,
        };

  return (
    <>
      <HiddenScannerCapture
        focusKey={`${plan.basketId}:${selectedOrderId ?? 'waybill'}`}
        enabled={!isComplete}
        locked={!scannerTarget || isSubmitting || proofVisible}
        value={scannerTarget?.value ?? ''}
        onChangeText={scannerTarget?.onChangeText ?? noopScannerChange}
        onSubmit={scannerTarget?.onSubmit ?? noopScannerSubmit}
      />

      <View style={styles.executionHeader}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Feather name="chevron-left" size={20} color={tokens.colors.ink} />
        </Pressable>
        <View style={styles.executionTitleGroup}>
          <Text numberOfLines={1} style={styles.executionTitle}>Basket {basketLabel}</Text>
          <Text numberOfLines={1} style={styles.executionMeta}>
            {basket?.warehouse?.name ?? 'Warehouse'} · {remainingOrders} open
          </Text>
        </View>
        <TaskHeaderIconButton
          icon="refresh-cw"
          loading={isSubmitting}
          onPress={onRefresh}
        />
        <PackStateBadge
          status={basket?.status ?? plan.status}
          label={selectedOrder ? 'Packing' : isComplete ? 'Packed' : 'Awaiting pack'}
        />
      </View>

      <DemandPackFloatingCounter
        actionDisabled={packingProof.isLoading || packingProof.isUploading}
        actionLabel={packingProof.isLoading
          ? 'Checking proof'
          : packingProof.hasProof
            ? 'Done packing'
            : 'Add packing proof'}
        isSubmitting={isSubmitting || packingProof.isLoading}
        onCompleteOrder={
          basket?.id && selectedOrder && activeOrderReadyToComplete
            ? completeOrderWithProof
            : null
        }
        plan={plan}
      />

      <SurfaceCard style={styles.executionCard}>
        <OrderChangeNotice change={changedTask?.itemChange ?? null} disabled />

        <View style={styles.taskProgressRow}>
          <View>
            <Text style={styles.bigProgress}>{plan.totals.packed}/{plan.totals.required}</Text>
            <Text style={styles.progressLabel}>basket units packed</Text>
          </View>
          <UtilityPill icon="shopping-bag" label={`${plan.orderProgress.total} orders`} />
        </View>

        <View style={styles.basketSummary}>
          <Text style={styles.basketLabel}>Basket {basketLabel}</Text>
          <Text style={styles.historyMeta}>
            {availableUnitCount} ready · {plan.totals.remaining} left
          </Text>
        </View>

        <DemandPackOrderList
          activeOrderId={selectedOrder?.id ?? null}
          orders={plan.orders}
        />

        {isComplete ? (
          <View style={styles.donePanelCompact}>
            <Feather name="check-circle" size={24} color={tokens.colors.success} />
            <Text style={styles.doneTitle}>Basket complete</Text>
            <Text style={styles.doneCopy}>All basket orders are packed.</Text>
          </View>
        ) : (
          <View style={styles.scanPanel}>
            {selectedOrder ? (
              <>
                <View style={styles.demandActiveOrderCard}>
                  <View style={styles.demandActiveOrderHeader}>
                    <View style={styles.demandActiveOrderCopy}>
                      <Text numberOfLines={1} style={styles.demandActiveOrderCode}>#{selectedOrder.posOrderId}</Text>
                      <Text numberOfLines={1} style={styles.demandActiveOrderMeta}>
                        {selectedOrder.customerName ?? selectedOrder.tracking ?? 'Selected order'}
                      </Text>
                    </View>
                    <Text style={styles.demandActiveOrderQty}>
                      {selectedOrder.totals.packed}/{selectedOrder.totals.required}
                    </Text>
                  </View>
                </View>

                {activeOrderReadyToComplete ? (
                  <View style={styles.donePanelCompact}>
                    <Feather
                      name={packingProof.hasProof ? 'check-circle' : 'camera'}
                      size={24}
                      color={packingProof.hasProof ? tokens.colors.success : tokens.colors.panel}
                    />
                    <Text style={styles.doneTitle}>
                      {packingProof.hasProof ? 'Packing proof saved' : 'Packing proof required'}
                    </Text>
                    <Text style={styles.doneCopy}>
                      {packingProof.hasProof
                        ? 'Done packing will finish this waybill.'
                        : 'Take or select one clear item photo before finishing this waybill.'}
                    </Text>
                  </View>
                ) : (
                  <ScannerInput
                    autoSubmit
                    label="Unit"
                    placeholder="Scan basket unit"
                    scannerOnly
                    value={unitCode}
                    disabled={isSubmitting}
                    onChangeText={setUnitCode}
                    onSubmit={submitUnit}
                  />
                )}
              </>
            ) : (
              <ScannerInput
                autoSubmit
                label="Waybill"
                placeholder="Scan waybill"
                scannerOnly
                value={waybillCode}
                disabled={isSubmitting}
                onChangeText={setWaybillCode}
                onSubmit={submitWaybill}
              />
            )}
          </View>
        )}
      </SurfaceCard>

      <SectionLabel title={selectedOrder ? 'Order items' : 'Basket items'} />
      <View style={styles.itemList}>
        {selectedOrder
          ? selectedOrder.lines.map((line) => (
              <SurfaceCard key={line.id} tone="muted" style={styles.itemCard}>
                <View style={styles.itemHeader}>
                  <Text numberOfLines={1} style={styles.itemName}>{line.productName}</Text>
                  <Text style={styles.itemQty}>{line.packed}/{line.required}</Text>
                </View>
                <Text numberOfLines={1} style={styles.itemMeta}>
                  {line.remaining} left
                </Text>
              </SurfaceCard>
            ))
          : plan.availableUnits.map((unit) => (
              <SurfaceCard key={`${unit.variationId}:${unit.productId ?? ''}`} tone="muted" style={styles.itemCard}>
                <View style={styles.itemHeader}>
                  <Text numberOfLines={1} style={styles.itemName}>{unit.productName}</Text>
                  <Text style={styles.itemQty}>{unit.unitCount}</Text>
                </View>
                <Text numberOfLines={1} style={styles.itemMeta}>
                  {unit.productDisplayId ?? unit.variationId}
                </Text>
              </SurfaceCard>
            ))}
      </View>

      {proofVisible && selectedOrder ? (
        <PackingProofModal
          error={packingProof.error}
          isUploading={packingProof.isUploading}
          orderLabel={`Order #${selectedOrder.posOrderId}`}
          visible
          onClose={() => {
            packingProof.clearError();
            setProofVisible(false);
          }}
          onSave={packingProof.upload}
        />
      ) : null}
    </>
  );
}

function PackExecutionCard({
  canDirectVoid,
  device,
  isSubmitting,
  task,
  onBack,
  onComplete,
  onRefresh,
  onScanUnit,
  onStart,
  onVerifyTracking,
  onVoid,
  session,
}: {
  canDirectVoid: boolean;
  device: DeviceIdentity | null;
  isSubmitting: boolean;
  task: WmsMobilePickingTask;
  onBack: () => void;
  onComplete: (taskId: string, trackingCode: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onScanUnit: (taskId: string, code: string) => Promise<boolean>;
  onStart: (taskId: string) => Promise<boolean>;
  onVerifyTracking: (taskId: string, code: string) => Promise<string | null>;
  onVoid: (params: {
    taskId: string;
    reason: string;
    supervisorIdentifier?: string | null;
    supervisorPassword?: string | null;
  }) => Promise<boolean>;
  session: StoredSession;
}) {
  const [proofVisible, setProofVisible] = useState(false);
  const [unitCode, setUnitCode] = useState('');
  const [trackingCode, setTrackingCode] = useState('');
  const [verifiedTracking, setVerifiedTracking] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [supervisorIdentifier, setSupervisorIdentifier] = useState('');
  const [supervisorPassword, setSupervisorPassword] = useState('');
  const [voidVisible, setVoidVisible] = useState(false);
  const unitSubmitInFlightRef = useRef(false);
  const trackingSubmitInFlightRef = useRef(false);
  const tracking = task.tracking?.trim() || null;
  const canStart = task.status === 'PICKED' && Boolean(tracking);
  const isPacking = task.status === 'PACKING';
  const isAwaitingTracking = !tracking;
  const packedAll = task.totals.packed >= task.totals.required && task.totals.required > 0;
  const isPacked = task.status === 'PACKED';
  const nextUnit = getNextPackReservation(task);
  const packingProof = usePackingProof({
    device,
    enabled: isPacking && packedAll,
    orderId: task.id,
    session,
  });

  useEffect(() => {
    setUnitCode('');
    setTrackingCode('');
    setVerifiedTracking(null);
    setVoidReason('');
    setSupervisorIdentifier('');
    setSupervisorPassword('');
    setVoidVisible(false);
    setProofVisible(false);
  }, [task.id]);

  const submitUnit = async () => {
    if (unitSubmitInFlightRef.current || isSubmitting) {
      return;
    }

    const code = unitCode.trim();
    if (!code) {
      return;
    }

    unitSubmitInFlightRef.current = true;
    try {
      const ok = await onScanUnit(task.id, code);
      if (ok) {
        setUnitCode('');
      }
    } finally {
      unitSubmitInFlightRef.current = false;
    }
  };

  const submitTracking = async () => {
    if (trackingSubmitInFlightRef.current || isSubmitting) {
      return;
    }

    const code = trackingCode.trim();
    if (!code) {
      return;
    }

    trackingSubmitInFlightRef.current = true;
    try {
      const verified = await onVerifyTracking(task.id, code);
      if (verified) {
        setTrackingCode(verified);
        setVerifiedTracking(verified);
      }
    } finally {
      trackingSubmitInFlightRef.current = false;
    }
  };

  const submitVoid = async () => {
    const reason = voidReason.trim();
    if (!reason || isSubmitting) {
      return;
    }

    const ok = await onVoid({
      taskId: task.id,
      reason,
      supervisorIdentifier: canDirectVoid ? null : supervisorIdentifier.trim(),
      supervisorPassword: canDirectVoid ? null : supervisorPassword,
    });

    if (ok) {
      setVoidVisible(false);
      setVoidReason('');
      setSupervisorIdentifier('');
      setSupervisorPassword('');
    }
  };

  const scannerTarget = isPacking
    ? !packedAll
      ? {
          value: unitCode,
          onChangeText: setUnitCode,
          onSubmit: submitUnit,
        }
      : {
          value: trackingCode,
          onChangeText: (value: string) => {
            setTrackingCode(value);
            setVerifiedTracking(null);
          },
          onSubmit: submitTracking,
        }
    : null;

  return (
    <>
      <HiddenScannerCapture
        focusKey={`${task.id}:${packedAll ? 'tracking' : 'unit'}`}
        enabled={isPacking}
        locked={!scannerTarget || isSubmitting || proofVisible}
        value={scannerTarget?.value ?? ''}
        onChangeText={scannerTarget?.onChangeText ?? noopScannerChange}
        onSubmit={scannerTarget?.onSubmit ?? noopScannerSubmit}
      />

      <View style={styles.executionHeader}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Feather name="chevron-left" size={20} color={tokens.colors.ink} />
        </Pressable>
        <View style={styles.executionTitleGroup}>
          <Text numberOfLines={1} style={styles.executionTitle}>#{task.posOrderId}</Text>
          <Text numberOfLines={1} style={styles.executionMeta}>
            {task.customer.name ?? task.store?.name ?? 'Pack task'}
          </Text>
        </View>
        <PackStateBadge
          status={task.basket?.status ?? task.status}
          label={mapPackCardStatus(task, task.basket?.statusLabel ?? task.statusLabel, tracking)}
        />
      </View>

      <SurfaceCard style={styles.executionCard}>
        <OrderChangeNotice change={task.itemChange} disabled />

        <View style={styles.taskProgressRow}>
          <View>
            <Text style={styles.bigProgress}>{task.totals.packed}/{task.totals.required}</Text>
            <Text style={styles.progressLabel}>units packed</Text>
          </View>
          <UtilityPill icon="package" label={`Basket ${task.basket?.barcode ?? 'None'}`} />
        </View>

        <View style={styles.basketSummary}>
          <Text style={styles.basketLabel}>Picker {task.claimedBy?.name ?? task.claimedBy?.email ?? 'Unknown'}</Text>
          <Text style={styles.historyMeta}>
            {tracking ? `Tracking ${tracking}` : 'Awaiting tracking print'}
          </Text>
        </View>

        <PackBasketOrderList task={task} />

        {isAwaitingTracking ? (
          <View style={styles.blockedPanel}>
            <Text style={styles.blockedTitle}>Awaiting tracking</Text>
            <Text style={styles.blockedCopy}>
              This order cannot start packing until the waybill is printed and `posOrders.tracking` is available.
            </Text>
            <PrimaryButton label="Resync" onPress={onRefresh} variant="secondary" />
          </View>
        ) : null}

        {isPacked ? (
          <View style={styles.donePanelCompact}>
            <Feather name="check-circle" size={24} color={tokens.colors.success} />
            <Text style={styles.doneTitle}>{task.delivery?.label ?? 'Packed'}</Text>
            <Text style={styles.doneCopy}>
              {resolvePackedStateCopy(task)}
            </Text>
          </View>
        ) : null}

        {canStart ? (
          <PrimaryButton
            label="Start packing"
            loading={isSubmitting}
            onPress={() => void onStart(task.id)}
          />
        ) : null}

        {task.status === 'PICKED' || task.status === 'PACKING' || task.status === 'PACKED' ? (
          <Pressable
            disabled={isSubmitting}
            onPress={() => setVoidVisible(true)}
            style={({ pressed }) => [
              styles.voidButton,
              pressed && !isSubmitting ? styles.pressed : null,
              isSubmitting ? styles.voidButtonDisabled : null,
            ]}>
            <Feather name="slash" size={15} color="#B42318" />
            <Text style={styles.voidButtonLabel}>Void order</Text>
          </Pressable>
        ) : null}

        {isPacking ? (
          <View style={styles.scanPanel}>
            {nextUnit ? (
              <View style={styles.nextUnitCard}>
                <Text style={styles.scanLabel}>Next unit</Text>
                <Text numberOfLines={1} style={styles.nextUnitCode}>{nextUnit.unit.code}</Text>
                <Text numberOfLines={1} style={styles.nextUnitName}>{nextUnit.unit.name}</Text>
              </View>
            ) : (
              <View style={styles.donePanelCompact}>
                <Feather name="check-circle" size={24} color={tokens.colors.success} />
                <Text style={styles.doneTitle}>All units verified</Text>
                <Text style={styles.doneCopy}>
                  Scan the tracking barcode, then mark this order packed.
                </Text>
              </View>
            )}

            {!packedAll ? (
              <ScannerInput
                autoSubmit
                label="Unit"
                placeholder="Scan picked unit"
                scannerOnly
                value={unitCode}
                disabled={isSubmitting}
                helper="Only units reserved for this order are accepted. Open sibling basket orders separately."
                onChangeText={setUnitCode}
                onSubmit={submitUnit}
              />
            ) : null}

            <ScannerInput
              autoSubmit
              label="Tracking"
              placeholder={tracking ?? 'Scan tracking barcode'}
              scannerOnly
              value={trackingCode}
              disabled={isSubmitting}
              helper={verifiedTracking ? `Verified ${verifiedTracking}` : 'Scan the waybill barcode to confirm the order tracking number.'}
              onChangeText={(value) => {
                setTrackingCode(value);
                setVerifiedTracking(null);
              }}
              onSubmit={submitTracking}
            />

            <PrimaryButton
              disabled={
                !packedAll
                || packingProof.isLoading
                || packingProof.isUploading
                || (packingProof.hasProof && !verifiedTracking)
              }
              label={packingProof.isLoading
                ? 'Checking proof'
                : packingProof.hasProof
                  ? 'Mark packed'
                  : 'Add packing proof'}
              loading={isSubmitting || packingProof.isLoading}
              onPress={() => {
                if (!packingProof.hasProof) {
                  packingProof.clearError();
                  setProofVisible(true);
                  return;
                }

                void onComplete(task.id, verifiedTracking ?? trackingCode);
              }}
            />
          </View>
        ) : null}
      </SurfaceCard>

      <SectionLabel title="Items" />
      <View style={styles.itemList}>
        {getVisiblePackLines(task.lines).map((line) => (
          <SurfaceCard key={line.id} tone="muted" style={styles.itemCard}>
            <View style={styles.itemHeader}>
              <Text numberOfLines={1} style={styles.itemName}>{line.productName}</Text>
              <Text style={styles.itemQty}>{line.packed}/{line.required}</Text>
            </View>
            <Text numberOfLines={1} style={styles.itemMeta}>
              {line.packed >= line.required ? 'Verified' : `${line.required - line.packed} left to verify`}
            </Text>
          </SurfaceCard>
        ))}
      </View>

      {proofVisible ? (
        <PackingProofModal
          error={packingProof.error}
          isUploading={packingProof.isUploading}
          orderLabel={`Order #${task.posOrderId}`}
          visible
          onClose={() => {
            packingProof.clearError();
            setProofVisible(false);
          }}
          onSave={packingProof.upload}
        />
      ) : null}

      <Modal
        transparent
        animationType="fade"
        visible={voidVisible}
        onRequestClose={() => setVoidVisible(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={styles.modalBackdropPressable} onPress={() => setVoidVisible(false)} />
          <SurfaceCard style={styles.voidModalCard}>
            <View style={styles.voidModalHeader}>
              <Text style={styles.voidModalTitle}>Void pack order</Text>
              <Pressable onPress={() => setVoidVisible(false)} style={styles.voidModalClose}>
                <Feather name="x" size={18} color={tokens.colors.ink} />
              </Pressable>
            </View>
            <Text style={styles.voidModalCopy}>
              This will cancel the fulfillment task and return all involved units back to inventory bins.
            </Text>

            <TextField
              label="Reason"
              multiline
              numberOfLines={3}
              placeholder="Order canceled, discontinued, customer changed item, etc."
              value={voidReason}
              onChangeText={setVoidReason}
              style={styles.voidReasonInput}
            />

            {!canDirectVoid ? (
              <View style={styles.voidApprovalGroup}>
                <Text style={styles.voidApprovalTitle}>Supervisor approval required</Text>
                <TextField
                  label="Supervisor email or employee ID"
                  placeholder="manager@company.com or EMP-001"
                  value={supervisorIdentifier}
                  onChangeText={setSupervisorIdentifier}
                />
                <TextField
                  label="Supervisor password"
                  placeholder="Enter supervisor password"
                  secureTextEntry
                  value={supervisorPassword}
                  onChangeText={setSupervisorPassword}
                />
              </View>
            ) : null}

            <View style={styles.voidModalActions}>
              <PrimaryButton
                label="Keep order"
                onPress={() => setVoidVisible(false)}
                variant="secondary"
                style={styles.voidSecondaryAction}
              />
              <PrimaryButton
                disabled={!voidReason.trim() || (!canDirectVoid && (!supervisorIdentifier.trim() || !supervisorPassword.trim()))}
                label={canDirectVoid ? 'Void now' : 'Request void'}
                loading={isSubmitting}
                onPress={() => void submitVoid()}
                style={styles.voidPrimaryAction}
              />
            </View>
          </SurfaceCard>
        </View>
      </Modal>
    </>
  );
}

function PackBasketOrderList({ task }: { task: WmsMobilePickingTask }) {
  const basket = task.basket;
  const orders = basket?.orders ?? [];

  if (!basket || !orders.length) {
    return null;
  }

  return (
    <View style={styles.basketOrderPanel}>
      <View style={styles.basketOrderHeader}>
        <View>
          <Text style={styles.basketOrderTitle}>Basket orders</Text>
          <Text style={styles.basketOrderHint}>Selected order stays highlighted.</Text>
        </View>
        <Text style={styles.basketOrderMeta}>
          {orders.length}/{basket.maxFulfillmentOrders}
        </Text>
      </View>
      {orders.map((order) => {
        const active = order.id === task.id;
        return (
          <View key={order.id} style={[styles.basketOrderRow, active ? styles.basketOrderRowActive : null]}>
            <View style={[styles.basketOrderDot, active ? styles.basketOrderDotActive : null]} />
            <View style={styles.basketOrderCopy}>
              <Text numberOfLines={1} style={styles.basketOrderCode}>
                {order.posOrderId ? `#${order.posOrderId}` : 'Order'}
              </Text>
              <Text numberOfLines={1} style={styles.basketOrderSubcopy}>
                {active ? 'Current pack order' : order.store?.name ?? order.customerName ?? order.statusLabel ?? 'Same basket'}
              </Text>
            </View>
            <Text style={styles.basketOrderQty}>
              {order.totals.picked}/{order.totals.required}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function DemandPackOrderList({
  activeOrderId,
  orders,
}: {
  activeOrderId: string | null;
  orders: WmsMobileBasketPackPlan['orders'];
}) {
  if (!orders.length) {
    return null;
  }

  return (
    <View style={styles.basketOrderPanel}>
      <View style={styles.basketOrderHeader}>
        <View>
          <Text style={styles.basketOrderTitle}>Basket orders</Text>
        </View>
        <Text style={styles.basketOrderMeta}>{orders.length}</Text>
      </View>
      {orders.map((order) => {
        const active = order.id === activeOrderId;
        return (
          <View key={order.id} style={[styles.basketOrderRow, active ? styles.basketOrderRowActive : null]}>
            <View style={[styles.basketOrderDot, active ? styles.basketOrderDotActive : null]} />
            <View style={styles.basketOrderCopy}>
              <Text numberOfLines={1} style={styles.basketOrderCode}>
                #{order.posOrderId}
              </Text>
              <Text numberOfLines={1} style={styles.basketOrderSubcopy}>
                {order.trackingReady ? (order.tracking ?? 'Waybill ready') : 'No tracking'}
              </Text>
            </View>
            <Text style={styles.basketOrderQty}>
              {order.totals.packed}/{order.totals.required}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function DemandPackFloatingCounter({
  actionDisabled,
  actionLabel,
  isSubmitting,
  onCompleteOrder,
  plan,
}: {
  actionDisabled: boolean;
  actionLabel: string;
  isSubmitting: boolean;
  onCompleteOrder: (() => Promise<boolean>) | null;
  plan: WmsMobileBasketPackPlan;
}) {
  const setShellOverlay = useStoxShellOverlay();
  const primaryLabel = plan.activeOrder ? 'Order' : 'Orders';
  const primaryPacked = plan.activeOrder?.totals.packed ?? plan.orderProgress.packed;
  const primaryRequired = plan.activeOrder?.totals.required ?? plan.orderProgress.total;
  const dock = useMemo(() => (
    <View style={styles.demandCounterDock}>
      <View style={styles.demandCounterRow}>
        <View style={styles.demandCounterPillPrimary}>
          <Text style={styles.demandCounterLabel}>{primaryLabel}</Text>
          <Text style={styles.demandCounterValue}>{primaryPacked}/{primaryRequired}</Text>
        </View>
        <View style={styles.demandCounterPill}>
          <Text style={styles.demandCounterLabelSoft}>Basket left</Text>
          <Text style={styles.demandCounterValueSoft}>{plan.totals.remaining}</Text>
        </View>
      </View>
      {onCompleteOrder ? (
        <PrimaryButton
          disabled={actionDisabled}
          label={actionLabel}
          loading={isSubmitting}
          onPress={() => {
            void onCompleteOrder();
          }}
          style={styles.demandCounterActionButton}
        />
      ) : null}
    </View>
  ), [actionDisabled, actionLabel, isSubmitting, onCompleteOrder, plan.totals.remaining, primaryLabel, primaryPacked, primaryRequired]);

  useEffect(() => {
    if (!setShellOverlay) {
      return;
    }

    setShellOverlay(dock);
  }, [dock, setShellOverlay]);

  useEffect(() => {
    if (!setShellOverlay) {
      return undefined;
    }

    return () => {
      setShellOverlay(null);
    };
  }, [setShellOverlay]);

  if (setShellOverlay) {
    return null;
  }

  return dock;
}

function ScannerInput({
  autoSubmit = false,
  autoSubmitDelayMs = 120,
  autoSubmitMinLength = 3,
  disabled,
  helper,
  label,
  placeholder,
  scannerOnly = false,
  value,
  onChangeText,
  onSubmit,
}: {
  autoSubmit?: boolean;
  autoSubmitDelayMs?: number;
  autoSubmitMinLength?: number;
  disabled?: boolean;
  helper?: string;
  label: string;
  placeholder: string;
  scannerOnly?: boolean;
  value: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void | Promise<void>;
}) {
  const submitRef = useRef(onSubmit);
  const lastAutoSubmittedRef = useRef<string | null>(null);

  useEffect(() => {
    submitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    const cleaned = value.trim();
    if (!cleaned) {
      lastAutoSubmittedRef.current = null;
      return;
    }

    if (
      !autoSubmit
      || scannerOnly
      || disabled
      || cleaned.length < autoSubmitMinLength
      || lastAutoSubmittedRef.current === cleaned
    ) {
      return;
    }

    const timer = setTimeout(() => {
      lastAutoSubmittedRef.current = cleaned;
      void submitRef.current();
    }, autoSubmitDelayMs);

    return () => clearTimeout(timer);
  }, [autoSubmit, autoSubmitDelayMs, autoSubmitMinLength, disabled, scannerOnly, value]);

  return (
    <View style={[styles.scanInputWrap, disabled ? styles.scanInputDisabled : null]}>
      <Text style={styles.scanInputLabel}>{label}</Text>
      <View style={styles.scanInputRow}>
        <TextInput
          autoCapitalize="characters"
          autoCorrect={false}
          blurOnSubmit={false}
          caretHidden
          contextMenuHidden
          editable={!disabled && !scannerOnly}
          placeholder={placeholder}
          placeholderTextColor={tokens.colors.inkSoft}
          returnKeyType="done"
          selectTextOnFocus={false}
          showSoftInputOnFocus={false}
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={() => {
            void onSubmit();
          }}
          style={styles.scanInput}
        />
        <Pressable
          disabled={disabled}
          onPress={() => {
            void onSubmit();
          }}
          style={styles.scanSubmit}>
          <Feather name="corner-down-left" size={18} color={tokens.colors.surface} />
        </Pressable>
      </View>
      {helper ? <Text style={styles.scanHelper}>{helper}</Text> : null}
    </View>
  );
}

function HiddenScannerCapture({
  enabled,
  focusKey,
  locked = false,
  value,
  onChangeText,
  onSubmit,
  autoSubmitDelayMs = 120,
  autoSubmitMinLength = 3,
}: {
  enabled: boolean;
  focusKey: string;
  locked?: boolean;
  value: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  autoSubmitDelayMs?: number;
  autoSubmitMinLength?: number;
}) {
  const inputRef = useRef<TextInput>(null);
  const enabledRef = useRef(enabled);
  const lockedRef = useRef(locked);
  const submitRef = useRef(onSubmit);
  const lastAutoSubmittedRef = useRef<string | null>(null);

  useEffect(() => {
    submitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      lastAutoSubmittedRef.current = null;
      inputRef.current?.blur();
      return;
    }

    const focusScanner = () => {
      if (enabledRef.current && !lockedRef.current && AppState.currentState === 'active') {
        inputRef.current?.focus();
      }
    };

    const interaction = InteractionManager.runAfterInteractions(focusScanner);
    const timers = [40, 250, 650, 1_200].map((delay) => setTimeout(focusScanner, delay));
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setTimeout(focusScanner, 100);
      }
    });

    return () => {
      interaction.cancel();
      timers.forEach(clearTimeout);
      appStateSubscription.remove();
    };
  }, [enabled, focusKey, locked]);

  useEffect(() => {
    if (!enabled) {
      lastAutoSubmittedRef.current = null;
      return;
    }

    if (locked) {
      return;
    }

    const cleaned = value.trim();
    if (!cleaned) {
      lastAutoSubmittedRef.current = null;
      return;
    }

    if (cleaned.length < autoSubmitMinLength || lastAutoSubmittedRef.current === cleaned) {
      return;
    }

    const timer = setTimeout(() => {
      lastAutoSubmittedRef.current = cleaned;
      void submitRef.current();
    }, autoSubmitDelayMs);

    return () => clearTimeout(timer);
  }, [autoSubmitDelayMs, autoSubmitMinLength, enabled, locked, value]);

  return (
    <TextInput
      ref={inputRef}
      autoCapitalize="characters"
      autoCorrect={false}
      autoFocus={enabled}
      blurOnSubmit={false}
      caretHidden
      contextMenuHidden
      editable
      onBlur={() => {
        if (!enabledRef.current || lockedRef.current) {
          return;
        }

        setTimeout(() => {
          if (enabledRef.current && !lockedRef.current) {
            inputRef.current?.focus();
          }
        }, 30);
      }}
      onChangeText={(nextValue) => {
        if (!lockedRef.current) {
          onChangeText(nextValue);
        }
      }}
      onSubmitEditing={() => {
        if (!lockedRef.current) {
          void submitRef.current();
        }
      }}
      showSoftInputOnFocus={false}
      style={styles.hiddenScannerInput}
      value={value}
    />
  );
}

function noopScannerChange(_value: string) {}

function noopScannerSubmit() {}

function PackStateBadge({
  label,
  status,
}: {
  label: string;
  status: string;
}) {
  const noTracking = label === 'No tracking';
  const delivered = label === 'Delivered';
  const shipped = label === 'Shipped';
  const packed = status === 'PACKED';
  const packing = status === 'PACKING';
  const toneStyle = noTracking
    ? styles.statusBadgeDanger
    : delivered
      ? styles.statusBadgeDelivered
      : shipped
        ? styles.statusBadgeDispatch
        : packed
      ? styles.statusBadgeReady
      : packing
        ? styles.statusBadgeWarn
        : styles.statusBadgeReady;
  const textStyle = noTracking
    ? styles.statusTextDanger
    : delivered
      ? styles.statusTextDelivered
      : shipped
        ? styles.statusTextDispatch
        : packed
      ? styles.statusTextReady
      : packing
        ? styles.statusTextWarn
        : styles.statusTextReady;

  return (
    <View style={[styles.statusBadge, toneStyle]}>
      <Text style={[styles.statusText, textStyle]}>
        {label}
      </Text>
    </View>
  );
}

function getVisiblePackLines(lines: WmsMobilePickingTask['lines']) {
  return lines.filter((line) => line.status !== 'CANCELED' && line.required > 0);
}

function getNextPackReservation(task: WmsMobilePickingTask) {
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

function buildPackingFilterOptions(
  activeFilter: PackingFilterKey | null,
  packing: WmsMobilePackingResponse | null,
  bootstrap: BootstrapResponse,
  canFilterPartners: boolean,
): StockScopeOption[] {
  if (activeFilter === 'tenant' && canFilterPartners) {
    const partners = packing?.context.tenantOptions ?? bootstrap.context.tenantOptions ?? [];
    return [
      { label: 'All partners', value: null },
      ...partners.map((partner) => ({
        label: partner.name,
        value: partner.id,
        meta: partner.slug,
      })),
    ];
  }

  const stores = packing?.context.stores ?? bootstrap.context.stores;
  return [
    { label: 'All stores', value: null },
    ...stores.map((store) => ({
      label: 'shopName' in store ? store.shopName || store.name : store.name,
      value: store.id,
      meta: 'tenantName' in store && typeof store.tenantName === 'string' ? store.tenantName : undefined,
    })),
  ];
}

function resolveActivePartnerName(
  packing: { context: { tenantOptions?: Array<{ id: string; name: string }> } } | null,
  bootstrap: BootstrapResponse,
  tenantId: PackingFilters['tenantId'],
) {
  if (!tenantId) {
    return 'All partners';
  }

  const partners = packing?.context.tenantOptions ?? bootstrap.context.tenantOptions ?? [];
  return partners.find((partner) => partner.id === tenantId)?.name ?? 'Partner';
}

function resolveActiveStoreName(
  packing: { context: { stores: Array<{ id: string; name: string }> } } | null,
  bootstrap: BootstrapResponse,
  storeId: PackingFilters['storeId'],
) {
  if (!storeId) {
    return 'All stores';
  }

  const stores = packing?.context.stores ?? bootstrap.context.stores;
  return stores.find((store) => store.id === storeId)?.name ?? 'Store';
}

function buildPackQueueEntries(
  tasks: WmsMobilePickingTask[],
  options: { groupBaskets: boolean },
): PackQueueEntry[] {
  if (!options.groupBaskets) {
    return tasks.map((task) => ({
      key: `task:${task.id}`,
      kind: 'task',
      basket: task.basket,
      primaryTask: task,
      tasks: [task],
    }));
  }

  const entries: PackQueueEntry[] = [];
  const seenBaskets = new Set<string>();

  for (const task of tasks) {
    const basket = task.basket;
    if (!basket?.orders?.length) {
      entries.push({
        key: `task:${task.id}`,
        kind: 'task',
        basket,
        primaryTask: task,
        tasks: [task],
      });
      continue;
    }

    if (seenBaskets.has(basket.id)) {
      continue;
    }

    seenBaskets.add(basket.id);
    const basketTasks = tasks.filter((candidate) => candidate.basket?.id === basket.id);
    entries.push({
      key: `basket:${basket.id}`,
      kind: 'basket',
      basket,
      primaryTask: pickPrimaryPackTask(basketTasks),
      tasks: basketTasks,
    });
  }

  return entries;
}

function isPackQueueEntryActive(
  entry: PackQueueEntry,
  activeTaskId: string | null,
  activeBasketId: string | null,
) {
  if (entry.kind === 'basket') {
    if (activeBasketId && entry.basket.id === activeBasketId) {
      return true;
    }

    return entry.tasks.some((task) => task.id === activeTaskId);
  }

  return activeTaskId === entry.primaryTask.id
    || (activeBasketId !== null && activeBasketId === entry.primaryTask.basket?.id);
}

function pickPrimaryPackTask(tasks: WmsMobilePickingTask[]) {
  return [...tasks].sort((left, right) => {
    const rankDelta = getPackTaskPriority(left) - getPackTaskPriority(right);
    if (rankDelta !== 0) {
      return rankDelta;
    }

    const rightTime = parsePackDate(getPackTaskQueueDateValue(right))?.getTime() ?? 0;
    const leftTime = parsePackDate(getPackTaskQueueDateValue(left))?.getTime() ?? 0;
    return rightTime - leftTime;
  })[0] ?? tasks[0];
}

function getPackTaskPriority(task: WmsMobilePickingTask) {
  if (task.status === 'PACKING') {
    return 0;
  }

  if (!task.tracking?.trim() && task.status !== 'PACKED') {
    return 1;
  }

  if (task.status === 'PICKED') {
    return 2;
  }

  return 3;
}

function formatPackBasketStoreLabel(tasks: WmsMobilePickingTask[]) {
  const uniqueStoreNames = Array.from(new Set(
    tasks.map((task) => task.store?.name).filter((value): value is string => Boolean(value)),
  ));

  if (uniqueStoreNames.length === 0) {
    return 'Assigned basket';
  }

  if (uniqueStoreNames.length === 1) {
    return uniqueStoreNames[0];
  }

  return `${uniqueStoreNames.length} stores`;
}

function formatPackBasketTrackingLabel(tasks: WmsMobilePickingTask[]) {
  const missingTrackingCount = tasks.filter((task) => !task.tracking?.trim()).length;
  const readyTrackingCount = tasks.length - missingTrackingCount;

  if (missingTrackingCount > 0 && readyTrackingCount > 0) {
    return `${readyTrackingCount} with tracking · ${missingTrackingCount} waiting`;
  }

  if (missingTrackingCount > 0) {
    return `${missingTrackingCount} order${missingTrackingCount === 1 ? '' : 's'} waiting for tracking`;
  }

  return `${readyTrackingCount} order${readyTrackingCount === 1 ? '' : 's'} with tracking`;
}

function mapPackBasketStatusLabel(tasks: WmsMobilePickingTask[]) {
  if (tasks.some((task) => task.status === 'PACKING')) {
    return 'Packing';
  }

  if (tasks.some((task) => !task.tracking?.trim() && task.status !== 'PACKED')) {
    return 'No tracking';
  }

  if (tasks.every((task) => task.status === 'PACKED')) {
    return 'Packed';
  }

  return 'Awaiting pack';
}

function formatPackBasketUnitSummary(totalPacked: number, totalRequired: number) {
  return `${totalPacked}/${totalRequired} units packed`;
}

function formatPackBasketSlotSummary(
  basket: NonNullable<WmsMobilePickingTask['basket']>,
) {
  const openSlots = Math.max(basket.maxFulfillmentOrders - basket.activeFulfillmentOrders, 0);
  if (openSlots === 0) {
    return `${basket.activeFulfillmentOrders} orders in basket · full`;
  }

  return `${basket.activeFulfillmentOrders} orders in basket · ${openSlots} slot${openSlots === 1 ? '' : 's'} open`;
}

function getPackTaskQueueDateValue(task: WmsMobilePickingTask) {
  return task.basket?.readyForPackAt
    ?? task.basket?.fullAt
    ?? task.completedAt
    ?? task.claimedAt
    ?? task.orderDateLocal
    ?? task.orderDate
    ?? task.createdAt;
}

function buildPackDateOptions(tasks: WmsMobilePickingTask[]) {
  const seen = new Map<string, { key: string; month: string; day: string; weekday: string; isToday: boolean; sort: number }>();
  const todayKey = buildDateKey(new Date());

  for (const task of tasks) {
    const parsed = parsePackDate(getPackTaskQueueDateValue(task));
    if (!parsed) {
      continue;
    }

    const key = buildDateKey(parsed);
    if (seen.has(key)) {
      continue;
    }

    seen.set(key, {
      key,
      month: parsed.toLocaleDateString('en-PH', { month: 'short' }),
      day: parsed.toLocaleDateString('en-PH', { day: '2-digit' }),
      weekday: parsed.toLocaleDateString('en-PH', { weekday: 'short' }),
      isToday: key === todayKey,
      sort: parsed.getTime(),
    });
  }

  return Array.from(seen.values())
    .sort((left, right) => left.sort - right.sort)
    .map(({ sort, ...option }) => option);
}

function getPackTaskDateKey(task: WmsMobilePickingTask) {
  const parsed = parsePackDate(getPackTaskQueueDateValue(task));
  return parsed ? buildDateKey(parsed) : null;
}

function parsePackDate(value: string) {
  if (!value) {
    return null;
  }

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnlyMatch) {
    return new Date(
      Number(dateOnlyMatch[1]),
      Number(dateOnlyMatch[2]) - 1,
      Number(dateOnlyMatch[3]),
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function buildDateKey(date: Date) {
  return [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, '0'),
    `${date.getDate()}`.padStart(2, '0'),
  ].join('-');
}

function formatPackQueueDate(value: string) {
  const parsed = parsePackDate(value);
  if (!parsed) {
    return 'No date';
  }

  return parsed.toLocaleDateString('en-PH', {
    month: 'short',
    day: '2-digit',
  });
}

function mapPackCardStatus(
  task: WmsMobilePickingTask,
  fallback: string,
  tracking: string | null,
) {
  if (task.status === 'PACKED' && task.delivery?.label) {
    return task.delivery.label;
  }

  const { status } = task;
  if (!tracking && status !== 'PACKED') {
    return 'No tracking';
  }
  if (status === 'PICKED') {
    return 'Awaiting pack';
  }
  if (status === 'PACKING') {
    return 'Packing';
  }
  if (status === 'PACKED') {
    return 'Packed';
  }
  return fallback;
}

function resolvePackedStateCopy(task: WmsMobilePickingTask) {
  if (task.delivery?.status === 'DELIVERED') {
    return 'This order was delivered. The packed activity remains traceable in STOX history.';
  }

  if (task.delivery?.status === 'SHIPPED') {
    return 'This order already left the warehouse and its units were moved to dispatched inventory.';
  }

  return 'This order is packed and the basket has already been released back to available.';
}

const styles = StyleSheet.create({
  loadingCard: {
    alignItems: 'center',
    gap: tokens.spacing.sm,
    minHeight: 140,
    justifyContent: 'center',
  },
  workspaceShell: {
    gap: tokens.spacing.lg,
    position: 'relative',
  },
  workspaceShellWithError: {
    paddingTop: 78,
  },
  loadingText: {
    color: tokens.colors.inkMuted,
    fontSize: 14,
    fontWeight: '700',
  },
  queueHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    marginTop: 2,
  },
  queueHeaderTitle: {
    color: '#24232D',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  queueBellButton: {
    alignItems: 'center',
    height: 34,
    justifyContent: 'center',
    position: 'relative',
    width: 34,
  },
  queueBellDot: {
    backgroundColor: '#6437F6',
    borderColor: '#FBFAFF',
    borderRadius: 5,
    borderWidth: 2,
    height: 10,
    position: 'absolute',
    right: 5,
    top: 4,
    width: 10,
  },
  queueFilterStack: {
    gap: 12,
    marginBottom: 4,
  },
  scopeDropdownWrap: {
    borderRadius: 24,
  },
  scopeDropdownWrapPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.995 }],
  },
  scopeDropdownCard: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
    shadowColor: '#A38BFF',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
  },
  scopeDropdownIcon: {
    alignItems: 'center',
    backgroundColor: '#FFE1F2',
    borderRadius: 12,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  scopeDropdownCopy: {
    flex: 1,
    minWidth: 0,
  },
  scopeDropdownLabel: {
    color: '#8F8AAB',
    fontSize: 14,
    fontWeight: '600',
  },
  scopeDropdownValue: {
    color: '#24232D',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 2,
  },
  dateCarousel: {
    gap: 8,
    paddingBottom: 4,
  },
  dateCard: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 15,
    height: 80,
    justifyContent: 'center',
    shadowColor: '#9C83FF',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    width: 56,
  },
  dateCardActive: {
    backgroundColor: '#6437F6',
  },
  dateCardPressed: {
    opacity: 0.92,
  },
  dateCardMonth: {
    color: '#353346',
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 4,
  },
  dateCardMonthActive: {
    color: '#F4EEFF',
  },
  dateCardDay: {
    color: '#24232D',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 4,
  },
  dateCardDayActive: {
    color: '#FFFFFF',
  },
  dateCardWeekday: {
    color: '#59556D',
    fontSize: 12,
    fontWeight: '600',
  },
  dateCardWeekdayActive: {
    color: '#F4EEFF',
  },
  statusFilterRow: {
    gap: 10,
    paddingBottom: 4,
  },
  statusFilterChip: {
    alignItems: 'center',
    backgroundColor: '#EEE9FF',
    borderRadius: 14,
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  statusFilterChipActive: {
    backgroundColor: '#6437F6',
  },
  statusFilterText: {
    color: '#6F5BCB',
    fontSize: 15,
    fontWeight: '700',
  },
  statusFilterTextActive: {
    color: '#FFFFFF',
  },
  emptyCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    gap: 8,
    paddingVertical: 20,
    shadowColor: '#9C83FF',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.07,
    shadowRadius: 20,
  },
  emptyTitle: {
    color: '#24232D',
    fontSize: 17,
    fontWeight: '800',
  },
  emptyCopy: {
    color: '#7B7791',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  taskList: {
    gap: 18,
  },
  taskPressable: {
    borderRadius: 24,
  },
  activeTaskPressable: {
    opacity: 0.92,
  },
  pressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
  compactTaskCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 18,
    shadowColor: '#A38BFF',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.08,
    shadowRadius: 22,
  },
  compactTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  compactStoreLabel: {
    color: '#7B7791',
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    marginRight: 12,
  },
  compactIconBadge: {
    alignItems: 'center',
    backgroundColor: '#F1E9FF',
    borderRadius: 12,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  compactOrderTitle: {
    color: '#24232D',
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  compactSummary: {
    color: '#6437F6',
    fontSize: 14,
    fontWeight: '700',
  },
  compactMetaText: {
    color: '#524F66',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  compactBasketText: {
    color: '#7D7697',
    fontSize: 12,
    fontWeight: '800',
  },
  compactFooterRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  compactDateMeta: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  compactDateValue: {
    color: '#9C83FF',
    fontSize: 13,
    fontWeight: '700',
  },
  executionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.sm,
  },
  backButton: {
    alignItems: 'center',
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.pill,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  executionTitleGroup: {
    flex: 1,
    gap: 2,
  },
  executionTitle: {
    color: tokens.colors.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  executionMeta: {
    color: tokens.colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  executionCard: {
    gap: tokens.spacing.md,
  },
  taskProgressRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  bigProgress: {
    color: tokens.colors.ink,
    fontSize: 28,
    fontWeight: '900',
  },
  progressLabel: {
    color: tokens.colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  basketSummary: {
    gap: 4,
  },
  basketOrderPanel: {
    borderTopColor: '#ECE7FA',
    borderTopWidth: 1,
    gap: tokens.spacing.sm,
    paddingTop: tokens.spacing.sm,
  },
  basketOrderHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  basketOrderTitle: {
    color: tokens.colors.inkSoft,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  basketOrderHint: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  basketOrderMeta: {
    color: '#6437F6',
    fontSize: 12,
    fontWeight: '900',
  },
  basketOrderRow: {
    alignItems: 'center',
    borderBottomColor: '#F0EDF7',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    paddingHorizontal: 2,
    paddingVertical: 10,
  },
  basketOrderRowActive: {
    backgroundColor: '#FAF8FF',
  },
  basketOrderDot: {
    backgroundColor: '#D8D2EA',
    borderRadius: tokens.radius.pill,
    height: 6,
    width: 6,
  },
  basketOrderDotActive: {
    backgroundColor: '#6437F6',
  },
  basketOrderCopy: {
    flex: 1,
    minWidth: 0,
  },
  basketOrderCode: {
    color: tokens.colors.ink,
    fontSize: 12,
    fontWeight: '900',
  },
  basketOrderSubcopy: {
    color: tokens.colors.inkMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  basketOrderQty: {
    color: tokens.colors.ink,
    fontSize: 11,
    fontWeight: '900',
  },
  demandCounterDock: {
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: tokens.spacing.sm,
    justifyContent: 'center',
    marginTop: -4,
  },
  demandCounterRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    justifyContent: 'center',
  },
  demandCounterActionButton: {
    alignSelf: 'stretch',
    minHeight: 52,
    shadowOpacity: 0,
    elevation: 0,
  },
  demandCounterPillPrimary: {
    alignItems: 'center',
    backgroundColor: tokens.colors.panel,
    borderRadius: tokens.radius.pill,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  demandCounterPill: {
    alignItems: 'center',
    backgroundColor: tokens.colors.surface,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  demandCounterLabel: {
    color: '#E9E1FF',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  demandCounterLabelSoft: {
    color: tokens.colors.inkMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  demandCounterValue: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },
  demandCounterValueSoft: {
    color: tokens.colors.ink,
    fontSize: 14,
    fontWeight: '900',
  },
  basketLabel: {
    color: tokens.colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  historyMeta: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  blockedPanel: {
    backgroundColor: tokens.colors.surfaceMuted,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    gap: tokens.spacing.sm,
    padding: tokens.spacing.md,
  },
  blockedTitle: {
    color: tokens.colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  blockedCopy: {
    color: tokens.colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 20,
  },
  scanPanel: {
    gap: tokens.spacing.md,
  },
  hiddenScannerInput: {
    backgroundColor: 'transparent',
    color: 'transparent',
    height: 4,
    left: 1,
    opacity: 0.01,
    padding: 0,
    position: 'absolute',
    top: 1,
    width: 4,
  },
  demandActiveOrderCard: {
    backgroundColor: tokens.colors.surfaceMuted,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    padding: tokens.spacing.md,
  },
  demandActiveOrderHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    justifyContent: 'space-between',
  },
  demandActiveOrderCopy: {
    flex: 1,
    minWidth: 0,
  },
  demandActiveOrderCode: {
    color: tokens.colors.ink,
    fontSize: 15,
    fontWeight: '900',
  },
  demandActiveOrderMeta: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  demandActiveOrderQty: {
    color: tokens.colors.panel,
    fontSize: 14,
    fontWeight: '900',
  },
  nextUnitCard: {
    backgroundColor: tokens.colors.surfaceMuted,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    gap: 4,
    padding: tokens.spacing.md,
  },
  scanLabel: {
    color: tokens.colors.inkSoft,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  nextUnitCode: {
    color: tokens.colors.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  nextUnitName: {
    color: tokens.colors.inkMuted,
    fontSize: 14,
    fontWeight: '700',
  },
  donePanelCompact: {
    alignItems: 'center',
    gap: tokens.spacing.xs,
    paddingVertical: tokens.spacing.sm,
  },
  doneTitle: {
    color: tokens.colors.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  doneCopy: {
    color: tokens.colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 20,
    textAlign: 'center',
  },
  voidButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#FFF0F0',
    borderColor: '#F3C9C7',
    borderRadius: tokens.radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  voidButtonDisabled: {
    opacity: 0.6,
  },
  voidButtonLabel: {
    color: '#B42318',
    fontSize: 13,
    fontWeight: '800',
  },
  scanInputWrap: {
    gap: tokens.spacing.xs,
  },
  scanInputDisabled: {
    opacity: 0.6,
  },
  scanInputLabel: {
    color: tokens.colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  scanInputRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.xs,
  },
  scanInput: {
    backgroundColor: tokens.colors.surface,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    color: tokens.colors.ink,
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
    minHeight: 52,
    paddingHorizontal: tokens.spacing.md,
  },
  scanSubmit: {
    alignItems: 'center',
    backgroundColor: tokens.colors.panel,
    borderRadius: tokens.radius.lg,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  scanHelper: {
    color: tokens.colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  itemList: {
    gap: tokens.spacing.sm,
  },
  itemCard: {
    gap: 4,
  },
  itemHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    justifyContent: 'space-between',
  },
  itemName: {
    color: tokens.colors.ink,
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
  },
  itemQty: {
    color: tokens.colors.panel,
    fontSize: 13,
    fontWeight: '900',
  },
  itemMeta: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  modalBackdrop: {
    backgroundColor: 'rgba(21, 20, 31, 0.42)',
    flex: 1,
    justifyContent: 'center',
    padding: tokens.spacing.lg,
  },
  modalBackdropPressable: {
    ...StyleSheet.absoluteFillObject,
  },
  voidModalCard: {
    gap: tokens.spacing.md,
    padding: tokens.spacing.lg,
  },
  voidModalHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  voidModalTitle: {
    color: tokens.colors.ink,
    fontSize: 20,
    fontWeight: '900',
  },
  voidModalClose: {
    alignItems: 'center',
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.pill,
    borderWidth: 1,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  voidModalCopy: {
    color: tokens.colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 20,
  },
  voidReasonInput: {
    minHeight: 92,
    paddingTop: tokens.spacing.md,
    textAlignVertical: 'top',
  },
  voidApprovalGroup: {
    gap: tokens.spacing.sm,
  },
  voidApprovalTitle: {
    color: tokens.colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  voidModalActions: {
    flexDirection: 'row',
    gap: tokens.spacing.sm,
  },
  voidSecondaryAction: {
    flex: 1,
  },
  voidPrimaryAction: {
    flex: 1,
  },
  statusBadge: {
    borderWidth: 1,
    borderRadius: tokens.radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusBadgeReady: {
    backgroundColor: '#EAF8F3',
    borderColor: '#D8F0E6',
  },
  statusBadgeWarn: {
    backgroundColor: '#FFF1E8',
    borderColor: '#FFE0D1',
  },
  statusBadgeDanger: {
    backgroundColor: '#FFE8E4',
    borderColor: '#FFD5CF',
  },
  statusBadgeDispatch: {
    backgroundColor: '#EAF4FF',
    borderColor: '#D2E8FF',
  },
  statusBadgeDelivered: {
    backgroundColor: '#EAF8F3',
    borderColor: '#D8F0E6',
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
  },
  statusTextReady: {
    color: '#17B57C',
  },
  statusTextWarn: {
    color: '#F28B50',
  },
  statusTextDanger: {
    color: '#E8735B',
  },
  statusTextDispatch: {
    color: '#1989D6',
  },
  statusTextDelivered: {
    color: '#17B57C',
  },
});

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type RefObject } from 'react';
import { Feather } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { BootstrapResponse, DeviceIdentity, StoredSession } from '@/src/features/auth/types';
import { canDetachStoxPickOrder, canFilterStoxPartners, canUsePickWorkspace } from '@/src/features/home/rbac';
import { usePickingWorkspace } from '@/src/features/picking/hooks/use-picking-workspace';
import type {
  PickingFilters,
  PickingStatus,
  WmsMobileBasketPickPlan,
  WmsMobileHeldBasket,
  WmsMobilePickBasket,
  WmsMobilePickingPackerOption,
  WmsMobilePickingTask,
} from '@/src/features/picking/types';
import { PrimaryButton } from '@/src/shared/components/primary-button';
import { SurfaceCard } from '@/src/shared/components/surface-card';
import { OrderChangeNotice } from '@/src/features/fulfillment/components/order-change-notice';
import { tokens } from '@/src/shared/theme/tokens';
import {
  StockScopeFilterModal,
} from '@/src/features/stock/components/stock-scope-filter';
import type { StockScopeOption } from '@/src/features/stock/utils/stock-scope';
import { BlockedTaskState, FloatingErrorBanner, SectionLabel, TaskHeader, TaskHeaderIconButton, UtilityPill } from './stox-primitives';
import { useStoxShellOverlay } from './stox-shell';

type PickingTabProps = {
  bootstrap: BootstrapResponse;
  device: DeviceIdentity | null;
  session: StoredSession;
};

type PickingFilterKey = 'tenant' | 'store';
type PickTabKey = 'list' | 'picked' | 'baskets';

const PICK_TABS: Array<{ key: PickTabKey; label: string }> = [
  { key: 'list', label: 'Pick list' },
  { key: 'picked', label: 'Picked' },
  { key: 'baskets', label: 'Baskets' },
];

const PICK_STATUS_FILTERS: Array<{ label: string; value: PickingStatus | null }> = [
  { label: 'All', value: null },
  { label: 'To do', value: 'READY' },
  { label: 'In Progress', value: 'IN_PICKING' },
  { label: 'Partial', value: 'PARTIAL' },
  { label: 'Restocking', value: 'RESTOCKING' },
  { label: 'Issues', value: 'ISSUE' },
];
const DEFAULT_PICK_LIST_PAGE_SIZE = 10;

function isMonitoredPickBasket(basket: WmsMobilePickBasket) {
  return basket.status === 'ASSIGNED'
    || basket.status === 'IN_PICKING'
    || (basket.status === 'FULL_HELD' && !basket.assignedPacker);
}

export function PickingTab({ bootstrap, device, session }: PickingTabProps) {
  if (!canUsePickWorkspace(bootstrap)) {
    return (
      <>
        <TaskHeader title="Pick" />
        <BlockedTaskState copy="This account needs WMS fulfillment write or edit permission and a PICK task assignment in WMS Web." />
      </>
    );
  }

  return <PickingWorkspaceTab bootstrap={bootstrap} device={device} session={session} />;
}

function PickingWorkspaceTab({ bootstrap, device, session }: PickingTabProps) {
  const [activeFilter, setActiveFilter] = useState<PickingFilterKey | null>(null);
  const [activeTab, setActiveTab] = useState<PickTabKey>('list');
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const [selectedPickTaskIds, setSelectedPickTaskIds] = useState<string[]>([]);
  const [claimReviewTaskIds, setClaimReviewTaskIds] = useState<string[]>([]);
  const [activeBatchTaskIds, setActiveBatchTaskIds] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const {
    activeBin,
    activeTask,
    activeTaskId,
    claimTask,
    basketPlans,
    error,
    fetchBasketPlan,
    filters,
    handoffTask,
    isLoading,
    isLoadingMore,
    isRefreshing,
    isSubmitting,
    loadMore,
    picking,
    refreshPicking,
    retryAllocation,
    returnDetachedUnit,
    returnReworkUnit,
    scanBasketBin,
    scanBasketUnit,
    scanBasket,
    scanBin,
    scanUnit,
    startOrderDetachment,
    setActiveBin,
    setActiveTaskId,
    setFilters,
    setStatusFilter,
    assignTasksToBasket,
    statusFilter,
  } = usePickingWorkspace({ bootstrap, device, session });
  const normalizedSearch = searchInput.trim();
  const canFilterPartners = canFilterStoxPartners(bootstrap);

  useEffect(() => {
    setSearchInput(filters.search);
  }, [filters.search]);

  const filterOptions = useMemo(
    () => buildPickingFilterOptions(activeFilter, picking, bootstrap, canFilterPartners),
    [activeFilter, bootstrap, canFilterPartners, picking],
  );
  const activePartnerName = resolveActivePartnerName(picking, bootstrap, filters.tenantId);
  const activeStoreName = resolveActiveStoreName(picking, bootstrap, filters.storeId);
  const taskPool = useMemo(() => {
    if (activeTab === 'picked') {
      return picking?.pickedHistory ?? [];
    }

    if (activeTab === 'list') {
      return picking?.tasks ?? [];
    }

    return [];
  }, [activeTab, picking?.pickedHistory, picking?.tasks]);
  const dateOptions = useMemo(() => buildPickDateOptions(taskPool), [taskPool]);
  const totalPickTasks = picking?.pagination.total ?? 0;
  const filteredTaskPool = useMemo(() => {
    if (!selectedDateKey || activeTab === 'baskets') {
      return taskPool;
    }

    return taskPool.filter((task) => getPickTaskDateKey(task) === selectedDateKey);
  }, [activeTab, selectedDateKey, taskPool]);
  const hiddenTaskCount = Math.max(taskPool.length - filteredTaskPool.length, 0);
  const currentUserEmail = bootstrap.user.email;
  const selectedPickTaskIdSet = useMemo(() => new Set(selectedPickTaskIds), [selectedPickTaskIds]);
  const selectedPickTasks = useMemo(
    () => filteredTaskPool.filter((task) => selectedPickTaskIdSet.has(task.id)),
    [filteredTaskPool, selectedPickTaskIdSet],
  );
  const pickTaskById = useMemo(() => {
    const entries = new Map<string, WmsMobilePickingTask>();

    for (const task of picking?.tasks ?? []) {
      entries.set(task.id, task);
    }

    for (const task of picking?.pickedHistory ?? []) {
      entries.set(task.id, task);
    }

    for (const basket of picking?.heldBaskets ?? []) {
      for (const task of basket.tasks ?? []) {
        entries.set(task.id, task);
      }

      if (basket.task) {
        entries.set(basket.task.id, basket.task);
      }

      for (const order of basket.orders ?? []) {
        const existing = entries.get(order.id);
        if (existing) {
          entries.set(order.id, existing);
        }
      }
    }

    if (activeTask) {
      entries.set(activeTask.id, activeTask);
    }

    return entries;
  }, [activeTask, picking?.heldBaskets, picking?.pickedHistory, picking?.tasks]);
  const activeBatchTasks = useMemo(
    () => activeBatchTaskIds
      .map((taskId) => pickTaskById.get(taskId))
      .filter((task): task is WmsMobilePickingTask => Boolean(task)),
    [activeBatchTaskIds, pickTaskById],
  );
  const activeBasketTasks = useMemo(() => {
    if (!activeTask?.basket?.orders?.length) {
      return [];
    }

    return activeTask.basket.orders
      .map((order) => pickTaskById.get(order.id))
      .filter((task): task is WmsMobilePickingTask => Boolean(task));
  }, [activeTask?.basket?.orders, pickTaskById]);
  const claimReviewTasks = useMemo(
    () => claimReviewTaskIds
      .map((taskId) => pickTaskById.get(taskId))
      .filter((task): task is WmsMobilePickingTask => Boolean(task)),
    [claimReviewTaskIds, pickTaskById],
  );
  const claimReviewBaskets = useMemo(() => {
    const baskets = new Map<string, WmsMobilePickBasket>();

    for (const basket of picking?.availableBaskets ?? []) {
      baskets.set(basket.id, basket);
    }

    for (const basket of picking?.heldBaskets ?? []) {
      baskets.set(basket.id, basket);
    }

    return Array.from(baskets.values());
  }, [picking?.availableBaskets, picking?.heldBaskets]);
  const executionTasks = activeBatchTasks.length > 0
    ? activeBatchTasks
    : activeBasketTasks.length > 1
      ? activeBasketTasks
      : activeTask
        ? [activeTask]
        : [];
  const showClaimReview = executionTasks.length === 0 && claimReviewTasks.length > 0;
  const showQueueChrome = executionTasks.length === 0 && !showClaimReview;

  useEffect(() => {
    setSelectedPickTaskIds([]);
    setClaimReviewTaskIds([]);
    setActiveBatchTaskIds([]);
  }, [activeTab, filters.search, filters.storeId, filters.tenantId, selectedDateKey, statusFilter]);

  useEffect(() => {
    const nextSearch = searchInput.trim();
    const timer = setTimeout(() => {
      setFilters((current) => {
        if (current.search === nextSearch) {
          return current;
        }

        return {
          ...current,
          search: nextSearch,
        };
      });
    }, 320);

    return () => clearTimeout(timer);
  }, [searchInput, setFilters]);

  useEffect(() => {
    if (!normalizedSearch || selectedDateKey === null) {
      return;
    }

    setSelectedDateKey(null);
  }, [normalizedSearch, selectedDateKey]);

  useEffect(() => {
    setActiveBatchTaskIds((current) => current.filter((taskId) => pickTaskById.has(taskId)));
    setClaimReviewTaskIds((current) => current.filter((taskId) => pickTaskById.has(taskId)));
  }, [pickTaskById]);

  useEffect(() => {
    if (executionTasks.length <= 1 || !activeTask) {
      return;
    }

    if (activeTask.status !== 'READY_FOR_PACK' && activeTask.status !== 'PICKED') {
      return;
    }

    const nextOpenTask = executionTasks.find((task) => (
      task.id !== activeTask.id
      && task.status !== 'READY_FOR_PACK'
      && task.status !== 'PICKED'
      && task.status !== 'PACKED'
      && task.status !== 'CANCELED'
    ));

    if (nextOpenTask) {
      const basketId = activeTask.basket?.id ?? nextOpenTask.basket?.id ?? null;
      const activeBinStillPending = Boolean(
        activeBin
        && basketId
        && basketPlans[basketId]?.bins.some((group) => group.bin.id === activeBin.id),
      );

      setActiveTaskId(nextOpenTask.id);
      if (!activeBinStillPending) {
        setActiveBin(null);
      }
    }
  }, [activeBin, activeTask, basketPlans, executionTasks, setActiveBin, setActiveTaskId]);

  useEffect(() => {
    setSelectedPickTaskIds((current) => current.filter((taskId) => {
      const task = filteredTaskPool.find((candidate) => candidate.id === taskId);
      return task ? isPickTaskSelectable(task, currentUserEmail) : false;
    }));
  }, [currentUserEmail, filteredTaskPool]);

  const togglePickTaskSelection = (task: WmsMobilePickingTask) => {
    if (!isPickTaskSelectable(task, currentUserEmail)) {
      return;
    }

    setSelectedPickTaskIds((current) => (
      current.includes(task.id)
        ? current.filter((taskId) => taskId !== task.id)
        : [...current, task.id]
    ));
  };
  const clearPickTaskSelection = useCallback(() => {
    setSelectedPickTaskIds([]);
    setClaimReviewTaskIds([]);
  }, []);

  const openPickClaimReview = useCallback(() => {
    if (selectedPickTaskIds.length === 0) {
      return;
    }

    setClaimReviewTaskIds(selectedPickTaskIds);
  }, [selectedPickTaskIds]);

  const assignSelectedPickTasksToBasket = useCallback(async (basketCode: string) => {
    const taskIds = claimReviewTaskIds.length > 0 ? claimReviewTaskIds : selectedPickTaskIds;
    if (taskIds.length === 0) {
      return false;
    }

    const result = await assignTasksToBasket(taskIds, basketCode);
    if (result) {
      const assignedTaskIds = result.tasks.map((task) => task.id);
      setSelectedPickTaskIds([]);
      setClaimReviewTaskIds([]);
      setActiveBatchTaskIds(assignedTaskIds);
      setActiveTaskId(assignedTaskIds[0] ?? null);
      setActiveBin(null);
    }

    return Boolean(result);
  }, [assignTasksToBasket, claimReviewTaskIds, selectedPickTaskIds, setActiveBin, setActiveTaskId]);

  const openHeldBasket = useCallback((basket: WmsMobileHeldBasket) => {
    const tasks = basket.tasks.length > 0
      ? basket.tasks
      : basket.task
        ? [basket.task]
        : [];
    if (tasks.length === 0) {
      return;
    }

    const nextTask = tasks.find((task) => (
      task.status !== 'READY_FOR_PACK'
      && task.status !== 'PICKED'
      && task.status !== 'PACKED'
      && task.status !== 'CANCELED'
    )) ?? tasks[0];

    setActiveBatchTaskIds(tasks.map((task) => task.id));
    setActiveTaskId(nextTask.id);
    setActiveBin(null);
    void fetchBasketPlan(basket.id);
  }, [fetchBasketPlan, setActiveBin, setActiveTaskId]);

  useEffect(() => {
    if (activeTab === 'baskets') {
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

    if (selectedDateKey !== null) {
      setSelectedDateKey(null);
    }
  }, [activeTab, dateOptions, selectedDateKey]);

  const updateFilter = (value: string | null) => {
    if (activeFilter === 'tenant') {
      setSelectedDateKey(null);
    }

    setFilters((current) => {
      if (activeFilter === 'tenant') {
        return {
          tenantId: value,
          storeId: null,
          search: current.search,
        };
      }

      return {
        ...current,
        storeId: value,
      };
    });
    setActiveFilter(null);
  };

  if (isLoading && !picking) {
    return (
      <SurfaceCard style={styles.loadingCard}>
        <ActivityIndicator color={tokens.colors.panel} />
        <Text style={styles.loadingText}>Loading picks</Text>
      </SurfaceCard>
    );
  }

  return (
    <View style={[styles.workspaceShell, error ? styles.workspaceShellWithError : null]}>
      <FloatingErrorBanner message={error} />

      {showQueueChrome ? (
        <>
          <View style={styles.queueHeader}>
            <TaskHeaderIconButton
              icon="refresh-cw"
              loading={isRefreshing}
              onPress={refreshPicking}
            />
            <Text style={styles.queueHeaderTitle}>Pick Tasks</Text>
            <View style={styles.queueBellButton}>
              <Feather name="bell" size={18} color="#1F1F28" />
            <View style={styles.queueBellDot} />
          </View>
          </View>

          {activeTab !== 'baskets' && dateOptions.length > 0 ? (
            <TaskDateCarousel
              options={dateOptions}
              value={selectedDateKey}
              onChange={setSelectedDateKey}
            />
          ) : null}

          <View style={styles.queueFilterStack}>
            {canFilterPartners ? (
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

            {activeTab === 'list' ? (
              <PickOrderSearchCard
                value={searchInput}
                onChangeText={setSearchInput}
                onClear={() => setSearchInput('')}
              />
            ) : null}
          </View>
        </>
      ) : null}

      {showQueueChrome ? <PickTabSwitcher activeTab={activeTab} onChange={setActiveTab} /> : null}

      {activeTask && executionTasks.length > 0 ? (
        <PickExecutionStack
          activeBin={activeBin}
          activeTask={activeTask}
          currentUserEmail={bootstrap.user.email}
          canDetachOrders={canDetachStoxPickOrder(bootstrap)}
          isSubmitting={isSubmitting}
          tasks={executionTasks}
          onBack={() => {
            setActiveTaskId(null);
            setActiveBin(null);
            setActiveBatchTaskIds([]);
          }}
          onClaim={claimTask}
          onRefresh={refreshPicking}
          onRetryAllocation={retryAllocation}
          onReturnReworkUnit={returnReworkUnit}
          onReturnDetachedUnit={returnDetachedUnit}
          onStartOrderDetachment={startOrderDetachment}
          basketPlan={activeTask.basket ? basketPlans[activeTask.basket.id] ?? null : null}
          onFetchBasketPlan={fetchBasketPlan}
          onHandoff={handoffTask}
          packerOptions={picking?.context.packerOptions ?? []}
          onScanBasketBin={scanBasketBin}
          onScanBasketUnit={scanBasketUnit}
          onScanBasket={scanBasket}
          onScanBin={scanBin}
          onScanUnit={scanUnit}
        />
      ) : showClaimReview ? (
        <PickBatchClaimReviewScreen
          baskets={claimReviewBaskets}
          isSubmitting={isSubmitting}
          tasks={claimReviewTasks}
          onAssignBasket={assignSelectedPickTasksToBasket}
          onBack={() => setClaimReviewTaskIds([])}
        />
      ) : (
        <>
          {activeTab === 'list' ? (
            <>
              <PickStatusFilterRow value={statusFilter} onChange={setStatusFilter} />
              {statusFilter === 'IN_PICKING' ? (
                <HeldBasketTaskList
                  baskets={picking?.heldBaskets ?? []}
                  onSelect={openHeldBasket}
                />
              ) : (
                <>
                  <PickTaskList
                    activeTaskId={activeTaskId}
                    currentUserEmail={currentUserEmail}
                    hiddenCount={hiddenTaskCount}
                    hasMore={Boolean(picking?.pagination.hasMore)}
                    isLoadingMore={isLoadingMore}
                    loadedCount={taskPool.length}
                    onClearDateFilter={() => setSelectedDateKey(null)}
                    pageSize={picking?.pagination.pageSize ?? DEFAULT_PICK_LIST_PAGE_SIZE}
                    searchQuery={normalizedSearch}
                    tasks={filteredTaskPool}
                    total={totalPickTasks}
                    onLoadMore={loadMore}
                    onSelect={setActiveTaskId}
                    onToggleSelection={togglePickTaskSelection}
                    selectedTaskIds={selectedPickTaskIdSet}
                  />
                  <PickSelectionFloatingActions
                    isSubmitting={isSubmitting}
                    selectedCount={selectedPickTasks.length}
                    onClaim={openPickClaimReview}
                    onClear={clearPickTaskSelection}
                  />
                </>
              )}
            </>
          ) : null}

          {activeTab === 'picked' ? (
            <TaskCollectionSection
              activeTaskId={activeTaskId}
              emptyCopy="Picked baskets stay here until they are handed off to a packer."
              emptyTitle="No picked baskets"
              showHeader={false}
              tasks={filteredTaskPool}
              title="Picked"
              trailing={`${filteredTaskPool.length}`}
              onSelect={setActiveTaskId}
            />
          ) : null}

          {activeTab === 'baskets' ? (
            <>
              <SectionLabel
                title="Picking Baskets"
                trailing={`${(picking?.heldBaskets ?? []).filter(isMonitoredPickBasket).length}`}
              />
              <HeldBasketTaskList
                baskets={picking?.heldBaskets ?? []}
                onSelect={openHeldBasket}
              />
              <AvailableBasketSection baskets={picking?.availableBaskets ?? []} />
            </>
          ) : null}
        </>
      )}

      <StockScopeFilterModal
        options={filterOptions}
        title={activeFilter === 'tenant' ? 'Partner' : 'Store'}
        visible={activeFilter !== null}
        onClose={() => setActiveFilter(null)}
        onSelect={updateFilter}
      />
    </View>
  );
}

function PickTaskList({
  activeTaskId,
  currentUserEmail,
  hiddenCount,
  hasMore,
  isLoadingMore,
  loadedCount,
  onClearDateFilter,
  pageSize,
  searchQuery,
  tasks,
  total,
  onLoadMore,
  onSelect,
  onToggleSelection,
  selectedTaskIds,
}: {
  activeTaskId: string | null;
  currentUserEmail: string;
  hiddenCount: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadedCount: number;
  onClearDateFilter: () => void;
  pageSize: number;
  searchQuery: string;
  tasks: WmsMobilePickingTask[];
  total: number;
  onLoadMore: () => void | Promise<void>;
  onSelect: (taskId: string) => void;
  onToggleSelection: (task: WmsMobilePickingTask) => void;
  selectedTaskIds: Set<string>;
}) {
  const remaining = Math.max(total - loadedCount, 0);

  return (
    <>
      <TaskCollectionSection
        activeTaskId={activeTaskId}
        emptyCopy={searchQuery
          ? 'No queued order matches this order ID in the current store and status filters.'
          : hiddenCount > 0
            ? 'Loaded orders are currently hidden by the selected date. Show all loaded dates or choose another day.'
            : 'Confirmed orders will show here after sync.'}
        emptyTitle={searchQuery ? 'No matching order' : hiddenCount > 0 ? 'No tasks on this date' : 'No pick tasks'}
        showHeader={false}
        currentUserEmail={currentUserEmail}
        selectionEnabled
        selectionModeActive={selectedTaskIds.size > 0}
        selectedTaskIds={selectedTaskIds}
        tasks={tasks}
        title="Orders"
        trailing={`${tasks.length}/${total}`}
        onSelect={onSelect}
        onToggleSelection={onToggleSelection}
      />

      {(loadedCount > 0 || hasMore) ? (
        <SurfaceCard style={styles.paginationCard}>
          <View style={styles.paginationTopRow}>
            <View style={styles.paginationIconWrap}>
              <Feather name="layers" size={16} color="#6437F6" />
            </View>
            <View style={styles.paginationCopyWrap}>
              <Text style={styles.paginationTitle}>
                {loadedCount >= total && total > 0
                  ? `All ${total} queued orders are loaded`
                  : `${loadedCount} of ${total} queued orders loaded`}
              </Text>
              <Text style={styles.paginationCopy}>
                {hiddenCount > 0
                  ? `${tasks.length} visible now · ${hiddenCount} hidden by date filter`
                  : `${tasks.length} visible in the current view`}
              </Text>
            </View>
          </View>

          {hiddenCount > 0 ? (
            <Pressable onPress={onClearDateFilter} style={styles.paginationHintButton}>
              <Feather name="calendar" size={14} color="#6437F6" />
              <Text style={styles.paginationHintText}>Show all loaded dates</Text>
            </Pressable>
          ) : null}

          {hasMore ? (
            <PrimaryButton
              label={`Load ${Math.min(pageSize, remaining)} more order${Math.min(pageSize, remaining) === 1 ? '' : 's'}`}
              loading={isLoadingMore}
              onPress={onLoadMore}
              style={styles.paginationButton}
              variant="secondary"
            />
          ) : (
            <View style={styles.paginationDoneRow}>
              <Feather name="check-circle" size={15} color="#2DAA73" />
              <Text style={styles.paginationDoneText}>You have reached the end of the loaded queue.</Text>
            </View>
          )}
        </SurfaceCard>
      ) : null}
    </>
  );
}

function HeldBasketTaskList({
  baskets,
  onSelect,
}: {
  baskets: WmsMobileHeldBasket[];
  onSelect: (basket: WmsMobileHeldBasket) => void;
}) {
  const activeBaskets = baskets.filter(isMonitoredPickBasket);

  if (activeBaskets.length === 0) {
    return (
      <SurfaceCard style={styles.emptyCard}>
        <Text style={styles.emptyTitle}>No active baskets</Text>
        <Text style={styles.emptyCopy}>Claim ready orders into a basket to start picking.</Text>
      </SurfaceCard>
    );
  }

  return (
    <View style={styles.taskList}>
      {activeBaskets.map((basket) => {
        const tasks = basket.tasks.length > 0
          ? basket.tasks
          : basket.task
            ? [basket.task]
            : [];
        const required = tasks.reduce((total, task) => total + task.totals.required, 0);
        const picked = tasks.reduce((total, task) => total + task.totals.picked, 0);
        const nextBin = tasks
          .map((task) => task.nextPick?.unit.currentLocation?.code ?? null)
          .find(Boolean);
        const nextAction = basket.status === 'FULL_HELD'
          ? basket.assignedPacker
            ? `Packer: ${basket.assignedPacker.name}`
            : 'Assign packer'
          : nextBin
            ? `Next bin ${nextBin}`
            : 'Continue picking';

        return (
          <Pressable
            key={basket.id}
            onPress={() => onSelect(basket)}
            style={({ pressed }) => [styles.taskPressable, pressed ? styles.pressed : null]}>
            <SurfaceCard style={styles.heldBasketCard}>
              <View style={styles.heldBasketTopRow}>
                <View style={styles.heldBasketIcon}>
                  <Feather name="shopping-bag" size={16} color="#6437F6" />
                </View>
                <View style={styles.heldBasketCopy}>
                  <Text numberOfLines={1} style={styles.heldBasketTitle}>Basket {basket.barcode}</Text>
                  <Text numberOfLines={1} style={styles.heldBasketMeta}>
                    {tasks.length} order{tasks.length === 1 ? '' : 's'} · {picked}/{required} units
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color="#9C83FF" />
              </View>

              <View style={styles.heldBasketFooter}>
                <StatusBadge status={basket.status} label={basket.statusLabel} />
                <Text numberOfLines={1} style={styles.heldBasketNextBin}>
                  {nextAction}
                </Text>
              </View>
            </SurfaceCard>
          </Pressable>
        );
      })}
    </View>
  );
}

function PickSelectionFloatingActions({
  isSubmitting,
  selectedCount,
  onClaim,
  onClear,
}: {
  isSubmitting: boolean;
  selectedCount: number;
  onClaim: () => void;
  onClear: () => void;
}) {
  const setShellOverlay = useStoxShellOverlay();

  const dock = useMemo(() => (
    <PickSelectionDock
      isSubmitting={isSubmitting}
      selectedCount={selectedCount}
      onClaim={onClaim}
      onClear={onClear}
    />
  ), [isSubmitting, onClaim, onClear, selectedCount]);

  useEffect(() => {
    if (!setShellOverlay) {
      return;
    }

    if (selectedCount === 0) {
      setShellOverlay(null);
      return;
    }

    setShellOverlay(dock);
  }, [dock, selectedCount, setShellOverlay]);

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

  if (selectedCount === 0) {
    return null;
  }

  return dock;
}

function PickSelectionDock({
  isSubmitting,
  selectedCount,
  onClaim,
  onClear,
}: {
  isSubmitting: boolean;
  selectedCount: number;
  onClaim: () => void;
  onClear: () => void;
}) {
  return (
    <View style={styles.selectionFloatingDock}>
      <Pressable onPress={onClear} style={styles.selectionClearFab}>
        <Feather name="x" size={20} color="#6437F6" />
      </Pressable>
      <PrimaryButton
        label={`Claim order · ${selectedCount}`}
        loading={isSubmitting}
        onPress={onClaim}
        style={styles.selectionFloatingAssignButton}
      />
    </View>
  );
}

function PickBatchClaimReviewScreen({
  baskets,
  isSubmitting,
  onAssignBasket,
  onBack,
  tasks,
}: {
  baskets: WmsMobilePickBasket[];
  isSubmitting: boolean;
  onAssignBasket: (basketCode: string) => Promise<boolean>;
  onBack: () => void;
  tasks: WmsMobilePickingTask[];
}) {
  const [basketCode, setBasketCode] = useState('');
  const basketInputRef = useRef<TextInput>(null);
  const submitInFlightRef = useRef(false);
  const totalUnits = tasks.reduce((total, task) => total + task.totals.required, 0);
  const storeCount = new Set(tasks.map((task) => task.store?.id ?? task.store?.name ?? 'UNKNOWN_STORE')).size;
  const partnerCount = new Set(tasks.map((task) => task.store?.tenantId ?? task.store?.tenantName ?? 'UNKNOWN_PARTNER')).size;
  const normalizedBasketCode = basketCode.trim().toUpperCase();
  const matchedBasket = useMemo(
    () => baskets.find((basket) => basket.barcode.trim().toUpperCase() === normalizedBasketCode) ?? null,
    [baskets, normalizedBasketCode],
  );
  const matchedBasketOpenSlots = matchedBasket
    ? Math.max(matchedBasket.maxFulfillmentOrders - matchedBasket.activeFulfillmentOrders, 0)
    : null;
  const exceedsMatchedBasketCapacity = matchedBasketOpenSlots !== null && tasks.length > matchedBasketOpenSlots;

  useEffect(() => {
    const timer = setTimeout(() => basketInputRef.current?.focus(), 150);
    return () => clearTimeout(timer);
  }, []);

  const submitBasketAssignment = useCallback(async () => {
    if (submitInFlightRef.current || isSubmitting) {
      return;
    }

    const code = basketCode.trim();
    if (!code) {
      basketInputRef.current?.focus();
      return;
    }

    if (exceedsMatchedBasketCapacity) {
      basketInputRef.current?.focus();
      return;
    }

    submitInFlightRef.current = true;
    try {
      const ok = await onAssignBasket(code);
      if (ok) {
        setBasketCode('');
      }
    } finally {
      submitInFlightRef.current = false;
    }
  }, [basketCode, isSubmitting, onAssignBasket]);

  return (
    <>
      <View style={styles.executionHeader}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Feather name="chevron-left" size={20} color={tokens.colors.ink} />
        </Pressable>
        <View style={styles.executionTitleGroup}>
          <Text numberOfLines={1} style={styles.executionTitle}>Claim order</Text>
          <Text numberOfLines={1} style={styles.executionMeta}>
            {tasks.length} order{tasks.length === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}
          </Text>
        </View>
        <View style={styles.claimReviewCountBadge}>
          <Text style={styles.claimReviewCountText}>{tasks.length}</Text>
        </View>
      </View>

      <SurfaceCard style={styles.claimReviewCard}>
        <View style={styles.claimReviewStatsRow}>
          <View style={styles.claimReviewStatPill}>
            <Text style={styles.claimReviewStatText}>{partnerCount} partner{partnerCount === 1 ? '' : 's'}</Text>
          </View>
          <View style={styles.claimReviewStatPill}>
            <Text style={styles.claimReviewStatText}>{storeCount} store{storeCount === 1 ? '' : 's'}</Text>
          </View>
          <View style={styles.claimReviewStatPill}>
            <Text style={styles.claimReviewStatText}>{totalUnits} units</Text>
          </View>
        </View>

        <View style={styles.claimReviewList}>
          {tasks.map((task, index) => (
            <View key={task.id} style={styles.claimReviewOrderRow}>
              <Text style={styles.claimReviewOrderIndex}>{index + 1}</Text>
              <View style={styles.claimReviewOrderCopy}>
                <Text numberOfLines={1} style={styles.claimReviewOrderId}>#{task.posOrderId}</Text>
                <Text numberOfLines={1} style={styles.claimReviewOrderMeta}>
                  {[task.store?.tenantName, task.store?.name].filter(Boolean).join(' · ') || 'Store'}
                </Text>
              </View>
              <Text style={styles.claimReviewOrderQty}>{task.totals.required}</Text>
            </View>
          ))}
        </View>
      </SurfaceCard>

      <SurfaceCard style={styles.claimReviewScanCard}>
        {matchedBasket ? (
          <View style={styles.claimReviewBasketMetaRow}>
            <View style={styles.claimReviewStatPill}>
              <Text style={styles.claimReviewStatText}>{matchedBasket.barcode}</Text>
            </View>
            <View style={styles.claimReviewStatPill}>
              <Text style={styles.claimReviewStatText}>
                {matchedBasket.activeFulfillmentOrders}/{matchedBasket.maxFulfillmentOrders} filled
              </Text>
            </View>
            <View style={styles.claimReviewStatPill}>
              <Text style={styles.claimReviewStatText}>
                {matchedBasketOpenSlots} open slot{matchedBasketOpenSlots === 1 ? '' : 's'}
              </Text>
            </View>
          </View>
        ) : null}
        <ScannerInput
          autoSubmit
          inputRef={basketInputRef}
          label="Basket"
          placeholder="Scan basket"
          value={basketCode}
          disabled={isSubmitting}
          onChangeText={setBasketCode}
          onSubmit={submitBasketAssignment}
        />
        {exceedsMatchedBasketCapacity ? (
          <Text style={styles.claimReviewCapacityError}>
            Basket {matchedBasket?.barcode} has only {matchedBasketOpenSlots} open slot{matchedBasketOpenSlots === 1 ? '' : 's'} for {tasks.length} selected order{tasks.length === 1 ? '' : 's'}.
          </Text>
        ) : null}
        <PrimaryButton
          disabled={!basketCode.trim() || exceedsMatchedBasketCapacity}
          label="Claim"
          loading={isSubmitting}
          onPress={submitBasketAssignment}
        />
      </SurfaceCard>
    </>
  );
}

function PickTabSwitcher({
  activeTab,
  onChange,
}: {
  activeTab: PickTabKey;
  onChange: (tab: PickTabKey) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.pickTabs}>
      {PICK_TABS.map((tab) => {
        const active = activeTab === tab.key;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            style={[styles.pickTabButton, active ? styles.pickTabButtonActive : null]}>
            <Text style={[styles.pickTabText, active ? styles.pickTabTextActive : null]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function PickStatusFilterRow({
  value,
  onChange,
}: {
  value: PickingStatus | null;
  onChange: (status: PickingStatus | null) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.statusFilterRow}>
      {PICK_STATUS_FILTERS.map((option) => {
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

function TaskCollectionSection({
  activeTaskId,
  currentUserEmail,
  emptyCopy,
  emptyTitle,
  selectionEnabled = false,
  selectionModeActive = false,
  selectedTaskIds,
  showHeader,
  tasks,
  title,
  trailing,
  onSelect,
  onToggleSelection,
}: {
  activeTaskId: string | null;
  currentUserEmail?: string;
  emptyCopy: string;
  emptyTitle: string;
  selectionEnabled?: boolean;
  selectionModeActive?: boolean;
  selectedTaskIds?: Set<string>;
  showHeader?: boolean;
  tasks: WmsMobilePickingTask[];
  title: string;
  trailing?: string;
  onSelect: (taskId: string) => void;
  onToggleSelection?: (task: WmsMobilePickingTask) => void;
}) {
  return (
    <>
      {showHeader !== false ? <SectionLabel title={title} trailing={trailing} /> : null}

      {tasks.length === 0 ? (
        <SurfaceCard style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>{emptyTitle}</Text>
          <Text style={styles.emptyCopy}>{emptyCopy}</Text>
        </SurfaceCard>
      ) : null}

      <View style={styles.taskList}>
        {tasks.map((task) => {
          const selectable = selectionEnabled && isPickTaskSelectable(task, currentUserEmail ?? '');
          return (
            <PickTaskCard
              key={task.id}
              active={activeTaskId === task.id}
              selectable={selectable}
              selected={Boolean(selectedTaskIds?.has(task.id))}
              selectionEnabled={selectionEnabled}
              task={task}
              onPress={() => {
                if (selectionModeActive) {
                  if (selectable) {
                    onToggleSelection?.(task);
                  }
                  return;
                }

                onSelect(task.id);
              }}
              onToggleSelection={() => onToggleSelection?.(task)}
            />
          );
        })}
      </View>
    </>
  );
}

function AvailableBasketSection({ baskets }: { baskets: WmsMobilePickBasket[] }) {
  const openSlots = baskets.reduce(
    (total, basket) => total + Math.max(basket.maxFulfillmentOrders - basket.activeFulfillmentOrders, 0),
    0,
  );

  return (
    <>
      <SectionLabel title="Open Basket Slots" trailing={`${openSlots}`} />

      {baskets.length === 0 ? (
        <SurfaceCard style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No basket slots open</Text>
          <Text style={styles.emptyCopy}>Finish or hand off active baskets, or register another basket in WMS Warehouses.</Text>
        </SurfaceCard>
      ) : (
        <View style={styles.availableBasketGrid}>
          {baskets.slice(0, 8).map((basket) => {
            const usedOrders = Math.min(basket.activeFulfillmentOrders, basket.maxFulfillmentOrders);
            const openOrderSlots = Math.max(basket.maxFulfillmentOrders - usedOrders, 0);
            const fillPercent = `${Math.max((usedOrders / Math.max(basket.maxFulfillmentOrders, 1)) * 100, 4)}%` as `${number}%`;

            return (
              <SurfaceCard key={basket.id} tone="muted" style={styles.availableBasketCard}>
                <View style={styles.availableBasketTopRow}>
                  <Text numberOfLines={1} style={styles.availableBasketCode}>{basket.barcode}</Text>
                  <Text style={styles.availableBasketSlotText}>{openOrderSlots}</Text>
                </View>
                <Text numberOfLines={1} style={styles.availableBasketMeta}>
                  {basket.warehouse?.code ?? 'Warehouse'} · {usedOrders}/{basket.maxFulfillmentOrders} orders
                </Text>
                <Text numberOfLines={2} style={styles.availableBasketOrders}>
                  {formatBasketOrderSummary(basket.orders)}
                </Text>
                <View style={styles.availableBasketSlotTrack}>
                  <View style={[styles.availableBasketSlotFill, { width: fillPercent }]} />
                </View>
              </SurfaceCard>
            );
          })}
        </View>
      )}
    </>
  );
}

function BasketOrderList({
  basket,
  currentTaskId,
}: {
  basket: WmsMobilePickBasket;
  currentTaskId: string;
}) {
  const orders = basket.orders ?? [];

  if (!orders.length) {
    return null;
  }

  return (
    <View style={styles.basketOrderPanel}>
      <View style={styles.basketOrderHeader}>
        <Text style={styles.basketOrderTitle}>Basket orders</Text>
        <Text style={styles.basketOrderMeta}>
          {orders.length}/{basket.maxFulfillmentOrders}
        </Text>
      </View>
      {orders.map((order) => {
        const active = order.id === currentTaskId;
        return (
          <View key={order.id} style={[styles.basketOrderRow, active ? styles.basketOrderRowActive : null]}>
            <View style={styles.basketOrderDot} />
            <View style={styles.basketOrderCopy}>
              <Text numberOfLines={1} style={styles.basketOrderCode}>
                {order.posOrderId ? `#${order.posOrderId}` : 'Order'}
              </Text>
              <Text numberOfLines={1} style={styles.basketOrderSubcopy}>
                {order.store?.name ?? order.customerName ?? order.statusLabel ?? 'Queued order'}
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

function PickOrderSearchCard({
  value,
  onChangeText,
  onClear,
}: {
  value: string;
  onChangeText: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <SurfaceCard style={styles.searchCard}>
      <View style={styles.searchIconWrap}>
        <Feather name="search" size={15} color="#F55DB8" />
      </View>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="never"
        keyboardType="number-pad"
        onChangeText={onChangeText}
        placeholder="Search order ID"
        placeholderTextColor="#8F8AAB"
        returnKeyType="search"
        style={styles.searchInput}
        value={value}
      />
      {value ? (
        <Pressable
          hitSlop={10}
          onPress={onClear}
          style={({ pressed }) => [styles.searchClearButton, pressed ? styles.pressed : null]}>
          <Feather name="x" size={15} color="#7A719F" />
        </Pressable>
      ) : null}
    </SurfaceCard>
  );
}

function TaskDateCarousel({
  options,
  value,
  onChange,
}: {
  options: Array<{ key: string; month: string; day: string; weekday: string }>;
  value: string | null;
  onChange: (key: string | null) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.dateCarousel}>
      <Pressable
        onPress={() => onChange(null)}
        style={({ pressed }) => [
          styles.dateCard,
          value === null ? styles.dateCardActive : null,
          pressed ? styles.dateCardPressed : null,
          styles.dateCardAll,
        ]}>
        <Text style={[styles.dateCardAllLabel, value === null ? styles.dateCardAllLabelActive : null]}>All</Text>
        <Text style={[styles.dateCardAllMeta, value === null ? styles.dateCardAllMetaActive : null]}>Dates</Text>
      </Pressable>

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

function PickTaskCard({
  active,
  selectable = false,
  selected = false,
  selectionEnabled = false,
  task,
  onPress,
  onToggleSelection,
}: {
  active: boolean;
  selectable?: boolean;
  selected?: boolean;
  selectionEnabled?: boolean;
  task: WmsMobilePickingTask;
  onPress: () => void;
  onToggleSelection?: () => void;
}) {
  const visibleLines = getVisiblePickLines(task.lines);
  const shortageNote = visibleLines.find((line) => line.issueReason)?.issueReason ?? null;
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
          {selectionEnabled ? (
            <Pressable
              onPress={(event) => {
                event.stopPropagation?.();
                if (selectable) {
                  onToggleSelection?.();
                }
              }}
              hitSlop={8}
              style={styles.pickSelectionHitBox}>
              <View
                style={[
                  styles.pickSelectionBox,
                  selected ? styles.pickSelectionBoxSelected : null,
                  !selectable ? styles.pickSelectionBoxDisabled : null,
                ]}>
                {selected ? <Feather name="check" size={15} color="#FFFFFF" /> : null}
              </View>
            </Pressable>
          ) : null}
          <Text numberOfLines={1} style={styles.compactStoreLabel}>
            {task.store?.name ?? 'Store'}
          </Text>
          <View style={styles.compactIconBadge}>
            <Feather name="shopping-bag" size={14} color="#F55DB8" />
          </View>
        </View>

        {task.itemChange ? (
          <View style={[
            styles.compactOrderChangeBadge,
            task.itemChange.requiresAction ? styles.compactOrderChangeBadgeWarning : styles.compactOrderChangeBadgeInfo,
          ]}>
            <Text numberOfLines={2} style={[
              styles.compactOrderChangeText,
              task.itemChange.requiresAction ? styles.compactOrderChangeTextWarning : styles.compactOrderChangeTextInfo,
            ]}>
              {task.itemChange.requiresAction ? 'Order changed · Rework required' : 'Order changed · Automatic revision'} — {task.itemChange.message}
            </Text>
          </View>
        ) : null}

        <Text numberOfLines={1} style={styles.compactOrderTitle}>{task.posOrderId}</Text>

        <Text numberOfLines={2} style={styles.compactSummary}>
          {summary || `${task.totals.required} required unit${task.totals.required === 1 ? '' : 's'}`}
        </Text>

        {shortageNote ? (
          <Text numberOfLines={2} style={styles.compactIssueText}>{shortageNote}</Text>
        ) : null}

        <View style={styles.compactFooterRow}>
          <View style={styles.compactDateMeta}>
            <Feather name="clock" size={13} color="#9C83FF" />
            <Text style={styles.compactDateValue}>
              {formatPickQueueDate(task.orderDateLocal ?? task.orderDate)}
            </Text>
          </View>
          <StatusBadge status={task.status} label={mapPickCardStatus(task.status, task.statusLabel)} />
        </View>
      </SurfaceCard>
    </Pressable>
  );
}

function PickExecutionStack({
  activeBin,
  activeTask,
  basketPlan,
  currentUserEmail,
  canDetachOrders,
  isSubmitting,
  onBack,
  onClaim,
  onFetchBasketPlan,
  onHandoff,
  onRefresh,
  onRetryAllocation,
  onReturnReworkUnit,
  onReturnDetachedUnit,
  onScanBasketBin,
  onScanBasketUnit,
  onScanBasket,
  onScanBin,
  onScanUnit,
  onStartOrderDetachment,
  packerOptions,
  tasks,
}: {
  activeBin: { id: string; code: string; name: string } | null;
  activeTask: WmsMobilePickingTask;
  basketPlan: WmsMobileBasketPickPlan | null;
  currentUserEmail: string;
  canDetachOrders: boolean;
  isSubmitting: boolean;
  onBack: () => void;
  onClaim: (taskId: string) => Promise<void>;
  onFetchBasketPlan: (basketId: string) => Promise<unknown>;
  onHandoff: (taskId: string, packerId: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onRetryAllocation: (taskId: string) => Promise<boolean>;
  onReturnReworkUnit: (basketId: string, orderId: string, code: string) => Promise<boolean>;
  onReturnDetachedUnit: (params: { basketId: string; orderId: string; binCode: string; code: string }) => Promise<boolean>;
  onScanBasketBin: (basketId: string, code: string) => Promise<boolean>;
  onScanBasketUnit: (basketId: string, binId: string, code: string) => Promise<boolean>;
  onScanBasket: (taskId: string, code: string) => Promise<boolean>;
  onScanBin: (taskId: string, code: string) => Promise<boolean>;
  onScanUnit: (taskId: string, code: string) => Promise<boolean>;
  onStartOrderDetachment: (params: {
    basketId: string;
    orderId: string;
    confirmation: string;
    sourceRevision: number;
    reason: string;
  }) => Promise<boolean>;
  packerOptions: WmsMobilePickingPackerOption[];
  tasks: WmsMobilePickingTask[];
}) {
  const required = tasks.reduce((total, task) => total + task.totals.required, 0);
  const picked = tasks.reduce((total, task) => total + task.totals.picked, 0);
  const basket = activeTask.basket ?? tasks.find((task) => task.basket)?.basket ?? null;
  const title = tasks.length > 1
    ? basket
      ? `Basket ${basket.barcode}`
      : `${tasks.length} orders`
    : `#${activeTask.posOrderId}`;
  const useBasketPicking = Boolean(basket) && (
    tasks.length > 1
    || activeTask.assignmentMode === 'BASKET_DEMAND'
  );
  const meta = useBasketPicking
    ? `${picked}/${required} units · ${tasks.length} order${tasks.length === 1 ? '' : 's'}`
    : activeTask.customer.name ?? activeTask.store?.name ?? 'Pick task';

  return (
    <>
      <View style={styles.executionHeader}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Feather name="chevron-left" size={20} color={tokens.colors.ink} />
        </Pressable>
        <View style={styles.executionTitleGroup}>
          <Text numberOfLines={1} style={styles.executionTitle}>{title}</Text>
          <Text numberOfLines={1} style={styles.executionMeta}>{meta}</Text>
        </View>
        <StatusBadge status={activeTask.status} label={mapPickCardStatus(activeTask.status, activeTask.statusLabel)} />
      </View>

      {tasks.filter((task) => Boolean(task.itemChange)).map((task) => (
        <OrderChangeNotice
          key={`change-${task.id}`}
          canDetach={canDetachOrders}
          change={task.itemChange}
          disabled={isSubmitting}
          onStartDetachment={basket && canDetachOrders
            ? (confirmation, reason) => onStartOrderDetachment({
                basketId: basket.id,
                orderId: task.id,
                confirmation,
                sourceRevision: task.sourceRevision,
                reason,
              })
            : undefined}
          onReturnDetachedUnit={basket && task.itemChange?.detachment
            ? (binCode, code) => onReturnDetachedUnit({
                basketId: basket.id,
                orderId: task.id,
                binCode,
                code,
              })
            : undefined}
          onReturnUnit={basket && task.itemChange?.returnUnitsRemaining
            ? (code) => onReturnReworkUnit(basket.id, task.id, code)
            : undefined}
        />
      ))}

      {tasks.filter((task) => task.fulfillmentAdjustment).map((task) => (
        <View key={`adjustment-${task.id}`} style={styles.fulfillmentAdjustmentNotice}>
          <View style={styles.fulfillmentAdjustmentTitleRow}>
            <Feather name="shield" size={16} color="#9A6700" />
            <Text style={styles.fulfillmentAdjustmentTitle}>Supervisor item adjustment</Text>
          </View>
          {task.fulfillmentAdjustment?.items.map((adjustment) => (
            <Text key={adjustment.id} style={styles.fulfillmentAdjustmentText}>
              {adjustment.type === 'SUBSTITUTION'
                ? `${adjustment.sourceProductName} ×${adjustment.quantity} replaced with ${adjustment.substituteProductName ?? 'substitute stock'} ×${adjustment.quantity}`
                : `${adjustment.sourceProductName} ×${adjustment.quantity} bypassed`}
            </Text>
          ))}
          <Text style={styles.fulfillmentAdjustmentMeta}>
            Follow the updated item list below. Original POS requirement: {task.fulfillmentAdjustment?.sourceTotalRequired ?? task.totals.required} · Pick now: {task.totals.required}
          </Text>
        </View>
      ))}

      {useBasketPicking && basket ? (
        <BasketPickExecutionCard
          activeBin={activeBin}
          activeTask={activeTask}
          basket={basket}
          isSubmitting={isSubmitting}
          packerOptions={packerOptions}
          plan={basketPlan}
          onFetchPlan={onFetchBasketPlan}
          onHandoff={onHandoff}
          onScanBin={onScanBasketBin}
          onScanUnit={onScanBasketUnit}
        />
      ) : (
        <PickExecutionCard
          activeBin={activeBin}
          currentUserEmail={currentUserEmail}
          isSubmitting={isSubmitting}
          showHeader={false}
          task={activeTask}
          onBack={onBack}
          onClaim={onClaim}
          onRefresh={onRefresh}
          onRetryAllocation={onRetryAllocation}
          onHandoff={onHandoff}
          packerOptions={packerOptions}
          onScanBasket={onScanBasket}
          onScanBin={onScanBin}
          onScanUnit={onScanUnit}
        />
      )}
    </>
  );
}

function BasketPickExecutionCard({
  activeBin,
  activeTask,
  basket,
  isSubmitting,
  onFetchPlan,
  onHandoff,
  onScanBin,
  onScanUnit,
  packerOptions,
  plan,
}: {
  activeBin: { id: string; code: string; name: string } | null;
  activeTask: WmsMobilePickingTask;
  basket: WmsMobilePickBasket;
  isSubmitting: boolean;
  onFetchPlan: (basketId: string) => Promise<unknown>;
  onHandoff: (taskId: string, packerId: string) => Promise<boolean>;
  onScanBin: (basketId: string, code: string) => Promise<boolean>;
  onScanUnit: (basketId: string, binId: string, code: string) => Promise<boolean>;
  packerOptions: WmsMobilePickingPackerOption[];
  plan: WmsMobileBasketPickPlan | null;
}) {
  const [binCode, setBinCode] = useState('');
  const [unitCode, setUnitCode] = useState('');
  const [handoffVisible, setHandoffVisible] = useState(false);
  const binInputRef = useRef<TextInput>(null);
  const unitInputRef = useRef<TextInput>(null);
  const binSubmitInFlightRef = useRef(false);
  const unitSubmitInFlightRef = useRef(false);
  const currentGroup = activeBin
    ? plan?.bins.find((group) => group.bin.id === activeBin.id) ?? plan?.bins[0] ?? null
    : plan?.bins[0] ?? null;
  const isDemandMode = plan?.mode === 'BASKET_DEMAND' || activeTask.assignmentMode === 'BASKET_DEMAND';
  const activeBinMatches = Boolean(activeBin && currentGroup && activeBin.id === currentGroup.bin.id);
  const hasPendingUnits = Boolean(plan && plan.totalPendingUnits > 0);
  const handoffOptions: StockScopeOption[] = packerOptions.map((packer) => ({
    label: packer.name,
    value: packer.id,
    meta: packer.employeeId ? `${packer.email} · ${packer.employeeId}` : packer.email,
  }));

  useEffect(() => {
    if (!plan) {
      void onFetchPlan(basket.id);
    }
  }, [basket.id, onFetchPlan, plan]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!hasPendingUnits) {
        return;
      }

      if (activeBinMatches) {
        unitInputRef.current?.focus();
      } else {
        binInputRef.current?.focus();
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [activeBinMatches, hasPendingUnits]);

  const submitBin = async () => {
    if (binSubmitInFlightRef.current || isSubmitting) {
      return;
    }

    const code = binCode.trim();
    if (!code) {
      binInputRef.current?.focus();
      return;
    }

    binSubmitInFlightRef.current = true;
    try {
      const ok = await onScanBin(basket.id, code);
      setBinCode('');
      if (ok) {
        setTimeout(() => unitInputRef.current?.focus(), 80);
      } else {
        setTimeout(() => binInputRef.current?.focus(), 80);
      }
    } finally {
      binSubmitInFlightRef.current = false;
    }
  };

  const submitUnit = async () => {
    if (unitSubmitInFlightRef.current || isSubmitting || !activeBin) {
      return;
    }

    const code = unitCode.trim();
    if (!code) {
      unitInputRef.current?.focus();
      return;
    }

    unitSubmitInFlightRef.current = true;
    try {
      await onScanUnit(basket.id, activeBin.id, code);
      setUnitCode('');
      setTimeout(() => unitInputRef.current?.focus(), 80);
    } finally {
      unitSubmitInFlightRef.current = false;
    }
  };
  const scannerTarget = !hasPendingUnits || handoffVisible || !currentGroup
    ? null
    : activeBinMatches
      ? {
          value: unitCode,
          onChangeText: setUnitCode,
          onSubmit: submitUnit,
        }
      : {
          value: binCode,
          onChangeText: setBinCode,
          onSubmit: submitBin,
        };

  return (
    <>
      <HiddenScannerCapture
        enabled={Boolean(scannerTarget)}
        value={scannerTarget?.value ?? ''}
        onChangeText={scannerTarget?.onChangeText ?? noopScannerChange}
        onSubmit={scannerTarget?.onSubmit ?? noopScannerSubmit}
      />

      {isDemandMode && plan ? (
        <DemandPickFloatingCounter
          currentGroup={currentGroup}
          totalPickedUnits={plan.totalPickedUnits}
          totalRequiredUnits={plan.totalRequiredUnits}
          visible={hasPendingUnits}
        />
      ) : null}

      <SurfaceCard style={styles.executionCard}>
        <View style={styles.taskProgressRow}>
          <View>
            <Text style={styles.bigProgress}>
              {plan ? `${plan.totalPickedUnits}/${plan.totalRequiredUnits}` : '...'}
            </Text>
            <Text style={styles.progressLabel}>basket units</Text>
          </View>
          <UtilityPill icon="shopping-bag" label={`${basket.activeFulfillmentOrders} orders`} />
        </View>

        {plan && plan.bins.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.multiPickRail}>
            {plan.bins.slice(0, 8).map((group) => {
              const active = currentGroup?.bin.id === group.bin.id;
              return (
                <View key={group.bin.id} style={[styles.multiPickChip, active ? styles.multiPickChipActive : null]}>
                  <Text numberOfLines={1} style={[styles.multiPickChipTitle, active ? styles.multiPickChipTitleActive : null]}>
                    {group.bin.code}
                  </Text>
                  <Text numberOfLines={1} style={[styles.multiPickChipMeta, active ? styles.multiPickChipMetaActive : null]}>
                    {isDemandMode
                      ? `${group.pendingUnits} left · ${group.requiredUnits} total`
                      : `${group.pendingUnits} units · ${group.orderCount} orders`}
                  </Text>
                </View>
              );
            })}
          </ScrollView>
        ) : null}

        {plan && !hasPendingUnits ? (
          <View style={styles.donePanel}>
            <Feather name="check-circle" size={28} color={tokens.colors.success} />
            <Text style={styles.doneTitle}>Basket picked</Text>
            <Text style={styles.doneCopy}>Basket {basket.barcode} is ready for pack handoff.</Text>
            <PrimaryButton
              disabled={handoffOptions.length === 0}
              label={basket.assignedPacker ? 'Change packer' : 'Assign packer'}
              loading={isSubmitting}
              onPress={() => setHandoffVisible(true)}
              variant="secondary"
            />
          </View>
        ) : null}

        {currentGroup && hasPendingUnits ? (
          <View style={styles.scanPanel}>
            <View style={styles.nextUnitCard}>
              <Text style={styles.scanLabel}>{isDemandMode ? 'Next bin' : 'Bin'}</Text>
              <Text numberOfLines={1} style={styles.nextUnitCode}>{currentGroup.bin.code}</Text>
              <Text numberOfLines={1} style={styles.nextUnitName}>
                {isDemandMode
                  ? `${currentGroup.pendingUnits} left · ${countDemandDisplayItems(currentGroup.units)} item${countDemandDisplayItems(currentGroup.units) === 1 ? '' : 's'}`
                  : `${currentGroup.pendingUnits} unit${currentGroup.pendingUnits === 1 ? '' : 's'} · ${currentGroup.orderCount} order${currentGroup.orderCount === 1 ? '' : 's'}`}
              </Text>
            </View>

            {!activeBinMatches ? (
            <ScannerInput
              autoSubmit
              inputRef={binInputRef}
              label="Bin"
              placeholder={currentGroup.bin.code}
              suppressKeyboard
              value={binCode}
              disabled={isSubmitting}
              onChangeText={setBinCode}
              onSubmit={submitBin}
            />
            ) : (
              <>
                <BasketPendingUnitList isDemandMode={isDemandMode} units={currentGroup.units} />
                <ScannerInput
                  autoSubmit
                  inputRef={unitInputRef}
                  keepFocused
                  scannerOnly
                  label={isDemandMode ? 'Item' : 'Unit'}
                  placeholder={isDemandMode ? 'Scan matching unit' : 'Scan unit'}
                  suppressKeyboard
                  value={unitCode}
                  disabled={isSubmitting}
                  onChangeText={setUnitCode}
                  onSubmit={submitUnit}
                />
              </>
            )}
          </View>
        ) : null}
      </SurfaceCard>

      <StockScopeFilterModal
        options={handoffOptions}
        title="Assign packer"
        visible={handoffVisible}
        onClose={() => setHandoffVisible(false)}
        onSelect={(value) => {
          if (!value) {
            setHandoffVisible(false);
            return;
          }

          void onHandoff(activeTask.id, value).then((ok) => {
            if (ok) {
              setHandoffVisible(false);
            }
          });
        }}
      />
    </>
  );
}

function BasketPendingUnitList({
  isDemandMode,
  units,
}: {
  isDemandMode: boolean;
  units: WmsMobileBasketPickPlan['bins'][number]['units'];
}) {
  if (units.length === 0) {
    return null;
  }

  const totalRemainingUnits = units.reduce((total, unit) => total + Math.max(unit.remainingUnits, 0), 0);
  const groupedDemandUnits = isDemandMode ? summarizeDemandBinUnits(units) : [];

  return (
    <View style={styles.basketUnitQueue}>
      <View style={styles.basketUnitQueueHeader}>
        <Text style={styles.basketUnitQueueTitle}>{isDemandMode ? 'Items' : 'To scan'}</Text>
        <Text style={styles.basketUnitQueueCount}>{totalRemainingUnits}</Text>
      </View>
      <View style={styles.basketUnitList}>
        {isDemandMode
          ? groupedDemandUnits.map((unit) => (
              <View key={unit.key} style={styles.basketUnitRow}>
                <View style={styles.basketUnitCopy}>
                  <Text numberOfLines={1} style={styles.basketUnitCode}>
                    {unit.displayCode}
                  </Text>
                  <Text numberOfLines={1} style={styles.basketUnitName}>
                    {unit.displayLabel}
                  </Text>
                </View>
                <Text numberOfLines={1} style={styles.basketUnitOrder}>
                  {unit.remainingUnits}
                </Text>
              </View>
            ))
          : units.map((unit) => (
              <View key={unit.id} style={styles.basketUnitRow}>
                <View style={styles.basketUnitCopy}>
                  <Text numberOfLines={1} style={styles.basketUnitCode}>
                    {unit.displayCode}
                  </Text>
                  <Text numberOfLines={1} style={styles.basketUnitName}>
                    {unit.displayLabel}
                  </Text>
                </View>
                <Text numberOfLines={1} style={styles.basketUnitOrder}>
                  {unit.order.posOrderId} · {unit.remainingUnits}
                </Text>
              </View>
            ))}
      </View>
    </View>
  );
}

function DemandPickFloatingCounter({
  currentGroup,
  totalPickedUnits,
  totalRequiredUnits,
  visible,
}: {
  currentGroup: WmsMobileBasketPickPlan['bins'][number] | null;
  totalPickedUnits: number;
  totalRequiredUnits: number;
  visible: boolean;
}) {
  const setShellOverlay = useStoxShellOverlay();
  const dock = useMemo(() => {
    if (!visible || !currentGroup) {
      return null;
    }

    return (
      <View style={styles.demandCounterDock}>
        <View style={styles.demandCounterPillPrimary}>
          <Text style={styles.demandCounterLabel}>Bin</Text>
          <Text style={styles.demandCounterValue}>
            {currentGroup.pickedUnits}/{currentGroup.requiredUnits}
          </Text>
        </View>
        <View style={styles.demandCounterPill}>
          <Text style={styles.demandCounterLabelSoft}>Basket</Text>
          <Text style={styles.demandCounterValueSoft}>
            {totalPickedUnits}/{totalRequiredUnits}
          </Text>
        </View>
      </View>
    );
  }, [currentGroup, totalPickedUnits, totalRequiredUnits, visible]);

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

  if (setShellOverlay || !dock) {
    return null;
  }

  return dock;
}

function summarizeDemandBinUnits(units: WmsMobileBasketPickPlan['bins'][number]['units']) {
  const grouped = new Map<string, {
    key: string;
    displayCode: string;
    displayLabel: string;
    remainingUnits: number;
  }>();

  for (const unit of units) {
    const key = `${unit.displayCode}:${unit.displayLabel}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.remainingUnits += unit.remainingUnits;
    } else {
      grouped.set(key, {
        key,
        displayCode: unit.displayCode,
        displayLabel: unit.displayLabel,
        remainingUnits: unit.remainingUnits,
      });
    }
  }

  return Array.from(grouped.values()).sort((left, right) => (
    right.remainingUnits - left.remainingUnits
    || left.displayLabel.localeCompare(right.displayLabel)
  ));
}

function countDemandDisplayItems(units: WmsMobileBasketPickPlan['bins'][number]['units']) {
  return summarizeDemandBinUnits(units).length;
}

function PickExecutionCard({
  activeBin,
  currentUserEmail,
  isSubmitting,
  onHandoff,
  task,
  onBack,
  onClaim,
  packerOptions,
  onRefresh,
  onRetryAllocation,
  onScanBasket,
  onScanBin,
  onScanUnit,
  showHeader = true,
}: {
  activeBin: { id: string; code: string; name: string } | null;
  currentUserEmail: string;
  isSubmitting: boolean;
  onHandoff: (taskId: string, packerId: string) => Promise<boolean>;
  task: WmsMobilePickingTask;
  onBack: () => void;
  onClaim: (taskId: string) => Promise<void>;
  packerOptions: WmsMobilePickingPackerOption[];
  onRefresh: () => Promise<void>;
  onRetryAllocation: (taskId: string) => Promise<boolean>;
  onScanBasket: (taskId: string, code: string) => Promise<boolean>;
  onScanBin: (taskId: string, code: string) => Promise<boolean>;
  onScanUnit: (taskId: string, code: string) => Promise<boolean>;
  showHeader?: boolean;
}) {
  const [basketCode, setBasketCode] = useState('');
  const [binCode, setBinCode] = useState('');
  const [unitCode, setUnitCode] = useState('');
  const basketInputRef = useRef<TextInput>(null);
  const binInputRef = useRef<TextInput>(null);
  const unitInputRef = useRef<TextInput>(null);
  const basketSubmitInFlightRef = useRef(false);
  const binSubmitInFlightRef = useRef(false);
  const unitSubmitInFlightRef = useRef(false);
  const [handoffVisible, setHandoffVisible] = useState(false);
  const nextPick = task.nextPick;
  const claimedByEmail = task.claimedBy?.email?.trim().toLowerCase() ?? null;
  const isClaimedByMe = Boolean(claimedByEmail && claimedByEmail === currentUserEmail.trim().toLowerCase());
  const isClaimedByAnotherPicker = task.status === 'READY' && Boolean(task.claimedBy) && !isClaimedByMe;
  const canClaim = task.status === 'READY' && !task.claimedBy;
  const canScanBasket = task.status === 'READY' && isClaimedByMe && !task.basket;
  const canScan = task.status === 'IN_PICKING';
  const hasBasket = Boolean(task.basket);
  const isBlocked = task.status === 'PARTIAL' || task.status === 'RESTOCKING' || task.status === 'ISSUE';
  const isPicked = task.status === 'READY_FOR_PACK' || task.status === 'PICKED';
  const basketReadyForHandoff = task.basket?.status === 'FULL_HELD' || task.basket?.status === 'PACKING';
  const canHandoff = isPicked && isClaimedByMe && Boolean(task.basket) && basketReadyForHandoff;
  const handoffOptions: StockScopeOption[] = packerOptions.map((packer) => ({
    label: packer.name,
    value: packer.id,
    meta: packer.employeeId ? `${packer.email} · ${packer.employeeId}` : packer.email,
  }));

  useEffect(() => {
    if (!canScanBasket && (!canScan || !nextPick)) {
      return;
    }

    const timer = setTimeout(() => {
      if (canScanBasket || !hasBasket) {
        basketInputRef.current?.focus();
      } else if (activeBin) {
        unitInputRef.current?.focus();
      } else {
        binInputRef.current?.focus();
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [activeBin, canScan, canScanBasket, hasBasket, nextPick]);

  const submitBasket = async () => {
    if (basketSubmitInFlightRef.current || isSubmitting) {
      return;
    }

    const code = basketCode.trim();
    if (!code) {
      basketInputRef.current?.focus();
      return;
    }

    basketSubmitInFlightRef.current = true;
    try {
      const ok = await onScanBasket(task.id, code);
      setBasketCode('');
      if (ok) {
        setTimeout(() => binInputRef.current?.focus(), 80);
      } else {
        setTimeout(() => basketInputRef.current?.focus(), 80);
      }
    } finally {
      basketSubmitInFlightRef.current = false;
    }
  };

  const submitBin = async () => {
    if (binSubmitInFlightRef.current || isSubmitting) {
      return;
    }

    const code = binCode.trim();
    if (!code) {
      binInputRef.current?.focus();
      return;
    }

    binSubmitInFlightRef.current = true;
    try {
      const ok = await onScanBin(task.id, code);
      setBinCode('');
      if (ok) {
        setTimeout(() => unitInputRef.current?.focus(), 80);
      } else {
        setTimeout(() => binInputRef.current?.focus(), 80);
      }
    } finally {
      binSubmitInFlightRef.current = false;
    }
  };

  const submitUnit = async () => {
    if (unitSubmitInFlightRef.current || isSubmitting) {
      return;
    }

    const code = unitCode.trim();
    if (!code) {
      unitInputRef.current?.focus();
      return;
    }

    unitSubmitInFlightRef.current = true;
    try {
      await onScanUnit(task.id, code);
      setUnitCode('');
      setTimeout(() => unitInputRef.current?.focus(), 80);
    } finally {
      unitSubmitInFlightRef.current = false;
    }
  };
  const scannerTarget = handoffVisible
    ? null
    : canScanBasket || (canScan && !task.basket)
      ? {
          value: basketCode,
          onChangeText: setBasketCode,
          onSubmit: submitBasket,
        }
      : canScan && nextPick && task.basket
        ? activeBin
          ? {
              value: unitCode,
              onChangeText: setUnitCode,
              onSubmit: submitUnit,
            }
          : {
              value: binCode,
              onChangeText: setBinCode,
              onSubmit: submitBin,
            }
        : null;

  return (
    <>
      <HiddenScannerCapture
        enabled={Boolean(scannerTarget)}
        value={scannerTarget?.value ?? ''}
        onChangeText={scannerTarget?.onChangeText ?? noopScannerChange}
        onSubmit={scannerTarget?.onSubmit ?? noopScannerSubmit}
      />

      {showHeader ? (
        <View style={styles.executionHeader}>
          <Pressable onPress={onBack} style={styles.backButton}>
            <Feather name="chevron-left" size={20} color={tokens.colors.ink} />
          </Pressable>
          <View style={styles.executionTitleGroup}>
            <Text numberOfLines={1} style={styles.executionTitle}>#{task.posOrderId}</Text>
            <Text numberOfLines={1} style={styles.executionMeta}>
              {task.customer.name ?? task.store?.name ?? 'Pick task'}
            </Text>
          </View>
          <StatusBadge status={task.status} label={task.statusLabel} />
        </View>
      ) : null}

      <SurfaceCard style={styles.executionCard}>
        <View style={styles.taskProgressRow}>
          <View>
            <Text style={styles.bigProgress}>{task.totals.picked}/{task.totals.required}</Text>
            <Text style={styles.progressLabel}>units picked</Text>
          </View>
          <UtilityPill icon="package" label={`${task.totals.allocated} reserved`} />
        </View>

        {task.basket ? (
          <View style={styles.basketSummary}>
            <Text style={styles.basketLabel}>Basket {task.basket.barcode}</Text>
            <Text style={styles.historyMeta}>
              {task.basket.statusLabel}
              {` · ${task.basket.activeFulfillmentOrders}/${task.basket.maxFulfillmentOrders} orders`}
              {task.basket.fullAt ? ` · full ${formatPickOrderDate(task.basket.fullAt)}` : ''}
            </Text>
          </View>
        ) : null}

        {task.basket ? (
          <BasketOrderList basket={task.basket} currentTaskId={task.id} />
        ) : null}

        {canClaim ? (
          <PrimaryButton
            label="Claim order"
            loading={isSubmitting}
            onPress={() => onClaim(task.id)}
          />
        ) : null}

        {canScanBasket ? (
          <View style={styles.scanPanel}>
            <ScannerInput
              autoSubmit
              inputRef={basketInputRef}
              scannerOnly
              label="Basket"
              placeholder="Scan basket barcode"
              suppressKeyboard
              value={basketCode}
              disabled={isSubmitting}
              onChangeText={setBasketCode}
              onSubmit={submitBasket}
            />
          </View>
        ) : null}

        {isClaimedByAnotherPicker ? (
          <View style={styles.blockedPanel}>
            <Text style={styles.blockedTitle}>Claimed</Text>
            <Text style={styles.blockedCopy}>
              This order is already claimed by {task.claimedBy?.name ?? task.claimedBy?.email ?? 'another picker'}.
            </Text>
            <PrimaryButton label="Resync" onPress={onRefresh} variant="secondary" />
          </View>
        ) : null}

        {isBlocked ? (
          <View style={styles.blockedPanel}>
            <Text style={styles.blockedTitle}>
              {task.status === 'RESTOCKING' ? 'Needs stock' : task.statusLabel}
            </Text>
            <Text style={styles.blockedCopy}>
              {task.issueReason ?? 'This order is not ready because one or more products are short.'}
            </Text>
            <View style={styles.blockedActions}>
              <PrimaryButton
                label="Retry allocation"
                loading={isSubmitting}
                onPress={async () => {
                  await onRetryAllocation(task.id);
                }}
              />
              <PrimaryButton label="Refresh" onPress={onRefresh} variant="secondary" />
            </View>
          </View>
        ) : null}

        {isPicked ? (
          <View style={styles.donePanel}>
            <Feather name="check-circle" size={28} color={tokens.colors.success} />
            <Text style={styles.doneTitle}>{task.status === 'READY_FOR_PACK' ? 'Ready for Pack' : 'Picked'}</Text>
            {task.basket ? (
              <Text style={styles.doneCopy}>
                {basketReadyForHandoff
                  ? `Basket ${task.basket.barcode} is now held for pack handoff.`
                  : `Basket ${task.basket.barcode} is still collecting orders (${task.basket.activeFulfillmentOrders}/${task.basket.maxFulfillmentOrders}).`}
              </Text>
            ) : null}
            {task.basket?.assignedPacker ? (
              <Text style={styles.doneCopy}>
                Assigned to {task.basket.assignedPacker.name} for packing.
              </Text>
            ) : (
              <Text style={styles.doneCopy}>
                Assign a packer to complete the handoff from picking.
              </Text>
            )}
            {canHandoff ? (
              <PrimaryButton
                disabled={handoffOptions.length === 0}
                label={task.basket?.assignedPacker ? 'Change packer' : 'Assign packer'}
                loading={isSubmitting}
                onPress={() => setHandoffVisible(true)}
                variant="secondary"
              />
            ) : null}
            {canHandoff && handoffOptions.length === 0 ? (
              <Text style={styles.handoffHint}>No active WMS packers with packing permission are available.</Text>
            ) : null}
          </View>
        ) : null}

        {canScan && !task.basket ? (
          <View style={styles.scanPanel}>
            <ScannerInput
              autoSubmit
              inputRef={basketInputRef}
              scannerOnly
              label="Basket"
              placeholder="Scan basket barcode"
              suppressKeyboard
              value={basketCode}
              disabled={isSubmitting}
              onChangeText={setBasketCode}
              onSubmit={submitBasket}
            />
          </View>
        ) : null}

        {canScan && nextPick && task.basket ? (
          <View style={styles.scanPanel}>
            <View style={styles.nextUnitCard}>
              <Text style={styles.scanLabel}>Next</Text>
              <Text numberOfLines={1} style={styles.nextUnitCode}>{nextPick.unit.code}</Text>
              <Text numberOfLines={1} style={styles.nextUnitName}>{nextPick.unit.name}</Text>
              <Text numberOfLines={1} style={styles.nextUnitBin}>
                {nextPick.unit.currentLocation?.code ?? 'No bin'}
              </Text>
            </View>

            <ScannerInput
              autoSubmit
              inputRef={binInputRef}
              scannerOnly
              label="Bin"
              placeholder={nextPick.unit.currentLocation?.code ?? 'Scan bin'}
              suppressKeyboard
              value={binCode}
              disabled={isSubmitting}
              onChangeText={setBinCode}
              onSubmit={submitBin}
            />

            <ScannerInput
              autoSubmit
              inputRef={unitInputRef}
              keepFocused
              scannerOnly
              label="Unit"
              placeholder={activeBin ? 'Scan unit' : 'Scan bin first'}
              suppressKeyboard
              value={unitCode}
              disabled={isSubmitting || !activeBin}
              onChangeText={setUnitCode}
              onSubmit={submitUnit}
            />
          </View>
        ) : null}
      </SurfaceCard>

      <SectionLabel title="Items" />
      <View style={styles.itemList}>
        {getVisiblePickLines(task.lines).map((line) => (
          <SurfaceCard key={line.id} tone="muted" style={styles.itemCard}>
            <View style={styles.itemHeader}>
              <Text numberOfLines={1} style={styles.itemName}>{line.productName}</Text>
              <Text style={styles.itemQty}>{line.picked}/{line.required}</Text>
            </View>
            <Text numberOfLines={1} style={styles.itemMeta}>
              {line.shortage > 0 ? `${line.shortage} short` : `${line.allocated} reserved`}
            </Text>
          </SurfaceCard>
        ))}
      </View>

      <StockScopeFilterModal
        options={handoffOptions}
        title="Assign packer"
        visible={handoffVisible}
        onClose={() => setHandoffVisible(false)}
        onSelect={(value) => {
          if (!value) {
            setHandoffVisible(false);
            return;
          }

          void onHandoff(task.id, value).then((ok) => {
            if (ok) {
              setHandoffVisible(false);
            }
          });
        }}
      />
    </>
  );
}

function getVisiblePickLines(lines: WmsMobilePickingTask['lines']) {
  return lines.filter((line) => line.status !== 'CANCELED' && line.required > 0);
}

function isPickTaskSelectable(task: WmsMobilePickingTask, currentUserEmail: string) {
  if (task.status !== 'READY' || task.basket) {
    return false;
  }

  const claimedByEmail = task.claimedBy?.email?.trim().toLowerCase() ?? null;
  if (!claimedByEmail) {
    return true;
  }

  return claimedByEmail === currentUserEmail.trim().toLowerCase();
}

function ScannerInput({
  autoSubmit = false,
  autoSubmitDelayMs = 120,
  autoSubmitMinLength = 3,
  disabled,
  keepFocused = false,
  scannerOnly = false,
  suppressKeyboard = false,
  helper,
  inputRef,
  label,
  placeholder,
  value,
  onChangeText,
  onSubmit,
}: {
  autoSubmit?: boolean;
  autoSubmitDelayMs?: number;
  autoSubmitMinLength?: number;
  disabled?: boolean;
  keepFocused?: boolean;
  scannerOnly?: boolean;
  suppressKeyboard?: boolean;
  helper?: string;
  inputRef: RefObject<TextInput | null>;
  label: string;
  placeholder: string;
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
    if (!keepFocused || disabled || value.trim().length > 0) {
      return;
    }

    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 40);

    return () => clearTimeout(timer);
  }, [disabled, inputRef, keepFocused, value]);

  useEffect(() => {
    const cleaned = value.trim();
    if (!cleaned) {
      lastAutoSubmittedRef.current = null;
      return;
    }

    if (
      !autoSubmit
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
  }, [autoSubmit, autoSubmitDelayMs, autoSubmitMinLength, disabled, value]);

  return (
    <View style={[styles.scanInputWrap, disabled ? styles.scanInputDisabled : null]}>
      <Text style={styles.scanInputLabel}>{label}</Text>
      <View style={styles.scanInputRow}>
        <TextInput
          ref={inputRef}
          autoCapitalize="characters"
          autoCorrect={false}
          blurOnSubmit={false}
          caretHidden={suppressKeyboard}
          contextMenuHidden={suppressKeyboard}
          editable={!disabled && !scannerOnly}
          placeholder={placeholder}
          placeholderTextColor={tokens.colors.inkSoft}
          returnKeyType="done"
          selectTextOnFocus={!suppressKeyboard && !scannerOnly}
          showSoftInputOnFocus={!suppressKeyboard}
          value={value}
          onChangeText={onChangeText}
          onBlur={() => {
            if (!keepFocused || disabled) {
              return;
            }

            setTimeout(() => {
              inputRef.current?.focus();
            }, 40);
          }}
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
  value,
  onChangeText,
  onSubmit,
  autoSubmitDelayMs = 120,
  autoSubmitMinLength = 3,
}: {
  enabled: boolean;
  value: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  autoSubmitDelayMs?: number;
  autoSubmitMinLength?: number;
}) {
  const inputRef = useRef<TextInput>(null);
  const submitRef = useRef(onSubmit);
  const lastAutoSubmittedRef = useRef<string | null>(null);

  useEffect(() => {
    submitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    if (!enabled) {
      lastAutoSubmittedRef.current = null;
      return;
    }

    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 30);

    return () => clearTimeout(timer);
  }, [enabled, value]);

  useEffect(() => {
    if (!enabled) {
      lastAutoSubmittedRef.current = null;
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
  }, [autoSubmitDelayMs, autoSubmitMinLength, enabled, value]);

  return (
    <TextInput
      ref={inputRef}
      autoCapitalize="characters"
      autoCorrect={false}
      blurOnSubmit={false}
      caretHidden
      contextMenuHidden
      onBlur={() => {
        if (!enabled) {
          return;
        }

        setTimeout(() => {
          inputRef.current?.focus();
        }, 30);
      }}
      onChangeText={onChangeText}
      onSubmitEditing={() => {
        void onSubmit();
      }}
      showSoftInputOnFocus={false}
      style={styles.hiddenScannerInput}
      value={value}
    />
  );
}

function noopScannerChange(_value: string) {}

function noopScannerSubmit() {}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone = getStatusTone(status);

  return (
    <View style={[styles.statusBadge, tone === 'ready' && styles.statusReady, tone === 'warn' && styles.statusWarn, tone === 'danger' && styles.statusDanger]}>
      <Text style={[styles.statusText, tone === 'ready' && styles.statusTextReady, tone === 'warn' && styles.statusTextWarn, tone === 'danger' && styles.statusTextDanger]}>
        {label}
      </Text>
    </View>
  );
}

function buildPickingFilterOptions(
  activeFilter: PickingFilterKey | null,
  picking: {
    context: {
      tenantOptions?: Array<{ id: string; name: string; slug: string }>;
      stores: Array<{ id: string; name: string; tenantName?: string | null }>;
    };
  } | null,
  bootstrap: BootstrapResponse,
  canFilterPartners: boolean,
): StockScopeOption[] {
  if (activeFilter === 'tenant' && canFilterPartners) {
    const partners = picking?.context.tenantOptions ?? bootstrap.context.tenantOptions ?? [];
    return [
      { label: 'All partners', value: null },
      ...partners.map((partner) => ({
        label: partner.name,
        value: partner.id,
        meta: partner.slug,
      })),
    ];
  }

  const stores = picking?.context.stores ?? bootstrap.context.stores;
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
  picking: { context: { tenantOptions?: Array<{ id: string; name: string }> } } | null,
  bootstrap: BootstrapResponse,
  tenantId: PickingFilters['tenantId'],
) {
  if (!tenantId) {
    return 'All partners';
  }

  const partners = picking?.context.tenantOptions ?? bootstrap.context.tenantOptions ?? [];
  return partners.find((partner) => partner.id === tenantId)?.name ?? 'Partner';
}

function resolveActiveStoreName(
  picking: { context: { stores: Array<{ id: string; name: string }> } } | null,
  bootstrap: BootstrapResponse,
  storeId: PickingFilters['storeId'],
) {
  if (!storeId) {
    return 'All stores';
  }

  const stores = picking?.context.stores ?? bootstrap.context.stores;
  return stores.find((store) => store.id === storeId)?.name ?? 'Store';
}

function buildPickDateOptions(tasks: WmsMobilePickingTask[]) {
  const seen = new Map<string, { key: string; month: string; day: string; weekday: string; isToday: boolean; sort: number }>();
  const todayKey = buildDateKey(new Date());

  for (const task of tasks) {
    const parsed = parsePickDate(task.orderDateLocal ?? task.orderDate);
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

function getPickTaskDateKey(task: WmsMobilePickingTask) {
  const parsed = parsePickDate(task.orderDateLocal ?? task.orderDate);
  return parsed ? buildDateKey(parsed) : null;
}

function parsePickDate(value: string) {
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

function getStatusTone(status: string) {
  if (status === 'READY' || status === 'AVAILABLE' || status === 'IN_PICKING' || status === 'READY_FOR_PACK' || status === 'PICKED') {
    return 'ready';
  }

  if (status === 'ISSUE' || status === 'DAMAGED' || status === 'RETIRED') {
    return 'danger';
  }

  return 'warn';
}

function formatPickOrderDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'No date';
  }

  return date.toLocaleString('en-PH', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

function formatPickQueueDate(value: string) {
  const parsed = parsePickDate(value);
  if (!parsed) {
    return 'No date';
  }

  return parsed.toLocaleDateString('en-PH', {
    hour: undefined,
    minute: undefined,
    month: 'short',
    day: '2-digit',
  });
}

function formatBasketOrderSummary(orders: WmsMobilePickBasket['orders'] | undefined) {
  const basketOrders = orders ?? [];

  if (!basketOrders.length) {
    return 'Ready for first order';
  }

  const visibleOrders = basketOrders
    .slice(0, 3)
    .map((order) => order.posOrderId ? `#${order.posOrderId}` : 'Order');
  const extraCount = Math.max(basketOrders.length - visibleOrders.length, 0);

  return `${visibleOrders.join(' · ')}${extraCount > 0 ? ` +${extraCount}` : ''}`;
}

function mapPickCardStatus(status: PickingStatus, fallback: string) {
  if (status === 'READY') {
    return 'To do';
  }
  if (status === 'IN_PICKING') {
    return 'In Progress';
  }
  if (status === 'READY_FOR_PACK' || status === 'PICKED') {
    return 'Picked';
  }
  if (status === 'RESTOCKING') {
    return 'Restocking';
  }
  if (status === 'ISSUE') {
    return 'Issues';
  }
  return fallback;
}

const styles = StyleSheet.create({
  fulfillmentAdjustmentNotice: {
    backgroundColor: '#FFF8E1',
    borderColor: '#F2D38A',
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
    padding: 14,
  },
  fulfillmentAdjustmentTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  fulfillmentAdjustmentTitle: {
    color: '#5F4300',
    fontSize: 14,
    fontWeight: '800',
  },
  fulfillmentAdjustmentText: {
    color: '#5F4300',
    fontSize: 13,
    fontWeight: '700',
  },
  fulfillmentAdjustmentMeta: {
    color: '#80651D',
    fontSize: 12,
    lineHeight: 17,
  },
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
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: tokens.spacing.sm,
  },
  pickTabs: {
    gap: 10,
    paddingBottom: 2,
  },
  pickTabButton: {
    alignItems: 'center',
    backgroundColor: '#EEE9FF',
    borderRadius: 16,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  pickTabButtonActive: {
    backgroundColor: '#6437F6',
    shadowColor: '#6437F6',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
  },
  pickTabText: {
    color: '#6F5BCB',
    fontSize: 15,
    fontWeight: '700',
  },
  pickTabTextActive: {
    color: '#FFFFFF',
  },
  statusFilterRow: {
    gap: 10,
    paddingBottom: 4,
  },
  statusFilterChip: {
    alignItems: 'center',
    backgroundColor: '#EEE9FF',
    borderRadius: 14,
    justifyContent: 'center',
    minHeight: 38,
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
  selectionFloatingDock: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    borderColor: '#E8E3FF',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: -4,
    padding: 8,
    shadowColor: '#6B4DFF',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.16,
    shadowRadius: 24,
    elevation: 6,
  },
  selectionFloatingDockEntry: {
    alignSelf: 'stretch',
  },
  selectionClearFab: {
    alignItems: 'center',
    backgroundColor: '#F2EEFF',
    borderRadius: 999,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  selectionBasketInputWrap: {
    backgroundColor: '#F8F5FF',
    borderColor: '#E3DCFF',
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 16,
  },
  selectionBasketInput: {
    color: '#24232D',
    fontSize: 15,
    fontWeight: '800',
    padding: 0,
  },
  selectionFloatingAssignButton: {
    minHeight: 48,
    minWidth: 112,
    paddingHorizontal: 18,
    shadowOpacity: 0,
    elevation: 0,
  },
  claimReviewCountBadge: {
    alignItems: 'center',
    backgroundColor: '#EEE9FF',
    borderRadius: 999,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  claimReviewCountText: {
    color: '#6437F6',
    fontSize: 15,
    fontWeight: '900',
  },
  claimReviewCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
    shadowColor: '#9C83FF',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
  },
  claimReviewStatsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  claimReviewStatPill: {
    backgroundColor: '#F5F2FF',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  claimReviewStatText: {
    color: '#6437F6',
    fontSize: 12,
    fontWeight: '900',
  },
  claimReviewList: {
    gap: 10,
  },
  claimReviewOrderRow: {
    alignItems: 'center',
    backgroundColor: '#FBFAFF',
    borderColor: '#ECE6FF',
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  claimReviewOrderIndex: {
    color: '#9C83FF',
    fontSize: 13,
    fontWeight: '900',
    minWidth: 22,
    textAlign: 'center',
  },
  claimReviewOrderCopy: {
    flex: 1,
    minWidth: 0,
  },
  claimReviewOrderId: {
    color: '#24232D',
    fontSize: 15,
    fontWeight: '900',
  },
  claimReviewOrderMeta: {
    color: '#7B7791',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  claimReviewOrderQty: {
    color: '#6437F6',
    fontSize: 15,
    fontWeight: '900',
    minWidth: 28,
    textAlign: 'right',
  },
  claimReviewScanCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
    shadowColor: '#9C83FF',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
  },
  claimReviewBasketMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  claimReviewCapacityError: {
    color: tokens.colors.danger,
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 18,
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
  searchCard: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: '#A38BFF',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
  },
  searchIconWrap: {
    alignItems: 'center',
    backgroundColor: '#FFE1F2',
    borderRadius: 12,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  searchInput: {
    color: '#24232D',
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    minHeight: 24,
    padding: 0,
  },
  searchClearButton: {
    alignItems: 'center',
    borderRadius: 999,
    height: 28,
    justifyContent: 'center',
    width: 28,
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
  dateCardAll: {
    width: 68,
  },
  dateCardAllLabel: {
    color: '#24232D',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
  },
  dateCardAllLabelActive: {
    color: '#FFFFFF',
  },
  dateCardAllMeta: {
    color: '#6A6680',
    fontSize: 12,
    fontWeight: '600',
  },
  dateCardAllMetaActive: {
    color: '#F4EEFF',
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
  lookupCard: {
    gap: tokens.spacing.md,
  },
  lookupResult: {
    borderColor: tokens.colors.border,
    borderTopWidth: 1,
    gap: tokens.spacing.sm,
    paddingTop: tokens.spacing.md,
  },
  lookupCopy: {
    color: tokens.colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  lookupClear: {
    alignSelf: 'flex-start',
  },
  lookupClearText: {
    color: tokens.colors.panel,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  availableBasketGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  availableBasketCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    flexBasis: '47%',
    flexGrow: 1,
    gap: 7,
    paddingVertical: 18,
    shadowColor: '#9C83FF',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.07,
    shadowRadius: 18,
  },
  availableBasketTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  availableBasketCode: {
    color: '#24232D',
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
  },
  availableBasketSlotText: {
    backgroundColor: '#EAF8F3',
    borderRadius: 999,
    color: '#17B57C',
    fontSize: 11,
    fontWeight: '900',
    minWidth: 26,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
    textAlign: 'center',
  },
  availableBasketMeta: {
    color: '#8F8AAB',
    fontSize: 11,
    fontWeight: '700',
  },
  availableBasketOrders: {
    color: tokens.colors.ink,
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 16,
  },
  availableBasketSlotTrack: {
    backgroundColor: '#F1EFF8',
    borderRadius: 999,
    height: 7,
    overflow: 'hidden',
  },
  availableBasketSlotFill: {
    backgroundColor: '#6437F6',
    borderRadius: 999,
    height: '100%',
  },
  taskList: {
    gap: 18,
  },
  heldBasketCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 18,
    shadowColor: '#A38BFF',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.08,
    shadowRadius: 22,
  },
  heldBasketTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  heldBasketIcon: {
    alignItems: 'center',
    backgroundColor: '#EEE9FF',
    borderRadius: 14,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  heldBasketCopy: {
    flex: 1,
    minWidth: 0,
  },
  heldBasketTitle: {
    color: '#24232D',
    fontSize: 16,
    fontWeight: '900',
  },
  heldBasketMeta: {
    color: '#7B7791',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
  },
  heldBasketFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  heldBasketNextBin: {
    color: '#9C83FF',
    flex: 1,
    fontSize: 12,
    fontWeight: '800',
    marginLeft: 10,
    textAlign: 'right',
  },
  paginationCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    gap: 14,
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 18,
    shadowColor: '#9C83FF',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
  },
  paginationTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  paginationIconWrap: {
    alignItems: 'center',
    backgroundColor: '#EEE9FF',
    borderRadius: 14,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  paginationCopyWrap: {
    flex: 1,
    minWidth: 0,
  },
  paginationTitle: {
    color: '#24232D',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  paginationCopy: {
    color: '#7B7791',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
    marginTop: 2,
  },
  paginationHintButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 8,
  },
  paginationHintText: {
    color: '#6437F6',
    fontSize: 12,
    fontWeight: '800',
  },
  paginationButton: {
    minHeight: 52,
  },
  paginationDoneRow: {
    alignItems: 'center',
    backgroundColor: '#EEF9F3',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 14,
  },
  paginationDoneText: {
    color: '#227E56',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  taskPressable: {},
  activeTaskPressable: {
    opacity: 0.92,
  },
  pressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
  taskCard: {
    gap: tokens.spacing.md,
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
  compactOrderTitle: {
    color: '#24232D',
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  compactIssueText: {
    color: '#E8735B',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
  },
  compactOrderChangeBadge: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  compactOrderChangeBadgeInfo: {
    backgroundColor: '#EEF6FF',
    borderColor: '#BBD8FA',
  },
  compactOrderChangeBadgeWarning: {
    backgroundColor: '#FFF4EF',
    borderColor: '#F2B8A9',
  },
  compactOrderChangeText: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
  },
  compactOrderChangeTextInfo: {
    color: '#175CD3',
  },
  compactOrderChangeTextWarning: {
    color: '#B42318',
  },
  compactTopRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  pickSelectionHitBox: {
    alignItems: 'center',
    height: 48,
    justifyContent: 'center',
    marginRight: 4,
    width: 48,
  },
  pickSelectionBox: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#CFC5FF',
    borderRadius: 9,
    borderWidth: 2,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  pickSelectionBoxSelected: {
    backgroundColor: '#6437F6',
    borderColor: '#6437F6',
  },
  pickSelectionBoxDisabled: {
    backgroundColor: '#F3F1F8',
    borderColor: '#E2DDEC',
    opacity: 0.62,
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
    backgroundColor: '#FFE1F2',
    borderRadius: 12,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  compactSummary: {
    color: '#524F66',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
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
  taskHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: tokens.spacing.md,
    justifyContent: 'space-between',
  },
  taskTitleGroup: {
    flex: 1,
    minWidth: 0,
  },
  taskId: {
    color: tokens.colors.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  taskStore: {
    color: tokens.colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
  },
  taskDate: {
    color: tokens.colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
    marginTop: 3,
  },
  basketLabel: {
    color: tokens.colors.panel,
    fontSize: 16,
    fontWeight: '900',
  },
  basketMeta: {
    color: tokens.colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
  },
  historyMeta: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  taskProgress: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: tokens.spacing.xs,
  },
  progressValue: {
    color: tokens.colors.panel,
    fontSize: 24,
    fontWeight: '900',
  },
  progressLabel: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  linePreview: {
    gap: 4,
  },
  linePreviewText: {
    color: tokens.colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  statusReady: {
    backgroundColor: '#EAF8F3',
  },
  statusWarn: {
    backgroundColor: '#FFF1E8',
  },
  statusDanger: {
    backgroundColor: '#FFE8E4',
  },
  statusText: {
    color: '#6C6882',
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
  executionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.sm,
  },
  backButton: {
    alignItems: 'center',
    backgroundColor: tokens.colors.surface,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.pill,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  executionTitleGroup: {
    flex: 1,
    minWidth: 0,
  },
  executionTitle: {
    color: tokens.colors.ink,
    fontSize: 20,
    fontWeight: '900',
  },
  executionMeta: {
    color: tokens.colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  multiPickRailCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    paddingHorizontal: 12,
    paddingVertical: 12,
    shadowColor: '#9C83FF',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.07,
    shadowRadius: 18,
  },
  multiPickRail: {
    gap: 10,
  },
  multiPickChip: {
    backgroundColor: '#F5F2FF',
    borderColor: '#ECE6FF',
    borderRadius: 16,
    borderWidth: 1,
    minWidth: 118,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  multiPickChipActive: {
    backgroundColor: '#6437F6',
    borderColor: '#6437F6',
  },
  multiPickChipTitle: {
    color: '#24232D',
    fontSize: 13,
    fontWeight: '900',
  },
  multiPickChipTitleActive: {
    color: '#FFFFFF',
  },
  multiPickChipMeta: {
    color: '#7B7791',
    fontSize: 11,
    fontWeight: '800',
    marginTop: 3,
  },
  multiPickChipMetaActive: {
    color: '#F3EEFF',
  },
  demandCounterDock: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    borderColor: '#E6E0FF',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    shadowColor: '#6437F6',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.16,
    shadowRadius: 24,
    elevation: 8,
  },
  demandCounterPillPrimary: {
    backgroundColor: '#6437F6',
    borderRadius: 999,
    gap: 2,
    minWidth: 92,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  demandCounterPill: {
    backgroundColor: '#F5F2FF',
    borderRadius: 999,
    gap: 2,
    minWidth: 92,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  demandCounterLabel: {
    color: '#F3EEFF',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  demandCounterLabelSoft: {
    color: '#7B7791',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  demandCounterValue: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900',
  },
  demandCounterValueSoft: {
    color: '#24232D',
    fontSize: 16,
    fontWeight: '900',
  },
  executionCard: {
    gap: tokens.spacing.lg,
  },
  basketHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.md,
    justifyContent: 'space-between',
  },
  basketSummary: {
    backgroundColor: tokens.colors.surfaceMuted,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    gap: 4,
    padding: tokens.spacing.md,
  },
  basketOrderPanel: {
    backgroundColor: tokens.colors.surfaceMuted,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    gap: tokens.spacing.sm,
    padding: tokens.spacing.md,
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
  basketOrderMeta: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '800',
  },
  basketOrderRow: {
    alignItems: 'center',
    backgroundColor: tokens.colors.surface,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: 10,
  },
  basketOrderRowActive: {
    borderColor: tokens.colors.panel,
  },
  basketOrderDot: {
    backgroundColor: tokens.colors.panel,
    borderRadius: tokens.radius.pill,
    height: 8,
    width: 8,
  },
  basketOrderCopy: {
    flex: 1,
    minWidth: 0,
  },
  basketOrderCode: {
    color: tokens.colors.ink,
    fontSize: 13,
    fontWeight: '900',
  },
  basketOrderSubcopy: {
    color: tokens.colors.inkMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  basketOrderQty: {
    color: tokens.colors.panel,
    fontSize: 12,
    fontWeight: '900',
  },
  taskProgressRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  bigProgress: {
    color: tokens.colors.ink,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1,
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
    fontSize: 18,
    fontWeight: '900',
  },
  blockedCopy: {
    color: tokens.colors.inkMuted,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  blockedActions: {
    gap: tokens.spacing.sm,
  },
  donePanel: {
    alignItems: 'center',
    backgroundColor: 'rgba(15, 157, 122, 0.10)',
    borderRadius: tokens.radius.lg,
    gap: tokens.spacing.sm,
    padding: tokens.spacing.lg,
  },
  doneTitle: {
    color: tokens.colors.success,
    fontSize: 20,
    fontWeight: '900',
  },
  doneCopy: {
    color: tokens.colors.success,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  handoffHint: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  scanPanel: {
    gap: tokens.spacing.md,
  },
  hiddenScannerInput: {
    height: 1,
    left: -9999,
    opacity: 0,
    position: 'absolute',
    top: 0,
    width: 1,
  },
  nextUnitCard: {
    backgroundColor: tokens.colors.panel,
    borderRadius: tokens.radius.lg,
    gap: 4,
    padding: tokens.spacing.md,
  },
  scanLabel: {
    color: tokens.colors.accent,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  nextUnitCode: {
    color: tokens.colors.surface,
    fontSize: 20,
    fontWeight: '900',
  },
  nextUnitName: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    fontWeight: '700',
  },
  basketUnitQueue: {
    backgroundColor: '#FFFFFF',
    borderColor: '#ECE6FF',
    borderRadius: 22,
    borderWidth: 1,
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  basketUnitQueueHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  basketUnitQueueTitle: {
    color: '#24232D',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: -0.2,
  },
  basketUnitQueueCount: {
    backgroundColor: '#F5F2FF',
    borderRadius: 999,
    color: '#6437F6',
    fontSize: 12,
    fontWeight: '900',
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  basketUnitList: {
    gap: 8,
  },
  basketUnitRow: {
    alignItems: 'center',
    backgroundColor: '#FBFAFF',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  basketUnitCopy: {
    flex: 1,
    minWidth: 0,
  },
  basketUnitCode: {
    color: '#24232D',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  basketUnitName: {
    color: '#7B7791',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  basketUnitOrder: {
    color: '#6437F6',
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '900',
    maxWidth: 116,
  },
  nextUnitBin: {
    color: tokens.colors.accent,
    fontSize: 14,
    fontWeight: '900',
    marginTop: 4,
  },
  scanInputWrap: {
    gap: tokens.spacing.xs,
  },
  scanInputDisabled: {
    opacity: 0.62,
  },
  scanInputLabel: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  scanInputRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.sm,
  },
  scanInput: {
    backgroundColor: tokens.colors.surfaceMuted,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    color: tokens.colors.ink,
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    minHeight: 54,
    paddingHorizontal: tokens.spacing.md,
  },
  scanSubmit: {
    alignItems: 'center',
    backgroundColor: tokens.colors.panel,
    borderRadius: tokens.radius.lg,
    height: 54,
    justifyContent: 'center',
    width: 54,
  },
  scanHelper: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  itemList: {
    gap: tokens.spacing.sm,
  },
  itemCard: {
    gap: tokens.spacing.xs,
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
    fontSize: 15,
    fontWeight: '900',
  },
  itemQty: {
    color: tokens.colors.panel,
    fontSize: 16,
    fontWeight: '900',
  },
  itemMeta: {
    color: tokens.colors.inkMuted,
    fontSize: 12,
    fontWeight: '700',
  },
});

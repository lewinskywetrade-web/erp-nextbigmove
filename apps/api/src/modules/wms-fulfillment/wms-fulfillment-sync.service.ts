import { InjectQueue } from '@nestjs/bull';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bull';
import {
  Prisma,
  WmsBasketStatus,
  WmsBasketUnitStatus,
  WmsFulfillmentAdjustmentStatus,
  WmsFulfillmentAmendmentStage,
  WmsFulfillmentAmendmentStatus,
  WmsFulfillmentAssignmentMode,
  WmsFulfillmentChangeState,
  WmsFulfillmentLineStatus,
  WmsFulfillmentOrderStatus,
  WmsInventoryMovementType,
  WmsInventoryUnitStatus,
  WmsLocationKind,
  WmsPickReservationStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { buildUnexpiredInventoryWhere } from '../wms-inventory/wms-inventory-expiration.utils';
import { WmsInventoryCogsService } from '../wms-inventory/wms-inventory-cogs.service';
import {
  finalizeCompleteDemandAllocation,
  normalizeDemandAllocation,
} from './wms-demand-allocation.utils';
import {
  WMS_DEMAND_QUEUE_REFRESH_JOB,
  WMS_DEMAND_QUEUE_REFRESH_QUEUE,
  type WmsDemandQueueRefreshJobData,
} from './wms-fulfillment.constants';
import {
  buildFulfillmentDemandHash,
  diffFulfillmentDemand,
  summarizeFulfillmentDemandDiff,
} from './wms-fulfillment-amendment.utils';
import {
  EMPTY_STOCK_POOL_INDEX,
  loadTenantStockPoolIndex,
  type TenantStockPoolIndex,
} from './wms-stock-pool.util';

type FulfillmentLineDraft = {
  variationId: string;
  productId: string | null;
  productName: string;
  productDisplayId: string | null;
  quantityRequired: number;
  lineSnapshot: Prisma.InputJsonValue;
};

type FulfillmentSyncStore = {
  id: string;
  tenantId: string;
  shopId: string;
};

type FulfillmentAmendmentPlan = {
  stage: WmsFulfillmentAmendmentStage;
  changeState: WmsFulfillmentChangeState;
  summary: Record<string, unknown>;
  requiredActions: {
    pick: Array<{ variationId: string; productName: string; quantity: number }>;
    return: Array<{ variationId: string; productName: string; quantity: number }>;
  };
};

const CONFIRMED_POS_ORDER_STATUS = 1;
const PACKING_POS_ORDER_STATUS = 8;
const WAITING_FOR_PICKUP_POS_ORDER_STATUS = 9;
const WAITING_FOR_PRINTING_POS_ORDER_STATUS = 12;
const PRINTED_POS_ORDER_STATUS = 13;
const AMENDABLE_POST_CONFIRM_POS_ORDER_STATUSES = [
  PACKING_POS_ORDER_STATUS,
  WAITING_FOR_PICKUP_POS_ORDER_STATUS,
  WAITING_FOR_PRINTING_POS_ORDER_STATUS,
  PRINTED_POS_ORDER_STATUS,
] as const;
const CANCELED_POS_ORDER_STATUS = 6;
const SHIPPED_EQUIVALENT_POS_ORDER_STATUSES = [2, 3, 4, 5] as const;
const ACTIVE_PICKING_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.READY,
  WmsFulfillmentOrderStatus.PARTIAL,
  WmsFulfillmentOrderStatus.RESTOCKING,
  WmsFulfillmentOrderStatus.ISSUE,
  WmsFulfillmentOrderStatus.IN_PICKING,
] as const;
const AUTO_POS_CANCELLATION_ISSUE_REASON = 'Order was canceled in POS.';
const TRANSIENT_EMPTY_ITEMS_WEBHOOK_REASON = 'VOID_NO_PRODUCT_ITEMS';
const PICKING_SYNC_ORDER_LIMIT = 80;
const ACTIVE_PICK_RESERVATION_STATUSES = [
  WmsPickReservationStatus.RESERVED,
  WmsPickReservationStatus.PICKED,
] as const;
const ACTIVE_DEMAND_BASKET_STATUSES = [
  WmsBasketStatus.ASSIGNED,
  WmsBasketStatus.IN_PICKING,
  WmsBasketStatus.FULL_HELD,
] as const;
const ACTIVE_BASKET_UNIT_STATUSES = [
  WmsBasketUnitStatus.PICKED,
  WmsBasketUnitStatus.PACKED,
] as const;
const ACTIVE_BASKET_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.READY,
  WmsFulfillmentOrderStatus.PARTIAL,
  WmsFulfillmentOrderStatus.RESTOCKING,
  WmsFulfillmentOrderStatus.ISSUE,
  WmsFulfillmentOrderStatus.IN_PICKING,
  WmsFulfillmentOrderStatus.READY_FOR_PACK,
  WmsFulfillmentOrderStatus.PICKED,
  WmsFulfillmentOrderStatus.PACKING,
] as const;
const SOURCE_REVISION_ELIGIBLE_FULFILLMENT_ORDER_STATUSES = [
  ...ACTIVE_BASKET_ORDER_STATUSES,
  WmsFulfillmentOrderStatus.PACKED,
] as const;
const AUTO_REALLOCATION_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.RESTOCKING,
  WmsFulfillmentOrderStatus.PARTIAL,
] as const;
const DEMAND_QUEUE_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.READY,
  WmsFulfillmentOrderStatus.RESTOCKING,
  WmsFulfillmentOrderStatus.PARTIAL,
] as const;
const FINALIZED_FULFILLMENT_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.IN_PICKING,
  WmsFulfillmentOrderStatus.READY_FOR_PACK,
  WmsFulfillmentOrderStatus.PICKED,
  WmsFulfillmentOrderStatus.PACKING,
  WmsFulfillmentOrderStatus.PACKED,
  WmsFulfillmentOrderStatus.CANCELED,
] as const;
const PUTAWAY_REALLOCATION_ORDER_LIMIT = 80;
const MANUAL_REALLOCATION_ORDER_LIMIT = 200;
const FULFILLABLE_UNIT_STATUSES = [
  WmsInventoryUnitStatus.PUTAWAY,
] as const;

type DemandFulfillmentReadinessRecord = Prisma.WmsFulfillmentOrderGetPayload<{
  include: {
    posOrder: {
      select: {
        status: true;
        isVoid: true;
        dateLocal: true;
      };
    };
    lines: true;
  };
}>;

@Injectable()
export class WmsFulfillmentSyncService {
  private readonly logger = new Logger(WmsFulfillmentSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wmsInventoryCogsService: WmsInventoryCogsService,
    @InjectQueue(WMS_DEMAND_QUEUE_REFRESH_QUEUE)
    private readonly demandQueueRefreshQueue: Queue<WmsDemandQueueRefreshJobData>,
  ) {}

  private isBasketDemandPickingEnabled() {
    return process.env.WMS_BASKET_DEMAND_PICKING_ENABLED === 'true';
  }

  private getDemandQueueRefreshChunkSize() {
    const configuredSize = Number(process.env.WMS_DEMAND_QUEUE_REFRESH_CHUNK_SIZE ?? 25);
    if (!Number.isFinite(configuredSize) || configuredSize < 1) {
      return 25;
    }

    return Math.floor(configuredSize);
  }

  private getDemandQueueRefreshTransactionOptions() {
    const configuredTimeout = Number(process.env.WMS_DEMAND_QUEUE_REFRESH_TX_TIMEOUT_MS ?? 90000);
    const configuredMaxWait = Number(process.env.WMS_DEMAND_QUEUE_REFRESH_TX_MAX_WAIT_MS ?? 10000);

    return {
      timeout: Number.isFinite(configuredTimeout) && configuredTimeout >= 1000
        ? Math.floor(configuredTimeout)
        : 90000,
      maxWait: Number.isFinite(configuredMaxWait) && configuredMaxWait >= 1000
        ? Math.floor(configuredMaxWait)
        : 10000,
    };
  }

  private getDemandQueueRefreshJobOptions() {
    const transactionTimeout = this.getDemandQueueRefreshTransactionOptions().timeout;

    return {
      attempts: 4,
      backoff: { type: 'exponential' as const, delay: 3000 },
      timeout: Math.max(120000, transactionTimeout * 4),
      removeOnComplete: true,
      removeOnFail: 1000,
    };
  }

  private async enqueueDemandQueueRefresh(data: WmsDemandQueueRefreshJobData) {
    try {
      await this.demandQueueRefreshQueue.add(
        WMS_DEMAND_QUEUE_REFRESH_JOB,
        data,
        {
          ...this.getDemandQueueRefreshJobOptions(),
          jobId: `wms-demand-refresh:${data.tenantId}:${data.storeId}:${data.requestedAt}`,
        },
      );
    } catch (error) {
      this.logger.error(
        `Unable to enqueue WMS demand queue refresh tenant=${data.tenantId} store=${data.storeId}; periodic reconciliation must recover it: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private getDemandPriorityBucket(order: {
    priorityOverrideAt?: Date | null;
    priorityReleasedForOrderId?: string | null;
  }) {
    if (order.priorityOverrideAt) {
      return 0;
    }

    if (order.priorityReleasedForOrderId) {
      return 2;
    }

    return 1;
  }

  private sortDemandQueueOrders<T extends {
    id: string;
    priorityOverrideAt?: Date | null;
    priorityReleasedForOrderId?: string | null;
    posOrder?: {
      dateLocal?: string | null;
    } | null;
  }>(orders: T[]) {
    return [...orders].sort((left, right) => {
      const leftBucket = this.getDemandPriorityBucket(left);
      const rightBucket = this.getDemandPriorityBucket(right);
      if (leftBucket !== rightBucket) {
        return leftBucket - rightBucket;
      }

      if (leftBucket === 0) {
        const leftPriorityAt = left.priorityOverrideAt?.getTime() ?? 0;
        const rightPriorityAt = right.priorityOverrideAt?.getTime() ?? 0;
        if (leftPriorityAt !== rightPriorityAt) {
          return rightPriorityAt - leftPriorityAt;
        }
      }

      const leftDateLocal = left.posOrder?.dateLocal ?? '';
      const rightDateLocal = right.posOrder?.dateLocal ?? '';
      if (leftDateLocal !== rightDateLocal) {
        return leftDateLocal.localeCompare(rightDateLocal);
      }

      return left.id.localeCompare(right.id);
    });
  }

  private resolveNewFulfillmentAssignmentMode() {
    return this.isBasketDemandPickingEnabled()
      ? WmsFulfillmentAssignmentMode.BASKET_DEMAND
      : WmsFulfillmentAssignmentMode.SERIAL_RESERVED;
  }

  async syncConfirmedPickingOrders(params: {
    tenantId: string | null;
    storeId: string | null;
    stores: FulfillmentSyncStore[];
    actorId: string | null;
    limit?: number | null;
    posOrderRefs?: Array<{
      shopId: string;
      posOrderId: string;
    }>;
  }) {
    const scopedStores = params.storeId
      ? params.stores.filter((store) => store.id === params.storeId)
      : params.stores;

    if (scopedStores.length === 0) {
      return { syncedOrders: 0 };
    }

    await this.syncCanceledPickingOrders(params, scopedStores);
    const shippedPickingSync = await this.syncPosShippedPickingOrders(params, scopedStores);

    const refs = Array.from(
      new Map(
        (params.posOrderRefs ?? [])
          .filter((ref) => ref.shopId && ref.posOrderId)
          .map((ref) => [`${ref.shopId}::${ref.posOrderId}`, ref] as const),
      ).values(),
    );
    const storeByTenantShop = new Map(scopedStores.map((store) => [`${store.tenantId}:${store.shopId}`, store]));
    const shopIds = Array.from(new Set(scopedStores.map((store) => store.shopId)));
    const tenantIds = Array.from(new Set(scopedStores.map((store) => store.tenantId)));
    const tenantGoLiveFilters = await this.buildTenantGoLiveOrderFilters(tenantIds);
    const shouldLimit = refs.length === 0 && params.limit !== null;
    const effectiveLimit = shouldLimit
      ? (typeof params.limit === 'number' ? params.limit : PICKING_SYNC_ORDER_LIMIT)
      : null;

    const confirmedOrders = await this.prisma.posOrder.findMany({
      where: {
        isVoid: false,
        shopId: { in: shopIds },
        tenantId: params.tenantId ? params.tenantId : { in: tenantIds },
        AND: [
          {
            OR: tenantGoLiveFilters,
          },
          ...(refs.length > 0
            ? [{
                OR: refs.map((ref) => ({
                  shopId: ref.shopId,
                  posOrderId: ref.posOrderId,
                })),
              }]
            : []),
          {
            OR: [
              { status: CONFIRMED_POS_ORDER_STATUS },
              {
                status: {
                  in: [...AMENDABLE_POST_CONFIRM_POS_ORDER_STATUSES],
                },
                wmsFulfillmentOrders: {
                  some: {
                    status: {
                      in: [...SOURCE_REVISION_ELIGIBLE_FULFILLMENT_ORDER_STATUSES],
                    },
                  },
                },
              },
            ],
          },
        ],
        // Targeted webhook updates reconcile all eligible orders including PACKED.
        // Broad/background syncs also include active in-flight Pick/Pack orders so
        // missed webhooks still trigger automatic POS revisions immediately.
        ...(refs.length > 0
          ? {}
          : {
              OR: [
                {
                  wmsFulfillmentOrders: {
                    none: {
                      status: {
                        in: [...FINALIZED_FULFILLMENT_ORDER_STATUSES],
                      },
                    },
                  },
                },
                {
                  wmsFulfillmentOrders: {
                    some: {
                      status: {
                        in: [
                          WmsFulfillmentOrderStatus.IN_PICKING,
                          WmsFulfillmentOrderStatus.READY_FOR_PACK,
                          WmsFulfillmentOrderStatus.PICKED,
                          WmsFulfillmentOrderStatus.PACKING,
                        ],
                      },
                    },
                  },
                },
                {
                  // Include automatically canceled pre-pick orders so the
                  // broad queue resync can repair records stranded by a
                  // transient empty-items webhook before this fix deployed.
                  wmsFulfillmentOrders: {
                    some: {
                      status: WmsFulfillmentOrderStatus.CANCELED,
                      pickedQuantity: 0,
                      lines: {
                        some: {
                          issueReason: AUTO_POS_CANCELLATION_ISSUE_REASON,
                        },
                      },
                    },
                  },
                },
              ],
            }),
      },
      select: {
        id: true,
        status: true,
        isVoid: true,
        tenantId: true,
        shopId: true,
        posOrderId: true,
        insertedAt: true,
        customerName: true,
        customerPhone: true,
        orderSnapshot: true,
        itemData: true,
      },
      orderBy: [{ insertedAt: 'asc' }],
      ...(effectiveLimit && effectiveLimit > 0 ? { take: effectiveLimit } : {}),
    });

    if (effectiveLimit && effectiveLimit > 0 && confirmedOrders.length >= effectiveLimit) {
      const seenIds = new Set(confirmedOrders.map((order) => order.id));
      const uncreatedConfirmedOrders = await this.prisma.posOrder.findMany({
        where: {
          isVoid: false,
          status: CONFIRMED_POS_ORDER_STATUS,
          shopId: { in: shopIds },
          tenantId: params.tenantId ? params.tenantId : { in: tenantIds },
          id: { notIn: Array.from(seenIds) },
          AND: [{ OR: tenantGoLiveFilters }],
          wmsFulfillmentOrders: { none: {} },
        },
        select: {
          id: true,
          status: true,
          isVoid: true,
          tenantId: true,
          shopId: true,
          posOrderId: true,
          insertedAt: true,
          customerName: true,
          customerPhone: true,
          orderSnapshot: true,
          itemData: true,
        },
        orderBy: [{ insertedAt: 'asc' }],
        take: effectiveLimit,
      });
      confirmedOrders.push(...uncreatedConfirmedOrders);
    }

    let syncedOrders = 0;
    const demandQueueScopeKeys = new Set<string>();

    for (const posOrder of confirmedOrders) {
      const store = storeByTenantShop.get(`${posOrder.tenantId}:${posOrder.shopId}`);
      if (!store) {
        continue;
      }

      const lines = await this.extractFulfillmentLinesFromOrderSnapshot(
        posOrder.orderSnapshot,
        store.id,
        posOrder.itemData,
      );
      const emptyOrderIssueReason = lines.length === 0
        ? this.resolveEmptyFulfillmentIssueReason(posOrder.orderSnapshot, posOrder.itemData)
        : null;
      const sourceItemsHash = buildFulfillmentDemandHash(lines);
      const posWarehouseRef = this.extractPosWarehouseRef(posOrder.orderSnapshot);
      const assignmentMode = this.resolveNewFulfillmentAssignmentMode();
      const warehouseId = assignmentMode === WmsFulfillmentAssignmentMode.SERIAL_RESERVED
        ? await this.resolveFulfillmentWarehouseId({
            tenantId: posOrder.tenantId,
            storeId: store.id,
            posWarehouseRef,
          })
        : null;
      const totalQuantity = lines.reduce((sum, line) => sum + line.quantityRequired, 0);

      const fulfillmentOrder = await this.prisma.$transaction(async (tx) => {
        // Serialize all revisions for one POS order before reading its current
        // fulfillment demand. This keeps consecutive webhook retries and rapid
        // edits from calculating a diff against a stale WMS revision.
        await tx.$queryRaw`SELECT "id" FROM "pos_orders" WHERE "id" = ${posOrder.id}::uuid FOR UPDATE`;
        const existing = await tx.wmsFulfillmentOrder.findUnique({
          where: { posOrderDbId: posOrder.id },
          include: {
            lines: {
              include: {
                reservations: {
                  where: {
                    status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
                  },
                  include: {
                    inventoryUnit: true,
                  },
                },
              },
            },
            basketPickDemands: {
              include: { bins: true },
            },
            basketUnits: {
              where: {
                status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] },
              },
              include: { inventoryUnit: true },
            },
          },
        });

        if (!existing) {
          // Post-handoff POS states are accepted only to amend an existing
          // WMS order, never to create a new fulfillment.
          if (posOrder.status !== CONFIRMED_POS_ORDER_STATUS) {
            return null;
          }
          return tx.wmsFulfillmentOrder.create({
            data: {
              tenantId: posOrder.tenantId,
              storeId: store.id,
              posOrderDbId: posOrder.id,
              shopId: posOrder.shopId,
              posOrderId: posOrder.posOrderId,
              posWarehouseRef,
              warehouseId,
              customerName: posOrder.customerName,
              customerPhone: posOrder.customerPhone,
              status: lines.length === 0
                ? WmsFulfillmentOrderStatus.ISSUE
                : WmsFulfillmentOrderStatus.RESTOCKING,
              assignmentMode,
              issueReason: emptyOrderIssueReason,
              sourceTotalQuantity: totalQuantity,
              totalQuantity,
              sourceItemsHash,
              sourceRevision: 1,
              lastSyncedAt: new Date(),
              lines: {
                create: lines.map((line) => ({
                  tenantId: posOrder.tenantId,
                  productId: line.productId,
                  variationId: line.variationId,
                  productName: line.productName,
                  productDisplayId: line.productDisplayId,
                  sourceQuantityRequired: line.quantityRequired,
                  quantityRequired: line.quantityRequired,
                  lineSnapshot: line.lineSnapshot,
                  status: WmsFulfillmentLineStatus.RESTOCKING,
                })),
              },
            },
            select: {
              id: true,
              status: true,
              assignmentMode: true,
            },
          });
        }

        // Scanner transactions lock basket first. Use the same order here to
        // avoid basket/order deadlocks during an automatic revision.
        if (existing.basketId) {
          await tx.$queryRaw`SELECT "id" FROM "wms_baskets" WHERE "id" = ${existing.basketId}::uuid FOR UPDATE`;
        }
        await tx.$queryRaw`SELECT "id" FROM "wms_fulfillment_orders" WHERE "id" = ${existing.id}::uuid FOR UPDATE`;
        const lockedRevision = await tx.wmsFulfillmentOrder.findUniqueOrThrow({
          where: { id: existing.id },
          select: { sourceItemsHash: true, sourceRevision: true },
        });

        const previousDemand = existing.lines
          .filter((line) => line.sourceQuantityRequired > 0)
          .map((line) => ({
            variationId: line.variationId,
            productId: line.productId,
            productName: line.productName,
            productDisplayId: line.productDisplayId,
            quantityRequired: line.sourceQuantityRequired,
          }));
        const demandDiff = diffFulfillmentDemand(previousDemand, lines);
        const hasNewSourceRevision = lockedRevision.sourceItemsHash !== sourceItemsHash;
        const isInitialHashBackfill = !lockedRevision.sourceItemsHash && !demandDiff.hasChanges;
        const shouldRecoverTransientCancellation = await this.canRecoverTransientEmptyItemsCancellationTx(
          tx,
          {
            order: existing,
            posOrder,
            nextLines: lines,
          },
        );
        const shouldRecoverUnbasketedIssueOrder =
          !existing.basketId
          && existing.status === WmsFulfillmentOrderStatus.ISSUE
          && lines.length > 0;
        const shouldMarkUnbasketedEmptyOrderIssue =
          !existing.basketId
          && lines.length === 0
          && (
            existing.status === WmsFulfillmentOrderStatus.READY
            || existing.status === WmsFulfillmentOrderStatus.PARTIAL
            || existing.status === WmsFulfillmentOrderStatus.RESTOCKING
          );

        if ((!hasNewSourceRevision || isInitialHashBackfill) && !shouldRecoverUnbasketedIssueOrder) {
          const shouldClearStaleUnbasketedAmendment =
            !existing.basketId
            && existing.pickedQuantity === 0
            && existing.changeState !== WmsFulfillmentChangeState.NONE;

          if (shouldClearStaleUnbasketedAmendment) {
            await tx.wmsFulfillmentAmendment.updateMany({
              where: {
                fulfillmentOrderId: existing.id,
                status: WmsFulfillmentAmendmentStatus.OPEN,
              },
              data: {
                status: WmsFulfillmentAmendmentStatus.RESOLVED,
                resolvedAt: new Date(),
              },
            });
          }

          if (shouldRecoverTransientCancellation) {
            await tx.wmsFulfillmentLine.updateMany({
              where: {
                fulfillmentOrderId: existing.id,
                quantityRequired: { gt: 0 },
              },
              data: {
                status: WmsFulfillmentLineStatus.RESTOCKING,
                issueReason: null,
              },
            });
          }

          await tx.wmsFulfillmentOrder.update({
            where: { id: existing.id },
            data: {
              sourceItemsHash,
              sourceRevision: Math.max(lockedRevision.sourceRevision, 1),
              ...(shouldClearStaleUnbasketedAmendment
                ? { changeState: WmsFulfillmentChangeState.NONE }
                : {}),
              ...(shouldRecoverTransientCancellation
                ? {
                    status: WmsFulfillmentOrderStatus.RESTOCKING,
                    issueReason: null,
                    allocatedQuantity: 0,
                    pickedQuantity: 0,
                    claimedById: null,
                    claimedAt: null,
                    packedById: null,
                    basketId: null,
                    completedAt: null,
                  }
                : existing.status === WmsFulfillmentOrderStatus.ISSUE
                  ? {
                      issueReason:
                        emptyOrderIssueReason
                        ?? existing.issueReason
                        ?? 'Order has a fulfillment issue — review order line items or resync the pick queue.',
                    }
                  : {}),
              lastSyncedAt: new Date(),
            },
          });

          if (shouldRecoverTransientCancellation) {
            await this.recordTransientCancellationRecoveryTx(tx, {
              order: existing,
              sourceRevision: Math.max(lockedRevision.sourceRevision, 1),
            });
          }

          return shouldRecoverTransientCancellation
            ? { ...existing, status: WmsFulfillmentOrderStatus.RESTOCKING }
            : existing;
        }

        const isInitialEmptyIssueHydration =
          shouldRecoverUnbasketedIssueOrder
          && previousDemand.length === 0
          && lockedRevision.sourceRevision <= 1
          && existing.pickedQuantity === 0
          && !existing.changeDetectedAt;
        const amendment = this.buildFulfillmentAmendmentPlan(existing, demandDiff, lines.length);
        const nextRevision = isInitialEmptyIssueHydration
          ? 1
          : hasNewSourceRevision
            ? lockedRevision.sourceRevision + 1
            : Math.max(lockedRevision.sourceRevision, 1);
        const shouldReopenSerialPickingForRework =
          existing.assignmentMode === WmsFulfillmentAssignmentMode.SERIAL_RESERVED
          && amendment.changeState === WmsFulfillmentChangeState.PICK_REWORK_REQUIRED
          && (
            existing.status === WmsFulfillmentOrderStatus.READY_FOR_PACK
            || existing.status === WmsFulfillmentOrderStatus.PICKED
          );
        const nextSyncedOrderStatus = shouldRecoverTransientCancellation || shouldRecoverUnbasketedIssueOrder
          ? WmsFulfillmentOrderStatus.RESTOCKING
          : shouldMarkUnbasketedEmptyOrderIssue
            ? WmsFulfillmentOrderStatus.ISSUE
            : shouldReopenSerialPickingForRework
              ? WmsFulfillmentOrderStatus.IN_PICKING
              : existing.status;

        await tx.wmsFulfillmentOrder.update({
          where: { id: existing.id },
          data: {
            posWarehouseRef,
            ...(existing.assignmentMode === WmsFulfillmentAssignmentMode.SERIAL_RESERVED
              ? { warehouseId }
              : {}),
            customerName: posOrder.customerName,
            customerPhone: posOrder.customerPhone,
            sourceTotalQuantity: totalQuantity,
            totalQuantity,
            sourceItemsHash,
            sourceRevision: nextRevision,
            changeState: isInitialEmptyIssueHydration
              ? WmsFulfillmentChangeState.NONE
              : amendment.changeState,
            ...(isInitialEmptyIssueHydration
              ? {
                  changeDetectedAt: null,
                  changeSummary: Prisma.DbNull,
                }
              : {
                  changeDetectedAt: new Date(),
                  changeSummary: amendment.summary as Prisma.InputJsonValue,
                }),
            issueReason:
              nextSyncedOrderStatus === WmsFulfillmentOrderStatus.ISSUE
                ? (
                    emptyOrderIssueReason
                    ?? existing.issueReason
                    ?? 'Order has a fulfillment issue — review order line items or resync the pick queue.'
                  )
                : null,
            ...(shouldRecoverTransientCancellation
              ? {
                  status: WmsFulfillmentOrderStatus.RESTOCKING,
                  allocatedQuantity: 0,
                  pickedQuantity: 0,
                  claimedById: null,
                  claimedAt: null,
                  packedById: null,
                  basketId: null,
                  completedAt: null,
                }
              : shouldRecoverUnbasketedIssueOrder
                ? {
                    status: WmsFulfillmentOrderStatus.RESTOCKING,
                  }
                : shouldMarkUnbasketedEmptyOrderIssue
                  ? {
                      status: WmsFulfillmentOrderStatus.ISSUE,
                      allocatedQuantity: 0,
                    }
                  : shouldReopenSerialPickingForRework
                    ? {
                        status: WmsFulfillmentOrderStatus.IN_PICKING,
                        packedById: null,
                        completedAt: null,
                      }
                    : {}),
            lastSyncedAt: new Date(),
          },
        });

        await Promise.all(lines.map((line) => (
          tx.wmsFulfillmentLine.upsert({
            where: {
              fulfillmentOrderId_variationId: {
                fulfillmentOrderId: existing.id,
                variationId: line.variationId,
              },
            },
            create: {
              fulfillmentOrderId: existing.id,
              tenantId: posOrder.tenantId,
              productId: line.productId,
              variationId: line.variationId,
              productName: line.productName,
              productDisplayId: line.productDisplayId,
              sourceQuantityRequired: line.quantityRequired,
              quantityRequired: line.quantityRequired,
              lineSnapshot: line.lineSnapshot,
              status: WmsFulfillmentLineStatus.RESTOCKING,
            },
            update: {
              productId: line.productId,
              productName: line.productName,
              productDisplayId: line.productDisplayId,
              sourceQuantityRequired: line.quantityRequired,
              quantityRequired: line.quantityRequired,
              lineSnapshot: line.lineSnapshot,
              status: WmsFulfillmentLineStatus.RESTOCKING,
              issueReason: null,
            },
          })
        )));

        await this.reconcileLegacyFulfillmentLines(tx, {
          fulfillmentOrderId: existing.id,
          canonicalVariationIds: lines.map((line) => line.variationId),
        });

        await tx.wmsFulfillmentLine.updateMany({
          where: lines.length > 0
            ? {
                fulfillmentOrderId: existing.id,
                variationId: { notIn: lines.map((line) => line.variationId) },
              }
            : { fulfillmentOrderId: existing.id },
          data: {
            status: WmsFulfillmentLineStatus.CANCELED,
            sourceQuantityRequired: 0,
            quantityRequired: 0,
            quantityAllocated: 0,
            issueReason: null,
          },
        });

        await tx.wmsFulfillmentAdjustment.updateMany({
          where: {
            fulfillmentOrderId: existing.id,
            status: WmsFulfillmentAdjustmentStatus.ACTIVE,
          },
          data: {
            status: WmsFulfillmentAdjustmentStatus.SUPERSEDED,
            supersededAt: new Date(),
          },
        });

        await this.releaseSurplusReservedUnitsTx(tx, existing, lines, params.actorId, new Date());

        if (
          existing.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
          && existing.basketId
        ) {
          await this.rebuildActiveBasketDemandTx(tx, {
            order: existing,
            lines,
            amendment,
            now: new Date(),
          });
        }

        if (hasNewSourceRevision && !isInitialEmptyIssueHydration) {
          await tx.wmsFulfillmentAmendment.updateMany({
            where: {
              fulfillmentOrderId: existing.id,
              status: WmsFulfillmentAmendmentStatus.OPEN,
            },
            data: {
              status: WmsFulfillmentAmendmentStatus.SUPERSEDED,
            },
          });
          await tx.wmsFulfillmentAmendment.upsert({
            where: {
              fulfillmentOrderId_sourceHash: {
                fulfillmentOrderId: existing.id,
                sourceHash: sourceItemsHash,
              },
            },
            create: {
              tenantId: existing.tenantId,
              fulfillmentOrderId: existing.id,
              sourceHash: sourceItemsHash,
              previousHash: lockedRevision.sourceItemsHash,
              sourceRevision: nextRevision,
              detectedStage: amendment.stage,
              status: amendment.changeState === WmsFulfillmentChangeState.NONE
                ? WmsFulfillmentAmendmentStatus.RESOLVED
                : WmsFulfillmentAmendmentStatus.OPEN,
              diff: amendment.summary as Prisma.InputJsonValue,
              requiredActions: amendment.requiredActions as Prisma.InputJsonValue,
              resolvedAt: amendment.changeState === WmsFulfillmentChangeState.NONE ? new Date() : null,
            },
            update: {
              sourceRevision: nextRevision,
              detectedStage: amendment.stage,
              status: amendment.changeState === WmsFulfillmentChangeState.NONE
                ? WmsFulfillmentAmendmentStatus.RESOLVED
                : WmsFulfillmentAmendmentStatus.OPEN,
              diff: amendment.summary as Prisma.InputJsonValue,
              requiredActions: amendment.requiredActions as Prisma.InputJsonValue,
              resolvedAt: amendment.changeState === WmsFulfillmentChangeState.NONE ? new Date() : null,
            },
          });
        } else if (!existing.basketId && existing.pickedQuantity === 0 && amendment.changeState === WmsFulfillmentChangeState.NONE) {
          await tx.wmsFulfillmentAmendment.updateMany({
            where: {
              fulfillmentOrderId: existing.id,
              status: WmsFulfillmentAmendmentStatus.OPEN,
            },
            data: {
              status: WmsFulfillmentAmendmentStatus.RESOLVED,
              resolvedAt: new Date(),
            },
          });
        }

        if (shouldRecoverTransientCancellation) {
          await this.recordTransientCancellationRecoveryTx(tx, {
            order: existing,
            sourceRevision: nextRevision,
          });
        }

        return shouldRecoverTransientCancellation || shouldRecoverUnbasketedIssueOrder
          ? { ...existing, status: WmsFulfillmentOrderStatus.RESTOCKING }
          : shouldMarkUnbasketedEmptyOrderIssue
            ? { ...existing, status: WmsFulfillmentOrderStatus.ISSUE }
            : shouldReopenSerialPickingForRework
              ? { ...existing, status: WmsFulfillmentOrderStatus.IN_PICKING }
              : existing;
      });

      if (!fulfillmentOrder) {
        continue;
      }

      syncedOrders += 1;

      if (fulfillmentOrder.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
        if (!(FINALIZED_FULFILLMENT_ORDER_STATUSES as readonly WmsFulfillmentOrderStatus[]).includes(fulfillmentOrder.status)) {
          demandQueueScopeKeys.add(`${posOrder.tenantId}::${store.id}`);
        }
      } else if (
        !(FINALIZED_FULFILLMENT_ORDER_STATUSES as readonly WmsFulfillmentOrderStatus[]).includes(fulfillmentOrder.status)
        || fulfillmentOrder.status === WmsFulfillmentOrderStatus.IN_PICKING
      ) {
        await this.allocateFulfillmentOrder(fulfillmentOrder.id, params.actorId);
      }
    }

    for (const scopeKey of demandQueueScopeKeys) {
      const [tenantId, storeId] = scopeKey.split('::');
      if (!tenantId || !storeId) {
        continue;
      }

      await this.refreshDemandFulfillmentQueue({
        tenantId,
        storeId,
      });
    }

    return { syncedOrders: syncedOrders + shippedPickingSync.syncedOrders };
  }

  private async canRecoverTransientEmptyItemsCancellationTx(
    tx: Prisma.TransactionClient,
    params: {
      order: {
        id: string;
        tenantId: string;
        shopId: string;
        posOrderId: string;
        status: WmsFulfillmentOrderStatus;
        completedAt: Date | null;
        pickedQuantity: number;
      };
      posOrder: {
        status: number | null;
        isVoid: boolean;
      };
      nextLines: FulfillmentLineDraft[];
    },
  ) {
    const { order, posOrder, nextLines } = params;
    if (
      order.status !== WmsFulfillmentOrderStatus.CANCELED
      || (posOrder.status !== CONFIRMED_POS_ORDER_STATUS
        && posOrder.status !== WAITING_FOR_PRINTING_POS_ORDER_STATUS)
      || posOrder.isVoid
      || nextLines.length === 0
      || order.pickedQuantity > 0
      || !order.completedAt
    ) {
      return false;
    }

    const cancellationWindowStart = new Date(order.completedAt.getTime() - 90_000);
    const cancellationWindowEnd = new Date(order.completedAt.getTime() + 90_000);
    const [transientWebhook, pickedReservationCount, basketUnitCount, packingProofCount, outboundRecordCount, manualVoidCount] = await Promise.all([
      tx.pancakeWebhookLogOrder.findFirst({
        where: {
          shopId: order.shopId,
          orderId: order.posOrderId,
          reason: TRANSIENT_EMPTY_ITEMS_WEBHOOK_REASON,
          createdAt: {
            gte: cancellationWindowStart,
            lte: cancellationWindowEnd,
          },
          log: {
            tenantId: order.tenantId,
          },
        },
        select: { id: true },
      }),
      tx.wmsPickReservation.count({
        where: {
          fulfillmentOrderId: order.id,
          OR: [
            { status: WmsPickReservationStatus.PICKED },
            { pickedAt: { not: null } },
          ],
        },
      }),
      tx.wmsBasketUnit.count({
        where: { fulfillmentOrderId: order.id },
      }),
      tx.wmsPackingProof.count({
        where: { fulfillmentOrderId: order.id },
      }),
      tx.wmsOutboundUnitRecord.count({
        where: { fulfillmentOrderId: order.id },
      }),
      tx.wmsStaffActivity.count({
        where: {
          resourceId: order.id,
          actionType: { contains: 'VOID' },
        },
      }),
    ]);

    return Boolean(transientWebhook)
      && pickedReservationCount === 0
      && basketUnitCount === 0
      && packingProofCount === 0
      && outboundRecordCount === 0
      && manualVoidCount === 0;
  }

  private async recordTransientCancellationRecoveryTx(
    tx: Prisma.TransactionClient,
    params: {
      order: {
        id: string;
        tenantId: string;
        storeId: string;
        warehouseId: string | null;
        posOrderId: string;
      };
      sourceRevision: number;
    },
  ) {
    await tx.wmsStaffActivity.create({
      data: {
        tenantId: params.order.tenantId,
        actorId: null,
        actionType: 'FULFILLMENT_AUTO_REOPEN',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: params.order.id,
        storeId: params.order.storeId,
        warehouseId: params.order.warehouseId,
        fromStatus: WmsFulfillmentOrderStatus.CANCELED,
        toStatus: WmsFulfillmentOrderStatus.RESTOCKING,
        reasonCode: 'TRANSIENT_EMPTY_ITEMS_RECOVERED',
        metadata: {
          posOrderId: params.order.posOrderId,
          sourceRevision: params.sourceRevision,
          recoverySource: TRANSIENT_EMPTY_ITEMS_WEBHOOK_REASON,
        },
      },
    });
  }

  async reconcileCanceledPickingOrderRefs(params: {
    actorId: string | null;
    orders: Array<{
      tenantId: string;
      storeId: string;
      shopId: string;
      posOrderId: string;
    }>;
  }) {
    const uniqueOrders = Array.from(
      new Map(
        params.orders
          .filter((order) => (
            order.tenantId
            && order.storeId
            && order.shopId
            && order.posOrderId
          ))
          .map((order) => [
            `${order.tenantId}::${order.storeId}::${order.shopId}::${order.posOrderId}`,
            order,
          ] as const),
      ).values(),
    );

    const ordersByStore = new Map<string, typeof uniqueOrders>();
    for (const order of uniqueOrders) {
      const scopeKey = `${order.tenantId}::${order.storeId}::${order.shopId}`;
      const scopedOrders = ordersByStore.get(scopeKey) ?? [];
      scopedOrders.push(order);
      ordersByStore.set(scopeKey, scopedOrders);
    }

    let cleanedOrders = 0;
    for (const scopedOrders of ordersByStore.values()) {
      const [scope] = scopedOrders;
      const store = {
        id: scope.storeId,
        tenantId: scope.tenantId,
        shopId: scope.shopId,
      };
      const result = await this.syncCanceledPickingOrders({
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        stores: [store],
        actorId: params.actorId,
        posOrderRefs: scopedOrders.map((order) => ({
          shopId: order.shopId,
          posOrderId: order.posOrderId,
        })),
      }, [store]);
      cleanedOrders += result.cleanedOrders;
    }

    return { cleanedOrders };
  }

  async reconcilePosShippedPickingOrderRefs(params: {
    actorId: string | null;
    orders: Array<{
      tenantId: string;
      storeId: string;
      shopId: string;
      posOrderId: string;
    }>;
  }) {
    const uniqueOrders = Array.from(
      new Map(
        params.orders
          .filter((order) => (
            order.tenantId
            && order.storeId
            && order.shopId
            && order.posOrderId
          ))
          .map((order) => [
            `${order.tenantId}::${order.storeId}::${order.shopId}::${order.posOrderId}`,
            order,
          ] as const),
      ).values(),
    );

    const ordersByStore = new Map<string, typeof uniqueOrders>();
    for (const order of uniqueOrders) {
      const scopeKey = `${order.tenantId}::${order.storeId}::${order.shopId}`;
      const scopedOrders = ordersByStore.get(scopeKey) ?? [];
      scopedOrders.push(order);
      ordersByStore.set(scopeKey, scopedOrders);
    }

    let syncedOrders = 0;
    for (const scopedOrders of ordersByStore.values()) {
      const [scope] = scopedOrders;
      const store = {
        id: scope.storeId,
        tenantId: scope.tenantId,
        shopId: scope.shopId,
      };
      const result = await this.syncPosShippedPickingOrders({
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        stores: [store],
        actorId: params.actorId,
        posOrderRefs: scopedOrders.map((order) => ({
          shopId: order.shopId,
          posOrderId: order.posOrderId,
        })),
      }, [store]);
      syncedOrders += result.syncedOrders;
    }

    return { syncedOrders };
  }

  private async syncPosShippedPickingOrders(
    params: {
      tenantId: string | null;
      storeId: string | null;
      stores: FulfillmentSyncStore[];
      actorId: string | null;
      posOrderRefs?: Array<{
        shopId: string;
        posOrderId: string;
      }>;
    },
    scopedStores: FulfillmentSyncStore[],
  ) {
    const refs = Array.from(
      new Map(
        (params.posOrderRefs ?? [])
          .filter((ref) => ref.shopId && ref.posOrderId)
          .map((ref) => [`${ref.shopId}::${ref.posOrderId}`, ref] as const),
      ).values(),
    );
    const storeByTenantShop = new Map(
      scopedStores.map((store) => [`${store.tenantId}:${store.shopId}`, store] as const),
    );
    const shopIds = Array.from(new Set(scopedStores.map((store) => store.shopId)));
    const tenantIds = Array.from(new Set(scopedStores.map((store) => store.tenantId)));
    const tenantGoLiveFilters = await this.buildTenantGoLiveOrderFilters(tenantIds);

    const candidateShippedPosOrders = await this.prisma.posOrder.findMany({
      where: {
        isVoid: false,
        status: {
          in: [...SHIPPED_EQUIVALENT_POS_ORDER_STATUSES],
        },
        shopId: { in: shopIds },
        tenantId: params.tenantId ? params.tenantId : { in: tenantIds },
        AND: [
          ...(tenantGoLiveFilters.length > 0 ? [{ OR: tenantGoLiveFilters }] : []),
          ...(refs.length > 0
            ? [{
                OR: refs.map((ref) => ({
                  shopId: ref.shopId,
                  posOrderId: ref.posOrderId,
                })),
              }]
            : []),
        ],
        wmsFulfillmentOrders: {
          some: {
            status: {
              in: [...ACTIVE_PICKING_ORDER_STATUSES],
            },
          },
        },
      },
      select: {
        id: true,
        tenantId: true,
        shopId: true,
        posOrderId: true,
        status: true,
        isVoid: true,
        tracking: true,
        orderSnapshot: true,
        itemData: true,
      },
    });

    const shippedPosOrders = candidateShippedPosOrders.filter((order) => (
      !order.isVoid
      && SHIPPED_EQUIVALENT_POS_ORDER_STATUSES.includes(
        order.status as (typeof SHIPPED_EQUIVALENT_POS_ORDER_STATUSES)[number],
      )
    ));

    if (shippedPosOrders.length === 0) {
      return { syncedOrders: 0 };
    }

    const hydratedLinesByPosOrderDbId = new Map<string, FulfillmentLineDraft[]>();
    for (const posOrder of shippedPosOrders) {
      const store = storeByTenantShop.get(`${posOrder.tenantId}:${posOrder.shopId}`);
      if (!store) {
        continue;
      }
      const extractedLines = await this.extractFulfillmentLinesFromOrderSnapshot(
        posOrder.orderSnapshot,
        store.id,
        posOrder.itemData,
      );
      if (extractedLines.length > 0) {
        hydratedLinesByPosOrderDbId.set(posOrder.id, extractedLines);
      }
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const fulfillmentOrders = await tx.wmsFulfillmentOrder.findMany({
        where: {
          posOrderDbId: {
            in: shippedPosOrders.map((order) => order.id),
          },
          status: {
            in: [...ACTIVE_PICKING_ORDER_STATUSES],
          },
        },
        include: {
          posOrder: {
            select: {
              id: true,
              status: true,
              isVoid: true,
              tracking: true,
            },
          },
          lines: {
            include: {
              reservations: {
                where: {
                  status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
                },
                include: {
                  inventoryUnit: {
                    select: {
                      id: true,
                      code: true,
                      status: true,
                      warehouseId: true,
                      currentLocationId: true,
                    },
                  },
                },
              },
            },
          },
          basketUnits: {
            where: {
              status: {
                in: [...ACTIVE_BASKET_UNIT_STATUSES],
              },
            },
            select: {
              id: true,
              basketId: true,
              tenantId: true,
              inventoryUnitId: true,
              sourceLocationId: true,
              status: true,
              inventoryUnit: {
                select: {
                  id: true,
                  code: true,
                  status: true,
                },
              },
            },
          },
        },
      });

      const affectedBasketIds = new Set<string>();
      const scopeKeys = new Set<string>();
      let syncedCount = 0;

      for (const candidate of fulfillmentOrders) {
        if (candidate.basketId) {
          await tx.$queryRaw`SELECT "id" FROM "wms_baskets" WHERE "id" = ${candidate.basketId}::uuid FOR UPDATE`;
        }
        await tx.$queryRaw`SELECT "id" FROM "wms_fulfillment_orders" WHERE "id" = ${candidate.id}::uuid FOR UPDATE`;

        const lockedOrder = await tx.wmsFulfillmentOrder.findUnique({
          where: { id: candidate.id },
          select: {
            status: true,
            basketId: true,
            completedAt: true,
            posOrder: {
              select: {
                status: true,
                isVoid: true,
                tracking: true,
              },
            },
          },
        });

        const posStatus = lockedOrder?.posOrder?.status ?? null;
        if (
          !lockedOrder
          || !(ACTIVE_PICKING_ORDER_STATUSES as readonly WmsFulfillmentOrderStatus[]).includes(lockedOrder.status)
          || lockedOrder.posOrder?.isVoid
          || !(SHIPPED_EQUIVALENT_POS_ORDER_STATUSES as readonly number[]).includes(posStatus ?? -1)
        ) {
          continue;
        }

        syncedCount += 1;
        const previousStatus = lockedOrder.status;

        if (candidate.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
          await this.releasePosShippedDemandPickOrderHoldsTx(tx, {
            order: {
              ...candidate,
              basketId: lockedOrder.basketId,
            },
            actorId: params.actorId,
            now,
          });

          if (lockedOrder.basketId) {
            affectedBasketIds.add(lockedOrder.basketId);
          }
          for (const basketUnit of candidate.basketUnits ?? []) {
            if (basketUnit.basketId) {
              affectedBasketIds.add(basketUnit.basketId);
            }
          }
          scopeKeys.add(`${candidate.tenantId}::${candidate.storeId}`);
        } else {
          await this.releasePosShippedReservedPickOrderHoldsTx(tx, {
            order: candidate,
            actorId: params.actorId,
            now,
          });
        }

        const activeLines = candidate.lines.filter(
          (line) => line.status !== WmsFulfillmentLineStatus.CANCELED && line.quantityRequired > 0,
        );
        const hydratedLines = hydratedLinesByPosOrderDbId.get(candidate.posOrderDbId) ?? [];
        let nextTotalQuantity: number | undefined;

        if (activeLines.length === 0 && hydratedLines.length > 0) {
          nextTotalQuantity = hydratedLines.reduce((sum, line) => sum + line.quantityRequired, 0);
          for (const line of hydratedLines) {
            await tx.wmsFulfillmentLine.upsert({
              where: {
                fulfillmentOrderId_variationId: {
                  fulfillmentOrderId: candidate.id,
                  variationId: line.variationId,
                },
              },
              create: {
                fulfillmentOrderId: candidate.id,
                tenantId: candidate.tenantId,
                productId: line.productId,
                variationId: line.variationId,
                productName: line.productName,
                productDisplayId: line.productDisplayId,
                sourceQuantityRequired: line.quantityRequired,
                quantityRequired: line.quantityRequired,
                quantityAllocated: 0,
                quantityPicked: 0,
                lineSnapshot: line.lineSnapshot,
                status: WmsFulfillmentLineStatus.PICKED,
                issueReason: null,
              },
              update: {
                productId: line.productId,
                productName: line.productName,
                productDisplayId: line.productDisplayId,
                sourceQuantityRequired: line.quantityRequired,
                quantityRequired: line.quantityRequired,
                quantityAllocated: 0,
                quantityPicked: 0,
                lineSnapshot: line.lineSnapshot,
                status: WmsFulfillmentLineStatus.PICKED,
                issueReason: null,
              },
            });
          }
        } else {
          await tx.wmsFulfillmentLine.updateMany({
            where: {
              fulfillmentOrderId: candidate.id,
              status: {
                not: WmsFulfillmentLineStatus.CANCELED,
              },
              quantityRequired: {
                gt: 0,
              },
            },
            data: {
              quantityAllocated: 0,
              quantityPicked: 0,
              status: WmsFulfillmentLineStatus.PICKED,
              issueReason: null,
            },
          });
        }

        await tx.wmsFulfillmentAmendment.updateMany({
          where: {
            fulfillmentOrderId: candidate.id,
            status: WmsFulfillmentAmendmentStatus.OPEN,
          },
          data: {
            status: WmsFulfillmentAmendmentStatus.SUPERSEDED,
          },
        });

        await tx.wmsFulfillmentOrder.update({
          where: { id: candidate.id },
          data: {
            status: WmsFulfillmentOrderStatus.PACKED,
            issueReason: null,
            ...(typeof nextTotalQuantity === 'number'
              ? {
                  sourceTotalQuantity: nextTotalQuantity,
                  totalQuantity: nextTotalQuantity,
                }
              : {}),
            allocatedQuantity: 0,
            pickedQuantity: 0,
            claimedById: null,
            claimedAt: null,
            packedById: null,
            basketId: null,
            changeState: WmsFulfillmentChangeState.NONE,
            completedAt: lockedOrder.completedAt ?? now,
            lastSyncedAt: now,
          },
        });

        await tx.wmsStaffActivity.create({
          data: {
            tenantId: candidate.tenantId,
            actorId: params.actorId,
            actionType: posStatus === 3 ? 'ORDER_DELIVERY_SYNC' : 'ORDER_DISPATCH_SYNC',
            resourceType: 'WMS_FULFILLMENT_ORDER',
            resourceId: candidate.id,
            storeId: candidate.storeId,
            warehouseId: candidate.warehouseId,
            fromStatus: previousStatus,
            toStatus: WmsFulfillmentOrderStatus.PACKED,
            reasonCode: 'POS_STATUS_SYNC',
            metadata: {
              mode: 'POS_SYNC',
              posOrderId: candidate.posOrderId,
              posStatus,
              trackingCode: lockedOrder.posOrder?.tracking ?? null,
              previousWmsStatus: previousStatus,
              reason: 'Synced from POS status while order was still in Pick status',
            },
          },
        });
      }

      for (const basketId of affectedBasketIds) {
        await this.refreshDemandBasketStateTx(tx, basketId, now);
      }

      return {
        syncedOrders: syncedCount,
        refreshScopes: Array.from(scopeKeys).flatMap((scopeKey) => {
          const [tenantId, storeId] = scopeKey.split('::');
          return tenantId && storeId ? [{ tenantId, storeId }] : [];
        }),
      };
    }, this.getDemandQueueRefreshTransactionOptions());

    await Promise.all(result.refreshScopes.map((scope) => (
      this.enqueueDemandQueueRefresh({
        ...scope,
        requestedAt: now.toISOString(),
      })
    )));

    return { syncedOrders: result.syncedOrders };
  }

  private async releasePosShippedDemandPickOrderHoldsTx(
    tx: Prisma.TransactionClient,
    params: {
      order: any;
      actorId: string | null;
      now: Date;
    },
  ) {
    const basketId = params.order.basketId as string | null;
    const activeBasketUnits = Array.isArray(params.order.basketUnits) ? params.order.basketUnits : [];
    const restorableUnitIds = activeBasketUnits
      .filter((basketUnit: any) => (
        basketUnit.inventoryUnit?.status === WmsInventoryUnitStatus.PICKED
        || basketUnit.inventoryUnit?.status === WmsInventoryUnitStatus.PACKED
      ))
      .map((basketUnit: any) => basketUnit.inventoryUnitId as string);

    const restoreStateByInventoryUnitId = basketId && restorableUnitIds.length > 0
      ? await this.loadBasketUnitRestoreStatesTx(tx, basketId, restorableUnitIds)
      : new Map<string, {
          fromLocationId: string | null;
          fromStatus: WmsInventoryUnitStatus | null;
          warehouseId: string | null;
        }>();

    const movementRows: Prisma.WmsInventoryMovementCreateManyInput[] = [];

    for (const basketUnit of activeBasketUnits) {
      const expectedSourceStatus = basketUnit.status === WmsBasketUnitStatus.PACKED
        ? WmsInventoryUnitStatus.PACKED
        : WmsInventoryUnitStatus.PICKED;
      const restoreState = restoreStateByInventoryUnitId.get(basketUnit.inventoryUnitId);

      if (
        restoreState?.fromLocationId
        && restoreState.fromStatus
        && restoreState.warehouseId
        && basketUnit.inventoryUnit?.status === expectedSourceStatus
      ) {
        const restoredNow = await this.restoreInventoryUnitToPriorStateTx(tx, {
          inventoryUnitId: basketUnit.inventoryUnitId,
          expectedSourceStatus,
          restoreState,
          actorId: params.actorId,
        });

        if (restoredNow) {
          movementRows.push({
            tenantId: basketUnit.tenantId,
            inventoryUnitId: basketUnit.inventoryUnitId,
            warehouseId: restoreState.warehouseId,
            fromLocationId: null,
            toLocationId: restoreState.fromLocationId,
            fromStatus: expectedSourceStatus,
            toStatus: restoreState.fromStatus,
            movementType: WmsInventoryMovementType.TRANSFER,
            referenceType: 'WMS_FULFILLMENT_ORDER',
            referenceId: params.order.id,
            referenceCode: params.order.posOrderId,
            notes: `POS shipped order ${params.order.posOrderId} released uncompleted pick basket hold`,
            actorId: params.actorId,
            createdAt: params.now,
          });
        }
      }

      await tx.wmsBasketUnit.updateMany({
        where: {
          id: basketUnit.id,
          status: basketUnit.status,
        },
        data: {
          status: WmsBasketUnitStatus.REMOVED,
          removedById: params.actorId ?? undefined,
          removedAt: params.now,
        },
      });
    }

    if (movementRows.length > 0) {
      await tx.wmsInventoryMovement.createMany({
        data: movementRows,
      });
    }

    await tx.wmsBasketPickDemand.deleteMany({
      where: {
        fulfillmentOrderId: params.order.id,
      },
    });

    if (basketId) {
      await tx.wmsBasket.updateMany({
        where: {
          id: basketId,
          fulfillmentOrderId: params.order.id,
        },
        data: {
          fulfillmentOrderId: null,
        },
      });
    }
  }

  private async releasePosShippedReservedPickOrderHoldsTx(
    tx: Prisma.TransactionClient,
    params: {
      order: any;
      actorId: string | null;
      now: Date;
    },
  ) {
    for (const line of params.order.lines ?? []) {
      for (const reservation of line.reservations ?? []) {
        if (reservation.status === WmsPickReservationStatus.RESERVED) {
          const released = await tx.wmsPickReservation.updateMany({
            where: {
              id: reservation.id,
              status: WmsPickReservationStatus.RESERVED,
            },
            data: {
              status: WmsPickReservationStatus.RELEASED,
            },
          });
          if (released.count !== 1) {
            continue;
          }

          const inventory = await tx.wmsInventoryUnit.updateMany({
            where: {
              id: reservation.inventoryUnitId,
              status: WmsInventoryUnitStatus.RESERVED,
            },
            data: {
              status: WmsInventoryUnitStatus.PUTAWAY,
              updatedById: params.actorId ?? undefined,
            },
          });

          if (inventory.count === 1 && reservation.inventoryUnit) {
            await tx.wmsInventoryMovement.create({
              data: {
                tenantId: params.order.tenantId,
                inventoryUnitId: reservation.inventoryUnitId,
                warehouseId: reservation.inventoryUnit.warehouseId,
                fromLocationId: reservation.inventoryUnit.currentLocationId,
                toLocationId: reservation.inventoryUnit.currentLocationId,
                fromStatus: WmsInventoryUnitStatus.RESERVED,
                toStatus: WmsInventoryUnitStatus.PUTAWAY,
                movementType: WmsInventoryMovementType.RESERVATION,
                referenceType: 'WMS_FULFILLMENT_ORDER',
                referenceId: params.order.id,
                referenceCode: params.order.posOrderId,
                notes: `Released reservation after POS marked order ${params.order.posOrderId} shipped`,
                actorId: params.actorId,
                createdAt: params.now,
              },
            });
          }
        }
      }
    }
  }

  private async syncCanceledPickingOrders(
    params: {
      tenantId: string | null;
      storeId: string | null;
      stores: FulfillmentSyncStore[];
      actorId: string | null;
      posOrderRefs?: Array<{
        shopId: string;
        posOrderId: string;
      }>;
    },
    scopedStores: FulfillmentSyncStore[],
  ) {
    const refs = Array.from(
      new Map(
        (params.posOrderRefs ?? [])
          .filter((ref) => ref.shopId && ref.posOrderId)
          .map((ref) => [`${ref.shopId}::${ref.posOrderId}`, ref] as const),
      ).values(),
    );
    const shopIds = Array.from(new Set(scopedStores.map((store) => store.shopId)));
    const tenantIds = Array.from(new Set(scopedStores.map((store) => store.tenantId)));
    const goLiveByTenantId = await this.getTenantGoLiveMap(tenantIds);
    const preGoLiveFilters: Prisma.PosOrderWhereInput[] = [];
    for (const [tid, goLiveAt] of goLiveByTenantId.entries()) {
      if (goLiveAt) {
        preGoLiveFilters.push({
          tenantId: tid,
          insertedAt: {
            lt: goLiveAt,
          },
        });
      }
    }

    const canceledPosBranch: Prisma.PosOrderWhereInput = {
      OR: [
        { status: CANCELED_POS_ORDER_STATUS },
        { isVoid: true },
      ],
      ...(refs.length > 0
        ? {
            AND: [
              {
                OR: refs.map((ref) => ({
                  shopId: ref.shopId,
                  posOrderId: ref.posOrderId,
                })),
              },
            ],
          }
        : {}),
      wmsFulfillmentOrders: {
        some: {
          status: {
            in: [
              WmsFulfillmentOrderStatus.READY,
              WmsFulfillmentOrderStatus.RESTOCKING,
              WmsFulfillmentOrderStatus.PARTIAL,
              WmsFulfillmentOrderStatus.ISSUE,
              WmsFulfillmentOrderStatus.IN_PICKING,
              WmsFulfillmentOrderStatus.READY_FOR_PACK,
              WmsFulfillmentOrderStatus.PICKED,
              WmsFulfillmentOrderStatus.PACKING,
              WmsFulfillmentOrderStatus.PACKED,
            ],
          },
        },
      },
    };

    const preGoLiveUnpickedBranch: Prisma.PosOrderWhereInput | null =
      refs.length === 0 && preGoLiveFilters.length > 0
        ? {
            OR: preGoLiveFilters,
            wmsFulfillmentOrders: {
              some: {
                basketId: null,
                status: {
                  in: [
                    WmsFulfillmentOrderStatus.READY,
                    WmsFulfillmentOrderStatus.RESTOCKING,
                    WmsFulfillmentOrderStatus.PARTIAL,
                    WmsFulfillmentOrderStatus.ISSUE,
                  ],
                },
                basketUnits: {
                  none: {
                    status: {
                      in: [...ACTIVE_BASKET_UNIT_STATUSES],
                    },
                  },
                },
              },
            },
          }
        : null;

    const canceledPosOrders = await this.prisma.posOrder.findMany({
      where: {
        shopId: { in: shopIds },
        tenantId: params.tenantId ? params.tenantId : { in: tenantIds },
        ...(preGoLiveUnpickedBranch
          ? {
              OR: [canceledPosBranch, preGoLiveUnpickedBranch],
            }
          : canceledPosBranch),
      },
      select: {
        id: true,
      },
    });

    if (canceledPosOrders.length === 0) {
      return { cleanedOrders: 0 };
    }

    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const fulfillmentOrders = await tx.wmsFulfillmentOrder.findMany({
        where: {
          posOrderDbId: {
            in: canceledPosOrders.map((order) => order.id),
          },
          status: {
            not: WmsFulfillmentOrderStatus.CANCELED,
          },
        },
        include: {
          posOrder: {
            select: {
              status: true,
              isVoid: true,
              insertedAt: true,
            },
          },
          lines: true,
          basketUnits: {
            where: {
              status: {
                in: [...ACTIVE_BASKET_UNIT_STATUSES],
              },
            },
            select: {
              id: true,
              basketId: true,
              tenantId: true,
              inventoryUnitId: true,
              sourceLocationId: true,
              status: true,
              inventoryUnit: {
                select: {
                  id: true,
                  code: true,
                  status: true,
                },
              },
            },
          },
        },
      });

      const affectedBasketIds = new Set<string>();
      const scopeKeys = new Set<string>();
      let cleanedCount = 0;

      for (const order of fulfillmentOrders) {
        const isCanceledInPos =
          (order.posOrder?.status ?? null) === CANCELED_POS_ORDER_STATUS
          || Boolean(order.posOrder?.isVoid);
        const tenantGoLiveAt = goLiveByTenantId.get(order.tenantId) ?? null;
        const isPreGoLiveUnpicked = Boolean(
          tenantGoLiveAt
          && order.posOrder?.insertedAt
          && order.posOrder.insertedAt < tenantGoLiveAt
          && !order.basketId
          && (order.basketUnits ?? []).length === 0
          && (
            order.status === WmsFulfillmentOrderStatus.READY
            || order.status === WmsFulfillmentOrderStatus.RESTOCKING
            || order.status === WmsFulfillmentOrderStatus.PARTIAL
            || order.status === WmsFulfillmentOrderStatus.ISSUE
          ),
        );

        if (!isCanceledInPos && !isPreGoLiveUnpicked) {
          continue;
        }

        const cancelReason = isCanceledInPos
          ? 'Order was canceled in POS.'
          : 'Excluded before client WMS fulfillment go-live.';
        cleanedCount += 1;

        if (order.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
          await this.releaseCanceledDemandOrderTx(tx, {
            order,
            actorId: params.actorId,
            now,
            reason: cancelReason,
          });

          if (order.basketId) {
            affectedBasketIds.add(order.basketId);
          }
          for (const basketUnit of order.basketUnits ?? []) {
            if (basketUnit.basketId) {
              affectedBasketIds.add(basketUnit.basketId);
            }
          }
          scopeKeys.add(`${order.tenantId}::${order.storeId}`);
          continue;
        }

        await tx.wmsFulfillmentLine.updateMany({
          where: {
            fulfillmentOrderId: order.id,
          },
          data: {
            quantityAllocated: 0,
            quantityPicked: 0,
            status: WmsFulfillmentLineStatus.CANCELED,
            issueReason: cancelReason,
          },
        });

        await tx.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            status: WmsFulfillmentOrderStatus.CANCELED,
            issueReason: cancelReason,
            allocatedQuantity: 0,
            pickedQuantity: 0,
            claimedById: null,
            claimedAt: null,
            packedById: null,
            basketId: null,
            completedAt: now,
            lastSyncedAt: now,
          },
        });
      }

      for (const basketId of affectedBasketIds) {
        await this.refreshDemandBasketStateTx(tx, basketId, now);
      }

      return {
        cleanedOrders: cleanedCount,
        refreshScopes: Array.from(scopeKeys).flatMap((scopeKey) => {
          const [tenantId, storeId] = scopeKey.split('::');
          return tenantId && storeId ? [{ tenantId, storeId }] : [];
        }),
      };
    }, this.getDemandQueueRefreshTransactionOptions());

    await Promise.all(result.refreshScopes.map((scope) => (
      this.enqueueDemandQueueRefresh({
        ...scope,
        requestedAt: now.toISOString(),
      })
    )));

    return { cleanedOrders: result.cleanedOrders };
  }

  private async getTenantGoLiveMap(tenantIds: string[]): Promise<Map<string, Date | null>> {
    const uniqueTenantIds = Array.from(new Set(
      tenantIds
        .map((tenantId) => tenantId?.trim())
        .filter((tenantId): tenantId is string => Boolean(tenantId)),
    ));

    if (
      uniqueTenantIds.length === 0
      || typeof (this.prisma as any).tenant?.findMany !== 'function'
    ) {
      return new Map();
    }

    const tenants = await this.prisma.tenant.findMany({
      where: {
        id: {
          in: uniqueTenantIds,
        },
      },
      select: {
        id: true,
        wmsFulfillmentGoLiveAt: true,
      },
    });

    return new Map(
      tenants.map((tenant) => [tenant.id, tenant.wmsFulfillmentGoLiveAt] as const),
    );
  }

  private async resolveDemandQueueGoLiveAt(
    client: Pick<PrismaService, 'tenant' | 'posStore'> | Prisma.TransactionClient,
    params: { tenantId: string | null; storeId: string },
  ): Promise<Date | null> {
    if (params.tenantId && typeof (client as any).tenant?.findUnique === 'function') {
      const tenant = await client.tenant.findUnique({
        where: { id: params.tenantId },
        select: { wmsFulfillmentGoLiveAt: true },
      });
      return tenant?.wmsFulfillmentGoLiveAt ?? null;
    }

    if (params.storeId && typeof (client as any).posStore?.findUnique === 'function') {
      const store = await client.posStore.findUnique({
        where: { id: params.storeId },
        select: {
          tenant: {
            select: { wmsFulfillmentGoLiveAt: true },
          },
        },
      });
      return store?.tenant?.wmsFulfillmentGoLiveAt ?? null;
    }

    return null;
  }

  private async resolveDemandQueueTenantId(
    client: Pick<PrismaService, 'posStore'> | Prisma.TransactionClient,
    params: { tenantId: string | null; storeId: string },
  ): Promise<string | null> {
    if (params.tenantId) {
      return params.tenantId;
    }
    if (params.storeId && typeof (client as any).posStore?.findUnique === 'function') {
      const store = await client.posStore.findUnique({
        where: { id: params.storeId },
        select: { tenantId: true },
      });
      return store?.tenantId ?? null;
    }
    return null;
  }

  private buildDemandQueueScopeWhere(params: {
    tenantId: string | null;
    storeId: string;
    variationIds: string[];
    goLiveAt: Date | null;
    poolIndex: TenantStockPoolIndex;
  }): Prisma.WmsFulfillmentOrderWhereInput {
    const baseWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
      OR: [
        {
          status: {
            in: [...DEMAND_QUEUE_ORDER_STATUSES],
          },
        },
        {
          status: WmsFulfillmentOrderStatus.ISSUE,
          basketId: null,
          lines: {
            some: {
              quantityRequired: {
                gt: 0,
              },
              status: {
                not: WmsFulfillmentLineStatus.CANCELED,
              },
            },
          },
        },
      ],
      posOrder: {
        is: {
          status: CONFIRMED_POS_ORDER_STATUS,
          isVoid: false,
          ...(params.goLiveAt
            ? {
                insertedAt: {
                  gte: params.goLiveAt,
                },
              }
            : {}),
        },
      },
    };

    if (!params.poolIndex.hasAnyPools) {
      return {
        ...baseWhere,
        storeId: params.storeId,
        ...(params.variationIds.length > 0
          ? {
              lines: {
                some: {
                  variationId: {
                    in: params.variationIds,
                  },
                  quantityRequired: {
                    gt: 0,
                  },
                },
              },
            }
          : {}),
      };
    }

    const expanded = params.poolIndex.expandQueueRefreshScope({
      storeId: params.storeId,
      variationIds: params.variationIds,
    });

    if (expanded.storeVariationClauses && expanded.storeVariationClauses.length > 0) {
      if (expanded.storeVariationClauses.length === 1) {
        const single = expanded.storeVariationClauses[0]!;
        return {
          ...baseWhere,
          storeId: single.storeId,
          lines: {
            some: {
              variationId: {
                in: single.variationIds,
              },
              quantityRequired: {
                gt: 0,
              },
            },
          },
        };
      }

      return {
        ...baseWhere,
        AND: [
          {
            OR: expanded.storeVariationClauses.map((clause) => ({
              storeId: clause.storeId,
              lines: {
                some: {
                  variationId: {
                    in: clause.variationIds,
                  },
                  quantityRequired: {
                    gt: 0,
                  },
                },
              },
            })),
          },
        ],
      };
    }

    return {
      ...baseWhere,
      storeId: expanded.storeIds.length === 1
        ? expanded.storeIds[0]!
        : { in: expanded.storeIds },
    };
  }

  private async buildTenantGoLiveOrderFilters(tenantIds: string[]): Promise<Prisma.PosOrderWhereInput[]> {
    const uniqueTenantIds = Array.from(new Set(
      tenantIds
        .map((tenantId) => tenantId?.trim())
        .filter((tenantId): tenantId is string => Boolean(tenantId)),
    ));

    if (uniqueTenantIds.length === 0) {
      return [];
    }

    const goLiveByTenantId = await this.getTenantGoLiveMap(uniqueTenantIds);

    return uniqueTenantIds.map((tenantId) => {
      const goLiveAt = goLiveByTenantId.get(tenantId) ?? null;

      return goLiveAt
        ? {
            tenantId,
            insertedAt: {
              gte: goLiveAt,
            },
          }
        : {
            tenantId,
          };
    });
  }

  async allocateFulfillmentOrder(fulfillmentOrderId: string, actorId: string | null) {
    const demandOrderScope = await this.prisma.wmsFulfillmentOrder.findUnique({
      where: { id: fulfillmentOrderId },
      select: {
        tenantId: true,
        storeId: true,
        assignmentMode: true,
      },
    });

    if (demandOrderScope?.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
      await this.refreshDemandFulfillmentQueue({
        tenantId: demandOrderScope.tenantId,
        storeId: demandOrderScope.storeId,
      });
      return;
    }

    await this.allocateFulfillmentOrderWithOptions(fulfillmentOrderId, actorId, {
      preferredWarehouseId: null,
    });
  }

  async reallocateWaitingOrdersForRestockedVariations(params: {
    tenantId: string;
    storeId: string;
    warehouseId: string;
    variationIds: string[];
    actorId: string | null;
  }) {
    const variationIds = Array.from(new Set(
      params.variationIds
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ));

    if (variationIds.length === 0) {
      return { reallocatedOrders: 0 };
    }

    const candidateOrders = await this.prisma.wmsFulfillmentOrder.findMany({
      where: {
        tenantId: params.tenantId,
        storeId: params.storeId,
        assignmentMode: WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
        status: {
          in: [...AUTO_REALLOCATION_ORDER_STATUSES],
        },
        posOrder: {
          is: {
            status: CONFIRMED_POS_ORDER_STATUS,
            isVoid: false,
          },
        },
        OR: [
          { warehouseId: params.warehouseId },
          { warehouseId: null },
        ],
        lines: {
          some: {
            variationId: {
              in: variationIds,
            },
            quantityRequired: {
              gt: 0,
            },
            status: {
              in: [
                WmsFulfillmentLineStatus.RESTOCKING,
                WmsFulfillmentLineStatus.PARTIAL,
              ],
            },
          },
        },
      },
      select: {
        id: true,
      },
      orderBy: [
        { posOrder: { dateLocal: 'asc' } },
        { id: 'asc' },
      ],
      take: PUTAWAY_REALLOCATION_ORDER_LIMIT,
    });

    for (const order of candidateOrders) {
      await this.allocateFulfillmentOrderWithOptions(order.id, params.actorId, {
        preferredWarehouseId: params.warehouseId,
      });
    }

    const demandCandidateOrders = await this.prisma.wmsFulfillmentOrder.findMany({
      where: {
        tenantId: params.tenantId,
        storeId: params.storeId,
        assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
        status: {
          in: [...DEMAND_QUEUE_ORDER_STATUSES],
        },
        posOrder: {
          is: {
            status: CONFIRMED_POS_ORDER_STATUS,
            isVoid: false,
          },
        },
        OR: [
          { warehouseId: null },
          { warehouseId: params.warehouseId },
        ],
        lines: {
          some: {
            variationId: {
              in: variationIds,
            },
            quantityRequired: {
              gt: 0,
            },
          },
        },
      },
      select: {
        id: true,
      },
      orderBy: [
        { posOrder: { dateLocal: 'asc' } },
        { id: 'asc' },
      ],
      take: PUTAWAY_REALLOCATION_ORDER_LIMIT,
    });

    if (demandCandidateOrders.length > 0) {
      await this.refreshDemandFulfillmentQueue({
        tenantId: params.tenantId,
        storeId: params.storeId,
        variationIds,
        limit: PUTAWAY_REALLOCATION_ORDER_LIMIT,
      });
    }

    return {
      reallocatedOrders: candidateOrders.length + demandCandidateOrders.length,
    };
  }

  async reallocateWaitingOrders(params: {
    tenantId: string | null;
    storeId: string | null;
    warehouseId?: string | null;
    actorId: string | null;
    limit?: number | null;
  }) {
    const availableRestockVariations = await this.prisma.wmsInventoryUnit.findMany({
      where: {
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
        ...(params.storeId ? { storeId: params.storeId } : {}),
        ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
        status: {
          in: [...FULFILLABLE_UNIT_STATUSES],
        },
        AND: [buildUnexpiredInventoryWhere()],
        currentLocation: {
          is: {
            kind: WmsLocationKind.BIN,
          },
        },
        pickReservations: {
          none: {
            status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
          },
        },
      },
      select: {
        storeId: true,
        variationId: true,
      },
      distinct: ['storeId', 'variationId'],
    });

    if (availableRestockVariations.length === 0) {
      return {
        checkedOrders: 0,
      };
    }

    const variationIdsByStore = availableRestockVariations.reduce((map, unit) => {
      const current = map.get(unit.storeId);
      if (current) {
        current.add(unit.variationId);
        return map;
      }

      map.set(unit.storeId, new Set([unit.variationId]));
      return map;
    }, new Map<string, Set<string>>());
    const candidateStoreIds = Array.from(variationIdsByStore.keys());
    const candidateVariationIds = Array.from(new Set(
      availableRestockVariations.map((unit) => unit.variationId),
    ));

    const candidateOrders = await this.prisma.wmsFulfillmentOrder.findMany({
      where: {
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
        ...(params.storeId
          ? { storeId: params.storeId }
          : { storeId: { in: candidateStoreIds } }),
        assignmentMode: WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
        status: {
          in: [...AUTO_REALLOCATION_ORDER_STATUSES],
        },
        posOrder: {
          is: {
            status: CONFIRMED_POS_ORDER_STATUS,
            isVoid: false,
          },
        },
        ...(params.warehouseId
          ? {
              OR: [
                { warehouseId: params.warehouseId },
                { warehouseId: null },
              ],
            }
          : {}),
        lines: {
          some: {
            quantityRequired: {
              gt: 0,
            },
            variationId: {
              in: candidateVariationIds,
            },
            status: {
              in: [
                WmsFulfillmentLineStatus.RESTOCKING,
                WmsFulfillmentLineStatus.PARTIAL,
              ],
            },
          },
        },
      },
      select: {
        id: true,
        warehouseId: true,
        storeId: true,
        lines: {
          where: {
            quantityRequired: {
              gt: 0,
            },
            status: {
              in: [
                WmsFulfillmentLineStatus.RESTOCKING,
                WmsFulfillmentLineStatus.PARTIAL,
              ],
            },
            variationId: {
              in: candidateVariationIds,
            },
          },
          select: {
            variationId: true,
          },
        },
      },
      orderBy: [
        { posOrder: { dateLocal: 'asc' } },
        { id: 'asc' },
      ],
      take: params.limit === null ? undefined : (params.limit ?? MANUAL_REALLOCATION_ORDER_LIMIT),
    });

    const filteredOrders = candidateOrders.filter((order) => {
      const availableVariations = variationIdsByStore.get(order.storeId);
      if (!availableVariations) {
        return false;
      }

      return order.lines.some((line) => availableVariations.has(line.variationId));
    });

    for (const order of filteredOrders) {
      await this.allocateFulfillmentOrderWithOptions(order.id, params.actorId, {
        preferredWarehouseId: order.warehouseId ?? params.warehouseId ?? null,
      });
    }

    const demandCandidateOrders = await this.prisma.wmsFulfillmentOrder.findMany({
      where: {
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
        ...(params.storeId
          ? { storeId: params.storeId }
          : { storeId: { in: candidateStoreIds } }),
        assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
        status: {
          in: [...DEMAND_QUEUE_ORDER_STATUSES],
        },
        posOrder: {
          is: {
            status: CONFIRMED_POS_ORDER_STATUS,
            isVoid: false,
          },
        },
        ...(params.warehouseId
          ? {
              OR: [
                { warehouseId: params.warehouseId },
                { warehouseId: null },
              ],
            }
          : {}),
        lines: {
          some: {
            quantityRequired: {
              gt: 0,
            },
            variationId: {
              in: candidateVariationIds,
            },
          },
        },
      },
      select: {
        id: true,
        tenantId: true,
        storeId: true,
        lines: {
          where: {
            quantityRequired: {
              gt: 0,
            },
            variationId: {
              in: candidateVariationIds,
            },
          },
          select: {
            variationId: true,
          },
        },
      },
      orderBy: [
        { posOrder: { dateLocal: 'asc' } },
        { id: 'asc' },
      ],
      take: params.limit === null ? undefined : (params.limit ?? MANUAL_REALLOCATION_ORDER_LIMIT),
    });

    const filteredDemandOrders = demandCandidateOrders.filter((order) => {
      const availableVariations = variationIdsByStore.get(order.storeId);
      if (!availableVariations) {
        return false;
      }

      return order.lines.some((line) => availableVariations.has(line.variationId));
    });

    const demandQueueStoreKeys = new Set(filteredDemandOrders.map((order) => (
      `${order.tenantId}::${order.storeId}`
    )));

    for (const scopeKey of demandQueueStoreKeys) {
      const [tenantId, storeId] = scopeKey.split('::');
      if (!storeId) {
        continue;
      }

      await this.refreshDemandFulfillmentQueue({
        tenantId: tenantId || null,
        storeId,
        variationIds: Array.from(variationIdsByStore.get(storeId) ?? []),
        limit: params.limit === null ? null : (params.limit ?? MANUAL_REALLOCATION_ORDER_LIMIT),
      });
    }

    return {
      checkedOrders: filteredOrders.length + filteredDemandOrders.length,
    };
  }

  async retryAllocationForFulfillmentOrder(fulfillmentOrderId: string, actorId: string | null) {
    await this.allocateFulfillmentOrder(fulfillmentOrderId, actorId);
  }

  async refreshDemandQueueForScope(params: {
    tenantId: string | null;
    storeId: string;
    variationIds?: string[] | null;
    limit?: number | null;
  }) {
    await this.refreshDemandFulfillmentQueue(params);
  }

  async refreshDemandQueueForScopeTx(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string | null;
      storeId: string;
      variationIds?: string[] | null;
      limit?: number | null;
    },
    now = new Date(),
  ) {
    await this.refreshDemandFulfillmentQueueTx(tx, params, now);
  }

  async clearPriorityOverridesTx(
    tx: Prisma.TransactionClient,
    params: {
      targetOrderIds: string[];
    },
  ) {
    const targetOrderIds = Array.from(new Set(
      params.targetOrderIds
        .map((orderId) => orderId?.trim())
        .filter((orderId): orderId is string => Boolean(orderId)),
    ));

    if (targetOrderIds.length === 0) {
      return {
        clearedTargets: 0,
        clearedDonors: 0,
      };
    }

    const [targetUpdate, donorUpdate] = await Promise.all([
      tx.wmsFulfillmentOrder.updateMany({
        where: {
          id: {
            in: targetOrderIds,
          },
        },
        data: {
          priorityOverrideAt: null,
          priorityOverrideReason: null,
        },
      }),
      tx.wmsFulfillmentOrder.updateMany({
        where: {
          priorityReleasedForOrderId: {
            in: targetOrderIds,
          },
        },
        data: {
          priorityReleasedForOrderId: null,
        },
      }),
    ]);

    return {
      clearedTargets: targetUpdate.count,
      clearedDonors: donorUpdate.count,
    };
  }

  async repairReleasedDemandOrders(params: {
    orderIds: string[];
    actorId: string | null;
    reason?: string | null;
  }) {
    const orderIds = Array.from(new Set(
      params.orderIds
        .map((orderId) => orderId?.trim())
        .filter((orderId): orderId is string => Boolean(orderId)),
    ));
    if (orderIds.length === 0) {
      return {
        repairedOrders: 0,
        resetOrders: 0,
        canceledOrders: 0,
        refreshedScopes: 0,
      };
    }

    const reason = params.reason?.trim() || 'Pick basket was voided from WMS.';
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const orders = await tx.wmsFulfillmentOrder.findMany({
        where: {
          id: {
            in: orderIds,
          },
        },
        include: {
          posOrder: {
            select: {
              status: true,
              isVoid: true,
            },
          },
          lines: true,
        },
      });

      const demandOrders = orders.filter((order) => (
        order.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
        && order.status !== WmsFulfillmentOrderStatus.PACKED
        && order.status !== WmsFulfillmentOrderStatus.CANCELED
      ));
      const scopeKeys = new Set(demandOrders.map((order) => `${order.tenantId}::${order.storeId}`));
      let resetOrders = 0;
      let canceledOrders = 0;

      for (const order of demandOrders) {
        const isConfirmed = order.posOrder.status === CONFIRMED_POS_ORDER_STATUS && !order.posOrder.isVoid;

        await tx.wmsFulfillmentLine.updateMany({
          where: {
            fulfillmentOrderId: order.id,
            status: {
              not: WmsFulfillmentLineStatus.CANCELED,
            },
          },
          data: {
            quantityAllocated: 0,
            quantityPicked: 0,
            status: isConfirmed ? WmsFulfillmentLineStatus.RESTOCKING : WmsFulfillmentLineStatus.CANCELED,
            issueReason: isConfirmed ? null : reason,
          },
        });

        await tx.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            warehouseId: null,
            status: isConfirmed ? WmsFulfillmentOrderStatus.RESTOCKING : WmsFulfillmentOrderStatus.CANCELED,
            issueReason: isConfirmed ? null : reason,
            allocatedQuantity: 0,
            pickedQuantity: 0,
            claimedById: null,
            claimedAt: null,
            packedById: null,
            basketId: null,
            completedAt: isConfirmed ? null : now,
            lastSyncedAt: now,
          },
        });

        if (isConfirmed) {
          resetOrders += 1;
        } else {
          canceledOrders += 1;
        }
      }

      for (const scopeKey of scopeKeys) {
        const [tenantId, storeId] = scopeKey.split('::');
        if (!tenantId || !storeId) {
          continue;
        }

        await this.refreshDemandFulfillmentQueueTx(tx, {
          tenantId,
          storeId,
        }, now);
      }

      return {
        repairedOrders: demandOrders.length,
        resetOrders,
        canceledOrders,
        refreshedScopes: scopeKeys.size,
      };
    });
  }

  private async refreshDemandFulfillmentQueue(params: {
    tenantId: string | null;
    storeId: string;
    variationIds?: string[] | null;
    limit?: number | null;
  }) {
    const now = new Date();
    const effectiveTenantId = await this.resolveDemandQueueTenantId(this.prisma, params);
    const [goLiveAt, poolIndex] = await Promise.all([
      this.resolveDemandQueueGoLiveAt(this.prisma, {
        tenantId: effectiveTenantId ?? params.tenantId,
        storeId: params.storeId,
      }),
      loadTenantStockPoolIndex(this.prisma, effectiveTenantId),
    ]);
    const variationIds = Array.from(new Set(
      (params.variationIds ?? [])
        .map((variationId) => variationId?.trim())
        .filter((variationId): variationId is string => Boolean(variationId)),
    ));
    const orderedQueue = await this.prisma.wmsFulfillmentOrder.findMany({
      where: this.buildDemandQueueScopeWhere({
        tenantId: effectiveTenantId ?? params.tenantId,
        storeId: params.storeId,
        variationIds,
        goLiveAt,
        poolIndex,
      }),
      select: {
        id: true,
        priorityOverrideAt: true,
        priorityReleasedForOrderId: true,
        posOrder: {
          select: {
            dateLocal: true,
          },
        },
      },
      orderBy: [
        { posOrder: { dateLocal: 'asc' } },
        { id: 'asc' },
      ],
      ...(typeof params.limit === 'number' && params.limit > 0 ? { take: params.limit } : {}),
    });
    const orderedQueueIds = this.sortDemandQueueOrders(orderedQueue).map((order) => order.id);

    if (orderedQueueIds.length === 0) {
      return;
    }

    const virtualAllocatedByWarehouseVariation = new Map<string, number>();
    const chunkSize = this.getDemandQueueRefreshChunkSize();
    const incompleteOrderIds: string[] = [];

    for (let index = 0; index < orderedQueueIds.length; index += chunkSize) {
      const chunkIds = orderedQueueIds.slice(index, index + chunkSize);
      const incompleteChunkIds = await this.prisma.$transaction(async (tx) => {
        const batchOrders = await tx.wmsFulfillmentOrder.findMany({
          where: {
            id: {
              in: chunkIds,
            },
          },
          include: {
            posOrder: {
              select: {
                status: true,
                isVoid: true,
                dateLocal: true,
              },
            },
            lines: true,
          },
        });
        const orderById = new Map(batchOrders.map((order) => [order.id, order]));
        const pendingPartialIds: string[] = [];

        for (const orderId of chunkIds) {
          const order = orderById.get(orderId);
          if (!order) {
            continue;
          }

          const result = await this.refreshDemandFulfillmentOrderReadinessTx(tx, order.id, now, {
            order,
            poolIndex,
            virtualAllocatedByWarehouseVariation,
            accumulateVirtualAllocation: true,
          });
          if (result && !result.isFullyAllocated) {
            pendingPartialIds.push(order.id);
          }
        }

        return pendingPartialIds;
      }, this.getDemandQueueRefreshTransactionOptions());
      incompleteOrderIds.push(...incompleteChunkIds);
    }

    // Complete orders reserve stock first. Only genuine leftovers are offered
    // back to incomplete orders so PARTIAL work does not block READY work.
    for (let index = 0; index < incompleteOrderIds.length; index += chunkSize) {
      const chunkIds = incompleteOrderIds.slice(index, index + chunkSize);
      await this.prisma.$transaction(async (tx) => {
        const batchOrders = await tx.wmsFulfillmentOrder.findMany({
          where: {
            id: {
              in: chunkIds,
            },
          },
          include: {
            posOrder: {
              select: {
                status: true,
                isVoid: true,
                dateLocal: true,
              },
            },
            lines: true,
          },
        });
        const orderById = new Map(batchOrders.map((order) => [order.id, order]));

        for (const orderId of chunkIds) {
          const order = orderById.get(orderId);
          if (!order) {
            continue;
          }

          await this.refreshDemandFulfillmentOrderReadinessTx(tx, order.id, now, {
            order,
            poolIndex,
            virtualAllocatedByWarehouseVariation,
            accumulateVirtualAllocation: true,
            allocationMode: 'ALLOW_PARTIAL',
          });
        }
      }, this.getDemandQueueRefreshTransactionOptions());
    }
  }

  private async refreshDemandFulfillmentQueueTx(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string | null;
      storeId: string;
      variationIds?: string[] | null;
      limit?: number | null;
    },
    now: Date,
  ) {
    const effectiveTenantId = await this.resolveDemandQueueTenantId(tx, params);
    const [goLiveAt, poolIndex] = await Promise.all([
      this.resolveDemandQueueGoLiveAt(tx, {
        tenantId: effectiveTenantId ?? params.tenantId,
        storeId: params.storeId,
      }),
      loadTenantStockPoolIndex(tx, effectiveTenantId),
    ]);
    const variationIds = Array.from(new Set(
      (params.variationIds ?? [])
        .map((variationId) => variationId?.trim())
        .filter((variationId): variationId is string => Boolean(variationId)),
    ));
    const queueOrders = await tx.wmsFulfillmentOrder.findMany({
      where: this.buildDemandQueueScopeWhere({
        tenantId: effectiveTenantId ?? params.tenantId,
        storeId: params.storeId,
        variationIds,
        goLiveAt,
        poolIndex,
      }),
      include: {
        posOrder: {
          select: {
            status: true,
            isVoid: true,
            dateLocal: true,
          },
        },
        lines: true,
      },
      ...(typeof params.limit === 'number' && params.limit > 0 ? { take: params.limit } : {}),
    });

    const orderedQueue = this.sortDemandQueueOrders(queueOrders);
    const virtualAllocatedByWarehouseVariation = new Map<string, number>();
    const incompleteOrders: DemandFulfillmentReadinessRecord[] = [];

    for (const order of orderedQueue) {
      const result = await this.refreshDemandFulfillmentOrderReadinessTx(tx, order.id, now, {
        order,
        poolIndex,
        virtualAllocatedByWarehouseVariation,
        accumulateVirtualAllocation: true,
      });
      if (result && !result.isFullyAllocated) {
        incompleteOrders.push(order);
      }
    }

    for (const order of incompleteOrders) {
      await this.refreshDemandFulfillmentOrderReadinessTx(tx, order.id, now, {
        order,
        poolIndex,
        virtualAllocatedByWarehouseVariation,
        accumulateVirtualAllocation: true,
        allocationMode: 'ALLOW_PARTIAL',
      });
    }
  }

  private async releaseCanceledDemandOrderTx(
    tx: Prisma.TransactionClient,
    params: {
      order: any;
      actorId: string | null;
      now: Date;
      reason?: string;
    },
  ) {
    const cancelReason = params.reason ?? 'Order was canceled in POS.';
    const basketId = params.order.basketId as string | null;
    const activeBasketUnits = Array.isArray(params.order.basketUnits) ? params.order.basketUnits : [];
    const restorableUnitIds = activeBasketUnits
      .filter((basketUnit: any) => (
        basketUnit.inventoryUnit?.status === WmsInventoryUnitStatus.PICKED
        || basketUnit.inventoryUnit?.status === WmsInventoryUnitStatus.PACKED
      ))
      .map((basketUnit: any) => basketUnit.inventoryUnitId as string);

    const restoreStateByInventoryUnitId = basketId && restorableUnitIds.length > 0
      ? await this.loadBasketUnitRestoreStatesTx(tx, basketId, restorableUnitIds)
      : new Map<string, {
          fromLocationId: string | null;
          fromStatus: WmsInventoryUnitStatus | null;
          warehouseId: string | null;
        }>();

    const movementRows: Prisma.WmsInventoryMovementCreateManyInput[] = [];

    for (const basketUnit of activeBasketUnits) {
      const expectedSourceStatus = basketUnit.status === WmsBasketUnitStatus.PACKED
        ? WmsInventoryUnitStatus.PACKED
        : WmsInventoryUnitStatus.PICKED;
      const restoreState = restoreStateByInventoryUnitId.get(basketUnit.inventoryUnitId);

      if (
        restoreState?.fromLocationId
        && restoreState.fromStatus
        && restoreState.warehouseId
        && basketUnit.inventoryUnit?.status === expectedSourceStatus
      ) {
        const restoredNow = await this.restoreInventoryUnitToPriorStateTx(tx, {
          inventoryUnitId: basketUnit.inventoryUnitId,
          expectedSourceStatus,
          restoreState,
          actorId: params.actorId,
        });

        if (restoredNow) {
          movementRows.push({
            tenantId: basketUnit.tenantId,
            inventoryUnitId: basketUnit.inventoryUnitId,
            warehouseId: restoreState.warehouseId,
            fromLocationId: null,
            toLocationId: restoreState.fromLocationId,
            fromStatus: expectedSourceStatus,
            toStatus: restoreState.fromStatus,
            movementType: WmsInventoryMovementType.TRANSFER,
            referenceType: 'WMS_FULFILLMENT_ORDER',
            referenceId: params.order.id,
            referenceCode: params.order.posOrderId,
            notes: `POS canceled order ${params.order.posOrderId} released basket hold`,
            actorId: params.actorId,
            createdAt: params.now,
          });
        }
      }

      await tx.wmsBasketUnit.updateMany({
        where: {
          id: basketUnit.id,
          status: basketUnit.status,
        },
        data: {
          status: WmsBasketUnitStatus.REMOVED,
          removedById: params.actorId ?? undefined,
          removedAt: params.now,
        },
      });
    }

    if (movementRows.length > 0) {
      await tx.wmsInventoryMovement.createMany({
        data: movementRows,
      });
    }

    await tx.wmsBasketPickDemand.deleteMany({
      where: {
        fulfillmentOrderId: params.order.id,
      },
    });

    await tx.wmsFulfillmentLine.updateMany({
      where: {
        fulfillmentOrderId: params.order.id,
      },
      data: {
        quantityAllocated: 0,
        quantityPicked: 0,
        status: WmsFulfillmentLineStatus.CANCELED,
        issueReason: cancelReason,
      },
    });

    await tx.wmsFulfillmentOrder.update({
      where: { id: params.order.id },
      data: {
        status: WmsFulfillmentOrderStatus.CANCELED,
        issueReason: cancelReason,
        allocatedQuantity: 0,
        pickedQuantity: 0,
        claimedById: null,
        claimedAt: null,
        packedById: null,
        basketId: null,
        completedAt: params.now,
        lastSyncedAt: params.now,
      },
    });
  }

  private async loadBasketUnitRestoreStatesTx(
    tx: Prisma.TransactionClient,
    basketId: string,
    inventoryUnitIds: string[],
  ) {
    if (inventoryUnitIds.length === 0) {
      return new Map<string, {
        fromLocationId: string | null;
        fromStatus: WmsInventoryUnitStatus | null;
        warehouseId: string | null;
      }>();
    }

    const movements = await tx.wmsInventoryMovement.findMany({
      where: {
        inventoryUnitId: {
          in: inventoryUnitIds,
        },
        movementType: WmsInventoryMovementType.PICK,
        referenceType: 'WMS_BASKET',
        referenceId: basketId,
      },
      select: {
        inventoryUnitId: true,
        warehouseId: true,
        fromLocationId: true,
        fromStatus: true,
        createdAt: true,
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });

    const restoreStateByInventoryUnitId = new Map<string, {
      fromLocationId: string | null;
      fromStatus: WmsInventoryUnitStatus | null;
      warehouseId: string | null;
    }>();

    for (const movement of movements) {
      if (restoreStateByInventoryUnitId.has(movement.inventoryUnitId)) {
        continue;
      }

      restoreStateByInventoryUnitId.set(movement.inventoryUnitId, {
        fromLocationId: movement.fromLocationId ?? null,
        fromStatus: movement.fromStatus ?? null,
        warehouseId: movement.warehouseId ?? null,
      });
    }

    return restoreStateByInventoryUnitId;
  }

  private async restoreInventoryUnitToPriorStateTx(
    tx: Prisma.TransactionClient,
    params: {
      inventoryUnitId: string;
      expectedSourceStatus: WmsInventoryUnitStatus;
      restoreState: {
        fromLocationId: string | null;
        fromStatus: WmsInventoryUnitStatus | null;
        warehouseId: string | null;
      };
      actorId: string | null;
    },
  ) {
    const targetStatus = params.restoreState.fromStatus;
    if (!targetStatus) {
      return false;
    }

    const inventoryUpdate = await tx.wmsInventoryUnit.updateMany({
      where: {
        id: params.inventoryUnitId,
        status: params.expectedSourceStatus,
      },
      data: {
        currentLocationId: params.restoreState.fromLocationId,
        status: targetStatus,
        updatedById: params.actorId ?? undefined,
      },
    });

    if (inventoryUpdate.count === 1) {
      return true;
    }

    const currentUnit = await tx.wmsInventoryUnit.findUnique({
      where: { id: params.inventoryUnitId },
      select: {
        id: true,
        status: true,
        currentLocationId: true,
      },
    });

    return Boolean(
      currentUnit
      && currentUnit.status === targetStatus
      && currentUnit.currentLocationId === params.restoreState.fromLocationId,
    );
  }

  private buildFulfillmentAmendmentPlan(
    order: any,
    diff: ReturnType<typeof diffFulfillmentDemand>,
    nextLineCount?: number,
  ): FulfillmentAmendmentPlan {
    const summarized = summarizeFulfillmentDemandDiff(diff);
    const pickedByVariation = new Map<string, number>();
    for (const line of order.lines ?? []) {
      const serialPicked = (line.reservations ?? []).filter(
        (reservation: any) => reservation.status === WmsPickReservationStatus.PICKED,
      ).length;
      pickedByVariation.set(
        line.variationId,
        Math.max(line.quantityPicked ?? 0, serialPicked),
      );
    }
    for (const demand of order.basketPickDemands ?? []) {
      pickedByVariation.set(
        demand.variationId,
        Math.max(pickedByVariation.get(demand.variationId) ?? 0, demand.quantityPicked ?? 0),
      );
    }
    const basketUnitsByVariation = new Map<string, number>();
    for (const basketUnit of order.basketUnits ?? []) {
      basketUnitsByVariation.set(
        basketUnit.variationId,
        (basketUnitsByVariation.get(basketUnit.variationId) ?? 0) + 1,
      );
    }
    for (const [variationId, quantity] of basketUnitsByVariation) {
      pickedByVariation.set(
        variationId,
        Math.max(pickedByVariation.get(variationId) ?? 0, quantity),
      );
    }

    const returnActions = [...diff.removed, ...diff.decreased]
      .map((change) => ({
        variationId: change.variationId,
        productName: change.productName,
        quantity: Math.max(
          (pickedByVariation.get(change.variationId) ?? 0) - change.nextQuantity,
          0,
        ),
      }))
      .filter((action) => action.quantity > 0);
    const retainedPickedByVariation = new Map(pickedByVariation);
    for (const action of returnActions) {
      retainedPickedByVariation.set(
        action.variationId,
        Math.max((retainedPickedByVariation.get(action.variationId) ?? 0) - action.quantity, 0),
      );
    }
    const pickActions = [...diff.added, ...diff.increased]
      .map((change) => ({
        variationId: change.variationId,
        productName: change.productName,
        quantity: Math.max(
          change.nextQuantity - (retainedPickedByVariation.get(change.variationId) ?? 0),
          0,
        ),
      }))
      .filter((action) => action.quantity > 0);

    const physicalPickedTotal = Array.from(pickedByVariation.values())
      .reduce((sum, quantity) => sum + quantity, 0);
    const hasPhysicalWork = returnActions.length > 0 || pickActions.length > 0;
    const isInActivePickOrBasket =
      Boolean(order.basketId)
      || order.status === WmsFulfillmentOrderStatus.IN_PICKING
      || order.status === WmsFulfillmentOrderStatus.READY_FOR_PACK
      || order.status === WmsFulfillmentOrderStatus.PICKED;
    const allItemsRemovedDuringPick = isInActivePickOrBasket && nextLineCount === 0;
    let stage: WmsFulfillmentAmendmentStage = WmsFulfillmentAmendmentStage.PRE_PICK;
    let changeState: WmsFulfillmentChangeState = WmsFulfillmentChangeState.NONE;
    if (order.status === WmsFulfillmentOrderStatus.PACKED) {
      stage = WmsFulfillmentAmendmentStage.PACKED;
      changeState = WmsFulfillmentChangeState.PACKED_REWORK_REQUIRED;
    } else if (order.status === WmsFulfillmentOrderStatus.PACKING) {
      stage = WmsFulfillmentAmendmentStage.PACKING;
      changeState = WmsFulfillmentChangeState.PACK_REWORK_REQUIRED;
    } else if (isInActivePickOrBasket) {
      stage = WmsFulfillmentAmendmentStage.PICKING;
      changeState = allItemsRemovedDuringPick
        ? WmsFulfillmentChangeState.PICK_REWORK_REQUIRED
        : order.status === WmsFulfillmentOrderStatus.IN_PICKING && physicalPickedTotal === 0
          ? WmsFulfillmentChangeState.NONE
          : hasPhysicalWork
            ? WmsFulfillmentChangeState.PICK_REWORK_REQUIRED
            : WmsFulfillmentChangeState.NONE;
    }

    return {
      stage,
      changeState,
      summary: {
        ...summarized,
        ...(allItemsRemovedDuringPick
          ? {
              message: 'All pickable items were removed from this order in POS. Return any picked units or detach this order from the basket.',
            }
          : {}),
        autoRebuilt: true,
        requiresAction: changeState !== WmsFulfillmentChangeState.NONE,
        detectedStage: stage,
        notificationTitle: allItemsRemovedDuringPick
          ? 'Order changed during picking — all items removed'
          : changeState === WmsFulfillmentChangeState.NONE
            ? 'Order updated — pick list refreshed'
            : stage === WmsFulfillmentAmendmentStage.PACKED
              ? 'Packed order changed — rework required'
              : stage === WmsFulfillmentAmendmentStage.PACKING
                ? 'Order changed during packing'
                : 'Order changed during picking',
        returnUnitsRemaining: returnActions.reduce((sum, action) => sum + action.quantity, 0),
        pickUnitsRequired: pickActions.reduce((sum, action) => sum + action.quantity, 0),
      },
      requiredActions: {
        pick: pickActions,
        return: returnActions,
      },
    };
  }

  private async releaseSurplusReservedUnitsTx(
    tx: Prisma.TransactionClient,
    order: any,
    nextLines: FulfillmentLineDraft[],
    actorId: string | null,
    now: Date,
  ) {
    if (order.assignmentMode !== WmsFulfillmentAssignmentMode.SERIAL_RESERVED) {
      return;
    }

    const targetByVariation = new Map(nextLines.map((line) => [line.variationId, line.quantityRequired]));
    for (const line of order.lines ?? []) {
      const target = targetByVariation.get(line.variationId) ?? 0;
      const pickedCount = (line.reservations ?? []).filter(
        (reservation: any) => reservation.status === WmsPickReservationStatus.PICKED,
      ).length;
      const reserved = (line.reservations ?? []).filter(
        (reservation: any) => reservation.status === WmsPickReservationStatus.RESERVED,
      );
      const keepReserved = Math.max(target - pickedCount, 0);
      const surplus = reserved.slice(keepReserved);

      for (const reservation of surplus) {
        const released = await tx.wmsPickReservation.updateMany({
          where: { id: reservation.id, status: WmsPickReservationStatus.RESERVED },
          data: { status: WmsPickReservationStatus.RELEASED },
        });
        if (released.count !== 1) {
          continue;
        }
        const inventory = await tx.wmsInventoryUnit.updateMany({
          where: { id: reservation.inventoryUnitId, status: WmsInventoryUnitStatus.RESERVED },
          data: { status: WmsInventoryUnitStatus.PUTAWAY, updatedById: actorId ?? undefined },
        });
        if (inventory.count === 1) {
          await tx.wmsInventoryMovement.create({
            data: {
              tenantId: order.tenantId,
              inventoryUnitId: reservation.inventoryUnitId,
              warehouseId: reservation.inventoryUnit.warehouseId,
              fromLocationId: reservation.inventoryUnit.currentLocationId,
              toLocationId: reservation.inventoryUnit.currentLocationId,
              fromStatus: WmsInventoryUnitStatus.RESERVED,
              toStatus: WmsInventoryUnitStatus.PUTAWAY,
              movementType: WmsInventoryMovementType.RESERVATION,
              referenceType: 'WMS_FULFILLMENT_AMENDMENT',
              referenceId: order.id,
              referenceCode: order.posOrderId,
              notes: `Released after POS changed order ${order.posOrderId}`,
              actorId,
              createdAt: now,
            },
          });
        }
      }
    }
  }

  private async rebuildActiveBasketDemandTx(
    tx: Prisma.TransactionClient,
    params: {
      order: any;
      lines: FulfillmentLineDraft[];
      amendment: FulfillmentAmendmentPlan;
      now: Date;
    },
  ) {
    const basketId = params.order.basketId as string;
    const warehouseId = params.order.warehouseId as string | null;
    if (!warehouseId) {
      return;
    }

    // Scanner writes already lock the basket. Taking the same lock here keeps
    // an automatic POS revision rebuild from racing an in-flight scan.
    await tx.$queryRaw`SELECT "id" FROM "wms_baskets" WHERE "id" = ${basketId}::uuid FOR UPDATE`;

    const oldDemandByVariation = new Map<string, any>();
    for (const demand of params.order.basketPickDemands ?? []) {
      oldDemandByVariation.set(demand.variationId, demand);
    }
    await tx.wmsBasketPickDemand.deleteMany({
      where: { fulfillmentOrderId: params.order.id },
    });

    if (
      params.order.status === WmsFulfillmentOrderStatus.PACKING
      || params.order.status === WmsFulfillmentOrderStatus.PACKED
    ) {
      const packedUnits = (params.order.basketUnits ?? []).filter(
        (unit: any) => unit.status === WmsBasketUnitStatus.PACKED,
      );
      for (const unit of packedUnits) {
        await tx.wmsBasketUnit.update({
          where: { id: unit.id },
          data: { status: WmsBasketUnitStatus.PICKED, packedById: null, packedAt: null },
        });
        await tx.wmsInventoryUnit.updateMany({
          where: { id: unit.inventoryUnitId, status: WmsInventoryUnitStatus.PACKED },
          data: { status: WmsInventoryUnitStatus.PICKED },
        });
      }
    }

    const currentLines = await tx.wmsFulfillmentLine.findMany({
      where: {
        fulfillmentOrderId: params.order.id,
        status: { not: WmsFulfillmentLineStatus.CANCELED },
        quantityRequired: { gt: 0 },
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    let routeSequence = await tx.wmsBasketPickDemandBin.count({ where: { basketId } });
    let totalAllocated = 0;
    let totalPicked = 0;

    for (const line of currentLines) {
      const oldDemand = oldDemandByVariation.get(line.variationId);
      const carriedPicked = Math.min(oldDemand?.quantityPicked ?? 0, line.quantityRequired);
      const demand = await tx.wmsBasketPickDemand.create({
        data: {
          tenantId: params.order.tenantId,
          storeId: params.order.storeId,
          basketId,
          fulfillmentOrderId: params.order.id,
          fulfillmentLineId: line.id,
          productId: line.productId,
          variationId: line.variationId,
          productName: line.productName,
          productDisplayId: line.productDisplayId,
          quantityRequired: line.quantityRequired,
          quantityPicked: carriedPicked,
          quantityPacked: 0,
        },
      });

      let remainingPicked = carriedPicked;
      for (const oldBin of oldDemand?.bins ?? []) {
        if (remainingPicked <= 0) break;
        const binPicked = Math.min(oldBin.quantityPicked ?? 0, remainingPicked);
        if (binPicked <= 0) continue;
        routeSequence += 1;
        await tx.wmsBasketPickDemandBin.create({
          data: {
            tenantId: params.order.tenantId,
            basketId,
            demandId: demand.id,
            warehouseId: oldBin.warehouseId,
            locationId: oldBin.locationId,
            variationId: line.variationId,
            quantityTarget: binPicked,
            quantityPicked: binPicked,
            routeSequence,
          },
        });
        remainingPicked -= binPicked;
      }

      const missing = Math.max(line.quantityRequired - carriedPicked, 0);
      const availableBins = await this.findReworkDemandBinsTx(tx, {
        tenantId: params.order.tenantId,
        storeId: params.order.storeId,
        warehouseId,
        posWarehouseRef: params.order.posWarehouseRef ?? null,
        variationId: line.variationId,
      });
      let remaining = missing;
      for (const bin of availableBins) {
        if (remaining <= 0) break;
        const target = Math.min(bin.availableQuantity, remaining);
        if (target <= 0) continue;
        routeSequence += 1;
        await tx.wmsBasketPickDemandBin.create({
          data: {
            tenantId: params.order.tenantId,
            basketId,
            demandId: demand.id,
            warehouseId,
            locationId: bin.locationId,
            variationId: line.variationId,
            quantityTarget: target,
            routeSequence,
          },
        });
        remaining -= target;
      }

      const allocated = carriedPicked + (missing - remaining);
      totalAllocated += allocated;
      totalPicked += carriedPicked;
      await tx.wmsFulfillmentLine.update({
        where: { id: line.id },
        data: {
          quantityAllocated: allocated,
          quantityPicked: carriedPicked,
          status: this.resolveFulfillmentLineStatus(
            line.quantityRequired,
            allocated,
            carriedPicked,
            line.status,
          ),
          issueReason: remaining > 0 ? `Needs ${remaining} more unit${remaining === 1 ? '' : 's'} after POS order update.` : null,
        },
      });
    }

    // Never put an order into ISSUE status while it is actively being picked in a basket.
    // Keep it IN_PICKING so the picker sees the automatic revision / rework note above.
    await tx.wmsFulfillmentOrder.update({
      where: { id: params.order.id },
      data: {
        status: WmsFulfillmentOrderStatus.IN_PICKING,
        issueReason: null,
        allocatedQuantity: Math.min(totalAllocated, params.lines.reduce((sum, line) => sum + line.quantityRequired, 0)),
        pickedQuantity: Math.min(totalPicked, params.lines.reduce((sum, line) => sum + line.quantityRequired, 0)),
        packedById: null,
        completedAt: null,
      },
    });
    await tx.wmsBasket.update({
      where: { id: basketId },
      data: {
        status: WmsBasketStatus.IN_PICKING,
        assignedPackerId: null,
        fullAt: null,
        readyForPackAt: null,
      },
    });
  }

  private async findReworkDemandBinsTx(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      storeId: string;
      warehouseId: string;
      posWarehouseRef: string | null;
      variationId: string;
    },
  ) {
    const groups = await tx.wmsInventoryUnit.groupBy({
      by: ['currentLocationId'],
      where: {
        tenantId: params.tenantId,
        storeId: params.storeId,
        warehouseId: params.warehouseId,
        variationId: params.variationId,
        status: WmsInventoryUnitStatus.PUTAWAY,
        currentLocationId: { not: null },
        currentLocation: { is: { kind: WmsLocationKind.BIN, isActive: true } },
        AND: [
          buildUnexpiredInventoryWhere(),
          ...(params.posWarehouseRef
            ? [{ OR: [{ posWarehouseRef: params.posWarehouseRef }, { posWarehouseRef: null }] }]
            : []),
        ],
        pickReservations: { none: { status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] } } },
        basketUnits: { none: { status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] } } },
      },
      _count: { _all: true },
    });
    const locationIds = groups
      .map((group) => group.currentLocationId)
      .filter((id): id is string => Boolean(id));
    const holds = locationIds.length > 0
      ? await tx.wmsBasketPickDemandBin.groupBy({
          by: ['locationId'],
          where: {
            tenantId: params.tenantId,
            variationId: params.variationId,
            locationId: { in: locationIds },
            basket: { status: { in: [...ACTIVE_DEMAND_BASKET_STATUSES] } },
          },
          _sum: { quantityTarget: true, quantityPicked: true },
        })
      : [];
    const heldByLocation = new Map(holds.map((hold) => [
      hold.locationId,
      Math.max((hold._sum.quantityTarget ?? 0) - (hold._sum.quantityPicked ?? 0), 0),
    ]));

    return groups
      .filter((group): group is typeof group & { currentLocationId: string } => Boolean(group.currentLocationId))
      .map((group) => ({
        locationId: group.currentLocationId,
        availableQuantity: Math.max(group._count._all - (heldByLocation.get(group.currentLocationId) ?? 0), 0),
      }))
      .filter((group) => group.availableQuantity > 0);
  }

  async returnAmendmentBasketUnit(params: {
    tenantId: string;
    fulfillmentOrderId: string;
    basketId: string;
    code: string;
    actorId: string | null;
  }) {
    const normalizedCode = params.code.trim();
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "wms_baskets" WHERE "id" = ${params.basketId}::uuid FOR UPDATE`;
      const order = await tx.wmsFulfillmentOrder.findFirst({
        where: {
          id: params.fulfillmentOrderId,
          tenantId: params.tenantId,
          basketId: params.basketId,
          changeState: {
            in: [
              WmsFulfillmentChangeState.PICK_REWORK_REQUIRED,
              WmsFulfillmentChangeState.PACK_REWORK_REQUIRED,
              WmsFulfillmentChangeState.PACKED_REWORK_REQUIRED,
            ],
          },
        },
        include: {
          amendments: {
            where: { status: WmsFulfillmentAmendmentStatus.OPEN },
            orderBy: { detectedAt: 'desc' },
            take: 1,
          },
        },
      });
      if (!order) {
        throw new NotFoundException('Active order rework was not found');
      }
      const amendment = order.amendments[0];
      if (!amendment) {
        throw new ConflictException('Open order amendment was not found');
      }
      const actions = amendment.requiredActions as any;
      const returnActions = Array.isArray(actions?.return) ? actions.return : [];
      const requiredVariations = new Set<string>(
        returnActions
          .filter((action: any) => Math.max(action.quantity ?? 0, 0) > 0)
          .map((action: any) => String(action.variationId)),
      );
      const basketUnit = await tx.wmsBasketUnit.findFirst({
        where: {
          basketId: params.basketId,
          fulfillmentOrderId: order.id,
          status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] },
          variationId: { in: Array.from(requiredVariations) },
          inventoryUnit: {
            is: {
              OR: [
                { code: normalizedCode },
                { barcode: normalizedCode },
                ...(normalizedCode.match(/^[0-9a-f-]{36}$/i) ? [{ id: normalizedCode }] : []),
              ],
            },
          },
        },
        include: { inventoryUnit: true },
      });
      if (!basketUnit) {
        throw new BadRequestException('Scanned unit is not one of the items that must be returned');
      }
      if (!basketUnit.sourceLocationId) {
        throw new ConflictException(`Unit ${basketUnit.inventoryUnit.code} has no original bin to return to`);
      }
      const fromStatus = basketUnit.inventoryUnit.status;
      if (
        fromStatus !== WmsInventoryUnitStatus.PICKED
        && fromStatus !== WmsInventoryUnitStatus.PACKED
      ) {
        throw new ConflictException(`Unit ${basketUnit.inventoryUnit.code} is no longer held for rework`);
      }

      await tx.wmsInventoryUnit.update({
        where: { id: basketUnit.inventoryUnitId },
        data: {
          status: WmsInventoryUnitStatus.PUTAWAY,
          currentLocationId: basketUnit.sourceLocationId,
          updatedById: params.actorId ?? undefined,
        },
      });
      await tx.wmsBasketUnit.update({
        where: { id: basketUnit.id },
        data: {
          status: WmsBasketUnitStatus.REMOVED,
          removedById: params.actorId ?? undefined,
          removedAt: new Date(),
        },
      });
      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: params.tenantId,
          inventoryUnitId: basketUnit.inventoryUnitId,
          warehouseId: basketUnit.warehouseId,
          fromLocationId: null,
          toLocationId: basketUnit.sourceLocationId,
          fromStatus,
          toStatus: WmsInventoryUnitStatus.PUTAWAY,
          movementType: WmsInventoryMovementType.TRANSFER,
          referenceType: 'WMS_FULFILLMENT_AMENDMENT',
          referenceId: amendment.id,
          referenceCode: order.posOrderId,
          notes: `Returned after POS changed order ${order.posOrderId}`,
          actorId: params.actorId,
        },
      });

      const nextReturnActions = returnActions.map((action: any) => (
        action.variationId === basketUnit.variationId && action.quantity > 0
          ? { ...action, quantity: action.quantity - 1 }
          : action
      ));
      await tx.wmsFulfillmentAmendment.update({
        where: { id: amendment.id },
        data: {
          requiredActions: {
            ...actions,
            return: nextReturnActions,
          } as Prisma.InputJsonValue,
        },
      });
      const currentSummary = order.changeSummary && typeof order.changeSummary === 'object'
        && !Array.isArray(order.changeSummary)
        ? order.changeSummary as Record<string, unknown>
        : {};
      await tx.wmsFulfillmentOrder.update({
        where: { id: order.id },
        data: {
          changeSummary: {
            ...currentSummary,
            returnUnitsRemaining: nextReturnActions.reduce(
              (sum: number, action: any) => sum + Math.max(action.quantity ?? 0, 0),
              0,
            ),
          } as Prisma.InputJsonValue,
        },
      });

      return {
        unit: {
          id: basketUnit.inventoryUnit.id,
          code: basketUnit.inventoryUnit.code,
          variationId: basketUnit.variationId,
        },
      };
    });
    await this.resolveFulfillmentAmendmentIfComplete(params.fulfillmentOrderId);
    return result;
  }

  async resolveFulfillmentAmendmentIfComplete(fulfillmentOrderId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.wmsFulfillmentOrder.findUnique({
        where: { id: fulfillmentOrderId },
        include: {
          basketPickDemands: true,
          lines: {
            include: {
              reservations: {
                where: { status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] } },
              },
            },
          },
          amendments: {
            where: { status: WmsFulfillmentAmendmentStatus.OPEN },
            orderBy: { detectedAt: 'desc' },
            take: 1,
          },
        },
      });
      if (!order || order.changeState === WmsFulfillmentChangeState.NONE) {
        return false;
      }
      const amendment = order.amendments[0];
      if (!amendment) return false;
      const actions = amendment.requiredActions as any;
      const pendingReturns = Array.isArray(actions?.return)
        ? actions.return.reduce((sum: number, action: any) => sum + Math.max(action.quantity ?? 0, 0), 0)
        : 0;
      const pickComplete = order.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
        ? order.basketPickDemands.every(
            (demand) => demand.quantityPicked >= demand.quantityRequired,
          )
        : order.lines
            .filter((line) => (
              line.status !== WmsFulfillmentLineStatus.CANCELED
              && line.quantityRequired > 0
            ))
            .every((line) => (
              line.reservations.filter(
                (reservation) => reservation.status === WmsPickReservationStatus.PICKED,
              ).length >= line.quantityRequired
            ));
      if (pendingReturns > 0 || !pickComplete) {
        return false;
      }
      const isAttachedToActivePick = Boolean(order.basketId || order.claimedById);
      if (order.totalQuantity === 0 && isAttachedToActivePick) {
        // Keep the order in IN_PICKING with its amendment note until detached or voided from the basket.
        return false;
      }
      await tx.wmsFulfillmentAmendment.update({
        where: { id: amendment.id },
        data: { status: WmsFulfillmentAmendmentStatus.RESOLVED, resolvedAt: new Date() },
      });
      await tx.wmsFulfillmentOrder.update({
        where: { id: order.id },
        data: {
          changeState: WmsFulfillmentChangeState.NONE,
          ...(order.totalQuantity === 0
            ? {
                status: WmsFulfillmentOrderStatus.ISSUE,
                issueReason:
                  order.issueReason
                  ?? 'All pickable items were removed from this order in Pancake POS — no units remain to pick.',
              }
            : {}),
        },
      });
      return true;
    });
  }

  private async allocateFulfillmentOrderWithOptions(
    fulfillmentOrderId: string,
    actorId: string | null,
    options: {
      preferredWarehouseId: string | null;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const existingOrder = await tx.wmsFulfillmentOrder.findUnique({
        where: { id: fulfillmentOrderId },
        include: {
          posOrder: {
            select: {
              status: true,
              isVoid: true,
            },
          },
          lines: {
            include: {
              reservations: {
                where: {
                  status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
                },
              },
            },
          },
        },
      });

      const isEligiblePreShipPosStatus =
        existingOrder?.posOrder.status === CONFIRMED_POS_ORDER_STATUS
        || (AMENDABLE_POST_CONFIRM_POS_ORDER_STATUSES as readonly number[]).includes(
          existingOrder?.posOrder.status ?? -1,
        );
      if (
        !existingOrder
        || existingOrder.status === WmsFulfillmentOrderStatus.READY_FOR_PACK
        || existingOrder.status === WmsFulfillmentOrderStatus.PICKED
        || existingOrder.status === WmsFulfillmentOrderStatus.PACKING
        || existingOrder.status === WmsFulfillmentOrderStatus.PACKED
        || existingOrder.status === WmsFulfillmentOrderStatus.CANCELED
        || !isEligiblePreShipPosStatus
        || existingOrder.posOrder.isVoid
      ) {
        return;
      }

      if (existingOrder.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
        await this.refreshDemandFulfillmentOrderReadinessTx(tx, existingOrder.id, new Date());
        return;
      }

      const canonicalVariationIds = Array.from(new Set(
        existingOrder.lines.flatMap((line) => {
          const snapshot = this.asJsonRecord(line.lineSnapshot);
          const sourceVariationId = this.readString(snapshot?.sourceVariationId);
          return sourceVariationId ?? line.variationId;
        }),
      ));

      await this.reconcileLegacyFulfillmentLines(tx, {
        fulfillmentOrderId: existingOrder.id,
        canonicalVariationIds,
      });

      const anchoredWarehouseId = await this.resolveAllocationWarehouseId(tx, {
        fulfillmentOrderId: existingOrder.id,
        currentWarehouseId: existingOrder.warehouseId,
        preferredWarehouseId: options.preferredWarehouseId,
      });

      if (anchoredWarehouseId && anchoredWarehouseId !== existingOrder.warehouseId) {
        await tx.wmsFulfillmentOrder.update({
          where: { id: existingOrder.id },
          data: {
            warehouseId: anchoredWarehouseId,
          },
        });
      }

      const order = await tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: fulfillmentOrderId },
        include: {
          lines: {
            include: {
              reservations: {
                where: {
                  status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
                },
              },
            },
          },
        },
      });

      const poolIndex = await loadTenantStockPoolIndex(tx, order.tenantId);

      for (const line of order.lines) {
        if (line.quantityRequired <= 0 || line.status === WmsFulfillmentLineStatus.CANCELED) {
          continue;
        }

        const activeReservationCount = line.reservations.length;
        const missingQuantity = Math.max(line.quantityRequired - activeReservationCount, 0);

        if (missingQuantity <= 0) {
          if (line.issueReason) {
            await tx.wmsFulfillmentLine.update({
              where: { id: line.id },
              data: { issueReason: null },
            });
          }
          continue;
        }

        const availableUnits = await this.findAvailablePickUnitsForLine(tx, {
          order,
          variationId: line.variationId,
          take: missingQuantity,
          poolIndex,
        });
        const targetPoolMember = poolIndex.getTargetMember(order.storeId, line.variationId);

        if (!order.warehouseId && availableUnits.length > 0) {
          const anchorWarehouseId = availableUnits[0]?.warehouseId ?? null;
          if (anchorWarehouseId) {
            await tx.wmsFulfillmentOrder.update({
              where: { id: order.id },
              data: {
                warehouseId: anchorWarehouseId,
              },
            });
            order.warehouseId = anchorWarehouseId;
          }
        }

        for (const [index, unit] of availableUnits.entries()) {
          await tx.wmsPickReservation.upsert({
            where: {
              fulfillmentLineId_inventoryUnitId: {
                fulfillmentLineId: line.id,
                inventoryUnitId: unit.id,
              },
            },
            create: {
              fulfillmentOrderId: order.id,
              fulfillmentLineId: line.id,
              tenantId: order.tenantId,
              inventoryUnitId: unit.id,
              status: WmsPickReservationStatus.RESERVED,
              sequence: activeReservationCount + index + 1,
              reservedById: actorId,
              reservedAt: new Date(),
            },
            update: {
              status: WmsPickReservationStatus.RESERVED,
              sequence: activeReservationCount + index + 1,
              reservedById: actorId,
              reservedAt: new Date(),
              pickedById: null,
              pickedAt: null,
            },
          });

          const isPooledReassignment = Boolean(
            targetPoolMember
            && (unit.storeId !== targetPoolMember.storeId || unit.variationId !== targetPoolMember.variationId),
          );
          const isSameStoreVariantChange = Boolean(
            targetPoolMember && unit.storeId === targetPoolMember.storeId,
          );

          await tx.wmsInventoryUnit.update({
            where: { id: unit.id },
            data: {
              status: WmsInventoryUnitStatus.RESERVED,
              ...(isPooledReassignment && targetPoolMember
                ? {
                    storeId: targetPoolMember.storeId,
                    posProductId: targetPoolMember.posProductId,
                    productProfileId: targetPoolMember.profileId,
                    productId: targetPoolMember.productId,
                    variationId: targetPoolMember.variationId,
                    posWarehouseRef: isSameStoreVariantChange
                      ? null
                      : targetPoolMember.posWarehouseRef ?? null,
                  }
                : {}),
              updatedById: actorId || undefined,
            },
          });

          if (isPooledReassignment && targetPoolMember) {
            await tx.wmsInventoryMovement.create({
              data: {
                tenantId: unit.tenantId,
                inventoryUnitId: unit.id,
                warehouseId: unit.warehouseId,
                fromLocationId: unit.currentLocationId,
                toLocationId: unit.currentLocationId,
                fromStatus: unit.status,
                toStatus: unit.status,
                movementType: WmsInventoryMovementType.ADJUSTMENT,
                referenceType: 'SHARED_STOCK_POOL',
                referenceId: order.id,
                referenceCode: order.posOrderId,
                notes: `Auto-assigned from shared stock pool for order ${order.posOrderId}`,
                actorId,
              },
            });
          }

          await tx.wmsInventoryMovement.create({
            data: {
              tenantId: unit.tenantId,
              inventoryUnitId: unit.id,
              warehouseId: unit.warehouseId,
              fromLocationId: unit.currentLocationId,
              toLocationId: unit.currentLocationId,
              fromStatus: unit.status,
              toStatus: WmsInventoryUnitStatus.RESERVED,
              movementType: WmsInventoryMovementType.RESERVATION,
              referenceType: 'WMS_FULFILLMENT_ORDER',
              referenceId: order.id,
              referenceCode: order.posOrderId,
              notes: `STOX reserved for order ${order.posOrderId}`,
              actorId,
            },
          });
        }

        const remainingQuantity = missingQuantity - availableUnits.length;
        await tx.wmsFulfillmentLine.update({
          where: { id: line.id },
          data: {
            issueReason: remainingQuantity > 0
              ? await this.buildPickShortageReason(tx, {
                  order,
                  variationId: line.variationId,
                })
              : null,
          },
        });
      }

      await this.refreshFulfillmentOrderState(tx, order.id, new Date());
    });

    await this.wmsInventoryCogsService.syncPosOrderCogsFromMatchedInventoryUnits({
      fulfillmentOrderIds: [fulfillmentOrderId],
    });
  }

  private async findAvailablePickUnitsForLine(
    tx: Prisma.TransactionClient,
    params: {
      order: {
        tenantId: string;
        storeId: string;
        warehouseId: string | null;
        posWarehouseRef: string | null;
      };
      variationId: string;
      take: number;
      poolIndex?: TenantStockPoolIndex;
    },
  ) {
    const baseWhere: Prisma.WmsInventoryUnitWhereInput = {
      tenantId: params.order.tenantId,
      storeId: params.order.storeId,
      ...(params.order.warehouseId ? { warehouseId: params.order.warehouseId } : {}),
      variationId: params.variationId,
      status: {
        in: [...FULFILLABLE_UNIT_STATUSES],
      },
      AND: [buildUnexpiredInventoryWhere()],
      currentLocation: {
        is: {
          kind: WmsLocationKind.BIN,
        },
      },
      pickReservations: {
        none: {
          status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
        },
      },
      basketUnits: {
        none: {
          status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] },
        },
      },
    };
    const select = {
      id: true,
      tenantId: true,
      storeId: true,
      variationId: true,
      warehouseId: true,
      currentLocationId: true,
      status: true,
      code: true,
    } satisfies Prisma.WmsInventoryUnitSelect;
    const orderBy = [
      ...(params.order.warehouseId ? [] : [{ warehouseId: 'asc' as const }]),
      { expirationDate: 'asc' as const },
      { updatedAt: 'asc' as const },
      { code: 'asc' as const },
    ];

    let directUnits: Array<{
      id: string;
      tenantId: string;
      storeId: string;
      variationId: string;
      warehouseId: string;
      currentLocationId: string | null;
      status: WmsInventoryUnitStatus;
      code: string;
    }> = [];

    if (!params.order.posWarehouseRef) {
      const candidates = await tx.wmsInventoryUnit.findMany({
        where: baseWhere,
        select,
        orderBy,
        take: params.order.warehouseId ? params.take : Math.max(params.take, 50),
      });

      directUnits = this.limitUnitsToAnchorWarehouse(candidates, params.take, params.order.warehouseId);
    } else {
      const exactCandidates = await tx.wmsInventoryUnit.findMany({
        where: {
          ...baseWhere,
          posWarehouseRef: params.order.posWarehouseRef,
        },
        select,
        orderBy,
        take: params.order.warehouseId ? params.take : Math.max(params.take, 50),
      });
      const anchoredWarehouseId = params.order.warehouseId ?? exactCandidates[0]?.warehouseId ?? null;
      const exactUnits = this.limitUnitsToAnchorWarehouse(exactCandidates, params.take, anchoredWarehouseId);

      const remainingQuantity = params.take - exactUnits.length;
      if (remainingQuantity <= 0) {
        return exactUnits;
      }

      const fallbackUnits = await tx.wmsInventoryUnit.findMany({
        where: {
          ...baseWhere,
          ...(anchoredWarehouseId ? { warehouseId: anchoredWarehouseId } : {}),
          posWarehouseRef: null,
          id: {
            notIn: exactUnits.map((unit) => unit.id),
          },
        },
        select,
        orderBy,
        take: remainingQuantity,
      });

      directUnits = [...exactUnits, ...fallbackUnits];
    }

    const missingAfterDirect = params.take - directUnits.length;
    const poolIndex = params.poolIndex ?? await loadTenantStockPoolIndex(tx, params.order.tenantId);
    const poolMembers = poolIndex.getPoolMembers(params.order.storeId, params.variationId);
    if (missingAfterDirect <= 0 || poolMembers.length < 2) {
      return directUnits;
    }

    const anchoredWarehouseId = params.order.warehouseId ?? directUnits[0]?.warehouseId ?? null;
    const pooledCandidates = await tx.wmsInventoryUnit.findMany({
      where: {
        tenantId: params.order.tenantId,
        ...(anchoredWarehouseId ? { warehouseId: anchoredWarehouseId } : {}),
        OR: poolMembers.map((member) => ({
          storeId: member.storeId,
          variationId: member.variationId,
        })),
        ...(directUnits.length > 0
          ? {
              id: {
                notIn: directUnits.map((unit) => unit.id),
              },
            }
          : {}),
        status: {
          in: [...FULFILLABLE_UNIT_STATUSES],
        },
        AND: [buildUnexpiredInventoryWhere()],
        currentLocation: {
          is: {
            kind: WmsLocationKind.BIN,
          },
        },
        pickReservations: {
          none: {
            status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
          },
        },
        basketUnits: {
          none: {
            status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] },
          },
        },
      },
      select,
      orderBy,
      take: anchoredWarehouseId ? missingAfterDirect : Math.max(missingAfterDirect, 50),
    });

    const pooledUnits = this.limitUnitsToAnchorWarehouse(
      pooledCandidates,
      missingAfterDirect,
      anchoredWarehouseId,
    );

    return [...directUnits, ...pooledUnits];
  }

  private async buildPickShortageReason(
    tx: Prisma.TransactionClient,
    params: {
      order: {
        tenantId: string;
        storeId: string;
        warehouseId: string | null;
        posWarehouseRef: string | null;
      };
      variationId: string;
    },
  ) {
    const identityWhere: Prisma.WmsInventoryUnitWhereInput = {
      tenantId: params.order.tenantId,
      storeId: params.order.storeId,
      variationId: params.variationId,
    };
    const warehouseScopedIdentityWhere: Prisma.WmsInventoryUnitWhereInput = {
      ...identityWhere,
      ...(params.order.warehouseId ? { warehouseId: params.order.warehouseId } : {}),
    };
    const putawayWhere: Prisma.WmsInventoryUnitWhereInput = {
      ...warehouseScopedIdentityWhere,
      status: {
        in: [...FULFILLABLE_UNIT_STATUSES],
      },
      AND: [buildUnexpiredInventoryWhere()],
    };
    const binnedWhere: Prisma.WmsInventoryUnitWhereInput = {
      ...putawayWhere,
      currentLocation: {
        is: {
          kind: WmsLocationKind.BIN,
        },
      },
    };
    const unreservedWhere: Prisma.WmsInventoryUnitWhereInput = {
      ...binnedWhere,
      pickReservations: {
        none: {
          status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
        },
      },
      basketUnits: {
        none: {
          status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] },
        },
      },
    };
    const scopedWhere: Prisma.WmsInventoryUnitWhereInput = params.order.posWarehouseRef
      ? {
          ...unreservedWhere,
          OR: [
            { posWarehouseRef: params.order.posWarehouseRef },
            { posWarehouseRef: null },
          ],
        }
      : unreservedWhere;

    const [matchingUnits, warehouseMatchingUnits, putawayUnits, binnedUnits, freeBinnedUnits, scopedUnits] = await Promise.all([
      tx.wmsInventoryUnit.count({ where: identityWhere }),
      tx.wmsInventoryUnit.count({ where: warehouseScopedIdentityWhere }),
      tx.wmsInventoryUnit.count({ where: putawayWhere }),
      tx.wmsInventoryUnit.count({ where: binnedWhere }),
      tx.wmsInventoryUnit.count({ where: unreservedWhere }),
      tx.wmsInventoryUnit.count({ where: scopedWhere }),
    ]);

    if (matchingUnits === 0) {
      return 'No WMS units match this order item for this store.';
    }

    if (params.order.warehouseId && warehouseMatchingUnits === 0) {
      return 'Matching units exist, but not in the warehouse assigned to this order.';
    }

    if (putawayUnits === 0) {
      return 'Matching units exist but are not put away yet.';
    }

    if (binnedUnits === 0) {
      return 'Matching units are put away but not inside a bin.';
    }

    if (freeBinnedUnits === 0) {
      return 'Matching binned units are already reserved for another order.';
    }

    if (params.order.posWarehouseRef && scopedUnits === 0) {
      return 'Matching units are in a different POS warehouse scope.';
    }

    return 'No eligible unit is available for reservation.';
  }

  private async reconcileLegacyFulfillmentLines(
    tx: Prisma.TransactionClient,
    params: {
      fulfillmentOrderId: string;
      canonicalVariationIds: string[];
    },
  ) {
    const order = await tx.wmsFulfillmentOrder.findUnique({
      where: { id: params.fulfillmentOrderId },
      select: {
        warehouseId: true,
      },
    });

    const lines = await tx.wmsFulfillmentLine.findMany({
      where: {
        fulfillmentOrderId: params.fulfillmentOrderId,
      },
      select: {
        id: true,
        variationId: true,
        lineSnapshot: true,
        reservations: {
          where: {
            status: {
              in: [...ACTIVE_PICK_RESERVATION_STATUSES],
            },
          },
          select: {
            id: true,
            inventoryUnitId: true,
            inventoryUnit: {
              select: {
                warehouseId: true,
              },
            },
          },
        },
      },
    });

    const canonicalSet = new Set(params.canonicalVariationIds);
    const lineByVariationId = new Map(lines.map((line) => [line.variationId, line]));
    let resolvedWarehouseId = order?.warehouseId ?? null;

    for (const line of lines) {
      const snapshot = this.asJsonRecord(line.lineSnapshot);
      const sourceVariationId = this.readIdentifier(snapshot?.sourceVariationId);

      if (!sourceVariationId || sourceVariationId === line.variationId || !canonicalSet.has(sourceVariationId)) {
        continue;
      }

      const canonicalLine = lineByVariationId.get(sourceVariationId);
      if (!canonicalLine || canonicalLine.id === line.id) {
        continue;
      }

      const canonicalReservationUnitIds = new Set(
        canonicalLine.reservations.map((reservation) => reservation.inventoryUnitId),
      );

      for (const reservation of line.reservations) {
        if (!resolvedWarehouseId && reservation.inventoryUnit.warehouseId) {
          resolvedWarehouseId = reservation.inventoryUnit.warehouseId;
        }

        if (canonicalReservationUnitIds.has(reservation.inventoryUnitId)) {
          await tx.wmsPickReservation.update({
            where: { id: reservation.id },
            data: {
              status: WmsPickReservationStatus.CANCELED,
            },
          });
          continue;
        }

        await tx.wmsPickReservation.update({
          where: { id: reservation.id },
          data: {
            fulfillmentLineId: canonicalLine.id,
          },
        });
        canonicalReservationUnitIds.add(reservation.inventoryUnitId);
      }

      await tx.wmsFulfillmentLine.update({
        where: { id: line.id },
        data: {
          status: WmsFulfillmentLineStatus.CANCELED,
          quantityRequired: 0,
          quantityAllocated: 0,
          quantityPicked: 0,
          issueReason: null,
        },
      });
    }

    if (resolvedWarehouseId && resolvedWarehouseId !== order?.warehouseId) {
      await tx.wmsFulfillmentOrder.update({
        where: { id: params.fulfillmentOrderId },
        data: {
          warehouseId: resolvedWarehouseId,
        },
      });
    }
  }

  private limitUnitsToAnchorWarehouse<
    TUnit extends {
      warehouseId: string;
    },
  >(units: TUnit[], take: number, warehouseId: string | null) {
    const anchorWarehouseId = warehouseId ?? units[0]?.warehouseId ?? null;
    if (!anchorWarehouseId) {
      return units.slice(0, take);
    }

    return units
      .filter((unit) => unit.warehouseId === anchorWarehouseId)
      .slice(0, take);
  }

  private async resolveAllocationWarehouseId(
    tx: Prisma.TransactionClient,
    params: {
      fulfillmentOrderId: string;
      currentWarehouseId: string | null;
      preferredWarehouseId: string | null;
    },
  ) {
    if (params.currentWarehouseId) {
      return params.currentWarehouseId;
    }

    const reservationWarehouses = await tx.wmsPickReservation.findMany({
      where: {
        fulfillmentOrderId: params.fulfillmentOrderId,
        status: {
          in: [...ACTIVE_PICK_RESERVATION_STATUSES],
        },
      },
      select: {
        inventoryUnit: {
          select: {
            warehouseId: true,
          },
        },
      },
    });

    const uniqueReservationWarehouses = Array.from(new Set(
      reservationWarehouses.map((reservation) => reservation.inventoryUnit.warehouseId),
    ));

    if (uniqueReservationWarehouses.length === 1) {
      return uniqueReservationWarehouses[0] ?? null;
    }

    if (uniqueReservationWarehouses.length > 1) {
      return null;
    }

    return params.preferredWarehouseId;
  }

  private async refreshFulfillmentOrderState(
    tx: Prisma.TransactionClient,
    fulfillmentOrderId: string,
    now: Date,
  ) {
    const order = await tx.wmsFulfillmentOrder.findUnique({
      where: { id: fulfillmentOrderId },
      include: {
        lines: {
          include: {
            reservations: {
              where: {
                status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
              },
            },
          },
        },
      },
    });

    if (!order) {
      return;
    }

    let totalQuantity = 0;
    let allocatedQuantity = 0;
    let pickedQuantity = 0;
    let hasIssue = false;
    const evaluatedLines: Array<{
      productName: string;
      status: WmsFulfillmentLineStatus;
      issueReason: string | null;
    }> = [];

    for (const line of order.lines) {
      if (line.status === WmsFulfillmentLineStatus.CANCELED) {
        if (line.quantityAllocated !== 0 || line.quantityPicked !== 0 || line.issueReason) {
          await tx.wmsFulfillmentLine.update({
            where: { id: line.id },
            data: {
              quantityAllocated: 0,
              quantityPicked: 0,
              issueReason: null,
            },
          });
        }
        continue;
      }

      const required = Math.max(line.quantityRequired, 0);
      const allocated = line.reservations.length;
      const picked = line.reservations.filter((reservation) => reservation.status === WmsPickReservationStatus.PICKED).length;
      if (required <= 0 && allocated === 0 && picked === 0) {
        await tx.wmsFulfillmentLine.update({
          where: { id: line.id },
          data: {
            quantityAllocated: 0,
            quantityPicked: 0,
            status: WmsFulfillmentLineStatus.CANCELED,
            issueReason: null,
          },
        });
        continue;
      }

      const nextLineStatus = this.resolveFulfillmentLineStatus(required, allocated, picked, line.status);
      const nextLineIssueReason = nextLineStatus === WmsFulfillmentLineStatus.READY
        || nextLineStatus === WmsFulfillmentLineStatus.PICKED
        ? null
        : required <= 0
          ? 'Picked or reserved units remain on a removed order item — return units to bin to continue.'
          : line.issueReason;

      totalQuantity += required;
      allocatedQuantity += Math.min(allocated, required);
      pickedQuantity += Math.min(picked, required);
      hasIssue = hasIssue || nextLineStatus === WmsFulfillmentLineStatus.ISSUE;
      evaluatedLines.push({
        productName: line.productName,
        status: nextLineStatus,
        issueReason: nextLineIssueReason,
      });

      await tx.wmsFulfillmentLine.update({
        where: { id: line.id },
        data: {
          quantityAllocated: Math.min(allocated, required),
          quantityPicked: Math.min(picked, required),
          status: nextLineStatus,
          issueReason: nextLineIssueReason,
        },
      });
    }

    const nextOrderStatus = this.resolveFulfillmentOrderStatus({
      currentStatus: order.status,
      claimedById: order.claimedById,
      basketId: order.basketId,
      totalQuantity,
      allocatedQuantity,
      pickedQuantity,
      hasIssue,
    });

    await tx.wmsFulfillmentOrder.update({
      where: { id: order.id },
      data: {
        totalQuantity,
        allocatedQuantity,
        pickedQuantity,
        status: nextOrderStatus,
        completedAt: nextOrderStatus === WmsFulfillmentOrderStatus.READY_FOR_PACK
          ? order.completedAt ?? now
          : null,
        issueReason: this.resolveOrderIssueReason({
          nextOrderStatus,
          totalQuantity,
          existingIssueReason: order.issueReason,
          lines: evaluatedLines,
        }),
      },
    });
  }

  private async refreshDemandBasketStateTx(
    tx: Prisma.TransactionClient,
    basketId: string,
    now: Date,
  ) {
    const basket = await tx.wmsBasket.findUnique({
      where: { id: basketId },
      select: {
        id: true,
        status: true,
        assignedPackerId: true,
        fullAt: true,
        readyForPackAt: true,
        fulfillmentOrders: {
          where: {
            status: {
              in: [...ACTIVE_BASKET_ORDER_STATUSES],
            },
          },
          select: {
            id: true,
            status: true,
            pickedQuantity: true,
            tenantId: true,
            claimedById: true,
          },
          orderBy: [
            { updatedAt: 'desc' },
            { createdAt: 'desc' },
          ],
        },
      },
    });

    if (!basket) {
      return;
    }

    const activeOrders = basket.fulfillmentOrders;
    if (activeOrders.length === 0) {
      await tx.wmsBasket.update({
        where: { id: basket.id },
        data: {
          tenantId: null,
          status: WmsBasketStatus.AVAILABLE,
          assignedPickerId: null,
          assignedPackerId: null,
          fulfillmentOrderId: null,
          claimedAt: null,
          fullAt: null,
          readyForPackAt: null,
        },
      });
      return;
    }

    const hasPackingOrder = activeOrders.some((order) => order.status === WmsFulfillmentOrderStatus.PACKING);
    const allReadyForPack = activeOrders.every((order) => (
      order.status === WmsFulfillmentOrderStatus.READY_FOR_PACK
      || order.status === WmsFulfillmentOrderStatus.PICKED
    ));
    const hasPickedWork = activeOrders.some((order) => (
      order.pickedQuantity > 0
      || order.status === WmsFulfillmentOrderStatus.IN_PICKING
    ));
    const activeTenantIds = Array.from(new Set(activeOrders.map((order) => order.tenantId)));
    const nextStatus = hasPackingOrder
      ? WmsBasketStatus.PACKING
      : allReadyForPack
        ? WmsBasketStatus.FULL_HELD
        : hasPickedWork
          ? WmsBasketStatus.IN_PICKING
          : WmsBasketStatus.ASSIGNED;

    await tx.wmsBasket.update({
      where: { id: basket.id },
      data: {
        tenantId: activeTenantIds.length === 1 ? activeTenantIds[0] : null,
        status: nextStatus,
        assignedPickerId: activeOrders[0]?.claimedById ?? null,
        assignedPackerId: nextStatus === WmsBasketStatus.FULL_HELD || nextStatus === WmsBasketStatus.PACKING
          ? basket.assignedPackerId
          : null,
        fullAt: nextStatus === WmsBasketStatus.FULL_HELD || nextStatus === WmsBasketStatus.PACKING
          ? basket.fullAt ?? now
          : null,
        readyForPackAt: nextStatus === WmsBasketStatus.FULL_HELD || nextStatus === WmsBasketStatus.PACKING
          ? basket.readyForPackAt ?? now
          : null,
      },
    });
  }

  private async refreshDemandFulfillmentOrderReadiness(fulfillmentOrderId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.refreshDemandFulfillmentOrderReadinessTx(tx, fulfillmentOrderId, new Date());
    });
  }

  private async refreshDemandFulfillmentOrderReadinessTx(
    tx: Prisma.TransactionClient,
    fulfillmentOrderId: string,
    now: Date,
    options?: {
      order?: DemandFulfillmentReadinessRecord | null;
      poolIndex?: TenantStockPoolIndex;
      virtualAllocatedByWarehouseVariation?: Map<string, number>;
      accumulateVirtualAllocation?: boolean;
      allocationMode?: 'COMPLETE_ONLY' | 'ALLOW_PARTIAL';
    },
  ) {
    const order = options?.order ?? await tx.wmsFulfillmentOrder.findUnique({
      where: { id: fulfillmentOrderId },
      include: {
        posOrder: {
          select: {
            status: true,
            isVoid: true,
            dateLocal: true,
          },
        },
        lines: true,
      },
    });

    const isEligiblePreShipPosStatus =
      order?.posOrder.status === CONFIRMED_POS_ORDER_STATUS
      || (AMENDABLE_POST_CONFIRM_POS_ORDER_STATUSES as readonly number[]).includes(
        order?.posOrder.status ?? -1,
      );
    if (
      !order
      || order.assignmentMode !== WmsFulfillmentAssignmentMode.BASKET_DEMAND
      || order.status === WmsFulfillmentOrderStatus.READY_FOR_PACK
      || order.status === WmsFulfillmentOrderStatus.PICKED
      || order.status === WmsFulfillmentOrderStatus.PACKING
      || order.status === WmsFulfillmentOrderStatus.PACKED
      || order.status === WmsFulfillmentOrderStatus.CANCELED
      || Boolean(order.basketId)
      || !isEligiblePreShipPosStatus
      || order.posOrder.isVoid
    ) {
      return;
    }

    const poolIndex = options?.poolIndex ?? await loadTenantStockPoolIndex(tx, order.tenantId);
    const warehouseLocked = this.isDemandWarehouseLocked(order) && Boolean(order.warehouseId);
    const lockedWarehouseId = warehouseLocked ? order.warehouseId : null;
    let totalQuantity = 0;
    let allocatedQuantity = 0;
    let pickedQuantity = 0;
    let hasIssue = false;
    const candidateWarehouseIds = new Set<string>();
    const eligibleLines: Array<{
      id: string;
      variationId: string;
      productName: string;
      required: number;
      availabilityByWarehouse: Map<string, number>;
      totalAvailableAcrossWarehouses: number;
    }> = [];

    for (const line of order.lines) {
      if (line.status === WmsFulfillmentLineStatus.CANCELED) {
        if (line.quantityAllocated !== 0 || line.quantityPicked !== 0 || line.issueReason) {
          await tx.wmsFulfillmentLine.update({
            where: { id: line.id },
            data: {
              quantityAllocated: 0,
              quantityPicked: 0,
              issueReason: null,
            },
          });
        }
        continue;
      }

      const required = Math.max(line.quantityRequired, 0);
      if (required <= 0) {
        await tx.wmsFulfillmentLine.update({
          where: { id: line.id },
          data: {
            quantityAllocated: 0,
            quantityPicked: 0,
            status: WmsFulfillmentLineStatus.CANCELED,
            issueReason: null,
          },
        });
        continue;
      }

      let availabilityByWarehouse = await this.listDemandAvailableQuantityByWarehouse(tx, {
        tenantId: order.tenantId,
        storeId: order.storeId,
        warehouseId: lockedWarehouseId,
        posWarehouseRef: order.posWarehouseRef,
        variationId: line.variationId,
        excludeFulfillmentOrderId: order.id,
        poolIndex,
      });
      if (options?.virtualAllocatedByWarehouseVariation && options.virtualAllocatedByWarehouseVariation.size > 0) {
        const adjustedAvailability = new Map<string, number>();
        for (const [warehouseId, availableQuantity] of availabilityByWarehouse.entries()) {
          const virtualAllocated = options.virtualAllocatedByWarehouseVariation.get(
            this.buildDemandWarehouseVariationKey(
              warehouseId,
              line.variationId,
              order.storeId,
              poolIndex,
            ),
          ) ?? 0;
          const nextAvailable = Math.max(availableQuantity - virtualAllocated, 0);
          if (nextAvailable > 0) {
            adjustedAvailability.set(warehouseId, nextAvailable);
          }
        }
        availabilityByWarehouse = adjustedAvailability;
      }
      for (const warehouseId of availabilityByWarehouse.keys()) {
        candidateWarehouseIds.add(warehouseId);
      }

      eligibleLines.push({
        id: line.id,
        variationId: line.variationId,
        productName: line.productName,
        required,
        availabilityByWarehouse,
        totalAvailableAcrossWarehouses: Array.from(availabilityByWarehouse.values())
          .reduce((sum, quantity) => sum + quantity, 0),
      });
    }

    if (lockedWarehouseId) {
      candidateWarehouseIds.add(lockedWarehouseId);
    }

    let selectedWarehouseId: string | null = lockedWarehouseId;
    const allocatedByLineId = new Map<string, number>();
    const candidateList = Array.from(candidateWarehouseIds.values());

    for (const warehouseId of candidateList) {
      let totalAllocatedForWarehouse = 0;
      let coveredLineCount = 0;
      let fullyReady = true;
      const lineAllocations = new Map<string, number>();

      for (const line of eligibleLines) {
        const availableInWarehouse = line.availabilityByWarehouse.get(warehouseId) ?? 0;
        const allocated = Math.min(availableInWarehouse, line.required);
        lineAllocations.set(line.id, allocated);
        totalAllocatedForWarehouse += allocated;
        if (allocated > 0) {
          coveredLineCount += 1;
        }
        if (allocated < line.required) {
          fullyReady = false;
        }
      }

      const currentTotalAllocated = Array.from(allocatedByLineId.values())
        .reduce((sum, quantity) => sum + quantity, 0);
      const currentCoveredLineCount = eligibleLines.reduce((sum, line) => (
        sum + ((allocatedByLineId.get(line.id) ?? 0) > 0 ? 1 : 0)
      ), 0);
      const currentFullyReady = eligibleLines.length > 0
        && eligibleLines.every((line) => (allocatedByLineId.get(line.id) ?? 0) >= line.required);

      const shouldReplaceSelection = selectedWarehouseId === null
        || Number(fullyReady) > Number(currentFullyReady)
        || (
          fullyReady === currentFullyReady
          && totalAllocatedForWarehouse > currentTotalAllocated
        )
        || (
          fullyReady === currentFullyReady
          && totalAllocatedForWarehouse === currentTotalAllocated
          && coveredLineCount > currentCoveredLineCount
        )
        || (
          fullyReady === currentFullyReady
          && totalAllocatedForWarehouse === currentTotalAllocated
          && coveredLineCount === currentCoveredLineCount
          && selectedWarehouseId !== null
          && warehouseId.localeCompare(selectedWarehouseId) < 0
        );

      if (shouldReplaceSelection) {
        selectedWarehouseId = warehouseId;
        allocatedByLineId.clear();
        for (const [lineId, quantity] of lineAllocations.entries()) {
          allocatedByLineId.set(lineId, quantity);
        }
      }
    }

    const selectedAllocationByLineId = hasIssue
      ? new Map(eligibleLines.map((line) => [line.id, 0]))
      : options?.allocationMode === 'ALLOW_PARTIAL'
        ? normalizeDemandAllocation(eligibleLines, allocatedByLineId)
        : finalizeCompleteDemandAllocation(eligibleLines, allocatedByLineId);
    const orderIsFullyAllocatable = !hasIssue
      && eligibleLines.length > 0
      && eligibleLines.every((line) => (
        (selectedAllocationByLineId.get(line.id) ?? 0) >= line.required
      ));

    const evaluatedDemandLines: Array<{
      productName: string;
      status: WmsFulfillmentLineStatus;
      issueReason: string | null;
    }> = [];

    for (const line of order.lines) {
      if (line.status === WmsFulfillmentLineStatus.CANCELED) {
        continue;
      }

      const required = Math.max(line.quantityRequired, 0);
      if (required <= 0) {
        continue;
      }

      const eligibleLine = eligibleLines.find((entry) => entry.id === line.id);
      const nextAllocated = Math.min(selectedAllocationByLineId.get(line.id) ?? 0, required);
      const nextLineStatus = this.resolveFulfillmentLineStatus(required, nextAllocated, 0, line.status);

      totalQuantity += required;
      allocatedQuantity += nextAllocated;
      hasIssue = hasIssue || nextLineStatus === WmsFulfillmentLineStatus.ISSUE;

      const availableInSelectedWarehouse = selectedWarehouseId && eligibleLine
        ? eligibleLine.availabilityByWarehouse.get(selectedWarehouseId) ?? 0
        : 0;
      const nextLineIssueReason = nextLineStatus === WmsFulfillmentLineStatus.READY
        ? null
        : !orderIsFullyAllocatable && availableInSelectedWarehouse >= required
          ? 'Stock is available for this item, but the complete order cannot be fulfilled yet.'
          : this.buildDemandAvailabilityIssueReason({
              required,
              availableInSelectedWarehouse,
              totalAvailableAcrossWarehouses: eligibleLine?.totalAvailableAcrossWarehouses ?? 0,
              warehouseLocked,
            });
      evaluatedDemandLines.push({
        productName: line.productName,
        status: nextLineStatus,
        issueReason: nextLineIssueReason,
      });

      await tx.wmsFulfillmentLine.update({
        where: { id: line.id },
        data: {
          quantityAllocated: nextAllocated,
          quantityPicked: 0,
          status: nextLineStatus,
          issueReason: nextLineIssueReason,
        },
      });
    }

    const nextOrderStatus = this.resolveFulfillmentOrderStatus({
      currentStatus: order.status,
      claimedById: order.claimedById,
      basketId: order.basketId,
      totalQuantity,
      allocatedQuantity,
      pickedQuantity,
      hasIssue,
    });

    await tx.wmsFulfillmentOrder.update({
      where: { id: order.id },
      data: {
        warehouseId: warehouseLocked ? order.warehouseId : null,
        totalQuantity,
        allocatedQuantity,
        pickedQuantity,
        status: nextOrderStatus,
        completedAt: null,
        issueReason: this.resolveOrderIssueReason({
          nextOrderStatus,
          totalQuantity,
          existingIssueReason: order.issueReason,
          lines: evaluatedDemandLines,
        }),
      },
    });

    if (
      options?.accumulateVirtualAllocation
      && options.virtualAllocatedByWarehouseVariation
      && !warehouseLocked
      && selectedWarehouseId
    ) {
      for (const line of eligibleLines) {
        const allocated = Math.min(selectedAllocationByLineId.get(line.id) ?? 0, line.required);
        if (allocated <= 0) {
          continue;
        }

        const key = this.buildDemandWarehouseVariationKey(
          selectedWarehouseId,
          line.variationId,
          order.storeId,
          poolIndex,
        );
        options.virtualAllocatedByWarehouseVariation.set(
          key,
          (options.virtualAllocatedByWarehouseVariation.get(key) ?? 0) + allocated,
        );
      }
    }

    return {
      isFullyAllocated: orderIsFullyAllocatable,
      allocatedQuantity,
      totalQuantity,
    };
  }

  private buildDemandWarehouseVariationKey(
    warehouseId: string,
    variationId: string,
    storeId?: string,
    poolIndex: TenantStockPoolIndex = EMPTY_STOCK_POOL_INDEX,
  ) {
    if (storeId && poolIndex.hasAnyPools) {
      return poolIndex.buildWarehouseAllocationKey(warehouseId, storeId, variationId);
    }
    return `${warehouseId}::${variationId}`;
  }

  private isDemandWarehouseLocked(order: {
    basketId: string | null;
    status: WmsFulfillmentOrderStatus;
  }) {
    return Boolean(order.basketId)
      || order.status === WmsFulfillmentOrderStatus.IN_PICKING
      || order.status === WmsFulfillmentOrderStatus.READY_FOR_PACK
      || order.status === WmsFulfillmentOrderStatus.PICKED
      || order.status === WmsFulfillmentOrderStatus.PACKING
      || order.status === WmsFulfillmentOrderStatus.PACKED;
  }

  private buildDemandAvailabilityIssueReason(params: {
    required: number;
    availableInSelectedWarehouse: number;
    totalAvailableAcrossWarehouses: number;
    warehouseLocked: boolean;
  }) {
    if (params.warehouseLocked) {
      if (params.totalAvailableAcrossWarehouses <= 0) {
        return 'No eligible unit is currently available in the assigned warehouse.';
      }

      if (params.availableInSelectedWarehouse <= 0) {
        return 'Matching units exist in other warehouses, but not in the assigned warehouse.';
      }

      return `Only ${params.availableInSelectedWarehouse} of ${params.required} units are currently available in the assigned warehouse.`;
    }

    if (params.totalAvailableAcrossWarehouses <= 0) {
      return 'No eligible unit is currently available in any warehouse.';
    }

    if (params.availableInSelectedWarehouse <= 0) {
      return 'Stock exists, but no single warehouse can fulfill this order yet.';
    }

    return `Only ${params.availableInSelectedWarehouse} of ${params.required} units are currently available together in one warehouse.`;
  }

  private async listDemandAvailableQuantityByWarehouse(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      storeId: string;
      warehouseId: string | null;
      posWarehouseRef: string | null;
      variationId: string;
      excludeFulfillmentOrderId?: string | null;
      poolIndex?: TenantStockPoolIndex;
    },
  ) {
    const poolIndex = params.poolIndex ?? await loadTenantStockPoolIndex(tx, params.tenantId);
    const [freeUnitGroups, heldBins] = await Promise.all([
      tx.wmsInventoryUnit.groupBy({
        by: ['warehouseId'],
        where: this.buildFreeDemandPickUnitWhere({
          ...params,
          poolIndex,
        }),
        _count: {
          _all: true,
        },
      }),
      tx.wmsBasketPickDemandBin.findMany({
        where: poolIndex.buildPooledDemandBinHoldWhere({
          tenantId: params.tenantId,
          storeId: params.storeId,
          variationId: params.variationId,
          warehouseId: params.warehouseId,
          basketStatuses: ACTIVE_DEMAND_BASKET_STATUSES,
          orderStatuses: ACTIVE_BASKET_ORDER_STATUSES,
          excludeFulfillmentOrderId: params.excludeFulfillmentOrderId,
        }),
        select: {
          warehouseId: true,
          quantityTarget: true,
          quantityPicked: true,
        },
      }),
    ]);

    const availableByWarehouse = new Map<string, number>();
    for (const group of freeUnitGroups) {
      availableByWarehouse.set(group.warehouseId, group._count._all);
    }

    for (const hold of heldBins) {
      const nextAvailable = Math.max(
        (availableByWarehouse.get(hold.warehouseId) ?? 0)
          - Math.max((hold.quantityTarget ?? 0) - (hold.quantityPicked ?? 0), 0),
        0,
      );
      if (nextAvailable > 0) {
        availableByWarehouse.set(hold.warehouseId, nextAvailable);
      } else {
        availableByWarehouse.delete(hold.warehouseId);
      }
    }

    return availableByWarehouse;
  }

  private async countFreeDemandPickUnits(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      storeId: string;
      warehouseId: string | null;
      posWarehouseRef: string | null;
      variationId: string;
      poolIndex?: TenantStockPoolIndex;
    },
  ) {
    const poolIndex = params.poolIndex ?? await loadTenantStockPoolIndex(tx, params.tenantId);
    return tx.wmsInventoryUnit.count({
      where: this.buildFreeDemandPickUnitWhere({
        ...params,
        poolIndex,
      }),
    });
  }

  private buildFreeDemandPickUnitWhere(params: {
    tenantId: string;
    storeId: string;
    warehouseId: string | null;
    posWarehouseRef: string | null;
    variationId: string;
    poolIndex?: TenantStockPoolIndex;
  }): Prisma.WmsInventoryUnitWhereInput {
    const poolIndex = params.poolIndex ?? EMPTY_STOCK_POOL_INDEX;
    const identityFilter = poolIndex.buildPooledUnitIdentityFilter({
      storeId: params.storeId,
      variationId: params.variationId,
      posWarehouseRef: params.posWarehouseRef,
      applyPosWarehouseFilterWhenUnpooled: true,
    });
    return {
      tenantId: params.tenantId,
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...identityFilter,
      status: {
        in: [...FULFILLABLE_UNIT_STATUSES],
      },
      AND: [buildUnexpiredInventoryWhere()],
      currentLocation: {
        is: {
          kind: WmsLocationKind.BIN,
          isActive: true,
        },
      },
      pickReservations: {
        none: {
          status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
        },
      },
      basketUnits: {
        none: {
          status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] },
        },
      },
    };
  }

  private async countActiveDemandHeldQuantity(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      storeId: string;
      warehouseId: string | null;
      variationId: string;
      locationId?: string | null;
      excludeFulfillmentOrderId?: string | null;
      poolIndex?: TenantStockPoolIndex;
    },
  ) {
    const poolIndex = params.poolIndex ?? await loadTenantStockPoolIndex(tx, params.tenantId);
    const holds = await tx.wmsBasketPickDemandBin.findMany({
      where: poolIndex.buildPooledDemandBinHoldWhere({
        tenantId: params.tenantId,
        storeId: params.storeId,
        variationId: params.variationId,
        warehouseId: params.warehouseId,
        locationId: params.locationId,
        basketStatuses: ACTIVE_DEMAND_BASKET_STATUSES,
        orderStatuses: [
          WmsFulfillmentOrderStatus.IN_PICKING,
          WmsFulfillmentOrderStatus.READY_FOR_PACK,
          WmsFulfillmentOrderStatus.PICKED,
        ],
        excludeFulfillmentOrderId: params.excludeFulfillmentOrderId,
      }),
      select: {
        quantityTarget: true,
        quantityPicked: true,
      },
    });

    return holds.reduce((sum, hold) => (
      sum + Math.max((hold.quantityTarget ?? 0) - (hold.quantityPicked ?? 0), 0)
    ), 0);
  }

  private resolveFulfillmentLineStatus(
    required: number,
    allocated: number,
    picked: number,
    currentStatus: WmsFulfillmentLineStatus,
  ) {
    if (currentStatus === WmsFulfillmentLineStatus.CANCELED) {
      return WmsFulfillmentLineStatus.CANCELED;
    }

    if (required <= 0) {
      return WmsFulfillmentLineStatus.ISSUE;
    }

    if (picked >= required) {
      return WmsFulfillmentLineStatus.PICKED;
    }

    if (allocated >= required) {
      return WmsFulfillmentLineStatus.READY;
    }

    if (allocated > 0) {
      return WmsFulfillmentLineStatus.PARTIAL;
    }

    return WmsFulfillmentLineStatus.RESTOCKING;
  }

  private resolveFulfillmentOrderStatus(params: {
    currentStatus: WmsFulfillmentOrderStatus;
    claimedById: string | null;
    basketId?: string | null;
    totalQuantity: number;
    allocatedQuantity: number;
    pickedQuantity: number;
    hasIssue: boolean;
  }) {
    if (params.currentStatus === WmsFulfillmentOrderStatus.CANCELED) {
      return WmsFulfillmentOrderStatus.CANCELED;
    }

    if (params.currentStatus === WmsFulfillmentOrderStatus.PACKED) {
      return WmsFulfillmentOrderStatus.PACKED;
    }

    if (params.currentStatus === WmsFulfillmentOrderStatus.PACKING) {
      return WmsFulfillmentOrderStatus.PACKING;
    }

    if (params.currentStatus === WmsFulfillmentOrderStatus.PICKED) {
      return WmsFulfillmentOrderStatus.PICKED;
    }

    const isActivelyBeingPicked =
      (params.currentStatus === WmsFulfillmentOrderStatus.IN_PICKING && Boolean(params.claimedById || params.basketId))
      || params.currentStatus === WmsFulfillmentOrderStatus.READY_FOR_PACK;
    if (isActivelyBeingPicked) {
      if (params.totalQuantity <= 0 || params.hasIssue) {
        return WmsFulfillmentOrderStatus.IN_PICKING;
      }

      if (params.pickedQuantity >= params.totalQuantity) {
        return WmsFulfillmentOrderStatus.READY_FOR_PACK;
      }

      return WmsFulfillmentOrderStatus.IN_PICKING;
    }

    if (params.totalQuantity <= 0 || params.hasIssue) {
      return WmsFulfillmentOrderStatus.ISSUE;
    }

    if (params.pickedQuantity >= params.totalQuantity) {
      return WmsFulfillmentOrderStatus.READY_FOR_PACK;
    }

    if (params.allocatedQuantity >= params.totalQuantity) {
      return WmsFulfillmentOrderStatus.READY;
    }

    if (params.allocatedQuantity > 0) {
      return WmsFulfillmentOrderStatus.PARTIAL;
    }

    return WmsFulfillmentOrderStatus.RESTOCKING;
  }

  public resolveEmptyFulfillmentIssueReason(
    orderSnapshot: Prisma.JsonValue | null,
    fallbackItemData?: Prisma.JsonValue | null,
  ): string {
    const snapshot = this.asJsonRecord(orderSnapshot);
    const hasSnapshotItemsArray = Array.isArray(snapshot?.items);
    const snapshotItems = hasSnapshotItemsArray ? (snapshot!.items as unknown[]) : [];
    const fallbackItems = Array.isArray(fallbackItemData) ? fallbackItemData : [];

    if (!hasSnapshotItemsArray && fallbackItems.length === 0) {
      return 'Order line items have not arrived from Pancake POS yet — syncing from POS';
    }

    if (snapshotItems.length === 0 && fallbackItems.length === 0) {
      return 'Order has no line items in Pancake POS — add a product variation in POS to pick';
    }

    const effectiveItems = snapshotItems.length > 0 ? snapshotItems : fallbackItems;
    const objectItems = effectiveItems
      .map((raw) => this.asJsonRecord(raw))
      .filter((item): item is Record<string, unknown> => Boolean(item));

    if (
      objectItems.length > 0
      && objectItems.every((item) => {
        const qty = this.readPositiveInt(item.quantity);
        const returned =
          this.readPositiveInt(item.returned_count)
          + this.readPositiveInt(item.return_quantity)
          + this.readPositiveInt(item.returning_quantity);
        return qty > 0 && returned >= qty;
      })
    ) {
      return 'All order line items are marked returned in Pancake POS';
    }

    const unlinkedNames = Array.from(
      new Set(
        objectItems
          .map((item) => {
            const varInfo = this.asJsonRecord(item.variation_info);
            const candidate =
              varInfo?.name
              ?? item.variationName
              ?? item.product_name
              ?? item.note_product
              ?? item.name;
            return typeof candidate === 'string' && candidate.trim().length > 0
              ? candidate.trim()
              : null;
          })
          .filter((name): name is string => Boolean(name)),
      ),
    );
    if (unlinkedNames.length > 0) {
      return `Order item in Pancake POS ("${unlinkedNames.slice(0, 2).join(', ')}") is not linked to a catalog variation — link a product variation in POS to pick`;
    }

    return 'Order item in Pancake POS is not linked to a catalog variation — link a product variation in POS to pick';
  }

  public resolveOrderIssueReason(params: {
    nextOrderStatus: WmsFulfillmentOrderStatus;
    totalQuantity: number;
    existingIssueReason?: string | null;
    lines?: Array<{
      productName: string;
      status: WmsFulfillmentLineStatus;
      issueReason?: string | null;
    }>;
    orderSnapshot?: Prisma.JsonValue | null;
    itemData?: Prisma.JsonValue | null;
  }): string | null {
    if (params.nextOrderStatus !== WmsFulfillmentOrderStatus.ISSUE) {
      return null;
    }

    if (params.totalQuantity <= 0) {
      const existing = params.existingIssueReason?.trim();
      if (existing) {
        return existing;
      }
      if (params.orderSnapshot !== undefined || params.itemData !== undefined) {
        return this.resolveEmptyFulfillmentIssueReason(
          params.orderSnapshot ?? null,
          params.itemData ?? null,
        );
      }
      return 'Order has no pickable variation items';
    }

    const issueLine = (params.lines ?? []).find(
      (line) => line.status === WmsFulfillmentLineStatus.ISSUE || Boolean(line.issueReason?.trim()),
    );
    if (issueLine) {
      const lineReason = issueLine.issueReason?.trim();
      const lineName = issueLine.productName?.trim();
      if (lineReason) {
        return lineName ? `${lineName}: ${lineReason}` : lineReason;
      }
      return lineName
        ? `${lineName}: Order item has a fulfillment issue — review line item.`
        : 'Order item has a fulfillment issue — review order line items.';
    }

    return (
      params.existingIssueReason?.trim()
      || 'Order has a fulfillment issue — review order line items or resync the pick queue.'
    );
  }

  public async extractFulfillmentLinesFromOrderSnapshot(
    orderSnapshot: Prisma.JsonValue | null,
    storeId: string,
    fallbackItemData?: Prisma.JsonValue | null,
  ): Promise<FulfillmentLineDraft[]> {
    const snapshot = this.asJsonRecord(orderSnapshot);
    const snapshotItems = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const primaryLines = await this.extractFulfillmentLinesFromItems(snapshotItems, storeId);
    if (primaryLines.length > 0) {
      return primaryLines;
    }

    const fallbackItems = Array.isArray(fallbackItemData) ? fallbackItemData : [];
    if (fallbackItems.length > 0) {
      return this.extractFulfillmentLinesFromItems(fallbackItems, storeId);
    }

    return [];
  }

  private async extractFulfillmentLinesFromItems(
    items: unknown[],
    storeId: string,
    depth = 0,
  ): Promise<FulfillmentLineDraft[]> {
    if (items.length === 0) {
      return [];
    }

    const groupedLines = new Map<string, FulfillmentLineDraft>();
    const identifiers = new Set<string>();
    const exactNames = new Set<string>();

    const normalizeSkuCandidate = (value: unknown): string | null => {
      const raw = this.readIdentifier(value);
      if (!raw) return null;
      const cleaned = raw.replace(/`+$/g, '').trim();
      return cleaned.length > 0 ? cleaned : null;
    };

    const normalizeNameCandidate = (value: unknown): string | null => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      return trimmed.length >= 2 ? trimmed : null;
    };

    for (const rawItem of items) {
      const item = this.asJsonRecord(rawItem);
      if (!item) {
        continue;
      }

      const variationInfo = this.asJsonRecord(item.variation_info);
      [
        this.readIdentifier(item.variation_id),
        this.readIdentifier(item.variationId),
        this.readIdentifier(variationInfo?.variation_id),
        this.readIdentifier(variationInfo?.variationId),
        this.readIdentifier(variationInfo?.id),
        this.readIdentifier(item.product_id),
        this.readIdentifier(item.productId),
        this.readIdentifier(variationInfo?.product_id),
        this.readIdentifier(variationInfo?.productId),
        normalizeSkuCandidate(item.product_display_id),
        normalizeSkuCandidate(item.productDisplayId),
        normalizeSkuCandidate(item.custom_id),
        normalizeSkuCandidate(item.customId),
        normalizeSkuCandidate(item.sku),
        normalizeSkuCandidate(item.barcode),
        normalizeSkuCandidate(variationInfo?.display_id),
        normalizeSkuCandidate(variationInfo?.product_display_id),
        normalizeSkuCandidate(variationInfo?.custom_id),
        normalizeSkuCandidate(variationInfo?.barcode),
      ].forEach((value) => {
        if (value) {
          identifiers.add(value);
        }
      });

      [
        normalizeNameCandidate(variationInfo?.name),
        normalizeNameCandidate(item.variationName),
        normalizeNameCandidate(item.product_name),
        normalizeNameCandidate(item.name),
      ].forEach((nameValue) => {
        if (nameValue && exactNames.size < 20) {
          exactNames.add(nameValue);
        }
      });
    }

    const candidateIds = Array.from(identifiers);
    const candidateNames = Array.from(exactNames);
    const catalogOrClauses: Prisma.PosProductWhereInput[] = [
      ...(candidateIds.length > 0
        ? [
            { variationId: { in: candidateIds } },
            { productId: { in: candidateIds } },
            { customId: { in: candidateIds } },
          ]
        : []),
      ...candidateNames.map((name) => ({
        name: { equals: name, mode: 'insensitive' as const },
      })),
    ];
    const catalogProducts = catalogOrClauses.length > 0
      && typeof (this.prisma as any).posProduct?.findMany === 'function'
      ? await this.prisma.posProduct.findMany({
          where: {
            storeId,
            OR: catalogOrClauses,
          },
          select: {
            productId: true,
            variationId: true,
            customId: true,
            name: true,
          },
        })
      : [];

    type CatalogProductRow = (typeof catalogProducts)[number];
    const isStockableCatalogRow = (product: CatalogProductRow) =>
      Boolean(product.variationId && product.variationId !== product.productId);

    const productByVariationId = new Map<string, CatalogProductRow>();
    const productsByProductId = new Map<string, CatalogProductRow[]>();
    const productsByCustomKey = new Map<string, CatalogProductRow[]>();
    const productsByNameKey = new Map<string, CatalogProductRow[]>();

    for (const product of catalogProducts) {
      if (product.variationId) {
        const current = productByVariationId.get(product.variationId);
        if (!current || (!isStockableCatalogRow(current) && isStockableCatalogRow(product))) {
          productByVariationId.set(product.variationId, product);
        }
      }

      if (product.productId) {
        const list = productsByProductId.get(product.productId) ?? [];
        list.push(product);
        productsByProductId.set(product.productId, list);
      }

      const normCustom = normalizeSkuCandidate(product.customId)?.toLowerCase();
      if (normCustom) {
        const list = productsByCustomKey.get(normCustom) ?? [];
        list.push(product);
        productsByCustomKey.set(normCustom, list);
      }

      const normName = normalizeNameCandidate(product.name)?.toLowerCase();
      if (normName) {
        const list = productsByNameKey.get(normName) ?? [];
        list.push(product);
        productsByNameKey.set(normName, list);
      }
    }

    const pickUnambiguousCatalogProduct = (rows: CatalogProductRow[] | undefined): CatalogProductRow | null => {
      if (!rows || rows.length === 0) return null;
      const stockable = rows.filter((row) => isStockableCatalogRow(row));
      const pool = stockable.length > 0 ? stockable : rows.filter((row) => Boolean(row.variationId));
      if (pool.length === 0) {
        return rows.length === 1 ? rows[0] : null;
      }
      const distinctVariationIds = new Set(pool.map((row) => row.variationId!));
      return distinctVariationIds.size === 1 ? pool[0] : null;
    };

    for (const rawItem of items) {
      const item = this.asJsonRecord(rawItem);
      if (!item) {
        continue;
      }

      const quantity = this.readPositiveInt(item.quantity);
      const returnedQuantity =
        this.readPositiveInt(item.returned_count)
        + this.readPositiveInt(item.return_quantity)
        + this.readPositiveInt(item.returning_quantity);
      const requiredQuantity = Math.max(quantity - returnedQuantity, 0);
      if (requiredQuantity <= 0) {
        continue;
      }

      const variationInfo = this.asJsonRecord(item.variation_info);
      const sourceProductId =
        this.readIdentifier(item.product_id)
        ?? this.readIdentifier(item.productId)
        ?? this.readIdentifier(variationInfo?.product_id)
        ?? this.readIdentifier(variationInfo?.productId);
      const explicitVariationId =
        this.readIdentifier(item.variation_id)
        ?? this.readIdentifier(item.variationId)
        ?? this.readIdentifier(variationInfo?.variation_id)
        ?? this.readIdentifier(variationInfo?.variationId);
      const variationInfoId = this.readIdentifier(variationInfo?.id);
      const sourceVariationId =
        explicitVariationId
        ?? (variationInfoId && (!sourceProductId || variationInfoId !== sourceProductId)
          ? variationInfoId
          : null);
      const sourceDisplayIds = [
        normalizeSkuCandidate(item.product_display_id),
        normalizeSkuCandidate(item.productDisplayId),
        normalizeSkuCandidate(item.custom_id),
        normalizeSkuCandidate(item.customId),
        normalizeSkuCandidate(item.sku),
        normalizeSkuCandidate(item.barcode),
        normalizeSkuCandidate(variationInfo?.product_display_id),
        normalizeSkuCandidate(variationInfo?.display_id),
        normalizeSkuCandidate(variationInfo?.custom_id),
        normalizeSkuCandidate(variationInfo?.barcode),
      ].filter((value): value is string => Boolean(value));
      const sourceNames = [
        normalizeNameCandidate(variationInfo?.name),
        normalizeNameCandidate(item.variationName),
        normalizeNameCandidate(item.product_name),
        normalizeNameCandidate(item.name),
      ].filter((value): value is string => Boolean(value));

      const hasDistinctSourceVariation = Boolean(
        sourceVariationId && (!sourceProductId || sourceVariationId !== sourceProductId),
      );

      let resolvedProduct: CatalogProductRow | null = null;
      if (hasDistinctSourceVariation) {
        resolvedProduct = productByVariationId.get(sourceVariationId!) ?? null;
      } else {
        const directVariationMatch = sourceVariationId ? productByVariationId.get(sourceVariationId) ?? null : null;
        resolvedProduct =
          (directVariationMatch && isStockableCatalogRow(directVariationMatch) ? directVariationMatch : null)
          ?? sourceDisplayIds
            .map((sku) => pickUnambiguousCatalogProduct(productsByCustomKey.get(sku.toLowerCase())))
            .find((row): row is CatalogProductRow => Boolean(row))
          ?? (sourceProductId ? pickUnambiguousCatalogProduct(productsByProductId.get(sourceProductId)) : null)
          ?? sourceNames
            .map((name) => pickUnambiguousCatalogProduct(productsByNameKey.get(name.toLowerCase())))
            .find((row): row is CatalogProductRow => Boolean(row))
          ?? directVariationMatch
          ?? null;
      }

      const variationId = hasDistinctSourceVariation
        ? (resolvedProduct?.variationId ?? sourceVariationId)
        : (resolvedProduct?.variationId ?? sourceVariationId ?? null);

      if (!variationId) {
        if (depth === 0) {
          const childItems = Array.isArray(item.components)
            ? item.components
            : Array.isArray(item.combo_items)
              ? item.combo_items
              : null;
          if (childItems && childItems.length > 0) {
            const childLines = await this.extractFulfillmentLinesFromItems(childItems, storeId, depth + 1);
            for (const childLine of childLines) {
              const scaledRequired = childLine.quantityRequired * requiredQuantity;
              const existingChild = groupedLines.get(childLine.variationId);
              if (existingChild) {
                existingChild.quantityRequired += scaledRequired;
              } else {
                groupedLines.set(childLine.variationId, {
                  ...childLine,
                  quantityRequired: scaledRequired,
                });
              }
            }
          }
        }
        continue;
      }

      const productId = resolvedProduct?.productId ?? sourceProductId;
      const productName =
        this.readString(variationInfo?.name)
        ?? this.readString(item.variationName)
        ?? resolvedProduct?.name
        ?? this.readString(item.note_product)
        ?? this.readString(item.name)
        ?? `Variation ${variationId}`;
      const productDisplayId =
        resolvedProduct?.customId
        ?? normalizeSkuCandidate(item.productDisplayId)
        ?? normalizeSkuCandidate(item.product_display_id)
        ?? normalizeSkuCandidate(variationInfo?.display_id)
        ?? normalizeSkuCandidate(variationInfo?.product_display_id)
        ?? normalizeSkuCandidate(variationInfo?.barcode)
        ?? null;

      const existing = groupedLines.get(variationId);
      if (existing) {
        existing.quantityRequired += requiredQuantity;
        continue;
      }

      groupedLines.set(variationId, {
        variationId,
        productId,
        productName,
        productDisplayId,
        quantityRequired: requiredQuantity,
        lineSnapshot: {
          variationId,
          productId,
          productName,
          productDisplayId,
          sourceVariationId,
          sourceProductId,
          sourceItem: item,
        } as Prisma.InputJsonValue,
      });
    }

    return Array.from(groupedLines.values());
  }

  private extractPosWarehouseRef(orderSnapshot: Prisma.JsonValue | null) {
    const snapshot = this.asJsonRecord(orderSnapshot);
    return (
      this.readIdentifier(snapshot?.warehouse_id)
      ?? this.readIdentifier(snapshot?.warehouseId)
      ?? null
    );
  }

  private async resolveFulfillmentWarehouseId(params: {
    tenantId: string;
    storeId: string;
    posWarehouseRef: string | null;
  }) {
    if (!params.posWarehouseRef) {
      return null;
    }

    const unit = await this.prisma.wmsInventoryUnit.findFirst({
      where: {
        tenantId: params.tenantId,
        storeId: params.storeId,
        posWarehouseRef: params.posWarehouseRef,
      },
      select: {
        warehouseId: true,
      },
    });

    return unit?.warehouseId ?? null;
  }

  private asJsonRecord(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any>
      : null;
  }

  private readString(value: unknown) {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : null;
  }

  private readIdentifier(value: unknown): string | null {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }

    return null;
  }

  private readPositiveInt(value: unknown) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }

    return Math.max(Math.trunc(parsed), 0);
  }
}

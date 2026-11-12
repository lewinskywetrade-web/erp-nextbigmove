import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IntegrationStatus, WmsFulfillmentOrderStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunApiBackgroundServices } from '../../../common/runtime/process-role';
import { IntegrationService } from '../integration.service';

const MAX_RECONCILE_PER_TICK = 30;
const MAX_CANDIDATE_SCAN = 500;
const PICK_QUEUE_STORE_SYNC_INTERVAL_MS = 2 * 60_000;
const MAX_PICK_QUEUE_STORES_PER_TICK = 4;
const STARTUP_MAX_PICK_QUEUE_STORES = 12;
const ACTIVE_PICK_QUEUE_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.READY,
  WmsFulfillmentOrderStatus.PARTIAL,
  WmsFulfillmentOrderStatus.RESTOCKING,
  WmsFulfillmentOrderStatus.ISSUE,
  WmsFulfillmentOrderStatus.IN_PICKING,
  WmsFulfillmentOrderStatus.READY_FOR_PACK,
  WmsFulfillmentOrderStatus.PICKED,
  WmsFulfillmentOrderStatus.PACKING,
] as const;

export function resolveWmsIssueRecheckIntervalMs(ageMs: number): number {
  if (ageMs < 30 * 60_000) {
    return 50_000;
  }
  if (ageMs < 6 * 60 * 60_000) {
    return 5 * 60_000;
  }
  if (ageMs < 72 * 60 * 60_000) {
    return 30 * 60_000;
  }
  return 4 * 60 * 60_000;
}

@Injectable()
export class WmsIssueOrderReconcilerService implements OnModuleInit {
  private readonly logger = new Logger(WmsIssueOrderReconcilerService.name);
  private readonly lastCheckedAtByOrderId = new Map<string, number>();
  private readonly lastPickQueueStoreSyncAtByStoreId = new Map<string, number>();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrationService: IntegrationService,
  ) {}

  private isEnabled(): boolean {
    return (
      process.env.WMS_ISSUE_ORDER_RECONCILE_ENABLED !== 'false'
      && shouldRunApiBackgroundServices()
    );
  }

  onModuleInit() {
    if (!this.isEnabled()) {
      return;
    }
    const timer = setTimeout(() => {
      void this.reconcileDueIssueOrders('startup');
    }, 5_000);
    timer.unref?.();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    await this.reconcileDueIssueOrders('cron');
  }

  async reconcileDueIssueOrders(source: 'startup' | 'cron' = 'cron'): Promise<{
    dueCount: number;
    recoveredCount: number;
    canceledCount: number;
    remainingIssueCount: number;
  }> {
    if (!this.isEnabled() || this.running) {
      return {
        dueCount: 0,
        recoveredCount: 0,
        canceledCount: 0,
        remainingIssueCount: 0,
      };
    }

    this.running = true;
    try {
      const nowMs = Date.now();
      const openIssueOrders = await this.prisma.wmsFulfillmentOrder.findMany({
        where: {
          status: WmsFulfillmentOrderStatus.ISSUE,
          basketId: null,
          pickedQuantity: 0,
          store: {
            is: {
              status: IntegrationStatus.ACTIVE,
            },
          },
        },
        select: {
          id: true,
          createdAt: true,
          totalQuantity: true,
          issueReason: true,
          posOrder: {
            select: {
              status: true,
              isVoid: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }],
        take: MAX_CANDIDATE_SCAN,
      });

      const prioritizedIssueOrders = [...openIssueOrders].sort((left: any, right: any) => {
        const leftConfirmedVisible =
          (left.posOrder?.status ?? 1) === 1 && !left.posOrder?.isVoid ? 1 : 0;
        const rightConfirmedVisible =
          (right.posOrder?.status ?? 1) === 1 && !right.posOrder?.isVoid ? 1 : 0;
        if (leftConfirmedVisible !== rightConfirmedVisible) {
          return rightConfirmedVisible - leftConfirmedVisible;
        }
        const leftNeedsImmediateHeal =
          (left.totalQuantity ?? 0) > 0 || !left.issueReason ? 1 : 0;
        const rightNeedsImmediateHeal =
          (right.totalQuantity ?? 0) > 0 || !right.issueReason ? 1 : 0;
        if (leftNeedsImmediateHeal !== rightNeedsImmediateHeal) {
          return rightNeedsImmediateHeal - leftNeedsImmediateHeal;
        }
        return 0;
      });

      const activeIdSet = new Set(prioritizedIssueOrders.map((row) => row.id));
      for (const trackedId of Array.from(this.lastCheckedAtByOrderId.keys())) {
        if (!activeIdSet.has(trackedId)) {
          this.lastCheckedAtByOrderId.delete(trackedId);
        }
      }

      const dueOrderIds: string[] = [];
      for (const row of prioritizedIssueOrders) {
        const createdAtMs = row.createdAt instanceof Date ? row.createdAt.getTime() : nowMs;
        const ageMs = Math.max(nowMs - createdAtMs, 0);
        const intervalMs = resolveWmsIssueRecheckIntervalMs(ageMs);
        const lastCheckedAt = this.lastCheckedAtByOrderId.get(row.id) ?? 0;
        if (nowMs - lastCheckedAt >= intervalMs) {
          dueOrderIds.push(row.id);
          if (dueOrderIds.length >= MAX_RECONCILE_PER_TICK) {
            break;
          }
        }
      }

      if (dueOrderIds.length === 0) {
        await this.reconcileOpenPickQueueStoresFromPos(source, nowMs);
        return {
          dueCount: 0,
          recoveredCount: 0,
          canceledCount: 0,
          remainingIssueCount: openIssueOrders.length,
        };
      }

      for (const id of dueOrderIds) {
        this.lastCheckedAtByOrderId.set(id, nowMs);
      }

      const result = await this.integrationService.reconcileOpenWmsIssueOrders({
        orderIds: dueOrderIds,
        limit: dueOrderIds.length,
      });

      if (result.recoveredCount > 0 || result.canceledCount > 0) {
        this.logger.log(
          `WMS ISSUE reconciler (${source}) evaluated=${result.evaluatedCount} recovered=${result.recoveredCount} canceled=${result.canceledCount} remaining=${result.remainingIssueCount}`,
        );
      }

      await this.reconcileOpenPickQueueStoresFromPos(source, nowMs);

      return {
        dueCount: dueOrderIds.length,
        recoveredCount: result.recoveredCount,
        canceledCount: result.canceledCount,
        remainingIssueCount: result.remainingIssueCount,
      };
    } catch {
      this.logger.warn(`WMS ISSUE order reconciler (${source}) deferred until next tick`);
      return {
        dueCount: 0,
        recoveredCount: 0,
        canceledCount: 0,
        remainingIssueCount: 0,
      };
    } finally {
      this.running = false;
    }
  }

  private async reconcileOpenPickQueueStoresFromPos(
    source: 'startup' | 'cron',
    nowMs: number,
  ): Promise<number> {
    if (typeof (this.integrationService as any)?.syncPancakeOrdersByStoreId !== 'function') {
      return 0;
    }

    const openStoreCandidates = await this.prisma.wmsFulfillmentOrder.findMany({
      where: {
        status: {
          in: [...ACTIVE_PICK_QUEUE_ORDER_STATUSES],
        },
        store: {
          is: {
            status: IntegrationStatus.ACTIVE,
            NOT: { enabled: false },
          },
        },
        posOrder: {
          is: {
            OR: [
              { status: { in: [1, 8, 9, 12, 13] }, isVoid: false },
              { status: { in: [2, 3, 4, 5, 6] } },
              { isVoid: true },
            ],
          },
        },
      },
      select: {
        storeId: true,
        tenantId: true,
      },
      distinct: ['storeId'],
      take: 50,
    });

    const validStoreCandidates = (Array.isArray(openStoreCandidates) ? openStoreCandidates : []).filter(
      (row) => Boolean(row?.storeId && row?.tenantId),
    );
    const activeStoreIdSet = new Set(validStoreCandidates.map((row) => row.storeId));
    for (const trackedStoreId of Array.from(this.lastPickQueueStoreSyncAtByStoreId.keys())) {
      if (!activeStoreIdSet.has(trackedStoreId)) {
        this.lastPickQueueStoreSyncAtByStoreId.delete(trackedStoreId);
      }
    }

    const maxStores = source === 'startup'
      ? STARTUP_MAX_PICK_QUEUE_STORES
      : MAX_PICK_QUEUE_STORES_PER_TICK;
    const dueStores = validStoreCandidates
      .filter((row) => {
        const lastSyncedAt = this.lastPickQueueStoreSyncAtByStoreId.get(row.storeId) ?? 0;
        return source === 'startup' || nowMs - lastSyncedAt >= PICK_QUEUE_STORE_SYNC_INTERVAL_MS;
      })
      .slice(0, maxStores);

    let syncedStoreCount = 0;
    for (const row of dueStores) {
      this.lastPickQueueStoreSyncAtByStoreId.set(row.storeId, nowMs);
      try {
        await this.integrationService.syncPancakeOrdersByStoreId(
          row.storeId,
          row.tenantId,
          { days: 3, repairIssueOrders: true },
        );
        syncedStoreCount += 1;
      } catch (error: any) {
        this.logger.warn(
          `WMS Pick Queue POS store sync (${source}) skipped store=${row.storeId}: ${error?.message || 'Unknown error'}`,
        );
      }
    }

    if (syncedStoreCount > 0 && source === 'startup') {
      this.logger.log(
        `WMS Pick Queue startup POS sync refreshed ${syncedStoreCount} active store(s)`,
      );
    }

    return syncedStoreCount;
  }
}

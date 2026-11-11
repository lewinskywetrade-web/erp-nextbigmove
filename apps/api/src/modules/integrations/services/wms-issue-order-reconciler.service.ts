import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IntegrationStatus, WmsFulfillmentOrderStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunApiBackgroundServices } from '../../../common/runtime/process-role';
import { IntegrationService } from '../integration.service';

const MAX_RECONCILE_PER_TICK = 30;
const MAX_CANDIDATE_SCAN = 150;

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
              NOT: { enabled: false },
            },
          },
        },
        select: {
          id: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }],
        take: MAX_CANDIDATE_SCAN,
      });

      const activeIdSet = new Set(openIssueOrders.map((row) => row.id));
      for (const trackedId of Array.from(this.lastCheckedAtByOrderId.keys())) {
        if (!activeIdSet.has(trackedId)) {
          this.lastCheckedAtByOrderId.delete(trackedId);
        }
      }

      const dueOrderIds: string[] = [];
      for (const row of openIssueOrders) {
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
}

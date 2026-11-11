import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  CreativeAiRunStatus,
  IntegrationStatus,
  TenantStatus,
  WmsFulfillmentAmendmentStatus,
  WmsFulfillmentChangeState,
  WmsFulfillmentOrderStatus,
  WmsInventoryCountSessionStatus,
  WmsInventoryUnitStatus,
  WmsPurchasingBatchStatus,
  WmsReceivingBatchStatus,
  WmsStaffActivityOutcome,
  WorkflowExecutionStatus,
} from '@prisma/client';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import Redis from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WmsReportsService } from '../wms-reports/wms-reports.service';
import { GetOpsDailyDigestDto } from './dto/get-ops-daily-digest.dto';
import { SendOpsDailyDigestEmailDto } from './dto/send-ops-daily-digest-email.dto';

dayjs.extend(utc);
dayjs.extend(timezone);

const MANILA_TZ = 'Asia/Manila';
const DEFAULT_FROM_EMAIL = 'WeTrade WMS <wms-inventory-update@wetrade.com.ph>';
const DEFAULT_OPS_RECIPIENT = 'lewinskycandido@gmail.com';

const BULL_QUEUES = [
  'pancake-webhook',
  'pancake-webhook-reconcile',
  'pos-order-sync-recovery',
  'workflow-execution',
  'manual-meta-upload',
  'orders-confirmation-update',
  'wms-demand-queue-refresh',
  'wms-picking-handoff',
  'wms-packing-post-complete',
  'creative-ai-analysis',
  'creative-meta-draft',
] as const;

const SAFE_METADATA_KEYS = new Set([
  'reason',
  'reasonCode',
  'error',
  'errorCode',
  'code',
  'barcode',
  'scannedCode',
  'scannedBarcode',
  'unitCode',
  'locationCode',
  'variationId',
  'expectedVariationId',
  'scannedVariationId',
  'productId',
  'orderId',
  'posOrderId',
  'status',
  'fromStatus',
  'toStatus',
  'stage',
]);

function sanitizeText(value: unknown, maxLen = 200): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const redacted = raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
    .replace(/\b(?:\+?63|0)9\d{9}\b/g, '[PHONE]');
  return redacted.length > maxLen ? `${redacted.slice(0, maxLen)}…` : redacted;
}

function extractSafeMetadataHint(metadata: unknown): Record<string, string | number | boolean> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(record)) {
    if (!SAFE_METADATA_KEYS.has(key)) {
      continue;
    }
    const val = record[key];
    if (typeof val === 'number' || typeof val === 'boolean') {
      out[key] = val;
    } else if (typeof val === 'string' && val.trim().length > 0) {
      const cleaned = sanitizeText(val, 120);
      if (cleaned) {
        out[key] = cleaned;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function formatActorName(actor?: { firstName?: string | null; lastName?: string | null } | null): string {
  if (!actor) {
    return 'System / Unknown';
  }
  const full = [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim();
  return full || 'Staff User';
}

@Injectable()
export class OpsDigestService {
  private readonly logger = new Logger(OpsDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wmsReportsService: WmsReportsService,
  ) {}

  async getDailyDigest(query: GetOpsDailyDigestDto) {
    const windowHours = Math.min(Math.max(Number(query.windowHours || 24), 1), 168);
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowHours * 3600 * 1000);
    const stale12h = new Date(now.getTime() - 12 * 3600 * 1000);
    const stale24h = new Date(now.getTime() - 24 * 3600 * 1000);
    const stale36h = new Date(now.getTime() - 36 * 3600 * 1000);
    const stale2h = new Date(now.getTime() - 2 * 3600 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const expirySoonDate = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
    const collectionWarnings: string[] = [];

    const runSection = async <T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Ops digest section "${name}" failed: ${msg}`);
        collectionWarnings.push(`${name}: ${sanitizeText(msg, 180)}`);
        return fallback;
      }
    };

    const tenants = await this.prisma.tenant.findMany({
      where: {
        status: { in: [TenantStatus.ACTIVE, TenantStatus.TRIAL] },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        planType: true,
        wmsFulfillmentGoLiveAt: true,
      },
      orderBy: [{ name: 'asc' }],
    });

    const tenantNameById = new Map<string, string>(tenants.map((t) => [t.id, t.name]));
    const stores = await this.prisma.posStore.findMany({
      select: {
        id: true,
        tenantId: true,
        name: true,
        shopId: true,
        status: true,
        enabled: true,
        lastSyncAt: true,
      },
    });
    const storeNameById = new Map<string, string>(stores.map((s) => [s.id, s.name]));

    const resolveTenantName = (tenantId?: string | null) =>
      (tenantId && tenantNameById.get(tenantId)) || (tenantId ? `Tenant:${tenantId.slice(0, 8)}` : 'Internal / Platform');
    const resolveStoreName = (storeId?: string | null) =>
      (storeId && storeNameById.get(storeId)) || (storeId ? `Store:${storeId.slice(0, 8)}` : 'Unscoped');

    const [
      wmsStaffActivities,
      wmsFulfillment,
      wmsInventoryAndOps,
      erpAuditAndAnalytics,
      erpPosOrdersAndCogs,
      erpIntegrationsAndWebhooks,
      erpWorkflowsAndCreativeAi,
      redisQueues,
    ] = await Promise.all([
      runSection(
        'wms.staffActivities',
        {
          totalEvents: 0,
          byPlatformAndOutcome: [],
          topActions: [],
          issuesAndRejections: [],
          staffBreakdown: [],
        },
        async () => {
          const [groupedOutcomes, groupedActions, nonSuccessRows, actorCounts] = await Promise.all([
            this.prisma.wmsStaffActivity.groupBy({
              by: ['platform', 'outcome'],
              where: { createdAt: { gte: windowStart } },
              _count: { _all: true },
            }),
            this.prisma.wmsStaffActivity.groupBy({
              by: ['platform', 'actionType', 'outcome'],
              where: { createdAt: { gte: windowStart } },
              _count: { _all: true },
            }),
            this.prisma.wmsStaffActivity.findMany({
              where: {
                createdAt: { gte: windowStart },
                outcome: { in: [WmsStaffActivityOutcome.REJECTED, WmsStaffActivityOutcome.EXCEPTION] },
              },
              select: {
                tenantId: true,
                storeId: true,
                platform: true,
                deviceName: true,
                actionType: true,
                taskType: true,
                fromStatus: true,
                toStatus: true,
                outcome: true,
                reasonCode: true,
                metadata: true,
                createdAt: true,
                actor: { select: { firstName: true, lastName: true } },
              },
              orderBy: { createdAt: 'desc' },
              take: 500,
            }),
            this.prisma.wmsStaffActivity.groupBy({
              by: ['actorId', 'platform', 'outcome'],
              where: { createdAt: { gte: windowStart } },
              _count: { _all: true },
            }),
          ]);

          const actorIds = Array.from(
            new Set(actorCounts.map((r) => r.actorId).filter((v): v is string => Boolean(v))),
          );
          const actors = actorIds.length
            ? await this.prisma.user.findMany({
                where: { id: { in: actorIds } },
                select: { id: true, firstName: true, lastName: true },
              })
            : [];
          const actorNameMap = new Map(actors.map((u) => [u.id, formatActorName(u)]));

          let totalEvents = 0;
          const byPlatformAndOutcome = groupedOutcomes.map((row) => {
            totalEvents += row._count._all;
            return {
              platform: row.platform,
              outcome: row.outcome,
              count: row._count._all,
            };
          });

          const actionAcc = new Map<
            string,
            {
              platform: string;
              actionType: string;
              totalCount: number;
              successCount: number;
              rejectedCount: number;
              exceptionCount: number;
            }
          >();
          for (const row of groupedActions) {
            const key = `${row.platform}::${row.actionType}`;
            const item = actionAcc.get(key) || {
              platform: row.platform,
              actionType: row.actionType,
              totalCount: 0,
              successCount: 0,
              rejectedCount: 0,
              exceptionCount: 0,
            };
            item.totalCount += row._count._all;
            if (row.outcome === WmsStaffActivityOutcome.SUCCESS) item.successCount += row._count._all;
            if (row.outcome === WmsStaffActivityOutcome.REJECTED) item.rejectedCount += row._count._all;
            if (row.outcome === WmsStaffActivityOutcome.EXCEPTION) item.exceptionCount += row._count._all;
            actionAcc.set(key, item);
          }

          const issueMap = new Map<
            string,
            {
              tenantName: string;
              storeName: string;
              platform: string;
              actionType: string;
              outcome: string;
              reasonCode: string;
              count: number;
              latestAt: string;
              actors: Set<string>;
              devices: Set<string>;
              sampleHints: Array<Record<string, string | number | boolean>>;
            }
          >();

          for (const row of nonSuccessRows) {
            const tenantName = resolveTenantName(row.tenantId);
            const storeName = resolveStoreName(row.storeId);
            const reasonCode = row.reasonCode || 'UNSPECIFIED';
            const key = `${tenantName}::${storeName}::${row.platform}::${row.actionType}::${row.outcome}::${reasonCode}`;
            const entry = issueMap.get(key) || {
              tenantName,
              storeName,
              platform: row.platform,
              actionType: row.actionType,
              outcome: row.outcome,
              reasonCode,
              count: 0,
              latestAt: row.createdAt.toISOString(),
              actors: new Set<string>(),
              devices: new Set<string>(),
              sampleHints: [],
            };
            entry.count += 1;
            if (row.createdAt.toISOString() > entry.latestAt) {
              entry.latestAt = row.createdAt.toISOString();
            }
            if (entry.actors.size < 5) {
              entry.actors.add(formatActorName(row.actor));
            }
            if (row.deviceName && entry.devices.size < 5) {
              entry.devices.add(row.deviceName);
            }
            if (entry.sampleHints.length < 3) {
              const hint = extractSafeMetadataHint(row.metadata);
              if (hint) {
                entry.sampleHints.push(hint);
              }
            }
            issueMap.set(key, entry);
          }

          const staffAcc = new Map<
            string,
            {
              actorName: string;
              platform: string;
              totalActions: number;
              successCount: number;
              rejectedCount: number;
              exceptionCount: number;
            }
          >();
          for (const row of actorCounts) {
            const actorLabel = row.actorId ? actorNameMap.get(row.actorId) || 'Staff User' : 'Unauthenticated / System';
            const key = `${actorLabel}::${row.platform}`;
            const entry = staffAcc.get(key) || {
              actorName: actorLabel,
              platform: row.platform,
              totalActions: 0,
              successCount: 0,
              rejectedCount: 0,
              exceptionCount: 0,
            };
            entry.totalActions += row._count._all;
            if (row.outcome === WmsStaffActivityOutcome.SUCCESS) entry.successCount += row._count._all;
            if (row.outcome === WmsStaffActivityOutcome.REJECTED) entry.rejectedCount += row._count._all;
            if (row.outcome === WmsStaffActivityOutcome.EXCEPTION) entry.exceptionCount += row._count._all;
            staffAcc.set(key, entry);
          }

          return {
            totalEvents,
            byPlatformAndOutcome,
            topActions: Array.from(actionAcc.values())
              .sort((a, b) => b.totalCount - a.totalCount)
              .slice(0, 25),
            issuesAndRejections: Array.from(issueMap.values())
              .map((item) => ({
                tenantName: item.tenantName,
                storeName: item.storeName,
                platform: item.platform,
                actionType: item.actionType,
                outcome: item.outcome,
                reasonCode: item.reasonCode,
                count: item.count,
                latestAt: item.latestAt,
                actors: Array.from(item.actors),
                devices: Array.from(item.devices),
                sampleHints: item.sampleHints,
              }))
              .sort((a, b) => b.count - a.count)
              .slice(0, 30),
            staffBreakdown: Array.from(staffAcc.values())
              .sort((a, b) => b.rejectedCount + b.exceptionCount - (a.rejectedCount + a.exceptionCount) || b.totalActions - a.totalActions)
              .slice(0, 20),
          };
        },
      ),

      runSection(
        'wms.fulfillment',
        {
          throughputInWindow: [],
          liveQueueByStatus: [],
          issueOrdersByReason: [],
          sampleIssueOrders: [],
          reworkOrders: [],
          openAmendmentsByStage: [],
          agingBacklogOver12h: { countsByStatus: [], oldestOrders: [] },
          manualAdjustmentsInWindow: [],
        },
        async () => {
          const activeQueueStatuses: WmsFulfillmentOrderStatus[] = [
            WmsFulfillmentOrderStatus.READY,
            WmsFulfillmentOrderStatus.PARTIAL,
            WmsFulfillmentOrderStatus.RESTOCKING,
            WmsFulfillmentOrderStatus.ISSUE,
            WmsFulfillmentOrderStatus.IN_PICKING,
            WmsFulfillmentOrderStatus.READY_FOR_PACK,
            WmsFulfillmentOrderStatus.PICKED,
            WmsFulfillmentOrderStatus.PACKING,
          ];

          const [
            createdByTenant,
            packedByTenant,
            canceledByTenant,
            liveQueueGroups,
            issueReasonGroups,
            sampleIssues,
            reworkRows,
            openAmendments,
            agingGroups,
            oldestAgingRows,
            adjustments,
          ] = await Promise.all([
            this.prisma.wmsFulfillmentOrder.groupBy({
              by: ['tenantId'],
              where: { createdAt: { gte: windowStart } },
              _count: { _all: true },
            }),
            this.prisma.wmsFulfillmentOrder.groupBy({
              by: ['tenantId'],
              where: { status: WmsFulfillmentOrderStatus.PACKED, completedAt: { gte: windowStart } },
              _count: { _all: true },
            }),
            this.prisma.wmsFulfillmentOrder.groupBy({
              by: ['tenantId'],
              where: { status: WmsFulfillmentOrderStatus.CANCELED, updatedAt: { gte: windowStart } },
              _count: { _all: true },
            }),
            this.prisma.wmsFulfillmentOrder.groupBy({
              by: ['tenantId', 'storeId', 'status'],
              where: { status: { in: activeQueueStatuses } },
              _count: { _all: true },
            }),
            this.prisma.wmsFulfillmentOrder.groupBy({
              by: ['tenantId', 'storeId', 'issueReason'],
              where: { status: WmsFulfillmentOrderStatus.ISSUE },
              _count: { _all: true },
              _min: { createdAt: true },
            }),
            this.prisma.wmsFulfillmentOrder.findMany({
              where: { status: WmsFulfillmentOrderStatus.ISSUE },
              select: {
                posOrderId: true,
                tenantId: true,
                storeId: true,
                issueReason: true,
                totalQuantity: true,
                allocatedQuantity: true,
                pickedQuantity: true,
                createdAt: true,
                updatedAt: true,
              },
              orderBy: { updatedAt: 'desc' },
              take: 25,
            }),
            this.prisma.wmsFulfillmentOrder.findMany({
              where: {
                status: { not: WmsFulfillmentOrderStatus.CANCELED },
                changeState: { not: WmsFulfillmentChangeState.NONE },
              },
              select: {
                posOrderId: true,
                tenantId: true,
                storeId: true,
                status: true,
                changeState: true,
                changeDetectedAt: true,
                updatedAt: true,
              },
              orderBy: { updatedAt: 'desc' },
              take: 25,
            }),
            this.prisma.wmsFulfillmentAmendment.groupBy({
              by: ['tenantId', 'detectedStage'],
              where: { status: WmsFulfillmentAmendmentStatus.OPEN },
              _count: { _all: true },
            }),
            this.prisma.wmsFulfillmentOrder.groupBy({
              by: ['tenantId', 'status'],
              where: {
                status: {
                  in: [
                    WmsFulfillmentOrderStatus.READY,
                    WmsFulfillmentOrderStatus.PARTIAL,
                    WmsFulfillmentOrderStatus.RESTOCKING,
                    WmsFulfillmentOrderStatus.IN_PICKING,
                    WmsFulfillmentOrderStatus.READY_FOR_PACK,
                    WmsFulfillmentOrderStatus.PACKING,
                  ],
                },
                createdAt: { lt: stale12h },
              },
              _count: { _all: true },
            }),
            this.prisma.wmsFulfillmentOrder.findMany({
              where: {
                status: {
                  in: [
                    WmsFulfillmentOrderStatus.READY,
                    WmsFulfillmentOrderStatus.PARTIAL,
                    WmsFulfillmentOrderStatus.RESTOCKING,
                    WmsFulfillmentOrderStatus.IN_PICKING,
                    WmsFulfillmentOrderStatus.READY_FOR_PACK,
                    WmsFulfillmentOrderStatus.PACKING,
                  ],
                },
                createdAt: { lt: stale12h },
              },
              select: {
                posOrderId: true,
                tenantId: true,
                storeId: true,
                status: true,
                totalQuantity: true,
                allocatedQuantity: true,
                pickedQuantity: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
              take: 20,
            }),
            this.prisma.wmsFulfillmentAdjustment.findMany({
              where: { createdAt: { gte: windowStart } },
              select: {
                tenantId: true,
                type: true,
                status: true,
                quantity: true,
                reason: true,
                sourceProductName: true,
                substituteProductName: true,
                createdAt: true,
                fulfillmentOrder: { select: { posOrderId: true } },
              },
              orderBy: { createdAt: 'desc' },
              take: 25,
            }),
          ]);

          const throughputTenantIds = Array.from(
            new Set([
              ...createdByTenant.map((r) => r.tenantId),
              ...packedByTenant.map((r) => r.tenantId),
              ...canceledByTenant.map((r) => r.tenantId),
            ]),
          );
          const createdMap = new Map(createdByTenant.map((r) => [r.tenantId, r._count._all]));
          const packedMap = new Map(packedByTenant.map((r) => [r.tenantId, r._count._all]));
          const canceledMap = new Map(canceledByTenant.map((r) => [r.tenantId, r._count._all]));

          return {
            throughputInWindow: throughputTenantIds.map((tenantId) => ({
              tenantName: resolveTenantName(tenantId),
              createdOrders: createdMap.get(tenantId) || 0,
              packedOrders: packedMap.get(tenantId) || 0,
              canceledOrders: canceledMap.get(tenantId) || 0,
            })),
            liveQueueByStatus: liveQueueGroups.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              storeName: resolveStoreName(row.storeId),
              status: row.status,
              count: row._count._all,
            })),
            issueOrdersByReason: issueReasonGroups
              .map((row) => ({
                tenantName: resolveTenantName(row.tenantId),
                storeName: resolveStoreName(row.storeId),
                issueReason: sanitizeText(row.issueReason || 'Unspecified issue', 160),
                count: row._count._all,
                oldestCreatedAt: row._min.createdAt?.toISOString() || null,
              }))
              .sort((a, b) => b.count - a.count),
            sampleIssueOrders: sampleIssues.map((row) => ({
              posOrderId: row.posOrderId,
              tenantName: resolveTenantName(row.tenantId),
              storeName: resolveStoreName(row.storeId),
              issueReason: sanitizeText(row.issueReason, 160),
              totalQuantity: row.totalQuantity,
              allocatedQuantity: row.allocatedQuantity,
              pickedQuantity: row.pickedQuantity,
              ageHours: Math.round(((now.getTime() - row.createdAt.getTime()) / 3600000) * 10) / 10,
              createdAt: row.createdAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
            })),
            reworkOrders: reworkRows.map((row) => ({
              posOrderId: row.posOrderId,
              tenantName: resolveTenantName(row.tenantId),
              storeName: resolveStoreName(row.storeId),
              status: row.status,
              changeState: row.changeState,
              changeDetectedAt: row.changeDetectedAt?.toISOString() || null,
              ageHours: row.changeDetectedAt
                ? Math.round(((now.getTime() - row.changeDetectedAt.getTime()) / 3600000) * 10) / 10
                : null,
            })),
            openAmendmentsByStage: openAmendments.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              detectedStage: row.detectedStage,
              count: row._count._all,
            })),
            agingBacklogOver12h: {
              countsByStatus: agingGroups.map((row) => ({
                tenantName: resolveTenantName(row.tenantId),
                status: row.status,
                count: row._count._all,
              })),
              oldestOrders: oldestAgingRows.map((row) => ({
                posOrderId: row.posOrderId,
                tenantName: resolveTenantName(row.tenantId),
                storeName: resolveStoreName(row.storeId),
                status: row.status,
                totalQuantity: row.totalQuantity,
                allocatedQuantity: row.allocatedQuantity,
                pickedQuantity: row.pickedQuantity,
                ageHours: Math.round(((now.getTime() - row.createdAt.getTime()) / 3600000) * 10) / 10,
                createdAt: row.createdAt.toISOString(),
              })),
            },
            manualAdjustmentsInWindow: adjustments.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              posOrderId: row.fulfillmentOrder.posOrderId,
              type: row.type,
              status: row.status,
              quantity: row.quantity,
              reason: sanitizeText(row.reason, 160),
              sourceProductName: row.sourceProductName,
              substituteProductName: row.substituteProductName,
              createdAt: row.createdAt.toISOString(),
            })),
          };
        },
      ),

      runSection(
        'wms.inventoryAndOps',
        {
          movementsByType: [],
          changeVariantTransfers: [],
          unitExceptionSnapshot: [],
          awaitingPutAwayOver24h: [],
          expiringWithin14Days: [],
          countSessions: { openOver24hCount: 0, discrepancySessionsInWindow: [] },
          receivingAndPurchasing: {
            receivingCompletedInWindow: 0,
            agingReceivingBatchesOver24h: [],
            purchasingAttentionCounts: [],
          },
          outboundAndRtsInWindow: [],
          dailyInventoryEmailHealth: [],
        },
        async () => {
          const [
            movementGroups,
            transferItems,
            unitExceptions,
            stalePutawayGroups,
            expiringSoonGroups,
            openCountSessionsOver24h,
            discrepancySessions,
            receivingCompletedCount,
            agingReceivingBatches,
            purchasingAttentionGroups,
            outboundGroups,
            emailSubscriptions,
          ] = await Promise.all([
            this.prisma.wmsInventoryMovement.groupBy({
              by: ['tenantId', 'movementType'],
              where: { createdAt: { gte: windowStart } },
              _count: { _all: true },
            }),
            this.prisma.wmsInventoryStoreTransferItem.findMany({
              where: { createdAt: { gte: windowStart } },
              select: {
                transferId: true,
                fromStoreId: true,
                toStoreId: true,
                fromProductProfileId: true,
                toProductProfileId: true,
                fromVariationId: true,
                toVariationId: true,
                createdAt: true,
                transfer: { select: { tenantId: true } },
              },
              orderBy: { createdAt: 'desc' },
              take: 1000,
            }),
            this.prisma.wmsInventoryUnit.groupBy({
              by: ['tenantId', 'status'],
              where: {
                status: {
                  in: [
                    WmsInventoryUnitStatus.EXPIRED,
                    WmsInventoryUnitStatus.DAMAGED,
                    WmsInventoryUnitStatus.LOST,
                    WmsInventoryUnitStatus.DEADSTOCK,
                    WmsInventoryUnitStatus.RTS,
                  ],
                },
              },
              _count: { _all: true },
            }),
            this.prisma.wmsInventoryUnit.groupBy({
              by: ['tenantId'],
              where: {
                status: { in: [WmsInventoryUnitStatus.RECEIVED, WmsInventoryUnitStatus.STAGED] },
                createdAt: { lt: stale24h },
              },
              _count: { _all: true },
            }),
            this.prisma.wmsInventoryUnit.groupBy({
              by: ['tenantId'],
              where: {
                status: WmsInventoryUnitStatus.PUTAWAY,
                expirationDate: { not: null, lte: expirySoonDate },
              },
              _count: { _all: true },
            }),
            this.prisma.wmsInventoryCountSession.count({
              where: {
                status: WmsInventoryCountSessionStatus.OPEN,
                startedAt: { lt: stale24h },
              },
            }),
            this.prisma.wmsInventoryCountSession.findMany({
              where: {
                updatedAt: { gte: windowStart },
                OR: [{ missingUnitCount: { gt: 0 } }, { unexpectedUnitCount: { gt: 0 } }],
              },
              select: {
                tenantId: true,
                status: true,
                expectedUnitCount: true,
                countedUnitCount: true,
                missingUnitCount: true,
                unexpectedUnitCount: true,
                updatedAt: true,
              },
              orderBy: { updatedAt: 'desc' },
              take: 15,
            }),
            this.prisma.wmsReceivingBatch.count({
              where: {
                status: WmsReceivingBatchStatus.COMPLETED,
                completedAt: { gte: windowStart },
              },
            }),
            this.prisma.wmsReceivingBatch.findMany({
              where: {
                status: {
                  in: [
                    WmsReceivingBatchStatus.DRAFT,
                    WmsReceivingBatchStatus.ARRIVED,
                    WmsReceivingBatchStatus.COUNTED,
                    WmsReceivingBatchStatus.STAGED,
                    WmsReceivingBatchStatus.PUTAWAY_PENDING,
                  ],
                },
                createdAt: { lt: stale24h },
              },
              select: {
                code: true,
                tenantId: true,
                storeId: true,
                status: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
              take: 15,
            }),
            this.prisma.wmsPurchasingBatch.groupBy({
              by: ['tenantId', 'status'],
              where: {
                status: {
                  in: [
                    WmsPurchasingBatchStatus.RECEIVING_EXCEPTION,
                    WmsPurchasingBatchStatus.REVISION,
                    WmsPurchasingBatchStatus.UNDER_REVIEW,
                    WmsPurchasingBatchStatus.PAYMENT_REVIEW,
                  ],
                },
              },
              _count: { _all: true },
            }),
            this.prisma.wmsOutboundUnitRecord.groupBy({
              by: ['tenantId', 'currentStatus'],
              where: { latestEventAt: { gte: windowStart } },
              _count: { _all: true },
            }),
            tenants.length > 0
              ? this.wmsReportsService.getSubscriptionsForTenants(tenants.map((t) => t.id))
              : Promise.resolve([]),
          ]);

          const profileIds = Array.from(
            new Set(
              transferItems.flatMap((i) => [i.fromProductProfileId, i.toProductProfileId]),
            ),
          );
          const profiles = profileIds.length
            ? await this.prisma.wmsProductProfile.findMany({
                where: { id: { in: profileIds } },
                select: {
                  id: true,
                  stockPoolGroupId: true,
                  posProduct: { select: { name: true } },
                },
              })
            : [];
          const profileMap = new Map(profiles.map((p) => [p.id, p]));

          const transferPairs = new Map<
            string,
            {
              tenantName: string;
              fromStoreName: string;
              toStoreName: string;
              fromProductName: string;
              fromVariationId: string;
              toProductName: string;
              toVariationId: string;
              sharedPoolLinked: boolean;
              transferIds: Set<string>;
              unitsMoved: number;
              latestAt: string;
            }
          >();
          for (const item of transferItems) {
            const fromProfile = profileMap.get(item.fromProductProfileId);
            const toProfile = profileMap.get(item.toProductProfileId);
            const sharedPoolLinked = Boolean(
              fromProfile?.stockPoolGroupId &&
                toProfile?.stockPoolGroupId &&
                fromProfile.stockPoolGroupId === toProfile.stockPoolGroupId,
            );
            const key = `${item.fromProductProfileId}::${item.toProductProfileId}`;
            const entry = transferPairs.get(key) || {
              tenantName: resolveTenantName(item.transfer.tenantId),
              fromStoreName: resolveStoreName(item.fromStoreId),
              toStoreName: resolveStoreName(item.toStoreId),
              fromProductName: fromProfile?.posProduct?.name || item.fromVariationId,
              fromVariationId: item.fromVariationId,
              toProductName: toProfile?.posProduct?.name || item.toVariationId,
              toVariationId: item.toVariationId,
              sharedPoolLinked,
              transferIds: new Set<string>(),
              unitsMoved: 0,
              latestAt: item.createdAt.toISOString(),
            };
            entry.transferIds.add(item.transferId);
            entry.unitsMoved += 1;
            if (item.createdAt.toISOString() > entry.latestAt) {
              entry.latestAt = item.createdAt.toISOString();
            }
            transferPairs.set(key, entry);
          }

          return {
            movementsByType: movementGroups.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              movementType: row.movementType,
              count: row._count._all,
            })),
            changeVariantTransfers: Array.from(transferPairs.values())
              .map((entry) => ({
                tenantName: entry.tenantName,
                fromStoreName: entry.fromStoreName,
                toStoreName: entry.toStoreName,
                fromProductName: entry.fromProductName,
                fromVariationId: entry.fromVariationId,
                toProductName: entry.toProductName,
                toVariationId: entry.toVariationId,
                sharedPoolLinked: entry.sharedPoolLinked,
                transferBatchCount: entry.transferIds.size,
                unitsMoved: entry.unitsMoved,
                latestAt: entry.latestAt,
              }))
              .sort((a, b) => b.unitsMoved - a.unitsMoved)
              .slice(0, 25),
            unitExceptionSnapshot: unitExceptions.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              status: row.status,
              count: row._count._all,
            })),
            awaitingPutAwayOver24h: stalePutawayGroups.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              unitsCount: row._count._all,
            })),
            expiringWithin14Days: expiringSoonGroups.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              unitsCount: row._count._all,
            })),
            countSessions: {
              openOver24hCount: openCountSessionsOver24h,
              discrepancySessionsInWindow: discrepancySessions.map((row) => ({
                tenantName: resolveTenantName(row.tenantId),
                status: row.status,
                expectedUnitCount: row.expectedUnitCount,
                countedUnitCount: row.countedUnitCount,
                missingUnitCount: row.missingUnitCount,
                unexpectedUnitCount: row.unexpectedUnitCount,
                updatedAt: row.updatedAt.toISOString(),
              })),
            },
            receivingAndPurchasing: {
              receivingCompletedInWindow: receivingCompletedCount,
              agingReceivingBatchesOver24h: agingReceivingBatches.map((row) => ({
                code: row.code,
                tenantName: resolveTenantName(row.tenantId),
                storeName: resolveStoreName(row.storeId),
                status: row.status,
                ageHours: Math.round(((now.getTime() - row.createdAt.getTime()) / 3600000) * 10) / 10,
                createdAt: row.createdAt.toISOString(),
              })),
              purchasingAttentionCounts: purchasingAttentionGroups.map((row) => ({
                tenantName: resolveTenantName(row.tenantId),
                status: row.status,
                count: row._count._all,
              })),
            },
            outboundAndRtsInWindow: outboundGroups.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              currentStatus: row.currentStatus,
              count: row._count._all,
            })),
            dailyInventoryEmailHealth: emailSubscriptions
              .filter((sub) => sub.enabled || sub.lastDeliveryStatus === 'FAILED')
              .map((sub) => ({
                tenantName: sub.tenantName,
                enabled: sub.enabled,
                recipientCount: sub.effectiveRecipients.length,
                sendTimeManila: sub.sendTimeManila,
                lastSentDate: sub.lastSentDate,
                lastDeliveryStatus: sub.lastDeliveryStatus,
                lastError: sanitizeText(sub.lastError, 160),
              })),
          };
        },
      ),

      runSection(
        'erp.auditAndAnalytics',
        { auditActions: [], analyticsEvents: [] },
        async () => {
          const [auditGroups, analyticsGroups] = await Promise.all([
            this.prisma.auditLog.groupBy({
              by: ['tenantId', 'resource', 'action'],
              where: { createdAt: { gte: windowStart } },
              _count: { _all: true },
            }),
            this.prisma.analyticsEvent.groupBy({
              by: ['tenantId', 'eventType'],
              where: { timestamp: { gte: windowStart } },
              _count: { _all: true },
            }),
          ]);

          return {
            auditActions: auditGroups
              .map((row) => ({
                tenantName: resolveTenantName(row.tenantId),
                resource: row.resource,
                action: row.action,
                count: row._count._all,
              }))
              .sort((a, b) => b.count - a.count)
              .slice(0, 30),
            analyticsEvents: analyticsGroups
              .map((row) => ({
                tenantName: resolveTenantName(row.tenantId),
                eventType: row.eventType,
                count: row._count._all,
              }))
              .sort((a, b) => b.count - a.count)
              .slice(0, 20),
          };
        },
      ),

      runSection(
        'erp.posOrdersAndCogs',
        {
          ordersByTenantInWindow: [],
          zeroCogsProductsLast7d: [],
          undeliverables: { attemptsInWindowByTenant: [], unremarkedBacklogByTenant: [] },
        },
        async () => {
          const [orderSummaryRows, zeroCogsRows, undeliverableInWindow, unremarkedUndeliverables] =
            await Promise.all([
              this.prisma.$queryRaw<
                Array<{
                  tenantId: string;
                  ordersCount: number;
                  nonVoidCount: number;
                  voidCount: number;
                  undeliverableCount: number;
                  rtsCount: number;
                  zeroCogsNonVoidCount: number;
                  arrivalP50Seconds: number | null;
                  arrivalP95Seconds: number | null;
                  arrivalMaxSeconds: number | null;
                  arrivalOver10mCount: number;
                  arrivalOver1hCount: number;
                }>
              >`
                SELECT
                  o."tenantId" AS "tenantId",
                  COUNT(*)::int AS "ordersCount",
                  COUNT(*) FILTER (WHERE o."isVoid" = false)::int AS "nonVoidCount",
                  COUNT(*) FILTER (WHERE o."isVoid" = true)::int AS "voidCount",
                  COUNT(*) FILTER (WHERE o."isUndeliverable" = true)::int AS "undeliverableCount",
                  COUNT(*) FILTER (WHERE o."rtsAt" IS NOT NULL)::int AS "rtsCount",
                  COUNT(*) FILTER (WHERE o."isVoid" = false AND o."totalQuantity" > 0 AND o."cogs" <= 0)::int AS "zeroCogsNonVoidCount",
                  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o."createdAt" - o."insertedAt"))))::int AS "arrivalP50Seconds",
                  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o."createdAt" - o."insertedAt"))))::int AS "arrivalP95Seconds",
                  ROUND(MAX(EXTRACT(EPOCH FROM (o."createdAt" - o."insertedAt"))))::int AS "arrivalMaxSeconds",
                  COUNT(*) FILTER (WHERE o."createdAt" - o."insertedAt" > interval '10 minutes')::int AS "arrivalOver10mCount",
                  COUNT(*) FILTER (WHERE o."createdAt" - o."insertedAt" > interval '1 hour')::int AS "arrivalOver1hCount"
                FROM pos_orders o
                WHERE o."insertedAt" >= ${windowStart}
                GROUP BY o."tenantId"
                ORDER BY "ordersCount" DESC
              `,
              this.prisma.$queryRaw<
                Array<{
                  tenantId: string;
                  shopId: string;
                  mapping: string | null;
                  ordersCount: number;
                  unitsCount: number;
                  latestDateLocal: string | null;
                }>
              >`
                SELECT
                  o."tenantId" AS "tenantId",
                  o."shopId" AS "shopId",
                  COALESCE(NULLIF(TRIM(o."mapping"), ''), '(unmapped)') AS "mapping",
                  COUNT(*)::int AS "ordersCount",
                  COALESCE(SUM(o."totalQuantity"), 0)::int AS "unitsCount",
                  MAX(o."dateLocal") AS "latestDateLocal"
                FROM pos_orders o
                WHERE o."insertedAt" >= ${last7d}
                  AND o."isVoid" = false
                  AND o."totalQuantity" > 0
                  AND o."cogs" <= 0
                GROUP BY o."tenantId", o."shopId", COALESCE(NULLIF(TRIM(o."mapping"), ''), '(unmapped)')
                ORDER BY "ordersCount" DESC
                LIMIT 20
              `,
              this.prisma.undeliverableAttempt.groupBy({
                by: ['tenantId'],
                where: { failedAt: { gte: windowStart } },
                _count: { _all: true },
              }),
              this.prisma.undeliverableAttempt.groupBy({
                by: ['tenantId'],
                where: { remarkedAt: null },
                _count: { _all: true },
              }),
            ]);

          const storeByShopId = new Map(stores.map((s) => [`${s.tenantId}::${s.shopId}`, s.name]));

          return {
            ordersByTenantInWindow: orderSummaryRows.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              ordersCount: row.ordersCount,
              nonVoidCount: row.nonVoidCount,
              voidCount: row.voidCount,
              undeliverableCount: row.undeliverableCount,
              rtsCount: row.rtsCount,
              zeroCogsNonVoidCount: row.zeroCogsNonVoidCount,
              arrivalP50Seconds: row.arrivalP50Seconds,
              arrivalP95Seconds: row.arrivalP95Seconds,
              arrivalMaxSeconds: row.arrivalMaxSeconds,
              arrivalOver10mCount: row.arrivalOver10mCount,
              arrivalOver1hCount: row.arrivalOver1hCount,
            })),
            zeroCogsProductsLast7d: zeroCogsRows.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              storeName: storeByShopId.get(`${row.tenantId}::${row.shopId}`) || `Shop ${row.shopId}`,
              shopId: row.shopId,
              mapping: row.mapping || '(unmapped)',
              ordersCount: row.ordersCount,
              unitsCount: row.unitsCount,
              latestDateLocal: row.latestDateLocal,
            })),
            undeliverables: {
              attemptsInWindowByTenant: undeliverableInWindow.map((row) => ({
                tenantName: resolveTenantName(row.tenantId),
                attemptsInWindow: row._count._all,
              })),
              unremarkedBacklogByTenant: unremarkedUndeliverables.map((row) => ({
                tenantName: resolveTenantName(row.tenantId),
                unremarkedCount: row._count._all,
              })),
            },
          };
        },
      ),

      runSection(
        'erp.integrationsAndWebhooks',
        {
          unhealthyIntegrations: [],
          unhealthyPosStores: [],
          unhealthyMetaAccounts: [],
          webhooksByTenantInWindow: [],
          recentWebhookErrors: [],
          posOrderSyncRecovery: { byState: [], recoveredInWindow: 0, unresolvedByErrorCode: [] },
        },
        async () => {
          const [
            unhealthyIntegrations,
            unhealthyMetaAccounts,
            webhookStats,
            recentWebhookErrors,
            recoveryByState,
            recoveredInWindow,
            unresolvedRecoveries,
          ] = await Promise.all([
            this.prisma.integration.findMany({
              where: {
                OR: [
                  { status: IntegrationStatus.ERROR },
                  { syncError: { not: null } },
                  { enabled: true, lastSyncAt: { lt: stale36h } },
                ],
              },
              select: {
                tenantId: true,
                name: true,
                provider: true,
                status: true,
                enabled: true,
                lastSyncAt: true,
                syncStatus: true,
                syncError: true,
              },
              orderBy: { updatedAt: 'desc' },
              take: 25,
            }),
            this.prisma.metaAdAccount.findMany({
              where: {
                OR: [
                  { status: IntegrationStatus.ERROR },
                  { enabled: true, lastSyncAt: { lt: stale36h } },
                ],
              },
              select: {
                tenantId: true,
                accountId: true,
                name: true,
                status: true,
                enabled: true,
                lastSyncAt: true,
              },
              orderBy: { updatedAt: 'desc' },
              take: 25,
            }),
            this.prisma.$queryRaw<
              Array<{
                tenantId: string | null;
                webhooks: number;
                unprocessed: number;
                failedCount: number;
                warningCount: number;
                ingestWaitP50s: number | null;
                ingestWaitP95s: number | null;
                processingP95Ms: number | null;
                lastReceivedAt: Date | null;
              }>
            >`
              SELECT
                l."tenantId" AS "tenantId",
                COUNT(*)::int AS "webhooks",
                COUNT(*) FILTER (WHERE l."processedAt" IS NULL)::int AS "unprocessed",
                COUNT(*) FILTER (WHERE l."errorCode" IS NOT NULL OR l."processStatus" IN ('FAILED', 'ERROR'))::int AS "failedCount",
                COALESCE(SUM(l."warningCount"), 0)::int AS "warningCount",
                ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (l."processingStartedAt" - l."receivedAt"))))::int AS "ingestWaitP50s",
                ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (l."processingStartedAt" - l."receivedAt"))))::int AS "ingestWaitP95s",
                ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY l."processingDurationMs"))::int AS "processingP95Ms",
                MAX(l."receivedAt") AS "lastReceivedAt"
              FROM pancake_webhook_logs l
              WHERE l."receivedAt" >= ${windowStart}
              GROUP BY l."tenantId"
              ORDER BY "webhooks" DESC
            `,
            this.prisma.pancakeWebhookLog.findMany({
              where: {
                receivedAt: { gte: windowStart },
                OR: [
                  { errorCode: { not: null } },
                  { processStatus: { in: ['FAILED', 'ERROR'] } },
                ],
              },
              select: {
                tenantId: true,
                source: true,
                receiveStatus: true,
                processStatus: true,
                errorCode: true,
                errorMessage: true,
                receivedAt: true,
              },
              orderBy: { receivedAt: 'desc' },
              take: 15,
            }),
            this.prisma.posOrderSyncRecovery.groupBy({
              by: ['state'],
              _count: { _all: true },
            }),
            this.prisma.posOrderSyncRecovery.count({
              where: { recoveredAt: { gte: windowStart } },
            }),
            this.prisma.posOrderSyncRecovery.groupBy({
              by: ['tenantId', 'state', 'lastErrorCode'],
              where: { state: { not: 'RECOVERED' } },
              _count: { _all: true },
              _max: { lastErrorAt: true },
            }),
          ]);

          const unhealthyStores = stores
            .filter(
              (s) =>
                s.status === IntegrationStatus.ERROR ||
                (s.enabled !== false && s.lastSyncAt && s.lastSyncAt < stale36h),
            )
            .slice(0, 25);

          return {
            unhealthyIntegrations: unhealthyIntegrations.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              name: row.name,
              provider: row.provider,
              status: row.status,
              enabled: row.enabled,
              lastSyncAt: row.lastSyncAt?.toISOString() || null,
              syncStatus: row.syncStatus,
              syncError: sanitizeText(row.syncError, 180),
            })),
            unhealthyPosStores: unhealthyStores.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              storeName: row.name,
              shopId: row.shopId,
              status: row.status,
              enabled: row.enabled,
              lastSyncAt: row.lastSyncAt?.toISOString() || null,
            })),
            unhealthyMetaAccounts: unhealthyMetaAccounts.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              accountId: row.accountId,
              name: row.name,
              status: row.status,
              enabled: row.enabled,
              lastSyncAt: row.lastSyncAt?.toISOString() || null,
            })),
            webhooksByTenantInWindow: webhookStats.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              webhooks: row.webhooks,
              unprocessed: row.unprocessed,
              failedCount: row.failedCount,
              warningCount: row.warningCount,
              ingestWaitP50s: row.ingestWaitP50s,
              ingestWaitP95s: row.ingestWaitP95s,
              processingP95Ms: row.processingP95Ms,
              lastReceivedAt: row.lastReceivedAt?.toISOString() || null,
            })),
            recentWebhookErrors: recentWebhookErrors.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              source: row.source,
              receiveStatus: row.receiveStatus,
              processStatus: row.processStatus,
              errorCode: row.errorCode,
              errorMessage: sanitizeText(row.errorMessage, 180),
              receivedAt: row.receivedAt.toISOString(),
            })),
            posOrderSyncRecovery: {
              byState: recoveryByState.map((row) => ({
                state: row.state,
                count: row._count._all,
              })),
              recoveredInWindow,
              unresolvedByErrorCode: unresolvedRecoveries.map((row) => ({
                tenantName: resolveTenantName(row.tenantId),
                state: row.state,
                lastErrorCode: row.lastErrorCode || 'UNKNOWN',
                count: row._count._all,
                latestErrorAt: row._max.lastErrorAt?.toISOString() || null,
              })),
            },
          };
        },
      ),

      runSection(
        'erp.workflowsAndCreativeAi',
        {
          workflowExecutionsByStatus: [],
          stalledWorkflowsOver2hCount: 0,
          recentFailedWorkflows: [],
          creativeAiRunsByStatus: [],
          recentFailedCreativeAiRuns: [],
        },
        async () => {
          const [
            workflowGroups,
            stalledWorkflowsCount,
            failedWorkflows,
            creativeAiGroups,
            failedCreativeRuns,
          ] = await Promise.all([
            this.prisma.workflowExecution.groupBy({
              by: ['tenantId', 'status'],
              where: { createdAt: { gte: windowStart } },
              _count: { _all: true },
            }),
            this.prisma.workflowExecution.count({
              where: {
                status: WorkflowExecutionStatus.RUNNING,
                startedAt: { lt: stale2h },
              },
            }),
            this.prisma.workflowExecution.findMany({
              where: {
                createdAt: { gte: windowStart },
                status: WorkflowExecutionStatus.FAILED,
              },
              select: {
                tenantId: true,
                triggerType: true,
                status: true,
                errors: true,
                startedAt: true,
                duration: true,
                createdAt: true,
                workflow: { select: { name: true } },
              },
              orderBy: { createdAt: 'desc' },
              take: 15,
            }),
            this.prisma.creativeAiRun.groupBy({
              by: ['tenantId', 'status'],
              where: { createdAt: { gte: windowStart } },
              _count: { _all: true },
            }),
            this.prisma.creativeAiRun.findMany({
              where: {
                createdAt: { gte: windowStart },
                status: CreativeAiRunStatus.FAILED,
              },
              select: {
                tenantId: true,
                provider: true,
                model: true,
                stage: true,
                errorMessage: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'desc' },
              take: 10,
            }),
          ]);

          return {
            workflowExecutionsByStatus: workflowGroups.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              status: row.status,
              count: row._count._all,
            })),
            stalledWorkflowsOver2hCount: stalledWorkflowsCount,
            recentFailedWorkflows: failedWorkflows.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              workflowName: row.workflow.name,
              triggerType: row.triggerType,
              status: row.status,
              startedAt: row.startedAt?.toISOString() || row.createdAt.toISOString(),
              durationMs: row.duration,
              errorSummary: sanitizeText(row.errors, 220),
            })),
            creativeAiRunsByStatus: creativeAiGroups.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              status: row.status,
              count: row._count._all,
            })),
            recentFailedCreativeAiRuns: failedCreativeRuns.map((row) => ({
              tenantName: resolveTenantName(row.tenantId),
              provider: row.provider,
              model: row.model,
              stage: row.stage,
              errorMessage: sanitizeText(row.errorMessage, 200),
              createdAt: row.createdAt.toISOString(),
            })),
          };
        },
      ),

      runSection('infrastructure.redisQueues', [], async () => this.inspectRedisQueues()),
    ]);

    return {
      meta: {
        generatedAt: now.toISOString(),
        timezone: MANILA_TZ,
        manilaNow: dayjs(now).tz(MANILA_TZ).format('YYYY-MM-DD HH:mm:ss'),
        windowHours,
        windowStart: windowStart.toISOString(),
        windowEnd: now.toISOString(),
        activeTenantCount: tenants.length,
        activeTenants: tenants.map((t) => ({
          name: t.name,
          slug: t.slug,
          status: t.status,
          planType: t.planType,
          wmsFulfillmentGoLiveAt: t.wmsFulfillmentGoLiveAt?.toISOString() || null,
        })),
        collectionWarnings,
      },
      wms: {
        staffActivities: wmsStaffActivities,
        fulfillment: wmsFulfillment,
        inventoryAndOps: wmsInventoryAndOps,
      },
      erp: {
        auditAndAnalytics: erpAuditAndAnalytics,
        posOrdersAndCogs: erpPosOrdersAndCogs,
        integrationsAndWebhooks: erpIntegrationsAndWebhooks,
        workflowsAndCreativeAi: erpWorkflowsAndCreativeAi,
      },
      infrastructure: {
        redisQueues,
      },
    };
  }

  async sendDailyDigestEmail(dto: SendOpsDailyDigestEmailDto) {
    const rawRecipients = (process.env.OPS_DIGEST_EMAIL_TO || DEFAULT_OPS_RECIPIENT)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    if (rawRecipients.length === 0) {
      throw new BadRequestException('No ops digest email recipients configured');
    }

    const from = process.env.DAILY_REPORT_EMAIL_FROM || DEFAULT_FROM_EMAIL;
    const resendKey = (process.env.RESEND_API_KEY || '').trim();
    if (!resendKey) {
      throw new BadRequestException('RESEND_API_KEY is not configured on the API server');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: rawRecipients,
        subject: dto.subject.trim(),
        html: dto.html,
        text: dto.text,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new BadRequestException(`Resend API error (${response.status}): ${sanitizeText(body, 200)}`);
    }

    const result = (await response.json().catch(() => ({}))) as { id?: string };
    this.logger.log(
      `Ops daily digest email sent to [${rawRecipients.join(', ')}] subject="${dto.subject.trim()}" id=${result.id || 'n/a'}`,
    );

    return {
      delivered: true,
      mode: 'RESEND' as const,
      recipients: rawRecipients,
      messageId: result.id || null,
      sentAt: new Date().toISOString(),
    };
  }

  private async inspectRedisQueues() {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const redis = new Redis({
      host,
      port,
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
      connectTimeout: 4000,
      maxRetriesPerRequest: 1,
    });

    try {
      await redis.connect();
      const snapshots: Array<{
        queue: string;
        wait: number;
        active: number;
        delayed: number;
        failed: number;
        paused: number;
        oldestWaitingAgeSeconds: number | null;
        recentFailures: Array<{ at: string | null; reason: string | null }>;
      }> = [];
      for (const queue of BULL_QUEUES) {
        const [wait, active, delayed, failed, paused] = await Promise.all([
          redis.llen(`bull:${queue}:wait`),
          redis.llen(`bull:${queue}:active`),
          redis.zcard(`bull:${queue}:delayed`),
          redis.zcard(`bull:${queue}:failed`),
          redis.llen(`bull:${queue}:paused`),
        ]);
        const oldestWaitId = wait > 0 ? await redis.lindex(`bull:${queue}:wait`, -1) : null;
        const oldestTs = oldestWaitId ? await redis.hget(`bull:${queue}:${oldestWaitId}`, 'timestamp') : null;
        const recentFailedIds = failed > 0 ? await redis.zrevrange(`bull:${queue}:failed`, 0, 2) : [];
        const recentFailures = await Promise.all(
          recentFailedIds.map(async (jobId) => {
            const [reason, finishedOn] = await Promise.all([
              redis.hget(`bull:${queue}:${jobId}`, 'failedReason'),
              redis.hget(`bull:${queue}:${jobId}`, 'finishedOn'),
            ]);
            return {
              at: finishedOn ? new Date(Number(finishedOn)).toISOString() : null,
              reason: sanitizeText(reason, 180),
            };
          }),
        );

        snapshots.push({
          queue,
          wait,
          active,
          delayed,
          failed,
          paused,
          oldestWaitingAgeSeconds: oldestTs ? Math.round((Date.now() - Number(oldestTs)) / 1000) : null,
          recentFailures,
        });
      }
      return snapshots;
    } finally {
      redis.disconnect();
    }
  }
}

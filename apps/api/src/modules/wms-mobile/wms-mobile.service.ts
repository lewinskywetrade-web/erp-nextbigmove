import { InjectQueue } from '@nestjs/bull';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Queue } from 'bull';
import { randomUUID } from 'crypto';
import {
  IntegrationStatus,
  MediaAssetKind,
  Prisma,
  UserStatus,
  WmsBasketStatus,
  WmsBasketUnitStatus,
  WmsFulfillmentAssignmentMode,
  WmsFulfillmentAmendmentStatus,
  WmsFulfillmentChangeState,
  WmsStaffAssignmentTaskType,
  WmsStaffActivityOutcome,
  TenantStatus,
  WmsFulfillmentLineStatus,
  WmsFulfillmentOrderStatus,
  WmsInventoryCountEntryStatus,
  WmsInventoryCountSessionStatus,
  WmsInventoryMovementType,
  WmsInventoryUnitStatus,
  WmsLocationKind,
  WmsPackingProofSource,
  WmsPickReservationStatus,
  WmsReceivingBatchStatus,
  WmsTransferStatus,
  WmsWarehouseStatus,
} from '@prisma/client';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EffectiveAccessService } from '../../common/services/effective-access.service';
import { MediaAssetsService, type UploadedImageFile } from '../../common/services/media-assets.service';
import { WmsStaffActivityService } from '../../common/services/wms-staff-activity.service';
import { OrdersService } from '../orders/orders.service';
import { IntegrationService } from '../integrations/integration.service';
import { WmsFulfillmentOpsService } from '../wms-fulfillment/wms-fulfillment-ops.service';
import { WmsFulfillmentSyncService } from '../wms-fulfillment/wms-fulfillment-sync.service';
import {
  EMPTY_STOCK_POOL_INDEX,
  loadTenantStockPoolIndex,
  type TenantStockPoolIndex,
} from '../wms-fulfillment/wms-stock-pool.util';
import {
  buildUnexpiredInventoryWhere,
  isExpiredInventoryDate,
} from '../wms-inventory/wms-inventory-expiration.utils';
import { WmsInventoryService } from '../wms-inventory/wms-inventory.service';
import {
  deriveReceivingBatchStatus,
  RECEIVING_BATCH_COMPLETED_BIN_UNIT_STATUSES,
  RECEIVING_BATCH_COMPLETED_NON_BIN_UNIT_STATUSES,
} from '../wms-receiving/wms-receiving-batch-status.util';
import { WmsStoxReleasesService } from '../wms-settings/wms-stox-releases.service';
import {
  GetWmsMobileStockDto,
  type WmsMobileStockMode,
} from './dto/get-wms-mobile-stock.dto';
import {
  GetWmsMobileHomeInventorySummaryDto,
  GetWmsMobileRtsTasksDto,
  WmsMobileCloseoutStockCountDto,
  GetWmsMobileStockCountSessionsDto,
  GetWmsMobileHomeTaskSummaryDto,
  GetWmsMobileStockScanDto,
  GetWmsMobileStockScopedDto,
  GetWmsMobileTrackingLookupDto,
  WmsMobileReopenStockCountDto,
  WmsMobileScanStockCountUnitDto,
  WmsMobileStartStockCountDto,
  WmsMobileTrackingReturnDispositionDto,
  WmsMobileTrackingReturnUnitDto,
  WmsMobileSubmitStockCountDto,
  WmsMobileStockMoveDto,
} from './dto/wms-mobile-stock-execution.dto';
import {
  GetWmsMobilePickBasketLookupDto,
  GetWmsMobilePickingTasksDto,
  WmsMobilePickBasketBatchAssignDto,
  WmsMobilePickBasketUnitScanDto,
  WmsMobilePickBasketVoidDto,
  WmsMobilePickHandoffDto,
  WmsMobileFulfillmentDetachReturnDto,
  WmsMobileFulfillmentDetachStartDto,
  WmsMobileFulfillmentReworkReturnDto,
  WmsMobilePickReallocateDto,
  WmsMobilePickResyncDto,
  WmsMobilePickScanDto,
  WmsMobilePickScopedDto,
} from './dto/wms-mobile-picking.dto';
import {
  GetWmsMobilePackingTasksDto,
  WmsMobilePackBasketVoidDto,
  WmsMobilePackBasketOrderCompleteDto,
  WmsMobilePackCompleteDto,
  WmsPackingProofUploadDto,
  WmsMobilePackScanDto,
  WmsMobilePackScopedDto,
  WmsMobilePackVoidDto,
} from './dto/wms-mobile-packing.dto';
import {
  GetWmsMobileHistoryFeedDto,
  type WmsMobileHistoryTypeFilter,
} from './dto/wms-mobile-history.dto';
import {
  WMS_PACKING_POST_COMPLETE_QUEUE,
  WMS_PACKING_POST_COMPLETE_SYNC_JOB,
  WMS_PICKING_HANDOFF_QUEUE,
  WMS_PICKING_HANDOFF_WAITING_FOR_PRINTING_JOB,
  type WmsPackingPostCompleteJobData,
  type WmsPickingHandoffWaitingForPrintingJobData,
} from './wms-mobile.constants';

type BootstrapUser = {
  userId?: string;
  id?: string;
  email?: string;
  tenantId?: string | null;
  role?: string;
  permissions?: string[];
  firstName?: string | null;
  lastName?: string | null;
  avatar?: string | null;
  employeeId?: string | null;
  defaultTeamId?: string | null;
  sessionId?: string | null;
};

type MobileTenantOption = {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
};

const STOCK_PUTAWAY_BATCH_STATUSES = [
  WmsReceivingBatchStatus.STAGED,
  WmsReceivingBatchStatus.PUTAWAY_PENDING,
] as const;

const STOCK_TRANSFERABLE_UNIT_STATUSES = [
  WmsInventoryUnitStatus.RECEIVED,
  WmsInventoryUnitStatus.STAGED,
  WmsInventoryUnitStatus.PUTAWAY,
  WmsInventoryUnitStatus.EXPIRED,
  WmsInventoryUnitStatus.DEADSTOCK,
  WmsInventoryUnitStatus.RTS,
  WmsInventoryUnitStatus.DAMAGED,
] as const;
const MOBILE_UNITS_ON_HAND_EXCLUDED_STATUSES = [
  WmsInventoryUnitStatus.RECEIVED,
  WmsInventoryUnitStatus.STAGED,
  WmsInventoryUnitStatus.DISPATCHED,
  WmsInventoryUnitStatus.DAMAGED,
  WmsInventoryUnitStatus.LOST,
  WmsInventoryUnitStatus.ARCHIVED,
] as const;
const FULFILLABLE_UNIT_STATUSES = [
  WmsInventoryUnitStatus.PUTAWAY,
] as const;
const RETURNED_EQUIVALENT_UNIT_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.RTS,
  WmsInventoryUnitStatus.STAGED,
  WmsInventoryUnitStatus.PUTAWAY,
  WmsInventoryUnitStatus.DEADSTOCK,
  WmsInventoryUnitStatus.DAMAGED,
  WmsInventoryUnitStatus.LOST,
  WmsInventoryUnitStatus.ARCHIVED,
]);

const DEFAULT_STOCK_PAGE_SIZE = 12;
const MOBILE_PUTAWAY_SOURCE_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.RECEIVED,
  WmsInventoryUnitStatus.STAGED,
]);
const MOBILE_MOVE_DESTINATION_KINDS = new Set<WmsLocationKind>([
  WmsLocationKind.BIN,
  WmsLocationKind.RECEIVING_STAGING,
  WmsLocationKind.PACKING,
  WmsLocationKind.DISPATCH_STAGING,
  WmsLocationKind.RTS,
  WmsLocationKind.DAMAGE,
  WmsLocationKind.QUARANTINE,
]);

const DEFAULT_PICKING_PAGE_SIZE = 10;
const DEFAULT_PACKING_PAGE_SIZE = 10;
const DEFAULT_RTS_PAGE_SIZE = 10;
const CONFIRMED_POS_ORDER_STATUS = 1;
const WAITING_FOR_PRINTING_POS_ORDER_STATUS = 12;
const CANCELED_POS_ORDER_STATUS = 6;
const SHIPPED_EQUIVALENT_POS_ORDER_STATUSES = [2, 3, 4, 5] as const;
const PICKING_SYNC_ORDER_LIMIT = 80;
const BASKET_ASSIGN_TRANSACTION_MAX_WAIT_MS = 5000;
const BASKET_ASSIGN_TRANSACTION_TIMEOUT_MS = 30000;
const BASKET_ASSIGN_TRANSACTION_MAX_ATTEMPTS = 3;
const SLOW_BASKET_ASSIGN_THRESHOLD_MS = 2000;
const ACTIVE_PICKING_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.READY,
  WmsFulfillmentOrderStatus.PARTIAL,
  WmsFulfillmentOrderStatus.RESTOCKING,
  WmsFulfillmentOrderStatus.ISSUE,
  WmsFulfillmentOrderStatus.IN_PICKING,
] as const;
const ACTIVE_PICK_RESERVATION_STATUSES = [
  WmsPickReservationStatus.RESERVED,
  WmsPickReservationStatus.PICKED,
] as const;
const ACTIVE_PICK_BASKET_STATUSES = [
  WmsBasketStatus.ASSIGNED,
  WmsBasketStatus.IN_PICKING,
  WmsBasketStatus.FULL_HELD,
] as const;
const ACTIVE_BASKET_UNIT_STATUSES = [
  WmsBasketUnitStatus.PICKED,
  WmsBasketUnitStatus.PACKED,
] as const;

function isBasketAssignmentTransactionConflict(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    return true;
  }

  if (!error) {
    return false;
  }

  const errorCode = typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  const errorText = error instanceof Error
    ? `${error.message}\n${error.stack ?? ''}`
    : String(error);

  return errorCode === '40P01' || /\b40P01\b|deadlock detected/i.test(errorText);
}
const PICKER_ACTIVE_BASKET_STATUSES = [
  WmsBasketStatus.ASSIGNED,
  WmsBasketStatus.IN_PICKING,
] as const;
const PICKER_ACTIVE_BASKET_STATUS_SET = new Set<WmsBasketStatus>(PICKER_ACTIVE_BASKET_STATUSES);
const BLOCKED_PICK_BASKET_STATUSES = [
  WmsBasketStatus.DAMAGED,
  WmsBasketStatus.RETIRED,
] as const;
const PACK_QUEUE_BASKET_STATUSES = [
  WmsBasketStatus.FULL_HELD,
  WmsBasketStatus.PACKING,
] as const;
const PACK_QUEUE_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.PICKED,
  WmsFulfillmentOrderStatus.PACKING,
] as const;
const PACK_LIST_ORDER_STATUSES = [
  ...PACK_QUEUE_ORDER_STATUSES,
  WmsFulfillmentOrderStatus.PACKED,
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
const PICK_ASSIGNMENT_PERMISSIONS = [
  'wms.fulfillment.write',
  'wms.fulfillment.edit',
  'wms.fulfillment.override',
] as const;
const PICK_SUPERVISOR_PERMISSIONS = [
  'wms.fulfillment.override',
] as const;
const PACK_HANDOFF_PERMISSIONS = [
  'wms.dispatch.write',
  'wms.dispatch.edit',
  'wms.dispatch.override',
] as const;
const PACK_VOID_DIRECT_PERMISSIONS = [
  'wms.dispatch.void',
  'wms.dispatch.override',
] as const;
const PACK_SUPERVISOR_PERMISSIONS = [
  'wms.dispatch.override',
] as const;
const RTS_VERIFY_ACTION_PERMISSIONS = [
  'wms.dispatch.write',
  'wms.dispatch.edit',
  'wms.dispatch.override',
] as const;
const RTS_DISPOSITION_ACTION_PERMISSIONS = [
  'wms.rts.disposition',
  'wms.dispatch.override',
] as const;
const HISTORY_READ_ALL_PERMISSIONS = [
  'wms.history.read_all',
] as const;
const DEFAULT_HISTORY_PAGE_SIZE = 20;
const HISTORY_PICK_ACTION_TYPES = [
  'PICKING_CLAIM',
  'PICKING_BIN_SCAN',
  'PICKING_BASKET_SCAN',
  'PICKING_BASKET_BATCH_ASSIGN',
  'PICKING_BASKET_BIN_SCAN',
  'PICKING_BASKET_UNIT_SCAN',
  'PICKING_UNIT_SCAN',
  'PICKING_BASKET_LOOKUP',
  'PICKING_COMPLETE',
  'PICKING_HANDOFF',
] as const;
const HISTORY_PACK_ACTION_TYPES = [
  'PACKING_START',
  'PACKING_UNIT_SCAN',
  'PACKING_TRACKING_VERIFY',
  'PACKING_COMPLETE',
] as const;
const HISTORY_DISPATCH_ACTION_TYPES = [
  'ORDER_DISPATCH_SYNC',
  'ORDER_DELIVERY_SYNC',
] as const;
const HISTORY_RTS_ACTION_TYPES = [
  'ORDER_RTS_UNIT_VERIFY',
  'ORDER_RTS_COMPLETE',
  'ORDER_RTS_DISPOSITION',
] as const;
const HISTORY_SCAN_ACTION_TYPES = [
  'STOCK_SCAN',
  'STOCK_UNIT_VIEW',
  'STOCK_BIN_VIEW',
  'STOCK_BATCH_VIEW',
  'STOCK_PUTAWAY',
  'STOCK_MOVE',
] as const;
const HISTORY_VOID_ACTION_TYPES = [
  'PACKING_VOID_REQUEST',
  'PACKING_VOID_APPROVAL',
  'PACKING_VOID_COMPLETE',
] as const;
const HISTORY_ALL_ACTION_TYPES = [
  ...HISTORY_PICK_ACTION_TYPES,
  ...HISTORY_PACK_ACTION_TYPES,
  ...HISTORY_DISPATCH_ACTION_TYPES,
  ...HISTORY_RTS_ACTION_TYPES,
  ...HISTORY_SCAN_ACTION_TYPES,
  ...HISTORY_VOID_ACTION_TYPES,
] as const;

type FulfillmentLineDraft = {
  variationId: string;
  productId: string | null;
  productName: string;
  productDisplayId: string | null;
  quantityRequired: number;
  lineSnapshot: Prisma.InputJsonValue;
};

type PickedOrderPosStatusUpdateSummary = {
  targetStatus: number;
  queued: number;
  skipped: number;
  failed: number;
  results: Array<{
    posOrderId: string;
    outcome: 'queued' | 'skipped' | 'failed';
    reason: string;
    currentStatus?: number | null;
  }>;
};

@Injectable()
export class WmsMobileService {
  private readonly logger = new Logger(WmsMobileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly effectiveAccessService: EffectiveAccessService,
    private readonly mediaAssetsService: MediaAssetsService,
    private readonly wmsStaffActivityService: WmsStaffActivityService,
    private readonly wmsFulfillmentOpsService: WmsFulfillmentOpsService,
    private readonly wmsFulfillmentSyncService: WmsFulfillmentSyncService,
    private readonly wmsInventoryService: WmsInventoryService,
    private readonly wmsStoxReleasesService: WmsStoxReleasesService,
    private readonly ordersService: OrdersService,
    @InjectQueue(WMS_PICKING_HANDOFF_QUEUE)
    private readonly pickingHandoffQueue: Queue<WmsPickingHandoffWaitingForPrintingJobData>,
    @InjectQueue(WMS_PACKING_POST_COMPLETE_QUEUE)
    private readonly packingPostCompleteQueue: Queue<WmsPackingPostCompleteJobData>,
    @Optional()
    private readonly integrationService?: IntegrationService,
  ) {}

  private getPickingHandoffQueueJobOptions() {
    const attempts = Math.max(
      1,
      Number(process.env.WMS_PICKING_HANDOFF_QUEUE_ATTEMPTS || 4),
    );
    const backoffDelay = Math.max(
      1000,
      Number(process.env.WMS_PICKING_HANDOFF_QUEUE_BACKOFF_MS || 3000),
    );
    const timeout = Math.max(
      10000,
      Number(process.env.WMS_PICKING_HANDOFF_QUEUE_TIMEOUT_MS || 45000),
    );

    return {
      attempts,
      backoff: { type: 'exponential' as const, delay: backoffDelay },
      timeout,
      removeOnComplete: true,
      removeOnFail: 1000,
    };
  }

  private getPackingPostCompleteQueueJobOptions() {
    const attempts = Math.max(
      1,
      Number(process.env.WMS_PACKING_POST_COMPLETE_QUEUE_ATTEMPTS || 4),
    );
    const backoffDelay = Math.max(
      1000,
      Number(process.env.WMS_PACKING_POST_COMPLETE_QUEUE_BACKOFF_MS || 3000),
    );
    const timeout = Math.max(
      10000,
      Number(process.env.WMS_PACKING_POST_COMPLETE_QUEUE_TIMEOUT_MS || 60000),
    );

    return {
      attempts,
      backoff: { type: 'exponential' as const, delay: backoffDelay },
      timeout,
      removeOnComplete: true,
      removeOnFail: 1000,
    };
  }

  private async enqueuePackingPostCompleteSync(data: WmsPackingPostCompleteJobData) {
    try {
      await this.packingPostCompleteQueue.add(
        WMS_PACKING_POST_COMPLETE_SYNC_JOB,
        data,
        {
          ...this.getPackingPostCompleteQueueJobOptions(),
          jobId: `packing-post-complete:${data.fulfillmentOrderId}`,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Packing post-complete queue unavailable for ${data.fulfillmentOrderId}; running the sync inline: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        await this.processPackingPostCompleteJob(data);
      } catch (fallbackError) {
        this.logger.error(
          `Packing post-complete fallback failed for ${data.fulfillmentOrderId}; the repair sync can recover it later: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
          fallbackError instanceof Error ? fallbackError.stack : undefined,
        );
      }
    }
  }

  async processPackingPostCompleteJob(data: WmsPackingPostCompleteJobData) {
    const order = await this.prisma.wmsFulfillmentOrder.findFirst({
      where: {
        id: data.fulfillmentOrderId,
        tenantId: data.tenantId,
      },
      select: {
        id: true,
        status: true,
        tenantId: true,
        storeId: true,
        shopId: true,
        posOrderId: true,
      },
    });

    if (!order || order.status !== WmsFulfillmentOrderStatus.PACKED) {
      this.logger.debug(
        `Skipping stale packing post-complete sync for ${data.fulfillmentOrderId}`,
      );
      return { skipped: true };
    }

    const dispatchSync = await this.wmsInventoryService.syncPackedUnitsToDispatchedForPosOrders({
      tenantId: order.tenantId,
      storeId: order.storeId,
      posOrderRefs: [{
        shopId: order.shopId,
        posOrderId: order.posOrderId,
      }],
    });

    if (dispatchSync.cogsUpdatedOrders === 0) {
      await this.wmsInventoryService.syncPosOrderCogsFromMatchedInventoryUnits({
        fulfillmentOrderIds: [order.id],
      });
    }

    return {
      skipped: false,
      dispatchedUnits: dispatchSync.dispatchedUnits,
      deliveredOrders: dispatchSync.deliveredOrders,
      cogsUpdatedOrders: dispatchSync.cogsUpdatedOrders,
    };
  }

  async getActiveStoxRelease(user: BootstrapUser) {
    return this.wmsStoxReleasesService.getLatestActiveRelease(user);
  }

  async getBootstrap(user: BootstrapUser, request?: Request) {
    const userId = user.userId || user.id || null;
    const sessionId = (this.cls.get('sessionId') as string | undefined) || user.sessionId || null;
    const tenantContext = await this.resolveMobileTenantContext(user, request, {
      allowMissingPlatformTenant: true,
    });
    const tenantId = tenantContext.tenantId;

    if (!userId) {
      return this.buildTenantSelectionBootstrap(user, userId, sessionId, tenantContext.tenantOptions);
    }

    if (!tenantId) {
      if (user.role === 'SUPER_ADMIN') {
        return this.buildPlatformBootstrap(user, userId, sessionId, tenantContext.tenantOptions);
      }

      return this.buildGlobalWmsBootstrap(user, userId, sessionId, tenantContext.tenantOptions, request);
    }

    const [tenant, access, taskAssignment, teamMemberships, stores, warehouses] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
        },
      }),
      this.effectiveAccessService.resolveUserAccess({
        userId,
        basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
        workspace: 'wms',
      }),
      this.getWmsTaskAssignment(userId),
      this.effectiveAccessService.getActiveTeamMemberships(userId, tenantId),
      this.prisma.posStore.findMany({
        where: {
          tenantId,
          status: IntegrationStatus.ACTIVE,
        },
        select: {
          id: true,
          name: true,
          shopId: true,
          shopName: true,
          teamId: true,
        },
        orderBy: [{ name: 'asc' }],
      }),
      this.prisma.wmsWarehouse.findMany({
        where: {
          status: WmsWarehouseStatus.ACTIVE,
        },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
        },
        orderBy: [{ name: 'asc' }],
      }),
    ]);

    const defaultTeamId =
      user.defaultTeamId
      || teamMemberships.find((membership) => membership.isDefault)?.teamId
      || teamMemberships[0]?.teamId
      || null;
    const defaultStoreId = stores[0]?.id ?? null;
    const defaultWarehouseId = warehouses[0]?.id ?? null;

    if (user.role !== 'SUPER_ADMIN' && !access.permissions.some((permission) => permission.startsWith('wms.'))) {
      throw new ForbiddenException('This account has no WMS access');
    }

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId,
      actorId: userId,
      sessionId,
      actionType: 'BOOTSTRAP',
      resourceType: 'STOX_APP',
      resourceId: 'phase-1',
      metadata: {
        teamCount: teamMemberships.length,
        storeCount: stores.length,
        warehouseCount: warehouses.length,
      },
    });

    return {
      tenantReady: true,
      app: {
        key: 'stox',
        phase: 1,
        mode: process.env.NODE_ENV || 'development',
      },
      session: {
        sessionId,
      },
      user: {
        id: userId,
        email: user.email ?? null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        avatar: user.avatar ?? null,
        employeeId: user.employeeId ?? null,
        role: user.role ?? null,
      },
      tenant: tenant
        ? {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            status: tenant.status,
          }
        : null,
      access: {
        permissions: access.permissions,
        roles: access.roles.map((role) => ({
          id: role.id,
          key: role.key,
          name: role.name,
          scope: role.scope,
          workspace: role.workspace,
          teamId: role.teamId,
        })),
      },
      operations: {
        taskAssignment: taskAssignment,
      },
      context: {
        tenantOptions: tenantContext.tenantOptions,
        defaultTeamId,
        defaultStoreId,
        defaultWarehouseId,
        teams: teamMemberships.map((membership) => ({
          id: membership.teamId,
          name: membership.teamName,
          code: membership.teamCode,
          isDefault: membership.isDefault,
          role: membership.role,
        })),
        stores: stores.map((store) => ({
          id: store.id,
          name: store.name,
          shopId: store.shopId,
          shopName: store.shopName,
          teamId: store.teamId,
        })),
        warehouses: warehouses.map((warehouse) => ({
          id: warehouse.id,
          code: warehouse.code,
          name: warehouse.name,
          status: warehouse.status,
        })),
      },
      readiness: {
        teams: teamMemberships.length,
        stores: stores.length,
        warehouses: warehouses.length,
      },
    };
  }

  async getStock(user: BootstrapUser, query: GetWmsMobileStockDto, request?: Request) {
    const userId = user.userId || user.id || null;
    const tenantContext = await this.resolveMobileStockContext(user, query, request);
    const tenantId = tenantContext.tenantId;
    const sessionId = (this.cls.get('sessionId') as string | undefined) || user.sessionId || null;

    if (!userId) {
      return this.buildEmptyStockResponse(false);
    }

    const activeMode = query.mode ?? 'putaway';
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_STOCK_PAGE_SIZE;
    const skip = (page - 1) * pageSize;

    const storeWhere: Prisma.PosStoreWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      status: IntegrationStatus.ACTIVE,
    };

    const [stores, warehouses] = await Promise.all([
      this.prisma.posStore.findMany({
        where: storeWhere,
        select: {
          id: true,
          tenantId: true,
          name: true,
          shopName: true,
          teamId: true,
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
        orderBy: [{ name: 'asc' }],
      }),
      this.prisma.wmsWarehouse.findMany({
        where: {
          status: WmsWarehouseStatus.ACTIVE,
        },
        select: {
          id: true,
          code: true,
          name: true,
        },
        orderBy: [{ code: 'asc' }],
      }),
    ]);

    const activeStore = query.storeId
      ? stores.find((store) => store.id === query.storeId) ?? null
      : null;
    const activeWarehouse = query.warehouseId
      ? warehouses.find((warehouse) => warehouse.id === query.warehouseId) ?? null
      : null;
    const activeStoreId = activeStore?.id ?? null;
    const activeWarehouseId = activeWarehouse?.id ?? null;

    if (tenantId) {
      // Repair any shipped/delivered packed units before computing stock totals.
      await this.wmsInventoryService.syncPackedUnitsToDispatchedForPosOrders({
        tenantId,
        storeId: activeStoreId,
      });
    }

    const unitScope: Prisma.WmsInventoryUnitWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(activeStoreId ? { storeId: activeStoreId } : {}),
      ...(activeWarehouseId ? { warehouseId: activeWarehouseId } : {}),
    };
    const receivingScope: Prisma.WmsReceivingBatchWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(activeStoreId ? { storeId: activeStoreId } : {}),
      ...(activeWarehouseId ? { warehouseId: activeWarehouseId } : {}),
    };
    const transferScope: Prisma.WmsTransferWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(activeWarehouseId ? { warehouseId: activeWarehouseId } : {}),
    };
    const binScope: Prisma.WmsLocationWhereInput = {
      isActive: true,
      kind: WmsLocationKind.BIN,
      ...(activeWarehouseId ? { warehouseId: activeWarehouseId } : {}),
    };

    const [
      totalUnits,
      locatedUnits,
      stagedUnits,
      movableUnitCount,
      putawayBatchCount,
      transferCount,
      binCount,
      unitsOnHandCount,
      dispatchedUnitCount,
      capacityBins,
      putawayQueue,
      movableUnits,
      recentTransfers,
      bins,
    ] = await Promise.all([
      this.prisma.wmsInventoryUnit.count({
        where: unitScope,
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...unitScope,
          currentLocationId: {
            not: null,
          },
        },
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...unitScope,
          status: WmsInventoryUnitStatus.STAGED,
        },
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...unitScope,
          status: {
            in: [...STOCK_TRANSFERABLE_UNIT_STATUSES],
          },
        },
      }),
      this.prisma.wmsReceivingBatch.count({
        where: {
          ...receivingScope,
          status: {
            in: [...STOCK_PUTAWAY_BATCH_STATUSES],
          },
        },
      }),
      this.prisma.wmsTransfer.count({
        where: transferScope,
      }),
      this.prisma.wmsLocation.count({
        where: binScope,
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...unitScope,
          status: {
            notIn: [...MOBILE_UNITS_ON_HAND_EXCLUDED_STATUSES],
          },
        },
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...unitScope,
          status: WmsInventoryUnitStatus.DISPATCHED,
        },
      }),
      this.prisma.wmsLocation.findMany({
        where: binScope,
        select: {
          id: true,
          capacity: true,
        },
      }),
      this.prisma.wmsReceivingBatch.findMany({
        where: {
          ...receivingScope,
          status: {
            in: [...STOCK_PUTAWAY_BATCH_STATUSES],
          },
        },
        select: {
          id: true,
          code: true,
          status: true,
          store: {
            select: {
              id: true,
              name: true,
              shopName: true,
            },
          },
          lines: {
            select: {
              store: {
                select: {
                  id: true,
                  name: true,
                  shopName: true,
                },
              },
            },
          },
          warehouse: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
          stagingLocation: {
            select: {
              id: true,
              code: true,
              name: true,
              kind: true,
            },
          },
          _count: {
            select: {
              inventoryUnits: true,
            },
          },
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.wmsInventoryUnit.findMany({
        where: {
          ...unitScope,
          status: {
            in: [...STOCK_TRANSFERABLE_UNIT_STATUSES],
          },
        },
        select: {
          id: true,
          code: true,
          barcode: true,
          status: true,
          productId: true,
          variationId: true,
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
            },
          },
          warehouse: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
          currentLocation: {
            select: {
              id: true,
              code: true,
              name: true,
              kind: true,
            },
          },
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.wmsTransfer.findMany({
        where: transferScope,
        select: {
          id: true,
          code: true,
          status: true,
          fromLocation: {
            select: {
              id: true,
              code: true,
              name: true,
              kind: true,
            },
          },
          toLocation: {
            select: {
              id: true,
              code: true,
              name: true,
              kind: true,
            },
          },
          warehouse: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
          createdBy: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          _count: {
            select: {
              items: true,
            },
          },
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.wmsLocation.findMany({
        where: binScope,
        select: {
          id: true,
          code: true,
          name: true,
          kind: true,
          capacity: true,
          warehouse: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
          parent: {
            select: {
              id: true,
              code: true,
              name: true,
              kind: true,
              parent: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  kind: true,
                },
              },
            },
          },
          _count: {
            select: {
              inventoryUnits: true,
            },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        skip,
        take: pageSize,
      }),
    ]);

    const unlocatedUnits = Math.max(totalUnits - locatedUnits, 0);
    const warehouseCapacity = await this.getMobileWarehouseCapacitySummary({
      bins: capacityBins,
      storeId: activeStoreId,
      tenantId,
      warehouseId: activeWarehouseId,
    });
    const activeTotal = this.getStockModeTotal(activeMode, {
      bins: binCount,
      move: movableUnitCount,
      putaway: putawayBatchCount,
      recent: transferCount,
    });
    const activityTenantId = tenantId ?? activeStore?.tenantId ?? null;

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId: activityTenantId,
      actorId: userId,
      sessionId,
      actionType: 'STOCK_VIEW',
      resourceType: 'STOX_STOCK',
      resourceId: activeWarehouseId,
      storeId: activeStoreId,
      warehouseId: activeWarehouseId,
      metadata: {
        totalUnits,
        stagedUnits,
        movableUnitCount,
        putawayBatchCount,
      },
    });

    return {
      tenantReady: true,
      serverTime: new Date().toISOString(),
      pagination: {
        mode: activeMode,
        page,
        pageSize,
        total: activeTotal,
        hasMore: page * pageSize < activeTotal,
      },
      context: {
        tenantOptions: tenantContext.tenantOptions,
        activeTenantId: tenantId,
        activeStoreId,
        activeWarehouseId,
        stores: stores.map((store) => ({
          id: store.id,
          tenantId: store.tenantId,
          name: store.shopName || store.name,
          tenantName: store.tenant.name,
          tenantSlug: store.tenant.slug,
        })),
        warehouses: warehouses.map((warehouse) => ({
          id: warehouse.id,
          code: warehouse.code,
          name: warehouse.name,
        })),
      },
      summary: {
        totalUnits,
        locatedUnits,
        unlocatedUnits,
        stagedUnits,
        movableUnits: movableUnitCount,
        putawayBatches: putawayBatchCount,
        transfers: transferCount,
        bins: binCount,
        unitsOnHand: unitsOnHandCount,
        dispatchedUnits: dispatchedUnitCount,
        warehouseCapacity,
      },
      putawayQueue: putawayQueue.map((batch) => {
        const storeSummary = this.summarizeMobileReceivingBatchStore({
          fallbackStore: batch.store,
          lines: batch.lines,
        });

        return {
          id: batch.id,
          code: batch.code,
          status: batch.status,
          statusLabel: this.formatEnumLabel(batch.status),
          unitCount: batch._count.inventoryUnits,
          store: storeSummary,
          warehouse: batch.warehouse,
          stagingLocation: batch.stagingLocation
            ? this.mapLocation(batch.stagingLocation)
            : null,
          updatedAt: batch.updatedAt,
        };
      }),
      movableUnits: movableUnits.map((unit) => ({
        id: unit.id,
        code: unit.code,
        barcode: unit.barcode,
        status: unit.status,
        statusLabel: this.formatEnumLabel(unit.status),
        productId: unit.productId,
        variationId: unit.variationId,
        name: unit.posProduct.name,
        customId: unit.posProduct.customId,
        warehouse: unit.warehouse,
        currentLocation: unit.currentLocation ? this.mapLocation(unit.currentLocation) : null,
        updatedAt: unit.updatedAt,
      })),
      recentTransfers: recentTransfers.map((transfer) => ({
        id: transfer.id,
        code: transfer.code,
        status: transfer.status,
        statusLabel: this.formatEnumLabel(transfer.status),
        itemCount: transfer._count.items,
        warehouse: transfer.warehouse,
        fromLocation: transfer.fromLocation ? this.mapLocation(transfer.fromLocation) : null,
        toLocation: this.mapLocation(transfer.toLocation),
        actor: this.mapActor(transfer.createdBy),
        createdAt: transfer.createdAt,
      })),
      bins: bins.map((bin) => {
        const occupiedUnits = bin._count.inventoryUnits;
        const availableUnits =
          bin.capacity === null ? null : Math.max(bin.capacity - occupiedUnits, 0);
        const rack = bin.parent?.kind === WmsLocationKind.RACK ? bin.parent : null;
        const section = rack?.parent?.kind === WmsLocationKind.SECTION ? rack.parent : null;

        return {
          id: bin.id,
          code: bin.code,
          name: bin.name,
          kind: bin.kind,
          label: `${bin.warehouse.code} · ${bin.code}`,
          warehouse: bin.warehouse,
          section: section
            ? {
              id: section.id,
              code: section.code,
              name: section.name,
            }
            : null,
          rack: rack
            ? {
              id: rack.id,
              code: rack.code,
              name: rack.name,
            }
            : null,
          capacity: bin.capacity,
          occupiedUnits,
          availableUnits,
          isFull: bin.capacity !== null ? occupiedUnits >= bin.capacity : false,
        };
      }),
    };
  }

  async getTenantOptions(user: BootstrapUser) {
    return {
      tenants: await this.getPlatformTenantOptions(),
    };
  }

  async getHomeInventorySummary(
    user: BootstrapUser,
    query: GetWmsMobileHomeInventorySummaryDto,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: query.tenantId } as GetWmsMobileStockDto,
      request,
    );

    let tenantId = tenantContext.tenantId;

    if (!tenantId && query.storeId) {
      const store = await this.prisma.posStore.findUnique({
        where: { id: query.storeId },
        select: { tenantId: true },
      });
      tenantId = store?.tenantId ?? null;
    }

    if (tenantId) {
      // Repair any shipped/delivered packed units before computing summary totals.
      await this.wmsInventoryService.syncPackedUnitsToDispatchedForPosOrders({
        tenantId,
        storeId: query.storeId ?? null,
      });
    }

    const scope: Prisma.WmsInventoryUnitWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
    };
    const binScope: Prisma.WmsLocationWhereInput = {
      isActive: true,
      kind: WmsLocationKind.BIN,
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
    };

    const [
      totalUnits,
      locatedUnits,
      stagedUnits,
      movableUnits,
      unitsOnHand,
      dispatchedUnits,
      bins,
    ] = await Promise.all([
      this.prisma.wmsInventoryUnit.count({
        where: scope,
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...scope,
          currentLocationId: {
            not: null,
          },
        },
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...scope,
          status: WmsInventoryUnitStatus.STAGED,
        },
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...scope,
          status: {
            in: [...STOCK_TRANSFERABLE_UNIT_STATUSES],
          },
        },
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...scope,
          status: {
            notIn: [...MOBILE_UNITS_ON_HAND_EXCLUDED_STATUSES],
          },
        },
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...scope,
          status: WmsInventoryUnitStatus.DISPATCHED,
        },
      }),
      this.prisma.wmsLocation.findMany({
        where: binScope,
        select: {
          id: true,
          capacity: true,
        },
      }),
    ]);

    const warehouseCapacity = await this.getMobileWarehouseCapacitySummary({
      bins,
      storeId: query.storeId ?? null,
      tenantId,
      warehouseId: query.warehouseId ?? null,
    });

    return {
      context: {
        activeStoreId: query.storeId ?? null,
        activeTenantId: tenantId ?? null,
        activeWarehouseId: query.warehouseId ?? null,
      },
      summary: {
        dispatchedUnits,
        locatedUnits,
        movableUnits,
        stagedUnits,
        totalUnits,
        unitsOnHand,
        warehouseCapacity,
      },
      tenantReady: Boolean(tenantId),
    };
  }

  async getHomeTaskSummary(
    user: BootstrapUser,
    query: GetWmsMobileHomeTaskSummaryDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: query.tenantId } as GetWmsMobileStockDto,
      request,
    );

    let tenantId = tenantContext.tenantId;

    if (!tenantId && query.storeId) {
      const store = await this.prisma.posStore.findUnique({
        where: { id: query.storeId },
        select: { tenantId: true },
      });
      tenantId = store?.tenantId ?? null;
    }

    const fulfillmentGoLiveAt = await this.getFulfillmentGoLiveAt(tenantId);
    const fulfillmentGoLiveWhere = this.buildFulfillmentGoLiveWhere(fulfillmentGoLiveAt);
    const activeStoxAssignmentWhere = this.buildActiveStoxAssignmentWhere();
    const fulfillmentScope: Prisma.WmsFulfillmentOrderWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...fulfillmentGoLiveWhere,
      ...activeStoxAssignmentWhere,
    };
    const rtsScope: Prisma.WmsFulfillmentOrderWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
    };
    let permissions: string[] = [];
    let taskAssignment: WmsStaffAssignmentTaskType | null = null;

    if (userId) {
      const [access, resolvedTaskAssignment] = await Promise.all([
        this.effectiveAccessService.resolveUserAccess({
          userId,
          basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
          workspace: 'wms',
        }),
        this.getWmsTaskAssignment(userId),
      ]);
      permissions = access.permissions;
      taskAssignment = resolvedTaskAssignment;
    }

    const isPackSupervisor = user.role === 'SUPER_ADMIN'
      || this.hasAnyRequiredPermission(permissions, PACK_SUPERVISOR_PERMISSIONS);
    const isPickSupervisor = user.role === 'SUPER_ADMIN'
      || this.hasAnyRequiredPermission(permissions, PICK_SUPERVISOR_PERMISSIONS);
    const canPick = user.role === 'SUPER_ADMIN'
      || this.hasAnyRequiredPermission(permissions, PICK_ASSIGNMENT_PERMISSIONS);
    const canPack = user.role === 'SUPER_ADMIN'
      || this.hasAnyRequiredPermission(permissions, PACK_HANDOFF_PERMISSIONS);
    const pickQueueAccess = (() => {
      try {
        return userId
          ? this.resolvePickQueueAccess(user, permissions, taskAssignment)
          : { canViewAll: false };
      } catch {
        return { canViewAll: false };
      }
    })();
    const packBasketAssignmentWhere: Prisma.WmsBasketWhereInput = isPackSupervisor
      ? { assignedPackerId: { not: null } }
      : taskAssignment === WmsStaffAssignmentTaskType.PACK && userId
        ? { assignedPackerId: userId }
        : { assignedPackerId: { not: null } };
    const pickActiveOwnershipWhere: Prisma.WmsFulfillmentOrderWhereInput = pickQueueAccess.canViewAll
      ? {}
      : userId
        ? {
            OR: [
              { claimedById: null },
              { claimedById: userId },
            ],
          }
        : { claimedById: '__missing_user__' };
    const pickCompletedOwnershipWhere: Prisma.WmsFulfillmentOrderWhereInput = pickQueueAccess.canViewAll
      ? {}
      : userId
        ? { claimedById: userId }
        : { claimedById: '__missing_user__' };
    const deliveredAttributionWhere: Prisma.WmsFulfillmentOrderWhereInput = (() => {
      if (!userId || user.role === 'SUPER_ADMIN') {
        return {};
      }

      if (taskAssignment === WmsStaffAssignmentTaskType.PICK && !isPickSupervisor) {
        return { claimedById: userId };
      }

      if (taskAssignment === WmsStaffAssignmentTaskType.PACK && !isPackSupervisor) {
        return { packedById: userId };
      }

      if (canPick && !canPack && !isPickSupervisor) {
        return { claimedById: userId };
      }

      if (canPack && !canPick && !isPackSupervisor) {
        return { packedById: userId };
      }

      if (canPick && canPack && !isPickSupervisor && !isPackSupervisor) {
        return {
          OR: [
            { claimedById: userId },
            { packedById: userId },
          ],
        };
      }

      return {};
    })();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const completionActivityWhere: Prisma.WmsStaffActivityWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      actionType: {
        in: [
          'PICKING_COMPLETE',
          'PACKING_COMPLETE',
        ],
      },
      ...(isPackSupervisor
        ? {}
        : userId
          ? { actorId: userId }
          : { actorId: '__missing_user__' }),
    };
    const missingTrackingFilter: Prisma.WmsFulfillmentOrderWhereInput = {
      OR: [
        {
          posOrder: {
            is: {
              tracking: null,
            },
          },
        },
        {
          posOrder: {
            is: {
              tracking: '',
            },
          },
        },
      ],
    };
    const packedAttributionWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      ...(isPackSupervisor
        ? { packedById: { not: null } }
        : userId
          ? { packedById: userId }
          : { packedById: '__missing_user__' }),
    };
    const [pickGroups, pickCompletedGroups, packGroups, restockingCount, packingWithoutTrackingCount, packedCount, deliveredCount, rtsCount, completedTodayGroups] = await Promise.all([
      this.prisma.wmsFulfillmentOrder.groupBy({
        by: ['status'],
        where: {
          ...fulfillmentScope,
          ...pickActiveOwnershipWhere,
          status: {
            in: [
              WmsFulfillmentOrderStatus.READY,
              WmsFulfillmentOrderStatus.PARTIAL,
              WmsFulfillmentOrderStatus.IN_PICKING,
            ],
          },
        },
        _count: {
          _all: true,
        },
      }),
      this.prisma.wmsFulfillmentOrder.groupBy({
        by: ['status'],
        where: {
          ...fulfillmentScope,
          ...pickCompletedOwnershipWhere,
          status: {
            in: [
              WmsFulfillmentOrderStatus.READY_FOR_PACK,
              WmsFulfillmentOrderStatus.PICKED,
            ],
          },
        },
        _count: {
          _all: true,
        },
      }),
      this.prisma.wmsFulfillmentOrder.groupBy({
        by: ['status'],
        where: {
          ...fulfillmentScope,
          status: {
            in: [
              WmsFulfillmentOrderStatus.PICKED,
              WmsFulfillmentOrderStatus.PACKING,
            ],
          },
          basket: {
            is: {
              ...packBasketAssignmentWhere,
              status: {
                in: [
                  WmsBasketStatus.FULL_HELD,
                  WmsBasketStatus.PACKING,
                ],
              },
            },
          },
        },
        _count: {
          _all: true,
        },
      }),
      this.prisma.wmsFulfillmentOrder.count({
        where: {
          ...fulfillmentScope,
          status: WmsFulfillmentOrderStatus.RESTOCKING,
        },
      }),
      this.prisma.wmsFulfillmentOrder.count({
        where: {
          ...fulfillmentScope,
          status: {
            in: [
              WmsFulfillmentOrderStatus.PICKED,
              WmsFulfillmentOrderStatus.PACKING,
            ],
          },
          basket: {
            is: {
              ...packBasketAssignmentWhere,
              status: {
                in: [
                  WmsBasketStatus.FULL_HELD,
                  WmsBasketStatus.PACKING,
                ],
              },
            },
          },
          ...missingTrackingFilter,
        },
      }),
      this.prisma.wmsFulfillmentOrder.count({
        where: {
          ...fulfillmentScope,
          ...packedAttributionWhere,
          status: WmsFulfillmentOrderStatus.PACKED,
        },
      }),
      this.prisma.wmsFulfillmentOrder.count({
        where: {
          ...fulfillmentScope,
          ...deliveredAttributionWhere,
          status: WmsFulfillmentOrderStatus.PACKED,
          posOrder: {
            is: {
              ...(fulfillmentGoLiveAt
                ? {
                    insertedAt: {
                      gte: fulfillmentGoLiveAt,
                    },
                  }
                : {}),
              status: 3,
            },
          },
        },
      }),
      this.prisma.wmsFulfillmentOrder.count({
        where: this.buildOpenRtsOrderWhere({
          ...rtsScope,
        }),
      }),
      this.prisma.wmsStaffActivity.groupBy({
        by: ['actionType'],
        where: {
          ...completionActivityWhere,
          createdAt: {
            gte: todayStart,
          },
        },
        _count: {
          _all: true,
        },
      }),
    ]);
    const pickCounts = this.mapStatusCounts(pickGroups);
    const pickCompletedCounts = this.mapStatusCounts(pickCompletedGroups);
    const packCounts = this.mapStatusCounts(packGroups);
    const completedTodayCounts = Object.fromEntries(
      completedTodayGroups.map((group) => [group.actionType, group._count._all]),
    ) as Partial<Record<string, number>>;
    const ready = pickCounts[WmsFulfillmentOrderStatus.READY] ?? 0;
    const partial = pickCounts[WmsFulfillmentOrderStatus.PARTIAL] ?? 0;
    const inPicking = pickCounts[WmsFulfillmentOrderStatus.IN_PICKING] ?? 0;
    const readyForPack = pickCompletedCounts[WmsFulfillmentOrderStatus.READY_FOR_PACK] ?? 0;
    const pickedHistory = pickCompletedCounts[WmsFulfillmentOrderStatus.PICKED] ?? 0;
    const picked = packCounts[WmsFulfillmentOrderStatus.PICKED] ?? 0;
    const packing = packCounts[WmsFulfillmentOrderStatus.PACKING] ?? 0;

    return {
      context: {
        activeStoreId: query.storeId ?? null,
        activeTenantId: tenantId ?? null,
      },
      summary: {
        pick: {
          ready,
          partial,
          inPicking,
          readyForPack,
          picked: pickedHistory,
          total: ready + partial + inPicking,
        },
        pack: {
          picked,
          packing,
          awaitingTracking: packingWithoutTrackingCount,
          packed: packedCount,
          total: picked + packing,
        },
        groups: {
          restocking: restockingCount,
          packingWithoutTracking: packingWithoutTrackingCount,
          delivered: deliveredCount,
          rts: rtsCount,
        },
        completedToday: {
          picked: completedTodayCounts.PICKING_COMPLETE ?? 0,
          packed: completedTodayCounts.PACKING_COMPLETE ?? 0,
        },
      },
      tenantReady: Boolean(tenantId),
    };
  }

  async scanStockCode(user: BootstrapUser, query: GetWmsMobileStockScanDto, request?: Request) {
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: query.tenantId }, request);
    const code = this.normalizeScannedCode(query.code);

    const unit = await this.findUnitByCode(code, tenantContext.tenantId);
    if (unit) {
      await this.recordStockActivity(user, request, {
        tenantId: unit.tenantId,
        actionType: 'STOCK_SCAN',
        resourceType: 'WMS_INVENTORY_UNIT',
        resourceId: unit.id,
        metadata: { code, resultType: 'unit' },
      });

      return {
        found: true,
        type: 'unit',
        unit: this.mapMobileUnitDetail(unit),
      };
    }

    const location = await this.findLocationByCode(code);
    if (location) {
      await this.recordStockActivity(user, request, {
        tenantId: tenantContext.tenantId,
        actionType: 'STOCK_SCAN',
        resourceType: 'WMS_LOCATION',
        resourceId: location.id,
        metadata: { code, resultType: 'bin' },
      });

      return {
        found: true,
        type: location.kind === WmsLocationKind.BIN ? 'bin' : 'location',
        bin: await this.buildMobileBinDetail(location.id, tenantContext.tenantId),
      };
    }

    const batch = await this.findBatchByCode(code, tenantContext.tenantId);
    if (batch) {
      await this.recordStockActivity(user, request, {
        tenantId: batch.tenantId,
        actionType: 'STOCK_SCAN',
        resourceType: 'WMS_RECEIVING_BATCH',
        resourceId: batch.id,
        metadata: { code, resultType: 'batch' },
      });

      return {
        found: true,
        type: 'batch',
        batch: this.mapMobileBatchDetail(batch),
      };
    }

    await this.recordStockActivity(user, request, {
      tenantId: tenantContext.tenantId,
      actionType: 'STOCK_SCAN',
      resourceType: 'STOX_STOCK',
      resourceId: null,
      metadata: { code, resultType: 'none' },
    });

    return {
      found: false,
      type: 'none',
      code,
    };
  }

  async getStockUnit(
    user: BootstrapUser,
    id: string,
    query: GetWmsMobileStockScopedDto,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: query.tenantId }, request);
    const unit = await this.findUnitById(id, tenantContext.tenantId);

    if (!unit) {
      throw new NotFoundException('Inventory unit was not found');
    }

    await this.recordStockActivity(user, request, {
      tenantId: unit.tenantId,
      actionType: 'STOCK_UNIT_VIEW',
      resourceType: 'WMS_INVENTORY_UNIT',
      resourceId: unit.id,
    });

    const linkedTask = await this.findLinkedTaskForUnit(unit.id, tenantContext.tenantId);

    return {
      unit: this.mapMobileUnitDetail(unit),
      task: linkedTask ? this.mapMobilePickingTask(linkedTask) : null,
    };
  }

  async getStockBin(
    user: BootstrapUser,
    id: string,
    query: GetWmsMobileStockScopedDto,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: query.tenantId }, request);
    const bin = await this.buildMobileBinDetail(id, tenantContext.tenantId);

    if (!bin) {
      throw new NotFoundException('Bin was not found');
    }

    await this.recordStockActivity(user, request, {
      tenantId: tenantContext.tenantId,
      actionType: 'STOCK_BIN_VIEW',
      resourceType: 'WMS_LOCATION',
      resourceId: bin.id,
    });

    return { bin };
  }

  async getStockBatch(
    user: BootstrapUser,
    id: string,
    query: GetWmsMobileStockScopedDto,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: query.tenantId }, request);
    const batch = await this.findBatchById(id, tenantContext.tenantId);

    if (!batch) {
      throw new NotFoundException('Receiving batch was not found');
    }

    await this.recordStockActivity(user, request, {
      tenantId: batch.tenantId,
      actionType: 'STOCK_BATCH_VIEW',
      resourceType: 'WMS_RECEIVING_BATCH',
      resourceId: batch.id,
    });

    return {
      batch: this.mapMobileBatchDetail(batch),
    };
  }

  async getStockCountSessions(
    user: BootstrapUser,
    query: GetWmsMobileStockCountSessionsDto,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: query.tenantId }, request);

    const sessions = await this.prisma.wmsInventoryCountSession.findMany({
      where: {
        ...(tenantContext.tenantId ? { tenantId: tenantContext.tenantId } : {}),
        ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: this.mobileCountSessionInclude(),
      orderBy: [
        { status: 'asc' },
        { createdAt: 'desc' },
      ],
      take: 12,
    });

    return {
      context: {
        activeTenantId: tenantContext.tenantId ?? null,
        activeWarehouseId: query.warehouseId ?? null,
      },
      sessions: sessions.map((session) => this.mapMobileCountSessionSummary(session)),
      tenantReady: Boolean(tenantContext.tenantId),
    };
  }

  async getStockCountSession(
    user: BootstrapUser,
    id: string,
    query: GetWmsMobileStockScopedDto,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: query.tenantId }, request);
    const session = await this.findMobileCountSessionById(id, tenantContext.tenantId);

    if (!session) {
      throw new NotFoundException('Cycle count session was not found');
    }

    await this.recordStockActivity(user, request, {
      tenantId: session.tenantId,
      actionType: 'STOCK_COUNT_VIEW',
      resourceType: 'WMS_INVENTORY_COUNT_SESSION',
      resourceId: session.id,
      warehouseId: session.warehouseId,
      metadata: {
        locationCode: session.location.code,
        status: session.status,
      },
    });

    return {
      session: this.mapMobileCountSessionDetail(session),
    };
  }

  async startStockCountSession(
    user: BootstrapUser,
    body: WmsMobileStartStockCountDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: body.tenantId }, request);
    const tenantId = tenantContext.tenantId ?? null;

    if (!tenantId) {
      throw new BadRequestException('Select a Partner scope before starting a cycle count.');
    }

    const warehouseId = body.warehouseId ?? await this.resolveWarehouseScopeFromLocationCode(body.targetCode);

    if (!warehouseId) {
      throw new BadRequestException('Select a warehouse or scan a warehouse-prefixed bin code first.');
    }

    const location = await this.findLocationByCode(body.targetCode, {
      warehouseId,
      warehouseMismatchMessage: 'Scanned count bin belongs to another warehouse.',
    });

    if (!location || !location.isActive) {
      throw new NotFoundException('Count bin was not found');
    }

    if (location.kind !== WmsLocationKind.BIN) {
      throw new BadRequestException('Cycle counts can only be started from a BIN location.');
    }

    const existingOpenSession = await this.prisma.wmsInventoryCountSession.findFirst({
      where: {
        tenantId,
        locationId: location.id,
        status: WmsInventoryCountSessionStatus.OPEN,
      },
      include: this.mobileCountSessionInclude(),
    });

    if (existingOpenSession) {
      return {
        session: this.mapMobileCountSessionDetail(existingOpenSession),
        resumed: true,
      };
    }

    const now = new Date();
    const created = await this.prisma.$transaction(async (tx) => {
      const expectedUnits = await tx.wmsInventoryUnit.findMany({
        where: {
          tenantId,
          warehouseId,
          currentLocationId: location.id,
        },
        select: {
          id: true,
          code: true,
          barcode: true,
          posProduct: {
            select: {
              name: true,
              customId: true,
            },
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
      });

      const session = await tx.wmsInventoryCountSession.create({
        data: {
          tenantId,
          warehouseId,
          locationId: location.id,
          startedById: userId ?? undefined,
          expectedUnitCount: expectedUnits.length,
          notes: this.cleanOptionalText(body.notes),
          startedAt: now,
          entries: {
            create: expectedUnits.map((unit) => ({
              inventoryUnitId: unit.id,
              status: WmsInventoryCountEntryStatus.PENDING,
              unitCode: unit.code,
              unitBarcode: unit.barcode,
              productName: unit.posProduct.name,
              productCustomId: unit.posProduct.customId,
            })),
          },
        },
        include: this.mobileCountSessionInclude(),
      });

      return session;
    });

    await this.recordStockActivity(user, request, {
      tenantId: created.tenantId,
      actionType: 'STOCK_COUNT_START',
      resourceType: 'WMS_INVENTORY_COUNT_SESSION',
      resourceId: created.id,
      warehouseId: created.warehouseId,
      metadata: {
        locationCode: created.location.code,
        expectedUnitCount: created.expectedUnitCount,
      },
    });

    return {
      session: this.mapMobileCountSessionDetail(created),
      resumed: false,
    };
  }

  async scanStockCountUnit(
    user: BootstrapUser,
    id: string,
    body: WmsMobileScanStockCountUnitDto,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: body.tenantId }, request);
    const session = await this.findMobileCountSessionById(id, tenantContext.tenantId);

    if (!session) {
      throw new NotFoundException('Cycle count session was not found');
    }

    if (session.status !== WmsInventoryCountSessionStatus.OPEN) {
      throw new ConflictException('This cycle count session is already closed.');
    }

    const scannedCode = this.normalizeScannedCode(body.code);
    const unit = await this.findUnitByCode(scannedCode, session.tenantId);

    if (!unit) {
      throw new NotFoundException(`No inventory unit was found for ${scannedCode}.`);
    }

    if (unit.warehouseId !== session.warehouseId) {
      throw new BadRequestException(`Unit ${unit.code} belongs to another warehouse.`);
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const expectedEntry = await tx.wmsInventoryCountEntry.findFirst({
        where: {
          sessionId: session.id,
          inventoryUnitId: unit.id,
        },
      });

      if (expectedEntry) {
        if (expectedEntry.status !== WmsInventoryCountEntryStatus.COUNTED) {
          await tx.wmsInventoryCountEntry.update({
            where: { id: expectedEntry.id },
            data: {
              status: WmsInventoryCountEntryStatus.COUNTED,
              scannedCode,
              scannedAt: now,
            },
          });
        }
      } else {
        const existingUnexpected = await tx.wmsInventoryCountEntry.findFirst({
          where: {
            sessionId: session.id,
            unitCode: unit.code,
            status: WmsInventoryCountEntryStatus.UNEXPECTED,
          },
        });

        if (!existingUnexpected) {
          await tx.wmsInventoryCountEntry.create({
            data: {
              sessionId: session.id,
              inventoryUnitId: unit.id,
              status: WmsInventoryCountEntryStatus.UNEXPECTED,
              unitCode: unit.code,
              unitBarcode: unit.barcode,
              productName: unit.posProduct.name,
              productCustomId: unit.posProduct.customId,
              scannedCode,
              scannedAt: now,
            },
          });
        }
      }

      await this.refreshCountSessionSummary(tx, session.id);
    });

    const refreshed = await this.findMobileCountSessionById(session.id, session.tenantId);

    await this.recordStockActivity(user, request, {
      tenantId: session.tenantId,
      actionType: 'STOCK_COUNT_UNIT_SCAN',
      resourceType: 'WMS_INVENTORY_COUNT_SESSION',
      resourceId: session.id,
      warehouseId: session.warehouseId,
      metadata: {
        code: scannedCode,
        unitCode: unit.code,
        locationCode: session.location.code,
      },
    });

    return {
      session: refreshed ? this.mapMobileCountSessionDetail(refreshed) : null,
    };
  }

  async submitStockCountSession(
    user: BootstrapUser,
    id: string,
    body: WmsMobileSubmitStockCountDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: body.tenantId }, request);
    const session = await this.findMobileCountSessionById(id, tenantContext.tenantId);

    if (!session) {
      throw new NotFoundException('Cycle count session was not found');
    }

    if (session.status !== WmsInventoryCountSessionStatus.OPEN) {
      throw new ConflictException('This cycle count session is already closed.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.wmsInventoryCountEntry.updateMany({
        where: {
          sessionId: session.id,
          status: WmsInventoryCountEntryStatus.PENDING,
        },
        data: {
          status: WmsInventoryCountEntryStatus.MISSING,
        },
      });

      await this.refreshCountSessionSummary(tx, session.id);

      await tx.wmsInventoryCountSession.update({
        where: { id: session.id },
        data: {
          status: WmsInventoryCountSessionStatus.SUBMITTED,
          submittedAt: new Date(),
          submittedById: userId ?? undefined,
          notes: this.cleanOptionalText(body.notes) ?? session.notes,
        },
      });
    });

    const refreshed = await this.findMobileCountSessionById(session.id, session.tenantId);

    await this.recordStockActivity(user, request, {
      tenantId: session.tenantId,
      actionType: 'STOCK_COUNT_SUBMIT',
      resourceType: 'WMS_INVENTORY_COUNT_SESSION',
      resourceId: session.id,
      warehouseId: session.warehouseId,
      metadata: {
        locationCode: session.location.code,
      },
    });

    return {
      session: refreshed ? this.mapMobileCountSessionDetail(refreshed) : null,
    };
  }

  async reopenStockCountSession(
    user: BootstrapUser,
    id: string,
    body: WmsMobileReopenStockCountDto,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: body.tenantId }, request);
    const session = await this.findMobileCountSessionById(id, tenantContext.tenantId);

    if (!session) {
      throw new NotFoundException('Cycle count session was not found');
    }

    if (
      session.status !== WmsInventoryCountSessionStatus.SUBMITTED
      && session.status !== WmsInventoryCountSessionStatus.CLOSED
    ) {
      throw new ConflictException('Only submitted or closed count sessions can be reopened.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.wmsInventoryCountEntry.updateMany({
        where: {
          sessionId: session.id,
          status: WmsInventoryCountEntryStatus.MISSING,
        },
        data: {
          status: WmsInventoryCountEntryStatus.PENDING,
        },
      });

      await this.refreshCountSessionSummary(tx, session.id);

      await tx.wmsInventoryCountSession.update({
        where: { id: session.id },
        data: {
          status: WmsInventoryCountSessionStatus.OPEN,
          submittedAt: null,
          submittedById: null,
          closedAt: null,
          closedById: null,
          notes: this.cleanOptionalText(body.notes) ?? session.notes,
        },
      });
    });

    const refreshed = await this.findMobileCountSessionById(session.id, session.tenantId);

    await this.recordStockActivity(user, request, {
      tenantId: session.tenantId,
      actionType: 'STOCK_COUNT_REOPEN',
      resourceType: 'WMS_INVENTORY_COUNT_SESSION',
      resourceId: session.id,
      warehouseId: session.warehouseId,
      metadata: {
        locationCode: session.location.code,
        previousStatus: session.status,
      },
    });

    return {
      session: refreshed ? this.mapMobileCountSessionDetail(refreshed) : null,
    };
  }

  async closeoutStockCountSession(
    user: BootstrapUser,
    id: string,
    body: WmsMobileCloseoutStockCountDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: body.tenantId }, request);
    const session = await this.findMobileCountSessionById(id, tenantContext.tenantId);

    if (!session) {
      throw new NotFoundException('Cycle count session was not found');
    }

    if (session.status !== WmsInventoryCountSessionStatus.SUBMITTED) {
      throw new ConflictException('Only submitted count sessions can be closed out.');
    }

    await this.prisma.wmsInventoryCountSession.update({
      where: { id: session.id },
      data: {
        status: WmsInventoryCountSessionStatus.CLOSED,
        closedAt: new Date(),
        closedById: userId ?? undefined,
        notes: this.cleanOptionalText(body.notes) ?? session.notes,
      },
    });

    const refreshed = await this.findMobileCountSessionById(session.id, session.tenantId);

    await this.recordStockActivity(user, request, {
      tenantId: session.tenantId,
      actionType: 'STOCK_COUNT_CLOSEOUT',
      resourceType: 'WMS_INVENTORY_COUNT_SESSION',
      resourceId: session.id,
      warehouseId: session.warehouseId,
      metadata: {
        locationCode: session.location.code,
      },
    });

    return {
      session: refreshed ? this.mapMobileCountSessionDetail(refreshed) : null,
    };
  }

  async lookupTrackingOrder(
    user: BootstrapUser,
    query: GetWmsMobileTrackingLookupDto,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: query.tenantId }, request);
    const normalizedCode = this.normalizeTrackingCode(query.code);
    const fulfillmentGoLiveAt = await this.getFulfillmentGoLiveAt(tenantContext.tenantId);
    const candidates = await this.prisma.wmsFulfillmentOrder.findMany({
      where: {
        ...(tenantContext.tenantId ? { tenantId: tenantContext.tenantId } : {}),
        status: {
          in: [
            WmsFulfillmentOrderStatus.READY,
            WmsFulfillmentOrderStatus.PARTIAL,
            WmsFulfillmentOrderStatus.RESTOCKING,
            WmsFulfillmentOrderStatus.ISSUE,
            WmsFulfillmentOrderStatus.IN_PICKING,
            WmsFulfillmentOrderStatus.READY_FOR_PACK,
            WmsFulfillmentOrderStatus.PICKED,
            WmsFulfillmentOrderStatus.PACKING,
            WmsFulfillmentOrderStatus.PACKED,
          ],
        },
        posOrder: {
          is: {
            ...(fulfillmentGoLiveAt
              ? {
                  insertedAt: {
                    gte: fulfillmentGoLiveAt,
                  },
                }
              : {}),
            tracking: {
              contains: query.code.trim(),
              mode: 'insensitive',
            },
          },
        },
      },
      include: this.pickingTaskInclude(),
      orderBy: [{ updatedAt: 'desc' }],
      take: 8,
    });

    const order = candidates.find((candidate) => (
      this.normalizeTrackingCode(candidate.posOrder?.tracking ?? '') === normalizedCode
    )) ?? null;

    await this.recordStockActivity(user, request, {
      tenantId: tenantContext.tenantId,
      actionType: 'STOCK_SCAN',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: order?.id ?? null,
      storeId: order?.storeId ?? null,
      warehouseId: order?.warehouseId ?? null,
      metadata: {
        code: normalizedCode,
        source: 'tracking',
        found: Boolean(order),
      },
    });

    return {
      found: Boolean(order),
      code: normalizedCode,
      task: order ? this.mapMobilePickingTask(order) : null,
      returnFlow: order ? await this.buildTrackingReturnFlow(order) : null,
    };
  }

  async getRtsTasks(
    user: BootstrapUser,
    query: GetWmsMobileRtsTasksDto,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: query.tenantId }, request);
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_RTS_PAGE_SIZE, 5), 50);
    const normalizedSearch = query.search?.trim() || null;
    const searchWhere: Prisma.WmsFulfillmentOrderWhereInput = normalizedSearch
      ? {
          OR: [
            { posOrderId: { contains: normalizedSearch, mode: 'insensitive' } },
            {
              store: {
                is: {
                  OR: [
                    { name: { contains: normalizedSearch, mode: 'insensitive' } },
                    { shopName: { contains: normalizedSearch, mode: 'insensitive' } },
                  ],
                },
              },
            },
            {
              posOrder: {
                is: {
                  OR: [
                    { customerName: { contains: normalizedSearch, mode: 'insensitive' } },
                    { tracking: { contains: normalizedSearch, mode: 'insensitive' } },
                  ],
                },
              },
            },
          ],
        }
      : {};
    const where = {
      ...this.buildOpenRtsOrderWhere({
      ...(tenantContext.tenantId ? { tenantId: tenantContext.tenantId } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      }, query.state),
      ...searchWhere,
    } satisfies Prisma.WmsFulfillmentOrderWhereInput;

    const [total, orders, stores] = await Promise.all([
      this.prisma.wmsFulfillmentOrder.count({ where }),
      this.prisma.wmsFulfillmentOrder.findMany({
        where,
        include: this.pickingTaskInclude(),
        orderBy: [
          { updatedAt: 'desc' },
          { id: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.posStore.findMany({
        where: {
          ...(tenantContext.tenantId ? { tenantId: tenantContext.tenantId } : {}),
          status: IntegrationStatus.ACTIVE,
          ...(query.storeId ? { id: query.storeId } : {}),
        },
        select: {
          id: true,
          tenantId: true,
          name: true,
          shopName: true,
          tenant: {
            select: {
              name: true,
              slug: true,
            },
          },
        },
        orderBy: [{ shopName: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const tasks = await Promise.all(
      orders.map(async (order) => ({
        task: this.mapMobilePickingTask(order),
        returnFlow: await this.buildTrackingReturnFlow(order),
      })),
    );

    return {
      tenantReady: Boolean(tenantContext.tenantId),
      serverTime: new Date().toISOString(),
      pagination: {
        page,
        pageSize,
        total,
        hasMore: page * pageSize < total,
      },
      context: {
        activeTenantId: tenantContext.tenantId,
        activeStoreId: query.storeId ?? null,
        stores: stores.map((store) => ({
          id: store.id,
          tenantId: store.tenantId,
          name: store.shopName || store.name,
          tenantName: store.tenant?.name ?? null,
          tenantSlug: store.tenant?.slug ?? null,
        })),
      },
      tasks,
    };
  }

  async verifyTrackingReturnUnit(
    user: BootstrapUser,
    id: string,
    body: WmsMobileTrackingReturnUnitDto,
    request?: Request,
  ) {
    const order = await this.findRtsOrderForAction(user, id, body.tenantId, request);
    this.assertOrderReadyForRtsVerification(order);

    const scannedCode = this.normalizeScannedCode(body.code);
    const trackedUnits = await this.getTrackedReturnUnits(order);
    const matchedUnit = trackedUnits.find((unit: any) => (
      unit.code === scannedCode
      || unit.barcode === scannedCode
      || unit.id === scannedCode
    )) as any | null;

    if (!matchedUnit) {
      const scannedUnit = await this.findUnitByCode(scannedCode, order.tenantId);
      if (!scannedUnit) {
        throw new BadRequestException(`Unit ${scannedCode} is not part of order ${order.posOrderId}`);
      }

      const requiredVariationIds = new Set(
        trackedUnits.map((unit: any) => unit.variationId),
      );
      if (requiredVariationIds.has(scannedUnit.variationId)) {
        throw new BadRequestException(`Unit ${scannedUnit.code} is not one of the dispatched units for order ${order.posOrderId}`);
      }

      throw new BadRequestException(`Unit ${scannedUnit.code} is not one of the products assigned to order ${order.posOrderId}`);
    }

    const unit = matchedUnit;
    if (unit.status === WmsInventoryUnitStatus.DISPATCHED) {
      const rtsLocation = await this.resolveWarehouseOperationalLocation(unit.warehouseId, WmsLocationKind.RTS);
      const now = new Date();
      const updatedOrder = await this.prisma.$transaction(async (tx) => {
        await tx.wmsInventoryUnit.update({
          where: { id: unit.id },
          data: {
            status: WmsInventoryUnitStatus.RTS,
            currentLocationId: rtsLocation.id,
            updatedById: user.userId || user.id || undefined,
          },
        });

        await tx.wmsInventoryMovement.create({
          data: {
            tenantId: order.tenantId,
            inventoryUnitId: unit.id,
            warehouseId: unit.warehouseId,
            fromLocationId: unit.currentLocationId,
            toLocationId: rtsLocation.id,
            fromStatus: unit.status,
            toStatus: WmsInventoryUnitStatus.RTS,
            movementType: WmsInventoryMovementType.ADJUSTMENT,
            referenceType: 'WMS_FULFILLMENT_ORDER',
            referenceId: order.id,
            referenceCode: order.posOrderId,
            notes: `Returned unit ${unit.code} verified from waybill ${order.posOrder?.tracking ?? order.posOrderId}`,
            actorId: user.userId || user.id || null,
          },
        });

        await tx.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            rtsDisposedById: null,
            rtsDisposedAt: null,
          },
        });

        return tx.wmsFulfillmentOrder.findUniqueOrThrow({
          where: { id: order.id },
          include: this.pickingTaskInclude(),
        });
      });

      await this.recordStockActivity(user, request, {
        tenantId: updatedOrder.tenantId,
        actionType: 'ORDER_RTS_UNIT_VERIFY',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: updatedOrder.id,
        taskType: 'DISPATCH',
        taskId: updatedOrder.id,
        storeId: updatedOrder.storeId,
        warehouseId: updatedOrder.warehouseId ?? unit.warehouseId,
        fromStatus: WmsInventoryUnitStatus.DISPATCHED,
        toStatus: WmsInventoryUnitStatus.RTS,
        metadata: {
          posOrderId: updatedOrder.posOrderId,
          posStatus: updatedOrder.posOrder?.status ?? null,
          trackingCode: updatedOrder.posOrder?.tracking ?? null,
          unitCode: unit.code,
          unitId: unit.id,
          unitCount: 1,
          targetCode: rtsLocation.code,
        },
      });

      const returnFlow = await this.buildTrackingReturnFlow(updatedOrder);
      if (returnFlow.state === 'VERIFIED') {
        await this.recordStockActivity(user, request, {
          tenantId: updatedOrder.tenantId,
          actionType: 'ORDER_RTS_COMPLETE',
          resourceType: 'WMS_FULFILLMENT_ORDER',
          resourceId: updatedOrder.id,
          taskType: 'DISPATCH',
          taskId: updatedOrder.id,
          storeId: updatedOrder.storeId,
          warehouseId: updatedOrder.warehouseId ?? unit.warehouseId,
          fromStatus: WmsInventoryUnitStatus.DISPATCHED,
          toStatus: WmsInventoryUnitStatus.RTS,
          metadata: {
            posOrderId: updatedOrder.posOrderId,
            posStatus: updatedOrder.posOrder?.status ?? null,
            trackingCode: updatedOrder.posOrder?.tracking ?? null,
            unitCodes: returnFlow.verifiedUnits.map((verifiedUnit: any) => verifiedUnit.code),
            unitCount: returnFlow.verifiedUnits.length,
          },
        });
      }

      return {
        success: true,
        task: this.mapMobilePickingTask(updatedOrder),
        returnFlow,
        unit: {
          id: unit.id,
          code: unit.code,
          status: WmsInventoryUnitStatus.RTS,
          statusLabel: this.formatEnumLabel(WmsInventoryUnitStatus.RTS),
          currentLocation: this.mapLocation(rtsLocation),
        },
      };
    }

    if (RETURNED_EQUIVALENT_UNIT_STATUSES.has(unit.status)) {
      throw new ConflictException(`Unit ${unit.code} was already processed as a returned item`);
    }

    if (unit.status === WmsInventoryUnitStatus.PACKED) {
      throw new BadRequestException(`Unit ${unit.code} has not been dispatched yet`);
    }

    throw new BadRequestException(`Unit ${unit.code} is ${this.formatEnumLabel(unit.status)} and cannot be verified as RTS`);
  }

  async dispositionTrackingReturnUnit(
    user: BootstrapUser,
    id: string,
    body: WmsMobileTrackingReturnDispositionDto,
    request?: Request,
  ) {
    const order = await this.findRtsOrderForAction(
      user,
      id,
      body.tenantId,
      request,
      RTS_DISPOSITION_ACTION_PERMISSIONS,
      'This account does not have WMS RTS disposition permission',
    );
    this.assertOrderReadyForRtsVerification(order);

    const trackedUnits = await this.getTrackedReturnUnits(order);
    const unit = (trackedUnits.find((candidate: any) => candidate.id === body.unitId) ?? null) as any | null;
    if (!unit) {
      throw new BadRequestException(`Unit ${body.unitId} is not part of order ${order.posOrderId}`);
    }

    if (unit.status === WmsInventoryUnitStatus.DISPATCHED || unit.status === WmsInventoryUnitStatus.PACKED) {
      throw new BadRequestException(`Unit ${unit.code} must be verified as RTS before disposition`);
    }

    if (unit.status !== WmsInventoryUnitStatus.RTS) {
      throw new ConflictException(`Unit ${unit.code} is already ${this.formatEnumLabel(unit.status)}`);
    }

    const unitRecord = await this.findUnitById(unit.id, order.tenantId);
    if (!unitRecord) {
      throw new NotFoundException('Inventory unit was not found');
    }

    await this.assertActionTenantAccess(user, body.tenantId, unitRecord.tenantId, request);
    this.assertMobileActionPreconditions(unitRecord, body);

    const targetCode = this.cleanOptionalText(body.targetCode);
    const target = await this.resolveTrackingReturnDispositionTarget(
      unitRecord.warehouseId,
      body.disposition,
      targetCode,
    );
    const { nextStatus, actionLabel, requiresTransfer } = this.resolveRtsDisposition(
      body.disposition,
      target?.kind ?? null,
    );
    const nextLocationId = target?.id ?? null;
    const notes = this.cleanOptionalText(body.notes)
      ?? (
        target
          ? `RTS disposition ${actionLabel.toLowerCase()} to ${target.code}`
          : `RTS disposition ${actionLabel.toLowerCase()}`
      );
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      if (target?.kind === WmsLocationKind.BIN) {
        await this.assertLocationCapacity(tx, target.id, target.code, target.capacity, 1, unitRecord.currentLocationId);
      }

      let transfer: { id: string; code: string } | null = null;

      if (requiresTransfer && target) {
        transfer = await tx.wmsTransfer.create({
          data: {
            code: this.buildMobileTransferCode(),
            tenantId: unitRecord.tenantId,
            warehouseId: unitRecord.warehouseId,
            fromLocationId: unitRecord.currentLocationId,
            toLocationId: target.id,
            status: WmsTransferStatus.COMPLETED,
            notes,
            createdById: user.userId || user.id || null,
            updatedById: user.userId || user.id || null,
          },
          select: {
            id: true,
            code: true,
          },
        });

        await tx.wmsTransferItem.create({
          data: {
            transferId: transfer.id,
            inventoryUnitId: unitRecord.id,
            lineNo: 1,
          },
        });
      }

      const updatedUnit = await tx.wmsInventoryUnit.update({
        where: { id: unitRecord.id },
        data: {
          currentLocationId: nextLocationId,
          status: nextStatus,
          updatedById: user.userId || user.id || undefined,
        },
        include: this.mobileUnitInclude(),
      });

      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: unitRecord.tenantId,
          inventoryUnitId: unitRecord.id,
          warehouseId: unitRecord.warehouseId,
          fromLocationId: unitRecord.currentLocationId,
          toLocationId: nextLocationId,
          fromStatus: unitRecord.status,
          toStatus: nextStatus,
          movementType: transfer ? WmsInventoryMovementType.TRANSFER : WmsInventoryMovementType.ADJUSTMENT,
          referenceType: transfer ? 'TRANSFER' : 'WMS_FULFILLMENT_ORDER',
          referenceId: transfer?.id ?? order.id,
          referenceCode: transfer?.code ?? order.posOrderId,
          notes,
          actorId: user.userId || user.id || null,
          createdAt: now,
        },
      });

      const releasedBasketHoldCount = await this.releaseReturnedUnitBasketHoldsTx(
        tx,
        unitRecord.id,
        user.userId || user.id || null,
        now,
      );

      const completionState = await this.resolveTrackingReturnCompletionStateTx(tx, order.id, this.isDemandPickingOrder(order));

      await tx.wmsFulfillmentOrder.update({
        where: { id: order.id },
        data: completionState.isComplete
          ? {
              rtsDisposedById: user.userId || user.id || null,
              rtsDisposedAt: now,
            }
          : {
              rtsDisposedById: null,
              rtsDisposedAt: null,
            },
      });

      const updatedOrder = await tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: this.pickingTaskInclude(),
      });

      return {
        updatedOrder,
        updatedUnit,
        releasedBasketHoldCount,
      };
    });

    await this.recordStockActivity(user, request, {
      tenantId: order.tenantId,
      actionType: 'ORDER_RTS_DISPOSITION',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: order.id,
      taskType: 'DISPATCH',
      taskId: order.id,
      storeId: order.storeId,
      warehouseId: unitRecord.warehouseId,
      fromStatus: unitRecord.status,
      toStatus: nextStatus,
      metadata: {
        posOrderId: order.posOrderId,
        posStatus: order.posOrder?.status ?? null,
        trackingCode: order.posOrder?.tracking ?? null,
        unitCode: unitRecord.code,
        unitId: unitRecord.id,
        unitCount: 1,
        targetCode: target?.code ?? null,
        dispositionAction: body.disposition,
        releasedBasketHoldCount: result.releasedBasketHoldCount,
      },
    });

    if (nextStatus === WmsInventoryUnitStatus.PUTAWAY || nextStatus === WmsInventoryUnitStatus.DEADSTOCK) {
      await this.wmsFulfillmentSyncService.reallocateWaitingOrdersForRestockedVariations({
        tenantId: unitRecord.tenantId,
        storeId: unitRecord.storeId,
        warehouseId: unitRecord.warehouseId,
        variationIds: [unitRecord.variationId],
        actorId: user.userId || user.id || null,
      });
    }

    return {
      success: true,
      task: this.mapMobilePickingTask(result.updatedOrder),
      returnFlow: await this.buildTrackingReturnFlow(result.updatedOrder),
      unit: this.mapMobileUnitDetail(result.updatedUnit),
    };
  }

  async putawayStockUnit(user: BootstrapUser, body: WmsMobileStockMoveDto, request?: Request) {
    const unit = await this.findUnitById(body.unitId, body.tenantId ?? null);
    if (!unit) {
      throw new NotFoundException('Inventory unit was not found');
    }

    await this.assertActionTenantAccess(user, body.tenantId, unit.tenantId, request);
    this.assertMobileActionPreconditions(unit, body);

    if (!this.isMobilePutawayCandidate(unit)) {
      throw new BadRequestException(
        `Unit ${unit.code} is not in receiving staging. Use Move for already stored units.`,
      );
    }
    if (unit.productProfile.requiresExpirationDate && !unit.expirationDate) {
      throw new BadRequestException(
        `Unit ${unit.code} requires an expiration date. Set it in Inventory > Transfer before put-away.`,
      );
    }
    if (isExpiredInventoryDate(unit.expirationDate)) {
      throw new BadRequestException(`Unit ${unit.code} has already expired and cannot be put away`);
    }

    const target = await this.resolveTargetLocation(body.targetCode, unit.warehouseId);
    if (target.kind !== WmsLocationKind.BIN) {
      throw new BadRequestException('Putaway target must be a bin');
    }

    const notes = this.cleanOptionalText(body.notes) ?? `STOX putaway to ${target.code}`;
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      await this.assertLocationCapacity(tx, target.id, target.code, target.capacity, 1, unit.currentLocationId);

      const updatedUnit = await tx.wmsInventoryUnit.update({
        where: { id: unit.id },
        data: {
          currentLocationId: target.id,
          status: WmsInventoryUnitStatus.PUTAWAY,
          expiredAt: null,
          updatedById: user.userId || user.id || undefined,
        },
        include: this.mobileUnitInclude(),
      });

      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: unit.tenantId,
          inventoryUnitId: unit.id,
          warehouseId: unit.warehouseId,
          fromLocationId: unit.currentLocationId,
          toLocationId: target.id,
          fromStatus: unit.status,
          toStatus: WmsInventoryUnitStatus.PUTAWAY,
          movementType: WmsInventoryMovementType.PUTAWAY,
          referenceType: unit.receivingBatchId ? 'RECEIVING_BATCH' : 'STOX_PUTAWAY',
          referenceId: unit.receivingBatchId,
          referenceCode: unit.receivingBatch?.code ?? null,
          notes,
          actorId: user.userId || user.id || null,
          createdAt: now,
        },
      });

      if (unit.receivingBatchId) {
        await this.refreshReceivingBatchPutawayState(tx, unit.receivingBatchId, user.userId || user.id || null, now);
      }

      return updatedUnit;
    });

    await this.recordStockActivity(user, request, {
      tenantId: unit.tenantId,
      actionType: 'STOCK_PUTAWAY',
      resourceType: 'WMS_INVENTORY_UNIT',
      resourceId: unit.id,
      storeId: unit.storeId,
      warehouseId: unit.warehouseId,
      metadata: {
        clientRequestId: body.clientRequestId ?? null,
        targetLocationId: target.id,
        targetCode: target.code,
      },
    });

    await this.wmsFulfillmentSyncService.reallocateWaitingOrdersForRestockedVariations({
      tenantId: unit.tenantId,
      storeId: unit.storeId,
      warehouseId: unit.warehouseId,
      variationIds: [unit.variationId],
      actorId: user.userId || user.id || null,
    });

    return {
      success: true,
      unit: this.mapMobileUnitDetail(result),
    };
  }

  async moveStockUnit(user: BootstrapUser, body: WmsMobileStockMoveDto, request?: Request) {
    const unit = await this.findUnitById(body.unitId, body.tenantId ?? null);
    if (!unit) {
      throw new NotFoundException('Inventory unit was not found');
    }

    await this.assertActionTenantAccess(user, body.tenantId, unit.tenantId, request);
    this.assertMobileActionPreconditions(unit, body);

    if (!unit.currentLocationId) {
      throw new BadRequestException(`Unit ${unit.code} is missing a current location`);
    }

    if (this.isMobilePutawayCandidate(unit)) {
      throw new BadRequestException(`Use Putaway for unit ${unit.code} from receiving staging`);
    }

    if (!STOCK_TRANSFERABLE_UNIT_STATUSES.includes(unit.status as typeof STOCK_TRANSFERABLE_UNIT_STATUSES[number])) {
      throw new BadRequestException(`Unit ${unit.code} cannot be moved from ${unit.status}`);
    }

    const target = await this.resolveTargetLocation(body.targetCode, unit.warehouseId);
    if (target.id === unit.currentLocationId) {
      throw new BadRequestException('Target location must be different from the current location');
    }

    if (!this.isMobileMoveDestinationAllowed(target.kind)) {
      throw new BadRequestException('Target location is not valid for a mobile stock move');
    }

    const nextStatus = this.resolveMobileMoveStatus(unit.status, target.kind);
    const transferCode = this.buildMobileTransferCode();
    const notes = this.cleanOptionalText(body.notes) ?? `STOX move to ${target.code}`;
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      if (target.kind === WmsLocationKind.BIN) {
        await this.assertLocationCapacity(tx, target.id, target.code, target.capacity, 1, unit.currentLocationId);
      }

      const transfer = await tx.wmsTransfer.create({
        data: {
          code: transferCode,
          tenantId: unit.tenantId,
          warehouseId: unit.warehouseId,
          fromLocationId: unit.currentLocationId,
          toLocationId: target.id,
          status: WmsTransferStatus.COMPLETED,
          notes,
          createdById: user.userId || user.id || null,
          updatedById: user.userId || user.id || null,
        },
      });

      await tx.wmsTransferItem.create({
        data: {
          transferId: transfer.id,
          inventoryUnitId: unit.id,
          lineNo: 1,
        },
      });

      const updatedUnit = await tx.wmsInventoryUnit.update({
        where: { id: unit.id },
        data: {
          currentLocationId: target.id,
          status: nextStatus,
          updatedById: user.userId || user.id || undefined,
        },
        include: this.mobileUnitInclude(),
      });

      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: unit.tenantId,
          inventoryUnitId: unit.id,
          warehouseId: unit.warehouseId,
          fromLocationId: unit.currentLocationId,
          toLocationId: target.id,
          fromStatus: unit.status,
          toStatus: nextStatus,
          movementType: WmsInventoryMovementType.TRANSFER,
          referenceType: 'TRANSFER',
          referenceId: transfer.id,
          referenceCode: transfer.code,
          notes,
          actorId: user.userId || user.id || null,
          createdAt: now,
        },
      });

      return {
        transfer,
        unit: updatedUnit,
      };
    });

    await this.recordStockActivity(user, request, {
      tenantId: unit.tenantId,
      actionType: 'STOCK_MOVE',
      resourceType: 'WMS_INVENTORY_UNIT',
      resourceId: unit.id,
      storeId: unit.storeId,
      warehouseId: unit.warehouseId,
      metadata: {
        clientRequestId: body.clientRequestId ?? null,
        targetLocationId: target.id,
        targetCode: target.code,
        transferId: result.transfer.id,
        transferCode: result.transfer.code,
      },
    });

    return {
      success: true,
      transfer: {
        id: result.transfer.id,
        code: result.transfer.code,
        status: result.transfer.status,
      },
      unit: this.mapMobileUnitDetail(result.unit),
    };
  }

  async getPickingTasks(user: BootstrapUser, query: GetWmsMobilePickingTasksDto, request?: Request) {
    const userId = user.userId || user.id || null;
    const tenantContext = await this.resolveMobileStockContext(user, query as GetWmsMobileStockDto, request);
    const tenantId = tenantContext.tenantId;
    const sessionId = (this.cls.get('sessionId') as string | undefined) || user.sessionId || null;

    if (!userId) {
      return this.buildEmptyPickingResponse(false);
    }

    const [access, taskAssignment] = await Promise.all([
      this.effectiveAccessService.resolveUserAccess({
        userId,
        basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
        workspace: 'wms',
      }),
      this.getWmsTaskAssignment(userId),
    ]);
    const pickQueueAccess = this.resolvePickQueueAccess(user, access.permissions, taskAssignment);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PICKING_PAGE_SIZE;
    const skip = (page - 1) * pageSize;
    const activeStoxAssignmentWhere = this.buildActiveStoxAssignmentWhere();

    const stores = await this.prisma.posStore.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        status: IntegrationStatus.ACTIVE,
      },
      select: {
        id: true,
        tenantId: true,
        teamId: true,
        name: true,
        shopId: true,
        shopName: true,
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
      orderBy: [{ name: 'asc' }],
    });

    const activeStore = query.storeId
      ? stores.find((store) => store.id === query.storeId) ?? null
      : null;

    if (query.storeId && !activeStore) {
      throw new ForbiddenException('Selected store is not available for STOX picking');
    }

    const statusFilter = query.status
      ? (query.status as WmsFulfillmentOrderStatus)
      : { in: [...ACTIVE_PICKING_ORDER_STATUSES] };
    const ownedOnly = Boolean(query.ownedOnly && userId && !pickQueueAccess.canViewAll);
    const effectiveGoLiveTenantId = tenantId ?? activeStore?.tenantId ?? null;
    const singleTenantGoLiveAt = await this.getFulfillmentGoLiveAt(effectiveGoLiveTenantId);
    const multiTenantGoLiveFilters = effectiveGoLiveTenantId
      ? []
      : await this.buildTenantGoLiveFulfillmentOrderFilters(
          Array.from(new Set(stores.map((store) => store.tenantId))),
        );
    const goLiveAndClauses: Prisma.WmsFulfillmentOrderWhereInput[] = singleTenantGoLiveAt
      ? [this.buildFulfillmentGoLiveWhere(singleTenantGoLiveAt)]
      : multiTenantGoLiveFilters.length > 0
        ? [{ OR: multiTenantGoLiveFilters }]
        : [];
    const confirmedPickOrderWhere = this.buildConfirmedPickPosOrderWhere();
    const scopedWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(activeStore ? { storeId: activeStore.id } : {}),
      ...(goLiveAndClauses.length > 0 ? { AND: goLiveAndClauses } : {}),
    };
    const normalizedSearch = query.search?.trim() || null;
    const searchWhere: Prisma.WmsFulfillmentOrderWhereInput = normalizedSearch
      ? {
          OR: [
            { posOrderId: { contains: normalizedSearch, mode: 'insensitive' } },
            {
              store: {
                is: {
                  OR: [
                    { name: { contains: normalizedSearch, mode: 'insensitive' } },
                    { shopName: { contains: normalizedSearch, mode: 'insensitive' } },
                  ],
                },
              },
            },
            {
              posOrder: {
                is: {
                  customerName: { contains: normalizedSearch, mode: 'insensitive' },
                },
              },
            },
          ],
        }
      : {};
    const queueOwnershipWhere: Prisma.WmsFulfillmentOrderWhereInput = ownedOnly
      ? { claimedById: userId }
      : {};
    const heldBasketOrderWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      ...activeStoxAssignmentWhere,
      ...(activeStore ? { storeId: activeStore.id } : {}),
      OR: [
        {
          status: {
            in: [...ACTIVE_PICKING_ORDER_STATUSES],
          },
          ...confirmedPickOrderWhere,
        },
        {
          status: {
            in: [
              WmsFulfillmentOrderStatus.READY_FOR_PACK,
              WmsFulfillmentOrderStatus.PICKED,
            ],
          },
        },
      ],
    };
    const heldBasketWhere: Prisma.WmsBasketWhereInput = {
      ...(pickQueueAccess.canViewAll
        ? {}
        : userId
          ? { assignedPickerId: userId }
          : { assignedPickerId: '__missing_user__' }),
      OR: [
        {
          status: {
            in: [...PICKER_ACTIVE_BASKET_STATUSES],
          },
        },
        {
          status: WmsBasketStatus.FULL_HELD,
          assignedPackerId: null,
        },
      ],
      ...(tenantId ? { tenantId } : {}),
      fulfillmentOrders: {
        some: heldBasketOrderWhere,
      },
    };
    const openBasketWhere: Prisma.WmsBasketWhereInput = {
      warehouseId: {
        not: null,
      },
      OR: [
        {
          status: WmsBasketStatus.AVAILABLE,
        },
        {
          assignedPickerId: userId,
          status: {
            in: [
              WmsBasketStatus.ASSIGNED,
              WmsBasketStatus.IN_PICKING,
            ],
          },
          ...(tenantId ? { tenantId } : {}),
          fulfillmentOrders: {
            some: {
              ...activeStoxAssignmentWhere,
              ...(activeStore ? { storeId: activeStore.id } : {}),
              status: {
                in: [...ACTIVE_BASKET_ORDER_STATUSES],
              },
              ...confirmedPickOrderWhere,
            },
          },
        },
      ],
    };
    const registeredBasketWhere: Prisma.WmsBasketWhereInput = {
      status: {
        notIn: [...BLOCKED_PICK_BASKET_STATUSES],
      },
      warehouseId: {
        not: null,
      },
    };
    const activeBasketWhere: Prisma.WmsBasketWhereInput = {
      ...(pickQueueAccess.canViewAll
        ? {}
        : userId
          ? { assignedPickerId: userId }
          : { assignedPickerId: '__missing_user__' }),
      status: {
        in: [...PICKER_ACTIVE_BASKET_STATUSES],
      },
      ...(tenantId ? { tenantId } : {}),
      fulfillmentOrders: {
        some: {
          ...activeStoxAssignmentWhere,
          ...(activeStore ? { storeId: activeStore.id } : {}),
          status: {
            in: [...ACTIVE_BASKET_ORDER_STATUSES],
          },
          ...confirmedPickOrderWhere,
        },
      },
    };
    const pickedHistoryWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      ...scopedWhere,
      ...activeStoxAssignmentWhere,
      ...(pickQueueAccess.canViewAll ? {} : { claimedById: userId }),
      status: {
        in: [
          WmsFulfillmentOrderStatus.READY_FOR_PACK,
          WmsFulfillmentOrderStatus.PICKED,
        ],
      },
      basket: {
        isNot: null,
      },
    };
    const taskWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      ...scopedWhere,
      ...activeStoxAssignmentWhere,
      ...confirmedPickOrderWhere,
      ...queueOwnershipWhere,
      ...searchWhere,
      status: statusFilter,
    };

    const [total, statusGroups, tasks, heldBaskets, pickedHistory, activeLoad, registeredBasketCount, openBasketCandidates, packerOptions] = await Promise.all([
      this.prisma.wmsFulfillmentOrder.count({ where: taskWhere }),
      this.prisma.wmsFulfillmentOrder.groupBy({
        by: ['status'],
        where: {
          ...scopedWhere,
          ...activeStoxAssignmentWhere,
          ...confirmedPickOrderWhere,
          ...queueOwnershipWhere,
          ...searchWhere,
        },
        _count: {
          _all: true,
        },
      }),
      this.prisma.wmsFulfillmentOrder.findMany({
        where: taskWhere,
        include: this.pickingTaskInclude(),
        orderBy: query.status
          ? [
              { priorityOverrideAt: 'desc' },
              { posOrder: { dateLocal: 'asc' } },
              { id: 'asc' },
            ]
          : [
              { priorityOverrideAt: 'desc' },
              { status: 'asc' },
              { posOrder: { dateLocal: 'asc' } },
              { id: 'asc' },
            ],
        skip,
        take: pageSize,
      }),
      this.prisma.wmsBasket.findMany({
        where: heldBasketWhere,
        include: {
          fulfillmentOrders: {
            where: heldBasketOrderWhere,
            include: this.pickingTaskInclude(),
            orderBy: [
              { updatedAt: 'desc' },
              { createdAt: 'desc' },
            ],
          },
        },
        orderBy: [
          { status: 'asc' },
          { fullAt: 'desc' },
          { claimedAt: 'desc' },
          { createdAt: 'desc' },
        ],
      }),
      this.prisma.wmsFulfillmentOrder.findMany({
        where: pickedHistoryWhere,
        include: this.pickingTaskInclude(),
        orderBy: [
          { completedAt: 'desc' },
          { updatedAt: 'desc' },
        ],
        take: 20,
      }),
      this.prisma.wmsBasket.count({ where: activeBasketWhere }),
      this.prisma.wmsBasket.count({ where: registeredBasketWhere }),
      this.prisma.wmsBasket.findMany({
        where: openBasketWhere,
        include: this.mobileBasketInclude(),
        orderBy: [
          { status: 'asc' },
          { warehouse: { name: 'asc' } },
          { barcode: 'asc' },
        ],
        take: 80,
      }),
      this.listPackingHandoffCandidates(),
    ]);
    const openBaskets = openBasketCandidates
      .filter((basket) => this.getOpenBasketSlotCount(basket) > 0)
      .slice(0, 40);
    const openBasketSlotCount = openBaskets.reduce(
      (totalSlots, basket) => totalSlots + this.getOpenBasketSlotCount(basket),
      0,
    );

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId: tenantId ?? activeStore?.tenantId ?? null,
      actorId: userId,
      sessionId,
      actionType: 'PICKING_VIEW',
      resourceType: 'STOX_PICKING',
      resourceId: activeStore?.id ?? null,
      storeId: activeStore?.id ?? null,
      metadata: {
        page,
        pageSize,
        status: query.status ?? null,
        search: normalizedSearch,
        total,
      },
    });

    return {
      tenantReady: true,
      serverTime: new Date().toISOString(),
      pagination: {
        page,
        pageSize,
        total,
        hasMore: page * pageSize < total,
      },
      context: {
        tenantOptions: tenantContext.tenantOptions,
        activeTenantId: tenantId,
        activeStoreId: activeStore?.id ?? null,
        canViewAllQueue: pickQueueAccess.canViewAll,
        stores: stores.map((store) => ({
          id: store.id,
          tenantId: store.tenantId,
          name: store.shopName || store.name,
          tenantName: store.tenant.name,
          tenantSlug: store.tenant.slug,
        })),
        packerOptions,
        taskAssignment,
      },
      summary: this.mapPickingSummary(statusGroups),
      picker: {
        registeredBaskets: registeredBasketCount,
        activeLoad,
        availableSlots: openBasketSlotCount,
        heldBaskets: heldBaskets.length,
        fullHeldBaskets: heldBaskets.filter((basket) => basket.status === WmsBasketStatus.FULL_HELD).length,
      },
      availableBaskets: openBaskets.map((basket) => this.mapMobilePickBasket(basket)),
      heldBaskets: heldBaskets.map((basket) => this.mapMobileHeldBasket(basket)),
      pickedHistory: pickedHistory.map((task) => this.mapMobilePickingTask(task)),
      tasks: tasks.map((task) => this.mapMobilePickingTask(task)),
    };
  }

  async resyncPickingTasks(user: BootstrapUser, body: WmsMobilePickResyncDto, request?: Request) {
    const userId = user.userId || user.id || null;
    const sessionId = (this.cls.get('sessionId') as string | undefined) || user.sessionId || null;
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: body.tenantId } as GetWmsMobileStockDto,
      request,
    );
    const tenantId = tenantContext.tenantId;

    if (!userId) {
      throw new ForbiddenException('User context is required for queue resync');
    }

    this.assertLegacyRetirementConfiguration();

    if (user.role === 'SUPER_ADMIN' && !tenantId) {
      throw new BadRequestException('Select a partner before resyncing the pick queue');
    }

    const stores = await this.prisma.posStore.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        status: IntegrationStatus.ACTIVE,
      },
      select: {
        id: true,
        tenantId: true,
        teamId: true,
        name: true,
        shopId: true,
        shopName: true,
      },
      orderBy: [{ name: 'asc' }],
    });

    const activeStore = body.storeId
      ? stores.find((store) => store.id === body.storeId) ?? null
      : null;

    if (body.storeId && !activeStore) {
      throw new ForbiddenException('Selected store is not available for WMS fulfillment resync');
    }

    if (this.integrationService) {
      let storesToLiveSync = activeStore ? [activeStore] : [];
      if (!activeStore && stores.length > 0) {
        if (typeof (this.prisma as any).wmsFulfillmentOrder?.findMany === 'function') {
          const openPickStoreRows = await this.prisma.wmsFulfillmentOrder.findMany({
            where: {
              ...(tenantId ? { tenantId } : {}),
              storeId: { in: stores.map((store) => store.id) },
              status: { in: [...ACTIVE_PICKING_ORDER_STATUSES] },
            },
            select: { storeId: true },
            distinct: ['storeId'],
          });
          const openStoreIdSet = new Set(openPickStoreRows.map((row) => row.storeId));
          const prioritized = [
            ...stores.filter((store) => openStoreIdSet.has(store.id)),
            ...stores.filter((store) => !openStoreIdSet.has(store.id)),
          ];
          storesToLiveSync = prioritized.slice(0, 12);
        } else {
          storesToLiveSync = stores.slice(0, 12);
        }
      }

      const syncBatchSize = 3;
      for (let idx = 0; idx < storesToLiveSync.length; idx += syncBatchSize) {
        const batch = storesToLiveSync.slice(idx, idx + syncBatchSize);
        await Promise.all(
          batch.map(async (targetStore) => {
            try {
              await this.integrationService!.syncPancakeOrdersByStoreId(
                targetStore.id,
                targetStore.tenantId,
                { days: 7, repairIssueOrders: true },
              );
            } catch (error: any) {
              this.logger.warn(
                `Live POS store sync skipped during picking queue resync for store=${targetStore.id}: ${error?.message || 'Unknown error'}`,
              );
            }
          }),
        );
      }

      try {
        await this.integrationService.reconcileOpenWmsIssueOrders({
          tenantId,
          storeId: activeStore?.id ?? null,
          limit: 60,
          forceCatalogSync: true,
        });
      } catch (error: any) {
        this.logger.warn(
          `Live ISSUE order reconciliation skipped during picking queue resync: ${error?.message || 'Unknown error'}`,
        );
      }
    }

    const result = await this.wmsFulfillmentSyncService.syncConfirmedPickingOrders({
      tenantId,
      storeId: activeStore?.id ?? null,
      actorId: userId,
      stores: stores.map((store) => ({
        id: store.id,
        tenantId: store.tenantId,
        shopId: store.shopId,
      })),
      limit: null,
    });

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId,
      actorId: userId,
      sessionId,
      actionType: 'PICKING_QUEUE_RESYNC',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: activeStore?.id ?? tenantId,
      storeId: activeStore?.id ?? null,
      metadata: {
        syncedOrders: result.syncedOrders,
        scopedStoreId: activeStore?.id ?? null,
        scopedStoreName: activeStore ? (activeStore.shopName || activeStore.name) : null,
        storeCount: activeStore ? 1 : stores.length,
      },
    });

    return {
      success: true,
      syncedOrders: result.syncedOrders,
      tenantId,
      storeId: activeStore?.id ?? null,
      storeName: activeStore ? (activeStore.shopName || activeStore.name) : null,
      storeCount: activeStore ? 1 : stores.length,
    };
  }

  async reallocatePickingTasks(user: BootstrapUser, body: WmsMobilePickReallocateDto, request?: Request) {
    const userId = user.userId || user.id || null;
    const sessionId = (this.cls.get('sessionId') as string | undefined) || user.sessionId || null;
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: body.tenantId } as GetWmsMobileStockDto,
      request,
    );
    const tenantId = tenantContext.tenantId;

    if (!userId) {
      throw new ForbiddenException('User context is required for queue reallocation');
    }

    this.assertLegacyRetirementConfiguration();

    const [access, taskAssignment] = await Promise.all([
      this.effectiveAccessService.resolveUserAccess({
        userId,
        basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
        workspace: 'wms',
      }),
      this.getWmsTaskAssignment(userId),
    ]);
    const pickQueueAccess = this.resolvePickQueueAccess(user, access.permissions, taskAssignment);

    if (!pickQueueAccess.canViewAll) {
      throw new ForbiddenException('Only pick supervisors can reallocate the full pick queue');
    }

    if (user.role === 'SUPER_ADMIN' && !tenantId) {
      throw new BadRequestException('Select a partner before reallocating the pick queue');
    }

    const stores = await this.prisma.posStore.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        status: IntegrationStatus.ACTIVE,
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        shopName: true,
      },
      orderBy: [{ name: 'asc' }],
    });

    const activeStore = body.storeId
      ? stores.find((store) => store.id === body.storeId) ?? null
      : null;

    if (body.storeId && !activeStore) {
      throw new ForbiddenException('Selected store is not available for WMS fulfillment reallocation');
    }

    const result = await this.wmsFulfillmentSyncService.reallocateWaitingOrders({
      tenantId,
      storeId: activeStore?.id ?? null,
      actorId: userId,
      limit: null,
    });

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId,
      actorId: userId,
      sessionId,
      actionType: 'PICKING_QUEUE_REALLOCATION',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: activeStore?.id ?? tenantId,
      storeId: activeStore?.id ?? null,
      metadata: {
        checkedOrders: result.checkedOrders,
        scopedStoreId: activeStore?.id ?? null,
        scopedStoreName: activeStore ? (activeStore.shopName || activeStore.name) : null,
        storeCount: activeStore ? 1 : stores.length,
      },
    });

    return {
      success: true,
      checkedOrders: result.checkedOrders,
      tenantId,
      storeId: activeStore?.id ?? null,
      storeName: activeStore ? (activeStore.shopName || activeStore.name) : null,
      storeCount: activeStore ? 1 : stores.length,
    };
  }

  async retryPickingTaskAllocation(
    user: BootstrapUser,
    fulfillmentOrderId: string,
    body: WmsMobilePickScopedDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const sessionId = (this.cls.get('sessionId') as string | undefined) || user.sessionId || null;
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: body.tenantId } as GetWmsMobileStockDto,
      request,
    );
    const tenantId = tenantContext.tenantId;

    if (!userId) {
      throw new ForbiddenException('User context is required for allocation retry');
    }

    const [access, taskAssignment, order] = await Promise.all([
      this.effectiveAccessService.resolveUserAccess({
        userId,
        basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
        workspace: 'wms',
      }),
      this.getWmsTaskAssignment(userId),
      this.prisma.wmsFulfillmentOrder.findUnique({
        where: { id: fulfillmentOrderId },
        select: {
          id: true,
          tenantId: true,
          storeId: true,
          claimedById: true,
          assignmentMode: true,
        },
      }),
    ]);
    const pickQueueAccess = this.resolvePickQueueAccess(user, access.permissions, taskAssignment);

    if (!order) {
      throw new NotFoundException('Picking task not found');
    }

    this.assertLegacyReservedStoxAccessAllowedForOrder(order);

    if (tenantId && order.tenantId !== tenantId) {
      throw new ForbiddenException('This picking task is outside the active tenant scope');
    }

    const stores = await this.prisma.posStore.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        status: IntegrationStatus.ACTIVE,
      },
      select: {
        id: true,
      },
    });

    if (!stores.some((store) => store.id === order.storeId)) {
      throw new ForbiddenException('This picking task is outside the available store scope');
    }

    if (!pickQueueAccess.canViewAll && order.claimedById && order.claimedById !== userId) {
      throw new ForbiddenException('This task is already claimed by another picker');
    }

    await this.wmsFulfillmentSyncService.retryAllocationForFulfillmentOrder(fulfillmentOrderId, userId);

    const updatedOrder = await this.prisma.wmsFulfillmentOrder.findUniqueOrThrow({
      where: { id: fulfillmentOrderId },
      include: this.pickingTaskInclude(),
    });

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId: updatedOrder.tenantId,
      actorId: userId,
      sessionId,
      actionType: 'PICKING_ALLOCATION_RETRY',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: updatedOrder.id,
      taskType: 'PICK',
      taskId: updatedOrder.id,
      storeId: updatedOrder.storeId,
      warehouseId: updatedOrder.warehouseId,
      metadata: {
        posOrderId: updatedOrder.posOrderId,
        shopId: updatedOrder.shopId,
        status: updatedOrder.status,
        totalQuantity: updatedOrder.totalQuantity,
        allocatedQuantity: updatedOrder.allocatedQuantity,
        pickedQuantity: updatedOrder.pickedQuantity,
      },
    });

    return {
      success: true,
      task: this.mapMobilePickingTask(updatedOrder),
    };
  }

  async getPackingTasks(user: BootstrapUser, query: GetWmsMobilePackingTasksDto, request?: Request) {
    const userId = user.userId || user.id || null;
    const tenantContext = await this.resolveMobileStockContext(user, query as GetWmsMobileStockDto, request);
    const tenantId = tenantContext.tenantId;
    const sessionId = (this.cls.get('sessionId') as string | undefined) || user.sessionId || null;
    const useCompactResponse = this.wantsCompactPackingResponse(request);

    if (!userId) {
      return this.buildEmptyPackingResponse(false);
    }

    const [access, taskAssignment] = await Promise.all([
      this.effectiveAccessService.resolveUserAccess({
        userId,
        basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
        workspace: 'wms',
      }),
      this.getWmsTaskAssignment(userId),
    ]);
    const packQueueAccess = this.resolvePackQueueAccess(user, access.permissions, taskAssignment);

    const isPackSupervisor = user.role === 'SUPER_ADMIN'
      || this.hasAnyRequiredPermission(access.permissions, PACK_SUPERVISOR_PERMISSIONS);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PACKING_PAGE_SIZE;
    const skip = (page - 1) * pageSize;
    const activeStoxAssignmentWhere = this.buildActiveStoxAssignmentWhere();

    const stores = await this.prisma.posStore.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        status: IntegrationStatus.ACTIVE,
      },
      select: {
        id: true,
        tenantId: true,
        teamId: true,
        name: true,
        shopId: true,
        shopName: true,
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
      orderBy: [{ name: 'asc' }],
    });

    const activeStore = query.storeId
      ? stores.find((store) => store.id === query.storeId) ?? null
      : null;

    if (query.storeId && !activeStore) {
      throw new ForbiddenException('Selected store is not available for STOX packing');
    }

    const effectiveGoLiveTenantId = tenantId ?? activeStore?.tenantId ?? null;
    const singleTenantGoLiveAt = await this.getFulfillmentGoLiveAt(effectiveGoLiveTenantId);
    const multiTenantGoLiveFilters = effectiveGoLiveTenantId
      ? []
      : await this.buildTenantGoLiveFulfillmentOrderFilters(
          Array.from(new Set(stores.map((store) => store.tenantId))),
        );
    const goLiveAndClauses: Prisma.WmsFulfillmentOrderWhereInput[] = singleTenantGoLiveAt
      ? [this.buildFulfillmentGoLiveWhere(singleTenantGoLiveAt)]
      : multiTenantGoLiveFilters.length > 0
        ? [{ OR: multiTenantGoLiveFilters }]
        : [];
    const scopedWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      ...(tenantId ? { tenantId } : {}),
      ...(activeStore ? { storeId: activeStore.id } : {}),
      ...(goLiveAndClauses.length > 0 ? { AND: goLiveAndClauses } : {}),
    };
    const normalizedSearch = query.search?.trim() || null;
    const searchWhere: Prisma.WmsFulfillmentOrderWhereInput = normalizedSearch
      ? {
          OR: [
            { posOrderId: { contains: normalizedSearch, mode: 'insensitive' } },
            {
              store: {
                is: {
                  OR: [
                    { name: { contains: normalizedSearch, mode: 'insensitive' } },
                    { shopName: { contains: normalizedSearch, mode: 'insensitive' } },
                  ],
                },
              },
            },
            {
              posOrder: {
                is: {
                  customerName: { contains: normalizedSearch, mode: 'insensitive' },
                },
              },
            },
          ],
        }
      : {};
    const selectedPackingStatuses: WmsFulfillmentOrderStatus[] = query.status === 'PICKED'
      ? [WmsFulfillmentOrderStatus.PICKED]
      : query.status === 'PACKING'
        ? [WmsFulfillmentOrderStatus.PACKING]
      : query.status === 'PACKED'
        ? [WmsFulfillmentOrderStatus.PACKED]
        : [...PACK_QUEUE_ORDER_STATUSES];
    const trackingMissingFilter: Prisma.WmsFulfillmentOrderWhereInput = {
      OR: [
        {
          posOrder: {
            is: {
              tracking: null,
            },
          },
        },
        {
          posOrder: {
            is: {
              tracking: '',
            },
          },
        },
      ],
    };
    const activeStatuses = selectedPackingStatuses.filter(
      (status) => status !== WmsFulfillmentOrderStatus.PACKED,
    );
    const includePackedHistory = selectedPackingStatuses.includes(WmsFulfillmentOrderStatus.PACKED);

    const scopedBasketWhere: Prisma.WmsBasketWhereInput = {
      status: {
        in: [...PACK_QUEUE_BASKET_STATUSES],
      },
      ...(isPackSupervisor
        ? { assignedPackerId: { not: null } }
        : { assignedPackerId: userId }),
      fulfillmentOrders: {
        some: {
          ...scopedWhere,
          ...activeStoxAssignmentWhere,
          ...searchWhere,
          status: {
            in: activeStatuses.length > 0 ? activeStatuses : [WmsFulfillmentOrderStatus.PICKED],
          },
          ...(query.status === 'AWAITING_TRACKING' ? trackingMissingFilter : {}),
        },
      },
    };
    const taskWhereBranches: Prisma.WmsFulfillmentOrderWhereInput[] = [];

    if (activeStatuses.length > 0) {
      taskWhereBranches.push({
        ...scopedWhere,
        ...activeStoxAssignmentWhere,
        status: {
          in: activeStatuses,
        },
        ...(query.status === 'AWAITING_TRACKING' ? trackingMissingFilter : {}),
        basket: {
          is: {
            status: {
              in: [...PACK_QUEUE_BASKET_STATUSES],
            },
            ...(isPackSupervisor
              ? { assignedPackerId: { not: null } }
              : { assignedPackerId: userId }),
          },
        },
        ...searchWhere,
      });
    }

    if (includePackedHistory && query.status !== 'AWAITING_TRACKING') {
      taskWhereBranches.push({
        ...scopedWhere,
        ...activeStoxAssignmentWhere,
        status: WmsFulfillmentOrderStatus.PACKED,
        ...(isPackSupervisor
          ? { packedById: { not: null } }
          : { packedById: userId }),
        ...searchWhere,
      });
    }

    const taskWhere: Prisma.WmsFulfillmentOrderWhereInput = taskWhereBranches.length === 1
      ? taskWhereBranches[0]
      : { OR: taskWhereBranches };
    const awaitingTrackingWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      AND: [
        taskWhere,
        trackingMissingFilter,
      ],
    };

    const packedCountWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      ...scopedWhere,
      ...activeStoxAssignmentWhere,
      status: WmsFulfillmentOrderStatus.PACKED,
      ...(isPackSupervisor
        ? { packedById: { not: null } }
        : { packedById: userId }),
      ...searchWhere,
    };

    const [heldCount, packingCount, awaitingTrackingCount, packedCount] = await Promise.all([
      this.prisma.wmsBasket.count({
        where: {
          ...scopedBasketWhere,
          status: WmsBasketStatus.FULL_HELD,
        },
      }),
      this.prisma.wmsBasket.count({
        where: {
          ...scopedBasketWhere,
          status: WmsBasketStatus.PACKING,
        },
      }),
      this.prisma.wmsFulfillmentOrder.count({
        where: awaitingTrackingWhere,
      }),
      this.prisma.wmsFulfillmentOrder.count({
        where: packedCountWhere,
      }),
    ]);

    let total = 0;
    let tasks: any[] = [];

    if (includePackedHistory) {
      total = await this.prisma.wmsFulfillmentOrder.count({ where: taskWhere });
      tasks = await this.prisma.wmsFulfillmentOrder.findMany({
        where: taskWhere,
        include: useCompactResponse ? this.packingQueueTaskInclude() : this.pickingTaskInclude(),
        orderBy: [
          { updatedAt: 'desc' },
          { completedAt: 'desc' },
          { createdAt: 'desc' },
        ],
        skip,
        take: pageSize,
      });
    } else {
      const basketQueueEntries = await this.prisma.wmsBasket.findMany({
        where: scopedBasketWhere,
        select: {
          id: true,
          readyForPackAt: true,
          fullAt: true,
          claimedAt: true,
          updatedAt: true,
          createdAt: true,
        },
      });

      const orderedBasketIds = basketQueueEntries
        .map((basket) => ({
          id: basket.id,
          sortAt: this.resolvePackQueueSortTimestamp([
            basket.readyForPackAt,
            basket.fullAt,
            basket.claimedAt,
            basket.updatedAt,
            basket.createdAt,
          ]),
        }))
        .sort((left, right) => {
          if (right.sortAt !== left.sortAt) {
            return right.sortAt - left.sortAt;
          }

          return left.id.localeCompare(right.id);
        })
        .map((entry) => entry.id);

      total = orderedBasketIds.length;
      const pagedBasketIds = orderedBasketIds.slice(skip, skip + pageSize);

      if (pagedBasketIds.length > 0) {
        const basketTasks = await this.prisma.wmsFulfillmentOrder.findMany({
          where: {
            AND: [
              taskWhere,
              {
                basketId: {
                  in: pagedBasketIds,
                },
              },
            ],
          },
          include: useCompactResponse ? this.packingQueueTaskInclude() : this.pickingTaskInclude(),
          orderBy: [
            { updatedAt: 'desc' },
            { completedAt: 'desc' },
            { createdAt: 'desc' },
          ],
        });

        tasks = this.orderPackingTasksForBaskets(basketTasks, pagedBasketIds);
      }
    }

    if (!this.isBackgroundPackingRefresh(request)) {
      await this.wmsStaffActivityService.recordFromRequest({
        request,
        tenantId: tenantId ?? activeStore?.tenantId ?? null,
        actorId: userId,
        sessionId,
        actionType: 'PACKING_VIEW',
        resourceType: 'STOX_PACKING',
        resourceId: activeStore?.id ?? null,
        storeId: activeStore?.id ?? null,
        metadata: {
          page,
          pageSize,
          search: normalizedSearch,
          total,
          held: heldCount,
          packing: packingCount,
          awaitingTracking: awaitingTrackingCount,
          packed: packedCount,
        },
      });
    }

    return {
      tenantReady: true,
      ...(useCompactResponse ? {} : { serverTime: new Date().toISOString() }),
      pagination: {
        page,
        pageSize,
        total,
        hasMore: page * pageSize < total,
      },
      context: {
        tenantOptions: tenantContext.tenantOptions,
        activeTenantId: tenantId,
        activeStoreId: activeStore?.id ?? null,
        canViewAllQueue: packQueueAccess.canViewAll,
        stores: stores.map((store) => ({
          id: store.id,
          tenantId: store.tenantId,
          name: store.shopName || store.name,
          tenantName: store.tenant.name,
          tenantSlug: store.tenant.slug,
        })),
        taskAssignment,
      },
      summary: {
        held: heldCount,
        packing: packingCount,
        awaitingTracking: awaitingTrackingCount,
        packed: packedCount,
      },
      tasks: tasks.map((task) => (
        useCompactResponse
          ? this.mapMobilePackingQueueTask(task)
          : this.mapMobilePickingTask(task)
      )),
    };
  }

  async getPackingTask(
    user: BootstrapUser,
    id: string,
    query: WmsMobilePackScopedDto,
    request?: Request,
  ) {
    const task = await this.findPackingOrderForAction(user, id, query.tenantId, request);

    return {
      success: true,
      task: this.mapMobilePickingTask(task),
    };
  }

  async getHistoryFeed(
    user: BootstrapUser,
    query: GetWmsMobileHistoryFeedDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: query.tenantId },
      request,
    );
    const tenantId = tenantContext.tenantId;

    if (!userId) {
      return {
        tenantReady: false,
        items: [],
        pagination: {
          limit: query.limit ?? DEFAULT_HISTORY_PAGE_SIZE,
          nextCursor: null,
          hasMore: false,
        },
        filters: {
          canViewAll: false,
          activeActorId: null,
          activeType: query.type ?? 'ALL',
          actorOptions: [],
        },
      };
    }

    const access = await this.effectiveAccessService.resolveUserAccess({
      userId,
      basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
      workspace: 'wms',
    });

    const canViewAll = user.role === 'SUPER_ADMIN'
      || this.hasAnyRequiredPermission(access.permissions, HISTORY_READ_ALL_PERMISSIONS);
    const activeActorId = canViewAll ? query.actorId ?? null : userId;
    if (!canViewAll && query.actorId && query.actorId !== userId) {
      throw new ForbiddenException('This account can only view its own STOX history');
    }

    const limit = query.limit ?? DEFAULT_HISTORY_PAGE_SIZE;
    const cursor = this.decodeHistoryCursor(query.cursor);
    const activeType = query.type ?? 'ALL';
    const where = this.buildHistoryActivityWhere({
      tenantId,
      actorId: activeActorId,
      type: activeType,
      cursor,
    });

    const rows = await this.prisma.wmsStaffActivity.findMany({
      where,
      select: {
        id: true,
        actorId: true,
        actionType: true,
        resourceType: true,
        resourceId: true,
        storeId: true,
        warehouseId: true,
        fromStatus: true,
        toStatus: true,
        outcome: true,
        metadata: true,
        createdAt: true,
        actor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: limit + 1,
    });

    const actorOptions = canViewAll
      ? await this.prisma.user.findMany({
          where: {
            tenantId: null,
            status: UserStatus.ACTIVE,
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            employeeId: true,
          },
          orderBy: [
            { firstName: 'asc' },
            { lastName: 'asc' },
            { email: 'asc' },
          ],
        })
      : [];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? this.encodeHistoryCursor(pageRows[pageRows.length - 1].createdAt, pageRows[pageRows.length - 1].id)
      : null;

    const storeIds = [...new Set(pageRows.map((row) => row.storeId).filter((value): value is string => Boolean(value)))];
    const warehouseIds = [...new Set(pageRows.map((row) => row.warehouseId).filter((value): value is string => Boolean(value)))];

    const [stores, warehouses] = await Promise.all([
      storeIds.length > 0
        ? this.prisma.posStore.findMany({
            where: {
              id: { in: storeIds },
            },
            select: {
              id: true,
              name: true,
              shopName: true,
            },
          })
        : Promise.resolve([]),
      warehouseIds.length > 0
        ? this.prisma.wmsWarehouse.findMany({
            where: {
              id: { in: warehouseIds },
            },
            select: {
              id: true,
              code: true,
              name: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const storeMap = new Map(
      stores.map((store) => [store.id, store.shopName || store.name] as const),
    );
    const warehouseMap = new Map(
      warehouses.map((warehouse) => [
        warehouse.id,
        `${warehouse.code} · ${warehouse.name}`,
      ] as const),
    );

    return {
      tenantReady: true,
      serverTime: new Date().toISOString(),
      items: pageRows.map((row) => this.mapMobileHistoryItem(row, {
        storeMap,
        warehouseMap,
      })),
      pagination: {
        limit,
        nextCursor,
        hasMore,
      },
      filters: {
        canViewAll,
        activeActorId,
        activeType,
        actorOptions: actorOptions.map((actor) => ({
          id: actor.id,
          name: this.formatActorName(actor.firstName, actor.lastName, actor.email),
          email: actor.email,
          employeeId: actor.employeeId ?? null,
        })),
      },
    };
  }

  async getPackingBasketPlan(
    user: BootstrapUser,
    id: string,
    query: WmsMobilePackScopedDto,
    request?: Request,
  ) {
    const basket = await this.findPackingBasketForAction(user, id, query.tenantId, request);
    this.assertDemandPackingBasket(basket);

    return {
      success: true,
      basket: this.mapMobilePickBasket(basket),
      tasks: this.mapMobileBasketTasks(basket),
      plan: this.buildMobileBasketPackPlan(basket, this.resolveActiveBasketPackOrderId(basket)),
    };
  }

  async scanPackingBasketWaybill(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePackScanDto,
    request?: Request,
  ) {
    const basket = await this.findPackingBasketForAction(user, id, body.tenantId, request);
    this.assertDemandPackingBasket(basket);

    const trackingCode = this.normalizeTrackingCode(body.code);
    const matchedOrder = (basket.fulfillmentOrders ?? []).find((order: any) => {
      const tracking = this.cleanOptionalText(order.posOrder?.tracking ?? null);
      return tracking ? this.normalizeTrackingCode(tracking) === trackingCode : false;
    });

    if (!matchedOrder) {
      const missingTrackingOrder = (basket.fulfillmentOrders ?? []).find((order: any) => !this.cleanOptionalText(order.posOrder?.tracking ?? null));
      if (missingTrackingOrder && (basket.fulfillmentOrders?.length ?? 0) === 1) {
        throw new BadRequestException(`Order ${missingTrackingOrder.posOrderId} is still waiting for its tracking number`);
      }

      throw new BadRequestException(`Tracking code ${trackingCode} was not found in basket ${basket.barcode}`);
    }

    this.assertOrderHasTracking(matchedOrder);

    const userId = (user.userId || user.id) ?? null;
    const now = new Date();
    const updatedBasket = await this.prisma.$transaction(async (tx) => {
      const scopedBasket = await tx.wmsBasket.findUnique({
        where: { id: basket.id },
        include: this.mobileBasketInclude(),
      });

      if (!scopedBasket) {
        throw new NotFoundException('Pack basket was not found');
      }

      this.assertDemandPackingBasket(scopedBasket);
      await this.lockBasketForUpdate(tx, scopedBasket.id);

      const scopedOrder = (scopedBasket.fulfillmentOrders ?? []).find((order: any) => order.id === matchedOrder.id);
      if (!scopedOrder) {
        throw new NotFoundException('Pack task was not found in this basket');
      }

      this.assertPackOrderNotCanceledInPos(scopedOrder);
      this.assertOrderHasTracking(scopedOrder);
      this.assertNoOtherDemandPackOrderInProgress(scopedBasket, scopedOrder.id);

      if (
        scopedOrder.status !== WmsFulfillmentOrderStatus.PICKED
        && scopedOrder.status !== WmsFulfillmentOrderStatus.PACKING
      ) {
        throw new BadRequestException(`Order ${scopedOrder.posOrderId} is ${this.formatEnumLabel(scopedOrder.status)} and cannot be packed`);
      }

      if (scopedOrder.status !== WmsFulfillmentOrderStatus.PACKING) {
        await tx.wmsFulfillmentOrder.update({
          where: { id: scopedOrder.id },
          data: {
            status: WmsFulfillmentOrderStatus.PACKING,
          },
        });
      }

      await this.refreshBasketState(tx, scopedBasket.id, now);

      return tx.wmsBasket.findUniqueOrThrow({
        where: { id: scopedBasket.id },
        include: this.mobileBasketInclude(),
      });
    });

    const updatedOrder = (updatedBasket.fulfillmentOrders ?? []).find((order: any) => order.id === matchedOrder.id) ?? null;
    const activeOrderId = this.resolveActiveBasketPackOrderId(
      updatedBasket,
      updatedOrder?.id ?? matchedOrder.id,
    );

    await this.recordStockActivity(user, request, {
      tenantId: updatedOrder?.tenantId ?? basket.tenantId ?? null,
      actionType: 'PACKING_TRACKING_VERIFY',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: updatedOrder?.id ?? matchedOrder.id,
      storeId: updatedOrder?.storeId ?? matchedOrder.storeId ?? null,
      warehouseId: updatedOrder?.warehouseId ?? matchedOrder.warehouseId ?? null,
      metadata: {
        fulfillmentOrderId: updatedOrder?.id ?? matchedOrder.id,
        posOrderId: updatedOrder?.posOrderId ?? matchedOrder.posOrderId,
        basketCode: updatedBasket.barcode,
        trackingCode,
        mode: 'BASKET_DEMAND',
      },
    });

    return {
      success: true,
      tracking: trackingCode,
      activeOrderId: activeOrderId ?? matchedOrder.id,
      activeOrder: updatedOrder ? this.mapMobilePickingTask(updatedOrder) : this.mapMobilePickingTask(matchedOrder),
      basket: this.mapMobilePickBasket(updatedBasket),
      tasks: this.mapMobileBasketTasks(updatedBasket),
      plan: this.buildMobileBasketPackPlan(updatedBasket, activeOrderId ?? matchedOrder.id),
    };
  }

  async scanPackingBasketOrderUnit(
    user: BootstrapUser,
    basketId: string,
    orderId: string,
    body: WmsMobilePackScanDto,
    request?: Request,
  ) {
    if (this.wantsPackingUnitScanDeltaResponse(request)) {
      return this.scanPackingBasketOrderUnitDelta(user, basketId, orderId, body, request);
    }

    const basket = await this.findPackingBasketForAction(user, basketId, body.tenantId, request);
    this.assertDemandPackingBasket(basket);

    const selectedOrder = (basket.fulfillmentOrders ?? []).find((order: any) => order.id === orderId);
    if (!selectedOrder) {
      throw new NotFoundException('Pack task was not found in this basket');
    }

    this.assertPackingTaskInProgress(selectedOrder);
    this.assertOrderHasTracking(selectedOrder);

    const scannedCode = this.normalizeScannedCode(body.code);
    const scannedUnit = await this.findUnitByCode(scannedCode, selectedOrder.tenantId);
    if (!scannedUnit) {
      throw new NotFoundException('Scanned unit was not found');
    }

    const userId = (user.userId || user.id) ?? null;
    const now = new Date();
    const transactionResult = await this.prisma.$transaction(async (tx) => {
      const scopedBasket = await tx.wmsBasket.findUnique({
        where: { id: basket.id },
        include: this.mobileBasketInclude(),
      });

      if (!scopedBasket) {
        throw new NotFoundException('Pack basket was not found');
      }

      this.assertDemandPackingBasket(scopedBasket);
      await this.lockBasketForUpdate(tx, scopedBasket.id);

      const scopedOrder = (scopedBasket.fulfillmentOrders ?? []).find((order: any) => order.id === orderId);
      if (!scopedOrder) {
        throw new NotFoundException('Pack task was not found in this basket');
      }

      this.assertPackOrderNotCanceledInPos(scopedOrder);
      this.assertPackingTaskInProgress(scopedOrder);
      this.assertOrderHasTracking(scopedOrder);

      const basketUnit = (scopedBasket.basketUnits ?? []).find((candidate: any) => (
        candidate.inventoryUnitId === scannedUnit.id
        || candidate.inventoryUnit?.code === scannedCode
        || candidate.inventoryUnit?.barcode === scannedCode
      ));

      if (!basketUnit) {
        throw new BadRequestException(`Unit ${scannedUnit.code} is not in basket ${scopedBasket.barcode}`);
      }

      const packableLines = (scopedOrder.lines ?? []).filter((line: any) => (
        line.status !== WmsFulfillmentLineStatus.CANCELED
        && Math.max(line.quantityRequired ?? 0, 0) > 0
      ));
      let poolIndex = EMPTY_STOCK_POOL_INDEX;
      let matchingLine = packableLines.find((line: any) => line.variationId === basketUnit.variationId);
      if (!matchingLine) {
        poolIndex = await loadTenantStockPoolIndex(tx, scopedOrder.tenantId);
        if (poolIndex.hasAnyPools) {
          matchingLine = packableLines.find((line: any) => (
            poolIndex.areStoreVariationsPooled(
              scopedOrder.storeId,
              line.variationId,
              basketUnit.storeId ?? scopedOrder.storeId,
              basketUnit.variationId,
            )
          ));
        }
      }
      if (!matchingLine) {
        throw new BadRequestException(`Unit ${scannedUnit.code} is not one of the products required by order ${scopedOrder.posOrderId}`);
      }

      const packedForLine = (scopedOrder.basketUnits ?? []).filter((candidate: any) => (
        candidate.status === WmsBasketUnitStatus.PACKED
        && candidate.fulfillmentLineId === matchingLine.id
      )).length;
      if (packedForLine >= Math.max(matchingLine.quantityRequired ?? 0, 0)) {
        throw new BadRequestException(`Order ${scopedOrder.posOrderId} already has all required ${matchingLine.productName} units packed`);
      }

      if (!poolIndex.hasAnyPools) {
        poolIndex = await loadTenantStockPoolIndex(tx, scopedOrder.tenantId);
      }
      const targetPoolMember = poolIndex.getTargetMember(scopedOrder.storeId, matchingLine.variationId);
      const isCrossVariantPack = Boolean(
        targetPoolMember
        && (
          (basketUnit.storeId ?? scopedOrder.storeId) !== targetPoolMember.storeId
          || basketUnit.variationId !== targetPoolMember.variationId
        ),
      );

      const reassignment = await this.reassignDemandPackingUnitIfNeeded(tx, {
        basketId: scopedBasket.id,
        basketCode: scopedBasket.barcode,
        basketUnit,
        targetOrderId: scopedOrder.id,
        targetOrderCode: scopedOrder.posOrderId,
        targetStoreId: scopedOrder.storeId,
        targetVariationId: matchingLine.variationId,
        unitCode: scannedUnit.code,
        actorId: userId,
        now,
        poolIndex,
      });

      if (basketUnit.status === WmsBasketUnitStatus.PACKED) {
        throw new ConflictException(`Unit ${scannedUnit.code} was already packed`);
      }

      const updateBasketUnitResult = await tx.wmsBasketUnit.updateMany({
        where: {
          id: basketUnit.id,
          status: WmsBasketUnitStatus.PICKED,
        },
        data: {
          status: WmsBasketUnitStatus.PACKED,
          fulfillmentOrderId: scopedOrder.id,
          fulfillmentLineId: matchingLine.id,
          ...(isCrossVariantPack && targetPoolMember
            ? {
                storeId: targetPoolMember.storeId,
                productId: targetPoolMember.productId,
                variationId: targetPoolMember.variationId,
              }
            : {}),
          packedById: userId ?? undefined,
          packedAt: now,
        },
      });

      if (updateBasketUnitResult.count === 0) {
        throw new ConflictException(`Unit ${scannedUnit.code} changed before it could be packed`);
      }

      const inventoryUpdateResult = await tx.wmsInventoryUnit.updateMany({
        where: {
          id: basketUnit.inventoryUnitId,
          status: WmsInventoryUnitStatus.PICKED,
        },
        data: {
          status: WmsInventoryUnitStatus.PACKED,
          ...(isCrossVariantPack && targetPoolMember
            ? {
                storeId: targetPoolMember.storeId,
                posProductId: targetPoolMember.posProductId,
                productProfileId: targetPoolMember.profileId,
                productId: targetPoolMember.productId,
                variationId: targetPoolMember.variationId,
                posWarehouseRef: (basketUnit.storeId ?? scopedOrder.storeId) === targetPoolMember.storeId
                  ? null
                  : targetPoolMember.posWarehouseRef ?? null,
              }
            : {}),
          updatedById: userId ?? undefined,
        },
      });

      if (inventoryUpdateResult.count === 0) {
        throw new ConflictException(`Unit ${scannedUnit.code} is no longer ready for packing`);
      }

      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: scopedOrder.tenantId,
          inventoryUnitId: basketUnit.inventoryUnitId,
          warehouseId: basketUnit.inventoryUnit.warehouseId,
          fromLocationId: basketUnit.inventoryUnit.currentLocationId,
          toLocationId: null,
          fromStatus: basketUnit.inventoryUnit.status,
          toStatus: WmsInventoryUnitStatus.PACKED,
          movementType: WmsInventoryMovementType.PACK,
          referenceType: 'WMS_FULFILLMENT_ORDER',
          referenceId: scopedOrder.id,
          referenceCode: scopedOrder.posOrderId,
          notes: `STOX basket ${scopedBasket.barcode} packed for order ${scopedOrder.posOrderId}`,
          actorId: userId,
          createdAt: now,
        },
      });

      const refreshedOrder = await tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: scopedOrder.id },
        include: this.pickingTaskInclude(),
      });
      const refreshedPackedCount = this.getPackedBasketUnitCount(refreshedOrder);
      const isOrderReadyToComplete = refreshedPackedCount >= Math.max(refreshedOrder.totalQuantity ?? 0, 0);

      await this.refreshBasketState(tx, scopedBasket.id, now);

      const [updatedBasket, updatedOrder] = await Promise.all([
        tx.wmsBasket.findUniqueOrThrow({
          where: { id: scopedBasket.id },
          include: this.mobileBasketInclude(),
        }),
        tx.wmsFulfillmentOrder.findUniqueOrThrow({
          where: { id: scopedOrder.id },
          include: this.pickingTaskInclude(),
        }),
      ]);

      return {
        basket: updatedBasket,
        order: updatedOrder,
        line: matchingLine,
        isOrderReadyToComplete,
        basketUnitCode: basketUnit.inventoryUnit.code,
        basketUnitId: basketUnit.id,
        inventoryUnitId: basketUnit.inventoryUnitId,
        inventoryWarehouseId: basketUnit.inventoryUnit.warehouseId,
        reassignment,
      };
    });

    await this.recordStockActivity(user, request, {
      tenantId: transactionResult.order.tenantId,
      actionType: 'PACKING_UNIT_SCAN',
      resourceType: 'WMS_INVENTORY_UNIT',
      resourceId: transactionResult.inventoryUnitId,
      storeId: transactionResult.order.storeId,
      warehouseId: transactionResult.inventoryWarehouseId,
      metadata: {
        fulfillmentOrderId: transactionResult.order.id,
        fulfillmentLineId: transactionResult.line.id,
        posOrderId: transactionResult.order.posOrderId,
        basketCode: transactionResult.basket.barcode,
        unitCode: transactionResult.basketUnitCode,
        mode: 'BASKET_DEMAND',
        reassignedFromOrderId: transactionResult.reassignment?.sourceOrderId ?? null,
        exchangedUnitId: transactionResult.reassignment?.replacementUnitId ?? null,
      },
    });

    const activeOrderId = this.resolveActiveBasketPackOrderId(
      transactionResult.basket,
      transactionResult.order.id,
    );

    return {
      success: true,
      activeOrderId,
      activeOrder: activeOrderId ? this.mapMobilePickingTask(transactionResult.order) : null,
      completedOrder: null,
      basket: this.mapMobilePickBasket(transactionResult.basket),
      tasks: this.mapMobileBasketTasks(transactionResult.basket),
      plan: this.buildMobileBasketPackPlan(transactionResult.basket, activeOrderId),
    };
  }

  private async reassignDemandPackingUnitIfNeeded(
    tx: Prisma.TransactionClient,
    params: {
      basketId: string;
      basketCode: string;
      basketUnit: {
        id: string;
        storeId?: string;
        status: WmsBasketUnitStatus;
        fulfillmentOrderId: string | null;
        fulfillmentLineId: string | null;
        variationId: string;
        productId: string;
      };
      targetOrderId: string;
      targetOrderCode: string;
      targetStoreId?: string;
      targetVariationId?: string;
      unitCode: string;
      actorId?: string | null;
      now?: Date;
      poolIndex?: TenantStockPoolIndex;
    },
  ) {
    const sourceOrderId = params.basketUnit.fulfillmentOrderId;
    if (!sourceOrderId || sourceOrderId === params.targetOrderId) {
      return null;
    }

    const poolIndex = params.poolIndex ?? EMPTY_STOCK_POOL_INDEX;
    const poolMembers = params.targetStoreId && params.targetVariationId
      ? poolIndex.getPoolMembers(params.targetStoreId, params.targetVariationId)
      : [];
    const allowedVariationIds = poolMembers.length >= 2
      ? Array.from(new Set(poolMembers.map((member) => member.variationId)))
      : [params.basketUnit.variationId];

    const sourceOrder = await tx.wmsFulfillmentOrder.findUnique({
      where: { id: sourceOrderId },
      select: {
        tenantId: true,
        storeId: true,
        posOrderId: true,
        status: true,
        lines: {
          where: {
            variationId: allowedVariationIds.length === 1
              ? allowedVariationIds[0]!
              : { in: allowedVariationIds },
            status: { not: WmsFulfillmentLineStatus.CANCELED },
            quantityRequired: { gt: 0 },
          },
          select: { id: true, variationId: true },
          take: 1,
        },
      },
    });
    const sourceOrderCode = sourceOrder?.posOrderId ?? sourceOrderId;

    if (params.basketUnit.status === WmsBasketUnitStatus.PACKED) {
      throw new ConflictException(
        `Unit ${params.unitCode} is already packed for order ${sourceOrderCode}`,
      );
    }
    if (params.basketUnit.status !== WmsBasketUnitStatus.PICKED) {
      throw new ConflictException(
        `Unit ${params.unitCode} is not available for order ${params.targetOrderCode}`,
      );
    }
    if (
      !sourceOrder
      || (
        sourceOrder.status !== WmsFulfillmentOrderStatus.PICKED
        && sourceOrder.status !== WmsFulfillmentOrderStatus.PACKING
      )
    ) {
      throw new ConflictException(
        `Unit ${params.unitCode} belongs to completed or unavailable order ${sourceOrderCode}`,
      );
    }

    const sourceLine = sourceOrder.lines[0] ?? null;
    const sourceLineId = params.basketUnit.fulfillmentLineId ?? sourceLine?.id ?? null;
    if (!sourceLineId) {
      throw new ConflictException(
        `Unit ${params.unitCode} has no valid order line in basket ${params.basketCode}`,
      );
    }

    const replacementWhere: Prisma.WmsBasketUnitWhereInput = poolMembers.length >= 2
      ? {
          basketId: params.basketId,
          id: { not: params.basketUnit.id },
          status: WmsBasketUnitStatus.PICKED,
          OR: poolMembers.map((member) => ({
            storeId: member.storeId,
            variationId: member.variationId,
          })),
          inventoryUnit: {
            is: { status: WmsInventoryUnitStatus.PICKED },
          },
        }
      : {
          basketId: params.basketId,
          id: { not: params.basketUnit.id },
          status: WmsBasketUnitStatus.PICKED,
          variationId: params.basketUnit.variationId,
          productId: params.basketUnit.productId,
          inventoryUnit: {
            is: { status: WmsInventoryUnitStatus.PICKED },
          },
        };
    const replacementSelect = {
      id: true,
      storeId: true,
      variationId: true,
      inventoryUnitId: true,
      fulfillmentOrderId: true,
    } satisfies Prisma.WmsBasketUnitSelect;
    let replacementUnit = await tx.wmsBasketUnit.findFirst({
      where: {
        ...replacementWhere,
        fulfillmentOrderId: params.targetOrderId,
      },
      select: replacementSelect,
      orderBy: [{ pickedAt: 'asc' }, { createdAt: 'asc' }],
    });
    replacementUnit ??= await tx.wmsBasketUnit.findFirst({
      where: {
        ...replacementWhere,
        fulfillmentOrderId: null,
      },
      select: replacementSelect,
      orderBy: [{ pickedAt: 'asc' }, { createdAt: 'asc' }],
    });

    if (!replacementUnit) {
      throw new ConflictException(
        `Unit ${params.unitCode} is allocated to order ${sourceOrderCode}. Scan a matching unpacked serial allocated to order ${params.targetOrderCode}.`,
      );
    }

    const sourceVariationId = sourceLine?.variationId ?? params.basketUnit.variationId;
    const sourcePoolMember = sourceOrder.storeId
      ? poolIndex.getTargetMember(sourceOrder.storeId, sourceVariationId)
      : null;
    const replacementCrossVariant = Boolean(
      sourcePoolMember
      && replacementUnit.inventoryUnitId
      && (
        replacementUnit.storeId !== sourcePoolMember.storeId
        || replacementUnit.variationId !== sourcePoolMember.variationId
      ),
    );

    const exchangeResult = await tx.wmsBasketUnit.updateMany({
      where: {
        id: replacementUnit.id,
        status: WmsBasketUnitStatus.PICKED,
        fulfillmentOrderId: replacementUnit.fulfillmentOrderId,
      },
      data: {
        fulfillmentOrderId: sourceOrderId,
        fulfillmentLineId: sourceLineId,
        ...(replacementCrossVariant && sourcePoolMember
          ? {
              storeId: sourcePoolMember.storeId,
              productId: sourcePoolMember.productId,
              variationId: sourcePoolMember.variationId,
            }
          : {}),
      },
    });
    if (exchangeResult.count !== 1) {
      throw new ConflictException(
        `Basket ${params.basketCode} changed while assigning ${params.unitCode}. Scan the unit again.`,
      );
    }

    if (replacementCrossVariant && sourcePoolMember && replacementUnit.inventoryUnitId) {
      await tx.wmsInventoryUnit.updateMany({
        where: {
          id: replacementUnit.inventoryUnitId,
          status: WmsInventoryUnitStatus.PICKED,
        },
        data: {
          storeId: sourcePoolMember.storeId,
          posProductId: sourcePoolMember.posProductId,
          productProfileId: sourcePoolMember.profileId,
          productId: sourcePoolMember.productId,
          variationId: sourcePoolMember.variationId,
          posWarehouseRef: replacementUnit.storeId === sourcePoolMember.storeId
            ? null
            : sourcePoolMember.posWarehouseRef ?? null,
          updatedById: params.actorId ?? undefined,
        },
      });
    }

    return {
      sourceOrderId,
      replacementUnitId: replacementUnit.id,
    };
  }

  private async scanPackingBasketOrderUnitDelta(
    user: BootstrapUser,
    basketId: string,
    orderId: string,
    body: WmsMobilePackScanDto,
    request?: Request,
  ) {
    const startedAt = Date.now();
    const basket = await this.findPackingBasketForUnitScanAction(
      user,
      basketId,
      body.tenantId,
      request,
    );
    const scannedCode = this.normalizeScannedCode(body.code);
    const userId = (user.userId || user.id) ?? null;
    const now = new Date();

    const transactionResult = await this.prisma.$transaction(async (tx) => {
      await this.lockBasketForUpdate(tx, basket.id);

      const scopedBasket = await tx.wmsBasket.findUnique({
        where: { id: basket.id },
        select: {
          id: true,
          tenantId: true,
          barcode: true,
          status: true,
          assignedPackerId: true,
        },
      });
      if (!scopedBasket) {
        throw new NotFoundException('Pack basket was not found');
      }
      if (scopedBasket.status !== WmsBasketStatus.PACKING) {
        throw new BadRequestException(`Basket ${scopedBasket.barcode} is not in packing state`);
      }

      const scopedOrder = await tx.wmsFulfillmentOrder.findFirst({
        where: {
          id: orderId,
          basketId: scopedBasket.id,
          assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
        },
        select: {
          id: true,
          tenantId: true,
          storeId: true,
          warehouseId: true,
          posOrderId: true,
          status: true,
          assignmentMode: true,
          totalQuantity: true,
          changeState: true,
          changeDetectedAt: true,
          changeSummary: true,
          posOrder: {
            select: {
              tracking: true,
              status: true,
              isVoid: true,
              orderSnapshot: true,
            },
          },
          lines: {
            select: {
              id: true,
              variationId: true,
              productId: true,
              productName: true,
              productDisplayId: true,
              sourceQuantityRequired: true,
              quantityRequired: true,
              status: true,
              lineSnapshot: true,
            },
          },
        },
      });
      if (!scopedOrder) {
        throw new NotFoundException('Pack task was not found in this basket');
      }

      const scopedOrderWithBasket = { ...scopedOrder, basket: scopedBasket };
      this.assertPackOrderNotCanceledInPos(scopedOrderWithBasket);
      this.assertPackingTaskInProgress(scopedOrderWithBasket);
      this.assertOrderHasTracking(scopedOrderWithBasket);

      const scannedUnit = await tx.wmsInventoryUnit.findFirst({
        where: {
          tenantId: scopedOrder.tenantId,
          OR: [
            { code: scannedCode },
            { barcode: scannedCode },
            ...(this.isUuid(scannedCode) ? [{ id: scannedCode }] : []),
          ],
        },
        select: {
          id: true,
          code: true,
          barcode: true,
          status: true,
          variationId: true,
          warehouseId: true,
          currentLocationId: true,
        },
      });
      if (!scannedUnit) {
        throw new NotFoundException('Scanned unit was not found');
      }

      const basketUnit = await tx.wmsBasketUnit.findFirst({
        where: {
          basketId: scopedBasket.id,
          inventoryUnitId: scannedUnit.id,
          status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] },
        },
        select: {
          id: true,
          storeId: true,
          inventoryUnitId: true,
          variationId: true,
          productId: true,
          status: true,
          fulfillmentOrderId: true,
          fulfillmentLineId: true,
        },
      });
      if (!basketUnit) {
        throw new BadRequestException(`Unit ${scannedUnit.code} is not in basket ${scopedBasket.barcode}`);
      }

      const packableLines = scopedOrder.lines.filter((line) => (
        line.status !== WmsFulfillmentLineStatus.CANCELED
        && Math.max(line.quantityRequired, 0) > 0
      ));
      let poolIndex = EMPTY_STOCK_POOL_INDEX;
      let matchingLine = packableLines.find((line) => (
        line.id === basketUnit.fulfillmentLineId
        || line.variationId === basketUnit.variationId
      ));
      if (!matchingLine) {
        poolIndex = await loadTenantStockPoolIndex(tx, scopedOrder.tenantId);
        if (poolIndex.hasAnyPools) {
          matchingLine = packableLines.find((line) => (
            poolIndex.areStoreVariationsPooled(
              scopedOrder.storeId,
              line.variationId,
              basketUnit.storeId ?? scopedOrder.storeId,
              basketUnit.variationId,
            )
          ));
        }
      }
      if (!matchingLine) {
        throw new BadRequestException(`Unit ${scannedUnit.code} is not one of the products required by order ${scopedOrder.posOrderId}`);
      }

      if (
        basketUnit.status === WmsBasketUnitStatus.PACKED
        && basketUnit.fulfillmentOrderId !== scopedOrder.id
      ) {
        const packedOrder = basketUnit.fulfillmentOrderId
          ? await tx.wmsFulfillmentOrder.findUnique({
              where: { id: basketUnit.fulfillmentOrderId },
              select: { posOrderId: true },
            })
          : null;
        throw new ConflictException(
          `Unit ${scannedUnit.code} is already packed for order ${packedOrder?.posOrderId ?? basketUnit.fulfillmentOrderId ?? 'another order'}`,
        );
      }

      if (!poolIndex.hasAnyPools) {
        poolIndex = await loadTenantStockPoolIndex(tx, scopedOrder.tenantId);
      }
      const targetPoolMember = poolIndex.getTargetMember(scopedOrder.storeId, matchingLine.variationId);
      const isCrossVariantPack = Boolean(
        targetPoolMember
        && (
          (basketUnit.storeId ?? scopedOrder.storeId) !== targetPoolMember.storeId
          || basketUnit.variationId !== targetPoolMember.variationId
        ),
      );

      let alreadyProcessed = basketUnit.status === WmsBasketUnitStatus.PACKED;
      let reassignment = alreadyProcessed
        ? null
        : await this.reassignDemandPackingUnitIfNeeded(tx, {
            basketId: scopedBasket.id,
            basketCode: scopedBasket.barcode,
            basketUnit,
            targetOrderId: scopedOrder.id,
            targetOrderCode: scopedOrder.posOrderId,
            targetStoreId: scopedOrder.storeId,
            targetVariationId: matchingLine.variationId,
            unitCode: scannedUnit.code,
            actorId: userId,
            now,
            poolIndex,
          });
      if (!alreadyProcessed) {
        const packedForLine = await tx.wmsBasketUnit.count({
          where: {
            fulfillmentLineId: matchingLine.id,
            status: WmsBasketUnitStatus.PACKED,
          },
        });
        if (packedForLine >= Math.max(matchingLine.quantityRequired, 0)) {
          throw new BadRequestException(`Order ${scopedOrder.posOrderId} already has all required ${matchingLine.productName} units packed`);
        }

        const updateBasketUnitResult = await tx.wmsBasketUnit.updateMany({
          where: {
            id: basketUnit.id,
            status: WmsBasketUnitStatus.PICKED,
          },
          data: {
            status: WmsBasketUnitStatus.PACKED,
            fulfillmentOrderId: scopedOrder.id,
            fulfillmentLineId: matchingLine.id,
            ...(isCrossVariantPack && targetPoolMember
              ? {
                  storeId: targetPoolMember.storeId,
                  productId: targetPoolMember.productId,
                  variationId: targetPoolMember.variationId,
                }
              : {}),
            packedById: userId ?? undefined,
            packedAt: now,
          },
        });

        if (updateBasketUnitResult.count === 0) {
          const concurrentUnit = await tx.wmsBasketUnit.findUnique({
            where: { id: basketUnit.id },
            select: { status: true, fulfillmentOrderId: true, fulfillmentLineId: true },
          });
          alreadyProcessed = concurrentUnit?.status === WmsBasketUnitStatus.PACKED
            && concurrentUnit.fulfillmentOrderId === scopedOrder.id
            && concurrentUnit.fulfillmentLineId === matchingLine.id;
          if (!alreadyProcessed) {
            throw new ConflictException(`Unit ${scannedUnit.code} changed before it could be packed`);
          }
        }

        if (!alreadyProcessed) {
          const inventoryUpdateResult = await tx.wmsInventoryUnit.updateMany({
            where: {
              id: scannedUnit.id,
              status: WmsInventoryUnitStatus.PICKED,
            },
            data: {
              status: WmsInventoryUnitStatus.PACKED,
              ...(isCrossVariantPack && targetPoolMember
                ? {
                    storeId: targetPoolMember.storeId,
                    posProductId: targetPoolMember.posProductId,
                    productProfileId: targetPoolMember.profileId,
                    productId: targetPoolMember.productId,
                    variationId: targetPoolMember.variationId,
                    posWarehouseRef: (basketUnit.storeId ?? scopedOrder.storeId) === targetPoolMember.storeId
                      ? null
                      : targetPoolMember.posWarehouseRef ?? null,
                  }
                : {}),
              updatedById: userId ?? undefined,
            },
          });
          if (inventoryUpdateResult.count === 0) {
            throw new ConflictException(`Unit ${scannedUnit.code} is no longer ready for packing`);
          }

          await tx.wmsInventoryMovement.create({
            data: {
              tenantId: scopedOrder.tenantId,
              inventoryUnitId: scannedUnit.id,
              warehouseId: scannedUnit.warehouseId,
              fromLocationId: scannedUnit.currentLocationId,
              toLocationId: null,
              fromStatus: scannedUnit.status,
              toStatus: WmsInventoryUnitStatus.PACKED,
              movementType: WmsInventoryMovementType.PACK,
              referenceType: 'WMS_FULFILLMENT_ORDER',
              referenceId: scopedOrder.id,
              referenceCode: scopedOrder.posOrderId,
              notes: `STOX basket ${scopedBasket.barcode} packed for order ${scopedOrder.posOrderId}`,
              actorId: userId,
              createdAt: now,
            },
          });
        }
      }

      const [orderPacked, linePacked, basketPacked, basketRequiredAggregate, availableVariationUnits] = await Promise.all([
        tx.wmsBasketUnit.count({
          where: { fulfillmentOrderId: scopedOrder.id, status: WmsBasketUnitStatus.PACKED },
        }),
        tx.wmsBasketUnit.count({
          where: { fulfillmentLineId: matchingLine.id, status: WmsBasketUnitStatus.PACKED },
        }),
        tx.wmsBasketUnit.count({
          where: {
            basketId: scopedBasket.id,
            status: WmsBasketUnitStatus.PACKED,
            fulfillmentOrder: {
              is: { status: { in: [...ACTIVE_BASKET_ORDER_STATUSES] } },
            },
          },
        }),
        tx.wmsFulfillmentOrder.aggregate({
          where: {
            basketId: scopedBasket.id,
            status: { in: [...ACTIVE_BASKET_ORDER_STATUSES] },
          },
          _sum: { totalQuantity: true },
        }),
        tx.wmsBasketUnit.count({
          where: (() => {
            const linePoolMembers = poolIndex.getPoolMembers(scopedOrder.storeId, matchingLine.variationId);
            if (linePoolMembers.length >= 2) {
              return {
                basketId: scopedBasket.id,
                fulfillmentOrderId: null,
                status: WmsBasketUnitStatus.PICKED,
                OR: linePoolMembers.map((member) => ({
                  storeId: member.storeId,
                  variationId: member.variationId,
                })),
              };
            }
            return {
              basketId: scopedBasket.id,
              variationId: matchingLine.variationId,
              productId: matchingLine.productId ?? undefined,
              fulfillmentOrderId: null,
              status: WmsBasketUnitStatus.PICKED,
            };
          })(),
        }),
      ]);
      const orderRequired = Math.max(scopedOrder.totalQuantity, 0);
      const lineRequired = Math.max(matchingLine.quantityRequired, 0);
      const basketRequired = Math.max(basketRequiredAggregate._sum.totalQuantity ?? 0, 0);

      return {
        alreadyProcessed,
        reassignment: alreadyProcessed ? null : reassignment,
        basket: scopedBasket,
        order: scopedOrder,
        line: matchingLine,
        inventoryUnit: scannedUnit,
        counters: {
          basket: {
            required: basketRequired,
            packed: Math.min(basketPacked, basketRequired),
            remaining: Math.max(basketRequired - basketPacked, 0),
          },
          order: {
            required: orderRequired,
            packed: Math.min(orderPacked, orderRequired),
            remaining: Math.max(orderRequired - orderPacked, 0),
            status: scopedOrder.status,
          },
          line: {
            required: lineRequired,
            packed: Math.min(linePacked, lineRequired),
            remaining: Math.max(lineRequired - linePacked, 0),
            status: matchingLine.status,
          },
          availableVariationUnits,
        },
      };
    }, { timeout: 10_000 });

    if (!transactionResult.alreadyProcessed) {
      try {
        await this.recordStockActivity(user, request, {
          tenantId: transactionResult.order.tenantId,
          actionType: 'PACKING_UNIT_SCAN',
          resourceType: 'WMS_INVENTORY_UNIT',
          resourceId: transactionResult.inventoryUnit.id,
          storeId: transactionResult.order.storeId,
          warehouseId: transactionResult.inventoryUnit.warehouseId,
          metadata: {
            fulfillmentOrderId: transactionResult.order.id,
            fulfillmentLineId: transactionResult.line.id,
            posOrderId: transactionResult.order.posOrderId,
            basketCode: transactionResult.basket.barcode,
            unitCode: transactionResult.inventoryUnit.code,
            mode: 'BASKET_DEMAND',
            responseMode: 'scan-delta-v1',
            reassignedFromOrderId: transactionResult.reassignment?.sourceOrderId ?? null,
            exchangedUnitId: transactionResult.reassignment?.replacementUnitId ?? null,
          },
        });
      } catch (error) {
        this.logger.warn(
          `Packing scan audit failed after commit for basket ${basketId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const response = {
      success: true,
      responseMode: 'scan-delta-v1' as const,
      alreadyProcessed: transactionResult.alreadyProcessed,
      requiresRefresh: false,
      basketId: transactionResult.basket.id,
      basketStatus: transactionResult.basket.status,
      activeOrderId: transactionResult.order.id,
      orderId: transactionResult.order.id,
      lineId: transactionResult.line.id,
      packedUnit: {
        id: transactionResult.inventoryUnit.id,
        code: transactionResult.inventoryUnit.code,
        barcode: transactionResult.inventoryUnit.barcode,
        variationId: transactionResult.inventoryUnit.variationId,
      },
      counters: transactionResult.counters,
      orderReadyToComplete: transactionResult.counters.order.remaining === 0,
    };
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 1_000) {
      this.logger.warn(
        `Slow STOX packing unit scan basket=${basketId} order=${orderId} durationMs=${elapsedMs}`,
      );
    }

    return response;
  }

  async completePackingBasketOrder(
    user: BootstrapUser,
    basketId: string,
    orderId: string,
    body: WmsMobilePackBasketOrderCompleteDto,
    request?: Request,
    options: { requirePackingProof?: boolean } = {},
  ) {
    const basket = await this.findPackingBasketForAction(user, basketId, body.tenantId, request);
    this.assertDemandPackingBasket(basket);

    const selectedOrder = (basket.fulfillmentOrders ?? []).find((order: any) => order.id === orderId);
    if (!selectedOrder) {
      throw new NotFoundException('Pack task was not found in this basket');
    }

    this.assertPackingTaskInProgress(selectedOrder);
    const trackingCode = this.assertOrderHasTracking(selectedOrder);

    const packedCount = this.getPackedBasketUnitCount(selectedOrder);
    if (packedCount < Math.max(selectedOrder.totalQuantity ?? 0, 0)) {
      throw new BadRequestException(`Order ${selectedOrder.posOrderId} still has units to verify for packing`);
    }

    const now = new Date();
    const transactionResult = await this.prisma.$transaction(async (tx) => {
      const scopedBasket = await tx.wmsBasket.findUnique({
        where: { id: basket.id },
        include: this.mobileBasketInclude(),
      });

      if (!scopedBasket) {
        throw new NotFoundException('Pack basket was not found');
      }

      this.assertDemandPackingBasket(scopedBasket);
      await this.lockBasketForUpdate(tx, scopedBasket.id);

      const scopedOrder = (scopedBasket.fulfillmentOrders ?? []).find((order: any) => order.id === orderId);
      if (!scopedOrder) {
        throw new NotFoundException('Pack task was not found in this basket');
      }

      this.assertPackOrderNotCanceledInPos(scopedOrder);
      this.assertPackingTaskInProgress(scopedOrder);
      this.assertOrderHasTracking(scopedOrder);

      const scopedPackedCount = this.getPackedBasketUnitCount(scopedOrder);
      if (scopedPackedCount < Math.max(scopedOrder.totalQuantity ?? 0, 0)) {
        throw new BadRequestException(`Order ${scopedOrder.posOrderId} still has units to verify for packing`);
      }

      if (options.requirePackingProof ?? this.isStoxPackingProofRequired()) {
        await this.assertPackingProofExists(tx, scopedOrder.id, scopedOrder.posOrderId);
      }

      await tx.wmsFulfillmentOrder.update({
        where: { id: scopedOrder.id },
        data: {
          status: WmsFulfillmentOrderStatus.PACKED,
          packedById: (user.userId || user.id) ?? null,
          completedAt: now,
          basketId: null,
        },
      });

      await this.releaseCompletedDemandPackUnitsTx(
        tx,
        scopedOrder.id,
        user.userId || user.id || null,
        now,
      );

      await this.refreshBasketState(tx, scopedBasket.id, now);

      const [updatedBasket, updatedOrder] = await Promise.all([
        tx.wmsBasket.findUniqueOrThrow({
          where: { id: scopedBasket.id },
          include: this.mobileBasketInclude(),
        }),
        tx.wmsFulfillmentOrder.findUniqueOrThrow({
          where: { id: scopedOrder.id },
          include: this.pickingTaskInclude(),
        }),
      ]);

      return {
        basket: updatedBasket,
        order: updatedOrder,
      };
    });

    try {
      await this.recordStockActivity(user, request, {
        tenantId: transactionResult.order.tenantId,
        actionType: 'PACKING_COMPLETE',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: transactionResult.order.id,
        storeId: transactionResult.order.storeId,
        warehouseId: transactionResult.order.warehouseId,
        metadata: {
          fulfillmentOrderId: transactionResult.order.id,
          posOrderId: transactionResult.order.posOrderId,
          basketCode: transactionResult.basket.barcode,
          trackingCode: this.normalizeTrackingCode(trackingCode),
          mode: 'BASKET_DEMAND',
        },
      });
    } catch (error) {
      this.logger.warn(
        `Packing completed for ${transactionResult.order.id}, but its activity record failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await this.enqueuePackingPostCompleteSync({
      fulfillmentOrderId: transactionResult.order.id,
      tenantId: transactionResult.order.tenantId,
      storeId: transactionResult.order.storeId,
      shopId: transactionResult.order.shopId,
      posOrderId: transactionResult.order.posOrderId,
      requestedAt: new Date().toISOString(),
    });

    const activeOrderId = this.resolveActiveBasketPackOrderId(transactionResult.basket);
    const activeOrder = activeOrderId
      ? (transactionResult.basket.fulfillmentOrders ?? []).find((order: any) => order.id === activeOrderId) ?? null
      : null;

    if (this.wantsPackingDeltaResponse(request)) {
      return {
        success: true,
        responseMode: 'delta-v1' as const,
        basketId: transactionResult.basket.id,
        basketStatus: transactionResult.basket.status,
        completedOrderId: transactionResult.order.id,
        activeOrderId,
        plan: this.buildMobileBasketPackPlan(transactionResult.basket, activeOrderId),
      };
    }

    return {
      success: true,
      activeOrderId,
      activeOrder: activeOrder ? this.mapMobilePickingTask(activeOrder) : null,
      completedOrder: this.mapMobilePickingTask(transactionResult.order),
      basket: this.mapMobilePickBasket(transactionResult.basket),
      tasks: this.mapMobileBasketTasks(transactionResult.basket),
      plan: this.buildMobileBasketPackPlan(transactionResult.basket, activeOrderId),
    };
  }

  async voidPackingBasketOrders(
    user: BootstrapUser,
    basketId: string,
    body: WmsMobilePackBasketVoidDto,
    request?: Request,
  ) {
    const basket = await this.findPackingBasketForAction(user, basketId, body.tenantId, request);
    this.assertDemandPackingBasket(basket);

    const selectedOrderIdSet = new Set(body.orderIds);
    const selectedOrders = (basket.fulfillmentOrders ?? []).filter((order: any) => selectedOrderIdSet.has(order.id));
    if (selectedOrders.length !== selectedOrderIdSet.size) {
      throw new BadRequestException('One or more selected pack orders are no longer inside this basket');
    }

    const result = await this.performDemandPackingBasketVoid(
      user,
      basket,
      selectedOrders,
      body,
      request,
    );

    const activeOrderId = this.resolveActiveBasketPackOrderId(result.updatedBasket);
    const activeOrder = activeOrderId
      ? (result.updatedBasket.fulfillmentOrders ?? []).find((order: any) => order.id === activeOrderId) ?? null
      : null;

    return {
      success: true,
      voidedOrderIds: result.releaseResult.voidedOrderIds,
      activeOrderId,
      activeOrder: activeOrder ? this.mapMobilePickingTask(activeOrder) : null,
      basket: this.mapMobilePickBasket(result.updatedBasket),
      tasks: this.mapMobileBasketTasks(result.updatedBasket),
      plan: this.buildMobileBasketPackPlan(result.updatedBasket, activeOrderId),
    };
  }

  async startPackingTask(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePackScopedDto,
    request?: Request,
  ) {
    const order = await this.findPackingOrderForAction(user, id, body.tenantId, request);
    this.assertPackingTaskReadyToStart(order);
    this.assertOrderHasTracking(order);

    const now = new Date();
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      const scopedOrder = await tx.wmsFulfillmentOrder.findUnique({
        where: { id: order.id },
        include: this.pickingTaskInclude(),
      });

      if (!scopedOrder) {
        throw new NotFoundException('Pack task was not found');
      }

      this.assertPackingTaskReadyToStart(scopedOrder);
      this.assertOrderHasTracking(scopedOrder);

      if (!scopedOrder.basket) {
        throw new BadRequestException(`Order ${scopedOrder.posOrderId} has no basket assigned for packing`);
      }

      await tx.wmsBasket.update({
        where: { id: scopedOrder.basket.id },
        data: {
          status: WmsBasketStatus.PACKING,
        },
      });

      await tx.wmsFulfillmentOrder.update({
        where: { id: scopedOrder.id },
        data: {
          status: WmsFulfillmentOrderStatus.PACKING,
        },
      });

      return tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: scopedOrder.id },
        include: this.pickingTaskInclude(),
      });
    });

    await this.recordStockActivity(user, request, {
      tenantId: updatedOrder.tenantId,
      actionType: 'PACKING_START',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: updatedOrder.id,
      storeId: updatedOrder.storeId,
      warehouseId: updatedOrder.warehouseId,
      metadata: {
        fulfillmentOrderId: updatedOrder.id,
        posOrderId: updatedOrder.posOrderId,
        basketCode: updatedOrder.basket?.barcode ?? null,
      },
    });

    return {
      success: true,
      task: this.mapMobilePickingTask(updatedOrder),
    };
  }

  async scanPackingUnit(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePackScanDto,
    request?: Request,
  ) {
    const order = await this.findPackingOrderForAction(user, id, body.tenantId, request);
    this.assertPackingTaskInProgress(order);

    const scannedCode = this.normalizeScannedCode(body.code);
    const reservations = this.getAllPickReservations(order);
    const matchingReservation = reservations.find((reservation: any) => (
      reservation.inventoryUnit.code === scannedCode
      || reservation.inventoryUnit.barcode === scannedCode
      || reservation.inventoryUnit.id === scannedCode
    ));

    if (!matchingReservation) {
      const scannedUnit = await this.findUnitByCode(scannedCode, order.tenantId);
      if (!scannedUnit) {
        throw new NotFoundException('Scanned unit was not found');
      }

      const basket = order.basket;
      if (!basket) {
        throw new BadRequestException(`Order ${order.posOrderId} has no basket assigned for packing`);
      }

      const siblingReservation = await this.findSiblingBasketReservationForPackingUnit(
        scannedUnit.id,
        basket.id,
        order.id,
      );
      if (siblingReservation?.fulfillmentOrder) {
        throw new BadRequestException(
          `Unit ${scannedUnit.code} belongs to order ${siblingReservation.fulfillmentOrder.posOrderId} in basket ${basket.barcode}. Open that order before packing it.`,
        );
      }

      const requiredVariationIds = new Set(order.lines.map((line: any) => line.variationId));
      if (requiredVariationIds.has(scannedUnit.variationId)) {
        throw new BadRequestException(`Unit ${scannedUnit.code} is not reserved for this order`);
      }

      throw new BadRequestException(`Unit ${scannedUnit.code} is not one of the products required by this order`);
    }

    if (matchingReservation.status !== WmsPickReservationStatus.PICKED) {
      throw new BadRequestException(`Unit ${matchingReservation.inventoryUnit.code} is not ready for packing`);
    }

    if (this.isPackedEquivalentInventoryStatus(matchingReservation.inventoryUnit.status)) {
      throw new ConflictException(`Unit ${matchingReservation.inventoryUnit.code} was already packed for this order`);
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.wmsInventoryUnit.update({
        where: { id: matchingReservation.inventoryUnitId },
        data: {
          status: WmsInventoryUnitStatus.PACKED,
          updatedById: (user.userId || user.id) ?? undefined,
        },
      });

      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: order.tenantId,
          inventoryUnitId: matchingReservation.inventoryUnitId,
          warehouseId: matchingReservation.inventoryUnit.warehouseId,
          fromLocationId: null,
          toLocationId: null,
          fromStatus: matchingReservation.inventoryUnit.status,
          toStatus: WmsInventoryUnitStatus.PACKED,
          movementType: WmsInventoryMovementType.PACK,
          referenceType: 'WMS_FULFILLMENT_ORDER',
          referenceId: order.id,
          referenceCode: order.posOrderId,
          notes: `STOX packed for order ${order.posOrderId}`,
          actorId: (user.userId || user.id) ?? null,
          createdAt: now,
        },
      });
    });

    const updatedOrder = await this.findPackingOrderForAction(user, id, body.tenantId, request);

    await this.recordStockActivity(user, request, {
      tenantId: updatedOrder.tenantId,
      actionType: 'PACKING_UNIT_SCAN',
      resourceType: 'WMS_INVENTORY_UNIT',
      resourceId: matchingReservation.inventoryUnitId,
      storeId: updatedOrder.storeId,
      warehouseId: matchingReservation.inventoryUnit.warehouseId,
      metadata: {
        fulfillmentOrderId: updatedOrder.id,
        fulfillmentLineId: matchingReservation.fulfillmentLineId,
        posOrderId: updatedOrder.posOrderId,
        unitCode: matchingReservation.inventoryUnit.code,
      },
    });

    return {
      success: true,
      task: this.mapMobilePickingTask(updatedOrder),
    };
  }

  async verifyPackingTracking(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePackScanDto,
    request?: Request,
  ) {
    const order = await this.findPackingOrderForAction(user, id, body.tenantId, request);
    this.assertPackingTaskInProgress(order);
    const tracking = this.assertTrackingCodeMatchesOrder(order, body.code);

    await this.recordStockActivity(user, request, {
      tenantId: order.tenantId,
      actionType: 'PACKING_TRACKING_VERIFY',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: order.id,
      storeId: order.storeId,
      warehouseId: order.warehouseId,
      metadata: {
        fulfillmentOrderId: order.id,
        posOrderId: order.posOrderId,
        trackingCode: tracking,
      },
    });

    return {
      success: true,
      tracking,
      task: this.mapMobilePickingTask(order),
    };
  }

  async completePackingTask(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePackCompleteDto,
    request?: Request,
    options: { requirePackingProof?: boolean } = {},
  ) {
    const order = await this.findPackingOrderForAction(user, id, body.tenantId, request);
    const packingBasketId = order.basket?.id ?? null;
    this.assertPackingTaskInProgress(order);
    this.assertTrackingCodeMatchesOrder(order, body.trackingCode);

    const packedCount = this.getPackedReservationCount(order);
    if (packedCount < order.totalQuantity) {
      throw new BadRequestException(`Order ${order.posOrderId} still has units to verify for packing`);
    }

    const now = new Date();
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      const scopedOrder = await tx.wmsFulfillmentOrder.findUnique({
        where: { id: order.id },
        include: this.pickingTaskInclude(),
      });

      if (!scopedOrder) {
        throw new NotFoundException('Pack task was not found');
      }

      this.assertPackingTaskInProgress(scopedOrder);
      this.assertTrackingCodeMatchesOrder(scopedOrder, body.trackingCode);

      const scopedPackedCount = this.getPackedReservationCount(scopedOrder);
      if (scopedPackedCount < scopedOrder.totalQuantity) {
        throw new BadRequestException(`Order ${scopedOrder.posOrderId} still has units to verify for packing`);
      }

      if (options.requirePackingProof ?? this.isStoxPackingProofRequired()) {
        await this.assertPackingProofExists(tx, scopedOrder.id, scopedOrder.posOrderId);
      }

      const basketId = scopedOrder.basket?.id ?? null;
      if (!basketId) {
        throw new BadRequestException(`Order ${scopedOrder.posOrderId} has no basket assigned for packing`);
      }

      await tx.wmsFulfillmentOrder.update({
        where: { id: scopedOrder.id },
        data: {
          status: WmsFulfillmentOrderStatus.PACKED,
          packedById: (user.userId || user.id) ?? null,
          completedAt: now,
          basketId: null,
        },
      });

      await this.refreshBasketState(tx, basketId, now);

      return tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: scopedOrder.id },
        include: this.pickingTaskInclude(),
      });
    });

    try {
      await this.recordStockActivity(user, request, {
        tenantId: updatedOrder.tenantId,
        actionType: 'PACKING_COMPLETE',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: updatedOrder.id,
        storeId: updatedOrder.storeId,
        warehouseId: updatedOrder.warehouseId,
        metadata: {
          fulfillmentOrderId: updatedOrder.id,
          posOrderId: updatedOrder.posOrderId,
          trackingCode: this.normalizeTrackingCode(body.trackingCode),
        },
      });
    } catch (error) {
      this.logger.warn(
        `Packing completed for ${updatedOrder.id}, but its activity record failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await this.enqueuePackingPostCompleteSync({
      fulfillmentOrderId: updatedOrder.id,
      tenantId: updatedOrder.tenantId,
      storeId: updatedOrder.storeId,
      shopId: updatedOrder.shopId,
      posOrderId: updatedOrder.posOrderId,
      requestedAt: new Date().toISOString(),
    });

    if (this.wantsPackingDeltaResponse(request)) {
      return {
        success: true,
        responseMode: 'delta-v1' as const,
        basketId: packingBasketId,
        basketStatus: null,
        completedOrderId: updatedOrder.id,
        activeOrderId: null,
        plan: null,
      };
    }

    return {
      success: true,
      task: this.mapMobilePickingTask(updatedOrder),
    };
  }

  async getPackingProofs(
    user: BootstrapUser,
    orderId: string,
    request?: Request,
  ) {
    const order = await this.findPackingOrderByIdForAction(user, orderId, request);
    const proofs = await this.prisma.wmsPackingProof.findMany({
      where: { fulfillmentOrderId: order.id },
      include: {
        mediaAsset: true,
        uploadedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return {
      orderId: order.id,
      posOrderId: order.posOrderId,
      tracking: order.posOrder?.tracking ?? null,
      proofs: await Promise.all(proofs.map((proof) => this.mapPackingProof(proof))),
    };
  }

  async uploadPackingProof(
    user: BootstrapUser,
    orderId: string,
    body: WmsPackingProofUploadDto,
    file: UploadedImageFile | undefined,
    request?: Request,
  ) {
    const order = await this.findPackingOrderByIdForAction(user, orderId, request);
    this.assertPackingTaskInProgress(order);

    const userId = user.userId || user.id;
    if (!userId) {
      throw new ForbiddenException('Authenticated WMS user is required');
    }

    const uploadedAsset = await this.mediaAssetsService.uploadPackingProofImage(file, order.tenantId);
    let proof;
    try {
      proof = await this.prisma.wmsPackingProof.create({
        data: {
          fulfillmentOrderId: order.id,
          mediaAssetId: uploadedAsset.assetId,
          uploadedById: userId,
          source: (body.source ?? 'FILE') as WmsPackingProofSource,
        },
        include: {
          mediaAsset: true,
          uploadedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      });
    } catch (error) {
      await this.mediaAssetsService.deleteUnattachedImageAsset(
        uploadedAsset.assetId,
        order.tenantId,
        MediaAssetKind.WMS_PACKING_PROOF_IMAGE,
      );
      throw error;
    }

    try {
      await this.recordStockActivity(user, request, {
        tenantId: order.tenantId,
        actionType: 'PACKING_PROOF_UPLOAD',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: order.id,
        storeId: order.storeId,
        warehouseId: order.warehouseId,
        metadata: {
          fulfillmentOrderId: order.id,
          posOrderId: order.posOrderId,
          trackingCode: order.posOrder?.tracking ?? null,
          proofId: proof.id,
          source: proof.source,
        },
      });
    } catch (error) {
      this.logger.error(
        `Packing proof ${proof.id} was saved but its activity log failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      success: true,
      proof: await this.mapPackingProof(proof),
    };
  }

  async voidPackingTask(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePackVoidDto,
    request?: Request,
  ) {
    const order = await this.findPackingOrderForAction(user, id, body.tenantId, request);

    if ((order.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED) === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
      const basketId = order.basket?.id ?? order.basketId ?? null;
      if (!basketId) {
        throw new BadRequestException(`Order ${order.posOrderId} is no longer inside a pack basket`);
      }

      const basket = await this.findPackingBasketForAction(user, basketId, body.tenantId, request);
      this.assertDemandPackingBasket(basket);

      const scopedOrder = (basket.fulfillmentOrders ?? []).find((candidate: any) => candidate.id === order.id);
      if (!scopedOrder) {
        throw new BadRequestException(`Order ${order.posOrderId} is no longer inside basket ${basket.barcode}`);
      }

      await this.performDemandPackingBasketVoid(
        user,
        basket,
        [scopedOrder],
        body,
        request,
      );

      const updatedOrder = await this.prisma.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: this.pickingTaskInclude(),
      });

      return {
        success: true,
        task: this.mapMobilePickingTask(updatedOrder),
      };
    }

    this.assertPackingTaskVoidable(order);

    const userId = user.userId || user.id || null;
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    const directVoidAccess = await this.resolveDirectPackVoidAccess(userId, user);
    const approval = directVoidAccess.allowed
      ? {
          mode: 'DIRECT' as const,
          approver: null,
        }
      : await this.resolvePackVoidSupervisorApproval({
          requester: user,
          tenantId: order.tenantId,
          request,
          supervisorIdentifier: body.supervisorIdentifier,
          supervisorPassword: body.supervisorPassword,
        });

    const voidReason = this.cleanOptionalText(body.reason);
    if (!voidReason) {
      throw new BadRequestException('Void reason is required');
    }

    const fromStatus = order.status;
    const now = new Date();
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      const scopedOrder = await tx.wmsFulfillmentOrder.findUnique({
        where: { id: order.id },
        include: this.pickingTaskInclude(),
      });

      if (!scopedOrder) {
        throw new NotFoundException('Pack task was not found');
      }

      this.assertPackingTaskVoidable(scopedOrder);

      const reservations = this.getAllPickReservations(scopedOrder);
      const units = reservations.map((reservation: any) => reservation.inventoryUnit);
      const restoreStateByUnitId = await this.findVoidRestoreLocations(tx, scopedOrder.id, units.map((unit: any) => unit.id));

      for (const reservation of reservations) {
        const restoreState = restoreStateByUnitId.get(reservation.inventoryUnitId);
        const restoreLocationId = reservation.inventoryUnit.currentLocationId
          ?? restoreState?.locationId
          ?? null;
        const restoreStatus = restoreState?.status ?? WmsInventoryUnitStatus.PUTAWAY;

        if (!restoreLocationId) {
          throw new BadRequestException(`Unit ${reservation.inventoryUnit.code} has no source bin to restore after void`);
        }

        await tx.wmsInventoryUnit.update({
          where: { id: reservation.inventoryUnitId },
          data: {
            currentLocationId: restoreLocationId,
            status: restoreStatus,
            updatedById: userId,
          },
        });

        await tx.wmsInventoryMovement.create({
          data: {
            tenantId: scopedOrder.tenantId,
            inventoryUnitId: reservation.inventoryUnitId,
            warehouseId: reservation.inventoryUnit.warehouseId,
            fromLocationId: reservation.inventoryUnit.currentLocationId,
            toLocationId: restoreLocationId,
            fromStatus: reservation.inventoryUnit.status,
            toStatus: restoreStatus,
            movementType: WmsInventoryMovementType.ADJUSTMENT,
            referenceType: 'WMS_FULFILLMENT_ORDER',
            referenceId: scopedOrder.id,
            referenceCode: scopedOrder.posOrderId,
            notes: `PACK void returned to inventory for order ${scopedOrder.posOrderId}: ${voidReason}`,
            actorId: userId,
            createdAt: now,
          },
        });

        await tx.wmsPickReservation.update({
          where: { id: reservation.id },
          data: {
            status: WmsPickReservationStatus.CANCELED,
          },
        });
      }

      await tx.wmsFulfillmentLine.updateMany({
        where: { fulfillmentOrderId: scopedOrder.id },
        data: {
          quantityAllocated: 0,
          quantityPicked: 0,
          status: WmsFulfillmentLineStatus.CANCELED,
          issueReason: voidReason,
        },
      });

      await tx.wmsFulfillmentOrder.update({
        where: { id: scopedOrder.id },
        data: {
          status: WmsFulfillmentOrderStatus.CANCELED,
          issueReason: voidReason,
          allocatedQuantity: 0,
          pickedQuantity: 0,
          completedAt: now,
          basketId: null,
        },
      });

      if (scopedOrder.basket?.id) {
        await this.refreshBasketState(tx, scopedOrder.basket.id, now);
      }

      return tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: scopedOrder.id },
        include: this.pickingTaskInclude(),
      });
    });

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId: updatedOrder.tenantId,
      actorId: userId,
      sessionId: (this.cls.get('sessionId') as string | undefined) || user.sessionId || null,
      actionType: approval.mode === 'DIRECT' ? 'PACKING_VOID_COMPLETE' : 'PACKING_VOID_REQUEST',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: updatedOrder.id,
      storeId: updatedOrder.storeId,
      warehouseId: updatedOrder.warehouseId,
      fromStatus,
      toStatus: WmsFulfillmentOrderStatus.CANCELED,
      metadata: {
        approvalMode: approval.mode,
        fulfillmentOrderId: updatedOrder.id,
        posOrderId: updatedOrder.posOrderId,
        reason: voidReason,
        approverId: approval.approver?.id ?? null,
        approverEmail: approval.approver?.email ?? null,
      },
    });

    if (approval.approver) {
      await this.wmsStaffActivityService.recordFromRequest({
        request,
        tenantId: updatedOrder.tenantId,
        actorId: approval.approver.id,
        sessionId: (this.cls.get('sessionId') as string | undefined) || user.sessionId || null,
        actionType: 'PACKING_VOID_APPROVAL',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: updatedOrder.id,
        storeId: updatedOrder.storeId,
        warehouseId: updatedOrder.warehouseId,
        fromStatus,
        toStatus: WmsFulfillmentOrderStatus.CANCELED,
        metadata: {
          fulfillmentOrderId: updatedOrder.id,
          posOrderId: updatedOrder.posOrderId,
          reason: voidReason,
          requesterId: userId,
          requesterEmail: user.email ?? null,
        },
      });

      await this.wmsStaffActivityService.recordFromRequest({
        request,
        tenantId: updatedOrder.tenantId,
        actorId: userId,
        sessionId: (this.cls.get('sessionId') as string | undefined) || user.sessionId || null,
        actionType: 'PACKING_VOID_COMPLETE',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: updatedOrder.id,
        storeId: updatedOrder.storeId,
        warehouseId: updatedOrder.warehouseId,
        fromStatus,
        toStatus: WmsFulfillmentOrderStatus.CANCELED,
        metadata: {
          approvalMode: approval.mode,
          fulfillmentOrderId: updatedOrder.id,
          posOrderId: updatedOrder.posOrderId,
          reason: voidReason,
          approverId: approval.approver.id,
          approverEmail: approval.approver.email,
        },
      });
    }

    return {
      success: true,
      task: this.mapMobilePickingTask(updatedOrder),
    };
  }

  async claimPickingTask(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePickScopedDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    await this.wmsFulfillmentSyncService.allocateFulfillmentOrder(id, userId);
    const order = await this.findPickingOrderForAction(user, id, body.tenantId, request);

    if (order.claimedById === userId && (
      order.status === WmsFulfillmentOrderStatus.READY
      || order.status === WmsFulfillmentOrderStatus.IN_PICKING
    )) {
      return {
        success: true,
        task: this.mapMobilePickingTask(order),
      };
    }

    if (order.claimedById && order.claimedById !== userId) {
      throw new ConflictException('This pick task is already claimed by another staff member');
    }

    if (order.status !== WmsFulfillmentOrderStatus.READY) {
      throw new BadRequestException(`Order ${order.posOrderId} is ${this.formatEnumLabel(order.status)} and cannot be claimed yet`);
    }

    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      await this.assertAvailableBasketForClaim(order, tx, userId);

      const claimResult = await tx.wmsFulfillmentOrder.updateMany({
        where: {
          id: order.id,
          status: WmsFulfillmentOrderStatus.READY,
          claimedById: null,
        },
        data: {
          claimedById: userId,
          claimedAt: new Date(),
        },
      });

      if (claimResult.count !== 1) {
        throw new ConflictException('This pick task was already claimed or changed status');
      }

      return tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: this.pickingTaskInclude(),
      });
    });

    await this.recordStockActivity(user, request, {
      tenantId: updatedOrder.tenantId,
      actionType: 'PICKING_CLAIM',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: updatedOrder.id,
      storeId: updatedOrder.storeId,
      warehouseId: updatedOrder.warehouseId,
    });

    return {
      success: true,
      task: this.mapMobilePickingTask(updatedOrder),
    };
  }

  async scanPickingBin(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePickScanDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const order = await this.findPickingOrderForAction(user, id, body.tenantId, request);
    this.assertPickingTaskClaimedByUser(order, userId, { allowReadyWithoutBasket: true });
    this.assertPickingTaskHasBasket(order);

    const location = await this.findLocationByCode(body.code, {
      warehouseId: order.warehouseId ?? null,
      warehouseMismatchMessage: `Scanned bin belongs to another warehouse, not the order warehouse for ${order.posOrderId}`,
    });
    if (!location || location.kind !== WmsLocationKind.BIN) {
      throw new NotFoundException('Scanned code is not a WMS bin');
    }

    const pendingReservations = this.getPendingPickReservations(order).filter(
      (reservation) => reservation.inventoryUnit.currentLocationId === location.id,
    );

    if (pendingReservations.length === 0) {
      throw new BadRequestException(`Bin ${location.code} has no reserved units for order ${order.posOrderId}`);
    }

    await this.recordStockActivity(user, request, {
      tenantId: order.tenantId,
      actionType: 'PICKING_BIN_SCAN',
      resourceType: 'WMS_LOCATION',
      resourceId: location.id,
      storeId: order.storeId,
      warehouseId: location.warehouse.id,
      metadata: {
        fulfillmentOrderId: order.id,
        posOrderId: order.posOrderId,
        pendingUnits: pendingReservations.length,
      },
    });

    return {
      success: true,
      bin: {
        id: location.id,
        code: location.code,
        name: location.name,
        kind: location.kind,
        warehouse: location.warehouse,
      },
      pendingUnits: pendingReservations.map((reservation) => this.mapMobilePickReservation(reservation)),
    };
  }

  async scanPickingBasket(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePickScanDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const order = await this.findPickingOrderForAction(user, id, body.tenantId, request);
    this.assertPickingTaskClaimedByUser(order, userId, { allowReadyWithoutBasket: true });

    const basketCode = this.normalizeScannedCode(body.code);
    const now = new Date();
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      const scopedOrder = await tx.wmsFulfillmentOrder.findUnique({
        where: { id: order.id },
        include: this.pickingTaskInclude(),
      });

      if (!scopedOrder) {
        throw new NotFoundException('Pick task was not found');
      }

      const assignmentMode = scopedOrder.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED;

      if (scopedOrder.basket?.barcode === basketCode) {
        if (
          assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
          && (scopedOrder.basketPickDemands?.length ?? 0) === 0
        ) {
          if (!scopedOrder.basket.warehouseId) {
            throw new ConflictException(`Basket ${scopedOrder.basket.barcode} must be assigned to a warehouse before demand picking.`);
          }

          if (!scopedOrder.warehouseId) {
            await tx.wmsFulfillmentOrder.update({
              where: { id: scopedOrder.id },
              data: {
                warehouseId: scopedOrder.basket.warehouseId,
                status: WmsFulfillmentOrderStatus.IN_PICKING,
              },
            });
            scopedOrder.warehouseId = scopedOrder.basket.warehouseId;
          }

          await this.createBasketPickDemands(tx, {
            basketId: scopedOrder.basket.id,
            orders: [scopedOrder],
          });

          return tx.wmsFulfillmentOrder.findUniqueOrThrow({
            where: { id: scopedOrder.id },
            include: this.pickingTaskInclude(),
          });
        }

        return scopedOrder;
      }

      if (scopedOrder.basket) {
        if (scopedOrder.pickedQuantity > 0) {
          throw new ConflictException(`Order ${scopedOrder.posOrderId} is already assigned to basket ${scopedOrder.basket.barcode}`);
        }

        const previousBasketId = scopedOrder.basket.id;
        await tx.wmsBasketPickDemand.deleteMany({
          where: {
            fulfillmentOrderId: scopedOrder.id,
          },
        });
        await tx.wmsFulfillmentOrder.update({
          where: { id: scopedOrder.id },
          data: {
            basketId: null,
          },
        });
        await this.refreshBasketState(tx, previousBasketId, now);
      }

      let existingBasket = await tx.wmsBasket.findUnique({
        where: { barcode: basketCode },
        include: this.mobileBasketInclude(),
      });

      if (!existingBasket) {
        throw new NotFoundException(`Basket ${basketCode} is not registered. Add it in WMS Warehouses first.`);
      }

      if (BLOCKED_PICK_BASKET_STATUSES.includes(existingBasket.status as (typeof BLOCKED_PICK_BASKET_STATUSES)[number])) {
        throw new ConflictException(`Basket ${existingBasket.barcode} is ${this.formatEnumLabel(existingBasket.status)} and cannot be used`);
      }

      await this.lockBasketForUpdate(tx, existingBasket.id);
      await this.releaseReusableOrphanBasketUnitsTx(tx, {
        basketId: existingBasket.id,
        actorId: userId,
        now,
      });
      existingBasket = await tx.wmsBasket.findUnique({
        where: { id: existingBasket.id },
        include: this.mobileBasketInclude(),
      });

      if (!existingBasket) {
        throw new NotFoundException(`Basket ${basketCode} is not registered. Add it in WMS Warehouses first.`);
      }

      if (BLOCKED_PICK_BASKET_STATUSES.includes(existingBasket.status as (typeof BLOCKED_PICK_BASKET_STATUSES)[number])) {
        throw new ConflictException(`Basket ${existingBasket.barcode} is ${this.formatEnumLabel(existingBasket.status)} and cannot be used`);
      }

      const activeBasketOrders = await tx.wmsFulfillmentOrder.findMany({
        where: {
          basketId: existingBasket.id,
          status: {
            in: [...ACTIVE_BASKET_ORDER_STATUSES],
          },
        },
        select: {
          id: true,
          posOrderId: true,
          status: true,
          pickedQuantity: true,
          assignmentMode: true,
        },
        orderBy: [
          { updatedAt: 'desc' },
          { createdAt: 'desc' },
        ],
      });

      if (activeBasketOrders.some((activeOrder) => activeOrder.id === scopedOrder.id)) {
        await tx.wmsFulfillmentOrder.update({
          where: { id: scopedOrder.id },
          data: {
            status: WmsFulfillmentOrderStatus.IN_PICKING,
            ...(assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND && existingBasket.warehouseId
              ? { warehouseId: existingBasket.warehouseId }
              : {}),
          },
        });

        return tx.wmsFulfillmentOrder.findUniqueOrThrow({
          where: { id: scopedOrder.id },
          include: this.pickingTaskInclude(),
        });
      }

      const incompatibleOrder = activeBasketOrders.find((activeOrder) => (
        (activeOrder.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED) !== assignmentMode
      ));
      if (incompatibleOrder) {
        throw new ConflictException(`Basket ${existingBasket.barcode} already contains a different picking mode`);
      }

      if (
        existingBasket.status !== WmsBasketStatus.AVAILABLE
        && existingBasket.status !== WmsBasketStatus.ASSIGNED
        && existingBasket.status !== WmsBasketStatus.IN_PICKING
      ) {
        throw new ConflictException(`Basket ${existingBasket.barcode} is ${this.formatEnumLabel(existingBasket.status)} and not available for new pick orders`);
      }

      if (activeBasketOrders.length >= (existingBasket.maxFulfillmentOrders ?? 1)) {
        throw new ConflictException(
          `Basket ${existingBasket.barcode} already has ${activeBasketOrders.length}/${existingBasket.maxFulfillmentOrders ?? 1} active orders`,
        );
      }

      if (existingBasket?.assignedPickerId && existingBasket.assignedPickerId !== userId) {
        throw new ConflictException(`Basket ${existingBasket.barcode} is currently assigned to another picker`);
      }

      if (assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND && !existingBasket.warehouseId) {
        throw new ConflictException(`Basket ${existingBasket.barcode} must be assigned to a warehouse before demand picking.`);
      }

      if (scopedOrder.warehouseId && existingBasket.warehouseId && existingBasket.warehouseId !== scopedOrder.warehouseId) {
        throw new ConflictException(`Basket ${existingBasket.barcode} belongs to ${existingBasket.warehouse?.name ?? 'another warehouse'}`);
      }

      if (existingBasket.tenantId && existingBasket.tenantId !== scopedOrder.tenantId) {
        throw new ConflictException(`Basket ${existingBasket.barcode} is assigned to another partner`);
      }

      await tx.wmsBasket.update({
        where: { id: existingBasket.id },
        data: {
          tenantId: scopedOrder.tenantId,
          status: existingBasket.status === WmsBasketStatus.AVAILABLE
            ? WmsBasketStatus.ASSIGNED
            : existingBasket.status,
          assignedPickerId: userId,
          assignedPackerId: null,
          fulfillmentOrderId: existingBasket.fulfillmentOrderId ?? scopedOrder.id,
          claimedAt: existingBasket.claimedAt ?? now,
          fullAt: null,
          readyForPackAt: null,
        },
      });

      await tx.wmsFulfillmentOrder.update({
        where: { id: scopedOrder.id },
        data: {
          status: WmsFulfillmentOrderStatus.IN_PICKING,
          basketId: existingBasket.id,
          ...(assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
            ? { warehouseId: existingBasket.warehouseId }
            : {}),
        },
      });

      if (assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
        const demandOrder = await tx.wmsFulfillmentOrder.findUniqueOrThrow({
          where: { id: scopedOrder.id },
          include: this.pickingTaskInclude(),
        });
        await this.createBasketPickDemands(tx, {
          basketId: existingBasket.id,
          orders: [demandOrder],
        });
      }

      return tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: scopedOrder.id },
        include: this.pickingTaskInclude(),
      });
    });

    await this.recordStockActivity(user, request, {
      tenantId: updatedOrder.tenantId,
      actionType: 'PICKING_BASKET_SCAN',
      resourceType: 'WMS_BASKET',
      resourceId: updatedOrder.basket?.id ?? null,
      storeId: updatedOrder.storeId,
      warehouseId: updatedOrder.warehouseId,
      metadata: {
        fulfillmentOrderId: updatedOrder.id,
        posOrderId: updatedOrder.posOrderId,
        basketCode,
        ...(this.isDemandPickingOrder(updatedOrder) ? { mode: 'BASKET_DEMAND' } : {}),
      },
    });

    return {
      success: true,
      task: this.mapMobilePickingTask(updatedOrder),
    };
  }

  async assignPickingTasksToBasket(
    user: BootstrapUser,
    body: WmsMobilePickBasketBatchAssignDto,
    request?: Request,
  ) {
    const assignmentStartedAt = Date.now();
    const userId = user.userId || user.id || null;
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    const taskIds = [...new Set(body.taskIds)];
    if (taskIds.length !== body.taskIds.length) {
      throw new BadRequestException('Selected pick tasks must be unique');
    }

    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: body.tenantId } as GetWmsMobileStockDto,
      request,
    );

    const [access, taskAssignment] = await Promise.all([
      this.effectiveAccessService.resolveUserAccess({
        userId,
        basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
        workspace: 'wms',
      }),
      this.getWmsTaskAssignment(userId),
    ]);
    this.assertPickExecutionAccess(user, access.permissions, taskAssignment);

    const scopedTenantIds = this.resolvePickTaskSelectionTenantIds(
      tenantContext.tenantId,
      tenantContext.tenantOptions,
    );
    const basketCode = this.normalizeScannedCode(body.basketCode);
    const now = new Date();
    const fulfillmentGoLiveFilters = await this.buildTenantGoLiveFulfillmentOrderFilters(scopedTenantIds);
    const pickSelectionWhere: Prisma.WmsFulfillmentOrderWhereInput = fulfillmentGoLiveFilters.length > 0
      ? { OR: fulfillmentGoLiveFilters }
      : { tenantId: { in: scopedTenantIds } };
    const selectedDemandScopes = await this.prisma.wmsFulfillmentOrder.findMany({
      where: {
        id: {
          in: taskIds,
        },
        assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
        ...pickSelectionWhere,
      },
      select: {
        tenantId: true,
        storeId: true,
      },
    });

    const demandScopeKeys = Array.from(
      new Set(selectedDemandScopes.map((scope) => `${scope.tenantId}::${scope.storeId}`)),
    );
    const preTransactionMs = Date.now() - assignmentStartedAt;

    const transactionStartedAt = Date.now();
    const executeTransaction = () => this.prisma.$transaction(async (tx) => {
      const orders = await tx.wmsFulfillmentOrder.findMany({
        where: {
          id: {
            in: taskIds,
          },
          ...pickSelectionWhere,
        },
        include: this.basketAssignmentOrderInclude(),
      });
      const orderById = new Map(orders.map((order) => [order.id, order]));
      const orderedTasks = taskIds
        .map((taskId) => orderById.get(taskId))
        .filter((order): order is (typeof orders)[number] => Boolean(order));
      const prioritizedTargetIds = orderedTasks
        .filter((order) => Boolean(order.priorityOverrideAt))
        .map((order) => order.id);
      const priorityRefreshScopes = new Map<string, Set<string>>();

      if (orderedTasks.length !== taskIds.length) {
        throw new NotFoundException('One or more selected pick tasks were not found');
      }

      const firstOrder = orderedTasks[0];
      if (!firstOrder) {
        throw new BadRequestException('Select at least one pick task');
      }

      const assignmentMode = firstOrder.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED;
      let basket = await tx.wmsBasket.findUnique({
        where: { barcode: basketCode },
        include: this.basketAssignmentBasketInclude(),
      });

      if (!basket) {
        throw new NotFoundException(`Basket ${basketCode} is not registered. Add it in WMS Warehouses first.`);
      }

      const isIdempotentReplay = basket.assignedPickerId === userId
        && orderedTasks.every((order) => (
          order.status === WmsFulfillmentOrderStatus.IN_PICKING
          && order.basketId === basket?.id
          && order.claimedById === userId
          && (order.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED) === assignmentMode
        ));

      if (isIdempotentReplay) {
        const replayBasket = await tx.wmsBasket.findUniqueOrThrow({
          where: { id: basket.id },
          include: this.mobileBasketInclude(),
        });
        const replayTaskById = new Map(
          replayBasket.fulfillmentOrders.map((task) => [task.id, task]),
        );
        const replayTasks = taskIds
          .map((taskId) => replayTaskById.get(taskId))
          .filter((task): task is (typeof replayBasket.fulfillmentOrders)[number] => Boolean(task));
        const replayTenantIds = Array.from(new Set(orderedTasks.map((order) => order.tenantId)));
        const replayStoreIds = Array.from(new Set(orderedTasks.map((order) => order.storeId)));

        return {
          basket: replayBasket,
          tasks: replayTasks,
          tenantId: replayTenantIds.length === 1 ? replayTenantIds[0] : null,
          storeId: replayStoreIds.length === 1 ? replayStoreIds[0] : null,
          warehouseId: replayBasket.warehouseId ?? firstOrder.warehouseId ?? null,
          posOrderIds: orderedTasks.map((order) => order.posOrderId),
          priorityRefreshScopes: [],
          replayed: true,
        };
      }

      for (const order of orderedTasks) {
        if (order.status !== WmsFulfillmentOrderStatus.READY) {
          throw new BadRequestException(`Order ${order.posOrderId} is ${this.formatEnumLabel(order.status)} and cannot be batch assigned`);
        }

        this.assertActivePickOrderPosConfirmed(order);

        const orderAssignmentMode = order.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED;
        if (orderAssignmentMode !== assignmentMode) {
          throw new ConflictException('Selected pick tasks must use the same assignment mode');
        }

        if (order.basketId) {
          throw new ConflictException(`Order ${order.posOrderId} already has a basket`);
        }

        if (order.claimedById && order.claimedById !== userId) {
          throw new ForbiddenException(`Order ${order.posOrderId} is assigned to another picker`);
        }
      }

      if (BLOCKED_PICK_BASKET_STATUSES.includes(basket.status as (typeof BLOCKED_PICK_BASKET_STATUSES)[number])) {
        throw new ConflictException(`Basket ${basket.barcode} is ${this.formatEnumLabel(basket.status)} and cannot be used`);
      }

      await this.lockBasketForUpdate(tx, basket.id);
      await this.releaseReusableOrphanBasketUnitsTx(tx, {
        basketId: basket.id,
        actorId: userId,
        now,
      });
      basket = await tx.wmsBasket.findUnique({
        where: { id: basket.id },
        include: this.basketAssignmentBasketInclude(),
      });

      if (!basket) {
        throw new NotFoundException(`Basket ${basketCode} is not registered. Add it in WMS Warehouses first.`);
      }

      if (
        basket.status !== WmsBasketStatus.AVAILABLE
        && basket.status !== WmsBasketStatus.ASSIGNED
        && basket.status !== WmsBasketStatus.IN_PICKING
      ) {
        throw new ConflictException(`Basket ${basket.barcode} is ${this.formatEnumLabel(basket.status)} and not available for new pick orders`);
      }

      if (basket.assignedPickerId && basket.assignedPickerId !== userId) {
        throw new ConflictException(`Basket ${basket.barcode} is currently assigned to another picker`);
      }

      if (assignmentMode === WmsFulfillmentAssignmentMode.SERIAL_RESERVED) {
        if (!firstOrder.warehouseId) {
          throw new BadRequestException(`Order ${firstOrder.posOrderId} has no warehouse assigned`);
        }

        for (const order of orderedTasks) {
          if (order.warehouseId !== firstOrder.warehouseId) {
            throw new ConflictException('Selected pick tasks must belong to the same warehouse');
          }
        }

        if (basket.warehouseId && basket.warehouseId !== firstOrder.warehouseId) {
          throw new ConflictException(`Basket ${basket.barcode} belongs to ${basket.warehouse?.name ?? 'another warehouse'}`);
        }
      } else if (!basket.warehouseId) {
        throw new ConflictException(`Basket ${basket.barcode} must be assigned to a warehouse before demand picking.`);
      }

      const activeBasketOrders = basket.fulfillmentOrders ?? [];
      for (const activeOrder of activeBasketOrders) {
        const activeAssignmentMode = activeOrder.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED;
        if (activeAssignmentMode !== assignmentMode) {
          throw new ConflictException(`Basket ${basket.barcode} already contains ${this.formatEnumLabel(activeAssignmentMode)} pick work`);
        }

        if (
          assignmentMode === WmsFulfillmentAssignmentMode.SERIAL_RESERVED
          && activeOrder.warehouseId !== firstOrder.warehouseId
        ) {
          throw new ConflictException(`Basket ${basket.barcode} already contains another warehouse's order`);
        }

        if (
          assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
          && basket.warehouseId
          && activeOrder.warehouseId
          && activeOrder.warehouseId !== basket.warehouseId
        ) {
          throw new ConflictException(`Basket ${basket.barcode} already contains another warehouse's order`);
        }
      }

      if (assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
        for (const order of orderedTasks) {
          if (!prioritizedTargetIds.includes(order.id)) {
            continue;
          }

          const scopeKey = `${order.tenantId}::${order.storeId}`;
          const variationIds = priorityRefreshScopes.get(scopeKey) ?? new Set<string>();
          for (const line of order.lines ?? []) {
            if (line.status === WmsFulfillmentLineStatus.CANCELED) {
              continue;
            }

            if ((line.quantityRequired ?? 0) > 0) {
              variationIds.add(line.variationId);
            }
          }
          priorityRefreshScopes.set(scopeKey, variationIds);
        }

        for (const order of orderedTasks) {
          if (order.warehouseId && order.warehouseId !== basket.warehouseId) {
            throw new ConflictException(`Order ${order.posOrderId} is already locked to another warehouse`);
          }
        }
      }

      const maxFulfillmentOrders = basket.maxFulfillmentOrders ?? 1;
      if (activeBasketOrders.length + orderedTasks.length > maxFulfillmentOrders) {
        throw new ConflictException(
          `Basket ${basket.barcode} has ${Math.max(maxFulfillmentOrders - activeBasketOrders.length, 0)} open slot${Math.max(maxFulfillmentOrders - activeBasketOrders.length, 0) === 1 ? '' : 's'}`,
        );
      }
      const nextBasketTenantIds = Array.from(new Set([
        ...activeBasketOrders.map((order) => order.tenantId),
        ...orderedTasks.map((order) => order.tenantId),
      ]));
      const nextBasketStoreIds = Array.from(new Set([
        ...activeBasketOrders.map((order) => order.storeId),
        ...orderedTasks.map((order) => order.storeId),
      ]));

      await tx.wmsBasket.update({
        where: { id: basket.id },
        data: {
          tenantId: nextBasketTenantIds.length === 1 ? nextBasketTenantIds[0] : null,
          warehouseId: basket.warehouseId ?? firstOrder.warehouseId,
          status: basket.status === WmsBasketStatus.AVAILABLE
            ? WmsBasketStatus.ASSIGNED
            : basket.status,
          assignedPickerId: userId,
          assignedPackerId: null,
          fulfillmentOrderId: basket.fulfillmentOrderId ?? firstOrder.id,
          claimedAt: basket.claimedAt ?? now,
          fullAt: null,
          readyForPackAt: null,
        },
      });

      const assignResult = await tx.wmsFulfillmentOrder.updateMany({
        where: {
          id: {
            in: taskIds,
          },
          status: WmsFulfillmentOrderStatus.READY,
          basketId: null,
          AND: [
            pickSelectionWhere,
            {
              OR: [
                { claimedById: null },
                { claimedById: userId },
              ],
            },
          ],
        },
        data: {
          claimedById: userId,
          claimedAt: now,
          status: WmsFulfillmentOrderStatus.IN_PICKING,
          basketId: basket.id,
          ...(assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
            ? { warehouseId: basket.warehouseId }
            : {}),
        },
      });

      if (assignResult.count !== taskIds.length) {
        throw new ConflictException('One or more selected pick tasks changed before basket assignment');
      }

      if (prioritizedTargetIds.length > 0) {
        await this.wmsFulfillmentSyncService.clearPriorityOverridesTx(tx, {
          targetOrderIds: prioritizedTargetIds,
        });
      }

      if (assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
        await this.createBasketPickDemands(tx, {
          basketId: basket.id,
          orders: orderedTasks.map((order) => ({
            ...order,
            warehouseId: basket.warehouseId,
          })),
        });
      }

      await this.refreshBasketState(tx, basket.id, now);

      const updatedBasket = await tx.wmsBasket.findUniqueOrThrow({
        where: { id: basket.id },
        include: this.mobileBasketInclude(),
      });
      const finalTaskById = new Map(
        updatedBasket.fulfillmentOrders.map((task) => [task.id, task]),
      );
      const orderedFinalTasks = taskIds
        .map((taskId) => finalTaskById.get(taskId))
        .filter((task): task is (typeof updatedBasket.fulfillmentOrders)[number] => Boolean(task));

      return {
        basket: updatedBasket,
        tasks: orderedFinalTasks,
        tenantId: nextBasketTenantIds.length === 1 ? nextBasketTenantIds[0] : null,
        storeId: nextBasketStoreIds.length === 1 ? nextBasketStoreIds[0] : null,
        warehouseId: basket.warehouseId ?? firstOrder.warehouseId ?? null,
        posOrderIds: orderedTasks.map((order) => order.posOrderId),
        priorityRefreshScopes: Array.from(priorityRefreshScopes.entries()).map(([scopeKey, variationIds]) => {
          const [tenantId, storeId] = scopeKey.split('::');
          return {
            tenantId,
            storeId,
            variationIds: Array.from(variationIds),
          };
        }),
        replayed: false,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: BASKET_ASSIGN_TRANSACTION_MAX_WAIT_MS,
      timeout: BASKET_ASSIGN_TRANSACTION_TIMEOUT_MS,
    });
    let result: Awaited<ReturnType<typeof executeTransaction>> | null = null;
    let transactionAttempts = 0;
    try {
      while (!result && transactionAttempts < BASKET_ASSIGN_TRANSACTION_MAX_ATTEMPTS) {
        transactionAttempts += 1;
        try {
          result = await executeTransaction();
        } catch (error) {
          const isTransactionConflict = isBasketAssignmentTransactionConflict(error);
          if (isTransactionConflict && transactionAttempts < BASKET_ASSIGN_TRANSACTION_MAX_ATTEMPTS) {
            this.logger.warn(
              `STOX basket assignment retry basket=${basketCode} tasks=${taskIds.length} attempt=${transactionAttempts}`,
            );
            await new Promise((resolve) => setTimeout(resolve, transactionAttempts * 75));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      const transactionMs = Date.now() - transactionStartedAt;
      this.logger.error(
        `STOX basket assignment failed basket=${basketCode} tasks=${taskIds.length} scopes=${demandScopeKeys.length} pre_transaction_ms=${preTransactionMs} transaction_ms=${transactionMs} total_ms=${Date.now() - assignmentStartedAt}`,
        error instanceof Error ? error.stack : String(error),
      );
      if (isBasketAssignmentTransactionConflict(error)) {
        throw new ConflictException('Basket or inventory changed during assignment. Please retry.');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028') {
        throw new ServiceUnavailableException('Basket assignment timed out while planning inventory. Please retry.');
      }
      throw error;
    }
    if (!result) {
      throw new ServiceUnavailableException('Basket assignment could not start. Please retry.');
    }
    const transactionMs = Date.now() - transactionStartedAt;

    for (const scope of result.priorityRefreshScopes ?? []) {
      if (!scope.tenantId || !scope.storeId) {
        continue;
      }

      await this.wmsFulfillmentSyncService.refreshDemandQueueForScope({
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        variationIds: scope.variationIds,
      });
    }

    if (!result.replayed) {
      await this.recordStockActivity(user, request, {
        tenantId: result.tenantId,
        actionType: 'PICKING_BASKET_BATCH_ASSIGN',
        resourceType: 'WMS_BASKET',
        resourceId: result.basket.id,
        taskType: 'PICK',
        storeId: result.storeId,
        warehouseId: result.warehouseId,
        metadata: {
          basketCode: result.basket.barcode,
          taskIds,
          posOrderIds: result.posOrderIds,
          assignedCount: result.tasks.length,
          ...(result.tasks.some((task: any) => this.isDemandPickingOrder(task)) ? { mode: 'BASKET_DEMAND' } : {}),
        },
      });
    }

    const totalMs = Date.now() - assignmentStartedAt;
    const timingMessage = `STOX basket assignment basket=${result.basket.id} tasks=${taskIds.length} scopes=${demandScopeKeys.length} attempts=${transactionAttempts} replayed=${result.replayed} pre_transaction_ms=${preTransactionMs} transaction_ms=${transactionMs} total_ms=${totalMs}`;
    if (totalMs >= SLOW_BASKET_ASSIGN_THRESHOLD_MS) {
      this.logger.warn(timingMessage);
    } else {
      this.logger.debug(timingMessage);
    }

    return {
      success: true,
      assignedCount: result.tasks.length,
      basket: this.mapMobilePickBasket(result.basket),
      tasks: result.tasks.map((task) => this.mapMobilePickingTask(task)),
    };
  }

  private async createBasketPickDemands(
    tx: Prisma.TransactionClient,
    params: {
      basketId: string;
      orders: any[];
    },
  ) {
    const orderIds = params.orders.map((order) => order.id);
    await tx.wmsBasketPickDemand.deleteMany({
      where: {
        basketId: params.basketId,
        fulfillmentOrderId: {
          in: orderIds,
        },
      },
    });

    let routeSequence = await tx.wmsBasketPickDemandBin.count({
      where: {
        basketId: params.basketId,
      },
    });

    const uniqueTenantIds = Array.from(
      new Set(
        params.orders
          .map((order) => order.tenantId)
          .filter((tenantId): tenantId is string => typeof tenantId === 'string' && tenantId.length > 0),
      ),
    );
    const poolIndexEntries = await Promise.all(
      uniqueTenantIds.map(async (tenantId) => ([
        tenantId,
        await loadTenantStockPoolIndex(tx, tenantId),
      ] as const)),
    );
    const poolIndexByTenantId = new Map(poolIndexEntries);

    const demandInputs: Array<{
      order: any;
      line: any;
      requiredQuantity: number;
      availabilityKey: string;
    }> = [];
    const availabilityParamsByKey = new Map<string, {
      tenantId: string;
      storeId: string;
      warehouseId: string;
      posWarehouseRef: string | null;
      variationId: string;
    }>();

    for (const order of params.orders) {
      if (!order.warehouseId) {
        throw new BadRequestException(`Order ${order.posOrderId} has no warehouse assigned`);
      }

      const lines = Array.isArray(order.lines)
        ? order.lines.filter((line: any) => (
            line.status !== WmsFulfillmentLineStatus.CANCELED
            && Math.max(line.quantityRequired ?? 0, 0) > 0
          ))
        : [];

      for (const line of lines) {
        const requiredQuantity = Math.max(line.quantityRequired ?? 0, 0);
        const availabilityParams = {
          tenantId: order.tenantId,
          storeId: order.storeId,
          warehouseId: order.warehouseId,
          posWarehouseRef: order.posWarehouseRef ?? null,
          variationId: line.variationId,
        };
        const availabilityKey = JSON.stringify(availabilityParams);
        availabilityParamsByKey.set(availabilityKey, availabilityParams);
        demandInputs.push({
          order,
          line,
          requiredQuantity,
          availabilityKey,
        });
      }
    }

    const availabilityEntries = await Promise.all(
      Array.from(availabilityParamsByKey.entries()).map(async ([key, availabilityParams]) => ([
        key,
        await this.getDemandPickBinAvailability(
          tx,
          availabilityParams,
          poolIndexByTenantId.get(availabilityParams.tenantId) ?? EMPTY_STOCK_POOL_INDEX,
        ),
      ] as const)),
    );
    const availableBinsByKey = new Map(availabilityEntries);
    const plannedQuantityByLocation = new Map<string, number>();
    const demandRows: Prisma.WmsBasketPickDemandCreateManyInput[] = [];
    const demandBinRows: Prisma.WmsBasketPickDemandBinCreateManyInput[] = [];

    for (const input of demandInputs) {
      const poolIndex = poolIndexByTenantId.get(input.order.tenantId) ?? EMPTY_STOCK_POOL_INDEX;
      const availableBins = [...(availableBinsByKey.get(input.availabilityKey) ?? [])]
        .map((bin) => {
          const locationKey = [
            input.order.tenantId,
            poolIndex.buildWarehouseAllocationKey(
              bin.warehouseId,
              input.order.storeId,
              input.line.variationId,
            ),
            bin.locationId,
          ].join('::');
          return {
            ...bin,
            locationKey,
            effectiveAvailableQuantity: Math.max(
              bin.availableQuantity - (plannedQuantityByLocation.get(locationKey) ?? 0),
              0,
            ),
          };
        })
        .sort((a, b) => {
          const aExpiration = a.earliestExpirationDate?.getTime() ?? Number.POSITIVE_INFINITY;
          const bExpiration = b.earliestExpirationDate?.getTime() ?? Number.POSITIVE_INFINITY;
          if (aExpiration !== bExpiration) {
            return aExpiration - bExpiration;
          }
          if (b.effectiveAvailableQuantity !== a.effectiveAvailableQuantity) {
            return b.effectiveAvailableQuantity - a.effectiveAvailableQuantity;
          }
          if (a.locationSortOrder !== b.locationSortOrder) {
            return a.locationSortOrder - b.locationSortOrder;
          }
          return a.locationCode.localeCompare(b.locationCode);
        });
      let remaining = input.requiredQuantity;
      const demandId = randomUUID();
      const selectedStockedLabels = new Set<string>();

      for (const bin of availableBins) {
        if (remaining <= 0) {
          break;
        }

        const quantityTarget = Math.min(bin.effectiveAvailableQuantity, remaining);
        if (quantityTarget <= 0) {
          continue;
        }

        for (const stockedLabel of bin.stockedLabels ?? []) {
          if (stockedLabel?.trim()) {
            selectedStockedLabels.add(stockedLabel.trim());
          }
        }

        routeSequence += 1;
        demandBinRows.push({
          tenantId: input.order.tenantId,
          basketId: params.basketId,
          demandId,
          warehouseId: bin.warehouseId,
          locationId: bin.locationId,
          variationId: input.line.variationId,
          quantityTarget,
          routeSequence,
        });
        plannedQuantityByLocation.set(
          bin.locationKey,
          (plannedQuantityByLocation.get(bin.locationKey) ?? 0) + quantityTarget,
        );
        remaining -= quantityTarget;
      }

      const baseProductName = typeof input.line.productName === 'string' && input.line.productName.trim().length > 0
        ? input.line.productName.trim()
        : null;
      const alternateLabels = Array.from(selectedStockedLabels).filter(
        (label) => !baseProductName || label.toLowerCase() !== baseProductName.toLowerCase(),
      );
      const demandProductName = baseProductName && alternateLabels.length > 0
        ? `${baseProductName} · Bin: ${alternateLabels.join(' / ')}`
        : input.line.productName;

      demandRows.push({
        id: demandId,
        tenantId: input.order.tenantId,
        storeId: input.order.storeId,
        basketId: params.basketId,
        fulfillmentOrderId: input.order.id,
        fulfillmentLineId: input.line.id,
        productId: input.line.productId,
        variationId: input.line.variationId,
        productName: demandProductName,
        productDisplayId: input.line.productDisplayId,
        quantityRequired: input.requiredQuantity,
      });

      if (remaining > 0) {
        const availableQuantity = input.requiredQuantity - remaining;
        throw new ConflictException(
          `Order ${input.order.posOrderId} needs ${input.requiredQuantity} ${input.line.productName}, but only ${availableQuantity} binned unit${availableQuantity === 1 ? '' : 's'} can be held`,
        );
      }
    }

    if (demandRows.length > 0) {
      await tx.wmsBasketPickDemand.createMany({ data: demandRows });
    }
    if (demandBinRows.length > 0) {
      await tx.wmsBasketPickDemandBin.createMany({ data: demandBinRows });
    }
  }

  private async getDemandPickBinAvailability(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      storeId: string;
      warehouseId: string;
      posWarehouseRef: string | null;
      variationId: string;
    },
    poolIndexParam?: TenantStockPoolIndex,
  ) {
    const poolIndex = poolIndexParam ?? await loadTenantStockPoolIndex(tx, params.tenantId);
    const poolMembers = poolIndex.getPoolMembers(params.storeId, params.variationId);
    const isPooled = poolMembers.length >= 2;
    const unitIdentityWhere = poolIndex.buildPooledUnitIdentityFilter({
      storeId: params.storeId,
      variationId: params.variationId,
      posWarehouseRef: params.posWarehouseRef,
      applyPosWarehouseFilterWhenUnpooled: true,
    });
    const scopedWhere: Prisma.WmsInventoryUnitWhereInput = {
      tenantId: params.tenantId,
      warehouseId: params.warehouseId,
      ...unitIdentityWhere,
      status: {
        in: [...FULFILLABLE_UNIT_STATUSES],
      },
      AND: [buildUnexpiredInventoryWhere()],
      currentLocationId: {
        not: null,
      },
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

    type AggregatedUnitGroup = {
      warehouseId: string;
      currentLocationId: string;
      count: number;
      earliestExpirationDate: Date | null;
      stockedLabels: Set<string>;
    };
    const aggregatedGroups = new Map<string, AggregatedUnitGroup>();

    if (isPooled) {
      const rawUnitGroups = await tx.wmsInventoryUnit.groupBy({
        by: ['warehouseId', 'currentLocationId', 'storeId', 'variationId'],
        where: scopedWhere,
        _count: {
          _all: true,
        },
        _min: {
          expirationDate: true,
        },
      });
      for (const group of rawUnitGroups) {
        if (!group.currentLocationId) {
          continue;
        }
        const aggKey = `${group.warehouseId}::${group.currentLocationId}`;
        const existing = aggregatedGroups.get(aggKey) ?? {
          warehouseId: group.warehouseId,
          currentLocationId: group.currentLocationId,
          count: 0,
          earliestExpirationDate: null,
          stockedLabels: new Set<string>(),
        };
        existing.count += group._count._all;
        const groupMinExp = group._min.expirationDate ?? null;
        if (
          groupMinExp
          && (!existing.earliestExpirationDate || groupMinExp.getTime() < existing.earliestExpirationDate.getTime())
        ) {
          existing.earliestExpirationDate = groupMinExp;
        }
        if (group.storeId && group.variationId) {
          const stockedMember = poolIndex.getTargetMember(group.storeId, group.variationId);
          if (stockedMember?.productName?.trim()) {
            existing.stockedLabels.add(stockedMember.productName.trim());
          }
        }
        aggregatedGroups.set(aggKey, existing);
      }
    } else {
      const rawUnitGroups = await tx.wmsInventoryUnit.groupBy({
        by: ['warehouseId', 'currentLocationId'],
        where: scopedWhere,
        _count: {
          _all: true,
        },
        _min: {
          expirationDate: true,
        },
      });
      for (const group of rawUnitGroups) {
        if (!group.currentLocationId) {
          continue;
        }
        aggregatedGroups.set(`${group.warehouseId}::${group.currentLocationId}`, {
          warehouseId: group.warehouseId,
          currentLocationId: group.currentLocationId,
          count: group._count._all,
          earliestExpirationDate: group._min.expirationDate ?? null,
          stockedLabels: new Set<string>(),
        });
      }
    }

    const unitGroups = Array.from(aggregatedGroups.values());
    const locationIds = unitGroups.map((group) => group.currentLocationId);

    if (locationIds.length === 0) {
      return [];
    }

    const [locations, heldBins] = await Promise.all([
      tx.wmsLocation.findMany({
        where: {
          id: {
            in: locationIds,
          },
        },
        select: {
          id: true,
          code: true,
          sortOrder: true,
        },
      }),
      tx.wmsBasketPickDemandBin.findMany({
        where: poolIndex.buildPooledDemandBinHoldWhere({
          tenantId: params.tenantId,
          storeId: params.storeId,
          variationId: params.variationId,
          warehouseId: params.warehouseId,
          locationIds,
          basketStatuses: ACTIVE_PICK_BASKET_STATUSES,
          orderStatuses: ACTIVE_BASKET_ORDER_STATUSES,
        }),
        select: {
          locationId: true,
          quantityTarget: true,
          quantityPicked: true,
        },
      }),
    ]);
    const locationById = new Map(locations.map((location) => [location.id, location]));
    const heldQuantityByLocation = heldBins.reduce((map, bin) => {
      map.set(
        bin.locationId,
        (map.get(bin.locationId) ?? 0) + Math.max((bin.quantityTarget ?? 0) - (bin.quantityPicked ?? 0), 0),
      );
      return map;
    }, new Map<string, number>());

    return unitGroups
      .map((group) => {
        const locationId = group.currentLocationId;
        const heldQuantity = heldQuantityByLocation.get(locationId) ?? 0;
        const availableQuantity = Math.max(
          group.count - heldQuantity,
          0,
        );
        const location = locationById.get(locationId);

        return {
          warehouseId: group.warehouseId,
          locationId,
          locationCode: location?.code ?? '',
          locationSortOrder: location?.sortOrder ?? 0,
          availableQuantity,
          earliestExpirationDate: group.earliestExpirationDate,
          stockedLabels: Array.from(group.stockedLabels),
        };
      })
      .filter((bin): bin is {
        warehouseId: string;
        locationId: string;
        locationCode: string;
        locationSortOrder: number;
        availableQuantity: number;
        earliestExpirationDate: Date | null;
        stockedLabels: string[];
      } => bin !== null && bin.availableQuantity > 0)
      .sort((a, b) => {
        const aExpiration = a.earliestExpirationDate?.getTime() ?? Number.POSITIVE_INFINITY;
        const bExpiration = b.earliestExpirationDate?.getTime() ?? Number.POSITIVE_INFINITY;
        if (aExpiration !== bExpiration) {
          return aExpiration - bExpiration;
        }

        if (b.availableQuantity !== a.availableQuantity) {
          return b.availableQuantity - a.availableQuantity;
        }

        if (a.locationSortOrder !== b.locationSortOrder) {
          return a.locationSortOrder - b.locationSortOrder;
        }

        return a.locationCode.localeCompare(b.locationCode);
      });
  }

  private buildDemandLocationKey(variationId: string, locationId: string) {
    return `${variationId}:${locationId}`;
  }

  private resolvePickTaskSelectionTenantIds(
    selectedTenantId: string | null,
    tenantOptions: MobileTenantOption[],
  ) {
    if (selectedTenantId) {
      return [selectedTenantId];
    }

    const availableTenantIds = Array.from(new Set(tenantOptions.map((tenant) => tenant.id)));
    if (availableTenantIds.length === 0) {
      throw new ForbiddenException('No partner is available for STOX picking');
    }

    return availableTenantIds;
  }

  async scanPickingUnit(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePickScanDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const order = await this.findPickingOrderForAction(user, id, body.tenantId, request);
    this.assertPickingTaskClaimedByUser(order, userId);
    this.assertPickingTaskHasBasket(order);

    const scannedCode = this.normalizeScannedCode(body.code);
    const allReservations = this.getAllPickReservations(order);
    const matchingReservation = allReservations.find((reservation) => (
      reservation.inventoryUnit.code === scannedCode
      || reservation.inventoryUnit.barcode === scannedCode
      || reservation.inventoryUnit.id === scannedCode
    ));

    if (!matchingReservation) {
      const scannedUnit = await this.findUnitByCode(scannedCode, order.tenantId);
      if (!scannedUnit) {
        throw new NotFoundException('Scanned unit was not found');
      }

      const requiredVariationIds = new Set(order.lines.map((line: any) => line.variationId));
      if (requiredVariationIds.has(scannedUnit.variationId)) {
        throw new BadRequestException(`Unit ${scannedUnit.code} is not reserved for this order. Resync the queue before picking it.`);
      }

      throw new BadRequestException(`Unit ${scannedUnit.code} is not one of the products required by this order`);
    }

    if (matchingReservation.status === WmsPickReservationStatus.PICKED) {
      throw new ConflictException(`Unit ${matchingReservation.inventoryUnit.code} was already picked for this order`);
    }

    if (matchingReservation.status !== WmsPickReservationStatus.RESERVED) {
      throw new BadRequestException(`Unit ${matchingReservation.inventoryUnit.code} is not active for picking`);
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.wmsPickReservation.update({
        where: { id: matchingReservation.id },
        data: {
          status: WmsPickReservationStatus.PICKED,
          pickedById: userId,
          pickedAt: now,
        },
      });

      await tx.wmsInventoryUnit.update({
        where: { id: matchingReservation.inventoryUnitId },
        data: {
          status: WmsInventoryUnitStatus.PICKED,
          currentLocationId: null,
          updatedById: userId || undefined,
        },
      });

      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: order.tenantId,
          inventoryUnitId: matchingReservation.inventoryUnitId,
          warehouseId: matchingReservation.inventoryUnit.warehouseId,
          fromLocationId: matchingReservation.inventoryUnit.currentLocationId,
          toLocationId: null,
          fromStatus: matchingReservation.inventoryUnit.status,
          toStatus: WmsInventoryUnitStatus.PICKED,
          movementType: WmsInventoryMovementType.PICK,
          referenceType: 'WMS_FULFILLMENT_ORDER',
          referenceId: order.id,
          referenceCode: order.posOrderId,
          notes: `STOX picked for order ${order.posOrderId}`,
          actorId: userId,
          createdAt: now,
        },
      });

      await this.refreshFulfillmentOrderState(tx, order.id, now);
      await this.refreshFulfillmentBasketState(tx, order.id, now);
    });

    await this.wmsFulfillmentSyncService.resolveFulfillmentAmendmentIfComplete(order.id);

    const updatedOrder = await this.findPickingOrderForAction(user, id, body.tenantId, request);

    await this.recordStockActivity(user, request, {
      tenantId: order.tenantId,
      actionType: 'PICKING_UNIT_SCAN',
      resourceType: 'WMS_INVENTORY_UNIT',
      resourceId: matchingReservation.inventoryUnitId,
      storeId: order.storeId,
      warehouseId: matchingReservation.inventoryUnit.warehouseId,
      metadata: {
        fulfillmentOrderId: order.id,
        fulfillmentLineId: matchingReservation.fulfillmentLineId,
        posOrderId: order.posOrderId,
        unitCode: matchingReservation.inventoryUnit.code,
      },
    });

    return {
      success: true,
      task: this.mapMobilePickingTask(updatedOrder),
    };
  }

  async getPickingBasketPlan(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePickScopedDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const basket = await this.findPickingBasketForAction(user, id, body.tenantId, request);
    this.assertPickingBasketAssignedToUser(basket, userId, { allowFullHeld: true });

    return {
      success: true,
      basket: this.mapMobilePickBasket(basket),
      tasks: this.mapMobileBasketTasks(basket),
      plan: this.buildMobileBasketPickPlan(basket),
    };
  }

  async scanPickingBasketBin(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePickScanDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const basket = await this.findPickingBasketForAction(user, id, body.tenantId, request);
    this.assertPickingBasketAssignedToUser(basket, userId);

    const location = await this.findLocationByCode(body.code, {
      warehouseId: basket.warehouseId ?? null,
      warehouseMismatchMessage: `Scanned bin belongs to another warehouse, not basket ${basket.barcode}`,
    });
    if (!location || location.kind !== WmsLocationKind.BIN) {
      throw new NotFoundException('Scanned code is not a WMS bin');
    }

    const plan = this.buildMobileBasketPickPlan(basket);
    const binGroup = plan.bins.find((group: any) => group.bin.id === location.id);
    if (!binGroup) {
      throw new BadRequestException(`Bin ${location.code} has no pending pick work in basket ${basket.barcode}`);
    }

    await this.recordStockActivity(user, request, {
      tenantId: basket.tenantId ?? null,
      actionType: 'PICKING_BASKET_BIN_SCAN',
      resourceType: 'WMS_LOCATION',
      resourceId: location.id,
      taskType: 'PICK',
      warehouseId: location.warehouse.id,
      metadata: {
        basketId: basket.id,
        basketCode: basket.barcode,
        pendingUnits: binGroup.pendingUnits,
        orderCount: binGroup.orderCount,
        ...(plan.mode === WmsFulfillmentAssignmentMode.BASKET_DEMAND ? { mode: 'BASKET_DEMAND' } : {}),
      },
    });

    return {
      success: true,
      bin: {
        id: location.id,
        code: location.code,
        name: location.name,
        kind: location.kind,
        warehouse: location.warehouse,
      },
      pendingUnits: binGroup.units,
      units: binGroup.units,
      plan,
    };
  }

  async scanPickingBasketUnit(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePickBasketUnitScanDto,
    request?: Request,
  ) {
    const scanStartedAt = Date.now();
    const useDeltaResponse = this.wantsBasketScanDeltaResponse(request);
    const userId = user.userId || user.id || null;
    let basket: any = useDeltaResponse
      ? await this.findPickingBasketForUnitScan(user, id, body.tenantId, request)
      : await this.findPickingBasketForAction(user, id, body.tenantId, request);
    if (useDeltaResponse && !this.isDemandPickingBasket(basket)) {
      basket = await this.findPickingBasketForAction(user, id, body.tenantId, request);
    }
    const initialBasketLoadMs = Date.now() - scanStartedAt;
    this.assertPickingBasketAssignedToUser(basket, userId, {
      allowFullHeld: useDeltaResponse,
    });

    const activeBin = await this.prisma.wmsLocation.findFirst({
      where: {
        id: body.binId,
        kind: WmsLocationKind.BIN,
        isActive: true,
        ...(basket.warehouseId ? { warehouseId: basket.warehouseId } : {}),
      },
      include: {
        warehouse: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
      },
    });
    if (!activeBin) {
      throw new NotFoundException('Active basket bin was not found');
    }

    const scannedCode = this.normalizeScannedCode(body.code);
    if (this.isDemandPickingBasket(basket)) {
      const scannedUnit = await this.findUnitByCode(scannedCode, basket.tenantId ?? null);
      if (!scannedUnit) {
        throw new NotFoundException('Scanned unit was not found');
      }

      if (basket.warehouseId && scannedUnit.warehouseId !== basket.warehouseId) {
        throw new BadRequestException(
          `Unit ${scannedUnit.code} belongs to ${scannedUnit.warehouse?.name ?? 'another warehouse'}, not basket ${basket.barcode}`,
        );
      }

      if (!(FULFILLABLE_UNIT_STATUSES as readonly WmsInventoryUnitStatus[]).includes(scannedUnit.status)) {
        const existingBasketUnit = await this.prisma.wmsBasketUnit.findFirst({
          where: {
            inventoryUnitId: scannedUnit.id,
            status: {
              in: [...ACTIVE_BASKET_UNIT_STATUSES],
            },
          },
          select: {
            basketId: true,
          },
        });
        if (existingBasketUnit?.basketId === basket.id) {
          if (useDeltaResponse) {
            return this.buildIdempotentBasketScanResult({
              basket,
              activeBin,
              scannedUnit,
            });
          }

          throw new ConflictException(`Unit ${scannedUnit.code} was already picked in basket ${basket.barcode}`);
        }

        throw new BadRequestException(`Unit ${scannedUnit.code} is ${this.formatEnumLabel(scannedUnit.status)} and cannot be picked`);
      }
      if (scannedUnit.currentLocationId !== activeBin.id) {
        throw new BadRequestException(
          `Unit ${scannedUnit.code} is in ${scannedUnit.currentLocation?.code ?? 'another bin'}, not ${activeBin.code}`,
        );
      }
      if (isExpiredInventoryDate(scannedUnit.expirationDate)) {
        throw new BadRequestException(`Unit ${scannedUnit.code} is expired and cannot be picked`);
      }

      const poolIndex = await loadTenantStockPoolIndex(this.prisma, scannedUnit.tenantId);
      const pendingDemandContexts = this.getBasketDemandPickContexts(basket)
        .filter((context: any) => (
          context.remainingQuantity > 0
          && context.order.tenantId === scannedUnit.tenantId
          && (
            (context.order.storeId === scannedUnit.storeId && context.demand.variationId === scannedUnit.variationId)
            || poolIndex.areStoreVariationsPooled(
              context.order.storeId,
              context.demand.variationId,
              scannedUnit.storeId,
              scannedUnit.variationId,
            )
          )
          && context.bin.location?.id === activeBin.id
        ))
        .sort((left: any, right: any) => {
          const seqDiff =
            (left.bin.routeSequence ?? Number.MAX_SAFE_INTEGER)
            - (right.bin.routeSequence ?? Number.MAX_SAFE_INTEGER);
          if (seqDiff !== 0) {
            return seqDiff;
          }
          const leftExact =
            left.order.storeId === scannedUnit.storeId && left.demand.variationId === scannedUnit.variationId
              ? 0
              : 1;
          const rightExact =
            right.order.storeId === scannedUnit.storeId && right.demand.variationId === scannedUnit.variationId
              ? 0
              : 1;
          if (leftExact !== rightExact) {
            return leftExact - rightExact;
          }
          return left.order.posOrderId.localeCompare(right.order.posOrderId);
        });

      if (pendingDemandContexts.length === 0) {
        const basketContexts = this.getBasketDemandPickContexts(basket)
          .filter((context: any) => context.remainingQuantity > 0);
        const hasRequiredVariationElsewhere = basketContexts.some((context: any) => (
          context.order.tenantId === scannedUnit.tenantId
          && (
            (context.order.storeId === scannedUnit.storeId && context.demand.variationId === scannedUnit.variationId)
            || poolIndex.areStoreVariationsPooled(
              context.order.storeId,
              context.demand.variationId,
              scannedUnit.storeId,
              scannedUnit.variationId,
            )
          )
        ));

        if (hasRequiredVariationElsewhere) {
          throw new BadRequestException(
            `Unit ${scannedUnit.code} is needed from another bin, not ${activeBin.code}`,
          );
        }

        throw new BadRequestException(
          `Unit ${scannedUnit.code} is not one of the pending products for basket ${basket.barcode}`,
        );
      }

      const now = new Date();
      const transactionStartedAt = Date.now();
      const executeTransaction = () => this.prisma.$transaction(async (tx) => {
        await this.lockBasketForUpdate(tx, basket.id);

        const activeBasketUnit = await tx.wmsBasketUnit.findFirst({
          where: {
            inventoryUnitId: scannedUnit.id,
            status: {
              in: [...ACTIVE_BASKET_UNIT_STATUSES],
            },
          },
          select: {
            basketId: true,
          },
        });
        if (activeBasketUnit) {
          if (activeBasketUnit.basketId === basket.id) {
            return {
              alreadyProcessed: true as const,
            };
          }

          throw new ConflictException(`Unit ${scannedUnit.code} is already held by another basket`);
        }

        const txPoolIndex = poolIndex.hasAnyPools
          ? poolIndex
          : await loadTenantStockPoolIndex(tx, scannedUnit.tenantId);
        const scopedPoolMembers = txPoolIndex.getPoolMembers(scannedUnit.storeId, scannedUnit.variationId);
        const demandBinIdentityWhere: Prisma.WmsBasketPickDemandBinWhereInput =
          scopedPoolMembers.length >= 2
            ? {
                OR: scopedPoolMembers.map((member) => ({
                  variationId: member.variationId,
                  demand: {
                    is: {
                      tenantId: scannedUnit.tenantId,
                      storeId: member.storeId,
                    },
                  },
                })),
              }
            : {
                variationId: scannedUnit.variationId,
                demand: {
                  is: {
                    tenantId: scannedUnit.tenantId,
                    storeId: scannedUnit.storeId,
                  },
                },
              };

        const scopedDemandBins = await tx.wmsBasketPickDemandBin.findMany({
          where: {
            basketId: basket.id,
            locationId: activeBin.id,
            ...demandBinIdentityWhere,
          },
          include: {
            demand: {
              select: {
                id: true,
                storeId: true,
                fulfillmentOrderId: true,
                fulfillmentLineId: true,
                fulfillmentOrder: {
                  select: {
                    id: true,
                    posOrderId: true,
                  },
                },
              },
            },
          },
          orderBy: [
            { routeSequence: 'asc' },
            { createdAt: 'asc' },
          ],
        });
        const scopedBin = scopedDemandBins
          .filter((candidate) => candidate.quantityPicked < candidate.quantityTarget)
          .sort((left, right) => {
            if (left.routeSequence !== right.routeSequence) {
              return left.routeSequence - right.routeSequence;
            }
            const leftDemandStoreId = left.demand.storeId ?? scannedUnit.storeId;
            const rightDemandStoreId = right.demand.storeId ?? scannedUnit.storeId;
            const leftExact =
              leftDemandStoreId === scannedUnit.storeId && left.variationId === scannedUnit.variationId
                ? 0
                : 1;
            const rightExact =
              rightDemandStoreId === scannedUnit.storeId && right.variationId === scannedUnit.variationId
                ? 0
                : 1;
            if (leftExact !== rightExact) {
              return leftExact - rightExact;
            }
            return left.demand.fulfillmentOrder.posOrderId.localeCompare(right.demand.fulfillmentOrder.posOrderId);
          })[0];
        if (!scopedBin) {
          throw new ConflictException(`Bin ${activeBin.code} no longer needs ${scannedUnit.code}`);
        }

        const targetDemandStoreId = scopedBin.demand.storeId ?? scannedUnit.storeId;
        const needsPoolReassignment =
          scannedUnit.storeId !== targetDemandStoreId
          || scannedUnit.variationId !== scopedBin.variationId;
        const targetPoolMember = needsPoolReassignment
          ? txPoolIndex.getTargetMember(targetDemandStoreId, scopedBin.variationId)
          : null;
        if (needsPoolReassignment && !targetPoolMember) {
          throw new ConflictException(
            `Shared stock pool target profile was not found for order ${scopedBin.demand.fulfillmentOrder.posOrderId}`,
          );
        }

        const inventoryUpdate = await tx.wmsInventoryUnit.updateMany({
          where: {
            id: scannedUnit.id,
            warehouseId: basket.warehouseId ?? scannedUnit.warehouseId,
            currentLocationId: activeBin.id,
            status: {
              in: [...FULFILLABLE_UNIT_STATUSES],
            },
            AND: [buildUnexpiredInventoryWhere()],
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
          data: {
            status: WmsInventoryUnitStatus.PICKED,
            currentLocationId: null,
            updatedById: userId || undefined,
            ...(targetPoolMember
              ? {
                  storeId: targetPoolMember.storeId,
                  posProductId: targetPoolMember.posProductId,
                  productProfileId: targetPoolMember.profileId,
                  productId: targetPoolMember.productId,
                  variationId: targetPoolMember.variationId,
                  posWarehouseRef:
                    scannedUnit.storeId === targetPoolMember.storeId
                      ? null
                      : (targetPoolMember.posWarehouseRef ?? null),
                }
              : {}),
          },
        });

        if (inventoryUpdate.count !== 1) {
          const concurrentBasketUnit = await tx.wmsBasketUnit.findFirst({
            where: {
              inventoryUnitId: scannedUnit.id,
              status: {
                in: [...ACTIVE_BASKET_UNIT_STATUSES],
              },
            },
            select: {
              basketId: true,
            },
          });
          if (concurrentBasketUnit?.basketId === basket.id) {
            return {
              alreadyProcessed: true as const,
            };
          }

          throw new ConflictException(`Unit ${scannedUnit.code} changed before this scan completed`);
        }

        await tx.wmsBasketUnit.create({
          data: {
            tenantId: scannedUnit.tenantId,
            storeId: targetPoolMember?.storeId ?? scannedUnit.storeId,
            basketId: basket.id,
            inventoryUnitId: scannedUnit.id,
            warehouseId: scannedUnit.warehouseId,
            sourceLocationId: activeBin.id,
            productId: targetPoolMember?.productId ?? scannedUnit.productId,
            variationId: targetPoolMember?.variationId ?? scannedUnit.variationId,
            fulfillmentOrderId: scopedBin.demand.fulfillmentOrderId,
            fulfillmentLineId: scopedBin.demand.fulfillmentLineId,
            status: WmsBasketUnitStatus.PICKED,
            pickedById: userId || undefined,
          },
        });

        await tx.wmsBasketPickDemandBin.update({
          where: {
            id: scopedBin.id,
          },
          data: {
            quantityPicked: {
              increment: 1,
            },
          },
        });

        await tx.wmsBasketPickDemand.update({
          where: {
            id: scopedBin.demand.id,
          },
          data: {
            quantityPicked: {
              increment: 1,
            },
          },
        });

        if (targetPoolMember) {
          await tx.wmsInventoryMovement.create({
            data: {
              tenantId: scannedUnit.tenantId,
              inventoryUnitId: scannedUnit.id,
              warehouseId: scannedUnit.warehouseId,
              fromLocationId: activeBin.id,
              toLocationId: activeBin.id,
              fromStatus: scannedUnit.status,
              toStatus: scannedUnit.status,
              movementType: WmsInventoryMovementType.ADJUSTMENT,
              referenceType: 'SHARED_STOCK_POOL',
              referenceId: scopedBin.demand.fulfillmentOrderId,
              referenceCode: scopedBin.demand.fulfillmentOrder.posOrderId,
              notes: `Auto-assigned from shared stock pool on pick (${scannedUnit.variationId} -> ${targetPoolMember.variationId})`,
              actorId: userId,
              createdAt: now,
            },
          });
        }

        await tx.wmsInventoryMovement.create({
          data: {
            tenantId: scannedUnit.tenantId,
            inventoryUnitId: scannedUnit.id,
            warehouseId: scannedUnit.warehouseId,
            fromLocationId: activeBin.id,
            toLocationId: null,
            fromStatus: scannedUnit.status,
            toStatus: WmsInventoryUnitStatus.PICKED,
            movementType: WmsInventoryMovementType.PICK,
            referenceType: 'WMS_BASKET',
            referenceId: basket.id,
            referenceCode: basket.barcode,
            notes: `STOX basket ${basket.barcode} picked from ${activeBin.code}`,
            actorId: userId,
            createdAt: now,
          },
        });

        await this.refreshFulfillmentOrderState(tx, scopedBin.demand.fulfillmentOrderId, now);
        await this.refreshFulfillmentBasketState(
          tx,
          scopedBin.demand.fulfillmentOrderId,
          now,
          {
            basketAlreadyLocked: true,
            cleanupOrphans: false,
          },
        );

        const [updatedOrder, updatedBasketState, binTotals] = await Promise.all([
          tx.wmsFulfillmentOrder.findUniqueOrThrow({
            where: { id: scopedBin.demand.fulfillmentOrderId },
            select: {
              id: true,
              status: true,
              totalQuantity: true,
              allocatedQuantity: true,
              pickedQuantity: true,
              lines: {
                where: { id: scopedBin.demand.fulfillmentLineId },
                select: {
                  id: true,
                  status: true,
                  quantityRequired: true,
                  quantityAllocated: true,
                  quantityPicked: true,
                },
              },
            },
          }),
          tx.wmsBasket.findUniqueOrThrow({
            where: { id: basket.id },
            select: { status: true },
          }),
          tx.wmsBasketPickDemandBin.aggregate({
            where: {
              basketId: basket.id,
              locationId: activeBin.id,
            },
            _sum: {
              quantityTarget: true,
              quantityPicked: true,
            },
          }),
        ]);
        const updatedLine = updatedOrder.lines[0] ?? null;
        const binRequired = Math.max(binTotals._sum.quantityTarget ?? 0, 0);
        const binPicked = Math.min(Math.max(binTotals._sum.quantityPicked ?? 0, 0), binRequired);

        return {
          alreadyProcessed: false as const,
          basketStatus: updatedBasketState.status,
          taskId: updatedOrder.id,
          lineId: updatedLine?.id ?? scopedBin.demand.fulfillmentLineId,
          demandId: scopedBin.demand.id,
          effectiveVariationId: targetPoolMember?.variationId ?? scannedUnit.variationId,
          order: {
            required: updatedOrder.totalQuantity,
            allocated: updatedOrder.allocatedQuantity,
            picked: updatedOrder.pickedQuantity,
            remaining: Math.max(updatedOrder.totalQuantity - updatedOrder.pickedQuantity, 0),
            status: updatedOrder.status,
          },
          line: updatedLine
            ? {
                required: updatedLine.quantityRequired,
                allocated: updatedLine.quantityAllocated,
                picked: updatedLine.quantityPicked,
                remaining: Math.max(updatedLine.quantityRequired - updatedLine.quantityPicked, 0),
                status: updatedLine.status,
              }
            : null,
          bin: {
            required: binRequired,
            picked: binPicked,
            remaining: Math.max(binRequired - binPicked, 0),
          },
        };
      }, {
        maxWait: 3000,
        timeout: 10000,
      });
      let transactionResult: Awaited<ReturnType<typeof executeTransaction>>;
      try {
        transactionResult = await executeTransaction();
      } catch (error) {
        const transactionMs = Date.now() - transactionStartedAt;
        this.logger.error(
          `STOX basket scan failed basket=${basket.id} unit=${scannedUnit.id} initial_load_ms=${initialBasketLoadMs} transaction_ms=${transactionMs} total_ms=${Date.now() - scanStartedAt}`,
          error instanceof Error ? error.stack : String(error),
        );
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
          throw new ConflictException('Basket changed while this unit was being scanned. Please retry.');
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028') {
          throw new ServiceUnavailableException('Basket scan timed out while waiting for inventory. Please retry.');
        }
        throw error;
      }
      const transactionMs = Date.now() - transactionStartedAt;

      if (transactionResult.taskId) {
        await this.wmsFulfillmentSyncService.resolveFulfillmentAmendmentIfComplete(
          transactionResult.taskId,
        );
      }

      if (transactionResult.alreadyProcessed) {
        if (useDeltaResponse) {
          return this.buildIdempotentBasketScanResult({
            basket,
            activeBin,
            scannedUnit,
          });
        }

        throw new ConflictException(`Unit ${scannedUnit.code} was already picked in basket ${basket.barcode}`);
      }

      void this.recordStockActivity(user, request, {
        tenantId: scannedUnit.tenantId,
        actionType: 'PICKING_BASKET_UNIT_SCAN',
        resourceType: 'WMS_INVENTORY_UNIT',
        resourceId: scannedUnit.id,
        taskType: 'PICK',
        storeId: scannedUnit.storeId,
        warehouseId: scannedUnit.warehouseId,
        metadata: {
          basketId: basket.id,
          basketCode: basket.barcode,
          binCode: activeBin.code,
          fulfillmentOrderId: transactionResult.taskId,
          fulfillmentLineId: transactionResult.lineId,
          unitCode: scannedUnit.code,
          mode: 'BASKET_DEMAND',
        },
      });

      const totalMs = Date.now() - scanStartedAt;
      const timingMessage = `STOX basket scan basket=${basket.id} unit=${scannedUnit.id} initial_load_ms=${initialBasketLoadMs} transaction_ms=${transactionMs} total_ms=${totalMs}`;
      if (totalMs >= 2000) {
        this.logger.warn(timingMessage);
      } else {
        this.logger.debug(timingMessage);
      }

      if (!useDeltaResponse) {
        const updatedBasket = await this.findPickingBasketForAction(user, id, body.tenantId, request);
        const updatedTasks = this.mapMobileBasketTasks(updatedBasket);
        const updatedTask = updatedTasks.find((task: any) => task.id === transactionResult.taskId)
          ?? updatedTasks[0]
          ?? null;
        const updatedContext = this.getBasketDemandPickContexts(updatedBasket).find((context: any) => (
          context.demand.id === transactionResult.demandId
          && context.bin.id === activeBin.id
        )) ?? pendingDemandContexts[0];

        return {
          success: true,
          basket: this.mapMobilePickBasket(updatedBasket),
          task: updatedTask,
          tasks: updatedTasks,
          pickedUnit: this.mapMobileBasketPickDemandUnit(updatedContext),
          plan: this.buildMobileBasketPickPlan(updatedBasket),
        };
      }

      return {
        success: true,
        alreadyProcessed: false,
        requiresRefresh: transactionResult.bin.remaining === 0 || transactionResult.order.remaining === 0,
        basketId: basket.id,
        basketStatus: transactionResult.basketStatus,
        taskId: transactionResult.taskId,
        lineId: transactionResult.lineId,
        demandId: transactionResult.demandId,
        binId: activeBin.id,
        pickedUnit: {
          id: scannedUnit.id,
          code: scannedUnit.code,
          barcode: scannedUnit.barcode,
          variationId: transactionResult.effectiveVariationId,
        },
        counters: {
          order: transactionResult.order,
          line: transactionResult.line,
          bin: transactionResult.bin,
        },
        currentBinComplete: transactionResult.bin.remaining === 0,
        orderComplete: transactionResult.order.remaining === 0,
      };
    }

    const contexts = this.getBasketPickReservationContexts(basket);
    const matchingContext = contexts.find(({ reservation }) => (
      reservation.inventoryUnit.code === scannedCode
      || reservation.inventoryUnit.barcode === scannedCode
      || reservation.inventoryUnit.id === scannedCode
    ));

    if (!matchingContext) {
      const scannedUnit = await this.findUnitByCode(scannedCode, null);
      if (!scannedUnit) {
        throw new NotFoundException('Scanned unit was not found');
      }

      throw new BadRequestException(`Unit ${scannedUnit.code} is not reserved in basket ${basket.barcode}`);
    }

    const { order, reservation } = matchingContext;
    if (reservation.status === WmsPickReservationStatus.PICKED) {
      throw new ConflictException(`Unit ${reservation.inventoryUnit.code} was already picked for order ${order.posOrderId}`);
    }

    if (reservation.status !== WmsPickReservationStatus.RESERVED) {
      throw new BadRequestException(`Unit ${reservation.inventoryUnit.code} is not active for picking`);
    }
    if (isExpiredInventoryDate(reservation.inventoryUnit.expirationDate)) {
      throw new BadRequestException(
        `Unit ${reservation.inventoryUnit.code} is expired and cannot be picked`,
      );
    }
    if (
      reservation.inventoryUnit.productProfile.requiresExpirationDate
      && !reservation.inventoryUnit.expirationDate
    ) {
      throw new BadRequestException(
        `Unit ${reservation.inventoryUnit.code} requires an expiration date and cannot be picked`,
      );
    }

    if (reservation.inventoryUnit.currentLocationId !== activeBin.id) {
      throw new BadRequestException(
        `Unit ${reservation.inventoryUnit.code} is reserved in ${reservation.inventoryUnit.currentLocation?.code ?? 'another bin'}, not ${activeBin.code}`,
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const reservationResult = await tx.wmsPickReservation.updateMany({
        where: {
          id: reservation.id,
          status: WmsPickReservationStatus.RESERVED,
        },
        data: {
          status: WmsPickReservationStatus.PICKED,
          pickedById: userId,
          pickedAt: now,
        },
      });

      if (reservationResult.count !== 1) {
        throw new ConflictException(`Unit ${reservation.inventoryUnit.code} was already picked or changed before scan`);
      }

      await tx.wmsInventoryUnit.update({
        where: { id: reservation.inventoryUnitId },
        data: {
          status: WmsInventoryUnitStatus.PICKED,
          currentLocationId: null,
          updatedById: userId || undefined,
        },
      });

      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: order.tenantId,
          inventoryUnitId: reservation.inventoryUnitId,
          warehouseId: reservation.inventoryUnit.warehouseId,
          fromLocationId: reservation.inventoryUnit.currentLocationId,
          toLocationId: null,
          fromStatus: reservation.inventoryUnit.status,
          toStatus: WmsInventoryUnitStatus.PICKED,
          movementType: WmsInventoryMovementType.PICK,
          referenceType: 'WMS_FULFILLMENT_ORDER',
          referenceId: order.id,
          referenceCode: order.posOrderId,
          notes: `STOX basket ${basket.barcode} picked for order ${order.posOrderId}`,
          actorId: userId,
          createdAt: now,
        },
      });

      await this.refreshFulfillmentOrderState(tx, order.id, now);
      await this.refreshFulfillmentBasketState(tx, order.id, now);
    });

    const updatedBasket = await this.findPickingBasketForAction(user, id, body.tenantId, request);
    const updatedTasks = this.mapMobileBasketTasks(updatedBasket);
    const updatedTask = updatedTasks.find((task: any) => task.id === order.id) ?? updatedTasks[0] ?? null;

    await this.recordStockActivity(user, request, {
      tenantId: order.tenantId,
      actionType: 'PICKING_BASKET_UNIT_SCAN',
      resourceType: 'WMS_INVENTORY_UNIT',
      resourceId: reservation.inventoryUnitId,
      taskType: 'PICK',
      storeId: order.storeId,
      warehouseId: reservation.inventoryUnit.warehouseId,
      metadata: {
        basketId: basket.id,
        basketCode: basket.barcode,
        binCode: activeBin.code,
        fulfillmentOrderId: order.id,
        fulfillmentLineId: reservation.fulfillmentLineId,
        posOrderId: order.posOrderId,
        unitCode: reservation.inventoryUnit.code,
      },
    });

    return {
      success: true,
      basket: this.mapMobilePickBasket(updatedBasket),
      task: updatedTask,
      tasks: updatedTasks,
      pickedUnit: this.mapMobilePickReservation({
        ...reservation,
        status: WmsPickReservationStatus.PICKED,
        pickedAt: now,
      }),
      plan: this.buildMobileBasketPickPlan(updatedBasket),
    };
  }

  async lookupPickingBasket(
    user: BootstrapUser,
    query: GetWmsMobilePickBasketLookupDto,
    request?: Request,
  ) {
    const basketCode = this.normalizeScannedCode(query.code);
    const tenantContext = await this.resolveMobileStockContext(user, { tenantId: query.tenantId }, request);
    const basket = await this.prisma.wmsBasket.findUnique({
      where: { barcode: basketCode },
      include: this.mobileBasketInclude(),
    });
    const scopedBasket = basket && tenantContext.tenantId && basket.tenantId && basket.tenantId !== tenantContext.tenantId
      ? null
      : basket;
    const scopedBasketOrder = Array.isArray(scopedBasket?.fulfillmentOrders)
      ? scopedBasket.fulfillmentOrders[0] ?? null
      : null;

    await this.recordStockActivity(user, request, {
      tenantId: scopedBasket?.tenantId ?? tenantContext.tenantId,
      actionType: 'PICKING_BASKET_LOOKUP',
      resourceType: 'WMS_BASKET',
      resourceId: scopedBasket?.id ?? null,
      storeId: scopedBasketOrder?.storeId ?? null,
      warehouseId: scopedBasket?.warehouseId ?? scopedBasketOrder?.warehouseId ?? null,
      metadata: {
        basketCode,
        found: Boolean(scopedBasket),
        ...(scopedBasket && this.isDemandPickingBasket(scopedBasket) ? { mode: 'BASKET_DEMAND' } : {}),
      },
    });

    return {
      found: Boolean(scopedBasket),
      basket: scopedBasket ? this.mapMobileBasketLookup(scopedBasket) : null,
    };
  }

  async returnFulfillmentReworkUnit(
    user: BootstrapUser,
    basketId: string,
    orderId: string,
    body: WmsMobileFulfillmentReworkReturnDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }
    const basket = await this.findPickingBasketForAction(user, basketId, body.tenantId, request);
    const order = (basket.fulfillmentOrders ?? []).find((candidate: any) => candidate.id === orderId);
    if (!order) {
      throw new NotFoundException('The changed order is no longer inside this basket');
    }
    if (this.resolveFulfillmentOrderItemChange(order)?.detachment) {
      throw new ConflictException('This order is being detached. Use the validated bin-and-unit return steps shown in STOX.');
    }

    const result = await this.wmsFulfillmentSyncService.returnAmendmentBasketUnit({
      tenantId: order.tenantId,
      fulfillmentOrderId: order.id,
      basketId: basket.id,
      code: this.normalizeScannedCode(body.code),
      actorId: userId,
    });
    const updatedBasket = await this.findPickingBasketForAction(user, basket.id, body.tenantId, request);
    const updatedTask = this.getMobileBasketOrders(updatedBasket).find((candidate: any) => candidate.id === order.id);

    await this.recordStockActivity(user, request, {
      tenantId: order.tenantId,
      actionType: 'FULFILLMENT_AMENDMENT_RETURN',
      resourceType: 'WMS_INVENTORY_UNIT',
      resourceId: result.unit.id,
      taskType: 'PICK',
      storeId: order.storeId,
      warehouseId: order.warehouseId,
      metadata: {
        fulfillmentOrderId: order.id,
        posOrderId: order.posOrderId,
        basketId: basket.id,
        basketCode: basket.barcode,
        unitCode: result.unit.code,
        variationId: result.unit.variationId,
      },
    });

    return {
      success: true,
      returnedUnit: result.unit,
      task: updatedTask ? this.mapMobilePickingTask(updatedTask) : null,
      basket: this.mapMobilePickBasket(updatedBasket),
      plan: this.buildMobileBasketPickPlan(updatedBasket),
    };
  }

  async startFulfillmentOrderDetachment(
    user: BootstrapUser,
    basketId: string,
    orderId: string,
    body: WmsMobileFulfillmentDetachStartDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    const basket = await this.findPickingBasketForRepairAction(user, basketId, body.tenantId, request);
    this.assertDemandPickBasketVoidable(basket);
    const scopedOrder = this.getMobileBasketOrders(basket).find((candidate: any) => candidate.id === orderId);
    if (!scopedOrder) {
      throw new NotFoundException('The changed order is no longer inside this basket');
    }
    if (body.confirmPosOrderId.trim() !== scopedOrder.posOrderId) {
      throw new BadRequestException(`Type order ${scopedOrder.posOrderId} exactly to confirm detachment`);
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockBasketForUpdate(tx, basket.id);
      const lockedBasket = await tx.wmsBasket.findUnique({
        where: { id: basket.id },
        select: { status: true },
      });
      if (
        !lockedBasket
        || !PICKER_ACTIVE_BASKET_STATUS_SET.has(lockedBasket.status)
      ) {
        throw new ConflictException('The basket changed state. Refresh before detaching this order.');
      }
      await tx.$queryRaw`SELECT "id" FROM "wms_fulfillment_orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;

      const order = await tx.wmsFulfillmentOrder.findFirst({
        where: {
          id: orderId,
          basketId: basket.id,
          tenantId: scopedOrder.tenantId,
        },
        include: {
          basket: {
            select: {
              id: true,
              barcode: true,
              status: true,
            },
          },
          lines: {
            orderBy: [{ createdAt: 'asc' }],
          },
          basketPickDemands: {
            include: {
              bins: true,
            },
          },
          amendments: {
            where: { status: WmsFulfillmentAmendmentStatus.OPEN },
            orderBy: { detectedAt: 'desc' },
            take: 1,
          },
        },
      });
      if (!order || !order.basket) {
        throw new NotFoundException('The changed order is no longer inside this basket');
      }
      if (order.assignmentMode !== WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
        throw new BadRequestException('Order detachment is only available for basket-demand picking');
      }
      if (order.status !== WmsFulfillmentOrderStatus.IN_PICKING) {
        throw new ConflictException(`Order ${order.posOrderId} is ${this.formatEnumLabel(order.status)} and cannot be detached from picking`);
      }
      if (order.changeState !== WmsFulfillmentChangeState.PICK_REWORK_REQUIRED) {
        throw new ConflictException(`Order ${order.posOrderId} does not have an active Pick rework`);
      }
      if (order.sourceRevision !== body.expectedSourceRevision) {
        throw new ConflictException('The POS order changed again. Refresh the basket before confirming detachment.');
      }

      const amendment = order.amendments[0];
      if (!amendment) {
        throw new ConflictException('The open POS order amendment was not found');
      }
      const requiredActions = this.asJsonRecord(amendment.requiredActions) ?? {};
      const existingDetachment = this.asJsonRecord(requiredActions.detach);
      if (existingDetachment?.status === 'RETURNING') {
        return {
          detached: false,
          alreadyStarted: true,
          tenantId: order.tenantId,
          storeId: order.storeId,
          warehouseId: order.warehouseId,
          posOrderId: order.posOrderId,
          variationIds: order.lines.map((line) => line.variationId),
        };
      }

      const pickActions = this.readFulfillmentReworkActions({
        raw: requiredActions.pick,
        fallbackChanges: [],
        fallbackTotal: 0,
      });
      const hasUnavailableAddedUnit = pickActions.some((action) => (
        action.quantity > 0
        && order.lines.some((line) => (
          line.variationId === action.variationId
          && line.status !== WmsFulfillmentLineStatus.CANCELED
          && line.quantityAllocated < line.quantityRequired
        ))
      ));
      if (!hasUnavailableAddedUnit) {
        throw new ConflictException('This order still has an allocated pick path. Retry or complete the highlighted pick before detaching it.');
      }

      const returnActions = this.readFulfillmentReworkActions({
        raw: requiredActions.return,
        fallbackChanges: [],
        fallbackTotal: 0,
      });
      const quantityByVariation = new Map<string, number>();
      for (const demand of order.basketPickDemands) {
        if (demand.quantityPicked > 0) {
          quantityByVariation.set(
            demand.variationId,
            (quantityByVariation.get(demand.variationId) ?? 0) + demand.quantityPicked,
          );
        }
      }
      for (const action of returnActions) {
        quantityByVariation.set(
          action.variationId,
          (quantityByVariation.get(action.variationId) ?? 0) + action.quantity,
        );
      }

      const basketUnits = await tx.wmsBasketUnit.findMany({
        where: {
          basketId: basket.id,
          status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] },
          OR: [
            { fulfillmentOrderId: order.id },
            { fulfillmentOrderId: null },
          ],
        },
        include: {
          inventoryUnit: {
            select: {
              id: true,
              code: true,
              barcode: true,
              status: true,
            },
          },
          sourceLocation: {
            select: {
              id: true,
              code: true,
              barcode: true,
              name: true,
              kind: true,
            },
          },
        },
        orderBy: [
          { pickedAt: 'asc' },
          { createdAt: 'asc' },
        ],
      });
      const competingPickedDemands = await tx.wmsBasketPickDemand.findMany({
        where: {
          basketId: basket.id,
          fulfillmentOrderId: { not: order.id },
          quantityPicked: { gt: 0 },
        },
        select: { variationId: true },
        distinct: ['variationId'],
      });
      const competingPickedVariations = new Set(
        competingPickedDemands.map((demand) => demand.variationId),
      );
      const lineByVariation = new Map(order.lines.map((line) => [line.variationId, line]));
      const selectedBasketUnitIds = new Set<string>();
      const detachUnits: Array<Record<string, unknown>> = [];

      for (const [variationId, quantity] of quantityByVariation) {
        const candidates = basketUnits
          .filter((basketUnit) => (
            basketUnit.variationId === variationId
            && !selectedBasketUnitIds.has(basketUnit.id)
          ))
          .sort((left, right) => (
            Number(right.fulfillmentOrderId === order.id) - Number(left.fulfillmentOrderId === order.id)
          ));
        const selected = candidates.slice(0, quantity);
        if (selected.length !== quantity) {
          throw new ConflictException(
            `WMS could identify only ${selected.length} of ${quantity} picked ${lineByVariation.get(variationId)?.productName ?? 'item'} unit(s). Refresh inventory links before detaching.`,
          );
        }
        if (
          selected.some((basketUnit) => !basketUnit.fulfillmentOrderId)
          && competingPickedVariations.has(variationId)
        ) {
          throw new ConflictException(
            `WMS cannot safely identify which ${lineByVariation.get(variationId)?.productName ?? 'item'} serial belongs to this order because another order in the basket has the same item. Repair the legacy basket-unit links before detaching.`,
          );
        }

        for (const basketUnit of selected) {
          if (!basketUnit.sourceLocation || basketUnit.sourceLocation.kind !== WmsLocationKind.BIN) {
            throw new ConflictException(
              `Unit ${basketUnit.inventoryUnit.code} has no original pick bin. Repair its basket history before detaching this order.`,
            );
          }
          selectedBasketUnitIds.add(basketUnit.id);
          const line = lineByVariation.get(variationId);
          detachUnits.push({
            basketUnitId: basketUnit.id,
            inventoryUnitId: basketUnit.inventoryUnitId,
            variationId,
            productId: basketUnit.productId,
            productName: line?.productName ?? 'Picked item',
            productDisplayId: line?.productDisplayId ?? null,
            code: basketUnit.inventoryUnit.code,
            barcode: basketUnit.inventoryUnit.barcode,
            destinationBin: {
              id: basketUnit.sourceLocation.id,
              code: basketUnit.sourceLocation.code,
              barcode: basketUnit.sourceLocation.barcode,
              name: basketUnit.sourceLocation.name,
              kind: basketUnit.sourceLocation.kind,
            },
            returnedAt: null,
          });
        }
      }

      const detachment = {
        status: detachUnits.length > 0 ? 'RETURNING' : 'COMPLETED',
        reason: body.reason.trim(),
        confirmedAt: now.toISOString(),
        confirmedById: userId,
        sourceRevision: order.sourceRevision,
        units: detachUnits,
      };
      const nextRequiredActions = {
        ...requiredActions,
        detach: detachment,
      };

      await tx.wmsBasketPickDemandBin.updateMany({
        where: {
          basketId: basket.id,
          demand: { fulfillmentOrderId: order.id },
        },
        data: {
          quantityTarget: 0,
          quantityPicked: 0,
        },
      });

      const currentSummary = this.asJsonRecord(order.changeSummary) ?? {};
      await tx.wmsFulfillmentAmendment.update({
        where: { id: amendment.id },
        data: { requiredActions: nextRequiredActions as Prisma.InputJsonValue },
      });
      await tx.wmsFulfillmentOrder.update({
        where: { id: order.id },
        data: {
          changeSummary: {
            ...currentSummary,
            notificationTitle: 'Order detachment confirmed',
            message: detachUnits.length > 0
              ? `Return the listed units to their validated bins. Order ${order.posOrderId} will detach automatically after the last scan.`
              : `Order ${order.posOrderId} was detached and returned to fulfillment restocking.`,
            detachmentRemainingUnits: detachUnits.length,
          } as Prisma.InputJsonValue,
        },
      });

      if (detachUnits.length === 0) {
        await this.finalizeFulfillmentOrderDetachmentTx(tx, {
          order,
          amendmentId: amendment.id,
          requiredActions: nextRequiredActions,
          detachment,
          basketId: basket.id,
          basketCode: basket.barcode,
          actorId: userId,
          now,
        });
      }

      return {
        detached: detachUnits.length === 0,
        alreadyStarted: false,
        tenantId: order.tenantId,
        storeId: order.storeId,
        warehouseId: order.warehouseId,
        posOrderId: order.posOrderId,
        variationIds: order.lines.map((line) => line.variationId),
      };
    }, {
      maxWait: 3000,
      timeout: 15000,
    });

    if (result.detached) {
      await this.wmsFulfillmentSyncService.refreshDemandQueueForScope({
        tenantId: result.tenantId,
        storeId: result.storeId,
        variationIds: result.variationIds,
      });
    }

    const [updatedOrder, updatedBasket] = await Promise.all([
      this.prisma.wmsFulfillmentOrder.findUnique({
        where: { id: orderId },
        include: this.pickingTaskInclude(),
      }),
      this.prisma.wmsBasket.findUnique({
        where: { id: basket.id },
        include: this.mobileBasketInclude(),
      }),
    ]);

    await this.recordStockActivity(user, request, {
      tenantId: result.tenantId,
      actionType: result.detached ? 'FULFILLMENT_ORDER_DETACHED' : 'FULFILLMENT_ORDER_DETACH_CONFIRMED',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: orderId,
      taskType: 'PICK',
      storeId: result.storeId,
      warehouseId: result.warehouseId,
      metadata: {
        basketId: basket.id,
        basketCode: basket.barcode,
        posOrderId: result.posOrderId,
        reason: body.reason.trim(),
        alreadyStarted: result.alreadyStarted,
      },
    });

    return {
      success: true,
      detached: result.detached,
      alreadyStarted: result.alreadyStarted,
      task: updatedOrder ? this.mapMobilePickingTask(updatedOrder) : null,
      basket: updatedBasket ? this.mapMobilePickBasket(updatedBasket) : null,
      plan: updatedBasket ? this.buildMobileBasketPickPlan(updatedBasket) : null,
    };
  }

  async returnDetachedFulfillmentUnit(
    user: BootstrapUser,
    basketId: string,
    orderId: string,
    body: WmsMobileFulfillmentDetachReturnDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }
    const basket = await this.findPickingBasketForAction(user, basketId, body.tenantId, request);
    if (!PICKER_ACTIVE_BASKET_STATUS_SET.has(basket.status)) {
      throw new BadRequestException(
        `Basket ${basket.barcode} is ${this.formatEnumLabel(basket.status)} and cannot accept item returns`,
      );
    }
    if (basket.assignedPickerId !== userId) {
      await this.assertPickSupervisorAccess(user);
    }
    const scopedOrder = this.getMobileBasketOrders(basket).find((candidate: any) => candidate.id === orderId);
    if (!scopedOrder) {
      throw new NotFoundException('The detaching order is no longer inside this basket');
    }

    const unitCode = this.normalizeScannedCode(body.code);
    const binCode = this.normalizeScannedCode(body.binCode);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockBasketForUpdate(tx, basket.id);
      const lockedBasket = await tx.wmsBasket.findUnique({
        where: { id: basket.id },
        select: { assignedPickerId: true, status: true },
      });
      if (
        !lockedBasket
        || !PICKER_ACTIVE_BASKET_STATUS_SET.has(lockedBasket.status)
        || lockedBasket.assignedPickerId !== basket.assignedPickerId
      ) {
        throw new ConflictException('The basket assignment changed. Refresh before returning this unit.');
      }
      await tx.$queryRaw`SELECT "id" FROM "wms_fulfillment_orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.wmsFulfillmentOrder.findFirst({
        where: {
          id: orderId,
          basketId: basket.id,
          tenantId: scopedOrder.tenantId,
          changeState: WmsFulfillmentChangeState.PICK_REWORK_REQUIRED,
        },
        include: {
          basket: { select: { id: true, barcode: true } },
          lines: true,
          amendments: {
            where: { status: WmsFulfillmentAmendmentStatus.OPEN },
            orderBy: { detectedAt: 'desc' },
            take: 1,
          },
        },
      });
      if (!order || !order.basket) {
        throw new NotFoundException('The active detachment plan was not found');
      }
      const amendment = order.amendments[0];
      if (!amendment) {
        throw new ConflictException('The open order amendment was not found');
      }
      const requiredActions = this.asJsonRecord(amendment.requiredActions) ?? {};
      const detachment = this.asJsonRecord(requiredActions.detach);
      const rawUnits = Array.isArray(detachment?.units) ? detachment.units : [];
      if (detachment?.status !== 'RETURNING' || rawUnits.length === 0) {
        throw new ConflictException('This order does not have pending detachment returns');
      }

      const units = rawUnits.map((rawUnit) => this.asJsonRecord(rawUnit) ?? {});
      const unitIndex = units.findIndex((unit) => (
        !this.readString(unit.returnedAt)
        && [this.readString(unit.code), this.readString(unit.barcode)]
          .filter(Boolean)
          .some((candidate) => this.normalizeScannedCode(candidate!) === unitCode)
      ));
      if (unitIndex < 0) {
        throw new BadRequestException('Scanned unit is not pending return for this detached order');
      }
      const unitPlan = units[unitIndex];
      const destinationBin = this.asJsonRecord(unitPlan.destinationBin);
      const validBinCodes = [this.readString(destinationBin?.code), this.readString(destinationBin?.barcode)]
        .filter(Boolean)
        .map((candidate) => this.normalizeScannedCode(candidate!));
      if (!validBinCodes.includes(binCode)) {
        throw new BadRequestException(
          `Scan destination bin ${this.readString(destinationBin?.code) ?? 'shown in the return plan'} before returning this unit`,
        );
      }

      const basketUnitId = this.readString(unitPlan.basketUnitId);
      const inventoryUnitId = this.readString(unitPlan.inventoryUnitId);
      const destinationBinId = this.readString(destinationBin?.id);
      if (!basketUnitId || !inventoryUnitId || !destinationBinId) {
        throw new ConflictException('The detachment return plan is incomplete. Refresh and contact a supervisor.');
      }
      const basketUnit = await tx.wmsBasketUnit.findFirst({
        where: {
          id: basketUnitId,
          basketId: basket.id,
          inventoryUnitId,
          status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] },
        },
        include: { inventoryUnit: true },
      });
      if (!basketUnit) {
        throw new ConflictException('This serialized unit is no longer active in the basket. Refresh the detachment plan.');
      }
      if (
        basketUnit.inventoryUnit.status !== WmsInventoryUnitStatus.PICKED
        && basketUnit.inventoryUnit.status !== WmsInventoryUnitStatus.PACKED
      ) {
        throw new ConflictException(`Unit ${basketUnit.inventoryUnit.code} is no longer held for return`);
      }

      await tx.wmsInventoryUnit.update({
        where: { id: inventoryUnitId },
        data: {
          status: WmsInventoryUnitStatus.PUTAWAY,
          currentLocationId: destinationBinId,
          updatedById: userId,
        },
      });
      await tx.wmsBasketUnit.update({
        where: { id: basketUnit.id },
        data: {
          status: WmsBasketUnitStatus.REMOVED,
          removedById: userId,
          removedAt: now,
        },
      });
      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: basketUnit.tenantId,
          inventoryUnitId,
          warehouseId: basketUnit.warehouseId,
          fromLocationId: null,
          toLocationId: destinationBinId,
          fromStatus: basketUnit.inventoryUnit.status,
          toStatus: WmsInventoryUnitStatus.PUTAWAY,
          movementType: WmsInventoryMovementType.TRANSFER,
          referenceType: 'WMS_FULFILLMENT_DETACH',
          referenceId: order.id,
          referenceCode: order.posOrderId,
          notes: `Returned while detaching order ${order.posOrderId} from basket ${basket.barcode}`,
          actorId: userId,
          createdAt: now,
        },
      });

      units[unitIndex] = {
        ...unitPlan,
        returnedAt: now.toISOString(),
        returnedById: userId,
      };
      const remainingUnits = units.filter((unit) => !this.readString(unit.returnedAt)).length;
      const nextDetachment = {
        ...detachment,
        status: remainingUnits === 0 ? 'COMPLETED' : 'RETURNING',
        units,
        ...(remainingUnits === 0 ? { completedAt: now.toISOString() } : {}),
      };
      const nextRequiredActions = {
        ...requiredActions,
        detach: nextDetachment,
      };
      const currentSummary = this.asJsonRecord(order.changeSummary) ?? {};

      if (remainingUnits === 0) {
        await this.finalizeFulfillmentOrderDetachmentTx(tx, {
          order,
          amendmentId: amendment.id,
          requiredActions: nextRequiredActions,
          detachment: nextDetachment,
          basketId: basket.id,
          basketCode: basket.barcode,
          actorId: userId,
          now,
        });
      } else {
        await tx.wmsFulfillmentAmendment.update({
          where: { id: amendment.id },
          data: { requiredActions: nextRequiredActions as Prisma.InputJsonValue },
        });
        await tx.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            changeSummary: {
              ...currentSummary,
              detachmentRemainingUnits: remainingUnits,
              message: `${remainingUnits} unit${remainingUnits === 1 ? '' : 's'} must still be returned before order ${order.posOrderId} detaches.`,
            } as Prisma.InputJsonValue,
          },
        });
      }

      return {
        detached: remainingUnits === 0,
        remainingUnits,
        tenantId: order.tenantId,
        storeId: order.storeId,
        warehouseId: order.warehouseId,
        posOrderId: order.posOrderId,
        variationIds: order.lines.map((line) => line.variationId),
        returnedUnit: {
          id: inventoryUnitId,
          code: basketUnit.inventoryUnit.code,
          variationId: basketUnit.variationId,
          destinationBin: this.readString(destinationBin?.code),
        },
      };
    }, {
      maxWait: 3000,
      timeout: 15000,
    });

    if (result.detached) {
      await this.wmsFulfillmentSyncService.refreshDemandQueueForScope({
        tenantId: result.tenantId,
        storeId: result.storeId,
        variationIds: result.variationIds,
      });
    }

    const [updatedOrder, updatedBasket] = await Promise.all([
      this.prisma.wmsFulfillmentOrder.findUnique({
        where: { id: orderId },
        include: this.pickingTaskInclude(),
      }),
      this.prisma.wmsBasket.findUnique({
        where: { id: basket.id },
        include: this.mobileBasketInclude(),
      }),
    ]);

    await this.recordStockActivity(user, request, {
      tenantId: result.tenantId,
      actionType: result.detached ? 'FULFILLMENT_ORDER_DETACHED' : 'FULFILLMENT_DETACH_UNIT_RETURN',
      resourceType: 'WMS_INVENTORY_UNIT',
      resourceId: result.returnedUnit.id,
      taskType: 'PICK',
      storeId: result.storeId,
      warehouseId: result.warehouseId,
      metadata: {
        basketId: basket.id,
        basketCode: basket.barcode,
        fulfillmentOrderId: orderId,
        posOrderId: result.posOrderId,
        unitCode: result.returnedUnit.code,
        destinationBin: result.returnedUnit.destinationBin,
        remainingUnits: result.remainingUnits,
      },
    });

    return {
      success: true,
      detached: result.detached,
      remainingUnits: result.remainingUnits,
      returnedUnit: result.returnedUnit,
      task: updatedOrder ? this.mapMobilePickingTask(updatedOrder) : null,
      basket: updatedBasket ? this.mapMobilePickBasket(updatedBasket) : null,
      plan: updatedBasket ? this.buildMobileBasketPickPlan(updatedBasket) : null,
    };
  }

  private async finalizeFulfillmentOrderDetachmentTx(
    tx: Prisma.TransactionClient,
    params: {
      order: any;
      amendmentId: string;
      requiredActions: Record<string, unknown>;
      detachment: Record<string, unknown>;
      basketId: string;
      basketCode: string;
      actorId: string;
      now: Date;
    },
  ) {
    const activeLines = (params.order.lines ?? []).filter(
      (line: any) => line.status !== WmsFulfillmentLineStatus.CANCELED && line.quantityRequired > 0,
    );
    const currentSummary = this.asJsonRecord(params.order.changeSummary) ?? {};
    const completedDetachment = {
      ...params.detachment,
      status: 'COMPLETED',
      completedAt: this.readString(params.detachment.completedAt) ?? params.now.toISOString(),
    };

    await tx.wmsBasketPickDemand.deleteMany({
      where: { fulfillmentOrderId: params.order.id },
    });
    await tx.wmsFulfillmentLine.updateMany({
      where: {
        fulfillmentOrderId: params.order.id,
        status: { not: WmsFulfillmentLineStatus.CANCELED },
      },
      data: {
        quantityAllocated: 0,
        quantityPicked: 0,
        status: WmsFulfillmentLineStatus.RESTOCKING,
        issueReason: `Waiting for stock after detachment from basket ${params.basketCode}.`,
      },
    });
    await tx.wmsFulfillmentAmendment.update({
      where: { id: params.amendmentId },
      data: {
        status: WmsFulfillmentAmendmentStatus.RESOLVED,
        resolvedAt: params.now,
        requiredActions: {
          ...params.requiredActions,
          detach: completedDetachment,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.wmsFulfillmentOrder.update({
      where: { id: params.order.id },
      data: {
        basketId: null,
        status: activeLines.length > 0
          ? WmsFulfillmentOrderStatus.RESTOCKING
          : WmsFulfillmentOrderStatus.ISSUE,
        allocatedQuantity: 0,
        pickedQuantity: 0,
        claimedById: null,
        claimedAt: null,
        packedById: null,
        completedAt: null,
        changeState: WmsFulfillmentChangeState.NONE,
        issueReason: activeLines.length > 0
          ? `Waiting for stock after detachment from basket ${params.basketCode}.`
          : 'Order has no pickable variation items after detachment.',
        changeSummary: {
          ...currentSummary,
          requiresAction: false,
          notificationTitle: 'Order detached — waiting for stock',
          message: `Order ${params.order.posOrderId} was detached from basket ${params.basketCode} and returned to fulfillment allocation.`,
          returnUnitsRemaining: 0,
          pickUnitsRequired: 0,
          detachmentRemainingUnits: 0,
          detachedFromBasket: params.basketCode,
          detachedAt: params.now.toISOString(),
          detachedById: params.actorId,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.wmsBasket.updateMany({
      where: {
        id: params.basketId,
        fulfillmentOrderId: params.order.id,
      },
      data: { fulfillmentOrderId: null },
    });
    await this.refreshBasketState(tx, params.basketId, params.now, {
      basketAlreadyLocked: true,
      cleanupOrphans: false,
    });
  }

  async completePickingTask(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePickScopedDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    const order = await this.findPickingOrderForAction(user, id, body.tenantId, request);
    this.assertPickingTaskClaimedByUser(order, userId);
    await this.assertFulfillmentAmendmentResolved(order);

    if (order.pickedQuantity < order.totalQuantity) {
      throw new BadRequestException(`Order ${order.posOrderId} still has units to pick`);
    }

    const now = order.completedAt ?? new Date();
    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      if (order.basket?.id) {
        await tx.$queryRaw`SELECT "id" FROM "wms_baskets" WHERE "id" = ${order.basket.id}::uuid FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT "id" FROM "wms_fulfillment_orders" WHERE "id" = ${order.id}::uuid FOR UPDATE`;
      const currentOrder = await tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: {
          changeState: true,
          pickedQuantity: true,
          totalQuantity: true,
          posOrderId: true,
        },
      });
      if (currentOrder.changeState !== WmsFulfillmentChangeState.NONE) {
        throw new ConflictException(
          `Order ${currentOrder.posOrderId} changed in POS. Finish its updated Pick steps before completing it.`,
        );
      }
      if (currentOrder.pickedQuantity < currentOrder.totalQuantity) {
        throw new ConflictException(`Order ${currentOrder.posOrderId} was updated and still has units to pick`);
      }

      await tx.wmsFulfillmentOrder.update({
        where: { id: order.id },
        data: {
          status: WmsFulfillmentOrderStatus.READY_FOR_PACK,
          completedAt: now,
        },
      });

      await this.refreshFulfillmentBasketState(tx, order.id, now);

      return tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: this.pickingTaskInclude(),
      });
    });

    await this.recordStockActivity(user, request, {
      tenantId: updatedOrder.tenantId,
      actionType: 'PICKING_COMPLETE',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: updatedOrder.id,
      storeId: updatedOrder.storeId,
      warehouseId: updatedOrder.warehouseId,
      metadata: this.isDemandPickingOrder(updatedOrder)
        ? {
            fulfillmentOrderId: updatedOrder.id,
            posOrderId: updatedOrder.posOrderId,
            mode: 'BASKET_DEMAND',
          }
        : undefined,
    });

    return {
      success: true,
      task: this.mapMobilePickingTask(updatedOrder),
    };
  }

  async handoffPickingTask(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePickHandoffDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    const order = await this.findPickingOrderForAction(user, id, body.tenantId, request);
    await this.assertFulfillmentAmendmentResolved(order);

    const [access, taskAssignment] = await Promise.all([
      this.effectiveAccessService.resolveUserAccess({
        userId,
        basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
        workspace: 'wms',
      }),
      this.getWmsTaskAssignment(userId),
    ]);
    const pickQueueAccess = this.resolvePickQueueAccess(user, access.permissions, taskAssignment);

    if (order.claimedById !== userId && !pickQueueAccess.canViewAll) {
      throw new ForbiddenException('Only the claiming picker can hand off this basket');
    }

    if (!order.basket) {
      throw new BadRequestException(`Order ${order.posOrderId} has no basket to hand off`);
    }

    if (
      order.status !== WmsFulfillmentOrderStatus.READY_FOR_PACK
      && order.status !== WmsFulfillmentOrderStatus.PICKED
    ) {
      throw new BadRequestException(`Order ${order.posOrderId} is ${this.formatEnumLabel(order.status)} and cannot be handed off yet`);
    }

    const packerCandidate = await this.findPackingHandoffCandidate(body.packerId);
    if (!packerCandidate) {
      throw new NotFoundException('Selected packer is not available for WMS packing');
    }

    const now = new Date();
    const handoffResult = await this.prisma.$transaction(async (tx) => {
      const scopedOrder = await tx.wmsFulfillmentOrder.findUnique({
        where: { id: order.id },
        select: {
          id: true,
          posOrderId: true,
          status: true,
          changeState: true,
          basket: {
            select: {
              id: true,
              barcode: true,
              readyForPackAt: true,
            },
          },
        },
      });

      if (!scopedOrder || !scopedOrder.basket) {
        throw new NotFoundException('Pick task was not found');
      }

      if (scopedOrder.changeState !== WmsFulfillmentChangeState.NONE) {
        throw new ConflictException(
          `Order ${scopedOrder.posOrderId} changed in POS. Finish the highlighted return and pick steps before assigning a packer.`,
        );
      }

      if (
        scopedOrder.status !== WmsFulfillmentOrderStatus.READY_FOR_PACK
        && scopedOrder.status !== WmsFulfillmentOrderStatus.PICKED
      ) {
        throw new BadRequestException(`Order ${scopedOrder.posOrderId} is ${this.formatEnumLabel(scopedOrder.status)} and cannot be handed off yet`);
      }

      const blockedBasketOrders = await tx.wmsFulfillmentOrder.count({
        where: {
          basketId: scopedOrder.basket.id,
          id: {
            not: scopedOrder.id,
          },
          OR: [
            {
              status: {
                notIn: [
                  WmsFulfillmentOrderStatus.READY_FOR_PACK,
                  WmsFulfillmentOrderStatus.PICKED,
                ],
              },
            },
            { changeState: { not: WmsFulfillmentChangeState.NONE } },
          ],
        },
      });

      if (blockedBasketOrders > 0) {
        throw new ConflictException(`Basket ${scopedOrder.basket.barcode} still has ${blockedBasketOrders} order${blockedBasketOrders === 1 ? '' : 's'} not ready for pack`);
      }

      await tx.wmsBasket.update({
        where: { id: scopedOrder.basket.id },
        data: {
          assignedPackerId: packerCandidate.id,
          status: WmsBasketStatus.FULL_HELD,
          readyForPackAt: scopedOrder.basket.readyForPackAt ?? now,
        },
      });

      await tx.wmsFulfillmentOrder.updateMany({
        where: {
          basketId: scopedOrder.basket.id,
          status: WmsFulfillmentOrderStatus.READY_FOR_PACK,
        },
        data: {
          status: WmsFulfillmentOrderStatus.PICKED,
          completedAt: now,
        },
      });

      const posStatusOrders = await tx.wmsFulfillmentOrder.findMany({
        where: {
          basketId: scopedOrder.basket.id,
          status: WmsFulfillmentOrderStatus.PICKED,
        },
        select: {
          id: true,
          tenantId: true,
          storeId: true,
          posOrderDbId: true,
          shopId: true,
          posOrderId: true,
          warehouseId: true,
        },
      });

      return {
        basketId: scopedOrder.basket.id,
        basketCode: scopedOrder.basket.barcode,
        posStatusOrders,
      };
    }, {
      maxWait: 3000,
      timeout: 10000,
    });
    let updatedOrder: any;
    try {
      updatedOrder = await this.prisma.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: this.pickingTaskInclude(),
      });
    } catch (reloadError: any) {
      this.logger.error(
        `Failed to reload committed WMS picking handoff basket=${handoffResult.basketCode}: ${reloadError?.message || 'Unknown error'}. Returning the committed handoff state.`,
        reloadError?.stack,
      );
      updatedOrder = {
        ...order,
        status: WmsFulfillmentOrderStatus.PICKED,
        completedAt: now,
        basket: {
          ...order.basket,
          status: WmsBasketStatus.FULL_HELD,
          assignedPackerId: packerCandidate.id,
          assignedPacker: {
            firstName: packerCandidate.name,
            lastName: null,
            email: packerCandidate.email,
          },
          readyForPackAt: order.basket.readyForPackAt ?? now,
          fulfillmentOrders: Array.isArray(order.basket.fulfillmentOrders)
            ? order.basket.fulfillmentOrders.map((basketOrder: any) => ({
                ...basketOrder,
                status: basketOrder.status === WmsFulfillmentOrderStatus.READY_FOR_PACK
                  ? WmsFulfillmentOrderStatus.PICKED
                  : basketOrder.status,
              }))
            : [],
        },
      };
    }
    let posStatusDispatchMode: 'ASYNC_QUEUE' | 'INLINE_FALLBACK' | 'FAILED' = 'ASYNC_QUEUE';
    let posStatusUpdate: PickedOrderPosStatusUpdateSummary;

    try {
      posStatusUpdate = await this.enqueuePickedOrdersWaitingForPrintingFanout({
        basketId: updatedOrder.basket?.id ?? order.basket.id,
        basketCode: updatedOrder.basket?.barcode ?? order.basket.barcode ?? null,
        requestedAt: now,
        orders: handoffResult.posStatusOrders,
      });
    } catch (error: any) {
      posStatusDispatchMode = 'INLINE_FALLBACK';
      this.logger.error(
        `Failed to queue WMS picking handoff fanout basket=${updatedOrder.basket?.barcode ?? order.basket.barcode ?? order.basket.id}: ${error?.message || 'Unknown error'}. Falling back to inline status queueing.`,
        error?.stack,
      );
      try {
        posStatusUpdate = await this.enqueuePickedOrdersWaitingForPrintingStatus(handoffResult.posStatusOrders);
      } catch (fallbackError: any) {
        posStatusDispatchMode = 'FAILED';
        const reason = fallbackError?.message || 'Unknown error';
        this.logger.error(
          `Failed all WMS picking handoff status dispatch modes basket=${updatedOrder.basket?.barcode ?? order.basket.barcode ?? order.basket.id}: ${reason}. The basket handoff remains committed.`,
          fallbackError?.stack,
        );
        posStatusUpdate = {
          targetStatus: WAITING_FOR_PRINTING_POS_ORDER_STATUS,
          queued: 0,
          skipped: 0,
          failed: handoffResult.posStatusOrders.length,
          results: handoffResult.posStatusOrders.map((statusOrder) => ({
            posOrderId: statusOrder.posOrderId,
            outcome: 'failed' as const,
            reason,
          })),
        };
      }
    }

    try {
      await this.recordStockActivity(user, request, {
        tenantId: updatedOrder.tenantId,
        actionType: 'PICKING_HANDOFF',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: updatedOrder.id,
        storeId: updatedOrder.storeId,
        warehouseId: updatedOrder.warehouseId,
        metadata: {
          fulfillmentOrderId: updatedOrder.id,
          posOrderId: updatedOrder.posOrderId,
          basketCode: updatedOrder.basket?.barcode ?? null,
          packerId: packerCandidate.id,
          packerEmail: packerCandidate.email,
          posStatusDispatchMode,
          posStatusTarget: posStatusUpdate.targetStatus,
          posStatusQueued: posStatusUpdate.queued,
          posStatusSkipped: posStatusUpdate.skipped,
          posStatusFailed: posStatusUpdate.failed,
          posStatusResults: posStatusUpdate.results,
          ...(this.isDemandPickingOrder(updatedOrder) ? { mode: 'BASKET_DEMAND' } : {}),
        },
      });
    } catch (activityError: any) {
      this.logger.error(
        `Failed to record WMS picking handoff activity basket=${updatedOrder.basket?.barcode ?? order.basket.barcode ?? order.basket.id}: ${activityError?.message || 'Unknown error'}. The basket handoff remains committed.`,
        activityError?.stack,
      );
    }

    return {
      success: true,
      task: this.mapMobilePickingTask(updatedOrder),
      posStatusUpdate,
    };
  }

  async processPickingHandoffWaitingForPrintingJob(
    data: WmsPickingHandoffWaitingForPrintingJobData,
  ): Promise<PickedOrderPosStatusUpdateSummary> {
    const summary = await this.enqueuePickedOrdersWaitingForPrintingStatus(data.orders);

    this.logger.log(
      `Processed WMS picking handoff status fanout basket=${data.basketCode ?? data.basketId} target=${summary.targetStatus} queued=${summary.queued} skipped=${summary.skipped} failed=${summary.failed}`,
    );

    return summary;
  }

  async voidPickingBasket(
    user: BootstrapUser,
    id: string,
    body: WmsMobilePickBasketVoidDto,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    const basket = await this.findPickingBasketForRepairAction(user, id, body.tenantId, request);
    this.assertDemandPickBasketVoidable(basket);

    const activeOrders = this.getMobileBasketOrders(basket);
    const releaseResult = await this.wmsFulfillmentOpsService.releaseAbandonedDemandBaskets(
      user,
      {
        basketId: basket.id,
        allowPackedDetach: true,
      },
      request,
    );
    const basketResult = releaseResult.results[0];

    if (!basketResult) {
      throw new BadRequestException(`Basket ${basket.barcode} could not be released`);
    }

    if (basketResult.status === 'error') {
      throw new BadRequestException(basketResult.reason ?? `Basket ${basket.barcode} could not be released`);
    }

    if (basketResult.status === 'skipped') {
      throw new ConflictException(basketResult.reason ?? `Basket ${basket.barcode} could not be released`);
    }

    const repairSummary = await this.wmsFulfillmentSyncService.repairReleasedDemandOrders({
      orderIds: activeOrders.map((order: any) => order.id),
      actorId: userId,
      reason: `Pick basket ${basket.barcode} was voided from WMS.`,
    });

    await this.recordStockActivity(user, request, {
      tenantId: basket.tenantId ?? activeOrders[0]?.tenantId ?? null,
      actionType: 'PICKING_VOID',
      resourceType: 'WMS_BASKET',
      resourceId: basket.id,
      storeId: activeOrders.length === 1 ? activeOrders[0]?.storeId ?? null : null,
      warehouseId: basket.warehouseId ?? activeOrders[0]?.warehouseId ?? null,
      metadata: {
        basketCode: basket.barcode,
        releasedOrders: basketResult.releasedOrders ?? activeOrders.length,
        releasedUnits: basketResult.releasedUnits ?? 0,
        detachedPackedUnits: basketResult.detachedPackedUnits ?? 0,
        detachedPackedOrders: basketResult.detachedPackedOrders ?? 0,
        resetOrders: repairSummary.resetOrders,
        canceledOrders: repairSummary.canceledOrders,
        refreshedScopes: repairSummary.refreshedScopes,
        mode: 'BASKET_DEMAND',
      },
    });

    return {
      success: true,
      basket: {
        id: basket.id,
        barcode: basket.barcode,
      },
      releasedOrders: basketResult.releasedOrders ?? activeOrders.length,
      releasedUnits: basketResult.releasedUnits ?? 0,
      detachedPackedUnits: basketResult.detachedPackedUnits ?? 0,
      detachedPackedOrders: basketResult.detachedPackedOrders ?? 0,
      resetOrders: repairSummary.resetOrders,
      canceledOrders: repairSummary.canceledOrders,
      refreshedScopes: repairSummary.refreshedScopes,
    };
  }

  private async performDemandPackingBasketVoid(
    user: BootstrapUser,
    basket: any,
    selectedOrders: any[],
    body: Pick<WmsMobilePackBasketVoidDto, 'reason' | 'supervisorIdentifier' | 'supervisorPassword'>,
    request?: Request,
  ) {
    const userId = user.userId || user.id || null;
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    const directVoidAccess = await this.resolveDirectPackVoidAccess(userId, user);
    const approval = directVoidAccess.allowed
      ? {
          mode: 'DIRECT' as const,
          approver: null,
        }
      : await this.resolvePackVoidSupervisorApproval({
          requester: user,
          tenantId: basket.tenantId ?? selectedOrders[0]?.tenantId ?? null,
          request,
          supervisorIdentifier: body.supervisorIdentifier,
          supervisorPassword: body.supervisorPassword,
        });

    const voidReason = this.cleanOptionalText(body.reason);
    if (!voidReason) {
      throw new BadRequestException('Void reason is required');
    }

    const releaseResult = await this.wmsFulfillmentOpsService.releaseDemandBasketOrdersForPackVoid(
      user,
      {
        basketId: basket.id,
        orderIds: selectedOrders.map((order: any) => order.id),
        reason: voidReason,
      },
      request,
    );

    const updatedBasket = await this.prisma.wmsBasket.findUniqueOrThrow({
      where: { id: basket.id },
      include: this.mobileBasketInclude(),
    });

    const selectedTenantIds = Array.from(new Set(selectedOrders.map((order: any) => order.tenantId).filter(Boolean)));
    const selectedStoreIds = Array.from(new Set(selectedOrders.map((order: any) => order.storeId).filter(Boolean)));

    const activityMetadata = {
      approvalMode: approval.mode,
      basketCode: basket.barcode,
      reason: voidReason,
      mode: 'BASKET_DEMAND',
      releasedOrders: releaseResult.voidedOrderIds.length,
      releasedPosOrderIds: releaseResult.voidedPosOrderIds,
      restoredPickedUnits: releaseResult.restoredPickedUnits,
      restoredPackedUnits: releaseResult.restoredPackedUnits,
      canceledPosOrderIds: releaseResult.canceledPosOrderIds,
      reopenedPosOrderIds: releaseResult.reopenedPosOrderIds,
      approverId: approval.approver?.id ?? null,
      approverEmail: approval.approver?.email ?? null,
    };

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId: selectedTenantIds.length === 1 ? selectedTenantIds[0] : basket.tenantId ?? null,
      actorId: userId,
      sessionId: (this.cls.get('sessionId') as string | undefined) || user.sessionId || null,
      actionType: approval.mode === 'DIRECT' ? 'PACKING_VOID_COMPLETE' : 'PACKING_VOID_REQUEST',
      resourceType: 'WMS_BASKET',
      resourceId: basket.id,
      storeId: selectedStoreIds.length === 1 ? selectedStoreIds[0] : null,
      warehouseId: basket.warehouseId ?? selectedOrders[0]?.warehouseId ?? null,
      fromStatus: basket.status ?? null,
      toStatus: updatedBasket.status ?? null,
      metadata: activityMetadata,
    });

    if (approval.approver) {
      await this.wmsStaffActivityService.recordFromRequest({
        request,
        tenantId: selectedTenantIds.length === 1 ? selectedTenantIds[0] : basket.tenantId ?? null,
        actorId: approval.approver.id,
        sessionId: (this.cls.get('sessionId') as string | undefined) || user.sessionId || null,
        actionType: 'PACKING_VOID_APPROVAL',
        resourceType: 'WMS_BASKET',
        resourceId: basket.id,
        storeId: selectedStoreIds.length === 1 ? selectedStoreIds[0] : null,
        warehouseId: basket.warehouseId ?? selectedOrders[0]?.warehouseId ?? null,
        fromStatus: basket.status ?? null,
        toStatus: updatedBasket.status ?? null,
        metadata: {
          basketCode: basket.barcode,
          reason: voidReason,
          releasedPosOrderIds: releaseResult.voidedPosOrderIds,
          requesterId: userId,
          requesterEmail: user.email ?? null,
          mode: 'BASKET_DEMAND',
        },
      });

      await this.wmsStaffActivityService.recordFromRequest({
        request,
        tenantId: selectedTenantIds.length === 1 ? selectedTenantIds[0] : basket.tenantId ?? null,
        actorId: userId,
        sessionId: (this.cls.get('sessionId') as string | undefined) || user.sessionId || null,
        actionType: 'PACKING_VOID_COMPLETE',
        resourceType: 'WMS_BASKET',
        resourceId: basket.id,
        storeId: selectedStoreIds.length === 1 ? selectedStoreIds[0] : null,
        warehouseId: basket.warehouseId ?? selectedOrders[0]?.warehouseId ?? null,
        fromStatus: basket.status ?? null,
        toStatus: updatedBasket.status ?? null,
        metadata: activityMetadata,
      });
    }

    return {
      updatedBasket,
      approval,
      voidReason,
      releaseResult,
    };
  }

  private async enqueuePickedOrdersWaitingForPrintingStatus(
    orders: Array<{
      id: string;
      tenantId: string;
      storeId: string;
      posOrderDbId: string;
      shopId: string;
      posOrderId: string;
      warehouseId: string | null;
    }>,
  ): Promise<PickedOrderPosStatusUpdateSummary> {
    const summary: PickedOrderPosStatusUpdateSummary = {
      targetStatus: WAITING_FOR_PRINTING_POS_ORDER_STATUS,
      queued: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };

    if (orders.length === 0) {
      return summary;
    }

    const results = await Promise.all(orders.map(async (order): Promise<PickedOrderPosStatusUpdateSummary['results'][number]> => {
      try {
        const result = await this.ordersService.enqueueSystemPosOrderStatusUpdate({
          tenantId: order.tenantId,
          orderRowId: order.posOrderDbId,
          shopId: order.shopId,
          posOrderId: order.posOrderId,
          targetStatus: WAITING_FOR_PRINTING_POS_ORDER_STATUS,
          allowedCurrentStatuses: [CONFIRMED_POS_ORDER_STATUS],
          source: 'wms_picking',
        });

        if (result.skipped) {
          this.logger.warn(
            `Skipped WMS POS status update order=${order.posOrderId} target=${WAITING_FOR_PRINTING_POS_ORDER_STATUS} reason=${result.reason} current=${result.currentStatus ?? 'n/a'}`,
          );
          return {
            posOrderId: order.posOrderId,
            outcome: 'skipped',
            reason: result.reason,
            currentStatus: result.currentStatus,
          };
        }

        this.logger.log(
          `Queued WMS POS status update order=${order.posOrderId} target=${WAITING_FOR_PRINTING_POS_ORDER_STATUS} reason=${result.reason}`,
        );
        return {
          posOrderId: order.posOrderId,
          outcome: 'queued',
          reason: result.reason,
          currentStatus: result.currentStatus,
        };
      } catch (error: any) {
        const reason = error?.message || 'Unknown error';
        this.logger.error(
          `Failed to queue WMS POS status update order=${order.posOrderId} target=${WAITING_FOR_PRINTING_POS_ORDER_STATUS}: ${reason}`,
          error?.stack,
        );
        return {
          posOrderId: order.posOrderId,
          outcome: 'failed',
          reason,
        };
      }
    }));

    for (const result of results) {
      summary.results.push(result);
      if (result.outcome === 'queued') {
        summary.queued += 1;
      } else if (result.outcome === 'skipped') {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
      }
    }

    return summary;
  }

  private buildDeferredPickedOrdersWaitingForPrintingSummary(
    orders: Array<{
      posOrderId: string;
    }>,
  ): PickedOrderPosStatusUpdateSummary {
    return {
      targetStatus: WAITING_FOR_PRINTING_POS_ORDER_STATUS,
      queued: orders.length,
      skipped: 0,
      failed: 0,
      results: orders.map((order) => ({
        posOrderId: order.posOrderId,
        outcome: 'queued',
        reason: 'HANDOFF_FANOUT_QUEUED',
      })),
    };
  }

  private async enqueuePickedOrdersWaitingForPrintingFanout(params: {
    basketId: string;
    basketCode: string | null;
    requestedAt: Date;
    orders: Array<{
      id: string;
      tenantId: string;
      storeId: string;
      posOrderDbId: string;
      shopId: string;
      posOrderId: string;
      warehouseId: string | null;
    }>;
  }): Promise<PickedOrderPosStatusUpdateSummary> {
    if (params.orders.length === 0) {
      return this.buildDeferredPickedOrdersWaitingForPrintingSummary([]);
    }

    const jobData: WmsPickingHandoffWaitingForPrintingJobData = {
      basketId: params.basketId,
      basketCode: params.basketCode,
      requestedAt: params.requestedAt.toISOString(),
      orders: params.orders.map((order) => ({
        id: order.id,
        tenantId: order.tenantId,
        storeId: order.storeId,
        posOrderDbId: order.posOrderDbId,
        shopId: order.shopId,
        posOrderId: order.posOrderId,
        warehouseId: order.warehouseId,
      })),
    };

    await this.pickingHandoffQueue.add(
      WMS_PICKING_HANDOFF_WAITING_FOR_PRINTING_JOB,
      jobData,
      {
        jobId: `wms-picking-handoff:${params.basketId}:waiting-for-printing`,
        ...this.getPickingHandoffQueueJobOptions(),
      },
    );

    this.logger.log(
      `Queued WMS picking handoff status fanout basket=${params.basketCode ?? params.basketId} orders=${params.orders.length}`,
    );

    return this.buildDeferredPickedOrdersWaitingForPrintingSummary(params.orders);
  }

  private async syncConfirmedPickingOrders(params: {
    tenantId: string | null;
    storeId: string | null;
    stores: Array<{
      id: string;
      tenantId: string;
      shopId: string;
      name: string;
      shopName: string;
    }>;
    actorId: string;
  }) {
    const scopedStores = params.storeId
      ? params.stores.filter((store) => store.id === params.storeId)
      : params.stores;

    if (scopedStores.length === 0) {
      return;
    }

    const storeByTenantShop = new Map(scopedStores.map((store) => [`${store.tenantId}:${store.shopId}`, store]));
    const shopIds = Array.from(new Set(scopedStores.map((store) => store.shopId)));
    const tenantIds = Array.from(new Set(scopedStores.map((store) => store.tenantId)));
    const tenantGoLiveFilters = await this.buildTenantGoLivePosOrderFilters(tenantIds);

    const confirmedOrders = await this.prisma.posOrder.findMany({
      where: {
        status: CONFIRMED_POS_ORDER_STATUS,
        isVoid: false,
        shopId: { in: shopIds },
        tenantId: params.tenantId ? params.tenantId : { in: tenantIds },
        AND: [
          {
            OR: tenantGoLiveFilters,
          },
        ],
        wmsFulfillmentOrders: {
          none: {
            status: {
              in: [
                WmsFulfillmentOrderStatus.IN_PICKING,
                WmsFulfillmentOrderStatus.READY_FOR_PACK,
                WmsFulfillmentOrderStatus.PICKED,
                WmsFulfillmentOrderStatus.PACKING,
                WmsFulfillmentOrderStatus.PACKED,
                WmsFulfillmentOrderStatus.CANCELED,
              ],
            },
          },
        },
      },
      select: {
        id: true,
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
      take: PICKING_SYNC_ORDER_LIMIT,
    });

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
      const posWarehouseRef = this.extractPosWarehouseRef(posOrder.orderSnapshot);
      const warehouseId = await this.resolveFulfillmentWarehouseId({
        tenantId: posOrder.tenantId,
        storeId: store.id,
        posWarehouseRef,
      });
      const totalQuantity = lines.reduce((sum, line) => sum + line.quantityRequired, 0);

      const fulfillmentOrder = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.wmsFulfillmentOrder.findUnique({
          where: { posOrderDbId: posOrder.id },
          select: {
            id: true,
            status: true,
          },
        });

        if (!existing) {
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
              issueReason: lines.length === 0 ? 'Order has no pickable variation items' : null,
              sourceTotalQuantity: totalQuantity,
              totalQuantity,
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
            },
          });
        }

        if (
          existing.status === WmsFulfillmentOrderStatus.IN_PICKING
          || existing.status === WmsFulfillmentOrderStatus.READY_FOR_PACK
          || existing.status === WmsFulfillmentOrderStatus.PICKED
          || existing.status === WmsFulfillmentOrderStatus.PACKING
          || existing.status === WmsFulfillmentOrderStatus.PACKED
          || existing.status === WmsFulfillmentOrderStatus.CANCELED
        ) {
          return existing;
        }

        await tx.wmsFulfillmentOrder.update({
          where: { id: existing.id },
          data: {
            posWarehouseRef,
            warehouseId,
            customerName: posOrder.customerName,
            customerPhone: posOrder.customerPhone,
            sourceTotalQuantity: totalQuantity,
            totalQuantity,
            issueReason: lines.length === 0 ? 'Order has no pickable variation items' : null,
            lastSyncedAt: new Date(),
          },
        });

        if (lines.length === 0) {
          await tx.wmsFulfillmentOrder.update({
            where: { id: existing.id },
            data: { status: WmsFulfillmentOrderStatus.ISSUE },
          });
          return existing;
        }

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

        await tx.wmsFulfillmentLine.updateMany({
          where: {
            fulfillmentOrderId: existing.id,
            variationId: {
              notIn: lines.map((line) => line.variationId),
            },
            reservations: {
              none: {
                status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
              },
            },
          },
          data: {
            status: WmsFulfillmentLineStatus.CANCELED,
            sourceQuantityRequired: 0,
            quantityRequired: 0,
          },
        });

        return existing;
      });

      if (
        fulfillmentOrder.status !== WmsFulfillmentOrderStatus.IN_PICKING
        && fulfillmentOrder.status !== WmsFulfillmentOrderStatus.READY_FOR_PACK
        && fulfillmentOrder.status !== WmsFulfillmentOrderStatus.PICKED
        && fulfillmentOrder.status !== WmsFulfillmentOrderStatus.PACKING
        && fulfillmentOrder.status !== WmsFulfillmentOrderStatus.PACKED
        && fulfillmentOrder.status !== WmsFulfillmentOrderStatus.CANCELED
      ) {
        await this.allocateFulfillmentOrder(fulfillmentOrder.id, params.actorId);
      }
    }

    const repairTenantId = params.tenantId ?? scopedStores[0]?.tenantId ?? null;
    if (repairTenantId) {
      await this.wmsInventoryService.syncPackedUnitsToDispatchedForPosOrders({
        tenantId: repairTenantId,
        storeId: params.storeId,
      });
    }
  }

  private async allocateFulfillmentOrder(fulfillmentOrderId: string, actorId: string | null) {
    await this.prisma.$transaction(async (tx) => {
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

      if (
        !order
        || order.status === WmsFulfillmentOrderStatus.READY_FOR_PACK
        || order.status === WmsFulfillmentOrderStatus.PICKED
        || order.status === WmsFulfillmentOrderStatus.PACKING
        || order.status === WmsFulfillmentOrderStatus.PACKED
        || order.status === WmsFulfillmentOrderStatus.CANCELED
      ) {
        return;
      }

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
        });

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

          await tx.wmsInventoryUnit.update({
            where: { id: unit.id },
            data: {
              status: WmsInventoryUnitStatus.RESERVED,
              updatedById: actorId || undefined,
            },
          });

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
  }

  private async findAvailablePickUnitsForLine(
    tx: Prisma.TransactionClient,
    params: {
      order: {
        tenantId: string;
        storeId: string;
        posWarehouseRef: string | null;
      };
      variationId: string;
      take: number;
    },
  ) {
    const baseWhere: Prisma.WmsInventoryUnitWhereInput = {
      tenantId: params.order.tenantId,
      storeId: params.order.storeId,
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
    };
    const select = {
      id: true,
      tenantId: true,
      storeId: true,
      warehouseId: true,
      currentLocationId: true,
      status: true,
      code: true,
    } satisfies Prisma.WmsInventoryUnitSelect;
    const orderBy = [
      { expirationDate: 'asc' as const },
      { updatedAt: 'asc' as const },
      { code: 'asc' as const },
    ];

    if (!params.order.posWarehouseRef) {
      return tx.wmsInventoryUnit.findMany({
        where: baseWhere,
        select,
        orderBy,
        take: params.take,
      });
    }

    const exactUnits = await tx.wmsInventoryUnit.findMany({
      where: {
        ...baseWhere,
        posWarehouseRef: params.order.posWarehouseRef,
      },
      select,
      orderBy,
      take: params.take,
    });

    const remainingQuantity = params.take - exactUnits.length;
    if (remainingQuantity <= 0) {
      return exactUnits;
    }

    const fallbackUnits = await tx.wmsInventoryUnit.findMany({
      where: {
        ...baseWhere,
        posWarehouseRef: null,
        id: {
          notIn: exactUnits.map((unit) => unit.id),
        },
      },
      select,
      orderBy,
      take: remainingQuantity,
    });

    return [...exactUnits, ...fallbackUnits];
  }

  private async buildPickShortageReason(
    tx: Prisma.TransactionClient,
    params: {
      order: {
        tenantId: string;
        storeId: string;
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
    const putawayWhere: Prisma.WmsInventoryUnitWhereInput = {
      ...identityWhere,
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

    const [matchingUnits, putawayUnits, binnedUnits, freeBinnedUnits, scopedUnits] = await Promise.all([
      tx.wmsInventoryUnit.count({ where: identityWhere }),
      tx.wmsInventoryUnit.count({ where: putawayWhere }),
      tx.wmsInventoryUnit.count({ where: binnedWhere }),
      tx.wmsInventoryUnit.count({ where: unreservedWhere }),
      tx.wmsInventoryUnit.count({ where: scopedWhere }),
    ]);

    if (matchingUnits === 0) {
      return 'No WMS units match this order item for this store.';
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
            basketPickDemands: true,
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
      const allocated = this.isDemandPickingOrder(order)
        ? (line.basketPickDemands.length > 0
            ? Math.min(
                line.basketPickDemands.reduce(
                  (sum: number, demand: any) => sum + Math.max(demand.quantityRequired ?? 0, 0),
                  0,
                ),
                required,
              )
            : Math.min(line.quantityAllocated ?? 0, required))
        : line.reservations.length;
      const picked = this.isDemandPickingOrder(order)
        ? Math.min(
            line.basketPickDemands.reduce(
              (sum: number, demand: any) => sum + Math.max(demand.quantityPicked ?? 0, 0),
              0,
            ),
            required,
          )
        : line.reservations.filter((reservation) => reservation.status === WmsPickReservationStatus.PICKED).length;
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
          ? 'Picked units remain on a removed order item — return units to bin to continue.'
          : line.issueReason;

      totalQuantity += required;
      allocatedQuantity += Math.min(allocated, required);
      pickedQuantity += Math.min(picked, required);
      hasIssue = hasIssue || nextLineStatus === WmsFulfillmentLineStatus.ISSUE;

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
    const mobileIssueLine = order.lines.find(
      (line) => line.status !== WmsFulfillmentLineStatus.CANCELED && Boolean(line.issueReason?.trim()),
    );

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
        issueReason: nextOrderStatus !== WmsFulfillmentOrderStatus.ISSUE
          ? null
          : totalQuantity === 0
            ? order.issueReason ?? 'Order has no pickable variation items'
            : mobileIssueLine?.issueReason
              ? `${mobileIssueLine.productName}: ${mobileIssueLine.issueReason}`
              : order.issueReason ?? 'Order has a fulfillment issue — review order line items or resync the pick queue.',
      },
    });
  }

  private async refreshFulfillmentBasketState(
    tx: Prisma.TransactionClient,
    fulfillmentOrderId: string,
    now: Date,
    options: {
      basketAlreadyLocked?: boolean;
      cleanupOrphans?: boolean;
    } = {},
  ) {
    const order = await tx.wmsFulfillmentOrder.findUnique({
      where: { id: fulfillmentOrderId },
      select: {
        basketId: true,
      },
    });

    if (!order?.basketId) {
      return;
    }

    await this.refreshBasketState(tx, order.basketId, now, options);
  }

  private async refreshBasketState(
    tx: Prisma.TransactionClient,
    basketId: string,
    now: Date,
    options: {
      basketAlreadyLocked?: boolean;
      cleanupOrphans?: boolean;
    } = {},
  ) {
    if (!options.basketAlreadyLocked) {
      await this.lockBasketForUpdate(tx, basketId);
    }
    if (options.cleanupOrphans !== false) {
      await this.releaseReusableOrphanBasketUnitsTx(tx, {
        basketId,
        actorId: null,
        now,
      });
    }

    const basket = await tx.wmsBasket.findUnique({
      where: { id: basketId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        assignedPickerId: true,
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
            storeId: true,
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

    const hasPackingOrder = activeOrders.some((activeOrder) => activeOrder.status === WmsFulfillmentOrderStatus.PACKING);
    const allReadyForPack = activeOrders.every((activeOrder) => (
      activeOrder.status === WmsFulfillmentOrderStatus.READY_FOR_PACK
      || activeOrder.status === WmsFulfillmentOrderStatus.PICKED
    ));
    const hasPickedWork = activeOrders.some((activeOrder) => (
      activeOrder.pickedQuantity > 0
      || activeOrder.status === WmsFulfillmentOrderStatus.IN_PICKING
    ));
    const activeTenantIds = Array.from(new Set(activeOrders.map((activeOrder) => activeOrder.tenantId)));
    const nextStatus = hasPackingOrder
      ? WmsBasketStatus.PACKING
      : allReadyForPack
        ? WmsBasketStatus.FULL_HELD
        : hasPickedWork
          ? WmsBasketStatus.IN_PICKING
          : WmsBasketStatus.ASSIGNED;

    const nextTenantId = activeTenantIds.length === 1 ? activeTenantIds[0] : null;
    const nextAssignedPickerId = activeOrders[0]?.claimedById ?? null;
    const nextAssignedPackerId = nextStatus === WmsBasketStatus.FULL_HELD || nextStatus === WmsBasketStatus.PACKING
      ? basket.assignedPackerId
      : null;
    const nextFullAt = nextStatus === WmsBasketStatus.FULL_HELD || nextStatus === WmsBasketStatus.PACKING
      ? basket.fullAt ?? now
      : null;
    const nextReadyForPackAt = nextStatus === WmsBasketStatus.FULL_HELD || nextStatus === WmsBasketStatus.PACKING
      ? basket.readyForPackAt ?? now
      : null;

    if (
      basket.status === nextStatus
      && basket.tenantId === nextTenantId
      && basket.assignedPickerId === nextAssignedPickerId
      && basket.assignedPackerId === nextAssignedPackerId
      && basket.fullAt?.getTime() === nextFullAt?.getTime()
      && basket.readyForPackAt?.getTime() === nextReadyForPackAt?.getTime()
    ) {
      return;
    }

    await tx.wmsBasket.update({
      where: { id: basket.id },
      data: {
        status: nextStatus,
        tenantId: nextTenantId,
        assignedPickerId: nextAssignedPickerId,
        assignedPackerId: nextAssignedPackerId,
        fullAt: nextFullAt,
        readyForPackAt: nextReadyForPackAt,
      },
    });
  }

  private async releaseReusableOrphanBasketUnitsTx(
    tx: Prisma.TransactionClient,
    params: {
      basketId: string;
      actorId: string | null;
      now: Date;
    },
  ) {
    const staleBasketUnits = await tx.wmsBasketUnit.findMany({
      where: {
        basketId: params.basketId,
        status: {
          in: [...ACTIVE_BASKET_UNIT_STATUSES],
        },
        fulfillmentOrderId: null,
        fulfillmentLineId: null,
        inventoryUnit: {
          status: {
            notIn: [
              WmsInventoryUnitStatus.PICKED,
              WmsInventoryUnitStatus.PACKED,
            ],
          },
        },
      },
      select: {
        id: true,
      },
    });

    if (staleBasketUnits.length === 0) {
      return 0;
    }

    const updateResult = await tx.wmsBasketUnit.updateMany({
      where: {
        id: {
          in: staleBasketUnits.map((basketUnit) => basketUnit.id),
        },
        status: {
          in: [...ACTIVE_BASKET_UNIT_STATUSES],
        },
        fulfillmentOrderId: null,
        fulfillmentLineId: null,
      },
      data: {
        status: WmsBasketUnitStatus.REMOVED,
        removedById: params.actorId ?? undefined,
        removedAt: params.now,
      },
    });

    return updateResult.count;
  }

  private async lockBasketForUpdate(tx: Prisma.TransactionClient, basketId: string) {
    await tx.$queryRaw`SELECT "id" FROM "wms_baskets" WHERE "id" = ${basketId}::uuid FOR UPDATE`;
  }

  private async backfillPackedOrderActors(params: {
    tenantId?: string | null;
    storeId?: string | null;
  }) {
    const candidates = await this.prisma.wmsFulfillmentOrder.findMany({
      where: {
        status: WmsFulfillmentOrderStatus.PACKED,
        packedById: null,
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
        ...(params.storeId ? { storeId: params.storeId } : {}),
      },
      select: {
        id: true,
      },
      take: 200,
    });

    if (candidates.length === 0) {
      return;
    }

    const orderIds = candidates.map((candidate) => candidate.id);
    const [activities, movements] = await Promise.all([
      this.prisma.wmsStaffActivity.findMany({
        where: {
          actionType: 'PACKING_COMPLETE',
          actorId: { not: null },
          resourceId: { in: orderIds },
        },
        select: {
          actorId: true,
          resourceId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
      this.prisma.wmsInventoryMovement.findMany({
        where: {
          movementType: WmsInventoryMovementType.PACK,
          actorId: { not: null },
          referenceId: { in: orderIds },
        },
        select: {
          actorId: true,
          referenceId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
    ]);

    const actorByOrderId = new Map<string, string>();

    for (const activity of activities) {
      if (activity.actorId && activity.resourceId && !actorByOrderId.has(activity.resourceId)) {
        actorByOrderId.set(activity.resourceId, activity.actorId);
      }
    }

    for (const movement of movements) {
      if (movement.actorId && movement.referenceId && !actorByOrderId.has(movement.referenceId)) {
        actorByOrderId.set(movement.referenceId, movement.actorId);
      }
    }

    const updates = Array.from(actorByOrderId.entries());
    if (updates.length === 0) {
      return;
    }

    await this.prisma.$transaction(
      updates.map(([orderId, actorId]) => (
        this.prisma.wmsFulfillmentOrder.updateMany({
          where: {
            id: orderId,
            status: WmsFulfillmentOrderStatus.PACKED,
            packedById: null,
          },
          data: {
            packedById: actorId,
          },
        })
      )),
    );
  }

  private async assertAvailableBasketForClaim(
    order: { warehouseId: string | null; posOrderId: string },
    client: Prisma.TransactionClient,
    userId: string,
  ) {
    const candidateBaskets = await client.wmsBasket.findMany({
      where: {
        warehouseId: order.warehouseId
          ? order.warehouseId
          : { not: null },
        OR: [
          {
            status: WmsBasketStatus.AVAILABLE,
          },
          {
            status: {
              in: [
                WmsBasketStatus.ASSIGNED,
                WmsBasketStatus.IN_PICKING,
              ],
            },
            assignedPickerId: userId,
          },
        ],
      },
      select: {
        id: true,
        status: true,
        maxFulfillmentOrders: true,
        fulfillmentOrders: {
          where: {
            status: {
              in: [...ACTIVE_BASKET_ORDER_STATUSES],
            },
          },
          select: {
            id: true,
          },
        },
      },
      take: 20,
    });

    const hasBasketCapacity = candidateBaskets.some((basket) => (
      basket.status === WmsBasketStatus.AVAILABLE
      || basket.fulfillmentOrders.length < basket.maxFulfillmentOrders
    ));

    if (!hasBasketCapacity) {
      throw new ConflictException(
        `No available picking baskets for order ${order.posOrderId}. Release a full basket to packing or register another basket before claiming.`,
      );
    }
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

  private async extractFulfillmentLinesFromOrderSnapshot(
    orderSnapshot: Prisma.JsonValue | null,
    storeId: string,
    fallbackItemData?: Prisma.JsonValue | null,
  ): Promise<FulfillmentLineDraft[]> {
    if (typeof (this.wmsFulfillmentSyncService as any)?.extractFulfillmentLinesFromOrderSnapshot === 'function') {
      return this.wmsFulfillmentSyncService.extractFulfillmentLinesFromOrderSnapshot(
        orderSnapshot,
        storeId,
        fallbackItemData,
      );
    }
    const snapshot = this.asJsonRecord(orderSnapshot);
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const groupedLines = new Map<string, FulfillmentLineDraft>();
    const identifiers = new Set<string>();

    for (const rawItem of items) {
      const item = this.asJsonRecord(rawItem);
      if (!item) {
        continue;
      }

      const variationInfo = this.asJsonRecord(item.variation_info);
      [
        this.readIdentifier(item.variation_id),
        this.readIdentifier(item.variationId),
        this.readIdentifier(variationInfo?.id),
        this.readIdentifier(item.product_id),
        this.readIdentifier(item.productId),
        this.readIdentifier(item.product_display_id),
        this.readIdentifier(item.productDisplayId),
        this.readIdentifier(variationInfo?.display_id),
        this.readIdentifier(variationInfo?.product_display_id),
        this.readIdentifier(variationInfo?.barcode),
      ].forEach((value) => {
        if (value) {
          identifiers.add(value);
        }
      });
    }

    const candidateIds = Array.from(identifiers);
    const catalogProducts = candidateIds.length > 0
      ? await this.prisma.posProduct.findMany({
          where: {
            storeId,
            OR: [
              { variationId: { in: candidateIds } },
              { productId: { in: candidateIds } },
              { customId: { in: candidateIds } },
            ],
          },
          select: {
            productId: true,
            variationId: true,
            customId: true,
            name: true,
          },
        })
      : [];
    const productByVariationId = new Map(
      catalogProducts
        .filter((product) => product.variationId)
        .map((product) => [product.variationId!, product]),
    );
    const productByProductId = new Map(
      catalogProducts.map((product) => [product.productId, product]),
    );
    const productByCustomId = new Map(
      catalogProducts
        .filter((product) => product.customId)
        .map((product) => [product.customId!, product]),
    );

    for (const rawItem of items) {
      const item = this.asJsonRecord(rawItem);
      if (!item) {
        continue;
      }

      const variationInfo = this.asJsonRecord(item.variation_info);
      const sourceProductId = this.readIdentifier(item.product_id) ?? this.readIdentifier(item.productId);
      const variationInfoId = this.readIdentifier(variationInfo?.id);
      const sourceVariationId =
        this.readIdentifier(item.variation_id)
        ?? this.readIdentifier(item.variationId)
        ?? (variationInfoId && variationInfoId !== sourceProductId ? variationInfoId : null);
      const sourceDisplayIds = [
        this.readIdentifier(item.product_display_id),
        this.readIdentifier(item.productDisplayId),
        this.readIdentifier(variationInfo?.product_display_id),
        this.readIdentifier(variationInfo?.display_id),
        this.readIdentifier(variationInfo?.barcode),
      ].filter(Boolean) as string[];
      const resolvedProduct =
        (sourceVariationId ? productByVariationId.get(sourceVariationId) : null)
        ?? (sourceProductId ? productByVariationId.get(sourceProductId) : null)
        ?? (sourceProductId ? productByProductId.get(sourceProductId) : null)
        ?? sourceDisplayIds.map((id) => productByCustomId.get(id)).find(Boolean)
        ?? null;
      const variationId = resolvedProduct?.variationId ?? sourceVariationId ?? sourceProductId;
      if (!variationId) {
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

      const productId = resolvedProduct?.productId ?? sourceProductId;
      const productName =
        this.readString(variationInfo?.name)
        ?? resolvedProduct?.name
        ?? this.readString(item.note_product)
        ?? `Variation ${variationId}`;
      const productDisplayId =
        resolvedProduct?.customId
        ?? this.readIdentifier(item.productDisplayId)
        ?? this.readIdentifier(item.product_display_id)
        ?? this.readIdentifier(variationInfo?.display_id)
        ?? this.readIdentifier(variationInfo?.product_display_id)
        ?? this.readIdentifier(variationInfo?.barcode);

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

  private async findPickingOrderForAction(
    user: BootstrapUser,
    id: string,
    requestedTenantId?: string | null,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: requestedTenantId ?? undefined } as GetWmsMobileStockDto,
      request,
    );
    const fulfillmentGoLiveWhere = this.buildFulfillmentGoLiveWhere(
      await this.getFulfillmentGoLiveAt(tenantContext.tenantId),
    );
    const order = await this.prisma.wmsFulfillmentOrder.findFirst({
      where: {
        id,
        ...(tenantContext.tenantId ? { tenantId: tenantContext.tenantId } : {}),
        ...fulfillmentGoLiveWhere,
      },
      include: this.pickingTaskInclude(),
    });

    if (!order) {
      throw new NotFoundException('Pick task was not found');
    }

    this.assertLegacyReservedStoxAccessAllowedForOrder(order);
    this.assertActivePickOrderPosConfirmed(order);

    const userId = user.userId || user.id || null;
    if (userId) {
      const [access, taskAssignment] = await Promise.all([
        this.effectiveAccessService.resolveUserAccess({
          userId,
          basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
          workspace: 'wms',
        }),
        this.getWmsTaskAssignment(userId),
      ]);
      this.assertPickExecutionAccess(user, access.permissions, taskAssignment);
    }

    return order;
  }

  private isBasketDemandPickingEnabled() {
    return process.env.WMS_BASKET_DEMAND_PICKING_ENABLED === 'true';
  }

  private isLegacyReservedStoxEnabled() {
    return process.env.WMS_STOX_LEGACY_RESERVED_ENABLED !== 'false';
  }

  private isLegacyReservedStoxRetired() {
    return !this.isLegacyReservedStoxEnabled();
  }

  private buildActiveStoxAssignmentWhere(): Prisma.WmsFulfillmentOrderWhereInput {
    return this.isLegacyReservedStoxRetired()
      ? { assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND }
      : {};
  }

  private assertLegacyRetirementConfiguration() {
    if (!this.isLegacyReservedStoxRetired()) {
      return;
    }

    if (this.isBasketDemandPickingEnabled()) {
      return;
    }

    throw new BadRequestException(
      'Enable basket demand picking before retiring legacy reserved STOX tasks',
    );
  }

  private assertLegacyReservedStoxAccessAllowedForOrder(order: {
    assignmentMode?: WmsFulfillmentAssignmentMode | null;
  }) {
    if (!this.isLegacyReservedStoxRetired()) {
      return;
    }

    if ((order.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED) === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
      return;
    }

    throw new NotFoundException('Legacy reserved STOX tasks are retired');
  }

  private assertLegacyReservedStoxAccessAllowedForBasket(basket: any) {
    if (!this.isLegacyReservedStoxRetired()) {
      return;
    }

    if (this.isDemandPickingBasket(basket)) {
      return;
    }

    throw new NotFoundException('Legacy reserved STOX baskets are retired');
  }

  private buildConfirmedPickPosOrderWhere(): Prisma.WmsFulfillmentOrderWhereInput {
    return {
      posOrder: {
        is: {
          status: CONFIRMED_POS_ORDER_STATUS,
          isVoid: false,
        },
      },
    };
  }

  private isActivePickOrderStatus(status: WmsFulfillmentOrderStatus) {
    return (ACTIVE_PICKING_ORDER_STATUSES as readonly WmsFulfillmentOrderStatus[]).includes(status);
  }

  private assertActivePickOrderPosConfirmed(order: any) {
    if (!this.isActivePickOrderStatus(order.status)) {
      return;
    }

    const posStatus = typeof order.posOrder?.status === 'number' ? order.posOrder.status : null;
    const isVoid = Boolean(order.posOrder?.isVoid);
    if (posStatus === CONFIRMED_POS_ORDER_STATUS && !isVoid) {
      return;
    }

    throw new BadRequestException(
      `Order ${order.posOrderId} is no longer confirmed in POS and cannot be picked`,
    );
  }

  private assertBasketActivePickOrdersPosConfirmed(basket: any) {
    const activeOrders = Array.isArray(basket.fulfillmentOrders)
      ? basket.fulfillmentOrders
      : basket.fulfillmentOrder
        ? [basket.fulfillmentOrder]
        : [];

    const invalidOrder = activeOrders.find((order: any) => {
      if (!this.isActivePickOrderStatus(order.status)) {
        return false;
      }

      const posStatus = typeof order.posOrder?.status === 'number' ? order.posOrder.status : null;
      return posStatus !== CONFIRMED_POS_ORDER_STATUS || Boolean(order.posOrder?.isVoid);
    });

    if (!invalidOrder) {
      return;
    }

    throw new BadRequestException(
      `Basket ${basket.barcode} contains order ${invalidOrder.posOrderId}, which is no longer confirmed in POS`,
    );
  }

  private async reconcileCanceledBasketOrders(
    basket: any,
    actorId: string | null,
  ) {
    const orders = Array.isArray(basket.fulfillmentOrders)
      ? basket.fulfillmentOrders
      : basket.fulfillmentOrder
        ? [basket.fulfillmentOrder]
        : [];
    const canceledOrders = orders.filter((order: any) => (
      order.posOrder?.status === CANCELED_POS_ORDER_STATUS
      || Boolean(order.posOrder?.isVoid)
    ));
    const shippedPickOrders = orders.filter((order: any) => (
      !order.posOrder?.isVoid
      && this.isActivePickOrderStatus(order.status)
      && (SHIPPED_EQUIVALENT_POS_ORDER_STATUSES as readonly number[]).includes(
        typeof order.posOrder?.status === 'number' ? order.posOrder.status : -1,
      )
    ));

    if (canceledOrders.length === 0 && shippedPickOrders.length === 0) {
      return 0;
    }

    let cleanedCount = 0;

    if (canceledOrders.length > 0) {
      const result = await this.wmsFulfillmentSyncService.reconcileCanceledPickingOrderRefs({
        actorId,
        orders: canceledOrders
          .filter((order: any) => (
            typeof order.tenantId === 'string'
            && typeof order.storeId === 'string'
            && typeof order.shopId === 'string'
            && typeof order.posOrderId === 'string'
          ))
          .map((order: any) => ({
            tenantId: order.tenantId,
            storeId: order.storeId,
            shopId: order.shopId,
            posOrderId: order.posOrderId,
          })),
      });

      if (result.cleanedOrders > 0) {
        this.logger.warn(
          `Released ${result.cleanedOrders} canceled POS order(s) from basket ${basket.barcode}`,
        );
        cleanedCount += result.cleanedOrders;
      }
    }

    if (
      shippedPickOrders.length > 0
      && typeof (this.wmsFulfillmentSyncService as any).reconcilePosShippedPickingOrderRefs === 'function'
    ) {
      const shippedResult = await this.wmsFulfillmentSyncService.reconcilePosShippedPickingOrderRefs({
        actorId,
        orders: shippedPickOrders
          .filter((order: any) => (
            typeof order.tenantId === 'string'
            && typeof order.storeId === 'string'
            && typeof order.shopId === 'string'
            && typeof order.posOrderId === 'string'
          ))
          .map((order: any) => ({
            tenantId: order.tenantId,
            storeId: order.storeId,
            shopId: order.shopId,
            posOrderId: order.posOrderId,
          })),
      });

      if (shippedResult.syncedOrders > 0) {
        this.logger.warn(
          `Synced ${shippedResult.syncedOrders} POS-shipped pick order(s) from basket ${basket.barcode}`,
        );
        cleanedCount += shippedResult.syncedOrders;
      }
    }

    return cleanedCount;
  }

  private async findPickingBasketForAction(
    user: BootstrapUser,
    id: string,
    requestedTenantId?: string | null,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: requestedTenantId ?? undefined } as GetWmsMobileStockDto,
      request,
    );
    const fulfillmentGoLiveWhere = this.buildFulfillmentGoLiveWhere(
      await this.getFulfillmentGoLiveAt(tenantContext.tenantId),
    );
    const tenantScopeWhere: Prisma.WmsBasketWhereInput = tenantContext.tenantId
      ? {
          OR: [
            { tenantId: tenantContext.tenantId },
            {
              fulfillmentOrders: {
                some: {
                  tenantId: tenantContext.tenantId,
                  ...fulfillmentGoLiveWhere,
                },
              },
            },
          ],
        }
      : {};
    let basket = await this.prisma.wmsBasket.findFirst({
      where: {
        id,
        ...tenantScopeWhere,
      },
      include: this.mobileBasketInclude(),
    });

    if (!basket) {
      throw new NotFoundException('Pick basket was not found');
    }

    this.assertLegacyReservedStoxAccessAllowedForBasket(basket);

    const userId = user.userId || user.id || null;
    if (userId) {
      const [access, taskAssignment] = await Promise.all([
        this.effectiveAccessService.resolveUserAccess({
          userId,
          basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
          workspace: 'wms',
        }),
        this.getWmsTaskAssignment(userId),
      ]);
      this.assertPickExecutionAccess(user, access.permissions, taskAssignment);
    }

    if (await this.reconcileCanceledBasketOrders(basket, userId)) {
      basket = await this.prisma.wmsBasket.findFirst({
        where: {
          id,
          ...tenantScopeWhere,
        },
        include: this.mobileBasketInclude(),
      });
      if (!basket) {
        throw new NotFoundException('Pick basket was not found after canceled orders were released');
      }
    }

    this.assertBasketActivePickOrdersPosConfirmed(basket);

    return basket;
  }

  private async findPickingBasketForUnitScan(
    user: BootstrapUser,
    id: string,
    requestedTenantId?: string | null,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: requestedTenantId ?? undefined } as GetWmsMobileStockDto,
      request,
    );
    const fulfillmentGoLiveWhere = this.buildFulfillmentGoLiveWhere(
      await this.getFulfillmentGoLiveAt(tenantContext.tenantId),
    );
    const tenantScopeWhere: Prisma.WmsBasketWhereInput = tenantContext.tenantId
      ? {
          OR: [
            { tenantId: tenantContext.tenantId },
            {
              fulfillmentOrders: {
                some: {
                  tenantId: tenantContext.tenantId,
                  ...fulfillmentGoLiveWhere,
                },
              },
            },
          ],
        }
      : {};
    const basketQuery = {
      where: {
        id,
        ...tenantScopeWhere,
      },
      include: {
        warehouse: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        fulfillmentOrders: {
          where: {
            status: {
              in: [...ACTIVE_BASKET_ORDER_STATUSES],
            },
          },
          select: {
            id: true,
            posOrderId: true,
            tenantId: true,
            storeId: true,
            shopId: true,
            status: true,
            assignmentMode: true,
            posOrder: {
              select: {
                status: true,
                isVoid: true,
              },
            },
            basketPickDemands: {
              select: {
                id: true,
                fulfillmentLineId: true,
                variationId: true,
                quantityRequired: true,
                quantityPicked: true,
                bins: {
                  select: {
                    id: true,
                    locationId: true,
                    variationId: true,
                    quantityTarget: true,
                    quantityPicked: true,
                    routeSequence: true,
                    location: {
                      select: {
                        id: true,
                        code: true,
                        name: true,
                        kind: true,
                      },
                    },
                  },
                  orderBy: [
                    { routeSequence: 'asc' },
                    { createdAt: 'asc' },
                  ],
                },
              },
              orderBy: [{ createdAt: 'asc' }],
            },
          },
          orderBy: [
            { updatedAt: 'desc' },
            { createdAt: 'desc' },
          ],
        },
      },
    } satisfies Prisma.WmsBasketFindFirstArgs;
    let basket = await this.prisma.wmsBasket.findFirst(basketQuery);

    if (!basket) {
      throw new NotFoundException('Pick basket was not found');
    }

    this.assertLegacyReservedStoxAccessAllowedForBasket(basket);

    const userId = user.userId || user.id || null;
    if (userId) {
      const [access, taskAssignment] = await Promise.all([
        this.effectiveAccessService.resolveUserAccess({
          userId,
          basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
          workspace: 'wms',
        }),
        this.getWmsTaskAssignment(userId),
      ]);
      this.assertPickExecutionAccess(user, access.permissions, taskAssignment);
    }

    if (await this.reconcileCanceledBasketOrders(basket, userId)) {
      basket = await this.prisma.wmsBasket.findFirst(basketQuery);
      if (!basket) {
        throw new NotFoundException('Pick basket was not found after canceled orders were released');
      }
    }

    this.assertBasketActivePickOrdersPosConfirmed(basket);

    return basket;
  }

  private async findPickingBasketForRepairAction(
    user: BootstrapUser,
    id: string,
    requestedTenantId?: string | null,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: requestedTenantId ?? undefined } as GetWmsMobileStockDto,
      request,
    );
    const fulfillmentGoLiveWhere = this.buildFulfillmentGoLiveWhere(
      await this.getFulfillmentGoLiveAt(tenantContext.tenantId),
    );
    const tenantScopeWhere: Prisma.WmsBasketWhereInput = tenantContext.tenantId
      ? {
          OR: [
            { tenantId: tenantContext.tenantId },
            {
              fulfillmentOrders: {
                some: {
                  tenantId: tenantContext.tenantId,
                  ...fulfillmentGoLiveWhere,
                },
              },
            },
          ],
        }
      : {};
    const basket = await this.prisma.wmsBasket.findFirst({
      where: {
        id,
        ...tenantScopeWhere,
      },
      include: this.mobileBasketInclude(),
    });

    if (!basket) {
      throw new NotFoundException('Pick basket was not found');
    }

    this.assertLegacyReservedStoxAccessAllowedForBasket(basket);
    await this.assertPickSupervisorAccess(user);

    return basket;
  }

  private async findPackingBasketForAction(
    user: BootstrapUser,
    id: string,
    requestedTenantId?: string | null,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: requestedTenantId ?? undefined } as GetWmsMobileStockDto,
      request,
    );
    const fulfillmentGoLiveWhere = this.buildFulfillmentGoLiveWhere(
      await this.getFulfillmentGoLiveAt(tenantContext.tenantId),
    );
    const tenantScopeWhere: Prisma.WmsBasketWhereInput = tenantContext.tenantId
      ? {
          OR: [
            { tenantId: tenantContext.tenantId },
            {
              fulfillmentOrders: {
                some: {
                  tenantId: tenantContext.tenantId,
                  ...fulfillmentGoLiveWhere,
                },
              },
            },
          ],
        }
      : {};
    let basket = await this.prisma.wmsBasket.findFirst({
      where: {
        id,
        status: {
          in: [...PACK_QUEUE_BASKET_STATUSES],
        },
        ...tenantScopeWhere,
      },
      include: this.mobileBasketInclude(),
    });

    if (!basket) {
      throw new NotFoundException('Pack basket was not found');
    }

    this.assertLegacyReservedStoxAccessAllowedForBasket(basket);
    await this.assertPackingBasketUserAccess(user, basket);

    const userId = user.userId || user.id || null;
    if (await this.reconcileCanceledBasketOrders(basket, userId)) {
      basket = await this.prisma.wmsBasket.findFirst({
        where: {
          id,
          status: {
            in: [...PACK_QUEUE_BASKET_STATUSES],
          },
          ...tenantScopeWhere,
        },
        include: this.mobileBasketInclude(),
      });
      if (!basket) {
        throw new ConflictException(
          'Canceled POS orders were released and this basket left the pack queue. Refresh the queue.',
        );
      }
    }

    return basket;
  }

  private async findPackingBasketForUnitScanAction(
    user: BootstrapUser,
    id: string,
    requestedTenantId?: string | null,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: requestedTenantId ?? undefined } as GetWmsMobileStockDto,
      request,
    );
    const fulfillmentGoLiveWhere = this.buildFulfillmentGoLiveWhere(
      await this.getFulfillmentGoLiveAt(tenantContext.tenantId),
    );
    const tenantScopeWhere: Prisma.WmsBasketWhereInput = tenantContext.tenantId
      ? {
          OR: [
            { tenantId: tenantContext.tenantId },
            {
              fulfillmentOrders: {
                some: {
                  tenantId: tenantContext.tenantId,
                  ...fulfillmentGoLiveWhere,
                },
              },
            },
          ],
        }
      : {};
    const basketQuery = {
      where: {
        id,
        status: WmsBasketStatus.PACKING,
        ...tenantScopeWhere,
      },
      select: {
        id: true,
        tenantId: true,
        barcode: true,
        status: true,
        assignedPackerId: true,
        fulfillmentOrders: {
          where: {
            status: { in: [...ACTIVE_BASKET_ORDER_STATUSES] },
          },
          select: {
            id: true,
            tenantId: true,
            storeId: true,
            shopId: true,
            posOrderId: true,
            status: true,
            assignmentMode: true,
            posOrder: {
              select: {
                status: true,
                isVoid: true,
              },
            },
          },
        },
      },
    } satisfies Prisma.WmsBasketFindFirstArgs;
    let basket = await this.prisma.wmsBasket.findFirst(basketQuery);

    if (!basket) {
      throw new NotFoundException('Pack basket was not found');
    }

    this.assertLegacyReservedStoxAccessAllowedForBasket(basket);
    this.assertDemandPackingBasket(basket);
    await this.assertPackingBasketUserAccess(user, basket);

    const userId = user.userId || user.id || null;
    if (await this.reconcileCanceledBasketOrders(basket, userId)) {
      basket = await this.prisma.wmsBasket.findFirst(basketQuery);
      if (!basket) {
        throw new ConflictException(
          'Canceled POS orders were released and this basket left the pack queue. Refresh the queue.',
        );
      }
      this.assertDemandPackingBasket(basket);
    }

    return basket;
  }

  private async assertPackingBasketUserAccess(
    user: BootstrapUser,
    basket: { assignedPackerId?: string | null },
  ) {

    const userId = user.userId || user.id || null;
    let permissions: string[] = [];
    let isPackSupervisor = user.role === 'SUPER_ADMIN';

    if (userId) {
      const [access, taskAssignment] = await Promise.all([
        this.effectiveAccessService.resolveUserAccess({
          userId,
          basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
          workspace: 'wms',
        }),
        this.getWmsTaskAssignment(userId),
      ]);
      permissions = access.permissions;
      this.assertPackExecutionAccess(user, permissions, taskAssignment);
      isPackSupervisor = isPackSupervisor || this.hasAnyRequiredPermission(permissions, PACK_SUPERVISOR_PERMISSIONS);
    }

    if (!isPackSupervisor && basket.assignedPackerId !== userId) {
      throw new ForbiddenException('This pack basket is assigned to another staff member');
    }
  }

  private async findPackingOrderForAction(
    user: BootstrapUser,
    id: string,
    requestedTenantId?: string | null,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: requestedTenantId ?? undefined } as GetWmsMobileStockDto,
      request,
    );
    const fulfillmentGoLiveWhere = this.buildFulfillmentGoLiveWhere(
      await this.getFulfillmentGoLiveAt(tenantContext.tenantId),
    );
    const order = await this.prisma.wmsFulfillmentOrder.findFirst({
      where: {
        id,
        ...(tenantContext.tenantId ? { tenantId: tenantContext.tenantId } : {}),
        ...fulfillmentGoLiveWhere,
        status: {
          in: [...PACK_LIST_ORDER_STATUSES],
        },
      },
      include: this.pickingTaskInclude(),
    });

    if (!order) {
      throw new NotFoundException('Pack task was not found');
    }

    this.assertLegacyReservedStoxAccessAllowedForOrder(order);

    const userId = user.userId || user.id || null;
    let permissions: string[] = [];
    let isPackSupervisor = user.role === 'SUPER_ADMIN';

    if (userId) {
      const [access, taskAssignment] = await Promise.all([
        this.effectiveAccessService.resolveUserAccess({
          userId,
          basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
          workspace: 'wms',
        }),
        this.getWmsTaskAssignment(userId),
      ]);
      permissions = access.permissions;
      this.assertPackExecutionAccess(user, permissions, taskAssignment);
      isPackSupervisor = isPackSupervisor || this.hasAnyRequiredPermission(permissions, PACK_SUPERVISOR_PERMISSIONS);
    }

    if (!isPackSupervisor) {
      if (order.status === WmsFulfillmentOrderStatus.PACKED) {
        if (order.packedById !== userId) {
          throw new ForbiddenException('This packed task belongs to another staff member');
        }
      } else if (order.basket?.assignedPackerId !== userId) {
        throw new ForbiddenException('This pack task is assigned to another staff member');
      }
    }

    return order;
  }

  private async findPackingOrderByIdForAction(
    user: BootstrapUser,
    id: string,
    request?: Request,
  ) {
    const orderReference = await this.prisma.wmsFulfillmentOrder.findUnique({
      where: { id },
      select: { tenantId: true },
    });

    if (!orderReference) {
      throw new NotFoundException('Pack task was not found');
    }

    return this.findPackingOrderForAction(user, id, orderReference.tenantId, request);
  }

  private isStoxPackingProofRequired() {
    return ['1', 'true', 'yes', 'on'].includes(
      String(process.env.WMS_STOX_PACKING_PROOF_REQUIRED ?? 'false').trim().toLowerCase(),
    );
  }

  private async assertPackingProofExists(
    tx: Prisma.TransactionClient,
    fulfillmentOrderId: string,
    posOrderId: string,
  ) {
    const proof = await tx.wmsPackingProof.findFirst({
      where: { fulfillmentOrderId },
      select: { id: true },
    });

    if (!proof) {
      throw new BadRequestException(`Packing proof is required for order ${posOrderId}`);
    }
  }

  private async mapPackingProof(proof: {
    id: string;
    source: WmsPackingProofSource;
    createdAt: Date;
    mediaAsset: {
      objectKey: string;
      contentType: string;
      byteSize: number;
      width: number | null;
      height: number | null;
      originalFileName: string | null;
    };
    uploadedBy: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string;
    };
  }) {
    const uploadedByName = [proof.uploadedBy.firstName, proof.uploadedBy.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      id: proof.id,
      source: proof.source,
      createdAt: proof.createdAt,
      imageUrl: await this.mediaAssetsService.createSignedAssetUrl(proof.mediaAsset),
      contentType: proof.mediaAsset.contentType,
      byteSize: proof.mediaAsset.byteSize,
      width: proof.mediaAsset.width,
      height: proof.mediaAsset.height,
      originalFileName: proof.mediaAsset.originalFileName,
      uploadedBy: {
        id: proof.uploadedBy.id,
        name: uploadedByName || proof.uploadedBy.email,
        email: proof.uploadedBy.email,
      },
    };
  }

  private async findLinkedTaskForUnit(unitId: string, tenantId: string | null) {
    const reservation = await this.prisma.wmsPickReservation.findFirst({
      where: {
        inventoryUnitId: unitId,
        status: {
          in: [...ACTIVE_PICK_RESERVATION_STATUSES],
        },
        ...(tenantId
          ? {
              fulfillmentOrder: {
                is: {
                  tenantId,
                },
              },
            }
          : {}),
      },
      include: {
        fulfillmentOrder: {
          include: this.pickingTaskInclude(),
        },
      },
      orderBy: [{ pickedAt: 'desc' }, { createdAt: 'desc' }],
    });

    return reservation?.fulfillmentOrder ?? null;
  }

  private async findSiblingBasketReservationForPackingUnit(
    unitId: string,
    basketId: string,
    currentOrderId: string,
  ) {
    return this.prisma.wmsPickReservation.findFirst({
      where: {
        inventoryUnitId: unitId,
        status: WmsPickReservationStatus.PICKED,
        fulfillmentOrderId: {
          not: currentOrderId,
        },
        fulfillmentOrder: {
          is: {
            basketId,
            status: {
              in: [...ACTIVE_BASKET_ORDER_STATUSES],
            },
          },
        },
      },
      include: {
        fulfillmentOrder: {
          select: {
            id: true,
            posOrderId: true,
            status: true,
          },
        },
      },
      orderBy: [{ pickedAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private assertPackingTaskReadyToStart(order: any) {
    if (order.status !== WmsFulfillmentOrderStatus.PICKED && order.status !== WmsFulfillmentOrderStatus.PACKING) {
      throw new BadRequestException(`Order ${order.posOrderId} is ${this.formatEnumLabel(order.status)} and cannot start packing`);
    }

    if (!order.basket) {
      throw new BadRequestException(`Order ${order.posOrderId} has no basket assigned for packing`);
    }

    if (order.basket.status !== WmsBasketStatus.FULL_HELD && order.basket.status !== WmsBasketStatus.PACKING) {
      throw new BadRequestException(`Basket ${order.basket.barcode} is ${this.formatEnumLabel(order.basket.status)} and cannot be packed`);
    }

    this.assertPackOrderItemsMatchPos(order);
  }

  private assertPackingTaskInProgress(order: any) {
    if (order.status !== WmsFulfillmentOrderStatus.PACKING) {
      throw new BadRequestException(`Order ${order.posOrderId} must be started in PACK before scanning`);
    }

    if (!order.basket) {
      throw new BadRequestException(`Order ${order.posOrderId} has no basket assigned for packing`);
    }

    if (order.basket.status !== WmsBasketStatus.PACKING) {
      throw new BadRequestException(`Basket ${order.basket.barcode} is not in packing state`);
    }

    this.assertPackOrderItemsMatchPos(order);
  }

  private assertDemandPackingBasket(basket: any) {
    if (!this.isDemandPickingBasket(basket)) {
      throw new BadRequestException(`Basket ${basket.barcode} still uses legacy reserved packing`);
    }

    if (
      basket.status !== WmsBasketStatus.FULL_HELD
      && basket.status !== WmsBasketStatus.PACKING
    ) {
      throw new BadRequestException(`Basket ${basket.barcode} is ${this.formatEnumLabel(basket.status)} and cannot be packed`);
    }
  }

  private assertDemandPickBasketVoidable(basket: any) {
    if (!this.isDemandPickingBasket(basket)) {
      throw new BadRequestException(`Basket ${basket.barcode} still uses legacy reserved picking`);
    }

    if (
      basket.status !== WmsBasketStatus.ASSIGNED
      && basket.status !== WmsBasketStatus.IN_PICKING
      && basket.status !== WmsBasketStatus.FULL_HELD
      && basket.status !== WmsBasketStatus.PACKING
    ) {
      throw new BadRequestException(`Basket ${basket.barcode} is ${this.formatEnumLabel(basket.status)} and cannot be voided`);
    }
  }

  private assertNoOtherDemandPackOrderInProgress(basket: any, allowedOrderId: string) {
    const activeOrder = this.getMobileBasketOrders(basket).find((order: any) => (
      order.status === WmsFulfillmentOrderStatus.PACKING
      && order.id !== allowedOrderId
    ));

    if (activeOrder) {
      throw new BadRequestException(`Finish order ${activeOrder.posOrderId} before scanning the next waybill`);
    }
  }

  private assertPackingTaskVoidable(order: any) {
    if (
      order.status !== WmsFulfillmentOrderStatus.PICKED
      && order.status !== WmsFulfillmentOrderStatus.PACKING
    ) {
      throw new BadRequestException(`Order ${order.posOrderId} is ${this.formatEnumLabel(order.status)} and cannot be voided from PACK`);
    }
  }

  private assertPackOrderNotCanceledInPos(order: any) {
    const posStatus = typeof order.posOrder?.status === 'number' ? order.posOrder.status : null;
    if (posStatus === CANCELED_POS_ORDER_STATUS || order.posOrder?.isVoid) {
      throw new ConflictException(`Order ${order.posOrderId} was canceled in POS. Void it from PACK before continuing`);
    }
  }

  private assertPackOrderItemsMatchPos(order: any) {
    if (order.changeState && order.changeState !== WmsFulfillmentChangeState.NONE) {
      const summary = this.asJsonRecord(order.changeSummary);
      throw new ConflictException(
        this.readString(summary?.message)
        ?? `Order ${order.posOrderId} changed in POS. Its pick list was rebuilt automatically; finish the guided rework before packing.`,
      );
    }
    const itemChange = this.resolveFulfillmentOrderItemChange(order);
    if (!itemChange?.hasChanged) {
      return;
    }

    throw new ConflictException(
      itemChange.message
      ?? `Order ${order.posOrderId} items changed in POS. Refresh while WMS applies the automatic Pick rework.`,
    );
  }

  private resolveFulfillmentAdjustment(order: any) {
    const adjustments = Array.isArray(order?.fulfillmentAdjustments)
      ? order.fulfillmentAdjustments
      : [];
    if (adjustments.length === 0) {
      return null;
    }

    const bypassedUnits = adjustments
      .filter((adjustment: any) => adjustment.type === 'BYPASS')
      .reduce((sum: number, adjustment: any) => sum + Math.max(adjustment.quantity ?? 0, 0), 0);
    const substitutedUnits = adjustments
      .filter((adjustment: any) => adjustment.type === 'SUBSTITUTION')
      .reduce((sum: number, adjustment: any) => sum + Math.max(adjustment.quantity ?? 0, 0), 0);

    return {
      hasAdjustments: true,
      sourceTotalRequired: order.sourceTotalQuantity ?? order.totalQuantity ?? 0,
      effectiveTotalRequired: order.totalQuantity ?? 0,
      bypassedUnits,
      substitutedUnits,
      items: adjustments.map((adjustment: any) => ({
        id: adjustment.id,
        type: adjustment.type,
        quantity: adjustment.quantity,
        sourceVariationId: adjustment.sourceVariationId,
        sourceProductName: adjustment.sourceProductName,
        sourceProductDisplayId: adjustment.sourceProductDisplayId ?? null,
        substituteVariationId: adjustment.substituteVariationId ?? null,
        substituteProductName: adjustment.substituteProductName ?? null,
        substituteProductDisplayId: adjustment.substituteProductDisplayId ?? null,
        reason: adjustment.reason,
        approvedBy: this.mapActor(adjustment.createdBy),
        approvedAt: adjustment.createdAt,
      })),
    };
  }

  private resolveFulfillmentOrderItemChange(order: any) {
    const summary = this.asJsonRecord(order?.changeSummary);
    const changeState = order?.changeState ?? WmsFulfillmentChangeState.NONE;
    const sourceLines = Array.isArray(order?.lines)
      ? order.lines.filter((line: any) => (
          Math.max(line.sourceQuantityRequired ?? line.quantityRequired ?? 0, 0) > 0
        ))
      : [];
    const canCompareLiveSnapshot =
      Boolean(order?.posOrder?.orderSnapshot)
      && sourceLines.length > 0
      && sourceLines.every((line: any) => 'lineSnapshot' in line);
    const hasUnappliedLiveSnapshotDiff = canCompareLiveSnapshot
      && !this.areDemandSignaturesEqual(
        this.buildOrderSnapshotDemandSignature(order.posOrder.orderSnapshot),
        this.buildFulfillmentLineDemandSignature(sourceLines),
      );

    if ((order?.changeDetectedAt || summary) && !hasUnappliedLiveSnapshotDiff) {
      const completedDetachment = changeState === WmsFulfillmentChangeState.NONE
        && Boolean(this.readString(summary?.detachedAt));
      if (completedDetachment) {
        return null;
      }

      const reworkGuide = changeState === WmsFulfillmentChangeState.NONE
        ? { returnSteps: [], pickSteps: [] }
        : this.resolveFulfillmentReworkGuide(order, summary);
      const detachment = this.resolveFulfillmentDetachment(order);
      return {
        hasChanged: changeState !== WmsFulfillmentChangeState.NONE,
        autoRebuilt: summary?.autoRebuilt === true,
        requiresAction: changeState !== WmsFulfillmentChangeState.NONE,
        state: changeState,
        detectedAt: order.changeDetectedAt ?? null,
        title: this.readString(summary?.notificationTitle)
          ?? (changeState === WmsFulfillmentChangeState.NONE
            ? 'Order updated — pick list refreshed'
            : 'Order changed — rework required'),
        message: this.readString(summary?.message)
          ?? (changeState === WmsFulfillmentChangeState.NONE
            ? `Order ${order.posOrderId} was updated automatically.`
            : `Order ${order.posOrderId} changed in POS. Follow the updated pick steps before continuing.`),
        addedUnits: typeof summary?.addedUnits === 'number' ? summary.addedUnits : 0,
        removedUnits: typeof summary?.removedUnits === 'number' ? summary.removedUnits : 0,
        returnUnitsRemaining: typeof summary?.returnUnitsRemaining === 'number' ? summary.returnUnitsRemaining : 0,
        pickUnitsRequired: typeof summary?.pickUnitsRequired === 'number' ? summary.pickUnitsRequired : 0,
        added: Array.isArray(summary?.added) ? summary.added : [],
        removed: Array.isArray(summary?.removed) ? summary.removed : [],
        increased: Array.isArray(summary?.increased) ? summary.increased : [],
        decreased: Array.isArray(summary?.decreased) ? summary.decreased : [],
        order: {
          id: order.id,
          posOrderId: order.posOrderId,
          tracking: this.readString(order.posOrder?.tracking) ?? null,
          basketCode: this.readString(order.basket?.barcode) ?? null,
        },
        returnSteps: reworkGuide.returnSteps,
        pickSteps: reworkGuide.pickSteps,
        detachment,
      };
    }
    if (!order || !Array.isArray(order.lines) || !order.posOrder?.orderSnapshot) {
      return null;
    }

    if (sourceLines.length === 0) {
      return null;
    }

    const currentSignature = this.buildOrderSnapshotDemandSignature(order.posOrder.orderSnapshot);
    const fulfillmentSignature = this.buildFulfillmentLineDemandSignature(sourceLines);

    if (this.areDemandSignaturesEqual(currentSignature, fulfillmentSignature)) {
      return null;
    }

    const activeExecutionStatuses = new Set<WmsFulfillmentOrderStatus>([
      WmsFulfillmentOrderStatus.IN_PICKING,
      WmsFulfillmentOrderStatus.READY_FOR_PACK,
      WmsFulfillmentOrderStatus.PICKED,
      WmsFulfillmentOrderStatus.PACKING,
      WmsFulfillmentOrderStatus.PACKED,
    ]);

    return {
      hasChanged: true,
      autoRebuilt: false,
      requiresAction: true,
      state: WmsFulfillmentChangeState.EXCEPTION,
      detectedAt: null,
      title: 'POS order update detected',
      message: activeExecutionStatuses.has(order.status)
        ? `Order ${order.posOrderId} items changed in POS. Refresh while WMS applies the automatic Pick rework.`
        : `Order ${order.posOrderId} items changed in POS. WMS is refreshing its fulfillment requirements automatically.`,
      addedUnits: 0,
      removedUnits: 0,
      returnUnitsRemaining: 0,
      pickUnitsRequired: 0,
      added: [],
      removed: [],
      increased: [],
      decreased: [],
      order: {
        id: order.id,
        posOrderId: order.posOrderId,
        tracking: this.readString(order.posOrder?.tracking) ?? null,
        basketCode: this.readString(order.basket?.barcode) ?? null,
      },
      returnSteps: [],
      pickSteps: [],
      detachment: null,
    };
  }

  private resolveFulfillmentDetachment(order: any) {
    const amendment = Array.isArray(order?.amendments) ? order.amendments[0] : null;
    const requiredActions = this.asJsonRecord(amendment?.requiredActions);
    const detachment = this.asJsonRecord(requiredActions?.detach);
    if (!detachment || detachment.status !== 'RETURNING') {
      return null;
    }

    const units = (Array.isArray(detachment.units) ? detachment.units : [])
      .map((rawUnit) => this.asJsonRecord(rawUnit))
      .filter((unit): unit is Record<string, unknown> => Boolean(unit))
      .map((unit) => {
        const destinationBin = this.asJsonRecord(unit.destinationBin);
        return {
          basketUnitId: this.readString(unit.basketUnitId) ?? '',
          inventoryUnitId: this.readString(unit.inventoryUnitId) ?? '',
          variationId: this.readString(unit.variationId) ?? '',
          productName: this.readString(unit.productName) ?? 'Picked item',
          productDisplayId: this.readString(unit.productDisplayId),
          code: this.readString(unit.code),
          barcode: this.readString(unit.barcode),
          destinationBin: destinationBin
            ? {
                id: this.readString(destinationBin.id) ?? '',
                code: this.readString(destinationBin.code) ?? '',
                barcode: this.readString(destinationBin.barcode),
                name: this.readString(destinationBin.name) ?? this.readString(destinationBin.code) ?? 'Return bin',
                kind: this.readString(destinationBin.kind) ?? WmsLocationKind.BIN,
              }
            : null,
          returnedAt: this.readString(unit.returnedAt),
        };
      })
      .filter((unit) => unit.basketUnitId && unit.inventoryUnitId && unit.variationId);
    const returnedUnits = units.filter((unit) => Boolean(unit.returnedAt)).length;

    return {
      status: 'RETURNING' as const,
      reason: this.readString(detachment.reason) ?? '',
      confirmedAt: this.readString(detachment.confirmedAt),
      totalUnits: units.length,
      returnedUnits,
      remainingUnits: Math.max(units.length - returnedUnits, 0),
      units,
    };
  }

  private resolveFulfillmentReworkGuide(
    order: any,
    summary: Record<string, unknown> | null,
  ) {
    const amendment = Array.isArray(order?.amendments) ? order.amendments[0] : null;
    const requiredActions = this.asJsonRecord(amendment?.requiredActions);
    const returnActions = this.readFulfillmentReworkActions({
      raw: requiredActions?.return,
      fallbackChanges: [
        ...(Array.isArray(summary?.removed) ? summary.removed : []),
        ...(Array.isArray(summary?.decreased) ? summary.decreased : []),
      ],
      fallbackTotal: typeof summary?.returnUnitsRemaining === 'number'
        ? summary.returnUnitsRemaining
        : 0,
    });
    const pickActions = this.readFulfillmentReworkActions({
      raw: requiredActions?.pick,
      fallbackChanges: [
        ...(Array.isArray(summary?.added) ? summary.added : []),
        ...(Array.isArray(summary?.increased) ? summary.increased : []),
      ],
      fallbackTotal: typeof summary?.pickUnitsRequired === 'number'
        ? summary.pickUnitsRequired
        : 0,
    });
    const lines = Array.isArray(order?.lines) ? order.lines : [];
    const basketUnits = [
      ...(Array.isArray(order?.reworkBasketUnits) ? order.reworkBasketUnits : []),
      ...(Array.isArray(order?.basketUnits) ? order.basketUnits : []),
    ]
      .filter((basketUnit: any, index: number, all: any[]) => (
        basketUnit?.id
        && all.findIndex((candidate) => candidate?.id === basketUnit.id) === index
        && ACTIVE_BASKET_UNIT_STATUSES.includes(basketUnit.status)
        && (
          basketUnit.fulfillmentOrderId === order.id
          || !basketUnit.fulfillmentOrderId
        )
      ))
      .sort((left: any, right: any) => (
        Number(right.fulfillmentOrderId === order.id) - Number(left.fulfillmentOrderId === order.id)
      ));
    const demands = Array.isArray(order?.basketPickDemands) ? order.basketPickDemands : [];

    const returnSteps = returnActions.map((action) => {
      const line = lines.find((candidate: any) => candidate.variationId === action.variationId) ?? null;
      const serializedUnits = basketUnits
        .filter((basketUnit: any) => basketUnit.variationId === action.variationId)
        .slice(0, action.quantity)
        .map((basketUnit: any) => ({
          id: basketUnit.inventoryUnit?.id ?? basketUnit.inventoryUnitId,
          code: basketUnit.inventoryUnit?.code ?? null,
          barcode: basketUnit.inventoryUnit?.barcode ?? null,
          sourceBin: basketUnit.sourceLocation
            ? this.mapLocation(basketUnit.sourceLocation)
            : null,
        }));

      return {
        variationId: action.variationId,
        productName: action.productName || line?.productName || 'Changed item',
        productDisplayId: line?.productDisplayId ?? null,
        quantity: action.quantity,
        serializedUnits,
        unidentifiedQuantity: Math.max(action.quantity - serializedUnits.length, 0),
      };
    });

    const pickSteps = pickActions.map((action) => {
      const line = lines.find((candidate: any) => candidate.variationId === action.variationId) ?? null;
      const demand = demands.find((candidate: any) => candidate.variationId === action.variationId) ?? null;
      const reservedUnits = (line?.reservations ?? [])
        .filter((reservation: any) => reservation.status === WmsPickReservationStatus.RESERVED)
        .slice(0, action.quantity)
        .map((reservation: any) => ({
          id: reservation.inventoryUnit?.id ?? reservation.inventoryUnitId,
          code: reservation.inventoryUnit?.code ?? null,
          barcode: reservation.inventoryUnit?.barcode ?? null,
          sourceBin: reservation.inventoryUnit?.currentLocation
            ? this.mapLocation(reservation.inventoryUnit.currentLocation)
            : null,
        }));
      const sourceBins = (demand?.bins ?? [])
        .map((bin: any) => ({
          location: bin.location ? this.mapLocation(bin.location) : null,
          quantity: Math.max((bin.quantityTarget ?? 0) - (bin.quantityPicked ?? 0), 0),
        }))
        .filter((bin: any) => bin.location && bin.quantity > 0);
      const allocatedQuantity = reservedUnits.length > 0
        ? reservedUnits.length
        : sourceBins.reduce((total: number, bin: any) => total + bin.quantity, 0);

      return {
        variationId: action.variationId,
        productName: action.productName || demand?.productName || line?.productName || 'Changed item',
        productDisplayId: demand?.productDisplayId ?? line?.productDisplayId ?? null,
        quantity: action.quantity,
        serializedUnits: reservedUnits,
        sourceBins,
        unallocatedQuantity: Math.max(action.quantity - allocatedQuantity, 0),
        scanAnyMatchingUnit: reservedUnits.length === 0 && sourceBins.length > 0,
      };
    });

    return { returnSteps, pickSteps };
  }

  private readFulfillmentReworkActions(params: {
    raw: unknown;
    fallbackChanges: unknown[];
    fallbackTotal: number;
  }) {
    if (Array.isArray(params.raw)) {
      return params.raw
        .map((value) => {
          const action = this.asJsonRecord(value);
          const variationId = this.readString(action?.variationId);
          const quantity = typeof action?.quantity === 'number'
            ? Math.max(Math.trunc(action.quantity), 0)
            : 0;
          if (!variationId || quantity <= 0) {
            return null;
          }
          return {
            variationId,
            productName: this.readString(action?.productName) ?? '',
            quantity,
          };
        })
        .filter((action): action is { variationId: string; productName: string; quantity: number } => Boolean(action));
    }

    let remaining = Math.max(Math.trunc(params.fallbackTotal), 0);
    return params.fallbackChanges
      .map((value) => {
        const change = this.asJsonRecord(value);
        const variationId = this.readString(change?.variationId);
        const delta = typeof change?.delta === 'number' ? Math.abs(Math.trunc(change.delta)) : 0;
        const quantity = Math.min(delta, remaining);
        if (!variationId || quantity <= 0) {
          return null;
        }
        remaining -= quantity;
        return {
          variationId,
          productName: this.readString(change?.productName) ?? '',
          quantity,
        };
      })
      .filter((action): action is { variationId: string; productName: string; quantity: number } => Boolean(action));
  }

  private buildOrderSnapshotDemandSignature(orderSnapshot: Prisma.JsonValue | null) {
    const signature = new Map<string, number>();
    const snapshot = this.asJsonRecord(orderSnapshot);
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];

    for (const rawItem of items) {
      const item = this.asJsonRecord(rawItem);
      if (!item) {
        continue;
      }

      const variationInfo = this.asJsonRecord(item.variation_info);
      const quantity = this.readPositiveInt(item.quantity);
      const returnedQuantity =
        this.readPositiveInt(item.returned_count)
        + this.readPositiveInt(item.return_quantity)
        + this.readPositiveInt(item.returning_quantity);
      const requiredQuantity = Math.max(quantity - returnedQuantity, 0);
      if (requiredQuantity <= 0) {
        continue;
      }

      const comparisonKey = this.buildDemandComparisonKey({
        variationId: this.readIdentifier(item.variation_id) ?? this.readIdentifier(item.variationId) ?? null,
        productId: this.readIdentifier(item.product_id) ?? this.readIdentifier(item.productId) ?? null,
        productDisplayId:
          this.readIdentifier(item.product_display_id)
          ?? this.readIdentifier(item.productDisplayId)
          ?? this.readIdentifier(variationInfo?.display_id)
          ?? this.readIdentifier(variationInfo?.product_display_id)
          ?? this.readIdentifier(variationInfo?.barcode)
          ?? null,
        productName:
          this.readString(variationInfo?.name)
          ?? this.readString(item.note_product)
          ?? this.readString(item.name)
          ?? null,
      });

      signature.set(comparisonKey, (signature.get(comparisonKey) ?? 0) + requiredQuantity);
    }

    return signature;
  }

  private buildFulfillmentLineDemandSignature(lines: any[]) {
    const signature = new Map<string, number>();

    for (const line of lines) {
      const lineSnapshot = this.asJsonRecord(line.lineSnapshot);
      const sourceItem = this.asJsonRecord(lineSnapshot?.sourceItem);
      const variationInfo = this.asJsonRecord(sourceItem?.variation_info);
      const quantity = Math.max(line.sourceQuantityRequired ?? line.quantityRequired ?? 0, 0);
      if (quantity <= 0) {
        continue;
      }

      const comparisonKey = this.buildDemandComparisonKey({
        variationId:
          this.readIdentifier(lineSnapshot?.sourceVariationId)
          ?? this.readIdentifier(sourceItem?.variation_id)
          ?? this.readIdentifier(sourceItem?.variationId)
          ?? line.variationId
          ?? null,
        productId:
          this.readIdentifier(lineSnapshot?.sourceProductId)
          ?? this.readIdentifier(sourceItem?.product_id)
          ?? this.readIdentifier(sourceItem?.productId)
          ?? line.productId
          ?? null,
        productDisplayId:
          this.readIdentifier(lineSnapshot?.productDisplayId)
          ?? this.readIdentifier(sourceItem?.product_display_id)
          ?? this.readIdentifier(sourceItem?.productDisplayId)
          ?? this.readIdentifier(variationInfo?.display_id)
          ?? this.readIdentifier(variationInfo?.product_display_id)
          ?? this.readIdentifier(variationInfo?.barcode)
          ?? line.productDisplayId
          ?? null,
        productName:
          this.readString(variationInfo?.name)
          ?? this.readString(lineSnapshot?.productName)
          ?? this.readString(sourceItem?.note_product)
          ?? line.productName
          ?? null,
      });

      signature.set(comparisonKey, (signature.get(comparisonKey) ?? 0) + quantity);
    }

    return signature;
  }

  private buildDemandComparisonKey(params: {
    variationId: string | null;
    productId: string | null;
    productDisplayId: string | null;
    productName: string | null;
  }) {
    const variationId = params.variationId?.trim();
    return `variation::${variationId ?? ''}`;
  }

  private normalizeDemandComparisonText(value: string | null | undefined) {
    return (value ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  private areDemandSignaturesEqual(left: Map<string, number>, right: Map<string, number>) {
    if (left.size !== right.size) {
      return false;
    }

    for (const [key, value] of left.entries()) {
      if ((right.get(key) ?? null) !== value) {
        return false;
      }
    }

    return true;
  }

  private assertOrderHasTracking(order: any) {
    const tracking = this.cleanOptionalText(order.posOrder?.tracking ?? null);
    if (!tracking) {
      throw new BadRequestException(`Order ${order.posOrderId} is still waiting for its tracking number`);
    }

    return tracking;
  }

  private assertTrackingCodeMatchesOrder(order: any, code: string) {
    const expected = this.normalizeTrackingCode(this.assertOrderHasTracking(order));
    const scanned = this.normalizeTrackingCode(code);

    if (expected !== scanned) {
      throw new BadRequestException(`Tracking code ${scanned} does not match order ${order.posOrderId}`);
    }

    return expected;
  }

  private async resolveDirectPackVoidAccess(userId: string, user: BootstrapUser) {
    const access = await this.effectiveAccessService.resolveUserAccess({
      userId,
      basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
      workspace: 'wms',
    });

    return {
      allowed: user.role === 'SUPER_ADMIN' || this.hasAnyRequiredPermission(access.permissions, PACK_VOID_DIRECT_PERMISSIONS),
      permissions: access.permissions,
    };
  }

  private async assertPickSupervisorAccess(user: BootstrapUser) {
    const userId = user.userId || user.id || null;
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    if (user.role === 'SUPER_ADMIN') {
      return;
    }

    const access = await this.effectiveAccessService.resolveUserAccess({
      userId,
      basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
      workspace: 'wms',
    });

    if (this.hasAnyRequiredPermission(access.permissions, PICK_SUPERVISOR_PERMISSIONS)) {
      return;
    }

    throw new ForbiddenException('This account does not have WMS pick override access');
  }

  private async resolvePackVoidSupervisorApproval(params: {
    requester: BootstrapUser;
    tenantId: string;
    request?: Request;
    supervisorIdentifier?: string;
    supervisorPassword?: string;
  }) {
    const requesterId = params.requester.userId || params.requester.id || null;
    const identifier = this.cleanOptionalText(params.supervisorIdentifier);
    const password = params.supervisorPassword?.trim() ?? '';

    if (!requesterId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    if (!identifier || !password) {
      throw new ForbiddenException('Supervisor approval is required to void this order');
    }

    const normalizedEmail = identifier.toLowerCase();
    const supervisor = await this.prisma.user.findFirst({
      where: {
        tenantId: null,
        status: UserStatus.ACTIVE,
        OR: [
          { email: normalizedEmail },
          { employeeId: identifier },
        ],
      },
      select: {
        id: true,
        email: true,
        employeeId: true,
        password: true,
        role: true,
      },
    });

    if (!supervisor) {
      await this.wmsStaffActivityService.recordFromRequest({
        request: params.request,
        tenantId: params.tenantId,
        actorId: requesterId,
        sessionId: (this.cls.get('sessionId') as string | undefined) || params.requester.sessionId || null,
        actionType: 'PACKING_VOID_REQUEST',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        outcome: WmsStaffActivityOutcome.REJECTED,
        reasonCode: 'SUPERVISOR_NOT_FOUND',
        metadata: {
          supervisorIdentifier: identifier,
        },
      });
      throw new ForbiddenException('Supervisor approval failed');
    }

    if (supervisor.id === requesterId) {
      throw new ForbiddenException('A different supervisor must approve this void');
    }

    const passwordValid = await bcrypt.compare(password, supervisor.password);
    if (!passwordValid) {
      await this.wmsStaffActivityService.recordFromRequest({
        request: params.request,
        tenantId: params.tenantId,
        actorId: requesterId,
        sessionId: (this.cls.get('sessionId') as string | undefined) || params.requester.sessionId || null,
        actionType: 'PACKING_VOID_REQUEST',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        outcome: WmsStaffActivityOutcome.REJECTED,
        reasonCode: 'SUPERVISOR_INVALID_CREDENTIALS',
        metadata: {
          supervisorId: supervisor.id,
          supervisorIdentifier: identifier,
        },
      });
      throw new ForbiddenException('Supervisor approval failed');
    }

    const access = await this.effectiveAccessService.resolveUserAccess({
      userId: supervisor.id,
      basePermissions: [],
      workspace: 'wms',
    });

    const canApprove = supervisor.role === 'SUPER_ADMIN'
      || this.hasAnyRequiredPermission(access.permissions, PACK_VOID_DIRECT_PERMISSIONS);

    if (!canApprove) {
      await this.wmsStaffActivityService.recordFromRequest({
        request: params.request,
        tenantId: params.tenantId,
        actorId: requesterId,
        sessionId: (this.cls.get('sessionId') as string | undefined) || params.requester.sessionId || null,
        actionType: 'PACKING_VOID_REQUEST',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        outcome: WmsStaffActivityOutcome.REJECTED,
        reasonCode: 'SUPERVISOR_NOT_AUTHORIZED',
        metadata: {
          supervisorId: supervisor.id,
          supervisorIdentifier: identifier,
        },
      });
      throw new ForbiddenException('Supervisor is not authorized to approve void');
    }

    return {
      mode: 'SUPERVISOR' as const,
      approver: {
        id: supervisor.id,
        email: supervisor.email,
        employeeId: supervisor.employeeId ?? null,
      },
    };
  }

  private async findVoidRestoreLocations(
    tx: Prisma.TransactionClient,
    fulfillmentOrderId: string,
    inventoryUnitIds: string[],
  ) {
    if (inventoryUnitIds.length === 0) {
      return new Map<string, { locationId: string; status: WmsInventoryUnitStatus }>();
    }

    const movements = await tx.wmsInventoryMovement.findMany({
      where: {
        referenceType: 'WMS_FULFILLMENT_ORDER',
        referenceId: fulfillmentOrderId,
        inventoryUnitId: {
          in: inventoryUnitIds,
        },
        movementType: {
          in: [
            WmsInventoryMovementType.PICK,
            WmsInventoryMovementType.RESERVATION,
          ],
        },
        OR: [
          { fromLocationId: { not: null } },
          { toLocationId: { not: null } },
        ],
      },
      select: {
        inventoryUnitId: true,
        fromLocationId: true,
        toLocationId: true,
        fromStatus: true,
        createdAt: true,
      },
      orderBy: [
        { createdAt: 'desc' },
      ],
    });

    const restoreLocationByUnitId = new Map<string, { locationId: string; status: WmsInventoryUnitStatus }>();
    for (const movement of movements) {
      if (restoreLocationByUnitId.has(movement.inventoryUnitId)) {
        continue;
      }

      const restoreLocationId = movement.fromLocationId ?? movement.toLocationId;
      if (restoreLocationId) {
        restoreLocationByUnitId.set(movement.inventoryUnitId, {
          locationId: restoreLocationId,
          status: movement.fromStatus === WmsInventoryUnitStatus.DEADSTOCK
            ? WmsInventoryUnitStatus.DEADSTOCK
            : WmsInventoryUnitStatus.PUTAWAY,
        });
      }
    }

    return restoreLocationByUnitId;
  }

  private assertPickingTaskClaimedByUser(
    order: any,
    userId: string | null,
    options: { allowReadyWithoutBasket?: boolean } = {},
  ) {
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    const isReadyBasketScan = options.allowReadyWithoutBasket
      && order.status === WmsFulfillmentOrderStatus.READY
      && !order.basket;

    if (order.status !== WmsFulfillmentOrderStatus.IN_PICKING && !isReadyBasketScan) {
      throw new BadRequestException(`Order ${order.posOrderId} must be claimed before scanning`);
    }

    if (order.claimedById !== userId) {
      throw new ForbiddenException('This pick task is assigned to another staff member');
    }
  }

  private async assertFulfillmentAmendmentResolved(order: any) {
    if (!order?.changeState || order.changeState === WmsFulfillmentChangeState.NONE) {
      return;
    }

    await this.wmsFulfillmentSyncService.resolveFulfillmentAmendmentIfComplete(order.id);
    const current = await this.prisma.wmsFulfillmentOrder.findUnique({
      where: { id: order.id },
      select: { changeState: true, changeSummary: true, posOrderId: true },
    });
    if (!current || current.changeState === WmsFulfillmentChangeState.NONE) {
      return;
    }

    const summary = this.asJsonRecord(current.changeSummary);
    throw new ConflictException(
      this.readString(summary?.message)
      ?? `Order ${current.posOrderId} changed in POS. Finish the highlighted return and pick steps before continuing.`,
    );
  }

  private assertPickingTaskHasBasket(order: any) {
    if (!order.basket) {
      throw new BadRequestException(`Scan a basket before picking order ${order.posOrderId}`);
    }
  }

  private assertPickingBasketAssignedToUser(
    basket: any,
    userId: string | null,
    options: { allowFullHeld?: boolean } = {},
  ) {
    if (!userId) {
      throw new ForbiddenException('Missing WMS user context');
    }

    const allowedStatuses = options.allowFullHeld
      ? [...ACTIVE_PICK_BASKET_STATUSES]
      : [...PICKER_ACTIVE_BASKET_STATUSES];
    if (!allowedStatuses.includes(basket.status)) {
      throw new BadRequestException(`Basket ${basket.barcode} is ${this.formatEnumLabel(basket.status)} and cannot be picked`);
    }

    if (basket.assignedPickerId !== userId) {
      throw new ForbiddenException(`Basket ${basket.barcode} is assigned to another picker`);
    }
  }

  private getAllPickReservations(order: any) {
    return order.lines.flatMap((line: any) => line.reservations);
  }

  private getBasketPickReservationContexts(basket: any) {
    const orders = Array.isArray(basket.fulfillmentOrders)
      ? basket.fulfillmentOrders
      : basket.fulfillmentOrder
        ? [basket.fulfillmentOrder]
        : [];

    return orders.flatMap((order: any) => (
      (order.lines ?? []).flatMap((line: any) => (
        (line.reservations ?? []).map((reservation: any) => ({
          order,
          line,
          reservation,
        }))
      ))
    ));
  }

  private isDemandPickingOrder(order: any) {
    return (order?.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED)
      === WmsFulfillmentAssignmentMode.BASKET_DEMAND;
  }

  private isDemandPickingBasket(basket: any) {
    const orders = Array.isArray(basket?.fulfillmentOrders)
      ? basket.fulfillmentOrders
      : basket?.fulfillmentOrder
        ? [basket.fulfillmentOrder]
        : [];

    return orders.some((order: any) => this.isDemandPickingOrder(order));
  }

  private getBasketDemandPickContexts(basket: any) {
    const orders = Array.isArray(basket.fulfillmentOrders)
      ? basket.fulfillmentOrders
      : basket.fulfillmentOrder
        ? [basket.fulfillmentOrder]
        : [];

    return orders.flatMap((order: any) => {
      const lineById = new Map((order.lines ?? []).map((line: any) => [line.id, line]));

      return (order.basketPickDemands ?? []).flatMap((demand: any) => {
        const line = lineById.get(demand.fulfillmentLineId) ?? null;

        return (demand.bins ?? []).map((bin: any) => ({
          order,
          demand,
          line,
          bin,
          remainingQuantity: Math.max((bin.quantityTarget ?? 0) - (bin.quantityPicked ?? 0), 0),
        }));
      });
    });
  }

  private getPendingPickReservations(order: any) {
    return this.getAllPickReservations(order).filter(
      (reservation: any) => reservation.status === WmsPickReservationStatus.RESERVED,
    );
  }

  private getPackedReservationCount(order: any) {
    return this.getAllPickReservations(order).filter(
      (reservation: any) => this.isPackedEquivalentInventoryStatus(reservation.inventoryUnit.status),
    ).length;
  }

  private getPackedBasketUnitCount(order: any) {
    return Math.min(
      (Array.isArray(order?.basketUnits) ? order.basketUnits : []).filter(
        (basketUnit: any) => this.isHistoricallyPackedDemandBasketUnit(basketUnit),
      ).length,
      Math.max(order?.totalQuantity ?? 0, 0),
    );
  }

  private getPackedBasketUnitCountForLine(
    order: any,
    fulfillmentLineId: string,
    quantityRequired: number,
  ) {
    return Math.min(
      (Array.isArray(order?.basketUnits) ? order.basketUnits : []).filter(
        (basketUnit: any) => (
          this.isHistoricallyPackedDemandBasketUnit(basketUnit)
          && basketUnit.fulfillmentLineId === fulfillmentLineId
        ),
      ).length,
      Math.max(quantityRequired, 0),
    );
  }

  private isHistoricallyPackedDemandBasketUnit(
    basketUnit:
      | {
          status?: WmsBasketUnitStatus | string | null;
          packedAt?: Date | string | null;
        }
      | null
      | undefined,
  ) {
    if (!basketUnit) {
      return false;
    }

    return basketUnit.status === WmsBasketUnitStatus.PACKED
      || (basketUnit.status === WmsBasketUnitStatus.REMOVED && basketUnit.packedAt != null);
  }

  private basketAssignmentOrderInclude() {
    return {
      posOrder: {
        select: {
          status: true,
          isVoid: true,
        },
      },
      lines: true,
    } satisfies Prisma.WmsFulfillmentOrderInclude;
  }

  private basketAssignmentBasketInclude() {
    return {
      warehouse: {
        select: {
          id: true,
          name: true,
        },
      },
      fulfillmentOrders: {
        where: {
          status: {
            in: [...ACTIVE_BASKET_ORDER_STATUSES],
          },
        },
        select: {
          id: true,
          tenantId: true,
          storeId: true,
          assignmentMode: true,
          warehouseId: true,
        },
      },
    } satisfies Prisma.WmsBasketInclude;
  }

  private pickingTaskInclude() {
    return {
      store: {
        select: {
          id: true,
          tenantId: true,
          name: true,
          shopName: true,
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      },
      warehouse: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
      claimedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      packedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      rtsDisposedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      posOrder: {
        select: {
          insertedAt: true,
          dateLocal: true,
          deliveredAt: true,
          orderSnapshot: true,
          status: true,
          statusName: true,
          tracking: true,
          isVoid: true,
        },
      },
      fulfillmentAdjustments: {
        where: { status: 'ACTIVE' },
        include: {
          createdBy: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }],
      },
      amendments: {
        where: { status: 'OPEN' },
        select: {
          id: true,
          requiredActions: true,
          detectedAt: true,
        },
        orderBy: [{ detectedAt: 'desc' }],
        take: 1,
      },
      basket: {
        select: {
          id: true,
          barcode: true,
          status: true,
          maxFulfillmentOrders: true,
          warehouseId: true,
          assignedPackerId: true,
          claimedAt: true,
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
              posOrderId: true,
              status: true,
              customerName: true,
              totalQuantity: true,
              pickedQuantity: true,
              posOrder: {
                select: {
                  tracking: true,
                },
              },
              store: {
                select: {
                  id: true,
                  name: true,
                  shopName: true,
                  tenantId: true,
                  tenant: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
            },
          },
          assignedPacker: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          warehouse: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      },
      basketPickDemands: {
        include: {
          bins: {
            include: {
              location: {
                select: {
                  id: true,
                  code: true,
                  barcode: true,
                  name: true,
                  kind: true,
                },
              },
              warehouse: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                },
              },
            },
            orderBy: [
              { routeSequence: 'asc' },
              { createdAt: 'asc' },
            ],
          },
        },
        orderBy: [{ createdAt: 'asc' }],
      },
      basketUnits: {
        where: {
          OR: [
            {
              status: {
                in: [...ACTIVE_BASKET_UNIT_STATUSES],
              },
            },
            {
              status: WmsBasketUnitStatus.REMOVED,
              packedAt: {
                not: null,
              },
            },
          ],
        },
        include: {
          inventoryUnit: {
            select: {
              id: true,
              code: true,
              barcode: true,
              status: true,
              expirationDate: true,
              productId: true,
              variationId: true,
              warehouseId: true,
              currentLocationId: true,
              posProduct: {
                select: {
                  id: true,
                  name: true,
                  customId: true,
                },
              },
              warehouse: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                },
              },
              currentLocation: {
                select: {
                  id: true,
                  code: true,
                  barcode: true,
                  name: true,
                  kind: true,
                },
              },
            },
          },
          sourceLocation: {
            select: {
              id: true,
              code: true,
              barcode: true,
              name: true,
              kind: true,
            },
          },
        },
        orderBy: [
          { pickedAt: 'asc' },
          { createdAt: 'asc' },
        ],
      },
      lines: {
        include: {
          reservations: {
            include: {
              inventoryUnit: {
                select: {
                  id: true,
                  code: true,
                  barcode: true,
                  status: true,
                  expirationDate: true,
                  productProfile: {
                    select: {
                      requiresExpirationDate: true,
                    },
                  },
                  productId: true,
                  variationId: true,
                  warehouseId: true,
                  currentLocationId: true,
                  posProduct: {
                    select: {
                      id: true,
                      name: true,
                      customId: true,
                    },
                  },
                  warehouse: {
                    select: {
                      id: true,
                      code: true,
                      name: true,
                    },
                  },
                  currentLocation: {
                    select: {
                      id: true,
                      code: true,
                      barcode: true,
                      name: true,
                      kind: true,
                    },
                  },
                },
              },
            },
            orderBy: [{ sequence: 'asc' }],
          },
        },
        orderBy: [{ createdAt: 'asc' }],
      },
    } satisfies Prisma.WmsFulfillmentOrderInclude;
  }

  private packingQueueTaskInclude() {
    return {
      store: {
        select: {
          id: true,
          tenantId: true,
          name: true,
          shopName: true,
          tenant: {
            select: {
              name: true,
            },
          },
        },
      },
      warehouse: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
      claimedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      packedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      posOrder: {
        select: {
          insertedAt: true,
          dateLocal: true,
          deliveredAt: true,
          status: true,
          tracking: true,
        },
      },
      fulfillmentAdjustments: {
        where: { status: 'ACTIVE' },
        include: {
          createdBy: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }],
      },
      amendments: {
        where: { status: 'OPEN' },
        select: {
          id: true,
          requiredActions: true,
          detectedAt: true,
        },
        orderBy: [{ detectedAt: 'desc' }],
        take: 1,
      },
      basket: {
        select: {
          id: true,
          barcode: true,
          status: true,
          maxFulfillmentOrders: true,
          warehouseId: true,
          assignedPackerId: true,
          claimedAt: true,
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
              posOrderId: true,
              status: true,
              customerName: true,
              totalQuantity: true,
              pickedQuantity: true,
              posOrder: {
                select: {
                  tracking: true,
                },
              },
              store: {
                select: {
                  id: true,
                  name: true,
                  shopName: true,
                  tenantId: true,
                  tenant: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
            },
          },
          assignedPicker: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          assignedPacker: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          warehouse: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      },
      basketUnits: {
        where: {
          OR: [
            {
              status: {
                in: [...ACTIVE_BASKET_UNIT_STATUSES],
              },
            },
            {
              status: WmsBasketUnitStatus.REMOVED,
              packedAt: {
                not: null,
              },
            },
          ],
        },
        select: {
          status: true,
          packedAt: true,
          fulfillmentLineId: true,
        },
      },
      lines: {
        select: {
          id: true,
          variationId: true,
          productId: true,
          productName: true,
          productDisplayId: true,
          sourceQuantityRequired: true,
          status: true,
          issueReason: true,
          quantityRequired: true,
          quantityAllocated: true,
          quantityPicked: true,
          reservations: {
            select: {
              status: true,
              inventoryUnit: {
                select: {
                  status: true,
                },
              },
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }],
      },
    } satisfies Prisma.WmsFulfillmentOrderInclude;
  }

  private mobileBasketInclude() {
    return {
      warehouse: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
      assignedPicker: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      assignedPacker: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      fulfillmentOrders: {
        where: {
          status: {
            in: [...ACTIVE_BASKET_ORDER_STATUSES],
          },
        },
        include: this.pickingTaskInclude(),
        orderBy: [
          { updatedAt: 'desc' },
          { createdAt: 'desc' },
        ],
      },
      basketUnits: {
        where: {
          status: {
            in: [...ACTIVE_BASKET_UNIT_STATUSES],
          },
        },
        include: {
          fulfillmentOrder: {
            select: {
              id: true,
              posOrderId: true,
            },
          },
          inventoryUnit: {
            select: {
              id: true,
              code: true,
              barcode: true,
              status: true,
              productId: true,
              variationId: true,
              warehouseId: true,
              currentLocationId: true,
              posProduct: {
                select: {
                  id: true,
                  name: true,
                  customId: true,
                },
              },
              warehouse: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                },
              },
              currentLocation: {
                select: {
                  id: true,
                  code: true,
                  barcode: true,
                  name: true,
                  kind: true,
                },
              },
            },
          },
          sourceLocation: {
            select: {
              id: true,
              code: true,
              barcode: true,
              name: true,
              kind: true,
            },
          },
        },
        orderBy: [
          { pickedAt: 'asc' },
          { createdAt: 'asc' },
        ],
      },
    } satisfies Prisma.WmsBasketInclude;
  }

  private resolveTaskIssueReason(task: any): string | null {
    const explicitReason = typeof task?.issueReason === 'string' ? task.issueReason.trim() : '';
    if (explicitReason) {
      return explicitReason;
    }

    if (task?.status !== WmsFulfillmentOrderStatus.ISSUE) {
      return null;
    }

    const rawLines = Array.isArray(task?.lines) ? task.lines : [];
    const activeLines = rawLines.filter(
      (line: any) => line?.status !== WmsFulfillmentLineStatus.CANCELED,
    );
    const issueLine = activeLines.find(
      (line: any) => (
        line?.status === WmsFulfillmentLineStatus.ISSUE
        || (typeof line?.issueReason === 'string' && line.issueReason.trim().length > 0)
      ),
    );
    if (issueLine) {
      const lineReason = typeof issueLine.issueReason === 'string' ? issueLine.issueReason.trim() : '';
      const productName = typeof issueLine.productName === 'string' ? issueLine.productName.trim() : '';
      if (lineReason) {
        return productName ? `${productName}: ${lineReason}` : lineReason;
      }
      return productName
        ? `${productName}: Order item has a fulfillment issue — review line item.`
        : 'Order item has a fulfillment issue — review order line items.';
    }

    const totalRequired = Math.max(Number(task?.totalQuantity ?? 0), 0);
    if (totalRequired <= 0) {
      if (Array.isArray(task?.fulfillmentAdjustments) && task.fulfillmentAdjustments.length > 0) {
        return 'All pickable items on this order were bypassed to zero quantity — no units remain to pick.';
      }
      if (
        task?.posOrder
        && typeof (this.wmsFulfillmentSyncService as any)?.resolveEmptyFulfillmentIssueReason === 'function'
      ) {
        return this.wmsFulfillmentSyncService.resolveEmptyFulfillmentIssueReason(
          task.posOrder.orderSnapshot ?? null,
          task.posOrder.itemData ?? null,
        );
      }
      return 'Order has no pickable variation items — verify product variation links in Pancake POS or resync queue.';
    }

    if (task?.posOrder?.isVoid) {
      return 'Order was voided or deleted in Pancake POS — click Resync queue to cancel it in WMS.';
    }

    if (typeof task?.posOrder?.status === 'number' && task.posOrder.status !== 1) {
      const statusLabel = task.posOrder.statusName || String(task.posOrder.status);
      return `Order is in Pancake POS status "${statusLabel}" (not Confirmed) — click Resync queue to update WMS status.`;
    }

    return `Order remained in Issue status after a POS item revision (${totalRequired} required unit${totalRequired === 1 ? '' : 's'}) — click Resync queue or Reallocate waiting to refresh pick readiness.`;
  }

  private mapMobilePickingTask(task: any) {
    const lines = Array.isArray(task.lines)
      ? task.lines.filter((line: any) => (
          line.status !== WmsFulfillmentLineStatus.CANCELED
          && (
            Math.max(line.quantityRequired ?? 0, 0) > 0
            || line.status === WmsFulfillmentLineStatus.ISSUE
          )
        ))
      : [];
    const reservations = this.getAllPickReservations({ lines });
    const pendingReservations = reservations.filter(
      (reservation: any) => reservation.status === WmsPickReservationStatus.RESERVED,
    );
    const nextReservation = pendingReservations[0] ?? null;
    const packedCount = this.isDemandPickingOrder(task)
      ? this.getPackedBasketUnitCount(task)
      : reservations.filter(
          (reservation: any) => this.isPackedEquivalentInventoryStatus(reservation.inventoryUnit.status),
        ).length;
    const itemChange = this.resolveFulfillmentOrderItemChange(task);

    return {
      id: task.id,
      posOrderId: task.posOrderId,
      shopId: task.shopId,
      status: task.status,
      assignmentMode: task.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
      sourceRevision: task.sourceRevision ?? 0,
      statusLabel: this.formatEnumLabel(task.status),
      issueReason: this.resolveTaskIssueReason(task),
      customer: {
        name: task.customerName,
        phone: task.customerPhone,
      },
      totals: {
        required: task.totalQuantity,
        allocated: task.allocatedQuantity,
        picked: task.pickedQuantity,
        packed: Math.min(packedCount, task.totalQuantity),
        remaining: Math.max(task.totalQuantity - task.pickedQuantity, 0),
      },
      store: task.store
        ? {
            id: task.store.id,
            tenantId: task.store.tenantId,
            name: task.store.shopName || task.store.name,
            tenantName: task.store.tenant?.name ?? null,
          }
        : null,
      warehouse: task.warehouse,
      claimedBy: this.mapActor(task.claimedBy),
      packedBy: this.mapActor(task.packedBy),
      claimedAt: task.claimedAt,
      completedAt: task.completedAt,
      orderDate: task.posOrder?.insertedAt ?? task.createdAt,
      orderDateLocal: task.posOrder?.dateLocal ?? null,
      tracking: task.posOrder?.tracking ?? null,
      delivery: this.mapTaskDelivery(task),
      itemChange,
      fulfillmentAdjustment: this.resolveFulfillmentAdjustment(task),
      priority: {
        isPrioritized: Boolean(task.priorityOverrideAt),
        prioritizedAt: task.priorityOverrideAt ?? null,
        reason: task.priorityOverrideReason ?? null,
        donorReleasedForOrderId: task.priorityReleasedForOrderId ?? null,
      },
      createdAt: task.createdAt,
      basket: task.basket ? this.mapMobilePickBasket(task.basket) : null,
      lines: lines.map((line: any) => ({
        id: line.id,
        variationId: line.variationId,
        productId: line.productId,
        productName: line.productName,
        productDisplayId: line.productDisplayId,
        sourceRequired: line.sourceQuantityRequired ?? line.quantityRequired,
        status: line.status,
        statusLabel: this.formatEnumLabel(line.status),
        issueReason: line.issueReason ?? null,
        required: line.quantityRequired,
        allocated: line.quantityAllocated,
        picked: line.quantityPicked,
        packed: this.isDemandPickingOrder(task)
          ? this.getPackedBasketUnitCountForLine(task, line.id, line.quantityRequired)
          : Math.min(
              line.reservations.filter((reservation: any) => this.isPackedEquivalentInventoryStatus(reservation.inventoryUnit.status)).length,
              line.quantityRequired,
            ),
        shortage: Math.max(line.quantityRequired - line.quantityAllocated, 0),
        reservations: line.reservations.map((reservation: any) => this.mapMobilePickReservation(reservation)),
      })),
      nextPick: nextReservation ? this.mapMobilePickReservation(nextReservation) : null,
    };
  }

  private mapMobilePackingQueueTask(task: any) {
    const lines = Array.isArray(task.lines)
      ? task.lines.filter((line: any) => (
          line.status !== WmsFulfillmentLineStatus.CANCELED
          && (
            Math.max(line.quantityRequired ?? 0, 0) > 0
            || line.status === WmsFulfillmentLineStatus.ISSUE
          )
        ))
      : [];
    const isDemandOrder = this.isDemandPickingOrder(task);
    const packedCount = isDemandOrder
      ? this.getPackedBasketUnitCount(task)
      : lines.reduce((total: number, line: any) => (
          total + (line.reservations ?? []).filter(
            (reservation: any) => this.isPackedEquivalentInventoryStatus(
              reservation.inventoryUnit?.status,
            ),
          ).length
        ), 0);

    return {
      id: task.id,
      posOrderId: task.posOrderId,
      shopId: task.shopId,
      status: task.status,
      assignmentMode: task.assignmentMode ?? WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
      sourceRevision: task.sourceRevision ?? 0,
      statusLabel: this.formatEnumLabel(task.status),
      issueReason: this.resolveTaskIssueReason(task),
      customer: {
        name: task.customerName,
        phone: task.customerPhone,
      },
      totals: {
        required: task.totalQuantity,
        allocated: task.allocatedQuantity,
        picked: task.pickedQuantity,
        packed: Math.min(packedCount, task.totalQuantity),
        remaining: Math.max(task.totalQuantity - task.pickedQuantity, 0),
      },
      store: task.store
        ? {
            id: task.store.id,
            tenantId: task.store.tenantId,
            name: task.store.shopName || task.store.name,
            tenantName: task.store.tenant?.name ?? null,
          }
        : null,
      warehouse: task.warehouse,
      claimedBy: this.mapActor(task.claimedBy),
      packedBy: this.mapActor(task.packedBy),
      claimedAt: task.claimedAt,
      completedAt: task.completedAt,
      orderDate: task.posOrder?.insertedAt ?? task.createdAt,
      orderDateLocal: task.posOrder?.dateLocal ?? null,
      tracking: task.posOrder?.tracking ?? null,
      delivery: this.mapTaskDelivery(task),
      itemChange: this.resolveFulfillmentOrderItemChange(task),
      fulfillmentAdjustment: this.resolveFulfillmentAdjustment(task),
      priority: {
        isPrioritized: Boolean(task.priorityOverrideAt),
        prioritizedAt: task.priorityOverrideAt ?? null,
        reason: task.priorityOverrideReason ?? null,
        donorReleasedForOrderId: task.priorityReleasedForOrderId ?? null,
      },
      createdAt: task.createdAt,
      basket: task.basket ? this.mapMobilePickBasket(task.basket) : null,
      lines: lines.map((line: any) => ({
        id: line.id,
        variationId: line.variationId,
        productId: line.productId,
        productName: line.productName,
        productDisplayId: line.productDisplayId,
        sourceRequired: line.sourceQuantityRequired ?? line.quantityRequired,
        status: line.status,
        statusLabel: this.formatEnumLabel(line.status),
        issueReason: line.issueReason ?? null,
        required: line.quantityRequired,
        allocated: line.quantityAllocated,
        picked: line.quantityPicked,
        packed: isDemandOrder
          ? this.getPackedBasketUnitCountForLine(task, line.id, line.quantityRequired)
          : Math.min(
              (line.reservations ?? []).filter(
                (reservation: any) => this.isPackedEquivalentInventoryStatus(
                  reservation.inventoryUnit?.status,
                ),
              ).length,
              line.quantityRequired,
            ),
        shortage: Math.max(line.quantityRequired - line.quantityAllocated, 0),
        reservations: [],
      })),
      nextPick: null,
    };
  }

  private mapMobilePickBasket(basket: any) {
    const activeFulfillmentOrders = Array.isArray(basket.fulfillmentOrders)
      ? basket.fulfillmentOrders
      : basket.fulfillmentOrder
        ? [basket.fulfillmentOrder]
        : [];

    return {
      id: basket.id,
      barcode: basket.barcode,
      status: basket.status,
      statusLabel: this.formatEnumLabel(basket.status),
      maxFulfillmentOrders: basket.maxFulfillmentOrders ?? 1,
      activeFulfillmentOrders: activeFulfillmentOrders.length,
      orders: this.mapMobileBasketOrders(activeFulfillmentOrders),
      warehouse: basket.warehouse
        ? {
            id: basket.warehouse.id,
            code: basket.warehouse.code,
            name: basket.warehouse.name,
          }
        : null,
      assignedPicker: basket.assignedPicker
        ? this.mapActor(basket.assignedPicker)
        : null,
      assignedPacker: basket.assignedPacker
        ? this.mapActor(basket.assignedPacker)
        : null,
      claimedAt: basket.claimedAt ?? null,
      fullAt: basket.fullAt ?? null,
      readyForPackAt: basket.readyForPackAt ?? null,
    };
  }

  private mapMobileBasketOrders(orders: any[]) {
    return orders.map((order) => ({
      id: order.id,
      posOrderId: order.posOrderId ?? null,
      tracking: typeof order.posOrder?.tracking === 'string' && order.posOrder.tracking.trim().length > 0
        ? order.posOrder.tracking.trim()
        : null,
      status: order.status ?? null,
      statusLabel: order.status ? this.formatEnumLabel(order.status) : null,
      customerName: order.customerName ?? null,
      totals: {
        required: order.totalQuantity ?? 0,
        picked: order.pickedQuantity ?? 0,
      },
      store: order.store
        ? {
            id: order.store.id,
            tenantId: order.store.tenantId ?? null,
            name: order.store.shopName || order.store.name,
            tenantName: order.store.tenant?.name ?? null,
          }
        : null,
    }));
  }

  private getOpenBasketSlotCount(basket: any) {
    if (
      basket.status !== WmsBasketStatus.AVAILABLE
      && basket.status !== WmsBasketStatus.ASSIGNED
      && basket.status !== WmsBasketStatus.IN_PICKING
    ) {
      return 0;
    }

    const activeFulfillmentOrderCount = Array.isArray(basket.fulfillmentOrders)
      ? basket.fulfillmentOrders.length
      : basket.fulfillmentOrder
        ? 1
        : 0;

    return Math.max((basket.maxFulfillmentOrders ?? 1) - activeFulfillmentOrderCount, 0);
  }

  private mapMobileBasketTasks(basket: any) {
    const reworkBasketUnits = Array.isArray(basket?.basketUnits) ? basket.basketUnits : [];
    return this.getMobileBasketOrders(basket).map((task: any) => this.mapMobilePickingTask({
      ...task,
      reworkBasketUnits,
    }));
  }

  private getMobileBasketOrders(basket: any) {
    return Array.isArray(basket?.fulfillmentOrders)
      ? basket.fulfillmentOrders
      : basket?.fulfillmentOrder
        ? [basket.fulfillmentOrder]
        : [];
  }

  private resolveActiveBasketPackOrderId(basket: any, preferredOrderId: string | null = null) {
    const activeOrders = this.getMobileBasketOrders(basket);
    if (preferredOrderId) {
      const preferredOrder = activeOrders.find((order: any) => (
        order.id === preferredOrderId
        && order.status === WmsFulfillmentOrderStatus.PACKING
      ));
      if (preferredOrder) {
        return preferredOrder.id;
      }
    }

    return activeOrders.find((order: any) => order.status === WmsFulfillmentOrderStatus.PACKING)?.id ?? null;
  }

  private buildMobileBasketPickPlan(basket: any) {
    if (this.isDemandPickingBasket(basket)) {
      return this.buildMobileBasketDemandPickPlan(basket);
    }

    return this.buildMobileBasketReservedPickPlan(basket);
  }

  private buildMobileBasketPackPlan(basket: any, activeOrderId: string | null = null) {
    const activeOrders = this.getMobileBasketOrders(basket);
    const basketUnits = basket.basketUnits ?? [];
    const availableBasketUnits = basketUnits.filter((basketUnit: any) => (
      basketUnit.status === WmsBasketUnitStatus.PICKED
      && !basketUnit.fulfillmentOrderId
    ));
    const availableUnitCounts = new Map<string, number>();

    for (const basketUnit of availableBasketUnits) {
      const key = `${basketUnit.variationId}::${basketUnit.productId ?? ''}`;
      availableUnitCounts.set(key, (availableUnitCounts.get(key) ?? 0) + 1);
    }

    const orders = activeOrders.map((order: any) => {
      const packableLines = (order.lines ?? []).filter((line: any) => (
        line.status !== WmsFulfillmentLineStatus.CANCELED
        && Math.max(line.quantityRequired ?? 0, 0) > 0
      ));
      const packedByLineId = new Map<string, number>();

      for (const basketUnit of order.basketUnits ?? []) {
        if (basketUnit.status !== WmsBasketUnitStatus.PACKED || !basketUnit.fulfillmentLineId) {
          continue;
        }

        packedByLineId.set(
          basketUnit.fulfillmentLineId,
          (packedByLineId.get(basketUnit.fulfillmentLineId) ?? 0) + 1,
        );
      }

      const lines = packableLines.map((line: any) => {
        const required = Math.max(line.quantityRequired ?? 0, 0);
        const packed = Math.min(packedByLineId.get(line.id) ?? 0, required);
        const availableInBasket = availableUnitCounts.get(`${line.variationId}::${line.productId ?? ''}`) ?? 0;

        return {
          id: line.id,
          variationId: line.variationId,
          productId: line.productId ?? null,
          productName: line.productName,
          productDisplayId: line.productDisplayId ?? null,
          required,
          packed,
          remaining: Math.max(required - packed, 0),
          availableInBasket,
        };
      });

      const required = lines.reduce((sum: number, line: any) => sum + line.required, 0);
      const packed = lines.reduce((sum: number, line: any) => sum + line.packed, 0);
      const tracking = this.cleanOptionalText(order.posOrder?.tracking ?? null);

      return {
        id: order.id,
        posOrderId: order.posOrderId,
        status: order.status,
        statusLabel: this.formatEnumLabel(order.status),
        customerName: order.customerName ?? null,
        tracking,
        trackingReady: Boolean(tracking),
        totals: {
          required,
          packed,
          remaining: Math.max(required - packed, 0),
        },
        lines,
      };
    });

    const resolvedActiveOrderId = this.resolveActiveBasketPackOrderId(
      { fulfillmentOrders: activeOrders },
      activeOrderId,
    );
    const activeOrder = resolvedActiveOrderId
      ? orders.find((order: any) => order.id === resolvedActiveOrderId) ?? null
      : null;
    const basketRequired = orders.reduce((sum: number, order: any) => sum + order.totals.required, 0);
    const basketPacked = orders.reduce((sum: number, order: any) => sum + order.totals.packed, 0);
    const packedOrderCount = orders.filter((order: any) => order.status === WmsFulfillmentOrderStatus.PACKED).length;
    const totalOrderCount = orders.length;

    return {
      basketId: basket.id,
      basketCode: basket.barcode,
      mode: this.isDemandPickingBasket(basket)
        ? WmsFulfillmentAssignmentMode.BASKET_DEMAND
        : WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
      status: basket.status,
      statusLabel: this.formatEnumLabel(basket.status),
      totals: {
        required: basketRequired,
        packed: basketPacked,
        remaining: Math.max(basketRequired - basketPacked, 0),
      },
      orderProgress: {
        total: totalOrderCount,
        packed: packedOrderCount,
        remaining: Math.max(totalOrderCount - packedOrderCount, 0),
      },
      availableUnits: Array.from(
        availableBasketUnits.reduce((map: Map<string, any>, basketUnit: any) => {
          const key = `${basketUnit.variationId}::${basketUnit.productId ?? ''}`;
          if (!map.has(key)) {
            map.set(key, {
              variationId: basketUnit.variationId,
              productId: basketUnit.productId ?? null,
              productName: basketUnit.inventoryUnit?.posProduct?.name ?? `Variation ${basketUnit.variationId}`,
              productDisplayId: basketUnit.inventoryUnit?.posProduct?.customId ?? null,
              unitCount: 0,
            });
          }

          map.get(key).unitCount += 1;
          return map;
        }, new Map<string, any>()).values(),
      ),
      units: basketUnits.map((basketUnit: any) => ({
        id: basketUnit.id,
        inventoryUnitId: basketUnit.inventoryUnitId,
        code: basketUnit.inventoryUnit?.code ?? null,
        barcode: basketUnit.inventoryUnit?.barcode ?? null,
        scannableCode: basketUnit.inventoryUnit?.barcode ?? basketUnit.inventoryUnit?.code ?? null,
        status: basketUnit.status,
        variationId: basketUnit.variationId,
        productId: basketUnit.productId ?? null,
        productName: basketUnit.inventoryUnit?.posProduct?.name ?? `Variation ${basketUnit.variationId}`,
        productDisplayId: basketUnit.inventoryUnit?.posProduct?.customId ?? null,
        assignedOrder: basketUnit.fulfillmentOrder
          ? {
              id: basketUnit.fulfillmentOrder.id,
              posOrderId: basketUnit.fulfillmentOrder.posOrderId,
            }
          : null,
      })),
      orders,
      activeOrder,
    };
  }

  private buildMobileBasketReservedPickPlan(basket: any) {
    const activeOrders = Array.isArray(basket.fulfillmentOrders)
      ? basket.fulfillmentOrders
      : basket.fulfillmentOrder
        ? [basket.fulfillmentOrder]
        : [];
    const contexts = this.getBasketPickReservationContexts(basket);
    const pendingContexts = contexts.filter(({ reservation }) => (
      reservation.status === WmsPickReservationStatus.RESERVED
    ));
    const pickedContexts = contexts.filter(({ reservation }) => (
      reservation.status === WmsPickReservationStatus.PICKED
    ));
    const groupByLocationId = new Map<string, {
      bin: any;
      contexts: Array<{ order: any; line: any; reservation: any }>;
    }>();
    let unbinnedPendingUnits = 0;

    for (const context of pendingContexts) {
      const location = context.reservation.inventoryUnit.currentLocation;
      if (!location || location.kind !== WmsLocationKind.BIN) {
        unbinnedPendingUnits += 1;
        continue;
      }

      const existing = groupByLocationId.get(location.id);
      if (existing) {
        existing.contexts.push(context);
      } else {
        groupByLocationId.set(location.id, {
          bin: this.mapLocation(location),
          contexts: [context],
        });
      }
    }

    const bins = Array.from(groupByLocationId.values())
      .map((group) => {
        const orderCounts = new Map<string, {
          id: string;
          posOrderId: string;
          storeName: string | null;
          tenantName: string | null;
          pendingUnits: number;
        }>();

        for (const context of group.contexts) {
          const existing = orderCounts.get(context.order.id);
          if (existing) {
            existing.pendingUnits += 1;
          } else {
            orderCounts.set(context.order.id, {
              id: context.order.id,
              posOrderId: context.order.posOrderId,
              storeName: context.order.store?.shopName || context.order.store?.name || null,
              tenantName: context.order.store?.tenant?.name ?? null,
              pendingUnits: 1,
            });
          }
        }

        return {
          bin: group.bin,
          pickedUnits: 0,
          requiredUnits: group.contexts.length,
          pendingUnits: group.contexts.length,
          orderCount: orderCounts.size,
          orders: Array.from(orderCounts.values())
            .sort((left, right) => right.pendingUnits - left.pendingUnits || left.posOrderId.localeCompare(right.posOrderId)),
          units: group.contexts
            .sort((left, right) => (
              left.reservation.sequence - right.reservation.sequence
              || left.order.posOrderId.localeCompare(right.order.posOrderId)
            ))
            .map((context) => this.mapMobileBasketPickUnit(context)),
        };
      })
      .sort((left, right) => (
        right.pendingUnits - left.pendingUnits
        || left.bin.code.localeCompare(right.bin.code)
      ));

    return {
      basketId: basket.id,
      basketCode: basket.barcode,
      mode: WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
      status: basket.status,
      statusLabel: this.formatEnumLabel(basket.status),
      totalOrders: activeOrders.length,
      totalRequiredUnits: activeOrders.reduce((total: number, order: any) => total + Math.max(order.totalQuantity ?? 0, 0), 0),
      totalPickedUnits: activeOrders.reduce((total: number, order: any) => total + Math.max(order.pickedQuantity ?? 0, 0), 0),
      totalPendingUnits: pendingContexts.length,
      totalPickedReservations: pickedContexts.length,
      unbinnedPendingUnits,
      currentBin: bins[0]?.bin ?? null,
      bins,
    };
  }

  private buildMobileBasketDemandPickPlan(basket: any) {
    const activeOrders = Array.isArray(basket.fulfillmentOrders)
      ? basket.fulfillmentOrders
      : basket.fulfillmentOrder
        ? [basket.fulfillmentOrder]
        : [];
    const contexts = this.getBasketDemandPickContexts(basket)
      .filter((context: any) => context.remainingQuantity > 0);
    const groupByLocationId = new Map<string, {
      bin: any;
      contexts: any[];
      routeSequence: number;
    }>();

    for (const context of contexts) {
      const location = context.bin.location;
      if (!location || location.kind !== WmsLocationKind.BIN) {
        continue;
      }

      const existing = groupByLocationId.get(location.id);
      if (existing) {
        existing.contexts.push(context);
        existing.routeSequence = Math.min(existing.routeSequence, context.bin.routeSequence ?? Number.MAX_SAFE_INTEGER);
      } else {
        groupByLocationId.set(location.id, {
          bin: this.mapLocation(location),
          contexts: [context],
          routeSequence: context.bin.routeSequence ?? Number.MAX_SAFE_INTEGER,
        });
      }
    }

    const bins = Array.from(groupByLocationId.values())
      .map((group) => {
        const orderCounts = new Map<string, {
          id: string;
          posOrderId: string;
          storeName: string | null;
          tenantName: string | null;
          pendingUnits: number;
        }>();

        for (const context of group.contexts) {
          const existing = orderCounts.get(context.order.id);
          if (existing) {
            existing.pendingUnits += context.remainingQuantity;
          } else {
            orderCounts.set(context.order.id, {
              id: context.order.id,
              posOrderId: context.order.posOrderId,
              storeName: context.order.store?.shopName || context.order.store?.name || null,
              tenantName: context.order.store?.tenant?.name ?? null,
              pendingUnits: context.remainingQuantity,
            });
          }
        }

        return {
          bin: group.bin,
          routeSequence: group.routeSequence,
          pickedUnits: group.contexts.reduce(
            (total: number, context: any) => total + Math.max(context.bin.quantityPicked ?? 0, 0),
            0,
          ),
          requiredUnits: group.contexts.reduce(
            (total: number, context: any) => total + Math.max(context.bin.quantityTarget ?? 0, 0),
            0,
          ),
          pendingUnits: group.contexts.reduce(
            (total: number, context: any) => total + context.remainingQuantity,
            0,
          ),
          orderCount: orderCounts.size,
          orders: Array.from(orderCounts.values())
            .sort((left, right) => right.pendingUnits - left.pendingUnits || left.posOrderId.localeCompare(right.posOrderId)),
          units: group.contexts
            .sort((left: any, right: any) => (
              (left.bin.routeSequence ?? Number.MAX_SAFE_INTEGER) - (right.bin.routeSequence ?? Number.MAX_SAFE_INTEGER)
              || left.order.posOrderId.localeCompare(right.order.posOrderId)
            ))
            .map((context: any) => this.mapMobileBasketPickDemandUnit(context)),
        };
      })
      .sort((left, right) => (
        right.pendingUnits - left.pendingUnits
        || left.routeSequence - right.routeSequence
        || left.bin.code.localeCompare(right.bin.code)
      ));

    return {
      basketId: basket.id,
      basketCode: basket.barcode,
      mode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
      status: basket.status,
      statusLabel: this.formatEnumLabel(basket.status),
      totalOrders: activeOrders.length,
      totalRequiredUnits: activeOrders.reduce((total: number, order: any) => total + Math.max(order.totalQuantity ?? 0, 0), 0),
      totalPickedUnits: activeOrders.reduce((total: number, order: any) => total + Math.max(order.pickedQuantity ?? 0, 0), 0),
      totalPendingUnits: contexts.reduce((total: number, context: any) => total + context.remainingQuantity, 0),
      totalPickedReservations: activeOrders.reduce((total: number, order: any) => total + Math.max(order.pickedQuantity ?? 0, 0), 0),
      unbinnedPendingUnits: 0,
      currentBin: bins[0]?.bin ?? null,
      bins,
    };
  }

  private mapMobileBasketPickUnit(context: { order: any; line: any; reservation: any }) {
    return {
      id: context.reservation.id,
      mode: WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
      displayCode: context.reservation.inventoryUnit.code,
      displayLabel: context.line.productName,
      remainingUnits: 1,
      pickedUnits: context.reservation.status === WmsPickReservationStatus.PICKED ? 1 : 0,
      requiredUnits: 1,
      reservation: this.mapMobilePickReservation(context.reservation),
      order: {
        id: context.order.id,
        posOrderId: context.order.posOrderId,
        storeName: context.order.store?.shopName || context.order.store?.name || null,
        tenantName: context.order.store?.tenant?.name ?? null,
      },
      line: {
        id: context.line.id,
        productName: context.line.productName,
        productDisplayId: context.line.productDisplayId ?? null,
        variationId: context.line.variationId,
      },
    };
  }

  private mapMobileBasketPickDemandUnit(context: {
    order: any;
    demand: any;
    line: any;
    bin: any;
    remainingQuantity: number;
  }) {
    return {
      id: `${context.demand.id}:${context.bin.id}`,
      mode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
      displayCode: context.demand.productDisplayId ?? context.line?.productDisplayId ?? context.demand.variationId,
      displayLabel: context.demand.productName ?? context.line?.productName ?? 'Pick item',
      remainingUnits: context.remainingQuantity,
      pickedUnits: Math.min(context.demand.quantityPicked ?? 0, context.demand.quantityRequired ?? 0),
      requiredUnits: Math.max(context.demand.quantityRequired ?? 0, 0),
      reservation: null,
      order: {
        id: context.order.id,
        posOrderId: context.order.posOrderId,
        storeName: context.order.store?.shopName || context.order.store?.name || null,
        tenantName: context.order.store?.tenant?.name ?? null,
      },
      line: {
        id: context.line?.id ?? context.demand.fulfillmentLineId,
        productName: context.demand.productName ?? context.line?.productName ?? 'Pick item',
        productDisplayId: context.demand.productDisplayId ?? context.line?.productDisplayId ?? null,
        variationId: context.demand.variationId,
      },
    };
  }

  private buildIdempotentBasketScanResult(params: {
    basket: any;
    activeBin: { id: string };
    scannedUnit: {
      id: string;
      code: string;
      barcode: string;
      variationId: string;
    };
  }) {
    return {
      success: true,
      alreadyProcessed: true,
      requiresRefresh: true,
      basketId: params.basket.id,
      basketStatus: params.basket.status,
      taskId: null,
      lineId: null,
      demandId: null,
      binId: params.activeBin.id,
      pickedUnit: {
        id: params.scannedUnit.id,
        code: params.scannedUnit.code,
        barcode: params.scannedUnit.barcode,
        variationId: params.scannedUnit.variationId,
      },
      counters: {
        order: null,
        line: null,
        bin: null,
      },
      currentBinComplete: false,
      orderComplete: false,
    };
  }

  private wantsBasketScanDeltaResponse(request?: Request) {
    const rawHeader = request?.headers['x-stox-scan-response'];
    const responseMode = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    return responseMode === 'delta-v1';
  }

  private wantsPackingDeltaResponse(request?: Request) {
    const rawHeader = request?.headers['x-stox-pack-response'];
    const responseMode = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    return responseMode === 'delta-v1';
  }

  private wantsPackingUnitScanDeltaResponse(request?: Request) {
    const rawHeader = request?.headers['x-stox-pack-response'];
    const responseMode = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    return responseMode === 'scan-delta-v1';
  }

  private wantsCompactPackingResponse(request?: Request) {
    const rawHeader = request?.headers['x-stox-pack-response'];
    const responseMode = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    return responseMode === 'compact-v1';
  }

  private isBackgroundPackingRefresh(request?: Request) {
    const rawHeader = request?.headers['x-stox-pack-refresh'];
    const refreshMode = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    return refreshMode === 'background';
  }

  private mapMobileHeldBasket(basket: any) {
    const tasks = this.mapMobileBasketTasks(basket);
    const activeTask = tasks[0] ?? null;

    return {
      ...this.mapMobilePickBasket(basket),
      task: activeTask,
      tasks,
    };
  }

  private mapMobileBasketLookup(basket: any) {
    const tasks = this.mapMobileBasketTasks(basket);
    const activeTask = tasks[0] ?? null;

    return {
      ...this.mapMobilePickBasket(basket),
      task: activeTask,
      tasks,
    };
  }

  private mapMobilePickReservation(reservation: any) {
    return {
      id: reservation.id,
      status: reservation.status,
      statusLabel: this.formatEnumLabel(reservation.status),
      sequence: reservation.sequence,
      lineId: reservation.fulfillmentLineId,
      unit: {
        id: reservation.inventoryUnit.id,
        code: reservation.inventoryUnit.code,
        barcode: reservation.inventoryUnit.barcode,
        status: reservation.inventoryUnit.status,
        statusLabel: this.formatEnumLabel(reservation.inventoryUnit.status),
        productId: reservation.inventoryUnit.productId,
        variationId: reservation.inventoryUnit.variationId,
        name: reservation.inventoryUnit.posProduct.name,
        customId: reservation.inventoryUnit.posProduct.customId,
        warehouse: reservation.inventoryUnit.warehouse,
        currentLocation: reservation.inventoryUnit.currentLocation
          ? this.mapLocation(reservation.inventoryUnit.currentLocation)
          : null,
      },
      pickedAt: reservation.pickedAt,
    };
  }

  private mapTaskDelivery(task: any) {
    const posStatus = typeof task.posOrder?.status === 'number' ? task.posOrder.status : null;

    if (posStatus === CANCELED_POS_ORDER_STATUS) {
      return {
        posStatus,
        status: 'CANCELED' as const,
        label: 'Cancelled',
        deliveredAt: task.posOrder?.deliveredAt ?? null,
      };
    }

    if (posStatus === 5) {
      return {
        posStatus,
        status: 'RETURNED' as const,
        label: 'Returned',
        deliveredAt: task.posOrder?.deliveredAt ?? null,
      };
    }

    if (posStatus === 4) {
      return {
        posStatus,
        status: 'RETURNING' as const,
        label: 'Returning',
        deliveredAt: task.posOrder?.deliveredAt ?? null,
      };
    }

    if (posStatus === 3) {
      return {
        posStatus,
        status: 'DELIVERED' as const,
        label: 'Delivered',
        deliveredAt: task.posOrder?.deliveredAt ?? null,
      };
    }

    if (posStatus === 2) {
      return {
        posStatus,
        status: 'SHIPPED' as const,
        label: 'Shipped',
        deliveredAt: task.posOrder?.deliveredAt ?? null,
      };
    }

    if (task.status === WmsFulfillmentOrderStatus.PACKED) {
      return {
        posStatus,
        status: 'PACKED' as const,
        label: 'Packed',
        deliveredAt: task.posOrder?.deliveredAt ?? null,
      };
    }

    return {
      posStatus,
      status: null,
      label: null,
      deliveredAt: task.posOrder?.deliveredAt ?? null,
    };
  }

  private isPackedEquivalentInventoryStatus(status: WmsInventoryUnitStatus | string | null | undefined) {
    return status === WmsInventoryUnitStatus.PACKED
      || status === WmsInventoryUnitStatus.DISPATCHED
      || RETURNED_EQUIVALENT_UNIT_STATUSES.has(status as WmsInventoryUnitStatus);
  }

  private async findRtsOrderForAction(
    user: BootstrapUser,
    id: string,
    requestedTenantId?: string | null,
    request?: Request,
    requiredPermissions: readonly string[] = RTS_VERIFY_ACTION_PERMISSIONS,
    forbiddenMessage = 'This account does not have WMS RTS verification permission',
  ) {
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: requestedTenantId ?? undefined } as GetWmsMobileStockDto,
      request,
    );
    const order = await this.prisma.wmsFulfillmentOrder.findFirst({
      where: {
        id,
        ...(tenantContext.tenantId ? { tenantId: tenantContext.tenantId } : {}),
        status: {
          in: [...PACK_LIST_ORDER_STATUSES],
        },
      },
      include: this.pickingTaskInclude(),
    });

    if (!order) {
      throw new NotFoundException('RTS order was not found');
    }

    const userId = user.userId || user.id || null;
    let permissions: string[] = [];
    if (userId) {
      const access = await this.effectiveAccessService.resolveUserAccess({
        userId,
        basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
        workspace: 'wms',
      });
      permissions = access.permissions;
    }

    if (
      user.role !== 'SUPER_ADMIN'
      && !this.hasAnyRequiredPermission(permissions, requiredPermissions)
    ) {
      throw new ForbiddenException(forbiddenMessage);
    }

    return order;
  }

  private assertOrderRtsEligible(order: any) {
    const posStatus = typeof order.posOrder?.status === 'number' ? order.posOrder.status : null;
    if (posStatus !== 4 && posStatus !== 5) {
      throw new BadRequestException(`Order ${order.posOrderId} is not in POS return status`);
    }

    return posStatus;
  }

  private assertOrderReadyForRtsVerification(order: any) {
    const posStatus = this.assertOrderRtsEligible(order);
    if (posStatus !== 5) {
      throw new BadRequestException(`Order ${order.posOrderId} is still returning and has not reached warehouse verification yet`);
    }
  }

  private buildOpenRtsOrderWhere(
    scope: Pick<Prisma.WmsFulfillmentOrderWhereInput, 'tenantId' | 'storeId'>,
    state?: GetWmsMobileRtsTasksDto['state'],
  ): Prisma.WmsFulfillmentOrderWhereInput {
    const baseWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      ...scope,
      status: WmsFulfillmentOrderStatus.PACKED,
      posOrder: {
        is: {
          status: {
            in: [4, 5],
          },
        },
      },
      lines: {
        some: {
          status: {
            not: WmsFulfillmentLineStatus.CANCELED,
          },
          quantityRequired: {
            gt: 0,
          },
        },
      },
    };

    if (!state) {
      return baseWhere;
    }

    const returnedEquivalentStatuses = Array.from(RETURNED_EQUIVALENT_UNIT_STATUSES);
    const trackedDemandUnitsWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      basketUnits: {
        some: {
          OR: [
            {
              status: WmsBasketUnitStatus.PACKED,
            },
            {
              status: WmsBasketUnitStatus.REMOVED,
              packedAt: {
                not: null,
              },
            },
          ],
        },
      },
    };
    const verifiedDemandUnitsWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      basketUnits: {
        some: {
          OR: [
            {
              status: WmsBasketUnitStatus.PACKED,
            },
            {
              status: WmsBasketUnitStatus.REMOVED,
              packedAt: {
                not: null,
              },
            },
          ],
          inventoryUnit: {
            status: {
              in: returnedEquivalentStatuses,
            },
          },
        },
      },
    };
    const trackedReservedUnitsWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      reservations: {
        some: {},
      },
    };
    const verifiedReservedUnitsWhere: Prisma.WmsFulfillmentOrderWhereInput = {
      reservations: {
        some: {
          inventoryUnit: {
            status: {
              in: returnedEquivalentStatuses,
            },
          },
        },
      },
    };

    if (state === 'RETURNING') {
      return {
        ...baseWhere,
        posOrder: {
          is: {
            status: 4,
          },
        },
      };
    }

    if (state === 'READY_TO_VERIFY') {
      return {
        ...baseWhere,
        posOrder: {
          is: {
            status: 5,
          },
        },
        OR: [
          {
            assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
            ...trackedDemandUnitsWhere,
            NOT: verifiedDemandUnitsWhere,
          },
          {
            assignmentMode: WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
            ...trackedReservedUnitsWhere,
            NOT: verifiedReservedUnitsWhere,
          },
        ],
      };
    }

    return {
      ...baseWhere,
      posOrder: {
        is: {
          status: 5,
        },
      },
      OR: [
        {
          assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
          ...verifiedDemandUnitsWhere,
        },
        {
          assignmentMode: WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
          ...verifiedReservedUnitsWhere,
        },
      ],
    };
  }

  private async buildTenantGoLivePosOrderFilters(tenantIds: string[]): Promise<Prisma.PosOrderWhereInput[]> {
    const uniqueTenantIds = Array.from(new Set(
      tenantIds
        .map((tenantId) => tenantId?.trim())
        .filter((tenantId): tenantId is string => Boolean(tenantId)),
    ));

    if (uniqueTenantIds.length === 0) {
      return [];
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
    const goLiveByTenantId = new Map(
      tenants.map((tenant) => [tenant.id, tenant.wmsFulfillmentGoLiveAt] as const),
    );

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

  private async buildTenantGoLiveFulfillmentOrderFilters(tenantIds: string[]): Promise<Prisma.WmsFulfillmentOrderWhereInput[]> {
    const uniqueTenantIds = Array.from(new Set(
      tenantIds
        .map((tenantId) => tenantId?.trim())
        .filter((tenantId): tenantId is string => Boolean(tenantId)),
    ));

    if (uniqueTenantIds.length === 0) {
      return [];
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
    const goLiveByTenantId = new Map(
      tenants.map((tenant) => [tenant.id, tenant.wmsFulfillmentGoLiveAt] as const),
    );

    return uniqueTenantIds.map((tenantId) => {
      const goLiveAt = goLiveByTenantId.get(tenantId) ?? null;

      return goLiveAt
        ? {
            tenantId,
            posOrder: {
              is: {
                insertedAt: {
                  gte: goLiveAt,
                },
              },
            },
          }
        : {
            tenantId,
          };
    });
  }

  private async getFulfillmentGoLiveAt(tenantId: string | null): Promise<Date | null> {
    if (!tenantId) {
      return null;
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        wmsFulfillmentGoLiveAt: true,
      },
    });

    return tenant?.wmsFulfillmentGoLiveAt ?? null;
  }

  private buildFulfillmentGoLiveWhere(goLiveAt: Date | null): Prisma.WmsFulfillmentOrderWhereInput {
    if (!goLiveAt) {
      return {};
    }

    return {
      posOrder: {
        is: {
          insertedAt: {
            gte: goLiveAt,
          },
        },
      },
    };
  }

  private async getTrackedReturnUnits(order: any) {
    if (this.isDemandPickingOrder(order) || (Array.isArray(order?.basketUnits) && order.basketUnits.length > 0)) {
      const basketUnits = await this.prisma.wmsBasketUnit.findMany({
        where: {
          fulfillmentOrderId: order.id,
          OR: [
            {
              status: WmsBasketUnitStatus.PACKED,
            },
            {
              status: WmsBasketUnitStatus.REMOVED,
              packedAt: {
                not: null,
              },
            },
          ],
        },
        select: {
          inventoryUnit: {
            select: {
              id: true,
              code: true,
              barcode: true,
              status: true,
              productId: true,
              variationId: true,
              warehouseId: true,
              currentLocationId: true,
              currentLocation: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  kind: true,
                },
              },
              posProduct: {
                select: {
                  name: true,
                  customId: true,
                },
              },
            },
          },
        },
      });

      return Array.from(
        new Map(
          basketUnits
            .filter((basketUnit: any) => Boolean(basketUnit.inventoryUnit?.id))
            .map((basketUnit: any) => {
              const unit = basketUnit.inventoryUnit;

              return [unit.id, {
                id: unit.id,
                code: unit.code,
                barcode: unit.barcode,
                status: unit.status,
                productId: unit.productId,
                variationId: unit.variationId,
                warehouseId: unit.warehouseId,
                currentLocationId: unit.currentLocationId,
                currentLocation: unit.currentLocation,
                name: unit.posProduct?.name ?? unit.code,
                customId: unit.posProduct?.customId ?? null,
              }] as const;
            }),
        ).values(),
      );
    }

    return Array.from(
      new Map(
        this.getAllPickReservations(order)
          .filter((reservation: any) => Boolean(reservation.inventoryUnit?.id))
          .map((reservation: any) => {
            const unit = reservation.inventoryUnit;

            return [unit.id, {
              id: unit.id,
              code: unit.code,
              barcode: unit.barcode,
              status: unit.status,
              productId: unit.productId,
              variationId: unit.variationId,
              warehouseId: unit.warehouseId,
              currentLocationId: unit.currentLocationId,
              currentLocation: unit.currentLocation,
              name: unit.posProduct?.name ?? unit.code,
              customId: unit.posProduct?.customId ?? null,
            }] as const;
          }),
      ).values(),
    );
  }

  private async releaseReturnedUnitBasketHoldsTx(
    tx: Prisma.TransactionClient,
    inventoryUnitId: string,
    actorId: string | null,
    now: Date,
  ) {
    const activeBasketUnits = await tx.wmsBasketUnit.findMany({
      where: {
        inventoryUnitId,
        status: {
          in: [...ACTIVE_BASKET_UNIT_STATUSES],
        },
      },
      select: {
        id: true,
      },
    });

    if (activeBasketUnits.length === 0) {
      return 0;
    }

    const updateResult = await tx.wmsBasketUnit.updateMany({
      where: {
        id: {
          in: activeBasketUnits.map((basketUnit) => basketUnit.id),
        },
        status: {
          in: [...ACTIVE_BASKET_UNIT_STATUSES],
        },
      },
      data: {
        status: WmsBasketUnitStatus.REMOVED,
        removedById: actorId ?? undefined,
        removedAt: now,
      },
    });

    if (updateResult.count !== activeBasketUnits.length) {
      throw new ConflictException('Returned unit hold changed before RTS disposition could finish');
    }

    return updateResult.count;
  }

  private async releaseCompletedDemandPackUnitsTx(
    tx: Prisma.TransactionClient,
    fulfillmentOrderId: string,
    actorId: string | null,
    now: Date,
  ) {
    const packedBasketUnits = await tx.wmsBasketUnit.findMany({
      where: {
        fulfillmentOrderId,
        status: WmsBasketUnitStatus.PACKED,
        packedAt: {
          not: null,
        },
      },
      select: {
        id: true,
      },
    });

    if (packedBasketUnits.length === 0) {
      return 0;
    }

    const updateResult = await tx.wmsBasketUnit.updateMany({
      where: {
        id: {
          in: packedBasketUnits.map((basketUnit) => basketUnit.id),
        },
        fulfillmentOrderId,
        status: WmsBasketUnitStatus.PACKED,
      },
      data: {
        status: WmsBasketUnitStatus.REMOVED,
        removedById: actorId ?? undefined,
        removedAt: now,
      },
    });

    if (updateResult.count !== packedBasketUnits.length) {
      throw new ConflictException('Packed basket state changed before pack completion could finish');
    }

    return updateResult.count;
  }

  private async buildTrackingReturnFlow(order: any) {
    const posStatus = typeof order.posOrder?.status === 'number' ? order.posOrder.status : null;
    const posStatusLabel = this.cleanOptionalText(order.posOrder?.statusName ?? null);
    const trackedUnits = await this.getTrackedReturnUnits(order);
    const historicallyDisposedUnits = await this.loadSuccessfulTrackingReturnDispositionUnitKeys(
      this.prisma,
      order.id,
      order.tenantId,
    );
    const verifiedUnits = trackedUnits.filter((unit: any) => (
      RETURNED_EQUIVALENT_UNIT_STATUSES.has(unit.status)
      || this.isHistoricallyDisposedTrackingReturnUnit(unit, historicallyDisposedUnits)
    ));
    const pendingUnits = trackedUnits.filter((unit: any) => (
      !RETURNED_EQUIVALENT_UNIT_STATUSES.has(unit.status)
      && !this.isHistoricallyDisposedTrackingReturnUnit(unit, historicallyDisposedUnits)
    ));
    const latestVerification = await this.prisma.wmsStaffActivity.findFirst({
        where: {
          tenantId: order.tenantId,
          resourceType: 'WMS_FULFILLMENT_ORDER',
          resourceId: order.id,
          actionType: 'ORDER_RTS_UNIT_VERIFY',
          outcome: WmsStaffActivityOutcome.SUCCESS,
        },
        select: {
          createdAt: true,
          actor: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });

    const awaitingPlacementUnits = verifiedUnits.filter((unit: any) => unit.status === WmsInventoryUnitStatus.RTS);
    const isCompleted = trackedUnits.length > 0
      && pendingUnits.length === 0
      && awaitingPlacementUnits.length === 0;

    let state: 'NONE' | 'RETURNING' | 'READY_TO_VERIFY' | 'PARTIAL' | 'VERIFIED' = 'NONE';
    let label: string | null = null;

    if (posStatus === 4) {
      state = 'RETURNING';
      label = 'Returning';
    } else if (posStatus === 5) {
      if (trackedUnits.length === 0) {
        state = 'NONE';
        label = 'No units linked';
      } else if (verifiedUnits.length >= trackedUnits.length) {
        state = 'VERIFIED';
        label = 'Processed';
      } else if (verifiedUnits.length > 0) {
        state = 'PARTIAL';
        label = 'Processed';
      } else {
        state = 'READY_TO_VERIFY';
        label = 'Returned';
      }
    }

    return {
      eligible: posStatus === 4 || posStatus === 5,
      posStatus,
      posStatusLabel: posStatusLabel ?? (posStatus === 4 ? 'Returning' : posStatus === 5 ? 'Returned' : null),
      state,
      label,
      canVerify: posStatus === 5 && pendingUnits.length > 0,
      expectedUnits: trackedUnits.length,
      verifiedUnits: verifiedUnits.map((unit: any) => this.mapTrackingReturnUnit(unit)),
      pendingUnits: pendingUnits.map((unit: any) => this.mapTrackingReturnUnit(unit)),
      disposedAt: isCompleted ? (order.rtsDisposedAt ?? null) : null,
      disposedBy: isCompleted && order.rtsDisposedBy
        ? this.mapActor(order.rtsDisposedBy)
        : null,
      lastVerifiedAt: latestVerification?.createdAt ?? null,
      lastVerifiedBy: latestVerification?.actor ? this.mapActor(latestVerification.actor) : null,
    };
  }

  private async resolveTrackingReturnCompletionStateTx(
    tx: Prisma.TransactionClient,
    fulfillmentOrderId: string,
    isDemandOrder: boolean,
  ) {
    const unitStatuses = isDemandOrder
      ? await tx.wmsBasketUnit.findMany({
          where: {
            fulfillmentOrderId,
            OR: [
              {
                status: WmsBasketUnitStatus.PACKED,
              },
              {
                status: WmsBasketUnitStatus.REMOVED,
                packedAt: {
                  not: null,
                },
              },
            ],
          },
          select: {
            inventoryUnit: {
              select: {
                id: true,
                code: true,
                status: true,
              },
            },
          },
        })
      : await tx.wmsPickReservation.findMany({
          where: {
            fulfillmentOrderId,
          },
          select: {
            inventoryUnit: {
              select: {
                id: true,
                code: true,
                status: true,
              },
            },
          },
        });

    const historicallyDisposedUnits = await this.loadSuccessfulTrackingReturnDispositionUnitKeys(
      tx,
      fulfillmentOrderId,
    );
    const trackedUnits = unitStatuses
      .map((record: any) => record.inventoryUnit ?? null)
      .filter((unit: any) => Boolean(unit?.id));

    const pendingCount = trackedUnits.filter((unit: any) => (
      !RETURNED_EQUIVALENT_UNIT_STATUSES.has(unit.status as WmsInventoryUnitStatus)
      && !this.isHistoricallyDisposedTrackingReturnUnit(unit, historicallyDisposedUnits)
    )).length;
    const awaitingPlacementCount = trackedUnits.filter((unit: any) => (
      unit.status === WmsInventoryUnitStatus.RTS
    )).length;

    return {
      trackedCount: trackedUnits.length,
      pendingCount,
      awaitingPlacementCount,
      isComplete: trackedUnits.length > 0 && pendingCount === 0 && awaitingPlacementCount === 0,
    };
  }

  private async loadSuccessfulTrackingReturnDispositionUnitKeys(
    client: Prisma.TransactionClient | PrismaService,
    fulfillmentOrderId: string,
    tenantId?: string | null,
  ) {
    const rows = await client.wmsStaffActivity.findMany({
      where: {
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: fulfillmentOrderId,
        ...(tenantId ? { tenantId } : {}),
        actionType: 'ORDER_RTS_DISPOSITION',
        outcome: WmsStaffActivityOutcome.SUCCESS,
      },
      select: {
        metadata: true,
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });

    const unitIds = new Set<string>();
    const unitCodes = new Set<string>();

    for (const row of rows) {
      const metadata = this.readHistoryMetadata(row.metadata);
      const unitId = this.readHistoryMetadataString(metadata, 'unitId');
      const unitCode = this.readHistoryMetadataString(metadata, 'unitCode');

      if (unitId) {
        unitIds.add(unitId);
      }

      if (unitCode) {
        unitCodes.add(unitCode);
      }
    }

    return {
      unitIds,
      unitCodes,
    };
  }

  private isHistoricallyDisposedTrackingReturnUnit(
    unit: { id?: string | null; code?: string | null; status?: WmsInventoryUnitStatus | null },
    historicallyDisposedUnits: { unitIds: Set<string>; unitCodes: Set<string> },
  ) {
    if (!unit || unit.status === WmsInventoryUnitStatus.RTS) {
      return false;
    }

    return (unit.id ? historicallyDisposedUnits.unitIds.has(unit.id) : false)
      || (unit.code ? historicallyDisposedUnits.unitCodes.has(unit.code) : false);
  }

  private mapTrackingReturnUnit(unit: any) {
    return {
      id: unit.id,
      code: unit.code,
      barcode: unit.barcode,
      status: unit.status,
      statusLabel: this.formatEnumLabel(unit.status),
      name: unit.name ?? unit.posProduct?.name ?? unit.code,
      customId: unit.customId ?? unit.posProduct?.customId ?? null,
      currentLocation: unit.currentLocation ? this.mapLocation(unit.currentLocation) : null,
    };
  }

  private mapPickingSummary(
    statusGroups: Array<{ status: WmsFulfillmentOrderStatus; _count: { _all: number } }>,
  ) {
    const counts = this.mapStatusCounts(statusGroups);

    return {
      ready: counts[WmsFulfillmentOrderStatus.READY] ?? 0,
      partial: counts[WmsFulfillmentOrderStatus.PARTIAL] ?? 0,
      restocking: counts[WmsFulfillmentOrderStatus.RESTOCKING] ?? 0,
      issue: counts[WmsFulfillmentOrderStatus.ISSUE] ?? 0,
      inPicking: counts[WmsFulfillmentOrderStatus.IN_PICKING] ?? 0,
      readyForPack: counts[WmsFulfillmentOrderStatus.READY_FOR_PACK] ?? 0,
      picked: counts[WmsFulfillmentOrderStatus.PICKED] ?? 0,
    };
  }

  private mapStatusCounts(
    statusGroups: Array<{ status: WmsFulfillmentOrderStatus; _count: { _all: number } }>,
  ) {
    return Object.fromEntries(
      statusGroups.map((group) => [group.status, group._count._all]),
    ) as Partial<Record<WmsFulfillmentOrderStatus, number>>;
  }

  private buildHistoryActivityWhere(params: {
    tenantId: string | null;
    actorId: string | null;
    type: WmsMobileHistoryTypeFilter;
    cursor: { createdAt: Date; id: string } | null;
  }): Prisma.WmsStaffActivityWhereInput {
    const where: Prisma.WmsStaffActivityWhereInput = {
      ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      ...(params.actorId ? { actorId: params.actorId } : {}),
      actionType: {
        in: [...this.resolveHistoryActionTypes(params.type)],
      },
    };

    if (params.type === 'ISSUE') {
      where.outcome = {
        in: [WmsStaffActivityOutcome.REJECTED, WmsStaffActivityOutcome.EXCEPTION],
      };
    }

    if (params.cursor) {
      where.AND = [
        {
          OR: [
            { createdAt: { lt: params.cursor.createdAt } },
            {
              createdAt: params.cursor.createdAt,
              id: { lt: params.cursor.id },
            },
          ],
        },
      ];
    }

    return where;
  }

  private resolveHistoryActionTypes(type: WmsMobileHistoryTypeFilter) {
    switch (type) {
      case 'PICK':
        return HISTORY_PICK_ACTION_TYPES;
      case 'PACK':
        return HISTORY_PACK_ACTION_TYPES;
      case 'DISPATCH':
        return HISTORY_DISPATCH_ACTION_TYPES;
      case 'RTS':
        return HISTORY_RTS_ACTION_TYPES;
      case 'SCAN':
        return HISTORY_SCAN_ACTION_TYPES;
      case 'VOID':
        return HISTORY_VOID_ACTION_TYPES;
      case 'ISSUE':
      case 'ALL':
      default:
        return HISTORY_ALL_ACTION_TYPES;
    }
  }

  private encodeHistoryCursor(createdAt: Date, id: string) {
    return Buffer.from(JSON.stringify({
      createdAt: createdAt.toISOString(),
      id,
    }), 'utf8').toString('base64url');
  }

  private decodeHistoryCursor(cursor?: string | null) {
    if (!cursor) {
      return null;
    }

    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        createdAt?: string;
        id?: string;
      };
      const createdAt = parsed.createdAt ? new Date(parsed.createdAt) : null;

      if (!createdAt || Number.isNaN(createdAt.getTime()) || !parsed.id) {
        return null;
      }

      return {
        createdAt,
        id: parsed.id,
      };
    } catch {
      return null;
    }
  }

  private mapMobileHistoryItem(
    activity: any,
    context: {
      storeMap: Map<string, string>;
      warehouseMap: Map<string, string>;
    },
  ) {
    const metadata = this.readHistoryMetadata(activity.metadata);
    const storeLabel = activity.storeId ? context.storeMap.get(activity.storeId) ?? null : null;
    const warehouseLabel = activity.warehouseId ? context.warehouseMap.get(activity.warehouseId) ?? null : null;
    const actorName = activity.actor
      ? this.formatActorName(activity.actor.firstName, activity.actor.lastName, activity.actor.email)
      : null;

    return {
      id: activity.id,
      category: this.resolveHistoryCategory(activity.actionType, activity.outcome),
      actionType: activity.actionType,
      title: this.resolveHistoryTitle(activity.actionType, metadata),
      subject: this.resolveHistorySubject(activity.actionType, metadata, activity.resourceType),
      supporting: this.resolveHistorySupporting(activity.actionType, metadata, {
        storeLabel,
        warehouseLabel,
      }),
      occurredAt: activity.createdAt,
      outcome: activity.outcome,
      actor: actorName
        ? {
            id: activity.actorId ?? null,
            name: actorName,
            email: activity.actor.email,
          }
        : null,
      status: {
        from: activity.fromStatus ? this.formatEnumLabel(activity.fromStatus) : null,
        to: activity.toStatus ? this.formatEnumLabel(activity.toStatus) : null,
      },
    };
  }

  private resolveHistoryCategory(actionType: string, outcome: WmsStaffActivityOutcome) {
    if (outcome === WmsStaffActivityOutcome.REJECTED || outcome === WmsStaffActivityOutcome.EXCEPTION) {
      return 'issue';
    }

    if ((HISTORY_VOID_ACTION_TYPES as readonly string[]).includes(actionType)) {
      return 'void';
    }

    if ((HISTORY_DISPATCH_ACTION_TYPES as readonly string[]).includes(actionType)) {
      return 'dispatch';
    }

    if ((HISTORY_RTS_ACTION_TYPES as readonly string[]).includes(actionType)) {
      return 'rts';
    }

    if ((HISTORY_PACK_ACTION_TYPES as readonly string[]).includes(actionType)) {
      return 'pack';
    }

    if ((HISTORY_PICK_ACTION_TYPES as readonly string[]).includes(actionType)) {
      return 'pick';
    }

    return 'scan';
  }

  private resolveHistoryTitle(actionType: string, metadata: Record<string, unknown> | null) {
    switch (actionType) {
      case 'PICKING_CLAIM':
        return 'Claimed pick order';
      case 'PICKING_BIN_SCAN':
        return 'Scanned pick location';
      case 'PICKING_BASKET_SCAN':
        return 'Assigned picking basket';
      case 'PICKING_BASKET_BATCH_ASSIGN':
        return 'Assigned basket batch';
      case 'PICKING_UNIT_SCAN':
        return 'Picked unit';
      case 'PICKING_BASKET_LOOKUP':
        return 'Looked up basket';
      case 'PICKING_COMPLETE':
        return 'Completed picking';
      case 'PICKING_HANDOFF':
        return 'Handed off to pack';
      case 'PACKING_START':
        return 'Started packing';
      case 'PACKING_UNIT_SCAN':
        return 'Packed unit';
      case 'PACKING_TRACKING_VERIFY':
        return 'Verified tracking';
      case 'PACKING_COMPLETE':
        return 'Completed packing';
      case 'ORDER_DISPATCH_SYNC':
        return 'Synced dispatch status';
      case 'ORDER_DELIVERY_SYNC':
        return 'Synced delivery status';
      case 'ORDER_RTS_UNIT_VERIFY':
        return 'Verified returned unit';
      case 'ORDER_RTS_DISPOSITION':
        return 'Applied RTS disposition';
      case 'ORDER_RTS_COMPLETE':
        return 'Completed RTS verification';
      case 'PACKING_VOID_REQUEST':
        return 'Requested order void';
      case 'PACKING_VOID_APPROVAL':
        return 'Approved order void';
      case 'PACKING_VOID_COMPLETE':
        return 'Voided order from pack';
      case 'STOCK_UNIT_VIEW':
        return 'Viewed unit details';
      case 'STOCK_BIN_VIEW':
        return 'Viewed location details';
      case 'STOCK_BATCH_VIEW':
        return 'Viewed receiving batch';
      case 'STOCK_PUTAWAY':
        return 'Put away unit';
      case 'STOCK_MOVE':
        return 'Moved unit';
      case 'STOCK_SCAN': {
        const source = this.readHistoryMetadataString(metadata, 'source');
        const resultType = this.readHistoryMetadataString(metadata, 'resultType');

        if (source === 'tracking') {
          return 'Scanned waybill';
        }

        if (resultType === 'unit') {
          return 'Scanned serialized unit';
        }

        if (resultType === 'bin' || resultType === 'location') {
          return 'Scanned location';
        }

        if (resultType === 'batch') {
          return 'Scanned receiving batch';
        }

        return 'Scanned code';
      }
      default:
        return this.formatEnumLabel(actionType);
    }
  }

  private resolveHistorySubject(
    actionType: string,
    metadata: Record<string, unknown> | null,
    resourceType?: string | null,
  ) {
    const posOrderId = this.readHistoryMetadataString(metadata, 'posOrderId');
    const unitCode = this.readHistoryMetadataString(metadata, 'unitCode');
    const basketCode = this.readHistoryMetadataString(metadata, 'basketCode');
    const trackingCode = this.readHistoryMetadataString(metadata, 'trackingCode');
    const genericCode = this.readHistoryMetadataString(metadata, 'code');
    const targetCode = this.readHistoryMetadataString(metadata, 'targetCode');
    const deliveryState = this.readHistoryMetadataString(metadata, 'deliveryState');

    if (
      (
        actionType === 'ORDER_DISPATCH_SYNC'
        || actionType === 'ORDER_DELIVERY_SYNC'
        || actionType === 'ORDER_RTS_UNIT_VERIFY'
        || actionType === 'ORDER_RTS_DISPOSITION'
        || actionType === 'ORDER_RTS_COMPLETE'
      )
      && posOrderId
    ) {
      if (
        actionType === 'ORDER_RTS_UNIT_VERIFY'
        || actionType === 'ORDER_RTS_DISPOSITION'
        || actionType === 'ORDER_RTS_COMPLETE'
      ) {
        return `Order ${posOrderId} · Return verified`;
      }

      if (!deliveryState) {
        return `Order ${posOrderId}`;
      }

      return `Order ${posOrderId} · ${deliveryState === 'DELIVERED' ? 'Delivered' : 'Shipped'}`;
    }

    if (actionType === 'STOCK_MOVE' && targetCode) {
      return targetCode;
    }

    if (unitCode) {
      return unitCode;
    }

    if (trackingCode) {
      return trackingCode;
    }

    if (basketCode) {
      return basketCode;
    }

    if (posOrderId) {
      return `Order ${posOrderId}`;
    }

    if (genericCode) {
      return genericCode;
    }

    switch (resourceType) {
      case 'WMS_FULFILLMENT_ORDER':
        return 'Fulfillment order';
      case 'WMS_INVENTORY_UNIT':
        return 'Inventory unit';
      case 'WMS_BASKET':
        return 'Basket';
      case 'WMS_LOCATION':
        return 'Location';
      case 'WMS_RECEIVING_BATCH':
        return 'Receiving batch';
      default:
        return 'WMS activity';
    }
  }

  private resolveHistorySupporting(
    actionType: string,
    metadata: Record<string, unknown> | null,
    context: {
      storeLabel: string | null;
      warehouseLabel: string | null;
    },
  ) {
    const parts: string[] = [];
    const unitCode = this.readHistoryMetadataString(metadata, 'unitCode');
    const trackingCode = this.readHistoryMetadataString(metadata, 'trackingCode');
    const basketCode = this.readHistoryMetadataString(metadata, 'basketCode');
    const voidReason = this.readHistoryMetadataString(metadata, 'voidReason');
    const targetCode = this.readHistoryMetadataString(metadata, 'targetCode');
    const packerName = this.readHistoryMetadataString(metadata, 'packerName')
      ?? this.readHistoryMetadataString(metadata, 'packerEmail');
    const source = this.readHistoryMetadataString(metadata, 'source');
    const deliveryState = this.readHistoryMetadataString(metadata, 'deliveryState');
    const dispositionAction = this.readHistoryMetadataString(metadata, 'dispositionAction');
    const unitCount = this.readHistoryMetadataNumber(metadata, 'unitCount');
    const assignedCount = this.readHistoryMetadataNumber(metadata, 'assignedCount');
    const mode = this.readHistoryMetadataString(metadata, 'mode');
    const found = this.readHistoryMetadataBoolean(metadata, 'found');

    if (context.storeLabel) {
      parts.push(context.storeLabel);
    }

    if (trackingCode && actionType !== 'PACKING_TRACKING_VERIFY') {
      parts.push(`Tracking ${trackingCode}`);
    }

    if (basketCode) {
      parts.push(`Basket ${basketCode}`);
    }

    if (typeof assignedCount === 'number' && actionType === 'PICKING_BASKET_BATCH_ASSIGN') {
      parts.push(`${assignedCount} order${assignedCount === 1 ? '' : 's'}`);
    }

    if (targetCode && actionType === 'STOCK_MOVE') {
      parts.push(`Moved to ${targetCode}`);
    }

    if (packerName && actionType === 'PICKING_HANDOFF') {
      parts.push(`To ${packerName}`);
    }

    if (context.warehouseLabel && (actionType === 'STOCK_PUTAWAY' || actionType === 'STOCK_MOVE')) {
      parts.push(context.warehouseLabel);
    }

    if ((actionType === 'ORDER_DISPATCH_SYNC' || actionType === 'ORDER_DELIVERY_SYNC') && deliveryState) {
      parts.push(deliveryState === 'DELIVERED' ? 'Courier marked delivered' : 'Courier marked shipped');
    }

    if (typeof unitCount === 'number' && (actionType === 'ORDER_DISPATCH_SYNC' || actionType === 'ORDER_DELIVERY_SYNC')) {
      parts.push(
        `${unitCount} unit${unitCount === 1 ? '' : 's'} ${actionType === 'ORDER_DELIVERY_SYNC' ? 'delivered' : 'dispatched'}`,
      );
    }

    if (mode === 'AUTO' && (actionType === 'ORDER_DISPATCH_SYNC' || actionType === 'ORDER_DELIVERY_SYNC')) {
      parts.push('Auto sync');
    }

    if (actionType === 'ORDER_RTS_UNIT_VERIFY') {
      if (unitCode) {
        parts.push(`Returned unit ${unitCode}`);
      }
      if (targetCode) {
        parts.push(`Moved to ${targetCode}`);
      }
      parts.push('Verified against the dispatched waybill');
    }

    if (actionType === 'ORDER_RTS_DISPOSITION') {
      if (unitCode) {
        parts.push(`Returned unit ${unitCode}`);
      }
      if (dispositionAction) {
        parts.push(this.formatEnumLabel(dispositionAction));
      }
      if (targetCode) {
        parts.push(`Moved to ${targetCode}`);
      }
    }

    if (actionType === 'ORDER_RTS_COMPLETE') {
      if (typeof unitCount === 'number') {
        parts.push(`${unitCount} unit${unitCount === 1 ? '' : 's'} reconciled`);
      }
      parts.push('All dispatched units have been checked');
    }

    if (source === 'tracking' && found === false) {
      parts.push('Waybill not found');
    } else if (found === false) {
      parts.push('No matching record');
    }

    if (voidReason) {
      parts.push(voidReason);
    }

    return parts.join(' · ') || null;
  }

  private readHistoryMetadata(metadata: Prisma.JsonValue | null | undefined) {
    if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') {
      return null;
    }

    return metadata as Record<string, unknown>;
  }

  private readHistoryMetadataString(
    metadata: Record<string, unknown> | null,
    key: string,
  ) {
    const value = metadata?.[key];

    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number') {
      return String(value);
    }

    return null;
  }

  private readHistoryMetadataNumber(
    metadata: Record<string, unknown> | null,
    key: string,
  ) {
    const value = metadata?.[key];

    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readHistoryMetadataBoolean(
    metadata: Record<string, unknown> | null,
    key: string,
  ) {
    const value = metadata?.[key];
    return typeof value === 'boolean' ? value : null;
  }

  private async getWmsTaskAssignment(userId: string) {
    const assignment = await this.prisma.wmsStaffAssignment.findUnique({
      where: { userId },
      select: {
        taskType: true,
      },
    });

    return assignment?.taskType ?? null;
  }

  private resolvePickQueueAccess(
    user: BootstrapUser,
    permissions: string[],
    taskAssignment: WmsStaffAssignmentTaskType | null,
  ) {
    if (user.role === 'SUPER_ADMIN' || this.hasAnyRequiredPermission(permissions, PICK_SUPERVISOR_PERMISSIONS)) {
      return {
        canViewAll: true,
      };
    }

    if (this.hasAnyRequiredPermission(permissions, PICK_ASSIGNMENT_PERMISSIONS)) {
      if (taskAssignment === WmsStaffAssignmentTaskType.PICK) {
        return {
          canViewAll: false,
        };
      }

      throw new ForbiddenException('This account is not assigned to PICK in WMS Web');
    }

    if (permissions.includes('wms.fulfillment.read')) {
      return {
        canViewAll: true,
      };
    }

    throw new ForbiddenException('This account does not have WMS pick queue access');
  }

  private resolvePackQueueAccess(
    user: BootstrapUser,
    permissions: string[],
    taskAssignment: WmsStaffAssignmentTaskType | null,
  ) {
    if (user.role === 'SUPER_ADMIN' || this.hasAnyRequiredPermission(permissions, PACK_SUPERVISOR_PERMISSIONS)) {
      return {
        canViewAll: true,
      };
    }

    if (this.hasAnyRequiredPermission(permissions, PACK_HANDOFF_PERMISSIONS)) {
      if (taskAssignment === WmsStaffAssignmentTaskType.PACK) {
        return {
          canViewAll: false,
        };
      }

      throw new ForbiddenException('This account is not assigned to PACK in WMS Web');
    }

    if (permissions.includes('wms.dispatch.read')) {
      return {
        canViewAll: true,
      };
    }

    throw new ForbiddenException('This account does not have WMS pack queue access');
  }

  private assertPickExecutionAccess(
    user: BootstrapUser,
    permissions: string[],
    taskAssignment: WmsStaffAssignmentTaskType | null,
  ) {
    if (user.role === 'SUPER_ADMIN' || this.hasAnyRequiredPermission(permissions, PICK_SUPERVISOR_PERMISSIONS)) {
      return;
    }

    if (!this.hasAnyRequiredPermission(permissions, PICK_ASSIGNMENT_PERMISSIONS)) {
      throw new ForbiddenException('This account does not have WMS picking permissions');
    }

    if (taskAssignment !== WmsStaffAssignmentTaskType.PICK) {
      throw new ForbiddenException('This account is not assigned to PICK in WMS Web');
    }
  }

  private assertPackExecutionAccess(
    user: BootstrapUser,
    permissions: string[],
    taskAssignment: WmsStaffAssignmentTaskType | null,
  ) {
    if (user.role === 'SUPER_ADMIN' || this.hasAnyRequiredPermission(permissions, PACK_SUPERVISOR_PERMISSIONS)) {
      return;
    }

    if (!this.hasAnyRequiredPermission(permissions, PACK_HANDOFF_PERMISSIONS)) {
      throw new ForbiddenException('This account does not have WMS packing permissions');
    }

    if (taskAssignment !== WmsStaffAssignmentTaskType.PACK) {
      throw new ForbiddenException('This account is not assigned to PACK in WMS Web');
    }
  }

  private async listPackingHandoffCandidates() {
    const users = await this.prisma.user.findMany({
      where: {
        tenantId: null,
        status: UserStatus.ACTIVE,
        wmsStaffAssignment: {
          is: {
            taskType: WmsStaffAssignmentTaskType.PACK,
          },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        employeeId: true,
      },
      orderBy: [
        { firstName: 'asc' },
        { lastName: 'asc' },
        { email: 'asc' },
      ],
    });

    const resolved = await Promise.all(users.map(async (candidate) => {
      const access = await this.effectiveAccessService.resolveUserAccess({
        userId: candidate.id,
        workspace: 'wms',
      });

      if (!this.hasAnyRequiredPermission(access.permissions, PACK_HANDOFF_PERMISSIONS)) {
        return null;
      }

      return {
        id: candidate.id,
        name: this.formatActorName(candidate.firstName, candidate.lastName, candidate.email),
        email: candidate.email,
        employeeId: candidate.employeeId ?? null,
      };
    }));

    return resolved.filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
  }

  private async findPackingHandoffCandidate(userId: string) {
    const candidates = await this.listPackingHandoffCandidates();
    return candidates.find((candidate) => candidate.id === userId) ?? null;
  }

  private buildEmptyPickingResponse(tenantReady: boolean) {
    return {
      tenantReady,
      serverTime: new Date().toISOString(),
      pagination: {
        page: 1,
        pageSize: DEFAULT_PICKING_PAGE_SIZE,
        total: 0,
        hasMore: false,
      },
      context: {
        tenantOptions: [],
        activeTenantId: null,
        activeStoreId: null,
        stores: [],
        packerOptions: [],
      },
      summary: {
        ready: 0,
        partial: 0,
        restocking: 0,
        issue: 0,
        inPicking: 0,
        readyForPack: 0,
        picked: 0,
      },
      picker: {
        registeredBaskets: 0,
        activeLoad: 0,
        availableSlots: 0,
        heldBaskets: 0,
        fullHeldBaskets: 0,
      },
      availableBaskets: [],
      heldBaskets: [],
      pickedHistory: [],
      tasks: [],
    };
  }

  private buildEmptyPackingResponse(tenantReady: boolean) {
    return {
      tenantReady,
      serverTime: new Date().toISOString(),
      pagination: {
        page: 1,
        pageSize: DEFAULT_PACKING_PAGE_SIZE,
        total: 0,
        hasMore: false,
      },
      context: {
        tenantOptions: [],
        activeTenantId: null,
        activeStoreId: null,
        stores: [],
      },
      summary: {
        held: 0,
        packing: 0,
        awaitingTracking: 0,
        packed: 0,
      },
      tasks: [],
    };
  }

  private resolvePackQueueSortTimestamp(values: Array<Date | string | null | undefined>) {
    for (const value of values) {
      if (!value) {
        continue;
      }

      if (value instanceof Date) {
        const timestamp = value.getTime();
        if (!Number.isNaN(timestamp)) {
          return timestamp;
        }
        continue;
      }

      const timestamp = Date.parse(value);
      if (!Number.isNaN(timestamp)) {
        return timestamp;
      }
    }

    return 0;
  }

  private orderPackingTasksForBaskets(tasks: any[], basketIds: string[]) {
    const tasksByBasketId = new Map<string, any[]>();

    tasks.forEach((task) => {
      const basketId = typeof task?.basketId === 'string' ? task.basketId : task?.basket?.id;
      if (!basketId) {
        return;
      }

      const existing = tasksByBasketId.get(basketId) ?? [];
      existing.push(task);
      tasksByBasketId.set(basketId, existing);
    });

    return basketIds.flatMap((basketId) => tasksByBasketId.get(basketId) ?? []);
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

  private hasAnyRequiredPermission(
    permissions: string[],
    requiredPermissions: readonly string[],
  ) {
    return requiredPermissions.some((permission) => permissions.includes(permission));
  }

  private formatActorName(
    firstName: string | null,
    lastName: string | null,
    fallback: string,
  ) {
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    return fullName || fallback;
  }

  private async findUnitByCode(code: string, tenantId: string | null) {
    const normalizedCode = this.normalizeScannedCode(code);
    return this.prisma.wmsInventoryUnit.findFirst({
      where: {
        ...(tenantId ? { tenantId } : {}),
        OR: [
          { code: normalizedCode },
          { barcode: normalizedCode },
          ...(this.isUuid(normalizedCode) ? [{ id: normalizedCode }] : []),
        ],
      },
      include: this.mobileUnitInclude(),
    });
  }

  private async findUnitById(id: string, tenantId: string | null) {
    return this.prisma.wmsInventoryUnit.findFirst({
      where: {
        id,
        ...(tenantId ? { tenantId } : {}),
      },
      include: this.mobileUnitInclude(),
    });
  }

  private async findLocationByCode(
    code: string,
    options?: {
      warehouseId?: string | null;
      warehouseMismatchMessage?: string;
    },
  ) {
    const normalizedCode = this.normalizeScannedCode(code);
    const scopedWarehouseId = options?.warehouseId ?? await this.resolveWarehouseScopeFromLocationCode(normalizedCode);
    const candidates = await this.buildLocationLookupCandidates(normalizedCode, scopedWarehouseId ?? undefined);
    const locationInclude = {
      warehouse: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
    } satisfies Prisma.WmsLocationInclude;

    if (scopedWarehouseId) {
      const location = await this.prisma.wmsLocation.findFirst({
        where: {
          warehouseId: scopedWarehouseId,
          isActive: true,
          OR: this.buildLocationLookupWhere(candidates, normalizedCode),
        },
        include: locationInclude,
      });

      if (location) {
        return location;
      }

      if (options?.warehouseId) {
        const locationInAnotherWarehouse = await this.prisma.wmsLocation.findFirst({
          where: {
            isActive: true,
            OR: this.buildLocationLookupWhere(candidates, normalizedCode),
            NOT: {
              warehouseId: scopedWarehouseId,
            },
          },
          include: locationInclude,
        });

        if (locationInAnotherWarehouse) {
          throw new BadRequestException(
            options.warehouseMismatchMessage
              ?? `Scanned bin ${locationInAnotherWarehouse.code} belongs to ${locationInAnotherWarehouse.warehouse.code}, not this warehouse`,
          );
        }
      }

      return null;
    }

    const matches = await this.prisma.wmsLocation.findMany({
      where: {
        isActive: true,
        OR: this.buildLocationLookupWhere(candidates, normalizedCode),
      },
      include: locationInclude,
      orderBy: [
        { warehouseId: 'asc' },
        { code: 'asc' },
      ],
      take: 3,
    });

    if (matches.length === 0) {
      return null;
    }

    if (matches.length > 1) {
      const warehouseCodes = Array.from(
        new Set(matches.map((match) => match.warehouse.code)),
      );
      throw new BadRequestException(
        `Location code ${normalizedCode} exists in multiple warehouses (${warehouseCodes.join(', ')}). Scan the warehouse-prefixed bin barcode instead.`,
      );
    }

    return matches[0];
  }

  private async findBatchByCode(code: string, tenantId: string | null) {
    const normalizedCode = this.normalizeScannedCode(code);
    return this.prisma.wmsReceivingBatch.findFirst({
      where: {
        ...(tenantId ? { tenantId } : {}),
        OR: [
          { code: normalizedCode },
          ...(this.isUuid(normalizedCode) ? [{ id: normalizedCode }] : []),
        ],
      },
      include: this.mobileBatchInclude(),
    });
  }

  private async findBatchById(id: string, tenantId: string | null) {
    return this.prisma.wmsReceivingBatch.findFirst({
      where: {
        id,
        ...(tenantId ? { tenantId } : {}),
      },
      include: this.mobileBatchInclude(),
    });
  }

  private async buildMobileBinDetail(id: string, tenantId: string | null) {
    const bin = await this.prisma.wmsLocation.findUnique({
      where: { id },
      include: {
        warehouse: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        inventoryUnits: {
          where: {
            ...(tenantId ? { tenantId } : {}),
          },
          select: {
            id: true,
            code: true,
            barcode: true,
            status: true,
            updatedAt: true,
            posProduct: {
              select: {
                id: true,
                name: true,
                customId: true,
              },
            },
          },
          orderBy: [{ updatedAt: 'desc' }],
          take: 20,
        },
        _count: {
          select: {
            inventoryUnits: true,
          },
        },
      },
    });

    if (!bin || !bin.isActive) {
      return null;
    }

    const occupiedUnits = bin._count.inventoryUnits;
    const availableUnits = bin.capacity === null ? null : Math.max(bin.capacity - occupiedUnits, 0);

    return {
      id: bin.id,
      code: bin.code,
      barcode: bin.barcode,
      name: bin.name,
      kind: bin.kind,
      label: `${bin.warehouse.code} · ${bin.code}`,
      warehouse: bin.warehouse,
      capacity: bin.capacity,
      occupiedUnits,
      availableUnits,
      isFull: bin.capacity !== null ? occupiedUnits >= bin.capacity : false,
      units: bin.inventoryUnits.map((unit) => ({
        id: unit.id,
        code: unit.code,
        barcode: unit.barcode,
        status: unit.status,
        statusLabel: this.formatEnumLabel(unit.status),
        name: unit.posProduct.name,
        customId: unit.posProduct.customId,
        updatedAt: unit.updatedAt,
      })),
    };
  }

  private mobileCountSessionInclude() {
    return {
      warehouse: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
      location: {
        include: {
          warehouse: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      },
      startedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      submittedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      closedBy: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      entries: {
        orderBy: [
          { status: 'asc' },
          { scannedAt: 'desc' },
          { createdAt: 'asc' },
        ],
      },
    } satisfies Prisma.WmsInventoryCountSessionInclude;
  }

  private async findMobileCountSessionById(id: string, tenantId: string | null) {
    return this.prisma.wmsInventoryCountSession.findFirst({
      where: {
        id,
        ...(tenantId ? { tenantId } : {}),
      },
      include: this.mobileCountSessionInclude(),
    });
  }

  private async refreshCountSessionSummary(tx: Prisma.TransactionClient, sessionId: string) {
    const grouped = await tx.wmsInventoryCountEntry.groupBy({
      by: ['status'],
      where: {
        sessionId,
      },
      _count: {
        _all: true,
      },
    });

    const counts = Object.fromEntries(
      grouped.map((group) => [group.status, group._count._all]),
    ) as Partial<Record<WmsInventoryCountEntryStatus, number>>;

    const expectedUnitCount =
      (counts[WmsInventoryCountEntryStatus.PENDING] ?? 0)
      + (counts[WmsInventoryCountEntryStatus.COUNTED] ?? 0)
      + (counts[WmsInventoryCountEntryStatus.MISSING] ?? 0);

    await tx.wmsInventoryCountSession.update({
      where: { id: sessionId },
      data: {
        expectedUnitCount,
        countedUnitCount: counts[WmsInventoryCountEntryStatus.COUNTED] ?? 0,
        missingUnitCount: counts[WmsInventoryCountEntryStatus.MISSING] ?? 0,
        unexpectedUnitCount: counts[WmsInventoryCountEntryStatus.UNEXPECTED] ?? 0,
      },
    });
  }

  private mapMobileCountSessionSummary(session: any) {
    const pendingUnitCount = Math.max(
      session.expectedUnitCount - session.countedUnitCount - session.missingUnitCount,
      0,
    );

    return {
      id: session.id,
      status: session.status,
      statusLabel: this.formatEnumLabel(session.status),
      warehouse: session.warehouse,
      location: {
        id: session.location.id,
        code: session.location.code,
        name: session.location.name,
        kind: session.location.kind,
        label: `${session.location.warehouse.code} · ${session.location.code}`,
      },
      notes: session.notes,
      startedAt: session.startedAt,
      submittedAt: session.submittedAt,
      closedAt: session.closedAt,
      startedBy: this.mapActor(session.startedBy),
      submittedBy: this.mapActor(session.submittedBy),
      closedBy: this.mapActor(session.closedBy),
      summary: {
        expectedUnits: session.expectedUnitCount,
        countedUnits: session.countedUnitCount,
        pendingUnits: pendingUnitCount,
        missingUnits: session.missingUnitCount,
        unexpectedUnits: session.unexpectedUnitCount,
        varianceUnits: session.missingUnitCount + session.unexpectedUnitCount,
      },
    };
  }

  private mapMobileCountSessionDetail(session: any) {
    return {
      ...this.mapMobileCountSessionSummary(session),
      entries: Array.isArray(session.entries)
        ? session.entries.map((entry: any) => ({
            id: entry.id,
            inventoryUnitId: entry.inventoryUnitId ?? null,
            status: entry.status,
            statusLabel: this.formatEnumLabel(entry.status),
            unitCode: entry.unitCode,
            unitBarcode: entry.unitBarcode,
            productName: entry.productName,
            productCustomId: entry.productCustomId,
            scannedCode: entry.scannedCode ?? null,
            scannedAt: entry.scannedAt ?? null,
          }))
        : [],
    };
  }

  private async resolveTargetLocation(targetCode: string, warehouseId: string) {
    const code = this.normalizeScannedCode(targetCode);
    const candidates = await this.buildLocationLookupCandidates(code, warehouseId);
    const targetSelect = {
      id: true,
      code: true,
      name: true,
      kind: true,
      warehouseId: true,
      capacity: true,
      warehouse: {
        select: {
          code: true,
          name: true,
        },
      },
    } satisfies Prisma.WmsLocationSelect;

    const target = await this.prisma.wmsLocation.findFirst({
      where: {
        warehouseId,
        isActive: true,
        OR: this.buildLocationLookupWhere(candidates, code),
      },
      select: targetSelect,
    });

    if (target) {
      return this.toMobileTargetLocation(target);
    }

    const targetInAnotherWarehouse = await this.prisma.wmsLocation.findFirst({
      where: {
        isActive: true,
        OR: this.buildLocationLookupWhere(candidates, code),
      },
      select: targetSelect,
    });

    if (targetInAnotherWarehouse) {
      throw new BadRequestException(
        `Target bin ${targetInAnotherWarehouse.code} belongs to ${targetInAnotherWarehouse.warehouse.code}, not this unit warehouse`,
      );
    }

    const targetWarehouse = await this.prisma.wmsWarehouse.findUnique({
      where: { id: warehouseId },
      select: { code: true },
    });

    if (!targetWarehouse) {
      throw new BadRequestException('Target location was not found in this warehouse');
    }

    throw new BadRequestException(
      `Target location ${code} was not found in warehouse ${targetWarehouse.code}`,
    );
  }

  private async resolveWarehouseOperationalLocation(warehouseId: string, kind: WmsLocationKind) {
    const location = await this.prisma.wmsLocation.findFirst({
      where: {
        warehouseId,
        kind,
        isActive: true,
      },
      select: {
        id: true,
        code: true,
        name: true,
        kind: true,
        warehouseId: true,
        capacity: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });

    if (location) {
      return {
        id: location.id,
        code: location.code,
        name: location.name,
        kind: location.kind,
        warehouseId: location.warehouseId,
        capacity: location.capacity,
      };
    }

    const warehouse = await this.prisma.wmsWarehouse.findUnique({
      where: { id: warehouseId },
      select: {
        code: true,
      },
    });

    const locationLabel = this.formatEnumLabel(kind);
    const warehouseLabel = warehouse?.code ?? 'This warehouse';
    throw new BadRequestException(`${warehouseLabel} is missing an active ${locationLabel} location`);
  }

  private async buildLocationLookupCandidates(rawCode: string, warehouseId?: string) {
    const code = this.normalizeScannedCode(rawCode);
    const candidates = new Set<string>();
    this.addLocationLookupCandidate(candidates, code);

    if (!code) {
      return [];
    }

    const warehouses = warehouseId
      ? await this.prisma.wmsWarehouse.findMany({
          where: { id: warehouseId },
          select: { code: true },
        })
      : await this.prisma.wmsWarehouse.findMany({
          select: { code: true },
    });

    warehouses.forEach((warehouse) => {
      [`WMS-${warehouse.code}-`, `${warehouse.code}-`].forEach((prefix) => {
        if (code.toUpperCase().startsWith(prefix.toUpperCase())) {
          const stripped = code.slice(prefix.length).trim();

          if (stripped.length > 0) {
            this.addLocationLookupCandidate(candidates, stripped);
          }
        }
      });
    });

    return Array.from(candidates);
  }

  private async resolveWarehouseScopeFromLocationCode(rawCode: string) {
    const code = this.normalizeScannedCode(rawCode);
    if (!code) {
      return null;
    }

    const warehouses = await this.prisma.wmsWarehouse.findMany({
      select: {
        id: true,
        code: true,
      },
      orderBy: {
        code: 'desc',
      },
    });

    const matchingWarehouse = warehouses
      .sort((left, right) => right.code.length - left.code.length)
      .find((warehouse) =>
        [`WMS-${warehouse.code}-`, `${warehouse.code}-`].some((prefix) =>
          code.toUpperCase().startsWith(prefix.toUpperCase()),
        ),
      );

    return matchingWarehouse?.id ?? null;
  }

  private buildLocationLookupWhere(candidates: string[], scannedCode: string): Prisma.WmsLocationWhereInput[] {
    return [
      ...candidates.flatMap((candidate) => [
        { code: { equals: candidate, mode: 'insensitive' as const } },
        { barcode: { equals: candidate, mode: 'insensitive' as const } },
      ]),
      ...(this.isUuid(scannedCode) ? [{ id: scannedCode }] : []),
    ];
  }

  private addLocationLookupCandidate(candidates: Set<string>, value: string) {
    const normalized = this.normalizeScannedCode(value);

    if (!normalized) {
      return;
    }

    candidates.add(normalized);
    candidates.add(normalized.toUpperCase());
  }

  private toMobileTargetLocation(
    target: Prisma.WmsLocationGetPayload<{
      select: {
        id: true;
        code: true;
        name: true;
        kind: true;
        warehouseId: true;
        capacity: true;
        warehouse: {
          select: {
            code: true;
            name: true;
          };
        };
      };
    }>,
  ) {
    return {
      id: target.id,
      code: target.code,
      name: target.name,
      kind: target.kind,
      warehouseId: target.warehouseId,
      capacity: target.capacity,
    };
  }

  private async assertActionTenantAccess(
    user: BootstrapUser,
    requestedTenantId: string | null | undefined,
    unitTenantId: string,
    request?: Request,
  ) {
    const tenantContext = await this.resolveMobileStockContext(
      user,
      { tenantId: requestedTenantId ?? undefined },
      request,
    );

    if (tenantContext.tenantId && tenantContext.tenantId !== unitTenantId) {
      throw new ForbiddenException('Selected unit is outside the active Partner scope');
    }
  }

  private async assertLocationCapacity(
    tx: Prisma.TransactionClient,
    targetLocationId: string,
    targetCode: string,
    capacity: number | null,
    demand: number,
    sourceLocationId: string | null,
  ) {
    if (capacity === null) {
      throw new BadRequestException(`Bin ${targetCode} is missing a capacity setting`);
    }

    if (sourceLocationId === targetLocationId) {
      return;
    }

    const occupiedUnits = await tx.wmsInventoryUnit.count({
      where: {
        currentLocationId: targetLocationId,
      },
    });
    const availableUnits = Math.max(capacity - occupiedUnits, 0);

    if (demand > availableUnits) {
      throw new BadRequestException(
        `Bin ${targetCode} has space for ${availableUnits} more unit${availableUnits === 1 ? '' : 's'}`,
      );
    }
  }

  private async refreshReceivingBatchPutawayState(
    tx: Prisma.TransactionClient,
    receivingBatchId: string,
    actorId: string | null,
    now: Date,
  ) {
    const [batch, totalUnits, completedUnits, stagedUnits] = await Promise.all([
      tx.wmsReceivingBatch.findUnique({
        where: { id: receivingBatchId },
        select: {
          status: true,
        },
      }),
      tx.wmsInventoryUnit.count({
        where: {
          receivingBatchId,
        },
      }),
      tx.wmsInventoryUnit.count({
        where: {
          receivingBatchId,
          OR: [
            {
              status: {
                in: [...RECEIVING_BATCH_COMPLETED_BIN_UNIT_STATUSES],
              },
              currentLocation: {
                is: {
                  kind: WmsLocationKind.BIN,
                },
              },
            },
            {
              status: {
                in: [...RECEIVING_BATCH_COMPLETED_NON_BIN_UNIT_STATUSES],
              },
            },
          ],
        },
      }),
      tx.wmsInventoryUnit.count({
        where: {
          receivingBatchId,
          status: WmsInventoryUnitStatus.STAGED,
          currentLocation: {
            is: {
              kind: WmsLocationKind.RECEIVING_STAGING,
            },
          },
        },
      }),
    ]);

    if (!batch) {
      throw new NotFoundException('Receiving batch was not found');
    }

    if (batch.status === WmsReceivingBatchStatus.CANCELED) {
      return;
    }

    const nextStatus = deriveReceivingBatchStatus({
      totalUnits,
      stagedUnits,
      completedUnits,
    });

    await tx.wmsReceivingBatch.update({
      where: { id: receivingBatchId },
      data: {
        status: nextStatus,
        completedAt: nextStatus === WmsReceivingBatchStatus.COMPLETED ? now : null,
        ...(actorId ? { updatedById: actorId } : {}),
      },
    });
  }

  private mobileUnitInclude() {
    return {
      tenant: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      store: {
        select: {
          id: true,
          name: true,
          shopName: true,
        },
      },
      warehouse: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
      currentLocation: {
        select: {
          id: true,
          code: true,
          barcode: true,
          name: true,
          kind: true,
        },
      },
      receivingBatch: {
        select: {
          id: true,
          code: true,
          status: true,
        },
      },
      productProfile: {
        select: {
          requiresExpirationDate: true,
        },
      },
      posProduct: {
        select: {
          id: true,
          name: true,
          customId: true,
        },
      },
      movements: {
        include: {
          fromLocation: {
            select: {
              id: true,
              code: true,
              name: true,
              kind: true,
            },
          },
          toLocation: {
            select: {
              id: true,
              code: true,
              name: true,
              kind: true,
            },
          },
          actor: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }],
        take: 8,
      },
    } satisfies Prisma.WmsInventoryUnitInclude;
  }

  private mobileBatchInclude() {
    return {
      tenant: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      store: {
        select: {
          id: true,
          name: true,
          shopName: true,
        },
      },
      lines: {
        select: {
          store: {
            select: {
              id: true,
              name: true,
              shopName: true,
            },
          },
        },
      },
      warehouse: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
      stagingLocation: {
        select: {
          id: true,
          code: true,
          name: true,
          kind: true,
        },
      },
      inventoryUnits: {
        include: {
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
            },
          },
          currentLocation: {
            select: {
              id: true,
              code: true,
              name: true,
              kind: true,
            },
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 30,
      },
      _count: {
        select: {
          inventoryUnits: true,
        },
      },
    } satisfies Prisma.WmsReceivingBatchInclude;
  }

  private summarizeMobileReceivingBatchStore(input: {
    fallbackStore?: {
      id: string;
      name: string;
      shopName: string | null;
    } | null;
    lines?: Array<{
      store?: {
        id: string;
        name: string;
        shopName: string | null;
      } | null;
    }> | null;
  }) {
    const seen = new Map<string, { id: string | null; name: string }>();

    for (const line of input.lines ?? []) {
      const store = line.store;
      if (!store || seen.has(store.id)) {
        continue;
      }

      seen.set(store.id, {
        id: store.id,
        name: store.shopName || store.name,
      });
    }

    if (!seen.size && input.fallbackStore) {
      seen.set(input.fallbackStore.id, {
        id: input.fallbackStore.id,
        name: input.fallbackStore.shopName || input.fallbackStore.name,
      });
    }

    const stores = Array.from(seen.values()).sort((left, right) => left.name.localeCompare(right.name));
    if (stores.length === 1) {
      return stores[0];
    }

    return {
      id: null,
      name: stores.length > 1 ? `${stores.length} stores` : 'No store',
    };
  }

  private mapMobileUnitDetail(unit: any) {
    return {
      id: unit.id,
      tenantId: unit.tenantId,
      tenant: unit.tenant,
      store: {
        id: unit.store.id,
        name: unit.store.shopName || unit.store.name,
      },
      warehouse: unit.warehouse,
      code: unit.code,
      barcode: unit.barcode,
      status: unit.status,
      statusLabel: this.formatEnumLabel(unit.status),
      expirationDate: unit.expirationDate,
      expiredAt: unit.expiredAt,
      productId: unit.productId,
      variationId: unit.variationId,
      name: unit.posProduct.name,
      customId: unit.posProduct.customId,
      receivingBatch: unit.receivingBatch
        ? {
            id: unit.receivingBatch.id,
            code: unit.receivingBatch.code,
            status: unit.receivingBatch.status,
            statusLabel: this.formatEnumLabel(unit.receivingBatch.status),
          }
        : null,
      currentLocation: unit.currentLocation ? this.mapLocation(unit.currentLocation) : null,
      allowedActions: {
        putaway: this.isMobilePutawayCandidate(unit),
        move: this.isMobileMoveCandidate(unit),
      },
      movements: Array.isArray(unit.movements)
        ? unit.movements.map((movement: any) => this.mapMobileMovement(movement))
        : [],
      updatedAt: unit.updatedAt,
    };
  }

  private isMobilePutawayCandidate(unit: {
    status: WmsInventoryUnitStatus;
    currentLocationId?: string | null;
    currentLocation?: { kind: WmsLocationKind } | null;
  }) {
    return (
      MOBILE_PUTAWAY_SOURCE_STATUSES.has(unit.status)
      && Boolean(unit.currentLocationId)
      && unit.currentLocation?.kind === WmsLocationKind.RECEIVING_STAGING
    );
  }

  private isMobileMoveCandidate(unit: {
    status: WmsInventoryUnitStatus;
    currentLocationId?: string | null;
    currentLocation?: { kind: WmsLocationKind } | null;
  }) {
    return (
      Boolean(unit.currentLocationId)
      && STOCK_TRANSFERABLE_UNIT_STATUSES.includes(unit.status as typeof STOCK_TRANSFERABLE_UNIT_STATUSES[number])
      && !this.isMobilePutawayCandidate(unit)
    );
  }

  private assertMobileActionPreconditions(
    unit: {
      code: string;
      status: WmsInventoryUnitStatus;
      currentLocationId?: string | null;
      updatedAt: Date;
    },
    body: Pick<
      WmsMobileStockMoveDto,
      'expectedStatus' | 'expectedCurrentLocationId' | 'expectedUpdatedAt'
    >,
  ) {
    if (body.expectedStatus && body.expectedStatus !== unit.status) {
      throw new ConflictException(
        `Unit ${unit.code} changed from ${body.expectedStatus} to ${unit.status}. Rescan before continuing.`,
      );
    }

    if (body.expectedCurrentLocationId !== undefined) {
      const expectedLocationId = body.expectedCurrentLocationId ?? null;
      const actualLocationId = unit.currentLocationId ?? null;

      if (expectedLocationId !== actualLocationId) {
        throw new ConflictException(`Unit ${unit.code} moved after it was scanned. Rescan before continuing.`);
      }
    }

    if (body.expectedUpdatedAt) {
      const expectedUpdatedAt = new Date(body.expectedUpdatedAt);

      if (Number.isNaN(expectedUpdatedAt.getTime())) {
        throw new BadRequestException('Invalid expected unit timestamp');
      }

      if (expectedUpdatedAt.getTime() !== unit.updatedAt.getTime()) {
        throw new ConflictException(`Unit ${unit.code} changed after it was scanned. Rescan before continuing.`);
      }
    }
  }

  private mapMobileBatchDetail(batch: any) {
    const storeSummary = this.summarizeMobileReceivingBatchStore({
      fallbackStore: batch.store,
      lines: batch.lines,
    });

    return {
      id: batch.id,
      tenantId: batch.tenantId,
      tenant: batch.tenant,
      code: batch.code,
      status: batch.status,
      statusLabel: this.formatEnumLabel(batch.status),
      store: storeSummary,
      warehouse: batch.warehouse,
      stagingLocation: batch.stagingLocation ? this.mapLocation(batch.stagingLocation) : null,
      unitCount: batch._count?.inventoryUnits ?? batch.inventoryUnits?.length ?? 0,
      units: Array.isArray(batch.inventoryUnits)
        ? batch.inventoryUnits.map((unit: any) => ({
            id: unit.id,
            code: unit.code,
            barcode: unit.barcode,
            status: unit.status,
            statusLabel: this.formatEnumLabel(unit.status),
            name: unit.posProduct.name,
            customId: unit.posProduct.customId,
            currentLocation: unit.currentLocation ? this.mapLocation(unit.currentLocation) : null,
            updatedAt: unit.updatedAt,
          }))
        : [],
      updatedAt: batch.updatedAt,
    };
  }

  private mapMobileMovement(movement: any) {
    return {
      id: movement.id,
      movementType: movement.movementType,
      fromStatus: movement.fromStatus,
      fromStatusLabel: movement.fromStatus ? this.formatEnumLabel(movement.fromStatus) : null,
      toStatus: movement.toStatus,
      toStatusLabel: movement.toStatus ? this.formatEnumLabel(movement.toStatus) : null,
      referenceType: movement.referenceType,
      referenceId: movement.referenceId,
      referenceCode: movement.referenceCode,
      notes: movement.notes,
      fromLocation: movement.fromLocation ? this.mapLocation(movement.fromLocation) : null,
      toLocation: movement.toLocation ? this.mapLocation(movement.toLocation) : null,
      actor: this.mapActor(movement.actor),
      createdAt: movement.createdAt,
    };
  }

  private async recordStockActivity(
    user: BootstrapUser,
    request: Request | undefined,
    activity: {
      tenantId: string | null;
      actionType: string;
      resourceType: string;
      resourceId: string | null;
      taskType?: string | null;
      taskId?: string | null;
      storeId?: string | null;
      warehouseId?: string | null;
      fromStatus?: string | null;
      toStatus?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId: activity.tenantId,
      actorId: user.userId || user.id || null,
      sessionId: (this.cls.get('sessionId') as string | undefined) || user.sessionId || null,
      actionType: activity.actionType,
      resourceType: activity.resourceType,
      resourceId: activity.resourceId,
      taskType: activity.taskType,
      taskId: activity.taskId,
      storeId: activity.storeId,
      warehouseId: activity.warehouseId,
      fromStatus: activity.fromStatus,
      toStatus: activity.toStatus,
      metadata: activity.metadata as Prisma.InputJsonValue | undefined,
    });
  }

  private isMobileMoveDestinationAllowed(kind: WmsLocationKind) {
    return MOBILE_MOVE_DESTINATION_KINDS.has(kind);
  }

  private resolveMobileMoveStatus(
    currentStatus: WmsInventoryUnitStatus,
    targetKind: WmsLocationKind,
  ) {
    if (currentStatus === WmsInventoryUnitStatus.EXPIRED) {
      return WmsInventoryUnitStatus.EXPIRED;
    }

    if (targetKind === WmsLocationKind.BIN) {
      return currentStatus === WmsInventoryUnitStatus.DEADSTOCK
        ? WmsInventoryUnitStatus.DEADSTOCK
        : WmsInventoryUnitStatus.PUTAWAY;
    }

    if (targetKind === WmsLocationKind.RECEIVING_STAGING) {
      return WmsInventoryUnitStatus.STAGED;
    }

    if (targetKind === WmsLocationKind.RTS) {
      return WmsInventoryUnitStatus.RTS;
    }

    if (targetKind === WmsLocationKind.DAMAGE || targetKind === WmsLocationKind.QUARANTINE) {
      return WmsInventoryUnitStatus.DAMAGED;
    }

    return currentStatus;
  }

  private resolveRtsDisposition(
    disposition: WmsMobileTrackingReturnDispositionDto['disposition'],
    targetKind: WmsLocationKind | null,
  ) {
    switch (disposition) {
      case 'STAGED':
        if (targetKind !== WmsLocationKind.RECEIVING_STAGING) {
          throw new BadRequestException('Stage target must be a receiving staging location');
        }

        return {
          nextStatus: WmsInventoryUnitStatus.STAGED,
          actionLabel: 'Staged',
          requiresTransfer: true,
        };
      case 'PUTAWAY':
        if (targetKind !== WmsLocationKind.BIN) {
          throw new BadRequestException('Putaway target must be a bin');
        }

        return {
          nextStatus: WmsInventoryUnitStatus.PUTAWAY,
          actionLabel: 'Putaway',
          requiresTransfer: true,
        };
      case 'DEADSTOCK':
        if (targetKind !== WmsLocationKind.BIN) {
          throw new BadRequestException('Deadstock target must be a bin');
        }

        return {
          nextStatus: WmsInventoryUnitStatus.DEADSTOCK,
          actionLabel: 'Deadstock',
          requiresTransfer: true,
        };
      case 'DAMAGE':
        if (targetKind !== WmsLocationKind.DAMAGE && targetKind !== WmsLocationKind.QUARANTINE) {
          throw new BadRequestException('Damage target must be a damage or quarantine location');
        }

        return {
          nextStatus: WmsInventoryUnitStatus.DAMAGED,
          actionLabel: 'Damaged',
          requiresTransfer: true,
        };
      case 'LOST':
        if (targetKind !== null) {
          throw new BadRequestException('Lost disposition does not accept a target location');
        }

        return {
          nextStatus: WmsInventoryUnitStatus.LOST,
          actionLabel: 'Lost',
          requiresTransfer: false,
        };
      case 'ARCHIVED':
        if (targetKind !== null) {
          throw new BadRequestException('Archive disposition does not accept a target location');
        }

        return {
          nextStatus: WmsInventoryUnitStatus.ARCHIVED,
          actionLabel: 'Archived',
          requiresTransfer: false,
        };
      default:
        throw new BadRequestException('Unsupported RTS disposition action');
    }
  }

  private async resolveTrackingReturnDispositionTarget(
    warehouseId: string,
    disposition: WmsMobileTrackingReturnDispositionDto['disposition'],
    targetCode: string | null,
  ) {
    if (targetCode) {
      return this.resolveTargetLocation(targetCode, warehouseId);
    }

    if (disposition === 'STAGED') {
      return this.resolveWarehouseOperationalLocation(warehouseId, WmsLocationKind.RECEIVING_STAGING);
    }

    if (disposition === 'DAMAGE') {
      return this.resolveWarehouseOperationalLocation(warehouseId, WmsLocationKind.DAMAGE);
    }

    return null;
  }

  private buildMobileTransferCode() {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 14);
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();

    return `STOX-MV-${timestamp}-${suffix}`;
  }

  private cleanOptionalText(value?: string | null) {
    const trimmed = value?.trim();

    return trimmed && trimmed.length > 0 ? trimmed : null;
  }

  private normalizeScannedCode(value: string) {
    return value
      .normalize('NFKC')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[‐‑‒–—―−]/g, '-')
      .replace(/\s*-\s*/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeTrackingCode(value: string) {
    return this.normalizeScannedCode(value).toUpperCase();
  }

  private isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private buildEmptyStockResponse(tenantReady: boolean) {
    return {
      tenantReady,
      serverTime: new Date().toISOString(),
      pagination: {
        mode: 'putaway',
        page: 1,
        pageSize: DEFAULT_STOCK_PAGE_SIZE,
        total: 0,
        hasMore: false,
      },
      context: {
        tenantOptions: [],
        activeTenantId: null,
        activeStoreId: null,
        activeWarehouseId: null,
        stores: [],
        warehouses: [],
      },
      summary: {
        totalUnits: 0,
        locatedUnits: 0,
        unlocatedUnits: 0,
        stagedUnits: 0,
        movableUnits: 0,
        putawayBatches: 0,
        transfers: 0,
        bins: 0,
        unitsOnHand: 0,
        dispatchedUnits: 0,
        warehouseCapacity: {
          usedUnits: 0,
          totalUnits: 0,
          utilizationPercent: 0,
        },
      },
      putawayQueue: [],
      movableUnits: [],
      recentTransfers: [],
      bins: [],
    };
  }

  private getStockModeTotal(
    mode: WmsMobileStockMode,
    totals: Record<WmsMobileStockMode, number>,
  ) {
    return totals[mode] ?? 0;
  }

  private async getMobileWarehouseCapacitySummary(params: {
    bins: Array<{
      id: string;
      capacity: number | null;
    }>;
    tenantId: string | null;
    storeId: string | null;
    warehouseId: string | null;
  }) {
    const totalUnits = params.bins.reduce((sum, bin) => sum + (bin.capacity ?? 0), 0);
    const binIds = params.bins.map((bin) => bin.id);

    if (!binIds.length || totalUnits === 0) {
      return {
        usedUnits: 0,
        totalUnits,
        utilizationPercent: 0,
      };
    }

    const usedUnits = await this.prisma.wmsInventoryUnit.count({
      where: {
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
        ...(params.storeId ? { storeId: params.storeId } : {}),
        ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
        currentLocationId: {
          in: binIds,
        },
        status: {
          notIn: [
            WmsInventoryUnitStatus.DISPATCHED,
            WmsInventoryUnitStatus.ARCHIVED,
          ],
        },
      },
    });

    return {
      usedUnits,
      totalUnits,
      utilizationPercent: Math.round((usedUnits / totalUnits) * 100),
    };
  }

  private buildTenantSelectionBootstrap(
    user: BootstrapUser,
    userId: string | null,
    sessionId: string | null,
    tenantOptions: MobileTenantOption[],
  ) {
    return {
      tenantReady: false,
      app: {
        key: 'stox',
        phase: 1,
        mode: process.env.NODE_ENV || 'development',
      },
      session: {
        sessionId,
      },
      user: {
        id: userId,
        email: user.email ?? null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        avatar: user.avatar ?? null,
        employeeId: user.employeeId ?? null,
        role: user.role ?? null,
      },
      tenant: null,
      access: {
        permissions: [],
        roles: [],
      },
      operations: {
        taskAssignment: null,
      },
      context: {
        tenantOptions,
        defaultTeamId: null,
        defaultStoreId: null,
        defaultWarehouseId: null,
        teams: [],
        stores: [],
        warehouses: [],
      },
      readiness: {
        teams: 0,
        stores: 0,
        warehouses: 0,
      },
    };
  }

  private buildPlatformBootstrap(
    user: BootstrapUser,
    userId: string,
    sessionId: string | null,
    tenantOptions: MobileTenantOption[],
  ) {
    return {
      tenantReady: true,
      app: {
        key: 'stox',
        phase: 1,
        mode: process.env.NODE_ENV || 'development',
      },
      session: {
        sessionId,
      },
      user: {
        id: userId,
        email: user.email ?? null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        avatar: user.avatar ?? null,
        employeeId: user.employeeId ?? null,
        role: user.role ?? null,
      },
      tenant: null,
      access: {
        permissions: [],
        roles: [],
      },
      operations: {
        taskAssignment: null,
      },
      context: {
        tenantOptions,
        defaultTeamId: null,
        defaultStoreId: null,
        defaultWarehouseId: null,
        teams: [],
        stores: [],
        warehouses: [],
      },
      readiness: {
        teams: 0,
        stores: 0,
        warehouses: 0,
      },
    };
  }

  private async buildGlobalWmsBootstrap(
    user: BootstrapUser,
    userId: string,
    sessionId: string | null,
    tenantOptions: MobileTenantOption[],
    request?: Request,
  ) {
    const [access, taskAssignment, warehouses] = await Promise.all([
      this.effectiveAccessService.resolveUserAccess({
        userId,
        basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
        workspace: 'wms',
      }),
      this.getWmsTaskAssignment(userId),
      this.prisma.wmsWarehouse.findMany({
        where: {
          status: WmsWarehouseStatus.ACTIVE,
        },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
        },
        orderBy: [{ name: 'asc' }],
      }),
    ]);

    if (!access.permissions.some((permission) => permission.startsWith('wms.'))) {
      throw new ForbiddenException('This account has no WMS access');
    }

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      actorId: userId,
      sessionId,
      actionType: 'BOOTSTRAP',
      resourceType: 'STOX_APP',
      resourceId: 'phase-1',
      metadata: {
        tenantCount: tenantOptions.length,
        warehouseCount: warehouses.length,
      },
    });

    return {
      tenantReady: true,
      app: {
        key: 'stox',
        phase: 1,
        mode: process.env.NODE_ENV || 'development',
      },
      session: {
        sessionId,
      },
      user: {
        id: userId,
        email: user.email ?? null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        avatar: user.avatar ?? null,
        employeeId: user.employeeId ?? null,
        role: user.role ?? null,
      },
      tenant: null,
      access: {
        permissions: access.permissions,
        roles: access.roles.map((role) => ({
          id: role.id,
          key: role.key,
          name: role.name,
          scope: role.scope,
          workspace: role.workspace,
          tenantId: role.tenantId,
          teamId: role.teamId,
        })),
      },
      operations: {
        taskAssignment,
      },
      context: {
        tenantOptions,
        defaultTeamId: null,
        defaultStoreId: null,
        defaultWarehouseId: warehouses[0]?.id ?? null,
        teams: [],
        stores: [],
        warehouses: warehouses.map((warehouse) => ({
          id: warehouse.id,
          code: warehouse.code,
          name: warehouse.name,
          status: warehouse.status,
        })),
      },
      readiness: {
        teams: 0,
        stores: 0,
        warehouses: warehouses.length,
      },
    };
  }

  private async resolveMobileStockContext(
    user: BootstrapUser,
    query: GetWmsMobileStockDto,
    request?: Request,
  ) {
    const userTenantId =
      (this.cls.get('tenantId') as string | undefined) || user.tenantId || null;

    const tenantOptions = await this.getPlatformTenantOptions();
    const requestedTenantId = query.tenantId ?? this.readRequestedTenantId(request);

    if (user.role !== 'SUPER_ADMIN' && userTenantId) {
      return {
        tenantId: userTenantId,
        tenantOptions,
      };
    }

    if (!requestedTenantId) {
      return {
        tenantId: null,
        tenantOptions,
      };
    }

    const selectedTenant = tenantOptions.find((tenant) => tenant.id === requestedTenantId);
    if (!selectedTenant) {
      throw new ForbiddenException('Selected partner is not available for STOX');
    }

    return {
      tenantId: selectedTenant.id,
      tenantOptions,
    };
  }

  private async resolveMobileTenantContext(
    user: BootstrapUser,
    request?: Request,
    options: { allowMissingPlatformTenant?: boolean } = {},
  ) {
    const userTenantId =
      (this.cls.get('tenantId') as string | undefined) || user.tenantId || null;

    const tenantOptions = await this.getPlatformTenantOptions();
    const requestedTenantId = this.readRequestedTenantId(request);

    if (user.role !== 'SUPER_ADMIN' && userTenantId) {
      return {
        tenantId: userTenantId,
        tenantOptions,
      };
    }

    if (!requestedTenantId) {
      if (options.allowMissingPlatformTenant) {
        return {
          tenantId: null,
          tenantOptions,
        };
      }

      throw new ForbiddenException('Select a tenant before using STOX');
    }

    const selectedTenant = tenantOptions.find((tenant) => tenant.id === requestedTenantId);
    if (!selectedTenant) {
      throw new ForbiddenException('Selected tenant is not available for STOX');
    }

    return {
      tenantId: selectedTenant.id,
      tenantOptions,
    };
  }

  private async getPlatformTenantOptions(): Promise<MobileTenantOption[]> {
    return this.prisma.tenant.findMany({
      where: {
        status: {
          in: [TenantStatus.ACTIVE, TenantStatus.TRIAL],
        },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
      },
      orderBy: [{ name: 'asc' }],
    });
  }

  private readRequestedTenantId(request?: Request) {
    const rawTenantId = request?.headers['x-tenant-id'];
    const tenantId = Array.isArray(rawTenantId) ? rawTenantId[0] : rawTenantId;

    return typeof tenantId === 'string' && tenantId.trim().length > 0
      ? tenantId.trim()
      : null;
  }

  private mapLocation(location: {
    id: string;
    code: string;
    name: string;
    kind: WmsLocationKind;
  }) {
    return {
      id: location.id,
      code: location.code,
      name: location.name,
      kind: location.kind,
      label: `${location.code} · ${location.name}`,
    };
  }

  private mapActor(actor: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null) {
    if (!actor) {
      return null;
    }

    const name = [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim();

    return {
      name: name || actor.email,
      email: actor.email,
    };
  }

  private formatEnumLabel(value: string) {
    return value
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
}

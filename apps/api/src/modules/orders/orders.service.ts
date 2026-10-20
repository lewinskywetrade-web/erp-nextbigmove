import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'crypto';
import {
  MediaAssetKind,
  NotificationDomain,
  NotificationSystem,
  Prisma,
} from '@prisma/client';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EffectiveAccessService } from '../../common/services/effective-access.service';
import {
  MediaAssetsService,
  type UploadedImageFile,
} from '../../common/services/media-assets.service';
import { NotificationStateService } from '../../common/services/notification-state.service';
import { TeamContextService } from '../../common/services/team-context.service';
import { IntegrationService } from '../integrations/integration.service';
import { WorkflowExecutionGateway } from '../workflows/gateways/workflow-execution.gateway';
import { OrdersAgingNotificationCacheService } from './orders-aging-notification-cache.service';
import {
  AGING_ORDERS_NOTIFICATION_ENTITY_TYPE,
  AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS,
  CONFIRMATION_UPDATE_STATUS_JOB,
  CONFIRMATION_UPDATE_QUEUE,
  ConfirmationUpdateItemPayload,
  ConfirmationUpdateStatusJobData,
  ORDERS_AGING_NOTIFICATION_UPDATED_EVENT,
  ORDERS_UNDELIVERABLES_UPDATED_EVENT,
  type AgingOrdersNotificationBucketKey,
} from './orders.constants';

dayjs.extend(utc);
dayjs.extend(timezone);

const TIMEZONE = process.env.NEXT_PUBLIC_TIMEZONE || process.env.TIMEZONE || 'Asia/Manila';

type ListConfirmationOrdersParams = {
  startDate?: string;
  endDate?: string;
  shopIds?: string | string[];
  search?: string;
  page?: string;
  limit?: string;
};

type ListConfirmationPhoneHistoryParams = {
  phone?: string;
  page?: string;
  limit?: string;
};

type GetAgingOrdersSummaryParams = {
  thresholdDays?: number;
};

type GetOrderStatusSummaryParams = {
  dateLocal?: string;
  shopIds?: string | string[];
};

type PosStoreAccessRow = {
  id: string;
  shopId: string;
  shopName: string | null;
  name: string | null;
};

type PosOrderListRow = {
  id: string;
  shopId: string;
  posOrderId: string;
  dateLocal: string;
  insertedAt: Date;
  status: number | null;
  statusName: string | null;
  isAbandoned: boolean;
  cod: Prisma.Decimal | null;
  reportsByPhoneOrderFail: number | null;
  reportsByPhoneOrderSuccess: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  itemData: Prisma.JsonValue | null;
  orderSnapshot: Prisma.JsonValue | null;
  tags: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

type AssigningSellerPayload = {
  avatar_url: string | null;
  email: string | null;
  fb_id: string | null;
  id: string | null;
  name: string | null;
  phone_number: string | null;
};

type ConfirmationTagOptionRow = {
  tagId: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
};

type ConfirmationOrderTag = {
  id: string | null;
  name: string;
};

type AgingOrdersSummaryRow = {
  shopId: string;
  total_orders: number;
  new_orders: number;
  restocking: number;
  confirmed: number;
  printed: number;
  waiting_pickup: number;
  shipped: number;
  rts: number;
};

type OrderStatusSummaryRow = {
  shop_id: string;
  shop_name: string;
  total_orders: number;
  new_orders: number;
  restocking: number;
  confirmed: number;
  printed: number;
  waiting_pickup: number;
  shipped: number;
  delivered: number;
  returning: number;
  returned: number;
  cancelled: number;
  deleted: number;
};

type OrderStatusSummaryQueryRow = {
  shopId: string;
  newOrders: number;
  restockingOrders: number;
  confirmedOrders: number;
  printedOrders: number;
  waitingPickupOrders: number;
  shippedOrders: number;
  deliveredOrders: number;
  returningOrders: number;
  returnedOrders: number;
  cancelledOrders: number;
  deletedOrders: number;
  totalOrders: number;
};

type AgingOrdersBucketQueryRow = {
  shopId: string;
  bucketKey: AgingOrdersNotificationBucketKey;
  agedCount: number;
  orderIds: string[] | null;
};

type AgingOrdersBucketDetail = {
  shopId: string;
  bucketKey: AgingOrdersNotificationBucketKey;
  agedCount: number;
  orderIds: string[];
};

type AgingOrdersNotificationContext = {
  shopId?: string;
  shopName?: string;
  shopSignature?: string | null;
  affectedOrderCount?: number;
};

type UndeliverableStatus = 2 | 3 | 4 | 5;
type UndeliverableRemarkView = 'needs_remarks' | 'with_remarks' | 'unattended';
type UndeliverableLifecycleStatus =
  | 'AWAITING_REMARK'
  | 'UNATTENDED'
  | 'REMARKED_ON_TIME'
  | 'REMARKED_LATE';

type UndeliverableStoreRow = {
  id: string;
  shopId: string;
  shopName: string | null;
  name: string | null;
};

type UndeliverablesAccessScope = {
  tenantId: string;
  userId: string;
  permissions: string[];
  canReadAll: boolean;
  canAssign: boolean;
  canWriteRemarks: boolean;
  accessibleStores: UndeliverableStoreRow[];
  accessibleShopIds: string[];
  accessibleStoreIds: string[];
};

type UndeliverableUserOption = {
  user_id: string;
  full_name: string;
  email: string;
};

type UndeliverableTrackingUpdate = {
  key: string | null;
  kind: 'problematic' | 'rider';
  title: string;
  detail: string;
  location: string | null;
  status: string;
  tracking_id: string | null;
  updated_at: string | null;
  updated_at_local: string | null;
  sort_timestamp: number;
};

type UndeliverableOrderItem = {
  name: string;
  quantity: number;
  product_display_id: string | null;
};

const UNDELIVERABLE_STATUS_VALUES: UndeliverableStatus[] = [2, 3, 4, 5];
const UNDELIVERABLE_REMARK_SLA_MS = 24 * 60 * 60 * 1000;
const UNDELIVERABLE_STATUS_LABELS: Record<UndeliverableStatus, string> = {
  2: 'Shipped',
  3: 'Delivered',
  4: 'Returning',
  5: 'Returned',
};

type SystemPosOrderStatusUpdateParams = {
  tenantId: string;
  orderRowId: string;
  shopId: string;
  posOrderId: string;
  targetStatus: number;
  allowedCurrentStatuses: number[];
  source: NonNullable<ConfirmationUpdateStatusJobData['source']>;
  requestId?: string | null;
};

const STATIC_ASSIGNING_SELLER_PAYLOAD: AssigningSellerPayload = {
  avatar_url: null,
  email: 'wetradejaysonquiatchon@gmail.com',
  fb_id: '122115075452788142',
  id: '31440f2c-bc28-4d91-bf6e-d09dd921b62c',
  name: 'Arnold Sayson',
  phone_number: null,
};

@Injectable()
export class OrdersService {
  private readonly allowedConfirmationStatusUpdates = new Set([1, 6, 7, 11]);
  private readonly logger = new Logger(OrdersService.name);
  private readonly confirmationStatusLabels: Record<number, string> = {
    1: 'Confirm',
    6: 'Cancel',
    7: 'Delete',
    11: 'Restocking',
    12: 'Waiting for printing',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly teamContext: TeamContextService,
    private readonly effectiveAccess: EffectiveAccessService,
    private readonly notificationStateService: NotificationStateService,
    private readonly mediaAssetsService: MediaAssetsService,
    private readonly integrationService: IntegrationService,
    private readonly workflowExecutionGateway: WorkflowExecutionGateway,
    private readonly ordersAgingNotificationCache: OrdersAgingNotificationCacheService,
    @InjectQueue(CONFIRMATION_UPDATE_QUEUE)
    private readonly confirmationUpdateQueue: Queue<ConfirmationUpdateStatusJobData>,
  ) {}

  private normalizeDateLocal(value: string | undefined, fallback: string): string {
    if (!value) return fallback;
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return fallback;
    const parsed = dayjs.tz(`${trimmed}T00:00:00`, TIMEZONE);
    if (!parsed.isValid()) return fallback;
    return parsed.format('YYYY-MM-DD');
  }

  private getTodayDateLocal(): string {
    return dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
  }

  private parseUndeliverableAddress(rawAddress: string | null | undefined) {
    const parts = (rawAddress ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length === 0) {
      return {
        address: null as string | null,
        barangay: null as string | null,
        city: null as string | null,
        province: null as string | null,
      };
    }

    if (parts.length >= 4) {
      return {
        address: parts.slice(0, -3).join(', ') || null,
        barangay: parts[parts.length - 3] ?? null,
        city: parts[parts.length - 2] ?? null,
        province: parts[parts.length - 1] ?? null,
      };
    }

    return {
      address: parts[0] ?? null,
      barangay: parts[1] ?? null,
      city: parts[2] ?? null,
      province: null,
    };
  }

  private parseTrackingUpdateDate(rawValue: string | null): {
    local: string | null;
    timestamp: number;
  } {
    if (!rawValue) {
      return { local: null, timestamp: 0 };
    }

    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawValue);
    // Carrier update_at values are UTC even when the source omits the timezone suffix.
    const parsed = (hasTimezone ? dayjs(rawValue) : dayjs.utc(rawValue)).tz(TIMEZONE);
    if (!parsed.isValid()) {
      return { local: null, timestamp: 0 };
    }

    return {
      local: parsed.format(),
      timestamp: parsed.valueOf(),
    };
  }

  private parseUndeliverableTrackingUpdate(value: Prisma.JsonValue): UndeliverableTrackingUpdate | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const entry = value as Prisma.JsonObject;
    const status = typeof entry.status === 'string' ? entry.status.trim() : '';
    const note = typeof entry.note === 'string' ? entry.note.trim() : '';
    const isRiderUpdate = status.toLowerCase().includes('sprinter');
    if (!note && !isRiderUpdate) {
      return null;
    }

    const sourceText = note || status;
    const bracketValues = Array.from(sourceText.matchAll(/【([^】]+)】/g))
      .map((match) => match[1]?.trim())
      .filter((item): item is string => Boolean(item));
    const reasonMatch = note.match(/reason【([^】]+)】/i);
    const riderMatch = status.match(/sprinter【([^】]+)】/i);
    const updatedAt = typeof entry.update_at === 'string' ? entry.update_at.trim() || null : null;
    const parsedDate = this.parseTrackingUpdateDate(updatedAt);
    const kind: UndeliverableTrackingUpdate['kind'] = note ? 'problematic' : 'rider';

    return {
      key: typeof entry.key === 'string' ? entry.key.trim() || null : null,
      kind,
      title: kind === 'problematic' ? 'Delivery failed' : 'Rider out for delivery',
      detail:
        (kind === 'problematic' ? reasonMatch?.[1]?.trim() : riderMatch?.[1]?.trim())
        || sourceText,
      location: bracketValues[0] ?? null,
      status,
      tracking_id:
        typeof entry.tracking_id === 'string' ? entry.tracking_id.trim() || null : null,
      updated_at: updatedAt,
      updated_at_local: parsedDate.local,
      sort_timestamp: parsedDate.timestamp,
    };
  }

  private parseUndeliverableOrderItems(value: Prisma.JsonValue): UndeliverableOrderItem[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((rawItem) => {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        return [];
      }

      const item = rawItem as Prisma.JsonObject;
      const variationInfo = item.variation_info;
      const variation = variationInfo && typeof variationInfo === 'object' && !Array.isArray(variationInfo)
        ? variationInfo as Prisma.JsonObject
        : null;
      const nameCandidates = [
        item.variationName,
        item.variation_name,
        item.productName,
        item.product_name,
        item.name,
        variation?.name,
      ];
      const name = nameCandidates.find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
      )?.trim();

      if (!name) {
        return [];
      }

      const rawQuantity = Number(item.quantity ?? 0);
      const quantity = Number.isFinite(rawQuantity) ? Math.max(0, rawQuantity) : 0;
      const displayIdCandidates = [
        item.productDisplayId,
        item.product_display_id,
        variation?.product_display_id,
        variation?.display_id,
      ];
      const productDisplayId = displayIdCandidates.find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
      )?.trim() ?? null;

      return [{ name, quantity, product_display_id: productDisplayId }];
    });
  }

  private parsePage(raw?: string): number {
    const parsed = Number.parseInt(raw || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  private parseLimit(raw?: string): number {
    const parsed = Number.parseInt(raw || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 20;
    return Math.min(parsed, 200);
  }

  private parseThresholdDays(raw?: number): number {
    if (!Number.isFinite(raw)) return AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS;
    const normalized = Math.trunc(Number(raw));
    if (normalized < 1) return 1;
    return Math.min(normalized, 30);
  }

  private getAgingOrderNotificationEntityId(shopId: string) {
    return shopId;
  }

  private parseAgingOrderNotificationEntityId(entityId: string): { shopId: string } | null {
    const trimmed = entityId.trim();
    if (!trimmed) {
      return null;
    }

    const separatorIndex = entityId.indexOf(':');
    if (separatorIndex > 0) {
      const shopId = entityId.slice(0, separatorIndex).trim();
      return shopId ? { shopId } : null;
    }

    return {
      shopId: trimmed,
    };
  }

  private getAgingOrderNotificationSignature(orderIds: string[]) {
    return createHash('sha1').update(orderIds.join('|')).digest('hex');
  }

  private getConfirmationUpdateProcessingTtlSeconds(): number {
    const raw = process.env.CONFIRMATION_UPDATE_PROCESSING_TTL_SECONDS;
    const parsed = Number.parseInt(raw || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 300;
    return Math.min(parsed, 3600);
  }

  private getConfirmationUpdateProcessingCutoff(): Date {
    return dayjs().subtract(this.getConfirmationUpdateProcessingTtlSeconds(), 'second').toDate();
  }

  private parseShopIds(raw?: string | string[]): string[] {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const exploded = list
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return Array.from(new Set(exploded));
  }

  private parseUuidArray(raw?: string | string[]): string[] {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const exploded = list
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry));

    return Array.from(new Set(exploded));
  }

  private parseUndeliverableStatuses(raw?: string | string[]): UndeliverableStatus[] {
    if (!raw) {
      return [];
    }

    const list = Array.isArray(raw) ? raw : [raw];
    const parsed = list
      .flatMap((entry) => entry.split(','))
      .map((entry) => Number.parseInt(entry.trim(), 10))
      .filter((value): value is UndeliverableStatus => UNDELIVERABLE_STATUS_VALUES.includes(value as UndeliverableStatus));

    return parsed.length > 0 ? Array.from(new Set(parsed)) : [];
  }

  private parseUndeliverableView(raw?: string): UndeliverableRemarkView {
    if (raw === 'with_remarks' || raw === 'unattended') {
      return raw;
    }

    return 'needs_remarks';
  }

  private buildUndeliverableLifecycle(params: {
    failedAt: Date;
    remark: string | null;
    remarkedAt: Date | null;
    updatedAt: Date;
    now: Date;
  }): {
    deadline_at: string;
    lifecycle_status: UndeliverableLifecycleStatus;
    remaining_seconds: number | null;
    remarked_late: boolean;
  } {
    const deadlineAt = new Date(params.failedAt.getTime() + UNDELIVERABLE_REMARK_SLA_MS);
    const hasRemark = Boolean(params.remark);
    const responseAt = params.remarkedAt ?? (hasRemark ? params.updatedAt : null);
    const remarkedLate = Boolean(responseAt && responseAt.getTime() > deadlineAt.getTime());

    let lifecycleStatus: UndeliverableLifecycleStatus;
    let remainingSeconds: number | null = null;
    if (hasRemark) {
      lifecycleStatus = remarkedLate ? 'REMARKED_LATE' : 'REMARKED_ON_TIME';
    } else {
      remainingSeconds = Math.ceil((deadlineAt.getTime() - params.now.getTime()) / 1000);
      lifecycleStatus = remainingSeconds <= 0 ? 'UNATTENDED' : 'AWAITING_REMARK';
    }

    return {
      deadline_at: deadlineAt.toISOString(),
      lifecycle_status: lifecycleStatus,
      remaining_seconds: remainingSeconds,
      remarked_late: remarkedLate,
    };
  }

  private getCurrentUserBasePermissions(): string[] {
    const permissions = this.cls.get('userPermissions');
    if (!Array.isArray(permissions)) {
      return [];
    }

    return permissions.filter((value): value is string => typeof value === 'string');
  }

  private buildUndeliverableStoreLabel(store: {
    name: string | null;
    shopName: string | null;
    shopId: string;
  }) {
    return store.name?.trim() || store.shopName?.trim() || store.shopId;
  }

  private buildUndeliverableUserLabel(user: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  }) {
    const fullName = [user.firstName?.trim(), user.lastName?.trim()].filter(Boolean).join(' ').trim();
    return fullName || user.email.trim();
  }

  private async resolveUndeliverablesAccessScope(): Promise<UndeliverablesAccessScope> {
    const { tenantId, userId, teamIds, userTeams } = await this.teamContext.getContext();
    const requestedTeamIds =
      (Array.isArray(teamIds) && teamIds.length > 0 ? teamIds : userTeams) || [];
    const basePermissions = this.getCurrentUserBasePermissions();
    const access = await this.effectiveAccess.resolveUserAccess({
      userId,
      tenantId,
      requestedTeamIds,
      basePermissions,
      workspace: 'erp',
    });

    const canReadAll = access.permissions.includes('orders.undeliverables.read_all');
    const canAssign = access.permissions.includes('orders.undeliverables.assign');
    const canWriteRemarks = access.permissions.includes('orders.undeliverables.remarks.write');

    const accessibleStores = canReadAll
      ? await this.prisma.posStore.findMany({
          where: { tenantId },
          select: {
            id: true,
            shopId: true,
            shopName: true,
            name: true,
          },
          orderBy: [{ shopName: 'asc' }, { name: 'asc' }],
        })
      : await this.prisma.undeliverableStoreAssignment.findMany({
          where: {
            tenantId,
            userId,
          },
          select: {
            store: {
              select: {
                id: true,
                shopId: true,
                shopName: true,
                name: true,
              },
            },
          },
        }).then((rows) =>
          rows
            .map((row) => row.store)
            .sort((left, right) =>
              this.buildUndeliverableStoreLabel(left).localeCompare(this.buildUndeliverableStoreLabel(right)),
            ));

    const uniqueStores = Array.from(
      new Map(accessibleStores.map((store) => [store.id, store])).values(),
    );

    return {
      tenantId,
      userId,
      permissions: access.permissions,
      canReadAll,
      canAssign,
      canWriteRemarks,
      accessibleStores: uniqueStores,
      accessibleShopIds: Array.from(new Set(uniqueStores.map((store) => store.shopId))).sort((left, right) => left.localeCompare(right)),
      accessibleStoreIds: uniqueStores.map((store) => store.id),
    };
  }

  private async listUndeliverableEligibleUsers(tenantId: string): Promise<UndeliverableUserOption[]> {
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        permissions: true,
        userRoleAssignments: {
          where: { tenantId },
          select: {
            role: {
              select: {
                rolePermissions: {
                  select: {
                    permission: {
                      select: {
                        key: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        userPermissionAssignments: {
          where: { tenantId },
          select: {
            allow: true,
            permission: {
              select: {
                key: true,
              },
            },
          },
        },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { email: 'asc' }],
    });

    return users
      .filter((user) => {
        const permissions = new Set<string>((user.permissions ?? []).filter((value): value is string => typeof value === 'string'));
        user.userRoleAssignments.forEach((assignment) => {
          assignment.role.rolePermissions.forEach((rolePermission) => {
            permissions.add(rolePermission.permission.key);
          });
        });
        user.userPermissionAssignments.forEach((assignment) => {
          if (assignment.allow) {
            permissions.add(assignment.permission.key);
          } else {
            permissions.delete(assignment.permission.key);
          }
        });

        return (
          permissions.has('orders.undeliverables.read')
          || permissions.has('orders.undeliverables.read_all')
          || permissions.has('orders.undeliverables.assign')
        );
      })
      .map((user) => ({
        user_id: user.id,
        full_name: this.buildUndeliverableUserLabel(user),
        email: user.email,
      }));
  }

  private async resolveUndeliverableOrderScope(
    orderId: string,
    access: UndeliverablesAccessScope,
  ) {
    const order = await this.prisma.posOrder.findFirst({
      where: {
        id: orderId,
        tenantId: access.tenantId,
      },
      select: {
        id: true,
        shopId: true,
        posOrderId: true,
        status: true,
        statusName: true,
        tracking: true,
        dateLocal: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const matchingStore = access.accessibleStores.find((store) => store.shopId === order.shopId);
    if (!matchingStore) {
      throw new ForbiddenException('Order store is outside your undeliverables scope');
    }

    return {
      order,
      store: matchingStore,
    };
  }

  private async resolveUndeliverableAttemptScope(
    attemptId: string,
    access: UndeliverablesAccessScope,
  ) {
    const attempt = await this.prisma.undeliverableAttempt.findFirst({
      where: {
        id: attemptId,
        tenantId: access.tenantId,
      },
      select: {
        id: true,
        orderId: true,
        storeId: true,
        attemptNumber: true,
        failedAt: true,
        remark: true,
        remarkOptionId: true,
        remarkedById: true,
        remarkedAt: true,
        createdAt: true,
        updatedAt: true,
        proofs: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            uploadedById: true,
            createdAt: true,
            mediaAsset: {
              select: {
                id: true,
                objectKey: true,
                contentType: true,
                byteSize: true,
                width: true,
                height: true,
                originalFileName: true,
              },
            },
          },
        },
        order: {
          select: {
            id: true,
            shopId: true,
            posOrderId: true,
            status: true,
            statusName: true,
            tracking: true,
            dateLocal: true,
            customerName: true,
            itemData: true,
            trackingUpdates: true,
          },
        },
      },
    });

    if (!attempt) {
      throw new NotFoundException('Undeliverable attempt not found');
    }

    const matchingStore =
      (attempt.storeId
        ? access.accessibleStores.find((store) => store.id === attempt.storeId)
        : undefined)
      ?? access.accessibleStores.find((store) => store.shopId === attempt.order.shopId);

    if (!matchingStore) {
      throw new ForbiddenException('Order store is outside your undeliverables scope');
    }

    return {
      attempt,
      order: attempt.order,
      store: matchingStore,
    };
  }

  private stripPhoneDigits(value: string): string {
    return value.replace(/\D/g, '');
  }

  private normalizePhoneToCanonical(value: string | null | undefined): string | null {
    if (!value) return null;
    const digits = this.stripPhoneDigits(value);
    if (!digits) return null;

    if (/^63\d{10}$/.test(digits)) return digits;
    if (/^0\d{10}$/.test(digits)) return `63${digits.slice(1)}`;
    if (/^9\d{9}$/.test(digits)) return `63${digits}`;

    return null;
  }

  private buildPhoneMatchVariants(canonicalPhone: string): string[] {
    const local10 = canonicalPhone.slice(2);
    return Array.from(new Set([canonicalPhone, `+${canonicalPhone}`, `0${local10}`, local10]));
  }

  private toNumber(value: Prisma.Decimal | number | string | null | undefined): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = Number.parseFloat(value.toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private toObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private extractSnapshotAmount(
    orderSnapshot: Prisma.JsonValue | null | undefined,
    key: string,
  ): number | undefined {
    const snapshot = this.toObject(orderSnapshot);
    if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, key)) {
      return undefined;
    }

    const raw = snapshot[key];
    if (typeof raw === 'number') {
      return Number.isFinite(raw) ? raw : undefined;
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return 0;
      const parsed = Number.parseFloat(trimmed);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private extractSnapshotField(
    orderSnapshot: Prisma.JsonValue | null | undefined,
    key: string,
  ): { exists: boolean; value: unknown } {
    const snapshot = this.toObject(orderSnapshot);
    if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, key)) {
      return { exists: false, value: undefined };
    }

    return {
      exists: true,
      value: snapshot[key],
    };
  }

  private extractOrderWarehouseId(orderSnapshot: Prisma.JsonValue | null): string | null {
    const snapshot = this.toObject(orderSnapshot);
    const warehouseIdRaw = snapshot?.warehouse_id ?? snapshot?.warehouseId ?? null;
    if (warehouseIdRaw === null || warehouseIdRaw === undefined) return null;
    const warehouseId = warehouseIdRaw.toString().trim();
    return warehouseId || null;
  }

  private extractTagNames(tagsRaw: Prisma.JsonValue | null): string[] {
    return this.extractTagDetails(tagsRaw).map((entry) => entry.name);
  }

  private extractTagDetails(tagsRaw: Prisma.JsonValue | null): ConfirmationOrderTag[] {
    if (!Array.isArray(tagsRaw)) return [];

    const seen = new Set<string>();
    const details: ConfirmationOrderTag[] = [];

    for (const entry of tagsRaw) {
      if (typeof entry === 'string') {
        const name = entry.trim();
        if (!name) continue;
        const key = `|${name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        details.push({ id: null, name });
        continue;
      }

      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const source = entry as Record<string, unknown>;
      const nameRaw = source.name;
      const idRaw = source.id ?? source.tag_id;
      const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
      if (!name) continue;

      const id =
        typeof idRaw === 'string'
          ? idRaw.trim() || null
          : typeof idRaw === 'number' && Number.isFinite(idRaw)
            ? String(idRaw)
            : null;

      const key = `${id || ''}|${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      details.push({ id, name });
    }

    return details;
  }

  private normalizeUpdateTags(tags: Array<{ id: string; name: string }>): Array<{ id: string; name: string }> {
    const seen = new Set<string>();
    const normalized: Array<{ id: string; name: string }> = [];

    for (const entry of tags) {
      const id = entry?.id?.toString?.().trim?.() || '';
      const name = entry?.name?.toString?.().trim?.() || '';
      if (!id || !name) continue;

      const key = `${id}|${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({ id, name });
    }

    return normalized;
  }

  private normalizeUpdateItems(items: Array<{ variation_id: string; quantity: number }>): ConfirmationUpdateItemPayload[] {
    const normalized = new Map<string, ConfirmationUpdateItemPayload>();

    for (const entry of items) {
      const variationId = entry?.variation_id?.toString?.().trim?.() || '';
      if (!variationId) continue;

      const quantityRaw = Number.parseInt(`${entry?.quantity ?? 1}`, 10);
      const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;

      normalized.set(variationId, {
        variation_id: variationId,
        quantity,
      });
    }

    return Array.from(normalized.values());
  }

  private parseOptionalAmountUpdateField(
    payload: Record<string, unknown>,
    key: string,
  ): number | undefined {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) return undefined;
    const raw = payload[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return 0;
      const parsed = Number.parseFloat(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (raw === null) return 0;
    throw new BadRequestException(`${key} must be a valid number`);
  }

  private buildPosStoreAccessWhere(
    tenantId: string,
    allowedTeams: string[],
    isAdmin: boolean,
    tenantHasTeams: boolean,
  ): Prisma.PosStoreWhereInput | null {
    if (!tenantHasTeams) {
      return { tenantId };
    }

    const shouldRestrict = !isAdmin || (isAdmin && allowedTeams.length > 0);
    if (!shouldRestrict) {
      return { tenantId };
    }

    if (allowedTeams.length === 0) {
      return null;
    }

    return {
      tenantId,
      OR: [
        { teamId: { in: allowedTeams } },
        { integration: { teamId: { in: allowedTeams } } },
        { integration: { sharedTeams: { some: { teamId: { in: allowedTeams } } } } },
      ],
    };
  }

  private async resolveStoreApiKey(
    tenantId: string,
    store: { id: string; integrationId: string | null; apiKey: string | null },
  ): Promise<string | null> {
    const storeApiKey = store.apiKey?.trim() || '';
    if (storeApiKey) return storeApiKey;

    if (!store.integrationId) return null;

    try {
      const credentials = await this.integrationService.getDecryptedCredentials(
        store.integrationId,
        tenantId,
      );
      const apiKey = credentials?.apiKey?.toString?.().trim?.() || '';
      if (!apiKey) return null;

      await this.prisma.posStore.update({
        where: { id: store.id },
        data: { apiKey },
      });

      return apiKey;
    } catch {
      return null;
    }
  }

  private async clearConfirmationUpdateInFlight(orderRowId: string): Promise<void> {
    await this.prisma.posOrder.update({
      where: { id: orderRowId },
      data: {
        confirmationUpdateRequestedAt: null,
        confirmationUpdateTargetStatus: null,
      },
    });
  }

  async clearConfirmationUpdateInFlightByJob(
    orderRowId: string,
    tenantId: string,
  ): Promise<void> {
    await this.prisma.posOrder.updateMany({
      where: {
        id: orderRowId,
        tenantId,
      },
      data: {
        confirmationUpdateRequestedAt: null,
        confirmationUpdateTargetStatus: null,
      },
    });
  }

  private getConfirmationUpdateQueueJobOptions() {
    const attempts = Math.max(
      1,
      Number(process.env.CONFIRMATION_UPDATE_QUEUE_ATTEMPTS || 4),
    );
    const backoffDelay = Math.max(
      1000,
      Number(process.env.CONFIRMATION_UPDATE_QUEUE_BACKOFF_MS || 3000),
    );
    const timeout = Math.max(
      10000,
      Number(process.env.CONFIRMATION_UPDATE_QUEUE_TIMEOUT_MS || 45000),
    );

    return {
      attempts,
      backoff: { type: 'exponential' as const, delay: backoffDelay },
      timeout,
      removeOnComplete: true,
      removeOnFail: 1000,
    };
  }

  private async enqueueConfirmationStatusUpdate(
    data: ConfirmationUpdateStatusJobData,
  ): Promise<void> {
    await this.confirmationUpdateQueue.add(CONFIRMATION_UPDATE_STATUS_JOB, data, {
      jobId: `confirmation-update:${data.tenantId}:${data.shopId}:${data.posOrderId}`,
      ...this.getConfirmationUpdateQueueJobOptions(),
    });
  }

  async enqueueSystemPosOrderStatusUpdate(params: SystemPosOrderStatusUpdateParams): Promise<{
    queued: boolean;
    skipped: boolean;
    reason: string;
    processing?: boolean;
    currentStatus?: number | null;
    targetStatus: number;
  }> {
    const targetStatus = Number.isInteger(params.targetStatus) ? params.targetStatus : null;
    const allowedCurrentStatuses = Array.from(new Set(
      params.allowedCurrentStatuses.filter((status) => Number.isInteger(status)),
    ));

    if (targetStatus === null) {
      throw new BadRequestException('Target POS status must be an integer');
    }

    if (allowedCurrentStatuses.length === 0) {
      throw new BadRequestException('At least one allowed current POS status is required');
    }

    const order = await this.withDbRetry(
      () =>
        this.prisma.posOrder.findFirst({
          where: {
            id: params.orderRowId,
            tenantId: params.tenantId,
          },
          select: {
            id: true,
            shopId: true,
            posOrderId: true,
            status: true,
            confirmationUpdateRequestedAt: true,
            confirmationUpdateTargetStatus: true,
          },
        }),
      'read-system-pos-order-status-update',
    );

    if (!order) {
      return {
        queued: false,
        skipped: true,
        reason: 'ORDER_NOT_FOUND',
        targetStatus,
      };
    }

    if (order.shopId !== params.shopId || order.posOrderId !== params.posOrderId) {
      return {
        queued: false,
        skipped: true,
        reason: 'ORDER_MISMATCH',
        currentStatus: order.status,
        targetStatus,
      };
    }

    if (order.status === targetStatus) {
      await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
      return {
        queued: false,
        skipped: true,
        reason: 'STATUS_ALREADY_TARGET',
        currentStatus: order.status,
        targetStatus,
      };
    }

    if (!allowedCurrentStatuses.includes(order.status ?? Number.NaN)) {
      return {
        queued: false,
        skipped: true,
        reason: `STATUS_${order.status ?? 'NULL'}_NOT_ALLOWED`,
        currentStatus: order.status,
        targetStatus,
      };
    }

    const processingCutoff = this.getConfirmationUpdateProcessingCutoff();
    const processingRequestedAt = new Date();
    const lockResult = await this.withDbRetry(
      () =>
        this.prisma.posOrder.updateMany({
          where: {
            id: order.id,
            tenantId: params.tenantId,
            status: {
              in: allowedCurrentStatuses,
            },
            OR: [
              { confirmationUpdateRequestedAt: null },
              { confirmationUpdateRequestedAt: { lt: processingCutoff } },
            ],
          },
          data: {
            confirmationUpdateRequestedAt: processingRequestedAt,
            confirmationUpdateTargetStatus: targetStatus,
          },
        }),
      'lock-system-pos-order-status-update',
    );

    if (lockResult.count === 0) {
      const latest = await this.withDbRetry(
        () =>
          this.prisma.posOrder.findUnique({
            where: { id: order.id },
            select: {
              status: true,
              confirmationUpdateRequestedAt: true,
              confirmationUpdateTargetStatus: true,
            },
          }),
        'read-system-pos-order-status-update-after-lock',
      );

      if (!latest) {
        return {
          queued: false,
          skipped: true,
          reason: 'ORDER_NOT_FOUND',
          targetStatus,
        };
      }

      if (latest.status === targetStatus) {
        await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
        return {
          queued: false,
          skipped: true,
          reason: 'STATUS_ALREADY_TARGET',
          currentStatus: latest.status,
          targetStatus,
        };
      }

      if (!allowedCurrentStatuses.includes(latest.status ?? Number.NaN)) {
        return {
          queued: false,
          skipped: true,
          reason: `STATUS_${latest.status ?? 'NULL'}_NOT_ALLOWED`,
          currentStatus: latest.status,
          targetStatus,
        };
      }

      const inFlight =
        latest.confirmationUpdateRequestedAt &&
        latest.confirmationUpdateRequestedAt >= processingCutoff;
      if (inFlight) {
        const inflightTarget =
          typeof latest.confirmationUpdateTargetStatus === 'number'
            ? latest.confirmationUpdateTargetStatus
            : null;

        return {
          queued: inflightTarget === targetStatus,
          skipped: inflightTarget !== targetStatus,
          processing: true,
          reason: inflightTarget === targetStatus
            ? 'STATUS_UPDATE_ALREADY_IN_PROGRESS'
            : `STATUS_UPDATE_IN_PROGRESS_${inflightTarget ?? 'UNKNOWN'}`,
          currentStatus: latest.status,
          targetStatus,
        };
      }

      return {
        queued: false,
        skipped: true,
        reason: 'LOCK_NOT_ACQUIRED',
        currentStatus: latest.status,
        targetStatus,
      };
    }

    try {
      await this.enqueueConfirmationStatusUpdate({
        tenantId: params.tenantId,
        orderRowId: order.id,
        shopId: order.shopId,
        posOrderId: order.posOrderId,
        targetStatus,
        requestId: params.requestId ?? undefined,
        source: params.source,
        allowedCurrentStatuses,
      });
    } catch (error: any) {
      const message = (error?.message || '').toString().toLowerCase();
      if (message.includes('job') && message.includes('exist')) {
        return {
          queued: true,
          skipped: false,
          processing: true,
          reason: 'STATUS_UPDATE_ALREADY_QUEUED',
          currentStatus: order.status,
          targetStatus,
        };
      }

      await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
      throw error;
    }

    return {
      queued: true,
      skipped: false,
      processing: true,
      reason: 'QUEUED',
      currentStatus: order.status,
      targetStatus,
    };
  }

  private getConfirmationStatusLabel(status: number | null | undefined): string {
    if (typeof status !== 'number') return 'Unknown';
    return this.confirmationStatusLabels[status] || `Status ${status}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isTransientDbError(error: any): boolean {
    const message = (error?.message || '').toString().toLowerCase();
    const code = (error?.code || '').toString().toUpperCase();
    const metaCode = (error?.meta?.code || '').toString().toUpperCase();

    return (
      code === 'P2034' ||
      metaCode === '40P01' ||
      message.includes('deadlock detected') ||
      message.includes('40p01') ||
      message.includes('could not serialize access due to')
    );
  }

  private async withDbRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxAttempts = 3,
  ): Promise<T> {
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await operation();
      } catch (error: any) {
        if (!this.isTransientDbError(error) || attempt >= maxAttempts) {
          throw error;
        }
        const delayMs = Math.min(800, 120 * attempt);
        this.logger.warn(
          `Transient DB contention during ${operationName}. Retrying (${attempt}/${maxAttempts}) in ${delayMs}ms`,
        );
        await this.sleep(delayMs);
      }
    }
    throw new Error(`Failed ${operationName}`);
  }

  async listGeoProvinces(countryCodeRaw: string) {
    return this.integrationService.listPosGeoProvinces(countryCodeRaw);
  }

  async listGeoDistricts(provinceIdRaw: string) {
    return this.integrationService.listPosGeoDistricts(provinceIdRaw);
  }

  async listGeoCommunes(provinceIdRaw: string, districtIdRaw?: string) {
    return this.integrationService.listPosGeoCommunes(provinceIdRaw, districtIdRaw);
  }

  private async listShopAccessRows(where: Prisma.PosStoreWhereInput) {
    return (await this.prisma.posStore.findMany({
      where,
      select: {
        id: true,
        shopId: true,
        shopName: true,
        name: true,
      },
      orderBy: [{ shopName: 'asc' }, { name: 'asc' }],
    })) as PosStoreAccessRow[];
  }

  private buildShopDisplayMap(
    stores: Array<{ shopId: string; shopName: string | null; name: string | null }>,
  ) {
    const shopDisplayMap = new Map<string, string>();

    stores.forEach((store) => {
      if (!store.shopId || shopDisplayMap.has(store.shopId)) {
        return;
      }

      shopDisplayMap.set(
        store.shopId,
        store.shopName?.trim() || store.name?.trim() || store.shopId,
      );
    });

    return shopDisplayMap;
  }

  private buildAgingOrderNotificationEntityIds(shopIds: string[]) {
    return shopIds.map((shopId) =>
      this.getAgingOrderNotificationEntityId(shopId),
    );
  }

  private async resolveAccessibleAgingOrderScope() {
    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams = (Array.isArray(teamIds) && teamIds.length > 0 ? teamIds : userTeams) || [];
    const storeWhere = this.buildPosStoreAccessWhere(tenantId, allowedTeams, isAdmin, tenantHasTeams);

    if (!storeWhere) {
      return {
        tenantId,
        accessibleShopIds: [] as string[],
        shopDisplayMap: new Map<string, string>(),
      };
    }

    const stores = await this.listShopAccessRows(storeWhere);
    const shopDisplayMap = this.buildShopDisplayMap(stores);

    return {
      tenantId,
      accessibleShopIds: Array.from(shopDisplayMap.keys()),
      shopDisplayMap,
    };
  }

  private async getTenantAgingOrderShopDisplayMap(tenantId: string) {
    const stores = await this.listShopAccessRows({ tenantId });
    return this.buildShopDisplayMap(stores);
  }

  private normalizeAgingOrderScopeShopIds(shopIds: string[]) {
    return Array.from(new Set(
      shopIds
        .map((shopId) => shopId?.trim())
        .filter((shopId): shopId is string => !!shopId),
    )).sort((left, right) => left.localeCompare(right));
  }

  private async loadAgingOrdersBucketDetails(params: {
    tenantId: string;
    shopIds: string[];
    thresholdDays: number;
  }): Promise<AgingOrdersBucketDetail[]> {
    const normalizedShopIds = this.normalizeAgingOrderScopeShopIds(params.shopIds);

    if (normalizedShopIds.length === 0) {
      return [] as AgingOrdersBucketDetail[];
    }

    const staleCutoffDate = dayjs()
      .tz(TIMEZONE)
      .subtract(params.thresholdDays, 'day')
      .format('YYYY-MM-DD');

    const rows = await this.prisma.$queryRaw<AgingOrdersBucketQueryRow[]>(Prisma.sql`
      WITH relevant AS (
        SELECT
          o."id",
          o."shopId",
          CASE
            WHEN o."status" = 0 THEN 'new_orders'
            WHEN o."status" = 11 THEN 'restocking'
            WHEN o."status" = 1 THEN 'confirmed'
            WHEN o."status" = 13 THEN 'printed'
            WHEN o."status" = 9 THEN 'waiting_pickup'
            WHEN o."status" = 2 THEN 'shipped'
            WHEN o."status" = 4 THEN 'rts'
            ELSE NULL
          END AS "bucketKey",
          CASE
            WHEN o."status" = 0 THEN o."dateLocal"::date
            ELSE (
              SELECT MAX(
                CASE
                  WHEN jsonb_typeof(entry) = 'object'
                    AND COALESCE(entry->>'status', '') ~ '^-?\\d+$'
                    AND (entry->>'status')::int = o."status"
                    AND COALESCE(entry->>'updated_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                  THEN ((entry->>'updated_at')::timestamptz AT TIME ZONE ${TIMEZONE})::date
                  ELSE NULL
                END
              )
              FROM jsonb_array_elements(COALESCE(o."statusHistory"::jsonb, '[]'::jsonb)) entry
            )
          END AS status_reference_date
        FROM "pos_orders" o
        WHERE o."tenantId" = CAST(${params.tenantId} AS uuid)
          AND o."shopId" IN (${Prisma.join(normalizedShopIds)})
          AND o."status" IS NOT NULL
          AND COALESCE(o."isVoid", false) = false
      )
      SELECT
        "shopId",
        "bucketKey",
        COUNT(*)::int AS "agedCount",
        ARRAY_AGG("id"::text ORDER BY "id"::text) AS "orderIds"
      FROM relevant
      WHERE "bucketKey" IS NOT NULL
        AND status_reference_date IS NOT NULL
        AND status_reference_date <= ${staleCutoffDate}::date
      GROUP BY "shopId", "bucketKey"
      ORDER BY "shopId" ASC, "bucketKey" ASC
    `);

    return rows.map((row) => ({
      shopId: row.shopId,
      bucketKey: row.bucketKey,
      agedCount: Number(row.agedCount || 0),
      orderIds: Array.isArray(row.orderIds)
        ? row.orderIds.filter((value): value is string => typeof value === 'string')
        : [],
    }));
  }

  private async loadCachedAgingOrdersBucketDetails(params: {
    tenantId: string;
    shopIds: string[];
    thresholdDays: number;
  }) {
    const normalizedShopIds = this.normalizeAgingOrderScopeShopIds(params.shopIds);
    const cached = await this.ordersAgingNotificationCache.getCachedBucketDetails(
      params.tenantId,
      normalizedShopIds,
      params.thresholdDays,
    );

    if (cached) {
      return cached.map((row) => ({
        shopId: row.shopId,
        bucketKey: row.bucketKey as AgingOrdersNotificationBucketKey,
        agedCount: Number(row.agedCount || 0),
        orderIds: Array.isArray(row.orderIds) ? row.orderIds : [],
      }));
    }

    const bucketDetails = await this.loadAgingOrdersBucketDetails({
      ...params,
      shopIds: normalizedShopIds,
    });

    await this.ordersAgingNotificationCache.setCachedBucketDetails(
      params.tenantId,
      normalizedShopIds,
      params.thresholdDays,
      bucketDetails.map((row) => ({
        shopId: row.shopId,
        bucketKey: row.bucketKey,
        agedCount: row.agedCount,
        orderIds: row.orderIds,
      })),
    );

    return bucketDetails;
  }

  private buildAgingOrdersSummaryRows(
    bucketDetails: AgingOrdersBucketDetail[],
    shopDisplayMap: Map<string, string>,
  ) {
    const rowsByShopId = new Map<string, AgingOrdersSummaryRow>();

    for (const bucket of bucketDetails) {
      const current =
        rowsByShopId.get(bucket.shopId)
        || {
          shopId: bucket.shopId,
          total_orders: 0,
          new_orders: 0,
          restocking: 0,
          confirmed: 0,
          printed: 0,
          waiting_pickup: 0,
          shipped: 0,
          rts: 0,
        };

      current[bucket.bucketKey] = bucket.agedCount;
      current.total_orders += bucket.agedCount;
      rowsByShopId.set(bucket.shopId, current);
    }

    return Array.from(rowsByShopId.values())
      .sort((left, right) => left.shopId.localeCompare(right.shopId))
      .map((row) => ({
        shop_id: row.shopId,
        shop_name: shopDisplayMap.get(row.shopId) || row.shopId,
        total_orders: Number(row.total_orders || 0),
        new_orders: Number(row.new_orders || 0),
        restocking: Number(row.restocking || 0),
        confirmed: Number(row.confirmed || 0),
        printed: Number(row.printed || 0),
        waiting_pickup: Number(row.waiting_pickup || 0),
        shipped: Number(row.shipped || 0),
        rts: Number(row.rts || 0),
      }));
  }

  private buildAgingOrdersNotificationCells(
    notificationStates: Array<{ entityId: string; context: Prisma.JsonValue | null }>,
  ) {
    const cells: Record<string, boolean> = {};

    for (const state of notificationStates) {
      const context = this.toObject(state.context) as AgingOrdersNotificationContext | null;
      const parsed = this.parseAgingOrderNotificationEntityId(state.entityId);
      const shopId = context?.shopId?.trim() || parsed?.shopId || '';

      if (!shopId) {
        continue;
      }

      cells[shopId] = true;
    }

    return cells;
  }

  private buildAgingOrdersNotificationShopState(bucketDetails: AgingOrdersBucketDetail[]) {
    const rowsByShopId = new Map<
      string,
      {
        orderIds: Set<string>;
        affectedOrderCount: number;
      }
    >();

    for (const bucket of bucketDetails) {
      const current = rowsByShopId.get(bucket.shopId) || {
        orderIds: new Set<string>(),
        affectedOrderCount: 0,
      };

      current.affectedOrderCount += bucket.agedCount;
      for (const orderId of bucket.orderIds) {
        current.orderIds.add(orderId);
      }

      rowsByShopId.set(bucket.shopId, current);
    }

    return new Map(
      Array.from(rowsByShopId.entries()).map(([shopId, value]) => {
        const orderIds = Array.from(value.orderIds).sort((left, right) => left.localeCompare(right));
        return [
          shopId,
          {
            shopId,
            affectedOrderCount: value.affectedOrderCount,
            orderIds,
            shopSignature: this.getAgingOrderNotificationSignature(orderIds),
          },
        ];
      }),
    );
  }

  private emitAgingOrdersNotificationUpdate(params: {
    tenantId: string;
    source: 'lazy' | 'read';
    changedEntityIds?: string[];
    changedRowCount?: number;
  }) {
    this.workflowExecutionGateway.emitTenantEvent(
      params.tenantId,
      null,
      ORDERS_AGING_NOTIFICATION_UPDATED_EVENT,
      {
        tenantId: params.tenantId,
        source: params.source,
        changedEntityIds: params.changedEntityIds ?? [],
        changedRowCount: params.changedRowCount ?? 0,
        updatedAt: new Date().toISOString(),
      },
    );
  }

  private emitUndeliverablesUpdated(params: {
    tenantId: string;
    source:
      | 'assignments_updated'
      | 'remark_created'
      | 'remark_updated'
      | 'remark_deleted'
      | 'remark_option_created'
      | 'remark_option_updated'
      | 'remark_option_deleted';
    changedOrderId?: string | null;
    changedStoreIds?: string[];
    changedRemarkOptionId?: string | null;
  }) {
    this.workflowExecutionGateway.emitTenantEvent(
      params.tenantId,
      null,
      ORDERS_UNDELIVERABLES_UPDATED_EVENT,
      {
        tenantId: params.tenantId,
        source: params.source,
        changedOrderId: params.changedOrderId ?? null,
        changedStoreIds: params.changedStoreIds ?? [],
        changedRemarkOptionId: params.changedRemarkOptionId ?? null,
        updatedAt: new Date().toISOString(),
      },
    );
  }

  private async ensureAgingOrdersNotificationsFresh(params: {
    tenantId: string;
    shopIds: string[];
    shopDisplayMap: Map<string, string>;
  }) {
    // Preview reads must not create, clear or change the target user's
    // notification state. Existing summaries and unread rows remain readable.
    if (this.cls.get('impersonatedBy')) {
      return;
    }

    const normalizedShopIds = this.normalizeAgingOrderScopeShopIds(params.shopIds);
    if (normalizedShopIds.length === 0) {
      return;
    }

    if (await this.ordersAgingNotificationCache.hasRecentLazySync(
      params.tenantId,
      normalizedShopIds,
    )) {
      return;
    }

    if (await this.ordersAgingNotificationCache.hasLazySyncLock(
      params.tenantId,
      normalizedShopIds,
    )) {
      return;
    }

    await this.ordersAgingNotificationCache.setLazySyncLock(
      params.tenantId,
      normalizedShopIds,
    );

    try {
      const bucketDetails = await this.loadAgingOrdersBucketDetails({
        tenantId: params.tenantId,
        shopIds: normalizedShopIds,
        thresholdDays: AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS,
      });

      await this.ordersAgingNotificationCache.setCachedBucketDetails(
        params.tenantId,
        normalizedShopIds,
        AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS,
        bucketDetails.map((row) => ({
          shopId: row.shopId,
          bucketKey: row.bucketKey,
          agedCount: row.agedCount,
          orderIds: row.orderIds,
        })),
      );

      await this.syncAgingOrderNotificationsForTenant(
        params.tenantId,
        'lazy',
        {
          shopIds: normalizedShopIds,
          shopDisplayMap: params.shopDisplayMap,
          bucketDetails,
        },
      );

      await this.ordersAgingNotificationCache.markLazySyncFresh(
        params.tenantId,
        normalizedShopIds,
      );
    } catch (error: any) {
      this.logger.warn(
        `Lazy aging notification sync failed for tenant=${params.tenantId}: ${error?.message || 'Unknown error'}`,
      );
    } finally {
      await this.ordersAgingNotificationCache.clearLazySyncLock(
        params.tenantId,
        normalizedShopIds,
      );
    }
  }

  async getAgingOrdersSummary(params: GetAgingOrdersSummaryParams) {
    const thresholdDays = this.parseThresholdDays(params.thresholdDays);
    const generatedAt = new Date().toISOString();

    const { tenantId, accessibleShopIds, shopDisplayMap } =
      await this.resolveAccessibleAgingOrderScope();

    if (accessibleShopIds.length === 0) {
      return {
        items: [],
        filters: {
          shops: [],
        },
        selected: {
          threshold_days: thresholdDays,
        },
        generated_at: generatedAt,
        notification_cells: {},
      };
    }

    if (thresholdDays === AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS) {
      await this.ensureAgingOrdersNotificationsFresh({
        tenantId,
        shopIds: accessibleShopIds,
        shopDisplayMap,
      });
    }

    const bucketDetails = await this.loadCachedAgingOrdersBucketDetails({
      tenantId,
      shopIds: accessibleShopIds,
      thresholdDays,
    });
    const items = this.buildAgingOrdersSummaryRows(bucketDetails, shopDisplayMap);

    const unreadStates = thresholdDays === AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS
      ? await this.prisma.notificationState.findMany({
          where: {
            tenantId,
            system: NotificationSystem.ERP,
            domain: NotificationDomain.ORDERS_AGING,
            entityType: AGING_ORDERS_NOTIFICATION_ENTITY_TYPE,
            isUnread: true,
            entityId: {
              in: this.buildAgingOrderNotificationEntityIds(accessibleShopIds),
            },
          },
          select: {
            entityId: true,
            context: true,
          },
        })
      : [];

    const shops = accessibleShopIds.map((shopId) => ({
      shop_id: shopId,
      shop_name: shopDisplayMap.get(shopId) || shopId,
    }));

    return {
      items,
      filters: {
        shops,
      },
      selected: {
        threshold_days: thresholdDays,
      },
      generated_at: generatedAt,
      notification_cells: this.buildAgingOrdersNotificationCells(unreadStates),
    };
  }

  async getOrderStatusSummary(params: GetOrderStatusSummaryParams) {
    const generatedAt = new Date().toISOString();
    const selectedDate = this.normalizeDateLocal(params.dateLocal, this.getTodayDateLocal());

    const {
      tenantId,
      accessibleShopIds,
      shopDisplayMap,
    } = await this.resolveAccessibleAgingOrderScope();

    const accessibleShopSet = new Set(accessibleShopIds);
    const requestedShopIds = this.parseShopIds(params.shopIds);
    const selectedShopIds = requestedShopIds.filter((shopId) => accessibleShopSet.has(shopId));
    const effectiveShopIds = selectedShopIds.length > 0 ? selectedShopIds : accessibleShopIds;

    const shops = accessibleShopIds.map((shopId) => ({
      shop_id: shopId,
      shop_name: shopDisplayMap.get(shopId) || shopId,
    }));

    if (effectiveShopIds.length === 0) {
      return {
        items: [] as OrderStatusSummaryRow[],
        filters: { shops },
        selected: {
          date_local: selectedDate,
          shop_ids: selectedShopIds,
        },
        generated_at: generatedAt,
      };
    }

    const rows = await this.prisma.$queryRaw<OrderStatusSummaryQueryRow[]>(Prisma.sql`
      SELECT
        o."shopId" AS "shopId",
        COUNT(*) FILTER (WHERE o."status" = 0)::int AS "newOrders",
        COUNT(*) FILTER (WHERE o."status" = 11)::int AS "restockingOrders",
        COUNT(*) FILTER (WHERE o."status" = 1)::int AS "confirmedOrders",
        COUNT(*) FILTER (WHERE o."status" = 13)::int AS "printedOrders",
        COUNT(*) FILTER (WHERE o."status" = 9)::int AS "waitingPickupOrders",
        COUNT(*) FILTER (WHERE o."status" = 2)::int AS "shippedOrders",
        COUNT(*) FILTER (WHERE o."status" = 3)::int AS "deliveredOrders",
        COUNT(*) FILTER (WHERE o."status" = 4)::int AS "returningOrders",
        COUNT(*) FILTER (WHERE o."status" = 5)::int AS "returnedOrders",
        COUNT(*) FILTER (WHERE o."status" = 6)::int AS "cancelledOrders",
        COUNT(*) FILTER (WHERE o."status" = 7)::int AS "deletedOrders",
        COUNT(*) FILTER (WHERE o."status" IN (0, 11, 1, 13, 9, 2, 3, 4, 5, 6, 7))::int AS "totalOrders"
      FROM "pos_orders" o
      WHERE o."tenantId" = CAST(${tenantId} AS uuid)
        AND o."dateLocal" = ${selectedDate}
        AND o."shopId" IN (${Prisma.join(effectiveShopIds)})
      GROUP BY o."shopId"
      ORDER BY "totalOrders" DESC, o."shopId" ASC
    `);

    const countsByShopId = new Map(rows.map((row) => [row.shopId, row]));

    const items = effectiveShopIds
      .map((shopId) => {
        const row = countsByShopId.get(shopId);
        return {
          shop_id: shopId,
          shop_name: shopDisplayMap.get(shopId) || shopId,
          total_orders: Number(row?.totalOrders || 0),
          new_orders: Number(row?.newOrders || 0),
          restocking: Number(row?.restockingOrders || 0),
          confirmed: Number(row?.confirmedOrders || 0),
          printed: Number(row?.printedOrders || 0),
          waiting_pickup: Number(row?.waitingPickupOrders || 0),
          shipped: Number(row?.shippedOrders || 0),
          delivered: Number(row?.deliveredOrders || 0),
          returning: Number(row?.returningOrders || 0),
          returned: Number(row?.returnedOrders || 0),
          cancelled: Number(row?.cancelledOrders || 0),
          deleted: Number(row?.deletedOrders || 0),
        };
      })
      .sort((left, right) => {
        if (right.total_orders !== left.total_orders) {
          return right.total_orders - left.total_orders;
        }
        return left.shop_name.localeCompare(right.shop_name);
      });

    return {
      items,
      filters: { shops },
      selected: {
        date_local: selectedDate,
        shop_ids: selectedShopIds,
      },
      generated_at: generatedAt,
    };
  }

  async listUndeliverables(params: {
    start_date?: string;
    end_date?: string;
    store_id?: string | string[];
    status?: string | string[];
    remarked_by_id?: string | string[];
    search?: string;
    view?: string;
    failed_at_order?: string;
    page?: string;
    limit?: string;
  }) {
    const today = this.getTodayDateLocal();
    let startDate = this.normalizeDateLocal(params.start_date, today);
    let endDate = this.normalizeDateLocal(params.end_date, today);
    if (startDate > endDate) {
      [startDate, endDate] = [endDate, startDate];
    }

    const page = this.parsePage(params.page);
    const limit = this.parseLimit(params.limit);
    const skip = (page - 1) * limit;
    const search = params.search?.trim() || '';
    const statuses = this.parseUndeliverableStatuses(params.status);
    const view = this.parseUndeliverableView(params.view);
    const selectedRemarkedByIds = view === 'with_remarks'
      ? this.parseUuidArray(params.remarked_by_id)
      : [];
    const failedAtOrder: Prisma.SortOrder = params.failed_at_order === 'desc' ? 'desc' : 'asc';
    const undeliverableStartAt = dayjs.tz(`${startDate}T00:00:00`, TIMEZONE).toDate();
    const undeliverableEndAt = dayjs.tz(`${endDate}T23:59:59.999`, TIMEZONE).toDate();
    const requestNow = new Date();
    const unattendedCutoff = new Date(requestNow.getTime() - UNDELIVERABLE_REMARK_SLA_MS);
    const attemptVisibilityWhere: Prisma.UndeliverableAttemptWhereInput =
      view === 'with_remarks'
        ? {
            failedAt: {
              gte: undeliverableStartAt,
              lte: undeliverableEndAt,
            },
            remark: { not: null },
          }
        : view === 'unattended'
          ? {
              failedAt: { lte: unattendedCutoff },
              remark: null,
            }
          : {
              failedAt: {
                gte: undeliverableStartAt,
                lte: undeliverableEndAt,
              },
              remark: null,
            };
    const access = await this.resolveUndeliverablesAccessScope();

    if (access.accessibleStores.length === 0 || access.accessibleShopIds.length === 0) {
      return {
        items: [],
        pagination: { page, limit, total: 0, pageCount: 0 },
        filters: {
          stores: [],
          statuses: UNDELIVERABLE_STATUS_VALUES.map((status) => ({
            value: String(status),
            label: UNDELIVERABLE_STATUS_LABELS[status],
          })),
          remarkers: [],
        },
        selected: {
          start_date: startDate,
          end_date: endDate,
          store_ids: [],
          statuses: statuses.map(String),
          remarked_by_ids: selectedRemarkedByIds,
          search,
          view,
          failed_at_order: failedAtOrder,
        },
        scope: {
          mode: access.canReadAll ? 'all' : 'assigned',
        },
        server_time: requestNow.toISOString(),
      };
    }

    const requestedStoreIds = this.parseUuidArray(params.store_id);
    const accessibleStoreIdSet = new Set(access.accessibleStoreIds);
    const selectedStoreIds = requestedStoreIds.filter((storeId) => accessibleStoreIdSet.has(storeId));
    const effectiveStores =
      selectedStoreIds.length > 0
        ? access.accessibleStores.filter((store) => selectedStoreIds.includes(store.id))
        : access.accessibleStores;
    const effectiveStoreIds = effectiveStores.map((store) => store.id);

    const baseWhere: Prisma.UndeliverableAttemptWhereInput = {
      tenantId: access.tenantId,
      ...attemptVisibilityWhere,
      storeId: { in: access.accessibleStoreIds },
      order: {
        ...(statuses.length > 0 ? { status: { in: statuses } } : {}),
        ...(search
          ? {
              OR: [
                { posOrderId: { contains: search, mode: 'insensitive' } },
                { tracking: { contains: search, mode: 'insensitive' } },
                { customerName: { contains: search, mode: 'insensitive' } },
                { customerPhone: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
    };

    const visibleStoreIds = new Set(
      (await this.prisma.undeliverableAttempt.findMany({
        where: baseWhere,
        select: { storeId: true },
        distinct: ['storeId'],
      })).map((row) => row.storeId).filter((value): value is string => !!value),
    );

    const filterStores = access.accessibleStores
      .filter((store) => visibleStoreIds.has(store.id))
      .map((store) => ({
        store_id: store.id,
        shop_id: store.shopId,
        store_name: this.buildUndeliverableStoreLabel(store),
      }));

    if (effectiveStoreIds.length === 0) {
      return {
        items: [],
        pagination: { page, limit, total: 0, pageCount: 0 },
        filters: {
          stores: filterStores,
          statuses: UNDELIVERABLE_STATUS_VALUES.map((status) => ({
            value: String(status),
            label: UNDELIVERABLE_STATUS_LABELS[status],
          })),
          remarkers: [],
        },
        selected: {
          start_date: startDate,
          end_date: endDate,
          store_ids: selectedStoreIds,
          statuses: statuses.map(String),
          remarked_by_ids: selectedRemarkedByIds,
          search,
          view,
          failed_at_order: failedAtOrder,
        },
        scope: {
          mode: access.canReadAll ? 'all' : 'assigned',
        },
        server_time: requestNow.toISOString(),
      };
    }

    const filterContextWhere: Prisma.UndeliverableAttemptWhereInput = {
      tenantId: access.tenantId,
      ...attemptVisibilityWhere,
      storeId: { in: effectiveStoreIds },
      order: {
        ...(statuses.length > 0 ? { status: { in: statuses } } : {}),
        ...(search
        ? {
            OR: [
              { posOrderId: { contains: search, mode: 'insensitive' } },
              { tracking: { contains: search, mode: 'insensitive' } },
              { customerName: { contains: search, mode: 'insensitive' } },
              { customerPhone: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      },
    };

    const remarkAuthorRows = view === 'with_remarks'
      ? await this.prisma.undeliverableAttempt.findMany({
          where: filterContextWhere,
          select: { remarkedById: true },
          distinct: ['remarkedById'],
        })
      : [];
    const remarkAuthorIds = remarkAuthorRows
      .map((row) => row.remarkedById)
      .filter((value): value is string => !!value);
    const remarkAuthorUsers = remarkAuthorIds.length > 0
      ? await this.prisma.user.findMany({
          where: {
            tenantId: access.tenantId,
            id: { in: remarkAuthorIds },
          },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        })
      : [];
    const filterRemarkers = remarkAuthorUsers
      .map((user) => ({
        user_id: user.id,
        full_name: this.buildUndeliverableUserLabel(user),
        email: user.email,
      }))
      .sort((left, right) => left.full_name.localeCompare(right.full_name));

    const where: Prisma.UndeliverableAttemptWhereInput = {
      ...filterContextWhere,
      ...(selectedRemarkedByIds.length > 0
        ? { remarkedById: { in: selectedRemarkedByIds } }
        : {}),
    };

    const [total, attempts] = await this.prisma.$transaction([
      this.prisma.undeliverableAttempt.count({ where }),
      this.prisma.undeliverableAttempt.findMany({
        where,
        orderBy: [{ failedAt: failedAtOrder }, { createdAt: failedAtOrder }],
        skip,
        take: limit,
        select: {
          id: true,
          orderId: true,
          storeId: true,
          attemptNumber: true,
          failedAt: true,
          remark: true,
          remarkOptionId: true,
          remarkedById: true,
          remarkedAt: true,
          updatedAt: true,
          _count: {
            select: {
              proofs: true,
            },
          },
          order: {
            select: {
              id: true,
              shopId: true,
              posOrderId: true,
              dateLocal: true,
              status: true,
              statusName: true,
              tracking: true,
              cod: true,
              customerName: true,
              customerPhone: true,
              customerAddress: true,
              deliveryAttemptFailed: true,
            },
          },
        },
      }),
    ]);

    const pageCount = total > 0 ? Math.ceil(total / limit) : 0;
    const storeIdsInPage = Array.from(
      new Set(attempts.map((attempt) => attempt.storeId).filter((value): value is string => !!value)),
    );
    const shopIdsInPage = Array.from(new Set(attempts.map((attempt) => attempt.order.shopId)));
    const pageStores = access.accessibleStores.filter((store) =>
      storeIdsInPage.includes(store.id) || shopIdsInPage.includes(store.shopId),
    );
    const storeById = new Map<string, UndeliverableStoreRow>();
    const storeByShopId = new Map<string, UndeliverableStoreRow>();
    pageStores.forEach((store) => {
      storeById.set(store.id, store);
      if (!storeByShopId.has(store.shopId)) {
        storeByShopId.set(store.shopId, store);
      }
    });

    const remarkUserIds = Array.from(
      new Set(
        attempts.map((attempt) => attempt.remarkedById).filter((value): value is string => !!value),
      ),
    );

    const remarkUsers = remarkUserIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: remarkUserIds } },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        })
      : [];
    const remarkUserMap = new Map(
      remarkUsers.map((user) => [user.id, this.buildUndeliverableUserLabel(user)]),
    );

    const assignmentStoreIds = Array.from(new Set(pageStores.map((store) => store.id)));
    const assignments = assignmentStoreIds.length > 0
      ? await this.prisma.undeliverableStoreAssignment.findMany({
          where: {
            tenantId: access.tenantId,
            storeId: { in: assignmentStoreIds },
          },
          select: {
            storeId: true,
            userId: true,
            user: {
              select: {
                email: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        })
      : [];

    const assignedUsersByStoreId = new Map<string, Array<{ user_id: string; full_name: string; email: string }>>();
    assignments.forEach((assignment) => {
      const bucket = assignedUsersByStoreId.get(assignment.storeId) ?? [];
      bucket.push({
        user_id: assignment.userId,
        full_name: this.buildUndeliverableUserLabel(assignment.user),
        email: assignment.user.email,
      });
      assignedUsersByStoreId.set(assignment.storeId, bucket);
    });

    const items = attempts.map((attempt) => {
      const order = attempt.order;
      const store = (attempt.storeId ? storeById.get(attempt.storeId) : undefined) ?? storeByShopId.get(order.shopId);
      const parsedAddress = this.parseUndeliverableAddress(order.customerAddress);
      const lifecycle = this.buildUndeliverableLifecycle({
        failedAt: attempt.failedAt,
        remark: attempt.remark,
        remarkedAt: attempt.remarkedAt,
        updatedAt: attempt.updatedAt,
        now: requestNow,
      });

      return {
        id: attempt.id,
        order_id: order.id,
        pos_order_id: order.posOrderId,
        date_local: dayjs(attempt.failedAt).tz(TIMEZONE).format('YYYY-MM-DD'),
        failed_at: attempt.failedAt.toISOString(),
        attempt_number: attempt.attemptNumber,
        status: order.status,
        status_name:
          typeof order.status === 'number' && UNDELIVERABLE_STATUS_VALUES.includes(order.status as UndeliverableStatus)
            ? UNDELIVERABLE_STATUS_LABELS[order.status as UndeliverableStatus]
            : order.statusName,
        tracking: order.tracking,
        cod_amount: order.cod ? Number(order.cod) : null,
        attempt_failed: order.deliveryAttemptFailed ?? attempt.attemptNumber,
        customer_name: order.customerName,
        customer_phone: order.customerPhone,
        address: parsedAddress.address,
        barangay: parsedAddress.barangay,
        city: parsedAddress.city,
        province: parsedAddress.province,
        store_id: store?.id ?? null,
        store_name: store ? this.buildUndeliverableStoreLabel(store) : order.shopId,
        shop_id: order.shopId,
        sa_assigned: store ? (assignedUsersByStoreId.get(store.id) ?? []) : [],
        ...lifecycle,
        latest_remark: attempt.remark
          ? {
              id: attempt.id,
              remark: attempt.remark,
              created_at: (attempt.remarkedAt ?? attempt.updatedAt).toISOString(),
              updated_at: attempt.updatedAt.toISOString(),
              author_name:
                (attempt.remarkedById ? remarkUserMap.get(attempt.remarkedById) : null)
                || 'Unknown user',
              proof_count: attempt._count.proofs,
            }
          : null,
      };
    });

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        pageCount,
      },
      filters: {
        stores: filterStores,
        statuses: UNDELIVERABLE_STATUS_VALUES.map((status) => ({
          value: String(status),
          label: UNDELIVERABLE_STATUS_LABELS[status],
        })),
        remarkers: filterRemarkers,
      },
      selected: {
        start_date: startDate,
        end_date: endDate,
        store_ids: selectedStoreIds,
        statuses: statuses.map(String),
        remarked_by_ids: selectedRemarkedByIds,
        search,
        view,
        failed_at_order: failedAtOrder,
      },
      scope: {
        mode: access.canReadAll ? 'all' : 'assigned',
      },
      server_time: requestNow.toISOString(),
    };
  }

  async getUndeliverableAssignments() {
    const access = await this.resolveUndeliverablesAccessScope();
    if (!access.canReadAll && !access.canAssign) {
      throw new ForbiddenException('You do not have permission to manage undeliverables assignments');
    }

    const [stores, users, assignments] = await Promise.all([
      this.prisma.posStore.findMany({
        where: {
          tenantId: access.tenantId,
        },
        select: {
          id: true,
          shopId: true,
          shopName: true,
          name: true,
        },
        orderBy: [{ shopName: 'asc' }, { name: 'asc' }],
      }),
      this.listUndeliverableEligibleUsers(access.tenantId),
      this.prisma.undeliverableStoreAssignment.findMany({
        where: {
          tenantId: access.tenantId,
        },
        select: {
          userId: true,
          storeId: true,
        },
      }),
    ]);

    return {
      users,
      stores: stores.map((store) => ({
        store_id: store.id,
        shop_id: store.shopId,
        store_name: this.buildUndeliverableStoreLabel(store),
      })),
      assignments,
    };
  }

  async updateUndeliverableAssignments(userId: string, storeIds: string[]) {
    const access = await this.resolveUndeliverablesAccessScope();
    if (!access.canAssign) {
      throw new ForbiddenException('You do not have permission to manage undeliverables assignments');
    }

    const normalizedStoreIds = Array.from(new Set(
      (Array.isArray(storeIds) ? storeIds : []).filter((value) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
      ),
    ));

    const [targetUser, stores] = await Promise.all([
      this.prisma.user.findFirst({
        where: {
          id: userId,
          tenantId: access.tenantId,
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
      normalizedStoreIds.length > 0
        ? this.prisma.posStore.findMany({
            where: {
              tenantId: access.tenantId,
              id: { in: normalizedStoreIds },
            },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);

    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    if (stores.length !== normalizedStoreIds.length) {
      throw new BadRequestException('One or more selected stores are invalid for this tenant');
    }

    const eligibleUsers = await this.listUndeliverableEligibleUsers(access.tenantId);
    if (!eligibleUsers.some((user) => user.user_id === userId)) {
      throw new BadRequestException('Selected user does not have undeliverables access');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.undeliverableStoreAssignment.deleteMany({
        where: {
          tenantId: access.tenantId,
          userId,
        },
      });

      if (normalizedStoreIds.length > 0) {
        await tx.undeliverableStoreAssignment.createMany({
          data: normalizedStoreIds.map((storeId) => ({
            tenantId: access.tenantId,
            storeId,
            userId,
            createdById: access.userId,
          })),
        });
      }
    });

    this.emitUndeliverablesUpdated({
      tenantId: access.tenantId,
      source: 'assignments_updated',
      changedStoreIds: normalizedStoreIds,
    });

    return {
      success: true,
      user_id: userId,
      store_ids: normalizedStoreIds,
    };
  }

  async listUndeliverableRemarks(attemptId: string) {
    const access = await this.resolveUndeliverablesAccessScope();
    const { attempt, order, store } = await this.resolveUndeliverableAttemptScope(attemptId, access);

    const userIds = Array.from(new Set([
      ...(attempt.remarkedById ? [attempt.remarkedById] : []),
      ...attempt.proofs.map((proof) => proof.uploadedById),
    ]));
    const users = userIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
      })
      : [];
    const userMap = new Map(users.map((user) => [user.id, this.buildUndeliverableUserLabel(user)]));
    const proofs = await Promise.all(
      attempt.proofs.map(async (proof) => ({
        id: proof.id,
        asset_id: proof.mediaAsset.id,
        image_url: await this.mediaAssetsService.createSignedAssetUrl(proof.mediaAsset),
        content_type: proof.mediaAsset.contentType,
        byte_size: proof.mediaAsset.byteSize,
        width: proof.mediaAsset.width,
        height: proof.mediaAsset.height,
        original_file_name: proof.mediaAsset.originalFileName,
        uploaded_at: proof.createdAt.toISOString(),
        uploaded_by_id: proof.uploadedById,
        uploaded_by_name: userMap.get(proof.uploadedById) || 'Unknown user',
      })),
    );

    return {
      order: {
        id: order.id,
        pos_order_id: order.posOrderId,
        status: order.status,
        tracking: order.tracking,
        date_local: order.dateLocal,
        store_name: this.buildUndeliverableStoreLabel(store),
      },
      items: attempt.remark
        ? [
            {
              id: attempt.id,
              remark: attempt.remark,
              created_at: (attempt.remarkedAt ?? attempt.createdAt).toISOString(),
              updated_at: attempt.updatedAt.toISOString(),
              created_by_id: attempt.remarkedById ?? '',
              updated_by_id: attempt.remarkedById,
              created_by_name: attempt.remarkedById ? (userMap.get(attempt.remarkedById) || 'Unknown user') : 'Unknown user',
              updated_by_name: attempt.remarkedById ? (userMap.get(attempt.remarkedById) || 'Unknown user') : null,
              proofs,
            },
          ]
        : [],
    };
  }

  async getUndeliverableTrackingUpdates(attemptId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)) {
      throw new BadRequestException('Invalid undeliverable attempt ID');
    }

    const access = await this.resolveUndeliverablesAccessScope();
    const { attempt, order, store } = await this.resolveUndeliverableAttemptScope(attemptId, access);
    const rawUpdates = Array.isArray(order.trackingUpdates) ? order.trackingUpdates : [];
    const items = rawUpdates
      .map((entry) => this.parseUndeliverableTrackingUpdate(entry))
      .filter((entry): entry is UndeliverableTrackingUpdate => Boolean(entry))
      .sort((left, right) => right.sort_timestamp - left.sort_timestamp)
      .map(({ sort_timestamp: _sortTimestamp, ...entry }) => entry);
    const proofs = await Promise.all(
      attempt.proofs.map(async (proof) => ({
        id: proof.id,
        image_url: await this.mediaAssetsService.createSignedAssetUrl(proof.mediaAsset),
        byte_size: proof.mediaAsset.byteSize,
        width: proof.mediaAsset.width,
        height: proof.mediaAsset.height,
        uploaded_at: proof.createdAt.toISOString(),
      })),
    );

    return {
      attempt: {
        id: attempt.id,
        attempt_number: attempt.attemptNumber,
        failed_at: attempt.failedAt.toISOString(),
      },
      order: {
        id: order.id,
        pos_order_id: order.posOrderId,
        customer_name: order.customerName,
        tracking: order.tracking,
        status: order.status,
        status_name:
          typeof order.status === 'number' && UNDELIVERABLE_STATUS_VALUES.includes(order.status as UndeliverableStatus)
            ? UNDELIVERABLE_STATUS_LABELS[order.status as UndeliverableStatus]
            : order.statusName,
        store_name: this.buildUndeliverableStoreLabel(store),
        order_items: this.parseUndeliverableOrderItems(order.itemData),
      },
      proof: {
        remark: attempt.remark,
        items: proofs,
      },
      items,
    };
  }

  async listUndeliverableRemarkOptions() {
    const access = await this.resolveUndeliverablesAccessScope();
    const options = await this.prisma.undeliverableRemarkOption.findMany({
      where: {
        tenantId: access.tenantId,
      },
      orderBy: [
        { remark: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    return {
      items: options.map((option) => ({
        id: option.id,
        remark: option.remark,
        created_at: option.createdAt.toISOString(),
        updated_at: option.updatedAt.toISOString(),
      })),
    };
  }

  async createUndeliverableRemarkOption(remarkRaw: string) {
    const access = await this.resolveUndeliverablesAccessScope();
    if (!access.canWriteRemarks) {
      throw new ForbiddenException('You do not have permission to manage undeliverables remarks');
    }

    const remark = remarkRaw.trim();
    if (!remark) {
      throw new BadRequestException('Remark is required');
    }

    const duplicate = await this.prisma.undeliverableRemarkOption.findFirst({
      where: {
        tenantId: access.tenantId,
        remark: {
          equals: remark,
          mode: 'insensitive',
        },
      },
      select: {
        id: true,
      },
    });

    if (duplicate) {
      throw new ConflictException('Remark already exists');
    }

    const created = await this.prisma.undeliverableRemarkOption.create({
      data: {
        tenantId: access.tenantId,
        remark,
        createdById: access.userId,
      },
    });

    this.emitUndeliverablesUpdated({
      tenantId: access.tenantId,
      source: 'remark_option_created',
      changedRemarkOptionId: created.id,
    });

    return {
      success: true,
      item: {
        id: created.id,
        remark: created.remark,
        created_at: created.createdAt.toISOString(),
        updated_at: created.updatedAt.toISOString(),
      },
    };
  }

  async updateUndeliverableRemarkOption(remarkOptionId: string, remarkRaw: string) {
    const access = await this.resolveUndeliverablesAccessScope();
    if (!access.canWriteRemarks) {
      throw new ForbiddenException('You do not have permission to manage undeliverables remarks');
    }

    const remark = remarkRaw.trim();
    if (!remark) {
      throw new BadRequestException('Remark is required');
    }

    const existing = await this.prisma.undeliverableRemarkOption.findFirst({
      where: {
        id: remarkOptionId,
        tenantId: access.tenantId,
      },
      select: {
        id: true,
      },
    });

    if (!existing) {
      throw new NotFoundException('Remark option not found');
    }

    const duplicate = await this.prisma.undeliverableRemarkOption.findFirst({
      where: {
        tenantId: access.tenantId,
        id: { not: remarkOptionId },
        remark: {
          equals: remark,
          mode: 'insensitive',
        },
      },
      select: {
        id: true,
      },
    });

    if (duplicate) {
      throw new ConflictException('Remark already exists');
    }

    const updated = await this.prisma.undeliverableRemarkOption.update({
      where: {
        id: remarkOptionId,
      },
      data: {
        remark,
        updatedById: access.userId,
      },
    });

    this.emitUndeliverablesUpdated({
      tenantId: access.tenantId,
      source: 'remark_option_updated',
      changedRemarkOptionId: updated.id,
    });

    return {
      success: true,
      item: {
        id: updated.id,
        remark: updated.remark,
        created_at: updated.createdAt.toISOString(),
        updated_at: updated.updatedAt.toISOString(),
      },
    };
  }

  async deleteUndeliverableRemarkOption(remarkOptionId: string) {
    const access = await this.resolveUndeliverablesAccessScope();
    if (!access.canWriteRemarks) {
      throw new ForbiddenException('You do not have permission to manage undeliverables remarks');
    }

    const existing = await this.prisma.undeliverableRemarkOption.findFirst({
      where: {
        id: remarkOptionId,
        tenantId: access.tenantId,
      },
      select: {
        id: true,
      },
    });

    if (!existing) {
      throw new NotFoundException('Remark option not found');
    }

    await this.prisma.undeliverableRemarkOption.delete({
      where: {
        id: remarkOptionId,
      },
    });

    this.emitUndeliverablesUpdated({
      tenantId: access.tenantId,
      source: 'remark_option_deleted',
      changedRemarkOptionId: remarkOptionId,
    });

    return {
      success: true,
      id: remarkOptionId,
    };
  }

  async createUndeliverableRemark(
    attemptId: string,
    remarkOptionId: string,
    proofFile: UploadedImageFile | undefined,
  ) {
    const access = await this.resolveUndeliverablesAccessScope();
    if (!access.canWriteRemarks) {
      throw new ForbiddenException('You do not have permission to write undeliverables remarks');
    }

    const remarkOption = await this.prisma.undeliverableRemarkOption.findFirst({
      where: {
        id: remarkOptionId,
        tenantId: access.tenantId,
      },
      select: {
        id: true,
        remark: true,
      },
    });

    if (!remarkOption) {
      throw new NotFoundException('Remark option not found');
    }

    const { attempt, order, store } = await this.resolveUndeliverableAttemptScope(attemptId, access);
    if (attempt.remark) {
      throw new ConflictException('This delivery attempt already has an SA remark');
    }

    const remarkedAt = attempt.remarkedAt ?? new Date();
    const remarkedById = attempt.remarkedById ?? access.userId;
    const proofAsset = await this.mediaAssetsService.uploadUndeliverableRemarkProofImage(
      proofFile,
      access.tenantId,
    );

    let updated: {
      id: string;
      remark: string | null;
      updatedAt: Date;
    };
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const result = await tx.undeliverableAttempt.updateMany({
          where: {
            id: attempt.id,
            remark: null,
          },
          data: {
            remark: remarkOption.remark,
            remarkOptionId: remarkOption.id,
            remarkedById,
            remarkedAt,
          },
        });

        if (result.count !== 1) {
          throw new ConflictException('This delivery attempt already has an SA remark');
        }

        await tx.undeliverableAttemptProof.create({
          data: {
            tenantId: access.tenantId,
            attemptId: attempt.id,
            mediaAssetId: proofAsset.assetId,
            uploadedById: access.userId,
          },
        });

        return tx.undeliverableAttempt.findUniqueOrThrow({
          where: {
            id: attempt.id,
          },
        });
      });
    } catch (error) {
      try {
        await this.mediaAssetsService.deleteUnattachedImageAsset(
          proofAsset.assetId,
          access.tenantId,
          MediaAssetKind.UNDELIVERABLE_REMARK_PROOF_IMAGE,
        );
      } catch (cleanupError) {
        this.logger.error(
          `Failed to clean up proof asset ${proofAsset.assetId}: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        );
      }
      throw error;
    }

    this.emitUndeliverablesUpdated({
      tenantId: access.tenantId,
      source: 'remark_created',
      changedOrderId: order.id,
      changedStoreIds: [store.id],
    });

    return {
      success: true,
      item: {
        id: updated.id,
        remark: updated.remark,
        proof_asset_id: proofAsset.assetId,
        created_at: remarkedAt.toISOString(),
        updated_at: updated.updatedAt.toISOString(),
      },
    };
  }

  async updateUndeliverableRemark(remarkId: string, remarkOptionId: string) {
    const access = await this.resolveUndeliverablesAccessScope();
    if (!access.canWriteRemarks) {
      throw new ForbiddenException('You do not have permission to update undeliverables remarks');
    }

    const remarkOption = await this.prisma.undeliverableRemarkOption.findFirst({
      where: {
        id: remarkOptionId,
        tenantId: access.tenantId,
      },
      select: {
        id: true,
        remark: true,
      },
    });

    if (!remarkOption) {
      throw new NotFoundException('Remark option not found');
    }

    const { attempt, order } = await this.resolveUndeliverableAttemptScope(remarkId, access);
    const updated = await this.prisma.undeliverableAttempt.update({
      where: {
        id: attempt.id,
      },
      data: {
        remark: remarkOption.remark,
        remarkOptionId: remarkOption.id,
        remarkedAt: attempt.remarkedAt ?? attempt.updatedAt,
        remarkedById: attempt.remarkedById ?? access.userId,
      },
    });

    this.emitUndeliverablesUpdated({
      tenantId: access.tenantId,
      source: 'remark_updated',
      changedOrderId: order.id,
    });

    return {
      success: true,
      item: {
        id: updated.id,
        remark: updated.remark,
        created_at: (attempt.remarkedAt ?? attempt.updatedAt).toISOString(),
        updated_at: updated.updatedAt.toISOString(),
      },
    };
  }

  async deleteUndeliverableRemark(remarkId: string) {
    const access = await this.resolveUndeliverablesAccessScope();
    if (!access.canWriteRemarks) {
      throw new ForbiddenException('You do not have permission to delete undeliverables remarks');
    }

    const { attempt, order } = await this.resolveUndeliverableAttemptScope(remarkId, access);
    await this.prisma.undeliverableAttempt.update({
      where: {
        id: attempt.id,
      },
      data: {
        remark: null,
        remarkOptionId: null,
      },
    });

    this.emitUndeliverablesUpdated({
      tenantId: access.tenantId,
      source: 'remark_deleted',
      changedOrderId: order.id,
    });

    return {
      success: true,
      id: attempt.id,
    };
  }

  async getAgingOrdersUnreadNotificationCount() {
    const { tenantId, accessibleShopIds, shopDisplayMap } =
      await this.resolveAccessibleAgingOrderScope();
    if (accessibleShopIds.length === 0) {
      return { count: 0 };
    }

    await this.ensureAgingOrdersNotificationsFresh({
      tenantId,
      shopIds: accessibleShopIds,
      shopDisplayMap,
    });

    return {
      count: await this.prisma.notificationState.count({
        where: {
          tenantId,
          system: NotificationSystem.ERP,
          domain: NotificationDomain.ORDERS_AGING,
          entityType: AGING_ORDERS_NOTIFICATION_ENTITY_TYPE,
          isUnread: true,
          entityId: {
            in: this.buildAgingOrderNotificationEntityIds(accessibleShopIds),
          },
        },
      }),
    };
  }

  async markAgingOrdersNotificationRead(params: {
    shop_id: string;
  }) {
    const { tenantId, accessibleShopIds } = await this.resolveAccessibleAgingOrderScope();
    if (!accessibleShopIds.includes(params.shop_id)) {
      throw new ForbiddenException('Selected shop is outside your team scope');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const entityId = this.getAgingOrderNotificationEntityId(params.shop_id);
    const updatedCount = await this.notificationStateService.markEntityRead({
      tenantId,
      system: NotificationSystem.ERP,
      domain: NotificationDomain.ORDERS_AGING,
      entityType: AGING_ORDERS_NOTIFICATION_ENTITY_TYPE,
      entityId,
      readByUserId: actorId,
    });

    if (updatedCount > 0) {
      this.emitAgingOrdersNotificationUpdate({
        tenantId,
        source: 'read',
        changedEntityIds: [entityId],
        changedRowCount: updatedCount,
      });
    }

    return {
      success: true,
      count: updatedCount,
    };
  }

  private async syncAgingOrderNotificationsForTenant(
    tenantId: string,
    source: 'lazy',
    options?: {
      shopIds?: string[];
      shopDisplayMap?: Map<string, string>;
      bucketDetails?: AgingOrdersBucketDetail[];
    },
  ) {
    const baseShopDisplayMap =
      options?.shopDisplayMap ?? await this.getTenantAgingOrderShopDisplayMap(tenantId);
    const shopIds = Array.from(
      new Set(
        (options?.shopIds?.length ? options.shopIds : Array.from(baseShopDisplayMap.keys()))
          .map((shopId) => shopId?.trim())
          .filter((shopId): shopId is string => !!shopId),
      ),
    );
    const shopDisplayMap = new Map(
      shopIds.map((shopId) => [shopId, baseShopDisplayMap.get(shopId) || shopId]),
    );

    if (shopIds.length === 0) {
      return {
        changedRowCount: 0,
      };
    }

    const bucketDetails =
      options?.bucketDetails
      ?? await this.loadAgingOrdersBucketDetails({
        tenantId,
        shopIds,
        thresholdDays: AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS,
      });
    const existingRows = await this.prisma.notificationState.findMany({
      where: {
        tenantId,
        system: NotificationSystem.ERP,
        domain: NotificationDomain.ORDERS_AGING,
        entityType: AGING_ORDERS_NOTIFICATION_ENTITY_TYPE,
      },
      select: {
        id: true,
        entityId: true,
        context: true,
        isUnread: true,
      },
    });

    const scopedExistingRows = existingRows.filter((row) => {
      const parsed = this.parseAgingOrderNotificationEntityId(row.entityId);
      return !!parsed && shopIds.includes(parsed.shopId);
    });
    const currentShopStatesByEntityId = new Map(
      Array.from(this.buildAgingOrdersNotificationShopState(bucketDetails).entries()).map(
        ([shopId, value]) => [this.getAgingOrderNotificationEntityId(shopId), value],
      ),
    );
    const existingRowsByEntityId = new Map(
      scopedExistingRows
        .filter((row) => !row.entityId.includes(':'))
        .map((row) => [row.entityId, row]),
    );
    const changedEntityIds: string[] = [];
    let changedRowCount = 0;
    const now = new Date();
    const syncStamp = now.toISOString();

    await this.prisma.$transaction(async (tx) => {
      for (const existingRow of scopedExistingRows.filter((row) => row.entityId.includes(':'))) {
        const parsedEntity = this.parseAgingOrderNotificationEntityId(existingRow.entityId);
        if (!parsedEntity) {
          continue;
        }

        changedRowCount += 1;
        changedEntityIds.push(this.getAgingOrderNotificationEntityId(parsedEntity.shopId));

        await tx.notificationState.delete({
          where: { id: existingRow.id },
        });
      }

      for (const existingRow of scopedExistingRows.filter((row) => !row.entityId.includes(':'))) {
        if (currentShopStatesByEntityId.has(existingRow.entityId)) {
          continue;
        }

        const parsedEntity = this.parseAgingOrderNotificationEntityId(existingRow.entityId);
        if (!parsedEntity) {
          continue;
        }

        const existingContext = this.toObject(
          existingRow.context,
        ) as AgingOrdersNotificationContext | null;
        const existingAffectedOrderCount =
          typeof existingContext?.affectedOrderCount === 'number'
            ? existingContext.affectedOrderCount
            : 0;
        const existingSignature =
          typeof existingContext?.shopSignature === 'string'
            ? existingContext.shopSignature
            : null;

        if (!existingRow.isUnread && existingAffectedOrderCount === 0 && existingSignature === null) {
          continue;
        }

        changedRowCount += 1;
        changedEntityIds.push(existingRow.entityId);

        await tx.notificationState.update({
          where: { id: existingRow.id },
          data: {
            sourceEventId: `aging-orders-sync:${tenantId}:${existingRow.entityId}:${syncStamp}`,
            sourceEventType: 'AGING_THRESHOLD_SYNC',
            fromState: existingAffectedOrderCount > 0 ? String(existingAffectedOrderCount) : null,
            toState: '0',
            context: {
              shopId: parsedEntity.shopId,
              shopName: shopDisplayMap.get(parsedEntity.shopId) || parsedEntity.shopId,
              shopSignature: null,
              affectedOrderCount: 0,
              thresholdDays: AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS,
              sampleOrderIds: [],
              source,
              syncedAt: syncStamp,
            },
            isUnread: false,
            readAt: now,
            readByUserId: null,
          },
        });
      }

      for (const [entityId, shopState] of currentShopStatesByEntityId) {
        const existingRow = existingRowsByEntityId.get(entityId);
        const existingContext = this.toObject(
          existingRow?.context ?? null,
        ) as AgingOrdersNotificationContext | null;
        const existingAffectedOrderCount =
          typeof existingContext?.affectedOrderCount === 'number'
            ? existingContext.affectedOrderCount
            : 0;
        const existingSignature =
          typeof existingContext?.shopSignature === 'string'
            ? existingContext.shopSignature
            : null;
        const nextContext = {
          shopId: shopState.shopId,
          shopName: shopDisplayMap.get(shopState.shopId) || shopState.shopId,
          shopSignature: shopState.shopSignature,
          affectedOrderCount: shopState.affectedOrderCount,
          thresholdDays: AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS,
          sampleOrderIds: shopState.orderIds.slice(0, 10),
          source,
          syncedAt: syncStamp,
        };

        if (!existingRow) {
          changedRowCount += 1;
          changedEntityIds.push(entityId);

          await tx.notificationState.create({
            data: {
              tenantId,
              system: NotificationSystem.ERP,
              domain: NotificationDomain.ORDERS_AGING,
              entityType: AGING_ORDERS_NOTIFICATION_ENTITY_TYPE,
              entityId,
              sourceEventId: `aging-orders-sync:${tenantId}:${entityId}:${syncStamp}`,
              sourceEventType: 'AGING_THRESHOLD_SYNC',
              fromState: null,
              toState: String(shopState.affectedOrderCount),
              context: nextContext,
              isUnread: true,
            },
          });
          continue;
        }

        if (
          existingSignature === shopState.shopSignature
          && existingAffectedOrderCount === shopState.affectedOrderCount
        ) {
          continue;
        }

        changedRowCount += 1;
        changedEntityIds.push(entityId);

        await tx.notificationState.update({
          where: { id: existingRow.id },
          data: {
            sourceEventId: `aging-orders-sync:${tenantId}:${entityId}:${syncStamp}`,
            sourceEventType: 'AGING_THRESHOLD_SYNC',
            fromState: existingAffectedOrderCount > 0 ? String(existingAffectedOrderCount) : null,
            toState: String(shopState.affectedOrderCount),
            context: nextContext,
            isUnread: true,
            readAt: null,
            readByUserId: null,
          },
        });
      }
    });

    if (changedEntityIds.length > 0) {
      this.emitAgingOrdersNotificationUpdate({
        tenantId,
        source,
        changedEntityIds,
        changedRowCount,
      });
    }

    return {
      changedRowCount,
    };
  }

  async listConfirmationOrders(params: ListConfirmationOrdersParams) {
    const today = this.getTodayDateLocal();
    let startDate = this.normalizeDateLocal(params.startDate, today);
    let endDate = this.normalizeDateLocal(params.endDate, today);
    if (startDate > endDate) {
      [startDate, endDate] = [endDate, startDate];
    }

    const page = this.parsePage(params.page);
    const limit = this.parseLimit(params.limit);
    const skip = (page - 1) * limit;
    const search = params.search?.trim() || '';

    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams = (Array.isArray(teamIds) && teamIds.length > 0 ? teamIds : userTeams) || [];
    const storeWhere = this.buildPosStoreAccessWhere(tenantId, allowedTeams, isAdmin, tenantHasTeams);

    if (!storeWhere) {
      return {
        items: [],
        pagination: {
          page,
          limit,
          total: 0,
          pageCount: 0,
        },
        filters: {
          shops: [],
        },
        selected: {
          start_date: startDate,
          end_date: endDate,
          shop_ids: [],
          search,
        },
      };
    }

    const stores = (await this.prisma.posStore.findMany({
      where: storeWhere,
      select: {
        id: true,
        shopId: true,
        shopName: true,
        name: true,
      },
      orderBy: [{ shopName: 'asc' }, { name: 'asc' }],
    })) as PosStoreAccessRow[];

    const accessibleShopIds = Array.from(new Set(stores.map((store) => store.shopId).filter(Boolean)));
    if (accessibleShopIds.length === 0) {
      return {
        items: [],
        pagination: {
          page,
          limit,
          total: 0,
          pageCount: 0,
        },
        filters: {
          shops: [],
        },
        selected: {
          start_date: startDate,
          end_date: endDate,
          shop_ids: [],
          search,
        },
      };
    }

    const accessibleShopSet = new Set(accessibleShopIds);
    const requestedShopIds = this.parseShopIds(params.shopIds);
    const selectedShopIds = requestedShopIds.filter((shopId) => accessibleShopSet.has(shopId));
    const effectiveShopIds = selectedShopIds.length > 0 ? selectedShopIds : accessibleShopIds;
    const processingCutoff = this.getConfirmationUpdateProcessingCutoff();
    const processingFilter: Prisma.PosOrderWhereInput = {
      OR: [
        { confirmationUpdateRequestedAt: null },
        { confirmationUpdateRequestedAt: { lt: processingCutoff } },
      ],
    };

    const rangeWhere: Prisma.PosOrderWhereInput = {
      tenantId,
      status: 0,
      AND: [processingFilter],
      dateLocal: {
        gte: startDate,
        lte: endDate,
      },
      shopId: { in: accessibleShopIds },
    };

    const shopsInRangeRows = await this.prisma.posOrder.findMany({
      where: rangeWhere,
      select: { shopId: true },
      distinct: ['shopId'],
    });
    const shopsInRange = new Set(shopsInRangeRows.map((row) => row.shopId));

    const storeMetaByShopId = new Map(
      stores.map((store) => [
        store.shopId,
        {
          shopName: store.shopName?.trim() || store.name?.trim() || store.shopId,
        },
      ]),
    );

    const shopOptions = stores
      .filter((store) => shopsInRange.has(store.shopId))
      .map((store) => ({
        shop_id: store.shopId,
        shop_name:
          storeMetaByShopId.get(store.shopId)?.shopName || store.shopName?.trim() || store.name?.trim() || store.shopId,
      }));

    const andClauses: Prisma.PosOrderWhereInput[] = [processingFilter];
    if (search) {
      andClauses.push({
        OR: [
          { posOrderId: { contains: search, mode: 'insensitive' } },
          { customerName: { contains: search, mode: 'insensitive' } },
          { customerPhone: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.PosOrderWhereInput = {
      tenantId,
      status: 0,
      AND: andClauses,
      dateLocal: {
        gte: startDate,
        lte: endDate,
      },
      shopId: { in: effectiveShopIds },
    };

    const [total, rows] = (await this.prisma.$transaction([
      this.prisma.posOrder.count({ where }),
      this.prisma.posOrder.findMany({
        where,
        orderBy: [{ dateLocal: 'desc' }, { insertedAt: 'desc' }],
        skip,
        take: limit,
        select: {
          id: true,
          shopId: true,
          posOrderId: true,
          dateLocal: true,
          insertedAt: true,
          status: true,
          statusName: true,
          isAbandoned: true,
          cod: true,
          reportsByPhoneOrderFail: true,
          reportsByPhoneOrderSuccess: true,
          customerName: true,
          customerPhone: true,
          customerAddress: true,
          itemData: true,
          orderSnapshot: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ])) as [number, PosOrderListRow[]];

    const shopIdByStoreId = new Map(stores.map((store) => [store.id, store.shopId]));
    const storeIdByShopId = new Map(stores.map((store) => [store.shopId, store.id]));
    const warehouseIds = Array.from(
      new Set(
        rows
          .map((row) => this.extractOrderWarehouseId(row.orderSnapshot))
          .filter((value): value is string => !!value),
      ),
    );
    const storeIdsForWarehouseLookup = Array.from(
      new Set(
        rows
          .map((row) => storeIdByShopId.get(row.shopId))
          .filter((value): value is string => !!value),
      ),
    );
    const warehouseNameByShopAndWarehouseId = new Map<string, string>();
    if (warehouseIds.length > 0 && storeIdsForWarehouseLookup.length > 0) {
      const warehouseRows = await this.prisma.posWarehouse.findMany({
        where: {
          storeId: { in: storeIdsForWarehouseLookup },
          warehouseId: { in: warehouseIds },
        },
        select: {
          storeId: true,
          warehouseId: true,
          name: true,
        },
      });

      for (const warehouse of warehouseRows) {
        const shopId = shopIdByStoreId.get(warehouse.storeId);
        if (!shopId) continue;
        warehouseNameByShopAndWarehouseId.set(
          `${shopId}|${warehouse.warehouseId}`,
          warehouse.name,
        );
      }
    }

    const pageCount = total === 0 ? 0 : Math.ceil(total / limit);
    const items = rows.map((row) => {
      const tagDetails = this.extractTagDetails(row.tags);
      const warehouseId = this.extractOrderWarehouseId(row.orderSnapshot);
      return {
      id: row.id,
      store_id: storeIdByShopId.get(row.shopId) || null,
      shop_id: row.shopId,
      shop_name: storeMetaByShopId.get(row.shopId)?.shopName || row.shopId,
      pos_order_id: row.posOrderId,
      date_local: row.dateLocal,
      inserted_at: row.insertedAt.toISOString(),
      inserted_at_local: dayjs(row.insertedAt).tz(TIMEZONE).format('YYYY-MM-DD HH:mm:ss'),
      status: row.status,
      status_name: row.statusName,
      is_abandoned: row.isAbandoned,
      cod: this.toNumber(row.cod),
      reports_by_phone_fail: row.reportsByPhoneOrderFail,
      reports_by_phone_success: row.reportsByPhoneOrderSuccess,
      customer_name: row.customerName || null,
      customer_phone: row.customerPhone || null,
      customer_address: row.customerAddress || null,
      item_data: row.itemData,
      order_snapshot: row.orderSnapshot,
      warehouse_id: warehouseId,
      warehouse_name:
        warehouseId
          ? warehouseNameByShopAndWarehouseId.get(`${row.shopId}|${warehouseId}`) || null
          : null,
      tags: tagDetails.map((entry) => entry.name),
      tags_detail: tagDetails,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      };
    });

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        pageCount,
      },
      filters: {
        shops: shopOptions,
      },
      selected: {
        start_date: startDate,
        end_date: endDate,
        shop_ids: selectedShopIds,
        search,
      },
    };
  }

  async listConfirmationPhoneHistory(params: ListConfirmationPhoneHistoryParams) {
    const rawPhone = params.phone?.trim() || '';
    const canonicalPhone = this.normalizePhoneToCanonical(rawPhone);
    if (!canonicalPhone) {
      throw new BadRequestException('Invalid phone number format');
    }

    const page = this.parsePage(params.page);
    const limit = this.parseLimit(params.limit);
    const skip = (page - 1) * limit;
    const local10 = canonicalPhone.slice(2);
    const phoneVariants = this.buildPhoneMatchVariants(canonicalPhone);

    const { tenantId } = await this.teamContext.getContext();

    const [stores, candidateRows] = await this.prisma.$transaction([
      this.prisma.posStore.findMany({
        where: { tenantId },
        select: {
          id: true,
          shopId: true,
          shopName: true,
          name: true,
        },
      }),
      this.prisma.posOrder.findMany({
        where: {
          tenantId,
          customerPhone: { not: null },
          OR: [
            ...phoneVariants.map((phone) => ({ customerPhone: phone })),
            { customerPhone: { endsWith: local10 } },
          ],
        },
        orderBy: [{ dateLocal: 'desc' }, { insertedAt: 'desc' }],
        select: {
          id: true,
          shopId: true,
          posOrderId: true,
          dateLocal: true,
          insertedAt: true,
          status: true,
          statusName: true,
          isAbandoned: true,
          cod: true,
          reportsByPhoneOrderFail: true,
          reportsByPhoneOrderSuccess: true,
          customerName: true,
          customerPhone: true,
          customerAddress: true,
          itemData: true,
          orderSnapshot: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    const normalizedRows = (candidateRows as PosOrderListRow[]).filter(
      (row) => this.normalizePhoneToCanonical(row.customerPhone) === canonicalPhone,
    );

    const total = normalizedRows.length;
    const pageRows = normalizedRows.slice(skip, skip + limit);
    const pageCount = total === 0 ? 0 : Math.ceil(total / limit);

    const storeMetaByShopId = new Map(
      stores.map((store) => [
        store.shopId,
        {
          shopName: store.shopName?.trim() || store.name?.trim() || store.shopId,
        },
      ]),
    );
    const shopIdByStoreId = new Map(stores.map((store) => [store.id, store.shopId]));
    const storeIdByShopId = new Map(stores.map((store) => [store.shopId, store.id]));
    const warehouseIds = Array.from(
      new Set(
        pageRows
          .map((row) => this.extractOrderWarehouseId(row.orderSnapshot))
          .filter((value): value is string => !!value),
      ),
    );
    const storeIdsForWarehouseLookup = Array.from(
      new Set(
        pageRows
          .map((row) => storeIdByShopId.get(row.shopId))
          .filter((value): value is string => !!value),
      ),
    );
    const warehouseNameByShopAndWarehouseId = new Map<string, string>();
    if (warehouseIds.length > 0 && storeIdsForWarehouseLookup.length > 0) {
      const warehouseRows = await this.prisma.posWarehouse.findMany({
        where: {
          storeId: { in: storeIdsForWarehouseLookup },
          warehouseId: { in: warehouseIds },
        },
        select: {
          storeId: true,
          warehouseId: true,
          name: true,
        },
      });

      for (const warehouse of warehouseRows) {
        const shopId = shopIdByStoreId.get(warehouse.storeId);
        if (!shopId) continue;
        warehouseNameByShopAndWarehouseId.set(
          `${shopId}|${warehouse.warehouseId}`,
          warehouse.name,
        );
      }
    }

    const items = pageRows.map((row) => {
      const tagDetails = this.extractTagDetails(row.tags);
      const warehouseId = this.extractOrderWarehouseId(row.orderSnapshot);
      return {
      id: row.id,
      store_id: storeIdByShopId.get(row.shopId) || null,
      shop_id: row.shopId,
      shop_name: storeMetaByShopId.get(row.shopId)?.shopName || row.shopId,
      pos_order_id: row.posOrderId,
      date_local: row.dateLocal,
      inserted_at: row.insertedAt.toISOString(),
      inserted_at_local: dayjs(row.insertedAt).tz(TIMEZONE).format('YYYY-MM-DD HH:mm:ss'),
      status: row.status,
      status_name: row.statusName,
      is_abandoned: row.isAbandoned,
      cod: this.toNumber(row.cod),
      reports_by_phone_fail: row.reportsByPhoneOrderFail,
      reports_by_phone_success: row.reportsByPhoneOrderSuccess,
      customer_name: row.customerName || null,
      customer_phone: row.customerPhone || null,
      customer_address: row.customerAddress || null,
      item_data: row.itemData,
      order_snapshot: row.orderSnapshot,
      warehouse_id: warehouseId,
      warehouse_name:
        warehouseId
          ? warehouseNameByShopAndWarehouseId.get(`${row.shopId}|${warehouseId}`) || null
          : null,
      tags: tagDetails.map((entry) => entry.name),
      tags_detail: tagDetails,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      };
    });

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        pageCount,
      },
      selected: {
        phone: rawPhone,
        canonical_phone: canonicalPhone,
      },
    };
  }

  async listConfirmationOrderTagOptions(orderRowId: string) {
    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams =
      (Array.isArray(teamIds) && teamIds.length > 0 ? teamIds : userTeams) || [];
    const storeWhere = this.buildPosStoreAccessWhere(tenantId, allowedTeams, isAdmin, tenantHasTeams);
    if (!storeWhere) {
      throw new ForbiddenException('No store access for current team scope');
    }

    const order = await this.prisma.posOrder.findFirst({
      where: {
        id: orderRowId,
        tenantId,
      },
      select: {
        id: true,
        shopId: true,
        posOrderId: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const store = await this.prisma.posStore.findFirst({
      where: {
        ...storeWhere,
        shopId: order.shopId,
      },
      select: {
        id: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!store) {
      throw new ForbiddenException('Order store is outside your team scope');
    }

    const rows = (await this.prisma.posTag.findMany({
      where: {
        tenantId,
        storeId: store.id,
      },
      orderBy: [{ groupName: 'asc' }, { name: 'asc' }],
      select: {
        tagId: true,
        name: true,
        groupId: true,
        groupName: true,
      },
    })) as ConfirmationTagOptionRow[];

    const groupedMap = new Map<string, { group_id: string; group_name: string; tags: Array<{ tag_id: string; name: string }> }>();
    const individual: Array<{ tag_id: string; name: string }> = [];

    for (const row of rows) {
      const tag = { tag_id: row.tagId, name: row.name };
      if (!row.groupId || !row.groupName) {
        individual.push(tag);
        continue;
      }

      const existing = groupedMap.get(row.groupId);
      if (!existing) {
        groupedMap.set(row.groupId, {
          group_id: row.groupId,
          group_name: row.groupName,
          tags: [tag],
        });
        continue;
      }
      existing.tags.push(tag);
    }

    return {
      order_id: order.id,
      shop_id: order.shopId,
      groups: Array.from(groupedMap.values()),
      individual,
      total: rows.length,
    };
  }

  async listConfirmationOrderProductOptions(
    orderRowId: string,
    searchRaw?: string,
    limitRaw?: string,
  ) {
    const search = (searchRaw || '').trim();
    const limit = Math.min(this.parseLimit(limitRaw), 50);
    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams =
      (Array.isArray(teamIds) && teamIds.length > 0 ? teamIds : userTeams) || [];
    const storeWhere = this.buildPosStoreAccessWhere(tenantId, allowedTeams, isAdmin, tenantHasTeams);
    if (!storeWhere) {
      throw new ForbiddenException('No store access for current team scope');
    }

    const order = await this.prisma.posOrder.findFirst({
      where: {
        id: orderRowId,
        tenantId,
      },
      select: {
        id: true,
        shopId: true,
        orderSnapshot: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const store = await this.prisma.posStore.findFirst({
      where: {
        ...storeWhere,
        shopId: order.shopId,
      },
      select: {
        id: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!store) {
      throw new ForbiddenException('Order store is outside your team scope');
    }

    const warehouseId = this.extractOrderWarehouseId(order.orderSnapshot);
    if (!warehouseId) {
      return {
        order_id: order.id,
        shop_id: order.shopId,
        warehouse_id: null,
        warehouse_name: null,
        items: [],
        total: 0,
      };
    }

    const warehouse = await this.prisma.posWarehouse.findFirst({
      where: {
        storeId: store.id,
        warehouseId,
      },
      select: {
        name: true,
      },
    });

    const where: Prisma.PosProductWhereInput = {
      storeId: store.id,
      warehouseId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { customId: { contains: search, mode: 'insensitive' } },
              { productId: { contains: search, mode: 'insensitive' } },
              { variationId: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.posProduct.findMany({
      where,
      orderBy: [{ name: 'asc' }, { updatedAt: 'desc' }],
      take: limit,
      select: {
        productId: true,
        variationId: true,
        customId: true,
        name: true,
        retailPrice: true,
        productSnapshot: true,
      },
    });

    const items = rows
      .map((row) => {
        const variationId = row.variationId?.toString?.().trim?.() || '';
        if (!variationId) return null;

        const snapshot = this.toObject(row.productSnapshot);
        let imageUrl: string | null = null;

        const images = Array.isArray(snapshot?.images) ? snapshot.images : [];
        imageUrl =
          images.find(
            (value) => typeof value === 'string' && value.trim().length > 0,
          )?.toString?.() || null;

        if (!imageUrl) {
          const productSnapshot = this.toObject(snapshot?.product as Prisma.JsonValue | null);
          const productImage = productSnapshot?.image;
          if (typeof productImage === 'string' && productImage.trim()) {
            imageUrl = productImage.trim();
          }
        }

        return {
          variation_id: variationId,
          product_id: row.productId,
          custom_id: row.customId || null,
          name: row.name,
          retail_price: this.toNumber(row.retailPrice),
          image_url: imageUrl,
        };
      })
      .filter(
        (
          row,
        ): row is {
          variation_id: string;
          product_id: string;
          custom_id: string | null;
          name: string;
          retail_price: number;
          image_url: string | null;
        } => !!row,
      );

    return {
      order_id: order.id,
      shop_id: order.shopId,
      warehouse_id: warehouseId,
      warehouse_name: warehouse?.name || null,
      items,
      total: items.length,
    };
  }

  async updateConfirmationOrderStatus(
    orderRowId: string,
    payload: {
      status?: number;
      tags?: Array<{ id: string; name: string }>;
      items?: Array<{ variation_id: string; quantity: number }>;
      note?: string;
      note_print?: string;
      shipping_address?: Record<string, unknown>;
      shipping_fee?: number;
      total_discount?: number;
      bank_payments?: unknown;
      surcharge?: number;
    },
  ) {
    try {
      const targetStatus =
        typeof payload.status === 'number' && Number.isFinite(payload.status)
          ? payload.status
          : null;
      const hasTagsPayload = Array.isArray(payload.tags);
      const targetTags = hasTagsPayload ? this.normalizeUpdateTags(payload.tags || []) : undefined;
      const hasItemsPayload = Array.isArray(payload.items);
      const targetItems = hasItemsPayload ? this.normalizeUpdateItems(payload.items || []) : undefined;
      const hasNotePayload = Object.prototype.hasOwnProperty.call(payload, 'note');
      const targetNote = hasNotePayload ? (typeof payload.note === 'string' ? payload.note : '') : undefined;
      const hasNotePrintPayload = Object.prototype.hasOwnProperty.call(payload, 'note_print');
      const targetNotePrint = hasNotePrintPayload
        ? (typeof payload.note_print === 'string' ? payload.note_print : '')
        : undefined;
      const hasShippingAddressPayload = Object.prototype.hasOwnProperty.call(payload, 'shipping_address');
      let targetShippingAddress: Record<string, unknown> | undefined;
      if (hasShippingAddressPayload) {
        const shippingAddressValue = payload.shipping_address;
        if (
          !shippingAddressValue ||
          typeof shippingAddressValue !== 'object' ||
          Array.isArray(shippingAddressValue)
        ) {
          throw new BadRequestException('shipping_address must be an object');
        }
        const sanitizedShippingAddress = {
          ...(shippingAddressValue as Record<string, unknown>),
        };
        delete (sanitizedShippingAddress as { id?: unknown }).id;
        targetShippingAddress = sanitizedShippingAddress;
      }
      const targetShippingFee = this.parseOptionalAmountUpdateField(payload, 'shipping_fee');
      const hasShippingFeePayload = typeof targetShippingFee === 'number';
      const targetTotalDiscount = this.parseOptionalAmountUpdateField(payload, 'total_discount');
      const hasTotalDiscountPayload = typeof targetTotalDiscount === 'number';
      const hasBankPaymentsPayload = Object.prototype.hasOwnProperty.call(payload, 'bank_payments');
      const targetBankPayments = hasBankPaymentsPayload ? payload.bank_payments : undefined;
      const targetSurcharge = this.parseOptionalAmountUpdateField(payload, 'surcharge');
      const hasSurchargePayload = typeof targetSurcharge === 'number';

      if (
        targetStatus === null &&
        !hasTagsPayload &&
        !hasItemsPayload &&
        !hasNotePayload &&
        !hasNotePrintPayload &&
        !hasShippingAddressPayload &&
        !hasShippingFeePayload &&
        !hasTotalDiscountPayload &&
        !hasBankPaymentsPayload &&
        !hasSurchargePayload
      ) {
        throw new BadRequestException(
          'Request must include status, tags, items, note, note_print, shipping_address, shipping_fee, total_discount, bank_payments, and/or surcharge',
        );
      }

      if (targetStatus !== null && !this.allowedConfirmationStatusUpdates.has(targetStatus)) {
        throw new BadRequestException('Invalid status. Allowed values: 1, 6, 7, 11');
      }

      const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
      const allowedTeams =
        (Array.isArray(teamIds) && teamIds.length > 0 ? teamIds : userTeams) || [];
      const storeWhere = this.buildPosStoreAccessWhere(tenantId, allowedTeams, isAdmin, tenantHasTeams);
      if (!storeWhere) {
        throw new ForbiddenException('No store access for current team scope');
      }

      const order = await this.withDbRetry(
        () =>
          this.prisma.posOrder.findFirst({
            where: { id: orderRowId, tenantId },
            select: {
              id: true,
              shopId: true,
              posOrderId: true,
              status: true,
              confirmationUpdateRequestedAt: true,
              confirmationUpdateTargetStatus: true,
            },
          }),
        'read-confirmation-order',
      );

      if (!order) {
        throw new NotFoundException('Order not found');
      }

      if (order.status !== 0) {
        throw new BadRequestException(
          'Only NEW (status 0) orders can be updated from confirmation queue',
        );
      }

      const processingCutoff = this.getConfirmationUpdateProcessingCutoff();
      if (targetStatus === null) {
        const hasInFlightStatusUpdate =
          !!order.confirmationUpdateRequestedAt &&
          order.confirmationUpdateRequestedAt >= processingCutoff;
        if (hasInFlightStatusUpdate) {
          const inflightTarget =
            typeof order.confirmationUpdateTargetStatus === 'number'
              ? order.confirmationUpdateTargetStatus
              : null;
          throw new ConflictException(
            `Order status update is already in progress (${this.getConfirmationStatusLabel(inflightTarget)}). Please wait for webhook sync.`,
          );
        }
      }

      const store = await this.withDbRetry(
        () =>
          this.prisma.posStore.findFirst({
            where: {
              ...storeWhere,
              shopId: order.shopId,
            },
            select: {
              id: true,
              shopId: true,
              apiKey: true,
              integrationId: true,
            },
            orderBy: { updatedAt: 'desc' },
          }),
        'read-confirmation-store',
      );

      if (!store) {
        throw new ForbiddenException('Order store is outside your team scope');
      }

      const hasStatusUpdate = targetStatus !== null;
      const processingRequestedAt = new Date();
      let lockedForStatusUpdate = false;

      if (hasStatusUpdate) {
        const lockResult = await this.withDbRetry(
          () =>
            this.prisma.posOrder.updateMany({
              where: {
                id: order.id,
                tenantId,
                status: 0,
                OR: [
                  { confirmationUpdateRequestedAt: null },
                  { confirmationUpdateRequestedAt: { lt: processingCutoff } },
                ],
              },
              data: {
                confirmationUpdateRequestedAt: processingRequestedAt,
                confirmationUpdateTargetStatus: targetStatus,
              },
            }),
          'lock-confirmation-order',
        );

        if (lockResult.count === 0) {
          const latest = await this.withDbRetry(
            () =>
              this.prisma.posOrder.findUnique({
                where: { id: order.id },
                select: {
                  status: true,
                  confirmationUpdateRequestedAt: true,
                  confirmationUpdateTargetStatus: true,
                },
              }),
            'read-confirmation-order-after-lock',
          );

          if (!latest) {
            throw new NotFoundException('Order not found');
          }

          if (latest.status !== 0) {
            throw new BadRequestException('Order is no longer NEW. Please refresh.');
          }

          const inFlight =
            latest.confirmationUpdateRequestedAt &&
            latest.confirmationUpdateRequestedAt >= processingCutoff;
          if (inFlight) {
            const inflightTarget =
              typeof latest.confirmationUpdateTargetStatus === 'number'
                ? latest.confirmationUpdateTargetStatus
                : null;
            if (inflightTarget === targetStatus) {
              const startedAtIso =
                latest.confirmationUpdateRequestedAt?.toISOString?.() ||
                processingRequestedAt.toISOString();
              return {
                accepted: true,
                shop_id: order.shopId,
                order_id: order.posOrderId,
                status: targetStatus,
                tags_count: targetTags?.length ?? undefined,
                items_count: targetItems?.length ?? undefined,
                note_updated: hasNotePayload || undefined,
                note_print_updated: hasNotePrintPayload || undefined,
                shipping_address_updated: hasShippingAddressPayload || undefined,
                shipping_fee_updated: hasShippingFeePayload || undefined,
                total_discount_updated: hasTotalDiscountPayload || undefined,
                bank_payments_updated: hasBankPaymentsPayload || undefined,
                surcharge_updated: hasSurchargePayload || undefined,
                processing: true,
                processing_started_at: startedAtIso,
                processing_timeout_seconds: this.getConfirmationUpdateProcessingTtlSeconds(),
                assigning_seller_included: true,
                message: 'Order update already in progress. Waiting for webhook callback.',
              };
            }
            throw new ConflictException(
              `Order update is already in progress (${this.getConfirmationStatusLabel(inflightTarget)}). Please wait for webhook sync.`,
            );
          }

          throw new BadRequestException(
            'Order update cannot be processed right now. Please retry.',
          );
        }

        lockedForStatusUpdate = true;
      }

      try {
        await this.enqueueConfirmationStatusUpdate({
          tenantId,
          orderRowId: order.id,
          shopId: order.shopId,
          posOrderId: order.posOrderId,
          targetStatus,
          targetTags: targetTags ?? null,
          targetItems: targetItems ?? null,
          targetNote,
          targetNotePrint,
          targetShippingAddress,
          targetShippingFee,
          targetTotalDiscount,
          targetBankPayments,
          targetSurcharge,
        });
      } catch (error: any) {
        if (lockedForStatusUpdate) {
          await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
        }
        const message = (error?.message || '').toString();
        const normalized = message.toLowerCase();
        if (normalized.includes('job') && normalized.includes('exist')) {
          return {
            accepted: true,
            shop_id: order.shopId,
            order_id: order.posOrderId,
            status: targetStatus ?? undefined,
            tags_count: targetTags?.length ?? undefined,
            items_count: targetItems?.length ?? undefined,
            note_updated: hasNotePayload || undefined,
            note_print_updated: hasNotePrintPayload || undefined,
            shipping_address_updated: hasShippingAddressPayload || undefined,
            shipping_fee_updated: hasShippingFeePayload || undefined,
            total_discount_updated: hasTotalDiscountPayload || undefined,
            bank_payments_updated: hasBankPaymentsPayload || undefined,
            surcharge_updated: hasSurchargePayload || undefined,
            processing: lockedForStatusUpdate,
            processing_started_at: lockedForStatusUpdate
              ? processingRequestedAt.toISOString()
              : undefined,
            processing_timeout_seconds: lockedForStatusUpdate
              ? this.getConfirmationUpdateProcessingTtlSeconds()
              : undefined,
            assigning_seller_included: true,
            queued: true,
            message: 'Order update already queued. Waiting for webhook callback.',
          };
        }
        throw new ServiceUnavailableException('Unable to queue order update right now. Please retry.');
      }

      return {
        accepted: true,
        shop_id: order.shopId,
        order_id: order.posOrderId,
        status: targetStatus ?? undefined,
        tags_count: targetTags?.length ?? undefined,
        items_count: targetItems?.length ?? undefined,
        note_updated: hasNotePayload || undefined,
        note_print_updated: hasNotePrintPayload || undefined,
        shipping_address_updated: hasShippingAddressPayload || undefined,
        shipping_fee_updated: hasShippingFeePayload || undefined,
        total_discount_updated: hasTotalDiscountPayload || undefined,
        bank_payments_updated: hasBankPaymentsPayload || undefined,
        surcharge_updated: hasSurchargePayload || undefined,
        processing: lockedForStatusUpdate,
        processing_started_at: lockedForStatusUpdate
          ? processingRequestedAt.toISOString()
          : undefined,
        processing_timeout_seconds: lockedForStatusUpdate
          ? this.getConfirmationUpdateProcessingTtlSeconds()
          : undefined,
        assigning_seller_included: true,
        queued: true,
        message: lockedForStatusUpdate
          ? 'Order update queued. Waiting for webhook callback.'
          : 'Order update queued.',
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (this.isTransientDbError(error)) {
        throw new ServiceUnavailableException(
          'Order update is temporarily busy. Please retry in a few seconds.',
        );
      }

      this.logger.error(
        `Failed to update confirmation order id=${orderRowId} targetStatus=${payload?.status ?? 'n/a'} targetTags=${Array.isArray(payload?.tags) ? payload.tags.length : 0} targetItems=${Array.isArray(payload?.items) ? payload.items.length : 0} targetNote=${Object.prototype.hasOwnProperty.call(payload, 'note') ? 1 : 0} targetNotePrint=${Object.prototype.hasOwnProperty.call(payload, 'note_print') ? 1 : 0} targetShippingAddress=${Object.prototype.hasOwnProperty.call(payload, 'shipping_address') ? 1 : 0} targetShippingFee=${Object.prototype.hasOwnProperty.call(payload, 'shipping_fee') ? 1 : 0} targetTotalDiscount=${Object.prototype.hasOwnProperty.call(payload, 'total_discount') ? 1 : 0} targetBankPayments=${Object.prototype.hasOwnProperty.call(payload, 'bank_payments') ? 1 : 0} targetSurcharge=${Object.prototype.hasOwnProperty.call(payload, 'surcharge') ? 1 : 0}: ${error?.message || 'Unknown error'}`,
        error?.stack,
      );
      throw new ServiceUnavailableException(
        'Order update failed due to a temporary server issue. Please retry.',
      );
    }
  }

  async processQueuedConfirmationOrderStatusUpdate(
    jobData: ConfirmationUpdateStatusJobData,
  ): Promise<{ success: boolean; reason: string }> {
    const hasStatusUpdate = typeof jobData.targetStatus === 'number';
    const hasTagsUpdate = Array.isArray(jobData.targetTags);
    const hasItemsUpdate = Array.isArray(jobData.targetItems);
    const hasNoteUpdate = typeof jobData.targetNote === 'string';
    const hasNotePrintUpdate = typeof jobData.targetNotePrint === 'string';
    const hasShippingAddressUpdate =
      !!jobData.targetShippingAddress &&
      typeof jobData.targetShippingAddress === 'object' &&
      !Array.isArray(jobData.targetShippingAddress);
    const hasShippingFeeUpdate = typeof jobData.targetShippingFee === 'number';
    const hasTotalDiscountUpdate = typeof jobData.targetTotalDiscount === 'number';
    const hasBankPaymentsUpdate = typeof jobData.targetBankPayments !== 'undefined';
    const hasSurchargeUpdate = typeof jobData.targetSurcharge === 'number';
    const allowedCurrentStatuses = Array.from(new Set(
      (Array.isArray(jobData.allowedCurrentStatuses) && jobData.allowedCurrentStatuses.length > 0
        ? jobData.allowedCurrentStatuses
        : [0]
      ).filter((status) => Number.isInteger(status)),
    ));

    if (
      !hasStatusUpdate &&
      !hasTagsUpdate &&
      !hasItemsUpdate &&
      !hasNoteUpdate &&
      !hasNotePrintUpdate &&
      !hasShippingAddressUpdate &&
      !hasShippingFeeUpdate &&
      !hasTotalDiscountUpdate &&
      !hasBankPaymentsUpdate &&
      !hasSurchargeUpdate
    ) {
      return { success: false, reason: 'NO_OPERATION' };
    }

    const order = await this.prisma.posOrder.findFirst({
      where: {
        id: jobData.orderRowId,
        tenantId: jobData.tenantId,
      },
      select: {
        id: true,
        shopId: true,
        posOrderId: true,
        status: true,
        confirmationUpdateTargetStatus: true,
        orderSnapshot: true,
      },
    });

    if (!order) {
      return { success: false, reason: 'ORDER_NOT_FOUND' };
    }

    if (order.shopId !== jobData.shopId || order.posOrderId !== jobData.posOrderId) {
      await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
      return { success: false, reason: 'ORDER_MISMATCH' };
    }

    if (hasStatusUpdate && order.status === jobData.targetStatus) {
      await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
      return { success: true, reason: 'STATUS_ALREADY_TARGET' };
    }

    if (!allowedCurrentStatuses.includes(order.status ?? Number.NaN)) {
      await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
      return {
        success: false,
        reason: allowedCurrentStatuses.length === 1 && allowedCurrentStatuses[0] === 0
          ? 'STATUS_NOT_NEW'
          : `STATUS_${order.status ?? 'NULL'}_NOT_ALLOWED`,
      };
    }

    const store = await this.prisma.posStore.findFirst({
      where: {
        tenantId: jobData.tenantId,
        shopId: jobData.shopId,
      },
      select: {
        id: true,
        integrationId: true,
        apiKey: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!store) {
      await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
      return { success: false, reason: 'STORE_NOT_FOUND' };
    }

    const apiKey = await this.resolveStoreApiKey(jobData.tenantId, {
      id: store.id,
      integrationId: store.integrationId || null,
      apiKey: store.apiKey || null,
    });
    if (!apiKey) {
      await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
      return { success: false, reason: 'MISSING_API_KEY' };
    }

    const shouldPreservePaymentFields =
      hasShippingAddressUpdate ||
      hasShippingFeeUpdate ||
      hasTotalDiscountUpdate ||
      hasBankPaymentsUpdate ||
      hasSurchargeUpdate;
    const preservedShippingFee =
      shouldPreservePaymentFields && !hasShippingFeeUpdate
        ? this.extractSnapshotAmount(order.orderSnapshot, 'shipping_fee')
        : undefined;
    const effectiveShippingFee =
      typeof jobData.targetShippingFee === 'number'
        ? jobData.targetShippingFee
        : preservedShippingFee;
    const preservedTotalDiscount =
      shouldPreservePaymentFields && !hasTotalDiscountUpdate
        ? this.extractSnapshotAmount(order.orderSnapshot, 'total_discount')
        : undefined;
    const effectiveTotalDiscount =
      typeof jobData.targetTotalDiscount === 'number'
        ? jobData.targetTotalDiscount
        : preservedTotalDiscount;
    const preservedSurcharge =
      shouldPreservePaymentFields && !hasSurchargeUpdate
        ? this.extractSnapshotAmount(order.orderSnapshot, 'surcharge')
        : undefined;
    const effectiveSurcharge =
      typeof jobData.targetSurcharge === 'number'
        ? jobData.targetSurcharge
        : preservedSurcharge;
    const preservedBankPaymentsField =
      shouldPreservePaymentFields && !hasBankPaymentsUpdate
        ? this.extractSnapshotField(order.orderSnapshot, 'bank_payments')
        : { exists: false, value: undefined };
    const hasEffectiveBankPayments = hasBankPaymentsUpdate || preservedBankPaymentsField.exists;
    const effectiveBankPayments = hasBankPaymentsUpdate
      ? jobData.targetBankPayments
      : preservedBankPaymentsField.value;

    const params = new URLSearchParams();
    params.set('api_key', apiKey);
    const requestBody: Record<string, unknown> = {
      assigning_seller: STATIC_ASSIGNING_SELLER_PAYLOAD,
      assigning_seller_id: STATIC_ASSIGNING_SELLER_PAYLOAD.id,
    };
    if (hasStatusUpdate) {
      requestBody.status = jobData.targetStatus;
    }
    if (hasTagsUpdate) {
      requestBody.tags = (jobData.targetTags || []).map((tag) => ({
        id: tag.id,
        name: tag.name,
      }));
    }
    if (hasItemsUpdate) {
      requestBody.items = (jobData.targetItems || []).map((item) => ({
        variation_id: item.variation_id,
        quantity: item.quantity,
      }));
    }
    if (hasNoteUpdate) {
      requestBody.note = jobData.targetNote || '';
    }
    if (hasNotePrintUpdate) {
      requestBody.note_print = jobData.targetNotePrint || '';
    }
    if (hasShippingAddressUpdate) {
      requestBody.shipping_address = jobData.targetShippingAddress;
    }
    if (typeof effectiveShippingFee === 'number') {
      requestBody.shipping_fee = effectiveShippingFee;
    }
    if (typeof effectiveTotalDiscount === 'number') {
      requestBody.total_discount = effectiveTotalDiscount;
    }
    if (hasEffectiveBankPayments) {
      requestBody.bank_payments = effectiveBankPayments;
    }
    if (typeof effectiveSurcharge === 'number') {
      requestBody.surcharge = effectiveSurcharge;
    }

    let response: Response;
    try {
      response = await fetch(
        `https://pos.pages.fm/api/v1/shops/${encodeURIComponent(jobData.shopId)}/orders/${encodeURIComponent(jobData.posOrderId)}?${params.toString()}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
      );
    } catch (error: any) {
      throw new BadGatewayException(
        error?.message || 'Failed to reach Pancake API',
      );
    }

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      const statusCode = response.status;

      if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
        await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
        return {
          success: false,
          reason: `UPSTREAM_CLIENT_ERROR_${statusCode}${responseText ? `:${responseText.slice(0, 120)}` : ''}`,
        };
      }

      throw new BadGatewayException(
        `Failed to update Pancake order (${statusCode})${responseText ? `: ${responseText.slice(0, 180)}` : ''}`,
      );
    }

    if (!hasStatusUpdate) {
      await this.clearConfirmationUpdateInFlight(order.id).catch(() => undefined);
    }

    const updates: string[] = [];
    if (hasStatusUpdate) updates.push('STATUS');
    if (hasTagsUpdate) updates.push('TAGS');
    if (hasItemsUpdate) updates.push('ITEMS');
    if (hasNoteUpdate) updates.push('NOTE');
    if (hasNotePrintUpdate) updates.push('NOTE_PRINT');
    if (hasShippingAddressUpdate) updates.push('SHIPPING_ADDRESS');
    if (hasShippingFeeUpdate) updates.push('SHIPPING_FEE');
    if (hasTotalDiscountUpdate) updates.push('TOTAL_DISCOUNT');
    if (hasBankPaymentsUpdate) updates.push('BANK_PAYMENTS');
    if (hasSurchargeUpdate) updates.push('SURCHARGE');

    return {
      success: true,
      reason: `${updates.join('_') || 'ORDER'}_UPDATE_SENT`,
    };
  }
}

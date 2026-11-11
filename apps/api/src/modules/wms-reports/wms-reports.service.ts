import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  IntegrationStatus,
  Prisma,
  TenantStatus,
  UserRole,
  UserStatus,
  WmsInventoryMovementType,
  WmsInventoryUnitStatus,
  WmsLocationKind,
  WmsProductProfileStatus,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GetWmsMonthEndStockReportDto } from './dto/get-wms-month-end-stock-report.dto';
import { GetWmsDailyInventoryMovementsDto } from './dto/get-wms-daily-inventory-movements.dto';
import { UpdateWmsDailyInventoryEmailSubscriptionDto } from './dto/wms-daily-inventory-email.dto';

dayjs.extend(utc);
dayjs.extend(timezone);

const MANILA_TZ = 'Asia/Manila';
const ACTIVE_TENANT_STATUSES = [TenantStatus.ACTIVE, TenantStatus.TRIAL] as const;
const NON_PHYSICAL_BIN_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.DISPATCHED,
  WmsInventoryUnitStatus.LOST,
  WmsInventoryUnitStatus.ARCHIVED,
]);
const NEGATIVE_ADJUSTMENT_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.DAMAGED,
  WmsInventoryUnitStatus.LOST,
  WmsInventoryUnitStatus.EXPIRED,
  WmsInventoryUnitStatus.DEADSTOCK,
  WmsInventoryUnitStatus.ARCHIVED,
]);
const RESTOCK_FROM_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.RTS,
  WmsInventoryUnitStatus.DISPATCHED,
  WmsInventoryUnitStatus.DAMAGED,
  WmsInventoryUnitStatus.LOST,
  WmsInventoryUnitStatus.EXPIRED,
  WmsInventoryUnitStatus.DEADSTOCK,
]);
const RESTOCK_TO_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.PUTAWAY,
  WmsInventoryUnitStatus.RECEIVED,
  WmsInventoryUnitStatus.STAGED,
]);

type StockAccumulator = {
  receivedQty: number;
  stagedQty: number;
  putAwayQty: number;
  reservedQty: number;
  inBinQty: number;
};

type StockReportTotals = StockAccumulator & {
  variantCount: number;
  awaitingPutAwayQty: number;
};

export type DailyInventoryEmailSubscriptionConfig = {
  enabled: boolean;
  recipients: string[];
  sendTimeManila: string;
  lastSentAt: string | null;
  lastSentDate: string | null;
  lastDeliveryStatus: string | null;
  lastDeliveryMode: string | null;
  lastError: string | null;
};

export type ClientDailyInventoryEmailSubscription = DailyInventoryEmailSubscriptionConfig & {
  tenantId: string;
  tenantName: string;
  defaultRecipients: string[];
  effectiveRecipients: string[];
};

export type DailyInventoryMovementRow = {
  rowId: string;
  tenantId: string;
  tenantName: string;
  storeId: string;
  storeName: string;
  shopId: string;
  productId: string;
  variationId: string | null;
  variantCode: string | null;
  variantDisplayId: string | null;
  variantName: string;
  receivedInQty: number;
  manualInQty: number;
  restockedInQty: number;
  totalInQty: number;
  putAwayMovedQty: number;
  dispatchedOutQty: number;
  packedOutQty: number;
  adjustedOutQty: number;
  totalOutQty: number;
  netChangeQty: number;
  receivedQty: number;
  stagedQty: number;
  awaitingPutAwayQty: number;
  putAwayQty: number;
  reservedQty: number;
  inBinQty: number;
  onHandQty: number;
  lastMovementAt: string | null;
};

export type DailyInventoryMovementEventItem = {
  id: string;
  createdAt: string;
  tenantId: string;
  tenantName: string;
  storeId: string;
  storeName: string;
  variantName: string;
  variantCode: string | null;
  unitCode: string;
  movementType: WmsInventoryMovementType;
  direction: 'IN' | 'OUT' | 'INTERNAL';
  fromStatus: WmsInventoryUnitStatus | null;
  toStatus: WmsInventoryUnitStatus | null;
  fromLocationCode: string | null;
  toLocationCode: string | null;
  referenceCode: string | null;
  notes: string | null;
  actorName: string | null;
};

export type DailyInventoryMovementsReportTotals = {
  variantCount: number;
  activeMovedVariantCount: number;
  receivedInQty: number;
  manualInQty: number;
  restockedInQty: number;
  totalInQty: number;
  putAwayMovedQty: number;
  dispatchedOutQty: number;
  packedOutQty: number;
  adjustedOutQty: number;
  totalOutQty: number;
  netChangeQty: number;
  receivedQty: number;
  stagedQty: number;
  awaitingPutAwayQty: number;
  putAwayQty: number;
  reservedQty: number;
  inBinQty: number;
  onHandQty: number;
};

@Injectable()
export class WmsReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  getManilaTodayDateString(): string {
    return dayjs().tz(MANILA_TZ).format('YYYY-MM-DD');
  }

  normalizeDateWindow(query: { date?: string; startDate?: string; endDate?: string }) {
    const today = this.getManilaTodayDateString();
    const rawStart = query.startDate?.trim() || query.date?.trim() || today;
    const rawEnd = query.endDate?.trim() || query.date?.trim() || rawStart;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawStart) || !/^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) {
      throw new BadRequestException('Dates must use YYYY-MM-DD format');
    }
    if (rawEnd < rawStart) {
      throw new BadRequestException('startDate must be before or equal to endDate');
    }

    const startUtc = dayjs.tz(`${rawStart} 00:00:00.000`, MANILA_TZ).toDate();
    const endUtc = dayjs.tz(`${rawEnd} 23:59:59.999`, MANILA_TZ).toDate();

    return {
      startDate: rawStart,
      endDate: rawEnd,
      startUtc,
      endUtc,
    };
  }

  async getMonthEndStockReport(query: GetWmsMonthEndStockReportDto) {
    const scope = await this.resolveScope(query);
    const reportStoreIds = scope.reportStores.map((store) => store.id);

    if (reportStoreIds.length === 0) {
      return this.buildResponse(scope, [], new Date());
    }

    const [products, groupedUnits, inBinGroups] = await Promise.all([
      this.prisma.posProduct.findMany({
        where: {
          storeId: { in: reportStoreIds },
          wmsProductProfile: {
            is: { status: { not: WmsProductProfileStatus.ARCHIVED } },
          },
        },
        select: {
          id: true,
          storeId: true,
          productId: true,
          variationId: true,
          customId: true,
          name: true,
          productSnapshot: true,
        },
        orderBy: [{ storeId: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.wmsInventoryUnit.groupBy({
        by: ['posProductId', 'status'],
        where: { storeId: { in: reportStoreIds } },
        _count: { _all: true },
      }),
      this.prisma.wmsInventoryUnit.groupBy({
        by: ['posProductId'],
        where: {
          storeId: { in: reportStoreIds },
          currentLocation: { is: { kind: WmsLocationKind.BIN } },
          status: { notIn: Array.from(NON_PHYSICAL_BIN_STATUSES) },
        },
        _count: { _all: true },
      }),
    ]);

    const inBinQtyByProduct = new Map(
      inBinGroups.map((group) => [group.posProductId, group._count._all]),
    );

    const quantitiesByProduct = new Map<string, StockAccumulator>();
    for (const group of groupedUnits) {
      const quantities = quantitiesByProduct.get(group.posProductId) ?? {
        receivedQty: 0,
        stagedQty: 0,
        putAwayQty: 0,
        reservedQty: 0,
        inBinQty: 0,
      };
      const quantity = group._count._all;

      if (group.status === WmsInventoryUnitStatus.RECEIVED) quantities.receivedQty += quantity;
      if (group.status === WmsInventoryUnitStatus.STAGED) quantities.stagedQty += quantity;
      if (group.status === WmsInventoryUnitStatus.PUTAWAY) quantities.putAwayQty += quantity;
      if (group.status === WmsInventoryUnitStatus.RESERVED) quantities.reservedQty += quantity;
      quantitiesByProduct.set(group.posProductId, quantities);
    }

    for (const [posProductId, inBinQty] of inBinQtyByProduct) {
      const quantities = quantitiesByProduct.get(posProductId) ?? {
        receivedQty: 0,
        stagedQty: 0,
        putAwayQty: 0,
        reservedQty: 0,
        inBinQty: 0,
      };
      quantities.inBinQty = inBinQty;
      quantitiesByProduct.set(posProductId, quantities);
    }

    const storeById = new Map(scope.reportStores.map((store) => [store.id, store]));
    const rows = products.map((product) => {
      const store = storeById.get(product.storeId)!;
      const quantities = quantitiesByProduct.get(product.id) ?? {
        receivedQty: 0,
        stagedQty: 0,
        putAwayQty: 0,
        reservedQty: 0,
        inBinQty: 0,
      };
      const snapshot = product.productSnapshot as {
        display_id?: string | null;
        product?: { display_id?: string | null } | null;
      } | null;

      return {
        rowId: `${product.storeId}:${product.id}`,
        tenantId: store.tenantId,
        tenantName: store.tenant.name,
        storeId: store.id,
        storeName: store.shopName || store.name,
        shopId: store.shopId,
        productId: product.productId,
        variationId: product.variationId,
        variantCode: product.customId,
        variantDisplayId: snapshot?.display_id ?? snapshot?.product?.display_id ?? null,
        variantName: product.name,
        ...quantities,
        awaitingPutAwayQty: quantities.receivedQty + quantities.stagedQty,
      };
    });

    rows.sort((left, right) => (
      left.tenantName.localeCompare(right.tenantName)
      || left.storeName.localeCompare(right.storeName)
      || left.variantName.localeCompare(right.variantName)
    ));

    return this.buildResponse(scope, rows, new Date());
  }

  async getDailyInventoryMovementsReport(
    query: GetWmsDailyInventoryMovementsDto,
    options?: { bypassClsForCron?: boolean },
  ) {
    const scope = await this.resolveScope(query, options);
    const window = this.normalizeDateWindow(query);
    const reportStoreIds = scope.reportStores.map((store) => store.id);
    const subscriptions = await this.getSubscriptionsForTenants(
      scope.partners.map((partner) => partner.id),
    );

    if (reportStoreIds.length === 0) {
      return this.buildDailyMovementsResponse(
        scope,
        window,
        [],
        [],
        subscriptions,
        new Date(),
      );
    }

    const [products, groupedUnits, inBinGroups, movements] = await Promise.all([
      this.prisma.posProduct.findMany({
        where: {
          storeId: { in: reportStoreIds },
          wmsProductProfile: {
            is: { status: { not: WmsProductProfileStatus.ARCHIVED } },
          },
        },
        select: {
          id: true,
          storeId: true,
          productId: true,
          variationId: true,
          customId: true,
          name: true,
          productSnapshot: true,
        },
        orderBy: [{ storeId: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.wmsInventoryUnit.groupBy({
        by: ['posProductId', 'status'],
        where: { storeId: { in: reportStoreIds } },
        _count: { _all: true },
      }),
      this.prisma.wmsInventoryUnit.groupBy({
        by: ['posProductId'],
        where: {
          storeId: { in: reportStoreIds },
          currentLocation: { is: { kind: WmsLocationKind.BIN } },
          status: { notIn: Array.from(NON_PHYSICAL_BIN_STATUSES) },
        },
        _count: { _all: true },
      }),
      this.prisma.wmsInventoryMovement.findMany({
        where: {
          createdAt: {
            gte: window.startUtc,
            lte: window.endUtc,
          },
          inventoryUnit: {
            is: {
              storeId: { in: reportStoreIds },
            },
          },
        },
        include: {
          inventoryUnit: {
            select: {
              id: true,
              code: true,
              storeId: true,
              posProductId: true,
              productId: true,
              variationId: true,
              posProduct: {
                select: {
                  id: true,
                  name: true,
                  customId: true,
                  productSnapshot: true,
                },
              },
            },
          },
          fromLocation: {
            select: { code: true, name: true },
          },
          toLocation: {
            select: { code: true, name: true },
          },
          actor: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
    ]);

    const inBinQtyByProduct = new Map(
      inBinGroups.map((group) => [group.posProductId, group._count._all]),
    );

    const quantitiesByProduct = new Map<string, StockAccumulator>();
    for (const group of groupedUnits) {
      const quantities = quantitiesByProduct.get(group.posProductId) ?? {
        receivedQty: 0,
        stagedQty: 0,
        putAwayQty: 0,
        reservedQty: 0,
        inBinQty: 0,
      };
      const quantity = group._count._all;

      if (group.status === WmsInventoryUnitStatus.RECEIVED) quantities.receivedQty += quantity;
      if (group.status === WmsInventoryUnitStatus.STAGED) quantities.stagedQty += quantity;
      if (group.status === WmsInventoryUnitStatus.PUTAWAY) quantities.putAwayQty += quantity;
      if (
        group.status === WmsInventoryUnitStatus.RESERVED
        || group.status === WmsInventoryUnitStatus.PICKED
        || group.status === WmsInventoryUnitStatus.PACKED
      ) {
        quantities.reservedQty += quantity;
      }
      quantitiesByProduct.set(group.posProductId, quantities);
    }

    for (const [posProductId, inBinQty] of inBinQtyByProduct) {
      const quantities = quantitiesByProduct.get(posProductId) ?? {
        receivedQty: 0,
        stagedQty: 0,
        putAwayQty: 0,
        reservedQty: 0,
        inBinQty: 0,
      };
      quantities.inBinQty = inBinQty;
      quantitiesByProduct.set(posProductId, quantities);
    }

    type MovementUnitBuckets = {
      receivedUnits: Set<string>;
      manualUnits: Set<string>;
      restockedUnits: Set<string>;
      putAwayUnits: Set<string>;
      dispatchedUnits: Set<string>;
      packedUnits: Set<string>;
      adjustedOutUnits: Set<string>;
      lastMovementAt: Date | null;
    };

    const movementBucketsByProduct = new Map<string, MovementUnitBuckets>();
    const productById = new Map(products.map((product) => [product.id, product]));

    for (const movement of movements) {
      const unit = movement.inventoryUnit;
      const posProductId = unit.posProductId;

      if (!productById.has(posProductId) && unit.posProduct) {
        productById.set(posProductId, {
          id: posProductId,
          storeId: unit.storeId,
          productId: unit.productId,
          variationId: unit.variationId,
          customId: unit.posProduct.customId,
          name: unit.posProduct.name,
          productSnapshot: unit.posProduct.productSnapshot,
        });
      }

      let bucket = movementBucketsByProduct.get(posProductId);
      if (!bucket) {
        bucket = {
          receivedUnits: new Set<string>(),
          manualUnits: new Set<string>(),
          restockedUnits: new Set<string>(),
          putAwayUnits: new Set<string>(),
          dispatchedUnits: new Set<string>(),
          packedUnits: new Set<string>(),
          adjustedOutUnits: new Set<string>(),
          lastMovementAt: null,
        };
        movementBucketsByProduct.set(posProductId, bucket);
      }

      if (!bucket.lastMovementAt || movement.createdAt > bucket.lastMovementAt) {
        bucket.lastMovementAt = movement.createdAt;
      }

      const direction = this.classifyMovementDirection(movement);
      if (movement.movementType === WmsInventoryMovementType.RECEIPT) {
        bucket.receivedUnits.add(unit.id);
      } else if (movement.movementType === WmsInventoryMovementType.MANUAL_RECEIPT) {
        bucket.manualUnits.add(unit.id);
      } else if (direction === 'IN') {
        bucket.restockedUnits.add(unit.id);
      }

      if (
        movement.movementType === WmsInventoryMovementType.PUTAWAY
        || movement.toStatus === WmsInventoryUnitStatus.PUTAWAY
      ) {
        bucket.putAwayUnits.add(unit.id);
      }

      if (
        movement.movementType === WmsInventoryMovementType.DISPATCH
        || movement.toStatus === WmsInventoryUnitStatus.DISPATCHED
      ) {
        bucket.dispatchedUnits.add(unit.id);
      } else if (
        movement.movementType === WmsInventoryMovementType.PACK
        || movement.movementType === WmsInventoryMovementType.PICK
        || movement.toStatus === WmsInventoryUnitStatus.PACKED
        || movement.toStatus === WmsInventoryUnitStatus.PICKED
      ) {
        bucket.packedUnits.add(unit.id);
      } else if (direction === 'OUT') {
        bucket.adjustedOutUnits.add(unit.id);
      }
    }

    const storeById = new Map(scope.reportStores.map((store) => [store.id, store]));
    const rows: DailyInventoryMovementRow[] = [];

    for (const product of productById.values()) {
      const store = storeById.get(product.storeId);
      if (!store) continue;

      const quantities = quantitiesByProduct.get(product.id) ?? {
        receivedQty: 0,
        stagedQty: 0,
        putAwayQty: 0,
        reservedQty: 0,
        inBinQty: 0,
      };
      const bucket = movementBucketsByProduct.get(product.id);

      const receivedInQty = bucket ? bucket.receivedUnits.size : 0;
      const manualInQty = bucket
        ? Array.from(bucket.manualUnits).filter((id) => !bucket.receivedUnits.has(id)).length
        : 0;
      const restockedInQty = bucket
        ? Array.from(bucket.restockedUnits).filter(
            (id) => !bucket.receivedUnits.has(id) && !bucket.manualUnits.has(id),
          ).length
        : 0;
      const totalInQty = receivedInQty + manualInQty + restockedInQty;
      const putAwayMovedQty = bucket ? bucket.putAwayUnits.size : 0;

      const dispatchedOutQty = bucket ? bucket.dispatchedUnits.size : 0;
      const packedOutQty = bucket
        ? Array.from(bucket.packedUnits).filter((id) => !bucket.dispatchedUnits.has(id)).length
        : 0;
      const adjustedOutQty = bucket
        ? Array.from(bucket.adjustedOutUnits).filter(
            (id) => !bucket.dispatchedUnits.has(id) && !bucket.packedUnits.has(id),
          ).length
        : 0;
      const totalOutQty = dispatchedOutQty + packedOutQty + adjustedOutQty;
      const netChangeQty = totalInQty - totalOutQty;

      const awaitingPutAwayQty = quantities.receivedQty + quantities.stagedQty;
      const onHandQty = quantities.inBinQty + awaitingPutAwayQty + quantities.reservedQty;

      const snapshot = product.productSnapshot as {
        display_id?: string | null;
        product?: { display_id?: string | null } | null;
      } | null;

      rows.push({
        rowId: `${product.storeId}:${product.id}`,
        tenantId: store.tenantId,
        tenantName: store.tenant.name,
        storeId: store.id,
        storeName: store.shopName || store.name,
        shopId: store.shopId,
        productId: product.productId,
        variationId: product.variationId,
        variantCode: product.customId,
        variantDisplayId: snapshot?.display_id ?? snapshot?.product?.display_id ?? null,
        variantName: product.name,
        receivedInQty,
        manualInQty,
        restockedInQty,
        totalInQty,
        putAwayMovedQty,
        dispatchedOutQty,
        packedOutQty,
        adjustedOutQty,
        totalOutQty,
        netChangeQty,
        receivedQty: quantities.receivedQty,
        stagedQty: quantities.stagedQty,
        awaitingPutAwayQty,
        putAwayQty: quantities.putAwayQty,
        reservedQty: quantities.reservedQty,
        inBinQty: quantities.inBinQty,
        onHandQty,
        lastMovementAt: bucket?.lastMovementAt ? bucket.lastMovementAt.toISOString() : null,
      });
    }

    rows.sort((left, right) => {
      const leftMoved = left.totalInQty + left.totalOutQty + left.putAwayMovedQty > 0 ? 1 : 0;
      const rightMoved = right.totalInQty + right.totalOutQty + right.putAwayMovedQty > 0 ? 1 : 0;
      if (leftMoved !== rightMoved) return rightMoved - leftMoved;
      return (
        left.tenantName.localeCompare(right.tenantName)
        || left.storeName.localeCompare(right.storeName)
        || left.variantName.localeCompare(right.variantName)
      );
    });

    const recentMovements: DailyInventoryMovementEventItem[] = movements
      .slice(0, 150)
      .map((movement) => {
        const store = storeById.get(movement.inventoryUnit.storeId);
        const actorName = movement.actor
          ? [movement.actor.firstName, movement.actor.lastName].filter(Boolean).join(' ')
            || movement.actor.email
          : null;
        return {
          id: movement.id,
          createdAt: movement.createdAt.toISOString(),
          tenantId: movement.tenantId,
          tenantName: store?.tenant.name ?? 'Client',
          storeId: movement.inventoryUnit.storeId,
          storeName: store ? store.shopName || store.name : 'Store',
          variantName: movement.inventoryUnit.posProduct?.name ?? 'Product',
          variantCode: movement.inventoryUnit.posProduct?.customId ?? null,
          unitCode: movement.inventoryUnit.code,
          movementType: movement.movementType,
          direction: this.classifyMovementDirection(movement),
          fromStatus: movement.fromStatus,
          toStatus: movement.toStatus,
          fromLocationCode: movement.fromLocation?.code ?? null,
          toLocationCode: movement.toLocation?.code ?? null,
          referenceCode: movement.referenceCode ?? null,
          notes: movement.notes ?? null,
          actorName,
        };
      });

    return this.buildDailyMovementsResponse(
      scope,
      window,
      rows,
      recentMovements,
      subscriptions,
      new Date(),
    );
  }

  classifyMovementDirection(movement: {
    movementType: WmsInventoryMovementType;
    fromStatus: WmsInventoryUnitStatus | null;
    toStatus: WmsInventoryUnitStatus | null;
  }): 'IN' | 'OUT' | 'INTERNAL' {
    if (
      movement.movementType === WmsInventoryMovementType.RECEIPT
      || movement.movementType === WmsInventoryMovementType.MANUAL_RECEIPT
    ) {
      return 'IN';
    }
    if (
      movement.fromStatus
      && movement.toStatus
      && RESTOCK_FROM_STATUSES.has(movement.fromStatus)
      && RESTOCK_TO_STATUSES.has(movement.toStatus)
    ) {
      return 'IN';
    }
    if (
      movement.movementType === WmsInventoryMovementType.DISPATCH
      || movement.movementType === WmsInventoryMovementType.PACK
      || movement.movementType === WmsInventoryMovementType.PICK
      || movement.toStatus === WmsInventoryUnitStatus.DISPATCHED
      || movement.toStatus === WmsInventoryUnitStatus.PACKED
      || movement.toStatus === WmsInventoryUnitStatus.PICKED
    ) {
      return 'OUT';
    }
    if (
      movement.movementType === WmsInventoryMovementType.ADJUSTMENT
      && movement.toStatus
      && NEGATIVE_ADJUSTMENT_STATUSES.has(movement.toStatus)
    ) {
      return 'OUT';
    }
    return 'INTERNAL';
  }

  async getSubscriptionsForTenants(
    tenantIds: string[],
  ): Promise<ClientDailyInventoryEmailSubscription[]> {
    if (tenantIds.length === 0) return [];

    const [tenants, adminUsers] = await Promise.all([
      this.prisma.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: {
          id: true,
          name: true,
          billingEmail: true,
          settings: true,
        },
        orderBy: [{ name: 'asc' }],
      }),
      this.prisma.user.findMany({
        where: {
          tenantId: { in: tenantIds },
          status: UserStatus.ACTIVE,
        },
        select: {
          tenantId: true,
          email: true,
          role: true,
        },
        orderBy: [{ createdAt: 'asc' }],
      }),
    ]);

    const emailsByTenant = new Map<string, string[]>();
    for (const user of adminUsers) {
      if (!user.tenantId || !user.email) continue;
      const list = emailsByTenant.get(user.tenantId) ?? [];
      if (user.role === UserRole.ADMIN || list.length < 3) {
        if (!list.includes(user.email.toLowerCase())) {
          list.push(user.email.toLowerCase());
        }
      }
      emailsByTenant.set(user.tenantId, list);
    }

    return tenants.map((tenant) => {
      const parsed = this.extractSubscriptionFromSettings(tenant.settings);
      const defaultRecipients = Array.from(
        new Set(
          [
            ...(tenant.billingEmail ? [tenant.billingEmail.trim().toLowerCase()] : []),
            ...(emailsByTenant.get(tenant.id) ?? []),
          ].filter(Boolean),
        ),
      );
      const effectiveRecipients =
        parsed.recipients.length > 0 ? parsed.recipients : defaultRecipients;

      return {
        tenantId: tenant.id,
        tenantName: tenant.name,
        ...parsed,
        defaultRecipients,
        effectiveRecipients,
      };
    });
  }

  extractSubscriptionFromSettings(
    settingsValue: Prisma.JsonValue | null | undefined,
  ): DailyInventoryEmailSubscriptionConfig {
    const root =
      settingsValue && typeof settingsValue === 'object' && !Array.isArray(settingsValue)
        ? (settingsValue as Record<string, unknown>)
        : {};
    const raw =
      root.dailyInventoryReport
      && typeof root.dailyInventoryReport === 'object'
      && !Array.isArray(root.dailyInventoryReport)
        ? (root.dailyInventoryReport as Record<string, unknown>)
        : {};

    const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true;
    const recipients = Array.isArray(raw.recipients)
      ? Array.from(
          new Set(
            raw.recipients
              .map((entry) => String(entry).trim().toLowerCase())
              .filter(Boolean),
          ),
        )
      : [];
    const sendTimeManila =
      typeof raw.sendTimeManila === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.sendTimeManila)
        ? raw.sendTimeManila
        : '20:00';

    return {
      enabled,
      recipients,
      sendTimeManila,
      lastSentAt: typeof raw.lastSentAt === 'string' ? raw.lastSentAt : null,
      lastSentDate: typeof raw.lastSentDate === 'string' ? raw.lastSentDate : null,
      lastDeliveryStatus:
        typeof raw.lastDeliveryStatus === 'string' ? raw.lastDeliveryStatus : null,
      lastDeliveryMode: typeof raw.lastDeliveryMode === 'string' ? raw.lastDeliveryMode : null,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    };
  }

  async updateDailyEmailSubscription(dto: UpdateWmsDailyInventoryEmailSubscriptionDto) {
    const targetTenantId = this.resolveTargetTenantId(dto.tenantId);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: targetTenantId },
      select: { id: true, name: true, settings: true },
    });
    if (!tenant) {
      throw new NotFoundException('Client not found');
    }

    const existingRoot =
      tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings)
        ? (tenant.settings as Record<string, unknown>)
        : {};
    const current = this.extractSubscriptionFromSettings(tenant.settings);

    const nextConfig: DailyInventoryEmailSubscriptionConfig = {
      ...current,
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.recipients !== undefined ? { recipients: dto.recipients } : {}),
      ...(dto.sendTimeManila !== undefined ? { sendTimeManila: dto.sendTimeManila } : {}),
    };

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        settings: {
          ...existingRoot,
          dailyInventoryReport: nextConfig,
        } as Prisma.InputJsonValue,
      },
    });

    const [updatedSubscription] = await this.getSubscriptionsForTenants([tenant.id]);
    return {
      subscription: updatedSubscription,
    };
  }

  async recordDailyEmailDeliveryResult(
    tenantId: string,
    result: {
      sentDate: string;
      sentAt: string;
      status: string;
      mode: string;
      error?: string | null;
    },
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, settings: true },
    });
    if (!tenant) return;

    const existingRoot =
      tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings)
        ? (tenant.settings as Record<string, unknown>)
        : {};
    const current = this.extractSubscriptionFromSettings(tenant.settings);

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        settings: {
          ...existingRoot,
          dailyInventoryReport: {
            ...current,
            lastSentAt: result.sentAt,
            lastSentDate: result.sentDate,
            lastDeliveryStatus: result.status,
            lastDeliveryMode: result.mode,
            lastError: result.error ?? null,
          },
        } as Prisma.InputJsonValue,
      },
    });
  }

  resolveTargetTenantId(requestedTenantId?: string): string {
    const clsTenantId = this.cls.get('tenantId') as string | undefined;
    const userRole = this.cls.get('userRole') as string | undefined;
    const isGlobalUser = userRole === 'SUPER_ADMIN' || this.cls.get('wmsGlobalAccess') === true;

    if (!isGlobalUser) {
      if (!clsTenantId) {
        throw new ForbiddenException('Client context is required');
      }
      if (requestedTenantId && requestedTenantId !== clsTenantId) {
        throw new ForbiddenException('Selected client is outside your scope');
      }
      return clsTenantId;
    }

    const target = requestedTenantId || clsTenantId;
    if (!target) {
      throw new BadRequestException('Please select a client first');
    }
    return target;
  }

  private async resolveScope(
    query: { tenantIds?: string[]; storeIds?: string[] },
    options?: { bypassClsForCron?: boolean },
  ) {
    const clsTenantId = this.cls.get('tenantId') as string | undefined;
    const userRole = this.cls.get('userRole') as string | undefined;
    const isGlobalUser =
      options?.bypassClsForCron === true
      || userRole === 'SUPER_ADMIN'
      || this.cls.get('wmsGlobalAccess') === true;
    const requestedTenantIds = Array.from(new Set(query.tenantIds ?? []));
    const requestedStoreIds = Array.from(new Set(query.storeIds ?? []));

    if (!isGlobalUser && !clsTenantId) {
      throw new ForbiddenException('Partner context is required for WMS reports');
    }
    if (!isGlobalUser && requestedTenantIds.some((tenantId) => tenantId !== clsTenantId)) {
      throw new ForbiddenException('One or more selected partners are outside your WMS scope');
    }

    const accessibleTenantWhere = isGlobalUser ? {} : { id: clsTenantId };
    const partners = await this.prisma.tenant.findMany({
      where: {
        ...accessibleTenantWhere,
        status: { in: [...ACTIVE_TENANT_STATUSES] },
      },
      select: { id: true, name: true, slug: true },
      orderBy: [{ name: 'asc' }],
    });
    const accessibleTenantIds = new Set(partners.map((partner) => partner.id));

    if (requestedTenantIds.some((tenantId) => !accessibleTenantIds.has(tenantId))) {
      throw new ForbiddenException('One or more selected partners are outside your WMS scope');
    }

    const stores = await this.prisma.posStore.findMany({
      where: {
        tenantId: { in: partners.map((partner) => partner.id) },
        status: IntegrationStatus.ACTIVE,
      },
      select: {
        id: true,
        tenantId: true,
        shopId: true,
        name: true,
        shopName: true,
        tenant: { select: { name: true } },
      },
      orderBy: [{ tenant: { name: 'asc' } }, { shopName: 'asc' }, { name: 'asc' }],
    });

    const selectedTenantIds = requestedTenantIds.length > 0
      ? new Set(requestedTenantIds)
      : accessibleTenantIds;
    const storesInSelectedPartners = stores.filter((store) => selectedTenantIds.has(store.tenantId));
    const storesInSelectedPartnersById = new Map(
      storesInSelectedPartners.map((store) => [store.id, store]),
    );

    if (requestedStoreIds.some((storeId) => !storesInSelectedPartnersById.has(storeId))) {
      throw new ForbiddenException('One or more selected stores are outside the selected partner scope');
    }

    return {
      partners,
      stores,
      selectedTenantIds: requestedTenantIds,
      selectedStoreIds: requestedStoreIds,
      reportStores: requestedStoreIds.length > 0
        ? requestedStoreIds.map((storeId) => storesInSelectedPartnersById.get(storeId)!)
        : storesInSelectedPartners,
    };
  }

  private buildResponse(
    scope: Awaited<ReturnType<WmsReportsService['resolveScope']>>,
    rows: Array<{
      receivedQty: number;
      stagedQty: number;
      putAwayQty: number;
      reservedQty: number;
      inBinQty: number;
      awaitingPutAwayQty: number;
      [key: string]: unknown;
    }>,
    generatedAt: Date,
  ) {
    const totals = rows.reduce<StockReportTotals>(
      (total, row) => ({
        variantCount: total.variantCount + 1,
        receivedQty: total.receivedQty + row.receivedQty,
        stagedQty: total.stagedQty + row.stagedQty,
        awaitingPutAwayQty: total.awaitingPutAwayQty + row.awaitingPutAwayQty,
        putAwayQty: total.putAwayQty + row.putAwayQty,
        reservedQty: total.reservedQty + row.reservedQty,
        inBinQty: total.inBinQty + row.inBinQty,
      }),
      {
        variantCount: 0,
        receivedQty: 0,
        stagedQty: 0,
        awaitingPutAwayQty: 0,
        putAwayQty: 0,
        reservedQty: 0,
        inBinQty: 0,
      },
    );

    return {
      report: {
        key: 'MONTH_END_STOCK',
        label: 'Month-End Stock Report',
        generatedAt: generatedAt.toISOString(),
        basis: 'CURRENT_WMS_SNAPSHOT',
      },
      filters: {
        partners: scope.partners.map((partner) => ({
          id: partner.id,
          name: partner.name,
          slug: partner.slug,
        })),
        stores: scope.stores.map((store) => ({
          id: store.id,
          tenantId: store.tenantId,
          tenantName: store.tenant.name,
          shopId: store.shopId,
          name: store.shopName || store.name,
        })),
        selectedTenantIds: scope.selectedTenantIds,
        selectedStoreIds: scope.selectedStoreIds,
        effectiveStoreIds: scope.reportStores.map((store) => store.id),
      },
      totals,
      rows,
    };
  }

  private buildDailyMovementsResponse(
    scope: Awaited<ReturnType<WmsReportsService['resolveScope']>>,
    window: { startDate: string; endDate: string; startUtc: Date; endUtc: Date },
    rows: DailyInventoryMovementRow[],
    recentMovements: DailyInventoryMovementEventItem[],
    subscriptions: ClientDailyInventoryEmailSubscription[],
    generatedAt: Date,
  ) {
    const totals = rows.reduce<DailyInventoryMovementsReportTotals>(
      (acc, row) => ({
        variantCount: acc.variantCount + 1,
        activeMovedVariantCount:
          acc.activeMovedVariantCount
          + (row.totalInQty + row.totalOutQty + row.putAwayMovedQty > 0 ? 1 : 0),
        receivedInQty: acc.receivedInQty + row.receivedInQty,
        manualInQty: acc.manualInQty + row.manualInQty,
        restockedInQty: acc.restockedInQty + row.restockedInQty,
        totalInQty: acc.totalInQty + row.totalInQty,
        putAwayMovedQty: acc.putAwayMovedQty + row.putAwayMovedQty,
        dispatchedOutQty: acc.dispatchedOutQty + row.dispatchedOutQty,
        packedOutQty: acc.packedOutQty + row.packedOutQty,
        adjustedOutQty: acc.adjustedOutQty + row.adjustedOutQty,
        totalOutQty: acc.totalOutQty + row.totalOutQty,
        netChangeQty: acc.netChangeQty + row.netChangeQty,
        receivedQty: acc.receivedQty + row.receivedQty,
        stagedQty: acc.stagedQty + row.stagedQty,
        awaitingPutAwayQty: acc.awaitingPutAwayQty + row.awaitingPutAwayQty,
        putAwayQty: acc.putAwayQty + row.putAwayQty,
        reservedQty: acc.reservedQty + row.reservedQty,
        inBinQty: acc.inBinQty + row.inBinQty,
        onHandQty: acc.onHandQty + row.onHandQty,
      }),
      {
        variantCount: 0,
        activeMovedVariantCount: 0,
        receivedInQty: 0,
        manualInQty: 0,
        restockedInQty: 0,
        totalInQty: 0,
        putAwayMovedQty: 0,
        dispatchedOutQty: 0,
        packedOutQty: 0,
        adjustedOutQty: 0,
        totalOutQty: 0,
        netChangeQty: 0,
        receivedQty: 0,
        stagedQty: 0,
        awaitingPutAwayQty: 0,
        putAwayQty: 0,
        reservedQty: 0,
        inBinQty: 0,
        onHandQty: 0,
      },
    );

    const selectedTenantSet = new Set(scope.selectedTenantIds);
    const relevantSubscriptions =
      selectedTenantSet.size > 0
        ? subscriptions.filter((sub) => selectedTenantSet.has(sub.tenantId))
        : subscriptions;

    return {
      report: {
        key: 'DAILY_INVENTORY_INS_OUTS',
        label: 'Daily Inventory Ins & Outs Report',
        generatedAt: generatedAt.toISOString(),
        startDate: window.startDate,
        endDate: window.endDate,
        timezone: MANILA_TZ,
      },
      filters: {
        partners: scope.partners.map((partner) => ({
          id: partner.id,
          name: partner.name,
          slug: partner.slug,
        })),
        stores: scope.stores.map((store) => ({
          id: store.id,
          tenantId: store.tenantId,
          tenantName: store.tenant.name,
          shopId: store.shopId,
          name: store.shopName || store.name,
        })),
        selectedTenantIds: scope.selectedTenantIds,
        selectedStoreIds: scope.selectedStoreIds,
        effectiveStoreIds: scope.reportStores.map((store) => store.id),
      },
      totals,
      rows,
      recentMovements,
      subscriptions: relevantSubscriptions,
    };
  }
}

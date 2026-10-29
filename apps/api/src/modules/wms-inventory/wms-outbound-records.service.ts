import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  IntegrationStatus,
  Prisma,
  TenantStatus,
  WmsFulfillmentAssignmentMode,
  WmsFulfillmentOrderStatus,
  WmsInventoryMovementType,
  WmsOutboundUnitStatus,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GetWmsOutboundRecordsDto } from './dto/get-wms-outbound-records.dto';

const ACTIVE_WMS_TENANT_STATUSES = [TenantStatus.ACTIVE, TenantStatus.TRIAL] as const;
const OUTBOUND_STATUS_ORDER = [
  WmsOutboundUnitStatus.SHIPPED,
  WmsOutboundUnitStatus.DELIVERED,
  WmsOutboundUnitStatus.RETURNING,
  WmsOutboundUnitStatus.RETURNED,
] as const;
const POS_TO_OUTBOUND_STATUS: Record<number, WmsOutboundUnitStatus | undefined> = {
  2: WmsOutboundUnitStatus.SHIPPED,
  3: WmsOutboundUnitStatus.DELIVERED,
  4: WmsOutboundUnitStatus.RETURNING,
  5: WmsOutboundUnitStatus.RETURNED,
};
const DEFAULT_PAGE_SIZE = 20;
const MAX_DATE_RANGE_DAYS = 366;

const projectionOrderSelect = Prisma.validator<Prisma.WmsFulfillmentOrderSelect>()({
  id: true,
  posOrderDbId: true,
  tenantId: true,
  storeId: true,
  assignmentMode: true,
  posOrder: {
    select: {
      status: true,
      statusHistory: true,
      deliveredAt: true,
      rtsAt: true,
      tracking: true,
      updatedAt: true,
      orderSnapshot: true,
    },
  },
  basketUnits: {
    where: {
      packedAt: { not: null },
    },
    select: {
      fulfillmentLineId: true,
      inventoryUnit: {
        select: {
          id: true,
          warehouseId: true,
          productProfileId: true,
        },
      },
    },
  },
  reservations: {
    where: {
      pickedAt: { not: null },
    },
    select: {
      fulfillmentLineId: true,
      inventoryUnit: {
        select: {
          id: true,
          warehouseId: true,
          productProfileId: true,
        },
      },
    },
  },
});

type ProjectionOrder = Prisma.WmsFulfillmentOrderGetPayload<{
  select: typeof projectionOrderSelect;
}>;

type ProjectionUnit = {
  fulfillmentLineId: string | null;
  inventoryUnit: {
    id: string;
    warehouseId: string;
    productProfileId: string;
  };
};

type OutboundActivityRow = {
  recordId: string;
  activity: WmsOutboundUnitStatus;
  eventAt: Date;
  currentStatus: WmsOutboundUnitStatus;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  returningAt: Date | null;
  returnedAt: Date | null;
  trackingCode: string | null;
  unitId: string;
  unitCode: string;
  unitBarcode: string;
  variationId: string;
  productProfileId: string;
  productName: string;
  productCustomId: string | null;
  tenantId: string;
  tenantName: string;
  storeId: string;
  storeName: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  fulfillmentOrderId: string;
  posOrderId: string;
  shopId: string;
};

@Injectable()
export class WmsOutboundRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  async getRecords(query: GetWmsOutboundRecordsDto) {
    const scope = await this.resolveTenantScope(query.tenantId, query.allTenants === true);
    const isAllTenantScope = scope.canAccessAllTenants && !scope.activeTenantId;
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 5), 100);
    const dateWindow = this.resolveDateWindow(query.startDate, query.endDate);

    if (!scope.activeTenantId && !isAllTenantScope) {
      return this.emptyResponse({
        page,
        pageSize,
        startDate: dateWindow.startDate,
        endDate: dateWindow.endDate,
        tenants: scope.tenants,
      });
    }

    const tenantWhere: Prisma.WmsOutboundUnitRecordWhereInput = scope.activeTenantId
      ? { tenantId: scope.activeTenantId }
      : {};
    const availableStores = await this.prisma.posStore.findMany({
      where: {
        ...(scope.activeTenantId ? { tenantId: scope.activeTenantId } : {}),
        status: IntegrationStatus.ACTIVE,
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        shopName: true,
        tenant: { select: { name: true } },
      },
      orderBy: [{ tenant: { name: 'asc' } }, { shopName: 'asc' }, { name: 'asc' }],
    });
    const activeStore = query.storeId
      ? availableStores.find((store) => store.id === query.storeId) ?? null
      : null;

    if (query.storeId && !activeStore) {
      throw new ForbiddenException('Selected store is outside your WMS inventory scope');
    }

    const searchWhere = this.buildSearchWhere(query.search);
    const scopeWhere: Prisma.WmsOutboundUnitRecordWhereInput = {
      ...tenantWhere,
      ...(activeStore ? { storeId: activeStore.id } : {}),
      ...(query.productProfileId ? { productProfileId: query.productProfileId } : {}),
      ...searchWhere,
    };
    const activityDateWhere = this.buildActivityDateWhere(dateWindow.from, dateWindow.to);
    const productScopeWhere: Prisma.WmsOutboundUnitRecordWhereInput = {
      ...tenantWhere,
      ...activityDateWhere,
      ...(activeStore ? { storeId: activeStore.id } : {}),
    };

    const [records, shippedCount, deliveredCount, returningCount, returnedCount, productIds] = await Promise.all([
      this.findActivityRows({
        tenantId: scope.activeTenantId,
        storeId: activeStore?.id,
        productProfileId: query.productProfileId,
        activity: query.status,
        search: query.search,
        from: dateWindow.from,
        to: dateWindow.to,
        page,
        pageSize,
      }),
      this.prisma.wmsOutboundUnitRecord.count({
        where: { ...scopeWhere, shippedAt: { gte: dateWindow.from, lt: dateWindow.to } },
      }),
      this.prisma.wmsOutboundUnitRecord.count({
        where: { ...scopeWhere, deliveredAt: { gte: dateWindow.from, lt: dateWindow.to } },
      }),
      this.prisma.wmsOutboundUnitRecord.count({
        where: { ...scopeWhere, returningAt: { gte: dateWindow.from, lt: dateWindow.to } },
      }),
      this.prisma.wmsOutboundUnitRecord.count({
        where: { ...scopeWhere, returnedAt: { gte: dateWindow.from, lt: dateWindow.to } },
      }),
      scope.activeTenantId || activeStore
        ? this.prisma.wmsOutboundUnitRecord.findMany({
            where: productScopeWhere,
            distinct: ['productProfileId'],
            select: { productProfileId: true },
          })
        : Promise.resolve([]),
    ]);

    const statusCountMap = new Map<WmsOutboundUnitStatus, number>([
      [WmsOutboundUnitStatus.SHIPPED, shippedCount],
      [WmsOutboundUnitStatus.DELIVERED, deliveredCount],
      [WmsOutboundUnitStatus.RETURNING, returningCount],
      [WmsOutboundUnitStatus.RETURNED, returnedCount],
    ]);
    const total = query.status
      ? statusCountMap.get(query.status) ?? 0
      : Array.from(statusCountMap.values()).reduce((sum, count) => sum + count, 0);

    const products = productIds.length > 0
      ? await this.prisma.wmsProductProfile.findMany({
          where: { id: { in: productIds.map((entry) => entry.productProfileId) } },
          select: {
            id: true,
            tenantId: true,
            storeId: true,
            variationId: true,
            posProduct: { select: { name: true, customId: true } },
            store: { select: { name: true, shopName: true, tenant: { select: { name: true } } } },
          },
          orderBy: [{ posProduct: { name: 'asc' } }],
        })
      : [];
    const summary = Object.fromEntries(
      OUTBOUND_STATUS_ORDER.map((status) => [status.toLowerCase(), statusCountMap.get(status) ?? 0]),
    );

    return {
      tenantReady: true,
      serverTime: new Date().toISOString(),
      summary,
      filters: {
        tenants: scope.tenants,
        stores: availableStores.map((store) => ({
          id: store.id,
          tenantId: store.tenantId,
          name: store.shopName || store.name,
          label: isAllTenantScope
            ? `${store.tenant.name} · ${store.shopName || store.name}`
            : store.shopName || store.name,
        })),
        products: products.map((product) => ({
          id: product.id,
          tenantId: product.tenantId,
          storeId: product.storeId,
          variationId: product.variationId,
          name: product.posProduct.name,
          customId: product.posProduct.customId,
          label: `${product.posProduct.name} · ${product.store.shopName || product.store.name}`,
        })),
        statuses: OUTBOUND_STATUS_ORDER.map((status) => ({
          value: status,
          label: this.formatStatusLabel(status),
          recordCount: statusCountMap.get(status) ?? 0,
        })),
        activeTenantId: scope.activeTenantId,
        activeStoreId: activeStore?.id ?? null,
        activeProductProfileId: query.productProfileId ?? null,
        activeStatus: query.status ?? null,
        startDate: dateWindow.startDate,
        endDate: dateWindow.endDate,
      },
      pagination: {
        page,
        pageSize,
        totalItems: total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
      records: records.map((record) => ({
        id: record.recordId,
        activity: record.activity,
        status: record.currentStatus,
        eventAt: record.eventAt,
        shippedAt: record.shippedAt,
        deliveredAt: record.deliveredAt,
        returningAt: record.returningAt,
        returnedAt: record.returnedAt,
        trackingCode: record.trackingCode,
        unit: {
          id: record.unitId,
          code: record.unitCode,
          barcode: record.unitBarcode,
        },
        product: {
          profileId: record.productProfileId,
          variationId: record.variationId,
          name: record.productName,
          customId: record.productCustomId,
        },
        tenant: {
          id: record.tenantId,
          name: record.tenantName,
        },
        store: {
          id: record.storeId,
          name: record.storeName,
        },
        warehouse: {
          id: record.warehouseId,
          code: record.warehouseCode,
          name: record.warehouseName,
        },
        order: {
          id: record.fulfillmentOrderId,
          posOrderId: record.posOrderId,
          shopId: record.shopId,
        },
      })),
    };
  }

  private async findActivityRows(params: {
    tenantId: string | null;
    storeId?: string;
    productProfileId?: string;
    activity?: WmsOutboundUnitStatus;
    search?: string;
    from: Date;
    to: Date;
    page: number;
    pageSize: number;
  }) {
    const tenantFilter = params.tenantId
      ? Prisma.sql`AND record."tenantId" = CAST(${params.tenantId} AS UUID)`
      : Prisma.sql``;
    const storeFilter = params.storeId
      ? Prisma.sql`AND record."storeId" = CAST(${params.storeId} AS UUID)`
      : Prisma.sql``;
    const productFilter = params.productProfileId
      ? Prisma.sql`AND record."productProfileId" = CAST(${params.productProfileId} AS UUID)`
      : Prisma.sql``;
    const activityFilter = params.activity
      ? Prisma.sql`AND event."activity" = ${params.activity}`
      : Prisma.sql``;
    const normalizedSearch = params.search?.trim();
    const searchFilter = normalizedSearch
      ? Prisma.sql`AND (
          unit."code" ILIKE ${`%${normalizedSearch}%`}
          OR unit."barcode" ILIKE ${`%${normalizedSearch}%`}
          OR unit."variationId" ILIKE ${`%${normalizedSearch}%`}
          OR product."name" ILIKE ${`%${normalizedSearch}%`}
          OR fulfillment."posOrderId" ILIKE ${`%${normalizedSearch}%`}
          OR record."trackingCode" ILIKE ${`%${normalizedSearch}%`}
        )`
      : Prisma.sql``;
    const offset = (params.page - 1) * params.pageSize;

    return this.prisma.$queryRaw<OutboundActivityRow[]>(Prisma.sql`
      WITH "outboundEvents" AS (
        SELECT "id" AS "recordId", 'SHIPPED'::text AS "activity", "shippedAt" AS "eventAt"
        FROM "wms_outbound_unit_records"
        WHERE "shippedAt" >= ${params.from} AND "shippedAt" < ${params.to}

        UNION ALL

        SELECT "id" AS "recordId", 'DELIVERED'::text AS "activity", "deliveredAt" AS "eventAt"
        FROM "wms_outbound_unit_records"
        WHERE "deliveredAt" >= ${params.from} AND "deliveredAt" < ${params.to}

        UNION ALL

        SELECT "id" AS "recordId", 'RETURNING'::text AS "activity", "returningAt" AS "eventAt"
        FROM "wms_outbound_unit_records"
        WHERE "returningAt" >= ${params.from} AND "returningAt" < ${params.to}

        UNION ALL

        SELECT "id" AS "recordId", 'RETURNED'::text AS "activity", "returnedAt" AS "eventAt"
        FROM "wms_outbound_unit_records"
        WHERE "returnedAt" >= ${params.from} AND "returnedAt" < ${params.to}
      )
      SELECT
        record."id" AS "recordId",
        event."activity" AS "activity",
        event."eventAt" AS "eventAt",
        record."currentStatus" AS "currentStatus",
        record."shippedAt" AS "shippedAt",
        record."deliveredAt" AS "deliveredAt",
        record."returningAt" AS "returningAt",
        record."returnedAt" AS "returnedAt",
        record."trackingCode" AS "trackingCode",
        unit."id" AS "unitId",
        unit."code" AS "unitCode",
        unit."barcode" AS "unitBarcode",
        unit."variationId" AS "variationId",
        record."productProfileId" AS "productProfileId",
        product."name" AS "productName",
        product."customId" AS "productCustomId",
        tenant."id" AS "tenantId",
        tenant."name" AS "tenantName",
        store."id" AS "storeId",
        COALESCE(store."shopName", store."name") AS "storeName",
        warehouse."id" AS "warehouseId",
        warehouse."code" AS "warehouseCode",
        warehouse."name" AS "warehouseName",
        fulfillment."id" AS "fulfillmentOrderId",
        fulfillment."posOrderId" AS "posOrderId",
        fulfillment."shopId" AS "shopId"
      FROM "outboundEvents" event
      INNER JOIN "wms_outbound_unit_records" record ON record."id" = event."recordId"
      INNER JOIN "wms_inventory_units" unit ON unit."id" = record."inventoryUnitId"
      INNER JOIN "pos_products" product ON product."id" = unit."posProductId"
      INNER JOIN "tenants" tenant ON tenant."id" = record."tenantId"
      INNER JOIN "pos_stores" store ON store."id" = record."storeId"
      INNER JOIN "wms_warehouses" warehouse ON warehouse."id" = record."warehouseId"
      INNER JOIN "wms_fulfillment_orders" fulfillment ON fulfillment."id" = record."fulfillmentOrderId"
      WHERE TRUE
        ${tenantFilter}
        ${storeFilter}
        ${productFilter}
        ${activityFilter}
        ${searchFilter}
      ORDER BY event."eventAt" DESC, record."id" DESC, event."activity" ASC
      LIMIT ${params.pageSize}
      OFFSET ${offset}
    `);
  }

  private buildActivityDateWhere(from: Date, to: Date): Prisma.WmsOutboundUnitRecordWhereInput {
    return {
      OR: [
        { shippedAt: { gte: from, lt: to } },
        { deliveredAt: { gte: from, lt: to } },
        { returningAt: { gte: from, lt: to } },
        { returnedAt: { gte: from, lt: to } },
      ],
    };
  }

  async syncForPosOrders(params: {
    tenantId: string;
    storeId?: string | null;
    posOrderRefs?: Array<{ shopId: string; posOrderId: string }>;
  }) {
    const refs = Array.from(
      new Map(
        (params.posOrderRefs ?? [])
          .filter((ref) => ref.shopId && ref.posOrderId)
          .map((ref) => [`${ref.shopId}::${ref.posOrderId}`, ref] as const),
      ).values(),
    );
    const orders = await this.prisma.wmsFulfillmentOrder.findMany({
      where: {
        tenantId: params.tenantId,
        ...(params.storeId ? { storeId: params.storeId } : {}),
        status: WmsFulfillmentOrderStatus.PACKED,
        posOrder: { is: { status: { in: [2, 3, 4, 5] } } },
        ...(refs.length > 0
          ? { OR: refs.map((ref) => ({ shopId: ref.shopId, posOrderId: ref.posOrderId })) }
          : {}),
      },
      select: projectionOrderSelect,
    });

    if (orders.length === 0) {
      return { upsertedRecords: 0 };
    }

    const orderIds = orders.map((order) => order.id);
    const dispatchMovements = await this.prisma.wmsInventoryMovement.findMany({
      where: {
        movementType: WmsInventoryMovementType.DISPATCH,
        referenceType: 'WMS_FULFILLMENT_ORDER',
        referenceId: { in: orderIds },
      },
      select: {
        referenceId: true,
        inventoryUnitId: true,
        createdAt: true,
        inventoryUnit: {
          select: {
            id: true,
            warehouseId: true,
            productProfileId: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const dispatchedAtByUnit = new Map<string, Date>();
    const dispatchedUnitsByOrder = new Map<string, ProjectionUnit[]>();
    for (const movement of dispatchMovements) {
      if (!movement.referenceId) continue;
      const key = `${movement.referenceId}::${movement.inventoryUnitId}`;
      if (!dispatchedAtByUnit.has(key)) dispatchedAtByUnit.set(key, movement.createdAt);
      const units = dispatchedUnitsByOrder.get(movement.referenceId) ?? [];
      if (!units.some((unit) => unit.inventoryUnit.id === movement.inventoryUnitId)) {
        units.push({
          fulfillmentLineId: null,
          inventoryUnit: movement.inventoryUnit,
        });
        dispatchedUnitsByOrder.set(movement.referenceId, units);
      }
    }

    const writes: Array<{
      sourceOrderId: string;
      sourceFingerprint: string;
      args: Prisma.WmsOutboundUnitRecordUpsertArgs;
    }> = [];
    for (const order of orders) {
      const currentStatus = POS_TO_OUTBOUND_STATUS[order.posOrder.status ?? -1];
      if (!currentStatus) continue;

      const historyTimes = this.extractStatusTimes(order.posOrder.statusHistory);
      const units = this.resolveProjectionUnits(
        order,
        dispatchedUnitsByOrder.get(order.id) ?? [],
      );
      for (const unit of units) {
        const shippedAt = historyTimes.get(2)
          ?? dispatchedAtByUnit.get(`${order.id}::${unit.inventoryUnit.id}`)
          ?? null;
        const deliveredAt = historyTimes.get(3) ?? order.posOrder.deliveredAt ?? null;
        const returningAt = historyTimes.get(4) ?? null;
        const returnedAt = historyTimes.get(5) ?? order.posOrder.rtsAt ?? null;
        const latestEventAt = this.resolveLatestEventAt({
          currentStatus,
          shippedAt,
          deliveredAt,
          returningAt,
          returnedAt,
          fallback: order.posOrder.updatedAt,
        });

        writes.push({ sourceOrderId: order.posOrderDbId,
          sourceFingerprint: this.projectionSourceFingerprint(order.posOrder), args: {
          where: {
            fulfillmentOrderId_inventoryUnitId: {
              fulfillmentOrderId: order.id,
              inventoryUnitId: unit.inventoryUnit.id,
            },
          },
          create: {
            tenantId: order.tenantId,
            storeId: order.storeId,
            warehouseId: unit.inventoryUnit.warehouseId,
            productProfileId: unit.inventoryUnit.productProfileId,
            inventoryUnitId: unit.inventoryUnit.id,
            fulfillmentOrderId: order.id,
            fulfillmentLineId: unit.fulfillmentLineId,
            currentStatus,
            shippedAt,
            deliveredAt,
            returningAt,
            returnedAt,
            latestEventAt,
            trackingCode: order.posOrder.tracking,
          },
          update: {
            currentStatus,
            latestEventAt,
            trackingCode: order.posOrder.tracking,
            warehouseId: unit.inventoryUnit.warehouseId,
            productProfileId: unit.inventoryUnit.productProfileId,
            ...(unit.fulfillmentLineId ? { fulfillmentLineId: unit.fulfillmentLineId } : {}),
            ...(shippedAt ? { shippedAt } : {}),
            ...(deliveredAt ? { deliveredAt } : {}),
            ...(returningAt ? { returningAt } : {}),
            ...(returnedAt ? { returnedAt } : {}),
          },
        } });
      }
    }

    for (let index = 0; index < writes.length; index += 100) {
      const chunk = writes.slice(index, index + 100);
      const sourceIds = [...new Set(chunk.map(write => write.sourceOrderId))].sort();
      await this.prisma.$transaction(async tx => {
        // Projection inputs were read before this transaction. Fence them with
        // the same source rows ingest updates, so a slower old projection can
        // never overwrite one computed from a newer committed order snapshot.
        const sources = await tx.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
          SELECT id, status, "statusHistory", "deliveredAt", "rtsAt", tracking, "updatedAt",
            "orderSnapshot"->>'_pancakeUpdatedAt' AS "sourceVersion"
          FROM pos_orders WHERE id IN (${Prisma.join(sourceIds.map(id => Prisma.sql`${id}::uuid`))})
          ORDER BY id FOR SHARE NOWAIT
        `);
        const fingerprints = new Map(sources.map(source => [source.id, this.projectionSourceFingerprint(source)]));
        if (chunk.some(write => fingerprints.get(write.sourceOrderId) !== write.sourceFingerprint)) {
          throw Object.assign(new Error('POS source changed before outbound projection; retry current source'), { code: 'P2034' });
        }
        for (const write of chunk) await tx.wmsOutboundUnitRecord.upsert(write.args);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 20_000 });
    }

    return { upsertedRecords: writes.length };
  }

  private projectionSourceFingerprint(source: Record<string, any>): string {
    const snapshot = source.orderSnapshot;
    const sourceVersion = typeof source.sourceVersion === 'string' ? source.sourceVersion
      : snapshot && typeof snapshot === 'object' && typeof snapshot._pancakeUpdatedAt === 'string'
        ? snapshot._pancakeUpdatedAt : null;
    return JSON.stringify([
      source.status, source.statusHistory, source.deliveredAt?.toISOString() ?? null,
      source.rtsAt?.toISOString() ?? null, source.tracking, source.updatedAt.toISOString(), sourceVersion,
    ]);
  }

  private resolveProjectionUnits(
    order: ProjectionOrder,
    dispatchedUnits: ProjectionUnit[],
  ): ProjectionUnit[] {
    const basketUnits = order.basketUnits as ProjectionUnit[];
    const reservations = order.reservations as ProjectionUnit[];
    const preferred = order.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
      ? basketUnits
      : reservations;
    const secondary = order.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
      ? reservations
      : basketUnits;
    const associatedUnits = [...preferred, ...secondary];
    const lineByUnitId = new Map(
      associatedUnits.map((unit) => [unit.inventoryUnit.id, unit.fulfillmentLineId] as const),
    );
    const source = dispatchedUnits.length > 0
      ? dispatchedUnits.map((unit) => ({
          ...unit,
          fulfillmentLineId: lineByUnitId.get(unit.inventoryUnit.id) ?? null,
        }))
      : associatedUnits;

    return Array.from(
      new Map(source.map((unit) => [unit.inventoryUnit.id, unit] as const)).values(),
    );
  }

  private extractStatusTimes(value: Prisma.JsonValue | null) {
    const times = new Map<number, Date>();
    if (!Array.isArray(value)) return times;

    for (const rawEntry of value) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as Record<string, Prisma.JsonValue>;
      const rawStatus = Number(entry.status);
      const rawTimestamp = entry.updated_at ?? entry.updatedAt ?? entry.created_at ?? entry.createdAt;
      if (![2, 3, 4, 5].includes(rawStatus) || typeof rawTimestamp !== 'string') continue;
      const timestamp = new Date(rawTimestamp);
      if (Number.isNaN(timestamp.getTime())) continue;
      const current = times.get(rawStatus);
      if (!current || timestamp > current) times.set(rawStatus, timestamp);
    }

    return times;
  }

  private resolveLatestEventAt(params: {
    currentStatus: WmsOutboundUnitStatus;
    shippedAt: Date | null;
    deliveredAt: Date | null;
    returningAt: Date | null;
    returnedAt: Date | null;
    fallback: Date;
  }) {
    if (params.currentStatus === WmsOutboundUnitStatus.SHIPPED) return params.shippedAt ?? params.fallback;
    if (params.currentStatus === WmsOutboundUnitStatus.DELIVERED) return params.deliveredAt ?? params.fallback;
    if (params.currentStatus === WmsOutboundUnitStatus.RETURNING) return params.returningAt ?? params.fallback;
    return params.returnedAt ?? params.fallback;
  }

  private buildSearchWhere(search?: string): Prisma.WmsOutboundUnitRecordWhereInput {
    const normalized = search?.trim();
    if (!normalized) return {};

    return {
      OR: [
        { inventoryUnit: { is: { code: { contains: normalized, mode: 'insensitive' } } } },
        { inventoryUnit: { is: { barcode: { contains: normalized, mode: 'insensitive' } } } },
        { inventoryUnit: { is: { variationId: { contains: normalized, mode: 'insensitive' } } } },
        { inventoryUnit: { is: { posProduct: { is: { name: { contains: normalized, mode: 'insensitive' } } } } } },
        { fulfillmentOrder: { is: { posOrderId: { contains: normalized, mode: 'insensitive' } } } },
        { trackingCode: { contains: normalized, mode: 'insensitive' } },
      ],
    };
  }

  private resolveDateWindow(startDate?: string, endDate?: string) {
    const today = this.formatManilaDate(new Date());
    const defaultStart = new Date(`${today}T00:00:00+08:00`);
    defaultStart.setUTCDate(defaultStart.getUTCDate() - 29);
    const normalizedStart = startDate ?? this.formatManilaDate(defaultStart);
    const normalizedEnd = endDate ?? today;
    const from = new Date(`${normalizedStart}T00:00:00+08:00`);
    const inclusiveEnd = new Date(`${normalizedEnd}T00:00:00+08:00`);

    if (Number.isNaN(from.getTime()) || Number.isNaN(inclusiveEnd.getTime()) || from > inclusiveEnd) {
      throw new BadRequestException('Start date must be on or before end date');
    }

    const rangeDays = Math.floor((inclusiveEnd.getTime() - from.getTime()) / 86_400_000) + 1;
    if (rangeDays > MAX_DATE_RANGE_DAYS) {
      throw new BadRequestException(`Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`);
    }

    const to = new Date(inclusiveEnd);
    to.setUTCDate(to.getUTCDate() + 1);
    return { startDate: normalizedStart, endDate: normalizedEnd, from, to };
  }

  private formatManilaDate(value: Date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(value);
  }

  private formatStatusLabel(status: WmsOutboundUnitStatus) {
    return status.charAt(0) + status.slice(1).toLowerCase();
  }

  private async resolveTenantScope(requestedTenantId?: string, forceAllTenants = false) {
    const clsTenantId = this.cls.get('tenantId') as string | undefined;
    const userRole = this.cls.get('userRole') as string | undefined;
    const hasGlobalWmsAccess = this.cls.get('wmsGlobalAccess') === true;
    const canAccessAllTenants = userRole === 'SUPER_ADMIN' || hasGlobalWmsAccess;
    const tenants = await this.prisma.tenant.findMany({
      where: { status: { in: [...ACTIVE_WMS_TENANT_STATUSES] } },
      select: { id: true, name: true, slug: true, status: true },
      orderBy: { name: 'asc' },
    });

    if (canAccessAllTenants) {
      const activeTenantId = requestedTenantId && tenants.some((tenant) => tenant.id === requestedTenantId)
        ? requestedTenantId
        : forceAllTenants
          ? null
          : clsTenantId && tenants.some((tenant) => tenant.id === clsTenantId)
            ? clsTenantId
            : tenants[0]?.id ?? null;
      return {
        activeTenantId,
        canAccessAllTenants: true,
        tenants: tenants.map((tenant) => ({
          id: tenant.id,
          label: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
        })),
      };
    }

    if (!clsTenantId) {
      return { activeTenantId: null, canAccessAllTenants: false, tenants: [] };
    }
    if (requestedTenantId && requestedTenantId !== clsTenantId) {
      throw new ForbiddenException('Selected tenant is outside your WMS scope');
    }
    const tenant = tenants.find((entry) => entry.id === clsTenantId) ?? null;
    return {
      activeTenantId: tenant?.id ?? null,
      canAccessAllTenants: false,
      tenants: tenant
        ? [{ id: tenant.id, label: tenant.name, slug: tenant.slug, status: tenant.status }]
        : [],
    };
  }

  private emptyResponse(params: {
    page: number;
    pageSize: number;
    startDate: string;
    endDate: string;
    tenants: Array<{ id: string; label: string; slug: string; status: TenantStatus }>;
  }) {
    return {
      tenantReady: false,
      serverTime: new Date().toISOString(),
      summary: { shipped: 0, delivered: 0, returning: 0, returned: 0 },
      filters: {
        tenants: params.tenants,
        stores: [],
        products: [],
        statuses: OUTBOUND_STATUS_ORDER.map((status) => ({
          value: status,
          label: this.formatStatusLabel(status),
          recordCount: 0,
        })),
        activeTenantId: null,
        activeStoreId: null,
        activeProductProfileId: null,
        activeStatus: null,
        startDate: params.startDate,
        endDate: params.endDate,
      },
      pagination: { page: params.page, pageSize: params.pageSize, totalItems: 0, totalPages: 1 },
      records: [],
    };
  }
}

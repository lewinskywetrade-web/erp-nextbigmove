import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TenantStatus,
  WmsBasketUnitStatus,
  WmsFulfillmentLineStatus,
  WmsFulfillmentOrderStatus,
  WmsStaffActivityOutcome,
  WmsInventoryMovementType,
  WmsInventoryUnitStatus,
  WmsLocationKind,
  WmsPickReservationStatus,
  WmsProductProfileStatus,
  WmsTransferStatus,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WmsStaffActivityService } from '../../common/services/wms-staff-activity.service';
import { WmsFulfillmentSyncService } from '../wms-fulfillment/wms-fulfillment-sync.service';
import { linkProfilesIntoSharedStockPoolTx } from '../wms-fulfillment/wms-stock-pool.util';
import { CreateWmsInventoryAdjustmentDto } from './dto/create-wms-inventory-adjustment.dto';
import { CreateWmsInventoryStoreTransferDto } from './dto/create-wms-inventory-store-transfer.dto';
import { CreateWmsInventoryTransferDto } from './dto/create-wms-inventory-transfer.dto';
import { GetWmsInventoryOverviewDto } from './dto/get-wms-inventory-overview.dto';
import { GetWmsInventoryStoreTransferOptionsDto } from './dto/get-wms-inventory-store-transfer-options.dto';
import { GetWmsInventoryTransfersDto } from './dto/get-wms-inventory-transfers.dto';
import { RecordWmsInventoryUnitLabelPrintDto } from './dto/record-wms-inventory-unit-label-print.dto';
import { VoidWmsInventoryUnitDto } from './dto/void-wms-inventory-unit.dto';
import { WmsInventoryCogsService } from './wms-inventory-cogs.service';
import { WmsOutboundRecordsService } from './wms-outbound-records.service';

const UNIT_STATUS_ORDER: WmsInventoryUnitStatus[] = [
  WmsInventoryUnitStatus.RECEIVED,
  WmsInventoryUnitStatus.STAGED,
  WmsInventoryUnitStatus.PUTAWAY,
  WmsInventoryUnitStatus.EXPIRED,
  WmsInventoryUnitStatus.DEADSTOCK,
  WmsInventoryUnitStatus.RESERVED,
  WmsInventoryUnitStatus.PICKED,
  WmsInventoryUnitStatus.PACKED,
  WmsInventoryUnitStatus.DISPATCHED,
  WmsInventoryUnitStatus.RTS,
  WmsInventoryUnitStatus.DAMAGED,
  WmsInventoryUnitStatus.LOST,
  WmsInventoryUnitStatus.ARCHIVED,
];
const UNIT_ON_HAND_EXCLUDED_STATUSES: WmsInventoryUnitStatus[] = [
  WmsInventoryUnitStatus.RECEIVED,
  WmsInventoryUnitStatus.STAGED,
  WmsInventoryUnitStatus.DISPATCHED,
  WmsInventoryUnitStatus.DAMAGED,
  WmsInventoryUnitStatus.LOST,
  WmsInventoryUnitStatus.ARCHIVED,
];
const ACTIVE_WMS_TENANT_STATUSES = [TenantStatus.ACTIVE, TenantStatus.TRIAL] as const;

type InventoryUnitRecord = Prisma.WmsInventoryUnitGetPayload<{
  include: {
    store: {
      select: {
        id: true;
        name: true;
        shopName: true;
      };
    };
    warehouse: {
      select: {
        id: true;
        code: true;
        name: true;
      };
    };
    currentLocation: {
      select: {
        id: true;
        code: true;
        name: true;
        kind: true;
      };
    };
    posProduct: {
      select: {
        id: true;
        name: true;
        customId: true;
        productSnapshot: true;
      };
    };
  };
}>;

type InventoryMovementRecord = Prisma.WmsInventoryMovementGetPayload<{
  include: {
    fromLocation: {
      select: {
        id: true;
        code: true;
        name: true;
        kind: true;
      };
    };
    toLocation: {
      select: {
        id: true;
        code: true;
        name: true;
        kind: true;
      };
    };
    actor: {
      select: {
        firstName: true;
        lastName: true;
        email: true;
      };
    };
  };
}>;

type TransferableUnitRecord = Prisma.WmsInventoryUnitGetPayload<{
  include: {
    warehouse: {
      select: {
        id: true;
        code: true;
        name: true;
      };
    };
    currentLocation: {
      select: {
        id: true;
        code: true;
        name: true;
        kind: true;
        warehouseId: true;
        parentId: true;
        isActive: true;
      };
    };
  };
}>;

type TransferLocationRecord = {
  id: string;
  warehouseId: string;
  parentId: string | null;
  kind: WmsLocationKind;
  code: string;
  name: string;
  capacity: number | null;
};

type TransferStructureMaps = {
  sections: TransferLocationRecord[];
  locationMap: Map<string, TransferLocationRecord>;
  racksBySectionId: Map<string, TransferLocationRecord[]>;
  binsByRackId: Map<string, TransferLocationRecord[]>;
};

type InventoryTransferRecord = Prisma.WmsTransferGetPayload<{
  include: {
    warehouse: {
      select: {
        id: true;
        code: true;
        name: true;
      };
    };
    fromLocation: {
      select: {
        id: true;
        code: true;
        name: true;
        kind: true;
      };
    };
    toLocation: {
      select: {
        id: true;
        code: true;
        name: true;
        kind: true;
      };
    };
    createdBy: {
      select: {
        firstName: true;
        lastName: true;
        email: true;
      };
    };
    _count: {
      select: {
        items: true;
      };
    };
  };
}>;

const TRANSFERABLE_UNIT_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.RECEIVED,
  WmsInventoryUnitStatus.STAGED,
  WmsInventoryUnitStatus.PUTAWAY,
  WmsInventoryUnitStatus.EXPIRED,
  WmsInventoryUnitStatus.DEADSTOCK,
  WmsInventoryUnitStatus.RTS,
  WmsInventoryUnitStatus.DAMAGED,
]);

const STORE_TRANSFERABLE_UNIT_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.RECEIVED,
  WmsInventoryUnitStatus.STAGED,
  WmsInventoryUnitStatus.PUTAWAY,
]);

const STORE_TRANSFER_DEMAND_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.READY,
  WmsFulfillmentOrderStatus.PARTIAL,
  WmsFulfillmentOrderStatus.RESTOCKING,
  WmsFulfillmentOrderStatus.ISSUE,
  WmsFulfillmentOrderStatus.IN_PICKING,
] as const;

const ADJUSTABLE_UNIT_TARGET_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.STAGED,
  WmsInventoryUnitStatus.PUTAWAY,
  WmsInventoryUnitStatus.DEADSTOCK,
  WmsInventoryUnitStatus.RTS,
  WmsInventoryUnitStatus.DAMAGED,
  WmsInventoryUnitStatus.LOST,
  WmsInventoryUnitStatus.ARCHIVED,
]);

const ARCHIVABLE_ADJUSTMENT_SOURCE_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.RECEIVED,
  WmsInventoryUnitStatus.STAGED,
  WmsInventoryUnitStatus.PUTAWAY,
  WmsInventoryUnitStatus.EXPIRED,
  WmsInventoryUnitStatus.DEADSTOCK,
  WmsInventoryUnitStatus.RESERVED,
  WmsInventoryUnitStatus.RTS,
  WmsInventoryUnitStatus.DAMAGED,
  WmsInventoryUnitStatus.LOST,
]);

const VOIDABLE_UNIT_STATUSES = new Set<WmsInventoryUnitStatus>([
  WmsInventoryUnitStatus.RECEIVED,
  WmsInventoryUnitStatus.STAGED,
  WmsInventoryUnitStatus.PUTAWAY,
  WmsInventoryUnitStatus.EXPIRED,
  WmsInventoryUnitStatus.DEADSTOCK,
  WmsInventoryUnitStatus.RESERVED,
  WmsInventoryUnitStatus.RTS,
  WmsInventoryUnitStatus.DAMAGED,
  WmsInventoryUnitStatus.LOST,
]);

const ACTIVE_PICK_RESERVATION_STATUSES = [
  WmsPickReservationStatus.RESERVED,
  WmsPickReservationStatus.PICKED,
] as const;

const ACTIVE_BASKET_UNIT_HOLD_STATUSES = [
  WmsBasketUnitStatus.PICKED,
  WmsBasketUnitStatus.PACKED,
] as const;

const VOID_BLOCKED_FULFILLMENT_ORDER_STATUSES = new Set<WmsFulfillmentOrderStatus>([
  WmsFulfillmentOrderStatus.IN_PICKING,
  WmsFulfillmentOrderStatus.READY_FOR_PACK,
  WmsFulfillmentOrderStatus.PICKED,
  WmsFulfillmentOrderStatus.PACKING,
  WmsFulfillmentOrderStatus.PACKED,
]);

const STRUCTURAL_LOCATION_KINDS = [WmsLocationKind.SECTION, WmsLocationKind.RACK, WmsLocationKind.BIN] as const;

const TRANSFER_OPERATIONAL_LOCATION_KINDS = [
  WmsLocationKind.RECEIVING_STAGING,
  WmsLocationKind.RTS,
  WmsLocationKind.DAMAGE,
  WmsLocationKind.QUARANTINE,
] as const;

@Injectable()
export class WmsInventoryService {
  private readonly logger = new Logger(WmsInventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly wmsStaffActivityService: WmsStaffActivityService,
    private readonly wmsInventoryCogsService: WmsInventoryCogsService,
    private readonly wmsFulfillmentSyncService: WmsFulfillmentSyncService,
    private readonly wmsOutboundRecordsService: WmsOutboundRecordsService,
  ) {}

  async getOverview(query: GetWmsInventoryOverviewDto) {
    const scope = await this.resolveTenantScope(query.tenantId, query.allTenants === true);
    const isAllTenantScope = scope.canAccessAllTenants && !scope.activeTenantId;
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(Math.max(1, query.pageSize ?? 10), 100);
    const skip = (page - 1) * pageSize;
    const activityDateWindow = this.resolveInventoryActivityDateWindow(
      query.startDate,
      query.endDate,
    );

    if (!scope.activeTenantId && !isAllTenantScope) {
      return {
        tenantReady: false,
        summary: {
          units: 0,
        locatedUnits: 0,
        unlocatedUnits: 0,
        unitsOnHand: 0,
        skuOnHand: 0,
        dispatchedUnits: 0,
          warehouseCapacity: {
            usedUnits: 0,
            totalUnits: 0,
            utilizationPercent: 0,
          },
        },
        filters: {
          tenants: scope.tenants,
          stores: [],
          warehouses: [],
          products: [],
          statuses: UNIT_STATUS_ORDER.map((status) => ({
            value: status,
            label: this.formatStatusLabel(status),
            unitCount: 0,
          })),
          activeTenantId: null,
          activeStoreId: null,
          activeWarehouseId: null,
          activeVariationId: null,
          activeStatus: null,
        },
        pagination: {
          page,
          pageSize,
          totalItems: 0,
          totalPages: 1,
        },
        units: [],
      };
    }

    const unitTenantWhere: Prisma.WmsInventoryUnitWhereInput = scope.activeTenantId
      ? { tenantId: scope.activeTenantId }
      : {};
    const storeTenantWhere: Prisma.PosStoreWhereInput = scope.activeTenantId
      ? { tenantId: scope.activeTenantId }
      : {};

    const stores = await this.prisma.posStore.findMany({
      where: storeTenantWhere,
      select: {
        id: true,
        name: true,
        shopName: true,
        tenant: {
          select: {
            id: true,
            name: true,
          },
        },
        _count: {
          select: {
            wmsInventoryUnits: true,
          },
        },
      },
      orderBy: [{ name: 'asc' }],
    });

    const activeStoreId =
      query.storeId && stores.some((store) => store.id === query.storeId)
        ? query.storeId
        : null;

    const warehouseCountScope: Prisma.WmsInventoryUnitWhereInput = {
      ...unitTenantWhere,
      ...(activeStoreId ? { storeId: activeStoreId } : {}),
    };

    const [warehouses, warehouseCounts] = await Promise.all([
      this.prisma.wmsWarehouse.findMany({
        select: {
          id: true,
          code: true,
          name: true,
        },
        orderBy: [{ code: 'asc' }],
      }),
      this.prisma.wmsInventoryUnit.groupBy({
        by: ['warehouseId'],
        where: warehouseCountScope,
        _count: {
          _all: true,
        },
      }),
    ]);

    const activeWarehouseId =
      query.warehouseId && warehouses.some((warehouse) => warehouse.id === query.warehouseId)
        ? query.warehouseId
        : null;

    const productFilterScope: Prisma.WmsInventoryUnitWhereInput = {
      ...unitTenantWhere,
      ...(activeStoreId ? { storeId: activeStoreId } : {}),
      ...(activeWarehouseId ? { warehouseId: activeWarehouseId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const shouldLoadProductOptions = Boolean(scope.activeTenantId || activeStoreId);

    const [productOptions, productCounts] = shouldLoadProductOptions
      ? await Promise.all([
        this.prisma.wmsInventoryUnit.findMany({
          where: productFilterScope,
          distinct: ['storeId', 'variationId'],
          select: {
            tenantId: true,
            storeId: true,
            store: {
              select: {
                name: true,
                shopName: true,
                tenant: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
            variationId: true,
            posProduct: {
              select: {
                name: true,
                customId: true,
                productSnapshot: true,
              },
            },
          },
          orderBy: [{ storeId: 'asc' }, { variationId: 'asc' }],
        }),
        this.prisma.wmsInventoryUnit.groupBy({
          by: ['storeId', 'variationId'],
          where: productFilterScope,
          _count: {
            _all: true,
          },
        }),
      ])
      : [[], []];

    const activeVariationId =
      query.variationId && productOptions.some((product) => product.variationId === query.variationId)
        ? query.variationId
        : null;
    const productCountMap = new Map(
      productCounts.map((record) => [`${record.storeId}::${record.variationId}`, record._count._all]),
    );
    const mappedProductOptions = productOptions
      .map((product) => {
        const variationDisplayId = this.resolveVariationDisplayId(product.posProduct.productSnapshot);
        const productCustomId = product.posProduct.customId;
        const name = product.posProduct.name;
        const storeName = product.store.shopName || product.store.name;
        const tenantLabel = product.store.tenant.name;

        return {
          tenantId: product.store.tenant.id,
          tenantLabel,
          storeId: product.storeId,
          storeName,
          variationId: product.variationId,
          name,
          label: this.formatInventoryProductFilterLabel({
            storeName,
            tenantLabel,
            includeStoreContext: !activeStoreId,
            includeTenantContext: isAllTenantScope,
            variationId: product.variationId,
            name,
            variationDisplayId,
            productCustomId,
          }),
          selectedLabel: name,
          variationDisplayId,
          productCustomId,
          unitCount: productCountMap.get(`${product.storeId}::${product.variationId}`) ?? 0,
        };
      })
      .sort((left, right) => (
        left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
        || left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
      ));

    const where: Prisma.WmsInventoryUnitWhereInput = {
      ...unitTenantWhere,
      ...(activeStoreId ? { storeId: activeStoreId } : {}),
      ...(activeWarehouseId ? { warehouseId: activeWarehouseId } : {}),
      ...(activeVariationId ? { variationId: activeVariationId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(activityDateWindow
        ? {
            updatedAt: {
              gte: activityDateWindow.from,
              lt: activityDateWindow.to,
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { barcode: { contains: query.search, mode: 'insensitive' } },
              { variationId: { contains: query.search, mode: 'insensitive' } },
              { productId: { contains: query.search, mode: 'insensitive' } },
              { posProduct: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const statusCountScope: Prisma.WmsInventoryUnitWhereInput = {
      ...unitTenantWhere,
      ...(activeStoreId ? { storeId: activeStoreId } : {}),
      ...(activeWarehouseId ? { warehouseId: activeWarehouseId } : {}),
    };
    const stockControlScope: Prisma.WmsInventoryUnitWhereInput = {
      ...statusCountScope,
      status: {
        notIn: UNIT_ON_HAND_EXCLUDED_STATUSES,
      },
    };

    const [
      units,
      totalUnits,
      locatedUnits,
      unlocatedUnits,
      statusCounts,
      unitsOnHand,
      skuOnHandRecords,
      warehouseCapacity,
    ] = await Promise.all([
      this.prisma.wmsInventoryUnit.findMany({
        where,
        include: {
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
              name: true,
              kind: true,
            },
          },
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
              productSnapshot: true,
            },
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.wmsInventoryUnit.count({ where }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...where,
          currentLocationId: { not: null },
        },
      }),
      this.prisma.wmsInventoryUnit.count({
        where: {
          ...where,
          currentLocationId: null,
        },
      }),
      this.prisma.wmsInventoryUnit.groupBy({
        by: ['status'],
        where: statusCountScope,
        _count: {
          _all: true,
        },
      }),
      this.prisma.wmsInventoryUnit.count({
        where: stockControlScope,
      }),
      this.prisma.wmsInventoryUnit.findMany({
        where: stockControlScope,
        distinct: ['variationId'],
        select: {
          variationId: true,
        },
      }),
      this.getWarehouseCapacitySummary({
        tenantId: scope.activeTenantId,
        storeId: activeStoreId,
        warehouseId: activeWarehouseId,
      }),
    ]);

    const warehouseCountMap = new Map(
      warehouseCounts.map((record) => [record.warehouseId, record._count._all]),
    );
    const statusCountMap = new Map(statusCounts.map((record) => [record.status, record._count._all]));
    const dispatchedUnits = statusCountMap.get(WmsInventoryUnitStatus.DISPATCHED) ?? 0;

    return {
      tenantReady: true,
      summary: {
        units: totalUnits,
        locatedUnits,
        unlocatedUnits,
        unitsOnHand,
        skuOnHand: skuOnHandRecords.length,
        dispatchedUnits,
        warehouseCapacity,
      },
      filters: {
        tenants: scope.tenants,
        stores: stores.map((store) => ({
          id: store.id,
          tenantId: store.tenant.id,
          name: store.shopName || store.name,
          label: isAllTenantScope
            ? `${store.tenant.name} · ${store.shopName || store.name}`
            : store.shopName || store.name,
          unitCount: store._count.wmsInventoryUnits,
        })),
        warehouses: warehouses.map((warehouse) => ({
          id: warehouse.id,
          code: warehouse.code,
          label: warehouse.name,
          unitCount: warehouseCountMap.get(warehouse.id) ?? 0,
        })),
        products: mappedProductOptions,
        statuses: UNIT_STATUS_ORDER.map((status) => ({
          value: status,
          label: this.formatStatusLabel(status),
          unitCount: statusCountMap.get(status) ?? 0,
        })),
        activeTenantId: scope.activeTenantId,
        activeStoreId,
        activeWarehouseId,
        activeVariationId,
        activeStatus: query.status ?? null,
      },
      pagination: {
        page,
        pageSize,
        totalItems: totalUnits,
        totalPages: Math.max(1, Math.ceil(totalUnits / pageSize)),
      },
      units: units.map((unit) => this.mapUnit(unit)),
    };
  }

  private resolveInventoryActivityDateWindow(startDate?: string, endDate?: string) {
    if (!startDate && !endDate) {
      return null;
    }

    const normalizedStart = startDate ?? endDate!;
    const normalizedEnd = endDate ?? startDate!;
    const from = this.parseInventoryActivityDate(normalizedStart);
    const inclusiveEnd = this.parseInventoryActivityDate(normalizedEnd);

    if (from > inclusiveEnd) {
      throw new BadRequestException('Start date must be on or before end date');
    }

    const rangeDays = Math.floor((inclusiveEnd.getTime() - from.getTime()) / 86_400_000) + 1;
    if (rangeDays > 366) {
      throw new BadRequestException('Date range cannot exceed 366 days');
    }

    const to = new Date(inclusiveEnd);
    to.setUTCDate(to.getUTCDate() + 1);
    return { from, to };
  }

  private parseInventoryActivityDate(value: string) {
    const [year, month, day] = value.split('-').map(Number);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));

    if (
      calendarDate.getUTCFullYear() !== year
      || calendarDate.getUTCMonth() !== month - 1
      || calendarDate.getUTCDate() !== day
    ) {
      throw new BadRequestException('Dates must be valid calendar dates in YYYY-MM-DD format');
    }

    // WMS business dates follow Asia/Manila, which has a fixed UTC+08:00 offset.
    return new Date(calendarDate.getTime() - 8 * 60 * 60 * 1_000);
  }

  async getUnitMovements(id: string, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const unit = await this.prisma.wmsInventoryUnit.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
      },
    });

    if (!unit) {
      throw new NotFoundException('Inventory unit was not found');
    }

    if (unit.tenantId !== scope.activeTenantId) {
      throw new ForbiddenException('Selected tenant is outside your WMS scope');
    }

    const movements = await this.prisma.wmsInventoryMovement.findMany({
      where: {
        inventoryUnitId: unit.id,
      },
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
    });

    return {
      movements: movements.map((movement) => this.mapMovement(movement)),
    };
  }

  async getUnitTransferOptions(id: string, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const unit = await this.prisma.wmsInventoryUnit.findUnique({
      where: { id },
      include: {
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
            parentId: true,
            warehouseId: true,
          },
        },
      },
    });

    if (!unit) {
      throw new NotFoundException('Inventory unit was not found');
    }

    if (unit.tenantId !== scope.activeTenantId) {
      throw new ForbiddenException('Selected tenant is outside your WMS scope');
    }

    const [structuralLocations, operationalLocations] = await Promise.all([
      this.getActiveStructuralLocationsByWarehouse(unit.warehouseId),
      this.prisma.wmsLocation.findMany({
        where: {
          warehouseId: unit.warehouseId,
          isActive: true,
          kind: {
            in: [...TRANSFER_OPERATIONAL_LOCATION_KINDS],
          },
        },
        select: {
          id: true,
          code: true,
          name: true,
          kind: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
    ]);

    const structure = this.buildTransferStructureMaps(structuralLocations);
    const binOccupancyMap = await this.getBinOccupancyMap(
      structuralLocations
        .filter((location) => location.kind === WmsLocationKind.BIN)
        .map((location) => location.id),
    );

    return {
      unit: {
        id: unit.id,
        code: unit.code,
        status: unit.status,
        warehouse: unit.warehouse,
        currentLocation: unit.currentLocation
          ? {
              id: unit.currentLocation.id,
              code: unit.currentLocation.code,
              name: unit.currentLocation.name,
              kind: unit.currentLocation.kind,
              label: `${unit.warehouse.code} · ${unit.currentLocation.code}`,
            }
          : null,
      },
      sections: structure.sections.map((section) => ({
        id: section.id,
        code: section.code,
        name: section.name,
        label: `${section.code} · ${section.name}`,
        racks: (structure.racksBySectionId.get(section.id) ?? []).map((rack) => ({
          id: rack.id,
          code: rack.code,
          name: rack.name,
          label: `${rack.code} · ${rack.name}`,
          bins: (structure.binsByRackId.get(rack.id) ?? []).map((bin) => {
            const occupiedUnits = binOccupancyMap.get(bin.id) ?? 0;
            const availableUnits =
              bin.capacity === null ? null : Math.max(bin.capacity - occupiedUnits, 0);

            return {
              id: bin.id,
              code: bin.code,
              name: bin.name,
              label: `${bin.code} · ${bin.name}`,
              capacity: bin.capacity,
              occupiedUnits,
              availableUnits,
              isFull: bin.capacity !== null ? occupiedUnits >= bin.capacity : false,
            };
          }),
        })),
      })),
      operationalLocations: operationalLocations.map((location) => ({
        id: location.id,
        code: location.code,
        name: location.name,
        kind: location.kind,
        label: `${location.code} · ${location.name}`,
      })),
    };
  }

  async getTransfers(query: GetWmsInventoryTransfersDto) {
    const scope = await this.resolveTenantScope(query.tenantId);

    if (!scope.activeTenantId) {
      return {
        tenantReady: false,
        summary: {
          transfers: 0,
          movedUnits: 0,
        },
        filters: {
          tenants: scope.tenants,
          warehouses: [],
          activeTenantId: null,
          activeWarehouseId: null,
        },
        transfers: [],
      };
    }

    const transferCountScope: Prisma.WmsTransferWhereInput = {
      tenantId: scope.activeTenantId,
    };

    const [warehouses, warehouseCounts] = await Promise.all([
      this.prisma.wmsWarehouse.findMany({
        select: {
          id: true,
          code: true,
          name: true,
        },
        orderBy: [{ code: 'asc' }],
      }),
      this.prisma.wmsTransfer.groupBy({
        by: ['warehouseId'],
        where: transferCountScope,
        _count: {
          _all: true,
        },
      }),
    ]);

    const activeWarehouseId =
      query.warehouseId && warehouses.some((warehouse) => warehouse.id === query.warehouseId)
        ? query.warehouseId
        : null;

    const where: Prisma.WmsTransferWhereInput = {
      tenantId: scope.activeTenantId,
      ...(activeWarehouseId ? { warehouseId: activeWarehouseId } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { notes: { contains: query.search, mode: 'insensitive' } },
              { fromLocation: { code: { contains: query.search, mode: 'insensitive' } } },
              { fromLocation: { name: { contains: query.search, mode: 'insensitive' } } },
              { toLocation: { code: { contains: query.search, mode: 'insensitive' } } },
              { toLocation: { name: { contains: query.search, mode: 'insensitive' } } },
              {
                items: {
                  some: {
                    inventoryUnit: {
                      OR: [
                        { code: { contains: query.search, mode: 'insensitive' } },
                        { barcode: { contains: query.search, mode: 'insensitive' } },
                      ],
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [transfers, transferCount, movedUnits] = await Promise.all([
      this.prisma.wmsTransfer.findMany({
        where,
        include: {
          warehouse: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
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
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
      this.prisma.wmsTransfer.count({ where }),
      this.prisma.wmsTransferItem.count({
        where: {
          transfer: where,
        },
      }),
    ]);

    const warehouseCountMap = new Map(
      warehouseCounts.map((record) => [record.warehouseId, record._count._all]),
    );

    return {
      tenantReady: true,
      summary: {
        transfers: transferCount,
        movedUnits,
      },
      filters: {
        tenants: scope.tenants,
        warehouses: warehouses.map((warehouse) => ({
          id: warehouse.id,
          code: warehouse.code,
          label: warehouse.name,
          transferCount: warehouseCountMap.get(warehouse.id) ?? 0,
        })),
        activeTenantId: scope.activeTenantId,
        activeWarehouseId,
      },
      transfers: transfers.map((transfer) => this.mapTransfer(transfer)),
    };
  }

  async getStoreTransferOptions(query: GetWmsInventoryStoreTransferOptionsDto) {
    const scope = await this.resolveTenantScope(query.tenantId);

    if (!scope.activeTenantId) {
      return {
        tenantReady: false,
        stores: [],
        products: [],
        activeTenantId: null,
        activeTargetStoreId: null,
      };
    }

    const stores = await this.prisma.posStore.findMany({
      where: {
        tenantId: scope.activeTenantId,
      },
      select: {
        id: true,
        name: true,
        shopName: true,
      },
      orderBy: [{ name: 'asc' }],
    });

    const activeTargetStoreId =
      query.targetStoreId && stores.some((store) => store.id === query.targetStoreId)
        ? query.targetStoreId
        : null;

    const products = activeTargetStoreId
      ? await this.prisma.wmsProductProfile.findMany({
          where: {
            tenantId: scope.activeTenantId,
            storeId: activeTargetStoreId,
            status: {
              not: WmsProductProfileStatus.ARCHIVED,
            },
            ...(query.search
              ? {
                  OR: [
                    { productId: { contains: query.search, mode: 'insensitive' } },
                    { variationId: { contains: query.search, mode: 'insensitive' } },
                    {
                      posProduct: {
                        name: { contains: query.search, mode: 'insensitive' },
                      },
                    },
                    {
                      posProduct: {
                        customId: { contains: query.search, mode: 'insensitive' },
                      },
                    },
                  ],
                }
              : {}),
          },
          include: {
            posProduct: {
              select: {
                id: true,
                productId: true,
                variationId: true,
                customId: true,
                productSnapshot: true,
                name: true,
              },
            },
          },
          orderBy: [{ updatedAt: 'desc' }],
          take: 200,
        })
      : [];
    const [sourceProfile, savedEquivalence] = await Promise.all([
      query.sourceProfileId
        ? this.prisma.wmsProductProfile.findFirst({
            where: {
              id: query.sourceProfileId,
              tenantId: scope.activeTenantId,
            },
            include: {
              posProduct: {
                select: {
                  id: true,
                  productId: true,
                  variationId: true,
                  customId: true,
                  productSnapshot: true,
                  name: true,
                },
              },
            },
          })
        : Promise.resolve(null),
      query.sourceProfileId && activeTargetStoreId
        ? this.prisma.wmsProductProfileEquivalence.findFirst({
            where: {
              tenantId: scope.activeTenantId,
              sourceProfileId: query.sourceProfileId,
              targetStoreId: activeTargetStoreId,
            },
          })
        : Promise.resolve(null),
    ]);

    const isSameStoreTarget = Boolean(
      sourceProfile
      && activeTargetStoreId
      && sourceProfile.storeId === activeTargetStoreId,
    );
    const mappedProducts = products
      .filter((profile) => (
        this.isStockableVariation(profile.posProduct.productId, profile.posProduct.variationId)
        && this.isStockableVariation(profile.productId, profile.variationId)
        && !(isSameStoreTarget && profile.variationId === sourceProfile?.variationId)
      ))
      .map((profile) =>
        this.mapStoreTransferProductOption(profile, sourceProfile?.stockPoolGroupId ?? null),
      );
    const suggestion = this.resolveStoreTransferSuggestion({
      sourceProfile,
      products: mappedProducts,
      savedEquivalence: isSameStoreTarget ? null : savedEquivalence,
    });
    const sortedProducts = suggestion
      ? [
          ...mappedProducts.filter((product) => product.profileId === suggestion.profileId),
          ...mappedProducts.filter((product) => product.profileId !== suggestion.profileId),
        ]
      : mappedProducts;

    return {
      tenantReady: true,
      activeTenantId: scope.activeTenantId,
      activeTargetStoreId,
      stores: stores.map((store) => ({
        id: store.id,
        label: store.shopName || store.name,
      })),
      products: sortedProducts,
      suggestion,
    };
  }

  async previewStoreTransfer(body: CreateWmsInventoryStoreTransferDto, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const uniqueUnitIds = Array.from(new Set(body.unitIds));
    const blockers: Array<{ code: string; message: string }> = [];
    const warnings: Array<{ code: string; message: string; severity: 'warning' | 'critical' }> = [];

    if (uniqueUnitIds.length === 0) {
      blockers.push({
        code: 'NO_UNITS_SELECTED',
        message: 'Select at least one stock unit',
      });
    }

    const [targetStore, targetProfile] = await Promise.all([
      this.prisma.posStore.findFirst({
        where: {
          id: body.targetStoreId,
          tenantId: scope.activeTenantId,
        },
        select: {
          id: true,
          name: true,
          shopName: true,
        },
      }),
      this.prisma.wmsProductProfile.findFirst({
        where: {
          id: body.targetProfileId,
          tenantId: scope.activeTenantId,
          storeId: body.targetStoreId,
          status: {
            not: WmsProductProfileStatus.ARCHIVED,
          },
        },
        include: {
          posProduct: {
            select: {
              productId: true,
              variationId: true,
              customId: true,
              productSnapshot: true,
              name: true,
            },
          },
        },
      }),
    ]);
    const units = uniqueUnitIds.length
      ? await this.prisma.wmsInventoryUnit.findMany({
          where: {
            id: {
              in: uniqueUnitIds,
            },
            tenantId: scope.activeTenantId,
          },
          include: {
            store: {
              select: {
                id: true,
                name: true,
                shopName: true,
              },
            },
            posProduct: {
              select: {
                name: true,
                customId: true,
                productSnapshot: true,
              },
            },
            pickReservations: {
              where: {
                status: {
                  in: [WmsPickReservationStatus.RESERVED, WmsPickReservationStatus.PICKED],
                },
              },
              select: {
                id: true,
              },
            },
          },
        })
      : [];

    if (!targetStore) {
      blockers.push({
        code: 'INVALID_TARGET_STORE',
        message: 'Target store is not valid for this tenant',
      });
    }

    if (!targetProfile) {
      blockers.push({
        code: 'INVALID_TARGET_PRODUCT',
        message: 'Target product profile is not valid for the selected store',
      });
    } else {
      if (!this.isStockableVariation(targetProfile.posProduct.productId, targetProfile.posProduct.variationId)) {
        blockers.push({
          code: 'TARGET_PRODUCT_NOT_STOCKABLE',
          message: `Target product is not stockable: ${this.getStockabilityReason(
            targetProfile.posProduct.productId,
            targetProfile.posProduct.variationId,
          )}`,
        });
      }

      if (!this.isStockableVariation(targetProfile.productId, targetProfile.variationId)) {
        blockers.push({
          code: 'TARGET_PROFILE_LEGACY_VARIATION',
          message: 'Target product profile still uses a legacy variation mapping. Sync this product first.',
        });
      }
    }

    if (units.length !== uniqueUnitIds.length) {
      blockers.push({
        code: 'MISSING_UNITS',
        message: 'One or more selected units no longer exist',
      });
    }

    const sourceUnit = units[0] ?? null;
    const sourceStoreId = sourceUnit?.storeId ?? null;
    const sourceVariationId = sourceUnit?.variationId ?? null;
    const sourceProfileId = sourceUnit?.productProfileId ?? null;

    if (
      sourceUnit
      && targetStore
      && targetProfile
      && sourceStoreId === targetStore.id
      && sourceVariationId === targetProfile.variationId
    ) {
      blockers.push({
        code: 'SAME_VARIANT',
        message: 'Select a different target variant when changing stock within the same store',
      });
    }

    for (const unit of units) {
      if (sourceStoreId && unit.storeId !== sourceStoreId) {
        blockers.push({
          code: 'MIXED_SOURCE_STORE',
          message: 'Selected units must come from the same source store',
        });
        break;
      }
    }

    for (const unit of units) {
      if (
        sourceVariationId
        && sourceProfileId
        && (unit.variationId !== sourceVariationId || unit.productProfileId !== sourceProfileId)
      ) {
        blockers.push({
          code: 'MIXED_SOURCE_PRODUCT',
          message: 'Selected units must share the same source product and variation',
        });
        break;
      }
    }

    const invalidStatusUnits = units.filter((unit) => !STORE_TRANSFERABLE_UNIT_STATUSES.has(unit.status));
    if (invalidStatusUnits.length) {
      blockers.push({
        code: 'INVALID_UNIT_STATUS',
        message: `${invalidStatusUnits.length} selected unit${invalidStatusUnits.length === 1 ? '' : 's'} cannot change variant from the current status`,
      });
    }

    const reservedUnits = units.filter((unit) => unit.pickReservations.length > 0);
    if (reservedUnits.length) {
      blockers.push({
        code: 'RESERVED_UNITS',
        message: `${reservedUnits.length} selected unit${reservedUnits.length === 1 ? '' : 's'} already reserved for picking and cannot change variant`,
      });
    }

    const sourceAvailableUnits = sourceStoreId && sourceProfileId && sourceVariationId
      ? await this.prisma.wmsInventoryUnit.count({
          where: {
            tenantId: scope.activeTenantId,
            storeId: sourceStoreId,
            productProfileId: sourceProfileId,
            variationId: sourceVariationId,
            status: {
              in: Array.from(STORE_TRANSFERABLE_UNIT_STATUSES),
            },
            pickReservations: {
              none: {
                status: {
                  in: [WmsPickReservationStatus.RESERVED, WmsPickReservationStatus.PICKED],
                },
              },
            },
          },
        })
      : 0;

    const demandLines = sourceStoreId && sourceVariationId
      ? await this.prisma.wmsFulfillmentLine.findMany({
          where: {
            tenantId: scope.activeTenantId,
            variationId: sourceVariationId,
            status: {
              not: WmsFulfillmentLineStatus.CANCELED,
            },
            quantityRequired: {
              gt: 0,
            },
            fulfillmentOrder: {
              storeId: sourceStoreId,
              status: {
                in: [...STORE_TRANSFER_DEMAND_ORDER_STATUSES],
              },
            },
          },
          select: {
            fulfillmentOrderId: true,
            quantityRequired: true,
            reservations: {
              where: {
                status: {
                  in: [WmsPickReservationStatus.RESERVED, WmsPickReservationStatus.PICKED],
                },
              },
              select: {
                id: true,
              },
            },
          },
        })
      : [];

    const activeDemandUnits = demandLines.reduce(
      (sum, line) => sum + Math.max(line.quantityRequired - line.reservations.length, 0),
      0,
    );
    const activeDemandOrders = new Set(
      demandLines
        .filter((line) => Math.max(line.quantityRequired - line.reservations.length, 0) > 0)
        .map((line) => line.fulfillmentOrderId),
    ).size;
    const selectedUnits = uniqueUnitIds.length;
    const remainingAvailableUnits = Math.max(sourceAvailableUnits - selectedUnits, 0);

    if (activeDemandUnits > 0) {
      warnings.push({
        code: 'ACTIVE_PICK_DEMAND',
        severity: 'warning',
        message: `${sourceUnit?.store.shopName || sourceUnit?.store.name || 'Source store'} has ${activeDemandUnits} active pick demand unit${activeDemandUnits === 1 ? '' : 's'} for this product across ${activeDemandOrders} order${activeDemandOrders === 1 ? '' : 's'}.`,
      });
    }

    if (sourceAvailableUnits > 0 && selectedUnits >= sourceAvailableUnits) {
      warnings.push({
        code: 'TRANSFER_ALL_AVAILABLE',
        severity: 'critical',
        message: `This changes all ${sourceAvailableUnits} available unit${sourceAvailableUnits === 1 ? '' : 's'} from the source product variant.`,
      });
    }

    if (activeDemandUnits > 0 && remainingAvailableUnits < activeDemandUnits) {
      warnings.push({
        code: 'DEMAND_EXCEEDS_REMAINING',
        severity: 'critical',
        message: `After this change, ${remainingAvailableUnits} available unit${remainingAvailableUnits === 1 ? '' : 's'} will remain, below the active demand of ${activeDemandUnits}.`,
      });
    }

    return {
      valid: blockers.length === 0,
      selectedUnits,
      sourceAvailableUnits,
      remainingAvailableUnits,
      activeDemandUnits,
      activeDemandOrders,
      sourceStore: sourceUnit
        ? {
            id: sourceUnit.store.id,
            name: sourceUnit.store.shopName || sourceUnit.store.name,
          }
        : null,
      sourceProduct: sourceUnit
        ? {
            profileId: sourceUnit.productProfileId,
            name: sourceUnit.posProduct.name,
            variationId: sourceUnit.variationId,
            variationDisplayId: this.resolveVariationDisplayId(sourceUnit.posProduct.productSnapshot),
          }
        : null,
      targetStore: targetStore
        ? {
            id: targetStore.id,
            name: targetStore.shopName || targetStore.name,
          }
        : null,
      targetProduct: targetProfile
        ? {
            profileId: targetProfile.id,
            name: targetProfile.posProduct.name,
            variationId: targetProfile.variationId,
            variationDisplayId: this.resolveVariationDisplayId(targetProfile.posProduct.productSnapshot),
          }
        : null,
      blockers,
      warnings,
    };
  }

  async createStoreTransfer(body: CreateWmsInventoryStoreTransferDto, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const uniqueUnitIds = Array.from(new Set(body.unitIds));

    if (uniqueUnitIds.length === 0) {
      throw new BadRequestException('Select at least one stock unit');
    }

    const [targetStore, targetProfile] = await Promise.all([
      this.prisma.posStore.findFirst({
        where: {
          id: body.targetStoreId,
          tenantId: scope.activeTenantId,
        },
        select: {
          id: true,
          name: true,
          shopName: true,
        },
      }),
      this.prisma.wmsProductProfile.findFirst({
        where: {
          id: body.targetProfileId,
          tenantId: scope.activeTenantId,
          storeId: body.targetStoreId,
          status: {
            not: WmsProductProfileStatus.ARCHIVED,
          },
        },
        include: {
          posProduct: {
            select: {
              id: true,
              productId: true,
              variationId: true,
              customId: true,
              productSnapshot: true,
              name: true,
            },
          },
        },
      }),
    ]);

    if (!targetStore) {
      throw new BadRequestException('Target store is not valid for this tenant');
    }

    if (!targetProfile) {
      throw new BadRequestException('Target product profile is not valid for the selected store');
    }

    if (!this.isStockableVariation(targetProfile.posProduct.productId, targetProfile.posProduct.variationId)) {
      throw new BadRequestException(
        `Target product is not stockable: ${this.getStockabilityReason(
          targetProfile.posProduct.productId,
          targetProfile.posProduct.variationId,
        )}`,
      );
    }

    if (!this.isStockableVariation(targetProfile.productId, targetProfile.variationId)) {
      throw new BadRequestException('Target product profile still uses a legacy variation mapping. Sync this product first.');
    }

    const transferCode = this.buildStoreTransferCode();
    const notes = this.cleanOptionalText(body.notes);
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const units = await tx.wmsInventoryUnit.findMany({
        where: {
          id: {
            in: uniqueUnitIds,
          },
          tenantId: scope.activeTenantId!,
        },
        include: {
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
              name: true,
              kind: true,
            },
          },
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
              productSnapshot: true,
            },
          },
          pickReservations: {
            where: {
              status: {
                in: [WmsPickReservationStatus.RESERVED, WmsPickReservationStatus.PICKED],
              },
            },
            select: {
              id: true,
            },
          },
        },
      });

      if (units.length !== uniqueUnitIds.length) {
        throw new BadRequestException('One or more selected units no longer exist');
      }

      const sourceStoreId = units[0].storeId;
      const sourceVariationId = units[0].variationId;
      const sourceProductProfileId = units[0].productProfileId;
      const isSameStoreChange = sourceStoreId === targetStore.id;

      if (isSameStoreChange && sourceVariationId === targetProfile.variationId) {
        throw new BadRequestException('Select a different target variant when changing stock within the same store');
      }

      units.forEach((unit) => {
        if (unit.tenantId !== scope.activeTenantId) {
          throw new ForbiddenException('One or more selected units are outside your WMS scope');
        }

        if (unit.storeId !== sourceStoreId) {
          throw new BadRequestException('Selected units must come from the same source store');
        }

        if (unit.variationId !== sourceVariationId || unit.productProfileId !== sourceProductProfileId) {
          throw new BadRequestException('Selected units must share the same source product and variation');
        }

        if (!STORE_TRANSFERABLE_UNIT_STATUSES.has(unit.status)) {
          throw new BadRequestException(`Unit ${unit.code} cannot change variant from status ${unit.status}`);
        }

        if (unit.pickReservations.length > 0) {
          throw new BadRequestException(`Unit ${unit.code} is already reserved and cannot change variant`);
        }
      });

      const storeTransfer = await tx.wmsInventoryStoreTransfer.create({
        data: {
          code: transferCode,
          tenantId: scope.activeTenantId!,
          fromStoreId: sourceStoreId,
          toStoreId: targetStore.id,
          targetProfileId: targetProfile.id,
          notes,
          createdById: actorId,
          updatedById: actorId,
        },
      });

      await tx.wmsInventoryStoreTransferItem.createMany({
        data: units.map((unit, index) => ({
          transferId: storeTransfer.id,
          inventoryUnitId: unit.id,
          lineNo: index + 1,
          fromStoreId: unit.storeId,
          toStoreId: targetStore.id,
          fromPosProductId: unit.posProductId,
          toPosProductId: targetProfile.posProductId,
          fromProductProfileId: unit.productProfileId,
          toProductProfileId: targetProfile.id,
          fromProductId: unit.productId,
          toProductId: targetProfile.productId,
          fromVariationId: unit.variationId,
          toVariationId: targetProfile.variationId,
          unitCost: unit.unitCost,
        })),
      });

      if (!isSameStoreChange) {
        await tx.wmsProductProfileEquivalence.upsert({
          where: {
            tenantId_sourceProfileId_targetStoreId: {
              tenantId: scope.activeTenantId!,
              sourceProfileId: sourceProductProfileId,
              targetStoreId: targetStore.id,
            },
          },
          create: {
            tenantId: scope.activeTenantId!,
            sourceStoreId,
            targetStoreId: targetStore.id,
            sourceProfileId: sourceProductProfileId,
            targetProfileId: targetProfile.id,
            sourceVariationId,
            targetVariationId: targetProfile.variationId,
            matchSource: 'TRANSFER',
            transferCount: 1,
            lastTransferAt: now,
            createdById: actorId,
            updatedById: actorId,
          },
          update: {
            targetProfileId: targetProfile.id,
            targetVariationId: targetProfile.variationId,
            matchSource: 'TRANSFER',
            transferCount: {
              increment: 1,
            },
            lastTransferAt: now,
            updatedById: actorId,
          },
        });
      }

      const poolLinkResult =
        body.shareStockPool === true && sourceProductProfileId
          ? await linkProfilesIntoSharedStockPoolTx(tx, {
              tenantId: scope.activeTenantId!,
              profileIds: [sourceProductProfileId, targetProfile.id],
            })
          : null;

      await tx.wmsInventoryMovement.createMany({
        data: units.map((unit) => ({
          tenantId: scope.activeTenantId!,
          inventoryUnitId: unit.id,
          warehouseId: unit.warehouseId,
          fromLocationId: unit.currentLocationId,
          toLocationId: unit.currentLocationId,
          fromStatus: unit.status,
          toStatus: unit.status,
          movementType: WmsInventoryMovementType.ADJUSTMENT,
          referenceType: 'STORE_TRANSFER',
          referenceId: storeTransfer.id,
          referenceCode: storeTransfer.code,
          notes,
          actorId,
          createdAt: now,
        })),
      });

      await tx.wmsInventoryUnit.updateMany({
        where: {
          id: {
            in: units.map((unit) => unit.id),
          },
        },
        data: {
          storeId: targetStore.id,
          posProductId: targetProfile.posProductId,
          productProfileId: targetProfile.id,
          productId: targetProfile.productId,
          variationId: targetProfile.variationId,
          // A same-store variant correction is physical WMS stock, not stock received
          // for one specific POS warehouse. Keep it eligible for orders from any POS
          // warehouse mapped to this store while retaining the physical WMS scope.
          posWarehouseRef: isSameStoreChange ? null : targetProfile.posWarehouseRef ?? null,
          ...(actorId ? { updatedById: actorId } : {}),
        },
      });

      const updatedUnits = await tx.wmsInventoryUnit.findMany({
        where: {
          id: {
            in: units.map((unit) => unit.id),
          },
        },
        include: {
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
              name: true,
              kind: true,
            },
          },
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
              productSnapshot: true,
            },
          },
        },
        orderBy: [{ code: 'asc' }],
      });

      return {
        transfer: storeTransfer,
        units: updatedUnits,
        sourceVariationId,
        poolLinkResult,
      };
    });

    const fulfillmentRefreshScopes = new Map<string, Set<string>>();
    const addRefreshScope = (storeId: string, variationId: string) => {
      const variationIds = fulfillmentRefreshScopes.get(storeId) ?? new Set<string>();
      variationIds.add(variationId);
      fulfillmentRefreshScopes.set(storeId, variationIds);
    };

    addRefreshScope(result.transfer.fromStoreId, result.sourceVariationId);
    addRefreshScope(result.transfer.toStoreId, targetProfile.variationId);
    for (const affected of result.poolLinkResult?.affectedScopes ?? []) {
      addRefreshScope(affected.storeId, affected.variationId);
    }

    for (const [storeId, variationIds] of fulfillmentRefreshScopes) {
      await this.wmsFulfillmentSyncService.refreshDemandQueueForScope({
        tenantId: scope.activeTenantId,
        storeId,
        variationIds: Array.from(variationIds),
        limit: null,
      });
    }

    await this.recordInventoryActivity({
      tenantId: scope.activeTenantId,
      actionType: 'INVENTORY_STORE_TRANSFER',
      resourceType: 'WMS_INVENTORY_STORE_TRANSFER',
      resourceId: result.transfer.id,
      metadata: {
        transferCode: result.transfer.code,
        fromStoreId: result.transfer.fromStoreId,
        toStoreId: result.transfer.toStoreId,
        targetProfileId: result.transfer.targetProfileId,
        sourceVariationId: result.sourceVariationId,
        targetVariationId: targetProfile.variationId,
        unitCount: result.units.length,
        changeScope: result.transfer.fromStoreId === result.transfer.toStoreId ? 'SAME_STORE' : 'CROSS_STORE',
        shareStockPool: Boolean(body.shareStockPool),
        stockPoolGroupId: result.poolLinkResult?.stockPoolGroupId ?? null,
      },
    });

    return {
      transfer: {
        id: result.transfer.id,
        code: result.transfer.code,
        itemCount: result.units.length,
        fromStoreId: result.transfer.fromStoreId,
        toStoreId: result.transfer.toStoreId,
        targetProfileId: result.transfer.targetProfileId,
        notes: result.transfer.notes,
        createdAt: result.transfer.createdAt,
      },
      units: result.units.map((unit) => this.mapUnit(unit)),
    };
  }

  async createTransfer(body: CreateWmsInventoryTransferDto, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const notes = this.cleanOptionalText(body.notes);

    const units = await this.prisma.wmsInventoryUnit.findMany({
      where: {
        id: {
          in: body.unitIds,
        },
      },
      include: {
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
            warehouseId: true,
            parentId: true,
            isActive: true,
          },
        },
      },
    });

    if (units.length !== body.unitIds.length) {
      throw new BadRequestException('One or more selected units no longer exist');
    }

    units.forEach((unit) => {
      if (unit.tenantId !== scope.activeTenantId) {
        throw new ForbiddenException('One or more selected units are outside your WMS scope');
      }

      if (!unit.currentLocationId || !unit.currentLocation) {
        throw new BadRequestException(`Unit ${unit.code} is missing a current location`);
      }

      if (!TRANSFERABLE_UNIT_STATUSES.has(unit.status)) {
        throw new BadRequestException(`Unit ${unit.code} cannot be transferred from status ${unit.status}`);
      }
    });

    const sourceLocationId = units[0].currentLocationId!;
    const warehouseId = units[0].warehouseId;

    if (units.some((unit) => unit.currentLocationId !== sourceLocationId)) {
      throw new BadRequestException('Selected units must come from the same source location');
    }

    if (units.some((unit) => unit.warehouseId !== warehouseId)) {
      throw new BadRequestException('Selected units must belong to the same warehouse');
    }

    const targetLocation = await this.prisma.wmsLocation.findFirst({
      where: {
        id: body.targetLocationId,
        warehouseId,
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
    });

    if (!targetLocation) {
      throw new BadRequestException('Target location is not valid for the warehouse');
    }

    if (targetLocation.id === sourceLocationId) {
      throw new BadRequestException('Target location must be different from the source location');
    }

    if (!this.isTransferDestinationKindAllowed(targetLocation.kind)) {
      throw new BadRequestException('Target location kind is not supported for internal transfer');
    }

    const nextStatus = this.resolveTransferTargetStatus(units[0].status, targetLocation.kind);

    if (targetLocation.kind === WmsLocationKind.BIN && targetLocation.capacity === null) {
      throw new BadRequestException(`Bin ${targetLocation.code} is missing a capacity setting`);
    }

    const transferCode = this.buildTransferCode();
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      if (targetLocation.kind === WmsLocationKind.BIN) {
        const occupiedUnits = await tx.wmsInventoryUnit.count({
          where: {
            currentLocationId: targetLocation.id,
          },
        });
        const availableUnits = Math.max((targetLocation.capacity ?? 0) - occupiedUnits, 0);

        if (units.length > availableUnits) {
          throw new BadRequestException(
            `Bin ${targetLocation.code} has space for ${availableUnits} more unit${availableUnits === 1 ? '' : 's'}, but ${units.length} were selected`,
          );
        }
      }

      const transfer = await tx.wmsTransfer.create({
        data: {
          code: transferCode,
          tenantId: scope.activeTenantId!,
          warehouseId,
          fromLocationId: sourceLocationId,
          toLocationId: targetLocation.id,
          status: WmsTransferStatus.COMPLETED,
          notes,
          createdById: actorId,
          updatedById: actorId,
        },
      });

      await tx.wmsTransferItem.createMany({
        data: units.map((unit, index) => ({
          transferId: transfer.id,
          inventoryUnitId: unit.id,
          lineNo: index + 1,
        })),
      });

      for (const unit of units) {
        await tx.wmsInventoryUnit.update({
          where: { id: unit.id },
          data: {
            currentLocationId: targetLocation.id,
            status: nextStatus,
            ...(actorId ? { updatedById: actorId } : {}),
          },
        });
      }

      await tx.wmsInventoryMovement.createMany({
        data: units.map((unit) => ({
          tenantId: scope.activeTenantId!,
          inventoryUnitId: unit.id,
          warehouseId: unit.warehouseId,
          fromLocationId: unit.currentLocationId,
          toLocationId: targetLocation.id,
          fromStatus: unit.status,
          toStatus: nextStatus,
          movementType: WmsInventoryMovementType.TRANSFER,
          referenceType: 'TRANSFER',
          referenceId: transfer.id,
          referenceCode: transfer.code,
          notes,
          actorId,
          createdAt: now,
        })),
      });

      const updatedUnits = await tx.wmsInventoryUnit.findMany({
        where: {
          id: {
            in: units.map((unit) => unit.id),
          },
        },
        include: {
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
              name: true,
              kind: true,
            },
          },
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
              productSnapshot: true,
            },
          },
        },
        orderBy: [{ code: 'asc' }],
      });

      return {
        transfer,
        units: updatedUnits.map((unit) => this.mapUnit(unit)),
      };
    });

    return result;
  }

  async createAdjustment(body: CreateWmsInventoryAdjustmentDto, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    if (!ADJUSTABLE_UNIT_TARGET_STATUSES.has(body.targetStatus)) {
      throw new BadRequestException(`Status ${body.targetStatus} is not supported for inventory adjustment`);
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const notes = this.cleanOptionalText(body.notes);

    const units = await this.prisma.wmsInventoryUnit.findMany({
      where: {
        id: {
          in: body.unitIds,
        },
      },
      include: {
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
            name: true,
            kind: true,
            warehouseId: true,
            parentId: true,
            isActive: true,
          },
        },
        posProduct: {
          select: {
            id: true,
            name: true,
            customId: true,
            productSnapshot: true,
          },
        },
        pickReservations: {
          where: {
            status: {
              in: [...ACTIVE_PICK_RESERVATION_STATUSES],
            },
          },
          include: {
            fulfillmentOrder: {
              select: {
                id: true,
                status: true,
                posOrderId: true,
              },
            },
          },
        },
        basketUnits: {
          where: {
            status: {
              in: [...ACTIVE_BASKET_UNIT_HOLD_STATUSES],
            },
          },
          select: {
            id: true,
            status: true,
            fulfillmentOrderId: true,
            fulfillmentLineId: true,
          },
        },
      },
    });

    if (units.length !== body.unitIds.length) {
      throw new BadRequestException('One or more selected units no longer exist');
    }

    units.forEach((unit) => {
      if (unit.tenantId !== scope.activeTenantId) {
        throw new ForbiddenException('One or more selected units are outside your WMS scope');
      }
    });

    const warehouseId = units[0].warehouseId;

    if (
      body.targetStatus !== WmsInventoryUnitStatus.ARCHIVED
      && units.some((unit) => unit.warehouseId !== warehouseId)
    ) {
      throw new BadRequestException('Selected units must belong to the same warehouse');
    }

    if (body.targetStatus === WmsInventoryUnitStatus.ARCHIVED) {
      const invalidSourceUnit = units.find((unit) => !ARCHIVABLE_ADJUSTMENT_SOURCE_STATUSES.has(unit.status));
      if (invalidSourceUnit) {
        throw new BadRequestException(
          `Unit ${invalidSourceUnit.code} cannot be archived from status ${invalidSourceUnit.status}`,
        );
      }

      const pickedReservationUnit = units.find((unit) => (
        unit.pickReservations.some((reservation) => reservation.status === WmsPickReservationStatus.PICKED)
      ));
      if (pickedReservationUnit) {
        throw new BadRequestException(
          `Unit ${pickedReservationUnit.code} is already picked and cannot be archived from inventory`,
        );
      }

      const blockedReservationUnit = units.find((unit) => (
        unit.pickReservations.some((reservation) => (
          VOID_BLOCKED_FULFILLMENT_ORDER_STATUSES.has(reservation.fulfillmentOrder.status)
        ))
      ));
      if (blockedReservationUnit) {
        const blockedReservation = blockedReservationUnit.pickReservations.find((reservation) => (
          VOID_BLOCKED_FULFILLMENT_ORDER_STATUSES.has(reservation.fulfillmentOrder.status)
        ));
        throw new BadRequestException(
          `Unit ${blockedReservationUnit.code} is attached to active fulfillment order ${blockedReservation?.fulfillmentOrder.posOrderId ?? blockedReservation?.fulfillmentOrder.id} and cannot be archived with bulk action`,
        );
      }
    }

    const targetLocationKind = this.getRequiredAdjustmentLocationKind(body.targetStatus);
    const targetLocationKinds = this.getAllowedAdjustmentLocationKinds(body.targetStatus);
    let targetLocation:
      | {
          id: string;
          code: string;
          name: string;
          kind: WmsLocationKind;
          warehouseId: string;
          capacity: number | null;
        }
      | null = null;

    if (targetLocationKinds.length === 0) {
      if (body.targetLocationId) {
        throw new BadRequestException(`Status ${body.targetStatus} should not include a destination location`);
      }
    } else {
      if (!body.targetLocationId) {
        throw new BadRequestException(`Status ${body.targetStatus} requires a destination location`);
      }

      targetLocation = await this.prisma.wmsLocation.findFirst({
        where: {
          id: body.targetLocationId,
          warehouseId,
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
      });

      if (!targetLocation) {
        throw new BadRequestException('Adjustment destination is not valid for the warehouse');
      }

      const confirmedTargetLocation = targetLocation;

      if (!targetLocationKinds.some((kind) => kind === confirmedTargetLocation.kind)) {
        throw new BadRequestException(
          `Status ${body.targetStatus} requires a ${targetLocationKind}, but ${confirmedTargetLocation.code} is ${confirmedTargetLocation.kind}`,
        );
      }

      if (confirmedTargetLocation.kind === WmsLocationKind.BIN && confirmedTargetLocation.capacity === null) {
        throw new BadRequestException(`Bin ${confirmedTargetLocation.code} is missing a capacity setting`);
      }
    }

    const adjustmentCode = this.buildAdjustmentCode();
    const now = new Date();
    const affectedFulfillmentOrderIds = body.targetStatus === WmsInventoryUnitStatus.ARCHIVED
      ? Array.from(new Set(
          units.flatMap((unit) => unit.pickReservations.map((reservation) => reservation.fulfillmentOrderId)),
        ))
      : [];

    const result = await this.prisma.$transaction(async (tx) => {
      if (targetLocation?.kind === WmsLocationKind.BIN) {
        const occupiedUnits = await tx.wmsInventoryUnit.count({
          where: {
            currentLocationId: targetLocation.id,
          },
        });
        const availableUnits = Math.max((targetLocation.capacity ?? 0) - occupiedUnits, 0);

        if (units.length > availableUnits) {
          throw new BadRequestException(
            `Bin ${targetLocation.code} has space for ${availableUnits} more unit${availableUnits === 1 ? '' : 's'}, but ${units.length} were selected`,
          );
        }
      }

      for (const unit of units) {
        await this.releaseOrphanBasketUnitHoldsTx(tx, {
          unit,
          nextStatus: body.targetStatus,
          actorId,
          now,
        });

        if (body.targetStatus === WmsInventoryUnitStatus.ARCHIVED && unit.pickReservations.length > 0) {
          await tx.wmsPickReservation.updateMany({
            where: {
              inventoryUnitId: unit.id,
              status: WmsPickReservationStatus.RESERVED,
            },
            data: {
              status: WmsPickReservationStatus.RELEASED,
            },
          });
        }

        await tx.wmsInventoryUnit.update({
          where: { id: unit.id },
          data: {
            currentLocationId: targetLocation?.id ?? null,
            status: body.targetStatus,
            ...(actorId ? { updatedById: actorId } : {}),
          },
        });
      }

      await tx.wmsInventoryMovement.createMany({
        data: units.map((unit) => ({
          tenantId: scope.activeTenantId!,
          inventoryUnitId: unit.id,
          warehouseId: unit.warehouseId,
          fromLocationId: unit.currentLocationId,
          toLocationId: targetLocation?.id ?? null,
          fromStatus: unit.status,
          toStatus: body.targetStatus,
          movementType: WmsInventoryMovementType.ADJUSTMENT,
          referenceType: 'ADJUSTMENT',
          referenceCode: adjustmentCode,
          notes,
          actorId,
          createdAt: now,
        })),
      });

      if (body.targetStatus === WmsInventoryUnitStatus.ARCHIVED) {
        for (const fulfillmentOrderId of affectedFulfillmentOrderIds) {
          await this.refreshFulfillmentOrderStateAfterInventoryVoid(tx, fulfillmentOrderId, now);
        }
      }

      const updatedUnits = await tx.wmsInventoryUnit.findMany({
        where: {
          id: {
            in: units.map((unit) => unit.id),
          },
        },
        include: {
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
              name: true,
              kind: true,
            },
          },
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
              productSnapshot: true,
            },
          },
        },
        orderBy: [{ code: 'asc' }],
      });

      return {
        adjustment: {
          code: adjustmentCode,
          unitCount: units.length,
          targetStatus: body.targetStatus,
          targetLocation: targetLocation
            ? {
                id: targetLocation.id,
                code: targetLocation.code,
                name: targetLocation.name,
                kind: targetLocation.kind,
                label: `${units[0].warehouse.code} · ${targetLocation.code}`,
              }
            : null,
          createdAt: now,
        },
        units: updatedUnits.map((unit) => this.mapUnit(unit)),
      };
    });

    return result;
  }

  async voidUnit(
    id: string,
    body: VoidWmsInventoryUnitDto,
    requestedTenantId?: string,
  ) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const reason = body.reason.trim();
    const notes = this.cleanOptionalText(body.notes);
    const now = new Date();

    if (!reason) {
      throw new BadRequestException('Void reason is required');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const unit = await tx.wmsInventoryUnit.findFirst({
        where: {
          id,
          tenantId: scope.activeTenantId!,
        },
        include: {
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
              name: true,
              kind: true,
            },
          },
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
              productSnapshot: true,
            },
          },
          pickReservations: {
            where: {
              status: {
                in: [...ACTIVE_PICK_RESERVATION_STATUSES],
              },
            },
            include: {
              fulfillmentOrder: {
                select: {
                  id: true,
                  status: true,
                  posOrderId: true,
                },
              },
            },
          },
          basketUnits: {
            where: {
              status: {
                in: [...ACTIVE_BASKET_UNIT_HOLD_STATUSES],
              },
            },
            select: {
              id: true,
              status: true,
              fulfillmentOrderId: true,
              fulfillmentLineId: true,
            },
          },
        },
      });

      if (!unit) {
        throw new NotFoundException('Inventory unit was not found');
      }

      if (!VOIDABLE_UNIT_STATUSES.has(unit.status)) {
        throw new BadRequestException(`Unit ${unit.code} cannot be voided from status ${unit.status}`);
      }

      const pickedReservation = unit.pickReservations.find(
        (reservation) => reservation.status === WmsPickReservationStatus.PICKED,
      );
      if (pickedReservation) {
        throw new BadRequestException(`Unit ${unit.code} is already picked and cannot be voided from inventory`);
      }

      const blockedReservation = unit.pickReservations.find((reservation) =>
        VOID_BLOCKED_FULFILLMENT_ORDER_STATUSES.has(reservation.fulfillmentOrder.status),
      );
      if (blockedReservation) {
        throw new BadRequestException(
          `Unit ${unit.code} is attached to active fulfillment order ${blockedReservation.fulfillmentOrder.posOrderId}`,
        );
      }

      const affectedFulfillmentOrderIds = Array.from(new Set(
        unit.pickReservations.map((reservation) => reservation.fulfillmentOrderId),
      ));
      const movementNotes = notes ? `${reason} · ${notes}` : reason;

      if (unit.pickReservations.length > 0) {
        await tx.wmsPickReservation.updateMany({
          where: {
            inventoryUnitId: unit.id,
            status: WmsPickReservationStatus.RESERVED,
          },
          data: {
            status: WmsPickReservationStatus.RELEASED,
          },
        });
      }

      await this.releaseOrphanBasketUnitHoldsTx(tx, {
        unit,
        nextStatus: WmsInventoryUnitStatus.ARCHIVED,
        actorId,
        now,
      });

      await tx.wmsInventoryUnit.update({
        where: { id: unit.id },
        data: {
          currentLocationId: null,
          status: WmsInventoryUnitStatus.ARCHIVED,
          ...(actorId ? { updatedById: actorId } : {}),
        },
      });

      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: scope.activeTenantId!,
          inventoryUnitId: unit.id,
          warehouseId: unit.warehouseId,
          fromLocationId: unit.currentLocationId,
          toLocationId: null,
          fromStatus: unit.status,
          toStatus: WmsInventoryUnitStatus.ARCHIVED,
          movementType: WmsInventoryMovementType.ADJUSTMENT,
          referenceType: 'VOID_UNIT',
          referenceId: unit.id,
          referenceCode: unit.code,
          notes: movementNotes,
          actorId,
          createdAt: now,
        },
      });

      for (const fulfillmentOrderId of affectedFulfillmentOrderIds) {
        await this.refreshFulfillmentOrderStateAfterInventoryVoid(tx, fulfillmentOrderId, now);
      }

      const updatedUnit = await tx.wmsInventoryUnit.findUniqueOrThrow({
        where: { id: unit.id },
        include: {
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
              name: true,
              kind: true,
            },
          },
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
              productSnapshot: true,
            },
          },
        },
      });

      return {
        voided: {
          unitId: unit.id,
          unitCode: unit.code,
          releasedReservations: unit.pickReservations.length,
          reason,
        },
        unit: this.mapUnit(updatedUnit),
      };
    });

    await this.recordInventoryActivity({
      tenantId: scope.activeTenantId,
      actionType: 'VOID_UNIT',
      resourceType: 'WMS_INVENTORY_UNIT',
      resourceId: result.voided.unitId,
      metadata: {
        unitCode: result.voided.unitCode,
        reason,
        releasedReservations: result.voided.releasedReservations,
      },
    });

    return result;
  }

  async recordUnitLabelPrint(
    id: string,
    body: RecordWmsInventoryUnitLabelPrintDto,
    requestedTenantId?: string,
  ) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const action = body.action ?? 'PRINT';
    const now = new Date();

    const unit = await this.prisma.wmsInventoryUnit.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        firstLabelPrintedAt: true,
      },
    });

    if (!unit) {
      throw new NotFoundException('Inventory unit was not found');
    }

    if (unit.tenantId !== scope.activeTenantId) {
      throw new ForbiddenException('Selected tenant is outside your WMS scope');
    }

    const nextUnit = await this.prisma.$transaction(async (tx) => {
      await tx.wmsInventoryUnit.update({
        where: { id: unit.id },
        data: {
          labelPrintCount: {
            increment: 1,
          },
          ...(unit.firstLabelPrintedAt ? {} : { firstLabelPrintedAt: now }),
          lastLabelPrintedAt: now,
          ...(actorId ? { updatedById: actorId } : {}),
        },
      });

      await tx.wmsLabelPrintLog.create({
        data: {
          tenantId: scope.activeTenantId!,
          actorId,
          scope: 'INVENTORY_UNIT',
          action,
          inventoryUnitId: unit.id,
          itemCount: 1,
        },
      });

      return tx.wmsInventoryUnit.findUnique({
        where: { id: unit.id },
        include: {
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
              name: true,
              kind: true,
            },
          },
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
              productSnapshot: true,
            },
          },
        },
      });
    });

    if (!nextUnit) {
      throw new NotFoundException('Inventory unit was not found');
    }

    return {
      print: {
        action,
        itemCount: 1,
      },
      unit: this.mapUnit(nextUnit),
    };
  }

  private async resolveTenantScope(requestedTenantId?: string, forceAllTenants = false) {
    const clsTenantId = this.cls.get('tenantId') as string | undefined;
    const userRole = this.cls.get('userRole') as string | undefined;
    const isPlatformUser = userRole === 'SUPER_ADMIN';
    const hasGlobalWmsAccess = this.cls.get('wmsGlobalAccess') === true;

    if (isPlatformUser || hasGlobalWmsAccess) {
      const tenants = await this.prisma.tenant.findMany({
        where: {
          status: {
            in: [...ACTIVE_WMS_TENANT_STATUSES],
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

      const activeTenantId =
        requestedTenantId && tenants.some((tenant) => tenant.id === requestedTenantId)
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
      return {
        activeTenantId: null,
        canAccessAllTenants: false,
        tenants: [],
      };
    }

    if (requestedTenantId && requestedTenantId !== clsTenantId) {
      throw new ForbiddenException('Selected tenant is outside your WMS scope');
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: {
        id: clsTenantId,
        status: {
          in: [...ACTIVE_WMS_TENANT_STATUSES],
        },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
      },
    });

    return {
      activeTenantId: tenant?.id ?? null,
      canAccessAllTenants: false,
      tenants: tenant
        ? [
            {
              id: tenant.id,
              label: tenant.name,
              slug: tenant.slug,
              status: tenant.status,
            },
          ]
        : [],
    };
  }

  private mapUnit(unit: InventoryUnitRecord) {
    const snapshot = unit.posProduct.productSnapshot as
      | {
          display_id?: string | null;
          product?: {
            display_id?: string | null;
          } | null;
        }
      | null;
    const variationDisplayId =
      typeof snapshot?.display_id === 'string'
        ? snapshot.display_id
        : typeof snapshot?.product?.display_id === 'string'
          ? snapshot.product.display_id
          : null;

    return {
      id: unit.id,
      code: unit.code,
      barcode: unit.barcode,
      status: unit.status,
      expirationDate: unit.expirationDate,
      expiredAt: unit.expiredAt,
      labelPrintCount: unit.labelPrintCount,
      firstLabelPrintedAt: unit.firstLabelPrintedAt,
      lastLabelPrintedAt: unit.lastLabelPrintedAt,
      posProductId: unit.posProductId,
      productProfileId: unit.productProfileId,
      productId: unit.productId,
      productCustomId: unit.posProduct.customId,
      variationId: unit.variationId,
      variationDisplayId,
      name: unit.posProduct.name,
      unitCost: unit.unitCost === null ? null : Number(unit.unitCost),
      store: {
        id: unit.store.id,
        name: unit.store.shopName || unit.store.name,
      },
      warehouse: {
        id: unit.warehouse.id,
        code: unit.warehouse.code,
        name: unit.warehouse.name,
      },
      currentLocation: unit.currentLocation
        ? {
            id: unit.currentLocation.id,
            code: unit.currentLocation.code,
            name: unit.currentLocation.name,
            kind: unit.currentLocation.kind,
            label: `${unit.warehouse.code} · ${unit.currentLocation.code}`,
          }
        : null,
      source: unit.sourceType
        ? {
            type: unit.sourceType,
            refId: unit.sourceRefId,
            label: unit.sourceRefLabel,
          }
        : null,
      notes: unit.notes,
      createdAt: unit.createdAt,
      updatedAt: unit.updatedAt,
    };
  }

  private mapMovement(movement: InventoryMovementRecord) {
    return {
      id: movement.id,
      movementType: movement.movementType,
      fromStatus: movement.fromStatus,
      fromStatusLabel: movement.fromStatus ? this.formatStatusLabel(movement.fromStatus) : null,
      toStatus: movement.toStatus,
      toStatusLabel: movement.toStatus ? this.formatStatusLabel(movement.toStatus) : null,
      referenceType: movement.referenceType,
      referenceId: movement.referenceId,
      referenceCode: movement.referenceCode,
      notes: movement.notes,
      fromLocation: movement.fromLocation
        ? {
            id: movement.fromLocation.id,
            code: movement.fromLocation.code,
            name: movement.fromLocation.name,
            kind: movement.fromLocation.kind,
          }
        : null,
      toLocation: movement.toLocation
        ? {
            id: movement.toLocation.id,
            code: movement.toLocation.code,
            name: movement.toLocation.name,
            kind: movement.toLocation.kind,
          }
        : null,
      actor: movement.actor
        ? {
            name:
              `${movement.actor.firstName ?? ''} ${movement.actor.lastName ?? ''}`.trim()
              || movement.actor.email,
            email: movement.actor.email,
          }
        : null,
      createdAt: movement.createdAt,
    };
  }

  private mapTransfer(transfer: InventoryTransferRecord) {
    return {
      id: transfer.id,
      code: transfer.code,
      status: transfer.status,
      itemCount: transfer._count.items,
      warehouse: {
        id: transfer.warehouse.id,
        code: transfer.warehouse.code,
        name: transfer.warehouse.name,
      },
      fromLocation: transfer.fromLocation
        ? {
            id: transfer.fromLocation.id,
            code: transfer.fromLocation.code,
            name: transfer.fromLocation.name,
            kind: transfer.fromLocation.kind,
            label: `${transfer.warehouse.code} · ${transfer.fromLocation.code}`,
          }
        : null,
      toLocation: {
        id: transfer.toLocation.id,
        code: transfer.toLocation.code,
        name: transfer.toLocation.name,
        kind: transfer.toLocation.kind,
        label: `${transfer.warehouse.code} · ${transfer.toLocation.code}`,
      },
      notes: transfer.notes,
      actor: transfer.createdBy
        ? {
            name:
              `${transfer.createdBy.firstName ?? ''} ${transfer.createdBy.lastName ?? ''}`.trim()
              || transfer.createdBy.email,
            email: transfer.createdBy.email,
          }
        : null,
      createdAt: transfer.createdAt,
    };
  }

  private async getActiveStructuralLocationsByWarehouse(warehouseId: string) {
    return this.prisma.wmsLocation.findMany({
      where: {
        warehouseId,
        isActive: true,
        kind: {
          in: [...STRUCTURAL_LOCATION_KINDS],
        },
      },
      select: {
        id: true,
        warehouseId: true,
        parentId: true,
        kind: true,
        code: true,
        name: true,
        capacity: true,
      },
      orderBy: [{ code: 'asc' }],
    });
  }

  private async getBinOccupancyMap(binIds: string[]) {
    if (!binIds.length) {
      return new Map<string, number>();
    }

    const counts = await this.prisma.wmsInventoryUnit.groupBy({
      by: ['currentLocationId'],
      where: {
        currentLocationId: {
          in: binIds,
        },
      },
      _count: {
        _all: true,
      },
    });

    return new Map(
      counts.flatMap((record) =>
        record.currentLocationId ? [[record.currentLocationId, record._count._all] as const] : [],
      ),
    );
  }

  async syncPosOrderCogsFromMatchedInventoryUnits(params: {
    tenantId?: string | null;
    storeId?: string | null;
    fulfillmentOrderIds?: string[];
    posOrderRefs?: Array<{
      shopId: string;
      posOrderId: string;
    }>;
  }) {
    return this.wmsInventoryCogsService.syncPosOrderCogsFromMatchedInventoryUnits(params);
  }

  async syncPackedUnitsToDispatchedForPosOrders(params: {
    tenantId: string;
    storeId?: string | null;
    posOrderRefs?: Array<{
      shopId: string;
      posOrderId: string;
    }>;
    mode?: 'AUTO' | 'MANUAL';
    actorId?: string | null;
  }) {
    const refs = Array.from(
      new Map(
        (params.posOrderRefs ?? [])
          .filter((ref) => ref.shopId && ref.posOrderId)
          .map((ref) => [`${ref.shopId}::${ref.posOrderId}`, ref] as const),
      ).values(),
    );

    const orderScope = {
      tenantId: params.tenantId,
      ...(params.storeId ? { storeId: params.storeId } : {}),
      status: WmsFulfillmentOrderStatus.PACKED,
      posOrder: {
        is: {
          status: {
            in: [2, 3],
          },
        },
      },
      ...(refs.length > 0
        ? {
            OR: refs.map((ref) => ({
              shopId: ref.shopId,
              posOrderId: ref.posOrderId,
            })),
          }
        : {}),
    } satisfies Prisma.WmsFulfillmentOrderWhereInput;

    const [reservations, basketUnits] = await Promise.all([
      this.prisma.wmsPickReservation.findMany({
        where: {
          inventoryUnit: {
            status: WmsInventoryUnitStatus.PACKED,
          },
          fulfillmentOrder: orderScope,
        },
        select: {
          inventoryUnitId: true,
          inventoryUnit: {
            select: {
              id: true,
              code: true,
              currentLocationId: true,
              status: true,
              warehouseId: true,
            },
          },
          fulfillmentOrder: {
            select: {
              id: true,
              posOrderId: true,
              tenantId: true,
              storeId: true,
              warehouseId: true,
              posOrder: {
                select: {
                  status: true,
                  tracking: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.wmsBasketUnit.findMany({
        where: {
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
            status: WmsInventoryUnitStatus.PACKED,
          },
          fulfillmentOrder: orderScope,
        },
        select: {
          inventoryUnitId: true,
          inventoryUnit: {
            select: {
              id: true,
              code: true,
              currentLocationId: true,
              status: true,
              warehouseId: true,
            },
          },
          fulfillmentOrder: {
            select: {
              id: true,
              posOrderId: true,
              tenantId: true,
              storeId: true,
              warehouseId: true,
              posOrder: {
                select: {
                  status: true,
                  tracking: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const matchedUnits = Array.from(
      new Map(
        [...reservations, ...basketUnits].map((record) => [record.inventoryUnitId, record] as const),
      ).values(),
    );
    const now = new Date();
    const syncMode = params.mode ?? 'AUTO';
    const actorId = params.actorId ?? null;
    let dispatchedUnits = 0;
    const dispatchedByOrderId = new Map<string, Array<typeof matchedUnits[number]>>();

    if (matchedUnits.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const reservation of matchedUnits) {
          if (!reservation.fulfillmentOrder) {
            continue;
          }

          const updateResult = await tx.wmsInventoryUnit.updateMany({
            where: {
              id: reservation.inventoryUnitId,
              status: WmsInventoryUnitStatus.PACKED,
            },
            data: {
              currentLocationId: null,
              status: WmsInventoryUnitStatus.DISPATCHED,
              updatedById: actorId,
            },
          });

          if (updateResult.count === 0) {
            continue;
          }

          dispatchedUnits += updateResult.count;
          const dispatchedForOrder = dispatchedByOrderId.get(reservation.fulfillmentOrder.id) ?? [];
          dispatchedForOrder.push(reservation);
          dispatchedByOrderId.set(reservation.fulfillmentOrder.id, dispatchedForOrder);

          const shippedStatus = reservation.fulfillmentOrder.posOrder?.status;
          const notePrefix = syncMode === 'MANUAL' ? 'Dispatch repair' : 'Auto-dispatched';
          const note = shippedStatus === 3
            ? `${notePrefix} after POS order ${reservation.fulfillmentOrder.posOrderId} was marked delivered`
            : `${notePrefix} after POS order ${reservation.fulfillmentOrder.posOrderId} was marked shipped`;

          await tx.wmsInventoryMovement.create({
            data: {
              tenantId: reservation.fulfillmentOrder.tenantId,
              inventoryUnitId: reservation.inventoryUnitId,
              warehouseId: reservation.inventoryUnit.warehouseId,
              fromLocationId: reservation.inventoryUnit.currentLocationId,
              toLocationId: null,
              fromStatus: reservation.inventoryUnit.status,
              toStatus: WmsInventoryUnitStatus.DISPATCHED,
              movementType: WmsInventoryMovementType.DISPATCH,
              referenceType: 'WMS_FULFILLMENT_ORDER',
              referenceId: reservation.fulfillmentOrder.id,
              referenceCode: reservation.fulfillmentOrder.posOrderId,
              notes: note,
              actorId,
              createdAt: now,
            },
          });
        }
      });

      await Promise.all(
        Array.from(dispatchedByOrderId.entries()).map(async ([orderId, orderReservations]) => {
          const sample = orderReservations[0];
          if (!sample?.fulfillmentOrder) {
            return;
          }

          const posStatus = sample.fulfillmentOrder.posOrder?.status ?? null;
          const deliveryState = posStatus === 3 ? 'DELIVERED' : 'SHIPPED';

          await this.wmsStaffActivityService.record({
            tenantId: sample.fulfillmentOrder.tenantId,
            actorId,
            sessionId: (this.cls.get('sessionId') as string | undefined) ?? null,
            actionType: 'ORDER_DISPATCH_SYNC',
            resourceType: 'WMS_FULFILLMENT_ORDER',
            resourceId: orderId,
            taskType: 'DISPATCH',
            taskId: orderId,
            storeId: sample.fulfillmentOrder.storeId,
            warehouseId: sample.fulfillmentOrder.warehouseId ?? sample.inventoryUnit.warehouseId,
            fromStatus: WmsInventoryUnitStatus.PACKED,
            toStatus: WmsInventoryUnitStatus.DISPATCHED,
            outcome: WmsStaffActivityOutcome.SUCCESS,
            metadata: {
              deliveryState,
              mode: syncMode,
              posOrderId: sample.fulfillmentOrder.posOrderId,
              posStatus,
              trackingCode: sample.fulfillmentOrder.posOrder?.tracking ?? null,
              unitCodes: orderReservations.map((reservation) => reservation.inventoryUnit.code),
              unitCount: orderReservations.length,
            },
          });
        }),
      );
    }

    const cogsSync = dispatchedByOrderId.size > 0
      ? await this.syncPosOrderCogsFromMatchedInventoryUnits({
          fulfillmentOrderIds: Array.from(dispatchedByOrderId.keys()),
        })
      : {
          updatedOrders: 0,
          skippedOrders: 0,
        };

    const deliveredOrders = await this.recordDeliveredOrderHistoryForDispatchedPosOrders({
      tenantId: params.tenantId,
      storeId: params.storeId ?? null,
      refs,
      mode: syncMode,
      actorId,
    });

    try {
      await this.wmsOutboundRecordsService.syncForPosOrders({
        tenantId: params.tenantId,
        storeId: params.storeId ?? null,
        posOrderRefs: refs,
      });
    } catch (error) {
      this.logger.warn(
        `Outbound unit projection sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      dispatchedUnits,
      deliveredOrders,
      cogsUpdatedOrders: cogsSync.updatedOrders,
    };
  }

  private async recordDeliveredOrderHistoryForDispatchedPosOrders(params: {
    tenantId: string;
    storeId: string | null;
    refs: Array<{
      shopId: string;
      posOrderId: string;
    }>;
    mode?: 'AUTO' | 'MANUAL';
    actorId?: string | null;
  }) {
    const deliveredOrders = await this.prisma.wmsFulfillmentOrder.findMany({
      where: {
        tenantId: params.tenantId,
        ...(params.storeId ? { storeId: params.storeId } : {}),
        status: WmsFulfillmentOrderStatus.PACKED,
        posOrder: {
          is: {
            status: 3,
          },
        },
        reservations: {
          some: {
            inventoryUnit: {
              status: WmsInventoryUnitStatus.DISPATCHED,
            },
          },
        },
        ...(params.refs.length > 0
          ? {
              OR: params.refs.map((ref) => ({
                shopId: ref.shopId,
                posOrderId: ref.posOrderId,
              })),
            }
          : {}),
      },
      select: {
        id: true,
        tenantId: true,
        storeId: true,
        warehouseId: true,
        posOrderId: true,
        posOrder: {
          select: {
            status: true,
            tracking: true,
          },
        },
        reservations: {
          where: {
            inventoryUnit: {
              status: WmsInventoryUnitStatus.DISPATCHED,
            },
          },
          select: {
            inventoryUnit: {
              select: {
                code: true,
                warehouseId: true,
              },
            },
          },
        },
      },
    });

    if (deliveredOrders.length === 0) {
      return 0;
    }

    const existingActivities = await this.prisma.wmsStaffActivity.findMany({
      where: {
        tenantId: params.tenantId,
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: {
          in: deliveredOrders.map((order) => order.id),
        },
        actionType: {
          in: ['ORDER_DISPATCH_SYNC', 'ORDER_DELIVERY_SYNC'],
        },
      },
      select: {
        resourceId: true,
        actionType: true,
        metadata: true,
      },
    });

    const deliveredOrderIds = new Set(
      existingActivities.flatMap((activity) => {
        if (!activity.resourceId) {
          return [];
        }

        if (activity.actionType === 'ORDER_DELIVERY_SYNC') {
          return [activity.resourceId];
        }

        if (
          activity.metadata
          && !Array.isArray(activity.metadata)
          && typeof activity.metadata === 'object'
          && activity.metadata['deliveryState'] === 'DELIVERED'
        ) {
          return [activity.resourceId];
        }

        return [];
      }),
    );

    const ordersToRecord = deliveredOrders.filter((order) => !deliveredOrderIds.has(order.id));
    await Promise.all(
      ordersToRecord.map(async (order) => {
        const sampleReservation = order.reservations[0]?.inventoryUnit ?? null;
        await this.wmsStaffActivityService.record({
          tenantId: order.tenantId,
          actorId: params.actorId ?? null,
          sessionId: (this.cls.get('sessionId') as string | undefined) ?? null,
          actionType: 'ORDER_DELIVERY_SYNC',
          resourceType: 'WMS_FULFILLMENT_ORDER',
          resourceId: order.id,
          taskType: 'DISPATCH',
          taskId: order.id,
          storeId: order.storeId,
          warehouseId: order.warehouseId ?? sampleReservation?.warehouseId ?? null,
          fromStatus: WmsInventoryUnitStatus.DISPATCHED,
          toStatus: WmsInventoryUnitStatus.DISPATCHED,
          outcome: WmsStaffActivityOutcome.SUCCESS,
          metadata: {
            deliveryState: 'DELIVERED',
            mode: params.mode ?? 'AUTO',
            posOrderId: order.posOrderId,
            posStatus: order.posOrder?.status ?? 3,
            trackingCode: order.posOrder?.tracking ?? null,
            unitCodes: order.reservations.map((reservation) => reservation.inventoryUnit.code),
            unitCount: order.reservations.length,
          },
        });
      }),
    );

    return ordersToRecord.length;
  }

  private async getWarehouseCapacitySummary(params: {
    tenantId: string | null;
    storeId: string | null;
    warehouseId: string | null;
  }) {
    const bins = await this.prisma.wmsLocation.findMany({
      where: {
        isActive: true,
        kind: WmsLocationKind.BIN,
        ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      },
      select: {
        id: true,
        capacity: true,
      },
    });
    const binIds = bins.map((bin) => bin.id);
    const totalUnits = bins.reduce((total, bin) => total + (bin.capacity ?? 0), 0);

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

  private buildTransferStructureMaps(locations: TransferLocationRecord[]): TransferStructureMaps {
    const locationMap = new Map<string, TransferLocationRecord>(
      locations.map((location) => [location.id, location]),
    );
    const sections = locations
      .filter((location) => location.kind === WmsLocationKind.SECTION)
      .sort((left, right) => left.code.localeCompare(right.code));

    const racksBySectionId = new Map<string, TransferLocationRecord[]>();
    const binsByRackId = new Map<string, TransferLocationRecord[]>();

    locations.forEach((location) => {
      if (location.kind === WmsLocationKind.RACK && location.parentId) {
        const racks = racksBySectionId.get(location.parentId) ?? [];
        racks.push(location);
        racksBySectionId.set(location.parentId, racks);
        return;
      }

      if (location.kind === WmsLocationKind.BIN && location.parentId) {
        const bins = binsByRackId.get(location.parentId) ?? [];
        bins.push(location);
        binsByRackId.set(location.parentId, bins);
      }
    });

    racksBySectionId.forEach((racks, sectionId) => {
      racksBySectionId.set(
        sectionId,
        racks.slice().sort((left, right) => left.code.localeCompare(right.code)),
      );
    });

    binsByRackId.forEach((bins, rackId) => {
      binsByRackId.set(
        rackId,
        bins.slice().sort((left, right) => left.code.localeCompare(right.code)),
      );
    });

    return {
      sections,
      locationMap,
      racksBySectionId,
      binsByRackId,
    };
  }

  private isTransferDestinationKindAllowed(kind: WmsLocationKind) {
    return (
      kind === WmsLocationKind.BIN
      || TRANSFER_OPERATIONAL_LOCATION_KINDS.includes(
        kind as (typeof TRANSFER_OPERATIONAL_LOCATION_KINDS)[number],
      )
    );
  }

  private resolveTransferTargetStatus(
    currentStatus: WmsInventoryUnitStatus,
    targetKind: WmsLocationKind,
  ) {
    if (currentStatus === WmsInventoryUnitStatus.EXPIRED) {
      return WmsInventoryUnitStatus.EXPIRED;
    }

    switch (targetKind) {
      case WmsLocationKind.BIN:
        return currentStatus === WmsInventoryUnitStatus.DEADSTOCK
          ? WmsInventoryUnitStatus.DEADSTOCK
          : WmsInventoryUnitStatus.PUTAWAY;
      case WmsLocationKind.RECEIVING_STAGING:
        return WmsInventoryUnitStatus.STAGED;
      case WmsLocationKind.RTS:
        return WmsInventoryUnitStatus.RTS;
      case WmsLocationKind.DAMAGE:
      case WmsLocationKind.QUARANTINE:
        return WmsInventoryUnitStatus.DAMAGED;
      default:
        return currentStatus;
    }
  }

  private getAllowedAdjustmentLocationKinds(targetStatus: WmsInventoryUnitStatus) {
    switch (targetStatus) {
      case WmsInventoryUnitStatus.STAGED:
        return [WmsLocationKind.RECEIVING_STAGING];
      case WmsInventoryUnitStatus.PUTAWAY:
      case WmsInventoryUnitStatus.DEADSTOCK:
        return [WmsLocationKind.BIN];
      case WmsInventoryUnitStatus.RTS:
        return [];
      case WmsInventoryUnitStatus.DAMAGED:
        return [WmsLocationKind.DAMAGE, WmsLocationKind.QUARANTINE];
      case WmsInventoryUnitStatus.LOST:
      case WmsInventoryUnitStatus.ARCHIVED:
        return [];
      default:
        return [];
    }
  }

  private getRequiredAdjustmentLocationKind(targetStatus: WmsInventoryUnitStatus) {
    switch (targetStatus) {
      case WmsInventoryUnitStatus.STAGED:
        return 'receiving staging location';
      case WmsInventoryUnitStatus.PUTAWAY:
      case WmsInventoryUnitStatus.DEADSTOCK:
        return 'bin location';
      case WmsInventoryUnitStatus.RTS:
        return 'no location';
      case WmsInventoryUnitStatus.DAMAGED:
        return 'damage or quarantine location';
      case WmsInventoryUnitStatus.LOST:
      case WmsInventoryUnitStatus.ARCHIVED:
        return 'no location';
      default:
        return 'valid location';
    }
  }

  private buildTransferCode() {
    return `TRF-${Date.now().toString(36).toUpperCase()}`;
  }

  private buildStoreTransferCode() {
    return `STX-${Date.now().toString(36).toUpperCase()}`;
  }

  private buildAdjustmentCode() {
    return `ADJ-${Date.now().toString(36).toUpperCase()}`;
  }

  private isLegacyVariationMapping(productId: string, variationId: string | null | undefined) {
    return Boolean(variationId) && variationId === productId;
  }

  private isStockableVariation(productId: string, variationId: string | null | undefined) {
    return Boolean(variationId) && !this.isLegacyVariationMapping(productId, variationId);
  }

  private getStockabilityReason(productId: string, variationId: string | null | undefined) {
    if (!variationId) {
      return 'variation ID is missing';
    }

    if (this.isLegacyVariationMapping(productId, variationId)) {
      return 'variation ID is still mapped to the parent product ID';
    }

    return 'product is not stockable';
  }

  private resolveVariationDisplayId(snapshot: unknown) {
    const parsed = snapshot as
      | {
          display_id?: string | null;
          product?: {
            display_id?: string | null;
          } | null;
        }
      | null;

    return typeof parsed?.display_id === 'string'
      ? parsed.display_id
      : typeof parsed?.product?.display_id === 'string'
        ? parsed.product.display_id
        : null;
  }

  private mapStoreTransferProductOption(
    profile: {
      id: string;
      posProductId: string;
      productId: string;
      variationId: string;
      stockPoolGroupId?: string | null;
      posProduct: {
        customId: string | null;
        productSnapshot: Prisma.JsonValue | null;
        name: string;
      };
    },
    sourceStockPoolGroupId: string | null = null,
  ) {
    return {
      id: profile.id,
      profileId: profile.id,
      posProductId: profile.posProductId,
      productId: profile.productId,
      variationId: profile.variationId,
      variationDisplayId: this.resolveVariationDisplayId(profile.posProduct.productSnapshot),
      productCustomId: profile.posProduct.customId,
      name: profile.posProduct.name,
      label: profile.posProduct.name,
      alreadyPooled: Boolean(
        sourceStockPoolGroupId
        && profile.stockPoolGroupId
        && profile.stockPoolGroupId === sourceStockPoolGroupId,
      ),
    };
  }

  private formatInventoryProductFilterLabel(product: {
    name: string;
    variationDisplayId: string | null;
    productCustomId: string | null;
    variationId: string;
    storeName?: string;
    tenantLabel?: string;
    includeStoreContext?: boolean;
    includeTenantContext?: boolean;
  }) {
    const identity =
      product.variationDisplayId
      || product.productCustomId
      || product.variationId;
    const segments = [`${product.name} · ${identity}`];

    if (product.includeStoreContext && product.storeName) {
      segments.push(product.storeName);
    }

    if (product.includeTenantContext && product.tenantLabel) {
      segments.push(product.tenantLabel);
    }

    return segments.join(' · ');
  }

  private resolveStoreTransferSuggestion(params: {
    sourceProfile: {
      id: string;
      productId: string;
      variationId: string;
      stockPoolGroupId?: string | null;
      posProduct: {
        customId: string | null;
        productSnapshot: Prisma.JsonValue | null;
        name: string;
      };
    } | null;
    products: Array<ReturnType<WmsInventoryService['mapStoreTransferProductOption']>>;
    savedEquivalence: {
      targetProfileId: string;
    } | null;
  }) {
    const pooledProduct = params.products.find((product) => product.alreadyPooled) ?? null;
    if (pooledProduct) {
      return {
        profileId: pooledProduct.profileId,
        label: pooledProduct.label,
        reason: 'Linked shared stock pool',
        confidence: 'high',
      };
    }

    const savedProduct = params.savedEquivalence
      ? params.products.find((product) => product.profileId === params.savedEquivalence?.targetProfileId) ?? null
      : null;

    if (savedProduct) {
      return {
        profileId: savedProduct.profileId,
        label: savedProduct.label,
        reason: 'Saved mapping',
        confidence: 'high',
      };
    }

    if (!params.sourceProfile) {
      return null;
    }

    const sourceCustomId = this.normalizeProductMatchValue(params.sourceProfile.posProduct.customId);
    const sourceDisplayId = this.normalizeProductMatchValue(
      this.resolveVariationDisplayId(params.sourceProfile.posProduct.productSnapshot),
    );
    const sourceProductId = this.normalizeProductMatchValue(params.sourceProfile.productId);
    const sourceName = this.normalizeProductMatchValue(params.sourceProfile.posProduct.name);

    const exactCustomId = sourceCustomId
      ? params.products.find((product) => this.normalizeProductMatchValue(product.productCustomId) === sourceCustomId)
      : null;
    if (exactCustomId) {
      return {
        profileId: exactCustomId.profileId,
        label: exactCustomId.label,
        reason: 'Same product custom ID',
        confidence: 'high',
      };
    }

    const exactDisplayId = sourceDisplayId
      ? params.products.find((product) => this.normalizeProductMatchValue(product.variationDisplayId) === sourceDisplayId)
      : null;
    if (exactDisplayId) {
      return {
        profileId: exactDisplayId.profileId,
        label: exactDisplayId.label,
        reason: 'Same product display ID',
        confidence: 'high',
      };
    }

    const exactProductId = sourceProductId
      ? params.products.find((product) => this.normalizeProductMatchValue(product.productId) === sourceProductId)
      : null;
    if (exactProductId) {
      return {
        profileId: exactProductId.profileId,
        label: exactProductId.label,
        reason: 'Same product ID',
        confidence: 'medium',
      };
    }

    const exactName = sourceName
      ? params.products.find((product) => this.normalizeProductMatchValue(product.name) === sourceName)
      : null;
    if (exactName) {
      return {
        profileId: exactName.profileId,
        label: exactName.label,
        reason: 'Same product name',
        confidence: 'medium',
      };
    }

    return null;
  }

  private normalizeProductMatchValue(value: string | null | undefined) {
    return value?.trim().replace(/\s+/g, ' ').toLowerCase() || null;
  }

  private async refreshFulfillmentOrderStateAfterInventoryVoid(
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
                status: {
                  in: [...ACTIVE_PICK_RESERVATION_STATUSES],
                },
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
      const allocated = line.reservations.length;
      const picked = line.reservations.filter(
        (reservation) => reservation.status === WmsPickReservationStatus.PICKED,
      ).length;
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

      const nextLineStatus = this.resolveFulfillmentLineStatusAfterInventoryVoid(
        required,
        allocated,
        picked,
        line.status,
      );
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

    const nextOrderStatus = this.resolveFulfillmentOrderStatusAfterInventoryVoid({
      currentStatus: order.status,
      claimedById: order.claimedById,
      totalQuantity,
      allocatedQuantity,
      pickedQuantity,
      hasIssue,
    });
    const voidIssueLine = order.lines.find(
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
            : voidIssueLine?.issueReason
              ? `${voidIssueLine.productName}: ${voidIssueLine.issueReason}`
              : order.issueReason ?? 'Reserved inventory unit was voided — reallocate or review order items.',
      },
    });
  }

  private async releaseOrphanBasketUnitHoldsTx(
    tx: Prisma.TransactionClient,
    params: {
      unit: {
        id: string;
        status: WmsInventoryUnitStatus;
        basketUnits: Array<{
          id: string;
          status: WmsBasketUnitStatus;
          fulfillmentOrderId: string | null;
          fulfillmentLineId: string | null;
        }>;
      };
      nextStatus?: WmsInventoryUnitStatus;
      actorId: string | null;
      now: Date;
    },
  ) {
    const effectiveStatus = params.nextStatus ?? params.unit.status;
    if (
      effectiveStatus === WmsInventoryUnitStatus.PICKED
      || effectiveStatus === WmsInventoryUnitStatus.PACKED
    ) {
      return 0;
    }

    const orphanBasketUnitIds = params.unit.basketUnits
      .filter((basketUnit) => !basketUnit.fulfillmentOrderId && !basketUnit.fulfillmentLineId)
      .map((basketUnit) => basketUnit.id);

    if (orphanBasketUnitIds.length === 0) {
      return 0;
    }

    const released = await tx.wmsBasketUnit.updateMany({
      where: {
        id: {
          in: orphanBasketUnitIds,
        },
        status: {
          in: [...ACTIVE_BASKET_UNIT_HOLD_STATUSES],
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

    return released.count;
  }

  private resolveFulfillmentLineStatusAfterInventoryVoid(
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

  private resolveFulfillmentOrderStatusAfterInventoryVoid(params: {
    currentStatus: WmsFulfillmentOrderStatus;
    claimedById: string | null;
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

    if (params.totalQuantity <= 0 || params.hasIssue) {
      return WmsFulfillmentOrderStatus.ISSUE;
    }

    if (params.pickedQuantity >= params.totalQuantity) {
      return WmsFulfillmentOrderStatus.READY_FOR_PACK;
    }

    if (params.currentStatus === WmsFulfillmentOrderStatus.IN_PICKING && params.claimedById) {
      return WmsFulfillmentOrderStatus.IN_PICKING;
    }

    if (params.allocatedQuantity >= params.totalQuantity) {
      return WmsFulfillmentOrderStatus.READY;
    }

    if (params.allocatedQuantity > 0) {
      return WmsFulfillmentOrderStatus.PARTIAL;
    }

    return WmsFulfillmentOrderStatus.RESTOCKING;
  }

  private async recordInventoryActivity(params: {
    tenantId: string;
    actionType: string;
    resourceType: string;
    resourceId: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    await this.wmsStaffActivityService.record({
      tenantId: params.tenantId,
      actorId: (this.cls.get('userId') as string | undefined) ?? null,
      sessionId: (this.cls.get('sessionId') as string | undefined) ?? null,
      actionType: params.actionType,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      taskType: 'INVENTORY',
      taskId: params.resourceId,
      outcome: WmsStaffActivityOutcome.SUCCESS,
      metadata: params.metadata,
    });
  }

  private cleanOptionalText(value?: string | null) {
    const normalized = value?.trim() ?? null;
    return normalized ? normalized : null;
  }

  private formatStatusLabel(status: WmsInventoryUnitStatus) {
    return status
      .toLowerCase()
      .split('_')
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ');
  }
}

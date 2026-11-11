import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  Prisma,
  TenantStatus,
  WmsBasketStatus,
  WmsBasketUnitStatus,
  WmsFulfillmentAdjustmentStatus,
  WmsFulfillmentAdjustmentType,
  WmsFulfillmentAssignmentMode,
  WmsFulfillmentLineStatus,
  WmsFulfillmentOrderStatus,
  WmsInventoryMovementType,
  WmsInventoryUnitStatus,
  WmsLocationKind,
  WmsPickReservationStatus,
} from '@prisma/client';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WmsStaffActivityService } from '../../common/services/wms-staff-activity.service';
import { buildUnexpiredInventoryWhere } from '../wms-inventory/wms-inventory-expiration.utils';
import {
  AdjustWmsFulfillmentOrderDto,
  WmsFulfillmentAdjustmentActionDto,
} from './dto/adjust-wms-fulfillment-order.dto';
import { GetWmsFulfillmentAdjustmentOptionsDto } from './dto/get-wms-fulfillment-adjustment-options.dto';
import { GetWmsFulfillmentOpsSnapshotDto } from './dto/get-wms-fulfillment-ops-snapshot.dto';
import { GetWmsFulfillmentPriorityPreviewDto } from './dto/get-wms-fulfillment-priority-preview.dto';
import { PrioritizeWmsFulfillmentOrderDto } from './dto/prioritize-wms-fulfillment-order.dto';
import { RecalculateWmsDemandCountsDto } from './dto/recalculate-wms-demand-counts.dto';
import { ReleaseWmsFulfillmentPriorityDto } from './dto/release-wms-fulfillment-priority.dto';
import { RepairWmsDemandBasketsDto } from './dto/repair-wms-demand-baskets.dto';
import { WmsFulfillmentSyncService } from './wms-fulfillment-sync.service';
import {
  EMPTY_STOCK_POOL_INDEX,
  loadTenantStockPoolIndex,
  type TenantStockPoolIndex,
} from './wms-stock-pool.util';

const DEFAULT_OPS_LIMIT = 25;
const DEFAULT_STALE_MINUTES = 180;
const ACTIVE_PICK_RESERVATION_STATUSES = [
  WmsPickReservationStatus.RESERVED,
  WmsPickReservationStatus.PICKED,
] as const;
const ACTIVE_BASKET_UNIT_STATUSES = [
  WmsBasketUnitStatus.PICKED,
  WmsBasketUnitStatus.PACKED,
] as const;
const ACTIVE_DEMAND_HOLD_BASKET_STATUSES = [
  WmsBasketStatus.ASSIGNED,
  WmsBasketStatus.IN_PICKING,
  WmsBasketStatus.FULL_HELD,
] as const;
const ACTIVE_DEMAND_MONITOR_BASKET_STATUSES = [
  ...ACTIVE_DEMAND_HOLD_BASKET_STATUSES,
  WmsBasketStatus.PACKING,
] as const;
const ACTIVE_BASKET_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.IN_PICKING,
  WmsFulfillmentOrderStatus.READY_FOR_PACK,
  WmsFulfillmentOrderStatus.PICKED,
  WmsFulfillmentOrderStatus.PACKING,
] as const;
const FULFILLABLE_UNIT_STATUSES = [
  WmsInventoryUnitStatus.PUTAWAY,
] as const;
const CONFIRMED_POS_ORDER_STATUS = 1;
const WAITING_FOR_PICKUP_POS_ORDER_STATUS = 9;
const WAITING_FOR_PRINTING_POS_ORDER_STATUS = 12;
const CANCELED_POS_ORDER_STATUS = 6;
const ACTIVE_WMS_TENANT_STATUSES = [TenantStatus.ACTIVE, TenantStatus.TRIAL] as const;
const ITEM_ADJUSTMENT_ORDER_STATUSES = [
  WmsFulfillmentOrderStatus.READY,
  WmsFulfillmentOrderStatus.PARTIAL,
  WmsFulfillmentOrderStatus.RESTOCKING,
] as const;

type BasketUnitRestoreState = {
  fromLocationId: string | null;
  fromStatus: WmsInventoryUnitStatus | null;
  warehouseId: string | null;
};

type DemandHealthDemandRecord = Prisma.WmsBasketPickDemandGetPayload<{
  include: {
    basket: {
      select: {
        id: true;
        barcode: true;
        status: true;
        updatedAt: true;
      };
    };
    fulfillmentOrder: {
      select: {
        id: true;
        posOrderId: true;
        status: true;
      };
    };
    bins: {
      include: {
        location: {
          select: {
            id: true;
            code: true;
            name: true;
          };
        };
      };
    };
  };
}>;

type DemandHealthBasketUnitRecord = Prisma.WmsBasketUnitGetPayload<{
  select: {
    id: true;
    basketId: true;
    tenantId: true;
    storeId: true;
    variationId: true;
    sourceLocationId: true;
    status: true;
    fulfillmentLineId: true;
  };
}>;

type DemandMismatchRecord = {
  basketId: string;
  basketCode: string;
  basketStatus: WmsBasketStatus;
  basketUpdatedAt: Date;
  demandId: string;
  fulfillmentOrderId: string;
  fulfillmentLineId: string;
  posOrderId: string;
  tenantId: string;
  storeId: string;
  variationId: string;
  productName: string;
  productDisplayId: string | null;
  quantityRequired: number;
  storedPicked: number;
  actualPicked: number;
  storedPacked: number;
  actualPacked: number;
  binMismatches: Array<{
    binId: string;
    binCode: string;
    quantityTarget: number;
    storedPicked: number;
    actualPicked: number;
  }>;
};

type DemandActualCountState = {
  actualPickedByDemandId: Map<string, number>;
  actualPackedByDemandId: Map<string, number>;
  actualPickedByBinId: Map<string, number>;
  mismatches: DemandMismatchRecord[];
};

type RepairResultRecord = {
  basketId: string;
  basketCode: string;
  status: 'released' | 'removed' | 'recalculated' | 'skipped' | 'error';
  reason?: string;
  releasedOrders?: number;
  releasedUnits?: number;
  detachedPackedUnits?: number;
  detachedPackedOrders?: number;
  removedUnits?: number;
  updatedDemands?: number;
  updatedBins?: number;
};

@Injectable()
export class WmsFulfillmentOpsService {
  private readonly logger = new Logger(WmsFulfillmentOpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly wmsStaffActivityService: WmsStaffActivityService,
    private readonly wmsFulfillmentSyncService: WmsFulfillmentSyncService,
  ) {}

  private getPriorityTransactionOptions() {
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

  async getOpsHealth(query: GetWmsFulfillmentOpsSnapshotDto) {
    const scope = await this.resolveTenantScope(query.tenantId, query.allTenants === true);
    const limit = query.limit ?? DEFAULT_OPS_LIMIT;
    const staleMinutes = query.staleMinutes ?? DEFAULT_STALE_MINUTES;
    const staleThreshold = new Date(Date.now() - staleMinutes * 60_000);

    if (!scope.activeTenantId && !scope.canAccessAllTenants) {
      return this.buildEmptyOpsHealth(scope, limit, staleMinutes);
    }

    const demandBasketWhere: Prisma.WmsBasketWhereInput = {
      status: {
        in: [...ACTIVE_DEMAND_MONITOR_BASKET_STATUSES],
      },
      pickDemands: {
        some: scope.activeTenantId ? { tenantId: scope.activeTenantId } : {},
      },
    };

    const [legacyReservationCount, demandBasketCount, pickedNotPackedCount, legacyReservations, activeDemandBaskets, pickedNotPackedBasketUnits, activeDemandBasketIds] =
      await Promise.all([
        this.prisma.wmsPickReservation.count({
          where: {
            status: {
              in: [...ACTIVE_PICK_RESERVATION_STATUSES],
            },
            ...(scope.activeTenantId ? { tenantId: scope.activeTenantId } : {}),
            fulfillmentOrder: {
              assignmentMode: WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
            },
          },
        }),
        this.prisma.wmsBasket.count({
          where: demandBasketWhere,
        }),
        this.prisma.wmsBasketUnit.count({
          where: {
            status: WmsBasketUnitStatus.PICKED,
            ...(scope.activeTenantId ? { tenantId: scope.activeTenantId } : {}),
          },
        }),
        this.prisma.wmsPickReservation.findMany({
          where: {
            status: {
              in: [...ACTIVE_PICK_RESERVATION_STATUSES],
            },
            ...(scope.activeTenantId ? { tenantId: scope.activeTenantId } : {}),
            fulfillmentOrder: {
              assignmentMode: WmsFulfillmentAssignmentMode.SERIAL_RESERVED,
            },
          },
          select: {
            id: true,
            status: true,
            createdAt: true,
            fulfillmentOrder: {
              select: {
                id: true,
                posOrderId: true,
                status: true,
                basket: {
                  select: {
                    id: true,
                    barcode: true,
                  },
                },
              },
            },
            fulfillmentLine: {
              select: {
                id: true,
                variationId: true,
                productName: true,
                quantityRequired: true,
              },
            },
            inventoryUnit: {
              select: {
                id: true,
                code: true,
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
                  },
                },
              },
            },
          },
          orderBy: [
            { createdAt: 'asc' },
            { id: 'asc' },
          ],
          take: limit,
        }),
        this.prisma.wmsBasket.findMany({
          where: demandBasketWhere,
          select: {
            id: true,
            barcode: true,
            status: true,
            tenantId: true,
            warehouseId: true,
            claimedAt: true,
            fullAt: true,
            readyForPackAt: true,
            updatedAt: true,
            warehouse: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
            assignedPicker: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
            assignedPacker: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
            fulfillmentOrders: {
              where: {
                assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
                status: {
                  in: [...ACTIVE_BASKET_ORDER_STATUSES],
                },
                ...(scope.activeTenantId ? { tenantId: scope.activeTenantId } : {}),
              },
              select: {
                id: true,
                tenantId: true,
                storeId: true,
                posOrderId: true,
                status: true,
              },
            },
            pickDemands: {
              where: scope.activeTenantId ? { tenantId: scope.activeTenantId } : {},
              select: {
                id: true,
                tenantId: true,
                quantityRequired: true,
                quantityPicked: true,
                quantityPacked: true,
              },
            },
            basketUnits: {
              where: scope.activeTenantId ? { tenantId: scope.activeTenantId } : {},
              select: {
                id: true,
                status: true,
              },
            },
          },
          orderBy: [
            { updatedAt: 'asc' },
            { claimedAt: 'asc' },
          ],
          take: limit,
        }),
        this.prisma.wmsBasketUnit.findMany({
          where: {
            status: WmsBasketUnitStatus.PICKED,
            ...(scope.activeTenantId ? { tenantId: scope.activeTenantId } : {}),
          },
          select: {
            id: true,
            tenantId: true,
            storeId: true,
            basketId: true,
            pickedAt: true,
            variationId: true,
            basket: {
              select: {
                id: true,
                barcode: true,
                status: true,
              },
            },
            sourceLocation: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
            inventoryUnit: {
              select: {
                id: true,
                code: true,
              },
            },
          },
          orderBy: [
            { pickedAt: 'asc' },
            { id: 'asc' },
          ],
          take: limit,
        }),
        this.prisma.wmsBasket.findMany({
          where: demandBasketWhere,
          select: {
            id: true,
          },
        }),
      ]);

    const mismatchState = await this.computeDemandActualCountState({
      basketIds: activeDemandBasketIds.map((basket) => basket.id),
      tenantId: scope.activeTenantId ?? null,
    });

    return {
      tenantReady: Boolean(scope.activeTenantId || scope.canAccessAllTenants),
      filters: {
        tenants: scope.tenants,
        activeTenantId: scope.activeTenantId,
        limit,
        staleMinutes,
      },
      summary: {
        activeLegacyReservations: legacyReservationCount,
        activeDemandBaskets: demandBasketCount,
        pickedNotPackedBasketUnits: pickedNotPackedCount,
        demandQuantityMismatches: mismatchState.mismatches.length,
      },
      legacyReservations: legacyReservations.map((reservation) => ({
        id: reservation.id,
        status: reservation.status,
        createdAt: reservation.createdAt,
        fulfillmentOrderId: reservation.fulfillmentOrder.id,
        posOrderId: reservation.fulfillmentOrder.posOrderId,
        fulfillmentOrderStatus: reservation.fulfillmentOrder.status,
        basketId: reservation.fulfillmentOrder.basket?.id ?? null,
        basketCode: reservation.fulfillmentOrder.basket?.barcode ?? null,
        fulfillmentLineId: reservation.fulfillmentLine.id,
        variationId: reservation.fulfillmentLine.variationId,
        productName: reservation.fulfillmentLine.productName,
        quantityRequired: reservation.fulfillmentLine.quantityRequired,
        inventoryUnitId: reservation.inventoryUnit.id,
        inventoryUnitCode: reservation.inventoryUnit.code,
        warehouse: reservation.inventoryUnit.warehouse,
        currentLocation: reservation.inventoryUnit.currentLocation,
      })),
      activeDemandBaskets: activeDemandBaskets.map((basket) => {
        const tenantIds = Array.from(
          new Set([
            ...basket.fulfillmentOrders.map((order) => order.tenantId),
            ...basket.pickDemands.map((demand) => demand.tenantId),
          ]),
        );
        const pickedUnits = basket.basketUnits.filter((unit) => unit.status === WmsBasketUnitStatus.PICKED).length;
        const packedUnits = basket.basketUnits.filter((unit) => unit.status === WmsBasketUnitStatus.PACKED).length;

        return {
          id: basket.id,
          barcode: basket.barcode,
          status: basket.status,
          tenantId: basket.tenantId,
          warehouse: basket.warehouse,
          assignedPicker: this.mapActor(basket.assignedPicker),
          assignedPacker: this.mapActor(basket.assignedPacker),
          claimedAt: basket.claimedAt,
          fullAt: basket.fullAt,
          readyForPackAt: basket.readyForPackAt,
          updatedAt: basket.updatedAt,
          mixedTenant: tenantIds.length > 1,
          releaseCandidate: packedUnits === 0 && basket.updatedAt <= staleThreshold && tenantIds.length <= 1,
          orderCount: basket.fulfillmentOrders.length,
          demandRequired: basket.pickDemands.reduce((sum, demand) => sum + Math.max(demand.quantityRequired, 0), 0),
          demandPicked: basket.pickDemands.reduce((sum, demand) => sum + Math.max(demand.quantityPicked, 0), 0),
          demandPacked: basket.pickDemands.reduce((sum, demand) => sum + Math.max(demand.quantityPacked, 0), 0),
          pickedUnits,
          packedUnits,
          orders: basket.fulfillmentOrders.map((order) => ({
            id: order.id,
            tenantId: order.tenantId,
            storeId: order.storeId,
            posOrderId: order.posOrderId,
            status: order.status,
          })),
        };
      }),
      pickedNotPackedBasketUnits: pickedNotPackedBasketUnits.map((unit) => ({
        id: unit.id,
        tenantId: unit.tenantId,
        storeId: unit.storeId,
        basketId: unit.basket.id,
        basketCode: unit.basket.barcode,
        basketStatus: unit.basket.status,
        pickedAt: unit.pickedAt,
        variationId: unit.variationId,
        inventoryUnitId: unit.inventoryUnit.id,
        inventoryUnitCode: unit.inventoryUnit.code,
        sourceLocation: unit.sourceLocation,
      })),
      demandMismatches: mismatchState.mismatches
        .sort((left, right) => left.basketUpdatedAt.getTime() - right.basketUpdatedAt.getTime())
        .slice(0, limit),
    };
  }

  async getPriorityPreview(query: GetWmsFulfillmentPriorityPreviewDto) {
    const scope = await this.resolveTenantScope(query.tenantId);
    const scopedTenantId = this.requireScopedTenantId(scope.activeTenantId);
    const targetOrder = await this.loadPriorityTargetOrder(this.prisma, query.orderId, scopedTenantId);
    const donorOrders = await this.loadPriorityDonorOrders(this.prisma, targetOrder);
    const preview = this.buildPriorityPreview(targetOrder, donorOrders);

    return {
      success: true,
      ...preview,
    };
  }

  async getItemAdjustmentOptions(query: GetWmsFulfillmentAdjustmentOptionsDto) {
    const scope = await this.resolveTenantScope(query.tenantId);
    const tenantId = this.requireScopedTenantId(scope.activeTenantId);
    const order = await this.loadAdjustableOrder(this.prisma, query.orderId, tenantId);
    const options = await this.listItemAdjustmentStockOptions(this.prisma, {
      order,
      search: query.search?.trim() || null,
      limit: query.limit ?? 50,
    });

    return {
      success: true,
      order: {
        id: order.id,
        posOrderId: order.posOrderId,
        sourceRevision: order.sourceRevision,
        status: order.status,
      },
      options,
    };
  }

  async adjustItems(
    user: { userId?: string; id?: string; sessionId?: string | null },
    body: AdjustWmsFulfillmentOrderDto,
    request?: Request,
  ) {
    const scope = await this.resolveTenantScope(body.tenantId);
    const tenantId = this.requireScopedTenantId(scope.activeTenantId);
    const actorId = this.resolveActorId(user);
    const sessionId = this.resolveSessionId(user);
    if (!actorId) {
      throw new ForbiddenException('A signed-in supervisor is required to adjust fulfillment items.');
    }

    const reason = body.reason.trim();
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockFulfillmentOrdersForUpdate(tx, [body.orderId]);
      const order = await this.loadAdjustableOrder(tx, body.orderId, tenantId);

      if (order.sourceRevision !== body.expectedSourceRevision) {
        throw new ConflictException(
          'The POS order changed after this panel was opened. Refresh the order before adjusting its items.',
        );
      }

      if (order.changeState !== 'NONE') {
        throw new ConflictException(
          'This order has an unresolved POS item change. Let the automatic rebuild finish before applying an adjustment.',
        );
      }

      const sourceLine = order.lines.find((line) => line.id === body.sourceLineId);
      if (
        !sourceLine
        || sourceLine.status === WmsFulfillmentLineStatus.CANCELED
        || sourceLine.sourceQuantityRequired <= 0
      ) {
        throw new BadRequestException('Select an active item from the original POS order.');
      }

      const previouslyAdjustedSourceQuantity = order.fulfillmentAdjustments
        .filter((adjustment) => adjustment.sourceLineId === sourceLine.id)
        .reduce((sum, adjustment) => sum + adjustment.quantity, 0);
      const remainingOriginalQuantity = Math.max(
        sourceLine.sourceQuantityRequired - previouslyAdjustedSourceQuantity,
        0,
      );
      if (body.quantity > sourceLine.quantityRequired || body.quantity > remainingOriginalQuantity) {
        throw new BadRequestException(
          `Only ${Math.min(sourceLine.quantityRequired, remainingOriginalQuantity)} original unit(s) remain adjustable for ${sourceLine.productName}.`,
        );
      }

      const activeBasketUnits = await tx.wmsBasketUnit.count({
        where: {
          fulfillmentOrderId: order.id,
          status: { in: [...ACTIVE_BASKET_UNIT_STATUSES] },
        },
      });
      const pickedReservations = order.lines.reduce((count, line) => (
        count + line.reservations.filter(
          (reservation) => reservation.status === WmsPickReservationStatus.PICKED,
        ).length
      ), 0);
      if (activeBasketUnits > 0 || pickedReservations > 0 || order.pickedQuantity > 0) {
        throw new ConflictException(
          'This order already has scanned units. Use the item-change rework flow instead of a pre-pick adjustment.',
        );
      }

      let substitute: {
        productId: string;
        variationId: string;
        productName: string;
        productDisplayId: string | null;
      } | null = null;

      if (body.action === WmsFulfillmentAdjustmentActionDto.SUBSTITUTION) {
        const substituteVariationId = body.substituteVariationId?.trim();
        if (!substituteVariationId || substituteVariationId === sourceLine.variationId) {
          throw new BadRequestException('Select a different in-stock variation as the substitute.');
        }

        const stockOptions = await this.listItemAdjustmentStockOptions(tx, {
          order,
          variationId: substituteVariationId,
          limit: 1,
        });
        const selectedOption = stockOptions[0];
        if (!selectedOption || selectedOption.availableQuantity < body.quantity) {
          throw new ConflictException(
            `The selected substitute no longer has ${body.quantity} eligible unit(s). Refresh available stock and try again.`,
          );
        }

        substitute = {
          productId: selectedOption.productId,
          variationId: selectedOption.variationId,
          productName: selectedOption.productName,
          productDisplayId: selectedOption.productDisplayId,
        };
      }

      const nextSourceQuantity = sourceLine.quantityRequired - body.quantity;
      const sourceReservations = sourceLine.reservations.filter(
        (reservation) => reservation.status === WmsPickReservationStatus.RESERVED,
      );
      const reservationsToRelease = sourceReservations.slice(nextSourceQuantity);

      for (const reservation of reservationsToRelease) {
        const released = await tx.wmsPickReservation.updateMany({
          where: {
            id: reservation.id,
            status: WmsPickReservationStatus.RESERVED,
          },
          data: { status: WmsPickReservationStatus.RELEASED },
        });
        if (released.count !== 1) {
          throw new ConflictException('The reserved stock changed while applying the adjustment. Refresh and try again.');
        }

        const restored = await tx.wmsInventoryUnit.updateMany({
          where: {
            id: reservation.inventoryUnitId,
            status: WmsInventoryUnitStatus.RESERVED,
          },
          data: {
            status: WmsInventoryUnitStatus.PUTAWAY,
            updatedById: actorId,
          },
        });
        if (restored.count !== 1) {
          throw new ConflictException('A reserved inventory unit changed while applying the adjustment.');
        }

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
            referenceType: 'WMS_FULFILLMENT_ADJUSTMENT',
            referenceId: order.id,
            referenceCode: order.posOrderId,
            notes: `${body.action === WmsFulfillmentAdjustmentActionDto.SUBSTITUTION ? 'Substituted' : 'Bypassed'} ${body.quantity} unit(s) of ${sourceLine.productName}: ${reason}`,
            actorId,
            createdAt: now,
          },
        });
      }

      const keptSourceReservations = sourceReservations.length - reservationsToRelease.length;
      await tx.wmsFulfillmentLine.update({
        where: { id: sourceLine.id },
        data: {
          quantityRequired: nextSourceQuantity,
          quantityAllocated: Math.min(keptSourceReservations, nextSourceQuantity),
          quantityPicked: 0,
          status: nextSourceQuantity === 0
            ? WmsFulfillmentLineStatus.CANCELED
            : keptSourceReservations >= nextSourceQuantity
              ? WmsFulfillmentLineStatus.READY
              : keptSourceReservations > 0
                ? WmsFulfillmentLineStatus.PARTIAL
                : WmsFulfillmentLineStatus.RESTOCKING,
          issueReason: null,
        },
      });

      let substituteLineId: string | null = null;
      if (substitute) {
        const existingSubstituteLine = order.lines.find(
          (line) => line.variationId === substitute?.variationId,
        );
        const nextSubstituteQuantity = (existingSubstituteLine?.quantityRequired ?? 0) + body.quantity;
        const substituteLine = await tx.wmsFulfillmentLine.upsert({
          where: {
            fulfillmentOrderId_variationId: {
              fulfillmentOrderId: order.id,
              variationId: substitute.variationId,
            },
          },
          create: {
            fulfillmentOrderId: order.id,
            tenantId: order.tenantId,
            productId: substitute.productId,
            variationId: substitute.variationId,
            productName: substitute.productName,
            productDisplayId: substitute.productDisplayId,
            sourceQuantityRequired: 0,
            quantityRequired: body.quantity,
            status: WmsFulfillmentLineStatus.RESTOCKING,
            lineSnapshot: {
              fulfillmentAdjustment: true,
              sourceLineId: sourceLine.id,
              sourceVariationId: sourceLine.variationId,
            },
          },
          update: {
            productId: substitute.productId,
            productName: substitute.productName,
            productDisplayId: substitute.productDisplayId,
            quantityRequired: nextSubstituteQuantity,
            status: WmsFulfillmentLineStatus.RESTOCKING,
            issueReason: null,
          },
          select: { id: true },
        });
        substituteLineId = substituteLine.id;
      }

      const adjustment = await tx.wmsFulfillmentAdjustment.create({
        data: {
          tenantId: order.tenantId,
          fulfillmentOrderId: order.id,
          sourceLineId: sourceLine.id,
          sourceVariationId: sourceLine.variationId,
          sourceProductId: sourceLine.productId,
          sourceProductName: sourceLine.productName,
          sourceProductDisplayId: sourceLine.productDisplayId,
          substituteVariationId: substitute?.variationId ?? null,
          substituteProductId: substitute?.productId ?? null,
          substituteProductName: substitute?.productName ?? null,
          substituteProductDisplayId: substitute?.productDisplayId ?? null,
          type: body.action === WmsFulfillmentAdjustmentActionDto.SUBSTITUTION
            ? WmsFulfillmentAdjustmentType.SUBSTITUTION
            : WmsFulfillmentAdjustmentType.BYPASS,
          status: WmsFulfillmentAdjustmentStatus.ACTIVE,
          quantity: body.quantity,
          reason,
          sourceRevision: order.sourceRevision,
          createdById: actorId,
        },
      });

      if (substitute && order.assignmentMode === WmsFulfillmentAssignmentMode.SERIAL_RESERVED) {
        await this.reserveSubstituteUnitsTx(tx, {
          order,
          fulfillmentLineId: substituteLineId!,
          substitute,
          quantity: body.quantity,
          actorId,
          now,
        });
      }

      if (order.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
        await this.wmsFulfillmentSyncService.refreshDemandQueueForScopeTx(tx, {
          tenantId: order.tenantId,
          storeId: order.storeId,
          variationIds: [sourceLine.variationId, ...(substitute ? [substitute.variationId] : [])],
        }, now);
      } else {
        await this.refreshFulfillmentOrderProgressState(tx, order.id, now);
      }

      const refreshedOrder = await tx.wmsFulfillmentOrder.findUniqueOrThrow({
        where: { id: order.id },
        select: {
          status: true,
          sourceTotalQuantity: true,
          totalQuantity: true,
          allocatedQuantity: true,
          pickedQuantity: true,
        },
      });
      if (refreshedOrder.totalQuantity <= 0) {
        throw new BadRequestException('At least one unit must remain in the fulfillment order. Cancel the order instead.');
      }

      return {
        order,
        adjustment,
        sourceLine,
        substitute,
        refreshedOrder,
      };
    }, this.getPriorityTransactionOptions());

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId: result.order.tenantId,
      actorId,
      sessionId,
      actionType: 'FULFILLMENT_ITEM_ADJUSTMENT',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: result.order.id,
      metadata: {
        adjustmentId: result.adjustment.id,
        action: body.action,
        sourceRevision: result.order.sourceRevision,
        sourceLineId: result.sourceLine.id,
        sourceVariationId: result.sourceLine.variationId,
        sourceProductName: result.sourceLine.productName,
        substituteVariationId: result.substitute?.variationId ?? null,
        substituteProductName: result.substitute?.productName ?? null,
        quantity: body.quantity,
        reason,
        resultingStatus: result.refreshedOrder.status,
      } as Prisma.InputJsonValue,
    });

    return {
      success: true,
      order: {
        id: result.order.id,
        posOrderId: result.order.posOrderId,
        status: result.refreshedOrder.status,
        statusLabel: this.formatEnumLabel(result.refreshedOrder.status),
        sourceRevision: result.order.sourceRevision,
        sourceTotalQuantity: result.refreshedOrder.sourceTotalQuantity,
        effectiveTotalQuantity: result.refreshedOrder.totalQuantity,
        allocatedQuantity: result.refreshedOrder.allocatedQuantity,
        pickedQuantity: result.refreshedOrder.pickedQuantity,
      },
      adjustment: {
        id: result.adjustment.id,
        type: result.adjustment.type,
        quantity: result.adjustment.quantity,
        sourceProductName: result.adjustment.sourceProductName,
        substituteProductName: result.substitute?.productName ?? null,
        reason: result.adjustment.reason,
        createdAt: result.adjustment.createdAt,
      },
    };
  }

  async prioritizeOrder(
    user: { userId?: string; id?: string; sessionId?: string | null },
    body: PrioritizeWmsFulfillmentOrderDto,
    request?: Request,
  ) {
    const scope = await this.resolveTenantScope(body.tenantId);
    const scopedTenantId = this.requireScopedTenantId(scope.activeTenantId);
    const actorId = this.resolveActorId(user);
    const sessionId = this.resolveSessionId(user);
    const reason = body.reason?.trim() || `Priority override applied to order #${body.orderId}`;
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const initialTargetOrder = await this.loadPriorityTargetOrder(tx, body.orderId, scopedTenantId);
      const initialDonorOrders = await this.loadPriorityDonorOrders(tx, initialTargetOrder);
      const selectedDonorIds = new Set(body.donorOrderIds);
      const initialSelectedPlan = this.buildPriorityPreview(
        initialTargetOrder,
        initialDonorOrders,
        selectedDonorIds,
      );
      const initialSelectedOrderIds = initialSelectedPlan.donors.map((donor) => donor.id);

      if (initialSelectedOrderIds.length !== selectedDonorIds.size) {
        throw new BadRequestException('One or more selected donor orders are no longer eligible for priority release.');
      }

      if (!initialSelectedPlan.summary.canFullyPrioritize) {
        throw new BadRequestException(
          `Selected donors can only release ${initialSelectedPlan.summary.totalSuggestedQty} of ${initialSelectedPlan.summary.targetShortage} required unit(s).`,
        );
      }

      await this.lockFulfillmentOrdersForUpdate(tx, [initialTargetOrder.id, ...initialSelectedOrderIds]);

      const targetOrder = await this.loadPriorityTargetOrder(tx, body.orderId, scopedTenantId);
      const donorOrders = await this.loadPriorityDonorOrders(tx, targetOrder);
      const selectedPlan = this.buildPriorityPreview(targetOrder, donorOrders, selectedDonorIds);
      const selectedOrderIds = selectedPlan.donors.map((donor) => donor.id);

      if (selectedOrderIds.length !== selectedDonorIds.size || !selectedPlan.summary.canFullyPrioritize) {
        throw new ConflictException('The selected allocation changed while prioritizing. Refresh the donor list and try again.');
      }

      await tx.wmsFulfillmentOrder.update({
        where: { id: targetOrder.id },
        data: {
          priorityOverrideAt: now,
          priorityOverrideReason: reason,
          priorityReleasedForOrderId: null,
        },
      });

      await tx.wmsFulfillmentOrder.updateMany({
        where: {
          priorityReleasedForOrderId: targetOrder.id,
          ...(selectedOrderIds.length > 0
            ? {
                id: {
                  notIn: selectedOrderIds,
                },
              }
            : {}),
        },
        data: {
          priorityReleasedForOrderId: null,
        },
      });

      await tx.wmsFulfillmentOrder.updateMany({
        where: {
          id: {
            in: selectedOrderIds,
          },
        },
        data: {
          priorityReleasedForOrderId: targetOrder.id,
        },
      });

      await this.applyPriorityReallocationPlanTx(tx, {
        targetOrder,
        selectedPlan,
        reason,
        now,
      });

      await this.wmsFulfillmentSyncService.refreshDemandQueueForScopeTx(tx, {
        tenantId: targetOrder.tenantId,
        storeId: targetOrder.storeId,
      }, now);

      const refreshedTarget = await tx.wmsFulfillmentOrder.findUnique({
        where: { id: targetOrder.id },
        select: {
          status: true,
          allocatedQuantity: true,
          totalQuantity: true,
        },
      });

      if (!refreshedTarget || refreshedTarget.status !== WmsFulfillmentOrderStatus.READY) {
        throw new ConflictException(
          'The order could not be fully backed by eligible warehouse units. Refresh stock and donor availability, then try again.',
        );
      }

      await this.wmsStaffActivityService.recordFromRequest({
        request,
        tenantId: targetOrder.tenantId,
        actorId,
        sessionId,
        actionType: 'FULFILLMENT_PRIORITY_APPLY',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: targetOrder.id,
        metadata: {
          mode: 'BASKET_DEMAND',
          targetOrderId: targetOrder.id,
          targetPosOrderId: targetOrder.posOrderId,
          donorOrderIds: selectedOrderIds,
          donorPosOrderIds: selectedPlan.donors.map((donor) => donor.posOrderId),
          totalFreedUnits: selectedPlan.summary.totalSuggestedQty,
          targetShortage: selectedPlan.summary.targetShortage,
          reason,
        } as Prisma.InputJsonValue,
      });

      return {
        targetOrder,
        summary: selectedPlan.summary,
        donorOrderIds: selectedOrderIds,
        donorPosOrderIds: selectedPlan.donors.map((donor) => donor.posOrderId),
      };
    }, this.getPriorityTransactionOptions());

    return {
      success: true,
      targetOrderId: result.targetOrder.id,
      targetPosOrderId: result.targetOrder.posOrderId,
      donorOrderIds: result.donorOrderIds,
      donorPosOrderIds: result.donorPosOrderIds,
      summary: result.summary,
    };
  }

  private async applyPriorityReallocationPlanTx(
    tx: Prisma.TransactionClient,
    params: {
      targetOrder: Awaited<ReturnType<WmsFulfillmentOpsService['loadPriorityTargetOrder']>>;
      selectedPlan: ReturnType<WmsFulfillmentOpsService['buildPriorityPreview']>;
      reason: string;
      now: Date;
    },
  ) {
    const targetTransferByVariation = new Map<string, number>();
    const donorLineReleaseById = new Map<string, number>();
    const donorOrderReleaseById = new Map<string, number>();

    for (const donor of params.selectedPlan.donors) {
      let donorReleasedQty = 0;

      for (const line of donor.lines) {
        if (line.suggestedGiveQty <= 0) {
          continue;
        }

        donorLineReleaseById.set(line.id, line.suggestedGiveQty);
        donorReleasedQty += line.suggestedGiveQty;
        targetTransferByVariation.set(
          line.variationId,
          (targetTransferByVariation.get(line.variationId) ?? 0) + line.suggestedGiveQty,
        );
      }

      if (donorReleasedQty > 0) {
        donorOrderReleaseById.set(donor.id, donorReleasedQty);
      }
    }

    for (const line of params.targetOrder.lines) {
      if (line.status === WmsFulfillmentLineStatus.CANCELED) {
        continue;
      }

      const required = Math.max(line.quantityRequired, 0);
      const picked = Math.max(line.quantityPicked, 0);
      const currentAllocated = Math.max(line.quantityAllocated, 0);
      const addedAllocation = targetTransferByVariation.get(line.variationId) ?? 0;
      const nextAllocated = Math.min(required, currentAllocated + addedAllocation);
      const nextStatus = this.resolvePriorityLineStatus({
        required,
        picked,
        allocated: nextAllocated,
      });

      await tx.wmsFulfillmentLine.update({
        where: { id: line.id },
        data: {
          quantityAllocated: nextAllocated,
          status: nextStatus,
          issueReason: nextAllocated > 0 ? null : line.issueReason,
        },
      });
    }

    const targetAllocatedQuantity = params.targetOrder.lines.reduce((sum, line) => (
      sum + Math.min(
        Math.max(line.quantityRequired, 0),
        Math.max(line.quantityAllocated, 0) + (targetTransferByVariation.get(line.variationId) ?? 0),
      )
    ), 0);

    await tx.wmsFulfillmentOrder.update({
      where: { id: params.targetOrder.id },
      data: {
        status: targetAllocatedQuantity >= params.targetOrder.totalQuantity
          ? WmsFulfillmentOrderStatus.READY
          : targetAllocatedQuantity > 0
            ? WmsFulfillmentOrderStatus.PARTIAL
            : WmsFulfillmentOrderStatus.RESTOCKING,
        allocatedQuantity: targetAllocatedQuantity,
        issueReason: null,
        lastSyncedAt: params.now,
      },
    });

    if (donorOrderReleaseById.size === 0) {
      return;
    }

    const donorOrders = await tx.wmsFulfillmentOrder.findMany({
      where: {
        id: {
          in: Array.from(donorOrderReleaseById.keys()),
        },
      },
      include: {
        lines: {
          orderBy: [
            { createdAt: 'asc' },
            { id: 'asc' },
          ],
        },
      },
    });

    for (const donorOrder of donorOrders) {
      const releasedQty = donorOrderReleaseById.get(donorOrder.id) ?? 0;

      for (const line of donorOrder.lines) {
        if (line.status === WmsFulfillmentLineStatus.CANCELED) {
          continue;
        }

        const currentAllocated = Math.max(line.quantityAllocated, 0);
        const releasedLineQty = donorLineReleaseById.get(line.id) ?? 0;
        const nextAllocated = Math.max(0, currentAllocated - releasedLineQty);
        const nextStatus = this.resolvePriorityLineStatus({
          required: Math.max(line.quantityRequired, 0),
          picked: Math.max(line.quantityPicked, 0),
          allocated: nextAllocated,
        });

        await tx.wmsFulfillmentLine.update({
          where: { id: line.id },
          data: {
            quantityAllocated: nextAllocated,
            status: nextStatus,
            issueReason: nextAllocated > 0 ? null : `Released for priority order #${params.targetOrder.posOrderId}`,
          },
        });
      }

      const nextAllocatedQuantity = Math.max(0, donorOrder.allocatedQuantity - releasedQty);
      const nextStatus = nextAllocatedQuantity >= donorOrder.totalQuantity
        ? WmsFulfillmentOrderStatus.READY
        : nextAllocatedQuantity > 0
          ? WmsFulfillmentOrderStatus.PARTIAL
          : WmsFulfillmentOrderStatus.RESTOCKING;

      await tx.wmsFulfillmentOrder.update({
        where: { id: donorOrder.id },
        data: {
          status: nextStatus,
          allocatedQuantity: nextAllocatedQuantity,
          issueReason: nextAllocatedQuantity > 0 ? null : `Released for priority order #${params.targetOrder.posOrderId}`,
          lastSyncedAt: params.now,
        },
      });
    }
  }

  private resolvePriorityLineStatus(params: {
    required: number;
    allocated: number;
    picked: number;
  }) {
    if (params.picked >= params.required && params.required > 0) {
      return WmsFulfillmentLineStatus.PICKED;
    }

    if (params.allocated >= params.required && params.required > 0) {
      return WmsFulfillmentLineStatus.READY;
    }

    if (params.allocated > 0) {
      return WmsFulfillmentLineStatus.PARTIAL;
    }

    return WmsFulfillmentLineStatus.RESTOCKING;
  }

  async releasePriority(
    user: { userId?: string; id?: string; sessionId?: string | null },
    body: ReleaseWmsFulfillmentPriorityDto,
    request?: Request,
  ) {
    const scope = await this.resolveTenantScope(body.tenantId);
    const scopedTenantId = this.requireScopedTenantId(scope.activeTenantId);
    const actorId = this.resolveActorId(user);
    const sessionId = this.resolveSessionId(user);

    const result = await this.prisma.$transaction(async (tx) => {
      const targetOrder = await this.loadPriorityTargetOrder(tx, body.orderId, scopedTenantId);
      const preview = this.buildPriorityPreview(targetOrder, await this.loadPriorityDonorOrders(tx, targetOrder));
      const clearResult = await this.wmsFulfillmentSyncService.clearPriorityOverridesTx(tx, {
        targetOrderIds: [targetOrder.id],
      });

      await this.wmsStaffActivityService.recordFromRequest({
        request,
        tenantId: targetOrder.tenantId,
        actorId,
        sessionId,
        actionType: 'FULFILLMENT_PRIORITY_RELEASE',
        resourceType: 'WMS_FULFILLMENT_ORDER',
        resourceId: targetOrder.id,
        metadata: {
          mode: 'BASKET_DEMAND',
          targetOrderId: targetOrder.id,
          targetPosOrderId: targetOrder.posOrderId,
          donorOrderIds: preview.donors.map((donor) => donor.id),
          donorPosOrderIds: preview.donors.map((donor) => donor.posOrderId),
          clearedTargets: clearResult.clearedTargets,
          clearedDonors: clearResult.clearedDonors,
        } as Prisma.InputJsonValue,
      });

      return {
        targetOrder,
        clearResult,
        variationIds: preview.target.lines
          .filter((line) => line.shortage > 0 || line.allocated > 0)
          .map((line) => line.variationId),
      };
    });

    await this.wmsFulfillmentSyncService.refreshDemandQueueForScope({
      tenantId: result.targetOrder.tenantId,
      storeId: result.targetOrder.storeId,
      variationIds: result.variationIds,
    });

    return {
      success: true,
      targetOrderId: result.targetOrder.id,
      targetPosOrderId: result.targetOrder.posOrderId,
      clearedTargets: result.clearResult.clearedTargets,
      clearedDonors: result.clearResult.clearedDonors,
    };
  }

  async releaseAbandonedDemandBaskets(
    user: { userId?: string; id?: string; sessionId?: string | null },
    body: RepairWmsDemandBasketsDto,
    request?: Request,
  ) {
    if (!body.tenantId && !body.basketId) {
      throw new BadRequestException('Select a tenant or basket before releasing abandoned demand baskets');
    }

    const scope = await this.resolveTenantScope(body.tenantId);
    const limit = body.limit ?? DEFAULT_OPS_LIMIT;
    const olderThanMinutes = body.olderThanMinutes ?? DEFAULT_STALE_MINUTES;
    const staleThreshold = new Date(Date.now() - olderThanMinutes * 60_000);
    const where: Prisma.WmsBasketWhereInput = {
      status: {
        in: [...ACTIVE_DEMAND_MONITOR_BASKET_STATUSES],
      },
      ...(body.basketId ? { id: body.basketId } : {}),
      ...(body.basketId
        ? {
            pickDemands: {
              some: scope.activeTenantId ? { tenantId: scope.activeTenantId } : {},
            },
          }
        : {
            updatedAt: {
              lte: staleThreshold,
            },
            pickDemands: {
              some: scope.activeTenantId ? { tenantId: scope.activeTenantId } : {},
            },
          }),
    };

    const baskets = await this.prisma.wmsBasket.findMany({
      where,
      select: {
        id: true,
        barcode: true,
      },
      orderBy: [
        { updatedAt: 'asc' },
        { claimedAt: 'asc' },
      ],
      take: limit,
    });

    const actorId = this.resolveActorId(user);
    const results: RepairResultRecord[] = [];

    for (const basket of baskets) {
      try {
        const result = await this.prisma.$transaction(async (tx) => (
          this.releaseDemandBasketTx(tx, {
            basketId: basket.id,
            scopedTenantId: body.basketId ? null : (scope.activeTenantId ?? null),
            actorId,
            allowPackedDetach: body.allowPackedDetach === true,
            now: new Date(),
            request,
            sessionId: this.resolveSessionId(user),
          })
        ));
        results.push(result);
      } catch (error) {
        results.push({
          basketId: basket.id,
          basketCode: basket.barcode,
          status: 'error',
          reason: error instanceof Error ? error.message : 'Unknown repair error',
        });
      }
    }

    return {
      success: true,
      processedCount: results.length,
      releasedCount: results.filter((result) => result.status === 'released').length,
      results,
    };
  }

  async releaseDemandBasketOrdersForPackVoid(
    user: { userId?: string; id?: string; sessionId?: string | null },
    params: {
      basketId: string;
      orderIds: string[];
      reason: string;
    },
    request?: Request,
  ) {
    const orderIds = Array.from(new Set(
      params.orderIds
        .map((orderId) => orderId?.trim())
        .filter((orderId): orderId is string => Boolean(orderId)),
    ));

    if (!params.basketId?.trim()) {
      throw new BadRequestException('Select a basket before voiding pack orders');
    }

    if (orderIds.length === 0) {
      throw new BadRequestException('Select at least one order before voiding pack work');
    }

    const actorId = this.resolveActorId(user);
    return this.prisma.$transaction(async (tx) => (
      this.releaseDemandBasketOrdersForPackVoidTx(tx, {
        basketId: params.basketId,
        orderIds,
        reason: params.reason,
        actorId,
        now: new Date(),
        request,
        sessionId: this.resolveSessionId(user),
      })
    ));
  }

  async releaseDemandOrderForDispatchVoid(
    user: { userId?: string; id?: string; sessionId?: string | null },
    params: {
      fulfillmentOrderId: string;
      reason: string;
    },
    request?: Request,
  ) {
    if (!params.fulfillmentOrderId?.trim()) {
      throw new BadRequestException('Select a packed order before voiding dispatch work');
    }

    const reason = params.reason?.trim() ?? '';
    if (!reason) {
      throw new BadRequestException('Void reason is required');
    }

    const actorId = this.resolveActorId(user);
    return this.prisma.$transaction(async (tx) => (
      this.releaseDemandOrderForDispatchVoidTx(tx, {
        fulfillmentOrderId: params.fulfillmentOrderId,
        actorId,
        now: new Date(),
        reason,
        request,
        sessionId: this.resolveSessionId(user),
      })
    ));
  }

  async repairDemandOrderAfterStuckDispatchVoid(
    user: { userId?: string; id?: string; sessionId?: string | null },
    params: {
      fulfillmentOrderId: string;
    },
    request?: Request,
  ) {
    if (!params.fulfillmentOrderId?.trim()) {
      throw new BadRequestException('Select a packed order before repairing dispatch state');
    }

    const actorId = this.resolveActorId(user);
    return this.prisma.$transaction(async (tx) => (
      this.repairDemandOrderAfterStuckDispatchVoidTx(tx, {
        fulfillmentOrderId: params.fulfillmentOrderId,
        actorId,
        now: new Date(),
        request,
        sessionId: this.resolveSessionId(user),
      })
    ));
  }

  async removeStaleBasketUnits(
    user: { userId?: string; id?: string; sessionId?: string | null },
    body: RepairWmsDemandBasketsDto,
    request?: Request,
  ) {
    if (!body.tenantId && !body.basketId) {
      throw new BadRequestException('Select a tenant or basket before removing stale basket units');
    }

    const scope = await this.resolveTenantScope(body.tenantId);
    const limit = body.limit ?? DEFAULT_OPS_LIMIT;
    const olderThanMinutes = body.olderThanMinutes ?? DEFAULT_STALE_MINUTES;
    const staleThreshold = new Date(Date.now() - olderThanMinutes * 60_000);
    const basketUnits = await this.prisma.wmsBasketUnit.findMany({
      where: {
        status: WmsBasketUnitStatus.PICKED,
        ...(body.basketId ? { basketId: body.basketId } : {}),
        ...(scope.activeTenantId ? { tenantId: scope.activeTenantId } : {}),
        ...(!body.basketId
          ? {
              pickedAt: {
                lte: staleThreshold,
              },
            }
          : {}),
        basket: {
          pickDemands: {
            some: {},
          },
        },
      },
      select: {
        id: true,
        basketId: true,
        basket: {
          select: {
            barcode: true,
          },
        },
      },
      orderBy: [
        { pickedAt: 'asc' },
        { id: 'asc' },
      ],
      take: limit,
    });

    const unitIdsByBasketId = new Map<string, string[]>();
    for (const basketUnit of basketUnits) {
      const existing = unitIdsByBasketId.get(basketUnit.basketId) ?? [];
      existing.push(basketUnit.id);
      unitIdsByBasketId.set(basketUnit.basketId, existing);
    }

    const actorId = this.resolveActorId(user);
    const results: RepairResultRecord[] = [];

    for (const [basketId, basketUnitIds] of unitIdsByBasketId.entries()) {
      const basketCode = basketUnits.find((unit) => unit.basketId === basketId)?.basket.barcode ?? basketId;
      try {
        const result = await this.prisma.$transaction(async (tx) => (
          this.removeStaleBasketUnitsTx(tx, {
            basketId,
            basketUnitIds,
            actorId,
            now: new Date(),
            request,
            sessionId: this.resolveSessionId(user),
          })
        ));
        results.push(result);
      } catch (error) {
        results.push({
          basketId,
          basketCode,
          status: 'error',
          reason: error instanceof Error ? error.message : 'Unknown repair error',
        });
      }
    }

    return {
      success: true,
      processedCount: results.length,
      removedCount: results.reduce((sum, result) => sum + (result.removedUnits ?? 0), 0),
      results,
    };
  }

  async recalculateDemandCounts(
    user: { userId?: string; id?: string; sessionId?: string | null },
    body: RecalculateWmsDemandCountsDto,
    request?: Request,
  ) {
    if (!body.tenantId && !body.basketId) {
      throw new BadRequestException('Select a tenant or basket before recalculating demand counts');
    }

    const scope = await this.resolveTenantScope(body.tenantId);
    const limit = body.limit ?? DEFAULT_OPS_LIMIT;
    const baskets = await this.prisma.wmsBasket.findMany({
      where: {
        ...(body.basketId ? { id: body.basketId } : {}),
        pickDemands: {
          some: scope.activeTenantId ? { tenantId: scope.activeTenantId } : {},
        },
      },
      select: {
        id: true,
        barcode: true,
      },
      orderBy: [
        { updatedAt: 'asc' },
        { claimedAt: 'asc' },
      ],
      take: limit,
    });

    const actorId = this.resolveActorId(user);
    const results: RepairResultRecord[] = [];

    for (const basket of baskets) {
      try {
        const result = await this.prisma.$transaction(async (tx) => (
          this.recalculateDemandCountsForBasketTx(tx, {
            basketId: basket.id,
            actorId,
            now: new Date(),
            request,
            sessionId: this.resolveSessionId(user),
          })
        ));
        results.push(result);
      } catch (error) {
        results.push({
          basketId: basket.id,
          basketCode: basket.barcode,
          status: 'error',
          reason: error instanceof Error ? error.message : 'Unknown repair error',
        });
      }
    }

    return {
      success: true,
      processedCount: results.length,
      recalculatedCount: results.filter((result) => result.status === 'recalculated').length,
      results,
    };
  }

  private async recalculateDemandCountsForBasketTx(
    tx: Prisma.TransactionClient,
    params: {
      basketId: string;
      actorId: string | null;
      now: Date;
      request?: Request;
      sessionId?: string | null;
    },
  ) {
    await this.lockBasketForUpdate(tx, params.basketId);
    const basket = await tx.wmsBasket.findUnique({
      where: { id: params.basketId },
      select: {
        id: true,
        barcode: true,
      },
    });

    if (!basket) {
      throw new BadRequestException('Demand basket was not found');
    }

    const syncResult = await this.syncDemandBasketCountsTx(tx, {
      basketId: basket.id,
      now: params.now,
      refreshBasketState: true,
    });

    await this.wmsStaffActivityService.recordFromRequest({
      request: params.request,
      tenantId: syncResult.demands[0]?.tenantId ?? null,
      actorId: params.actorId,
      sessionId: params.sessionId ?? null,
      actionType: 'FULFILLMENT_DEMAND_RECALCULATE',
      resourceType: 'WMS_BASKET',
      resourceId: basket.id,
      metadata: {
        basketCode: basket.barcode,
        mode: 'BASKET_DEMAND',
        updatedDemands: syncResult.updatedDemands,
        updatedBins: syncResult.updatedBins,
      } as Prisma.InputJsonValue,
    });

    return {
      basketId: basket.id,
      basketCode: basket.barcode,
      status: 'recalculated' as const,
      updatedDemands: syncResult.updatedDemands,
      updatedBins: syncResult.updatedBins,
    };
  }

  private async removeStaleBasketUnitsTx(
    tx: Prisma.TransactionClient,
    params: {
      basketId: string;
      basketUnitIds: string[];
      actorId: string | null;
      now: Date;
      request?: Request;
      sessionId?: string | null;
    },
  ) {
    await this.lockBasketForUpdate(tx, params.basketId);

    const basket = await tx.wmsBasket.findUnique({
      where: { id: params.basketId },
      select: {
        id: true,
        barcode: true,
      },
    });

    if (!basket) {
      throw new BadRequestException('Demand basket was not found');
    }

    const basketUnits = await tx.wmsBasketUnit.findMany({
      where: {
        basketId: basket.id,
        id: {
          in: params.basketUnitIds,
        },
        status: WmsBasketUnitStatus.PICKED,
      },
      select: {
        id: true,
        tenantId: true,
        inventoryUnitId: true,
        sourceLocationId: true,
        inventoryUnit: {
          select: {
            id: true,
            code: true,
            status: true,
          },
        },
      },
    });

    if (basketUnits.length === 0) {
      return {
        basketId: basket.id,
        basketCode: basket.barcode,
        status: 'skipped' as const,
        reason: 'No stale picked basket units matched the repair scope',
      };
    }

    const restoreStateByInventoryUnitId = await this.loadBasketUnitRestoreStates(
      tx,
      basket.id,
      basketUnits.map((basketUnit) => basketUnit.inventoryUnitId),
    );

    const restoredInventoryUnitIds = new Set<string>();
    for (const basketUnit of basketUnits) {
      const restoreState = restoreStateByInventoryUnitId.get(basketUnit.inventoryUnitId);
      if (!restoreState?.fromLocationId || !restoreState.fromStatus || !restoreState.warehouseId) {
        throw new ConflictException(`Unable to restore original bin state for unit ${basketUnit.inventoryUnit.code}`);
      }

      const restoredNow = await this.restoreInventoryUnitToPriorStateTx(tx, {
        inventoryUnitId: basketUnit.inventoryUnitId,
        expectedSourceStatus: WmsInventoryUnitStatus.PICKED,
        restoreState,
        actorId: params.actorId,
        conflictMessage: `Unit ${basketUnit.inventoryUnit.code} changed before the stale removal completed`,
      });

      if (restoredNow) {
        restoredInventoryUnitIds.add(basketUnit.inventoryUnitId);
      }

      const basketUnitUpdate = await tx.wmsBasketUnit.updateMany({
        where: {
          id: basketUnit.id,
          status: WmsBasketUnitStatus.PICKED,
        },
        data: {
          status: WmsBasketUnitStatus.REMOVED,
          removedById: params.actorId ?? undefined,
          removedAt: params.now,
        },
      });

      if (basketUnitUpdate.count !== 1) {
        throw new ConflictException(`Basket record for unit ${basketUnit.inventoryUnit.code} changed before removal completed`);
      }
    }

    const movementRows: Prisma.WmsInventoryMovementCreateManyInput[] = basketUnits.flatMap((basketUnit) => {
      if (!restoredInventoryUnitIds.has(basketUnit.inventoryUnitId)) {
        return [];
      }

      const restoreState = restoreStateByInventoryUnitId.get(basketUnit.inventoryUnitId);
      if (!restoreState?.fromLocationId || !restoreState.fromStatus || !restoreState.warehouseId) {
        throw new ConflictException(`Unable to restore original movement state for unit ${basketUnit.inventoryUnit.code}`);
      }

      return [{
        tenantId: basketUnit.tenantId,
        inventoryUnitId: basketUnit.inventoryUnitId,
        warehouseId: restoreState.warehouseId,
        fromLocationId: null,
        toLocationId: restoreState.fromLocationId,
        fromStatus: WmsInventoryUnitStatus.PICKED,
        toStatus: restoreState.fromStatus,
        movementType: WmsInventoryMovementType.TRANSFER,
        referenceType: 'WMS_BASKET_REPAIR',
        referenceId: basket.id,
        referenceCode: basket.barcode,
        notes: `Released stale STOX basket unit from ${basket.barcode}`,
        actorId: params.actorId,
        createdAt: params.now,
      }];
    });

    if (movementRows.length > 0) {
      await tx.wmsInventoryMovement.createMany({
        data: movementRows,
      });
    }

    const activeDemands = await tx.wmsBasketPickDemand.findMany({
      where: {
        basketId: basket.id,
      },
      select: {
        fulfillmentOrderId: true,
      },
    });

    await this.recalculateDemandCountsForBasketTx(tx, {
      basketId: basket.id,
      actorId: params.actorId,
      now: params.now,
      request: params.request,
      sessionId: params.sessionId,
    });

    await this.wmsStaffActivityService.recordFromRequest({
      request: params.request,
      tenantId: basketUnits[0]?.tenantId ?? null,
      actorId: params.actorId,
      sessionId: params.sessionId ?? null,
      actionType: 'FULFILLMENT_DEMAND_STALE_UNIT_REMOVE',
      resourceType: 'WMS_BASKET',
      resourceId: basket.id,
      metadata: {
        basketCode: basket.barcode,
        mode: 'BASKET_DEMAND',
        removedUnits: basketUnits.length,
        fulfillmentOrderIds: Array.from(new Set(activeDemands.map((demand) => demand.fulfillmentOrderId))),
      } as Prisma.InputJsonValue,
    });

    return {
      basketId: basket.id,
      basketCode: basket.barcode,
      status: 'removed' as const,
      removedUnits: basketUnits.length,
    };
  }

  private async releaseDemandBasketTx(
    tx: Prisma.TransactionClient,
    params: {
      basketId: string;
      scopedTenantId: string | null;
      actorId: string | null;
      allowPackedDetach?: boolean;
      now: Date;
      request?: Request;
      sessionId?: string | null;
    },
  ) {
    await this.lockBasketForUpdate(tx, params.basketId);

    const basket = await tx.wmsBasket.findUnique({
      where: { id: params.basketId },
      select: {
        id: true,
        barcode: true,
        status: true,
        tenantId: true,
        updatedAt: true,
        fulfillmentOrders: {
          where: {
            assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
            status: {
              in: [...ACTIVE_BASKET_ORDER_STATUSES],
            },
          },
          select: {
            id: true,
            tenantId: true,
            posOrderId: true,
          },
        },
        pickDemands: {
          select: {
            id: true,
            tenantId: true,
            fulfillmentOrderId: true,
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
            tenantId: true,
            inventoryUnitId: true,
            sourceLocationId: true,
            fulfillmentOrderId: true,
            status: true,
            inventoryUnit: {
              select: {
                id: true,
                code: true,
              },
            },
            fulfillmentOrder: {
              select: {
                id: true,
                status: true,
                posOrder: {
                  select: {
                    status: true,
                    isVoid: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!basket) {
      throw new BadRequestException('Demand basket was not found');
    }

    const activeTenantIds = Array.from(
      new Set([
        ...basket.fulfillmentOrders.map((order) => order.tenantId),
        ...basket.pickDemands.map((demand) => demand.tenantId),
        ...basket.basketUnits.map((basketUnit) => basketUnit.tenantId),
      ]),
    );
    if (params.scopedTenantId && activeTenantIds.length > 1) {
      return {
        basketId: basket.id,
        basketCode: basket.barcode,
        status: 'skipped' as const,
        reason: 'Basket contains demand work from multiple tenants and needs an explicit basket repair',
      };
    }

    const packedUnits = basket.basketUnits.filter((basketUnit) => basketUnit.status === WmsBasketUnitStatus.PACKED);
    const detachablePackedUnits = params.allowPackedDetach
      ? packedUnits.filter((basketUnit) => this.canDetachPackedBasketUnit(basketUnit.fulfillmentOrder))
      : [];
    const blockedPackedUnits = params.allowPackedDetach
      ? packedUnits.filter((basketUnit) => !this.canDetachPackedBasketUnit(basketUnit.fulfillmentOrder))
      : packedUnits;

    if (blockedPackedUnits.length > 0) {
      return {
        basketId: basket.id,
        basketCode: basket.barcode,
        status: 'skipped' as const,
        reason: params.allowPackedDetach
          ? 'Basket still contains active packed work. Finish or void the active PACK work before resetting this basket.'
          : 'Basket already contains packed units and cannot be safely released',
      };
    }

    const pickedUnits = basket.basketUnits.filter((basketUnit) => basketUnit.status === WmsBasketUnitStatus.PICKED);
    const restoreStateByInventoryUnitId = await this.loadBasketUnitRestoreStates(
      tx,
      basket.id,
      pickedUnits.map((basketUnit) => basketUnit.inventoryUnitId),
    );

    const restoredInventoryUnitIds = new Set<string>();
    for (const basketUnit of pickedUnits) {
      const restoreState = restoreStateByInventoryUnitId.get(basketUnit.inventoryUnitId);
      if (!restoreState?.fromLocationId || !restoreState.fromStatus || !restoreState.warehouseId) {
        throw new ConflictException(`Unable to restore original bin state for unit ${basketUnit.inventoryUnit.code}`);
      }

      const restoredNow = await this.restoreInventoryUnitToPriorStateTx(tx, {
        inventoryUnitId: basketUnit.inventoryUnitId,
        expectedSourceStatus: WmsInventoryUnitStatus.PICKED,
        restoreState,
        actorId: params.actorId,
        conflictMessage: `Unit ${basketUnit.inventoryUnit.code} changed before basket release completed`,
      });

      if (restoredNow) {
        restoredInventoryUnitIds.add(basketUnit.inventoryUnitId);
      }

      const basketUnitUpdate = await tx.wmsBasketUnit.updateMany({
        where: {
          id: basketUnit.id,
          status: WmsBasketUnitStatus.PICKED,
        },
        data: {
          status: WmsBasketUnitStatus.REMOVED,
          removedById: params.actorId ?? undefined,
          removedAt: params.now,
        },
      });

      if (basketUnitUpdate.count !== 1) {
        throw new ConflictException(`Basket record for unit ${basketUnit.inventoryUnit.code} changed before release completed`);
      }
    }

    if (detachablePackedUnits.length > 0) {
      const detachedPackedIds = detachablePackedUnits.map((basketUnit) => basketUnit.id);
      const packedDetachUpdate = await tx.wmsBasketUnit.updateMany({
        where: {
          id: {
            in: detachedPackedIds,
          },
          status: WmsBasketUnitStatus.PACKED,
        },
        data: {
          status: WmsBasketUnitStatus.REMOVED,
          removedById: params.actorId ?? undefined,
          removedAt: params.now,
        },
      });

      if (packedDetachUpdate.count !== detachedPackedIds.length) {
        throw new ConflictException(`Packed basket state changed before basket ${basket.barcode} could be reset`);
      }
    }

    if (pickedUnits.length > 0) {
      const movementRows: Prisma.WmsInventoryMovementCreateManyInput[] = pickedUnits.flatMap((basketUnit) => {
        if (!restoredInventoryUnitIds.has(basketUnit.inventoryUnitId)) {
          return [];
        }

        const restoreState = restoreStateByInventoryUnitId.get(basketUnit.inventoryUnitId);
        if (!restoreState?.fromLocationId || !restoreState.fromStatus || !restoreState.warehouseId) {
          throw new ConflictException(`Unable to restore original movement state for unit ${basketUnit.inventoryUnit.code}`);
        }

        return [{
          tenantId: basketUnit.tenantId,
          inventoryUnitId: basketUnit.inventoryUnitId,
          warehouseId: restoreState.warehouseId,
          fromLocationId: null,
          toLocationId: restoreState.fromLocationId,
          fromStatus: WmsInventoryUnitStatus.PICKED,
          toStatus: restoreState.fromStatus,
          movementType: WmsInventoryMovementType.TRANSFER,
          referenceType: 'WMS_BASKET_RELEASE',
          referenceId: basket.id,
          referenceCode: basket.barcode,
          notes: `Released abandoned STOX basket ${basket.barcode}`,
          actorId: params.actorId,
          createdAt: params.now,
        }];
      });

      if (movementRows.length > 0) {
        await tx.wmsInventoryMovement.createMany({
          data: movementRows,
        });
      }
    }

    await tx.wmsBasketPickDemand.deleteMany({
      where: {
        basketId: basket.id,
      },
    });

    await tx.wmsFulfillmentOrder.updateMany({
      where: {
        basketId: basket.id,
        assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
      },
      data: {
        basketId: null,
        claimedById: null,
        claimedAt: null,
        packedById: null,
        completedAt: null,
      },
    });

    const orderIds = Array.from(new Set(basket.fulfillmentOrders.map((order) => order.id)));
    const detachedPackedOrderIds = Array.from(new Set(
      detachablePackedUnits
        .map((basketUnit) => basketUnit.fulfillmentOrderId)
        .filter((orderId): orderId is string => Boolean(orderId)),
    ));
    for (const orderId of orderIds) {
      await this.refreshDemandOrderAvailabilityState(tx, orderId, params.now);
    }

    await this.refreshBasketState(tx, basket.id, params.now);

    await this.wmsStaffActivityService.recordFromRequest({
      request: params.request,
      tenantId: activeTenantIds.length === 1 ? activeTenantIds[0] : null,
      actorId: params.actorId,
      sessionId: params.sessionId ?? null,
      actionType: 'FULFILLMENT_DEMAND_BASKET_RELEASE',
      resourceType: 'WMS_BASKET',
      resourceId: basket.id,
      metadata: {
        basketCode: basket.barcode,
        mode: 'BASKET_DEMAND',
        releasedOrders: orderIds.length,
        releasedUnits: pickedUnits.length,
        detachedPackedUnits: detachablePackedUnits.length,
        detachedPackedOrders: detachedPackedOrderIds.length,
        tenantIds: activeTenantIds,
      } as Prisma.InputJsonValue,
    });

    return {
      basketId: basket.id,
      basketCode: basket.barcode,
      status: 'released' as const,
      releasedOrders: orderIds.length,
      releasedUnits: pickedUnits.length,
      detachedPackedUnits: detachablePackedUnits.length,
      detachedPackedOrders: detachedPackedOrderIds.length,
    };
  }

  private async releaseDemandBasketOrdersForPackVoidTx(
    tx: Prisma.TransactionClient,
    params: {
      basketId: string;
      orderIds: string[];
      reason: string;
      actorId: string | null;
      now: Date;
      request?: Request;
      sessionId?: string | null;
    },
  ) {
    await this.lockBasketForUpdate(tx, params.basketId);

    const basket = await tx.wmsBasket.findUnique({
      where: { id: params.basketId },
      select: {
        id: true,
        barcode: true,
        tenantId: true,
        status: true,
        fulfillmentOrders: {
          where: {
            assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
            status: {
              in: [...ACTIVE_BASKET_ORDER_STATUSES],
            },
          },
          select: {
            id: true,
            tenantId: true,
            storeId: true,
            posOrderId: true,
            status: true,
            claimedById: true,
            packedById: true,
            warehouseId: true,
            posOrder: {
              select: {
                status: true,
                isVoid: true,
              },
            },
            lines: {
              select: {
                id: true,
                variationId: true,
                quantityRequired: true,
                status: true,
              },
            },
          },
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
          select: {
            id: true,
            tenantId: true,
            storeId: true,
            variationId: true,
            inventoryUnitId: true,
            sourceLocationId: true,
            status: true,
            fulfillmentOrderId: true,
            fulfillmentLineId: true,
            pickedAt: true,
            inventoryUnit: {
              select: {
                id: true,
                code: true,
                status: true,
              },
            },
          },
          orderBy: [
            { pickedAt: 'desc' },
            { createdAt: 'desc' },
          ],
        },
      },
    });

    if (!basket) {
      throw new BadRequestException('Demand basket was not found');
    }

    const staleOrphanBasketUnits = basket.basketUnits.filter((basketUnit) => (
      !basketUnit.fulfillmentOrderId
      && !basketUnit.fulfillmentLineId
      && basketUnit.inventoryUnit.status !== WmsInventoryUnitStatus.PICKED
      && basketUnit.inventoryUnit.status !== WmsInventoryUnitStatus.PACKED
    ));
    if (staleOrphanBasketUnits.length > 0) {
      await tx.wmsBasketUnit.updateMany({
        where: {
          id: {
            in: staleOrphanBasketUnits.map((basketUnit) => basketUnit.id),
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
    }

    const staleOrphanBasketUnitIdSet = new Set(
      staleOrphanBasketUnits.map((basketUnit) => basketUnit.id),
    );
    const activeBasketUnits = basket.basketUnits.filter(
      (basketUnit) => !staleOrphanBasketUnitIdSet.has(basketUnit.id),
    );

    const selectedOrderIdSet = new Set(params.orderIds);
    const selectedOrders = basket.fulfillmentOrders.filter((order) => selectedOrderIdSet.has(order.id));
    if (selectedOrders.length !== selectedOrderIdSet.size) {
      throw new BadRequestException('One or more selected pack orders are no longer inside this basket');
    }

    const invalidStatusOrder = selectedOrders.find((order) => (
      order.status !== WmsFulfillmentOrderStatus.PICKED
      && order.status !== WmsFulfillmentOrderStatus.PACKING
    ));
    if (invalidStatusOrder) {
      throw new BadRequestException(
        `Order ${invalidStatusOrder.posOrderId} must still be inside an active pack basket before it can be voided`,
      );
    }

    const blockedDispatchOrder = selectedOrders.find((order) => {
      const posStatus = order.posOrder?.status ?? null;
      const isCanceledInPos = posStatus === CANCELED_POS_ORDER_STATUS;
      return (
        (!isCanceledInPos && order.posOrder?.isVoid)
        || (
          posStatus !== CONFIRMED_POS_ORDER_STATUS
          && posStatus !== WAITING_FOR_PICKUP_POS_ORDER_STATUS
          && posStatus !== WAITING_FOR_PRINTING_POS_ORDER_STATUS
          && posStatus !== CANCELED_POS_ORDER_STATUS
        )
      );
    });
    if (blockedDispatchOrder) {
      throw new ConflictException(
        `Order ${blockedDispatchOrder.posOrderId} is already outside the pack basket flow and cannot be voided`,
      );
    }

    const selectedCanceledOrders = selectedOrders.filter(
      (order) => (order.posOrder?.status ?? null) === CANCELED_POS_ORDER_STATUS,
    );
    const selectedReopenOrders = selectedOrders.filter(
      (order) => (order.posOrder?.status ?? null) !== CANCELED_POS_ORDER_STATUS,
    );

    const selectedPackedUnits = activeBasketUnits.filter((basketUnit) => (
      basketUnit.status === WmsBasketUnitStatus.PACKED
      && basketUnit.fulfillmentOrderId
      && selectedOrderIdSet.has(basketUnit.fulfillmentOrderId)
    ));
    const blockedDispatchedUnit = selectedPackedUnits.find((basketUnit) => (
      basketUnit.inventoryUnit.status === WmsInventoryUnitStatus.DISPATCHED
      || basketUnit.inventoryUnit.status === WmsInventoryUnitStatus.RTS
    ));
    if (blockedDispatchedUnit) {
      throw new ConflictException(
        `Order ${selectedOrders.find((order) => order.id === blockedDispatchedUnit.fulfillmentOrderId)?.posOrderId ?? 'Selected order'} is already in dispatch and cannot be voided from PACK`,
      );
    }

    const retainedOrders = basket.fulfillmentOrders.filter((order) => !selectedOrderIdSet.has(order.id));
    const retainedOrderIdSet = new Set(retainedOrders.map((order) => order.id));
    const packedCountByRetainedLineId = new Map<string, number>();

    for (const basketUnit of activeBasketUnits) {
      if (
        basketUnit.status !== WmsBasketUnitStatus.PACKED
        || !basketUnit.fulfillmentLineId
        || !basketUnit.fulfillmentOrderId
        || !retainedOrderIdSet.has(basketUnit.fulfillmentOrderId)
      ) {
        continue;
      }

      packedCountByRetainedLineId.set(
        basketUnit.fulfillmentLineId,
        (packedCountByRetainedLineId.get(basketUnit.fulfillmentLineId) ?? 0) + 1,
      );
    }

    const retainedOpenDemandByVariation = new Map<string, number>();
    for (const order of retainedOrders) {
      for (const line of order.lines) {
        if (line.status === WmsFulfillmentLineStatus.CANCELED) {
          continue;
        }

        const required = Math.max(line.quantityRequired ?? 0, 0);
        if (required <= 0) {
          continue;
        }

        const packed = Math.min(packedCountByRetainedLineId.get(line.id) ?? 0, required);
        const remaining = Math.max(required - packed, 0);
        if (remaining <= 0) {
          continue;
        }

        retainedOpenDemandByVariation.set(
          line.variationId,
          (retainedOpenDemandByVariation.get(line.variationId) ?? 0) + remaining,
        );
      }
    }

    const openPickedUnitsByVariation = new Map<string, typeof basket.basketUnits>();
    for (const basketUnit of activeBasketUnits) {
      if (basketUnit.status !== WmsBasketUnitStatus.PICKED || basketUnit.fulfillmentOrderId) {
        continue;
      }

      const existing = openPickedUnitsByVariation.get(basketUnit.variationId) ?? [];
      existing.push(basketUnit);
      openPickedUnitsByVariation.set(basketUnit.variationId, existing);
    }

    const releasedPickedUnits: typeof basket.basketUnits = [];
    for (const [variationId, pickedUnits] of openPickedUnitsByVariation.entries()) {
      const retainedNeed = retainedOpenDemandByVariation.get(variationId) ?? 0;
      const surplus = Math.max(pickedUnits.length - retainedNeed, 0);
      if (surplus <= 0) {
        continue;
      }

      releasedPickedUnits.push(...pickedUnits.slice(0, surplus));
    }

    const unitsToRestore = [...selectedPackedUnits, ...releasedPickedUnits];
    const restoreStateByInventoryUnitId = await this.loadBasketUnitRestoreStates(
      tx,
      basket.id,
      unitsToRestore.map((basketUnit) => basketUnit.inventoryUnitId),
    );

    const movementRows: Prisma.WmsInventoryMovementCreateManyInput[] = [];
    for (const basketUnit of unitsToRestore) {
      const restoreState = restoreStateByInventoryUnitId.get(basketUnit.inventoryUnitId);
      if (!restoreState?.fromLocationId || !restoreState.fromStatus || !restoreState.warehouseId) {
        throw new ConflictException(`Unable to restore original bin state for unit ${basketUnit.inventoryUnit.code}`);
      }

      const sourceStatus = basketUnit.status === WmsBasketUnitStatus.PACKED
        ? WmsInventoryUnitStatus.PACKED
        : WmsInventoryUnitStatus.PICKED;

      const restoredNow = await this.restoreInventoryUnitToPriorStateTx(tx, {
        inventoryUnitId: basketUnit.inventoryUnitId,
        expectedSourceStatus: sourceStatus,
        restoreState,
        actorId: params.actorId,
        conflictMessage: `Unit ${basketUnit.inventoryUnit.code} changed before the pack void completed`,
      });

      const basketUnitUpdate = await tx.wmsBasketUnit.updateMany({
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

      if (basketUnitUpdate.count !== 1) {
        throw new ConflictException(`Basket state for unit ${basketUnit.inventoryUnit.code} changed before the pack void completed`);
      }

      if (restoredNow) {
        movementRows.push({
          tenantId: basketUnit.tenantId,
          inventoryUnitId: basketUnit.inventoryUnitId,
          warehouseId: restoreState.warehouseId,
          fromLocationId: null,
          toLocationId: restoreState.fromLocationId,
          fromStatus: sourceStatus,
          toStatus: restoreState.fromStatus,
          movementType: WmsInventoryMovementType.TRANSFER,
          referenceType: 'WMS_BASKET',
          referenceId: basket.id,
          referenceCode: basket.barcode,
          notes: `Released STOX pack basket ${basket.barcode} during PACK void`,
          actorId: params.actorId,
          createdAt: params.now,
        });
      }
    }

    if (movementRows.length > 0) {
      await tx.wmsInventoryMovement.createMany({
        data: movementRows,
      });
    }

    await tx.wmsBasketPickDemand.deleteMany({
      where: {
        basketId: basket.id,
        fulfillmentOrderId: {
          in: Array.from(selectedOrderIdSet),
        },
      },
    });

    if (retainedOrders.length > 0) {
      await this.syncDemandBasketCountsTx(tx, {
        basketId: basket.id,
        now: params.now,
        refreshBasketState: false,
      });
    }

    for (const order of selectedCanceledOrders) {
      await tx.wmsFulfillmentLine.updateMany({
        where: {
          fulfillmentOrderId: order.id,
        },
        data: {
          quantityAllocated: 0,
          quantityPicked: 0,
          status: WmsFulfillmentLineStatus.CANCELED,
          issueReason: params.reason,
        },
      });

      await tx.wmsFulfillmentOrder.update({
        where: { id: order.id },
        data: {
          status: WmsFulfillmentOrderStatus.CANCELED,
          issueReason: params.reason,
          allocatedQuantity: 0,
          pickedQuantity: 0,
          completedAt: params.now,
          basketId: null,
        },
      });
    }

    for (const order of selectedReopenOrders) {
      await this.refreshDemandOrderAvailabilityState(tx, order.id, params.now, {
        allowedPosStatuses: [
          CONFIRMED_POS_ORDER_STATUS,
          WAITING_FOR_PICKUP_POS_ORDER_STATUS,
          WAITING_FOR_PRINTING_POS_ORDER_STATUS,
        ],
      });
    }

    await this.refreshBasketState(tx, basket.id, params.now);

    await this.wmsStaffActivityService.recordFromRequest({
      request: params.request,
      tenantId: basket.tenantId ?? selectedOrders[0]?.tenantId ?? null,
      actorId: params.actorId,
      sessionId: params.sessionId ?? null,
      actionType: 'FULFILLMENT_DEMAND_BASKET_RELEASE',
      resourceType: 'WMS_BASKET',
      resourceId: basket.id,
      metadata: {
        basketCode: basket.barcode,
        mode: 'BASKET_DEMAND',
        source: 'PACK_VOID',
        voidedOrders: selectedOrders.map((order) => ({
          id: order.id,
          posOrderId: order.posOrderId,
        })),
        restoredPickedUnits: releasedPickedUnits.length,
        restoredPackedUnits: selectedPackedUnits.length,
        canceledPosOrderIds: selectedCanceledOrders.map((order) => order.posOrderId),
        reopenedPosOrderIds: selectedReopenOrders.map((order) => order.posOrderId),
      } as Prisma.InputJsonValue,
    });

    return {
      basketId: basket.id,
      basketCode: basket.barcode,
      voidedOrderIds: selectedOrders.map((order) => order.id),
      voidedPosOrderIds: selectedOrders.map((order) => order.posOrderId),
      restoredPickedUnits: releasedPickedUnits.length,
      restoredPackedUnits: selectedPackedUnits.length,
      canceledPosOrderIds: selectedCanceledOrders.map((order) => order.posOrderId),
      reopenedPosOrderIds: selectedReopenOrders.map((order) => order.posOrderId),
    };
  }

  private async releaseDemandOrderForDispatchVoidTx(
    tx: Prisma.TransactionClient,
    params: {
      fulfillmentOrderId: string;
      actorId: string | null;
      now: Date;
      reason: string;
      request?: Request;
      sessionId?: string | null;
    },
  ) {
    const order = await tx.wmsFulfillmentOrder.findUnique({
      where: { id: params.fulfillmentOrderId },
      select: {
        id: true,
        tenantId: true,
        storeId: true,
        shopId: true,
        posOrderId: true,
        posOrderDbId: true,
        assignmentMode: true,
        status: true,
        warehouseId: true,
        posOrder: {
          select: {
            status: true,
            isVoid: true,
          },
        },
        basketUnits: {
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
          },
          select: {
            id: true,
            basketId: true,
            tenantId: true,
            inventoryUnitId: true,
            status: true,
            sourceLocationId: true,
            inventoryUnit: {
              select: {
                id: true,
                code: true,
                status: true,
              },
            },
          },
          orderBy: [
            { packedAt: 'desc' },
            { id: 'desc' },
          ],
        },
      },
    });

    if (!order) {
      throw new BadRequestException('Packed dispatch order was not found');
    }

    if (order.assignmentMode !== WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
      throw new BadRequestException('Dispatch void currently supports basket-demand packed orders only');
    }

    if (order.status !== WmsFulfillmentOrderStatus.PACKED) {
      throw new BadRequestException(`Order ${order.posOrderId} is ${this.formatEnumLabel(order.status)} and cannot be voided from Dispatch`);
    }

    const posStatus = order.posOrder?.status ?? null;
    const isPackedCanceled = posStatus === 6;
    if (
      (!isPackedCanceled && order.posOrder?.isVoid)
      || posStatus === 2
      || posStatus === 3
      || posStatus === 4
      || posStatus === 5
    ) {
      throw new ConflictException(`Order ${order.posOrderId} has already moved beyond packed dispatch work and cannot be voided`);
    }

    if (order.basketUnits.length === 0) {
      throw new ConflictException(`Order ${order.posOrderId} has no restorable packed unit history`);
    }

    const blockedUnit = order.basketUnits.find((basketUnit) => (
      basketUnit.inventoryUnit.status !== WmsInventoryUnitStatus.PACKED
    ));
    if (blockedUnit) {
      throw new ConflictException(
        `Unit ${blockedUnit.inventoryUnit.code} is already ${this.formatEnumLabel(blockedUnit.inventoryUnit.status)} and cannot be voided from Dispatch`,
      );
    }

    const basketIdSet = new Set<string>();
    const inventoryUnitIdsByBasketId = new Map<string, string[]>();
    for (const basketUnit of order.basketUnits) {
      if (!basketUnit.basketId) {
        throw new ConflictException(`Unit ${basketUnit.inventoryUnit.code} is missing its source basket history`);
      }

      basketIdSet.add(basketUnit.basketId);
      const existing = inventoryUnitIdsByBasketId.get(basketUnit.basketId) ?? [];
      existing.push(basketUnit.inventoryUnitId);
      inventoryUnitIdsByBasketId.set(basketUnit.basketId, existing);
    }

    for (const basketId of basketIdSet) {
      await this.lockBasketForUpdate(tx, basketId);
    }

    const restoreStateByInventoryUnitId = new Map<string, {
      fromLocationId: string | null;
      fromStatus: WmsInventoryUnitStatus | null;
      warehouseId: string | null;
    }>();
    for (const [basketId, inventoryUnitIds] of inventoryUnitIdsByBasketId.entries()) {
      const basketRestoreState = await this.loadBasketUnitRestoreStates(tx, basketId, inventoryUnitIds);
      for (const [inventoryUnitId, restoreState] of basketRestoreState.entries()) {
        if (!restoreStateByInventoryUnitId.has(inventoryUnitId)) {
          restoreStateByInventoryUnitId.set(inventoryUnitId, restoreState);
        }
      }
    }

    const movementRows: Prisma.WmsInventoryMovementCreateManyInput[] = [];
    for (const basketUnit of order.basketUnits) {
      const restoreState = restoreStateByInventoryUnitId.get(basketUnit.inventoryUnitId);
      if (!restoreState?.fromLocationId || !restoreState.fromStatus || !restoreState.warehouseId) {
        throw new ConflictException(`Unable to restore original bin state for unit ${basketUnit.inventoryUnit.code}`);
      }

      const restoredNow = await this.restoreInventoryUnitToPriorStateTx(tx, {
        inventoryUnitId: basketUnit.inventoryUnitId,
        expectedSourceStatus: WmsInventoryUnitStatus.PACKED,
        restoreState,
        actorId: params.actorId,
        conflictMessage: `Unit ${basketUnit.inventoryUnit.code} changed before the dispatch void completed`,
      });

      if (basketUnit.status === WmsBasketUnitStatus.PACKED) {
        const basketUnitUpdate = await tx.wmsBasketUnit.updateMany({
          where: {
            id: basketUnit.id,
            status: WmsBasketUnitStatus.PACKED,
          },
          data: {
            status: WmsBasketUnitStatus.REMOVED,
            removedById: params.actorId ?? undefined,
            removedAt: params.now,
          },
        });

        if (basketUnitUpdate.count !== 1) {
          throw new ConflictException(`Basket state for unit ${basketUnit.inventoryUnit.code} changed before the dispatch void completed`);
        }
      }

      if (restoredNow) {
        movementRows.push({
          tenantId: basketUnit.tenantId,
          inventoryUnitId: basketUnit.inventoryUnitId,
          warehouseId: restoreState.warehouseId,
          fromLocationId: null,
          toLocationId: restoreState.fromLocationId,
          fromStatus: WmsInventoryUnitStatus.PACKED,
          toStatus: restoreState.fromStatus,
          movementType: WmsInventoryMovementType.TRANSFER,
          referenceType: 'WMS_FULFILLMENT_ORDER',
          referenceId: order.id,
          referenceCode: order.posOrderId,
          notes: `Dispatch void returned packed order ${order.posOrderId} to inventory: ${params.reason}`,
          actorId: params.actorId,
          createdAt: params.now,
        });
      }
    }

    if (movementRows.length > 0) {
      await tx.wmsInventoryMovement.createMany({
        data: movementRows,
      });
    }

    await tx.wmsBasketPickDemand.deleteMany({
      where: {
        fulfillmentOrderId: order.id,
      },
    });

    for (const basketId of basketIdSet) {
      await this.syncDemandBasketCountsTx(tx, {
        basketId,
        now: params.now,
        refreshBasketState: false,
      });
    }

    if (isPackedCanceled) {
      await tx.wmsFulfillmentLine.updateMany({
        where: {
          fulfillmentOrderId: order.id,
        },
        data: {
          quantityAllocated: 0,
          quantityPicked: 0,
          status: WmsFulfillmentLineStatus.CANCELED,
          issueReason: params.reason,
        },
      });

      await tx.wmsFulfillmentOrder.update({
        where: { id: order.id },
        data: {
          status: WmsFulfillmentOrderStatus.CANCELED,
          issueReason: params.reason,
          allocatedQuantity: 0,
          pickedQuantity: 0,
          completedAt: params.now,
          basketId: null,
        },
      });
    } else {
      await this.refreshDemandOrderAvailabilityState(tx, order.id, params.now, {
        allowedPosStatuses: [CONFIRMED_POS_ORDER_STATUS, WAITING_FOR_PRINTING_POS_ORDER_STATUS],
        allowPackedCurrentStatus: true,
        allowAnyPreDispatchPosStatus: true,
      });
    }

    for (const basketId of basketIdSet) {
      await this.refreshBasketState(tx, basketId, params.now);
    }

    await this.wmsStaffActivityService.recordFromRequest({
      request: params.request,
      tenantId: order.tenantId,
      actorId: params.actorId,
      sessionId: params.sessionId ?? null,
      actionType: 'DISPATCH_VOID_COMPLETE',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: order.id,
      storeId: order.storeId,
      warehouseId: order.warehouseId ?? null,
      metadata: {
        mode: 'BASKET_DEMAND',
        source: 'DISPATCH',
        resolution: isPackedCanceled ? 'CANCELED' : 'RETURNED_TO_PICKING',
        reason: params.reason,
        posOrderId: order.posOrderId,
        restoredPackedUnits: order.basketUnits.length,
        affectedBasketIds: Array.from(basketIdSet),
      } as Prisma.InputJsonValue,
    });

    return {
      fulfillmentOrderId: order.id,
      tenantId: order.tenantId,
      storeId: order.storeId,
      shopId: order.shopId,
      posOrderId: order.posOrderId,
      posOrderDbId: order.posOrderDbId,
      warehouseId: order.warehouseId ?? null,
      resolution: isPackedCanceled ? 'CANCELED' as const : 'RETURNED_TO_PICKING' as const,
      restoredPackedUnits: order.basketUnits.length,
      affectedBasketIds: Array.from(basketIdSet),
    };
  }

  private async repairDemandOrderAfterStuckDispatchVoidTx(
    tx: Prisma.TransactionClient,
    params: {
      fulfillmentOrderId: string;
      actorId: string | null;
      now: Date;
      request?: Request;
      sessionId?: string | null;
    },
  ) {
    const order = await tx.wmsFulfillmentOrder.findUnique({
      where: { id: params.fulfillmentOrderId },
      select: {
        id: true,
        tenantId: true,
        storeId: true,
        shopId: true,
        posOrderId: true,
        assignmentMode: true,
        status: true,
        basketId: true,
        warehouseId: true,
        posOrder: {
          select: {
            status: true,
            isVoid: true,
          },
        },
        basketUnits: {
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
          },
          select: {
            id: true,
            basketId: true,
            status: true,
            inventoryUnit: {
              select: {
                id: true,
                code: true,
                status: true,
              },
            },
          },
          orderBy: [
            { packedAt: 'desc' },
            { id: 'desc' },
          ],
        },
      },
    });

    if (!order) {
      return {
        outcome: 'skipped' as const,
        fulfillmentOrderId: params.fulfillmentOrderId,
        posOrderId: null,
        previousStatus: null,
        nextStatus: null,
        reason: 'Order was not found.',
        affectedBasketIds: [] as string[],
      };
    }

    if (order.assignmentMode !== WmsFulfillmentAssignmentMode.BASKET_DEMAND) {
      return {
        outcome: 'skipped' as const,
        fulfillmentOrderId: order.id,
        posOrderId: order.posOrderId,
        previousStatus: order.status,
        nextStatus: order.status,
        reason: 'Only basket-demand orders can be repaired with this flow.',
        affectedBasketIds: [] as string[],
      };
    }

    if (order.status !== WmsFulfillmentOrderStatus.PACKED) {
      return {
        outcome: 'skipped' as const,
        fulfillmentOrderId: order.id,
        posOrderId: order.posOrderId,
        previousStatus: order.status,
        nextStatus: order.status,
        reason: `Order is ${this.formatEnumLabel(order.status)} and is not stuck in packed dispatch state.`,
        affectedBasketIds: [] as string[],
      };
    }

    const posStatus = order.posOrder?.status ?? null;
    if (order.posOrder?.isVoid || [2, 3, 4, 5].includes(posStatus ?? Number.NaN)) {
      return {
        outcome: 'skipped' as const,
        fulfillmentOrderId: order.id,
        posOrderId: order.posOrderId,
        previousStatus: order.status,
        nextStatus: order.status,
        reason: 'Order already moved beyond packed dispatch work.',
        affectedBasketIds: [] as string[],
      };
    }

    const historicalPackedUnits = order.basketUnits.filter((basketUnit) => Boolean(basketUnit.inventoryUnit));
    if (historicalPackedUnits.length === 0) {
      return {
        outcome: 'skipped' as const,
        fulfillmentOrderId: order.id,
        posOrderId: order.posOrderId,
        previousStatus: order.status,
        nextStatus: order.status,
        reason: 'No historical packed units were found for this order.',
        affectedBasketIds: [] as string[],
      };
    }

    const stillPackedUnit = historicalPackedUnits.find((basketUnit) => (
      basketUnit.status === WmsBasketUnitStatus.PACKED
      || basketUnit.inventoryUnit?.status === WmsInventoryUnitStatus.PACKED
    ));
    if (stillPackedUnit) {
      return {
        outcome: 'skipped' as const,
        fulfillmentOrderId: order.id,
        posOrderId: order.posOrderId,
        previousStatus: order.status,
        nextStatus: order.status,
        reason: 'Packed units are still active, so this order is not a stale dispatch-void candidate.',
        affectedBasketIds: [] as string[],
      };
    }

    const basketIdSet = new Set<string>();
    if (order.basketId) {
      basketIdSet.add(order.basketId);
    }
    for (const basketUnit of historicalPackedUnits) {
      if (basketUnit.basketId) {
        basketIdSet.add(basketUnit.basketId);
      }
    }

    for (const basketId of basketIdSet) {
      await this.lockBasketForUpdate(tx, basketId);
    }

    await tx.wmsBasketPickDemand.deleteMany({
      where: {
        fulfillmentOrderId: order.id,
      },
    });

    await tx.wmsFulfillmentOrder.updateMany({
      where: {
        id: order.id,
        status: WmsFulfillmentOrderStatus.PACKED,
      },
      data: {
        basketId: null,
        claimedById: null,
        claimedAt: null,
        packedById: null,
        completedAt: null,
      },
    });

    for (const basketId of basketIdSet) {
      await this.syncDemandBasketCountsTx(tx, {
        basketId,
        now: params.now,
        refreshBasketState: false,
      });
    }

    await this.refreshDemandOrderAvailabilityState(tx, order.id, params.now, {
      allowedPosStatuses: [CONFIRMED_POS_ORDER_STATUS, WAITING_FOR_PRINTING_POS_ORDER_STATUS],
      allowPackedCurrentStatus: true,
      allowAnyPreDispatchPosStatus: true,
    });

    for (const basketId of basketIdSet) {
      await this.refreshBasketState(tx, basketId, params.now);
    }

    const refreshedOrder = await tx.wmsFulfillmentOrder.findUnique({
      where: { id: order.id },
      select: {
        status: true,
      },
    });

    await this.wmsStaffActivityService.recordFromRequest({
      request: params.request,
      tenantId: order.tenantId,
      actorId: params.actorId,
      sessionId: params.sessionId ?? null,
      actionType: 'DISPATCH_VOID_REPAIR_COMPLETE',
      resourceType: 'WMS_FULFILLMENT_ORDER',
      resourceId: order.id,
      storeId: order.storeId,
      warehouseId: order.warehouseId ?? null,
      metadata: {
        mode: 'BASKET_DEMAND',
        source: 'DISPATCH_REPAIR',
        posOrderId: order.posOrderId,
        previousStatus: order.status,
        nextStatus: refreshedOrder?.status ?? order.status,
        affectedBasketIds: Array.from(basketIdSet),
      } as Prisma.InputJsonValue,
    });

    return {
      outcome: 'repaired' as const,
      fulfillmentOrderId: order.id,
      posOrderId: order.posOrderId,
      previousStatus: order.status,
      nextStatus: refreshedOrder?.status ?? order.status,
      reason: null,
      affectedBasketIds: Array.from(basketIdSet),
    };
  }

  private canDetachPackedBasketUnit(
    fulfillmentOrder:
      | {
          id: string;
          status: WmsFulfillmentOrderStatus;
          posOrder: {
            status: number | null;
            isVoid: boolean;
          } | null;
        }
      | null
      | undefined,
  ) {
    if (!fulfillmentOrder) {
      return true;
    }

    if (
      fulfillmentOrder.status === WmsFulfillmentOrderStatus.PACKED
      || fulfillmentOrder.status === WmsFulfillmentOrderStatus.CANCELED
    ) {
      return true;
    }

    if (!fulfillmentOrder.posOrder) {
      return false;
    }

    return (
      fulfillmentOrder.posOrder.status !== CONFIRMED_POS_ORDER_STATUS
      || fulfillmentOrder.posOrder.isVoid
    );
  }

  private async computeDemandActualCountState(params: {
    basketIds: string[];
    tenantId?: string | null;
    tx?: Prisma.TransactionClient;
  }): Promise<DemandActualCountState> {
    if (params.basketIds.length === 0) {
      return {
        actualPickedByDemandId: new Map<string, number>(),
        actualPackedByDemandId: new Map<string, number>(),
        actualPickedByBinId: new Map<string, number>(),
        mismatches: [],
      };
    }

    const [demands, basketUnits] = await Promise.all([
      this.loadDemandHealthDemands({
        basketIds: params.basketIds,
        tenantId: params.tenantId ?? null,
        tx: params.tx,
      }),
      this.loadDemandHealthBasketUnits({
        basketIds: params.basketIds,
        tenantId: params.tenantId ?? null,
        tx: params.tx,
      }),
    ]);

    const pickedCountByDemandId = new Map<string, number>();
    const packedCountByDemandId = new Map<string, number>();
    const pickedCountByBinId = new Map<string, number>();
    const packedCountByDemandBinKey = new Map<string, number>();
    const pickedPoolByVariationKey = new Map<string, number>();
    const pickedPoolByLocationKey = new Map<string, number>();

    for (const basketUnit of basketUnits) {
      if (
        basketUnit.status !== WmsBasketUnitStatus.PICKED
        && basketUnit.status !== WmsBasketUnitStatus.PACKED
      ) {
        continue;
      }

      const variationKey = this.buildDemandVariationKey({
        basketId: basketUnit.basketId,
        tenantId: basketUnit.tenantId,
        storeId: basketUnit.storeId,
        variationId: basketUnit.variationId,
      });
      pickedPoolByVariationKey.set(
        variationKey,
        (pickedPoolByVariationKey.get(variationKey) ?? 0) + 1,
      );

      if (basketUnit.sourceLocationId) {
        const locationKey = this.buildDemandLocationKey({
          basketId: basketUnit.basketId,
          tenantId: basketUnit.tenantId,
          storeId: basketUnit.storeId,
          variationId: basketUnit.variationId,
          locationId: basketUnit.sourceLocationId,
        });
        pickedPoolByLocationKey.set(
          locationKey,
          (pickedPoolByLocationKey.get(locationKey) ?? 0) + 1,
        );
      }

      if (
        basketUnit.status === WmsBasketUnitStatus.PACKED
        && basketUnit.fulfillmentLineId
      ) {
        const demand = demands.find(
          (candidate) => candidate.fulfillmentLineId === basketUnit.fulfillmentLineId && candidate.basketId === basketUnit.basketId,
        );
        if (!demand) {
          continue;
        }

        packedCountByDemandId.set(
          demand.id,
          (packedCountByDemandId.get(demand.id) ?? 0) + 1,
        );

        if (basketUnit.sourceLocationId) {
          const demandBinKey = `${demand.id}:${basketUnit.sourceLocationId}`;
          packedCountByDemandBinKey.set(
            demandBinKey,
            (packedCountByDemandBinKey.get(demandBinKey) ?? 0) + 1,
          );
        }
      }
    }

    const demandsByVariationKey = new Map<string, DemandHealthDemandRecord[]>();
    for (const demand of demands) {
      const variationKey = this.buildDemandVariationKey({
        basketId: demand.basketId,
        tenantId: demand.tenantId,
        storeId: demand.storeId,
        variationId: demand.variationId,
      });
      const existing = demandsByVariationKey.get(variationKey) ?? [];
      existing.push(demand);
      demandsByVariationKey.set(variationKey, existing);
    }

    for (const group of demandsByVariationKey.values()) {
      const sortedGroup = [...group].sort((left, right) => (
        left.createdAt.getTime() - right.createdAt.getTime()
        || left.id.localeCompare(right.id)
      ));
      const variationKey = this.buildDemandVariationKey({
        basketId: sortedGroup[0].basketId,
        tenantId: sortedGroup[0].tenantId,
        storeId: sortedGroup[0].storeId,
        variationId: sortedGroup[0].variationId,
      });
      let remainingPicked = pickedPoolByVariationKey.get(variationKey) ?? 0;
      let reservedPacked = 0;

      for (const demand of sortedGroup) {
        const packed = packedCountByDemandId.get(demand.id) ?? 0;
        reservedPacked += packed;
      }

      remainingPicked = Math.max(remainingPicked - reservedPacked, 0);

      for (const demand of sortedGroup) {
        const packed = packedCountByDemandId.get(demand.id) ?? 0;
        const additionalCapacity = Math.max(demand.quantityRequired - packed, 0);
        const additionalPicked = Math.min(additionalCapacity, remainingPicked);
        const actualPicked = packed + additionalPicked;
        pickedCountByDemandId.set(demand.id, actualPicked);
        remainingPicked -= additionalPicked;
      }
    }

    const binContextsByLocationKey = new Map<string, Array<{
      demand: DemandHealthDemandRecord;
      bin: DemandHealthDemandRecord['bins'][number];
    }>>();
    const remainingDemandCapacity = new Map<string, number>();

    for (const demand of demands) {
      let packedAcrossBins = 0;

      for (const bin of demand.bins) {
        const packedBaseline = packedCountByDemandBinKey.get(`${demand.id}:${bin.locationId}`) ?? 0;
        pickedCountByBinId.set(bin.id, packedBaseline);
        packedAcrossBins += packedBaseline;

        const locationKey = this.buildDemandLocationKey({
          basketId: demand.basketId,
          tenantId: demand.tenantId,
          storeId: demand.storeId,
          variationId: demand.variationId,
          locationId: bin.locationId,
        });
        const existing = binContextsByLocationKey.get(locationKey) ?? [];
        existing.push({ demand, bin });
        binContextsByLocationKey.set(locationKey, existing);
      }

      const demandPicked = pickedCountByDemandId.get(demand.id) ?? 0;
      remainingDemandCapacity.set(demand.id, Math.max(demandPicked - packedAcrossBins, 0));
    }

    for (const [locationKey, contexts] of binContextsByLocationKey.entries()) {
      const sortedContexts = [...contexts].sort((left, right) => (
        left.bin.routeSequence - right.bin.routeSequence
        || left.demand.createdAt.getTime() - right.demand.createdAt.getTime()
        || left.bin.id.localeCompare(right.bin.id)
      ));
      let remainingLocationPool = pickedPoolByLocationKey.get(locationKey) ?? 0;
      let reservedPacked = 0;

      for (const context of sortedContexts) {
        reservedPacked += pickedCountByBinId.get(context.bin.id) ?? 0;
      }

      remainingLocationPool = Math.max(remainingLocationPool - reservedPacked, 0);

      for (const context of sortedContexts) {
        const baseline = pickedCountByBinId.get(context.bin.id) ?? 0;
        const remainingDemand = remainingDemandCapacity.get(context.demand.id) ?? 0;
        const additionalCapacity = Math.max(context.bin.quantityTarget - baseline, 0);
        const additionalPicked = Math.min(additionalCapacity, remainingDemand, remainingLocationPool);
        const actualBinPicked = baseline + additionalPicked;
        pickedCountByBinId.set(context.bin.id, actualBinPicked);
        remainingDemandCapacity.set(context.demand.id, Math.max(remainingDemand - additionalPicked, 0));
        remainingLocationPool -= additionalPicked;
      }
    }

    const mismatches: DemandMismatchRecord[] = [];
    for (const demand of demands) {
      const actualPicked = pickedCountByDemandId.get(demand.id) ?? 0;
      const actualPacked = packedCountByDemandId.get(demand.id) ?? 0;
      const binMismatches = demand.bins
        .map((bin) => ({
          binId: bin.id,
          binCode: bin.location.code,
          quantityTarget: bin.quantityTarget,
          storedPicked: bin.quantityPicked,
          actualPicked: pickedCountByBinId.get(bin.id) ?? 0,
        }))
        .filter((bin) => bin.storedPicked !== bin.actualPicked);

      if (
        demand.quantityPicked !== actualPicked
        || demand.quantityPacked !== actualPacked
        || binMismatches.length > 0
      ) {
        mismatches.push({
          basketId: demand.basketId,
          basketCode: demand.basket.barcode,
          basketStatus: demand.basket.status,
          basketUpdatedAt: demand.basket.updatedAt,
          demandId: demand.id,
          fulfillmentOrderId: demand.fulfillmentOrderId,
          fulfillmentLineId: demand.fulfillmentLineId,
          posOrderId: demand.fulfillmentOrder.posOrderId,
          tenantId: demand.tenantId,
          storeId: demand.storeId,
          variationId: demand.variationId,
          productName: demand.productName,
          productDisplayId: demand.productDisplayId,
          quantityRequired: demand.quantityRequired,
          storedPicked: demand.quantityPicked,
          actualPicked,
          storedPacked: demand.quantityPacked,
          actualPacked,
          binMismatches,
        });
      }
    }

    return {
      actualPickedByDemandId: pickedCountByDemandId,
      actualPackedByDemandId: packedCountByDemandId,
      actualPickedByBinId: pickedCountByBinId,
      mismatches,
    };
  }

  private async loadDemandHealthDemands(params: {
    basketIds: string[];
    tenantId?: string | null;
    tx?: Prisma.TransactionClient;
  }) {
    const client = params.tx ?? this.prisma;
    return client.wmsBasketPickDemand.findMany({
      where: {
        basketId: {
          in: params.basketIds,
        },
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      },
      include: {
        basket: {
          select: {
            id: true,
            barcode: true,
            status: true,
            updatedAt: true,
          },
        },
        fulfillmentOrder: {
          select: {
            id: true,
            posOrderId: true,
            status: true,
          },
        },
        bins: {
          include: {
            location: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: [
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
  }

  private async loadDemandHealthBasketUnits(params: {
    basketIds: string[];
    tenantId?: string | null;
    tx?: Prisma.TransactionClient;
  }) {
    const client = params.tx ?? this.prisma;
    return client.wmsBasketUnit.findMany({
      where: {
        basketId: {
          in: params.basketIds,
        },
        status: {
          in: [...ACTIVE_BASKET_UNIT_STATUSES],
        },
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
      },
      select: {
        id: true,
        basketId: true,
        tenantId: true,
        storeId: true,
        variationId: true,
        sourceLocationId: true,
        status: true,
        fulfillmentLineId: true,
      },
    });
  }

  private async loadBasketUnitRestoreStates(
    tx: Prisma.TransactionClient,
    basketId: string,
    inventoryUnitIds: string[],
  ) {
    if (inventoryUnitIds.length === 0) {
      return new Map<string, BasketUnitRestoreState>();
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

    const restoreStateByInventoryUnitId = new Map<string, BasketUnitRestoreState>();
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
      restoreState: BasketUnitRestoreState;
      actorId: string | null;
      conflictMessage: string;
    },
  ) {
    const targetStatus = params.restoreState.fromStatus;
    if (!targetStatus) {
      throw new ConflictException(params.conflictMessage);
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

    if (
      currentUnit
      && currentUnit.status === targetStatus
      && currentUnit.currentLocationId === params.restoreState.fromLocationId
    ) {
      return false;
    }

    throw new ConflictException(params.conflictMessage);
  }

  private async refreshDemandOrderAvailabilityState(
    tx: Prisma.TransactionClient,
    fulfillmentOrderId: string,
    now: Date,
    options?: {
      allowedPosStatuses?: number[];
      allowPackedCurrentStatus?: boolean;
      allowAnyPreDispatchPosStatus?: boolean;
    },
  ) {
    const order = await tx.wmsFulfillmentOrder.findUnique({
      where: { id: fulfillmentOrderId },
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
    const allowedPosStatuses = options?.allowedPosStatuses?.length
      ? options.allowedPosStatuses
      : [CONFIRMED_POS_ORDER_STATUS];
    const posStatus = order?.posOrder?.status ?? null;
    const posStatusAllowed = options?.allowAnyPreDispatchPosStatus
      ? posStatus === null || ![2, 3, 4, 5, 6].includes(posStatus)
      : allowedPosStatuses.includes(posStatus ?? Number.NaN);

    if (
      !order
      || order.assignmentMode !== WmsFulfillmentAssignmentMode.BASKET_DEMAND
      || (!options?.allowPackedCurrentStatus && order.status === WmsFulfillmentOrderStatus.PACKED)
      || order.status === WmsFulfillmentOrderStatus.CANCELED
      || !posStatusAllowed
      || order.posOrder.isVoid
    ) {
      return;
    }

    const warehouseLocked = this.isDemandWarehouseLocked(order) && Boolean(order.warehouseId);
    const lockedWarehouseId = warehouseLocked ? order.warehouseId : null;
    let totalQuantity = 0;
    let allocatedQuantity = 0;
    let pickedQuantity = 0;
    let hasIssue = false;
    const candidateWarehouseIds = new Set<string>();
    const eligibleLines: Array<{
      id: string;
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
        hasIssue = true;
        await tx.wmsFulfillmentLine.update({
          where: { id: line.id },
          data: {
            quantityAllocated: 0,
            quantityPicked: 0,
            status: WmsFulfillmentLineStatus.ISSUE,
            issueReason: 'Order line has no required quantity.',
          },
        });
        continue;
      }

      const availabilityByWarehouse = await this.listDemandAvailableQuantityByWarehouse(tx, {
        tenantId: order.tenantId,
        storeId: order.storeId,
        warehouseId: lockedWarehouseId,
        posWarehouseRef: order.posWarehouseRef,
        variationId: line.variationId,
        excludeFulfillmentOrderId: order.id,
      });
      for (const warehouseId of availabilityByWarehouse.keys()) {
        candidateWarehouseIds.add(warehouseId);
      }

      eligibleLines.push({
        id: line.id,
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

    for (const line of order.lines) {
      if (line.status === WmsFulfillmentLineStatus.CANCELED) {
        continue;
      }

      const required = Math.max(line.quantityRequired, 0);
      if (required <= 0) {
        continue;
      }

      const eligibleLine = eligibleLines.find((entry) => entry.id === line.id);
      const nextAllocated = Math.min(allocatedByLineId.get(line.id) ?? 0, required);
      const nextLineStatus = this.resolveFulfillmentLineStatus(required, nextAllocated, 0, WmsFulfillmentLineStatus.RESTOCKING);
      const availableInSelectedWarehouse = selectedWarehouseId && eligibleLine
        ? eligibleLine.availabilityByWarehouse.get(selectedWarehouseId) ?? 0
        : 0;

      totalQuantity += required;
      allocatedQuantity += nextAllocated;
      hasIssue = hasIssue || nextLineStatus === WmsFulfillmentLineStatus.ISSUE;

      await tx.wmsFulfillmentLine.update({
        where: { id: line.id },
        data: {
          quantityAllocated: nextAllocated,
          quantityPicked: 0,
          status: nextLineStatus,
          issueReason: nextLineStatus === WmsFulfillmentLineStatus.READY
            ? null
            : this.buildDemandAvailabilityIssueReason({
                required,
                availableInSelectedWarehouse,
                totalAvailableAcrossWarehouses: eligibleLine?.totalAvailableAcrossWarehouses ?? 0,
                warehouseLocked,
              }),
        },
      });
    }

    const nextOrderStatus = this.resolveFulfillmentOrderStatus({
      currentStatus: WmsFulfillmentOrderStatus.RESTOCKING,
      claimedById: null,
      totalQuantity,
      allocatedQuantity,
      pickedQuantity,
      hasIssue,
    });

    await tx.wmsFulfillmentOrder.update({
      where: { id: order.id },
      data: {
        warehouseId: null,
        totalQuantity,
        allocatedQuantity,
        pickedQuantity,
        status: nextOrderStatus,
        issueReason: totalQuantity === 0 ? order.issueReason ?? 'Order has no pickable variation items' : null,
        claimedById: null,
        claimedAt: null,
        basketId: null,
        packedById: null,
        completedAt: nextOrderStatus === WmsFulfillmentOrderStatus.READY_FOR_PACK ? order.completedAt ?? now : null,
      },
    });
  }

  private async syncDemandBasketCountsTx(
    tx: Prisma.TransactionClient,
    params: {
      basketId: string;
      now: Date;
      refreshBasketState: boolean;
    },
  ) {
    const state = await this.computeDemandActualCountState({
      basketIds: [params.basketId],
      tx,
    });
    const demands = await this.loadDemandHealthDemands({
      basketIds: [params.basketId],
      tx,
    });

    let updatedDemands = 0;
    let updatedBins = 0;

    for (const demand of demands) {
      const nextPicked = state.actualPickedByDemandId.get(demand.id) ?? 0;
      const nextPacked = state.actualPackedByDemandId.get(demand.id) ?? 0;
      if (demand.quantityPicked !== nextPicked || demand.quantityPacked !== nextPacked) {
        await tx.wmsBasketPickDemand.update({
          where: { id: demand.id },
          data: {
            quantityPicked: nextPicked,
            quantityPacked: nextPacked,
          },
        });
        updatedDemands += 1;
      }

      for (const bin of demand.bins) {
        const nextBinPicked = state.actualPickedByBinId.get(bin.id) ?? 0;
        if (bin.quantityPicked !== nextBinPicked) {
          await tx.wmsBasketPickDemandBin.update({
            where: { id: bin.id },
            data: {
              quantityPicked: nextBinPicked,
            },
          });
          updatedBins += 1;
        }
      }
    }

    const orderIds = Array.from(new Set(demands.map((demand) => demand.fulfillmentOrderId)));
    for (const orderId of orderIds) {
      await this.refreshFulfillmentOrderProgressState(tx, orderId, params.now);
    }

    if (params.refreshBasketState) {
      await this.refreshBasketState(tx, params.basketId, params.now);
    }

    return {
      demands,
      updatedDemands,
      updatedBins,
    };
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
          basketStatuses: ACTIVE_DEMAND_HOLD_BASKET_STATUSES,
          orderStatuses: [
            WmsFulfillmentOrderStatus.IN_PICKING,
            WmsFulfillmentOrderStatus.READY_FOR_PACK,
            WmsFulfillmentOrderStatus.PICKED,
          ],
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

  private async refreshFulfillmentOrderProgressState(
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
      const allocated = order.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
        ? (line.basketPickDemands.length > 0
            ? line.basketPickDemands.reduce(
                (sum, demand) => sum + Math.max(demand.quantityRequired ?? 0, 0),
                0,
              )
            : Math.min(line.quantityAllocated ?? 0, required))
        : line.reservations.length;
      const picked = order.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
        ? line.basketPickDemands.reduce(
            (sum, demand) => sum + Math.max(demand.quantityPicked ?? 0, 0),
            0,
          )
        : line.reservations.filter((reservation) => reservation.status === WmsPickReservationStatus.PICKED).length;
      const nextLineStatus = this.resolveFulfillmentLineStatus(required, allocated, picked, line.status);

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
          issueReason: nextLineStatus === WmsFulfillmentLineStatus.READY || nextLineStatus === WmsFulfillmentLineStatus.PICKED
            ? null
            : line.issueReason,
        },
      });
    }

    const nextOrderStatus = this.resolveFulfillmentOrderStatus({
      currentStatus: order.status,
      claimedById: order.claimedById,
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
        issueReason: totalQuantity === 0 ? order.issueReason ?? 'Order has no pickable variation items' : null,
      },
    });
  }

  private async refreshBasketState(
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
        status: nextStatus,
        tenantId: activeTenantIds.length === 1 ? activeTenantIds[0] : null,
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
      applyPosWarehouseFilterWhenUnpooled: false,
    });
    const baseWhere: Prisma.WmsInventoryUnitWhereInput = {
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
    return baseWhere;
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
        basketStatuses: ACTIVE_DEMAND_HOLD_BASKET_STATUSES,
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

  private async loadAdjustableOrder(
    client: Prisma.TransactionClient | PrismaService,
    orderId: string,
    tenantId: string,
  ) {
    const order = await client.wmsFulfillmentOrder.findFirst({
      where: { id: orderId, tenantId },
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
              include: {
                inventoryUnit: {
                  select: {
                    id: true,
                    warehouseId: true,
                    currentLocationId: true,
                    status: true,
                  },
                },
              },
            },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        fulfillmentAdjustments: {
          where: { status: WmsFulfillmentAdjustmentStatus.ACTIVE },
          select: {
            sourceLineId: true,
            quantity: true,
          },
        },
      },
    });

    if (!order) {
      throw new BadRequestException('Fulfillment order was not found in the selected tenant.');
    }

    if (!(ITEM_ADJUSTMENT_ORDER_STATUSES as readonly WmsFulfillmentOrderStatus[]).includes(order.status)) {
      throw new BadRequestException(
        `Order ${order.posOrderId} is ${this.formatEnumLabel(order.status)} and can no longer be adjusted before picking.`,
      );
    }

    if (order.claimedById || order.basketId) {
      throw new ConflictException(
        `Order ${order.posOrderId} is already assigned for picking and cannot be adjusted here.`,
      );
    }

    if (order.posOrder.status !== CONFIRMED_POS_ORDER_STATUS || order.posOrder.isVoid) {
      throw new ConflictException(`Order ${order.posOrderId} is no longer confirmed in POS.`);
    }

    return order;
  }

  private async listItemAdjustmentStockOptions(
    client: Prisma.TransactionClient | PrismaService,
    params: {
      order: Awaited<ReturnType<WmsFulfillmentOpsService['loadAdjustableOrder']>>;
      search?: string | null;
      variationId?: string | null;
      limit: number;
    },
  ) {
    const search = params.search?.trim() || null;
    const inventoryWhere: Prisma.WmsInventoryUnitWhereInput = {
      tenantId: params.order.tenantId,
      storeId: params.order.storeId,
      ...(params.order.warehouseId ? { warehouseId: params.order.warehouseId } : {}),
      ...(params.variationId ? { variationId: params.variationId } : {}),
      ...(params.order.posWarehouseRef
        ? {
            OR: [
              { posWarehouseRef: params.order.posWarehouseRef },
              { posWarehouseRef: null },
            ],
          }
        : {}),
      status: WmsInventoryUnitStatus.PUTAWAY,
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
      ...(search
        ? {
            posProduct: {
              is: {
                OR: [
                  { name: { contains: search, mode: 'insensitive' } },
                  { customId: { contains: search, mode: 'insensitive' } },
                  { variationId: { contains: search, mode: 'insensitive' } },
                ],
              },
            },
          }
        : {}),
    };

    const freeGroups = await client.wmsInventoryUnit.groupBy({
      by: ['variationId'],
      where: inventoryWhere,
      _count: { _all: true },
      orderBy: { variationId: 'asc' },
    });
    if (freeGroups.length === 0) {
      return [];
    }

    const variationIds = freeGroups.map((group) => group.variationId);
    const [products, activeDemandBins] = await Promise.all([
      client.posProduct.findMany({
        where: {
          storeId: params.order.storeId,
          variationId: { in: variationIds },
        },
        select: {
          productId: true,
          variationId: true,
          customId: true,
          name: true,
        },
      }),
      params.order.assignmentMode === WmsFulfillmentAssignmentMode.BASKET_DEMAND
        ? client.wmsBasketPickDemandBin.findMany({
            where: {
              tenantId: params.order.tenantId,
              variationId: { in: variationIds },
              ...(params.order.warehouseId ? { warehouseId: params.order.warehouseId } : {}),
              basket: {
                status: { in: [...ACTIVE_DEMAND_HOLD_BASKET_STATUSES] },
              },
              demand: {
                storeId: params.order.storeId,
                fulfillmentOrderId: { not: params.order.id },
              },
            },
            select: {
              variationId: true,
              quantityTarget: true,
              quantityPicked: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const heldByVariation = new Map<string, number>();
    for (const bin of activeDemandBins) {
      heldByVariation.set(
        bin.variationId,
        (heldByVariation.get(bin.variationId) ?? 0)
          + Math.max(bin.quantityTarget - bin.quantityPicked, 0),
      );
    }
    const productByVariation = new Map(
      products
        .filter((product) => Boolean(product.variationId))
        .map((product) => [product.variationId!, product]),
    );

    return freeGroups
      .map((group) => {
        const product = productByVariation.get(group.variationId);
        const availableQuantity = Math.max(
          group._count._all - (heldByVariation.get(group.variationId) ?? 0),
          0,
        );
        if (!product || availableQuantity <= 0) {
          return null;
        }
        return {
          productId: product.productId,
          variationId: group.variationId,
          productName: product.name,
          productDisplayId: product.customId,
          availableQuantity,
        };
      })
      .filter((option): option is NonNullable<typeof option> => option !== null)
      .sort((left, right) => (
        left.productName.localeCompare(right.productName)
        || left.variationId.localeCompare(right.variationId)
      ))
      .slice(0, params.limit);
  }

  private async reserveSubstituteUnitsTx(
    tx: Prisma.TransactionClient,
    params: {
      order: Awaited<ReturnType<WmsFulfillmentOpsService['loadAdjustableOrder']>>;
      fulfillmentLineId: string;
      substitute: {
        productId: string;
        variationId: string;
        productName: string;
        productDisplayId: string | null;
      };
      quantity: number;
      actorId: string;
      now: Date;
    },
  ) {
    const candidates = await tx.wmsInventoryUnit.findMany({
      where: {
        tenantId: params.order.tenantId,
        storeId: params.order.storeId,
        ...(params.order.warehouseId ? { warehouseId: params.order.warehouseId } : {}),
        variationId: params.substitute.variationId,
        ...(params.order.posWarehouseRef
          ? {
              OR: [
                { posWarehouseRef: params.order.posWarehouseRef },
                { posWarehouseRef: null },
              ],
            }
          : {}),
        status: WmsInventoryUnitStatus.PUTAWAY,
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
      },
      select: {
        id: true,
        warehouseId: true,
        currentLocationId: true,
        status: true,
      },
      orderBy: [
        { expirationDate: 'asc' },
        { updatedAt: 'asc' },
        { code: 'asc' },
      ],
      take: params.quantity,
    });

    if (candidates.length < params.quantity) {
      throw new ConflictException(
        `The selected substitute no longer has ${params.quantity} eligible unit(s). Refresh available stock and try again.`,
      );
    }

    const sequenceStart = await tx.wmsPickReservation.count({
      where: {
        fulfillmentLineId: params.fulfillmentLineId,
        status: { in: [...ACTIVE_PICK_RESERVATION_STATUSES] },
      },
    });

    for (const [index, unit] of candidates.entries()) {
      const reserved = await tx.wmsInventoryUnit.updateMany({
        where: {
          id: unit.id,
          status: WmsInventoryUnitStatus.PUTAWAY,
        },
        data: {
          status: WmsInventoryUnitStatus.RESERVED,
          updatedById: params.actorId,
        },
      });
      if (reserved.count !== 1) {
        throw new ConflictException('Substitute stock was reserved by another order. Refresh and try again.');
      }

      await tx.wmsPickReservation.upsert({
        where: {
          fulfillmentLineId_inventoryUnitId: {
            fulfillmentLineId: params.fulfillmentLineId,
            inventoryUnitId: unit.id,
          },
        },
        create: {
          fulfillmentOrderId: params.order.id,
          fulfillmentLineId: params.fulfillmentLineId,
          tenantId: params.order.tenantId,
          inventoryUnitId: unit.id,
          status: WmsPickReservationStatus.RESERVED,
          sequence: sequenceStart + index + 1,
          reservedById: params.actorId,
          reservedAt: params.now,
        },
        update: {
          status: WmsPickReservationStatus.RESERVED,
          sequence: sequenceStart + index + 1,
          reservedById: params.actorId,
          reservedAt: params.now,
          pickedById: null,
          pickedAt: null,
        },
      });

      await tx.wmsInventoryMovement.create({
        data: {
          tenantId: params.order.tenantId,
          inventoryUnitId: unit.id,
          warehouseId: unit.warehouseId,
          fromLocationId: unit.currentLocationId,
          toLocationId: unit.currentLocationId,
          fromStatus: unit.status,
          toStatus: WmsInventoryUnitStatus.RESERVED,
          movementType: WmsInventoryMovementType.RESERVATION,
          referenceType: 'WMS_FULFILLMENT_ADJUSTMENT',
          referenceId: params.order.id,
          referenceCode: params.order.posOrderId,
          notes: `Reserved substitute ${params.substitute.productName} for order ${params.order.posOrderId}`,
          actorId: params.actorId,
          createdAt: params.now,
        },
      });
    }
  }

  private requireScopedTenantId(tenantId: string | null) {
    if (!tenantId) {
      throw new BadRequestException('Select a tenant first.');
    }

    return tenantId;
  }

  private async loadPriorityTargetOrder(
    client: Prisma.TransactionClient | PrismaService,
    orderId: string,
    tenantId: string,
  ) {
    const order = await client.wmsFulfillmentOrder.findFirst({
      where: {
        id: orderId,
        tenantId,
        assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
      },
      include: {
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
        posOrder: {
          select: {
            status: true,
            isVoid: true,
            dateLocal: true,
          },
        },
        lines: {
          orderBy: [
            { createdAt: 'asc' },
            { id: 'asc' },
          ],
        },
      },
    });

    if (!order) {
      throw new BadRequestException('Fulfillment order was not found in the selected tenant.');
    }

    if (
      order.status !== WmsFulfillmentOrderStatus.RESTOCKING
      && order.status !== WmsFulfillmentOrderStatus.PARTIAL
      && order.status !== WmsFulfillmentOrderStatus.READY
    ) {
      throw new BadRequestException(
        `Order ${order.posOrderId} is ${this.formatEnumLabel(order.status)} and cannot be prioritized.`,
      );
    }

    if (order.claimedById || order.basketId) {
      throw new ConflictException(`Order ${order.posOrderId} is already in execution and cannot be prioritized.`);
    }

    if (order.posOrder.status !== CONFIRMED_POS_ORDER_STATUS || order.posOrder.isVoid) {
      throw new ConflictException(`Order ${order.posOrderId} is no longer confirmed and cannot be prioritized.`);
    }

    return order;
  }

  private async loadPriorityDonorOrders(
    client: Prisma.TransactionClient | PrismaService,
    targetOrder: Awaited<ReturnType<WmsFulfillmentOpsService['loadPriorityTargetOrder']>>,
  ) {
    const targetVariationIds = Array.from(new Set(
      targetOrder.lines
        .filter((line) => (
          line.status !== WmsFulfillmentLineStatus.CANCELED
          && Math.max(line.quantityRequired, 0) > Math.max(line.quantityAllocated, 0)
        ))
        .map((line) => line.variationId),
    ));

    if (targetVariationIds.length === 0) {
      return [];
    }

    const donors = await client.wmsFulfillmentOrder.findMany({
      where: {
        tenantId: targetOrder.tenantId,
        storeId: targetOrder.storeId,
        assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
        status: {
          in: [
            WmsFulfillmentOrderStatus.READY,
            WmsFulfillmentOrderStatus.PARTIAL,
          ],
        },
        claimedById: null,
        basketId: null,
        pickedQuantity: 0,
        id: {
          not: targetOrder.id,
        },
        priorityOverrideAt: null,
        OR: [
          { priorityReleasedForOrderId: null },
          { priorityReleasedForOrderId: targetOrder.id },
        ],
        posOrder: {
          is: {
            status: CONFIRMED_POS_ORDER_STATUS,
            isVoid: false,
          },
        },
        lines: {
          some: {
            variationId: {
              in: targetVariationIds,
            },
            status: {
              not: WmsFulfillmentLineStatus.CANCELED,
            },
            quantityAllocated: {
              gt: 0,
            },
          },
        },
      },
      include: {
        posOrder: {
          select: {
            dateLocal: true,
          },
        },
        lines: {
          where: {
            variationId: {
              in: targetVariationIds,
            },
            status: {
              not: WmsFulfillmentLineStatus.CANCELED,
            },
          },
          orderBy: [
            { createdAt: 'asc' },
            { id: 'asc' },
          ],
        },
      },
      orderBy: [
        { posOrder: { dateLocal: 'desc' } },
        { id: 'desc' },
      ],
    });

    return donors;
  }

  private buildPriorityPreview(
    targetOrder: Awaited<ReturnType<WmsFulfillmentOpsService['loadPriorityTargetOrder']>>,
    donorOrders: Awaited<ReturnType<WmsFulfillmentOpsService['loadPriorityDonorOrders']>>,
    selectedDonorIds?: Set<string>,
  ) {
    const targetLines = targetOrder.lines
      .filter((line) => line.status !== WmsFulfillmentLineStatus.CANCELED)
      .map((line) => {
        const required = Math.max(line.quantityRequired, 0);
        const allocated = Math.max(line.quantityAllocated, 0);
        const picked = Math.max(line.quantityPicked, 0);
        return {
          id: line.id,
          variationId: line.variationId,
          productName: line.productName,
          productDisplayId: line.productDisplayId,
          required,
          allocated,
          picked,
          shortage: Math.max(required - allocated, 0),
          status: line.status,
          issueReason: line.issueReason,
        };
      });

    const shortageRemaining = new Map<string, number>();
    for (const line of targetLines) {
      if (line.shortage <= 0) {
        continue;
      }

      shortageRemaining.set(
        line.variationId,
        (shortageRemaining.get(line.variationId) ?? 0) + line.shortage,
      );
    }

    const donors = donorOrders
      .filter((order) => !selectedDonorIds || selectedDonorIds.has(order.id))
      .map((order) => {
        let releasableQty = 0;
        let suggestedGiveQty = 0;
        const lines = order.lines
          .map((line) => {
            const releasable = Math.max(Math.min(line.quantityAllocated, line.quantityRequired) - line.quantityPicked, 0);
            if (releasable <= 0) {
              return null;
            }

            releasableQty += releasable;
            const remainingShortage = shortageRemaining.get(line.variationId) ?? 0;
            const suggested = Math.min(releasable, remainingShortage);
            if (suggested > 0) {
              shortageRemaining.set(line.variationId, Math.max(remainingShortage - suggested, 0));
              suggestedGiveQty += suggested;
            }

            return {
              id: line.id,
              variationId: line.variationId,
              productName: line.productName,
              productDisplayId: line.productDisplayId,
              releasableQty: releasable,
              suggestedGiveQty: suggested,
            };
          })
          .filter((line): line is NonNullable<typeof line> => Boolean(line));

        if (releasableQty <= 0) {
          return null;
        }

        return {
          id: order.id,
          posOrderId: order.posOrderId,
          status: order.status,
          statusLabel: this.formatEnumLabel(order.status),
          dateLocal: order.posOrder?.dateLocal ?? null,
          customerName: order.customerName ?? null,
          releasableQty,
          suggestedGiveQty,
          lines,
        };
      })
      .filter((order): order is NonNullable<typeof order> => Boolean(order));

    const targetShortage = targetLines.reduce((sum, line) => sum + line.shortage, 0);
    const totalSuggestedQty = donors.reduce((sum, donor) => sum + donor.suggestedGiveQty, 0);

    return {
      target: {
        id: targetOrder.id,
        posOrderId: targetOrder.posOrderId,
        status: targetOrder.status,
        statusLabel: this.formatEnumLabel(targetOrder.status),
        tenantId: targetOrder.tenantId,
        storeId: targetOrder.storeId,
        storeName: targetOrder.store?.shopName || targetOrder.store?.name || null,
        tenantName: targetOrder.store?.tenant?.name ?? null,
        orderDateLocal: targetOrder.posOrder?.dateLocal ?? null,
        isPrioritized: Boolean(targetOrder.priorityOverrideAt),
        prioritizedAt: targetOrder.priorityOverrideAt ?? null,
        priorityReason: targetOrder.priorityOverrideReason ?? null,
        lines: targetLines,
      },
      donors,
      summary: {
        donorOrders: donors.length,
        targetShortage,
        totalSuggestedQty,
        canFullyPrioritize: targetShortage > 0 && totalSuggestedQty >= targetShortage,
        remainingShortage: Math.max(targetShortage - totalSuggestedQty, 0),
      },
    };
  }

  private async lockFulfillmentOrdersForUpdate(
    tx: Prisma.TransactionClient,
    orderIds: string[],
  ) {
    const scopedIds = Array.from(new Set(orderIds.filter(Boolean)));
    if (scopedIds.length === 0) {
      return;
    }

    await tx.$queryRaw(
      Prisma.sql`
        SELECT id
        FROM wms_fulfillment_orders
        WHERE id IN (${Prisma.join(scopedIds.map((id) => Prisma.sql`${id}::uuid`))})
        FOR UPDATE
      `,
    );
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

  private buildDemandVariationKey(params: {
    basketId: string;
    tenantId: string;
    storeId: string;
    variationId: string;
  }) {
    return `${params.basketId}:${params.tenantId}:${params.storeId}:${params.variationId}`;
  }

  private buildDemandLocationKey(params: {
    basketId: string;
    tenantId: string;
    storeId: string;
    variationId: string;
    locationId: string;
  }) {
    return `${this.buildDemandVariationKey(params)}:${params.locationId}`;
  }

  private resolveActorId(user: { userId?: string; id?: string }) {
    return user.userId || user.id || null;
  }

  private resolveSessionId(user: { sessionId?: string | null }) {
    return user.sessionId ?? null;
  }

  private mapActor(actor: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null) {
    if (!actor) {
      return null;
    }

    const name = [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim() || actor.email;
    return {
      id: actor.id,
      name,
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

  private buildEmptyOpsHealth(
    scope: {
      activeTenantId: string | null;
      tenants: Array<{ id: string; label: string; slug: string; status: string }>;
    },
    limit: number,
    staleMinutes: number,
  ) {
    return {
      tenantReady: false,
      filters: {
        tenants: scope.tenants,
        activeTenantId: scope.activeTenantId,
        limit,
        staleMinutes,
      },
      summary: {
        activeLegacyReservations: 0,
        activeDemandBaskets: 0,
        pickedNotPackedBasketUnits: 0,
        demandQuantityMismatches: 0,
      },
      legacyReservations: [],
      activeDemandBaskets: [],
      pickedNotPackedBasketUnits: [],
      demandMismatches: [],
    };
  }

  private async lockBasketForUpdate(tx: Prisma.TransactionClient, basketId: string) {
    await tx.$queryRaw`SELECT "id" FROM "wms_baskets" WHERE "id" = ${basketId}::uuid FOR UPDATE`;
  }
}

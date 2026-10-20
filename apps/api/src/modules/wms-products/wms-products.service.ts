import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TenantStatus,
  WmsLocationKind,
  WmsProductProfileStatus,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IntegrationService } from '../integrations/integration.service';
import { WmsCogsSyncService, WmsCogsSyncResult } from '../product-cogs/wms-cogs-sync.service';
import { GetWmsProductsOverviewDto } from './dto/get-wms-products-overview.dto';
import { GetWmsVariationIntegrityAuditDto } from './dto/get-wms-variation-integrity-audit.dto';
import { UpdateWmsProductProfileDto } from './dto/update-wms-product-profile.dto';

const PRODUCT_SECTION_LOCATION_KINDS = [WmsLocationKind.SECTION] as const;
const ACTIVE_WMS_TENANT_STATUSES = [TenantStatus.ACTIVE, TenantStatus.TRIAL] as const;

type ProductProfileRecord = Prisma.WmsProductProfileGetPayload<{
  include: {
    posProduct: {
      select: {
        id: true;
        productId: true;
        variationId: true;
        warehouseId: true;
        customId: true;
        productSnapshot: true;
        name: true;
        retailPrice: true;
        createdAt: true;
        updatedAt: true;
        store: {
          select: {
            id: true;
            name: true;
            shopName: true;
            tenant: {
              select: {
                name: true;
              };
            };
          };
        };
      };
    };
  };
}>;

type NonStockableProductRecord = Prisma.PosProductGetPayload<{
  select: {
    id: true;
    productId: true;
    variationId: true;
    warehouseId: true;
    customId: true;
    productSnapshot: true;
    name: true;
    retailPrice: true;
    createdAt: true;
    updatedAt: true;
    store: {
      select: {
        id: true;
        name: true;
        shopName: true;
        tenant: {
          select: {
            name: true;
          };
        };
      };
    };
  };
}>;

type AuditCanonicalVariationProduct = {
  id: string;
  storeId: string;
  productId: string;
  variationId: string;
  name: string;
  customId: string | null;
  store: {
    id: string;
    name: string;
    shopName: string;
  };
};

@Injectable()
export class WmsProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly integrationService: IntegrationService,
    private readonly cogsSync: WmsCogsSyncService,
  ) {}

  async getOverview(query: GetWmsProductsOverviewDto) {
    const scope = await this.resolveTenantScope(query.tenantId, query.allTenants === true);
    const isAllTenantScope = scope.canAccessAllTenants && !scope.activeTenantId;

    if (!scope.activeTenantId && !isAllTenantScope) {
      return {
        tenantReady: false,
        summary: {
          products: 0,
          defaultProfiles: 0,
          readyProfiles: 0,
          serializedProfiles: 0,
          warehouseScopedProducts: 0,
          assignedProfiles: 0,
          unassignedProfiles: 0,
          nonStockableProducts: 0,
        },
        filters: {
          tenants: scope.tenants,
          stores: [],
          posWarehouses: [],
          activeTenantId: null,
          activeStoreId: null,
          activePosWarehouseId: null,
        },
        locationOptions: [],
        products: [],
      };
    }

    if (scope.activeTenantId) {
      await this.ensureDefaultProfiles(scope.activeTenantId, query.storeId);
    } else if (isAllTenantScope) {
      for (const tenant of scope.tenants) {
        await this.ensureDefaultProfiles(tenant.id, query.storeId);
      }
    }

    const tenantWhere = scope.activeTenantId ? { tenantId: scope.activeTenantId } : {};
    const storeTenantWhere = scope.activeTenantId ? { tenantId: scope.activeTenantId } : {};

    const stores = await this.prisma.posStore.findMany({
      where: tenantWhere,
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
            products: true,
          },
        },
      },
      orderBy: [{ name: 'asc' }],
    });

    const activeStoreId =
      query.storeId && stores.some((store) => store.id === query.storeId)
        ? query.storeId
        : null;

    const posWarehouses = activeStoreId
      ? await this.prisma.posWarehouse.findMany({
          where: { storeId: activeStoreId },
          select: {
            id: true,
            warehouseId: true,
            name: true,
          },
          orderBy: [{ name: 'asc' }],
        })
      : [];

    const activePosWarehouse =
      query.posWarehouseId && posWarehouses.some((warehouse) => warehouse.id === query.posWarehouseId)
        ? posWarehouses.find((warehouse) => warehouse.id === query.posWarehouseId) ?? null
        : null;

    const where: Prisma.WmsProductProfileWhereInput = {
      ...tenantWhere,
      ...(activeStoreId ? { storeId: activeStoreId } : {}),
      ...(activePosWarehouse ? { posWarehouseRef: activePosWarehouse.warehouseId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { variationId: { contains: query.search, mode: 'insensitive' } },
              { productId: { contains: query.search, mode: 'insensitive' } },
              { posProduct: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const productCandidateWhere: Prisma.PosProductWhereInput = {
      ...(scope.activeTenantId ? { store: storeTenantWhere } : {}),
      ...(activeStoreId ? { storeId: activeStoreId } : {}),
      ...(activePosWarehouse ? { warehouseId: activePosWarehouse.warehouseId } : {}),
      ...(!query.status && query.search
        ? {
            OR: [
              { variationId: { contains: query.search, mode: 'insensitive' } },
              { productId: { contains: query.search, mode: 'insensitive' } },
              { customId: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [profileCandidates, productCandidates, warehouseCounts, locationOptions] =
      await Promise.all([
        this.prisma.wmsProductProfile.findMany({
          where,
          include: {
            posProduct: {
              select: {
                id: true,
                productId: true,
                variationId: true,
                warehouseId: true,
                customId: true,
                productSnapshot: true,
                name: true,
                retailPrice: true,
                createdAt: true,
                updatedAt: true,
                store: {
                  select: {
                    id: true,
                    name: true,
                    shopName: true,
                    tenant: {
                      select: {
                        name: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: [{ updatedAt: 'desc' }],
        }),
        query.status
          ? Promise.resolve([] as NonStockableProductRecord[])
          : this.prisma.posProduct.findMany({
              where: productCandidateWhere,
              select: {
                id: true,
                productId: true,
                variationId: true,
                warehouseId: true,
                customId: true,
                productSnapshot: true,
                name: true,
                retailPrice: true,
                createdAt: true,
                updatedAt: true,
                store: {
                  select: {
                    id: true,
                    name: true,
                    shopName: true,
                    tenant: {
                      select: {
                        name: true,
                      },
                    },
                  },
                },
              },
              orderBy: [{ updatedAt: 'desc' }],
            }),
        activeStoreId
          ? this.prisma.posProduct.groupBy({
              by: ['warehouseId'],
              where: {
                storeId: activeStoreId,
              },
              _count: {
                _all: true,
              },
            })
          : Promise.resolve([] as Array<{ warehouseId: string | null; _count: { _all: number } }>),
        this.prisma.wmsLocation.findMany({
          where: {
            isActive: true,
            kind: {
              in: [...PRODUCT_SECTION_LOCATION_KINDS],
            },
          },
          select: {
            id: true,
            code: true,
            name: true,
            kind: true,
            warehouse: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
          orderBy: [{ warehouse: { code: 'asc' } }, { code: 'asc' }],
        }),
      ]);

    const profiles = profileCandidates.filter(
      (profile) =>
        this.isStockableVariation(profile.posProduct.productId, profile.posProduct.variationId)
        && this.isStockableVariation(profile.productId, profile.variationId),
    );
    const nonStockableProducts = productCandidates.filter(
      (product) => !this.isStockableVariation(product.productId, product.variationId),
    );
    const totalProfiles = profiles.length;
    const defaultProfiles = profiles.filter(
      (profile) => profile.status === WmsProductProfileStatus.DEFAULT,
    ).length;
    const readyProfiles = profiles.filter(
      (profile) => profile.status === WmsProductProfileStatus.READY,
    ).length;
    const serializedProfiles = profiles.filter((profile) => profile.isSerialized).length;
    const warehouseScopedProducts = profiles.filter((profile) => profile.posWarehouseRef).length;
    const assignedProfiles = profiles.filter((profile) => profile.preferredLocationId).length;
    const unassignedProfiles = profiles.filter((profile) => !profile.preferredLocationId).length;

    const locationIds = Array.from(
      new Set(
        profiles.flatMap((profile) =>
          [profile.preferredLocationId, profile.pickLocationId].filter(Boolean) as string[],
        ),
      ),
    );

    const locations = locationIds.length
      ? await this.prisma.wmsLocation.findMany({
          where: {
            id: {
              in: locationIds,
            },
          },
          select: {
            id: true,
            code: true,
            name: true,
            kind: true,
            warehouse: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        })
      : [];

    const locationMap = new Map(
      locations.map((location) => [
        location.id,
        {
          id: location.id,
          code: location.code,
          name: location.name,
          kind: location.kind,
          warehouse: location.warehouse,
          label: `${location.warehouse.code} · ${location.code}`,
        },
      ]),
    );

    const warehouseMap = new Map(
      posWarehouses.map((warehouse) => [warehouse.warehouseId, warehouse]),
    );
    const warehouseCountMap = new Map(
      warehouseCounts
        .filter((record) => record.warehouseId)
        .map((record) => [record.warehouseId as string, record._count._all]),
    );

    const products = [
      ...profiles.map((profile) => this.mapProfile(profile, warehouseMap, locationMap, isAllTenantScope)),
      ...nonStockableProducts.map((product) =>
        this.mapNonStockableProduct(product, warehouseMap, isAllTenantScope),
      ),
    ].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());

    return {
      tenantReady: true,
      summary: {
        products: totalProfiles + nonStockableProducts.length,
        defaultProfiles,
        readyProfiles,
        serializedProfiles,
        warehouseScopedProducts,
        assignedProfiles,
        unassignedProfiles,
        nonStockableProducts: nonStockableProducts.length,
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
          productCount: store._count.products,
        })),
        posWarehouses: posWarehouses.map((warehouse) => ({
          id: warehouse.id,
          warehouseId: warehouse.warehouseId,
          label: warehouse.name,
          productCount: warehouseCountMap.get(warehouse.warehouseId) ?? 0,
        })),
        activeTenantId: scope.activeTenantId,
        activeStoreId,
        activePosWarehouseId: activePosWarehouse?.id ?? null,
      },
      locationOptions: locationOptions.map((location) => ({
        id: location.id,
        code: location.code,
        name: location.name,
        kind: location.kind,
        label: `${location.warehouse.code} · ${location.code} · ${location.name}`,
        warehouse: location.warehouse,
      })),
      products,
    };
  }

  async getVariationIntegrityAudit(query: GetWmsVariationIntegrityAuditDto) {
    const scope = await this.resolveTenantScope(query.tenantId);

    if (!scope.activeTenantId) {
      return {
        tenantReady: false,
        detectedAt: new Date().toISOString(),
        summary: {
          canonicalVariationProducts: 0,
          invalidInventoryUnits: 0,
          invalidFulfillmentLines: 0,
        },
        inventoryUnits: [],
        fulfillmentLines: [],
      };
    }

    const stores = await this.prisma.posStore.findMany({
      where: { tenantId: scope.activeTenantId },
      select: { id: true },
    });
    const activeStoreId =
      query.storeId && stores.some((store) => store.id === query.storeId)
        ? query.storeId
        : null;

    const canonicalVariationProducts = await this.prisma.posProduct.findMany({
      where: {
        store: {
          tenantId: scope.activeTenantId,
        },
        ...(activeStoreId ? { storeId: activeStoreId } : {}),
        variationId: {
          not: null,
        },
      },
      select: {
        id: true,
        storeId: true,
        productId: true,
        variationId: true,
        name: true,
        customId: true,
        store: {
          select: {
            id: true,
            name: true,
            shopName: true,
          },
        },
      },
    });

    const canonicalProducts = canonicalVariationProducts.filter(
      (product): product is AuditCanonicalVariationProduct =>
        Boolean(product.variationId) && product.variationId !== product.productId,
    );

    if (!canonicalProducts.length) {
      return {
        tenantReady: true,
        detectedAt: new Date().toISOString(),
        summary: {
          canonicalVariationProducts: 0,
          invalidInventoryUnits: 0,
          invalidFulfillmentLines: 0,
        },
        inventoryUnits: [],
        fulfillmentLines: [],
      };
    }

    const canonicalKeyMap = new Map(
      canonicalProducts.map((product) => [`${product.storeId}:${product.productId}`, product]),
    );
    const candidateProductIds = Array.from(new Set(canonicalProducts.map((product) => product.productId)));

    const [inventoryUnitCandidates, fulfillmentLineCandidates] = await Promise.all([
      this.prisma.wmsInventoryUnit.findMany({
        where: {
          tenantId: scope.activeTenantId,
          ...(activeStoreId ? { storeId: activeStoreId } : {}),
          productId: {
            in: candidateProductIds,
          },
          variationId: {
            in: candidateProductIds,
          },
        },
        select: {
          id: true,
          code: true,
          status: true,
          storeId: true,
          productId: true,
          variationId: true,
          warehouse: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
          posProduct: {
            select: {
              id: true,
              name: true,
              customId: true,
            },
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
      }),
      this.prisma.wmsFulfillmentLine.findMany({
        where: {
          tenantId: scope.activeTenantId,
          ...(activeStoreId
            ? {
                fulfillmentOrder: {
                  storeId: activeStoreId,
                },
              }
            : {}),
          productId: {
            in: candidateProductIds,
          },
          variationId: {
            in: candidateProductIds,
          },
        },
        select: {
          id: true,
          productId: true,
          variationId: true,
          quantityRequired: true,
          status: true,
          fulfillmentOrder: {
            select: {
              id: true,
              posOrderId: true,
              storeId: true,
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
            },
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
      }),
    ]);

    const invalidInventoryUnits = inventoryUnitCandidates
      .filter((unit) => unit.variationId === unit.productId && canonicalKeyMap.has(`${unit.storeId}:${unit.productId}`))
      .map((unit) => {
        const canonical = canonicalKeyMap.get(`${unit.storeId}:${unit.productId}`)!;
        return {
          id: unit.id,
          code: unit.code,
          status: unit.status,
          productId: unit.productId,
          legacyVariationId: unit.variationId,
          canonicalVariationId: canonical.variationId,
          name: unit.posProduct.name,
          productCustomId: unit.posProduct.customId,
          store: {
            id: canonical.store.id,
            name: canonical.store.shopName || canonical.store.name,
          },
          warehouse: unit.warehouse,
        };
      });

    const invalidFulfillmentLines = fulfillmentLineCandidates
      .filter(
        (line) =>
          Boolean(line.productId)
          && line.variationId === line.productId
          && canonicalKeyMap.has(`${line.fulfillmentOrder.storeId}:${line.productId}`),
      )
      .map((line) => {
        const canonical = canonicalKeyMap.get(`${line.fulfillmentOrder.storeId}:${line.productId}`)!;
        return {
          id: line.id,
          fulfillmentOrderId: line.fulfillmentOrder.id,
          posOrderId: line.fulfillmentOrder.posOrderId,
          status: line.status,
          quantityRequired: line.quantityRequired,
          productId: line.productId,
          legacyVariationId: line.variationId,
          canonicalVariationId: canonical.variationId,
          store: {
            id: line.fulfillmentOrder.store.id,
            name: line.fulfillmentOrder.store.shopName || line.fulfillmentOrder.store.name,
          },
          warehouse: line.fulfillmentOrder.warehouse,
        };
      });

    return {
      tenantReady: true,
      detectedAt: new Date().toISOString(),
      summary: {
        canonicalVariationProducts: canonicalProducts.length,
        invalidInventoryUnits: invalidInventoryUnits.length,
        invalidFulfillmentLines: invalidFulfillmentLines.length,
      },
      inventoryUnits: invalidInventoryUnits.slice(0, 50),
      fulfillmentLines: invalidFulfillmentLines.slice(0, 50),
    };
  }

  async syncStoreProducts(storeId: string, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new BadRequestException('Tenant scope is required');
    }

    const store = await this.prisma.posStore.findFirst({
      where: {
        id: storeId,
        tenantId: scope.activeTenantId,
      },
      select: {
        id: true,
        name: true,
        shopName: true,
      },
    });

    if (!store) {
      throw new NotFoundException('Store not found in the selected tenant');
    }

    const result = await this.integrationService.syncPancakeProductsByStoreId(
      store.id,
      scope.activeTenantId,
    );

    return {
      store: {
        id: store.id,
        name: store.shopName || store.name,
      },
      syncedCount: result.syncedCount,
      profileCount: (
        await this.prisma.wmsProductProfile.findMany({
          where: {
            tenantId: scope.activeTenantId,
            storeId: store.id,
          },
          select: {
            productId: true,
            variationId: true,
            posProduct: {
              select: {
                productId: true,
                variationId: true,
              },
            },
          },
        })
      ).filter((profile) =>
        this.isStockableVariation(profile.productId, profile.variationId)
        && this.isStockableVariation(profile.posProduct.productId, profile.posProduct.variationId),
      ).length,
    };
  }

  async updateProfile(id: string, body: UpdateWmsProductProfileDto, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const existing = await this.prisma.wmsProductProfile.findFirst({
      where: {
        id,
        tenantId: scope.activeTenantId,
      },
      include: {
        posProduct: {
          select: {
            id: true,
            productId: true,
            variationId: true,
            warehouseId: true,
            customId: true,
            productSnapshot: true,
            name: true,
            retailPrice: true,
            createdAt: true,
            updatedAt: true,
            store: {
              select: {
                id: true,
                name: true,
                shopName: true,
                tenant: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!existing) {
      throw new NotFoundException('Product profile not found');
    }

    const preferredLocationId =
      body.preferredLocationId === undefined ? existing.preferredLocationId : body.preferredLocationId;

    if (!this.isStockableVariation(existing.posProduct.productId, existing.posProduct.variationId)) {
      throw new BadRequestException(
        this.getStockabilityReason(existing.posProduct.productId, existing.posProduct.variationId),
      );
    }

    if (!this.isStockableVariation(existing.productId, existing.variationId)) {
      throw new BadRequestException('This product profile still uses a legacy variation mapping. Sync this product first.');
    }

    await this.validateLocationReference(preferredLocationId ?? null, PRODUCT_SECTION_LOCATION_KINDS);

    let cogsSync: WmsCogsSyncResult | undefined;
    const updated = await this.prisma.$transaction(async tx => {
      const prepared = body.inhouseUnitCost !== undefined ? await this.cogsSync.prepare(tx, scope.activeTenantId!, [existing.id]) : null;
      if (prepared) this.cogsSync.assertSourceProfiles(prepared);
      const profile = await tx.wmsProductProfile.update({
      where: { id: existing.id, tenantId: scope.activeTenantId!, storeId: existing.storeId, posProductId: existing.posProductId,
        productId: existing.productId, variationId: existing.variationId, updatedAt: existing.updatedAt },
      data: {
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.isSerialized !== undefined ? { isSerialized: body.isSerialized } : {}),
        ...(body.preferredLocationId !== undefined ? { preferredLocationId: body.preferredLocationId } : {}),
        ...(body.isFragile !== undefined ? { isFragile: body.isFragile } : {}),
        ...(body.isStackable !== undefined ? { isStackable: body.isStackable } : {}),
        ...(body.keepDry !== undefined ? { keepDry: body.keepDry } : {}),
        ...(body.requiresExpirationDate !== undefined
          ? { requiresExpirationDate: body.requiresExpirationDate }
          : {}),
        ...(body.inhouseUnitCost !== undefined ? { inhouseUnitCost: this.numberOrNull(body.inhouseUnitCost) } : {}),
        ...(body.supplierUnitCost !== undefined ? { supplierUnitCost: this.numberOrNull(body.supplierUnitCost) } : {}),
        ...(body.notes !== undefined ? { notes: this.cleanOptionalText(body.notes) } : {}),
      },
      include: {
        posProduct: {
          select: {
            id: true,
            productId: true,
            variationId: true,
            warehouseId: true,
            customId: true,
            productSnapshot: true,
            name: true,
            retailPrice: true,
            createdAt: true,
            updatedAt: true,
            store: {
              select: {
                id: true,
                name: true,
                shopName: true,
                tenant: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      });
      if (prepared) cogsSync = await this.cogsSync.syncAfter(tx, prepared, { source: 'WMS_PROFILE_EDIT', sourceRef: existing.id,
        actorId: (this.cls.get('userId') as string | undefined) ?? null });
      // Fallback may have filled a blank/zero inhouse cost in the same transaction.
      return prepared?.enabled ? tx.wmsProductProfile.findUniqueOrThrow({ where: { id: profile.id, tenantId: scope.activeTenantId!, storeId: existing.storeId, posProductId: existing.posProductId }, include: { posProduct: { select: {
        id: true, productId: true, variationId: true, warehouseId: true, customId: true, productSnapshot: true, name: true,
        retailPrice: true, createdAt: true, updatedAt: true, store: { select: { id: true, name: true, shopName: true, tenant: { select: { name: true } } } },
      } } } }) : profile;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 30000 });

    const locationIds = [updated.preferredLocationId, updated.pickLocationId].filter(Boolean) as string[];
    const locations = locationIds.length
      ? await this.prisma.wmsLocation.findMany({
          where: { id: { in: locationIds } },
          select: {
            id: true,
            code: true,
            name: true,
            kind: true,
            warehouse: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        })
      : [];

    const locationMap = new Map(
      locations.map((location) => [
        location.id,
        {
          id: location.id,
          code: location.code,
          name: location.name,
          kind: location.kind,
          warehouse: location.warehouse,
          label: `${location.warehouse.code} · ${location.code}`,
        },
      ]),
    );

    const posWarehouse = updated.posWarehouseRef
      ? await this.prisma.posWarehouse.findFirst({
          where: {
            storeId: updated.storeId,
            warehouseId: updated.posWarehouseRef,
          },
          select: {
            id: true,
            warehouseId: true,
            name: true,
          },
        })
      : null;

    return {
      cogsSync,
      profile: this.mapProfile(
        updated,
        new Map(posWarehouse ? [[posWarehouse.warehouseId, posWarehouse]] : []),
        locationMap,
      ),
    };
  }

  private cleanOptionalText(value: string | null | undefined) {
    const cleaned = value?.trim();
    return cleaned ? cleaned : null;
  }

  private numberOrNull(value: number | null | undefined) {
    if (value === null || value === undefined) {
      return null;
    }
    return value;
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

  private async ensureDefaultProfiles(tenantId: string, storeId?: string) {
    const products = await this.prisma.posProduct.findMany({
      where: {
        variationId: {
          not: null,
        },
        store: {
          tenantId,
        },
        ...(storeId ? { storeId } : {}),
      },
      select: {
        id: true,
        storeId: true,
        productId: true,
        variationId: true,
        warehouseId: true,
      },
    });

    const stockableProducts = products.filter((product) =>
      this.isStockableVariation(product.productId, product.variationId),
    );

    if (!stockableProducts.length) {
      return;
    }

    const existingProfiles = await this.prisma.wmsProductProfile.findMany({
      where: {
        posProductId: {
          in: stockableProducts.map((product) => product.id),
        },
      },
      select: {
        posProductId: true,
      },
    });

    const existingProductIds = new Set(existingProfiles.map((profile) => profile.posProductId));
    const missingProfiles = stockableProducts.filter((product) => !existingProductIds.has(product.id));

    if (!missingProfiles.length) {
      return;
    }

    await this.prisma.wmsProductProfile.createMany({
      data: missingProfiles.map((product) => ({
        tenantId,
        storeId: product.storeId,
        posProductId: product.id,
        productId: product.productId,
        variationId: product.variationId!,
        posWarehouseRef: product.warehouseId,
        status: WmsProductProfileStatus.DEFAULT,
        isSerialized: true,
      })),
      skipDuplicates: true,
    });
  }

  private async validateLocationReference(
    locationId: string | null,
    allowedKinds: readonly WmsLocationKind[],
  ) {
    if (!locationId) {
      return;
    }

    const location = await this.prisma.wmsLocation.findUnique({
      where: { id: locationId },
      select: {
        id: true,
        kind: true,
        isActive: true,
      },
    });

    if (!location) {
      throw new BadRequestException('Selected WMS location was not found');
    }

    if (!location.isActive) {
      throw new BadRequestException('Selected WMS location is inactive');
    }

    if (!allowedKinds.includes(location.kind)) {
      throw new BadRequestException('Selected WMS location is not valid for this profile field');
    }
  }

  private mapProfile(
    profile: ProductProfileRecord,
    warehouseMap: Map<string, { id: string; warehouseId: string; name: string }>,
    locationMap: Map<
      string,
      {
        id: string;
        code: string;
        name: string;
        kind: WmsLocationKind;
        warehouse: {
          id: string;
          code: string;
          name: string;
        };
        label: string;
      }
    >,
    includeTenantInStoreName = false,
  ) {
    const posWarehouse = profile.posWarehouseRef ? warehouseMap.get(profile.posWarehouseRef) ?? null : null;
    const snapshot = profile.posProduct.productSnapshot as
      | {
          display_id?: string | null;
          product?: {
            display_id?: string | null;
          } | null;
        }
      | null;
    const snapshotCustomId =
      typeof snapshot?.display_id === 'string'
        ? snapshot.display_id
        : typeof snapshot?.product?.display_id === 'string'
          ? snapshot.product.display_id
          : null;

    const storeName = profile.posProduct.store.shopName || profile.posProduct.store.name;

    return {
      id: profile.id,
      profileId: profile.id,
      posProductId: profile.posProductId,
      status: profile.status,
      isSerialized: profile.isSerialized,
      requiresExpirationDate: profile.requiresExpirationDate,
      isStockable: true,
      stockabilityReason: null,
      productId: profile.productId,
      variationId: profile.variationId,
      variationDisplayId: snapshotCustomId,
      productCustomId: profile.posProduct.customId,
      name: profile.posProduct.name,
      customId: snapshotCustomId,
      retailPrice: profile.posProduct.retailPrice,
      inhouseUnitCost: profile.inhouseUnitCost,
      supplierUnitCost: profile.supplierUnitCost,
      posWarehouse: posWarehouse
        ? {
            id: posWarehouse.id,
            warehouseId: posWarehouse.warehouseId,
            name: posWarehouse.name,
          }
        : null,
      store: {
        id: profile.posProduct.store.id,
        name: includeTenantInStoreName
          ? `${profile.posProduct.store.tenant.name} · ${storeName}`
          : storeName,
      },
      preferredLocation: profile.preferredLocationId
        ? locationMap.get(profile.preferredLocationId) ?? null
        : null,
      pickLocation: profile.pickLocationId ? locationMap.get(profile.pickLocationId) ?? null : null,
      handling: {
        isFragile: profile.isFragile,
        isStackable: profile.isStackable,
        keepDry: profile.keepDry,
      },
      notes: profile.notes,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  private mapNonStockableProduct(
    product: NonStockableProductRecord,
    warehouseMap: Map<string, { id: string; warehouseId: string; name: string }>,
    includeTenantInStoreName = false,
  ) {
    const snapshot = product.productSnapshot as
      | {
          display_id?: string | null;
          product?: {
            display_id?: string | null;
          } | null;
        }
      | null;
    const snapshotCustomId =
      typeof snapshot?.display_id === 'string'
        ? snapshot.display_id
        : typeof snapshot?.product?.display_id === 'string'
          ? snapshot.product.display_id
          : null;
    const posWarehouse = product.warehouseId ? warehouseMap.get(product.warehouseId) ?? null : null;
    const storeName = product.store.shopName || product.store.name;

    return {
      id: `non-stockable:${product.id}`,
      profileId: null,
      posProductId: product.id,
      status: null,
      isSerialized: null,
      requiresExpirationDate: false,
      isStockable: false,
      stockabilityReason: this.getStockabilityReason(product.productId, product.variationId),
      productId: product.productId,
      variationId: product.variationId,
      variationDisplayId: snapshotCustomId,
      productCustomId: product.customId,
      name: product.name,
      customId: snapshotCustomId,
      retailPrice: product.retailPrice,
      inhouseUnitCost: null,
      supplierUnitCost: null,
      posWarehouse: posWarehouse
        ? {
            id: posWarehouse.id,
            warehouseId: posWarehouse.warehouseId,
            name: posWarehouse.name,
          }
        : null,
      store: {
        id: product.store.id,
        name: includeTenantInStoreName
          ? `${product.store.tenant.name} · ${storeName}`
          : storeName,
      },
      preferredLocation: null,
      pickLocation: null,
      handling: {
        isFragile: false,
        isStackable: true,
        keepDry: false,
      },
      notes: null,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  private isLegacyVariationMapping(productId: string, variationId: string | null | undefined) {
    return Boolean(variationId) && variationId === productId;
  }

  private isStockableVariation(productId: string, variationId: string | null | undefined) {
    return Boolean(variationId) && !this.isLegacyVariationMapping(productId, variationId);
  }

  private getStockabilityReason(productId: string, variationId: string | null | undefined) {
    if (!variationId) {
      return 'Missing variation ID';
    }

    if (this.isLegacyVariationMapping(productId, variationId)) {
      return 'Legacy variation mapping detected. Sync this product first.';
    }

    return 'This product is not stockable';
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TenantStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  BulkCreatePosIntegrationDto,
  UpdatePancakeWebhookDto,
  UpdatePancakeWebhookRelayDto,
} from '../integrations/dto';
import { IntegrationService } from '../integrations/integration.service';
import { UpdateWmsPosStoreDto } from './dto/update-wms-pos-store.dto';

const PANCAKE_WEBHOOK_SETTINGS_KEY = 'pancakePosWebhook';

type JsonObject = Record<string, unknown>;

@Injectable()
export class WmsIntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrationService: IntegrationService,
  ) {}

  async getPartnerIntegrations(tenantId: string, baseUrl: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        maxIntegrations: true,
        settings: true,
        _count: {
          select: {
            integrations: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Partner not found');
    }

    const [stores, recentLogs, recentErrorCount] = await Promise.all([
      this.prisma.posStore.findMany({
        where: { tenantId: tenant.id },
        orderBy: [{ createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          shopId: true,
          shopName: true,
          shopAvatarUrl: true,
          description: true,
          status: true,
          enabled: true,
          initialValueOffer: true,
          lastSyncAt: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              products: true,
              tags: true,
              warehouses: true,
            },
          },
          integration: {
            select: {
              id: true,
              name: true,
              provider: true,
              status: true,
              enabled: true,
              lastSyncAt: true,
              syncStatus: true,
              syncError: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      }),
      this.prisma.pancakeWebhookLog.findMany({
        where: { tenantId: tenant.id },
        orderBy: [{ receivedAt: 'desc' }],
        take: 8,
        select: {
          id: true,
          requestId: true,
          receiveStatus: true,
          processStatus: true,
          relayStatus: true,
          orderCount: true,
          upsertedCount: true,
          warningCount: true,
          errorMessage: true,
          receivedAt: true,
          totalDurationMs: true,
          _count: {
            select: { orders: true },
          },
        },
      }),
      this.prisma.pancakeWebhookLog.count({
        where: {
          tenantId: tenant.id,
          receivedAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
          OR: [
            { errorMessage: { not: null } },
            { receiveStatus: { notIn: ['ACCEPTED', 'SUCCESS', 'OK'] } },
            { processStatus: { notIn: ['PROCESSED', 'SUCCESS', 'SKIPPED'] } },
          ],
        },
      }),
    ]);

    const webhook = this.getPancakeWebhookSettings(tenant.settings);
    const activeStores = stores.filter((store) => store.status === 'ACTIVE').length;
    const enabledStores = stores.filter((store) => store.enabled !== false).length;
    const productCount = stores.reduce((sum, store) => sum + store._count.products, 0);
    const tagCount = stores.reduce((sum, store) => sum + store._count.tags, 0);
    const warehouseCount = stores.reduce((sum, store) => sum + store._count.warehouses, 0);

    return {
      partner: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        isOperational:
          tenant.status === TenantStatus.ACTIVE || tenant.status === TenantStatus.TRIAL,
        maxIntegrations: tenant.maxIntegrations,
        integrationCount: tenant._count.integrations,
      },
      summary: {
        stores: stores.length,
        activeStores,
        enabledStores,
        products: productCount,
        tags: tagCount,
        posWarehouses: warehouseCount,
        recentWebhookErrors: recentErrorCount,
      },
      webhook: {
        enabled: webhook.enabled,
        autoCancelEnabled: webhook.autoCancelEnabled,
        reconcileEnabled: webhook.reconcileEnabled,
        reconcileIntervalSeconds: webhook.reconcileIntervalSeconds,
        reconcileMode: webhook.reconcileMode,
        hasApiKey: Boolean(webhook.apiKeyHash),
        keyLast4: webhook.keyLast4,
        rotatedAt: webhook.rotatedAt,
        webhookUrl: this.buildPancakeWebhookUrl(baseUrl, tenant.id),
        relayEnabled: webhook.relayEnabled,
        relayWebhookUrl: webhook.relayWebhookUrl,
        relayHeaderKey: webhook.relayHeaderKey,
        relayHasApiKey: Boolean(webhook.relayApiKey || webhook.relayApiKeyEncrypted),
        relayKeyLast4: webhook.relayKeyLast4,
        relayUpdatedAt: webhook.relayUpdatedAt,
      },
      stores: stores.map((store) => ({
        id: store.id,
        name: store.shopName || store.name,
        storeName: store.name,
        shopName: store.shopName,
        shopId: store.shopId,
        shopAvatarUrl: store.shopAvatarUrl,
        description: store.description,
        status: store.status,
        enabled: store.enabled,
        initialValueOffer: store.initialValueOffer === null ? null : Number(store.initialValueOffer),
        lastSyncAt: store.lastSyncAt,
        createdAt: store.createdAt,
        updatedAt: store.updatedAt,
        productCount: store._count.products,
        tagCount: store._count.tags,
        warehouseCount: store._count.warehouses,
        integration: store.integration
          ? {
              id: store.integration.id,
              name: store.integration.name,
              provider: store.integration.provider,
              status: store.integration.status,
              enabled: store.integration.enabled,
              lastSyncAt: store.integration.lastSyncAt,
              syncStatus: store.integration.syncStatus,
              syncError: store.integration.syncError,
              createdAt: store.integration.createdAt,
              updatedAt: store.integration.updatedAt,
            }
          : null,
      })),
      recentWebhookLogs: recentLogs.map((log) => ({
        id: log.id,
        requestId: log.requestId,
        receiveStatus: log.receiveStatus,
        processStatus: log.processStatus,
        relayStatus: log.relayStatus,
        orderCount: log.orderCount,
        orderRowsCount: log._count.orders,
        upsertedCount: log.upsertedCount,
        warningCount: log.warningCount,
        errorMessage: log.errorMessage,
        receivedAt: log.receivedAt,
        totalDurationMs: log.totalDurationMs,
      })),
    };
  }

  async bulkImportPosStores(
    tenantId: string,
    dto: BulkCreatePosIntegrationDto,
    baseUrl: string,
  ) {
    const result = await this.integrationService.bulkCreatePosIntegrations(dto, tenantId);

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'posStores.bulkImport',
      result,
    );
  }

  async syncStoreProducts(tenantId: string, storeId: string, baseUrl: string) {
    const result = await this.integrationService.syncPancakeProductsByStoreId(storeId, tenantId);

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'posStores.syncProducts',
      result,
    );
  }

  async syncStoreTags(tenantId: string, storeId: string, baseUrl: string) {
    const result = await this.integrationService.syncPancakeTagsByStoreId(storeId, tenantId);

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'posStores.syncTags',
      result,
    );
  }

  async syncStoreWarehouses(tenantId: string, storeId: string, baseUrl: string) {
    const result = await this.integrationService.syncPancakeWarehousesByStoreId(
      storeId,
      tenantId,
    );

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'posStores.syncWarehouses',
      result,
    );
  }

  async syncStoreOrders(tenantId: string, storeId: string, baseUrl: string) {
    const result = await this.integrationService.syncPancakeOrdersByStoreId(
      storeId,
      tenantId,
      { days: 14, repairIssueOrders: true },
    );

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'posStores.syncOrders',
      result,
    );
  }

  async syncStoreAll(tenantId: string, storeId: string, baseUrl: string) {
    const [products, tags, warehouses] = await Promise.all([
      this.integrationService.syncPancakeProductsByStoreId(storeId, tenantId),
      this.integrationService.syncPancakeTagsByStoreId(storeId, tenantId),
      this.integrationService.syncPancakeWarehousesByStoreId(storeId, tenantId),
    ]);
    const orders = await this.integrationService.syncPancakeOrdersByStoreId(
      storeId,
      tenantId,
      { days: 14, repairIssueOrders: true },
    );

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'posStores.syncAll',
      { products, tags, warehouses, orders },
    );
  }

  async updatePosStore(
    tenantId: string,
    storeId: string,
    dto: UpdateWmsPosStoreDto,
    baseUrl: string,
  ) {
    const hasUpdate =
      typeof dto.name === 'string'
      || typeof dto.shopName === 'string'
      || typeof dto.description === 'string'
      || dto.status !== undefined
      || typeof dto.enabled === 'boolean'
      || typeof dto.initialValueOffer === 'number';

    if (!hasUpdate) {
      throw new BadRequestException('At least one store setting must be provided');
    }

    const store = await this.prisma.posStore.findFirst({
      where: { id: storeId, tenantId },
      select: {
        id: true,
        integrationId: true,
      },
    });

    if (!store) {
      throw new NotFoundException('POS store not found');
    }

    const storeName = this.optionalTrimmedString(dto.name);
    const shopName = this.optionalTrimmedString(dto.shopName);
    const description =
      typeof dto.description === 'string'
        ? this.optionalTrimmedString(dto.description)
        : undefined;
    const integrationName = shopName ?? storeName ?? undefined;

    await this.prisma.$transaction(async (tx) => {
      await tx.posStore.update({
        where: { id: store.id },
        data: {
          ...(storeName ? { name: storeName } : {}),
          ...(shopName ? { shopName } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(typeof dto.enabled === 'boolean' ? { enabled: dto.enabled } : {}),
          ...(typeof dto.initialValueOffer === 'number'
            ? { initialValueOffer: dto.initialValueOffer }
            : {}),
        },
      });

      if (store.integrationId) {
        await tx.integration.update({
          where: { id: store.integrationId },
          data: {
            ...(integrationName ? { name: integrationName } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            ...(typeof dto.enabled === 'boolean' ? { enabled: dto.enabled } : {}),
          },
        });
      }
    });

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'posStores.update',
      { storeId: store.id },
    );
  }

  async removePosStore(
    tenantId: string,
    storeId: string,
    baseUrl: string,
  ) {
    const store = await this.prisma.posStore.findFirst({
      where: { id: storeId, tenantId },
      select: {
        id: true,
        shopId: true,
        shopName: true,
        name: true,
        integrationId: true,
      },
    });

    if (!store) {
      throw new NotFoundException('POS store not found');
    }

    const [impactedFulfillmentOrders, impactedDemandBaskets, impactedUnitBaskets] = await Promise.all([
      this.prisma.wmsFulfillmentOrder.findMany({
        where: {
          tenantId,
          storeId: store.id,
        },
        select: {
          id: true,
          basketId: true,
        },
      }),
      this.prisma.wmsBasketPickDemand.findMany({
        where: {
          tenantId,
          storeId: store.id,
        },
        select: {
          basketId: true,
        },
      }),
      this.prisma.wmsBasketUnit.findMany({
        where: {
          tenantId,
          storeId: store.id,
        },
        select: {
          basketId: true,
        },
      }),
    ]);

    const impactedOrderIds = impactedFulfillmentOrders.map((order) => order.id);
    const impactedBasketIds = new Set(
      impactedFulfillmentOrders
        .map((order) => order.basketId)
        .filter((basketId): basketId is string => Boolean(basketId)),
    );

    for (const demand of impactedDemandBaskets) {
      impactedBasketIds.add(demand.basketId);
    }

    for (const basketUnit of impactedUnitBaskets) {
      impactedBasketIds.add(basketUnit.basketId);
    }

    if (impactedOrderIds.length > 0) {
      const legacyBaskets = await this.prisma.wmsBasket.findMany({
        where: {
          fulfillmentOrderId: { in: impactedOrderIds },
        },
        select: {
          id: true,
        },
      });

      for (const basket of legacyBaskets) {
        impactedBasketIds.add(basket.id);
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const deletedWebhookOrderLogs = await tx.pancakeWebhookLogOrder.deleteMany({
        where: {
          shopId: store.shopId,
          log: {
            tenantId,
          },
        },
      });

      const deletedPosOrders = await tx.posOrder.deleteMany({
        where: {
          tenantId,
          shopId: store.shopId,
        },
      });

      await tx.posStore.delete({
        where: {
          id: store.id,
        },
      });

      let resetBasketCount = 0;

      if (impactedBasketIds.size > 0) {
        for (const basketId of impactedBasketIds) {
          const basketState = await tx.wmsBasket.findUnique({
            where: { id: basketId },
            select: {
              id: true,
              fulfillmentOrderId: true,
              _count: {
                select: {
                  fulfillmentOrders: true,
                  pickDemands: true,
                  pickDemandBins: true,
                  basketUnits: {
                    where: {
                      status: {
                        in: ['PICKED', 'PACKED'],
                      },
                    },
                  },
                },
              },
            },
          });

          if (!basketState) {
            continue;
          }

          const hasActiveLinks =
            Boolean(basketState.fulfillmentOrderId)
            || basketState._count.fulfillmentOrders > 0
            || basketState._count.pickDemands > 0
            || basketState._count.pickDemandBins > 0
            || basketState._count.basketUnits > 0;

          if (hasActiveLinks) {
            continue;
          }

          await tx.wmsBasket.update({
            where: { id: basketId },
            data: {
              tenantId: null,
              status: 'AVAILABLE',
              assignedPickerId: null,
              assignedPackerId: null,
              fulfillmentOrderId: null,
              claimedAt: null,
              fullAt: null,
              readyForPackAt: null,
            },
          });
          resetBasketCount += 1;
        }
      }

      let deletedIntegrationId: string | null = null;

      if (store.integrationId) {
        const remainingStores = await tx.posStore.count({
          where: {
            tenantId,
            integrationId: store.integrationId,
          },
        });

        if (remainingStores === 0) {
          await tx.integration.delete({
            where: { id: store.integrationId },
          });
          deletedIntegrationId = store.integrationId;
        }
      }

      return {
        storeId: store.id,
        storeName: store.shopName || store.name,
        shopId: store.shopId,
        deletedPosOrders: deletedPosOrders.count,
        deletedWebhookOrderLogs: deletedWebhookOrderLogs.count,
        resetBasketCount,
        deletedIntegrationId,
      };
    });

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'posStores.remove',
      result,
    );
  }

  async updateWebhook(
    tenantId: string,
    dto: UpdatePancakeWebhookDto,
    baseUrl: string,
  ) {
    const result = await this.integrationService.updatePancakeWebhookEnabled(
      dto,
      baseUrl,
      tenantId,
    );

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'webhook.update',
      result,
    );
  }

  async rotateWebhookApiKey(tenantId: string, baseUrl: string) {
    const result = await this.integrationService.rotatePancakeWebhookApiKey(baseUrl, tenantId);

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'webhook.rotateKey',
      result,
    );
  }

  async updateWebhookRelay(
    tenantId: string,
    dto: UpdatePancakeWebhookRelayDto,
    baseUrl: string,
  ) {
    const result = await this.integrationService.updatePancakeWebhookRelayConfig(
      dto,
      baseUrl,
      tenantId,
    );

    return this.buildActionResponse(
      tenantId,
      baseUrl,
      'webhook.updateRelay',
      result,
    );
  }

  private async buildActionResponse(
    tenantId: string,
    baseUrl: string,
    action: string,
    result: unknown,
  ) {
    return {
      action,
      result,
      overview: await this.getPartnerIntegrations(tenantId, baseUrl),
    };
  }

  private buildPancakeWebhookUrl(baseUrl: string, tenantId: string) {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    return `${cleanBase}/api/v1/webhooks/pancake/${tenantId}`;
  }

  private getPancakeWebhookSettings(settings: Prisma.JsonValue) {
    const root = this.normalizeJsonObject(settings);
    const webhook = this.normalizeJsonObject(root[PANCAKE_WEBHOOK_SETTINGS_KEY]);
    const reconcileIntervalSeconds = Number(webhook.reconcileIntervalSeconds);
    const reconcileMode =
      webhook.reconcileMode === 'full_reset' || webhook.reconcileMode === 'incremental'
        ? webhook.reconcileMode
        : 'incremental';

    return {
      enabled: typeof webhook.enabled === 'boolean' ? webhook.enabled : false,
      autoCancelEnabled:
        typeof webhook.autoCancelEnabled === 'boolean' ? webhook.autoCancelEnabled : true,
      reconcileEnabled:
        typeof webhook.reconcileEnabled === 'boolean' ? webhook.reconcileEnabled : true,
      reconcileIntervalSeconds:
        Number.isFinite(reconcileIntervalSeconds) && reconcileIntervalSeconds > 0
          ? Math.floor(reconcileIntervalSeconds)
          : 300,
      reconcileMode,
      apiKeyHash: this.optionalString(webhook.apiKeyHash),
      keyLast4: this.optionalString(webhook.keyLast4),
      rotatedAt: this.optionalString(webhook.rotatedAt),
      relayEnabled: typeof webhook.relayEnabled === 'boolean' ? webhook.relayEnabled : false,
      relayWebhookUrl: this.optionalString(webhook.relayWebhookUrl),
      relayHeaderKey: this.optionalString(webhook.relayHeaderKey) ?? 'x-api-key',
      relayApiKey: this.optionalString(webhook.relayApiKey),
      relayApiKeyEncrypted: this.optionalString(webhook.relayApiKeyEncrypted),
      relayKeyLast4: this.optionalString(webhook.relayKeyLast4),
      relayUpdatedAt: this.optionalString(webhook.relayUpdatedAt),
    };
  }

  private normalizeJsonObject(value: unknown): JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value as JsonObject;
  }

  private optionalString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private optionalTrimmedString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}

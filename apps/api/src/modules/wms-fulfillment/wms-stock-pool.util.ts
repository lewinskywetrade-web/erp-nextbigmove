import { randomUUID } from 'crypto';
import {
  Prisma,
  WmsBasketStatus,
  WmsFulfillmentOrderStatus,
  WmsProductProfileStatus,
} from '@prisma/client';

export type StockPoolMember = {
  profileId: string;
  tenantId: string;
  storeId: string;
  posProductId: string;
  productId: string;
  variationId: string;
  posWarehouseRef: string | null;
  stockPoolGroupId: string;
  productName: string | null;
  productCustomId: string | null;
  variationDisplayId: string | null;
  storeName: string | null;
};

type StockPoolQueryClient = {
  wmsProductProfile?: {
    findMany?: Prisma.TransactionClient['wmsProductProfile']['findMany'];
  };
};

export class TenantStockPoolIndex {
  private readonly groupIdByStoreVariation = new Map<string, string>();
  private readonly memberByStoreVariation = new Map<string, StockPoolMember>();
  private readonly membersByGroupId = new Map<string, StockPoolMember[]>();

  constructor(members: StockPoolMember[]) {
    const rawGroups = new Map<string, StockPoolMember[]>();
    for (const member of members) {
      if (!member.stockPoolGroupId) {
        continue;
      }
      const list = rawGroups.get(member.stockPoolGroupId) ?? [];
      list.push(member);
      rawGroups.set(member.stockPoolGroupId, list);
    }

    for (const [groupId, groupMembers] of Array.from(rawGroups.entries())) {
      if (groupMembers.length < 2) {
        continue;
      }
      this.membersByGroupId.set(groupId, groupMembers);
      for (const member of groupMembers) {
        const key = buildStoreVariationKey(member.storeId, member.variationId);
        this.groupIdByStoreVariation.set(key, groupId);
        this.memberByStoreVariation.set(key, member);
      }
    }
  }

  get hasAnyPools(): boolean {
    return this.membersByGroupId.size > 0;
  }

  getGroupId(storeId: string, variationId: string): string | null {
    return this.groupIdByStoreVariation.get(buildStoreVariationKey(storeId, variationId)) ?? null;
  }

  getPoolMembers(storeId: string, variationId: string): StockPoolMember[] {
    const groupId = this.getGroupId(storeId, variationId);
    if (!groupId) {
      return [];
    }
    return this.membersByGroupId.get(groupId) ?? [];
  }

  getPoolMembersByGroupId(groupId: string | null | undefined): StockPoolMember[] {
    if (!groupId) {
      return [];
    }
    return this.membersByGroupId.get(groupId) ?? [];
  }

  getTargetMember(storeId: string, variationId: string): StockPoolMember | null {
    return this.memberByStoreVariation.get(buildStoreVariationKey(storeId, variationId)) ?? null;
  }

  areStoreVariationsPooled(
    leftStoreId: string,
    leftVariationId: string,
    rightStoreId: string,
    rightVariationId: string,
  ): boolean {
    if (leftStoreId === rightStoreId && leftVariationId === rightVariationId) {
      return true;
    }
    const leftGroup = this.getGroupId(leftStoreId, leftVariationId);
    if (!leftGroup) {
      return false;
    }
    const rightGroup = this.getGroupId(rightStoreId, rightVariationId);
    return leftGroup === rightGroup;
  }

  buildWarehouseAllocationKey(
    warehouseId: string,
    storeId: string,
    variationId: string,
  ): string {
    const groupId = this.getGroupId(storeId, variationId);
    if (groupId) {
      return `${warehouseId}::pool:${groupId}`;
    }
    return `${warehouseId}::${storeId}::${variationId}`;
  }

  buildPooledUnitIdentityFilter(params: {
    storeId: string;
    variationId: string;
    posWarehouseRef: string | null;
    applyPosWarehouseFilterWhenUnpooled?: boolean;
  }): Prisma.WmsInventoryUnitWhereInput {
    const members = this.getPoolMembers(params.storeId, params.variationId);
    if (members.length >= 2) {
      return {
        OR: members.map((member) => ({
          storeId: member.storeId,
          variationId: member.variationId,
        })),
      };
    }

    const applyPosWarehouse = params.applyPosWarehouseFilterWhenUnpooled ?? true;
    if (applyPosWarehouse && params.posWarehouseRef) {
      return {
        storeId: params.storeId,
        variationId: params.variationId,
        OR: [
          { posWarehouseRef: params.posWarehouseRef },
          { posWarehouseRef: null },
        ],
      };
    }

    return {
      storeId: params.storeId,
      variationId: params.variationId,
    };
  }

  buildPooledDemandBinHoldWhere(params: {
    tenantId: string;
    storeId: string;
    variationId: string;
    warehouseId?: string | null;
    locationId?: string | null;
    locationIds?: string[] | null;
    basketStatuses: readonly WmsBasketStatus[];
    orderStatuses: readonly WmsFulfillmentOrderStatus[];
    excludeFulfillmentOrderId?: string | null;
  }): Prisma.WmsBasketPickDemandBinWhereInput {
    const members = this.getPoolMembers(params.storeId, params.variationId);
    const commonWhere: Prisma.WmsBasketPickDemandBinWhereInput = {
      tenantId: params.tenantId,
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(params.locationId ? { locationId: params.locationId } : {}),
      ...(params.locationIds && params.locationIds.length > 0
        ? { locationId: { in: [...params.locationIds] } }
        : {}),
      basket: {
        status: {
          in: [...params.basketStatuses],
        },
      },
    };

    const demandOrderFilter: Prisma.WmsBasketPickDemandWhereInput = {
      ...(params.excludeFulfillmentOrderId
        ? { fulfillmentOrderId: { not: params.excludeFulfillmentOrderId } }
        : {}),
      fulfillmentOrder: {
        status: {
          in: [...params.orderStatuses],
        },
      },
    };

    if (members.length >= 2) {
      return {
        ...commonWhere,
        OR: members.map((member) => ({
          variationId: member.variationId,
          demand: {
            storeId: member.storeId,
            ...demandOrderFilter,
          },
        })),
      };
    }

    return {
      ...commonWhere,
      variationId: params.variationId,
      demand: {
        storeId: params.storeId,
        ...demandOrderFilter,
      },
    };
  }

  expandQueueRefreshScope(params: {
    storeId: string;
    variationIds: string[];
  }): {
    storeIds: string[];
    storeVariationClauses: Array<{ storeId: string; variationIds: string[] }> | null;
  } {
    if (!this.hasAnyPools) {
      return {
        storeIds: [params.storeId],
        storeVariationClauses: params.variationIds.length > 0
          ? [{ storeId: params.storeId, variationIds: params.variationIds }]
          : null,
      };
    }

    if (params.variationIds.length > 0) {
      const variationsByStore = new Map<string, Set<string>>();
      const addStoreVariation = (storeId: string, variationId: string) => {
        const set = variationsByStore.get(storeId) ?? new Set<string>();
        set.add(variationId);
        variationsByStore.set(storeId, set);
      };

      for (const variationId of params.variationIds) {
        addStoreVariation(params.storeId, variationId);
        const members = this.getPoolMembers(params.storeId, variationId);
        for (const member of members) {
          addStoreVariation(member.storeId, member.variationId);
        }
      }

      const storeIds = Array.from(variationsByStore.keys());
      const storeVariationClauses = Array.from(variationsByStore.entries()).map(
        ([storeId, set]) => ({
          storeId,
          variationIds: Array.from(set),
        }),
      );
      return {
        storeIds,
        storeVariationClauses,
      };
    }

    const storeIds = new Set<string>([params.storeId]);
    for (const groupMembers of Array.from(this.membersByGroupId.values())) {
      if (groupMembers.some((member) => member.storeId === params.storeId)) {
        for (const member of groupMembers) {
          storeIds.add(member.storeId);
        }
      }
    }

    return {
      storeIds: Array.from(storeIds),
      storeVariationClauses: null,
    };
  }
}

export const EMPTY_STOCK_POOL_INDEX = new TenantStockPoolIndex([]);

export function buildStoreVariationKey(storeId: string, variationId: string): string {
  return `${storeId}::${variationId}`;
}

export function extractVariationDisplayIdFromSnapshot(snapshot: Prisma.JsonValue | null | undefined): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }
  const record = snapshot as Record<string, unknown>;
  if (typeof record.display_id === 'string' && record.display_id.trim().length > 0) {
    return record.display_id.trim();
  }
  const product = record.product;
  if (product && typeof product === 'object' && !Array.isArray(product)) {
    const productRecord = product as Record<string, unknown>;
    if (typeof productRecord.display_id === 'string' && productRecord.display_id.trim().length > 0) {
      return productRecord.display_id.trim();
    }
  }
  return null;
}

export async function loadTenantStockPoolIndex(
  client: StockPoolQueryClient | null | undefined,
  tenantId: string | null | undefined,
): Promise<TenantStockPoolIndex> {
  if (!tenantId || !client?.wmsProductProfile?.findMany) {
    return EMPTY_STOCK_POOL_INDEX;
  }

  const rows = await client.wmsProductProfile.findMany({
    where: {
      tenantId,
      stockPoolGroupId: {
        not: null,
      },
      status: {
        not: WmsProductProfileStatus.ARCHIVED,
      },
    },
    select: {
      id: true,
      tenantId: true,
      storeId: true,
      posProductId: true,
      productId: true,
      variationId: true,
      posWarehouseRef: true,
      stockPoolGroupId: true,
      posProduct: {
        select: {
          name: true,
          customId: true,
          productSnapshot: true,
        },
      },
      store: {
        select: {
          name: true,
          shopName: true,
        },
      },
    },
  });

  if (!Array.isArray(rows) || rows.length === 0) {
    return EMPTY_STOCK_POOL_INDEX;
  }

  const members: StockPoolMember[] = rows
    .filter((row) => Boolean(row.stockPoolGroupId))
    .map((row) => ({
      profileId: row.id,
      tenantId: row.tenantId,
      storeId: row.storeId,
      posProductId: row.posProductId,
      productId: row.productId,
      variationId: row.variationId,
      posWarehouseRef: row.posWarehouseRef ?? null,
      stockPoolGroupId: row.stockPoolGroupId!,
      productName: row.posProduct?.name ?? null,
      productCustomId: row.posProduct?.customId ?? null,
      variationDisplayId: extractVariationDisplayIdFromSnapshot(row.posProduct?.productSnapshot),
      storeName: row.store?.shopName || row.store?.name || null,
    }));

  return new TenantStockPoolIndex(members);
}

export async function linkProfilesIntoSharedStockPoolTx(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    profileIds: string[];
  },
): Promise<{
  stockPoolGroupId: string | null;
  affectedScopes: Array<{ storeId: string; variationId: string }>;
}> {
  const uniqueProfileIds = Array.from(
    new Set(params.profileIds.map((id) => id?.trim()).filter((id): id is string => Boolean(id))),
  );
  if (uniqueProfileIds.length < 2) {
    return {
      stockPoolGroupId: null,
      affectedScopes: [],
    };
  }

  const directProfiles = await tx.wmsProductProfile.findMany({
    where: {
      tenantId: params.tenantId,
      id: { in: uniqueProfileIds },
      status: { not: WmsProductProfileStatus.ARCHIVED },
    },
    select: {
      id: true,
      storeId: true,
      variationId: true,
      stockPoolGroupId: true,
    },
  });

  if (directProfiles.length < 2) {
    return {
      stockPoolGroupId: null,
      affectedScopes: [],
    };
  }

  const existingGroupIds = Array.from(
    new Set(
      directProfiles
        .map((profile) => profile.stockPoolGroupId)
        .filter((groupId): groupId is string => Boolean(groupId)),
    ),
  ).sort();

  const existingGroupMembers = existingGroupIds.length > 0
    ? await tx.wmsProductProfile.findMany({
        where: {
          tenantId: params.tenantId,
          stockPoolGroupId: { in: existingGroupIds },
        },
        select: {
          id: true,
          storeId: true,
          variationId: true,
          stockPoolGroupId: true,
        },
      })
    : [];

  const canonicalGroupId = existingGroupIds[0] ?? randomUUID();
  const allMembersById = new Map<string, { id: string; storeId: string; variationId: string }>();
  for (const row of [...directProfiles, ...existingGroupMembers]) {
    allMembersById.set(row.id, {
      id: row.id,
      storeId: row.storeId,
      variationId: row.variationId,
    });
  }

  await tx.wmsProductProfile.updateMany({
    where: {
      tenantId: params.tenantId,
      id: {
        in: Array.from(allMembersById.keys()),
      },
    },
    data: {
      stockPoolGroupId: canonicalGroupId,
    },
  });

  return {
    stockPoolGroupId: canonicalGroupId,
    affectedScopes: Array.from(allMembersById.values()).map((row) => ({
      storeId: row.storeId,
      variationId: row.variationId,
    })),
  };
}

export async function syncProfileStockPoolLinksTx(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    profileId: string;
    linkedProfileIds: string[];
  },
): Promise<{
  stockPoolGroupId: string | null;
  affectedScopes: Array<{ storeId: string; variationId: string }>;
}> {
  const selfProfile = await tx.wmsProductProfile.findFirst({
    where: {
      id: params.profileId,
      tenantId: params.tenantId,
    },
    select: {
      id: true,
      storeId: true,
      variationId: true,
      stockPoolGroupId: true,
    },
  });

  if (!selfProfile) {
    return {
      stockPoolGroupId: null,
      affectedScopes: [],
    };
  }

  const desiredPeerIds = Array.from(
    new Set(
      params.linkedProfileIds
        .map((id) => id?.trim())
        .filter((id): id is string => Boolean(id) && id !== selfProfile.id),
    ),
  );

  const affectedByKey = new Map<string, { storeId: string; variationId: string }>();
  const recordAffected = (storeId: string, variationId: string) => {
    affectedByKey.set(buildStoreVariationKey(storeId, variationId), { storeId, variationId });
  };
  recordAffected(selfProfile.storeId, selfProfile.variationId);

  const oldGroupMembers = selfProfile.stockPoolGroupId
    ? await tx.wmsProductProfile.findMany({
        where: {
          tenantId: params.tenantId,
          stockPoolGroupId: selfProfile.stockPoolGroupId,
        },
        select: {
          id: true,
          storeId: true,
          variationId: true,
        },
      })
    : [];

  for (const member of oldGroupMembers) {
    recordAffected(member.storeId, member.variationId);
  }

  if (desiredPeerIds.length === 0) {
    if (selfProfile.stockPoolGroupId) {
      await tx.wmsProductProfile.update({
        where: { id: selfProfile.id },
        data: { stockPoolGroupId: null },
      });

      const remainingOldPeers = oldGroupMembers.filter((member) => member.id !== selfProfile.id);
      if (remainingOldPeers.length < 2 && remainingOldPeers.length > 0) {
        await tx.wmsProductProfile.updateMany({
          where: {
            tenantId: params.tenantId,
            id: { in: remainingOldPeers.map((member) => member.id) },
          },
          data: { stockPoolGroupId: null },
        });
      }
    }

    return {
      stockPoolGroupId: null,
      affectedScopes: Array.from(affectedByKey.values()),
    };
  }

  const desiredPeers = await tx.wmsProductProfile.findMany({
    where: {
      tenantId: params.tenantId,
      id: { in: desiredPeerIds },
      status: { not: WmsProductProfileStatus.ARCHIVED },
    },
    select: {
      id: true,
      storeId: true,
      variationId: true,
      stockPoolGroupId: true,
    },
  });

  for (const peer of desiredPeers) {
    recordAffected(peer.storeId, peer.variationId);
  }

  if (desiredPeers.length === 0) {
    if (selfProfile.stockPoolGroupId) {
      await tx.wmsProductProfile.update({
        where: { id: selfProfile.id },
        data: { stockPoolGroupId: null },
      });
    }
    return {
      stockPoolGroupId: null,
      affectedScopes: Array.from(affectedByKey.values()),
    };
  }

  const desiredPeerIdSet = new Set(desiredPeers.map((peer) => peer.id));
  const removedOldPeers = oldGroupMembers.filter(
    (member) => member.id !== selfProfile.id && !desiredPeerIdSet.has(member.id),
  );
  if (removedOldPeers.length > 0) {
    await tx.wmsProductProfile.updateMany({
      where: {
        tenantId: params.tenantId,
        id: { in: removedOldPeers.map((member) => member.id) },
      },
      data: { stockPoolGroupId: null },
    });
  }

  const peerGroupIds = Array.from(
    new Set(
      desiredPeers
        .map((peer) => peer.stockPoolGroupId)
        .filter((groupId): groupId is string => Boolean(groupId) && groupId !== selfProfile.stockPoolGroupId),
    ),
  ).sort();

  const transitivePeerMembers = peerGroupIds.length > 0
    ? await tx.wmsProductProfile.findMany({
        where: {
          tenantId: params.tenantId,
          stockPoolGroupId: { in: peerGroupIds },
        },
        select: {
          id: true,
          storeId: true,
          variationId: true,
        },
      })
    : [];

  for (const member of transitivePeerMembers) {
    recordAffected(member.storeId, member.variationId);
  }

  const targetGroupId = selfProfile.stockPoolGroupId ?? peerGroupIds[0] ?? randomUUID();
  const nextGroupMemberIds = Array.from(
    new Set([
      selfProfile.id,
      ...desiredPeers.map((peer) => peer.id),
      ...transitivePeerMembers.map((member) => member.id),
    ]),
  );

  await tx.wmsProductProfile.updateMany({
    where: {
      tenantId: params.tenantId,
      id: { in: nextGroupMemberIds },
    },
    data: {
      stockPoolGroupId: targetGroupId,
    },
  });

  return {
    stockPoolGroupId: targetGroupId,
    affectedScopes: Array.from(affectedByKey.values()),
  };
}

const STOCK_POOL_NOISE_WORDS = new Set([
  'oto',
  'upsell',
  'promo',
  'bundle',
  'freebie',
  'free',
  'gift',
  'cod',
  'b1t1',
  'new',
  'old',
  'v1',
  'v2',
  'bottle',
  'bottles',
  'btl',
  'btls',
  'pc',
  'pcs',
  'piece',
  'pieces',
  'pack',
  'packs',
  'box',
  'boxes',
  'sachet',
  'sachets',
  'pouch',
  'pouches',
  'tub',
  'tubs',
  'jar',
  'jars',
  'ml',
  'mg',
  'kg',
  'oz',
  'g',
  'l',
  'caps',
  'capsule',
  'capsules',
  'tablet',
  'tablets',
  'softgel',
  'softgels',
  'php',
  'only',
  'buy',
  'take',
  'save',
  'off',
  'with',
  'the',
  'and',
  'for',
]);

const STOCK_POOL_BRAND_TOKENS = new Set([
  'nourio',
  'nour',
  'tonio',
  'tonios',
  'famco',
  'cristobal',
]);

const STOCK_POOL_TOKEN_SYNONYMS: Record<string, string> = {
  nmg: 'magnesium',
  nour: 'nourio',
  tonios: 'tonio',
};

function tokenizeStockPoolIdentityText(value: string | null | undefined): string[] {
  if (!value || typeof value !== 'string') {
    return [];
  }
  const normalized = value
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) {
    return [];
  }
  const tokens: string[] = [];
  for (const rawToken of normalized.split(/\s+/)) {
    if (!rawToken) continue;
    if (/^\d+$/.test(rawToken)) continue;
    if (/^\d+(ml|g|mg|kg|oz|l|pc|pcs|btl|btls|pack|packs|caps)$/.test(rawToken)) continue;
    const mapped = STOCK_POOL_TOKEN_SYNONYMS[rawToken] ?? rawToken;
    if (STOCK_POOL_NOISE_WORDS.has(mapped)) continue;
    tokens.push(mapped);
  }
  return tokens;
}

export type StockPoolIdentityDescriptor = {
  name?: string | null;
  customId?: string | null;
  variationDisplayId?: string | null;
  mapping?: string | null;
  storeName?: string | null;
};

export function extractStockPoolBaseSku(input: StockPoolIdentityDescriptor): string | null {
  const candidates = [input.customId, input.variationDisplayId];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    const tokens = tokenizeStockPoolIdentityText(trimmed);
    if (tokens.length > 0) {
      return Array.from(new Set(tokens)).sort().join('-');
    }
  }
  return null;
}

export function resolveStockPoolProductFamilyKey(
  input: StockPoolIdentityDescriptor,
): string | null {
  const nameTokens = tokenizeStockPoolIdentityText(input.name);
  const skuTokens = [
    ...tokenizeStockPoolIdentityText(input.customId),
    ...tokenizeStockPoolIdentityText(input.variationDisplayId),
  ];
  const storeBrandTokens = new Set(tokenizeStockPoolIdentityText(input.storeName));

  const allTokens = Array.from(new Set([...nameTokens, ...skuTokens]));
  if (allTokens.includes('magnesium')) {
    return 'product:magnesium';
  }

  const nonBrandNameTokens = Array.from(
    new Set(
      nameTokens.filter(
        (token) => !STOCK_POOL_BRAND_TOKENS.has(token) && !storeBrandTokens.has(token),
      ),
    ),
  ).sort();

  if (nonBrandNameTokens.length > 0) {
    return `product:${nonBrandNameTokens.join('-')}`;
  }

  const nonBrandSkuTokens = Array.from(
    new Set(
      skuTokens.filter(
        (token) => !STOCK_POOL_BRAND_TOKENS.has(token) && !storeBrandTokens.has(token),
      ),
    ),
  ).sort();

  const brandTokensInItem = Array.from(
    new Set(
      allTokens.filter(
        (token) => STOCK_POOL_BRAND_TOKENS.has(token) || storeBrandTokens.has(token),
      ),
    ),
  ).sort();

  if (nonBrandSkuTokens.length > 0) {
    return `sku:${nonBrandSkuTokens.join('-')}`;
  }

  if (brandTokensInItem.length > 0) {
    return `brand:${brandTokensInItem.join('-')}`;
  }

  return null;
}

export function areProfilesCompatibleForStockPool(
  left: StockPoolIdentityDescriptor,
  right: StockPoolIdentityDescriptor,
): boolean {
  const leftFamily = resolveStockPoolProductFamilyKey(left);
  const rightFamily = resolveStockPoolProductFamilyKey(right);

  if (leftFamily === 'product:magnesium' || rightFamily === 'product:magnesium') {
    return leftFamily === rightFamily;
  }

  if (leftFamily && rightFamily && leftFamily === rightFamily) {
    return true;
  }

  const leftSku = extractStockPoolBaseSku(left);
  const rightSku = extractStockPoolBaseSku(right);
  if (leftSku && rightSku && leftSku === rightSku) {
    return true;
  }

  return false;
}


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

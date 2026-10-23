import { Prisma } from '@prisma/client';
import {
  creativeCodeParts,
  resolveStoreAttribution,
  StoreAttributionIndex,
  UNATTRIBUTED_STORE_KEY,
} from './store-attribution';

export type TeamAdRow = {
  teamId?: string | null;
  adId?: string | null;
  adName?: string | null;
  mapping?: string | null;
  shops?: unknown;
  date: Date;
  spend?: unknown;
  leads?: unknown;
  updatedAt?: Date | null;
};
export type AttributionStore = { id: string; shopId: string; teamId?: string | null };

/** The same exact store evidence serves Store grouping and the missing-team
 * fallback for ad spend. Conflicting hints remain Unattributed. */
export async function loadSalesStoreAttribution(
  db: any, tenantId: string, rows: TeamAdRow[], stores: AttributionStore[],
): Promise<StoreAttributionIndex> {
  const validStoreIds = new Set(stores.map(store => store.id.toLowerCase()));
  const insertUnique = (map: Map<string, string | null>, key: string, store: string | null | undefined) => {
    const value = store?.toLowerCase();
    const scoped = value && validStoreIds.has(value) ? value : null;
    if (map.has(key) && map.get(key) !== scoped) map.set(key, null);
    else map.set(key, scoped);
  };
  const storeByShopId = new Map<string, string | null>();
  for (const store of stores) insertUnique(storeByShopId, store.shopId, store.id);
  const adIds = [...new Set(rows.map(row => row.adId).filter(Boolean))];
  const codes = rows.map(row => creativeCodeParts(row.adName)).filter(Boolean);
  const uniqueCodes = [...new Set(codes.map(code => code!.code))];
  const uniquePrefixes = [...new Set(codes.map(code => code!.prefix))];
  const [links, products, creatives, configs] = await Promise.all([
    adIds.length ? db.creativeMetaAdLink.findMany({
      where: adIds.length <= 10000 ? { tenantId, adId: { in: adIds } } : { tenantId },
      select: { adId: true, creative: { select: { tenantId: true, storeConfig: { select: { tenantId: true, storeId: true } } } } },
    }) : [],
    db.posProduct.findMany({
      where: { store: { is: { tenantId, status: 'ACTIVE', OR: [{ enabled: true }, { enabled: null }] } }, mapping: { not: null } },
      select: { storeId: true, mapping: true },
    }),
    uniqueCodes.length ? db.creative.findMany({
      where: uniqueCodes.length <= 10000 ? { tenantId, code: { in: uniqueCodes } } : { tenantId },
      select: { code: true, storeConfig: { select: { tenantId: true, storeId: true } } },
    }) : [],
    uniquePrefixes.length ? db.creativeStoreConfig.findMany({
      where: uniquePrefixes.length <= 10000
        ? { tenantId, active: true, storeId: { in: [...validStoreIds] }, codePrefix: { in: uniquePrefixes } }
        : { tenantId, active: true, storeId: { in: [...validStoreIds] } },
      select: { codePrefix: true, storeId: true },
    }) : [],
  ]);
  const storeByAdId = new Map<string, string | null>();
  for (const link of links) insertUnique(storeByAdId, link.adId,
    link.creative?.tenantId === tenantId && link.creative?.storeConfig?.tenantId === tenantId
      ? link.creative.storeConfig.storeId : null);
  const storeByCreativeCode = new Map<string, string | null>();
  for (const creative of creatives) insertUnique(storeByCreativeCode, creative.code.toUpperCase(),
    creative.storeConfig?.tenantId === tenantId ? creative.storeConfig.storeId : null);
  const storeByCodePrefix = new Map<string, string | null>();
  for (const config of configs) insertUnique(storeByCodePrefix, config.codePrefix.toUpperCase(), config.storeId);
  const storeByLabel = new Map<string, string | null>();
  for (const product of products) {
    const label = product.mapping?.trim().toLowerCase();
    if (label) insertUnique(storeByLabel, label, product.storeId);
  }
  return { validStoreIds, storeByShopId, storeByAdId, storeByCreativeCode, storeByCodePrefix, storeByLabel };
}

/** Existing record team is historical authority. Only a missing record team
 * may fall back to one exact owned store. Never split unknown spend by ratio. */
export function partitionTeamAdSpend(
  rows: TeamAdRow[], stores: AttributionStore[], index: StoreAttributionIndex,
  selectedTeamIds: string[], currentStart: Date,
) {
  const storeTeams = new Map(stores.map(store => [store.id.toLowerCase(), store.teamId || null]));
  const selected = new Set(selectedTeamIds);
  const fresh = () => ({
    tenantSpend: new Prisma.Decimal(0), selectedSpend: new Prisma.Decimal(0),
    unassignedSpend: new Prisma.Decimal(0), fallbackAssignedSpend: new Prisma.Decimal(0),
    byTeam: new Map<string, Prisma.Decimal>(),
  });
  const periods = { current: fresh(), previous: fresh() };
  const resolved = rows.map(row => {
    const storeId = resolveStoreAttribution(row, index);
    const explicit = typeof row.teamId === 'string' && row.teamId.length > 0 ? row.teamId : null;
    const teamId = explicit || (storeId === UNATTRIBUTED_STORE_KEY ? null : storeTeams.get(storeId) || null);
    const included = !selected.size || (teamId !== null && selected.has(teamId));
    const period = row.date >= currentStart ? 'current' as const : 'previous' as const;
    const spend = new Prisma.Decimal(String(row.spend ?? 0));
    const stats = periods[period];
    stats.tenantSpend = stats.tenantSpend.plus(spend);
    if (included) stats.selectedSpend = stats.selectedSpend.plus(spend);
    if (teamId === null) stats.unassignedSpend = stats.unassignedSpend.plus(spend);
    else stats.byTeam.set(teamId, (stats.byTeam.get(teamId) || new Prisma.Decimal(0)).plus(spend));
    if (!explicit && teamId !== null) stats.fallbackAssignedSpend = stats.fallbackAssignedSpend.plus(spend);
    return { row, storeId, teamId, included, period };
  });
  const summarize = (stats: ReturnType<typeof fresh>) => ({
    tenantSpend: stats.tenantSpend.toNumber(), selectedSpend: stats.selectedSpend.toNumber(),
    unassignedSpend: stats.unassignedSpend.toNumber(), fallbackAssignedSpend: stats.fallbackAssignedSpend.toNumber(),
    byTeam: [...stats.byTeam.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([teamId, spend]) => ({ teamId, spend: spend.toNumber() })),
  });
  return {
    rows: resolved,
    coverage: {
      basis: 'EXPLICIT_REPORT_TEAM_THEN_EXACT_STORE_TEAM',
      currencyBasis: 'BASE_AD_SPEND_BEFORE_SELECTED_TAXES',
      current: summarize(periods.current), previous: summarize(periods.previous),
    },
  };
}

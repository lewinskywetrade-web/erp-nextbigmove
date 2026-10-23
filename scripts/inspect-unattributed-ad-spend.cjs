const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const CODE_SEGMENT_REGEX = /^[A-Z]{2,6}-[VI]\d{3,6}$/i;
function isCodeSegment(segment) {
  return CODE_SEGMENT_REGEX.test((segment || '').trim());
}
function creativeCodes(adName) {
  return [...new Set((adName || '').split('_').map(p => p.trim().toUpperCase()).filter(isCodeSegment))];
}
function creativeCodeParts(adName) {
  const codes = creativeCodes(adName);
  if (codes.length !== 1) return null;
  const code = codes[0];
  const sep = code.lastIndexOf('-');
  if (sep <= 0) return null;
  return { code, prefix: code.slice(0, sep) };
}
function parseProductMappingKey(raw) {
  if (!raw) return null;
  const m = /^pv::([0-9a-f-]{36})::(.+)$/i.exec(raw.trim());
  if (!m) return null;
  return { storeId: m[1].toLowerCase(), variationId: m[2] };
}
function parseUnassignedMappingKey(raw) {
  if (!raw) return null;
  const m = /^ua::([0-9a-f-]{36})$/i.exec(raw.trim());
  if (!m) return null;
  return { storeId: m[1].toLowerCase() };
}

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  for (const tenant of tenants) {
    const tenantId = tenant.id;
    const spendGroups = await prisma.$queryRawUnsafe(`
      SELECT
        "adId",
        "adName",
        "campaignId",
        "campaignName",
        "adsetId",
        "accountId",
        "teamId",
        "teamCode",
        mapping,
        shops::text AS "shopsJson",
        MIN(date)::text AS "minDate",
        MAX(date)::text AS "maxDate",
        COUNT(*)::int AS "days",
        SUM(spend)::float8 AS "totalSpend",
        SUM(CASE WHEN date >= '2026-10-01' AND date <= '2026-10-20' THEN spend ELSE 0 END)::float8 AS "octSpend",
        SUM(leads)::int AS "totalLeads",
        SUM("purchasesPos")::int AS "totalPurchases"
      FROM reconcile_marketing
      WHERE "tenantId" = $1::uuid
        AND (spend > 0 OR leads > 0)
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
      ORDER BY "totalSpend" DESC
    `, tenantId);

    if (spendGroups.length === 0) continue;

    const stores = await prisma.posStore.findMany({
      where: { tenantId },
      select: { id: true, shopId: true, name: true, teamId: true, status: true, enabled: true },
    });
    const activeStores = stores.filter(s => s.status === 'ACTIVE' && (s.enabled === true || s.enabled === null));
    const teams = await prisma.team.findMany({
      where: { tenantId },
      select: { id: true, name: true, teamCode: true, status: true },
    });
    const adAccounts = await prisma.metaAdAccount.findMany({
      where: { tenantId },
      select: { accountId: true, name: true, teamId: true },
    });

    console.log(`\n=== TENANT: ${tenant.name} (${tenantId}) | spendGroups=${spendGroups.length} | activeStores=${activeStores.length} ===`);
    console.log('Teams:', JSON.stringify(teams));
    console.log('AdAccounts:', JSON.stringify(adAccounts));

    const validStoreIds = new Set(activeStores.map(s => s.id.toLowerCase()));
    const storeNameById = new Map(stores.map(s => [s.id.toLowerCase(), `${s.name} (shopId=${s.shopId}, team=${s.teamId}, status=${s.status})`]));
    const insertUnique = (map, key, store) => {
      const value = store ? store.toLowerCase() : null;
      const scoped = value && validStoreIds.has(value) ? value : null;
      if (map.has(key) && map.get(key) !== scoped) map.set(key, null);
      else map.set(key, scoped);
    };

    const storeByShopId = new Map();
    for (const store of activeStores) insertUnique(storeByShopId, store.shopId, store.id);

    const [links, allProducts, creatives, configs] = await Promise.all([
      prisma.creativeMetaAdLink.findMany({
        where: { tenantId },
        select: { adId: true, creative: { select: { code: true, posCustomId: true, posVariationId: true, tenantId: true, storeConfig: { select: { tenantId: true, storeId: true } } } } },
      }),
      prisma.posProduct.findMany({
        where: { store: { is: { tenantId, status: 'ACTIVE', OR: [{ enabled: true }, { enabled: null }] } } },
        select: { id: true, storeId: true, customId: true, mapping: true, name: true, variationId: true },
      }),
      prisma.creative.findMany({
        where: { tenantId },
        select: { code: true, posCustomId: true, posVariationId: true, storeConfig: { select: { tenantId: true, storeId: true } } },
      }),
      prisma.creativeStoreConfig.findMany({
        where: { tenantId },
        select: { codePrefix: true, storeId: true, active: true },
      }),
    ]);

    console.log('CreativeStoreConfigs:', JSON.stringify(configs.map(c => ({ ...c, storeName: storeNameById.get(c.storeId.toLowerCase()) }))));
    const storesWithProductsOrConfigs = new Set([
      ...allProducts.map(p => p.storeId.toLowerCase()),
      ...configs.map(c => c.storeId.toLowerCase()),
    ]);
    console.log('RelevantStores:', JSON.stringify(
      stores.filter(s => storesWithProductsOrConfigs.has(s.id.toLowerCase()) || s.teamId).map(s => ({
        id: s.id,
        shopId: s.shopId,
        name: s.name,
        teamId: s.teamId,
        status: s.status,
        enabled: s.enabled,
      }))
    ));

    const storeByAdId = new Map();
    for (const link of links) insertUnique(storeByAdId, link.adId,
      link.creative?.tenantId === tenantId && link.creative?.storeConfig?.tenantId === tenantId
        ? link.creative.storeConfig.storeId : null);
    const storeByCreativeCode = new Map();
    for (const creative of creatives) if (creative.code) insertUnique(storeByCreativeCode, creative.code.toUpperCase(),
      creative.storeConfig?.tenantId === tenantId ? creative.storeConfig.storeId : null);
    const storeByCodePrefix = new Map();
    for (const config of configs.filter(c => c.active && c.storeId && validStoreIds.has(c.storeId.toLowerCase()))) {
      if (config.codePrefix) insertUnique(storeByCodePrefix, config.codePrefix.toUpperCase(), config.storeId);
    }
    const storeByLabel = new Map();
    const storesByCustomId = new Map();
    const storesByMappingLabel = new Map();
    const productCatalogSummary = new Map();
    for (const p of allProducts) {
      const catKey = `${p.storeId}|${p.customId || ''}|${p.mapping || ''}`;
      if (!productCatalogSummary.has(catKey)) {
        productCatalogSummary.set(catKey, {
          storeId: p.storeId,
          storeName: storeNameById.get(p.storeId.toLowerCase()),
          customId: p.customId,
          mapping: p.mapping,
          sampleName: p.name,
          sampleVariationId: p.variationId,
        });
      }
      const label = p.mapping?.trim().toLowerCase();
      if (label) {
        insertUnique(storeByLabel, label, p.storeId);
        if (!storesByMappingLabel.has(label)) storesByMappingLabel.set(label, new Set());
        storesByMappingLabel.get(label).add(p.storeId.toLowerCase());
      }
      const cid = (p.customId || '').trim().toLowerCase();
      if (cid) {
        if (!storesByCustomId.has(cid)) storesByCustomId.set(cid, new Set());
        storesByCustomId.get(cid).add(p.storeId.toLowerCase());
      }
    }
    console.log('ProductCatalogSummary:', JSON.stringify([...productCatalogSummary.values()]));

    // Sibling campaign / adset / adId mappings across all spendGroups
    const campaignSiblingsMap = new Map();
    const adsetSiblingsMap = new Map();
    const adIdSiblingsMap = new Map();
    for (const r of spendGroups) {
      let parsedShops = [];
      try { parsedShops = r.shopsJson ? JSON.parse(r.shopsJson) : []; } catch {}
      r.shops = Array.isArray(parsedShops) ? parsedShops : [];
      const hints = [];
      if (r.mapping) hints.push(`map:${r.mapping}`);
      for (const s of r.shops) hints.push(`shop:${s}`);
      if (hints.length > 0) {
        if (r.campaignId) {
          const set = campaignSiblingsMap.get(r.campaignId) || new Set();
          hints.forEach(h => set.add(h));
          campaignSiblingsMap.set(r.campaignId, set);
        }
        if (r.adsetId) {
          const set = adsetSiblingsMap.get(r.adsetId) || new Set();
          hints.forEach(h => set.add(h));
          adsetSiblingsMap.set(r.adsetId, set);
        }
        if (r.adId) {
          const set = adIdSiblingsMap.get(r.adId) || new Set();
          hints.forEach(h => set.add(h));
          adIdSiblingsMap.set(r.adId, set);
        }
      }
    }

    const storeTeams = new Map(activeStores.map(s => [s.id.toLowerCase(), s.teamId || null]));
    const unattributedList = [];
    const unassignedTeamList = [];
    const unassignedMappingList = [];

    let totalSpend = 0;
    let totalOctSpend = 0;
    let unattributedStoreSpend = 0;
    let unattributedOctStoreSpend = 0;
    let unassignedTeamSpend = 0;
    let unassignedOctTeamSpend = 0;
    let unassignedMappingSpend = 0;

    for (const row of spendGroups) {
      const spend = Number(row.totalSpend || 0);
      const octSpend = Number(row.octSpend || 0);
      totalSpend += spend;
      totalOctSpend += octSpend;

      let storeId = '__unattributed__';
      const reason = [];
      const candidates = new Set();
      let ambiguous = creativeCodes(row.adName).length > 1;
      if (ambiguous) reason.push('multiple_creative_codes');

      if (row.adId && storeByAdId.has(row.adId)) {
        const linked = storeByAdId.get(row.adId);
        storeId = linked && validStoreIds.has(linked) ? linked : '__unattributed__';
        if (storeId === '__unattributed__') reason.push('invalid_adId_link');
      } else {
        const add = (val, src) => {
          if (!val || !validStoreIds.has(val)) {
            ambiguous = true;
            reason.push(`ambiguous_or_invalid_${src}:${val}`);
          } else {
            candidates.add(val);
            reason.push(`candidate_${src}:${storeNameById.get(val) || val}`);
          }
        };
        const shops = Array.isArray(row.shops) ? row.shops : [];
        for (const raw of shops) {
          const shop = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
          if (!shop) { ambiguous = true; reason.push('empty_shop'); }
          else add(storeByShopId.get(shop), `shop(${shop})`);
        }
        const code = creativeCodeParts(row.adName);
        if (code) {
          if (storeByCreativeCode.has(code.code)) add(storeByCreativeCode.get(code.code), `creativeCode(${code.code})`);
          else reason.push(`no_creativeCode(${code.code})`);
          if (storeByCodePrefix.has(code.prefix)) add(storeByCodePrefix.get(code.prefix), `codePrefix(${code.prefix})`);
          else reason.push(`no_codePrefix(${code.prefix})`);
        } else {
          reason.push('no_creative_code_in_adName');
        }
        const mapping = typeof row.mapping === 'string' ? row.mapping : null;
        const precise = parseProductMappingKey(mapping) ?? parseUnassignedMappingKey(mapping);
        if (precise) add(precise.storeId, `preciseMapping(${mapping})`);
        else {
          const label = mapping?.trim().toLowerCase();
          if (label) {
            if (storeByLabel.has(label)) add(storeByLabel.get(label), `label(${label})`);
            else reason.push(`label_not_in_posProduct.mapping(${label})`);
          } else {
            reason.push('null_mapping');
          }
        }
        if (!ambiguous && candidates.size === 1) {
          storeId = [...candidates][0];
        }
      }

      const explicitTeam = typeof row.teamId === 'string' && row.teamId.length > 0 ? row.teamId : null;
      const teamId = explicitTeam || (storeId === '__unattributed__' ? null : storeTeams.get(storeId) || null);

      if (storeId === '__unattributed__' && (spend > 0 || row.totalLeads > 0)) {
        unattributedStoreSpend += spend;
        unattributedOctStoreSpend += octSpend;
        unattributedList.push({
          adId: row.adId,
          adName: row.adName,
          campaignId: row.campaignId,
          campaignName: row.campaignName,
          adsetId: row.adsetId,
          accountId: row.accountId,
          teamId: row.teamId,
          teamCode: row.teamCode,
          mapping: row.mapping,
          shops: row.shops,
          minDate: row.minDate,
          maxDate: row.maxDate,
          days: row.days,
          totalSpend: Number(spend.toFixed(2)),
          octSpend: Number(octSpend.toFixed(2)),
          totalLeads: row.totalLeads,
          totalPurchases: row.totalPurchases,
          reasons: reason,
          customIdStores: row.mapping ? [...(storesByCustomId.get(row.mapping.trim().toLowerCase()) || [])].map(id => `${id}:${storeNameById.get(id)}`) : [],
          mappingLabelStores: row.mapping ? [...(storesByMappingLabel.get(row.mapping.trim().toLowerCase()) || [])].map(id => `${id}:${storeNameById.get(id)}`) : [],
          adIdSiblings: row.adId ? [...(adIdSiblingsMap.get(row.adId) || [])] : [],
          adsetSiblings: row.adsetId ? [...(adsetSiblingsMap.get(row.adsetId) || [])] : [],
          campaignSiblings: row.campaignId ? [...(campaignSiblingsMap.get(row.campaignId) || [])] : [],
        });
      }

      if (!teamId && (spend > 0 || row.totalLeads > 0)) {
        unassignedTeamSpend += spend;
        unassignedOctTeamSpend += octSpend;
        unassignedTeamList.push({
          adId: row.adId,
          adName: row.adName,
          campaignName: row.campaignName,
          accountId: row.accountId,
          mapping: row.mapping,
          shops: row.shops,
          storeId,
          minDate: row.minDate,
          maxDate: row.maxDate,
          days: row.days,
          totalSpend: Number(spend.toFixed(2)),
          octSpend: Number(octSpend.toFixed(2)),
        });
      }

      if ((!row.mapping || row.mapping.startsWith('ua::')) && spend > 0) {
        unassignedMappingSpend += spend;
        unassignedMappingList.push({
          adId: row.adId,
          adName: row.adName,
          campaignName: row.campaignName,
          accountId: row.accountId,
          mapping: row.mapping,
          shops: row.shops,
          storeId,
          minDate: row.minDate,
          maxDate: row.maxDate,
          days: row.days,
          totalSpend: Number(spend.toFixed(2)),
          octSpend: Number(octSpend.toFixed(2)),
          adIdSiblings: row.adId ? [...(adIdSiblingsMap.get(row.adId) || [])] : [],
          adsetSiblings: row.adsetId ? [...(adsetSiblingsMap.get(row.adsetId) || [])] : [],
          campaignSiblings: row.campaignId ? [...(campaignSiblingsMap.get(row.campaignId) || [])] : [],
        });
      }
    }

    console.log('SUMMARY:', JSON.stringify({
      totalSpend: totalSpend.toFixed(2),
      totalOctSpend: totalOctSpend.toFixed(2),
      unattributedStoreSpend: unattributedStoreSpend.toFixed(2),
      unattributedOctStoreSpend: unattributedOctStoreSpend.toFixed(2),
      unattributedStoreGroups: unattributedList.length,
      unassignedTeamSpend: unassignedTeamSpend.toFixed(2),
      unassignedOctTeamSpend: unassignedOctTeamSpend.toFixed(2),
      unassignedTeamGroups: unassignedTeamList.length,
      unassignedMappingSpend: unassignedMappingSpend.toFixed(2),
      unassignedMappingGroups: unassignedMappingList.length,
    }));

    console.log(`ALL UNATTRIBUTED STORE AD GROUPS (${unattributedList.length}):`);
    for (const item of unattributedList) {
      console.log('UNATTR_STORE_AD:', JSON.stringify(item));
    }

    console.log(`ALL UNASSIGNED TEAM AD GROUPS (${unassignedTeamList.length}):`);
    for (const item of unassignedTeamList) {
      console.log('UNASSIGNED_TEAM_AD:', JSON.stringify(item));
    }

    console.log(`TOP UNASSIGNED MAPPING AD GROUPS (${unassignedMappingList.length}):`);
    for (const item of unassignedMappingList.slice(0, 150)) {
      console.log('UNASSIGNED_MAPPING_AD:', JSON.stringify(item));
    }
  }
}

main()
  .catch(e => { console.error('SCRIPT_ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());

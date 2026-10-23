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

    const spendRows = await prisma.reconcileMarketing.findMany({
      where: {
        tenantId,
        OR: [{ spend: { gt: 0 } }, { leads: { gt: 0 } }],
      },
      select: {
        id: true,
        date: true,
        adId: true,
        adName: true,
        campaignId: true,
        campaignName: true,
        adsetId: true,
        accountId: true,
        teamId: true,
        teamCode: true,
        mapping: true,
        shops: true,
        spend: true,
        leads: true,
        purchasesPos: true,
        codPos: true,
      },
      orderBy: { date: 'desc' },
    });

    if (spendRows.length === 0) continue;

    console.log(`\n=== TENANT: ${tenant.name} (${tenantId}) | spendRows=${spendRows.length} | activeStores=${activeStores.length} ===`);
    console.log('ActiveStores:', JSON.stringify(activeStores));
    console.log('Teams:', JSON.stringify(teams));
    console.log('AdAccounts:', JSON.stringify(adAccounts));

    const validStoreIds = new Set(activeStores.map(s => s.id.toLowerCase()));
    const storeNameById = new Map(stores.map(s => [s.id.toLowerCase(), `${s.name} (${s.status})`]));
    const insertUnique = (map, key, store) => {
      const value = store ? store.toLowerCase() : null;
      const scoped = value && validStoreIds.has(value) ? value : null;
      if (map.has(key) && map.get(key) !== scoped) map.set(key, null);
      else map.set(key, scoped);
    };

    const storeByShopId = new Map();
    for (const store of activeStores) insertUnique(storeByShopId, store.shopId, store.id);

    const adIds = [...new Set(spendRows.map(r => r.adId).filter(Boolean))];
    const codes = spendRows.map(r => creativeCodeParts(r.adName)).filter(Boolean);

    const [links, products, allProductsWithCustomId, creatives, configs] = await Promise.all([
      adIds.length ? prisma.creativeMetaAdLink.findMany({
        where: { tenantId, adId: { in: adIds } },
        select: { adId: true, creative: { select: { code: true, posCustomId: true, posVariationId: true, tenantId: true, storeConfig: { select: { tenantId: true, storeId: true } } } } },
      }) : [],
      prisma.posProduct.findMany({
        where: { store: { is: { tenantId, status: 'ACTIVE', OR: [{ enabled: true }, { enabled: null }] } }, mapping: { not: null } },
        select: { storeId: true, mapping: true },
      }),
      prisma.posProduct.findMany({
        where: { store: { is: { tenantId, status: 'ACTIVE', OR: [{ enabled: true }, { enabled: null }] } } },
        select: { id: true, storeId: true, customId: true, mapping: true, name: true, variationId: true },
      }),
      codes.length ? prisma.creative.findMany({
        where: { tenantId, code: { in: [...new Set(codes.map(c => c.code))] } },
        select: { code: true, posCustomId: true, posVariationId: true, storeConfig: { select: { tenantId: true, storeId: true } } },
      }) : [],
       prisma.creativeStoreConfig.findMany({
        where: { tenantId },
        select: { codePrefix: true, storeId: true, active: true },
      }),
    ]);

    console.log('CreativeStoreConfigs:', JSON.stringify(configs.map(c => ({ ...c, storeName: storeNameById.get(c.storeId.toLowerCase()) }))));
    console.log('AllProducts:', JSON.stringify(allProductsWithCustomId.map(p => ({
      storeId: p.storeId,
      storeName: storeNameById.get(p.storeId.toLowerCase()),
      customId: p.customId,
      mapping: p.mapping,
      name: p.name,
      variationId: p.variationId,
    }))));

    // Also index sibling ads by campaignId and adsetId across all reconcile_marketing rows
    const campaignMappings = new Map();
    const adsetMappings = new Map();
    for (const r of spendRows) {
      if (r.campaignId && (r.mapping || (Array.isArray(r.shops) && r.shops.length > 0))) {
        const set = campaignMappings.get(r.campaignId) || new Set();
        if (r.mapping) set.add(`map:${r.mapping}`);
        if (Array.isArray(r.shops)) r.shops.forEach(s => set.add(`shop:${s}`));
        campaignMappings.set(r.campaignId, set);
      }
      if (r.adsetId && (r.mapping || (Array.isArray(r.shops) && r.shops.length > 0))) {
        const set = adsetMappings.get(r.adsetId) || new Set();
        if (r.mapping) set.add(`map:${r.mapping}`);
        if (Array.isArray(r.shops)) r.shops.forEach(s => set.add(`shop:${s}`));
        adsetMappings.set(r.adsetId, set);
      }
    }

    const storeByAdId = new Map();
    for (const link of links) insertUnique(storeByAdId, link.adId,
      link.creative?.tenantId === tenantId && link.creative?.storeConfig?.tenantId === tenantId
        ? link.creative.storeConfig.storeId : null);
    const storeByCreativeCode = new Map();
    for (const creative of creatives) insertUnique(storeByCreativeCode, creative.code.toUpperCase(),
      creative.storeConfig?.tenantId === tenantId ? creative.storeConfig.storeId : null);
    const storeByCodePrefix = new Map();
    for (const config of configs.filter(c => c.active && validStoreIds.has(c.storeId.toLowerCase()))) {
      insertUnique(storeByCodePrefix, config.codePrefix.toUpperCase(), config.storeId);
    }
    const storeByLabel = new Map();
    for (const product of products) {
      const label = product.mapping?.trim().toLowerCase();
      if (label) insertUnique(storeByLabel, label, product.storeId);
    }

    // Also build helper maps for diagnosis:
    // 1. stores by customId
    const storesByCustomId = new Map();
    const storesByMappingLabel = new Map();
    for (const p of allProductsWithCustomId) {
      const cid = (p.customId || '').trim().toLowerCase();
      if (cid) {
        if (!storesByCustomId.has(cid)) storesByCustomId.set(cid, new Set());
        storesByCustomId.get(cid).add(p.storeId.toLowerCase());
      }
      const mp = (p.mapping || '').trim().toLowerCase();
      if (mp) {
        if (!storesByMappingLabel.has(mp)) storesByMappingLabel.set(mp, new Set());
        storesByMappingLabel.get(mp).add(p.storeId.toLowerCase());
      }
    }

    // Diagnose every row using current resolveStoreAttribution
    const storeTeams = new Map(activeStores.map(s => [s.id.toLowerCase(), s.teamId || null]));
    const unattributedGroups = new Map();
    const unassignedMappingGroups = new Map();
    const unassignedTeamGroups = new Map();

    let totalSpend = 0;
    let unattributedStoreSpend = 0;
    let unassignedTeamSpend = 0;
    let unassignedMappingSpend = 0;

    for (const row of spendRows) {
      const spend = Number(row.spend || 0);
      totalSpend += spend;

      // Exact reproduction of resolveStoreAttribution:
      let storeId = '__unattributed__';
      let reason = [];
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
      const dateStr = row.date.toISOString().slice(0, 10);

      if (storeId === '__unattributed__') {
        unattributedStoreSpend += spend;
        const gKey = `${row.adId}|${row.adName}|${row.campaignName}|${row.mapping}|${JSON.stringify(row.shops)}`;
        const g = unattributedGroups.get(gKey) || {
          adId: row.adId,
          adName: row.adName,
          campaignId: row.campaignId,
          campaignName: row.campaignName,
          accountId: row.accountId,
          teamId: row.teamId,
          teamCode: row.teamCode,
          mapping: row.mapping,
          shops: row.shops,
          minDate: dateStr,
          maxDate: dateStr,
          days: 0,
          totalSpend: 0,
          totalLeads: 0,
          totalPurchases: 0,
          reasons: reason,
          customIdStores: row.mapping ? [...(storesByCustomId.get(row.mapping.trim().toLowerCase()) || [])].map(id => `${id}:${storeNameById.get(id)}`) : [],
          mappingLabelStores: row.mapping ? [...(storesByMappingLabel.get(row.mapping.trim().toLowerCase()) || [])].map(id => `${id}:${storeNameById.get(id)}`) : [],
          campaignSiblings: row.campaignId ? [...(campaignMappings.get(row.campaignId) || [])] : [],
          adsetSiblings: row.adsetId ? [...(adsetMappings.get(row.adsetId) || [])] : [],
        };
        if (dateStr < g.minDate) g.minDate = dateStr;
        if (dateStr > g.maxDate) g.maxDate = dateStr;
        g.days += 1;
        g.totalSpend += spend;
        g.totalLeads += Number(row.leads || 0);
        g.totalPurchases += Number(row.purchasesPos || 0);
        unattributedGroups.set(gKey, g);
      }

      if (!teamId) {
        unassignedTeamSpend += spend;
        const gKey = `${row.adId}|${row.adName}|${row.campaignName}|${row.accountId}`;
        const g = unassignedTeamGroups.get(gKey) || {
          adId: row.adId,
          adName: row.adName,
          campaignName: row.campaignName,
          accountId: row.accountId,
          mapping: row.mapping,
          storeId,
          minDate: dateStr,
          maxDate: dateStr,
          days: 0,
          totalSpend: 0,
        };
        if (dateStr < g.minDate) g.minDate = dateStr;
        if (dateStr > g.maxDate) g.maxDate = dateStr;
        g.days += 1;
        g.totalSpend += spend;
        unassignedTeamGroups.set(gKey, g);
      }

      if (!row.mapping || row.mapping.startsWith('ua::')) {
        unassignedMappingSpend += spend;
        const gKey = `${row.adId}|${row.adName}|${row.campaignName}|${row.mapping}`;
        const g = unassignedMappingGroups.get(gKey) || {
          adId: row.adId,
          adName: row.adName,
          campaignName: row.campaignName,
          accountId: row.accountId,
          mapping: row.mapping,
          shops: row.shops,
          storeId,
          minDate: dateStr,
          maxDate: dateStr,
          days: 0,
          totalSpend: 0,
        };
        if (dateStr < g.minDate) g.minDate = dateStr;
        if (dateStr > g.maxDate) g.maxDate = dateStr;
        g.days += 1;
        g.totalSpend += spend;
        unassignedMappingGroups.set(gKey, g);
      }
    }

    console.log('SUMMARY:', JSON.stringify({
      totalSpend: totalSpend.toFixed(2),
      unattributedStoreSpend: unattributedStoreSpend.toFixed(2),
      unattributedStoreDistinctAds: unattributedGroups.size,
      unassignedTeamSpend: unassignedTeamSpend.toFixed(2),
      unassignedTeamDistinctAds: unassignedTeamGroups.size,
      unassignedMappingSpend: unassignedMappingSpend.toFixed(2),
      unassignedMappingDistinctAds: unassignedMappingGroups.size,
    }));

    const sortedUnattributed = [...unattributedGroups.values()].sort((a, b) => b.totalSpend - a.totalSpend);
    console.log(`TOP UNATTRIBUTED STORE ADS (${sortedUnattributed.length} total):`);
    for (const item of sortedUnattributed.slice(0, 150)) {
      console.log('UNATTR_STORE_AD:', JSON.stringify({ ...item, totalSpend: Number(item.totalSpend.toFixed(2)) }));
    }

    const sortedUnassignedTeam = [...unassignedTeamGroups.values()].sort((a, b) => b.totalSpend - a.totalSpend);
    console.log(`TOP UNASSIGNED TEAM ADS (${sortedUnassignedTeam.length} total):`);
    for (const item of sortedUnassignedTeam.slice(0, 100)) {
      console.log('UNASSIGNED_TEAM_AD:', JSON.stringify({ ...item, totalSpend: Number(item.totalSpend.toFixed(2)) }));
    }

    const sortedUnassignedMapping = [...unassignedMappingGroups.values()].sort((a, b) => b.totalSpend - a.totalSpend);
    console.log(`TOP UNASSIGNED MAPPING ADS (${sortedUnassignedMapping.length} total):`);
    for (const item of sortedUnassignedMapping.slice(0, 100)) {
      console.log('UNASSIGNED_MAPPING_AD:', JSON.stringify({ ...item, totalSpend: Number(item.totalSpend.toFixed(2)) }));
    }
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

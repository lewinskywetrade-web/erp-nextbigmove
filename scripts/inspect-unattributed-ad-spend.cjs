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
function normKey(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
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
        SUM(CASE WHEN date >= '2026-10-01' THEN spend ELSE 0 END)::float8 AS "octSpend",
        SUM(leads)::int AS "totalLeads",
        SUM("purchasesPos")::int AS "totalPurchases"
      FROM reconcile_marketing
      WHERE "tenantId" = $1::uuid
        AND (spend > 0 OR leads > 0)
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
      ORDER BY "totalSpend" DESC
    `, tenantId);

    if (spendGroups.length === 0) continue;

    const [stores, teams, links, allProducts, creatives, configs] = await Promise.all([
      prisma.posStore.findMany({
        where: { tenantId },
        select: { id: true, shopId: true, name: true, teamId: true, status: true, enabled: true },
      }),
      prisma.team.findMany({
        where: { tenantId },
        select: { id: true, name: true, teamCode: true, status: true },
      }),
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

    const activeStores = stores.filter(s => s.status === 'ACTIVE' && (s.enabled === true || s.enabled === null));
    const validStoreIds = new Set(activeStores.map(s => s.id.toLowerCase()));
    const storeById = new Map(activeStores.map(s => [s.id.toLowerCase(), s]));
    const storeNameById = new Map(stores.map(s => [s.id.toLowerCase(), `${s.name} (shop=${s.shopId}, team=${s.teamId})`]));

    // Team resolution helper from row.teamId / row.teamCode / campaignName / adName
    const teamIdByNorm = new Map();
    for (const t of teams) {
      teamIdByNorm.set(t.id.toLowerCase(), t.id);
      if (t.name) teamIdByNorm.set(normKey(t.name), t.id);
      if (t.teamCode) teamIdByNorm.set(normKey(t.teamCode), t.id);
    }
    function inferRowTeamId(row) {
      if (row.teamId && teamIdByNorm.has(row.teamId.toLowerCase())) return teamIdByNorm.get(row.teamId.toLowerCase());
      if (row.teamCode && teamIdByNorm.has(normKey(row.teamCode))) return teamIdByNorm.get(normKey(row.teamCode));
      const text = `${row.adName || ''} ${row.campaignName || ''}`.toLowerCase();
      if (text.includes('team1') || text.includes('team 1') || text.includes('wetrade')) return teamIdByNorm.get('wetrade') || null;
      if (text.includes('team2') || text.includes('team 2') || text.includes('zenith')) return teamIdByNorm.get('zenith') || null;
      return null;
    }

    const storeByShopId = new Map();
    const storesByNormName = new Map();
    for (const s of activeStores) {
      const sid = s.id.toLowerCase();
      if (s.shopId) storeByShopId.set(String(s.shopId).trim(), sid);
      const nk = normKey(s.name);
      if (nk) {
        if (!storesByNormName.has(nk)) storesByNormName.set(nk, new Set());
        storesByNormName.get(nk).add(sid);
      }
    }

    const storeByAdId = new Map();
    for (const link of links) {
      const sid = link.creative?.tenantId === tenantId && link.creative?.storeConfig?.tenantId === tenantId
        ? link.creative.storeConfig.storeId?.toLowerCase() : null;
      if (sid && validStoreIds.has(sid)) storeByAdId.set(link.adId, sid);
    }

    const storeByCreativeCode = new Map();
    for (const c of creatives) {
      const sid = c.storeConfig?.tenantId === tenantId ? c.storeConfig.storeId?.toLowerCase() : null;
      if (c.code && sid && validStoreIds.has(sid)) storeByCreativeCode.set(c.code.toUpperCase(), sid);
    }

    const storeByCodePrefix = new Map();
    for (const cfg of configs) {
      const sid = cfg.storeId?.toLowerCase();
      if (cfg.active && cfg.codePrefix && sid && validStoreIds.has(sid)) {
        storeByCodePrefix.set(cfg.codePrefix.toUpperCase(), sid);
      }
    }

    const storesByLabel = new Map();
    const storesByCustomId = new Map();
    const storesByProductName = new Map();
    for (const p of allProducts) {
      const sid = p.storeId.toLowerCase();
      if (!validStoreIds.has(sid)) continue;
      for (const raw of [p.mapping, normKey(p.mapping)]) {
        const k = (raw || '').trim().toLowerCase();
        if (k) {
          if (!storesByLabel.has(k)) storesByLabel.set(k, new Set());
          storesByLabel.get(k).add(sid);
        }
      }
      for (const raw of [p.customId, normKey(p.customId)]) {
        const k = (raw || '').trim().toLowerCase();
        if (k) {
          if (!storesByCustomId.has(k)) storesByCustomId.set(k, new Set());
          storesByCustomId.get(k).add(sid);
        }
      }
      const pk = normKey(p.name);
      if (pk) {
        if (!storesByProductName.has(pk)) storesByProductName.set(pk, new Set());
        storesByProductName.get(pk).add(sid);
      }
    }

    function pickCandidateSet(set, rowTeamId) {
      if (!set || set.size === 0) return null;
      if (set.size === 1) return [...set][0];
      if (rowTeamId) {
        const teamFiltered = [...set].filter(sid => storeById.get(sid)?.teamId === rowTeamId);
        if (teamFiltered.length === 1) return teamFiltered[0];
      }
      return null;
    }

    // Parse shopsJson
    for (const r of spendGroups) {
      try { r.shops = r.shopsJson ? JSON.parse(r.shopsJson) : []; } catch { r.shops = []; }
      if (!Array.isArray(r.shops)) r.shops = [];
      r.inferredTeamId = inferRowTeamId(r);
    }

    // Pass 1: Direct store resolution on each group (Tier 1 + Tier 3 direct)
    const adIdStores = new Map();
    const adsetStores = new Map();
    const campaignStores = new Map();
    const accountStores = new Map();
    const accountTeams = new Map();

    function resolveDirect(row) {
      // 1a. AdId link
      if (row.adId && storeByAdId.has(row.adId)) return { storeId: storeByAdId.get(row.adId), tier: '1a_adIdLink' };
      // 1b. Precise mapping key (pv:: or ua::)
      const precise = parseProductMappingKey(row.mapping) ?? parseUnassignedMappingKey(row.mapping);
      if (precise && validStoreIds.has(precise.storeId)) return { storeId: precise.storeId, tier: '1b_preciseMapping' };
      // 1c. Shops array on row
      const shopStores = new Set();
      for (const raw of row.shops) {
        const sid = storeByShopId.get(String(raw).trim());
        if (sid) shopStores.add(sid);
      }
      const fromShop = pickCandidateSet(shopStores, row.inferredTeamId);
      if (fromShop) return { storeId: fromShop, tier: '1c_rowShops' };
      // 1d. Creative code / prefix
      const code = creativeCodeParts(row.adName);
      if (code) {
        if (storeByCreativeCode.has(code.code)) return { storeId: storeByCreativeCode.get(code.code), tier: '1d_creativeCode' };
        if (storeByCodePrefix.has(code.prefix)) return { storeId: storeByCodePrefix.get(code.prefix), tier: '1e_codePrefix' };
      }
      // 1f. Multiple creative codes? Check if all codes point to same prefix/store
      const allCodes = creativeCodes(row.adName);
      if (allCodes.length > 1) {
        const codeStores = new Set();
        for (const c of allCodes) {
          if (storeByCreativeCode.has(c)) codeStores.add(storeByCreativeCode.get(c));
          const sep = c.lastIndexOf('-');
          if (sep > 0 && storeByCodePrefix.has(c.slice(0, sep))) codeStores.add(storeByCodePrefix.get(c.slice(0, sep)));
        }
        const fromMultiCode = pickCandidateSet(codeStores, row.inferredTeamId);
        if (fromMultiCode) return { storeId: fromMultiCode, tier: '1f_multiCodeSameStore' };
      }
      // 3a. Mapping label -> posProduct.mapping / customId / storeName / productName
      if (row.mapping) {
        const rawMap = row.mapping.trim().toLowerCase();
        const nkMap = normKey(row.mapping);
        const byLabel = pickCandidateSet(storesByLabel.get(rawMap) || storesByLabel.get(nkMap), row.inferredTeamId);
        if (byLabel) return { storeId: byLabel, tier: '3a_productMapping' };
        const byCid = pickCandidateSet(storesByCustomId.get(rawMap) || storesByCustomId.get(nkMap), row.inferredTeamId);
        if (byCid) return { storeId: byCid, tier: '3b_productCustomId' };
        const byStoreName = pickCandidateSet(storesByNormName.get(nkMap), row.inferredTeamId);
        if (byStoreName) return { storeId: byStoreName, tier: '3c_mappingIsStoreName' };
        const byProdName = pickCandidateSet(storesByProductName.get(nkMap), row.inferredTeamId);
        if (byProdName) return { storeId: byProdName, tier: '3d_mappingIsProductName' };
      }
      return null;
    }

    for (const row of spendGroups) {
      const direct = resolveDirect(row);
      if (direct) {
        row.resolvedStoreId = direct.storeId;
        row.resolvedTier = direct.tier;
        if (row.adId) {
          if (!adIdStores.has(row.adId)) adIdStores.set(row.adId, new Set());
          adIdStores.get(row.adId).add(direct.storeId);
        }
        if (row.adsetId) {
          if (!adsetStores.has(row.adsetId)) adsetStores.set(row.adsetId, new Set());
          adsetStores.get(row.adsetId).add(direct.storeId);
        }
        if (row.campaignId) {
          if (!campaignStores.has(row.campaignId)) campaignStores.set(row.campaignId, new Set());
          campaignStores.get(row.campaignId).add(direct.storeId);
        }
        if (row.accountId) {
          if (!accountStores.has(row.accountId)) accountStores.set(row.accountId, new Set());
          accountStores.get(row.accountId).add(direct.storeId);
        }
      }
      const effTeam = row.inferredTeamId || (row.resolvedStoreId ? storeById.get(row.resolvedStoreId)?.teamId : null);
      if (effTeam && row.accountId) {
        if (!accountTeams.has(row.accountId)) accountTeams.set(row.accountId, new Set());
        accountTeams.get(row.accountId).add(effTeam);
      }
    }

    // Pass 2: Sibling & CampaignName / AdName substring resolution
    // Pre-build store normNames >= 4 chars sorted longest first
    const storeNormEntries = [...storesByNormName.entries()]
      .filter(([nk]) => nk.length >= 4)
      .sort((a, b) => b[0].length - a[0].length);

    for (const row of spendGroups) {
      if (row.resolvedStoreId) continue;
      // 2a. Sibling adId
      const fromAdId = pickCandidateSet(adIdStores.get(row.adId), row.inferredTeamId);
      if (fromAdId) { row.resolvedStoreId = fromAdId; row.resolvedTier = '2a_siblingAdId'; continue; }
      // 2b. Sibling adsetId
      const fromAdset = pickCandidateSet(adsetStores.get(row.adsetId), row.inferredTeamId);
      if (fromAdset) { row.resolvedStoreId = fromAdset; row.resolvedTier = '2b_siblingAdsetId'; continue; }
      // 2c. Sibling campaignId
      const fromCamp = pickCandidateSet(campaignStores.get(row.campaignId), row.inferredTeamId);
      if (fromCamp) { row.resolvedStoreId = fromCamp; row.resolvedTier = '2c_siblingCampaignId'; continue; }
      // 3e. CampaignName / AdName segments matching storeName or product mapping/customId
      const segments = [
        ...(row.campaignName || '').split(/[_|\-]+/),
        ...(row.adName || '').split(/[_|\-]+/),
      ].map(s => normKey(s)).filter(Boolean);
      for (const seg of segments) {
        const sMatch = pickCandidateSet(storesByNormName.get(seg), row.inferredTeamId);
        if (sMatch) { row.resolvedStoreId = sMatch; row.resolvedTier = '3e_segmentStoreName'; break; }
        const lMatch = pickCandidateSet(storesByLabel.get(seg), row.inferredTeamId);
        if (lMatch) { row.resolvedStoreId = lMatch; row.resolvedTier = '3f_segmentProductMapping'; break; }
        const cMatch = pickCandidateSet(storesByCustomId.get(seg), row.inferredTeamId);
        if (cMatch) { row.resolvedStoreId = cMatch; row.resolvedTier = '3g_segmentCustomId'; break; }
      }
      if (row.resolvedStoreId) continue;
      // 3h. Substring match of storeName inside normalized campaignName + adName
      const fullNorm = normKey(`${row.campaignName || ''} ${row.adName || ''}`);
      for (const [nk, set] of storeNormEntries) {
        if (fullNorm.includes(nk)) {
          const subMatch = pickCandidateSet(set, row.inferredTeamId);
          if (subMatch) { row.resolvedStoreId = subMatch; row.resolvedTier = `3h_substringStore(${nk})`; break; }
        }
      }
      if (row.resolvedStoreId) continue;
      // 4a. AccountId single-store fallback
      const fromAcct = pickCandidateSet(accountStores.get(row.accountId), row.inferredTeamId);
      if (fromAcct) { row.resolvedStoreId = fromAcct; row.resolvedTier = '4a_accountIdSingleStore'; continue; }
    }

    // Summarize by tier
    const tierStats = {};
    const stillUnattributed = [];
    const octUnattributedCurrent = [];
    let stillUnassignedTeamSpend = 0;
    const stillUnassignedTeam = [];

    for (const row of spendGroups) {
      const tier = row.resolvedTier || 'UNRESOLVED';
      if (!tierStats[tier]) tierStats[tier] = { groups: 0, spend: 0, octSpend: 0 };
      tierStats[tier].groups += 1;
      tierStats[tier].spend += Number(row.totalSpend || 0);
      tierStats[tier].octSpend += Number(row.octSpend || 0);

      const storeTeam = row.resolvedStoreId ? storeById.get(row.resolvedStoreId)?.teamId : null;
      const acctTeamSet = accountTeams.get(row.accountId);
      const acctTeam = acctTeamSet && acctTeamSet.size === 1 ? [...acctTeamSet][0] : null;
      const finalTeamId = row.inferredTeamId || storeTeam || acctTeam || null;

      if (!row.resolvedStoreId) {
        stillUnattributed.push({
          adId: row.adId,
          adName: row.adName,
          campaignName: row.campaignName,
          accountId: row.accountId,
          teamId: row.teamId,
          teamCode: row.teamCode,
          finalTeamId,
          mapping: row.mapping,
          shops: row.shops,
          minDate: row.minDate,
          maxDate: row.maxDate,
          days: row.days,
          totalSpend: Number(row.totalSpend.toFixed(2)),
          octSpend: Number(row.octSpend.toFixed(2)),
          totalLeads: row.totalLeads,
        });
      }

      if (!finalTeamId) {
        stillUnassignedTeamSpend += Number(row.totalSpend || 0);
        stillUnassignedTeam.push({
          adId: row.adId,
          adName: row.adName,
          campaignName: row.campaignName,
          accountId: row.accountId,
          mapping: row.mapping,
          resolvedStoreId: row.resolvedStoreId,
          totalSpend: Number(row.totalSpend.toFixed(2)),
          octSpend: Number(row.octSpend.toFixed(2)),
        });
      }

      if (row.octSpend > 0 && row.resolvedTier !== '1a_adIdLink' && row.resolvedTier !== '1b_preciseMapping' && row.resolvedTier !== '1d_creativeCode' && row.resolvedTier !== '1e_codePrefix') {
        octUnattributedCurrent.push({
          adId: row.adId,
          adName: row.adName,
          campaignName: row.campaignName,
          mapping: row.mapping,
          shops: row.shops,
          octSpend: Number(row.octSpend.toFixed(2)),
          resolvedTier: row.resolvedTier || 'UNRESOLVED',
          resolvedStore: row.resolvedStoreId ? storeNameById.get(row.resolvedStoreId) : null,
        });
      }
    }

    console.log('TIER_STATS:', JSON.stringify(tierStats));
    console.log(`STILL_UNATTRIBUTED_COUNT=${stillUnattributed.length} | STILL_UNASSIGNED_TEAM_COUNT=${stillUnassignedTeam.length} (spend=${stillUnassignedTeamSpend.toFixed(2)})`);
    console.log(`OCT_SPECIAL_ADS (${octUnattributedCurrent.length}):`);
    for (const item of octUnattributedCurrent) {
      console.log('OCT_AD:', JSON.stringify(item));
    }

    // Group stillUnattributed by (mapping || campaignName || adName) + accountId + finalTeamId
    const unattrPatterns = new Map();
    for (const item of stillUnattributed) {
      const pKey = `${item.mapping || ''}|${item.campaignName || ''}|${item.accountId || ''}|${item.finalTeamId || ''}`;
      const existing = unattrPatterns.get(pKey) || {
        mapping: item.mapping,
        campaignName: item.campaignName,
        sampleAdName: item.adName,
        sampleAdId: item.adId,
        accountId: item.accountId,
        teamCode: item.teamCode,
        finalTeamId: item.finalTeamId,
        minDate: item.minDate,
        maxDate: item.maxDate,
        adCount: 0,
        totalSpend: 0,
        octSpend: 0,
        totalLeads: 0,
      };
      if (item.minDate < existing.minDate) existing.minDate = item.minDate;
      if (item.maxDate > existing.maxDate) existing.maxDate = item.maxDate;
      existing.adCount += 1;
      existing.totalSpend += item.totalSpend;
      existing.octSpend += item.octSpend;
      existing.totalLeads += item.totalLeads;
      unattrPatterns.set(pKey, existing);
    }
    const sortedPatterns = [...unattrPatterns.values()].sort((a, b) => b.totalSpend - a.totalSpend);
    console.log(`STILL_UNATTRIBUTED_PATTERNS (${sortedPatterns.length}):`);
    for (const pat of sortedPatterns) {
      console.log('UNATTR_PAT:', JSON.stringify({ ...pat, totalSpend: Number(pat.totalSpend.toFixed(2)), octSpend: Number(pat.octSpend.toFixed(2)) }));
    }

    // Also check if any inactive/disabled stores exist in pos_stores
    const inactiveStores = stores.filter(s => !(s.status === 'ACTIVE' && (s.enabled === true || s.enabled === null)));
    console.log(`INACTIVE_STORES (${inactiveStores.length}):`, JSON.stringify(inactiveStores));
  }
  await new Promise(r => setTimeout(r, 2000));
}

main()
  .catch(e => { console.error('SCRIPT_ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function normKey(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, slug: true } });
  console.log('ALL_TENANTS:', JSON.stringify(tenants));

  for (const tenant of tenants) {
    const tenantId = tenant.id;
    const stores = await prisma.posStore.findMany({
      where: { tenantId },
      select: { id: true, shopId: true, name: true, teamId: true, status: true, enabled: true },
    });
    const products = await prisma.posProduct.findMany({
      where: { store: { is: { tenantId } } },
      select: { storeId: true, customId: true, mapping: true, name: true },
    });
    const configs = await prisma.creativeStoreConfig.findMany({
      where: { tenantId },
      select: { codePrefix: true, storeId: true, active: true },
    });
    const orderCounts = await prisma.$queryRawUnsafe(`
      SELECT "storeId", COUNT(*)::int AS cnt
      FROM pos_orders
      WHERE "tenantId" = $1::uuid
      GROUP BY "storeId"
    `, tenantId);
    const orderCountByStore = new Map(orderCounts.map(r => [r.storeId.toLowerCase(), r.cnt]));
    const prodCountByStore = new Map();
    for (const p of products) {
      const sid = p.storeId.toLowerCase();
      prodCountByStore.set(sid, (prodCountByStore.get(sid) || 0) + 1);
    }

    console.log(`\n=== TENANT: ${tenant.name} (${tenant.id}) | stores=${stores.length} | products=${products.length} | configs=${configs.length} ===`);

    // Check duplicate store names
    const byNormName = new Map();
    for (const s of stores) {
      const nk = normKey(s.name);
      if (!byNormName.has(nk)) byNormName.set(nk, []);
      byNormName.get(nk).push({
        id: s.id,
        name: s.name,
        shopId: s.shopId,
        teamId: s.teamId,
        status: s.status,
        enabled: s.enabled,
        orders: orderCountByStore.get(s.id.toLowerCase()) || 0,
        products: prodCountByStore.get(s.id.toLowerCase()) || 0,
      });
    }
    const dupNames = [...byNormName.entries()].filter(([, arr]) => arr.length > 1);
    console.log(`DUPLICATE_STORE_NAMES (${dupNames.length}):`);
    for (const [nk, arr] of dupNames) {
      console.log('DUP_STORE:', nk, JSON.stringify(arr));
    }

    // Search stores & products for keywords from the 29 unresolved families:
    const keywords = [
      'ogimi', 'kangen', 'garahe', 'headlight', 'andrea', 'scentgem', 'petal',
      'ifeelyou', 'feel', 'milagros', 'aling', 'tails', 'yoyo', 'bonds', 'mom',
      'vitasure', 'immuni', 'speak', 'safeplay', 'evah', 'rtw', 'agri', 'plant',
      'taisui', 'amulet', 'hanna', 'kinetiq', 'anik', 'kid', 'chart'
    ];
    for (const kw of keywords) {
      const matchingStores = stores.filter(s => normKey(s.name).includes(kw)).map(s => ({
        id: s.id, name: s.name, shopId: s.shopId, teamId: s.teamId,
        orders: orderCountByStore.get(s.id.toLowerCase()) || 0,
        products: prodCountByStore.get(s.id.toLowerCase()) || 0,
      }));
      const matchingProds = products.filter(p =>
        normKey(p.name).includes(kw) || normKey(p.mapping).includes(kw) || normKey(p.customId).includes(kw)
      ).slice(0, 10).map(p => ({
        storeId: p.storeId,
        storeName: stores.find(s => s.id.toLowerCase() === p.storeId.toLowerCase())?.name,
        customId: p.customId,
        mapping: p.mapping,
        name: p.name,
      }));
      console.log(`KW_SEARCH[${kw}]: stores=${JSON.stringify(matchingStores)} | prods=${JSON.stringify(matchingProds)}`);
    }

    // Also check what stores/products/teams are used by the ad accounts of the unresolved ads
    const targetAccts = [
      '1615092896413080', '2921311144885542', '2560293900989953', '1498715057328619',
      '813136290183411', '2832635633605962', '1308651473678665', '1687383405458946',
      '3061259110752002', '285261450734660', '644344414390235', '1669334037124730',
      '954488446859723', '1487235986020067', '1003304012201844', '9822032834531822',
      '655262126044184', '847418468403540', '998165405979790', '850768971402640',
      '958259000437052', '582155984080051', '803800711267060', '960384376518638',
      '1889518721645704'
    ];
    const acctUsage = await prisma.$queryRawUnsafe(`
      SELECT
        "accountId",
        mapping,
        shops::text AS "shopsJson",
        "teamId",
        "teamCode",
        MIN(date)::text AS "minDate",
        MAX(date)::text AS "maxDate",
        SUM(spend)::float8 AS spend,
        ARRAY_AGG(DISTINCT "campaignName") AS camps
      FROM reconcile_marketing
      WHERE "tenantId" = $1::uuid
        AND "accountId" = ANY($2::text[])
        AND (spend > 0 OR leads > 0)
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY "accountId", spend DESC
    `, tenantId, targetAccts);

    const byAcct = new Map();
    for (const r of acctUsage) {
      if (!byAcct.has(r.accountId)) byAcct.set(r.accountId, []);
      byAcct.get(r.accountId).push({
        mapping: r.mapping,
        shops: r.shopsJson,
        teamId: r.teamId,
        teamCode: r.teamCode,
        dates: `${r.minDate}..${r.maxDate}`,
        spend: Number(r.spend.toFixed(2)),
        sampleCamps: (r.camps || []).slice(0, 3),
      });
    }
    for (const [acct, rows] of byAcct.entries()) {
      console.log(`ACCT_USAGE[${acct}]:`, JSON.stringify(rows.slice(0, 12)));
    }
  }
  await new Promise(r => setTimeout(r, 2000));
}

main()
  .catch(e => { console.error('SCRIPT_ERROR:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());

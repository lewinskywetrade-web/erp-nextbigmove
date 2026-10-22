import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Scope = {
  tenantId: string;
  previousStart: string;
  currentStart: string;
  end: string;
  activeShopIds: string[];
  mappings: string[];
  includeNull: boolean;
  emptySelection?: boolean;
  teamIds?: string[];
};

export type AbandonedCostGroup = {
  period: 'current' | 'previous';
  mapping: string | null;
  currentAbandonedCount: number;
  repurchaseCurrentAbandonedCount: number;
  currentAbandonedCodPos: number;
  repurchaseCurrentAbandonedCodPos: number;
  cogsCurrentAbandonedPos: number;
  repurchaseCogsCurrentAbandonedPos: number;
};

const unsupported = () => new BadRequestException(
  'Exclude Abandoned cannot calculate exact COGS for these report rows. Reconcile the selected dates and try again; no missing cost has been treated as zero.',
);

/** Reuse the report's actual per-ad order membership, never PosOrder.mapping. */
export function abandonedCostQueries(scope: Scope) {
  const mappingConditions = scope.mappings.filter(m => m !== '__null__')
    .map(m => Prisma.sql`LOWER(r.mapping) = ${m}`);
  if (scope.includeNull) mappingConditions.push(Prisma.sql`r.mapping IS NULL`);
  const selection = scope.emptySelection ? Prisma.sql`FALSE`
    : scope.mappings.length ? (mappingConditions.length ? Prisma.sql`(${Prisma.join(mappingConditions, ' OR ')})` : Prisma.sql`FALSE`) : Prisma.sql`TRUE`;
  const teamIds = scope.teamIds || [];
  const rowTeam = teamIds.length ? Prisma.sql`r."teamId" IN (${Prisma.join(teamIds.map(id => Prisma.sql`${id}::uuid`))})` : Prisma.sql`TRUE`;
  const orderTeam = teamIds.length ? Prisma.sql`o."teamId" IN (${Prisma.join(teamIds.map(id => Prisma.sql`${id}::uuid`))})` : Prisma.sql`TRUE`;
  const active = scope.activeShopIds.length ? Prisma.sql`o."shopId" IN (${Prisma.join(scope.activeShopIds)})` : Prisma.sql`FALSE`;
  const targets = Prisma.sql`
    targets AS MATERIALIZED (
      SELECT r.* FROM reconcile_marketing r
      WHERE r."tenantId" = ${scope.tenantId}::uuid
        AND r.date BETWEEN ${scope.previousStart}::date AND ${scope.end}::date
        AND ${selection} AND ${rowTeam}
        AND (r."currentAbandonedCount" <> 0 OR r."repurchaseCurrentAbandonedCount" <> 0)
    ),
    witnesses AS MATERIALIZED (
      SELECT r.id, r.date, r."matchedOrders" FROM reconcile_marketing r
      WHERE r."tenantId" = ${scope.tenantId}::uuid
        AND r.date IN (SELECT DISTINCT date FROM targets)
    )`;
  const budget = Prisma.sql`WITH ${targets}
    SELECT (SELECT count(*)::text FROM targets) AS "targetRows",
      count(*)::text AS "witnessRows",
      coalesce(sum(pg_column_size("matchedOrders")),0)::text AS "payloadBytes",
      coalesce(sum(CASE WHEN jsonb_typeof("matchedOrders") = 'array'
        THEN jsonb_array_length("matchedOrders") ELSE 0 END), 0)::text AS "members"
    FROM witnesses`;
  const groups = Prisma.sql`WITH ${targets},
    ownership AS MATERIALIZED (
      SELECT w.date, j.value->>'shopId' AS shop, j.value->>'posOrderId' AS external_id, count(*) AS owners
      FROM witnesses w CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(w."matchedOrders") = 'array' THEN w."matchedOrders" ELSE '[]'::jsonb END) j
      GROUP BY w.date, j.value->>'shopId', j.value->>'posOrderId'
    ),
    evidence AS (
      SELECT t.id, t.date, t.mapping,
        t."currentAbandonedCount", t."repurchaseCurrentAbandonedCount",
        t."currentAbandonedCodPos", t."repurchaseCurrentAbandonedCodPos",
        jsonb_typeof(t."matchedOrders") IS DISTINCT FROM 'array'
          OR count(*) FILTER (WHERE j.value IS NOT NULL AND (
            jsonb_typeof(j.value) IS DISTINCT FROM 'object'
            OR jsonb_typeof(j.value->'shopId') IS DISTINCT FROM 'string'
            OR jsonb_typeof(j.value->'posOrderId') IS DISTINCT FROM 'string'
            OR coalesce(j.value->>'shopId','') = '' OR coalesce(j.value->>'posOrderId','') = ''
            OR own.owners IS DISTINCT FROM 1 OR o.id IS NULL
            OR CASE WHEN jsonb_typeof(j.value->'cod') = 'number'
              THEN (j.value->>'cod')::numeric IS DISTINCT FROM o.cod ELSE TRUE END
          )) > 0
          OR count(o.id) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7) <> t."purchasesPos"
          OR coalesce(sum(o.cod) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7),0) <> t."codPos"
          OR coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7),0) <> t."cogsPos"
          OR count(o.id) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7 AND o."isRepurchase") <> t."repurchaseCount"
          OR coalesce(sum(o.cod) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7 AND o."isRepurchase"),0) <> t."repurchaseCodPos"
          OR coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7 AND o."isRepurchase"),0) <> t."repurchaseCogsPos"
          OR coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 6),0) <> t."cogsCanceledPos"
          OR coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 6 AND o."isRepurchase"),0) <> t."repurchaseCogsCanceledPos"
          OR coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 11),0) <> t."cogsRestockingPos"
          OR coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 11 AND o."isRepurchase"),0) <> t."repurchaseCogsRestockingPos"
          OR coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status IN (4,5)),0) <> t."cogsRtsPos"
          OR coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status IN (4,5) AND o."isRepurchase"),0) <> t."repurchaseCogsRtsPos"
          OR coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 3),0) <> t."cogsDeliveredPos"
          OR coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 3 AND o."isRepurchase"),0) <> t."repurchaseCogsDeliveredPos"
          OR count(o.id) FILTER (WHERE NOT o."isVoid" AND o.status = 0 AND o."isAbandoned") <> t."currentAbandonedCount"
          OR coalesce(sum(o.cod) FILTER (WHERE NOT o."isVoid" AND o.status = 0 AND o."isAbandoned"),0) <> t."currentAbandonedCodPos"
          OR count(o.id) FILTER (WHERE NOT o."isVoid" AND o.status = 0 AND o."isAbandoned" AND o."isRepurchase") <> t."repurchaseCurrentAbandonedCount"
          OR coalesce(sum(o.cod) FILTER (WHERE NOT o."isVoid" AND o.status = 0 AND o."isAbandoned" AND o."isRepurchase"),0) <> t."repurchaseCurrentAbandonedCodPos"
          AS invalid,
        coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 0 AND o."isAbandoned"),0) AS abandoned_cost,
        coalesce(sum(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 0 AND o."isAbandoned" AND o."isRepurchase"),0) AS repeat_abandoned_cost
      FROM targets t
      LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t."matchedOrders") = 'array'
        THEN t."matchedOrders" ELSE '[]'::jsonb END) j ON TRUE
      LEFT JOIN ownership own ON own.date = t.date AND own.shop = j.value->>'shopId' AND own.external_id = j.value->>'posOrderId'
      LEFT JOIN pos_orders o ON o."tenantId" = ${scope.tenantId}::uuid
        AND o."shopId" = j.value->>'shopId' AND o."posOrderId" = j.value->>'posOrderId'
        AND o."dateLocal" = to_char(t.date,'YYYY-MM-DD') AND ${active} AND ${orderTeam}
      GROUP BY t.id, t.date, t.mapping, t."matchedOrders", t."purchasesPos", t."codPos", t."cogsPos",
        t."repurchaseCount", t."repurchaseCodPos", t."repurchaseCogsPos",
        t."currentAbandonedCount", t."repurchaseCurrentAbandonedCount",
        t."currentAbandonedCodPos", t."repurchaseCurrentAbandonedCodPos",
        t."cogsCanceledPos", t."repurchaseCogsCanceledPos", t."cogsRestockingPos", t."repurchaseCogsRestockingPos", t."cogsRtsPos", t."repurchaseCogsRtsPos", t."cogsDeliveredPos", t."repurchaseCogsDeliveredPos"
    )
    SELECT CASE WHEN date >= ${scope.currentStart}::date THEN 'current' ELSE 'previous' END AS period, mapping,
      count(*) FILTER (WHERE invalid)::text AS "invalidRows",
      sum("currentAbandonedCount")::text AS "currentAbandonedCount",
      sum("repurchaseCurrentAbandonedCount")::text AS "repurchaseCurrentAbandonedCount",
      sum("currentAbandonedCodPos")::text AS "currentAbandonedCodPos",
      sum("repurchaseCurrentAbandonedCodPos")::text AS "repurchaseCurrentAbandonedCodPos",
      sum(abandoned_cost)::text AS "cogsCurrentAbandonedPos",
      sum(repeat_abandoned_cost)::text AS "repurchaseCogsCurrentAbandonedPos"
    FROM evidence GROUP BY period, mapping`;
  return { budget, groups };
}

async function readCurrentAbandonedCostsUnchecked(db: any, scope: Scope): Promise<AbandonedCostGroup[]> {
  const queries = abandonedCostQueries(scope);
  await db.$executeRaw`SET LOCAL statement_timeout = '10000ms'`;
  const [budget] = await db.$queryRaw(queries.budget);
  const bounded = (v: any, max: number) => typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) <= BigInt(max);
  if (!budget || !bounded(budget.targetRows, 25000) || !bounded(budget.witnessRows, 25000) || !bounded(budget.members, 100000) || !bounded(budget.payloadBytes, 16777216)) throw unsupported();
  if (budget.targetRows === '0') return [];
  const rows = await db.$queryRaw(queries.groups);
  if (rows.length > 25000) throw unsupported();
  return rows.map((row: any) => {
    if (!['current', 'previous'].includes(row.period) || !(row.mapping === null || typeof row.mapping === 'string') || row.invalidRows !== '0') throw unsupported();
    const result: any = { period: row.period, mapping: row.mapping };
    for (const key of ['currentAbandonedCount', 'repurchaseCurrentAbandonedCount', 'currentAbandonedCodPos', 'repurchaseCurrentAbandonedCodPos', 'cogsCurrentAbandonedPos', 'repurchaseCogsCurrentAbandonedPos']) {
      if (typeof row[key] !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(row[key]) || !Number.isFinite(Number(row[key])) || (key.includes('Count') && !/^\d+$/.test(row[key]))) throw unsupported();
      result[key] = Number(row[key]);
    }
    if (result.cogsCurrentAbandonedPos < 0 || result.repurchaseCogsCurrentAbandonedPos < 0) throw unsupported();
    return result;
  });
}

export function attachCurrentAbandonedCosts(sum: any, groups: AbandonedCostGroup[]) {
  for (const key of ['currentAbandonedCount', 'repurchaseCurrentAbandonedCount', 'currentAbandonedCodPos', 'repurchaseCurrentAbandonedCodPos']) {
    const actual = groups.reduce((total, row) => total.plus(Number(row[key as keyof AbandonedCostGroup])), new Prisma.Decimal(0));
    if (!actual.equals(new Prisma.Decimal(sum[key] ?? 0))) throw unsupported();
  }
  sum.cogsCurrentAbandonedPos = groups.reduce((total, row) => total.plus(row.cogsCurrentAbandonedPos), new Prisma.Decimal(0)).toNumber();
  sum.repurchaseCogsCurrentAbandonedPos = groups.reduce((total, row) => total.plus(row.repurchaseCogsCurrentAbandonedPos), new Prisma.Decimal(0)).toNumber();
}

export async function readCurrentAbandonedCosts(db: any, scope: Scope): Promise<AbandonedCostGroup[]> {
  try { return await readCurrentAbandonedCostsUnchecked(db, scope); }
  catch { throw unsupported(); }
}

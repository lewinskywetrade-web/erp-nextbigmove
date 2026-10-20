import { ConflictException } from '@nestjs/common';
import { PosProductCogs, Prisma } from '@prisma/client';
import { assertRecordedProductCogs, assertValidProductCogs } from '../integrations/product-cogs-validation';

export type LockedCogsProduct = { id: string; name: string; productId: string; customId: string | null; teamId: string | null };

export async function lockCogsProduct(
    tx: Prisma.TransactionClient,
    productId: string,
    store: { id: string; tenantId: string },
  ): Promise<LockedCogsProduct | null> {
    // Acquire the normal COGS write table lock before the parent row. The reviewed
    // repair utility takes a SHARE table lock in the same order to exclude phantoms.
    await tx.$executeRawUnsafe('LOCK TABLE pos_product_cogs IN ROW EXCLUSIVE MODE');
    const rows = await tx.$queryRawUnsafe<LockedCogsProduct[]>(`
      SELECT p.id,p.name,p."productId",p."customId",s."teamId"
      FROM pos_products p JOIN pos_stores s ON s.id=p."storeId"
      WHERE p.id=$1::uuid AND p."storeId"=$2::uuid AND s."tenantId"=$3::uuid
      FOR UPDATE OF p FOR SHARE OF s`, productId, store.id, store.tenantId);
    return rows[0] ?? null;
  }

export async function productCogsToday(client: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>): Promise<Date> {
    const [clock] = await client.$queryRawUnsafe<Array<{ businessDate: string }>>(`
      SELECT to_char((statement_timestamp() AT TIME ZONE 'Asia/Manila')::date,'YYYY-MM-DD') AS "businessDate"`);
    return new Date(`${clock.businessDate}T00:00:00.000Z`);
  }

export async function findApplicableProductCogs(
    client: Pick<Prisma.TransactionClient, 'posProductCogs'>,
    productId: string,
    store: { id: string; tenantId: string },
    date: Date,
  ) {
    const scope = { tenantId: store.tenantId, storeId: store.id, productId };
    const dated = await client.posProductCogs.findFirst({
      where: { ...scope, AND: [{ startDate: { not: null } }, { startDate: { lte: date } }],
        OR: [{ endDate: { gte: date } }, { endDate: null }] },
      orderBy: [{ startDate: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
    });
    const selected = dated ?? await client.posProductCogs.findFirst({
      where: { ...scope, startDate: null, OR: [{ endDate: { gte: date } }, { endDate: null }] },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    if (!selected) return null;
    try { assertValidProductCogs(Number(selected.cogs.toString())); } catch { return null; }
    return selected;
  }

export function validateCurrentCogsHistory(
    history: PosProductCogs[], productId: string, store: { id: string; tenantId: string }, today: Date,
  ) {
    const review = (reason: string): never => {
      throw new ConflictException(`COGS history requires review (${reason}); no changes applied`);
    };
    const todayTime = today.getTime();
    for (const entry of history) {
      if (entry.productId !== productId || entry.storeId !== store.id || entry.tenantId !== store.tenantId) review('scope mismatch');
      try { assertRecordedProductCogs(Number(entry.cogs.toString())); } catch { review('invalid recorded cost'); }
      const start = entry.startDate?.getTime();
      const end = entry.endDate?.getTime();
      if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end))) review('invalid date');
      if (start !== undefined && end !== undefined && end < start) review('invalid date range');
      if (start !== undefined && start > todayTime) review('future schedule');
      if (end !== undefined && end >= todayTime) review('finite current or future expiry');
    }
    if (history.filter((entry) => entry.startDate === null).length > 1) review('multiple undated defaults');
    const dated = history.filter((entry) => entry.startDate !== null)
      .sort((left, right) => left.startDate!.getTime() - right.startDate!.getTime());
    let previousEnd = -Infinity;
    for (const entry of dated) {
      if (entry.startDate!.getTime() <= previousEnd) review('overlapping dated intervals');
      previousEnd = entry.endDate?.getTime() ?? Infinity;
    }
  }

export async function writeCurrentProductCogs(
    tx: Prisma.TransactionClient, product: LockedCogsProduct,
    store: { id: string; tenantId: string }, cogs: number | Prisma.Decimal, today: Date,
  ) {
    assertValidProductCogs(Number(cogs.toString()));
    // Deliberately include all rows for this parent, so wrong-scope history is
    // rejected rather than hidden by a tenant filter and silently duplicated.
    const history = await tx.posProductCogs.findMany({ where: { productId: product.id } });
    validateCurrentCogsHistory(history, product.id, store, today);
    const todayEntry = history.find((entry) => entry.startDate?.getTime() === today.getTime());
    const olderOpen = history.find((entry) => entry.startDate !== null
      && entry.startDate.getTime() < today.getTime() && entry.endDate === null);
    const legacy = history.find((entry) => entry.startDate === null && entry.endDate === null);
    const current = todayEntry ?? olderOpen ?? legacy;
    if (current && current.cogs.equals(cogs)) return { entry: current, hadHistory: true, changed: false, historyBefore: history };
    if (todayEntry) {
      const entry = await tx.posProductCogs.update({
        where: { id: todayEntry.id, tenantId: store.tenantId, storeId: store.id,
          productId: product.id, updatedAt: todayEntry.updatedAt },
        data: { cogs },
      });
      return { entry, hadHistory: true, changed: true, historyBefore: history };
    }
    if (olderOpen) {
      const closed = await tx.posProductCogs.updateMany({
        where: { id: olderOpen.id, tenantId: store.tenantId, storeId: store.id,
          productId: product.id, updatedAt: olderOpen.updatedAt, endDate: null },
        data: { endDate: new Date(today.getTime() - 86400000) },
      });
      if (closed.count !== 1) throw new ConflictException('COGS history changed; refresh before retrying');
    }
    const entry = await tx.posProductCogs.create({ data: {
      tenantId: store.tenantId, teamId: product.teamId, productId: product.id,
      storeId: store.id, cogs, startDate: today, endDate: null,
    } });
    return { entry, hadHistory: history.length > 0, changed: true, historyBefore: history };
  }

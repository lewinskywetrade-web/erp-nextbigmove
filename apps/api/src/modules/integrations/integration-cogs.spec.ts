import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException, ValidationPipe } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';
import { ProductCogsDto } from './dto/product-cogs.dto';
import { MAX_PRODUCT_COGS } from './product-cogs-validation';

function costEntry(overrides: any = {}) {
  return { id: 'old-cost', tenantId: 'tenant-1', storeId: 'store-1', teamId: 'team-1', productId: 'product-1',
    cogs: new Decimal('10.00'), startDate: null, endDate: null,
    createdAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01'), ...overrides };
}

function matches(row: any, where: any): boolean {
  return Object.entries(where || {}).every(([key, condition]: [string, any]) => {
    if (key === 'AND') return condition.every((clause: any) => matches(row, clause));
    if (key === 'OR') return condition.some((clause: any) => matches(row, clause));
    const value = row[key];
    if (condition && typeof condition === 'object' && !(condition instanceof Date) && !(condition instanceof Decimal)) {
      return Object.entries(condition).every(([operator, bound]: [string, any]) => {
        if (operator === 'in') return bound.includes(value);
        if (operator === 'not') return value !== bound;
        if (value === null) return false;
        if (operator === 'lte') return value.getTime() <= bound.getTime();
        if (operator === 'gte') return value.getTime() >= bound.getTime();
        throw new Error(`Unsupported fixture operator ${operator}`);
      });
    }
    return value instanceof Date && condition instanceof Date ? value.getTime() === condition.getTime() : value === condition;
  });
}

function createHarness(initialRows: any[] = []) {
  const store = { id: 'store-1', tenantId: 'tenant-1', teamId: 'team-1' };
  let rows = initialRows.map(row => ({ ...row }));
  const products = ['product-1', 'product-2'].map(id => ({ id, name: id, productId: `parent-${id}`, customId: id, storeId: store.id, teamId: store.teamId }));
  const events: string[] = [];
  const hooks = { failCreate: false, failClose: false, failQueue: false };
  const refresh = { enqueue: jest.fn(async (_scope: any) => {
    events.push('refresh-queued');
    if (hooks.failQueue) throw new Error('Fixture queue unavailable');
  }) };
  let sequence = 0;
  let transactionId = 0;
  const tails = new Map<string, Promise<void>>();
  const operations = Object.fromEntries(['findFirst', 'findMany', 'create', 'update', 'updateMany', 'delete'].map(name => [name, jest.fn<(args: any) => void>()])) as Record<string, ReturnType<typeof jest.fn<(args: any) => void>>>;
  function model(overlay = new Map<string, any>(), locked?: Set<string>, prefix = 'read') {
    const view = () => {
      const result = new Map(rows.map(row => [row.id, row]));
      for (const [id, row] of overlay) { if (row === null) result.delete(id); else result.set(id, row); }
      return [...result.values()];
    };
    const read = (args: any) => {
      if (locked && !locked.has(args.where.productId)) throw new Error('History read before parent lock');
      events.push(`${prefix}:history:${args.where.productId}`);
      const result = view().filter(row => matches(row, args.where));
      return result.sort((left, right) => {
        for (const ordering of args.orderBy || []) {
          const [key, direction] = Object.entries(ordering)[0];
          const a = left[key] instanceof Date ? left[key].getTime() : left[key] ?? Infinity;
          const b = right[key] instanceof Date ? right[key].getTime() : right[key] ?? Infinity;
          if (a !== b) return (a < b ? -1 : 1) * (direction === 'desc' ? -1 : 1);
        }
        return 0;
      }).map(row => ({ ...row }));
    };
    const changed = (row: any, data: any) => ({ ...row, ...data, cogs: new Decimal(data.cogs ?? row.cogs), updatedAt: new Date(Date.UTC(2026, 9, 19, 1, 0, 0, ++sequence)) });
    return {
      findFirst: async (args: any) => { operations.findFirst(args); return read(args)[0] ?? null; },
      findMany: async (args: any) => { operations.findMany(args); return read(args); },
      create: async (args: any) => {
        operations.create(args);
        if (hooks.failCreate) throw new Error('Fixture create failure');
        const entry = costEntry({ ...args.data, id: `created-${++sequence}`, cogs: new Decimal(args.data.cogs) });
        overlay.set(entry.id, entry); return { ...entry };
      },
      update: async (args: any) => {
        operations.update(args);
        const row = view().find(row => matches(row, args.where));
        if (!row) throw new Error('Fixture version conflict');
        const entry = changed(row, args.data); overlay.set(entry.id, entry); return { ...entry };
      },
      updateMany: async (args: any) => {
        operations.updateMany(args);
        if (hooks.failClose) return { count: 0 };
        const matching = view().filter(row => matches(row, args.where));
        for (const row of matching) overlay.set(row.id, changed(row, args.data));
        return { count: matching.length };
      },
      delete: async (args: any) => {
        operations.delete(args);
        const row = view().find(row => matches(row, args.where));
        if (!row) throw new Error('Fixture version conflict');
        overlay.set(row.id, null); return row;
      },
    };
  }
  const prisma = {
    posProduct: {
      findFirst: jest.fn(async (args: any) => products.find(product => product.id === args.where.id && product.storeId === args.where.storeId) ?? null),
    },
    posProductCogs: model(),
    $queryRawUnsafe: jest.fn(async (_sql: string) => [{ businessDate: '2026-10-19' }]),
    $transaction: jest.fn(async (callback: (tx: any) => Promise<any>, options: any) => {
      expect(options.isolationLevel).toBe('ReadCommitted');
      const prefix = `tx-${++transactionId}`;
      const overlay = new Map<string, any>();
      const locked = new Set<string>();
      const releases: Array<() => void> = [];
      let hasCogsTableLock = false;
      const tx = {
        tenant: { findUnique: jest.fn(async () => ({ settings: {} })) },
        wmsProductProfile: { findUnique: jest.fn(async () => null) },
        posProductCogs: model(overlay, locked, prefix),
        $executeRawUnsafe: async (sql: string) => {
          expect(sql).toBe('LOCK TABLE pos_product_cogs IN ROW EXCLUSIVE MODE');
          hasCogsTableLock = true;
          events.push(`${prefix}:table-lock`);
          return 0;
        },
        $queryRawUnsafe: async (sql: string, ...params: string[]) => {
          if (sql.includes('businessDate')) return [{ businessDate: '2026-10-19' }];
          expect(hasCogsTableLock).toBe(true);
          expect(sql).toContain('FOR UPDATE OF p');
          expect(sql).toContain('FOR SHARE OF s');
          const [productId, storeId, tenantId] = params;
          expect(storeId).toBe(store.id); expect(tenantId).toBe(store.tenantId);
          const product = products.find(product => product.id === productId && product.storeId === storeId);
          if (!product) return [];
          const previous = tails.get(productId) ?? Promise.resolve();
          let release!: () => void;
          const held = new Promise<void>(resolve => { release = resolve; });
          tails.set(productId, previous.then(() => held));
          await previous;
          releases.push(release); locked.add(productId); events.push(`${prefix}:lock:${productId}`);
          return [{ ...product, teamId: store.teamId }];
        },
      };
      try {
        const result = await callback(tx);
        const committed = new Map(rows.map(row => [row.id, row]));
        for (const [id, row] of overlay) { if (row === null) committed.delete(id); else committed.set(id, row); }
        rows = [...committed.values()]; events.push(`${prefix}:commit`); return result;
      } finally { releases.forEach(release => release()); }
    }),
  };
  const teamContext = {
    getContext: jest.fn<() => Promise<unknown>>().mockResolvedValue({ tenantId: store.tenantId }),
    validateAndGetTeamId: jest.fn<() => Promise<string>>().mockResolvedValue(store.teamId),
  };
  const service = new IntegrationService(
    prisma as never,
    { get: jest.fn(() => undefined) } as never,
    teamContext as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    refresh as never,
    { syncAfterErpWrites: jest.fn(async () => undefined) } as never,
  );
  const getStore = jest.spyOn(service, 'getPosStore').mockResolvedValue(store as never);
  return { service, prisma, getStore, teamContext, operations, events, hooks, refresh, store, rows: () => rows };
}

const invalidAmounts: unknown[] = [
  undefined, null, '12.34', {}, NaN, Infinity, -Infinity, -1,
  0.001, 12.345, 10_000_000_000,
];

describe('product COGS service validation', () => {
  it.each([{ code: 'P2010', meta: { code: '55P03' } }, { code: 'P2010', meta: { code: '57014' } }, { code: 'P2028' }])(
    'retains source lock/transaction failures for ingestion retry: %p', error => {
      const { service } = createHarness();
      expect((service as any).isTransientDbError(error)).toBe(true);
    },
  );
  it.each(invalidAmounts)('rejects invalid add amount %p before accessing data', async (amount) => {
    const { service, operations, getStore, teamContext } = createHarness();
    await expect(service.addCogsEntry('product-1', 'store-1', amount as number))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(getStore).not.toHaveBeenCalled();
    expect(teamContext.getContext).not.toHaveBeenCalled();
    expect(operations.create).not.toHaveBeenCalled();
    expect(operations.update).not.toHaveBeenCalled();
  });

  it.each(invalidAmounts)('rejects invalid update amount %p before accessing data', async (amount) => {
    const { service, operations, getStore } = createHarness();
    await expect(service.updateCogsEntry('store-1', 'product-1', 'cogs-1', amount as number))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(getStore).not.toHaveBeenCalled();
    expect(operations.update).not.toHaveBeenCalled();
  });

  it.each(invalidAmounts)('applies the same rule to bulk amount %p', async (amount) => {
    const { service, getStore } = createHarness();
    await expect(service.bulkUpdateProductCogs('store-1', ['product-1'], amount as number))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(getStore).not.toHaveBeenCalled();
  });

  it.each([0, 0.01, 12.34, MAX_PRODUCT_COGS])('stores valid peso amounts unchanged: %p', async (amount) => {
    const { service, operations } = createHarness();
    const entry = await service.addCogsEntry('product-1', 'store-1', amount);
    expect(operations.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1', teamId: 'team-1', productId: 'product-1', storeId: 'store-1',
        cogs: amount, startDate: new Date('2026-10-19'), endDate: null,
      },
    });
    await service.updateCogsEntry('store-1', 'product-1', entry.id, amount);
    expect(operations.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: entry.id, tenantId: 'tenant-1', storeId: 'store-1', productId: 'product-1' }), data: { cogs: amount },
    }));
  });
});

describe('date-aware current COGS writes and reads', () => {
  const today = new Date('2026-10-19');
  const yesterday = new Date('2026-10-18');

  it('preserves the undated default and adds a current baseline using the store team', async () => {
    const { service, rows, teamContext } = createHarness([costEntry()]);
    const created = await service.addCogsEntry('product-1', 'store-1', 20);
    expect(rows().find(row => row.id === 'old-cost')).toEqual(costEntry());
    expect(created).toMatchObject({ tenantId: 'tenant-1', storeId: 'store-1', teamId: 'team-1', startDate: today, endDate: null });
    expect(created.cogs.toString()).toBe('20');
    expect(teamContext.getContext).not.toHaveBeenCalled();
    expect(teamContext.validateAndGetTeamId).not.toHaveBeenCalled();
    expect((await service.getCogsForDate('product-1', 'store-1', new Date('2026-10-01')))!.toString()).toBe('10');
    expect((await service.getCurrentCogs('product-1', 'store-1'))!.cogs.toString()).toBe('20');
  });

  it('closes the prior open interval yesterday without changing its amount', async () => {
    const prior = costEntry({ startDate: new Date('2026-10-01') });
    const { service, rows, operations } = createHarness([prior]);
    await service.addCogsEntry('product-1', 'store-1', 20);
    expect(rows().find(row => row.id === prior.id)).toMatchObject({ cogs: prior.cogs, startDate: prior.startDate, endDate: yesterday });
    expect(operations.updateMany.mock.calls[0][0].data).toEqual({ endDate: yesterday });
    expect((await service.getCogsForDate('product-1', 'store-1', yesterday))!.toString()).toBe('10');
    expect((await service.getCurrentCogs('product-1', 'store-1'))!.cogs.toString()).toBe('20');
  });

  it('edits only the amount of an existing today row', async () => {
    const { service, rows, operations } = createHarness([costEntry({ startDate: today })]);
    const entry = await service.addCogsEntry('product-1', 'store-1', 25);
    expect(entry.id).toBe('old-cost');
    expect(rows()).toHaveLength(1);
    expect(operations.update.mock.calls[0][0].data).toEqual({ cogs: 25 });
    expect(rows()[0]).toMatchObject({ startDate: today, endDate: null });
    expect(operations.create).not.toHaveBeenCalled();
    expect(operations.updateMany).not.toHaveBeenCalled();
  });

  it.each([null, new Date('2026-10-01'), today])('does not mutate matching current cost with startDate=%s', async startDate => {
    const prior = costEntry({ startDate });
    const { service, rows, operations } = createHarness([prior]);
    await service.addCogsEntry('product-1', 'store-1', 10);
    expect(rows()).toEqual([prior]);
    expect(operations.create).not.toHaveBeenCalled();
    expect(operations.update).not.toHaveBeenCalled();
    expect(operations.updateMany).not.toHaveBeenCalled();
  });

  it.each<[string, any[]]>([
    ['wrong tenant', [costEntry({ tenantId: 'other-tenant' })]],
    ['wrong store', [costEntry({ storeId: 'other-store' })]],
    ['negative cost', [costEntry({ cogs: new Decimal(-1) })]],
    ['invalid range', [costEntry({ startDate: today, endDate: yesterday })]],
    ['future start', [costEntry({ startDate: new Date('2026-10-20') })]],
    ['finite future expiry', [costEntry({ endDate: new Date('2026-10-20') })]],
    ['expiry today', [costEntry({ endDate: today })]],
    ['multiple defaults', [costEntry(), costEntry({ id: 'second-default' })]],
    ['dated overlap', [costEntry({ startDate: new Date('2026-09-01'), endDate: new Date('2026-09-30') }),
      costEntry({ id: 'overlap', startDate: new Date('2026-09-30'), endDate: new Date('2026-10-01') })]],
  ])('rejects %s for review without modifying any history', async (_reason, history) => {
    const { service, rows, operations } = createHarness(history);
    await expect(service.addCogsEntry('product-1', 'store-1', 20)).rejects.toBeInstanceOf(ConflictException);
    expect(rows()).toEqual(history);
    expect(operations.create).not.toHaveBeenCalled();
    expect(operations.update).not.toHaveBeenCalled();
    expect(operations.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back the interval closure if creating the new baseline fails', async () => {
    const prior = costEntry({ startDate: new Date('2026-10-01') });
    const { service, rows, hooks, operations } = createHarness([prior]);
    hooks.failCreate = true;
    await expect(service.addCogsEntry('product-1', 'store-1', 20)).rejects.toThrow('Fixture create failure');
    expect(operations.updateMany).toHaveBeenCalled();
    expect(rows()).toEqual([prior]);
  });

  it('does not create a baseline if the older row version cannot be closed', async () => {
    const prior = costEntry({ startDate: new Date('2026-10-01') });
    const { service, rows, hooks, operations } = createHarness([prior]);
    hooks.failClose = true;
    await expect(service.addCogsEntry('product-1', 'store-1', 20)).rejects.toBeInstanceOf(ConflictException);
    expect(rows()).toEqual([prior]);
    expect(operations.create).not.toHaveBeenCalled();
  });

  it('serializes two writers on their parent before either reads cost history', async () => {
    const { service, rows, events } = createHarness([costEntry({ startDate: new Date('2026-10-01') })]);
    await Promise.all([service.addCogsEntry('product-1', 'store-1', 20), service.addCogsEntry('product-1', 'store-1', 30)]);
    expect(rows()).toHaveLength(2);
    expect(rows().filter(row => row.startDate?.getTime() === today.getTime())).toHaveLength(1);
    expect((await service.getCurrentCogs('product-1', 'store-1'))!.cogs.toString()).toBe('30');
    expect(events.indexOf('tx-2:history:product-1')).toBeGreaterThan(events.indexOf('tx-1:commit'));
    expect(events.indexOf('tx-1:history:product-1')).toBeGreaterThan(events.indexOf('tx-1:lock:product-1'));
    expect(events.indexOf('tx-1:lock:product-1')).toBeGreaterThan(events.indexOf('tx-1:table-lock'));
  });

  it('keeps the bulk response shape and locks products in stable order', async () => {
    const { service, rows, events } = createHarness([costEntry()]);
    const response = await service.bulkUpdateProductCogs('store-1', ['product-2', 'product-1', 'product-1', 'missing'], 20);
    expect(response).toMatchObject({ success: true, requested: 3, matched: 2, processed: 2, created: 1, updated: 1 });
    expect(response.summary.new.map(row => row.id)).toEqual(['product-2']);
    expect(response.summary.updated.map(row => row.id)).toEqual(['product-1']);
    expect(response.summary.failed.map(row => row.id)).toEqual(['missing']);
    expect(events.filter(event => event.includes(':lock:'))).toEqual(['tx-1:lock:product-1', 'tx-1:lock:product-2']);
    expect(events.indexOf('tx-1:history:product-1')).toBeGreaterThan(events.indexOf('tx-1:lock:product-2'));
    expect(rows().find(row => row.id === 'old-cost')).toEqual(costEntry());
  });

  it('rolls back the entire bulk operation when a later product requires review', async () => {
    const history = [costEntry({ startDate: new Date('2026-10-01') }),
      costEntry({ id: 'future', productId: 'product-2', startDate: new Date('2026-10-20') })];
    const { service, rows } = createHarness(history);
    await expect(service.bulkUpdateProductCogs('store-1', ['product-1', 'product-2'], 20)).rejects.toBeInstanceOf(ConflictException);
    expect(rows()).toEqual(history);
  });

  it('keeps explicit historical editing and deletion parent-locked without reopening other dates', async () => {
    const past = costEntry({ startDate: new Date('2026-09-01'), endDate: yesterday });
    const { service, rows, events } = createHarness([past, costEntry({ id: 'current', startDate: today })]);
    await service.updateCogsEntry('store-1', 'product-1', past.id, 12);
    expect(rows().find(row => row.id === past.id)).toMatchObject({ startDate: past.startDate, endDate: yesterday });
    await service.deleteCogsEntry('store-1', 'product-1', 'current');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].endDate).toEqual(yesterday);
    expect(rows()[0].cogs.toString()).toBe('12');
    expect(await service.getCurrentCogs('product-1', 'store-1')).toBeNull();
    expect(events).toContain('tx-1:lock:product-1');
    expect(events).toContain('tx-2:lock:product-1');
  });

  it('reads applicable dates instead of choosing the most recently edited row', async () => {
    const { service } = createHarness([
      costEntry({ id: 'today', cogs: new Decimal(20), startDate: today }),
      costEntry({ id: 'default', cogs: new Decimal(8), updatedAt: new Date('2026-10-21') }),
      costEntry({ id: 'future', cogs: new Decimal(30), startDate: new Date('2026-10-30'), updatedAt: new Date('2026-10-22') }),
    ]);
    expect((await service.getCurrentCogs('product-1', 'store-1'))!.id).toBe('today');
    expect((await service.getCogsForDate('product-1', 'store-1', yesterday))!.toString()).toBe('8');
  });

  it('preserves a dated zero for partner-supplied stock and keeps the earlier paid rate', async () => {
    const { service, rows, operations } = createHarness([costEntry({ startDate: new Date('2026-10-01') })]);
    await service.addCogsEntry('product-1', 'store-1', 0);
    expect((await service.getCogsForDate('product-1', 'store-1', yesterday))!.toString()).toBe('10');
    expect((await service.getCogsForDate('product-1', 'store-1', today))!.toString()).toBe('0');
    const zero = rows().find(row => row.startDate?.getTime() === today.getTime());
    expect(zero!.cogs.toString()).toBe('0');
    operations.update.mockClear();
    await service.addCogsEntry('product-1', 'store-1', 0);
    expect(operations.update).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(2);
  });

  it('does not use a future baseline or an expired undated row for an earlier date', async () => {
    const { service } = createHarness([
      costEntry({ startDate: today }),
      costEntry({ id: 'expired-default', endDate: new Date('2026-09-30') }),
    ]);
    expect(await service.getCogsForDate('product-1', 'store-1', new Date('2026-10-01'))).toBeNull();
    await expect(service.getCogsForDate('product-1', 'store-1', new Date('invalid'))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('publishes one current-date bulk refresh under the parent locks before commit', async () => {
    const { service, events, refresh } = createHarness([costEntry()]);
    await service.bulkUpdateProductCogs('store-1', ['product-2', 'product-1'], 20);
    expect(refresh.enqueue).toHaveBeenCalledTimes(1);
    expect(refresh.enqueue).toHaveBeenCalledWith({ tenantId: 'tenant-1', storeId: 'store-1', changes: [
      { productId: 'product-1', fromDate: '2026-10-19', toDate: null },
      { productId: 'product-2', fromDate: '2026-10-19', toDate: null },
    ] });
    expect(events.indexOf('refresh-queued')).toBeGreaterThan(events.indexOf('tx-1:lock:product-2'));
    expect(events.indexOf('refresh-queued')).toBeLessThan(events.indexOf('tx-1:commit'));
  });

  it('rolls back all cost changes when durable refresh publication fails', async () => {
    const prior = costEntry({ startDate: new Date('2026-10-01') });
    const { service, rows, hooks } = createHarness([prior]); hooks.failQueue = true;
    await expect(service.addCogsEntry('product-1', 'store-1', 20)).rejects.toThrow('Fixture queue unavailable');
    expect(rows()).toEqual([prior]);
  });

  it('refreshes the existing historical range for explicit edits and deletion fallback', async () => {
    const prior = costEntry({ startDate: new Date('2026-09-01'), endDate: new Date('2026-09-30') });
    const { service, refresh } = createHarness([prior]);
    await service.updateCogsEntry('store-1', 'product-1', prior.id, 12);
    await service.deleteCogsEntry('store-1', 'product-1', prior.id);
    expect(refresh.enqueue.mock.calls.map(([call]) => call.changes)).toEqual([
      [{ productId: 'product-1', fromDate: '2026-09-01', toDate: '2026-09-30' }],
      [{ productId: 'product-1', fromDate: '2026-09-01', toDate: '2026-09-30' }],
    ]);
  });
});

describe('single product COGS HTTP contracts', () => {
  const pipe = new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  it.each(['addCogsEntry', 'updateCogsEntry'] as const)('%s uses a runtime DTO', (method) => {
    const parameters = Reflect.getMetadata('design:paramtypes', IntegrationController.prototype, method);
    expect(parameters[parameters.length - 1]).toBe(ProductCogsDto);
  });

  it.each([
    undefined, null, {}, true, false, [], [12.34], '', ' ', '12.34',
    NaN, Infinity, -Infinity, -1, 0.001, 12.345, 10_000_000_000,
  ])(
    'returns a validation error for invalid request amount %p', async (amount) => {
      await expect(pipe.transform({ cogs: amount }, { type: 'body', metatype: ProductCogsDto }))
        .rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each([0, 0.01, 12.34, MAX_PRODUCT_COGS])('accepts valid currency amount %p', async (amount) => {
    await expect(pipe.transform({ cogs: amount }, { type: 'body', metatype: ProductCogsDto }))
      .resolves.toMatchObject({ cogs: amount });
  });

  it('does not accept unimplemented effective-date fields', async () => {
    await expect(pipe.transform({ cogs: 12.34, startDate: '2026-10-19' }, {
      type: 'body', metatype: ProductCogsDto,
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});

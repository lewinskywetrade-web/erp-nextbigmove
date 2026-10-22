import { describe, expect, it } from '@jest/globals';
import { SalesAttributionAnalyticsService } from './sales-attribution-analytics.service';

type Order = {
  status: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 11;
  cod: number;
  cogs: number;
  tracking?: boolean;
  abandoned?: boolean;
};

const defaults = {
  excludeCancel: true,
  excludeRestocking: true,
  excludeAbandoned: true,
  excludeRts: true,
  includeTax12: false,
  includeTax1: false,
};

function rts(row: Order) {
  return (row.status === 4 || row.status === 5) && !!row.tracking;
}

function total(rows: Order[], key: 'cod' | 'cogs') {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

function aggregateRows(rows: Order[]) {
  const sums: Record<string, number> = {
    codPos: total(rows, 'cod'),
    cogsPos: total(rows, 'cogs'),
    purchasesPos: rows.length,
    processedPurchasesPos: rows.filter((row) => [1, 2, 3, 8].includes(row.status)).length,
  };
  for (const [name, predicate] of [
    ['delivered', (row: Order) => row.status === 3],
    ['shipped', (row: Order) => row.status === 2],
    ['canceled', (row: Order) => row.status === 6],
    ['restocking', (row: Order) => row.status === 11],
    ['rts', rts],
    ['abandoned', (row: Order) => !!row.abandoned],
  ] as const) {
    const matching = rows.filter(predicate);
    sums[`${name}Count`] = matching.length;
    sums[`${name}CodPos`] = total(matching, 'cod');
    sums[`cogs${name[0].toUpperCase()}${name.slice(1)}Pos`] = total(matching, 'cogs');
  }
  const nonCanceled = rows.filter((row) => row.status !== 6);
  const shippedDeliveredRts = rows.filter(
    (row) => row.status === 2 || row.status === 3 || rts(row),
  );
  for (const [name, rate] of [
    ['sf', 60],
    ['ff', 25],
    ['if', 5],
  ] as const) {
    sums[`${name}Pos`] = nonCanceled.length * rate;
    sums[`${name}SdrPos`] = shippedDeliveredRts.length * rate;
  }
  sums.codFeePos = total(rows.filter((row) => row.status !== 6 && !rts(row)), 'cod') * 0.0224;
  sums.codFeeDeliveredPos = total(rows.filter((row) => row.status === 3), 'cod') * 0.0224;
  return sums;
}

function persistedAggregate(rows: Order[], spend: number, mapping = 'product-a') {
  const sums = aggregateRows(rows);
  return { mapping, _sum: { ...sums, spend } };
}

function calculator() {
  const service = new SalesAttributionAnalyticsService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return service as any;
}

describe('SalesAttributionAnalyticsService COGS & RTS basis', () => {
  it('RTS on/off adjusts COGS once, does not double-credit RTS COGS, and preserves the independent forecast', () => {
    const service = calculator();
    const input = persistedAggregate(
      [
        { status: 3, cod: 1000, cogs: 300, tracking: true },
        { status: 4, cod: 700, cogs: 210, tracking: true },
        { status: 6, cod: 500, cogs: 150, tracking: false },
        { status: 11, cod: 400, cogs: 120, tracking: false },
      ],
      100,
    );

    const off = service.computeProductRow(input, { ...defaults, excludeRts: false });
    const on = service.computeProductRow(input, { ...defaults, excludeRts: true });
    const kpisOn = service.computeKpis(input, { ...defaults, excludeRts: true });
    const kpisOff = service.computeKpis(input, { ...defaults, excludeRts: false });

    expect(on.cogs).toBe(300);
    expect(off.cogs).toBe(510);
    expect(on.cogs_forecast_basis).toBe(510);
    expect(off.cogs_forecast_basis).toBe(510);
    expect(kpisOn.cogs_adjusted).toBe(300);
    expect(kpisOff.cogs_adjusted).toBe(510);
    expect(kpisOn.cogs_forecast_basis).toBe(510);
    expect(kpisOff.cogs_forecast_basis).toBe(510);
    expect(on.cogs_rts_credit).toBe(0);
    expect(off.cogs_rts_credit).toBe(210);
    expect(kpisOn.cogs_rts_credit).toBe(0);
    expect(kpisOff.cogs_rts_credit).toBe(210);

    // Contribution margin difference between excludeRts=false and excludeRts=true
    // is solely the RTS revenue (700) because RTS COGS is credited when included
    // and removed from COGS when excluded.
    expect(off.contribution_margin - on.contribution_margin).toBeCloseTo(700, 8);
    expect(kpisOff.contribution_margin - kpisOn.contribution_margin).toBeCloseTo(700, 8);
    expect(on.contribution_margin).toBeCloseTo(kpisOn.contribution_margin, 8);
    expect(off.contribution_margin).toBeCloseTo(kpisOff.contribution_margin, 8);

    // Forecast CM is independent of the excludeRts toggle
    expect(on.cm_rts_forecast).toBeCloseTo(off.cm_rts_forecast, 8);
    expect(kpisOn.cm_rts_forecast).toBeCloseTo(on.cm_rts_forecast, 8);
    expect(kpisOff.cm_rts_forecast).toBeCloseTo(off.cm_rts_forecast, 8);
    expect(on.net_margin).toBeCloseTo(off.net_margin, 8);
    expect(kpisOn.net_margin).toBeCloseTo(on.net_margin, 8);
  });
});

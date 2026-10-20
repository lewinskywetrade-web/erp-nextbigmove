import assert from 'node:assert/strict';
import { cogsUnitsValue, canViewCogsUnits, forecastCogsUnits } from '../src/app/(dashboard)/analytics/_utils/actual-cogs-units';
import { test } from 'node:test';
import type { SalesOverviewResponse } from '../src/app/(dashboard)/analytics/_types/sales';
import {
  projectSalesReport, observedCodFeeRate, forecastSalesKpis, forecastSalesProduct,
  forecastKpiValues, forecastProductValues,
} from '../src/app/(dashboard)/analytics/_utils/sales-report-forecast';
import { salesProductsExportGrid, type SalesProductsExportRow } from '../src/app/(dashboard)/analytics/_utils/sales-products-export';

const basis = {
  revenue: 10_000, orders: 10, cogs: 3_000, adSpend: 1_000,
  shipping: 500, fulfillment: 100, ifFees: 50, codFeeRate: .02,
};
const options = { excludeCancel: true, excludeRestocking: true, excludeAbandoned: true, excludeRts: true };

test('full report scenario updates revenue, COGS, orders and margin once', () => {
  const low = projectSalesReport(basis, 10), high = projectSalesReport(basis, 40);
  assert.equal(low.revenue, 9_000); assert.equal(low.cogs, 2_700); assert.equal(low.orders, 9);
  assert.equal(low.codFees, 180); assert.equal(low.margin, 4_470);
  assert.equal(high.revenue, 6_000); assert.equal(high.cogs, 1_800); assert.equal(high.orders, 6);
  assert.equal(high.codFees, 120); assert.equal(high.margin, 2_430);
  assert.equal(high.shipping, low.shipping); assert.equal(high.adSpend, low.adSpend);
  assert.equal(low.rtsRevenue + low.revenue, basis.revenue);
  assert.equal(low.rtsOrders + low.orders, basis.orders);
});

test('explicit zero cost remains valid, missing cost stays unavailable even at 100% RTS', () => {
  assert.equal(projectSalesReport({ ...basis, cogs: 0 }, 20).cogs, 0);
  assert.ok(Number.isNaN(projectSalesReport({ ...basis, cogs: Number.NaN }, 20).margin));
  assert.ok(Number.isNaN(projectSalesReport({ ...basis, cogs: Number.NaN }, 100).cogs));
});

test('no delivered revenue does not invent a COD rate or a zero margin', () => {
  const rate = observedCodFeeRate({ delivered: 0, cod_fee_delivered: 0 } as SalesOverviewResponse['kpis']);
  assert.ok(Number.isNaN(rate));
  assert.ok(Number.isNaN(projectSalesReport({ ...basis, codFeeRate: rate }, 20).margin));
  assert.equal(projectSalesReport({ ...basis, codFeeRate: rate }, 100).margin, -1_650);
  assert.equal(observedCodFeeRate({ delivered: 1_000, cod_fee_delivered: 0 } as SalesOverviewResponse['kpis']), 0);
});

test('zero success reports zero revenue and goods cost with incurred expenses retained', () => {
  const allReturned = projectSalesReport(basis, 100);
  assert.equal(allReturned.revenue, 0); assert.equal(allReturned.cogs, 0);
  assert.equal(allReturned.codFees, 0); assert.equal(allReturned.margin, -1_650);
  assert.ok(Number.isNaN(allReturned.cpp)); assert.ok(Number.isNaN(allReturned.arPct));
});

test('uniform selected-cohort COD rate conserves row amounts and total margins', () => {
  for (const pct of [0, 10, 23, 40, 100]) {
    const whole = projectSalesReport(basis, pct);
    const rows = [.2, .3, .5].map(part => projectSalesReport({
      revenue: basis.revenue * part, orders: basis.orders * part, cogs: basis.cogs * part,
      adSpend: basis.adSpend * part, shipping: basis.shipping * part,
      fulfillment: basis.fulfillment * part, ifFees: basis.ifFees * part,
      codFeeRate: basis.codFeeRate,
    }, pct));
    for (const key of ['revenue', 'orders', 'cogs', 'codFees', 'margin'] as const) {
      assert.ok(Math.abs(rows.reduce((sum, row) => sum + row[key], 0) - whole[key]) < 1e-8);
    }
  }
});

test('API adapters use already scoped components and restore actual RTS only to forecast population', () => {
  const kpis = {
    gross_cod: 12_000, canceled_cod: 1_000, restocking_cod: 500, abandoned_cod: 500,
    cogs_forecast_basis: 3_000, ad_spend: 1_000, sf_fees: 500, ff_fees: 100, if_fees: 50,
    delivered: 5_000, cod_fee_delivered: 100,
  } as SalesOverviewResponse['kpis'];
  const counts = { purchases: 8, rts: 2 } as SalesOverviewResponse['counts'];
  const row = {
    cod_raw: 12_000, canceled_cod: 1_000, restocking_cod: 500, abandoned_cod: 500,
    cogs_forecast_basis: 3_000, ad_spend: 1_000, sf_raw: 500, ff_raw: 100, if_raw: 50,
    gross_sales: 8, rts_count: 2,
  } as SalesOverviewResponse['products'][number];
  const originalKpis = structuredClone(kpis), originalRow = structuredClone(row);
  const total = forecastSalesKpis(kpis, counts, options, 20);
  const product = forecastSalesProduct(row, options, 20, observedCodFeeRate(kpis));
  assert.deepEqual(total, product);
  assert.equal(total.revenue, 8_000); assert.equal(total.cogs, 2_400);
  assert.equal(total.orders, 8); assert.equal(total.margin, 3_790);
  assert.deepEqual(forecastSalesKpis(kpis, { ...counts, purchases: 10 }, { ...options, excludeRts: false }, 20), total);
  const projectedKpis = forecastKpiValues(kpis, total), projectedRow = forecastProductValues(row, product);
  assert.equal(projectedKpis.contribution_margin, projectedKpis.net_margin);
  assert.equal(projectedRow.net_margin, projectedKpis.net_margin);
  assert.deepEqual(kpis, originalKpis); assert.deepEqual(row, originalRow);
});

test('current and previous periods use their own fee evidence', () => {
  const previousRate = observedCodFeeRate({ delivered: 2_000, cod_fee_delivered: 80 } as SalesOverviewResponse['kpis']);
  assert.equal(projectSalesReport({ ...basis, codFeeRate: previousRate }, 20).codFees, 320);
  assert.equal(projectSalesReport(basis, 20).codFees, 160);
});

test('forecast export keeps every row, fractional orders and explicit zeros; unavailable margins are blank', () => {
  const row: SalesProductsExportRow = {
    product: 'Example', grossRevenue: 100, grossSales: 1.25, cogs: 0, aov: 80, cpp: 10,
    processedCpp: 10, adSpend: 12.5, arPct: 12.5, rtsPct: 23, pePct: Number.NaN,
    contributionMargin: Number.NaN, cmRtsForecast: Number.NaN, netMargin: Number.NaN,
  };
  const input = { startDate: '2026-10-01', endDate: '2026-10-20', cmRtsLabel: 'CM (RTS 23%)', rows: Array.from({ length: 30 }, () => row) };
  const forecast = salesProductsExportGrid({ ...input, view: 'forecast', entityLabel: 'Store' });
  assert.equal(forecast.rows.length, 30);
  assert.equal(forecast.headers.length, 12); assert.ok(forecast.rows.every(values => values.length === 12));
  assert.equal(forecast.headers[0], 'Store'); assert.equal(forecast.headers[1], 'Forecast Revenue');
  assert.equal(forecast.headers.at(-1), 'Forecast Net (before overhead)');
  assert.equal(forecast.rows[0][2], 1.25); assert.equal(forecast.rows[0][3], 0);
  assert.equal(forecast.rows[0].at(-1), '');
  assert.ok(!forecast.headers.includes('Processed CPP')); assert.ok(!forecast.headers.includes(input.cmRtsLabel));
  const actual = salesProductsExportGrid(input);
  assert.equal(actual.headers.length, 14); assert.equal(actual.headers[1], 'Gross Revenue');
  assert.ok(actual.headers.includes(input.cmRtsLabel));
});

test('COGS-unit visibility follows only the current server identity, including View As', () => {
  assert.equal(canViewCogsUnits({ role: 'SUPER_ADMIN' }), true);
  for (const role of ['ADMIN', 'USER', 'VIEWER', undefined]) {
    assert.equal(canViewCogsUnits({ role }), false);
  }
  assert.equal(canViewCogsUnits(null), false);
  assert.equal(canViewCogsUnits(undefined), false);
  const preview = { role: 'USER', impersonatedBy: 'super-admin-owner' };
  assert.equal(canViewCogsUnits(preview), false);
});

test('actual quantities accept saved safe counts and never coerce missing evidence to zero', () => {
  for (const value of [0, 7, 1234]) assert.equal(cogsUnitsValue(value), value);
  for (const value of [null, undefined, '', '7', -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(cogsUnitsValue(value), null);
  }
  assert.equal(cogsUnitsValue(5.6, 'forecast'), 5.6);
  for (const value of [null, undefined, '', '7', -1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(cogsUnitsValue(value, 'forecast'), null);
  }
});

test('Forecast units use the same pre-RTS COGS population and success ratio for rows and totals', () => {
  const row = { actual_units: 37, actual_units_forecast_basis: 41 } as SalesOverviewResponse['products'][number];
  const kpis = { actual_units: 137, actual_units_forecast_basis: 149 } as SalesOverviewResponse['kpis'];
  for (const pct of [0, 20, 100]) {
    const forecast = projectSalesReport(basis, pct);
    const success = 1 - pct / 100;
    assert.equal(forecastProductValues(row, forecast).actual_units, 41 * success);
    assert.equal(forecastKpiValues(kpis, forecast).actual_units, 149 * success);
    assert.equal(forecast.cogs, basis.cogs * success);
    // Repeated calculations start from the server population, never the prior projection.
    assert.equal(forecastProductValues(forecastProductValues(row, forecast), forecast).actual_units, 41 * success);
  }
  assert.equal(row.actual_units, 37);
  assert.equal(kpis.actual_units, 137);
});

test('filtered actual units remain distinct from pre-RTS units, and other exclusions change both bases', () => {
  const included = { actual_units: 10, actual_units_forecast_basis: 10 } as SalesOverviewResponse['products'][number];
  const excludeRts = { actual_units: 7, actual_units_forecast_basis: 10 } as SalesOverviewResponse['products'][number];
  const alsoExcludeCancel = { actual_units: 5, actual_units_forecast_basis: 8 } as SalesOverviewResponse['products'][number];
  const forecast = projectSalesReport(basis, 20);
  assert.equal(cogsUnitsValue(included.actual_units), 10);
  assert.equal(cogsUnitsValue(excludeRts.actual_units), 7);
  assert.equal(cogsUnitsValue(alsoExcludeCancel.actual_units), 5);
  assert.equal(forecastProductValues(included, forecast).actual_units, 8);
  assert.equal(forecastProductValues(excludeRts, forecast).actual_units, 8);
  assert.equal(forecastProductValues(alsoExcludeCancel, forecast).actual_units, 6.4);
});

test('unknown quantity remains unknown even at 100% RTS while explicit zero stays zero', () => {
  for (const pct of [0, 20, 100]) {
    assert.equal(forecastCogsUnits(0, pct), 0);
    for (const value of [null, undefined, '', '7', -1, 1.5, Number.NaN, Infinity]) {
      assert.equal(forecastCogsUnits(value, pct), null);
    }
    const forecast = projectSalesReport(basis, pct);
    const unknown = { actual_units: 7, actual_units_forecast_basis: null } as SalesOverviewResponse['products'][number];
    assert.equal(forecastProductValues(unknown, forecast).actual_units, null);
    assert.equal(Object.hasOwn(forecastProductValues({} as SalesOverviewResponse['products'][number], forecast), 'actual_units'), false);
    assert.equal(Object.hasOwn(forecastKpiValues({} as SalesOverviewResponse['kpis'], forecast), 'actual_units'), false);
  }
});

test('Actual and Forecast exports include correctly labeled quantities only when authorized, adjacent to COGS', () => {
  const row: SalesProductsExportRow = {
    product: 'Example', grossRevenue: 100, grossSales: 1.25, cogs: 0, aov: 80, cpp: 10,
    processedCpp: 10, adSpend: 12.5, arPct: 12.5, rtsPct: 23, pePct: 50,
    contributionMargin: 10, cmRtsForecast: 20, netMargin: 30, units: 7,
  };
  const input = {
    startDate: '2026-10-01', endDate: '2026-10-20', cmRtsLabel: 'CM (RTS 23%)',
    rows: [...Array.from({ length: 30 }, () => row), { ...row, units: 0 }, { ...row, units: null }],
  };
  for (const view of ['actual', 'forecast'] as const) {
    const rows = input.rows.map(item => ({ ...item, units: item.units === null ? null : view === 'forecast' ? (item.units ?? 0) * .8 : item.units }));
    const authorized = salesProductsExportGrid({ ...input, rows, view, includeUnits: true });
    assert.equal(authorized.headers[4], view === 'actual' ? 'Actual Units' : 'Forecast Units');
    assert.equal(authorized.rows.length, 32);
    assert.equal(authorized.rows[0][4], view === 'actual' ? 7 : 7 * .8);
    assert.equal(authorized.rows[30][4], 0);
    assert.equal(authorized.rows[31][4], '');
    assert.equal(authorized.indices[4], 14);
    const hidden = salesProductsExportGrid({ ...input, view });
    assert.equal(hidden.headers.includes('Actual Units'), false);
    assert.equal(hidden.headers.includes('Forecast Units'), false);
    assert.equal(hidden.indices.includes(14), false);
    assert.equal(hidden.headers.length, view === 'actual' ? 14 : 12);
  }
});

test('each included or excluded component changes the forecast population once', () => {
  const kpis = {
    gross_cod: 12_000, canceled_cod: 1_000, restocking_cod: 500, abandoned_cod: 500,
    cogs_forecast_basis: 3_000, ad_spend: 1_000, sf_fees: 500, ff_fees: 100, if_fees: 50,
    delivered: 5_000, cod_fee_delivered: 100,
  } as SalesOverviewResponse['kpis'];
  const counts = { purchases: 8, rts: 2 } as SalesOverviewResponse['counts'];
  for (const excludeCancel of [true, false]) for (const excludeRestocking of [true, false]) for (const excludeAbandoned of [true, false]) {
    const result = forecastSalesKpis(kpis, counts, { ...options, excludeCancel, excludeRestocking, excludeAbandoned }, 20);
    assert.equal(result.revenueBase, 12_000 - (excludeCancel ? 1_000 : 0) - (excludeRestocking ? 500 : 0) - (excludeAbandoned ? 500 : 0));
    assert.equal(result.revenue, result.revenueBase * .8);
  }
});

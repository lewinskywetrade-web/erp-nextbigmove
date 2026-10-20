import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSalesKpiForecast,
  buildSalesProductForecast,
  getSafeRtsForecastPct,
} from '../src/app/(dashboard)/analytics/_utils/sales-forecast';

const options = {
  excludeCancel: true,
  excludeRestocking: true,
  excludeAbandoned: true,
  excludeRts: true,
};

// These are already net of repurchase: total COGS 1,600, canceled 100,
// restocking 50. The API product's adjusted COGS is consequently 1,450.
const amounts = {
  canceled_cod: 500,
  restocking_cod: 200,
  abandoned_cod: 300,
  ad_spend: 500,
  sf_fees: 100,
  ff_fees: 20,
  if_fees: 10,
  cod_fee_delivered: 40,
  cogs_canceled: 100,
  cogs_restocking: 50,
  cogs_rts: 80,
};
const kpis = { ...amounts, gross_cod: 8_000, cogs: 1_600 };
const counts = { purchases: 6, rts: 1 };
const product = {
  ...amounts,
  cod_raw: 8_000,
  gross_sales: 6,
  rts_count: 1,
  cogs_raw: 1_600,
  cogs: 1_450,
  cogs_ec: 1_500,
};

test('repurchase-adjusted KPI and product use the same cost once', () => {
  const total = buildSalesKpiForecast(kpis, counts, options, 20);
  const row = buildSalesProductForecast(product, options, 20);
  assert.equal(total.revenueBase, 7_000);
  assert.equal(total.cogsAdjusted, 1_450);
  assert.equal(row.cogsAdjusted, 1_450);
  assert.equal(row.cogsCanceled, 100);
  // 5,600 revenue - 500 ads - 130 fulfillment - 40 COD - 1,450 COGS + 80 RTS.
  assert.equal(total.cmForecast, 3_560);
  assert.equal(row.cmForecast, 3_560);
});

for (const excludeCancel of [false, true]) {
  for (const excludeRestocking of [false, true]) {
    test(`status exclusions apply once: canceled=${excludeCancel}, restocking=${excludeRestocking}`, () => {
      const selected = { ...options, excludeCancel, excludeRestocking };
      const cost = 1_600 - (excludeCancel ? 100 : 0) - (excludeRestocking ? 50 : 0);
      const revenueBase = 8_000 - 300 - (excludeCancel ? 500 : 0) - (excludeRestocking ? 200 : 0);
      const expected = revenueBase * 0.8 - 500 - 130 - 40 - cost + 80;
      const total = buildSalesKpiForecast(kpis, counts, selected, 20);
      const row = buildSalesProductForecast({ ...product, cogs: cost }, selected, 20);
      assert.ok(Math.abs(total.cmForecast - expected) < 1e-9);
      assert.ok(Math.abs(row.cmForecast - expected) < 1e-9);
      assert.equal(row.cogsAdjusted, cost);
    });
  }
}

test('API 20% forecast is authoritative, including a zero result', () => {
  assert.equal(buildSalesKpiForecast({ ...kpis, cm_rts_forecast: 0 }, counts, options, 20).cmForecast, 0);
  assert.equal(buildSalesProductForecast({ ...product, cm_rts_forecast: 0 }, options, 20).cmForecast, 0);
});

test('custom RTS scenario changes only revenue from the API baseline', () => {
  const total = buildSalesKpiForecast({ ...kpis, cm_rts_forecast: 3_560 }, counts, options, 30);
  const row = buildSalesProductForecast({ ...product, cm_rts_forecast: 3_560 }, options, 30);
  assert.ok(Math.abs(total.cmForecast - 2_860) < 1e-9);
  assert.ok(Math.abs(row.cmForecast - 2_860) < 1e-9);
  assert.equal(total.cogsAdjusted, 1_450);
  assert.equal(row.cogsAdjusted, 1_450);
});

test('current and previous periods retain their own forecast inputs', () => {
  const current = buildSalesKpiForecast({ ...kpis, cm_rts_forecast: 3_560 }, counts, options, 30);
  const previous = buildSalesKpiForecast(
    { gross_cod: 2_000, cogs: 500, cm_rts_forecast: 1_100 },
    { purchases: 2, rts: 0 }, options, 30,
  );
  assert.ok(Math.abs(current.cmForecast - 2_860) < 1e-9);
  assert.equal(previous.revenueBase, 2_000);
  assert.equal(previous.cmForecast, 900);
});

test('team forecast excludes abandoned revenue just as its API does', () => {
  const row = buildSalesProductForecast(product, options, 40);
  assert.equal(row.revenueBase, 7_000);
  assert.equal(row.revenueAfterRts, 4_200);
  assert.equal(row.cmForecast, 2_160);
});

test('repurchase included response is consumed without another repurchase adjustment', () => {
  const total = buildSalesKpiForecast({
    gross_cod: 10_000, canceled_cod: 800, restocking_cod: 400, abandoned_cod: 500,
    cogs: 2_000, cogs_canceled: 300, cogs_restocking: 200,
  }, { purchases: 8, rts: 1 }, options, 20);
  assert.equal(total.revenueBase, 8_300);
  assert.equal(total.cogsAdjusted, 1_500);
  assert.equal(total.cmForecast, 5_140);
});

test('no-purchase response keeps the API zero-revenue behavior and costs', () => {
  const result = buildSalesKpiForecast(kpis, { purchases: 0, rts: 0 }, options, 20);
  assert.equal(result.revenueBase, 0);
  assert.equal(result.cmForecast, -2_040);
});

test('RTS scenario retains the existing 0–100 bounds and invalid-input default', () => {
  assert.equal(getSafeRtsForecastPct(-1), 0);
  assert.equal(getSafeRtsForecastPct(101), 100);
  assert.equal(getSafeRtsForecastPct(Number.NaN), 20);
  assert.equal(getSafeRtsForecastPct(Number.POSITIVE_INFINITY), 20);
});


test('live RTS exclusions change displayed COGS but not the separately quoted RTS scenario', () => {
  for (const excludeRts of [false, true]) {
    const selected = { ...options, excludeRts };
    const current = { ...product, cogs: excludeRts ? 1300 : 1380, cogs_forecast_basis: 1380,
      cogs_abandoned: 70, cogs_rts_credit: excludeRts ? 0 : 80 };
    const total = { ...kpis, cogs_adjusted: current.cogs, cogs_forecast_basis: 1380, cogs_abandoned: 70 };
    const row = buildSalesProductForecast(current, selected, 20);
    const kpi = buildSalesKpiForecast(total, counts, selected, 20);
    assert.equal(row.cogsAdjusted, 1380);
    assert.equal(kpi.cogsAdjusted, 1380);
    assert.equal(row.cmForecast, 3630);
    assert.equal(kpi.cmForecast, 3630);
    assert.equal(buildSalesProductForecast({ ...current, cm_rts_forecast: 3630 }, selected, 30).cmForecast, 2930);
  }
});

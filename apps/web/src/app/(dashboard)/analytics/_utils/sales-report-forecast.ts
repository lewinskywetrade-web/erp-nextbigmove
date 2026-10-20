import type { SalesOverviewResponse } from '../_types/sales';
import { getSafeRtsForecastPct, type SalesForecastOptions } from './sales-forecast';
import { forecastCogsUnits } from './actual-cogs-units';

type Kpis = SalesOverviewResponse['kpis'];
type Counts = SalesOverviewResponse['counts'];
type Product = SalesOverviewResponse['products'][number];
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown) => finite(value) && value >= 0 ? value : Number.NaN;
const amount = (value: unknown) => finite(value) ? value : Number.NaN;
const ratio = (numerator: number, denominator: number, multiplier = 1) =>
  finite(numerator) && finite(denominator) && denominator > 0
    ? numerator / denominator * multiplier : Number.NaN;

export type SalesReportForecast = {
  revenue: number; orders: number; cogs: number; rtsRevenue: number; rtsOrders: number;
  adSpend: number; shipping: number; fulfillment: number; ifFees: number;
  codFees: number; codFeeRate: number; margin: number; rtsPct: number;
  revenueBase: number; cogsBase: number; ordersBase: number;
  aov: number; cpp: number; arPct: number; profitEfficiency: number;
};

// A blended rate for the selected cohort is used for both totals and every row,
// so changing grouping cannot introduce different fee assumptions.
export function observedCodFeeRate(kpis: Kpis): number {
  return ratio(nonnegative(kpis.cod_fee_delivered), nonnegative(kpis.delivered));
}

export function projectSalesReport(inputs: {
  revenue: number; orders: number; cogs: number; adSpend: number;
  shipping: number; fulfillment: number; ifFees: number; codFeeRate: number;
}, rtsPct: number): SalesReportForecast {
  const safePct = getSafeRtsForecastPct(rtsPct), success = 1 - safePct / 100;
  const revenueBase = nonnegative(inputs.revenue), ordersBase = nonnegative(inputs.orders);
  const cogsBase = nonnegative(inputs.cogs);
  const revenue = revenueBase * success, orders = ordersBase * success, cogs = cogsBase * success;
  const codFeeRate = nonnegative(inputs.codFeeRate);
  // No successful sales means no percentage COD fee. A positive sales scenario
  // without an observed delivered rate remains unavailable, never fabricated 0.
  const codFees = revenue === 0 ? 0 : revenue * codFeeRate;
  const adSpend = amount(inputs.adSpend), shipping = amount(inputs.shipping);
  const fulfillment = amount(inputs.fulfillment), ifFees = amount(inputs.ifFees);
  const margin = revenue - cogs - adSpend - shipping - fulfillment - ifFees - codFees;
  return {
    revenue, orders, cogs, rtsRevenue: revenueBase * safePct / 100,
    rtsOrders: ordersBase * safePct / 100, adSpend, shipping, fulfillment, ifFees,
    codFees, codFeeRate, margin, rtsPct: safePct, revenueBase, cogsBase, ordersBase,
    aov: ratio(revenue, orders), cpp: ratio(adSpend, orders),
    arPct: ratio(adSpend, revenue, 100), profitEfficiency: ratio(margin, adSpend, 100),
  };
}

function revenueBeforeRts(raw: number | undefined, amounts: {
  canceled_cod?: number; restocking_cod?: number; abandoned_cod?: number;
}, options: SalesForecastOptions) {
  return amount(raw)
    - (options.excludeCancel ? amount(amounts.canceled_cod) : 0)
    - (options.excludeRestocking ? amount(amounts.restocking_cod) : 0)
    - (options.excludeAbandoned ? amount(amounts.abandoned_cod) : 0);
}

export function forecastSalesKpis(kpis: Kpis, counts: Counts, options: SalesForecastOptions, rtsPct: number) {
  return projectSalesReport({
    revenue: revenueBeforeRts(kpis.gross_cod, kpis, options),
    orders: amount(counts.purchases) + (options.excludeRts ? amount(counts.rts) : 0),
    cogs: amount(kpis.cogs_forecast_basis),
    adSpend: amount(kpis.ad_spend), shipping: amount(kpis.sf_fees),
    fulfillment: amount(kpis.ff_fees), ifFees: amount(kpis.if_fees),
    codFeeRate: observedCodFeeRate(kpis),
  }, rtsPct);
}

export function forecastSalesProduct(row: Product, options: SalesForecastOptions, rtsPct: number, codFeeRate: number) {
  return projectSalesReport({
    revenue: revenueBeforeRts(row.cod_raw, row, options),
    orders: amount(row.gross_sales) + (options.excludeRts ? amount(row.rts_count) : 0),
    cogs: amount(row.cogs_forecast_basis), adSpend: amount(row.ad_spend),
    shipping: amount(row.sf_raw), fulfillment: amount(row.ff_raw), ifFees: amount(row.if_raw),
    codFeeRate,
  }, rtsPct);
}

export function forecastKpiValues(kpis: Kpis, forecast: SalesReportForecast): Kpis {
  return {
    ...kpis, revenue: forecast.revenue, delivered: forecast.revenue, rts: forecast.rtsRevenue,
    ...(Object.prototype.hasOwnProperty.call(kpis, 'actual_units')
      ? { actual_units: forecastCogsUnits(kpis.actual_units_forecast_basis, forecast.rtsPct) } : {}),
    cogs: forecast.cogs, cogs_adjusted: forecast.cogs, cogs_rts_credit: 0,
    contribution_margin: forecast.margin, net_margin: forecast.margin, cm_rts_forecast: forecast.margin,
    aov: forecast.aov, cpp: forecast.cpp, ar_pct: forecast.arPct,
    profit_efficiency: forecast.profitEfficiency, rts_pct: forecast.rtsPct,
  };
}

export function forecastProductValues(row: Product, forecast: SalesReportForecast): Product {
  return {
    ...row, revenue: forecast.revenue, gross_sales: forecast.orders, cogs: forecast.cogs,
    ...(Object.prototype.hasOwnProperty.call(row, 'actual_units')
      ? { actual_units: forecastCogsUnits(row.actual_units_forecast_basis, forecast.rtsPct) } : {}),
    contribution_margin: forecast.margin, net_margin: forecast.margin, cm_rts_forecast: forecast.margin,
    aov: forecast.aov, cpp: forecast.cpp, ar_pct: forecast.arPct,
    profit_efficiency: forecast.profitEfficiency, delivered_count: forecast.orders, rts_count: forecast.rtsOrders,
  };
}

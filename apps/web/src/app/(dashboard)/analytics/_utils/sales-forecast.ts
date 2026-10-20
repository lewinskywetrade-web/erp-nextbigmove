// Sales overview endpoints currently return the 20% scenario. Custom scenarios
// change only that scenario's revenue assumption, keeping the API's cost basis.
const API_RTS_FORECAST_PCT = 20;

export type SalesForecastOptions = {
  excludeCancel: boolean;
  excludeRestocking: boolean;
  excludeAbandoned?: boolean;
  excludeRts: boolean;
};

type ForecastAmounts = {
  cogs?: number;
  cogs_forecast_basis?: number;
  cogs_canceled?: number;
  cogs_abandoned?: number | null;
  cogs_restocking?: number;
  cogs_rts?: number;
  canceled_cod?: number;
  restocking_cod?: number;
  abandoned_cod?: number;
  ad_spend?: number;
  sf_fees?: number;
  ff_fees?: number;
  if_fees?: number;
  cod_fee_delivered?: number;
  cm_rts_forecast?: number;
};

export function getSafeRtsForecastPct(pct: number) {
  return Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : API_RTS_FORECAST_PCT));
}

function adjustedCod(cod: number, amounts: ForecastAmounts, opts: SalesForecastOptions) {
  return cod
    - (opts.excludeCancel ? amounts.canceled_cod ?? 0 : 0)
    - (opts.excludeRestocking ? amounts.restocking_cod ?? 0 : 0)
    - (opts.excludeAbandoned ? amounts.abandoned_cod ?? 0 : 0);
}

function forecast(params: {
  amounts: ForecastAmounts;
  adjustedCod: number;
  purchases: number;
  cogsTotal: number;
  cogsCanceled: number;
  cogsRestocking: number;
  cogsAdjusted: number;
  sf: number;
  ff: number;
  iF: number;
  codFeeDelivered: number;
  rtsPct: number;
}) {
  const { amounts, cogsTotal, cogsCanceled, cogsRestocking, cogsAdjusted, sf, ff, iF, codFeeDelivered } = params;
  const purchases = Math.max(0, params.purchases);
  const aov = purchases > 0 ? params.adjustedCod / purchases : 0;
  const revenueBase = aov * purchases;
  const rtsFraction = getSafeRtsForecastPct(params.rtsPct) / 100;
  const revenueAfterRts = (1 - rtsFraction) * revenueBase;
  const adSpend = amounts.ad_spend ?? 0;
  const cogsRts = amounts.cogs_rts ?? 0;
  const localForecast = revenueAfterRts - adSpend - sf - ff - iF
    - codFeeDelivered - cogsAdjusted + cogsRts;
  const apiForecast = amounts.cm_rts_forecast;
  const cmForecast = typeof apiForecast === 'number' && Number.isFinite(apiForecast)
    ? apiForecast + (API_RTS_FORECAST_PCT / 100 - rtsFraction) * revenueBase
    : localForecast;
  return {
    purchases, aov, revenueBase, revenueAfterRts, rtsFraction, cmForecast,
    cogsTotal, cogsCanceled, cogsRestocking, cogsAdjusted,
    adSpend, sf, ff, iF, codFeeDelivered, cogsRts,
  };
}

export function buildSalesKpiForecast(
  kpis: ForecastAmounts & { gross_cod?: number },
  counts: { purchases?: number; rts?: number },
  opts: SalesForecastOptions,
  rtsPct: number,
) {
  // All components already use the API's selected repurchase policy. KPI cogs
  // is the total; subtract only the matching excluded components, once.
  const cogsTotal = kpis.cogs ?? 0;
  const cogsCanceled = opts.excludeCancel ? kpis.cogs_canceled ?? 0 : 0;
  const cogsRestocking = opts.excludeRestocking ? kpis.cogs_restocking ?? 0 : 0;
  return forecast({
    amounts: kpis,
    adjustedCod: adjustedCod(kpis.gross_cod ?? 0, kpis, opts),
    purchases: (counts.purchases ?? 0) + (opts.excludeRts ? counts.rts ?? 0 : 0),
    cogsTotal, cogsCanceled, cogsRestocking,
    cogsAdjusted: kpis.cogs_forecast_basis ?? cogsTotal - cogsCanceled - cogsRestocking
      - (opts.excludeAbandoned ? kpis.cogs_abandoned ?? 0 : 0),
    sf: kpis.sf_fees ?? 0,
    ff: kpis.ff_fees ?? 0,
    iF: kpis.if_fees ?? 0,
    codFeeDelivered: kpis.cod_fee_delivered ?? 0,
    rtsPct,
  });
}

export function buildSalesProductForecast(
  row: ForecastAmounts & {
    revenue?: number;
    gross_sales?: number;
    cod_raw?: number;
    rts_count?: number;
    cogs_raw?: number;
    sf_raw?: number;
    ff_raw?: number;
    if_raw?: number;
    cod_fee_delivered_raw?: number;
  },
  opts: SalesForecastOptions,
  rtsPct: number,
) {
  return forecast({
    amounts: row,
    adjustedCod: adjustedCod(row.cod_raw ?? row.revenue ?? 0, row, opts),
    purchases: (row.gross_sales ?? 0) + (opts.excludeRts ? row.rts_count ?? 0 : 0),
    cogsTotal: row.cogs_raw ?? row.cogs ?? 0,
    cogsCanceled: opts.excludeCancel ? row.cogs_canceled ?? 0 : 0,
    cogsRestocking: opts.excludeRestocking ? row.cogs_restocking ?? 0 : 0,
    // The scenario retains RTS in its own cost basis even when the live table
    // excludes RTS. Older endpoints still return the original adjusted COGS.
    cogsAdjusted: row.cogs_forecast_basis ?? row.cogs ?? 0,
    sf: row.sf_raw ?? row.sf_fees ?? 0,
    ff: row.ff_raw ?? row.ff_fees ?? 0,
    iF: row.if_raw ?? row.if_fees ?? 0,
    codFeeDelivered: row.cod_fee_delivered_raw ?? row.cod_fee_delivered ?? 0,
    rtsPct,
  });
}

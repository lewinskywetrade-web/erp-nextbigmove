export type SalesAttributionKpis = {
  revenue: number;
  delivered: number;
  shipped: number;
  waiting_pickup: number;
  rts: number;
  ad_spend: number;
  processed: number;
  cancellation_rate_pct: number;
  ar_pct: number;
  profit_efficiency: number;
  conversion_rate: number;
  aov: number;
  cpp: number;
  processed_cpp: number;
  confirmed: number;
  unconfirmed: number;
  canceled: number;
  contribution_margin: number;
  net_margin: number;
  cogs: number;
  cogs_adjusted?: number;
  cogs_rts_credit?: number;
  cogs_forecast_basis?: number;
  cogs_canceled: number;
  cogs_restocking: number;
  cogs_rts: number;
  cogs_delivered: number;
  cod_fee: number;
  cod_fee_delivered: number;
  gross_cod: number;
  rts_cod: number;
  canceled_cod: number;
  restocking_cod: number;
  abandoned_cod: number;
  sf_fees: number;
  ff_fees: number;
  if_fees: number;
  cm_rts_forecast?: number;
  rts_pct?: number;
  sf_sdr_fees: number;
  ff_sdr_fees: number;
  if_sdr_fees: number;
};

export type SalesAttributionCounts = {
  purchases: number;
  delivered: number;
  shipped: number;
  waiting_pickup: number;
  rts: number;
  undelivered: number;
  returned: number;
  restocking: number;
  confirmed: number;
  unconfirmed: number;
  canceled: number;
};

export type SalesAttributionProductRow = {
  mapping: string | null;
  revenue: number;
  gross_sales: number;
  cogs: number;
  cogs_raw?: number;
  cogs_canceled?: number;
  cogs_rts_credit?: number;
  cogs_forecast_basis?: number;
  aov: number;
  cpp: number;
  processed_cpp: number;
  ad_spend: number;
  ar_pct: number;
  profit_efficiency: number;
  contribution_margin: number;
  cm_rts_forecast?: number;
  net_margin: number;
  sf_fees?: number;
  ff_fees?: number;
  if_fees?: number;
  cod_fee_delivered?: number;
  cogs_rts?: number;
  rts_count?: number;
  delivered_count?: number;
  cod_raw?: number;
  purchases_raw?: number;
  sf_raw?: number;
  ff_raw?: number;
  if_raw?: number;
  cod_fee_delivered_raw?: number;
  cogs_ec?: number;
  cogs_restocking?: number;
  canceled_cod?: number;
  restocking_cod?: number;
  rts_cod?: number;
  abandoned_cod?: number;
};

export type SalesAttributionDeliveryStatusRow = {
  mapping: string | null;
  total_orders: number;
  new_orders: number;
  restocking: number;
  confirmed: number;
  printed: number;
  waiting_pickup: number;
  shipped: number;
  delivered: number;
  rts: number;
  canceled: number;
  deleted: number;
};

export type SalesAttributionFilters = {
  teamCodes: string[];
  teamCodeDisplayMap: Record<string, string>;
  mappings: string[];
  mappingsDisplayMap: Record<string, string>;
};

export type SalesAttributionSelected = {
  start_date: string;
  end_date: string;
  teamCode: string | null;
  mappings: string[];
};

export type SalesAttributionVolumeGrowthRow = {
  date: string;
  shipped: number;
  delivered: number;
  rts: number;
};

export type SalesAttributionOverviewContract = {
  kpis: SalesAttributionKpis;
  prevKpis: SalesAttributionKpis;
  counts: SalesAttributionCounts;
  prevCounts: SalesAttributionCounts;
  products: SalesAttributionProductRow[];
  deliveryStatuses?: SalesAttributionDeliveryStatusRow[];
  filters: SalesAttributionFilters;
  selected: SalesAttributionSelected;
  rangeDays: number;
  lastUpdatedAt: Date | string | null;
  volumeGrowthTrend?: SalesAttributionVolumeGrowthRow[];
};

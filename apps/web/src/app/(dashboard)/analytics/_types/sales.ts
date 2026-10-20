export type SalesOverviewResponse = {
  coverage?: {
    basis: string;
    feeBasis: string;
    ambiguousShopCount: number;
    ambiguousOrderCount: number;
    zeroCogsOrderCount: number;
    unattributedAdRows: number;
    unattributedAdSpend: number;
    previousUnattributedAdRows: number;
    previousUnattributedAdSpend: number;
    unknownSelectedStoreCount: number;
    hasCanonicalDifferences: boolean;
    canonicalMinusSource: { current: Record<string, number>; previous: Record<string, number> };
  };
  kpis: {
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
    cogs_abandoned?: number | null;
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
  prevKpis: {
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
    cogs_abandoned?: number | null;
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
  counts: {
    purchases: number;
    delivered: number;
    shipped: number;
    waiting_pickup: number;
    rts: number;
    restocking: number;
    confirmed: number;
    unconfirmed: number;
    canceled: number;
  };
  statusDistribution: {
    total: number;
    delivered: number;
    shipped: number;
    waiting_pickup: number;
    rts: number;
    restocking: number;
    confirmed: number;
    unconfirmed: number;
    canceled: number;
  };
  prevCounts: {
    purchases: number;
    delivered: number;
    shipped: number;
    waiting_pickup: number;
    rts: number;
    restocking: number;
    confirmed: number;
    unconfirmed: number;
    canceled: number;
  };
  products: Array<{
    mapping: string | null;
    revenue: number;
    gross_sales: number;
    cogs: number;
    cogs_adjusted?: number;
    cogs_abandoned?: number | null;
    cogs_rts_credit?: number;
    cogs_forecast_basis?: number;
    aov: number;
    cpp: number;
    processed_cpp: number;
    ad_spend: number;
    ar_pct: number;
    profit_efficiency: number;
    contribution_margin: number;
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
    cogs_raw?: number;
    cogs_canceled?: number;
    cogs_ec?: number;
    cogs_restocking?: number;
    canceled_cod?: number;
    restocking_cod?: number;
    rts_cod?: number;
    abandoned_cod?: number;
    cm_rts_forecast?: number;
  }>;
  deliveryStatuses?: Array<{
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
  }>;
  filters: { mappings: string[]; mappingsDisplayMap: Record<string, string> };
  selected: { start_date: string; end_date: string; mappings: string[] };
  rangeDays: number;
  lastUpdatedAt: string | null;
};

export const salesMetricDefinitions: Array<{
  key: keyof SalesOverviewResponse['kpis'];
  label: string;
  format: 'currency' | 'number' | 'percent';
  countKey?: keyof SalesOverviewResponse['counts'];
  countLabel?: string;
}> = [
  { key: 'revenue', label: 'Revenue (₱)', format: 'currency', countKey: 'purchases', countLabel: 'Orders' },
  { key: 'unconfirmed', label: 'New (₱)', format: 'currency', countKey: 'unconfirmed', countLabel: 'Orders' },
  { key: 'restocking_cod', label: 'Restocking (₱)', format: 'currency', countKey: 'restocking', countLabel: 'Orders' },
  { key: 'confirmed', label: 'Confirmed (₱)', format: 'currency', countKey: 'confirmed', countLabel: 'Orders' },
  { key: 'waiting_pickup', label: 'Wait for Pickup (₱)', format: 'currency', countKey: 'waiting_pickup', countLabel: 'Waiting' },
  { key: 'canceled', label: 'Canceled (₱)', format: 'currency', countKey: 'canceled', countLabel: 'Orders' },
  { key: 'shipped', label: 'Shipped (₱)', format: 'currency', countKey: 'shipped', countLabel: 'Shipped' },
  { key: 'rts', label: 'RTS (₱)', format: 'currency', countKey: 'rts', countLabel: 'Orders' },
  { key: 'delivered', label: 'Delivered (₱)', format: 'currency', countKey: 'delivered', countLabel: 'Orders' },
] as const;

export const salesSecondaryMetricDefinitions: Array<{
  key: keyof SalesOverviewResponse['kpis'];
  label: string;
  format: 'currency' | 'number' | 'percent';
}> = [
  { key: 'cm_rts_forecast', label: 'CM (RTS 20%)', format: 'currency' },
  { key: 'ad_spend', label: 'Ad Spend (₱)', format: 'currency' },
  { key: 'ar_pct', label: 'AR (%)', format: 'percent' },
  { key: 'aov', label: 'AOV (₱)', format: 'currency' },
  { key: 'cancellation_rate_pct', label: 'Cancellation Rate (%)', format: 'percent' },
  { key: 'cpp', label: 'CPP (₱)', format: 'currency' },
  { key: 'processed_cpp', label: 'Processed CPP (₱)', format: 'currency' },
  { key: 'rts_pct', label: 'RTS (%)', format: 'percent' },
  { key: 'conversion_rate', label: 'Conversion Rate (%)', format: 'percent' },
  { key: 'profit_efficiency', label: 'Profit Efficiency (%)', format: 'percent' },
  { key: 'contribution_margin', label: 'Contribution Margin (₱)', format: 'currency' },
  { key: 'net_margin', label: 'Net Margin (₱)', format: 'currency' },
];

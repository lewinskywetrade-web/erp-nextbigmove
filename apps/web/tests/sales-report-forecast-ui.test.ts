import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnalyticsSalesProductsTable, type SalesProductRowItem } from '../src/app/(dashboard)/analytics/_components/analytics-sales-products-table';

function render(view: 'actual' | 'forecast', options: { showUnits?: boolean; units?: number | null; totalUnits?: number | null } = {}) {
  const row = {
    row: {
      mapping: 'Example', revenue: 1234, gross_sales: 1.25, cogs: 0,
      aov: 987.2, cpp: 0, processed_cpp: 0, ad_spend: 0, ar_pct: 0,
      profit_efficiency: Number.NaN, contribution_margin: Number.NaN, net_margin: Number.NaN,
      actual_delivered_units: options.units,
    },
    index: 0,
    derived: {
      display: 'Example', forecast: { revenueAfterRts: 1234, cmForecast: Number.NaN },
      rtsPct: 23, sf: 1, ff: 2, iF: 3, codFeeDelivered: Number.NaN,
      cogsAdjusted: 0, cogsRts: 0,
    },
  } satisfies SalesProductRowItem;
  return renderToStaticMarkup(createElement(AnalyticsSalesProductsTable, {
    reportView: view, entityLabel: 'Store', isLoading: false, productStart: 1, productEnd: 1,
    totalProducts: 1, onPrevious() {}, onNext() {}, canPrevious: false, canNext: false,
    pageSize: 20, productPage: 1, totalProductPages: 1, rtsForecastSafe: 23,
    rows: [row], sourceCount: 1, renderSortLabel: label => label,
    showActualDeliveredUnits: options.showUnits,
    ...(options.totalUnits !== undefined ? { totals: {
      revenue: 1234, grossSales: 1.25, cogs: 0, aov: 987.2, cpp: 0, processedCpp: 0,
      adSpend: 0, arPct: 0, rtsPct: 23, profitEfficiency: Number.NaN, contributionMargin: Number.NaN,
      cmRtsForecast: Number.NaN, netMargin: Number.NaN, actualDeliveredUnits: options.totalUnits,
    } } : {}),
  }));
}

test('Forecast table renders projected labels, fractional expected orders and unavailable margins', () => {
  const html = render('forecast');
  assert.match(html, /Forecast Revenue/);
  assert.match(html, /Forecast COGS/);
  assert.match(html, /Forecast Net \(before overhead\)/);
  assert.match(html, /Assumed RTS %/);
  assert.match(html, />1.25</);
  assert.match(html, /—/);
  assert.doesNotMatch(html, /NaN|Processed CPP|CM \(RTS/);
  assert.equal((html.match(/<th /g) ?? []).length, 13);
  assert.equal((html.match(/<td /g) ?? []).length, 13);
});

for (const view of ['actual', 'forecast'] as const) {
  test(`${view} protected quantity column is directly beside COGS with actual row and total units`, () => {
    const html = render(view, { showUnits: true, units: 7, totalUnits: 17 });
    assert.match(html, /Actual Units Delivered/);
    assert.match(html, /not the number of orders or a forecast/);
    const headings = [...html.matchAll(/<th [^>]*>(.*?)<\/th>/g)].map(match => match[1]);
    const cogs = headings.findIndex(heading => heading.includes(view === 'actual' ? '>COGS<' : 'Forecast COGS') || heading === 'COGS');
    assert.ok(cogs >= 0);
    assert.match(headings[cogs + 1], /Actual Units Delivered/);
    assert.match(html, />7<\/td>/);
    assert.match(html, />17<\/td>/);
    assert.equal(headings.length, view === 'actual' ? 16 : 14);
  });
  test(`${view} omits protected quantity cells and headers without authorization even if payload contains them`, () => {
    const html = render(view, { units: 876543, totalUnits: 987654 });
    assert.doesNotMatch(html, /Actual Units Delivered|876,543|987,654/);
    assert.equal((html.match(/<th /g) ?? []).length, view === 'actual' ? 15 : 13);
  });
  test(`${view} actual quantity distinguishes intentional zero from missing evidence`, () => {
    const zero = render(view, { showUnits: true, units: 0, totalUnits: 0 });
    const missing = render(view, { showUnits: true, units: null, totalUnits: null });
    const rowCells = (html: string) => [...html.split('<tbody')[1].split('</tbody>')[0].matchAll(/<td [^>]*>(.*?)<\/td>/g)].map(match => match[1]);
    assert.equal(rowCells(zero)[5], '0');
    assert.equal(rowCells(missing)[5], '—');
  });
}

test('Actual table retains original columns and label semantics', () => {
  const html = render('actual');
  assert.match(html, /Gross Revenue/);
  assert.match(html, /Processed CPP/);
  assert.match(html, /CM \(RTS/);
  assert.doesNotMatch(html, /Forecast COGS|Expected Deliveries/);
  assert.equal((html.match(/<th /g) ?? []).length, 15);
  assert.equal((html.match(/<td /g) ?? []).length, 15);
});

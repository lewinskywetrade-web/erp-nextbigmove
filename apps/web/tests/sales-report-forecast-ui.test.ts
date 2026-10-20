import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnalyticsSalesProductsTable, type SalesProductRowItem } from '../src/app/(dashboard)/analytics/_components/analytics-sales-products-table';

function render(view: 'actual' | 'forecast') {
  const row = {
    row: {
      mapping: 'Example', revenue: 1234, gross_sales: 1.25, cogs: 0,
      aov: 987.2, cpp: 0, processed_cpp: 0, ad_spend: 0, ar_pct: 0,
      profit_efficiency: Number.NaN, contribution_margin: Number.NaN, net_margin: Number.NaN,
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

test('Actual table retains original columns and label semantics', () => {
  const html = render('actual');
  assert.match(html, /Gross Revenue/);
  assert.match(html, /Processed CPP/);
  assert.match(html, /CM \(RTS/);
  assert.doesNotMatch(html, /Forecast COGS|Expected Deliveries/);
  assert.equal((html.match(/<th /g) ?? []).length, 15);
  assert.equal((html.match(/<td /g) ?? []).length, 15);
});

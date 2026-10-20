const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const base = path.resolve(__dirname, '../src/app/(dashboard)/analytics');
function load(file, resolve = require) {
  const code = ts.transpileModule(fs.readFileSync(path.join(base, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: resolve });
  return module.exports;
}
const { zeroCogsReviewPriority: priority, applySuperAdminCogsReview: prepare } = load('_utils/zero-cogs-review.ts');
function item(id, orders, cost, delivered, enabled = true) {
  return { id, row: { gross_sales: orders, cogs: cost }, zeroCogsPriority: priority({ gross_sales: orders, cogs: cost }, delivered, enabled) };
}
test('delivered zero-cost single-unit orders come first before pagination, zero-order rows disappear', () => {
  const rows = [
    item('normal', 500, 1000, 400), item('no-orders', 0, 0, 0),
    item('active-zero', 2, 0, 0), item('delivered-zero', 1, 0, 1),
    item('delivered-zero-2', 10, 0, 9), item('unknown', 2, null, 2),
  ];
  const result = prepare(rows, true);
  assert.equal(result.map(x => x.id).join(','), 'delivered-zero,delivered-zero-2,active-zero,normal,unknown');
  assert.equal(result.slice(0,1)[0].id, 'delivered-zero');
  assert.equal(rows[0].id, 'normal'); // no mutation of original/server ordering
});
test('ordinary users retain all original rows and sorting with no review flag', () => {
  const rows = [item('no-orders', 0, 0, 0, false), item('delivered', 1, 0, 1, false)];
  assert.equal(prepare(rows, false), rows);
  assert.equal(priority({ gross_sales: 1, cogs: 0 }, 1, false), 0);
});
test('missing costs, invalid counts, and 100-percent RTS forecast zeros are not zero-cost orders', () => {
  for (const cost of [null, undefined, NaN, Infinity, '0', -1, 0.01]) {
    assert.equal(priority({ gross_sales: 1, cogs: cost }, 1, true), 0);
  }
  for (const orders of [0, -1, NaN, Infinity, null, '1']) {
    assert.equal(priority({ gross_sales: orders, cogs: 0 }, 1, true), 0);
  }
  assert.equal(priority({ gross_sales: 0.8, cogs: 0 }, 0, true), 1);
  assert.equal(priority({ gross_sales: 0.8, cogs: 0 }, 1, true), 2);
});
test('table renders red and descriptive badges only when Super Admin review is enabled', () => {
  const units = load('_utils/actual-cogs-units.ts');
  const { AnalyticsSalesProductsTable } = load('_components/analytics-sales-products-table.tsx', name => {
    if (name === './analytics-table-shell') return { AnalyticsTableShell: p => React.createElement('div', null, p.children) };
    if (name === '../_utils/actual-cogs-units') return units;
    if (name === '../_utils/metrics') return { formatMetricValue: value => String(value ?? ''), toTitleCase: value => value };
    return require(name);
  });
  const row = {
    ...item('single', 1, 0, 1), index: 0,
    row: { mapping: 'Single', gross_sales: 1, cogs: 0 },
    derived: { display: 'Single', forecast: { cmForecast: 0 }, rtsPct: 0 },
  };
  const props = { isLoading: false, productPage: 1, pageSize: 10, rows: [row], sourceCount: 1,
    productStart: 1, productEnd: 1, totalProducts: 1, totalProductPages: 1, rtsForecastSafe: 20,
    onPrevious() {}, onNext() {}, renderSortLabel: label => label };
  const admin = renderToStaticMarkup(React.createElement(AnalyticsSalesProductsTable, { ...props, showZeroCogsReview: true }));
  assert.match(admin, /data-cogs-review="zero-cogs"/);
  assert.match(admin, /Delivered orders · Missing ERP COGS/);
  assert.match(admin, /bg-red-50/);
  const ordinary = renderToStaticMarkup(React.createElement(AnalyticsSalesProductsTable, props));
  assert.doesNotMatch(ordinary, /data-cogs-review|Missing ERP COGS|bg-red-50/);
});

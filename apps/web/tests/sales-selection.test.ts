import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { buildSalesMappingSelection, parseSalesTeamSelection } from '../src/app/(dashboard)/analytics/_utils/sales-selection';

test('All, Clear and a subset produce different actual query plans', () => {
  const all = buildSalesMappingSelection(true, []);
  const none = buildSalesMappingSelection(false, []);
  const subset = buildSalesMappingSelection(false, ['b', 'a', 'a']);
  assert.notEqual(all.key, none.key);
  assert.equal(all.emptySelection, false);
  assert.equal(none.emptySelection, true);
  assert.deepEqual(subset.mappings, ['a', 'b']);
  assert.notEqual(subset.key, all.key);
  assert.notEqual(subset.key, none.key);
  assert.equal(buildSalesMappingSelection(true, subset.mappings).key, all.key);
});

test('actual Product export mapping retains displayed zero-revenue rows and their financial totals', () => {
  const filename = path.resolve(__dirname, '../src/app/(dashboard)/analytics/sales/page.tsx');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'exportableProducts') declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(declaration);
  const js = ts.transpileModule(`(function(sortedProducts,toTitleCase){const ${declaration.getText(source)};return exportableProducts;})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const map = vm.runInNewContext(js);
  const display = [
    { row: { revenue: 1000, cogs: 300, contribution_margin: 500 }, derived: { display: 'delivered', forecast: { cmForecast: 400 } } },
    { row: { revenue: 0, ad_spend: 0, cogs: 0, contribution_margin: -90, net_margin: -90 }, derived: { display: 'excluded RTS', forecast: { cmForecast: -90 } } },
  ];
  const exported = map(display, (v: string) => v);
  assert.equal(exported.length, display.length);
  assert.equal(exported.reduce((total: number, row: any) => total + row.contributionMargin, 0), 410);
  assert.equal(exported.reduce((total: number, row: any) => total + row.cogs, 0), 300);
  assert.equal(exported[1].product, 'excluded RTS');
});


test('team filter cache scope mirrors actual API header storage including All and events', () => {
  assert.deepEqual(parseSalesTeamSelection(null, 'ALL_TEAMS'), []);
  assert.deepEqual(parseSalesTeamSelection('[]', 'old-team'), []);
  assert.deepEqual(parseSalesTeamSelection('["b","a","b"]', 'old-team'), ['a', 'b']);
  assert.deepEqual(parseSalesTeamSelection(null, 'one-team'), ['one-team']);
  assert.deepEqual(parseSalesTeamSelection('invalid', 'old-team'), []);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const XLSX = require('xlsx');

const base = path.resolve(__dirname, '../src/app/(dashboard)/analytics/_utils');
function load(filename, context, resolve) {
  const fullPath = path.join(base, filename);
  const code = ts.transpileModule(fs.readFileSync(fullPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: resolve, ...context }, { filename: fullPath });
  return module.exports;
}

function exportsFixture() {
  const captured = {};
  const units = load('actual-cogs-units.ts', {}, require);
  const api = load('sales-products-export.ts', {
    Blob,
    URL: {
      createObjectURL: blob => { captured.blob = blob; return 'blob:test'; },
      revokeObjectURL() {},
    },
    document: {
      createElement: () => ({ click() {} }),
      body: { appendChild() {}, removeChild() {} },
    },
  }, name => {
    if (name === './actual-cogs-units') return units;
    if (name === 'xlsx') return { ...XLSX, writeFile: workbook => { captured.workbook = workbook; } };
    throw new Error(`Unexpected dependency: ${name}`);
  });
  return { api, captured };
}

const sample = {
  product: 'Fixture', grossRevenue: 120, grossSales: 1.25, cogs: 40, units: 7,
  aov: 96, cpp: 2, processedCpp: 3, adSpend: 2.5, arPct: 12.5, rtsPct: 20, pePct: 50,
  contributionMargin: 25, cmRtsForecast: 20, netMargin: 15,
};

for (const view of ['actual', 'forecast']) {
  for (const authorized of [true, false]) {
    test(`${view} ${authorized ? 'authorized' : 'ordinary'} CSV and XLSX use matching protected columns and numeric formats`, async () => {
      const { api, captured } = exportsFixture();
      const input = {
        startDate: '2026-10-01', endDate: '2026-10-20', cmRtsLabel: 'CM (RTS 20%)', view,
        includeUnits: authorized,
        rows: [{ ...sample, units: view === 'forecast' ? 5.6 : 7 }, { ...sample, units: 0 }, { ...sample, units: null }],
      };
      api.exportSalesProductsCsv(input);
      const csvLines = (await captured.blob.text()).split('\n').map(line => line.split(','));
      await api.exportSalesProductsXlsx(input);
      assert.ok(captured.workbook);
      // Round-trip the actual workbook serializer, without creating a file.
      const workbook = XLSX.read(XLSX.write(captured.workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer', cellNF: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      assert.deepEqual(grid[0], csvLines[0]);
      if (authorized) {
        assert.equal(grid[0][4], view === 'actual' ? 'Actual Units' : 'Forecast Units');
        assert.equal(sheet.E2.v, view === 'forecast' ? 5.6 : 7); assert.equal(sheet.E2.t, 'n'); assert.equal(sheet.E2.z, view === 'forecast' ? '0.00' : '0');
        assert.equal(sheet.E3.v, 0); assert.equal(sheet.E3.z, view === 'forecast' ? '0.00' : '0');
        assert.equal(grid[3][4], '');
        assert.equal(csvLines[1][4], view === 'forecast' ? '5.60' : '7');
        assert.equal(csvLines[2][4], view === 'forecast' ? '0.00' : '0');
        assert.equal(csvLines[3][4], '');
        assert.equal(sheet.F2.z, '#,##0.00'); // AOV shifted by the inserted units column.
      } else {
        assert.ok(!grid[0].includes('Actual Units'));
        assert.ok(!grid[0].includes('Forecast Units'));
        assert.equal(grid[0][4], 'AOV');
        assert.equal(sheet.E2.z, '#,##0.00');
      }
      const percentIndex = grid[0].indexOf('AR %');
      assert.equal(sheet[XLSX.utils.encode_cell({ r: 1, c: percentIndex })].z, '0.00%');
      assert.equal(csvLines[1][percentIndex], '12.50%');
      assert.equal(sheet.C2.z, view === 'forecast' ? '0.00' : '0');
      assert.ok(grid.every(row => row.length === grid[0].length));
      if (view === 'forecast' && authorized) {
        const assumptions = XLSX.utils.sheet_to_json(workbook.Sheets['Forecast assumptions'], { header: 1 }).flat().join(' ');
        assert.match(assumptions, /Forecast Units uses the same population as Forecast COGS/);
        assert.match(assumptions, /before the actual RTS exclusion/);
        assert.doesNotMatch(assumptions, /Actual Units Delivered|not scaled/);
      }
    });
  }
}

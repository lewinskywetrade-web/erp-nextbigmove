import { cogsUnitsValue } from './actual-cogs-units';

export type SalesProductsExportRow = {
  product: string;
  grossRevenue: number;
  grossSales: number;
  cogs: number;
  units?: number | null;
  aov: number;
  cpp: number;
  processedCpp: number;
  adSpend: number;
  arPct: number;
  rtsPct: number;
  pePct: number;
  contributionMargin: number;
  cmRtsForecast: number;
  netMargin: number;
};

type SalesProductsExportInput = {
  startDate: string;
  endDate: string;
  cmRtsLabel: string;
  rows: SalesProductsExportRow[];
  view?: 'actual' | 'forecast';
  entityLabel?: 'Product' | 'Store';
  includeUnits?: boolean;
};

const escapeCsvValue = (value: string | number) => {
  const raw = `${value ?? ''}`;
  if (!raw.includes(',') && !raw.includes('"') && !raw.includes('\n')) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
};

const buildFilename = (
  startDate: string,
  endDate: string,
  extension: 'csv' | 'xlsx',
  view: 'actual' | 'forecast' = 'actual',
) => `sales-products${view === 'forecast' ? '_forecast' : ''}_${startDate}_to_${endDate}.${extension}`;

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

const buildHeaders = (cmRtsLabel: string, entityLabel = 'Product') => [
  entityLabel,
  'Gross Revenue',
  'Gross Sales',
  'COGS',
  'AOV',
  'CPP',
  'Processed CPP',
  'Ad Spend',
  'AR %',
  'RTS %',
  'P.E %',
  'Contribution Margin',
  cmRtsLabel,
  'Net Margin',
];

export function salesProductsExportGrid(input: SalesProductsExportInput) {
  const forecast = input.view === 'forecast';
  const headers = buildHeaders(input.cmRtsLabel, input.entityLabel);
  if (forecast) {
    headers[1] = 'Forecast Revenue'; headers[2] = 'Expected Deliveries';
    headers[3] = 'Forecast COGS'; headers[9] = 'Assumed RTS %';
    headers[11] = 'Forecast CM'; headers[13] = 'Forecast Net (before overhead)';
  }
  // Keep existing metric indices stable for currency/percentage formatting.
  // The optional protected column is inserted beside COGS only for its caller.
  headers.push(forecast ? 'Forecast Units' : 'Actual Units');
  const indices = headers.map((_, i) => i)
    .filter(i => i !== 14 && (!forecast || (i !== 6 && i !== 12)));
  if (input.includeUnits) indices.splice(indices.indexOf(3) + 1, 0, 14);
  const rows = input.rows.map(row => [
    row.product, row.grossRevenue, row.grossSales, row.cogs, row.aov, row.cpp,
    row.processedCpp, row.adSpend, row.arPct / 100, row.rtsPct / 100, row.pePct / 100,
    row.contributionMargin, row.cmRtsForecast, row.netMargin,
    input.includeUnits ? cogsUnitsValue(row.units, input.view) ?? '' : '',
  ].map(value => typeof value === 'number' && !Number.isFinite(value) ? '' : value));
  return { headers: indices.map(i => headers[i]), rows: rows.map(row => indices.map(i => row[i])), indices };
}

export function exportSalesProductsCsv(input: SalesProductsExportInput) {
  const { headers, rows: values, indices } = salesProductsExportGrid(input);
  const rows = values.map(row => row.map((value, index) => {
    if (typeof value !== 'number') return value;
    const originalIndex = indices[index];
    if ([8, 9, 10].includes(originalIndex)) return `${(value * 100).toFixed(2)}%`;
    if ([2, 14].includes(originalIndex) && input.view !== 'forecast') return Math.round(value);
    return value.toFixed(2);
  }));

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => escapeCsvValue(cell)).join(','))
    .join('\n');

  downloadBlob(
    new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
    buildFilename(input.startDate, input.endDate, 'csv', input.view),
  );
}

export async function exportSalesProductsXlsx(input: SalesProductsExportInput) {
  const XLSX = await import('xlsx');
  const { headers, rows: values, indices } = salesProductsExportGrid(input);
  const rows: Array<Array<string | number>> = [
    headers,
    ...values,
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const columnWidths = [
    { wch: 28 },
    { wch: 14 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 20 },
    { wch: 20 },
    { wch: 14 },
    { wch: 24 },
  ];
  worksheet['!cols'] = indices.map(index => columnWidths[index]);

  const currencyColumns = new Set([1, 3, 4, 5, 6, 7, 11, 12, 13]);
  const percentColumns = new Set([8, 9, 10]);

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    for (let columnIndex = 1; columnIndex < headers.length; columnIndex += 1) {
      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = worksheet[cellAddress];
      if (!cell || cell.t !== 'n') continue;

      const originalIndex = indices[columnIndex];
      if (originalIndex === 2 || originalIndex === 14) {
        cell.z = input.view === 'forecast' ? '0.00' : '0';
        continue;
      }

      if (percentColumns.has(originalIndex)) {
        cell.z = '0.00%';
        continue;
      }

      if (currencyColumns.has(originalIndex)) {
        cell.z = '#,##0.00';
      }
    }
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, input.view === 'forecast' ? 'Forecast' : `Revenue per ${input.entityLabel ?? 'Product'}`);
  if (input.view === 'forecast') {
    const notes = XLSX.utils.aoa_to_sheet([
      ['Forecast assumptions'],
      ['Revenue, goods cost and expected deliveries use the selected RTS success percentage.'],
      ['Returned goods are assumed fully recoverable. Advertising and existing shipping, fulfillment and IF fee estimates stay fixed.'],
      ['COD fees use the selected cohort’s blended delivered fee/revenue rate. Missing evidence is blank.'],
      ['Forecast Net is before overhead and equals Forecast CM on the same available expense basis.'],
      ['These are projections from saved source values, not actual results or cost corrections.'],
      ...(input.includeUnits ? [['Forecast Units uses the same population as Forecast COGS: item quantities before the actual RTS exclusion multiplied by (1 − assumed RTS %). Other selected filters still apply. Fractional units are estimates; blank means quantity evidence is unavailable.']] : []),
    ]);
    notes['!cols'] = [{ wch: 120 }];
    XLSX.utils.book_append_sheet(workbook, notes, 'Forecast assumptions');
  }
  XLSX.writeFile(workbook, buildFilename(input.startDate, input.endDate, 'xlsx', input.view));
}

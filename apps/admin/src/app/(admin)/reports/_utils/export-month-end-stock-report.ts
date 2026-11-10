import type { MonthEndStockReportResponse, MonthEndStockRow } from '../_types/month-end-stock-report';

const HEADERS = [
  'Client',
  'Store',
  'Shop ID',
  'Variant name',
  'Put away',
  'Reserved in bin',
  'Currently in bin',
] as const;

function rowValues(row: MonthEndStockRow) {
  return [
    row.tenantName,
    row.storeName,
    row.shopId,
    row.variantName,
    row.putAwayQty,
    row.reservedQty,
    row.inBinQty,
  ];
}

function reportFileName(data: MonthEndStockReportResponse, extension: 'csv' | 'xlsx') {
  const date = data.report.generatedAt.slice(0, 10);
  return `wms-month-end-stock-${date}.${extension}`;
}

export function exportMonthEndStockCsv(data: MonthEndStockReportResponse) {
  const rows = [HEADERS, ...data.rows.map(rowValues)];
  const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = reportFileName(data, 'csv');
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function exportMonthEndStockWorkbook(data: MonthEndStockReportResponse) {
  const XLSX = await import('xlsx');
  const xlsx = (XLSX as unknown as { default?: typeof XLSX }).default ?? XLSX;
  const worksheet = xlsx.utils.aoa_to_sheet([
    ['WMS Month-End Stock Report'],
    ['Generated at', new Date(data.report.generatedAt).toLocaleString()],
    ['Snapshot basis', 'Current WMS inventory at generation time'],
    [],
    [...HEADERS],
    ...data.rows.map(rowValues),
  ]);
  worksheet['!cols'] = [
    { wch: 24 }, { wch: 24 }, { wch: 16 }, { wch: 36 },
    { wch: 14 }, { wch: 18 }, { wch: 18 },
  ];
  worksheet['!freeze'] = { xSplit: 0, ySplit: 5 };
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Month-End Stock');
  xlsx.writeFile(workbook, reportFileName(data, 'xlsx'));
}

function escapeCsvCell(value: string | number) {
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

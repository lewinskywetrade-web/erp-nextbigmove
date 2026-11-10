'use client';

import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MonthEndStockRow } from '../_types/month-end-stock-report';

const PAGE_SIZE = 25;

export function MonthEndStockTable({ rows, isLoading }: { rows: MonthEndStockRow[]; isLoading: boolean }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => [
      row.tenantName,
      row.storeName,
      row.shopId,
      row.variantName,
      row.variantCode,
      row.productId,
      row.variationId,
    ].some((value) => value?.toLowerCase().includes(needle)));
  }, [rows, search]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <section className="overflow-hidden rounded-[24px] border border-[#dce4ea] bg-white">
      <div className="flex flex-col gap-3 border-b border-[#e6edf1] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-primary">Variant stock</h2>
          <p className="mt-0.5 text-xs text-muted">One row per active WMS product variant and store, including zero stock.</p>
        </div>
        <label className="flex h-10 min-w-0 items-center gap-2 rounded-2xl border border-[#d7e0e7] bg-white px-3 sm:w-[320px]">
          <Search className="h-4 w-4 shrink-0 text-[#8193a0]" />
          <input
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            placeholder="Search variant, store, or client"
            className="min-w-0 flex-1 border-0 bg-transparent text-sm text-primary outline-none placeholder:text-[#94a3b8]"
          />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[840px] border-collapse text-left text-sm">
          <thead className="bg-[#f6f8fa] text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6f8290]">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Store</th>
              <th className="px-4 py-3">Variant</th>
              <th className="px-4 py-3 text-right">Put away</th>
              <th className="px-4 py-3 text-right">Reserved</th>
              <th className="px-4 py-3 text-right">Currently in bin</th>
            </tr>
          </thead>
          <tbody className={isLoading ? 'opacity-50' : ''}>
            {visibleRows.map((row) => (
              <tr key={row.rowId} className="border-t border-[#edf1f4] text-primary hover:bg-[#fbfcfd]">
                <td className="px-4 py-3 font-medium">{row.tenantName}</td>
                <td className="px-4 py-3">
                  <span className="block font-semibold">{row.storeName}</span>
                  <span className="block text-[11px] text-muted">Shop {row.shopId}</span>
                </td>
                <td className="max-w-[320px] px-4 py-3">
                  <span className="block truncate font-semibold">{row.variantName}</span>
                </td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums">{row.putAwayQty.toLocaleString()}</td>
                <td className="px-4 py-3 text-right tabular-nums">{row.reservedQty.toLocaleString()}</td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums text-emerald-700">{row.inBinQty.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visibleRows.length === 0 ? (
        <div className="border-t border-[#edf1f4] px-4 py-14 text-center text-sm text-muted">
          {isLoading ? 'Loading stock snapshot…' : 'No WMS variants match this report scope.'}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 border-t border-[#e6edf1] bg-[#fbfcfd] px-4 py-3 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
        <span>{filteredRows.length.toLocaleString()} variants</span>
        <div className="flex items-center gap-3">
          <button type="button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="btn btn-sm btn-secondary">Previous</button>
          <span>Page {currentPage} of {totalPages}</span>
          <button type="button" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} className="btn btn-sm btn-secondary">Next</button>
        </div>
      </div>
    </section>
  );
}

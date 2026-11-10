'use client';

import { Eye, FileSearch } from 'lucide-react';
import type { WmsPurchasingBatchRow } from '../_types/purchasing';
import {
  formatRequestTypeLabel,
  formatShortDate,
  formatStatusLabel,
  getStatusClasses,
} from '../_utils/purchasing-presenters';

type PurchasingBatchesTableProps = {
  batches: WmsPurchasingBatchRow[];
  isLoading: boolean;
  tenantReady: boolean;
  onOpenBatch: (batchId: string) => void;
};

export function PurchasingBatchesTable({
  batches,
  isLoading,
  tenantReady,
  onOpenBatch,
}: PurchasingBatchesTableProps) {
  return (
    <div className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] 2xl:min-w-full divide-y divide-[#eef2f5]">
          <thead className="bg-[#eff3f6]">
            <tr>
              <TableHeader className="min-w-[220px]">Request</TableHeader>
              <TableHeader>Type</TableHeader>
              <TableHeader>Store</TableHeader>
              <TableHeader className="text-right">Qty</TableHeader>
              <TableHeader className="w-[172px]">Status</TableHeader>
              <TableHeader>Updated</TableHeader>
              <TableHeader className="text-right">Action</TableHeader>
            </tr>
          </thead>

          <tbody className="divide-y divide-[#eef2f5]">
            {isLoading ? (
              Array.from({ length: 8 }).map((_, rowIndex) => (
                <tr key={`loading-${rowIndex}`}>
                  {Array.from({ length: 7 }).map((__, cellIndex) => (
                    <td key={`loading-${rowIndex}-${cellIndex}`} className="px-4 py-3.5">
                      <div className="h-3.5 animate-pulse rounded-full bg-[#eef2f5]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : !tenantReady ? (
              <StateRow
                title="Client context required"
                message="Select a client first before reviewing purchasing batches."
              />
            ) : batches.length === 0 ? (
              <StateRow
                title="No purchasing batches found"
                message="No requests match the current filters."
              />
            ) : (
              batches.map((batch) => (
                <tr key={batch.id} className="group transition hover:bg-[#fbfcfc]">
                  <td className="px-4 py-3">
                    <div className="max-w-[220px] space-y-0.5">
                      <p className="truncate text-sm font-semibold text-primary">
                        {batch.sourceRequestId || batch.requestTitle || batch.id.slice(0, 8)}
                      </p>
                      <p className="truncate text-[12px] text-[#7b8e9c]">
                        {batch.requestTitle || batch.sourceStatus || 'No request title'}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className="pill pill-ghost">
                      {formatRequestTypeLabel(batch.requestType)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-primary">
                    <span className="block max-w-[180px] truncate">{batch.store.name}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-primary">
                    {batch.approvedQuantity.toLocaleString()}
                  </td>
                  <td className="w-[172px] px-4 py-3 text-sm">
                    <span
                      className={`pill inline-flex whitespace-nowrap ${getStatusClasses(batch.status)}`}
                    >
                      {formatStatusLabel(batch.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-[#4d6677]">
                    {formatShortDate(batch.updatedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onOpenBatch(batch.id)}
                      className="btn btn-sm btn-outline btn-icon ml-auto"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      View
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableHeader({
  children,
  className = '',
}: {
  children: string;
  className?: string;
}) {
  return (
    <th
      className={`whitespace-nowrap px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.22em] text-muted bg-slate-50 ${className}`}
    >
      {children}
    </th>
  );
}

function StateRow({ title, message }: { title: string; message: string }) {
  return (
    <tr>
      <td colSpan={7} className="px-4 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[#dce4ea] bg-[#fbfcfc] text-primary">
            <FileSearch className="h-5 w-5" />
          </span>
          <p className="text-sm font-semibold text-primary">{title}</p>
          <p className="text-[12.5px] text-[#7b8e9c]">{message}</p>
        </div>
      </td>
    </tr>
  );
}


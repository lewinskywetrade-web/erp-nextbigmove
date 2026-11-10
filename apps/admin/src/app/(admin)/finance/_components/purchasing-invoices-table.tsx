'use client';

import { Eye, FileSearch } from 'lucide-react';
import type { WmsInvoiceRow } from '../_types/purchasing';
import {
  formatInvoiceSourceTypeLabel,
  formatInvoiceStatusLabel,
  formatMoney,
  formatShortDate,
  getInvoiceStatusClasses,
} from '../_utils/purchasing-presenters';

type PurchasingInvoicesTableProps = {
  invoices: WmsInvoiceRow[];
  isLoading: boolean;
  tenantReady: boolean;
  onOpenInvoice: (invoiceId: string) => void;
};

export function PurchasingInvoicesTable({
  invoices,
  isLoading,
  tenantReady,
  onOpenInvoice,
}: PurchasingInvoicesTableProps) {
  return (
    <div className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] divide-y divide-[#eef2f5]">
          <thead className="bg-[#eff3f6]">
            <tr>
              <TableHeader className="min-w-[220px]">Invoice</TableHeader>
              <TableHeader>Source</TableHeader>
              <TableHeader>Issued</TableHeader>
              <TableHeader>Due</TableHeader>
              <TableHeader className="text-right">Qty</TableHeader>
              <TableHeader className="text-right">Amount</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>Updated</TableHeader>
              <TableHeader className="text-right">Action</TableHeader>
            </tr>
          </thead>

          <tbody className="divide-y divide-[#eef2f5]">
            {isLoading ? (
              Array.from({ length: 8 }).map((_, rowIndex) => (
                <tr key={`loading-${rowIndex}`}>
                  {Array.from({ length: 9 }).map((__, cellIndex) => (
                    <td key={`loading-${rowIndex}-${cellIndex}`} className="px-4 py-3.5">
                      <div className="h-3.5 animate-pulse rounded-full bg-[#eef2f5]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : !tenantReady ? (
              <StateRow
                title="Client context required"
                message="Select a client first before reviewing invoices."
              />
            ) : invoices.length === 0 ? (
              <StateRow
                title="No invoices found"
                message="No invoices match the current filters."
              />
            ) : (
              invoices.map((invoice) => (
                <tr key={invoice.id} className="group transition hover:bg-[#fbfcfc]">
                  <td className="px-4 py-3">
                    <div className="max-w-[220px] space-y-0.5">
                      <p className="truncate text-sm font-semibold text-primary">
                        {invoice.invoiceNumber}
                      </p>
                      <p className="truncate text-[12px] text-[#7b8e9c]">
                        {invoice.sourceRefCode || invoice.notes || 'No source reference'}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className="pill pill-ghost">
                      {formatInvoiceSourceTypeLabel(invoice.sourceType)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[#4d6677]">
                    {formatShortDate(invoice.issueDate)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[#4d6677]">
                    {formatShortDate(invoice.dueDate)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-primary">
                    {invoice.totalQuantity.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-primary">
                    {formatMoney(invoice.totalAmount)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`pill inline-flex whitespace-nowrap ${getInvoiceStatusClasses(invoice.status)}`}>
                      {formatInvoiceStatusLabel(invoice.status)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-[#4d6677]">
                    {formatShortDate(invoice.updatedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onOpenInvoice(invoice.id)}
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
    <th className={`whitespace-nowrap bg-slate-50 px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.22em] text-muted ${className}`}>
      {children}
    </th>
  );
}

function StateRow({ title, message }: { title: string; message: string }) {
  return (
    <tr>
      <td colSpan={9} className="px-4 py-16">
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

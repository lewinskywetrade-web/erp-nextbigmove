'use client';

import { Eye } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WmsOutboundUnitRecord } from '../_types/outbound-records';
import {
  formatOutboundDateTime,
  formatOutboundStatus,
  getOutboundStatusClassName,
} from '../_utils/outbound-records-presenters';

type OutboundRecordsTableProps = {
  records: WmsOutboundUnitRecord[];
  isLoading: boolean;
  tenantReady: boolean;
  onView: (record: WmsOutboundUnitRecord) => void;
};

export function OutboundRecordsTable({ records, isLoading, tenantReady, onView }: OutboundRecordsTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0">
        <thead>
          <tr className="bg-secondary/30 text-left">
            <HeaderCell>Activity date</HeaderCell>
            <HeaderCell>Activity</HeaderCell>
            <HeaderCell>Unit</HeaderCell>
            <HeaderCell>Product</HeaderCell>
            <HeaderCell>Client / Store</HeaderCell>
            <HeaderCell>Order / Tracking</HeaderCell>
            <HeaderCell>Warehouse</HeaderCell>
            <HeaderCell>Current status</HeaderCell>
            <HeaderCell align="right">Action</HeaderCell>
          </tr>
        </thead>
        <tbody className="bg-surface">
          {isLoading ? (
            <EmptyRow>Loading outbound records…</EmptyRow>
          ) : !tenantReady ? (
            <EmptyRow>No client scope is available for outbound records.</EmptyRow>
          ) : records.length === 0 ? (
            <EmptyRow>No outbound items match the selected filters and dates.</EmptyRow>
          ) : records.map((record) => (
            <tr key={`${record.id}:${record.activity}:${record.eventAt}`} className="border-b border-border/20 text-sm-custom text-foreground transition hover:bg-secondary/10">
              <BodyCell>
                <span className="whitespace-nowrap font-medium">{formatOutboundDateTime(record.eventAt)}</span>
              </BodyCell>
              <BodyCell>
                <span className={`pill inline-flex ${getOutboundStatusClassName(record.activity)}`}>
                  {formatOutboundStatus(record.activity)}
                </span>
              </BodyCell>
              <BodyCell>
                <div className="min-w-36">
                  <p className="truncate font-semibold">{record.unit.code}</p>
                  <p className="mt-1 truncate text-xs text-muted">{record.unit.barcode}</p>
                </div>
              </BodyCell>
              <BodyCell>
                <div className="min-w-44">
                  <p className="truncate font-medium">{record.product.name}</p>
                  <p className="mt-1 truncate text-xs text-muted">
                    {record.product.customId ?? record.product.variationId}
                  </p>
                </div>
              </BodyCell>
              <BodyCell>
                <div className="min-w-40">
                  <p className="truncate font-medium">{record.tenant.name}</p>
                  <p className="mt-1 truncate text-xs text-muted">{record.store.name}</p>
                </div>
              </BodyCell>
              <BodyCell>
                <div className="min-w-40">
                  <p className="truncate font-semibold">#{record.order.posOrderId}</p>
                  <p className="mt-1 truncate text-xs text-muted">{record.trackingCode ?? 'No tracking code'}</p>
                </div>
              </BodyCell>
              <BodyCell>
                <p className="min-w-32 truncate font-medium">{record.warehouse.name}</p>
              </BodyCell>
              <BodyCell>
                <span className={`pill inline-flex ${getOutboundStatusClassName(record.status)}`}>
                  {formatOutboundStatus(record.status)}
                </span>
              </BodyCell>
              <BodyCell align="right">
                <button type="button" onClick={() => onView(record)} className="btn btn-sm btn-outline btn-icon ml-auto">
                  <Eye className="h-3.5 w-3.5" />
                  View
                </button>
              </BodyCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <tr>
      <td colSpan={9} className="px-5 py-14 text-center text-sm text-muted">{children}</td>
    </tr>
  );
}

function HeaderCell({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={`px-5 py-3 text-xs-tight font-semibold uppercase tracking-widest text-muted ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );
}

function BodyCell({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return <td className={`px-5 py-3.5 align-middle ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</td>;
}

'use client';

import { Check, PackageCheck, RotateCcw, Truck, Undo2 } from 'lucide-react';
import { WmsSidePanel } from '../../_components/wms-side-panel';
import type { WmsOutboundUnitRecord } from '../_types/outbound-records';
import {
  formatOutboundDateTime,
  formatOutboundStatus,
  getOutboundStatusClassName,
} from '../_utils/outbound-records-presenters';

type OutboundRecordDetailPanelProps = {
  record: WmsOutboundUnitRecord | null;
  onClose: () => void;
};

const lifecycle = [
  { key: 'shippedAt', label: 'Shipped', icon: Truck },
  { key: 'deliveredAt', label: 'Delivered', icon: Check },
  { key: 'returningAt', label: 'Returning', icon: Undo2 },
  { key: 'returnedAt', label: 'Returned', icon: RotateCcw },
] as const;

export function OutboundRecordDetailPanel({ record, onClose }: OutboundRecordDetailPanelProps) {
  if (!record) return null;

  return (
    <WmsSidePanel
      open
      title={record.unit.code}
      description={`${record.product.name} · Order #${record.order.posOrderId}`}
      onClose={onClose}
      footer={(
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="btn btn-md btn-outline">Close</button>
        </div>
      )}
    >
      <div className="space-y-4">
        <section className="card">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="card-label">Selected activity</p>
              <p className="mt-2 text-lg font-semibold text-foreground">{formatOutboundStatus(record.activity)}</p>
              <p className="mt-1 text-xs text-muted">{formatOutboundDateTime(record.eventAt)}</p>
            </div>
            <div className="text-right">
              <p className="card-label">Current status</p>
              <span className={`pill mt-2 inline-flex ${getOutboundStatusClassName(record.status)}`}>
                {formatOutboundStatus(record.status)}
              </span>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Detail label="Barcode" value={record.unit.barcode} />
            <Detail label="Tracking" value={record.trackingCode ?? 'Not assigned'} />
            <Detail label="Client" value={record.tenant.name} />
            <Detail label="Store" value={record.store.name} />
            <Detail label="Warehouse" value={`${record.warehouse.code} · ${record.warehouse.name}`} />
            <Detail label="Variation" value={record.product.variationId} />
          </div>
        </section>

        <section className="panel panel-content">
          <div className="panel-header">
            <PackageCheck className="panel-icon" />
            <h3 className="panel-title">Lifecycle</h3>
          </div>
          <div className="space-y-1 p-3">
            {lifecycle.map((step) => {
              const Icon = step.icon;
              const timestamp = record[step.key];
              return (
                <div key={step.key} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-secondary/20">
                  <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${timestamp ? 'bg-primary-soft text-primary' : 'bg-secondary/40 text-muted'}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{step.label}</p>
                    <p className="mt-0.5 text-xs text-muted">{formatOutboundDateTime(timestamp)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </WmsSidePanel>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-secondary/20 px-3 py-2.5">
      <p className="text-xs-tight font-semibold uppercase tracking-widest text-muted">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground" title={value}>{value}</p>
    </div>
  );
}

'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Building2, Pencil } from 'lucide-react';
import type { TenantRecord } from '../_types/tenant';
import {
  formatTenantDate,
  formatTenantPlan,
  formatTenantStatus,
  getTenantPlanClassName,
  getTenantStatusClassName,
} from '../_utils/tenant-presenters';

type TenantsTableProps = {
  tenants: TenantRecord[];
  isLoading: boolean;
};

export function TenantsTable({ tenants, isLoading }: TenantsTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0">
        <thead>
          <tr className="bg-[#eaf0f4] text-left">
            <HeaderCell>Client</HeaderCell>
            <HeaderCell>Status</HeaderCell>
            <HeaderCell>Plan</HeaderCell>
            <HeaderCell>Users</HeaderCell>
            <HeaderCell>Integrations</HeaderCell>
            <HeaderCell>Created</HeaderCell>
            <HeaderCell align="right">Action</HeaderCell>
          </tr>
        </thead>

        <tbody className="bg-white">
          {isLoading ? (
            Array.from({ length: 5 }).map((_, index) => (
              <tr key={`loading-${index}`} className="border-b border-[#edf2f6]">
                {Array.from({ length: 7 }).map((__, cellIndex) => (
                  <td key={`loading-${index}-${cellIndex}`} className="px-5 py-4">
                    <div className="h-3.5 animate-pulse rounded-full bg-[#eef2f5]" />
                  </td>
                ))}
              </tr>
            ))
          ) : tenants.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-5 py-16">
                <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[#dce4ea] bg-[#fbfcfc] text-[#5e8196]">
                    <Building2 className="h-5 w-5" />
                  </span>
                  <p className="text-sm font-semibold text-primary">No clients yet</p>
                  <p className="text-[12.5px] text-[#7b8e9c]">
                    Create your first client organization to get started.
                  </p>
                </div>
              </td>
            </tr>
          ) : (
            tenants.map((tenant) => {
              const userCount = tenant._count?.users ?? 0;
              const integrationCount = tenant._count?.integrations ?? 0;

              return (
                <tr
                  key={tenant.id}
                  className="border-b border-[#edf2f6] text-[13px] text-primary transition hover:bg-[#fbfcfc]"
                >
                  <BodyCell className="font-semibold">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-white">
                        <Building2 className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate">{tenant.name}</div>
                        <div className="mt-0.5 truncate text-[11px] font-medium text-[#7c8f9b]">
                          {tenant.slug}
                        </div>
                      </div>
                    </div>
                  </BodyCell>

                  <BodyCell>
                    <span
                      className={`pill ${getTenantStatusClassName(tenant.status)}`}
                    >
                      {formatTenantStatus(tenant.status)}
                    </span>
                  </BodyCell>

                  <BodyCell>
                    <span
                      className={`pill ${getTenantPlanClassName(tenant.planType)}`}
                    >
                      {formatTenantPlan(tenant.planType)}
                    </span>
                  </BodyCell>

                  <BodyCell>
                    <UsageCell current={userCount} max={tenant.maxUsers} />
                  </BodyCell>

                  <BodyCell>
                    <UsageCell current={integrationCount} max={tenant.maxIntegrations} />
                  </BodyCell>

                  <BodyCell className="tabular-nums text-[#4d6677]">
                    {formatTenantDate(tenant.createdAt)}
                  </BodyCell>

                  <BodyCell align="right">
                    <Link
                      href={`/tenants/${tenant.id}`}
                      className="btn btn-sm btn-outline btn-icon max-w-[85px] ml-auto"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Manage
                    </Link>
                  </BodyCell>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function UsageCell({ current, max }: { current: number; max: number }) {
  const isUnlimited = max <= 0;
  const ratio = !isUnlimited && max > 0 ? Math.min(1, current / max) : 0;
  const percent = Math.round(ratio * 100);
  const barColor =
    percent >= 90 ? 'bg-destructive/60' : percent >= 70 ? 'bg-warning/60' : 'bg-primary';

  return (
    <div className="min-w-[120px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-semibold tabular-nums text-primary">
          {current.toLocaleString()}
        </span>
        <span className="text-[11px] text-[#7c8f9b]">
          / {isUnlimited ? 'Unlimited' : max.toLocaleString()}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#eef2f5]">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function HeaderCell({
  children,
  align = 'left',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={`px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.24em] bg-slate-50 text-muted ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function BodyCell({
  children,
  align = 'left',
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={`px-5 py-4 align-middle ${align === 'right' ? 'text-right' : 'text-left'} ${className}`.trim()}
    >
      {children}
    </td>
  );
}

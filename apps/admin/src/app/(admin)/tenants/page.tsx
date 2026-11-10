'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Building, Plus } from 'lucide-react';
import apiClient from '@/lib/api-client';
import { readStoredAdminUser, readStoredPermissions } from '@/lib/admin-session';
import {
  hasAnyAdminPermission,
  WMS_PARTNERS_READ_PERMISSIONS,
  WMS_PARTNERS_WRITE_PERMISSIONS,
} from '@/lib/wms-permissions';
import { WmsPageShell } from '../_components/wms-page-shell';
import { WmsInlineNotice } from '../_components/wms-inline-notice';
import { WmsWorkspaceCard } from '../_components/wms-workspace-card';
import { TenantsFilterBar } from './_components/tenants-filter-bar';
import { TenantsTable } from './_components/tenants-table';
import type { TenantPlan, TenantRecord, TenantStatus } from './_types/tenant';

export default function TenantsPage() {
  const router = useRouter();
  const user = useMemo(() => readStoredAdminUser(), []);
  const permissions = useMemo(() => readStoredPermissions(), []);
  const canRead = useMemo(
    () => hasAnyAdminPermission(user?.role, permissions, WMS_PARTNERS_READ_PERMISSIONS),
    [permissions, user?.role],
  );
  const canWrite = useMemo(
    () => hasAnyAdminPermission(user?.role, permissions, WMS_PARTNERS_WRITE_PERMISSIONS),
    [permissions, user?.role],
  );
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<TenantStatus | ''>('');
  const [planFilter, setPlanFilter] = useState<TenantPlan | ''>('');

  const getErrorMessage = (error: unknown, fallback: string) => {
    if (
      typeof error === 'object'
      && error !== null
      && 'response' in error
      && typeof (error as { response?: unknown }).response === 'object'
      && (error as { response?: { data?: unknown } }).response?.data
      && typeof (error as { response?: { data?: { message?: unknown } } }).response?.data?.message === 'string'
    ) {
      return (error as { response?: { data?: { message?: string } } }).response?.data?.message ?? fallback;
    }

    return fallback;
  };

  useEffect(() => {
    if (!canRead) {
      setIsLoading(false);
      return;
    }

    const fetchTenants = async () => {
      try {
        const token = localStorage.getItem('access_token');
        if (!token) {
          router.push('/login');
          return;
        }

        const response = await apiClient.get('/tenants', {
          headers: { Authorization: `Bearer ${token}` },
        });

        setTenants(response.data);
      } catch (error: unknown) {
        setError(getErrorMessage(error, 'Failed to load tenants'));
      } finally {
        setIsLoading(false);
      }
    };

    fetchTenants();
  }, [canRead, router]);

  const summary = useMemo(() => {
    const total = tenants.length;
    const active = tenants.filter((t) => t.status === 'ACTIVE').length;
    const trial = tenants.filter((t) => t.status === 'TRIAL').length;
    const suspended = tenants.filter((t) => t.status === 'SUSPENDED').length;
    return { total, active, trial, suspended };
  }, [tenants]);

  const filteredTenants = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return tenants.filter((tenant) => {
      if (statusFilter && tenant.status !== statusFilter) {
        return false;
      }
      if (planFilter && tenant.planType !== planFilter) {
        return false;
      }
      if (needle) {
        const haystack = `${tenant.name} ${tenant.slug}`.toLowerCase();
        if (!haystack.includes(needle)) {
          return false;
        }
      }
      return true;
    });
  }, [tenants, statusFilter, planFilter, searchText]);

  return (
    <div className="space-y-5">
      <WmsPageShell
        title="Clients"
        actions={
          canWrite ? (
            <Link
              href="/tenants/create"
              className="btn btn-md btn-primary btn-icon"
            >
              <Plus className="h-4 w-4" />
              New Client
            </Link>
          ) : null
        }
      >
        {!canRead ? (
          <WmsInlineNotice tone="error">You do not have permission to view clients.</WmsInlineNotice>
        ) : null}
        {error ? <WmsInlineNotice tone="error">{error}</WmsInlineNotice> : null}

        <div className="grid gap-3 xl:grid-cols-4">
          <InsightCard label="Total clients" value={summary.total.toLocaleString()} />
          <InsightCard label="Active" value={summary.active.toLocaleString()} tone="success" />
          <InsightCard label="Trial" value={summary.trial.toLocaleString()} tone="info" />
          <InsightCard label="Suspended" value={summary.suspended.toLocaleString()} tone="warning" />
        </div>

        <WmsWorkspaceCard
          title="Directory"
          icon={<Building className='panel-icon' />}
          filters={
            <TenantsFilterBar
              searchText={searchText}
              onSearchTextChange={setSearchText}
              statusFilter={statusFilter}
              onStatusChange={setStatusFilter}
              planFilter={planFilter}
              onPlanChange={setPlanFilter}
            />
          }
          footer={
            <div className="flex items-center justify-between gap-3 text-[12px] text-[#6f8290]">
              <span>
                Showing{' '}
                <span className="font-semibold text-primary">
                  {filteredTenants.length.toLocaleString()}
                </span>{' '}
                of{' '}
                <span className="font-semibold text-primary">
                  {tenants.length.toLocaleString()}
                </span>{' '}
                client{tenants.length === 1 ? '' : 's'}
              </span>
              <span className="pill pill-neutral">
                {isLoading ? 'Loading…' : 'Up to date'}
              </span>
            </div>
          }
        >
          <TenantsTable tenants={filteredTenants} isLoading={isLoading} />
        </WmsWorkspaceCard>
      </WmsPageShell>
    </div>
  );
}

type InsightTone = 'default' | 'success' | 'info' | 'warning';

function InsightCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: InsightTone;
}) {
  const accentMap: Record<InsightTone, string> = {
    default: 'bg-primary',
    success: 'bg-success',
    info: 'bg-info',
    warning: 'bg-amber-500',
  };

  return (
    <div className="relative overflow-hidden rounded-[18px] border border-[#dce4ea] bg-white px-4 py-3">
      {/* <div className={`absolute left-0 top-0 h-full w-1 ${accentMap[tone]}`} /> */}
      <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">
        {label}
      </p>
      <p className="mt-2 text-[1.4rem] font-semibold tracking-tight text-primary">{value}</p>
    </div>
  );
}

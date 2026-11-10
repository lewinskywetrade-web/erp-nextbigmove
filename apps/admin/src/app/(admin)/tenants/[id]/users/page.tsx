'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Search, User as UserIcon, Users } from 'lucide-react';
import apiClient from '@/lib/api-client';
import { readStoredAdminUser, readStoredPermissions } from '@/lib/admin-session';
import { hasAnyAdminPermission, WMS_PARTNERS_READ_PERMISSIONS } from '@/lib/wms-permissions';
import { WmsCompactPanel } from '../../../_components/wms-compact-panel';
import { WmsInlineNotice } from '../../../_components/wms-inline-notice';
import { WmsPageShell } from '../../../_components/wms-page-shell';
import { formatTenantDateTime } from '../../_utils/tenant-presenters';

type PartnerUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
  membership: 'HOME' | 'GRANTED';
  roles: string[];
  teams: string[];
};

type PartnerUsersResponse = {
  tenant: { id: string; name: string };
  users: PartnerUser[];
};

const getErrorMessage = (error: unknown, fallback: string) => {
  const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === 'string' ? message : fallback;
};

const statusClassName = (status: string) => {
  switch (status) {
    case 'ACTIVE':
      return 'pill pill-success';
    case 'INVITED':
    case 'PENDING':
      return 'pill pill-info';
    case 'SUSPENDED':
    case 'INACTIVE':
      return 'pill pill-warning';
    default:
      return 'pill pill-white';
  }
};

const titleCase = (value: string) =>
  value.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

export default function PartnerUsersPage() {
  const router = useRouter();
  const params = useParams();
  const tenantId = params.id as string;
  const user = useMemo(() => readStoredAdminUser(), []);
  const permissions = useMemo(() => readStoredPermissions(), []);
  const canRead = hasAnyAdminPermission(user?.role, permissions, WMS_PARTNERS_READ_PERMISSIONS);
  const [data, setData] = useState<PartnerUsersResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!canRead) {
      setIsLoading(false);
      return;
    }
    let isMounted = true;
    const load = async () => {
      try {
        const token = localStorage.getItem('access_token');
        if (!token) {
          router.push('/login');
          return;
        }
        const response = await apiClient.get(`/tenants/${tenantId}/users`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (isMounted) {
          setData(response.data as PartnerUsersResponse);
          setError('');
        }
      } catch (loadError: unknown) {
        if (isMounted) setError(getErrorMessage(loadError, 'Failed to load partner users'));
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    void load();
    return () => {
      isMounted = false;
    };
  }, [canRead, router, tenantId]);

  const filteredUsers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const users = data?.users ?? [];
    if (!needle) return users;
    return users.filter((partnerUser) =>
      `${partnerUser.firstName ?? ''} ${partnerUser.lastName ?? ''} ${partnerUser.email} ${partnerUser.roles.join(' ')} ${partnerUser.teams.join(' ')}`
        .toLowerCase()
        .includes(needle),
    );
  }, [data, search]);

  const backAction = (
    <Link href={`/tenants/${tenantId}`} className="btn btn-md btn-outline btn-icon">
      <ArrowLeft className="h-3.5 w-3.5" />
      Partner
    </Link>
  );

  return (
    <WmsPageShell
      title={data ? `${data.tenant.name} users` : 'Partner users'}
      breadcrumb="Partners / Manage"
      description="ERP user accounts that belong to this partner, with their roles and teams in this partner."
      actions={backAction}
    >
      {!canRead ? (
        <WmsInlineNotice tone="error">You do not have permission to view partners.</WmsInlineNotice>
      ) : null}
      {error ? <WmsInlineNotice tone="error">{error}</WmsInlineNotice> : null}

      {canRead ? (
        <WmsCompactPanel title={`Users${data ? ` (${data.users.length})` : ''}`} icon={<Users className="panel-icon" />}>
          <div className="border-b border-[#edf2f6] p-4">
            <label className="relative block max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#7c8f9b]" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name, email, role or team"
                className="input pl-8"
              />
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0">
              <thead>
                <tr className="text-left">
                  <HeaderCell>User</HeaderCell>
                  <HeaderCell>Status</HeaderCell>
                  <HeaderCell>Role</HeaderCell>
                  <HeaderCell>Teams</HeaderCell>
                  <HeaderCell>Access</HeaderCell>
                  <HeaderCell>Last login</HeaderCell>
                  <HeaderCell>Created</HeaderCell>
                </tr>
              </thead>
              <tbody className="bg-white">
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, index) => (
                    <tr key={`loading-${index}`}>
                      {Array.from({ length: 7 }).map((__, cellIndex) => (
                        <td key={`loading-${index}-${cellIndex}`} className="px-5 py-4">
                          <div className="h-3.5 animate-pulse rounded-full bg-[#eef2f5]" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-14 text-center text-[13px] text-[#6f8290]">
                      {data?.users.length ? 'No users match your search.' : 'This partner has no users yet.'}
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((partnerUser) => {
                    const fullName = [partnerUser.firstName, partnerUser.lastName].filter(Boolean).join(' ') || '—';
                    const roleLabel = partnerUser.role === 'SUPER_ADMIN'
                      ? 'Super Admin'
                      : partnerUser.roles.length ? partnerUser.roles.join(', ') : '—';
                    return (
                      <tr key={partnerUser.id} className="border-b border-[#edf2f6] text-[13px] text-[#29404f]">
                        <BodyCell>
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-white">
                              <UserIcon className="h-3.5 w-3.5" />
                            </span>
                            <div className="min-w-0">
                              <div className="truncate font-semibold">{fullName}</div>
                              <div className="mt-0.5 truncate text-[11px] font-medium text-[#7c8f9b]">{partnerUser.email}</div>
                            </div>
                          </div>
                        </BodyCell>
                        <BodyCell>
                          <span className={statusClassName(partnerUser.status)}>{titleCase(partnerUser.status)}</span>
                        </BodyCell>
                        <BodyCell>{roleLabel}</BodyCell>
                        <BodyCell>{partnerUser.teams.length ? partnerUser.teams.join(', ') : 'All teams'}</BodyCell>
                        <BodyCell>
                          <span className={partnerUser.membership === 'HOME' ? 'pill pill-white' : 'pill pill-info'}>
                            {partnerUser.membership === 'HOME' ? 'Home account' : 'Granted access'}
                          </span>
                        </BodyCell>
                        <BodyCell className="tabular-nums text-[#4d6677]">{formatTenantDateTime(partnerUser.lastLoginAt)}</BodyCell>
                        <BodyCell className="tabular-nums text-[#4d6677]">{formatTenantDateTime(partnerUser.createdAt)}</BodyCell>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </WmsCompactPanel>
      ) : null}
    </WmsPageShell>
  );
}

function HeaderCell({ children }: { children: ReactNode }) {
  return (
    <th className="bg-slate-50 px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.24em] text-muted">
      {children}
    </th>
  );
}

function BodyCell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-5 py-4 align-middle ${className}`.trim()}>{children}</td>;
}

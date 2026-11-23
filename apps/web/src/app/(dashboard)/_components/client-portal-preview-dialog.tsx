'use client';

import { useEffect, useMemo, useState } from 'react';
import { Building2, Eye, Search, UserCheck } from 'lucide-react';
import apiClient from '@/lib/api-client';
import { startClientPortalPreview } from '@/lib/impersonation';
import { AlertBanner, LoadingCard } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';

type PreviewTenant = {
  id: string;
  name: string;
  slug: string | null;
  status: string;
};

type PreviewTenantUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  status: string;
  membership: 'HOME' | 'GRANTED';
  roles: string[];
  teams: string[];
};

export function ClientPortalPreviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { addToast } = useToast();
  const [tenants, setTenants] = useState<PreviewTenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [tenantSearch, setTenantSearch] = useState('');
  const [isLoadingTenants, setIsLoadingTenants] = useState(false);

  const [users, setUsers] = useState<PreviewTenantUser[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [destination, setDestination] = useState<'/daily-inventory' | '/dashboard' | '/reports'>(
    '/daily-inventory',
  );
  const [startingUserId, setStartingUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoadingTenants(true);
    setError(null);

    apiClient
      .get<PreviewTenant[]>('/auth/client-preview/tenants')
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res.data) ? res.data : [];
        setTenants(list);
        if (list.length > 0) {
          setSelectedTenantId((prev) =>
            prev && list.some((t) => t.id === prev) ? prev : list[0].id,
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          || 'Unable to load client workspaces for preview.';
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTenants(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !selectedTenantId) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    setIsLoadingUsers(true);
    setError(null);

    apiClient
      .get<{ tenant: PreviewTenant; users: PreviewTenantUser[] }>(
        `/auth/client-preview/tenants/${selectedTenantId}/users`,
      )
      .then((res) => {
        if (cancelled) return;
        setUsers(Array.isArray(res.data?.users) ? res.data.users : []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          || 'Unable to load client users.';
        setError(msg);
        setUsers([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingUsers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, selectedTenantId]);

  const filteredTenants = useMemo(() => {
    const needle = tenantSearch.trim().toLowerCase();
    if (!needle) return tenants;
    return tenants.filter(
      (tenant) =>
        tenant.name.toLowerCase().includes(needle)
        || (tenant.slug ?? '').toLowerCase().includes(needle),
    );
  }, [tenantSearch, tenants]);

  const filteredUsers = useMemo(() => {
    const needle = userSearch.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((u) =>
      [u.firstName, u.lastName, u.email, ...u.roles, ...u.teams]
        .filter(Boolean)
        .some((val) => String(val).toLowerCase().includes(needle)),
    );
  }, [userSearch, users]);

  const selectedTenant = tenants.find((t) => t.id === selectedTenantId) ?? null;

  const handleStartPreview = async (userId: string) => {
    if (!selectedTenantId || startingUserId) return;
    setStartingUserId(userId);
    try {
      await startClientPortalPreview({
        tenantId: selectedTenantId,
        userId,
        destination,
      });
    } catch (err: unknown) {
      setStartingUserId(null);
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        || 'Unable to start read-only client preview.';
      addToast('error', msg);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!startingUserId) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5 text-primary" />
            View Live Client Portal As User
          </DialogTitle>
          <DialogDescription>
            Open a read-only 15-minute preview as any client account. All writes are blocked by the server; click Exit preview to return to your workspace.
          </DialogDescription>
        </DialogHeader>

        {error ? <AlertBanner tone="error" message={error} /> : null}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background/60 px-3 py-2.5 text-xs">
          <span className="font-semibold text-foreground">Open preview directly on:</span>
          <div className="flex items-center gap-2">
            <select
              value={destination}
              onChange={(e) =>
                setDestination(e.target.value as '/daily-inventory' | '/dashboard' | '/reports')
              }
              className="h-8 rounded-lg border border-border bg-surface px-2.5 text-xs font-semibold text-foreground focus:border-primary focus:outline-none"
            >
              <option value="/daily-inventory">Daily Stock Ins &amp; Outs (/daily-inventory)</option>
              <option value="/dashboard">Client Dashboard (/dashboard)</option>
              <option value="/reports">Client Reports (/reports)</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[240px_1fr]">
          {/* Client List */}
          <div className="flex flex-col rounded-xl border border-border bg-background/40">
            <div className="border-b border-border p-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={tenantSearch}
                  onChange={(e) => setTenantSearch(e.target.value)}
                  placeholder="Search client..."
                  className="h-8 w-full rounded-lg border border-border bg-surface pl-8 pr-2.5 text-xs text-foreground focus:border-primary focus:outline-none"
                />
              </div>
            </div>

            <div className="max-h-72 overflow-y-auto p-1.5 space-y-1">
              {isLoadingTenants ? (
                <p className="p-3 text-xs text-muted">Loading clients...</p>
              ) : filteredTenants.length === 0 ? (
                <p className="p-3 text-xs text-muted">No matching clients.</p>
              ) : (
                filteredTenants.map((tenant) => {
                  const active = tenant.id === selectedTenantId;
                  return (
                    <button
                      key={tenant.id}
                      type="button"
                      onClick={() => {
                        setSelectedTenantId(tenant.id);
                        setUserSearch('');
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                        active
                          ? 'bg-primary text-primary-foreground font-semibold'
                          : 'text-foreground hover:bg-foreground/5'
                      }`}
                    >
                      <Building2 className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate flex-1">{tenant.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Client Users List */}
          <div className="flex flex-col rounded-xl border border-border bg-background/40">
            <div className="flex items-center justify-between gap-2 border-b border-border p-2.5">
              <span className="text-xs font-semibold text-foreground truncate">
                {selectedTenant ? `${selectedTenant.name} Accounts` : 'Select a client'}
              </span>
              <div className="relative w-48">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <input
                  type="text"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Search user or team..."
                  className="h-8 w-full rounded-lg border border-border bg-surface pl-8 pr-2.5 text-xs text-foreground focus:border-primary focus:outline-none"
                />
              </div>
            </div>

            <div className="max-h-72 overflow-y-auto p-2 space-y-2">
              {isLoadingUsers ? (
                <LoadingCard label="Loading client users..." />
              ) : filteredUsers.length === 0 ? (
                <p className="p-4 text-center text-xs text-muted">
                  No active ERP user accounts found for this client workspace.
                </p>
              ) : (
                filteredUsers.map((clientUser) => {
                  const fullName =
                    [clientUser.firstName, clientUser.lastName].filter(Boolean).join(' ')
                    || clientUser.email;
                  const rolesLabel =
                    clientUser.role === 'SUPER_ADMIN'
                      ? 'Super Admin'
                      : clientUser.roles.length > 0
                        ? clientUser.roles.join(', ')
                        : clientUser.role;
                  const teamsLabel =
                    clientUser.teams.length > 0
                      ? `Teams: ${clientUser.teams.join(', ')}`
                      : 'All tenant stores';

                  return (
                    <div
                      key={clientUser.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          <UserCheck className="h-3.5 w-3.5 text-primary shrink-0" />
                          <span className="truncate">{fullName}</span>
                        </div>
                        <p className="truncate text-xs text-muted">{clientUser.email}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">
                          {rolesLabel} · {teamsLabel}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        iconLeft={<Eye className="h-3.5 w-3.5" />}
                        loading={startingUserId === clientUser.id}
                        disabled={Boolean(startingUserId)}
                        onClick={() => void handleStartPreview(clientUser.id)}
                      >
                        View as
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

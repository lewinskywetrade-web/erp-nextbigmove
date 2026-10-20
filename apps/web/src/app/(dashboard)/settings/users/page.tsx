'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';
import { startImpersonation } from '@/lib/impersonation';
import { viewAsCapabilities, viewAsDisabledReason } from '@/lib/view-as';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AlertBanner, LoadingCard } from '@/components/ui/feedback';
import { FormInput } from '@/components/ui/form-input';
import { FormSelect } from '@/components/ui/form-select';
import { EmptyState } from '@/components/ui/emptystate';
import { useToast } from '@/components/ui/toast';
import { DataTable } from '@/components/data-table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import { type ColumnDef } from '@tanstack/react-table';
import { ConfirmActionDialog } from '../_components/confirm-action-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Eye, MoreHorizontal, Plus, UserPlus, Users as UsersIcon } from 'lucide-react';

type User = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  defaultTeamId?: string | null;
  createdAt?: string;
  lastLoginAt?: string | null;
  userRoleAssignments?: {
    roleId: string;
    teamId: string | null;
    role?: { id: string; name: string; key: string; workspace?: 'erp' | 'wms' };
  }[];
};

type Team = {
  id: string;
  name: string;
};

type Role = {
  id: string;
  name: string;
  key: string;
  tenantId: string | null;
  isSystem: boolean;
  workspace?: 'erp' | 'wms';
  permissions?: string[];
};

const statusOptions = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'INVITED', label: 'Invited' },
  { value: 'SUSPENDED', label: 'Suspended' },
];

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [isReady, setIsReady] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [canImpersonate, setCanImpersonate] = useState(false);
  // Impersonating yourself is rejected server-side; hiding it keeps the menu honest.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [actorIsSuperAdmin, setActorIsSuperAdmin] = useState(false);
  const [userToPreview, setUserToPreview] = useState<User | null>(null);
  const [isStartingPreview, setIsStartingPreview] = useState(false);
  const [isCheckingPermissions, setIsCheckingPermissions] = useState(true);
  const [permissionCheckResolved, setPermissionCheckResolved] = useState(false);
  const [permissionToastShown, setPermissionToastShown] = useState(false);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);

  const isPermissionDeniedError = (error: unknown) => {
    if (!error || typeof error !== 'object') return false;
    const maybeError = error as { response?: { status?: number } };
    return maybeError.response?.status === 403;
  };

  useEffect(() => {
    setIsReady(true);
  }, []);

  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;

    const checkPermissions = async () => {
      setIsCheckingPermissions(true);
      setPermissionCheckResolved(false);
      try {
        const [identityResult, permissionsResult] = await Promise.allSettled([
          apiClient.get('/auth/me'),
          apiClient.get('/auth/permissions', { params: { workspace: 'erp' } }),
        ]);
        const identity = identityResult.status === 'fulfilled' ? identityResult.value.data?.user : null;
        const permissions = permissionsResult.status === 'fulfilled' ? permissionsResult.value.data?.permissions : [];
        const capability = viewAsCapabilities(identity, permissions);
        if (!cancelled) {
          setCurrentUserId(capability.currentUserId);
          setActorIsSuperAdmin(capability.isSuperAdmin);
          setCanManage(capability.canManage);
          setCanImpersonate(capability.canImpersonate);
          setPermissionCheckResolved(true);
        }
      } catch {
        if (!cancelled) {
          setCanManage(false);
          setCanImpersonate(false);
        }
      } finally {
        if (!cancelled) {
          setIsCheckingPermissions(false);
        }
      }
    };

    void checkPermissions();
    return () => {
      cancelled = true;
    };
  }, [isReady]);

  useEffect(() => {
    if (!isReady || isCheckingPermissions || !permissionCheckResolved) return;
    if (!canManage && !permissionToastShown) {
      addToast('warning', "You don't have permission to manage users.");
      setPermissionToastShown(true);
    }
    if (canManage && permissionToastShown) {
      setPermissionToastShown(false);
    }
  }, [addToast, canManage, isCheckingPermissions, isReady, permissionCheckResolved, permissionToastShown]);

  const { data: users, isLoading, isError } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await apiClient.get('/users');
      return res.data;
    },
    enabled: canManage && !isCheckingPermissions,
  });

  const { data: teams } = useQuery<Team[]>({
    queryKey: ['teams'],
    queryFn: async () => {
      const res = await apiClient.get('/teams');
      return res.data;
    },
    staleTime: 60_000,
    enabled: canManage && !isCheckingPermissions,
  });

  const { data: erpRoles } = useQuery<Role[]>({
    queryKey: ['roles', 'erp'],
    queryFn: async () => {
      const res = await apiClient.get('/roles', {
        params: { workspace: 'erp' },
      });
      return res.data;
    },
    staleTime: 60_000,
    enabled: canManage && !isCheckingPermissions,
  });

  const [createOpen, setCreateOpen] = useState(false);
  // "Add existing user": grants an identity that already exists (in any tenant)
  // membership here — no second password, no second account.
  const [addExistingOpen, setAddExistingOpen] = useState(false);
  const [existingEmail, setExistingEmail] = useState('');
  const [existingRoleId, setExistingRoleId] = useState('');
  const [isAddingExisting, setIsAddingExisting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const [createForm, setCreateForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    teamId: '',
    roleId: '',
  });
  const [editForm, setEditForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    status: 'ACTIVE',
    teamId: '',
    roleId: '',
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiClient.post('/users', {
        firstName: createForm.firstName,
        lastName: createForm.lastName,
        email: createForm.email,
        password: createForm.password,
        teamId: createForm.teamId || undefined,
        roleId: createForm.roleId || null,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      setCreateForm({
        firstName: '',
        lastName: '',
        email: '',
        password: '',
        teamId: '',
        roleId: '',
      });
      setCreateOpen(false);
      addToast('success', 'User created successfully.');
    },
    onError: (error: unknown) => {
      if (isPermissionDeniedError(error)) {
        addToast('error', "You don't have permission to create users.");
        return;
      }
      addToast('error', 'Failed to create user.');
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      payload,
    }: {
      id: string;
      payload: Partial<User> & { roleId?: string | null };
    }) => {
      await apiClient.patch(`/users/${id}`, payload);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditOpen(false);
      setEditingUser(null);
      addToast('success', 'User updated successfully.');
    },
    onError: (error: unknown) => {
      if (isPermissionDeniedError(error)) {
        addToast('error', "You don't have permission to edit users.");
        return;
      }
      addToast('error', 'Failed to update user.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/users/${id}`);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      setUserToDelete(null);
      addToast('success', 'User deleted successfully.');
    },
    onError: (error: unknown) => {
      if (isPermissionDeniedError(error)) {
        addToast('error', "You don't have permission to delete users.");
        return;
      }
      addToast('error', 'Failed to delete user.');
    },
  });

  const teamMap = useMemo(() => {
    return new Map((teams || []).map((team) => [team.id, team.name]));
  }, [teams]);

  const getTenantRole = useCallback(
    (userItem: User) =>
      userItem.userRoleAssignments?.find(
        (assignment) => !assignment.teamId && assignment.role?.workspace !== 'wms',
      )?.role,
    [],
  );

  const isTenantAdmin = useCallback(
    (userItem: User) => getTenantRole(userItem)?.key === 'TENANT_ADMIN',
    [getTenantRole],
  );

  const getRoleLabel = useCallback(
    (userItem: User) => getTenantRole(userItem)?.name || userItem.role || '—',
    [getTenantRole],
  );

  const getTeamLabel = useCallback(
    (userItem: User) => {
      if (isTenantAdmin(userItem)) return 'All Teams';
      if (!userItem.defaultTeamId) return '—';
      return teamMap.get(userItem.defaultTeamId) || '—';
    },
    [isTenantAdmin, teamMap],
  );

  const openEditModal = useCallback((userItem: User) => {
    const tenantAssignment = userItem.userRoleAssignments?.find(
      (assignment) => !assignment.teamId && assignment.role?.workspace !== 'wms',
    );
    setEditingUser(userItem);
    setEditForm({
      firstName: userItem.firstName || '',
      lastName: userItem.lastName || '',
      email: userItem.email || '',
      status: userItem.status || 'ACTIVE',
      roleId: tenantAssignment?.roleId || '',
      teamId: userItem.defaultTeamId || '',
    });
    setEditOpen(true);
  }, []);

  const formatLastLogin = (value?: string | null) =>
    value ? new Date(value).toLocaleString() : '—';

  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-400/30',
      INACTIVE: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-400/30',
      INVITED: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-400/30',
      SUSPENDED: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:border-rose-400/30',
    };
    return (
      <span
        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${styles[status] || 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300 dark:border-slate-400/30'}`}
      >
        {statusOptions.find((opt) => opt.value === status)?.label || status}
      </span>
    );
  };

  const columns = useMemo<ColumnDef<User>[]>(
    () => [
      {
        id: 'user',
        header: 'User',
        cell: ({ row }) => (
          <div>
            <p className="font-medium text-[#0F172A] dark:text-foreground">
              {row.original.firstName} {row.original.lastName}
            </p>
            <p className="text-xs text-[#64748B] dark:text-slate-300">{row.original.email}</p>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => statusBadge(row.original.status),
      },
      {
        id: 'team',
        header: 'Team',
        cell: ({ row }) => (
          <span className="text-sm text-[#0F172A] dark:text-foreground">{getTeamLabel(row.original)}</span>
        ),
      },
      {
        id: 'role',
        header: 'Role',
        cell: ({ row }) => (
          <span className="inline-flex w-fit items-center rounded-full bg-[#F1F5F9] px-2.5 py-1 text-xs font-semibold text-[#475569] dark:bg-surface dark:text-slate-300">
            {getRoleLabel(row.original)}
          </span>
        ),
      },
      {
        id: 'last_login',
        header: 'Last Login',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm text-[#475569] dark:text-slate-300">
            {formatLastLogin(row.original.lastLoginAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <div className="flex w-full items-center justify-end gap-2">
            {canImpersonate ? (
              <span title={viewAsDisabledReason(row.original, currentUserId, actorIsSuperAdmin) ?? 'Preview this user’s ERP access'}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  iconLeft={<Eye className="h-4 w-4" aria-hidden="true" />}
                  disabled={isStartingPreview || Boolean(viewAsDisabledReason(row.original, currentUserId, actorIsSuperAdmin))}
                  aria-label={`View as ${row.original.email}`}
                  onClick={() => setUserToPreview(row.original)}
                  className="whitespace-nowrap"
                >
                  View as
                </Button>
              </span>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={`Manage ${row.original.email}`} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-surface">
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem onClick={() => openEditModal(row.original)}>
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setUserToDelete(row.original)}
                  className="text-rose-600 focus:text-rose-600"
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [getRoleLabel, getTeamLabel, openEditModal, canImpersonate, currentUserId, actorIsSuperAdmin, isStartingPreview],
  );

  const { table } = useDataTable({
    data: users || [],
    columns,
    initialState: {
      pagination: { pageIndex: 0, pageSize: 10 },
    },
  });

  if (!isReady || isCheckingPermissions) {
    return <LoadingCard label="Loading users..." />;
  }

  if (!canManage) {
    return (
      <div className="space-y-6">
        <AlertBanner tone="warning" message="You don't have permission to manage users." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4">
          <div className="text-sm text-slate-600 dark:text-slate-300">
            All Users: <span className="font-semibold text-foreground">{users?.length ?? 0}</span>
          </div>
          <Button
            variant="primary"
            iconLeft={<Plus className="h-4 w-4" />}
            onClick={() => setCreateOpen(true)}
            className='btn-icon'
          >
            Add new user
          </Button>
          <Button
            variant="secondary"
            iconLeft={<UserPlus className="h-4 w-4" />}
            onClick={() => { setExistingEmail(''); setExistingRoleId(''); setAddExistingOpen(true); }}
            className='btn-icon'
          >
            Add existing user
          </Button>
        </div>

        <div className="p-4">
          {isLoading && (
            <LoadingCard label="Loading users..." />
          )}

          {isError && (
            <AlertBanner tone="error" message="Failed to load users." />
          )}

          {!isLoading && !isError && users?.length === 0 && (
            <EmptyState
              title="No users yet"
              description="Invite your first teammate."
              icon={<UsersIcon className="h-8 w-8" />}
            />
          )}

          {!isLoading && !isError && users && users.length > 0 && (
            <DataTable table={table} />
          )}
        </div>
      </Card>

      <Dialog open={Boolean(userToPreview)} onOpenChange={(open) => {
        if (!open && !isStartingPreview) setUserToPreview(null);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>View as {userToPreview?.firstName || userToPreview?.email}</DialogTitle>
            <DialogDescription>
              Open a read-only preview of {userToPreview?.email} in this workspace for up to 15 minutes.
              You will see their menus, teams and data with their current permissions.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted">
            Changes and actions that update records are blocked. All ERP tabs in this browser share
            the preview session and will reload. Use Exit preview to return to your account.
            If the preview expires, sign in again with your own account.
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={isStartingPreview} onClick={() => setUserToPreview(null)}>Cancel</Button>
            <Button
              type="button"
              variant="primary"
              loading={isStartingPreview}
              disabled={isStartingPreview || !userToPreview}
              onClick={() => {
                if (!userToPreview || isStartingPreview) return;
                setIsStartingPreview(true);
                void startImpersonation(userToPreview.id).catch((error) => {
                  setIsStartingPreview(false);
                  addToast('error', error?.response?.data?.message ?? error?.message ?? 'Unable to preview this user.');
                });
              }}
            >
              {isStartingPreview ? 'Opening preview…' : 'Open read-only preview'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addExistingOpen} onOpenChange={setAddExistingOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add existing user</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setIsAddingExisting(true);
              try {
                await apiClient.post('/users/add-existing', {
                  email: existingEmail.trim(),
                  ...(existingRoleId ? { roleId: existingRoleId } : {}),
                });
                addToast('success', 'User added to this workspace.');
                setAddExistingOpen(false);
                await queryClient.invalidateQueries({ queryKey: ['users'] });
              } catch (error: any) {
                addToast('error', error?.response?.data?.message ?? 'Could not add that user.');
              } finally {
                setIsAddingExisting(false);
              }
            }}
          >
            <p className="text-sm text-muted">
              Enter the email of someone who already has an account. They keep their password and can switch into this workspace from the header.
            </p>
            <div className="space-y-1.5">
              <label className="form-label" htmlFor="existing-user-email">Email</label>
              <input
                id="existing-user-email"
                type="email"
                required
                value={existingEmail}
                onChange={(e) => setExistingEmail(e.target.value)}
                className="input w-full"
                placeholder="name@company.com"
              />
            </div>
            <div className="space-y-1.5">
              <label className="form-label" htmlFor="existing-user-role">Role in this workspace</label>
              <select
                id="existing-user-role"
                value={existingRoleId}
                onChange={(e) => setExistingRoleId(e.target.value)}
                className="input w-full"
              >
                <option value="">No role yet</option>
                {(erpRoles ?? []).map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              <p className="text-xs text-muted">Roles are per workspace — this does not change what they can do elsewhere.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setAddExistingOpen(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={isAddingExisting}>Add to workspace</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create User</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate();
            }}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormInput
                label="First name"
                value={createForm.firstName}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, firstName: e.target.value }))}
                required
              />
              <FormInput
                label="Last name"
                value={createForm.lastName}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, lastName: e.target.value }))}
                required
              />
            </div>

            <FormInput
              type="email"
              label="Email"
              value={createForm.email}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, email: e.target.value }))}
              required
            />

            <FormInput
              type="password"
              label="Password"
              value={createForm.password}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, password: e.target.value }))}
              required
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormSelect
                label="Role"
                value={createForm.roleId}
                onChange={(e) => {
                  const newRoleId = e.target.value;
                  const selectedRole = erpRoles?.find((r) => r.id === newRoleId);
                  const isAdmin = selectedRole?.key === 'TENANT_ADMIN';
                  setCreateForm((prev) => ({
                    ...prev,
                    roleId: newRoleId,
                    teamId: isAdmin ? '' : prev.teamId,
                  }));
                }}
                options={erpRoles?.map((r) => ({
                  value: r.id,
                  label: `${r.name}${r.tenantId ? '' : ' (default)'}`,
                })) || []}
                placeholder="No role"
              />

              {(() => {
                const selectedRole = erpRoles?.find((r) => r.id === createForm.roleId);
                const isAdmin = selectedRole?.key === 'TENANT_ADMIN';
                return isAdmin ? (
                  <div className="space-y-1.5">
                    <label className="block text-sm font-semibold text-[#0F172A]">
                      Default team
                    </label>
                    <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2 text-sm text-[#94A3B8]">
                      All Teams (Tenant Admin)
                    </div>
                  </div>
                ) : (
                  <FormSelect
                    label="Default team (optional)"
                    value={createForm.teamId}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, teamId: e.target.value }))}
                    options={teams?.map((team) => ({
                      value: team.id,
                      label: team.name,
                    })) || []}
                    placeholder="No default team"
                  />
                );
              })()}
            </div>

            {createMutation.isError && (
              <AlertBanner
                tone="error"
                message="Failed to create user. Check the details and try again."
              />
            )}

            <DialogFooter className="gap-2 sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending}
                loading={createMutation.isPending}
              >
                {createMutation.isPending ? 'Creating...' : 'Create User'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setEditingUser(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!editingUser) return;
              const selectedRole = erpRoles?.find((r) => r.id === editForm.roleId);
              const isAdmin = selectedRole?.key === 'TENANT_ADMIN';
              updateMutation.mutate({
                id: editingUser.id,
                payload: {
                  firstName: editForm.firstName,
                  lastName: editForm.lastName,
                  status: editForm.status,
                  roleId: editForm.roleId || null,
                  defaultTeamId: isAdmin ? undefined : editForm.teamId || undefined,
                },
              });
            }}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormInput
                label="First name"
                value={editForm.firstName}
                onChange={(e) => setEditForm((prev) => ({ ...prev, firstName: e.target.value }))}
                required
              />
              <FormInput
                label="Last name"
                value={editForm.lastName}
                onChange={(e) => setEditForm((prev) => ({ ...prev, lastName: e.target.value }))}
                required
              />
            </div>

            <FormInput label="Email" value={editForm.email} readOnly />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormSelect
                label="Status"
                value={editForm.status}
                onChange={(e) => setEditForm((prev) => ({ ...prev, status: e.target.value }))}
                options={statusOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
              />

              <FormSelect
                label="Role"
                value={editForm.roleId}
                onChange={(e) => {
                  const newRoleId = e.target.value;
                  const selectedRole = erpRoles?.find((r) => r.id === newRoleId);
                  const isAdmin = selectedRole?.key === 'TENANT_ADMIN';
                  setEditForm((prev) => ({
                    ...prev,
                    roleId: newRoleId,
                    teamId: isAdmin ? '' : prev.teamId,
                  }));
                }}
                options={erpRoles?.map((r) => ({
                  value: r.id,
                  label: `${r.name}${r.tenantId ? '' : ' (default)'}`,
                })) || []}
                placeholder="No role"
              />
            </div>

            {(() => {
              const selectedRole = erpRoles?.find((r) => r.id === editForm.roleId);
              const isAdmin = selectedRole?.key === 'TENANT_ADMIN';
              return isAdmin ? (
                <div className="space-y-1.5">
                  <label className="block text-sm font-semibold text-[#0F172A]">
                    Default team
                  </label>
                  <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2 text-sm text-[#94A3B8]">
                    All Teams (Tenant Admin)
                  </div>
                </div>
              ) : (
                <FormSelect
                  label="Default team (optional)"
                  value={editForm.teamId}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, teamId: e.target.value }))}
                  options={teams?.map((team) => ({
                    value: team.id,
                    label: team.name,
                  })) || []}
                  placeholder="No default team"
                />
              );
            })()}

            {updateMutation.isError && (
              <AlertBanner tone="error" message="Failed to update user. Try again." />
            )}

            <DialogFooter className="gap-2 sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={updateMutation.isPending}
                loading={updateMutation.isPending}
              >
                {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={Boolean(userToDelete)}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            setUserToDelete(null);
          }
        }}
        title="Delete User"
        description={
          userToDelete
            ? `Are you sure you want to delete "${userToDelete.firstName} ${userToDelete.lastName}"? This action cannot be undone.`
            : 'Are you sure you want to delete this user?'
        }
        confirmLabel="Delete user"
        cancelLabel="Cancel"
        isConfirming={deleteMutation.isPending}
        onConfirm={() => {
          if (!userToDelete) return;
          deleteMutation.mutate(userToDelete.id);
        }}
      />
    </div>
  );
}

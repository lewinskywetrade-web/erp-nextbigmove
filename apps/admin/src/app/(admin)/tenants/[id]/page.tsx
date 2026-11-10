'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock,
  Copy,
  GaugeCircle,
  Link2,
  PauseCircle,
  Plug,
  Users,
} from 'lucide-react';
import apiClient from '@/lib/api-client';
import { readStoredAdminUser, readStoredPermissions } from '@/lib/admin-session';
import {
  hasAnyAdminPermission,
  WMS_PARTNERS_EDIT_PERMISSIONS,
  WMS_PARTNERS_READ_PERMISSIONS,
} from '@/lib/wms-permissions';
import { WmsCompactPanel } from '../../_components/wms-compact-panel';
import { WmsPageShell } from '../../_components/wms-page-shell';
import { WmsInlineNotice } from '../../_components/wms-inline-notice';
import { WmsFormField } from '../../_components/wms-form-field';
import type { TenantPlan, TenantRecord, TenantStatus } from '../_types/tenant';
import {
  formatTenantDateTime,
  formatTenantPlan,
  formatTenantStatus,
  getTenantPlanClassName,
  getTenantStatusClassName,
} from '../_utils/tenant-presenters';

const updateTenantSchema = z.object({
  name: z.string().min(2, 'Organization name must be at least 2 characters').max(100),
  slug: z
    .string()
    .min(2, 'Tenant slug must be at least 2 characters')
    .max(50)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
  planType: z.enum(['trial', 'starter', 'professional', 'enterprise']),
  status: z.enum(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED']),
  maxUsers: z
    .number({ invalid_type_error: 'Enter the maximum number of users' })
    .int('Use a whole number')
    .min(0, 'Max users must be at least 1, or Unlimited (0)')
    .max(10000, 'Max users cannot exceed 10,000'),
  maxIntegrations: z
    .number({ invalid_type_error: 'Enter the maximum number of integrations' })
    .int('Use a whole number')
    .min(0, 'Max integrations must be at least 1, or Unlimited (0)')
    .max(100, 'Max integrations cannot exceed 100'),
  wmsFulfillmentGoLiveAt: z.string().nullable().optional(),
  billingCompanyName: z.string().max(160).nullable().optional(),
  billingAddress: z.string().max(600).nullable().optional(),
});

type UpdateTenantForm = z.infer<typeof updateTenantSchema>;

const planOptions: Array<{ value: TenantPlan; label: string }> = [
  { value: 'trial', label: 'Trial' },
  { value: 'starter', label: 'Starter' },
  { value: 'professional', label: 'Professional' },
  { value: 'enterprise', label: 'Enterprise' },
];

const statusOptions: Array<{ value: TenantStatus; label: string }> = [
  { value: 'TRIAL', label: 'Trial' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const NOTICE_AUTO_DISMISS_MS = 5000;

export default function TenantDetailsPage() {
  const router = useRouter();
  const params = useParams();
  const tenantId = params.id as string;
  const user = useMemo(() => readStoredAdminUser(), []);
  const permissions = useMemo(() => readStoredPermissions(), []);
  const canRead = useMemo(
    () => hasAnyAdminPermission(user?.role, permissions, WMS_PARTNERS_READ_PERMISSIONS),
    [permissions, user?.role],
  );
  const canEdit = useMemo(
    () => hasAnyAdminPermission(user?.role, permissions, WMS_PARTNERS_EDIT_PERMISSIONS),
    [permissions, user?.role],
  );

  const [tenant, setTenant] = useState<TenantRecord | null>(null);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [slugCopied, setSlugCopied] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<UpdateTenantForm>({
    resolver: zodResolver(updateTenantSchema),
  });

  const watchedMaxUsers = watch('maxUsers');
  const watchedMaxIntegrations = watch('maxIntegrations');

  // Keep the form baseline equal to the saved tenant so "unsaved changes"
  // and the Save button reflect real edits only.
  const resetFormFromTenant = (tenantData: TenantRecord) => {
    reset({
      name: tenantData.name,
      slug: tenantData.slug,
      planType: tenantData.planType,
      status: tenantData.status,
      maxUsers: tenantData.maxUsers,
      maxIntegrations: tenantData.maxIntegrations,
      wmsFulfillmentGoLiveAt: toDateTimeLocalInputValue(tenantData.wmsFulfillmentGoLiveAt),
      billingCompanyName: tenantData.billingCompanyName ?? '',
      billingAddress: tenantData.billingAddress ?? '',
    });
  };

  const getErrorMessage = (error: unknown, fallback: string) => {
    const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
    if (typeof message === 'string' && message.trim()) return message;
    if (Array.isArray(message) && message.length) return message.map(String).join('. ');
    return fallback;
  };

  useEffect(() => {
    if (!canRead) {
      setIsLoading(false);
      return;
    }

    const fetchTenant = async () => {
      try {
        const token = localStorage.getItem('access_token');
        if (!token) {
          router.push('/login');
          return;
        }

        const response = await apiClient.get(`/tenants/${tenantId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        const tenantData: TenantRecord = response.data;
        setTenant(tenantData);
        resetFormFromTenant(tenantData);
      } catch (error: unknown) {
        setError(getErrorMessage(error, 'Failed to load tenant'));
      } finally {
        setIsLoading(false);
      }
    };

    fetchTenant();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, tenantId, router]);

  // Arriving from "Create tenant": confirm and point to the next steps.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('created') === '1') {
      setSuccessMessage('Tenant created. Next: connect their stores under View integrations, then review users.');
      params.delete('created');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }
  }, []);

  const refreshTenant = async () => {
    try {
      const token = localStorage.getItem('access_token');
      const response = await apiClient.get(`/tenants/${tenantId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setTenant(response.data);
      resetFormFromTenant(response.data);
    } catch {
      /* no-op */
    }
  };

  const onSubmit = async (data: UpdateTenantForm) => {
    if (!canEdit) {
      return;
    }

    setError('');
    setSuccessMessage('');
    setIsSaving(true);

    try {
      const token = localStorage.getItem('access_token');
      await apiClient.patch(`/tenants/${tenantId}`, {
        ...data,
        wmsFulfillmentGoLiveAt: toIsoDateTimeOrNull(data.wmsFulfillmentGoLiveAt),
        billingCompanyName: data.billingCompanyName?.trim() || null,
        billingAddress: data.billingAddress?.trim() || null,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });

      setSuccessMessage('Tenant updated successfully');
      await refreshTenant();
    } catch (error: unknown) {
      setError(getErrorMessage(error, 'Failed to update tenant'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleStatusAction = async (status: TenantStatus, confirmMessage?: string) => {
    if (!canEdit) {
      return;
    }

    if (confirmMessage && !confirm(confirmMessage)) {
      return;
    }

    try {
      const token = localStorage.getItem('access_token');
      await apiClient.patch(
        `/tenants/${tenantId}`,
        { status },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setError('');
      setSuccessMessage(`Tenant status set to ${formatTenantStatus(status)}`);
      await refreshTenant();
    } catch (error: unknown) {
      setSuccessMessage('');
      setError(getErrorMessage(error, `Failed to set status to ${formatTenantStatus(status)}`));
    }
  };

  const handleCopySlug = async () => {
    if (!tenant?.slug) {
      return;
    }
    let copied = false;
    try {
      await navigator.clipboard.writeText(tenant.slug);
      copied = true;
    } catch {
      // Clipboard API can be unavailable (permissions/insecure context);
      // fall back to a temporary selection.
      try {
        const textarea = document.createElement('textarea');
        textarea.value = tenant.slug;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch {
        copied = false;
      }
    }
    if (copied) {
      setSlugCopied(true);
      setTimeout(() => setSlugCopied(false), 1500);
    } else {
      setError('Could not copy the slug. Select it and copy manually.');
    }
  };

  const usageMetrics = useMemo(() => {
    if (!tenant) {
      return null;
    }
    const users = tenant._count?.users ?? 0;
    const integrations = tenant._count?.integrations ?? 0;
    return {
      users,
      integrations,
      usersPercent: tenant.maxUsers > 0 ? Math.min(100, Math.round((users / tenant.maxUsers) * 100)) : 0,
      integrationsPercent:
        tenant.maxIntegrations > 0
          ? Math.min(100, Math.round((integrations / tenant.maxIntegrations) * 100))
          : 0,
    };
  }, [tenant]);

  if (isLoading) {
    return (
      <WmsPageShell title="Tenant" breadcrumb="Tenants">
        <WmsInlineNotice tone="info">Loading tenant…</WmsInlineNotice>
      </WmsPageShell>
    );
  }

  if (!tenant) {
    return (
      <WmsPageShell title="Tenant" breadcrumb="Tenants">
        <WmsInlineNotice tone="error">
          {canRead ? 'Tenant not found' : 'You do not have permission to view partners.'}
        </WmsInlineNotice>
      </WmsPageShell>
    );
  }

  return (
    <WmsPageShell
      title={tenant.name}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link
            href="/tenants"
            className="btn btn-md btn-outline btn-icon"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Link>
        </div>
        <div className='space-x-2'>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${getTenantStatusClassName(tenant.status)}`}
          >
            {formatTenantStatus(tenant.status)}
          </span>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${getTenantPlanClassName(tenant.planType)}`}
          >
            {formatTenantPlan(tenant.planType)}
          </span>
        </div>
      </div>
      
      {error ? (
        <WmsInlineNotice
          tone="error"
          dismissible
          autoDismissMs={NOTICE_AUTO_DISMISS_MS}
          onDismiss={() => setError('')}
        >
          {error}
        </WmsInlineNotice>
      ) : null}
      {successMessage ? (
        <WmsInlineNotice
          tone="success"
          dismissible
          autoDismissMs={NOTICE_AUTO_DISMISS_MS}
          onDismiss={() => setSuccessMessage('')}
        >
          {successMessage}
        </WmsInlineNotice>
      ) : null}
      {!canEdit ? (
        <WmsInlineNotice tone="info">You have read-only access to this partner.</WmsInlineNotice>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,360px)]">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          <WmsCompactPanel title="Identity" icon={<Building2 className='panel-icon' />}>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <WmsFormField label="Organization name">
                  <input {...register('name')} type="text" className="input" disabled={!canEdit} />
                </WmsFormField>
                {errors.name ? (
                  <p className="mt-1.5 text-[12px] text-rose-600">{errors.name.message}</p>
                ) : null}
              </div>

              <div className="sm:col-span-2">
                <WmsFormField label="Tenant slug" hint="Appears in URLs. Lowercase letters, numbers, and hyphens only.">
                  <div className="flex items-center gap-2">
                    <input
                      {...register('slug')}
                      type="text"
                      className="input font-mono tracking-tight"
                      disabled={!canEdit}
                    />
                    <button
                      type="button"
                      onClick={handleCopySlug}
                      className="btn btn-md btn-outline btn-icon"
                    >
                      {slugCopied ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                </WmsFormField>
                {errors.slug ? (
                  <p className="mt-1.5 text-[12px] text-rose-600">{errors.slug.message}</p>
                ) : null}
              </div>
            </div>
          </WmsCompactPanel>

          <WmsCompactPanel title="Plan" icon={<ClipboardList className='panel-icon' />}>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <WmsFormField label="Plan type">
                <select {...register('planType')} className="input" disabled={!canEdit}>
                  {planOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </WmsFormField>

              <WmsFormField label="Status">
                <select {...register('status')} className="input" disabled={!canEdit}>
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </WmsFormField>

              <WmsFormField label="Max users">
                <div className="flex items-center gap-2">
                  {watchedMaxUsers === 0 ? (
                    <input
                      type="text"
                      value="Unlimited"
                      readOnly
                      disabled={!canEdit}
                      onClick={() => {
                        if (!canEdit) return;
                        setValue(
                          'maxUsers',
                          tenant.maxUsers > 0 ? tenant.maxUsers : 20,
                          { shouldDirty: true, shouldValidate: true },
                        );
                      }}
                      className="input flex-1 cursor-pointer bg-[#f4f8fa] font-semibold text-primary"
                    />
                  ) : null}
                  <input
                    {...register('maxUsers', { valueAsNumber: true })}
                    type="number"
                    min={1}
                    max={10000}
                    className={watchedMaxUsers === 0 ? 'sr-only' : 'input flex-1'}
                    disabled={!canEdit}
                  />
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() =>
                      setValue(
                        'maxUsers',
                        watchedMaxUsers === 0 ? (tenant.maxUsers > 0 ? tenant.maxUsers : 20) : 0,
                        { shouldDirty: true, shouldValidate: true },
                      )
                    }
                    className={`btn btn-md shrink-0 ${
                      watchedMaxUsers === 0 ? 'btn-primary' : 'btn-outline'
                    }`}
                  >
                    Unlimited
                  </button>
                </div>
                {errors.maxUsers ? (
                  <p className="mt-1.5 text-[12px] text-rose-600">{errors.maxUsers.message}</p>
                ) : null}
              </WmsFormField>

              <WmsFormField label="Max integrations">
                <div className="flex items-center gap-2">
                  {watchedMaxIntegrations === 0 ? (
                    <input
                      type="text"
                      value="Unlimited"
                      readOnly
                      disabled={!canEdit}
                      onClick={() => {
                        if (!canEdit) return;
                        setValue(
                          'maxIntegrations',
                          tenant.maxIntegrations > 0 ? tenant.maxIntegrations : 5,
                          { shouldDirty: true, shouldValidate: true },
                        );
                      }}
                      className="input flex-1 cursor-pointer bg-[#f4f8fa] font-semibold text-primary"
                    />
                  ) : null}
                  <input
                    {...register('maxIntegrations', { valueAsNumber: true })}
                    type="number"
                    min={1}
                    max={100}
                    className={watchedMaxIntegrations === 0 ? 'sr-only' : 'input flex-1'}
                    disabled={!canEdit}
                  />
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() =>
                      setValue(
                        'maxIntegrations',
                        watchedMaxIntegrations === 0
                          ? tenant.maxIntegrations > 0
                            ? tenant.maxIntegrations
                            : 5
                          : 0,
                        { shouldDirty: true, shouldValidate: true },
                      )
                    }
                    className={`btn btn-md shrink-0 ${
                      watchedMaxIntegrations === 0 ? 'btn-primary' : 'btn-outline'
                    }`}
                  >
                    Unlimited
                  </button>
                </div>
                {errors.maxIntegrations ? (
                  <p className="mt-1.5 text-[12px] text-rose-600">{errors.maxIntegrations.message}</p>
                ) : null}
              </WmsFormField>
            </div>
          </WmsCompactPanel>

          <WmsCompactPanel title="WMS cutover" icon={<Clock className='panel-icon' />}>
            <div className="grid gap-4 p-5">
              <div>
                <WmsFormField
                  label="Fulfillment go-live"
                  hint="Only POS orders inserted at or after this timestamp will enter WMS pick and pack queues for this tenant."
                >
                  <input
                    {...register('wmsFulfillmentGoLiveAt')}
                    type="datetime-local"
                    className="input"
                    disabled={!canEdit}
                  />
                </WmsFormField>
                {errors.wmsFulfillmentGoLiveAt ? (
                  <p className="mt-1.5 text-[12px] text-rose-600">{errors.wmsFulfillmentGoLiveAt.message}</p>
                ) : null}
              </div>
              <p className="text-[12px] leading-5 text-[#6f8290]">
                Existing legacy fulfillment rows are not deleted by this setting. It prevents pre-go-live orders from entering or appearing in active WMS pick and pack queues.
              </p>
            </div>
          </WmsCompactPanel>

          <WmsCompactPanel title="Invoice bill-to" icon={<Building2 className='panel-icon' />}>
            <div className="grid gap-4 p-5">
              <div>
                <WmsFormField
                  label="Billing company name"
                  hint="This becomes the default bill-to company name for this partner on WMS invoices."
                >
                  <input
                    {...register('billingCompanyName')}
                    type="text"
                    className="input"
                    placeholder="Defaults to tenant name if left blank"
                    disabled={!canEdit}
                  />
                </WmsFormField>
                {errors.billingCompanyName ? (
                  <p className="mt-1.5 text-[12px] text-rose-600">{errors.billingCompanyName.message}</p>
                ) : null}
              </div>

              <div>
                <WmsFormField
                  label="Billing address"
                  hint="Shown in the invoice bill-to block for this partner."
                >
                  <textarea
                    {...register('billingAddress')}
                    className="input min-h-[120px] py-3"
                    placeholder="Partner billing address"
                    disabled={!canEdit}
                  />
                </WmsFormField>
                {errors.billingAddress ? (
                  <p className="mt-1.5 text-[12px] text-rose-600">{errors.billingAddress.message}</p>
                ) : null}
              </div>
            </div>
          </WmsCompactPanel>

          <div className="flex items-center justify-end gap-3 rounded-2xl border border-[#dce4ea] bg-white/90 px-4 py-3 shadow-[0_18px_36px_-28px_rgba(18,56,75,0.35)] backdrop-blur">
            <span className="mr-auto text-[12px] text-[#6f8290]">
              {isDirty ? 'You have unsaved changes' : 'All changes saved'}
            </span>
            <button
              type="submit"
              disabled={isSaving || !isDirty || !canEdit}
              className="btn btn-md btn-primary"
            >
              {isSaving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>

        <aside className="space-y-5">
          <WmsCompactPanel title="Usage" icon={<GaugeCircle className='panel-icon' />}>
            <div className="space-y-4 p-5">
              <UsageRow
                icon={<Users className="h-4 w-4" />}
                label="Users"
                current={usageMetrics?.users ?? 0}
                max={tenant.maxUsers}
                percent={usageMetrics?.usersPercent ?? 0}
              />
              <UsageRow
                icon={<Plug className="h-4 w-4" />}
                label="Integrations"
                current={usageMetrics?.integrations ?? 0}
                max={tenant.maxIntegrations}
                percent={usageMetrics?.integrationsPercent ?? 0}
              />
            </div>
          </WmsCompactPanel>

          <WmsCompactPanel title="Timeline" icon={<Clock className='panel-icon' />}>
            <div className="space-y-2.5 p-5">
              <TimelineRow
                icon={<CalendarClock className="h-3.5 w-3.5" />}
                label="Created"
                value={formatTenantDateTime(tenant.createdAt)}
              />
              {tenant.updatedAt ? (
                <TimelineRow
                  icon={<CalendarClock className="h-3.5 w-3.5" />}
                  label="Last updated"
                  value={formatTenantDateTime(tenant.updatedAt)}
                />
              ) : null}
              {tenant.trialEndsAt ? (
                <TimelineRow
                  icon={<CalendarClock className="h-3.5 w-3.5" />}
                  label="Trial ends"
                  value={formatTenantDateTime(tenant.trialEndsAt)}
                />
              ) : null}
              {tenant.wmsFulfillmentGoLiveAt ? (
                <TimelineRow
                  icon={<Clock className="h-3.5 w-3.5" />}
                  label="WMS go-live"
                  value={formatTenantDateTime(tenant.wmsFulfillmentGoLiveAt)}
                />
              ) : null}
            </div>
          </WmsCompactPanel>

          <WmsCompactPanel title="Actions" icon={<ArrowLeftRight className='panel-icon' />}>
            <div className="space-y-2 p-5">
              {tenant.status !== 'ACTIVE' ? (
                <QuickActionButton
                  icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                  label={tenant.status === 'TRIAL' ? 'Activate tenant (end trial)' : 'Activate tenant'}
                  onClick={() => handleStatusAction('ACTIVE')}
                  tone="primary"
                  disabled={!canEdit}
                />
              ) : null}
              {tenant.status === 'ACTIVE' || tenant.status === 'TRIAL' ? (
                <QuickActionButton
                  icon={<PauseCircle className="h-3.5 w-3.5" />}
                  label="Suspend tenant"
                  onClick={() =>
                    handleStatusAction('SUSPENDED', 'Are you sure you want to suspend this tenant?')
                  }
                  tone="warning"
                  disabled={!canEdit}
                />
              ) : null}
              <QuickActionButton
                icon={<Users className="h-3.5 w-3.5" />}
                label="View users"
                href={`/tenants/${tenant.id}/users`}
              />
              <QuickActionButton
                icon={<Link2 className="h-3.5 w-3.5" />}
                label="View integrations"
                href={`/tenants/${tenant.id}/integrations`}
              />
            </div>
          </WmsCompactPanel>

          <WmsCompactPanel title="Danger zone" icon={<AlertTriangle className='panel-icon' />}>
            <div className="p-5">
              <h3 className="text-[1.1rem] font-semibold tracking-tight text-primary">Cancel tenant</h3>
              {tenant.status === 'CANCELLED' ? (
                <p className="mt-1.5 text-[13px] leading-5 text-[#6f8290]">
                  This tenant is cancelled and its users cannot sign in. Use Activate tenant above to restore access.
                </p>
              ) : (
                <>
                  <p className="mt-1.5 text-[13px] leading-5 text-[#6f8290]">
                    Cancellation disables the tenant. Data is retained for compliance.
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      handleStatusAction(
                        'CANCELLED',
                        'Cancel this tenant? The organization will lose access immediately.',
                      )
                    }
                    className="btn btn-md btn-destructive btn-icon mt-3 w-full"
                    disabled={!canEdit}
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Cancel tenant
                  </button>
                </>
              )}
            </div>
          </WmsCompactPanel>
        </aside>
      </div>
    </WmsPageShell>
  );
}

function toDateTimeLocalInputValue(value: string | null | undefined) {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  const local = new Date(parsed.getTime() - (parsed.getTimezoneOffset() * 60_000));
  return local.toISOString().slice(0, 16);
}

function toIsoDateTimeOrNull(value: string | null | undefined) {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function UsageRow({
  icon,
  label,
  current,
  max,
  percent,
}: {
  icon: ReactNode;
  label: string;
  current: number;
  max: number;
  percent: number;
}) {
  const barColor =
    percent >= 90 ? 'bg-rose-400' : percent >= 70 ? 'bg-amber-400' : 'bg-primary';

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-[#6c8190]">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white">
            {icon}
          </span>
          {label}
        </div>
        <span className="text-[12px] font-semibold tabular-nums text-primary">
          {current.toLocaleString()} / {max <= 0 ? 'Unlimited' : max.toLocaleString()}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#eef2f5]">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function TimelineRow({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-[#dce4ea] bg-[#fbfcfc] px-3.5 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-white">
          {icon}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">
          {label}
        </span>
      </div>
      <span className="truncate text-right text-[12.5px] font-semibold text-primary" title={value}>
        {value}
      </span>
    </div>
  );
}

type QuickActionTone = 'neutral' | 'primary' | 'warning';

function QuickActionButton({
  icon,
  label,
  href,
  onClick,
  tone = 'neutral',
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  href?: string;
  onClick?: () => void;
  tone?: QuickActionTone;
  disabled?: boolean;
}) {
  const toneClasses: Record<QuickActionTone, string> = {
    neutral:
      'btn-outline',
    primary:
      'btn-success',
    warning:
      'btn-warning',
  };

  const base =
    'btn btn-md btn-icon w-full';

  if (href) {
    return (
      <Link
        href={href}
        aria-disabled={disabled}
        className={`${base} ${toneClasses[tone]} ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      >
        <span className="inline-flex items-center gap-2">
          {icon}
          {label}
        </span>
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${toneClasses[tone]} ${disabled ? 'opacity-50' : ''}`}
    >
      <span className="inline-flex items-center gap-2">
        {icon}
        {label}
      </span>
    </button>
  );
}

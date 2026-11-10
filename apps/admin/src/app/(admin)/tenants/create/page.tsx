'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { ArrowLeft, Building2, ClipboardCheck, Crown, ShieldCheck, Sparkles, UserCog, User as UserIcon } from 'lucide-react';
import apiClient from '@/lib/api-client';
import { readStoredAdminUser, readStoredPermissions } from '@/lib/admin-session';
import {
  hasAnyAdminPermission,
  WMS_PARTNERS_WRITE_PERMISSIONS,
} from '@/lib/wms-permissions';
import { WmsCompactPanel } from '../../_components/wms-compact-panel';
import { WmsPageShell } from '../../_components/wms-page-shell';
import { WmsInlineNotice } from '../../_components/wms-inline-notice';
import { WmsFormField } from '../../_components/wms-form-field';
import type { TenantPlan, TenantStatus } from '../_types/tenant';

const createTenantSchema = z.object({
  tenantName: z.string().min(2, 'Organization name must be at least 2 characters').max(100),
  tenantSlug: z
    .string()
    .min(2, 'Tenant slug must be at least 2 characters')
    .max(50)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Slug must use lowercase letters and numbers, separated by single hyphens (no hyphen at the start or end)',
    ),
  email: z.string().trim().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100)
    .regex(
      /((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/,
      'Password must contain uppercase, lowercase, and number/special character',
    ),
  firstName: z.string().min(2, 'First name must be at least 2 characters').max(50),
  lastName: z.string().min(2, 'Last name must be at least 2 characters').max(50),
  planType: z.enum(['trial', 'starter', 'professional', 'enterprise']),
  status: z.enum(['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED']),
  maxUsers: z
    .number({ invalid_type_error: 'Enter the maximum number of users' })
    .int('Use a whole number')
    .min(1, 'Max users must be at least 1')
    .max(10000, 'Max users cannot exceed 10,000'),
  maxIntegrations: z
    .number({ invalid_type_error: 'Enter the maximum number of integrations' })
    .int('Use a whole number')
    .min(1, 'Max integrations must be at least 1')
    .max(100, 'Max integrations cannot exceed 100'),
  trialDays: z
    .number({ invalid_type_error: 'Enter the trial length in days' })
    .int('Use a whole number')
    .min(1, 'Trial must be at least 1 day')
    .max(14, 'Trial cannot exceed 14 days')
    .optional(),
  billingCompanyName: z.string().max(160).nullable().optional(),
  billingAddress: z.string().max(600).nullable().optional(),
});

type CreateTenantForm = z.infer<typeof createTenantSchema>;

type PlanPreset = {
  value: TenantPlan;
  label: string;
  tagline: string;
  icon: typeof Sparkles;
  accent: string;
  suggestedMaxUsers: number;
  suggestedMaxIntegrations: number;
  defaultStatus: TenantStatus;
};

const planPresets: PlanPreset[] = [
  {
    value: 'trial',
    label: 'Trial',
    tagline: 'Evaluate the platform for up to 14 days.',
    icon: Sparkles,
    accent: 'from-[#f8f7f0] to-[#f2ecdb]',
    suggestedMaxUsers: 10,
    suggestedMaxIntegrations: 5,
    defaultStatus: 'TRIAL',
  },
  {
    value: 'starter',
    label: 'Starter',
    tagline: 'Small teams getting started in production.',
    icon: ShieldCheck,
    accent: 'from-[#f0f5ea] to-[#e6eed5]',
    suggestedMaxUsers: 25,
    suggestedMaxIntegrations: 10,
    defaultStatus: 'ACTIVE',
  },
  {
    value: 'professional',
    label: 'Professional',
    tagline: 'Growing teams with multiple channels.',
    icon: Building2,
    accent: 'from-[#eaf1f5] to-[#d6e4ec]',
    suggestedMaxUsers: 100,
    suggestedMaxIntegrations: 25,
    defaultStatus: 'ACTIVE',
  },
  {
    value: 'enterprise',
    label: 'Enterprise',
    tagline: 'Large organizations with advanced limits.',
    icon: Crown,
    accent: 'from-[#efecf8] to-[#ddd4f0]',
    suggestedMaxUsers: 1000,
    suggestedMaxIntegrations: 50,
    defaultStatus: 'ACTIVE',
  },
];

const statusOptions: Array<{ value: TenantStatus; label: string }> = [
  { value: 'TRIAL', label: 'Trial' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const createTenantSlugFromName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');

const sanitizeTenantSlugInput = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]+/g, '');

const normalizeTrialDaysInput = (value: string) => {
  if (value === '') {
    return '';
  }

  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return '';
  }

  if (parsedValue > 14) {
    return 14;
  }

  return parsedValue;
};

const clampTrialDaysInput = (value: string) => {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue) || parsedValue < 1) {
    return 1;
  }

  if (parsedValue > 14) {
    return 14;
  }

  return parsedValue;
};

export default function CreateTenantPage() {
  const router = useRouter();
  const user = readStoredAdminUser();
  const permissions = readStoredPermissions();
  const canWrite = hasAnyAdminPermission(user?.role, permissions, WMS_PARTNERS_WRITE_PERMISSIONS);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateTenantForm>({
    resolver: zodResolver(createTenantSchema),
    defaultValues: {
      planType: 'trial',
      status: 'TRIAL',
      maxUsers: 10,
      maxIntegrations: 5,
      trialDays: 14,
    },
  });

  const getErrorMessage = (error: unknown, fallback: string) => {
    const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
    if (typeof message === 'string' && message.trim()) return message;
    if (Array.isArray(message) && message.length) return message.map(String).join('. ');
    return fallback;
  };

  const planType = watch('planType');
  const status = watch('status');
  const trialDaysField = register('trialDays', { valueAsNumber: true });

  const handleTenantNameChange = (name: string) => {
    setValue('tenantSlug', createTenantSlugFromName(name), { shouldValidate: false });
  };

  const handlePlanSelect = (preset: PlanPreset) => {
    setValue('planType', preset.value);
    setValue('status', preset.defaultStatus);
    setValue('maxUsers', preset.suggestedMaxUsers);
    setValue('maxIntegrations', preset.suggestedMaxIntegrations);
  };

  const onSubmit = async (data: CreateTenantForm) => {
    setError('');
    setIsLoading(true);

    try {
      const token = localStorage.getItem('access_token');
      if (!token) {
        router.push('/login');
        return;
      }

      const response = await apiClient.post('/tenants', {
        ...data,
        tenantName: data.tenantName.trim(),
        email: data.email.trim().toLowerCase(),
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        // A trial length only applies to tenants that start on trial.
        trialDays: data.status === 'TRIAL' ? data.trialDays : undefined,
        billingCompanyName: data.billingCompanyName?.trim() || undefined,
        billingAddress: data.billingAddress?.trim() || undefined,
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const createdId = (response.data as { tenant?: { id?: string } })?.tenant?.id;
      router.push(createdId ? `/tenants/${createdId}?created=1` : '/tenants');
    } catch (error: unknown) {
      setError(getErrorMessage(error, 'Failed to create tenant. Please try again.'));
      setIsLoading(false);
      // The notice renders at the top of the form.
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  return (
    <WmsPageShell
      title="Create tenant"
      actions={
        <Link
          href="/tenants"
          className="btn btn-lg btn-outline btn-icon"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to tenants
        </Link>
      }
    >
      {!canWrite ? (
        <WmsInlineNotice tone="error">You do not have permission to create partners.</WmsInlineNotice>
      ) : null}
      {error ? <WmsInlineNotice tone="error">{error}</WmsInlineNotice> : null}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <WmsCompactPanel title="Organization" icon={<Building2 className='panel-icon' />}>
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <WmsFormField label="Organization name">
                <input
                  {...register('tenantName')}
                  type="text"
                  onChange={(event) => {
                    register('tenantName').onChange(event);
                    handleTenantNameChange(event.target.value);
                  }}
                  className="input"
                  placeholder="Acme Corporation"
                />
              </WmsFormField>
              {errors.tenantName ? (
                <p className="mt-1.5 text-[12px] text-rose-600">{errors.tenantName.message}</p>
              ) : null}
            </div>

            <div className="sm:col-span-2">
              <WmsFormField
                label="Tenant slug"
                hint="Used in URLs. Lowercase letters, numbers, and hyphens only."
              >
                <input
                  {...register('tenantSlug')}
                  type="text"
                  onChange={(event) => {
                    const sanitizedSlug = sanitizeTenantSlugInput(event.target.value);
                    event.target.value = sanitizedSlug;
                    register('tenantSlug').onChange(event);
                  }}
                  className="input font-mono tracking-tight"
                  placeholder="acme-corp"
                />
              </WmsFormField>
              {errors.tenantSlug ? (
                <p className="mt-1.5 text-[12px] text-rose-600">{errors.tenantSlug.message}</p>
              ) : null}
            </div>
          </div>
        </WmsCompactPanel>

        <WmsCompactPanel title="Admin account" icon={<UserCog className='panel-icon' />}>
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <div>
              <WmsFormField label="First name">
                <input {...register('firstName')} type="text" className="input" placeholder="Juan" />
              </WmsFormField>
              {errors.firstName ? (
                <p className="mt-1.5 text-[12px] text-rose-600">{errors.firstName.message}</p>
              ) : null}
            </div>

            <div>
              <WmsFormField label="Last name">
                <input {...register('lastName')} type="text" className="input" placeholder="Dela Cruz" />
              </WmsFormField>
              {errors.lastName ? (
                <p className="mt-1.5 text-[12px] text-rose-600">{errors.lastName.message}</p>
              ) : null}
            </div>

            <div className="sm:col-span-2">
              <WmsFormField label="Email address">
                <div className="flex items-center gap-2">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#dce4ea] bg-[#fbfcfc] text-[#5e8196]">
                    <UserIcon className="h-4 w-4" />
                  </span>
                  <input
                    {...register('email')}
                    type="email"
                    className="input"
                    placeholder="admin@acme.com"
                  />
                </div>
              </WmsFormField>
              {errors.email ? (
                <p className="mt-1.5 text-[12px] text-rose-600">{errors.email.message}</p>
              ) : null}
            </div>

            <div className="sm:col-span-2">
              <WmsFormField
                label="Password"
                hint="Must be at least 8 characters and include uppercase, lowercase, and a number or symbol."
              >
                <input
                  {...register('password')}
                  type="password"
                  className="input"
                  placeholder="••••••••"
                />
              </WmsFormField>
              {errors.password ? (
                <p className="mt-1.5 text-[12px] text-rose-600">{errors.password.message}</p>
              ) : null}
            </div>
          </div>
        </WmsCompactPanel>

        <WmsCompactPanel title="Plan & limits" icon={<ClipboardCheck className='panel-icon' />}>
          <div className="space-y-5 p-5">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {planPresets.map((preset) => {
                const Icon = preset.icon;
                const isActive = planType === preset.value;
                return (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => handlePlanSelect(preset)}
                    className={`group relative overflow-hidden rounded-[18px] border p-4 text-left transition ${
                      isActive
                        ? 'border-primary shadow-[0_18px_36px_-28px_rgba(18,56,75,0.45)]'
                        : 'border-[#dce4ea] hover:border-[#c6d4dd]'
                    }`}
                  >
                    <div className={`card absolute inset-0 bg-gradient-to-br opacity-60 ${preset.accent}`} />
                    <div className="relative z-10 flex h-full flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-primary shadow-sm">
                          <Icon className="h-4 w-4" />
                        </span>
                        {isActive ? (
                          <span className="rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white">
                            Selected
                          </span>
                        ) : null}
                      </div>
                      <div>
                        <p className="text-[15px] font-semibold text-primary">{preset.label}</p>
                        <p className="mt-1 text-[12px] leading-5 text-[#5f7483]">{preset.tagline}</p>
                      </div>
                      <div className="mt-auto flex items-center justify-between text-[11px] font-semibold text-[#4d6677]">
                        <span>{preset.suggestedMaxUsers.toLocaleString()} users</span>
                        <span>{preset.suggestedMaxIntegrations} integrations</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <WmsFormField label="Status">
                <select {...register('status')} className="input w-full">
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </WmsFormField>

              {status === 'TRIAL' ? (
                <WmsFormField label="Trial duration (days)">
                  <input
                    {...trialDaysField}
                    type="number"
                    min={1}
                    max={14}
                    onChange={(event) => {
                      const normalizedTrialDays = normalizeTrialDaysInput(event.target.value);
                      event.target.value = normalizedTrialDays === '' ? '' : String(normalizedTrialDays);
                      trialDaysField.onChange(event);
                    }}
                    onBlur={(event) => {
                      const clampedTrialDays = clampTrialDaysInput(event.target.value);
                      event.target.value = String(clampedTrialDays);
                      trialDaysField.onBlur(event);
                      setValue('trialDays', clampedTrialDays, { shouldDirty: true, shouldValidate: true });
                    }}
                    className="input"
                  />
                  {errors.trialDays ? (
                    <p className="mt-1.5 text-[12px] text-rose-600">{errors.trialDays.message}</p>
                  ) : null}
                </WmsFormField>
              ) : null}

              <WmsFormField label="Max users">
                <input
                  {...register('maxUsers', { valueAsNumber: true })}
                  type="number"
                  min={1}
                  max={10000}
                  className="input"
                />
                {errors.maxUsers ? (
                  <p className="mt-1.5 text-[12px] text-rose-600">{errors.maxUsers.message}</p>
                ) : null}
              </WmsFormField>

              <WmsFormField label="Max integrations">
                <input
                  {...register('maxIntegrations', { valueAsNumber: true })}
                  type="number"
                  min={1}
                  max={100}
                  className="input"
                />
                {errors.maxIntegrations ? (
                  <p className="mt-1.5 text-[12px] text-rose-600">{errors.maxIntegrations.message}</p>
                ) : null}
              </WmsFormField>
            </div>
          </div>
        </WmsCompactPanel>

        <WmsCompactPanel title="Invoice bill-to" icon={<Building2 className='panel-icon' />}>
          <div className="grid gap-4 p-5">
            <div>
              <WmsFormField
                label="Billing company name"
                hint="Default bill-to company name used when WMS generates invoices for this partner."
              >
                <input
                  {...register('billingCompanyName')}
                  type="text"
                  className="input"
                  placeholder="Defaults to organization name if left blank"
                />
              </WmsFormField>
              {errors.billingCompanyName ? (
                <p className="mt-1.5 text-[12px] text-rose-600">{errors.billingCompanyName.message}</p>
              ) : null}
            </div>

            <div>
              <WmsFormField
                label="Billing address"
                hint="Default bill-to address shown on WMS invoices for this partner."
              >
                <textarea
                  {...register('billingAddress')}
                  className="input min-h-[120px] py-3"
                  placeholder="Partner billing address"
                />
              </WmsFormField>
              {errors.billingAddress ? (
                <p className="mt-1.5 text-[12px] text-rose-600">{errors.billingAddress.message}</p>
              ) : null}
            </div>
          </div>
        </WmsCompactPanel>

        <div className="flex items-center justify-end gap-3 rounded-[20px] border border-[#dce4ea] bg-white/90 px-4 py-3 shadow-[0_18px_36px_-28px_rgba(18,56,75,0.35)] backdrop-blur">
          <Link
            href="/tenants"
            className="btn btn-md btn-outline"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={isLoading || !canWrite}
            className="btn btn-md btn-primary"
          >
            {isLoading ? 'Creating…' : 'Create tenant'}
          </button>
        </div>
      </form>
    </WmsPageShell>
  );
}

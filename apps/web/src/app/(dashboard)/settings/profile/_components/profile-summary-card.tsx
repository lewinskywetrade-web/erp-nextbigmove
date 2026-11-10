'use client';

import { User } from 'lucide-react';
import { DashboardSection } from '../../../dashboard/_components/dashboard-section';

interface ProfileSummaryCardProps {
  initials: string;
  displayName: string;
  email: string;
  tenantName: string | null;
  employeeId: string;
  fallbackEmployeeId: string | null | undefined;
  roleText: string;
  teamText: string;
}

export function ProfileSummaryCard({
  initials,
  displayName,
  email,
  tenantName,
  employeeId,
  fallbackEmployeeId,
  roleText,
  teamText,
}: ProfileSummaryCardProps) {
  return (
    <DashboardSection
      title="Profile Summary"
      icon={<User className="panel-icon" />}
      className="lg:col-span-1"
      contentClassName="space-y-4 p-6"
    >
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground">
          {initials}
        </div>
        <div className="space-y-1">
          <p className="text-base font-semibold text-foreground">{displayName}</p>
          <p className="text-sm text-slate-600 dark:text-slate-300">{email}</p>
        </div>
      </div>
      <div className="mt-4 space-y-2 rounded-xl border border-slate-200 bg-slate-50/85 dark:bg-background-secondary dark:border-border px-4 py-3 text-sm text-slate-600 dark:text-slate-300">
        <div className="flex items-center justify-between">
          <span>Client</span>
          <span className="font-semibold text-foreground">{tenantName || '—'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Employee ID</span>
          <span className="font-semibold text-foreground">
            {employeeId || fallbackEmployeeId || '—'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>Role</span>
          <span className="font-semibold text-foreground">{roleText}</span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <span className="mt-0.5">Teams</span>
          <span className="text-right font-semibold text-foreground">{teamText}</span>
        </div>
      </div>
    </DashboardSection>
  );
}

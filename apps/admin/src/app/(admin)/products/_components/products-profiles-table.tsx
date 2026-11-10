'use client';

import { PackageSearch, Pencil } from 'lucide-react';
import {
  formatProductProfileStatus,
  getProductProfileStatusClasses,
} from '../_utils/product-profile-presenters';
import type { WmsProductProfileRecord } from '../_types/product';

type ProductsProfilesTableProps = {
  profiles: WmsProductProfileRecord[];
  isLoading: boolean;
  tenantReady: boolean;
  canEditProfile: boolean;
  onEditProfile: (profile: WmsProductProfileRecord) => void;
  variant?: 'card' | 'embedded';
};

export function ProductsProfilesTable({
  profiles,
  isLoading,
  tenantReady,
  canEditProfile,
  onEditProfile,
  variant = 'card',
}: ProductsProfilesTableProps) {
  const isEmbedded = variant === 'embedded';

  return (
    <div
      className={
        isEmbedded
          ? 'overflow-hidden'
          : 'overflow-hidden rounded-[20px] border border-[#dce4ea] bg-white'
      }
    >
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[#eef2f5]">
          <thead className="bg-[#eff3f6]">
            <tr>
              <TableHeader className="min-w-[280px]">Product</TableHeader>
              <TableHeader>Variation ID</TableHeader>
              <TableHeader>Product ID</TableHeader>
              <TableHeader>Store</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>Serialized</TableHeader>
              <TableHeader>Action</TableHeader>
            </tr>
          </thead>

          <tbody className="divide-y divide-[#eef2f5]">
            {isLoading ? (
              Array.from({ length: 6 }).map((_, rowIndex) => (
                <tr key={`loading-${rowIndex}`}>
                  {Array.from({ length: 7 }).map((__, cellIndex) => (
                    <td key={`loading-${rowIndex}-${cellIndex}`} className="px-4 py-3.5">
                      <div className="h-3.5 animate-pulse rounded-full bg-[#eef2f5]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : !tenantReady ? (
              <StateRow
                title="Client context required"
                message="Select a client first before profiling products."
              />
            ) : profiles.length === 0 ? (
              <StateRow
                title="No profiles found"
                message="No product profiles match the current scope. Try adjusting filters or sync products from the selected store."
              />
            ) : (
              profiles.map((profile) => (
                <tr key={profile.id} className="group transition hover:bg-[#fbfcfc]">
                  <td className="px-4 py-3 text-sm text-primary">
                    <div className="max-w-[280px]">
                      <p className="truncate font-semibold">{profile.name}</p>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    {profile.variationDisplayId ? (
                      <span className="font-semibold tabular-nums text-[#1d4b61]">
                        {profile.variationDisplayId}
                      </span>
                    ) : !profile.isStockable ? (
                      <span className="font-medium text-rose-700">Missing variation ID</span>
                    ) : (
                      <span className="italic text-[#8193a0]">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    {profile.productCustomId ? (
                      <span className="font-semibold tabular-nums text-[#1d4b61]">
                        {profile.productCustomId}
                      </span>
                    ) : (
                      <span className="italic text-[#8193a0]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-primary">
                    <span className="block max-w-[180px] truncate">{profile.store.name}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    {profile.isStockable && profile.status ? (
                      <span
                        className={`pill ${getProductProfileStatusClasses(profile.status)}`}
                      >
                        {formatProductProfileStatus(profile.status)}
                      </span>
                    ) : (
                      <span className="pill border border-rose-200 bg-rose-50 text-rose-700">
                        Not stockable
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm">
                    {profile.isSerialized === null ? (
                      <span className="text-[11px] font-medium text-[#8aa0ae]">N/A</span>
                    ) : (
                      <span
                        className={`pill ${
                          profile.isSerialized
                            ? 'border border-primary bg-primary text-white'
                            : 'border border-[#dce4ea] bg-[#fbfcfc] text-[#4d6677]'
                        }`}
                      >
                        {profile.isSerialized ? 'Yes' : 'No'}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {profile.isStockable && canEditProfile ? (
                      <button
                        type="button"
                        onClick={() => onEditProfile(profile)}
                        className="btn btn-sm btn-outline btn-icon"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                    ) : !profile.isStockable ? (
                      <span className="text-[11px] font-medium text-rose-700">
                        {profile.stockabilityReason ?? 'Requires variation ID sync'}
                      </span>
                    ) : (
                      <span className="text-[11px] font-medium text-[#8aa0ae]">Read only</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableHeader({
  children,
  className = '',
}: {
  children: string;
  className?: string;
}) {
  return (
    <th
      className={`whitespace-nowrap px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.22em] text-muted bg-slate-50 ${className}`}
    >
      {children}
    </th>
  );
}

function StateRow({ title, message }: { title: string; message: string }) {
  return (
    <tr>
      <td colSpan={7} className="px-4 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-[#dce4ea] bg-[#fbfcfc] text-[#5e8196]">
            <PackageSearch className="h-5 w-5" />
          </span>
          <p className="text-sm font-semibold text-primary">{title}</p>
          <p className="text-[12.5px] text-[#7b8e9c]">{message}</p>
        </div>
      </td>
    </tr>
  );
}

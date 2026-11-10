'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpDown,
  Box,
  Boxes,
  HeartHandshake,
  PackageSearch, Puzzle, ScanLine, SlidersHorizontal, Warehouse } from 'lucide-react';
import { WmsCompactPanel } from '../_components/wms-compact-panel';
import { WmsReadinessCard } from '../_components/wms-readiness-card';
import { fetchWmsBootstrap, type WmsBootstrapResponse } from '@/lib/wms-service';

const readinessCards = [
  { key: 'posStores', label: 'Stores', icon: Warehouse, tone: 'teal' as const },
  { key: 'posWarehouses', label: 'Warehouses', icon: Boxes, tone: 'yellow' as const },
  { key: 'posProducts', label: 'Products', icon: PackageSearch, tone: 'lavender' as const },
] as const satisfies ReadonlyArray<{
  key: keyof WmsBootstrapResponse['readiness'];
  label: string;
  icon: typeof Warehouse;
  tone: 'teal' | 'yellow' | 'lavender';
}>;

const setupChips = ['Access', 'Warehouses', 'Products', 'Receiving', 'Inventory'];
const planModules = ['Clients', 'Purchasing', 'Warehouses', 'Products', 'Receiving', 'Inventory'];

export default function WmsHomePage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['wms-core-bootstrap'],
    queryFn: fetchWmsBootstrap,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          className="btn btn-md btn-outline btn-icon"
        >
          <ArrowUpDown className="h-4 w-4" />
          Sort by
        </button>
        <button
          type="button"
          className="btn btn-md btn-outline btn-icon"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Filter
        </button>
      </div>

      {error ? (
        <div className="rounded-[28px] border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">
          Unable to load dashboard.
        </div>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(286px,0.72fr)]">
        <WmsCompactPanel title="Foundation" icon={<Warehouse className='panel-icon' />}>
          <div className="grid gap-3.5 md:grid-cols-3">
            {readinessCards.map((card) => (
              <WmsReadinessCard
                key={card.key}
                icon={card.icon}
                label={card.label}
                tone={card.tone}
                value={isLoading ? 0 : data?.readiness?.[card.key] ?? 0}
              />
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {setupChips.map((chip) => (
              <span
                key={chip}
                className="pill pill-neutral"
              >
                {chip}
              </span>
            ))}
          </div>
        </WmsCompactPanel>

        <div className="space-y-4">
          <WmsCompactPanel title='Inventory' icon={<Box className='panel-icon' />} meta="Serialized" className="bg-[linear-gradient(135deg,#eef5df_0%,#e6eed0_44%,#f7edc1_100%)]">

            <div className="mt-6 flex flex-wrap gap-2">
              <span className="pill pill-primary">Unit</span>
              <span className="pill pill-white">
                Movement
              </span>
              <span className="pill pill-white">
                Receiving
              </span>
            </div>
          </WmsCompactPanel>

          <WmsCompactPanel title="Session" icon={< HeartHandshake className='panel-icon' />}>
            <div className="flex items-center justify-between rounded-xl border border-[#dce4ea] bg-[#fbfcfc] px-4 py-3.5">
              <div>
                <p className="text-[13px] font-semibold text-primary">
                  {data?.tenantReady ? 'Client context ready' : 'Client context pending'}
                </p>
                <p className="mt-1 text-[12px] text-[#617685]">{data?.context?.userRole ?? 'Unknown role'}</p>
              </div>
              <div className="rounded-full bg-primary p-2.5 text-primary-foreground">
                <ScanLine className="h-4 w-4" />
              </div>
            </div>
          </WmsCompactPanel>

          <WmsCompactPanel title="Modules" icon={<Puzzle className='panel-icon' />}>
            <div className="flex flex-wrap gap-2">
              {planModules.map((label) => (
                <span
                  key={label}
                  className="pill pill-neutral"
                >
                  {label}
                </span>
              ))}
              {isLoading ? (
                <span className="pill pill-white">
                  Loading
                </span>
              ) : null}
            </div>
          </WmsCompactPanel>
        </div>
      </section>
    </div>
  );
}

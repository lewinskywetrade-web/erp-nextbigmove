'use client';

import { useState } from 'react';
import { ArrowLeftRight, Boxes } from 'lucide-react';
import { DailyInventoryMovementsScreen } from './_components/daily-inventory-movements-screen';
import { MonthEndStockReportScreen } from './_components/month-end-stock-report-screen';

export default function WmsReportsPage() {
  const [activeTab, setActiveTab] = useState<'daily-movements' | 'month-end'>('daily-movements');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-[#dce4ea] bg-white px-4 py-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#5e7483]">
            WMS Reports & Auto-Email
          </p>
          <h1 className="mt-0.5 text-lg font-bold text-primary">
            {activeTab === 'daily-movements'
              ? 'Daily Inventory Ins & Outs (Automated Client Email)'
              : 'Month-End Stock Snapshot'}
          </h1>
        </div>

        <div className="flex items-center rounded-2xl border border-[#d7e0e7] bg-[#fbfcfc] p-1 gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('daily-movements')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
              activeTab === 'daily-movements'
                ? 'bg-primary text-white shadow-sm'
                : 'text-[#536977] hover:text-primary'
            }`}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            Daily Ins & Outs (Auto-Email)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('month-end')}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
              activeTab === 'month-end'
                ? 'bg-primary text-white shadow-sm'
                : 'text-[#536977] hover:text-primary'
            }`}
          >
            <Boxes className="h-3.5 w-3.5" />
            Month-End Stock
          </button>
        </div>
      </div>

      {activeTab === 'daily-movements' ? (
        <DailyInventoryMovementsScreen />
      ) : (
        <MonthEndStockReportScreen />
      )}
    </div>
  );
}

'use client';

import { type ReactNode } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { FloatingTooltip } from '@/components/ui/floating-tooltip';
import { ArrowDown, ArrowUp, Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatMetricValue } from '../_utils/metrics';

export type AnalyticsMetricFormat = 'currency' | 'number' | 'percent';

type MetricCount = {
  value: number;
  precision?: number;
  delta?: number | null;
  percentage?: number | null;
  label?: string;
};

type AnalyticsMetricCardProps = {
  label: string;
  value: number;
  format: AnalyticsMetricFormat;
  precision?: number;
  delta: number | null;
  deltaDisplay?: 'signed' | 'trend';
  showDelta?: boolean;
  count?: MetricCount;
  tooltip?: ReactNode;
  tooltipMode?: 'hover' | 'popover';
  className?: string;
  /** Keep the label; spin the value while the fetch is in flight. */
  loading?: boolean;
};

const formatCountValue = (value: number, precision = 0) =>
  Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: precision }).format(value) : '—';

const formatDeltaLabel = (value: number | null | undefined) => {
  if (value === null || value === undefined) return '--';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
};

const formatPercentageLabel = (value: number | null | undefined) => {
  if (value === null || value === undefined) return '--';
  return `${value.toFixed(1)}%`;
};

const getDeltaColor = (value: number | null | undefined) => {
  if (value === null || value === undefined) return 'text-slate-400';
  return value >= 0 ? 'text-emerald-600' : 'text-rose-500';
};

function DeltaLabel({
  value,
  display,
}: {
  value: number | null | undefined;
  display: 'signed' | 'trend';
}) {
  if (display === 'signed' || value === null || value === undefined) {
    return <span className={`text-xs ${getDeltaColor(value)}`}>{formatDeltaLabel(value)}</span>;
  }

  const TrendIcon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : null;

  return (
    <span className={`inline-flex items-center gap-0.5 text-xs ${getDeltaColor(value)}`}>
      {TrendIcon ? <TrendIcon className="h-3 w-3" aria-hidden="true" /> : null}
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

function TooltipIcon({ label, content, mode }: { label: string; content: ReactNode; mode: 'hover' | 'popover' }) {
  if (mode === 'popover') {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex cursor-help"
            aria-label={`${label} formula`}
          >
            <Info className="h-4 w-4 text-slate-400 hover:text-emerald-600 focus:text-emerald-600" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" side="bottom" sideOffset={8} className="w-80">
          {content}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <FloatingTooltip
      ariaLabel={`${label} formula`}
      content={content}
      triggerClassName="group inline-flex cursor-help rounded-full outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
      contentClassName="w-80 text-xs leading-relaxed text-foreground"
    >
      <Info className="h-4 w-4 text-slate-400 group-hover:text-emerald-600 group-focus-within:text-emerald-600" />
    </FloatingTooltip>
  );
}

export function AnalyticsMetricCard({
  label,
  value,
  format,
  precision,
  delta,
  deltaDisplay = 'signed',
  showDelta = true,
  count,
  tooltip,
  tooltipMode = 'hover',
  className,
  loading,
}: AnalyticsMetricCardProps) {
  const valuePrecision =
    precision === undefined ? (format === 'percent' ? 1 : 2) : precision;

  return (
    <div
      className={`card ${className ?? ''}`.trim()}
    >
      <div className="text-xs text-foreground/60 flex items-center gap-1">
        {label}
        {tooltip ? <TooltipIcon label={label} content={tooltip} mode={tooltipMode} /> : null}
      </div>

      <div className="mt-1 flex items-center justify-between">
        <p className="text-lg font-semibold text-foreground">
          {loading ? <Spinner className="h-4 w-4 text-foreground/50" /> : formatMetricValue(value, format, valuePrecision)}
        </p>
        {showDelta && !loading ? (
          <DeltaLabel value={delta} display={deltaDisplay} />
        ) : null}
      </div>

      {count ? (
        <div className="mt-1 flex items-center justify-between">
          <span className="text-sm text-slate-700">
            <span className="font-normal text-foreground/80">{count.label ?? 'ord'}:</span>{' '}
            {loading ? <Spinner className="h-3 w-3 text-foreground/40" /> : <span className="font-semibold text-foreground">{formatCountValue(count.value, count.precision)}</span>}
          </span>
          {count.percentage !== undefined ? (
            <span className="text-xs font-medium text-muted">
              {formatPercentageLabel(count.percentage)}
            </span>
          ) : (
            <DeltaLabel value={count.delta} display={deltaDisplay} />
          )}
        </div>
      ) : null}
    </div>
  );
}

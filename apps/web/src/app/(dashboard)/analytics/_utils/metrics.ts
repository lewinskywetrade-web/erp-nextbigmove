export type MetricFormat = 'currency' | 'number' | 'percent';

export function formatMetricValue(
  value: number,
  format: MetricFormat,
  decimals: number = 2,
) {
  if (!Number.isFinite(value)) return '—';

  if (format === 'currency') {
    return new Intl.NumberFormat('en-PH', {
      style: 'currency',
      currency: 'PHP',
      maximumFractionDigits: 2,
    }).format(value);
  }

  const formatted = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: decimals,
  }).format(value);

  return format === 'percent' ? `${formatted}%` : formatted;
}

export function formatDeltaPercent(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function toTitleCase(text: string) {
  return text
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function formatPhpCurrency(value: number) {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    maximumFractionDigits: 2,
  }).format(value);
}

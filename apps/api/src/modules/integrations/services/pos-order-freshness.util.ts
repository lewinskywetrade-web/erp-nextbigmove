/** A fixed-width UTC string preserves Pancake's microseconds (Date truncates them). */
export function normalizePancakeSourceVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const base = `${match[1]}T${match[2]}`;
  const date = new Date(`${base}.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== base) return null;
  const zone = match[4];
  if (zone && zone !== 'Z') {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    date.setTime(date.getTime() - (zone[0] === '+' ? 1 : -1) * (hours * 60 + minutes) * 60_000);
  }
  const utc = date.toISOString().slice(0, 19);
  if (!/^\d{4}-/.test(utc)) return null;
  return `${utc}.${(match[3] ?? '').padEnd(9, '0')}Z`;
}

export const PANCAKE_SOURCE_VERSION_KEY = '_pancakeUpdatedAt';

export function latestPancakeStatusVersion(history: unknown): string | null {
  if (!Array.isArray(history)) return null;
  let latest: string | null = null;
  for (const entry of history) {
    const version = normalizePancakeSourceVersion(entry?.updated_at);
    if (version && (!latest || version > latest)) latest = version;
  }
  return latest;
}

export function savedPancakeSourceVersion(snapshot: unknown, history: unknown): string | null {
  const version = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? normalizePancakeSourceVersion((snapshot as Record<string, unknown>)[PANCAKE_SOURCE_VERSION_KEY])
    : null;
  // History is a conservative floor for rows saved before watermarks existed.
  const historyVersion = latestPancakeStatusVersion(history);
  return version && (!historyVersion || version > historyVersion) ? version : historyVersion;
}

export function incomingPancakeSourceVersion(order: any): { version: string | null; invalid: boolean } {
  const provided = order?.updated_at !== undefined && order?.updated_at !== null;
  // History versions only bound a stored legacy row; they cannot version a
  // new snapshot (an address/item edit may retain the same status history).
  const version = provided ? normalizePancakeSourceVersion(order.updated_at) : null;
  return { version, invalid: provided && !version };
}

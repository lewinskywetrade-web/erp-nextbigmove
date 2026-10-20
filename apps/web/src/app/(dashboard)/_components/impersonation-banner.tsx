'use client';

import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { getImpersonation, stopImpersonation, syncImpersonationWithServer, type ImpersonationBanner as Banner } from '@/lib/impersonation';

/**
 * Always-visible reminder that this session is not your own.
 *
 * API-enforced read-only preview: keep the identity and return action visible
 * even while the report underneath is scrolled.
 */
export function ImpersonationBanner() {
  const [banner, setBanner] = useState<Banner | null>(null);
  const [isExiting, setIsExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The cached flag renders instantly; the server then confirms or overrules
  // it. Without the check, a flag left by an expired session shows a banner
  // whose Exit can never succeed — the bug this guards against.
  useEffect(() => {
    setBanner(getImpersonation());
    let cancelled = false;
    syncImpersonationWithServer()
      .then((verified) => { if (!cancelled) setBanner(verified); })
      .catch(() => { /* leave the cached state; a failed check is not proof either way */ });
    return () => { cancelled = true; };
  }, []);

  if (!banner) return null;

  return (
    <div role="status" className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-3 bg-warning px-4 py-2 text-center text-sm font-medium text-white">
      <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        Read-only preview: <strong>{banner.name}</strong>
        {banner.email ? <span className="font-normal opacity-80"> · {banner.email}</span> : null}
      </span>
      <span className="text-xs font-normal">Record changes are blocked · Up to 15 minutes</span>
      <button
        type="button"
        disabled={isExiting}
        onClick={() => {
          setIsExiting(true);
          setError(null);
          void stopImpersonation().catch((exitError) => {
            setIsExiting(false);
            setError(exitError?.response?.data?.message ?? 'Could not exit. Try again.');
          });
        }}
        className="rounded-md bg-surface px-2.5 py-1 text-xs font-semibold text-foreground transition hover:opacity-90 disabled:opacity-60"
      >
        {isExiting ? 'Exiting…' : 'Exit preview'}
      </button>
      {error ? <span className="text-xs font-normal">{error}</span> : null}
    </div>
  );
}

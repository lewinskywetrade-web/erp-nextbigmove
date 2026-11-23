'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Eye } from 'lucide-react';
import { exchangeClientPreviewHandoff } from '@/lib/impersonation';
import { AlertBanner, LoadingCard } from '@/components/ui/feedback';

export default function PreviewHandoffPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const rawHash = typeof window !== 'undefined' ? window.location.hash : '';
    const params = new URLSearchParams(rawHash.startsWith('#') ? rawHash.slice(1) : rawHash);
    const code = params.get('code')?.trim() || '';

    if (typeof window !== 'undefined' && window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    if (!code) {
      setError('Missing client preview handoff code. Launch View as in ERP again from Admin.');
      return;
    }

    let cancelled = false;
    void exchangeClientPreviewHandoff(code)
      .then((destination) => {
        if (!cancelled) {
          window.location.href = destination;
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message
          || (err as { message?: string })?.message
          || 'Unable to open read-only client preview.';
        setError(msg);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-surface p-6 shadow-lg">
        <div className="flex items-center gap-2 text-primary">
          <Eye className="h-5 w-5" />
          <h1 className="text-lg font-bold text-foreground">Opening Client Portal Preview</h1>
        </div>
        {error ? (
          <>
            <AlertBanner tone="error" message={error} />
            <div className="flex items-center justify-end gap-3 text-xs font-semibold">
              <Link href="/login" className="text-primary hover:underline">
                Go to Client Portal Login
              </Link>
            </div>
          </>
        ) : (
          <LoadingCard label="Verifying read-only View As session..." />
        )}
      </div>
    </div>
  );
}

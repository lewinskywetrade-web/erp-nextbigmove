'use client';

import apiClient from '@/lib/api-client';
import { applySession } from '@/lib/session';

/**
 * Exported so every session boundary (login, logout, 401 expiry) can clear it.
 * The flag describes ONE session; if it outlives that session it lies.
 */
export const IMPERSONATION_KEY = 'impersonating_user';

export type ImpersonationBanner = {
  name: string;
  email: string;
};

/**
 * Who is currently being viewed, if anyone.
 *
 * Kept alongside the token rather than derived from it: the banner has to
 * render before any request completes, and decoding a JWT client-side to drive
 * UI invites treating its claims as trusted. The server is still the authority
 * — this only decides whether to show the banner.
 */
export function getImpersonation(): ImpersonationBanner | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(IMPERSONATION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.name === 'string' && typeof parsed.email === 'string'
      ? { name: parsed.name, email: parsed.email }
      : null;
  } catch {
    return null;
  }
}

export function clearImpersonation(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(IMPERSONATION_KEY); } catch { /* storage unavailable */ }
}

/**
 * Reconcile the local flag with what the token actually says.
 *
 * The flag renders the banner instantly, but it is a cache, not the truth: a
 * session can expire and be replaced by a plain login — even under a different
 * partner — while the flag sits in localStorage. The server reads
 * `impersonatedBy` straight off the JWT, so it is the authority. Returns the
 * banner to show, or null when this session is not impersonating.
 */
export async function syncImpersonationWithServer(): Promise<ImpersonationBanner | null> {
  const { data } = await apiClient.get('/auth/me');
  const me = data?.user;
  if (!me?.impersonatedBy) {
    clearImpersonation();
    return null;
  }
  // Server says impersonating; rebuild the banner from the token's user so a
  // missing or stale flag (cleared in another tab, say) still labels correctly.
  const banner: ImpersonationBanner = {
    name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.email || 'another user',
    email: me.email ?? '',
  };
  try { window.localStorage.setItem(IMPERSONATION_KEY, JSON.stringify(banner)); } catch { /* ignore */ }
  return banner;
}

/** Swap the session to the target user and reload into their view. */
export async function startImpersonation(userId: string): Promise<void> {
  const { data } = await apiClient.post(`/auth/impersonate/${userId}`);
  if (data?.impersonationReadOnly !== true || !data?.impersonatedBy) {
    throw new Error('Read-only preview is not available yet. Reload and try again.');
  }
  applySession(data);
  window.localStorage.setItem(IMPERSONATION_KEY, JSON.stringify({
    name: [data.user?.firstName, data.user?.lastName].filter(Boolean).join(' ') || data.user?.email,
    email: data.user?.email ?? '',
  }));
  window.location.href = '/dashboard';
}

/** Hand the session back to the admin who started it. */
export async function stopImpersonation(): Promise<void> {
  try {
    const { data } = await apiClient.post('/auth/impersonate/stop');
    applySession(data);
  } catch (error: any) {
    // 400 here means the server looked at the token and found no impersonation
    // in it — the flag is stale, not the session. Clearing is the honest move;
    // keeping the banner would leave an Exit button that can never succeed.
    // Network and 5xx failures rethrow: the token may genuinely still be the
    // impersonated one, and hiding the banner then would strand the admin.
    if (error?.response?.status === 400) {
      clearImpersonation();
      window.location.reload();
      return;
    }
    throw error;
  }
  clearImpersonation();
  window.location.href = '/settings/users';
}

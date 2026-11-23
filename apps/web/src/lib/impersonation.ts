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

/**
 * Swap the session into a target client tenant & user in read-only View As
 * mode (designated owner account only, enforced server-side).
 */
export async function startClientPortalPreview(params: {
  tenantId: string;
  userId: string;
  destination?: string;
}): Promise<void> {
  const { data } = await apiClient.post('/auth/impersonate/client', {
    tenantId: params.tenantId,
    userId: params.userId,
  });
  if (data?.impersonationReadOnly !== true || !data?.impersonatedBy) {
    throw new Error('Read-only client preview is not available. Reload and try again.');
  }
  applySession(data);
  window.localStorage.setItem(IMPERSONATION_KEY, JSON.stringify({
    name: [data.user?.firstName, data.user?.lastName].filter(Boolean).join(' ') || data.user?.email,
    email: data.user?.email ?? '',
  }));
  window.location.href = params.destination || '/daily-inventory';
}

/**
 * Exchange a single-use preview handoff code launched from admin console for a
 * read-only Client Portal View As session.
 */
export async function exchangeClientPreviewHandoff(code: string): Promise<string> {
  const { data } = await apiClient.post('/auth/impersonate/client/exchange', { code });
  if (data?.impersonationReadOnly !== true || !data?.impersonatedBy) {
    throw new Error('Read-only client preview is not available. Please retry from Admin.');
  }
  applySession(data);
  window.localStorage.setItem(IMPERSONATION_KEY, JSON.stringify({
    name: [data.user?.firstName, data.user?.lastName].filter(Boolean).join(' ') || data.user?.email,
    email: data.user?.email ?? '',
  }));
  const dest =
    data?.destination === '/daily-inventory'
    || data?.destination === '/reports'
    || data?.destination === '/dashboard'
      ? data.destination
      : '/dashboard';
  return dest;
}

/** Hand the session back to the admin who started it. */
export async function stopImpersonation(): Promise<void> {
  let returnedTenantId: string | null = null;
  try {
    const { data } = await apiClient.post('/auth/impersonate/stop');
    returnedTenantId = data?.tenant?.id ?? null;
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
  window.location.href = returnedTenantId ? '/settings/users' : '/dashboard';
}

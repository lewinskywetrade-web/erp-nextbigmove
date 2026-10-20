'use client';

/** A tenant this identity may work in, as returned by the API. */
export type Membership = { tenantId: string; name: string; slug: string | null; status: string };

// A document must not silently start sending requests as an identity installed
// by another tab while its React tree and query cache still show the old one.
let pageAccessToken: string | null | undefined =
  typeof window === 'undefined' ? undefined : window.localStorage.getItem('access_token');

export function getPageSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  const current = window.localStorage.getItem('access_token');
  if (pageAccessToken === undefined) pageAccessToken = current;
  if (pageAccessToken !== current) {
    window.location.reload();
    throw new Error('Your session changed in another ERP tab. Reloading this view.');
  }
  return current;
}

export function isCurrentSessionAuthorization(authorization: unknown): boolean {
  if (typeof window === 'undefined') return false;
  const current = window.localStorage.getItem('access_token');
  return Boolean(current) && authorization === `Bearer ${current}`;
}

export function watchSessionChanges(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handleStorage = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if ((event.key === 'access_token' || event.key === null)
      && window.localStorage.getItem('access_token') !== pageAccessToken) {
      onChange();
      window.location.reload();
    }
  };
  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
}

/**
 * Install an auth response as the browser session. Used by login, tenant
 * switching, and impersonation so all three agree on what "signed in" means.
 * Team selection belongs to the previous tenant/identity and is always cleared.
 */
export function applySession(data: any): void {
  if (typeof window === 'undefined') return;
  const ls = window.localStorage;
  if (data?.refreshToken) ls.setItem('refresh_token', data.refreshToken);
  else ls.removeItem('refresh_token');
  if (data?.user) ls.setItem('user', JSON.stringify(data.user));
  else ls.removeItem('user');
  if (data?.tenant) {
    ls.setItem('tenant', JSON.stringify(data.tenant));
    if (data.tenant.id) ls.setItem('current_tenant_id', data.tenant.id);
    else ls.removeItem('current_tenant_id');
  } else {
    ls.removeItem('tenant');
    ls.removeItem('current_tenant_id');
  }
  ls.setItem('memberships', JSON.stringify(Array.isArray(data?.memberships) ? data.memberships : []));
  if (data?.impersonatedBy || data?.user?.impersonatedBy) {
    ls.setItem('impersonating_user', JSON.stringify({
      name: [data.user?.firstName, data.user?.lastName].filter(Boolean).join(' ') || data.user?.email || 'another user',
      email: data.user?.email || '',
    }));
  } else {
    ls.removeItem('impersonating_user');
  }
  ls.removeItem('current_team_id');
  ls.removeItem('current_team_ids');
  // Publish the token last: other tabs reload only after identity metadata is
  // complete. Callers hard-navigate so the initiating tab also drops its cache.
  pageAccessToken = data?.accessToken || null;
  if (pageAccessToken) ls.setItem('access_token', pageAccessToken);
  else ls.removeItem('access_token');
}

export function getMemberships(): Membership[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem('memberships');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getCurrentTenantId(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem('current_tenant_id'); } catch { return null; }
}

export const CLIENT_PORTAL_PREVIEW_ALLOWED_EMAIL = 'lewinsky.wetrade@gmail.com';

type VerifiedIdentity = {
  id?: string;
  userId?: string;
  email?: string | null;
  role?: string;
  impersonatedBy?: string | null;
};

/** Presentation capability only. The API checks every preview request again. */
export function viewAsCapabilities(me: VerifiedIdentity | null, permissions: unknown) {
  const keys = Array.isArray(permissions) ? permissions : [];
  const currentUserId = me?.userId || me?.id || null;
  const isSuperAdmin = Boolean(currentUserId) && me?.role === 'SUPER_ADMIN';
  return {
    currentUserId,
    isSuperAdmin,
    canManage: Boolean(currentUserId) && (isSuperAdmin || keys.includes('user.manage')),
    canImpersonate: Boolean(currentUserId) && !me?.impersonatedBy
      && (isSuperAdmin || keys.includes('user.impersonate')),
  };
}

/**
 * Presentation check for cross-client live portal View As.
 * Always requires both the server-verified flag and the designated owner email.
 */
export function canPreviewAllClients(
  me: VerifiedIdentity | null,
  serverCanPreviewClients = false,
): boolean {
  const currentUserId = me?.userId || me?.id || null;
  return Boolean(
    serverCanPreviewClients
    && currentUserId
    && !me?.impersonatedBy
    && me?.role === 'SUPER_ADMIN'
    && (me?.email ?? '').trim().toLowerCase() === CLIENT_PORTAL_PREVIEW_ALLOWED_EMAIL,
  );
}

export function viewAsDisabledReason(
  target: { id: string; status: string; role: string },
  currentUserId: string | null,
  actorIsSuperAdmin = false,
): string | null {
  if (!currentUserId) return 'Your session is still being verified.';
  if (target.id === currentUserId) return 'You are already viewing your own account.';
  if (target.status !== 'ACTIVE') return 'Only active users can be previewed.';
  if (target.role === 'SUPER_ADMIN' && !actorIsSuperAdmin) return 'Only a Super Admin can preview this account.';
  return null;
}

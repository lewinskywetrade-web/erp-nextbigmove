type VerifiedIdentity = {
  id?: string;
  userId?: string;
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

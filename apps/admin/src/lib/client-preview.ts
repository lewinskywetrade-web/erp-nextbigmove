import apiClient from '@/lib/api-client';

export const CLIENT_PORTAL_PREVIEW_ALLOWED_EMAIL = 'lewinsky.wetrade@gmail.com';

export type ClientPreviewDestination = '/dashboard' | '/daily-inventory' | '/reports';

export function canPreviewAllClients(
  me: {
    id?: string;
    userId?: string;
    email?: string | null;
    role?: string;
    impersonatedBy?: string | null;
  } | null,
  serverCanPreviewClients = false,
): boolean {
  const uid = me?.userId || me?.id || null;
  return Boolean(
    serverCanPreviewClients
    && uid
    && !me?.impersonatedBy
    && me?.role === 'SUPER_ADMIN'
    && (me?.email ?? '').trim().toLowerCase() === CLIENT_PORTAL_PREVIEW_ALLOWED_EMAIL,
  );
}

export function resolveErpPortalBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_ERP_WEB_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  if (typeof window === 'undefined') {
    return 'http://localhost:3000';
  }
  const { protocol, hostname, port, origin } = window.location;
  if (hostname.startsWith('admin.')) {
    return `${protocol}//erp.${hostname.slice('admin.'.length)}${port ? `:${port}` : ''}`;
  }
  if ((hostname === 'localhost' || hostname === '127.0.0.1') && port === '3002') {
    return `${protocol}//${hostname}:3000`;
  }
  return origin;
}

export async function launchClientPortalPreviewFromAdmin(params: {
  tenantId: string;
  userId: string;
  destination?: ClientPreviewDestination;
}): Promise<void> {
  // Open target window synchronously on click so browsers do not block the async redirect.
  const popup = typeof window !== 'undefined' ? window.open('', '_blank') : null;
  if (popup) {
    popup.opener = null;
  }

  try {
    const { data } = await apiClient.post<{ code: string }>('/auth/impersonate/client/handoff', {
      tenantId: params.tenantId,
      userId: params.userId,
      destination: params.destination ?? '/dashboard',
    });

    if (!data?.code) {
      throw new Error('Failed to obtain client preview handoff code.');
    }

    const targetUrl = `${resolveErpPortalBaseUrl()}/preview-handoff#code=${encodeURIComponent(data.code)}`;
    if (popup) {
      popup.location.replace(targetUrl);
    } else if (typeof window !== 'undefined') {
      window.location.href = targetUrl;
    }
  } catch (error) {
    if (popup && !popup.closed) {
      popup.close();
    }
    throw error;
  }
}

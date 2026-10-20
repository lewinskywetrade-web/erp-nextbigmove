import axios from 'axios';
import { getPageSessionToken, isCurrentSessionAuthorization } from '@/lib/session';

const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor - Add auth token and tenant ID
apiClient.interceptors.request.use(
  (config) => {
    if (typeof window !== 'undefined') {
      const token = getPageSessionToken();
      const tenantId = localStorage.getItem('current_tenant_id');
      const teamIdsRaw = localStorage.getItem('current_team_ids');
      const singleTeam = localStorage.getItem('current_team_id');
      let activeTeamIds: string[] = [];

      if (teamIdsRaw) {
        try {
          const parsed = JSON.parse(teamIdsRaw);
          if (Array.isArray(parsed)) {
            activeTeamIds = parsed.filter((t) => typeof t === 'string' && t.length > 0);
          }
        } catch {
          // ignore parse errors
        }
      } else if (singleTeam) {
        activeTeamIds = singleTeam === 'ALL_TEAMS' ? [] : [singleTeam];
      }

      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }

      if (tenantId) {
        config.headers['X-Tenant-ID'] = tenantId;
      }

      if (activeTeamIds.length > 0) {
        config.headers['X-Team-ID'] = activeTeamIds.join(',');
      }
    }

    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor - Handle auth errors
apiClient.interceptors.response.use(
  (response) => {
    const authorization = response.config.headers?.Authorization;
    if (authorization && !isCurrentSessionAuthorization(authorization)) {
      return Promise.reject(new Error('The session changed before this response arrived.'));
    }
    return response;
  },
  async (error) => {
    if (error.response?.status === 401) {
      if (typeof window !== 'undefined'
        && isCurrentSessionAuthorization(error.config?.headers?.Authorization)) {
        if (localStorage.getItem('impersonating_user')) {
          window.sessionStorage.setItem('auth_session_notice', 'Your read-only preview ended. Sign in with your own account to continue.');
        }
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        localStorage.removeItem('current_tenant_id');
        localStorage.removeItem('user');
        localStorage.removeItem('tenant');
        localStorage.removeItem('memberships');
        localStorage.removeItem('current_team_id');
        localStorage.removeItem('current_team_ids');
        // An expired impersonated session must not leave its banner behind for
        // whoever logs in next. Literal key: importing the impersonation module
        // here would be circular (it imports this client).
        localStorage.removeItem('impersonating_user');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;

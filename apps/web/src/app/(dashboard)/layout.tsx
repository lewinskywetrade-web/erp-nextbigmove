'use client';

import { ImpersonationBanner } from './_components/impersonation-banner';
import { applySession, getCurrentTenantId, getMemberships, type Membership } from '@/lib/session';
import { switchTenant } from '@/lib/tenant-switch';

import { ReactNode, useEffect, useState, useRef, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Layers,
  StoreIcon,
  Network,
  BarChart3,
  Users,
  ClipboardList,
  Package,
  FileSpreadsheet,
  Menu,
  X,
  Moon,
  Sun,
  Video,
  BookOpen,
  FolderCheck,
  Sparkles,
} from 'lucide-react';
import apiClient from '@/lib/api-client';
import { ToastProvider } from '@/components/ui/toast';
import { filterErpPermissions } from '@/lib/permission-workspace';
import { clearTeamScopeStorage } from './integrations/_utils/team-scope';
import { useRequestNotificationCount } from './requests/_hooks/use-request-notification-count';

interface NavLink {
  href: string;
  label: string;
  description: string;
  icon: ReactNode;
  children?: { href: string; label: string; icon?: ReactNode }[];
}

const iconClasses = 'h-4 w-4';
const MOBILE_DRAWER_TRANSITION_MS = 220;

const baseNavigation: NavLink[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    description: 'Snapshot of your business',
    icon: (
      <svg className={iconClasses} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 9.5 12 4l9 5.5v9.75a.75.75 0 0 1-.75.75H4.75A.75.75 0 0 1 4 19.25V9.5Z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 21V12h6v9" />
      </svg>
    ),
  },
  {
    href: '/analytics',
    label: 'Analytics',
    description: 'Reports & performance',
    icon: (
      <svg className={iconClasses} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h3v8H5zM10.5 8h3v12h-3zM16 4h3v16h-3z" />
      </svg>
    ),
    children: [
      { href: '/analytics/sales', label: 'Business Performance', icon: <StoreIcon className="h-4 w-4" /> },
      { href: '/analytics/team-performance', label: 'Team Performance', icon: <Users className="h-4 w-4" /> },
      { href: '/analytics/sales-performance', label: 'Sales Operations', icon: <BarChart3 className="h-4 w-4" /> },
    ],
  },
  {
    href: '/orders',
    label: 'Orders',
    description: 'Order operations queue',
    icon: <ClipboardList className={iconClasses} />,
    children: [
      { href: '/orders/summary', label: 'Orders Summary', icon: <BarChart3 className="h-4 w-4" /> },
      { href: '/orders/confirmation', label: 'Confirmation of Order', icon: <ClipboardList className="h-4 w-4" /> },
      { href: '/orders/undeliverables', label: 'Undeliverables', icon: <Users className="h-4 w-4" /> },
    ],
  },
  {
    href: '/requests',
    label: 'Stock Requests',
    description: 'Inventory request coordination with WMS',
    icon: <Package className={iconClasses} />,
  },
  {
    href: '/performance',
    label: 'Performance',
    description: 'Ad spend against POS orders',
    icon: <BarChart3 className={iconClasses} />,
  },
  {
    href: '/reports',
    label: 'Reports',
    description: 'Tenant-wide POS exports',
    icon: <FileSpreadsheet className={iconClasses} />,
  },
  {
    href: '/integrations',
    label: 'Integrations',
    description: 'Manage connected apps',
    icon: (
      <svg className={iconClasses} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8 7h8m-4-4v8m-7 3h6m6 0h6m-9 0v6m-3-6v6"
        />
      </svg>
    ),
    children: [
      { href: '/integrations', label: 'Create Integration', icon: <Layers className="h-4 w-4" /> },
      { href: '/integrations/store', label: 'Stores', icon: <StoreIcon className="h-4 w-4" /> },
      { href: '/integrations/meta', label: 'Meta', icon: <Network className="h-4 w-4" /> },
    ],
  },
  {
    href: '/creative-insights',
    label: 'Creative Insights',
    description: 'What to scale, refresh, or let go — and your next batch',
    icon: <Sparkles className={iconClasses} />,
  },
  {
    href: '/assets',
    label: 'Assets',
    description: 'Your creative library, performance, and feedback',
    icon: <FolderCheck className={iconClasses} />,
  },
  {
    href: '/video-registry',
    label: 'Video Registry',
    description: 'Meta ads waiting to be enrolled',
    icon: <Video className={iconClasses} />,
  },
  {
    href: '/knowledge-base',
    label: 'Knowledge Base',
    description: 'What wins and loses, per store',
    icon: <BookOpen className={iconClasses} />,
  },
  {
    href: '/strategy-log',
    label: 'Strategy Log',
    description: 'What you changed, and what it did',
    icon: <ClipboardList className={iconClasses} />,
  },
  {
    href: '/workflows',
    label: 'Workflows',
    description: 'Automated data sync',
    icon: (
      <svg className={iconClasses} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 7h16M4 12h16M4 17h16"
        />
        <circle cx="7" cy="7" r="1.5" fill="currentColor" />
        <circle cx="7" cy="12" r="1.5" fill="currentColor" />
        <circle cx="7" cy="17" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
];

type DashboardLayoutUser = {
  userId?: string;
  id?: string;
  tenantId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  permissions?: string[];
  tenant?: {
    name?: string;
  };
};

type DashboardLayoutTenant = {
  id?: string;
  status?: string;
  name?: string;
};

type DashboardLayoutTeam = {
  id: string;
  name?: string;
  teamCode?: string;
};

type DashboardLayoutRole = {
  key: string;
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<DashboardLayoutUser | null>(null);
  // Tenants this identity belongs to; the switcher only renders for 2+.
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [isTenantMenuOpen, setIsTenantMenuOpen] = useState(false);
  const [isSwitchingTenant, setIsSwitchingTenant] = useState(false);
  useEffect(() => {
    setMemberships(getMemberships());
    setActiveTenantId(getCurrentTenantId());
  }, []);
  const [tenant, setTenant] = useState<DashboardLayoutTenant | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [hasResolvedRoles, setHasResolvedRoles] = useState(false);
  const [teams, setTeams] = useState<DashboardLayoutTeam[]>([]);
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [isLoadingTeams, setIsLoadingTeams] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isMobileNavMounted, setIsMobileNavMounted] = useState(false);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [canViewAllTeams, setCanViewAllTeams] = useState(false);
  const [isTeamMenuOpen, setIsTeamMenuOpen] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [collapsedPopupItem, setCollapsedPopupItem] = useState<string | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ top: number; left: number } | null>(null);
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    return window.localStorage.getItem('theme_mode') === 'dark' ? 'dark' : 'light';
  });
  const navButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const mobileNavCloseTimerRef = useRef<number | null>(null);
  const requestNotifications = useRequestNotificationCount(
    permissions.includes('stock_request.read'),
    tenant?.id ?? user?.tenantId ?? null,
  );

  const openMobileNav = () => {
    if (typeof window === 'undefined') {
      setIsMobileNavMounted(true);
      setIsMobileNavOpen(true);
      return;
    }

    if (mobileNavCloseTimerRef.current !== null) {
      window.clearTimeout(mobileNavCloseTimerRef.current);
      mobileNavCloseTimerRef.current = null;
    }

    setIsMobileNavMounted(true);
    window.requestAnimationFrame(() => {
      setIsMobileNavOpen(true);
    });
  };

  const closeMobileNav = () => {
    if (typeof window === 'undefined') {
      setIsMobileNavOpen(false);
      setIsMobileNavMounted(false);
      return;
    }

    setIsMobileNavOpen(false);

    if (mobileNavCloseTimerRef.current !== null) {
      window.clearTimeout(mobileNavCloseTimerRef.current);
    }

    mobileNavCloseTimerRef.current = window.setTimeout(() => {
      setIsMobileNavMounted(false);
      mobileNavCloseTimerRef.current = null;
    }, MOBILE_DRAWER_TRANSITION_MS);
  };

  const filteredNavigation = useMemo<NavLink[]>(() => {
    const hasMarketing = permissions.includes('analytics.marketing');
    const hasSales = permissions.includes('analytics.sales');
    const hasSalesPerformance = permissions.includes('analytics.sales_performance');
    const hasIntegrations = permissions.includes('integration.read');
    const hasStores = permissions.includes('pos.read');
    const hasMeta = permissions.includes('meta.read');
    const hasWorkflow = permissions.includes('workflow.read');
    const hasStockRequests =
      permissions.includes('stock_request.read')
      || permissions.includes('stock_request.write');
    const hasOrderSummary = permissions.includes('orders.summary.read');
    // Confirmation is an Orders screen, so it follows an orders permission.
    // Keying it on pos.read pulled the whole Orders group in for any role that
    // needed pos.read purely to reach the Stores integration page.
    const hasOrderConfirmation = permissions.includes('orders.summary.read');
    const hasUndeliverables =
      permissions.includes('orders.undeliverables.read')
      || permissions.includes('orders.undeliverables.read_all');
    const hasReports = permissions.includes('reports.pos_orders.read');
    const canReadCreative = permissions.includes('creative_agent.read');
    const canReadCreativeAll = permissions.includes('creative_agent.read_all');
    const canReviewCreative = permissions.includes('creative_agent.review')
      || permissions.includes('creative_agent.performance.manage');
    const isTenantAdmin = roleKeys.includes('TENANT_ADMIN');
    const hasExplicitCreativeRole = roleKeys.some((key) =>
      ['CREATIVE_MAKER', 'CREATIVE_REVIEWER', 'CREATIVE_MANAGER'].includes(key));
    // Backend permissions are authoritative (Tenant Admin no longer holds
    // creative_agent.* by seed); this role check only keeps the nav honest for
    // admins with stale JWT base permissions until they re-login. When roles
    // cannot be resolved we fall back to permissions alone rather than hiding
    // the workspace from every legitimate creative user.
    const canShowCreativeWorkspace = !hasResolvedRoles || !isTenantAdmin || hasExplicitCreativeRole;
    // Video Registry belongs to Creative and Manager; Advertising works
    // through Performance and Assets instead.
    const canShowVideoRegistry = canReadCreative;
    const canShowPerformance = canReadCreativeAll && canReviewCreative;
    // Assets is the creative library for everyone who can read one. It used to
    // hang off read_all alone, on the reasoning that a maker already saw the
    // same shelf in Video Registry — but the registry is the enrolment queue
    // now and lists nothing that is already enrolled. Gating Assets on read_all
    // would leave a maker with no way to reach their own work at all. The API
    // still scopes a maker to creatives they created.
    const canShowAssets = canReadCreative || canReadCreativeAll;

    return baseNavigation.flatMap((link) => {
      if (link.href !== '/analytics') {
        if (link.href === '/workflows') {
          return hasWorkflow ? [link] : [];
        }
        if (link.href === '/requests') {
          return hasStockRequests ? [link] : [];
        }
        if (link.href === '/orders') {
          const children = (link.children || []).filter((child) => {
            if (child.href === '/orders/summary') return hasOrderSummary;
            if (child.href === '/orders/confirmation') return hasOrderConfirmation;
            if (child.href === '/orders/undeliverables') return hasUndeliverables;
            return false;
          });
          if (children.length === 0) return [];
          return [{ ...link, children }];
        }
        if (link.href === '/reports') {
          return hasReports ? [link] : [];
        }
        if (link.href === '/performance') return canShowCreativeWorkspace && canShowPerformance ? [link] : [];
        // The creative's own steering view — same audience as Video Registry,
        // by the owner's explicit call: "para sa creatives, hindi sa advertiser".
        if (link.href === '/creative-insights') return canShowCreativeWorkspace && canReadCreative ? [link] : [];
        if (link.href === '/assets') return canShowCreativeWorkspace && canShowAssets ? [link] : [];
        if (link.href === '/video-registry') return canShowCreativeWorkspace && canShowVideoRegistry ? [link] : [];
        // The library is scoped per store and meant to be studied, so anyone who
        // can read creatives can read it. Curating it needs ai.manage, enforced
        // by the API rather than by hiding the page.
        if (link.href === '/knowledge-base') return canShowCreativeWorkspace && canReadCreative ? [link] : [];
        // Unlike Creative Insights, the log is deliberately open to read_all too:
        // a manager reading what the team changed is the point of keeping it.
        if (link.href === '/strategy-log') {
          return canShowCreativeWorkspace && (canReadCreative || canReadCreativeAll) ? [link] : [];
        }
        if (link.href !== '/integrations') return [link];

        const children = (link.children || []).filter((child) => {
          if (child.href === '/integrations') return hasIntegrations;
          if (child.href === '/integrations/store') return hasStores;
          if (child.href === '/integrations/meta') return hasMeta;
          return false;
        });

        if (children.length === 0) return [];
        return [{ ...link, children }];
      }

      const children = (link.children || []).filter((child) => {
        if (child.href === '/analytics/sales') return hasSales;
        if (child.href === '/analytics/team-performance') return hasSales || hasMarketing;
        if (child.href === '/analytics/sales-performance') return hasSalesPerformance;
        return false;
      });

      if (children.length === 0) return [];
      return [{ ...link, children }];
    });
  }, [hasResolvedRoles, permissions, roleKeys]);

  const getNavigationNotificationCount = (href: string) => {
    if (href === '/requests') {
      return requestNotifications.count;
    }
    return 0;
  };


  useEffect(() => {
    if (typeof window === 'undefined') return;

    const root = window.document.documentElement;
    const isDark = themeMode === 'dark';
    root.classList.toggle('dark', isDark);
    if (isDark) {
      localStorage.setItem('theme_mode', 'dark');
    } else {
      localStorage.removeItem('theme_mode');
    }
  }, [themeMode]);

  useEffect(() => {
    const token = localStorage.getItem('access_token');
    const userStr = localStorage.getItem('user');
    const tenantStr = localStorage.getItem('tenant');
    const storedTenantId = localStorage.getItem('current_tenant_id');
    const storedTeamIds = localStorage.getItem('current_team_ids');

    if (!token) {
      router.push('/login');
      return;
    }

    if (userStr) {
      const parsedUser = JSON.parse(userStr) as DashboardLayoutUser;
      setUser(parsedUser);
      const perms = filterErpPermissions(parsedUser.permissions);
      if (perms.includes('team.read_all') || perms.includes('permission.assign')) {
        setCanViewAllTeams(true);
      }
      setPermissions(perms);
      // Ensure tenant context from user if missing
      if (!storedTenantId && parsedUser?.tenantId) {
        localStorage.setItem('current_tenant_id', parsedUser.tenantId);
      }
    }
    if (tenantStr) {
      const parsedTenant = JSON.parse(tenantStr) as DashboardLayoutTenant;
      setTenant(parsedTenant);
      // Ensure tenant context is set for permission calls
      if (!storedTenantId && parsedTenant?.id) {
        localStorage.setItem('current_tenant_id', parsedTenant.id);
      }
    }
    if (storedTeamIds) {
      try {
        const arr = JSON.parse(storedTeamIds);
        if (Array.isArray(arr)) {
          setSelectedTeamIds(arr.filter((t) => typeof t === 'string' && t.length > 0));
        }
      } catch {
        // ignore
      }
    } else {
      // Default to all teams (empty selection)
      setSelectedTeamIds([]);
      clearTeamScopeStorage();
    }

    setIsLoading(false);
  }, [router]);

  useEffect(() => {
    const normalized = pathname?.split('?')[0] || '/';
    const activeWithChildren = filteredNavigation.find(
      (link) => link.children && link.children.length > 0 && (normalized === link.href || normalized.startsWith(`${link.href}/`))
    );
    if (activeWithChildren) {
      setExpandedItem(activeWithChildren.href);
    }
  }, [pathname, filteredNavigation]);

  useEffect(() => {
    const uid = user?.userId || user?.id;
    if (!user || !uid || !user.tenantId) return;
    const checkAccess = async () => {
      try {
        const [permissionsResult, rolesResult] = await Promise.allSettled([
          apiClient.get('/auth/permissions', { params: { workspace: 'erp' } }),
          apiClient.get('/auth/my-role', { params: { workspace: 'erp' } }),
        ]);

        if (permissionsResult.status === 'fulfilled') {
          const nextPermissions = permissionsResult.value.data.permissions || [];
          const hasAllTeams = nextPermissions.includes('team.read_all') || nextPermissions.includes('permission.assign');
          setCanViewAllTeams(hasAllTeams);
          setPermissions(nextPermissions);
        }

        if (rolesResult.status === 'fulfilled') {
          const roles = Array.isArray(rolesResult.value.data.roles)
            ? rolesResult.value.data.roles as DashboardLayoutRole[]
            : [];
          setRoleKeys(roles.map((role) => role.key));
          setHasResolvedRoles(true);
        } else {
          setRoleKeys([]);
          setHasResolvedRoles(false);
        }
      } catch {
        // Keep current state if fetch fails
        setCanViewAllTeams((prev) => prev);
        setRoleKeys([]);
        setHasResolvedRoles(false);
      }
    };
    void checkAccess();
  }, [user]);

  useEffect(() => {
    if (!user) return;

    setIsLoadingTeams(true);
    const endpoint = canViewAllTeams ? '/teams' : '/teams/my-teams';
    apiClient
      .get(endpoint)
      .then((res) => {
        const list = Array.isArray(res.data) ? (res.data as DashboardLayoutTeam[]) : [];
        setTeams(list);

        if (list.length === 0) {
          setSelectedTeamIds([]);
          clearTeamScopeStorage();
          return;
        }

        const storedIds = localStorage.getItem('current_team_ids');
        let initialIds: string[] = [];
        if (storedIds) {
          try {
            const parsed = JSON.parse(storedIds);
            if (Array.isArray(parsed)) {
              initialIds = parsed.filter((t) => typeof t === 'string' && t.length > 0);
            }
          } catch {
            // ignore
          }
        }
        if (initialIds.length === 0) {
          // Default to "All teams" (empty selection means all)
          initialIds = [];
          clearTeamScopeStorage();
        }
        setSelectedTeamIds(initialIds);
      })
      .catch(() => {
        setTeams([]);
        setSelectedTeamIds([]);
      })
      .finally(() => setIsLoadingTeams(false));
  }, [user, canViewAllTeams]);

  const handleLogout = () => {
    applySession({});
    window.location.href = '/login';
  };

  const handleTeamSelection = (teamId: string) => {
    let next: string[] = [];
    if (teamId === '__all__') {
      next = [];
    } else {
      if (selectedTeamIds.includes(teamId)) {
        next = selectedTeamIds.filter((id) => id !== teamId);
      } else {
        next = [...selectedTeamIds, teamId];
      }
    }
    setSelectedTeamIds(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem('current_team_ids', JSON.stringify(next));
      localStorage.setItem('current_team_id', next[0] || '');
      window.dispatchEvent(new CustomEvent('teamScopeChanged', { detail: next }));
    }
    setIsTeamMenuOpen(false);
    router.refresh();
  };

  const handleOnlySelection = (teamId: string) => {
    const next = teamId === '__all__' ? [] : [teamId];
    setSelectedTeamIds(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem('current_team_ids', JSON.stringify(next));
      localStorage.setItem('current_team_id', next[0] || '');
      window.dispatchEvent(new CustomEvent('teamScopeChanged', { detail: next }));
    }
    setIsTeamMenuOpen(false);
    router.refresh();
  };

  const organizationName =
    tenant?.name || user?.tenant?.name || 'ERP Analytics';
  const isDarkMode = themeMode === 'dark';

  useEffect(() => {
    setIsProfileMenuOpen(false);
    setIsMobileNavOpen(false);
    setIsMobileNavMounted(false);
    setCollapsedPopupItem(null);
  }, [pathname]);

  // Close collapsed popup when sidebar expands
  useEffect(() => {
    if (!isSidebarCollapsed) {
      setCollapsedPopupItem(null);
    }
  }, [isSidebarCollapsed]);

  useEffect(() => {
    if (!isMobileNavMounted) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobileNavMounted]);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && mobileNavCloseTimerRef.current !== null) {
        window.clearTimeout(mobileNavCloseTimerRef.current);
      }
    };
  }, []);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-t-2 border-border"></div>
      </div>
    );
  }

  const sidebarWidth = isSidebarCollapsed ? 'md:w-14 lg:w-14 xl:w-[60px]' : 'md:w-52 lg:w-56 xl:w-60';

  return (
    <ToastProvider>
      <div className="flex h-screen bg-background text-foreground">
        {/* Sidebar */}
        <aside
          className={`relative hidden md:flex ${sidebarWidth} sticky top-0 z-40 h-screen flex-col overflow-visible bg-surface transition-all duration-300 ease-in-out`}
        >
          {/* Collapse toggle pinned to the right edge, vertically centered */}
          <button
            onClick={() => setIsSidebarCollapsed((prev) => !prev)}
            className="absolute -right-3 top-1/2 z-50 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface shadow-sm transition-all duration-300 hover:border-primary/60 hover:text-primary"
            aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg
              className={`h-3.5 w-3.5 transition-transform duration-300 ${isSidebarCollapsed ? 'rotate-180' : ''}`}
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5l-5 5 5 5" />
            </svg>
          </button>
          <div
            className={`px-3 py-4 flex relative z-40 transition-all duration-300 ${
              isSidebarCollapsed ? 'justify-center' : 'flex-col items-center gap-3 text-center'
            }`}
          >
            <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-[1.35rem] bg-primary text-xl font-semibold text-white transition-all duration-300">
              {organizationName
                .split(' ')
                .map((word: string) => word.charAt(0))
                .join('')
                .slice(0, 2)
                .toUpperCase() || 'EA'}
            </div>
            <div className={`min-w-0 transition-all duration-300 ${isSidebarCollapsed ? 'w-0 opacity-0' : 'w-auto opacity-100'}`}>
              <p className="whitespace-nowrap text-base font-semibold text-foreground">{organizationName}</p>
            </div>
          </div>

        {/* Scrollable nav and profile section */}
          <div className="flex-1 flex flex-col overflow-y-auto overflow-x-hidden">
        <nav className="flex-1 px-2 py-4 space-y-2">
          {filteredNavigation.map((link) => {
            const normalizedPath = pathname?.split('?')[0] || '/';
            const isActive =
              normalizedPath === link.href ||
              (link.href !== '/dashboard' && normalizedPath.startsWith(`${link.href}/`));
            const hasChildren = link.children && link.children.length > 0;
            const isExpanded = expandedItem === link.href;
            const hasActiveChild =
              hasChildren && link.children!.some((child) => normalizedPath === child.href || normalizedPath.startsWith(`${child.href}/`));
            const navigationNotificationCount = getNavigationNotificationCount(link.href);

            return (
              <div key={link.href} className="relative">
                <div className="space-y-1">
                  {hasChildren ? (
                    <button
                      type="button"
                      ref={(el) => {
                        if (el) navButtonRefs.current.set(link.href, el);
                      }}
                      onClick={(e) => {
                        if (isSidebarCollapsed) {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setPopupPosition({ top: rect.top, left: rect.right + 8 });
                          setCollapsedPopupItem((prev) => (prev === link.href ? null : link.href));
                        } else {
                          setExpandedItem((prev) => (prev === link.href ? null : link.href));
                        }
                      }}
                      className={`group relative flex w-full items-center rounded-xl px-3 py-3 transition-all duration-300 ${
                        isSidebarCollapsed ? 'justify-center px-0' : ''
                      } ${
                        hasActiveChild || isExpanded || (isSidebarCollapsed && collapsedPopupItem === link.href)
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted hover:bg-foreground/5 dark:text-foreground'
                      }`}
                    >
                      <span
                        className={`flex-shrink-0 transition-colors duration-300 ${
                          hasActiveChild || isExpanded || (isSidebarCollapsed && collapsedPopupItem === link.href)
                            ? 'text-primary'
                            : 'text-muted dark:text-slate-300'
                        } group-hover:text-primary`}
                      >
                        {link.icon}
                      </span>
                      <div
                        className={
                          isSidebarCollapsed
                            ? 'hidden'
                            : 'ml-3 flex-1 text-left transition-all duration-300 overflow-hidden'
                        }
                      >
                        <span className="text-sm-custom font-semibold text-foreground whitespace-nowrap">
                          {link.label}
                        </span>
                      </div>
                      <svg
                        className={`h-4 w-4 text-muted transition-all duration-300 ${
                          isExpanded ? 'rotate-90 text-primary' : ''
                        } ${isSidebarCollapsed ? 'hidden' : 'opacity-100'}`}
                        viewBox="0 0 20 20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7 5l6 5-6 5" />
                      </svg>
                    </button>
                  ) : (
                    <Link
                      href={link.href}
                      className={`group relative flex items-center rounded-xl px-3 py-3 transition-all duration-300 ${
                        isActive ? 'bg-primary/10 text-primary shadow-sm' : 'text-muted hover:bg-foreground/5 dark:text-foreground'
                      } ${isSidebarCollapsed ? 'justify-center px-0' : ''}`}
                    >
                      <span
                        className={`flex-shrink-0 transition-colors duration-300 ${
                          isActive ? 'text-primary' : 'text-muted dark:text-slate-300'
                        } group-hover:text-primary`}
                      >
                        {link.icon}
                      </span>
                      <div
                        className={
                          isSidebarCollapsed
                            ? 'hidden'
                            : 'ml-3 flex-1 transition-all duration-300 overflow-hidden'
                        }
                      >
                        <span className="flex items-center gap-2 text-sm-custom font-semibold text-foreground whitespace-nowrap">
                          <span>{link.label}</span>
                          {navigationNotificationCount > 0 ? (
                            <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white shadow-sm">
                              {navigationNotificationCount > 99 ? '99+' : navigationNotificationCount}
                            </span>
                          ) : null}
                        </span>
                      </div>
                      {navigationNotificationCount > 0 ? (
                        <span
                          className={`absolute flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive mt-0.5 px-1 text-[10px] font-semibold leading-none text-white shadow-sm ${
                            isSidebarCollapsed ? 'right-1 top-1' : 'hidden'
                          }`}
                        >
                          {navigationNotificationCount > 99 ? '99+' : navigationNotificationCount}
                        </span>
                      ) : null}
                    </Link>
                  )}
                  {/* Expanded submenu when sidebar is open */}
                  {hasChildren && !isSidebarCollapsed && isExpanded && (
                    <div className="ml-9 space-y-1">
                      {link.children!.map((child) => {
                        const isRootIntegration = child.href === '/integrations';
                        const childActive = isRootIntegration
                          ? normalizedPath === child.href
                          : normalizedPath === child.href || normalizedPath.startsWith(`${child.href}/`);
                        const childNotificationCount = getNavigationNotificationCount(child.href);
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            className={`flex items-center gap-2 rounded-lg px-2.5 py-2.5 text-sm-custom transition ${
                              childActive
                                ? 'bg-primary/10 text-primary shadow-sm'
                                : 'text-muted hover:bg-foreground/5 dark:text-foreground'
                            }`}
                          >
                            <span
                            className={`flex h-6 w-6 items-center justify-center rounded-full ${
                              childActive ? 'bg-primary/15 text-primary' : 'bg-foreground/5 text-muted dark:text-slate-300'
                            }`}
                          >
                              {child.icon ?? <span className="h-4 w-4" />}
                            </span>
                            <span className="flex items-center gap-2 font-medium">
                              <span>{child.label}</span>
                              {childNotificationCount > 0 ? (
                                <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white shadow-sm">
                                  {childNotificationCount > 99 ? '99+' : childNotificationCount}
                                </span>
                              ) : null}
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </nav>

        <div className={`sticky bottom-0 space-y-3 bg-surface px-3 py-3 transition-all duration-300 ${isSidebarCollapsed ? 'px-2' : ''}`}>
          <div className="relative">
            <button
              onClick={() => isSidebarCollapsed ? handleLogout() : setIsProfileMenuOpen((prev) => !prev)}
              className={`w-full rounded-xl text-left transition-all duration-300 hover:bg-foreground/5 focus:outline-none ${
                isSidebarCollapsed ? 'px-0 py-2 flex justify-center' : 'px-3 py-2'
              }`}
            >
                <div className={`flex items-center transition-all duration-300 ${isSidebarCollapsed ? 'justify-center' : 'gap-3'}`}>
                  <div className="h-9 w-9 flex-shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold">
                    {`${user?.firstName?.[0] || ''}${user?.lastName?.[0] || ''}`.trim() || '??'}
                  </div>
                <div
                  className={
                    isSidebarCollapsed
                      ? 'hidden'
                      : 'flex-1 transition-all duration-300 overflow-hidden'
                  }
                >
                  <div className="text-sm-custom font-semibold text-foreground whitespace-nowrap">
                    {user?.firstName} {user?.lastName}
                  </div>
                </div>
                <svg
                  className={`h-4 w-4 text-muted transition-all duration-300 ${isProfileMenuOpen ? 'rotate-180' : ''} ${isSidebarCollapsed ? 'hidden' : 'opacity-100'}`}
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                >
                  <path d="M6 8l4 4 4-4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </button>

            {isProfileMenuOpen && !isSidebarCollapsed && (
              <div className="absolute inset-x-0 bottom-full z-40 mb-2 rounded-2xl border border-border bg-surface shadow-lg">
                <div className="border-b border-border/60 px-4 py-3">
                  <div className="text-sm-custom font-semibold text-foreground">
                    {user?.firstName} {user?.lastName}
                  </div>
                  <div className="truncate text-xs text-muted dark:text-slate-300">{user?.email}</div>
                </div>
                <Link
                  href="/settings/profile"
                  className="flex items-center gap-3 px-4 py-3 text-sm-custom text-foreground hover:bg-foreground/5"
                  onClick={() => setIsProfileMenuOpen(false)}
                >
                  <svg className="h-4 w-4 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor">
                    <path
                      d="M4.5 10a5.5 5.5 0 0 1 10 0 5.5 5.5 0 0 1-10 0Zm5.5-3v3l2 1"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>Settings</span>
                </Link>
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-3 px-4 py-3 text-sm-custom text-foreground hover:bg-foreground/5"
                >
                  <svg className="h-4 w-4 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor">
                    <path d="M11 5v10M7 9l-2 2 2 2M11 10H4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>Log out</span>
                </button>
              </div>
            )}
          </div>
        </div>
        </div>
      </aside>

      {isMobileNavMounted ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className={`absolute inset-0 bg-slate-950/25 transition-opacity duration-200 ${
              isMobileNavOpen ? 'opacity-100' : 'opacity-0'
            }`}
            onClick={closeMobileNav}
          />
          <aside
            className={`absolute inset-y-0 left-0 flex w-[85vw] max-w-sm flex-col bg-surface shadow-xl transition-transform duration-200 ease-out ${
              isMobileNavOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            <div className="flex items-center justify-end px-4 py-3">
              <button
                type="button"
                onClick={closeMobileNav}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface text-muted"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="relative z-40 flex flex-col items-center gap-3 px-3 py-4 text-center">
              <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-[1.35rem] bg-primary text-xl font-semibold text-white">
                {organizationName
                  .split(' ')
                  .map((word: string) => word.charAt(0))
                  .join('')
                  .slice(0, 2)
                  .toUpperCase() || 'EA'}
              </div>
              <div className="min-w-0">
                <p className="whitespace-nowrap text-base font-semibold text-foreground">{organizationName}</p>
              </div>
            </div>

            <nav className="flex-1 space-y-2 overflow-y-auto px-2 py-4">
              {filteredNavigation.map((link) => {
                const normalizedPath = pathname?.split('?')[0] || '/';
                const isActive =
                  normalizedPath === link.href ||
                  (link.href !== '/dashboard' && normalizedPath.startsWith(`${link.href}/`));
                const hasChildren = Boolean(link.children && link.children.length > 0);
                const isExpanded = expandedItem === link.href;
                const hasActiveChild = Boolean(
                  link.children?.some(
                    (child) => normalizedPath === child.href || normalizedPath.startsWith(`${child.href}/`),
                  ),
                );
                const navigationNotificationCount = getNavigationNotificationCount(link.href);

                return (
                  <div key={`mobile-${link.href}`} className="space-y-1">
                    {hasChildren ? (
                      <button
                        type="button"
                        onClick={() => setExpandedItem((prev) => (prev === link.href ? null : link.href))}
                        className={`group flex w-full items-center rounded-xl px-3 py-3 transition-all duration-300 ${
                          hasActiveChild || isExpanded ? 'bg-primary/10 text-primary' : 'text-muted hover:bg-foreground/5 dark:text-foreground'
                        }`}
                      >
                        <span
                          className={`flex-shrink-0 transition-colors duration-300 ${
                            hasActiveChild || isExpanded
                              ? 'text-primary'
                              : 'text-muted dark:text-slate-300 group-hover:text-primary'
                          }`}
                        >
                          {link.icon}
                        </span>
                        <span className="ml-3 flex-1 text-left text-sm-custom font-semibold text-foreground">
                          {link.label}
                        </span>
                        <svg
                          className={`h-4 w-4 text-muted transition-all duration-300 ${
                            isExpanded ? 'rotate-90 text-primary' : ''
                          }`}
                          viewBox="0 0 20 20"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M7 5l6 5-6 5" />
                        </svg>
                      </button>
                    ) : (
                      <Link
                        href={link.href}
                        onClick={closeMobileNav}
                        className={`group relative flex items-center rounded-xl px-3 py-3 transition-all duration-300 ${
                          isActive ? 'bg-primary/10 text-primary shadow-sm' : 'text-muted hover:bg-foreground/5 dark:text-foreground'
                        }`}
                      >
                        <span
                          className={`flex-shrink-0 transition-colors duration-300 ${
                            isActive ? 'text-primary' : 'text-muted dark:text-slate-300 group-hover:text-primary'
                          }`}
                        >
                          {link.icon}
                        </span>
                        <span className="ml-3 flex items-center gap-2 text-sm-custom font-semibold text-foreground">
                          <span>{link.label}</span>
                          {navigationNotificationCount > 0 ? (
                            <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white shadow-sm">
                              {navigationNotificationCount > 99 ? '99+' : navigationNotificationCount}
                            </span>
                          ) : null}
                        </span>
                        {navigationNotificationCount > 0 ? (
                          <span className="hidden absolute right-2 top-2 h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white shadow-sm">
                            {navigationNotificationCount > 99 ? '99+' : navigationNotificationCount}
                          </span>
                        ) : null}
                      </Link>
                    )}

                    {hasChildren && isExpanded ? (
                      <div className="ml-9 space-y-1">
                        {link.children!.map((child) => {
                          const isRootIntegration = child.href === '/integrations';
                          const childActive = isRootIntegration
                            ? normalizedPath === child.href
                            : normalizedPath === child.href || normalizedPath.startsWith(`${child.href}/`);
                          const childNotificationCount = getNavigationNotificationCount(child.href);
                          return (
                            <Link
                              key={`mobile-child-${child.href}`}
                              href={child.href}
                              onClick={closeMobileNav}
                              className={`flex items-center gap-2 rounded-lg px-2.5 py-2.5 text-sm-custom transition ${
                                childActive
                                  ? 'bg-primary/10 text-primary shadow-sm'
                                  : 'text-muted hover:bg-foreground/5 dark:text-foreground'
                              }`}
                            >
                              <span
                                className={`flex h-6 w-6 items-center justify-center rounded-full ${
                                  childActive ? 'bg-primary/15 text-primary' : 'bg-foreground/5 text-muted dark:text-slate-300'
                                }`}
                              >
                                {child.icon ?? <span className="h-4 w-4" />}
                              </span>
                              <span className="flex items-center gap-2 font-medium">
                                <span>{child.label}</span>
                                {childNotificationCount > 0 ? (
                                  <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white shadow-sm">
                                    {childNotificationCount > 99 ? '99+' : childNotificationCount}
                                  </span>
                                ) : null}
                              </span>
                            </Link>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </nav>

            <div className="border-t border-border px-3 py-3">
              <div className="rounded-xl border border-border bg-surface px-3 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    {`${user?.firstName?.[0] || ''}${user?.lastName?.[0] || ''}`.trim() || '??'}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm-custom font-semibold text-foreground">
                      {user?.firstName} {user?.lastName}
                    </p>
                    <p className="truncate text-xs text-muted">{user?.email}</p>
                  </div>
                </div>

                <div className="mt-3 space-y-1">
                  <Link
                    href="/settings/profile"
                    onClick={closeMobileNav}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm-custom text-foreground transition-colors hover:bg-foreground/5"
                  >
                    <svg className="h-4 w-4 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor">
                      <path
                        d="M4.5 10a5.5 5.5 0 0 1 10 0 5.5 5.5 0 0 1-10 0Zm5.5-3v3l2 1"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>Settings</span>
                  </Link>

                  <button
                    type="button"
                    onClick={() => {
                      closeMobileNav();
                      handleLogout();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm-custom text-foreground transition-colors hover:bg-foreground/5"
                  >
                    <svg className="h-4 w-4 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor">
                      <path d="M11 5v10M7 9l-2 2 2 2M11 10H4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>Log out</span>
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      {/* Collapsed sidebar popup - rendered outside sidebar to avoid clipping */}
      {isSidebarCollapsed && collapsedPopupItem && popupPosition && !isMobileNavMounted && (
        <div className="hidden md:block">
          {/* Backdrop to close popup when clicking outside */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCollapsedPopupItem(null)}
          />
          {filteredNavigation.filter(link => link.children && link.href === collapsedPopupItem).map((link) => {
            const normalizedPath = pathname?.split('?')[0] || '/';

            return (
              <div
                key={link.href}
                className="fixed z-50 w-56 rounded-2xl border border-border bg-surface shadow-lg"
                style={{
                  left: `${popupPosition.left}px`,
                  top: `${popupPosition.top}px`
                }}
              >
                <div className="border-b border-border/60 px-4 py-2.5">
                  <div className="text-sm-custom font-semibold text-foreground">{link.label}</div>
                </div>
                <div className="py-2">
                  {link.children!.map((child) => {
                    const isRootIntegration = child.href === '/integrations';
                    const childActive = isRootIntegration
                      ? normalizedPath === child.href
                      : normalizedPath === child.href || normalizedPath.startsWith(`${child.href}/`);
                    const childNotificationCount = getNavigationNotificationCount(child.href);
                    return (
                      <Link
                        key={child.href}
                        href={child.href}
                        onClick={() => setCollapsedPopupItem(null)}
                        className={`flex items-center gap-3 px-4 py-2.5 text-sm-custom transition ${
                          childActive
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted hover:bg-foreground/5 dark:text-foreground'
                        }`}
                      >
                        <span
                          className={`flex h-6 w-6 items-center justify-center rounded-full ${
                            childActive ? 'bg-primary/15 text-primary' : 'bg-foreground/5 text-muted dark:text-slate-300'
                          }`}
                        >
                          {child.icon ?? <span className="h-4 w-4" />}
                        </span>
                        <span className="flex items-center gap-2 font-medium">
                          <span>{child.label}</span>
                          {childNotificationCount > 0 ? (
                            <span className="flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white shadow-sm">
                              {childNotificationCount > 99 ? '99+' : childNotificationCount}
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Content Area */}
      <div className="flex-1 flex min-w-0 flex-col h-screen overflow-hidden bg-background">
        {/* Top bar - connected to sidebar (no border between them) */}
        <header className="sticky top-0 z-30 flex-shrink-0 bg-surface px-3 py-1 sm:px-4 lg:px-5">
          <div className="max-w-full flex min-h-[32px] items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openMobileNav}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface text-muted shadow-sm md:hidden"
                aria-label="Open navigation"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="h-10 md:hidden" />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))}
                className='btn btn-sm btn-outline btn-icon'
                aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-pressed={isDarkMode}
              >
                {isDarkMode ? <Sun className="h-4 w-4 text-primary" /> : <Moon className="h-4 w-4 text-primary" />}
              </button>
            {memberships.length > 1 ? (
              <div className="relative">
                <button
                  type="button"
                  disabled={isSwitchingTenant}
                  onClick={() => setIsTenantMenuOpen((prev) => !prev)}
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1 text-sm font-semibold text-foreground shadow-sm hover:border-primary/60 focus:border-primary focus:outline-none disabled:opacity-60"
                >
                  <span>Workspace:</span>
                  <span className="text-primary">
                    {memberships.find((m) => m.tenantId === activeTenantId)?.name ?? 'Choose'}
                  </span>
                  <svg className="h-4 w-4 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor">
                    <path d="M6 8l4 4 4-4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {isTenantMenuOpen && (
                  <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-surface shadow-lg">
                    <div className="max-h-64 overflow-auto py-2">
                      {memberships.map((m) => (
                        <button
                          key={m.tenantId}
                          type="button"
                          disabled={isSwitchingTenant}
                          onClick={() => {
                            setIsTenantMenuOpen(false);
                            if (m.tenantId === activeTenantId) return;
                            setIsSwitchingTenant(true);
                            void switchTenant(m.tenantId).catch(() => setIsSwitchingTenant(false));
                          }}
                          className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-foreground/5 ${m.tenantId === activeTenantId ? 'font-semibold text-primary' : 'text-foreground'}`}
                        >
                          <span className="truncate">{m.name}</span>
                          {m.tenantId === activeTenantId ? <span className="text-xs text-muted">Current</span> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
            {canViewAllTeams && teams.length > 0 ? (
              <div className="relative">
                {isLoadingTeams ? (
                  <span className="text-sm text-muted">Loading teams…</span>
                ) : teams.length > 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setIsTeamMenuOpen((prev) => !prev)}
                      className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1 text-sm font-semibold text-foreground shadow-sm hover:border-primary/60 focus:border-primary focus:outline-none"
                    >
                      <span>Team scope:</span>
                      <span className="text-primary">
                        {selectedTeamIds.length === 0
                          ? 'All teams'
                          : selectedTeamIds
                              .map((id) => teams.find((t) => t.id === id)?.name || id)
                              .join(', ')}
                      </span>
                      <svg className="h-4 w-4 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor">
                        <path d="M6 8l4 4 4-4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    {isTeamMenuOpen && (
                      <div className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-border bg-surface shadow-lg">
                        <div className="max-h-64 overflow-auto py-2">
                          <div className="flex items-center justify-between px-3 py-2 text-sm text-foreground hover:bg-foreground/5">
                            <label className="flex cursor-pointer items-center gap-2">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-border accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-primary/20"
                                checked={selectedTeamIds.length === 0}
                                onChange={() => handleTeamSelection('__all__')}
                              />
                              <span>All teams</span>
                            </label>
                          </div>
                          {teams.map((team) => (
                            <div
                              key={team.id}
                              className="flex items-center justify-between px-3 py-2 text-sm text-foreground hover:bg-foreground/5"
                            >
                              <label className="flex cursor-pointer items-center gap-2">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-border accent-primary checked:border-primary checked:bg-primary focus:ring-2 focus:ring-primary/20"
                                  checked={selectedTeamIds.includes(team.id)}
                                  onChange={() => handleTeamSelection(team.id)}
                                />
                                <span>{team.name}</span>
                              </label>
                              <button
                                className="text-xs font-semibold text-primary hover:text-primary/80"
                                onClick={() => handleOnlySelection(team.id)}
                              >
                                ONLY
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <span className="text-sm text-destructive">No teams</span>
                )}
              </div>
            ) : null}
            </div>
          </div>
        </header>

        {/* Main content area - rounded top-left corner for App Shell look */}
        <main className="flex-1 overflow-y-auto bg-background lg:rounded-tl-[1.75rem]">
          <ImpersonationBanner />
          <div className="mx-auto min-h-full w-full max-w-[1560px] px-3 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-4 sm:pb-7 lg:px-5 lg:pb-8">
            {children}
          </div>
        </main>
      </div>
      </div>
    </ToastProvider>
  );
}

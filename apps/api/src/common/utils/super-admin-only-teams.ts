export const SUPER_ADMIN_ONLY_TEAM_IDS = new Set([
  '00000000-0000-4000-8000-000000000003', // Ogimi (TEAM3)
  '00000000-0000-4000-8000-000000000004', // Kangen (TEAM4)
  '00000000-0000-4000-8000-000000000005', // Evah (TEAM5)
]);

export const SUPER_ADMIN_ONLY_TEAM_CODES = new Set([
  'TEAM3',
  'TEAM4',
  'TEAM5',
]);

export const SUPER_ADMIN_ONLY_TEAM_NAMES = new Set([
  'ogimi',
  'kangen',
  'evah',
  'evah fragrances',
]);

export const SUPER_ADMIN_ONLY_STORE_SHOP_IDS = new Set([
  '715088566', // Ogimi Wellness
  'kangen_store', // Kangen
  'evah_fragrances_store', // Evah Fragrances
]);

export const SUPER_ADMIN_ONLY_STORE_IDS = new Set([
  '23d5232f-dbc0-48cb-9160-d5793c5057aa', // Ogimi Wellness
  '00000000-0000-4000-8000-000000000014', // Kangen
  '00000000-0000-4000-8000-000000000015', // Evah Fragrances
]);

export function isSuperAdminOnlyTeamId(teamId?: string | null): boolean {
  const normalized = String(teamId || '').trim();
  return Boolean(normalized && SUPER_ADMIN_ONLY_TEAM_IDS.has(normalized));
}

export function isSuperAdminOnlyTeam(team?: {
  id?: string | null;
  teamCode?: string | null;
  name?: string | null;
} | null): boolean {
  if (!team) return false;
  if (isSuperAdminOnlyTeamId(team.id)) return true;
  const code = String(team.teamCode || '').trim().toUpperCase();
  if (code && SUPER_ADMIN_ONLY_TEAM_CODES.has(code)) return true;
  const name = String(team.name || '').trim().toLowerCase();
  if (name && SUPER_ADMIN_ONLY_TEAM_NAMES.has(name)) return true;
  return false;
}

export function isBusinessReportExcludedStore(store?: {
  id?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  teamId?: string | null;
} | null): boolean {
  if (!store) return false;
  if (isSuperAdminOnlyTeamId(store.teamId)) return true;
  const storeId = String(store.id || '').trim();
  if (storeId && SUPER_ADMIN_ONLY_STORE_IDS.has(storeId)) return true;
  const shopId = String(store.shopId || '').trim();
  if (shopId && SUPER_ADMIN_ONLY_STORE_SHOP_IDS.has(shopId)) return true;
  const shopName = String(store.shopName || '').trim().toLowerCase();
  if (
    shopName === 'ogimi wellness' ||
    shopName === 'ogimi' ||
    shopName === 'kangen' ||
    shopName === 'evah fragrances' ||
    shopName === 'evah'
  ) {
    return true;
  }
  return false;
}

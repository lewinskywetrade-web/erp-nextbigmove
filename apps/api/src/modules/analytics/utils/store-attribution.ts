import { isCodeSegment } from '../../creative-agent/utils/ad-name-convention';
import {
  parseProductMappingKey,
  parseUnassignedMappingKey,
} from '../../workflows/utils/product-mapping-key';

export const UNATTRIBUTED_STORE_KEY = '__unattributed__';

export type StoreAttributionRow = {
  adId?: string | null;
  adName?: string | null;
  mapping?: string | null;
  shops?: unknown;
};

export type StoreAttributionIndex = {
  storeByShopId: ReadonlyMap<string, string | null>;
  storeByAdId: ReadonlyMap<string, string | null>;
  storeByCreativeCode: ReadonlyMap<string, string | null>;
  storeByCodePrefix: ReadonlyMap<string, string | null>;
  storeByLabel: ReadonlyMap<string, string | null>;
  validStoreIds: ReadonlySet<string>;
};

export function creativeCodeParts(adName: string | null | undefined): {
  code: string;
  prefix: string;
} | null {
  const codes = creativeCodes(adName);
  if (codes.length !== 1) return null;
  const code = codes[0];
  const separator = code.lastIndexOf('-');
  if (separator <= 0) return null;
  return { code, prefix: code.slice(0, separator) };
}

function creativeCodes(adName: string | null | undefined): string[] {
  return [...new Set((adName || '').split('_').map(part => part.trim().toUpperCase()).filter(isCodeSegment))];
}

/** Resolve ad delivery ownership only. POS money is always grouped separately
 * by its actual shop. An explicit identity link wins over name/shop hints;
 * otherwise every recognized hint must agree on one valid active store.
 */
export function resolveStoreAttribution(
  row: StoreAttributionRow,
  index: StoreAttributionIndex,
): string {
  if (row.adId && index.storeByAdId.has(row.adId)) {
    const linked = index.storeByAdId.get(row.adId);
    return linked && index.validStoreIds.has(linked) ? linked : UNATTRIBUTED_STORE_KEY;
  }

  const candidates = new Set<string>();
  let ambiguous = creativeCodes(row.adName).length > 1;
  const add = (value: string | null | undefined) => {
    if (!value || !index.validStoreIds.has(value)) ambiguous = true;
    else candidates.add(value);
  };
  const fromMap = (map: ReadonlyMap<string, string | null>, key: string) => {
    if (map.has(key)) add(map.get(key));
  };
  const shops = Array.isArray(row.shops) ? row.shops : [];
  for (const raw of shops) {
    const shop = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
    if (!shop) ambiguous = true;
    else add(index.storeByShopId.get(shop));
  }

  const code = creativeCodeParts(row.adName);
  if (code) {
    fromMap(index.storeByCreativeCode, code.code);
    fromMap(index.storeByCodePrefix, code.prefix);
  }
  const mapping = typeof row.mapping === 'string' ? row.mapping : null;
  const precise = parseProductMappingKey(mapping) ?? parseUnassignedMappingKey(mapping);
  if (precise) add(precise.storeId);
  else {
    const label = mapping?.trim().toLowerCase();
    if (label) fromMap(index.storeByLabel, label);
  }

  return !ambiguous && candidates.size === 1
    ? candidates.values().next().value!
    : UNATTRIBUTED_STORE_KEY;
}

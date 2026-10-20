import { Prisma } from '@prisma/client';

export const PANCAKE_RETAIL_PRICE_POLICY = 'CATALOG_RETAIL_CURRENCY_V1';

type Currency = 'PHP' | 'PHP1' | 'PHP100';
type RecordValue = Record<string, unknown>;

export type PancakeShopCurrency = {
  shopId: string;
  currency: Currency | null;
  divisor: '1' | '100' | null;
  observedAt: string;
  reason: string | null;
};

export type RetailPriceEvidence = {
  policy: typeof PANCAKE_RETAIL_PRICE_POLICY;
  status: 'NORMALIZED' | 'SKIPPED';
  reason: string | null;
  shopId: string;
  productId: string;
  variationId: string | null;
  sourcePath: string | null;
  rawAmount: string | null;
  sourceCurrency: Currency | null;
  divisor: '1' | '100' | null;
  normalizedCurrency: 'PHP';
  normalizedAmount: string | null;
  observedAt: string;
};

const CURRENCY_FIELDS = ['currency', 'currency_code', 'currencyCode', 'default_currency', 'shop_currency'];
const DIVISOR_FIELDS = ['currency_divisor', 'currencyDivisor', 'currency_multiplier', 'currencyMultiplier'];
const PRICE_FIELDS = ['retail_price', 'retailPrice', 'price', 'selling_price', 'exact_price'];
const MONEY_FIELDS = ['amount', 'value', ...PRICE_FIELDS];
const MAX_RETAIL_PRICE = new Prisma.Decimal('9999999999.99'); // Decimal(12, 2).
const MAX_SHOP_CURRENCY_RESPONSE_BYTES = 8 * 1024 * 1024;

export async function readPancakeShopCurrencyResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body ||
      Number(response.headers.get('content-length') || 0) > MAX_SHOP_CURRENCY_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('SHOP_CURRENCY_RESPONSE_UNAVAILABLE');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SHOP_CURRENCY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('SHOP_CURRENCY_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : null;
}

function identity(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim() || null : null;
}

function token(value: unknown): Currency | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return normalized === 'PHP' || normalized === 'PHP1' || normalized === 'PHP100'
    ? normalized : null;
}

function divisor(currency: Currency): '1' | '100' {
  return currency === 'PHP100' ? '100' : '1';
}

function metadataConflict(value: unknown, expected: Currency): boolean {
  const row = object(value);
  if (!row) return false;
  for (const key of CURRENCY_FIELDS) {
    if (row[key] === null || row[key] === undefined || row[key] === '') continue;
    const found = token(row[key]);
    if (!found || divisor(found) !== divisor(expected)) return true;
  }
  for (const key of DIVISOR_FIELDS) {
    if (row[key] === null || row[key] === undefined || row[key] === '') continue;
    if (String(row[key]).trim() !== divisor(expected)) return true;
  }
  // These encodings are not established by the provider contract we observed.
  return ['money_unit', 'moneyUnit', 'unit_type'].some(key =>
    row[key] !== null && row[key] !== undefined && row[key] !== '',
  );
}

export function missingPancakeShopCurrency(
  shopId: string, reason: string, observedAt = new Date().toISOString(),
): PancakeShopCurrency {
  return { shopId, currency: null, divisor: null, observedAt, reason };
}

/** Only the exact current /shops record establishes catalog units; old orders do not. */
export function resolvePancakeShopCurrency(
  payload: unknown, shopId: string, observedAt = new Date().toISOString(),
): PancakeShopCurrency {
  const body = object(payload);
  if (body?.success !== true || !Array.isArray(body.shops)) {
    return missingPancakeShopCurrency(shopId, 'SHOP_CURRENCY_RESPONSE_UNAVAILABLE', observedAt);
  }
  const matches = body.shops.filter(shop => identity(object(shop)?.id) === shopId);
  if (matches.length !== 1) {
    return missingPancakeShopCurrency(shopId, 'SHOP_CURRENCY_IDENTITY_NOT_UNIQUE', observedAt);
  }
  const shop = object(matches[0])!;
  const currency = token(shop.currency);
  if (!currency || metadataConflict(shop, currency)) {
    return missingPancakeShopCurrency(shopId, 'SHOP_CURRENCY_UNSUPPORTED_OR_CONFLICTING', observedAt);
  }
  return { shopId, currency, divisor: divisor(currency), observedAt, reason: null };
}

function parseAmount(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Prisma.Decimal)) return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
  const raw = String(value).trim();
  // No symbol stripping, locale guessing, exponent rewriting, or float round trip.
  if (raw.length > 32 || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  try {
    const parsed = new Prisma.Decimal(raw);
    return parsed.isFinite() && parsed.gte(0) ? parsed : null;
  } catch {
    return null;
  }
}

function parseMoney(value: unknown, currency: Currency) {
  const money = value instanceof Prisma.Decimal ? null : object(value);
  if (!money) return { amount: parseAmount(value), field: null, reason: 'PRICE_AMOUNT_INVALID' };
  if (metadataConflict(money, currency)) {
    return { amount: null, field: null, reason: 'PRICE_CURRENCY_METADATA_CONFLICT' };
  }
  const fields = MONEY_FIELDS.filter(key => money[key] !== null && money[key] !== undefined && money[key] !== '');
  const amounts = fields.map(key => parseAmount(money[key]));
  if (!amounts.length || amounts.some(amount => !amount || !amount.eq(amounts[0]!))) {
    return { amount: null, field: null, reason: 'PRICE_OBJECT_AMOUNT_INVALID_OR_CONFLICTING' };
  }
  return { amount: amounts[0], field: fields[0], reason: null };
}

function currencyPriceMapConflicts(value: unknown, currency: Currency, amount: Prisma.Decimal): boolean {
  if (value === null || value === undefined) return false;
  const map = object(value);
  if (!map && !Array.isArray(value)) return true;
  if (Array.isArray(value)) {
    if (value.length > 50) return true;
    for (const entry of value) {
      const row = object(entry);
      const found = token(row?.currency ?? row?.currency_code);
      if (found && divisor(found) === divisor(currency) && metadataConflict(row, currency)) return true;
    }
  }
  const entries: Array<[unknown, unknown]> = map ? Object.entries(map) : (value as unknown[]).map(entry => {
    const row = object(entry);
    return [row?.currency ?? row?.currency_code, row?.retail_price ?? row?.price ?? row?.value];
  });
  if (entries.length > 50) return true;
  for (const [code, price] of entries) {
    const found = token(code);
    if (!found || divisor(found) !== divisor(currency)) continue;
    const parsed = parseMoney(price, currency).amount;
    if (!parsed || !parsed.eq(amount)) return true;
  }
  return false;
}

function firstPrice(row: RecordValue | null, path: string): { value: unknown; path: string } | null {
  if (!row) return null;
  for (const field of PRICE_FIELDS) {
    if (row[field] !== null && row[field] !== undefined && row[field] !== '') {
      return { value: row[field], path: `${path}.${field}` };
    }
  }
  return null;
}

export function normalizePancakeRetailPrice(
  item: unknown,
  scope: { shopId: string; productId: string; variationId: string | null },
  context: PancakeShopCurrency,
  responseMetadata: unknown[] = [],
): { retailPrice: Prisma.Decimal | null; evidence: RetailPriceEvidence } {
  const evidence: RetailPriceEvidence = {
    policy: PANCAKE_RETAIL_PRICE_POLICY, status: 'SKIPPED', reason: null,
    ...scope, sourcePath: null, rawAmount: null,
    sourceCurrency: context.currency, divisor: context.divisor,
    normalizedCurrency: 'PHP', normalizedAmount: null, observedAt: context.observedAt,
  };
  const skip = (reason: string) => ({ retailPrice: null, evidence: { ...evidence, reason } });
  if (context.shopId !== scope.shopId || !context.currency || !context.divisor || context.reason) {
    return skip(context.reason || 'SHOP_CURRENCY_UNAVAILABLE');
  }
  const row = object(item);
  if (!row) return skip('PRODUCT_ROW_INVALID');
  const variationInfo = object(row.variation_info);
  const variation = object(row.variation);
  const parent = object(row.product);
  for (const candidate of [row, variationInfo, variation]) {
    if (!candidate) continue;
    for (const key of ['product_id', 'productId']) {
      if (identity(candidate[key]) && identity(candidate[key]) !== scope.productId) {
        return skip('PRICE_PRODUCT_IDENTITY_CONFLICT');
      }
    }
    for (const key of ['variation_id', 'variationId', 'id']) {
      const id = identity(candidate[key]);
      // A root parent row can use its product ID; a nested variation cannot.
      if (id && id !== scope.variationId && !(candidate === row && key === 'id' && id === scope.productId)) {
        return skip('PRICE_VARIATION_IDENTITY_CONFLICT');
      }
    }
  }
  if (identity(parent?.id) && identity(parent?.id) !== scope.productId) {
    return skip('PRICE_PRODUCT_IDENTITY_CONFLICT');
  }
  if ([row, variationInfo, variation, parent, ...responseMetadata].some(value => metadataConflict(value, context.currency!))) {
    return skip('PRICE_CURRENCY_METADATA_CONFLICT');
  }

  // Expanded variation rows supply their own price. Never borrow a parent's or
  // the first sibling's amount when the selected variation has no price.
  const selected = firstPrice(row, 'row')
    ?? firstPrice(variationInfo, 'row.variation_info')
    ?? firstPrice(variation, 'row.variation');
  if (!selected) return skip('PRICE_MISSING_FOR_EXACT_VARIATION');
  evidence.sourcePath = selected.path;
  const money = parseMoney(selected.value, context.currency);
  if (!money.amount) return skip(money.reason || 'PRICE_AMOUNT_INVALID');
  if (money.field) evidence.sourcePath += `.${money.field}`;
  const amount = money.amount;
  if ([row, variationInfo, variation].some(value =>
    currencyPriceMapConflicts(value?.retail_price_by_currency, context.currency!, amount),
  )) return skip('PRICE_CURRENT_CURRENCY_MAP_CONFLICT');
  evidence.rawAmount = amount.toFixed();
  const normalized = amount.div(context.divisor);
  if (normalized.gt(MAX_RETAIL_PRICE) || normalized.decimalPlaces() > 2) {
    return skip('PRICE_AMOUNT_OUTSIDE_STORAGE_PRECISION');
  }
  evidence.status = 'NORMALIZED';
  evidence.normalizedAmount = normalized.toFixed(2);
  return { retailPrice: normalized, evidence };
}

/** Persistence consumes already-normalized values; it never scales stored prices. */
export function normalizedPancakeRetailPriceForStorage(
  value: unknown, evidence: RetailPriceEvidence | undefined,
  scope: { shopId: string; productId: string; variationId: string | null },
): Prisma.Decimal | null {
  if (!(value instanceof Prisma.Decimal) || !value.isFinite() || value.lt(0) ||
      value.gt(MAX_RETAIL_PRICE) || value.decimalPlaces() > 2 ||
      evidence?.policy !== PANCAKE_RETAIL_PRICE_POLICY || evidence.status !== 'NORMALIZED' ||
      evidence.shopId !== scope.shopId || evidence.productId !== scope.productId ||
      evidence.variationId !== scope.variationId || evidence.normalizedAmount !== value.toFixed(2)) {
    return null;
  }
  return value;
}

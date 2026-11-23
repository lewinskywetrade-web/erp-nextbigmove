import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  canManageClientPortalAutoEmail,
  hasDailyInventoryReadPermission,
  hasReportsNavPermission,
  pruneSelectedStoreIds,
  resolveInitialReportsTab,
} from '../src/app/(dashboard)/reports/_utils/daily-inventory-helpers';
import type { ErpDailyInventoryReportResponse } from '../src/app/(dashboard)/reports/_types/reports';

const baseResponse = (
  overrides: Partial<ErpDailyInventoryReportResponse> = {},
): ErpDailyInventoryReportResponse => ({
  report: {
    key: 'DAILY_INVENTORY_INS_OUTS',
    label: 'Daily Inventory Ins & Outs Report',
    generatedAt: '2026-11-19T12:00:00.000Z',
    startDate: '2026-11-19',
    endDate: '2026-11-19',
    timezone: 'Asia/Manila',
  },
  filters: {
    stores: [
      {
        id: 'store-1',
        tenantId: 'tenant-1',
        tenantName: 'Next Big Move',
        shopId: 'shop-1',
        name: 'Store 1',
      },
    ],
    selectedStoreIds: [],
    effectiveStoreIds: ['store-1'],
  },
  totals: {
    variantCount: 0,
    activeMovedVariantCount: 0,
    receivedInQty: 0,
    manualInQty: 0,
    restockedInQty: 0,
    totalInQty: 0,
    putAwayMovedQty: 0,
    dispatchedOutQty: 0,
    packedOutQty: 0,
    adjustedOutQty: 0,
    totalOutQty: 0,
    netChangeQty: 0,
    receivedQty: 0,
    stagedQty: 0,
    awaitingPutAwayQty: 0,
    putAwayQty: 0,
    reservedQty: 0,
    inBinQty: 0,
    onHandQty: 0,
  },
  rows: [],
  recentMovements: [],
  subscriptions: [],
  ...overrides,
});

test('client portal permission helpers grant Daily Stock Ins & Outs to daily_inventory, pos_orders, and stock_request roles', () => {
  assert.equal(hasDailyInventoryReadPermission(['reports.daily_inventory.read']), true);
  assert.equal(hasDailyInventoryReadPermission(['stock_request.read']), true);
  assert.equal(hasDailyInventoryReadPermission(['reports.pos_orders.read']), true);
  assert.equal(hasDailyInventoryReadPermission(['ads.read']), false);

  assert.equal(hasReportsNavPermission(['reports.daily_inventory.read']), true);
  assert.equal(hasReportsNavPermission(['stock_request.read']), true);
  assert.equal(hasReportsNavPermission(['ads.read']), false);
});

test('resolveInitialReportsTab defaults to daily-inventory for store/stock-request users without pos_orders permission', () => {
  assert.equal(
    resolveInitialReportsTab({ permissions: ['stock_request.read'], requestedTab: null }),
    'daily-inventory',
  );
  assert.equal(
    resolveInitialReportsTab({
      permissions: ['reports.pos_orders.read', 'reports.daily_inventory.read'],
      requestedTab: 'daily-inventory',
    }),
    'daily-inventory',
  );
  assert.equal(
    resolveInitialReportsTab({
      permissions: ['reports.pos_orders.read', 'reports.daily_inventory.read'],
      requestedTab: null,
    }),
    'pos-orders',
  );
});

test('pruneSelectedStoreIds removes store IDs outside the server-returned allowed stores list', () => {
  const pruned = pruneSelectedStoreIds(
    ['store-1', 'store-other-team'],
    [{ id: 'store-1' }, { id: 'store-2' }],
  );
  assert.deepEqual(pruned, ['store-1']);
  assert.deepEqual(pruneSelectedStoreIds(['store-other'], []), []);
});

test('canManageClientPortalAutoEmail hides tenant-wide email settings when team-scoped or no subscription is returned', () => {
  const hiddenForTeam = baseResponse({
    filters: {
      stores: [],
      selectedStoreIds: [],
      effectiveStoreIds: [],
      isTeamScoped: true,
      canManageEmailSubscription: false,
    },
    subscriptions: [
      {
        tenantId: 'tenant-1',
        tenantName: 'Next Big Move',
        enabled: true,
        recipients: ['a@b.com'],
        defaultRecipients: [],
        effectiveRecipients: ['a@b.com'],
        sendTimeManila: '20:00',
        lastSentAt: null,
        lastSentDate: null,
        lastDeliveryStatus: null,
        lastDeliveryMode: null,
        lastError: null,
      },
    ],
  });
  assert.equal(canManageClientPortalAutoEmail(hiddenForTeam), false);

  const visibleForFullAdmin = baseResponse({
    filters: {
      stores: [
        {
          id: 'store-1',
          tenantId: 'tenant-1',
          tenantName: 'Next Big Move',
          shopId: 'shop-1',
          name: 'Store 1',
        },
      ],
      selectedStoreIds: [],
      effectiveStoreIds: ['store-1'],
      isTeamScoped: false,
      canManageEmailSubscription: true,
    },
    subscriptions: hiddenForTeam.subscriptions,
  });
  assert.equal(canManageClientPortalAutoEmail(visibleForFullAdmin), true);
});

test('client portal navigation and panel source wire /daily-inventory and teamScopeChanged listener', () => {
  const layoutSource = fs.readFileSync(
    path.join(process.cwd(), 'src/app/(dashboard)/layout.tsx'),
    'utf8',
  );
  const panelSource = fs.readFileSync(
    path.join(
      process.cwd(),
      'src/app/(dashboard)/reports/_components/daily-inventory-ins-outs-panel.tsx',
    ),
    'utf8',
  );
  assert.match(layoutSource, /href:\s*'\/daily-inventory'/);
  assert.match(panelSource, /teamScopeChanged/);
  assert.match(panelSource, /canManageClientPortalAutoEmail/);
  assert.match(panelSource, /storeIds:\s*selectedStoreId\s*\?\s*\[selectedStoreId\]\s*:\s*undefined/);
});

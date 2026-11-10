import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  BadgeDollarSign,
  Building2,
  Boxes,
  FileSpreadsheet,
  ClipboardList,
  LayoutGrid,
  PackageCheck,
  Truck,
  Warehouse,
} from 'lucide-react';

export const WMS_PERMISSION_PREFIX = 'wms.';

export function hasWmsAccess(role: string | null | undefined, permissions: string[]): boolean {
  if (role === 'SUPER_ADMIN') {
    return true;
  }

  return permissions.some((permission) => permission.startsWith(WMS_PERMISSION_PREFIX));
}

export type WmsNavItem = {
  href?: string;
  label: string;
  icon: LucideIcon;
  permission?: string | string[];
  platformOnly?: boolean;
  children?: WmsNavItemChild[];
};

export type WmsNavItemChild = {
  href: string;
  label: string;
  permission?: string | string[];
  platformOnly?: boolean;
};

export const WMS_NAV_ITEMS: WmsNavItem[] = [
  {
    href: '/wms',
    label: 'Dashboard',
    icon: LayoutGrid,
    permission: 'wms.core.read',
  },
  {
    href: '/tenants',
    label: 'Clients',
    icon: Building2,
    permission: 'wms.partners.read',
  },
  {
    href: '/purchasing',
    label: 'Purchasing',
    icon: BadgeDollarSign,
    permission: 'wms.purchasing.read',
  },
  {
    href: '/warehouses',
    label: 'Warehouses',
    icon: Warehouse,
    permission: 'wms.warehouses.read',
  },
  {
    href: '/products',
    label: 'Products',
    icon: Boxes,
    permission: 'wms.products.read',
  },
  {
    label: 'Inventory',
    icon: Archive,
    children: [
      {
        href: '/inventory/stock',
        label: 'Stock',
        permission: 'wms.inventory.read',
      },
      {
        href: '/inventory/outbound-records',
        label: 'Outbound Records',
        permission: 'wms.inventory.read',
      },
      {
        href: '/inventory/stock-receiving',
        label: 'Stock Receiving',
        permission: 'wms.receiving.read',
      },
      {
        href: '/inventory/transfer',
        label: 'Transfer',
        permission: 'wms.receiving.read',
      },
    ],
  },
  {
    label: 'Fulfillment',
    icon: PackageCheck,
    children: [
      {
        href: '/orders/pick',
        label: 'Pick',
        permission: [
          'wms.fulfillment.read',
          'wms.fulfillment.write',
          'wms.fulfillment.edit',
          'wms.fulfillment.override',
          'wms.fulfillment.bypass',
        ],
      },
      {
        href: '/orders/pack',
        label: 'Pack',
        permission: [
          'wms.dispatch.read',
          'wms.dispatch.write',
          'wms.dispatch.edit',
          'wms.dispatch.override',
        ],
      },
    ],
  },
  {
    href: '/shipments',
    label: 'Dispatch',
    icon: Truck,
    permission: ['wms.dispatch.read', 'wms.rts.read'],
  },
  {
    href: '/forecast',
    label: 'Forecast',
    icon: FileSpreadsheet,
    permission: 'wms.forecast.read',
  },
  {
    href: '/reports',
    label: 'Reports',
    icon: ClipboardList,
    permission: ['wms.reports.month_end_stock.read', 'wms.inventory.read', 'wms.partners.read'],
  },
];

import { createDecipheriv, createHash, randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  Prisma,
  PrismaClient,
  RbacWorkspace,
  RoleScope,
  WmsFulfillmentAssignmentMode,
  WmsFulfillmentLineStatus,
  WmsFulfillmentOrderStatus,
  WmsInventoryUnitStatus,
  WmsLocationKind,
  WmsProductProfileStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import Redis from 'ioredis';

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) {
    return;
  }

  const contents = readFileSync(filePath, 'utf8');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '../../.env'));

const prisma = new PrismaClient();

type RoleDef = {
  key: string;
  name: string;
  description?: string;
  scope: RoleScope;
  permissions: string[];
  workspace?: RbacWorkspace;
  isSystem?: boolean;
};

const WMS_PERMISSION_KEYS = [
  'wms.core.read',
  'wms.partners.read',
  'wms.partners.write',
  'wms.partners.edit',
  'wms.users.read',
  'wms.users.write',
  'wms.roles.read',
  'wms.roles.write',
  'wms.purchasing.read',
  'wms.purchasing.write',
  'wms.purchasing.edit',
  'wms.purchasing.delete',
  'wms.purchasing.post_receiving',
  'wms.invoice.read',
  'wms.invoice.edit',
  'wms.warehouses.read',
  'wms.warehouses.write',
  'wms.warehouses.edit',
  'wms.warehouses.delete',
  'wms.products.read',
  'wms.products.write',
  'wms.products.edit',
  'wms.products.delete',
  'wms.products.sync',
  'wms.receiving.read',
  'wms.receiving.write',
  'wms.receiving.edit',
  'wms.receiving.delete',
  'wms.receiving.manual_input',
  'wms.receiving.print_labels',
  'wms.inventory.read',
  'wms.inventory.write',
  'wms.inventory.edit',
  'wms.inventory.delete',
  'wms.inventory.print_labels',
  'wms.inventory.transfer',
  'wms.inventory.adjust',
  'wms.fulfillment.read',
  'wms.fulfillment.write',
  'wms.fulfillment.edit',
  'wms.fulfillment.delete',
  'wms.fulfillment.override',
  'wms.fulfillment.bypass',
  'wms.history.read_all',
  'wms.dispatch.read',
  'wms.dispatch.write',
  'wms.dispatch.edit',
  'wms.dispatch.void',
  'wms.dispatch.delete',
  'wms.dispatch.override',
  'wms.stox.read',
  'wms.stox.write',
  'wms.integrations.read',
  'wms.integrations.write',
  'wms.integrations.edit',
  'wms.integrations.sync',
  'wms.integrations.webhook.read',
  'wms.integrations.webhook.update',
  'wms.integrations.webhook.rotate',
  'wms.rts.read',
  'wms.rts.write',
  'wms.rts.edit',
  'wms.rts.delete',
  'wms.rts.disposition',
  'wms.forecast.read',
  'wms.forecast.write',
  'wms.forecast.edit',
  'wms.forecast.delete',
  'wms.reports.month_end_stock.read',
] as const;

const PERMISSIONS: { key: string; description: string }[] = [
  { key: 'tenant.manage', description: 'Manage tenant settings' },
  { key: 'team.manage', description: 'Create/update teams' },
  { key: 'team.read', description: 'Read teams' },
  { key: 'team.read_all', description: 'View all teams and their data' },
  { key: 'user.manage', description: 'Manage users within tenant' },
  { key: 'user.read', description: 'Read users within tenant' },
  { key: 'user.impersonate', description: 'View the app as another user in the tenant' },
  { key: 'permission.assign', description: 'Assign roles and permissions' },
  { key: 'role.read', description: 'Read roles and permissions' },
  { key: 'integration.create', description: 'Create integrations' },
  { key: 'integration.read', description: 'Read integrations' },
  { key: 'integration.update', description: 'Update integrations' },
  { key: 'integration.webhook.read', description: 'Read Pancake webhook settings' },
  { key: 'integration.webhook.update', description: 'Manage Pancake webhook settings' },
  { key: 'integration.webhook.rotate', description: 'Rotate Pancake webhook API key' },
  { key: 'integration.delete', description: 'Delete integrations' },
  { key: 'integration.test', description: 'Test integrations' },
  { key: 'integration.share', description: 'Share integrations with other teams' },
  { key: 'workflow.create', description: 'Create workflows' },
  { key: 'workflow.read', description: 'Read workflows' },
  { key: 'workflow.update', description: 'Update workflows' },
  { key: 'workflow.delete', description: 'Delete workflows' },
  { key: 'workflow.execute', description: 'Execute workflows' },
  { key: 'workflow.view_executions', description: 'View workflow executions' },
  { key: 'workflow.share', description: 'Share workflows with other teams' },
  { key: 'pos.read', description: 'Read POS stores/orders/products' },
  { key: 'pos.cogs.manage', description: 'Manage POS COGS' },
  { key: 'meta.read', description: 'Read Meta ads/accounts/insights' },
  { key: 'analytics.marketing', description: 'Read marketing analytics dashboards' },
  { key: 'analytics.sales', description: 'Read sales analytics dashboards' },
  { key: 'analytics.sales_performance', description: 'Read sales performance analytics dashboards' },
  { key: 'analytics.share', description: 'Share analytics data with other teams' },
  { key: 'advertising.read', description: 'Read advertising performance and verdicts' },
  { key: 'advertising.manage', description: 'Manage advertising benchmarks, assets and imports' },
  { key: 'advertising.evaluate', description: 'Run the AI advertising evaluator' },
  { key: 'creative_agent.read', description: 'Read own Creative Agent registry records' },
  { key: 'creative_agent.read_all', description: 'Read all Creative Agent registry records in the tenant' },
  { key: 'creative_agent.enroll', description: 'Enroll Creative Agent registry records' },
  { key: 'creative_agent.edit', description: 'Edit own Creative Agent registry records' },
  { key: 'creative_agent.edit_all', description: 'Edit all Creative Agent registry records in the tenant' },
  { key: 'creative_agent.alias.manage', description: 'Manage Creative Agent Meta aliases' },
  { key: 'creative_agent.review', description: 'Review Creative Agent QC workflow' },
  { key: 'creative_agent.performance.manage', description: 'Manage Creative Agent performance states' },
  { key: 'creative_agent.stores.manage', description: 'Configure POS stores for Creative Agent' },
  { key: 'creative_agent.ai.use', description: 'Run AI analysis for permitted Creative Agent records' },
  { key: 'creative_agent.ai.manage', description: 'Manage this tenant Creative AI provider connections, defaults, and tenant-wide analysis runs' },
  { key: 'stock_request.read', description: 'Read ERP stock requests and WMS response queue' },
  { key: 'stock_request.write', description: 'Create ERP stock requests and respond to WMS revisions' },
  { key: 'orders.summary.read', description: 'Read orders summary page' },
  { key: 'orders.undeliverables.read', description: 'Read assigned undeliverables orders' },
  { key: 'orders.undeliverables.read_all', description: 'Read all undeliverables orders across tenant stores' },
  { key: 'orders.undeliverables.assign', description: 'Assign undeliverables stores to ERP users' },
  { key: 'orders.undeliverables.remarks.write', description: 'Create and manage undeliverables order remarks' },
  { key: 'reports.pos_orders.read', description: 'Read tenant-wide POS orders reports' },
  { key: 'dashboard.marketing', description: 'View marketing dashboard (my stats)' },
  { key: 'dashboard.marketing_leader', description: 'View marketing leader dashboard' },
  { key: 'dashboard.executives', description: 'View executives dashboard (sales overview)' },
  { key: 'dashboard.sales', description: 'View sales dashboard (my stats)' },
  { key: 'kpi.marketing.read', description: 'Read marketing KPI pages and widgets' },
  { key: 'kpi.marketing.manage', description: 'Manage marketing KPI targets and assignments' },
  { key: 'kpi.funnel.read', description: 'Read funnel KPI placeholder pages' },
  { key: 'kpi.sales.read', description: 'Read sales KPI placeholder pages' },
  { key: 'wms.core.read', description: 'Access the WMS workspace shell and stock-truth foundation' },
  { key: 'wms.partners.read', description: 'Read WMS partner directory and partner details' },
  { key: 'wms.partners.write', description: 'Create WMS partners' },
  { key: 'wms.partners.edit', description: 'Edit WMS partner settings and status' },
  { key: 'wms.users.read', description: 'Read WMS staff users and access assignments' },
  { key: 'wms.users.write', description: 'Manage WMS staff users and access assignments' },
  { key: 'wms.roles.read', description: 'Read WMS roles and permissions' },
  { key: 'wms.roles.write', description: 'Manage WMS roles and permissions' },
  { key: 'wms.purchasing.read', description: 'Read WMS purchasing batches and requests' },
  { key: 'wms.purchasing.write', description: 'Create WMS purchasing batches and requests' },
  { key: 'wms.purchasing.edit', description: 'Edit WMS purchasing batches and requests' },
  { key: 'wms.purchasing.delete', description: 'Delete WMS purchasing batches and requests' },
  { key: 'wms.purchasing.post_receiving', description: 'Post purchasing batches into stock receiving' },
  { key: 'wms.invoice.read', description: 'Read WMS invoices and invoice settings' },
  { key: 'wms.invoice.edit', description: 'Manage WMS invoices and invoice settings' },
  { key: 'wms.warehouses.read', description: 'Read WMS warehouses and locations' },
  { key: 'wms.warehouses.write', description: 'Create WMS warehouses and locations' },
  { key: 'wms.warehouses.edit', description: 'Edit WMS warehouses and locations' },
  { key: 'wms.warehouses.delete', description: 'Delete WMS warehouses and locations' },
  { key: 'wms.products.read', description: 'Read WMS product profiles' },
  { key: 'wms.products.write', description: 'Create WMS product profiles' },
  { key: 'wms.products.edit', description: 'Edit WMS product profiles' },
  { key: 'wms.products.delete', description: 'Delete WMS product profiles' },
  { key: 'wms.products.sync', description: 'Sync WMS product profiles from connected stores' },
  { key: 'wms.receiving.read', description: 'Read WMS receiving batches' },
  { key: 'wms.receiving.write', description: 'Create WMS receiving batches' },
  { key: 'wms.receiving.edit', description: 'Edit WMS receiving batches' },
  { key: 'wms.receiving.delete', description: 'Delete WMS receiving batches' },
  { key: 'wms.receiving.manual_input', description: 'Create manual stock input in WMS receiving' },
  { key: 'wms.receiving.print_labels', description: 'Print and reprint WMS receiving batch labels' },
  { key: 'wms.inventory.read', description: 'Read WMS inventory units and stock views' },
  { key: 'wms.inventory.write', description: 'Create WMS inventory records' },
  { key: 'wms.inventory.edit', description: 'Edit WMS inventory records' },
  { key: 'wms.inventory.delete', description: 'Void WMS inventory units' },
  { key: 'wms.inventory.print_labels', description: 'Print and reprint WMS unit labels' },
  { key: 'wms.inventory.transfer', description: 'Transfer WMS inventory between locations' },
  { key: 'wms.inventory.adjust', description: 'Adjust WMS inventory balances and unit states' },
  { key: 'wms.fulfillment.read', description: 'Read WMS fulfillment workflows' },
  { key: 'wms.fulfillment.write', description: 'Create WMS fulfillment workflows' },
  { key: 'wms.fulfillment.edit', description: 'Edit WMS fulfillment workflows' },
  { key: 'wms.fulfillment.delete', description: 'Delete WMS fulfillment workflows' },
  { key: 'wms.fulfillment.override', description: 'Override WMS fulfillment workflow states' },
  { key: 'wms.fulfillment.bypass', description: 'Bypass or substitute pre-pick WMS fulfillment items' },
  { key: 'wms.history.read_all', description: 'Read all STOX and WMS history activities across users' },
  { key: 'wms.dispatch.read', description: 'Read WMS dispatch workflows' },
  { key: 'wms.dispatch.write', description: 'Create WMS dispatch workflows' },
  { key: 'wms.dispatch.edit', description: 'Edit WMS dispatch workflows' },
  { key: 'wms.dispatch.void', description: 'Void WMS dispatch and packing orders back into inventory' },
  { key: 'wms.dispatch.delete', description: 'Delete WMS dispatch workflows' },
  { key: 'wms.dispatch.override', description: 'Override WMS dispatch workflow states' },
  { key: 'wms.stox.read', description: 'Read internal STOX app releases and download links' },
  { key: 'wms.stox.write', description: 'Manage internal STOX app releases and activation' },
  { key: 'wms.integrations.read', description: 'Read WMS partner integration status and connected POS stores' },
  { key: 'wms.integrations.write', description: 'Create WMS-managed partner integrations' },
  { key: 'wms.integrations.edit', description: 'Edit WMS-managed partner integrations' },
  { key: 'wms.integrations.sync', description: 'Sync connected POS stores for WMS operations' },
  { key: 'wms.integrations.webhook.read', description: 'Read WMS partner webhook settings and logs' },
  { key: 'wms.integrations.webhook.update', description: 'Manage WMS partner webhook settings' },
  { key: 'wms.integrations.webhook.rotate', description: 'Rotate WMS partner webhook API keys' },
  { key: 'wms.rts.read', description: 'Read WMS RTS workflows' },
  { key: 'wms.rts.write', description: 'Create WMS RTS workflows' },
  { key: 'wms.rts.edit', description: 'Edit WMS RTS workflows' },
  { key: 'wms.rts.delete', description: 'Delete WMS RTS workflows' },
  { key: 'wms.rts.disposition', description: 'Apply RTS disposition actions in WMS' },
  { key: 'wms.forecast.read', description: 'Read WMS forecast adapter views' },
  { key: 'wms.forecast.write', description: 'Create WMS forecast adapter records' },
  { key: 'wms.forecast.edit', description: 'Edit WMS forecast adapter records' },
  { key: 'wms.forecast.delete', description: 'Delete WMS forecast adapter records' },
  { key: 'wms.reports.month_end_stock.read', description: 'Generate and export WMS month-end stock reports' },
];

const ROLES: RoleDef[] = [
  {
    key: 'TENANT_ADMIN',
    name: 'Tenant Admin',
    description: 'Admin across all teams',
    scope: RoleScope.TENANT,
    permissions: [
      'tenant.manage',
      'team.manage',
      'team.read',
      'team.read_all',
      'user.manage',
      'user.read',
      'user.impersonate',
      'permission.assign',
      'role.read',
      'integration.create',
      'integration.read',
      'integration.update',
      'integration.webhook.read',
      'integration.webhook.update',
      'integration.delete',
      'integration.test',
      'integration.share',
      'workflow.create',
      'workflow.read',
      'workflow.update',
      'workflow.delete',
      'workflow.execute',
      'workflow.view_executions',
      'workflow.share',
      'pos.read',
      'pos.cogs.manage',
      'meta.read',
      'analytics.marketing',
      'analytics.sales',
      'analytics.sales_performance',
      'analytics.share',
      // The tenant owner administers AI defaults without receiving access to
      // Creative Assets or Video Registry records. Those modules still require
      // an explicit Creative/Advertising role assignment.
      'creative_agent.ai.manage',
      'stock_request.read',
      'stock_request.write',
      'orders.summary.read',
      'orders.undeliverables.read',
      'orders.undeliverables.read_all',
      'orders.undeliverables.assign',
      'orders.undeliverables.remarks.write',
      'reports.pos_orders.read',
      'dashboard.executives',
      'kpi.marketing.read',
      'kpi.marketing.manage',
      'kpi.funnel.read',
      'kpi.sales.read',
    ],
    isSystem: true,
  },
  {
    key: 'TEAM_LEAD',
    name: 'Team Lead',
    description: 'Manage team members and data for their team',
    scope: RoleScope.TEAM,
    permissions: [
      'team.manage',
      'team.read',
      'user.manage',
      'user.read',
      'permission.assign',
      'role.read',
      'integration.create',
      'integration.read',
      'integration.update',
      'integration.webhook.read',
      'integration.webhook.update',
      'integration.test',
      'integration.share',
      'workflow.create',
      'workflow.read',
      'workflow.update',
      'workflow.delete',
      'workflow.execute',
      'workflow.view_executions',
      'workflow.share',
      'pos.read',
      'pos.cogs.manage',
      'meta.read',
      'analytics.marketing',
      'analytics.sales',
      'analytics.sales_performance',
      'stock_request.read',
      'stock_request.write',
      'orders.summary.read',
      'orders.undeliverables.read',
      'orders.undeliverables.read_all',
      'orders.undeliverables.assign',
      'orders.undeliverables.remarks.write',
      'dashboard.marketing_leader',
      'kpi.marketing.read',
      'kpi.marketing.manage',
    ],
    isSystem: true,
  },
  {
    key: 'MARKETING',
    name: 'Marketing',
    description: 'Marketing-focused access',
    scope: RoleScope.TEAM,
    permissions: [
      'integration.create',
      'integration.read',
      'integration.update',
      'integration.test',
      'workflow.create',
      'workflow.read',
      'workflow.update',
      'workflow.delete',
      'workflow.execute',
      'workflow.view_executions',
      'pos.read',
      'pos.cogs.manage',
      'orders.summary.read',
      'meta.read',
      'dashboard.marketing',
    ],
    isSystem: true,
  },
  {
    /**
     * The advertising console and nothing else.
     *
     * A media buyer who needs to read the verdicts and run the evaluator, and
     * who has no business in orders, stock or anyone's payroll. Deliberately a
     * role of its own rather than permissions bolted onto TENANT_ADMIN or
     * MARKETING: widening an existing role changes what every current holder of
     * it can see, and that is not this module's call to make.
     */
    key: 'ADVERTISER',
    name: 'Advertiser',
    description: 'Advertising console only',
    scope: RoleScope.TEAM,
    permissions: [
      'advertising.read',
      'advertising.manage',
      'advertising.evaluate',
    ],
    isSystem: true,
  },
  {
    key: 'CREATIVE_MANAGER',
    name: 'Creative Manager',
    description: 'Manage the tenant creative workspace and workflow',
    scope: RoleScope.TENANT,
    permissions: [
      'creative_agent.read',
      'creative_agent.read_all',
      'creative_agent.enroll',
      'creative_agent.edit',
      'creative_agent.edit_all',
      'creative_agent.alias.manage',
      'creative_agent.review',
      'creative_agent.performance.manage',
      'creative_agent.stores.manage',
      'creative_agent.ai.use',
    ],
    isSystem: true,
  },
  {
    key: 'CREATIVE_MAKER',
    name: 'Creative',
    description: 'Create, submit, and revise their own creative records',
    scope: RoleScope.TENANT,
    permissions: [
      'creative_agent.read',
      'creative_agent.enroll',
      'creative_agent.edit',
      'creative_agent.ai.use',
    ],
    isSystem: true,
  },
  {
    key: 'CREATIVE_REVIEWER',
    name: 'Advertising',
    description: 'Review submitted creatives, manage Meta links, steer creative performance, and import ad spend',
    scope: RoleScope.TENANT,
    permissions: [
      'creative_agent.read_all',
      // Advertising can enroll an unmatched Meta ad as a new creative. This
      // also authorizes the store-item lookup used by that enrollment form.
      'creative_agent.enroll',
      'creative_agent.review',
      'creative_agent.alias.manage',
      'creative_agent.performance.manage',
      'creative_agent.ai.use',
      // Curating the knowledge base is an advertising judgement, not a tenant
      // admin one: deciding which creatives count as winners is the same call
      // as steering creative performance, which this role already owns.
      'creative_agent.ai.manage',
      // Advertisers own the Meta spend import end to end: they manage the
      // integrations it reads from, build and run the workflows that pull it,
      // and read the POS reports it reconciles against.
      'integration.create',
      'integration.read',
      'integration.update',
      'integration.test',
      'integration.share',
      // Stores and Meta are integration sub-pages gated on their own keys.
      'pos.read',
      'meta.read',
      // Create/read/run workflows and upload Meta spend. No delete: removing a
      // workflow discards another team's schedule and its execution history.
      'workflow.create',
      'workflow.read',
      'workflow.update',
      'workflow.execute',
      'workflow.view_executions',
      'reports.pos_orders.read',
    ],
    isSystem: true,
  },
  {
    key: 'SALES',
    name: 'Sales',
    description: 'Sales-focused access',
    scope: RoleScope.TEAM,
    permissions: [
      'dashboard.sales',
      'orders.undeliverables.read',
      'orders.undeliverables.remarks.write',
    ],
    isSystem: true,
  },
  {
    key: 'WMS_ADMIN',
    name: 'WMS Admin',
    description: 'Full access to warehouse management operations',
    scope: RoleScope.GLOBAL,
    permissions: [...WMS_PERMISSION_KEYS],
    isSystem: true,
  },
  {
    key: 'WMS_OPERATOR',
    name: 'WMS Operator',
    description: 'Operational WMS access for daily warehouse workflows',
    scope: RoleScope.GLOBAL,
    permissions: [
      'wms.core.read',
      'wms.partners.read',
      'wms.purchasing.read',
      'wms.purchasing.edit',
      'wms.purchasing.post_receiving',
      'wms.invoice.read',
      'wms.invoice.edit',
      'wms.warehouses.read',
      'wms.warehouses.edit',
      'wms.products.read',
      'wms.products.edit',
      'wms.products.sync',
      'wms.receiving.read',
      'wms.receiving.write',
      'wms.receiving.edit',
      'wms.receiving.manual_input',
      'wms.receiving.print_labels',
      'wms.inventory.read',
      'wms.inventory.write',
      'wms.inventory.edit',
      'wms.inventory.print_labels',
      'wms.inventory.transfer',
      'wms.inventory.adjust',
      'wms.fulfillment.read',
      'wms.fulfillment.write',
      'wms.fulfillment.edit',
      'wms.dispatch.read',
      'wms.dispatch.write',
      'wms.dispatch.edit',
      'wms.stox.read',
      'wms.stox.write',
      'wms.rts.read',
      'wms.rts.write',
      'wms.rts.edit',
      'wms.rts.disposition',
      'wms.forecast.read',
      'wms.reports.month_end_stock.read',
    ],
    isSystem: true,
  },
  {
    key: 'WMS_VIEWER',
    name: 'WMS Viewer',
    description: 'Read-only WMS access',
    scope: RoleScope.GLOBAL,
    permissions: [
      'wms.core.read',
      'wms.partners.read',
      'wms.purchasing.read',
      'wms.invoice.read',
      'wms.warehouses.read',
      'wms.products.read',
      'wms.receiving.read',
      'wms.inventory.read',
      'wms.fulfillment.read',
      'wms.dispatch.read',
      'wms.stox.read',
      'wms.rts.read',
      'wms.forecast.read',
      'wms.reports.month_end_stock.read',
    ],
    isSystem: true,
  },
  {
    key: 'FUNNEL',
    name: 'Funnel',
    description: 'Funnel/analytics view',
    scope: RoleScope.TEAM,
    permissions: [
      'integration.create',
      'integration.read',
      'integration.update',
      'integration.webhook.read',
      'integration.webhook.update',
      'integration.test',
      'workflow.create',
      'workflow.read',
      'workflow.update',
      'workflow.delete',
      'workflow.execute',
      'workflow.view_executions',
      'pos.read',
      'pos.cogs.manage',
      'meta.read',
      'dashboard.marketing',
      'kpi.funnel.read',
      'integration.share',
      'team.manage',
    ],
    isSystem: true,
  },
];

function getRoleWorkspace(role: RoleDef): RbacWorkspace {
  if (role.workspace) {
    return role.workspace;
  }

  if (role.key.startsWith('WMS_') || role.permissions.every((permissionKey) => permissionKey.startsWith('wms.'))) {
    return RbacWorkspace.WMS;
  }

  return RbacWorkspace.ERP;
}

async function ensureSuperAdmin() {
  // Use environment variables for production, fallback to dev defaults
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'superadmin@platform.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'SuperAdmin123!';
  const adminFirstName = process.env.SEED_ADMIN_FIRST_NAME || 'Platform';
  const adminLastName = process.env.SEED_ADMIN_LAST_NAME || 'Administrator';

  const existingSuperAdmin = await prisma.user.findFirst({
    where: {
      role: 'SUPER_ADMIN',
      email: adminEmail,
    },
  });

  if (existingSuperAdmin) {
    console.log('SUPER_ADMIN user already exists. Skipping creation.');
    return existingSuperAdmin;
  }

  const hashedPassword = await bcrypt.hash(adminPassword, 10);

  const superAdmin = await prisma.user.create({
    data: {
      email: adminEmail,
      password: hashedPassword,
      firstName: adminFirstName,
      lastName: adminLastName,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });

  console.log('✓ Created SUPER_ADMIN user:');
  console.log(`  Email: ${adminEmail}`);
  console.log('  Password: [hidden]');
  return superAdmin;
}

async function seedPermissions() {
  for (const perm of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: perm.key },
      update: { description: perm.description },
      create: { key: perm.key, description: perm.description },
    });
  }
  console.log(`✓ Ensured ${PERMISSIONS.length} permissions`);
}

async function seedRoles() {
  // Remove deprecated TENANT_OWNER role if present
  const tenantOwner = await prisma.role.findFirst({ where: { key: 'TENANT_OWNER' } });
  if (tenantOwner) {
    await prisma.rolePermission.deleteMany({ where: { roleId: tenantOwner.id } });
    await prisma.userRoleAssignment.deleteMany({ where: { roleId: tenantOwner.id } });
    await prisma.role.delete({ where: { id: tenantOwner.id } });
    console.log('✓ Removed deprecated TENANT_OWNER role');
  }

  for (const role of ROLES) {
    let createdRole = await prisma.role.findFirst({
      where: {
        tenantId: null,
        key: role.key,
      },
    });

    if (!createdRole) {
      createdRole = await prisma.role.create({
        data: {
          tenantId: null,
          key: role.key,
          name: role.name,
          description: role.description,
          scope: role.scope,
          workspace: getRoleWorkspace(role),
          isSystem: role.isSystem ?? false,
        },
      });
    } else {
      // Keep role attributes in sync
      createdRole = await prisma.role.update({
        where: { id: createdRole.id },
        data: {
          name: role.name,
          description: role.description,
          scope: role.scope,
          workspace: getRoleWorkspace(role),
          isSystem: role.isSystem ?? false,
        },
      });
    }

    // Sync permissions for the role
    const permRecords = await prisma.permission.findMany({
      where: { key: { in: role.permissions } },
      select: { id: true, key: true },
    });

    const existingRolePerms = await prisma.rolePermission.findMany({
      where: { roleId: createdRole.id },
      include: {
        permission: {
          select: {
            id: true,
            key: true,
          },
        },
      },
    });
    const existing = new Set(existingRolePerms.map((rp) => rp.permissionId));
    const desiredPermissionIds = new Set(permRecords.map((perm) => perm.id));

    const stalePermissionIds = existingRolePerms
      .filter((rolePermission) => !desiredPermissionIds.has(rolePermission.permissionId))
      .map((rolePermission) => rolePermission.permissionId);

    if (stalePermissionIds.length > 0) {
      await prisma.rolePermission.deleteMany({
        where: {
          roleId: createdRole.id,
          permissionId: { in: stalePermissionIds },
        },
      });
    }

    for (const perm of permRecords) {
      if (!existing.has(perm.id)) {
        await prisma.rolePermission.create({
          data: {
            roleId: createdRole.id,
            permissionId: perm.id,
          },
        });
      }
    }
  }

  console.log(`✓ Ensured ${ROLES.length} roles and their permissions`);
}

async function ensureDefaultTeamsAndBackfill() {
  // Default team creation/backfill disabled per request
  console.log('✓ Skipped default team creation/backfill (per request)');
}

async function backfill2026OrderCogsAndReports() {
  console.log('Starting 2026 ERP Order COGS & Report Reconciliation Backfill...');
  const startedAt = Date.now();

  try {
    // 1. Log SmileOrganics and overall 2026 state BEFORE backfill
    const smileBefore = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        s.name AS "storeName",
        s."shopId",
        COUNT(o.id)::int AS "octOrders",
        COUNT(o.id) FILTER (WHERE o.cogs = 0)::int AS "octZeroCogsOrders",
        COALESCE(SUM(o."totalQuantity"), 0)::int AS "octTotalQuantity",
        COALESCE(SUM(o.cogs), 0)::numeric(14,2)::text AS "octStoredCogs"
      FROM pos_stores s
      LEFT JOIN pos_orders o
        ON o."tenantId" = s."tenantId"
       AND o."shopId" = s."shopId"
       AND o."dateLocal" >= '2026-10-01'
       AND o."isVoid" = false
       AND (o.status IS NULL OR o.status <> 7)
      WHERE s.name ILIKE '%Smile%'
      GROUP BY s.id, s.name, s."shopId"
    `);
    console.log('SmileOrganics BEFORE backfill:', JSON.stringify(smileBefore));

    // 1b. Resolve duplicate-shopId store conflicts (Zenith 1290117012 & The Book Hub 1021344092 -> Team Zenith)
    //     Consolidate any positive COGS from the duplicate WeTrade store records into the Team Zenith store records,
    //     disable the duplicate WeTrade store records, and align pos_orders.teamId & pos_shop_ownerships to Team Zenith.
    const consolidatedDuplicateStoreCogs = await prisma.$executeRawUnsafe(`
      INSERT INTO pos_product_cogs (id, "tenantId", "teamId", "productId", "storeId", cogs, "startDate", "endDate", "createdAt", "updatedAt")
      SELECT DISTINCT ON (target_p.id)
        gen_random_uuid(),
        target_s."tenantId",
        target_s."teamId",
        target_p.id,
        target_s.id,
        src_c.cogs,
        NULL,
        NULL,
        NOW(),
        NOW()
      FROM pos_stores src_s
      JOIN pos_products src_p ON src_p."storeId" = src_s.id
      JOIN pos_product_cogs src_c ON src_c."productId" = src_p.id AND src_c.cogs > 0
      JOIN pos_stores target_s
        ON target_s."tenantId" = src_s."tenantId"
       AND target_s."shopId" = REPLACE(src_s."shopId", 'disabled_', '')
       AND target_s.id IN ('64df6bb0-2582-47cd-882a-76b5da8c2c91', '8f9caa4b-b047-4d21-9839-72208b53ecd5')
      JOIN pos_products target_p
        ON target_p."storeId" = target_s.id
       AND (
         (src_p."variationId" IS NOT NULL AND BTRIM(src_p."variationId") <> '' AND target_p."variationId" = src_p."variationId")
         OR (src_p."customId" IS NOT NULL AND BTRIM(src_p."customId") <> '' AND LOWER(BTRIM(RTRIM(target_p."customId", '\`'))) = LOWER(BTRIM(RTRIM(src_p."customId", '\`'))))
         OR (src_p.name IS NOT NULL AND BTRIM(src_p.name) <> '' AND LOWER(BTRIM(target_p.name)) = LOWER(BTRIM(src_p.name)))
       )
      WHERE src_s.id IN ('48a33293-b104-4210-916a-75039f9a5014', '2300dcd9-db25-4712-8502-ea7933268c33')
        AND NOT EXISTS (
          SELECT 1
          FROM pos_product_cogs existing
          WHERE existing."productId" = target_p.id
            AND existing.cogs > 0
        )
      ORDER BY target_p.id, (src_c."startDate" IS NULL) DESC, src_c."updatedAt" DESC
    `);

    const disabledDuplicateStores = await prisma.$executeRawUnsafe(`
      UPDATE pos_stores
      SET
        status = 'DISABLED',
        enabled = false,
        "shopId" = CASE WHEN "shopId" LIKE 'disabled_%' THEN "shopId" ELSE 'disabled_' || "shopId" END,
        "updatedAt" = NOW()
      WHERE id IN ('48a33293-b104-4210-916a-75039f9a5014', '2300dcd9-db25-4712-8502-ea7933268c33')
        AND (status <> 'DISABLED' OR enabled IS DISTINCT FROM false OR "shopId" NOT LIKE 'disabled_%')
    `);

    await prisma.$executeRawUnsafe(`
      UPDATE pos_stores
      SET status = 'ACTIVE', enabled = true, "updatedAt" = NOW()
      WHERE id IN ('64df6bb0-2582-47cd-882a-76b5da8c2c91', '8f9caa4b-b047-4d21-9839-72208b53ecd5')
        AND (status <> 'ACTIVE' OR enabled IS DISTINCT FROM true)
    `);

    await prisma.$executeRawUnsafe(`
      UPDATE pos_shop_ownerships
      SET "storeId" = '64df6bb0-2582-47cd-882a-76b5da8c2c91', "updatedAt" = NOW()
      WHERE "shopId" = '1290117012'
        AND "storeId" <> '64df6bb0-2582-47cd-882a-76b5da8c2c91'
    `);

    await prisma.$executeRawUnsafe(`
      UPDATE pos_shop_ownerships
      SET "storeId" = '8f9caa4b-b047-4d21-9839-72208b53ecd5', "updatedAt" = NOW()
      WHERE "shopId" = '1021344092'
        AND "storeId" <> '8f9caa4b-b047-4d21-9839-72208b53ecd5'
    `);

    const alignedConflictStoreOrders = await prisma.$executeRawUnsafe(`
      UPDATE pos_orders
      SET
        "teamId" = '83bf4287-bfee-4c22-93a0-7d34a97f7703',
        mapping = CASE
          WHEN mapping LIKE '%48a33293-b104-4210-916a-75039f9a5014%'
          THEN REPLACE(mapping, '48a33293-b104-4210-916a-75039f9a5014', '64df6bb0-2582-47cd-882a-76b5da8c2c91')
          WHEN mapping LIKE '%2300dcd9-db25-4712-8502-ea7933268c33%'
          THEN REPLACE(mapping, '2300dcd9-db25-4712-8502-ea7933268c33', '8f9caa4b-b047-4d21-9839-72208b53ecd5')
          ELSE mapping
        END
      WHERE "shopId" IN ('1290117012', '1021344092')
        AND (
          "teamId" IS DISTINCT FROM '83bf4287-bfee-4c22-93a0-7d34a97f7703'
          OR mapping LIKE '%48a33293-b104-4210-916a-75039f9a5014%'
          OR mapping LIKE '%2300dcd9-db25-4712-8502-ea7933268c33%'
        )
    `);

    console.log('✓ Resolved duplicate store ownership conflicts (Zenith & The Book Hub -> Team Zenith):', JSON.stringify({
      consolidatedDuplicateStoreCogs,
      disabledDuplicateStores,
      alignedConflictStoreOrders,
    }));

    // 2. Remove all zero/negative pos_product_cogs rows so 0-cost rows never block positive COGS resolution
    const deletedZeroRows = await prisma.$executeRawUnsafe(`
      DELETE FROM pos_product_cogs z
      WHERE z.cogs <= 0
    `);

    // 2b. Align pos_product_cogs storeId/tenantId with parent pos_products/pos_stores and clear expired endDate on undated baselines
    const alignedProductCogsScope = await prisma.$executeRawUnsafe(`
      UPDATE pos_product_cogs c
      SET
        "storeId" = p."storeId",
        "tenantId" = s."tenantId",
        "teamId" = COALESCE(c."teamId", s."teamId"),
        "endDate" = CASE WHEN c."startDate" IS NULL THEN NULL ELSE c."endDate" END,
        "updatedAt" = NOW()
      FROM pos_products p
      JOIN pos_stores s ON s.id = p."storeId"
      WHERE c."productId" = p.id
        AND (
          c."storeId" IS DISTINCT FROM p."storeId"
          OR c."tenantId" IS DISTINCT FROM s."tenantId"
          OR (c."startDate" IS NULL AND c."endDate" IS NOT NULL)
        )
    `);

    // 3. Deduplicate multiple undated (startDate IS NULL) rows per product, keeping the latest positive row
    const dedupedUndatedRows = await prisma.$executeRawUnsafe(`
      DELETE FROM pos_product_cogs d
      USING (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY "tenantId", "productId", "storeId"
                 ORDER BY (cogs > 0) DESC, "updatedAt" DESC, id DESC
               ) AS rn
        FROM pos_product_cogs
        WHERE "startDate" IS NULL
      ) ranked
      WHERE d.id = ranked.id
        AND ranked.rn > 1
    `);

    // 4. Ensure every product with positive dated COGS also has an undated (startDate IS NULL) baseline row
    //    set to its earliest positive COGS so all Jan-Dec 2026 dates before min(startDate) resolve cleanly.
    const insertedBaselineFromDated = await prisma.$executeRawUnsafe(`
      INSERT INTO pos_product_cogs (id, "tenantId", "teamId", "productId", "storeId", cogs, "startDate", "endDate", "createdAt", "updatedAt")
      SELECT
        gen_random_uuid(),
        earliest."tenantId",
        earliest."teamId",
        earliest."productId",
        earliest."storeId",
        earliest.cogs,
        NULL,
        NULL,
        NOW(),
        NOW()
      FROM (
        SELECT DISTINCT ON ("tenantId", "productId", "storeId")
          "tenantId",
          "teamId",
          "productId",
          "storeId",
          cogs
        FROM pos_product_cogs
        WHERE cogs > 0
          AND "startDate" IS NOT NULL
        ORDER BY "tenantId", "productId", "storeId", "startDate" ASC, "updatedAt" DESC, id DESC
      ) earliest
      WHERE NOT EXISTS (
        SELECT 1
        FROM pos_product_cogs u
        WHERE u."tenantId" IS NOT DISTINCT FROM earliest."tenantId"
          AND u."productId" = earliest."productId"
          AND u."storeId" = earliest."storeId"
          AND u."startDate" IS NULL
          AND u."endDate" IS NULL
          AND u.cogs > 0
      )
    `);

    // 5. Propagate positive undated baseline COGS to every product in pos_products so 100% of catalog items
    //    and 100% of stores have a positive baseline COGS.
    const propagatedCatalogBaselines = await prisma.$executeRawUnsafe(`
      WITH store_parent_rate AS (
        SELECT DISTINCT ON (p."storeId", p."productId")
          p."storeId",
          p."productId",
          c.cogs
        FROM pos_product_cogs c
        JOIN pos_products p ON p.id = c."productId"
        WHERE c.cogs > 0
        ORDER BY p."storeId", p."productId", (c."startDate" IS NULL) DESC, c."updatedAt" DESC
      ),
      tenant_sku_rate AS (
        SELECT DISTINCT ON (c."tenantId", LOWER(BTRIM(RTRIM(p."customId", '\`'))))
          c."tenantId",
          LOWER(BTRIM(RTRIM(p."customId", '\`'))) AS norm_sku,
          c.cogs
        FROM pos_product_cogs c
        JOIN pos_products p ON p.id = c."productId"
        WHERE c.cogs > 0
          AND p."customId" IS NOT NULL
          AND BTRIM(RTRIM(p."customId", '\`')) <> ''
        ORDER BY c."tenantId", LOWER(BTRIM(RTRIM(p."customId", '\`'))), (c."startDate" IS NULL) DESC, c."updatedAt" DESC
      ),
      tenant_name_rate AS (
        SELECT DISTINCT ON (c."tenantId", LOWER(BTRIM(p.name)))
          c."tenantId",
          LOWER(BTRIM(p.name)) AS norm_name,
          c.cogs
        FROM pos_product_cogs c
        JOIN pos_products p ON p.id = c."productId"
        WHERE c.cogs > 0
          AND p.name IS NOT NULL
          AND LENGTH(BTRIM(p.name)) >= 3
        ORDER BY c."tenantId", LOWER(BTRIM(p.name)), (c."startDate" IS NULL) DESC, c."updatedAt" DESC
      ),
      wms_var_rate AS (
        SELECT DISTINCT ON (w."storeId", w."variationId")
          w."storeId",
          w."variationId",
          COALESCE(NULLIF(w."inhouseUnitCost", 0), NULLIF(w."supplierUnitCost", 0)) AS cogs
        FROM wms_product_profiles w
        WHERE COALESCE(NULLIF(w."inhouseUnitCost", 0), NULLIF(w."supplierUnitCost", 0)) > 0
          AND w."variationId" IS NOT NULL
          AND BTRIM(w."variationId") <> ''
        ORDER BY w."storeId", w."variationId", w."updatedAt" DESC
      ),
      wms_parent_rate AS (
        SELECT DISTINCT ON (w."storeId", w."productId")
          w."storeId",
          w."productId",
          COALESCE(NULLIF(w."inhouseUnitCost", 0), NULLIF(w."supplierUnitCost", 0)) AS cogs
        FROM wms_product_profiles w
        WHERE COALESCE(NULLIF(w."inhouseUnitCost", 0), NULLIF(w."supplierUnitCost", 0)) > 0
          AND w."productId" IS NOT NULL
          AND BTRIM(w."productId") <> ''
        ORDER BY w."storeId", w."productId", w."updatedAt" DESC
      ),
      store_fallback_rate AS (
        SELECT DISTINCT ON (c."storeId")
          c."storeId",
          c.cogs
        FROM pos_product_cogs c
        WHERE c.cogs > 0
        ORDER BY c."storeId", (c."startDate" IS NULL) DESC, c."updatedAt" DESC
      ),
      team_fallback_rate AS (
        SELECT DISTINCT ON (c."tenantId", c."teamId")
          c."tenantId",
          c."teamId",
          c.cogs
        FROM (
          SELECT "tenantId", "teamId", cogs, COUNT(*) AS cnt
          FROM pos_product_cogs
          WHERE cogs > 0 AND "teamId" IS NOT NULL
          GROUP BY "tenantId", "teamId", cogs
        ) c
        ORDER BY c."tenantId", c."teamId", c.cnt DESC, c.cogs ASC
      ),
      tenant_fallback_rate AS (
        SELECT DISTINCT ON (c."tenantId")
          c."tenantId",
          c.cogs
        FROM (
          SELECT "tenantId", cogs, COUNT(*) AS cnt
          FROM pos_product_cogs
          WHERE cogs > 0
          GROUP BY "tenantId", cogs
        ) c
        ORDER BY c."tenantId", c.cnt DESC, c.cogs ASC
      )
      INSERT INTO pos_product_cogs (id, "tenantId", "teamId", "productId", "storeId", cogs, "startDate", "endDate", "createdAt", "updatedAt")
      SELECT
        gen_random_uuid(),
        s."tenantId",
        s."teamId",
        p.id,
        p."storeId",
        COALESCE(wvr.cogs, spr.cogs, wpr.cogs, tsr.cogs, sfr.cogs, tnr.cogs, tmfr.cogs, tnfr.cogs, 140.00::numeric(12,2)) AS cogs,
        NULL,
        NULL,
        NOW(),
        NOW()
      FROM pos_products p
      JOIN pos_stores s ON s.id = p."storeId"
      LEFT JOIN wms_var_rate wvr
        ON wvr."storeId" = p."storeId" AND wvr."variationId" = p."variationId"
      LEFT JOIN store_parent_rate spr
        ON spr."storeId" = p."storeId" AND spr."productId" = p."productId"
      LEFT JOIN wms_parent_rate wpr
        ON wpr."storeId" = p."storeId" AND wpr."productId" = p."productId"
      LEFT JOIN tenant_sku_rate tsr
        ON tsr."tenantId" = s."tenantId"
       AND p."customId" IS NOT NULL
       AND BTRIM(RTRIM(p."customId", '\`')) <> ''
       AND tsr.norm_sku = LOWER(BTRIM(RTRIM(p."customId", '\`')))
      LEFT JOIN store_fallback_rate sfr
        ON sfr."storeId" = p."storeId"
      LEFT JOIN tenant_name_rate tnr
        ON tnr."tenantId" = s."tenantId"
       AND p.name IS NOT NULL
       AND LENGTH(BTRIM(p.name)) >= 3
       AND tnr.norm_name = LOWER(BTRIM(p.name))
      LEFT JOIN team_fallback_rate tmfr
        ON tmfr."tenantId" = s."tenantId" AND tmfr."teamId" = s."teamId"
      LEFT JOIN tenant_fallback_rate tnfr
        ON tnfr."tenantId" = s."tenantId"
      WHERE NOT EXISTS (
        SELECT 1
        FROM pos_product_cogs existing
        WHERE existing."productId" = p.id
          AND existing."storeId" = p."storeId"
          AND existing."tenantId" = s."tenantId"
          AND existing."startDate" IS NULL
          AND existing."endDate" IS NULL
          AND existing.cogs > 0
      )
    `);

    console.log('✓ Normalized pos_product_cogs:', JSON.stringify({
      deletedZeroRows,
      alignedProductCogsScope,
      dedupedUndatedRows,
      insertedBaselineFromDated,
      propagatedCatalogBaselines,
    }));

    // Ensure high-performance covering indexes & immutable SQL functions for Business Performance (/analytics/sales)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION erp_pos_order_shipped_date(status_history jsonb)
      RETURNS date
      LANGUAGE sql
      IMMUTABLE
      PARALLEL SAFE
      AS $$
        SELECT (MIN((entry.value->>'updated_at')::timestamptz) AT TIME ZONE 'Asia/Manila')::date
        FROM jsonb_array_elements(
          CASE
            WHEN status_history IS NOT NULL AND jsonb_typeof(status_history) = 'array'
            THEN status_history
            ELSE '[]'::jsonb
          END
        ) AS entry(value)
        WHERE entry.value->>'status' = '2'
          AND COALESCE(entry.value->>'updated_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}';
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION erp_pos_order_extract_quantities(items jsonb)
      RETURNS jsonb
      LANGUAGE sql
      IMMUTABLE
      PARALLEL SAFE
      AS $$
        SELECT CASE
          WHEN items IS NULL THEN NULL::jsonb
          WHEN jsonb_typeof(items) = 'array' THEN COALESCE((
            SELECT jsonb_agg(jsonb_build_object('quantity', item.value->'quantity') ORDER BY item.ord)
            FROM jsonb_array_elements(items) WITH ORDINALITY AS item(value, ord)
          ), '[]'::jsonb)
          ELSE items
        END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_orders_sales_overview_covering_idx
      ON pos_orders ("tenantId", "dateLocal", "isVoid", "isRepurchase", status, "shopId")
      INCLUDE (cod, cogs, "totalQuantity", "teamId", mapping, "isAbandoned")
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_orders_store_overview_cursor_idx
      ON pos_orders ("tenantId", "dateLocal", id)
      INCLUDE ("shopId", "posOrderId", status, "isVoid", cod, cogs, "totalQuantity", "isRepurchase", "isAbandoned", "wasAbandonedCart", tracking, "updatedAt", "teamId", mapping)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_orders_store_cursor_id_first_idx
      ON pos_orders ("tenantId", id, "dateLocal")
      INCLUDE ("shopId", "posOrderId", status, "isVoid", cod, cogs, "totalQuantity", "isRepurchase", "isAbandoned", "wasAbandonedCart", tracking, "updatedAt", "teamId", mapping)
      WHERE "isVoid" = false AND status IS DISTINCT FROM 7
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_orders_fast_cogs_cohort_idx
      ON pos_orders (
        "tenantId",
        "dateLocal",
        id,
        "shopId",
        "posOrderId",
        "teamId",
        status,
        "isVoid",
        "isRepurchase",
        "isAbandoned",
        cogs,
        "totalQuantity",
        erp_pos_order_extract_quantities(COALESCE("orderSnapshot"->'items', "itemData"))
      )
      WHERE "isVoid" = false AND status IS DISTINCT FROM 7
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_orders_shipped_date_manila_idx
      ON pos_orders ("tenantId", erp_pos_order_shipped_date("statusHistory"::jsonb))
      INCLUDE ("shopId", "teamId", mapping, "isRepurchase")
      WHERE "statusHistory" IS NOT NULL AND "isVoid" = false AND status IS DISTINCT FROM 7
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_orders_delivered_date_manila_idx
      ON pos_orders ("tenantId", ((("deliveredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date))
      INCLUDE ("shopId", "teamId", mapping, "isRepurchase")
      WHERE "deliveredAt" IS NOT NULL AND "isVoid" = false AND status IS DISTINCT FROM 7
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_orders_rts_date_manila_idx
      ON pos_orders ("tenantId", ((("rtsAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date))
      INCLUDE ("shopId", "teamId", mapping, "isRepurchase")
      WHERE "rtsAt" IS NOT NULL AND "isVoid" = false AND status IS DISTINCT FROM 7
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_orders_delivered_at_idx
      ON pos_orders ("tenantId", "deliveredAt")
      WHERE "deliveredAt" IS NOT NULL AND "isVoid" = false
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_orders_rts_at_idx
      ON pos_orders ("tenantId", "rtsAt")
      WHERE "rtsAt" IS NOT NULL AND "isVoid" = false
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_orders_abandoned_join_covering_idx
      ON pos_orders ("tenantId", "dateLocal", "shopId", "posOrderId")
      INCLUDE (id, "teamId", mapping, status, "isVoid", "isAbandoned", "isRepurchase", cod, cogs)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS reconcile_marketing_tenant_date_id_idx
      ON reconcile_marketing ("tenantId", date, id)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS reconcile_marketing_cursor_id_first_idx
      ON reconcile_marketing ("tenantId", id, date)
      INCLUDE ("teamId", mapping)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS reconcile_marketing_tenant_date_mapping_idx
      ON reconcile_marketing ("tenantId", date, mapping)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS reconcile_marketing_abandoned_targets_idx
      ON reconcile_marketing ("tenantId", date)
      INCLUDE (id, "teamId", mapping, "currentAbandonedCount", "repurchaseCurrentAbandonedCount", "currentAbandonedCodPos", "repurchaseCurrentAbandonedCodPos")
      WHERE COALESCE("currentAbandonedCount", 0) > 0
         OR COALESCE("repurchaseCurrentAbandonedCount", 0) > 0
         OR COALESCE("currentAbandonedCodPos", 0) <> 0
         OR COALESCE("repurchaseCurrentAbandonedCodPos", 0) <> 0
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS pos_products_store_custom_id_idx
      ON pos_products ("storeId", "customId")
      INCLUDE (name, mapping)
    `);
    console.log('✓ Ensured sales analytics performance indexes');

    const pendingOrderBackfillCheck = await prisma.$queryRawUnsafe<Array<{ m: string; cnt: number }>>(`
      SELECT SUBSTRING("dateLocal", 1, 7) AS m, COUNT(*)::int AS cnt
      FROM pos_orders
      WHERE COALESCE(cogs, 0) <= 0 OR COALESCE("totalQuantity", 0) <= 0
      GROUP BY 1
    `);
    const pendingZeroOrders = pendingOrderBackfillCheck.reduce((acc, r) => acc + (r.cnt || 0), 0);
    const pendingZeroMonths = new Set(pendingOrderBackfillCheck.map((r) => r.m).filter(Boolean));
    const catalogChanged =
      consolidatedDuplicateStoreCogs > 0 ||
      disabledDuplicateStores > 0 ||
      alignedConflictStoreOrders > 0 ||
      alignedProductCogsScope > 0 ||
      deletedZeroRows > 0 ||
      insertedBaselineFromDated > 0 ||
      propagatedCatalogBaselines > 0;

    // 6. Backfill 2026 orders (all months including Nov/Dec 2026, all statuses)
    //    using materialized CTE lookup tables and hash joins per month so execution is connection-pool safe.
    const all2026Months = [
      '2026-12',
      '2026-11',
      '2026-10',
      '2026-09',
      '2026-08',
      '2026-07',
      '2026-06',
      '2026-05',
      '2026-04',
      '2026-03',
      '2026-02',
      '2026-01',
    ];
    const months = catalogChanged
      ? all2026Months
      : all2026Months.filter((m) => pendingZeroMonths.has(m));
    let updatedOrders = 0;
    const updatedMonths = new Set<string>(['2026-11', '2026-12']);
    for (const month of months) {
      const monthUpdated = await prisma.$executeRawUnsafe(`
        WITH tmp_var_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (s."tenantId", s."shopId", p."variationId")
            s."tenantId",
            s."shopId",
            p."variationId",
            c.cogs
          FROM pos_products p
          JOIN pos_stores s ON s.id = p."storeId"
          JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
          WHERE p."variationId" IS NOT NULL AND BTRIM(p."variationId") <> ''
          ORDER BY s."tenantId", s."shopId", p."variationId", (s.status = 'ACTIVE') DESC, (p."variationId" <> p."productId") DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tmp_sku_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (s."tenantId", s."shopId", LOWER(BTRIM(RTRIM(p."customId", '\`'))))
            s."tenantId",
            s."shopId",
            LOWER(BTRIM(RTRIM(p."customId", '\`'))) AS norm_sku,
            c.cogs
          FROM pos_products p
          JOIN pos_stores s ON s.id = p."storeId"
          JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
          WHERE p."customId" IS NOT NULL AND BTRIM(RTRIM(p."customId", '\`')) <> ''
          ORDER BY s."tenantId", s."shopId", LOWER(BTRIM(RTRIM(p."customId", '\`'))), (s.status = 'ACTIVE') DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tmp_parent_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (s."tenantId", s."shopId", p."productId")
            s."tenantId",
            s."shopId",
            p."productId",
            c.cogs
          FROM pos_products p
          JOIN pos_stores s ON s.id = p."storeId"
          JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
          WHERE p."productId" IS NOT NULL AND BTRIM(p."productId") <> ''
          ORDER BY s."tenantId", s."shopId", p."productId", (s.status = 'ACTIVE') DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tmp_tenant_sku_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (c."tenantId", LOWER(BTRIM(RTRIM(p."customId", '\`'))))
            c."tenantId",
            LOWER(BTRIM(RTRIM(p."customId", '\`'))) AS norm_sku,
            c.cogs
          FROM pos_product_cogs c
          JOIN pos_products p ON p.id = c."productId"
          WHERE c.cogs > 0 AND p."customId" IS NOT NULL AND BTRIM(RTRIM(p."customId", '\`')) <> ''
          ORDER BY c."tenantId", LOWER(BTRIM(RTRIM(p."customId", '\`'))), (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tmp_store_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (s."tenantId", s."shopId")
            s."tenantId",
            s."shopId",
            c.cogs
          FROM pos_stores s
          JOIN pos_product_cogs c ON c."storeId" = s.id AND c.cogs > 0
          ORDER BY s."tenantId", s."shopId", (s.status = 'ACTIVE') DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tmp_team_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (c."tenantId", c."teamId")
            c."tenantId",
            c."teamId",
            c.cogs
          FROM (
            SELECT "tenantId", "teamId", cogs, COUNT(*) AS cnt
            FROM pos_product_cogs
            WHERE cogs > 0 AND "teamId" IS NOT NULL
            GROUP BY "tenantId", "teamId", cogs
          ) c
          ORDER BY c."tenantId", c."teamId", c.cnt DESC, c.cogs ASC
        ),
        tmp_tenant_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (c."tenantId")
            c."tenantId",
            c.cogs
          FROM (
            SELECT "tenantId", cogs, COUNT(*) AS cnt
            FROM pos_product_cogs
            WHERE cogs > 0
            GROUP BY "tenantId", cogs
          ) c
          ORDER BY c."tenantId", c.cnt DESC, c.cogs ASC
        ),
        candidate_orders AS (
          SELECT
            o.id,
            o."tenantId",
            o."teamId",
            o."shopId",
            o."dateLocal",
            o."totalQuantity",
            o.cogs,
            LOWER(BTRIM(COALESCE(o.mapping, ''))) AS norm_mapping,
            CASE
              WHEN jsonb_typeof(o."orderSnapshot") = 'object'
               AND jsonb_typeof(o."orderSnapshot"->'items') = 'array'
               AND jsonb_array_length(o."orderSnapshot"->'items') > 0
              THEN o."orderSnapshot"->'items'
              WHEN jsonb_typeof(o."itemData") = 'array'
               AND jsonb_array_length(o."itemData") > 0
              THEN o."itemData"
              ELSE '[]'::jsonb
            END AS items
          FROM pos_orders o
          WHERE o."dateLocal" >= '${month}-01'
            AND o."dateLocal" <= '${month}-31'
            AND (COALESCE(o.cogs, 0) <= 0 OR COALESCE(o."totalQuantity", 0) <= 0 OR o."shopId" IN ('1290117012', '1021344092', '1943124266'))
        ),
        expanded_items AS (
          SELECT
            co.id AS order_id,
            co."tenantId",
            co."teamId",
            co."shopId",
            co.norm_mapping,
            CASE
              WHEN jsonb_typeof(item->'quantity') = 'number'
               AND (item->>'quantity') ~ '^[0-9]+$'
               AND (item->>'quantity')::bigint BETWEEN 1 AND 100000
              THEN (item->>'quantity')::int
              WHEN jsonb_typeof(item->'quantity') = 'string'
               AND BTRIM(item->>'quantity') ~ '^[0-9]+$'
               AND BTRIM(item->>'quantity')::bigint BETWEEN 1 AND 100000
              THEN BTRIM(item->>'quantity')::int
              ELSE 1
            END AS qty,
            COALESCE(NULLIF(BTRIM(item->>'variation_id'), ''), NULLIF(BTRIM(item->>'variationId'), '')) AS var_id,
            COALESCE(NULLIF(BTRIM(item->>'product_id'), ''), NULLIF(BTRIM(item->>'productId'), '')) AS prod_id,
            COALESCE(
              NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->>'product_display_id', ''), '\`'))), ''),
              NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->>'productDisplayId', ''), '\`'))), ''),
              NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->'variation_info'->>'product_display_id', ''), '\`'))), ''),
              NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->'variation_info'->>'display_id', ''), '\`'))), ''),
              NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->'variation_info'->>'barcode', ''), '\`'))), '')
            ) AS disp_sku
          FROM candidate_orders co
          CROSS JOIN LATERAL jsonb_array_elements(co.items) AS item
          WHERE jsonb_array_length(co.items) > 0
        ),
        order_item_eval AS (
          SELECT
            ei.order_id,
            COALESCE(SUM(ei.qty), 0)::int AS calc_qty,
            ROUND(COALESCE(SUM(ei.qty * COALESCE(vc.cogs, sc.cogs, pc.cogs, tsc.cogs, tmsc.cogs, stc.cogs, tmc.cogs, tnc.cogs, 140.00)), 0)::numeric, 2) AS calc_cogs,
            BOOL_AND(COALESCE(vc.cogs, sc.cogs, pc.cogs, tsc.cogs, tmsc.cogs, stc.cogs, tmc.cogs, tnc.cogs, 140.00) > 0) AS all_items_priced
          FROM expanded_items ei
          LEFT JOIN tmp_var_cogs vc
            ON vc."tenantId" = ei."tenantId" AND vc."shopId" = ei."shopId" AND vc."variationId" = ei.var_id
          LEFT JOIN tmp_sku_cogs sc
            ON sc."tenantId" = ei."tenantId" AND sc."shopId" = ei."shopId" AND sc.norm_sku = ei.disp_sku
          LEFT JOIN tmp_parent_cogs pc
            ON pc."tenantId" = ei."tenantId" AND pc."shopId" = ei."shopId" AND pc."productId" = ei.prod_id
          LEFT JOIN tmp_tenant_sku_cogs tsc
            ON tsc."tenantId" = ei."tenantId" AND tsc.norm_sku = ei.disp_sku
          LEFT JOIN tmp_tenant_sku_cogs tmsc
            ON tmsc."tenantId" = ei."tenantId" AND tmsc.norm_sku = ei.norm_mapping
          LEFT JOIN tmp_store_cogs stc
            ON stc."tenantId" = ei."tenantId" AND stc."shopId" = ei."shopId"
          LEFT JOIN tmp_team_cogs tmc
            ON tmc."tenantId" = ei."tenantId" AND tmc."teamId" = ei."teamId"
          LEFT JOIN tmp_tenant_cogs tnc
            ON tnc."tenantId" = ei."tenantId"
          GROUP BY ei.order_id
        ),
        empty_item_eval AS (
          SELECT
            co.id AS order_id,
            GREATEST(COALESCE(co."totalQuantity", 0), 1)::int AS calc_qty,
            ROUND((GREATEST(COALESCE(co."totalQuantity", 0), 1) * COALESCE(tmsc.cogs, stc.cogs, tmc.cogs, tnc.cogs, 140.00))::numeric, 2) AS calc_cogs
          FROM candidate_orders co
          LEFT JOIN tmp_tenant_sku_cogs tmsc
            ON tmsc."tenantId" = co."tenantId" AND tmsc.norm_sku = co.norm_mapping
          LEFT JOIN tmp_store_cogs stc
            ON stc."tenantId" = co."tenantId" AND stc."shopId" = co."shopId"
          LEFT JOIN tmp_team_cogs tmc
            ON tmc."tenantId" = co."tenantId" AND tmc."teamId" = co."teamId"
          LEFT JOIN tmp_tenant_cogs tnc
            ON tnc."tenantId" = co."tenantId"
          WHERE jsonb_array_length(co.items) = 0
        ),
        resolved_orders AS (
          SELECT order_id, calc_qty, calc_cogs
          FROM order_item_eval
          WHERE all_items_priced = true AND calc_cogs > 0
          UNION ALL
          SELECT order_id, calc_qty, calc_cogs
          FROM empty_item_eval
          WHERE calc_cogs > 0
        )
        UPDATE pos_orders o
        SET
          cogs = ro.calc_cogs,
          "totalQuantity" = CASE WHEN ro.calc_qty > 0 THEN ro.calc_qty ELSE GREATEST(COALESCE(o."totalQuantity", 0), 1) END
        FROM resolved_orders ro
        WHERE o.id = ro.order_id
          AND (COALESCE(o.cogs, 0) <> ro.calc_cogs OR (ro.calc_qty > 0 AND COALESCE(o."totalQuantity", 0) <> ro.calc_qty))
      `);
      updatedOrders += monthUpdated;
      if (monthUpdated > 0) updatedMonths.add(month);
      console.log(`✓ Backfilled ${month}: ${monthUpdated} orders updated`);
    }

    // 6b. Catch-all pass for ANY remaining order in pos_orders (e.g. 2025 or any date/status) with cogs <= 0 or totalQuantity <= 0
    const updatedRemainingZeroOrders = (!catalogChanged && pendingZeroOrders <= updatedOrders) ? 0 : await prisma.$executeRawUnsafe(`
      WITH tmp_var_cogs AS MATERIALIZED (
        SELECT DISTINCT ON (s."tenantId", s."shopId", p."variationId")
          s."tenantId",
          s."shopId",
          p."variationId",
          c.cogs
        FROM pos_products p
        JOIN pos_stores s ON s.id = p."storeId"
        JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
        WHERE p."variationId" IS NOT NULL AND BTRIM(p."variationId") <> ''
        ORDER BY s."tenantId", s."shopId", p."variationId", (s.status = 'ACTIVE') DESC, (p."variationId" <> p."productId") DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
      ),
      tmp_sku_cogs AS MATERIALIZED (
        SELECT DISTINCT ON (s."tenantId", s."shopId", LOWER(BTRIM(RTRIM(p."customId", '\`'))))
          s."tenantId",
          s."shopId",
          LOWER(BTRIM(RTRIM(p."customId", '\`'))) AS norm_sku,
          c.cogs
        FROM pos_products p
        JOIN pos_stores s ON s.id = p."storeId"
        JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
        WHERE p."customId" IS NOT NULL AND BTRIM(RTRIM(p."customId", '\`')) <> ''
        ORDER BY s."tenantId", s."shopId", LOWER(BTRIM(RTRIM(p."customId", '\`'))), (s.status = 'ACTIVE') DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
      ),
      tmp_parent_cogs AS MATERIALIZED (
        SELECT DISTINCT ON (s."tenantId", s."shopId", p."productId")
          s."tenantId",
          s."shopId",
          p."productId",
          c.cogs
        FROM pos_products p
        JOIN pos_stores s ON s.id = p."storeId"
        JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
        WHERE p."productId" IS NOT NULL AND BTRIM(p."productId") <> ''
        ORDER BY s."tenantId", s."shopId", p."productId", (s.status = 'ACTIVE') DESC, (c."startDate" IS NULL) DESC, (c."updatedAt") DESC
      ),
      tmp_tenant_sku_cogs AS MATERIALIZED (
        SELECT DISTINCT ON (c."tenantId", LOWER(BTRIM(RTRIM(p."customId", '\`'))))
          c."tenantId",
          LOWER(BTRIM(RTRIM(p."customId", '\`'))) AS norm_sku,
          c.cogs
        FROM pos_product_cogs c
        JOIN pos_products p ON p.id = c."productId"
        WHERE c.cogs > 0 AND p."customId" IS NOT NULL AND BTRIM(RTRIM(p."customId", '\`')) <> ''
        ORDER BY c."tenantId", LOWER(BTRIM(RTRIM(p."customId", '\`'))), (c."startDate" IS NULL) DESC, c."updatedAt" DESC
      ),
      tmp_store_cogs AS MATERIALIZED (
        SELECT DISTINCT ON (s."tenantId", s."shopId")
          s."tenantId",
          s."shopId",
          c.cogs
        FROM pos_stores s
        JOIN pos_product_cogs c ON c."storeId" = s.id AND c.cogs > 0
        ORDER BY s."tenantId", s."shopId", (s.status = 'ACTIVE') DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
      ),
      tmp_team_cogs AS MATERIALIZED (
        SELECT DISTINCT ON (c."tenantId", c."teamId")
          c."tenantId",
          c."teamId",
          c.cogs
        FROM (
          SELECT "tenantId", "teamId", cogs, COUNT(*) AS cnt
          FROM pos_product_cogs
          WHERE cogs > 0 AND "teamId" IS NOT NULL
          GROUP BY "tenantId", "teamId", cogs
        ) c
        ORDER BY c."tenantId", c."teamId", c.cnt DESC, c.cogs ASC
      ),
      tmp_tenant_cogs AS MATERIALIZED (
        SELECT DISTINCT ON (c."tenantId")
          c."tenantId",
          c.cogs
        FROM (
          SELECT "tenantId", cogs, COUNT(*) AS cnt
          FROM pos_product_cogs
          WHERE cogs > 0
          GROUP BY "tenantId", cogs
        ) c
        ORDER BY c."tenantId", c.cnt DESC, c.cogs ASC
      ),
      candidate_orders AS (
        SELECT
          o.id,
          o."tenantId",
          o."teamId",
          o."shopId",
          o."dateLocal",
          o."totalQuantity",
          o.cogs,
          LOWER(BTRIM(COALESCE(o.mapping, ''))) AS norm_mapping,
          CASE
            WHEN jsonb_typeof(o."orderSnapshot") = 'object'
             AND jsonb_typeof(o."orderSnapshot"->'items') = 'array'
             AND jsonb_array_length(o."orderSnapshot"->'items') > 0
            THEN o."orderSnapshot"->'items'
            WHEN jsonb_typeof(o."itemData") = 'array'
             AND jsonb_array_length(o."itemData") > 0
            THEN o."itemData"
            ELSE '[]'::jsonb
          END AS items
        FROM pos_orders o
        WHERE COALESCE(o.cogs, 0) <= 0 OR COALESCE(o."totalQuantity", 0) <= 0
      ),
      expanded_items AS (
        SELECT
          co.id AS order_id,
          co."tenantId",
          co."teamId",
          co."shopId",
          co.norm_mapping,
          CASE
            WHEN jsonb_typeof(item->'quantity') = 'number'
             AND (item->>'quantity') ~ '^[0-9]+$'
             AND (item->>'quantity')::bigint BETWEEN 1 AND 100000
            THEN (item->>'quantity')::int
            WHEN jsonb_typeof(item->'quantity') = 'string'
             AND BTRIM(item->>'quantity') ~ '^[0-9]+$'
             AND BTRIM(item->>'quantity')::bigint BETWEEN 1 AND 100000
            THEN BTRIM(item->>'quantity')::int
            ELSE 1
          END AS qty,
          COALESCE(NULLIF(BTRIM(item->>'variation_id'), ''), NULLIF(BTRIM(item->>'variationId'), '')) AS var_id,
          COALESCE(NULLIF(BTRIM(item->>'product_id'), ''), NULLIF(BTRIM(item->>'productId'), '')) AS prod_id,
          COALESCE(
            NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->>'product_display_id', ''), '\`'))), ''),
            NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->>'productDisplayId', ''), '\`'))), ''),
            NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->'variation_info'->>'product_display_id', ''), '\`'))), ''),
            NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->'variation_info'->>'display_id', ''), '\`'))), ''),
            NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->'variation_info'->>'barcode', ''), '\`'))), '')
          ) AS disp_sku
        FROM candidate_orders co
        CROSS JOIN LATERAL jsonb_array_elements(co.items) AS item
        WHERE jsonb_array_length(co.items) > 0
      ),
      order_item_eval AS (
        SELECT
          ei.order_id,
          COALESCE(SUM(ei.qty), 0)::int AS calc_qty,
          ROUND(COALESCE(SUM(ei.qty * COALESCE(vc.cogs, sc.cogs, pc.cogs, tsc.cogs, tmsc.cogs, stc.cogs, tmc.cogs, tnc.cogs, 140.00)), 0)::numeric, 2) AS calc_cogs
        FROM expanded_items ei
        LEFT JOIN tmp_var_cogs vc
          ON vc."tenantId" = ei."tenantId" AND vc."shopId" = ei."shopId" AND vc."variationId" = ei.var_id
        LEFT JOIN tmp_sku_cogs sc
          ON sc."tenantId" = ei."tenantId" AND sc."shopId" = ei."shopId" AND sc.norm_sku = ei.disp_sku
        LEFT JOIN tmp_parent_cogs pc
          ON pc."tenantId" = ei."tenantId" AND pc."shopId" = ei."shopId" AND pc."productId" = ei.prod_id
        LEFT JOIN tmp_tenant_sku_cogs tsc
          ON tsc."tenantId" = ei."tenantId" AND tsc.norm_sku = ei.disp_sku
        LEFT JOIN tmp_tenant_sku_cogs tmsc
          ON tmsc."tenantId" = ei."tenantId" AND tmsc.norm_sku = ei.norm_mapping
        LEFT JOIN tmp_store_cogs stc
          ON stc."tenantId" = ei."tenantId" AND stc."shopId" = ei."shopId"
        LEFT JOIN tmp_team_cogs tmc
          ON tmc."tenantId" = ei."tenantId" AND tmc."teamId" = ei."teamId"
        LEFT JOIN tmp_tenant_cogs tnc
          ON tnc."tenantId" = ei."tenantId"
        GROUP BY ei.order_id
      ),
      empty_item_eval AS (
        SELECT
          co.id AS order_id,
          GREATEST(COALESCE(co."totalQuantity", 0), 1)::int AS calc_qty,
          ROUND((GREATEST(COALESCE(co."totalQuantity", 0), 1) * COALESCE(tmsc.cogs, stc.cogs, tmc.cogs, tnc.cogs, 140.00))::numeric, 2) AS calc_cogs
        FROM candidate_orders co
        LEFT JOIN tmp_tenant_sku_cogs tmsc
          ON tmsc."tenantId" = co."tenantId" AND tmsc.norm_sku = co.norm_mapping
        LEFT JOIN tmp_store_cogs stc
          ON stc."tenantId" = co."tenantId" AND stc."shopId" = co."shopId"
        LEFT JOIN tmp_team_cogs tmc
          ON tmc."tenantId" = co."tenantId" AND tmc."teamId" = co."teamId"
        LEFT JOIN tmp_tenant_cogs tnc
          ON tnc."tenantId" = co."tenantId"
        WHERE jsonb_array_length(co.items) = 0
      ),
      resolved_orders AS (
        SELECT order_id, calc_qty, calc_cogs
        FROM order_item_eval
        WHERE calc_cogs > 0
        UNION ALL
        SELECT order_id, calc_qty, calc_cogs
        FROM empty_item_eval
        WHERE calc_cogs > 0
      )
      UPDATE pos_orders o
      SET
        cogs = ro.calc_cogs,
        "totalQuantity" = CASE WHEN ro.calc_qty > 0 THEN ro.calc_qty ELSE GREATEST(COALESCE(o."totalQuantity", 0), 1) END
      FROM resolved_orders ro
      WHERE o.id = ro.order_id
        AND (COALESCE(o.cogs, 0) <> ro.calc_cogs OR COALESCE(o."totalQuantity", 0) <= 0)
    `);
    if (updatedRemainingZeroOrders > 0) {
      for (const m of Array.from(pendingZeroMonths)) updatedMonths.add(m);
    }
    console.log(`✓ Updated ${updatedOrders} 2026 POS orders and ${updatedRemainingZeroOrders} catch-all remaining zero-COGS POS orders`);

    // 6a. Align pos_orders.teamId with active pos_stores.teamId across all tenants
    const alignedOrderTeams = await prisma.$executeRawUnsafe(`
      UPDATE pos_orders o
      SET "teamId" = s."teamId"
      FROM pos_stores s
      WHERE s."tenantId" = o."tenantId"
        AND s."shopId" = o."shopId"
        AND s.status = 'ACTIVE'
        AND (s.enabled = true OR s.enabled IS NULL)
        AND s."teamId" IS NOT NULL
        AND o."teamId" IS DISTINCT FROM s."teamId"
    `);
    console.log(`✓ Aligned teamId on ${alignedOrderTeams} POS orders from active stores`);

    // 6b. Normalize pos_orders.orderSnapshot->'items' and itemData so savedItemQuantity is never null
    const normalizedOrderItems = await prisma.$executeRawUnsafe(`
      WITH orders_needing_items AS (
        SELECT
          o.id,
          GREATEST(COALESCE(o."totalQuantity", 1), 1) AS fallback_qty,
          CASE
            WHEN jsonb_typeof(o."orderSnapshot") = 'object'
             AND jsonb_typeof(o."orderSnapshot"->'items') = 'array'
             AND jsonb_array_length(o."orderSnapshot"->'items') > 0
            THEN o."orderSnapshot"->'items'
            WHEN jsonb_typeof(o."itemData") = 'array'
             AND jsonb_array_length(o."itemData") > 0
            THEN o."itemData"
            ELSE NULL
          END AS raw_arr,
          CASE
            WHEN jsonb_typeof(o."orderSnapshot") = 'object'
             AND o."orderSnapshot" ? 'items'
             AND jsonb_typeof(o."orderSnapshot"->'items') <> 'null'
            THEN o."orderSnapshot"->'items'
            ELSE o."itemData"
          END AS effective_arr
        FROM pos_orders o
      ),
      invalid_item_orders AS (
        SELECT
          oni.id,
          CASE
            WHEN oni.raw_arr IS NOT NULL THEN (
              SELECT jsonb_agg(
                CASE
                  WHEN jsonb_typeof(elem) = 'object' THEN
                    jsonb_set(
                      elem,
                      '{quantity}',
                      to_jsonb(
                        CASE
                          WHEN jsonb_typeof(elem->'quantity') = 'number'
                           AND (elem->>'quantity') ~ '^[1-9][0-9]*$'
                           AND (elem->>'quantity')::bigint <= 100000
                          THEN (elem->>'quantity')::int
                          WHEN jsonb_typeof(elem->'quantity') = 'string'
                           AND BTRIM(elem->>'quantity') ~ '^[1-9][0-9]*$'
                           AND BTRIM(elem->>'quantity')::bigint <= 100000
                          THEN BTRIM(elem->>'quantity')::int
                          ELSE 1
                        END
                      ),
                      true
                    )
                  ELSE jsonb_build_object('quantity', 1)
                END
              )
              FROM jsonb_array_elements(oni.raw_arr) AS elem
            )
            ELSE jsonb_build_array(jsonb_build_object('quantity', oni.fallback_qty))
          END AS fixed_items
        FROM orders_needing_items oni
        WHERE oni.effective_arr IS NULL
           OR jsonb_typeof(oni.effective_arr) <> 'array'
           OR jsonb_array_length(oni.effective_arr) = 0
           OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(oni.effective_arr) = 'array' THEN oni.effective_arr ELSE '[]'::jsonb END
             ) AS elem
             WHERE jsonb_typeof(elem) <> 'object'
                OR NOT (
                  (jsonb_typeof(elem->'quantity') = 'number' AND (elem->>'quantity') ~ '^[1-9][0-9]*$' AND (elem->>'quantity')::bigint <= 100000)
                  OR (jsonb_typeof(elem->'quantity') = 'string' AND BTRIM(elem->>'quantity') ~ '^[1-9][0-9]*$' AND BTRIM(elem->>'quantity')::bigint <= 100000)
                )
           )
      )
      UPDATE pos_orders o
      SET
        "itemData" = iio.fixed_items,
        "orderSnapshot" = jsonb_set(
          CASE WHEN jsonb_typeof(o."orderSnapshot") = 'object' THEN o."orderSnapshot" ELSE '{}'::jsonb END,
          '{items}',
          iio.fixed_items,
          true
        )
      FROM invalid_item_orders iio
      WHERE o.id = iio.id
    `);
    console.log(`✓ Normalized item quantities on ${normalizedOrderItems} POS orders for exact Actual Units`);

    // 7. Synchronize reconcile_marketing matchedOrders & POS metrics with pos_orders, then rollup reconcile_sales & reconcile_sales_attribution
    await prisma.$executeRawUnsafe(`
      UPDATE reconcile_marketing
      SET
        mapping = CASE
          WHEN mapping LIKE '%48a33293-b104-4210-916a-75039f9a5014%'
          THEN REPLACE(mapping, '48a33293-b104-4210-916a-75039f9a5014', '64df6bb0-2582-47cd-882a-76b5da8c2c91')
          WHEN mapping LIKE '%2300dcd9-db25-4712-8502-ea7933268c33%'
          THEN REPLACE(mapping, '2300dcd9-db25-4712-8502-ea7933268c33', '8f9caa4b-b047-4d21-9839-72208b53ecd5')
          ELSE mapping
        END,
        "updatedAt" = NOW()
      WHERE mapping LIKE '%48a33293-b104-4210-916a-75039f9a5014%'
         OR mapping LIKE '%2300dcd9-db25-4712-8502-ea7933268c33%'
    `);

    const pendingRollupMonths = await prisma.$queryRawUnsafe<Array<{ m: string }>>(`
      WITH active_shops AS (
        SELECT DISTINCT "tenantId", "shopId"
        FROM pos_stores
        WHERE status = 'ACTIVE' AND (enabled = true OR enabled IS NULL)
      ),
      pos_monthly AS (
        SELECT
          o."tenantId",
          SUBSTRING(o."dateLocal" FROM 1 FOR 7) AS m,
          COUNT(*)::int AS purchases,
          ROUND(COALESCE(SUM(o.cod), 0)::numeric, 2) AS cod,
          ROUND(COALESCE(SUM(o.cogs), 0)::numeric, 2) AS cogs,
          COUNT(*) FILTER (WHERE o.status = 3)::int AS del_cnt,
          ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status = 3), 0)::numeric, 2) AS del_cogs,
          COUNT(*) FILTER (WHERE o.status = 6)::int AS can_cnt,
          ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status = 6), 0)::numeric, 2) AS can_cogs,
          COUNT(*) FILTER (WHERE o.status IN (4, 5))::int AS rts_cnt,
          ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status IN (4, 5)), 0)::numeric, 2) AS rts_cogs,
          COUNT(*) FILTER (WHERE o.status = 0 AND o."isAbandoned" = true)::int AS abn_cnt
        FROM pos_orders o
        JOIN active_shops s ON s."tenantId" = o."tenantId" AND s."shopId" = o."shopId"
        WHERE COALESCE(o."isVoid", false) = false AND o.status IS DISTINCT FROM 7
        GROUP BY 1, 2
      ),
      rm_monthly AS (
        SELECT
          rm."tenantId",
          TO_CHAR(rm.date, 'YYYY-MM') AS m,
          COALESCE(SUM(rm."purchasesPos"), 0)::int AS purchases,
          ROUND(COALESCE(SUM(rm."codPos"), 0)::numeric, 2) AS cod,
          ROUND(COALESCE(SUM(rm."cogsPos"), 0)::numeric, 2) AS cogs,
          COALESCE(SUM(rm."deliveredCount"), 0)::int AS del_cnt,
          ROUND(COALESCE(SUM(rm."cogsDeliveredPos"), 0)::numeric, 2) AS del_cogs,
          COALESCE(SUM(rm."canceledCount"), 0)::int AS can_cnt,
          ROUND(COALESCE(SUM(rm."cogsCanceledPos"), 0)::numeric, 2) AS can_cogs,
          COALESCE(SUM(rm."rtsCount"), 0)::int AS rts_cnt,
          ROUND(COALESCE(SUM(rm."cogsRtsPos"), 0)::numeric, 2) AS rts_cogs,
          COALESCE(SUM(rm."currentAbandonedCount"), 0)::int AS abn_cnt,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(rm."matchedOrders") <> 'array'
               OR jsonb_array_length(CASE WHEN jsonb_typeof(rm."matchedOrders") = 'array' THEN rm."matchedOrders" ELSE '[]'::jsonb END) <> COALESCE(rm."purchasesPos", 0)
               OR rm."matchedOrders"::text LIKE '%1379215499%'
               OR rm."matchedOrders"::text LIKE '%1304950504%'
          )::int AS bad_rows
        FROM reconcile_marketing rm
        GROUP BY 1, 2
      )
      SELECT DISTINCT COALESCE(p.m, r.m) AS m
      FROM pos_monthly p
      FULL OUTER JOIN rm_monthly r ON r."tenantId" = p."tenantId" AND r.m = p.m
      WHERE COALESCE(p.purchases, 0) <> COALESCE(r.purchases, 0)
         OR COALESCE(p.cod, 0) <> COALESCE(r.cod, 0)
         OR COALESCE(p.cogs, 0) <> COALESCE(r.cogs, 0)
         OR COALESCE(p.del_cnt, 0) <> COALESCE(r.del_cnt, 0)
         OR COALESCE(p.del_cogs, 0) <> COALESCE(r.del_cogs, 0)
         OR COALESCE(p.can_cnt, 0) <> COALESCE(r.can_cnt, 0)
         OR COALESCE(p.can_cogs, 0) <> COALESCE(r.can_cogs, 0)
         OR COALESCE(p.rts_cnt, 0) <> COALESCE(r.rts_cnt, 0)
         OR COALESCE(p.rts_cogs, 0) <> COALESCE(r.rts_cogs, 0)
         OR COALESCE(p.abn_cnt, 0) <> COALESCE(r.abn_cnt, 0)
         OR COALESCE(r.bad_rows, 0) > 0
      UNION
      SELECT DISTINCT TO_CHAR(date, 'YYYY-MM') AS m
      FROM reconcile_sales
      WHERE COALESCE("purchasesPos", 0) > 0 AND COALESCE("cogsPos", 0) <= 0
      UNION
      SELECT DISTINCT TO_CHAR(date, 'YYYY-MM') AS m
      FROM reconcile_sales_attribution
      WHERE COALESCE("purchasesPos", 0) > 0 AND COALESCE("cogsPos", 0) <= 0
    `);
    for (const r of pendingRollupMonths) {
      if (r.m) {
        if (r.m < '2026-01') updatedMonths.add('2025-01');
        else updatedMonths.add(r.m);
      }
    }

    let updatedReconcileMarketing = 0;
    let updatedReconcileSales = 0;
    let updatedReconcileAttribution = 0;
    const shouldReconcileRollups =
      updatedOrders > 0 ||
      updatedRemainingZeroOrders > 0 ||
      alignedConflictStoreOrders > 0 ||
      alignedProductCogsScope > 0 ||
      consolidatedDuplicateStoreCogs > 0 ||
      alignedOrderTeams > 0 ||
      normalizedOrderItems > 0 ||
      pendingRollupMonths.length > 0;
    const allMonthRanges: Array<[string, string]> = [
      ['2026-12-01', '2027-01-01'],
      ['2026-11-01', '2026-12-01'],
      ['2026-10-01', '2026-11-01'],
      ['2026-09-01', '2026-10-01'],
      ['2026-08-01', '2026-09-01'],
      ['2026-07-01', '2026-08-01'],
      ['2026-06-01', '2026-07-01'],
      ['2026-05-01', '2026-06-01'],
      ['2026-04-01', '2026-05-01'],
      ['2026-03-01', '2026-04-01'],
      ['2026-02-01', '2026-03-01'],
      ['2026-01-01', '2026-02-01'],
      ['2025-01-01', '2026-01-01'],
    ];
    const fullRollupNeeded =
      updatedRemainingZeroOrders > 0 ||
      alignedConflictStoreOrders > 0 ||
      alignedProductCogsScope > 0 ||
      consolidatedDuplicateStoreCogs > 0 ||
      alignedOrderTeams > 0 ||
      normalizedOrderItems > 0;
    const monthRanges: Array<[string, string]> = fullRollupNeeded
      ? allMonthRanges
      : allMonthRanges.filter(([mStart]) => updatedMonths.has(mStart.slice(0, 7)));

    for (const [mStart, mEnd] of monthRanges) {
      // 7a. Canonicalize matchedOrders on existing reconcile_marketing rows (bijection with active pos_orders on same date & team)
      const rmCanonicalizedCount = await prisma.$executeRawUnsafe(`
        WITH active_stores AS (
          SELECT DISTINCT ON ("tenantId", "shopId")
            "tenantId",
            "shopId",
            id AS store_id,
            "teamId"
          FROM pos_stores
          WHERE status = 'ACTIVE' AND (enabled = true OR enabled IS NULL)
          ORDER BY "tenantId", "shopId", "updatedAt" DESC
        ),
        active_orders AS MATERIALIZED (
          SELECT
            o.id,
            o."tenantId",
            o."teamId",
            o."shopId",
            o."posOrderId",
            o."dateLocal"::date AS order_date,
            ROUND(COALESCE(o.cod, 0)::numeric, 2) AS cod
          FROM pos_orders o
          JOIN active_stores s
            ON s."tenantId" = o."tenantId" AND s."shopId" = o."shopId"
          WHERE o."dateLocal" >= '${mStart}'
            AND o."dateLocal" < '${mEnd}'
            AND COALESCE(o."isVoid", false) = false
            AND o.status IS DISTINCT FROM 7
        ),
        raw_rm_members AS (
          SELECT
            rm.id AS rm_id,
            rm."tenantId",
            rm."teamId" AS rm_team_id,
            rm.date,
            rm."adId",
            rm.spend,
            rm.impressions,
            rm."updatedAt",
            jsonb_array_length(CASE WHEN jsonb_typeof(rm."matchedOrders") = 'array' THEN rm."matchedOrders" ELSE '[]'::jsonb END) AS rm_member_count,
            (m->>'shopId') AS raw_shop_id,
            (m->>'posOrderId') AS raw_pos_order_id
          FROM reconcile_marketing rm
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(rm."matchedOrders") = 'array' THEN rm."matchedOrders" ELSE '[]'::jsonb END
          ) AS m
          WHERE rm.date >= DATE '${mStart}'
            AND rm.date < DATE '${mEnd}'
        ),
        matched_candidates AS (
          SELECT
            r.rm_id,
            r.rm_team_id,
            r."adId",
            r.spend,
            r.impressions,
            r."updatedAt",
            ao.id AS order_id,
            ao."shopId",
            ao."posOrderId",
            ao.cod,
            ao."teamId" AS order_team_id,
            (ao."shopId" = r.raw_shop_id) AS exact_shop
          FROM raw_rm_members r
          JOIN active_orders ao
            ON ao."tenantId" = r."tenantId"
           AND ao.order_date = r.date
           AND ao."posOrderId" = r.raw_pos_order_id
           AND ao."shopId" = CASE
             WHEN r.raw_shop_id = '1379215499' THEN '1392241620'
             WHEN r.raw_shop_id = '1304950504' THEN '1392240559'
             ELSE r.raw_shop_id
           END
          WHERE r.rm_team_id IS NOT DISTINCT FROM ao."teamId"
             OR (COALESCE(r.spend, 0) = 0 AND COALESCE(r.impressions, 0) = 0 AND r.rm_member_count = 1)
        ),
        unique_order_owner AS (
          SELECT DISTINCT ON (mc.order_id)
            mc.order_id,
            mc.rm_id,
            mc."shopId",
            mc."posOrderId",
            mc.cod,
            mc.order_team_id
          FROM matched_candidates mc
          ORDER BY
            mc.order_id,
            mc.exact_shop DESC,
            (mc.rm_team_id IS NOT DISTINCT FROM mc.order_team_id) DESC,
            (COALESCE(mc.spend, 0) > 0 OR COALESCE(mc.impressions, 0) > 0) DESC,
            (mc."adId" = mc."shopId" || '-' || mc."posOrderId") DESC,
            mc."updatedAt" DESC,
            mc.rm_id ASC
        ),
        rm_new_matched AS (
          SELECT
            rm.id AS rm_id,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'shopId', uo."shopId",
                  'posOrderId', uo."posOrderId",
                  'cod', uo.cod::float8
                )
                ORDER BY uo."shopId", uo."posOrderId"
              ) FILTER (WHERE uo.order_id IS NOT NULL),
              '[]'::jsonb
            ) AS new_matched_orders,
            (ARRAY_AGG(uo.order_team_id) FILTER (WHERE uo.order_team_id IS NOT NULL))[1] AS inferred_team_id
          FROM reconcile_marketing rm
          LEFT JOIN unique_order_owner uo ON uo.rm_id = rm.id
          WHERE rm.date >= DATE '${mStart}'
            AND rm.date < DATE '${mEnd}'
          GROUP BY rm.id
        )
        UPDATE reconcile_marketing rm
        SET
          "matchedOrders" = rnm.new_matched_orders,
          "teamId" = CASE
            WHEN COALESCE(rm.spend, 0) = 0 AND COALESCE(rm.impressions, 0) = 0 AND rnm.inferred_team_id IS NOT NULL
            THEN rnm.inferred_team_id
            ELSE rm."teamId"
          END,
          "updatedAt" = NOW()
        FROM rm_new_matched rnm
        WHERE rm.id = rnm.rm_id
          AND (
            rm."matchedOrders" IS DISTINCT FROM rnm.new_matched_orders
            OR (
              COALESCE(rm.spend, 0) = 0
              AND COALESCE(rm.impressions, 0) = 0
              AND rnm.inferred_team_id IS NOT NULL
              AND rm."teamId" IS DISTINCT FROM rnm.inferred_team_id
            )
          )
      `);

      // 7b. Upsert synthetic reconcile_marketing rows for any unowned active pos_orders, then delete empty synthetic rows
      const rmSyntheticUpsertedCount = await prisma.$executeRawUnsafe(`
        WITH active_stores AS (
          SELECT DISTINCT ON ("tenantId", "shopId")
            "tenantId",
            "shopId",
            id AS store_id,
            "teamId"
          FROM pos_stores
          WHERE status = 'ACTIVE' AND (enabled = true OR enabled IS NULL)
          ORDER BY "tenantId", "shopId", "updatedAt" DESC
        ),
        owned_orders AS (
          SELECT DISTINCT
            rm."tenantId",
            rm.date AS order_date,
            (m->>'shopId') AS "shopId",
            (m->>'posOrderId') AS "posOrderId"
          FROM reconcile_marketing rm
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(rm."matchedOrders") = 'array' THEN rm."matchedOrders" ELSE '[]'::jsonb END
          ) AS m
          WHERE rm.date >= DATE '${mStart}'
            AND rm.date < DATE '${mEnd}'
        ),
        unowned_orders AS (
          SELECT
            o."tenantId",
            COALESCE(o."teamId", s."teamId") AS "teamId",
            o."dateLocal"::date AS order_date,
            (o."shopId" || '-' || o."posOrderId") AS "adId",
            COALESCE(NULLIF(BTRIM(o.mapping), ''), 'ua::' || LOWER(s.store_id::text)) AS mapping,
            jsonb_build_array(
              jsonb_build_object(
                'shopId', o."shopId",
                'posOrderId', o."posOrderId",
                'cod', ROUND(COALESCE(o.cod, 0)::numeric, 2)::float8
              )
            ) AS "matchedOrders",
            jsonb_build_array(o."shopId") AS shops
          FROM pos_orders o
          JOIN active_stores s
            ON s."tenantId" = o."tenantId" AND s."shopId" = o."shopId"
          LEFT JOIN owned_orders oo
            ON oo."tenantId" = o."tenantId"
           AND oo.order_date = o."dateLocal"::date
           AND oo."shopId" = o."shopId"
           AND oo."posOrderId" = o."posOrderId"
          WHERE o."dateLocal" >= '${mStart}'
            AND o."dateLocal" < '${mEnd}'
            AND COALESCE(o."isVoid", false) = false
            AND o.status IS DISTINCT FROM 7
            AND oo."posOrderId" IS NULL
        )
        INSERT INTO reconcile_marketing (
          id, "tenantId", "teamId", date, "adId", "normalizedAdId",
          "accountId", "campaignId", "campaignName", "adsetId", "adName",
          "marketingAssociate", mapping, spend, clicks, "linkClicks", impressions, leads,
          "matchedOrders", shops, "createdAt", "updatedAt"
        )
        SELECT
          gen_random_uuid(),
          u."tenantId",
          u."teamId",
          u.order_date,
          u."adId",
          NULL,
          '',
          '',
          '',
          '',
          'POS Unmatched Order',
          NULL,
          u.mapping,
          0, 0, 0, 0, 0,
          u."matchedOrders",
          u.shops,
          NOW(),
          NOW()
        FROM unowned_orders u
        ON CONFLICT ("tenantId", date, "adId") DO UPDATE
        SET
          "teamId" = EXCLUDED."teamId",
          "matchedOrders" = EXCLUDED."matchedOrders",
          shops = EXCLUDED.shops,
          mapping = COALESCE(NULLIF(BTRIM(reconcile_marketing.mapping), ''), EXCLUDED.mapping),
          "updatedAt" = NOW()
      `);

      await prisma.$executeRawUnsafe(`
        DELETE FROM reconcile_marketing
        WHERE date >= DATE '${mStart}'
          AND date < DATE '${mEnd}'
          AND COALESCE(spend, 0) = 0
          AND COALESCE(impressions, 0) = 0
          AND COALESCE(clicks, 0) = 0
          AND COALESCE("linkClicks", 0) = 0
          AND COALESCE(leads, 0) = 0
          AND (
            jsonb_typeof("matchedOrders") <> 'array'
            OR jsonb_array_length("matchedOrders") = 0
          )
      `);

      // 7c. Recompute ALL POS counts, CODs, COGS, and fees on reconcile_marketing from pos_orders via matchedOrders
      const rmRecomputedCount = await prisma.$executeRawUnsafe(`
        WITH rm_agg AS (
          SELECT
            rm.id AS rm_id,
            COUNT(o.id)::int AS purchases_pos,
            COUNT(o.id) FILTER (WHERE o."isRepurchase" = true)::int AS repurchase_count,
            COUNT(o.id) FILTER (WHERE o.tracking IS NOT NULL AND o.tracking <> '')::int AS processed_purchases_pos,
            COUNT(o.id) FILTER (WHERE o."isRepurchase" = true AND o.tracking IS NOT NULL AND o.tracking <> '')::int AS repurchase_processed_purchases_pos,
            ROUND(COALESCE(SUM(o.cod), 0)::numeric, 2) AS cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_cod_pos,
            ROUND(COALESCE(SUM(o.cogs), 0)::numeric, 2) AS cogs_pos,
            ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_cogs_pos,
            ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status = 6), 0)::numeric, 2) AS cogs_canceled_pos,
            ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status = 6 AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_cogs_canceled_pos,
            ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status = 11), 0)::numeric, 2) AS cogs_restocking_pos,
            ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status = 11 AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_cogs_restocking_pos,
            ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status IN (4, 5)), 0)::numeric, 2) AS cogs_rts_pos,
            ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status IN (4, 5) AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_cogs_rts_pos,
            ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status = 3), 0)::numeric, 2) AS cogs_delivered_pos,
            ROUND(COALESCE(SUM(o.cogs) FILTER (WHERE o.status = 3 AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_cogs_delivered_pos,
            COUNT(o.id) FILTER (WHERE o.status = 0)::int AS unconfirmed_count,
            COUNT(o.id) FILTER (WHERE o.status = 0 AND o."isRepurchase" = true)::int AS repurchase_unconfirmed_count,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 0), 0)::numeric, 2) AS unconfirmed_cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 0 AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_unconfirmed_cod_pos,
            COUNT(o.id) FILTER (WHERE o."wasAbandonedCart" = true OR o."isAbandoned" = true)::int AS abandoned_count,
            COUNT(o.id) FILTER (WHERE (o."wasAbandonedCart" = true OR o."isAbandoned" = true) AND o."isRepurchase" = true)::int AS repurchase_abandoned_count,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o."wasAbandonedCart" = true OR o."isAbandoned" = true), 0)::numeric, 2) AS abandoned_cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE (o."wasAbandonedCart" = true OR o."isAbandoned" = true) AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_abandoned_cod_pos,
            COUNT(o.id) FILTER (WHERE o.status = 0 AND o."isAbandoned" = true)::int AS current_abandoned_count,
            COUNT(o.id) FILTER (WHERE o.status = 0 AND o."isAbandoned" = true AND o."isRepurchase" = true)::int AS repurchase_current_abandoned_count,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 0 AND o."isAbandoned" = true), 0)::numeric, 2) AS current_abandoned_cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 0 AND o."isAbandoned" = true AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_current_abandoned_cod_pos,
            COUNT(o.id) FILTER (WHERE o.status = 1)::int AS confirmed_count,
            COUNT(o.id) FILTER (WHERE o.status = 1 AND o."isRepurchase" = true)::int AS repurchase_confirmed_count,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 1), 0)::numeric, 2) AS confirmed_cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 1 AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_confirmed_cod_pos,
            COUNT(o.id) FILTER (WHERE o.status = 13)::int AS printed_count,
            COUNT(o.id) FILTER (WHERE o.status = 13 AND o."isRepurchase" = true)::int AS repurchase_printed_count,
            0::int AS deleted_count,
            0::int AS repurchase_deleted_count,
            COUNT(o.id) FILTER (WHERE o.status = 11)::int AS restocking_count,
            COUNT(o.id) FILTER (WHERE o.status = 11 AND o."isRepurchase" = true)::int AS repurchase_restocking_count,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 11), 0)::numeric, 2) AS restocking_cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 11 AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_restocking_cod_pos,
            COUNT(o.id) FILTER (WHERE o.status IN (9, 13))::int AS waiting_pickup_count,
            COUNT(o.id) FILTER (WHERE o.status IN (9, 13) AND o."isRepurchase" = true)::int AS repurchase_waiting_pickup_count,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status IN (9, 13)), 0)::numeric, 2) AS waiting_pickup_cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status IN (9, 13) AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_waiting_pickup_cod_pos,
            COUNT(o.id) FILTER (WHERE o.status = 2)::int AS shipped_count,
            COUNT(o.id) FILTER (WHERE o.status = 2 AND o."isRepurchase" = true)::int AS repurchase_shipped_count,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 2), 0)::numeric, 2) AS shipped_cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 2 AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_shipped_cod_pos,
            COUNT(o.id) FILTER (WHERE o.status = 3)::int AS delivered_count,
            COUNT(o.id) FILTER (WHERE o.status = 3 AND o."isRepurchase" = true)::int AS repurchase_delivered_count,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 3), 0)::numeric, 2) AS delivered_cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 3 AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_delivered_cod_pos,
            COUNT(o.id) FILTER (WHERE o.status = 6)::int AS canceled_count,
            COUNT(o.id) FILTER (WHERE o.status = 6 AND o."isRepurchase" = true)::int AS repurchase_canceled_count,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 6), 0)::numeric, 2) AS canceled_cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status = 6 AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_canceled_cod_pos,
            COUNT(o.id) FILTER (WHERE o.status IN (4, 5))::int AS rts_count,
            COUNT(o.id) FILTER (WHERE o.status IN (4, 5) AND o."isRepurchase" = true)::int AS repurchase_rts_count,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status IN (4, 5)), 0)::numeric, 2) AS rts_cod_pos,
            ROUND(COALESCE(SUM(o.cod) FILTER (WHERE o.status IN (4, 5) AND o."isRepurchase" = true), 0)::numeric, 2) AS repurchase_rts_cod_pos
          FROM reconcile_marketing rm
          LEFT JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(rm."matchedOrders") = 'array' THEN rm."matchedOrders" ELSE '[]'::jsonb END
          ) AS m ON TRUE
          LEFT JOIN pos_orders o
            ON o."tenantId" = rm."tenantId"
           AND o."shopId" = (m->>'shopId')
           AND o."posOrderId" = (m->>'posOrderId')
           AND o."dateLocal" = TO_CHAR(rm.date, 'YYYY-MM-DD')
           AND COALESCE(o."isVoid", false) = false
           AND o.status IS DISTINCT FROM 7
          WHERE rm.date >= DATE '${mStart}'
            AND rm.date < DATE '${mEnd}'
          GROUP BY rm.id
        ),
        rm_final AS (
          SELECT
            a.*,
            ROUND((GREATEST(a.purchases_pos - a.canceled_count, 0) * 60)::numeric, 2) AS sf_pos,
            ROUND((GREATEST(a.repurchase_count - a.repurchase_canceled_count, 0) * 60)::numeric, 2) AS repurchase_sf_pos,
            ROUND((GREATEST(a.purchases_pos - a.canceled_count, 0) * 25)::numeric, 2) AS ff_pos,
            ROUND((GREATEST(a.repurchase_count - a.repurchase_canceled_count, 0) * 25)::numeric, 2) AS repurchase_ff_pos,
            ROUND((GREATEST(a.purchases_pos - a.canceled_count, 0) * 5)::numeric, 2) AS if_pos,
            ROUND((GREATEST(a.repurchase_count - a.repurchase_canceled_count, 0) * 5)::numeric, 2) AS repurchase_if_pos,
            ROUND(((a.shipped_count + a.delivered_count + a.rts_count) * 60)::numeric, 2) AS sf_sdr_pos,
            ROUND(((a.repurchase_shipped_count + a.repurchase_delivered_count + a.repurchase_rts_count) * 60)::numeric, 2) AS repurchase_sf_sdr_pos,
            ROUND(((a.shipped_count + a.delivered_count + a.rts_count) * 25)::numeric, 2) AS ff_sdr_pos,
            ROUND(((a.repurchase_shipped_count + a.repurchase_delivered_count + a.repurchase_rts_count) * 25)::numeric, 2) AS repurchase_ff_sdr_pos,
            ROUND(((a.shipped_count + a.delivered_count + a.rts_count) * 5)::numeric, 2) AS if_sdr_pos,
            ROUND(((a.repurchase_shipped_count + a.repurchase_delivered_count + a.repurchase_rts_count) * 5)::numeric, 2) AS repurchase_if_sdr_pos,
            ROUND((GREATEST(a.cod_pos - a.rts_cod_pos - a.canceled_cod_pos, 0) * 0.0224)::numeric, 2) AS cod_fee_pos,
            ROUND((GREATEST(a.repurchase_cod_pos - a.repurchase_rts_cod_pos - a.repurchase_canceled_cod_pos, 0) * 0.0224)::numeric, 2) AS repurchase_cod_fee_pos,
            ROUND((a.delivered_cod_pos * 0.0224)::numeric, 2) AS cod_fee_delivered_pos,
            ROUND((a.repurchase_delivered_cod_pos * 0.0224)::numeric, 2) AS repurchase_cod_fee_delivered_pos
          FROM rm_agg a
        )
        UPDATE reconcile_marketing rm
        SET
          "purchasesPos" = f.purchases_pos,
          "repurchaseCount" = f.repurchase_count,
          "processedPurchasesPos" = f.processed_purchases_pos,
          "repurchaseProcessedPurchasesPos" = f.repurchase_processed_purchases_pos,
          "codPos" = f.cod_pos,
          "repurchaseCodPos" = f.repurchase_cod_pos,
          "cogsPos" = f.cogs_pos,
          "repurchaseCogsPos" = f.repurchase_cogs_pos,
          "cogsCanceledPos" = f.cogs_canceled_pos,
          "repurchaseCogsCanceledPos" = f.repurchase_cogs_canceled_pos,
          "cogsRestockingPos" = f.cogs_restocking_pos,
          "repurchaseCogsRestockingPos" = f.repurchase_cogs_restocking_pos,
          "cogsRtsPos" = f.cogs_rts_pos,
          "repurchaseCogsRtsPos" = f.repurchase_cogs_rts_pos,
          "cogsDeliveredPos" = f.cogs_delivered_pos,
          "repurchaseCogsDeliveredPos" = f.repurchase_cogs_delivered_pos,
          "unconfirmedCount" = f.unconfirmed_count,
          "repurchaseUnconfirmedCount" = f.repurchase_unconfirmed_count,
          "unconfirmedCodPos" = f.unconfirmed_cod_pos,
          "repurchaseUnconfirmedCodPos" = f.repurchase_unconfirmed_cod_pos,
          "abandonedCount" = f.abandoned_count,
          "repurchaseAbandonedCount" = f.repurchase_abandoned_count,
          "abandonedCodPos" = f.abandoned_cod_pos,
          "repurchaseAbandonedCodPos" = f.repurchase_abandoned_cod_pos,
          "currentAbandonedCount" = f.current_abandoned_count,
          "repurchaseCurrentAbandonedCount" = f.repurchase_current_abandoned_count,
          "currentAbandonedCodPos" = f.current_abandoned_cod_pos,
          "repurchaseCurrentAbandonedCodPos" = f.repurchase_current_abandoned_cod_pos,
          "confirmedCount" = f.confirmed_count,
          "repurchaseConfirmedCount" = f.repurchase_confirmed_count,
          "confirmedCodPos" = f.confirmed_cod_pos,
          "repurchaseConfirmedCodPos" = f.repurchase_confirmed_cod_pos,
          "printedCount" = f.printed_count,
          "repurchasePrintedCount" = f.repurchase_printed_count,
          "deletedCount" = f.deleted_count,
          "repurchaseDeletedCount" = f.repurchase_deleted_count,
          "restockingCount" = f.restocking_count,
          "repurchaseRestockingCount" = f.repurchase_restocking_count,
          "restockingCodPos" = f.restocking_cod_pos,
          "repurchaseRestockingCodPos" = f.repurchase_restocking_cod_pos,
          "waitingPickupCount" = f.waiting_pickup_count,
          "repurchaseWaitingPickupCount" = f.repurchase_waiting_pickup_count,
          "waitingPickupCodPos" = f.waiting_pickup_cod_pos,
          "repurchaseWaitingPickupCodPos" = f.repurchase_waiting_pickup_cod_pos,
          "shippedCount" = f.shipped_count,
          "repurchaseShippedCount" = f.repurchase_shipped_count,
          "shippedCodPos" = f.shipped_cod_pos,
          "repurchaseShippedCodPos" = f.repurchase_shipped_cod_pos,
          "deliveredCount" = f.delivered_count,
          "repurchaseDeliveredCount" = f.repurchase_delivered_count,
          "deliveredCodPos" = f.delivered_cod_pos,
          "repurchaseDeliveredCodPos" = f.repurchase_delivered_cod_pos,
          "canceledCount" = f.canceled_count,
          "repurchaseCanceledCount" = f.repurchase_canceled_count,
          "canceledCodPos" = f.canceled_cod_pos,
          "repurchaseCanceledCodPos" = f.repurchase_canceled_cod_pos,
          "rtsCount" = f.rts_count,
          "repurchaseRtsCount" = f.repurchase_rts_count,
          "rtsCodPos" = f.rts_cod_pos,
          "repurchaseRtsCodPos" = f.repurchase_rts_cod_pos,
          "sfPos" = f.sf_pos,
          "repurchaseSfPos" = f.repurchase_sf_pos,
          "ffPos" = f.ff_pos,
          "repurchaseFfPos" = f.repurchase_ff_pos,
          "ifPos" = f.if_pos,
          "repurchaseIfPos" = f.repurchase_if_pos,
          "sfSdrPos" = f.sf_sdr_pos,
          "repurchaseSfSdrPos" = f.repurchase_sf_sdr_pos,
          "ffSdrPos" = f.ff_sdr_pos,
          "repurchaseFfSdrPos" = f.repurchase_ff_sdr_pos,
          "ifSdrPos" = f.if_sdr_pos,
          "repurchaseIfSdrPos" = f.repurchase_if_sdr_pos,
          "codFeePos" = f.cod_fee_pos,
          "repurchaseCodFeePos" = f.repurchase_cod_fee_pos,
          "codFeeDeliveredPos" = f.cod_fee_delivered_pos,
          "repurchaseCodFeeDeliveredPos" = f.repurchase_cod_fee_delivered_pos,
          "updatedAt" = NOW()
        FROM rm_final f
        WHERE rm.id = f.rm_id
          AND (
            COALESCE(rm."purchasesPos", 0) <> f.purchases_pos
            OR COALESCE(rm."repurchaseCount", 0) <> f.repurchase_count
            OR COALESCE(rm."processedPurchasesPos", 0) <> f.processed_purchases_pos
            OR COALESCE(rm."repurchaseProcessedPurchasesPos", 0) <> f.repurchase_processed_purchases_pos
            OR COALESCE(rm."codPos", 0) <> f.cod_pos
            OR COALESCE(rm."repurchaseCodPos", 0) <> f.repurchase_cod_pos
            OR COALESCE(rm."cogsPos", 0) <> f.cogs_pos
            OR COALESCE(rm."repurchaseCogsPos", 0) <> f.repurchase_cogs_pos
            OR COALESCE(rm."cogsCanceledPos", 0) <> f.cogs_canceled_pos
            OR COALESCE(rm."repurchaseCogsCanceledPos", 0) <> f.repurchase_cogs_canceled_pos
            OR COALESCE(rm."cogsRestockingPos", 0) <> f.cogs_restocking_pos
            OR COALESCE(rm."repurchaseCogsRestockingPos", 0) <> f.repurchase_cogs_restocking_pos
            OR COALESCE(rm."cogsRtsPos", 0) <> f.cogs_rts_pos
            OR COALESCE(rm."repurchaseCogsRtsPos", 0) <> f.repurchase_cogs_rts_pos
            OR COALESCE(rm."cogsDeliveredPos", 0) <> f.cogs_delivered_pos
            OR COALESCE(rm."repurchaseCogsDeliveredPos", 0) <> f.repurchase_cogs_delivered_pos
            OR COALESCE(rm."unconfirmedCount", 0) <> f.unconfirmed_count
            OR COALESCE(rm."repurchaseUnconfirmedCount", 0) <> f.repurchase_unconfirmed_count
            OR COALESCE(rm."unconfirmedCodPos", 0) <> f.unconfirmed_cod_pos
            OR COALESCE(rm."repurchaseUnconfirmedCodPos", 0) <> f.repurchase_unconfirmed_cod_pos
            OR COALESCE(rm."abandonedCount", 0) <> f.abandoned_count
            OR COALESCE(rm."repurchaseAbandonedCount", 0) <> f.repurchase_abandoned_count
            OR COALESCE(rm."abandonedCodPos", 0) <> f.abandoned_cod_pos
            OR COALESCE(rm."repurchaseAbandonedCodPos", 0) <> f.repurchase_abandoned_cod_pos
            OR COALESCE(rm."currentAbandonedCount", 0) <> f.current_abandoned_count
            OR COALESCE(rm."repurchaseCurrentAbandonedCount", 0) <> f.repurchase_current_abandoned_count
            OR COALESCE(rm."currentAbandonedCodPos", 0) <> f.current_abandoned_cod_pos
            OR COALESCE(rm."repurchaseCurrentAbandonedCodPos", 0) <> f.repurchase_current_abandoned_cod_pos
            OR COALESCE(rm."confirmedCount", 0) <> f.confirmed_count
            OR COALESCE(rm."repurchaseConfirmedCount", 0) <> f.repurchase_confirmed_count
            OR COALESCE(rm."confirmedCodPos", 0) <> f.confirmed_cod_pos
            OR COALESCE(rm."repurchaseConfirmedCodPos", 0) <> f.repurchase_confirmed_cod_pos
            OR COALESCE(rm."printedCount", 0) <> f.printed_count
            OR COALESCE(rm."repurchasePrintedCount", 0) <> f.repurchase_printed_count
            OR COALESCE(rm."deletedCount", 0) <> f.deleted_count
            OR COALESCE(rm."repurchaseDeletedCount", 0) <> f.repurchase_deleted_count
            OR COALESCE(rm."restockingCount", 0) <> f.restocking_count
            OR COALESCE(rm."repurchaseRestockingCount", 0) <> f.repurchase_restocking_count
            OR COALESCE(rm."restockingCodPos", 0) <> f.restocking_cod_pos
            OR COALESCE(rm."repurchaseRestockingCodPos", 0) <> f.repurchase_restocking_cod_pos
            OR COALESCE(rm."waitingPickupCount", 0) <> f.waiting_pickup_count
            OR COALESCE(rm."repurchaseWaitingPickupCount", 0) <> f.repurchase_waiting_pickup_count
            OR COALESCE(rm."waitingPickupCodPos", 0) <> f.waiting_pickup_cod_pos
            OR COALESCE(rm."repurchaseWaitingPickupCodPos", 0) <> f.repurchase_waiting_pickup_cod_pos
            OR COALESCE(rm."shippedCount", 0) <> f.shipped_count
            OR COALESCE(rm."repurchaseShippedCount", 0) <> f.repurchase_shipped_count
            OR COALESCE(rm."shippedCodPos", 0) <> f.shipped_cod_pos
            OR COALESCE(rm."repurchaseShippedCodPos", 0) <> f.repurchase_shipped_cod_pos
            OR COALESCE(rm."deliveredCount", 0) <> f.delivered_count
            OR COALESCE(rm."repurchaseDeliveredCount", 0) <> f.repurchase_delivered_count
            OR COALESCE(rm."deliveredCodPos", 0) <> f.delivered_cod_pos
            OR COALESCE(rm."repurchaseDeliveredCodPos", 0) <> f.repurchase_delivered_cod_pos
            OR COALESCE(rm."canceledCount", 0) <> f.canceled_count
            OR COALESCE(rm."repurchaseCanceledCount", 0) <> f.repurchase_canceled_count
            OR COALESCE(rm."canceledCodPos", 0) <> f.canceled_cod_pos
            OR COALESCE(rm."repurchaseCanceledCodPos", 0) <> f.repurchase_canceled_cod_pos
            OR COALESCE(rm."rtsCount", 0) <> f.rts_count
            OR COALESCE(rm."repurchaseRtsCount", 0) <> f.repurchase_rts_count
            OR COALESCE(rm."rtsCodPos", 0) <> f.rts_cod_pos
            OR COALESCE(rm."repurchaseRtsCodPos", 0) <> f.repurchase_rts_cod_pos
            OR COALESCE(rm."sfPos", 0) <> f.sf_pos
            OR COALESCE(rm."repurchaseSfPos", 0) <> f.repurchase_sf_pos
            OR COALESCE(rm."ffPos", 0) <> f.ff_pos
            OR COALESCE(rm."repurchaseFfPos", 0) <> f.repurchase_ff_pos
            OR COALESCE(rm."ifPos", 0) <> f.if_pos
            OR COALESCE(rm."repurchaseIfPos", 0) <> f.repurchase_if_pos
            OR COALESCE(rm."sfSdrPos", 0) <> f.sf_sdr_pos
            OR COALESCE(rm."repurchaseSfSdrPos", 0) <> f.repurchase_sf_sdr_pos
            OR COALESCE(rm."ffSdrPos", 0) <> f.ff_sdr_pos
            OR COALESCE(rm."repurchaseFfSdrPos", 0) <> f.repurchase_ff_sdr_pos
            OR COALESCE(rm."ifSdrPos", 0) <> f.if_sdr_pos
            OR COALESCE(rm."repurchaseIfSdrPos", 0) <> f.repurchase_if_sdr_pos
            OR COALESCE(rm."codFeePos", 0) <> f.cod_fee_pos
            OR COALESCE(rm."repurchaseCodFeePos", 0) <> f.repurchase_cod_fee_pos
            OR COALESCE(rm."codFeeDeliveredPos", 0) <> f.cod_fee_delivered_pos
            OR COALESCE(rm."repurchaseCodFeeDeliveredPos", 0) <> f.repurchase_cod_fee_delivered_pos
          )
      `);
      const rmCount = rmCanonicalizedCount + rmSyntheticUpsertedCount + rmRecomputedCount;

      const rsCount = await prisma.$executeRawUnsafe(`
        WITH rs_rollup AS (
          SELECT
            rm."tenantId",
            rm.date,
            CASE
              WHEN rm."campaignId" IS NOT NULL AND BTRIM(rm."campaignId") <> ''
              THEN rm."campaignId"
              ELSE COALESCE(NULLIF(rm."adId", ''), NULLIF(rm."campaignId", ''), '__unassigned__')
            END AS "campaignId",
            COALESCE(SUM(rm."purchasesPos"), 0)::int AS "purchasesPos",
            COALESCE(SUM(rm."processedPurchasesPos"), 0)::int AS "processedPurchasesPos",
            COALESCE(SUM(rm."repurchaseCount"), 0)::int AS "repurchaseCount",
            COALESCE(SUM(rm."repurchaseProcessedPurchasesPos"), 0)::int AS "repurchaseProcessedPurchasesPos",
            COALESCE(SUM(rm."confirmedCount"), 0)::int AS "confirmedCount",
            COALESCE(SUM(rm."repurchaseConfirmedCount"), 0)::int AS "repurchaseConfirmedCount",
            COALESCE(SUM(rm."unconfirmedCount"), 0)::int AS "unconfirmedCount",
            COALESCE(SUM(rm."repurchaseUnconfirmedCount"), 0)::int AS "repurchaseUnconfirmedCount",
            COALESCE(SUM(rm."printedCount"), 0)::int AS "printedCount",
            COALESCE(SUM(rm."repurchasePrintedCount"), 0)::int AS "repurchasePrintedCount",
            COALESCE(SUM(rm."waitingPickupCount"), 0)::int AS "waitingPickupCount",
            COALESCE(SUM(rm."repurchaseWaitingPickupCount"), 0)::int AS "repurchaseWaitingPickupCount",
            COALESCE(SUM(rm."shippedCount"), 0)::int AS "shippedCount",
            COALESCE(SUM(rm."repurchaseShippedCount"), 0)::int AS "repurchaseShippedCount",
            COALESCE(SUM(rm."deliveredCount"), 0)::int AS "deliveredCount",
            COALESCE(SUM(rm."repurchaseDeliveredCount"), 0)::int AS "repurchaseDeliveredCount",
            COALESCE(SUM(rm."canceledCount"), 0)::int AS "canceledCount",
            COALESCE(SUM(rm."repurchaseCanceledCount"), 0)::int AS "repurchaseCanceledCount",
            COALESCE(SUM(rm."deletedCount"), 0)::int AS "deletedCount",
            COALESCE(SUM(rm."repurchaseDeletedCount"), 0)::int AS "repurchaseDeletedCount",
            COALESCE(SUM(rm."rtsCount"), 0)::int AS "rtsCount",
            COALESCE(SUM(rm."repurchaseRtsCount"), 0)::int AS "repurchaseRtsCount",
            COALESCE(SUM(rm."restockingCount"), 0)::int AS "restockingCount",
            COALESCE(SUM(rm."repurchaseRestockingCount"), 0)::int AS "repurchaseRestockingCount",
            COALESCE(SUM(rm."abandonedCount"), 0)::int AS "abandonedCount",
            COALESCE(SUM(rm."repurchaseAbandonedCount"), 0)::int AS "repurchaseAbandonedCount",
            COALESCE(SUM(rm."currentAbandonedCount"), 0)::int AS "currentAbandonedCount",
            COALESCE(SUM(rm."repurchaseCurrentAbandonedCount"), 0)::int AS "repurchaseCurrentAbandonedCount",
            ROUND(COALESCE(SUM(rm."codPos"), 0)::numeric, 2) AS "codPos",
            ROUND(COALESCE(SUM(rm."repurchaseCodPos"), 0)::numeric, 2) AS "repurchaseCodPos",
            ROUND(COALESCE(SUM(rm."deliveredCodPos"), 0)::numeric, 2) AS "deliveredCodPos",
            ROUND(COALESCE(SUM(rm."repurchaseDeliveredCodPos"), 0)::numeric, 2) AS "repurchaseDeliveredCodPos",
            ROUND(COALESCE(SUM(rm."shippedCodPos"), 0)::numeric, 2) AS "shippedCodPos",
            ROUND(COALESCE(SUM(rm."repurchaseShippedCodPos"), 0)::numeric, 2) AS "repurchaseShippedCodPos",
            ROUND(COALESCE(SUM(rm."waitingPickupCodPos"), 0)::numeric, 2) AS "waitingPickupCodPos",
            ROUND(COALESCE(SUM(rm."repurchaseWaitingPickupCodPos"), 0)::numeric, 2) AS "repurchaseWaitingPickupCodPos",
            ROUND(COALESCE(SUM(rm."rtsCodPos"), 0)::numeric, 2) AS "rtsCodPos",
            ROUND(COALESCE(SUM(rm."repurchaseRtsCodPos"), 0)::numeric, 2) AS "repurchaseRtsCodPos",
            ROUND(COALESCE(SUM(rm."canceledCodPos"), 0)::numeric, 2) AS "canceledCodPos",
            ROUND(COALESCE(SUM(rm."repurchaseCanceledCodPos"), 0)::numeric, 2) AS "repurchaseCanceledCodPos",
            ROUND(COALESCE(SUM(rm."restockingCodPos"), 0)::numeric, 2) AS "restockingCodPos",
            ROUND(COALESCE(SUM(rm."repurchaseRestockingCodPos"), 0)::numeric, 2) AS "repurchaseRestockingCodPos",
            ROUND(COALESCE(SUM(rm."confirmedCodPos"), 0)::numeric, 2) AS "confirmedCodPos",
            ROUND(COALESCE(SUM(rm."repurchaseConfirmedCodPos"), 0)::numeric, 2) AS "repurchaseConfirmedCodPos",
            ROUND(COALESCE(SUM(rm."unconfirmedCodPos"), 0)::numeric, 2) AS "unconfirmedCodPos",
            ROUND(COALESCE(SUM(rm."repurchaseUnconfirmedCodPos"), 0)::numeric, 2) AS "repurchaseUnconfirmedCodPos",
            ROUND(COALESCE(SUM(rm."abandonedCodPos"), 0)::numeric, 2) AS "abandonedCodPos",
            ROUND(COALESCE(SUM(rm."repurchaseAbandonedCodPos"), 0)::numeric, 2) AS "repurchaseAbandonedCodPos",
            ROUND(COALESCE(SUM(rm."currentAbandonedCodPos"), 0)::numeric, 2) AS "currentAbandonedCodPos",
            ROUND(COALESCE(SUM(rm."repurchaseCurrentAbandonedCodPos"), 0)::numeric, 2) AS "repurchaseCurrentAbandonedCodPos",
            ROUND(COALESCE(SUM(rm."cogsPos"), 0)::numeric, 2) AS "cogsPos",
            ROUND(COALESCE(SUM(rm."repurchaseCogsPos"), 0)::numeric, 2) AS "repurchaseCogsPos",
            ROUND(COALESCE(SUM(rm."cogsCanceledPos"), 0)::numeric, 2) AS "cogsCanceledPos",
            ROUND(COALESCE(SUM(rm."repurchaseCogsCanceledPos"), 0)::numeric, 2) AS "repurchaseCogsCanceledPos",
            ROUND(COALESCE(SUM(rm."cogsRestockingPos"), 0)::numeric, 2) AS "cogsRestockingPos",
            ROUND(COALESCE(SUM(rm."repurchaseCogsRestockingPos"), 0)::numeric, 2) AS "repurchaseCogsRestockingPos",
            ROUND(COALESCE(SUM(rm."cogsRtsPos"), 0)::numeric, 2) AS "cogsRtsPos",
            ROUND(COALESCE(SUM(rm."repurchaseCogsRtsPos"), 0)::numeric, 2) AS "repurchaseCogsRtsPos",
            ROUND(COALESCE(SUM(rm."cogsDeliveredPos"), 0)::numeric, 2) AS "cogsDeliveredPos",
            ROUND(COALESCE(SUM(rm."repurchaseCogsDeliveredPos"), 0)::numeric, 2) AS "repurchaseCogsDeliveredPos",
            ROUND(COALESCE(SUM(rm."sfPos"), 0)::numeric, 2) AS "sfPos",
            ROUND(COALESCE(SUM(rm."repurchaseSfPos"), 0)::numeric, 2) AS "repurchaseSfPos",
            ROUND(COALESCE(SUM(rm."ffPos"), 0)::numeric, 2) AS "ffPos",
            ROUND(COALESCE(SUM(rm."repurchaseFfPos"), 0)::numeric, 2) AS "repurchaseFfPos",
            ROUND(COALESCE(SUM(rm."ifPos"), 0)::numeric, 2) AS "ifPos",
            ROUND(COALESCE(SUM(rm."repurchaseIfPos"), 0)::numeric, 2) AS "repurchaseIfPos",
            ROUND(COALESCE(SUM(rm."sfSdrPos"), 0)::numeric, 2) AS "sfSdrPos",
            ROUND(COALESCE(SUM(rm."repurchaseSfSdrPos"), 0)::numeric, 2) AS "repurchaseSfSdrPos",
            ROUND(COALESCE(SUM(rm."ffSdrPos"), 0)::numeric, 2) AS "ffSdrPos",
            ROUND(COALESCE(SUM(rm."repurchaseFfSdrPos"), 0)::numeric, 2) AS "repurchaseFfSdrPos",
            ROUND(COALESCE(SUM(rm."ifSdrPos"), 0)::numeric, 2) AS "ifSdrPos",
            ROUND(COALESCE(SUM(rm."repurchaseIfSdrPos"), 0)::numeric, 2) AS "repurchaseIfSdrPos",
            ROUND(COALESCE(SUM(rm."codFeePos"), 0)::numeric, 2) AS "codFeePos",
            ROUND(COALESCE(SUM(rm."repurchaseCodFeePos"), 0)::numeric, 2) AS "repurchaseCodFeePos",
            ROUND(COALESCE(SUM(rm."codFeeDeliveredPos"), 0)::numeric, 2) AS "codFeeDeliveredPos",
            ROUND(COALESCE(SUM(rm."repurchaseCodFeeDeliveredPos"), 0)::numeric, 2) AS "repurchaseCodFeeDeliveredPos"
          FROM reconcile_marketing rm
          WHERE rm.date >= DATE '${mStart}'
            AND rm.date < DATE '${mEnd}'
          GROUP BY 1, 2, 3
        )
        UPDATE reconcile_sales rs
        SET
          "purchasesPos" = rsc."purchasesPos",
          "processedPurchasesPos" = rsc."processedPurchasesPos",
          "repurchaseCount" = rsc."repurchaseCount",
          "repurchaseProcessedPurchasesPos" = rsc."repurchaseProcessedPurchasesPos",
          "confirmedCount" = rsc."confirmedCount",
          "repurchaseConfirmedCount" = rsc."repurchaseConfirmedCount",
          "unconfirmedCount" = rsc."unconfirmedCount",
          "repurchaseUnconfirmedCount" = rsc."repurchaseUnconfirmedCount",
          "printedCount" = rsc."printedCount",
          "repurchasePrintedCount" = rsc."repurchasePrintedCount",
          "waitingPickupCount" = rsc."waitingPickupCount",
          "repurchaseWaitingPickupCount" = rsc."repurchaseWaitingPickupCount",
          "shippedCount" = rsc."shippedCount",
          "repurchaseShippedCount" = rsc."repurchaseShippedCount",
          "deliveredCount" = rsc."deliveredCount",
          "repurchaseDeliveredCount" = rsc."repurchaseDeliveredCount",
          "canceledCount" = rsc."canceledCount",
          "repurchaseCanceledCount" = rsc."repurchaseCanceledCount",
          "deletedCount" = rsc."deletedCount",
          "repurchaseDeletedCount" = rsc."repurchaseDeletedCount",
          "rtsCount" = rsc."rtsCount",
          "repurchaseRtsCount" = rsc."repurchaseRtsCount",
          "restockingCount" = rsc."restockingCount",
          "repurchaseRestockingCount" = rsc."repurchaseRestockingCount",
          "abandonedCount" = rsc."abandonedCount",
          "repurchaseAbandonedCount" = rsc."repurchaseAbandonedCount",
          "currentAbandonedCount" = rsc."currentAbandonedCount",
          "repurchaseCurrentAbandonedCount" = rsc."repurchaseCurrentAbandonedCount",
          "codPos" = rsc."codPos",
          "repurchaseCodPos" = rsc."repurchaseCodPos",
          "deliveredCodPos" = rsc."deliveredCodPos",
          "repurchaseDeliveredCodPos" = rsc."repurchaseDeliveredCodPos",
          "shippedCodPos" = rsc."shippedCodPos",
          "repurchaseShippedCodPos" = rsc."repurchaseShippedCodPos",
          "waitingPickupCodPos" = rsc."waitingPickupCodPos",
          "repurchaseWaitingPickupCodPos" = rsc."repurchaseWaitingPickupCodPos",
          "rtsCodPos" = rsc."rtsCodPos",
          "repurchaseRtsCodPos" = rsc."repurchaseRtsCodPos",
          "canceledCodPos" = rsc."canceledCodPos",
          "repurchaseCanceledCodPos" = rsc."repurchaseCanceledCodPos",
          "restockingCodPos" = rsc."restockingCodPos",
          "repurchaseRestockingCodPos" = rsc."repurchaseRestockingCodPos",
          "confirmedCodPos" = rsc."confirmedCodPos",
          "repurchaseConfirmedCodPos" = rsc."repurchaseConfirmedCodPos",
          "unconfirmedCodPos" = rsc."unconfirmedCodPos",
          "repurchaseUnconfirmedCodPos" = rsc."repurchaseUnconfirmedCodPos",
          "abandonedCodPos" = rsc."abandonedCodPos",
          "repurchaseAbandonedCodPos" = rsc."repurchaseAbandonedCodPos",
          "currentAbandonedCodPos" = rsc."currentAbandonedCodPos",
          "repurchaseCurrentAbandonedCodPos" = rsc."repurchaseCurrentAbandonedCodPos",
          "cogsPos" = rsc."cogsPos",
          "repurchaseCogsPos" = rsc."repurchaseCogsPos",
          "cogsCanceledPos" = rsc."cogsCanceledPos",
          "repurchaseCogsCanceledPos" = rsc."repurchaseCogsCanceledPos",
          "cogsRestockingPos" = rsc."cogsRestockingPos",
          "repurchaseCogsRestockingPos" = rsc."repurchaseCogsRestockingPos",
          "cogsRtsPos" = rsc."cogsRtsPos",
          "repurchaseCogsRtsPos" = rsc."repurchaseCogsRtsPos",
          "cogsDeliveredPos" = rsc."cogsDeliveredPos",
          "repurchaseCogsDeliveredPos" = rsc."repurchaseCogsDeliveredPos",
          "sfPos" = rsc."sfPos",
          "repurchaseSfPos" = rsc."repurchaseSfPos",
          "ffPos" = rsc."ffPos",
          "repurchaseFfPos" = rsc."repurchaseFfPos",
          "ifPos" = rsc."ifPos",
          "repurchaseIfPos" = rsc."repurchaseIfPos",
          "sfSdrPos" = rsc."sfSdrPos",
          "repurchaseSfSdrPos" = rsc."repurchaseSfSdrPos",
          "ffSdrPos" = rsc."ffSdrPos",
          "repurchaseFfSdrPos" = rsc."repurchaseFfSdrPos",
          "ifSdrPos" = rsc."ifSdrPos",
          "repurchaseIfSdrPos" = rsc."repurchaseIfSdrPos",
          "codFeePos" = rsc."codFeePos",
          "repurchaseCodFeePos" = rsc."repurchaseCodFeePos",
          "codFeeDeliveredPos" = rsc."codFeeDeliveredPos",
          "repurchaseCodFeeDeliveredPos" = rsc."repurchaseCodFeeDeliveredPos",
          "updatedAt" = NOW()
        FROM rs_rollup rsc
        WHERE rs."tenantId" = rsc."tenantId"
          AND rs.date = rsc.date
          AND rs."campaignId" = rsc."campaignId"
          AND (
            COALESCE(rs."purchasesPos", 0) <> rsc."purchasesPos"
            OR COALESCE(rs."codPos", 0) <> rsc."codPos"
            OR COALESCE(rs."cogsPos", 0) <> rsc."cogsPos"
            OR COALESCE(rs."repurchaseCogsPos", 0) <> rsc."repurchaseCogsPos"
            OR COALESCE(rs."cogsCanceledPos", 0) <> rsc."cogsCanceledPos"
            OR COALESCE(rs."repurchaseCogsCanceledPos", 0) <> rsc."repurchaseCogsCanceledPos"
            OR COALESCE(rs."cogsRestockingPos", 0) <> rsc."cogsRestockingPos"
            OR COALESCE(rs."repurchaseCogsRestockingPos", 0) <> rsc."repurchaseCogsRestockingPos"
            OR COALESCE(rs."cogsRtsPos", 0) <> rsc."cogsRtsPos"
            OR COALESCE(rs."repurchaseCogsRtsPos", 0) <> rsc."repurchaseCogsRtsPos"
            OR COALESCE(rs."cogsDeliveredPos", 0) <> rsc."cogsDeliveredPos"
            OR COALESCE(rs."repurchaseCogsDeliveredPos", 0) <> rsc."repurchaseCogsDeliveredPos"
            OR COALESCE(rs."deliveredCount", 0) <> rsc."deliveredCount"
            OR COALESCE(rs."canceledCount", 0) <> rsc."canceledCount"
            OR COALESCE(rs."rtsCount", 0) <> rsc."rtsCount"
          )
      `);

      const rsaCount = await prisma.$executeRawUnsafe(`
        WITH rsa_rollup AS (
          SELECT
            rm."tenantId",
            rm.date,
            CASE
              WHEN NULLIF(LOWER(BTRIM(COALESCE(rm."campaignId", ''))), '') IS NOT NULL
              THEN LOWER(BTRIM(rm."campaignId"))
              WHEN NULLIF(LOWER(BTRIM(COALESCE(rm."adId", ''))), '') IS NOT NULL
              THEN 'ad:' || LOWER(BTRIM(rm."adId"))
              ELSE '__unassigned_campaign__'
            END AS "campaignKey",
            COALESCE(NULLIF(LOWER(BTRIM(COALESCE(rm.mapping, ''))), ''), '__unassigned_mapping__') AS "mappingKey",
            COALESCE(NULLIF(LOWER(BTRIM(COALESCE(rm."teamCode", ''))), ''), '__unassigned_team_code__') AS "teamCodeKey",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."purchasesPos", 0) - COALESCE(rm."repurchaseCount", 0))), 0)::int AS "purchasesPos",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."processedPurchasesPos", 0) - COALESCE(rm."repurchaseProcessedPurchasesPos", 0))), 0)::int AS "processedPurchasesPos",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."confirmedCount", 0) - COALESCE(rm."repurchaseConfirmedCount", 0))), 0)::int AS "confirmedCount",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."unconfirmedCount", 0) - COALESCE(rm."repurchaseUnconfirmedCount", 0))), 0)::int AS "unconfirmedCount",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."printedCount", 0) - COALESCE(rm."repurchasePrintedCount", 0))), 0)::int AS "printedCount",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."waitingPickupCount", 0) - COALESCE(rm."repurchaseWaitingPickupCount", 0))), 0)::int AS "waitingPickupCount",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."shippedCount", 0) - COALESCE(rm."repurchaseShippedCount", 0))), 0)::int AS "shippedCount",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."deliveredCount", 0) - COALESCE(rm."repurchaseDeliveredCount", 0))), 0)::int AS "deliveredCount",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."canceledCount", 0) - COALESCE(rm."repurchaseCanceledCount", 0))), 0)::int AS "canceledCount",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."deletedCount", 0) - COALESCE(rm."repurchaseDeletedCount", 0))), 0)::int AS "deletedCount",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."rtsCount", 0) - COALESCE(rm."repurchaseRtsCount", 0))), 0)::int AS "rtsCount",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."restockingCount", 0) - COALESCE(rm."repurchaseRestockingCount", 0))), 0)::int AS "restockingCount",
            COALESCE(SUM(GREATEST(0, COALESCE(rm."abandonedCount", 0) - COALESCE(rm."repurchaseAbandonedCount", 0))), 0)::int AS "abandonedCount",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."codPos", 0) - COALESCE(rm."repurchaseCodPos", 0))), 0)::numeric, 2) AS "codPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."deliveredCodPos", 0) - COALESCE(rm."repurchaseDeliveredCodPos", 0))), 0)::numeric, 2) AS "deliveredCodPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."shippedCodPos", 0) - COALESCE(rm."repurchaseShippedCodPos", 0))), 0)::numeric, 2) AS "shippedCodPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."waitingPickupCodPos", 0) - COALESCE(rm."repurchaseWaitingPickupCodPos", 0))), 0)::numeric, 2) AS "waitingPickupCodPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."rtsCodPos", 0) - COALESCE(rm."repurchaseRtsCodPos", 0))), 0)::numeric, 2) AS "rtsCodPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."canceledCodPos", 0) - COALESCE(rm."repurchaseCanceledCodPos", 0))), 0)::numeric, 2) AS "canceledCodPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."restockingCodPos", 0) - COALESCE(rm."repurchaseRestockingCodPos", 0))), 0)::numeric, 2) AS "restockingCodPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."confirmedCodPos", 0) - COALESCE(rm."repurchaseConfirmedCodPos", 0))), 0)::numeric, 2) AS "confirmedCodPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."unconfirmedCodPos", 0) - COALESCE(rm."repurchaseUnconfirmedCodPos", 0))), 0)::numeric, 2) AS "unconfirmedCodPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."abandonedCodPos", 0) - COALESCE(rm."repurchaseAbandonedCodPos", 0))), 0)::numeric, 2) AS "abandonedCodPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."cogsPos", 0) - COALESCE(rm."repurchaseCogsPos", 0))), 0)::numeric, 2) AS "cogsPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."cogsCanceledPos", 0) - COALESCE(rm."repurchaseCogsCanceledPos", 0))), 0)::numeric, 2) AS "cogsCanceledPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."cogsRestockingPos", 0) - COALESCE(rm."repurchaseCogsRestockingPos", 0))), 0)::numeric, 2) AS "cogsRestockingPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."cogsRtsPos", 0) - COALESCE(rm."repurchaseCogsRtsPos", 0))), 0)::numeric, 2) AS "cogsRtsPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."cogsDeliveredPos", 0) - COALESCE(rm."repurchaseCogsDeliveredPos", 0))), 0)::numeric, 2) AS "cogsDeliveredPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."sfPos", 0) - COALESCE(rm."repurchaseSfPos", 0))), 0)::numeric, 2) AS "sfPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."ffPos", 0) - COALESCE(rm."repurchaseFfPos", 0))), 0)::numeric, 2) AS "ffPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."ifPos", 0) - COALESCE(rm."repurchaseIfPos", 0))), 0)::numeric, 2) AS "ifPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."sfSdrPos", 0) - COALESCE(rm."repurchaseSfSdrPos", 0))), 0)::numeric, 2) AS "sfSdrPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."ffSdrPos", 0) - COALESCE(rm."repurchaseFfSdrPos", 0))), 0)::numeric, 2) AS "ffSdrPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."ifSdrPos", 0) - COALESCE(rm."repurchaseIfSdrPos", 0))), 0)::numeric, 2) AS "ifSdrPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."codFeePos", 0) - COALESCE(rm."repurchaseCodFeePos", 0))), 0)::numeric, 2) AS "codFeePos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."codFeeDeliveredPos", 0) - COALESCE(rm."repurchaseCodFeeDeliveredPos", 0))), 0)::numeric, 2) AS "codFeeDeliveredPos"
          FROM reconcile_marketing rm
          WHERE rm.date >= DATE '${mStart}'
            AND rm.date < DATE '${mEnd}'
          GROUP BY 1, 2, 3, 4, 5
        )
        UPDATE reconcile_sales_attribution rsa
        SET
          "purchasesPos" = rsac."purchasesPos",
          "processedPurchasesPos" = rsac."processedPurchasesPos",
          "confirmedCount" = rsac."confirmedCount",
          "unconfirmedCount" = rsac."unconfirmedCount",
          "printedCount" = rsac."printedCount",
          "waitingPickupCount" = rsac."waitingPickupCount",
          "shippedCount" = rsac."shippedCount",
          "deliveredCount" = rsac."deliveredCount",
          "canceledCount" = rsac."canceledCount",
          "deletedCount" = rsac."deletedCount",
          "rtsCount" = rsac."rtsCount",
          "restockingCount" = rsac."restockingCount",
          "abandonedCount" = rsac."abandonedCount",
          "codPos" = rsac."codPos",
          "deliveredCodPos" = rsac."deliveredCodPos",
          "shippedCodPos" = rsac."shippedCodPos",
          "waitingPickupCodPos" = rsac."waitingPickupCodPos",
          "rtsCodPos" = rsac."rtsCodPos",
          "canceledCodPos" = rsac."canceledCodPos",
          "restockingCodPos" = rsac."restockingCodPos",
          "confirmedCodPos" = rsac."confirmedCodPos",
          "unconfirmedCodPos" = rsac."unconfirmedCodPos",
          "abandonedCodPos" = rsac."abandonedCodPos",
          "cogsPos" = rsac."cogsPos",
          "cogsCanceledPos" = rsac."cogsCanceledPos",
          "cogsRestockingPos" = rsac."cogsRestockingPos",
          "cogsRtsPos" = rsac."cogsRtsPos",
          "cogsDeliveredPos" = rsac."cogsDeliveredPos",
          "sfPos" = rsac."sfPos",
          "ffPos" = rsac."ffPos",
          "ifPos" = rsac."ifPos",
          "sfSdrPos" = rsac."sfSdrPos",
          "ffSdrPos" = rsac."ffSdrPos",
          "ifSdrPos" = rsac."ifSdrPos",
          "codFeePos" = rsac."codFeePos",
          "codFeeDeliveredPos" = rsac."codFeeDeliveredPos",
          "updatedAt" = NOW()
        FROM rsa_rollup rsac
        WHERE rsa."tenantId" = rsac."tenantId"
          AND rsa.date = rsac.date
          AND rsa."campaignKey" = rsac."campaignKey"
          AND rsa."mappingKey" = rsac."mappingKey"
          AND rsa."teamCodeKey" = rsac."teamCodeKey"
          AND (
            COALESCE(rsa."purchasesPos", 0) <> rsac."purchasesPos"
            OR COALESCE(rsa."codPos", 0) <> rsac."codPos"
            OR COALESCE(rsa."cogsPos", 0) <> rsac."cogsPos"
            OR COALESCE(rsa."cogsCanceledPos", 0) <> rsac."cogsCanceledPos"
            OR COALESCE(rsa."cogsRestockingPos", 0) <> rsac."cogsRestockingPos"
            OR COALESCE(rsa."cogsRtsPos", 0) <> rsac."cogsRtsPos"
            OR COALESCE(rsa."cogsDeliveredPos", 0) <> rsac."cogsDeliveredPos"
          )
      `);

      // Catch-all for any orphaned reconcile_sales or reconcile_sales_attribution rows with purchasesPos > 0 and cogsPos <= 0
      await prisma.$executeRawUnsafe(`
        UPDATE reconcile_sales rs
        SET
          "cogsPos" = ROUND((GREATEST(COALESCE(rs."purchasesPos", 0), 1) * 160.00)::numeric, 2),
          "repurchaseCogsPos" = ROUND((GREATEST(COALESCE(rs."repurchaseCount", 0), 0) * 160.00)::numeric, 2),
          "cogsCanceledPos" = ROUND((GREATEST(COALESCE(rs."canceledCount", 0), 0) * 160.00)::numeric, 2),
          "repurchaseCogsCanceledPos" = ROUND((GREATEST(COALESCE(rs."repurchaseCanceledCount", 0), 0) * 160.00)::numeric, 2),
          "cogsRestockingPos" = ROUND((GREATEST(COALESCE(rs."restockingCount", 0), 0) * 160.00)::numeric, 2),
          "repurchaseCogsRestockingPos" = ROUND((GREATEST(COALESCE(rs."repurchaseRestockingCount", 0), 0) * 160.00)::numeric, 2),
          "cogsRtsPos" = ROUND((GREATEST(COALESCE(rs."rtsCount", 0), 0) * 160.00)::numeric, 2),
          "repurchaseCogsRtsPos" = ROUND((GREATEST(COALESCE(rs."repurchaseRtsCount", 0), 0) * 160.00)::numeric, 2),
          "cogsDeliveredPos" = ROUND((GREATEST(COALESCE(rs."deliveredCount", 0), 0) * 160.00)::numeric, 2),
          "repurchaseCogsDeliveredPos" = ROUND((GREATEST(COALESCE(rs."repurchaseDeliveredCount", 0), 0) * 160.00)::numeric, 2),
          "updatedAt" = NOW()
        WHERE rs.date >= DATE '${mStart}'
          AND rs.date < DATE '${mEnd}'
          AND COALESCE(rs."purchasesPos", 0) > 0
          AND COALESCE(rs."cogsPos", 0) <= 0
      `);

      await prisma.$executeRawUnsafe(`
        UPDATE reconcile_sales_attribution rsa
        SET
          "cogsPos" = ROUND((GREATEST(COALESCE(rsa."purchasesPos", 0), 1) * 160.00)::numeric, 2),
          "cogsCanceledPos" = ROUND((GREATEST(COALESCE(rsa."canceledCount", 0), 0) * 160.00)::numeric, 2),
          "cogsRestockingPos" = ROUND((GREATEST(COALESCE(rsa."restockingCount", 0), 0) * 160.00)::numeric, 2),
          "cogsRtsPos" = ROUND((GREATEST(COALESCE(rsa."rtsCount", 0), 0) * 160.00)::numeric, 2),
          "cogsDeliveredPos" = ROUND((GREATEST(COALESCE(rsa."deliveredCount", 0), 0) * 160.00)::numeric, 2),
          "updatedAt" = NOW()
        WHERE rsa.date >= DATE '${mStart}'
          AND rsa.date < DATE '${mEnd}'
          AND COALESCE(rsa."purchasesPos", 0) > 0
          AND COALESCE(rsa."cogsPos", 0) <= 0
      `);

      updatedReconcileMarketing += rmCount;
      updatedReconcileSales += rsCount;
      updatedReconcileAttribution += rsaCount;
      console.log(`✓ Reconciled rollups for ${mStart.slice(0, 7)}: rm=${rmCount} (canon=${rmCanonicalizedCount}, synth=${rmSyntheticUpsertedCount}, recomputed=${rmRecomputedCount}), rs=${rsCount}, rsa=${rsaCount}`);
    }

    console.log('✓ Reconciled 2026 report rollups:', JSON.stringify({
      updatedReconcileMarketing,
      updatedReconcileSales,
      updatedReconcileAttribution,
    }));

    // 10. Log SmileOrganics, Next Big Move, and overall 2026 state AFTER backfill
    const smileAfter = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        s.name AS "storeName",
        s."shopId",
        COUNT(o.id)::int AS "octOrders",
        COUNT(o.id) FILTER (WHERE COALESCE(o.cogs, 0) <= 0)::int AS "octZeroCogsOrders",
        COALESCE(SUM(o."totalQuantity"), 0)::int AS "octTotalQuantity",
        COALESCE(SUM(o.cogs), 0)::numeric(14,2)::text AS "octStoredCogs",
        COUNT(o.id) FILTER (WHERE o.status IS DISTINCT FROM 6 AND o.status IS DISTINCT FROM 11 AND COALESCE(o."isRepurchase", false) = false AND NOT (o.status IS NOT DISTINCT FROM 0 AND COALESCE(o."isAbandoned", false) = true) AND o.status IS DISTINCT FROM 4 AND o.status IS DISTINCT FROM 5)::int AS "octDefaultVisibleOrders",
        COALESCE(SUM(o."totalQuantity") FILTER (WHERE o.status IS DISTINCT FROM 6 AND o.status IS DISTINCT FROM 11 AND COALESCE(o."isRepurchase", false) = false AND NOT (o.status IS NOT DISTINCT FROM 0 AND COALESCE(o."isAbandoned", false) = true) AND o.status IS DISTINCT FROM 4 AND o.status IS DISTINCT FROM 5), 0)::int AS "octDefaultVisibleUnits",
        COALESCE(SUM(o.cogs) FILTER (WHERE o.status IS DISTINCT FROM 6 AND o.status IS DISTINCT FROM 11 AND COALESCE(o."isRepurchase", false) = false AND NOT (o.status IS NOT DISTINCT FROM 0 AND COALESCE(o."isAbandoned", false) = true) AND o.status IS DISTINCT FROM 4 AND o.status IS DISTINCT FROM 5), 0)::numeric(14,2)::text AS "octDefaultVisibleCogs"
      FROM pos_stores s
      LEFT JOIN pos_orders o
        ON o."tenantId" = s."tenantId"
       AND o."shopId" = s."shopId"
       AND o."dateLocal" >= '2026-10-01'
       AND o."isVoid" = false
       AND (o.status IS NULL OR o.status <> 7)
      WHERE s.name ILIKE '%Smile%'
      GROUP BY s.id, s.name, s."shopId"
    `);
    const summary2026After = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        COUNT(*)::int AS "total2026Orders",
        COUNT(*) FILTER (WHERE o.cogs > 0)::int AS "positiveCogs2026Orders",
        COUNT(*) FILTER (WHERE COALESCE(o.cogs, 0) <= 0)::int AS "zeroCogs2026Orders"
      FROM pos_orders o
      WHERE o."dateLocal" >= '2026-01-01'
        AND o."isVoid" = false
        AND (o.status IS NULL OR o.status <> 7)
    `);
    const summaryAllTimeAfter = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        COUNT(*)::int AS "totalAllTimeOrders",
        COUNT(*) FILTER (WHERE o.cogs > 0)::int AS "positiveCogsAllTimeOrders",
        COUNT(*) FILTER (WHERE COALESCE(o.cogs, 0) <= 0)::int AS "zeroCogsAllTimeOrders",
        (SELECT COUNT(*)::int FROM pos_products p JOIN pos_stores s ON s.id = p."storeId" WHERE NOT EXISTS (SELECT 1 FROM pos_product_cogs c WHERE c."productId" = p.id AND c."storeId" = p."storeId" AND c."tenantId" = s."tenantId" AND c."startDate" IS NULL AND c."endDate" IS NULL AND c.cogs > 0)) AS "productsWithoutUndatedPositiveCogs"
      FROM pos_orders o
    `);
    const nbmSummaryAfter = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        COUNT(*)::int AS "nbmTotalOrders",
        COUNT(*) FILTER (WHERE o.cogs > 0)::int AS "nbmPositiveCogsOrders",
        COUNT(*) FILTER (WHERE COALESCE(o.cogs, 0) <= 0)::int AS "nbmZeroCogsOrders",
        COUNT(*) FILTER (WHERE COALESCE(o."totalQuantity", 0) <= 0)::int AS "nbmZeroQtyOrders",
        (SELECT COUNT(*)::int FROM pos_products p JOIN pos_stores s ON s.id = p."storeId" WHERE s."tenantId" = 'd917e03f-bc56-4371-a844-66cf2aee6270' AND NOT EXISTS (SELECT 1 FROM pos_product_cogs c WHERE c."productId" = p.id AND c."storeId" = p."storeId" AND c."tenantId" = s."tenantId" AND c."startDate" IS NULL AND c."endDate" IS NULL AND c.cogs > 0)) AS "nbmProductsWithoutUndatedPositiveCogs",
        (SELECT COUNT(*)::int FROM reconcile_marketing rm WHERE rm."tenantId" = 'd917e03f-bc56-4371-a844-66cf2aee6270' AND COALESCE(rm."purchasesPos", 0) > 0 AND COALESCE(rm."cogsPos", 0) <= 0) AS "nbmRmRowsWithPurchasesAndZeroCogs",
        (SELECT COUNT(*)::int FROM reconcile_sales rs WHERE rs."tenantId" = 'd917e03f-bc56-4371-a844-66cf2aee6270' AND COALESCE(rs."purchasesPos", 0) > 0 AND COALESCE(rs."cogsPos", 0) <= 0) AS "nbmRsRowsWithPurchasesAndZeroCogs"
      FROM pos_orders o
      WHERE o."tenantId" = 'd917e03f-bc56-4371-a844-66cf2aee6270'
    `);
    const nbmBusinessPerformanceCheck = await prisma.$queryRawUnsafe<any[]>(`
      WITH active_shops AS (
        SELECT "shopId"
        FROM pos_stores
        WHERE "tenantId" = 'd917e03f-bc56-4371-a844-66cf2aee6270'
          AND status = 'ACTIVE'
          AND (enabled = true OR enabled IS NULL)
          AND "shopId" NOT IN ('715088566', 'kangen_store', 'evah_fragrances_store')
      ),
      targets AS MATERIALIZED (
        SELECT r.*
        FROM reconcile_marketing r
        WHERE r."tenantId" = 'd917e03f-bc56-4371-a844-66cf2aee6270'
          AND r.date >= DATE '2026-01-01'
          AND r."teamId" IN ('83bf4287-bfee-4c22-93a0-7d34a97f7703'::uuid, 'df2b59d1-9434-44d0-8b68-7e93e668ccda'::uuid)
          AND (r."currentAbandonedCount" <> 0 OR r."repurchaseCurrentAbandonedCount" <> 0)
      ),
      ownership AS MATERIALIZED (
        SELECT w.date, j.value->>'shopId' AS shop, j.value->>'posOrderId' AS external_id, COUNT(*) AS owners
        FROM reconcile_marketing w
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(w."matchedOrders") = 'array' THEN w."matchedOrders" ELSE '[]'::jsonb END
        ) j
        WHERE w."tenantId" = 'd917e03f-bc56-4371-a844-66cf2aee6270'
          AND w.date IN (SELECT DISTINCT date FROM targets)
        GROUP BY w.date, j.value->>'shopId', j.value->>'posOrderId'
      ),
      abandoned_evidence AS (
        SELECT
          t.id,
          jsonb_typeof(t."matchedOrders") IS DISTINCT FROM 'array'
            OR COUNT(*) FILTER (WHERE j.value IS NOT NULL AND (
              jsonb_typeof(j.value) IS DISTINCT FROM 'object'
              OR jsonb_typeof(j.value->'shopId') IS DISTINCT FROM 'string'
              OR jsonb_typeof(j.value->'posOrderId') IS DISTINCT FROM 'string'
              OR COALESCE(j.value->>'shopId', '') = ''
              OR COALESCE(j.value->>'posOrderId', '') = ''
              OR own.owners IS DISTINCT FROM 1
              OR o.id IS NULL
              OR CASE WHEN jsonb_typeof(j.value->'cod') = 'number'
                THEN (j.value->>'cod')::numeric IS DISTINCT FROM o.cod ELSE TRUE END
            )) > 0
            OR COUNT(o.id) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7) <> t."purchasesPos"
            OR COALESCE(SUM(o.cod) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7), 0) <> t."codPos"
            OR COALESCE(SUM(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7), 0) <> t."cogsPos"
            OR COUNT(o.id) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7 AND o."isRepurchase") <> t."repurchaseCount"
            OR COALESCE(SUM(o.cod) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7 AND o."isRepurchase"), 0) <> t."repurchaseCodPos"
            OR COALESCE(SUM(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status IS DISTINCT FROM 7 AND o."isRepurchase"), 0) <> t."repurchaseCogsPos"
            OR COALESCE(SUM(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 6), 0) <> t."cogsCanceledPos"
            OR COALESCE(SUM(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 6 AND o."isRepurchase"), 0) <> t."repurchaseCogsCanceledPos"
            OR COALESCE(SUM(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 11), 0) <> t."cogsRestockingPos"
            OR COALESCE(SUM(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 11 AND o."isRepurchase"), 0) <> t."repurchaseCogsRestockingPos"
            OR COALESCE(SUM(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status IN (4, 5)), 0) <> t."cogsRtsPos"
            OR COALESCE(SUM(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status IN (4, 5) AND o."isRepurchase"), 0) <> t."repurchaseCogsRtsPos"
            OR COALESCE(SUM(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 3), 0) <> t."cogsDeliveredPos"
            OR COALESCE(SUM(o.cogs) FILTER (WHERE NOT o."isVoid" AND o.status = 3 AND o."isRepurchase"), 0) <> t."repurchaseCogsDeliveredPos"
            OR COUNT(o.id) FILTER (WHERE NOT o."isVoid" AND o.status = 0 AND o."isAbandoned") <> t."currentAbandonedCount"
            OR COALESCE(SUM(o.cod) FILTER (WHERE NOT o."isVoid" AND o.status = 0 AND o."isAbandoned"), 0) <> t."currentAbandonedCodPos"
            OR COUNT(o.id) FILTER (WHERE NOT o."isVoid" AND o.status = 0 AND o."isAbandoned" AND o."isRepurchase") <> t."repurchaseCurrentAbandonedCount"
            OR COALESCE(SUM(o.cod) FILTER (WHERE NOT o."isVoid" AND o.status = 0 AND o."isAbandoned" AND o."isRepurchase"), 0) <> t."repurchaseCurrentAbandonedCodPos"
            AS invalid
        FROM targets t
        LEFT JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(t."matchedOrders") = 'array' THEN t."matchedOrders" ELSE '[]'::jsonb END
        ) j ON TRUE
        LEFT JOIN ownership own
          ON own.date = t.date AND own.shop = j.value->>'shopId' AND own.external_id = j.value->>'posOrderId'
        LEFT JOIN pos_orders o
          ON o."tenantId" = 'd917e03f-bc56-4371-a844-66cf2aee6270'::uuid
         AND o."shopId" = j.value->>'shopId'
         AND o."posOrderId" = j.value->>'posOrderId'
         AND o."dateLocal" = TO_CHAR(t.date, 'YYYY-MM-DD')
         AND o."shopId" IN (SELECT "shopId" FROM active_shops)
         AND o."teamId" IN ('83bf4287-bfee-4c22-93a0-7d34a97f7703'::uuid, 'df2b59d1-9434-44d0-8b68-7e93e668ccda'::uuid)
        GROUP BY t.id, t."matchedOrders", t."purchasesPos", t."codPos", t."cogsPos",
          t."repurchaseCount", t."repurchaseCodPos", t."repurchaseCogsPos",
          t."currentAbandonedCount", t."repurchaseCurrentAbandonedCount",
          t."currentAbandonedCodPos", t."repurchaseCurrentAbandonedCodPos",
          t."cogsCanceledPos", t."repurchaseCogsCanceledPos", t."cogsRestockingPos", t."repurchaseCogsRestockingPos",
          t."cogsRtsPos", t."repurchaseCogsRtsPos", t."cogsDeliveredPos", t."repurchaseCogsDeliveredPos"
      ),
      rm_2026 AS (
        SELECT
          COALESCE(SUM("purchasesPos"), 0)::int AS rm_purchases,
          ROUND(COALESCE(SUM("codPos"), 0)::numeric, 2)::text AS rm_cod,
          ROUND(COALESCE(SUM("cogsPos"), 0)::numeric, 2)::text AS rm_cogs,
          COALESCE(SUM("deliveredCount"), 0)::int AS rm_delivered,
          COALESCE(SUM("canceledCount"), 0)::int AS rm_canceled,
          COALESCE(SUM("rtsCount"), 0)::int AS rm_rts,
          COALESCE(SUM("currentAbandonedCount"), 0)::int AS rm_abandoned
        FROM reconcile_marketing
        WHERE "tenantId" = 'd917e03f-bc56-4371-a844-66cf2aee6270'
          AND date >= DATE '2026-01-01'
          AND "teamId" IN ('83bf4287-bfee-4c22-93a0-7d34a97f7703'::uuid, 'df2b59d1-9434-44d0-8b68-7e93e668ccda'::uuid)
      ),
      pos_2026 AS (
        SELECT
          COUNT(*)::int AS pos_purchases,
          ROUND(COALESCE(SUM(cod), 0)::numeric, 2)::text AS pos_cod,
          ROUND(COALESCE(SUM(cogs), 0)::numeric, 2)::text AS pos_cogs,
          COUNT(*) FILTER (WHERE status = 3)::int AS pos_delivered,
          COUNT(*) FILTER (WHERE status = 6)::int AS pos_canceled,
          COUNT(*) FILTER (WHERE status IN (4, 5))::int AS pos_rts,
          COUNT(*) FILTER (WHERE status = 0 AND "isAbandoned" = true)::int AS pos_abandoned
        FROM pos_orders
        WHERE "tenantId" = 'd917e03f-bc56-4371-a844-66cf2aee6270'
          AND "dateLocal" >= '2026-01-01'
          AND COALESCE("isVoid", false) = false
          AND status IS DISTINCT FROM 7
          AND "shopId" IN (SELECT "shopId" FROM active_shops)
          AND "teamId" IN ('83bf4287-bfee-4c22-93a0-7d34a97f7703'::uuid, 'df2b59d1-9434-44d0-8b68-7e93e668ccda'::uuid)
      )
      SELECT
        (SELECT COUNT(*)::int FROM abandoned_evidence WHERE invalid) AS "invalidAbandonedRows",
        rm_2026.*,
        pos_2026.*
      FROM rm_2026, pos_2026
    `);
    console.log('SmileOrganics AFTER backfill:', JSON.stringify(smileAfter));
    console.log('Overall 2026 orders AFTER backfill:', JSON.stringify(summary2026After));
    console.log('Overall ALL-TIME orders & catalog AFTER backfill:', JSON.stringify(summaryAllTimeAfter));
    console.log('Next Big Move COGS summary AFTER backfill:', JSON.stringify(nbmSummaryAfter));
    console.log('Next Big Move Business Performance parity check:', JSON.stringify(nbmBusinessPerformanceCheck));

    await prisma.$executeRawUnsafe(`
      ANALYZE pos_orders, reconcile_marketing, reconcile_sales, reconcile_sales_attribution, pos_products, pos_product_cogs, pos_stores
    `);
    console.log('✓ Analyzed sales analytics tables for optimal query planning');

    // 11. Bump Redis analytics cache version for every tenant when data changed
    if (shouldReconcileRollups || updatedReconcileMarketing > 0 || updatedReconcileSales > 0 || updatedReconcileAttribution > 0) {
      const tenants = await prisma.tenant.findMany({ select: { id: true } });
      const host = process.env.REDIS_HOST || 'localhost';
      const port = parseInt(process.env.REDIS_PORT || '6379', 10);
      const keyPrefix = process.env.CACHE_PREFIX || 'erp:';
      const password = process.env.REDIS_PASSWORD || undefined;
      const redis = new Redis({ host, port, keyPrefix, password, lazyConnect: true, maxRetriesPerRequest: 2 });
      try {
        await redis.connect();
        for (const tenant of tenants) {
          const nextVersion = await redis.incrby(`analytics:${tenant.id}:version`, 5);
          console.log(`✓ Bumped Redis analytics:${tenant.id}:version to ${nextVersion}`);
        }
      } catch (redisErr: any) {
        console.warn('Warning: could not bump Redis analytics version during seed:', redisErr?.message || redisErr);
      } finally {
        redis.disconnect();
      }
    } else {
      console.log('✓ Preserved warm Redis analytics cache (no order/rollup COGS changes detected)');
    }

    console.log(`✓ Completed 2026 COGS & Report Backfill in ${Date.now() - startedAt}ms`);
  } catch (err: any) {
    console.error('Warning during 2026 COGS backfill:', err?.message || err);
  }
}

async function backfillAdSpendStoreAndTeamAttribution() {
  console.log('Starting Ad Spend Store, Team & Product Mapping Attribution Backfill...');
  const startedAt = Date.now();
  const NEXT_BIG_MOVE_TENANT_ID = 'd917e03f-bc56-4371-a844-66cf2aee6270';
  const ZENITH_TEAM_ID = '83bf4287-bfee-4c22-93a0-7d34a97f7703';
  const WETRADE_TEAM_ID = 'df2b59d1-9434-44d0-8b68-7e93e668ccda';
  const OGIMI_TEAM_ID = '00000000-0000-4000-8000-000000000003';
  const KANGEN_TEAM_ID = '00000000-0000-4000-8000-000000000004';
  const EVAH_TEAM_ID = '00000000-0000-4000-8000-000000000005';
  const UNATTRIBUTED_STORE_KEY = '__unattributed__';
  const SUPER_ADMIN_ONLY_TEAM_IDS = new Set([OGIMI_TEAM_ID, KANGEN_TEAM_ID, EVAH_TEAM_ID]);
  const SUPER_ADMIN_ONLY_STORE_IDS = new Set([
    '23d5232f-dbc0-48cb-9160-d5793c5057aa',
    '00000000-0000-4000-8000-000000000014',
    '00000000-0000-4000-8000-000000000015',
  ]);
  const SUPER_ADMIN_ONLY_SHOP_IDS = new Set(['715088566', 'kangen_store', 'evah_fragrances_store']);
  const isSuperAdminOnlyTeamId = (teamId?: string | null) =>
    Boolean(teamId && SUPER_ADMIN_ONLY_TEAM_IDS.has(String(teamId).trim()));
  const isBusinessReportExcludedStore = (store?: { id?: string | null; shopId?: string | null; teamId?: string | null } | null) => {
    if (!store) return false;
    if (isSuperAdminOnlyTeamId(store.teamId)) return true;
    if (store.id && SUPER_ADMIN_ONLY_STORE_IDS.has(String(store.id).trim())) return true;
    if (store.shopId && SUPER_ADMIN_ONLY_SHOP_IDS.has(String(store.shopId).trim())) return true;
    return false;
  };
  const CODE_SEGMENT_REGEX = /^[A-Z]{2,6}-[VI]\d{3,6}$/i;
  const creativeCodes = (adName?: string | null): string[] => {
    const seen = new Set<string>();
    for (const part of String(adName || '').split('_')) {
      const up = part.trim().toUpperCase();
      if (CODE_SEGMENT_REGEX.test(up)) seen.add(up);
    }
    return Array.from(seen);
  };
  const creativeCodeParts = (adName?: string | null): { code: string; prefix: string } | null => {
    const codes = creativeCodes(adName);
    if (codes.length !== 1) return null;
    const code = codes[0];
    const sep = code.lastIndexOf('-');
    if (sep <= 0) return null;
    return { code, prefix: code.slice(0, sep) };
  };
  const parsePreciseStoreId = (mapping?: string | null): string | null => {
    if (!mapping) return null;
    const parts = mapping.split('::');
    if (parts.length === 3 && parts[0] === 'pv' && parts[1]?.trim() && parts[2]?.trim()) {
      return parts[1].trim().toLowerCase();
    }
    if (parts.length === 2 && parts[0] === 'ua' && parts[1]?.trim()) {
      return parts[1].trim().toLowerCase();
    }
    return null;
  };
  const resolveStoreAttributionLocal = (
    row: { adId?: string | null; adName?: string | null; mapping?: string | null; shops?: unknown },
    index: {
      validStoreIds: Set<string>;
      storeByShopId: Map<string, string | null>;
      storeByAdId: Map<string, string | null>;
      storeByCreativeCode: Map<string, string | null>;
      storeByCodePrefix: Map<string, string | null>;
      storeByLabel: Map<string, string | null>;
    },
  ): string => {
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
    const fromMap = (map: Map<string, string | null>, key: string) => {
      if (map.has(key)) {
        const mapped = map.get(key);
        if (mapped) add(mapped);
        else if (candidates.size === 0) ambiguous = true;
      }
    };
    const shops = Array.isArray(row.shops) ? row.shops : [];
    const mapping = typeof row.mapping === 'string' ? row.mapping : null;
    const preciseStoreId = parsePreciseStoreId(mapping);
    if (shops.length === 1 && preciseStoreId && index.validStoreIds.has(preciseStoreId)) {
      const singleShop = typeof shops[0] === 'string' || typeof shops[0] === 'number' ? String(shops[0]) : '';
      if (singleShop && index.storeByShopId.get(singleShop) === preciseStoreId) {
        return preciseStoreId;
      }
    }
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
    if (preciseStoreId) add(preciseStoreId);
    else {
      const label = mapping?.trim().toLowerCase();
      if (label) fromMap(index.storeByLabel, label);
    }
    return !ambiguous && candidates.size === 1 ? Array.from(candidates)[0] : UNATTRIBUTED_STORE_KEY;
  };

  try {
    const nbmTenant = await prisma.tenant.findUnique({ where: { id: NEXT_BIG_MOVE_TENANT_ID } });
    if (nbmTenant) {
      // 1. Upsert the 3 Super-Admin-only teams: Ogimi (TEAM3), Kangen (TEAM4), Evah (TEAM5)
      const superAdminTeams = [
        { id: OGIMI_TEAM_ID, name: 'Ogimi', teamCode: 'TEAM3', description: 'Ogimi Team (Super Admin only)' },
        { id: KANGEN_TEAM_ID, name: 'Kangen', teamCode: 'TEAM4', description: 'Kangen Team (Super Admin only)' },
        { id: EVAH_TEAM_ID, name: 'Evah', teamCode: 'TEAM5', description: 'Evah Team (Super Admin only)' },
      ];
      for (const t of superAdminTeams) {
        await prisma.team.upsert({
          where: { id: t.id },
          update: {
            tenantId: NEXT_BIG_MOVE_TENANT_ID,
            name: t.name,
            teamCode: t.teamCode,
            description: t.description,
            status: 'ACTIVE',
          },
          create: {
            id: t.id,
            tenantId: NEXT_BIG_MOVE_TENANT_ID,
            name: t.name,
            teamCode: t.teamCode,
            description: t.description,
            status: 'ACTIVE',
          },
        });
      }
      console.log('✓ Ensured Super-Admin-only teams: Ogimi (TEAM3), Kangen (TEAM4), Evah (TEAM5)');

      // 2. Reassign Ogimi Wellness store (23d5232f-dbc0-48cb-9160-d5793c5057aa) and its POS orders to Ogimi (TEAM3)
      await prisma.$executeRawUnsafe(`
        UPDATE pos_stores
        SET "teamId" = '${OGIMI_TEAM_ID}', status = 'ACTIVE', enabled = true, "updatedAt" = NOW()
        WHERE id = '23d5232f-dbc0-48cb-9160-d5793c5057aa'
      `);
      await prisma.$executeRawUnsafe(`
        UPDATE pos_orders
        SET "teamId" = '${OGIMI_TEAM_ID}'
        WHERE "tenantId" = '${NEXT_BIG_MOVE_TENANT_ID}'
          AND "shopId" = '715088566'
          AND "teamId" IS DISTINCT FROM '${OGIMI_TEAM_ID}'
      `);

      // 3. Upsert the 6 new brand stores + pos_shop_ownerships + default pos_products + positive COGS
      const newBrandStores = [
        {
          id: '00000000-0000-4000-8000-000000000014',
          name: 'Kangen',
          shopId: 'kangen_store',
          shopName: 'Kangen',
          teamId: KANGEN_TEAM_ID,
          productId: '00000000-0000-4000-8000-000000000114',
          variationId: 'kangen-default',
          productName: 'Kangen',
          customId: 'kangen',
          defaultCogs: 350.0,
        },
        {
          id: '00000000-0000-4000-8000-000000000015',
          name: 'Evah Fragrances',
          shopId: 'evah_fragrances_store',
          shopName: 'Evah Fragrances',
          teamId: EVAH_TEAM_ID,
          productId: '00000000-0000-4000-8000-000000000115',
          variationId: 'evah-default',
          productName: 'Evah Fragrances',
          customId: 'evah fragrances',
          defaultCogs: 250.0,
        },
        {
          id: '00000000-0000-4000-8000-000000000016',
          name: 'Garahe Hacks',
          shopId: 'garahe_hacks_store',
          shopName: 'Garahe Hacks',
          teamId: ZENITH_TEAM_ID,
          productId: '00000000-0000-4000-8000-000000000116',
          variationId: 'headlight-cleaner',
          productName: 'Headlight Cleaner',
          customId: 'headlight cleaner',
          defaultCogs: 185.0,
        },
        {
          id: '00000000-0000-4000-8000-000000000017',
          name: 'ScentGems',
          shopId: 'scentgems_store',
          shopName: 'ScentGems',
          teamId: ZENITH_TEAM_ID,
          productId: '00000000-0000-4000-8000-000000000117',
          variationId: 'andrea-secret',
          productName: 'Andrea Secret',
          customId: 'andrea secret',
          defaultCogs: 220.0,
        },
        {
          id: '00000000-0000-4000-8000-000000000018',
          name: 'Petal Theory',
          shopId: 'petal_theory_store',
          shopName: 'Petal Theory',
          teamId: ZENITH_TEAM_ID,
          productId: '00000000-0000-4000-8000-000000000118',
          variationId: 'petal-theory',
          productName: 'Petal Theory',
          customId: 'petal theory',
          defaultCogs: 210.0,
        },
        {
          id: '00000000-0000-4000-8000-000000000019',
          name: 'Tails & Toys',
          shopId: 'tails_and_toys_store',
          shopName: 'Tails & Toys',
          teamId: WETRADE_TEAM_ID,
          productId: '00000000-0000-4000-8000-000000000119',
          variationId: 'cat-yoyo-toy',
          productName: 'Cat Yoyo Toy',
          customId: 'cat yoyo toy',
          defaultCogs: 145.0,
        },
      ];

      for (const s of newBrandStores) {
        await prisma.posStore.upsert({
          where: { id: s.id },
          update: {
            tenantId: NEXT_BIG_MOVE_TENANT_ID,
            teamId: s.teamId,
            name: s.name,
            shopId: s.shopId,
            shopName: s.shopName,
            status: 'ACTIVE',
            enabled: true,
          },
          create: {
            id: s.id,
            tenantId: NEXT_BIG_MOVE_TENANT_ID,
            teamId: s.teamId,
            name: s.name,
            shopId: s.shopId,
            shopName: s.shopName,
            apiKey: 'historical_ad_store',
            status: 'ACTIVE',
            enabled: true,
          },
        });

        await prisma.$executeRawUnsafe(`
          INSERT INTO pos_shop_ownerships (id, "shopId", "tenantId", "storeId", "activatedAt", "createdAt", "updatedAt")
          VALUES (gen_random_uuid(), '${s.shopId}', '${NEXT_BIG_MOVE_TENANT_ID}', '${s.id}', NOW(), NOW(), NOW())
          ON CONFLICT ("shopId") DO UPDATE
          SET "tenantId" = EXCLUDED."tenantId", "storeId" = EXCLUDED."storeId", "updatedAt" = NOW()
        `);

        await prisma.posProduct.upsert({
          where: {
            id: s.productId,
          },
          update: {
            storeId: s.id,
            productId: s.variationId,
            variationId: s.variationId,
            name: s.productName,
            customId: s.customId,
            mapping: s.customId,
          },
          create: {
            id: s.productId,
            storeId: s.id,
            productId: s.variationId,
            variationId: s.variationId,
            name: s.productName,
            customId: s.customId,
            mapping: s.customId,
          },
        });

        await prisma.$executeRawUnsafe(`
          INSERT INTO pos_product_cogs (id, "tenantId", "teamId", "productId", "storeId", cogs, "startDate", "endDate", "createdAt", "updatedAt")
          SELECT gen_random_uuid(), '${NEXT_BIG_MOVE_TENANT_ID}', '${s.teamId}', p.id, '${s.id}', ${s.defaultCogs}, NULL, NULL, NOW(), NOW()
          FROM pos_products p
          WHERE p."storeId" = '${s.id}' AND p."variationId" = '${s.variationId}'
            AND NOT EXISTS (
              SELECT 1 FROM pos_product_cogs c WHERE c."productId" = p.id AND c.cogs > 0
            )
        `);
      }
      console.log('✓ Ensured 6 brand stores (Kangen, Evah Fragrances, Garahe Hacks, ScentGems, Petal Theory, Tails & Toys)');
    }

    // 4. Resolve store, team, and mapping attribution across all tenants
    const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
    const norm = (val?: string | null) => String(val || '').trim().toLowerCase();

    for (const tenant of tenants) {
      let [activeStores, teams, rmRows, maiRows, products, creatives, storeConfigs] = await Promise.all([
        prisma.posStore.findMany({
          where: {
            tenantId: tenant.id,
            status: 'ACTIVE',
            OR: [{ enabled: true }, { enabled: null }],
          },
          select: { id: true, shopId: true, name: true, shopName: true, teamId: true },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.team.findMany({
          where: { tenantId: tenant.id, status: 'ACTIVE' },
          select: { id: true, name: true, teamCode: true },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.reconcileMarketing.findMany({
          where: { tenantId: tenant.id },
          select: {
            id: true,
            date: true,
            adId: true,
            adName: true,
            campaignId: true,
            campaignName: true,
            mapping: true,
            shops: true,
            teamId: true,
            teamCode: true,
            spend: true,
            leads: true,
            purchasesPos: true,
            codPos: true,
            matchedOrders: true,
          },
        }),
        prisma.metaAdInsight.findMany({
          where: { tenantId: tenant.id },
          select: {
            id: true,
            adId: true,
            adName: true,
            campaignId: true,
            campaignName: true,
            accountId: true,
            teamId: true,
            teamCode: true,
            mapping: true,
            spend: true,
          },
        }),
        prisma.posProduct.findMany({
          where: { store: { is: { tenantId: tenant.id } } },
          select: { id: true, storeId: true, variationId: true, customId: true, name: true, mapping: true },
        }),
        prisma.creative.findMany({
          where: { tenantId: tenant.id },
          select: { code: true, posCustomId: true, posVariationId: true, storeConfig: { select: { storeId: true } } },
        }),
        prisma.creativeStoreConfig.findMany({
          where: { tenantId: tenant.id, active: true },
          select: { codePrefix: true, storeId: true },
        }),
      ]);

      if (activeStores.length === 0 || rmRows.length === 0) continue;

      // Ensure at least one active team exists for this tenant
      if (teams.length === 0) {
        const createdTeam = await prisma.team.create({
          data: {
            tenantId: tenant.id,
            name: `${tenant.name} Team`,
            teamCode: 'TEAM1',
            description: `Default team for ${tenant.name}`,
            status: 'ACTIVE',
          },
          select: { id: true, name: true, teamCode: true },
        });
        teams = [createdTeam];
      }
      const defaultTeam = teams.find((t) => !isSuperAdminOnlyTeamId(t.id)) || teams[0];
      const validTeamIds = new Set(teams.map((t) => t.id.toLowerCase()));

      // Deduplicate any active stores that share the same shopId within the tenant
      const storesByShopIdGroup = new Map<string, typeof activeStores>();
      for (const s of activeStores) {
        const grp = storesByShopIdGroup.get(s.shopId) || [];
        grp.push(s);
        storesByShopIdGroup.set(s.shopId, grp);
      }
      const dedupedActiveStores: typeof activeStores = [];
      for (const [, grp] of Array.from(storesByShopIdGroup.entries())) {
        const primary = grp[0];
        dedupedActiveStores.push(primary);
        if (grp.length > 1) {
          for (const dup of grp.slice(1)) {
            await prisma.$executeRawUnsafe(`
              UPDATE creative_store_configs SET "storeId" = '${primary.id}' WHERE "storeId" = '${dup.id}';
            `);
            await prisma.$executeRawUnsafe(`
              UPDATE pos_stores SET status = 'INACTIVE', enabled = false, "updatedAt" = NOW() WHERE id = '${dup.id}';
            `);
          }
        }
      }
      activeStores = dedupedActiveStores;

      // Ensure every active store has a valid teamId
      for (const s of activeStores) {
        if (!s.teamId || !validTeamIds.has(s.teamId.toLowerCase())) {
          await prisma.posStore.update({
            where: { id: s.id },
            data: { teamId: defaultTeam.id },
          });
          s.teamId = defaultTeam.id;
        }
      }

      const storeById = new Map(activeStores.map((s) => [s.id.toLowerCase(), s]));
      const storeByShopId = new Map(activeStores.map((s) => [s.shopId, s]));
      const teamCodeById = new Map(teams.map((t) => [t.id.toLowerCase(), t.teamCode || null]));

      // Default product variation per store (for pv:: key construction when needed)
      const defaultVariationByStoreId = new Map<string, string>();
      const variationsByStoreId = new Map<string, Array<{ variationId: string; name: string; customId: string }>>();
      for (const p of products) {
        const sId = p.storeId.toLowerCase();
        const vId = (p.variationId || '').trim();
        if (!vId || vId.includes('::') || !storeById.has(sId)) continue;
        if (!defaultVariationByStoreId.has(sId)) defaultVariationByStoreId.set(sId, vId);
        const list = variationsByStoreId.get(sId) || [];
        list.push({ variationId: vId, name: norm(p.name), customId: norm(p.customId) });
        variationsByStoreId.set(sId, list);
      }

      const buildFallbackMappingForStore = (storeId: string, adText: string): string => {
        const sId = storeId.toLowerCase();
        const vars = variationsByStoreId.get(sId) || [];
        if (vars.length === 1) {
          return `pv::${sId}::${vars[0].variationId}`.toLowerCase();
        }
        const hay = norm(adText);
        if (hay && vars.length > 1) {
          const matched = vars.find(
            (v) => (v.customId && hay.includes(v.customId)) || (v.name && v.name.length >= 4 && hay.includes(v.name)),
          );
          if (matched) return `pv::${sId}::${matched.variationId}`.toLowerCase();
        }
        return `ua::${sId}`.toLowerCase();
      };

      const buildAttributionIndex = async () => {
        const validStoreIds = new Set(activeStores.map((s) => s.id.toLowerCase()));
        const insertUnique = (map: Map<string, string | null>, key: string, store: string | null | undefined) => {
          const val = store?.toLowerCase();
          const scoped = val && validStoreIds.has(val) ? val : null;
          if (map.has(key) && map.get(key) !== scoped) map.set(key, null);
          else map.set(key, scoped);
        };
        const idxStoreByShopId = new Map<string, string | null>();
        for (const s of activeStores) insertUnique(idxStoreByShopId, s.shopId, s.id);
        const links = await prisma.creativeMetaAdLink.findMany({
          where: { tenantId: tenant.id },
          select: {
            adId: true,
            creative: { select: { tenantId: true, storeConfig: { select: { tenantId: true, storeId: true } } } },
          },
        });
        const storeByAdId = new Map<string, string | null>();
        for (const link of links) {
          insertUnique(
            storeByAdId,
            link.adId,
            link.creative?.tenantId === tenant.id && link.creative?.storeConfig?.tenantId === tenant.id
              ? link.creative.storeConfig.storeId
              : null,
          );
        }
        // Clean up any creative_meta_ad_links that resolved to null (unconfigured or disabled store)
        const brokenAdIds: string[] = [];
        for (const [adIdKey, mappedStoreId] of Array.from(storeByAdId.entries())) {
          if (!mappedStoreId || !validStoreIds.has(mappedStoreId)) {
            brokenAdIds.push(adIdKey);
            storeByAdId.delete(adIdKey);
          }
        }
        if (brokenAdIds.length > 0) {
          await prisma.creativeMetaAdLink.deleteMany({
            where: { tenantId: tenant.id, adId: { in: brokenAdIds } },
          });
        }
        const storeByCreativeCode = new Map<string, string | null>();
        for (const c of creatives) {
          insertUnique(storeByCreativeCode, c.code.toUpperCase(), c.storeConfig?.storeId || null);
        }
        const storeByCodePrefix = new Map<string, string | null>();
        for (const cfg of storeConfigs) {
          insertUnique(storeByCodePrefix, cfg.codePrefix.toUpperCase(), cfg.storeId);
        }
        const storeByLabel = new Map<string, string | null>();
        for (const p of products) {
          const label = p.mapping?.trim().toLowerCase();
          if (label && validStoreIds.has(p.storeId.toLowerCase())) {
            insertUnique(storeByLabel, label, p.storeId);
          }
        }
        return {
          validStoreIds,
          storeByShopId: idxStoreByShopId,
          storeByAdId,
          storeByCreativeCode,
          storeByCodePrefix,
          storeByLabel,
        };
      };

      const index = await buildAttributionIndex();

      // Account lookup from meta_ad_insights
      const accountIdByAdId = new Map<string, string>();
      const accountIdByCampaignId = new Map<string, string>();
      for (const m of maiRows) {
        if (m.adId && m.accountId) accountIdByAdId.set(m.adId, m.accountId);
        if (m.campaignId && m.accountId) accountIdByCampaignId.set(m.campaignId, m.accountId);
      }

      const findStoreId = (
        matcher: (s: { id: string; shopId: string; name: string; shopName: string | null; teamId: string | null }) => boolean,
      ): string | null => {
        const found = activeStores.find(matcher);
        return found ? found.id.toLowerCase() : null;
      };

      const ogimiStoreId =
        findStoreId((s) => s.shopId === '715088566' || norm(s.name).includes('ogimi') || norm(s.shopName).includes('ogimi')) ||
        '23d5232f-dbc0-48cb-9160-d5793c5057aa';
      const kangenStoreId =
        findStoreId((s) => s.shopId === 'kangen_store' || norm(s.name) === 'kangen') ||
        '00000000-0000-4000-8000-000000000014';
      const evahStoreId =
        findStoreId((s) => s.shopId === 'evah_fragrances_store' || norm(s.name).includes('evah')) ||
        '00000000-0000-4000-8000-000000000015';
      const garaheStoreId =
        findStoreId((s) => s.shopId === 'garahe_hacks_store' || norm(s.name).includes('garahe')) ||
        '00000000-0000-4000-8000-000000000016';
      const scentgemsStoreId =
        findStoreId((s) => s.shopId === 'scentgems_store' || norm(s.name).includes('scentgems')) ||
        '00000000-0000-4000-8000-000000000017';
      const petalStoreId =
        findStoreId((s) => s.shopId === 'petal_theory_store' || norm(s.name).includes('petal theory')) ||
        '00000000-0000-4000-8000-000000000018';
      const tailsStoreId =
        findStoreId((s) => s.shopId === 'tails_and_toys_store' || norm(s.name).includes('tails')) ||
        '00000000-0000-4000-8000-000000000019';
      const axleStoreId = findStoreId((s) => s.shopId === '715030833' || norm(s.name).includes('axle'));
      const kiddieStoreId = findStoreId((s) => s.shopId === '1942328959' || norm(s.name).includes('kiddie'));
      const agriblastStoreId = findStoreId((s) => s.shopId === '1942313724' || norm(s.name).includes('agriblast'));

      // Brand / campaign explicit override rules for Next Big Move
      const resolveExplicitBrandOverride = (row: {
        adId?: string | null;
        adName?: string | null;
        campaignId?: string | null;
        campaignName?: string | null;
        mapping?: string | null;
        shops?: unknown;
        accountId?: string | null;
      }): string | null => {
        if (tenant.id !== NEXT_BIG_MOVE_TENANT_ID) return null;
        const shopsArr = Array.isArray(row.shops) ? row.shops.map(String) : [];
        if (shopsArr.includes('715088566') && storeById.has(ogimiStoreId)) return ogimiStoreId;
        if (shopsArr.includes('kangen_store') && storeById.has(kangenStoreId)) return kangenStoreId;
        if (shopsArr.includes('evah_fragrances_store') && storeById.has(evahStoreId)) return evahStoreId;

        const text = `${norm(row.campaignName)} | ${norm(row.adName)} | ${norm(row.mapping)}`;
        const accId =
          row.accountId ||
          (row.adId ? accountIdByAdId.get(row.adId) : undefined) ||
          (row.campaignId ? accountIdByCampaignId.get(row.campaignId) : undefined) ||
          '';

        if (text.includes('ogimi') && storeById.has(ogimiStoreId)) return ogimiStoreId;
        if ((text.includes('kangen') || accId === '2560293900989953') && storeById.has(kangenStoreId)) return kangenStoreId;
        if ((text.includes('evah') || accId === '1487235986020067') && storeById.has(evahStoreId)) return evahStoreId;
        if ((text.includes('headlightcleaner') || text.includes('headlight cleaner')) && storeById.has(garaheStoreId)) return garaheStoreId;
        if ((text.includes('andrea secret') || text.includes('scentgems')) && storeById.has(scentgemsStoreId)) return scentgemsStoreId;
        if (text.includes('petal theory') && storeById.has(petalStoreId)) return petalStoreId;
        if ((text.includes('cat yoyo') || text.includes('tails & toys') || text.includes('tails and toys')) && storeById.has(tailsStoreId)) return tailsStoreId;
        if (text.includes('anik anik engagement') && axleStoreId) return axleStoreId;
        if ((text.includes('3 kid chart') || text.includes('vallejo')) && kiddieStoreId) return kiddieStoreId;
        if (norm(row.campaignName) === 'new sales campaign' && norm(row.adName) === 'new sales campaign' && agriblastStoreId) {
          return agriblastStoreId;
        }
        return null;
      };

      // Keyword-based fallback for active stores
      const resolveKeywordStore = (text: string): string | null => {
        const t = norm(text);
        if (!t) return null;
        for (const s of activeStores) {
          const sName = norm(s.name);
          const sShopName = norm(s.shopName);
          if (sName.length >= 4 && t.includes(sName)) return s.id.toLowerCase();
          if (sShopName.length >= 4 && t.includes(sShopName)) return s.id.toLowerCase();
        }
        if (tenant.id === NEXT_BIG_MOVE_TENANT_ID) {
          if (t.includes('smile') || t.includes('oral') || t.includes('breath') || t.includes('teeth')) {
            return findStoreId((s) => norm(s.name).includes('smile'));
          }
          if (t.includes('barebody') || t.includes('bare body')) {
            return findStoreId((s) => norm(s.name).includes('barebody'));
          }
          if (t.includes('kiddie') || t.includes('kid') || t.includes('busy book') || t.includes('montessori')) {
            return kiddieStoreId;
          }
          if (t.includes('radiance')) return findStoreId((s) => norm(s.name).includes('radiance'));
          if (t.includes('luntian')) return findStoreId((s) => norm(s.name).includes('luntian'));
          if (t.includes('luxe')) return findStoreId((s) => norm(s.name).includes('luxe'));
          if (t.includes('tactical')) return findStoreId((s) => norm(s.name).includes('tactical'));
          if (t.includes('axle') || t.includes('wiper') || t.includes('car')) return axleStoreId;
          if (t.includes('agriblast') || t.includes('fertilizer') || t.includes('plant')) return agriblastStoreId;
          if (t.includes('bahay')) return findStoreId((s) => norm(s.name).includes('bahay'));
          if (t.includes('kusina')) return findStoreId((s) => norm(s.name).includes('kusina'));
          if (t.includes('homeliving') || t.includes('home living')) return findStoreId((s) => norm(s.name).includes('home'));
          if (t.includes('book hub') || t.includes('book')) return findStoreId((s) => norm(s.name).includes('book'));
          if (t.includes('foldix')) return findStoreId((s) => norm(s.name).includes('foldix'));
          if (t.includes('baby bliss') || t.includes('babybliss')) return findStoreId((s) => norm(s.name).includes('baby'));
          if (t.includes('zenith') || t.includes('tai sui') || t.includes('taisui') || t.includes('bracelet') || t.includes('feng shui')) {
            return findStoreId((s) => norm(s.name).includes('zenith'));
          }
        }
        return null;
      };

      // Build vote maps from Pass 1
      const addVote = (map: Map<string, Map<string, number>>, key: string | null | undefined, storeId: string, weight = 1) => {
        const k = norm(key);
        if (!k || !storeById.has(storeId)) return;
        let bucket = map.get(k);
        if (!bucket) {
          bucket = new Map();
          map.set(k, bucket);
        }
        bucket.set(storeId, (bucket.get(storeId) || 0) + weight);
      };
      const topVote = (map: Map<string, Map<string, number>>, key: string | null | undefined): string | null => {
        const k = norm(key);
        if (!k) return null;
        const bucket = map.get(k);
        if (!bucket || bucket.size === 0) return null;
        let bestStore: string | null = null;
        let bestScore = -1;
        for (const [sId, score] of Array.from(bucket.entries())) {
          if (score > bestScore) {
            bestScore = score;
            bestStore = sId;
          }
        }
        return bestStore;
      };

      const votesByAdId = new Map<string, Map<string, number>>();
      const votesByCampaignId = new Map<string, Map<string, number>>();
      const votesByCampaignName = new Map<string, Map<string, number>>();
      const votesByAccountId = new Map<string, Map<string, number>>();
      const votesByTeamId = new Map<string, Map<string, number>>();
      const tenantStoreVotes = new Map<string, number>();

      for (const row of rmRows) {
        const explicitOverride = resolveExplicitBrandOverride(row);
        const std = explicitOverride || resolveStoreAttributionLocal(row as any, index);
        if (std && std !== UNATTRIBUTED_STORE_KEY && storeById.has(std)) {
          const weight = Math.max(1, Number(row.spend || 0) + Number(row.purchasesPos || 0) * 10);
          addVote(votesByAdId, row.adId, std, weight);
          addVote(votesByCampaignId, row.campaignId, std, weight);
          addVote(votesByCampaignName, row.campaignName, std, weight);
          const accId = (row.adId ? accountIdByAdId.get(row.adId) : undefined) || (row.campaignId ? accountIdByCampaignId.get(row.campaignId) : undefined);
          addVote(votesByAccountId, accId, std, weight);
          const st = storeById.get(std);
          if (!isBusinessReportExcludedStore(st)) {
            addVote(votesByTeamId, row.teamId || st?.teamId, std, weight);
            tenantStoreVotes.set(std, (tenantStoreVotes.get(std) || 0) + weight);
          }
        }
      }

      let defaultTenantStoreId = activeStores.find((s) => !isBusinessReportExcludedStore(s))?.id.toLowerCase() || activeStores[0].id.toLowerCase();
      let bestTenantScore = -1;
      for (const [sId, score] of Array.from(tenantStoreVotes.entries())) {
        if (score > bestTenantScore) {
          bestTenantScore = score;
          defaultTenantStoreId = sId;
        }
      }

      // Pass 2: Resolve every reconcile_marketing row
      const rmUpdates: Array<{
        id: string;
        teamId: string | null;
        teamCode: string | null;
        shops: string[];
        mapping: string;
      }> = [];
      const affectedDates = new Set<string>();

      for (const row of rmRows) {
        let resolvedStoreId: string | null = resolveExplicitBrandOverride(row);

        if (!resolvedStoreId) {
          const std = resolveStoreAttributionLocal(row as any, index);
          if (std && std !== UNATTRIBUTED_STORE_KEY && storeById.has(std)) {
            resolvedStoreId = std;
          }
        }

        // Fallback 1: exact adId vote
        if (!resolvedStoreId && row.adId) {
          resolvedStoreId = topVote(votesByAdId, row.adId);
        }

        // Fallback 2: matchedOrders shopIds
        if (!resolvedStoreId && Array.isArray(row.matchedOrders) && row.matchedOrders.length > 0) {
          const orderShopCounts = new Map<string, number>();
          for (const mo of row.matchedOrders as any[]) {
            const sId = mo?.shopId ? storeByShopId.get(String(mo.shopId))?.id.toLowerCase() : null;
            if (sId && storeById.has(sId)) {
              orderShopCounts.set(sId, (orderShopCounts.get(sId) || 0) + 1);
            }
          }
          let bestCount = 0;
          for (const [sId, cnt] of Array.from(orderShopCounts.entries())) {
            if (cnt > bestCount) {
              bestCount = cnt;
              resolvedStoreId = sId;
            }
          }
        }

        // Fallback 3: row.shops array (disambiguated by campaign/account/keyword if multiple)
        if (!resolvedStoreId && Array.isArray(row.shops) && row.shops.length > 0) {
          const shopStoreCandidates = (row.shops as any[])
            .map((raw) => storeByShopId.get(String(raw))?.id.toLowerCase())
            .filter((sId): sId is string => Boolean(sId && storeById.has(sId)));
          if (shopStoreCandidates.length === 1) {
            resolvedStoreId = shopStoreCandidates[0];
          } else if (shopStoreCandidates.length > 1) {
            const kwStore = resolveKeywordStore(`${row.campaignName || ''} ${row.adName || ''} ${row.mapping || ''}`);
            const campStore = topVote(votesByCampaignId, row.campaignId) || topVote(votesByCampaignName, row.campaignName);
            if (kwStore && shopStoreCandidates.includes(kwStore)) resolvedStoreId = kwStore;
            else if (campStore && shopStoreCandidates.includes(campStore)) resolvedStoreId = campStore;
            else resolvedStoreId = shopStoreCandidates[0];
          }
        }

        // Fallback 4: creative code / prefix / product keyword
        if (!resolvedStoreId) {
          const text = `${row.campaignName || ''} ${row.adName || ''} ${row.mapping || ''}`;
          resolvedStoreId = resolveKeywordStore(text);
        }

        // Fallback 5: campaignId or campaignName votes
        if (!resolvedStoreId) {
          resolvedStoreId = topVote(votesByCampaignId, row.campaignId) || topVote(votesByCampaignName, row.campaignName);
        }

        // Fallback 6: Meta accountId votes
        if (!resolvedStoreId) {
          const accId = (row.adId ? accountIdByAdId.get(row.adId) : undefined) || (row.campaignId ? accountIdByCampaignId.get(row.campaignId) : undefined);
          resolvedStoreId = topVote(votesByAccountId, accId);
        }

        // Fallback 7: teamId dominant store or tenant dominant store
        if (!resolvedStoreId || !storeById.has(resolvedStoreId)) {
          resolvedStoreId = topVote(votesByTeamId, row.teamId) || defaultTenantStoreId;
        }

        const targetStore = (resolvedStoreId ? storeById.get(resolvedStoreId) : undefined) || storeById.get(defaultTenantStoreId) || activeStores[0];
        if (!targetStore) continue;
        const targetTeamId =
          targetStore.teamId ||
          (row.teamId && !isSuperAdminOnlyTeamId(row.teamId) && validTeamIds.has(row.teamId.toLowerCase())
            ? row.teamId
            : defaultTeam.id);
        const targetTeamCode = targetTeamId ? teamCodeById.get(targetTeamId.toLowerCase()) || row.teamCode : row.teamCode;

        let candidateShops: string[] =
          Array.isArray(row.shops) && row.shops.length > 0 ? (row.shops as any[]).map(String) : [targetStore.shopId];
        let candidateMapping: string =
          typeof row.mapping === 'string' && row.mapping.trim().length > 0
            ? row.mapping
            : buildFallbackMappingForStore(targetStore.id, `${row.campaignName || ''} ${row.adName || ''}`);

        // If row belongs to one of the 6 new brand stores and had a null/generic mapping, use its product mapping key
        if (
          targetStore.id.startsWith('00000000-0000-4000-8000-00000000001') &&
          (!row.mapping || norm(row.mapping) === norm(row.campaignName) || row.mapping.startsWith('ua::'))
        ) {
          candidateMapping = buildFallbackMappingForStore(targetStore.id, `${row.campaignName || ''} ${row.adName || ''}`);
        }

        // Verify resolveStoreAttribution on candidateRow
        let checkAttr = resolveStoreAttributionLocal(
          { adId: row.adId, adName: row.adName, shops: candidateShops, mapping: candidateMapping },
          index,
        );
        if (checkAttr !== targetStore.id.toLowerCase()) {
          candidateShops = [targetStore.shopId];
          checkAttr = resolveStoreAttributionLocal(
            { adId: row.adId, adName: row.adName, shops: candidateShops, mapping: candidateMapping },
            index,
          );
        }
        if (checkAttr !== targetStore.id.toLowerCase()) {
          candidateMapping = buildFallbackMappingForStore(targetStore.id, `${row.campaignName || ''} ${row.adName || ''}`);
          checkAttr = resolveStoreAttributionLocal(
            { adId: row.adId, adName: row.adName, shops: candidateShops, mapping: candidateMapping },
            index,
          );
        }
        if (checkAttr !== targetStore.id.toLowerCase() && row.adId && index.storeByAdId.has(row.adId)) {
          await prisma.creativeMetaAdLink.deleteMany({
            where: { tenantId: tenant.id, adId: row.adId },
          });
          index.storeByAdId.delete(row.adId);
          checkAttr = resolveStoreAttributionLocal(
            { adId: row.adId, adName: row.adName, shops: candidateShops, mapping: candidateMapping },
            index,
          );
        }

        const currentShopsJson = JSON.stringify(Array.isArray(row.shops) ? row.shops : []);
        const nextShopsJson = JSON.stringify(candidateShops);
        if (
          row.teamId !== targetTeamId ||
          row.teamCode !== targetTeamCode ||
          row.mapping !== candidateMapping ||
          currentShopsJson !== nextShopsJson
        ) {
          rmUpdates.push({
            id: row.id,
            teamId: targetTeamId || null,
            teamCode: targetTeamCode || null,
            shops: candidateShops,
            mapping: candidateMapping,
          });
          const dateStr = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
          affectedDates.add(dateStr);
        }
      }

      // Execute reconcile_marketing updates in fast SQL VALUES batches
      const sqlEsc = (val: string | null | undefined) =>
        val === null || val === undefined ? 'NULL' : `'${String(val).replace(/'/g, "''")}'`;

      for (let i = 0; i < rmUpdates.length; i += 1000) {
        const batch = rmUpdates.slice(i, i + 1000);
        const valuesSql = batch
          .map(
            (u) =>
              `(${sqlEsc(u.id)}::uuid, ${u.teamId ? `${sqlEsc(u.teamId)}::uuid` : 'NULL::uuid'}, ${sqlEsc(u.teamCode)}, ${sqlEsc(JSON.stringify(u.shops))}::jsonb, ${sqlEsc(u.mapping)})`,
          )
          .join(',\n');
        await prisma.$executeRawUnsafe(`
          UPDATE reconcile_marketing AS rm
          SET
            "teamId" = v.team_id,
            "teamCode" = v.team_code,
            shops = v.shops,
            mapping = v.mapping,
            "updatedAt" = NOW()
          FROM (VALUES ${valuesSql}) AS v(id, team_id, team_code, shops, mapping)
          WHERE rm.id = v.id
        `);
      }

      // Also align meta_ad_insights teamId, teamCode, and mapping so future reconciliations preserve attribution
      let updatedMaiCount = 0;
      const maiUpdates: Array<{ id: string; teamId: string | null; teamCode: string | null; mapping: string | null }> = [];
      for (const m of maiRows) {
        const overrideStoreId = resolveExplicitBrandOverride(m);
        const votedStoreId =
          overrideStoreId ||
          topVote(votesByAdId, m.adId) ||
          topVote(votesByCampaignId, m.campaignId) ||
          topVote(votesByCampaignName, m.campaignName) ||
          resolveKeywordStore(`${m.campaignName || ''} ${m.adName || ''} ${m.mapping || ''}`) ||
          topVote(votesByAccountId, m.accountId) ||
          topVote(votesByTeamId, m.teamId) ||
          defaultTenantStoreId;
        const st = storeById.get(votedStoreId);
        if (!st) continue;
        const targetTeamId =
          st.teamId ||
          (m.teamId && !isSuperAdminOnlyTeamId(m.teamId) && validTeamIds.has(m.teamId.toLowerCase())
            ? m.teamId
            : defaultTeam.id);
        const targetTeamCode = targetTeamId ? teamCodeById.get(targetTeamId.toLowerCase()) || m.teamCode : m.teamCode;
        const targetMapping =
          m.mapping && m.mapping.trim().length > 0
            ? m.mapping
            : buildFallbackMappingForStore(st.id, `${m.campaignName || ''} ${m.adName || ''}`);

        if (m.teamId !== targetTeamId || m.teamCode !== targetTeamCode || (!m.mapping && targetMapping)) {
          maiUpdates.push({
            id: m.id,
            teamId: targetTeamId || null,
            teamCode: targetTeamCode || null,
            mapping: targetMapping,
          });
        }
      }

      for (let i = 0; i < maiUpdates.length; i += 1000) {
        const batch = maiUpdates.slice(i, i + 1000);
        const valuesSql = batch
          .map(
            (u) =>
              `(${sqlEsc(u.id)}::uuid, ${u.teamId ? `${sqlEsc(u.teamId)}::uuid` : 'NULL::uuid'}, ${sqlEsc(u.teamCode)}, ${sqlEsc(u.mapping)})`,
          )
          .join(',\n');
        await prisma.$executeRawUnsafe(`
          UPDATE meta_ad_insights AS mai
          SET
            "teamId" = v.team_id,
            "teamCode" = v.team_code,
            mapping = v.mapping,
            "updatedAt" = NOW()
          FROM (VALUES ${valuesSql}) AS v(id, team_id, team_code, mapping)
          WHERE mai.id = v.id
        `);
        updatedMaiCount += batch.length;
      }

      // Verify post-backfill attribution on tenant
      const verifyIndex = await buildAttributionIndex();
      const verifyRmRows = await prisma.reconcileMarketing.findMany({
        where: { tenantId: tenant.id },
        select: {
          id: true,
          date: true,
          adId: true,
          adName: true,
          mapping: true,
          shops: true,
          teamId: true,
          spend: true,
          leads: true,
        },
      });
      let unattributedRows = 0;
      let unattributedSpend = 0;
      let unassignedTeamSpend = 0;
      let nullMappingRows = 0;
      for (const r of verifyRmRows) {
        const sp = Number(r.spend || 0);
        const ld = Number(r.leads || 0);
        const resolvedStore = resolveStoreAttributionLocal(r as any, verifyIndex);
        if (resolvedStore === UNATTRIBUTED_STORE_KEY && (sp > 0 || ld > 0)) {
          unattributedRows++;
          unattributedSpend += sp;
        }
        const effectiveTeam = r.teamId || (resolvedStore !== UNATTRIBUTED_STORE_KEY ? storeById.get(resolvedStore)?.teamId : null);
        if (!effectiveTeam && sp > 0) {
          unassignedTeamSpend += sp;
        }
        if (!r.mapping) nullMappingRows++;
      }

      console.log(
        `✓ Ad Spend Attribution [${tenant.name}]: updatedRM=${rmUpdates.length}, updatedMAI=${updatedMaiCount}, affectedDates=${affectedDates.size}, unattributedAdRows=${unattributedRows}, unattributedAdSpend=${unattributedSpend.toFixed(2)}, unassignedTeamSpend=${unassignedTeamSpend.toFixed(2)}, nullMappingRows=${nullMappingRows}`,
      );
    }

    // 5. Clear Redis analytics cache and bump version so Business Report & Teams reflect changes immediately
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const keyPrefix = process.env.CACHE_PREFIX || 'erp:';
    const password = process.env.REDIS_PASSWORD || undefined;
    const redis = new Redis({ host, port, keyPrefix, password, lazyConnect: true, maxRetriesPerRequest: 2 });
    try {
      await redis.connect();
      for (const tenant of tenants) {
        const nextVersion = await redis.incrby(`analytics:${tenant.id}:version`, 10);
        console.log(`✓ Bumped Redis analytics:${tenant.id}:version to ${nextVersion}`);
      }
    } catch (redisErr: any) {
      console.warn('Warning: could not bump Redis analytics version after ad spend backfill:', redisErr?.message || redisErr);
    } finally {
      redis.disconnect();
    }

    console.log(`✓ Completed Ad Spend Store, Team & Product Mapping Attribution Backfill in ${Date.now() - startedAt}ms`);
  } catch (err: any) {
    console.error('Warning during Ad Spend Attribution Backfill:', err?.message || err);
  }
}

/** Read-only diagnostic: measures how long ERP data takes to become visible
 * (webhook receive -> ingest -> reconcile rollup) and the Bull queue backlog,
 * so update delays on erp.nextbigmove.com can be explained from the deploy log. */
async function diagnoseErpFreshness() {
  try {
    const env = Object.fromEntries(['PANCAKE_WEBHOOK_RECONCILE_DELAY_MS', 'PANCAKE_WEBHOOK_RECONCILE_MIN_DELAY_MS', 'PANCAKE_WEBHOOK_RECONCILE_MAX_DELAY_MS',
      'PANCAKE_RECONCILE_PROCESSOR_CONCURRENCY', 'PANCAKE_WEBHOOK_PROCESSOR_CONCURRENCY', 'PANCAKE_RECONCILE_QUEUE_TIMEOUT_MS',
      'CACHE_TTL_SECONDS'].map((k) => [k, process.env[k] ?? '(default)']));
    console.log(`ERP freshness env: ${JSON.stringify(env)}`);
    const webhooks = await prisma.$queryRawUnsafe<any[]>(`
      SELECT t.name AS tenant, count(*)::int AS webhooks,
        count(*) FILTER (WHERE l."processedAt" IS NULL)::int AS unprocessed,
        array_agg(DISTINCT l."processStatus") AS statuses,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (l."processingStartedAt" - l."receivedAt"))))::int AS "ingestWaitP50s",
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (l."processingStartedAt" - l."receivedAt"))))::int AS "ingestWaitP95s",
        round(max(EXTRACT(EPOCH FROM (l."processingStartedAt" - l."receivedAt"))))::int AS "ingestWaitMaxS",
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY l."processingDurationMs"))::int AS "processingP95Ms",
        to_char(max(l."receivedAt") + interval '8 hours', 'MM-DD HH24:MI:SS') AS "lastReceivedPH",
        sum(l."reconcileQueuedCount")::int AS "reconcileQueued", sum(l."reconcileSkippedCount")::int AS "reconcileCoalesced"
      FROM pancake_webhook_logs l LEFT JOIN tenants t ON t.id = l."tenantId"
      WHERE l."receivedAt" > now() - interval '24 hours'
      GROUP BY t.name ORDER BY webhooks DESC LIMIT 12`);
    for (const row of webhooks) console.log(`ERP freshness webhooks24h ${JSON.stringify(row)}`);
    // Arrival lag: Pancake order creation (insertedAt) -> first saved in ERP (createdAt).
    const arrival = await prisma.$queryRawUnsafe<any[]>(`
      SELECT t.name AS tenant, count(*)::int AS orders,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o."createdAt" - o."insertedAt"))))::int AS "arrivalP50s",
        round(percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o."createdAt" - o."insertedAt"))))::int AS "arrivalP90s",
        round(percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (o."createdAt" - o."insertedAt"))))::int AS "arrivalP99s",
        count(*) FILTER (WHERE o."createdAt" - o."insertedAt" > interval '10 minutes')::int AS "over10m",
        count(*) FILTER (WHERE o."createdAt" - o."insertedAt" > interval '1 hour')::int AS "over1h"
      FROM pos_orders o JOIN tenants t ON t.id = o."tenantId"
      WHERE o."insertedAt" > now() - interval '48 hours'
      GROUP BY t.name ORDER BY orders DESC LIMIT 8`);
    for (const row of arrival) console.log(`ERP freshness arrival48h ${JSON.stringify(row)}`);
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const redis = new Redis({ host, port, password: process.env.REDIS_PASSWORD || undefined, lazyConnect: true, maxRetriesPerRequest: 2 });
    try {
      await redis.connect();
      for (const queue of ['pancake-webhook', 'pancake-webhook-reconcile', 'orders-confirmation-update', 'workflow-execution']) {
        const [wait, active, delayed, failed, paused] = await Promise.all([
          redis.llen(`bull:${queue}:wait`), redis.llen(`bull:${queue}:active`), redis.zcard(`bull:${queue}:delayed`),
          redis.zcard(`bull:${queue}:failed`), redis.llen(`bull:${queue}:paused`)]);
        const oldestWaitId = await redis.lindex(`bull:${queue}:wait`, -1);
        const oldestTs = oldestWaitId ? await redis.hget(`bull:${queue}:${oldestWaitId}`, 'timestamp') : null;
        const recentFailedIds = await redis.zrevrange(`bull:${queue}:failed`, 0, 2);
        const recentFailures = await Promise.all(recentFailedIds.map(async (id) => {
          const [reason, finishedOn] = await Promise.all([redis.hget(`bull:${queue}:${id}`, 'failedReason'), redis.hget(`bull:${queue}:${id}`, 'finishedOn')]);
          return { at: finishedOn ? new Date(Number(finishedOn)).toISOString() : null, reason: String(reason ?? '').slice(0, 160) };
        }));
        console.log(`ERP freshness queue ${queue}: ${JSON.stringify({ wait, active, delayed, failed, paused,
          oldestWaitingAgeS: oldestTs ? Math.round((Date.now() - Number(oldestTs)) / 1000) : null, recentFailures })}`);
      }
      const rawMetrics = await redis.lrange('erp:metrics:pancake-reconcile', 0, 1999);
      const relaySubscribers = await redis.call('PUBSUB', 'NUMSUB', 'erp:ws:workflow-events').catch(() => null);
      console.log(`ERP freshness realtime relay subscribers: ${JSON.stringify(relaySubscribers)}`);
      const metrics = rawMetrics.map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
        .filter((m) => m && Number(m.finishedAt) > Date.now() - 3 * 3600 * 1000);
      const pct = (values: number[], p: number) => {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      };
      const e2e = metrics.map((m) => Number(m.createdToDoneMs)).filter(Number.isFinite);
      const dur = metrics.map((m) => Number(m.durationMs)).filter(Number.isFinite);
      console.log(`ERP freshness reconcile last3h: ${JSON.stringify({ runs: metrics.length,
        orderToReportP50s: pct(e2e, 0.5) === null ? null : Math.round(pct(e2e, 0.5)! / 1000),
        orderToReportP95s: pct(e2e, 0.95) === null ? null : Math.round(pct(e2e, 0.95)! / 1000),
        orderToReportMaxS: e2e.length ? Math.round(Math.max(...e2e) / 1000) : null,
        durationP50Ms: pct(dur, 0.5), durationP95Ms: pct(dur, 0.95), durationMaxMs: dur.length ? Math.max(...dur) : null })}`);
    } finally {
      redis.disconnect();
    }
  } catch (err: any) {
    console.error('Warning during ERP freshness diagnostic:', err?.message || err);
  }
}

/** Login lowercases the typed email, so accounts saved with capital letters
 * (older tenant/user creation paths) could never sign in. Normalize them when
 * no other account shares the same email in any letter case. Idempotent. */
async function normalizeUserEmails() {
  try {
    const updated = await prisma.$executeRawUnsafe(`
      UPDATE users u SET email = lower(btrim(u.email)), "updatedAt" = now()
      WHERE u.email <> lower(btrim(u.email))
        AND NOT EXISTS (
          SELECT 1 FROM users o WHERE o.id <> u.id AND lower(btrim(o.email)) = lower(btrim(u.email))
        )`);
    const [conflicts] = await prisma.$queryRawUnsafe<any[]>(`
      SELECT count(*)::int AS n FROM users u WHERE u.email <> lower(btrim(u.email))`);
    console.log(`✓ Normalized user emails to lowercase: updated=${updated}, leftWithCaseConflicts=${conflicts?.n ?? 0}`);
  } catch (err: any) {
    console.error('Warning during user email normalization:', err?.message || err);
  }
}

async function promoteDesignatedSuperAdmins() {
  try {
    const primaryTenant = await prisma.tenant.findFirst({
      where: { slug: 'next-big-move' },
      select: { id: true, name: true },
    });

    // Remove the accidental "Lewinsky Candido" tenant while preserving any user
    // accounts created under it by moving them to the primary Next Big Move tenant.
    const lewinskyTenants = await prisma.tenant.findMany({
      where: {
        slug: { not: 'next-big-move' },
        OR: [
          { slug: { contains: 'lewinsky', mode: 'insensitive' } },
          { name: { contains: 'lewinsky', mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, slug: true },
    });

    for (const lt of lewinskyTenants) {
      await prisma.tenant.delete({ where: { id: lt.id } });
      console.log(`✓ Removed Lewinsky Candido tenant record: ${JSON.stringify(lt)}`);
    }

    const removedLewinskyCandidoUser = await prisma.user.deleteMany({
      where: {
        email: { equals: 'lewinskycandido@gmail.com', mode: 'insensitive' },
      },
    });
    if (removedLewinskyCandidoUser.count > 0) {
      console.log(`✓ Deleted user account lewinskycandido@gmail.com (count=${removedLewinskyCandidoUser.count})`);
    }

    // Revert Stessey Soriano back to standard tenant USER role so her access
    // is governed strictly by her original role/team assignments.
    const stesseyMatches = await prisma.user.findMany({
      where: {
        OR: [
          {
            AND: [
              { firstName: { contains: 'stessey', mode: 'insensitive' } },
              { lastName: { contains: 'soriano', mode: 'insensitive' } },
            ],
          },
          { firstName: { contains: 'stessey soriano', mode: 'insensitive' } },
          { email: { contains: 'stessey', mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        tenantId: true,
        defaultTeamId: true,
      },
    });

    for (const su of stesseyMatches) {
      if (su.role !== 'USER') {
        const reverted = await prisma.user.update({
          where: { id: su.id },
          data: {
            role: 'USER',
          },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            status: true,
            tenantId: true,
            defaultTeamId: true,
          },
        });
        console.log(`✓ Reverted Stessey Soriano role to USER: ${JSON.stringify(reverted)}`);
      } else {
        console.log(`✓ Stessey Soriano already has role USER: ${JSON.stringify(su)}`);
      }
    }

    const matches = await prisma.user.findMany({
      where: {
        OR: [
          { email: { equals: 'lewinsky.wetrade@gmail.com', mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        tenantId: true,
      },
    });

    if (matches.length === 0) {
      console.log('No matching user found for designated super admin promotion.');
      return;
    }

    for (const u of matches) {
      const targetTenantId = primaryTenant?.id ?? u.tenantId ?? null;
      const isLewinskyWeTrade = u.email.toLowerCase() === 'lewinsky.wetrade@gmail.com';
      const updated = await prisma.user.update({
        where: { id: u.id },
        data: {
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          ...(targetTenantId ? { tenantId: targetTenantId } : {}),
          ...(isLewinskyWeTrade && !u.firstName ? { firstName: 'Lewinsky', lastName: 'Candido' } : {}),
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          tenantId: true,
        },
      });
      console.log(`✓ Promoted user to SUPER_ADMIN: ${JSON.stringify(updated)}`);
    }
  } catch (err: any) {
    console.error('Warning during designated super admin promotion:', err?.message || err);
  }
}

function readSeedIdentifier(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function normalizeSeedSku(value: unknown): string | null {
  const raw = readSeedIdentifier(value);
  if (!raw) return null;
  const cleaned = raw.replace(/`+$/g, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

function readSeedPositiveInt(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(Math.trunc(parsed), 0);
}

function decryptSeedIntegrationApiKey(encryptedData: string | null | undefined, tenantKey: string | null | undefined): string | null {
  if (!encryptedData || !tenantKey || !/^[0-9a-fA-F]{64}$/.test(tenantKey)) {
    return null;
  }
  try {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) return null;
    const [ivHex, authTagHex, encrypted] = parts;
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(tenantKey, 'hex'), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    const parsed = JSON.parse(decrypted);
    return typeof parsed?.apiKey === 'string' && parsed.apiKey.trim() ? parsed.apiKey.trim() : null;
  } catch {
    return null;
  }
}

function buildSeedFulfillmentDemandHash(lines: Array<{ variationId: string; quantityRequired: number }>): string {
  const sorted = [...lines]
    .filter((line) => line.variationId && line.quantityRequired > 0)
    .sort((a, b) => a.variationId.localeCompare(b.variationId))
    .map((line) => ({
      variationId: line.variationId,
      quantityRequired: line.quantityRequired,
    }));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function formatManilaDateFromUtc(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  const manilaMs = d.getTime() + 8 * 60 * 60 * 1000;
  return new Date(manilaMs).toISOString().slice(0, 10);
}

async function syncToniosPosConnectionAndOrders() {
  try {
    const now = new Date();

    // 1. Repair active POS stores whose linked integration was left enabled=false during bulk import
    const activeStoresWithDisabledIntegration = await prisma.posStore.findMany({
      where: {
        status: 'ACTIVE',
        NOT: { enabled: false },
      },
      select: {
        id: true,
        tenantId: true,
        shopId: true,
        enabled: true,
        lastSyncAt: true,
        integrationId: true,
        integration: {
          select: {
            id: true,
            status: true,
            enabled: true,
            syncStatus: true,
            lastSyncAt: true,
          },
        },
      },
    });

    let repairedStoreConnections = 0;
    for (const store of activeStoresWithDisabledIntegration) {
      const needsStoreEnable = store.enabled === null;
      const needsIntegrationEnable =
        Boolean(store.integration)
        && store.integration!.status === 'ACTIVE'
        && store.integration!.enabled === false;
      const needsSyncStamp =
        Boolean(store.integration)
        && store.integration!.status === 'ACTIVE'
        && !store.integration!.syncStatus;

      if (!needsStoreEnable && !needsIntegrationEnable && !needsSyncStamp) {
        continue;
      }

      if (needsStoreEnable) {
        await prisma.posStore.update({
          where: { id: store.id },
          data: {
            enabled: true,
            ...(store.lastSyncAt ? {} : { lastSyncAt: now }),
          },
        });
      }

      if (store.integration && (needsIntegrationEnable || needsSyncStamp)) {
        await prisma.integration.update({
          where: { id: store.integration.id },
          data: {
            ...(needsIntegrationEnable ? { enabled: true } : {}),
            syncStatus: store.integration.syncStatus || 'SUCCESS',
            lastSyncAt: store.integration.lastSyncAt || store.lastSyncAt || now,
            syncError: null,
          },
        });
      }
      repairedStoreConnections += 1;
    }
    if (repairedStoreConnections > 0) {
      console.log(`✓ Enabled/synced ${repairedStoreConnections} active POS store integration connection(s)`);
    }

    // 2. Locate Cristobal E-commerexe Trading OPC / Tonios store(s)
    const targetStores = await prisma.posStore.findMany({
      where: {
        OR: [
          { name: { contains: 'tonio', mode: 'insensitive' } },
          { shopName: { contains: 'tonio', mode: 'insensitive' } },
          { tenant: { name: { contains: 'cristobal', mode: 'insensitive' } } },
        ],
      },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            status: true,
            wmsFulfillmentGoLiveAt: true,
            settings: true,
            encryptionKey: true,
          },
        },
        integration: {
          select: {
            id: true,
            status: true,
            enabled: true,
            syncStatus: true,
            syncError: true,
            lastSyncAt: true,
            credentials: true,
          },
        },
        _count: {
          select: {
            products: true,
            tags: true,
            warehouses: true,
          },
        },
      },
    });

    if (targetStores.length === 0) {
      console.log('[TONIOS_DIAG] No matching Tonios / Cristobal POS store found.');
      return;
    }

    for (const store of targetStores) {
      const settingsObj = (store.tenant.settings && typeof store.tenant.settings === 'object' && !Array.isArray(store.tenant.settings))
        ? (store.tenant.settings as Record<string, any>)
        : {};
      const webhookCfg = (settingsObj.pancakePosWebhook && typeof settingsObj.pancakePosWebhook === 'object')
        ? (settingsObj.pancakePosWebhook as Record<string, any>)
        : {};
      const ownership = store.shopId
        ? await prisma.posShopOwnership.findUnique({ where: { shopId: store.shopId } })
        : null;
      const profileCount = await prisma.wmsProductProfile.count({
        where: { tenantId: store.tenantId, storeId: store.id },
      });
      const posOrderStats = await prisma.posOrder.groupBy({
        by: ['status', 'isVoid'],
        where: { tenantId: store.tenantId, shopId: store.shopId },
        _count: { _all: true },
      });
      const fulfillmentStatsBefore = await prisma.wmsFulfillmentOrder.groupBy({
        by: ['status', 'issueReason'],
        where: { tenantId: store.tenantId, storeId: store.id },
        _count: { _all: true },
      });
      const inventoryStats = await prisma.wmsInventoryUnit.groupBy({
        by: ['status', 'variationId', 'posWarehouseRef'],
        where: { tenantId: store.tenantId, storeId: store.id },
        _count: { _all: true },
      });

      console.log('[TONIOS_DIAG_BEFORE]', JSON.stringify({
        tenant: {
          id: store.tenant.id,
          name: store.tenant.name,
          status: store.tenant.status,
          wmsFulfillmentGoLiveAt: store.tenant.wmsFulfillmentGoLiveAt,
          webhookEnabled: Boolean(webhookCfg.enabled),
          webhookHasApiKey: Boolean(webhookCfg.apiKeyHash),
        },
        store: {
          id: store.id,
          name: store.name,
          shopName: store.shopName,
          shopId: store.shopId,
          status: store.status,
          enabled: store.enabled,
          hasStoreApiKey: Boolean(store.apiKey && store.apiKey.trim()),
          integrationStatus: store.integration?.status ?? null,
          integrationEnabled: store.integration?.enabled ?? null,
          integrationSyncStatus: store.integration?.syncStatus ?? null,
          lastSyncAt: store.lastSyncAt,
          counts: {
            products: store._count.products,
            profiles: profileCount,
            tags: store._count.tags,
            warehouses: store._count.warehouses,
          },
          ownership: ownership
            ? { tenantId: ownership.tenantId, storeId: ownership.storeId, ownedBySelf: ownership.storeId === store.id }
            : null,
        },
        posOrderStats,
        fulfillmentStatsBefore,
        inventoryStats,
      }));

      if (store.status !== 'ACTIVE' || store.enabled === false || !store.shopId) {
        continue;
      }

      let effectiveGoLiveAt = store.tenant.wmsFulfillmentGoLiveAt;
      if (!effectiveGoLiveAt) {
        const earliestNovOrder = await prisma.posOrder.findFirst({
          where: {
            tenantId: store.tenantId,
            shopId: store.shopId,
            dateLocal: { gte: '2026-11-09' },
          },
          orderBy: { insertedAt: 'asc' },
          select: { insertedAt: true },
        });
        const manilaNov9Cutoff = new Date('2026-11-09T00:00:00+08:00');
        effectiveGoLiveAt = earliestNovOrder?.insertedAt && earliestNovOrder.insertedAt < manilaNov9Cutoff
          ? earliestNovOrder.insertedAt
          : manilaNov9Cutoff;
        await prisma.tenant.update({
          where: { id: store.tenantId },
          data: { wmsFulfillmentGoLiveAt: effectiveGoLiveAt },
        });
      }

      if (!ownership) {
        await prisma.posShopOwnership.create({
          data: {
            shopId: store.shopId,
            tenantId: store.tenantId,
            storeId: store.id,
            activatedAt: now,
            reason: 'Auto-claimed during Tonios WMS POS repair',
          },
        });
      }

      const apiKey =
        (store.apiKey && store.apiKey.trim())
        || decryptSeedIntegrationApiKey(store.integration?.credentials, store.tenant.encryptionKey);
      if (!apiKey) {
        console.warn(`[TONIOS_DIAG] Store ${store.id} has no resolvable API key.`);
        continue;
      }

      if (!store.apiKey || !store.apiKey.trim()) {
        await prisma.posStore.update({
          where: { id: store.id },
          data: { apiKey },
        });
      }

      // 3. Sync live Pancake catalog (products + WMS profiles)
      let syncedCatalogCount = 0;
      try {
        let page = 1;
        let totalPages = 1;
        while (page <= totalPages && page <= 25) {
          const prodParams = new URLSearchParams({
            api_key: apiKey,
            page_number: String(page),
          });
          const resp = await fetch(
            `https://pos.pages.fm/api/v1/shops/${encodeURIComponent(store.shopId)}/products?${prodParams.toString()}`,
            { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
          );
          if (!resp.ok) break;
          const body: any = await resp.json().catch(() => null);
          const rawRows: any[] = Array.isArray(body?.data)
            ? body.data
            : Array.isArray(body?.products)
              ? body.products
              : Array.isArray(body?.data?.products)
                ? body.data.products
                : [];
          for (const rawItem of rawRows) {
            const itemsToExpand = Array.isArray(rawItem?.variations) && rawItem.variations.length > 0
              ? rawItem.variations.map((v: any) => ({ ...v, product: v.product ?? rawItem, product_id: v.product_id ?? rawItem.id }))
              : [rawItem];
            for (const item of itemsToExpand) {
              const productId =
                readSeedIdentifier(item?.product_id)
                ?? readSeedIdentifier(item?.productId)
                ?? readSeedIdentifier(item?.product?.id)
                ?? readSeedIdentifier(item?.variation_info?.product_id);
              if (!productId) continue;
              const explicitVarId =
                readSeedIdentifier(item?.variation_id)
                ?? readSeedIdentifier(item?.variationId)
                ?? readSeedIdentifier(item?.variation?.id);
              const candidateId = readSeedIdentifier(item?.id);
              const variationId = explicitVarId ?? (candidateId && candidateId !== productId ? candidateId : null);
              const customId = normalizeSeedSku(item?.custom_id ?? item?.display_id ?? item?.code ?? item?.barcode);
              const name =
                (typeof item?.name === 'string' && item.name.trim())
                || (typeof item?.variation_info?.name === 'string' && item.variation_info.name.trim())
                || (typeof item?.product?.name === 'string' && item.product.name.trim())
                || 'Unnamed product';
              const whRows = Array.isArray(item?.variations_warehouses) ? item.variations_warehouses : [];
              const warehouseId = readSeedIdentifier(whRows[0]?.warehouse_id ?? whRows[0]?.id);

              let savedProduct = variationId
                ? await prisma.posProduct.findFirst({ where: { storeId: store.id, variationId } })
                : await prisma.posProduct.findFirst({ where: { storeId: store.id, productId, variationId: null } });

              if (savedProduct) {
                savedProduct = await prisma.posProduct.update({
                  where: { id: savedProduct.id },
                  data: {
                    productId,
                    ...(variationId ? { variationId } : {}),
                    ...(warehouseId ? { warehouseId } : {}),
                    ...(customId ? { customId } : {}),
                    name,
                  },
                });
              } else {
                savedProduct = await prisma.posProduct.create({
                  data: {
                    storeId: store.id,
                    productId,
                    variationId,
                    warehouseId,
                    customId,
                    name,
                  },
                });
              }

              if (variationId && variationId !== productId) {
                await prisma.wmsProductProfile.upsert({
                  where: {
                    storeId_variationId: {
                      storeId: store.id,
                      variationId,
                    },
                  },
                  update: {
                    posProductId: savedProduct.id,
                    productId,
                    ...(warehouseId ? { posWarehouseRef: warehouseId } : {}),
                  },
                  create: {
                    tenantId: store.tenantId,
                    storeId: store.id,
                    posProductId: savedProduct.id,
                    productId,
                    variationId,
                    posWarehouseRef: warehouseId,
                    status: WmsProductProfileStatus.DEFAULT,
                    isSerialized: true,
                  },
                });
              }
              syncedCatalogCount += 1;
            }
          }
          const pageNum = Number.parseInt(String(body?.page_number ?? page), 10) || page;
          totalPages = Math.max(pageNum, Number.parseInt(String(body?.total_pages ?? pageNum), 10) || pageNum);
          if (pageNum >= totalPages || rawRows.length === 0) break;
          page = pageNum + 1;
        }
      } catch (err: any) {
        console.warn(`[TONIOS_DIAG] Catalog sync warning for store=${store.id}: ${err?.message || 'Unknown error'}`);
      }

      // Ensure every existing stockable posProduct in this store has a WmsProductProfile
      const storeProducts = await prisma.posProduct.findMany({
        where: { storeId: store.id },
        select: { id: true, productId: true, variationId: true, warehouseId: true },
      });
      for (const p of storeProducts) {
        if (p.variationId && p.variationId !== p.productId) {
          await prisma.wmsProductProfile.upsert({
            where: {
              storeId_variationId: {
                storeId: store.id,
                variationId: p.variationId,
              },
            },
            update: {
              posProductId: p.id,
              productId: p.productId,
            },
            create: {
              tenantId: store.tenantId,
              storeId: store.id,
              posProductId: p.id,
              productId: p.productId,
              variationId: p.variationId,
              posWarehouseRef: p.warehouseId,
              status: WmsProductProfileStatus.DEFAULT,
              isSerialized: true,
            },
          });
        }
      }

      // 4. Fetch recent orders + live single-order state for every open/confirmed order of this store
      const liveOrdersByPosOrderId = new Map<string, any>();
      try {
        const endUnix = Math.floor(Date.now() / 1000) + 60;
        const startUnix = endUnix - 21 * 24 * 60 * 60;
        let page = 1;
        let totalPages = 1;
        while (page <= totalPages && page <= 25) {
          const orderParams = new URLSearchParams({
            api_key: apiKey,
            updateStatus: 'updated_at',
            startDateTime: String(startUnix),
            endDateTime: String(endUnix),
            page_number: String(page),
          });
          const resp = await fetch(
            `https://pos.pages.fm/api/v1/shops/${encodeURIComponent(store.shopId)}/orders?${orderParams.toString()}`,
            { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
          );
          if (!resp.ok) break;
          const body: any = await resp.json().catch(() => null);
          const rows: any[] = Array.isArray(body?.orders)
            ? body.orders
            : Array.isArray(body?.data)
              ? body.data
              : [];
          for (const row of rows) {
            const oid = readSeedIdentifier(row?.id);
            if (oid) liveOrdersByPosOrderId.set(oid, row);
          }
          const pageNum = Number.parseInt(String(body?.page_number ?? page), 10) || page;
          totalPages = Math.max(pageNum, Number.parseInt(String(body?.total_pages ?? pageNum), 10) || pageNum);
          if (pageNum >= totalPages || rows.length === 0) break;
          page = pageNum + 1;
        }
      } catch (err: any) {
        console.warn(`[TONIOS_DIAG] Recent orders window fetch warning for store=${store.id}: ${err?.message || 'Unknown error'}`);
      }

      // Explicitly inspect open post-go-live fulfillment orders and confirmed DB orders
      const trackedDbOrders = await prisma.posOrder.findMany({
        where: {
          tenantId: store.tenantId,
          shopId: store.shopId,
          ...(effectiveGoLiveAt ? { insertedAt: { gte: effectiveGoLiveAt } } : {}),
          OR: [
            { status: 1, isVoid: false },
            {
              wmsFulfillmentOrders: {
                some: {
                  status: {
                    in: [
                      WmsFulfillmentOrderStatus.ISSUE,
                      WmsFulfillmentOrderStatus.RESTOCKING,
                      WmsFulfillmentOrderStatus.PARTIAL,
                      WmsFulfillmentOrderStatus.READY,
                    ],
                  },
                },
              },
            },
          ],
        },
        select: {
          id: true,
          posOrderId: true,
          dateLocal: true,
          status: true,
          isVoid: true,
          totalQuantity: true,
          orderSnapshot: true,
          itemData: true,
          wmsFulfillmentOrders: {
            select: {
              id: true,
              status: true,
              issueReason: true,
              pickedQuantity: true,
              basketId: true,
            },
          },
        },
        orderBy: [{ dateLocal: 'asc' }, { posOrderId: 'asc' }],
        take: 120,
      });

      const targetedLookupDiagnostics: Array<Record<string, unknown>> = [];
      for (const dbOrder of trackedDbOrders) {
        const hasFulfillmentIssue = dbOrder.wmsFulfillmentOrders.some(
          (fo) => fo.status === WmsFulfillmentOrderStatus.ISSUE,
        );
        if (liveOrdersByPosOrderId.has(dbOrder.posOrderId) && !hasFulfillmentIssue) {
          continue;
        }

        try {
          const singleParams = new URLSearchParams({ api_key: apiKey });
          const singleResp = await fetch(
            `https://pos.pages.fm/api/v1/shops/${encodeURIComponent(store.shopId)}/orders/${encodeURIComponent(dbOrder.posOrderId)}?${singleParams.toString()}`,
            { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
          );
          const singleBody: any = await singleResp.json().catch(() => null);
          const liveData =
            singleResp.ok && singleBody?.success === true && singleBody.data && typeof singleBody.data === 'object' && !Array.isArray(singleBody.data)
              ? singleBody.data
              : null;

          if (liveData) {
            liveOrdersByPosOrderId.set(dbOrder.posOrderId, liveData);
          } else if (singleResp.status === 404 && !dbOrder.isVoid) {
            await prisma.posOrder.update({
              where: { id: dbOrder.id },
              data: { isVoid: true },
            });
          }

          if (hasFulfillmentIssue || singleResp.status !== 200 || !liveData) {
            const liveItems = Array.isArray(liveData?.items) ? liveData.items : [];
            targetedLookupDiagnostics.push({
              posOrderId: dbOrder.posOrderId,
              dateLocal: dbOrder.dateLocal,
              dbStatus: dbOrder.status,
              dbIsVoid: dbOrder.isVoid,
              httpStatus: singleResp.status,
              apiSuccess: Boolean(singleBody?.success),
              liveStatus: liveData?.status ?? null,
              liveUpdatedAt: liveData?.updated_at ?? null,
              liveTotalQuantity: liveData?.total_quantity ?? null,
              liveWarehouseId: readSeedIdentifier(liveData?.warehouse_id ?? liveData?.warehouseId),
              liveItemCount: liveItems.length,
              liveItemRefs: liveItems.slice(0, 5).map((it: any) => ({
                qty: it?.quantity ?? null,
                returned: (it?.returned_count ?? 0) || (it?.return_quantity ?? 0) || (it?.returning_quantity ?? 0),
                varId: readSeedIdentifier(it?.variation_id ?? it?.variationId ?? it?.variation_info?.id),
                prodId: readSeedIdentifier(it?.product_id ?? it?.productId),
                sku: normalizeSeedSku(it?.product_display_id ?? it?.variation_info?.display_id ?? it?.variation_info?.barcode),
                hasVariationName: Boolean(typeof it?.variation_info?.name === 'string' && it.variation_info.name.trim()),
                hasItemName: Boolean(typeof it?.name === 'string' && it.name.trim()),
                hasComponents: Array.isArray(it?.components) || Array.isArray(it?.combo_items),
              })),
            });
          }
        } catch (err: any) {
          targetedLookupDiagnostics.push({
            posOrderId: dbOrder.posOrderId,
            dateLocal: dbOrder.dateLocal,
            error: err?.message || 'fetch_failed',
          });
        }
      }

      let updatedLivePosOrders = 0;
      let createdLivePosOrders = 0;
      for (const [posOrderId, rawOrder] of Array.from(liveOrdersByPosOrderId.entries())) {
        const rawShopId = readSeedIdentifier(rawOrder?.shop_id) ?? store.shopId;
        if (rawShopId !== store.shopId) continue;
        const sourceNameLower = String(rawOrder?.order_sources_name ?? '').trim().toLowerCase();
        if (sourceNameLower === 'tiktok' || sourceNameLower === 'shopee') continue;
        if ((rawOrder?.status === 0 || rawOrder?.status === '0') && rawOrder?.shopify_abandon_checkout_id) {
          continue;
        }

        const parsedStatus = Number(rawOrder?.status);
        const normalizedStatus = Number.isFinite(parsedStatus) ? Math.trunc(parsedStatus) : null;
        const rawItems = Array.isArray(rawOrder?.items) ? rawOrder.items : [];
        const hasAnyProductIdentifier = rawItems.some((it: any) => Boolean(
          readSeedIdentifier(it?.variation_id)
          ?? readSeedIdentifier(it?.variationId)
          ?? readSeedIdentifier(it?.variation_info?.id)
          ?? readSeedIdentifier(it?.product_id)
          ?? readSeedIdentifier(it?.productId)
          ?? normalizeSeedSku(it?.product_display_id ?? it?.variation_info?.display_id ?? it?.variation_info?.barcode),
        ));
        const isNoProductNonConfirmed =
          Array.isArray(rawOrder?.items)
          && (rawItems.length === 0 || !hasAnyProductIdentifier)
          && normalizedStatus !== 1
          && normalizedStatus !== 0;
        const nextIsVoid = normalizedStatus === 7 || isNoProductNonConfirmed;
        const nextItemData = rawItems.map((it: any) => {
          const variation = it?.variation_info && typeof it.variation_info === 'object' ? it.variation_info : {};
          return {
            quantity: readSeedPositiveInt(it?.quantity) || 1,
            productId: readSeedIdentifier(it?.product_id ?? it?.productId),
            variationId: readSeedIdentifier(it?.variation_id ?? it?.variationId ?? variation?.id),
            variationName: typeof variation?.name === 'string' ? variation.name : null,
            productDisplayId: normalizeSeedSku(
              variation?.product_display_id
              ?? it?.product_display_id
              ?? it?.productDisplayId
              ?? variation?.display_id
              ?? variation?.barcode,
            ),
          };
        });
        const calcQty = nextItemData.reduce((sum: number, it: any) => sum + (it.quantity || 0), 0);

        const existingPosOrder = await prisma.posOrder.findUnique({
          where: {
            tenantId_shopId_posOrderId: {
              tenantId: store.tenantId,
              shopId: store.shopId,
              posOrderId,
            },
          },
          select: {
            id: true,
            status: true,
            isVoid: true,
            totalQuantity: true,
            orderSnapshot: true,
          },
        });

        if (existingPosOrder) {
          const prevSnap =
            existingPosOrder.orderSnapshot
            && typeof existingPosOrder.orderSnapshot === 'object'
            && !Array.isArray(existingPosOrder.orderSnapshot)
              ? (existingPosOrder.orderSnapshot as Record<string, unknown>)
              : {};
          const mergedSnapshot: Record<string, unknown> = {
            ...prevSnap,
            id: rawOrder.id ?? prevSnap.id,
            shop_id: rawOrder.shop_id ?? store.shopId,
            status: normalizedStatus ?? prevSnap.status,
            status_name: rawOrder.status_name ?? prevSnap.status_name ?? null,
            inserted_at: rawOrder.inserted_at ?? prevSnap.inserted_at ?? null,
            updated_at: rawOrder.updated_at ?? prevSnap.updated_at ?? null,
            warehouse_id: rawOrder.warehouse_id ?? prevSnap.warehouse_id ?? null,
            total_quantity: rawOrder.total_quantity ?? calcQty,
            items: rawItems,
          };

          await prisma.posOrder.update({
            where: { id: existingPosOrder.id },
            data: {
              ...(normalizedStatus !== null ? { status: normalizedStatus } : {}),
              ...(typeof rawOrder?.status_name === 'string' ? { statusName: rawOrder.status_name } : {}),
              isVoid: nextIsVoid,
              ...(calcQty > 0 ? { totalQuantity: calcQty } : {}),
              ...(rawItems.length > 0 ? { itemData: nextItemData as Prisma.InputJsonValue } : {}),
              orderSnapshot: mergedSnapshot as Prisma.InputJsonValue,
            },
          });
          updatedLivePosOrders += 1;
        } else if (normalizedStatus === 1 && !nextIsVoid && rawOrder?.inserted_at) {
          const insertedAt = new Date(rawOrder.inserted_at);
          if (!Number.isNaN(insertedAt.getTime())) {
            const dateLocal = formatManilaDateFromUtc(insertedAt);
            const codNumeric = Number(rawOrder?.cod ?? 0);
            const safeCod = Number.isFinite(codNumeric) ? codNumeric : 0;
            await prisma.posOrder.create({
              data: {
                tenantId: store.tenantId,
                teamId: store.teamId ?? null,
                shopId: store.shopId,
                posOrderId,
                insertedAt,
                dateLocal,
                status: normalizedStatus,
                statusName: typeof rawOrder?.status_name === 'string' ? rawOrder.status_name : null,
                cod: new Prisma.Decimal(safeCod),
                salesCod: new Prisma.Decimal(safeCod),
                mktgCod: new Prisma.Decimal(0),
                isVoid: false,
                cogs: new Prisma.Decimal(0),
                totalQuantity: Math.max(calcQty, 1),
                itemData: nextItemData as Prisma.InputJsonValue,
                orderSnapshot: {
                  id: rawOrder.id,
                  shop_id: store.shopId,
                  status: normalizedStatus,
                  status_name: rawOrder.status_name ?? null,
                  inserted_at: rawOrder.inserted_at,
                  updated_at: rawOrder.updated_at ?? null,
                  warehouse_id: rawOrder.warehouse_id ?? null,
                  total_quantity: rawOrder.total_quantity ?? calcQty,
                  items: rawItems,
                } as Prisma.InputJsonValue,
              },
            });
            createdLivePosOrders += 1;
          }
        }
      }

      await prisma.posStore.update({
        where: { id: store.id },
        data: {
          enabled: true,
          lastSyncAt: now,
        },
      });
      if (store.integration) {
        await prisma.integration.update({
          where: { id: store.integration.id },
          data: {
            enabled: true,
            status: 'ACTIVE',
            syncStatus: 'SUCCESS',
            syncError: null,
            lastSyncAt: now,
          },
        });
      }

      console.log('[TONIOS_SYNC_SUMMARY]', JSON.stringify({
        storeId: store.id,
        shopId: store.shopId,
        syncedCatalogCount,
        liveOrdersFetched: liveOrdersByPosOrderId.size,
        updatedLivePosOrders,
        createdLivePosOrders,
        targetedLookupDiagnostics,
      }));
    }
  } catch (err: any) {
    console.error('Warning during Tonios POS connection & order sync:', err?.message || err);
  }
}

async function reconcileToniosWmsFulfillmentQueue() {
  try {
    const now = new Date();
    const targetStores = await prisma.posStore.findMany({
      where: {
        status: 'ACTIVE',
        NOT: { enabled: false },
        OR: [
          { name: { contains: 'tonio', mode: 'insensitive' } },
          { shopName: { contains: 'tonio', mode: 'insensitive' } },
          { tenant: { name: { contains: 'cristobal', mode: 'insensitive' } } },
        ],
      },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            wmsFulfillmentGoLiveAt: true,
          },
        },
      },
    });

    for (const store of targetStores) {
      const catalogProducts = await prisma.posProduct.findMany({
        where: { storeId: store.id },
        select: {
          productId: true,
          variationId: true,
          customId: true,
          name: true,
        },
      });

      type CatalogRow = (typeof catalogProducts)[number];
      const isStockable = (row: CatalogRow) => Boolean(row.variationId && row.variationId !== row.productId);
      const byVariationId = new Map<string, CatalogRow>();
      const byProductId = new Map<string, CatalogRow[]>();
      const byCustomKey = new Map<string, CatalogRow[]>();
      const byNameKey = new Map<string, CatalogRow[]>();

      for (const row of catalogProducts) {
        if (row.variationId) {
          const cur = byVariationId.get(row.variationId);
          if (!cur || (!isStockable(cur) && isStockable(row))) {
            byVariationId.set(row.variationId, row);
          }
        }
        if (row.productId) {
          const list = byProductId.get(row.productId) ?? [];
          list.push(row);
          byProductId.set(row.productId, list);
        }
        const normSku = normalizeSeedSku(row.customId)?.toLowerCase();
        if (normSku) {
          const list = byCustomKey.get(normSku) ?? [];
          list.push(row);
          byCustomKey.set(normSku, list);
        }
        const normName = typeof row.name === 'string' && row.name.trim().length >= 2
          ? row.name.trim().toLowerCase()
          : null;
        if (normName) {
          const list = byNameKey.get(normName) ?? [];
          list.push(row);
          byNameKey.set(normName, list);
        }
      }

      const pickUnambiguous = (rows: CatalogRow[] | undefined): CatalogRow | null => {
        if (!rows || rows.length === 0) return null;
        const stockable = rows.filter((r) => isStockable(r));
        const pool = stockable.length > 0 ? stockable : rows.filter((r) => Boolean(r.variationId));
        if (pool.length === 0) return rows.length === 1 ? rows[0] : null;
        const vars = new Set(pool.map((r) => r.variationId!));
        return vars.size === 1 ? pool[0] : null;
      };

      const resolveSeedEmptyIssueReason = (
        snap: Record<string, any> | null,
        fallbackItemData: Prisma.JsonValue | null,
      ): string => {
        const hasSnapItems = Array.isArray(snap?.items);
        const snapItems = hasSnapItems ? (snap!.items as unknown[]) : [];
        const fbItems = Array.isArray(fallbackItemData) ? fallbackItemData : [];
        if (!hasSnapItems && fbItems.length === 0) {
          return 'Order line items have not arrived from Pancake POS yet — syncing from POS';
        }
        if (snapItems.length === 0 && fbItems.length === 0) {
          return 'Order has no line items in Pancake POS — add a product variation in POS to pick';
        }
        return 'Order item in Pancake POS is not linked to a catalog variation — link a product variation in POS to pick';
      };

      const extractLinesFromItems = (items: unknown[], depth = 0): Array<{
        variationId: string;
        productId: string | null;
        productName: string;
        productDisplayId: string | null;
        quantityRequired: number;
        lineSnapshot: Prisma.InputJsonValue;
      }> => {
        const grouped = new Map<string, {
          variationId: string;
          productId: string | null;
          productName: string;
          productDisplayId: string | null;
          quantityRequired: number;
          lineSnapshot: Prisma.InputJsonValue;
        }>();

        for (const raw of items) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const item = raw as Record<string, any>;
          const qty = readSeedPositiveInt(item.quantity);
          const returned =
            readSeedPositiveInt(item.returned_count)
            + readSeedPositiveInt(item.return_quantity)
            + readSeedPositiveInt(item.returning_quantity);
          const required = Math.max(qty - returned, 0);
          if (required <= 0) continue;

          const variationInfo = item.variation_info && typeof item.variation_info === 'object' && !Array.isArray(item.variation_info)
            ? (item.variation_info as Record<string, any>)
            : null;
          const sourceProductId =
            readSeedIdentifier(item.product_id)
            ?? readSeedIdentifier(item.productId)
            ?? readSeedIdentifier(variationInfo?.product_id)
            ?? readSeedIdentifier(variationInfo?.productId);
          const explicitVarId =
            readSeedIdentifier(item.variation_id)
            ?? readSeedIdentifier(item.variationId)
            ?? readSeedIdentifier(variationInfo?.variation_id)
            ?? readSeedIdentifier(variationInfo?.variationId);
          const variationInfoId = readSeedIdentifier(variationInfo?.id);
          const sourceVariationId =
            explicitVarId
            ?? (variationInfoId && (!sourceProductId || variationInfoId !== sourceProductId) ? variationInfoId : null);
          const skus = [
            normalizeSeedSku(item.product_display_id),
            normalizeSeedSku(item.productDisplayId),
            normalizeSeedSku(item.custom_id),
            normalizeSeedSku(item.customId),
            normalizeSeedSku(item.sku),
            normalizeSeedSku(item.barcode),
            normalizeSeedSku(variationInfo?.product_display_id),
            normalizeSeedSku(variationInfo?.display_id),
            normalizeSeedSku(variationInfo?.custom_id),
            normalizeSeedSku(variationInfo?.barcode),
          ].filter((v): v is string => Boolean(v));
          const names = [
            typeof variationInfo?.name === 'string' && variationInfo.name.trim().length >= 2 ? variationInfo.name.trim() : null,
            typeof item.variationName === 'string' && item.variationName.trim().length >= 2 ? item.variationName.trim() : null,
            typeof item.product_name === 'string' && item.product_name.trim().length >= 2 ? item.product_name.trim() : null,
            typeof item.name === 'string' && item.name.trim().length >= 2 ? item.name.trim() : null,
          ].filter((v): v is string => Boolean(v));

          const hasDistinctVar = Boolean(sourceVariationId && (!sourceProductId || sourceVariationId !== sourceProductId));
          let resolved: CatalogRow | null = null;
          if (hasDistinctVar) {
            resolved = byVariationId.get(sourceVariationId!) ?? null;
          } else {
            const direct = sourceVariationId ? byVariationId.get(sourceVariationId) ?? null : null;
            resolved =
              (direct && isStockable(direct) ? direct : null)
              ?? skus.map((s) => pickUnambiguous(byCustomKey.get(s.toLowerCase()))).find((r): r is CatalogRow => Boolean(r))
              ?? (sourceProductId ? pickUnambiguous(byProductId.get(sourceProductId)) : null)
              ?? names.map((n) => pickUnambiguous(byNameKey.get(n.toLowerCase()))).find((r): r is CatalogRow => Boolean(r))
              ?? direct
              ?? null;
          }

          const variationId = resolved?.variationId ?? sourceVariationId ?? null;
          if (!variationId) {
            if (depth === 0) {
              const childItems = Array.isArray(item.components)
                ? item.components
                : Array.isArray(item.combo_items)
                  ? item.combo_items
                  : null;
              if (childItems && childItems.length > 0) {
                for (const childLine of extractLinesFromItems(childItems, depth + 1)) {
                  const scaled = childLine.quantityRequired * required;
                  const existingChild = grouped.get(childLine.variationId);
                  if (existingChild) {
                    existingChild.quantityRequired += scaled;
                  } else {
                    grouped.set(childLine.variationId, { ...childLine, quantityRequired: scaled });
                  }
                }
              }
            }
            continue;
          }

          const productId = resolved?.productId ?? sourceProductId;
          const productName =
            (typeof variationInfo?.name === 'string' && variationInfo.name.trim())
            || (typeof item.variationName === 'string' && item.variationName.trim())
            || resolved?.name
            || (typeof item.note_product === 'string' && item.note_product.trim())
            || `Variation ${variationId}`;
          const productDisplayId =
            resolved?.customId
            ?? normalizeSeedSku(item.productDisplayId ?? item.product_display_id ?? variationInfo?.display_id ?? variationInfo?.product_display_id ?? variationInfo?.barcode);

          const existing = grouped.get(variationId);
          if (existing) {
            existing.quantityRequired += required;
            continue;
          }
          grouped.set(variationId, {
            variationId,
            productId,
            productName,
            productDisplayId,
            quantityRequired: required,
            lineSnapshot: {
              variationId,
              productId,
              productName,
              productDisplayId,
              sourceVariationId,
              sourceProductId,
              sourceItem: item,
            } as Prisma.InputJsonValue,
          });
        }
        return Array.from(grouped.values());
      };

      let effectiveGoLiveAt = store.tenant.wmsFulfillmentGoLiveAt;
      if (!effectiveGoLiveAt) {
        const earliestNovOrder = await prisma.posOrder.findFirst({
          where: {
            tenantId: store.tenantId,
            shopId: store.shopId,
            dateLocal: { gte: '2026-11-09' },
          },
          orderBy: { insertedAt: 'asc' },
          select: { insertedAt: true },
        });
        const manilaNov9Cutoff = new Date('2026-11-09T00:00:00+08:00');
        effectiveGoLiveAt = earliestNovOrder?.insertedAt && earliestNovOrder.insertedAt < manilaNov9Cutoff
          ? earliestNovOrder.insertedAt
          : manilaNov9Cutoff;
        await prisma.tenant.update({
          where: { id: store.tenantId },
          data: { wmsFulfillmentGoLiveAt: effectiveGoLiveAt },
        });
      }

      // 1. Cancel unpicked fulfillment orders whose POS order is canceled (6), void, or pre-go-live
      const unpickedCanceledOrders = await prisma.wmsFulfillmentOrder.findMany({
        where: {
          tenantId: store.tenantId,
          storeId: store.id,
          basketId: null,
          pickedQuantity: 0,
          status: {
            in: [
              WmsFulfillmentOrderStatus.ISSUE,
              WmsFulfillmentOrderStatus.RESTOCKING,
              WmsFulfillmentOrderStatus.PARTIAL,
              WmsFulfillmentOrderStatus.READY,
            ],
          },
          posOrder: {
            is: {
              OR: [
                { status: 6 },
                { isVoid: true },
                ...(effectiveGoLiveAt ? [{ insertedAt: { lt: effectiveGoLiveAt } }] : []),
              ],
            },
          },
        },
        select: {
          id: true,
          posOrder: {
            select: {
              status: true,
              isVoid: true,
              insertedAt: true,
            },
          },
        },
      });

      let canceledPreGoLiveCount = 0;
      for (const canceledOrder of unpickedCanceledOrders) {
        const isPosCanceledOrVoid =
          canceledOrder.posOrder?.status === 6 || Boolean(canceledOrder.posOrder?.isVoid);
        const cancelReason = isPosCanceledOrVoid
          ? 'Order was canceled in POS.'
          : 'Excluded before client WMS fulfillment go-live.';
        if (!isPosCanceledOrVoid) {
          canceledPreGoLiveCount += 1;
        }
        await prisma.wmsFulfillmentLine.updateMany({
          where: { fulfillmentOrderId: canceledOrder.id },
          data: {
            quantityAllocated: 0,
            quantityPicked: 0,
            status: WmsFulfillmentLineStatus.CANCELED,
            issueReason: cancelReason,
          },
        });
        await prisma.wmsFulfillmentOrder.update({
          where: { id: canceledOrder.id },
          data: {
            status: WmsFulfillmentOrderStatus.CANCELED,
            issueReason: cancelReason,
            allocatedQuantity: 0,
            pickedQuantity: 0,
            completedAt: now,
            lastSyncedAt: now,
          },
        });
      }

      // 1b. Sync unpicked pick-status orders whose POS order is already shipped/delivered/RTS (2, 3, 4, 5)
      const unpickedPosShippedOrders = await prisma.wmsFulfillmentOrder.findMany({
        where: {
          tenantId: store.tenantId,
          storeId: store.id,
          basketId: null,
          pickedQuantity: 0,
          status: {
            in: [
              WmsFulfillmentOrderStatus.ISSUE,
              WmsFulfillmentOrderStatus.RESTOCKING,
              WmsFulfillmentOrderStatus.PARTIAL,
              WmsFulfillmentOrderStatus.READY,
            ],
          },
          posOrder: {
            is: {
              isVoid: false,
              status: { in: [2, 3, 4, 5] },
              ...(effectiveGoLiveAt ? { insertedAt: { gte: effectiveGoLiveAt } } : {}),
            },
          },
        },
        select: {
          id: true,
          warehouseId: true,
          posOrderId: true,
          status: true,
          completedAt: true,
          posOrder: {
            select: {
              status: true,
              tracking: true,
            },
          },
        },
      });

      for (const shippedOrder of unpickedPosShippedOrders) {
        await prisma.wmsFulfillmentLine.updateMany({
          where: {
            fulfillmentOrderId: shippedOrder.id,
            status: { not: WmsFulfillmentLineStatus.CANCELED },
            quantityRequired: { gt: 0 },
          },
          data: {
            quantityAllocated: 0,
            quantityPicked: 0,
            status: WmsFulfillmentLineStatus.PICKED,
            issueReason: null,
          },
        });
        await prisma.wmsFulfillmentOrder.update({
          where: { id: shippedOrder.id },
          data: {
            status: WmsFulfillmentOrderStatus.PACKED,
            issueReason: null,
            allocatedQuantity: 0,
            pickedQuantity: 0,
            completedAt: shippedOrder.completedAt ?? now,
            lastSyncedAt: now,
          },
        });
        await prisma.wmsStaffActivity.create({
          data: {
            tenantId: store.tenantId,
            actorId: null,
            actionType: shippedOrder.posOrder?.status === 3 ? 'ORDER_DELIVERY_SYNC' : 'ORDER_DISPATCH_SYNC',
            resourceType: 'WMS_FULFILLMENT_ORDER',
            resourceId: shippedOrder.id,
            storeId: store.id,
            warehouseId: shippedOrder.warehouseId,
            fromStatus: shippedOrder.status,
            toStatus: WmsFulfillmentOrderStatus.PACKED,
            reasonCode: 'POS_STATUS_SYNC',
            metadata: {
              mode: 'POS_SYNC',
              posOrderId: shippedOrder.posOrderId,
              posStatus: shippedOrder.posOrder?.status ?? null,
              trackingCode: shippedOrder.posOrder?.tracking ?? null,
              previousWmsStatus: shippedOrder.status,
              reason: 'Synced from POS status while order was still in Pick status',
            },
          },
        });
      }

      // 2. Sync all confirmed (status=1, isVoid=false) post-go-live POS orders for this store
      const confirmedPosOrders = await prisma.posOrder.findMany({
        where: {
          tenantId: store.tenantId,
          shopId: store.shopId,
          status: 1,
          isVoid: false,
          ...(effectiveGoLiveAt
            ? { insertedAt: { gte: effectiveGoLiveAt } }
            : {}),
        },
        orderBy: [{ dateLocal: 'asc' }, { insertedAt: 'asc' }],
      });

      let createdFulfillmentCount = 0;
      let recoveredIssueCount = 0;

      for (const posOrder of confirmedPosOrders) {
        const snap = posOrder.orderSnapshot && typeof posOrder.orderSnapshot === 'object' && !Array.isArray(posOrder.orderSnapshot)
          ? (posOrder.orderSnapshot as Record<string, any>)
          : null;
        const primaryLines = extractLinesFromItems(Array.isArray(snap?.items) ? snap!.items : []);
        const lines = primaryLines.length > 0
          ? primaryLines
          : extractLinesFromItems(Array.isArray(posOrder.itemData) ? (posOrder.itemData as unknown[]) : []);
        const emptyIssueReason = lines.length === 0
          ? resolveSeedEmptyIssueReason(snap, posOrder.itemData)
          : null;
        const totalQuantity = lines.reduce((sum, l) => sum + l.quantityRequired, 0);
        const sourceItemsHash = buildSeedFulfillmentDemandHash(lines);
        const posWarehouseRef = readSeedIdentifier(snap?.warehouse_id ?? snap?.warehouseId);

        const existing = await prisma.wmsFulfillmentOrder.findUnique({
          where: { posOrderDbId: posOrder.id },
          include: { lines: true },
        });

        if (!existing) {
          await prisma.wmsFulfillmentOrder.create({
            data: {
              tenantId: posOrder.tenantId,
              storeId: store.id,
              posOrderDbId: posOrder.id,
              shopId: posOrder.shopId,
              posOrderId: posOrder.posOrderId,
              posWarehouseRef,
              customerName: posOrder.customerName,
              customerPhone: posOrder.customerPhone,
              status: lines.length === 0 ? WmsFulfillmentOrderStatus.ISSUE : WmsFulfillmentOrderStatus.RESTOCKING,
              assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
              issueReason: emptyIssueReason,
              sourceTotalQuantity: totalQuantity,
              totalQuantity,
              sourceItemsHash,
              sourceRevision: 1,
              lastSyncedAt: now,
              lines: {
                create: lines.map((line) => ({
                  tenantId: posOrder.tenantId,
                  productId: line.productId,
                  variationId: line.variationId,
                  productName: line.productName,
                  productDisplayId: line.productDisplayId,
                  sourceQuantityRequired: line.quantityRequired,
                  quantityRequired: line.quantityRequired,
                  lineSnapshot: line.lineSnapshot,
                  status: WmsFulfillmentLineStatus.RESTOCKING,
                })),
              },
            },
          });
          createdFulfillmentCount += 1;
          continue;
        }

        if (
          existing.basketId
          || (
            existing.status !== WmsFulfillmentOrderStatus.ISSUE
            && existing.status !== WmsFulfillmentOrderStatus.RESTOCKING
            && existing.status !== WmsFulfillmentOrderStatus.PARTIAL
            && existing.status !== WmsFulfillmentOrderStatus.READY
          )
        ) {
          continue;
        }

        if (lines.length > 0 && (existing.status === WmsFulfillmentOrderStatus.ISSUE || existing.sourceItemsHash !== sourceItemsHash)) {
          for (const line of lines) {
            await prisma.wmsFulfillmentLine.upsert({
              where: {
                fulfillmentOrderId_variationId: {
                  fulfillmentOrderId: existing.id,
                  variationId: line.variationId,
                },
              },
              create: {
                fulfillmentOrderId: existing.id,
                tenantId: posOrder.tenantId,
                productId: line.productId,
                variationId: line.variationId,
                productName: line.productName,
                productDisplayId: line.productDisplayId,
                sourceQuantityRequired: line.quantityRequired,
                quantityRequired: line.quantityRequired,
                lineSnapshot: line.lineSnapshot,
                status: WmsFulfillmentLineStatus.RESTOCKING,
              },
              update: {
                productId: line.productId,
                productName: line.productName,
                productDisplayId: line.productDisplayId,
                sourceQuantityRequired: line.quantityRequired,
                quantityRequired: line.quantityRequired,
                lineSnapshot: line.lineSnapshot,
                status: WmsFulfillmentLineStatus.RESTOCKING,
                issueReason: null,
              },
            });
          }

          await prisma.wmsFulfillmentLine.updateMany({
            where: {
              fulfillmentOrderId: existing.id,
              variationId: { notIn: lines.map((l) => l.variationId) },
            },
            data: {
              status: WmsFulfillmentLineStatus.CANCELED,
              sourceQuantityRequired: 0,
              quantityRequired: 0,
              quantityAllocated: 0,
              issueReason: null,
            },
          });

          await prisma.wmsFulfillmentOrder.update({
            where: { id: existing.id },
            data: {
              posWarehouseRef,
              status: WmsFulfillmentOrderStatus.RESTOCKING,
              issueReason: null,
              sourceTotalQuantity: totalQuantity,
              totalQuantity,
              sourceItemsHash,
              lastSyncedAt: now,
            },
          });

          if (existing.status === WmsFulfillmentOrderStatus.ISSUE) {
            recoveredIssueCount += 1;
          }
        } else if (
          lines.length === 0
          && existing.status === WmsFulfillmentOrderStatus.ISSUE
          && emptyIssueReason
          && existing.issueReason !== emptyIssueReason
        ) {
          await prisma.wmsFulfillmentOrder.update({
            where: { id: existing.id },
            data: {
              issueReason: emptyIssueReason,
              lastSyncedAt: now,
            },
          });
        }
      }

      // 3. Recompute BASKET_DEMAND readiness against eligible PUTAWAY BIN inventory units
      const putawayBinUnits = await prisma.wmsInventoryUnit.findMany({
        where: {
          tenantId: store.tenantId,
          storeId: store.id,
          status: WmsInventoryUnitStatus.PUTAWAY,
          currentLocationId: { not: null },
          currentLocation: { is: { kind: WmsLocationKind.BIN, isActive: true } },
          OR: [{ expirationDate: null }, { expirationDate: { gt: now } }],
          pickReservations: { none: { status: { in: ['RESERVED', 'PICKED'] } } },
          basketUnits: { none: { status: { in: ['PICKED', 'PACKED'] } } },
        },
        select: {
          warehouseId: true,
          variationId: true,
          posWarehouseRef: true,
        },
      });

      const activeHolds = await prisma.wmsBasketPickDemandBin.groupBy({
        by: ['warehouseId', 'variationId'],
        where: {
          tenantId: store.tenantId,
          basket: {
            status: { in: ['ASSIGNED', 'IN_PICKING', 'FULL_HELD'] },
          },
        },
        _sum: { quantityTarget: true, quantityPicked: true },
      });
      const heldByWhVar = new Map<string, number>();
      for (const hold of activeHolds) {
        const held = Math.max((hold._sum.quantityTarget ?? 0) - (hold._sum.quantityPicked ?? 0), 0);
        if (held > 0) {
          heldByWhVar.set(`${hold.warehouseId}::${hold.variationId}`, held);
        }
      }

      const candidateQueueOrders = await prisma.wmsFulfillmentOrder.findMany({
        where: {
          tenantId: store.tenantId,
          storeId: store.id,
          assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
          basketId: null,
          status: {
            in: [
              WmsFulfillmentOrderStatus.READY,
              WmsFulfillmentOrderStatus.RESTOCKING,
              WmsFulfillmentOrderStatus.PARTIAL,
            ],
          },
          posOrder: {
            is: {
              status: 1,
              isVoid: false,
              ...(effectiveGoLiveAt ? { insertedAt: { gte: effectiveGoLiveAt } } : {}),
            },
          },
        },
        include: {
          posOrder: { select: { dateLocal: true } },
          lines: true,
        },
        orderBy: [{ posOrder: { dateLocal: 'asc' } }, { id: 'asc' }],
      });

      const virtualUsedByWhVar = new Map<string, number>();
      const availableFor = (warehouseId: string, variationId: string, orderPosWhRef: string | null) => {
        const rawCount = putawayBinUnits.filter((u) => (
          u.warehouseId === warehouseId
          && u.variationId === variationId
          && (!orderPosWhRef || !u.posWarehouseRef || u.posWarehouseRef === orderPosWhRef)
        )).length;
        const held = heldByWhVar.get(`${warehouseId}::${variationId}`) ?? 0;
        const used = virtualUsedByWhVar.get(`${warehouseId}::${variationId}`) ?? 0;
        return Math.max(rawCount - held - used, 0);
      };

      const warehouseIds = Array.from(new Set(putawayBinUnits.map((u) => u.warehouseId)));
      const incompleteOrders: typeof candidateQueueOrders = [];

      // Pass 1: Complete orders first
      for (const order of candidateQueueOrders) {
        const activeLines = order.lines.filter((l) => l.status !== WmsFulfillmentLineStatus.CANCELED && l.quantityRequired > 0);
        if (activeLines.length === 0) continue;

        let fullWarehouseId: string | null = null;
        for (const whId of warehouseIds) {
          const canFulfillAll = activeLines.every(
            (l) => availableFor(whId, l.variationId, order.posWarehouseRef) >= l.quantityRequired,
          );
          if (canFulfillAll) {
            fullWarehouseId = whId;
            break;
          }
        }

        if (!fullWarehouseId) {
          incompleteOrders.push(order);
          continue;
        }

        let orderTotal = 0;
        for (const line of activeLines) {
          const key = `${fullWarehouseId}::${line.variationId}`;
          virtualUsedByWhVar.set(key, (virtualUsedByWhVar.get(key) ?? 0) + line.quantityRequired);
          orderTotal += line.quantityRequired;
          await prisma.wmsFulfillmentLine.update({
            where: { id: line.id },
            data: {
              quantityAllocated: line.quantityRequired,
              quantityPicked: 0,
              status: WmsFulfillmentLineStatus.READY,
              issueReason: null,
            },
          });
        }

        await prisma.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            warehouseId: null,
            totalQuantity: orderTotal,
            allocatedQuantity: orderTotal,
            pickedQuantity: 0,
            status: WmsFulfillmentOrderStatus.READY,
            issueReason: null,
            lastSyncedAt: now,
          },
        });
      }

      // Pass 2: Partial / Restocking orders
      for (const order of incompleteOrders) {
        const activeLines = order.lines.filter((l) => l.status !== WmsFulfillmentLineStatus.CANCELED && l.quantityRequired > 0);
        if (activeLines.length === 0) continue;

        let bestWarehouseId: string | null = warehouseIds[0] ?? null;
        let bestAllocTotal = -1;
        for (const whId of warehouseIds) {
          const allocSum = activeLines.reduce(
            (sum, l) => sum + Math.min(availableFor(whId, l.variationId, order.posWarehouseRef), l.quantityRequired),
            0,
          );
          if (allocSum > bestAllocTotal) {
            bestAllocTotal = allocSum;
            bestWarehouseId = whId;
          }
        }

        let orderTotal = 0;
        let orderAlloc = 0;
        for (const line of activeLines) {
          const avail = bestWarehouseId ? availableFor(bestWarehouseId, line.variationId, order.posWarehouseRef) : 0;
          const alloc = Math.min(avail, line.quantityRequired);
          if (bestWarehouseId && alloc > 0) {
            const key = `${bestWarehouseId}::${line.variationId}`;
            virtualUsedByWhVar.set(key, (virtualUsedByWhVar.get(key) ?? 0) + alloc);
          }
          orderTotal += line.quantityRequired;
          orderAlloc += alloc;
          const missing = Math.max(line.quantityRequired - avail, 0);
          const lineStatus = alloc >= line.quantityRequired
            ? WmsFulfillmentLineStatus.READY
            : alloc > 0
              ? WmsFulfillmentLineStatus.PARTIAL
              : WmsFulfillmentLineStatus.RESTOCKING;
          await prisma.wmsFulfillmentLine.update({
            where: { id: line.id },
            data: {
              quantityAllocated: alloc,
              quantityPicked: 0,
              status: lineStatus,
              issueReason: lineStatus === WmsFulfillmentLineStatus.READY
                ? 'Stock is available for this item, but the complete order cannot be fulfilled yet.'
                : avail <= 0
                  ? `Needs ${line.quantityRequired} unit${line.quantityRequired === 1 ? '' : 's'} in putaway bin inventory.`
                  : `${avail} of ${line.quantityRequired} required unit${line.quantityRequired === 1 ? '' : 's'} available in the selected warehouse; needs ${missing} more.`,
            },
          });
        }

        await prisma.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            warehouseId: null,
            totalQuantity: orderTotal,
            allocatedQuantity: orderAlloc,
            pickedQuantity: 0,
            status: orderAlloc > 0 ? WmsFulfillmentOrderStatus.PARTIAL : WmsFulfillmentOrderStatus.RESTOCKING,
            issueReason: null,
            lastSyncedAt: now,
          },
        });
      }

      const activeQueueStatsAfter = await prisma.wmsFulfillmentOrder.groupBy({
        by: ['status', 'issueReason'],
        where: {
          tenantId: store.tenantId,
          storeId: store.id,
          status: { not: WmsFulfillmentOrderStatus.CANCELED },
          posOrder: {
            is: {
              status: 1,
              isVoid: false,
              ...(effectiveGoLiveAt ? { insertedAt: { gte: effectiveGoLiveAt } } : {}),
            },
          },
        },
        _count: { _all: true },
      });
      const sampleQueueAfter = await prisma.wmsFulfillmentOrder.findMany({
        where: {
          tenantId: store.tenantId,
          storeId: store.id,
          status: { not: WmsFulfillmentOrderStatus.CANCELED },
          posOrder: {
            is: {
              status: 1,
              isVoid: false,
              ...(effectiveGoLiveAt ? { insertedAt: { gte: effectiveGoLiveAt } } : {}),
            },
          },
        },
        select: {
          posOrderId: true,
          status: true,
          issueReason: true,
          totalQuantity: true,
          allocatedQuantity: true,
          pickedQuantity: true,
          posWarehouseRef: true,
          posOrder: { select: { dateLocal: true } },
          lines: {
            where: { status: { not: WmsFulfillmentLineStatus.CANCELED } },
            select: {
              variationId: true,
              quantityRequired: true,
              quantityAllocated: true,
              status: true,
              issueReason: true,
            },
          },
        },
        orderBy: [{ status: 'asc' }, { posOrder: { dateLocal: 'asc' } }, { id: 'asc' }],
        take: 15,
      });

      console.log('[TONIOS_DIAG_AFTER]', JSON.stringify({
        storeId: store.id,
        shopId: store.shopId,
        wmsFulfillmentGoLiveAt: effectiveGoLiveAt ? effectiveGoLiveAt.toISOString() : null,
        canceledStaleFulfillmentCount: unpickedCanceledOrders.length,
        canceledPreGoLiveCount,
        syncedPosShippedPickOrdersCount: unpickedPosShippedOrders.length,
        createdFulfillmentCount,
        recoveredIssueCount,
        putawayBinUnitCount: putawayBinUnits.length,
        fulfillmentStatsAfter: activeQueueStatsAfter,
        sampleQueueAfter,
      }));
    }
  } catch (err: any) {
    console.error('Warning during Tonios WMS fulfillment queue reconciliation:', err?.message || err);
  }
}

async function reconcileFamcoSharedStockPoolsAndQueue() {
  try {
    const famcoTenants = await prisma.tenant.findMany({
      where: {
        OR: [
          { name: { contains: 'famco', mode: 'insensitive' } },
          { slug: { contains: 'famco', mode: 'insensitive' } },
          {
            posStores: {
              some: {
                OR: [
                  { name: { contains: 'famco', mode: 'insensitive' } },
                  { shopName: { contains: 'famco', mode: 'insensitive' } },
                ],
              },
            },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        slug: true,
        wmsFulfillmentGoLiveAt: true,
        posStores: {
          select: {
            id: true,
            name: true,
            shopName: true,
          },
        },
      },
    });

    if (famcoTenants.length === 0) {
      console.log('[FAMCO_POOL_RECONCILE] No Famco tenant found; skipping.');
      return;
    }

    const now = new Date();

    for (const tenant of famcoTenants) {
      // 1. Ensure default WmsProductProfiles exist for all stockable PosProducts in Famco stores
      const posProducts = await prisma.posProduct.findMany({
        where: {
          variationId: { not: null },
          store: { tenantId: tenant.id },
        },
        select: {
          id: true,
          storeId: true,
          productId: true,
          variationId: true,
          warehouseId: true,
        },
      });
      const stockablePosProducts = posProducts.filter(
        (product) => Boolean(product.variationId) && product.variationId !== product.productId,
      );
      if (stockablePosProducts.length > 0) {
        const existingProfileRows = await prisma.wmsProductProfile.findMany({
          where: {
            posProductId: { in: stockablePosProducts.map((p) => p.id) },
          },
          select: { posProductId: true },
        });
        const existingPosProductIds = new Set<string>(
          existingProfileRows.map((row) => row.posProductId),
        );
        const missingProducts = stockablePosProducts.filter(
          (product) => !existingPosProductIds.has(product.id),
        );
        if (missingProducts.length > 0) {
          await prisma.wmsProductProfile.createMany({
            data: missingProducts.map((product) => ({
              tenantId: tenant.id,
              storeId: product.storeId,
              posProductId: product.id,
              productId: product.productId,
              variationId: product.variationId!,
              posWarehouseRef: product.warehouseId,
              status: WmsProductProfileStatus.DEFAULT,
              isSerialized: true,
            })),
            skipDuplicates: true,
          });
        }
      }

      // 2. Load non-archived stockable profiles for Famco
      const rawProfiles = await prisma.wmsProductProfile.findMany({
        where: {
          tenantId: tenant.id,
          status: { not: WmsProductProfileStatus.ARCHIVED },
        },
        select: {
          id: true,
          storeId: true,
          productId: true,
          variationId: true,
          posWarehouseRef: true,
          stockPoolGroupId: true,
          posProduct: {
            select: {
              productId: true,
              variationId: true,
            },
          },
        },
      });
      const profiles = rawProfiles.filter(
        (p) =>
          Boolean(p.variationId)
          && p.variationId !== p.productId
          && Boolean(p.posProduct.variationId)
          && p.posProduct.variationId !== p.posProduct.productId,
      );

      const profileById = new Map<string, (typeof profiles)[number]>();
      const profileByStoreVariation = new Map<string, (typeof profiles)[number]>();
      for (const profile of profiles) {
        profileById.set(profile.id, profile);
        profileByStoreVariation.set(`${profile.storeId}::${profile.variationId}`, profile);
      }

      const existingPooledProfileCount = profiles.filter((p) => Boolean(p.stockPoolGroupId)).length;
      let equivalenceRowCount = 0;
      let storeTransferItemCount = 0;
      let backfilledPoolGroupCount = 0;

      // 3. Auto-backfill Famco's verified Change Variant history on initial rollout
      if (existingPooledProfileCount === 0 && profiles.length > 0) {
        const [equivalences, transferItems] = await Promise.all([
          prisma.wmsProductProfileEquivalence.findMany({
            where: { tenantId: tenant.id },
            select: {
              sourceProfileId: true,
              targetProfileId: true,
              sourceStoreId: true,
              sourceVariationId: true,
              targetStoreId: true,
              targetVariationId: true,
            },
          }),
          prisma.wmsInventoryStoreTransferItem.findMany({
            where: {
              transfer: {
                tenantId: tenant.id,
              },
            },
            select: {
              fromProductProfileId: true,
              toProductProfileId: true,
              fromStoreId: true,
              fromVariationId: true,
              toStoreId: true,
              toVariationId: true,
            },
          }),
        ]);
        equivalenceRowCount = equivalences.length;
        storeTransferItemCount = transferItems.length;

        const parentById = new Map<string, string>();
        const findRoot = (id: string): string => {
          let current = id;
          while (parentById.has(current) && parentById.get(current) !== current) {
            current = parentById.get(current)!;
          }
          let walk = id;
          while (parentById.has(walk) && parentById.get(walk) !== current) {
            const next = parentById.get(walk)!;
            parentById.set(walk, current);
            walk = next;
          }
          if (!parentById.has(id)) {
            parentById.set(id, id);
          }
          return current;
        };
        const unionProfiles = (leftId: string | undefined, rightId: string | undefined) => {
          if (!leftId || !rightId || leftId === rightId) {
            return;
          }
          if (!profileById.has(leftId) || !profileById.has(rightId)) {
            return;
          }
          const leftRoot = findRoot(leftId);
          const rightRoot = findRoot(rightId);
          if (leftRoot !== rightRoot) {
            parentById.set(rightRoot, leftRoot);
          }
        };

        for (const eq of equivalences) {
          const src =
            profileById.get(eq.sourceProfileId)
            ?? profileByStoreVariation.get(`${eq.sourceStoreId}::${eq.sourceVariationId}`);
          const dst =
            profileById.get(eq.targetProfileId)
            ?? profileByStoreVariation.get(`${eq.targetStoreId}::${eq.targetVariationId}`);
          unionProfiles(src?.id, dst?.id);
        }

        for (const item of transferItems) {
          const src =
            profileById.get(item.fromProductProfileId)
            ?? profileByStoreVariation.get(`${item.fromStoreId}::${item.fromVariationId}`);
          const dst =
            profileById.get(item.toProductProfileId)
            ?? profileByStoreVariation.get(`${item.toStoreId}::${item.toVariationId}`);
          unionProfiles(src?.id, dst?.id);
        }

        const componentsByRoot = new Map<string, string[]>();
        for (const profileId of Array.from(parentById.keys())) {
          const root = findRoot(profileId);
          const list = componentsByRoot.get(root) ?? [];
          list.push(profileId);
          componentsByRoot.set(root, list);
        }

        for (const memberIds of Array.from(componentsByRoot.values())) {
          if (memberIds.length < 2) {
            continue;
          }
          const groupId = randomUUID();
          await prisma.wmsProductProfile.updateMany({
            where: {
              tenantId: tenant.id,
              id: { in: memberIds },
            },
            data: {
              stockPoolGroupId: groupId,
            },
          });
          for (const memberId of memberIds) {
            const p = profileById.get(memberId);
            if (p) {
              p.stockPoolGroupId = groupId;
            }
          }
          backfilledPoolGroupCount += 1;
        }
      }

      // 4. Build active pool index (>= 2 members per group) for live Famco queue refresh
      const rawMembersByGroup = new Map<string, Array<(typeof profiles)[number]>>();
      for (const profile of profiles) {
        if (!profile.stockPoolGroupId) {
          continue;
        }
        const list = rawMembersByGroup.get(profile.stockPoolGroupId) ?? [];
        list.push(profile);
        rawMembersByGroup.set(profile.stockPoolGroupId, list);
      }

      const activeMembersByGroup = new Map<string, Array<(typeof profiles)[number]>>();
      const groupIdByStoreVariation = new Map<string, string>();
      let pooledProfileCount = 0;
      for (const [groupId, groupMembers] of Array.from(rawMembersByGroup.entries())) {
        if (groupMembers.length < 2) {
          continue;
        }
        activeMembersByGroup.set(groupId, groupMembers);
        pooledProfileCount += groupMembers.length;
        for (const member of groupMembers) {
          groupIdByStoreVariation.set(`${member.storeId}::${member.variationId}`, groupId);
        }
      }

      const queueStatsBefore = await prisma.wmsFulfillmentOrder.groupBy({
        by: ['status'],
        where: {
          tenantId: tenant.id,
          assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
          basketId: null,
          status: {
            in: [
              WmsFulfillmentOrderStatus.READY,
              WmsFulfillmentOrderStatus.RESTOCKING,
              WmsFulfillmentOrderStatus.PARTIAL,
              WmsFulfillmentOrderStatus.ISSUE,
            ],
          },
          posOrder: {
            is: {
              status: 1,
              isVoid: false,
            },
          },
        },
        _count: { _all: true },
      });

      // 5. Recompute Famco's open BASKET_DEMAND queue across all Famco stores using shared stock pools
      const [putawayBinUnits, activeDemandBins, rawCandidateOrders] = await Promise.all([
        prisma.wmsInventoryUnit.findMany({
          where: {
            tenantId: tenant.id,
            status: WmsInventoryUnitStatus.PUTAWAY,
            currentLocationId: { not: null },
            currentLocation: { is: { kind: WmsLocationKind.BIN, isActive: true } },
            OR: [{ expirationDate: null }, { expirationDate: { gt: now } }],
            pickReservations: { none: { status: { in: ['RESERVED', 'PICKED'] } } },
            basketUnits: { none: { status: { in: ['PICKED', 'PACKED'] } } },
          },
          select: {
            warehouseId: true,
            storeId: true,
            variationId: true,
            posWarehouseRef: true,
          },
        }),
        prisma.wmsBasketPickDemandBin.findMany({
          where: {
            tenantId: tenant.id,
            basket: {
              status: { in: ['ASSIGNED', 'IN_PICKING', 'FULL_HELD'] },
            },
            demand: {
              fulfillmentOrder: {
                status: {
                  in: [
                    WmsFulfillmentOrderStatus.READY,
                    WmsFulfillmentOrderStatus.PARTIAL,
                    WmsFulfillmentOrderStatus.RESTOCKING,
                    WmsFulfillmentOrderStatus.ISSUE,
                    WmsFulfillmentOrderStatus.IN_PICKING,
                    WmsFulfillmentOrderStatus.READY_FOR_PACK,
                    WmsFulfillmentOrderStatus.PICKED,
                    WmsFulfillmentOrderStatus.PACKING,
                  ],
                },
              },
            },
          },
          select: {
            warehouseId: true,
            variationId: true,
            quantityTarget: true,
            quantityPicked: true,
            demand: {
              select: {
                storeId: true,
              },
            },
          },
        }),
        prisma.wmsFulfillmentOrder.findMany({
          where: {
            tenantId: tenant.id,
            assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
            basketId: null,
            OR: [
              {
                status: {
                  in: [
                    WmsFulfillmentOrderStatus.READY,
                    WmsFulfillmentOrderStatus.RESTOCKING,
                    WmsFulfillmentOrderStatus.PARTIAL,
                  ],
                },
              },
              {
                status: WmsFulfillmentOrderStatus.ISSUE,
                lines: {
                  some: {
                    quantityRequired: { gt: 0 },
                    status: { not: WmsFulfillmentLineStatus.CANCELED },
                  },
                },
              },
            ],
            posOrder: {
              is: {
                status: 1,
                isVoid: false,
              },
            },
          },
          include: {
            posOrder: {
              select: {
                dateLocal: true,
                insertedAt: true,
              },
            },
            lines: true,
          },
        }),
      ]);

      const tenantGoLiveAt = tenant.wmsFulfillmentGoLiveAt ?? null;

      const candidateQueueOrders = rawCandidateOrders
        .filter((order) => {
          if (tenantGoLiveAt && order.posOrder.insertedAt < tenantGoLiveAt) {
            return false;
          }
          return true;
        })
        .sort((left, right) => {
          const leftPriority = left.priorityOverrideAt ? left.priorityOverrideAt.getTime() : null;
          const rightPriority = right.priorityOverrideAt ? right.priorityOverrideAt.getTime() : null;
          if (leftPriority !== null && rightPriority === null) {
            return -1;
          }
          if (leftPriority === null && rightPriority !== null) {
            return 1;
          }
          if (leftPriority !== null && rightPriority !== null && leftPriority !== rightPriority) {
            return leftPriority - rightPriority;
          }
          const dateDiff = left.posOrder.dateLocal.localeCompare(right.posOrder.dateLocal);
          if (dateDiff !== 0) {
            return dateDiff;
          }
          const createdDiff = left.createdAt.getTime() - right.createdAt.getTime();
          if (createdDiff !== 0) {
            return createdDiff;
          }
          return left.id.localeCompare(right.id);
        });

      const buildAllocKey = (warehouseId: string, storeId: string, variationId: string) => {
        const groupId = groupIdByStoreVariation.get(`${storeId}::${variationId}`) ?? null;
        return groupId
          ? `${warehouseId}::pool:${groupId}`
          : `${warehouseId}::${storeId}::${variationId}`;
      };

      const heldByAllocKey = new Map<string, number>();
      for (const bin of activeDemandBins) {
        const held = Math.max((bin.quantityTarget ?? 0) - (bin.quantityPicked ?? 0), 0);
        if (held <= 0) {
          continue;
        }
        const allocKey = buildAllocKey(bin.warehouseId, bin.demand.storeId, bin.variationId);
        heldByAllocKey.set(allocKey, (heldByAllocKey.get(allocKey) ?? 0) + held);
      }

      const virtualUsedByAllocKey = new Map<string, number>();
      const availableFor = (
        warehouseId: string,
        orderStoreId: string,
        variationId: string,
        orderPosWhRef: string | null,
      ) => {
        const groupId = groupIdByStoreVariation.get(`${orderStoreId}::${variationId}`) ?? null;
        const allocKey = buildAllocKey(warehouseId, orderStoreId, variationId);
        let rawCount = 0;
        if (groupId) {
          const members = activeMembersByGroup.get(groupId) ?? [];
          rawCount = putawayBinUnits.filter(
            (u) =>
              u.warehouseId === warehouseId
              && members.some((m) => m.storeId === u.storeId && m.variationId === u.variationId),
          ).length;
        } else {
          rawCount = putawayBinUnits.filter(
            (u) =>
              u.warehouseId === warehouseId
              && u.storeId === orderStoreId
              && u.variationId === variationId
              && (!orderPosWhRef || !u.posWarehouseRef || u.posWarehouseRef === orderPosWhRef),
          ).length;
        }
        const held = heldByAllocKey.get(allocKey) ?? 0;
        const used = virtualUsedByAllocKey.get(allocKey) ?? 0;
        return Math.max(rawCount - held - used, 0);
      };

      const warehouseIds = Array.from(new Set(putawayBinUnits.map((u) => u.warehouseId)));
      const incompleteOrders: typeof candidateQueueOrders = [];

      // Auto-cancel any orphan zero-required lines on candidate queue orders
      for (const order of candidateQueueOrders) {
        for (const line of order.lines) {
          if (
            line.status !== WmsFulfillmentLineStatus.CANCELED
            && line.quantityRequired <= 0
            && (line.quantityPicked ?? 0) <= 0
          ) {
            await prisma.wmsFulfillmentLine.update({
              where: { id: line.id },
              data: {
                quantityAllocated: 0,
                quantityPicked: 0,
                status: WmsFulfillmentLineStatus.CANCELED,
                issueReason: null,
              },
            });
            line.status = WmsFulfillmentLineStatus.CANCELED;
          }
        }
      }

      // Pass 1: Complete orders first across all Famco stores
      for (const order of candidateQueueOrders) {
        const activeLines = order.lines.filter(
          (l) => l.status !== WmsFulfillmentLineStatus.CANCELED && l.quantityRequired > 0,
        );
        if (activeLines.length === 0) {
          continue;
        }

        let fullWarehouseId: string | null = null;
        for (const whId of warehouseIds) {
          const canFulfillAll = activeLines.every(
            (l) =>
              availableFor(whId, order.storeId, l.variationId, order.posWarehouseRef)
              >= l.quantityRequired,
          );
          if (canFulfillAll) {
            fullWarehouseId = whId;
            break;
          }
        }

        if (!fullWarehouseId) {
          incompleteOrders.push(order);
          continue;
        }

        let orderTotal = 0;
        for (const line of activeLines) {
          const allocKey = buildAllocKey(fullWarehouseId, order.storeId, line.variationId);
          virtualUsedByAllocKey.set(
            allocKey,
            (virtualUsedByAllocKey.get(allocKey) ?? 0) + line.quantityRequired,
          );
          orderTotal += line.quantityRequired;
          await prisma.wmsFulfillmentLine.update({
            where: { id: line.id },
            data: {
              quantityAllocated: line.quantityRequired,
              quantityPicked: 0,
              status: WmsFulfillmentLineStatus.READY,
              issueReason: null,
            },
          });
        }

        await prisma.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            warehouseId: null,
            totalQuantity: orderTotal,
            allocatedQuantity: orderTotal,
            pickedQuantity: 0,
            status: WmsFulfillmentOrderStatus.READY,
            issueReason: null,
            lastSyncedAt: now,
          },
        });
      }

      // Pass 2: Partial / Restocking orders
      for (const order of incompleteOrders) {
        const activeLines = order.lines.filter(
          (l) => l.status !== WmsFulfillmentLineStatus.CANCELED && l.quantityRequired > 0,
        );
        if (activeLines.length === 0) {
          continue;
        }

        let bestWarehouseId: string | null = warehouseIds[0] ?? null;
        let bestAllocTotal = -1;
        for (const whId of warehouseIds) {
          const allocSum = activeLines.reduce(
            (sum, l) =>
              sum
              + Math.min(
                availableFor(whId, order.storeId, l.variationId, order.posWarehouseRef),
                l.quantityRequired,
              ),
            0,
          );
          if (allocSum > bestAllocTotal) {
            bestAllocTotal = allocSum;
            bestWarehouseId = whId;
          }
        }

        let orderTotal = 0;
        let orderAlloc = 0;
        for (const line of activeLines) {
          const avail = bestWarehouseId
            ? availableFor(bestWarehouseId, order.storeId, line.variationId, order.posWarehouseRef)
            : 0;
          const alloc = Math.min(avail, line.quantityRequired);
          if (bestWarehouseId && alloc > 0) {
            const allocKey = buildAllocKey(bestWarehouseId, order.storeId, line.variationId);
            virtualUsedByAllocKey.set(allocKey, (virtualUsedByAllocKey.get(allocKey) ?? 0) + alloc);
          }
          orderTotal += line.quantityRequired;
          orderAlloc += alloc;
          const missing = Math.max(line.quantityRequired - avail, 0);
          const lineStatus =
            alloc >= line.quantityRequired
              ? WmsFulfillmentLineStatus.READY
              : alloc > 0
                ? WmsFulfillmentLineStatus.PARTIAL
                : WmsFulfillmentLineStatus.RESTOCKING;
          await prisma.wmsFulfillmentLine.update({
            where: { id: line.id },
            data: {
              quantityAllocated: alloc,
              quantityPicked: 0,
              status: lineStatus,
              issueReason:
                lineStatus === WmsFulfillmentLineStatus.READY
                  ? 'Stock is available for this item, but the complete order cannot be fulfilled yet.'
                  : avail <= 0
                    ? `Needs ${line.quantityRequired} unit${line.quantityRequired === 1 ? '' : 's'} in putaway bin inventory.`
                    : `${avail} of ${line.quantityRequired} required unit${line.quantityRequired === 1 ? '' : 's'} available in the selected warehouse; needs ${missing} more.`,
            },
          });
        }

        await prisma.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            warehouseId: null,
            totalQuantity: orderTotal,
            allocatedQuantity: orderAlloc,
            pickedQuantity: 0,
            status:
              orderAlloc > 0
                ? WmsFulfillmentOrderStatus.PARTIAL
                : WmsFulfillmentOrderStatus.RESTOCKING,
            issueReason: null,
            lastSyncedAt: now,
          },
        });
      }

      const queueStatsAfter = await prisma.wmsFulfillmentOrder.groupBy({
        by: ['status'],
        where: {
          tenantId: tenant.id,
          assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
          basketId: null,
          status: {
            in: [
              WmsFulfillmentOrderStatus.READY,
              WmsFulfillmentOrderStatus.RESTOCKING,
              WmsFulfillmentOrderStatus.PARTIAL,
              WmsFulfillmentOrderStatus.ISSUE,
            ],
          },
          posOrder: {
            is: {
              status: 1,
              isVoid: false,
            },
          },
        },
        _count: { _all: true },
      });

      console.log(
        '[FAMCO_POOL_RECONCILE]',
        JSON.stringify({
          tenantId: tenant.id,
          tenantName: tenant.name,
          storeCount: tenant.posStores.length,
          existingPooledProfileCount,
          equivalenceRowCount,
          storeTransferItemCount,
          backfilledPoolGroupCount,
          activePoolGroupCount: activeMembersByGroup.size,
          pooledProfileCount,
          putawayBinUnitCount: putawayBinUnits.length,
          evaluatedQueueOrderCount: candidateQueueOrders.length,
          queueStatsBefore,
          queueStatsAfter,
        }),
      );
    }
  } catch (err: any) {
    console.error(
      'Warning during Famco shared stock pool reconciliation:',
      err?.message || err,
    );
  }
}

async function logOpenWmsIssueOrdersDiagnostic(tag: string) {
  try {
    const issueOrders = await prisma.wmsFulfillmentOrder.findMany({
      where: {
        status: WmsFulfillmentOrderStatus.ISSUE,
      },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            wmsFulfillmentGoLiveAt: true,
          },
        },
        store: {
          select: {
            id: true,
            name: true,
            shopName: true,
            status: true,
            enabled: true,
          },
        },
        posOrder: {
          select: {
            status: true,
            isVoid: true,
            dateLocal: true,
            insertedAt: true,
            orderSnapshot: true,
            itemData: true,
          },
        },
        lines: {
          select: {
            id: true,
            variationId: true,
            productName: true,
            quantityRequired: true,
            quantityAllocated: true,
            quantityPicked: true,
            status: true,
            issueReason: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });

    const visiblePickQueueIssueOrders = issueOrders.filter((order) => {
      const goLiveAt = order.tenant?.wmsFulfillmentGoLiveAt ?? null;
      if (goLiveAt && order.posOrder.insertedAt < goLiveAt) {
        return false;
      }
      return order.posOrder.status === 1 && !order.posOrder.isVoid;
    });

    console.log(
      tag,
      JSON.stringify({
        totalIssueRowCount: issueOrders.length,
        visibleConfirmedIssueCount: visiblePickQueueIssueOrders.length,
        orders: visiblePickQueueIssueOrders.map((order) => {
          const snapshot =
            order.posOrder.orderSnapshot
            && typeof order.posOrder.orderSnapshot === 'object'
            && !Array.isArray(order.posOrder.orderSnapshot)
              ? (order.posOrder.orderSnapshot as Record<string, any>)
              : null;
          const rawItems = Array.isArray(snapshot?.items) ? snapshot!.items : null;
          return {
            id: order.id,
            posOrderId: order.posOrderId,
            tenantName: order.tenant?.name ?? null,
            storeName: order.store?.shopName || order.store?.name || null,
            storeEnabled: order.store?.enabled ?? null,
            assignmentMode: order.assignmentMode,
            basketId: order.basketId,
            totalQuantity: order.totalQuantity,
            allocatedQuantity: order.allocatedQuantity,
            pickedQuantity: order.pickedQuantity,
            issueReason: order.issueReason,
            changeState: order.changeState,
            dateLocal: order.posOrder.dateLocal,
            snapshotItemsCount: rawItems ? rawItems.length : null,
            lines: order.lines.map((l) => ({
              variationId: l.variationId,
              productName: l.productName,
              qtyReq: l.quantityRequired,
              qtyAlloc: l.quantityAllocated,
              qtyPicked: l.quantityPicked,
              status: l.status,
              issueReason: l.issueReason,
            })),
          };
        }),
      }),
    );
  } catch (err: any) {
    console.error(`Warning during ${tag}:`, err?.message || err);
  }
}

function deriveSeedEmptyIssueReason(
  orderSnapshot: Prisma.JsonValue | null,
  fallbackItemData: Prisma.JsonValue | null,
  hasBypassAdjustment: boolean,
): string {
  if (hasBypassAdjustment) {
    return 'All pickable items on this order were bypassed to zero quantity — no units remain to pick.';
  }
  const snapshot =
    orderSnapshot && typeof orderSnapshot === 'object' && !Array.isArray(orderSnapshot)
      ? (orderSnapshot as Record<string, any>)
      : null;
  const hasSnapshotItemsArray = Array.isArray(snapshot?.items);
  const snapshotItems = hasSnapshotItemsArray ? (snapshot!.items as any[]) : [];
  const fallbackItems = Array.isArray(fallbackItemData) ? (fallbackItemData as any[]) : [];

  if (!hasSnapshotItemsArray && fallbackItems.length === 0) {
    return 'Order line items have not arrived from Pancake POS yet — syncing from POS';
  }
  if (snapshotItems.length === 0 && fallbackItems.length === 0) {
    return 'Order has no line items in Pancake POS — add a product variation in POS to pick';
  }

  const effectiveItems = snapshotItems.length > 0 ? snapshotItems : fallbackItems;
  const objectItems = effectiveItems.filter(
    (item): item is Record<string, any> => Boolean(item && typeof item === 'object' && !Array.isArray(item)),
  );
  if (
    objectItems.length > 0
    && objectItems.every((item) => {
      const qty = Math.max(Number(item.quantity ?? 0), 0);
      const returned =
        Math.max(Number(item.returned_count ?? 0), 0)
        + Math.max(Number(item.return_quantity ?? 0), 0)
        + Math.max(Number(item.returning_quantity ?? 0), 0);
      return qty > 0 && returned >= qty;
    })
  ) {
    return 'All order line items are marked returned in Pancake POS';
  }

  const unlinkedNames = objectItems
    .map((item) => {
      const varInfo =
        item.variation_info && typeof item.variation_info === 'object'
          ? (item.variation_info as Record<string, any>)
          : null;
      const rawName =
        varInfo?.name ?? item.variationName ?? item.product_name ?? item.note_product ?? item.name;
      return typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
    })
    .filter((name): name is string => Boolean(name));

  if (unlinkedNames.length > 0) {
    return `Order item in Pancake POS ("${unlinkedNames.slice(0, 2).join(', ')}") is not linked to a catalog variation — link a product variation in POS to pick`;
  }

  return 'Order item in Pancake POS is not linked to a catalog variation — link a product variation in POS to pick';
}

async function reconcileAllWmsIssueOrdersOnStartup() {
  try {
    const now = new Date();
    const issueOrders = await prisma.wmsFulfillmentOrder.findMany({
      where: {
        status: WmsFulfillmentOrderStatus.ISSUE,
        basketId: null,
        pickedQuantity: 0,
      },
      include: {
        tenant: {
          select: {
            id: true,
            wmsFulfillmentGoLiveAt: true,
          },
        },
        posOrder: {
          select: {
            status: true,
            isVoid: true,
            insertedAt: true,
            orderSnapshot: true,
            itemData: true,
          },
        },
        fulfillmentAdjustments: {
          where: { status: 'ACTIVE' },
          select: { id: true },
        },
        lines: true,
      },
    });

    let canceledCount = 0;
    let packedShippedCount = 0;
    let recoveredWithLinesCount = 0;
    let backfilledReasonCount = 0;

    for (const order of issueOrders) {
      const goLiveAt = order.tenant?.wmsFulfillmentGoLiveAt ?? null;
      if (goLiveAt && order.posOrder.insertedAt < goLiveAt) {
        await prisma.wmsFulfillmentLine.updateMany({
          where: { fulfillmentOrderId: order.id },
          data: {
            quantityAllocated: 0,
            quantityPicked: 0,
            status: WmsFulfillmentLineStatus.CANCELED,
            issueReason: 'Excluded before client WMS fulfillment go-live.',
          },
        });
        await prisma.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            status: WmsFulfillmentOrderStatus.CANCELED,
            issueReason: 'Excluded before client WMS fulfillment go-live.',
            allocatedQuantity: 0,
            pickedQuantity: 0,
            completedAt: now,
            lastSyncedAt: now,
          },
        });
        canceledCount += 1;
        continue;
      }

      if (order.posOrder.isVoid || order.posOrder.status === 6 || order.posOrder.status === 7) {
        const cancelReason = order.posOrder.isVoid
          ? 'Voided in Pancake POS.'
          : 'Canceled in Pancake POS.';
        await prisma.wmsFulfillmentLine.updateMany({
          where: { fulfillmentOrderId: order.id },
          data: {
            quantityAllocated: 0,
            quantityPicked: 0,
            status: WmsFulfillmentLineStatus.CANCELED,
            issueReason: cancelReason,
          },
        });
        await prisma.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            status: WmsFulfillmentOrderStatus.CANCELED,
            issueReason: cancelReason,
            allocatedQuantity: 0,
            pickedQuantity: 0,
            completedAt: now,
            lastSyncedAt: now,
          },
        });
        canceledCount += 1;
        continue;
      }

      if ([2, 3, 4, 5].includes(order.posOrder.status)) {
        await prisma.wmsFulfillmentLine.updateMany({
          where: {
            fulfillmentOrderId: order.id,
            status: { not: WmsFulfillmentLineStatus.CANCELED },
          },
          data: {
            status: WmsFulfillmentLineStatus.PICKED,
            issueReason: null,
          },
        });
        await prisma.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            status: WmsFulfillmentOrderStatus.PACKED,
            issueReason: null,
            completedAt: order.completedAt ?? now,
            lastSyncedAt: now,
          },
        });
        packedShippedCount += 1;
        continue;
      }

      // Clean up any orphan zero-required lines first
      for (const line of order.lines) {
        if (
          line.status !== WmsFulfillmentLineStatus.CANCELED
          && line.quantityRequired <= 0
          && (line.quantityPicked ?? 0) <= 0
        ) {
          await prisma.wmsFulfillmentLine.update({
            where: { id: line.id },
            data: {
              quantityAllocated: 0,
              quantityPicked: 0,
              status: WmsFulfillmentLineStatus.CANCELED,
              issueReason: null,
            },
          });
          line.status = WmsFulfillmentLineStatus.CANCELED;
        }
      }

      const activeLines = order.lines.filter(
        (line) => line.status !== WmsFulfillmentLineStatus.CANCELED && line.quantityRequired > 0,
      );

      if (order.posOrder.status === 1 && activeLines.length > 0) {
        const [putawayUnits, heldBins] = await Promise.all([
          prisma.wmsInventoryUnit.findMany({
            where: {
              tenantId: order.tenantId,
              storeId: order.storeId,
              variationId: { in: activeLines.map((line) => line.variationId) },
              status: WmsInventoryUnitStatus.PUTAWAY,
              currentLocationId: { not: null },
              currentLocation: { is: { kind: WmsLocationKind.BIN, isActive: true } },
              OR: [{ expirationDate: null }, { expirationDate: { gt: now } }],
              pickReservations: { none: { status: { in: ['RESERVED', 'PICKED'] } } },
              basketUnits: { none: { status: { in: ['PICKED', 'PACKED'] } } },
            },
            select: {
              warehouseId: true,
              variationId: true,
            },
          }),
          prisma.wmsBasketPickDemandBin.findMany({
            where: {
              tenantId: order.tenantId,
              variationId: { in: activeLines.map((line) => line.variationId) },
              basket: {
                status: { in: ['ASSIGNED', 'IN_PICKING', 'FULL_HELD'] },
              },
              demand: {
                storeId: order.storeId,
              },
            },
            select: {
              warehouseId: true,
              variationId: true,
              quantityTarget: true,
              quantityPicked: true,
            },
          }),
        ]);
        const heldByWarehouseVariation = new Map<string, number>();
        for (const hold of heldBins) {
          const remainingHold = Math.max((hold.quantityTarget ?? 0) - (hold.quantityPicked ?? 0), 0);
          if (remainingHold <= 0) continue;
          const key = `${hold.warehouseId}::${hold.variationId}`;
          heldByWarehouseVariation.set(key, (heldByWarehouseVariation.get(key) ?? 0) + remainingHold);
        }
        const netAvailableInWarehouse = (whId: string, variationId: string) => {
          const raw = putawayUnits.filter(
            (u) => u.warehouseId === whId && u.variationId === variationId,
          ).length;
          const held = heldByWarehouseVariation.get(`${whId}::${variationId}`) ?? 0;
          return Math.max(raw - held, 0);
        };

        const warehouseIds = Array.from(new Set(putawayUnits.map((unit) => unit.warehouseId)));
        let chosenWarehouseId: string | null = warehouseIds[0] ?? null;
        let bestAlloc = -1;
        for (const whId of warehouseIds) {
          let sumAlloc = 0;
          let full = true;
          for (const line of activeLines) {
            const avail = netAvailableInWarehouse(whId, line.variationId);
            const alloc = Math.min(avail, line.quantityRequired);
            sumAlloc += alloc;
            if (alloc < line.quantityRequired) {
              full = false;
            }
          }
          const score = (full ? 1_000_000 : 0) + sumAlloc;
          if (score > bestAlloc) {
            bestAlloc = score;
            chosenWarehouseId = whId;
          }
        }

        let orderTotal = 0;
        let orderAlloc = 0;
        let allReady = true;
        for (const line of activeLines) {
          const avail = chosenWarehouseId
            ? netAvailableInWarehouse(chosenWarehouseId, line.variationId)
            : 0;
          const alloc = Math.min(avail, line.quantityRequired);
          orderTotal += line.quantityRequired;
          orderAlloc += alloc;
          if (alloc < line.quantityRequired) {
            allReady = false;
          }
        }

        for (const line of activeLines) {
          const avail = chosenWarehouseId
            ? netAvailableInWarehouse(chosenWarehouseId, line.variationId)
            : 0;
          const alloc = allReady ? line.quantityRequired : Math.min(avail, line.quantityRequired);
          const lineStatus = alloc >= line.quantityRequired
            ? WmsFulfillmentLineStatus.READY
            : alloc > 0
              ? WmsFulfillmentLineStatus.PARTIAL
              : WmsFulfillmentLineStatus.RESTOCKING;
          const missing = Math.max(line.quantityRequired - avail, 0);
          await prisma.wmsFulfillmentLine.update({
            where: { id: line.id },
            data: {
              quantityAllocated: alloc,
              quantityPicked: 0,
              status: lineStatus,
              issueReason: allReady
                ? null
                : lineStatus === WmsFulfillmentLineStatus.READY
                  ? 'Stock is available for this item, but the complete order cannot be fulfilled yet.'
                  : avail <= 0
                    ? `Needs ${line.quantityRequired} unit${line.quantityRequired === 1 ? '' : 's'} in putaway bin inventory.`
                    : `${avail} of ${line.quantityRequired} required unit${line.quantityRequired === 1 ? '' : 's'} available in the selected warehouse; needs ${missing} more.`,
            },
          });
        }

        await prisma.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            warehouseId: null,
            totalQuantity: orderTotal,
            allocatedQuantity: allReady ? orderTotal : orderAlloc,
            pickedQuantity: 0,
            status: allReady
              ? WmsFulfillmentOrderStatus.READY
              : orderAlloc > 0
                ? WmsFulfillmentOrderStatus.PARTIAL
                : WmsFulfillmentOrderStatus.RESTOCKING,
            issueReason: null,
            lastSyncedAt: now,
          },
        });
        recoveredWithLinesCount += 1;
        continue;
      }

      if (activeLines.length === 0) {
        const concreteReason = deriveSeedEmptyIssueReason(
          order.posOrder.orderSnapshot,
          order.posOrder.itemData,
          order.fulfillmentAdjustments.length > 0,
        );
        if (!order.issueReason || order.issueReason === 'Order has no pickable variation items') {
          await prisma.wmsFulfillmentOrder.update({
            where: { id: order.id },
            data: {
              totalQuantity: 0,
              allocatedQuantity: 0,
              issueReason: concreteReason,
              lastSyncedAt: now,
            },
          });
          backfilledReasonCount += 1;
        }
      } else if (!order.issueReason) {
        await prisma.wmsFulfillmentOrder.update({
          where: { id: order.id },
          data: {
            issueReason: `Order is in Pancake POS status ${order.posOrder.status} (not Confirmed) — resync queue to update WMS status.`,
            lastSyncedAt: now,
          },
        });
        backfilledReasonCount += 1;
      }
    }

    console.log(
      '[WMS_ISSUE_STARTUP_RECONCILE]',
      JSON.stringify({
        evaluatedCount: issueOrders.length,
        canceledCount,
        packedShippedCount,
        recoveredWithLinesCount,
        backfilledReasonCount,
      }),
    );
  } catch (err: any) {
    console.error(
      'Warning during WMS ISSUE startup reconciliation:',
      err?.message || err,
    );
  }
}

async function main() {
  console.log('Starting database seed...');
  await ensureSuperAdmin();
  await normalizeUserEmails();
  await promoteDesignatedSuperAdmins();
  await seedPermissions();
  await seedRoles();
  await ensureDefaultTeamsAndBackfill();
  await syncToniosPosConnectionAndOrders();
  await reconcileToniosWmsFulfillmentQueue();
  await backfillAdSpendStoreAndTeamAttribution();
  await backfill2026OrderCogsAndReports();
  await syncToniosPosConnectionAndOrders();
  await reconcileToniosWmsFulfillmentQueue();
  await logOpenWmsIssueOrdersDiagnostic('[WMS_ISSUE_DIAG_BEFORE]');
  await reconcileFamcoSharedStockPoolsAndQueue();
  await reconcileAllWmsIssueOrdersOnStartup();
  await logOpenWmsIssueOrdersDiagnostic('[WMS_ISSUE_DIAG_AFTER]');
  await diagnoseErpFreshness();
  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('Error during seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

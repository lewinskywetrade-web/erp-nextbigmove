import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient, RbacWorkspace, RoleScope } from '@prisma/client';
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
    //    set to its earliest positive COGS so all Jan-Oct 2026 dates before min(startDate) resolve cleanly.
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
          AND existing.cogs > 0
      )
    `);

    console.log('✓ Normalized pos_product_cogs:', JSON.stringify({
      deletedZeroRows,
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

    const pendingOrderBackfillCheck = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(`
      SELECT COUNT(*)::int AS cnt
      FROM pos_orders
      WHERE cogs <= 0 OR "totalQuantity" <= 0
    `);
    const pendingZeroOrders = pendingOrderBackfillCheck[0]?.cnt ?? 0;
    const hasChangesRequiringBackfill =
      pendingZeroOrders > 0 ||
      consolidatedDuplicateStoreCogs > 0 ||
      disabledDuplicateStores > 0 ||
      alignedConflictStoreOrders > 0 ||
      deletedZeroRows > 0 ||
      insertedBaselineFromDated > 0 ||
      propagatedCatalogBaselines > 0;

    // 6. Backfill all 2026 orders (dateLocal >= '2026-01-01', non-void, status <> 7)
    //    using materialized CTE lookup tables and hash joins per month so execution is connection-pool safe.
    const months = hasChangesRequiringBackfill
      ? ['2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01']
      : [];
    let updatedOrders = 0;
    const updatedMonths = new Set<string>();
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
            AND (o.cogs <= 0 OR o."totalQuantity" <= 0 OR o."shopId" IN ('1290117012', '1021344092', '1943124266'))
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
            GREATEST(co."totalQuantity", 1)::int AS calc_qty,
            ROUND((GREATEST(co."totalQuantity", 1) * COALESCE(tmsc.cogs, stc.cogs, tmc.cogs, tnc.cogs, 140.00))::numeric, 2) AS calc_cogs
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
          "totalQuantity" = CASE WHEN ro.calc_qty > 0 THEN ro.calc_qty ELSE o."totalQuantity" END
        FROM resolved_orders ro
        WHERE o.id = ro.order_id
          AND (o.cogs <> ro.calc_cogs OR (ro.calc_qty > 0 AND o."totalQuantity" <> ro.calc_qty))
      `);
      updatedOrders += monthUpdated;
      if (monthUpdated > 0) updatedMonths.add(month);
      console.log(`✓ Backfilled ${month}: ${monthUpdated} orders updated`);
    }

    // 6b. Catch-all pass for ANY remaining order in pos_orders (e.g. 2025 or any date/status) with cogs <= 0 or totalQuantity <= 0
    const updatedRemainingZeroOrders = !hasChangesRequiringBackfill ? 0 : await prisma.$executeRawUnsafe(`
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
        WHERE o.cogs <= 0 OR o."totalQuantity" <= 0
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
          GREATEST(co."totalQuantity", 1)::int AS calc_qty,
          ROUND((GREATEST(co."totalQuantity", 1) * COALESCE(tmsc.cogs, stc.cogs, tmc.cogs, tnc.cogs, 140.00))::numeric, 2) AS calc_cogs
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
        "totalQuantity" = CASE WHEN ro.calc_qty > 0 THEN ro.calc_qty ELSE GREATEST(o."totalQuantity", 1) END
      FROM resolved_orders ro
      WHERE o.id = ro.order_id
        AND (o.cogs <> ro.calc_cogs OR o."totalQuantity" <= 0)
    `);
    console.log(`✓ Updated ${updatedOrders} 2026 POS orders and ${updatedRemainingZeroOrders} catch-all remaining zero-COGS POS orders`);

    // 7. Recompute POS COGS columns in reconcile_marketing, reconcile_sales, and reconcile_sales_attribution
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

    let updatedReconcileMarketing = 0;
    let updatedReconcileSales = 0;
    let updatedReconcileAttribution = 0;
    const shouldReconcileRollups =
      updatedOrders > 0 ||
      updatedRemainingZeroOrders > 0 ||
      alignedConflictStoreOrders > 0 ||
      consolidatedDuplicateStoreCogs > 0;
    const allMonthRanges: Array<[string, string]> = [
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
      consolidatedDuplicateStoreCogs > 0;
    const monthRanges: Array<[string, string]> = fullRollupNeeded
      ? allMonthRanges
      : allMonthRanges.filter(([mStart]) => updatedMonths.has(mStart.slice(0, 7)));

    for (const [mStart, mEnd] of monthRanges) {
      const rmCount = await prisma.$executeRawUnsafe(`
        WITH rm_orders AS (
          SELECT DISTINCT
            rm.id AS rm_id,
            rm."tenantId",
            (m->>'shopId') AS "shopId",
            (m->>'posOrderId') AS "posOrderId"
          FROM reconcile_marketing rm
          CROSS JOIN LATERAL jsonb_array_elements(rm."matchedOrders") AS m
          WHERE rm.date >= DATE '${mStart}'
            AND rm.date < DATE '${mEnd}'
            AND jsonb_typeof(rm."matchedOrders") = 'array'
            AND jsonb_array_length(rm."matchedOrders") > 0
        ),
        rm_cogs AS (
          SELECT
            rmo.rm_id,
            ROUND(COALESCE(SUM(o.cogs), 0)::numeric, 2) AS "cogsPos",
            ROUND(COALESCE(SUM(CASE WHEN o."isRepurchase" = true THEN o.cogs ELSE 0 END), 0)::numeric, 2) AS "repurchaseCogsPos",
            ROUND(COALESCE(SUM(CASE WHEN o.status = 6 THEN o.cogs ELSE 0 END), 0)::numeric, 2) AS "cogsCanceledPos",
            ROUND(COALESCE(SUM(CASE WHEN o.status = 6 AND o."isRepurchase" = true THEN o.cogs ELSE 0 END), 0)::numeric, 2) AS "repurchaseCogsCanceledPos",
            ROUND(COALESCE(SUM(CASE WHEN o.status = 11 THEN o.cogs ELSE 0 END), 0)::numeric, 2) AS "cogsRestockingPos",
            ROUND(COALESCE(SUM(CASE WHEN o.status = 11 AND o."isRepurchase" = true THEN o.cogs ELSE 0 END), 0)::numeric, 2) AS "repurchaseCogsRestockingPos",
            ROUND(COALESCE(SUM(CASE WHEN o.status IN (4, 5) THEN o.cogs ELSE 0 END), 0)::numeric, 2) AS "cogsRtsPos",
            ROUND(COALESCE(SUM(CASE WHEN o.status IN (4, 5) AND o."isRepurchase" = true THEN o.cogs ELSE 0 END), 0)::numeric, 2) AS "repurchaseCogsRtsPos",
            ROUND(COALESCE(SUM(CASE WHEN o.status = 3 THEN o.cogs ELSE 0 END), 0)::numeric, 2) AS "cogsDeliveredPos",
            ROUND(COALESCE(SUM(CASE WHEN o.status = 3 AND o."isRepurchase" = true THEN o.cogs ELSE 0 END), 0)::numeric, 2) AS "repurchaseCogsDeliveredPos"
          FROM rm_orders rmo
          LEFT JOIN pos_orders o
            ON o."tenantId" = rmo."tenantId"
           AND o."shopId" = rmo."shopId"
           AND o."posOrderId" = rmo."posOrderId"
           AND o."isVoid" = false
           AND (o.status IS NULL OR o.status <> 7)
          GROUP BY rmo.rm_id
        )
        UPDATE reconcile_marketing rm
        SET
          "cogsPos" = rc."cogsPos",
          "repurchaseCogsPos" = rc."repurchaseCogsPos",
          "cogsCanceledPos" = rc."cogsCanceledPos",
          "repurchaseCogsCanceledPos" = rc."repurchaseCogsCanceledPos",
          "cogsRestockingPos" = rc."cogsRestockingPos",
          "repurchaseCogsRestockingPos" = rc."repurchaseCogsRestockingPos",
          "cogsRtsPos" = rc."cogsRtsPos",
          "repurchaseCogsRtsPos" = rc."repurchaseCogsRtsPos",
          "cogsDeliveredPos" = rc."cogsDeliveredPos",
          "repurchaseCogsDeliveredPos" = rc."repurchaseCogsDeliveredPos",
          "updatedAt" = NOW()
        FROM rm_cogs rc
        WHERE rm.id = rc.rm_id
          AND (
            rm."cogsPos" <> rc."cogsPos"
            OR rm."repurchaseCogsPos" <> rc."repurchaseCogsPos"
            OR rm."cogsCanceledPos" <> rc."cogsCanceledPos"
            OR rm."repurchaseCogsCanceledPos" <> rc."repurchaseCogsCanceledPos"
            OR rm."cogsRestockingPos" <> rc."cogsRestockingPos"
            OR rm."repurchaseCogsRestockingPos" <> rc."repurchaseCogsRestockingPos"
            OR rm."cogsRtsPos" <> rc."cogsRtsPos"
            OR rm."repurchaseCogsRtsPos" <> rc."repurchaseCogsRtsPos"
            OR rm."cogsDeliveredPos" <> rc."cogsDeliveredPos"
            OR rm."repurchaseCogsDeliveredPos" <> rc."repurchaseCogsDeliveredPos"
          )
      `);

      const rsCount = await prisma.$executeRawUnsafe(`
        WITH rs_cogs AS (
          SELECT
            rm."tenantId",
            rm.date,
            CASE
              WHEN rm."campaignId" IS NOT NULL AND BTRIM(rm."campaignId") <> ''
              THEN rm."campaignId"
              ELSE COALESCE(NULLIF(rm."adId", ''), NULLIF(rm."campaignId", ''), '__unassigned__')
            END AS "campaignId",
            ROUND(COALESCE(SUM(rm."cogsPos"), 0)::numeric, 2) AS "cogsPos",
            ROUND(COALESCE(SUM(rm."repurchaseCogsPos"), 0)::numeric, 2) AS "repurchaseCogsPos",
            ROUND(COALESCE(SUM(rm."cogsCanceledPos"), 0)::numeric, 2) AS "cogsCanceledPos",
            ROUND(COALESCE(SUM(rm."repurchaseCogsCanceledPos"), 0)::numeric, 2) AS "repurchaseCogsCanceledPos",
            ROUND(COALESCE(SUM(rm."cogsRestockingPos"), 0)::numeric, 2) AS "cogsRestockingPos",
            ROUND(COALESCE(SUM(rm."repurchaseCogsRestockingPos"), 0)::numeric, 2) AS "repurchaseCogsRestockingPos",
            ROUND(COALESCE(SUM(rm."cogsRtsPos"), 0)::numeric, 2) AS "cogsRtsPos",
            ROUND(COALESCE(SUM(rm."repurchaseCogsRtsPos"), 0)::numeric, 2) AS "repurchaseCogsRtsPos",
            ROUND(COALESCE(SUM(rm."cogsDeliveredPos"), 0)::numeric, 2) AS "cogsDeliveredPos",
            ROUND(COALESCE(SUM(rm."repurchaseCogsDeliveredPos"), 0)::numeric, 2) AS "repurchaseCogsDeliveredPos"
          FROM reconcile_marketing rm
          WHERE rm.date >= DATE '${mStart}'
            AND rm.date < DATE '${mEnd}'
          GROUP BY 1, 2, 3
        )
        UPDATE reconcile_sales rs
        SET
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
          "updatedAt" = NOW()
        FROM rs_cogs rsc
        WHERE rs."tenantId" = rsc."tenantId"
          AND rs.date = rsc.date
          AND rs."campaignId" = rsc."campaignId"
          AND (
            rs."cogsPos" <> rsc."cogsPos"
            OR rs."repurchaseCogsPos" <> rsc."repurchaseCogsPos"
            OR rs."cogsCanceledPos" <> rsc."cogsCanceledPos"
            OR rs."repurchaseCogsCanceledPos" <> rsc."repurchaseCogsCanceledPos"
            OR rs."cogsRestockingPos" <> rsc."cogsRestockingPos"
            OR rs."repurchaseCogsRestockingPos" <> rsc."repurchaseCogsRestockingPos"
            OR rs."cogsRtsPos" <> rsc."cogsRtsPos"
            OR rs."repurchaseCogsRtsPos" <> rsc."repurchaseCogsRtsPos"
            OR rs."cogsDeliveredPos" <> rsc."cogsDeliveredPos"
            OR rs."repurchaseCogsDeliveredPos" <> rsc."repurchaseCogsDeliveredPos"
          )
      `);

      const rsaCount = await prisma.$executeRawUnsafe(`
        WITH rsa_cogs AS (
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
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."cogsPos", 0) - COALESCE(rm."repurchaseCogsPos", 0))), 0)::numeric, 2) AS "cogsPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."cogsCanceledPos", 0) - COALESCE(rm."repurchaseCogsCanceledPos", 0))), 0)::numeric, 2) AS "cogsCanceledPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."cogsRestockingPos", 0) - COALESCE(rm."repurchaseCogsRestockingPos", 0))), 0)::numeric, 2) AS "cogsRestockingPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."cogsRtsPos", 0) - COALESCE(rm."repurchaseCogsRtsPos", 0))), 0)::numeric, 2) AS "cogsRtsPos",
            ROUND(COALESCE(SUM(GREATEST(0, COALESCE(rm."cogsDeliveredPos", 0) - COALESCE(rm."repurchaseCogsDeliveredPos", 0))), 0)::numeric, 2) AS "cogsDeliveredPos"
          FROM reconcile_marketing rm
          WHERE rm.date >= DATE '${mStart}'
            AND rm.date < DATE '${mEnd}'
          GROUP BY 1, 2, 3, 4, 5
        )
        UPDATE reconcile_sales_attribution rsa
        SET
          "cogsPos" = rsac."cogsPos",
          "cogsCanceledPos" = rsac."cogsCanceledPos",
          "cogsRestockingPos" = rsac."cogsRestockingPos",
          "cogsRtsPos" = rsac."cogsRtsPos",
          "cogsDeliveredPos" = rsac."cogsDeliveredPos",
          "updatedAt" = NOW()
        FROM rsa_cogs rsac
        WHERE rsa."tenantId" = rsac."tenantId"
          AND rsa.date = rsac.date
          AND rsa."campaignKey" = rsac."campaignKey"
          AND rsa."mappingKey" = rsac."mappingKey"
          AND rsa."teamCodeKey" = rsac."teamCodeKey"
          AND (
            rsa."cogsPos" <> rsac."cogsPos"
            OR rsa."cogsCanceledPos" <> rsac."cogsCanceledPos"
            OR rsa."cogsRestockingPos" <> rsac."cogsRestockingPos"
            OR rsa."cogsRtsPos" <> rsac."cogsRtsPos"
            OR rsa."cogsDeliveredPos" <> rsac."cogsDeliveredPos"
          )
      `);

      updatedReconcileMarketing += rmCount;
      updatedReconcileSales += rsCount;
      updatedReconcileAttribution += rsaCount;
      console.log(`✓ Reconciled rollups for ${mStart.slice(0, 7)}: rm=${rmCount}, rs=${rsCount}, rsa=${rsaCount}`);
    }

    console.log('✓ Reconciled 2026 report rollups:', JSON.stringify({
      updatedReconcileMarketing,
      updatedReconcileSales,
      updatedReconcileAttribution,
    }));

    // 10. Log SmileOrganics and overall 2026 state AFTER backfill
    const smileAfter = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        s.name AS "storeName",
        s."shopId",
        COUNT(o.id)::int AS "octOrders",
        COUNT(o.id) FILTER (WHERE o.cogs = 0)::int AS "octZeroCogsOrders",
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
        COUNT(*) FILTER (WHERE o.cogs <= 0)::int AS "zeroCogs2026Orders"
      FROM pos_orders o
      WHERE o."dateLocal" >= '2026-01-01'
        AND o."isVoid" = false
        AND (o.status IS NULL OR o.status <> 7)
    `);
    const summaryAllTimeAfter = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        COUNT(*)::int AS "totalAllTimeOrders",
        COUNT(*) FILTER (WHERE o.cogs > 0)::int AS "positiveCogsAllTimeOrders",
        COUNT(*) FILTER (WHERE o.cogs <= 0)::int AS "zeroCogsAllTimeOrders",
        (SELECT COUNT(*)::int FROM pos_products p WHERE NOT EXISTS (SELECT 1 FROM pos_product_cogs c WHERE c."productId" = p.id AND c.cogs > 0)) AS "productsWithoutPositiveCogs"
      FROM pos_orders o
    `);
    console.log('SmileOrganics AFTER backfill:', JSON.stringify(smileAfter));
    console.log('Overall 2026 orders AFTER backfill:', JSON.stringify(summary2026After));
    console.log('Overall ALL-TIME orders & catalog AFTER backfill:', JSON.stringify(summaryAllTimeAfter));

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
      const [activeStores, teams, rmRows, maiRows, products, creatives, storeConfigs] = await Promise.all([
        prisma.posStore.findMany({
          where: {
            tenantId: tenant.id,
            status: 'ACTIVE',
            OR: [{ enabled: true }, { enabled: null }],
          },
          select: { id: true, shopId: true, name: true, shopName: true, teamId: true },
        }),
        prisma.team.findMany({
          where: { tenantId: tenant.id, status: 'ACTIVE' },
          select: { id: true, name: true, teamCode: true },
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

      const storeById = new Map(activeStores.map((s) => [s.id.toLowerCase(), s]));
      const storeByShopId = new Map(activeStores.map((s) => [s.shopId, s]));
      const teamCodeById = new Map(teams.map((t) => [t.id.toLowerCase(), t.teamCode || null]));

      // Default product variation per store (for pv:: key construction when needed)
      const defaultVariationByStoreId = new Map<string, string>();
      const variationsByStoreId = new Map<string, Array<{ variationId: string; name: string; customId: string }>>();
      for (const p of products) {
        const sId = p.storeId.toLowerCase();
        const vId = (p.variationId || '').trim();
        if (!vId || !storeById.has(sId)) continue;
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
        if (shopsArr.includes('715088566')) return '23d5232f-dbc0-48cb-9160-d5793c5057aa';
        if (shopsArr.includes('kangen_store')) return '00000000-0000-4000-8000-000000000014';
        if (shopsArr.includes('evah_fragrances_store')) return '00000000-0000-4000-8000-000000000015';

        const text = `${norm(row.campaignName)} | ${norm(row.adName)} | ${norm(row.mapping)}`;
        const accId = row.accountId || (row.adId ? accountIdByAdId.get(row.adId) : undefined) || (row.campaignId ? accountIdByCampaignId.get(row.campaignId) : undefined) || '';

        if (text.includes('ogimi')) return '23d5232f-dbc0-48cb-9160-d5793c5057aa'; // Ogimi Wellness
        if (text.includes('kangen') || accId === '2560293900989953') return '00000000-0000-4000-8000-000000000014'; // Kangen
        if (text.includes('evah') || accId === '1487235986020067') return '00000000-0000-4000-8000-000000000015'; // Evah Fragrances
        if (text.includes('headlightcleaner') || text.includes('headlight cleaner')) return '00000000-0000-4000-8000-000000000016'; // Garahe Hacks
        if (text.includes('andrea secret') || text.includes('scentgems')) return '00000000-0000-4000-8000-000000000017'; // ScentGems
        if (text.includes('petal theory')) return '00000000-0000-4000-8000-000000000018'; // Petal Theory
        if (text.includes('cat yoyo') || text.includes('tails & toys') || text.includes('tails and toys')) return '00000000-0000-4000-8000-000000000019'; // Tails & Toys
        if (text.includes('anik anik engagement')) return '250d2a13-0244-4200-a346-9510c2378171'; // Axle Gear
        if (text.includes('3 kid chart') || text.includes('vallejo')) return '5b86e613-05f3-4d33-b4dd-56916721c216'; // Kiddie Wonders PH
        if (norm(row.campaignName) === 'new sales campaign' && norm(row.adName) === 'new sales campaign') {
          return '98056b3d-fb9d-45e9-ad5f-785c77444034'; // Agriblast PH
        }
        return null;
      };

      // Keyword-based fallback for active stores in Next Big Move
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
          if (t.includes('smile') || t.includes('oral') || t.includes('breath') || t.includes('teeth')) return '2998bcd6-c878-40f6-ad19-1c29fb9f69f6'; // SmileOrganics
          if (t.includes('barebody') || t.includes('bare body')) return '2bb11c9e-d41b-4cd5-8f57-f5b6d8a22458'; // Barebody.ph
          if (t.includes('kiddie') || t.includes('kid') || t.includes('busy book') || t.includes('montessori')) return '5b86e613-05f3-4d33-b4dd-56916721c216'; // Kiddie Wonders PH
          if (t.includes('radiance')) return '11edbb22-f08e-456d-92be-d62f42670d0f'; // Radiance Sphere
          if (t.includes('luntian')) return '972d13d9-7251-4e78-9d23-9e5fb20b7061'; // Luntian
          if (t.includes('luxe')) return '5d4f7b8e-705c-401c-8222-3e271659cf55'; // Luxe Essential
          if (t.includes('tactical')) return 'e31d81c1-72b0-4058-b78c-d54f74263f73'; // Tactical Minds
          if (t.includes('axle') || t.includes('wiper') || t.includes('car')) return '250d2a13-0244-4200-a346-9510c2378171'; // Axle Gear
          if (t.includes('agriblast') || t.includes('fertilizer') || t.includes('plant')) return '98056b3d-fb9d-45e9-ad5f-785c77444034'; // Agriblast PH
          if (t.includes('bahay')) return '0560ff14-563a-4782-a309-838a5743f0d5'; // Bahay Trends
          if (t.includes('kusina')) return 'd6e7b31a-4821-4625-9333-1989b44cf408'; // Kusina Hacks
          if (t.includes('homeliving') || t.includes('home living')) return 'd2d8ff80-66d8-4a12-a844-5df8c139463e'; // HomeLiving PH
          if (t.includes('book hub') || t.includes('book')) return '8f9caa4b-b047-4d21-9839-72208b53ecd5'; // The Book Hub
          if (t.includes('zenith') || t.includes('tai sui') || t.includes('taisui') || t.includes('bracelet') || t.includes('feng shui')) return '64df6bb0-2582-47cd-882a-76b5da8c2c91'; // Zenith
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
        if (!resolvedStoreId) {
          resolvedStoreId = topVote(votesByTeamId, row.teamId) || defaultTenantStoreId;
        }

        const targetStore = storeById.get(resolvedStoreId)!;
        const isSuperAdminStore = isBusinessReportExcludedStore(targetStore);
        const targetTeamId = isSuperAdminStore
          ? targetStore.teamId
          : row.teamId && !isSuperAdminOnlyTeamId(row.teamId)
            ? row.teamId
            : targetStore.teamId;
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
        const isSuperAdminStore = isBusinessReportExcludedStore(st);
        const targetTeamId = isSuperAdminStore
          ? st.teamId
          : m.teamId && !isSuperAdminOnlyTeamId(m.teamId)
            ? m.teamId
            : st.teamId;
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
        const resolvedStore = resolveStoreAttributionLocal(r as any, index);
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

async function main() {
  console.log('Starting database seed...');
  await ensureSuperAdmin();
  await seedPermissions();
  await seedRoles();
  await ensureDefaultTeamsAndBackfill();
  await backfillAdSpendStoreAndTeamAttribution();
  await backfill2026OrderCogsAndReports();
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

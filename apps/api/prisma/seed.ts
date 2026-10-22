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

    // 2. Remove zero/negative pos_product_cogs rows when a positive COGS row exists for the same product
    const deletedZeroRows = await prisma.$executeRawUnsafe(`
      DELETE FROM pos_product_cogs z
      WHERE z.cogs <= 0
        AND EXISTS (
          SELECT 1
          FROM pos_product_cogs p
          WHERE p."productId" = z."productId"
            AND p.cogs > 0
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
        WHERE u."tenantId" = earliest."tenantId"
          AND u."productId" = earliest."productId"
          AND u."storeId" = earliest."storeId"
          AND u."startDate" IS NULL
          AND u.cogs > 0
      )
    `);

    // 5. Propagate positive undated baseline COGS to sibling variants in the same (storeId, productId)
    //    or same (tenantId, lower(btrim(customId))) or same storeId when a product still lacks positive COGS.
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
        SELECT DISTINCT ON (c."tenantId", LOWER(BTRIM(p."customId")))
          c."tenantId",
          LOWER(BTRIM(p."customId")) AS norm_sku,
          c.cogs
        FROM pos_product_cogs c
        JOIN pos_products p ON p.id = c."productId"
        WHERE c.cogs > 0
          AND p."customId" IS NOT NULL
          AND BTRIM(p."customId") <> ''
        ORDER BY c."tenantId", LOWER(BTRIM(p."customId")), (c."startDate" IS NULL) DESC, c."updatedAt" DESC
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
          AND LENGTH(BTRIM(p.name)) >= 4
        ORDER BY c."tenantId", LOWER(BTRIM(p.name)), (c."startDate" IS NULL) DESC, c."updatedAt" DESC
      ),
      store_fallback_rate AS (
        SELECT DISTINCT ON (c."storeId")
          c."storeId",
          c.cogs
        FROM pos_product_cogs c
        WHERE c.cogs > 0
        ORDER BY c."storeId", (c."startDate" IS NULL) DESC, c."updatedAt" DESC
      )
      INSERT INTO pos_product_cogs (id, "tenantId", "teamId", "productId", "storeId", cogs, "startDate", "endDate", "createdAt", "updatedAt")
      SELECT
        gen_random_uuid(),
        s."tenantId",
        s."teamId",
        p.id,
        p."storeId",
        COALESCE(spr.cogs, tsr.cogs, sfr.cogs, tnr.cogs) AS cogs,
        NULL,
        NULL,
        NOW(),
        NOW()
      FROM pos_products p
      JOIN pos_stores s ON s.id = p."storeId"
      LEFT JOIN store_parent_rate spr
        ON spr."storeId" = p."storeId" AND spr."productId" = p."productId"
      LEFT JOIN tenant_sku_rate tsr
        ON tsr."tenantId" = s."tenantId"
       AND p."customId" IS NOT NULL
       AND BTRIM(p."customId") <> ''
       AND tsr.norm_sku = LOWER(BTRIM(p."customId"))
      LEFT JOIN store_fallback_rate sfr
        ON sfr."storeId" = p."storeId"
      LEFT JOIN tenant_name_rate tnr
        ON tnr."tenantId" = s."tenantId"
       AND p.name IS NOT NULL
       AND LENGTH(BTRIM(p.name)) >= 4
       AND tnr.norm_name = LOWER(BTRIM(p.name))
      WHERE COALESCE(spr.cogs, tsr.cogs, sfr.cogs, tnr.cogs) > 0
        AND NOT EXISTS (
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

    // 6. Backfill all 2026 orders (dateLocal >= '2026-01-01', non-void, status <> 7)
    //    using materialized temporary lookup tables and hash joins per month so execution completes in seconds.
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS tmp_var_cogs, tmp_sku_cogs, tmp_parent_cogs, tmp_tenant_sku_cogs, tmp_store_cogs`);
    await prisma.$executeRawUnsafe(`
      CREATE TEMP TABLE tmp_var_cogs AS
      SELECT DISTINCT ON (s."tenantId", s."shopId", p."variationId")
        s."tenantId",
        s."shopId",
        p."variationId",
        c.cogs
      FROM pos_products p
      JOIN pos_stores s ON s.id = p."storeId"
      JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
      WHERE p."variationId" IS NOT NULL AND BTRIM(p."variationId") <> ''
      ORDER BY s."tenantId", s."shopId", p."variationId", (p."variationId" <> p."productId") DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TEMP TABLE tmp_sku_cogs AS
      SELECT DISTINCT ON (s."tenantId", s."shopId", LOWER(BTRIM(p."customId")))
        s."tenantId",
        s."shopId",
        LOWER(BTRIM(p."customId")) AS norm_sku,
        c.cogs
      FROM pos_products p
      JOIN pos_stores s ON s.id = p."storeId"
      JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
      WHERE p."customId" IS NOT NULL AND BTRIM(p."customId") <> ''
      ORDER BY s."tenantId", s."shopId", LOWER(BTRIM(p."customId")), (c."startDate" IS NULL) DESC, c."updatedAt" DESC
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TEMP TABLE tmp_parent_cogs AS
      SELECT DISTINCT ON (s."tenantId", s."shopId", p."productId")
        s."tenantId",
        s."shopId",
        p."productId",
        c.cogs
      FROM pos_products p
      JOIN pos_stores s ON s.id = p."storeId"
      JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
      WHERE p."productId" IS NOT NULL AND BTRIM(p."productId") <> ''
      ORDER BY s."tenantId", s."shopId", p."productId", (c."startDate" IS NULL) DESC, c."updatedAt" DESC
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TEMP TABLE tmp_tenant_sku_cogs AS
      SELECT DISTINCT ON (c."tenantId", LOWER(BTRIM(p."customId")))
        c."tenantId",
        LOWER(BTRIM(p."customId")) AS norm_sku,
        c.cogs
      FROM pos_product_cogs c
      JOIN pos_products p ON p.id = c."productId"
      WHERE c.cogs > 0 AND p."customId" IS NOT NULL AND BTRIM(p."customId") <> ''
      ORDER BY c."tenantId", LOWER(BTRIM(p."customId")), (c."startDate" IS NULL) DESC, c."updatedAt" DESC
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TEMP TABLE tmp_store_cogs AS
      SELECT DISTINCT ON (s."tenantId", s."shopId")
        s."tenantId",
        s."shopId",
        c.cogs
      FROM pos_stores s
      JOIN pos_product_cogs c ON c."storeId" = s.id AND c.cogs > 0
      ORDER BY s."tenantId", s."shopId", (s.status = 'ACTIVE') DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
    `);

    const months = ['2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01'];
    let updatedOrders = 0;
    for (const month of months) {
      const monthUpdated = await prisma.$executeRawUnsafe(`
        WITH candidate_orders AS (
          SELECT
            o.id,
            o."tenantId",
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
            AND o."isVoid" = false
            AND (o.status IS NULL OR o.status <> 7)
        ),
        expanded_items AS (
          SELECT
            co.id AS order_id,
            co."tenantId",
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
              NULLIF(LOWER(BTRIM(COALESCE(item->>'product_display_id', ''))), ''),
              NULLIF(LOWER(BTRIM(COALESCE(item->>'productDisplayId', ''))), ''),
              NULLIF(LOWER(BTRIM(COALESCE(item->'variation_info'->>'product_display_id', ''))), ''),
              NULLIF(LOWER(BTRIM(COALESCE(item->'variation_info'->>'display_id', ''))), ''),
              NULLIF(LOWER(BTRIM(COALESCE(item->'variation_info'->>'barcode', ''))), '')
            ) AS disp_sku
          FROM candidate_orders co
          CROSS JOIN LATERAL jsonb_array_elements(co.items) AS item
          WHERE jsonb_array_length(co.items) > 0
        ),
        order_item_eval AS (
          SELECT
            ei.order_id,
            COALESCE(SUM(ei.qty), 0)::int AS calc_qty,
            ROUND(COALESCE(SUM(ei.qty * COALESCE(vc.cogs, sc.cogs, pc.cogs, tsc.cogs, tmsc.cogs, stc.cogs, 0)), 0)::numeric, 2) AS calc_cogs,
            BOOL_AND(COALESCE(vc.cogs, sc.cogs, pc.cogs, tsc.cogs, tmsc.cogs, stc.cogs, 0) > 0) AS all_items_priced
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
          GROUP BY ei.order_id
        ),
        empty_item_eval AS (
          SELECT
            co.id AS order_id,
            GREATEST(co."totalQuantity", 1)::int AS calc_qty,
            ROUND((GREATEST(co."totalQuantity", 1) * COALESCE(tmsc.cogs, stc.cogs, 0))::numeric, 2) AS calc_cogs
          FROM candidate_orders co
          LEFT JOIN tmp_tenant_sku_cogs tmsc
            ON tmsc."tenantId" = co."tenantId" AND tmsc.norm_sku = co.norm_mapping
          LEFT JOIN tmp_store_cogs stc
            ON stc."tenantId" = co."tenantId" AND stc."shopId" = co."shopId"
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
      console.log(`✓ Backfilled ${month}: ${monthUpdated} orders updated`);
    }
    console.log(`✓ Updated ${updatedOrders} total 2026 POS orders with aligned ERP COGS and quantities`);

    // 7. Recompute 2026 POS COGS columns in reconcile_marketing, reconcile_sales, and reconcile_sales_attribution month-by-month
    let updatedReconcileMarketing = 0;
    let updatedReconcileSales = 0;
    let updatedReconcileAttribution = 0;
    const monthRanges: Array<[string, string]> = [
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
    ];

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
        COUNT(*) FILTER (WHERE o.cogs = 0)::int AS "zeroCogs2026Orders"
      FROM pos_orders o
      JOIN pos_stores s ON s."tenantId" = o."tenantId" AND s."shopId" = o."shopId"
      WHERE o."dateLocal" >= '2026-01-01'
        AND o."isVoid" = false
        AND (o.status IS NULL OR o.status <> 7)
    `);
    console.log('SmileOrganics AFTER backfill:', JSON.stringify(smileAfter));
    console.log('Overall 2026 orders AFTER backfill:', JSON.stringify(summary2026After));

    // 11. Bump Redis analytics cache version for every tenant
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

    console.log(`✓ Completed 2026 COGS & Report Backfill in ${Date.now() - startedAt}ms`);
  } catch (err: any) {
    console.error('Warning during 2026 COGS backfill:', err?.message || err);
  }
}

async function main() {
  console.log('Starting database seed...');
  await ensureSuperAdmin();
  await seedPermissions();
  await seedRoles();
  await ensureDefaultTeamsAndBackfill();
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

'use client';

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  KeyRound,
  Link2,
  Plug,
  Radio,
  RefreshCw,
  Store,
  Tags,
  Warehouse,
} from 'lucide-react';
import { readStoredAdminUser, readStoredPermissions } from '@/lib/admin-session';
import {
  hasAnyAdminPermission,
  WMS_INTEGRATIONS_EDIT_PERMISSIONS,
  WMS_INTEGRATIONS_READ_PERMISSIONS,
  WMS_INTEGRATIONS_SYNC_PERMISSIONS,
  WMS_INTEGRATIONS_WEBHOOK_ROTATE_PERMISSIONS,
  WMS_INTEGRATIONS_WEBHOOK_UPDATE_PERMISSIONS,
  WMS_INTEGRATIONS_WRITE_PERMISSIONS,
} from '@/lib/wms-permissions';
import { WmsCompactPanel } from '../../../_components/wms-compact-panel';
import { WmsInlineNotice } from '../../../_components/wms-inline-notice';
import { WmsPageShell } from '../../../_components/wms-page-shell';
import {
  bulkImportPartnerPosStores,
  fetchPartnerIntegrationOverview,
  rotatePartnerWebhookApiKey,
  removePartnerPosStore,
  syncPartnerPosStoreAll,
  syncPartnerPosStoreProducts,
  syncPartnerPosStoreTags,
  syncPartnerPosStoreWarehouses,
  updatePartnerPosStore,
  updatePartnerWebhook,
  updatePartnerWebhookRelay,
} from '../../_services/tenant-integrations.service';
import type {
  PartnerIntegrationActionResponse,
  PartnerIntegrationOverview,
  PartnerPosStoreIntegration,
  PartnerWebhookLog,
  UpdatePartnerPosStoreInput,
  UpdatePartnerWebhookInput,
  UpdatePartnerWebhookRelayInput,
} from '../../_types/tenant-integrations';
import {
  formatTenantDateTime,
  formatTenantStatus,
  getTenantStatusClassName,
} from '../../_utils/tenant-presenters';

export default function PartnerIntegrationsPage() {
  const router = useRouter();
  const params = useParams();
  const tenantId = params.id as string;
  const user = useMemo(() => readStoredAdminUser(), []);
  const permissions = useMemo(() => readStoredPermissions(), []);
  const access = useMemo(
    () => buildIntegrationAccess(user?.role, permissions),
    [permissions, user?.role],
  );
  const [overview, setOverview] = useState<PartnerIntegrationOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [apiKeysText, setApiKeysText] = useState('');
  const [rotatedWebhookApiKey, setRotatedWebhookApiKey] = useState('');
  const [editingStoreId, setEditingStoreId] = useState<string | null>(null);

  useEffect(() => {
    if (!access.canWrite) {
      setIsImportOpen(false);
    }

    if (!access.canEdit) {
      setEditingStoreId(null);
    }
  }, [access.canEdit, access.canWrite]);

  useEffect(() => {
    let isMounted = true;

    async function loadOverview() {
      try {
        const token = localStorage.getItem('access_token');
        if (!token) {
          router.push('/login');
          return;
        }

        const data = await fetchPartnerIntegrationOverview(tenantId);
        if (isMounted) {
          setOverview(data);
          setError('');
        }
      } catch (error: unknown) {
        if (isMounted) {
          setError(getErrorMessage(error, 'Failed to load partner integrations'));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadOverview();

    return () => {
      isMounted = false;
    };
  }, [router, tenantId]);

  const webhookHealth = useMemo(() => {
    if (!overview) {
      return null;
    }

    if (!overview.webhook.enabled) {
      return {
        label: 'Webhook off',
        className: 'border-amber-200 bg-amber-50 text-amber-700',
        icon: <AlertTriangle className="h-3.5 w-3.5" />,
      };
    }

    if (!overview.webhook.hasApiKey) {
      return {
        label: 'Key missing',
        className: 'border-rose-200 bg-rose-50 text-rose-700',
        icon: <AlertTriangle className="h-3.5 w-3.5" />,
      };
    }

    return {
      label: 'Webhook live',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    };
  }, [overview]);

  const copyWebhookUrl = async () => {
    if (!overview?.webhook.webhookUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(overview.webhook.webhookUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const runIntegrationAction = async (
    actionKey: string,
    action: () => Promise<PartnerIntegrationActionResponse>,
    getMessage: (response: PartnerIntegrationActionResponse) => string,
  ) => {
    setPendingAction(actionKey);
    setActionError('');
    setActionMessage('');

    try {
      const response = await action();
      setOverview(response.overview);
      setActionMessage(getMessage(response));
    } catch (error: unknown) {
      setActionError(getErrorMessage(error, 'Integration action failed'));
    } finally {
      setPendingAction(null);
    }
  };

  const submitBulkImport = async () => {
    const apiKeys = parseApiKeys(apiKeysText);

    if (apiKeys.length === 0) {
      setActionError('Paste at least one Pancake API key.');
      return;
    }

    await runIntegrationAction(
      'bulkImport',
      () => bulkImportPartnerPosStores(tenantId, {
        integrations: apiKeys.map((apiKey) => ({ apiKey })),
      }),
      (response) => summarizeBulkImportResult(response.result),
    );
  };

  const syncStore = async (
    store: PartnerPosStoreIntegration,
    target: StoreSyncTarget,
  ) => {
    const actionKey = getStoreActionKey(store.id, target);
    const label = getStoreSyncLabel(target);

    await runIntegrationAction(
      actionKey,
      () => {
        if (target === 'products') {
          return syncPartnerPosStoreProducts(tenantId, store.id);
        }

        if (target === 'tags') {
          return syncPartnerPosStoreTags(tenantId, store.id);
        }

        if (target === 'warehouses') {
          return syncPartnerPosStoreWarehouses(tenantId, store.id);
        }

        return syncPartnerPosStoreAll(tenantId, store.id);
      },
      () => `${label} synced for ${store.name}.`,
    );
  };

  const saveStoreSettings = async (
    store: PartnerPosStoreIntegration,
    input: UpdatePartnerPosStoreInput,
  ) => {
    await runIntegrationAction(
      getStoreActionKey(store.id, 'edit'),
      () => updatePartnerPosStore(tenantId, store.id, input),
      () => {
        setEditingStoreId(null);
        return `${store.name} updated.`;
      },
    );
  };

  const saveWebhookSettings = async (input: UpdatePartnerWebhookInput) => {
    await runIntegrationAction(
      'webhook:update',
      () => updatePartnerWebhook(tenantId, input),
      () => 'Webhook settings saved.',
    );
  };

  const rotateWebhookKey = async () => {
    await runIntegrationAction(
      'webhook:rotate',
      () => rotatePartnerWebhookApiKey(tenantId),
      (response) => {
        const apiKey = getRotatedWebhookApiKey(response.result);
        if (apiKey) {
          setRotatedWebhookApiKey(apiKey);
          return 'Webhook key rotated. Copy the new key now.';
        }

        return 'Webhook key rotated.';
      },
    );
  };

  const saveWebhookRelay = async (input: UpdatePartnerWebhookRelayInput) => {
    await runIntegrationAction(
      'webhook:relay',
      () => updatePartnerWebhookRelay(tenantId, input),
      () => 'Webhook relay settings saved.',
    );
  };

  const removeStore = async (store: PartnerPosStoreIntegration) => {
    if (!window.confirm(
      `Remove ${store.name}? This deletes the connected store data, matching POS orders, and related WMS records for this shop.`,
    )) {
      return;
    }

    setEditingStoreId((current) => (current === store.id ? null : current));

    await runIntegrationAction(
      getStoreActionKey(store.id, 'remove'),
      () => removePartnerPosStore(tenantId, store.id),
      (response) => summarizeStoreRemovalResult(store, response.result),
    );
  };

  if (isLoading) {
    return (
      <WmsPageShell title="Client integrations" breadcrumb="Clients">
        <WmsInlineNotice tone="info">Loading client integrations…</WmsInlineNotice>
      </WmsPageShell>
    );
  }

  if (!overview) {
    return (
      <WmsPageShell title="Client integrations" breadcrumb="Clients">
        <WmsInlineNotice tone="error">{error || 'Client integrations not found'}</WmsInlineNotice>
      </WmsPageShell>
    );
  }

  return (
    <WmsPageShell
      title={`${overview.partner.name} integrations`}
      breadcrumb="Clients / Manage"
      description="Client-level POS store connections and Pancake webhook health for WMS operations."
      actions={
        <>
          <Link href={`/tenants/${overview.partner.id}`} className="btn btn-md btn-outline btn-icon">
            <ArrowLeft className="h-3.5 w-3.5" />
            Client
          </Link>
          <span className={getTenantStatusClassName(overview.partner.status)}>
            {formatTenantStatus(overview.partner.status)}
          </span>
          {webhookHealth ? (
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${webhookHealth.className}`}>
              {webhookHealth.icon}
              {webhookHealth.label}
            </span>
          ) : null}
        </>
      }
    >
      {error ? <WmsInlineNotice tone="error">{error}</WmsInlineNotice> : null}
      {actionError ? (
        <WmsInlineNotice tone="error" dismissible onDismiss={() => setActionError('')}>
          {actionError}
        </WmsInlineNotice>
      ) : null}
      {actionMessage ? (
        <WmsInlineNotice
          tone="success"
          dismissible
          autoDismissMs={4000}
          onDismiss={() => setActionMessage('')}
        >
          {actionMessage}
        </WmsInlineNotice>
      ) : null}
      {access.isReadOnly ? (
        <WmsInlineNotice tone="info">
          Read-only access. You can review stores, webhook status, and recent logs, but operational actions are hidden.
        </WmsInlineNotice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<Store className="h-4 w-4" />}
          label="POS stores"
          value={overview.summary.stores}
          meta={`${overview.summary.activeStores} active`}
        />
        <MetricTile
          icon={<Boxes className="h-4 w-4" />}
          label="Products"
          value={overview.summary.products}
          meta="Synced to WMS"
        />
        <MetricTile
          icon={<Warehouse className="h-4 w-4" />}
          label="POS warehouses"
          value={overview.summary.posWarehouses}
          meta={`${overview.summary.tags} tags`}
        />
        <MetricTile
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Webhook issues"
          value={overview.summary.recentWebhookErrors}
          meta="Last 7 days"
          tone={overview.summary.recentWebhookErrors > 0 ? 'warning' : 'success'}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
        <WmsCompactPanel
          title="POS Store Integrations"
          icon={<Plug className="panel-icon" />}
          meta={`${overview.stores.length.toLocaleString()} connected`}
          headerActions={
            access.canWrite ? (
              <button
                type="button"
                onClick={() => setIsImportOpen((current) => !current)}
                className="btn btn-sm btn-primary btn-icon"
                disabled={pendingAction === 'bulkImport'}
              >
                <KeyRound className="h-3.5 w-3.5" />
                {isImportOpen ? 'Close import' : 'Import stores'}
              </button>
            ) : null
          }
        >
          {isImportOpen && access.canWrite ? (
            <PosStoreImportPanel
              apiKeysText={apiKeysText}
              isSubmitting={pendingAction === 'bulkImport'}
              onApiKeysTextChange={setApiKeysText}
              onSubmit={submitBulkImport}
            />
          ) : null}
          <PosStoresTable
            stores={overview.stores}
            pendingAction={pendingAction}
            editingStoreId={editingStoreId}
            access={access}
            onSyncStore={syncStore}
            onEditStore={(store) => setEditingStoreId((current) => current === store.id ? null : store.id)}
            onRemoveStore={removeStore}
            onCloseEdit={() => setEditingStoreId(null)}
            onSaveStore={saveStoreSettings}
            onOpenImport={() => setIsImportOpen(true)}
          />
        </WmsCompactPanel>

        <aside className="space-y-5">
          <WmsCompactPanel title="Pancake Webhook" icon={<Radio className="panel-icon" />}>
            <div className="space-y-3">
              <StatusLine
                icon={<Radio className="h-3.5 w-3.5" />}
                label="Receiver"
                value={overview.webhook.enabled ? 'Enabled' : 'Disabled'}
                tone={overview.webhook.enabled ? 'success' : 'warning'}
              />
              <StatusLine
                icon={<KeyRound className="h-3.5 w-3.5" />}
                label="API key"
                value={overview.webhook.hasApiKey ? `Set${overview.webhook.keyLast4 ? ` • ${overview.webhook.keyLast4}` : ''}` : 'Missing'}
                tone={overview.webhook.hasApiKey ? 'success' : 'danger'}
              />
              <StatusLine
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                label="Reconcile"
                value={overview.webhook.reconcileEnabled ? `${overview.webhook.reconcileMode} • ${overview.webhook.reconcileIntervalSeconds}s` : 'Disabled'}
                tone={overview.webhook.reconcileEnabled ? 'neutral' : 'warning'}
              />
              <StatusLine
                icon={<Link2 className="h-3.5 w-3.5" />}
                label="Relay"
                value={overview.webhook.relayEnabled ? 'Enabled' : 'Disabled'}
                tone={overview.webhook.relayEnabled ? 'success' : 'neutral'}
              />
              <div className="rounded-2xl border border-[#dce4ea] bg-[#fbfcfc] p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">
                    Webhook URL
                  </p>
                  <button
                    type="button"
                    onClick={copyWebhookUrl}
                    className="btn btn-sm btn-outline btn-icon"
                  >
                    <Copy className="h-3 w-3" />
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="mt-2 break-all font-mono text-[11.5px] leading-5 text-primary">
                  {overview.webhook.webhookUrl}
                </p>
              </div>
              {rotatedWebhookApiKey ? (
                <OneTimeWebhookKeyNotice
                  apiKey={rotatedWebhookApiKey}
                  onDismiss={() => setRotatedWebhookApiKey('')}
                />
              ) : null}
              <WebhookSettingsForm
                webhook={overview.webhook}
                pendingAction={pendingAction}
                access={access}
                onSaveSettings={saveWebhookSettings}
                onRotateKey={rotateWebhookKey}
                onSaveRelay={saveWebhookRelay}
              />
            </div>
          </WmsCompactPanel>

          <WmsCompactPanel
            title="Recent Webhooks"
            icon={<Activity className="panel-icon" />}
            meta={`${overview.recentWebhookLogs.length} latest`}
          >
            <WebhookLogList logs={overview.recentWebhookLogs} />
          </WmsCompactPanel>
        </aside>
      </div>
    </WmsPageShell>
  );
}

function PosStoreImportPanel({
  apiKeysText,
  isSubmitting,
  onApiKeysTextChange,
  onSubmit,
}: {
  apiKeysText: string;
  isSubmitting: boolean;
  onApiKeysTextChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="mb-3 rounded-[18px] border border-[#dce4ea] bg-[#fbfcfc] p-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">
            Pancake API keys
          </span>
          <textarea
            value={apiKeysText}
            onChange={(event) => onApiKeysTextChange(event.target.value)}
            className="input mt-2 min-h-[88px] font-mono text-[12px]"
            placeholder="Paste one API key per line"
            disabled={isSubmitting}
          />
        </label>
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting}
          className="btn btn-md btn-primary btn-icon lg:mb-0.5"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isSubmitting ? 'animate-spin' : ''}`} />
          {isSubmitting ? 'Importing' : 'Import and sync'}
        </button>
      </div>
      <p className="mt-2 text-[12px] leading-5 text-[#6f8290]">
        Each key discovers Pancake shops for this partner and syncs products, tags, and warehouses.
      </p>
    </div>
  );
}

function PosStoresTable({
  stores,
  pendingAction,
  editingStoreId,
  access,
  onSyncStore,
  onEditStore,
  onRemoveStore,
  onCloseEdit,
  onSaveStore,
  onOpenImport,
}: {
  stores: PartnerPosStoreIntegration[];
  pendingAction: string | null;
  editingStoreId: string | null;
  access: IntegrationAccess;
  onSyncStore: (store: PartnerPosStoreIntegration, target: StoreSyncTarget) => void;
  onEditStore: (store: PartnerPosStoreIntegration) => void;
  onRemoveStore: (store: PartnerPosStoreIntegration) => void;
  onCloseEdit: () => void;
  onSaveStore: (store: PartnerPosStoreIntegration, input: UpdatePartnerPosStoreInput) => void;
  onOpenImport: () => void;
}) {
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(stores.length / POS_STORES_PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * POS_STORES_PAGE_SIZE;
  const paginatedStores = stores.slice(startIndex, startIndex + POS_STORES_PAGE_SIZE);
  const paginationStart = stores.length === 0 ? 0 : startIndex + 1;
  const paginationEnd = Math.min(stores.length, startIndex + paginatedStores.length);

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  if (stores.length === 0) {
    return (
      <div className="flex min-h-[240px] flex-col items-center justify-center rounded-2xl border border-dashed border-[#d7e0e7] bg-[#fbfcfc] px-6 text-center">
        <Store className="h-8 w-8 text-[#8aa0ad]" />
        <p className="mt-3 text-sm font-semibold text-primary">No POS stores connected</p>
        <p className="mt-1 max-w-sm text-[12.5px] leading-5 text-[#6f8290]">
          Import Pancake API keys to connect shops and load catalog data for WMS.
        </p>
        {access.canWrite ? (
          <button type="button" onClick={onOpenImport} className="btn btn-sm btn-primary btn-icon mt-4">
            <KeyRound className="h-3.5 w-3.5" />
            Import stores
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-0">
          <thead>
            <tr className="bg-[#eaf0f4] text-left">
              <HeaderCell>Store</HeaderCell>
              <HeaderCell>Provider</HeaderCell>
              <HeaderCell>Catalog</HeaderCell>
              <HeaderCell>Sync</HeaderCell>
              <HeaderCell>Status</HeaderCell>
              <HeaderCell>Actions</HeaderCell>
            </tr>
          </thead>
          <tbody className="bg-white">
            {paginatedStores.map((store) => {
              const isEditing = editingStoreId === store.id;

              return (
                <Fragment key={store.id}>
                  <tr className="border-b border-[#edf2f6] text-[13px] text-primary">
                    <BodyCell>
                      <div className="flex min-w-[220px] items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-white">
                          <Store className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{store.name}</p>
                          <p className="mt-0.5 truncate text-[11px] font-medium text-[#7c8f9b]">
                            Shop {store.shopId}
                          </p>
                        </div>
                      </div>
                    </BodyCell>
                    <BodyCell>
                      <span className="pill pill-white">
                        {store.integration?.provider?.replace(/_/g, ' ') ?? 'Unlinked'}
                      </span>
                    </BodyCell>
                    <BodyCell>
                      <div className="space-y-1 text-[12px] text-[#4d6677]">
                        <InlineCount icon={<Boxes className="h-3 w-3" />} value={store.productCount} label="products" />
                        <InlineCount icon={<Tags className="h-3 w-3" />} value={store.tagCount} label="tags" />
                        <InlineCount icon={<Database className="h-3 w-3" />} value={store.warehouseCount} label="warehouses" />
                      </div>
                    </BodyCell>
                    <BodyCell>
                      <div className="min-w-[150px]">
                        <p className="text-[12.5px] font-semibold text-primary">
                          {store.integration?.syncStatus ?? 'No sync status'}
                        </p>
                        <p className="mt-0.5 text-[11px] text-[#7c8f9b]">
                          {formatTenantDateTime(store.integration?.lastSyncAt ?? store.lastSyncAt)}
                        </p>
                      </div>
                    </BodyCell>
                    <BodyCell>
                      <span className={getIntegrationStatusClassName(store.integration?.status ?? store.status)}>
                        {store.integration?.enabled === false || store.enabled === false ? 'Disabled' : store.integration?.status ?? store.status}
                      </span>
                    </BodyCell>
                    <BodyCell>
                      <StoreSyncActions
                        store={store}
                        pendingAction={pendingAction}
                        isEditing={isEditing}
                        access={access}
                        onSyncStore={onSyncStore}
                        onEditStore={onEditStore}
                        onRemoveStore={onRemoveStore}
                      />
                    </BodyCell>
                  </tr>
                  {isEditing ? (
                    <tr>
                      <td colSpan={6} className="border-b border-[#edf2f6] bg-[#fbfcfc] px-4 py-3">
                        <StoreEditPanel
                          store={store}
                          pendingAction={pendingAction}
                          canEdit={access.canEdit}
                          onClose={onCloseEdit}
                          onSave={onSaveStore}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <PosStoresPagination
        currentPage={safePage}
        totalPages={totalPages}
        totalItems={stores.length}
        startItem={paginationStart}
        endItem={paginationEnd}
        onPrevious={() => {
          onCloseEdit();
          setCurrentPage((page) => Math.max(1, page - 1));
        }}
        onNext={() => {
          onCloseEdit();
          setCurrentPage((page) => Math.min(totalPages, page + 1));
        }}
      />
    </div>
  );
}

function StoreSyncActions({
  store,
  pendingAction,
  isEditing,
  access,
  onSyncStore,
  onEditStore,
  onRemoveStore,
}: {
  store: PartnerPosStoreIntegration;
  pendingAction: string | null;
  isEditing: boolean;
  access: IntegrationAccess;
  onSyncStore: (store: PartnerPosStoreIntegration, target: StoreSyncTarget) => void;
  onEditStore: (store: PartnerPosStoreIntegration) => void;
  onRemoveStore: (store: PartnerPosStoreIntegration) => void;
}) {
  const isBusy = Boolean(pendingAction);
  const hasActions = access.canEdit || access.canSync || access.canWrite;
  const isRemoving = pendingAction === getStoreActionKey(store.id, 'remove');

  return (
    <div className="flex min-w-[260px] flex-wrap gap-2">
      {!hasActions ? <span className="pill pill-white">Read-only</span> : null}
      {access.canEdit ? (
        <button
          type="button"
          onClick={() => onEditStore(store)}
          disabled={isBusy}
          className="btn btn-sm btn-outline"
        >
          {isEditing ? 'Close' : 'Edit'}
        </button>
      ) : null}
      {access.canWrite ? (
        <button
          type="button"
          onClick={() => onRemoveStore(store)}
          disabled={isBusy}
          className="btn btn-sm btn-outline text-rose-700 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-800"
        >
          {isRemoving ? 'Removing' : 'Remove'}
        </button>
      ) : null}
      {access.canSync
        ? (['all', 'products', 'tags', 'warehouses'] as StoreSyncTarget[]).map((target) => {
            const actionKey = getStoreActionKey(store.id, target);
            const isCurrent = pendingAction === actionKey;
            const isPrimary = target === 'all';

            return (
              <button
                key={target}
                type="button"
                onClick={() => onSyncStore(store, target)}
                disabled={isBusy}
                className={`btn btn-sm ${isPrimary ? 'btn-primary' : 'btn-outline'} btn-icon`}
              >
                <RefreshCw className={`h-3 w-3 ${isCurrent ? 'animate-spin' : ''}`} />
                {isCurrent ? 'Syncing' : getStoreSyncLabel(target)}
              </button>
            );
          })
        : null}
    </div>
  );
}

function PosStoresPagination({
  currentPage,
  totalPages,
  totalItems,
  startItem,
  endItem,
  onPrevious,
  onNext,
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  startItem: number;
  endItem: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[18px] border border-[#dce4ea] bg-[#fbfcfc] px-3 py-2.5 text-[12px] text-[#6f8290] sm:flex-row sm:items-center sm:justify-between">
      <span>
        Showing <span className="font-semibold tabular-nums text-primary">{startItem}-{endItem}</span> of{' '}
        <span className="font-semibold tabular-nums text-primary">{totalItems.toLocaleString()}</span> stores
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrevious}
          disabled={currentPage <= 1}
          className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-[#d7e0e7] bg-white text-[#4d6677] transition hover:border-[#c6d4dd] hover:text-primary disabled:cursor-not-allowed disabled:opacity-45"
          aria-label="Previous POS store page"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="rounded-full border border-[#dce4ea] bg-white px-3 py-1.5 text-[12px] font-semibold tabular-nums text-primary">
          {currentPage} / {totalPages}
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={currentPage >= totalPages}
          className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-[#d7e0e7] bg-white text-[#4d6677] transition hover:border-[#c6d4dd] hover:text-primary disabled:cursor-not-allowed disabled:opacity-45"
          aria-label="Next POS store page"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function StoreEditPanel({
  store,
  pendingAction,
  canEdit,
  onClose,
  onSave,
}: {
  store: PartnerPosStoreIntegration;
  pendingAction: string | null;
  canEdit: boolean;
  onClose: () => void;
  onSave: (store: PartnerPosStoreIntegration, input: UpdatePartnerPosStoreInput) => void;
}) {
  const [form, setForm] = useState({
    name: store.storeName,
    shopName: store.shopName,
    description: store.description ?? '',
    status: normalizeStoreStatus(store.integration?.status ?? store.status),
    enabled: store.integration?.enabled !== false && store.enabled !== false,
    initialValueOffer: store.initialValueOffer === null ? '' : String(store.initialValueOffer),
  });
  const actionKey = getStoreActionKey(store.id, 'edit');
  const isSaving = pendingAction === actionKey;
  const isBusy = Boolean(pendingAction);
  const initialValueOffer = form.initialValueOffer.trim()
    ? Number(form.initialValueOffer)
    : undefined;
  const canSaveOffer =
    initialValueOffer === undefined
    || (Number.isFinite(initialValueOffer) && initialValueOffer >= 0);

  useEffect(() => {
    setForm({
      name: store.storeName,
      shopName: store.shopName,
      description: store.description ?? '',
      status: normalizeStoreStatus(store.integration?.status ?? store.status),
      enabled: store.integration?.enabled !== false && store.enabled !== false,
      initialValueOffer: store.initialValueOffer === null ? '' : String(store.initialValueOffer),
    });
  }, [store]);

  return (
    <div className="rounded-[18px] border border-[#dce4ea] bg-white p-3">
      {!canEdit ? (
        <div className="mb-3 rounded-[14px] border border-[#dce4ea] bg-[#fbfcfc] px-3 py-2.5 text-[12px] text-[#637786]">
          Store editing is not available for your WMS role.
        </div>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">
            Store name
          </span>
          <input
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            className="input mt-1.5"
            disabled={isBusy || !canEdit}
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">
            Display name
          </span>
          <input
            value={form.shopName}
            onChange={(event) => setForm((current) => ({ ...current, shopName: event.target.value }))}
            className="input mt-1.5"
            disabled={isBusy || !canEdit}
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">
            Status
          </span>
          <select
            value={form.status}
            onChange={(event) => setForm((current) => ({
              ...current,
              status: event.target.value as StoreStatus,
            }))}
            className="input mt-1.5"
            disabled={isBusy || !canEdit}
          >
            <option value="ACTIVE">Active</option>
            <option value="PENDING">Pending</option>
            <option value="ERROR">Error</option>
            <option value="DISABLED">Disabled</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">
            Initial offer value
          </span>
          <input
            type="number"
            min={0}
            value={form.initialValueOffer}
            onChange={(event) => setForm((current) => ({
              ...current,
              initialValueOffer: event.target.value,
            }))}
            className="input mt-1.5"
            disabled={isBusy || !canEdit}
          />
        </label>
        <label className="lg:col-span-2 block">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">
            Description
          </span>
          <textarea
            value={form.description}
            onChange={(event) => setForm((current) => ({
              ...current,
              description: event.target.value,
            }))}
            className="input mt-1.5 min-h-[76px]"
            disabled={isBusy || !canEdit}
          />
        </label>
        <label className="lg:col-span-2 flex items-center justify-between gap-3 rounded-[14px] border border-[#dce4ea] bg-[#fbfcfc] px-3 py-2.5 text-[12.5px] font-semibold text-primary">
          <span>Store enabled</span>
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={isBusy || !canEdit}
            onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
            className="h-4 w-4 accent-[#12384b]"
          />
        </label>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={isBusy} className="btn btn-sm btn-outline">
          Cancel
        </button>
        <button
          type="button"
          disabled={isBusy || !canEdit || !canSaveOffer || !form.name.trim() || !form.shopName.trim()}
          onClick={() => onSave(store, {
            name: form.name.trim(),
            shopName: form.shopName.trim(),
            description: form.description,
            status: form.status,
            enabled: form.enabled,
            ...(initialValueOffer !== undefined ? { initialValueOffer } : {}),
          })}
          className="btn btn-sm btn-primary btn-icon"
        >
          <RefreshCw className={`h-3 w-3 ${isSaving ? 'animate-spin' : ''}`} />
          {isSaving ? 'Saving' : 'Save store'}
        </button>
      </div>
    </div>
  );
}

function OneTimeWebhookKeyNotice({
  apiKey,
  onDismiss,
}: {
  apiKey: string;
  onDismiss: () => void;
}) {
  const [copiedKey, setCopiedKey] = useState(false);

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopiedKey(true);
      window.setTimeout(() => setCopiedKey(false), 1500);
    } catch {
      setCopiedKey(false);
    }
  };

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em]">
          New webhook key
        </p>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={copyKey} className="btn btn-sm btn-outline btn-icon">
            <Copy className="h-3 w-3" />
            {copiedKey ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={onDismiss} className="btn btn-sm btn-outline">
            Dismiss
          </button>
        </div>
      </div>
      <p className="mt-2 break-all font-mono text-[11.5px] leading-5">{apiKey}</p>
    </div>
  );
}

function WebhookSettingsForm({
  webhook,
  pendingAction,
  access,
  onSaveSettings,
  onRotateKey,
  onSaveRelay,
}: {
  webhook: PartnerIntegrationOverview['webhook'];
  pendingAction: string | null;
  access: IntegrationAccess;
  onSaveSettings: (input: UpdatePartnerWebhookInput) => void;
  onRotateKey: () => void;
  onSaveRelay: (input: UpdatePartnerWebhookRelayInput) => void;
}) {
  const [settingsForm, setSettingsForm] = useState({
    enabled: webhook.enabled,
    autoCancelEnabled: webhook.autoCancelEnabled,
    reconcileEnabled: webhook.reconcileEnabled,
    reconcileIntervalSeconds: String(webhook.reconcileIntervalSeconds),
    reconcileMode: webhook.reconcileMode,
  });
  const [relayForm, setRelayForm] = useState({
    enabled: webhook.relayEnabled,
    webhookUrl: webhook.relayWebhookUrl ?? '',
    headerKey: webhook.relayHeaderKey ?? 'x-api-key',
    apiKey: '',
  });

  useEffect(() => {
    setSettingsForm({
      enabled: webhook.enabled,
      autoCancelEnabled: webhook.autoCancelEnabled,
      reconcileEnabled: webhook.reconcileEnabled,
      reconcileIntervalSeconds: String(webhook.reconcileIntervalSeconds),
      reconcileMode: webhook.reconcileMode,
    });
    setRelayForm({
      enabled: webhook.relayEnabled,
      webhookUrl: webhook.relayWebhookUrl ?? '',
      headerKey: webhook.relayHeaderKey ?? 'x-api-key',
      apiKey: '',
    });
  }, [webhook]);

  const isSavingSettings = pendingAction === 'webhook:update';
  const isRotating = pendingAction === 'webhook:rotate';
  const isSavingRelay = pendingAction === 'webhook:relay';
  const isBusy = Boolean(pendingAction);
  const canUpdateWebhook = access.canWebhookUpdate;
  const canRotateWebhook = access.canWebhookRotate;
  const reconcileIntervalSeconds = Number(settingsForm.reconcileIntervalSeconds);
  const canSaveSettings =
    Number.isFinite(reconcileIntervalSeconds)
    && reconcileIntervalSeconds >= 10
    && reconcileIntervalSeconds <= 3600;

  return (
    <div className="space-y-3">
      {!canUpdateWebhook && !canRotateWebhook ? (
        <div className="rounded-[14px] border border-[#dce4ea] bg-[#fbfcfc] px-3 py-2.5 text-[12px] text-[#637786]">
          Webhook settings are read-only for your WMS role.
        </div>
      ) : null}
      <div className="rounded-2xl border border-[#dce4ea] bg-white p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">
            Receiver settings
          </p>
          {canRotateWebhook ? (
            <button
              type="button"
              onClick={onRotateKey}
              disabled={isBusy}
              className="btn btn-sm btn-outline btn-icon"
            >
              <KeyRound className={`h-3 w-3 ${isRotating ? 'animate-spin' : ''}`} />
              {isRotating ? 'Rotating' : 'Rotate key'}
            </button>
          ) : null}
        </div>

        <div className="mt-3 grid gap-2">
          <ToggleRow
            label="Receiver"
            checked={settingsForm.enabled}
            disabled={isBusy || !canUpdateWebhook}
            onChange={(checked) => setSettingsForm((current) => ({ ...current, enabled: checked }))}
          />
          <ToggleRow
            label="Auto-cancel"
            checked={settingsForm.autoCancelEnabled}
            disabled={isBusy || !canUpdateWebhook}
            onChange={(checked) => setSettingsForm((current) => ({ ...current, autoCancelEnabled: checked }))}
          />
          <ToggleRow
            label="Reconcile"
            checked={settingsForm.reconcileEnabled}
            disabled={isBusy || !canUpdateWebhook}
            onChange={(checked) => setSettingsForm((current) => ({ ...current, reconcileEnabled: checked }))}
          />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">
              Interval seconds
            </span>
            <input
              type="number"
              min={10}
              max={3600}
              value={settingsForm.reconcileIntervalSeconds}
              onChange={(event) => setSettingsForm((current) => ({
                ...current,
                reconcileIntervalSeconds: event.target.value,
              }))}
              className="input mt-1.5"
              disabled={isBusy || !canUpdateWebhook}
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">
              Mode
            </span>
            <select
              value={settingsForm.reconcileMode}
              onChange={(event) => setSettingsForm((current) => ({
                ...current,
                reconcileMode: event.target.value as 'incremental' | 'full_reset',
              }))}
              className="input mt-1.5"
              disabled={isBusy || !canUpdateWebhook}
            >
              <option value="incremental">Incremental</option>
              <option value="full_reset">Full reset</option>
            </select>
          </label>
        </div>

        {canUpdateWebhook ? (
          <button
            type="button"
            onClick={() => onSaveSettings({
              enabled: settingsForm.enabled,
              autoCancelEnabled: settingsForm.autoCancelEnabled,
              reconcileEnabled: settingsForm.reconcileEnabled,
              reconcileIntervalSeconds,
              reconcileMode: settingsForm.reconcileMode,
            })}
            disabled={isBusy || !canSaveSettings}
            className="btn btn-sm btn-primary btn-icon mt-3 w-full"
          >
            <RefreshCw className={`h-3 w-3 ${isSavingSettings ? 'animate-spin' : ''}`} />
            {isSavingSettings ? 'Saving' : 'Save receiver'}
          </button>
        ) : null}
      </div>

      <div className="rounded-2xl border border-[#dce4ea] bg-white p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">
            Relay settings
          </p>
          <span className={webhook.relayHasApiKey ? 'pill pill-success' : 'pill pill-white'}>
            {webhook.relayHasApiKey ? `Key set${webhook.relayKeyLast4 ? ` • ${webhook.relayKeyLast4}` : ''}` : 'No relay key'}
          </span>
        </div>

        <div className="mt-3 grid gap-2">
          <ToggleRow
            label="Relay"
            checked={relayForm.enabled}
            disabled={isBusy || !canUpdateWebhook}
            onChange={(checked) => setRelayForm((current) => ({ ...current, enabled: checked }))}
          />
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">
              Relay URL
            </span>
            <input
              value={relayForm.webhookUrl}
              onChange={(event) => setRelayForm((current) => ({
                ...current,
                webhookUrl: event.target.value,
              }))}
              className="input mt-1.5"
              placeholder="https://example.com/webhook"
              disabled={isBusy || !canUpdateWebhook}
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">
              Header key
            </span>
            <input
              value={relayForm.headerKey}
              onChange={(event) => setRelayForm((current) => ({
                ...current,
                headerKey: event.target.value,
              }))}
              className="input mt-1.5"
              placeholder="x-api-key"
              disabled={isBusy || !canUpdateWebhook}
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8193a0]">
              API key
            </span>
            <input
              value={relayForm.apiKey}
              onChange={(event) => setRelayForm((current) => ({
                ...current,
                apiKey: event.target.value,
              }))}
              className="input mt-1.5"
              placeholder={webhook.relayHasApiKey ? 'Leave blank to keep current key' : 'Required when relay is enabled'}
              disabled={isBusy || !canUpdateWebhook}
            />
          </label>
        </div>

        {canUpdateWebhook ? (
          <button
            type="button"
            onClick={() => onSaveRelay({
              enabled: relayForm.enabled,
              webhookUrl: relayForm.webhookUrl.trim() || undefined,
              headerKey: relayForm.headerKey.trim() || undefined,
              apiKey: relayForm.apiKey.trim() || undefined,
            })}
            disabled={isBusy}
            className="btn btn-sm btn-primary btn-icon mt-3 w-full"
          >
            <RefreshCw className={`h-3 w-3 ${isSavingRelay ? 'animate-spin' : ''}`} />
            {isSavingRelay ? 'Saving' : 'Save relay'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-[14px] border border-[#dce4ea] bg-[#fbfcfc] px-3 py-2.5 text-[12.5px] font-semibold text-primary">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-[#12384b]"
      />
    </label>
  );
}

function WebhookLogList({ logs }: { logs: PartnerWebhookLog[] }) {
  if (logs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[#d7e0e7] bg-[#fbfcfc] px-4 py-8 text-center">
        <Activity className="mx-auto h-7 w-7 text-[#8aa0ad]" />
        <p className="mt-2 text-sm font-semibold text-primary">No webhook traffic yet</p>
        <p className="mt-1 text-[12.5px] text-[#6f8290]">Incoming Pancake events will appear here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {logs.map((log) => (
        <div key={log.id} className="rounded-2xl border border-[#dce4ea] bg-[#fbfcfc] px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[12.5px] font-semibold text-primary">{log.requestId}</p>
              <p className="mt-0.5 text-[11px] text-[#7c8f9b]">
                {formatTenantDateTime(log.receivedAt)}
              </p>
            </div>
            <span className={getWebhookStatusClassName(log.processStatus, log.errorMessage)}>
              {log.errorMessage ? 'Issue' : log.processStatus}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-[#5f7483]">
            <span>{log.orderCount.toLocaleString()} orders</span>
            <span>{log.upsertedCount.toLocaleString()} upserted</span>
            <span>{log.warningCount.toLocaleString()} warnings</span>
          </div>
          {log.errorMessage ? (
            <p className="mt-2 line-clamp-2 text-[11.5px] leading-4 text-rose-700">{log.errorMessage}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function MetricTile({
  icon,
  label,
  value,
  meta,
  tone = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: number;
  meta: string;
  tone?: 'neutral' | 'success' | 'warning';
}) {
  const toneClassName =
    tone === 'success'
      ? 'bg-emerald-50 text-emerald-700'
      : tone === 'warning'
        ? 'bg-amber-50 text-amber-700'
        : 'bg-primary text-white';

  return (
    <div className="rounded-[20px] border border-[#dce4ea] bg-white p-4 shadow-[0_18px_36px_-30px_rgba(18,56,75,0.32)]">
      <div className="flex items-center justify-between gap-3">
        <span className={`flex h-9 w-9 items-center justify-center rounded-full ${toneClassName}`}>
          {icon}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">
          {label}
        </span>
      </div>
      <p className="mt-4 text-2xl font-semibold tabular-nums text-primary">{value.toLocaleString()}</p>
      <p className="mt-1 text-[12px] text-[#6f8290]">{meta}</p>
    </div>
  );
}

function StatusLine({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  const toneClassName =
    tone === 'success'
      ? 'bg-emerald-50 text-emerald-700'
      : tone === 'warning'
        ? 'bg-amber-50 text-amber-700'
        : tone === 'danger'
          ? 'bg-rose-50 text-rose-700'
          : 'bg-[#eef2f5] text-[#4d6677]';

  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-[#dce4ea] bg-white px-3.5 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${toneClassName}`}>
          {icon}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8193a0]">
          {label}
        </span>
      </div>
      <span className="truncate text-right text-[12.5px] font-semibold text-primary" title={value}>
        {value}
      </span>
    </div>
  );
}

function InlineCount({ icon, value, label }: { icon: ReactNode; value: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {icon}
      <span className="font-semibold tabular-nums text-primary">{value.toLocaleString()}</span>
      {label}
    </span>
  );
}

function HeaderCell({ children }: { children: ReactNode }) {
  return (
    <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-[0.18em] text-[#5f7483]">
      {children}
    </th>
  );
}

function BodyCell({ children }: { children: ReactNode }) {
  return <td className="border-b border-[#edf2f6] px-4 py-3 align-middle">{children}</td>;
}

type IntegrationAccess = {
  canRead: boolean;
  canWrite: boolean;
  canEdit: boolean;
  canSync: boolean;
  canWebhookUpdate: boolean;
  canWebhookRotate: boolean;
  isReadOnly: boolean;
};

function buildIntegrationAccess(
  role: string | null | undefined,
  permissions: readonly string[],
): IntegrationAccess {
  const canRead = hasAnyAdminPermission(role, permissions, WMS_INTEGRATIONS_READ_PERMISSIONS);
  const canWrite = hasAnyAdminPermission(role, permissions, WMS_INTEGRATIONS_WRITE_PERMISSIONS);
  const canEdit = hasAnyAdminPermission(role, permissions, WMS_INTEGRATIONS_EDIT_PERMISSIONS);
  const canSync = hasAnyAdminPermission(role, permissions, WMS_INTEGRATIONS_SYNC_PERMISSIONS);
  const canWebhookUpdate = hasAnyAdminPermission(
    role,
    permissions,
    WMS_INTEGRATIONS_WEBHOOK_UPDATE_PERMISSIONS,
  );
  const canWebhookRotate = hasAnyAdminPermission(
    role,
    permissions,
    WMS_INTEGRATIONS_WEBHOOK_ROTATE_PERMISSIONS,
  );

  return {
    canRead,
    canWrite,
    canEdit,
    canSync,
    canWebhookUpdate,
    canWebhookRotate,
    isReadOnly: canRead && !canWrite && !canEdit && !canSync && !canWebhookUpdate && !canWebhookRotate,
  };
}

type StoreSyncTarget = 'all' | 'products' | 'tags' | 'warehouses';
type StoreActionTarget = StoreSyncTarget | 'edit' | 'remove';
type StoreStatus = NonNullable<UpdatePartnerPosStoreInput['status']>;

const POS_STORES_PAGE_SIZE = 10;

const STORE_SYNC_LABELS: Record<StoreSyncTarget, string> = {
  all: 'Sync all',
  products: 'Products',
  tags: 'Tags',
  warehouses: 'Warehouses',
};

function getStoreActionKey(storeId: string, target: StoreActionTarget) {
  return `${storeId}:${target}`;
}

function getStoreSyncLabel(target: StoreSyncTarget) {
  return STORE_SYNC_LABELS[target];
}

function summarizeStoreRemovalResult(
  store: PartnerPosStoreIntegration,
  result: unknown,
) {
  const payload = typeof result === 'object' && result !== null
    ? result as {
        deletedPosOrders?: number;
        deletedIntegrationId?: string | null;
      }
    : null;

  const deletedOrders = payload?.deletedPosOrders ?? 0;
  const removedIntegration = Boolean(payload?.deletedIntegrationId);

  return `${store.name} removed. Deleted ${deletedOrders.toLocaleString()} POS orders${removedIntegration ? ' and pruned the orphan integration connection' : ''}.`;
}

function normalizeStoreStatus(status: string): StoreStatus {
  if (status === 'PENDING' || status === 'ERROR' || status === 'DISABLED') {
    return status;
  }

  return 'ACTIVE';
}

function parseApiKeys(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function summarizeBulkImportResult(result: unknown) {
  const summary = getBulkImportSummary(result);

  if (!summary) {
    return 'POS store import finished.';
  }

  return [
    'POS store import finished:',
    `${summary.created.toLocaleString()} created`,
    `${summary.skipped.toLocaleString()} skipped`,
    `${summary.failed.toLocaleString()} failed`,
  ].join(' ');
}

function getBulkImportSummary(result: unknown) {
  if (!result || typeof result !== 'object' || !('summary' in result)) {
    return null;
  }

  const summary = (result as { summary?: unknown }).summary;
  if (!summary || typeof summary !== 'object') {
    return null;
  }

  const created = Number((summary as { created?: unknown }).created);
  const skipped = Number((summary as { skipped?: unknown }).skipped);
  const failed = Number((summary as { failed?: unknown }).failed);

  if (!Number.isFinite(created) || !Number.isFinite(skipped) || !Number.isFinite(failed)) {
    return null;
  }

  return {
    created,
    skipped,
    failed,
  };
}

function getRotatedWebhookApiKey(result: unknown) {
  if (
    result
    && typeof result === 'object'
    && 'apiKey' in result
    && typeof (result as { apiKey?: unknown }).apiKey === 'string'
  ) {
    return (result as { apiKey: string }).apiKey;
  }

  return '';
}

function getIntegrationStatusClassName(status: string) {
  const normalized = status.toUpperCase();

  if (normalized === 'ACTIVE') {
    return 'pill pill-success';
  }

  if (normalized === 'PENDING') {
    return 'pill pill-warning';
  }

  if (normalized === 'ERROR' || normalized === 'FAILED') {
    return 'pill pill-destructive';
  }

  return 'pill pill-white';
}

function getWebhookStatusClassName(status: string, errorMessage: string | null) {
  const normalized = status.toUpperCase();

  if (errorMessage || normalized === 'FAILED' || normalized === 'ERROR') {
    return 'pill pill-destructive';
  }

  if (normalized === 'PROCESSED' || normalized === 'SUCCESS') {
    return 'pill pill-success';
  }

  if (normalized === 'SKIPPED') {
    return 'pill pill-warning';
  }

  return 'pill pill-white';
}

function getErrorMessage(error: unknown, fallback: string) {
  const message = getResponseErrorMessage(error);

  if (message) {
    return message;
  }

  return fallback;
}

function getResponseErrorMessage(error: unknown) {
  if (
    typeof error === 'object'
    && error !== null
    && 'response' in error
    && typeof (error as { response?: unknown }).response === 'object'
    && (error as { response?: { data?: unknown } }).response?.data
    && typeof (error as { response?: { data?: { message?: unknown } } }).response?.data?.message === 'string'
  ) {
    return (error as { response?: { data?: { message?: string } } }).response?.data?.message ?? null;
  }

  if (
    typeof error === 'object'
    && error !== null
    && 'response' in error
    && typeof (error as { response?: unknown }).response === 'object'
    && Array.isArray((error as { response?: { data?: { message?: unknown } } }).response?.data?.message)
  ) {
    return (error as { response?: { data?: { message?: string[] } } }).response?.data?.message?.join(', ') ?? null;
  }

  return null;
}

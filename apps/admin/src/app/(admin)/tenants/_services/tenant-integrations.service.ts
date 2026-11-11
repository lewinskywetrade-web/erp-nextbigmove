import apiClient from '@/lib/api-client';
import type {
  BulkImportPartnerPosStoresInput,
  PartnerIntegrationActionResponse,
  PartnerIntegrationOverview,
  UpdatePartnerPosStoreInput,
  UpdatePartnerWebhookInput,
  UpdatePartnerWebhookRelayInput,
} from '../_types/tenant-integrations';

export async function fetchPartnerIntegrationOverview(tenantId: string) {
  const response = await apiClient.get(`/wms/partners/${tenantId}/integrations`, {
    params: { tenantId },
  });

  return response.data as PartnerIntegrationOverview;
}

export async function bulkImportPartnerPosStores(
  tenantId: string,
  input: BulkImportPartnerPosStoresInput,
) {
  const response = await apiClient.post(
    `/wms/partners/${tenantId}/integrations/pos-stores/bulk-import`,
    input,
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

export async function syncPartnerPosStoreProducts(tenantId: string, storeId: string) {
  const response = await apiClient.post(
    `/wms/partners/${tenantId}/integrations/pos-stores/${storeId}/sync-products`,
    {},
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

export async function syncPartnerPosStoreTags(tenantId: string, storeId: string) {
  const response = await apiClient.post(
    `/wms/partners/${tenantId}/integrations/pos-stores/${storeId}/sync-tags`,
    {},
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

export async function syncPartnerPosStoreWarehouses(tenantId: string, storeId: string) {
  const response = await apiClient.post(
    `/wms/partners/${tenantId}/integrations/pos-stores/${storeId}/sync-warehouses`,
    {},
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

export async function syncPartnerPosStoreOrders(tenantId: string, storeId: string) {
  const response = await apiClient.post(
    `/wms/partners/${tenantId}/integrations/pos-stores/${storeId}/sync-orders`,
    {},
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

export async function syncPartnerPosStoreAll(tenantId: string, storeId: string) {
  const response = await apiClient.post(
    `/wms/partners/${tenantId}/integrations/pos-stores/${storeId}/sync-all`,
    {},
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

export async function updatePartnerPosStore(
  tenantId: string,
  storeId: string,
  input: UpdatePartnerPosStoreInput,
) {
  const response = await apiClient.patch(
    `/wms/partners/${tenantId}/integrations/pos-stores/${storeId}`,
    input,
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

export async function removePartnerPosStore(tenantId: string, storeId: string) {
  const response = await apiClient.delete(
    `/wms/partners/${tenantId}/integrations/pos-stores/${storeId}`,
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

export async function updatePartnerWebhook(
  tenantId: string,
  input: UpdatePartnerWebhookInput,
) {
  const response = await apiClient.patch(
    `/wms/partners/${tenantId}/integrations/webhook`,
    input,
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

export async function rotatePartnerWebhookApiKey(tenantId: string) {
  const response = await apiClient.post(
    `/wms/partners/${tenantId}/integrations/webhook/rotate-key`,
    {},
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

export async function updatePartnerWebhookRelay(
  tenantId: string,
  input: UpdatePartnerWebhookRelayInput,
) {
  const response = await apiClient.patch(
    `/wms/partners/${tenantId}/integrations/webhook/relay`,
    input,
    { params: { tenantId } },
  );

  return response.data as PartnerIntegrationActionResponse;
}

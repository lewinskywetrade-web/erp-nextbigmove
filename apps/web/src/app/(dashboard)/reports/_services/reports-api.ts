import apiClient from '@/lib/api-client';
import type {
  ErpDailyInventoryReportResponse,
  ErpDailyInventorySubscription,
  PosOrdersReportResponse,
} from '../_types/reports';

export async function fetchPosOrdersReport(
  params: URLSearchParams,
): Promise<PosOrdersReportResponse> {
  const response = await apiClient.get<PosOrdersReportResponse>(
    `/reports/pos-orders-summary?${params.toString()}`,
  );
  return response.data;
}

export async function fetchErpDailyInventoryReport(params: {
  startDate: string;
  endDate: string;
  storeIds?: string[];
}): Promise<ErpDailyInventoryReportResponse> {
  const response = await apiClient.get<ErpDailyInventoryReportResponse>(
    '/reports/daily-inventory-movements',
    {
      params: {
        startDate: params.startDate,
        endDate: params.endDate,
        ...(params.storeIds && params.storeIds.length > 0
          ? { storeIds: params.storeIds.join(',') }
          : {}),
      },
    },
  );
  return response.data;
}

export async function updateErpDailyInventorySubscription(input: {
  enabled?: boolean;
  recipients?: string[];
  sendTimeManila?: string;
}): Promise<{ subscription: ErpDailyInventorySubscription }> {
  const response = await apiClient.patch<{ subscription: ErpDailyInventorySubscription }>(
    '/reports/daily-inventory-subscription',
    input,
  );
  return response.data;
}

export async function sendErpDailyInventoryEmailNow(input: {
  startDate: string;
  endDate: string;
  recipients?: string[];
}) {
  const response = await apiClient.post('/reports/daily-inventory-send', input);
  return response.data as {
    clientName: string;
    recipients: string[];
    subject: string;
    sentAt: string;
    subscription: ErpDailyInventorySubscription;
  };
}

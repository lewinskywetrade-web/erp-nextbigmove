import apiClient from '@/lib/api-client';
import type {
  ClientDailyInventoryEmailSubscription,
  DailyInventoryMovementsReportResponse,
  MonthEndStockReportResponse,
  SendDailyInventoryEmailResponse,
} from '../_types/month-end-stock-report';

export async function fetchMonthEndStockReport(params: {
  tenantIds: string[];
  storeIds: string[];
}) {
  const response = await apiClient.get('/wms/reports/month-end-stock', {
    params: {
      ...(params.tenantIds.length ? { tenantIds: params.tenantIds.join(',') } : {}),
      ...(params.storeIds.length ? { storeIds: params.storeIds.join(',') } : {}),
    },
  });

  return response.data as MonthEndStockReportResponse;
}

export async function fetchDailyInventoryMovementsReport(params: {
  startDate?: string;
  endDate?: string;
  tenantIds: string[];
  storeIds: string[];
}) {
  const response = await apiClient.get('/wms/reports/daily-inventory-movements', {
    params: {
      ...(params.startDate ? { startDate: params.startDate } : {}),
      ...(params.endDate ? { endDate: params.endDate } : {}),
      ...(params.tenantIds.length ? { tenantIds: params.tenantIds.join(',') } : {}),
      ...(params.storeIds.length ? { storeIds: params.storeIds.join(',') } : {}),
    },
  });

  return response.data as DailyInventoryMovementsReportResponse;
}

export async function updateDailyInventoryEmailSubscription(input: {
  tenantId: string;
  enabled?: boolean;
  recipients?: string[];
  sendTimeManila?: string;
}) {
  const response = await apiClient.patch('/wms/reports/daily-inventory-subscription', input);
  return response.data as { subscription: ClientDailyInventoryEmailSubscription };
}

export async function sendDailyInventoryEmailNow(input: {
  tenantId: string;
  startDate?: string;
  endDate?: string;
  recipients?: string[];
}) {
  const response = await apiClient.post('/wms/reports/daily-inventory-send', input);
  return response.data as SendDailyInventoryEmailResponse;
}

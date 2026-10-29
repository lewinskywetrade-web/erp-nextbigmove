export const PANCAKE_WEBHOOK_QUEUE = 'pancake-webhook';
export const PANCAKE_WEBHOOK_JOB = 'ingest';
export const PANCAKE_WEBHOOK_AUTO_CANCEL_JOB = 'auto-cancel-status';
export const PANCAKE_WEBHOOK_REPORTS_HYDRATE_JOB = 'hydrate-reports-by-phone';
export const PANCAKE_WEBHOOK_RECONCILE_QUEUE = 'pancake-webhook-reconcile';
export const PANCAKE_WEBHOOK_RECONCILE_JOB = 'reconcile-day';
export const POS_ORDER_RECOVERY_QUEUE = 'pos-order-sync-recovery';
export const POS_ORDER_RECOVERY_JOB = 'refresh-order';

export interface PosOrderRecoveryJobData {
  recoveryId: string;
}

export interface PancakeWebhookJobData {
  logId: string;
  requestId: string;
  tenantId: string;
  payload: any;
}

export interface PancakeWebhookReconcileJobData {
  tenantId: string;
  teamId: string | null;
  dateLocal: string;
  reconcileMode?: 'incremental' | 'full_reset';
  trigger?: 'standard' | 'destructive_order_change';
  scheduledFor?: string;
  requestId?: string;
  logId?: string;
}

export interface PancakeWebhookAutoCancelJobData {
  tenantId: string;
  shopId: string;
  orderId: string;
  reportsByPhoneOrderFail: number | null;
  reportsByPhoneOrderSuccess: number | null;
  reportsByPhoneWarning: number | null;
  requestId?: string;
  logId?: string;
}

export interface PancakeWebhookReportsHydrateJobData {
  tenantId: string;
  shopId: string;
  orderId: string;
  customerPhone: string;
  requestId?: string;
  logId?: string;
}

export type WmsPurchasingRequestType = 'PROCUREMENT' | 'SELF_BUY';

export type WmsInvoiceSourceType = 'MANUAL' | 'MANUAL_RECEIVING' | 'PROCUREMENT';

export type WmsInvoiceStatus =
  | 'DRAFT'
  | 'ISSUED'
  | 'PAID_PENDING_VERIFY'
  | 'PAID_VERIFIED'
  | 'CANCELED';

export type WmsLinkedInvoiceSummary = {
  id: string;
  sourceType: WmsInvoiceSourceType;
  status: WmsInvoiceStatus;
  invoiceNumber: string;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: number;
  amountDue: number;
};

export type WmsPurchasingBatchStatus =
  | 'UNDER_REVIEW'
  | 'REVISION'
  | 'AWAITING_PRODUCTS'
  | 'SHIPPED'
  | 'RECEIVING_EXCEPTION'
  | 'PENDING_PAYMENT'
  | 'PAYMENT_REVIEW'
  | 'RECEIVING_READY'
  | 'RECEIVING'
  | 'STOCKED'
  | 'REJECTED'
  | 'CANCELED';

export type WmsPurchasingBatchRow = {
  id: string;
  requestType: WmsPurchasingRequestType;
  status: WmsPurchasingBatchStatus;
  sourceType: string;
  sourceRequestId: string | null;
  sourceStatus: string | null;
  requestTitle: string | null;
  store: {
    id: string;
    name: string;
  };
  lineCount: number;
  requestedQuantity: number;
  approvedQuantity: number;
  receivedQuantity: number;
  invoiceNumber: string | null;
  invoiceAmount: number | null;
  paymentProofImageUrl: string | null;
  paymentSubmittedAt: string | null;
  paymentProofSubmittedAt: string | null;
  paymentVerifiedAt: string | null;
  readyForReceivingAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WmsPurchasingBatchDetail = WmsPurchasingBatchRow & {
  sourceRequestType: number | null;
  sourceSnapshot: Record<string, unknown> | null;
  partnerNotes: string | null;
  wmsNotes: string | null;
  invoice: {
    number: string | null;
    amount: number | null;
    linked: WmsLinkedInvoiceSummary | null;
    bankDetails: {
      warehouseId: string | null;
      warehouseCode: string | null;
      warehouseName: string | null;
      billingCompanyName: string | null;
      billingAddress: string | null;
      bankName: string | null;
      bankAccountName: string | null;
      bankAccountNumber: string | null;
      bankAccountType: string | null;
      bankBranch: string | null;
      paymentInstructions: string | null;
    } | null;
    billTo?: {
      tenantId: string;
      tenantName: string;
      tenantSlug: string;
      companyName: string;
      billingAddress: string | null;
    };
  };
  paymentProofSubmittedBy: {
    id: string;
    name: string;
    email: string;
  } | null;
  lines: Array<{
    id: string;
    lineNo: number;
    sourceItemId: string | null;
    sourceSnapshot: Record<string, unknown> | null;
    productId: string | null;
    variationId: string | null;
    requestedProductName: string | null;
    uom: string | null;
    requestedQuantity: number;
    approvedQuantity: number | null;
    receivedQuantity: number;
    partnerUnitCost: number | null;
    needsProfiling: boolean;
    resolvedPosProduct: {
      id: string;
      name: string;
      customId: string | null;
    } | null;
    resolvedProfile: {
      id: string;
      status: string;
      isSerialized: boolean;
    } | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  events: Array<{
    id: string;
    eventType: string;
    fromStatus: WmsPurchasingBatchStatus | null;
    toStatus: WmsPurchasingBatchStatus | null;
    message: string | null;
    payload: Record<string, unknown> | null;
    actor: {
      id: string;
      name: string;
      email: string;
    } | null;
    createdAt: string;
  }>;
};

export type WmsPurchasingOverviewResponse = {
  tenantReady: boolean;
  summary: {
    batches: number;
    procurement: number;
    selfBuy: number;
    readyForReceiving: number;
    underReview: number;
  };
  filters: {
    tenants: Array<{
      id: string;
      label: string;
      slug: string;
      status: string;
    }>;
    stores: Array<{
      id: string;
      label: string;
      batchCount: number;
    }>;
    requestTypes: Array<{
      value: WmsPurchasingRequestType;
      label: string;
      batchCount: number;
    }>;
    statuses: Array<{
      value: WmsPurchasingBatchStatus;
      label: string;
      batchCount: number;
    }>;
    activeTenantId: string | null;
    activeStoreId: string | null;
    activeRequestType: WmsPurchasingRequestType | null;
    activeStatus: WmsPurchasingBatchStatus | null;
  };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  batches: WmsPurchasingBatchRow[];
};

export type GetWmsPurchasingOverviewParams = {
  tenantId?: string;
  storeId?: string;
  requestType?: WmsPurchasingRequestType;
  status?: WmsPurchasingBatchStatus;
  search?: string;
  page?: number;
  pageSize?: number;
};

export type GetWmsPurchasingProductOptionsParams = {
  tenantId?: string;
  storeId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
};

export type WmsPurchasingProductOption = {
  profileId: string;
  posProductId: string;
  status: 'DEFAULT' | 'READY' | 'ARCHIVED';
  isSerialized: boolean;
  productId: string;
  variationId: string;
  variationDisplayId: string | null;
  productCustomId: string | null;
  name: string;
  retailPrice: number | null;
  partnerUnitCost: number | null;
  store: {
    id: string;
    name: string;
  };
};

export type WmsPurchasingProductOptionsResponse = {
  tenantReady: boolean;
  filters: {
    tenants: Array<{
      id: string;
      label: string;
      slug: string;
      status: string;
    }>;
    stores: Array<{
      id: string;
      label: string;
    }>;
    activeTenantId: string | null;
    activeStoreId: string | null;
  };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  products: WmsPurchasingProductOption[];
};

export type CreateWmsPurchasingBatchLineInput = {
  lineNo?: number;
  sourceItemId?: string;
  sourceSnapshot?: Record<string, unknown>;
  productId?: string;
  variationId?: string;
  storeId?: string;
  requestedProductName?: string;
  uom?: string;
  requestedQuantity: number;
  approvedQuantity?: number;
  partnerUnitCost?: number;
  needsProfiling?: boolean;
  resolvedPosProductId?: string;
  resolvedProfileId?: string;
  notes?: string;
};

export type CreateWmsPurchasingBatchInput = {
  storeId: string;
  teamId?: string;
  requestType: WmsPurchasingRequestType;
  sourceType?: 'ERP_REQUEST' | 'MANUAL_WMS';
  sourceRequestId?: string;
  sourceRequestType?: number;
  sourceStatus?: string;
  sourceSnapshot?: Record<string, unknown>;
  requestTitle?: string;
  partnerNotes?: string;
  wmsNotes?: string;
  invoiceNumber?: string;
  invoiceAmount?: number;
  paymentSubmittedAt?: string;
  paymentProofImageUrl?: string;
  paymentProofAssetId?: string;
  paymentVerifiedAt?: string;
  lines: CreateWmsPurchasingBatchLineInput[];
};

export type WmsInvoiceDetail = {
  id: string;
  tenantId: string;
  sourceType: WmsInvoiceSourceType;
  sourceRefId: string | null;
  sourceRefCode: string | null;
  status: WmsInvoiceStatus;
  invoiceNumber: string;
  issueDate: string | null;
  dueDate: string | null;
  currency: string;
  notes: string | null;
  lineCount: number;
  totalQuantity: number;
  totalAmount: number;
  amountDue: number;
  createdAt: string;
  updatedAt: string;
  issuer: Record<string, unknown>;
  billTo: Record<string, unknown>;
  totals: {
    lineCount: number | null;
    totalQuantity: number | null;
    subtotal: number | null;
    totalAmount: number | null;
    amountDue: number | null;
  };
  lines: Array<{
    id: string;
    lineNo: number;
    storeId: string | null;
    store: {
      id: string;
      name: string;
    } | null;
    productId: string | null;
    variationId: string | null;
    description: string;
    quantity: number;
    unitRate: number;
    amount: number;
    rateSource: string | null;
    lineSnapshot: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type WmsInvoiceDocumentResponse = {
  invoice: WmsInvoiceDetail;
  document: {
    title: string;
    tenant: {
      id: string;
      name: string;
      slug: string;
    };
    issuer: Record<string, unknown> & {
      logoUrl?: string | null;
    };
    billTo: Record<string, unknown>;
    payment: {
      bankName: string | null;
      bankAccountName: string | null;
      bankAccountNumber: string | null;
      bankAccountType: string | null;
      bankBranch: string | null;
      paymentInstructions: string | null;
      footerNotes: string | null;
    };
    source: {
      type: WmsInvoiceSourceType;
      referenceCode: string | null;
    };
    generatedAt: string;
  };
};

export type SubmitWmsPurchasingPaymentProofInput = {
  paymentProofImageUrl?: string;
  paymentProofAssetId?: string;
  message?: string;
};

export type UploadedWmsPurchasingProofImage = {
  assetId: string;
  imageUrl: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  originalFileName: string | null;
};

export type MarkWmsSelfBuyShipmentInput = {
  shipmentReference?: string;
  message?: string;
};

export type RespondWmsPurchasingRevisionInput = {
  decision: 'ACCEPT' | 'REJECT';
  message?: string;
};

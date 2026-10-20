import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationDomain,
  NotificationSystem,
  Prisma,
  TenantStatus,
  WmsInvoiceLineType,
  WmsInvoiceSourceType,
  WmsInvoiceStatus,
  WmsPurchasingBatchStatus,
  WmsProductProfileStatus,
  WmsPurchasingRequestType,
  WmsPurchasingSourceType,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MediaAssetsService, type UploadedImageFile } from '../../common/services/media-assets.service';
import { NotificationStateService } from '../../common/services/notification-state.service';
import { WorkflowExecutionGateway } from '../workflows/gateways/workflow-execution.gateway';
import { WmsCogsSyncService } from '../product-cogs/wms-cogs-sync.service';
import {
  CreateWmsPurchasingBatchDto,
  type CreateWmsPurchasingBatchLineInput,
} from './dto/create-wms-purchasing-batch.dto';
import {
  CreateWmsInvoiceDto,
  type CreateWmsInvoiceLineInput,
} from './dto/create-wms-invoice.dto';
import { GetWmsInvoicesOverviewDto } from './dto/get-wms-invoices-overview.dto';
import { GetWmsPurchasingOverviewDto } from './dto/get-wms-purchasing-overview.dto';
import { GetWmsPurchasingProductOptionsDto } from './dto/get-wms-purchasing-product-options.dto';
import { MarkWmsSelfBuyShipmentDto } from './dto/mark-wms-self-buy-shipment.dto';
import { RespondWmsPurchasingRevisionDto } from './dto/respond-wms-purchasing-revision.dto';
import { SubmitWmsPurchasingPaymentProofDto } from './dto/submit-wms-purchasing-payment-proof.dto';
import { UpdateWmsInvoiceDto, type UpdateWmsInvoiceLineInput } from './dto/update-wms-invoice.dto';
import { UpdateWmsInvoiceStatusDto } from './dto/update-wms-invoice-status.dto';
import { UpdateWmsPurchasingLineDto } from './dto/update-wms-purchasing-line.dto';
import { UpdateWmsPurchasingStatusDto } from './dto/update-wms-purchasing-status.dto';

const REQUEST_TYPE_ORDER: WmsPurchasingRequestType[] = [
  WmsPurchasingRequestType.PROCUREMENT,
  WmsPurchasingRequestType.SELF_BUY,
];

const STATUS_ORDER: WmsPurchasingBatchStatus[] = [
  WmsPurchasingBatchStatus.UNDER_REVIEW,
  WmsPurchasingBatchStatus.REVISION,
  WmsPurchasingBatchStatus.AWAITING_PRODUCTS,
  WmsPurchasingBatchStatus.SHIPPED,
  WmsPurchasingBatchStatus.RECEIVING_EXCEPTION,
  WmsPurchasingBatchStatus.PENDING_PAYMENT,
  WmsPurchasingBatchStatus.PAYMENT_REVIEW,
  WmsPurchasingBatchStatus.RECEIVING_READY,
  WmsPurchasingBatchStatus.RECEIVING,
  WmsPurchasingBatchStatus.STOCKED,
  WmsPurchasingBatchStatus.REJECTED,
  WmsPurchasingBatchStatus.CANCELED,
];

const INVOICE_SOURCE_ORDER: WmsInvoiceSourceType[] = [
  WmsInvoiceSourceType.MANUAL,
  WmsInvoiceSourceType.MANUAL_RECEIVING,
  WmsInvoiceSourceType.PROCUREMENT,
];

const INVOICE_STATUS_ORDER: WmsInvoiceStatus[] = [
  WmsInvoiceStatus.DRAFT,
  WmsInvoiceStatus.ISSUED,
  WmsInvoiceStatus.PAID_PENDING_VERIFY,
  WmsInvoiceStatus.PAID_VERIFIED,
  WmsInvoiceStatus.CANCELED,
];

const INVOICE_STATUS_TRANSITIONS: Record<WmsInvoiceStatus, readonly WmsInvoiceStatus[]> = {
  [WmsInvoiceStatus.DRAFT]: [WmsInvoiceStatus.ISSUED, WmsInvoiceStatus.CANCELED],
  [WmsInvoiceStatus.ISSUED]: [
    WmsInvoiceStatus.PAID_PENDING_VERIFY,
    WmsInvoiceStatus.PAID_VERIFIED,
    WmsInvoiceStatus.CANCELED,
  ],
  [WmsInvoiceStatus.PAID_PENDING_VERIFY]: [
    WmsInvoiceStatus.ISSUED,
    WmsInvoiceStatus.PAID_VERIFIED,
    WmsInvoiceStatus.CANCELED,
  ],
  [WmsInvoiceStatus.PAID_VERIFIED]: [],
  [WmsInvoiceStatus.CANCELED]: [],
};
const ACTIVE_WMS_TENANT_STATUSES = [TenantStatus.ACTIVE, TenantStatus.TRIAL] as const;

const GLOBAL_WMS_INVOICE_SETTINGS_SCOPE = 'GLOBAL';
const MANUAL_INVOICE_VAT_RATE = 12;

const PROCUREMENT_STATUS_TRANSITIONS: Record<
  WmsPurchasingBatchStatus,
  readonly WmsPurchasingBatchStatus[]
> = {
  [WmsPurchasingBatchStatus.UNDER_REVIEW]: [
    WmsPurchasingBatchStatus.PENDING_PAYMENT,
    WmsPurchasingBatchStatus.CANCELED,
  ],
  [WmsPurchasingBatchStatus.REVISION]: [
    WmsPurchasingBatchStatus.PENDING_PAYMENT,
    WmsPurchasingBatchStatus.REJECTED,
    WmsPurchasingBatchStatus.CANCELED,
  ],
  [WmsPurchasingBatchStatus.AWAITING_PRODUCTS]: [],
  [WmsPurchasingBatchStatus.SHIPPED]: [],
  [WmsPurchasingBatchStatus.RECEIVING_EXCEPTION]: [],
  [WmsPurchasingBatchStatus.PENDING_PAYMENT]: [],
  [WmsPurchasingBatchStatus.PAYMENT_REVIEW]: [
    WmsPurchasingBatchStatus.PENDING_PAYMENT,
    WmsPurchasingBatchStatus.RECEIVING_READY,
    WmsPurchasingBatchStatus.REJECTED,
    WmsPurchasingBatchStatus.CANCELED,
  ],
  [WmsPurchasingBatchStatus.RECEIVING_READY]: [],
  [WmsPurchasingBatchStatus.RECEIVING]: [
    WmsPurchasingBatchStatus.STOCKED,
    WmsPurchasingBatchStatus.CANCELED,
  ],
  [WmsPurchasingBatchStatus.STOCKED]: [],
  [WmsPurchasingBatchStatus.REJECTED]: [],
  [WmsPurchasingBatchStatus.CANCELED]: [],
};

const SELF_BUY_STATUS_TRANSITIONS: Record<
  WmsPurchasingBatchStatus,
  readonly WmsPurchasingBatchStatus[]
> = {
  [WmsPurchasingBatchStatus.UNDER_REVIEW]: [
    WmsPurchasingBatchStatus.AWAITING_PRODUCTS,
    WmsPurchasingBatchStatus.CANCELED,
  ],
  [WmsPurchasingBatchStatus.REVISION]: [
    WmsPurchasingBatchStatus.AWAITING_PRODUCTS,
    WmsPurchasingBatchStatus.REJECTED,
    WmsPurchasingBatchStatus.CANCELED,
  ],
  [WmsPurchasingBatchStatus.AWAITING_PRODUCTS]: [],
  [WmsPurchasingBatchStatus.SHIPPED]: [
    WmsPurchasingBatchStatus.RECEIVING_EXCEPTION,
    WmsPurchasingBatchStatus.CANCELED,
  ],
  [WmsPurchasingBatchStatus.RECEIVING_EXCEPTION]: [
    WmsPurchasingBatchStatus.AWAITING_PRODUCTS,
    WmsPurchasingBatchStatus.CANCELED,
  ],
  [WmsPurchasingBatchStatus.PENDING_PAYMENT]: [],
  [WmsPurchasingBatchStatus.PAYMENT_REVIEW]: [],
  [WmsPurchasingBatchStatus.RECEIVING_READY]: [],
  [WmsPurchasingBatchStatus.RECEIVING]: [
    WmsPurchasingBatchStatus.STOCKED,
    WmsPurchasingBatchStatus.RECEIVING_EXCEPTION,
    WmsPurchasingBatchStatus.CANCELED,
  ],
  [WmsPurchasingBatchStatus.STOCKED]: [],
  [WmsPurchasingBatchStatus.REJECTED]: [],
  [WmsPurchasingBatchStatus.CANCELED]: [],
};

type PurchasingBatchListRecord = Prisma.WmsPurchasingBatchGetPayload<{
  include: {
    store: {
      select: {
        id: true;
        name: true;
        shopName: true;
      };
    };
    lines: {
      select: {
        requestedQuantity: true;
        approvedQuantity: true;
        receivedQuantity: true;
      };
    };
  };
}>;

type PurchasingBatchDetailRecord = Prisma.WmsPurchasingBatchGetPayload<{
  include: {
    tenant: {
      select: {
        id: true;
        name: true;
        slug: true;
        billingCompanyName: true;
        billingAddress: true;
      };
    };
    store: {
      select: {
        id: true;
        name: true;
        shopName: true;
      };
    };
    lines: {
      orderBy: {
        lineNo: 'asc';
      };
      include: {
        resolvedPosProduct: {
          select: {
            id: true;
            name: true;
            customId: true;
            productSnapshot: true;
          };
        };
        resolvedProfile: {
          select: {
            id: true;
            status: true;
            isSerialized: true;
          };
        };
      };
    };
    events: {
      orderBy: {
        createdAt: 'desc';
      };
      include: {
        actor: {
          select: {
            id: true;
            firstName: true;
            lastName: true;
            email: true;
          };
        };
      };
    };
    paymentProofSubmittedBy: {
      select: {
        id: true;
        firstName: true;
        lastName: true;
        email: true;
      };
    };
    paymentProofAsset: {
      select: {
        id: true;
        objectKey: true;
      };
    };
  };
}>;

type InvoiceBankDetailsRecord = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  billingCompanyName: string | null;
  billingAddress: string | null;
  issuerCompanyName: string | null;
  issuerCompanyAddress: string | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankAccountType: string | null;
  bankBranch: string | null;
  paymentInstructions: string | null;
};

type InvoicePaymentProfileSnapshot = {
  id: string | null;
  name: string;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankAccountType: string | null;
  bankBranch: string | null;
  paymentInstructions: string | null;
};

type WmsInvoiceListRecord = Prisma.WmsInvoiceGetPayload<{
  include: {
    lines: {
      select: {
        quantity: true;
        amount: true;
      };
    };
  };
}>;

type WmsInvoiceDetailRecord = Prisma.WmsInvoiceGetPayload<{
  include: {
    lines: {
      orderBy: {
        lineNo: 'asc';
      };
      include: {
        store: {
          select: {
            id: true;
            name: true;
            shopName: true;
          };
        };
      };
    };
  };
}>;

type WmsInvoiceActivityRecord = Prisma.WmsStaffActivityGetPayload<{
  include: {
    actor: {
      select: {
        id: true;
        firstName: true;
        lastName: true;
        email: true;
      };
    };
  };
}>;

type LinkedInvoiceSummary = {
  id: string;
  sourceType: WmsInvoiceSourceType;
  status: WmsInvoiceStatus;
  invoiceNumber: string;
  currency: string;
  issueDate: Date | null;
  dueDate: Date | null;
  totalAmount: number;
  amountDue: number;
};

const INVOICE_MUTABLE_STATUSES = new Set<WmsInvoiceStatus>([WmsInvoiceStatus.DRAFT]);
const INVOICE_EDITABLE_STATUSES = new Set<WmsInvoiceStatus>([
  WmsInvoiceStatus.DRAFT,
  WmsInvoiceStatus.ISSUED,
]);
const INVOICE_REISSUABLE_STATUSES = new Set<WmsInvoiceStatus>([
  WmsInvoiceStatus.ISSUED,
  WmsInvoiceStatus.PAID_PENDING_VERIFY,
  WmsInvoiceStatus.CANCELED,
]);

@Injectable()
export class WmsPurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly mediaAssetsService: MediaAssetsService,
    private readonly notificationStateService: NotificationStateService,
    private readonly workflowExecutionGateway: WorkflowExecutionGateway,
    private readonly wmsCogsSync: WmsCogsSyncService,
  ) {}

  async getOverview(query: GetWmsPurchasingOverviewDto) {
    const scope = await this.resolveTenantScope(query.tenantId);
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(5, query.pageSize ?? 10));

    if (!scope.activeTenantId) {
      return {
        tenantReady: false,
        summary: {
          batches: 0,
          procurement: 0,
          selfBuy: 0,
          readyForReceiving: 0,
          underReview: 0,
        },
        filters: {
          tenants: scope.tenants,
          stores: [],
          requestTypes: REQUEST_TYPE_ORDER.map((type) => ({
            value: type,
            label: this.formatRequestTypeLabel(type),
            batchCount: 0,
          })),
          statuses: STATUS_ORDER.map((status) => ({
            value: status,
            label: this.formatStatusLabel(status),
            batchCount: 0,
          })),
          activeTenantId: null,
          activeStoreId: null,
          activeRequestType: null,
          activeStatus: null,
        },
        pagination: {
          page,
          pageSize,
          total: 0,
          totalPages: 1,
        },
        batches: [],
      };
    }

    const stores = await this.prisma.posStore.findMany({
      where: { tenantId: scope.activeTenantId },
      select: {
        id: true,
        name: true,
        shopName: true,
        _count: {
          select: {
            wmsPurchasingBatches: true,
          },
        },
      },
      orderBy: [{ name: 'asc' }],
    });

    const activeStoreId =
      query.storeId && stores.some((store) => store.id === query.storeId)
        ? query.storeId
        : null;

    const normalizedSearch = this.cleanOptionalText(query.search);
    const storeBatchFilter: Prisma.WmsPurchasingBatchWhereInput = activeStoreId
      ? {
          OR: [
            { storeId: activeStoreId },
            {
              lines: {
                some: {
                  storeId: activeStoreId,
                },
              },
            },
          ],
        }
      : {};

    const summaryAnd: Prisma.WmsPurchasingBatchWhereInput[] = [];
    if (activeStoreId) {
      summaryAnd.push(storeBatchFilter);
    }
    if (normalizedSearch) {
      summaryAnd.push({
        OR: [
          { sourceRequestId: { contains: normalizedSearch, mode: 'insensitive' } },
          { requestTitle: { contains: normalizedSearch, mode: 'insensitive' } },
          { invoiceNumber: { contains: normalizedSearch, mode: 'insensitive' } },
          { store: { name: { contains: normalizedSearch, mode: 'insensitive' } } },
          { store: { shopName: { contains: normalizedSearch, mode: 'insensitive' } } },
          {
            lines: {
              some: {
                OR: [
                  { requestedProductName: { contains: normalizedSearch, mode: 'insensitive' } },
                  { productId: { contains: normalizedSearch, mode: 'insensitive' } },
                  { variationId: { contains: normalizedSearch, mode: 'insensitive' } },
                ],
              },
            },
          },
        ],
      });
    }

    const summaryWhere: Prisma.WmsPurchasingBatchWhereInput = {
      tenantId: scope.activeTenantId,
      ...(query.requestType ? { requestType: query.requestType } : {}),
      ...(summaryAnd.length ? { AND: summaryAnd } : {}),
    };

    const listWhere: Prisma.WmsPurchasingBatchWhereInput = {
      ...summaryWhere,
      ...(query.status ? { status: query.status } : {}),
    };

    const [summaryCounts, listTotal, batches, typeCounts, statusCounts] = await Promise.all([
      this.computeSummaryCounts(summaryWhere),
      this.prisma.wmsPurchasingBatch.count({ where: listWhere }),
      this.prisma.wmsPurchasingBatch.findMany({
        where: listWhere,
        include: {
          store: {
            select: {
              id: true,
              name: true,
              shopName: true,
            },
          },
          lines: {
            select: {
              requestedQuantity: true,
              approvedQuantity: true,
              receivedQuantity: true,
            },
          },
        },
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.wmsPurchasingBatch.groupBy({
        by: ['requestType'],
        where: {
          tenantId: scope.activeTenantId,
          ...storeBatchFilter,
        },
        _count: {
          _all: true,
        },
      }),
      this.prisma.wmsPurchasingBatch.groupBy({
        by: ['status'],
        where: {
          tenantId: scope.activeTenantId,
          ...storeBatchFilter,
        },
        _count: {
          _all: true,
        },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(listTotal / pageSize));
    const typeCountMap = new Map(typeCounts.map((row) => [row.requestType, row._count._all]));
    const statusCountMap = new Map(statusCounts.map((row) => [row.status, row._count._all]));

    return {
      tenantReady: true,
      summary: summaryCounts,
      filters: {
        tenants: scope.tenants,
        stores: stores.map((store) => ({
          id: store.id,
          label: store.shopName || store.name,
          batchCount: store._count.wmsPurchasingBatches,
        })),
        requestTypes: REQUEST_TYPE_ORDER.map((type) => ({
          value: type,
          label: this.formatRequestTypeLabel(type),
          batchCount: typeCountMap.get(type) ?? 0,
        })),
        statuses: STATUS_ORDER.map((status) => ({
          value: status,
          label: this.formatStatusLabel(status),
          batchCount: statusCountMap.get(status) ?? 0,
        })),
        activeTenantId: scope.activeTenantId,
        activeStoreId,
        activeRequestType: query.requestType ?? null,
        activeStatus: query.status ?? null,
      },
      pagination: {
        page,
        pageSize,
        total: listTotal,
        totalPages,
      },
      batches: batches.map((batch) => this.mapBatchListRow(batch)),
    };
  }

  async getUnreadNotificationCount(system: NotificationSystem, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      return { count: 0 };
    }

    return {
      count: await this.notificationStateService.getUnreadCount({
        tenantId: scope.activeTenantId,
        system,
        domain: NotificationDomain.PURCHASING,
      }),
    };
  }

  async getInvoiceOverview(query: GetWmsInvoicesOverviewDto) {
    const scope = await this.resolveTenantScope(query.tenantId);
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(5, query.pageSize ?? 10));

    if (!scope.activeTenantId) {
      return {
        tenantReady: false,
        summary: {
          invoices: 0,
          draft: 0,
          issued: 0,
          paidPendingVerify: 0,
          paidVerified: 0,
          canceled: 0,
          totalBilledAmount: 0,
          totalAmountDue: 0,
          draftAmount: 0,
          issuedAmount: 0,
          paidPendingVerifyAmount: 0,
          paidVerifiedAmount: 0,
          canceledAmount: 0,
        },
        filters: {
          tenants: scope.tenants,
          statuses: INVOICE_STATUS_ORDER.map((status) => ({
            value: status,
            label: this.formatInvoiceStatusLabel(status),
            invoiceCount: 0,
          })),
          sourceTypes: INVOICE_SOURCE_ORDER.map((sourceType) => ({
            value: sourceType,
            label: this.formatInvoiceSourceTypeLabel(sourceType),
            invoiceCount: 0,
          })),
          activeTenantId: null,
          activeStatus: null,
          activeSourceType: null,
        },
        pagination: {
          page,
          pageSize,
          total: 0,
          totalPages: 1,
        },
        invoices: [],
      };
    }

    const normalizedSearch = this.cleanOptionalText(query.search);
    const where: Prisma.WmsInvoiceWhereInput = {
      tenantId: scope.activeTenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(normalizedSearch
        ? {
            OR: [
              { invoiceNumber: { contains: normalizedSearch, mode: 'insensitive' } },
              { sourceRefCode: { contains: normalizedSearch, mode: 'insensitive' } },
              { notes: { contains: normalizedSearch, mode: 'insensitive' } },
              {
                lines: {
                  some: {
                    OR: [
                      { description: { contains: normalizedSearch, mode: 'insensitive' } },
                      { productId: { contains: normalizedSearch, mode: 'insensitive' } },
                      { variationId: { contains: normalizedSearch, mode: 'insensitive' } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [listTotal, invoices, summaryInvoices, statusCounts, sourceTypeCounts] = await Promise.all([
      this.prisma.wmsInvoice.count({ where }),
      this.prisma.wmsInvoice.findMany({
        where,
        include: {
          lines: {
            select: {
              quantity: true,
              amount: true,
            },
          },
        },
        orderBy: [
          { createdAt: 'desc' },
          { invoiceNumber: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.wmsInvoice.findMany({
        where,
        select: {
          status: true,
          totalsSnapshot: true,
        },
      }),
      this.prisma.wmsInvoice.groupBy({
        by: ['status'],
        where: {
          tenantId: scope.activeTenantId,
        },
        _count: {
          _all: true,
        },
      }),
      this.prisma.wmsInvoice.groupBy({
        by: ['sourceType'],
        where: {
          tenantId: scope.activeTenantId,
        },
        _count: {
          _all: true,
        },
      }),
    ]);

    const statusCountMap = new Map(statusCounts.map((row) => [row.status, row._count._all]));
    const sourceTypeCountMap = new Map(
      sourceTypeCounts.map((row) => [row.sourceType, row._count._all]),
    );
    const summary = summaryInvoices.reduce<{
      invoices: number;
      draft: number;
      issued: number;
      paidPendingVerify: number;
      paidVerified: number;
      canceled: number;
      totalBilledAmount: number;
      totalAmountDue: number;
      draftAmount: number;
      issuedAmount: number;
      paidPendingVerifyAmount: number;
      paidVerifiedAmount: number;
      canceledAmount: number;
    }>(
      (acc, invoice) => {
        const totals = this.readInvoiceTotals(invoice.totalsSnapshot);
        const totalAmount = totals.totalAmount ?? 0;
        const amountDue = totals.amountDue ?? totalAmount;

        acc.invoices += 1;
        acc.totalBilledAmount += totalAmount;
        acc.totalAmountDue += amountDue;

        switch (invoice.status) {
          case WmsInvoiceStatus.DRAFT:
            acc.draft += 1;
            acc.draftAmount += totalAmount;
            break;
          case WmsInvoiceStatus.ISSUED:
            acc.issued += 1;
            acc.issuedAmount += totalAmount;
            break;
          case WmsInvoiceStatus.PAID_PENDING_VERIFY:
            acc.paidPendingVerify += 1;
            acc.paidPendingVerifyAmount += totalAmount;
            break;
          case WmsInvoiceStatus.PAID_VERIFIED:
            acc.paidVerified += 1;
            acc.paidVerifiedAmount += totalAmount;
            break;
          case WmsInvoiceStatus.CANCELED:
            acc.canceled += 1;
            acc.canceledAmount += totalAmount;
            break;
          default:
            break;
        }

        return acc;
      },
      {
        invoices: 0,
        draft: 0,
        issued: 0,
        paidPendingVerify: 0,
        paidVerified: 0,
        canceled: 0,
        totalBilledAmount: 0,
        totalAmountDue: 0,
        draftAmount: 0,
        issuedAmount: 0,
        paidPendingVerifyAmount: 0,
        paidVerifiedAmount: 0,
        canceledAmount: 0,
      },
    );

    return {
      tenantReady: true,
      summary,
      filters: {
        tenants: scope.tenants,
        statuses: INVOICE_STATUS_ORDER.map((status) => ({
          value: status,
          label: this.formatInvoiceStatusLabel(status),
          invoiceCount: statusCountMap.get(status) ?? 0,
        })),
        sourceTypes: INVOICE_SOURCE_ORDER.map((sourceType) => ({
          value: sourceType,
          label: this.formatInvoiceSourceTypeLabel(sourceType),
          invoiceCount: sourceTypeCountMap.get(sourceType) ?? 0,
        })),
        activeTenantId: scope.activeTenantId,
        activeStatus: query.status ?? null,
        activeSourceType: query.sourceType ?? null,
      },
      pagination: {
        page,
        pageSize,
        total: listTotal,
        totalPages: Math.max(1, Math.ceil(listTotal / pageSize)),
      },
      invoices: invoices.map((invoice) => this.mapInvoiceListRow(invoice)),
    };
  }

  async getInvoiceById(id: string, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const invoice = await this.prisma.wmsInvoice.findUnique({
      where: { id },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            store: {
              select: {
                id: true,
                name: true,
                shopName: true,
              },
            },
          },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice was not found');
    }

    if (invoice.tenantId !== scope.activeTenantId) {
      throw new ForbiddenException('Selected invoice is outside your WMS scope');
    }

    const activities = await this.prisma.wmsStaffActivity.findMany({
      where: {
        tenantId: invoice.tenantId,
        resourceType: 'WMS_INVOICE',
        resourceId: invoice.id,
      },
      include: {
        actor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 50,
    });

    return {
      invoice: this.mapInvoiceDetail(invoice, activities),
    };
  }

  async getInvoiceDocument(id: string, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const invoice = await this.prisma.wmsInvoice.findUnique({
      where: { id },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            store: {
              select: {
                id: true,
                name: true,
                shopName: true,
              },
            },
          },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Invoice was not found');
    }

    if (invoice.tenantId !== scope.activeTenantId) {
      throw new ForbiddenException('Selected invoice is outside your WMS scope');
    }

    const [tenant, settings] = await Promise.all([
      this.requireInvoiceTenant(invoice.tenantId),
      this.findEffectiveInvoiceSettingsWithLogo(invoice.tenantId),
    ]);

    const invoiceDetail = this.mapInvoiceDetail(invoice);
    const logoUrl = settings?.logoAsset
      ? await this.mediaAssetsService.createAssetDataUrl(settings.logoAsset)
      : null;
    const storedPaymentProfile = this.asJsonRecord(invoice.paymentProfileSnapshot);
    const selectedPaymentProfile = this.hasInvoicePaymentProfile(storedPaymentProfile)
      ? storedPaymentProfile
      : this.resolveInvoicePaymentProfile(settings);
    const issuerDocument = {
      ...(invoiceDetail.issuer ?? {}),
      companyName: settings?.companyName ?? this.readJsonString(invoiceDetail.issuer, 'companyName'),
      companyAddress:
        settings?.companyAddress ?? this.readJsonString(invoiceDetail.issuer, 'companyAddress'),
      bankName:
        this.readJsonString(selectedPaymentProfile, 'bankName')
        ?? this.readJsonString(invoiceDetail.issuer, 'bankName'),
      bankAccountName:
        this.readJsonString(selectedPaymentProfile, 'bankAccountName')
        ?? this.readJsonString(invoiceDetail.issuer, 'bankAccountName'),
      bankAccountNumber:
        this.readJsonString(selectedPaymentProfile, 'bankAccountNumber')
        ?? this.readJsonString(invoiceDetail.issuer, 'bankAccountNumber'),
      bankAccountType:
        this.readJsonString(selectedPaymentProfile, 'bankAccountType')
        ?? this.readJsonString(invoiceDetail.issuer, 'bankAccountType'),
      bankBranch:
        this.readJsonString(selectedPaymentProfile, 'bankBranch')
        ?? this.readJsonString(invoiceDetail.issuer, 'bankBranch'),
      paymentInstructions:
        this.readJsonString(selectedPaymentProfile, 'paymentInstructions')
        ?? this.readJsonString(invoiceDetail.issuer, 'paymentInstructions'),
      footerNotes: settings?.footerNotes ?? this.readJsonString(invoiceDetail.issuer, 'footerNotes'),
      logoUrl,
    };
    const billToDocument = {
      ...(invoiceDetail.billTo ?? {}),
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      companyName: tenant.billingCompanyName ?? tenant.name,
      billingAddress:
        tenant.billingAddress ?? this.readJsonString(invoiceDetail.billTo, 'billingAddress'),
    };

    return {
      invoice: invoiceDetail,
      document: {
        title: 'Billing Statement',
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
        },
        issuer: issuerDocument,
        billTo: billToDocument,
        payment: {
          profileId: this.readJsonString(selectedPaymentProfile, 'id'),
          profileName: this.readJsonString(selectedPaymentProfile, 'name'),
          bankName: this.readJsonString(issuerDocument, 'bankName'),
          bankAccountName: this.readJsonString(issuerDocument, 'bankAccountName'),
          bankAccountNumber: this.readJsonString(issuerDocument, 'bankAccountNumber'),
          bankAccountType: this.readJsonString(issuerDocument, 'bankAccountType'),
          bankBranch: this.readJsonString(issuerDocument, 'bankBranch'),
          paymentInstructions: this.readJsonString(issuerDocument, 'paymentInstructions'),
          footerNotes: this.readJsonString(issuerDocument, 'footerNotes'),
        },
        source: {
          type: invoiceDetail.sourceType,
          referenceCode: invoiceDetail.sourceRefCode,
        },
        generatedAt: new Date().toISOString(),
      },
    };
  }

  async createManualInvoice(body: CreateWmsInvoiceDto, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    if (!body.lines.length) {
      throw new BadRequestException('At least one invoice line is required');
    }

    const tenant = await this.requireInvoiceTenant(scope.activeTenantId);
    const status = body.status ?? WmsInvoiceStatus.DRAFT;
    if (status !== WmsInvoiceStatus.DRAFT && status !== WmsInvoiceStatus.ISSUED) {
      throw new BadRequestException('Manual invoice can only start as draft or issued');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const explicitInvoiceNumber = this.cleanOptionalText(body.invoiceNumber);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const created = await this.prisma.$transaction(async (tx) => {
          const normalizedLines = await this.prepareInvoiceLines(
            tx,
            scope.activeTenantId!,
            body.lines,
            { allowVat: true },
          );
          const totals = this.computeInvoiceTotals(normalizedLines);
          const invoiceSettings = await this.getInvoiceSettingsRecordTx(tx, scope.activeTenantId!);
          const paymentProfile = this.resolveInvoicePaymentProfile(
            invoiceSettings,
            body.paymentProfileId,
          );
          const invoiceNumber = explicitInvoiceNumber
            ?? await this.generateNextInvoiceNumberTx(
              tx,
              scope.activeTenantId!,
              invoiceSettings?.invoicePrefix ?? 'INV',
            );
          const issueDate = this.parseOptionalDate(body.issueDate);
          const dueDate = this.parseOptionalDate(body.dueDate);
          const now = new Date();

          const invoice = await tx.wmsInvoice.create({
            data: {
              tenantId: scope.activeTenantId!,
              sourceType: WmsInvoiceSourceType.MANUAL,
              status,
              invoiceNumber,
              issueDate: status === WmsInvoiceStatus.ISSUED ? (issueDate ?? now) : issueDate,
              dueDate,
              currency: this.normalizeInvoiceCurrency(body.currency),
              issuerSnapshot: this.buildIssuerSnapshot(invoiceSettings, tenant, paymentProfile),
              billToSnapshot: this.buildBillToSnapshot(tenant),
              paymentProfileSnapshot: this.buildPaymentProfileSnapshot(paymentProfile),
              totalsSnapshot: totals as Prisma.InputJsonValue,
              notes: this.cleanOptionalText(body.notes),
              createdById: actorId,
              updatedById: actorId,
              lines: {
                create: normalizedLines.map((line, index) => ({
                  tenantId: scope.activeTenantId!,
                  lineNo: index + 1,
                  lineType: line.lineType,
                  storeId: line.storeId ?? null,
                  productId: line.productId ?? null,
                  variationId: line.variationId ?? null,
                  description: line.description,
                  itemSubtext: line.itemSubtext,
                  quantity: line.quantity,
                  unitRate: new Prisma.Decimal(line.unitRate.toFixed(2)),
                  amount: new Prisma.Decimal(line.amount.toFixed(2)),
                  vatEnabled: line.vatEnabled,
                  vatRate: new Prisma.Decimal(line.vatRate.toFixed(2)),
                  vatAmount: new Prisma.Decimal(line.vatAmount.toFixed(2)),
                  rateSource: line.rateSource ?? null,
                  lineSnapshot: this.buildInvoiceLineSnapshot(line),
                })),
              },
            },
            include: {
              lines: {
                orderBy: { lineNo: 'asc' },
                include: {
                  store: {
                    select: {
                      id: true,
                      name: true,
                      shopName: true,
                    },
                  },
                },
              },
            },
          });

          await this.recordInvoiceActivityTx(tx, {
            tenantId: scope.activeTenantId!,
            actorId,
            actionType: 'WMS_INVOICE_CREATED',
            resourceId: invoice.id,
            toStatus: invoice.status,
            metadata: this.toJsonValue({
              sourceType: invoice.sourceType,
              sourceRefId: invoice.sourceRefId,
              sourceRefCode: invoice.sourceRefCode,
              invoiceNumber: invoice.invoiceNumber,
              totalAmount: this.readInvoiceTotals(invoice.totalsSnapshot).totalAmount ?? 0,
              origin: 'MANUAL',
            }),
          });

          return invoice;
        });

        return {
          invoice: this.mapInvoiceDetail(created),
        };
      } catch (error) {
        if (
          explicitInvoiceNumber
          && error instanceof Prisma.PrismaClientKnownRequestError
          && error.code === 'P2002'
        ) {
          throw new BadRequestException('Invoice number is already used in this tenant');
        }

        if (
          !explicitInvoiceNumber
          && attempt < 2
          && error instanceof Prisma.PrismaClientKnownRequestError
          && error.code === 'P2002'
        ) {
          continue;
        }

        throw error;
      }
    }

    throw new BadRequestException('Unable to generate a unique invoice number');
  }

  async updateInvoice(id: string, body: UpdateWmsInvoiceDto, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;

    const updatedId = await this.prisma.$transaction(async (tx) => {
      const current = await tx.wmsInvoice.findUnique({
        where: { id },
        include: {
          lines: {
            orderBy: { lineNo: 'asc' },
          },
        },
      });

      if (!current) {
        throw new NotFoundException('Invoice was not found');
      }

      if (current.tenantId !== scope.activeTenantId) {
        throw new ForbiddenException('Selected invoice is outside your WMS scope');
      }

      if (!INVOICE_EDITABLE_STATUSES.has(current.status)) {
        throw new BadRequestException('Only draft or issued invoices can be edited');
      }

      if (
        body.paymentProfileId !== undefined
        && current.sourceType !== WmsInvoiceSourceType.MANUAL
      ) {
        throw new BadRequestException(
          'Payment information can only be changed on manual invoices',
        );
      }

      let totalsSnapshot: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput =
        current.totalsSnapshot === null
          ? Prisma.JsonNull
          : current.totalsSnapshot as Prisma.InputJsonValue;
      let paymentProfileSnapshot: Prisma.InputJsonValue | undefined;
      let issuerSnapshot: Prisma.InputJsonValue | undefined;
      if (body.paymentProfileId !== undefined) {
        const invoiceSettings = await this.getInvoiceSettingsRecordTx(tx, scope.activeTenantId!);
        const paymentProfile = this.resolveInvoicePaymentProfile(
          invoiceSettings,
          body.paymentProfileId,
        );
        paymentProfileSnapshot = this.buildPaymentProfileSnapshot(paymentProfile);
        issuerSnapshot = {
          ...(this.asJsonRecord(current.issuerSnapshot) ?? {}),
          ...this.paymentProfileFields(paymentProfile),
        } as Prisma.InputJsonValue;
      }
      if (body.lines) {
        if (!body.lines.length) {
          throw new BadRequestException('At least one invoice line is required');
        }

        const normalizedLines = await this.prepareInvoiceLines(
          tx,
          scope.activeTenantId!,
          body.lines,
          { allowVat: current.sourceType === WmsInvoiceSourceType.MANUAL },
        );
        const totals = this.applyInvoiceStatusToTotals(
          this.computeInvoiceTotals(normalizedLines),
          current.status,
        );
        totalsSnapshot = totals as Prisma.InputJsonValue;

        await tx.wmsInvoiceLine.deleteMany({
          where: {
            invoiceId: current.id,
          },
        });

        await tx.wmsInvoiceLine.createMany({
          data: normalizedLines.map((line, index) => ({
            invoiceId: current.id,
            tenantId: scope.activeTenantId!,
            lineNo: index + 1,
            lineType: line.lineType,
            storeId: line.storeId ?? null,
            productId: line.productId ?? null,
            variationId: line.variationId ?? null,
            description: line.description,
            itemSubtext: line.itemSubtext,
            quantity: line.quantity,
            unitRate: new Prisma.Decimal(line.unitRate.toFixed(2)),
            amount: new Prisma.Decimal(line.amount.toFixed(2)),
            vatEnabled: line.vatEnabled,
            vatRate: new Prisma.Decimal(line.vatRate.toFixed(2)),
            vatAmount: new Prisma.Decimal(line.vatAmount.toFixed(2)),
            rateSource: line.rateSource ?? null,
            lineSnapshot: this.buildInvoiceLineSnapshot(line),
          })),
        });
      }

      const updated = await tx.wmsInvoice.update({
        where: { id: current.id },
        data: {
          issueDate:
            body.issueDate !== undefined ? this.parseOptionalDate(body.issueDate) : undefined,
          dueDate:
            body.dueDate !== undefined ? this.parseOptionalDate(body.dueDate) : undefined,
          currency:
            body.currency !== undefined ? this.normalizeInvoiceCurrency(body.currency) : undefined,
          notes:
            body.notes !== undefined ? this.cleanOptionalText(body.notes) : undefined,
          paymentProfileSnapshot,
          issuerSnapshot,
          totalsSnapshot,
          updatedById: actorId,
        },
      });

      await this.recordInvoiceActivityTx(tx, {
        tenantId: scope.activeTenantId!,
        actorId,
        actionType: 'WMS_INVOICE_UPDATED',
        resourceId: updated.id,
        fromStatus: current.status,
        toStatus: updated.status,
        metadata: this.toJsonValue({
          invoiceNumber: current.invoiceNumber,
          lineCount: body.lines?.length ?? current.lines.length,
          noteChanged: body.notes !== undefined,
          currencyChanged: body.currency !== undefined,
          dueDateChanged: body.dueDate !== undefined,
          issueDateChanged: body.issueDate !== undefined,
          paymentProfileChanged: body.paymentProfileId !== undefined,
        }),
      });

      return updated.id;
    });

    const updated = await this.prisma.wmsInvoice.findUnique({
      where: { id: updatedId },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            store: {
              select: {
                id: true,
                name: true,
                shopName: true,
              },
            },
          },
        },
      },
    });

    if (!updated) {
      throw new NotFoundException('Invoice was not found after update');
    }

    return {
      invoice: this.mapInvoiceDetail(updated),
    };
  }

  async updateInvoiceStatus(id: string, body: UpdateWmsInvoiceStatusDto, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;

    const updatedId = await this.prisma.$transaction(async (tx) => {
      const current = await tx.wmsInvoice.findUnique({
        where: { id },
        include: {
          lines: {
            orderBy: { lineNo: 'asc' },
            include: {
              store: {
                select: {
                  id: true,
                  name: true,
                  shopName: true,
                },
              },
            },
          },
        },
      });

      if (!current) {
        throw new NotFoundException('Invoice was not found');
      }

      if (current.tenantId !== scope.activeTenantId) {
        throw new ForbiddenException('Selected invoice is outside your WMS scope');
      }

      if (current.status === body.status) {
        return current.id;
      }

      const allowedTransitions = INVOICE_STATUS_TRANSITIONS[current.status] ?? [];
      if (!allowedTransitions.includes(body.status)) {
        throw new BadRequestException(
          `Cannot move invoice from ${current.status} to ${body.status}`,
        );
      }

      const nextIssueDate = body.status === WmsInvoiceStatus.ISSUED
        ? this.parseOptionalDate(body.issueDate) ?? current.issueDate ?? new Date()
        : body.issueDate !== undefined
          ? this.parseOptionalDate(body.issueDate)
          : undefined;
      const currentTotals = this.readInvoiceTotals(current.totalsSnapshot);
      const totalAmount = currentTotals.totalAmount ?? 0;
      const nextAmountDue =
        body.status === WmsInvoiceStatus.PAID_VERIFIED || body.status === WmsInvoiceStatus.CANCELED
          ? 0
          : totalAmount;

      const updated = await tx.wmsInvoice.update({
        where: { id: current.id },
        data: {
          status: body.status,
          issueDate: nextIssueDate,
          dueDate:
            body.dueDate !== undefined ? this.parseOptionalDate(body.dueDate) : undefined,
          notes:
            body.notes !== undefined ? this.cleanOptionalText(body.notes) : undefined,
          totalsSnapshot: {
            ...currentTotals,
            amountDue: nextAmountDue,
          } as Prisma.InputJsonValue,
          updatedById: actorId,
        },
      });

      await this.recordInvoiceActivityTx(tx, {
        tenantId: scope.activeTenantId!,
        actorId,
        actionType: 'WMS_INVOICE_STATUS_CHANGED',
        resourceId: updated.id,
        fromStatus: current.status,
        toStatus: updated.status,
        metadata: this.toJsonValue({
          invoiceNumber: current.invoiceNumber,
          sourceType: current.sourceType,
          sourceRefId: current.sourceRefId,
          sourceRefCode: current.sourceRefCode,
        }),
      });

      return updated.id;
    });

    const updated = await this.prisma.wmsInvoice.findUnique({
      where: { id: updatedId },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            store: {
              select: {
                id: true,
                name: true,
                shopName: true,
              },
            },
          },
        },
      },
    });

    if (!updated) {
      throw new NotFoundException('Invoice was not found after status update');
    }

    return {
      invoice: this.mapInvoiceDetail(updated),
    };
  }

  async ensureProcurementInvoice(id: string, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const invoiceId = await this.prisma.$transaction(async (tx) => {
      const batch = await tx.wmsPurchasingBatch.findUnique({
        where: { id },
        include: {
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
              billingCompanyName: true,
              billingAddress: true,
            },
          },
          lines: {
            orderBy: { lineNo: 'asc' },
            include: {
              store: {
                select: {
                  id: true,
                  name: true,
                  shopName: true,
                },
              },
            },
          },
        },
      });

      if (!batch) {
        throw new NotFoundException('Purchasing batch was not found');
      }

      this.assertBatchTenantScope(batch.tenantId, scope.activeTenantId!);

      if (batch.requestType !== WmsPurchasingRequestType.PROCUREMENT) {
        throw new BadRequestException('Linked invoices are only available for procurement batches');
      }

      return this.syncProcurementInvoiceForBatchTx(tx, batch);
    });

    return this.getInvoiceById(invoiceId, scope.activeTenantId);
  }

  async getProcurementInvoiceByBatchId(id: string, requestedTenantId?: string) {
    const invoiceId = await this.getLinkedProcurementInvoiceIdByBatchId(id, requestedTenantId);
    return this.getInvoiceById(invoiceId, requestedTenantId);
  }

  async getProcurementInvoiceDocumentByBatchId(id: string, requestedTenantId?: string) {
    const invoiceId = await this.getLinkedProcurementInvoiceIdByBatchId(id, requestedTenantId);
    return this.getInvoiceDocument(invoiceId, requestedTenantId);
  }

  async ensureManualReceivingInvoice(receivingBatchId: string, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const invoiceId = await this.prisma.$transaction(async (tx) => {
      const receivingBatch = await tx.wmsReceivingBatch.findUnique({
        where: { id: receivingBatchId },
        include: {
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
              billingCompanyName: true,
              billingAddress: true,
            },
          },
          lines: {
            orderBy: { lineNo: 'asc' },
            include: {
              store: {
                select: {
                  id: true,
                  name: true,
                  shopName: true,
                },
              },
            },
          },
        },
      });

      if (!receivingBatch) {
        throw new NotFoundException('Receiving batch was not found');
      }

      if (receivingBatch.tenantId !== scope.activeTenantId) {
        throw new ForbiddenException('Selected receiving batch is outside your WMS scope');
      }

      if (receivingBatch.purchasingBatchId) {
        throw new BadRequestException(
          'Linked receiving invoices can only be created for manual receiving batches',
        );
      }

      return this.syncManualReceivingInvoiceForBatchTx(tx, receivingBatch);
    });

    return this.getInvoiceById(invoiceId, scope.activeTenantId);
  }

  private async getLinkedProcurementInvoiceIdByBatchId(id: string, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const batch = await this.prisma.wmsPurchasingBatch.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        requestType: true,
      },
    });

    if (!batch) {
      throw new NotFoundException('Purchasing batch was not found');
    }

    this.assertBatchTenantScope(batch.tenantId, scope.activeTenantId);

    if (batch.requestType !== WmsPurchasingRequestType.PROCUREMENT) {
      throw new BadRequestException('Linked invoices are only available for procurement batches');
    }

    const invoice = await this.prisma.wmsInvoice.findFirst({
      where: {
        tenantId: batch.tenantId,
        sourceType: WmsInvoiceSourceType.PROCUREMENT,
        sourceRefId: batch.id,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (!invoice) {
      throw new NotFoundException('Linked invoice was not found for this procurement request');
    }

    return invoice.id;
  }

  async getProductOptions(query: GetWmsPurchasingProductOptionsDto) {
    const scope = await this.resolveTenantScope(query.tenantId);
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(5, query.pageSize ?? 10));

    if (!scope.activeTenantId) {
      return {
        tenantReady: false,
        filters: {
          tenants: scope.tenants,
          stores: [],
          activeTenantId: null,
          activeStoreId: null,
        },
        pagination: {
          page,
          pageSize,
          total: 0,
          totalPages: 1,
        },
        products: [],
      };
    }

    const stores = await this.prisma.posStore.findMany({
      where: { tenantId: scope.activeTenantId },
      select: {
        id: true,
        name: true,
        shopName: true,
      },
      orderBy: [{ name: 'asc' }],
    });

    const activeStoreId =
      query.storeId && stores.some((store) => store.id === query.storeId)
        ? query.storeId
        : null;
    const normalizedSearch = this.cleanOptionalText(query.search);

    const where: Prisma.WmsProductProfileWhereInput = {
      tenantId: scope.activeTenantId,
      status: {
        in: [WmsProductProfileStatus.DEFAULT, WmsProductProfileStatus.READY],
      },
      ...(activeStoreId ? { storeId: activeStoreId } : {}),
      ...(normalizedSearch
        ? {
            OR: [
              { productId: { contains: normalizedSearch, mode: 'insensitive' } },
              { variationId: { contains: normalizedSearch, mode: 'insensitive' } },
              {
                posProduct: {
                  OR: [
                    { name: { contains: normalizedSearch, mode: 'insensitive' } },
                    { customId: { contains: normalizedSearch, mode: 'insensitive' } },
                  ],
                },
              },
            ],
          }
        : {}),
    };

    const profileCandidates = await this.prisma.wmsProductProfile.findMany({
      where,
      include: {
        posProduct: {
          select: {
            id: true,
            productId: true,
            variationId: true,
            customId: true,
            name: true,
            productSnapshot: true,
            retailPrice: true,
            store: {
              select: {
                id: true,
                name: true,
                shopName: true,
              },
            },
          },
        },
      },
      orderBy: [{ updatedAt: 'desc' }],
    });

    const profiles = profileCandidates.filter(
      (profile) =>
        this.isStockableVariation(profile.posProduct.productId, profile.posProduct.variationId)
        && this.isStockableVariation(profile.productId, profile.variationId),
    );
    const total = profiles.length;
    const paginatedProfiles = profiles.slice((page - 1) * pageSize, page * pageSize);

    return {
      tenantReady: true,
      filters: {
        tenants: scope.tenants,
        stores: stores.map((store) => ({
          id: store.id,
          label: store.shopName || store.name,
        })),
        activeTenantId: scope.activeTenantId,
        activeStoreId,
      },
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
      products: paginatedProfiles.map((profile) => {
        const snapshot = profile.posProduct.productSnapshot as
          | {
              display_id?: string | null;
              product?: {
                display_id?: string | null;
              } | null;
            }
          | null;

        const variationDisplayId =
          typeof snapshot?.display_id === 'string'
            ? snapshot.display_id
            : typeof snapshot?.product?.display_id === 'string'
              ? snapshot.product.display_id
              : null;

        return {
          profileId: profile.id,
          posProductId: profile.posProduct.id,
          status: profile.status,
          isSerialized: profile.isSerialized,
          productId: profile.productId,
          variationId: profile.variationId,
          variationDisplayId,
          productCustomId: profile.posProduct.customId,
          name: profile.posProduct.name,
          retailPrice: this.toNumber(profile.posProduct.retailPrice),
          inhouseUnitCost: this.toNumber(profile.inhouseUnitCost),
          supplierUnitCost: this.toNumber(profile.supplierUnitCost),
          store: {
            id: profile.posProduct.store.id,
            name: profile.posProduct.store.shopName || profile.posProduct.store.name,
          },
        };
      }),
    };
  }

  async getBatchById(id: string, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const batch = await this.prisma.wmsPurchasingBatch.findUnique({
      where: { id },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            billingCompanyName: true,
            billingAddress: true,
          },
        },
        store: {
          select: {
            id: true,
            name: true,
            shopName: true,
          },
        },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            resolvedPosProduct: {
              select: {
                id: true,
                name: true,
                customId: true,
                productSnapshot: true,
              },
            },
            resolvedProfile: {
              select: {
                id: true,
                status: true,
                isSerialized: true,
              },
            },
          },
        },
        events: {
          orderBy: { createdAt: 'desc' },
          include: {
            actor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
        paymentProofSubmittedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        paymentProofAsset: {
          select: {
            id: true,
            objectKey: true,
          },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException('Purchasing batch was not found');
    }

    this.assertBatchTenantScope(batch.tenantId, scope.activeTenantId);
    const [invoiceBankDetails, linkedInvoice] = await Promise.all([
      this.resolveInvoiceBankDetails(batch.tenantId),
      this.findLinkedInvoiceSummary({
        tenantId: batch.tenantId,
        sourceType: WmsInvoiceSourceType.PROCUREMENT,
        sourceRefId: batch.id,
      }),
    ]);

    return {
      batch: await this.mapBatchDetail(batch, invoiceBankDetails, linkedInvoice),
    };
  }

  async markBatchNotificationsRead(
    id: string,
    system: NotificationSystem,
    requestedTenantId?: string,
  ) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const batch = await this.prisma.wmsPurchasingBatch.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        status: true,
        sourceStatus: true,
      },
    });

    if (!batch) {
      throw new NotFoundException('Purchasing batch was not found');
    }

    this.assertBatchTenantScope(batch.tenantId, scope.activeTenantId);

    const updatedCount = await this.notificationStateService.markEntityRead({
      tenantId: batch.tenantId,
      system,
      domain: NotificationDomain.PURCHASING,
      entityType: this.notificationStateService.getPurchasingEntityType(),
      entityId: batch.id,
      readByUserId: actorId,
    });

    if (updatedCount > 0) {
      this.emitStockRequestUpdate({
        tenantId: batch.tenantId,
        batchId: batch.id,
        status: batch.status,
        sourceStatus: batch.sourceStatus ?? null,
        eventType: 'NOTIFICATION_READ',
      });
    }

    return {
      success: true,
    };
  }

  async uploadPartnerPaymentProofImage(
    file: UploadedImageFile | undefined,
    requestedTenantId?: string,
  ) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    return this.mediaAssetsService.uploadPaymentProofImage(file, scope.activeTenantId);
  }

  async createBatch(body: CreateWmsPurchasingBatchDto, requestedTenantId?: string) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    if (!body.lines.length) {
      throw new BadRequestException('At least one purchasing line is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;

    await this.validateStore(scope.activeTenantId, body.storeId);

    const status = body.status ?? WmsPurchasingBatchStatus.UNDER_REVIEW;
    const sourceType = body.sourceType ?? WmsPurchasingSourceType.ERP_REQUEST;
    const sourceRequestId = this.cleanOptionalText(body.sourceRequestId);

    if (sourceRequestId) {
      const existing = await this.prisma.wmsPurchasingBatch.findUnique({
        where: {
          tenantId_sourceType_sourceRequestId: {
            tenantId: scope.activeTenantId,
            sourceType,
            sourceRequestId,
          },
        },
        select: {
          id: true,
        },
      });

      if (existing) {
        return this.getBatchById(existing.id, scope.activeTenantId);
      }
    }

    const lineData = await this.normalizeCreateLines({
      tenantId: scope.activeTenantId,
      storeId: body.storeId,
      requestType: body.requestType,
      lines: body.lines,
    });

    if (this.requiresOperationalReadinessValidation(body.requestType, status)) {
      this.validateReadyForReceiving({
        requestType: body.requestType,
        lines: lineData,
        invoiceNumber: body.invoiceNumber,
        paymentVerifiedAt: body.paymentVerifiedAt,
      });
    }

    const now = new Date();
    const paymentProofAsset = await this.resolvePaymentProofAsset(
      body.paymentProofAssetId,
      scope.activeTenantId,
    );
    const paymentProofImageUrl = this.cleanOptionalText(body.paymentProofImageUrl);
    const hasPaymentProof = Boolean(paymentProofAsset || paymentProofImageUrl);
    let createdId = '';
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.wmsPurchasingBatch.create({
        data: {
          tenantId: scope.activeTenantId!,
          storeId: body.storeId,
          requestType: body.requestType,
          status,
          sourceType,
          sourceRequestId,
          sourceRequestType: body.sourceRequestType ?? null,
          sourceStatus: this.cleanOptionalText(body.sourceStatus),
          sourceSnapshot: this.toJsonValue(body.sourceSnapshot),
          requestTitle: this.cleanOptionalText(body.requestTitle),
          partnerNotes: this.cleanOptionalText(body.partnerNotes),
          wmsNotes: this.cleanOptionalText(body.wmsNotes),
          invoiceNumber: this.cleanOptionalText(body.invoiceNumber),
          invoiceAmount: this.numberOrNull(body.invoiceAmount),
          paymentProofImageUrl: paymentProofAsset ? null : paymentProofImageUrl,
          paymentProofAssetId: paymentProofAsset?.id ?? null,
          paymentSubmittedAt: this.parseOptionalDate(body.paymentSubmittedAt),
          paymentProofSubmittedAt: hasPaymentProof
            ? this.parseOptionalDate(body.paymentSubmittedAt) ?? now
            : null,
          paymentProofSubmittedById: hasPaymentProof
            ? actorId
            : null,
          paymentVerifiedAt: this.parseOptionalDate(body.paymentVerifiedAt),
          readyForReceivingAt: this.isReadyForReceivingQueueStatus(status) ? now : null,
          submittedById: actorId,
          reviewedById:
            status === WmsPurchasingBatchStatus.REVISION
            || status === WmsPurchasingBatchStatus.AWAITING_PRODUCTS
            || status === WmsPurchasingBatchStatus.PENDING_PAYMENT
            || status === WmsPurchasingBatchStatus.PAYMENT_REVIEW
            || status === WmsPurchasingBatchStatus.RECEIVING_EXCEPTION
            || status === WmsPurchasingBatchStatus.RECEIVING_READY
            || status === WmsPurchasingBatchStatus.RECEIVING
            || status === WmsPurchasingBatchStatus.STOCKED
              ? actorId
              : null,
          approvedById:
            status === WmsPurchasingBatchStatus.AWAITING_PRODUCTS
            || status === WmsPurchasingBatchStatus.PENDING_PAYMENT
            || status === WmsPurchasingBatchStatus.PAYMENT_REVIEW
            || status === WmsPurchasingBatchStatus.RECEIVING_READY
            || status === WmsPurchasingBatchStatus.RECEIVING
            || status === WmsPurchasingBatchStatus.STOCKED
              ? actorId
              : null,
          createdById: actorId,
          updatedById: actorId,
          lines: {
            createMany: {
              data: lineData.map((line) => ({
                ...line,
                createdById: actorId,
                updatedById: actorId,
              })),
            },
          },
        },
        select: { id: true },
      });

      const event = await tx.wmsPurchasingEvent.create({
        data: {
          batchId: created.id,
          tenantId: scope.activeTenantId!,
          eventType: 'STATUS_CHANGED',
          toStatus: status,
          message: 'Purchasing batch created',
          actorId,
        },
      });

      await this.syncPurchasingNotificationEvent(tx, event);
      createdId = created.id;
    });

    this.emitStockRequestUpdate({
      tenantId: scope.activeTenantId,
      batchId: createdId,
      status,
      sourceStatus: this.cleanOptionalText(body.sourceStatus) ?? null,
      eventType: 'STATUS_CHANGED',
    });

    return this.getBatchById(createdId, scope.activeTenantId);
  }

  async submitPartnerPaymentProof(
    id: string,
    body: SubmitWmsPurchasingPaymentProofDto,
    requestedTenantId?: string,
  ) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const batch = await this.prisma.wmsPurchasingBatch.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        status: true,
        requestType: true,
      },
    });

    if (!batch) {
      throw new NotFoundException('Purchasing batch was not found');
    }

    this.assertBatchTenantScope(batch.tenantId, scope.activeTenantId);

    if (
      batch.status === WmsPurchasingBatchStatus.REJECTED
      || batch.status === WmsPurchasingBatchStatus.CANCELED
      || batch.status === WmsPurchasingBatchStatus.STOCKED
    ) {
      throw new BadRequestException('Cannot submit payment proof for a closed purchasing batch');
    }

    if (batch.requestType === WmsPurchasingRequestType.SELF_BUY) {
      throw new BadRequestException('Self-buy requests do not require payment proof');
    }

    if (batch.status !== WmsPurchasingBatchStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Payment proof can only be submitted while payment is pending');
    }

    const paymentProofAsset = await this.resolvePaymentProofAsset(
      body.paymentProofAssetId,
      scope.activeTenantId,
    );
    const paymentProofImageUrl = this.cleanOptionalText(body.paymentProofImageUrl);
    if (!paymentProofAsset && !paymentProofImageUrl) {
      throw new BadRequestException('Uploaded payment proof image is required');
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.wmsPurchasingBatch.update({
        where: { id: batch.id },
        data: {
          status: WmsPurchasingBatchStatus.PAYMENT_REVIEW,
          paymentProofImageUrl: paymentProofAsset ? null : paymentProofImageUrl,
          paymentProofAssetId: paymentProofAsset?.id ?? null,
          paymentSubmittedAt: now,
          paymentProofSubmittedAt: now,
          paymentProofSubmittedById: actorId,
          sourceStatus: 'PAYMENT_REVIEW',
          updatedById: actorId,
        },
      });

      const event = await tx.wmsPurchasingEvent.create({
        data: {
          batchId: batch.id,
          tenantId: batch.tenantId,
          eventType: 'PAYMENT_PROOF_SUBMITTED',
          fromStatus: batch.status,
          toStatus: WmsPurchasingBatchStatus.PAYMENT_REVIEW,
          message: this.cleanOptionalText(body.message) ?? 'Partner submitted payment proof',
          actorId,
          payload: {
            paymentProofImageUrl: paymentProofImageUrl ?? null,
            paymentProofAssetId: paymentProofAsset?.id ?? null,
          },
        },
      });

      await this.syncPurchasingNotificationEvent(tx, event);
    });

    this.emitStockRequestUpdate({
      tenantId: batch.tenantId,
      batchId: batch.id,
      status: WmsPurchasingBatchStatus.PAYMENT_REVIEW,
      sourceStatus: 'PAYMENT_REVIEW',
      eventType: 'PAYMENT_PROOF_SUBMITTED',
    });

    return this.getBatchById(batch.id, scope.activeTenantId);
  }

  async respondToRevision(
    id: string,
    body: RespondWmsPurchasingRevisionDto,
    requestedTenantId?: string,
  ) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const batch = await this.prisma.wmsPurchasingBatch.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        requestType: true,
        status: true,
      },
    });

    if (!batch) {
      throw new NotFoundException('Purchasing batch was not found');
    }

    this.assertBatchTenantScope(batch.tenantId, scope.activeTenantId);

    if (batch.status !== WmsPurchasingBatchStatus.REVISION) {
      throw new BadRequestException('Only revised requests can be accepted or rejected by the partner');
    }

    return this.updateStatus(
      id,
      {
        status:
          body.decision === 'ACCEPT'
            ? (
              batch.requestType === WmsPurchasingRequestType.SELF_BUY
                ? WmsPurchasingBatchStatus.AWAITING_PRODUCTS
                : WmsPurchasingBatchStatus.PENDING_PAYMENT
            )
            : WmsPurchasingBatchStatus.REJECTED,
        message:
          this.cleanOptionalText(body.message)
          ?? (
            body.decision === 'ACCEPT'
              ? 'Partner accepted the revised request'
              : 'Partner rejected the revised request'
          ),
        sourceStatus:
          body.decision === 'ACCEPT'
            ? (
              batch.requestType === WmsPurchasingRequestType.SELF_BUY
                ? 'AWAITING_PRODUCTS'
                : 'REVISION_ACCEPTED'
            )
            : 'REVISION_REJECTED',
      },
      scope.activeTenantId,
      { bypassRevisionAcceptanceGuard: true },
    );
  }

  async markSelfBuyShipment(
    id: string,
    body: MarkWmsSelfBuyShipmentDto,
    requestedTenantId?: string,
  ) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const batch = await this.prisma.wmsPurchasingBatch.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        requestType: true,
        status: true,
      },
    });

    if (!batch) {
      throw new NotFoundException('Purchasing batch was not found');
    }

    this.assertBatchTenantScope(batch.tenantId, scope.activeTenantId);

    if (batch.requestType !== WmsPurchasingRequestType.SELF_BUY) {
      throw new BadRequestException('Only self-buy requests can be marked as shipped');
    }

    if (
      batch.status !== WmsPurchasingBatchStatus.AWAITING_PRODUCTS
      && batch.status !== WmsPurchasingBatchStatus.RECEIVING_EXCEPTION
    ) {
      throw new BadRequestException('Self-buy shipment can only be marked after WMS approval or exception follow-up');
    }

    const shipmentReference = this.cleanOptionalText(body.shipmentReference);
    const message =
      this.cleanOptionalText(body.message)
      ?? (
        batch.status === WmsPurchasingBatchStatus.RECEIVING_EXCEPTION
          ? 'Partner confirmed a replacement shipment to warehouse'
          : 'Partner marked products as shipped to warehouse'
      );
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.wmsPurchasingBatch.update({
        where: { id: batch.id },
        data: {
          status: WmsPurchasingBatchStatus.SHIPPED,
          sourceStatus: 'SHIPPED',
          readyForReceivingAt: now,
          updatedById: actorId,
        },
      });

      const event = await tx.wmsPurchasingEvent.create({
        data: {
          batchId: batch.id,
          tenantId: batch.tenantId,
          eventType: 'SELF_BUY_SHIPPED',
          fromStatus: batch.status,
          toStatus: WmsPurchasingBatchStatus.SHIPPED,
          message,
          actorId,
          payload: shipmentReference
            ? {
                shipmentReference,
              }
            : undefined,
        },
      });

      await this.syncPurchasingNotificationEvent(tx, event);
    });

    this.emitStockRequestUpdate({
      tenantId: batch.tenantId,
      batchId: batch.id,
      status: WmsPurchasingBatchStatus.SHIPPED,
      sourceStatus: 'SHIPPED',
      eventType: 'SELF_BUY_SHIPPED',
    });

    return this.getBatchById(batch.id, scope.activeTenantId);
  }

  async updateStatus(
    id: string,
    body: UpdateWmsPurchasingStatusDto,
    requestedTenantId?: string,
    options?: {
      bypassRevisionAcceptanceGuard?: boolean;
    },
  ) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const current = await this.readPurchasingStatusSource(this.prisma, id);

    if (!current) {
      throw new NotFoundException('Purchasing batch was not found');
    }

    this.assertBatchTenantScope(current.tenantId, scope.activeTenantId);

    if (body.status !== current.status) {
      const allowed = this.getAllowedStatusTransitions(current.requestType, current.status);
      if (!allowed.includes(body.status)) {
        throw new BadRequestException(
          `Cannot move purchasing batch from ${current.status} to ${body.status}`,
        );
      }
    }

    const now = new Date();
    const shouldAutoIssueInvoice =
      body.status === WmsPurchasingBatchStatus.PENDING_PAYMENT
      && current.requestType === WmsPurchasingRequestType.PROCUREMENT;

    const providedInvoiceNumber = this.cleanOptionalText(body.invoiceNumber);
    const effectiveInvoiceNumber =
      providedInvoiceNumber
      ?? current.invoiceNumber
      ?? (shouldAutoIssueInvoice ? this.generateInvoiceNumber() : null);

    const providedInvoiceAmount =
      body.invoiceAmount === undefined ? undefined : this.numberOrNull(body.invoiceAmount);
    const effectiveInvoiceAmountRaw =
      providedInvoiceAmount
      ?? this.toNumber(current.invoiceAmount)
      ?? (shouldAutoIssueInvoice ? this.computeInvoiceAmountFromLines(current.lines) : null);
    const effectiveInvoiceAmount =
      effectiveInvoiceAmountRaw === null || effectiveInvoiceAmountRaw === undefined
        ? null
        : Number(effectiveInvoiceAmountRaw);

    const providedPaymentProofImageUrl = this.cleanOptionalText(body.paymentProofImageUrl);
    const providedPaymentProofAsset = await this.resolvePaymentProofAsset(
      body.paymentProofAssetId,
      scope.activeTenantId,
    );
    const effectivePaymentProofAssetId =
      body.paymentProofAssetId !== undefined
        ? (providedPaymentProofAsset?.id ?? null)
        : (current.paymentProofAsset?.id ?? null);
    const effectivePaymentProofImageUrl =
      body.paymentProofImageUrl !== undefined
        ? providedPaymentProofImageUrl
        : current.paymentProofImageUrl;
    const hasEffectivePaymentProof = Boolean(effectivePaymentProofAssetId || effectivePaymentProofImageUrl);
    const shouldSyncAcceptedLineProfileCosts =
      body.status !== current.status
      && current.requestType === WmsPurchasingRequestType.PROCUREMENT
      && body.status === WmsPurchasingBatchStatus.PENDING_PAYMENT;

    const effectivePaymentSubmittedAt =
      body.paymentSubmittedAt === undefined
        ? current.paymentSubmittedAt
        : this.parseOptionalDate(body.paymentSubmittedAt);

    const effectivePaymentVerifiedAt =
      this.parseOptionalDate(body.paymentVerifiedAt)
      ?? (
        body.status === WmsPurchasingBatchStatus.RECEIVING_READY
        && hasEffectivePaymentProof
          ? now
          : current.paymentVerifiedAt
      );

    if (
      body.status === WmsPurchasingBatchStatus.PENDING_PAYMENT
      && current.status === WmsPurchasingBatchStatus.UNDER_REVIEW
      && this.hasCommercialRevisionChanges(current.lines)
    ) {
      throw new BadRequestException(
        'Requests with revised quantity or pricing must be sent back to the partner as a revision',
      );
    }

    if (
      body.status === WmsPurchasingBatchStatus.PENDING_PAYMENT
      && current.requestType === WmsPurchasingRequestType.PROCUREMENT
      && current.status === WmsPurchasingBatchStatus.REVISION
      && !options?.bypassRevisionAcceptanceGuard
    ) {
      throw new BadRequestException(
        'Revision requests must be accepted by the partner before payment can be requested',
      );
    }

    if (this.requiresOperationalReadinessValidation(current.requestType, body.status)) {
      this.validateReadyForReceiving({
        requestType: current.requestType,
        lines: current.lines,
        invoiceNumber: effectiveInvoiceNumber,
        paymentVerifiedAt: effectivePaymentVerifiedAt,
      });
    }

    const nextSourceStatus =
      this.cleanOptionalText(body.sourceStatus)
      ?? (
        body.status === WmsPurchasingBatchStatus.REVISION
          ? 'REVISION_REQUESTED'
          : body.status === WmsPurchasingBatchStatus.AWAITING_PRODUCTS
            ? 'AWAITING_PRODUCTS'
            : body.status === WmsPurchasingBatchStatus.SHIPPED
              ? 'SHIPPED'
              : body.status === WmsPurchasingBatchStatus.RECEIVING_EXCEPTION
                ? 'RECEIVING_EXCEPTION'
          : body.status === WmsPurchasingBatchStatus.PENDING_PAYMENT
            ? 'PENDING_PAYMENT'
            : body.status === WmsPurchasingBatchStatus.PAYMENT_REVIEW
              ? 'PAYMENT_REVIEW'
              : body.status === WmsPurchasingBatchStatus.RECEIVING_READY
                ? 'RECEIVING_READY'
                : body.status === WmsPurchasingBatchStatus.RECEIVING
                  ? 'RECEIVING'
                  : body.status === WmsPurchasingBatchStatus.STOCKED
                    ? 'STOCKED'
                    : body.status === WmsPurchasingBatchStatus.REJECTED
                      ? 'REJECTED'
                      : body.status === WmsPurchasingBatchStatus.CANCELED
                        ? 'CANCELED'
                        : null
      );

    await this.prisma.$transaction(async (tx) => {
      // Take cost parents/profile locks before any batch/line mutation. Reject a
      // stale accepted-price snapshot rather than publishing an earlier value.
      const prepared = shouldSyncAcceptedLineProfileCosts
        ? await this.wmsCogsSync.prepare(tx, current.tenantId,
          current.lines.flatMap(line => line.resolvedProfileId ? [line.resolvedProfileId] : []))
        : null;
      let costLines = current.lines;
      let costProfileProducts = new Map<string, string>();
      if (prepared) {
        await this.lockPurchasingCogsSource(tx, current.tenantId, current.id);
        const fresh = await this.readPurchasingStatusSource(tx, current.id);
        if (!fresh || this.purchasingSourceVersion(fresh) !== this.purchasingSourceVersion(current)) {
          throw new ConflictException('Purchasing prices changed; refresh before accepting this request');
        }
        costLines = fresh.lines;
        costProfileProducts = await this.assertPurchasingCostProfiles(tx, current.tenantId, costLines);
      }
      await tx.wmsPurchasingBatch.update({
        where: { id: current.id },
        data: {
          status: body.status,
          wmsNotes: this.cleanOptionalText(body.wmsNotes) ?? undefined,
          invoiceNumber:
            body.invoiceNumber !== undefined || shouldAutoIssueInvoice
              ? effectiveInvoiceNumber
              : undefined,
          invoiceAmount:
            body.invoiceAmount !== undefined || shouldAutoIssueInvoice
              ? effectiveInvoiceAmount
              : undefined,
          paymentSubmittedAt:
            body.paymentSubmittedAt !== undefined ? effectivePaymentSubmittedAt : undefined,
          paymentProofAssetId:
            body.paymentProofAssetId !== undefined ? effectivePaymentProofAssetId : undefined,
          paymentProofImageUrl:
            body.paymentProofImageUrl !== undefined || body.paymentProofAssetId !== undefined
              ? (effectivePaymentProofAssetId ? null : effectivePaymentProofImageUrl)
              : undefined,
          paymentProofSubmittedAt:
            body.paymentProofImageUrl !== undefined || body.paymentProofAssetId !== undefined
              ? hasEffectivePaymentProof
                ? now
                : null
              : undefined,
          paymentProofSubmittedById:
            body.paymentProofImageUrl !== undefined || body.paymentProofAssetId !== undefined
              ? hasEffectivePaymentProof
                ? actorId
                : null
              : undefined,
          paymentVerifiedAt:
            body.paymentVerifiedAt !== undefined
            || (
              body.status === WmsPurchasingBatchStatus.RECEIVING_READY
              && hasEffectivePaymentProof
            )
              ? effectivePaymentVerifiedAt
              : undefined,
          sourceStatus: nextSourceStatus ?? undefined,
          readyForReceivingAt: this.resolveReadyForReceivingAt(
            current.readyForReceivingAt,
            body.status,
            now,
          ),
          reviewedById:
            body.status === WmsPurchasingBatchStatus.REVISION
            || body.status === WmsPurchasingBatchStatus.AWAITING_PRODUCTS
            || body.status === WmsPurchasingBatchStatus.RECEIVING_EXCEPTION
            || body.status === WmsPurchasingBatchStatus.PENDING_PAYMENT
            || body.status === WmsPurchasingBatchStatus.PAYMENT_REVIEW
            || body.status === WmsPurchasingBatchStatus.RECEIVING_READY
            || body.status === WmsPurchasingBatchStatus.RECEIVING
            || body.status === WmsPurchasingBatchStatus.STOCKED
              ? actorId
              : undefined,
          approvedById:
            body.status === WmsPurchasingBatchStatus.AWAITING_PRODUCTS
            || body.status === WmsPurchasingBatchStatus.PENDING_PAYMENT
            || body.status === WmsPurchasingBatchStatus.PAYMENT_REVIEW
            || body.status === WmsPurchasingBatchStatus.RECEIVING_READY
            || body.status === WmsPurchasingBatchStatus.RECEIVING
            || body.status === WmsPurchasingBatchStatus.STOCKED
              ? actorId
              : undefined,
          updatedById: actorId,
        },
      });

      const refreshedBatch = await tx.wmsPurchasingBatch.findUnique({
        where: { id: current.id },
        include: {
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
              billingCompanyName: true,
              billingAddress: true,
            },
          },
          lines: {
            orderBy: { lineNo: 'asc' },
            include: {
              store: {
                select: {
                  id: true,
                  name: true,
                  shopName: true,
                },
              },
            },
          },
        },
      });

      if (!refreshedBatch) {
        throw new NotFoundException('Purchasing batch was not found after status update');
      }

      const invoiceStatus = this.mapProcurementBatchStatusToInvoiceStatus(refreshedBatch.status);
      if (
        refreshedBatch.requestType === WmsPurchasingRequestType.PROCUREMENT
        && invoiceStatus
      ) {
        await this.syncProcurementInvoiceForBatchTx(tx, refreshedBatch);
      }

      const productProfileCostsSynced = shouldSyncAcceptedLineProfileCosts
        ? await this.syncAcceptedLineProfileCosts(tx, current.tenantId, costLines, costProfileProducts)
        : false;
      if (prepared) await this.wmsCogsSync.syncAfter(tx, prepared, {
        source: 'WMS_PROCUREMENT_ACCEPTED', sourceRef: current.id, actorId,
      });

      const event = await tx.wmsPurchasingEvent.create({
        data: {
          batchId: current.id,
          tenantId: current.tenantId,
          eventType:
            body.status === current.status ? 'BATCH_UPDATED' : 'STATUS_CHANGED',
          fromStatus: current.status,
          toStatus: body.status,
          message: this.cleanOptionalText(body.message),
          actorId,
          payload: {
            invoiceNumber: effectiveInvoiceNumber,
            invoiceAmount: effectiveInvoiceAmount,
            paymentSubmittedAt: body.paymentSubmittedAt ?? null,
            paymentProofImageUrl: effectivePaymentProofImageUrl,
            paymentProofAssetId: effectivePaymentProofAssetId,
            paymentVerifiedAt: effectivePaymentVerifiedAt,
            sourceStatus: nextSourceStatus,
            productProfileCostsSynced,
          },
        },
      });

      await this.syncPurchasingNotificationEvent(tx, event);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 30000 });

    this.emitStockRequestUpdate({
      tenantId: current.tenantId,
      batchId: current.id,
      status: body.status,
      sourceStatus: nextSourceStatus ?? null,
      eventType: body.status === current.status ? 'BATCH_UPDATED' : 'STATUS_CHANGED',
    });

    return this.getBatchById(id, scope.activeTenantId);
  }

  async updateLine(
    batchId: string,
    lineId: string,
    body: UpdateWmsPurchasingLineDto,
    requestedTenantId?: string,
  ) {
    const scope = await this.resolveTenantScope(requestedTenantId);
    if (!scope.activeTenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const line = await this.prisma.wmsPurchasingBatchLine.findUnique({
      where: { id: lineId },
      include: {
        batch: {
          select: {
            id: true,
            tenantId: true,
            storeId: true,
            requestType: true,
            status: true,
          },
        },
      },
    });

    if (!line || line.batchId !== batchId) {
      throw new NotFoundException('Purchasing line was not found');
    }

    this.assertBatchTenantScope(line.batch.tenantId, scope.activeTenantId);
    await this.validateResolutionTargets(
      line.batch.tenantId,
      line.batch.storeId,
      body.resolvedPosProductId,
      body.resolvedProfileId,
    );

    const approvedQuantity =
      body.approvedQuantity !== undefined ? body.approvedQuantity : line.approvedQuantity;
    const receivedQuantity =
      body.receivedQuantity !== undefined ? body.receivedQuantity : line.receivedQuantity;
    const maxReceivable = approvedQuantity ?? line.requestedQuantity;
    const currentEffectiveApprovedQuantity = line.approvedQuantity ?? line.requestedQuantity;
    const nextEffectiveApprovedQuantity = approvedQuantity ?? line.requestedQuantity;
    const nextPartnerUnitCost =
      body.partnerUnitCost === undefined
        ? this.toNumber(line.partnerUnitCost)
        : this.numberOrNull(body.partnerUnitCost);
    const nextSupplierUnitCost =
      line.batch.requestType === WmsPurchasingRequestType.SELF_BUY
        ? null
        : body.supplierUnitCost === undefined
          ? this.toNumber(line.supplierUnitCost)
          : this.numberOrNull(body.supplierUnitCost);
    const nextResolvedProfileId =
      body.resolvedProfileId === undefined ? line.resolvedProfileId : body.resolvedProfileId || null;
    const shouldSyncLineProfileCosts =
      Boolean(nextResolvedProfileId)
      && (
        body.supplierUnitCost !== undefined
        || body.partnerUnitCost !== undefined
        || body.resolvedProfileId !== undefined
      )
      && line.batch.requestType === WmsPurchasingRequestType.PROCUREMENT
      && line.batch.status !== WmsPurchasingBatchStatus.UNDER_REVIEW
      && line.batch.status !== WmsPurchasingBatchStatus.REVISION;
    // A supplier-only edit must not copy a stale purchasing partner price over
    // a newer WMS inhouse price. Explicit partner/resolution edits still do.
    const shouldSyncInhouseCost = shouldSyncLineProfileCosts
      && (body.partnerUnitCost !== undefined || body.resolvedProfileId !== undefined);
    const didChangeCommercialTerms =
      nextEffectiveApprovedQuantity !== currentEffectiveApprovedQuantity
      || nextPartnerUnitCost !== this.toNumber(line.partnerUnitCost)
      || nextSupplierUnitCost !== this.toNumber(line.supplierUnitCost);
    const shouldAutoRequestRevision =
      line.batch.status === WmsPurchasingBatchStatus.UNDER_REVIEW && didChangeCommercialTerms;

    if (approvedQuantity !== null && approvedQuantity !== undefined) {
      if (approvedQuantity > line.requestedQuantity) {
        throw new BadRequestException('Approved quantity cannot exceed requested quantity');
      }
    }

    if (receivedQuantity > maxReceivable) {
      throw new BadRequestException('Received quantity cannot exceed approved quantity');
    }

    const baseSnapshot = this.readLineSnapshot(line.sourceSnapshot);
    const originalPartnerUnitCost =
      baseSnapshot.originalPartnerUnitCost ?? this.toNumber(line.partnerUnitCost);
    const originalSupplierUnitCost =
      baseSnapshot.originalSupplierUnitCost ?? this.toNumber(line.supplierUnitCost);
    const nextSourceSnapshot = {
      ...baseSnapshot.raw,
      originalPartnerUnitCost,
      originalSupplierUnitCost,
      originalApprovedQuantity:
        baseSnapshot.originalApprovedQuantity ?? currentEffectiveApprovedQuantity,
    };

    await this.prisma.$transaction(async (tx) => {
      const prepared = shouldSyncInhouseCost && nextResolvedProfileId
        ? await this.wmsCogsSync.prepare(tx, line.batch.tenantId, [nextResolvedProfileId]) : null;
      await this.lockPurchasingCogsSource(tx, line.batch.tenantId, line.batchId, line.id);
      const fresh = await tx.wmsPurchasingBatchLine.findUnique({
        where: { id: line.id },
        include: { batch: { select: { id: true, tenantId: true, storeId: true, requestType: true, status: true } } },
      });
      if (!fresh || this.purchasingSourceVersion(fresh) !== this.purchasingSourceVersion(line)) {
        throw new ConflictException('Purchasing line changed; refresh before applying this edit');
      }
      const profileProducts = shouldSyncLineProfileCosts && nextResolvedProfileId
        ? await this.assertPurchasingCostProfiles(tx, line.batch.tenantId, [{ ...fresh,
          resolvedProfileId: nextResolvedProfileId,
          resolvedPosProductId: body.resolvedPosProductId === undefined ? fresh.resolvedPosProductId : body.resolvedPosProductId || null,
        }]) : new Map<string, string>();
      await tx.wmsPurchasingBatchLine.update({
        where: { id: line.id },
        data: {
          sourceSnapshot: nextSourceSnapshot as Prisma.InputJsonValue,
          approvedQuantity:
            body.approvedQuantity === undefined ? undefined : body.approvedQuantity,
          receivedQuantity:
            body.receivedQuantity === undefined ? undefined : body.receivedQuantity,
          partnerUnitCost:
            body.partnerUnitCost === undefined
              ? undefined
              : this.numberOrNull(body.partnerUnitCost),
          supplierUnitCost:
            line.batch.requestType === WmsPurchasingRequestType.SELF_BUY
              ? null
              : body.supplierUnitCost === undefined
              ? undefined
              : this.numberOrNull(body.supplierUnitCost),
          needsProfiling:
            body.needsProfiling === undefined
              ? body.resolvedProfileId
                ? false
                : undefined
              : body.needsProfiling,
          resolvedPosProductId:
            body.resolvedPosProductId === undefined
              ? undefined
              : body.resolvedPosProductId || null,
          resolvedProfileId:
            body.resolvedProfileId === undefined ? undefined : body.resolvedProfileId || null,
          notes: this.cleanOptionalText(body.notes) ?? undefined,
          updatedById: actorId,
        },
      });

      if (shouldSyncLineProfileCosts && nextResolvedProfileId) {
        await tx.wmsProductProfile.update({
          where: { id: nextResolvedProfileId, tenantId: line.batch.tenantId, posProductId: profileProducts.get(nextResolvedProfileId)! },
          data: {
            ...(nextSupplierUnitCost !== null ? { supplierUnitCost: nextSupplierUnitCost } : {}),
            ...(shouldSyncInhouseCost && nextPartnerUnitCost !== null ? { inhouseUnitCost: nextPartnerUnitCost } : {}),
          },
        });
      }
      if (prepared) await this.wmsCogsSync.syncAfter(tx, prepared, {
        source: 'WMS_PURCHASING_LINE', sourceRef: line.id, actorId,
      });

      await tx.wmsPurchasingBatch.update({
        where: { id: line.batchId },
        data: {
          status: shouldAutoRequestRevision ? WmsPurchasingBatchStatus.REVISION : undefined,
          sourceStatus: shouldAutoRequestRevision ? 'REVISION_REQUESTED' : undefined,
          reviewedById: shouldAutoRequestRevision ? actorId : undefined,
          updatedById: actorId,
        },
      });

      if (shouldAutoRequestRevision) {
        const event = await tx.wmsPurchasingEvent.create({
          data: {
            batchId: line.batchId,
            tenantId: line.batch.tenantId,
            eventType: 'STATUS_CHANGED',
            fromStatus: line.batch.status,
            toStatus: WmsPurchasingBatchStatus.REVISION,
            message: 'Revised quantity or pricing was sent back to the partner',
            actorId,
            payload: {
              trigger: 'LINE_UPDATE',
              lineId: line.id,
            },
          },
        });

        await this.syncPurchasingNotificationEvent(tx, event);
      }

      await tx.wmsPurchasingEvent.create({
        data: {
          batchId: line.batchId,
          tenantId: line.batch.tenantId,
          eventType: 'LINE_UPDATED',
          message: `Updated line ${line.lineNo}`,
          actorId,
          payload: {
            lineId: line.id,
            before: {
              approvedQuantity: line.approvedQuantity,
              partnerUnitCost: this.toNumber(line.partnerUnitCost),
              supplierUnitCost: this.toNumber(line.supplierUnitCost),
            },
            after: {
              approvedQuantity,
              partnerUnitCost: nextPartnerUnitCost,
              supplierUnitCost: nextSupplierUnitCost,
            },
            productProfileCostSynced: shouldSyncLineProfileCosts,
            autoRequestedRevision: shouldAutoRequestRevision,
          },
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 30000 });

    this.emitStockRequestUpdate({
      tenantId: line.batch.tenantId,
      batchId: line.batchId,
      status: shouldAutoRequestRevision ? WmsPurchasingBatchStatus.REVISION : line.batch.status,
      sourceStatus: shouldAutoRequestRevision ? 'REVISION_REQUESTED' : null,
      eventType: shouldAutoRequestRevision ? 'STATUS_CHANGED' : 'LINE_UPDATED',
    });

    return this.getBatchById(batchId, scope.activeTenantId);
  }

  private readPurchasingStatusSource(client: Pick<Prisma.TransactionClient, 'wmsPurchasingBatch'>, id: string) {
    return client.wmsPurchasingBatch.findUnique({ where: { id }, include: {
      paymentProofAsset: { select: { id: true } },
      lines: { orderBy: { lineNo: 'asc' }, select: {
        id: true, lineNo: true, tenantId: true, storeId: true, productId: true, variationId: true,
        sourceSnapshot: true, requestedQuantity: true, approvedQuantity: true,
        partnerUnitCost: true, supplierUnitCost: true, needsProfiling: true, resolvedProfileId: true, resolvedPosProductId: true, updatedAt: true,
      } },
    } });
  }

  private purchasingSourceVersion(value: unknown): string {
    const sort = (row: any): any => Array.isArray(row) ? row.map(sort)
      : row && typeof row === 'object' ? Object.fromEntries(Object.keys(row).sort().map(key => [key, sort(row[key])])) : row;
    return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
  }

  private async lockPurchasingCogsSource(tx: Prisma.TransactionClient, tenantId: string, batchId: string, lineId?: string) {
    const batches = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT id FROM wms_purchasing_batches WHERE id=$1::uuid AND "tenantId"=$2::uuid FOR UPDATE NOWAIT', batchId, tenantId);
    if (batches.length !== 1) throw new ConflictException('Purchasing scope changed; refresh before retrying');
    const lines = lineId
      ? await tx.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM wms_purchasing_batch_lines WHERE "batchId"=$1::uuid AND id=$2::uuid ORDER BY id FOR UPDATE NOWAIT', batchId, lineId)
      : await tx.$queryRawUnsafe<Array<{ id: string }>>('SELECT id FROM wms_purchasing_batch_lines WHERE "batchId"=$1::uuid ORDER BY id FOR UPDATE NOWAIT', batchId);
    if (lineId && lines.length !== 1) throw new ConflictException('Purchasing line changed; refresh before retrying');
  }

  private async assertPurchasingCostProfiles(tx: Prisma.TransactionClient, tenantId: string, lines: Array<{
    tenantId: string; storeId: string; productId: string | null; variationId: string | null;
    resolvedProfileId: string | null; resolvedPosProductId: string | null;
  }>): Promise<Map<string, string>> {
    const selected = lines.filter(line => line.resolvedProfileId);
    const ids = [...new Set(selected.map(line => line.resolvedProfileId!))].sort();
    if (!ids.length) return new Map();
    const read = () => tx.wmsProductProfile.findMany({ where: { id: { in: ids } }, include: {
      posProduct: { select: { id: true, storeId: true, productId: true, variationId: true, store: { select: { tenantId: true } } } },
    } });
    const assertRows = (profiles: Awaited<ReturnType<typeof read>>) => {
      const byId = new Map(profiles.map(profile => [profile.id, profile]));
      if (byId.size !== ids.length) throw new ConflictException('Purchasing product resolution requires review');
      for (const line of selected) {
        const profile = byId.get(line.resolvedProfileId!)!;
        const product = profile.posProduct;
        if (line.tenantId !== tenantId || profile.tenantId !== tenantId || product.store.tenantId !== tenantId
          || profile.storeId !== line.storeId || product.storeId !== line.storeId || product.id !== profile.posProductId
          || (line.resolvedPosProductId !== null && line.resolvedPosProductId !== profile.posProductId)
          || profile.productId !== product.productId || profile.variationId !== product.variationId
          || !product.productId.trim() || !product.variationId?.trim() || product.variationId === product.productId
          || (line.productId !== null && line.productId !== product.productId)
          || (line.variationId !== null && line.variationId !== product.variationId)) {
          throw new ConflictException('Purchasing product resolution changed; refresh before updating costs');
        }
      }
      return byId;
    };
    // Reject foreign pointers before locking their parents. Repeat the identity
    // read under sorted parent/profile locks, even when synchronization is off.
    const before = assertRows(await read());
    const productIds = [...new Set([...before.values()].map(profile => profile.posProductId))].sort();
    const parents = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
      SELECT p.id FROM pos_products p JOIN pos_stores s ON s.id=p."storeId"
      WHERE p.id=ANY($1::uuid[]) AND s."tenantId"=$2::uuid ORDER BY p.id FOR SHARE OF p,s NOWAIT`, productIds, tenantId);
    if (parents.length !== productIds.length) throw new ConflictException('Purchasing product scope changed; refresh before retrying');
    const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT id FROM wms_product_profiles WHERE id=ANY($1::uuid[]) AND "tenantId"=$2::uuid ORDER BY id FOR UPDATE NOWAIT', ids, tenantId);
    if (locked.length !== ids.length) throw new ConflictException('Purchasing profile scope changed; refresh before retrying');
    const after = assertRows(await read());
    if ([...after.values()].some(profile => profile.posProductId !== before.get(profile.id)?.posProductId)) {
      throw new ConflictException('Purchasing product resolution changed; refresh before updating costs');
    }
    return new Map([...after.values()].map(profile => [profile.id, profile.posProductId]));
  }

  private async syncAcceptedLineProfileCosts(
    client: Prisma.TransactionClient,
    tenantId: string,
    lines: Array<{
      resolvedProfileId: string | null;
      partnerUnitCost: Prisma.Decimal | number | null;
      supplierUnitCost: Prisma.Decimal | number | null;
    }>,
    profileProducts: Map<string, string>,
  ) {
    const costsByProfileId = new Map<string, {
      inhouseUnitCost?: number;
      supplierUnitCost?: number;
    }>();

    lines.forEach((line) => {
      if (!line.resolvedProfileId) {
        return;
      }

      const partnerUnitCost = this.toNumber(line.partnerUnitCost);
      const supplierUnitCost = this.toNumber(line.supplierUnitCost);
      if (partnerUnitCost === null && supplierUnitCost === null) {
        return;
      }

      costsByProfileId.set(line.resolvedProfileId, {
        ...(partnerUnitCost !== null ? { inhouseUnitCost: partnerUnitCost } : {}),
        ...(supplierUnitCost !== null ? { supplierUnitCost } : {}),
      });
    });

    for (const [profileId, costs] of costsByProfileId) {
      await client.wmsProductProfile.update({
        where: { id: profileId, tenantId, posProductId: profileProducts.get(profileId)! },
        data: costs,
      });
    }

    return costsByProfileId.size > 0;
  }

  private emitStockRequestUpdate(params: {
    tenantId: string;
    batchId: string;
    status: WmsPurchasingBatchStatus;
    sourceStatus: string | null;
    eventType: string;
  }) {
    this.workflowExecutionGateway.emitTenantEvent(
      params.tenantId,
      null,
      'stock-requests:updated',
      {
        tenantId: params.tenantId,
        batchId: params.batchId,
        status: params.status,
        sourceStatus: params.sourceStatus,
        eventType: params.eventType,
        updatedAt: new Date().toISOString(),
      },
    );
  }

  private async syncPurchasingNotificationEvent(
    client: Prisma.TransactionClient,
    event: {
      id: string;
      tenantId: string;
      batchId: string;
      eventType: string;
      fromStatus: WmsPurchasingBatchStatus | null;
      toStatus: WmsPurchasingBatchStatus | null;
      message: string | null;
      payload: Prisma.JsonValue | null;
    },
  ) {
    await this.notificationStateService.syncPurchasingBatchEvent(client, {
      tenantId: event.tenantId,
      batchId: event.batchId,
      sourceEventId: event.id,
      sourceEventType: event.eventType,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      context: {
        message: event.message,
        payload: event.payload,
      },
    });
  }

  private async computeSummaryCounts(where: Prisma.WmsPurchasingBatchWhereInput) {
    const [batches, procurement, selfBuy, readyForReceiving, underReview] = await Promise.all([
      this.prisma.wmsPurchasingBatch.count({ where }),
      this.prisma.wmsPurchasingBatch.count({
        where: {
          ...where,
          requestType: WmsPurchasingRequestType.PROCUREMENT,
        },
      }),
      this.prisma.wmsPurchasingBatch.count({
        where: {
          ...where,
          requestType: WmsPurchasingRequestType.SELF_BUY,
        },
      }),
      this.prisma.wmsPurchasingBatch.count({
        where: {
          ...where,
          status: {
            in: [
              WmsPurchasingBatchStatus.RECEIVING_READY,
              WmsPurchasingBatchStatus.SHIPPED,
            ],
          },
        },
      }),
      this.prisma.wmsPurchasingBatch.count({
        where: {
          ...where,
          status: {
            in: [
              WmsPurchasingBatchStatus.UNDER_REVIEW,
              WmsPurchasingBatchStatus.REVISION,
              WmsPurchasingBatchStatus.PAYMENT_REVIEW,
              WmsPurchasingBatchStatus.RECEIVING_EXCEPTION,
            ],
          },
        },
      }),
    ]);

    return {
      batches,
      procurement,
      selfBuy,
      readyForReceiving,
      underReview,
    };
  }

  private mapBatchListRow(batch: PurchasingBatchListRecord) {
    const aggregate = this.aggregateLineTotals(batch.lines);

    return {
      id: batch.id,
      requestType: batch.requestType,
      status: batch.status,
      sourceType: batch.sourceType,
      sourceRequestId: batch.sourceRequestId,
      sourceStatus: batch.sourceStatus,
      requestTitle: batch.requestTitle,
      store: {
        id: batch.store.id,
        name: batch.store.shopName || batch.store.name,
      },
      lineCount: batch.lines.length,
      requestedQuantity: aggregate.requestedQuantity,
      approvedQuantity: aggregate.approvedQuantity,
      receivedQuantity: aggregate.receivedQuantity,
      invoiceNumber: batch.invoiceNumber,
      invoiceAmount: this.toNumber(batch.invoiceAmount),
      paymentProofImageUrl: batch.paymentProofImageUrl,
      paymentSubmittedAt: batch.paymentSubmittedAt,
      paymentProofSubmittedAt: batch.paymentProofSubmittedAt,
      paymentVerifiedAt: batch.paymentVerifiedAt,
      readyForReceivingAt: batch.readyForReceivingAt,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    };
  }

  private async mapBatchDetail(
    batch: PurchasingBatchDetailRecord,
    invoiceBankDetails: InvoiceBankDetailsRecord | null,
    linkedInvoice: LinkedInvoiceSummary | null,
  ) {
    const listRow = {
      ...this.mapBatchListRow(batch),
      paymentProofImageUrl:
        await this.mediaAssetsService.createSignedAssetUrl(batch.paymentProofAsset)
        ?? batch.paymentProofImageUrl,
    };

    return {
      ...listRow,
      sourceRequestType: batch.sourceRequestType,
      sourceSnapshot: batch.sourceSnapshot,
      partnerNotes: batch.partnerNotes,
      wmsNotes: batch.wmsNotes,
      invoice: {
        number: listRow.invoiceNumber,
        amount: listRow.invoiceAmount,
        linked: linkedInvoice,
        bankDetails: invoiceBankDetails
          ? {
              warehouseId: null,
              warehouseCode: null,
              warehouseName: null,
              billingCompanyName: invoiceBankDetails.issuerCompanyName,
              billingAddress: invoiceBankDetails.issuerCompanyAddress,
              bankName: invoiceBankDetails.bankName,
              bankAccountName: invoiceBankDetails.bankAccountName,
              bankAccountNumber: invoiceBankDetails.bankAccountNumber,
              bankAccountType: invoiceBankDetails.bankAccountType,
              bankBranch: invoiceBankDetails.bankBranch,
              paymentInstructions: invoiceBankDetails.paymentInstructions,
            }
          : null,
        billTo: {
          tenantId: batch.tenant.id,
          tenantName: batch.tenant.name,
          tenantSlug: batch.tenant.slug,
          companyName:
            batch.tenant.billingCompanyName
            ?? invoiceBankDetails?.billingCompanyName
            ?? batch.tenant.name,
          billingAddress:
            batch.tenant.billingAddress
            ?? invoiceBankDetails?.billingAddress
            ?? null,
        },
      },
      paymentProofSubmittedBy: batch.paymentProofSubmittedBy
        ? {
            id: batch.paymentProofSubmittedBy.id,
            name: this.formatUserName(
              batch.paymentProofSubmittedBy.firstName,
              batch.paymentProofSubmittedBy.lastName,
            ),
            email: batch.paymentProofSubmittedBy.email,
          }
        : null,
      lines: batch.lines.map((line) => ({
        id: line.id,
        lineNo: line.lineNo,
        sourceItemId: line.sourceItemId,
        sourceSnapshot: line.sourceSnapshot,
        productId: line.productId,
        variationId: line.variationId,
        requestedProductName: line.requestedProductName,
        uom: line.uom,
        requestedQuantity: line.requestedQuantity,
        approvedQuantity: line.approvedQuantity,
        receivedQuantity: line.receivedQuantity,
        partnerUnitCost: this.toNumber(line.partnerUnitCost),
        supplierUnitCost: this.toNumber(line.supplierUnitCost),
        needsProfiling: line.needsProfiling,
        resolvedPosProduct: line.resolvedPosProduct
          ? {
              id: line.resolvedPosProduct.id,
              name: line.resolvedPosProduct.name,
              customId: line.resolvedPosProduct.customId,
            }
          : null,
        resolvedProfile: line.resolvedProfile
          ? {
              id: line.resolvedProfile.id,
              status: line.resolvedProfile.status,
              isSerialized: line.resolvedProfile.isSerialized,
            }
          : null,
        notes: line.notes,
        createdAt: line.createdAt,
        updatedAt: line.updatedAt,
      })),
      events: batch.events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        message: event.message,
        payload: event.payload,
        actor: event.actor
          ? {
              id: event.actor.id,
              name: this.formatUserName(event.actor.firstName, event.actor.lastName),
              email: event.actor.email,
            }
          : null,
        createdAt: event.createdAt,
      })),
    };
  }

  private async syncProcurementInvoiceForBatchTx(
    tx: Prisma.TransactionClient,
    batch: Prisma.WmsPurchasingBatchGetPayload<{
      include: {
        tenant: {
          select: {
            id: true;
            name: true;
            slug: true;
            billingCompanyName: true;
            billingAddress: true;
          };
        };
        lines: {
          orderBy: {
            lineNo: 'asc';
          };
          include: {
            store: {
              select: {
                id: true;
                name: true;
                shopName: true;
              };
            };
          };
        };
      };
    }>,
  ) {
    const targetStatus = this.mapProcurementBatchStatusToInvoiceStatus(batch.status);
    if (!targetStatus) {
      throw new BadRequestException('This procurement batch is not yet eligible for invoice creation');
    }

    const settings = await this.getInvoiceSettingsRecordTx(tx, batch.tenantId);
    const prefix = settings?.invoicePrefix ?? 'INV';
    const existing = await tx.wmsInvoice.findFirst({
      where: {
        tenantId: batch.tenantId,
        sourceType: WmsInvoiceSourceType.PROCUREMENT,
        sourceRefId: batch.id,
      },
      include: {
        lines: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const normalizedLines = batch.lines.map((line, index) => {
      const quantity = Math.max(0, line.approvedQuantity ?? line.requestedQuantity);
      const unitRate = this.toNumber(line.partnerUnitCost) ?? 0;
      return {
        lineNo: line.lineNo ?? index + 1,
        lineType: WmsInvoiceLineType.SOURCE,
        storeId: line.storeId,
        productId: this.cleanOptionalText(line.productId),
        variationId: this.cleanOptionalText(line.variationId),
        description:
          this.cleanOptionalText(line.requestedProductName)
          ?? `Purchasing line ${line.lineNo ?? index + 1}`,
        quantity,
        unitRate,
        amount: Number((quantity * unitRate).toFixed(2)),
        rateSource: 'INHOUSE_COGS',
      };
    });

    const totals = this.computeInvoiceTotals(normalizedLines);
    return this.upsertLinkedInvoiceTx(tx, {
      existingInvoiceId: existing?.id ?? null,
      tenant: batch.tenant,
      settings,
      sourceType: WmsInvoiceSourceType.PROCUREMENT,
      sourceRefId: batch.id,
      sourceRefCode: batch.sourceRequestId ?? batch.requestTitle ?? batch.id,
      invoiceNumber:
        this.cleanOptionalText(batch.invoiceNumber)
        ?? existing?.invoiceNumber
        ?? await this.generateNextInvoiceNumberTx(tx, batch.tenantId, prefix),
      status: targetStatus,
      issueDate:
        targetStatus === WmsInvoiceStatus.ISSUED
          ? existing?.issueDate ?? new Date()
          : existing?.issueDate ?? null,
      dueDate: existing?.dueDate ?? null,
      currency: existing?.currency ?? 'PHP',
      notes: batch.wmsNotes ?? existing?.notes ?? null,
      allowReissueOnChange: true,
      lines: normalizedLines,
      totals,
    });
  }

  private async syncManualReceivingInvoiceForBatchTx(
    tx: Prisma.TransactionClient,
    batch: Prisma.WmsReceivingBatchGetPayload<{
      include: {
        tenant: {
          select: {
            id: true;
            name: true;
            slug: true;
            billingCompanyName: true;
            billingAddress: true;
          };
        };
        lines: {
          orderBy: {
            lineNo: 'asc';
          };
          include: {
            store: {
              select: {
                id: true;
                name: true;
                shopName: true;
              };
            };
          };
        };
      };
    }>,
  ) {
    const settings = await this.getInvoiceSettingsRecordTx(tx, batch.tenantId);
    const prefix = settings?.invoicePrefix ?? 'INV';
    const existing = await tx.wmsInvoice.findFirst({
      where: {
        tenantId: batch.tenantId,
        sourceType: WmsInvoiceSourceType.MANUAL_RECEIVING,
        sourceRefId: batch.id,
      },
      include: {
        lines: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const normalizedLines = batch.lines.map((line, index) => {
      const quantity = Math.max(0, line.receivedQuantity || line.expectedQuantity);
      const unitRate = this.toNumber(line.unitCost) ?? 0;
      return {
        lineNo: line.lineNo ?? index + 1,
        lineType: WmsInvoiceLineType.SOURCE,
        storeId: line.storeId,
        productId: this.cleanOptionalText(line.productId),
        variationId: this.cleanOptionalText(line.variationId),
        description:
          this.cleanOptionalText(line.requestedProductName)
          ?? `Manual receiving line ${line.lineNo ?? index + 1}`,
        quantity,
        unitRate,
        amount: Number((quantity * unitRate).toFixed(2)),
        rateSource: 'MANUAL_RECEIVING_COGS',
      };
    });

    const totals = this.computeInvoiceTotals(normalizedLines);
    const issueDate = existing?.issueDate ?? batch.receivedAt ?? new Date();
    return this.upsertLinkedInvoiceTx(tx, {
      existingInvoiceId: existing?.id ?? null,
      tenant: batch.tenant,
      settings,
      sourceType: WmsInvoiceSourceType.MANUAL_RECEIVING,
      sourceRefId: batch.id,
      sourceRefCode: batch.code,
      invoiceNumber:
        existing?.invoiceNumber
        ?? await this.generateNextInvoiceNumberTx(tx, batch.tenantId, prefix),
      status: existing?.status ?? WmsInvoiceStatus.ISSUED,
      issueDate,
      dueDate: existing?.dueDate ?? issueDate,
      currency: existing?.currency ?? 'PHP',
      notes: batch.notes ?? existing?.notes ?? null,
      allowReissueOnChange: true,
      lines: normalizedLines,
      totals,
    });
  }

  private async upsertLinkedInvoiceTx(
    tx: Prisma.TransactionClient,
    input: {
      existingInvoiceId: string | null;
      tenant: {
        id: string;
        name: string;
        slug: string;
        billingCompanyName: string | null;
        billingAddress: string | null;
      };
      settings: Awaited<ReturnType<WmsPurchasingService['getInvoiceSettingsRecordTx']>>;
      sourceType: WmsInvoiceSourceType;
      sourceRefId: string;
      sourceRefCode: string;
      invoiceNumber: string;
      status: WmsInvoiceStatus;
      issueDate: Date | null;
      dueDate: Date | null;
      currency: string;
      notes: string | null;
      allowReissueOnChange?: boolean;
      lines: Array<{
        lineNo: number;
        lineType: WmsInvoiceLineType;
        storeId: string | null;
        productId: string | null;
        variationId: string | null;
        description: string;
        itemSubtext?: string | null;
        quantity: number;
        unitRate: number;
        amount: number;
        vatEnabled?: boolean;
        vatRate?: number;
        vatAmount?: number;
        rateSource: string | null;
      }>;
      totals: {
        lineCount: number;
        totalQuantity: number;
        subtotal: number;
        vatRate: number;
        vatTotal: number;
        totalAmount: number;
        amountDue: number;
      };
    },
  ) {
    const actorId = (this.cls.get('userId') as string | undefined) ?? null;
    const paymentProfile = this.resolveInvoicePaymentProfile(input.settings);

    if (input.existingInvoiceId) {
      const existing = await tx.wmsInvoice.findUnique({
        where: { id: input.existingInvoiceId },
        include: {
          lines: {
            orderBy: { lineNo: 'asc' },
          },
        },
      });

      if (!existing) {
        throw new NotFoundException('Linked invoice was not found');
      }

      const existingCustomLines = this.extractCustomInvoiceLines(existing.lines);
      const combinedLines = this.resequenceInvoiceLines([
        ...input.lines.map((line) => ({
          ...line,
          lineType: WmsInvoiceLineType.SOURCE,
        })),
        ...existingCustomLines,
      ]);
      const totals = this.applyInvoiceStatusToTotals(
        this.computeInvoiceTotals(combinedLines),
        input.status,
      );
      const sharedData = {
        sourceType: input.sourceType,
        sourceRefId: input.sourceRefId,
        sourceRefCode: input.sourceRefCode,
        status: input.status,
        invoiceNumber: input.invoiceNumber,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        currency: input.currency,
        notes: input.notes,
        issuerSnapshot: this.buildIssuerSnapshot(input.settings, input.tenant, paymentProfile),
        billToSnapshot: this.buildBillToSnapshot(input.tenant),
        paymentProfileSnapshot: this.buildPaymentProfileSnapshot(paymentProfile),
        totalsSnapshot: totals as Prisma.InputJsonValue,
        updatedById: actorId,
      } satisfies Prisma.WmsInvoiceUncheckedUpdateInput;

      const hasMaterialChanges = this.hasLinkedInvoiceMaterialChanges(existing, input);

      if (!hasMaterialChanges && existing.status === input.status) {
        const issueDateChanged =
          (existing.issueDate?.getTime() ?? null) !== (input.issueDate?.getTime() ?? null);
        const dueDateChanged =
          (existing.dueDate?.getTime() ?? null) !== (input.dueDate?.getTime() ?? null);

        if (issueDateChanged || dueDateChanged) {
          await tx.wmsInvoice.update({
            where: { id: existing.id },
            data: {
              issueDate: input.issueDate,
              dueDate: input.dueDate,
              updatedById: actorId,
            },
          });
        }

        return existing.id;
      }

      if (INVOICE_MUTABLE_STATUSES.has(existing.status)) {
        await tx.wmsInvoiceLine.deleteMany({
          where: { invoiceId: input.existingInvoiceId },
        });

        await tx.wmsInvoice.update({
          where: { id: input.existingInvoiceId },
          data: {
            ...sharedData,
            lines: {
              create: combinedLines.map((line) => ({
                tenantId: input.tenant.id,
                lineNo: line.lineNo,
                lineType: line.lineType,
                storeId: line.storeId,
                productId: line.productId,
                variationId: line.variationId,
                description: line.description,
                itemSubtext: line.itemSubtext ?? null,
                quantity: line.quantity,
                unitRate: new Prisma.Decimal(line.unitRate.toFixed(2)),
                amount: new Prisma.Decimal(line.amount.toFixed(2)),
                vatEnabled: line.vatEnabled ?? false,
                vatRate: new Prisma.Decimal((line.vatRate ?? 0).toFixed(2)),
                vatAmount: new Prisma.Decimal((line.vatAmount ?? 0).toFixed(2)),
                rateSource: line.rateSource,
                lineSnapshot: this.buildInvoiceLineSnapshot(line),
              })),
            },
          },
        });

        await this.recordInvoiceActivityTx(tx, {
          tenantId: input.tenant.id,
          actorId,
          actionType: hasMaterialChanges ? 'WMS_INVOICE_SYNCED' : 'WMS_INVOICE_STATUS_CHANGED',
          resourceId: existing.id,
          fromStatus: existing.status,
          toStatus: input.status,
          metadata: this.toJsonValue({
            sourceType: input.sourceType,
            sourceRefId: input.sourceRefId,
            sourceRefCode: input.sourceRefCode,
            invoiceNumber: input.invoiceNumber,
            materialChange: hasMaterialChanges,
            syncMode: 'UPDATE_DRAFT',
          }),
        });

        return input.existingInvoiceId;
      }

      if (hasMaterialChanges) {
        if (!input.allowReissueOnChange) {
          throw new BadRequestException(
            'Issued linked invoices cannot be changed automatically. Cancel or reissue the invoice first.',
          );
        }

        if (!INVOICE_REISSUABLE_STATUSES.has(existing.status)) {
          throw new BadRequestException(
            'This linked invoice cannot be changed automatically after payment verification.',
          );
        }

        await tx.wmsInvoice.update({
          where: { id: existing.id },
          data: {
            status: WmsInvoiceStatus.CANCELED,
            updatedById: actorId,
            totalsSnapshot: {
              ...this.readInvoiceTotals(existing.totalsSnapshot),
              amountDue: 0,
            } as Prisma.InputJsonValue,
          },
        });

        await this.recordInvoiceActivityTx(tx, {
          tenantId: input.tenant.id,
          actorId,
          actionType: 'WMS_INVOICE_REISSUED',
          resourceId: existing.id,
          fromStatus: existing.status,
          toStatus: WmsInvoiceStatus.CANCELED,
          metadata: this.toJsonValue({
            sourceType: input.sourceType,
            sourceRefId: input.sourceRefId,
            sourceRefCode: input.sourceRefCode,
            invoiceNumber: existing.invoiceNumber,
            syncMode: 'CANCEL_AND_REISSUE',
          }),
        });

        input = {
          ...input,
          existingInvoiceId: null,
          lines: combinedLines,
          totals,
          invoiceNumber: await this.generateNextInvoiceNumberTx(
            tx,
            input.tenant.id,
            input.settings?.invoicePrefix ?? 'INV',
          ),
        };
      } else {
        await tx.wmsInvoice.update({
          where: { id: existing.id },
          data: {
            status: input.status,
            issueDate: input.issueDate,
            dueDate: input.dueDate,
            notes: input.notes,
            updatedById: actorId,
            totalsSnapshot: totals as Prisma.InputJsonValue,
          },
        });

        await this.recordInvoiceActivityTx(tx, {
          tenantId: input.tenant.id,
          actorId,
          actionType: 'WMS_INVOICE_STATUS_CHANGED',
          resourceId: existing.id,
          fromStatus: existing.status,
          toStatus: input.status,
          metadata: this.toJsonValue({
            sourceType: input.sourceType,
            sourceRefId: input.sourceRefId,
            sourceRefCode: input.sourceRefCode,
            invoiceNumber: existing.invoiceNumber,
            materialChange: false,
            syncMode: 'STATUS_ONLY',
          }),
        });

        return existing.id;
      }
    }

    const createdLines = this.resequenceInvoiceLines(
      input.lines.map((line) => ({
        ...line,
        lineType: line.lineType ?? WmsInvoiceLineType.SOURCE,
      })),
    );
    const totals = this.applyInvoiceStatusToTotals(
      this.computeInvoiceTotals(createdLines),
      input.status,
    );
    const sharedData = {
      sourceType: input.sourceType,
      sourceRefId: input.sourceRefId,
      sourceRefCode: input.sourceRefCode,
      status: input.status,
      invoiceNumber: input.invoiceNumber,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      currency: input.currency,
      notes: input.notes,
      issuerSnapshot: this.buildIssuerSnapshot(input.settings, input.tenant, paymentProfile),
      billToSnapshot: this.buildBillToSnapshot(input.tenant),
      paymentProfileSnapshot: this.buildPaymentProfileSnapshot(paymentProfile),
      totalsSnapshot: totals as Prisma.InputJsonValue,
      updatedById: actorId,
    } satisfies Prisma.WmsInvoiceUncheckedUpdateInput;

    const created = await tx.wmsInvoice.create({
      data: {
        tenantId: input.tenant.id,
        createdById: actorId,
        ...sharedData,
        lines: {
          create: createdLines.map((line) => ({
            tenantId: input.tenant.id,
            lineNo: line.lineNo,
            lineType: line.lineType,
            storeId: line.storeId,
            productId: line.productId,
            variationId: line.variationId,
            description: line.description,
            itemSubtext: line.itemSubtext ?? null,
            quantity: line.quantity,
            unitRate: new Prisma.Decimal(line.unitRate.toFixed(2)),
            amount: new Prisma.Decimal(line.amount.toFixed(2)),
            vatEnabled: line.vatEnabled ?? false,
            vatRate: new Prisma.Decimal((line.vatRate ?? 0).toFixed(2)),
            vatAmount: new Prisma.Decimal((line.vatAmount ?? 0).toFixed(2)),
            rateSource: line.rateSource,
            lineSnapshot: this.buildInvoiceLineSnapshot(line),
          })),
        },
      },
      select: { id: true },
    });

    await this.recordInvoiceActivityTx(tx, {
      tenantId: input.tenant.id,
      actorId,
      actionType: 'WMS_INVOICE_CREATED',
      resourceId: created.id,
      toStatus: input.status,
      metadata: this.toJsonValue({
        sourceType: input.sourceType,
        sourceRefId: input.sourceRefId,
        sourceRefCode: input.sourceRefCode,
        invoiceNumber: input.invoiceNumber,
        lineCount: createdLines.length,
        totalAmount: totals.totalAmount,
        origin: 'LINKED',
      }),
    });

    return created.id;
  }

  private mapProcurementBatchStatusToInvoiceStatus(status: WmsPurchasingBatchStatus) {
    switch (status) {
      case WmsPurchasingBatchStatus.PENDING_PAYMENT:
        return WmsInvoiceStatus.ISSUED;
      case WmsPurchasingBatchStatus.PAYMENT_REVIEW:
        return WmsInvoiceStatus.PAID_PENDING_VERIFY;
      case WmsPurchasingBatchStatus.RECEIVING_READY:
      case WmsPurchasingBatchStatus.RECEIVING:
      case WmsPurchasingBatchStatus.STOCKED:
        return WmsInvoiceStatus.PAID_VERIFIED;
      case WmsPurchasingBatchStatus.REJECTED:
      case WmsPurchasingBatchStatus.CANCELED:
        return WmsInvoiceStatus.CANCELED;
      default:
        return null;
    }
  }

  private hasLinkedInvoiceMaterialChanges(
    existing: Prisma.WmsInvoiceGetPayload<{
      include: {
        lines: true;
      };
    }>,
    input: {
      sourceType: WmsInvoiceSourceType;
      sourceRefId: string;
      sourceRefCode: string;
      currency: string;
      notes: string | null;
      lines: Array<{
        lineNo: number;
        lineType: WmsInvoiceLineType;
        storeId: string | null;
        productId: string | null;
        variationId: string | null;
        description: string;
        quantity: number;
        unitRate: number;
        amount: number;
        rateSource: string | null;
      }>;
      totals: {
        lineCount: number;
        totalQuantity: number;
        subtotal: number;
        totalAmount: number;
        amountDue: number;
      };
    },
  ) {
    if (
      existing.sourceType !== input.sourceType
      || existing.sourceRefId !== input.sourceRefId
      || existing.sourceRefCode !== input.sourceRefCode
      || existing.currency !== input.currency
      || (existing.notes ?? null) !== (input.notes ?? null)
    ) {
      return true;
    }

    const existingLines = existing.lines
      .filter((line) => line.lineType !== WmsInvoiceLineType.CUSTOM)
      .map((line) => ({
        lineNo: line.lineNo,
        storeId: line.storeId ?? null,
        productId: line.productId ?? null,
        variationId: line.variationId ?? null,
        description: line.description,
        quantity: line.quantity,
        unitRate: this.toNumber(line.unitRate) ?? 0,
        amount: this.toNumber(line.amount) ?? 0,
        rateSource: line.rateSource ?? null,
      }))
      .sort((left, right) => left.lineNo - right.lineNo);
    const nextLines = [...input.lines].sort((left, right) => left.lineNo - right.lineNo);

    if (existingLines.length !== nextLines.length) {
      return true;
    }

    for (let index = 0; index < existingLines.length; index += 1) {
      const left = existingLines[index];
      const right = nextLines[index];
      if (
        left.lineNo !== right.lineNo
        || left.storeId !== right.storeId
        || left.productId !== right.productId
        || left.variationId !== right.variationId
        || left.description !== right.description
        || left.quantity !== right.quantity
        || left.unitRate !== right.unitRate
        || left.amount !== right.amount
        || left.rateSource !== right.rateSource
      ) {
        return true;
      }
    }

    return false;
  }

  private async recordInvoiceActivityTx(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      actorId: string | null;
      actionType: string;
      resourceId: string;
      fromStatus?: string | null;
      toStatus?: string | null;
      metadata?: Prisma.InputJsonValue;
    },
  ) {
    await tx.wmsStaffActivity.create({
      data: {
        tenantId: input.tenantId,
        actorId: input.actorId,
        actionType: input.actionType,
        resourceType: 'WMS_INVOICE',
        resourceId: input.resourceId,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
  }

  private async findLinkedInvoiceSummary(input: {
    tenantId: string;
    sourceType: WmsInvoiceSourceType;
    sourceRefId: string;
  }) {
    const invoice = await this.prisma.wmsInvoice.findFirst({
      where: {
        tenantId: input.tenantId,
        sourceType: input.sourceType,
        sourceRefId: input.sourceRefId,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        sourceType: true,
        status: true,
        invoiceNumber: true,
        currency: true,
        issueDate: true,
        dueDate: true,
        totalsSnapshot: true,
      },
    });

    if (!invoice) {
      return null;
    }

    const totals = this.readInvoiceTotals(invoice.totalsSnapshot);
    return {
      id: invoice.id,
      sourceType: invoice.sourceType,
      status: invoice.status,
      invoiceNumber: invoice.invoiceNumber,
      currency: invoice.currency,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      totalAmount: totals.totalAmount ?? 0,
      amountDue: totals.amountDue ?? totals.totalAmount ?? 0,
    } satisfies LinkedInvoiceSummary;
  }

  private async resolvePaymentProofAsset(assetId: string | null | undefined, tenantId: string) {
    const normalized = this.cleanOptionalText(assetId);
    if (!normalized) {
      return null;
    }

    return this.mediaAssetsService.assertTenantOwnedPaymentProofAsset(normalized, tenantId);
  }

  private async resolveInvoiceBankDetails(
    tenantId: string,
  ): Promise<InvoiceBankDetailsRecord | null> {
    const [tenant, settings] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          billingCompanyName: true,
          billingAddress: true,
        },
      }),
      this.findEffectiveInvoiceSettingsRecord(tenantId),
    ]);

    if (!tenant && !settings) {
      return null;
    }

    return {
      tenantId: tenant?.id ?? tenantId,
      tenantName: tenant?.name ?? '',
      tenantSlug: tenant?.slug ?? '',
      billingCompanyName: tenant?.billingCompanyName ?? null,
      billingAddress: tenant?.billingAddress ?? null,
      issuerCompanyName: settings?.companyName ?? null,
      issuerCompanyAddress: settings?.companyAddress ?? null,
      bankName: settings?.bankName ?? null,
      bankAccountName: settings?.bankAccountName ?? null,
      bankAccountNumber: settings?.bankAccountNumber ?? null,
      bankAccountType: settings?.bankAccountType ?? null,
      bankBranch: settings?.bankBranch ?? null,
      paymentInstructions: settings?.paymentInstructions ?? null,
    };
  }

  private generateInvoiceNumber() {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `INV-${stamp}-${suffix}`;
  }

  private computeInvoiceAmountFromLines(
    lines: Array<{
      requestedQuantity: number;
      approvedQuantity: number | null;
      partnerUnitCost: Prisma.Decimal | number | null;
    }>,
  ) {
    const amount = lines.reduce((sum, line) => {
      const quantity = line.approvedQuantity ?? line.requestedQuantity;
      const unitCost =
        typeof line.partnerUnitCost === 'number'
          ? line.partnerUnitCost
          : line.partnerUnitCost
            ? Number(line.partnerUnitCost)
            : 0;

      return sum + quantity * unitCost;
    }, 0);

    return amount > 0 ? amount : null;
  }

  private aggregateLineTotals(
    lines: Array<{
      requestedQuantity: number;
      approvedQuantity: number | null;
      receivedQuantity: number;
    }>,
  ) {
    return lines.reduce<{
      requestedQuantity: number;
      approvedQuantity: number;
      receivedQuantity: number;
    }>(
      (acc, line) => {
        acc.requestedQuantity += line.requestedQuantity;
        acc.approvedQuantity += line.approvedQuantity ?? line.requestedQuantity;
        acc.receivedQuantity += line.receivedQuantity;
        return acc;
      },
      {
        requestedQuantity: 0,
        approvedQuantity: 0,
        receivedQuantity: 0,
      },
    );
  }

  private async normalizeCreateLines(input: {
    tenantId: string;
    storeId: string;
    requestType: WmsPurchasingRequestType;
    lines: CreateWmsPurchasingBatchLineInput[];
  }) {
    const usedLineNos = new Set<number>();
    const normalized: Array<{
      tenantId: string;
      storeId: string;
      lineNo: number;
      sourceItemId: string | null;
      sourceSnapshot: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined;
      productId: string | null;
      variationId: string | null;
      requestedProductName: string | null;
      uom: string | null;
      requestedQuantity: number;
      approvedQuantity: number | null;
      partnerUnitCost: number | null;
      supplierUnitCost: number | null;
      needsProfiling: boolean;
      resolvedPosProductId: string | null;
      resolvedProfileId: string | null;
      notes: string | null;
    }> = [];

    for (let index = 0; index < input.lines.length; index += 1) {
      const line = input.lines[index];
      const lineNo = line.lineNo ?? index + 1;
      const lineStoreId = line.storeId ?? input.storeId;

      if (usedLineNos.has(lineNo)) {
        throw new BadRequestException(`Duplicate line number detected: ${lineNo}`);
      }
      usedLineNos.add(lineNo);

      if (line.approvedQuantity !== undefined && line.approvedQuantity > line.requestedQuantity) {
        throw new BadRequestException(
          `Line ${lineNo}: approved quantity cannot exceed requested quantity`,
        );
      }

      const resolutionTargets = await this.validateResolutionTargets(
        input.tenantId,
        lineStoreId,
        line.resolvedPosProductId,
        line.resolvedProfileId,
      );

      const requestedVariationId = this.cleanOptionalText(line.variationId);
      const resolvedVariationId =
        resolutionTargets.profile?.variationId
        ?? resolutionTargets.posProduct?.variationId
        ?? null;
      const canonicalVariationId = requestedVariationId ?? resolvedVariationId;

      if (!canonicalVariationId) {
        throw new BadRequestException(
          `Line ${lineNo}: this product is not stockable because it is missing a variation ID`,
        );
      }

      if (line.productId && this.isLegacyVariationMapping(line.productId, canonicalVariationId)) {
        throw new BadRequestException(
          `Line ${lineNo}: this product still uses a legacy variation mapping. Sync this product first.`,
        );
      }

      if (requestedVariationId && resolvedVariationId && requestedVariationId !== resolvedVariationId) {
        throw new BadRequestException(
          `Line ${lineNo}: variation ID does not match the selected stockable product`,
        );
      }

      if (line.productId && canonicalVariationId === line.productId) {
        const canonicalVariationProducts = await this.prisma.posProduct.findMany({
          where: {
            storeId: lineStoreId,
            productId: line.productId,
            variationId: {
              not: null,
            },
          },
          select: {
            variationId: true,
          },
        });
        const canonicalVariationProduct = canonicalVariationProducts.find(
          (product) => this.isStockableVariation(line.productId!, product.variationId),
        );

        if (
          canonicalVariationProduct?.variationId
          && canonicalVariationProduct.variationId !== line.productId
        ) {
          throw new BadRequestException(
            `Line ${lineNo}: request must use variation ID ${canonicalVariationProduct.variationId}, not product ID ${line.productId}`,
          );
        }
      }

      if (lineStoreId !== input.storeId) {
        await this.validateStore(input.tenantId, lineStoreId);
      }

      const partnerUnitCost = this.numberOrNull(line.partnerUnitCost);
      const supplierUnitCost =
        input.requestType === WmsPurchasingRequestType.SELF_BUY
          ? null
          : this.numberOrNull(line.supplierUnitCost);

      if (
        input.requestType === WmsPurchasingRequestType.SELF_BUY
        && (partnerUnitCost === null || partnerUnitCost <= 0)
      ) {
        throw new BadRequestException(
          `Line ${lineNo}: self-buy actual unit COGS is required`,
        );
      }

      normalized.push({
        tenantId: input.tenantId,
        storeId: lineStoreId,
        lineNo,
        sourceItemId: this.cleanOptionalText(line.sourceItemId),
        sourceSnapshot: this.toJsonValue({
          ...(line.sourceSnapshot ?? {}),
          storeId: lineStoreId,
          originalPartnerUnitCost: partnerUnitCost,
          originalSupplierUnitCost: supplierUnitCost,
          originalApprovedQuantity: line.approvedQuantity ?? line.requestedQuantity,
        }),
        productId: this.cleanOptionalText(line.productId),
        variationId: canonicalVariationId,
        requestedProductName: this.cleanOptionalText(line.requestedProductName),
        uom: this.cleanOptionalText(line.uom),
        requestedQuantity: line.requestedQuantity,
        approvedQuantity: line.approvedQuantity ?? null,
        partnerUnitCost,
        supplierUnitCost,
        needsProfiling:
          line.needsProfiling ?? (input.requestType === WmsPurchasingRequestType.SELF_BUY && !line.resolvedProfileId),
        resolvedPosProductId: line.resolvedPosProductId ?? null,
        resolvedProfileId: line.resolvedProfileId ?? null,
        notes: this.cleanOptionalText(line.notes),
      });
    }

    return normalized;
  }

  private hasCommercialRevisionChanges(
    lines: Array<{
      sourceSnapshot?: Prisma.JsonValue | null;
      requestedQuantity: number;
      approvedQuantity: number | null;
      partnerUnitCost: Prisma.Decimal | number | null;
      supplierUnitCost?: Prisma.Decimal | number | null;
    }>,
  ) {
    return lines.some((line) => {
      const snapshot = this.readLineSnapshot(line.sourceSnapshot);
      const originalPartnerUnitCost =
        snapshot.originalPartnerUnitCost ?? this.toNumber(line.partnerUnitCost);
      const originalSupplierUnitCost =
        snapshot.originalSupplierUnitCost ?? this.toNumber(line.supplierUnitCost ?? null);
      const originalApprovedQuantity =
        snapshot.originalApprovedQuantity ?? line.requestedQuantity;

      return (
        (line.approvedQuantity ?? line.requestedQuantity) !== originalApprovedQuantity
        || this.toNumber(line.partnerUnitCost) !== originalPartnerUnitCost
        || this.toNumber(line.supplierUnitCost ?? null) !== originalSupplierUnitCost
      );
    });
  }

  private readLineSnapshot(sourceSnapshot: Prisma.JsonValue | null | undefined) {
    const raw =
      sourceSnapshot && typeof sourceSnapshot === 'object' && !Array.isArray(sourceSnapshot)
        ? (sourceSnapshot as Record<string, unknown>)
        : {};

    const asNumber = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    return {
      raw,
      originalPartnerUnitCost: asNumber(raw.originalPartnerUnitCost),
      originalSupplierUnitCost: asNumber(raw.originalSupplierUnitCost),
      originalApprovedQuantity: asNumber(raw.originalApprovedQuantity),
    };
  }

  private validateReadyForReceiving(input: {
    requestType: WmsPurchasingRequestType;
    lines: Array<{
      lineNo: number;
      requestedQuantity: number;
      approvedQuantity: number | null;
      partnerUnitCost?: Prisma.Decimal | number | null;
      needsProfiling: boolean;
      resolvedProfileId: string | null;
    }>;
    invoiceNumber?: string | null;
    paymentVerifiedAt?: Date | string | null;
  }) {
    if (!input.lines.length) {
      throw new BadRequestException('Cannot mark ready for receiving without line items');
    }

    input.lines.forEach((line) => {
      const approved = line.approvedQuantity ?? line.requestedQuantity;
      if (approved <= 0) {
        throw new BadRequestException(
          `Line ${line.lineNo}: approved quantity must be greater than zero`,
        );
      }
    });

    if (input.requestType === WmsPurchasingRequestType.SELF_BUY) {
      const unresolved = input.lines.find(
        (line) => line.needsProfiling || !line.resolvedProfileId,
      );
      if (unresolved) {
        throw new BadRequestException(
          `Line ${unresolved.lineNo}: self-buy requests must resolve product profiling before receiving handoff`,
        );
      }

      const missingUnitCost = input.lines.find((line) => {
        const partnerUnitCost = this.toNumber(line.partnerUnitCost ?? null);
        return partnerUnitCost === null || partnerUnitCost <= 0;
      });
      if (missingUnitCost) {
        throw new BadRequestException(
          `Line ${missingUnitCost.lineNo}: self-buy actual unit COGS is required`,
        );
      }
    }

    if (input.requestType === WmsPurchasingRequestType.PROCUREMENT) {
      const hasInvoice = Boolean(this.cleanOptionalText(input.invoiceNumber ?? null));
      const hasPaymentVerification = Boolean(input.paymentVerifiedAt);
      if (!hasInvoice || !hasPaymentVerification) {
        throw new BadRequestException(
          'Procurement requests require invoice number and verified payment before receiving handoff',
        );
      }
    }
  }

  private getAllowedStatusTransitions(
    requestType: WmsPurchasingRequestType,
    status: WmsPurchasingBatchStatus,
  ) {
    return requestType === WmsPurchasingRequestType.SELF_BUY
      ? SELF_BUY_STATUS_TRANSITIONS[status]
      : PROCUREMENT_STATUS_TRANSITIONS[status];
  }

  private requiresOperationalReadinessValidation(
    requestType: WmsPurchasingRequestType,
    status: WmsPurchasingBatchStatus,
  ) {
    return (
      (
        requestType === WmsPurchasingRequestType.PROCUREMENT
        && status === WmsPurchasingBatchStatus.RECEIVING_READY
      )
      || (
        requestType === WmsPurchasingRequestType.SELF_BUY
        && status === WmsPurchasingBatchStatus.AWAITING_PRODUCTS
      )
    );
  }

  private isReadyForReceivingQueueStatus(status: WmsPurchasingBatchStatus) {
    return (
      status === WmsPurchasingBatchStatus.RECEIVING_READY
      || status === WmsPurchasingBatchStatus.SHIPPED
    );
  }

  private resolveReadyForReceivingAt(
    currentValue: Date | null,
    nextStatus: WmsPurchasingBatchStatus,
    now: Date,
  ) {
    if (this.isReadyForReceivingQueueStatus(nextStatus)) {
      return now;
    }

    if (
      nextStatus === WmsPurchasingBatchStatus.AWAITING_PRODUCTS
      || nextStatus === WmsPurchasingBatchStatus.RECEIVING_EXCEPTION
      || nextStatus === WmsPurchasingBatchStatus.PENDING_PAYMENT
      || nextStatus === WmsPurchasingBatchStatus.PAYMENT_REVIEW
      || nextStatus === WmsPurchasingBatchStatus.REVISION
      || nextStatus === WmsPurchasingBatchStatus.REJECTED
      || nextStatus === WmsPurchasingBatchStatus.CANCELED
    ) {
      return null;
    }

    return currentValue ?? undefined;
  }

  private async validateStore(tenantId: string, storeId: string) {
    const store = await this.prisma.posStore.findFirst({
      where: {
        id: storeId,
        tenantId,
      },
      select: { id: true },
    });

    if (!store) {
      throw new BadRequestException('Selected store is outside tenant scope');
    }
  }

  private async validateResolutionTargets(
    tenantId: string,
    storeId: string,
    resolvedPosProductId?: string,
    resolvedProfileId?: string,
  ) {
    let resolvedPosProduct:
      | {
          id: string;
          productId: string;
          variationId: string | null;
        }
      | null = null;

    if (resolvedPosProductId) {
      const posProduct = await this.prisma.posProduct.findFirst({
        where: {
          id: resolvedPosProductId,
          storeId,
          store: {
            tenantId,
          },
        },
        select: {
          id: true,
          productId: true,
          variationId: true,
        },
      });

      if (!posProduct) {
        throw new BadRequestException('Resolved POS product is outside tenant/store scope');
      }

      if (!this.isStockableVariation(posProduct.productId, posProduct.variationId)) {
        throw new BadRequestException(
          this.getStockabilityReason(posProduct.productId, posProduct.variationId),
        );
      }

      resolvedPosProduct = posProduct;
    }

    let resolvedProfile:
      | {
          id: string;
          posProductId: string;
          variationId: string;
          posProduct: {
            productId: string;
            variationId: string | null;
          };
        }
      | null = null;

    if (resolvedProfileId) {
      const profile = await this.prisma.wmsProductProfile.findFirst({
        where: {
          id: resolvedProfileId,
          tenantId,
          storeId,
        },
        select: {
          id: true,
          posProductId: true,
          variationId: true,
          posProduct: {
            select: {
              productId: true,
              variationId: true,
            },
          },
        },
      });

      if (!profile) {
        throw new BadRequestException('Resolved product profile is outside tenant/store scope');
      }

      if (resolvedPosProductId && profile.posProductId !== resolvedPosProductId) {
        throw new BadRequestException(
          'Resolved product profile does not match the selected POS product',
        );
      }

      if (!this.isStockableVariation(profile.posProduct.productId, profile.posProduct.variationId)) {
        throw new BadRequestException(
          this.getStockabilityReason(profile.posProduct.productId, profile.posProduct.variationId),
        );
      }

      if (!this.isStockableVariation(profile.posProduct.productId, profile.variationId)) {
        throw new BadRequestException(
          'Resolved product profile still uses a legacy variation mapping. Sync this product first.',
        );
      }

      resolvedProfile = profile;
    }

    return {
      posProduct: resolvedPosProduct,
      profile: resolvedProfile,
    };
  }

  private assertBatchTenantScope(batchTenantId: string, activeTenantId: string) {
    if (batchTenantId !== activeTenantId) {
      throw new ForbiddenException('Selected purchasing batch is outside your WMS scope');
    }
  }

  private mapInvoiceListRow(invoice: WmsInvoiceListRecord) {
    const totals = this.readInvoiceTotals(invoice.totalsSnapshot);
    const totalQuantity = invoice.lines.reduce((sum, line) => sum + line.quantity, 0);
    const totalAmount = invoice.lines.reduce(
      (sum, line) => sum + (this.toNumber(line.amount) ?? 0),
      0,
    );

    return {
      id: invoice.id,
      tenantId: invoice.tenantId,
      sourceType: invoice.sourceType,
      sourceRefId: invoice.sourceRefId,
      sourceRefCode: invoice.sourceRefCode,
      status: invoice.status,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      notes: invoice.notes,
      lineCount: invoice.lines.length,
      totalQuantity,
      totalAmount: totals.totalAmount ?? totalAmount,
      amountDue: totals.amountDue ?? totalAmount,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
    };
  }

  private mapInvoiceDetail(
    invoice: WmsInvoiceDetailRecord,
    activities: WmsInvoiceActivityRecord[] = [],
  ) {
    const totals = this.readInvoiceTotals(invoice.totalsSnapshot);
    const issuerSnapshot = this.asJsonRecord(invoice.issuerSnapshot) ?? {};
    const billToSnapshot = this.asJsonRecord(invoice.billToSnapshot) ?? {};
    const paymentProfileSnapshot = this.asJsonRecord(invoice.paymentProfileSnapshot) ?? {};

    return {
      ...this.mapInvoiceListRow(invoice),
      issuer: issuerSnapshot,
      billTo: billToSnapshot,
      paymentProfile: paymentProfileSnapshot,
      totals,
      lines: invoice.lines.map((line) => ({
        id: line.id,
        lineNo: line.lineNo,
        lineType: line.lineType,
        storeId: line.storeId,
        store: line.store
          ? {
              id: line.store.id,
              name: line.store.shopName || line.store.name,
            }
          : null,
        productId: line.productId,
        variationId: line.variationId,
        description: line.description,
        itemSubtext: line.itemSubtext,
        quantity: line.quantity,
        unitRate: this.toNumber(line.unitRate) ?? 0,
        amount: this.toNumber(line.amount) ?? 0,
        vatEnabled: line.vatEnabled,
        vatRate: this.toNumber(line.vatRate) ?? 0,
        vatAmount: this.toNumber(line.vatAmount) ?? 0,
        rateSource: line.rateSource,
        lineSnapshot: line.lineSnapshot,
        createdAt: line.createdAt,
        updatedAt: line.updatedAt,
      })),
      activities: activities.map((activity) => ({
        id: activity.id,
        actionType: activity.actionType,
        fromStatus: activity.fromStatus,
        toStatus: activity.toStatus,
        metadata: activity.metadata,
        actor: activity.actor
          ? {
              id: activity.actor.id,
              name: this.formatUserName(activity.actor.firstName, activity.actor.lastName),
              email: activity.actor.email,
            }
          : null,
        createdAt: activity.createdAt,
      })),
    };
  }

  private async requireInvoiceTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        billingCompanyName: true,
        billingAddress: true,
      },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant was not found');
    }

    return tenant;
  }

  private async getInvoiceSettingsRecordTx(tx: Prisma.TransactionClient, tenantId: string) {
    const globalSettings = await tx.wmsInvoiceSettings.findFirst({
      where: {
        scopeKey: GLOBAL_WMS_INVOICE_SETTINGS_SCOPE,
      },
      select: {
        id: true,
        companyName: true,
        companyAddress: true,
        invoicePrefix: true,
        bankName: true,
        bankAccountName: true,
        bankAccountNumber: true,
        bankAccountType: true,
        bankBranch: true,
        paymentInstructions: true,
        footerNotes: true,
        partnerBillingCompanyName: true,
        partnerBillingAddress: true,
        paymentProfiles: {
          orderBy: [
            { isDefault: 'desc' },
            { sortOrder: 'asc' },
            { name: 'asc' },
          ],
        },
      },
    });

    if (globalSettings) {
      return globalSettings;
    }

    return tx.wmsInvoiceSettings.findFirst({
      where: {
        tenantId,
      },
      select: {
        id: true,
        companyName: true,
        companyAddress: true,
        invoicePrefix: true,
        bankName: true,
        bankAccountName: true,
        bankAccountNumber: true,
        bankAccountType: true,
        bankBranch: true,
        paymentInstructions: true,
        footerNotes: true,
        partnerBillingCompanyName: true,
        partnerBillingAddress: true,
        paymentProfiles: {
          orderBy: [
            { isDefault: 'desc' },
            { sortOrder: 'asc' },
            { name: 'asc' },
          ],
        },
      },
    });
  }

  private async findEffectiveInvoiceSettingsRecord(tenantId: string) {
    const globalSettings = await this.prisma.wmsInvoiceSettings.findFirst({
      where: {
        scopeKey: GLOBAL_WMS_INVOICE_SETTINGS_SCOPE,
      },
      include: {
        paymentProfiles: {
          orderBy: [
            { isDefault: 'desc' },
            { sortOrder: 'asc' },
            { name: 'asc' },
          ],
        },
      },
    });

    if (globalSettings) {
      return globalSettings;
    }

    return this.prisma.wmsInvoiceSettings.findFirst({
      where: {
        tenantId,
      },
      include: {
        paymentProfiles: {
          orderBy: [
            { isDefault: 'desc' },
            { sortOrder: 'asc' },
            { name: 'asc' },
          ],
        },
      },
    });
  }

  private async findEffectiveInvoiceSettingsWithLogo(tenantId: string) {
    const globalSettings = await this.prisma.wmsInvoiceSettings.findFirst({
      where: {
        scopeKey: GLOBAL_WMS_INVOICE_SETTINGS_SCOPE,
      },
      include: {
        logoAsset: {
          select: {
            id: true,
            objectKey: true,
            contentType: true,
            byteSize: true,
            width: true,
            height: true,
            originalFileName: true,
          },
        },
        paymentProfiles: {
          orderBy: [
            { isDefault: 'desc' },
            { sortOrder: 'asc' },
            { name: 'asc' },
          ],
        },
      },
    });

    if (globalSettings) {
      return globalSettings;
    }

    return this.prisma.wmsInvoiceSettings.findFirst({
      where: {
        tenantId,
      },
      include: {
        logoAsset: {
          select: {
            id: true,
            objectKey: true,
            contentType: true,
            byteSize: true,
            width: true,
            height: true,
            originalFileName: true,
          },
        },
        paymentProfiles: {
          orderBy: [
            { isDefault: 'desc' },
            { sortOrder: 'asc' },
            { name: 'asc' },
          ],
        },
      },
    });
  }

  private buildIssuerSnapshot(
    settings: Awaited<ReturnType<WmsPurchasingService['getInvoiceSettingsRecordTx']>>,
    tenant: {
      id: string;
      name: string;
      slug: string;
    },
    paymentProfile = this.resolveInvoicePaymentProfile(settings),
  ) {
    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      companyName: settings?.companyName ?? null,
      companyAddress: settings?.companyAddress ?? null,
      invoicePrefix: settings?.invoicePrefix ?? 'INV',
      ...this.paymentProfileFields(paymentProfile),
      footerNotes: settings?.footerNotes ?? null,
    } as Prisma.InputJsonValue;
  }

  private resolveInvoicePaymentProfile(
    settings:
      | Awaited<ReturnType<WmsPurchasingService['getInvoiceSettingsRecordTx']>>
      | Awaited<ReturnType<WmsPurchasingService['findEffectiveInvoiceSettingsWithLogo']>>,
    requestedProfileId?: string | null,
  ): InvoicePaymentProfileSnapshot | null {
    const paymentProfiles = settings?.paymentProfiles ?? [];
    const selected = requestedProfileId
      ? paymentProfiles.find((profile) => profile.id === requestedProfileId)
      : paymentProfiles.find((profile) => profile.isDefault) ?? paymentProfiles[0];

    if (requestedProfileId && !selected) {
      throw new BadRequestException('Selected payment option was not found in invoice settings');
    }

    if (selected) {
      return {
        id: selected.id,
        name: selected.name,
        bankName: selected.bankName ?? null,
        bankAccountName: selected.bankAccountName ?? null,
        bankAccountNumber: selected.bankAccountNumber ?? null,
        bankAccountType: selected.bankAccountType ?? null,
        bankBranch: selected.bankBranch ?? null,
        paymentInstructions: selected.paymentInstructions ?? null,
      };
    }

    if (!settings) {
      return null;
    }

    const hasLegacyPaymentDetails = [
      settings.bankName,
      settings.bankAccountName,
      settings.bankAccountNumber,
      settings.bankAccountType,
      settings.bankBranch,
      settings.paymentInstructions,
    ].some(Boolean);

    return hasLegacyPaymentDetails
      ? {
          id: null,
          name: 'Default payment',
          bankName: settings.bankName ?? null,
          bankAccountName: settings.bankAccountName ?? null,
          bankAccountNumber: settings.bankAccountNumber ?? null,
          bankAccountType: settings.bankAccountType ?? null,
          bankBranch: settings.bankBranch ?? null,
          paymentInstructions: settings.paymentInstructions ?? null,
        }
      : null;
  }

  private buildPaymentProfileSnapshot(paymentProfile: InvoicePaymentProfileSnapshot | null) {
    return (paymentProfile ?? {}) as Prisma.InputJsonValue;
  }

  private paymentProfileFields(paymentProfile: InvoicePaymentProfileSnapshot | null) {
    return {
      bankName: paymentProfile?.bankName ?? null,
      bankAccountName: paymentProfile?.bankAccountName ?? null,
      bankAccountNumber: paymentProfile?.bankAccountNumber ?? null,
      bankAccountType: paymentProfile?.bankAccountType ?? null,
      bankBranch: paymentProfile?.bankBranch ?? null,
      paymentInstructions: paymentProfile?.paymentInstructions ?? null,
    };
  }

  private hasInvoicePaymentProfile(
    paymentProfile: Record<string, unknown> | null | undefined,
  ) {
    return [
      'id',
      'name',
      'bankName',
      'bankAccountName',
      'bankAccountNumber',
      'bankAccountType',
      'bankBranch',
      'paymentInstructions',
    ].some((key) => paymentProfile?.[key] !== undefined && paymentProfile[key] !== null);
  }

  private buildBillToSnapshot(tenant: {
    id: string;
    name: string;
    slug: string;
    billingCompanyName: string | null;
    billingAddress: string | null;
  }) {
    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      companyName: tenant.billingCompanyName ?? tenant.name,
      billingAddress: tenant.billingAddress ?? null,
    } as Prisma.InputJsonValue;
  }

  private readJsonString(input: Record<string, unknown> | null | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' && value.trim().length ? value : null;
  }

  private async generateNextInvoiceNumberTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    prefix: string,
  ) {
    const latest = await tx.wmsInvoice.findFirst({
      where: {
        tenantId,
        invoiceNumber: {
          startsWith: `${prefix}-`,
        },
      },
      select: {
        invoiceNumber: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const currentSequence = latest
      ? this.extractInvoiceSequence(latest.invoiceNumber, prefix)
      : 0;

    return `${prefix}-${String(currentSequence + 1).padStart(6, '0')}`;
  }

  private extractInvoiceSequence(invoiceNumber: string, prefix: string) {
    const normalized = invoiceNumber.trim();
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
    const match = normalized.match(pattern);
    if (!match) {
      return 0;
    }

    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async prepareInvoiceLines(
    tx: Prisma.TransactionClient,
    tenantId: string,
    lines: CreateWmsInvoiceLineInput[] | UpdateWmsInvoiceLineInput[],
    options: { allowVat: boolean },
  ) {
    const storeIds = Array.from(
      new Set(
        lines
          .map((line) => this.cleanOptionalText('storeId' in line ? String(line.storeId ?? '') : ''))
          .filter((value): value is string => Boolean(value)),
      ),
    );

    if (storeIds.length) {
      const validStores = await tx.posStore.findMany({
        where: {
          tenantId,
          id: {
            in: storeIds,
          },
        },
        select: {
          id: true,
        },
      });

      if (validStores.length !== storeIds.length) {
        throw new BadRequestException('One or more invoice lines use a store outside tenant scope');
      }
    }

    return lines.map((line, index) => {
      const description = this.cleanOptionalText(line.description);
      if (!description) {
        throw new BadRequestException(`Invoice line ${index + 1} is missing description`);
      }

      const quantity = Number(line.quantity);
      const unitRate = Number(line.unitRate);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException(`Invoice line ${index + 1} has invalid quantity`);
      }
      if (!Number.isFinite(unitRate) || unitRate < 0) {
        throw new BadRequestException(`Invoice line ${index + 1} has invalid rate`);
      }

      const amount = Number((quantity * unitRate).toFixed(2));
      const vatEnabled = options.allowVat && line.vatEnabled === true;
      const vatRate = vatEnabled ? MANUAL_INVOICE_VAT_RATE : 0;
      const vatAmount = Number((amount * (vatRate / 100)).toFixed(2));

      return {
        lineNo: line.lineNo ?? index + 1,
        lineType: line.lineType ?? WmsInvoiceLineType.CUSTOM,
        storeId: line.storeId ?? null,
        productId: this.cleanOptionalText(line.productId ?? null),
        variationId: this.cleanOptionalText(line.variationId ?? null),
        description,
        itemSubtext: this.cleanOptionalText(line.itemSubtext ?? null),
        quantity,
        unitRate: Number(unitRate.toFixed(2)),
        amount,
        vatEnabled,
        vatRate,
        vatAmount,
        rateSource: this.cleanOptionalText(line.rateSource ?? null),
      };
    });
  }

  private computeInvoiceTotals(
    lines: Array<{
      quantity: number;
      amount: number;
      vatAmount?: number;
    }>,
  ) {
    const subtotal = Number(lines.reduce((sum, line) => sum + line.amount, 0).toFixed(2));
    const vatTotal = Number(
      lines.reduce((sum, line) => sum + (line.vatAmount ?? 0), 0).toFixed(2),
    );
    const totalAmount = Number((subtotal + vatTotal).toFixed(2));
    const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);

    return {
      lineCount: lines.length,
      totalQuantity,
      subtotal,
      vatRate: vatTotal > 0 ? MANUAL_INVOICE_VAT_RATE : 0,
      vatTotal,
      totalAmount,
      amountDue: totalAmount,
    };
  }

  private applyInvoiceStatusToTotals(
    totals: {
      lineCount: number;
      totalQuantity: number;
      subtotal: number;
      vatRate: number;
      vatTotal: number;
      totalAmount: number;
      amountDue: number;
    },
    status: WmsInvoiceStatus,
  ) {
    return {
      ...totals,
      amountDue:
        status === WmsInvoiceStatus.PAID_VERIFIED || status === WmsInvoiceStatus.CANCELED
          ? 0
          : totals.totalAmount,
    };
  }

  private resequenceInvoiceLines<
    T extends {
      lineNo: number;
      lineType: WmsInvoiceLineType;
      storeId: string | null;
      productId: string | null;
      variationId: string | null;
      description: string;
      itemSubtext?: string | null;
      quantity: number;
      unitRate: number;
      amount: number;
      vatEnabled?: boolean;
      vatRate?: number;
      vatAmount?: number;
      rateSource: string | null;
    },
  >(lines: T[]) {
    return lines.map((line, index) => ({
      ...line,
      lineNo: index + 1,
    }));
  }

  private extractCustomInvoiceLines(
    lines: Array<{
      lineNo: number;
      lineType: WmsInvoiceLineType;
      storeId: string | null;
      productId: string | null;
      variationId: string | null;
      description: string;
      itemSubtext: string | null;
      quantity: number;
      unitRate: Prisma.Decimal;
      amount: Prisma.Decimal;
      vatEnabled: boolean;
      vatRate: Prisma.Decimal;
      vatAmount: Prisma.Decimal;
      rateSource: string | null;
    }>,
  ) {
    return lines
      .filter((line) => line.lineType === WmsInvoiceLineType.CUSTOM)
      .map((line) => ({
        lineNo: line.lineNo,
        lineType: WmsInvoiceLineType.CUSTOM,
        storeId: line.storeId ?? null,
        productId: line.productId ?? null,
        variationId: line.variationId ?? null,
        description: line.description,
        itemSubtext: line.itemSubtext,
        quantity: line.quantity,
        unitRate: this.toNumber(line.unitRate) ?? 0,
        amount: this.toNumber(line.amount) ?? 0,
        vatEnabled: line.vatEnabled,
        vatRate: this.toNumber(line.vatRate) ?? 0,
        vatAmount: this.toNumber(line.vatAmount) ?? 0,
        rateSource: line.rateSource ?? null,
      }));
  }

  private buildInvoiceLineSnapshot(line: {
    lineType: WmsInvoiceLineType;
    storeId: string | null;
    productId: string | null;
    variationId: string | null;
    description: string;
    itemSubtext?: string | null;
    quantity: number;
    unitRate: number;
    amount: number;
    vatEnabled?: boolean;
    vatRate?: number;
    vatAmount?: number;
    rateSource: string | null;
  }) {
    return {
      lineType: line.lineType,
      storeId: line.storeId,
      productId: line.productId,
      variationId: line.variationId,
      description: line.description,
      itemSubtext: line.itemSubtext ?? null,
      quantity: line.quantity,
      unitRate: line.unitRate,
      amount: line.amount,
      vatEnabled: line.vatEnabled ?? false,
      vatRate: line.vatRate ?? 0,
      vatAmount: line.vatAmount ?? 0,
      rateSource: line.rateSource,
    } as Prisma.InputJsonValue;
  }

  private readInvoiceTotals(value: Prisma.JsonValue | null | undefined) {
    const snapshot = this.asJsonRecord(value);
    const lineCount = this.jsonNumber(snapshot?.lineCount);
    const totalQuantity = this.jsonNumber(snapshot?.totalQuantity);
    const subtotal = this.jsonNumber(snapshot?.subtotal);
    const vatRate = this.jsonNumber(snapshot?.vatRate);
    const vatTotal = this.jsonNumber(snapshot?.vatTotal);
    const totalAmount = this.jsonNumber(snapshot?.totalAmount);
    const amountDue = this.jsonNumber(snapshot?.amountDue);

    return {
      lineCount,
      totalQuantity,
      subtotal,
      vatRate,
      vatTotal,
      totalAmount,
      amountDue,
    };
  }

  private async resolveTenantScope(requestedTenantId?: string) {
    const clsTenantId = this.cls.get('tenantId') as string | undefined;
    const userRole = this.cls.get('userRole') as string | undefined;
    const isPlatformUser = userRole === 'SUPER_ADMIN';
    const hasGlobalWmsAccess = this.cls.get('wmsGlobalAccess') === true;

    if (isPlatformUser || hasGlobalWmsAccess) {
      const tenants = await this.prisma.tenant.findMany({
        where: {
          status: {
            in: [...ACTIVE_WMS_TENANT_STATUSES],
          },
        },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
        },
        orderBy: [{ name: 'asc' }],
      });

      const activeTenantId =
        requestedTenantId && tenants.some((tenant) => tenant.id === requestedTenantId)
          ? requestedTenantId
          : clsTenantId && tenants.some((tenant) => tenant.id === clsTenantId)
            ? clsTenantId
          : tenants[0]?.id ?? null;

      return {
        activeTenantId,
        tenants: tenants.map((tenant) => ({
          id: tenant.id,
          label: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
        })),
      };
    }

    if (!clsTenantId) {
      return {
        activeTenantId: null,
        tenants: [],
      };
    }

    if (requestedTenantId && requestedTenantId !== clsTenantId) {
      throw new ForbiddenException('Selected tenant is outside your WMS scope');
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: {
        id: clsTenantId,
        status: {
          in: [...ACTIVE_WMS_TENANT_STATUSES],
        },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
      },
    });

    return {
      activeTenantId: tenant?.id ?? null,
      tenants: tenant
        ? [
            {
              id: tenant.id,
              label: tenant.name,
              slug: tenant.slug,
              status: tenant.status,
            },
          ]
        : [],
    };
  }

  private toNumber(value: Prisma.Decimal | number | null | undefined) {
    if (value === null || value === undefined) {
      return null;
    }

    return Number(value);
  }

  private jsonNumber(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private asJsonRecord(value: unknown): Record<string, any> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, any>;
  }

  private isLegacyVariationMapping(productId: string, variationId: string | null | undefined) {
    return Boolean(variationId) && variationId === productId;
  }

  private isStockableVariation(productId: string, variationId: string | null | undefined) {
    return Boolean(variationId) && !this.isLegacyVariationMapping(productId, variationId);
  }

  private getStockabilityReason(productId: string, variationId: string | null | undefined) {
    if (!variationId) {
      return 'Resolved POS product is not stockable because it is missing a variation ID';
    }

    if (this.isLegacyVariationMapping(productId, variationId)) {
      return 'Resolved POS product still uses a legacy variation mapping. Sync this product first.';
    }

    return 'Resolved POS product is not stockable';
  }

  private numberOrNull(value: number | null | undefined) {
    if (value === null || value === undefined) {
      return null;
    }

    return Number(value);
  }

  private parseOptionalDate(value: string | null | undefined) {
    const normalized = this.cleanOptionalText(value);
    if (!normalized) {
      return null;
    }

    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid date value: ${value}`);
    }

    return parsed;
  }

  private cleanOptionalText(value: string | null | undefined) {
    const cleaned = value?.trim();
    return cleaned ? cleaned : null;
  }

  private normalizeInvoiceCurrency(value: string | null | undefined) {
    return this.cleanOptionalText(value)?.toUpperCase() ?? 'PHP';
  }

  private toJsonValue(value: Record<string, unknown> | undefined) {
    if (!value) {
      return undefined;
    }

    return value as Prisma.InputJsonValue;
  }

  private formatRequestTypeLabel(value: WmsPurchasingRequestType) {
    return value === WmsPurchasingRequestType.SELF_BUY ? 'Self-buy' : 'Procurement';
  }

  private formatStatusLabel(status: WmsPurchasingBatchStatus) {
    return status
      .split('_')
      .map((part) => part[0] + part.slice(1).toLowerCase())
      .join(' ');
  }

  private formatInvoiceStatusLabel(status: WmsInvoiceStatus) {
    return status
      .split('_')
      .map((part) => part[0] + part.slice(1).toLowerCase())
      .join(' ');
  }

  private formatInvoiceSourceTypeLabel(sourceType: WmsInvoiceSourceType) {
    if (sourceType === WmsInvoiceSourceType.MANUAL) {
      return 'Manual';
    }

    if (sourceType === WmsInvoiceSourceType.MANUAL_RECEIVING) {
      return 'Manual receiving';
    }

    return 'Procurement';
  }

  private formatUserName(firstName: string | null, lastName: string | null) {
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    return fullName || 'Unknown user';
  }
}

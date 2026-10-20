'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/ui/toast';
import {
  createWmsPurchasingBatch,
  fetchWmsPurchasingBatch,
  fetchWmsPurchasingLinkedInvoice,
  fetchWmsPurchasingLinkedInvoiceDocument,
  fetchWmsPurchasingOverview,
  fetchWmsPurchasingProductOptions,
  markStockRequestNotificationsRead,
  markWmsSelfBuyShipment,
  respondWmsPurchasingRevision,
  submitWmsPurchasingPaymentProof,
  uploadWmsPurchasingPaymentProofImage,
} from '../_services/requests.service';
import { useStockRequestRealtime } from './use-stock-request-realtime';
import type {
  CreateWmsPurchasingBatchInput,
  MarkWmsSelfBuyShipmentInput,
  RespondWmsPurchasingRevisionInput,
  SubmitWmsPurchasingPaymentProofInput,
  UploadedWmsPurchasingProofImage,
  WmsInvoiceDetail,
  WmsInvoiceDocumentResponse,
  WmsPurchasingBatchDetail,
  WmsPurchasingBatchStatus,
  WmsPurchasingOverviewResponse,
  WmsPurchasingProductOption,
  WmsPurchasingProductOptionsResponse,
  WmsPurchasingRequestType,
} from '../_types/request';
import { parseRequestError } from '../_utils/request-errors';

type CartLine = {
  id: string;
  product: WmsPurchasingProductOption;
  quantity: number;
  unitAmount: number | null;
};

const SEARCH_DEBOUNCE_MS = 300;

function getSourceRequestId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `ERP-${stamp}-${suffix}`;
}

function getUnitAmount(product: WmsPurchasingProductOption, requestType: WmsPurchasingRequestType) {
  if (requestType === 'PROCUREMENT') {
    return typeof product.partnerUnitCost === 'number'
      && Number.isFinite(product.partnerUnitCost) && product.partnerUnitCost >= 0
      ? product.partnerUnitCost : null;
  }
  return null;
}

export function useRequestsController() {
  const { addToast } = useToast();
  const queryClient = useQueryClient();

  const [overview, setOverview] = useState<WmsPurchasingOverviewResponse | null>(null);
  const [isLoadingOverview, setIsLoadingOverview] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [createStoreScopeId, setCreateStoreScopeIdState] = useState('');
  const [createRequestType, setCreateRequestType] = useState<WmsPurchasingRequestType>('PROCUREMENT');
  const [createPartnerNotes, setCreatePartnerNotes] = useState('');
  const [cartLines, setCartLines] = useState<CartLine[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [selectedRequestType, setSelectedRequestType] = useState<WmsPurchasingRequestType | ''>('');
  const [selectedStatus, setSelectedStatus] = useState<WmsPurchasingBatchStatus | ''>('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [overviewPage, setOverviewPage] = useState(1);

  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<WmsPurchasingBatchDetail | null>(null);
  const [isLoadingBatch, setIsLoadingBatch] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [isSubmittingPaymentProof, setIsSubmittingPaymentProof] = useState(false);
  const [isUploadingPaymentProofImage, setIsUploadingPaymentProofImage] = useState(false);
  const [isRespondingToRevision, setIsRespondingToRevision] = useState(false);
  const [isMarkingSelfBuyShipment, setIsMarkingSelfBuyShipment] = useState(false);
  const [linkedInvoice, setLinkedInvoice] = useState<WmsInvoiceDetail | null>(null);
  const [isLoadingLinkedInvoice, setIsLoadingLinkedInvoice] = useState(false);
  const [linkedInvoiceError, setLinkedInvoiceError] = useState<string | null>(null);
  const [isPrintingLinkedInvoice, setIsPrintingLinkedInvoice] = useState(false);
  const markedNotificationRef = useRef<string | null>(null);

  const [isProductPickerOpen, setIsProductPickerOpen] = useState(false);
  const [productSearchText, setProductSearchText] = useState('');
  const [debouncedProductSearch, setDebouncedProductSearch] = useState('');
  const [productOptions, setProductOptions] = useState<WmsPurchasingProductOptionsResponse | null>(null);
  const [isLoadingProductOptions, setIsLoadingProductOptions] = useState(false);
  const [productOptionsError, setProductOptionsError] = useState<string | null>(null);
  const [productOptionsPage, setProductOptionsPage] = useState(1);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [search]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedProductSearch(productSearchText.trim());
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [productSearchText]);

  const refreshOverview = useCallback(async () => {
    setIsLoadingOverview(true);
    setOverviewError(null);
    try {
      const data = await fetchWmsPurchasingOverview({
        ...(selectedStoreId ? { storeId: selectedStoreId } : {}),
        ...(selectedRequestType ? { requestType: selectedRequestType } : {}),
        ...(selectedStatus ? { status: selectedStatus } : {}),
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        page: overviewPage,
        pageSize: 10,
      });
      setOverview(data);
    } catch (error) {
      setOverviewError(parseRequestError(error, 'Failed to load stock requests'));
      setOverview(null);
    } finally {
      setIsLoadingOverview(false);
    }
  }, [debouncedSearch, overviewPage, selectedRequestType, selectedStatus, selectedStoreId]);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  useEffect(() => {
    setOverviewPage(1);
  }, [selectedStoreId, selectedRequestType, selectedStatus, debouncedSearch]);

  useEffect(() => {
    if (!selectedBatchId) {
      markedNotificationRef.current = null;
      setSelectedBatch(null);
      setBatchError(null);
      setLinkedInvoice(null);
      setLinkedInvoiceError(null);
      return;
    }

    let active = true;
    setIsLoadingBatch(true);
    setBatchError(null);

    void fetchWmsPurchasingBatch(selectedBatchId)
      .then((response) => {
        if (!active) {
          return;
        }
        setSelectedBatch(response.batch);
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setBatchError(parseRequestError(error, 'Failed to load request detail'));
        setSelectedBatch(null);
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setIsLoadingBatch(false);
      });

    return () => {
      active = false;
    };
  }, [selectedBatchId]);

  const refreshSelectedBatch = useCallback(async (batchId: string) => {
    setIsLoadingBatch(true);
    setBatchError(null);

    try {
      const response = await fetchWmsPurchasingBatch(batchId);
      setSelectedBatch(response.batch);
    } catch (error) {
      setBatchError(parseRequestError(error, 'Failed to load request detail'));
      setSelectedBatch(null);
    } finally {
      setIsLoadingBatch(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedBatch) {
      return;
    }

    const markKey = [
      selectedBatch.id,
      selectedBatch.events[0]?.id ?? 'no-event',
    ].join(':');

    if (markedNotificationRef.current === markKey) {
      return;
    }

    markedNotificationRef.current = markKey;

    void markStockRequestNotificationsRead(selectedBatch.id)
      .then(() =>
        queryClient.invalidateQueries({ queryKey: ['erp-stock-request-notification-count'] }))
      .catch(() => {
        if (markedNotificationRef.current === markKey) {
          markedNotificationRef.current = null;
        }
      });
  }, [queryClient, selectedBatch]);

  const effectiveStoreId = useMemo(() => {
    if (createStoreScopeId) {
      return createStoreScopeId;
    }
    return undefined;
  }, [createStoreScopeId]);

  const refreshProductOptions = useCallback(async () => {
    if (!isProductPickerOpen) {
      return;
    }

    setIsLoadingProductOptions(true);
    setProductOptionsError(null);
    try {
      const data = await fetchWmsPurchasingProductOptions({
        ...(effectiveStoreId ? { storeId: effectiveStoreId } : {}),
        ...(debouncedProductSearch ? { search: debouncedProductSearch } : {}),
        page: productOptionsPage,
        pageSize: 10,
      });
      setProductOptions(data);
    } catch (error) {
      setProductOptionsError(parseRequestError(error, 'Failed to load products'));
      setProductOptions(null);
    } finally {
      setIsLoadingProductOptions(false);
    }
  }, [debouncedProductSearch, effectiveStoreId, isProductPickerOpen, productOptionsPage]);

  useEffect(() => {
    void refreshProductOptions();
  }, [refreshProductOptions]);

  const setCreateStoreScopeId = useCallback(
    (nextStoreId: string) => {
      setCreateStoreScopeIdState(nextStoreId);
      setProductOptionsPage(1);
      if (cartLines.length > 0) {
        setCartLines([]);
        addToast('info', 'Cart cleared after changing store scope');
      }
    },
    [addToast, cartLines.length],
  );

  const openProductPicker = useCallback(() => {
    setProductOptionsPage(1);
    setProductSearchText('');
    setIsProductPickerOpen(true);
  }, []);

  const closeProductPicker = useCallback(() => {
    setIsProductPickerOpen(false);
  }, []);

  const addProductToCart = useCallback(
    (product: WmsPurchasingProductOption) => {
      setCartLines((current) => {
        const existing = current.find((line) => line.product.profileId === product.profileId);
        if (existing) {
          return current.map((line) =>
            line.product.profileId === product.profileId
              ? { ...line, quantity: line.quantity + 1 }
              : line,
          );
        }

        return [
          ...current,
          {
            id: `cart-${product.profileId}-${Date.now()}`,
            product,
            quantity: 1,
            unitAmount: getUnitAmount(product, createRequestType),
          },
        ];
      });

      setIsProductPickerOpen(false);
    },
    [createRequestType],
  );

  const removeCartLine = useCallback((lineId: string) => {
    setCartLines((current) => current.filter((line) => line.id !== lineId));
  }, []);

  const updateCartLineQuantity = useCallback((lineId: string, quantity: number) => {
    const nextQuantity = Number.isFinite(quantity) ? Math.max(1, Math.floor(quantity)) : 1;
    setCartLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, quantity: nextQuantity } : line)),
    );
  }, []);

  const updateCartLineUnitAmount = useCallback((lineId: string, unitAmount: number | null) => {
    setCartLines((current) =>
      current.map((line) => (
        line.id === lineId
          ? {
              ...line,
              unitAmount:
                unitAmount !== null && Number.isFinite(unitAmount)
                  ? Math.max(0, unitAmount)
                  : null,
            }
          : line
      )),
    );
  }, []);

  const updateCreateRequestType = useCallback((requestType: WmsPurchasingRequestType) => {
    setCreateRequestType(requestType);
    setCartLines((current) =>
      current.map((line) => ({
        ...line,
        unitAmount: getUnitAmount(line.product, requestType),
      })),
    );
  }, []);

  const cartTotals = useMemo(() => {
    const totalItems = cartLines.reduce((sum, line) => sum + line.quantity, 0);
    const totalAmount = cartLines.reduce(
      (sum, line) => sum + (line.unitAmount ?? 0) * line.quantity,
      0,
    );
    return {
      totalItems,
      totalAmount: cartLines.some((line) => line.unitAmount === null
        || !Number.isFinite(line.unitAmount)
        || (createRequestType === 'SELF_BUY' ? line.unitAmount <= 0 : line.unitAmount < 0)) ? null : totalAmount,
    };
  }, [cartLines, createRequestType]);

  const submitRequest = useCallback(async () => {
    if (!cartLines.length) {
      addToast('error', 'Add at least one product to cart');
      return;
    }

    const requestStoreId = createStoreScopeId || cartLines[0]?.product.store.id;
    if (!requestStoreId) {
      addToast('error', 'Add a product before submitting the request');
      return;
    }

    const missingUnitAmountLine = cartLines.find(
      (line) => line.unitAmount === null || !Number.isFinite(line.unitAmount)
        || (createRequestType === 'SELF_BUY' ? line.unitAmount <= 0 : line.unitAmount < 0),
    );
    if (missingUnitAmountLine) {
      addToast('error', createRequestType === 'SELF_BUY'
        ? `Enter actual unit COGS for ${missingUnitAmountLine.product.name}`
        : `Partner cost unavailable for ${missingUnitAmountLine.product.name}`);
      return;
    }

    const payload: CreateWmsPurchasingBatchInput = {
      storeId: requestStoreId,
      requestType: createRequestType,
      sourceType: 'ERP_REQUEST',
      sourceRequestId: getSourceRequestId(),
      sourceRequestType: 2,
      sourceStatus: 'UNDER_REVIEW',
      partnerNotes: createPartnerNotes.trim() || undefined,
      lines: cartLines.map((line, index) => {
        const unitAmount = line.unitAmount!;
        return {
          lineNo: index + 1,
          sourceItemId: line.product.posProductId,
          sourceSnapshot: {
            profileId: line.product.profileId,
            storeId: line.product.store.id,
            originalPartnerUnitCost: unitAmount,
            originalApprovedQuantity: line.quantity,
          },
          productId: line.product.productId,
          variationId: line.product.variationId,
          storeId: line.product.store.id,
          requestedProductName: line.product.name,
          requestedQuantity: line.quantity,
          uom: 'unit',
          partnerUnitCost: unitAmount,
          needsProfiling: false,
          resolvedPosProductId: line.product.posProductId,
          resolvedProfileId: line.product.profileId,
        };
      }),
    };

    setIsSubmitting(true);
    try {
      const response = await createWmsPurchasingBatch(payload);
      addToast('success', 'Stock request sent to WMS purchasing queue');
      setCartLines([]);
      setCreatePartnerNotes('');
      setSelectedBatchId(response.batch.id);
      await refreshOverview();
    } catch (error) {
      addToast('error', parseRequestError(error, 'Failed to submit stock request'));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    addToast,
    cartLines,
    createPartnerNotes,
    createRequestType,
    createStoreScopeId,
    refreshOverview,
  ]);

  const submitPaymentProof = useCallback(
    async (input: SubmitWmsPurchasingPaymentProofInput) => {
      if (!selectedBatchId) {
        addToast('error', 'Select a request first');
        return;
      }

      setIsSubmittingPaymentProof(true);
      try {
        const response = await submitWmsPurchasingPaymentProof(selectedBatchId, input);
        setSelectedBatch(response.batch);
        addToast('success', 'Payment proof submitted to WMS');
        await refreshOverview();
      } catch (error) {
        addToast('error', parseRequestError(error, 'Failed to submit payment proof'));
      } finally {
        setIsSubmittingPaymentProof(false);
      }
    },
    [addToast, refreshOverview, selectedBatchId],
  );

  const uploadPaymentProofImage = useCallback(
    async (file: File): Promise<UploadedWmsPurchasingProofImage | null> => {
      setIsUploadingPaymentProofImage(true);
      try {
        const response = await uploadWmsPurchasingPaymentProofImage(file);
        addToast('success', 'Payment proof image uploaded');
        return response.asset;
      } catch (error) {
        addToast('error', parseRequestError(error, 'Failed to upload payment proof image'));
        return null;
      } finally {
        setIsUploadingPaymentProofImage(false);
      }
    },
    [addToast],
  );

  const respondToRevision = useCallback(
    async (input: RespondWmsPurchasingRevisionInput) => {
      if (!selectedBatchId) {
        addToast('error', 'Select a request first');
        return;
      }

      setIsRespondingToRevision(true);
      try {
        const response = await respondWmsPurchasingRevision(selectedBatchId, input);
        setSelectedBatch(response.batch);
        addToast(
          'success',
          input.decision === 'ACCEPT'
            ? selectedBatch?.requestType === 'SELF_BUY'
              ? 'Revised request accepted. WMS is now waiting for your shipment.'
              : 'Revised request accepted. Payment is now pending.'
            : 'Revised request rejected.',
        );
        await refreshOverview();
      } catch (error) {
        addToast('error', parseRequestError(error, 'Failed to respond to revision'));
      } finally {
        setIsRespondingToRevision(false);
      }
    },
    [addToast, refreshOverview, selectedBatch?.requestType, selectedBatchId],
  );

  const markSelfBuyShipment = useCallback(
    async (input: MarkWmsSelfBuyShipmentInput) => {
      if (!selectedBatchId) {
        addToast('error', 'Select a request first');
        return;
      }

      setIsMarkingSelfBuyShipment(true);
      try {
        const response = await markWmsSelfBuyShipment(selectedBatchId, input);
        setSelectedBatch(response.batch);
        addToast('success', 'Shipment notice sent to WMS receiving queue');
        await refreshOverview();
      } catch (error) {
        addToast('error', parseRequestError(error, 'Failed to mark self-buy shipment'));
      } finally {
        setIsMarkingSelfBuyShipment(false);
      }
    },
    [addToast, refreshOverview, selectedBatchId],
  );

  const loadLinkedInvoice = useCallback(async () => {
    if (!selectedBatchId) {
      addToast('error', 'Select a request first');
      return null;
    }

    setIsLoadingLinkedInvoice(true);
    setLinkedInvoiceError(null);

    try {
      const response = await fetchWmsPurchasingLinkedInvoice(selectedBatchId);
      setLinkedInvoice(response.invoice);
      return response.invoice;
    } catch (error) {
      const message = parseRequestError(error, 'Failed to load invoice');
      setLinkedInvoiceError(message);
      addToast('error', message);
      return null;
    } finally {
      setIsLoadingLinkedInvoice(false);
    }
  }, [addToast, selectedBatchId]);

  const printLinkedInvoice = useCallback(async (): Promise<WmsInvoiceDocumentResponse | null> => {
    if (!selectedBatchId) {
      addToast('error', 'Select a request first');
      return null;
    }

    setIsPrintingLinkedInvoice(true);

    try {
      return await fetchWmsPurchasingLinkedInvoiceDocument(selectedBatchId);
    } catch (error) {
      addToast('error', parseRequestError(error, 'Failed to generate invoice document'));
      return null;
    } finally {
      setIsPrintingLinkedInvoice(false);
    }
  }, [addToast, selectedBatchId]);

  const handleRealtimeUpdate = useCallback((payload: { batchId?: string }) => {
    void refreshOverview();

    if (selectedBatchId && (!payload.batchId || payload.batchId === selectedBatchId)) {
      void refreshSelectedBatch(selectedBatchId);
    }
  }, [refreshOverview, refreshSelectedBatch, selectedBatchId]);

  useStockRequestRealtime({
    onUpdate: handleRealtimeUpdate,
  });

  return {
    isLoadingOverview,
    overviewError,
    overview,
    stores: overview?.filters.stores ?? [],
    queueRows: overview?.batches ?? [],
    queuePagination: overview?.pagination ?? { page: 1, pageSize: 10, total: 0, totalPages: 1 },
    queueFilters: overview?.filters ?? null,
    selectedStoreId,
    selectedRequestType,
    selectedStatus,
    search,
    setSelectedStoreId,
    setSelectedRequestType,
    setSelectedStatus,
    setSearch,
    overviewPage,
    setOverviewPage,
    selectedBatchId,
    setSelectedBatchId,
    selectedBatch,
    isLoadingBatch,
    batchError,
    submitPaymentProof,
    isSubmittingPaymentProof,
    uploadPaymentProofImage,
    isUploadingPaymentProofImage,
    respondToRevision,
    isRespondingToRevision,
    markSelfBuyShipment,
    isMarkingSelfBuyShipment,
    linkedInvoice,
    isLoadingLinkedInvoice,
    linkedInvoiceError,
    isPrintingLinkedInvoice,
    loadLinkedInvoice,
    printLinkedInvoice,
    createStoreScopeId,
    createRequestType,
    createPartnerNotes,
    cartLines,
    cartTotals,
    isSubmitting,
    setCreateStoreScopeId,
    setCreateRequestType: updateCreateRequestType,
    setCreatePartnerNotes,
    removeCartLine,
    updateCartLineQuantity,
    updateCartLineUnitAmount,
    submitRequest,
    isProductPickerOpen,
    productSearchText,
    productOptions,
    isLoadingProductOptions,
    productOptionsError,
    productOptionsPage,
    setProductSearchText: (value: string) => {
      setProductSearchText(value);
      setProductOptionsPage(1);
    },
    setProductOptionsPage,
    openProductPicker,
    closeProductPicker,
    addProductToCart,
    effectiveStoreId,
  };
}

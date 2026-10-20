'use client';

import clsx from 'clsx';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Receipt } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { DashboardSection } from '../../dashboard/_components/dashboard-section';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type {
  MarkWmsSelfBuyShipmentInput,
  RespondWmsPurchasingRevisionInput,
  SubmitWmsPurchasingPaymentProofInput,
  UploadedWmsPurchasingProofImage,
  WmsInvoiceDetail,
  WmsPurchasingBatchDetail,
} from '../_types/request';
import {
  formatDateTime,
  formatMoney,
  formatRequestTypeLabel,
  formatShortDate,
  formatStatusLabel,
  getStatusClasses,
} from '../_utils/request-presenters';

interface RequestDetailPanelProps {
  batch: WmsPurchasingBatchDetail | null;
  isLoading: boolean;
  error: string | null;
  canSubmitPaymentProof: boolean;
  isSubmittingPaymentProof: boolean;
  onSubmitPaymentProof: (input: SubmitWmsPurchasingPaymentProofInput) => Promise<void>;
  isUploadingPaymentProofImage: boolean;
  onUploadPaymentProofImage: (file: File) => Promise<UploadedWmsPurchasingProofImage | null>;
  canRespondToRevision: boolean;
  isRespondingToRevision: boolean;
  onRespondToRevision: (input: RespondWmsPurchasingRevisionInput) => Promise<void>;
  canMarkSelfBuyShipment: boolean;
  isMarkingSelfBuyShipment: boolean;
  onMarkSelfBuyShipment: (input: MarkWmsSelfBuyShipmentInput) => Promise<void>;
  linkedInvoice: WmsInvoiceDetail | null;
  isLoadingLinkedInvoice: boolean;
  linkedInvoiceError: string | null;
  isPrintingLinkedInvoice: boolean;
  onLoadLinkedInvoice: () => Promise<WmsInvoiceDetail | null>;
  onPrintLinkedInvoice: () => Promise<void>;
}

type ImageSize = {
  width: number;
  height: number;
};

type ImageFocusPoint = {
  x: number;
  y: number;
};

function formatAddress(value: string | null | undefined) {
  if (!value) {
    return '—';
  }
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ');
}

export function RequestDetailPanel({
  batch,
  isLoading,
  error,
  canSubmitPaymentProof,
  isSubmittingPaymentProof,
  onSubmitPaymentProof,
  isUploadingPaymentProofImage,
  onUploadPaymentProofImage,
  canRespondToRevision,
  isRespondingToRevision,
  onRespondToRevision,
  canMarkSelfBuyShipment,
  isMarkingSelfBuyShipment,
  onMarkSelfBuyShipment,
  linkedInvoice,
  isLoadingLinkedInvoice,
  linkedInvoiceError,
  isPrintingLinkedInvoice,
  onLoadLinkedInvoice,
  onPrintLinkedInvoice,
}: RequestDetailPanelProps) {
  const [proofAssetId, setProofAssetId] = useState<string | null>(null);
  const [proofPreviewUrl, setProofPreviewUrl] = useState('');
  const [proofFileName, setProofFileName] = useState('');
  const [proofMessage, setProofMessage] = useState('');
  const [shipmentReference, setShipmentReference] = useState('');
  const [shipmentMessage, setShipmentMessage] = useState('');
  const [activeProofImageUrl, setActiveProofImageUrl] = useState<string | null>(null);
  const [isInvoicePreviewOpen, setIsInvoicePreviewOpen] = useState(false);
  const [isProofImageZoomed, setIsProofImageZoomed] = useState(false);
  const [proofImageBaseSize, setProofImageBaseSize] = useState<ImageSize | null>(null);
  const [proofImageFocusPoint, setProofImageFocusPoint] = useState<ImageFocusPoint | null>(null);
  const proofImageScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setProofAssetId(null);
    setProofPreviewUrl(batch?.paymentProofImageUrl ?? '');
    setProofFileName('');
    setProofMessage('');
    setShipmentReference('');
    setShipmentMessage('');
    setActiveProofImageUrl(null);
    setIsInvoicePreviewOpen(false);
    setIsProofImageZoomed(false);
    setProofImageBaseSize(null);
    setProofImageFocusPoint(null);
  }, [batch?.id, batch?.paymentProofImageUrl]);

  useEffect(() => {
    if (!isProofImageZoomed || !proofImageBaseSize || !proofImageFocusPoint || !proofImageScrollRef.current) {
      return;
    }

    const scrollContainer = proofImageScrollRef.current;
    const zoomedWidth = proofImageBaseSize.width * PAYMENT_PROOF_ZOOM_SCALE;
    const zoomedHeight = proofImageBaseSize.height * PAYMENT_PROOF_ZOOM_SCALE;
    const targetLeft = clamp(
      zoomedWidth * proofImageFocusPoint.x - scrollContainer.clientWidth / 2,
      0,
      Math.max(0, zoomedWidth - scrollContainer.clientWidth),
    );
    const targetTop = clamp(
      zoomedHeight * proofImageFocusPoint.y - scrollContainer.clientHeight / 2,
      0,
      Math.max(0, zoomedHeight - scrollContainer.clientHeight),
    );

    const frameId = window.requestAnimationFrame(() => {
      scrollContainer.scrollTo({ left: targetLeft, top: targetTop });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isProofImageZoomed, proofImageBaseSize, proofImageFocusPoint]);

  if (isLoading) {
    return (
      <RequestDetailSection>
        <p className="text-sm text-[#5a7184]">Loading request details...</p>
      </RequestDetailSection>
    );
  }

  if (error) {
    return (
      <RequestDetailSection>
        <div className="rounded-lg border border-[#f1c7cc] bg-[#fff8f8] p-3">
          <p className="text-sm text-[#9f1d35]">{error}</p>
        </div>
      </RequestDetailSection>
    );
  }

  if (!batch) {
    return (
      <RequestDetailSection>
        <p className="text-sm text-[#5a7184] dark:text-slate-300">Select a request from the queue to view status and invoice.</p>
      </RequestDetailSection>
    );
  }

  const billTo = batch.store.name;
  const bank = batch.invoice.bankDetails;
  const linkedInvoiceSummary = batch.invoice.linked;
  const isSelfBuy = batch.requestType === 'SELF_BUY';
  const paymentProofImageUrl = getSafeImageUrl(batch.paymentProofImageUrl);
  const lineItemsTotal = batch.lines.reduce<number | null>((sum, line) => {
    const quantity = line.approvedQuantity ?? line.requestedQuantity;
    if (sum === null || !isKnownPartnerCost(line.partnerUnitCost)
      || !Number.isFinite(quantity) || quantity < 0) return null;
    const amount = sum + quantity * line.partnerUnitCost;
    return Number.isFinite(amount) ? amount : null;
  }, 0);
  const hasPendingPartnerCost = lineItemsTotal === null;
  const invoiceAmount = hasPendingPartnerCost ? null
    : batch.invoice.amount == null ? lineItemsTotal
      : isKnownPartnerCost(batch.invoice.amount) ? batch.invoice.amount : null;
  const linkedInvoicePricesKnown = !linkedInvoice || (
    isKnownPartnerCost(linkedInvoice.amountDue) && linkedInvoice.lines.length > 0
    && linkedInvoice.lines.every((line) => isKnownPartnerCost(line.unitRate) && isKnownPartnerCost(line.amount))
  );
  const canPrintInvoice = !hasPendingPartnerCost && linkedInvoicePricesKnown;
  const revisedLines = batch.lines
    .map((line) => {
      const sourceSnapshot =
        line.sourceSnapshot && typeof line.sourceSnapshot === 'object' && !Array.isArray(line.sourceSnapshot)
          ? line.sourceSnapshot
          : null;
      const revisedPartnerUnitCost = isKnownPartnerCost(line.partnerUnitCost) ? line.partnerUnitCost : null;
      const originalPartnerUnitCost = sourceSnapshot && 'originalPartnerUnitCost' in sourceSnapshot
        ? isKnownPartnerCost(sourceSnapshot.originalPartnerUnitCost) ? sourceSnapshot.originalPartnerUnitCost : null
        : revisedPartnerUnitCost;
      const revisedQuantity = line.approvedQuantity ?? line.requestedQuantity;
      const hasQuantityChange = revisedQuantity !== line.requestedQuantity;
      const hasRateChange = revisedPartnerUnitCost !== originalPartnerUnitCost;

      if (!hasQuantityChange && !hasRateChange) {
        return null;
      }

      return {
        id: line.id,
        label: line.requestedProductName || line.variationId || line.productId || `Line ${line.lineNo}`,
        originalQuantity: line.requestedQuantity,
        revisedQuantity,
        originalRate: originalPartnerUnitCost,
        revisedRate: revisedPartnerUnitCost,
      };
    })
    .filter((line): line is NonNullable<typeof line> => Boolean(line));

  return (
    <>
    <RequestDetailSection contentClassName="space-y-4">
      <Card className="border-[#d9e2ec]" padding='none'>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="">
                {isSelfBuy ? 'Self-buy Request' : 'Billing Statement'}
              </p>
              <h2 className="text-base font-semibold text-forergound">
                {batch.invoice.number || batch.sourceRequestId || batch.id.slice(0, 8)}
              </h2>
              <p className="text-xs text-[#6d8191] dark:text-slate-400">{formatRequestTypeLabel(batch.requestType)}</p>
            </div>
            <span
              className={clsx(
                'inline-flex rounded-full px-2 py-1 text-xs font-semibold',
                getStatusClasses(batch.status),
              )}
            >
              {formatStatusLabel(batch.status)}
            </span>
          </div>

          <div className="grid gap-3 card text-sm md:grid-cols-2">
            <div>
              <p className="card-label">From</p>
              <p className="mt-1 font-semibold text-forergound">
                {bank?.billingCompanyName || bank?.warehouseName || 'Warehouse Billing'}
              </p>
              <p className="mt-1 text-slate-300">{formatAddress(bank?.billingAddress)}</p>
            </div>
            <div className="md:text-right">
              <p className="card-label">Bill To</p>
              <p className="mt-1 font-semibold text-forergound">{billTo}</p>
              <p className="mt-1 text-slate-300">Invoice Date: {formatShortDate(batch.updatedAt)}</p>
              <p className="text-slate-300">Requested: {formatShortDate(batch.createdAt)}</p>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-[#e3e9ef] dark:border-border">
            <table className="min-w-full divide-y divide-[#edf2f7] text-sm dark:divide-border">
              <thead className="bg-[#eff3f6] text-left text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7b8ba1] dark:bg-background-secondary dark:text-slate-300">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Rate</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#edf2f7] bg-white dark:divide-border dark:bg-surface">
                {batch.lines.map((line) => {
                  const quantity = line.approvedQuantity ?? line.requestedQuantity;
                  const rate = isKnownPartnerCost(line.partnerUnitCost) ? line.partnerUnitCost : null;
                  return (
                    <tr key={line.id}>
                      <td className="px-3 py-2.5 text-[#4d6677] dark:text-slate-300">{line.lineNo}</td>
                      <td className="px-3 py-2.5 font-medium text-forergound">
                        {line.requestedProductName || line.variationId || line.productId || 'Item'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-forergound">{quantity}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-forergound">{formatPartnerCost(rate)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-forergound">
                        {formatPartnerCost(rate === null ? null : quantity * rate)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!isSelfBuy ? (
            <>
              <div className="rounded-xl border border-[#e3e9ef] dark:border-border bg-surface p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold text-forergound">Total Amount</span>
                  <span className="font-semibold text-forergound">{formatPartnerCost(invoiceAmount)}</span>
                </div>
              </div>

              {hasPendingPartnerCost ? (
                <p className="text-sm text-[#6d8191] dark:text-slate-300">
                  Partner cost pending. Totals and invoice printing are unavailable until every line has a valid partner price.
                </p>
              ) : null}

              <div className="card">
                <p className="card-label">
                  Bank Details
                </p>
                <div className="mt-2 space-y-1 text-sm">
                  <p>Bank: {bank?.bankName || '—'}</p>
                  <p>Account Name: {bank?.bankAccountName || '—'}</p>
                  <p>Account Number: {bank?.bankAccountNumber || '—'}</p>
                  <p>Account Type: {bank?.bankAccountType || '—'}</p>
                  <p>Branch: {bank?.bankBranch || '—'}</p>
                  {bank?.paymentInstructions ? <p>Instructions: {bank.paymentInstructions}</p> : null}
                </div>
              </div>

              {linkedInvoiceSummary ? (
                <div className="card">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="card-label">Linked Invoice</p>
                      <p className="mt-1 text-sm font-semibold text-forergound">
                        {linkedInvoiceSummary.invoiceNumber}
                      </p>
                      <p className="mt-1 text-xs text-[#6d8191] dark:text-slate-300">
                        {formatShortDate(linkedInvoiceSummary.issueDate)} to {formatShortDate(linkedInvoiceSummary.dueDate)}
                        {' · '}
                        {formatPartnerCost(hasPendingPartnerCost ? null : linkedInvoiceSummary.amountDue)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        disabled={isLoadingLinkedInvoice || hasPendingPartnerCost}
                        onClick={() => {
                          if (hasPendingPartnerCost) return;
                          void onLoadLinkedInvoice().then((invoice) => {
                            if (invoice) {
                              setIsInvoicePreviewOpen(true);
                            }
                          });
                        }}
                        className="btn btn-sm btn-secondary"
                      >
                        {isLoadingLinkedInvoice ? 'Opening...' : 'Preview'}
                      </button>
                      <button
                        type="button"
                        disabled={isPrintingLinkedInvoice || !canPrintInvoice}
                        onClick={() => { if (canPrintInvoice) void onPrintLinkedInvoice(); }}
                        className="btn btn-sm btn-primary-soft"
                      >
                        {isPrintingLinkedInvoice ? 'Preparing...' : 'Print / Save PDF'}
                      </button>
                    </div>
                  </div>
                  {linkedInvoiceError ? (
                    <p className="mt-2 text-xs text-[#b42318]">{linkedInvoiceError}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="rounded-xl border border-[#e3e9ef] bg-[#fbfdff] p-3 text-sm text-forergound">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#7b8ba1]">
                Warehouse Handoff
              </p>
              <div className="mt-2 space-y-1 text-sm">
                <p>Approved Units: {batch.approvedQuantity}</p>
                <p>Received Units: {batch.receivedQuantity}</p>
                <p>Ready for warehouse: {formatShortDate(batch.readyForReceivingAt)}</p>
              </div>
            </div>
          )}
        </div>
      </Card>

      {batch.status === 'REVISION' ? (
        <Card className="border-[#d9e2ec]" padding='none'>
          <div className="space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#7b8ba1]">
                Revision Review
              </p>
              <p className="mt-1 text-sm text-[#5a7184]">
                WMS adjusted this request. Review the updated quantity or billing rate before continuing.
              </p>
            </div>

            <div className="space-y-2 rounded-xl border border-[#e3e9ef] bg-[#fbfdff] p-3">
              {revisedLines.length === 0 ? (
                <p className="text-sm text-[#5a7184]">
                  WMS requested a revision. Open the line items above to review the updated quote.
                </p>
              ) : (
                revisedLines.map((line) => (
                  <div
                    key={line.id}
                    className="rounded-lg border border-[#dce4ea] bg-white px-3 py-2.5"
                  >
                    <p className="text-sm font-semibold text-forergound">{line.label}</p>
                    <div className="mt-1 grid gap-2 text-xs text-[#5a7184] sm:grid-cols-2">
                      <p>
                        Quantity: <span className="font-semibold text-forergound">{line.originalQuantity}</span> to{' '}
                        <span className="font-semibold text-forergound">{line.revisedQuantity}</span>
                      </p>
                      <p>
                        Rate: <span className="font-semibold text-forergound">{formatPartnerCost(line.originalRate)}</span> to{' '}
                        <span className="font-semibold text-forergound">{formatPartnerCost(line.revisedRate)}</span>
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>

            {canRespondToRevision ? (
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={isRespondingToRevision}
                  onClick={() => void onRespondToRevision({ decision: 'REJECT' })}
                  className="inline-flex h-9 items-center rounded-lg border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Reject Changes
                </button>
                <button
                  type="button"
                  disabled={isRespondingToRevision}
                  onClick={() => void onRespondToRevision({ decision: 'ACCEPT' })}
                  className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-semibold text-white transition hover:bg-[#0f3040] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isRespondingToRevision ? 'Submitting...' : 'Accept Changes'}
                </button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card className="border-[#d9e2ec]" padding="none">
        <div className="space-y-3">
          <p className="panel-title">
            {isSelfBuy ? 'Shipment to Warehouse' : 'Payment Proof'}
          </p>

          {!isSelfBuy && paymentProofImageUrl ? (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => {
                  setActiveProofImageUrl(paymentProofImageUrl);
                  setIsProofImageZoomed(false);
                  setProofImageBaseSize(null);
                  setProofImageFocusPoint(null);
                }}
                className="block w-full overflow-hidden rounded-xl border border-[#e3e9ef] bg-white text-left transition hover:border-[#b9c9d4] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7fb0cc]/40"
                aria-label="Open payment proof image"
              >
                <img
                  src={paymentProofImageUrl}
                  alt="Payment proof"
                  className="h-auto max-h-[320px] w-full object-contain bg-[#f8fbfd]"
                />
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveProofImageUrl(paymentProofImageUrl);
                  setIsProofImageZoomed(false);
                  setProofImageBaseSize(null);
                  setProofImageFocusPoint(null);
                }}
                className="btn btn-sm btn-primary-soft"
              >
                Open uploaded proof
              </button>
              <p className="text-xs text-[#6d8191] dark:text-slate-300">
                Submitted: {formatDateTime(batch.paymentProofSubmittedAt || batch.paymentSubmittedAt)}
                {batch.paymentProofSubmittedBy ? ` · ${batch.paymentProofSubmittedBy.name}` : ''}
              </p>
            </div>
          ) : (
            <p className="text-sm text-[#5a7184] dark:text-slate-300">
              {isSelfBuy ? 'No shipment notice recorded yet.' : 'No payment proof uploaded yet.'}
            </p>
          )}

          {!isSelfBuy && canSubmitPaymentProof ? (
            <div className="space-y-2 rounded-xl border border-[#e3e9ef] bg-[#fbfdff] dark:border-border dark:bg-background-secondary p-3">
              <div className="space-y-2 rounded-xl border border-dashed border-[#d7e0e7] bg-surface p-3">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={isUploadingPaymentProofImage || isSubmittingPaymentProof}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) {
                      return;
                    }

                    void (async () => {
                      const asset = await onUploadPaymentProofImage(file);
                      if (!asset) {
                        return;
                      }

                      setProofAssetId(asset.assetId);
                      setProofPreviewUrl(asset.imageUrl);
                      setProofFileName(asset.originalFileName || file.name);
                    })();
                    event.currentTarget.value = '';
                  }}
                  className="block w-full text-sm text-[#4d6677] file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-[#0f3040]"
                />
                <p className="text-xs text-[#6d8191]">PNG, JPEG, or WebP. The server will compress and store the image automatically.</p>
                {proofPreviewUrl ? (
                  <div className="space-y-2">
                    <div className="overflow-hidden rounded-xl border border-[#e3e9ef] bg-[#f8fbfd]">
                      <img
                        src={proofPreviewUrl}
                        alt="Uploaded payment proof preview"
                        className="h-auto max-h-[320px] w-full object-contain"
                      />
                    </div>
                    <p className="text-xs text-[#6d8191]">
                      {proofFileName || 'Uploaded image ready'}
                    </p>
                  </div>
                ) : null}
              </div>
              <textarea
                value={proofMessage}
                onChange={(event) => setProofMessage(event.target.value)}
                placeholder="Optional message to WMS"
                rows={2}
                className="input"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={!proofAssetId || isSubmittingPaymentProof || isUploadingPaymentProofImage}
                  onClick={() =>
                    void onSubmitPaymentProof({
                      ...(proofAssetId ? { paymentProofAssetId: proofAssetId } : {}),
                      ...(proofMessage.trim() ? { message: proofMessage.trim() } : {}),
                    })
                  }
                  className="btn btn-md btn-primary-soft"
                >
                  {isUploadingPaymentProofImage
                    ? 'Uploading...'
                    : isSubmittingPaymentProof
                      ? 'Submitting...'
                      : 'Submit Payment Proof'}
                </button>
              </div>
            </div>
          ) : isSelfBuy && canMarkSelfBuyShipment ? (
            <div className="space-y-2 rounded-xl border border-[#e3e9ef] bg-[#fbfdff] p-3">
              <input
                value={shipmentReference}
                onChange={(event) => setShipmentReference(event.target.value)}
                placeholder="Optional shipment reference or tracking"
                className="input"
              />
              <textarea
                value={shipmentMessage}
                onChange={(event) => setShipmentMessage(event.target.value)}
                placeholder="Optional message to warehouse"
                rows={2}
                className="input"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={isMarkingSelfBuyShipment}
                  onClick={() =>
                    void onMarkSelfBuyShipment({
                      ...(shipmentReference.trim()
                        ? { shipmentReference: shipmentReference.trim() }
                        : {}),
                      ...(shipmentMessage.trim() ? { message: shipmentMessage.trim() } : {}),
                    })
                  }
                  className="btn btn-md btn-primary-soft"
                >
                  {isMarkingSelfBuyShipment ? 'Submitting...' : 'Mark Products Shipped'}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-[#6d8191] dark:text-slate-300">
              {isSelfBuy
                ? batch.status === 'UNDER_REVIEW'
                  ? 'WMS is reviewing the self-buy request before you ship products to warehouse.'
                  : batch.status === 'REVISION'
                    ? 'Accept the revised request first before shipping products to warehouse.'
                    : batch.status === 'SHIPPED'
                      ? 'WMS has been notified that products are on the way to the warehouse.'
                      : batch.status === 'RECEIVING_EXCEPTION'
                        ? 'WMS reported a mismatch on received stock. Review the notes and re-ship if needed.'
                        : batch.status === 'RECEIVING'
                          ? 'The warehouse is checking and serializing the delivered self-buy stock.'
                          : batch.status === 'STOCKED'
                            ? 'The self-buy stock has been accepted into warehouse inventory.'
                            : 'Shipment notice opens once WMS approves the self-buy request.'
                : batch.status === 'UNDER_REVIEW'
                  ? 'WMS is still reviewing this request.'
                  : batch.status === 'REVISION'
                    ? 'Accept the revised request first before submitting payment proof.'
                    : batch.status === 'PAYMENT_REVIEW'
                      ? 'Your payment proof is being reviewed by WMS.'
                      : batch.status === 'RECEIVING_READY'
                        ? 'Payment has been verified. The request is queued for warehouse receiving.'
                        : batch.status === 'RECEIVING'
                          ? 'The request is being received and serialized in the warehouse.'
                          : batch.status === 'STOCKED'
                            ? 'The request has been stocked into serialized inventory.'
                            : 'Payment proof submission opens when the request status is Pending Payment.'}
            </p>
          )}
        </div>
      </Card>
    </RequestDetailSection>

    <Dialog
      open={Boolean(activeProofImageUrl)}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          return;
        }
        setActiveProofImageUrl(null);
        setIsProofImageZoomed(false);
        setProofImageBaseSize(null);
        setProofImageFocusPoint(null);
      }}
    >
      <DialogContent
        className="max-w-[min(96vw,980px)] border-[#E2E8F0] bg-white p-4 sm:p-5"
        closeButtonClassName="data-[state=open]:bg-[#F1F5F9]"
        overlayClassName="backdrop-blur-[1.5px]"
      >
        <DialogHeader>
          <DialogTitle className="text-[#0F172A]">Payment Proof Preview</DialogTitle>
          <DialogDescription className="text-[#64748B]">
            Submitted {formatDateTime(batch.paymentProofSubmittedAt || batch.paymentSubmittedAt)}
          </DialogDescription>
        </DialogHeader>

        {activeProofImageUrl ? (
          <div className="flex min-h-[60dvh] items-center justify-center">
            <div className="flex min-h-[60dvh] items-center justify-center">
            <button
              type="button"
              onClick={() => setIsProofImageZoomed((current) => !current)}
              className="block h-full w-full cursor-zoom-in overflow-auto rounded-xl border border-white/10 bg-[#050f16] p-3 text-left"
              aria-label={isProofImageZoomed ? 'Zoom out payment proof image' : 'Zoom in payment proof image'}
            >
              <div
                className="mx-auto transition-[width,transform] duration-200 ease-out"
                style={{ width: isProofImageZoomed ? '160%' : '100%' }}
              >
                <img
                  src={activeProofImageUrl}
                  alt="Payment proof preview"
                  className={`block h-auto w-full rounded-xl border border-white/10 bg-white object-contain shadow-[0_24px_80px_-36px_rgba(0,0,0,0.7)] ${
                    isProofImageZoomed ? 'cursor-zoom-out' : 'cursor-zoom-in'
                  }`}
                />
              </div>
            </button>
          </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>

    <Dialog open={isInvoicePreviewOpen} onOpenChange={setIsInvoicePreviewOpen}>
      <DialogContent
        className="max-w-[min(96vw,1080px)] border-[#E2E8F0] bg-white p-4 sm:p-5"
        closeButtonClassName="data-[state=open]:bg-[#F1F5F9]"
        overlayClassName="backdrop-blur-[1.5px]"
      >
        <DialogHeader>
          <DialogTitle className="text-[#0F172A]">
            {linkedInvoice?.invoiceNumber ?? linkedInvoiceSummary?.invoiceNumber ?? 'Invoice Preview'}
          </DialogTitle>
          <DialogDescription className="text-[#64748B]">
            Preview the procurement invoice before downloading or printing.
          </DialogDescription>
        </DialogHeader>

        {linkedInvoice ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-[#e3e9ef] bg-[#fbfdff] p-3">
                <p className="card-label">Status</p>
                <p className="mt-1 text-sm font-semibold text-forergound">{linkedInvoice.status.replaceAll('_', ' ')}</p>
              </div>
              <div className="rounded-xl border border-[#e3e9ef] bg-[#fbfdff] p-3">
                <p className="card-label">Issue Date</p>
                <p className="mt-1 text-sm font-semibold text-forergound">{formatShortDate(linkedInvoice.issueDate)}</p>
              </div>
              <div className="rounded-xl border border-[#e3e9ef] bg-[#fbfdff] p-3">
                <p className="card-label">Amount Due</p>
                <p className="mt-1 text-sm font-semibold text-forergound">{formatPartnerCost(hasPendingPartnerCost ? null : linkedInvoice.amountDue)}</p>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-[#e3e9ef] dark:border-border">
              <table className="min-w-full divide-y divide-[#edf2f7] text-sm dark:divide-border">
                <thead className="bg-[#eff3f6] text-left text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7b8ba1] dark:bg-background-secondary dark:text-slate-300">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Rate</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#edf2f7] bg-white dark:divide-border dark:bg-surface">
                  {linkedInvoice.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="px-3 py-2.5 text-[#4d6677] dark:text-slate-300">{line.lineNo}</td>
                      <td className="px-3 py-2.5 font-medium text-forergound">
                        <div>{line.description}</div>
                        {line.store?.name ? (
                          <div className="mt-1 text-xs font-normal text-[#6d8191] dark:text-slate-400">
                            {line.store.name}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-forergound">{line.quantity}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-forergound">{formatPartnerCost(hasPendingPartnerCost ? null : line.unitRate)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-forergound">{formatPartnerCost(hasPendingPartnerCost ? null : line.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsInvoicePreviewOpen(false)}
                className="btn btn-sm btn-secondary"
              >
                Close
              </button>
              <button
                type="button"
                disabled={isPrintingLinkedInvoice || !canPrintInvoice}
                onClick={() => { if (canPrintInvoice) void onPrintLinkedInvoice(); }}
                className="btn btn-sm btn-primary-soft"
              >
                {isPrintingLinkedInvoice ? 'Preparing...' : 'Print / Save PDF'}
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-[#e3e9ef] bg-[#fbfdff] p-4 text-sm text-[#5a7184]">
            {isLoadingLinkedInvoice ? 'Loading invoice...' : linkedInvoiceError || 'Invoice preview is not available.'}
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}

const PAYMENT_PROOF_ZOOM_SCALE = 2;

function RequestDetailSection({
  children,
  contentClassName,
}: {
  children: ReactNode;
  contentClassName?: string;
}) {
  return (
    <DashboardSection
      title="Request Detail"
      icon={<Receipt className="panel-icon" />}
      contentClassName={contentClassName}
    >
      {children}
    </DashboardSection>
  );
}

function getSafeImageUrl(url: string | null | undefined) {
  if (!url) {
    return null;
  }

  const normalized = url.trim();
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized, 'https://safe-preview.local');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isKnownPartnerCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function formatPartnerCost(value: unknown) {
  return isKnownPartnerCost(value) ? formatMoney(value) : 'Partner cost pending / unavailable';
}

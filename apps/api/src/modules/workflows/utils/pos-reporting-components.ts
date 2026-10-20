/** Pure saved-POS reporting components shared by reconciliation and Store analytics.
 * This reads ERP PosOrder.cogs only; it never infers or writes product/WMS costs.
 */
export interface PosOrderLite {
  pUtmContent?: string | null;
  shopId: string;
  posOrderId: string;
  cod?: any;
  teamId?: string | null;
  status?: number | null;
  isVoid?: boolean | null;
  isAbandoned?: boolean | null;
  wasAbandonedCart?: boolean | null;
  isRepurchase?: boolean | null;
  cogs?: any;
  tracking?: string | null;
  mapping?: string | null;
}

export function excludesPosOrderFromSalesTotals(
  order: Pick<PosOrderLite, 'status' | 'isVoid'>,
): boolean {
  return order.status === 7 || order.isVoid === true;
}

export type PosAggregateBucket = {
  purchasesPos: number;
  processedPurchasesPos: number;
  codPos: number;
  cogsPos: number;
  cogsCurrentAbandonedPos: number;
  repurchaseCogsCurrentAbandonedPos: number;
  cogsCanceledPos: number;
  cogsRestockingPos: number;
  cogsRtsPos: number;
  cogsDeliveredPos: number;
  confirmedCount: number;
  unconfirmedCount: number;
  printedCount: number;
  deletedCount: number;
  restockingCount: number;
  abandonedCount: number;
  currentAbandonedCount: number;
  waitingPickupCount: number;
  shippedCount: number;
  deliveredCount: number;
  canceledCount: number;
  rtsCount: number;
  confirmedCodPos: number;
  unconfirmedCodPos: number;
  abandonedCodPos: number;
  currentAbandonedCodPos: number;
  canceledCodPos: number;
  restockingCodPos: number;
  rtsCodPos: number;
  deliveredCodPos: number;
  shippedCodPos: number;
  waitingPickupCodPos: number;
  repurchaseCount: number;
  repurchaseProcessedPurchasesPos: number;
  repurchaseCodPos: number;
  repurchaseCogsPos: number;
  repurchaseCogsCanceledPos: number;
  repurchaseCogsRestockingPos: number;
  repurchaseCogsRtsPos: number;
  repurchaseCogsDeliveredPos: number;
  repurchaseConfirmedCount: number;
  repurchaseUnconfirmedCount: number;
  repurchasePrintedCount: number;
  repurchaseDeletedCount: number;
  repurchaseRestockingCount: number;
  repurchaseAbandonedCount: number;
  repurchaseCurrentAbandonedCount: number;
  repurchaseWaitingPickupCount: number;
  repurchaseShippedCount: number;
  repurchaseDeliveredCount: number;
  repurchaseCanceledCount: number;
  repurchaseRtsCount: number;
  repurchaseConfirmedCodPos: number;
  repurchaseUnconfirmedCodPos: number;
  repurchaseAbandonedCodPos: number;
  repurchaseCurrentAbandonedCodPos: number;
  repurchaseCanceledCodPos: number;
  repurchaseRestockingCodPos: number;
  repurchaseRtsCodPos: number;
  repurchaseDeliveredCodPos: number;
  repurchaseShippedCodPos: number;
  repurchaseWaitingPickupCodPos: number;
  orders: PosOrderLite[];
};

export function createEmptyPosAggregateBucket(): PosAggregateBucket {
  return {
    purchasesPos: 0,
    processedPurchasesPos: 0,
    codPos: 0,
    cogsPos: 0,
    cogsCurrentAbandonedPos: 0,
    repurchaseCogsCurrentAbandonedPos: 0,
    cogsCanceledPos: 0,
    cogsRestockingPos: 0,
    cogsRtsPos: 0,
    cogsDeliveredPos: 0,
    confirmedCount: 0,
    unconfirmedCount: 0,
    printedCount: 0,
    deletedCount: 0,
    restockingCount: 0,
    abandonedCount: 0,
    currentAbandonedCount: 0,
    waitingPickupCount: 0,
    shippedCount: 0,
    deliveredCount: 0,
    canceledCount: 0,
    rtsCount: 0,
    confirmedCodPos: 0,
    unconfirmedCodPos: 0,
    abandonedCodPos: 0,
    currentAbandonedCodPos: 0,
    canceledCodPos: 0,
    restockingCodPos: 0,
    rtsCodPos: 0,
    deliveredCodPos: 0,
    shippedCodPos: 0,
    waitingPickupCodPos: 0,
    repurchaseCount: 0,
    repurchaseProcessedPurchasesPos: 0,
    repurchaseCodPos: 0,
    repurchaseCogsPos: 0,
    repurchaseCogsCanceledPos: 0,
    repurchaseCogsRestockingPos: 0,
    repurchaseCogsRtsPos: 0,
    repurchaseCogsDeliveredPos: 0,
    repurchaseConfirmedCount: 0,
    repurchaseUnconfirmedCount: 0,
    repurchasePrintedCount: 0,
    repurchaseDeletedCount: 0,
    repurchaseRestockingCount: 0,
    repurchaseAbandonedCount: 0,
    repurchaseCurrentAbandonedCount: 0,
    repurchaseWaitingPickupCount: 0,
    repurchaseShippedCount: 0,
    repurchaseDeliveredCount: 0,
    repurchaseCanceledCount: 0,
    repurchaseRtsCount: 0,
    repurchaseConfirmedCodPos: 0,
    repurchaseUnconfirmedCodPos: 0,
    repurchaseAbandonedCodPos: 0,
    repurchaseCurrentAbandonedCodPos: 0,
    repurchaseCanceledCodPos: 0,
    repurchaseRestockingCodPos: 0,
    repurchaseRtsCodPos: 0,
    repurchaseDeliveredCodPos: 0,
    repurchaseShippedCodPos: 0,
    repurchaseWaitingPickupCodPos: 0,
    orders: [],
  };
}

export function accumulatePosOrder(bucket: PosAggregateBucket, order: PosOrderLite, retainOrder = true): void {
  const status = order.status ?? -1;
  const codVal = parseFloat(order.cod ?? '0') || 0;
  const cogsVal = parseFloat(order.cogs ?? '0') || 0;
  const isRepurchase = order.isRepurchase === true;
  const wasEverAbandoned =
    order.wasAbandonedCart === true || order.isAbandoned === true;
  const isCurrentlyAbandoned = status === 0 && order.isAbandoned === true;
  const isDeleted = status === 7;
  const isPrinted = status === 13;

  if (excludesPosOrderFromSalesTotals(order)) {
    if (isDeleted) {
      bucket.deletedCount += 1;
      if (isRepurchase) bucket.repurchaseDeletedCount += 1;
    }
    if (isPrinted) {
      bucket.printedCount += 1;
      if (isRepurchase) bucket.repurchasePrintedCount += 1;
    }
    if (retainOrder) bucket.orders.push(order);
    return;
  }

  bucket.purchasesPos += 1;
  bucket.codPos += codVal;
  bucket.cogsPos += cogsVal;
  if (order.tracking && order.tracking !== '') {
    bucket.processedPurchasesPos += 1;
  }

  if (isRepurchase) {
    bucket.repurchaseCount += 1;
    bucket.repurchaseCodPos += codVal;
    bucket.repurchaseCogsPos += cogsVal;
    if (order.tracking && order.tracking !== '') {
      bucket.repurchaseProcessedPurchasesPos += 1;
    }
  }

  if (status === 0) {
    bucket.unconfirmedCount += 1;
    bucket.unconfirmedCodPos += codVal;
    if (isRepurchase) {
      bucket.repurchaseUnconfirmedCount += 1;
      bucket.repurchaseUnconfirmedCodPos += codVal;
    }
  }
  if (wasEverAbandoned) {
    bucket.abandonedCount += 1;
    bucket.abandonedCodPos += codVal;
    if (isRepurchase) {
      bucket.repurchaseAbandonedCount += 1;
      bucket.repurchaseAbandonedCodPos += codVal;
    }
  }
  if (isCurrentlyAbandoned) {
    bucket.cogsCurrentAbandonedPos += cogsVal;
    bucket.currentAbandonedCount += 1;
    bucket.currentAbandonedCodPos += codVal;
    if (isRepurchase) {
      bucket.repurchaseCogsCurrentAbandonedPos += cogsVal;
      bucket.repurchaseCurrentAbandonedCount += 1;
      bucket.repurchaseCurrentAbandonedCodPos += codVal;
    }
  }
  if (status === 1) {
    bucket.confirmedCount += 1;
    bucket.confirmedCodPos += codVal;
    if (isRepurchase) {
      bucket.repurchaseConfirmedCount += 1;
      bucket.repurchaseConfirmedCodPos += codVal;
    }
  }
  if (status === 13) {
    bucket.printedCount += 1;
    if (isRepurchase) {
      bucket.repurchasePrintedCount += 1;
    }
  }
  if (status === 11) {
    bucket.restockingCount += 1;
    bucket.restockingCodPos += codVal;
    bucket.cogsRestockingPos += cogsVal;
    if (isRepurchase) {
      bucket.repurchaseRestockingCount += 1;
      bucket.repurchaseRestockingCodPos += codVal;
      bucket.repurchaseCogsRestockingPos += cogsVal;
    }
  }
  if (status === 9 || status === 13) {
    bucket.waitingPickupCount += 1;
    bucket.waitingPickupCodPos += codVal;
    if (isRepurchase) {
      bucket.repurchaseWaitingPickupCount += 1;
      bucket.repurchaseWaitingPickupCodPos += codVal;
    }
  }
  if (status === 2) {
    bucket.shippedCount += 1;
    bucket.shippedCodPos += codVal;
    if (isRepurchase) {
      bucket.repurchaseShippedCount += 1;
      bucket.repurchaseShippedCodPos += codVal;
    }
  }
  if (status === 3) {
    bucket.deliveredCount += 1;
    bucket.deliveredCodPos += codVal;
    bucket.cogsDeliveredPos += cogsVal;
    if (isRepurchase) {
      bucket.repurchaseDeliveredCount += 1;
      bucket.repurchaseDeliveredCodPos += codVal;
      bucket.repurchaseCogsDeliveredPos += cogsVal;
    }
  }
  if (status === 6) {
    bucket.canceledCount += 1;
    bucket.canceledCodPos += codVal;
    bucket.cogsCanceledPos += cogsVal;
    if (isRepurchase) {
      bucket.repurchaseCanceledCount += 1;
      bucket.repurchaseCanceledCodPos += codVal;
      bucket.repurchaseCogsCanceledPos += cogsVal;
    }
  }
  if (status === 4 || status === 5) {
    bucket.rtsCount += 1;
    bucket.rtsCodPos += codVal;
    bucket.cogsRtsPos += cogsVal;
    if (isRepurchase) {
      bucket.repurchaseRtsCount += 1;
      bucket.repurchaseRtsCodPos += codVal;
      bucket.repurchaseCogsRtsPos += cogsVal;
    }
  }

  if (retainOrder) bucket.orders.push(order);
}


export function calculatePosFees(agg: PosAggregateBucket | null | undefined) {
  const nonCanceled = agg ? Math.max(agg.purchasesPos - agg.canceledCount, 0) : 0;
  const repurchaseNonCanceled = agg ? Math.max(agg.repurchaseCount - agg.repurchaseCanceledCount, 0) : 0;
  const sf = nonCanceled * 60;
  const repurchaseSf = repurchaseNonCanceled * 60;
  const ff = nonCanceled * 25;
  const repurchaseFf = repurchaseNonCanceled * 25;
  const inf = nonCanceled * 5;
  const repurchaseIf = repurchaseNonCanceled * 5;
  const sdr = agg ? agg.shippedCount + agg.deliveredCount + agg.rtsCount : 0;
  const repurchaseSdr = agg ? agg.repurchaseShippedCount + agg.repurchaseDeliveredCount + agg.repurchaseRtsCount : 0;
  const sfSdr = sdr * 60;
  const repurchaseSfSdr = repurchaseSdr * 60;
  const ffSdr = sdr * 25;
  const repurchaseFfSdr = repurchaseSdr * 25;
  const infSdr = sdr * 5;
  const repurchaseIfSdr = repurchaseSdr * 5;
  const eligibleCod = agg
    ? Math.max(agg.codPos - agg.rtsCodPos - agg.canceledCodPos, 0)
    : 0;
  const repurchaseEligibleCod = agg
    ? Math.max(agg.repurchaseCodPos - agg.repurchaseRtsCodPos - agg.repurchaseCanceledCodPos, 0)
    : 0;
  const codFee = eligibleCod * 0.0224;
  const repurchaseCodFee = repurchaseEligibleCod * 0.0224;
  const codFeeDelivered = (agg?.deliveredCodPos ?? 0) * 0.0224;
  const repurchaseCodFeeDelivered = (agg?.repurchaseDeliveredCodPos ?? 0) * 0.0224;

  return {
    sf, repurchaseSf, ff, repurchaseFf, inf, repurchaseIf,
    sfSdr, repurchaseSfSdr, ffSdr, repurchaseFfSdr, infSdr, repurchaseIfSdr,
    codFee, repurchaseCodFee, codFeeDelivered, repurchaseCodFeeDelivered,
  };
}

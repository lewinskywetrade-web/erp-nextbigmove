import { describe, expect, it } from '@jest/globals';
import { accumulatePosOrder, calculatePosFees, createEmptyPosAggregateBucket } from './pos-reporting-components';

describe('Canonical saved ERP POS components', () => {
  it('retains every lifecycle/repurchase component and historical abandoned evidence', () => {
    const bucket = createEmptyPosAggregateBucket();
    for (const status of [0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 13]) {
      for (const isRepurchase of [false, true]) accumulatePosOrder(bucket, {
        shopId: 'shop', posOrderId: `${status}-${isRepurchase}`, status, cod: '100.25', cogs: '20.50',
        tracking: status === 0 ? null : 'tracking', isRepurchase,
        isAbandoned: status === 0, wasAbandonedCart: status === 3,
      });
    }
    expect(bucket.orders).toHaveLength(24);
    expect(bucket.purchasesPos).toBe(22);
    expect(bucket.repurchaseCount).toBe(11);
    expect(bucket.codPos).toBe(2205.5);
    expect(bucket.cogsPos).toBe(451);
    expect(bucket.repurchaseCogsPos).toBe(225.5);
    expect(bucket.processedPurchasesPos).toBe(20);
    expect(bucket.waitingPickupCount).toBe(4); // statuses9 and13
    expect(bucket.rtsCount).toBe(4);
    expect(bucket.cogsRtsPos).toBe(82);
    expect(bucket.deletedCount).toBe(2);
    expect(bucket.currentAbandonedCount).toBe(2);
    expect(bucket.abandonedCount).toBe(4);
    expect(calculatePosFees(bucket)).toMatchObject({ sf: 1200, ff: 500, inf: 100,
      sfSdr: 480, repurchaseSfSdr: 240, codFee: 35.9296, repurchaseCodFee: 17.9648 });
  });

  it('keeps void printed/deleted tombstone counts but contributes no money or fees', () => {
    const bucket = createEmptyPosAggregateBucket();
    for (const status of [3, 7, 13]) accumulatePosOrder(bucket, {
      shopId: 'shop', posOrderId: String(status), status, cod: 90000, cogs: 80000,
      isVoid: true, isRepurchase: true,
    });
    expect(bucket.purchasesPos).toBe(0);
    expect(bucket.cogsPos).toBe(0);
    expect(bucket.printedCount).toBe(1);
    expect(bucket.deletedCount).toBe(1);
    expect(bucket.repurchasePrintedCount).toBe(1);
    expect(Object.values(calculatePosFees(bucket)).every(value => value === 0)).toBe(true);
  });

  it('can aggregate a streamed page without retaining the order objects', () => {
    const bucket = createEmptyPosAggregateBucket();
    accumulatePosOrder(bucket, { shopId: 'shop', posOrderId: 'order', status: 3, cod: 1000, cogs: 123.45 }, false);
    expect(bucket.orders).toEqual([]);
    expect(bucket.cogsDeliveredPos).toBe(123.45);
    expect(calculatePosFees(bucket)).toMatchObject({ sf: 60, ff: 25, inf: 5, codFee: 22.4, codFeeDelivered: 22.4 });
    expect(Object.values(calculatePosFees(null)).every(value => value === 0)).toBe(true);
  });
});

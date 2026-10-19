import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class WmsInventoryCogsService {
  constructor(_prisma: PrismaService) {}

  /**
   * Compatibility entry point for warehouse completion/dispatch callers.
   * WMS unit costs are the actual warehouse basis; ERP PosOrder.cogs is a
   * separate reporting basis calculated from the ERP product catalog.
   * Warehouse processing must not replace it with WMS costs.
   */
  async syncPosOrderCogsFromMatchedInventoryUnits(_params: {
    tenantId?: string | null;
    storeId?: string | null;
    fulfillmentOrderIds?: string[];
    posOrderRefs?: Array<{
      shopId: string;
      posOrderId: string;
    }>;
  }) {
    return { updatedOrders: 0, skippedOrders: 0 };
  }
}

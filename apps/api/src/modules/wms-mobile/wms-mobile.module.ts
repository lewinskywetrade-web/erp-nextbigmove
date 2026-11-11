import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { IntegrationModule } from '../integrations/integration.module';
import { OrdersModule } from '../orders/orders.module';
import { WmsFulfillmentModule } from '../wms-fulfillment/wms-fulfillment.module';
import { WmsInventoryModule } from '../wms-inventory/wms-inventory.module';
import { WmsSettingsModule } from '../wms-settings/wms-settings.module';
import { WmsMobileController } from './wms-mobile.controller';
import {
  WMS_PACKING_POST_COMPLETE_QUEUE,
  WMS_PICKING_HANDOFF_QUEUE,
} from './wms-mobile.constants';
import { WmsMobileProcessor } from './wms-mobile.processor';
import { WmsPackingProcessor } from './wms-packing.processor';
import { WmsMobileService } from './wms-mobile.service';
import {
  resolveProcessRole,
  shouldRunApiBackgroundServices,
} from '../../common/runtime/process-role';

@Module({
  imports: [
    WmsInventoryModule,
    WmsFulfillmentModule,
    WmsSettingsModule,
    OrdersModule,
    IntegrationModule,
    BullModule.registerQueue({
      name: WMS_PICKING_HANDOFF_QUEUE,
    }),
    BullModule.registerQueue({
      name: WMS_PACKING_POST_COMPLETE_QUEUE,
    }),
  ],
  controllers: [WmsMobileController],
  providers: [
    WmsMobileService,
    ...(shouldRunApiBackgroundServices() ? [WmsMobileProcessor] : []),
    ...(resolveProcessRole() !== 'api' ? [WmsPackingProcessor] : []),
  ],
})
export class WmsMobileModule {}

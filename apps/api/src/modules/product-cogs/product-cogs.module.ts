import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PANCAKE_WEBHOOK_RECONCILE_QUEUE } from '../integrations/pancake-webhook.constants';
import { ProductCogsRefreshPublisherService } from '../integrations/services/product-cogs-refresh-publisher.service';
import { WmsCogsSyncService } from './wms-cogs-sync.service';

@Module({
  imports: [PrismaModule, BullModule.registerQueue({ name: PANCAKE_WEBHOOK_RECONCILE_QUEUE })],
  providers: [ProductCogsRefreshPublisherService, WmsCogsSyncService],
  exports: [ProductCogsRefreshPublisherService, WmsCogsSyncService],
})
export class ProductCogsModule {}

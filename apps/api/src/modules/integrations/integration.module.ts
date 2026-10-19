import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { WmsFulfillmentModule } from '../wms-fulfillment/wms-fulfillment.module';
import { WmsInventoryModule } from '../wms-inventory/wms-inventory.module';
import { IntegrationController } from './integration.controller';
import { PancakeWebhookController } from './pancake-webhook.controller';
import { IntegrationService } from './integration.service';
import { EncryptionService } from './services/encryption.service';
import { MetaInsightService } from './services/meta-insight.service';
import { PosOrderService } from './services/pos-order.service';
import { ProductCogsRecalculationService } from './services/product-cogs-recalculation.service';
import { ProductCogsRefreshPublisherService } from './services/product-cogs-refresh-publisher.service';
import { PosShopOwnershipService } from './services/pos-shop-ownership.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { ProviderFactory } from './providers/provider.factory';
import { ProviderRegistry } from './providers/provider.registry';
import { MetaAdsProvider } from './providers/meta-ads.provider';
import { PancakePosProvider } from './providers/pancake-pos.provider';
import { IntegrationProvider } from './dto/create-integration.dto';
import {
  PANCAKE_WEBHOOK_QUEUE,
  PANCAKE_WEBHOOK_RECONCILE_QUEUE,
} from './pancake-webhook.constants';
import { PancakeWebhookQueueProcessor } from './processors/pancake-webhook.processor';
import { shouldRunPancakeWorkers } from '../../common/runtime/process-role';
import { CreativeAgentModule } from '../creative-agent/creative-agent.module';

@Module({
  imports: [
    PrismaModule,
    CreativeAgentModule,
    WmsInventoryModule,
    WmsFulfillmentModule,
    BullModule.registerQueue({
      name: PANCAKE_WEBHOOK_QUEUE,
    }),
    BullModule.registerQueue({
      name: PANCAKE_WEBHOOK_RECONCILE_QUEUE,
    }),
  ],
  controllers: [IntegrationController, PancakeWebhookController],
  providers: [
    IntegrationService,
    EncryptionService,
    MetaInsightService,
    PosOrderService,
    ProductCogsRecalculationService,
    ProductCogsRefreshPublisherService,
    PosShopOwnershipService,
    ...(shouldRunPancakeWorkers() ? [PancakeWebhookQueueProcessor] : []),
    ProviderRegistry,
    ProviderFactory,
  ],
  exports: [
    IntegrationService,
    EncryptionService,
    ProviderFactory,
    MetaInsightService,
    PosOrderService,
    ProductCogsRecalculationService,
    PosShopOwnershipService,
  ],
})
export class IntegrationModule implements OnModuleInit {
  constructor(private readonly providerRegistry: ProviderRegistry) {}

  /**
   * Register all available integration providers when module initializes
   */
  onModuleInit() {
    this.providerRegistry.registerProvider(
      IntegrationProvider.META_ADS,
      MetaAdsProvider,
    );
    this.providerRegistry.registerProvider(
      IntegrationProvider.PANCAKE_POS,
      PancakePosProvider,
    );
  }
}

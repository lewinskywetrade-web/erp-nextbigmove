import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { IntegrationModule } from '../integrations/integration.module';
import { ProductCogsModule } from '../product-cogs/product-cogs.module';
import { WmsFulfillmentModule } from '../wms-fulfillment/wms-fulfillment.module';
import { WmsProductsController } from './wms-products.controller';
import { WmsProductsService } from './wms-products.service';

@Module({
  imports: [PrismaModule, IntegrationModule, ProductCogsModule, WmsFulfillmentModule],
  controllers: [WmsProductsController],
  providers: [WmsProductsService],
  exports: [WmsProductsService],
})
export class WmsProductsModule {}

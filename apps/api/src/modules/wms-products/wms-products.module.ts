import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { IntegrationModule } from '../integrations/integration.module';
import { ProductCogsModule } from '../product-cogs/product-cogs.module';
import { WmsProductsController } from './wms-products.controller';
import { WmsProductsService } from './wms-products.service';

@Module({
  imports: [PrismaModule, IntegrationModule, ProductCogsModule],
  controllers: [WmsProductsController],
  providers: [WmsProductsService],
  exports: [WmsProductsService],
})
export class WmsProductsModule {}

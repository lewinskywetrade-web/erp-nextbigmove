import { Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { TenantController } from './tenant.controller';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WmsFulfillmentModule } from '../wms-fulfillment/wms-fulfillment.module';

@Module({
  imports: [PrismaModule, WmsFulfillmentModule],
  controllers: [TenantController],
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}

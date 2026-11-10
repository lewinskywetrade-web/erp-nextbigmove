import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WmsReportsController } from './wms-reports.controller';
import { WmsReportsService } from './wms-reports.service';
import { WmsDailyInventoryEmailService } from './wms-daily-inventory-email.service';

@Module({
  imports: [PrismaModule],
  controllers: [WmsReportsController],
  providers: [WmsReportsService, WmsDailyInventoryEmailService],
  exports: [WmsReportsService, WmsDailyInventoryEmailService],
})
export class WmsReportsModule {}

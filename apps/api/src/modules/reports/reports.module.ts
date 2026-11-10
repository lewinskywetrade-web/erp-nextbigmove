import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WmsReportsModule } from '../wms-reports/wms-reports.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [PrismaModule, WmsReportsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}

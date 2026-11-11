import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WmsReportsModule } from '../wms-reports/wms-reports.module';
import { OpsDigestController } from './ops-digest.controller';
import { OpsDigestGuard } from './ops-digest.guard';
import { OpsDigestService } from './ops-digest.service';

@Module({
  imports: [PrismaModule, WmsReportsModule],
  controllers: [OpsDigestController],
  providers: [OpsDigestGuard, OpsDigestService],
})
export class OpsDigestModule {}

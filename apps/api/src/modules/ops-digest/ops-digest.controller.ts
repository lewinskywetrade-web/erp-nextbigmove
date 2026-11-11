import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { GetOpsDailyDigestDto } from './dto/get-ops-daily-digest.dto';
import { SendOpsDailyDigestEmailDto } from './dto/send-ops-daily-digest-email.dto';
import { OpsDigestGuard } from './ops-digest.guard';
import { OpsDigestService } from './ops-digest.service';

@Controller('ops')
@UseGuards(OpsDigestGuard)
export class OpsDigestController {
  constructor(private readonly opsDigestService: OpsDigestService) {}

  @Get('daily-digest')
  getDailyDigest(@Query() query: GetOpsDailyDigestDto) {
    return this.opsDigestService.getDailyDigest(query);
  }

  @Post('daily-digest/send-email')
  sendDailyDigestEmail(@Body() dto: SendOpsDailyDigestEmailDto) {
    return this.opsDigestService.sendDailyDigestEmail(dto);
  }
}

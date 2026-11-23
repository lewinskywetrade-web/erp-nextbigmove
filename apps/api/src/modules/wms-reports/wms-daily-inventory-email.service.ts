import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TenantStatus } from '@prisma/client';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import * as net from 'net';
import * as tls from 'tls';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  SendWmsDailyInventoryEmailDto,
  SendWmsWarehouseDailyInventoryEmailDto,
} from './dto/wms-daily-inventory-email.dto';
import {
  ClientDailyInventorySummary,
  DailyInventoryMovementRow,
  DailyInventoryMovementsReportTotals,
  DailyInventoryReportScopeOptions,
  WarehouseDailyInventoryEmailSubscription,
  WmsReportsService,
} from './wms-reports.service';

dayjs.extend(utc);
dayjs.extend(timezone);

const MANILA_TZ = 'Asia/Manila';
const ACTIVE_TENANT_STATUSES = [TenantStatus.ACTIVE, TenantStatus.TRIAL] as const;

type EmailPayload = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  csvFilename: string;
  csvContent: string;
};

type DeliveryOutcome = {
  delivered: boolean;
  status: 'SENT' | 'LOGGED_READY' | 'SKIPPED_NO_RECIPIENTS' | 'FAILED';
  mode: 'RESEND' | 'SENDGRID' | 'POSTMARK' | 'WEBHOOK' | 'SMTP' | 'LOG_PREVIEW';
  error?: string | null;
};

@Injectable()
export class WmsDailyInventoryEmailService implements OnModuleInit {
  private readonly logger = new Logger(WmsDailyInventoryEmailService.name);
  private isCronRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wmsReportsService: WmsReportsService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    void this.processScheduledDailyEmails();
  }

  @Cron('*/5 * * * *')
  async runEveryFiveMinutesDailyReportCheck() {
    await this.processScheduledDailyEmails();
  }

  @Cron('0 20 * * *')
  async runEveningDailyReportScheduleCheck() {
    await this.processScheduledDailyEmails();
  }

  async processScheduledDailyEmails() {
    if (process.env.PROCESS_ROLE === 'worker') {
      return;
    }
    if (process.env.WMS_DAILY_INVENTORY_EMAIL_CRON_ENABLED === 'false') {
      return;
    }
    if (this.isCronRunning) {
      return;
    }

    this.isCronRunning = true;
    try {
      const nowManila = dayjs().tz(MANILA_TZ);
      const todayManila = nowManila.format('YYYY-MM-DD');
      const currentHm = nowManila.format('HH:mm');

      const activeTenants = await this.prisma.tenant.findMany({
        where: {
          status: { in: [...ACTIVE_TENANT_STATUSES] },
        },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }],
      });

      if (activeTenants.length === 0) {
        return;
      }

      const subscriptions = await this.wmsReportsService.getSubscriptionsForTenants(
        activeTenants.map((tenant) => tenant.id),
      );

      for (const sub of subscriptions) {
        if (!sub.enabled) {
          continue;
        }
        if (sub.lastSentDate === todayManila) {
          continue;
        }
        if (currentHm < sub.sendTimeManila) {
          continue;
        }
        if (sub.effectiveRecipients.length === 0) {
          continue;
        }

        try {
          await this.sendForTenant({
            tenantId: sub.tenantId,
            startDate: todayManila,
            endDate: todayManila,
            recipients: sub.effectiveRecipients,
            bypassClsForCron: true,
          });
        } catch (error) {
          this.logger.warn(
            `Daily inventory email failed for client ${sub.tenantName}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      await this.processScheduledWarehouseDailyEmail(todayManila, currentHm);
    } finally {
      this.isCronRunning = false;
    }
  }

  private async processScheduledWarehouseDailyEmail(
    todayManila: string,
    currentHm: string,
  ) {
    try {
      const sub = await this.wmsReportsService.getWarehouseDailyEmailSubscription();
      if (!sub.enabled) {
        return;
      }
      if (sub.lastSentDate === todayManila) {
        return;
      }
      if (currentHm < sub.sendTimeManila) {
        return;
      }
      if (sub.effectiveRecipients.length === 0) {
        return;
      }

      await this.sendWarehouseSummary({
        startDate: todayManila,
        endDate: todayManila,
        tenantIds: [],
        recipients: sub.effectiveRecipients,
        bypassClsForCron: true,
        subscription: sub,
      });
    } catch (error) {
      this.logger.warn(
        `Daily warehouse inventory summary email failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async previewWarehouseNow(query: {
    date?: string;
    startDate?: string;
    endDate?: string;
    tenantIds?: string[];
  }) {
    this.wmsReportsService.assertGlobalWmsAccess();
    const window = this.wmsReportsService.normalizeDateWindow({
      date: query.date,
      startDate: query.startDate,
      endDate: query.endDate,
    });
    const [reportData, subscription] = await Promise.all([
      this.wmsReportsService.getWarehouseDailyInventoryData({
        startDate: window.startDate,
        endDate: window.endDate,
        tenantIds: query.tenantIds ?? [],
        storeIds: [],
      }),
      this.wmsReportsService.getWarehouseDailyEmailSubscription(),
    ]);

    const content = this.buildWarehouseEmailContent({
      startDate: window.startDate,
      endDate: window.endDate,
      totals: reportData.totals,
      rows: reportData.rows,
      clientSummaries: reportData.clientSummaries,
      generatedAt: reportData.report.generatedAt,
      sendTimeManila: subscription.sendTimeManila,
    });

    return {
      ...content,
      totals: reportData.totals,
      clientCount: reportData.clientSummaries.length,
      subscription,
    };
  }

  async sendWarehouseNow(dto: SendWmsWarehouseDailyInventoryEmailDto) {
    this.wmsReportsService.assertGlobalWmsAccess();
    const window = this.wmsReportsService.normalizeDateWindow({
      date: dto.date,
      startDate: dto.startDate,
      endDate: dto.endDate,
    });
    const sub = await this.wmsReportsService.getWarehouseDailyEmailSubscription();
    const recipients =
      dto.recipients && dto.recipients.length > 0
        ? dto.recipients
        : sub.effectiveRecipients;

    if (recipients.length === 0) {
      throw new BadRequestException(
        'No recipient email address is configured for the warehouse daily report. Please enter at least one email address.',
      );
    }

    return this.sendWarehouseSummary({
      startDate: window.startDate,
      endDate: window.endDate,
      tenantIds: dto.tenantIds ?? [],
      recipients,
      bypassClsForCron: false,
      subscription: sub,
    });
  }

  private async sendWarehouseSummary(params: {
    startDate: string;
    endDate: string;
    tenantIds: string[];
    recipients: string[];
    bypassClsForCron: boolean;
    subscription: WarehouseDailyInventoryEmailSubscription;
  }) {
    const reportData = await this.wmsReportsService.getWarehouseDailyInventoryData(
      {
        startDate: params.startDate,
        endDate: params.endDate,
        tenantIds: params.tenantIds,
        storeIds: [],
      },
      { bypassClsForCron: params.bypassClsForCron },
    );

    const content = this.buildWarehouseEmailContent({
      startDate: params.startDate,
      endDate: params.endDate,
      totals: reportData.totals,
      rows: reportData.rows,
      clientSummaries: reportData.clientSummaries,
      generatedAt: reportData.report.generatedAt,
      sendTimeManila: params.subscription.sendTimeManila,
    });

    const outcome = await this.deliverEmail({
      from: this.resolveFromAddress(),
      to: params.recipients,
      subject: content.subject,
      html: content.html,
      text: content.text,
      csvFilename: content.csvFilename,
      csvContent: content.csvContent,
    });

    const sentAt = new Date().toISOString();
    const nowManila = dayjs().tz(MANILA_TZ);
    const todayManila = nowManila.format('YYYY-MM-DD');
    const currentHm = nowManila.format('HH:mm');
    const shouldMarkScheduledDay =
      params.bypassClsForCron
      || (params.endDate === todayManila && currentHm >= params.subscription.sendTimeManila);

    await this.wmsReportsService.recordWarehouseDailyEmailDeliveryResult({
      sentDate: shouldMarkScheduledDay ? params.endDate : null,
      sentAt,
      status: outcome.status,
      mode: outcome.mode,
      error: outcome.error ?? null,
    });

    const updatedSubscription = await this.wmsReportsService.getWarehouseDailyEmailSubscription();

    this.logger.log(
      `Warehouse daily inventory report (${content.dateLabel}, ${reportData.clientSummaries.length} clients) -> [${params.recipients.join(
        ', ',
      )}] status=${outcome.status} mode=${outcome.mode}`,
    );

    return {
      dateLabel: content.dateLabel,
      recipients: params.recipients,
      subject: content.subject,
      sentAt,
      delivery: outcome,
      clientCount: reportData.clientSummaries.length,
      subscription: updatedSubscription,
      preview: {
        subject: content.subject,
        html: content.html,
        text: content.text,
        csvFilename: content.csvFilename,
        csvContent: content.csvContent,
      },
    };
  }

  async sendNow(
    dto: SendWmsDailyInventoryEmailDto,
    options?: DailyInventoryReportScopeOptions,
  ) {
    const targetTenantId = this.wmsReportsService.resolveTargetTenantId(dto.tenantId, options);
    await this.wmsReportsService.assertCanManageClientPortalEmail(targetTenantId, options);
    const window = this.wmsReportsService.normalizeDateWindow({
      date: dto.date,
      startDate: dto.startDate,
      endDate: dto.endDate,
    });

    const [sub] = await this.wmsReportsService.getSubscriptionsForTenants([targetTenantId]);
    if (!sub) {
      throw new BadRequestException('Client not found');
    }

    const recipients =
      dto.recipients && dto.recipients.length > 0
        ? dto.recipients
        : sub.effectiveRecipients;

    if (recipients.length === 0) {
      throw new BadRequestException(
        'No recipient email address is configured for this client. Please enter at least one email address.',
      );
    }

    return this.sendForTenant({
      tenantId: targetTenantId,
      startDate: window.startDate,
      endDate: window.endDate,
      recipients,
      bypassClsForCron: false,
      enforceClientPortalScope: options?.enforceClientPortalScope,
    });
  }

  private async sendForTenant(params: {
    tenantId: string;
    startDate: string;
    endDate: string;
    recipients: string[];
    bypassClsForCron: boolean;
    enforceClientPortalScope?: boolean;
  }) {
    const reportData = await this.wmsReportsService.getDailyInventoryMovementsReport(
      {
        startDate: params.startDate,
        endDate: params.endDate,
        tenantIds: [params.tenantId],
        storeIds: [],
      },
      {
        bypassClsForCron: params.bypassClsForCron,
        enforceClientPortalScope: params.enforceClientPortalScope,
      },
    );

    const clientName =
      reportData.filters.partners.find((partner) => partner.id === params.tenantId)?.name
      ?? 'Client';
    const dateLabel =
      params.startDate === params.endDate
        ? params.startDate
        : `${params.startDate} to ${params.endDate}`;

    const subject = `[Daily Inventory Ins & Outs] ${clientName} — ${dateLabel}`;
    const csvFilename = `inventory-ins-outs-${this.slugify(clientName)}-${params.startDate}${
      params.endDate !== params.startDate ? `-to-${params.endDate}` : ''
    }.csv`;
    const csvContent = this.buildCsvContent(reportData.rows, params.startDate, params.endDate);
    const html = this.buildHtmlEmail({
      clientName,
      dateLabel,
      totals: reportData.totals,
      rows: reportData.rows,
      generatedAt: reportData.report.generatedAt,
    });
    const text = this.buildPlainTextEmail({
      clientName,
      dateLabel,
      totals: reportData.totals,
      rows: reportData.rows,
    });

    const fromAddress = this.resolveFromAddress();

    const outcome = await this.deliverEmail({
      from: fromAddress,
      to: params.recipients,
      subject,
      html,
      text,
      csvFilename,
      csvContent,
    });

    const sentAt = new Date().toISOString();
    await this.wmsReportsService.recordDailyEmailDeliveryResult(params.tenantId, {
      sentDate: params.endDate,
      sentAt,
      status: outcome.status,
      mode: outcome.mode,
      error: outcome.error ?? null,
    });

    const [updatedSubscription] = await this.wmsReportsService.getSubscriptionsForTenants([
      params.tenantId,
    ]);

    this.logger.log(
      `Daily inventory report for ${clientName} (${dateLabel}) -> [${params.recipients.join(
        ', ',
      )}] status=${outcome.status} mode=${outcome.mode}`,
    );

    return {
      tenantId: params.tenantId,
      clientName,
      dateLabel,
      recipients: params.recipients,
      subject,
      sentAt,
      delivery: outcome,
      subscription: updatedSubscription,
      preview: {
        subject,
        html,
        text,
        csvFilename,
        csvContent,
      },
    };
  }

  private async deliverEmail(payload: EmailPayload): Promise<DeliveryOutcome> {
    try {
      if (process.env.RESEND_API_KEY) {
        await this.sendViaResend(process.env.RESEND_API_KEY, payload);
        return { delivered: true, status: 'SENT', mode: 'RESEND' };
      }

      if (process.env.SENDGRID_API_KEY) {
        await this.sendViaSendGrid(process.env.SENDGRID_API_KEY, payload);
        return { delivered: true, status: 'SENT', mode: 'SENDGRID' };
      }

      if (process.env.POSTMARK_SERVER_TOKEN) {
        await this.sendViaPostmark(process.env.POSTMARK_SERVER_TOKEN, payload);
        return { delivered: true, status: 'SENT', mode: 'POSTMARK' };
      }

      if (process.env.EMAIL_WEBHOOK_URL) {
        await this.sendViaWebhook(process.env.EMAIL_WEBHOOK_URL, payload);
        return { delivered: true, status: 'SENT', mode: 'WEBHOOK' };
      }

      if (process.env.SMTP_HOST || process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD) {
        await this.sendViaSmtp(payload);
        return { delivered: true, status: 'SENT', mode: 'SMTP' };
      }

      return {
        delivered: true,
        status: 'LOGGED_READY',
        mode: 'LOG_PREVIEW',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`External email transport failed: ${message}`);
      return {
        delivered: false,
        status: 'FAILED',
        mode: process.env.SMTP_HOST ? 'SMTP' : 'LOG_PREVIEW',
        error: message,
      };
    }
  }

  private async sendViaResend(apiKey: string, payload: EmailPayload) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        attachments: [
          {
            filename: payload.csvFilename,
            content: Buffer.from(payload.csvContent, 'utf8').toString('base64'),
          },
        ],
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend API error (${response.status}): ${body}`);
    }
  }

  private async sendViaSendGrid(apiKey: string, payload: EmailPayload) {
    const fromEmailMatch = payload.from.match(/<([^>]+)>/);
    const fromEmail = fromEmailMatch ? fromEmailMatch[1] : payload.from;
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: payload.to.map((email) => ({ email })) }],
        from: { email: fromEmail },
        subject: payload.subject,
        content: [
          { type: 'text/plain', value: payload.text },
          { type: 'text/html', value: payload.html },
        ],
        attachments: [
          {
            content: Buffer.from(payload.csvContent, 'utf8').toString('base64'),
            filename: payload.csvFilename,
            type: 'text/csv',
            disposition: 'attachment',
          },
        ],
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`SendGrid API error (${response.status}): ${body}`);
    }
  }

  private async sendViaPostmark(token: string, payload: EmailPayload) {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        From: payload.from,
        To: payload.to.join(','),
        Subject: payload.subject,
        HtmlBody: payload.html,
        TextBody: payload.text,
        Attachments: [
          {
            Name: payload.csvFilename,
            Content: Buffer.from(payload.csvContent, 'utf8').toString('base64'),
            ContentType: 'text/csv',
          },
        ],
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Postmark API error (${response.status}): ${body}`);
    }
  }

  private async sendViaWebhook(webhookUrl: string, payload: EmailPayload) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Email webhook error (${response.status}): ${body}`);
    }
  }

  private async sendViaSmtp(payload: EmailPayload) {
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT || 465);
    const secure = process.env.SMTP_SECURE !== 'false' && port === 465;
    const user = process.env.SMTP_USER || 'wms-inventory-update@wetrade.com.ph';
    const pass = (process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
    const fromEmailMatch = payload.from.match(/<([^>]+)>/);
    const fromEnvelope = fromEmailMatch ? fromEmailMatch[1] : payload.from;

    const boundary = `----=_Part_${Date.now()}`;
    const mimeLines = [
      `From: ${payload.from}`,
      `To: ${payload.to.join(', ')}`,
      `Subject: ${payload.subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(payload.html, 'utf8').toString('base64'),
      '',
      `--${boundary}`,
      `Content-Type: text/csv; name="${payload.csvFilename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${payload.csvFilename}"`,
      '',
      Buffer.from(payload.csvContent, 'utf8').toString('base64'),
      '',
      `--${boundary}--`,
      '.',
    ];

    await new Promise<void>((resolve, reject) => {
      const socket: net.Socket | tls.TLSSocket = secure
        ? tls.connect({ host, port, rejectUnauthorized: false })
        : net.createConnection({ host, port });

      socket.setTimeout(15000);
      let buffer = '';
      const steps: Array<() => void> = [];

      const sendCommand = (cmd: string) => {
        socket.write(`${cmd}\r\n`);
      };

      steps.push(() => sendCommand(`EHLO ${host}`));
      if (user && pass) {
        steps.push(() => sendCommand('AUTH LOGIN'));
        steps.push(() => sendCommand(Buffer.from(user).toString('base64')));
        steps.push(() => sendCommand(Buffer.from(pass).toString('base64')));
      }
      steps.push(() => sendCommand(`MAIL FROM:<${fromEnvelope}>`));
      for (const recipient of payload.to) {
        steps.push(() => sendCommand(`RCPT TO:<${recipient}>`));
      }
      steps.push(() => sendCommand('DATA'));
      steps.push(() => sendCommand(mimeLines.join('\r\n')));
      steps.push(() => sendCommand('QUIT'));

      let stepIndex = 0;

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\r\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!/^\d{3} /.test(line)) continue;
          const code = Number(line.slice(0, 3));
          if (code >= 400) {
            socket.destroy();
            reject(new Error(`SMTP error: ${line}`));
            return;
          }
          const next = steps[stepIndex++];
          if (next) {
            next();
          } else {
            socket.end();
            resolve();
            return;
          }
        }
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('SMTP connection timed out'));
      });
      socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  private buildCsvContent(
    rows: DailyInventoryMovementRow[],
    startDate: string,
    endDate: string,
  ): string {
    const headers = [
      'Date Range',
      'Client',
      'Store',
      'Product Variant',
      'SKU / Code',
      'Stock In (Received)',
      'Stock In (Manual Input)',
      'Stock In (Restocked / RTS)',
      'Total Stock In',
      'Put Away to Bin',
      'Stock Out (Dispatched)',
      'Stock Out (Packed / Picked)',
      'Stock Out (Adjustments)',
      'Total Stock Out',
      'Net Change',
      'Current In Bin',
      'Awaiting Put-Away',
      'Reserved',
      'Total On-Hand Stock',
    ];

    const escapeCsv = (val: string | number | null | undefined) => {
      const str = val === null || val === undefined ? '' : String(val);
      if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const dateRange = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
    const bodyLines = rows.map((row) =>
      [
        dateRange,
        row.tenantName,
        row.storeName,
        row.variantName,
        row.variantCode || row.variantDisplayId || row.variationId,
        row.receivedInQty,
        row.manualInQty,
        row.restockedInQty,
        row.totalInQty,
        row.putAwayMovedQty,
        row.dispatchedOutQty,
        row.packedOutQty,
        row.adjustedOutQty,
        row.totalOutQty,
        row.netChangeQty,
        row.inBinQty,
        row.awaitingPutAwayQty,
        row.reservedQty,
        row.onHandQty,
      ]
        .map(escapeCsv)
        .join(','),
    );

    return [headers.map(escapeCsv).join(','), ...bodyLines].join('\n');
  }

  private buildPlainTextEmail(params: {
    clientName: string;
    dateLabel: string;
    totals: DailyInventoryMovementsReportTotals;
    rows: DailyInventoryMovementRow[];
  }): string {
    const { clientName, dateLabel, totals, rows } = params;
    const movedRows = rows.filter((r) => r.totalInQty > 0 || r.totalOutQty > 0);
    const topRows = (movedRows.length > 0 ? movedRows : rows).slice(0, 30);

    const lines = [
      `DAILY INVENTORY INS & OUTS REPORT — ${clientName}`,
      `Date: ${dateLabel} (Asia/Manila)`,
      '',
      'SUMMARY',
      `- Total Stock In: +${totals.totalInQty} (Received: ${totals.receivedInQty}, Manual: ${totals.manualInQty}, Restocked: ${totals.restockedInQty})`,
      `- Total Stock Out: -${totals.totalOutQty} (Dispatched: ${totals.dispatchedOutQty}, Packed/Picked: ${totals.packedOutQty}, Adjusted: ${totals.adjustedOutQty})`,
      `- Net Inventory Change: ${totals.netChangeQty >= 0 ? `+${totals.netChangeQty}` : totals.netChangeQty}`,
      `- Closing On-Hand Stock: ${totals.onHandQty} (In Bin: ${totals.inBinQty}, Awaiting Put-Away: ${totals.awaitingPutAwayQty}, Reserved: ${totals.reservedQty})`,
      '',
      'PRODUCT BREAKDOWN',
      ...topRows.map(
        (row) =>
          `• [${row.storeName}] ${row.variantName}: IN +${row.totalInQty} | OUT -${row.totalOutQty} | Net ${
            row.netChangeQty >= 0 ? `+${row.netChangeQty}` : row.netChangeQty
          } | On-Hand: ${row.onHandQty} (In Bin: ${row.inBinQty})`,
      ),
    ];

    return lines.join('\n');
  }

  private resolveFromAddress(): string {
    return (
      process.env.DAILY_REPORT_EMAIL_FROM
      || process.env.SMTP_FROM
      || process.env.EMAIL_FROM
      || 'WeTrade WMS <wms-inventory-update@wetrade.com.ph>'
    );
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private formatSigned(value: number): string {
    return value >= 0 ? `+${value.toLocaleString()}` : value.toLocaleString();
  }

  private renderKpiCardsHtml(totals: DailyInventoryMovementsReportTotals): string {
    return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        <tr>
          <td width="24%" style="padding:12px;background:#ecfdf5;border-radius:12px;border:1px solid #a7f3d0;">
            <div style="font-size:11px;color:#047857;font-weight:600;text-transform:uppercase;">Stock In</div>
            <div style="font-size:21px;font-weight:700;color:#065f46;margin-top:4px;">+${totals.totalInQty.toLocaleString()}</div>
            <div style="font-size:11px;color:#047857;margin-top:2px;">Rcv: ${totals.receivedInQty.toLocaleString()} • Man: ${totals.manualInQty.toLocaleString()} • Rts: ${totals.restockedInQty.toLocaleString()}</div>
          </td>
          <td width="1.3%"></td>
          <td width="24%" style="padding:12px;background:#fff1f2;border-radius:12px;border:1px solid #fecdd3;">
            <div style="font-size:11px;color:#be123c;font-weight:600;text-transform:uppercase;">Stock Out</div>
            <div style="font-size:21px;font-weight:700;color:#9f1239;margin-top:4px;">-${totals.totalOutQty.toLocaleString()}</div>
            <div style="font-size:11px;color:#be123c;margin-top:2px;">Ship: ${totals.dispatchedOutQty.toLocaleString()} • Pack: ${totals.packedOutQty.toLocaleString()} • Adj: ${totals.adjustedOutQty.toLocaleString()}</div>
          </td>
          <td width="1.3%"></td>
          <td width="24%" style="padding:12px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
            <div style="font-size:11px;color:#475569;font-weight:600;text-transform:uppercase;">Net &amp; Put-Away</div>
            <div style="font-size:21px;font-weight:700;color:#0f172a;margin-top:4px;">${this.formatSigned(totals.netChangeQty)}</div>
            <div style="font-size:11px;color:#64748b;margin-top:2px;">Put-away: ${totals.putAwayMovedQty.toLocaleString()} • Moved SKUs: ${totals.activeMovedVariantCount.toLocaleString()}</div>
          </td>
          <td width="1.3%"></td>
          <td width="24%" style="padding:12px;background:#eff6ff;border-radius:12px;border:1px solid #bfdbfe;">
            <div style="font-size:11px;color:#1d4ed8;font-weight:600;text-transform:uppercase;">Closing Stock</div>
            <div style="font-size:21px;font-weight:700;color:#1e3a8a;margin-top:4px;">${totals.onHandQty.toLocaleString()}</div>
            <div style="font-size:11px;color:#1d4ed8;margin-top:2px;">Bin: ${totals.inBinQty.toLocaleString()} • Stg: ${totals.awaitingPutAwayQty.toLocaleString()} • Res: ${totals.reservedQty.toLocaleString()}</div>
          </td>
        </tr>
      </table>`;
  }

  private buildWarehouseEmailContent(params: {
    startDate: string;
    endDate: string;
    totals: DailyInventoryMovementsReportTotals;
    rows: DailyInventoryMovementRow[];
    clientSummaries: ClientDailyInventorySummary[];
    generatedAt: string;
    sendTimeManila?: string;
  }) {
    const dateLabel =
      params.startDate === params.endDate
        ? params.startDate
        : `${params.startDate} to ${params.endDate}`;
    const subject = `[Warehouse Daily Inventory Ins & Outs] All Clients — ${dateLabel}`;
    const csvFilename = `warehouse-inventory-ins-outs-all-clients-${params.startDate}${
      params.endDate !== params.startDate ? `-to-${params.endDate}` : ''
    }.csv`;

    const sortedRowsForCsv = [...params.rows].sort((left, right) => {
      const leftMoved = left.totalInQty + left.totalOutQty + left.putAwayMovedQty > 0 ? 1 : 0;
      const rightMoved = right.totalInQty + right.totalOutQty + right.putAwayMovedQty > 0 ? 1 : 0;
      const tenantCmp = left.tenantName.localeCompare(right.tenantName);
      if (tenantCmp !== 0) return tenantCmp;
      if (leftMoved !== rightMoved) return rightMoved - leftMoved;
      return left.storeName.localeCompare(right.storeName) || left.variantName.localeCompare(right.variantName);
    });

    const csvContent = this.buildCsvContent(sortedRowsForCsv, params.startDate, params.endDate);
    const html = this.buildWarehouseHtmlEmail({
      dateLabel,
      totals: params.totals,
      clientSummaries: params.clientSummaries,
      sendTimeManila: params.sendTimeManila || '20:00',
    });
    const text = this.buildWarehousePlainTextEmail({
      dateLabel,
      totals: params.totals,
      clientSummaries: params.clientSummaries,
    });

    return {
      dateLabel,
      subject,
      html,
      text,
      csvFilename,
      csvContent,
    };
  }

  private buildWarehousePlainTextEmail(params: {
    dateLabel: string;
    totals: DailyInventoryMovementsReportTotals;
    clientSummaries: ClientDailyInventorySummary[];
  }): string {
    const { dateLabel, totals, clientSummaries } = params;
    const lines: string[] = [
      'WAREHOUSE DAILY INVENTORY INS & OUTS REPORT — ALL CLIENTS (BY CLIENT)',
      `Date: ${dateLabel} (Asia/Manila)`,
      `Active Clients: ${clientSummaries.length}`,
      '',
      'WAREHOUSE TOTALS',
      `- Total Stock In: +${totals.totalInQty} (Received: ${totals.receivedInQty}, Manual: ${totals.manualInQty}, Restocked: ${totals.restockedInQty})`,
      `- Put Away to Bins: ${totals.putAwayMovedQty}`,
      `- Total Stock Out: -${totals.totalOutQty} (Dispatched: ${totals.dispatchedOutQty}, Packed/Picked: ${totals.packedOutQty}, Adjusted: ${totals.adjustedOutQty})`,
      `- Net Inventory Change: ${this.formatSigned(totals.netChangeQty)}`,
      `- Closing On-Hand Stock: ${totals.onHandQty} (In Bin: ${totals.inBinQty}, Awaiting Put-Away: ${totals.awaitingPutAwayQty}, Reserved: ${totals.reservedQty})`,
      '',
      'SUMMARY BY CLIENT',
      ...clientSummaries.map(
        (client) =>
          `• ${client.tenantName} (${client.storeCount} stores): IN +${client.totalInQty} | Put-Away ${client.putAwayMovedQty} | OUT -${client.totalOutQty} | Net ${this.formatSigned(
            client.netChangeQty,
          )} | Closing On-Hand ${client.onHandQty} (Bin ${client.inBinQty})`,
      ),
      '',
      'DETAILED BREAKDOWN PER CLIENT',
    ];

    for (const client of clientSummaries) {
      lines.push('');
      lines.push(
        `=== ${client.tenantName.toUpperCase()} | IN +${client.totalInQty} | Put-Away ${client.putAwayMovedQty} | OUT -${client.totalOutQty} | Net ${this.formatSigned(
          client.netChangeQty,
        )} | On-Hand ${client.onHandQty} ===`,
      );

      if (client.activityBreakdown.length > 0) {
        const topActivity = client.activityBreakdown
          .slice(0, 8)
          .map(
            (item) =>
              `${item.direction} ${item.movementType}${item.referenceCode ? ` (${item.referenceCode})` : ''}: ${item.unitCount}`,
          )
          .join(' • ');
        lines.push(`Activity: ${topActivity}`);
      }

      const relevantRows = client.rows.filter(
        (row) =>
          row.totalInQty > 0
          || row.totalOutQty > 0
          || row.putAwayMovedQty > 0
          || row.onHandQty > 0,
      );

      if (relevantRows.length === 0) {
        lines.push('  No stock movements or on-hand stock for this client.');
        continue;
      }

      for (const row of relevantRows) {
        const sku = row.variantCode || row.variantDisplayId || row.variationId || '—';
        lines.push(
          `  - [${row.storeName}] ${row.variantName} (${sku}): IN +${row.totalInQty} (Rcv ${row.receivedInQty}, Man ${row.manualInQty}, Rts ${row.restockedInQty}) | Put-Away ${row.putAwayMovedQty} | OUT -${row.totalOutQty} (Ship ${row.dispatchedOutQty}, Pack ${row.packedOutQty}, Adj ${row.adjustedOutQty}) | Net ${this.formatSigned(
            row.netChangeQty,
          )} | On-Hand ${row.onHandQty} (Bin ${row.inBinQty}, Stg ${row.awaitingPutAwayQty}, Res ${row.reservedQty})`,
        );
      }
    }

    return lines.join('\n');
  }

  private buildWarehouseHtmlEmail(params: {
    dateLabel: string;
    totals: DailyInventoryMovementsReportTotals;
    clientSummaries: ClientDailyInventorySummary[];
    sendTimeManila: string;
  }): string {
    const { dateLabel, totals, clientSummaries, sendTimeManila } = params;
    const esc = (v: string) => this.escapeHtml(v);

    const formatInBreakdown = (item: {
      receivedInQty: number;
      manualInQty: number;
      restockedInQty: number;
    }) => {
      const parts: string[] = [];
      if (item.receivedInQty > 0) parts.push(`Rcv ${item.receivedInQty.toLocaleString()}`);
      if (item.manualInQty > 0) parts.push(`Man ${item.manualInQty.toLocaleString()}`);
      if (item.restockedInQty > 0) parts.push(`Rts ${item.restockedInQty.toLocaleString()}`);
      return parts.join(' • ');
    };

    const formatOutBreakdown = (item: {
      dispatchedOutQty: number;
      packedOutQty: number;
      adjustedOutQty: number;
    }) => {
      const parts: string[] = [];
      if (item.dispatchedOutQty > 0) parts.push(`Ship ${item.dispatchedOutQty.toLocaleString()}`);
      if (item.packedOutQty > 0) parts.push(`Pack ${item.packedOutQty.toLocaleString()}`);
      if (item.adjustedOutQty > 0) parts.push(`Adj ${item.adjustedOutQty.toLocaleString()}`);
      return parts.join(' • ');
    };

    const summaryRowsHtml = clientSummaries
      .map((client) => {
        const inSub = formatInBreakdown(client);
        const outSub = formatOutBreakdown(client);
        const hasActivity = client.totalInQty > 0 || client.totalOutQty > 0 || client.putAwayMovedQty > 0;
        const rowBg = hasActivity ? '#ffffff' : '#fafbfc';
        return `<tr style="background:${rowBg};">
<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#0f172a;font-weight:700;">${esc(client.tenantName)}<div style="font-size:10px;color:#64748b;font-weight:400;">${client.storeCount} store(s) • ${client.movedVariantCount}/${client.variantCount} moved SKUs</div></td>
<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;color:${client.totalInQty > 0 ? '#059669' : '#64748b'};font-weight:700;">${client.totalInQty > 0 ? `+${client.totalInQty.toLocaleString()}` : '0'}${inSub ? `<div style="font-size:10px;color:#64748b;font-weight:400;">${inSub}</div>` : ''}</td>
<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;color:#475569;">${client.putAwayMovedQty.toLocaleString()}</td>
<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;color:${client.totalOutQty > 0 ? '#e11d48' : '#64748b'};font-weight:700;">${client.totalOutQty > 0 ? `-${client.totalOutQty.toLocaleString()}` : '0'}${outSub ? `<div style="font-size:10px;color:#64748b;font-weight:400;">${outSub}</div>` : ''}</td>
<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;color:#0f172a;font-weight:600;">${this.formatSigned(client.netChangeQty)}</td>
<td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;color:#0f172a;font-weight:700;">${client.onHandQty.toLocaleString()}<div style="font-size:10px;color:#64748b;font-weight:400;">Bin ${client.inBinQty.toLocaleString()} • Stg ${client.awaitingPutAwayQty.toLocaleString()} • Res ${client.reservedQty.toLocaleString()}</div></td>
</tr>`;
      })
      .join('');

    const grandTotalRowHtml = `<tr style="background:#f1f5f9;">
<td style="padding:9px 10px;font-size:12px;color:#0f172a;font-weight:700;">WAREHOUSE TOTAL (${clientSummaries.length} Clients)</td>
<td style="padding:9px 10px;font-size:12px;text-align:right;color:#065f46;font-weight:700;">+${totals.totalInQty.toLocaleString()}</td>
<td style="padding:9px 10px;font-size:12px;text-align:right;color:#334155;font-weight:700;">${totals.putAwayMovedQty.toLocaleString()}</td>
<td style="padding:9px 10px;font-size:12px;text-align:right;color:#9f1239;font-weight:700;">-${totals.totalOutQty.toLocaleString()}</td>
<td style="padding:9px 10px;font-size:12px;text-align:right;color:#0f172a;font-weight:700;">${this.formatSigned(totals.netChangeQty)}</td>
<td style="padding:9px 10px;font-size:12px;text-align:right;color:#1e3a8a;font-weight:700;">${totals.onHandQty.toLocaleString()}</td>
</tr>`;

    const renderProductRowHtml = (row: DailyInventoryMovementRow) => {
      const sku = row.variantCode || row.variantDisplayId || row.variationId || '—';
      const inSub = formatInBreakdown(row);
      const outSub = formatOutBreakdown(row);
      return `<tr>
<td style="padding:7px 10px;border-bottom:1px solid #edf2f7;font-size:12px;color:#0f172a;font-weight:600;">${esc(row.variantName)}<div style="font-size:10px;color:#64748b;font-weight:400;">${esc(row.storeName)} • ${esc(sku)}</div></td>
<td style="padding:7px 10px;border-bottom:1px solid #edf2f7;font-size:12px;text-align:right;color:${row.totalInQty > 0 ? '#059669' : '#94a3b8'};font-weight:600;">${row.totalInQty > 0 ? `+${row.totalInQty.toLocaleString()}` : '0'}${inSub ? `<div style="font-size:10px;color:#64748b;font-weight:400;">${inSub}</div>` : ''}</td>
<td style="padding:7px 10px;border-bottom:1px solid #edf2f7;font-size:12px;text-align:right;color:${row.putAwayMovedQty > 0 ? '#334155' : '#94a3b8'};">${row.putAwayMovedQty.toLocaleString()}</td>
<td style="padding:7px 10px;border-bottom:1px solid #edf2f7;font-size:12px;text-align:right;color:${row.totalOutQty > 0 ? '#e11d48' : '#94a3b8'};font-weight:600;">${row.totalOutQty > 0 ? `-${row.totalOutQty.toLocaleString()}` : '0'}${outSub ? `<div style="font-size:10px;color:#64748b;font-weight:400;">${outSub}</div>` : ''}</td>
<td style="padding:7px 10px;border-bottom:1px solid #edf2f7;font-size:12px;text-align:right;color:#334155;font-weight:600;">${this.formatSigned(row.netChangeQty)}</td>
<td style="padding:7px 10px;border-bottom:1px solid #edf2f7;font-size:12px;text-align:right;color:#0f172a;font-weight:700;">${row.onHandQty.toLocaleString()}<div style="font-size:10px;color:#64748b;font-weight:400;">Bin ${row.inBinQty.toLocaleString()}${row.awaitingPutAwayQty > 0 ? ` • Stg ${row.awaitingPutAwayQty.toLocaleString()}` : ''}${row.reservedQty > 0 ? ` • Res ${row.reservedQty.toLocaleString()}` : ''}</div></td>
</tr>`;
    };

    const movedRowsCount = clientSummaries.reduce(
      (sum, c) => sum + c.rows.filter((r) => r.totalInQty > 0 || r.totalOutQty > 0 || r.putAwayMovedQty > 0).length,
      0,
    );
    // Keep total HTML safely below Gmail's 102 KB clipping threshold while always showing 100% of moved rows.
    const approxFixedBytes = 8000 + summaryRowsHtml.length + movedRowsCount * 750 + clientSummaries.length * 1100;
    const stockedRowAllowance = Math.max(0, Math.floor((90000 - approxFixedBytes) / 750));
    let remainingStockedSlots = stockedRowAllowance;

    const clientSectionsHtml = clientSummaries
      .map((client) => {
        const movedRows = client.rows.filter(
          (r) => r.totalInQty > 0 || r.totalOutQty > 0 || r.putAwayMovedQty > 0,
        );
        const stockedOnlyRows = client.rows
          .filter(
            (r) =>
              r.totalInQty === 0
              && r.totalOutQty === 0
              && r.putAwayMovedQty === 0
              && r.onHandQty > 0,
          )
          .sort((a, b) => b.onHandQty - a.onHandQty || a.variantName.localeCompare(b.variantName));

        const includedStocked =
          remainingStockedSlots > 0 ? stockedOnlyRows.slice(0, remainingStockedSlots) : [];
        remainingStockedSlots = Math.max(0, remainingStockedSlots - includedStocked.length);
        const omittedStockedCount = stockedOnlyRows.length - includedStocked.length;
        const displayRows = [...movedRows, ...includedStocked];

        const activityText =
          client.activityBreakdown.length > 0
            ? client.activityBreakdown
                .slice(0, 8)
                .map((item) => {
                  const sign = item.direction === 'IN' ? '+' : item.direction === 'OUT' ? '-' : '';
                  const ref = item.referenceCode ? ` (${esc(item.referenceCode)})` : '';
                  return `${esc(item.movementType)}${ref}: ${sign}${item.unitCount.toLocaleString()}`;
                })
                .join(' • ')
            : '';

        const headerHtml = `<div style="padding:12px 14px;background:#1e293b;color:#ffffff;">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:14px;font-weight:700;color:#ffffff;">${esc(client.tenantName)}<div style="font-size:11px;color:#cbd5e1;font-weight:400;margin-top:2px;">${client.storeCount} store(s) • ${movedRows.length} moved SKU(s) • ${client.variantCount} total SKU(s)</div></td>
<td style="text-align:right;font-size:11px;color:#e2e8f0;white-space:nowrap;">
<span style="color:#6ee7b7;font-weight:700;">IN +${client.totalInQty.toLocaleString()}</span> &nbsp;|&nbsp;
<span style="color:#fda4af;font-weight:700;">OUT -${client.totalOutQty.toLocaleString()}</span> &nbsp;|&nbsp;
<span style="font-weight:700;">Net ${this.formatSigned(client.netChangeQty)}</span> &nbsp;|&nbsp;
<span style="color:#93c5fd;font-weight:700;">On-Hand ${client.onHandQty.toLocaleString()}</span>
</td>
</tr></table>
${activityText ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #334155;font-size:11px;color:#e2e8f0;"><strong>Activity:</strong> ${activityText}${client.activityBreakdown.length > 8 ? ` • +${client.activityBreakdown.length - 8} more` : ''}</div>` : ''}
</div>`;

        if (displayRows.length === 0) {
          return `<div style="margin-top:16px;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;">
${headerHtml}
<div style="padding:10px 14px;background:#ffffff;font-size:12px;color:#64748b;">No stock movements or on-hand inventory recorded for this client in this period${client.variantCount > 0 ? ` (${client.variantCount} inactive catalog SKUs included in CSV)` : ''}.</div>
</div>`;
        }

        const rowsHtml = displayRows.map(renderProductRowHtml).join('');
        const omittedNoteRow =
          omittedStockedCount > 0
            ? `<tr style="background:#f8fafc;"><td colspan="6" style="padding:7px 10px;border-bottom:1px solid #edf2f7;font-size:11px;color:#475569;font-style:italic;">+ ${omittedStockedCount.toLocaleString()} additional unmoved stocked SKUs included in the attached CSV.</td></tr>`
            : '';
        const subtotalRow = `<tr style="background:#f8fafc;">
<td style="padding:8px 10px;font-size:11px;color:#0f172a;font-weight:700;">Client Subtotal (${esc(client.tenantName)})</td>
<td style="padding:8px 10px;font-size:11px;text-align:right;color:#065f46;font-weight:700;">+${client.totalInQty.toLocaleString()}</td>
<td style="padding:8px 10px;font-size:11px;text-align:right;color:#334155;font-weight:700;">${client.putAwayMovedQty.toLocaleString()}</td>
<td style="padding:8px 10px;font-size:11px;text-align:right;color:#9f1239;font-weight:700;">-${client.totalOutQty.toLocaleString()}</td>
<td style="padding:8px 10px;font-size:11px;text-align:right;color:#0f172a;font-weight:700;">${this.formatSigned(client.netChangeQty)}</td>
<td style="padding:8px 10px;font-size:11px;text-align:right;color:#1e3a8a;font-weight:700;">${client.onHandQty.toLocaleString()}</td>
</tr>`;

        return `<div style="margin-top:16px;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;">
${headerHtml}
<table width="100%" cellpadding="0" cellspacing="0">
<thead><tr style="background:#f1f5f9;">
<th style="padding:7px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#475569;">Product / Store</th>
<th style="padding:7px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:#475569;">In (+)</th>
<th style="padding:7px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:#475569;">Put Away</th>
<th style="padding:7px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:#475569;">Out (-)</th>
<th style="padding:7px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:#475569;">Net</th>
<th style="padding:7px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:#475569;">On-Hand</th>
</tr></thead>
<tbody>${rowsHtml}${omittedNoteRow}${subtotalRow}</tbody>
</table>
</div>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:20px;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:840px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
    <div style="padding:22px 24px;background:#17324b;color:#ffffff;">
      <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#93c5fd;font-weight:600;">Daily Warehouse Inventory Report • All Clients</div>
      <h1 style="margin:6px 0 4px;font-size:21px;font-weight:700;">Warehouse Stock Ins &amp; Outs (By Client)</h1>
      <div style="font-size:13px;color:#cbd5e1;">Report Date: ${esc(dateLabel)} (Asia/Manila) • ${clientSummaries.length} Active Clients • ${totals.activeMovedVariantCount.toLocaleString()} Moved Products</div>
    </div>
    <div style="padding:20px 24px;">
      ${this.renderKpiCardsHtml(totals)}

      <h3 style="margin:0 0 10px;font-size:15px;color:#0f172a;">Summary by Client</h3>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:22px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#475569;">Client</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:#475569;">In (+)</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:#475569;">Put Away</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:#475569;">Out (-)</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:#475569;">Net</th>
            <th style="padding:8px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:#475569;">Closing On-Hand</th>
          </tr>
        </thead>
        <tbody>
          ${
            summaryRowsHtml
            || '<tr><td colspan="6" style="padding:18px;text-align:center;color:#64748b;font-size:12px;">No active clients found.</td></tr>'
          }
          ${summaryRowsHtml ? grandTotalRowHtml : ''}
        </tbody>
      </table>

      <h3 style="margin:0 0 4px;font-size:15px;color:#0f172a;">Detailed Stock Ins &amp; Outs Per Client</h3>
      <div style="font-size:12px;color:#64748b;margin-bottom:8px;">Clients with warehouse activity today are listed first, followed by remaining active clients.</div>
      ${clientSectionsHtml}

      <div style="margin-top:18px;font-size:12px;color:#64748b;">
        The complete all-clients CSV report is attached to this email. This consolidated report is automatically sent daily at ${esc(sendTimeManila)} (Asia/Manila).
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  private buildHtmlEmail(params: {
    clientName: string;
    dateLabel: string;
    totals: DailyInventoryMovementsReportTotals;
    rows: DailyInventoryMovementRow[];
    generatedAt: string;
  }): string {
    const { clientName, dateLabel, totals, rows } = params;
    const movedRows = rows.filter((r) => r.totalInQty > 0 || r.totalOutQty > 0);
    const displayRows = (movedRows.length > 0 ? movedRows : rows).slice(0, 50);

    const rowHtml = displayRows
      .map(
        (row) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;font-weight:600;">
            ${this.escapeHtml(row.variantName)}
            <div style="font-size:11px;color:#64748b;font-weight:400;">${this.escapeHtml(row.storeName)} • ${this.escapeHtml(row.variantCode || row.variationId || '—')}</div>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#059669;font-weight:600;">
            +${row.totalInQty.toLocaleString()}
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#e11d48;font-weight:600;">
            -${row.totalOutQty.toLocaleString()}
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#334155;font-weight:600;">
            ${this.formatSigned(row.netChangeQty)}
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#0f172a;font-weight:700;">
            ${row.onHandQty.toLocaleString()}
            <div style="font-size:11px;color:#64748b;font-weight:400;">Bin: ${row.inBinQty.toLocaleString()}</div>
          </td>
        </tr>`,
      )
      .join('');

    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
    <div style="padding:24px;background:#17324b;color:#ffffff;">
      <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#93c5fd;font-weight:600;">Daily Automated Inventory Report</div>
      <h1 style="margin:6px 0 4px;font-size:22px;font-weight:700;">${this.escapeHtml(clientName)} — Inventory Ins &amp; Outs</h1>
      <div style="font-size:13px;color:#cbd5e1;">Report Date: ${this.escapeHtml(dateLabel)} (Manila Time)</div>
    </div>
    <div style="padding:24px;">
      ${this.renderKpiCardsHtml(totals)}

      <h3 style="margin:0 0 12px;font-size:15px;color:#0f172a;">Product Ins &amp; Outs Summary</h3>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#475569;">Product / Store</th>
            <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#475569;">In</th>
            <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#475569;">Out</th>
            <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#475569;">Net</th>
            <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;color:#475569;">On-Hand</th>
          </tr>
        </thead>
        <tbody>
          ${
            rowHtml
            || '<tr><td colspan="5" style="padding:20px;text-align:center;color:#64748b;font-size:13px;">No products found for this client.</td></tr>'
          }
        </tbody>
      </table>
      <div style="margin-top:16px;font-size:12px;color:#64748b;">
        The complete CSV report is attached to this email. This report is automatically sent daily.
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  private slugify(value: string): string {
    return (
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'client'
    );
  }
}

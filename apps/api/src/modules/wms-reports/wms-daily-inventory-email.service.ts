import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TenantStatus } from '@prisma/client';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import * as net from 'net';
import * as tls from 'tls';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SendWmsDailyInventoryEmailDto } from './dto/wms-daily-inventory-email.dto';
import {
  DailyInventoryMovementRow,
  DailyInventoryMovementsReportTotals,
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
export class WmsDailyInventoryEmailService {
  private readonly logger = new Logger(WmsDailyInventoryEmailService.name);
  private isCronRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wmsReportsService: WmsReportsService,
  ) {}

  @Cron('5 * * * *')
  async runHourlyDailyReportScheduleCheck() {
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
    } finally {
      this.isCronRunning = false;
    }
  }

  async sendNow(dto: SendWmsDailyInventoryEmailDto) {
    const targetTenantId = this.wmsReportsService.resolveTargetTenantId(dto.tenantId);
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
    });
  }

  private async sendForTenant(params: {
    tenantId: string;
    startDate: string;
    endDate: string;
    recipients: string[];
    bypassClsForCron: boolean;
  }) {
    const reportData = await this.wmsReportsService.getDailyInventoryMovementsReport(
      {
        startDate: params.startDate,
        endDate: params.endDate,
        tenantIds: [params.tenantId],
        storeIds: [],
      },
      { bypassClsForCron: params.bypassClsForCron },
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

    const fromAddress =
      process.env.DAILY_REPORT_EMAIL_FROM
      || process.env.SMTP_FROM
      || process.env.EMAIL_FROM
      || 'WMS Reports <reports@wetrade-wms.local>';

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

      if (process.env.SMTP_HOST) {
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
    const host = process.env.SMTP_HOST!;
    const port = Number(process.env.SMTP_PORT || 465);
    const secure = process.env.SMTP_SECURE !== 'false' && port === 465;
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';
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

    const escapeHtml = (value: string) =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const rowHtml = displayRows
      .map(
        (row) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;font-weight:600;">
            ${escapeHtml(row.variantName)}
            <div style="font-size:11px;color:#64748b;font-weight:400;">${escapeHtml(row.storeName)} • ${escapeHtml(row.variantCode || row.variationId || '—')}</div>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#059669;font-weight:600;">
            +${row.totalInQty.toLocaleString()}
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#e11d48;font-weight:600;">
            -${row.totalOutQty.toLocaleString()}
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px;text-align:right;color:#334155;font-weight:600;">
            ${row.netChangeQty >= 0 ? `+${row.netChangeQty.toLocaleString()}` : row.netChangeQty.toLocaleString()}
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
      <h1 style="margin:6px 0 4px;font-size:22px;font-weight:700;">${escapeHtml(clientName)} — Inventory Ins &amp; Outs</h1>
      <div style="font-size:13px;color:#cbd5e1;">Report Date: ${escapeHtml(dateLabel)} (Manila Time)</div>
    </div>
    <div style="padding:24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td width="25%" style="padding:12px;background:#ecfdf5;border-radius:12px;border:1px solid #a7f3d0;">
            <div style="font-size:11px;color:#047857;font-weight:600;text-transform:uppercase;">Stock In</div>
            <div style="font-size:22px;font-weight:700;color:#065f46;margin-top:4px;">+${totals.totalInQty.toLocaleString()}</div>
            <div style="font-size:11px;color:#047857;margin-top:2px;">Rcv: ${totals.receivedInQty} • Man: ${totals.manualInQty}</div>
          </td>
          <td width="2%"></td>
          <td width="25%" style="padding:12px;background:#fff1f2;border-radius:12px;border:1px solid #fecdd3;">
            <div style="font-size:11px;color:#be123c;font-weight:600;text-transform:uppercase;">Stock Out</div>
            <div style="font-size:22px;font-weight:700;color:#9f1239;margin-top:4px;">-${totals.totalOutQty.toLocaleString()}</div>
            <div style="font-size:11px;color:#be123c;margin-top:2px;">Ship: ${totals.dispatchedOutQty} • Pack: ${totals.packedOutQty}</div>
          </td>
          <td width="2%"></td>
          <td width="21%" style="padding:12px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
            <div style="font-size:11px;color:#475569;font-weight:600;text-transform:uppercase;">Net Change</div>
            <div style="font-size:22px;font-weight:700;color:#0f172a;margin-top:4px;">${
              totals.netChangeQty >= 0
                ? `+${totals.netChangeQty.toLocaleString()}`
                : totals.netChangeQty.toLocaleString()
            }</div>
            <div style="font-size:11px;color:#64748b;margin-top:2px;">Put-away: ${totals.putAwayMovedQty}</div>
          </td>
          <td width="2%"></td>
          <td width="23%" style="padding:12px;background:#eff6ff;border-radius:12px;border:1px solid #bfdbfe;">
            <div style="font-size:11px;color:#1d4ed8;font-weight:600;text-transform:uppercase;">Closing Stock</div>
            <div style="font-size:22px;font-weight:700;color:#1e3a8a;margin-top:4px;">${totals.onHandQty.toLocaleString()}</div>
            <div style="font-size:11px;color:#1d4ed8;margin-top:2px;">In Bin: ${totals.inBinQty.toLocaleString()}</div>
          </td>
        </tr>
      </table>

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

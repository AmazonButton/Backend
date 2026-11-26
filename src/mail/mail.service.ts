import { Injectable, Logger, Optional, Inject, OnModuleDestroy } from '@nestjs/common';
import * as dns from 'node:dns';
import * as net from 'node:net';
import * as nodemailer from 'nodemailer';
import { QueueService } from '../common/queues/queue.service';
import { maskEmailAddress } from '../common/utils/pii-mask.util';

export interface MailPayload {
  to: string;
  subject: string;
  text: string;
  html: string;
}

@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private smtpHost = '';
  private smtpPort = 465;
  private smtpUser = '';
  private smtpPass = '';
  private isConfigured = false;
  private isSmtpConfigured = false;

  static maskEmail(email: string): string {
    return maskEmailAddress(email);
  }

  /**
   * Resolves SMTP hostname to IPv4 while keeping the original hostname for TLS SNI.
   * Passing an IPv4 literal avoids nodemailer's built-in IPv6 fallback (ENETUNREACH on IPv4-only hosts).
   */
  static async resolveSmtpConnectionTarget(
    host: string,
    lookupFn: (hostname: string, opts: { family: number }) => Promise<{ address: string; family: number }> = (
      h,
      opts,
    ) => dns.promises.lookup(h, opts),
  ): Promise<{ connectHost: string; servername: string }> {
    const cleanHost = (host || '').trim();
    if (!cleanHost || net.isIP(cleanHost)) {
      return { connectHost: cleanHost, servername: cleanHost };
    }
    try {
      const resolved = await lookupFn(cleanHost, { family: 4 });
      if (resolved?.address && net.isIP(resolved.address) === 4) {
        return { connectHost: resolved.address, servername: cleanHost };
      }
    } catch {
      // Graceful fallback to original hostname when DNS lookup fails
    }
    return { connectHost: cleanHost, servername: cleanHost };
  }

  private maskEmail(email: string): string {
    return MailService.maskEmail(email);
  }

  constructor(
    @Optional() @Inject(QueueService) private readonly queueService?: QueueService,
  ) {
    this.initTransporter();
    this.initQueueProcessor();
  }

  onModuleDestroy() {
    if (this.transporter) {
      try {
        this.transporter.close();
      } catch (_) {}
      this.transporter = null;
    }
  }

  private initQueueProcessor() {
    if (this.queueService) {
      this.queueService.registerProcessor('mail-queue', async (job) => {
        // Enforce throwOnError: true so queue engines (BullMQ / In-Memory) can execute retry logic and route to DLQ on exhaustion
        return this.sendMail(job.data, true);
      });
    }
  }

  /**
   * Enqueue email for asynchronous background dispatch with automatic exponential retry and DLQ.
   */
  async enqueueMail(options: { to: string; subject: string; text: string; html: string }): Promise<string> {
    if (this.queueService) {
      return this.queueService.enqueueJob('mail-queue', 'send-email', options, {
        attempts: 3,
        backoffDelayMs: 1000,
        backoffType: 'exponential',
      });
    }
    await this.sendMail(options);
    return 'direct-dispatch';
  }

  private getHttpsProvider(): 'resend' | 'brevo' | null {
    if (process.env.RESEND_API_KEY?.trim()) return 'resend';
    if (process.env.BREVO_API_KEY?.trim()) return 'brevo';
    return null;
  }

  private initTransporter() {
    const user = process.env.SMTP_USER?.trim() || '';
    const pass = (process.env.SMTP_PASSWORD || process.env.SMTP_PASS)?.replace(/\s+/g, '') || '';
    const host = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT) || 465;

    this.smtpHost = host;
    this.smtpPort = port;
    this.smtpUser = user;
    this.smtpPass = pass;

    const httpsProvider = this.getHttpsProvider();

    if (user && pass) {
      this.transporter = this.buildSmtpTransporter(host, host, port, user, pass);
      this.isSmtpConfigured = true;
      this.isConfigured = true;
      this.logger.log(`MailService initialized with SMTP host ${host}:${port} (User: ${this.maskEmail(user)})`);
    }

    if (httpsProvider) {
      this.isConfigured = true;
      this.logger.log(`MailService enabled HTTPS port-443 email provider (${httpsProvider.toUpperCase()}).`);
    }

    if (!this.isConfigured) {
      this.logger.warn('No mail provider configured (RESEND_API_KEY / BREVO_API_KEY / SMTP). MailService operating in DEV FALLBACK MODE.');
    }
  }

  private buildSmtpTransporter(
    connectHost: string,
    servername: string,
    port: number,
    user: string,
    pass: string,
  ): nodemailer.Transporter {
    return nodemailer.createTransport({
      host: connectHost,
      port,
      secure: port === 465,
      auth: { user, pass },
      tls: servername && !net.isIP(servername) ? { servername } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
    });
  }

  private async sendViaHttpsApi(provider: 'resend' | 'brevo', options: MailPayload, fromHeader: string): Promise<void> {
    if (provider === 'resend') {
      const apiKey = process.env.RESEND_API_KEY!.trim();
      const resendFrom = process.env.SMTP_FROM?.trim() || 'Smart Order Platform <onboarding@resend.dev>';
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: resendFrom,
          to: [options.to],
          subject: options.subject,
          text: options.text,
          html: options.html,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Resend API error HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      }
      return;
    }

    const brevoKey = process.env.BREVO_API_KEY!.trim();
    const rawSmtpFrom = process.env.SMTP_FROM?.trim();
    const parsedFromEmail = rawSmtpFrom
      ? (rawSmtpFrom.match(/<([^>]+)>/)?.[1] || rawSmtpFrom)
      : undefined;
    const senderEmail = this.smtpUser || parsedFromEmail || 'no-reply@smartorder.vn';
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': brevoKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'Smart Order Platform', email: senderEmail },
        to: [{ email: options.to }],
        subject: options.subject,
        textContent: options.text,
        htmlContent: options.html,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`Brevo API error HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    }
  }

  private buildOtpTemplate(title: string, message: string, otp: string, expiryMinutes = 15): string {
    return `
      <div style="max-width: 500px; margin: 20px auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; background-color: #ffffff;">
        <div style="background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #ffffff; padding: 24px; text-align: center;">
          <h2 style="margin: 0; font-size: 22px;">Smart Order Button Platform</h2>
        </div>
        <div style="padding: 30px 24px; color: #334155; line-height: 1.6;">
          <h3 style="margin-top: 0; color: #1e293b;">${title}</h3>
          <p>${message}</p>
          <div style="background: #f1f5f9; padding: 18px; text-align: center; border-radius: 8px; margin: 24px 0; border: 1px dashed #cbd5e1;">
            <span style="font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #0f172a; font-family: monospace;">${otp}</span>
          </div>
          <p style="font-size: 13px; color: #64748b; margin-bottom: 0;">Mã OTP có hiệu lực trong <strong>${expiryMinutes} phút</strong>. Tuyệt đối không chia sẻ mã này cho người khác để bảo vệ an toàn tài khoản.</p>
        </div>
        <div style="background: #f8fafc; padding: 14px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
          &copy; 2026 Smart Order Platform &bull; Email tự động, vui lòng không phản hồi.
        </div>
      </div>
    `;
  }

  async sendMail(options: MailPayload, throwOnError = false): Promise<boolean> {
    // Mask OTP digits in all environment logs
    const maskedText = options.text.replace(/\b\d{6}\b/g, '******');

    const isDummyDomain = /@.*\.(local|test|example|invalid)$/i.test(options.to) ||
                          /@(smartorder\.local|smartorder\.test|localhost|example\.com|realdomain\.com|test\.com)$/i.test(options.to);
    const isTestEnv = process.env.NODE_ENV === 'test' || process.env.DISABLE_REAL_EMAIL === 'true';

    const httpsProvider = this.getHttpsProvider();
    const hasActiveTransport = Boolean(httpsProvider || (this.isSmtpConfigured && this.transporter));

    // In production without configured mail transport: fail fast
    if (process.env.NODE_ENV === 'production' && !hasActiveTransport) {
      this.logger.error(`[CRITICAL] Mail provider not configured in production. Cannot send email to ${this.maskEmail(options.to)}`);
      if (throwOnError) {
        throw new Error('Mail provider (HTTPS API or SMTP) not configured in production');
      }
      return false;
    }

    if (!hasActiveTransport || isDummyDomain || isTestEnv) {
      this.logger.log(`[SIMULATED EMAIL DISPATCH] TO: ${this.maskEmail(options.to)} | SUBJECT: ${options.subject}`);
      this.logger.log(`[SIMULATED EMAIL CONTENT] ${maskedText}`);
      return true;
    }

    const rawFrom = process.env.SMTP_FROM || this.smtpUser || 'no-reply@smartorder.vn';
    const from = rawFrom.includes('<') ? rawFrom : `"Smart Order Platform" <${rawFrom}>`;

    try {
      if (httpsProvider) {
        try {
          await this.sendViaHttpsApi(httpsProvider, options, from);
          this.logger.log(`Email dispatched via ${httpsProvider.toUpperCase()} HTTPS API to ${this.maskEmail(options.to)}`);
          return true;
        } catch (httpsErr: any) {
          if (!this.isSmtpConfigured) {
            throw httpsErr;
          }
          this.logger.warn(`HTTPS mail provider (${httpsProvider}) failed (${httpsErr.message}); falling back to IPv4 SMTP...`);
        }
      }

      const target = await MailService.resolveSmtpConnectionTarget(this.smtpHost);
      const activeTransporter =
        target.connectHost !== this.smtpHost
          ? this.buildSmtpTransporter(target.connectHost, target.servername, this.smtpPort, this.smtpUser, this.smtpPass)
          : this.transporter!;

      let timeoutId: NodeJS.Timeout | undefined;
      try {
        const sendPromise = activeTransporter.sendMail({
          from,
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('SMTP timeout (outbound connection blocked or unacknowledged)')),
            15000,
          );
        });

        await Promise.race([sendPromise, timeoutPromise]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (activeTransporter !== this.transporter) {
          try {
            activeTransporter.close();
          } catch (_) {}
        }
      }

      this.logger.log(`Email dispatched successfully via SMTP to ${this.maskEmail(options.to)}`);
      return true;
    } catch (err: any) {
      this.logger.warn(`Failed to send email to ${this.maskEmail(options.to)}: ${err.message}`);
      if (throwOnError) {
        throw err;
      }
      return false;
    }
  }

  async sendRegistrationOtp(email: string, otp: string): Promise<boolean> {
    const title = 'Xác minh kích hoạt tài khoản';
    const message = 'Cảm ơn bạn đã đăng ký tài khoản tại Smart Order Platform. Dưới đây là mã OTP kích hoạt tài khoản của bạn:';
    await this.enqueueMail({
      to: email,
      subject: '[Smart Order] Mã OTP xác minh tài khoản',
      text: `${title} - ${message} Mã OTP: ${otp} (Hiệu lực: 15 phút)`,
      html: this.buildOtpTemplate(title, message, otp, 15),
    });
    return true;
  }

  async sendPasswordResetOtp(email: string, otp: string): Promise<boolean> {
    const title = 'Yêu cầu đặt lại mật khẩu';
    const message = 'Hệ thống nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn. Vui lòng nhập mã OTP sau:';
    await this.enqueueMail({
      to: email,
      subject: '[Smart Order] Mã OTP đặt lại mật khẩu',
      text: `${title} - ${message} Mã OTP: ${otp} (Hiệu lực: 15 phút)`,
      html: this.buildOtpTemplate(title, message, otp, 15),
    });
    return true;
  }
}

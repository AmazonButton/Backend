import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private isConfigured = false;

  constructor() {
    this.initTransporter();
  }

  private initTransporter() {
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASSWORD?.trim();
    const host = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT) || 465;

    if (user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      this.isConfigured = true;
      this.logger.log(`MailService initialized with SMTP host ${host}:${port} (User: ${user})`);
    } else {
      this.logger.warn('SMTP_USER or SMTP_PASSWORD not set. MailService operating in DEV FALLBACK MODE.');
    }
  }

  private buildOtpTemplate(title: string, message: string, otp: string, expiryMinutes = 10): string {
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

  async sendMail(options: { to: string; subject: string; text: string; html: string }): Promise<boolean> {
    if (!this.isConfigured || !this.transporter) {
      this.logger.log(`[DEV EMAIL DISPATCH] TO: ${options.to} | SUBJECT: ${options.subject}`);
      this.logger.log(`[DEV EMAIL CONTENT] ${options.text}`);
      return true;
    }
    try {
      const from = process.env.SMTP_FROM || process.env.SMTP_USER;
      await this.transporter.sendMail({
        from: `"Smart Order Platform" <${from}>`,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });
      this.logger.log(`Email dispatched successfully to ${options.to}`);
      return true;
    } catch (err: any) {
      this.logger.error(`Failed to send email to ${options.to}: ${err.message}`);
      return false;
    }
  }

  async sendRegistrationOtp(email: string, otp: string): Promise<boolean> {
    const title = 'Xác minh kích hoạt tài khoản';
    const message = 'Cảm ơn bạn đã đăng ký tài khoản tại Smart Order Platform. Dưới đây là mã OTP kích hoạt tài khoản của bạn:';
    return this.sendMail({
      to: email,
      subject: '[Smart Order] Mã OTP xác minh tài khoản',
      text: `${title} - ${message} Mã OTP: ${otp} (Hiệu lực: 10 phút)`,
      html: this.buildOtpTemplate(title, message, otp, 10),
    });
  }

  async sendPasswordResetOtp(email: string, otp: string): Promise<boolean> {
    const title = 'Yêu cầu đặt lại mật khẩu';
    const message = 'Hệ thống nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn. Vui lòng nhập mã OTP sau:';
    return this.sendMail({
      to: email,
      subject: '[Smart Order] Mã OTP đặt lại mật khẩu',
      text: `${title} - ${message} Mã OTP: ${otp} (Hiệu lực: 10 phút)`,
      html: this.buildOtpTemplate(title, message, otp, 10),
    });
  }
}

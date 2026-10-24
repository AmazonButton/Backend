import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
  Req,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StoreWalletService } from '../store-wallet/store-wallet.service';
import { verifyPayoutSignature } from './payos.helper';

export interface PayosPayoutWebhookDto {
  code: string;
  desc: string;
  data: {
    id: string;
    referenceId: string;
    amount: number;
    description?: string;
    toBin?: string;
    toAccountNumber?: string;
    toAccountName?: string;
    state?: string;
    approvalState?: string;
    transactions?: Array<{
      id: string;
      referenceId: string;
      amount: number;
      state: string;
    }>;
  };
  signature: string;
}

@Controller('webhooks')
export class PayoutWebhookController {
  private readonly logger = new Logger(PayoutWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => StoreWalletService))
    private readonly walletService: StoreWalletService,
  ) {}

  @Post('payos/payout')
  @HttpCode(HttpStatus.OK)
  async handlePayoutWebhook(@Body() body: PayosPayoutWebhookDto, @Req() req?: any) {
    if (!body?.data || !body?.signature) {
      throw new BadRequestException('Webhook payload hoặc chữ ký không hợp lệ');
    }

    const checksumKey =
      process.env.PAYOS_PAYOUT_CHECKSUM_KEY?.trim() ||
      process.env.PAYOS_CHECKSUM_KEY?.trim();

    if (!checksumKey) {
      this.logger.error('PAYOS_PAYOUT_CHECKSUM_KEY chưa được cấu hình');
      throw new BadRequestException('Thiếu cấu hình khóa xác thực chi hộ');
    }

    // 1. Primary: Timing-safe HMAC-SHA256 verification on canonical sorted data (Official PayOS specification)
    let isValid = verifyPayoutSignature(body.data, body.signature, checksumKey);

    // 2. Secondary fallback: Raw body HMAC verification if rawBody buffer is present
    if (!isValid && req?.rawBody) {
      try {
        const rawHmac = crypto.createHmac('sha256', checksumKey).update(req.rawBody).digest('hex');
        isValid = crypto.timingSafeEqual(Buffer.from(rawHmac, 'hex'), Buffer.from(body.signature, 'hex'));
      } catch {
        isValid = false;
      }
    }

    if (!isValid) {
      this.logger.warn(`Chữ ký webhook PayOS Payout không khớp cho ref: ${body.data?.referenceId}`);
      throw new BadRequestException('Chữ ký webhook không hợp lệ');
    }

    const referenceId = body.data.referenceId;
    if (!referenceId) {
      this.logger.warn('Webhook PayOS Payout thiếu referenceId');
      return { success: true, message: 'Đã nhận webhook (thiếu referenceId)' };
    }

    // Find withdrawal record by providerReferenceId or withdrawalCode
    const withdrawal = await this.prisma.storeWithdrawal.findFirst({
      where: {
        OR: [
          { providerReferenceId: referenceId },
          { withdrawalCode: referenceId },
        ],
      },
      include: { wallet: true },
    });

    if (!withdrawal) {
      this.logger.warn(`Không tìm thấy yêu cầu rút tiền với ref: ${referenceId}`);
      return { success: true, message: 'Không tìm thấy yêu cầu rút tiền tương ứng' };
    }

    // Determine target state
    const rawState =
      body.data.state ||
      body.data.approvalState ||
      body.data.transactions?.[0]?.state ||
      '';

    const isSucceeded = ['SUCCEEDED', 'COMPLETED', 'PAID'].includes(rawState.toUpperCase());
    const isFailed = ['FAILED', 'REJECTED', 'CANCELLED'].includes(rawState.toUpperCase());

    // Idempotency check: if already in target state, return OK immediately
    if (isSucceeded && withdrawal.status === 'SUCCEEDED') {
      return { success: true, message: 'Yêu cầu rút tiền đã ở trạng thái hoàn thành trước đó' };
    }
    if (isFailed && withdrawal.status === 'FAILED') {
      return { success: true, message: 'Yêu cầu rút tiền đã được xử lý hoàn tiền trước đó' };
    }

    // Monotonic guard: never downgrade terminal SUCCEEDED to FAILED
    if (withdrawal.status === 'SUCCEEDED') {
      this.logger.warn(`Bỏ qua webhook FAILED cho yêu cầu #${withdrawal.withdrawalCode} đã SUCCEEDED`);
      return { success: true, message: 'Không thể chuyển đổi trạng thái đã thành công' };
    }

    if (isSucceeded) {
      // Payout Succeeded: Release frozen balance, do not add to balance
      await this.prisma.$transaction(async (tx) => {
        const [lockedWithdrawal] = await tx.$queryRaw<Array<{
          withdrawal_id: bigint;
          status: string;
          amount: any;
          wallet_id: bigint;
        }>>`
          SELECT withdrawal_id, status, amount, wallet_id
          FROM store_withdrawals
          WHERE withdrawal_id = ${withdrawal.withdrawalId}
          FOR UPDATE
        `;

        if (!lockedWithdrawal || lockedWithdrawal.status === 'SUCCEEDED') return;

        const [lockedWallet] = await tx.$queryRaw<Array<{
          wallet_id: bigint;
          frozen_balance: any;
        }>>`
          SELECT wallet_id, frozen_balance
          FROM store_wallets
          WHERE wallet_id = ${lockedWithdrawal.wallet_id}
          FOR UPDATE
        `;

        if (lockedWallet) {
          const currentFrozen = Number(lockedWallet.frozen_balance || 0);
          const frozenAfter = Math.max(0, currentFrozen - Number(lockedWithdrawal.amount));

          await tx.storeWallet.update({
            where: { walletId: lockedWallet.wallet_id },
            data: { frozenBalance: frozenAfter },
          });
        }

        await tx.storeWithdrawal.update({
          where: { withdrawalId: withdrawal.withdrawalId },
          data: {
            status: 'SUCCEEDED',
            processedAt: new Date(),
          },
        });
      });

      this.logger.log(`Hoàn tất chi tiền thành công cho yêu cầu #${withdrawal.withdrawalCode}`);
      return { success: true, message: 'Đã hoàn tất chi tiền thành công' };
    }

    if (isFailed) {
      // Payout Failed: Refund frozen balance back to wallet balance
      const failReason = body.desc || 'PayOS Payout thông báo thất bại';
      await this.walletService.refundFailedWithdrawal(withdrawal.withdrawalId, failReason);

      this.logger.log(`Đã hoàn tiền tự động cho yêu cầu rút thất bại #${withdrawal.withdrawalCode}`);
      return { success: true, message: 'Đã hoàn tiền yêu cầu rút thất bại' };
    }

    return { success: true, message: 'Webhook đã được ghi nhận' };
  }
}

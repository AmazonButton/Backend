import { Body, Controller, ForbiddenException, Get, Param, Post, Put, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { WalletService } from './wallet.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
@Controller('store/wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  private storeId(req: any, requested?: string) {
    const storeId = req.user.role === 'SUPER_ADMIN' ? requested || req.user.storeId : req.user.storeId;
    if (!storeId) throw new ForbiddenException('Tài khoản chưa được gắn với cửa hàng');
    return storeId;
  }

  @Get()
  async getWallet(@Request() req: any) {
    return { success: true, data: await this.walletService.getWallet(this.storeId(req)) };
  }

  @Put('bank-account')
  async updateBankAccount(@Request() req: any, @Body() body: any) {
    return { success: true, data: await this.walletService.updateBankAccount(this.storeId(req), body) };
  }

  @Get('transactions')
  async getTransactions(@Request() req: any) {
    return { success: true, data: await this.walletService.getTransactions(this.storeId(req)) };
  }

  @Post('withdrawals')
  async requestWithdrawal(@Request() req: any, @Body() body: any) {
    return { success: true, data: await this.walletService.requestWithdrawal(this.storeId(req), body, req.headers['idempotency-key']) };
  }

  @Get('withdrawals')
  async getWithdrawals(@Request() req: any) {
    return { success: true, data: await this.walletService.getWithdrawals(this.storeId(req)) };
  }

  @Post('withdrawals/:id/sync-status')
  async syncWithdrawalStatus(@Request() req: any, @Param('id') id: string) {
    return { success: true, data: await this.walletService.syncWithdrawalStatus(this.storeId(req), id) };
  }
}

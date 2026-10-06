import { Controller, Get, Put, Body, UseGuards, Request, Param, Post } from '@nestjs/common';
import { StoreWalletService } from './store-wallet.service';
import { UpdateBankAccountDto } from './dto/wallet.dto';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('store/wallet')
export class StoreWalletController {
  constructor(private readonly walletService: StoreWalletService) {}

  @Get()
  async getWallet(@Request() req: any) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId;
    const data = await this.walletService.getOrCreateStoreWallet(storeId);
    return { success: true, data };
  }

  @Put('bank-account')
  async updateBankAccount(@Request() req: any, @Body() body: UpdateBankAccountDto) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId;
    const data = await this.walletService.updateBankAccount(storeId, body);
    return { success: true, message: 'C?p nh?t tài kho?n ngân hàng thành công!', data };
  }

  @Get('transactions')
  async getTransactions(@Request() req: any) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId;
    const data = await this.walletService.listTransactions(storeId);
    return { success: true, data };
  }

  @Post('withdrawals')
  async requestWithdrawal(@Request() req: any, @Body() body: RequestWithdrawalDto) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId;
    const data = await this.walletService.requestWithdrawal(storeId, body);
    return { success: true, message: 'G?i yêu c?u rút ti?n thành công!', data };
  }

  @Get('withdrawals')
  async getWithdrawals(@Request() req: any) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId;
    const data = await this.walletService.listWithdrawals(storeId);
    return { success: true, data };
  }

  @Post('withdrawals/:id/sync-status')
  async syncWithdrawalStatus(@Param('id') id: string) {
    const data = await this.walletService.syncWithdrawalPayoutStatus(id);
    return { success: true, message: 'Ð?ng b? tr?ng thái chi ti?n thành công', data };
  }
}

import { RequestWithdrawalDto } from './dto/withdrawal.dto';
import { Controller, Get, Put, Body, UseGuards, Request } from '@nestjs/common';
import { StoreWalletService } from './store-wallet.service';
import { UpdateBankAccountDto } from './dto/wallet.dto';
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
    return { success: true, message: 'Cập nhật tài khoản ngân hàng thành công!', data };
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
    return { success: true, message: 'Gửi yêu cầu rút tiền thành công!', data };
  }

  @Get('withdrawals')
  async getWithdrawals(@Request() req: any) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId;
    const data = await this.walletService.listWithdrawals(storeId);
    return { success: true, data };
  }
}

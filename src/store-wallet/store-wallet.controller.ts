import { Controller, Get, Put, Body, UseGuards, Request, Param, Post } from '@nestjs/common';
import { StoreWalletService } from './store-wallet.service';
import { UpdateBankAccountDto } from './dto/wallet.dto';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ForbiddenException } from '@nestjs/common';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STORE_OWNER', 'STORE_MANAGER')
@Controller('store/wallet')
export class StoreWalletController {
  constructor(private readonly walletService: StoreWalletService) {}

  @Get()
  async getWallet(@Request() req: any) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId || (req.query?.storeId ? BigInt(req.query.storeId) : undefined);
    if (!storeId) {
      throw new ForbiddenException('Không tìm thấy thông tin cửa hàng liên kết (storeId)');
    }
    const data = await this.walletService.getOrCreateStoreWallet(storeId);
    return { success: true, data };
  }

  @Put('bank-account')
  async updateBankAccount(@Request() req: any, @Body() body: UpdateBankAccountDto) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId || (req.query?.storeId ? BigInt(req.query.storeId) : undefined);
    if (!storeId) {
      throw new ForbiddenException('Không tìm thấy thông tin cửa hàng liên kết (storeId)');
    }
    const data = await this.walletService.updateBankAccount(storeId, body);
    return { success: true, message: 'C?p nh?t t�i kho?n ng�n h�ng th�nh c�ng!', data };
  }

  @Get('transactions')
  async getTransactions(@Request() req: any) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId || (req.query?.storeId ? BigInt(req.query.storeId) : undefined);
    if (!storeId) {
      throw new ForbiddenException('Không tìm thấy thông tin cửa hàng liên kết (storeId)');
    }
    const data = await this.walletService.listTransactions(storeId);
    return { success: true, data };
  }

  @Post('withdrawals')
  async requestWithdrawal(@Request() req: any, @Body() body: RequestWithdrawalDto) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId || (req.query?.storeId ? BigInt(req.query.storeId) : undefined);
    if (!storeId) {
      throw new ForbiddenException('Không tìm thấy thông tin cửa hàng liên kết (storeId)');
    }
    const data = await this.walletService.requestWithdrawal(storeId, body);
    return { success: true, message: 'G?i y�u c?u r�t ti?n th�nh c�ng!', data };
  }

  @Get('withdrawals')
  async getWithdrawals(@Request() req: any) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId || (req.query?.storeId ? BigInt(req.query.storeId) : undefined);
    if (!storeId) {
      throw new ForbiddenException('Không tìm thấy thông tin cửa hàng liên kết (storeId)');
    }
    const data = await this.walletService.listWithdrawals(storeId);
    return { success: true, data };
  }

  @Post('withdrawals/:id/sync-status')
  async syncWithdrawalStatus(@Param('id') id: string, @Request() req: any) {
    const storeId = req.user.storeId || req.user.ownedStores?.[0]?.storeId || (req.query?.storeId ? BigInt(req.query.storeId) : undefined);
    if (!storeId) {
      throw new ForbiddenException('Không tìm thấy thông tin cửa hàng liên kết (storeId)');
    }
    const data = await this.walletService.syncWithdrawalPayoutStatus(id, storeId);
    return { success: true, message: '�?ng b? tr?ng th�i chi ti?n th�nh c�ng', data };
  }
}

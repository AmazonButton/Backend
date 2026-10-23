import { Controller, Get, Put, Body, UseGuards, Request, Param, Post, Query, ForbiddenException } from '@nestjs/common';
import { StoreWalletService } from './store-wallet.service';
import { UpdateBankAccountDto, StoreQueryDto } from './dto/wallet.dto';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STORE_OWNER', 'STORE_MANAGER')
@Controller('store/wallet')
export class StoreWalletController {
  constructor(private readonly walletService: StoreWalletService) {}

  private extractStoreId(req: any, query?: StoreQueryDto): bigint {
    const isSuperAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(req.user?.role);
    if (isSuperAdmin && query?.storeId) return BigInt(query.storeId);

    const storeId = req.user?.storeId || req.user?.ownedStores?.[0]?.storeId;
    if (!storeId) throw new ForbiddenException('No store is associated with this session');
    return BigInt(storeId);
  }

  @Get()
  async getWallet(@Request() req: any, @Query() query?: StoreQueryDto) {
    return { success: true, data: await this.walletService.getWallet(this.extractStoreId(req, query)) };
  }

  @Put('bank-account')
  async updateBankAccount(@Request() req: any, @Body() body: UpdateBankAccountDto, @Query() query?: StoreQueryDto) {
    const data = await this.walletService.updateBankAccount(this.extractStoreId(req, query), body);
    return { success: true, message: 'Bank account updated successfully', data };
  }

  @Get('transactions')
  async getTransactions(@Request() req: any, @Query() query?: StoreQueryDto) {
    return { success: true, data: await this.walletService.listTransactions(this.extractStoreId(req, query)) };
  }

  @Post('withdrawals')
  async requestWithdrawal(@Request() req: any, @Body() body: RequestWithdrawalDto, @Query() query?: StoreQueryDto) {
    const idempotencyKey = (req.headers?.['idempotency-key'] as string) || (req.headers?.['x-idempotency-key'] as string) || undefined;
    const data = await this.walletService.requestWithdrawal(this.extractStoreId(req, query), body, idempotencyKey);
    return { success: true, message: 'Withdrawal request created successfully', data: this.walletService.serializeWithdrawal(data) };
  }

  @Get('withdrawals')
  async getWithdrawals(@Request() req: any, @Query() query?: StoreQueryDto) {
    return { success: true, data: await this.walletService.listWithdrawals(this.extractStoreId(req, query)) };
  }

  @Post('withdrawals/:id/sync-status')
  async syncWithdrawalStatus(@Param('id') id: string, @Request() req: any, @Query() query?: StoreQueryDto) {
    const data = await this.walletService.syncWithdrawalPayoutStatus(id, this.extractStoreId(req, query));
    return { success: true, message: 'Withdrawal payout status synchronized successfully', data: this.walletService.serializeWithdrawal(data) };
  }
}

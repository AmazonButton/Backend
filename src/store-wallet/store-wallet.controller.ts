import { Controller, Get, Put, Body, UseGuards, Request, Param, Post, Query, ForbiddenException } from '@nestjs/common';
import { StoreWalletService } from './store-wallet.service';
import { UpdateBankAccountDto, StoreQueryDto, TransactionQueryDto, WithdrawalQueryDto } from './dto/wallet.dto';
import { RequestWithdrawalDto } from './dto/withdrawal.dto';
import { WalletMapper } from './mappers/wallet.mapper';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STORE_OWNER', 'STORE_MANAGER')
@Controller('store/wallet')
export class StoreWalletController {
  constructor(private readonly walletService: StoreWalletService) {}

  private extractStoreId(req: any, query?: StoreQueryDto | TransactionQueryDto | WithdrawalQueryDto): bigint {
    const isSuperAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN'].includes(req.user?.role);
    if (isSuperAdmin && query?.storeId) {
      return BigInt(query.storeId);
    }
    const storeId = req.user?.storeId || req.user?.ownedStores?.[0]?.storeId;
    if (!storeId) {
      throw new ForbiddenException('Không tìm thấy thông tin cửa hàng liên kết (storeId) trong phiên đăng nhập');
    }
    return BigInt(storeId);
  }

  @Get()
  async getWallet(@Request() req: any, @Query() query?: StoreQueryDto) {
    const storeId = this.extractStoreId(req, query);
    const data = await this.walletService.getOrCreateStoreWallet(storeId);
    return { success: true, data: WalletMapper.toWalletDto(data) };
  }

  @Put('bank-account')
  async updateBankAccount(@Request() req: any, @Body() body: UpdateBankAccountDto, @Query() query?: StoreQueryDto) {
    const storeId = this.extractStoreId(req, query);
    const data = await this.walletService.updateBankAccount(storeId, body);
    return { success: true, message: 'Cập nhật tài khoản ngân hàng thành công!', data };
  }

  @Get('transactions')
  async getTransactions(@Request() req: any, @Query() query?: TransactionQueryDto) {
    const storeId = this.extractStoreId(req, query);
    const result = await this.walletService.listTransactions(storeId, query);
    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy danh sách giao dịch ví thành công',
    );
  }

  @Post('withdrawals')
  async requestWithdrawal(@Request() req: any, @Body() body: RequestWithdrawalDto, @Query() query?: StoreQueryDto) {
    const storeId = this.extractStoreId(req, query);
    const idempotencyKey =
      (req.headers?.['idempotency-key'] as string) ||
      (req.headers?.['x-idempotency-key'] as string) ||
      undefined;
    const data = await this.walletService.requestWithdrawal(storeId, body, idempotencyKey);
    return { success: true, message: 'Gửi yêu cầu rút tiền thành công!', data: WalletMapper.toWithdrawalDto(data) };
  }

  @Get('withdrawals')
  async getWithdrawals(@Request() req: any, @Query() query?: WithdrawalQueryDto) {
    const storeId = this.extractStoreId(req, query);
    const result = await this.walletService.listWithdrawals(storeId, query);
    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy danh sách yêu cầu rút tiền thành công',
    );
  }

  @Get('withdrawals/:id')
  async getWithdrawalDetail(@Param('id') id: string, @Request() req: any, @Query() query?: StoreQueryDto) {
    const storeId = this.extractStoreId(req, query);
    const data = await this.walletService.getWithdrawal(id, storeId);
    return { success: true, message: 'Lấy chi tiết yêu cầu rút tiền thành công', data };
  }

  @Post('withdrawals/:id/sync-status')
  async syncWithdrawalStatus(@Param('id') id: string, @Request() req: any, @Query() query?: StoreQueryDto) {
    const storeId = this.extractStoreId(req, query);
    const data = await this.walletService.syncWithdrawalPayoutStatus(id, storeId);
    return { success: true, message: 'Đồng bộ trạng thái chi tiền thành công', data: WalletMapper.toWithdrawalDto(data) };
  }
}

import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { BankVerificationService } from './bank-verification.service';
import { LookupBankAccountDto } from './dto/lookup-bank-account.dto';
import { CreateVerificationRequestDto } from './dto/create-verification-request.dto';
import { BankLookupRateLimitGuard } from './guards/bank-lookup-rate-limit.guard';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';

@ApiTags('Store Bank Accounts')
@Controller('stores')
export class StoreBankAccountsController {
  constructor(private readonly service: BankVerificationService) {}

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Tra cứu tên chủ tài khoản ngân hàng từ VietQR / NAPAS' })
  @UseGuards(JwtAuthGuard, BankLookupRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @Post('bank-accounts/lookup')
  async lookupAccount(@Body() dto: LookupBankAccountDto) {
    const data = await this.service.lookupBankAccount(dto);
    return {
      success: true,
      message: 'Tra cứu thông tin tài khoản thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Tạo yêu cầu xác minh tài khoản ngân hàng chính chủ (2.000 VND)' })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @Post('bank-accounts/verification')
  async createVerification(
    @Body() dto: CreateVerificationRequestDto,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.userId);
    const role = req.user?.role;
    const data = await this.service.createVerificationRequest(userId, dto, role);
    return {
      success: true,
      message: 'Tạo yêu cầu xác minh tài khoản thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Lấy danh sách tài khoản ngân hàng của cửa hàng' })
  @UseGuards(JwtAuthGuard)
  @Get(':storeId/bank-accounts')
  async listBankAccounts(
    @Param('storeId') storeId: string,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.userId);
    const role = req.user?.role;
    const data = await this.service.listStoreBankAccounts(userId, storeId, role);
    return {
      success: true,
      message: 'Lấy danh sách tài khoản ngân hàng thành công',
      data,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Lấy danh sách lịch sử giao dịch xác minh tài khoản của cửa hàng' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @UseGuards(JwtAuthGuard)
  @Get(':storeId/bank-account-verifications')
  async listStoreVerificationTransactions(
    @Param('storeId') storeId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Request() req?: any,
  ) {
    const userId = BigInt(req.user.userId);
    const role = req.user?.role;
    const result = await this.service.listStoreVerificationTransactions(
      storeId,
      {
        page: page ? Number(page) : 1,
        pageSize: pageSize ? Number(pageSize) : 20,
        status,
      },
      userId,
      role,
    );

    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy danh sách giao dịch xác minh tài khoản thành công',
    );
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Đặt tài khoản ngân hàng làm mặc định của cửa hàng' })
  @UseGuards(JwtAuthGuard)
  @Patch(':storeId/bank-accounts/:id/default')
  async setDefaultBankAccount(
    @Param('storeId') storeId: string,
    @Param('id') id: string,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.userId);
    const role = req.user?.role;
    const result = await this.service.setDefaultBankAccount(userId, storeId, id, role);
    return {
      success: true,
      message: result.message,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Xóa tài khoản ngân hàng của cửa hàng' })
  @UseGuards(JwtAuthGuard)
  @Delete(':storeId/bank-accounts/:id')
  async deleteBankAccount(
    @Param('storeId') storeId: string,
    @Param('id') id: string,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.userId);
    const role = req.user?.role;
    const result = await this.service.deleteBankAccount(userId, storeId, id, role);
    return {
      success: true,
      message: result.message,
    };
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Hủy yêu cầu xác minh tài khoản đang PENDING của cửa hàng' })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('bank-accounts/verification/:id/cancel')
  async cancelVerification(
    @Param('id') id: string,
    @Request() req: any,
  ) {
    const userId = BigInt(req.user.userId);
    const role = req.user?.role;
    const result = await this.service.cancelVerificationRequest(userId, id, role);
    return {
      success: true,
      message: result.message,
    };
  }
}

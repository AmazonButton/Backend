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
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { BankVerificationService } from './bank-verification.service';
import { LookupBankAccountDto } from './dto/lookup-bank-account.dto';
import { CreateVerificationRequestDto } from './dto/create-verification-request.dto';
import { BankLookupRateLimitGuard } from './guards/bank-lookup-rate-limit.guard';

@Controller('stores')
export class StoreBankAccountsController {
  constructor(private readonly service: BankVerificationService) {}

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

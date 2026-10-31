import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Request,
  Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { BillingChargesService } from './billing-charges.service';

@ApiTags('Billing Charges & Settlement')
@Controller('billing-charges')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class BillingChargesController {
  constructor(
    @Inject(BillingChargesService) private readonly chargesService: BillingChargesService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Chi tiết khoản thu và các dòng phí (thuê, cọc, duy trì sàn)' })
  @ApiResponse({ status: 200, description: 'Thông tin chi tiết khoản thu' })
  async getChargeById(@Param('id') id: string, @Request() req: any) {
    const charge = await this.chargesService.getChargeById(BigInt(id), req.user);
    return {
      success: true,
      message: 'Lấy thông tin khoản thu thành công',
      data: charge,
    };
  }

  @Post(':id/settle')
  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Đối soát và xác nhận thu tiền khoản phí (reconciliation atomic transaction)' })
  @ApiResponse({ status: 200, description: 'Khoản thu được thanh toán thành công' })
  async settleCharge(
    @Param('id') id: string,
    @Body() body: { providerTransactionCode: string },
    @Request() req: any,
  ) {
    const result = await this.chargesService.reconcileAndSettleCharge(
      BigInt(id),
      body.providerTransactionCode,
      req.user,
    );
    return {
      success: true,
      message: 'Đối soát thanh toán và cấp quyền thành công',
      data: result,
    };
  }

  @Post(':id/payment-link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tạo liên kết thanh toán PayOS thật cho khoản thu' })
  @ApiResponse({ status: 200, description: 'Tạo liên kết thanh toán PayOS thành công' })
  async createPaymentLink(
    @Param('id') id: string,
    @Body() body: { returnUrl?: string; cancelUrl?: string } = {},
    @Request() req: any = {},
  ) {
    const result = await this.chargesService.createPayosPaymentRequestForCharge(
      BigInt(id),
      req.user,
      body.returnUrl,
      body.cancelUrl,
    );
    return {
      success: true,
      message: 'Tạo liên kết thanh toán PayOS thành công',
      data: result,
    };
  }
}


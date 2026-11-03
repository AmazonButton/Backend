import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Header,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { StoreCashService } from './store-cash.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { Idempotent } from '../common/idempotency/idempotency.decorator';
import {
  issueCashVoucherSchema,
  collectCashSchema,
  collectCashBodySchema,
  validateZod,
  validatePathId,
} from './dto/store-cash.dto';

@ApiTags('Rentals - Cash Vouchers')
@Controller('rentals')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomerRentalsCashVoucherController {
  constructor(private readonly storeCashService: StoreCashService) {}

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Khách hàng tạo mã QR token xác nhận thanh toán tiền mặt tại cửa hàng' })
  @Roles('CUSTOMER')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Post(':rentalId/cash-vouchers')
  async issueCashVoucher(
    @Param('rentalId') rentalId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    validatePathId(rentalId, 'rentalId');
    const dto = validateZod(issueCashVoucherSchema, body);
    return this.storeCashService.issueCashVoucher(rentalId, dto, req.user);
  }
}

@ApiTags('Stores - Cash Receipts')
@Controller('stores/:storeId')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StoreCashReceiptsController {
  constructor(private readonly storeCashService: StoreCashService) {}

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Cửa hàng xác nhận thu tiền mặt và cấn trừ ví nội bộ' })
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_BUTTON')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ required: true, ttlSeconds: 86400 })
  @Post('cash-receipts')
  async collectCashWithBody(
    @Param('storeId') storeId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    validatePathId(storeId, 'storeId');
    const { rentalId, ...collection } = validateZod(collectCashBodySchema, body);
    return this.storeCashService.collectCash(storeId, rentalId, collection, req.user);
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Cửa hàng xác nhận thu tiền mặt cho hợp đồng thuê cụ thể' })
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_BUTTON')
  @UseInterceptors(IdempotencyInterceptor)
  @Idempotent({ required: true, ttlSeconds: 86400 })
  @Post('rentals/:rentalId/confirm-cash-collection')
  async confirmCashCollection(
    @Param('storeId') storeId: string,
    @Param('rentalId') rentalId: string,
    @Body() body: any,
    @Request() req: any,
  ) {
    validatePathId(storeId, 'storeId');
    validatePathId(rentalId, 'rentalId');
    const dto = validateZod(collectCashSchema, body);
    return this.storeCashService.collectCash(storeId, rentalId, dto, req.user);
  }


  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Kiểm tra thông tin hợp đồng và danh sách nút khả dụng tại kho cửa hàng trước khi bàn giao' })
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_BUTTON')
  @Get('rentals/:rentalId/handover-preview')
  async getHandoverPreview(
    @Param('storeId') storeId: string,
    @Param('rentalId') rentalId: string,
    @Request() req: any,
    @Query() query: any,
  ) {
    validatePathId(storeId, 'storeId');
    validatePathId(rentalId, 'rentalId');
    return this.storeCashService.getHandoverPreview(storeId, rentalId, req.user, query);
  }

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Lấy thông tin biên lai thu tiền mặt theo ID' })
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_BUTTON', 'SUPER_ADMIN')
  @Get('cash-receipts/:receiptId')
  async getReceipt(
    @Param('storeId') storeId: string,
    @Param('receiptId') receiptId: string,
    @Request() req: any,
  ) {
    validatePathId(storeId, 'storeId');
    validatePathId(receiptId, 'receiptId');
    return this.storeCashService.getReceipt(storeId, receiptId, req.user);
  }
}

@ApiTags('Admin - Billing Overpayments')
@Controller('admin/billing-overpayments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminBillingOverpaymentsController {
  constructor(private readonly storeCashService: StoreCashService) {}

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Danh sách các nghĩa vụ đối soát tiền thừa (overpayment obligations)' })
  @Roles('ADMIN', 'SYSTEM_ADMIN', 'SUPER_ADMIN')
  @Get()
  async listOverpayments(
    @Query() query: any,
  ) {
    return this.storeCashService.listOverpayments(query);
  }
}

import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Request,
  Param,
  ForbiddenException,
} from '@nestjs/common';
import { RentalsService } from './rentals.service';
import { CreateRentalOrderDto } from './dto/rentals.dto';
import { RentalExtensionDto } from './dto/rental-extension.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UseInterceptors } from '@nestjs/common';
import { IdempotencyInterceptor } from '../common/idempotency/idempotency.interceptor';
import { Idempotent } from '../common/idempotency/idempotency.decorator';

@UseInterceptors(IdempotencyInterceptor)
@Controller('rentals')
export class RentalsController {
  constructor(private readonly rentalsService: RentalsService) {}

  @Get('packages')
  async listPackages() {
    const data = await this.rentalsService.listAvailablePackages();
    return { success: true, data };
  }

  @UseGuards(JwtAuthGuard)
  @Post('order')
  @Idempotent({ required: true, ttlSeconds: 86400 })
  async createRentalOrder(@Request() req: any, @Body() body: CreateRentalOrderDto) {
    const customerProfileId = req.user.customerProfileId;
    if (!customerProfileId) {
      throw new ForbiddenException('Chỉ tài khoản khách hàng mới có thể tạo hợp đồng thuê nút');
    }
    const data = await this.rentalsService.createRentalContract(customerProfileId, body);
    return { success: true, message: 'Đăng ký thuê nút IoT thành công!', data };
  }

  @UseGuards(JwtAuthGuard)
  @Get('my-rentals')
  async getMyRentals(@Request() req: any) {
    const customerProfileId = req.user.customerProfileId;
    if (!customerProfileId) {
      throw new ForbiddenException('Chỉ tài khoản khách hàng mới có thể xem danh sách nút thuê');
    }
    const data = await this.rentalsService.listCustomerRentals(customerProfileId);
    return { success: true, data };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async getRentalDetail(@Param('id') id: string, @Request() req: any) {
    const data = await this.rentalsService.getRentalDetail(id, req.user);
    return {
      success: true,
      message: 'Lấy thông tin hợp đồng thuê thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/payment-requests')
  @Idempotent({ required: true, ttlSeconds: 86400 })
  async createPaymentRequest(@Param('id') id: string, @Request() req: any) {
    const data = await this.rentalsService.createRentalPaymentRequest(id, req.user);
    return {
      success: true,
      message: 'Tạo yêu cầu thanh toán hợp đồng thuê thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/extensions')
  @Idempotent({ required: true, ttlSeconds: 86400 })
  async extendRental(
    @Param('id') id: string,
    @Body() body: RentalExtensionDto,
    @Request() req: any,
  ) {
    const data = await this.rentalsService.extendRentalContract(id, body, req.user);
    return {
      success: true,
      message: 'Gia hạn hợp đồng thuê thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/return-requests')
  async requestReturn(@Param('id') id: string, @Request() req: any) {
    const data = await this.rentalsService.requestRentalReturn(id, req.user);
    return {
      success: true,
      message: 'Gửi yêu cầu trả nút IoT thành công',
      data,
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN', 'SYSTEM_ADMIN')
  @Post(':id/activate')
  async activateRental(@Param('id') id: string) {
    const data = await this.rentalsService.activateRental(BigInt(id));
    return { success: true, message: 'Kích hoạt hợp đồng thuê thành công!', data };
  }
}

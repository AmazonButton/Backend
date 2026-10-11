import { ForbiddenException } from '@nestjs/common';
import { Controller, Get, Post, Body, UseGuards, Request } from '@nestjs/common';
import { RentalsService } from './rentals.service';
import { CreateRentalOrderDto } from './dto/rentals.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

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
}

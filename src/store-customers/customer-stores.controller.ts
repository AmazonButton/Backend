import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { StoreCustomersService } from './store-customers.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';

@ApiTags('Customer Stores')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('customers')
export class CustomerStoresController {
  constructor(private readonly service: StoreCustomersService) {}

  @ApiBearerAuth('JWT-auth')
  @Get('me/stores')
  @ApiOperation({ summary: 'Xem danh sách các cửa hàng mà khách hàng đã tham gia hoặc mua sắm' })
  async getMyStores(@Request() req: any, @Query() query: any) {
    const result = await this.service.getCustomerStores(req.user, query);
    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy danh sách cửa hàng của khách hàng thành công',
    );
  }
}

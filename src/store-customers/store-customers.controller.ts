import { Controller, Get, Patch, Param, Body, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { StoreCustomersService } from './store-customers.service';
import { UpdateStoreCustomerStatusDto } from './dto/update-customer-status.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { buildPaginatedResponse } from '../common/utils/pagination.helper';

@ApiTags('Store Customers CRM')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('stores')
export class StoreCustomersController {
  constructor(private readonly service: StoreCustomersService) {}

  @ApiBearerAuth('JWT-auth')
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get(':storeId/customers')
  @ApiOperation({ summary: 'Xem danh sách khách hàng của cửa hàng' })
  async getStoreCustomers(
    @Param('storeId') storeId: string,
    @Query() query: any,
    @Request() req: any,
  ) {
    const result = await this.service.getStoreCustomers(storeId, query, req.user);
    return buildPaginatedResponse(
      result.items,
      result.total,
      result.page,
      result.pageSize,
      'Lấy danh sách khách hàng của cửa hàng thành công',
    );
  }

  @ApiBearerAuth('JWT-auth')
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'STAFF_ORDER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Get(':storeId/customers/:customerId')
  @ApiOperation({ summary: 'Xem chi tiết và thống kê khách hàng tại cửa hàng' })
  async getStoreCustomer(
    @Param('storeId') storeId: string,
    @Param('customerId') customerId: string,
    @Request() req: any,
  ) {
    const data = await this.service.getStoreCustomer(storeId, customerId, req.user);
    return { success: true, message: 'Lấy thông tin khách hàng thành công', data };
  }

  @ApiBearerAuth('JWT-auth')
  @Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN', 'SYSTEM_ADMIN')
  @Patch(':storeId/customers/:customerId/status')
  @ApiOperation({ summary: 'Cập nhật trạng thái khách hàng (ACTIVE / BLOCKED)' })
  async updateCustomerStatus(
    @Param('storeId') storeId: string,
    @Param('customerId') customerId: string,
    @Body() body: UpdateStoreCustomerStatusDto,
    @Request() req: any,
  ) {
    const data = await this.service.updateCustomerStatus(storeId, customerId, body.status, req.user);
    return { success: true, message: 'Cập nhật trạng thái khách hàng thành công', data };
  }
}

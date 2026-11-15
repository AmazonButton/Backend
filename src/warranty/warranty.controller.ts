import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { WarrantyService } from './warranty.service';
import { CreateWarrantyTicketDto } from './dto/create-warranty-ticket.dto';
import { QueryWarrantyTicketDto } from './dto/query-warranty-ticket.dto';
import { ApproveSwapTicketDto } from './dto/approve-swap-ticket.dto';
import { ResolveRejectTicketDto } from './dto/resolve-reject-ticket.dto';

@ApiTags('Warranty Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('warranty')
export class WarrantyController {
  constructor(private readonly warrantyService: WarrantyService) {}

  @Get('tickets')
  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN', 'STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_DELIVERY')
  @ApiOperation({ summary: 'Lấy danh sách phiếu bảo hành (Admin xem tất cả; Store/Staff chỉ xem của quán mình)' })
  @ApiResponse({ status: 200, description: 'Danh sách phiếu bảo hành và phân trang' })
  async getTickets(@Query() query: QueryWarrantyTicketDto, @Request() req: any) {
    const result = await this.warrantyService.getTickets(query, req.user);
    return {
      success: true,
      message: 'Lấy danh sách phiếu bảo hành thành công',
      data: result.items,
      pagination: result.pagination,
    };
  }

  @Get('tickets/:id')
  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN', 'STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_DELIVERY')
  @ApiOperation({ summary: 'Xem chi tiết phiếu bảo hành theo ID' })
  @ApiResponse({ status: 200, description: 'Chi tiết phiếu bảo hành' })
  async getTicketById(@Param('id') id: string, @Request() req: any) {
    const data = await this.warrantyService.getTicketById(id, req.user);
    return {
      success: true,
      message: 'Lấy thông tin phiếu bảo hành thành công',
      data,
    };
  }

  @Post('tickets')
  @HttpCode(HttpStatus.CREATED)
  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN', 'STORE_OWNER', 'STORE_MANAGER', 'STORE_STAFF', 'STAFF_DELIVERY')
  @ApiOperation({ summary: 'Tạo phiếu báo lỗi & yêu cầu bảo hành thiết bị' })
  @ApiResponse({ status: 201, description: 'Phiếu bảo hành đã được tạo' })
  async createTicket(@Body() dto: CreateWarrantyTicketDto, @Request() req: any) {
    const data = await this.warrantyService.createTicket(dto, req.user);
    return {
      success: true,
      message: 'Tạo phiếu bảo hành thành công',
      data,
    };
  }

  @Patch('tickets/:id/approve-swap')
  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @ApiOperation({ summary: 'Admin duyệt đổi mới 1-1 thiết bị và ghi nhận luân chuyển kho' })
  @ApiResponse({ status: 200, description: 'Phiếu đã duyệt và thiết bị đã được hoán đổi' })
  async approveSwap(
    @Param('id') id: string,
    @Body() dto: ApproveSwapTicketDto,
    @Request() req: any,
  ) {
    const data = await this.warrantyService.approveSwap(id, dto, req.user);
    return {
      success: true,
      message: 'Duyệt đổi mới 1-1 thiết bị thành công',
      data,
    };
  }

  @Patch('tickets/:id/lock-device')
  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @ApiOperation({ summary: 'Admin khóa nút hư hỏng nặng (Nhóm D) và hoàn tất phiếu' })
  @ApiResponse({ status: 200, description: 'Thiết bị đã bị khóa và phiếu đã chuyển sang RESOLVED' })
  async lockDevice(
    @Param('id') id: string,
    @Body() dto: ResolveRejectTicketDto,
    @Request() req: any,
  ) {
    const data = await this.warrantyService.lockDevice(id, req.user, dto.adminNote);
    return {
      success: true,
      message: 'Đã khóa thiết bị và hoàn tất phiếu bảo hành',
      data,
    };
  }

  @Patch('tickets/:id/resolve')
  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @ApiOperation({ summary: 'Admin hoàn tất phiếu bảo hành' })
  @ApiResponse({ status: 200, description: 'Phiếu bảo hành chuyển sang RESOLVED' })
  async resolveTicket(
    @Param('id') id: string,
    @Body() dto: ResolveRejectTicketDto,
    @Request() req: any,
  ) {
    const data = await this.warrantyService.resolveTicket(id, req.user, dto);
    return {
      success: true,
      message: 'Hoàn tất phiếu bảo hành thành công',
      data,
    };
  }

  @Patch('tickets/:id/reject')
  @Roles('SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN')
  @ApiOperation({ summary: 'Admin từ chối yêu cầu bảo hành' })
  @ApiResponse({ status: 200, description: 'Phiếu bảo hành chuyển sang REJECTED' })
  async rejectTicket(
    @Param('id') id: string,
    @Body() dto: ResolveRejectTicketDto,
    @Request() req: any,
  ) {
    const data = await this.warrantyService.rejectTicket(id, req.user, dto);
    return {
      success: true,
      message: 'Từ chối phiếu bảo hành thành công',
      data,
    };
  }
}

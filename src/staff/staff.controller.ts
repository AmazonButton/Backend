import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { StaffService } from './staff.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Staff')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STAFF_ORDER', 'STAFF_INVENTORY', 'STAFF_BUTTON', 'STAFF_DELIVERY', 'STORE_STAFF', 'DRIVER')
@Controller('staff')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Lấy dữ liệu dashboard của nhân viên hiện tại theo vai trò nghiệp vụ' })
  @Get('me/dashboard')
  async getMyDashboard(@Request() req: any) {
    const data = await this.staffService.getStaffDashboard(req.user);
    return {
      success: true,
      message: 'Lấy dữ liệu dashboard nhân viên thành công',
      data,
    };
  }
}

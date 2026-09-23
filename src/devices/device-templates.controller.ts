import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  Inject,
} from '@nestjs/common';
import { DeviceTemplatesService } from './device-templates.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STORE_OWNER', 'STORE_MANAGER', 'SUPER_ADMIN')
@Controller('device-templates')
export class DeviceTemplatesController {
  constructor(
    @Inject(DeviceTemplatesService)
    private readonly templatesService: DeviceTemplatesService,
  ) {}

  @Get()
  async list(@Request() req: any) {
    const data = await this.templatesService.list(req.user);
    return { success: true, data };
  }

  @Post()
  async create(@Body() body: any, @Request() req: any) {
    const data = await this.templatesService.create(body, req.user);
    return { success: true, message: 'Đã tạo template mẫu thiết bị thành công', data };
  }

  @Get(':id')
  async getById(@Param('id') id: string, @Request() req: any) {
    const data = await this.templatesService.getById(id, req.user);
    return { success: true, data };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    const data = await this.templatesService.update(id, body, req.user);
    return { success: true, message: 'Cập nhật template thành công', data };
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Request() req: any) {
    return this.templatesService.delete(id, req.user);
  }

  @Post(':id/deploy')
  async deploy(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.templatesService.deploy(id, body, req.user);
  }
}

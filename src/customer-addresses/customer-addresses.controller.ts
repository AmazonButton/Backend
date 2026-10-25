import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CustomerAddressesService } from './customer-addresses.service';
import { CreateCustomerAddressDto } from './dto/create-customer-address.dto';
import { UpdateCustomerAddressDto } from './dto/update-customer-address.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('customer-addresses')
@UseGuards(JwtAuthGuard)
export class CustomerAddressesController {
  constructor(private readonly addressService: CustomerAddressesService) {}

  @Get()
  async listAddresses(@Request() req: any) {
    const data = await this.addressService.listAddresses(req.user);
    return {
      success: true,
      message: 'Lấy danh sách địa chỉ thành công',
      data,
    };
  }

  @Post()
  async createAddress(
    @Request() req: any,
    @Body() body: CreateCustomerAddressDto,
  ) {
    const data = await this.addressService.createAddress(req.user, body);
    return {
      success: true,
      message: 'Thêm địa chỉ thành công',
      data,
    };
  }

  @Get(':id')
  async getAddressById(
    @Request() req: any,
    @Param('id') id: string,
  ) {
    const data = await this.addressService.getAddressById(req.user, id);
    return {
      success: true,
      message: 'Lấy thông tin địa chỉ thành công',
      data,
    };
  }

  @Patch(':id')
  async updateAddress(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: UpdateCustomerAddressDto,
  ) {
    const data = await this.addressService.updateAddress(req.user, id, body);
    return {
      success: true,
      message: 'Cập nhật địa chỉ thành công',
      data,
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteAddress(
    @Request() req: any,
    @Param('id') id: string,
  ) {
    await this.addressService.deleteAddress(req.user, id);
    return {
      success: true,
      message: 'Xóa địa chỉ thành công',
    };
  }
}

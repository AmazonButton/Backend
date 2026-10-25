import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { CustomerAddressesRepository } from './customer-addresses.repository';
import { CreateCustomerAddressDto } from './dto/create-customer-address.dto';
import { UpdateCustomerAddressDto } from './dto/update-customer-address.dto';
import { CustomerAddressResponseDto } from './dto/customer-address-response.dto';

@Injectable()
export class CustomerAddressesService {
  constructor(private readonly addressRepo: CustomerAddressesRepository) {}

  async resolveCustomerId(user: any): Promise<bigint> {
    if (user?.customerProfileId) {
      return BigInt(user.customerProfileId);
    }

    if (!user?.userId && !user?.id) {
      throw new ForbiddenException('Không xác định được danh tính người dùng');
    }

    const userId = BigInt(user.userId || user.id);
    let profile = await this.addressRepo.findProfileByUserId(userId);

    if (!profile) {
      // Auto-create customer profile for valid authenticated user
      profile = await this.addressRepo.createProfileForUser(userId, user.phone || null);
    }

    return profile.customerId;
  }

  async listAddresses(user: any): Promise<CustomerAddressResponseDto[]> {
    const customerId = await this.resolveCustomerId(user);
    const addresses = await this.addressRepo.findAllByCustomerId(customerId);
    return addresses.map((addr) => CustomerAddressResponseDto.fromEntity(addr));
  }

  async getAddressById(user: any, addressIdStr: string): Promise<CustomerAddressResponseDto> {
    const customerId = await this.resolveCustomerId(user);
    let addressId: bigint;
    try {
      addressId = BigInt(addressIdStr);
    } catch {
      throw new BadRequestException('ID địa chỉ không hợp lệ');
    }

    const address = await this.addressRepo.findByCustomerAndId(customerId, addressId);
    if (!address) {
      throw new NotFoundException('Không tìm thấy địa chỉ hoặc bạn không có quyền truy cập');
    }

    return CustomerAddressResponseDto.fromEntity(address);
  }

  async createAddress(
    user: any,
    dto: CreateCustomerAddressDto,
  ): Promise<CustomerAddressResponseDto> {
    const customerId = await this.resolveCustomerId(user);
    const address = await this.addressRepo.createAddressTx(customerId, dto);
    return CustomerAddressResponseDto.fromEntity(address);
  }

  async updateAddress(
    user: any,
    addressIdStr: string,
    dto: UpdateCustomerAddressDto,
  ): Promise<CustomerAddressResponseDto> {
    const customerId = await this.resolveCustomerId(user);
    let addressId: bigint;
    try {
      addressId = BigInt(addressIdStr);
    } catch {
      throw new BadRequestException('ID địa chỉ không hợp lệ');
    }

    const existing = await this.addressRepo.findByCustomerAndId(customerId, addressId);
    if (!existing) {
      throw new NotFoundException('Không tìm thấy địa chỉ hoặc bạn không có quyền truy cập');
    }

    const updated = await this.addressRepo.updateAddressTx(customerId, addressId, dto);
    return CustomerAddressResponseDto.fromEntity(updated);
  }

  async deleteAddress(user: any, addressIdStr: string): Promise<void> {
    const customerId = await this.resolveCustomerId(user);
    let addressId: bigint;
    try {
      addressId = BigInt(addressIdStr);
    } catch {
      throw new BadRequestException('ID địa chỉ không hợp lệ');
    }

    const existing = await this.addressRepo.findByCustomerAndId(customerId, addressId);
    if (!existing) {
      throw new NotFoundException('Không tìm thấy địa chỉ hoặc bạn không có quyền truy cập');
    }

    // Check if address is currently bound to any IoT button
    const deviceCount = await this.addressRepo.countIoTButtonsByAddress(customerId, addressId);
    if (deviceCount > 0) {
      throw new BadRequestException({
        statusCode: 400,
        errorCode: 'ADDRESS_IN_USE_BY_DEVICE',
        message: 'Không thể xóa địa chỉ đang được gán cho thiết bị IoT',
      });
    }

    await this.addressRepo.deleteAddress(customerId, addressId);
  }
}

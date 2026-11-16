import { IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class QuickReorderDto {
  @ApiProperty({ description: 'Mã định danh nút bấm (buttonCode hoặc deviceUid)', example: 'SOB-000003' })
  @Transform(({ value }) => (value !== undefined && value !== null ? String(value).trim() : value))
  @IsString({ message: 'Mã thiết bị (deviceId) phải là chuỗi' })
  deviceId: string;

  @ApiProperty({ description: 'ID địa chỉ giao hàng của khách hàng (bắt buộc trên mobile)', example: '42' })
  @IsOptional()
  @Transform(({ value }) => (value !== undefined && value !== null ? String(value).trim() : value))
  @IsString({ message: 'ID địa chỉ giao hàng (addressId) phải là chuỗi' })
  addressId?: string;
}

import { IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({ description: 'Khóa idempotency chống đặt đơn trùng khi bấm đúp hoặc retry mạng', example: 'app-req-12345' })
  @IsOptional()
  @Transform(({ value }) => (value !== undefined && value !== null ? String(value).trim() : value))
  @IsString({ message: 'idempotencyKey phải là chuỗi' })
  @MaxLength(128, { message: 'idempotencyKey tối đa 128 ký tự' })
  @Matches(/^[A-Za-z0-9._:-]+$/, { message: 'idempotencyKey chỉ được chứa chữ cái, chữ số và . _ : -' })
  idempotencyKey?: string;
}

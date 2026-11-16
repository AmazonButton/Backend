import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RenewSubscriptionChargeDto {
  @ApiProperty({ description: 'Mã định danh gói dịch vụ gian hàng (planId)', example: 1 })
  @IsNotEmpty({ message: 'Mã gói dịch vụ (planId) là bắt buộc' })
  planId: number | string;

  @ApiPropertyOptional({ description: 'URL điều hướng về khi người dùng thanh toán thành công' })
  @IsOptional()
  @IsString({ message: 'returnUrl phải là chuỗi ký tự hợp lệ' })
  returnUrl?: string;

  @ApiPropertyOptional({ description: 'URL điều hướng về khi người dùng hủy giao dịch PayOS' })
  @IsOptional()
  @IsString({ message: 'cancelUrl phải là chuỗi ký tự hợp lệ' })
  cancelUrl?: string;
}

import { IsOptional, IsString, IsEmail, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateAdminStoreDto {
  @ApiPropertyOptional({ description: 'Tên hiển thị cửa hàng', example: 'Cửa Hàng Tiện Lợi Quận 1' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'Email liên hệ của cửa hàng', example: 'store.q1@domain.com' })
  @IsOptional()
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  email?: string;

  @ApiPropertyOptional({ description: 'Số điện thoại liên hệ cửa hàng', example: '0987654321' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ description: 'Địa chỉ cửa hàng', example: '123 Nguyễn Huệ, Phường Bến Nghé, Quận 1' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ description: 'Trạng thái hoạt động của cửa hàng (ACTIVE, INACTIVE, SUSPENDED)', example: 'ACTIVE' })
  @IsOptional()
  @IsString()
  status?: string;
}

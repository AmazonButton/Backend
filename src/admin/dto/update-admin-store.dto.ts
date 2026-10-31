import { IsOptional, IsString, IsEmail, MaxLength, MinLength, Matches, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateAdminStoreDto {
  @ApiPropertyOptional({ description: 'Tên hiển thị cửa hàng', example: 'Cửa Hàng Tiện Lợi Quận 1' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Tên cửa hàng không được để trống' })
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'Email liên hệ của cửa hàng', example: 'store.q1@domain.com' })
  @IsOptional()
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  email?: string;

  @ApiPropertyOptional({ description: 'Số điện thoại liên hệ cửa hàng', example: '0987654321' })
  @IsOptional()
  @Matches(/^[0-9]{10,11}$/, { message: 'Số điện thoại phải gồm 10 đến 11 chữ số' })
  phone?: string;

  @ApiPropertyOptional({ description: 'Địa chỉ cửa hàng', example: '123 Nguyễn Huệ, Phường Bến Nghé, Quận 1' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ description: 'Trạng thái hoạt động của cửa hàng (ACTIVE, INACTIVE, SUSPENDED)', example: 'ACTIVE' })
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'SUSPENDED'], { message: 'Trạng thái phải là ACTIVE, INACTIVE hoặc SUSPENDED' })
  status?: string;
}

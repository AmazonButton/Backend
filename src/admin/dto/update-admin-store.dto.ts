import { IsOptional, IsString, IsEmail, MaxLength, MinLength, Matches, IsIn, IsNumber, Min, Max, ValidateIf, IsUrl } from 'class-validator';
import { Transform, Type } from 'class-transformer';
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

  @ApiPropertyOptional({ description: 'Vĩ độ cửa hàng (latitude)', example: 10.776889 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Vĩ độ (latitude) phải là số' })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ description: 'Kinh độ cửa hàng (longitude)', example: 106.700806 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Kinh độ (longitude) phải là số' })
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiPropertyOptional({ description: 'URL logo cửa hàng', example: 'https://res.cloudinary.com/.../logo.png' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: 'logoUrl phải là đường dẫn URL hợp lệ (http hoặc https)' },
  )
  @MaxLength(512)
  logoUrl?: string | null;

  @ApiPropertyOptional({ description: 'Trạng thái hoạt động của cửa hàng (ACTIVE, INACTIVE, SUSPENDED)', example: 'ACTIVE' })
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'SUSPENDED'], { message: 'Trạng thái phải là ACTIVE, INACTIVE hoặc SUSPENDED' })
  status?: string;
}

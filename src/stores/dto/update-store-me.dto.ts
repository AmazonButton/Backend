import { IsOptional, IsString, IsEmail, IsNumber, Min, Max, ValidateIf, IsUrl, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateStoreMeDto {
  @IsOptional()
  @IsString({ message: 'Tên cửa hàng phải là chuỗi' })
  name?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Email không đúng định dạng' })
  email?: string;

  @IsOptional()
  @IsString({ message: 'Số điện thoại phải là chuỗi' })
  phone?: string;

  @IsOptional()
  @IsString({ message: 'Địa chỉ phải là chuỗi' })
  address?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: 'logoUrl phải là một đường dẫn URL hợp lệ (http hoặc https)' },
  )
  @MaxLength(512, { message: 'logoUrl không được vượt quá 512 ký tự' })
  logoUrl?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Vĩ độ (latitude) phải là số' })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Kinh độ (longitude) phải là số' })
  @Min(-180)
  @Max(180)
  longitude?: number;
}

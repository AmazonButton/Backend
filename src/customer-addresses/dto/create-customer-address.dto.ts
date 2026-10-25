import { IsNotEmpty, IsString, IsOptional, IsBoolean, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCustomerAddressDto {
  @IsNotEmpty({ message: 'Tên người nhận không được để trống' })
  @IsString({ message: 'Tên người nhận phải là chuỗi ký tự' })
  recipientName: string;

  @IsNotEmpty({ message: 'Số điện thoại không được để trống' })
  @IsString({ message: 'Số điện thoại phải là chuỗi ký tự' })
  phone: string;

  @IsNotEmpty({ message: 'Địa chỉ chi tiết không được để trống' })
  @IsString({ message: 'Địa chỉ chi tiết phải là chuỗi ký tự' })
  addressDetail: string;

  @IsOptional()
  @IsString({ message: 'Phường/Xã phải là chuỗi ký tự' })
  ward?: string;

  @IsOptional()
  @IsString({ message: 'Quận/Huyện phải là chuỗi ký tự' })
  district?: string;

  @IsOptional()
  @IsString({ message: 'Tỉnh/Thành phố phải là chuỗi ký tự' })
  province?: string;

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

  @IsOptional()
  @IsBoolean({ message: 'isDefault phải là boolean' })
  isDefault?: boolean;
}

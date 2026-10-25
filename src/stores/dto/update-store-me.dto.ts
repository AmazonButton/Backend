import { IsOptional, IsString, IsEmail } from 'class-validator';

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
}

import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateVerificationRequestDto {
  @ApiProperty({
    description: 'Mã định danh Store',
    example: '1',
  })
  @IsNotEmpty({ message: 'Mã storeId không được để trống' })
  @IsString({ message: 'Mã storeId phải là chuỗi' })
  @Matches(/^[1-9]\d*$/, { message: 'Mã storeId phải là số nguyên dương' })
  storeId: string;

  @ApiProperty({
    description: 'Mã BIN ngân hàng (6 chữ số)',
    example: '970422',
  })
  @IsNotEmpty({ message: 'Mã BIN ngân hàng không được để trống' })
  @IsString({ message: 'Mã BIN ngân hàng phải là chuỗi' })
  @Matches(/^[0-9]{6}$/, { message: 'Mã BIN ngân hàng phải gồm đúng 6 chữ số' })
  bankBin: string;

  @ApiProperty({
    description: 'Số tài khoản ngân hàng',
    example: '0339898989',
  })
  @IsNotEmpty({ message: 'Số tài khoản không được để trống' })
  @IsString({ message: 'Số tài khoản phải là chuỗi' })
  @Matches(/^[0-9]{6,19}$/, { message: 'Số tài khoản ngân hàng phải gồm từ 6 đến 19 chữ số' })
  accountNumber: string;

  @ApiPropertyOptional({
    description: 'Tên chủ tài khoản ngân hàng (tự nhập khi tra cứu tự động không khả dụng)',
    example: 'NGUYEN VAN A',
  })
  @IsOptional()
  @IsString({ message: 'Tên chủ tài khoản phải là chuỗi' })
  accountName?: string;
}

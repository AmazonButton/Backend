import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LookupBankAccountDto {
  @ApiProperty({
    description: 'Mã BIN ngân hàng (6 chữ số)',
    example: '970422',
  })
  @IsNotEmpty({ message: 'Mã BIN ngân hàng không được để trống' })
  @IsString({ message: 'Mã BIN ngân hàng phải là chuỗi' })
  @Matches(/^[0-9]{6}$/, { message: 'Mã BIN ngân hàng phải gồm đúng 6 chữ số' })
  bankBin: string;

  @ApiProperty({
    description: 'Số tài khoản ngân hàng (6–19 chữ số, chỉ chứa số)',
    example: '0339898989',
  })
  @IsNotEmpty({ message: 'Số tài khoản không được để trống' })
  @IsString({ message: 'Số tài khoản phải là chuỗi' })
  // Issue 4 Fix: VietQR docs specify account numbers are 6-19 digits only (no alphanumeric).
  // Leading zeros must be preserved (kept as string). Min/MaxLength decorators removed in favor of Matches.
  @Matches(/^[0-9]{6,19}$/, { message: 'Số tài khoản chỉ chứa chữ số và phải từ 6 đến 19 ký tự' })
  accountNumber: string;
}

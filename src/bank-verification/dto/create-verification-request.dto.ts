import {
  IsNotEmpty,
  IsString,
  Matches,
  MinLength,
  MaxLength,
} from 'class-validator';

export class CreateVerificationRequestDto {
  @IsNotEmpty({ message: 'Mã storeId không được để trống' })
  @IsString({ message: 'Mã storeId phải là chuỗi' })
  @Matches(/^[1-9]\d*$/, { message: 'Mã storeId phải là số nguyên dương' })
  storeId: string;

  @IsNotEmpty({ message: 'Mã BIN ngân hàng không được để trống' })
  @IsString({ message: 'Mã BIN ngân hàng phải là chuỗi' })
  @Matches(/^[0-9]{6}$/, { message: 'Mã BIN ngân hàng phải gồm đúng 6 chữ số' })
  bankBin: string;

  @IsNotEmpty({ message: 'Số tài khoản không được để trống' })
  @IsString({ message: 'Số tài khoản phải là chuỗi' })
  @MinLength(5, { message: 'Số tài khoản tối thiểu 5 ký tự' })
  @MaxLength(30, { message: 'Số tài khoản tối đa 30 ký tự' })
  @Matches(/^[0-9a-zA-Z]+$/, { message: 'Số tài khoản chỉ chứa chữ và số' })
  accountNumber: string;
}

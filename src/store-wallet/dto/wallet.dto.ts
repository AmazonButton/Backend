import { IsNotEmpty, IsString, IsOptional, IsNumberString, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class UpdateBankAccountDto {
  @IsString()
  @Matches(/^[0-9]{6}$/, { message: 'Mã BIN ngân hàng phải gồm 6 chữ số' })
  bankBin: string;

  @IsString()
  @IsNotEmpty()
  bankName: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9]{6,19}$/, { message: 'Số tài khoản phải gồm 6–19 chữ số' })
  bankAccountNumber: string;

  @IsString()
  @IsNotEmpty()
  bankAccountHolder: string;
}

export class StoreQueryDto {
  @IsOptional()
  @IsNumberString({}, { message: 'storeId query parameter must be a numeric string' })
  storeId?: string;
}

export class TransactionQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsNumberString({}, { message: 'storeId query parameter must be a numeric string' })
  storeId?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;
}

export class WithdrawalQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsNumberString({}, { message: 'storeId query parameter must be a numeric string' })
  storeId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;
}

import { IsNotEmpty, IsString, IsOptional, IsNumberString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class UpdateBankAccountDto {
  @IsString()
  @IsNotEmpty()
  bankName: string;

  @IsString()
  @IsNotEmpty()
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

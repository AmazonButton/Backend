import { IsNotEmpty, IsString, IsOptional, IsNumberString } from 'class-validator';

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

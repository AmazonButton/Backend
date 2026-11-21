import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class InitiatePaymentRefundPayoutDto {
  @IsOptional()
  @Matches(/^\d+$/, { message: 'customerBankAccountId phải là số hợp lệ' })
  customerBankAccountId?: string;

  @IsOptional()
  @IsString({ message: 'note phải là chuỗi' })
  @MaxLength(500, { message: 'note tối đa 500 ký tự' })
  note?: string;
}

export class AdminListPaymentRefundObligationsQueryDto {
  @IsOptional()
  @Matches(/^\d+$/, { message: 'page phải là số nguyên dương' })
  page?: string;

  @IsOptional()
  @Matches(/^\d+$/, { message: 'pageSize phải là số nguyên dương' })
  pageSize?: string;

  @IsOptional()
  @IsString({ message: 'status phải là chuỗi' })
  status?: string;

  @IsOptional()
  @Matches(/^\d+$/, { message: 'orderId phải là số hợp lệ' })
  orderId?: string;
}

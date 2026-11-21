import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class RefundExcessPaymentDto {
  @IsOptional()
  @Matches(/^\d+$/, { message: 'obligationId phải là số hợp lệ' })
  obligationId?: string;

  @IsOptional()
  @Matches(/^\d+$/, { message: 'customerBankAccountId phải là số hợp lệ' })
  customerBankAccountId?: string;

  @IsOptional()
  @IsString({ message: 'refundReference phải là chuỗi' })
  @MaxLength(100, { message: 'refundReference tối đa 100 ký tự' })
  refundReference?: string;

  @IsOptional()
  @IsString({ message: 'adminNote phải là chuỗi' })
  @MaxLength(500, { message: 'adminNote tối đa 500 ký tự' })
  adminNote?: string;
}

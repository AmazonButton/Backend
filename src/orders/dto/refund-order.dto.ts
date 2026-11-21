import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class RefundOrderDto {
  @IsOptional()
  @Matches(/^\d+$/, { message: 'customerBankAccountId phải là số hợp lệ' })
  customerBankAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  refundReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  adminNote?: string;
}

import { IsNotEmpty, IsInt, IsString, Min, IsOptional } from 'class-validator';

export class RequestWithdrawalDto {
  @IsInt({ message: 'Số tiền rút phải là số nguyên VND' })
  @Min(50000, { message: 'Số tiền rút tối thiểu là 50,000 VND' })
  amount: number;

  @IsString()
  @IsOptional()
  bankAccountId?: string;

  @IsString()
  @IsOptional()
  bankCode?: string; // Mã BIN ngân hàng (ví dụ: 970422 cho MBBank)

  @IsString()
  @IsOptional()
  bankName?: string;

  @IsString()
  @IsOptional()
  bankAccountNumber?: string;

  @IsString()
  @IsOptional()
  bankAccountHolder?: string;
}

export class ConfirmTransferDto {
  @IsString()
  @IsOptional()
  transferEvidenceUrl?: string;
}

export class RejectWithdrawalDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}

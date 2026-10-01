import { IsNotEmpty, IsNumber, IsString, Min, IsOptional } from 'class-validator';

export class RequestWithdrawalDto {
  @IsNumber()
  @Min(50000, { message: 'Số tiền rút tối thiểu là 50,000 VND' })
  amount: number;

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

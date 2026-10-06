import { IsNotEmpty, IsNumber, IsString, Min, IsOptional } from 'class-validator';

export class RequestWithdrawalDto {
  @IsNumber()
  @Min(50000, { message: 'S? ti?n rút t?i thi?u là 50,000 VND' })
  amount: number;

  @IsString()
  @IsOptional()
  bankCode?: string; // Mã BIN ngân hàng (ví d?: 970422 cho MBBank)

  @IsString()
  @IsNotEmpty()
  bankName: string;

  @IsString()
  @IsNotEmpty()
  bankAccountNumber: string;

  @IsString()
  @IsNotEmpty()
  bankAccountHolder: string;

  @IsNumber()
  @IsOptional()
  fee?: number;
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

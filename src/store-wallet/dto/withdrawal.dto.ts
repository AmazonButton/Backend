import { IsNotEmpty, IsNumber, IsString, Min, IsOptional } from 'class-validator';

export class RequestWithdrawalDto {
  @IsNumber()
  @Min(50000, { message: 'S? ti?n r�t t?i thi?u l� 50,000 VND' })
  amount: number;

  @IsString()
  @IsOptional()
  bankCode?: string; // M� BIN ng�n h�ng (v� d?: 970422 cho MBBank)

  @IsString()
  @IsOptional()
  bankName?: string;

  @IsString()
  @IsOptional()
  bankAccountNumber?: string;

  @IsString()
  @IsOptional()
  bankAccountHolder?: string;

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

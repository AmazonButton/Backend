import { IsOptional, IsString, IsNumber } from 'class-validator';

export class BankVerificationWebhookDto {
  @IsOptional()
  @IsString()
  providerTransactionId?: string;

  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsString()
  referenceCode?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  accountNumber?: string;

  @IsOptional()
  @IsString()
  destinationAccountNumber?: string;

  @IsOptional()
  @IsString()
  destinationBankBin?: string;

  @IsOptional()
  @IsString()
  senderAccountNumber?: string;

  @IsOptional()
  @IsString()
  counterAccountNumber?: string;

  @IsOptional()
  @IsString()
  senderBankBin?: string;

  @IsOptional()
  @IsString()
  counterBankBin?: string;

  @IsOptional()
  @IsString()
  counterAccountBankId?: string;

  @IsOptional()
  code?: string | number;

  @IsOptional()
  desc?: string;

  @IsOptional()
  data?: any;

  @IsOptional()
  signature?: string;
}

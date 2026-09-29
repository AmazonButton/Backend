import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreatePaymentLinkDto {
  @IsNotEmpty({ message: 'orderId không được để trống' })
  orderId: string | number;

  @IsOptional()
  @IsNumber({}, { message: 'amount phải là số' })
  @Min(1000, { message: 'Số tiền thanh toán tối thiểu là 1,000 VND' })
  amount?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  returnUrl?: string;

  @IsOptional()
  @IsString()
  cancelUrl?: string;
}

export class PayosWebhookDto {
  @IsString()
  code: string;

  @IsNotEmpty()
  desc: string;

  @IsNotEmpty()
  data: any;

  @IsNotEmpty()
  signature: string;
}

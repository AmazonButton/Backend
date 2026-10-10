import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Min, Matches, IsUrl } from 'class-validator';

export class CreatePaymentLinkDto {
  @IsNotEmpty({ message: 'orderId không được để trống' })
  @Matches(/^\d+$/, { message: 'orderId phải là số' })
  orderId: string | number;

  @IsOptional()
  @IsNumber({}, { message: 'amount phải là số' })
  @Min(1000, { message: 'Số tiền thanh toán tối thiểu là 1,000 VND' })
  amount?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: 'returnUrl phải là URL hợp lệ' })
  @Matches(/^(http:\/\/localhost(:\d+)?|http:\/\/127\.0\.0\.1(:\d+)?|https:\/\/.*smartorder\.vn)(\/.*)?$/, {
    message: 'returnUrl phải thuộc domain được phép (localhost hoặc smartorder.vn)',
  })
  returnUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: 'cancelUrl phải là URL hợp lệ' })
  @Matches(/^(http:\/\/localhost(:\d+)?|http:\/\/127\.0\.0\.1(:\d+)?|https:\/\/.*smartorder\.vn)(\/.*)?$/, {
    message: 'cancelUrl phải thuộc domain được phép (localhost hoặc smartorder.vn)',
  })
  cancelUrl?: string;
}

export class PayosWebhookDto {
  @IsString()
  code: string;

  @IsNotEmpty()
  desc: string;

  @IsOptional()
  @IsBoolean()
  success?: boolean;

  @IsNotEmpty()
  data: any;

  @IsNotEmpty()
  signature: string;
}

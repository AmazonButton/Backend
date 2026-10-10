import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Matches,
  IsUrl,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

@ValidatorConstraint({ name: 'isAllowedPaymentRedirectUrl', async: false })
export class IsAllowedPaymentRedirectUrlConstraint implements ValidatorConstraintInterface {
  validate(value: any, args: ValidationArguments) {
    if (!value || typeof value !== 'string') return true;
    try {
      const parsed = new URL(value);
      const hostname = parsed.hostname.toLowerCase();
      const isProd = process.env.NODE_ENV === 'production';

      // Enforce HTTPS and exact smartorder.vn or *.smartorder.vn
      if (parsed.protocol === 'https:' && (hostname === 'smartorder.vn' || hostname.endsWith('.smartorder.vn'))) {
        return true;
      }

      // In non-production only: allow localhost or 127.0.0.1
      if (!isProd && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  defaultMessage(args: ValidationArguments) {
    return `${args.property} phải thuộc domain được phép (smartorder.vn hoặc subdomain an toàn)`;
  }
}

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
  @Validate(IsAllowedPaymentRedirectUrlConstraint)
  returnUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false }, { message: 'cancelUrl phải là URL hợp lệ' })
  @Validate(IsAllowedPaymentRedirectUrlConstraint)
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

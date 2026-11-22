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

export function isAllowedPaymentRedirectUrl(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!value || typeof value !== 'string') return true;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    const isProd = env.NODE_ENV === 'production';

    if (parsed.protocol === 'https:') {
      if (hostname === 'smartorder.vn' || hostname.endsWith('.smartorder.vn')) {
        return true;
      }

      const configuredUrls = [
        env.FRONTEND_URL,
        env.PAYOS_RETURN_URL,
        env.PAYOS_CANCEL_URL,
        ...(env.PAYOS_ALLOWED_RETURN_ORIGINS || '').split(','),
        ...(env.PAYOS_STORE_BANK_ALLOWED_RETURN_ORIGINS || '').split(','),
        ...(env.CORS_ORIGIN || '').split(','),
      ];
      for (const candidate of configuredUrls) {
        const trimmed = candidate?.trim();
        if (!trimmed) continue;
        try {
          const allowedUrl = new URL(trimmed);
          if (allowedUrl.protocol === 'https:' && parsed.origin === allowedUrl.origin) {
            return true;
          }
        } catch {
          // Ignore malformed optional env entries
        }
      }
    }

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

@ValidatorConstraint({ name: 'isAllowedPaymentRedirectUrl', async: false })
export class IsAllowedPaymentRedirectUrlConstraint implements ValidatorConstraintInterface {
  validate(value: any, _args: ValidationArguments) {
    return isAllowedPaymentRedirectUrl(value, process.env);
  }

  defaultMessage(args: ValidationArguments) {
    return `${args.property} phải thuộc domain được phép (HTTPS frontend cấu hình hoặc smartorder.vn)`;
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
  @IsOptional()
  @IsString()
  webhookUrl?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  desc?: string;

  @IsOptional()
  @IsBoolean({ message: 'Trường success bắt buộc phải là boolean' })
  success?: boolean;

  @IsOptional()
  data?: any;

  @IsOptional()
  @IsString()
  signature?: string;
}

export class CancelPaymentLinkDto {
  @IsOptional()
  @IsString()
  cancellationReason?: string;
}

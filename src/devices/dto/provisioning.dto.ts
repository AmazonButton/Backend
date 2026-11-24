import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  POSTGRES_BIGINT_MAX,
  parsePositivePostgresBigInt,
} from '../../common/utils/validation.util';

@ValidatorConstraint({ name: 'isPositiveBigIntId', async: false })
export class IsPositiveBigIntIdConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return false;
    }
    return parsePositivePostgresBigInt(value) !== null;
  }

  defaultMessage(): string {
    return `productId phải là mã số nguyên dương BIGINT hợp lệ (1..${POSTGRES_BIGINT_MAX.toString()})`;
  }
}

export class CreateSessionDto {
  @IsOptional()
  @IsString()
  qrPayload?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsString()
  code?: string;
}

export class VerifySessionDto {
  @IsString()
  sessionId: string;
}

export class DeviceBootstrapDto {
  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  firmwareVersion?: string;

  @IsOptional()
  @IsString()
  hardwareVersion?: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;

  @IsOptional()
  @IsString()
  macAddress?: string;

  @IsOptional()
  batteryVoltage?: string | number;

  @IsOptional()
  batteryLevel?: number;

  @IsOptional()
  wifiRssi?: number;

  @IsOptional()
  rssi?: number;

  @IsOptional()
  @IsString()
  wifiSsid?: string;

  @IsOptional()
  @IsString()
  ssid?: string;

  @IsOptional()
  uptime?: number;

  @IsOptional()
  @IsString()
  status?: string;
}

export class ClaimDeviceDto {
  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buttonName?: string;

  @IsOptional()
  @IsString()
  customName?: string;

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  quantity?: number;
}

export class ChangeWifiDto {
  @IsOptional()
  @IsString()
  ssid?: string;

  @IsOptional()
  @IsString()
  password?: string;
}

export class ConfirmPairingDto {
  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buttonName?: string;

  @IsOptional()
  @IsString()
  customName?: string;

  @IsNotEmpty({ message: 'productId là bắt buộc' })
  @Validate(IsPositiveBigIntIdConstraint)
  productId: string | number;

  @IsOptional()
  quantity?: number;

  @IsOptional()
  addressId?: string | number;
}

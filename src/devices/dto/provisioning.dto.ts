import { IsString, IsOptional, MaxLength } from 'class-validator';

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

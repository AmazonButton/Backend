import { IsNotEmpty, IsString, MaxLength, Matches, IsOptional, IsEnum, IsNumber, Min, Max } from 'class-validator';

export enum IotEventType {
  SINGLE_PRESS = 'SINGLE_PRESS',
  DOUBLE_PRESS = 'DOUBLE_PRESS',
  LONG_PRESS = 'LONG_PRESS',
  HEARTBEAT = 'HEARTBEAT',
  CANCEL = 'CANCEL',
}

export enum IotPaymentMethod {
  COD = 'COD',
  PAYOS = 'PAYOS',
}

export class IotEventDto {
  @IsNotEmpty({ message: 'Thiếu trường requestId' })
  @IsString({ message: 'requestId phải là chuỗi ký tự' })
  @MaxLength(128, { message: 'requestId không được vượt quá 128 ký tự' })
  @Matches(/^[a-zA-Z0-9_\-\.:]+$/, { message: 'requestId chứa ký tự không hợp lệ' })
  requestId: string;

  @IsOptional()
  @IsEnum(IotEventType, { message: 'eventType không hợp lệ' })
  eventType?: IotEventType;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsNumber({}, { message: 'battery phải là số' })
  @Min(0, { message: 'battery tối thiểu 0%' })
  @Max(100, { message: 'battery tối đa 100%' })
  battery?: number;

  @IsOptional()
  @IsNumber({}, { message: 'rssi phải là số' })
  @Min(-150, { message: 'rssi không hợp lệ' })
  @Max(0, { message: 'rssi không hợp lệ' })
  rssi?: number;

  @IsOptional()
  @IsEnum(IotPaymentMethod, { message: 'paymentMethod chỉ chấp nhận COD hoặc PAYOS' })
  paymentMethod?: IotPaymentMethod;

  @IsOptional()
  @IsNumber({}, { message: 'shippingFee phải là số' })
  @Min(0, { message: 'shippingFee không được âm' })
  shippingFee?: number;
}

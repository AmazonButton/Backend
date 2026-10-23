import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  IsIn,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  Length,
} from 'class-validator';

export const ALLOWED_LONG_PRESS_ACTIONS = [
  'WIFI_CONFIGURATION',
  'ORDER_PRODUCT',
  'NONE',
] as const;

export type LongPressActionType = (typeof ALLOWED_LONG_PRESS_ACTIONS)[number];

export class CreateDeviceTemplateDto {
  @IsNotEmpty({ message: 'Tên template không được để trống' })
  @IsString({ message: 'Tên template phải là chuỗi ký tự' })
  name: string;

  @IsOptional()
  @IsString({ message: 'Mô tả phải là chuỗi ký tự' })
  description?: string;

  @IsOptional()
  @IsString({ message: 'Danh mục phải là chuỗi ký tự' })
  category?: string;

  @IsOptional()
  storeId?: string | number | bigint;

  @IsOptional()
  defaultProductId?: string | number | bigint;

  @IsOptional()
  @IsString()
  singlePressAction?: string;

  @IsOptional()
  @IsString()
  doublePressAction?: string;

  @IsOptional()
  @IsString()
  @IsIn([...ALLOWED_LONG_PRESS_ACTIONS], {
    message: `longPressAction phải là một trong: ${ALLOWED_LONG_PRESS_ACTIONS.join(', ')}`,
  })
  longPressAction?: string;

  @IsOptional()
  @IsInt({ message: 'defaultQuantity phải là số nguyên' })
  @Min(1, { message: 'defaultQuantity tối thiểu là 1' })
  @Max(100, { message: 'defaultQuantity tối đa là 100' })
  defaultQuantity?: number;

  @IsOptional()
  @IsInt({ message: 'cancelWindowSeconds phải là số nguyên' })
  @Min(0, { message: 'cancelWindowSeconds tối thiểu là 0' })
  @Max(3600, { message: 'cancelWindowSeconds tối đa là 3600 giây (1 giờ)' })
  cancelWindowSeconds?: number;
}

export class UpdateDeviceTemplateDto {
  @IsOptional()
  @IsString({ message: 'Tên template phải là chuỗi ký tự' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'Mô tả phải là chuỗi ký tự' })
  description?: string;

  @IsOptional()
  @IsString({ message: 'Danh mục phải là chuỗi ký tự' })
  category?: string;

  @IsOptional()
  defaultProductId?: string | number | bigint;

  @IsOptional()
  @IsString()
  singlePressAction?: string;

  @IsOptional()
  @IsString()
  doublePressAction?: string;

  @IsOptional()
  @IsString()
  @IsIn([...ALLOWED_LONG_PRESS_ACTIONS], {
    message: `longPressAction phải là một trong: ${ALLOWED_LONG_PRESS_ACTIONS.join(', ')}`,
  })
  longPressAction?: string;

  @IsOptional()
  @IsInt({ message: 'defaultQuantity phải là số nguyên' })
  @Min(1, { message: 'defaultQuantity tối thiểu là 1' })
  @Max(100, { message: 'defaultQuantity tối đa là 100' })
  defaultQuantity?: number;

  @IsOptional()
  @IsInt({ message: 'cancelWindowSeconds phải là số nguyên' })
  @Min(0, { message: 'cancelWindowSeconds tối thiểu là 0' })
  @Max(3600, { message: 'cancelWindowSeconds tối đa là 3600 giây (1 giờ)' })
  cancelWindowSeconds?: number;
}

export class DeployDeviceTemplateDto {
  // Mode 1: Đơn lẻ 1 thiết bị
  @IsOptional()
  @IsString({ message: 'deviceId phải là chuỗi ký tự' })
  deviceId?: string;

  // Mode 2: Danh sách nhiều thiết bị (tối đa 100)
  @IsOptional()
  @IsArray({ message: 'deviceIds phải là mảng chuỗi' })
  @ArrayMinSize(1, { message: 'deviceIds tối thiểu 1 phần tử' })
  @ArrayMaxSize(100, { message: 'deviceIds tối đa 100 phần tử' })
  @IsString({ each: true, message: 'Mỗi mã thiết bị trong deviceIds phải là chuỗi' })
  deviceIds?: string[];

  // Mode 3: Triển khai theo dải mã (prefix + startRange + endRange + padLength)
  @IsOptional()
  @IsString({ message: 'prefix phải là chuỗi ký tự' })
  @Length(1, 20, { message: 'prefix có độ dài từ 1 đến 20 ký tự' })
  prefix?: string;

  @IsOptional()
  @IsInt({ message: 'startRange phải là số nguyên' })
  @Min(1, { message: 'startRange tối thiểu là 1' })
  startRange?: number;

  @IsOptional()
  @IsInt({ message: 'endRange phải là số nguyên' })
  @Min(1, { message: 'endRange tối thiểu là 1' })
  endRange?: number;

  @IsOptional()
  @IsInt({ message: 'padLength phải là số nguyên' })
  @Min(1, { message: 'padLength tối thiểu là 1' })
  @Max(8, { message: 'padLength tối đa là 8' })
  padLength?: number;

  // Khóa chống lặp thao tác bulk
  @IsOptional()
  @IsString()
  @Length(1, 128)
  idempotencyKey?: string;
}

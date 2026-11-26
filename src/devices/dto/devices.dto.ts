import {
  IsIn,
  IsInt,
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  Min,
  Max,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  IsNotEmpty,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BulkImportItemDto {
  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  buttonCode?: string;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  productSku?: string;

  @IsOptional()
  @IsString()
  customName?: string;

  @IsOptional()
  @IsString()
  buttonName?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  macAddress?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  productId?: string | number;

  @IsOptional()
  storeId?: string | number;
}

export class RegisterDeviceDto {
  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  buttonCode?: string;

  @IsOptional()
  @IsString()
  macAddress?: string;

  @IsOptional()
  storeId?: string | number;

  @IsOptional()
  productId?: string | number;

  @IsOptional()
  customerId?: string | number;

  @IsOptional()
  @IsString()
  buttonName?: string;

  @IsOptional()
  @IsString()
  customName?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;
}

export class BulkImportDevicesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BulkImportItemDto)
  rows: BulkImportItemDto[];

  @IsOptional()
  @IsString()
  storeId?: string;
}

export class BatchGenerateDevicesDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  count?: number;

  @IsOptional()
  @IsString()
  prefix?: string;

  @IsOptional()
  @IsString()
  model?: string;
}

export class AssignProductDto {
  @IsNotEmpty()
  productId: string | number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsString()
  customName?: string;
}

export class CustomerUpdateConfigDto {
  @IsOptional()
  storeId?: string | number;

  @IsOptional()
  @IsString()
  buttonName?: string;

  @IsOptional()
  productId?: string | number;

  @IsOptional()
  addressId?: string | number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;
}

export class BleClaimDeviceDto {
  @IsOptional()
  @IsBoolean({ message: 'bleConnected phải là boolean' })
  bleConnected?: boolean;

  @IsOptional()
  @IsString()
  buttonName?: string;

  @IsOptional()
  addressId?: string | number;
}

export class AllocateStoreDto {
  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsString()
  targetStoreId?: string;

  @IsArray()
  @IsString({ each: true })
  deviceIds: string[];

  @IsOptional()
  @IsString()
  productId?: string;
}

export class LookupCodeDto {
  @IsString()
  @IsNotEmpty()
  code: string;
}

export class ConfigureByCodeDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  productId?: string | number;

  @IsOptional()
  storeId?: string | number;

  @IsOptional()
  @IsString()
  customName?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;
}

export class UpdateDeviceDto {
  @IsOptional()
  @IsString()
  buttonName?: string;

  @IsOptional()
  @IsString()
  customName?: string;

  @IsOptional()
  @IsString()
  @IsIn(['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'RETIRED', 'DISABLED'], {
    message: 'Trạng thái phải là một trong: ACTIVE, INACTIVE, MAINTENANCE, RETIRED, DISABLED',
  })
  status?: string;

  @IsOptional()
  @IsInt({ message: 'holdDurationMs phải là số nguyên mili-giây' })
  @Min(500, { message: 'holdDurationMs tối thiểu là 500ms' })
  @Max(10000, { message: 'holdDurationMs tối đa là 10.000ms' })
  holdDurationMs?: number;

  @IsOptional()
  @IsBoolean({ message: 'canOrder phải là giá trị boolean (true/false)' })
  canOrder?: boolean;

  @IsOptional()
  @IsInt({ message: 'cancelWindowSeconds phải là số nguyên giây' })
  @Min(0, { message: 'cancelWindowSeconds tối thiểu là 0' })
  @Max(3600, { message: 'cancelWindowSeconds tối đa là 3.600 giây' })
  cancelWindowSeconds?: number;

  @IsOptional()
  @IsInt({ message: 'batteryLevel phải là số nguyên' })
  @Min(0, { message: 'batteryLevel tối thiểu là 0' })
  @Max(100, { message: 'batteryLevel tối đa là 100' })
  batteryLevel?: number;

  @IsOptional()
  @IsDateString({}, { message: 'warrantyUntil phải là chuỗi ngày hợp lệ (ISO 8601)' })
  warrantyUntil?: string;

  @IsOptional()
  @IsString({ message: 'location phải là chuỗi ký tự' })
  location?: string;

  @IsOptional()
  @IsString({ message: 'description phải là chuỗi ký tự' })
  description?: string;

  @IsOptional()
  productId?: string | number;

  @IsOptional()
  @IsNumber({}, { message: 'quantity phải là số' })
  @Min(1, { message: 'quantity tối thiểu là 1' })
  @Max(100, { message: 'quantity tối đa là 100' })
  quantity?: number;
}

export class PairDeviceDto {
  @IsOptional()
  @IsString()
  pairingToken?: string;

  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsString()
  code?: string;
}

export class ClaimLegacyDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsString()
  @IsNotEmpty()
  claimCode: string;
}

export class AssignDeviceDto {
  @IsOptional()
  storeId?: string | number;

  @IsOptional()
  customerId?: string | number;
}

export class UpdateConfigDto {
  @IsOptional()
  @IsString()
  buttonName?: string;

  @IsOptional()
  productId?: string | number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsString()
  @IsIn(['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'RETIRED', 'DISABLED'], {
    message: 'Trạng thái phải là một trong: ACTIVE, INACTIVE, MAINTENANCE, RETIRED, DISABLED',
  })
  status?: string;

  @IsOptional()
  @IsInt({ message: 'holdDurationMs phải là số nguyên mili-giây' })
  @Min(500, { message: 'holdDurationMs tối thiểu là 500ms' })
  @Max(10000, { message: 'holdDurationMs tối đa là 10.000ms' })
  holdDurationMs?: number;

  @IsOptional()
  @IsBoolean({ message: 'canOrder phải là giá trị boolean (true/false)' })
  canOrder?: boolean;

  @IsOptional()
  @IsInt({ message: 'cancelWindowSeconds phải là số nguyên giây' })
  @Min(0, { message: 'cancelWindowSeconds tối thiểu là 0' })
  @Max(3600, { message: 'cancelWindowSeconds tối đa là 3.600 giây' })
  cancelWindowSeconds?: number;
}

export class ExtendWarrantyDto {
  @IsNotEmpty()
  @IsNumber()
  @IsInt()
  @Min(1)
  @Max(120)
  months: number;
}

export class UpdateBehaviorDto {
  @IsOptional()
  @IsString()
  @IsIn(['SINGLE', 'DOUBLE', 'HOLD'])
  clickBehavior?: string;

  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(100)
  @Max(2000)
  doubleClickWindowMs?: number;

  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(500)
  @Max(10000)
  holdDurationMs?: number;
}

export class SimulatePressDto {
  @IsOptional()
  @IsString()
  pressType?: string;
}


export class UpdateBatteryDto {
  @IsNotEmpty()
  @IsNumber()
  @IsInt()
  @Min(0)
  @Max(100)
  batteryLevel: number;
}

export class UpdateDeviceStatusDto {
  @IsNotEmpty()
  @IsString()
  @IsIn(['ACTIVE', 'INACTIVE', 'LOCKED', 'SUSPENDED', 'UNASSIGNED', 'MAINTENANCE'])
  status: string;
}

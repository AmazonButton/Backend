import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  Min,
  Max,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  IsNotEmpty,
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
  @IsNumber()
  @Min(1)
  quantity?: number;
}

export class AllocateStoreDto {
  @IsString()
  @IsNotEmpty()
  storeId: string;

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
  status?: string;

  @IsOptional()
  storeId?: string | number;

  @IsOptional()
  customerId?: string | number;

  @IsOptional()
  productId?: string | number;

  @IsOptional()
  @IsNumber()
  @Min(1)
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
  status?: string;
}

export class ExtendWarrantyDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  months?: number;
}

export class UpdateBehaviorDto {
  @IsOptional()
  @IsString()
  clickBehavior?: string;

  @IsOptional()
  @IsNumber()
  doubleClickWindowMs?: number;

  @IsOptional()
  @IsNumber()
  holdDurationMs?: number;
}

export class SimulatePressDto {
  @IsOptional()
  @IsString()
  pressType?: string;
}

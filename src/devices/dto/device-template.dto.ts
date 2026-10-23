import { IsNotEmpty, IsOptional, IsString, IsInt, Min, IsArray } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateDeviceTemplateDto {
  @IsNotEmpty({ message: 'Tên template không được để trống' })
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  storeId?: string | number | bigint;

  @IsOptional()
  @IsString()
  defaultProductId?: string;

  @IsOptional()
  @IsString()
  singlePressAction?: string;

  @IsOptional()
  @IsString()
  doublePressAction?: string;

  @IsOptional()
  @IsString()
  longPressAction?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultQuantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cancelWindowSeconds?: number;
}

export class UpdateDeviceTemplateDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  defaultProductId?: string;

  @IsOptional()
  @IsString()
  singlePressAction?: string;

  @IsOptional()
  @IsString()
  doublePressAction?: string;

  @IsOptional()
  @IsString()
  longPressAction?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultQuantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cancelWindowSeconds?: number;
}

export class DeployDeviceTemplateDto {
  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deviceIds?: string[];

  @IsOptional()
  @IsString()
  prefix?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  startRange?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  endRange?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  padLength?: number;
}


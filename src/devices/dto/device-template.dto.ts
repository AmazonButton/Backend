import { IsNotEmpty, IsOptional, IsString, IsInt, Min } from 'class-validator';

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
  singlePressAction?: string;

  @IsOptional()
  @IsString()
  doublePressAction?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  defaultQuantity?: number;

  @IsOptional()
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
  singlePressAction?: string;

  @IsOptional()
  @IsString()
  doublePressAction?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  defaultQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  cancelWindowSeconds?: number;
}

export class DeployDeviceTemplateDto {
  @IsNotEmpty({ message: 'Mã thiết bị (deviceId) không được để trống khi triển khai template' })
  @IsString()
  deviceId: string;
}

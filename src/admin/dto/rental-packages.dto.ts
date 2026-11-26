import { IsString, IsNotEmpty, IsInt, IsOptional, Min, Max, IsBoolean } from 'class-validator';

export class CreateRentalPackageDto {
  @IsString()
  @IsNotEmpty()
  packageCode: string;

  @IsString()
  @IsNotEmpty()
  packageName: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  buttonQuantity: number;

  @IsInt()
  @Min(0)
  @Max(1000000000)
  monthlyPrice: number;

  @IsInt()
  @Min(0)
  @Max(1000000000)
  @IsOptional()
  depositFee?: number;
}

export class UpdateRentalPackageDto {
  @IsString()
  @IsOptional()
  packageName?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  buttonQuantity?: number;

  @IsInt()
  @Min(0)
  @Max(1000000000)
  @IsOptional()
  monthlyPrice?: number;

  @IsInt()
  @Min(0)
  @Max(1000000000)
  @IsOptional()
  depositFee?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

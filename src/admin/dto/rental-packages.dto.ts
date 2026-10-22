import { IsString, IsNotEmpty, IsNumber, IsOptional, Min, IsBoolean } from 'class-validator';

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

  @IsNumber()
  @Min(1)
  buttonQuantity: number;

  @IsNumber()
  @Min(0)
  monthlyPrice: number;

  @IsNumber()
  @Min(0)
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

  @IsNumber()
  @Min(1)
  @IsOptional()
  buttonQuantity?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  monthlyPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  depositFee?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

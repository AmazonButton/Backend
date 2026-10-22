import { IsString, IsNotEmpty, IsNumber, IsOptional, Min, IsBoolean } from 'class-validator';

export class CreateSubscriptionPlanDto {
  @IsString()
  @IsNotEmpty()
  planCode: string;

  @IsString()
  @IsNotEmpty()
  planName: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsNumber()
  @Min(1)
  durationDays: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  maxProducts?: number;
}

export class UpdateSubscriptionPlanDto {
  @IsString()
  @IsOptional()
  planName?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  price?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  durationDays?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  maxProducts?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

import { IsString, IsNotEmpty, IsInt, IsOptional, Min, Max, IsBoolean } from 'class-validator';

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

  @IsInt()
  @Min(0)
  @Max(1000000000)
  price: number;

  @IsInt()
  @Min(1)
  @Max(36500)
  durationDays: number;

  @IsInt()
  @Min(1)
  @Max(100000)
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

  @IsInt()
  @Min(0)
  @Max(1000000000)
  @IsOptional()
  price?: number;

  @IsInt()
  @Min(1)
  @Max(36500)
  @IsOptional()
  durationDays?: number;

  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  maxProducts?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

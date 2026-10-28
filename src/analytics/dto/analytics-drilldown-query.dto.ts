import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class OrderAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  toDate?: string;

  @IsOptional()
  @IsString()
  @IsIn(['day', 'week', 'month'])
  groupBy?: 'day' | 'week' | 'month';

  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: 'storeId phải là số nguyên dương' })
  storeId?: string;
}

export class ProductAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: 'categoryId phải là số nguyên dương' })
  categoryId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: 'storeId phải là số nguyên dương' })
  storeId?: string;
}

export class InventoryAnalyticsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @IsOptional()
  @IsIn(['low_stock', 'out_of_stock'])
  filter?: 'low_stock' | 'out_of_stock';

  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: 'storeId phải là số nguyên dương' })
  storeId?: string;
}

export class CustomerAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: 'storeId phải là số nguyên dương' })
  storeId?: string;
}

export class FinanceAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: 'storeId phải là số nguyên dương' })
  storeId?: string;
}

export class OperationsAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  toDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: 'storeId phải là số nguyên dương' })
  storeId?: string;
}

export class StaffAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  toDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: 'storeId phải là số nguyên dương' })
  storeId?: string;
}

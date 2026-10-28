import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import { buildAnalyticsDateRange } from '../../analytics/utils/analytics-date-range.util';

@ValidatorConstraint({ name: 'adminAnalyticsDateRange', async: false })
export class AdminAnalyticsDateRangeConstraint implements ValidatorConstraintInterface {
  validate(_value: string | undefined, args: ValidationArguments): boolean {
    const dto = args.object as any;
    try {
      buildAnalyticsDateRange(dto.fromDate, dto.toDate, dto.groupBy || 'day');
      return true;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return 'Khoảng ngày không hợp lệ; fromDate phải trước toDate và day/week tối đa 366 ngày';
  }
}

export class AdminDashboardQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Validate(AdminAnalyticsDateRangeConstraint)
  toDate?: string;

  @IsOptional()
  @IsString()
  @IsIn(['previous-period'])
  compareWith?: 'previous-period';
}

export class AdminTimeseriesAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Validate(AdminAnalyticsDateRangeConstraint)
  toDate?: string;

  @IsOptional()
  @IsString()
  @IsIn(['day', 'week', 'month'])
  groupBy?: 'day' | 'week' | 'month';
}

export class AdminStoresLeaderboardQueryDto {
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
  @IsIn(['gmv', 'orders', 'commission'])
  sortBy?: 'gmv' | 'orders' | 'commission' = 'gmv';

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc', 'ASC', 'DESC'])
  sortOrder?: 'asc' | 'desc' | 'ASC' | 'DESC' = 'desc';
}

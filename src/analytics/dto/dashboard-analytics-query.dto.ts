import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { buildAnalyticsDateRange } from '../utils/analytics-date-range.util';

@ValidatorConstraint({ name: 'analyticsDateRange', async: false })
export class AnalyticsDateRangeConstraint implements ValidatorConstraintInterface {
  validate(_value: string | undefined, args: ValidationArguments): boolean {
    const dto = args.object as DashboardAnalyticsQueryDto;
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

export class DashboardAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  fromDate?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Validate(AnalyticsDateRangeConstraint)
  toDate?: string;

  @IsOptional()
  @IsString()
  @IsIn(['day', 'week', 'month'])
  groupBy?: 'day' | 'week' | 'month';

  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d*$/, { message: 'storeId phải là số nguyên dương' })
  storeId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['previous-period'])
  compareWith?: 'previous-period';
}

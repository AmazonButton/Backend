import { BadRequestException } from '@nestjs/common';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ANALYTICS_TIME_ZONE_OFFSET = '+07:00';
const MAX_DAILY_WINDOW_DAYS = 366;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

export interface AnalyticsDateRange {
  fromDate?: Date;
  toDateExclusive?: Date;
}

function parseBoundary(value: string, upperBoundary: boolean): Date {
  if (DATE_ONLY_PATTERN.test(value)) {
    const startOfDay = new Date(`${value}T00:00:00.000${ANALYTICS_TIME_ZONE_OFFSET}`);
    return upperBoundary ? new Date(startOfDay.getTime() + DAY_IN_MS) : startOfDay;
  }

  return new Date(value);
}

export function buildAnalyticsDateRange(
  fromDate?: string,
  toDate?: string,
  groupBy: 'day' | 'week' | 'month' = 'day',
): AnalyticsDateRange {
  const range: AnalyticsDateRange = {};

  if (fromDate) range.fromDate = parseBoundary(fromDate, false);
  if (toDate) range.toDateExclusive = parseBoundary(toDate, true);

  if (range.fromDate && Number.isNaN(range.fromDate.getTime())) {
    throw new BadRequestException('fromDate không đúng định dạng ISO 8601');
  }
  if (range.toDateExclusive && Number.isNaN(range.toDateExclusive.getTime())) {
    throw new BadRequestException('toDate không đúng định dạng ISO 8601');
  }

  if (range.fromDate && range.toDateExclusive) {
    if (range.fromDate >= range.toDateExclusive) {
      throw new BadRequestException('fromDate phải nhỏ hơn hoặc bằng toDate');
    }

    const windowMs = range.toDateExclusive.getTime() - range.fromDate.getTime();
    if ((groupBy === 'day' || groupBy === 'week') && windowMs > MAX_DAILY_WINDOW_DAYS * DAY_IN_MS) {
      throw new BadRequestException('Khoảng thống kê day/week không được vượt quá 366 ngày');
    }
  }

  return range;
}

export function buildPreviousPeriod(range: AnalyticsDateRange): AnalyticsDateRange | null {
  if (!range.fromDate || !range.toDateExclusive) return null;
  const durationMs = range.toDateExclusive.getTime() - range.fromDate.getTime();
  const prevToExclusive = new Date(range.fromDate.getTime());
  const prevFrom = new Date(prevToExclusive.getTime() - durationMs);
  return { fromDate: prevFrom, toDateExclusive: prevToExclusive };
}

export function calculateGrowth(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

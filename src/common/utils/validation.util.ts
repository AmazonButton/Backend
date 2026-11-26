import { BadRequestException } from '@nestjs/common';

export const POSTGRES_BIGINT_MAX = BigInt('9223372036854775807');
export const POSTGRES_INT_MAX = 2147483647;

/**
 * Validate and parse a PostgreSQL signed 64-bit BIGINT identifier in [1, 9223372036854775807].
 * Rejects decimals, out-of-range values, booleans, empty strings, and leading zeros.
 */
export function parsePositivePostgresBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value >= BigInt(1) && value <= POSTGRES_BIGINT_MAX ? value : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? BigInt(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[1-9]\d{0,18}$/.test(trimmed)) {
      return null;
    }
    const parsed = BigInt(trimmed);
    return parsed >= BigInt(1) && parsed <= POSTGRES_BIGINT_MAX ? parsed : null;
  }
  return null;
}

/**
 * Strictly parse a PostgreSQL BIGINT identifier or throw 400 BadRequestException.
 */
export function requirePositivePostgresBigInt(value: unknown, label = 'Mã định danh (ID)'): bigint {
  const parsed = parsePositivePostgresBigInt(value);
  if (parsed === null) {
    throw new BadRequestException(`${label} không hợp lệ`);
  }
  return parsed;
}

/**
 * Validate and cap pagination query parameters to prevent negative, float, NaN, or oversized DB offsets.
 */
export function sanitizePagination(
  pageRaw: unknown,
  pageSizeRaw: unknown,
  defaultPageSize = 20,
  maxPageSize = 100,
  maxPage = 10000,
): { page: number; pageSize: number; skip: number } {
  let page = 1;
  if (pageRaw !== undefined && pageRaw !== null && pageRaw !== '') {
    const num = Number(pageRaw);
    if (!Number.isSafeInteger(num) || num < 1 || num > maxPage) {
      throw new BadRequestException(`Tham số page phải là số nguyên từ 1 đến ${maxPage}`);
    }
    page = num;
  }

  let pageSize = defaultPageSize;
  if (pageSizeRaw !== undefined && pageSizeRaw !== null && pageSizeRaw !== '') {
    const num = Number(pageSizeRaw);
    if (!Number.isSafeInteger(num) || num < 1) {
      throw new BadRequestException('Tham số pageSize phải là số nguyên dương');
    }
    pageSize = Math.min(num, maxPageSize);
  }

  return { page, pageSize, skip: (page - 1) * pageSize };
}

/**
 * Parse a non-negative PostgreSQL 32-bit INT quantity in [0, 2147483647].
 * Rejects decimals (e.g. 1.9), negative numbers, booleans, null, and non-numeric strings.
 */
export function parseNonNegativeInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= POSTGRES_INT_MAX ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^(0|[1-9]\d{0,9})$/.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= POSTGRES_INT_MAX ? parsed : null;
  }
  return null;
}

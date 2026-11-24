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

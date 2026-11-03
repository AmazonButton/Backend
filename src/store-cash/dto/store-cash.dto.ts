import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

// Keep IDs as strings: JS numbers cannot represent the PostgreSQL bigint range.
export const cashResourceIdSchema = z.string().regex(/^[1-9]\d{0,18}$/, 'ID phải là số nguyên dương')
  .refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n, 'ID vượt quá giới hạn PostgreSQL bigint');

export const cashVoucherTokenSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Mã token QR không hợp lệ');

// Customer identity, amount and expiry are ALWAYS obtained server-side.
export const issueCashVoucherSchema = z.object({
  chargeId: cashResourceIdSchema,
  collectingStoreId: cashResourceIdSchema,
}).strict();

const collectionFields = {
  chargeId: cashResourceIdSchema,
  voucherToken: cashVoucherTokenSchema,
};

export const collectCashSchema = z.discriminatedUnion('handover', [
  z.object({ ...collectionFields, handover: z.literal('DEFERRED') }).strict(),
  z.object({
    ...collectionFields,
    handover: z.literal('IMMEDIATE'),
    buttonIds: z.array(cashResourceIdSchema).min(1).max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate button IDs'),
  }).strict(),
]);

export const collectCashBodySchema = z.discriminatedUnion('handover', [
  z.object({
    rentalId: cashResourceIdSchema,
    ...collectionFields,
    handover: z.literal('DEFERRED'),
  }).strict(),
  z.object({
    rentalId: cashResourceIdSchema,
    ...collectionFields,
    handover: z.literal('IMMEDIATE'),
    buttonIds: z.array(cashResourceIdSchema).min(1).max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate button IDs'),
  }).strict(),
]);

export const MAX_PAGINATION_OFFSET = 1_000_000;

export const cashPaginationQuerySchema = z.object({
  page: z.string().max(10).regex(/^[1-9]\d*$/, 'Trang phải là số nguyên dương').default('1').transform(Number),
  pageSize: z.string().max(5).regex(/^[1-9]\d*$/, 'Kích thước trang phải là số nguyên dương').default('20').transform(Number)
    .refine((v) => v <= 100, { message: 'Kích thước trang không được vượt quá 100' }),
  status: z.string().max(32).regex(/^[A-Z_]{1,32}$/, 'Trạng thái không hợp lệ').optional(),
}).refine((data) => (data.page - 1) * data.pageSize <= MAX_PAGINATION_OFFSET, {
  message: 'Độ lệch phân trang vượt quá giới hạn tối đa cho phép',
  path: ['page'],
});

export type IssueCashVoucherDto = z.infer<typeof issueCashVoucherSchema>;
export type CollectCashDto = z.infer<typeof collectCashSchema>;
export type CollectCashBodyDto = z.infer<typeof collectCashBodySchema>;
export type CashPaginationQueryDto = z.infer<typeof cashPaginationQuerySchema>;

/** Validate data against Zod schema and throw standardized BadRequestException on error. */
export function validateZod<T>(schema: z.ZodType<T, any, any>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errorList = result.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    throw new BadRequestException({
      success: false,
      errorCode: 'VALIDATION_ERROR',
      message: errorList[0]?.message || 'Dữ liệu yêu cầu không hợp lệ',
      errors: errorList,
    });
  }
  return result.data;
}

/** Validate path parameter ID string before converting to bigint. */
export function validatePathId(id: string, paramName = 'id'): bigint {
  if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id)) {
    throw new BadRequestException({
      success: false,
      errorCode: 'INVALID_ID_FORMAT',
      message: `Tham số ${paramName} không hợp lệ (phải là số nguyên dương)`,
    });
  }
  try {
    const val = BigInt(id);
    if (val > 9223372036854775807n) {
      throw new Error();
    }
    return val;
  } catch {
    throw new BadRequestException({
      success: false,
      errorCode: 'INVALID_ID_FORMAT',
      message: `Tham số ${paramName} vượt quá giới hạn PostgreSQL bigint`,
    });
  }
}

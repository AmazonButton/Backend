/**
 * Smart Order Button Platform - Order Constants
 * Enforces business rules and financial integrity invariants
 */

/**
 * Giá trị đơn hàng tối thiểu (VND)
 * Áp dụng cho toàn bộ luồng tạo đơn (Stored Procedure & Fallback Transaction)
 */
export const MIN_ORDER_TOTAL_VND = 2000;

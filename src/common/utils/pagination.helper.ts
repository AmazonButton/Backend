export interface PaginationMetadata {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export function buildPaginationMetadata(
  totalItems: number,
  page: number = 1,
  pageSize: number = 20,
): PaginationMetadata {
  const safeTotal = Number.isSafeInteger(Number(totalItems)) && Number(totalItems) >= 0 ? Number(totalItems) : 0;
  const safePage = Number.isSafeInteger(Number(page)) && Number(page) >= 1 ? Number(page) : 1;
  const safePageSize =
    Number.isSafeInteger(Number(pageSize)) && Number(pageSize) >= 1
      ? Math.min(100, Number(pageSize))
      : 20;
  const totalPages = Math.ceil(safeTotal / safePageSize);

  return {
    page: safePage,
    pageSize: safePageSize,
    totalItems: safeTotal,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPrevPage: safePage > 1,
  };
}

export function buildPaginatedResponse<T>(
  items: T[],
  totalItems: number,
  page: number = 1,
  pageSize: number = 20,
  message: string = 'Lấy danh sách thành công',
) {
  return {
    success: true,
    message,
    data: items,
    pagination: buildPaginationMetadata(totalItems, page, pageSize),
  };
}

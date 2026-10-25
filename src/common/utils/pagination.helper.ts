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
  const safePage = Math.max(1, page);
  const safePageSize = Math.max(1, Math.min(100, pageSize));
  const totalPages = Math.ceil(totalItems / safePageSize);

  return {
    page: safePage,
    pageSize: safePageSize,
    totalItems,
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

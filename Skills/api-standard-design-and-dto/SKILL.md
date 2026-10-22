---
name: api-standard-design-and-dto
description: >-
  Use this skill when designing REST API endpoints, implementing uniform response envelopes (success/error),
  building pagination and sorting parameters, or creating DTO data mappers to separate database entities from API contracts.
---

# API Standard Design & DTO Pattern Runbook

This skill establishes consistent, predictable API design and ensures data transfer boundaries are strictly observed across all backend endpoints.

---

## 1. Uniform Response Envelopes Helper (`src/utils/response.js`)

Centralize success responses to guarantee a standard shape across the entire codebase:

```javascript
/**
 * Standard Success Response
 */
export const sendSuccess = (res, { statusCode = 200, message = 'Success', data = null, pagination = null }) => {
  const responseBody = {
    success: true,
    message,
    data
  };

  if (pagination) {
    responseBody.pagination = pagination;
  }

  return res.status(statusCode).json(responseBody);
};

/**
 * Standard Pagination Metadata Builder with Navigation Flags
 */
export const buildPagination = (page, pageSize, totalItems) => {
  const currentPage = Math.max(Number(page) || 1, 1);
  const limit = Math.min(Math.max(Number(pageSize) || 10, 1), 100);
  const total = Number(totalItems) || 0;
  const totalPages = Math.ceil(total / limit) || 1;

  return {
    page: currentPage,
    pageSize: limit,
    totalItems: total,
    totalPages,
    hasNextPage: currentPage < totalPages,
    hasPrevPage: currentPage > 1
  };
};
```

---

## 2. Generic Query Parameter Parsing: Pagination, Sorting, Fields & Expansion

Extract, sanitize, and whitelist incoming query parameters for any API endpoint:

```javascript
/**
 * Parse standard pagination and sort parameters
 */
export const parsePaginationParams = (query, defaultSort = 'created_at', allowedSortFields = ['created_at']) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 10, 1), 100);
  const offset = (page - 1) * pageSize;

  const sortBy = allowedSortFields.includes(query.sortBy) ? query.sortBy : defaultSort;
  const sortOrder = (query.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  return { page, pageSize, offset, sortBy, sortOrder };
};

/**
 * Parse Sparse Fieldsets (?fields=id,name,email)
 * Returns array of validated fields, or null if all allowed fields are requested
 */
export const parseFieldSelection = (fieldsQuery, allowedFields = []) => {
  if (!fieldsQuery || typeof fieldsQuery !== 'string') {
    return null; // Return all default fields
  }

  const requestedFields = fieldsQuery.split(',').map(f => f.trim()).filter(Boolean);
  const safeFields = requestedFields.filter(f => allowedFields.includes(f));

  // If none matched, return null to fallback to all fields
  return safeFields.length > 0 ? safeFields : null;
};

/**
 * Parse Resource Expansion (?expand=author,category)
 * Returns array of validated relation names to be joined/embedded
 */
export const parseExpansionParams = (expandQuery, allowedRelations = []) => {
  if (!expandQuery || typeof expandQuery !== 'string') {
    return [];
  }

  const requested = expandQuery.split(',').map(r => r.trim()).filter(Boolean);
  return requested.filter(r => allowedRelations.includes(r));
};

/**
 * Generic Field Projection Helper
 * Filters an object or array of objects to keep only selected fields
 */
export const projectFields = (data, selectedFields) => {
  if (!selectedFields || !Array.isArray(selectedFields) || selectedFields.length === 0) {
    return data;
  }

  const filterObject = (item) => {
    if (!item || typeof item !== 'object') return item;
    const projected = {};
    for (const field of selectedFields) {
      if (field in item) {
        projected[field] = item[field];
      }
    }
    return projected;
  };

  return Array.isArray(data) ? data.map(filterObject) : filterObject(data);
};

```

---

## 3. DTO Mapper Layer Pattern (`[feature].dto.js`)

Decouple the database schema from the API contract and sanitize internal/sensitive fields:

```javascript
/**
 * Convert a raw PostgreSQL book row to an API response DTO
 */
export const toBookResponseDTO = (rawBook) => {
  if (!rawBook) return null;

  return {
    id: rawBook.id,
    title: rawBook.title,
    author: rawBook.author,
    isbn: rawBook.isbn,
    publishedYear: rawBook.published_year,
    status: rawBook.status,
    createdAt: rawBook.created_at ? new Date(rawBook.created_at).toISOString() : null,
    updatedAt: rawBook.updated_at ? new Date(rawBook.updated_at).toISOString() : null
  };
};

/**
 * Convert a list of books
 */
export const toBookListDTO = (rawBooks = []) => {
  return rawBooks.map(toBookResponseDTO);
};
```

---

## 4. Standard Controller Implementation Example

```javascript
import { booksService } from './books.service.js';
import { sendSuccess, buildPagination } from '../../utils/response.js';
import { toBookListDTO, toBookResponseDTO } from './books.dto.js';
import { parsePaginationParams } from '../../utils/pagination.js';

export const booksController = {
  // GET /api/v1/books?page=1&pageSize=20&sortBy=title&sortOrder=asc
  async getAllBooks(req, res, next) {
    try {
      const { page, pageSize, offset, sortBy, sortOrder } = parsePaginationParams(
        req.query,
        'created_at',
        ['title', 'created_at', 'published_year']
      );

      const { books, total } = await booksService.listBooks({
        limit: pageSize,
        offset,
        sortBy,
        sortOrder,
        search: req.query.search
      });

      return sendSuccess(res, {
        message: 'Books retrieved successfully',
        data: toBookListDTO(books),
        pagination: buildPagination(page, pageSize, total)
      });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/books
  async createBook(req, res, next) {
    try {
      const createdBook = await booksService.createBook(req.body);
      return sendSuccess(res, {
        statusCode: 201,
        message: 'Book created successfully',
        data: toBookResponseDTO(createdBook)
      });
    } catch (err) {
      next(err);
    }
  }
};
```

---
name: db-migration-and-concurrency
description: >-
  Use this skill when managing PostgreSQL database migrations, enforcing database constraints and indexes,
  handling concurrent operations (race conditions with row locking), managing transactions, or implementing Idempotency keys.
---

# Database Migrations, Concurrency & Transaction Management

This skill provides patterns for database evolution, schema integrity, and race-condition prevention in critical business operations (such as borrowing books, inventory updates, or payments).

---

## 1. Migration File Structure

Maintain schema changes in ordered SQL migration scripts (`migrations/`):

```sql
-- migrations/001_create_initial_schema.sql

-- Enable UUID extension if using UUID keys
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL UNIQUE,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN', 'STAFF', 'USER')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Books Table with Constraints
CREATE TABLE IF NOT EXISTS books (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    author VARCHAR(255) NOT NULL,
    isbn VARCHAR(20) NOT NULL UNIQUE,
    total_copies INT NOT NULL DEFAULT 1 CHECK (total_copies >= 0),
    available_copies INT NOT NULL DEFAULT 1 CHECK (available_copies >= 0 AND available_copies <= total_copies),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Borrow Records Table with Foreign Keys
CREATE TABLE IF NOT EXISTS borrow_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    book_id UUID NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
    borrowed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_date TIMESTAMPTZ NOT NULL,
    returned_at TIMESTAMPTZ NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'BORROWED' CHECK (status IN ('BORROWED', 'RETURNED', 'OVERDUE')),
    deleted_at TIMESTAMPTZ NULL
);

-- Indices for high-frequency queries
CREATE INDEX IF NOT EXISTS idx_borrow_records_user ON borrow_records(user_id);
CREATE INDEX IF NOT EXISTS idx_borrow_records_book ON borrow_records(book_id);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);

-- Soft Delete Partial Unique Index:
-- Enforces uniqueness ONLY for active (non-deleted) records, avoiding conflict when re-registering
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_active ON users (email) WHERE deleted_at IS NULL;
```

---

## 2. Race Condition Mitigation (Row-Level Locking)

When modifying inventory, balance, or reservation status, standard `SELECT` followed by `UPDATE` suffers from race conditions if two requests execute concurrently.
Use `SELECT ... FOR UPDATE` within a transaction to lock the specific row:

```javascript
import { pool } from '../config/database.js';
import { AppError } from '../utils/apiError.js';

export const borrowBookAtomic = async (userId, bookId) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock the book record for update to prevent concurrent over-borrowing
    const bookRes = await client.query(
      'SELECT id, available_copies FROM books WHERE id = $1 FOR UPDATE',
      [bookId]
    );

    if (bookRes.rows.length === 0) {
      throw new AppError('Book not found', 404);
    }

    const book = bookRes.rows[0];
    if (book.available_copies <= 0) {
      throw new AppError('No copies available to borrow', 409);
    }

    // 2. Decrement available copies
    await client.query(
      'UPDATE books SET available_copies = available_copies - 1, updated_at = NOW() WHERE id = $1',
      [bookId]
    );

    // 3. Create borrow record
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 14); // 14-day borrowing period

    const recordRes = await client.query(
      `INSERT INTO borrow_records (user_id, book_id, due_date)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, bookId, dueDate]
    );

    await client.query('COMMIT');
    return recordRes.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
```

---

## 3. Idempotency Key Middleware (`src/middlewares/idempotency.js`)

Prevents duplicate execution on critical endpoints (orders, payments) caused by network retries:

```javascript
import { pool } from '../config/database.js';
import { AppError } from '../utils/apiError.js';

export const requireIdempotencyKey = async (req, res, next) => {
  const key = req.headers['idempotency-key'];

  if (!key) {
    // If not required on every route, skip or enforce as needed
    return next();
  }

  try {
    // Check if key has already been processed in the last 24 hours
    const existing = await pool.query(
      'SELECT response_status, response_body FROM idempotency_keys WHERE key = $1',
      [key]
    );

    if (existing.rows.length > 0) {
      const cached = existing.rows[0];
      return res.status(cached.response_status).json(cached.response_body);
    }

    // Intercept res.json to cache response
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Async insert into idempotency log
      pool.query(
        'INSERT INTO idempotency_keys (key, response_status, response_body) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [key, res.statusCode, body]
      ).catch(err => console.error('Idempotency save error', err));

      return originalJson(body);
    };

    next();
  } catch (error) {
    next(error);
  }
};
```

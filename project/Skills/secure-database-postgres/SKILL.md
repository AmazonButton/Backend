---
name: secure-database-postgres
description: >-
  Use this skill when designing, interacting with, or refactoring the PostgreSQL database layer in Node.js.
  It enforces parameterized queries, connection pooling best practices, least privilege database user setup,
  safe dynamic filtering/sorting, and transaction rollback patterns.
---

# Secure PostgreSQL Access & Repository Pattern

This skill ensures that all database operations are immune to SQL Injection (SQLi), handle connection limits gracefully, and operate under the principle of least privilege.

---

## 1. Connection Pool Configuration (`src/config/database.js`)

Do not create individual database connections per request. Use a shared `pg.Pool` with connection limits, timeouts, and SSL configuration:

```javascript
import pg from 'pg';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20, // Limit maximum concurrent connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', err);
});

// Helper wrapper for single query execution
export const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (env.NODE_ENV !== 'production') {
      logger.debug({ text, duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    logger.error('Database Query Error', { text, error: error.message });
    throw error;
  }
};
```

---

## 2. Parameterized Queries (Zero SQL Injection)

### ❌ Insecure (Never Do This)
```javascript
// Catastrophic SQL Injection risk!
const sql = `SELECT * FROM users WHERE email = '${email}' AND role = '${role}'`;
await pool.query(sql);
```

### ✅ Secure (Always Parameterize)
```javascript
const sql = `SELECT id, email, username, role, created_at FROM users WHERE email = $1 AND role = $2`;
const { rows } = await pool.query(sql, [email, role]);
return rows[0];
```

---

## 3. Safe Dynamic Queries (Sorting & Filtering)

SQL placeholders (`$1, $2`) cannot be used for column names or `ASC`/`DESC` keywords.
To prevent SQL injection via sort parameters, **always validate against a strict whitelist**:

```javascript
export const getFilteredUsers = async ({ sortBy = 'created_at', sortOrder = 'DESC', limit = 20, offset = 0 }) => {
  // 1. Whitelist valid columns and order
  const ALLOWED_COLUMNS = ['username', 'created_at', 'email'];
  const ALLOWED_ORDER = ['ASC', 'DESC'];

  const safeSortBy = ALLOWED_COLUMNS.includes(sortBy) ? sortBy : 'created_at';
  const safeSortOrder = ALLOWED_ORDER.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

  // 2. Cap pagination
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  // 3. Assemble query safely
  const queryText = `
    SELECT id, username, email, created_at
    FROM users
    ORDER BY ${safeSortBy} ${safeSortOrder}
    LIMIT $1 OFFSET $2
  `;

  const { rows } = await pool.query(queryText, [safeLimit, safeOffset]);
  return rows;
};
```

---

## 4. Transaction Safety Pattern

Wrap operations that modify multiple tables in explicit transactions with automatic rollback:

```javascript
export const executeTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
```

---

## 5. Least-Privilege Database User Setup (SQL Script)

Never use the `postgres` superuser for the backend application:

```sql
-- Run as superuser during server setup
CREATE USER app_backend WITH PASSWORD 'STRONG_RANDOMLY_GENERATED_PASSWORD';

-- Grant connection to the database
GRANT CONNECT ON DATABASE production_db TO app_backend;

-- Grant schema usage
GRANT USAGE ON SCHEMA public TO app_backend;

-- Grant DML privileges only (no DROP TABLE / ALTER TABLE)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_backend;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_backend;

-- Ensure future tables inherit same permissions
ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_backend;
```

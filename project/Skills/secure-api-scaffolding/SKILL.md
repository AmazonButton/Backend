---
name: secure-api-scaffolding
description: >-
  Use this skill when initializing or expanding a Node.js Express backend project. It provides standardized templates
  for the 6-layer architecture (Router, Middleware, Controller, Service, Repository, Database), centralized security middleware
  (Helmet, CORS, Rate Limit, Body Limit), and safe error handling.
---

# Secure API Scaffolding for Node.js & Express

This skill establishes the production-grade foundation for a secure Express.js application, enforcing a strict 6-layer architecture (Router -> Middleware -> Controller -> Service -> Repository -> Database) and security by design from the ground up.

---

## 1. Project Directory Layout

```text
src/
├── config/
│   ├── env.js             # Runtime environment validation (Zod)
│   └── database.js        # PostgreSQL pool configuration
├── middlewares/
│   ├── security.js        # Helmet, CORS, and request size limits
│   ├── rateLimiter.js     # Global & endpoint-specific rate limiters
│   ├── auth.js            # JWT verification & session extraction
│   ├── rbac.js            # Role-based & ownership authorization guards
│   ├── validate.js        # Generic Zod validation middleware
│   └── errorHandler.js    # Fail-secure central error handling
├── modules/               # Feature-based modular structure
│   └── [feature]/         # e.g., users, books, orders
│       ├── [feature].routes.js
│       ├── [feature].controller.js
│       ├── [feature].service.js
│       ├── [feature].repository.js
│       └── [feature].schema.js
├── utils/
│   ├── apiError.js        # Custom AppError class with HTTP status
│   └── logger.js          # Winston/Pino logger with sensitive data masking
├── app.js                 # Express application assembly & middleware pipeline
└── server.js              # HTTP server bootstrap & graceful shutdown
```

---

## 2. Core Middleware Setup

### A. Environment Validation (`src/config/env.js`)
Ensure the application refuses to start if critical secrets are missing or malformed:

```javascript
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('5000'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid connection string'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_SECRET: z.string().min(32, 'REFRESH_TOKEN_SECRET must be at least 32 characters'),
  CORS_ORIGIN: z.string().min(1, 'CORS_ORIGIN is required')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
```

### B. Security & Rate Limiting (`src/middlewares/security.js` & `rateLimiter.js`)
Apply Helmet, CORS, and strict payload caps:

```javascript
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

export const setupSecurityMiddleware = (app) => {
  // 1. Security Headers
  app.use(helmet());

  // 2. Strict CORS
  app.use(cors({
    origin: (origin, callback) => {
      const allowedOrigins = env.CORS_ORIGIN.split(',').map(o => o.trim());
      // Allow non-browser requests (like server-to-server or tests) only in non-prod
      if (!origin && env.NODE_ENV !== 'production') return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Blocked by CORS policy'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));

  // 3. Payload size limiting (anti-DoS)
  app.use(express.json({ limit: '10kb' }));
  app.use(express.urlencoded({ extended: true, limit: '10kb' }));
};

// Rate limiter for authentication / sensitive routes
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Max 10 attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: 'Too many requests, please try again after 15 minutes.'
  }
});
```

### C. Fail-Secure Centralized Error Handler (`src/middlewares/errorHandler.js`)
Prevent sensitive stack traces, file paths, or raw database queries from leaking:

```javascript
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  
  // Log all server errors internally
  logger.error({
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip
  });

  // Fail-secure response to client
  res.status(statusCode).json({
    status: 'error',
    message: err.isOperational || env.NODE_ENV !== 'production'
      ? err.message
      : 'Internal server error',
    ...(env.NODE_ENV === 'development' && { stack: err.stack })
  });
};
```

---

## 3. Creating a New Feature Module (Step-by-Step)

When adding any new endpoint, strictly follow the 6-layer pipeline:
1. **Define Schema & DTO** in `[feature].schema.js`: Validate `body`, `query`, and `params`.
2. **Implement Repository** in `[feature].repository.js`: Execute only parameterized SQL (`$1, $2`).
3. **Implement Service** in `[feature].service.js`: Enforce business rules & ownership verification.
4. **Implement Controller** in `[feature].controller.js`: Map inputs, call service, return clean DTOs.
5. **Configure Router** in `[feature].routes.js`: Wire the endpoint, HTTP verb, middleware pipeline, and controller.

### Router Layer Example (`src/modules/books/books.routes.js`):
```javascript
import { Router } from 'express';
import { booksController } from './books.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { requireRoles } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { createBookSchema, updateBookSchema } from './books.schema.js';

const router = Router();

// Public route: View books
router.get('/', booksController.getAllBooks);

// Protected route: Create book (Staff/Admin only)
router.post(
  '/',
  authenticate,
  requireRoles(['ADMIN', 'STAFF']),
  validate(createBookSchema),
  booksController.createBook
);

// Protected route: Update book
router.put(
  '/:id',
  authenticate,
  requireRoles(['ADMIN', 'STAFF']),
  validate(updateBookSchema),
  booksController.updateBook
);

export default router;
```


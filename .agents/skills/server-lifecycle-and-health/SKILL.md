---
name: server-lifecycle-and-health
description: >-
  Use this skill when implementing health check endpoints (/healthz, /readyz),
  setting up graceful shutdown (SIGTERM/SIGINT teardown of DB and Redis), or auto-generating OpenAPI/Swagger documentation from Zod schemas.
---

# Server Lifecycle, Health Probes & Swagger Documentation

This skill provides the operational foundations necessary for Docker, Kubernetes, CI/CD, and developer documentation.

---

## 1. Health & Readiness Probes (`src/routes/health.routes.js`)

Kubernetes and cloud load balancers use these endpoints to determine whether to restart an unresponsive container or direct user traffic to it.

```javascript
import { Router } from 'express';
import { pool } from '../config/database.js';
import { redis } from '../config/redis.js';

const router = Router();

// Liveness Probe: Checks if Node process is responsive
router.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Readiness Probe: Checks critical dependencies (Postgres + Redis)
router.get('/readyz', async (req, res) => {
  const checks = {
    database: false,
    redis: false
  };

  try {
    // 1. Check PostgreSQL
    await pool.query('SELECT 1');
    checks.database = true;

    // 2. Check Redis
    const pong = await redis.ping();
    if (pong === 'PONG') checks.redis = true;

    const allReady = checks.database && checks.redis;
    const statusCode = allReady ? 200 : 503;

    return res.status(statusCode).json({
      status: allReady ? 'ready' : 'unready',
      checks,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return res.status(503).json({
      status: 'unready',
      checks,
      error: error.message
    });
  }
});

export default router;
```

---

## 2. Graceful Shutdown Lifecycle (`src/server.js`)

When rolling out updates or receiving `SIGTERM` from Docker, ensure in-flight HTTP requests complete before shutting down database pools:

```javascript
import http from 'http';
import app from './app.js';
import { env } from './config/env.js';
import { pool } from './config/database.js';
import { redis } from './config/redis.js';
import { logger } from './utils/logger.js';

const server = http.createServer(app);

server.listen(env.PORT, () => {
  logger.info(`🚀 Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
});

const gracefulShutdown = (signal) => {
  logger.info(`📢 Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(async () => {
    logger.info('🛑 HTTP server closed.');

    try {
      // 1. Drain and close PostgreSQL connection pool
      await pool.end();
      logger.info('📦 PostgreSQL pool disconnected.');

      // 2. Disconnect Redis
      await redis.quit();
      logger.info('⚡ Redis disconnected.');

      logger.info('✅ Graceful shutdown completed cleanly.');
      process.exit(0);
    } catch (err) {
      logger.error('❌ Error during graceful shutdown', err);
      process.exit(1);
    }
  });

  // Force close if teardown takes longer than 15 seconds
  setTimeout(() => {
    logger.error('⚠️ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 15000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

---

## 3. Automated Swagger from Zod Schemas (`src/docs/swagger.js`)

Prevent documentation rot by generating OpenAPI specs directly from your Zod schemas:

```javascript
import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';

export const registry = new OpenAPIRegistry();

// Register Bearer Auth component
registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT'
});

// Example: Register an endpoint definition
export const registerBookRoutesDoc = () => {
  const BookSchema = registry.register(
    'Book',
    z.object({
      id: z.string().uuid(),
      title: z.string().openapi({ example: 'Clean Architecture' }),
      author: z.string().openapi({ example: 'Robert C. Martin' })
    })
  );

  registry.registerPath({
    method: 'get',
    path: '/api/v1/books',
    summary: 'Retrieve all books',
    responses: {
      200: {
        description: 'Books retrieved successfully',
        content: {
          'application/json': {
            schema: z.object({
              success: z.boolean(),
              data: z.array(BookSchema)
            })
          }
        }
      }
    }
  });
};

export const setupSwaggerDocs = (app) => {
  registerBookRoutesDoc();

  const generator = new OpenApiGeneratorV3(registry.definitions);
  const openApiDoc = generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Backend API Documentation',
      version: '1.0.0',
      description: 'API specifications auto-generated from Zod contracts'
    }
  });

  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDoc));
};
```

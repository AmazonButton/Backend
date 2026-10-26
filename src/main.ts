import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import helmet from 'helmet';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  // Boot-time env validation: crash early if critical secrets are missing
  const requiredEnvVars = [
    'JWT_SECRET',
    'OTP_PEPPER',
    'BANK_ACCOUNT_ENCRYPTION_KEY',
    'BANK_ACCOUNT_HASH_SALT',
  ];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      console.error(`❌ FATAL: Missing required environment variable: ${envVar}`);
      process.exit(1);
    }
  }

  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Enable shutdown hooks for graceful termination
  app.enableShutdownHooks();

  // Express body size limit with rawBody retention for webhooks
  // Webhooks (Didit eKYC dossiers with AML/OCR) can reach ~50kb; standard routes keep strict 10kb limit (RULE-14)
  app.use(
    '/api/v1/webhooks',
    express.json({
      limit: '1mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(
    express.json({
      limit: '10kb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ limit: '10kb', extended: true }));

  // Global exception filter for uniform error envelopes & security error masking
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global rate limiter (1000 requests per 15 minutes per IP)
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 1000,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        message: 'Quá nhiều yêu cầu từ địa chỉ IP của bạn. Vui lòng thử lại sau 15 phút.',
        errorCode: 'RATE_LIMIT_EXCEEDED',
      },
    }),
  );

  // Enable global validation pipeline — activates all class-validator DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,            // Strip unknown fields (anti Mass Assignment)
      forbidNonWhitelisted: true, // Reject requests with unknown fields
      transform: true,            // Auto-transform payloads to DTO instances
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginOpenerPolicy: { policy: 'unsafe-none' },
    }),
  );
  const defaultCorsOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000',
  ];
  const corsOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
    : defaultCorsOrigins;

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization, x-device-id, x-timestamp, x-nonce, x-signature',
  });

  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'healthz', 'readyz', 'api/v1/health', 'outbound-ip'],
  });

  // Setup Swagger Documentation (wrapped in try/catch to gracefully handle environments without emitDecoratorMetadata like tsx/esbuild)
  try {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Smart Order Button Platform API')
      .setDescription(
        'Nền tảng Nút Bấm Đặt Hàng Thông Minh Đa Cửa Hàng (Multi-Store IoT Button Platform - BRD V2.1).\n\n' +
        'Bao gồm đầy đủ các module: Auth & IAM, IoT Edge Gate (HMAC-SHA256), Devices & Zero-Touch Provisioning, Products & Inventory, Orders, Admin Management & Analytics.',
      )
      .setVersion('2.1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'JWT',
          description: 'Nhập JWT Token nhận được từ /api/v1/auth/login',
          in: 'header',
        },
        'JWT-auth',
      )
      .addApiKey(
        {
          type: 'apiKey',
          name: 'x-signature',
          in: 'header',
          description: 'Chữ ký HMAC-SHA256 của nút bấm IoT',
        },
        'HMAC-Signature',
      )
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      customSiteTitle: 'Smart Order Button API Documentation (Swagger)',
      swaggerOptions: {
        persistAuthorization: true,
        filter: true,
        displayRequestDuration: true,
      },
    });
  } catch (err: any) {
    console.warn(`⚠️ [Swagger] Không thể tạo tài liệu Swagger trong môi trường dev tsx do thiếu reflect metadata (${err?.message || err}). Chạy 'npm start' hoặc 'npm run build' để kích hoạt Swagger đầy đủ.`);
  }

  const port = process.env.PORT || 5000;
  await app.listen(port, '0.0.0.0');

  console.log(`=======================================================`);
  console.log(`🚀 SMART ORDER BUTTON — NESTJS CLOUD & REALTIME CORE`);
  console.log(`📡 NestJS Server running on http://localhost:${port}/api/v1`);
  console.log(`📚 Swagger API Docs:  http://localhost:${port}/docs`);
  console.log(`🔒 Security: HMAC-SHA256 Edge Gate & Multi-tenant RBAC`);
  console.log(`⚡ WebSocket: Socket.io Room Gateway Active`);
  console.log(`=======================================================`);
}

bootstrap();

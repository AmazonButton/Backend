import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import cors from 'cors';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginOpenerPolicy: { policy: 'unsafe-none' },
    }),
  );
  app.enableCors({
    origin: true,
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization, x-device-id, x-timestamp, x-nonce, x-signature',
  });

  // Support both /api and /api/v1 transparently
  app.use((req: any, _res: any, next: any) => {
    if (req.url && req.url.startsWith('/api/v1/')) {
      req.url = req.url.replace('/api/v1/', '/api/');
    }
    next();
  });

  app.setGlobalPrefix('api');

  const port = process.env.PORT || 5000;
  await app.listen(port, '0.0.0.0');

  console.log(`=======================================================`);
  console.log(`🚀 SMART ORDER BUTTON — NESTJS CLOUD & REALTIME CORE`);
  console.log(`📡 NestJS Server running on http://localhost:${port}/api`);
  console.log(`🔒 Security: HMAC-SHA256 Edge Gate & Multi-tenant RBAC`);
  console.log(`⚡ WebSocket: Socket.io Room Gateway Active`);
  console.log(`=======================================================`);
}

bootstrap();
// Server reloaded with real PayOS API credentials

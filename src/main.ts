import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import cors from 'cors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

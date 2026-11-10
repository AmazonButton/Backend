import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Configure JSON.stringify to convert BigInt values to numbers or strings
(BigInt.prototype as any).toJSON = function () {
  const intVal = Number(this);
  return Number.isSafeInteger(intVal) ? intVal : this.toString();
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Optional() options?: any) {
    const rawUrl = options?.datasources?.db?.url || process.env.DATABASE_URL;
    let effectiveUrl = rawUrl;

    if (rawUrl) {
      const paramsToAdd: string[] = [];
      if (!rawUrl.includes('connection_limit=')) {
        paramsToAdd.push('connection_limit=5');
      }
      if (!rawUrl.includes('pool_timeout=')) {
        paramsToAdd.push('pool_timeout=10');
      }
      if (!rawUrl.includes('connect_timeout=')) {
        paramsToAdd.push('connect_timeout=10');
      }

      if (paramsToAdd.length > 0) {
        const separator = rawUrl.includes('?') ? '&' : '?';
        effectiveUrl = `${rawUrl}${separator}${paramsToAdd.join('&')}`;
      }
    }

    const finalOptions: any = options ? { ...options } : {};
    if (effectiveUrl) {
      finalOptions.datasources = {
        ...(finalOptions.datasources || {}),
        db: {
          ...(finalOptions.datasources?.db || {}),
          url: effectiveUrl,
        },
      };
    }

    super(Object.keys(finalOptions).length > 0 ? finalOptions : undefined);
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Prisma connected with connection_limit=5 & pool_timeout=10s.');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

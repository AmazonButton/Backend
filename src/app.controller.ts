import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { QueueService } from './common/queues/queue.service';

@Controller()
export class AppController {
  public static isDraining = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(QueueService) private readonly queueService?: QueueService,
  ) {}

  /**
   * Kubernetes / Docker Liveness probe: returns immediate UP status & process uptime
   */
  @Get('healthz')
  getLiveness() {
    return {
      status: 'UP',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Kubernetes / Docker Readiness probe: verifies DB & Queue dependency readiness
   */
  @Get('readyz')
  async getReadiness() {
    if (AppController.isDraining) {
      throw new ServiceUnavailableException({
        status: 'UNREADY',
        checks: { server: 'DRAINING' },
        timestamp: new Date().toISOString(),
        message: 'Máy chủ đang trong tiến trình dừng dịch vụ (Draining). Không nhận thêm lưu lượng truy cập mới.',
      });
    }

    const checks: Record<string, string> = {
      database: 'DOWN',
      queue: 'DOWN',
    };

    let isDbHealthy = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'UP';
      isDbHealthy = true;
    } catch {
      checks.database = 'DOWN';
    }

    let isQueueHealthy = false;
    if (this.queueService) {
      const ready = await this.queueService.isReady();
      if (ready) {
        checks.queue = 'UP';
        isQueueHealthy = true;
      } else {
        checks.queue = 'DOWN';
      }
    } else {
      checks.queue = 'STANDALONE';
      isQueueHealthy = true;
    }

    if (!isDbHealthy || !isQueueHealthy) {
      throw new ServiceUnavailableException({
        status: 'UNREADY',
        checks,
        timestamp: new Date().toISOString(),
        message: 'Hệ thống phụ thuộc (cơ sở dữ liệu hoặc hàng đợi) tạm thời chưa sẵn sàng nhận lưu lượng truy cập',
      });
    }

    return {
      status: 'READY',
      checks,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Standard Health Check endpoints
   */
  @Get(['health', 'api/v1/health'])
  async getHealth() {
    let dbStatus = 'CONNECTED';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'DISCONNECTED';
    }

    return {
      status: dbStatus === 'CONNECTED' ? 'OK' : 'DEGRADED',
      timestamp: new Date().toISOString(),
      service: 'NestJS Smart Order Backend (BRD V2.1 Cloud Core)',
      database: {
        status: dbStatus,
      },
    };
  }

  /**
   * Diagnostic endpoint to inspect the server's public outbound egress IP
   */
  @Get(['outbound-ip', 'api/v1/outbound-ip'])
  async getOutboundIp() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
      clearTimeout(timeout);
      const data: any = await res.json();
      return {
        success: true,
        outboundIp: data.ip,
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message,
      };
    }
  }
}

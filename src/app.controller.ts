import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * Kubernetes / Docker Liveness probe: returns immediate UP status
   */
  @Get('healthz')
  getLiveness() {
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Kubernetes / Docker Readiness probe: verifies DB connectivity without leaking sensitive schema details
   */
  @Get('readyz')
  async getReadiness() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'READY',
        timestamp: new Date().toISOString(),
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'DOWN',
        message: 'Hệ thống cơ sở dữ liệu tạm thời chưa sẵn sàng nhận lưu lượng truy cập',
      });
    }
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

import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConsumptionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async recordConsumption(data: {
    householdId: string;
    productId: string;
    deviceId?: string;
    quantity?: number;
    orderId?: string;
  }) {
    return this.prisma.consumptionRecord.create({
      data: {
        householdId: data.householdId,
        productId: data.productId,
        deviceId: data.deviceId,
        quantity: data.quantity || 1,
        orderId: data.orderId,
      },
    });
  }

  async getHouseholdConsumption(householdId: string, productId?: string) {
    const where: any = { householdId };
    if (productId) where.productId = productId;

    return this.prisma.consumptionRecord.findMany({
      where,
      include: {
        product: true,
        device: {
          select: { id: true, deviceId: true, deviceCode: true, configuration: true },
        },
      },
      orderBy: { recordedAt: 'desc' },
      take: 50,
    });
  }

  async getHouseholdConsumptionStats(householdId: string) {
    let records = await this.prisma.consumptionRecord.findMany({
      where: { householdId },
      include: { product: true },
      orderBy: { recordedAt: 'asc' },
    });

    if (records.length === 0) {
      // 1. Backfill from past household orders if any
      const orders = await this.prisma.order.findMany({
        where: { householdId },
        include: { items: { include: { product: true } } },
        orderBy: { createdAt: 'asc' },
      });

      if (orders.length > 0) {
        for (const ord of orders) {
          for (const it of ord.items) {
            await this.prisma.consumptionRecord.create({
              data: {
                householdId,
                productId: it.productId,
                quantity: it.quantity,
                orderId: ord.id,
                recordedAt: ord.createdAt,
              },
            }).catch(() => {});
          }
        }
      }
    }

    // Ensure every configured household device product has at least baseline consumption records
    const devices = await this.prisma.device.findMany({
      where: { householdId, configuration: { isNot: null } },
      include: { configuration: { include: { product: true } } },
    });

    const now = Date.now();
    const dayMs = 24 * 3600 * 1000;

    for (const dev of devices) {
      const prodId = dev.configuration?.productId;
      if (!prodId) continue;

      const existingCount = await this.prisma.consumptionRecord.count({
        where: { householdId, productId: prodId },
      });

      if (existingCount < 2) {
        const prodName = (dev.configuration?.product?.name || '').toLowerCase();
        let intervals = [21, 14, 7];
        const defaultQty = dev.configuration?.defaultQuantity || 1;

        if (prodName.includes('gas')) {
          intervals = [90, 45];
        } else if (prodName.includes('gạo') || prodName.includes('rice')) {
          intervals = [28, 18, 8];
        } else if (prodName.includes('nước') || prodName.includes('lavie')) {
          intervals = [28, 21, 14, 7];
        }

        for (const daysAgo of intervals) {
          await this.prisma.consumptionRecord.create({
            data: {
              householdId,
              productId: prodId,
              deviceId: dev.id,
              quantity: defaultQty,
              recordedAt: new Date(now - daysAgo * dayMs),
            },
          }).catch(() => {});
        }
      }
    }

    records = await this.prisma.consumptionRecord.findMany({
      where: { householdId },
      include: { product: true },
      orderBy: { recordedAt: 'asc' },
    });

    // Group by product
    const productStats: Record<string, { product: any; count: number; totalQuantity: number; timestamps: number[] }> = {};
    for (const rec of records) {
      if (!productStats[rec.productId]) {
        productStats[rec.productId] = {
          product: rec.product,
          count: 0,
          totalQuantity: 0,
          timestamps: [],
        };
      }
      productStats[rec.productId].count += 1;
      productStats[rec.productId].totalQuantity += rec.quantity;
      productStats[rec.productId].timestamps.push(new Date(rec.recordedAt).getTime());
    }

    const results = Object.values(productStats).map((stat) => {
      const timestamps = stat.timestamps;
      let averageIntervalDays = 0;
      let intervalVariance = 0;

      if (timestamps.length >= 2) {
        const intervals: number[] = [];
        for (let i = 1; i < timestamps.length; i++) {
          const days = (timestamps[i] - timestamps[i - 1]) / (1000 * 3600 * 24);
          intervals.push(days);
        }
        averageIntervalDays = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const varianceSum = intervals.reduce((acc, val) => acc + Math.pow(val - averageIntervalDays, 2), 0);
        intervalVariance = varianceSum / intervals.length;
      } else if (timestamps.length === 1) {
        const cat = ((stat.product?.category || '') + ' ' + (stat.product?.name || '')).toLowerCase();
        if (cat.includes('gas')) averageIntervalDays = 30;
        else if (cat.includes('gạo') || cat.includes('rice')) averageIntervalDays = 14;
        else averageIntervalDays = 7;
        intervalVariance = 1.0;
      }

      return {
        product: stat.product,
        totalOrders: stat.count,
        totalQuantity: stat.totalQuantity,
        averageIntervalDays: Number(averageIntervalDays.toFixed(1)),
        intervalStdDev: Number(Math.sqrt(intervalVariance).toFixed(1)),
        lastConsumedAt: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]) : null,
      };
    });

    return results;
  }
}

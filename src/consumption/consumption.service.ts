import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConsumptionService {
  constructor(private readonly prisma: PrismaService) {}

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
    const records = await this.prisma.consumptionRecord.findMany({
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

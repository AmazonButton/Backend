import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConsumptionService } from '../consumption/consumption.service';

export interface PredictionInsight {
  productId: string;
  productName: string;
  unit: string;
  sampleCount: number;
  meanIntervalDays: number;
  stdDevDays: number;
  lastOrderDate: Date;
  expectedReplenishmentDate: Date;
  daysRemaining: number;
  confidenceScore: number; // 0-100%
  status: 'OPTIMAL' | 'DUE_SOON' | 'OVERDUE';
  explanation: string;
}

@Injectable()
export class PredictionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consumptionService: ConsumptionService,
  ) {}

  async calculateHouseholdPredictions(householdId: string): Promise<PredictionInsight[]> {
    const stats = await this.consumptionService.getHouseholdConsumptionStats(householdId);
    const now = Date.now();
    const insights: PredictionInsight[] = [];

    for (const item of stats) {
      if (!item.lastConsumedAt || item.averageIntervalDays <= 0) continue;

      const lastTime = new Date(item.lastConsumedAt).getTime();
      const intervalMs = item.averageIntervalDays * 24 * 3600 * 1000;
      const expectedTime = lastTime + intervalMs;
      const daysRemaining = Number(((expectedTime - now) / (24 * 3600 * 1000)).toFixed(1));

      // Confidence score calculation:
      // High sample size + low standard deviation => high confidence
      const sampleWeight = Math.min(1.0, item.totalOrders / 4); // Maxes out at 4+ records
      const consistencyWeight = Math.max(0.4, 1.0 - (item.intervalStdDev / (item.averageIntervalDays || 1)) * 0.5);
      const confidence = Math.min(98, Math.max(45, Math.round(sampleWeight * consistencyWeight * 100)));

      let status: 'OPTIMAL' | 'DUE_SOON' | 'OVERDUE' = 'OPTIMAL';
      if (daysRemaining <= 0) {
        status = 'OVERDUE';
      } else if (daysRemaining <= 3) {
        status = 'DUE_SOON';
      }

      const explanation = `Dựa trên chu kỳ tiêu dùng trung bình ${item.averageIntervalDays} ngày qua ${item.totalOrders} đơn gần nhất (độ lệch chuẩn ±${item.intervalStdDev} ngày). Dự kiến hết hàng vào ${new Date(expectedTime).toLocaleDateString('vi-VN')}.`;

      insights.push({
        productId: item.product.id,
        productName: item.product.name,
        unit: item.product.unit,
        sampleCount: item.totalOrders,
        meanIntervalDays: item.averageIntervalDays,
        stdDevDays: item.intervalStdDev,
        lastOrderDate: item.lastConsumedAt,
        expectedReplenishmentDate: new Date(expectedTime),
        daysRemaining,
        confidenceScore: confidence,
        status,
        explanation,
      });

      // Synchronize Smart Reminder in database if due soon or overdue
      if (status === 'DUE_SOON' || status === 'OVERDUE') {
        const existingReminder = await this.prisma.smartReminder.findFirst({
          where: {
            householdId,
            productId: item.product.id,
            status: 'PENDING',
          },
        });

        if (!existingReminder) {
          await this.prisma.smartReminder.create({
            data: {
              householdId,
              productId: item.product.id,
              expectedDate: new Date(expectedTime),
              confidence,
              reason: explanation,
              status: 'PENDING',
            },
          });
        }
      }
    }

    return insights;
  }
}

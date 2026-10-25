import { SubscriptionPlanResponseDto } from './subscription-plan-response.dto';

export class StoreSubscriptionResponseDto {
  subscriptionId: string;
  storeId: string;
  planId: string;
  plan: SubscriptionPlanResponseDto | null;
  startDate: Date;
  endDate: Date;
  status: string;
  paymentMethod: string;
  daysRemaining: number;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(sub: any): StoreSubscriptionResponseDto {
    const now = Date.now();
    const end = new Date(sub.endDate).getTime();
    const daysRemaining = Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));

    return {
      subscriptionId: sub.subscriptionId.toString(),
      storeId: sub.storeId.toString(),
      planId: sub.planId.toString(),
      plan: sub.plan ? SubscriptionPlanResponseDto.fromEntity(sub.plan) : null,
      startDate: sub.startDate,
      endDate: sub.endDate,
      status: sub.status,
      paymentMethod: sub.paymentMethod,
      daysRemaining,
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    };
  }
}

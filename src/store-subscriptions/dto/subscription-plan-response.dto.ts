export class SubscriptionPlanResponseDto {
  planId: string;
  planCode: string;
  planName: string;
  description: string | null;
  price: number;
  durationDays: number;
  maxProducts: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(plan: any): SubscriptionPlanResponseDto {
    return {
      planId: plan.planId.toString(),
      planCode: plan.planCode,
      planName: plan.planName,
      description: plan.description || null,
      price: Number(plan.price),
      durationDays: plan.durationDays,
      maxProducts: plan.maxProducts,
      isActive: Boolean(plan.isActive),
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }
}

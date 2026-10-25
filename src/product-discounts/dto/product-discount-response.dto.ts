export class ProductDiscountResponseDto {
  discountId: string;
  productId: string;
  discountPercent: number | null;
  discountAmount: number | null;
  startAt: Date;
  endAt: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(entity: any): ProductDiscountResponseDto {
    return {
      discountId: entity.discountId.toString(),
      productId: entity.productId.toString(),
      discountPercent: entity.discountPercent != null ? Number(entity.discountPercent) : null,
      discountAmount: entity.discountAmount != null ? Number(entity.discountAmount) : null,
      startAt: entity.startAt,
      endAt: entity.endAt,
      status: entity.status,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

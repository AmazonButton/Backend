export class PriceHistoryResponseDto {
  historyId: string;
  productId: string;
  oldPrice: number;
  newPrice: number;
  changedAt: Date;
  changedByUser: {
    userId: string;
    fullName: string;
    email: string | null;
  } | null;

  static fromEntity(h: any): PriceHistoryResponseDto {
    return {
      historyId: h.historyId.toString(),
      productId: h.productId.toString(),
      oldPrice: Number(h.oldPrice),
      newPrice: Number(h.newPrice),
      changedAt: h.changedAt,
      changedByUser: h.changedByUser
        ? {
            userId: h.changedByUser.userId.toString(),
            fullName: h.changedByUser.fullName,
            email: h.changedByUser.email || null,
          }
        : null,
    };
  }
}

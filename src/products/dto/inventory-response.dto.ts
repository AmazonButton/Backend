export class InventoryResponseDto {
  inventoryId: string;
  storeId: string;
  productId: string;
  productName: string;
  productCode: string;
  quantityOnHand: number;
  reservedQuantity: number;
  minStockAlert: number;
  isLowStock: boolean;
  updatedAt: Date;

  static fromEntity(inv: any): InventoryResponseDto {
    const qty = Number(inv.quantityOnHand ?? 0);
    const minAlert = Number(inv.minStockAlert ?? 5);
    return {
      inventoryId: inv.inventoryId.toString(),
      storeId: inv.storeId.toString(),
      productId: inv.productId.toString(),
      productName: inv.product?.productName || '',
      productCode: inv.product?.productCode || '',
      quantityOnHand: qty,
      reservedQuantity: Number(inv.reservedQuantity ?? 0),
      minStockAlert: minAlert,
      isLowStock: qty <= minAlert,
      updatedAt: inv.updatedAt,
    };
  }
}

/**
 * Strict Whitelist DTO Mapper for Orders
 * Prevents sensitive leaks of user credentials (passwordHash, hmacSecret, tokens, authId)
 */
export interface OrderResponseDto {
  id: string;
  orderId: string;
  orderNumber: string;
  orderCode: string;
  storeId: string;
  customerId: string;
  buttonId?: string | null;
  buttonCode?: string | null;
  orderStatus: string;
  paymentStatus: string;
  paymentMethod: string;
  totalAmount: number;
  subtotalAmount: number;
  shippingFee: number;
  discountAmount: number;
  commissionRate?: number;
  commissionAmount?: number;
  netAmount?: number;
  shippingAddress?: string | null;
  deliveryAddress?: string | null;
  notes?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  customer?: {
    customerId: string;
    fullName?: string;
    phoneNumber?: string;
    email?: string;
  };
  button?: {
    buttonId: string;
    buttonCode: string;
    deviceId: string;
    name?: string;
  };
  store?: {
    storeId: string;
    name: string;
    code?: string;
    phone?: string;
    address?: string;
  };
  items?: Array<{
    orderItemId: string;
    productId: string;
    productName: string;
    sku?: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    imageUrl?: string;
    product?: {
      productId: string;
      name: string;
      sku?: string;
      images?: Array<{
        imageId: string;
        imageUrl: string;
        isThumbnail: boolean;
      }>;
    };
  }>;
}

export function toOrderResponseDto(raw: any): OrderResponseDto {
  if (!raw) return null as any;

  const orderId = raw.orderId ? raw.orderId.toString() : raw.id ? raw.id.toString() : '';
  const orderCode = raw.orderCode || raw.orderNumber || '';

  const dto: OrderResponseDto = {
    id: orderId,
    orderId: orderId,
    orderNumber: orderCode,
    orderCode: orderCode,
    storeId: raw.storeId ? raw.storeId.toString() : '',
    customerId: raw.customerId ? raw.customerId.toString() : '',
    buttonId: raw.buttonId ? raw.buttonId.toString() : null,
    buttonCode: raw.buttonCode || raw.button?.buttonCode || null,
    orderStatus: raw.orderStatus || 'PENDING',
    paymentStatus: raw.paymentStatus || 'UNPAID',
    paymentMethod: raw.paymentMethod || 'COD',
    totalAmount: raw.totalAmount != null ? Number(raw.totalAmount) : 0,
    subtotalAmount: raw.subtotalAmount != null ? Number(raw.subtotalAmount) : (raw.totalAmount != null ? Number(raw.totalAmount) : 0),
    shippingFee: raw.shippingFee != null ? Number(raw.shippingFee) : 0,
    discountAmount: raw.discountAmount != null ? Number(raw.discountAmount) : 0,
    commissionRate: raw.commissionRate != null ? Number(raw.commissionRate) : undefined,
    commissionAmount: raw.commissionAmount != null ? Number(raw.commissionAmount) : undefined,
    netAmount: raw.netAmount != null ? Number(raw.netAmount) : undefined,
    shippingAddress: raw.shippingAddress || raw.deliveryAddress || null,
    deliveryAddress: raw.deliveryAddress || raw.shippingAddress || null,
    notes: raw.notes || null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };

  // Safe Customer mapping - NEVER leak raw User entity fields (passwordHash, authId, hmacSecret, etc.)
  if (raw.customer) {
    dto.customer = {
      customerId: raw.customer.customerId ? raw.customer.customerId.toString() : raw.customerId?.toString(),
      fullName: raw.customer.user?.fullName || raw.customer.fullName || raw.customerName,
      phoneNumber: raw.customer.user?.phone || raw.customer.phoneNumber || raw.customerPhone,
      email: raw.customer.user?.email || raw.customer.email,
    };
  }

  // Safe Store mapping
  if (raw.store) {
    dto.store = {
      storeId: raw.store.storeId ? raw.store.storeId.toString() : raw.storeId?.toString(),
      name: raw.store.name,
      code: raw.store.code,
      phone: raw.store.phone,
      address: raw.store.address,
    };
  }

  // Safe Button mapping - NEVER leak hmacSecret or deviceSecret
  if (raw.button) {
    dto.button = {
      buttonId: raw.button.buttonId ? raw.button.buttonId.toString() : (raw.buttonId ? raw.buttonId.toString() : ''),
      buttonCode: raw.button.buttonCode,
      deviceId: raw.button.deviceId,
      name: raw.button.name,
    };
  }

  // Safe Items mapping
  if (Array.isArray(raw.items)) {
    dto.items = raw.items.map((item: any) => {
      const orderItemId = item.orderItemId ? item.orderItemId.toString() : item.id ? item.id.toString() : '';
      const productId = item.productId ? item.productId.toString() : '';
      return {
        orderItemId,
        productId,
        productName: item.productName || item.product?.name || '',
        sku: item.sku || item.product?.sku,
        quantity: item.quantity != null ? Number(item.quantity) : 1,
        unitPrice: item.unitPrice != null ? Number(item.unitPrice) : 0,
        totalPrice: item.totalPrice != null ? Number(item.totalPrice) : (Number(item.quantity || 1) * Number(item.unitPrice || 0)),
        imageUrl: item.imageUrl || item.product?.images?.[0]?.imageUrl,
        product: item.product ? {
          productId: item.product.productId ? item.product.productId.toString() : productId,
          name: item.product.name,
          sku: item.product.sku,
          images: Array.isArray(item.product.images) ? item.product.images.map((img: any) => ({
            imageId: img.imageId ? img.imageId.toString() : '',
            imageUrl: img.imageUrl,
            isThumbnail: !!img.isThumbnail,
          })) : undefined,
        } : undefined,
      };
    });
  }

  return dto;
}

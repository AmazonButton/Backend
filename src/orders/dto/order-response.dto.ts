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
  shippingLatitude?: number | null;
  shippingLongitude?: number | null;
  assignedDriverId?: string | null;
  podImageUrl?: string | null;
  deliveredAt?: Date | string | null;
  failureReasonCode?: string | null;
  failureNote?: string | null;
  evidenceImageUrl?: string | null;
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
    buttonId: raw.buttonId ? raw.buttonId.toString() : (raw.button_id ? raw.button_id.toString() : null),
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
    shippingLatitude: raw.shippingLatitude != null ? Number(raw.shippingLatitude) : (raw.shipping_latitude != null ? Number(raw.shipping_latitude) : null),
    shippingLongitude: raw.shippingLongitude != null ? Number(raw.shippingLongitude) : (raw.shipping_longitude != null ? Number(raw.shipping_longitude) : null),
    assignedDriverId: raw.assignedDriverId ? raw.assignedDriverId.toString() : (raw.assigned_driver_id ? raw.assigned_driver_id.toString() : null),
    podImageUrl: raw.podImageUrl || raw.pod_image_url || null,
    deliveredAt: raw.deliveredAt || raw.delivered_at || null,
    failureReasonCode: raw.failureReasonCode || raw.failure_reason_code || null,
    failureNote: raw.failureNote || raw.failure_note || null,
    evidenceImageUrl: raw.evidenceImageUrl || raw.evidence_image_url || null,
    notes: raw.notes || raw.orderNote || null,
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
        productName: item.productNameSnapshot || item.productName || item.product?.productName || item.product?.name || '',
        sku: item.sku || item.product?.productCode || item.product?.sku,
        quantity: item.quantity != null ? Number(item.quantity) : 1,
        unitPrice: item.finalUnitPrice != null ? Number(item.finalUnitPrice) : (item.unitPriceSnapshot != null ? Number(item.unitPriceSnapshot) : Number(item.unitPrice || 0)),
        totalPrice: item.itemSubtotal != null ? Number(item.itemSubtotal) : (item.totalPrice != null ? Number(item.totalPrice) : (Number(item.quantity || 1) * Number(item.finalUnitPrice || item.unitPriceSnapshot || item.unitPrice || 0))),
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

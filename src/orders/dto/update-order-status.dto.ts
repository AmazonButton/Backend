import { IsNotEmpty, IsString, IsIn } from 'class-validator';

export const VALID_ORDER_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'READY_FOR_DELIVERY',
  'SHIPPING',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
  'DELIVERY_FAILED',
] as const;

export type OrderStatusType = (typeof VALID_ORDER_STATUSES)[number];

export const ALLOWED_ORDER_TRANSITIONS: Record<OrderStatusType, readonly OrderStatusType[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED', 'REJECTED'],
  CONFIRMED: ['PREPARING', 'CANCELLED', 'REJECTED'],
  PREPARING: ['READY_FOR_DELIVERY', 'CANCELLED'],
  READY_FOR_DELIVERY: ['SHIPPING', 'CANCELLED'],
  SHIPPING: ['DELIVERED', 'DELIVERY_FAILED', 'CANCELLED'],
  DELIVERY_FAILED: ['SHIPPING', 'CANCELLED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
};

export class UpdateOrderStatusDto {
  @IsNotEmpty({ message: 'Trạng thái đơn hàng không được để trống' })
  @IsString()
  @IsIn([...VALID_ORDER_STATUSES], {
    message: `Trạng thái phải là một trong: ${VALID_ORDER_STATUSES.join(', ')}`,
  })
  status: OrderStatusType;
}

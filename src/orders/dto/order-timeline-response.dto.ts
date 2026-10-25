export interface OrderTimelineItem {
  id: string;
  type: 'ORDER_PLACED' | 'STATUS_CHANGE' | 'PAYMENT' | 'DELIVERY';
  title: string;
  description: string;
  timestamp: Date;
  status?: string;
  actor?: string;
  metadata?: any;
}

export class OrderTimelineResponseDto {
  orderId: string;
  orderCode: string;
  orderStatus: string;
  paymentStatus: string;
  orderDate: Date;
  timeline: OrderTimelineItem[];

  static fromOrder(order: any): OrderTimelineResponseDto {
    const items: OrderTimelineItem[] = [];

    // 1. Order Placed event
    items.push({
      id: `placed_${order.orderId}`,
      type: 'ORDER_PLACED',
      title: 'Đơn hàng đã được tạo',
      description: order.buttonId
        ? `Đơn hàng tự động tạo qua nút bấm IoT ${order.button?.buttonCode || ''}`
        : 'Đơn hàng được đặt qua cửa hàng trực tuyến',
      timestamp: order.orderDate || order.createdAt,
      status: 'PENDING',
      actor: order.customer?.user?.fullName || 'Khách hàng',
    });

    // 2. Status History events
    if (order.statusHistories && Array.isArray(order.statusHistories)) {
      for (const history of order.statusHistories) {
        items.push({
          id: `status_${history.historyId || Math.random()}`,
          type: 'STATUS_CHANGE',
          title: `Chuyển trạng thái sang ${history.newStatus}`,
          description: history.reason || `Đơn hàng chuyển trạng thái sang ${history.newStatus}`,
          timestamp: history.changedAt || history.createdAt,
          status: history.newStatus,
          actor: history.changedByUserId ? `User #${history.changedByUserId}` : 'Hệ thống',
          metadata: {
            oldStatus: history.oldStatus,
            newStatus: history.newStatus,
            reason: history.reason,
          },
        });
      }
    }

    // 3. Payment Transaction events
    if (order.paymentTransactions && Array.isArray(order.paymentTransactions)) {
      for (const tx of order.paymentTransactions) {
        items.push({
          id: `payment_${tx.transactionId || Math.random()}`,
          type: 'PAYMENT',
          title: `Giao dịch thanh toán: ${tx.status}`,
          description: `Phương thức ${tx.paymentMethod}, số tiền: ${Number(tx.amount || 0).toLocaleString('vi-VN')} VND`,
          timestamp: tx.paidAt || tx.createdAt,
          status: tx.status,
          metadata: {
            transactionCode: tx.transactionCode,
            paymentMethod: tx.paymentMethod,
            amount: Number(tx.amount || 0),
          },
        });
      }
    }

    // 4. Delivery event if delivered
    if (order.deliveredAt) {
      items.push({
        id: `delivered_${order.orderId}`,
        type: 'DELIVERY',
        title: 'Đơn hàng đã giao thành công',
        description: order.assignedDriver ? `Tài xế ${order.assignedDriver.fullName} đã giao hàng` : 'Đã giao hàng thành công',
        timestamp: order.deliveredAt,
        status: 'DELIVERED',
        actor: order.assignedDriver?.fullName || 'Tài xế giao hàng',
        metadata: {
          podImageUrl: order.podImageUrl,
        },
      });
    }

    // Sort chronologically ascending
    items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return {
      orderId: order.orderId.toString(),
      orderCode: order.orderCode,
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      orderDate: order.orderDate,
      timeline: items,
    };
  }
}

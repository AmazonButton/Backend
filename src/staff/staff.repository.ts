import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class StaffRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private toNumber(val: unknown): number {
    return Number(val || 0);
  }

  async findStaffMembership(userId: bigint) {
    return this.prisma.storeStaff.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { role: true, store: true },
    });
  }

  async getOrderStaffDashboard(storeId: bigint) {
    const [countsRows, recentOrdersRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        orders_to_prepare: number;
        orders_preparing: number;
        orders_delivering: number;
        today_completed_orders: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE order_status IN ('PENDING', 'CONFIRMED'))::int AS orders_to_prepare,
          COUNT(*) FILTER (WHERE order_status = 'PREPARING')::int AS orders_preparing,
          COUNT(*) FILTER (WHERE order_status IN ('READY_FOR_DELIVERY', 'SHIPPING'))::int AS orders_delivering,
          COUNT(*) FILTER (WHERE order_status IN ('DELIVERED', 'COMPLETED') AND (completed_at >= CURRENT_DATE OR updated_at >= CURRENT_DATE))::int AS today_completed_orders
        FROM orders
        WHERE store_id = ${storeId}
      `),
      this.prisma.$queryRaw<Array<{
        order_id: bigint;
        order_code: string;
        order_status: string;
        total_amount: any;
        order_date: Date;
        shipping_recipient_name: string;
        shipping_phone: string;
      }>>(Prisma.sql`
        SELECT
          o.order_id,
          o.order_code,
          o.order_status,
          o.total_amount,
          o.order_date,
          o.shipping_recipient_name,
          o.shipping_phone
        FROM orders o
        WHERE o.store_id = ${storeId} AND o.order_status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY_FOR_DELIVERY', 'SHIPPING')
        ORDER BY o.order_date ASC
        LIMIT 10
      `),
    ]);

    const c = countsRows[0] || {
      orders_to_prepare: 0,
      orders_preparing: 0,
      orders_delivering: 0,
      today_completed_orders: 0,
    };

    return {
      role: 'STAFF_ORDER' as const,
      summary: {
        ordersToPrepare: this.toNumber(c.orders_to_prepare),
        ordersPreparing: this.toNumber(c.orders_preparing),
        ordersDelivering: this.toNumber(c.orders_delivering),
        todayCompletedOrders: this.toNumber(c.today_completed_orders),
      },
      actionableOrders: recentOrdersRows.map((o) => ({
        orderId: o.order_id.toString(),
        orderCode: o.order_code,
        orderStatus: o.order_status,
        totalAmount: this.toNumber(o.total_amount),
        orderDate: o.order_date,
        recipientName: o.shipping_recipient_name,
        phone: o.shipping_phone,
      })),
    };
  }

  async getInventoryStaffDashboard(storeId: bigint) {
    const [countsRows, criticalRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        low_stock_count: number;
        out_of_stock_count: number;
        total_products: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE i.quantity_on_hand <= i.min_stock_alert AND i.quantity_on_hand > 0)::int AS low_stock_count,
          COUNT(*) FILTER (WHERE i.quantity_on_hand <= 0)::int AS out_of_stock_count,
          COUNT(*)::int AS total_products
        FROM inventory i
        WHERE i.store_id = ${storeId}
      `),
      this.prisma.$queryRaw<Array<{
        product_id: bigint;
        product_name: string;
        product_code: string;
        quantity_on_hand: number;
        min_stock_alert: number;
      }>>(Prisma.sql`
        SELECT
          p.product_id,
          p.product_name,
          p.product_code,
          i.quantity_on_hand,
          i.min_stock_alert
        FROM inventory i
        JOIN product p ON p.product_id = i.product_id
        WHERE i.store_id = ${storeId} AND (i.quantity_on_hand <= i.min_stock_alert OR i.quantity_on_hand <= 0)
        ORDER BY i.quantity_on_hand ASC
        LIMIT 10
      `),
    ]);

    const c = countsRows[0] || { low_stock_count: 0, out_of_stock_count: 0, total_products: 0 };

    return {
      role: 'STAFF_INVENTORY' as const,
      summary: {
        lowStockCount: this.toNumber(c.low_stock_count),
        outOfStockCount: this.toNumber(c.out_of_stock_count),
        totalProducts: this.toNumber(c.total_products),
      },
      criticalItems: criticalRows.map((item) => ({
        productId: item.product_id.toString(),
        productName: item.product_name,
        productCode: item.product_code,
        quantityOnHand: this.toNumber(item.quantity_on_hand),
        minStockAlert: this.toNumber(item.min_stock_alert),
      })),
    };
  }

  async getButtonStaffDashboard(storeId: bigint) {
    const [countsRows, alertRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        total_buttons: number;
        active_buttons: number;
        low_battery_buttons: number;
        unassigned_buttons: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total_buttons,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_buttons,
          COUNT(*) FILTER (WHERE battery_level < 20)::int AS low_battery_buttons,
          COUNT(*) FILTER (WHERE customer_id IS NULL)::int AS unassigned_buttons
        FROM iot_button
        WHERE store_id = ${storeId}
      `),
      this.prisma.$queryRaw<Array<{
        button_id: bigint;
        device_id: string;
        button_code: string;
        button_name: string | null;
        status: string;
        battery_level: number;
      }>>(Prisma.sql`
        SELECT
          b.button_id,
          b.device_id,
          b.button_code,
          b.button_name,
          b.status,
          b.battery_level
        FROM iot_button b
        WHERE b.store_id = ${storeId} AND (b.battery_level < 20 OR b.status != 'ACTIVE')
        ORDER BY b.battery_level ASC
        LIMIT 10
      `),
    ]);

    const c = countsRows[0] || {
      total_buttons: 0,
      active_buttons: 0,
      low_battery_buttons: 0,
      unassigned_buttons: 0,
    };

    return {
      role: 'STAFF_BUTTON' as const,
      summary: {
        totalButtons: this.toNumber(c.total_buttons),
        activeButtons: this.toNumber(c.active_buttons),
        lowBatteryButtons: this.toNumber(c.low_battery_buttons),
        unassignedButtons: this.toNumber(c.unassigned_buttons),
      },
      deviceAlerts: alertRows.map((b) => ({
        buttonId: b.button_id.toString(),
        deviceId: b.device_id,
        buttonCode: b.button_code,
        buttonName: b.button_name,
        status: b.status,
        batteryLevel: this.toNumber(b.battery_level),
      })),
    };
  }

  async getDeliveryStaffDashboard(userId: bigint, storeId?: bigint) {
    const [countsRows, activeOrdersRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        assigned_orders_count: number;
        completed_today_count: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE order_status IN ('READY_FOR_DELIVERY', 'SHIPPING'))::int AS assigned_orders_count,
          COUNT(*) FILTER (WHERE order_status IN ('DELIVERED', 'COMPLETED') AND (completed_at >= CURRENT_DATE OR updated_at >= CURRENT_DATE))::int AS completed_today_count
        FROM orders
        WHERE assigned_driver_id = ${userId}
      `),
      this.prisma.$queryRaw<Array<{
        order_id: bigint;
        order_code: string;
        order_status: string;
        total_amount: any;
        shipping_recipient_name: string;
        shipping_phone: string;
        shipping_address: string;
        order_date: Date;
      }>>(Prisma.sql`
        SELECT
          o.order_id,
          o.order_code,
          o.order_status,
          o.total_amount,
          o.shipping_recipient_name,
          o.shipping_phone,
          o.shipping_address,
          o.order_date
        FROM orders o
        WHERE o.assigned_driver_id = ${userId} AND o.order_status IN ('READY_FOR_DELIVERY', 'SHIPPING')
        ORDER BY o.order_date ASC
        LIMIT 10
      `),
    ]);

    const c = countsRows[0] || { assigned_orders_count: 0, completed_today_count: 0 };

    return {
      role: 'STAFF_DELIVERY' as const,
      summary: {
        assignedOrdersCount: this.toNumber(c.assigned_orders_count),
        completedTodayCount: this.toNumber(c.completed_today_count),
      },
      activeOrders: activeOrdersRows.map((o) => ({
        orderId: o.order_id.toString(),
        orderCode: o.order_code,
        orderStatus: o.order_status,
        totalAmount: this.toNumber(o.total_amount),
        recipientName: o.shipping_recipient_name,
        phone: o.shipping_phone,
        address: o.shipping_address,
        orderDate: o.order_date,
      })),
    };
  }

  async getGeneralStaffDashboard(storeId: bigint) {
    const [orderDash, invDash, btnDash] = await Promise.all([
      this.getOrderStaffDashboard(storeId),
      this.getInventoryStaffDashboard(storeId),
      this.getButtonStaffDashboard(storeId),
    ]);

    return {
      role: 'STORE_STAFF' as const,
      orders: orderDash.summary,
      inventory: invDash.summary,
      buttons: btnDash.summary,
      recentActionableOrders: orderDash.actionableOrders.slice(0, 5),
    };
  }
}

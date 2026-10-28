import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class CustomersRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private toNumber(val: unknown): number {
    return Number(val || 0);
  }

  async getCustomerProfileByUserId(userId: bigint) {
    return this.prisma.customerProfile.findUnique({
      where: { userId },
    });
  }

  async getCustomerDashboard(userId: bigint) {
    const profile = await this.getCustomerProfileByUserId(userId);
    const customerId = profile?.customerId;

    const [ordersSummaryRows, recentOrdersRows, connectedStoresRows, devicesRows, rentalsRows, unreadNotifCount] =
      await Promise.all([
        customerId
          ? this.prisma.$queryRaw<Array<{
              total: number;
              pending: number;
              delivering: number;
              completed: number;
              cancelled: number;
              total_spent: any;
            }>>(Prisma.sql`
              SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE order_status IN ('PENDING', 'CONFIRMED'))::int AS pending,
                COUNT(*) FILTER (WHERE order_status IN ('PREPARING', 'READY_FOR_DELIVERY', 'SHIPPING'))::int AS delivering,
                COUNT(*) FILTER (WHERE order_status IN ('DELIVERED', 'COMPLETED'))::int AS completed,
                COUNT(*) FILTER (WHERE order_status IN ('CANCELLED', 'REJECTED', 'DELIVERY_FAILED'))::int AS cancelled,
                COALESCE(SUM(total_amount) FILTER (WHERE order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS total_spent
              FROM orders
              WHERE customer_id = ${customerId}
            `)
          : [{ total: 0, pending: 0, delivering: 0, completed: 0, cancelled: 0, total_spent: 0 }],

        customerId
          ? this.prisma.$queryRaw<Array<{
              order_id: bigint;
              order_code: string;
              order_status: string;
              total_amount: any;
              order_date: Date;
              store_name: string;
              store_id: bigint;
              items_count: number;
            }>>(Prisma.sql`
              SELECT
                o.order_id,
                o.order_code,
                o.order_status,
                o.total_amount,
                o.order_date,
                s.name AS store_name,
                s.store_id,
                (SELECT COUNT(*)::int FROM order_item oi WHERE oi.order_id = o.order_id) AS items_count
              FROM orders o
              JOIN store s ON s.store_id = o.store_id
              WHERE o.customer_id = ${customerId}
              ORDER BY o.order_date DESC
              LIMIT 5
            `)
          : [],

        customerId
          ? this.prisma.$queryRaw<Array<{
              store_id: bigint;
              name: string;
              code: string;
              logo_url: string | null;
            }>>(Prisma.sql`
              SELECT DISTINCT
                s.store_id,
                s.name,
                s.code,
                NULL::text AS logo_url
              FROM orders o
              JOIN store s ON s.store_id = o.store_id
              WHERE o.customer_id = ${customerId}
              LIMIT 10
            `)
          : [],

        customerId
          ? this.prisma.$queryRaw<Array<{
              total: number;
              active: number;
              low_battery: number;
            }>>(Prisma.sql`
              SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                COUNT(*) FILTER (WHERE battery_level < 20)::int AS low_battery
              FROM iot_button
              WHERE customer_id = ${customerId}
            `)
          : [{ total: 0, active: 0, low_battery: 0 }],

        customerId
          ? this.prisma.$queryRaw<Array<{
              total: number;
              active: number;
              expiring_soon: number;
            }>>(Prisma.sql`
              SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                COUNT(*) FILTER (WHERE status = 'ACTIVE' AND end_date <= NOW() + INTERVAL '7 days')::int AS expiring_soon
              FROM button_rentals
              WHERE customer_id = ${customerId}
            `)
          : [{ total: 0, active: 0, expiring_soon: 0 }],

        this.prisma.notification.count({
          where: {
            userId,
            readAt: null,
          },
        }),
      ]);

    const sum = ordersSummaryRows[0] || {
      total: 0,
      pending: 0,
      delivering: 0,
      completed: 0,
      cancelled: 0,
      total_spent: 0,
    };
    const dev = devicesRows[0] || { total: 0, active: 0, low_battery: 0 };
    const rent = rentalsRows[0] || { total: 0, active: 0, expiring_soon: 0 };

    return {
      ordersSummary: {
        total: this.toNumber(sum.total),
        pending: this.toNumber(sum.pending),
        delivering: this.toNumber(sum.delivering),
        completed: this.toNumber(sum.completed),
        cancelled: this.toNumber(sum.cancelled),
        totalSpent: this.toNumber(sum.total_spent),
      },
      recentOrders: recentOrdersRows.map((o) => ({
        orderId: o.order_id.toString(),
        orderCode: o.order_code,
        orderStatus: o.order_status,
        totalAmount: this.toNumber(o.total_amount),
        orderDate: o.order_date,
        storeId: o.store_id.toString(),
        storeName: o.store_name,
        itemsCount: this.toNumber(o.items_count),
      })),
      connectedStores: connectedStoresRows.map((s) => ({
        storeId: s.store_id.toString(),
        name: s.name,
        code: s.code,
        logoUrl: s.logo_url,
      })),
      devices: {
        total: this.toNumber(dev.total),
        active: this.toNumber(dev.active),
        lowBattery: this.toNumber(dev.low_battery),
      },
      rentals: {
        total: this.toNumber(rent.total),
        active: this.toNumber(rent.active),
        expiringSoon: this.toNumber(rent.expiring_soon),
      },
      unreadNotificationsCount: unreadNotifCount,
    };
  }

  async getCustomerOrdersAnalytics(
    userId: bigint,
    dateRange: { fromDate?: Date; toDateExclusive?: Date } = {},
  ) {
    const profile = await this.getCustomerProfileByUserId(userId);
    const customerId = profile?.customerId;
    if (!customerId) {
      return { timeline: [], statusBreakdown: [], topProducts: [] };
    }

    const conditions: Prisma.Sql[] = [Prisma.sql`o.customer_id = ${customerId}`];
    if (dateRange.fromDate) conditions.push(Prisma.sql`o.order_date >= ${dateRange.fromDate}`);
    if (dateRange.toDateExclusive) conditions.push(Prisma.sql`o.order_date < ${dateRange.toDateExclusive}`);
    const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

    const [timelineRows, statusRows, topProductRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ period: string; count: number; spent: any }>>(Prisma.sql`
        SELECT
          to_char(date_trunc('day', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') AS period,
          COUNT(*)::int AS count,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS spent
        FROM orders o
        ${whereClause}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      this.prisma.$queryRaw<Array<{ order_status: string; count: number }>>(Prisma.sql`
        SELECT
          o.order_status,
          COUNT(*)::int AS count
        FROM orders o
        ${whereClause}
        GROUP BY 1
      `),
      this.prisma.$queryRaw<Array<{ product_name: string; total_quantity: number; total_spent: any }>>(Prisma.sql`
        SELECT
          oi.product_name_snapshot AS product_name,
          SUM(oi.quantity)::int AS total_quantity,
          SUM(oi.item_subtotal)::numeric AS total_spent
        FROM order_item oi
        JOIN orders o ON o.order_id = oi.order_id
        ${whereClause}
        GROUP BY 1
        ORDER BY total_quantity DESC
        LIMIT 10
      `),
    ]);

    return {
      timeline: timelineRows.map((t) => ({
        period: t.period,
        count: this.toNumber(t.count),
        spent: this.toNumber(t.spent),
      })),
      statusBreakdown: statusRows.map((s) => ({
        status: s.order_status,
        count: this.toNumber(s.count),
      })),
      topProducts: topProductRows.map((p) => ({
        productName: p.product_name,
        totalQuantity: this.toNumber(p.total_quantity),
        totalSpent: this.toNumber(p.total_spent),
      })),
    };
  }

  async getCustomerDevicesAnalytics(userId: bigint) {
    const profile = await this.getCustomerProfileByUserId(userId);
    const customerId = profile?.customerId;
    if (!customerId) return { devices: [] };

    const devices = await this.prisma.ioTButton.findMany({
      where: { customerId },
      include: {
        store: { select: { storeId: true, name: true, code: true } },
        deployedTemplate: { select: { templateId: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      devices: devices.map((d) => ({
        buttonId: d.buttonId.toString(),
        deviceId: d.deviceId,
        buttonCode: d.buttonCode,
        buttonName: d.buttonName,
        status: d.status,
        batteryLevel: d.batteryLevel,
        storeId: d.storeId.toString(),
        storeName: d.store?.name || null,
        deployedTemplate: d.deployedTemplate?.name || null,
        installedAt: d.installedAt,
      })),
    };
  }

  async getCustomerRentalsAnalytics(userId: bigint) {
    const profile = await this.getCustomerProfileByUserId(userId);
    const customerId = profile?.customerId;
    if (!customerId) return { rentals: [] };

    const rentals = await this.prisma.buttonRental.findMany({
      where: { customerId },
      include: {
        package: true,
        buttons: { select: { buttonId: true, deviceId: true, buttonCode: true, status: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      rentals: rentals.map((r) => ({
        rentalId: r.rentalId.toString(),
        status: r.status,
        packageName: r.package?.packageName || null,
        monthlyPrice: this.toNumber(r.package?.monthlyPrice),
        depositAmount: this.toNumber(r.depositAmount),
        totalRentAmount: this.toNumber(r.totalRentAmount),
        startDate: r.startDate,
        endDate: r.endDate,
        assignedButtonsCount: r.buttons?.length || 0,
        buttons: r.buttons?.map((b) => ({
          buttonId: b.buttonId.toString(),
          deviceId: b.deviceId,
          buttonCode: b.buttonCode,
          status: b.status,
        })) || [],
      })),
    };
  }
}

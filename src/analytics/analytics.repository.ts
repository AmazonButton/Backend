import { Injectable, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsDateRange, calculateGrowth } from './utils/analytics-date-range.util';

type AnalyticsGroupBy = 'day' | 'week' | 'month';

interface SummaryRow {
  total_orders: number | bigint;
  gmv: Prisma.Decimal | string | number | null;
  realized_revenue: Prisma.Decimal | string | number | null;
  platform_commission: Prisma.Decimal | string | number | null;
  net_revenue: Prisma.Decimal | string | number | null;
}

interface ChartRow extends SummaryRow {
  period: string;
  completed_orders: number | bigint;
  cancelled_orders: number | bigint;
  cancelled_amount: Prisma.Decimal | string | number | null;
}

interface DeviceRow {
  total_devices: number | bigint;
  active_devices: number | bigint;
  inactive_devices: number | bigint;
  low_battery_devices: number | bigint;
  unassigned_devices: number | bigint;
}

const toNumber = (value: unknown): number => Number(value || 0);

@Injectable()
export class AnalyticsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getDashboardData(
    storeId?: bigint,
    dateRange: AnalyticsDateRange = {},
    groupBy: AnalyticsGroupBy = 'day',
  ) {
    const orderConditions: Prisma.Sql[] = [];
    if (storeId) orderConditions.push(Prisma.sql`o.store_id = ${storeId}`);
    if (dateRange.fromDate) orderConditions.push(Prisma.sql`o.order_date >= ${dateRange.fromDate}`);
    if (dateRange.toDateExclusive) {
      orderConditions.push(Prisma.sql`o.order_date < ${dateRange.toDateExclusive}`);
    }
    const orderWhere = orderConditions.length
      ? Prisma.sql`WHERE ${Prisma.join(orderConditions, ' AND ')}`
      : Prisma.empty;

    const paidConditions = [Prisma.sql`pt.status = 'PAID'`, ...orderConditions];
    const paidWhere = Prisma.sql`WHERE ${Prisma.join(paidConditions, ' AND ')}`;
    const deviceWhere = storeId ? Prisma.sql`WHERE b.store_id = ${storeId}` : Prisma.empty;

    const periodExpression: Record<AnalyticsGroupBy, Prisma.Sql> = {
      day: Prisma.sql`to_char(date_trunc('day', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD')`,
      week: Prisma.sql`to_char(date_trunc('week', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'IYYY-"W"IW')`,
      month: Prisma.sql`to_char(date_trunc('month', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM')`,
    };
    const period = periodExpression[groupBy];

    const [summaryRows, chartRows, deviceRows, paidRows] = await Promise.all([
      this.prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total_orders,
          COALESCE(SUM(o.total_amount) FILTER (
            WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')
          ), 0)::numeric AS gmv,
          COALESCE(SUM(o.total_amount) FILTER (
            WHERE o.order_status IN ('DELIVERED', 'COMPLETED')
          ), 0)::numeric AS realized_revenue,
          COALESCE(SUM(o.commission_amount) FILTER (
            WHERE o.order_status IN ('DELIVERED', 'COMPLETED')
          ), 0)::numeric AS platform_commission,
          COALESCE(SUM(o.net_amount) FILTER (
            WHERE o.order_status IN ('DELIVERED', 'COMPLETED')
          ), 0)::numeric AS net_revenue
        FROM orders o
        ${orderWhere}
      `),
      this.prisma.$queryRaw<ChartRow[]>(Prisma.sql`
        SELECT
          ${period} AS period,
          COUNT(*)::int AS total_orders,
          COALESCE(SUM(o.total_amount) FILTER (
            WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')
          ), 0)::numeric AS gmv,
          COALESCE(SUM(o.total_amount) FILTER (
            WHERE o.order_status IN ('DELIVERED', 'COMPLETED')
          ), 0)::numeric AS realized_revenue,
          COALESCE(SUM(o.commission_amount) FILTER (
            WHERE o.order_status IN ('DELIVERED', 'COMPLETED')
          ), 0)::numeric AS platform_commission,
          COALESCE(SUM(o.net_amount) FILTER (
            WHERE o.order_status IN ('DELIVERED', 'COMPLETED')
          ), 0)::numeric AS net_revenue,
          COALESCE(SUM(o.total_amount) FILTER (
            WHERE o.order_status = 'CANCELLED'
          ), 0)::numeric AS cancelled_amount,
          COUNT(*) FILTER (
            WHERE o.order_status IN ('DELIVERED', 'COMPLETED')
          )::int AS completed_orders,
          COUNT(*) FILTER (WHERE o.order_status = 'CANCELLED')::int AS cancelled_orders
        FROM orders o
        ${orderWhere}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      this.prisma.$queryRaw<DeviceRow[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total_devices,
          COUNT(*) FILTER (WHERE b.status = 'ACTIVE')::int AS active_devices,
          COUNT(*) FILTER (WHERE b.status <> 'ACTIVE')::int AS inactive_devices,
          COUNT(*) FILTER (WHERE b.battery_level <= 20)::int AS low_battery_devices,
          COUNT(*) FILTER (
            WHERE b.customer_id IS NULL
               OR NOT EXISTS (
                 SELECT 1 FROM button_product bp WHERE bp.button_id = b.button_id
               )
          )::int AS unassigned_devices
        FROM iot_button b
        ${deviceWhere}
      `),
      this.prisma.$queryRaw<Array<{ paid_revenue: Prisma.Decimal | string | number | null }>>(Prisma.sql`
        SELECT COALESCE(SUM(pt.amount), 0)::numeric AS paid_revenue
        FROM payment_transaction pt
        INNER JOIN orders o ON o.order_id = pt.order_id
        ${paidWhere}
      `),
    ]);

    const summaryRow = summaryRows[0];
    const deviceRow = deviceRows[0];

    return {
      summary: {
        totalOrders: toNumber(summaryRow?.total_orders),
        gmv: toNumber(summaryRow?.gmv),
        realizedRevenue: toNumber(summaryRow?.realized_revenue),
        platformCommission: toNumber(summaryRow?.platform_commission),
        netRevenue: toNumber(summaryRow?.net_revenue),
        paidRevenue: toNumber(paidRows[0]?.paid_revenue),
      },
      devices: {
        totalDevices: toNumber(deviceRow?.total_devices),
        activeDevices: toNumber(deviceRow?.active_devices),
        inactiveDevices: toNumber(deviceRow?.inactive_devices),
        lowBatteryDevices: toNumber(deviceRow?.low_battery_devices),
        unassignedDevices: toNumber(deviceRow?.unassigned_devices),
      },
      chartData: chartRows.map((row) => ({
        period: row.period,
        date: row.period,
        totalOrders: toNumber(row.total_orders),
        orderCount: toNumber(row.total_orders),
        gmv: toNumber(row.gmv),
        realizedRevenue: toNumber(row.realized_revenue),
        platformCommission: toNumber(row.platform_commission),
        netRevenue: toNumber(row.net_revenue),
        completedOrders: toNumber(row.completed_orders),
        cancelledOrders: toNumber(row.cancelled_orders),
        cancelledAmount: toNumber(row.cancelled_amount),
      })),
    };
  }

  async getStoreExtendedData(
    storeId?: bigint,
    dateRange: AnalyticsDateRange = {},
    compareWith?: 'previous-period',
  ) {
    const orderConditions: Prisma.Sql[] = [];
    if (storeId) orderConditions.push(Prisma.sql`o.store_id = ${storeId}`);
    if (dateRange.fromDate) orderConditions.push(Prisma.sql`o.order_date >= ${dateRange.fromDate}`);
    if (dateRange.toDateExclusive) orderConditions.push(Prisma.sql`o.order_date < ${dateRange.toDateExclusive}`);

    const orderWhere = orderConditions.length
      ? Prisma.sql`WHERE ${Prisma.join(orderConditions, ' AND ')}`
      : Prisma.empty;

    const [orderFunnelRows, inventoryRows, customerRows, deliveryRows, walletRows, delayedRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        total: number;
        pending: number;
        confirmed: number;
        preparing: number;
        ready: number;
        delivering: number;
        delivered: number;
        cancelled: number;
        rejected: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE o.order_status = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE o.order_status = 'CONFIRMED')::int AS confirmed,
          COUNT(*) FILTER (WHERE o.order_status = 'PREPARING')::int AS preparing,
          COUNT(*) FILTER (WHERE o.order_status = 'READY_FOR_DELIVERY')::int AS ready,
          COUNT(*) FILTER (WHERE o.order_status = 'SHIPPING')::int AS delivering,
          COUNT(*) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED'))::int AS delivered,
          COUNT(*) FILTER (WHERE o.order_status = 'CANCELLED')::int AS cancelled,
          COUNT(*) FILTER (WHERE o.order_status = 'REJECTED')::int AS rejected,
          COUNT(*) FILTER (WHERE o.order_status = 'DELIVERY_FAILED')::int AS delivery_failed
        FROM orders o
        ${orderWhere}
      `),
      this.prisma.$queryRaw<Array<{
        total_products: number;
        low_stock: number;
        out_of_stock: number;
        estimated_inventory_value: Prisma.Decimal | string | number | null;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total_products,
          COUNT(*) FILTER (WHERE i.quantity_on_hand <= i.min_stock_alert AND i.quantity_on_hand > 0)::int AS low_stock,
          COUNT(*) FILTER (WHERE i.quantity_on_hand = 0)::int AS out_of_stock,
          COALESCE(SUM(i.quantity_on_hand * p.base_price), 0)::numeric AS estimated_inventory_value
        FROM inventory i
        INNER JOIN product p ON p.product_id = i.product_id
        ${storeId ? Prisma.sql`WHERE i.store_id = ${storeId}` : Prisma.empty}
      `),
      this.prisma.$queryRaw<Array<{
        total_customers: number;
        new_customers: number;
        repeat_customers: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(DISTINCT o.customer_id)::int AS total_customers,
          COUNT(DISTINCT o.customer_id) FILTER (
            WHERE NOT EXISTS (
              SELECT 1 FROM orders prev
              WHERE prev.customer_id = o.customer_id
                ${storeId ? Prisma.sql`AND prev.store_id = ${storeId}` : Prisma.empty}
                AND prev.order_date < o.order_date
            )
          )::int AS new_customers,
          COUNT(DISTINCT o.customer_id) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM orders prev
              WHERE prev.customer_id = o.customer_id
                ${storeId ? Prisma.sql`AND prev.store_id = ${storeId}` : Prisma.empty}
                AND prev.order_date < o.order_date
            )
          )::int AS repeat_customers
        FROM orders o
        ${orderWhere}
      `),
      this.prisma.$queryRaw<Array<{
        available_drivers: number;
        open_shifts: number;
        failed_deliveries: number;
      }>>(Prisma.sql`
        SELECT
          (SELECT COUNT(*)::int FROM driver_duties dd WHERE dd.status = 'ONLINE' ${storeId ? Prisma.sql`AND dd.store_id = ${storeId}` : Prisma.empty}) AS available_drivers,
          (SELECT COUNT(*)::int FROM driver_shifts ds WHERE ds.status = 'OPEN' ${storeId ? Prisma.sql`AND ds.store_id = ${storeId}` : Prisma.empty}) AS open_shifts,
          (SELECT COUNT(*)::int FROM orders o WHERE o.order_status = 'DELIVERY_FAILED' ${storeId ? Prisma.sql`AND o.store_id = ${storeId}` : Prisma.empty}) AS failed_deliveries
      `),
      storeId ? this.prisma.$queryRaw<Array<{
        balance: Prisma.Decimal | string | number | null;
        frozen_balance: Prisma.Decimal | string | number | null;
        pending_withdrawals: Prisma.Decimal | string | number | null;
      }>>(Prisma.sql`
        SELECT
          COALESCE(w.balance, 0)::numeric AS balance,
          COALESCE(w.frozen_balance, 0)::numeric AS frozen_balance,
          COALESCE((
            SELECT SUM(sw.amount)
            FROM store_withdrawals sw
            WHERE sw.status = 'PENDING' AND sw.store_id = ${storeId}
          ), 0)::numeric AS pending_withdrawals
        FROM store_wallets w
        WHERE w.store_id = ${storeId}
        LIMIT 1
      `) : Promise.resolve([]),
      this.prisma.$queryRaw<Array<{ delayed_count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS delayed_count
        FROM orders o
        WHERE o.order_status = 'PREPARING'
          AND o.updated_at < NOW() - INTERVAL '30 minutes'
          ${storeId ? Prisma.sql`AND o.store_id = ${storeId}` : Prisma.empty}
      `),
    ]);

    const funnel = orderFunnelRows[0] || {
      total: 0, pending: 0, confirmed: 0, preparing: 0, ready: 0, delivering: 0, delivered: 0, cancelled: 0, rejected: 0, delivery_failed: 0,
    };
    const inv = inventoryRows[0] || { total_products: 0, low_stock: 0, out_of_stock: 0, estimated_inventory_value: 0 };
    const cust = customerRows[0] || { total_customers: 0, new_customers: 0, repeat_customers: 0 };
    const deliv = deliveryRows[0] || { available_drivers: 0, open_shifts: 0, failed_deliveries: 0 };
    const wal = walletRows[0] || { balance: 0, frozen_balance: 0, pending_withdrawals: 0 };
    const delayedCount = delayedRows[0]?.delayed_count || 0;

    const totalCust = toNumber(cust.total_customers);
    const repeatCust = toNumber(cust.repeat_customers);
    const repeatRate = totalCust > 0 ? Number(((repeatCust / totalCust) * 100).toFixed(2)) : 0;

    const alerts: Array<{ type: string; message: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; count?: number }> = [];
    if (inv.low_stock > 0) {
      alerts.push({ type: 'LOW_STOCK', message: `Có ${inv.low_stock} sản phẩm dưới mức cảnh báo tồn kho`, severity: 'WARNING', count: inv.low_stock });
    }
    if (inv.out_of_stock > 0) {
      alerts.push({ type: 'OUT_OF_STOCK', message: `Có ${inv.out_of_stock} sản phẩm đã hết hàng`, severity: 'CRITICAL', count: inv.out_of_stock });
    }
    if (delayedCount > 0) {
      alerts.push({ type: 'DELAYED_ORDERS', message: `Có ${delayedCount} đơn hàng đang xử lý quá 30 phút`, severity: 'CRITICAL', count: delayedCount });
    }
    if (toNumber(wal.pending_withdrawals) > 0) {
      alerts.push({ type: 'PENDING_WITHDRAWAL', message: `Đang có yêu cầu rút tiền chờ xử lý`, severity: 'INFO' });
    }

    let comparison = null;
    if (compareWith === 'previous-period' && dateRange.fromDate && dateRange.toDateExclusive) {
      const durationMs = dateRange.toDateExclusive.getTime() - dateRange.fromDate.getTime();
      const prevTo = new Date(dateRange.fromDate.getTime());
      const prevFrom = new Date(prevTo.getTime() - durationMs);
      const [curRows, prevRows] = await Promise.all([
        this.prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
          SELECT
            COUNT(*)::int AS total_orders,
            COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS gmv,
            COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS realized_revenue,
            COALESCE(SUM(o.net_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS net_revenue
          FROM orders o
          WHERE ${storeId ? Prisma.sql`o.store_id = ${storeId} AND` : Prisma.empty}
            o.order_date >= ${dateRange.fromDate} AND o.order_date < ${dateRange.toDateExclusive}
        `),
        this.prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
          SELECT
            COUNT(*)::int AS total_orders,
            COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS gmv,
            COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS realized_revenue,
            COALESCE(SUM(o.net_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS net_revenue
          FROM orders o
          WHERE ${storeId ? Prisma.sql`o.store_id = ${storeId} AND` : Prisma.empty}
            o.order_date >= ${prevFrom} AND o.order_date < ${prevTo}
        `),
      ]);
      const cur = curRows[0];
      const curGmv = toNumber(cur?.gmv);
      const curOrders = toNumber(cur?.total_orders);
      const curRealized = toNumber(cur?.realized_revenue);
      const curNet = toNumber(cur?.net_revenue);

      const prev = prevRows[0];
      const prevGmv = toNumber(prev?.gmv);
      const prevOrders = toNumber(prev?.total_orders);
      const prevRealized = toNumber(prev?.realized_revenue);
      const prevNet = toNumber(prev?.net_revenue);

      comparison = {
        previousPeriod: { fromDate: prevFrom.toISOString(), toDate: prevTo.toISOString() },
        ordersGrowth: calculateGrowth(curOrders, prevOrders),
        gmvGrowth: calculateGrowth(curGmv, prevGmv),
        realizedGrowth: calculateGrowth(curRealized, prevRealized),
        netRevenueGrowth: calculateGrowth(curNet, prevNet),
      };
    }

    return {
      orders: {
        total: toNumber(funnel.total),
        pending: toNumber(funnel.pending),
        confirmed: toNumber(funnel.confirmed),
        preparing: toNumber(funnel.preparing),
        ready: toNumber(funnel.ready),
        delivering: toNumber(funnel.delivering),
        delivered: toNumber(funnel.delivered),
        cancelled: toNumber(funnel.cancelled),
        rejected: toNumber(funnel.rejected),
        deliveryFailed: toNumber((funnel as any).delivery_failed),
      },
      inventory: {
        totalProducts: toNumber(inv.total_products),
        lowStock: toNumber(inv.low_stock),
        outOfStock: toNumber(inv.out_of_stock),
        estimatedInventoryValue: toNumber(inv.estimated_inventory_value),
      },
      customers: {
        total: totalCust,
        new: toNumber(cust.new_customers),
        repeat: repeatCust,
        repeatRate,
      },
      delivery: {
        availableDrivers: toNumber(deliv.available_drivers),
        openShifts: toNumber(deliv.open_shifts),
        failedDeliveries: toNumber(deliv.failed_deliveries),
      },
      wallet: {
        balance: toNumber(wal.balance),
        frozenBalance: toNumber(wal.frozen_balance),
        pendingWithdrawals: toNumber(wal.pending_withdrawals),
      },
      alerts,
      comparison,
    };
  }

  async getOrderAnalytics(storeId: bigint, dateRange: AnalyticsDateRange = {}, groupBy: AnalyticsGroupBy = 'day') {
    const orderConditions: Prisma.Sql[] = [Prisma.sql`o.store_id = ${storeId}`];
    if (dateRange.fromDate) orderConditions.push(Prisma.sql`o.order_date >= ${dateRange.fromDate}`);
    if (dateRange.toDateExclusive) orderConditions.push(Prisma.sql`o.order_date < ${dateRange.toDateExclusive}`);
    const orderWhere = Prisma.sql`WHERE ${Prisma.join(orderConditions, ' AND ')}`;

    const periodExpression: Record<AnalyticsGroupBy, Prisma.Sql> = {
      day: Prisma.sql`to_char(date_trunc('day', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD')`,
      week: Prisma.sql`to_char(date_trunc('week', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'IYYY-"W"IW')`,
      month: Prisma.sql`to_char(date_trunc('month', o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM')`,
    };

    const [summaryRows, paymentMethodRows, timelineRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        total_orders: number;
        completed_orders: number;
        cancelled_orders: number;
        rejected_orders: number;
        gmv: Prisma.Decimal | string | number | null;
        realized_revenue: Prisma.Decimal | string | number | null;
        avg_order_value: Prisma.Decimal | string | number | null;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total_orders,
          COUNT(*) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED'))::int AS completed_orders,
          COUNT(*) FILTER (WHERE o.order_status = 'CANCELLED')::int AS cancelled_orders,
          COUNT(*) FILTER (WHERE o.order_status = 'REJECTED')::int AS rejected_orders,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS gmv,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS realized_revenue,
          COALESCE(AVG(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS avg_order_value
        FROM orders o
        ${orderWhere}
      `),
      this.prisma.$queryRaw<Array<{ payment_method: string; count: number; total_amount: Prisma.Decimal | string | number }>>(Prisma.sql`
        SELECT
          COALESCE(o.payment_method, 'COD') AS payment_method,
          COUNT(*)::int AS count,
          COALESCE(SUM(o.total_amount), 0)::numeric AS total_amount
        FROM orders o
        ${orderWhere}
        GROUP BY 1
        ORDER BY count DESC
      `),
      this.prisma.$queryRaw<Array<{ period: string; orders: number; revenue: Prisma.Decimal | string | number }>>(Prisma.sql`
        SELECT
          ${periodExpression[groupBy]} AS period,
          COUNT(*)::int AS orders,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS revenue
        FROM orders o
        ${orderWhere}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
    ]);

    const s = summaryRows[0] || {
      total_orders: 0, completed_orders: 0, cancelled_orders: 0, rejected_orders: 0, gmv: 0, realized_revenue: 0, avg_order_value: 0,
    };
    const totalOrders = toNumber(s.total_orders);
    const cancelledOrders = toNumber(s.cancelled_orders);
    const rejectedOrders = toNumber(s.rejected_orders);

    return {
      totalOrders,
      completedOrders: toNumber(s.completed_orders),
      cancelledOrders,
      rejectedOrders,
      cancellationRate: totalOrders > 0 ? Number(((cancelledOrders / totalOrders) * 100).toFixed(2)) : 0,
      rejectionRate: totalOrders > 0 ? Number(((rejectedOrders / totalOrders) * 100).toFixed(2)) : 0,
      gmv: toNumber(s.gmv),
      realizedRevenue: toNumber(s.realized_revenue),
      averageOrderValue: toNumber(s.avg_order_value),
      paymentMethods: paymentMethodRows.map((r) => ({
        method: r.payment_method,
        count: toNumber(r.count),
        totalAmount: toNumber(r.total_amount),
      })),
      timeline: timelineRows.map((r) => ({
        period: r.period,
        orders: toNumber(r.orders),
        revenue: toNumber(r.revenue),
      })),
    };
  }

  async getProductAnalytics(
    storeId: bigint,
    dateRange: AnalyticsDateRange = {},
    options: { limit?: number; categoryId?: bigint } = {},
  ) {
    const limit = Math.min(options.limit || 10, 100);
    const orderConditions: Prisma.Sql[] = [Prisma.sql`o.store_id = ${storeId}`];
    if (dateRange.fromDate) orderConditions.push(Prisma.sql`o.order_date >= ${dateRange.fromDate}`);
    if (dateRange.toDateExclusive) orderConditions.push(Prisma.sql`o.order_date < ${dateRange.toDateExclusive}`);
    orderConditions.push(Prisma.sql`o.order_status NOT IN ('CANCELLED', 'REJECTED')`);
    const orderWhere = Prisma.sql`WHERE ${Prisma.join(orderConditions, ' AND ')}`;

    const [topProducts, slowProducts, categoryRevenue] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        product_id: bigint;
        product_name: string;
        product_code: string;
        category_name: string;
        units_sold: number;
        total_revenue: Prisma.Decimal | string | number;
      }>>(Prisma.sql`
        SELECT
          p.product_id,
          p.product_name,
          p.product_code,
          COALESCE(c.category_name, 'Chưa phân loại') AS category_name,
          COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
          COALESCE(SUM(oi.item_subtotal), 0)::numeric AS total_revenue
        FROM order_item oi
        INNER JOIN orders o ON o.order_id = oi.order_id
        INNER JOIN product p ON p.product_id = oi.product_id
        LEFT JOIN category c ON c.category_id = p.category_id
        ${orderWhere}
        ${options.categoryId ? Prisma.sql`AND p.category_id = ${options.categoryId}` : Prisma.empty}
        GROUP BY p.product_id, p.product_name, p.product_code, c.category_name
        ORDER BY units_sold DESC, total_revenue DESC
        LIMIT ${limit}
      `),
      this.prisma.$queryRaw<Array<{
        product_id: bigint;
        product_name: string;
        product_code: string;
        base_price: Prisma.Decimal | string | number;
        units_sold: number;
      }>>(Prisma.sql`
        SELECT
          p.product_id,
          p.product_name,
          p.product_code,
          p.base_price,
          COALESCE(SUM(oi.quantity) FILTER (WHERE o.order_id IS NOT NULL), 0)::int AS units_sold
        FROM product p
        LEFT JOIN order_item oi ON oi.product_id = p.product_id
        LEFT JOIN orders o ON o.order_id = oi.order_id
          AND o.order_status NOT IN ('CANCELLED', 'REJECTED')
          ${dateRange.fromDate ? Prisma.sql`AND o.order_date >= ${dateRange.fromDate}` : Prisma.empty}
          ${dateRange.toDateExclusive ? Prisma.sql`AND o.order_date < ${dateRange.toDateExclusive}` : Prisma.empty}
        WHERE p.store_id = ${storeId}
        GROUP BY p.product_id, p.product_name, p.product_code, p.base_price, p.created_at
        ORDER BY units_sold ASC, p.created_at ASC
        LIMIT ${limit}
      `),
      this.prisma.$queryRaw<Array<{
        category_id: bigint;
        category_name: string;
        units_sold: number;
        total_revenue: Prisma.Decimal | string | number;
      }>>(Prisma.sql`
        SELECT
          c.category_id,
          c.category_name AS category_name,
          COALESCE(SUM(oi.quantity), 0)::int AS units_sold,
          COALESCE(SUM(oi.item_subtotal), 0)::numeric AS total_revenue
        FROM order_item oi
        INNER JOIN orders o ON o.order_id = oi.order_id
        INNER JOIN product p ON p.product_id = oi.product_id
        INNER JOIN category c ON c.category_id = p.category_id
        ${orderWhere}
        GROUP BY c.category_id, c.category_name
        ORDER BY total_revenue DESC
      `),
    ]);

    return {
      topSelling: topProducts.map((p) => ({
        productId: p.product_id.toString(),
        productName: p.product_name,
        productCode: p.product_code,
        categoryName: p.category_name,
        unitsSold: toNumber(p.units_sold),
        totalRevenue: toNumber(p.total_revenue),
      })),
      slowMoving: slowProducts.map((p) => ({
        productId: p.product_id.toString(),
        productName: p.product_name,
        productCode: p.product_code,
        basePrice: toNumber(p.base_price),
        unitsSold: toNumber(p.units_sold),
      })),
      revenueByCategory: categoryRevenue.map((c) => ({
        categoryId: c.category_id.toString(),
        categoryName: c.category_name,
        unitsSold: toNumber(c.units_sold),
        totalRevenue: toNumber(c.total_revenue),
      })),
    };
  }

  async getInventoryAnalytics(
    storeId: bigint,
    options: { page?: number; pageSize?: number; filter?: string } = {},
  ) {
    const page = Math.max(options.page || 1, 1);
    const pageSize = Math.min(options.pageSize || 20, 100);
    const offset = (page - 1) * pageSize;

    const filterCondition =
      options.filter === 'low_stock'
        ? Prisma.sql`AND i.quantity_on_hand <= i.min_stock_alert AND i.quantity_on_hand > 0`
        : options.filter === 'out_of_stock'
        ? Prisma.sql`AND i.quantity_on_hand = 0`
        : Prisma.empty;

    const [summaryRows, itemRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        total_skus: number;
        low_stock_skus: number;
        out_of_stock_skus: number;
        total_on_hand: number;
        total_reserved: number;
        estimated_value: Prisma.Decimal | string | number | null;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total_skus,
          COUNT(*) FILTER (WHERE i.quantity_on_hand <= i.min_stock_alert AND i.quantity_on_hand > 0)::int AS low_stock_skus,
          COUNT(*) FILTER (WHERE i.quantity_on_hand = 0)::int AS out_of_stock_skus,
          COALESCE(SUM(i.quantity_on_hand), 0)::int AS total_on_hand,
          COALESCE(SUM(i.reserved_quantity), 0)::int AS total_reserved,
          COALESCE(SUM(i.quantity_on_hand * p.base_price), 0)::numeric AS estimated_value
        FROM inventory i
        INNER JOIN product p ON p.product_id = i.product_id
        WHERE i.store_id = ${storeId}
      `),
      this.prisma.$queryRaw<Array<{
        product_id: bigint;
        product_name: string;
        product_code: string;
        quantity_on_hand: number;
        reserved_quantity: number;
        available_quantity: number;
        min_stock_alert: number;
        base_price: Prisma.Decimal | string | number;
      }>>(Prisma.sql`
        SELECT
          p.product_id,
          p.product_name,
          p.product_code,
          i.quantity_on_hand,
          i.reserved_quantity,
          GREATEST(0, i.quantity_on_hand - i.reserved_quantity) AS available_quantity,
          i.min_stock_alert,
          p.base_price
        FROM inventory i
        INNER JOIN product p ON p.product_id = i.product_id
        WHERE i.store_id = ${storeId}
        ${filterCondition}
        ORDER BY i.quantity_on_hand ASC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS total
        FROM inventory i
        WHERE i.store_id = ${storeId}
        ${filterCondition}
      `),
    ]);

    const s = summaryRows[0] || {
      total_skus: 0, low_stock_skus: 0, out_of_stock_skus: 0, total_on_hand: 0, total_reserved: 0, estimated_value: 0,
    };
    const totalItems = countRows[0]?.total || 0;

    return {
      summary: {
        totalSkus: toNumber(s.total_skus),
        lowStockSkus: toNumber(s.low_stock_skus),
        outOfStockSkus: toNumber(s.out_of_stock_skus),
        totalOnHand: toNumber(s.total_on_hand),
        totalReserved: toNumber(s.total_reserved),
        totalAvailable: Math.max(0, toNumber(s.total_on_hand) - toNumber(s.total_reserved)),
        estimatedInventoryValue: toNumber(s.estimated_value),
      },
      items: itemRows.map((r) => ({
        productId: r.product_id.toString(),
        productName: r.product_name,
        productCode: r.product_code,
        quantityOnHand: toNumber(r.quantity_on_hand),
        reservedQuantity: toNumber(r.reserved_quantity),
        availableQuantity: toNumber(r.available_quantity),
        minStockAlert: toNumber(r.min_stock_alert),
        basePrice: toNumber(r.base_price),
        status: toNumber(r.quantity_on_hand) === 0 ? 'OUT_OF_STOCK' : toNumber(r.quantity_on_hand) <= toNumber(r.min_stock_alert) ? 'LOW_STOCK' : 'HEALTHY',
      })),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  async getCustomerAnalytics(
    storeId: bigint,
    dateRange: AnalyticsDateRange = {},
    options: { page?: number; pageSize?: number } = {},
  ) {
    const page = Math.max(options.page || 1, 1);
    const pageSize = Math.min(options.pageSize || 20, 100);
    const offset = (page - 1) * pageSize;

    const [summaryRows, topCustomerRows, totalCountRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        total_customers: number;
        new_customers: number;
        repeat_customers: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(DISTINCT o.customer_id)::int AS total_customers,
          COUNT(DISTINCT o.customer_id) FILTER (
            WHERE NOT EXISTS (
              SELECT 1 FROM orders prev
              WHERE prev.customer_id = o.customer_id
                AND prev.store_id = ${storeId}
                AND prev.order_date < o.order_date
            )
          )::int AS new_customers,
          COUNT(DISTINCT o.customer_id) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM orders prev
              WHERE prev.customer_id = o.customer_id
                AND prev.store_id = ${storeId}
                AND prev.order_date < o.order_date
            )
          )::int AS repeat_customers
        FROM orders o
        WHERE o.store_id = ${storeId}
          ${dateRange.fromDate ? Prisma.sql`AND o.order_date >= ${dateRange.fromDate}` : Prisma.empty}
          ${dateRange.toDateExclusive ? Prisma.sql`AND o.order_date < ${dateRange.toDateExclusive}` : Prisma.empty}
      `),
      this.prisma.$queryRaw<Array<{
        customer_id: bigint;
        customer_name: string;
        customer_phone: string;
        order_count: number;
        total_spent: Prisma.Decimal | string | number;
        last_order_date: Date;
      }>>(Prisma.sql`
        SELECT
          o.customer_id,
          COALESCE(u.full_name, 'Khách hàng') AS customer_name,
          COALESCE(u.phone, '') AS customer_phone,
          COUNT(*)::int AS order_count,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS total_spent,
          MAX(o.order_date) AS last_order_date
        FROM orders o
        INNER JOIN customer_profile cp ON cp.customer_id = o.customer_id
        INNER JOIN users u ON u.user_id = cp.user_id
        WHERE o.store_id = ${storeId}
          ${dateRange.fromDate ? Prisma.sql`AND o.order_date >= ${dateRange.fromDate}` : Prisma.empty}
          ${dateRange.toDateExclusive ? Prisma.sql`AND o.order_date < ${dateRange.toDateExclusive}` : Prisma.empty}
        GROUP BY o.customer_id, u.full_name, u.phone
        ORDER BY total_spent DESC, order_count DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT o.customer_id)::int AS total
        FROM orders o
        WHERE o.store_id = ${storeId}
          ${dateRange.fromDate ? Prisma.sql`AND o.order_date >= ${dateRange.fromDate}` : Prisma.empty}
          ${dateRange.toDateExclusive ? Prisma.sql`AND o.order_date < ${dateRange.toDateExclusive}` : Prisma.empty}
      `),
    ]);

    const s = summaryRows[0] || { total_customers: 0, new_customers: 0, repeat_customers: 0 };
    const totalCust = toNumber(s.total_customers);
    const repeatCust = toNumber(s.repeat_customers);
    const totalItems = totalCountRows[0]?.total || 0;

    return {
      summary: {
        totalCustomers: totalCust,
        newCustomers: toNumber(s.new_customers),
        repeatCustomers: repeatCust,
        repeatRate: totalCust > 0 ? Number(((repeatCust / totalCust) * 100).toFixed(2)) : 0,
      },
      topCustomers: topCustomerRows.map((c) => ({
        customerId: c.customer_id.toString(),
        customerName: c.customer_name,
        customerPhone: c.customer_phone,
        orderCount: toNumber(c.order_count),
        totalSpent: toNumber(c.total_spent),
        lastOrderDate: c.last_order_date,
      })),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  async getFinanceAnalytics(
    storeId: bigint,
    dateRange: AnalyticsDateRange = {},
    options: { page?: number; pageSize?: number } = {},
  ) {
    const page = Math.max(Number(options.page) || 1, 1);
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const [summaryRows, walletRows, withdrawalRows, txRows, totalWithdrawalRows, totalTxRows] = await Promise.all([
      this.prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS total_orders,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status NOT IN ('CANCELLED', 'REJECTED')), 0)::numeric AS gmv,
          COALESCE(SUM(o.total_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS realized_revenue,
          COALESCE(SUM(o.commission_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS platform_commission,
          COALESCE(SUM(o.net_amount) FILTER (WHERE o.order_status IN ('DELIVERED', 'COMPLETED')), 0)::numeric AS net_revenue
        FROM orders o
        WHERE o.store_id = ${storeId}
          ${dateRange.fromDate ? Prisma.sql`AND o.order_date >= ${dateRange.fromDate}` : Prisma.empty}
          ${dateRange.toDateExclusive ? Prisma.sql`AND o.order_date < ${dateRange.toDateExclusive}` : Prisma.empty}
      `),
      this.prisma.$queryRaw<Array<{ balance: Prisma.Decimal | string | number; frozen_balance: Prisma.Decimal | string | number }>>(Prisma.sql`
        SELECT
          COALESCE(w.balance, 0)::numeric AS balance,
          COALESCE(w.frozen_balance, 0)::numeric AS frozen_balance
        FROM store_wallets w
        WHERE w.store_id = ${storeId}
        LIMIT 1
      `),
      this.prisma.$queryRaw<Array<{
        id: bigint;
        amount: Prisma.Decimal | string | number;
        status: string;
        created_at: Date;
      }>>(Prisma.sql`
        SELECT
          sw.withdrawal_id AS id,
          sw.amount,
          sw.status,
          sw.created_at
        FROM store_withdrawals sw
        WHERE sw.store_id = ${storeId}
        ORDER BY sw.created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
      this.prisma.$queryRaw<Array<{
        transaction_id: bigint;
        amount: Prisma.Decimal | string | number;
        transaction_type: string;
        balance_after: Prisma.Decimal | string | number;
        created_at: Date;
      }>>(Prisma.sql`
        SELECT
          wt.transaction_id,
          wt.amount,
          wt.type AS transaction_type,
          wt.balance_after,
          wt.created_at
        FROM wallet_transactions wt
        INNER JOIN store_wallets w ON w.wallet_id = wt.wallet_id
        WHERE w.store_id = ${storeId}
        ORDER BY wt.created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM store_withdrawals sw
        WHERE sw.store_id = ${storeId}
      `),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM wallet_transactions wt
        INNER JOIN store_wallets w ON w.wallet_id = wt.wallet_id
        WHERE w.store_id = ${storeId}
      `),
    ]);

    const s = summaryRows[0];
    const w = walletRows[0] || { balance: 0, frozen_balance: 0 };
    const totalWithdrawals = Number(totalWithdrawalRows[0]?.count || 0);
    const totalTransactions = Number(totalTxRows[0]?.count || 0);
    const totalItems = Math.max(totalWithdrawals, totalTransactions);
    const totalPages = Math.ceil(totalItems / pageSize) || 1;

    return {
      financialSummary: {
        gmv: toNumber(s?.gmv),
        realizedRevenue: toNumber(s?.realized_revenue),
        platformCommission: toNumber(s?.platform_commission),
        netRevenue: toNumber(s?.net_revenue),
        walletBalance: toNumber(w.balance),
        frozenBalance: toNumber(w.frozen_balance),
      },
      withdrawals: withdrawalRows.map((r) => ({
        id: r.id.toString(),
        amount: toNumber(r.amount),
        status: r.status,
        createdAt: r.created_at,
      })),
      recentTransactions: txRows.map((r) => ({
        transactionId: r.transaction_id.toString(),
        amount: toNumber(r.amount),
        type: r.transaction_type,
        balanceAfter: toNumber(r.balance_after),
        createdAt: r.created_at,
      })),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages,
        totalWithdrawals,
        totalTransactions,
      },
    };
  }

  async getOperationsAnalytics(storeId: bigint, dateRange: AnalyticsDateRange = {}) {
    const [stuckOrders, driverStats, deviceIssues] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        order_status: string;
        stuck_count: number;
      }>>(Prisma.sql`
        SELECT
          o.order_status,
          COUNT(*)::int AS stuck_count
        FROM orders o
        WHERE o.store_id = ${storeId}
          AND (
            (o.order_status = 'PENDING' AND o.created_at < NOW() - INTERVAL '15 minutes')
            OR (o.order_status = 'PREPARING' AND o.updated_at < NOW() - INTERVAL '30 minutes')
            OR (o.order_status = 'SHIPPING' AND o.updated_at < NOW() - INTERVAL '60 minutes')
          )
        GROUP BY o.order_status
      `),
      this.prisma.$queryRaw<Array<{
        online_drivers: number;
        open_shifts: number;
        failed_deliveries: number;
      }>>(Prisma.sql`
        SELECT
          (SELECT COUNT(*)::int FROM driver_duties dd WHERE dd.store_id = ${storeId} AND dd.status = 'ONLINE') AS online_drivers,
          (SELECT COUNT(*)::int FROM driver_shifts ds WHERE ds.store_id = ${storeId} AND ds.status = 'OPEN') AS open_shifts,
          (SELECT COUNT(*)::int FROM orders o WHERE o.store_id = ${storeId} AND o.order_status = 'DELIVERY_FAILED'
            ${dateRange.fromDate ? Prisma.sql`AND o.order_date >= ${dateRange.fromDate}` : Prisma.empty}
            ${dateRange.toDateExclusive ? Prisma.sql`AND o.order_date < ${dateRange.toDateExclusive}` : Prisma.empty}
          ) AS failed_deliveries
      `),
      this.prisma.$queryRaw<Array<{
        low_battery_count: number;
        unassigned_count: number;
      }>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE b.battery_level <= 20)::int AS low_battery_count,
          COUNT(*) FILTER (WHERE b.customer_id IS NULL OR NOT EXISTS (SELECT 1 FROM button_product bp WHERE bp.button_id = b.button_id))::int AS unassigned_count
        FROM iot_button b
        WHERE b.store_id = ${storeId}
      `),
    ]);

    const d = driverStats[0] || { online_drivers: 0, open_shifts: 0, failed_deliveries: 0 };
    const dev = deviceIssues[0] || { low_battery_count: 0, unassigned_count: 0 };

    return {
      bottlenecks: stuckOrders.map((r) => ({
        status: r.order_status,
        stuckCount: toNumber(r.stuck_count),
      })),
      drivers: {
        onlineDrivers: toNumber(d.online_drivers),
        openShifts: toNumber(d.open_shifts),
        failedDeliveries: toNumber(d.failed_deliveries),
      },
      devices: {
        lowBatteryCount: toNumber(dev.low_battery_count),
        unassignedCount: toNumber(dev.unassigned_count),
      },
    };
  }

  async getStaffAnalytics(storeId: bigint, dateRange: AnalyticsDateRange = {}) {
    const [staffHistory, driverPerformance] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        user_id: bigint;
        staff_name: string;
        role_name: string;
        status_updates_count: number;
      }>>(Prisma.sql`
        SELECT
          u.user_id,
          u.full_name AS staff_name,
          r.role_code AS role_name,
          COUNT(osh.history_id)::int AS status_updates_count
        FROM store_staff ss
        INNER JOIN users u ON u.user_id = ss.user_id
        INNER JOIN roles r ON r.role_id = ss.role_id
        LEFT JOIN order_status_history osh ON osh.changed_by_user_id = u.user_id
          ${dateRange.fromDate ? Prisma.sql`AND osh.changed_at >= ${dateRange.fromDate}` : Prisma.empty}
          ${dateRange.toDateExclusive ? Prisma.sql`AND osh.changed_at < ${dateRange.toDateExclusive}` : Prisma.empty}
        WHERE ss.store_id = ${storeId}
        GROUP BY u.user_id, u.full_name, r.role_code
        ORDER BY status_updates_count DESC
      `),
      this.prisma.$queryRaw<Array<{
        driver_id: bigint;
        driver_name: string;
        total_delivered: number;
        total_failed: number;
        total_cod: Prisma.Decimal | string | number;
        total_vietqr: Prisma.Decimal | string | number;
      }>>(Prisma.sql`
        SELECT
          ds.driver_id,
          u.full_name AS driver_name,
          COALESCE(SUM(ds.total_orders_delivered), 0)::int AS total_delivered,
          COALESCE(SUM(ds.total_orders_failed), 0)::int AS total_failed,
          COALESCE(SUM(ds.total_cod_collected), 0)::numeric AS total_cod,
          COALESCE(SUM(ds.total_vietqr_collected), 0)::numeric AS total_vietqr
        FROM driver_shifts ds
        INNER JOIN users u ON u.user_id = ds.driver_id
        WHERE ds.store_id = ${storeId}
          ${dateRange.fromDate ? Prisma.sql`AND ds.started_at >= ${dateRange.fromDate}` : Prisma.empty}
          ${dateRange.toDateExclusive ? Prisma.sql`AND ds.started_at < ${dateRange.toDateExclusive}` : Prisma.empty}
        GROUP BY ds.driver_id, u.full_name
        ORDER BY total_delivered DESC
      `),
    ]);

    return {
      staffActivity: staffHistory.map((s) => ({
        userId: s.user_id.toString(),
        staffName: s.staff_name,
        role: s.role_name,
        statusUpdatesCount: toNumber(s.status_updates_count),
      })),
      driverPerformance: driverPerformance.map((d) => ({
        driverId: d.driver_id.toString(),
        driverName: d.driver_name,
        totalDelivered: toNumber(d.total_delivered),
        totalFailed: toNumber(d.total_failed),
        totalCodCollected: toNumber(d.total_cod),
        totalVietqrCollected: toNumber(d.total_vietqr),
      })),
    };
  }

  async getAlertsAnalytics(storeId: bigint) {
    const [invRows, buttonRows, delayedRows, subRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ low_stock: number; out_of_stock: number }>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE i.quantity_on_hand <= i.min_stock_alert AND i.quantity_on_hand > 0)::int AS low_stock,
          COUNT(*) FILTER (WHERE i.quantity_on_hand = 0)::int AS out_of_stock
        FROM inventory i
        WHERE i.store_id = ${storeId}
      `),
      this.prisma.$queryRaw<Array<{ low_battery: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS low_battery
        FROM iot_button b
        WHERE b.store_id = ${storeId} AND b.battery_level <= 20
      `),
      this.prisma.$queryRaw<Array<{ delayed_count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS delayed_count
        FROM orders o
        WHERE o.store_id = ${storeId}
          AND o.order_status = 'PREPARING'
          AND o.updated_at < NOW() - INTERVAL '30 minutes'
      `),
      this.prisma.$queryRaw<Array<{ expiring_count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS expiring_count
        FROM store_subscriptions ss
        WHERE ss.store_id = ${storeId}
          AND ss.status = 'ACTIVE'
          AND ss.end_date <= NOW() + INTERVAL '7 days'
      `),
    ]);

    const inv = invRows[0] || { low_stock: 0, out_of_stock: 0 };
    const lowBat = buttonRows[0]?.low_battery || 0;
    const delayed = delayedRows[0]?.delayed_count || 0;
    const expiringSub = subRows[0]?.expiring_count || 0;

    const alerts: Array<{ code: string; message: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; count: number }> = [];
    if (inv.out_of_stock > 0) {
      alerts.push({ code: 'OUT_OF_STOCK', message: `Có ${inv.out_of_stock} mặt hàng đã hết hàng hoàn toàn`, severity: 'CRITICAL', count: inv.out_of_stock });
    }
    if (inv.low_stock > 0) {
      alerts.push({ code: 'LOW_STOCK', message: `Có ${inv.low_stock} mặt hàng dưới định mức tồn kho tối thiểu`, severity: 'WARNING', count: inv.low_stock });
    }
    if (delayed > 0) {
      alerts.push({ code: 'PREPARING_DELAY', message: `Có ${delayed} đơn hàng đang chuẩn bị vượt quá 30 phút`, severity: 'CRITICAL', count: delayed });
    }
    if (lowBat > 0) {
      alerts.push({ code: 'LOW_BATTERY', message: `Có ${lowBat} nút bấm IoT pin yếu (<=20%)`, severity: 'WARNING', count: lowBat });
    }
    if (expiringSub > 0) {
      alerts.push({ code: 'SUBSCRIPTION_EXPIRING', message: `Gói dịch vụ cửa hàng sẽ hết hạn trong vòng 7 ngày`, severity: 'INFO', count: expiringSub });
    }

    return alerts;
  }
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DashboardAnalyticsQueryDto } from '../src/analytics/dto/dashboard-analytics-query.dto';
import { buildAnalyticsDateRange } from '../src/analytics/utils/analytics-date-range.util';
import { AnalyticsRepository } from '../src/analytics/analytics.repository';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AdminService } from '../src/admin/admin.service';
import { DevicesService } from '../src/devices/devices.service';

async function runAnalyticsFoundationUnitSuite() {
  let passed = 0;

  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    passed++;
  };

  const invalidOrder = plainToInstance(DashboardAnalyticsQueryDto, {
    fromDate: '2026-10-28',
    toDate: '2026-10-27',
  });
  check((await validate(invalidOrder)).length > 0, 'DTO rejects fromDate after toDate');

  const oversizedRange = plainToInstance(DashboardAnalyticsQueryDto, {
    fromDate: '2025-01-01',
    toDate: '2026-01-03',
    groupBy: 'day',
  });
  check((await validate(oversizedRange)).length > 0, 'DTO caps day/week analytics windows at 366 days');

  const invalidStore = plainToInstance(DashboardAnalyticsQueryDto, { storeId: '12 OR 1=1' });
  check((await validate(invalidStore)).length > 0, 'DTO rejects non-numeric storeId values');

  const validQuery = plainToInstance(DashboardAnalyticsQueryDto, {
    fromDate: '2026-10-01',
    toDate: '2026-10-27',
    groupBy: 'week',
    storeId: '12',
  });
  check((await validate(validQuery)).length === 0, 'DTO accepts a valid date-only analytics query');

  const range = buildAnalyticsDateRange('2026-10-27', '2026-10-27');
  check(
    range.fromDate?.toISOString() === '2026-10-26T17:00:00.000Z' &&
      range.toDateExclusive?.toISOString() === '2026-10-27T17:00:00.000Z',
    'Date-only range uses Asia/Ho_Chi_Minh and an exclusive next-day upper bound',
  );

  const queryResults: any[][] = [
    [
      {
        total_orders: 5,
        gmv: '600000',
        realized_revenue: '300000',
        platform_commission: '24000',
        net_revenue: '276000',
      },
    ],
    [
      {
        period: '2026-10-27',
        total_orders: 5,
        gmv: '600000',
        realized_revenue: '300000',
        platform_commission: '24000',
        net_revenue: '276000',
        completed_orders: 2,
        cancelled_orders: 1,
        cancelled_amount: '50000',
      },
    ],
    [
      {
        total_devices: 4,
        active_devices: 3,
        inactive_devices: 1,
        low_battery_devices: 1,
        unassigned_devices: 2,
      },
    ],
    [{ paid_revenue: '275000' }],
  ];
  const rawQueries: any[] = [];
  const prismaMock: any = {
    $queryRaw: async (query: any) => {
      rawQueries.push(query);
      return queryResults.shift();
    },
    order: {
      findMany: () => {
        throw new Error('analytics must not load full order rows');
      },
    },
  };
  const repository = new AnalyticsRepository(prismaMock);
  const aggregate = await repository.getDashboardData(12n, range, 'day');
  check(aggregate.summary.gmv === 600000, 'Repository maps GMV aggregate');
  check(aggregate.summary.realizedRevenue === 300000, 'Repository maps realized revenue aggregate');
  check(aggregate.summary.paidRevenue === 275000, 'Repository maps paid transaction aggregate');
  check(aggregate.chartData[0]?.gmv === 600000, 'Chart uses the same GMV definition as summary');
  check(aggregate.devices.lowBatteryDevices === 1, 'Device aggregate reports low-battery count');
  const renderedSql = rawQueries.map((query) => query.sql).join('\n');
  check(renderedSql.includes('FROM orders o'), 'Analytics queries use the real orders table');
  check(
    renderedSql.includes("NOT IN ('CANCELLED', 'REJECTED')") &&
      renderedSql.includes("IN ('DELIVERED', 'COMPLETED')"),
    'Summary and chart share the normalized GMV and realized-revenue status sets',
  );
  check(
    renderedSql.includes('o.order_date >= ?') && renderedSql.includes('o.order_date < ?'),
    'Repository uses a half-open SQL date range',
  );
  check(!renderedSql.includes('$queryRawUnsafe'), 'Analytics aggregation does not use unsafe raw SQL');

  let capturedStoreId: bigint | undefined;
  let capturedRange: any;
  const service = new AnalyticsService({
    getDashboardData: async (storeId: bigint | undefined, dateRange: any) => {
      capturedStoreId = storeId;
      capturedRange = dateRange;
      return aggregate;
    },
  } as any);
  const response = await service.getDashboardAnalytics('12', { role: 'STORE_OWNER', storeId: '12' }, {
    fromDate: '2026-10-27',
    toDate: '2026-10-27',
    groupBy: 'day',
  });
  check(capturedStoreId === 12n, 'Store dashboard derives tenant scope from authenticated user');
  check(capturedRange.toDateExclusive instanceof Date, 'Service passes normalized exclusive range to repository');
  check(response.totalRevenue === 600000, 'Legacy totalRevenue remains a GMV compatibility alias');
  check(response.financials.realizedRevenue === 300000, 'Response exposes normalized financial matrix');
  check(response.chartData[0]?.revenue === 600000, 'Legacy chart revenue is the same GMV compatibility alias');

  const adminService = new AdminService({
    getCounts: async () => ({
      totalStores: 8,
      activeStores: 6,
      totalUsers: 40,
      totalButtons: 20,
      activeButtons: 17,
      totalOrders: 50,
      completedOrders: 30,
      totalGmv: 900000,
    }),
  } as any);
  const adminStats = await adminService.getSystemStats();
  check(adminStats.completedOrders === 30, 'Admin service consumes database aggregates without loading rows');
  check(adminStats.totalGmv === 900000, 'Admin GMV is supplied by database aggregate');

  const countCalls: any[] = [];
  const deviceService = new DevicesService(
    {
      count: async (where: any) => {
        countCalls.push(where);
        return [10, 7, 3, 2, 4][countCalls.length - 1];
      },
    } as any,
    {} as any,
  );
  const fleet = await deviceService.getFleetStats({ role: 'STORE_OWNER', storeId: '12' });
  check(fleet.activeDevices === 7 && fleet.inactiveDevices === 3, 'Fleet reports active/inactive status truthfully');
  check(fleet.lowBatteryDevices === 2 && fleet.unassignedDevices === 4, 'Fleet reports actionable device metrics');
  check(!('online' in fleet) && !('offline' in fleet), 'Fleet does not label ACTIVE status as online presence');

  const migrationPath = path.resolve(
    process.cwd(),
    'prisma/migrations/20261027160000_add_dashboard_analytics_indexes/migration.sql',
  );
  const migration = fs.readFileSync(migrationPath, 'utf8');
  for (const indexName of [
    'idx_orders_store_date_status',
    'idx_orders_customer_date_status',
    'idx_inventory_store_stock_alert',
    'idx_iot_button_store_status_battery',
    'idx_payment_tx_status_order_created',
  ]) {
    check(migration.includes(indexName), `Migration defines ${indexName}`);
  }
  check(migration.includes('min_stock_alert'), 'Inventory index uses the real min_stock_alert column');

  console.log(`Analytics foundation unit suite: ${passed} assertions passed.`);
  process.exit(0);
}

runAnalyticsFoundationUnitSuite().catch((error) => {
  console.error(error);
  process.exit(1);
});

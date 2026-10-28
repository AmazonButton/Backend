import assert from 'node:assert/strict';
import { DashboardCacheService } from '../src/common/cache/dashboard-cache.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AdminService } from '../src/admin/admin.service';
import { CustomersService } from '../src/customers/customers.service';
import { StaffService } from '../src/staff/staff.service';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { AdminController } from '../src/admin/admin.controller';
import { InventoryAnalyticsQueryDto } from '../src/analytics/dto/analytics-drilldown-query.dto';
import { AdminStoresLeaderboardQueryDto } from '../src/admin/dto/admin-analytics-query.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  IN_TRANSIT_ORDER_STATUSES,
  REALIZED_ORDER_STATUSES,
  EXCLUDED_GMV_STATUSES,
  FAILED_DELIVERY_STATUSES,
} from '../src/analytics/constants/analytics-order-status.constant';

async function runAnalyticsDashboardE2ESuite() {
  console.log('--- Starting Suite 44: Multi-Role Analytics & Dashboard E2E Suite ---');
  let passed = 0;

  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    passed++;
  };

  // =========================================================================
  // 1. DASHBOARD CACHE-ASIDE SERVICE UNIT & MEMORY FALLBACK
  // =========================================================================
  console.log('Testing DashboardCacheService in-memory mode...');
  const cacheService = new DashboardCacheService();
  process.env.DISABLE_REDIS = 'true';
  await cacheService.onModuleInit();

  let fetchCalls = 0;
  const mockFetcher = async () => {
    fetchCalls++;
    return { data: 'fresh-report', timestamp: Date.now() };
  };

  const val1 = await cacheService.getOrSet('test:report:1', 10, mockFetcher);
  check(val1.data === 'fresh-report' && fetchCalls === 1, 'Cache service fetches fresh data on cache miss');

  const val2 = await cacheService.getOrSet('test:report:1', 10, mockFetcher);
  check(val2.data === 'fresh-report' && fetchCalls === 1, 'Cache service serves cached data on cache hit without re-fetching');

  await cacheService.invalidatePrefix('test:report');
  const val3 = await cacheService.getOrSet('test:report:1', 10, mockFetcher);
  check(val3.data === 'fresh-report' && fetchCalls === 2, 'Cache service invalidates entries by prefix');

  // =========================================================================
  // 2. ADMIN DASHBOARD & DRILL-DOWN ANALYTICS (P0 & P1)
  // =========================================================================
  console.log('Testing Admin Dashboard & Drill-Downs...');
  const mockAdminRepo: any = {
    getAdminDashboardData: async (_range: any, compareWith?: string) => ({
      stores: { total: 15, active: 12, pendingApproval: 2, suspended: 1 },
      users: { total: 150, customers: 120, storeOwners: 15, staff: 12, admins: 3, activeUsers: 145, suspendedUsers: 5 },
      orders: { total: 500, pending: 20, preparing: 15, delivering: 10, completed: 430, cancelled: 20, rejected: 5 },
      financials: { gmv: 50000000, realizedRevenue: 43000000, platformCommission: 3440000, paidRevenue: 43000000 },
      payments: { pending: 10, succeeded: 450, failed: 40 },
      devices: { total: 50, active: 45, inactive: 5, lowBattery: 2, unassigned: 3 },
      rentals: { total: 30, pendingPayment: 2, active: 25, expiringSoon: 3, expired: 0 },
      withdrawals: { pending: 3, processing: 1, completed: 40, rejected: 1, failed: 1 },
      verifications: { pendingBankVerification: 2, pendingKyc: 1 },
      dlq: { unresolvedCount: 0 },
      alerts: [
        { type: 'PENDING_STORE_APPROVAL', severity: 'MEDIUM', count: 2, message: '2 cửa hàng chờ phê duyệt' },
      ],
      comparison: compareWith ? { gmvGrowthPercent: 12.5, ordersGrowthPercent: 8.0 } : undefined,
    }),
    getAdminRevenueAnalytics: async () => ({
      timeline: [
        { period: '2026-10-01', gmv: 5000000, realizedRevenue: 4500000, platformCommission: 360000, totalOrders: 50 },
        { period: '2026-10-02', gmv: 6000000, realizedRevenue: 5200000, platformCommission: 416000, totalOrders: 58 },
      ],
      rentalRevenue: { activeRentAmount: 15000000, activeDepositAmount: 30000000 },
    }),
    getAdminGrowthAnalytics: async () => ({
      newStoresTimeline: [{ period: '2026-10-01', newStores: 2 }],
      newUsersTimeline: [{ period: '2026-10-01', newUsers: 15 }],
    }),
    getAdminOperationsAnalytics: async () => ({
      pendingStoreApprovals: [{ storeId: '1', name: 'Fresh Mart', code: 'FM01', phone: '0901234567', email: 'fm@test.local', createdAt: new Date() }],
      failedWithdrawals: [],
      deadLetterJobs: [],
    }),
    getAdminStoresLeaderboard: async ({ page = 1, pageSize = 20 }: any) => ({
      stores: [
        { storeId: '1', storeName: 'Fresh Mart', storeCode: 'FM01', status: 'ACTIVE', gmv: 30000000, realizedRevenue: 28000000, commissionGenerated: 2240000, completedOrders: 320, activeButtons: 8 },
      ],
      pagination: { page, pageSize, totalItems: 1, totalPages: 1 },
    }),
  };

  const adminService = new AdminService(mockAdminRepo, undefined, cacheService);

  const adminDash = await adminService.getDashboard({ compareWith: 'previous-period' });
  check(adminDash.stores.total === 15, 'Admin dashboard returns stores summary');
  check(adminDash.financials.realizedRevenue === 43000000, 'Admin dashboard returns financial aggregations');
  check(adminDash.comparison?.gmvGrowthPercent === 12.5, 'Admin dashboard calculates comparison when requested');

  const adminRev = await adminService.getRevenueAnalytics({ groupBy: 'day' });
  check(adminRev.timeline.length === 2 && adminRev.rentalRevenue.activeRentAmount === 15000000, 'Admin revenue analytics returns timeseries & rentals');

  const adminGrowth = await adminService.getGrowthAnalytics({ groupBy: 'day' });
  check(adminGrowth.newStoresTimeline.length === 1 && adminGrowth.newUsersTimeline.length === 1, 'Admin growth analytics returns signups');

  const adminOps = await adminService.getOperationsAnalytics();
  check(adminOps.pendingStoreApprovals.length === 1, 'Admin operations analytics returns pending stores');

  const adminStores = await adminService.getStoresLeaderboard({ page: 1, pageSize: 20 });
  check(adminStores.stores[0].storeName === 'Fresh Mart' && adminStores.pagination.totalItems === 1, 'Admin stores leaderboard returns stores & pagination');

  // =========================================================================
  // 3. STORE OWNER DASHBOARD & BOLA ISOLATION & DRILL-DOWNS
  // =========================================================================
  console.log('Testing Store Owner Dashboard & BOLA Protection...');
  const mockAnalyticsRepo: any = {
    getDashboardData: async () => ({
      summary: {
        totalOrders: 100,
        gmv: 12000000,
        realizedRevenue: 10000000,
        platformCommission: 800000,
        netRevenue: 9200000,
        activeButtons: 10,
        lowBatteryButtons: 1,
        totalCustomers: 45,
      },
      chartData: [],
      devices: { activeDevices: 10, inactiveDevices: 1, lowBatteryDevices: 1 },
    }),
    getStoreExtendedData: async () => ({
      orders: { pending: 5, preparing: 3, delivering: 4, completed: 80, cancelled: 6, rejected: 2 },
      inventory: { lowStockCount: 3, outOfStockCount: 1, estimatedInventoryValue: 25000000 },
      customers: { totalCustomers: 45, newCustomers: 10, repeatCustomers: 35, repeatCustomerRate: 77.78 },
      delivery: { activeDriversCount: 2, completedDutiesCount: 15, failedDeliveryOrdersCount: 1 },
      wallet: { balance: 8500000, frozenBalance: 500000, pendingWithdrawalsAmount: 500000 },
      alerts: [{ type: 'LOW_STOCK', count: 3, message: '3 sản phẩm sắp hết hàng' }],
    }),
    getOrderAnalytics: async () => ({
      totalOrders: 100,
      completedOrders: 80,
      cancelledOrders: 6,
      rejectedOrders: 2,
      cancellationRate: 6.0,
      rejectionRate: 2.0,
      gmv: 12000000,
      realizedRevenue: 10000000,
      averageOrderValue: 120000,
      paymentMethods: [{ method: 'PAYOS', orderCount: 70, totalAmount: 7000000 }],
      timeline: [{ period: '2026-10-27', totalOrders: 10, completedOrders: 8, gmv: 1200000, realizedRevenue: 1000000 }],
    }),
    getProductAnalytics: async () => ({
      topSelling: [{ productId: '101', productName: 'Milk', productCode: 'P101', categoryName: 'Dairy', unitsSold: 40, totalRevenue: 800000 }],
      slowMoving: [],
      revenueByCategory: [{ categoryId: '1', categoryName: 'Dairy', totalUnits: 40, totalRevenue: 800000 }],
    }),
    getInventoryAnalytics: async () => ({
      summary: { totalSkus: 20, lowStockSkus: 3, outOfStockSkus: 1, totalOnHand: 150, totalReserved: 10, totalAvailable: 140, estimatedInventoryValue: 25000000 },
      criticalItems: [],
    }),
    getCustomerAnalytics: async () => ({
      summary: { totalCustomers: 45, newCustomers: 10, repeatCustomers: 35, repeatRate: 77.78 },
      topCustomers: [{ customerId: '501', customerName: 'Nguyen Van A', totalOrders: 12, totalSpent: 2400000, lastOrderDate: new Date() }],
      segments: [],
    }),
    getFinanceAnalytics: async () => ({
      financialSummary: { gmv: 12000000, realizedRevenue: 10000000, platformCommission: 800000, netRevenue: 9200000, walletBalance: 8500000, frozenBalance: 500000 },
      withdrawals: [],
      recentTransactions: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 1 },
    }),
    getOperationsAnalytics: async () => ({
      bottlenecks: [],
      drivers: { onlineDrivers: 2, openShifts: 2, failedDeliveries: 1 },
      devices: { lowBatteryCount: 1, unassignedCount: 0 },
    }),
    getStaffAnalytics: async () => ({
      staffActivity: [{ userId: '31', staffName: 'Staff 1', role: 'STAFF_ORDER', statusUpdatesCount: 15 }],
      driverPerformance: [],
    }),
    getAlertsAnalytics: async () => ([
      { code: 'LOW_STOCK', message: '3 sản phẩm sắp hết hàng', severity: 'WARNING' as const, count: 3 },
    ]),
  };

  const analyticsService = new AnalyticsService(mockAnalyticsRepo, cacheService);

  const storeOwnerUser = { userId: '10', storeId: '100', role: 'STORE_OWNER' };
  const storeStaffUser = { userId: '11', storeId: '100', role: 'STORE_STAFF' };
  const adminUser = { userId: '1', role: 'SUPER_ADMIN' };

  // BOLA Check: Store Owner querying their own store -> OK
  const ownerDash = await analyticsService.getDashboard(storeOwnerUser, { storeId: '100' });
  check(ownerDash.financials.realizedRevenue === 10000000, 'Store owner can access their store dashboard');
  check(ownerDash.orders?.completed === 80, 'Store owner dashboard includes extended order funnel');
  check(ownerDash.wallet?.balance === 8500000, 'Store owner dashboard includes store wallet status');

  // BOLA Check: Store Owner querying someone else's store -> Forbidden
  let bolaPrevented = false;
  try {
    await analyticsService.getDashboard(storeOwnerUser, { storeId: '999' });
  } catch (err: any) {
    if (err instanceof ForbiddenException) bolaPrevented = true;
  }
  check(bolaPrevented, 'BOLA guard prevents Store Owner from accessing another store dashboard');

  // Platform Admin querying any store -> OK
  const adminQueryStore = await analyticsService.getDashboard(adminUser, { storeId: '100' });
  check(adminQueryStore.financials.realizedRevenue === 10000000, 'Platform admin can query any store by storeId');

  // RBAC Guard on /analytics/finance: Staff must be rejected with 403 Forbidden
  let staffFinanceForbidden = false;
  try {
    await analyticsService.getFinanceAnalytics(storeStaffUser, {});
  } catch (err: any) {
    if (err instanceof ForbiddenException) staffFinanceForbidden = true;
  }
  check(staffFinanceForbidden, 'RBAC guard blocks STORE_STAFF from accessing store finance analytics');

  // Store Owner can access /analytics/finance
  const financeData = await analyticsService.getFinanceAnalytics(storeOwnerUser, {});
  check(financeData.financialSummary.walletBalance === 8500000, 'STORE_OWNER can access store finance analytics');

  // All 8 store drill-downs execute successfully
  const [drillOrders, drillProducts, drillInv, drillCust, drillOps, drillStaff, drillAlerts] = await Promise.all([
    analyticsService.getOrderAnalytics(storeOwnerUser, {}),
    analyticsService.getProductAnalytics(storeOwnerUser, {}),
    analyticsService.getInventoryAnalytics(storeOwnerUser, {}),
    analyticsService.getCustomerAnalytics(storeOwnerUser, {}),
    analyticsService.getOperationsAnalytics(storeOwnerUser, {}),
    analyticsService.getStaffAnalytics(storeOwnerUser, {}),
    analyticsService.getAlertsAnalytics(storeOwnerUser),
  ]);
  check(drillOrders.completedOrders === 80 && Array.isArray(drillOrders.timeline), 'Drill-down: getOrderAnalytics returned completed orders & timeline');
  check(drillProducts.topSelling.length === 1, 'Drill-down: getProductAnalytics returned top products');
  check(drillInv.summary.lowStockSkus === 3, 'Drill-down: getInventoryAnalytics returned low stock count');
  check(drillCust.summary.totalCustomers === 45, 'Drill-down: getCustomerAnalytics returned customer count');
  check(drillOps.drivers.onlineDrivers === 2, 'Drill-down: getOperationsAnalytics returned delivery stats');
  check(Array.isArray(drillStaff.staffActivity), 'Drill-down: getStaffAnalytics returned staff performance');
  check(Array.isArray(drillAlerts) && drillAlerts.length === 1, 'Drill-down: getAlertsAnalytics returned alerts');

  // =========================================================================
  // 4. CUSTOMER DASHBOARD & DRILL-DOWN ANALYTICS (BOLA & ISOLATION)
  // =========================================================================
  console.log('Testing Customer Dashboard & Drill-Downs...');
  const mockCustomersRepo: any = {
    getCustomerDashboard: async (userId: bigint) => ({
      ordersSummary: { total: 10, pending: 1, delivering: 1, completed: 8, cancelled: 0, totalSpent: 1250000 },
      recentOrders: [
        { orderId: '501', orderCode: 'ORD-501', orderStatus: 'DELIVERING', totalAmount: 150000, orderDate: new Date(), storeId: '100', storeName: 'Fresh Mart', itemsCount: 3 },
      ],
      connectedStores: [{ storeId: '100', name: 'Fresh Mart', code: 'FM01', logoUrl: null }],
      devices: { total: 2, active: 2, lowBattery: 0 },
      rentals: { total: 1, active: 1, expiringSoon: 0 },
      unreadNotificationsCount: 3,
    }),
    getCustomerOrdersAnalytics: async (userId: bigint) => ({
      timeline: [{ period: '2026-10-27', count: 2, spent: 300000 }],
      statusBreakdown: [{ status: 'COMPLETED', count: 8 }],
      topProducts: [{ productName: 'Organic Apples', totalQuantity: 10, totalSpent: 250000 }],
    }),
    getCustomerDevicesAnalytics: async (userId: bigint) => ({
      devices: [
        { buttonId: '1', deviceId: 'BTN-001', buttonCode: 'BC01', buttonName: 'Kitchen Water', status: 'ACTIVE', batteryLevel: 95, storeId: '100', storeName: 'Fresh Mart', deployedTemplate: 'Water 19L', installedAt: new Date() },
      ],
    }),
    getCustomerRentalsAnalytics: async (userId: bigint) => ({
      rentals: [
        { rentalId: '1', status: 'ACTIVE', packageName: 'Gói Cơ Bản', monthlyPrice: 50000, depositAmount: 100000, totalRentAmount: 150000, startDate: new Date(), endDate: new Date(), assignedButtonsCount: 1, buttons: [] },
      ],
    }),
  };

  const customersService = new CustomersService(mockCustomersRepo, cacheService);
  const customerUser = { userId: '20', id: '20', role: 'CUSTOMER' };

  const custDash = await customersService.getDashboard(customerUser);
  check(custDash.ordersSummary.totalSpent === 1250000, 'Customer dashboard returns accurate spending');
  check(custDash.recentOrders.length === 1 && custDash.recentOrders[0].orderCode === 'ORD-501', 'Customer dashboard returns recent orders');
  check(custDash.connectedStores.length === 1, 'Customer dashboard returns connected stores');
  check(custDash.unreadNotificationsCount === 3, 'Customer dashboard returns unread notification count');

  const custOrders = await customersService.getOrdersAnalytics(customerUser, '2026-10-01', '2026-10-27');
  check(custOrders.topProducts[0].productName === 'Organic Apples', 'Customer orders analytics returns top products');

  const custDevices = await customersService.getDevicesAnalytics(customerUser);
  check(custDevices.devices[0].buttonCode === 'BC01', 'Customer devices analytics returns button list');

  const custRentals = await customersService.getRentalsAnalytics(customerUser);
  check(custRentals.rentals[0].packageName === 'Gói Cơ Bản', 'Customer rentals analytics returns active rentals');

  // =========================================================================
  // 5. STAFF DASHBOARD ROLE-BASED DISPATCH
  // =========================================================================
  console.log('Testing Staff Dashboard Role-Based Dispatch...');
  const mockStaffRepo: any = {
    findStaffMembership: async () => null,
    getOrderStaffDashboard: async (storeId: bigint) => ({
      role: 'STAFF_ORDER' as const,
      summary: { ordersToPrepare: 8, ordersPreparing: 4, ordersDelivering: 2, todayCompletedOrders: 35 },
      actionableOrders: [{ orderId: '101', orderCode: 'ORD-101', orderStatus: 'PENDING', totalAmount: 85000 }],
    }),
    getInventoryStaffDashboard: async (storeId: bigint) => ({
      role: 'STAFF_INVENTORY' as const,
      summary: { lowStockCount: 4, outOfStockCount: 1, totalProducts: 120 },
      criticalItems: [{ productId: '55', productName: 'Sugar 1kg', quantityOnHand: 2, minStockAlert: 10 }],
    }),
    getButtonStaffDashboard: async (storeId: bigint) => ({
      role: 'STAFF_BUTTON' as const,
      summary: { totalButtons: 25, activeButtons: 22, lowBatteryButtons: 2, unassignedButtons: 1 },
      deviceAlerts: [{ buttonId: '9', deviceId: 'DEV-09', batteryLevel: 15, status: 'ACTIVE' }],
    }),
    getDeliveryStaffDashboard: async (userId: bigint) => ({
      role: 'STAFF_DELIVERY' as const,
      summary: { assignedOrdersCount: 3, completedTodayCount: 12 },
      activeOrders: [{ orderId: '202', orderCode: 'ORD-202', orderStatus: 'DELIVERING', recipientName: 'Nguyen Van A' }],
    }),
    getGeneralStaffDashboard: async (storeId: bigint) => ({
      role: 'STORE_STAFF' as const,
      orders: { ordersToPrepare: 8 },
      inventory: { lowStockCount: 4 },
      buttons: { totalButtons: 25 },
      recentActionableOrders: [],
    }),
  };

  const staffService = new StaffService(mockStaffRepo, cacheService);

  // Dispatch 1: STAFF_ORDER
  const orderStaffRes = await staffService.getStaffDashboard({ userId: '31', storeId: '100', role: 'STAFF_ORDER' });
  if (orderStaffRes.role === 'STAFF_ORDER') {
    check(orderStaffRes.summary.ordersToPrepare === 8, 'Staff dashboard dispatches to STAFF_ORDER');
  } else {
    check(false, 'Expected STAFF_ORDER dashboard');
  }

  // Dispatch 2: STAFF_INVENTORY
  const invStaffRes = await staffService.getStaffDashboard({ userId: '32', storeId: '100', role: 'STAFF_INVENTORY' });
  if (invStaffRes.role === 'STAFF_INVENTORY') {
    check(invStaffRes.summary.lowStockCount === 4, 'Staff dashboard dispatches to STAFF_INVENTORY');
  } else {
    check(false, 'Expected STAFF_INVENTORY dashboard');
  }

  // Dispatch 3: STAFF_BUTTON
  const btnStaffRes = await staffService.getStaffDashboard({ userId: '33', storeId: '100', role: 'STAFF_BUTTON' });
  if (btnStaffRes.role === 'STAFF_BUTTON') {
    check(btnStaffRes.summary.lowBatteryButtons === 2, 'Staff dashboard dispatches to STAFF_BUTTON');
  } else {
    check(false, 'Expected STAFF_BUTTON dashboard');
  }

  // Dispatch 4: STAFF_DELIVERY (Driver)
  const deliveryStaffRes = await staffService.getStaffDashboard({ userId: '34', storeId: '100', role: 'STAFF_DELIVERY' });
  if (deliveryStaffRes.role === 'STAFF_DELIVERY') {
    check(deliveryStaffRes.summary.assignedOrdersCount === 3, 'Staff dashboard dispatches to STAFF_DELIVERY');
  } else {
    check(false, 'Expected STAFF_DELIVERY dashboard');
  }

  // Dispatch 5: STORE_STAFF (General)
  const generalStaffRes = await staffService.getStaffDashboard({ userId: '35', storeId: '100', role: 'STORE_STAFF' });
  if (generalStaffRes.role === 'STORE_STAFF') {
    check(generalStaffRes.orders.ordersToPrepare === 8, 'Staff dashboard dispatches to STORE_STAFF general overview');
  } else {
    check(false, 'Expected STORE_STAFF dashboard');
  }

  // Guard: Staff with no storeId must be rejected
  let staffNoStoreRejected = false;
  try {
    await staffService.getStaffDashboard({ userId: '36', role: 'STAFF_ORDER' });
  } catch (err: any) {
    if (err instanceof ForbiddenException) staffNoStoreRejected = true;
  }
  check(staffNoStoreRejected, 'Staff dashboard rejects store-based staff without associated storeId');

  // =========================================================================
  // 6. RBAC PRIVILEGE ESCALATION GUARDS & METHOD OVERRIDES
  // =========================================================================
  console.log('Testing RBAC Privilege Escalation Guards on AdminController...');
  const reflector = new Reflector();
  const rolesGuard = new RolesGuard(reflector);

  const createMockContext = (handler: any, user: any) => ({
    getHandler: () => handler,
    getClass: () => AdminController,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as any);

  // 1. ADMIN calls dashboard -> allowed (method override has ADMIN)
  const adminDashboardContext = createMockContext(AdminController.prototype.getDashboard, { role: 'ADMIN' });
  const adminCanAccessDashboard = rolesGuard.canActivate(adminDashboardContext);
  check(adminCanAccessDashboard === true, 'RBAC: Role ADMIN is granted access to read-only Admin Dashboard');

  // 2. SYSTEM_ADMIN calls dashboard -> allowed (method override has SYSTEM_ADMIN)
  const sysAdminDashboardContext = createMockContext(AdminController.prototype.getDashboard, { role: 'SYSTEM_ADMIN' });
  const sysAdminCanAccessDashboard = rolesGuard.canActivate(sysAdminDashboardContext);
  check(sysAdminCanAccessDashboard === true, 'RBAC: Role SYSTEM_ADMIN is granted access to read-only Admin Dashboard');

  // 3. ADMIN calls payoutViaPayOS -> 403 Forbidden (class-level SUPER_ADMIN applies)
  let adminPayoutBlocked = false;
  try {
    const adminPayoutContext = createMockContext(AdminController.prototype.payoutViaPayOS, { role: 'ADMIN' });
    rolesGuard.canActivate(adminPayoutContext);
  } catch (err: any) {
    if (err instanceof ForbiddenException) adminPayoutBlocked = true;
  }
  check(adminPayoutBlocked, 'RBAC: Role ADMIN is blocked (403) from calling payoutViaPayOS');

  // 4. ADMIN calls updateUserRole -> 403 Forbidden
  let adminUpdateRoleBlocked = false;
  try {
    const adminUpdateRoleContext = createMockContext(AdminController.prototype.updateUserRole, { role: 'ADMIN' });
    rolesGuard.canActivate(adminUpdateRoleContext);
  } catch (err: any) {
    if (err instanceof ForbiddenException) adminUpdateRoleBlocked = true;
  }
  check(adminUpdateRoleBlocked, 'RBAC: Role ADMIN is blocked (403) from calling updateUserRole');

  // 5. SYSTEM_ADMIN calls payoutViaPayOS -> 403 Forbidden
  let sysAdminPayoutBlocked = false;
  try {
    const sysAdminPayoutContext = createMockContext(AdminController.prototype.payoutViaPayOS, { role: 'SYSTEM_ADMIN' });
    rolesGuard.canActivate(sysAdminPayoutContext);
  } catch (err: any) {
    if (err instanceof ForbiddenException) sysAdminPayoutBlocked = true;
  }
  check(sysAdminPayoutBlocked, 'RBAC: Role SYSTEM_ADMIN is blocked (403) from calling payoutViaPayOS');

  // 6. SYSTEM_ADMIN calls updateUserRole -> 403 Forbidden
  let sysAdminUpdateRoleBlocked = false;
  try {
    const sysAdminUpdateRoleContext = createMockContext(AdminController.prototype.updateUserRole, { role: 'SYSTEM_ADMIN' });
    rolesGuard.canActivate(sysAdminUpdateRoleContext);
  } catch (err: any) {
    if (err instanceof ForbiddenException) sysAdminUpdateRoleBlocked = true;
  }
  check(sysAdminUpdateRoleBlocked, 'RBAC: Role SYSTEM_ADMIN is blocked (403) from calling updateUserRole');

  // 7. SUPER_ADMIN calls payoutViaPayOS -> allowed
  const superAdminPayoutContext = createMockContext(AdminController.prototype.payoutViaPayOS, { role: 'SUPER_ADMIN' });
  const superAdminCanPayout = rolesGuard.canActivate(superAdminPayoutContext);
  check(superAdminCanPayout === true, 'RBAC: Role SUPER_ADMIN is granted access to payoutViaPayOS');

  // 8. SUPER_ADMIN calls updateUserRole -> allowed
  const superAdminUpdateRoleContext = createMockContext(AdminController.prototype.updateUserRole, { role: 'SUPER_ADMIN' });
  const superAdminCanUpdateRole = rolesGuard.canActivate(superAdminUpdateRoleContext);
  check(superAdminCanUpdateRole === true, 'RBAC: Role SUPER_ADMIN is granted access to updateUserRole');

  // =========================================================================
  // 7. DRILL-DOWN DTO VALIDATION CONSTRAINTS (INVENTORY & LEADERBOARD)
  // =========================================================================
  console.log('Testing Drill-Down DTO Validation Constraints...');
  // Inventory DTO valid
  const invDtoValid = plainToInstance(InventoryAnalyticsQueryDto, { page: 1, pageSize: 20, filter: 'low_stock' });
  const invErrorsValid = await validate(invDtoValid);
  check(invErrorsValid.length === 0, 'DTO: InventoryAnalyticsQueryDto accepts valid page, pageSize, and filter');

  // Inventory DTO invalid (fractional, out of bounds, unknown filter)
  const invDtoInvalid = plainToInstance(InventoryAnalyticsQueryDto, { page: 1.5, pageSize: 101, filter: 'invalid_filter' });
  const invErrorsInvalid = await validate(invDtoInvalid);
  check(invErrorsInvalid.length >= 3, 'DTO: InventoryAnalyticsQueryDto rejects fractional page, pageSize > 100, and invalid filter');

  // Leaderboard DTO valid
  const lbDtoValid = plainToInstance(AdminStoresLeaderboardQueryDto, { page: 1, pageSize: 20 });
  const lbErrorsValid = await validate(lbDtoValid);
  check(lbErrorsValid.length === 0, 'DTO: AdminStoresLeaderboardQueryDto accepts valid pagination');

  // Leaderboard DTO invalid (fractional, > 100)
  const lbDtoInvalid = plainToInstance(AdminStoresLeaderboardQueryDto, { page: 1.5, pageSize: 101 });
  const lbErrorsInvalid = await validate(lbDtoInvalid);
  check(lbErrorsInvalid.length >= 2, 'DTO: AdminStoresLeaderboardQueryDto rejects fractional page and pageSize > 100');

  // =========================================================================
  // 8. CANONICAL DOMAIN ORDER STATUS INVARIANTS & REJECTION OF LEGACY STATUSES
  // =========================================================================
  console.log('Testing Canonical Domain Order Status Invariants...');
  check(
    IN_TRANSIT_ORDER_STATUSES.includes('READY_FOR_DELIVERY') &&
    IN_TRANSIT_ORDER_STATUSES.includes('SHIPPING') &&
    !(IN_TRANSIT_ORDER_STATUSES as readonly string[]).includes('READY') &&
    !(IN_TRANSIT_ORDER_STATUSES as readonly string[]).includes('DELIVERING'),
    'Status: In-transit statuses strictly include READY_FOR_DELIVERY & SHIPPING, and exclude legacy READY & DELIVERING',
  );

  check(
    REALIZED_ORDER_STATUSES.includes('DELIVERED') &&
    REALIZED_ORDER_STATUSES.includes('COMPLETED') &&
    !(REALIZED_ORDER_STATUSES as readonly string[]).includes('CANCELLED') &&
    !(REALIZED_ORDER_STATUSES as readonly string[]).includes('REJECTED'),
    'Status: Realized revenue statuses strictly include DELIVERED & COMPLETED only',
  );

  check(
    EXCLUDED_GMV_STATUSES.includes('CANCELLED') &&
    EXCLUDED_GMV_STATUSES.includes('REJECTED') &&
    !(EXCLUDED_GMV_STATUSES as readonly string[]).includes('DELIVERY_FAILED'),
    'Status: Excluded GMV statuses strictly distinguish store rejection/cancellation from delivery failure',
  );

  check(
    FAILED_DELIVERY_STATUSES.includes('DELIVERY_FAILED') &&
    !(FAILED_DELIVERY_STATUSES as readonly string[]).includes('REJECTED'),
    'Status: Failed delivery status is cleanly separated from REJECTED',
  );

  // =========================================================================
  // 9. MUTATION CACHE INVALIDATION PIPELINE VERIFICATION
  // =========================================================================
  console.log('Testing Mutation Cache Invalidation Pipeline...');

  // 9a. Exact Key vs Prefix isolation (User 7 vs 77)
  {
    await cacheService.set('customer:dashboard:7', { user: 7 }, 30);
    await cacheService.set('customer:dashboard:77', { user: 77 }, 30);
    await cacheService.invalidateKey('customer:dashboard:7');
    check((await cacheService.get('customer:dashboard:7')) === null, 'Exact key invalidation: user 7 cache cleared');
    check((await cacheService.get('customer:dashboard:77')) !== null, 'Exact key isolation: user 77 cache strictly preserved without prefix collision');
  }

  // 9b. Rental creation: customerId = 7 (profile), userId = 99 (user)
  // Ensures customerProfile ID is not confused with user ID during invalidation
  {
    const RentalsService = (await import('../src/rentals/rentals.service')).RentalsService;
    const mockRentalsRepo: any = {
      listAvailablePackages: async () => [],
      createRental: async (data: any) => ({
        rentalId: 101n,
        rentalCode: data.rentalCode,
        customerId: data.customerId, // 7n (CustomerProfile ID)
        packageId: data.packageId,
        monthsRented: data.monthsRented,
        totalRentAmount: data.totalRentAmount,
        depositAmount: data.depositAmount,
        startDate: data.startDate,
        endDate: data.endDate,
        status: data.status,
        customer: {
          customerId: 7n,
          userId: 99n, // User ID
        },
        package: { packageId: 1n, packageName: 'Button Plan', monthlyPrice: 50000 },
      }),
      findPackageById: async () => ({ packageId: 1n, isActive: true, monthlyPrice: 50000, depositFee: 10000 }),
      findRentalById: async () => ({
        rentalId: 101n,
        rentalCode: 'RNT-101',
        packageId: 1n,
        customerId: 7n,
        customer: { customerId: 7n, userId: 99n },
        package: { packageId: 1n, monthlyPrice: 50000 },
        status: 'ACTIVE',
        endDate: new Date(Date.now() + 30 * 86400000),
      }),
      extendRental: async (_id: any, newEnd: any, months: any, amount: any) => ({
        rentalId: 101n,
        rentalCode: 'RNT-101',
        packageId: 1n,
        customerId: 7n,
        status: 'ACTIVE',
        monthsRented: months,
        totalRentAmount: amount,
        endDate: newEnd,
        package: { packageId: 1n, monthlyPrice: 50000 },
        customer: { customerId: 7n, userId: 99n },
      }),
      updateRentalStatus: async (_id: any, status: string) => ({
        rentalId: 101n,
        rentalCode: 'RNT-101',
        packageId: 1n,
        customerId: 7n,
        status,
        package: { packageId: 1n, monthlyPrice: 50000 },
        customer: { customerId: 7n, userId: 99n },
      }),
    };
    const rentalsService = new RentalsService(mockRentalsRepo, cacheService);

    await cacheService.set('customer:dashboard:99', { marker: 'old' }, 30);
    await cacheService.set('customer:rentals:99', { marker: 'old' }, 30);
    await cacheService.set('customer:dashboard:7', { marker: 'keep' }, 30);

    await rentalsService.createRentalContract(7n, { packageId: '1', monthsRented: 2 } as any);

    check((await cacheService.get('customer:dashboard:99')) === null, 'Rental create: customer 99 dashboard cache cleared');
    check((await cacheService.get('customer:rentals:99')) === null, 'Rental create: customer 99 rentals drilldown cache cleared');
    check((await cacheService.get('customer:dashboard:7')) !== null, 'Rental create: customerProfile ID 7 was NOT cleared (no user ID corruption)');

    // 9c. All 5 rental mutations invalidate customer:dashboard and customer:rentals
    // 2) extendRentalContract
    await cacheService.set('customer:dashboard:99', { marker: 'old' }, 30);
    await cacheService.set('customer:rentals:99', { marker: 'old' }, 30);
    await rentalsService.extendRentalContract('101', { additionalMonths: 1 } as any, { role: 'CUSTOMER', userId: '99', customerProfileId: '7' });
    check((await cacheService.get('customer:dashboard:99')) === null, 'Rental extend: customer 99 dashboard cache cleared');
    check((await cacheService.get('customer:rentals:99')) === null, 'Rental extend: customer 99 rentals cache cleared');

    // 3) requestRentalReturn
    await cacheService.set('customer:dashboard:99', { marker: 'old' }, 30);
    await cacheService.set('customer:rentals:99', { marker: 'old' }, 30);
    await rentalsService.requestRentalReturn('101', { role: 'CUSTOMER', userId: '99', customerProfileId: '7' });
    check((await cacheService.get('customer:dashboard:99')) === null, 'Rental return: customer 99 dashboard cache cleared');
    check((await cacheService.get('customer:rentals:99')) === null, 'Rental return: customer 99 rentals cache cleared');

    // 4) activateRental
    await cacheService.set('customer:dashboard:99', { marker: 'old' }, 30);
    await cacheService.set('customer:rentals:99', { marker: 'old' }, 30);
    await rentalsService.activateRental('101');
    check((await cacheService.get('customer:dashboard:99')) === null, 'Rental activate: customer 99 dashboard cache cleared');
    check((await cacheService.get('customer:rentals:99')) === null, 'Rental activate: customer 99 rentals cache cleared');

    // 5) updateRentalStatusAdmin
    await cacheService.set('customer:dashboard:99', { marker: 'old' }, 30);
    await cacheService.set('customer:rentals:99', { marker: 'old' }, 30);
    await rentalsService.updateRentalStatusAdmin('101', 'COMPLETED');
    check((await cacheService.get('customer:dashboard:99')) === null, 'Rental admin update: customer 99 dashboard cache cleared');
    check((await cacheService.get('customer:rentals:99')) === null, 'Rental admin update: customer 99 rentals cache cleared');
  }

  // 9d. Device mutations: Staff 500 in store 42 updates device owned by customer 99
  // Verifies cache of device owner (customer 99) and store 42 are cleared, while staff 500 and other stores stay untouched
  {
    const DevicesService = (await import('../src/devices/devices.service')).DevicesService;
    const mockDevRepo: any = {
      findByIdentifier: async () => ({
        buttonId: 1n,
        deviceId: 'DEV-001',
        buttonCode: 'BTN-001',
        storeId: 42n,
        customerId: 7n,
        customer: { customerId: 7n, userId: 99n },
        status: 'ACTIVE',
        batteryLevel: 50,
      }),
      update: async (_id: any, data: any) => ({
        buttonId: 1n,
        deviceId: 'DEV-001',
        buttonCode: 'BTN-001',
        storeId: 42n,
        customerId: 7n,
        customer: { customerId: 7n, userId: 99n },
        status: data.status || 'ACTIVE',
        batteryLevel: data.batteryLevel ?? 50,
      }),
    };
    const devSvc = new DevicesService(mockDevRepo, {} as any, undefined, cacheService);

    await cacheService.set('customer:dashboard:99', { marker: 'old' }, 30);
    await cacheService.set('customer:devices:99', { marker: 'old' }, 30);
    await cacheService.set('customer:dashboard:500', { marker: 'keep' }, 30);
    await cacheService.set('dash:store:42:summary', { marker: 'old' }, 30);
    await cacheService.set('dash:store:88:summary', { marker: 'keep' }, 30);

    await devSvc.updateBattery('1', 10, {
      role: 'STAFF_BUTTON',
      userId: '500',
      storeId: '42',
    });

    check((await cacheService.get('customer:dashboard:99')) === null, 'Device updateBattery: owner customer 99 dashboard cleared');
    check((await cacheService.get('customer:devices:99')) === null, 'Device updateBattery: owner customer 99 devices cleared');
    check((await cacheService.get('customer:dashboard:500')) !== null, 'Device updateBattery: staff 500 customer dashboard NOT cleared');
    check((await cacheService.get('dash:store:42:summary')) === null, 'Device updateBattery: store 42 cache cleared');
    check((await cacheService.get('dash:store:88:summary')) !== null, 'Device updateBattery: unrelated store 88 cache preserved');

    // 9e. Device Remap: clears old store 42, new store 43, and owning customer 99
    let currentStore = 42n;
    const mockRemapRepo: any = {
      findByIdentifier: async () => ({
        buttonId: 2n,
        deviceId: 'DEV-002',
        buttonCode: 'BTN-002',
        storeId: currentStore,
        customerId: 7n,
        customer: { customerId: 7n, userId: 99n },
        status: 'ACTIVE',
      }),
      findActiveStoreById: async () => ({ storeId: 43n, status: 'ACTIVE' }),
      remapStore: async (_bId: any, newStoreId: any) => { currentStore = newStoreId; },
      update: async (_bId: any, data: any) => ({
        buttonId: 2n,
        deviceId: 'DEV-002',
        storeId: currentStore,
        customerId: 7n,
        customer: { customerId: 7n, userId: 99n },
        ...data,
      }),
    };
    const devRemapSvc = new DevicesService(mockRemapRepo, {} as any, undefined, cacheService);

    await cacheService.set('dash:store:42:summary', { marker: 'old' }, 30);
    await cacheService.set('dash:store:43:summary', { marker: 'old' }, 30);
    await cacheService.set('dash:store:88:summary', { marker: 'keep' }, 30);
    await cacheService.set('customer:dashboard:99', { marker: 'old' }, 30);

    await devRemapSvc.customerUpdateConfig('2', { storeId: '43' }, { role: 'CUSTOMER', userId: '99', customerProfileId: '7' });

    check((await cacheService.get('dash:store:42:summary')) === null, 'Device remap: old store 42 cache cleared');
    check((await cacheService.get('dash:store:43:summary')) === null, 'Device remap: new store 43 cache cleared');
    check((await cacheService.get('dash:store:88:summary')) !== null, 'Device remap: unrelated store 88 cache preserved');
    check((await cacheService.get('customer:dashboard:99')) === null, 'Device remap: customer 99 cache cleared');

    // 9f. Mutation rejected before DB: cache must NOT be invalidated
    await cacheService.set('customer:dashboard:99', { marker: 'keep-unmodified' }, 30);
    let forbiddenThrown = false;
    try {
      // Staff from unauthorized store tries to mutate device
      await devSvc.updateBattery('1', 10, { role: 'STAFF_BUTTON', userId: '500', storeId: '88' });
    } catch {
      forbiddenThrown = true;
    }
    check(forbiddenThrown, 'Security: Access check rejects unauthorized mutation before DB');
    check((await cacheService.get('customer:dashboard:99'))?.marker === 'keep-unmodified', 'Cache untouched: Rejected mutation does NOT invalidate cache');

    // 9g. Read dashboard/drill-down after mutation: Fetcher runs again and returns fresh data
    let customerDashboardFetches = 0;
    const customerDashboardFetcher = async () => {
      customerDashboardFetches++;
      return { activeDevices: customerDashboardFetches, version: customerDashboardFetches };
    };

    await cacheService.invalidateKey('customer:dashboard:99');
    const v1 = await cacheService.getOrSet('customer:dashboard:99', 30, customerDashboardFetcher);
    check(v1.version === 1 && customerDashboardFetches === 1, 'Initial fetch populates dashboard cache');

    const vCached = await cacheService.getOrSet('customer:dashboard:99', 30, customerDashboardFetcher);
    check(vCached.version === 1 && customerDashboardFetches === 1, 'Subsequent fetch served from cache without re-fetching');

    // Trigger mutation on device owned by 99
    await devSvc.updateBattery('1', 100, { role: 'STORE_OWNER', storeId: '42' });

    // Fetch after mutation
    const vFresh = await cacheService.getOrSet('customer:dashboard:99', 30, customerDashboardFetcher);
    check(vFresh.version === 2 && customerDashboardFetches === 2, 'Fetcher runs again after mutation invalidation, returning fresh data');

    // 9h. Resilience: Cache throws error - mutation still completes successfully
    const faultyCache = {
      invalidateKey: async () => { throw new Error('Redis connection lost'); },
      invalidatePrefix: async () => { throw new Error('Redis connection lost'); },
    } as any;
    const resilientDevSvc = new DevicesService(mockDevRepo, {} as any, undefined, faultyCache);
    let mutationSuccess = false;
    try {
      const res = await resilientDevSvc.updateBattery('1', 99, { role: 'STORE_OWNER', storeId: '42' });
      mutationSuccess = res.batteryLevel === 99;
    } catch {
      mutationSuccess = false;
    }
    check(mutationSuccess, 'Resilience: Mutation completes successfully even when cache invalidation throws');
  }

  // 9i. Direct refundFailedWithdrawal: invalidates wallet cache after commit
  {
    const StoreWalletService = (await import('../src/store-wallet/store-wallet.service')).StoreWalletService;
    const mockWalletPrisma: any = {
      $transaction: async (cb: any) => {
        return cb({
          $queryRaw: async (query: any) => {
            const text = (
              Array.isArray(query)
                ? query.join(' ')
                : (query?.strings?.join(' ') || query?.sql || query?.text || String(query))
            ).toLowerCase();
            if (text.includes('store_withdrawals')) {
              return [{ withdrawal_id: 88n, status: 'PROCESSING', amount: 50000, wallet_id: 10n, withdrawal_code: 'W-88' }];
            }
            if (text.includes('store_wallets')) {
              return [{ wallet_id: 10n, balance: 100000, frozen_balance: 50000 }];
            }
            return [];
          },
          walletTransaction: { findFirst: async () => null, create: async () => ({}) },
          storeWallet: { update: async () => ({}) },
          storeWithdrawal: { update: async () => ({ withdrawalId: 88n, status: 'FAILED' }), findUnique: async () => ({ withdrawalId: 88n, status: 'FAILED' }) },
        });
      },
      storeWithdrawal: {
        findUnique: async () => ({ withdrawalId: 88n, wallet: { storeId: 42n } }),
      },
    };
    const walletSvc = new StoreWalletService(mockWalletPrisma, undefined, undefined, cacheService);

    await cacheService.set('dash:store:42:wallet', { balance: 100000 }, 30);
    await cacheService.set('admin:dashboard:stats', { marker: 'old' }, 30);
    await cacheService.set('dash:store:99:wallet', { balance: 999999 }, 30);

    await walletSvc.refundFailedWithdrawal(88n, 'PayOS payout error');

    check((await cacheService.get('dash:store:42:wallet')) === null, 'Wallet direct refund: store 42 cache cleared after commit');
    check((await cacheService.get('admin:dashboard:stats')) === null, 'Wallet direct refund: admin stats cache cleared');
    check((await cacheService.get('dash:store:99:wallet')) !== null, 'Wallet direct refund: unrelated store 99 wallet preserved');
  }

  // 9j. Admin user status/role mutations invalidate admin cache
  {
    const AdminService = (await import('../src/admin/admin.service')).AdminService;
    const mockAdminUserRepo: any = {
      findUserById: async () => ({ userId: 99n, status: 'ACTIVE' }),
      updateUserStatus: async () => ({ userId: 99n, status: 'INACTIVE' }),
      findOrCreateRole: async () => ({ roleId: 2n }),
      updateStaffRole: async () => ({}),
    };
    const adminUserSvc = new AdminService(
      mockAdminUserRepo,
      null as any, // payout
      cacheService,
    );

    await cacheService.set('admin:dashboard:users', { marker: 'old' }, 30);
    await cacheService.set('admin:operations:users', { marker: 'old' }, 30);

    await adminUserSvc.toggleUserStatus('99');
    check((await cacheService.get('admin:dashboard:users')) === null, 'Admin toggleUserStatus: admin dashboard cache invalidated');
    check((await cacheService.get('admin:operations:users')) === null, 'Admin toggleUserStatus: admin operations cache invalidated');

    await cacheService.set('admin:dashboard:roles', { marker: 'old' }, 30);
    await adminUserSvc.updateUserRole('99', 'STORE_MANAGER');
    check((await cacheService.get('admin:dashboard:roles')) === null, 'Admin updateUserRole: admin dashboard cache invalidated');
  }

  // Teardown cache
  await cacheService.onModuleDestroy();

  console.log(`\n========================================================================`);
  console.log(`✔ Suite 44 PASSED: ${passed}/${passed} assertions successfully verified!`);
  console.log(`========================================================================\n`);

  process.exit(0);
}

runAnalyticsDashboardE2ESuite().catch((err) => {
  console.error('Suite 44 failed with error:', err);
  process.exit(1);
});

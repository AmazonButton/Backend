import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/api/v1';

function logTest(name: string, passed: boolean, detail?: string) {
  if (passed) {
    console.log(`\x1b[32m  ✔ [PASS]\x1b[0m ${name}`);
  } else {
    console.log(`\x1b[31m  ✖ [FAIL]\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function runFrontendContractAndNotificationsSuite() {
  console.log('\n========================================================================');
  console.log('🚀 SUITE 15: FRONTEND CONTRACT GAP & NOTIFICATIONS INTEGRATION SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  // Track entities for teardown
  let testUserId: bigint | null = null;
  let testCustomerToken = '';
  let testStoreToken = '';
  let testStoreId = '';
  let testAdminToken = '';
  let createdProductId: string | null = null;
  let createdOrderId: string | null = null;
  const createdNotificationIds: bigint[] = [];

  try {
    // -------------------------------------------------------------------------
    // 0. Setup Personas & Tokens
    // -------------------------------------------------------------------------
    // Login Customer
    const custLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'customer@smartorder.local', password: 'Password123!' }),
    });
    const custLoginData = await custLoginRes.json();
    testCustomerToken = custLoginData.data?.token || custLoginData.token;

    // Login Store Owner
    const storeLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'store@smartorder.local', password: 'Password123!' }),
    });
    const storeLoginData = await storeLoginRes.json();
    testStoreToken = storeLoginData.data?.token || storeLoginData.token;
    testStoreId = storeLoginData.data?.user?.storeId || storeLoginData.user?.storeId;

    // Login Admin
    const adminLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@smartorder.local', password: 'Password123!' }),
    });
    const adminLoginData = await adminLoginRes.json();
    testAdminToken = adminLoginData.data?.token || adminLoginData.token;

    logTest('0. Setup: Logged in customer, store owner, and admin', Boolean(testCustomerToken && testStoreToken && testAdminToken));
    passed++;

    // -------------------------------------------------------------------------
    // 1. Auth: POST /auth/change-password & PUT /auth/profile
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 1] Auth Contract: Change Password & Profile Alias');

    // Create a temporary user dedicated to password change test
    const tempUsername = `pw_test_${Date.now()}`;
    const tempEmail = `${tempUsername}@smartorder.test`;
    const tempPassword = 'OldPassword123@';

    const tempPhone = `09${Math.floor(10000000 + Math.random() * 90000000)}`;

    const regRes = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Password Test User',
        username: tempUsername,
        email: tempEmail,
        password: tempPassword,
        phone: tempPhone,
      }),
    });
    const regData = await regRes.json();
    if (regRes.status !== 201 && regRes.status !== 200) {
      throw new Error(`Register failed: ${JSON.stringify(regData)}`);
    }

    const tempUserDb = await prisma.user.findFirst({ where: { email: tempEmail } });
    if (!tempUserDb) throw new Error(`User not found in DB: ${tempEmail}`);
    testUserId = tempUserDb.userId;

    // Activate user directly in DB
    await prisma.user.update({
      where: { userId: testUserId },
      data: { status: 'ACTIVE' },
    });

    // Login temp user
    const tempLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: tempEmail, password: tempPassword }),
    });
    const tempLoginData = await tempLoginRes.json();
    let tempToken = tempLoginData.data?.token || tempLoginData.token;

    // 1.1 Change Password: Wrong current password -> 401
    const wrongOldRes = await fetch(`${BASE_URL}/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tempToken}`,
      },
      body: JSON.stringify({
        currentPassword: 'WrongOldPassword123@',
        newPassword: 'NewPassword123@',
      }),
    });
    const wrongOldData = await wrongOldRes.json();
    const test11 = wrongOldRes.status === 401 && wrongOldData.code === 'INCORRECT_CURRENT_PASSWORD';
    logTest('1.1 Change Password: Incorrect current password rejected with 401', test11);
    test11 ? passed++ : failed++;

    // 1.2 Change Password: New password same as current password -> 400
    const samePwRes = await fetch(`${BASE_URL}/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tempToken}`,
      },
      body: JSON.stringify({
        currentPassword: tempPassword,
        newPassword: tempPassword,
      }),
    });
    const samePwData = await samePwRes.json();
    const test12 = samePwRes.status === 400 && samePwData.code === 'PASSWORD_UNCHANGED';
    logTest('1.2 Change Password: Same new password rejected with 400', test12);
    test12 ? passed++ : failed++;

    // 1.3 Change Password: Weak new password -> 400
    const weakPwRes = await fetch(`${BASE_URL}/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tempToken}`,
      },
      body: JSON.stringify({
        currentPassword: tempPassword,
        newPassword: 'short',
      }),
    });
    const test13 = weakPwRes.status === 400;
    logTest('1.3 Change Password: Weak new password rejected with 400 validation error', test13);
    test13 ? passed++ : failed++;

    // 1.4 Change Password: Valid change -> 200
    const newPassword = 'BrandNewPassword123@';
    const validChangeRes = await fetch(`${BASE_URL}/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tempToken}`,
      },
      body: JSON.stringify({
        currentPassword: tempPassword,
        newPassword,
      }),
    });
    const validChangeData = await validChangeRes.json();
    const test14 = validChangeRes.status === 200 && validChangeData.success === true;
    logTest('1.4 Change Password: Valid credentials successfully updated (200 OK)', test14);
    test14 ? passed++ : failed++;

    // 1.5 Immediate Invalidation: Old JWT must be rejected (401) on subsequent requests
    // Wait 1 second so iat is strictly less than password_changed_at
    await new Promise((r) => setTimeout(r, 1100));
    const oldJwtCheckRes = await fetch(`${BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${tempToken}` },
    });
    const test15 = oldJwtCheckRes.status === 401;
    logTest('1.5 Change Password Security: Old JWT immediately rejected with 401', test15);
    test15 ? passed++ : failed++;

    // 1.6 Login with New Password succeeds
    const newLoginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: tempEmail, password: newPassword }),
    });
    const newLoginData = await newLoginRes.json();
    const test16 = newLoginRes.status === 200 && Boolean(newLoginData.data?.token || newLoginData.token);
    if (test16) {
      tempToken = newLoginData.data?.token || newLoginData.token;
    }
    logTest('1.6 Change Password: Login with new password succeeded (200 OK)', test16);
    test16 ? passed++ : failed++;

    // 1.7 PUT /auth/profile: Alias endpoint updates profile
    const putProfileRes = await fetch(`${BASE_URL}/auth/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tempToken}`,
      },
      body: JSON.stringify({
        fullName: 'Updated Via PUT Profile',
      }),
    });
    const putProfileData = await putProfileRes.json();
    const test17 = putProfileRes.status === 200 && putProfileData.data?.fullName === 'Updated Via PUT Profile';
    logTest('1.7 Profile Alias: PUT /auth/profile successfully updates user profile (200 OK)', test17);
    test17 ? passed++ : failed++;

    // -------------------------------------------------------------------------
    // 2. Payments: POST /payments/orders/:orderId/payment-method
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 2] Payments Contract: Change Order Payment Method');

    // Create a pending test order for customer
    const customerUser = await prisma.user.findFirst({ where: { email: 'customer@smartorder.local' }, include: { customerProfile: true } });
    const storeRecord = await prisma.store.findFirst();
    const buttonRecord = await prisma.ioTButton.findFirst();

    if (!customerUser?.customerProfile || !storeRecord || !buttonRecord) {
      throw new Error('Required fixtures for orders missing');
    }

    const testOrder = await prisma.order.create({
      data: {
        orderCode: `ORD-PM-${Date.now()}`,
        customerId: customerUser.customerProfile.customerId,
        storeId: storeRecord.storeId,
        buttonId: buttonRecord.buttonId,
        orderStatus: 'PENDING',
        paymentStatus: 'UNPAID',
        paymentMethod: 'COD',
        subtotalAmount: 50000,
        totalAmount: 50000,
        shippingRecipientName: 'Customer Test',
        shippingPhone: '0901234567',
        shippingAddress: '123 Test Street, District 1, HCMC',
      },
    });
    createdOrderId = testOrder.orderId.toString();

    // 2.1 BOLA Protection: Store owner cannot change customer's order payment method
    const bolaRes = await fetch(`${BASE_URL}/payments/orders/${createdOrderId}/payment-method`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testStoreToken}`,
      },
      body: JSON.stringify({ paymentMethod: 'PAYOS' }),
    });
    const test21 = bolaRes.status === 403;
    logTest('2.1 Payment Method BOLA: Non-owner blocked from modifying order payment method (403)', test21);
    test21 ? passed++ : failed++;

    // 2.2 Invalid Payment Method -> 400
    const invalidMethodRes = await fetch(`${BASE_URL}/payments/orders/${createdOrderId}/payment-method`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testCustomerToken}`,
      },
      body: JSON.stringify({ paymentMethod: 'BITCOIN' }),
    });
    const test22 = invalidMethodRes.status === 400;
    logTest('2.2 Payment Method Validation: Unsupported payment method rejected (400 Bad Request)', test22);
    test22 ? passed++ : failed++;

    // 2.3 Valid Payment Method Change: COD -> PAYOS
    const validChangePmRes = await fetch(`${BASE_URL}/payments/orders/${createdOrderId}/payment-method`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testCustomerToken}`,
      },
      body: JSON.stringify({ paymentMethod: 'PAYOS' }),
    });
    const validChangePmData = await validChangePmRes.json();
    const test23 = (validChangePmRes.status === 200 || validChangePmRes.status === 201) && validChangePmData.data?.paymentMethod === 'PAYOS';
    logTest('2.3 Payment Method Change: Successfully changed COD -> PAYOS on PENDING order (200 OK)', test23, `status=${validChangePmRes.status}, body=${JSON.stringify(validChangePmData)}`);
    test23 ? passed++ : failed++;

    // 2.4 Cannot change payment method once order is PAID or CONFIRMED
    await prisma.order.update({
      where: { orderId: testOrder.orderId },
      data: { paymentStatus: 'PAID', orderStatus: 'CONFIRMED' },
    });
    const paidChangeRes = await fetch(`${BASE_URL}/payments/orders/${createdOrderId}/payment-method`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testCustomerToken}`,
      },
      body: JSON.stringify({ paymentMethod: 'COD' }),
    });
    const test24 = paidChangeRes.status === 400;
    logTest('2.4 Payment Method Invariant: Modifying payment method on PAID/CONFIRMED order rejected (400)', test24);
    test24 ? passed++ : failed++;

    // -------------------------------------------------------------------------
    // 3. Products: DELETE /products/:id
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 3] Products Contract: DELETE /products/:id');

    // Create a product for testStore
    const testProd = await prisma.product.create({
      data: {
        storeId: BigInt(testStoreId),
        productName: `Test Delete Product ${Date.now()}`,
        productCode: `DEL-PRD-${Date.now()}`,
        brand: 'TestBrand',
        basePrice: 25000,
        status: 'ACTIVE',
      },
    });
    createdProductId = testProd.productId.toString();

    // 3.1 Tenant Isolation: Customer cannot delete store product
    const custDeleteRes = await fetch(`${BASE_URL}/products/${createdProductId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testCustomerToken}` },
    });
    const test31 = custDeleteRes.status === 403;
    logTest('3.1 Product Delete RBAC: Customer blocked from deleting product (403 Forbidden)', test31);
    test31 ? passed++ : failed++;

    // 3.2 Active Order Protection: Map product to active order item
    const orderWithItem = await prisma.order.create({
      data: {
        orderCode: `ORD-DEL-PRD-${Date.now()}`,
        customerId: customerUser.customerProfile.customerId,
        storeId: BigInt(testStoreId),
        buttonId: buttonRecord.buttonId,
        orderStatus: 'PREPARING',
        paymentStatus: 'PAID',
        paymentMethod: 'PAYOS',
        subtotalAmount: 25000,
        totalAmount: 25000,
        shippingRecipientName: 'Customer Test',
        shippingPhone: '0901234567',
        shippingAddress: '123 Test Street, District 1, HCMC',
        items: {
          create: {
            productId: testProd.productId,
            productNameSnapshot: testProd.productName,
            unitPriceSnapshot: 25000,
            finalUnitPrice: 25000,
            quantity: 1,
            itemSubtotal: 25000,
          },
        },
      },
    });

    const activeOrderDeleteRes = await fetch(`${BASE_URL}/products/${createdProductId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testStoreToken}` },
    });
    const test32 = activeOrderDeleteRes.status === 400;
    logTest('3.2 Product Delete Safety: Product with active processing order rejected (400)', test32);
    test32 ? passed++ : failed++;

    // Clean active order items so product can be deleted
    await prisma.orderItem.deleteMany({ where: { orderId: orderWithItem.orderId } });
    await prisma.order.delete({ where: { orderId: orderWithItem.orderId } });

    // 3.3 Valid Delete: Soft-delete product (status -> INACTIVE)
    const validDeleteRes = await fetch(`${BASE_URL}/products/${createdProductId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testStoreToken}` },
    });
    const validDeleteData = await validDeleteRes.json();
    const prodDbAfter = await prisma.product.findUnique({ where: { productId: testProd.productId } });
    const test33 = validDeleteRes.status === 200 && prodDbAfter?.status === 'INACTIVE';
    logTest('3.3 Product Delete: Successfully soft-deleted product to INACTIVE (200 OK)', test33);
    test33 ? passed++ : failed++;

    // -------------------------------------------------------------------------
    // 4. Notifications Module: History, Unread Count & Mark Read
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 4] Notifications APIs: List, Unread Count, Read Single & Read All');

    // Create 3 test notifications for customerUser
    const customerUserId = customerUser.userId;
    const notif1 = await prisma.notification.create({
      data: {
        userId: customerUserId,
        type: 'ORDER_STATUS_CHANGED',
        title: 'Đơn hàng đã được xác nhận',
        body: 'Cửa hàng đã xác nhận đơn hàng của bạn.',
        idempotencyKey: `test:notif:1:${Date.now()}`,
      },
    });
    const notif2 = await prisma.notification.create({
      data: {
        userId: customerUserId,
        type: 'ORDER_READY_FOR_DELIVERY',
        title: 'Đơn hàng sẵn sàng giao',
        body: 'Đơn hàng đã sẵn sàng giao tới bạn.',
        idempotencyKey: `test:notif:2:${Date.now()}`,
      },
    });
    createdNotificationIds.push(notif1.notificationId, notif2.notificationId);

    // 4.1 GET /notifications (Paginated list)
    const listRes = await fetch(`${BASE_URL}/notifications?page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${testCustomerToken}` },
    });
    const listData = await listRes.json();
    const test41 = listRes.status === 200 && Array.isArray(listData.data) && listData.data.length >= 2;
    logTest('4.1 Notifications List: GET /notifications returns paginated list for user (200 OK)', test41);
    test41 ? passed++ : failed++;

    // 4.2 GET /notifications/unread-count
    const unreadRes = await fetch(`${BASE_URL}/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${testCustomerToken}` },
    });
    const unreadData = await unreadRes.json();
    const initialUnread = unreadData.data?.unreadCount;
    const test42 = unreadRes.status === 200 && typeof initialUnread === 'number' && initialUnread >= 2;
    logTest('4.2 Notifications Unread Count: GET /notifications/unread-count returns accurate count', test42);
    test42 ? passed++ : failed++;

    // 4.3 BOLA Protection: Store owner cannot mark customer's notification as read
    const bolaReadRes = await fetch(`${BASE_URL}/notifications/${notif1.notificationId}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${testStoreToken}` },
    });
    const test43 = bolaReadRes.status === 403;
    logTest('4.3 Notifications BOLA: User cannot mark another user\'s notification as read (403 Forbidden)', test43);
    test43 ? passed++ : failed++;

    // 4.4 PATCH /notifications/:id/read (Customer marks own notif1 as read)
    const readSingleRes = await fetch(`${BASE_URL}/notifications/${notif1.notificationId}/read`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${testCustomerToken}` },
    });
    const readSingleData = await readSingleRes.json();
    const notif1Db = await prisma.notification.findUnique({ where: { notificationId: notif1.notificationId } });
    const test44 = readSingleRes.status === 200 && notif1Db?.readAt !== null;
    logTest('4.4 Notifications Mark Read: Single notification marked readAt successfully (200 OK)', test44);
    test44 ? passed++ : failed++;

    // 4.5 Unread count decreased by 1
    const unreadAfterSingleRes = await fetch(`${BASE_URL}/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${testCustomerToken}` },
    });
    const unreadAfterSingleData = await unreadAfterSingleRes.json();
    const test45 = unreadAfterSingleData.data?.unreadCount === initialUnread - 1;
    logTest('4.5 Notifications Count Sync: Unread count decremented by exactly 1', test45);
    test45 ? passed++ : failed++;

    // 4.6 PATCH /notifications/read-all (Mark all remaining as read)
    const readAllRes = await fetch(`${BASE_URL}/notifications/read-all`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${testCustomerToken}` },
    });
    const readAllData = await readAllRes.json();
    const unreadAfterAllRes = await fetch(`${BASE_URL}/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${testCustomerToken}` },
    });
    const unreadAfterAllData = await unreadAfterAllRes.json();
    const test46 = readAllRes.status === 200 && unreadAfterAllData.data?.unreadCount === 0;
    logTest('4.6 Notifications Mark Read-All: Successfully marked all unread notifications to read (count = 0)', test46);
    test46 ? passed++ : failed++;

    // -------------------------------------------------------------------------
    // 5. PayOS Webhook: Atomic Notification Creation & Idempotency
    // -------------------------------------------------------------------------
    console.log('\n[SECTION 5] PayOS Webhook: Atomic Notification & Idempotency Key');

    // Create a pending PayOS transaction
    const webhookOrder = await prisma.order.create({
      data: {
        orderCode: `ORD-WH-NOTIF-${Date.now()}`,
        customerId: customerUser.customerProfile.customerId,
        storeId: BigInt(testStoreId),
        buttonId: buttonRecord.buttonId,
        orderStatus: 'PENDING',
        paymentStatus: 'UNPAID',
        paymentMethod: 'PAYOS',
        subtotalAmount: 150000,
        totalAmount: 150000,
        shippingRecipientName: 'Customer Test',
        shippingPhone: '0901234567',
        shippingAddress: '123 Test Street, District 1, HCMC',
      },
    });

    const orderCodeNum = Math.floor(100000 + Math.random() * 900000);
    const mockPaymentLinkId = `link_notif_${orderCodeNum}`;

    const txRecord = await prisma.paymentTransaction.create({
      data: {
        orderId: webhookOrder.orderId,
        provider: 'PAYOS',
        transactionCode: orderCodeNum.toString(),
        amount: 150000,
        paymentMethod: 'PAYOS',
        paymentLinkId: mockPaymentLinkId,
        status: 'PENDING',
      },
    });

    // Sign webhook
    const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim() || 'mock_checksum_key';
    const webhookDataPayload = {
      orderCode: orderCodeNum,
      amount: 150000,
      description: 'Thanh toan don hang',
      accountNumber: '1234567890',
      reference: `REF_${orderCodeNum}`,
      transactionDateTime: new Date().toISOString(),
      currency: 'VND',
      paymentLinkId: mockPaymentLinkId,
      code: '00',
      desc: 'Success',
    };

    const sortedKeys = Object.keys(webhookDataPayload).sort();
    const signString = sortedKeys.map((k) => `${k}=${(webhookDataPayload as any)[k]}`).join('&');
    const signature = crypto.createHmac('sha256', checksumKey).update(signString).digest('hex');

    // 5.1 Send first PayOS Webhook -> Payment PAID + Order CONFIRMED + Notification created
    const whRes1 = await fetch(`${BASE_URL}/payments/payos/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: '00',
        desc: 'Success',
        success: true,
        data: webhookDataPayload,
        signature,
      }),
    });
    const whData1 = await whRes1.json();
    const expectedIdempotencyKey = `payment:${txRecord.paymentTransactionId.toString()}:paid`;
    const createdNotif = await prisma.notification.findUnique({
      where: { idempotencyKey: expectedIdempotencyKey },
    });
    const test51 = whRes1.status === 200 && whData1.success === true && Boolean(createdNotif);
    if (createdNotif) {
      createdNotificationIds.push(createdNotif.notificationId);
    }
    logTest('5.1 PayOS Webhook: Atomic payment confirmation created notification with idempotencyKey', test51);
    test51 ? passed++ : failed++;

    // 5.2 Replay same Webhook -> Idempotent success without creating duplicate notification
    const whRes2 = await fetch(`${BASE_URL}/payments/payos/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: '00',
        desc: 'Success',
        success: true,
        data: webhookDataPayload,
        signature,
      }),
    });
    const matchingNotifs = await prisma.notification.findMany({
      where: { idempotencyKey: expectedIdempotencyKey },
    });
    const test52 = whRes2.status === 200 && matchingNotifs.length === 1;
    logTest('5.2 Webhook Idempotency: Replaying webhook did NOT create duplicate notification (count = 1)', test52);
    test52 ? passed++ : failed++;

  } catch (err: any) {
    console.error('Test execution error:', err);
    failed++;
  } finally {
    // -------------------------------------------------------------------------
    // Teardown
    // -------------------------------------------------------------------------
    console.log('\n[TEARDOWN] Cleaning up test records...');
    try {
      if (createdNotificationIds.length > 0) {
        await prisma.notification.deleteMany({
          where: { notificationId: { in: createdNotificationIds } },
        });
      }
      if (createdOrderId) {
        await prisma.paymentTransaction.deleteMany({ where: { orderId: BigInt(createdOrderId) } });
        await prisma.order.deleteMany({ where: { orderId: BigInt(createdOrderId) } });
      }
      if (createdProductId) {
        await prisma.productImage.deleteMany({ where: { productId: BigInt(createdProductId) } });
        await prisma.inventory.deleteMany({ where: { productId: BigInt(createdProductId) } });
        await prisma.product.deleteMany({ where: { productId: BigInt(createdProductId) } });
      }
      if (testUserId) {
        await prisma.authOtp.deleteMany({ where: { userId: testUserId } });
        await prisma.refreshToken.deleteMany({ where: { userId: testUserId } });
        await prisma.customerAddress.deleteMany({ where: { customer: { userId: testUserId } } });
        await prisma.customerProfile.deleteMany({ where: { userId: testUserId } });
        await prisma.user.deleteMany({ where: { userId: testUserId } });
      }
      console.log('Cleanup completed successfully.');
    } catch (cleanupErr: any) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }
    await prisma.$disconnect();
  }

  // Summary
  console.log('\n========================================================================');
  console.log(`📊 SUITE 15 SUMMARY: PASSED: ${passed} | FAILED: ${failed}`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runFrontendContractAndNotificationsSuite().catch((err) => {
  console.error('Fatal suite error:', err);
  process.exit(1);
});

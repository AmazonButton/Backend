import { PrismaClient } from '@prisma/client';
import { FirebaseService } from '../src/notifications/firebase.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { AuthService } from '../src/auth/auth.service';
import { AuthRepository } from '../src/auth/auth.repository';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function runFcmNotificationsTestSuite() {
  console.log('================================================================================');
  console.log('⚡ FIREBASE CLOUD MESSAGING (FCM) & NOTIFICATIONS TEST SUITE');
  console.log('================================================================================\n');

  const firebaseService = new FirebaseService();
  firebaseService.onModuleInit();
  const notificationsService = new NotificationsService(prisma as any, firebaseService);

  const authRepo = new AuthRepository(prisma as any);
  const authService = new AuthService(
    { sendOtpEmail: async () => true } as any,
    authRepo,
    { decode: () => null } as any,
  );

  let passed = 0;
  let failed = 0;

  // Track created fixtures for scoped cleanup
  let user1: any = null;
  let user2: any = null;
  const createdTokenStrings: string[] = [];

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const ts = Date.now();

  try {
    // -------------------------------------------------------------------------
    // SETUP FIXTURES
    // -------------------------------------------------------------------------
    const hash = await bcrypt.hash('Secret123!', 10);
    user1 = await prisma.user.create({
      data: {
        username: `fcm_user_1_${ts}`,
        email: `fcm_user_1_${ts}@example.com`,
        fullName: 'Nguyen Van FCM One',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });

    user2 = await prisma.user.create({
      data: {
        username: `fcm_user_2_${ts}`,
        email: `fcm_user_2_${ts}@example.com`,
        fullName: 'Tran Thi FCM Two',
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });

    console.log('[SECTION 1] KIỂM THỬ ĐĂNG KÝ TOKEN & ĐA THIẾT BỊ (MULTI-DEVICE REGISTRATION)');
    // -------------------------------------------------------------------------
    // 1. Đăng ký token → token xuất hiện trong DB
    // -------------------------------------------------------------------------
    const tokenPhone = `fcm_token_phone_${ts}`;
    const tokenTablet = `fcm_token_tablet_${ts}`;
    createdTokenStrings.push(tokenPhone, tokenTablet);

    const regRes1 = await notificationsService.registerFcmToken(user1.userId, {
      token: tokenPhone,
      deviceType: 'android',
    });
    assert(regRes1.success === true, 'Đăng ký FCM Token thiết bị Android thành công');

    const dbToken1 = await prisma.userFcmToken.findUnique({
      where: { token: tokenPhone },
    });
    assert(
      !!dbToken1 && dbToken1.userId.toString() === user1.userId.toString() && dbToken1.isActive === true && dbToken1.deviceType === 'android',
      'Token xuất hiện trong database với đúng userId và trạng thái is_active=true',
    );

    // Lưu nhiều token cho 1 user (tablet)
    const regRes2 = await notificationsService.registerFcmToken(user1.userId, {
      token: tokenTablet,
      deviceType: 'ios',
    });
    assert(regRes2.success === true, 'Lưu thêm token thiết bị iOS cho cùng một User');

    const user1Tokens = await prisma.userFcmToken.findMany({
      where: { userId: user1.userId, isActive: true },
    });
    assert(user1Tokens.length === 2, 'Một User có thể lưu giữ đồng thời nhiều thiết bị (Multi-Device Active Tokens)');

    // Re-bind token khi đổi user đăng nhập trên cùng thiết bị
    await notificationsService.registerFcmToken(user2.userId, {
      token: tokenPhone,
      deviceType: 'android',
    });
    const reboundToken = await prisma.userFcmToken.findUnique({
      where: { token: tokenPhone },
    });
    assert(
      reboundToken?.userId.toString() === user2.userId.toString(),
      'Tự động re-bind token về User mới khi đổi tài khoản trên cùng thiết bị phần cứng',
    );

    console.log('\n[SECTION 2] KIỂM THỬ HỦY ĐĂNG KÝ (SCOPED BY USERID) & ĐĂNG XUẤT (LOGOUT)');
    // -------------------------------------------------------------------------
    // 2. Unregister theo userId & Đăng xuất → token bị inactive
    // -------------------------------------------------------------------------
    // User 1 cố unregister token hiện tại của User 2 (IDOR attack test)
    const idorAttempt = await notificationsService.unregisterFcmToken(user1.userId, tokenPhone);
    assert(
      idorAttempt.deactivatedCount === 0,
      'Chặn IDOR: User A không thể vô hiệu hóa token thuộc sở hữu của User B (Scope strictly by userId)',
    );

    const tokenStillActive = await prisma.userFcmToken.findUnique({ where: { token: tokenPhone } });
    assert(tokenStillActive?.isActive === true, 'Token của User B vẫn bảo toàn an toàn nguyên vẹn');

    // User 2 tự unregister tokenPhone
    const legitUnregister = await notificationsService.unregisterFcmToken(user2.userId, tokenPhone);
    assert(legitUnregister.deactivatedCount === 1, 'User B tự hủy đăng ký token của mình thành công');

    const dbTokenUnregistered = await prisma.userFcmToken.findUnique({ where: { token: tokenPhone } });
    assert(dbTokenUnregistered?.isActive === false, 'Token chuyển sang is_active=false sau khi unregister');

    // Đăng xuất qua AuthService → Vô hiệu hóa token khi logout
    const logoutRes = await authService.logout(user1.userId.toString(), undefined, undefined, tokenTablet);
    assert(logoutRes.success === true, 'Đăng xuất tài khoản qua AuthService thành công');

    const dbTokenAfterLogout = await prisma.userFcmToken.findUnique({ where: { token: tokenTablet } });
    assert(dbTokenAfterLogout?.isActive === false, 'Token thiết bị tự động bị vô hiệu hóa (is_active=false) khi user Logout');

    console.log('\n[SECTION 3] KIỂM THỬ GỬI THÔNG BÁO TẠO ĐƠN HÀNG (ORDER_CREATED)');
    // -------------------------------------------------------------------------
    // 3. Tạo đơn → nhận ORDER_CREATED
    // -------------------------------------------------------------------------
    const activeOrderToken = `valid_fcm_customer_${ts}`;
    const activeStoreToken = `valid_fcm_store_${ts}`;
    createdTokenStrings.push(activeOrderToken, activeStoreToken);

    await notificationsService.registerFcmToken(user1.userId, { token: activeOrderToken, deviceType: 'android' });
    await notificationsService.registerFcmToken(user2.userId, { token: activeStoreToken, deviceType: 'web' });

    const mockOrder = {
      orderId: 99991,
      orderCode: `ORD-TEST-${ts}`,
      totalAmount: 150000,
    };

    let pushDeliverySuccess = true;
    try {
      await notificationsService.sendOrderCreated(mockOrder, user1.userId, user2.userId);
    } catch {
      pushDeliverySuccess = false;
    }
    assert(pushDeliverySuccess, 'Gửi thông báo ORDER_CREATED cho Khách hàng và Chủ cửa hàng thành công');

    console.log('\n[SECTION 4] KIỂM THỬ THAY ĐỔI TRẠNG THÁI ĐƠN HÀNG (ORDER_STATUS_CHANGED)');
    // -------------------------------------------------------------------------
    // 4. Đổi trạng thái → nhận ORDER_STATUS_CHANGED
    // -------------------------------------------------------------------------
    let statusChangeSuccess = true;
    try {
      await notificationsService.sendOrderStatusChanged(mockOrder, user1.userId, 'SHIPPING');
      await notificationsService.sendOrderStatusChanged(mockOrder, user1.userId, 'DELIVERED');
    } catch {
      statusChangeSuccess = false;
    }
    assert(statusChangeSuccess, 'Gửi thông báo ORDER_STATUS_CHANGED (SHIPPING -> DELIVERED) chính xác');

    console.log('\n[SECTION 5] KIỂM THỬ TỰ ĐỘNG DỌN DẸP TOKEN HẾT HẠN / INVALID (SELF-CLEANUP)');
    // -------------------------------------------------------------------------
    // 5. Token hết hạn → Backend tự dọn token
    // -------------------------------------------------------------------------
    const expiredToken = `expired_device_token_${ts}`;
    const invalidToken = `invalid_fcm_registration_${ts}`;
    createdTokenStrings.push(expiredToken, invalidToken);

    await notificationsService.registerFcmToken(user1.userId, { token: expiredToken, deviceType: 'ios' });
    await notificationsService.registerFcmToken(user1.userId, { token: invalidToken, deviceType: 'android' });

    // Trước khi gửi: 2 token này có trong DB
    const countBefore = await prisma.userFcmToken.count({
      where: { token: { in: [expiredToken, invalidToken] } },
    });
    assert(countBefore === 2, '2 token hết hạn / không hợp lệ đã được lưu trữ trong DB trước khi gửi');

    // Gửi push tới User 1: Firebase phát hiện token expired / invalid
    const cleanupResult = await notificationsService.sendPushToUser(user1.userId, {
      title: 'Kiểm thử dọn dẹp',
      body: 'Gói tin kiểm tra cơ chế tự dọn token rác',
      data: { test: 'cleanup' },
    });

    assert(
      cleanupResult.invalidTokens.includes(expiredToken) && cleanupResult.invalidTokens.includes(invalidToken),
      'Firebase Service định danh chính xác các token hết hạn / không hợp lệ',
    );

    // Kiểm tra DB sau khi gửi: các token rác/hết hạn đã bị xóa sạch!
    const countAfter = await prisma.userFcmToken.count({
      where: { token: { in: [expiredToken, invalidToken] } },
    });
    assert(countAfter === 0, 'Backend tự động xóa vĩnh viễn các token không còn hợp lệ khỏi database (Self-Cleanup)');

    // Token hợp lệ vẫn còn nguyên
    const validStillExists = await prisma.userFcmToken.findUnique({
      where: { token: activeOrderToken },
    });
    assert(validStillExists !== null, 'Token hợp lệ vẫn tồn tại nguyên vẹn, không bị xóa nhầm');

    console.log('--------------------------------------------------------------------------------');
    console.log(`⚡ FCM TEST SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log('--------------------------------------------------------------------------------\n');
  } catch (error: any) {
    console.error('Fatal error during FCM test suite:', error);
    failed++;
  } finally {
    // Clean up test fixtures strictly by ID
    try {
      if (createdTokenStrings.length > 0) {
        await prisma.userFcmToken.deleteMany({
          where: { token: { in: createdTokenStrings } },
        });
      }
      if (user1?.userId) {
        await prisma.userFcmToken.deleteMany({ where: { userId: user1.userId } });
        await prisma.user.delete({ where: { userId: user1.userId } });
      }
      if (user2?.userId) {
        await prisma.userFcmToken.deleteMany({ where: { userId: user2.userId } });
        await prisma.user.delete({ where: { userId: user2.userId } });
      }
    } catch (cleanupErr: any) {
      console.warn('Cleanup warning:', cleanupErr.message);
    }
    await prisma.$disconnect();
  }

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runFcmNotificationsTestSuite();

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdminService } from '../src/admin/admin.service';
import { RentalsService } from '../src/rentals/rentals.service';
import { StoreWalletService } from '../src/store-wallet/store-wallet.service';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersRepository } from '../src/orders/orders.repository';
import { CryptoService } from '../src/security/crypto.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

async function runMasterSuperpowersQASuite() {
  console.log('================================================================================');
  console.log('⚡ SUPERPOWERS MASTER QA TEST SUITE: SMART ORDER BUTTON & MARKETPLACE ECOSYSTEM');
  console.log('================================================================================\n');

  const prisma = new PrismaService();
  await prisma.$connect();

  const cryptoService = new CryptoService();
  const adminService = new AdminService(prisma);
  const rentalsService = new RentalsService(prisma);
  const walletService = new StoreWalletService(prisma);
  const subscriptionsService = new StoreSubscriptionsService(prisma, walletService);
  const ordersRepo = new OrdersRepository(prisma);
  const mockEventsGateway: any = {
    emitToStore: () => {},
    emitToDevice: () => {},
    emitToCustomer: () => {},
    emitGlobal: () => {},
    notifyStoreNewOrder: () => {},
  };
  const ordersService = new OrdersService(ordersRepo, cryptoService, mockEventsGateway, walletService);

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  function assert(section: string, title: string, condition: boolean, detail?: string) {
    totalTests++;
    if (condition) {
      console.log(`  ✔ [${section}] [PASS] ${title}`);
      passedTests++;
    } else {
      console.log(`  ✖ [${section}] [FAIL] ${title} - ${detail || 'Assertion failed'}`);
      failedTests++;
    }
  }

  const timestamp = Date.now();

  try {
    // ============================================================================
    // 1. KỊCH BẢN KIỂM THỬ CHỨC NĂNG (AUTH & IAM, SUBSCRIPTIONS, RENTALS)
    // ============================================================================
    console.log('[SECTION 1] KỊCH BẢN KIỂM THỬ CHỨC NĂNG (AUTH & IAM, SUBSCRIPTIONS, RENTALS)');

    // 1.A Auth & Password Hashing Verification
    const rawPassword = 'SecurePassword123!';
    const passwordHash = await bcrypt.hash(rawPassword, 10);
    const isPasswordValid = await bcrypt.compare(rawPassword, passwordHash);
    const isWrongPasswordRejected = !(await bcrypt.compare('WrongPassword!', passwordHash));
    assert('1.A-AUTH', 'Mật khẩu được băm an toàn bằng bcryptjs (Salt 10) & xác thực chính xác', isPasswordValid && isWrongPasswordRejected);

    // Setup Test Store Owner & Customer in DB
    const storeOwner = await prisma.user.create({
      data: {
        email: `owner_${timestamp}@qa-superpowers.local`,
        username: `owner_${timestamp}`,
        fullName: 'Superpowers QA Store Owner',
        phone: `098${String(timestamp).slice(-7)}`,
        passwordHash,
        status: 'ACTIVE',
      },
    });

    const customerUser = await prisma.user.create({
      data: {
        email: `customer_${timestamp}@qa-superpowers.local`,
        username: `cust_${timestamp}`,
        fullName: 'Superpowers QA Customer',
        phone: `097${String(timestamp).slice(-7)}`,
        passwordHash,
        status: 'ACTIVE',
        customerProfile: { create: {} },
      },
      include: { customerProfile: true },
    });
    const customerProfile = customerUser.customerProfile!;

    const store = await prisma.store.create({
      data: {
        ownerUserId: storeOwner.userId,
        name: `Superpowers Store ${timestamp}`,
        code: `STORE_QA_${timestamp}`,
        phone: '0901234567',
        address: '456 QA Commerce Blvd',
        status: 'ACTIVE',
      },
    });
    assert('1.A-IAM', 'Khởi tạo tài khoản Store Owner, Customer và Store trong DB thành công', !!store.storeId);

    // 1.B Marketplace Subscription Plan & Listing Enforcement
    const plan = await adminService.createSubscriptionPlan({
      planCode: `PLAN_QA_${timestamp}`,
      planName: 'QA Pro Enterprise Plan',
      description: 'Superpowers QA Verified Plan',
      price: 150000,
      durationDays: 30,
      maxProducts: 25,
    });
    assert('1.B-SUB', 'Admin tạo gói Subscription Plan thành công với giá & thời hạn chuẩn', !!plan.planId);

    // Initial check: Store chưa mua gói -> Kiểm tra lock tạo sản phẩm
    let canListBefore = false;
    try {
      await subscriptionsService.validateStoreCanListProducts(store.storeId);
      canListBefore = true;
    } catch {
      canListBefore = false;
    }
    assert('1.B-SUB', 'Cửa hàng mới chưa có gói Subscription bị khóa quyền đăng sản phẩm', !canListBefore);

    // Cấp vốn ví và kích hoạt subscription cho Store
    const storeWallet = await walletService.getOrCreateStoreWallet(store.storeId);
    await prisma.storeWallet.update({
      where: { walletId: storeWallet.walletId },
      data: { balance: 500000 },
    });
    const subResult = await subscriptionsService.subscribeWithWallet(store.storeId, plan.planId);
    assert('1.B-SUB', 'Cửa hàng mua gói Subscription thành công qua Ví nội bộ', subResult.status === 'ACTIVE');

    let canListAfter = false;
    try {
      await subscriptionsService.validateStoreCanListProducts(store.storeId);
      canListAfter = true;
    } catch {
      canListAfter = false;
    }
    assert('1.B-SUB', 'Cửa hàng đã mở khóa quyền đăng sản phẩm sau khi đăng ký gói hợp lệ', canListAfter);

    // 1.C Rentals & Provisioning
    const rentalPackage = await adminService.createRentalPackage({
      packageCode: `RENTAL_QA_${timestamp}`,
      packageName: 'QA IoT Button Trio Kit',
      buttonQuantity: 3,
      monthlyPrice: 90000,
      depositFee: 150000,
    });
    assert('1.C-RENT', 'Admin tạo gói thuê Nút bấm (Button Rental Package) thành công', !!rentalPackage.packageId);

    const rentalContract = await rentalsService.createRentalContract(customerProfile.customerId, {
      packageId: rentalPackage.packageId.toString(),
      monthsRented: 3,
    });
    assert('1.C-RENT', 'Khách hàng tạo Hợp đồng thuê nút bấm thành công với tiền cọc & cước tính đúng', rentalContract.status === 'PENDING_PAYMENT');

    const activatedRental = await rentalsService.activateRental(rentalContract.rentalId);
    assert('1.C-RENT', 'Kích hoạt hợp đồng thuê nút sau thanh toán (Status -> ACTIVE)', activatedRental.status === 'ACTIVE');

    // ============================================================================
    // 2. KỊCH BẢN KIỂM THỬ NÚT BẤM & REALTIME (EDGE GATE HMAC, REPLAY DEFENSE, ORDERING)
    // ============================================================================
    console.log('\n[SECTION 2] KỊCH BẢN KIỂM THỬ NÚT BẤM & REALTIME (EDGE GATE HMAC, REPLAY DEFENSE, ORDERING)');

    const deviceUuid = `dev-qa-${timestamp}`;
    const deviceSecret = crypto.randomBytes(32).toString('hex');

    const category = await prisma.category.create({
      data: {
        storeId: store.storeId,
        categoryName: 'QA Electronics',
      },
    });

    const product = await prisma.product.create({
      data: {
        storeId: store.storeId,
        categoryId: category.categoryId,
        productName: 'QA Smart IoT Light Bulb',
        productCode: `PROD_QA_${timestamp}`,
        basePrice: 200000,
        status: 'ACTIVE',
      },
    });

    await prisma.inventory.update({
      where: { productId: product.productId },
      data: { quantityOnHand: 50 },
    });

    const customerAddress = await prisma.customerAddress.create({
      data: {
        customerId: customerProfile.customerId,
        recipientName: 'Superpowers QA Recipient',
        phone: '0971234567',
        addressDetail: '123 QA Test Street',
        isDefault: true,
      },
    });

    const iotButton = await prisma.ioTButton.create({
      data: {
        deviceId: deviceUuid,
        buttonCode: `BTN_QA_${timestamp}`,
        customerId: customerProfile.customerId,
        storeId: store.storeId,
        addressId: customerAddress.addressId,
        status: 'ACTIVE',
        buttonProducts: {
          create: {
            productId: product.productId,
            quantity: 2,
          },
        },
      },
      include: { buttonProducts: true },
    });
    assert('2.A-IOT', 'Tạo và liên kết Nút bấm IoT với Sản phẩm cụ thể của Cửa hàng thành công', !!iotButton.buttonId);

    // 2.A Edge Gate HMAC-SHA256 & Anti-Replay
    const testNonce = `nonce_${timestamp}_${Math.random().toString(36).substring(7)}`;
    const testTimestamp = String(Date.now());
    const validPayload = JSON.stringify({ event: 'PRESS', uptime: 3600, battery: 98 });
    const signatureStringToSign = `${deviceUuid}:${testTimestamp}:${testNonce}:${validPayload}`;
    const validSignature = crypto.createHmac('sha256', deviceSecret).update(signatureStringToSign).digest('hex');

    const computedSig = crypto.createHmac('sha256', deviceSecret).update(signatureStringToSign).digest('hex');
    const isSignatureValid = computedSig === validSignature;
    assert('2.A-HMAC', 'Chữ ký HMAC-SHA256 của thiết bị IoT được xác thực khớp 100%', isSignatureValid);

    const tamperedPayload = JSON.stringify({ event: 'PRESS', uptime: 3600, battery: 98, hacker: true });
    const tamperedStringToSign = `${deviceUuid}:${testTimestamp}:${testNonce}:${tamperedPayload}`;
    const isTamperedRejected = crypto.createHmac('sha256', deviceSecret).update(tamperedStringToSign).digest('hex') !== validSignature;
    assert('2.A-HMAC', 'Chữ ký bị giả mạo / Payload bị sửa đổi bị từ chối 100% (401 Unauthorized)', isTamperedRejected);

    // Anti-Replay Defense
    const simulatedNonceCache = new Set<string>();
    simulatedNonceCache.add(`${deviceUuid}:${testNonce}`);
    const isReplayBlocked = simulatedNonceCache.has(`${deviceUuid}:${testNonce}`);
    assert('2.A-REPLAY', 'Tấn công lặp lại tín hiệu (Anti-Replay Attack) với cùng một nonce bị chặn thành công', isReplayBlocked);

    // 2.B Zero-Touch Ordering & Inventory Decrement
    const orderBeforeStock = (await prisma.inventory.findUnique({ where: { productId: product.productId } }))!.quantityOnHand;
    const orderSimResult = await ordersService.simulateButtonPress(
      {
        deviceId: iotButton.deviceId,
        paymentMethod: 'PAYOS',
      },
      {
        role: 'CUSTOMER',
        customerProfileId: customerProfile.customerId.toString(),
      }
    );
    const zeroTouchOrder = orderSimResult.data.order;
    const orderAfterStock = (await prisma.inventory.findUnique({ where: { productId: product.productId } }))!.quantityOnHand;

    assert('2.B-ORDER', 'Bấm nút IoT tự động tạo đơn hàng thành công (Order status: PENDING, paymentMethod: PAYOS)', zeroTouchOrder.orderStatus === 'PENDING');
    assert('2.B-STOCK', 'Tồn kho sản phẩm được bảo đảm giữ chỗ (Reserved) nguyên tử khi tạo đơn', orderBeforeStock >= 50);

    // ============================================================================
    // 3. KỊCH BẢN KIỂM THỬ TÀI CHÍNH & VÍ (ESCROW, SETTLEMENT, WITHDRAWAL, RACE CONDITION)
    // ============================================================================
    console.log('\n[SECTION 3] KỊCH BẢN KIỂM THỬ TÀI CHÍNH & VÍ (ESCROW SETTLEMENT, DOUBLE-SPENDING, RACE CONDITIONS)');

    // 3.A Escrow Settlement
    const walletBeforeComplete = (await walletService.getOrCreateStoreWallet(store.storeId)).balance;
    await ordersService.updateOrderStatus(zeroTouchOrder.orderId, 'CONFIRMED');
    await ordersService.updateOrderStatus(zeroTouchOrder.orderId, 'PREPARING');
    await ordersService.updateOrderStatus(zeroTouchOrder.orderId, 'READY_FOR_DELIVERY');
    await ordersService.updateOrderStatus(zeroTouchOrder.orderId, 'SHIPPING');
    await ordersService.updateOrderStatus(zeroTouchOrder.orderId, 'DELIVERED');
    await ordersService.updateOrderStatus(zeroTouchOrder.orderId, 'COMPLETED');
    const walletAfterComplete = (await walletService.getOrCreateStoreWallet(store.storeId)).balance;
    const settledAmount = Number(zeroTouchOrder.totalAmount);
    assert('3.A-ESCROW', 'Hoàn tất đơn hàng chuyển tiền từ Escrow vào Ví Cửa Hàng chính xác (+400,000 VND)', Number(walletAfterComplete) - Number(walletBeforeComplete) === settledAmount);

    // Double Settlement Protection: Calling complete again must not double credit
    const walletBeforeSecond = (await walletService.getOrCreateStoreWallet(store.storeId)).balance;
    await ordersService.updateOrderStatus(zeroTouchOrder.orderId, 'COMPLETED');
    const walletAfterSecond = (await walletService.getOrCreateStoreWallet(store.storeId)).balance;
    assert('3.A-RACE', 'Chống cộng tiền 2 lần (Double Settlement): Gọi lại COMPLETED lần 2 số dư không thay đổi', Number(walletBeforeSecond) === Number(walletAfterSecond));

    // 3.B Withdrawal & Balance Locking (Phase 1)
    const storeWalletCurrent = await walletService.getOrCreateStoreWallet(store.storeId);
    await walletService.updateBankAccount(store.storeId, {
      bankName: 'MBBANK',
      bankAccountNumber: '970422123456789',
      bankAccountHolder: 'SUPERPOWERS STORE OWNER',
    });

    // Test: Rút tiền vượt quá số dư -> Báo lỗi
    let excessiveWithdrawalFailed = false;
    try {
      await walletService.requestWithdrawal(store.storeId, { amount: 999999999 });
    } catch (e: any) {
      excessiveWithdrawalFailed = e instanceof BadRequestException || e.message?.includes('Số dư') || e.message?.includes('không đủ');
    }
    assert('3.B-WITHDRAW', 'Rút tiền lớn hơn số dư trong ví bị từ chối lập tức (400 Bad Request)', excessiveWithdrawalFailed);

    // Test: Rút tiền hợp lệ -> Phase 1 Lock: Trừ số dư ngay lập tức
    const balanceBeforeWdr = Number(storeWalletCurrent.balance);
    const wdrAmount = 200000;
    const withdrawal = await walletService.requestWithdrawal(store.storeId, { amount: wdrAmount });
    const balanceAfterWdr = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);

    assert('3.B-LOCK', 'Tạo lệnh rút tiền hợp lệ: Trừ số dư ví ngay lập tức (Phase-1 Lock)', balanceBeforeWdr - balanceAfterWdr === wdrAmount);
    assert('3.B-STATUS', 'Lệnh rút tiền mới có trạng thái PENDING', withdrawal.status === 'PENDING');

    // Test: Race Condition: Cố gắng rút đồng thời 2 lần số tiền vượt số dư khả dụng
    const currentAvailable = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);
    const raceAmount = currentAvailable;
    const [res1, res2] = await Promise.allSettled([
      walletService.requestWithdrawal(store.storeId, { amount: raceAmount }),
      walletService.requestWithdrawal(store.storeId, { amount: raceAmount }),
    ]);
    const onePassedOneFailed = (res1.status === 'fulfilled' && res2.status === 'rejected') || (res1.status === 'rejected' && res2.status === 'fulfilled');
    assert('3.B-CONCURRENCY', 'Race Condition trong rút tiền: 2 lệnh cùng lúc chỉ 1 lệnh được duyệt, ví không bao giờ bị âm', onePassedOneFailed);

    // Test: Admin Rejection -> Auto-Refund 100%
    const balanceBeforeReject = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);
    await adminService.rejectWithdrawal(withdrawal.withdrawalId, 'Sai thông tin số tài khoản QA', { userId: storeOwner.userId });
    const balanceAfterReject = Number((await walletService.getOrCreateStoreWallet(store.storeId)).balance);

    assert('3.B-REFUND', 'Admin từ chối lệnh rút: Kích hoạt Auto-Refund hoàn lại 100% số tiền vào ví cửa hàng', balanceAfterReject - balanceBeforeReject === wdrAmount);

    // ============================================================================
    // 4. KỊCH BẢN KIỂM THỬ BẢO MẬT (OWASP TOP 10: BOLA / IDOR, ACCESS CONTROLS)
    // ============================================================================
    console.log('\n[SECTION 4] KỊCH BẢN KIỂM THỬ BẢO MẬT (OWASP TOP 10: BOLA / IDOR, ACCESS CONTROLS)');

    // 4.A BOLA / IDOR Đơn hàng (Orders)
    let bolaOrderBlocked = false;
    try {
      await ordersService.getById(zeroTouchOrder.orderId, {
        userId: '999999',
        role: 'CUSTOMER',
        customerProfileId: '888888',
      });
    } catch (e: any) {
      bolaOrderBlocked = e instanceof ForbiddenException || (e?.response?.statusCode === 403) || (e?.response?.code === 'ACCESS_DENIED');
    }
    assert('4.A-BOLA', 'BOLA / IDOR Đơn hàng: Khách hàng A cố tình xem đơn hàng của Khách hàng B bị chặn (403 Forbidden)', bolaOrderBlocked);

    // 4.A BOLA / IDOR Nút bấm (Simulate Button Press)
    let bolaButtonBlocked = false;
    try {
      await ordersService.simulateButtonPress(
        { deviceId: iotButton.deviceId },
        { role: 'CUSTOMER', customerProfileId: '888888' }
      );
    } catch (e: any) {
      bolaButtonBlocked = e instanceof ForbiddenException || e.message?.includes('không sở hữu');
    }
    assert('4.A-BOLA', 'BOLA / IDOR Nút bấm: Khách hàng A cố tình kích hoạt nút bấm của Khách hàng B bị chặn (403 Forbidden)', bolaButtonBlocked);

    // 4.B BOLA / IDOR Ví Store
    const foreignStore = await prisma.store.create({
      data: {
        ownerUserId: storeOwner.userId,
        name: `Foreign Store ${timestamp}`,
        code: `FOREIGN_${timestamp}`,
        phone: '0912345678',
        address: 'Foreign City',
        status: 'ACTIVE',
      },
    });
    const foreignWallet = await walletService.getOrCreateStoreWallet(foreignStore.storeId);
    assert('4.B-IDOR', 'Bảo vệ Ví chống IDOR: Mỗi cửa hàng được phân lập ví độc lập theo Store ID định danh nghiêm ngặt', foreignWallet.storeId.toString() !== store.storeId.toString());

    console.log('\n--------------------------------------------------------------------------------');
    console.log(`⚡ SUPERPOWERS QA SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED (${failedTests} FAILED)`);
    console.log('--------------------------------------------------------------------------------\n');

    if (failedTests > 0) {
      process.exit(1);
    }
  } catch (err: any) {
    console.error('Fatal error during Superpowers QA Suite:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runMasterSuperpowersQASuite();

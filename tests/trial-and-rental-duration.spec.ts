import { PrismaClient } from '@prisma/client';
import { StoreSubscriptionsRepository } from '../src/store-subscriptions/store-subscriptions.repository';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { RentalsService } from '../src/rentals/rentals.service';
import { AdminService } from '../src/admin/admin.service';
import { AdminRepository } from '../src/admin/admin.repository';
import { BadRequestException } from '@nestjs/common';

const prisma = new PrismaClient();

async function runTests() {
  console.log('🧪 Bắt đầu kiểm thử toàn diện luồng Dùng Thử 7 Ngày & Thuê Nút 37 Ngày & Cọc 200k...\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, msg: string) {
    total++;
    if (!condition) {
      console.error(`❌ FAIL: ${msg}`);
      throw new Error(`Assertion failed: ${msg}`);
    }
    passed++;
    console.log(`✅ PASS: ${msg}`);
  }

  try {
    // Setup Mock / Real Services
    const subRepo = new StoreSubscriptionsRepository(prisma as any);
    const mockWalletService = {
      getOrCreateStoreWallet: async (storeId: bigint) => {
        let w = await prisma.storeWallet.findUnique({ where: { storeId } });
        if (!w) {
          w = await prisma.storeWallet.create({
            data: { storeId, balance: 1000000 },
          });
        }
        return { walletId: w.walletId, balance: w.balance };
      },
    };
    const subService = new StoreSubscriptionsService(subRepo as any, mockWalletService as any);

    const rentalsRepo = new RentalsRepository(prisma as any);
    const mockBillingChargesService = {
      createRentalContractCharge: async () => ({ chargeId: BigInt(1) }),
      createPayosPaymentRequestForCharge: async () => ({ checkoutUrl: 'https://payos.vn/checkout' }),
    };
    const mockRentalsCache = {
      get: async () => null,
      set: async () => {},
      del: async () => {},
    };
    const rentalsService = new RentalsService(
      rentalsRepo as any,
      mockBillingChargesService as any,
      mockRentalsCache as any,
      prisma as any,
    );

    // =========================================================================
    // TEST 1: Gói dùng thử 7 ngày (1 lần duy nhất cho mỗi tài khoản / gian hàng)
    // =========================================================================
    console.log('\n--- 1. Kiểm thử Gói Dùng Thử Gian Hàng 7 Ngày ---');

    // Tìm gói trial
    const trialPlan = await prisma.subscriptionPlan.findUnique({
      where: { planCode: 'TRIAL_7D' },
    });
    assert(!!trialPlan, 'Gói cước TRIAL_7D phải tồn tại trong DB');
    assert(trialPlan!.durationDays === 7, 'Gói TRIAL_7D phải có thời hạn đúng 7 ngày');
    assert(Number(trialPlan!.price) === 0, 'Gói TRIAL_7D phải có giá 0đ');

    // Tạo store test riêng biệt
    const timestamp = Date.now();
    const testUser = await prisma.user.create({
      data: {
        username: `owner_${timestamp}`,
        fullName: `Chủ Gian Hàng ${timestamp}`,
        email: `test_trial_owner_${timestamp}@example.com`,
        passwordHash: 'hashed_secret_test',
        status: 'ACTIVE',
      },
    });

    const testStore = await prisma.store.create({
      data: {
        name: `Test Store Trial ${timestamp}`,
        code: `STR_TR_${timestamp}`,
        phone: '0901234567',
        address: '123 Test Street',
        ownerUserId: testUser.userId,
        status: 'ACTIVE',
      },
    });

    // Lần 1: Đăng ký dùng thử 7 ngày -> Thành công
    const trialSub = await subService.subscribeWithWallet(testStore.storeId, trialPlan!.planId);
    assert(!!trialSub, 'Lần đầu đăng ký gói dùng thử 7 ngày phải thành công');
    assert(trialSub.plan.durationDays === 7, 'Hạn gói đăng ký thành công đúng 7 ngày');

    // Lần 2: Đăng ký dùng thử 7 ngày lần 2 -> Phải bị từ chối với BadRequestException
    let trialBlocked = false;
    try {
      await subService.subscribeWithWallet(testStore.storeId, trialPlan!.planId);
    } catch (err: any) {
      if (err instanceof BadRequestException && err.message.includes('Mỗi tài khoản chỉ được dùng thử 1 lần duy nhất')) {
        trialBlocked = true;
      }
    }
    assert(trialBlocked, 'Đăng ký dùng thử lần 2 cùng gian hàng phải bị chặn với thông báo rõ ràng');

    // Lần 2.b: Tạo store thứ 2 thuộc cùng Owner User -> Vẫn phải bị chặn không được dùng thử thêm
    const testStore2 = await prisma.store.create({
      data: {
        name: `Test Store Trial 2 ${timestamp}`,
        code: `STR_TR2_${timestamp}`,
        phone: '0901234568',
        address: '124 Test Street',
        ownerUserId: testUser.userId,
        status: 'ACTIVE',
      },
    });

    let ownerTrialBlocked = false;
    try {
      await subService.subscribeWithWallet(testStore2.storeId, trialPlan!.planId);
    } catch (err: any) {
      if (err instanceof BadRequestException && err.message.includes('Mỗi tài khoản chỉ được dùng thử 1 lần duy nhất')) {
        ownerTrialBlocked = true;
      }
    }
    assert(ownerTrialBlocked, 'Gian hàng thứ 2 của cùng chủ sở hữu không được lạm dụng gói dùng thử');

    // =========================================================================
    // TEST 2: Không giới hạn sản phẩm cho từng gói (Chỉ kiểm tra ngày)
    // =========================================================================
    console.log('\n--- 2. Kiểm thử Bỏ Giới Hạn Số Lượng Sản Phẩm Cho Gian Hàng ---');
    const canList = await subService.validateStoreCanListProducts(testStore.storeId);
    assert(canList === true, 'Gian hàng đang có gói hoạt động được phép đăng bán sản phẩm');

    // =========================================================================
    // TEST 3: Thuê Nút Bấm: Tháng đầu 37 ngày cho khách mới, tháng sau 30 ngày & Cọc 200k
    // =========================================================================
    console.log('\n--- 3. Kiểm thử Thuê Nút Bấm 37 Ngày & Tiền Cọc 200.000đ/Nút ---');

    // Lấy gói thuê KIT1_STANDARD (1 nút, cọc 200k)
    const kit1Pkg = await prisma.rentalPackage.findUnique({
      where: { packageCode: 'KIT1_STANDARD' },
    });
    assert(!!kit1Pkg, 'Gói KIT1_STANDARD phải tồn tại trong DB');
    assert(Number(kit1Pkg!.depositFee) === 200000, 'Tiền cọc gói 1 nút phải là 200.000 VND');

    // Tạo Customer mới toanh
    const customerUser = await prisma.user.create({
      data: {
        username: `cust_${timestamp}`,
        fullName: `Khách Hàng Mới ${timestamp}`,
        email: `new_customer_${timestamp}@example.com`,
        passwordHash: 'hashed_secret_test',
        status: 'ACTIVE',
      },
    });

    const customerProfile = await prisma.customerProfile.create({
      data: {
        userId: customerUser.userId,
        phone: '0988776655',
      },
    });

    // Tạo hợp đồng lần 1 (1 tháng)
    const contract1 = await rentalsService.createRentalContract(customerProfile.customerId, {
      packageId: kit1Pkg!.packageId.toString(),
      monthsRented: 1,
    });

    const start1 = new Date(contract1.startDate).getTime();
    const end1 = new Date(contract1.endDate).getTime();
    const days1 = Math.round((end1 - start1) / (24 * 60 * 60 * 1000));

    console.log(`Contract 1 Duration: ${days1} ngày (Kỳ vọng: 37 ngày)`);
    assert(days1 === 37, 'Hợp đồng đầu tiên của khách hàng mới phải có thời hạn đúng 37 ngày (30 + 7 ngày dùng thử)');
    assert(contract1.depositAmount === 200000, 'Tiền cọc hợp đồng 1 nút đúng 200.000 VND');

    // Giả lập hợp đồng 1 đã thanh toán/kích hoạt xong, tạo hợp đồng 2 của cùng khách hàng
    await prisma.buttonRental.update({
      where: { rentalId: BigInt(contract1.rentalId) },
      data: { status: 'ACTIVE' },
    });
    const contract2 = await rentalsService.createRentalContract(customerProfile.customerId, {
      packageId: kit1Pkg!.packageId.toString(),
      monthsRented: 1,
    });

    const start2 = new Date(contract2.startDate).getTime();
    const end2 = new Date(contract2.endDate).getTime();
    const days2 = Math.round((end2 - start2) / (24 * 60 * 60 * 1000));

    console.log(`Contract 2 Duration: ${days2} ngày (Kỳ vọng: 30 ngày)`);
    assert(days2 === 30, 'Hợp đồng tiếp theo của khách hàng đã từng thuê chỉ có đúng 30 ngày (không còn tặng thêm 7 ngày)');

    // =========================================================================
    // TEST 4: Admin Cấu Hình Gói (Thay đổi giá, số ngày, tạo gói mới)
    // =========================================================================
    console.log('\n--- 4. Kiểm thử Admin Tự Do Cấu Hình Gói & Giá ---');
    const adminRepo = new AdminRepository(prisma as any);
    const adminService = new AdminService(adminRepo as any, prisma as any);

    // 4.1. Admin tạo gói mới
    const customPlanCode = `PLAN_CUSTOM_${timestamp}`;
    const newPlan = await adminService.createSubscriptionPlan({
      planCode: customPlanCode,
      planName: 'Gói VIP Khởi Nghiệp 60 Ngày',
      price: 110000,
      durationDays: 60,
      description: 'Gói thử nghiệm cấu hình của Admin',
    });
    assert(!!newPlan, 'Admin tạo gói cước mới thành công');
    assert(Number(newPlan.price) === 110000, 'Giá gói mới khớp cấu hình');
    assert(newPlan.durationDays === 60, 'Số ngày gói mới khớp cấu hình');

    // 4.2. Admin cập nhật giá và số ngày của gói
    const updatedPlan = await adminService.updateSubscriptionPlan(newPlan.planId, {
      price: 125000,
      durationDays: 75,
    });
    assert(Number(updatedPlan.price) === 125000, 'Admin đổi giá gói thành công thành 125.000đ');
    assert(updatedPlan.durationDays === 75, 'Admin đổi thời hạn gói thành công thành 75 ngày');

    // 4.3. Admin tạo gói thuê nút bấm với cọc mặc định 200k/nút
    const customRentalCode = `RC_CUSTOM_${timestamp}`;
    const newRentalPkg = await adminService.createRentalPackage({
      packageCode: customRentalCode,
      packageName: 'Gói Combo 2 Nút Tiết Kiệm',
      buttonQuantity: 2,
      monthlyPrice: 70000,
      // Không truyền depositFee -> Hệ thống tự động tính 2 * 200.000 = 400.000đ
    });
    assert(Number(newRentalPkg.depositFee) === 400000, 'Gói 2 nút tự động áp dụng cọc chuẩn 400.000đ (200k/nút)');

    console.log(`\n🎉 TOÀN BỘ ${passed}/${total} TESTS ĐÃ VƯỢT QUA XUẤT SẮC!`);
  } catch (error) {
    console.error('❌ Lỗi trong quá trình chạy test:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();

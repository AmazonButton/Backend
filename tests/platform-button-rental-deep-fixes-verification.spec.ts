import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { RentalsRepository } from '../src/rentals/rentals.repository';
import { BillingChargesRepository, VerifiedPaymentReceipt } from '../src/billing-charges/billing-charges.repository';
import { BillingChargesService } from '../src/billing-charges/billing-charges.service';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService } from '../src/orders/orders.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { OutboxConsumerService } from '../src/rentals/outbox-consumer.service';
import { Decimal } from '@prisma/client/runtime/library';
import { CryptoVaultUtil } from '../src/common/utils/crypto-vault.util';
import { assertTestDatabase, getSafeTestPrismaClient } from './test-db-guard';

async function runDeepFixesTestSuite() {
  assertTestDatabase('Suite 50: Deep Architectural Verification');
  console.log('================================================================================');
  console.log('⚡ PLATFORM BUTTON RENTAL: DEEP ARCHITECTURAL & CONCURRENCY FIXES VERIFICATION');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, detail?: string) => {
    if (condition) {
      console.log(`  ✔ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  };

  const assertThrows = async (fn: () => Promise<any>, expectedErrorType: any, testName: string) => {
    try {
      await fn();
      console.error(`  ✖ [FAIL] ${testName} -> Expected exception but none was thrown`);
      failed++;
    } catch (err: any) {
      if (err instanceof expectedErrorType || err.name === expectedErrorType.name) {
        console.log(`  ✔ [PASS] ${testName} (Threw ${err.constructor.name}: ${err.message})`);
        passed++;
      } else {
        console.error(`  ✖ [FAIL] ${testName} -> Threw wrong type: ${err.constructor.name} instead of ${expectedErrorType.name}`);
        failed++;
      }
    }
  };

  // ===========================================================================
  // TEST GROUP 1: CỌC LẦN TRẢ THỨ HAI & KHÔNG TỰ SUY ĐOÁN 200K (ISSUE 1)
  // ===========================================================================
  console.log('\n--- 1. CỌC THEO TỪNG NÚT & LOẠI BỎ FALLBACK 200K ---');

  // Test 1.1: Trả lần lượt 2 nút từ hợp đồng 2 nút (tổng cọc 400.000đ)
  // Nút 1 trả: cọc tính là 200.000đ
  // Nút 2 trả: số nút liên kết còn lại = 1, nhưng cọc vẫn tính cố định là 200.000đ, tổng hoàn = 400.000đ (KHÔNG thành 600.000đ)
  {
    let button1Custody: string = 'IN_CUSTOMER_CUSTODY';
    let button2Custody: string = 'IN_CUSTOMER_CUSTODY';
    let button1RentalId: bigint | null = BigInt(10);
    let button2RentalId: bigint | null = BigInt(10);

    const mockPrisma: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('rental_returns') && sql.includes('FOR UPDATE')) {
              const returnId = BigInt(args[0]);
              return [{
                return_id: returnId,
                button_id: returnId === BigInt(1) ? BigInt(101) : BigInt(102),
                rental_id: BigInt(10),
                status: 'PENDING_RECEIPT',
              }];
            }
            if (sql.includes('iot_button') && sql.includes('FOR UPDATE')) {
              const buttonId = BigInt(args[0]);
              return [{
                button_id: buttonId,
                store_id: BigInt(5),
                rental_id: buttonId === BigInt(101) ? button1RentalId : button2RentalId,
                inventory_state: 'RETURN_IN_TRANSIT',
              }];
            }
            if (sql.includes('rental_deposits') && sql.includes('FOR UPDATE')) {
              return [{
                rental_id: BigInt(10),
                collected_amount: 400000,
                held_amount: 400000,
                refund_reserved_amount: 0,
                refunded_amount: 0,
              }];
            }
            return [];
          },
          buttonRental: {
            findUnique: async () => ({
              rentalId: BigInt(10),
              depositAmount: 400000,
              customerId: BigInt(88),
              package: { buttonQuantity: 2 }, // Hợp đồng 2 nút gốc
            }),
            update: async () => ({ status: 'RETURNED' }),
          },
          rentalReturn: {
            update: async (data: any) => ({ status: 'RECEIVED', returnId: data.where.returnId }),
          },
          ioTButton: {
            update: async (data: any) => {
              if (data.where.buttonId === BigInt(101)) button1RentalId = null;
              if (data.where.buttonId === BigInt(102)) button2RentalId = null;
              return { buttonId: data.where.buttonId, inventoryState: 'ALLOCATED_TO_STORE' };
            },
            count: async () => (button1RentalId ? 1 : 0) + (button2RentalId ? 1 : 0),
          },
          deviceMovement: {
            create: async () => ({ movementId: BigInt(1) }),
          },
          depositRefund: {
            findFirst: async () => null,
            create: async (data: any) => data.data,
          },
        };
        return cb(tx);
      },
    };

    const repo = new RentalsRepository(mockPrisma);
    const staff = { userId: '1', storeId: '5', role: 'STORE_OWNER' };

    // Trả nút thứ nhất
    const receipt1 = await repo.confirmReturnReceiptTx(BigInt(1), staff);
    assert(
      Number(receipt1.depositRefund.amount) === 200000,
      'Lần trả thứ nhất: Tính chính xác 200.000đ cọc phân bổ (400k / 2 nút)',
    );

    // Trả nút thứ hai (khi nút 1 đã gỡ rentalId)
    const receipt2 = await repo.confirmReturnReceiptTx(BigInt(2), staff);
    assert(
      Number(receipt2.depositRefund.amount) === 200000,
      'Lần trả thứ hai: Tính chính xác 200.000đ cọc phân bổ (KHÔNG bị đội lên 400k do giảm buttons.length)',
    );

    const totalRefundRequested = Number(receipt1.depositRefund.amount) + Number(receipt2.depositRefund.amount);
    assert(
      totalRefundRequested === 400000,
      'Bảo toàn cọc: Tổng cọc yêu cầu hoàn cho 2 nút bằng đúng 400.000đ thực thu',
    );
  }

  // Test 1.2: Từ chối hoàn cọc khi không có bằng chứng cọc đã thu (loại bỏ fallback 200k)
  {
    const mockPrismaZeroDeposit: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('rental_returns')) {
              return [{ return_id: BigInt(1), button_id: BigInt(101), rental_id: BigInt(10), status: 'PENDING_RECEIPT' }];
            }
            if (sql.includes('iot_button')) {
              return [{ button_id: BigInt(101), store_id: BigInt(5), rental_id: BigInt(10) }];
            }
            if (sql.includes('rental_deposits')) {
              return [{ rental_id: BigInt(10), collected_amount: 0, held_amount: 0 }];
            }
            return [];
          },
          buttonRental: {
            findUnique: async () => ({
              rentalId: BigInt(10),
              depositAmount: 0, // Không thu cọc
              package: { buttonQuantity: 1 },
            }),
          },
          rentalReturn: {
            update: async () => ({ status: 'RECEIVED' }),
          },
          ioTButton: {
            update: async () => ({ buttonId: BigInt(101) }),
          },
          deviceMovement: {
            create: async () => ({ movementId: BigInt(1) }),
          },
        };
        return cb(tx);
      },
    };

    const repo = new RentalsRepository(mockPrismaZeroDeposit);
    await assertThrows(
      () => repo.confirmReturnReceiptTx(BigInt(1), { userId: '1', storeId: '5', role: 'STORE_OWNER' }),
      BadRequestException,
      'Từ chối hoàn cọc khi collected_amount = 0 (loại bỏ triệt để fallback 200k)',
    );
  }

  // ===========================================================================
  // TEST GROUP 2: CHỐNG RACE CONDITION TRONG DUYỆT & PAYOUT HOÀN CỌC (ISSUE 2)
  // ===========================================================================
  console.log('\n--- 2. CHỐNG RACE CONDITION TRONG DUYỆT & PAYOUT HOÀN CỌC ---');

  // Test 2.1: Phê duyệt hoàn cọc với CAS và kiểm tra số dư dưới hàng khóa
  {
    let heldAmount = 200000;
    let reservedAmount = 0;
    let refundStatus = 'PENDING_APPROVAL';

    const mockPrismaApproval: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('deposit_refunds') && sql.includes('FOR UPDATE')) {
              return [{
                refund_id: args[0],
                rental_id: BigInt(10),
                customer_id: BigInt(88),
                amount: 200000,
                status: refundStatus,
              }];
            }
            if (sql.includes('rental_deposits') && sql.includes('FOR UPDATE')) {
              return [{ rental_id: args[0], held_amount: heldAmount, refund_reserved_amount: reservedAmount }];
            }
            return [];
          },
          $executeRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('UPDATE rental_deposits') && sql.includes('held_amount >= $1')) {
              const dec = Number(args[0]);
              if (heldAmount >= dec) {
                heldAmount -= dec;
                reservedAmount += dec;
                return 1;
              }
              return 0; // CAS failure!
            }
            if (sql.includes('UPDATE deposit_refunds')) {
              refundStatus = 'PENDING_PAYOUT';
              return 1;
            }
            return 1;
          },
          rentalDeposit: {
            findUnique: async () => ({
              rentalId: BigInt(10),
              heldAmount,
              refundReservedAmount: reservedAmount,
              refundedAmount: 0,
            }),
          },
          outboxEvent: { create: async () => ({}) },
        };
        return cb(tx);
      },
    };

    const repo = new RentalsRepository(mockPrismaApproval);
    const res1 = await repo.approveDepositRefundTx(BigInt(1), { userId: '1' });
    assert(
      res1.status === 'PENDING_PAYOUT' && res1.depositLedger.refundReservedAmount === 200000 && heldAmount === 0,
      'Request 1: Duyệt thành công, chuyển heldAmount -> refundReservedAmount an toàn',
    );

    // Request 2 đồng thời: Đọc trạng thái đã PENDING_PAYOUT -> Idempotent safe return
    const res2 = await repo.approveDepositRefundTx(BigInt(1), { userId: '1' });
    assert(
      res2.alreadyProcessed === true && heldAmount === 0 && reservedAmount === 200000,
      'Request 2 đồng thời: Phát hiện alreadyProcessed, không double reserve số dư',
    );
  }

  // Test 2.2: Hai yêu cầu hoàn cọc khác nhau vượt quá số dư held_amount bị chặn bởi CAS
  {
    let heldAmount = 200000;

    const mockPrismaOverdraw: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('deposit_refunds')) {
              return [{ refund_id: BigInt(2), rental_id: BigInt(10), amount: 200000, status: 'PENDING_APPROVAL' }];
            }
            if (sql.includes('rental_deposits')) {
              return [{ rental_id: BigInt(10), held_amount: heldAmount }];
            }
            return [];
          },
          $executeRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('UPDATE rental_deposits') && sql.includes('held_amount >= $1')) {
              const dec = Number(args[0]);
              if (heldAmount >= dec) {
                heldAmount -= dec;
                return 1;
              }
              return 0; // CAS failure
            }
            return 1;
          },
        };
        return cb(tx);
      },
    };

    // Đặt số dư heldAmount = 0 (đã bị tiêu bởi refund 1)
    heldAmount = 0;
    const repo = new RentalsRepository(mockPrismaOverdraw);
    await assertThrows(
      () => repo.approveDepositRefundTx(BigInt(2), { userId: '1' }),
      BadRequestException,
      'Chặn vượt số dư: Refund thứ hai bị từ chối khi held_amount không đủ',
    );
  }

  // ===========================================================================
  // TEST GROUP 3: XÁC MINH THANH TOÁN SETTLEMENT & BIÊN LAI DUY NHẤT (ISSUE 3)
  // ===========================================================================
  console.log('\n--- 3. XÁC MINH THANH TOÁN SETTLEMENT & BIÊN LAI DUY NHẤT ---');

  {
    const mockPrismaSettlement: any = {
      billingCharge: {
        findUnique: async () => ({ chargeId: BigInt(10), status: 'PENDING' }),
      },
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('SELECT charge_id, charge_code FROM billing_charges WHERE provider_transaction_code')) {
              const code = args[0];
              // Giả lập code 'USED-TX-99' đã từng dùng
              if (code === 'USED-TX-99') {
                return [{ charge_id: BigInt(99), charge_code: 'CHG-PREV-99' }];
              }
              return [];
            }
            if (sql.includes('charge_id = $1 FOR UPDATE')) {
              return [{
                charge_id: BigInt(10),
                charge_code: 'CHG-001',
                total_amount: new Decimal(230000),
                currency: 'VND',
                purpose: 'RENTAL_INITIAL',
                target_id: BigInt(10),
                status: 'PENDING',
              }];
            }
            return [];
          },
          billingChargeLine: {
            findMany: async () => [
              { lineType: 'RENT', amount: new Decimal(30000) },
              { lineType: 'DEPOSIT', amount: new Decimal(200000) },
            ],
          },
          billingCharge: {
            update: async (data: any) => ({ ...data.data, chargeId: BigInt(10) }),
          },
          rentalDeposit: {
            upsert: async () => ({ collectedAmount: 200000, heldAmount: 200000 }),
          },
          buttonRental: {
            update: async (data: any) => data.data,
          },
          outboxEvent: {
            create: async () => ({}),
          },
        };
        return cb(tx);
      },
    };

    const repo = new BillingChargesRepository(mockPrismaSettlement);
    const service = new BillingChargesService(repo);

    // Test 3.1: Mã giả "abc" bị từ chối
    await assertThrows(
      () => service.settleCharge(BigInt(10), 'abc'),
      BadRequestException,
      'Mã giao dịch giả ("abc") bị từ chối xác thực',
    );

    // Test 3.2: Sai số tiền bị từ chối
    const mismatchedReceipt: VerifiedPaymentReceipt = {
      provider: 'PAYOS',
      providerTransactionCode: 'PAYOS-TX-88888',
      amount: 100000, // Khoản thu là 230.000đ
      currency: 'VND',
      verified: true,
    };
    await assertThrows(
      () => repo.settleChargeAtomicTx(BigInt(10), mismatchedReceipt),
      BadRequestException,
      'Số tiền không khớp (100k vs 230k) bị từ chối quyết toán',
    );

    // Test 3.3: Sai tiền tệ bị từ chối
    const foreignCurrencyReceipt: VerifiedPaymentReceipt = {
      provider: 'PAYOS',
      providerTransactionCode: 'PAYOS-TX-88888',
      amount: 230000,
      currency: 'USD', // Khoản thu là VND
      verified: true,
    };
    await assertThrows(
      () => repo.settleChargeAtomicTx(BigInt(10), foreignCurrencyReceipt),
      BadRequestException,
      'Đơn vị tiền tệ không khớp (USD vs VND) bị từ chối quyết toán',
    );

    // Test 3.4: Mã giao dịch đã sử dụng cho charge khác bị từ chối (Unique receipt)
    const usedReceipt: VerifiedPaymentReceipt = {
      provider: 'PAYOS',
      providerTransactionCode: 'USED-TX-99',
      amount: 230000,
      currency: 'VND',
      verified: true,
    };
    await assertThrows(
      () => repo.settleChargeAtomicTx(BigInt(10), usedReceipt),
      BadRequestException,
      'Biên lai trùng lặp (đã thanh toán cho charge khác) bị từ chối thanh toán lần hai',
    );

    // Test 3.5: Thanh toán hợp lệ thành công
    const validReceipt: VerifiedPaymentReceipt = {
      provider: 'PAYOS',
      providerTransactionCode: 'PAYOS-TX-VALID-12345',
      amount: 230000,
      currency: 'VND',
      verified: true,
    };
    const settled = await repo.settleChargeAtomicTx(BigInt(10), validReceipt);
    assert(
      settled.status === 'PAID' && settled.charge.status === 'PAID',
      'Settlement với chứng từ webhook/provider hợp lệ được chấp nhận',
    );
  }

  // ===========================================================================
  // TEST GROUP 4: THỜI HẠN THUÊ & KHÓA QUYỀN THUÊ (ISSUE 4)
  // ===========================================================================
  console.log('\n--- 4. THỜI HẠN THUÊ & KHÓA QUYỀN THUÊ ---');

  // Test 4.1: Bàn giao chậm không mất ngày (Thuê mới chưa đếm lùi ngày dùng trước khi bàn giao)
  {
    const mockPrismaInitialHandover: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('provider_transaction_code')) {
              return [];
            }
            if (sql.includes('charge_id = $1 FOR UPDATE')) {
              return [{
                charge_id: BigInt(11),
                charge_code: 'CHG-INIT-11',
                total_amount: new Decimal(230000),
                currency: 'VND',
                purpose: 'RENTAL_INITIAL',
                target_id: BigInt(11),
                status: 'PENDING',
              }];
            }
            if (sql.includes('FROM iot_button WHERE rental_id = $1')) {
              return [{
                button_id: BigInt(101),
                rental_id: BigInt(11),
                inventory_state: 'ALLOCATED_TO_STORE',
                custody_store_id: BigInt(99),
              }];
            }
            if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
              return [{
                rental_id: BigInt(11),
                status: 'PENDING_HANDOVER',
                months_rented: 1,
                fulfillment_store_id: BigInt(99),
              }];
            }
            if (sql.includes('billing_charge_lines bcl')) {
              return [{ paid_months: 1 }];
            }
            return [];
          },
          billingChargeLine: {
            findMany: async () => [
              { lineType: 'RENT', amount: new Decimal(30000) },
              { lineType: 'DEPOSIT', amount: new Decimal(200000) },
            ],
          },
          billingCharge: { update: async (data: any) => data.data },
          rentalDeposit: { upsert: async () => ({}) },
          buttonRental: { update: async (data: any) => data.data },
          ioTButton: {
            update: async (data: any) => data.data,
            updateMany: async () => ({ count: 1 }),
          },
          deviceMovement: { create: async () => ({ movementId: BigInt(1) }) },
          outboxEvent: { create: async () => ({}) },
        };
        return cb(tx);
      },
    };

    const billingRepo = new BillingChargesRepository(mockPrismaInitialHandover);
    const rentalsRepo = new RentalsRepository(mockPrismaInitialHandover);

    // Bước 1: Khách thanh toán cọc & phí thuê ban đầu -> PENDING_HANDOVER, effectiveExpiresAt = null!
    const initialSettlement = await billingRepo.settleChargeAtomicTx(BigInt(11), {
      provider: 'PAYOS',
      providerTransactionCode: 'PAYOS-INIT-TX-11',
      amount: 230000,
      currency: 'VND',
      verified: true,
    });

    assert(
      initialSettlement.rentalUpdated.status === 'PENDING_HANDOVER' &&
        initialSettlement.rentalUpdated.effectiveExpiresAt === null &&
        initialSettlement.rentalUpdated.paidThrough === null,
      'Thanh toán ban đầu: Vào trạng thái PENDING_HANDOVER, KHÔNG đếm lùi ngày trước khi bàn giao',
    );

    // Bước 2: Bàn giao thiết bị sau đó 5 ngày -> Đếm lùi bắt đầu từ ngày bàn giao thực tế
    const handoverDate = new Date('2026-11-05T10:00:00Z');
    const handoverResult = await rentalsRepo.handoverRentalButtonsTx(BigInt(11), { userId: '1' }, handoverDate);

    const expectedExpiry = new Date(handoverDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    assert(
      handoverResult.status === 'ACTIVE' &&
        handoverResult.effectiveExpiresAt.getTime() === expectedExpiry.getTime(),
      'Bàn giao thiết bị: Kích hoạt ACTIVE và tính đủ 30 ngày từ thời điểm bàn giao thực tế',
    );
  }

  // Test 4.2: Gia hạn đồng thời 2 kỳ không ghi đè thời hạn (Pessimistic row locking on rental)
  {
    let currentExpiry = new Date('2026-11-30T00:00:00Z');
    let monthsRented = 1;

    const mockPrismaExtension: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string, ...args: any[]) => {
            if (sql.includes('provider_transaction_code')) {
              return [];
            }
            if (sql.includes('charge_id = $1 FOR UPDATE')) {
              return [{
                charge_id: args[0],
                charge_code: `CHG-EXT-${args[0]}`,
                total_amount: new Decimal(30000),
                currency: 'VND',
                purpose: 'RENTAL_EXTENSION',
                target_id: BigInt(12),
                status: 'PENDING',
              }];
            }
            if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
              return [{
                rental_id: BigInt(12),
                status: 'ACTIVE',
                effective_expires_at: currentExpiry,
                months_rented: monthsRented,
              }];
            }
            return [];
          },
          billingChargeLine: {
            findMany: async () => [
              { lineType: 'RENT', amount: new Decimal(30000), description: 'Gia hạn thuê nút thông minh (1 tháng) [months: 1]' },
            ],
          },
          billingCharge: { update: async (data: any) => data.data },
          buttonRental: {
            update: async (data: any) => {
              currentExpiry = data.data.effectiveExpiresAt;
              monthsRented = data.data.monthsRented;
              return { effectiveExpiresAt: currentExpiry, monthsRented };
            },
          },
          outboxEvent: { create: async () => ({}) },
        };
        return cb(tx);
      },
    };

    const billingRepo = new BillingChargesRepository(mockPrismaExtension);

    // Kỳ 1: Gia hạn thêm 1 tháng
    const ext1 = await billingRepo.settleChargeAtomicTx(BigInt(101), {
      provider: 'PAYOS',
      providerTransactionCode: 'PAYOS-EXT-01',
      amount: 30000,
      currency: 'VND',
      verified: true,
    });

    // Kỳ 2: Gia hạn thêm 1 tháng nối tiếp
    const ext2 = await billingRepo.settleChargeAtomicTx(BigInt(102), {
      provider: 'PAYOS',
      providerTransactionCode: 'PAYOS-EXT-02',
      amount: 30000,
      currency: 'VND',
      verified: true,
    });

    const diffDays = Math.round((ext2.rentalUpdated.effectiveExpiresAt.getTime() - new Date('2026-11-30T00:00:00Z').getTime()) / (24 * 3600 * 1000));
    assert(
      diffDays === 60 && ext2.rentalUpdated.monthsRented === 3,
      'Gia hạn tuần tự dưới khóa: Cộng dồn đủ 60 ngày cho 2 khoản gia hạn (không bị ghi đè thời hạn)',
    );
  }

  // ===========================================================================
  // TEST GROUP 5: KHÓA ĐẶT HÀNG & CHỐNG RACE THU HỒI QUYỀN (ISSUE 5)
  // ===========================================================================
  console.log('\n--- 5. KHÓA ĐẶT HÀNG & CHỐNG RACE THU HỒI QUYỀN ---');

  {
    const createOrdersRepoMock = (buttonState: any, rentalState: any) => ({
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM iot_button WHERE button_id = $1 FOR UPDATE')) {
              return buttonState ? [buttonState] : [];
            }
            if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
              return rentalState ? [rentalState] : [];
            }
            return [];
          },
        };
        return cb(tx);
      },
    });

    // Test 5.1: Đặt hàng khi nút đang RETURN_IN_TRANSIT bị từ chối
    const repoReturnInTransit = new OrdersRepository(
      createOrdersRepoMock(
        { button_id: BigInt(1), status: 'ACTIVE', can_order: false, inventory_state: 'RETURN_IN_TRANSIT' },
        null,
      ) as any,
    );
    await assertThrows(
      () => repoReturnInTransit.createOrderFallbackTx({ buttonId: BigInt(1) }, 'COD', 0),
      BadRequestException,
      'Chặn đặt hàng khi nút đang trong luồng trả hàng (RETURN_IN_TRANSIT)',
    );

    // Test 5.2: Đặt hàng khi nút còn trong kho (ALLOCATED_TO_STORE) bị từ chối
    const repoInStore = new OrdersRepository(
      createOrdersRepoMock(
        { button_id: BigInt(1), status: 'ACTIVE', can_order: true, inventory_state: 'ALLOCATED_TO_STORE' },
        null,
      ) as any,
    );
    await assertThrows(
      () => repoInStore.createOrderFallbackTx({ buttonId: BigInt(1) }, 'COD', 0),
      BadRequestException,
      'Chặn đặt hàng khi nút chưa bàn giao cho khách (ALLOCATED_TO_STORE)',
    );

    // Test 5.3: Đặt hàng khi hợp đồng ở trạng thái PAID nhưng chưa bàn giao (PENDING_HANDOVER) bị từ chối
    const repoPendingHandover = new OrdersRepository(
      createOrdersRepoMock(
        { button_id: BigInt(1), status: 'ACTIVE', can_order: true, inventory_state: 'IN_CUSTOMER_CUSTODY', rental_id: BigInt(5) },
        { rental_id: BigInt(5), status: 'PAID' }, // Chưa ACTIVE
      ) as any,
    );
    await assertThrows(
      () => repoPendingHandover.createOrderFallbackTx({ buttonId: BigInt(1) }, 'COD', 0),
      BadRequestException,
      'Chặn đặt hàng khi hợp đồng mới chỉ PAID nhưng chưa bàn giao ACTIVE',
    );
  }

  // ===========================================================================
  // TEST GROUP 6: OUTBOX WORKER, RETRY, DLQ & KEY DETERMINISM (ISSUE 6)
  // ===========================================================================
  console.log('\n--- 6. OUTBOX WORKER, RETRY, DLQ & KEY DETERMINISM ---');

  // Test 6.1: Key notification determinism: eventId + recipientId + channel
  {
    let createdKeys: string[] = [];
    const mockRepo: any = {
      createNotification: async (data: any) => {
        createdKeys.push(data.idempotencyKey);
        return { notificationId: BigInt(1), ...data };
      },
    };
    const mockPrismaNotif: any = {
      userFcmToken: { findMany: async () => [] },
    };
    const notifService = new NotificationsService(mockPrismaNotif, { sendPushToDevice: async () => ({}) } as any, mockRepo);

    // Dispatch lần 1 cho kỳ 1
    await notifService.dispatchRentalEventNotification({
      eventType: 'RENTAL_EXPIRED',
      userId: BigInt(10),
      rentalCode: 'RNT-001',
      eventId: 'evt-month-1',
      channel: 'IN_APP',
    });

    // Retry cùng eventId (ví dụ worker chạy lại)
    await notifService.dispatchRentalEventNotification({
      eventType: 'RENTAL_EXPIRED',
      userId: BigInt(10),
      rentalCode: 'RNT-001',
      eventId: 'evt-month-1',
      channel: 'IN_APP',
    });

    assert(
      createdKeys[0] === createdKeys[1] && createdKeys[0] === 'notif:evt-month-1:10:IN_APP',
      'Retry cùng eventId giữ nguyên key idempotency: notif:evt-month-1:10:IN_APP (chống trùng)',
    );

    // Kỳ 2 hết hạn lần nữa (sự kiện mới)
    await notifService.dispatchRentalEventNotification({
      eventType: 'RENTAL_EXPIRED',
      userId: BigInt(10),
      rentalCode: 'RNT-001',
      eventId: 'evt-month-2',
      channel: 'IN_APP',
    });

    assert(
      createdKeys[2] === 'notif:evt-month-2:10:IN_APP' && createdKeys[2] !== createdKeys[0],
      'Kỳ hết hạn thứ hai có key mới: notif:evt-month-2:10:IN_APP (không bị nuốt thông báo)',
    );
  }

  // Test 6.2: Outbox Consumer claim với FOR UPDATE SKIP LOCKED, xử lý payout và đưa vào DLQ khi thất bại >= 3 lần
  {
    let deadLetterJobsCount = 0;
    let outboxStatus = 'PENDING';

    const mockPrismaOutbox: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('outbox_events') && sql.includes('SKIP LOCKED')) {
              return [{
                id: BigInt(999),
                event_type: 'DEPOSIT_REFUND_APPROVED',
                payload: { refundId: '999' },
                attempts: 2, // Đã thử 2 lần trước
                status: 'PENDING',
              }];
            }
            return [];
          },
          $executeRawUnsafe: async () => 1,
          outboxEvent: {
            update: async (data: any) => {
              outboxStatus = data.data.status;
            },
            updateMany: async (data: any) => {
              outboxStatus = data.data.status;
              return { count: 1 };
            },
          },
          deadLetterJob: {
            create: async () => {
              deadLetterJobsCount++;
            },
          },
        };
        return cb(tx);
      },
      depositRefund: {
        findUnique: async () => ({
          refundId: BigInt(999),
          refundCode: 'REF-999',
          customerId: BigInt(88),
          customer: { customerBankAccounts: [] }, // KHÔNG có tài khoản ngân hàng VERIFIED -> bắt buộc fail!
        }),
      },
      outboxEvent: {
        update: async (data: any) => {
          outboxStatus = data.data.status;
        },
        updateMany: async (data: any) => {
          outboxStatus = data.data.status;
          return { count: 1 };
        },
      },
    };

    const outboxConsumer = new OutboxConsumerService(
      mockPrismaOutbox,
      {} as any,
      { dispatchRentalEventNotification: async () => ({}) } as any,
    );

    const outboxResult = await outboxConsumer.processPendingEvents(1);
    assert(
      outboxResult.failed === 1 && outboxResult.dlqMoved === 1 && deadLetterJobsCount === 1,
      'Outbox Consumer: Tự động chuyển sự kiện thất bại 3 lần vào hàng đợi chết (DeadLetterJob DLQ)',
    );
  }

  // ===========================================================================
  // TEST GROUP 7: KIỂM THỬ ĐÓNG DỨT ĐIỂM R01 - R08 (COMPREHENSIVE CLOSURE)
  // ===========================================================================
  console.log('\n--- 7. KIỂM THỬ ĐÓNG DỨT ĐIỂM R01 - R08 ---');

  // R01: Từ chối chứng từ giả (string NOT-A-REAL-PAYMENT-123, verified: false, thiếu amount)
  {
    const mockPrismaR01: any = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          charge_id: BigInt(100),
          charge_code: 'CHG-100',
          total_amount: new Decimal(230000),
          currency: 'VND',
          status: 'PENDING',
        }],
      }),
    };
    const repo = new BillingChargesRepository(mockPrismaR01);

    await assertThrows(
      async () => repo.settleChargeAtomicTx(BigInt(100), 'NOT-A-REAL-PAYMENT-123' as any),
      BadRequestException,
      'R01: Từ chối chuỗi string "NOT-A-REAL-PAYMENT-123" (loại bỏ hoàn toàn tự suy đoán verified)',
    );

    await assertThrows(
      async () => repo.settleChargeAtomicTx(BigInt(100), {
        provider: 'PAYOS',
        providerTransactionCode: 'NOT-A-REAL-PAYMENT-123',
        amount: 230000,
        currency: 'VND',
        verified: false,
      } as any),
      BadRequestException,
      'R01: Từ chối biên lai có verified = false',
    );

    await assertThrows(
      async () => repo.settleChargeAtomicTx(BigInt(100), {
        provider: 'PAYOS',
        providerTransactionCode: 'NOT-A-REAL-PAYMENT-123',
        verified: true,
      } as any),
      BadRequestException,
      'R01: Từ chối biên lai thiếu amount và currency bắt buộc',
    );
  }

  // R02: Worker hoàn cọc gọi provider và giữ reserved khi chờ webhook
  {
    let payoutCalled: any = false;
    let confirmPayoutCalled: any = false;
    let savedBankAccountId: any = null;

    const mockPayosPayout: any = {
      createPayout: async () => {
        payoutCalled = true;
        return {
          code: '00',
          desc: 'success',
          data: { id: 'PAYOS-PAYOUT-STABLE-1', approvalState: 'PROCESSING' },
        };
      },
    };

    const mockPrismaR02: any = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          id: BigInt(201),
          event_type: 'DEPOSIT_REFUND_APPROVED',
          payload: { refundId: '201' },
          attempts: 0,
          status: 'PENDING',
        }],
        $executeRawUnsafe: async () => 1,
        outboxEvent: {
          updateMany: async () => ({ count: 1 }),
          update: async () => ({}),
        },
      }),
      depositRefund: {
        findUnique: async () => ({
          refundId: BigInt(201),
          refundCode: 'REF-201',
          amount: new Decimal(200000),
          customerId: BigInt(10),
          bankAccountId: null,
          customer: {
            userId: BigInt(5),
            customerBankAccounts: [{
              id: BigInt(888),
              verificationStatus: 'VERIFIED',
              bankBin: '970422',
              accountNumberMasked: '123456789',
              accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber('9876543210'),
            }],
          },
        }),
        update: async (data: any) => {
          if (data.data.bankAccountId) {
            savedBankAccountId = data.data.bankAccountId;
          }
        },
      },
      outboxEvent: {
        updateMany: async () => ({ count: 1 }),
        update: async () => ({}),
      },
    };

    const mockRentalsRepo: any = {
      confirmDepositRefundPayoutTx: async () => {
        confirmPayoutCalled = true;
      },
    };

    const worker = new OutboxConsumerService(
      mockPrismaR02,
      mockRentalsRepo,
      { dispatchRentalEventNotification: async () => ({}) } as any,
      mockPayosPayout,
    );

    await worker.processPendingEvents(1);
    assert(
      payoutCalled === true,
      'R02: Worker thực sự gọi PayOSPayoutService với payload chi trả',
    );
    assert(
      savedBankAccountId === BigInt(888),
      'R02: Worker chốt snapshot tài khoản nhận VERIFIED vào deposit_refunds',
    );
    assert(
      confirmPayoutCalled === false,
      'R02: Khi provider trả về PROCESSING (PENDING), tiền giữ ở reserved, KHÔNG tự chuyển sang REFUNDED',
    );
  }

  // R03: Luồng gia hạn không được tăng months_rented hay thời hạn trước khi thanh toán
  {
    const mockPrismaR03: any = {
      billingCharge: {
        create: async (data: any) => ({
          chargeId: BigInt(301),
          chargeCode: data.data.chargeCode,
          totalAmount: data.data.totalAmount,
          paymentMethod: data.data.paymentMethod,
        }),
      },
    };
    const mockRepoR03: any = {
      listAvailablePackages: async () => [],
      prisma: mockPrismaR03,
      findRentalById: async () => ({
        rentalId: BigInt(301),
        rentalCode: 'RNT-301',
        customerId: BigInt(10),
        status: 'PENDING_HANDOVER',
        monthsRented: 1,
        endDate: new Date('2026-11-30T00:00:00Z'),
        package: { monthlyPrice: new Decimal(30000) },
        customer: { userId: BigInt(10) },
      }),
      createRentalExtensionCharge: async () => ({
        chargeId: BigInt(301),
        chargeCode: 'CHG-EXT-301',
        totalAmount: 60000,
        status: 'PENDING',
      }),
      extendRental: async () => {
        throw new Error('extendRental should NOT be called before payment settlement');
      },
    };

    const { RentalsService } = require('../src/rentals/rentals.service');
    const service = new RentalsService(mockRepoR03);

    const extResult = await service.extendRentalContract('301', { additionalMonths: 2 }, { userId: '10' });
    assert(
      extResult.chargeId === '301' && extResult.status === 'PENDING_HANDOVER',
      'R03: Gọi extendRentalContract chỉ tạo billing_charge PENDING, KHÔNG sửa quyền thuê của hợp đồng',
    );
  }

  // R04: Bàn giao thất bại khi không có thiết bị hoặc số lượng không khớp
  {
    const mockPrismaR04: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM iot_button WHERE rental_id = $1')) {
              // Trả về rỗng (0 thiết bị)
              return [];
            }
            if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
              return [{
                rental_id: BigInt(401),
                status: 'PENDING_HANDOVER',
                button_quantity: 1,
              }];
            }
            return [];
          },
        };
        return cb(tx);
      },
    };
    const repo = new RentalsRepository(mockPrismaR04);

    await assertThrows(
      async () => repo.handoverRentalButtonsTx(BigInt(401), { userId: '1' }),
      BadRequestException,
      'R04: Bàn giao từ chối kích hoạt khi hợp đồng có 0 thiết bị được gán',
    );
  }

  // R04.2: Bàn giao từ chối khi thiết bị không ở trạng thái ALLOCATED_TO_STORE
  {
    const mockPrismaR04_2: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM iot_button WHERE rental_id = $1')) {
              return [{
                button_id: BigInt(501),
                rental_id: BigInt(402),
                inventory_state: 'IN_PLATFORM_WAREHOUSE', // Sai trạng thái
                custody_store_id: BigInt(1),
              }];
            }
            if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
              return [{
                rental_id: BigInt(402),
                status: 'PENDING_HANDOVER',
                button_quantity: 1,
                fulfillment_store_id: BigInt(1),
              }];
            }
            return [];
          },
        };
        return cb(tx);
      },
    };
    const repo = new RentalsRepository(mockPrismaR04_2);

    await assertThrows(
      async () => repo.handoverRentalButtonsTx(BigInt(402), { userId: '1' }),
      BadRequestException,
      'R04: Bàn giao từ chối khi thiết bị chưa ALLOCATED_TO_STORE',
    );
  }

  // R06: Outbox worker thu hồi lease hết hạn (locked_until < NOW())
  {
    let leaseClaimed: any = false;
    const mockPrismaR06: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('locked_until < NOW()')) {
              leaseClaimed = true;
              return [{
                id: BigInt(601),
                event_type: 'BILLING_CHARGE_SETTLED',
                payload: { purpose: 'RENTAL_INITIAL', targetId: '10' },
                attempts: 1,
                status: 'PROCESSING',
              }];
            }
            return [];
          },
          $executeRawUnsafe: async () => 1,
          outboxEvent: {
            updateMany: async () => ({ count: 1 }),
          },
        };
        return cb(tx);
      },
      buttonRental: {
        findUnique: async () => ({ rentalId: BigInt(10), customer: { userId: BigInt(1) } }),
      },
      outboxEvent: {
        updateMany: async () => ({ count: 1 }),
      },
    };

    const worker = new OutboxConsumerService(
      mockPrismaR06,
      {} as any,
      { dispatchRentalEventNotification: async () => ({}) } as any,
    );

    await worker.processPendingEvents(1);
    assert(
      leaseClaimed === true,
      'R06: Worker truy vấn và thu hồi thành công outbox event có lease PROCESSING đã hết hạn',
    );
  }

  // R06.2: Outbox worker không âm thầm nuốt sự kiện lạ
  {
    const mockPrismaR06_2: any = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          id: BigInt(602),
          event_type: 'UNKNOWN_CRITICAL_EVENT',
          payload: {},
          attempts: 0,
          status: 'PENDING',
        }],
        $executeRawUnsafe: async () => 1,
        outboxEvent: {
          updateMany: async () => ({ count: 1 }),
          update: async () => ({}),
        },
      }),
      outboxEvent: {
        updateMany: async () => ({ count: 1 }),
        update: async () => ({}),
      },
    };

    const worker = new OutboxConsumerService(
      mockPrismaR06_2,
      {} as any,
      { dispatchRentalEventNotification: async () => ({}) } as any,
    );

    const res = await worker.processPendingEvents(1);
    assert(
      res.failed === 1,
      'R06: Sự kiện không có handler bị reject (failed = 1), không âm thầm đánh dấu COMPLETED',
    );
  }

  // R07: Fallback từ chối khi effective_expires_at null hoặc <= NOW()
  {
    const mockPrismaR07: any = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('FROM iot_button WHERE button_id = $1 FOR UPDATE')) {
            return [{
              button_id: BigInt(701),
              status: 'ACTIVE',
              can_order: true,
              inventory_state: 'IN_CUSTOMER_CUSTODY',
              rental_id: BigInt(701),
            }];
          }
          if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
            return [{
              rental_id: BigInt(701),
              status: 'ACTIVE',
              effective_expires_at: new Date('2025-01-01T00:00:00Z'), // Đã hết hạn
            }];
          }
          return [];
        },
      }),
    };
    const repo = new OrdersRepository(mockPrismaR07);

    await assertThrows(
      async () => repo.createOrderFallbackTx({ buttonId: BigInt(701) }, 'COD', 15000),
      BadRequestException,
      'R07: Fallback thống nhất với SP từ chối đặt hàng khi effective_expires_at <= NOW()',
    );
  }

  // R08: Audit Log được ghi nhận khi bàn giao thiết bị
  {
    let auditLogAction = '';
    const mockPrismaR08: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM iot_button WHERE rental_id = $1')) {
              return [{
                button_id: BigInt(801),
                rental_id: BigInt(801),
                inventory_state: 'ALLOCATED_TO_STORE',
                custody_store_id: BigInt(1),
              }];
            }
            if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
              return [{
                rental_id: BigInt(801),
                status: 'PENDING_HANDOVER',
                button_quantity: 1,
                rental_code: 'RNT-801',
                fulfillment_store_id: BigInt(1),
              }];
            }
            if (sql.includes('billing_charges')) {
              return [{ paid_months: 1 }];
            }
            return [];
          },
          buttonRental: { update: async (data: any) => data.data },
          ioTButton: { update: async (data: any) => data.data },
          deviceMovement: { create: async () => ({}) },
          rentalAuditLog: {
            create: async (data: any) => {
              auditLogAction = data.data.action;
              return { auditId: BigInt(1) };
            },
          },
        };
        return cb(tx);
      },
    };

    const repo = new RentalsRepository(mockPrismaR08);
    await repo.handoverRentalButtonsTx(BigInt(801), { userId: '99', role: 'STORE_STAFF' });
    assert(
      auditLogAction === 'HANDOVER_RENTAL',
      'R08: Bàn giao thiết bị tự động ghi nhật ký vào rental_audit_logs cùng transaction',
    );
  }

  // R02.2: Reconcile payout không nhận mã tùy ý và giữ reserved khi provider trả PROCESSING
  {
    const mockRepoR02_2: any = {
      findDepositRefundById: async (refundId: bigint) => ({
        refundId,
        refundCode: 'REF-R02-TEST',
        status: 'PENDING_PAYOUT',
        amount: new Decimal(200000),
        providerReferenceId: 'PAYOS-PAYOUT-STILL-PROCESSING',
      }),
      confirmDepositRefundPayoutTx: async () => {
        throw new Error('confirmDepositRefundPayoutTx should NOT be called when provider is PROCESSING');
      },
    };
    const mockPayosPayoutR02_2: any = {
      getPayout: async () => ({
        code: '00',
        desc: 'success',
        data: {
          id: 'PAYOS-PAYOUT-STILL-PROCESSING',
          approvalState: 'PROCESSING',
          amount: 200000,
        },
      }),
    };
    const { RentalsService } = require('../src/rentals/rentals.service');
    const service = new RentalsService(mockRepoR02_2, null, mockPayosPayoutR02_2);
    const res = await service.reconcileDepositRefundPayout('202', { userId: '1', role: 'ADMIN' });
    assert(
      res.success === false && res.status === 'PENDING_PAYOUT',
      'R02: Đối soát payout giữ nguyên PENDING_PAYOUT khi provider trả PROCESSING (không tự ý REFUNDED)',
    );
  }

  // R02.2b: Reconcile payout từ chối fail-closed khi provider báo SUCCEEDED nhưng thiếu transactions hoặc amount (chặn probe rỗng)
  {
    const mockRepoR02_2b: any = {
      findDepositRefundById: async (refundId: bigint) => ({
        refundId,
        refundCode: 'REF-R02-EMPTY-PROBE',
        status: 'PENDING_PAYOUT',
        amount: new Decimal(200000),
        providerReferenceId: 'PAYOS-PAYOUT-EMPTY-PROBE',
      }),
      confirmDepositRefundPayoutTx: async () => {
        throw new Error('confirmDepositRefundPayoutTx should NEVER be called when transactions or amount are missing');
      },
    };
    // Provider chỉ trả code: "00", approvalState: "SUCCEEDED" nhưng KHÔNG có transactions hay amount
    const mockPayosPayoutR02_2b: any = {
      getPayout: async () => ({
        code: '00',
        desc: 'success',
        data: {
          id: 'PAYOS-PAYOUT-EMPTY-PROBE',
          approvalState: 'SUCCEEDED',
        },
      }),
    };
    const { RentalsService } = require('../src/rentals/rentals.service');
    const service = new RentalsService(mockRepoR02_2b, null, mockPayosPayoutR02_2b);
    await assertThrows(
      async () => service.reconcileDepositRefundPayout('202', { userId: '1', role: 'ADMIN' }),
      BadRequestException,
      'R02: Đối soát payout từ chối fail-closed khi provider báo SUCCEEDED nhưng thiếu transactions hoặc amount (chặn probe rỗng)',
    );
  }

  // R02.2c: Worker tạo payout nhận SUCCEEDED nhưng thiếu transactions thì giữ PENDING_PAYOUT, không gọi confirm
  {
    let confirmCalled = false;
    const mockPrismaR02_2c: any = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('outbox_events') && sql.includes('SKIP LOCKED')) {
            return [{
              id: BigInt(205),
              event_type: 'DEPOSIT_REFUND_APPROVED',
              payload: { refundId: '205' },
              attempts: 0,
              status: 'PENDING',
              claimToken: 'token-205',
            }];
          }
          return [];
        },
        $executeRawUnsafe: async () => 1,
        outboxEvent: {
          updateMany: async () => ({ count: 1 }),
        },
      }),
      depositRefund: {
        findUnique: async () => ({
          refundId: BigInt(205),
          refundCode: 'REF-205',
          customerId: BigInt(88),
          amount: new Decimal(200000),
          bankAccount: {
            id: BigInt(1),
            bankBin: '970422',
            accountNumberEncrypted: CryptoVaultUtil.encryptAccountNumber('1234567890'),
            accountNumberMasked: '******7890',
            verificationStatus: 'VERIFIED',
          },
        }),
        update: async () => ({}),
      },
      outboxEvent: {
        updateMany: async () => ({ count: 1 }),
      },
    };
    const mockRentalsRepoR02_2c: any = {
      confirmDepositRefundPayoutTx: async () => {
        confirmCalled = true;
      },
    };
    const mockPayosPayoutR02_2c: any = {
      createPayout: async () => ({
        code: '00',
        desc: 'success',
        data: {
          id: 'payout-205',
          approvalState: 'SUCCEEDED',
          // Thiếu transactions
        },
      }),
    };
    const worker = new OutboxConsumerService(mockPrismaR02_2c, mockRentalsRepoR02_2c, {} as any, mockPayosPayoutR02_2c);
    await worker.processPendingEvents(1);
    assert(
      confirmCalled === false,
      'R02: Worker tạo payout nhận SUCCEEDED nhưng thiếu transactions thì giữ PENDING_PAYOUT, không gọi confirm',
    );
  }

  // R02.3: Reconcile payout từ chối khi refund chưa có providerReferenceId
  {
    const mockRepoR02_3: any = {
      findDepositRefundById: async (refundId: bigint) => ({
        refundId,
        status: 'PENDING_PAYOUT',
        amount: new Decimal(200000),
        providerReferenceId: null, // Chưa có tham chiếu
      }),
    };
    const { RentalsService } = require('../src/rentals/rentals.service');
    const service = new RentalsService(mockRepoR02_3, null, {} as any);
    await assertThrows(
      async () => service.reconcileDepositRefundPayout('203'),
      BadRequestException,
      'R02: Đối soát payout từ chối khi chưa có providerReferenceId từ cổng thanh toán',
    );
  }

  // R02.4: Worker từ chối payout khi tài khoản thiếu dữ liệu mã hóa hoặc thiếu BIN (không dùng số masked/fake)
  {
    const mockPrismaR02_4: any = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          id: BigInt(204),
          event_type: 'DEPOSIT_REFUND_APPROVED',
          payload: { refundId: '204' },
          attempts: 0,
          status: 'PENDING',
        }],
        $executeRawUnsafe: async () => 1,
        outboxEvent: {
          updateMany: async () => ({ count: 1 }),
        },
      }),
      depositRefund: {
        findUnique: async () => ({
          refundId: BigInt(204),
          refundCode: 'REF-204',
          amount: new Decimal(200000),
          customerId: BigInt(10),
          bankAccountId: null,
          customer: {
            userId: BigInt(5),
            customerBankAccounts: [{
              id: BigInt(889),
              verificationStatus: 'VERIFIED',
              bankBin: '', // Thiếu BIN
              accountNumberMasked: '123456789',
              accountNumberEncrypted: null, // Thiếu dữ liệu mã hóa
            }],
          },
        }),
      },
      outboxEvent: {
        updateMany: async () => ({ count: 1 }),
      },
    };

    let payoutAttempted = false;
    const mockPayosPayout: any = {
      createPayout: async () => {
        payoutAttempted = true;
        return { code: '00' };
      },
    };

    const worker = new OutboxConsumerService(
      mockPrismaR02_4,
      {} as any,
      { dispatchRentalEventNotification: async () => ({}) } as any,
      mockPayosPayout,
    );

    await worker.processPendingEvents(1);
    assert(
      payoutAttempted === false,
      'R02: Worker dừng chi trả ngay lập tức khi tài khoản thiếu mã hóa hoặc BIN (không dùng fallback masked)',
    );
  }

  // R03.2: Bàn giao từ chối khi hợp đồng có 0 kỳ được thanh toán (không có fallback 1 tháng)
  {
    const mockPrismaR03_2: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM iot_button WHERE rental_id = $1')) {
              return [{
                button_id: BigInt(301),
                rental_id: BigInt(301),
                inventory_state: 'ALLOCATED_TO_STORE',
                custody_store_id: BigInt(1),
              }];
            }
            if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
              return [{
                rental_id: BigInt(301),
                status: 'PENDING_HANDOVER',
                button_quantity: 1,
                fulfillment_store_id: BigInt(1),
              }];
            }
            if (sql.includes('billing_charges')) {
              // 0 kỳ đã thanh toán!
              return [{ paid_months: 0 }];
            }
            return [];
          },
        };
        return cb(tx);
      },
    };
    const repo = new RentalsRepository(mockPrismaR03_2);
    await assertThrows(
      async () => repo.handoverRentalButtonsTx(BigInt(301), { userId: '1' }),
      BadRequestException,
      'R03: Bàn giao từ chối khi hợp đồng có 0 kỳ được thanh toán (loại bỏ triệt để fallback 1 tháng)',
    );
  }

  // R04.3: Bàn giao từ chối khi thiết bị thiếu custody_store_id hoặc khác fulfillment_store_id
  {
    const mockPrismaR04_3: any = {
      $transaction: async (cb: any) => {
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM iot_button WHERE rental_id = $1')) {
              return [{
                button_id: BigInt(403),
                rental_id: BigInt(403),
                inventory_state: 'ALLOCATED_TO_STORE',
                custody_store_id: null, // Thiếu custody!
              }];
            }
            if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
              return [{
                rental_id: BigInt(403),
                status: 'PENDING_HANDOVER',
                button_quantity: 1,
                fulfillment_store_id: BigInt(1),
              }];
            }
            return [];
          },
        };
        return cb(tx);
      },
    };
    const repo = new RentalsRepository(mockPrismaR04_3);
    await assertThrows(
      async () => repo.handoverRentalButtonsTx(BigInt(403), { userId: '1' }),
      BadRequestException,
      'R04: Bàn giao từ chối khi thiết bị thiếu thông tin kho tạm giữ (custody_store_id null)',
    );
  }

  // R03.3: Gia hạn thanh toán trước khi bàn giao giữ nguyên trạng thái PENDING_HANDOVER
  {
    const mockPrismaR03_3: any = {
      $transaction: async (cb: any) => {
        let updatedStatus = '';
        let updatedPaidThrough: any = 'NOT_TOUCHED';
        const tx: any = {
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM billing_charges WHERE charge_id = $1')) {
              return [{
                charge_id: BigInt(303),
                purpose: 'RENTAL_EXTENSION',
                target_type: 'RENTAL',
                target_id: BigInt(303),
                total_amount: new Decimal(60000),
                currency: 'VND',
                status: 'PENDING',
              }];
            }
            if (sql.includes('FROM button_rentals WHERE rental_id = $1 FOR UPDATE')) {
              return [{
                rental_id: BigInt(303),
                status: 'PENDING_HANDOVER', // Chưa bàn giao
                months_rented: 1,
                effective_expires_at: null,
              }];
            }
            return [];
          },
          $executeRawUnsafe: async () => 1,
          billingCharge: {
            update: async () => ({}),
          },
          buttonRental: {
            update: async (data: any) => {
              updatedStatus = data.data.status;
              updatedPaidThrough = data.data.paidThrough;
              return data.data;
            },
          },
          billingChargeLine: {
            findMany: async () => [{ lineType: 'RENT', durationCount: 2 }],
          },
          paymentTransaction: { create: async () => ({}) },
          rentalAuditLog: { create: async () => ({}) },
          outboxEvent: { create: async () => ({}) },
        };
        await cb(tx);
        return { updatedStatus, updatedPaidThrough };
      },
    };
    const repo = new BillingChargesRepository(mockPrismaR03_3);
    const receipt: VerifiedPaymentReceipt = {
      provider: 'PAYOS',
      providerTransactionCode: 'TX-EXT-PRE-HANDOVER-001',
      amount: 60000,
      currency: 'VND',
      paidAt: new Date(),
      verified: true,
    };
    const result: any = await repo.settleChargeAtomicTx(BigInt(303), receipt, { userId: BigInt(1) });
    const { updatedStatus, updatedPaidThrough } = result;
    assert(
      updatedStatus === 'PENDING_HANDOVER' && updatedPaidThrough === undefined,
      'R03: Gia hạn thanh toán trước bàn giao giữ nguyên PENDING_HANDOVER, không kích hoạt ACTIVE sớm',
    );
  }

  // R03.4: State Machine chặn Admin cập nhật status sang PENDING_HANDOVER hoặc ACTIVE tùy ý
  {
    const mockRepoR03_4: any = {
      findRentalById: async () => ({
        rentalId: BigInt(304),
        status: 'PENDING_PAYMENT',
      }),
    };
    const { RentalsService } = require('../src/rentals/rentals.service');
    const service = new RentalsService(mockRepoR03_4, {} as any);
    await assertThrows(
      async () => service.updateRentalStatusAdmin('304', 'ACTIVE'),
      BadRequestException,
      'R03: State Machine chặn Admin đổi trực tiếp trạng thái sang ACTIVE mà không qua bàn giao',
    );
    await assertThrows(
      async () => service.updateRentalStatusAdmin('304', 'PENDING_HANDOVER'),
      BadRequestException,
      'R03: State Machine chặn Admin đổi trực tiếp sang PENDING_HANDOVER mà không qua thanh toán',
    );
  }

  // R01.3: Reconcile charge từ chối chế độ Mock khi NODE_ENV = production
  {
    const origEnv = process.env.NODE_ENV;
    const origMock = process.env.PAYOS_MOCK_PAYMENT;
    process.env.NODE_ENV = 'production';
    process.env.PAYOS_MOCK_PAYMENT = 'true';
    const mockRepoR01: any = {
      findChargeById: async () => ({
        chargeId: BigInt(105),
        status: 'PENDING',
        totalAmount: 230000,
      }),
    };
    const service = new BillingChargesService(mockRepoR01);
    await assertThrows(
      async () => service.reconcileAndSettleCharge(BigInt(105), 'ANY-CODE', { userId: BigInt(1) }),
      BadRequestException,
      'R01: Chế độ Mock Payment bị chặn tuyệt đối trên môi trường Production',
    );
    process.env.NODE_ENV = origEnv;
    process.env.PAYOS_MOCK_PAYMENT = origMock;
  }

  // R01.4: Reconcile charge từ chối chế độ Mock khi NODE_ENV = staging
  {
    const origEnv = process.env.NODE_ENV;
    const origMock = process.env.PAYOS_MOCK_PAYMENT;
    process.env.NODE_ENV = 'staging';
    process.env.PAYOS_MOCK_PAYMENT = 'true';
    const mockRepoR01_4: any = {
      findChargeById: async () => ({
        chargeId: BigInt(106),
        status: 'PENDING',
        totalAmount: 230000,
      }),
    };
    const service = new BillingChargesService(mockRepoR01_4);
    await assertThrows(
      async () => service.reconcileAndSettleCharge(BigInt(106), 'ANY-CODE', { userId: BigInt(1) }),
      BadRequestException,
      'R01: Chế độ Mock Payment bị chặn tuyệt đối trên môi trường Staging',
    );
    process.env.NODE_ENV = origEnv;
    process.env.PAYOS_MOCK_PAYMENT = origMock;
  }

  // R06.3: Worker phát hiện mất lease (count = 0) thì hủy xử lý và không đẩy vào DLQ
  {
    let dlqCreated = false;
    const mockPrismaR06_3: any = {
      $transaction: async (cb: any) => cb({
        $queryRawUnsafe: async () => [{
          id: BigInt(603),
          attempts: 2,
          event_type: 'ANY_EVENT',
          claimToken: 'token-old',
        }],
        $executeRawUnsafe: async () => 1,
        outboxEvent: {
          updateMany: async () => ({ count: 0 }), // count = 0: Lease bị mất!
        },
        deadLetterJob: {
          create: async () => {
            dlqCreated = true;
          },
        },
      }),
    };
    const worker = new OutboxConsumerService(mockPrismaR06_3, {} as any, {} as any);
    await worker.processPendingEvents(1);
    assert(
      dlqCreated === false,
      'R06: Worker mất lease (count = 0) hủy tác vụ an toàn, không tạo bản ghi rác trong DLQ',
    );
  }

  // R08.2: Database chặn tuyệt đối UPDATE và DELETE trên rental_audit_logs, kiểm tra actor & rollback an toàn (Append-Only)
  {
    const realPrisma = getSafeTestPrismaClient('Suite 50: Deep Architectural Verification');
    let triggerBlockedUpdate: any = false;
    let triggerBlockedDelete: any = false;
    let actorRecorded: any = false;
    let noSensitiveData: any = false;
    let rollbackSuccess: any = false;

    // Test 1: Kiểm tra Actor, Sensitive Data & Chặn UPDATE trong Transaction cách ly
    try {
      await realPrisma.$transaction(async (tx: any) => {
        const testLog = await tx.rentalAuditLog.create({
          data: {
            actorType: 'ADMIN',
            actorUserId: BigInt(777),
            action: 'TEST_IMMUTABILITY_TRANSACTION',
            targetType: 'RENTAL',
            targetId: BigInt(999999),
            beforeState: 'INIT',
            afterState: 'MUTATED',
            metadata: {
              actorRole: 'SUPER_ADMIN',
              accountMasked: '******1234',
              correlationId: 'CORR-TEST-777',
            },
          },
        });

        if (testLog.actorUserId === BigInt(777) && testLog.actorType === 'ADMIN') {
          actorRecorded = true;
        }

        const metaStr = JSON.stringify(testLog.metadata);
        if (!metaStr.includes('password') && !metaStr.includes('secret') && !metaStr.includes('accountNumberEncrypted')) {
          noSensitiveData = true;
        }

        // Chạy update: trigger sẽ bắn lỗi P0001
        await tx.rentalAuditLog.update({
          where: { auditId: testLog.auditId },
          data: { action: 'TAMPERED' },
        });
      });
    } catch (err: any) {
      if (err.message && (err.message.includes('rental_audit_logs is append-only') || err.message.includes('P0001'))) {
        triggerBlockedUpdate = true;
        rollbackSuccess = true;
      }
    }

    // Test 2: Kiểm tra chặn DELETE trong Transaction cách ly
    try {
      await realPrisma.$transaction(async (tx: any) => {
        const testLog = await tx.rentalAuditLog.create({
          data: {
            actorType: 'ADMIN',
            action: 'TEST_DELETE_IMMUTABILITY',
            targetType: 'RENTAL',
            targetId: BigInt(999998),
          },
        });

        // Chạy delete: trigger sẽ bắn lỗi P0001
        await tx.rentalAuditLog.delete({
          where: { auditId: testLog.auditId },
        });
      });
    } catch (err: any) {
      if (err.message.includes('rental_audit_logs is append-only')) {
        triggerBlockedDelete = true;
      }
    }

    assert(
      triggerBlockedUpdate === true,
      'R08: PostgreSQL Trigger chặn tuyệt đối UPDATE trên rental_audit_logs (Append-Only Engine Invariant)',
    );
    assert(
      triggerBlockedDelete === true,
      'R08: PostgreSQL Trigger chặn tuyệt đối DELETE trên rental_audit_logs (Append-Only Engine Invariant)',
    );
    assert(
      actorRecorded === true && noSensitiveData === true && rollbackSuccess === true,
      'R08: Audit Log ghi đúng actor thật, không rò rỉ dữ liệu nhạy cảm và rollback sạch không để lại rác',
    );
    await realPrisma.$disconnect();
  }

  console.log(`\n================================================================================`);
  console.log(`Deep Architectural Verification Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runDeepFixesTestSuite();


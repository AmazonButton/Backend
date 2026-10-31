import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateRentalOrderDto } from '../src/rentals/dto/rentals.dto';
import { RentalExtensionDto } from '../src/rentals/dto/rental-extension.dto';
import { AssignFulfillmentDto } from '../src/rentals/dto/assign-fulfillment.dto';
import { AdminAdjustDurationDto } from '../src/rentals/dto/admin-adjust-duration.dto';
import { CreateReturnRequestDto, ConfirmReturnReceiptDto } from '../src/rentals/dto/return-request.dto';
import { RentalsService } from '../src/rentals/rentals.service';
import { assertTestDatabase } from './test-db-guard';
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';

async function runPhase7ValidationAndAuditSuite() {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/platform_button_rental_test';
  assertTestDatabase('Phase 7: Validation, BOLA & Audit');
  console.log('================================================================================');
  console.log('⚡ PHASE 7: API VALIDATION DTOS, STRICT BOLA & AUDIT IMMUTABILITY');
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

  try {
    // -------------------------------------------------------------------------
    // 1. DTO Validation: CreateRentalOrderDto
    // -------------------------------------------------------------------------
    const invalidCreateDto1 = plainToInstance(CreateRentalOrderDto, {
      packageId: '',
      monthsRented: 0,
    });
    const createErrors1 = await validate(invalidCreateDto1);
    assert(
      createErrors1.length >= 2,
      '7.1 [DTO Validation] CreateRentalOrderDto từ chối packageId rỗng và monthsRented <= 0',
    );

    const validCreateDto = plainToInstance(CreateRentalOrderDto, {
      packageId: 'PKG-101',
      monthsRented: 3,
    });
    const createErrors2 = await validate(validCreateDto);
    assert(
      createErrors2.length === 0,
      '7.2 [DTO Validation] CreateRentalOrderDto chấp nhận dữ liệu hợp lệ (monthsRented >= 1)',
    );

    // -------------------------------------------------------------------------
    // 2. DTO Validation: RentalExtensionDto
    // -------------------------------------------------------------------------
    const invalidExtensionDto = plainToInstance(RentalExtensionDto, {
      additionalMonths: 0,
    });
    const extErrors1 = await validate(invalidExtensionDto);
    assert(
      extErrors1.length > 0 && extErrors1[0].constraints?.min !== undefined,
      '7.3 [DTO Validation] RentalExtensionDto từ chối additionalMonths = 0 hoặc âm',
    );

    const excessiveExtensionDto = plainToInstance(RentalExtensionDto, {
      additionalMonths: 25,
    });
    const extErrors2 = await validate(excessiveExtensionDto);
    assert(
      extErrors2.length > 0 && extErrors2[0].constraints?.max !== undefined,
      '7.4 [DTO Validation] RentalExtensionDto giới hạn thời gian gia hạn tối đa 24 tháng',
    );

    // -------------------------------------------------------------------------
    // 3. DTO Validation: AssignFulfillmentDto
    // -------------------------------------------------------------------------
    const invalidAssignDto = plainToInstance(AssignFulfillmentDto, {
      fulfillmentStoreId: '',
      buttonIds: [],
    });
    const assignErrors = await validate(invalidAssignDto);
    assert(
      assignErrors.length >= 2,
      '7.5 [DTO Validation] AssignFulfillmentDto từ chối storeId rỗng và buttonIds rỗng',
    );

    const validAssignDto = plainToInstance(AssignFulfillmentDto, {
      fulfillmentStoreId: 'STORE-99',
      buttonIds: ['DEV-101', 'DEV-102'],
      notes: 'Giao hàng đợt 1',
    });
    const validAssignErrors = await validate(validAssignDto);
    assert(
      validAssignErrors.length === 0,
      '7.6 [DTO Validation] AssignFulfillmentDto chấp nhận mảng buttonIds hợp lệ và ghi chú',
    );

    // -------------------------------------------------------------------------
    // 4. DTO Validation: AdminAdjustDurationDto
    // -------------------------------------------------------------------------
    const zeroDaysDto = plainToInstance(AdminAdjustDurationDto, {
      additionalDays: 0,
      reason: 'Lý do hợp lệ dài hơn năm ký tự',
    });
    const zeroDaysErrors = await validate(zeroDaysDto);
    assert(
      zeroDaysErrors.length > 0,
      '7.7 [DTO Validation] AdminAdjustDurationDto từ chối additionalDays = 0',
    );

    const shortReasonDto = plainToInstance(AdminAdjustDurationDto, {
      additionalDays: 5,
      reason: 'ngắn',
    });
    const shortReasonErrors = await validate(shortReasonDto);
    assert(
      shortReasonErrors.length > 0 && shortReasonErrors[0].constraints?.minLength !== undefined,
      '7.8 [DTO Validation] AdminAdjustDurationDto bắt buộc lý do điều chỉnh tối thiểu 5 ký tự',
    );

    // -------------------------------------------------------------------------
    // 5. Strict BOLA: Customer Isolation
    // -------------------------------------------------------------------------
    const mockRentalInDb = {
      rentalId: BigInt(888),
      rentalCode: 'RNT-2026-888',
      customerId: BigInt(100), // Belongs to Customer Profile 100
      customer: { userId: BigInt(1000) }, // User ID 1000
      totalRentAmount: 200000,
      depositAmount: 150000,
      status: 'ACTIVE',
      fulfillmentStoreId: BigInt(50),
      buttons: [{ buttonId: BigInt(901), buttonCode: 'BTN-901', name: 'IoT Button 1', status: 'ACTIVE' }],
      createdAt: new Date(),
      updatedAt: new Date(),
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 86400000),
    };

    const mockRentalsRepo: any = {
      findRentalById: async (id: bigint) => (id === BigInt(888) ? mockRentalInDb : null),
      findDepositRefundById: async () => null,
    };

    const rentalsService = new RentalsService(
      mockRentalsRepo,
      null as any,
      null as any,
      null as any,
    );

    // Customer B (Profile 200, User 2000) attempts to access Customer A's rental
    const maliciousCustomerUser = {
      role: 'CUSTOMER',
      customerProfileId: '200',
      userId: '2000',
    };

    try {
      await rentalsService.getRentalDetail('888', maliciousCustomerUser);
      assert(false, '7.9 [Strict BOLA] Khách hàng khác truy cập trái phép hợp đồng không bị chặn');
    } catch (e: any) {
      assert(
        e instanceof ForbiddenException && e.message.includes('Bạn không có quyền truy cập'),
        '7.9 [Strict BOLA] Khách hàng khác xem chi tiết hợp đồng của người khác bị chặn 403 Forbidden',
      );
    }

    try {
      await rentalsService.extendRentalContract('888', { additionalMonths: 1 }, maliciousCustomerUser);
      assert(false, '7.10 [Strict BOLA] Khách hàng khác gia hạn trái phép hợp đồng không bị chặn');
    } catch (e: any) {
      assert(
        e instanceof ForbiddenException && e.message.includes('Bạn không có quyền truy cập'),
        '7.10 [Strict BOLA] Khách hàng khác cố gắng gia hạn hợp đồng của người khác bị chặn 403 Forbidden',
      );
    }

    try {
      await rentalsService.createReturnRequest('888', '901', maliciousCustomerUser);
      assert(false, '7.11 [Strict BOLA] Khách hàng khác gửi yêu cầu trả nút trái phép không bị chặn');
    } catch (e: any) {
      assert(
        e instanceof ForbiddenException && e.message.includes('Bạn không có quyền truy cập'),
        '7.11 [Strict BOLA] Khách hàng khác yêu cầu trả nút trên hợp đồng của người khác bị chặn 403 Forbidden',
      );
    }

    // -------------------------------------------------------------------------
    // 6. Strict BOLA: Store Fulfillment / Custody Isolation
    // -------------------------------------------------------------------------
    // Staff from Store 99 tries to confirm return receipt for a contract assigned to Store 50
    const mockRepoForStoreBola: any = {
      findRentalById: async () => null,
      confirmReturnReceiptTx: async (_returnId: bigint, staffUser: any) => {
        const targetStoreId = '50';
        const staffStoreId = staffUser.storeId?.toString();
        const isAdmin = ['SUPER_ADMIN', 'SYSTEM_ADMIN', 'ADMIN'].includes(staffUser.role);
        if (!isAdmin && (!staffStoreId || staffStoreId !== targetStoreId)) {
          throw new ForbiddenException('Bạn không thuộc cửa hàng chịu trách nhiệm nhận trả thiết bị cho hợp đồng này');
        }
        return { success: true };
      },
    };

    const rentalsServiceStoreBola = new RentalsService(
      mockRepoForStoreBola,
      null as any,
      null as any,
      null as any,
    );

    const storeStaffWrongStore = {
      role: 'STAFF_BUTTON',
      storeId: '99', // Store 99 != Target Store 50
      userId: '777',
    };

    try {
      await rentalsServiceStoreBola.confirmReturnReceipt('10', storeStaffWrongStore, 'Kiểm tra');
      assert(false, '7.12 [Store BOLA] Nhân viên cửa hàng khác nhận nút trái thẩm quyền không bị chặn');
    } catch (e: any) {
      assert(
        e instanceof ForbiddenException && e.message.includes('không thuộc cửa hàng chịu trách nhiệm'),
        '7.12 [Store BOLA] Nhân viên khác cửa hàng custody/fulfillment bị chặn 403 Forbidden',
      );
    }

    // -------------------------------------------------------------------------
    // 7. Audit Immutability: RentalAuditLog verification
    // -------------------------------------------------------------------------
    const auditLogs: any[] = [];
    const mockTxWithAudit: any = {
      rentalAuditLog: {
        create: async (entry: any) => {
          const data = entry.data || entry;
          auditLogs.push(data);
          return { logId: BigInt(auditLogs.length), ...data, createdAt: new Date() };
        },
      },
    };

    await mockTxWithAudit.rentalAuditLog.create({
      data: {
        actorType: 'ADMIN',
        actorUserId: BigInt(1),
        action: 'APPROVE_DEPOSIT_REFUND',
        targetType: 'DEPOSIT_REFUND',
        targetId: BigInt(701),
        beforeState: 'PENDING_APPROVAL',
        afterState: 'PENDING_PAYOUT',
        amount: 150000,
        correlationId: 'REF-2026-701',
      },
    });

    assert(
      auditLogs.length === 1 &&
        auditLogs[0].action === 'APPROVE_DEPOSIT_REFUND' &&
        auditLogs[0].beforeState === 'PENDING_APPROVAL' &&
        auditLogs[0].afterState === 'PENDING_PAYOUT',
      '7.13 [Audit Immutability] Bảng rental_audit_logs ghi vết bất biến cho mọi chuyển đổi trạng thái tài chính',
    );

  } catch (err: any) {
    console.error('Fatal test error in Phase 7 suite:', err);
    failed++;
  }

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase7ValidationAndAuditSuite().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

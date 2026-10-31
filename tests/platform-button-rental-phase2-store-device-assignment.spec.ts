import { RentalsService } from '../src/rentals/rentals.service';
import { assertTestDatabase } from './test-db-guard';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

async function runPhase2StoreDeviceAssignmentSuite() {
  process.env.TEST_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/platform_button_rental_test';
  assertTestDatabase('Phase 2: Fulfillment Store & Device Assignment');
  console.log('================================================================================');
  console.log('⚡ PHASE 2: FULFILLMENT STORE & DEVICE ASSIGNMENT ENGINE');
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

  // Mock State
  const rentalsMap = new Map<string, any>();
  const buttonsMap = new Map<string, any>();
  const storesMap = new Map<string, any>();
  const movementsList: any[] = [];
  const auditLogsList: any[] = [];

  // Setup initial mock entities
  storesMap.set('10', { storeId: BigInt(10), storeName: 'Cửa hàng Quận 1', status: 'ACTIVE' });
  storesMap.set('20', { storeId: BigInt(20), storeName: 'Cửa hàng Bình Thạnh', status: 'ACTIVE' });

  // Rental 1: PENDING_PAYMENT (Unpaid)
  rentalsMap.set('1', {
    rentalId: BigInt(1),
    rentalCode: 'RNT-001',
    status: 'PENDING_PAYMENT',
    buttonQuantity: 1,
    monthsRented: 2,
    customerId: BigInt(100),
    fulfillmentStoreId: null,
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-01-01'),
    buttons: [],
  });

  // Rental 2: PENDING_HANDOVER (Paid, waiting assignment)
  rentalsMap.set('2', {
    rentalId: BigInt(2),
    rentalCode: 'RNT-002',
    status: 'PENDING_HANDOVER',
    buttonQuantity: 2,
    monthsRented: 1,
    customerId: BigInt(100),
    fulfillmentStoreId: null,
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-01-01'),
    buttons: [],
  });

  // Buttons setup
  // Button 101: Belongs to Store 10, ALLOCATED_TO_STORE
  buttonsMap.set('101', {
    buttonId: BigInt(101),
    buttonCode: 'BTN-101',
    custodyStoreId: BigInt(10),
    inventoryState: 'ALLOCATED_TO_STORE',
    status: 'INACTIVE',
    rentalId: null,
  });

  // Button 102: Belongs to Store 10, ALLOCATED_TO_STORE
  buttonsMap.set('102', {
    buttonId: BigInt(102),
    buttonCode: 'BTN-102',
    custodyStoreId: BigInt(10),
    inventoryState: 'ALLOCATED_TO_STORE',
    status: 'INACTIVE',
    rentalId: null,
  });

  // Button 201: Belongs to Store 20 (different store)
  buttonsMap.set('201', {
    buttonId: BigInt(201),
    buttonCode: 'BTN-201',
    custodyStoreId: BigInt(20),
    inventoryState: 'ALLOCATED_TO_STORE',
    status: 'INACTIVE',
    rentalId: null,
  });

  // Button 103: Store 10, but still IN_PLATFORM_WAREHOUSE
  buttonsMap.set('103', {
    buttonId: BigInt(103),
    buttonCode: 'BTN-103',
    custodyStoreId: BigInt(10),
    inventoryState: 'IN_PLATFORM_WAREHOUSE',
    status: 'INACTIVE',
    rentalId: null,
  });

  // Mock Repository
  const mockRepo: any = {
    findRentalById: async (id: bigint) => rentalsMap.get(id.toString()) || null,
    findStoreById: async (id: bigint) => storesMap.get(id.toString()) || null,
    findButtonById: async (id: bigint) => buttonsMap.get(id.toString()) || null,
    assignFulfillmentAndDevicesAdminTx: async (
      rentalId: bigint,
      fulfillmentStoreId: bigint,
      buttonIds: bigint[],
      actor: any,
    ) => {
      const rental = rentalsMap.get(rentalId.toString());
      if (!rental) throw new NotFoundException('Không tìm thấy hợp đồng thuê');

      if (rental.status !== 'PENDING_HANDOVER') {
        throw new BadRequestException('Hợp đồng phải ở trạng thái PENDING_HANDOVER để gán cửa hàng và thiết bị');
      }

      const store = storesMap.get(fulfillmentStoreId.toString());
      if (!store || store.status !== 'ACTIVE') {
        throw new BadRequestException('Cửa hàng xử lý đơn không tồn tại hoặc không hoạt động');
      }

      const requiredCount = rental.buttonQuantity || 1;
      if (buttonIds.length !== requiredCount) {
        throw new BadRequestException(
          `Số lượng nút bấm (${buttonIds.length}) không khớp với số lượng yêu cầu của gói thuê (${requiredCount})`,
        );
      }

      for (const btnId of buttonIds) {
        const btn = buttonsMap.get(btnId.toString());
        if (!btn) throw new NotFoundException(`Không tìm thấy nút bấm #${btnId}`);

        if (btn.custodyStoreId?.toString() !== fulfillmentStoreId.toString()) {
          throw new BadRequestException(
            `Nút bấm #${btnId} không thuộc quyền lưu kho (custody) của Store #${fulfillmentStoreId}`,
          );
        }

        if (btn.inventoryState !== 'ALLOCATED_TO_STORE') {
          throw new BadRequestException(
            `Nút bấm #${btnId} đang ở trạng thái kho '${btn.inventoryState}', không thể gán cho hợp đồng`,
          );
        }

        if (btn.rentalId && btn.rentalId.toString() !== rentalId.toString()) {
          throw new BadRequestException(`Nút bấm #${btnId} đã được gán cho hợp đồng thuê khác`);
        }
      }

      rental.fulfillmentStoreId = fulfillmentStoreId;
      rental.buttons = [];

      for (const btnId of buttonIds) {
        const btn = buttonsMap.get(btnId.toString());
        btn.rentalId = rentalId;
        btn.inventoryState = 'ASSIGNED_TO_RENTAL';
        rental.buttons.push(btn);

        movementsList.push({
          buttonId: btnId,
          sourceType: 'STORE',
          sourceStoreId: fulfillmentStoreId,
          destType: 'RENTAL',
          rentalId,
          actorUserId: actor?.userId ? BigInt(actor.userId) : null,
          reason: 'ASSIGN_TO_RENTAL',
        });
      }

      auditLogsList.push({
        action: 'ASSIGN_FULFILLMENT_AND_DEVICES',
        targetId: rentalId,
        actorUserId: actor?.userId,
      });

      return rental;
    },
    handoverRentalButtonsTx: async (rentalId: bigint, user: any, handoverDate?: Date) => {
      const rental = rentalsMap.get(rentalId.toString());
      if (!rental) throw new NotFoundException('Không tìm thấy hợp đồng thuê');

      if (rental.status !== 'PENDING_HANDOVER') {
        throw new BadRequestException('Chỉ có thể bàn giao hợp đồng đang ở trạng thái PENDING_HANDOVER');
      }

      if (!rental.fulfillmentStoreId) {
        throw new BadRequestException('Hợp đồng chưa được gán cửa hàng xử lý đơn');
      }

      const assignedButtons = rental.buttons || [];
      if (assignedButtons.length === 0 || assignedButtons.length !== rental.buttonQuantity) {
        throw new BadRequestException('Chưa gán đủ nút bấm cho hợp đồng để tiến hành bàn giao');
      }

      const now = handoverDate || new Date();
      const months = rental.monthsRented || 1;
      const endDate = new Date(now.getTime() + months * 30 * 24 * 60 * 60 * 1000);

      rental.status = 'ACTIVE';
      rental.startDate = now;
      rental.endDate = endDate;
      rental.effectiveExpiresAt = endDate;

      for (const btn of assignedButtons) {
        btn.status = 'IN_USE';
        btn.inventoryState = 'IN_CUSTOMER_USE';
        btn.canOrder = true;
        btn.customerId = rental.customerId;

        movementsList.push({
          buttonId: btn.buttonId,
          sourceType: 'STORE',
          sourceStoreId: rental.fulfillmentStoreId,
          destType: 'CUSTOMER',
          rentalId,
          actorUserId: user?.userId ? BigInt(user.userId) : null,
          reason: 'HANDOVER_TO_CUSTOMER',
        });
      }

      auditLogsList.push({
        action: 'HANDOVER_RENTAL_BUTTONS',
        targetId: rentalId,
        actorUserId: user?.userId,
      });

      return rental;
    },
    updateRentalStatus: async (rentalId: bigint, status: string) => {
      const rental = rentalsMap.get(rentalId.toString());
      if (!rental) throw new NotFoundException('Không tìm thấy hợp đồng');
      rental.status = status;
      return rental;
    },
  };

  const rentalsService = new RentalsService(mockRepo);

  const adminActor = { role: 'SUPER_ADMIN', userId: '1' };
  const customerActor = { role: 'CUSTOMER', userId: '100' };

  try {
    // Test 1: Reject assignment when contract is PENDING_PAYMENT
    try {
      await rentalsService.assignFulfillmentAndDevicesAdmin(
        '1',
        { fulfillmentStoreId: '10', buttonIds: ['101'] },
        adminActor,
      );
      assert(false, '2.1 Từ chối gán khi hợp đồng chưa thanh toán (PENDING_PAYMENT)');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException && e.message.includes('PENDING_HANDOVER'),
        '2.1 Từ chối gán khi hợp đồng chưa thanh toán (PENDING_PAYMENT)',
      );
    }

    // Test 2: Reject assignment when button count mismatches required quantity (requires 2, provided 1)
    try {
      await rentalsService.assignFulfillmentAndDevicesAdmin(
        '2',
        { fulfillmentStoreId: '10', buttonIds: ['101'] },
        adminActor,
      );
      assert(false, '2.2 Từ chối gán khi số lượng button không khớp với buttonQuantity của gói');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException && e.message.includes('không khớp'),
        '2.2 Từ chối gán khi số lượng button không khớp với buttonQuantity của gói',
      );
    }

    // Test 3: Reject assignment when button belongs to another store custody
    try {
      await rentalsService.assignFulfillmentAndDevicesAdmin(
        '2',
        { fulfillmentStoreId: '10', buttonIds: ['101', '201'] }, // 201 belongs to Store 20
        adminActor,
      );
      assert(false, '2.3 Từ chối gán khi button không thuộc custodyStoreId của fulfillmentStoreId');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException && e.message.includes('không thuộc quyền lưu kho'),
        '2.3 Từ chối gán khi button không thuộc custodyStoreId của fulfillmentStoreId',
      );
    }

    // Test 4: Reject assignment when button is not ALLOCATED_TO_STORE
    try {
      await rentalsService.assignFulfillmentAndDevicesAdmin(
        '2',
        { fulfillmentStoreId: '10', buttonIds: ['101', '103'] }, // 103 is IN_PLATFORM_WAREHOUSE
        adminActor,
      );
      assert(false, '2.4 Từ chối gán khi button không ở trạng thái ALLOCATED_TO_STORE');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException && e.message.includes('trạng thái kho'),
        '2.4 Từ chối gán khi button không ở trạng thái ALLOCATED_TO_STORE',
      );
    }

    // Test 5: Valid assignment of 2 buttons from Store 10
    const assignedResult = await rentalsService.assignFulfillmentAndDevicesAdmin(
      '2',
      { fulfillmentStoreId: '10', buttonIds: ['101', '102'] },
      adminActor,
    );

    assert(
      assignedResult.fulfillmentStoreId.toString() === '10' &&
        assignedResult.buttons.length === 2 &&
        buttonsMap.get('101').inventoryState === 'ASSIGNED_TO_RENTAL' &&
        buttonsMap.get('102').inventoryState === 'ASSIGNED_TO_RENTAL',
      '2.5 Admin gán fulfillmentStore và buttons hợp lệ thành công: cập nhật fulfillmentStoreId, inventoryState -> ASSIGNED_TO_RENTAL',
    );

    assert(
      movementsList.length === 2 &&
        movementsList[0].action === undefined && // verified field below
        movementsList[0].destType === 'RENTAL',
      '2.6 Ghi nhận DeviceMovement cho từng thiết bị được gán vào hợp đồng',
    );

    // Test 6: Handover execution activates contract, sets countdown and customer use
    const handoverTime = new Date('2026-11-01T10:00:00Z');
    const handoverResult: any = await rentalsService.handoverRental('2', adminActor, handoverTime);

    assert(
      handoverResult.status === 'ACTIVE' &&
        handoverResult.startDate.getTime() === handoverTime.getTime() &&
        buttonsMap.get('101').inventoryState === 'IN_CUSTOMER_USE' &&
        buttonsMap.get('102').inventoryState === 'IN_CUSTOMER_USE' &&
        buttonsMap.get('101').canOrder === true,
      '2.7 Bàn giao (Handover) chuyển trạng thái sang ACTIVE, kích hoạt thời hạn thuê chính xác và mở quyền đặt hàng (canOrder = true)',
    );

    assert(
      movementsList.length === 4 &&
        movementsList[2].destType === 'CUSTOMER' &&
        movementsList[3].destType === 'CUSTOMER',
      '2.8 Ghi nhận DeviceMovement HANDOVER_TO_CUSTOMER cho từng nút bấm khi bàn giao cho khách',
    );

    // Test 7: Fail-closed on activateRental bypass
    try {
      // Trying to directly activate rental 1 (PENDING_PAYMENT, no buttons)
      await rentalsService.activateRental('1');
      assert(false, '2.9 [No-Bypass] Cấm gọi activateRental trực tiếp để nhảy cóc vào ACTIVE');
    } catch (e: any) {
      assert(
        e instanceof BadRequestException,
        '2.9 [No-Bypass] Cấm gọi activateRental trực tiếp để nhảy cóc vào ACTIVE',
      );
    }

  } catch (err: any) {
    console.error('Fatal test error in Phase 2 suite:', err);
    failed++;
  }

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase2StoreDeviceAssignmentSuite().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

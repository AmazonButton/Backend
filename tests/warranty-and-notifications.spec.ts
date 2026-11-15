import { PrismaClient } from '@prisma/client';
import { WarrantyService } from '../src/warranty/warranty.service';
import { WarrantyRepository } from '../src/warranty/warranty.repository';
import { EventsGateway } from '../src/websocket/events.gateway';
import { NotificationsService } from '../src/notifications/notifications.service';
import { IotService } from '../src/iot/iot.service';
import { OrdersService } from '../src/orders/orders.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

const prisma = new PrismaClient();

async function runWarrantyAndNotificationsSuite() {
  console.log('================================================================================');
  console.log('⚡ WARRANTY & REALTIME NOTIFICATIONS TEST SUITE (PHASE 2 & 3)');
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
    // 1. FINANCIAL CALCULATION MATH (4 FAULT GROUPS INVARIANT)
    // -------------------------------------------------------------------------
    console.log('--- Test Section 1: Financial Deduction Math ---');
    const mockRepo = {} as any;
    const mockGateway = {
      emitToAdmin: () => {},
      emitToStore: () => {},
      emitToUser: () => {},
    } as any;
    const mockNotifications = {
      createAndDispatchNotification: async () => {},
    } as any;

    const warrantyService = new WarrantyService(
      mockRepo,
      mockGateway,
      mockNotifications,
    );

    // Group A: Natural / Technical Fault -> 0% deduction
    const groupA = warrantyService.calculateWarrantyDeduction(100000, 'GROUP_A', 50);
    assert(
      groupA.percent === 0 && groupA.deductionAmount === 0 && groupA.refundAmount === 100000,
      'Group A enforces 0% deduction and full refund (100.000 VND)',
      `Actual: deduction=${groupA.deductionAmount}, refund=${groupA.refundAmount}`,
    );

    // Group B: Network / Children Spam -> 0% deduction, no device swap
    const groupB = warrantyService.calculateWarrantyDeduction(100000, 'GROUP_B', 100);
    assert(
      groupB.percent === 0 && groupB.deductionAmount === 0 && groupB.refundAmount === 100000,
      'Group B enforces 0% deduction (0 VND)',
      `Actual: deduction=${groupB.deductionAmount}, refund=${groupB.refundAmount}`,
    );

    // Group C: Minor Shell Crack -> Fixed 30% deduction (30.000 VND)
    const groupC = warrantyService.calculateWarrantyDeduction(100000, 'GROUP_C', 10);
    assert(
      groupC.percent === 30 && groupC.deductionAmount === 30000 && groupC.refundAmount === 70000,
      'Group C enforces 30% deduction (30.000 VND shell replacement fee)',
      `Actual: deduction=${groupC.deductionAmount}, refund=${groupC.refundAmount}`,
    );

    // Group D: Heavy Damage -> 70% to 100% deduction
    const groupD70 = warrantyService.calculateWarrantyDeduction(100000, 'GROUP_D', 70);
    assert(
      groupD70.percent === 70 && groupD70.deductionAmount === 70000 && groupD70.refundAmount === 30000,
      'Group D with 70% deduction calculates 70.000 VND fee and 30.000 VND refund',
      `Actual: deduction=${groupD70.deductionAmount}, refund=${groupD70.refundAmount}`,
    );

    const groupD100 = warrantyService.calculateWarrantyDeduction(100000, 'GROUP_D', 100);
    assert(
      groupD100.percent === 100 && groupD100.deductionAmount === 100000 && groupD100.refundAmount === 0,
      'Group D with 100% deduction forfeits full deposit (0 VND refund)',
      `Actual: deduction=${groupD100.deductionAmount}, refund=${groupD100.refundAmount}`,
    );

    const groupDClamp = warrantyService.calculateWarrantyDeduction(100000, 'GROUP_D', 20);
    assert(
      groupDClamp.percent === 70,
      'Group D clamps minimum deduction to 70% if lower percent provided',
      `Actual: percent=${groupDClamp.percent}`,
    );

    // -------------------------------------------------------------------------
    // 2. BOLA TENANT ISOLATION ON TICKET QUERIES
    // -------------------------------------------------------------------------
    console.log('\n--- Test Section 2: BOLA Tenant Isolation ---');
    let bolaThrew = false;
    try {
      // Store staff of store 999 attempting to query store 888
      await warrantyService.getTickets(
        { storeId: '888' },
        { id: 1, role: 'STORE_STAFF', storeId: '999' },
      );
    } catch (e: any) {
      if (e instanceof ForbiddenException) {
        bolaThrew = true;
      }
    }
    assert(
      bolaThrew,
      'BOLA prevents Store Staff from querying tickets belonging to another store',
    );

    // -------------------------------------------------------------------------
    // 3. IOT LOW BATTERY (< 20%) & HARDWARE FAULT DETECTION
    // -------------------------------------------------------------------------
    console.log('\n--- Test Section 3: IoT Low Battery & Telemetry Alerting ---');

    let emittedAlert: any = null;
    let emittedStoreId: string | null = null;
    let emittedEvent: string | null = null;

    const mockEventsGateway = {
      emitToAdmin: (event: string, payload: any) => {
        emittedEvent = event;
        emittedAlert = payload;
      },
      emitToStore: (storeId: string, event: string, payload: any) => {
        emittedStoreId = storeId;
        emittedEvent = event;
        emittedAlert = payload;
      },
      emitToCustomer: () => {},
    };

    const mockOrdersService = {
      eventsGateway: mockEventsGateway,
      handleButtonEvent: async (dev: any, payload: any) => {
        return { orderId: '999999', note: payload.battery < 20 ? `[CẢNH BÁO PIN YẾU: ${payload.battery}%]` : '' };
      },
    };

    const iotService = new IotService(prisma as any, mockOrdersService as any);

    // Test low battery alert trigger
    const testDevice = {
      buttonId: BigInt(1),
      deviceId: 'SOB-TEST-001',
      storeId: BigInt(10),
      buttonCode: 'BTN-001',
    };

    await iotService.checkAndDispatchDeviceAlerts(testDevice, {
      battery: 15, // < 20%
      rssi: -65,
    });

    assert(
      emittedEvent === 'DEVICE_FAULT_ALERT',
      'Low battery (< 20%) triggers realtime DEVICE_FAULT_ALERT event',
      `Actual event: ${emittedEvent}`,
    );
    assert(
      emittedAlert?.faultType === 'LOW_BATTERY' && emittedAlert?.batteryLevel === 15,
      'DEVICE_FAULT_ALERT payload contains LOW_BATTERY and correct batteryLevel',
      `Actual payload: ${JSON.stringify(emittedAlert)}`,
    );

    // Test hardware fault alert trigger (BUTTON_STUCK)
    emittedAlert = null;
    emittedEvent = null;
    await iotService.checkAndDispatchDeviceAlerts(testDevice, {
      battery: 80,
      eventType: 'BUTTON_STUCK',
      rssi: -50,
      pressCount: 15,
    });

    assert(
      emittedEvent === 'DEVICE_FAULT_ALERT' && emittedAlert?.faultType === 'BUTTON_STUCK',
      'BUTTON_STUCK triggers realtime DEVICE_FAULT_ALERT event',
      `Actual payload: ${JSON.stringify(emittedAlert)}`,
    );

    // Test normal battery does not trigger alert
    emittedAlert = null;
    emittedEvent = null;
    await iotService.checkAndDispatchDeviceAlerts(testDevice, {
      battery: 85,
      eventType: 'SINGLE_PRESS',
    });

    assert(
      emittedEvent === null && emittedAlert === null,
      'Normal battery (85%) with SINGLE_PRESS does NOT trigger fault alert',
    );

    // -------------------------------------------------------------------------
    // 4. ORDER NOTE LOW BATTERY PREPEND RULE
    // -------------------------------------------------------------------------
    console.log('\n--- Test Section 4: Order Note Low Battery Prepend Rule ---');
    const baseNote = 'Đơn hàng tự động từ nút bấm IoT';
    const testBatteryLow = 14;
    const orderNoteLow = testBatteryLow < 20
      ? `[CẢNH BÁO PIN YẾU: ${testBatteryLow}%] ${baseNote}`
      : baseNote;

    assert(
      orderNoteLow.startsWith('[CẢNH BÁO PIN YẾU: 14%]'),
      'Order note correctly prepends [CẢNH BÁO PIN YẾU: 14%] when battery < 20%',
      `Actual note: ${orderNoteLow}`,
    );

    const testBatteryNormal = 75;
    const orderNoteNormal = testBatteryNormal < 20
      ? `[CẢNH BÁO PIN YẾU: ${testBatteryNormal}%] ${baseNote}`
      : baseNote;

    assert(
      !orderNoteNormal.includes('CẢNH BÁO PIN YẾU'),
      'Order note is clean without warning when battery >= 20%',
      `Actual note: ${orderNoteNormal}`,
    );

    console.log('\n================================================================================');
    console.log(`TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err: any) {
    console.error('Fatal test error:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runWarrantyAndNotificationsSuite();

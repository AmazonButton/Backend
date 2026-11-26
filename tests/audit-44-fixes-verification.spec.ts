import * as assert from 'node:assert';
import 'dotenv/config';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { getSafeTestPrismaClient } from './test-db-guard';
import { StoreMeResponseDto } from '../src/stores/dto/store-me-response.dto';
import { CryptoService } from '../src/security/crypto.service';
import { IotService } from '../src/iot/iot.service';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersRepository } from '../src/orders/orders.repository';
import { StoreWalletRepository } from '../src/store-wallet/store-wallet.repository';
import { CustomersRepository } from '../src/customers/customers.repository';
import { AdminService } from '../src/admin/admin.service';
import { BillingChargesService } from '../src/billing-charges/billing-charges.service';
import { settleRentalRenewalInTx } from '../src/rentals/rental-renewal.transaction';
import { PayOSBankVerificationProvider } from '../src/bank-verification/providers/payos-bank-verification.provider';
import { PayOSPayoutPreDispatchException } from '../src/payments/payos-payout.service';
import { extractTrustedClientIp } from '../src/common/utils/client-ip.util';
import { AuthRateLimitGuard } from '../src/auth/guards/auth-rate-limit.guard';
import { DevicesService } from '../src/devices/devices.service';
import { IotTelemetryDto } from '../src/iot/dto/iot-telemetry.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✔ [PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✘ [FAIL] ${name}: ${err?.message || err}`);
    failed++;
  }
}

async function run() {
  console.log('\n=== AUDIT 44 FIXES REGRESSION & DB CONSTRAINT SUITE ===\n');

  await test('1. StoreMeResponseDto treats OWNERSHIP_VERIFIED as isVerified = true', () => {
    const dto = StoreMeResponseDto.fromEntity(
      {
        storeId: 1n,
        name: 'Test Store',
        code: 'TS01',
        phone: '0900000001',
        address: '1 Test St',
        status: 'ACTIVE',
        ownerUserId: 10n,
        owner: { userId: 10n, fullName: 'Owner', email: 'o@test.local' },
        bankAccounts: [{ verificationStatus: 'OWNERSHIP_VERIFIED', isDefault: true }],
        subscriptions: [],
      },
      'STORE_OWNER',
    );
    assert.strictEqual(dto.bankVerification.status, 'OWNERSHIP_VERIFIED');
    assert.strictEqual(dto.bankVerification.isVerified, true);
  });

  await test('2. CryptoService.safeCompare rejects odd-length / non-hex digests without silent truncation', () => {
    const cryptoSvc = new CryptoService();
    const validHex = 'a'.repeat(64);
    assert.strictEqual(cryptoSvc.safeCompare(validHex, validHex), true);
    assert.strictEqual(cryptoSvc.safeCompare('abc', 'abc'), false);
    assert.strictEqual(cryptoSvc.safeCompare('zzzz', 'zzzz'), false);
    assert.strictEqual(cryptoSvc.safeCompare('', ''), false);
  });

  await test('3. IotService HEARTBEAT does not trigger cooldown or leak inFlightRequests', async () => {
    let handleCount = 0;
    const mockOrdersSvc: any = {
      eventsGateway: { emitToStore: () => {}, emitToCustomer: () => {} },
      handleButtonEvent: async () => {
        handleCount++;
        return { order: { orderId: 101n } };
      },
    };
    const mockPrisma: any = {
      $queryRawUnsafe: async () => [{ id: 1n, status: 'PROCESSING', lease_token: 't' }],
      $executeRawUnsafe: async () => 1,
    };
    const iotSvc = new IotService(mockPrisma, mockOrdersSvc);
    const device = { buttonId: 10n, deviceId: 'DEV_HB_1', storeId: 1n, customerId: 2n };

    const hbRes = await iotSvc.handleEvent(device, { eventType: 'HEARTBEAT', requestId: 'hb_1' });
    assert.strictEqual(hbRes.code, 'DEVICE_HEARTBEAT_ACK');
    assert.strictEqual(iotSvc.inFlightRequests.size, 0, 'inFlightRequests must be empty after HEARTBEAT');

    const pressRes = await iotSvc.handleEvent(device, { eventType: 'SINGLE_PRESS', requestId: 'press_1' });
    assert.strictEqual(pressRes.success, true);
    assert.strictEqual(handleCount, 1);
    assert.strictEqual(iotSvc.inFlightRequests.size, 0, 'inFlightRequests must be cleaned up after SINGLE_PRESS');
  });

  await test('4. OrdersService.createStorefrontOrder blocks guest PAYOS while allowing guest COD', async () => {
    let createdMethod = '';
    const mockOrdersRepo: any = {
      createStorefrontOrderTx: async (p: any) => {
        createdMethod = p.paymentMethod;
        return {
          orderId: 55n,
          orderCode: 'WEB-55',
          storeId: p.storeId,
          totalAmount: 10000,
          subtotalAmount: 10000,
          shippingFee: 0,
          orderStatus: 'PENDING',
          paymentStatus: 'UNPAID',
          paymentMethod: p.paymentMethod,
          shippingRecipientName: p.customerName,
          shippingPhone: p.customerPhone,
          shippingAddress: p.deliveryAddress,
          items: [],
        };
      },
    };
    const ordersSvc = new OrdersService(mockOrdersRepo, undefined, undefined, undefined, undefined);

    await assert.rejects(
      () =>
        ordersSvc.createStorefrontOrder({
          storeId: '1',
          items: [{ productId: '1', quantity: 1 }],
          customerName: 'Guest',
          customerPhone: '0901234567',
          deliveryAddress: '123 St',
          paymentMethod: 'PAYOS',
        }),
      (err: any) => err instanceof ForbiddenException,
    );

    await ordersSvc.createStorefrontOrder({
      storeId: '1',
      items: [{ productId: '1', quantity: 1 }],
      customerName: 'Guest',
      customerPhone: '0901234567',
      deliveryAddress: '123 St',
      paymentMethod: 'COD',
    });
    assert.strictEqual(createdMethod, 'COD');
  });

  await test('5. OrdersService.getPodViewUrl BOLA check uses customer.userId & rejects stranger', async () => {
    const mockRepo: any = {
      findOrderById: async () => ({
        orderId: 99n,
        storeId: 1n,
        customerId: 500n,
        customer: { userId: 777n },
        podImageUrl: 'https://cdn.example.com/pod.webp',
      }),
    };
    const svc = new OrdersService(mockRepo, undefined, undefined, undefined, undefined);
    const ok = await svc.getPodViewUrl('99', { role: 'CUSTOMER', userId: '777', customerProfileId: '500' });
    assert.strictEqual(ok.orderId, '99');

    await assert.rejects(
      () => svc.getPodViewUrl('99', { role: 'CUSTOMER', userId: '500', customerProfileId: '999' }),
      (err: any) => err instanceof ForbiddenException,
    );
  });

  await test('6. OrdersRepository.completeDeliveryAtomicTx does not add PAYOS to total_vietqr_collected', async () => {
    let shiftVietqrRecorded = -1;
    let walletCredited = false;
    const mockTx: any = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM orders') && sql.includes('FOR UPDATE')) {
          return [
            {
              order_id: 10n,
              order_code: 'ORD-10',
              store_id: 5n,
              customer_id: 2n,
              order_status: 'SHIPPING',
              payment_status: 'PAID',
              payment_method: 'PAYOS',
              total_amount: 50000,
              net_amount: 46000,
              assigned_driver_id: 99n,
            },
          ];
        }
        if (sql.includes('FROM store WHERE')) return [{ owner_user_id: 99n }];
        if (sql.includes('FROM store_wallets')) return [{ wallet_id: 1n, store_id: 5n, balance: '0' }];
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: any[]) => {
        if (sql.includes('UPDATE driver_shifts')) {
          shiftVietqrRecorded = Number(args[1]);
        }
        return 1;
      },
      orderStatusHistory: { findFirst: async () => ({ historyId: 1n }), create: async () => ({}) },
      paymentTransaction: { findFirst: async () => ({ paymentTransactionId: 1n, status: 'PAID' }) },
      walletTransaction: {
        findFirst: async () => null,
        create: async () => {
          walletCredited = true;
          return {};
        },
      },
      storeWallet: { update: async () => ({}) },
      order: { update: async () => ({}) },
      outboxEvent: { create: async () => ({}) },
    };
    const mockPrisma: any = { $transaction: async (fn: any) => fn(mockTx) };
    const repo = new OrdersRepository(mockPrisma);
    (repo as any).findOrderByIdTx = async () => ({ orderId: 10n, storeId: 5n });

    await repo.completeDeliveryAtomicTx(10n, { userId: 99n, role: 'STORE_OWNER', storeId: 5n }, {
      status: 'DELIVERED',
      paymentMethod: 'PAYOS',
      podObjectKey: 'stores/5/pod/a.webp',
    });

    assert.strictEqual(shiftVietqrRecorded, 0, 'Online PAYOS order must not increment driver total_vietqr_collected');
    assert.strictEqual(walletCredited, true, 'PAYOS order must credit store wallet upon delivery');
  });

  await test('7. StoreWalletRepository preserves existing OWNERSHIP_VERIFIED default when saving new PENDING account', async () => {
    let demoteCalled = false;
    let savedDefault: boolean | undefined;
    const mockTx: any = {
      $queryRaw: async () => [{ store_id: 1n }],
      storeBankAccount: {
        updateMany: async () => {
          demoteCalled = true;
          return { count: 1 };
        },
        findUnique: async () => null,
        findFirst: async () => ({
          id: 1n,
          accountNumberHash: 'verified_hash',
          verificationStatus: 'OWNERSHIP_VERIFIED',
          isDefault: true,
        }),
        upsert: async ({ create }: any) => {
          savedDefault = create.isDefault;
          return { id: 2n, ...create };
        },
      },
      storeWallet: {
        findUniqueOrThrow: async () => ({ walletId: 1n, storeId: 1n, balance: '100000' }),
        update: async () => ({ walletId: 1n }),
      },
    };
    const repo = new StoreWalletRepository({ $transaction: async (fn: any) => fn(mockTx) } as any);
    await repo.updateBankAccountAtomicTx({
      storeId: 1n,
      bankBin: '970422',
      bankName: 'MB',
      bankAccountHolder: 'NEW HOLDER',
      accountNumberHash: 'new_pending_hash',
      accountNumberEncrypted: 'enc',
      cleanAcc: '123456789',
    });
    assert.strictEqual(demoteCalled, false, 'Existing OWNERSHIP_VERIFIED default must NOT be demoted for unverified account');
    assert.strictEqual(savedDefault, false, 'New PENDING account must have isDefault = false while verified default exists');
  });

  await test('8. CustomersRepository maps P2002 to ConflictException & preserves VERIFIED default', async () => {
    let demoted = false;
    const mockTx: any = {
      $queryRaw: async () => [{ customer_id: 1n }],
      customerBankAccount: {
        findFirst: async () => ({ id: 10n, isDefault: true, verificationStatus: 'VERIFIED' }),
        updateMany: async () => {
          demoted = true;
          return { count: 1 };
        },
        create: async () => {
          const err: any = new Error('Unique violation');
          err.code = 'P2002';
          throw err;
        },
      },
    };
    const repo = new CustomersRepository({ $transaction: async (fn: any) => fn(mockTx) } as any);
    await assert.rejects(
      () =>
        repo.createCustomerBankAccount({
          customerId: 1n,
          bankBin: '970422',
          bankName: 'MB',
          accountNumberEncrypted: 'e',
          accountNumberHash: 'h',
          accountNumberMasked: '***',
          accountName: 'TEST',
          isDefault: true,
        }),
      (err: any) => err instanceof ConflictException,
    );
    assert.strictEqual(demoted, false);
  });

  await test('9. AdminService enforces rejectStore reason/PENDING and blocks self-disable', async () => {
    const adminSvc = new AdminService({
      findStoreById: async () => ({ storeId: 1n, status: 'ACTIVE' }),
      findUserById: async () => ({ userId: 1n, status: 'ACTIVE' }),
    } as any);

    await assert.rejects(
      () => adminSvc.rejectStore('1', '   '),
      (err: any) => err instanceof BadRequestException,
    );
    await assert.rejects(
      () => adminSvc.rejectStore('1', 'Invalid docs'),
      (err: any) => err instanceof BadRequestException,
    );
    await assert.rejects(
      () => adminSvc.toggleUserStatus('1', 'INACTIVE', { userId: '1' }),
      (err: any) => err instanceof ForbiddenException,
    );
  });

  await test('10. BillingChargesService blocks payment link creation for CANCELLED charge', async () => {
    const billingSvc = new BillingChargesService({
      findChargeById: async () => ({
        chargeId: 5n,
        status: 'CANCELLED',
        purpose: 'RENTAL_INITIAL',
        targetId: 1n,
        rental: { customer: { userId: 2n } },
      }),
    } as any);

    await assert.rejects(
      () => billingSvc.createPayosPaymentRequestForCharge(5n, { role: 'SUPER_ADMIN', userId: '1' }),
      (err: any) => err instanceof BadRequestException,
    );
  });

  await test('11. PayOSBankVerificationProvider rethrows PayOSPayoutPreDispatchException', async () => {
    const provider = new PayOSBankVerificationProvider({
      createPayout: async () => {
        throw new PayOSPayoutPreDispatchException('HTTP_403', 'IP 403 forbidden');
      },
    } as any);
    await assert.rejects(
      () =>
        provider.createRefund({
          referenceId: 'SBV_TEST_1',
          amount: 2000,
          description: 'Refund',
          bankBin: '970422',
          accountNumber: '0123456789',
        }),
      (err: any) => err instanceof PayOSPayoutPreDispatchException,
    );
  });

  await test('12. settleRentalRenewalInTx preserves customer_child_lock (keeps canOrder=false)', async () => {
    let updatedCanOrder: boolean | null = null;
    const mockTx: any = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM iot_button')) {
          return [
            {
              button_id: 10n,
              customer_id: 5n,
              inventory_state: 'IN_CUSTOMER_CUSTODY',
              status: 'ACTIVE',
              customer_child_lock: true,
            },
          ];
        }
        return [
          {
            rental_id: 20n,
            customer_id: 5n,
            status: 'EXPIRED',
            billing_policy: 'LEGACY_CUSTOMER_RENT',
            monthly_rent_per_button_snapshot: 30000,
            pricing_review_required: false,
            billing_policy_review_required: false,
            button_quantity: 1,
            paid_through: null,
            effective_expires_at: null,
          },
        ];
      },
      rentalReturn: { findMany: async () => [] },
      billingChargeLine: {
        findMany: async () => [
          {
            lineType: 'RENT',
            quantity: 1,
            durationUnit: 'MONTH',
            durationCount: 1,
            amount: { eq: (v: any) => Number(v) === 30000 },
            unitPrice: { eq: (v: any) => Number(v) === 30000 },
          },
        ],
      },
      billingCharge: { updateMany: async () => ({ count: 1 }) },
      buttonRental: { update: async () => ({}) },
      ioTButton: {
        update: async ({ data }: any) => {
          updatedCanOrder = data.canOrder;
          return {};
        },
      },
      outboxEvent: { create: async () => ({}) },
      rentalAuditLog: { create: async () => ({}) },
    };
    const ok = await settleRentalRenewalInTx(
      mockTx,
      { charge_id: 1n, target_id: 20n, total_amount: 30000, payer_store_id: null },
      'PAY_REF',
    );
    assert.strictEqual(ok, true);
    assert.strictEqual(updatedCanOrder, false, 'customer_child_lock=true must keep canOrder=false on renewal');
  });

  if (process.env.TEST_DATABASE_URL) {
    const prisma: PrismaClient = getSafeTestPrismaClient('Audit44FixesVerification');
    try {
      await test('13. [PostgreSQL] DB CHECK constraints enforce custody & overpayment status invariants', async () => {
        const res = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
          `SELECT conname FROM pg_constraint WHERE conname IN (
             'chk_rental_deposits_conservation',
             'chk_iot_button_customer_custody_no_store',
             'ck_billing_overpayment_status'
           )`,
        );
        const names = new Set(res.map((r) => r.conname));
        assert.ok(names.has('chk_rental_deposits_conservation'), 'Missing chk_rental_deposits_conservation');
        assert.ok(names.has('chk_iot_button_customer_custody_no_store'), 'Missing chk_iot_button_customer_custody_no_store');
        assert.ok(names.has('ck_billing_overpayment_status'), 'Missing ck_billing_overpayment_status');
      });
    } finally {
      await prisma.$disconnect();
    }
  }

  await test('14. extractTrustedClientIp unwraps Cloudflare Worker IP safely while rejecting direct spoofed XFF', () => {
    const viaWorker = extractTrustedClientIp({
      headers: {
        'cf-connecting-ip': '2a06:98c0:3600::103',
        'cf-worker': ' PTT ',
        'x-edge-client-ip': '203.113.10.99',
        'x-forwarded-for': '10.0.0.1',
      },
    });
    assert.strictEqual(viaWorker, '203.113.10.99');

    const directNoWorker = extractTrustedClientIp({
      headers: {
        'cf-connecting-ip': '118.69.12.34',
        'x-edge-client-ip': '1.2.3.4',
        'x-forwarded-for': '5.6.7.8',
      },
    });
    assert.strictEqual(directNoWorker, '118.69.12.34');
  });

  await test('15. AuthRateLimitGuard scopes login limits by (IP + account) and emits Retry-After', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const guard = new AuthRateLimitGuard();
      const responseHeaders: Record<string, string> = {};
      const makeCtx = (email: string) =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { 'cf-connecting-ip': '198.51.100.42' },
              route: { path: '/api/v1/auth/login' },
              body: { email },
            }),
            getResponse: () => ({
              setHeader: (k: string, v: string) => {
                responseHeaders[k] = v;
              },
            }),
          }),
        }) as any;

      const demoAccounts = [
        'customer@smartorder.local',
        'store@smartorder.local',
        'staff@smartorder.local',
        'admin@smartorder.local',
      ];
      // 4 logins on each of 3 accounts (12 > old 10/IP limit) should all pass
      for (const acct of demoAccounts.slice(0, 3)) {
        for (let i = 0; i < 4; i++) {
          assert.strictEqual(guard.canActivate(makeCtx(acct)), true);
        }
      }
      // 10 logins on the 4th account succeed, 11th throws 429 with Retry-After header
      for (let i = 0; i < 10; i++) {
        assert.strictEqual(guard.canActivate(makeCtx(demoAccounts[3])), true);
      }
      let thrown: any = null;
      try {
        guard.canActivate(makeCtx(demoAccounts[3]));
      } catch (e) {
        thrown = e;
      }
      assert.ok(thrown, '11th login on same account within 60s must throw 429');
      assert.strictEqual(thrown.getStatus(), 429);
      assert.ok(Number(responseHeaders['Retry-After']) >= 1, 'Must set Retry-After response header');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  await test('16. DevicesService.assertDeviceAccess stays read-only & claimViaBle delegates atomically without violating lookup BOLA', async () => {
    let repoUpdated = false;
    let bleClaimParams: any = null;
    const devSvc = new DevicesService(
      {
        findByIdentifier: async () => ({
          buttonId: 348n,
          deviceId: 'SOB-000052',
          buttonCode: 'SOB-000052',
          storeId: 1n,
          customerId: null,
          status: 'ACTIVE',
        }),
        update: async () => {
          repoUpdated = true;
          return {};
        },
        claimViaBleAtomicTx: async (params: any) => {
          bleClaimParams = params;
          return {
            buttonId: 348n,
            deviceId: 'SOB-000052',
            buttonCode: 'SOB-000052',
            storeId: 1n,
            custodyStoreId: null,
            customerId: params.customerId,
            inventoryState: 'IN_CUSTOMER_CUSTODY',
            status: 'ACTIVE',
            canOrder: true,
          };
        },
      } as any,
      undefined as any,
    );

    await assert.rejects(
      () => devSvc.getById('SOB-000052', { role: 'CUSTOMER', customerProfileId: '1' }),
      (err: any) => err instanceof ForbiddenException,
    );
    assert.strictEqual(repoUpdated, false, 'GET /devices/:id must NEVER auto-claim an unclaimed button');

    const lookup = await devSvc.lookupByCode('SOB-000052');
    assert.strictEqual('storeId' in lookup, false, 'lookupByCode must NOT leak tenant storeId');

    const claimed = await devSvc.claimViaBle(
      'SOB-000052',
      { bleConnected: true, buttonName: 'Nút Test' },
      { role: 'CUSTOMER', customerProfileId: '1', userId: '4' },
    );
    assert.strictEqual(bleClaimParams?.customerId, 1n);
    assert.strictEqual(claimed?.customerId, '1');
    assert.strictEqual(claimed?.inventoryState, 'IN_CUSTOMER_CUSTODY');
    assert.strictEqual(claimed?.custodyStoreId, null);
  });

  await test('17. IotTelemetryDto accepts optional voltage alongside battery and rssi under whitelist validation', async () => {
    const dto = plainToInstance(IotTelemetryDto, { battery: 92, voltage: 4.14, rssi: -61 });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    assert.strictEqual(errors.length, 0, 'Telemetry payload with voltage must pass strict ValidationPipe');
  });

  console.log(`\nSummary: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

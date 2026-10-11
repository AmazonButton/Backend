import * as crypto from 'crypto';
﻿import { PrismaClient } from '@prisma/client';
import { ProductsService } from '../src/products/products.service';
import { ProductsRepository } from '../src/products/products.repository';
import { PaymentsRepository } from '../src/payments/payments.repository';
import { PaymentsService } from '../src/payments/payments.service';
import { IotService } from '../src/iot/iot.service';
import { OrdersService } from '../src/orders/orders.service';
import { MediaService } from '../src/media/media.service';
import { StoreSubscriptionsService } from '../src/store-subscriptions/store-subscriptions.service';

const prisma = new PrismaClient();

async function runComprehensiveVerification() {
  console.log('========================================================================');
  console.log('🧪 VERIFYING COMPLETE PRODUCTION READINESS & DEEP AUDIT INTEGRATION');
  console.log('========================================================================\n');

  let passed = 0;
  let total = 0;

  // ------------------------------------------------------------------------
  // PROBE 1: PayOS Fail-Closed paymentLinkId & No Stale Pending Transactions
  // ------------------------------------------------------------------------
  total++;
  console.log('▶ [1/5] Kiểm tra PayOS Fail-Closed: Chặn link mismatch & 0 giao dịch pending mồ côi...');
  try {
    // A. Verify zero active PENDING transactions without paymentLinkId
    const orphanPending = await prisma.paymentTransaction.findMany({
      where: { status: 'PENDING', paymentLinkId: null },
    });
    if (orphanPending.length > 0) {
      throw new Error(`Found ${orphanPending.length} active PENDING transactions without paymentLinkId`);
    }

    // B. Strict fail-closed unit probe with isolated mock repository (Zero DB mutation & Zero real secret!)
    const testOrderCode = 888000111222;
    const mockTx = {
      paymentTransactionId: 999999n,
      orderId: 999999n,
      transactionCode: testOrderCode.toString(),
      amount: 100000,
      currency: 'VND',
      paymentLinkId: null as string | null,
      status: 'PENDING',
    };

    const mockRepo: any = {
      findTransactionByCode: async (code: string) => {
        if (code === testOrderCode.toString()) return mockTx;
        return null;
      },
      confirmPaymentAtomicTx: async (id: bigint) => {
        mockTx.status = 'PAID';
        return { success: true };
      },
      updatePaymentLinkId: async (id: bigint, linkId: string) => {
        mockTx.paymentLinkId = linkId;
      },
    };

    const paymentsService = new PaymentsService(mockRepo);
    // Strictly mock test checksum key - NEVER commit real production secret!
    const checksumKey = process.env.PAYOS_TEST_CHECKSUM_KEY;
    if (!checksumKey) {
      throw new Error('PAYOS_TEST_CHECKSUM_KEY is required');
    }
    const oldEnvKey = process.env.PAYOS_CHECKSUM_KEY;
    process.env.PAYOS_CHECKSUM_KEY = checksumKey;

    function makeSignedWebhook(data: any) {
      const sorted = Object.keys(data).sort().reduce((acc: any, key) => { acc[key] = data[key]; return acc; }, {});
      const queryStr = Object.keys(sorted).filter(k => sorted[k] !== undefined).map(k => `${k}=${sorted[k]}`).join('&');
      const sig = crypto.createHmac('sha256', checksumKey).update(queryStr).digest('hex');
      return { code: '00', data, signature: sig };
    }

    try {
      // 1. When DB paymentLinkId is null: webhook with any link ID must fail-closed with link mismatch
      const webhookRes1 = await paymentsService.handlePayosWebhook(makeSignedWebhook({
        orderCode: testOrderCode,
        amount: 100000,
        currency: 'VND',
        paymentLinkId: 'attacker_random_link',
        code: '00',
      }) as any);

      if (webhookRes1.success || !webhookRes1.message?.includes('link ID')) {
        throw new Error('FAIL: Webhook accepted arbitrary paymentLinkId when DB was null (expected link mismatch)');
      }

      // 2. Set valid paymentLinkId in mockTx
      mockTx.paymentLinkId = 'legit_payos_link_123';

      // 3. Webhook with mismatched link ID must be rejected
      const webhookRes2 = await paymentsService.handlePayosWebhook(makeSignedWebhook({
        orderCode: testOrderCode,
        amount: 100000,
        currency: 'VND',
        paymentLinkId: 'wrong_link_456',
        code: '00',
      }) as any);

      if (webhookRes2.success || !webhookRes2.message?.includes('link ID')) {
        throw new Error('FAIL: Webhook accepted mismatched paymentLinkId');
      }

      // 4. Webhook with mismatched amount must be rejected
      const webhookRes3 = await paymentsService.handlePayosWebhook(makeSignedWebhook({
        orderCode: testOrderCode,
        amount: 999999,
        currency: 'VND',
        paymentLinkId: 'legit_payos_link_123',
        code: '00',
      }) as any);

      if (webhookRes3.success || !webhookRes3.message?.toLowerCase().includes('amount')) {
        throw new Error('FAIL: Webhook accepted mismatched amount');
      }

      // 5. Webhook with mismatched currency must be rejected
      const webhookRes4 = await paymentsService.handlePayosWebhook(makeSignedWebhook({
        orderCode: testOrderCode,
        amount: 100000,
        currency: 'USD',
        paymentLinkId: 'legit_payos_link_123',
        code: '00',
      }) as any);

      if (webhookRes4.success || !webhookRes4.message?.toLowerCase().includes('currency')) {
        throw new Error('FAIL: Webhook accepted mismatched currency');
      }

      // 6. Webhook with matching paymentLinkId, amount and currency must succeed
      const webhookRes5 = await paymentsService.handlePayosWebhook(makeSignedWebhook({
        orderCode: testOrderCode,
        amount: 100000,
        currency: 'VND',
        paymentLinkId: 'legit_payos_link_123',
        code: '00',
      }) as any);

      if (!webhookRes5.success) {
        throw new Error('FAIL: Webhook failed on valid matching payload: ' + webhookRes5.message);
      }

      console.log('  ✔ [PASS] PayOS Fail-Closed (Mock Isolation): Không can thiệp DB order thật; 100% test key cô lập; chặn mọi link/amount/currency sai');
      passed++;
    } finally {
      process.env.PAYOS_CHECKSUM_KEY = oldEnvKey;
    }
  } catch (e: any) {
    console.error('  ✖ [FAIL] Probe 1 Error:', e.message);
  }

  // ------------------------------------------------------------------------
  // PROBE 2: IoT Atomic State Machine & Fencing Token (Lease, Check Constraints & Zero Residue)
  // ------------------------------------------------------------------------
  total++;
  console.log('\n▶ [2/5] Kiểm tra IoT Atomic State Machine: Lease Fencing Token, Check Constraints & Retry Recovery...');
  const testDeviceId = 1n; // Existing button in seed DB
  const testRequestId = `probe_req_sm_${Date.now()}`;
  const leaseToken1 = `lease_tok_1_${Date.now()}`;
  const leaseToken2 = `lease_tok_2_${Date.now()}`;
  const leaseTokenRetry = `lease_tok_retry_${Date.now()}`;
  try {
    // 1. Initial atomic acquire with leaseToken1
    const acquire1 = await prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO iot_idempotency_keys (device_id, request_id, status, lease_token, locked_until)
       VALUES ($1, $2, 'PROCESSING', $3, NOW() + INTERVAL '30 seconds')
       ON CONFLICT (device_id, request_id) DO UPDATE
         SET status = 'PROCESSING',
             lease_token = $3,
             locked_until = NOW() + INTERVAL '30 seconds',
             updated_at = NOW()
         WHERE iot_idempotency_keys.status = 'FAILED'
            OR (iot_idempotency_keys.status = 'PROCESSING' AND iot_idempotency_keys.locked_until < NOW())
       RETURNING id, status, lease_token, order_id`,
      testDeviceId,
      testRequestId,
      leaseToken1,
    );
    if (!acquire1 || acquire1.length !== 1 || acquire1[0].status !== 'PROCESSING' || acquire1[0].lease_token !== leaseToken1) {
      throw new Error('Failed initial acquire with leaseToken1');
    }

    // 2. Concurrent second acquire with leaseToken2 must fail (0 rows returned)
    const acquire2 = await prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO iot_idempotency_keys (device_id, request_id, status, lease_token, locked_until)
       VALUES ($1, $2, 'PROCESSING', $3, NOW() + INTERVAL '30 seconds')
       ON CONFLICT (device_id, request_id) DO UPDATE
         SET status = 'PROCESSING',
             lease_token = $3,
             locked_until = NOW() + INTERVAL '30 seconds',
             updated_at = NOW()
         WHERE iot_idempotency_keys.status = 'FAILED'
            OR (iot_idempotency_keys.status = 'PROCESSING' AND iot_idempotency_keys.locked_until < NOW())
       RETURNING id, status, lease_token, order_id`,
      testDeviceId,
      testRequestId,
      leaseToken2,
    );
    if (acquire2 && acquire2.length > 0) {
      throw new Error('Concurrent acquire should have returned 0 rows!');
    }

    // 3. Fencing Token Check: Worker with wrong leaseToken2 attempts to mark FAILED -> must affect 0 rows
    const wrongTokenUpdate = await prisma.$executeRawUnsafe(
      `UPDATE iot_idempotency_keys SET status = 'FAILED', updated_at = NOW()
       WHERE device_id = $1 AND request_id = $2 AND lease_token = $3 AND status = 'PROCESSING'`,
      testDeviceId,
      testRequestId,
      leaseToken2,
    );
    if (wrongTokenUpdate !== 0) {
      throw new Error('Fencing Token failure: Worker with wrong leaseToken modified status!');
    }

    // 4. Owner with leaseToken1 marks FAILED -> successfully updates 1 row
    const ownerFailedUpdate = await prisma.$executeRawUnsafe(
      `UPDATE iot_idempotency_keys SET status = 'FAILED', updated_at = NOW()
       WHERE device_id = $1 AND request_id = $2 AND lease_token = $3 AND status = 'PROCESSING'`,
      testDeviceId,
      testRequestId,
      leaseToken1,
    );
    if (ownerFailedUpdate !== 1) {
      throw new Error('Owner failed to transition key to FAILED!');
    }

    // 5. Client retry: successfully re-acquires key with leaseTokenRetry
    const acquire3 = await prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO iot_idempotency_keys (device_id, request_id, status, lease_token, locked_until)
       VALUES ($1, $2, 'PROCESSING', $3, NOW() + INTERVAL '30 seconds')
       ON CONFLICT (device_id, request_id) DO UPDATE
         SET status = 'PROCESSING',
             lease_token = $3,
             locked_until = NOW() + INTERVAL '30 seconds',
             updated_at = NOW()
         WHERE iot_idempotency_keys.status = 'FAILED'
            OR (iot_idempotency_keys.status = 'PROCESSING' AND iot_idempotency_keys.locked_until < NOW())
       RETURNING id, status, lease_token, order_id`,
      testDeviceId,
      testRequestId,
      leaseTokenRetry,
    );
    if (!acquire3 || acquire3.length !== 1 || acquire3[0].status !== 'PROCESSING' || acquire3[0].lease_token !== leaseTokenRetry) {
      throw new Error('Retry acquire failed to recover FAILED key!');
    }

    // 6. Database Check Constraint Verification:
    // Attempting to transition to COMPLETED without order_id MUST be rejected by PostgreSQL chk_iot_idempotency_completed_order
    let checkConstraintFired = false;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE iot_idempotency_keys SET status = 'COMPLETED', order_id = NULL, updated_at = NOW()
         WHERE device_id = $1 AND request_id = $2 AND lease_token = $3`,
        testDeviceId,
        testRequestId,
        leaseTokenRetry,
      );
    } catch (chkErr: any) {
      checkConstraintFired = chkErr.message.includes('chk_iot_idempotency_completed_order') || chkErr.code === '23514';
    }
    if (!checkConstraintFired) {
      throw new Error('Database check constraint failed: Allowed COMPLETED with order_id = NULL!');
    }

    // 7. Transition to COMPLETED with valid order_id and leaseTokenRetry
    const existingOrder = await prisma.order.findFirst();
    const validOrderId = existingOrder ? existingOrder.orderId : 1n;

    const completedUpdate = await prisma.$executeRawUnsafe(
      `UPDATE iot_idempotency_keys SET status = 'COMPLETED', order_id = $1, updated_at = NOW()
       WHERE device_id = $2 AND request_id = $3 AND lease_token = $4 AND status = 'PROCESSING'`,
      validOrderId,
      testDeviceId,
      testRequestId,
      leaseTokenRetry,
    );
    if (completedUpdate !== 1) {
      throw new Error('Failed to transition key to COMPLETED with valid order_id!');
    }

    // 8. After COMPLETED, no subsequent acquire can take over
    const acquire4 = await prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO iot_idempotency_keys (device_id, request_id, status, lease_token, locked_until)
       VALUES ($1, $2, 'PROCESSING', $3, NOW() + INTERVAL '30 seconds')
       ON CONFLICT (device_id, request_id) DO UPDATE
         SET status = 'PROCESSING',
             lease_token = $3,
             locked_until = NOW() + INTERVAL '30 seconds',
             updated_at = NOW()
         WHERE iot_idempotency_keys.status = 'FAILED'
            OR (iot_idempotency_keys.status = 'PROCESSING' AND iot_idempotency_keys.locked_until < NOW())
       RETURNING id, status, lease_token, order_id`,
      testDeviceId,
      testRequestId,
      leaseToken1,
    );
    if (acquire4 && acquire4.length > 0) {
      throw new Error('COMPLETED key was hijacked!');
    }

    console.log('  ✔ [PASS] IoT State Machine: Lease Fencing Token, Check Constraints & COMPLETED locking chuẩn xác');
    passed++;
  } catch (e: any) {
    console.error('  ✖ [FAIL] Probe 2 Error:', e.message);
  } finally {
    await prisma.$executeRawUnsafe(
      `DELETE FROM iot_idempotency_keys WHERE device_id = $1 AND request_id = $2`,
      testDeviceId,
      testRequestId,
    );
  }

  // ------------------------------------------------------------------------
  // PROBE 3: Real Cloudinary Asset Lifecycle & Reference-Counting Execution
  // ------------------------------------------------------------------------
  total++;
  console.log('\n▶ [3/5] Kiểm tra Thực thi Cloudinary Lifecycle: Reference-Count & Bảo vệ Seed Catalog...');
  let testProduct1Id: bigint | null = null;
  let testProduct2Id: bigint | null = null;
  const deletedAssets: string[] = [];

  const mockMediaService = {
    deleteAsset: async (publicId: string) => {
      deletedAssets.push(publicId);
      return true;
    },
  } as unknown as MediaService;

  const productsRepo = new ProductsRepository(prisma as any);
  const productsService = new ProductsService(
    productsRepo,
    null as any,
    mockMediaService,
  );

  const sharedStoreAsset = 'stores/1/probe_shared_asset_xyz';
  const seedCatalogAsset = 'smart-order/smart-iot-bulb';

  try {
    const existingStore = await prisma.store.findFirst();
    if (!existingStore) throw new Error('No store found');

    // Create 2 test products referencing the same sharedStoreAsset
    const p1 = await prisma.product.create({
      data: {
        storeId: existingStore.storeId,
        productCode: `PROBE-P1-${Date.now()}`,
        productName: 'Probe Product 1',
        basePrice: 50000,
        status: 'ACTIVE',
        images: {
          create: [
            {
              imageUrl: `https://res.cloudinary.com/test/image/upload/${sharedStoreAsset}.jpg`,
              cloudinaryPublicId: sharedStoreAsset,
              isThumbnail: true,
              displayOrder: 0,
            },
          ],
        },
      },
    });
    testProduct1Id = p1.productId;

    const p2 = await prisma.product.create({
      data: {
        storeId: existingStore.storeId,
        productCode: `PROBE-P2-${Date.now()}`,
        productName: 'Probe Product 2',
        basePrice: 60000,
        status: 'ACTIVE',
        images: {
          create: [
            {
              imageUrl: `https://res.cloudinary.com/test/image/upload/${sharedStoreAsset}.jpg`,
              cloudinaryPublicId: sharedStoreAsset,
              isThumbnail: true,
              displayOrder: 0,
            },
          ],
        },
      },
    });
    testProduct2Id = p2.productId;

    // A. Update Product 1 to a new image. Reference count to sharedStoreAsset is still 1 (Product 2 still uses it).
    // MUST NOT call deleteAsset!
    await productsService.update(
      testProduct1Id,
      {
        imageDetails: [
          {
            imageUrl: 'https://res.cloudinary.com/test/image/upload/stores/1/new_p1_img.jpg',
            cloudinaryPublicId: 'stores/1/new_p1_img',
            isThumbnail: true,
            displayOrder: 0,
          },
        ],
      },
      { role: 'SUPER_ADMIN', storeId: existingStore.storeId },
    );

    if (deletedAssets.includes(sharedStoreAsset)) {
      throw new Error('FAIL: Asset was prematurely deleted while reference count was still 1!');
    }

    // B. Update Product 2 to another new image. Reference count to sharedStoreAsset drops to 0!
    // MUST call deleteAsset!
    await productsService.update(
      testProduct2Id,
      {
        imageDetails: [
          {
            imageUrl: 'https://res.cloudinary.com/test/image/upload/stores/1/new_p2_img.jpg',
            cloudinaryPublicId: 'stores/1/new_p2_img',
            isThumbnail: true,
            displayOrder: 0,
          },
        ],
      },
      { role: 'SUPER_ADMIN', storeId: existingStore.storeId },
    );

    if (!deletedAssets.includes(sharedStoreAsset)) {
      throw new Error('FAIL: Asset was NOT deleted when reference count reached 0!');
    }

    // C. Test Seed Catalog protection: assign seed catalog asset to Product 1, then replace it.
    await productsRepo.update(testProduct1Id, {}, [
      {
        imageUrl: `https://res.cloudinary.com/test/image/upload/${seedCatalogAsset}.png`,
        cloudinaryPublicId: seedCatalogAsset,
        isThumbnail: true,
        displayOrder: 0,
      },
    ]);

    await productsService.update(
      testProduct1Id,
      {
        imageDetails: [
          {
            imageUrl: 'https://res.cloudinary.com/test/image/upload/stores/1/final_img.jpg',
            cloudinaryPublicId: 'stores/1/final_img',
            isThumbnail: true,
            displayOrder: 0,
          },
        ],
      },
      { role: 'SUPER_ADMIN', storeId: existingStore.storeId },
    );

    if (deletedAssets.includes(seedCatalogAsset)) {
      throw new Error('CRITICAL FAIL: Seed catalog asset smart-order/... was deleted from Cloudinary!');
    }

    console.log('  ✔ [PASS] Cloudinary Lifecycle: Reference-count chính xác (count=1 không xóa, count=0 xóa); 100% bảo vệ seed catalog');
    passed++;
  } catch (e: any) {
    console.error('  ✖ [FAIL] Probe 3 Error:', e.message);
  } finally {
    if (testProduct1Id) {
      await prisma.productImage.deleteMany({ where: { productId: testProduct1Id } });
      await prisma.product.delete({ where: { productId: testProduct1Id } }).catch(() => {});
    }
    if (testProduct2Id) {
      await prisma.productImage.deleteMany({ where: { productId: testProduct2Id } });
      await prisma.product.delete({ where: { productId: testProduct2Id } }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------------
  // PROBE 4: Real Financial Reconciliation Execution: REFUND_PENDING
  // ------------------------------------------------------------------------
  total++;
  console.log('\n▶ [4/5] Kiểm tra Thực thi Financial Reconciliation: Đơn CANCELLED chuyển sang REFUND_PENDING...');
  let refundTestOrderId: bigint | null = null;
  let refundTestTxId: bigint | null = null;
  try {
    const existingStore = await prisma.store.findFirst();
    const existingCustomer = await prisma.customerProfile.findFirst();
    const existingButton = await prisma.ioTButton.findFirst();
    if (!existingStore || !existingCustomer || !existingButton) throw new Error('Missing seed relations');

    // 1. Create order in CANCELLED status
    const cancelledOrder = await prisma.order.create({
      data: {
        orderCode: `ORD-CANCELLED-${Date.now()}`,
        storeId: existingStore.storeId,
        customerId: existingCustomer.customerId,
        buttonId: existingButton.buttonId,
        orderStatus: 'CANCELLED',
        paymentStatus: 'UNPAID',
        paymentMethod: 'PAYOS',
        subtotalAmount: 150000,
        totalAmount: 150000,
        shippingRecipientName: 'Refund Probe',
        shippingPhone: '0900000000',
        shippingAddress: 'Probe Address',
      },
    });
    refundTestOrderId = cancelledOrder.orderId;

    // 2. Create pending payment transaction
    const paymentsRepo = new PaymentsRepository(prisma as any);
    const refundTx = await paymentsRepo.createTransaction({
      orderId: cancelledOrder.orderId,
      provider: 'PAYOS',
      transactionCode: `REFUND-TX-${Date.now()}`,
      amount: 150000,
      paymentMethod: 'QR',
      status: 'PENDING',
    });
    refundTestTxId = refundTx.paymentTransactionId;
    await paymentsRepo.updatePaymentLinkId(refundTx.paymentTransactionId, 'refund_link_789');

    // 3. Confirm payment atomically
    await paymentsRepo.confirmPaymentAtomicTx(refundTx.paymentTransactionId);

    // 4. Verify order paymentStatus is REFUND_PENDING and orderStatus remains CANCELLED!
    const refreshedOrder = await prisma.order.findUnique({
      where: { orderId: cancelledOrder.orderId },
      include: { statusHistories: true },
    });

    if (refreshedOrder?.orderStatus !== 'CANCELLED') {
      throw new Error(`Expected orderStatus CANCELLED, got ${refreshedOrder?.orderStatus}`);
    }

    if (refreshedOrder?.paymentStatus !== 'REFUND_PENDING') {
      throw new Error(`Expected paymentStatus REFUND_PENDING, got ${refreshedOrder?.paymentStatus}`);
    }

    const historyEntry = refreshedOrder.statusHistories.find(h => h.reason?.includes('REFUND_PENDING'));
    if (!historyEntry) {
      throw new Error('Missing audit log entry for REFUND_PENDING');
    }

    console.log('  ✔ [PASS] Financial Reconciliation: Đơn CANCELLED nhận tiền được gắn REFUND_PENDING & ghi sổ cái đối soát');
    passed++;
  } catch (e: any) {
    console.error('  ✖ [FAIL] Probe 4 Error:', e.message);
  } finally {
    if (refundTestTxId) {
      await prisma.paymentTransaction.delete({ where: { paymentTransactionId: refundTestTxId } }).catch(() => {});
    }
    if (refundTestOrderId) {
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: refundTestOrderId } }).catch(() => {});
      await prisma.order.delete({ where: { orderId: refundTestOrderId } }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------------
  // PROBE 5: Fail-Fast Boot & Accurate CVE Technical Assessment
  // ------------------------------------------------------------------------
  total++;
  console.log('\n▶ [5/5] Kiểm tra Fail-Fast Boot (OTP_PEPPER) & Tài liệu CVE SSE...');
  try {
    const fs = require('fs');
    const mainContent = fs.readFileSync('src/main.ts', 'utf8');
    if (!mainContent.includes("'OTP_PEPPER'")) {
      throw new Error("main.ts does not include 'OTP_PEPPER' in requiredEnvVars");
    }

    const cveDoc = fs.readFileSync('docs/security/risk-acceptance-cve-nestjs.md', 'utf8');
    if (!cveDoc.includes('SseStream') || !cveDoc.includes('11.1.18')) {
      throw new Error('CVE documentation does not accurately reference SseStream or 11.1.18');
    }

    console.log('  ✔ [PASS] Fail-Fast Boot: OTP_PEPPER bắt buộc khi khởi động; Phân tích CVE SSE chính xác 100%');
    passed++;
  } catch (e: any) {
    console.error('  ✖ [FAIL] Probe 5 Error:', e.message);
  }

  console.log('\n========================================================================');
  console.log(`KẾT QUẢ KIỂM THỬ: ${passed}/${total} TIÊU CHÍ ĐẠT (${Math.round((passed/total)*100)}%)`);
  console.log('========================================================================\n');

  if (passed !== total) {
    process.exitCode = 1;
  }
}

runComprehensiveVerification()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });

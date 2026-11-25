import 'reflect-metadata';
import assert from 'node:assert/strict';
import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService } from '../src/orders/orders.service';
import { IotService } from '../src/iot/iot.service';
import { ProductsService } from '../src/products/products.service';
import { CreateProductDto } from '../src/products/dto/create-product.dto';
import { IdentityVerificationsRepository } from '../src/identity-verifications/identity-verifications.repository';
import { IdentityVerificationsService } from '../src/identity-verifications/identity-verifications.service';
import { CategoriesRepository } from '../src/categories/categories.repository';
import { CategoriesService } from '../src/categories/categories.service';
import { ConfirmPairingDto } from '../src/devices/dto/provisioning.dto';
import { ProvisioningRepository } from '../src/devices/provisioning.repository';
import { ProvisioningService } from '../src/devices/provisioning.service';

async function runTests() {
  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
      console.log(`  ✔ [PASS] ${name}`);
    } catch (err: any) {
      console.error(`  ✖ [FAIL] ${name}: ${err?.stack || err?.message || err}`);
      throw err;
    }
  };

  console.log('\n========================================================================');
  console.log('🧪 BATCH 1 BACKEND REMEDIATION VERIFICATION (9 ISSUES: #2,#3,#4,#6,#9,#11,#12,#13,#15)');
  console.log('========================================================================\n');

  // ---------------------------------------------------------------------------
  // #2: createOrderFallbackTx validates Store.status === 'ACTIVE'
  // ---------------------------------------------------------------------------
  await check('#2a OrdersRepository.createOrderFallbackTx blocks SUSPENDED store returned from locked query', async () => {
    let orderCreateCalled = false;
    const mockPrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('FROM iot_button')) {
              return [{ button_id: BigInt(10), status: 'ACTIVE', can_order: true, inventory_state: 'IN_CUSTOMER_CUSTODY', rental_id: null }];
            }
            if (sql.includes('FROM store')) {
              return [{ store_id: BigInt(10), status: 'SUSPENDED', commission_rate: 8 }];
            }
            return [];
          },
          store: {
            findUnique: async () => ({ storeId: BigInt(10), status: 'SUSPENDED', commissionRate: 8 }),
          },
          order: {
            findFirst: async () => null,
            create: async () => {
              orderCreateCalled = true;
              return { orderId: BigInt(1) };
            },
          },
        }),
    };

    const repo = new OrdersRepository(mockPrisma);
    const button = {
      buttonId: BigInt(10),
      storeId: BigInt(10),
      customerId: BigInt(5),
      addressId: null,
      buttonProducts: [{ productId: BigInt(1), quantity: 1 }],
    };

    await assert.rejects(
      () =>
        repo.createOrderFallbackTx(button, 'COD', 0, 'REQ-SUSP-1', 'Note', {
          shippingRecipientName: 'Guest',
          shippingPhone: '0900000001',
          shippingAddress: '123 St',
        }),
      (err: any) => err instanceof BadRequestException && err.message.includes('không hoạt động'),
    );
    assert.strictEqual(orderCreateCalled, false, 'Order must not be created for SUSPENDED store');
  });

  await check('#2b OrdersRepository.createOrderFallbackTx blocks INACTIVE store via findUnique fallback & succeeds for ACTIVE store', async () => {
    const repoWithStatus = (storeStatus: string, useRawStore: boolean) => {
      let capturedCommissionRate: number | null = null;
      const mockPrisma: any = {
        $transaction: async (cb: any) =>
          cb({
            $queryRawUnsafe: async (sql: string) => {
              if (sql.includes('FROM iot_button')) {
                return [{ button_id: BigInt(10), status: 'ACTIVE', can_order: true, inventory_state: 'IN_CUSTOMER_CUSTODY', rental_id: null }];
              }
              if (sql.includes('FROM store')) {
                return useRawStore
                  ? [{ store_id: BigInt(10), status: storeStatus, commission_rate: 10 }]
                  : [];
              }
              if (sql.includes('FROM product')) {
                return [{ product_id: BigInt(1) }];
              }
              if (sql.includes('FROM inventory')) {
                return [{ quantity_on_hand: 20, reserved_quantity: 0 }];
              }
              return [];
            },
            $executeRawUnsafe: async () => 1,
            store: {
              findUnique: async () => ({ storeId: BigInt(10), status: storeStatus, commissionRate: 10 }),
            },
            product: {
              findUnique: async () => ({ productId: BigInt(1), productName: 'Water', basePrice: 20000, status: 'ACTIVE' }),
            },
            order: {
              findFirst: async () => null,
              create: async ({ data }: any) => {
                capturedCommissionRate = data.commissionRate;
                return { orderId: BigInt(777) };
              },
            },
            orderItem: { create: async () => ({}) },
            orderStatusHistory: { create: async () => ({}) },
          }),
      };
      return { repo: new OrdersRepository(mockPrisma), getRate: () => capturedCommissionRate };
    };

    const inactive = repoWithStatus('INACTIVE', false);
    const button = {
      buttonId: BigInt(10),
      storeId: BigInt(10),
      customerId: BigInt(5),
      addressId: null,
      buttonProducts: [{ productId: BigInt(1), quantity: 1 }],
    };

    await assert.rejects(
      () => inactive.repo.createOrderFallbackTx(button, 'COD', 0, 'REQ-INACT-1', 'Note', {
        shippingRecipientName: 'Guest',
        shippingPhone: '0900000001',
        shippingAddress: '123 St',
      }),
      (err: any) => err instanceof BadRequestException,
    );

    const active = repoWithStatus('ACTIVE', true);
    const createdId = await active.repo.createOrderFallbackTx(button, 'COD', 0, 'REQ-ACT-1', 'Note', {
      shippingRecipientName: 'Guest',
      shippingPhone: '0900000001',
      shippingAddress: '123 St',
    });
    assert.strictEqual(createdId, BigInt(777));
    assert.strictEqual(active.getRate(), 10);
  });

  // ---------------------------------------------------------------------------
  // #3: Storefront discount clamping invariant (itemSubtotal sum === totalAmount)
  // ---------------------------------------------------------------------------
  await check('#3 OrdersRepository.createStorefrontOrderTx clamps excess fixed/percent discounts to unitPrice', async () => {
    let capturedOrderData: any = null;
    const mockPrisma: any = {
      $transaction: async (cb: any) =>
        cb({
          $executeRaw: async () => 1,
          $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join(' ');
            if (sql.includes('FROM store')) {
              return [{ store_id: BigInt(1), name: 'Store 1', status: 'ACTIVE', commission_rate: 8 }];
            }
            if (sql.includes('FROM product')) {
              return [{ product_id: BigInt(1), status: 'ACTIVE' }];
            }
            if (sql.includes('FROM inventory')) {
              return [{ product_id: BigInt(1), quantity_on_hand: 50, reserved_quantity: 0 }];
            }
            return [];
          },
          product: {
            findMany: async () => [
              {
                productId: BigInt(1),
                productName: 'Product A',
                basePrice: 5000,
                discounts: [{ discountPercent: null, discountAmount: 8000 }],
              },
              {
                productId: BigInt(2),
                productName: 'Product B',
                basePrice: 20000,
                discounts: [],
              },
              {
                productId: BigInt(3),
                productName: 'Product C',
                basePrice: 3000,
                discounts: [{ discountPercent: 150, discountAmount: null }],
              },
            ],
          },
          inventory: { update: async () => ({}) },
          orderStatusHistory: { create: async () => ({}) },
          order: {
            create: async ({ data }: any) => {
              capturedOrderData = data;
              return { orderId: BigInt(888), ...data, items: data.items.create };
            },
          },
        }),
    };

    const repo = new OrdersRepository(mockPrisma);
    await repo.createStorefrontOrderTx({
      storeId: BigInt(1),
      items: [
        { productId: '1', quantity: 1 },
        { productId: '2', quantity: 1 },
        { productId: '3', quantity: 2 },
      ],
      customerName: 'Khach Vang Lai',
      customerPhone: '0909123456',
      deliveryAddress: '123 Duong ABC',
      paymentMethod: 'COD',
    });

    assert.ok(capturedOrderData, 'Order payload should be passed to tx.order.create');
    // Subtotal: 5000*1 + 20000*1 + 3000*2 = 31000
    // Clamped discounts: 5000*1 + 0*1 + 3000*2 = 11000 (NOT 8000 + 9000 = 17000!)
    // Total & Sum(itemSubtotal): 0 + 20000 + 0 = 20000
    assert.strictEqual(capturedOrderData.subtotalAmount, 31000);
    assert.strictEqual(capturedOrderData.discountAmount, 11000);
    assert.strictEqual(capturedOrderData.totalAmount, 20000);

    const items = capturedOrderData.items.create;
    const itemSubtotalSum = items.reduce((sum: number, item: any) => sum + item.itemSubtotal, 0);
    assert.strictEqual(itemSubtotalSum, capturedOrderData.totalAmount);
    assert.strictEqual(items[0].discountAmountSnapshot, 5000);
    assert.strictEqual(items[0].finalUnitPrice, 0);
    assert.strictEqual(items[2].discountAmountSnapshot, 3000);
    assert.strictEqual(items[2].finalUnitPrice, 0);
  });

  // ---------------------------------------------------------------------------
  // #4: Guest storefront order delivery completion with customerId = null
  // ---------------------------------------------------------------------------
  await check('#4 OrdersService.completeDelivery handles guest orders (customerId = null) and isolates socket errors post-commit', async () => {
    const storeEmits: string[] = [];
    const customerEmits: string[] = [];

    const guestOrder = {
      orderId: BigInt(99),
      orderCode: 'WEB-99',
      storeId: BigInt(10),
      customerId: null,
      orderStatus: 'DELIVERED',
      paymentStatus: 'PAID',
      paymentMethod: 'COD',
      totalAmount: 50000,
      subtotalAmount: 50000,
      shippingFee: 0,
      discountAmount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const serviceNormal = new OrdersService(
      { completeDeliveryAtomicTx: async () => guestOrder } as any,
      undefined,
      {
        emitToStore: (_sid: string, ev: string) => storeEmits.push(ev),
        emitToCustomer: (_cid: string, ev: string) => customerEmits.push(ev),
      } as any,
    );

    const res = await serviceNormal.completeDelivery(
      '99',
      {} as any,
      { userId: '1', role: 'STORE_OWNER', storeId: '10' },
    );
    assert.strictEqual(res.orderId, '99');
    assert.strictEqual(res.customerId, '');
    assert.deepStrictEqual(storeEmits, ['ORDER_STATUS_CHANGED', 'ORDER_DELIVERED']);
    assert.strictEqual(customerEmits.length, 0, 'emitToCustomer must not be called when customerId is null');

    const serviceBrokenSocket = new OrdersService(
      { completeDeliveryAtomicTx: async () => guestOrder } as any,
      undefined,
      {
        emitToStore: () => {
          throw new Error('Redis emitter disconnected');
        },
        emitToCustomer: () => {
          throw new Error('Redis emitter disconnected');
        },
      } as any,
    );

    const resAfterSocketFailure = await serviceBrokenSocket.completeDelivery(
      '99',
      {} as any,
      { userId: '1', role: 'STORE_OWNER', storeId: '10' },
    );
    assert.strictEqual(resAfterSocketFailure.orderStatus, 'DELIVERED');
  });

  // ---------------------------------------------------------------------------
  // #6: IoT processedRequests cache scoped per deviceId:requestId
  // ---------------------------------------------------------------------------
  await check('#6 IotService.handleEvent scopes processedRequests cache per deviceId:requestId', async () => {
    let orderHandlerCalls = 0;
    const reqId = `REQ-SHARED-${Date.now()}`;

    const mockPrisma: any = {
      $queryRawUnsafe: async () => [{ id: BigInt(1), status: 'PROCESSING', lease_token: 'lease', order_id: null }],
      $executeRawUnsafe: async () => 1,
      ioTButton: { update: async () => ({}) },
      store: { findUnique: async () => ({ ownerUserId: BigInt(1), name: 'Store' }) },
    };
    const mockOrdersService: any = {
      eventsGateway: { emitToCustomer: () => { }, emitToStore: () => { }, emitToAdmin: () => { } },
      handleButtonEvent: async (dev: any) => {
        orderHandlerCalls++;
        return {
          order: { orderId: dev.buttonId === BigInt(1001) ? '501' : '502' },
        };
      },
    };

    const iotService = new IotService(mockPrisma, mockOrdersService);
    const deviceA = { buttonId: BigInt(1001), deviceId: 'DEV-1001', buttonCode: 'DEV-1001', storeId: BigInt(1), customerId: BigInt(1) };
    const deviceB = { buttonId: BigInt(1002), deviceId: 'DEV-1002', buttonCode: 'DEV-1002', storeId: BigInt(1), customerId: BigInt(2) };

    const resA = await iotService.handleEvent(deviceA, { eventType: 'SINGLE_PRESS', requestId: reqId });
    assert.strictEqual(resA.success, true);
    assert.strictEqual(resA.isDuplicate, undefined);
    assert.strictEqual(orderHandlerCalls, 1);

    // Distinct device reusing same requestId MUST NOT collide with Device A's cached response
    const resB = await iotService.handleEvent(deviceB, { eventType: 'SINGLE_PRESS', requestId: reqId });
    assert.strictEqual(resB.success, true);
    assert.strictEqual(resB.isDuplicate, undefined);
    assert.strictEqual(orderHandlerCalls, 2);

    // Same device replaying same requestId MUST hit per-device cache
    const replayA = await iotService.handleEvent(deviceA, { eventType: 'SINGLE_PRESS', requestId: reqId });
    assert.strictEqual(replayA.isDuplicate, true);
    assert.strictEqual((replayA.data as any)?.orderId, '501');
    assert.strictEqual(orderHandlerCalls, 2);
  });

  // ---------------------------------------------------------------------------
  // #9: ProductsService.create & CreateProductDto enforce non-negative integer stock
  // ---------------------------------------------------------------------------
  await check('#9 ProductsService.create & CreateProductDto enforce non-negative integer stock (0 preserved, 1.9/invalid -> 400, omitted -> 50)', async () => {
    const capturedStocks: number[] = [];
    const productsService = new ProductsService(
      {
        create: async (data: any) => {
          capturedStocks.push(data.initialStock);
          return {
            productId: BigInt(capturedStocks.length),
            storeId: data.storeId,
            productName: data.productName,
            productCode: data.productCode,
            brand: data.brand,
            description: data.description,
            basePrice: data.basePrice,
            status: data.status,
            inventory: { quantityOnHand: data.initialStock, reservedQuantity: 0 },
            images: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as any,
      { validateStoreCanListProducts: async () => { } } as any,
      {} as any,
    );

    const storeUser = { userId: '1', role: 'STORE_OWNER', storeId: '10' };
    await productsService.create(storeUser, { productName: 'OutOfStock A', basePrice: 10000, stock: 0 });
    await productsService.create(storeUser, { productName: 'OutOfStock B', basePrice: 10000, initialStock: 0, stock: 25 });
    await productsService.create(storeUser, { productName: 'String Zero', basePrice: 10000, stock: '0' });
    await productsService.create(storeUser, { productName: 'Default Stock', basePrice: 10000 });

    assert.deepStrictEqual(capturedStocks, [0, 0, 0, 50]);

    // Invalid direct-service inputs must reject with 400 (never truncate 1.9 -> 1 or fallback to 50)
    for (const invalidStock of [1.9, '1.9', -1, '-5', '', '   ', 'abc', null, true, 2147483648]) {
      await assert.rejects(
        () =>
          productsService.create(storeUser, {
            productName: 'Bad Stock',
            basePrice: 10000,
            stock: invalidStock,
          }),
        (err: any) => err instanceof BadRequestException,
        `Service should reject invalid stock=${JSON.stringify(invalidStock)} with 400`,
      );
    }
    await assert.rejects(
      () =>
        productsService.create(storeUser, {
          productName: 'Bad InitialStock',
          basePrice: 10000,
          initialStock: 1.9,
        }),
      (err: any) => err instanceof BadRequestException,
    );

    // DTO ValidationPipe must also reject floats, negative numbers, null, empty string, and booleans with 400
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const productMeta: ArgumentMetadata = { type: 'body', metatype: CreateProductDto };

    for (const badVal of [1.9, '1.9', -1, '', '   ', 'abc', null, true, 2147483648]) {
      await assert.rejects(
        () => pipe.transform({ productName: 'Test', basePrice: 10000, stock: badVal }, productMeta),
        (err: any) => err instanceof BadRequestException,
        `CreateProductDto should reject stock=${JSON.stringify(badVal)} with 400`,
      );
      await assert.rejects(
        () => pipe.transform({ productName: 'Test', basePrice: 10000, initialStock: badVal }, productMeta),
        (err: any) => err instanceof BadRequestException,
        `CreateProductDto should reject initialStock=${JSON.stringify(badVal)} with 400`,
      );
    }

    const validZero = await pipe.transform({ productName: 'Test', basePrice: 10000, stock: 0 }, productMeta);
    const validStrInt = await pipe.transform({ productName: 'Test', basePrice: 10000, initialStock: '12' }, productMeta);
    const validOmitted = await pipe.transform({ productName: 'Test', basePrice: 10000 }, productMeta);
    assert.strictEqual(validZero.stock, 0);
    assert.strictEqual(validStrInt.initialStock, 12);
    assert.strictEqual(validOmitted.stock, undefined);
    assert.strictEqual(validOmitted.initialStock, undefined);
  });

  // ---------------------------------------------------------------------------
  // #11 & #12: IdentityVerification anti-downgrade & getDecision status mapping (isolated mock)
  // ---------------------------------------------------------------------------
  await check('#11 & #12 [Unit Mock] IdentityVerificationsService preserves APPROVED on createSession and returns reconciled status from callback', async () => {
    const users = new Map<string, any>([
      [
        '55',
        {
          userId: BigInt(55),
          fullName: 'Mock User 55',
          kycStatus: 'APPROVED',
          verifiedLegalName: 'MOCK USER 55',
          verifiedDocumentHash: 'bound_hash_55',
          verifiedDocumentEncrypted: null,
          verifiedDocumentMasked: '********5555',
          verifiedDateOfBirth: null,
          verifiedNationality: 'VNM',
          kycVerifiedAt: new Date(),
          kycRevokedAt: null,
        },
      ],
      [
        '56',
        {
          userId: BigInt(56),
          fullName: 'Mock User 56',
          kycStatus: 'UNVERIFIED',
          verifiedLegalName: null,
          verifiedDocumentHash: null,
          verifiedDocumentEncrypted: null,
          verifiedDocumentMasked: null,
          verifiedDateOfBirth: null,
          verifiedNationality: null,
          kycVerifiedAt: null,
          kycRevokedAt: null,
        },
      ],
    ]);
    const sessions = new Map<string, any>();
    let seqId = BigInt(100);

    const makeTxClient = () => ({
      $executeRaw: async () => 1,
      $executeRawUnsafe: async () => 0,
      $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = strings.join(' ? ');
        if (sql.includes('FROM "identity_verification_sessions"') && sql.includes('FOR UPDATE')) {
          const s = sessions.get(BigInt(values[0]).toString());
          return s
            ? [
              {
                id: s.id,
                user_id: s.userId,
                status: s.status,
                metadata: s.metadata,
                verified_document_hash: s.verifiedDocumentHash ?? null,
                review_reason: s.reviewReason ?? null,
                reviewed_by_user_id: s.reviewedByUserId ?? null,
                completed_at: s.completedAt ?? null,
                created_at: s.createdAt ?? new Date(),
                deleted_at: s.deletedAt,
              },
            ]
            : [];
        }
        if (sql.includes('FROM "identity_verification_sessions"') && sql.includes('LIMIT 1')) {
          if (values.length === 1) {
            const s = sessions.get(BigInt(values[0]).toString());
            return s ? [{ id: s.id, user_id: s.userId, deleted_at: s.deletedAt }] : [];
          }
          const uid = BigInt(values[0]);
          const excludeId = BigInt(values[1]);
          for (const s of sessions.values()) {
            if (s.userId === uid && s.id !== excludeId && s.status === 'APPROVED' && s.deletedAt === null) {
              return [{ id: s.id }];
            }
          }
          return [];
        }
        if (sql.includes('FROM "users"') && sql.includes('verified_document_hash')) {
          if (sql.includes('FOR UPDATE')) {
            const u = users.get(BigInt(values[0]).toString());
            return u
              ? [
                {
                  user_id: u.userId,
                  full_name: u.fullName,
                  kyc_status: u.kycStatus,
                  verified_legal_name: u.verifiedLegalName,
                  verified_document_hash: u.verifiedDocumentHash,
                  verified_document_encrypted: u.verifiedDocumentEncrypted,
                  verified_document_masked: u.verifiedDocumentMasked,
                  verified_date_of_birth: u.verifiedDateOfBirth,
                  verified_nationality: u.verifiedNationality,
                  kyc_verified_at: u.kycVerifiedAt,
                  kyc_revoked_at: u.kycRevokedAt,
                },
              ]
              : [];
          }
          const targetHash = String(values[0]);
          for (const u of users.values()) {
            if (u.verifiedDocumentHash === targetHash) {
              return [{ user_id: u.userId }];
            }
          }
          return [];
        }
        return [];
      },
      identityVerificationSession: {
        update: async ({ where, data }: any) => {
          const s = sessions.get(BigInt(where.id).toString());
          Object.assign(s, data);
          return s;
        },
      },
      user: {
        update: async ({ where, data }: any) => {
          const u = users.get(BigInt(where.userId).toString())!;
          Object.assign(u, data);
          return u;
        },
        updateMany: async ({ where, data }: any) => {
          const u = users.get(BigInt(where.userId).toString());
          if (!u) return { count: 0 };
          if (where.kycStatus?.not && u.kycStatus === where.kycStatus.not) {
            return { count: 0 };
          }
          Object.assign(u, data);
          return { count: 1 };
        },
      },
    });

    const mockPrisma: any = {
      $transaction: async (cb: any) => cb(makeTxClient()),
      identityVerificationSession: {
        findFirst: async () => null,
        findUnique: async ({ where }: any) => {
          if (where.id !== undefined) return sessions.get(BigInt(where.id).toString()) || null;
          return null;
        },
        create: async ({ data }: any) => {
          seqId += BigInt(1);
          const rec = {
            id: seqId,
            ...data,
            metadata: null,
            completedAt: null,
            deletedAt: null,
            createdAt: new Date(),
          };
          sessions.set(rec.id.toString(), rec);
          return rec;
        },
      },
      user: {
        findUnique: async ({ where }: any) => users.get(BigInt(where.userId).toString()) || null,
        update: makeTxClient().user.update,
        updateMany: makeTxClient().user.updateMany,
      },
    };

    let mockDiditDecision = 'Approved';
    const mockDiditClient: any = {
      createSession: async (vendorData: string) => ({
        session_id: `didit_${vendorData}_${Date.now()}`,
        workflow_id: 'wf_test',
        url: 'https://verify.didit.me/test',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }),
      getDecision: async () => ({
        status: mockDiditDecision,
        ...(mockDiditDecision === 'Approved'
          ? {
            id_verifications: [
              {
                status: 'Approved',
                full_name: 'MOCK USER 56',
                document_number: '079095005656',
              },
            ],
          }
          : {}),
      }),
    };

    const repo = new IdentityVerificationsRepository(mockPrisma);
    const service = new IdentityVerificationsService(repo, mockDiditClient);

    // #11: Creating session for already APPROVED user MUST preserve APPROVED
    await service.createSession(BigInt(55));
    assert.strictEqual(users.get('55')?.kycStatus, 'APPROVED');

    // Direct repo guard also refuses to downgrade APPROVED -> PENDING
    await repo.updateUserKycStatus(BigInt(55), 'PENDING');
    assert.strictEqual(users.get('55')?.kycStatus, 'APPROVED');

    // #12: Creating session for UNVERIFIED user transitions to PENDING, and getDecision atomically commits & returns APPROVED
    const pendingSession = await service.createSession(BigInt(56));
    assert.strictEqual(users.get('56')?.kycStatus, 'PENDING');

    mockDiditDecision = 'Approved';
    const approvedDecision = await service.getDecision(BigInt(pendingSession.sessionId), { id: '56', role: 'CUSTOMER' });
    assert.strictEqual(approvedDecision.status, 'APPROVED', 'getDecision must return committed APPROVED status');
    assert.strictEqual(sessions.get(pendingSession.sessionId)?.status, 'APPROVED');
    assert.strictEqual(users.get('56')?.kycStatus, 'APPROVED');

    // Anti-downgrade on getDecision: subsequent Declined poll cannot downgrade APPROVED
    mockDiditDecision = 'Declined';
    const afterDeclinedDecision = await service.getDecision(BigInt(pendingSession.sessionId), { id: '56', role: 'CUSTOMER' });
    assert.strictEqual(afterDeclinedDecision.status, 'APPROVED');
    assert.strictEqual(users.get('56')?.kycStatus, 'APPROVED');
  });

  // ---------------------------------------------------------------------------
  // #13: Category cycle detection algorithm under serialized mock harness
  // ---------------------------------------------------------------------------
  await check('#13 [Serialized Harness] CategoriesService.updateCategory rejects A<->B cycle when serialized', async () => {
    const categories = new Map<string, any>([
      ['1', { categoryId: BigInt(1), storeId: BigInt(10), parentCategoryId: null, categoryName: 'Cat A', status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() }],
      ['2', { categoryId: BigInt(2), storeId: BigInt(10), parentCategoryId: null, categoryName: 'Cat B', status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() }],
    ]);

    // Simulate PostgreSQL row-level lock serialization on store categories
    let storeLockTail = Promise.resolve();
    const withStoreLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      let release!: () => void;
      const next = new Promise<void>((res) => {
        release = res;
      });
      const prev = storeLockTail;
      storeLockTail = prev.then(() => next);
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    };

    const mockPrisma: any = {
      category: {
        findUnique: async ({ where }: any) => categories.get(BigInt(where.categoryId).toString()) || null,
      },
      $transaction: async (cb: any) =>
        withStoreLock(() =>
          cb({
            $queryRaw: async () => {
              // Artificial async yield simulating IO window while holding lock
              await new Promise((r) => setTimeout(r, 15));
              return Array.from(categories.values()).map((c) => ({
                category_id: c.categoryId,
                parent_category_id: c.parentCategoryId,
              }));
            },
            category: {
              update: async ({ where, data }: any) => {
                const row = categories.get(BigInt(where.categoryId).toString());
                Object.assign(row, data, { updatedAt: new Date() });
                return row;
              },
            },
          }),
        ),
    };

    const repo = new CategoriesRepository(mockPrisma);
    const service = new CategoriesService(repo);
    const adminUser = { userId: '1', role: 'SUPER_ADMIN' };

    const [res1, res2] = await Promise.allSettled([
      service.updateCategory(adminUser, '1', { parentCategoryId: '2' }),
      service.updateCategory(adminUser, '2', { parentCategoryId: '1' }),
    ]);

    const fulfilledCount = [res1, res2].filter((r) => r.status === 'fulfilled').length;
    const rejected = [res1, res2].filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    assert.strictEqual(fulfilledCount, 1, 'Exactly one parent update should succeed');
    assert.strictEqual(rejected.length, 1, 'Second concurrent parent update forming a cycle must be rejected');
    assert.ok(rejected[0].reason instanceof BadRequestException);
    assert.notStrictEqual(
      categories.get('1').parentCategoryId && categories.get('2').parentCategoryId
        ? `${categories.get('1').parentCategoryId}:${categories.get('2').parentCategoryId}`
        : 'no-cycle',
      '2:1',
      'Committed categories must never form A -> B -> A cycle',
    );
  });

  // ---------------------------------------------------------------------------
  // #15: ConfirmPairingDto & ProvisioningService / Repository enforce PostgreSQL BIGINT bounds (1..9223372036854775807)
  // ---------------------------------------------------------------------------
  await check('#15 ConfirmPairingDto and ProvisioningService/Repo enforce 1 <= productId <= BIGINT_MAX (400 on overflow/invalid)', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const meta: ArgumentMetadata = { type: 'body', metatype: ConfirmPairingDto };

    // Missing productId
    await assert.rejects(
      () => pipe.transform({ buttonName: 'Kitchen' }, meta),
      (err: any) => err instanceof BadRequestException,
    );
    // Invalid formats and BIGINT overflow values
    for (const badProductId of [
      '',
      '   ',
      '01',
      'abc',
      0,
      -5,
      1.5,
      null,
      '9223372036854775808',
      '99999999999999999999',
      Number('9223372036854775808'),
    ]) {
      await assert.rejects(
        () => pipe.transform({ buttonName: 'Kitchen', productId: badProductId }, meta),
        (err: any) => err instanceof BadRequestException,
        `ConfirmPairingDto should reject productId=${JSON.stringify(badProductId)}`,
      );
    }

    // Valid string, number, and exact PostgreSQL BIGINT_MAX pass cleanly
    const validStr = await pipe.transform({ buttonName: 'Kitchen', productId: '123' }, meta);
    const validNum = await pipe.transform({ buttonName: 'Kitchen', productId: 123 }, meta);
    const validBigIntMax = await pipe.transform(
      { buttonName: 'Kitchen', productId: '9223372036854775807' },
      meta,
    );
    assert.strictEqual(validStr.productId, '123');
    assert.strictEqual(validNum.productId, 123);
    assert.strictEqual(validBigIntMax.productId, '9223372036854775807');

    // Direct repository & service calls enforce same BIGINT bounds without 500
    const provRepo = new ProvisioningRepository({
      $transaction: async (cb: any) =>
        cb({
          $queryRawUnsafe: async (sql: string) => {
            if (sql.includes('provisioning_sessions')) {
              return [{ session_id: 'sess-1', status: 'ACTIVE', expires_at: new Date(Date.now() + 60000), claimed_by: null, device_id: BigInt(10) }];
            }
            if (sql.includes('iot_button')) {
              return [{ button_id: BigInt(10), device_id: 'SOB-10', store_id: BigInt(1), button_name: 'Btn' }];
            }
            return [];
          },
        }),
    } as any);

    for (const badDirectId of [undefined, '', '0', '-1', '9223372036854775808', 1.5]) {
      await assert.rejects(
        () => provRepo.confirmPairingAtomicTx('sess-1', BigInt(1), { buttonName: 'Kitchen', productId: badDirectId as any }),
        (err: any) => typeof err?.message === 'string' && err.message.startsWith('BAD_REQUEST:'),
      );
    }

    const provService = new ProvisioningService(
      provRepo,
      { decrypt: () => '' } as any,
      { emitToStore: () => { } } as any,
    );
    for (const badSvcId of [undefined, '9223372036854775808', 0, 1.5]) {
      await assert.rejects(
        () => provService.confirmPairing('sess-1', { buttonName: 'Kitchen', productId: badSvcId } as any, { customerProfileId: '1' }),
        (err: any) => err instanceof BadRequestException,
      );
    }
  });

  console.log(`\n🎉 ALL ${passed}/${passed} BATCH-1 VERIFICATION CHECKS PASSED!\n`);
}

runTests().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});

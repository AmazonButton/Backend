import 'reflect-metadata';
import * as assert from 'assert';
import * as crypto from 'crypto';
import { Module, ValidationPipe, BadRequestException } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
// Load controllers and dependencies from compiled dist for consistent DI token equality
const { CustomerBankWebhookController } = require('../dist/src/customers/customer-bank-webhook.controller');
const { CustomerBankPennyVerificationService: CustomerBankPennyVerificationServiceToken } = require('../dist/src/customers/customer-bank-penny-verification.service');
const { OrdersController } = require('../dist/src/orders/orders.controller');
const { OrdersService: OrdersServiceToken } = require('../dist/src/orders/orders.service');
const { IotController } = require('../dist/src/iot/iot.controller');
const { IotService: IotServiceToken } = require('../dist/src/iot/iot.service');
const { DevicesRepository } = require('../dist/src/devices/devices.repository');
const { CryptoService } = require('../dist/src/security/crypto.service');

import { PayosWebhookPayloadDto } from '../src/customers/dto/payos-webhook-payload.dto';
import { SimulateButtonPressDto } from '../src/orders/dto/simulate-button-press.dto';
import { IotTelemetryDto } from '../src/iot/dto/iot-telemetry.dto';
import { IotEventType, IotPaymentMethod } from '../src/iot/dto/iot-event.dto';
import { CustomerBankPennyVerificationService } from '../src/customers/customer-bank-penny-verification.service';
import { OrdersService } from '../src/orders/orders.service';
import { IotService } from '../src/iot/iot.service';
const { JwtAuthGuard } = require('../dist/src/common/guards/jwt-auth.guard');
const { RolesGuard } = require('../dist/src/common/guards/roles.guard');
const { HmacAuthGuard } = require('../dist/src/common/guards/hmac-auth.guard');
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { signWebhookData } from '../src/payments/payos.helper';

async function runHttpContractValidationTests() {
  console.log('================================================================');
  console.log('🔒 SUITE 75: HTTP Contract Validation & DTO Regression Tests');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✔ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ [FAIL] ${name}:`, err.message);
      failed++;
    }
  }

  // Exact configuration used in main.ts
  const validationPipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  // Helper to run ValidationPipe transformation & validation on a DTO target
  async function transformAndValidate<T extends object>(dtoClass: new () => T, body: any): Promise<T> {
    return (await validationPipe.transform(body, {
      type: 'body',
      metatype: dtoClass,
    })) as T;
  }

  // ============================================================================
  // SECTION 1: PayOS Webhook Payload Contract Unit Tests (Fix 1)
  // ============================================================================
  console.log('[SECTION 1] PayOS Webhook Payload Contract (@IsBoolean success & HMAC preservation)');
  {
    await test('1.1 Standard PayOS webhook payload with success=true passes ValidationPipe', async () => {
      const validPayload = {
        code: '00',
        desc: 'success',
        success: true,
        data: {
          orderCode: 123456,
          amount: 2000,
          description: 'Xac minh tai khoan 123456',
          accountNumber: '0123456789',
          reference: 'TF123456',
          transactionDateTime: '2026-03-30 12:00:00',
          currency: 'VND',
          paymentLinkId: 'plink_123',
          code: '00',
          desc: 'success',
        },
        signature: 'c2e821bb46c7dc8c23101c5d0124357df87455d315264b3ef133b3a726615714',
      };

      const result = await transformAndValidate(PayosWebhookPayloadDto, validPayload);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.code, '00');
      assert.strictEqual(result.data.orderCode, 123456);
      assert.strictEqual(result.data.amount, 2000);
      assert.strictEqual(typeof result.data, 'object');
    });

    await test('1.2 PayOS webhook payload missing success field is rejected with 400', async () => {
      const payloadWithoutSuccess = {
        code: '00',
        desc: 'success',
        data: { orderCode: 123456 },
        signature: 'valid_looking_sig',
      };

      await assert.rejects(
        () => transformAndValidate(PayosWebhookPayloadDto, payloadWithoutSuccess),
        (err: any) => {
          assert.strictEqual(err instanceof BadRequestException, true);
          const response = err.getResponse();
          const messages = Array.isArray(response.message) ? response.message : [response.message];
          assert.ok(messages.some((m: string) => m.includes('success')));
          return true;
        },
      );
    });

    await test('1.3 PayOS webhook payload with non-whitelisted field is rejected by forbidNonWhitelisted', async () => {
      const payloadWithExtraneous = {
        code: '00',
        desc: 'success',
        success: true,
        data: { orderCode: 123456 },
        signature: 'valid_looking_sig',
        maliciousExtraField: 'injected_data',
      };

      await assert.rejects(
        () => transformAndValidate(PayosWebhookPayloadDto, payloadWithExtraneous),
        (err: any) => {
          assert.strictEqual(err instanceof BadRequestException, true);
          const response = err.getResponse();
          const messages = Array.isArray(response.message) ? response.message : [response.message];
          assert.ok(messages.some((m: string) => m.includes('property maliciousExtraField should not exist')));
          return true;
        },
      );
    });

    await test('1.4 Raw transaction data object preserved without stripping inner fields for HMAC verification', async () => {
      const payloadWithNestedData = {
        code: '00',
        desc: 'success',
        success: true,
        data: {
          orderCode: 998877,
          amount: 2000,
          customMetadata: 'test-metadata-nested',
          arbitraryNestedAttr: 42,
        },
        signature: 'some_sig',
      };

      const result = await transformAndValidate(PayosWebhookPayloadDto, payloadWithNestedData);
      assert.strictEqual(result.data.orderCode, 998877);
      assert.strictEqual(result.data.customMetadata, 'test-metadata-nested');
      assert.strictEqual(result.data.arbitraryNestedAttr, 42);
    });

    await test('1.5 PayOS webhook service rejects invalid signature with 400 without calling actual repository query/mutation methods', async () => {
      const originalChecksumKey = process.env.PAYOS_CHECKSUM_KEY;
      process.env.PAYOS_CHECKSUM_KEY = 'test_checksum_key_123456';

      let findSessionCalls = 0;
      let recordInboundCalls = 0;
      let findInboundRefCalls = 0;

      // Real CustomersRepository methods used by CustomerBankPennyVerificationService
      const mockRepo: any = {
        findVerificationSessionByOrderCode: async () => {
          findSessionCalls++;
          return null;
        },
        findInboundTransactionByProviderRef: async () => {
          findInboundRefCalls++;
          return null;
        },
        recordInboundTransactionAndObligationAtomicTx: async () => {
          recordInboundCalls++;
          return { inboundTxId: 1n };
        },
      };

      const service = new CustomerBankPennyVerificationService(mockRepo);

      const invalidSigPayload = {
        code: '00',
        desc: 'success',
        success: true,
        data: {
          orderCode: 999999,
          amount: 2000,
          description: 'Fake payment',
        },
        signature: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      await assert.rejects(
        () => service.processPayosVerificationWebhook(invalidSigPayload),
        (err: any) => {
          assert.strictEqual(err instanceof BadRequestException, true);
          assert.ok(err.message.includes('Chữ ký webhook không hợp lệ'));
          return true;
        },
      );

      assert.strictEqual(findSessionCalls, 0, 'findVerificationSessionByOrderCode must NOT be called on invalid signature');
      assert.strictEqual(findInboundRefCalls, 0, 'findInboundTransactionByProviderRef must NOT be called on invalid signature');
      assert.strictEqual(recordInboundCalls, 0, 'recordInboundTransactionAndObligationAtomicTx must NOT be called on invalid signature');

      if (originalChecksumKey) {
        process.env.PAYOS_CHECKSUM_KEY = originalChecksumKey;
      } else {
        delete process.env.PAYOS_CHECKSUM_KEY;
      }
    });
  }

  // ============================================================================
  // SECTION 2: Simulate Button Press Contract & Shipping Fee Integrity (Fix 2)
  // ============================================================================
  console.log('\n[SECTION 2] Simulate Button Press Contract & Server Shipping Fee Integrity');
  {
    await test('2.1 SimulateButtonPressDto accepts valid supported fields (deviceId, eventType, requestId, paymentMethod)', async () => {
      const validSimBody = {
        deviceId: 'BTN-8829-WTR',
        eventType: IotEventType.SINGLE_PRESS,
        requestId: 'req_sim_98765',
        paymentMethod: IotPaymentMethod.COD,
      };

      const result = await transformAndValidate(SimulateButtonPressDto, validSimBody);
      assert.strictEqual(result.deviceId, 'BTN-8829-WTR');
      assert.strictEqual(result.eventType, IotEventType.SINGLE_PRESS);
      assert.strictEqual(result.requestId, 'req_sim_98765');
      assert.strictEqual(result.paymentMethod, IotPaymentMethod.COD);
    });

    await test('2.2 SimulateButtonPressDto accepts string enum values (DOUBLE_PRESS, PAYOS)', async () => {
      const validStringEnumBody = {
        buttonCode: 'BTN-8829',
        eventType: 'DOUBLE_PRESS',
        paymentMethod: 'PAYOS',
      };

      const result = await transformAndValidate(SimulateButtonPressDto, validStringEnumBody);
      assert.strictEqual(result.buttonCode, 'BTN-8829');
      assert.strictEqual(result.eventType, 'DOUBLE_PRESS');
      assert.strictEqual(result.paymentMethod, 'PAYOS');
    });

    await test('2.3 Client-supplied shippingFee in simulate-button-press is rejected by ValidationPipe (anti-tampering)', async () => {
      const tamperedFeeBody = {
        deviceId: 'BTN-8829-WTR',
        eventType: 'SINGLE_PRESS',
        shippingFee: 5000, // Client attempting to dictate or tamper with shipping fee
      };

      await assert.rejects(
        () => transformAndValidate(SimulateButtonPressDto, tamperedFeeBody),
        (err: any) => {
          assert.strictEqual(err instanceof BadRequestException, true);
          const response = err.getResponse();
          const messages = Array.isArray(response.message) ? response.message : [response.message];
          assert.ok(messages.some((m: string) => m.includes('property shippingFee should not exist')));
          return true;
        },
      );
    });

    await test('2.4 OrdersService.simulateButtonPress enforces fixed platform zero-fee policy (0đ) regardless of client inputs', async () => {
      let passedShippingFee: number | undefined;
      const mockOrdersRepo: any = {
        findButtonByIdentifier: async (id: string) => ({
          buttonId: 101n,
          deviceId: id,
          status: 'ACTIVE',
          canOrder: true,
          customerId: 500n,
          storeId: 10n,
          buttonProducts: [{ productId: 1n, quantity: 1, product: { basePrice: 50000 } }],
        }),
        findOrderByButtonAndRequestId: async () => null,
        executeSpCreateOrder: async (_btnId: any, _method: any, shippingFee: number) => {
          passedShippingFee = shippingFee;
          return 999n;
        },
        findOrderById: async (id: bigint) => ({
          orderId: id,
          orderCode: 'ORD-TEST-123',
          storeId: 10n,
          customerId: 500n,
          totalAmount: 50000,
          shippingFee: passedShippingFee,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      };

      const mockEventsGateway: any = {
        emitToStore: () => {},
        emitToCustomer: () => {},
      };

      const service = new OrdersService(
        mockOrdersRepo,
        {} as any, // cryptoService
        mockEventsGateway,
        {} as any, // storeWalletService
        undefined, // notificationsService
        undefined, // dashboardCacheService
      );

      const simDto: SimulateButtonPressDto = {
        deviceId: 'BTN-8829-WTR',
        eventType: IotEventType.SINGLE_PRESS,
        requestId: 'sim_unique_test_1',
        paymentMethod: IotPaymentMethod.COD,
      };

      const mockCustomerUser = {
        role: 'CUSTOMER',
        customerProfileId: '500',
      };

      const result = await service.simulateButtonPress(simDto, mockCustomerUser);
      assert.strictEqual(result.success, true);
      assert.strictEqual(passedShippingFee, 0, 'Server must enforce fixed 0đ platform policy for IoT button reorders');
    });
  }

  // ============================================================================
  // SECTION 3: IoT Telemetry Bounds & Integer Validation Unit Tests (Fix 3)
  // ============================================================================
  console.log('\n[SECTION 3] IoT Telemetry Bounds & Integer Enforcements');
  {
    await test('3.1 Valid telemetry boundary values (battery: 0, 100; rssi: -150, 0) pass validation', async () => {
      const boundaryMin = await transformAndValidate(IotTelemetryDto, { battery: 0, rssi: -150 });
      assert.strictEqual(boundaryMin.battery, 0);
      assert.strictEqual(boundaryMin.rssi, -150);

      const boundaryMax = await transformAndValidate(IotTelemetryDto, { battery: 100, rssi: 0 });
      assert.strictEqual(boundaryMax.battery, 100);
      assert.strictEqual(boundaryMax.rssi, 0);
    });

    await test('3.2 Floating point values for battery (50.5) and rssi (-55.2) are rejected', async () => {
      await assert.rejects(
        () => transformAndValidate(IotTelemetryDto, { battery: 50.5 }),
        (err: any) => {
          const response = err.getResponse();
          const messages = Array.isArray(response.message) ? response.message : [response.message];
          assert.ok(messages.some((m: string) => m.includes('battery phải là số nguyên')));
          return true;
        },
      );

      await assert.rejects(
        () => transformAndValidate(IotTelemetryDto, { rssi: -55.2 }),
        (err: any) => {
          const response = err.getResponse();
          const messages = Array.isArray(response.message) ? response.message : [response.message];
          assert.ok(messages.some((m: string) => m.includes('rssi phải là số nguyên')));
          return true;
        },
      );
    });

    await test('3.3 Out of range telemetry values (battery: -1, 101; rssi: 1, -151) are rejected', async () => {
      await assert.rejects(
        () => transformAndValidate(IotTelemetryDto, { battery: -1 }),
        (err: any) => {
          const response = err.getResponse();
          const messages = Array.isArray(response.message) ? response.message : [response.message];
          assert.ok(messages.some((m: string) => m.includes('battery tối thiểu 0%')));
          return true;
        },
      );

      await assert.rejects(
        () => transformAndValidate(IotTelemetryDto, { battery: 101 }),
        (err: any) => {
          const response = err.getResponse();
          const messages = Array.isArray(response.message) ? response.message : [response.message];
          assert.ok(messages.some((m: string) => m.includes('battery tối đa 100%')));
          return true;
        },
      );

      await assert.rejects(
        () => transformAndValidate(IotTelemetryDto, { rssi: 1 }),
        (err: any) => {
          const response = err.getResponse();
          const messages = Array.isArray(response.message) ? response.message : [response.message];
          assert.ok(messages.some((m: string) => m.includes('rssi không hợp lệ')));
          return true;
        },
      );

      await assert.rejects(
        () => transformAndValidate(IotTelemetryDto, { rssi: -151 }),
        (err: any) => {
          const response = err.getResponse();
          const messages = Array.isArray(response.message) ? response.message : [response.message];
          assert.ok(messages.some((m: string) => m.includes('rssi không hợp lệ')));
          return true;
        },
      );
    });

    await test('3.4 Telemetry with non-whitelisted property is rejected by forbidNonWhitelisted', async () => {
      await assert.rejects(
        () => transformAndValidate(IotTelemetryDto, { battery: 85, extraSensorPayload: 'unauthorized' }),
        (err: any) => {
          const response = err.getResponse();
          const messages = Array.isArray(response.message) ? response.message : [response.message];
          assert.ok(messages.some((m: string) => m.includes('property extraSensorPayload should not exist')));
          return true;
        },
      );
    });
  }

  // ============================================================================
  // SECTION 4: Real HTTP Integration Tests (Nest Application with Mock Repositories)
  // ============================================================================
  console.log('\n[SECTION 4] Real HTTP Pipeline Integration Tests (Nest App, Controller, Global ValidationPipe & Spies)');

  const testChecksumKey = 'integration_test_checksum_key_889900';
  const origChecksumKey = process.env.PAYOS_CHECKSUM_KEY;
  process.env.PAYOS_CHECKSUM_KEY = testChecksumKey;

  // Real Repository Spies
  const httpSpies = {
    // Customers Repository
    findVerificationSessionByOrderCodeCalls: 0,
    recordInboundTransactionAndObligationAtomicTxCalls: 0,
    findInboundTransactionByProviderRefCalls: 0,
    // Orders Repository
    findButtonByIdentifierCalls: 0,
    executeSpCreateOrderCalls: 0,
    lastPassedShippingFee: undefined as number | undefined,
    // IoT Service
    handleTelemetryCalls: 0,
    lastTelemetryBody: undefined as any,
  };

  const mockCustomersRepo: any = {
    findVerificationSessionByOrderCode: async (orderCode: bigint) => {
      httpSpies.findVerificationSessionByOrderCodeCalls++;
      return {
        id: 200n,
        customerId: 500n,
        orderCode,
        status: 'PENDING',
      };
    },
    findInboundTransactionByProviderRef: async () => {
      httpSpies.findInboundTransactionByProviderRefCalls++;
      return null; // No duplicate
    },
    recordInboundTransactionAndObligationAtomicTx: async () => {
      httpSpies.recordInboundTransactionAndObligationAtomicTxCalls++;
      return {
        inboundTxId: 10n,
        obligationId: 10n,
        verificationResult: 'MATCHED_PENDING_REFUND',
        matchDecision: 'MATCHED',
        shouldActivate: false,
      };
    },
    isStoreVerificationTransaction: async () => false,
  };

  const mockOrdersRepo: any = {
    findButtonByIdentifier: async (id: string) => {
      httpSpies.findButtonByIdentifierCalls++;
      return {
        buttonId: 101n,
        deviceId: id,
        status: 'ACTIVE',
        canOrder: true,
        customerId: 500n,
        storeId: 10n,
        buttonProducts: [{ productId: 1n, quantity: 1, product: { basePrice: 50000 } }],
      };
    },
    findOrderByButtonAndRequestId: async () => null,
    executeSpCreateOrder: async (_btnId: any, _method: any, shippingFee: number) => {
      httpSpies.executeSpCreateOrderCalls++;
      httpSpies.lastPassedShippingFee = shippingFee;
      return 888n;
    },
    findOrderById: async (id: bigint) => ({
      orderId: id,
      orderCode: 'ORD-HTTP-123',
      storeId: 10n,
      customerId: 500n,
      totalAmount: 50000,
      shippingFee: httpSpies.lastPassedShippingFee,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  };

  const mockEventsGateway: any = {
    emitToStore: () => {},
    emitToCustomer: () => {},
  };

  const httpPennyService = new CustomerBankPennyVerificationService(mockCustomersRepo);
  const httpOrdersService = new OrdersService(
    mockOrdersRepo,
    {} as any,
    mockEventsGateway,
    {} as any,
    undefined,
    undefined,
  );
  const mockIotService: any = {
    handleTelemetry: async (device: any, body: any) => {
      httpSpies.handleTelemetryCalls++;
      httpSpies.lastTelemetryBody = body;
      return {
        success: true,
        message: 'Ghi nhận thông số telemetry thành công',
        data: {
          deviceId: device.deviceId,
          battery: body.battery ?? 100,
          rssi: body.rssi ?? -50,
        },
      };
    },
  };

  class HttpIntegrationModule {}
  Module({
    controllers: [CustomerBankWebhookController, OrdersController, IotController],
    providers: [
      { provide: CustomerBankPennyVerificationServiceToken, useValue: httpPennyService },
      { provide: OrdersServiceToken, useValue: httpOrdersService },
      { provide: IotServiceToken, useValue: mockIotService },
      { provide: DevicesRepository, useValue: {} },
      { provide: CryptoService, useValue: {} },
      { provide: Reflector, useValue: new Reflector() },
    ],
  })(HttpIntegrationModule);

  // Hook guards for HTTP integration
  const origJwtGuard = JwtAuthGuard.prototype.canActivate;
  const origRolesGuard = RolesGuard.prototype.canActivate;
  const origHmacGuard = HmacAuthGuard.prototype.canActivate;

  JwtAuthGuard.prototype.canActivate = (ctx: any) => {
    const req = ctx.switchToHttp().getRequest();
    req.user = { userId: '500', role: 'CUSTOMER', customerProfileId: '500' };
    return true;
  };
  RolesGuard.prototype.canActivate = () => true;
  HmacAuthGuard.prototype.canActivate = (ctx: any) => {
    const req = ctx.switchToHttp().getRequest();
    req.device = { deviceId: 'SOB-001' };
    return true;
  };

  let nestApp: any;
  let baseUrl: string = '';

  try {
    nestApp = await NestFactory.create(HttpIntegrationModule, { logger: false });
    nestApp.setGlobalPrefix('api/v1');
    nestApp.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    nestApp.useGlobalFilters(new AllExceptionsFilter());
    await nestApp.listen(0, '127.0.0.1');
    baseUrl = await nestApp.getUrl();

    const postJson = async (path: string, body: any) => {
      const res = await fetch(`${baseUrl}/api/v1${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    };

    // ------------------------------------------------------------------------
    // HTTP Test 4.1: Authentic PayOS webhook passes pipeline & executes repository
    // ------------------------------------------------------------------------
    await test('4.1 [HTTP] Authentic PayOS webhook with valid signature and success=true returns 200 and calls repository', async () => {
      httpSpies.findVerificationSessionByOrderCodeCalls = 0;
      httpSpies.recordInboundTransactionAndObligationAtomicTxCalls = 0;

      const txData = {
        orderCode: 888111,
        amount: 2000,
        description: 'Xac minh tai khoan 888111',
        accountNumber: '970422123456',
        reference: 'REF_VALID_888111',
        transactionDateTime: '2026-03-30 14:00:00',
        currency: 'VND',
        code: '00',
        desc: 'success',
      };
      const validSig = signWebhookData(txData, testChecksumKey);

      const payload = {
        code: '00',
        desc: 'success',
        success: true,
        data: txData,
        signature: validSig,
      };

      const res = await postJson('/webhooks/payos/customer-bank-verification', payload);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(httpSpies.findVerificationSessionByOrderCodeCalls, 1, 'Repository lookup must be called once');
      assert.strictEqual(httpSpies.recordInboundTransactionAndObligationAtomicTxCalls, 1, 'Inbound transaction must be atomically recorded');
    });

    // ------------------------------------------------------------------------
    // HTTP Test 4.2: Webhook with invalid signature returns 400 and calls 0 repo mutations
    // ------------------------------------------------------------------------
    await test('4.2 [HTTP] Webhook with invalid signature returns 400 and performs zero repository lookups/mutations', async () => {
      httpSpies.findVerificationSessionByOrderCodeCalls = 0;
      httpSpies.recordInboundTransactionAndObligationAtomicTxCalls = 0;

      const txData = {
        orderCode: 888222,
        amount: 2000,
        description: 'Tampered payment',
        accountNumber: '970422123456',
        reference: 'REF_BAD_SIG',
      };

      const payload = {
        code: '00',
        desc: 'success',
        success: true,
        data: txData,
        signature: 'deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd',
      };

      const res = await postJson('/webhooks/payos/customer-bank-verification', payload);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.success, false);
      assert.ok(res.data.message.includes('Chữ ký webhook không hợp lệ'));
      assert.strictEqual(httpSpies.findVerificationSessionByOrderCodeCalls, 0, 'No session lookup on invalid signature');
      assert.strictEqual(httpSpies.recordInboundTransactionAndObligationAtomicTxCalls, 0, 'No atomic transaction record on invalid signature');
    });

    // ------------------------------------------------------------------------
    // HTTP Test 4.3: Webhook with missing success or extra fields returns 400 at ValidationPipe
    // ------------------------------------------------------------------------
    await test('4.3 [HTTP] Webhook with missing success field or forbidden extra field returns 400 with zero service calls', async () => {
      httpSpies.findVerificationSessionByOrderCodeCalls = 0;
      httpSpies.recordInboundTransactionAndObligationAtomicTxCalls = 0;

      // Missing success
      const missingSuccessPayload = {
        code: '00',
        desc: 'success',
        data: { orderCode: 888333 },
        signature: 'some_signature',
      };
      const res1 = await postJson('/webhooks/payos/customer-bank-verification', missingSuccessPayload);
      assert.strictEqual(res1.status, 400);

      // Extra non-whitelisted property
      const extraPropPayload = {
        code: '00',
        desc: 'success',
        success: true,
        data: { orderCode: 888333 },
        signature: 'some_signature',
        injectedMaliciousField: 'exploit',
      };
      const res2 = await postJson('/webhooks/payos/customer-bank-verification', extraPropPayload);
      assert.strictEqual(res2.status, 400);
      assert.ok(JSON.stringify(res2.data).includes('property injectedMaliciousField should not exist'));

      assert.strictEqual(httpSpies.findVerificationSessionByOrderCodeCalls, 0, 'Repository must not be touched');
      assert.strictEqual(httpSpies.recordInboundTransactionAndObligationAtomicTxCalls, 0, 'Repository must not be touched');
    });

    // ------------------------------------------------------------------------
    // HTTP Test 4.4: Simulation with client shippingFee is rejected with 400 with zero order mutations
    // ------------------------------------------------------------------------
    await test('4.4 [HTTP] POST /orders/simulate-button-press with shippingFee is rejected with 400 (Zero Order Mutation)', async () => {
      httpSpies.findButtonByIdentifierCalls = 0;
      httpSpies.executeSpCreateOrderCalls = 0;

      const tamperedSimPayload = {
        deviceId: 'BTN-8829-WTR',
        eventType: 'SINGLE_PRESS',
        shippingFee: 5000, // Prohibited client-dictated shipping fee
      };

      const res = await postJson('/orders/simulate-button-press', tamperedSimPayload);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.success, false);
      assert.ok(JSON.stringify(res.data).includes('property shippingFee should not exist'));

      assert.strictEqual(httpSpies.findButtonByIdentifierCalls, 0, 'findButtonByIdentifier must NOT be called on validation rejection');
      assert.strictEqual(httpSpies.executeSpCreateOrderCalls, 0, 'executeSpCreateOrder must NOT be called on validation rejection');
    });

    // ------------------------------------------------------------------------
    // HTTP Test 4.5: Simulation with valid contract succeeds and server enforces 0đ shipping fee
    // ------------------------------------------------------------------------
    await test('4.5 [HTTP] POST /orders/simulate-button-press with valid contract succeeds and enforces 0đ shipping policy', async () => {
      httpSpies.findButtonByIdentifierCalls = 0;
      httpSpies.executeSpCreateOrderCalls = 0;

      const validSimPayload = {
        deviceId: 'BTN-8829-WTR',
        eventType: 'SINGLE_PRESS',
        requestId: 'sim_http_valid_req_101',
        paymentMethod: 'COD',
      };

      const res = await postJson('/orders/simulate-button-press', validSimPayload);
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.data.success, true);
      assert.ok(httpSpies.findButtonByIdentifierCalls >= 1, 'findButtonByIdentifier must be called');
      assert.strictEqual(httpSpies.executeSpCreateOrderCalls, 1, 'executeSpCreateOrder must be called');
      assert.strictEqual(httpSpies.lastPassedShippingFee, 0, 'Shipping fee must strictly be 0đ according to fixed platform policy');
    });

    // ------------------------------------------------------------------------
    // HTTP Test 4.6: Telemetry with out-of-range or decimal values is rejected with 400
    // ------------------------------------------------------------------------
    await test('4.6 [HTTP] POST /iot/telemetry with decimal float or out-of-bounds numbers returns 400 and calls 0 service handlers', async () => {
      httpSpies.handleTelemetryCalls = 0;

      // Float battery
      const resFloat = await postJson('/iot/telemetry', { battery: 50.5 });
      assert.strictEqual(resFloat.status, 400);
      assert.ok(JSON.stringify(resFloat.data).includes('battery phải là số nguyên'));

      // Out of bounds rssi (e.g. 1 dBm)
      const resOutOfBound = await postJson('/iot/telemetry', { rssi: 1 });
      assert.strictEqual(resOutOfBound.status, 400);
      assert.ok(JSON.stringify(resOutOfBound.data).includes('rssi không hợp lệ'));

      assert.strictEqual(httpSpies.handleTelemetryCalls, 0, 'handleTelemetry must not be executed when validation fails');
    });

    // ------------------------------------------------------------------------
    // HTTP Test 4.7: Telemetry with valid boundary integers succeeds with 200
    // ------------------------------------------------------------------------
    await test('4.7 [HTTP] POST /iot/telemetry with valid boundary integers (battery: 100, rssi: -50) returns 200/201', async () => {
      httpSpies.handleTelemetryCalls = 0;

      const res = await postJson('/iot/telemetry', { battery: 100, rssi: -50 });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(httpSpies.handleTelemetryCalls, 1);
      assert.strictEqual(httpSpies.lastTelemetryBody.battery, 100);
      assert.strictEqual(httpSpies.lastTelemetryBody.rssi, -50);
    });
  } finally {
    if (nestApp) {
      await nestApp.close();
    }
    JwtAuthGuard.prototype.canActivate = origJwtGuard;
    RolesGuard.prototype.canActivate = origRolesGuard;
    HmacAuthGuard.prototype.canActivate = origHmacGuard;

    if (origChecksumKey) {
      process.env.PAYOS_CHECKSUM_KEY = origChecksumKey;
    } else {
      delete process.env.PAYOS_CHECKSUM_KEY;
    }
  }

  console.log('\n================================================================');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed across ${passed + failed} assertions`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runHttpContractValidationTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

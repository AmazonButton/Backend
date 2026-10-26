import { PrismaClient } from '@prisma/client';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { IdempotencyRepository } from '../src/common/idempotency/idempotency.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';

const prisma = new PrismaClient();
const prismaService = new PrismaService();
const idempotencyRepo = new IdempotencyRepository(prismaService);
const idempotencyService = new IdempotencyService(idempotencyRepo);

async function runPhase2IdempotencySuite() {
  console.log('\n================================================================');
  console.log('🚀 SUITE 37: Phase 2 Universal Idempotency Platform (IDEM-01/02/03)');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string) {
    if (condition) {
      console.log(`  ✔ [PASS] ${label}`);
      passed++;
    } else {
      console.error(`  ✖ [FAIL] ${label}`);
      failed++;
    }
  }

  const timestamp = Date.now();
  const testKeysToClean: string[] = [];

  try {
    // -------------------------------------------------------------
    // SECTION 1: Key Validation & Canonical Hashing (IDEM-01)
    // -------------------------------------------------------------
    console.log('--- 1. IDEM-01: Key Format Validation & Deterministic Request Hashing ---');

    // 1.1 Valid keys
    const validKey1 = idempotencyService.validateKey('valid-idemp_key.123:abc');
    assert(validKey1 === 'valid-idemp_key.123:abc', 'Valid IETF format key accepted and normalized');

    // 1.2 Invalid key characters
    let invalidCharCaught = false;
    try {
      idempotencyService.validateKey('invalid@key!#$');
    } catch (e: any) {
      invalidCharCaught = e instanceof BadRequestException;
    }
    assert(invalidCharCaught, 'Keys with invalid special characters rejected with BadRequestException (400)');

    // 1.3 Key exceeding 128 chars
    let tooLongCaught = false;
    try {
      idempotencyService.validateKey('k'.repeat(129));
    } catch (e: any) {
      tooLongCaught = e instanceof BadRequestException;
    }
    assert(tooLongCaught, 'Keys longer than 128 characters rejected with BadRequestException (400)');

    // 1.4 Deterministic JSON object sorting
    const hashA = idempotencyService.computeRequestHash({ a: 1, b: 2, c: { x: 'foo', y: [1, 2, 3] } });
    const hashB = idempotencyService.computeRequestHash({ c: { y: [1, 2, 3], x: 'foo' }, b: 2, a: 1 });
    assert(hashA === hashB, 'Deterministic hashing: recursive key ordering yields identical SHA-256');

    // 1.5 Different payloads yield different hash
    const hashC = idempotencyService.computeRequestHash({ a: 1, b: 3 });
    assert(hashA !== hashC, 'Distinct payload contents generate distinct hashes');

    // -------------------------------------------------------------
    // SECTION 2: Atomic Lock Acquisition, Cache Replay & In-Flight Lock (IDEM-02)
    // -------------------------------------------------------------
    console.log('\n--- 2. IDEM-02: Universal Idempotency Lifecycle & Cache Replay ---');

    const testKey1 = `IDEMP-P2-TEST-${timestamp}-1`;
    testKeysToClean.push(testKey1);
    const testRoute = '/api/v1/storefront/orders';
    const testPayload = { storeId: 10, items: [{ productId: 1, quantity: 2 }] };

    // 2.1 First acquisition: ACQUIRED
    const firstAcquire = await idempotencyService.acquire({
      idempotencyKey: testKey1,
      route: testRoute,
      body: testPayload,
      lockTimeoutMs: 15000,
    });
    assert(firstAcquire.state === 'ACQUIRED', 'First request atomically acquires key in state ACQUIRED');

    // 2.2 Concurrent in-flight request with same key throws ConflictException (409)
    let inFlightCaught = false;
    try {
      await idempotencyService.acquire({
        idempotencyKey: testKey1,
        route: testRoute,
        body: testPayload,
      });
    } catch (e: any) {
      inFlightCaught = e instanceof ConflictException && e.message.includes('IDEMPOTENCY_REQUEST_IN_FLIGHT');
    }
    assert(inFlightCaught, 'Concurrent request blocked with HTTP 409 Conflict (IDEMPOTENCY_REQUEST_IN_FLIGHT)');

    // 2.3 Key reuse with mismatched payload throws UnprocessableEntityException (422)
    let mismatchCaught = false;
    try {
      await idempotencyService.acquire({
        idempotencyKey: testKey1,
        route: testRoute,
        body: { storeId: 10, items: [{ productId: 99, quantity: 5 }] }, // different payload!
      });
    } catch (e: any) {
      mismatchCaught = e instanceof UnprocessableEntityException && e.message.includes('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    }
    assert(mismatchCaught, 'Reused key with altered payload rejected with HTTP 422 Unprocessable Entity');

    // 2.4 Finalize execution with cached result
    if (firstAcquire.state === 'ACQUIRED') {
      const mockResponse = {
        success: true,
        message: 'Order created',
        data: { orderId: 'ORD-P2-888', totalAmount: 250000 },
      };
      await idempotencyService.finalizeSuccess(firstAcquire.recordId, 201, mockResponse);

      // 2.5 Subsequent request returns cached response directly
      const replayAcquire = await idempotencyService.acquire({
        idempotencyKey: testKey1,
        route: testRoute,
        body: testPayload,
      });

      assert(replayAcquire.state === 'CACHED', 'Replayed request returns state CACHED');
      if (replayAcquire.state === 'CACHED') {
        assert(replayAcquire.statusCode === 201, 'Cached status code 201 preserved');
        assert(replayAcquire.responseBody.data.orderId === 'ORD-P2-888', 'Cached response body preserved exactly');
      }
    }

    // -------------------------------------------------------------
    // SECTION 3: Expired Lock Recovery & Client Error Rollback
    // -------------------------------------------------------------
    console.log('\n--- 3. Crash Recovery (Expired Lock) & Client Failure Cleanup ---');

    const testKey2 = `IDEMP-P2-CRASH-${timestamp}`;
    testKeysToClean.push(testKey2);

    // 3.1 Simulate crashed worker with past locked_until
    const expiredLockAcquire = await idempotencyService.acquire({
      idempotencyKey: testKey2,
      route: testRoute,
      body: testPayload,
      lockTimeoutMs: 100, // 100ms
    });
    assert(expiredLockAcquire.state === 'ACQUIRED', 'Initial acquire for crash recovery test succeeded');

    // Wait 250ms for lock to expire
    await new Promise((r) => setTimeout(r, 250));

    // Next acquire should detect expired lock and recover
    const recoveredAcquire = await idempotencyService.acquire({
      idempotencyKey: testKey2,
      route: testRoute,
      body: testPayload,
      lockTimeoutMs: 15000,
    });
    assert(recoveredAcquire.state === 'ACQUIRED', 'Expired lock safely recovered and re-acquired by new request');

    // 3.2 Failure cleanup (e.g. client error) removes record to allow clean retry
    if (recoveredAcquire.state === 'ACQUIRED') {
      await idempotencyService.finalizeFailure(recoveredAcquire.recordId, true);
      const afterFailureAcquire = await idempotencyService.acquire({
        idempotencyKey: testKey2,
        route: testRoute,
        body: testPayload,
      });
      assert(afterFailureAcquire.state === 'ACQUIRED', 'Client failure record deleted, allowing clean retry');
      if (afterFailureAcquire.state === 'ACQUIRED') {
        await idempotencyService.finalizeFailure(afterFailureAcquire.recordId, true);
      }
    }

    // -------------------------------------------------------------
    // SECTION 4: Cross-Scope Integration (IDEM-03: Payments & Rentals)
    // -------------------------------------------------------------
    console.log('\n--- 4. IDEM-03: Payments & Rentals Scope Verification ---');

    const paymentKey = `IDEMP-PAY-${timestamp}`;
    const paymentRoute = '/api/v1/payments/payos/create-link';
    const paymentBody = { orderId: '123', returnUrl: 'https://app.com/success', cancelUrl: 'https://app.com/cancel' };
    testKeysToClean.push(paymentKey);

    const payAcquire1 = await idempotencyService.acquire({
      idempotencyKey: paymentKey,
      route: paymentRoute,
      body: paymentBody,
    });
    assert(payAcquire1.state === 'ACQUIRED', 'Payment route acquires idempotency key cleanly');
    if (payAcquire1.state === 'ACQUIRED') {
      await idempotencyService.finalizeSuccess(payAcquire1.recordId, 200, {
        checkoutUrl: 'https://pay.payos.vn/web/12345',
        paymentLinkId: 'PL_888',
      });
    }

    const payAcquire2 = await idempotencyService.acquire({
      idempotencyKey: paymentKey,
      route: paymentRoute,
      body: paymentBody,
    });
    assert(payAcquire2.state === 'CACHED', 'Payment re-submission returns cached PayOS link without double charge');

    const rentalKey = `IDEMP-RNT-${timestamp}`;
    const rentalRoute = '/api/v1/rentals/123/extensions';
    const rentalBody = { months: 2 };
    testKeysToClean.push(rentalKey);

    const rentAcquire1 = await idempotencyService.acquire({
      idempotencyKey: rentalKey,
      route: rentalRoute,
      body: rentalBody,
    });
    assert(rentAcquire1.state === 'ACQUIRED', 'Rental extension acquires idempotency key cleanly');
    if (rentAcquire1.state === 'ACQUIRED') {
      await idempotencyService.finalizeSuccess(rentAcquire1.recordId, 200, {
        rentalId: '123',
        newMonthsRented: 3,
      });
    }

    const rentAcquire2 = await idempotencyService.acquire({
      idempotencyKey: rentalKey,
      route: rentalRoute,
      body: rentalBody,
    });
    assert(rentAcquire2.state === 'CACHED', 'Rental extension re-submission returns cached extension without double charge');

  } finally {
    // Cleanup test records
    console.log('\n--- Cleaning up Phase 2 test artifacts ---');
    for (const key of testKeysToClean) {
      await prisma.apiIdempotencyKey.deleteMany({
        where: { idempotencyKey: key },
      });
    }
    await prisma.$disconnect();
    await prismaService.$disconnect();
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase2IdempotencySuite().catch((err) => {
  console.error('Fatal Suite 37 error:', err);
  process.exit(1);
});

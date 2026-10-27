import { AppController } from '../src/app.controller';
import { PrismaService } from '../src/prisma/prisma.service';
import { QueueService } from '../src/common/queues/queue.service';
import { ServiceUnavailableException } from '@nestjs/common';

async function runPhase5HealthAndShutdownSuite() {
  console.log('\n================================================================');
  console.log('🚀 SUITE 40: Phase 5 Health Probes & Graceful Shutdown');
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

  const prisma = new PrismaService();
  const queueService = new QueueService();
  await queueService.onModuleInit();
  const appController = new AppController(prisma, queueService);

  try {
    // -------------------------------------------------------------
    // SECTION 1: Liveness Probe (/healthz)
    // -------------------------------------------------------------
    console.log('--- 1. Kubernetes / Docker Liveness Probe (/healthz) ---');
    const liveness = appController.getLiveness();
    assert(liveness.status === 'UP', 'Liveness probe returns status: UP');
    assert(typeof liveness.uptimeSeconds === 'number' && liveness.uptimeSeconds >= 0, 'Liveness probe includes non-negative uptimeSeconds');
    assert(typeof liveness.timestamp === 'string' && !isNaN(Date.parse(liveness.timestamp)), 'Liveness probe includes valid ISO timestamp');

    // -------------------------------------------------------------
    // SECTION 2: Readiness Probe (/readyz) Deep Dependencies
    // -------------------------------------------------------------
    console.log('\n--- 2. Readiness Probe (/readyz) Deep Dependency Health ---');
    const readiness = await appController.getReadiness();
    assert(readiness.status === 'READY', 'Readiness probe returns status: READY');
    assert(readiness.checks.database === 'UP', 'Readiness probe verifies live PostgreSQL connectivity (UP)');
    assert(readiness.checks.queue === 'UP', 'Readiness probe verifies Queue engine (UP)');
    assert(typeof readiness.uptimeSeconds === 'number', 'Readiness probe exports uptime metrics');

    // -------------------------------------------------------------
    // SECTION 3: Fail-Closed Behavior on Database Outage
    // -------------------------------------------------------------
    console.log('\n--- 3. Fail-Closed Resilience on Dependency Failure ---');
    const brokenPrismaMock = {
      $queryRaw: async () => {
        throw new Error('Connection refused by postgres:5432');
      },
    } as any;
    const brokenController = new AppController(brokenPrismaMock, queueService);

    let caughtException: any = null;
    try {
      await brokenController.getReadiness();
    } catch (err: any) {
      caughtException = err;
    }

    assert(caughtException instanceof ServiceUnavailableException, 'Dependency failure throws ServiceUnavailableException (503)');
    const errorResponse: any = caughtException?.getResponse();
    assert(errorResponse?.status === 'UNREADY', 'Unready response status indicates UNREADY');
    assert(errorResponse?.checks?.database === 'DOWN', 'Checks cleanly identifies database as DOWN');

    // Test Queue Dependency Failure
    const brokenQueueServiceMock = {
      isReady: async () => false,
    } as any;
    const brokenQueueController = new AppController(prisma, brokenQueueServiceMock);
    let queueFailureException: any = null;
    try {
      await brokenQueueController.getReadiness();
    } catch (err: any) {
      queueFailureException = err;
    }
    assert(queueFailureException instanceof ServiceUnavailableException, 'Queue dependency failure throws ServiceUnavailableException (503)');
    const queueErrorResponse: any = queueFailureException?.getResponse();
    assert(queueErrorResponse?.checks?.queue === 'DOWN', 'Checks cleanly identifies queue as DOWN when isReady is false');

    // Test Server Draining State (Zero Downtime Kubernetes Rolling Update Invariant)
    AppController.isDraining = true;
    let drainingException: any = null;
    try {
      await appController.getReadiness();
    } catch (err: any) {
      drainingException = err;
    }
    AppController.isDraining = false; // Reset back to false for further requests
    assert(drainingException instanceof ServiceUnavailableException, 'Readiness probe immediately returns 503 when server starts draining');
    const drainingResponse: any = drainingException?.getResponse();
    assert(drainingResponse?.checks?.server === 'DRAINING', 'Readiness probe exports server: DRAINING check');

    // -------------------------------------------------------------
    // SECTION 4: Signal Registration & Graceful Teardown Verification
    // -------------------------------------------------------------
    console.log('\n--- 4. Graceful Shutdown & Signal Handlers ---');
    // Verify QueueService.onModuleDestroy drains and stops worker loop
    await queueService.onModuleDestroy();
    const isReadyAfterDestroy = await queueService.isReady();
    assert(isReadyAfterDestroy === false, 'QueueService.isReady returns false after onModuleDestroy');
    assert((queueService as any).workerInterval === null, 'Worker polling interval cleared on destroy');

  } finally {
    await queueService.onModuleDestroy();
    await prisma.$disconnect();
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runPhase5HealthAndShutdownSuite().catch((err) => {
  console.error('Fatal Suite 40 error:', err);
  process.exit(1);
});

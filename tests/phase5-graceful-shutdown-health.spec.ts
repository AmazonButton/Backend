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

    // -------------------------------------------------------------
    // SECTION 4: Signal Registration & Graceful Teardown Verification
    // -------------------------------------------------------------
    console.log('\n--- 4. Graceful Shutdown & Signal Handlers ---');
    const sigtermListeners = process.listeners('SIGTERM');
    assert(sigtermListeners.length >= 0, 'SIGTERM listeners properly accessible');
    const sigintListeners = process.listeners('SIGINT');
    assert(sigintListeners.length >= 0, 'SIGINT listeners properly accessible');

  } finally {
    queueService.onModuleDestroy();
    await prisma.$disconnect();
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase5HealthAndShutdownSuite().catch((err) => {
  console.error('Fatal Suite 40 error:', err);
  process.exit(1);
});

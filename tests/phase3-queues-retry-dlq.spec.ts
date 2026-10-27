import { QueueService } from '../src/common/queues/queue.service';
import { QueueJob } from '../src/common/queues/queue.interface';

async function runPhase3QueueSuite() {
  console.log('\n================================================================');
  console.log('🚀 SUITE 38: Phase 3 Asynchronous Queues, Backoff Retry & DLQ');
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

  const queueService = new QueueService();
  await queueService.onModuleInit();

  try {
    // -------------------------------------------------------------
    // SECTION 1: Asynchronous Enqueue & Processing
    // -------------------------------------------------------------
    console.log('--- 1. Asynchronous Job Enqueue & Background Execution ---');

    let processedJobData: any = null;
    queueService.registerProcessor('test-success-queue', async (job: QueueJob) => {
      processedJobData = job.data;
      return true;
    });

    const enqueueStart = Date.now();
    const jobId = await queueService.enqueueJob('test-success-queue', 'send-welcome', {
      email: 'test@amazonbutton.vn',
      name: 'Tris',
    });
    const enqueueDuration = Date.now() - enqueueStart;

    assert(typeof jobId === 'string' && jobId.startsWith('job_'), 'Job enqueued and returned unique job ID');
    assert(enqueueDuration < 20, `Enqueue returned non-blocking in ${enqueueDuration}ms (<20ms)`);

    // Wait for worker loop to pick up and process job
    await new Promise((r) => setTimeout(r, 150));

    assert(processedJobData !== null, 'Background worker picked up and processed job asynchronously');
    assert(processedJobData?.email === 'test@amazonbutton.vn', 'Job data payload preserved accurately');

    // -------------------------------------------------------------
    // SECTION 2: Bounded Exponential Backoff Retry
    // -------------------------------------------------------------
    console.log('\n--- 2. Bounded Exponential Backoff Retry Engine ---');

    let retryAttempts = 0;
    queueService.registerProcessor('test-retry-queue', async (job: QueueJob) => {
      retryAttempts++;
      if (retryAttempts < 3) {
        throw new Error(`Transient network glitch on attempt ${retryAttempts}`);
      }
      return 'success-after-retries';
    });

    await queueService.enqueueJob(
      'test-retry-queue',
      'flakey-job',
      { action: 'fetch-external-status' },
      {
        attempts: 3,
        backoffDelayMs: 60,
        backoffType: 'exponential',
      },
    );

    // Wait for retries to complete (accounting for exponential backoff + jitter)
    const startRetryWait = Date.now();
    while (retryAttempts < 3 && Date.now() - startRetryWait < 1500) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert(retryAttempts === 3, `Job retried across failed attempts: expected 3, got ${retryAttempts}`);

    // -------------------------------------------------------------
    // SECTION 3: Dead-Letter Queue (DLQ) for Exhausted Jobs
    // -------------------------------------------------------------
    console.log('\n--- 3. Dead-Letter Queue (DLQ) & Exhausted Job Isolation ---');

    let permanentFailAttempts = 0;
    queueService.registerProcessor('test-dlq-queue', async (job: QueueJob) => {
      permanentFailAttempts++;
      throw new Error(`Critical permanent failure (code: HARD_REJECT_${permanentFailAttempts})`);
    });

    const dlqTargetJobId = await queueService.enqueueJob(
      'test-dlq-queue',
      'fatal-payment-callback',
      { orderId: 'ORD-999', amount: 500000 },
      {
        attempts: 2,
        backoffDelayMs: 40,
        backoffType: 'fixed',
      },
    );

    // Wait for 2 attempts to fail and be moved to DLQ
    for (let i = 0; i < 30 && permanentFailAttempts < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert(permanentFailAttempts === 2, `Exhausted all configured max attempts (2): got ${permanentFailAttempts}`);

    let deadJobs = await queueService.getDeadLetterJobs('test-dlq-queue');
    for (let i = 0; i < 20 && deadJobs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      deadJobs = await queueService.getDeadLetterJobs('test-dlq-queue');
    }
    assert(deadJobs.length === 1, 'Exhausted job cleanly transferred to Dead-Letter Queue (DLQ)');

    const deadJob = deadJobs[0];
    assert(deadJob.jobName === 'fatal-payment-callback', 'DLQ job name preserved');
    assert(deadJob.attemptsMade === 2, 'DLQ recorded attemptsMade: 2');
    assert(deadJob.status === 'DEAD', 'DLQ status marked as DEAD');
    assert(deadJob.failedReason.includes('HARD_REJECT_2'), 'DLQ captured final error reason');
    assert(deadJob.data.orderId === 'ORD-999', 'DLQ payload retained without loss');

    // -------------------------------------------------------------
    // SECTION 4: DLQ Inspection & Recovery / Replay
    // -------------------------------------------------------------
    let shouldFail = true;
    let recoveredData: any = null;
    queueService.registerProcessor('test-recovery-queue', async (job: QueueJob) => {
      if (shouldFail) {
        throw new Error('Initial crash');
      }
      recoveredData = job.data;
      return true;
    });

    // Enqueue job that will fail once and move to DLQ
    await queueService.enqueueJob(
      'test-recovery-queue',
      'recoverable-job',
      { accountId: 'ACC-123' },
      { attempts: 1 },
    );

    let recoveryDeadJobs = await queueService.getDeadLetterJobs('test-recovery-queue');
    for (let i = 0; i < 30 && recoveryDeadJobs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      recoveryDeadJobs = await queueService.getDeadLetterJobs('test-recovery-queue');
    }
    assert(recoveryDeadJobs.length >= 1, 'Job in DLQ ready for admin replay');

    // Enable success on replay
    shouldFail = false;

    const replayed = await queueService.retryDeadLetterJob(recoveryDeadJobs[0].id);
    assert(replayed === true, 'retryDeadLetterJob succeeded and restored job to queue');

    for (let i = 0; i < 30 && !recoveredData; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(recoveredData !== null && recoveredData.accountId === 'ACC-123', 'Replayed job successfully executed');

    // Clear DLQ
    const cleared = await queueService.clearDeadLetterJobs();
    assert(cleared >= 1, `Dead letter jobs cleared cleanly: ${cleared} removed`);
    const remainingDeadJobs = await queueService.getDeadLetterJobs();
    assert(remainingDeadJobs.length === 0, 'DLQ is empty after clearing');

    // -------------------------------------------------------------
    // SECTION 5: Queue Statistics Reporting
    // -------------------------------------------------------------
    console.log('\n--- 5. Queue Statistics & Health Metrics ---');
    let stats = queueService.getQueueStats();
    let testQueueStat = stats.find((s) => s.queueName === 'test-success-queue');
    for (let i = 0; i < 20 && (!testQueueStat || testQueueStat.completed < 1); i++) {
      await new Promise((r) => setTimeout(r, 50));
      stats = queueService.getQueueStats();
      testQueueStat = stats.find((s) => s.queueName === 'test-success-queue');
    }
    assert(Array.isArray(stats) && stats.length > 0, 'Queue statistics exported');
    assert(testQueueStat !== undefined && testQueueStat.completed >= 1, 'Queue metrics accurately count completed jobs');

  } finally {
    await queueService.onModuleDestroy();
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runPhase3QueueSuite().catch((err) => {
  console.error('Fatal Suite 38 error:', err);
  process.exit(1);
});

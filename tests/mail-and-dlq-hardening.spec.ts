import * as assert from 'assert';
import { MailService } from '../src/mail/mail.service';
import { QueueService } from '../src/common/queues/queue.service';

async function runTests() {
  console.log('================================================================================');
  console.log('🧪 TEST SUITE: Mail IPv4 / HTTPS Port 443 Hardening & DLQ OTP Redaction (TDD)');
  console.log('================================================================================\n');

  const origEnv = { ...process.env };
  const origFetch = global.fetch;

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✔ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✖ [FAIL] ${name} -> ${err?.message || err}`);
      failed++;
    } finally {
      process.env = { ...origEnv };
      global.fetch = origFetch;
    }
  }

  // Test 1: Resend HTTPS API (Port 443)
  await test('1. Resend HTTPS API dispatches email over port 443 without SMTP', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RESEND_API_KEY = 're_test_12345';
    process.env.SMTP_FROM = 'Smart Order <noreply@smartorder.vn>';
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    delete process.env.SMTP_PASS;
    delete process.env.BREVO_API_KEY;

    let capturedUrl = '';
    let capturedInit: any = null;
    global.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ id: 'email_resend_001' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as any;

    const mailService = new MailService();
    const ok = await mailService.sendMail(
      {
        to: 'customer.real@gmail.com',
        subject: '[Smart Order] Mã OTP xác minh tài khoản',
        text: 'Mã OTP: 123456',
        html: '<p>Mã OTP: <b>123456</b></p>',
      },
      true,
    );

    assert.strictEqual(ok, true);
    assert.strictEqual(capturedUrl, 'https://api.resend.com/emails');
    assert.strictEqual(capturedInit.headers['Authorization'], 'Bearer re_test_12345');
    const body = JSON.parse(capturedInit.body);
    assert.deepStrictEqual(body.to, ['customer.real@gmail.com']);
  });

  // Test 2: Brevo HTTPS API (Port 443)
  await test('2. Brevo HTTPS API fallback dispatches email over port 443', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RESEND_API_KEY;
    process.env.BREVO_API_KEY = 'xkeysib-test-67890';
    process.env.SMTP_USER = 'sender@smartorder.vn';
    delete process.env.SMTP_PASSWORD;
    delete process.env.SMTP_PASS;

    let capturedUrl = '';
    let capturedInit: any = null;
    global.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ messageId: '<brevo-1>' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as any;

    const mailService = new MailService();
    const ok = await mailService.sendMail(
      {
        to: 'customer.real@gmail.com',
        subject: 'Notification',
        text: 'Hello',
        html: '<p>Hello</p>',
      },
      true,
    );

    assert.strictEqual(ok, true);
    assert.strictEqual(capturedUrl, 'https://api.brevo.com/v3/smtp/email');
    assert.strictEqual(capturedInit.headers['api-key'], 'xkeysib-test-67890');
  });

  // Test 3: IPv4 resolution helper keeps TLS SNI servername & falls back gracefully
  await test('3. resolveSmtpConnectionTarget resolves IPv4 to prevent IPv6 ENETUNREACH and preserves SNI', async () => {
    const fn = (MailService as any).resolveSmtpConnectionTarget;
    assert.strictEqual(typeof fn, 'function', 'MailService.resolveSmtpConnectionTarget must exist');

    const ipv4Target = await fn('smtp.gmail.com', async () => ({ address: '142.250.4.109', family: 4 }));
    assert.deepStrictEqual(ipv4Target, {
      connectHost: '142.250.4.109',
      servername: 'smtp.gmail.com',
    });

    const fallbackTarget = await fn('smtp.gmail.com', async () => {
      throw new Error('DNS timeout');
    });
    assert.deepStrictEqual(fallbackTarget, {
      connectHost: 'smtp.gmail.com',
      servername: 'smtp.gmail.com',
    });
  });

  // Test 4: QueueService DLQ sanitization redacts OTP mail PII/HTML while keeping non-OTP payloads replayable
  await test('4. QueueService.sanitizePayload redacts OTP email recipient and HTML content before DLQ write', () => {
    const qs = new QueueService();
    const sanitizedOtp = (qs as any).sanitizePayload({
      to: 'alice.nguyen@gmail.com',
      subject: '[Smart Order] Mã OTP xác minh tài khoản',
      text: 'Mã OTP: 482913 (Hiệu lực: 15 phút)',
      html: '<div><span>482913</span></div>',
    });

    assert.ok(!String(sanitizedOtp.to).includes('alice.nguyen'), `Expected masked recipient, got ${sanitizedOtp.to}`);
    assert.ok(!JSON.stringify(sanitizedOtp).includes('482913'), 'OTP digits must not appear in DLQ payload');
    assert.strictEqual(sanitizedOtp.html, '[REDACTED_OTP_CONTENT]');

    const sanitizedOrderJob = (qs as any).sanitizePayload({
      orderId: '888',
      action: 'SYNC_INVENTORY',
    });
    assert.deepStrictEqual(sanitizedOrderJob, {
      orderId: '888',
      action: 'SYNC_INVENTORY',
    });
  });

  // Test 5: Production fails fast when no HTTPS or SMTP email provider is configured
  await test('5. Production without HTTPS/SMTP provider propagates fail-fast error on throwOnError=true', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RESEND_API_KEY;
    delete process.env.BREVO_API_KEY;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    delete process.env.SMTP_PASS;

    const mailService = new MailService();
    let caught: any = null;
    try {
      await mailService.sendMail(
        {
          to: 'real.customer@gmail.com',
          subject: 'Verify',
          text: 'Body',
          html: '<p>Body</p>',
        },
        true,
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error, 'Expected fail-fast error when no mail provider is configured in production');
  });

  console.log(`\n================================================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
